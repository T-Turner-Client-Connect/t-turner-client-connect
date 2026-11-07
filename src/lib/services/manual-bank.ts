import "server-only";
import type { LedgerAccount, Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { audit } from "@/lib/audit";
import type { Actor } from "@/lib/auth/actor";
import { can } from "@/lib/auth/permissions";
import { ValidationError } from "./clients";
import { assertLedger, assertManagedBusiness, canUseLedger, importBankCsv, isFeedSubtype, parseCents, type ParsedRow, newestBalance } from "./ledger";
import { chicagoLocalToUtc } from "@/lib/tz";
import { checkText } from "./bank-accounts";
import { once } from "./office-actions";

/**
 * Balances entered by our office. Until a Plaid feed is live for a business, staff who already
 * have access to its bank look up each account's balance and record it here; the client's
 * dashboard then shows that total as "Updated by our office · as of …" (never "live").
 *
 * - ManualBankAccount: a name, institution, kind and optionally the last 4 digits. Never
 *   usernames, passwords, security answers or full account numbers.
 * - ManualBankBalance: append-only. A balance is never edited or deleted; a correction is a new
 *   row (correctsId). The newest as-of per account that hasn't been corrected is the one shown.
 * - Writes: Banking and reconciliation → Edit (assertLedger(…, "banking", "edit")) on a business
 *   the office works books for. Reads: Banking → View. Every write is audited.
 * - Staff notes stay in the office: clientManualBalances never selects them.
 * - A bank CSV with a running-balance column (importBankCsv) records its newest balance here too
 *   (source BANK_FILE), on the manual account linked to the GL account it was imported into.
 * - signInUrl is the bank's own https sign-in page for the morning bank pull. Bank sign-ins are
 *   kept in the firm's password manager, never in Client Connect.
 */

/** A manual balance older than this is labeled "Not current" on the client's dashboard. */
export const MANUAL_STALE_DAYS = 7;

export const MANUAL_KINDS = { CHECKING: "Checking", SAVINGS: "Savings", CREDIT_CARD: "Credit card", OTHER: "Other" } as const;
export type ManualKind = keyof typeof MANUAL_KINDS;
/** Matches the Plaid feed: checking and savings are cash; cards are owed, never cash. */
export const manualFeedKind = (k: string): "CASH" | "CREDIT" | "OTHER" => (k === "CHECKING" || k === "SAVINGS" ? "CASH" : k === "CREDIT_CARD" ? "CREDIT" : "OTHER");

const MAX_CENTS = 2_000_000_000; // ±$20,000,000 (the column is a 32-bit integer)
/** A balance that a later entry corrected is history, never the current figure. */
const CURRENT = { corrections: { none: {} } };
const clean = (v: string | null | undefined, n: number) => v?.replace(/\s+/g, " ").trim().slice(0, n) || null;

async function assertCanEnter(actor: Actor, clientId: string) {
  await assertLedger(actor, clientId, "banking", "edit");
  await assertManagedBusiness(clientId);
}

/** Exactly four digits, or nothing. A longer number (a full account number) is refused, never trimmed. */
export function validLast4(raw: string | null | undefined) {
  const v = (raw ?? "").replace(/[\s•*.-]/g, "");
  if (!v) return null;
  if (/^\d+$/.test(v) && v.length > 4) throw new ValidationError("Enter only the last 4 digits — never the full account number.");
  if (!/^\d{4}$/.test(v)) throw new ValidationError("Last 4 digits: exactly 4 numbers, or leave it blank.");
  return v;
}

/** The bank's sign-in page: https only, no username or password in the address, or nothing. */
export function validSignInUrl(raw: string | null | undefined) {
  const v = (raw ?? "").trim();
  if (!v) return null;
  let u: URL;
  try {
    u = new URL(v);
  } catch {
    throw new ValidationError("Enter the bank's sign-in page address, starting with https://.");
  }
  if (u.protocol !== "https:") throw new ValidationError("The bank's sign-in page must start with https://.");
  if (u.username || u.password) throw new ValidationError("Never put a username or password in the address. Bank sign-ins are kept in the firm's password manager.");
  if ([...u.searchParams.keys()].some((k) => /pass|pwd|pin|user|login|token|secret|otp|mfa|code/i.test(k))) throw new ValidationError("Remove the sign-in details from the address — use the bank's plain sign-in page.");
  if (v.length > 500) throw new ValidationError("That address is too long.");
  return u.toString();
}

const KIND_OF_SUBTYPE: Record<string, ManualKind> = { BANK: "CHECKING", CREDIT_CARD: "CREDIT_CARD" };

export async function createManualAccount(actor: Actor, clientId: string, input: { name: string; institution?: string | null; last4?: string | null; kind: string; signInUrl?: string | null; ledgerAccountId?: string | null }) {
  await assertCanEnter(actor, clientId);
  if (!(input.kind in MANUAL_KINDS)) throw new ValidationError("Choose the account type.");
  const name = clean(input.name, 80);
  if (!name) throw new ValidationError("Name the account, e.g. Operating checking.");
  const institution = clean(input.institution, 120);
  const last4 = validLast4(input.last4);
  checkText(name, institution);
  const signInUrl = validSignInUrl(input.signInUrl);
  const ledgerAccountId = input.ledgerAccountId ? (await linkableLedger(clientId, input.ledgerAccountId)).id : null;
  const a = await prisma.manualBankAccount.create({ data: { clientId, name, institution, last4, kind: input.kind, createdById: actor.id, signInUrl, ledgerAccountId } });
  await audit(prisma, { actorId: actor.id, action: "banking.manual_account_create", entityType: "ManualBankAccount", entityId: a.id, clientId, details: { kind: a.kind, hasLast4: !!last4 } });
  return a;
}

export async function archiveManualAccount(actor: Actor, clientId: string, accountId: string, now = new Date()) {
  await assertCanEnter(actor, clientId);
  const a = await prisma.manualBankAccount.findFirst({ where: { id: accountId, clientId } });
  if (!a) throw new ValidationError("That account isn't one of this business's.");
  if (a.archivedAt) return a;
  const done = await prisma.manualBankAccount.update({ where: { id: a.id }, data: { archivedAt: now } });
  await audit(prisma, { actorId: actor.id, action: "banking.manual_account_archive", entityType: "ManualBankAccount", entityId: a.id, clientId });
  return done;
}

export type BalanceInput = { accountId: string; amount: string; asOf?: Date | null; note?: string | null; correctsId?: string | null };

/** Checks one entry without writing it. */
async function prepare(clientId: string, e: BalanceInput, now: Date) {
  const account = await prisma.manualBankAccount.findFirst({ where: { id: e.accountId, clientId } });
  if (!account) throw new ValidationError("That account isn't one of this business's.");
  if (account.archivedAt) throw new ValidationError(`${account.name} is archived. Add it again to keep entering balances.`);
  if (!e.amount?.trim()) throw new ValidationError(`Enter the balance for ${account.name}.`);
  const balanceCents = parseCents(e.amount, `balance for ${account.name}`);
  if (Math.abs(balanceCents) > MAX_CENTS) throw new ValidationError(`That balance for ${account.name} is too large.`);
  const asOf = e.asOf ?? now;
  if (Number.isNaN(asOf.getTime())) throw new ValidationError("Enter when the balance was shown at the bank.");
  if (asOf.getTime() > now.getTime() + 5 * 60_000) throw new ValidationError("The as-of time can't be in the future.");
  if (asOf.getTime() < now.getTime() - 366 * 86_400_000) throw new ValidationError("The as-of date is more than a year ago.");
  const note = clean(e.note, 500);
  checkText(note);
  let correctsId: string | null = null;
  if (e.correctsId) {
    const prior = await prisma.manualBankBalance.findFirst({ where: { id: e.correctsId, accountId: account.id, clientId }, select: { id: true } });
    if (!prior) throw new ValidationError("The balance being corrected isn't on this account.");
    correctsId = prior.id;
  }
  return { account, data: { accountId: account.id, clientId, balanceCents, asOf, note, correctsId } };
}

/** Records one observed balance. Never changes an earlier one. */
export async function enterManualBalance(actor: Actor, clientId: string, input: BalanceInput, now = new Date(), opts: { idempotencyKey?: string | null } = {}) {
  const [row] = await enterManualBalances(actor, [{ clientId, ...input }], now, opts);
  return row;
}

/**
 * Several balances in one sitting (one business, or the firm-wide page). Every entry is checked
 * — permission per business included — before anything is written; then all are saved together.
 */
export async function enterManualBalances(actor: Actor, entries: (BalanceInput & { clientId: string })[], now = new Date(), opts: { idempotencyKey?: string | null } = {}) {
  if (!entries.length) throw new ValidationError("Enter at least one balance.");
  const checked = new Set<string>();
  const ready: Awaited<ReturnType<typeof prepare>>[] = [];
  for (const e of entries) {
    if (!checked.has(e.clientId)) {
      await assertCanEnter(actor, e.clientId);
      checked.add(e.clientId);
    }
    ready.push(await prepare(e.clientId, e, now));
  }
  // A double-click or retry of the same form never saves the balances twice.
  return once(opts.idempotencyKey, actor, "manual_balance", () => prisma.$transaction(async (tx) => {
    const rows = [];
    for (const r of ready) {
      const b = await tx.manualBankBalance.create({ data: { ...r.data, enteredById: actor.id, enteredAt: now } });
      await audit(tx, { actorId: actor.id, action: r.data.correctsId ? "banking.manual_balance_correct" : "banking.manual_balance_enter", entityType: "ManualBankBalance", entityId: b.id, clientId: r.data.clientId, details: { accountId: r.account.id, asOf: b.asOf.toISOString(), ...(r.data.correctsId ? { correctsId: r.data.correctsId } : {}) } });
      rows.push(b);
    }
    return rows;
  }), (rows) => rows[0]?.id ?? null);
}

// --- Staff reads --------------------------------------------------------------------------------

/** The office view for one business: every account (archived last) with its full history, notes included. */
export async function manualAccountsForStaff(actor: Actor, clientId: string, historyLimit = 50) {
  await assertLedger(actor, clientId, "banking", "view");
  const accounts = await prisma.manualBankAccount.findMany({
    where: { clientId },
    orderBy: [{ archivedAt: { sort: "asc", nulls: "first" } }, { createdAt: "asc" }],
    include: { balances: { orderBy: [{ asOf: "desc" }, { enteredAt: "desc" }], take: historyLimit, include: { corrections: { select: { id: true } } } } },
  });
  const ids = [...new Set(accounts.flatMap((a) => [a.createdById, ...a.balances.map((b) => b.enteredById)]))];
  const users = ids.length ? await prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } }) : [];
  const nameOf = (id: string) => users.find((u) => u.id === id)?.name ?? "Former staff member";
  return accounts.map((a) => {
    const history = a.balances.map((b) => ({ id: b.id, balanceCents: b.balanceCents, asOf: b.asOf, enteredAt: b.enteredAt, note: b.note, correctsId: b.correctsId, corrected: b.corrections.length > 0, source: b.source, enteredBy: nameOf(b.enteredById) }));
    return { id: a.id, name: a.name, institution: a.institution, last4: a.last4, kind: a.kind as ManualKind, archivedAt: a.archivedAt, signInUrl: a.signInUrl, ledgerAccountId: a.ledgerAccountId, balanceSource: a.balanceSource, createdBy: nameOf(a.createdById), latest: history.find((b) => !b.corrected) ?? null, history };
  });
}

