import "server-only";
import { randomUUID } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { audit } from "@/lib/audit";
import { ForbiddenError, type Actor } from "@/lib/auth/actor";
import { decryptSecret, encryptSecret } from "@/lib/crypto";
import { createLinkToken, exchangePublicToken, getAccounts, PlaidError, plaidMode, removeItem, syncPage, type PlaidTxn } from "@/lib/plaid";
import { ValidationError } from "./clients";
import { assertLedger, assertLedgerWrite, assertManagedBusiness, bookOf, crossSourceMatch, toDate, ymdOf } from "./ledger";
import { isReportApprover } from "./bookkeeping-clients";

/**
 * Daily bank retrieval (read-only). Once a client has authorized a read-only connection, new
 * transactions are retrieved every day into the bookkeeping review queue.
 *
 * Coetha's part is limited on purpose: retrieve, recognize what's already there, suggest,
 * flag and notify. Nothing is posted, reconciled or approved automatically — every transaction
 * is still posted by a person, and statements are approved by Tabitha.
 */

export const BANK_CONSENT_VERSION = "2026-11-read-only-v1";
export const BANK_CONSENT_TEXT =
  "I authorize T. Turner & Associates, LLC to retrieve read-only transaction and balance information from the accounts I connect, for bookkeeping. No money can be moved, and I can disconnect at any time.";

// --- Connecting (sandbox only in this phase) ----------------------------------------------------

export async function startBankLink(actor: Actor, clientId: string) {
  await assertLedgerWrite(actor, clientId);
  await bookOf(clientId);
  return createLinkToken(`client:${clientId}`);
}

/**
 * Finishes a Plaid Link session: stores the token encrypted, records who authorized read-only
 * access and how, and lists the bank's accounts for staff to map to ledger accounts.
 */
export async function completeBankLink(actor: Actor, clientId: string, input: { publicToken: string; authorizedByName: string; authorizationMethod: "CLIENT_PRESENT" | "CLIENT_PORTAL" | "WRITTEN_AUTHORIZATION"; institutionName?: string; confirmed: boolean }) {
  await assertLedgerWrite(actor, clientId);
  await bookOf(clientId);
  if (!input.confirmed) throw new ValidationError("Confirm the client authorized read-only access.");
  const who = input.authorizedByName.trim().slice(0, 120);
  if (who.length < 2) throw new ValidationError("Enter the name of the person who authorized the connection.");
  if (!["CLIENT_PRESENT", "CLIENT_PORTAL", "WRITTEN_AUTHORIZATION"].includes(input.authorizationMethod)) throw new ValidationError("Choose how the client authorized it.");
  const { access_token, item_id } = await exchangePublicToken(input.publicToken);
  const { accounts } = await getAccounts(access_token);
  if (await prisma.bankConnection.count({ where: { itemId: item_id } })) throw new ValidationError("That bank login is already connected.");
  const conn = await prisma.bankConnection.create({
    data: {
      clientId, itemId: item_id, accessTokenEnc: encryptSecret(access_token), environment: "SANDBOX", institutionName: input.institutionName?.trim().slice(0, 120) || null,
      authorizedByName: who, authorizationMethod: input.authorizationMethod, consentVersion: BANK_CONSENT_VERSION, connectedById: actor.id,
      accounts: { create: accounts.map((a) => ({ providerAccountId: a.account_id, name: (a.official_name || a.name).slice(0, 120), mask: a.mask ?? null, type: a.type, subtype: a.subtype ?? null })) },
    },
    include: { accounts: true },
  });
  await audit(prisma, { actorId: actor.id, action: "banking.connected", entityType: "BankConnection", entityId: conn.id, clientId, details: { environment: "SANDBOX", institution: conn.institutionName, accounts: conn.accounts.length, authorizedByName: who, method: input.authorizationMethod, consentVersion: BANK_CONSENT_VERSION } });
  return conn;
}

/** Each bank account feeds exactly one of the client's own bank or card accounts in the ledger. */
export async function mapBankAccount(actor: Actor, clientId: string, connectionAccountId: string, ledgerAccountId: string | null) {
  await assertLedgerWrite(actor, clientId);
  const ca = await prisma.bankConnectionAccount.findFirst({ where: { id: connectionAccountId, connection: { clientId } } });
  if (!ca) throw new ValidationError("Bank account not found.");
  if (ledgerAccountId) {
    const la = await prisma.ledgerAccount.findFirst({ where: { id: ledgerAccountId, clientId, active: true, subtype: { in: ["BANK", "CREDIT_CARD"] } } });
    if (!la) throw new ValidationError("Choose one of this client's bank or credit card accounts.");
    const taken = await prisma.bankConnectionAccount.findFirst({ where: { ledgerAccountId, NOT: { id: ca.id } } });
    if (taken) throw new ValidationError("That ledger account already receives another bank account's transactions.");
  }
  await prisma.bankConnectionAccount.update({ where: { id: ca.id }, data: { ledgerAccountId } });
  await audit(prisma, { actorId: actor.id, action: "banking.account_mapped", entityType: "BankConnectionAccount", entityId: ca.id, clientId, details: { ledgerAccountId } });
}

