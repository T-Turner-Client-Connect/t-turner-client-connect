import "server-only";
import { randomUUID } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { audit } from "@/lib/audit";
import { ForbiddenError, type Actor } from "@/lib/auth/actor";
import { decryptSecret, encryptSecret } from "@/lib/crypto";
import { appUrl } from "@/lib/integrations";
import { createLinkToken, currentPlaidMode, envOfMode, exchangePublicToken, getAccounts, PLAID_MODE_TEXT, PlaidError, plaidWebhookUrl, REAUTH_CODES, removeItem, syncPage, liabilitiesFlag, type PlaidAccount, type PlaidTxn } from "@/lib/plaid";
import { ValidationError } from "./clients";
import { assertLedger, assertLedgerWrite, assertManagedBusiness, bookOf, crossSourceMatch, FEED_SUBTYPES, normDesc, officeBookClientIds, toDate, ymdOf } from "./ledger";
import { applySharedCardDetection, feedsShared } from "./bank-accounts";
import { refreshLiabilities } from "./plaid-products";
import { isReportApprover } from "./bookkeeping-clients";

/**
 * Automatic bank retrieval (read-only). Once a client has authorized a read-only connection for
 * one of their businesses, new transactions are retrieved at least daily (and whenever Plaid's
 * webhook says new ones are ready) into that business's bookkeeping review queue.
 *
 * Real banks need BOTH the Plaid production keys in Netlify and Tabitha's owner switch
 * "Live bank connections". Sandbox keeps working for testing. CSV statement import stays as
 * a backup and is matched against retrieved rows so nothing is counted twice.
 *
 * Nothing here posts, reconciles or approves. Coetha may draft categories from these rows,
 * but only Tabitha's approval posts them.
 */

export const BANK_CONSENT_VERSION = "2026-11-read-only-v1";
export const BANK_CONSENT_TEXT =
  "I authorize T. Turner & Associates, LLC to retrieve read-only transaction and balance information from the accounts I connect, for bookkeeping. No money can be moved, and I can disconnect at any time.";

/** The Plaid environment connections can be made in right now, or a clear reason why not. */
async function activeEnvironment(): Promise<"SANDBOX" | "PRODUCTION"> {
  const mode = await currentPlaidMode();
  const env = envOfMode(mode);
  if (!env) throw new ValidationError(PLAID_MODE_TEXT[mode]);
  return env;
}

// --- Connecting ----------------------------------------------------------------------------------

/** Opens Plaid Link for ONE client business (each business authorizes its own connection). */
export async function startBankLink(actor: Actor, clientId: string) {
  await assertLedgerWrite(actor, clientId, "banking");
  await bookOf(clientId);
  await activeEnvironment();
  return createLinkToken(`client:${clientId}`, { webhook: plaidWebhookUrl(appUrl()) });
}

/**
 * Finishes a Plaid Link session: stores the token encrypted, records who authorized read-only
 * access and how, and lists the bank's accounts for staff to map to ledger accounts.
 */
export async function completeBankLink(actor: Actor, clientId: string, input: { publicToken: string; authorizedByName: string; authorizationMethod: "CLIENT_PRESENT" | "CLIENT_PORTAL" | "WRITTEN_AUTHORIZATION"; institutionName?: string; confirmed: boolean }) {
  await assertLedgerWrite(actor, clientId, "banking");
  await bookOf(clientId);
  if (!input.confirmed) throw new ValidationError("Confirm the client authorized read-only access.");
  const who = input.authorizedByName.trim().slice(0, 120);
  if (who.length < 2) throw new ValidationError("Enter the name of the person who authorized the connection.");
  if (!["CLIENT_PRESENT", "CLIENT_PORTAL", "WRITTEN_AUTHORIZATION"].includes(input.authorizationMethod)) throw new ValidationError("Choose how the client authorized it.");
  const environment = await activeEnvironment();
  const { access_token, item_id } = await exchangePublicToken(input.publicToken);
  const { accounts } = await getAccounts(access_token);
  if (await prisma.bankConnection.count({ where: { itemId: item_id } })) throw new ValidationError("That bank login is already connected.");
  const conn = await prisma.bankConnection.create({
    data: {
      clientId, itemId: item_id, accessTokenEnc: encryptSecret(access_token), environment, institutionName: input.institutionName?.trim().slice(0, 120) || null,
      authorizedByName: who, authorizationMethod: input.authorizationMethod, consentVersion: BANK_CONSENT_VERSION, connectedById: actor.id,
      accounts: { create: accounts.map((a) => ({ providerAccountId: a.account_id, name: (a.official_name || a.name).slice(0, 120), mask: a.mask ?? null, type: a.type, subtype: a.subtype ?? null, ...balanceData(a) })) },
    },
    include: { accounts: true },
  });
  // Employee / authorized-user cards on one shared credit account are suggested as one liability.
  await applySharedCardDetection(conn.id);
  await audit(prisma, { actorId: actor.id, action: "banking.connected", entityType: "BankConnection", entityId: conn.id, clientId, details: { environment, institution: conn.institutionName, accounts: conn.accounts.length, authorizedByName: who, method: input.authorizationMethod, consentVersion: BANK_CONSENT_VERSION } });
  return conn;
}