/** Businesses the office works books for, where this staff member may enter balances, with their active manual accounts. */
export async function firmManualBalanceSheet(actor: Actor) {
  const everyone = actor.role === "ADMIN" || (await can(actor, "banking", "edit"));
  const clients = await prisma.client.findMany({
    where: {
      archivedAt: null,
      OR: [{ businessAccess: "ACTIVE" }, { bookkeepingProfile: { active: true } }],
      ...(everyone ? {} : { assignedToId: actor.id }),
      manualBankAccounts: { some: { archivedAt: null } },
    },
    orderBy: [{ businessName: "asc" }, { displayName: "asc" }],
    select: {
      id: true, businessName: true, displayName: true,
      manualBankAccounts: { where: { archivedAt: null }, orderBy: { createdAt: "asc" }, include: { balances: { where: CURRENT, orderBy: [{ asOf: "desc" }, { enteredAt: "desc" }], take: 1 } } },
    },
  });
  return clients.map((c) => ({
    id: c.id, name: c.businessName || c.displayName,
    accounts: c.manualBankAccounts.map((a) => ({ id: a.id, name: a.name, institution: a.institution, last4: a.last4, kind: a.kind as ManualKind, latest: a.balances[0] ? { balanceCents: a.balances[0].balanceCents, asOf: a.balances[0].asOf } : null })),
  }));
}