/** Admins (or Tabitha) disconnect; the bank is told to revoke access and the token is wiped. History stays. */
export async function disconnectBank(actor: Actor, clientId: string, connectionId: string, reason: string) {
  if (actor.role !== "ADMIN" && !(await isReportApprover(actor))) throw new ForbiddenError("Only an Admin can disconnect a bank.");
  if (reason.trim().length < 5) throw new ValidationError("Record why the bank is being disconnected.");
  const c = await prisma.bankConnection.findFirst({ where: { id: connectionId, clientId } });
  if (!c || c.status === "DISCONNECTED") throw new ValidationError("Connection not found.");
  await removeItem(decryptSecret(c.accessTokenEnc)).catch(() => undefined);
  await prisma.bankConnection.update({ where: { id: c.id }, data: { status: "DISCONNECTED", accessTokenEnc: "", cursor: null, disconnectedAt: new Date(), disconnectedById: actor.id } });
  await audit(prisma, { actorId: actor.id, action: "banking.disconnected", entityType: "BankConnection", entityId: c.id, clientId, details: { reason: reason.trim().slice(0, 300) } });
}

// --- Retrieval ---------------------------------------------------------------------------------

/** Plaid amounts are positive for money out; the books store money in as positive. */
const toCents = (t: PlaidTxn) => -Math.round(t.amount * 100);
const descOf = (t: PlaidTxn) => (t.merchant_name && !t.name.toUpperCase().includes(t.merchant_name.toUpperCase()) ? `${t.name} (${t.merchant_name})` : t.name).replace(/\s+/g, " ").trim().slice(0, 300) || "(no description)";

export type SyncResult = { added: number; matched: number; modified: number; removed: number; skipped: number; flagged: number };

/**
 * Retrieves everything new since the last successful retrieval (Plaid transactions/sync),
 * recognizing rows already imported from statements, and saving the cursor only after the
 * whole batch is stored — so a failure never loses or doubles a transaction.
 */