/**
 * Re-authentication (Plaid Link update mode): the client signs in to the bank again to repair a
 * connection flagged "needs sign-in". No new connection is made; history and mapping stay.
 */
export async function startBankReauth(actor: Actor, clientId: string, connectionId: string) {
  await assertLedgerWrite(actor, clientId);
  const c = await prisma.bankConnection.findFirst({ where: { id: connectionId, clientId, status: { in: ["NEEDS_REAUTH", "ERROR", "ACTIVE"] } } });
  if (!c) throw new ValidationError("Connection not found.");
  if ((await activeEnvironment()) !== c.environment) throw new ValidationError(`This connection was made in ${c.environment === "PRODUCTION" ? "live" : "sandbox"} mode, which isn't active right now.`);
  return createLinkToken(`client:${clientId}`, { accessToken: decryptSecret(c.accessTokenEnc), webhook: plaidWebhookUrl(appUrl()) });
}

export async function completeBankReauth(actor: Actor, clientId: string, connectionId: string) {
  await assertLedgerWrite(actor, clientId);
  const c = await prisma.bankConnection.findFirst({ where: { id: connectionId, clientId, status: { not: "DISCONNECTED" } } });
  if (!c) throw new ValidationError("Connection not found.");
  await prisma.bankConnection.update({ where: { id: c.id }, data: { status: "ACTIVE", errorCode: null, reauthRequiredAt: null, lastError: null } });
  await audit(prisma, { actorId: actor.id, action: "banking.reauthorized", entityType: "BankConnection", entityId: c.id, clientId, details: { previousStatus: c.status, previousError: c.errorCode } });
  await closeReauthTask(clientId);
}

/** Plaid's cached balances, in cents (credit: amount owed). */
const balanceData = (a: PlaidAccount) => ({
  currentBalanceCents: a.balances?.current != null ? Math.round(a.balances.current * 100) : null,
  creditLimitCents: a.balances?.limit != null ? Math.round(a.balances.limit * 100) : null,
  balanceAsOf: a.balances ? new Date() : null,
});