/** May this staff member enter balances for this business (for showing the forms)? */
export async function canEnterManualBalances(actor: Actor, clientId: string) {
  return canUseLedger(actor, clientId, "banking", "edit");
}

// --- Client-facing --------------------------------------------------------------------------------

/**
 * What the client may see: each active account's newest balance (name, institution, last 4,
 * amount, as-of). Never notes, never who entered it, never history. No access check here —
 * callers check portal or staff access first (see bank-feed.ts).
 */
export type ClientManualBalance = { id: string; name: string; institution: string | null; last4: string | null; kind: "CASH" | "CREDIT" | "OTHER"; ledgerAccountId: string | null; balanceSource: string; balanceCents: number | null; asOf: Date | null; fromFile: boolean };

/**
 * Every active office account (with or without a balance yet — bank-feed.ts matches it to a
 * bank-feed account of the same real account), and its newest balance. Never notes, who entered
 * it, history or the sign-in page.
 */
export async function clientManualBalances(clientId: string): Promise<ClientManualBalance[]> {
  const accounts = await prisma.manualBankAccount.findMany({
    where: { clientId, archivedAt: null },
    orderBy: { createdAt: "asc" },
    select: { id: true, name: true, institution: true, last4: true, kind: true, ledgerAccountId: true, balanceSource: true, balances: { where: CURRENT, orderBy: [{ asOf: "desc" }, { enteredAt: "desc" }], take: 1, select: { balanceCents: true, asOf: true, source: true } } },
  });
  return accounts.map((a) => ({
    id: a.id, name: a.name, institution: a.institution, last4: a.last4, kind: manualFeedKind(a.kind), ledgerAccountId: a.ledgerAccountId, balanceSource: a.balanceSource,
    balanceCents: a.balances[0]?.balanceCents ?? null, asOf: a.balances[0]?.asOf ?? null, fromFile: a.balances[0]?.source === "BANK_FILE",
  }));
}