export async function syncConnection(connectionId: string, trigger: "DAILY" | "MANUAL", actor: Actor | null = null): Promise<SyncResult> {
  const conn = await prisma.bankConnection.findUnique({ where: { id: connectionId }, include: { accounts: true } });
  if (!conn || conn.status === "DISCONNECTED") throw new ValidationError("Connection not found.");
  if (actor) await assertLedger(actor, conn.clientId);
  await assertManagedBusiness(conn.clientId);
  const run = await prisma.bankSyncRun.create({ data: { connectionId, trigger } });
  await prisma.bankConnection.update({ where: { id: connectionId }, data: { lastAttemptAt: new Date() } });
  const r: SyncResult = { added: 0, matched: 0, modified: 0, removed: 0, skipped: 0, flagged: 0 };
  try {
    const token = decryptSecret(conn.accessTokenEnc);
    // Collect the full batch first; Plaid asks for a restart if data changes mid-way.
    let cursor = conn.cursor;
    const added: PlaidTxn[] = [], modified: PlaidTxn[] = [], removed: { transaction_id: string; account_id?: string }[] = [];
    for (let page = 0; page < 50; page++) {
      const p = await syncPage(token, cursor);
      added.push(...p.added); modified.push(...p.modified); removed.push(...p.removed);
      cursor = p.next_cursor;
      if (!p.has_more) break;
    }
    const ledgerFor = new Map(conn.accounts.filter((a) => a.ledgerAccountId).map((a) => [a.providerAccountId, a.ledgerAccountId!]));
    const book = await bookOf(conn.clientId);
    await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${"bank-rows:" + conn.clientId}))`;
      for (const t of added) {
        const accountId = ledgerFor.get(t.account_id);
        // Pending transactions are skipped: the bank sends the final version when it posts.
        if (!accountId || t.pending) { r.skipped++; continue; }
        if (await tx.bankTransaction.count({ where: { accountId, providerId: t.transaction_id } })) { r.skipped++; continue; }
        const row = { date: t.date, amountCents: toCents(t), description: descOf(t) };
        const m = await crossSourceMatch(tx, accountId, row, "PLAID");
        if (m.match) {
          // Already imported from a statement: link it, don't add a second row.
          await tx.bankTransaction.update({ where: { id: m.match.id }, data: { providerId: t.transaction_id } });
          r.matched++;
          continue;
        }
        const beforeOpening = book.openingDate && t.date < ymdOf(book.openingDate);
        await tx.bankTransaction.create({
          data: {
            clientId: conn.clientId, accountId, date: toDate(t.date), amountCents: row.amountCents, description: row.description, fingerprint: `plaid:${t.transaction_id}`, source: "PLAID", providerId: t.transaction_id,
            ...(beforeOpening ? { status: "EXCLUDED", excludedReason: "Before the opening balances date (already included in the opening balance)" } : {}),
            ...(m.ambiguous ? { flag: "POSSIBLE_DUPLICATE", flagNote: "Looks like more than one row imported from a statement. Check before posting." } : {}),
          },
        });
        r.added++;
        if (m.ambiguous) r.flagged++;
      }
      for (const t of modified) {
        const accountId = ledgerFor.get(t.account_id);
        if (!accountId || t.pending) continue;
        const existing = await tx.bankTransaction.findFirst({ where: { accountId, providerId: t.transaction_id } });
        if (!existing) continue;
        const changed = existing.amountCents !== toCents(t) || ymdOf(existing.date) !== t.date;
        if (!changed) continue;
        if (existing.status === "UNREVIEWED") {
          await tx.bankTransaction.update({ where: { id: existing.id }, data: { amountCents: toCents(t), date: toDate(t.date), description: descOf(t) } });
        } else {
          // Already posted: the books are never changed behind staff's back.
          await tx.bankTransaction.update({ where: { id: existing.id }, data: { flag: "CHANGED_AFTER_POSTING", flagNote: `The bank now shows ${t.date}, $${(toCents(t) / 100).toFixed(2)}. Review and correct with a reversal if needed.` } });
          r.flagged++;
        }
        r.modified++;
      }
      for (const x of removed) {
        const existing = await tx.bankTransaction.findFirst({ where: { clientId: conn.clientId, providerId: x.transaction_id } });
        if (!existing) continue;
        if (existing.status === "UNREVIEWED") {
          await tx.bankTransaction.update({ where: { id: existing.id }, data: { status: "EXCLUDED", excludedReason: "Removed by the bank" } });
        } else if (existing.status === "POSTED") {
          await tx.bankTransaction.update({ where: { id: existing.id }, data: { flag: "REMOVED_AFTER_POSTING", flagNote: "The bank no longer shows this transaction. Review it; reverse the entry if it didn't happen." } });
          r.flagged++;
        }
        r.removed++;
      }
      // The cursor moves only with the stored rows.
      await tx.bankConnection.update({ where: { id: connectionId }, data: { cursor, lastSuccessAt: new Date(), lastError: null, status: "ACTIVE" } });
    });
    await prisma.bankSyncRun.update({ where: { id: run.id }, data: { status: "OK", finishedAt: new Date(), ...r } });
    await audit(prisma, { actorId: actor?.id ?? null, action: "banking.synced", entityType: "BankConnection", entityId: connectionId, clientId: conn.clientId, details: { trigger, ...r } });
    await notifyIfNeeded(conn.clientId);
    return r;
  } catch (err) {
    const code = err instanceof PlaidError ? err.code : "ERROR";
    const status = code === "ITEM_LOGIN_REQUIRED" || code === "PENDING_EXPIRATION" ? "NEEDS_REAUTH" : "ERROR";
    await prisma.bankSyncRun.update({ where: { id: run.id }, data: { status: "FAILED", finishedAt: new Date(), errorCode: code } });
    await prisma.bankConnection.update({ where: { id: connectionId }, data: { status, lastError: err instanceof PlaidError ? `${err.code}: ${err.message}`.slice(0, 300) : "Retrieval failed" } });
    await notifyIfNeeded(conn.clientId, status === "NEEDS_REAUTH" ? "The bank connection needs the client to sign in again." : "Daily bank retrieval failed.");
    throw err instanceof PlaidError ? new ValidationError(`Bank retrieval failed: ${err.message}`) : err;
  }
}

/** Manual "Retrieve now" for one client. */
export async function retrieveNow(actor: Actor, clientId: string) {
  await assertLedger(actor, clientId);
  const conns = await prisma.bankConnection.findMany({ where: { clientId, status: { in: ["ACTIVE", "ERROR"] } } });
  if (!conns.length) throw new ValidationError("No bank connection to retrieve from.");
  const total: SyncResult = { added: 0, matched: 0, modified: 0, removed: 0, skipped: 0, flagged: 0 };
  for (const c of conns) {
    const r = await syncConnection(c.id, "MANUAL", actor);
    for (const k of Object.keys(total) as (keyof SyncResult)[]) total[k] += r[k];
  }
  return total;
}

/**
 * The scheduled daily run (from the hourly automations cron): each active connection not
 * retrieved successfully in the last 20 hours. Never overlaps with itself.
 */
export async function runDailyBankRetrieval(now = new Date()) {
  if (plaidMode() !== "SANDBOX") return { ok: 0, failed: 0, skipped: plaidMode() };
  const runId = randomUUID();
  const until = new Date(now.getTime() + 15 * 60_000);
  const got = await prisma.jobLock.updateMany({ where: { name: "bank-retrieval", lockedUntil: { lt: now } }, data: { lockedUntil: until, runId } });
  if (!got.count) {
    try { await prisma.jobLock.create({ data: { name: "bank-retrieval", lockedUntil: until, runId } }); } catch { return { ok: 0, failed: 0, skipped: "another run is in progress" }; }
  }
  try {
    // Only owner-approved Managed Businesses are pulled; a removed business's feed simply stops.
    const managed = (await prisma.client.findMany({ where: { businessAccess: "ACTIVE" }, select: { id: true } })).map((c) => c.id);
    const due = await prisma.bankConnection.findMany({ where: { status: { in: ["ACTIVE", "ERROR"] }, clientId: { in: managed }, OR: [{ lastSuccessAt: null }, { lastSuccessAt: { lt: new Date(now.getTime() - 20 * 3600_000) } }] }, select: { id: true }, take: 200 });
    let ok = 0, failed = 0;
    for (const c of due) {
      try { await syncConnection(c.id, "DAILY"); ok++; } catch { failed++; }
    }
    return { ok, failed };
  } finally {
    await prisma.jobLock.update({ where: { name: "bank-retrieval" }, data: { lockedUntil: new Date(0), runId: null } }).catch(() => {});
  }
}

// --- Telling staff ------------------------------------------------------------------------------

const TASK_TITLE = "Bank transactions need review";

/**
 * One open task per client for the assigned staff member (or Tabitha when no one is assigned),
 * updated rather than repeated, whenever retrieved transactions need attention.
 */
async function notifyIfNeeded(clientId: string, problem?: string) {
  const [unreviewed, flagged, client] = await Promise.all([
    prisma.bankTransaction.count({ where: { clientId, status: "UNREVIEWED" } }),
    prisma.bankTransaction.count({ where: { clientId, flag: { not: null }, status: { not: "EXCLUDED" } } }),
    prisma.client.findUnique({ where: { id: clientId }, select: { assignedToId: true, displayName: true } }),
  ]);
  if (!problem && !unreviewed && !flagged) return;
  const owner = await prisma.ownerAccess.findFirst({ where: { isPrimary: true, revokedAt: null }, select: { userId: true } });
  const assignee = client?.assignedToId ?? owner?.userId ?? (await prisma.user.findFirst({ where: { role: "ADMIN", active: true }, select: { id: true } }))?.id;
  if (!assignee) return;
  const details = [problem, unreviewed ? `${unreviewed} transaction${unreviewed === 1 ? "" : "s"} to review` : null, flagged ? `${flagged} flagged for a closer look` : null].filter(Boolean).join(" · ") + ". Open Books & Ledger → Bank & reconcile.";
  const open = await prisma.task.findFirst({ where: { clientId, title: TASK_TITLE, status: { not: "DONE" } } });
  if (open) await prisma.task.update({ where: { id: open.id }, data: { details, assigneeId: assignee, dueAt: new Date(), ...(problem ? { priority: "HIGH" } : {}) } });
  else await prisma.task.create({ data: { title: TASK_TITLE, details, clientId, assigneeId: assignee, createdById: assignee, dueAt: new Date(), priority: problem ? "HIGH" : "NORMAL" } });
}

/** What the Books page shows about bank connections. */
export async function bankConnectionsView(actor: Actor, clientId: string) {
  await assertLedger(actor, clientId);
  const conns = await prisma.bankConnection.findMany({ where: { clientId }, orderBy: { createdAt: "asc" }, include: { accounts: true, runs: { orderBy: { startedAt: "desc" }, take: 5 } } });
  return { mode: plaidMode(), connections: conns.map(({ accessTokenEnc: _hidden, cursor: _c, ...c }) => c) };
}