/** Each bank account feeds exactly one of the client's own bank or card accounts in the ledger (employee cards on one shared account feed that account). */
export async function mapBankAccount(actor: Actor, clientId: string, connectionAccountId: string, ledgerAccountId: string | null) {
  await assertLedgerWrite(actor, clientId, "banking");
  const ca = await prisma.bankConnectionAccount.findFirst({ where: { id: connectionAccountId, connection: { clientId } } });
  if (!ca) throw new ValidationError("Bank account not found.");
  if (ledgerAccountId) {
    const la = await prisma.ledgerAccount.findFirst({ where: { id: ledgerAccountId, clientId, active: true, subtype: { in: FEED_SUBTYPES } } });
    if (!la) throw new ValidationError("Choose one of this client's bank or credit card accounts.");
    const taken = feedsShared(ca) ? null : await prisma.bankConnectionAccount.findFirst({ where: { ledgerAccountId, NOT: { id: ca.id }, OR: [{ sharedWithId: null }, { sharedStatus: "SEPARATE" }] } });
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
  await removeItem(decryptSecret(c.accessTokenEnc), c.environment === "PRODUCTION" ? "PRODUCTION" : "SANDBOX").catch(() => undefined);
  await prisma.bankConnection.update({ where: { id: c.id }, data: { status: "DISCONNECTED", accessTokenEnc: "", cursor: null, disconnectedAt: new Date(), disconnectedById: actor.id } });
  await audit(prisma, { actorId: actor.id, action: "banking.disconnected", entityType: "BankConnection", entityId: c.id, clientId, details: { reason: reason.trim().slice(0, 300) } });
}

// --- Retrieval ---------------------------------------------------------------------------------

/** Plaid amounts are positive for money out; the books store money in as positive. */
const toCents = (t: PlaidTxn) => -Math.round(t.amount * 100);
const descOf = (t: PlaidTxn) => (t.merchant_name && !t.name.toUpperCase().includes(t.merchant_name.toUpperCase()) ? `${t.name} (${t.merchant_name})` : t.name).replace(/\s+/g, " ").trim().slice(0, 300) || "(no description)";

export type SyncResult = { added: number; matched: number; modified: number; removed: number; skipped: number; flagged: number };
export type SyncTrigger = "DAILY" | "MANUAL" | "WEBHOOK";

/** Collects one full transactions/sync batch, restarting from the saved cursor if Plaid's data changes mid-way. */
async function collectBatch(token: string, start: string | null) {
  for (let attempt = 0; attempt < 3; attempt++) {
    let cursor = start;
    const added: PlaidTxn[] = [], modified: PlaidTxn[] = [], removed: { transaction_id: string; account_id?: string }[] = [];
    const accounts = new Map<string, PlaidAccount>();
    try {
      for (let page = 0; page < 50; page++) {
        const p = await syncPage(token, cursor);
        added.push(...p.added); modified.push(...p.modified); removed.push(...p.removed);
        for (const a of p.accounts ?? []) accounts.set(a.account_id, a);
        cursor = p.next_cursor;
        if (!p.has_more) break;
      }
      return { added, modified, removed, cursor, accounts: [...accounts.values()] };
    } catch (err) {
      if (err instanceof PlaidError && err.code === "TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION" && attempt < 2) continue;
      throw err;
    }
  }
  throw new PlaidError("Plaid kept changing the data during retrieval.", "TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION");
}

/**
 * Retrieves everything new since the last successful retrieval (Plaid transactions/sync),
 * recognizing rows already imported from statements, and saving the cursor only after the
 * whole batch is stored, so a failure never loses or doubles a transaction.
 */
export async function syncConnection(connectionId: string, trigger: SyncTrigger, actor: Actor | null = null): Promise<SyncResult> {
  const conn = await prisma.bankConnection.findUnique({ where: { id: connectionId }, include: { accounts: true } });
  if (!conn || conn.status === "DISCONNECTED") throw new ValidationError("Connection not found.");
  if (actor) await assertLedger(actor, conn.clientId, "banking", "edit");
  await assertManagedBusiness(conn.clientId);
  // A sandbox connection is never retrieved with live keys (or the reverse), and nothing is retrieved while live connections are off.
  const env = await activeEnvironment();
  if (env !== conn.environment) throw new ValidationError(`This connection was made in ${conn.environment === "PRODUCTION" ? "live" : "sandbox"} mode, which isn't active right now.`);
  const run = await prisma.bankSyncRun.create({ data: { connectionId, trigger } });
  await prisma.bankConnection.update({ where: { id: connectionId }, data: { lastAttemptAt: new Date() } });
  const r: SyncResult = { added: 0, matched: 0, modified: 0, removed: 0, skipped: 0, flagged: 0 };
  try {
    const token = decryptSecret(conn.accessTokenEnc);
    const { added, modified, removed, cursor, accounts: seen } = await collectBatch(token, conn.cursor);
    // An employee card on a shared credit account feeds the primary card's liability account.
    const byId = new Map(conn.accounts.map((a) => [a.id, a]));
    const target = (a: (typeof conn.accounts)[number]) => (feedsShared(a) ? byId.get(a.sharedWithId!)?.ledgerAccountId ?? a.ledgerAccountId : a.ledgerAccountId);
    const ledgerFor = new Map(conn.accounts.filter((a) => target(a)).map((a) => [a.providerAccountId, target(a)!]));
    const sharedLedgers = new Set(conn.accounts.filter((a) => feedsShared(a)).map((a) => target(a)).filter((x): x is string => !!x));
    const book = await bookOf(conn.clientId);
    await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${"bank-rows:" + conn.clientId}))`;
      for (const t of added) {
        const accountId = ledgerFor.get(t.account_id);
        // Pending transactions are skipped: the bank sends the final version when it posts.
        if (!accountId || t.pending) { r.skipped++; continue; }
        // Plaid's transaction_id is unique per account: the same transaction is never added twice.
        if (await tx.bankTransaction.count({ where: { accountId, providerId: t.transaction_id } })) { r.skipped++; continue; }
        const row = { date: t.date, amountCents: toCents(t), description: descOf(t) };
        // Shared credit account: the same charge reported under two cards is one charge.
        if (sharedLedgers.has(accountId)) {
          const twins = await tx.bankTransaction.findMany({ where: { accountId, source: "PLAID", date: toDate(t.date), amountCents: row.amountCents, NOT: { providerAccountId: t.account_id } }, select: { description: true } });
          if (twins.some((x) => normDesc(x.description) === normDesc(row.description))) { r.matched++; continue; }
        }
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
            clientId: conn.clientId, accountId, date: toDate(t.date), amountCents: row.amountCents, description: row.description, fingerprint: `plaid:${t.transaction_id}`, source: "PLAID", providerId: t.transaction_id, providerAccountId: t.account_id,
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
      // Balances Plaid returned with the batch (when it includes them), for outstanding balances.
      for (const a of seen) {
        const ca = conn.accounts.find((x) => x.providerAccountId === a.account_id);
        if (ca && a.balances) await tx.bankConnectionAccount.update({ where: { id: ca.id }, data: balanceData(a) });
      }
      // The cursor moves only with the stored rows.
      await tx.bankConnection.update({ where: { id: connectionId }, data: { cursor, lastSuccessAt: new Date(), lastError: null, errorCode: null, reauthRequiredAt: null, status: "ACTIVE" } });
    });
    await prisma.bankSyncRun.update({ where: { id: run.id }, data: { status: "OK", finishedAt: new Date(), ...r } });
    // Card and loan terms (Plaid Liabilities), only when Tabitha enabled the product.
    if (liabilitiesFlag()) await refreshLiabilities(connectionId).catch(() => undefined);
    await audit(prisma, { actorId: actor?.id ?? null, action: "banking.synced", entityType: "BankConnection", entityId: connectionId, clientId: conn.clientId, details: { trigger, ...r } });
    if (conn.status === "NEEDS_REAUTH") await closeReauthTask(conn.clientId);
    await notifyIfNeeded(conn.clientId);
    return r;
  } catch (err) {
    const code = err instanceof PlaidError ? err.code : "ERROR";
    await flagConnectionError(conn, code, err instanceof PlaidError ? err.message : "Retrieval failed");
    await prisma.bankSyncRun.update({ where: { id: run.id }, data: { status: "FAILED", finishedAt: new Date(), errorCode: code } });
    throw err instanceof PlaidError ? new ValidationError(`Bank retrieval failed: ${err.message}`) : err;
  }
}

/**
 * Marks a connection as needing the client to sign in again (item errors only the client can
 * fix) or as failed (anything else, retried on the next run), and alerts staff.
 */
async function flagConnectionError(conn: { id: string; clientId: string; institutionName: string | null; reauthRequiredAt: Date | null }, code: string, message: string) {
  const reauth = REAUTH_CODES.has(code);
  await prisma.bankConnection.update({
    where: { id: conn.id },
    data: { status: reauth ? "NEEDS_REAUTH" : "ERROR", errorCode: code, lastError: `${code}: ${message}`.slice(0, 300), ...(reauth && !conn.reauthRequiredAt ? { reauthRequiredAt: new Date() } : {}) },
  });
  await audit(prisma, { actorId: null, action: reauth ? "banking.needs_reauth" : "banking.sync_failed", entityType: "BankConnection", entityId: conn.id, clientId: conn.clientId, details: { code } });
  const bank = conn.institutionName ?? "A bank connection";
  if (reauth) await raiseReauthTask(conn.clientId, `${bank} needs the client to sign in to the bank again (${code}). Daily retrieval is paused for it until they do. Open Books & Ledger → Bank & reconcile → Reconnect, with the client present or by sending them the link.`);
  await notifyIfNeeded(conn.clientId, reauth ? `${bank}: the client needs to sign in to the bank again.` : `${bank}: bank retrieval failed (${code}).`);
}

/** Manual "Retrieve now" for one client. */
export async function retrieveNow(actor: Actor, clientId: string) {
  await assertLedger(actor, clientId, "banking", "edit");
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
 * The scheduled run (from the hourly automations cron): every active (or last-failed)
 * connection of every Managed Business not retrieved successfully in the last 20 hours, so each
 * one is pulled at least once a day. Connections that need the client to sign in again are
 * skipped (they'd only fail) and stay flagged. Never overlaps with itself.
 */
export async function runDailyBankRetrieval(now = new Date()) {
  const mode = await currentPlaidMode();
  const env = envOfMode(mode);
  if (!env) return { ok: 0, failed: 0, skipped: mode };
  const runId = randomUUID();
  const until = new Date(now.getTime() + 15 * 60_000);
  const got = await prisma.jobLock.updateMany({ where: { name: "bank-retrieval", lockedUntil: { lt: now } }, data: { lockedUntil: until, runId } });
  if (!got.count) {
    try { await prisma.jobLock.create({ data: { name: "bank-retrieval", lockedUntil: until, runId } }); } catch { return { ok: 0, failed: 0, skipped: "another run is in progress" }; }
  }
  try {
    // Only owner-approved Managed Businesses are pulled; a removed business's feed simply stops.
    // Every business the office keeps books for (Managed Business or active Bookkeeping Client).
    const managed = await officeBookClientIds();
    const due = await prisma.bankConnection.findMany({
      where: { environment: env, status: { in: ["ACTIVE", "ERROR"] }, clientId: { in: managed }, OR: [{ lastSuccessAt: null }, { lastSuccessAt: { lt: new Date(now.getTime() - 20 * 3600_000) } }] },
      orderBy: [{ lastSuccessAt: { sort: "asc", nulls: "first" } }],
      select: { id: true },
      take: 200,
    });
    let ok = 0, failed = 0;
    for (const c of due) {
      try { await syncConnection(c.id, "DAILY"); ok++; } catch { failed++; }
    }
    return { ok, failed, environment: env };
  } finally {
    await prisma.jobLock.update({ where: { name: "bank-retrieval" }, data: { lockedUntil: new Date(0), runId: null } }).catch(() => {});
  }
}

// --- Plaid webhooks (verified by the route before this is called) -------------------------------

export type PlaidWebhook = { webhook_type?: string; webhook_code?: string; item_id?: string; error?: { error_code?: string; error_message?: string } | null };

/**
 * SYNC_UPDATES_AVAILABLE retrieves that connection now; item errors flag it for re-authentication
 * right away instead of waiting for the next daily run. Unknown items are ignored.
 */
export async function handlePlaidWebhook(w: PlaidWebhook): Promise<string> {
  if (!w.item_id) return "ignored: no item";
  const conn = await prisma.bankConnection.findUnique({ where: { itemId: w.item_id } });
  if (!conn || conn.status === "DISCONNECTED") return "ignored: unknown item";
  await prisma.bankConnection.update({ where: { id: conn.id }, data: { lastWebhookAt: new Date() } });
  const kind = `${w.webhook_type}:${w.webhook_code}`;
  if (kind === "TRANSACTIONS:SYNC_UPDATES_AVAILABLE") {
    if (conn.status === "NEEDS_REAUTH") return "skipped: needs sign-in";
    try {
      await syncConnection(conn.id, "WEBHOOK");
      return "synced";
    } catch {
      return "sync failed (recorded)";
    }
  }
  if (w.webhook_type === "ITEM") {
    if (w.webhook_code === "ERROR") {
      const code = w.error?.error_code ?? "ITEM_ERROR";
      await flagConnectionError(conn, code, w.error?.error_message ?? "Plaid reported an item error.");
      return `flagged: ${code}`;
    }
    if (w.webhook_code === "PENDING_EXPIRATION" || w.webhook_code === "PENDING_DISCONNECT" || w.webhook_code === "USER_PERMISSION_REVOKED" || w.webhook_code === "USER_ACCOUNT_REVOKED") {
      await flagConnectionError(conn, w.webhook_code, "The bank says access is expiring or was revoked.");
      return `flagged: ${w.webhook_code}`;
    }
    if (w.webhook_code === "LOGIN_REPAIRED" && conn.status === "NEEDS_REAUTH") {
      await prisma.bankConnection.update({ where: { id: conn.id }, data: { status: "ACTIVE", errorCode: null, reauthRequiredAt: null, lastError: null } });
      await audit(prisma, { actorId: null, action: "banking.login_repaired", entityType: "BankConnection", entityId: conn.id, clientId: conn.clientId });
      await closeReauthTask(conn.clientId);
      return "repaired";
    }
  }
  return "ignored";
}

// --- Telling staff ------------------------------------------------------------------------------

const TASK_TITLE = "Bank transactions need review";
const REAUTH_TITLE = "Bank connection needs the client to sign in again";

async function staffFor(clientId: string) {
  const client = await prisma.client.findUnique({ where: { id: clientId }, select: { assignedToId: true } });
  const owner = await prisma.ownerAccess.findFirst({ where: { isPrimary: true, revokedAt: null }, select: { userId: true } });
  return client?.assignedToId ?? owner?.userId ?? (await prisma.user.findFirst({ where: { role: "ADMIN", active: true }, select: { id: true } }))?.id ?? null;
}

/** A separate, high-priority task: one per client, updated rather than repeated. */
async function raiseReauthTask(clientId: string, details: string) {
  const assignee = await staffFor(clientId);
  if (!assignee) return;
  const open = await prisma.task.findFirst({ where: { clientId, title: REAUTH_TITLE, status: { not: "DONE" } } });
  if (open) await prisma.task.update({ where: { id: open.id }, data: { details, assigneeId: assignee, priority: "HIGH" } });
  else await prisma.task.create({ data: { title: REAUTH_TITLE, details, clientId, assigneeId: assignee, createdById: assignee, dueAt: new Date(), priority: "HIGH" } });
}

async function closeReauthTask(clientId: string) {
  await prisma.task.updateMany({ where: { clientId, title: REAUTH_TITLE, status: { not: "DONE" } }, data: { status: "DONE" } });
}

/**
 * One open task per client for the assigned staff member (or Tabitha when no one is assigned),
 * updated rather than repeated, whenever retrieved transactions need attention.
 */
async function notifyIfNeeded(clientId: string, problem?: string) {
  const [unreviewed, flagged] = await Promise.all([
    prisma.bankTransaction.count({ where: { clientId, status: "UNREVIEWED" } }),
    prisma.bankTransaction.count({ where: { clientId, flag: { not: null }, status: { not: "EXCLUDED" } } }),
  ]);
  if (!problem && !unreviewed && !flagged) return;
  const assignee = await staffFor(clientId);
  if (!assignee) return;
  const details = [problem, unreviewed ? `${unreviewed} transaction${unreviewed === 1 ? "" : "s"} to review` : null, flagged ? `${flagged} flagged for a closer look` : null].filter(Boolean).join(" · ") + ". Open Books & Ledger → Bank & reconcile.";
  const open = await prisma.task.findFirst({ where: { clientId, title: TASK_TITLE, status: { not: "DONE" } } });
  if (open) await prisma.task.update({ where: { id: open.id }, data: { details, assigneeId: assignee, dueAt: new Date(), ...(problem ? { priority: "HIGH" } : {}) } });
  else await prisma.task.create({ data: { title: TASK_TITLE, details, clientId, assigneeId: assignee, createdById: assignee, dueAt: new Date(), priority: problem ? "HIGH" : "NORMAL" } });
}

/** What the Books page shows about bank connections. */
export async function bankConnectionsView(actor: Actor, clientId: string) {
  await assertLedger(actor, clientId, "banking", "view");
  const conns = await prisma.bankConnection.findMany({ where: { clientId }, orderBy: { createdAt: "asc" }, include: { accounts: true, runs: { orderBy: { startedAt: "desc" }, take: 5 } } });
  return { mode: await currentPlaidMode(), connections: conns.map(({ accessTokenEnc: _hidden, cursor: _c, ...c }) => c) };
}