// --- Bank sign-in page, GL link, bank files ------------------------------------------------------

/** One of this business's bank/card GL accounts that no other manual account is linked to. */
async function linkableLedger(clientId: string, ledgerAccountId: string, exceptManualId?: string) {
  const l = await prisma.ledgerAccount.findFirst({ where: { id: ledgerAccountId, clientId }, include: { manualBankAccount: { select: { id: true } } } });
  if (!l || !isFeedSubtype(l.subtype)) throw new ValidationError("Choose one of this business's bank or credit card GL accounts.");
  if (l.manualBankAccount && l.manualBankAccount.id !== exceptManualId) throw new ValidationError("That GL account is already linked to another account here.");
  return l;
}

export const BALANCE_SOURCES = { AUTO: "Automatic (bank feed when current, else ours)", OFFICE: "Office-entered" } as const;

export async function updateManualAccountLinks(actor: Actor, clientId: string, accountId: string, input: { signInUrl?: string | null; ledgerAccountId?: string | null; balanceSource?: string | null }) {
  await assertCanEnter(actor, clientId);
  const a = await prisma.manualBankAccount.findFirst({ where: { id: accountId, clientId } });
  if (!a) throw new ValidationError("That account isn't one of this business's.");
  const data: Prisma.ManualBankAccountUncheckedUpdateInput = {};
  if (input.signInUrl !== undefined) data.signInUrl = validSignInUrl(input.signInUrl);
  if (input.balanceSource != null) {
    if (!(input.balanceSource in BALANCE_SOURCES)) throw new ValidationError("Choose the balance source.");
    data.balanceSource = input.balanceSource;
  }
  if (input.ledgerAccountId !== undefined) data.ledgerAccountId = input.ledgerAccountId ? (await linkableLedger(clientId, input.ledgerAccountId, a.id)).id : null;
  const done = await prisma.manualBankAccount.update({ where: { id: a.id }, data });
  await audit(prisma, { actorId: actor.id, action: "banking.manual_account_update", entityType: "ManualBankAccount", entityId: a.id, clientId, details: { fields: Object.keys(data) } });
  return done;
}

/** End of that day in the office's time zone, but never later than now. */
export function endOfDayCentral(ymd: string, now = new Date()) {
  const eod = chicagoLocalToUtc(`${ymd}T23:59`)!;
  return eod.getTime() > now.getTime() ? now : eod;
}

export type FileBalanceResult =
  | { status: "RECORDED" | "DUPLICATE"; accountId: string; balanceCents: number; asOf: Date }
  | { status: "AMBIGUOUS" | "NO_BALANCE" | "ARCHIVED"; accountId: string | null; reason: string };

/**
 * The office account linked to this bank/card GL account: the one already linked, else an
 * unlinked one with the same last 4 (now linked), else a new one named after the GL account.
 */
export async function manualForLedger(tx: Prisma.TransactionClient | typeof prisma, actor: Actor, clientId: string, ledger: LedgerAccount) {
  const linked = await tx.manualBankAccount.findUnique({ where: { ledgerAccountId: ledger.id } });
  if (linked) return linked;
  const last4 = ledger.last4 && /^\d{4}$/.test(ledger.last4) ? ledger.last4 : null;
  let manual = last4 ? await tx.manualBankAccount.findFirst({ where: { clientId, last4, ledgerAccountId: null, archivedAt: null } }) : null;
  if (manual) manual = await tx.manualBankAccount.update({ where: { id: manual.id }, data: { ledgerAccountId: ledger.id } });
  else manual = await tx.manualBankAccount.create({ data: { clientId, name: ledger.name.slice(0, 80), institution: ledger.institution?.slice(0, 120) ?? null, last4, kind: KIND_OF_SUBTYPE[ledger.subtype ?? ""] ?? "OTHER", ledgerAccountId: ledger.id, createdById: actor.id } });
  await audit(tx, { actorId: actor.id, action: "banking.manual_account_link", entityType: "ManualBankAccount", entityId: manual.id, clientId, details: { ledgerAccountId: ledger.id } });
  return manual;
}

/**
 * Called by importBankCsv (inside its transaction, after its permission checks) when the file has
 * a running-balance column: records the newest balance on the manual account linked to this GL
 * account — linking one with the same last 4, or creating one, the first time. The same
 * account + as-of + amount is never recorded twice (an overlapping re-import).
 */
export async function recordFileBalance(tx: Prisma.TransactionClient, actor: Actor, clientId: string, ledger: LedgerAccount, rows: ParsedRow[], opts: { fileName: string; importId: string; manualAccountId: string | null; now: Date }): Promise<FileBalanceResult> {
  const newest = newestBalance(rows);
  let manual = opts.manualAccountId
    ? await tx.manualBankAccount.findFirst({ where: { id: opts.manualAccountId, clientId } })
    : await tx.manualBankAccount.findUnique({ where: { ledgerAccountId: ledger.id } });
  if (opts.manualAccountId && !manual) throw new ValidationError("That account isn't one of this business's.");
  if (manual && manual.ledgerAccountId !== ledger.id) {
    if (manual.ledgerAccountId) throw new ValidationError(`${manual.name} is linked to a different GL account.`);
    const taken = await tx.manualBankAccount.findUnique({ where: { ledgerAccountId: ledger.id } });
    if (taken) throw new ValidationError("That GL account is already linked to another account here.");
    manual = await tx.manualBankAccount.update({ where: { id: manual.id }, data: { ledgerAccountId: ledger.id } });
    await audit(tx, { actorId: actor.id, action: "banking.manual_account_update", entityType: "ManualBankAccount", entityId: manual.id, clientId, details: { fields: ["ledgerAccountId"] } });
  }
  // First file with a balance: link the office's account with the same last 4, or add one.
  if (!manual && newest.status === "OK") manual = await manualForLedger(tx, actor, clientId, ledger);
  if (newest.status !== "OK") return { status: newest.status, accountId: manual?.id ?? null, reason: newest.reason };
  if (!manual) return { status: "NO_BALANCE", accountId: null, reason: "No account to record the balance on." };
  if (manual.archivedAt) return { status: "ARCHIVED", accountId: manual.id, reason: `${manual.name} is archived, so the file's balance wasn't recorded.` };
  if (Math.abs(newest.balanceCents) > MAX_CENTS) return { status: "NO_BALANCE", accountId: manual.id, reason: "The file's balance is too large to record." };
  const asOf = endOfDayCentral(newest.date, opts.now);
  // An overlapping re-import: the same day's figure is already there.
  const dayStart = chicagoLocalToUtc(`${newest.date}T00:00`)!;
  const dup = await tx.manualBankBalance.findFirst({ where: { accountId: manual.id, balanceCents: newest.balanceCents, asOf: { gte: dayStart, lte: chicagoLocalToUtc(`${newest.date}T23:59`)! }, source: "BANK_FILE" } });
  if (dup) return { status: "DUPLICATE", accountId: manual.id, balanceCents: dup.balanceCents, asOf: dup.asOf };
  const b = await tx.manualBankBalance.create({
    data: { accountId: manual.id, clientId, balanceCents: newest.balanceCents, asOf, enteredById: actor.id, enteredAt: opts.now, source: "BANK_FILE", importId: opts.importId, note: `From bank file: ${opts.fileName.slice(0, 200)}` },
  });
  await audit(tx, { actorId: actor.id, action: "banking.manual_balance_enter", entityType: "ManualBankBalance", entityId: b.id, clientId, details: { accountId: manual.id, asOf: asOf.toISOString(), source: "BANK_FILE", importId: opts.importId } });
  return { status: "RECORDED", accountId: manual.id, balanceCents: b.balanceCents, asOf };
}

// --- Morning bank pull ---------------------------------------------------------------------------

/** "YYYY-MM-DD" in the office's time zone. */
export const centralDay = (d: Date) => d.toLocaleDateString("en-CA", { timeZone: "America/Chicago" });

/**
 * Today's status for one account (America/Chicago):
 * - DONE_IMPORT / DONE_BALANCE: today's work happened — a bank file imported today, or a current
 *   balance entered today. Only these count toward "N of M done today".
 * - PROBLEM: today's file couldn't give a balance (and none was entered after it).
 * - NEEDS_ATTENTION: nothing done today and the newest balance is older than MANUAL_STALE_DAYS
 *   (or the one entered today is that old).
 * - NOT_STARTED: nothing done yet today.
 */
export type PullStatus =
  | { state: "NOT_STARTED"; lastBalance?: { balanceCents: number; asOf: Date } | null }
  | { state: "NEEDS_ATTENTION"; lastBalance: { balanceCents: number; asOf: Date } | null; by?: string; at?: Date }
  | { state: "DONE_IMPORT" | "DONE_BALANCE" | "PROBLEM"; by: string; at: Date; added?: number; duplicates?: number; balanceCents?: number; balanceAsOf?: Date; problem?: string };

export type StatementStatus = { month: string; label: string; state: "ON_FILE" | "WAITING_SCAN" | "NOT_ON_FILE"; by?: string; at?: Date };

const BALANCE_PROBLEM: Record<string, string> = {
  AMBIGUOUS: "Couldn't tell which balance is newest — enter it by hand.",
  NO_BALANCE: "The newest row had no balance — enter it by hand.",
  ARCHIVED: "The account is archived; the file's balance wasn't recorded.",
};

/** The statement month the morning page tracks: last month (Central time). */
export function statementMonth(now = new Date()) {
  const [y, m] = centralDay(now).split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 2, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}
const monthLabel = (ym: string) => new Date(`${ym}-15T12:00:00Z`).toLocaleDateString("en-US", { month: "short", year: "numeric", timeZone: "UTC" });

/**
 * The morning routine: one row per bank account (the office's accounts and any bank/card GL
 * account not yet linked to one) of every business this staff member may work on, with what was
 * done TODAY (America/Chicago) and whether last month's statement is on file. Rows needing
 * attention come first; rows done today sort to the bottom.
 */
export async function morningPull(actor: Actor, now = new Date()) {
  const everyone = actor.role === "ADMIN" || (await can(actor, "banking", "edit"));
  const today = centralDay(now);
  const start = chicagoLocalToUtc(`${today}T00:00`)!;
  const staleMs = MANUAL_STALE_DAYS * 86_400_000;
  const stmtMonth = statementMonth(now);
  const [sy, sm] = stmtMonth.split("-").map(Number);
  const mStart = new Date(Date.UTC(sy, sm - 1, 1, 12));
  const mEnd = new Date(Date.UTC(sy, sm, 0, 12));
  const clients = await prisma.client.findMany({
    where: { archivedAt: null, OR: [{ businessAccess: "ACTIVE" }, { bookkeepingProfile: { active: true } }], ...(everyone ? {} : { assignedToId: actor.id }) },
    orderBy: [{ businessName: "asc" }, { displayName: "asc" }],
    select: {
      id: true, businessName: true, displayName: true,
      manualBankAccounts: {
        where: { archivedAt: null }, orderBy: { createdAt: "asc" },
        include: {
          balances: { where: CURRENT, orderBy: [{ asOf: "desc" }, { enteredAt: "desc" }], take: 1, select: { balanceCents: true, asOf: true } },
          // This month's statement (or a quarter that ends with it), not deleted.
          statements: { where: { deletedAt: null, periodStart: { lte: mStart }, periodEnd: { gte: mEnd } }, orderBy: { createdAt: "desc" }, select: { scanStatus: true, uploadedByStaffId: true, createdAt: true } },
        },
      },
      ledgerBook: { select: { accounts: { where: { active: true, subtype: { in: ["BANK", "CREDIT_CARD"] } }, orderBy: { code: "asc" }, select: { id: true, code: true, name: true, last4: true, institution: true, subtype: true, manualBankAccount: { select: { id: true } } } } } },
    },
  });
  const ledgerIds = clients.flatMap((c) => c.ledgerBook?.accounts.map((a) => a.id) ?? []);
  const manualIds = clients.flatMap((c) => c.manualBankAccounts.map((a) => a.id));
  const [imports, balances] = await Promise.all([
    ledgerIds.length ? prisma.bankImport.findMany({ where: { accountId: { in: ledgerIds }, createdAt: { gte: start } }, orderBy: { createdAt: "desc" } }) : [],
    manualIds.length ? prisma.manualBankBalance.findMany({ where: { accountId: { in: manualIds }, enteredAt: { gte: start } }, orderBy: { enteredAt: "desc" } }) : [],
  ]);
  const userIds = [...new Set([...imports.map((i) => i.createdById), ...balances.map((b) => b.enteredById), ...clients.flatMap((c) => c.manualBankAccounts.flatMap((m) => m.statements.map((d) => d.uploadedByStaffId ?? "")))].filter(Boolean))];
  const users = userIds.length ? await prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, name: true } }) : [];
  const nameOf = (id: string) => users.find((u) => u.id === id)?.name ?? "Former staff member";
  const current = (asOf: Date) => now.getTime() - asOf.getTime() <= staleMs;

  const statusOf = (ledgerId: string | null, manualId: string | null, last: { balanceCents: number; asOf: Date } | null): PullStatus => {
    const imp = ledgerId ? imports.filter((i) => i.accountId === ledgerId) : [];
    const bal = manualId ? balances.find((b) => b.accountId === manualId) : undefined;
    const lastImp = imp[0];
    const counts = imp.length ? { added: imp.reduce((n, i) => n + i.added, 0), duplicates: imp.reduce((n, i) => n + i.duplicates, 0) } : {};
    if (lastImp?.balanceStatus && BALANCE_PROBLEM[lastImp.balanceStatus] && (!bal || bal.enteredAt < lastImp.createdAt)) {
      return { state: "PROBLEM", by: nameOf(lastImp.createdById), at: lastImp.createdAt, ...counts, problem: BALANCE_PROBLEM[lastImp.balanceStatus] };
    }
    if (bal && current(bal.asOf)) return { state: "DONE_BALANCE", by: nameOf(bal.enteredById), at: bal.enteredAt, balanceCents: bal.balanceCents, balanceAsOf: bal.asOf, ...counts };
    if (lastImp) return { state: "DONE_IMPORT", by: nameOf(lastImp.createdById), at: lastImp.createdAt, ...counts, ...(lastImp.skipped ? { problem: `${lastImp.skipped} row(s) couldn't be read` } : {}) };
    // An old figure — even one typed in today — isn't today's work.
    if (bal) return { state: "NEEDS_ATTENTION", lastBalance: { balanceCents: bal.balanceCents, asOf: bal.asOf }, by: nameOf(bal.enteredById), at: bal.enteredAt };
    if (last && !current(last.asOf)) return { state: "NEEDS_ATTENTION", lastBalance: last };
    return { state: "NOT_STARTED", lastBalance: last };
  };
  const stmtOf = (docs: { scanStatus: string; uploadedByStaffId: string | null; createdAt: Date }[]): StatementStatus => {
    const clean = docs.find((d) => d.scanStatus === "CLEAN");
    const label = monthLabel(stmtMonth);
    if (clean) return { month: stmtMonth, label, state: "ON_FILE", by: clean.uploadedByStaffId ? nameOf(clean.uploadedByStaffId) : undefined, at: clean.createdAt };
    // Filed but not (yet) scanned clean: doesn't count.
    if (docs.some((d) => d.scanStatus !== "INFECTED")) return { month: stmtMonth, label, state: "WAITING_SCAN", by: docs[0].uploadedByStaffId ? nameOf(docs[0].uploadedByStaffId) : undefined, at: docs[0].createdAt };
    return { month: stmtMonth, label, state: "NOT_ON_FILE" };
  };

  const rows = clients.flatMap((c) => {
    const name = c.businessName || c.displayName;
    const ledger = c.ledgerBook?.accounts ?? [];
    const unlinked = ledger.filter((l) => !l.manualBankAccount);
    const fromManual = c.manualBankAccounts.map((m) => {
      const l = ledger.find((x) => x.id === m.ledgerAccountId) ?? null;
      const last = m.balances[0] ? { balanceCents: m.balances[0].balanceCents, asOf: m.balances[0].asOf } : null;
      return { key: m.id, clientId: c.id, clientName: name, manualAccountId: m.id as string | null, ledgerAccountId: m.ledgerAccountId, name: m.name, last4: m.last4, institution: m.institution, signInUrl: m.signInUrl, glLabel: l ? `${l.code} ${l.name}` : null, linkChoices: m.ledgerAccountId ? [] : unlinked.map((u) => ({ id: u.id, label: `${u.code} ${u.name}` })), status: statusOf(m.ledgerAccountId, m.id, last), statement: stmtOf(m.statements) };
    });
    const fromLedger = unlinked.map((l) => ({ key: l.id, clientId: c.id, clientName: name, manualAccountId: null as string | null, ledgerAccountId: l.id as string | null, name: l.name, last4: l.last4, institution: l.institution, signInUrl: null as string | null, glLabel: `${l.code} ${l.name}`, linkChoices: [] as { id: string; label: string }[], status: statusOf(l.id, null, null), statement: stmtOf([]) }));
    return [...fromManual, ...fromLedger];
  });
  const rank = (r: (typeof rows)[number]) => ({ PROBLEM: 0, NEEDS_ATTENTION: 0, NOT_STARTED: 1, DONE_IMPORT: 2, DONE_BALANCE: 2 })[r.status.state];
  // Needs attention and problems first, then not started, done today last (stable within each group).
  const sorted = [...rows].sort((a, b) => rank(a) - rank(b));
  const done = rows.filter((r) => rank(r) === 2).length;
  return { today, statementMonth: stmtMonth, rows: sorted, done, total: rows.length };
}

/**
 * "Import yesterday's CSV" on the morning page: the Books page's importBankCsv (same
 * permission checks, same de-duplication) into the account's GL account, with its balance
 * recorded on this manual account. An unlinked manual account is linked to the GL account chosen.
 */
export async function morningImport(actor: Actor, clientId: string, input: { manualAccountId?: string | null; ledgerAccountId?: string | null; fileName: string; text: string }, now = new Date(), opts: { idempotencyKey?: string | null } = {}) {
  await assertCanEnter(actor, clientId);
  let ledgerAccountId = input.ledgerAccountId ?? null;
  if (input.manualAccountId) {
    const m = await prisma.manualBankAccount.findFirst({ where: { id: input.manualAccountId, clientId } });
    if (!m) throw new ValidationError("That account isn't one of this business's.");
    if (m.archivedAt) throw new ValidationError(`${m.name} is archived.`);
    if (m.ledgerAccountId) ledgerAccountId = m.ledgerAccountId;
    else {
      if (!ledgerAccountId) throw new ValidationError(`Choose the GL account ${m.name}'s transactions go to.`);
      await linkableLedger(clientId, ledgerAccountId, m.id);
    }
  }
  if (!ledgerAccountId) throw new ValidationError("Choose the account to import into.");
  return importBankCsv(actor, clientId, ledgerAccountId, { fileName: input.fileName, text: input.text }, { manualAccountId: input.manualAccountId ?? null, now, idempotencyKey: opts.idempotencyKey });
}
