import "server-only";
import { createHash } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { audit } from "@/lib/audit";
import { ForbiddenError, type Actor } from "@/lib/auth/actor";
import { ValidationError } from "./clients";
import { isReportApprover } from "./bookkeeping-clients";
import { can } from "@/lib/auth/permissions";
import { recordFileBalance } from "./manual-bank";
import { once } from "./office-actions";

/**
 * Client bookkeeping ledger: real double-entry books, one set per client.
 *
 * Rules this module enforces:
 * - Every function is scoped to one client; accounts and entries from another client are refused.
 * - Every entry balances (debits = credits) and every line is one-sided.
 * - Entries are never edited or deleted. A correction is a reversal plus a new entry; both stay.
 * - The same source (opening balances, a bank transaction) is posted at most once.
 * - Nothing can be posted or reversed on or before the closed-through date (approved periods).
 * - Nothing here invents a transaction or balance: entries come from staff, opening balances
 *   staff enter, or bank rows imported from the client's statements.
 */

type Tx = Prisma.TransactionClient;
export type Basis = "CASH" | "ACCRUAL";
export const ACCOUNT_TYPES = { ASSET: "Asset", LIABILITY: "Liability", EQUITY: "Equity", INCOME: "Income", EXPENSE: "Expense" } as const;
export type AccountType = keyof typeof ACCOUNT_TYPES;
export const SUBTYPES: Record<string, { label: string; type: AccountType }> = {
  BANK: { label: "Bank account", type: "ASSET" },
  AR: { label: "Accounts receivable", type: "ASSET" },
  CLEARING: { label: "Payments in transit (clearing)", type: "ASSET" },
  CREDIT_CARD: { label: "Credit card", type: "LIABILITY" },
  LINE_OF_CREDIT: { label: "Line of credit", type: "LIABILITY" },
  LOAN: { label: "Loan", type: "LIABILITY" },
  AP: { label: "Accounts payable", type: "LIABILITY" },
  OWNER_CONTRIBUTION: { label: "Owner contributions", type: "EQUITY" },
  OWNER_DRAW: { label: "Owner draws", type: "EQUITY" },
  RETAINED_EARNINGS: { label: "Retained earnings", type: "EQUITY" },
  OPENING_BALANCE: { label: "Opening balance equity", type: "EQUITY" },
  OTHER_INCOME: { label: "Other income", type: "INCOME" },
  COGS: { label: "Cost of goods sold", type: "EXPENSE" },
  OTHER_EXPENSE: { label: "Other expense", type: "EXPENSE" },
  SUSPENSE: { label: "Needs review (suspense)", type: "EXPENSE" },
};
const DEBIT_NORMAL = new Set<string>(["ASSET", "EXPENSE"]);
/** Ledger accounts that hold a bank feed or statement: bank (asset) and card / line of credit / loan (liabilities). */
export const FEED_SUBTYPES = ["BANK", "CREDIT_CARD", "LINE_OF_CREDIT", "LOAN"];
export const isFeedSubtype = (s: string | null | undefined) => !!s && FEED_SUBTYPES.includes(s);

/** A small standard chart of accounts. Staff add, rename or deactivate accounts per client. */
export const DEFAULT_CHART: { code: string; name: string; type: AccountType; subtype?: string }[] = [
  { code: "1000", name: "Business Checking", type: "ASSET", subtype: "BANK" },
  { code: "1100", name: "Accounts Receivable", type: "ASSET", subtype: "AR" },
  { code: "1200", name: "Payments in Transit (Undeposited)", type: "ASSET", subtype: "CLEARING" },
  { code: "1500", name: "Equipment", type: "ASSET" },
  { code: "2000", name: "Accounts Payable", type: "LIABILITY", subtype: "AP" },
  { code: "2100", name: "Business Credit Card", type: "LIABILITY", subtype: "CREDIT_CARD" },
  { code: "2500", name: "Loans Payable", type: "LIABILITY" },
  { code: "3000", name: "Owner's Capital / Contributions", type: "EQUITY", subtype: "OWNER_CONTRIBUTION" },
  { code: "3100", name: "Owner's Draws", type: "EQUITY", subtype: "OWNER_DRAW" },
  { code: "3200", name: "Retained Earnings", type: "EQUITY", subtype: "RETAINED_EARNINGS" },
  { code: "3900", name: "Opening Balance Equity", type: "EQUITY", subtype: "OPENING_BALANCE" },
  { code: "4000", name: "Sales / Service Income", type: "INCOME" },
  { code: "4900", name: "Other Income", type: "INCOME", subtype: "OTHER_INCOME" },
  { code: "5000", name: "Cost of Goods Sold", type: "EXPENSE", subtype: "COGS" },
  { code: "6000", name: "Advertising & Marketing", type: "EXPENSE" },
  { code: "6100", name: "Bank Service Charges", type: "EXPENSE" },
  { code: "6150", name: "Merchant Processing Fees", type: "EXPENSE" },
  { code: "6200", name: "Insurance", type: "EXPENSE" },
  { code: "6300", name: "Office Supplies", type: "EXPENSE" },
  { code: "6400", name: "Professional Fees", type: "EXPENSE" },
  { code: "6500", name: "Rent", type: "EXPENSE" },
  { code: "6600", name: "Software & Subscriptions", type: "EXPENSE" },
  { code: "6700", name: "Utilities & Phone", type: "EXPENSE" },
  { code: "6800", name: "Travel", type: "EXPENSE" },
  { code: "6900", name: "Meals", type: "EXPENSE" },
  { code: "7000", name: "Payroll & Contract Labor", type: "EXPENSE" },
  { code: "7900", name: "Other Expense", type: "EXPENSE", subtype: "OTHER_EXPENSE" },
  { code: "9999", name: "Ask My Accountant (needs review)", type: "EXPENSE", subtype: "SUSPENSE" },
];

// --- Dates and money -------------------------------------------------------------------------

export const isYmd = (s: string) => /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`)) && new Date(`${s}T00:00:00Z`).toISOString().startsWith(s);
export const toDate = (ymd: string) => new Date(`${ymd}T00:00:00.000Z`);
export const ymdOf = (d: Date) => d.toISOString().slice(0, 10);
const monthOf = (d: string) => d.slice(0, 7);
const addMonths = (month: string, n: number) => {
  const [y, m] = month.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1 + n, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
};
const lastDayOf = (month: string) => ymdOf(new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)));
export const todayCentral = () => new Date().toLocaleDateString("en-CA", { timeZone: "America/Chicago" });

/** "1,234.56", "$1,234.56", "-12", "(12.00)" → cents. Throws on anything else. */
export function parseCents(input: string | number, field = "amount"): number {
  const raw = String(input).trim();
  const neg = /^\(.*\)$/.test(raw) || raw.startsWith("-");
  const s = raw.replace(/[()$,\s-]/g, "");
  if (!/^\d+(\.\d{1,2})?$/.test(s)) throw new ValidationError(`Enter a valid ${field}, e.g. 1,250.00.`);
  const cents = Math.round(Number(s) * 100);
  if (cents > 100_000_000_000) throw new ValidationError(`That ${field} is too large.`);
  return neg ? -cents : cents;
}
export const usd = (c: number) => `${c < 0 ? "-" : ""}$${(Math.abs(c) / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

// --- Access ------------------------------------------------------------------------------------

/** Admins, or the staff member assigned to this client (the same rule as the bookkeeping workspace's Coetha link). */
export type BooksArea = "ledger" | "banking";

/**
 * Admins and the assigned staff member work in a client's books (unchanged). Staff Access &
 * Permissions adds others: "General ledger" or "Banking and reconciliation" → View to see every
 * managed client's books, → Edit to work in them. Checked in the database on every call.
 */
export async function canUseLedger(actor: Actor, clientId: string, area: BooksArea = "ledger", action: "view" | "edit" = "view") {
  if (actor.role === "ADMIN") return true;
  const c = await prisma.client.findUnique({ where: { id: clientId }, select: { assignedToId: true } });
  if (c?.assignedToId === actor.id) return true;
  return can(actor, area, action);
}
export async function assertLedger(actor: Actor, clientId: string, area: BooksArea = "ledger", action: "view" | "edit" = "view") {
  if (!(await canUseLedger(actor, clientId, area, action))) throw new ForbiddenError("Only Admins, the staff member assigned to this client and staff Tabitha allows can work in its books.");
}
/**
 * Who may WORK on a business's books from the office (ledger writes, bank feeds, Coetha,
 * business invoicing): any client the office keeps books for — an active Bookkeeping Client —
 * or an owner-approved Managed Business. This is about the OFFICE only. Client-facing portal
 * access (the client seeing their business books, statements and uploads into bookkeeping
 * months) is a separate gate (effectiveGrant in src/lib/portal/access.ts) and still requires
 * owner-approved Managed Business access. Nothing here grants or changes client access.
 */
export async function officeMayWorkBooks(clientId: string, db: Tx | typeof prisma = prisma) {
  const c = await db.client.findUnique({ where: { id: clientId }, select: { businessAccess: true, archivedAt: true, bookkeepingProfile: { select: { active: true } } } });
  if (!c || c.archivedAt) return false;
  return c.businessAccess === "ACTIVE" || !!c.bookkeepingProfile?.active;
}
export const OFFICE_BOOKS_REFUSED = "This client is a Regular Tax Client and isn't on the Bookkeeping Client list. Add them as a Bookkeeping Client (or approve Managed Business access) before building business books, bank feeds or business invoices.";
/**
 * Kept under its old name so every caller stays the same: office work on a business's books.
 * (Previously this required Managed Business access; now any active Bookkeeping Client is
 * enough for the office. Reading existing history never needed either.)
 */
export async function assertManagedBusiness(clientId: string, db: Tx | typeof prisma = prisma) {
  if (!(await officeMayWorkBooks(clientId, db))) throw new ForbiddenError(OFFICE_BOOKS_REFUSED);
}
/** Client IDs whose books the office works on (for scheduled jobs). */
export async function officeBookClientIds() {
  const rows = await prisma.client.findMany({ where: { archivedAt: null, OR: [{ businessAccess: "ACTIVE" }, { bookkeepingProfile: { active: true } }] }, select: { id: true } });
  return rows.map((r) => r.id);
}
export async function assertLedgerWrite(actor: Actor, clientId: string, area: BooksArea = "ledger") {
  await assertLedger(actor, clientId, area, "edit");
  await assertManagedBusiness(clientId);
}
async function assertOwner(actor: Actor, what: string) {
  if (!(await isReportApprover(actor))) throw new ForbiddenError(`Only Tabitha can ${what}.`);
}
export async function bookOf(clientId: string, db: Tx | typeof prisma = prisma) {
  const b = await db.ledgerBook.findUnique({ where: { clientId } });
  if (!b) throw new ValidationError("Set up this client's books first.");
  return b;
}

// --- Setup and accounts ----------------------------------------------------------------------

export async function setupLedger(actor: Actor, clientId: string, input: { basis: Basis; fiscalYearStartMonth?: number }) {
  await assertLedgerWrite(actor, clientId);
  if (input.basis !== "CASH" && input.basis !== "ACCRUAL") throw new ValidationError("Choose cash or accrual basis.");
  const fy = input.fiscalYearStartMonth ?? 1;
  if (!Number.isInteger(fy) || fy < 1 || fy > 12) throw new ValidationError("Choose the month the fiscal year starts.");
  const client = await prisma.client.findUnique({ where: { id: clientId }, select: { archivedAt: true } });
  if (!client || client.archivedAt) throw new ValidationError("Client not found.");
  if (await prisma.ledgerBook.count({ where: { clientId } })) throw new ValidationError("This client's books are already set up.");
  const book = await prisma.$transaction(async (tx) => {
    const book = await tx.ledgerBook.create({ data: { clientId, basis: input.basis, fiscalYearStartMonth: fy, createdById: actor.id } });
    await tx.ledgerAccount.createMany({ data: DEFAULT_CHART.map((a) => ({ clientId, code: a.code, name: a.name, type: a.type, subtype: a.subtype ?? null })) });
    await audit(tx, { actorId: actor.id, action: "ledger.setup", entityType: "LedgerBook", entityId: clientId, clientId, details: { basis: input.basis, fiscalYearStartMonth: fy } });
    return book;
  });
  // Accounts registered before the books existed get their GL accounts now, so their statements import.
  const { linkRegisteredAccounts } = await import("./bank-accounts");
  await linkRegisteredAccounts(clientId, actor.id);
  return book;
}

export type AccountInput = { code: string; name: string; type: string; subtype?: string | null; description?: string; institution?: string; last4?: string };

export function cleanAccount(input: AccountInput) {
  const code = input.code.trim();
  const name = input.name.trim().slice(0, 120);
  if (!/^[0-9A-Za-z.-]{1,12}$/.test(code)) throw new ValidationError("Account number: up to 12 letters, digits, dots or dashes.");
  if (!name) throw new ValidationError("Name the account.");
  if (!(input.type in ACCOUNT_TYPES)) throw new ValidationError("Choose the account type.");
  const subtype = input.subtype || null;
  if (subtype && SUBTYPES[subtype]?.type !== input.type) throw new ValidationError("That account kind doesn't match the account type.");
  const last4 = input.last4?.trim() || null;
  if (last4 && !/^\d{4}$/.test(last4)) throw new ValidationError("Enter only the last four digits of the account number.");
  return { code, name, type: input.type, subtype, description: input.description?.trim().slice(0, 300) || null, institution: input.institution?.trim().slice(0, 80) || null, last4 };
}

export async function addAccount(actor: Actor, clientId: string, input: AccountInput) {
  await assertLedgerWrite(actor, clientId);
  await bookOf(clientId);
  const data = cleanAccount(input);
  if (await prisma.ledgerAccount.count({ where: { clientId, code: data.code } })) throw new ValidationError(`Account ${data.code} already exists.`);
  const a = await prisma.ledgerAccount.create({ data: { clientId, ...data } });
  await audit(prisma, { actorId: actor.id, action: "ledger.account_added", entityType: "LedgerAccount", entityId: a.id, clientId, details: { code: a.code, name: a.name, type: a.type } });
  return a;
}

/** Rename, re-describe or (de)activate. The type can change only while the account has no entries. */
export async function updateAccount(actor: Actor, clientId: string, accountId: string, input: Partial<AccountInput> & { active?: boolean }) {
  await assertLedgerWrite(actor, clientId);
  const a = await prisma.ledgerAccount.findFirst({ where: { id: accountId, clientId } });
  if (!a) throw new ValidationError("Account not found.");
  const next = cleanAccount({ code: input.code ?? a.code, name: input.name ?? a.name, type: input.type ?? a.type, subtype: input.subtype !== undefined ? input.subtype : a.subtype, description: input.description ?? a.description ?? "", institution: input.institution ?? a.institution ?? "", last4: input.last4 ?? a.last4 ?? "" });
  const used = await prisma.journalLine.count({ where: { accountId } });
  if (used && (next.type !== a.type || next.subtype !== a.subtype)) throw new ValidationError("This account already has entries, so its type can't change. Create a new account and move the balance with an adjusting entry.");
  if (next.code !== a.code && (await prisma.ledgerAccount.count({ where: { clientId, code: next.code } }))) throw new ValidationError(`Account ${next.code} already exists.`);
  const updated = await prisma.ledgerAccount.update({ where: { id: accountId }, data: { ...next, ...(input.active !== undefined ? { active: input.active } : {}) } });
  await audit(prisma, { actorId: actor.id, action: "ledger.account_updated", entityType: "LedgerAccount", entityId: accountId, clientId, details: { before: { code: a.code, name: a.name, active: a.active }, after: { code: updated.code, name: updated.name, active: updated.active } } });
  return updated;
}

// --- Posting ----------------------------------------------------------------------------------

export type LineInput = { accountId: string; debit?: string | number; credit?: string | number; description?: string };
type PostInput = { date: string; memo: string; lines: LineInput[]; source: string; sourceKey?: string | null; basis?: "BOTH" | "CASH_ONLY" | "ACCRUAL_ONLY"; reason?: string | null; reversalOfId?: string | null };

function assertOpenDate(book: { openingDate: Date | null; lockedThrough: Date | null }, date: string, what = "post") {
  if (!isYmd(date)) throw new ValidationError("Enter a valid date.");
  if (book.lockedThrough && date <= ymdOf(book.lockedThrough)) throw new ValidationError(`The books are closed through ${ymdOf(book.lockedThrough)} (approved statements), so nothing can be ${what === "post" ? "posted" : "reversed"} on or before that date. Reopen the month first (General Ledger → Reopen) to post a correction in it.`);
  if (book.openingDate && date < ymdOf(book.openingDate)) throw new ValidationError(`Entries can't be dated before the opening balances (${ymdOf(book.openingDate)}).`);
}

/** The one place entries are written. Validates balance, accounts, dates and duplicates inside the caller's transaction. */
export async function postEntryTx(tx: Tx, actor: Actor, clientId: string, input: PostInput) {
  return post(tx, actor, clientId, input);
}
async function post(tx: Tx, actor: Actor, clientId: string, input: PostInput) {
  const book = await bookOf(clientId, tx);
  // Saves for one client's books run one at a time.
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${"ledger:" + clientId}))`;
  assertOpenDate(book, input.date);
  const memo = input.memo.trim().slice(0, 300);
  if (!memo) throw new ValidationError("Describe the entry.");
  const lines = input.lines
    .map((l) => ({ accountId: l.accountId, debitCents: l.debit ? parseCents(l.debit, "debit") : 0, creditCents: l.credit ? parseCents(l.credit, "credit") : 0, description: l.description?.trim().slice(0, 200) || null }))
    .filter((l) => l.accountId && (l.debitCents || l.creditCents));
  if (lines.length < 2) throw new ValidationError("An entry needs at least two lines.");
  if (lines.some((l) => l.debitCents < 0 || l.creditCents < 0 || (l.debitCents > 0 && l.creditCents > 0))) throw new ValidationError("Each line is either a debit or a credit, and amounts are positive.");
  const dr = lines.reduce((n, l) => n + l.debitCents, 0);
  const cr = lines.reduce((n, l) => n + l.creditCents, 0);
  if (dr !== cr) throw new ValidationError(`Debits (${usd(dr)}) and credits (${usd(cr)}) must be equal.`);
  const ids = [...new Set(lines.map((l) => l.accountId))];
  const accounts = await tx.ledgerAccount.findMany({ where: { id: { in: ids }, clientId } });
  if (accounts.length !== ids.length) throw new ValidationError("Every line must use one of this client's own accounts.");
  if (accounts.some((a) => !a.active) && input.source !== "REVERSAL") throw new ValidationError("One of those accounts is inactive.");
  if (input.sourceKey && (await tx.journalEntry.count({ where: { clientId, sourceKey: input.sourceKey } }))) throw new ValidationError("That has already been posted, so it wasn't posted again.");
  const entry = await tx.journalEntry.create({
    data: { clientId, date: toDate(input.date), memo, source: input.source, sourceKey: input.sourceKey ?? null, basis: input.basis ?? "BOTH", reason: input.reason ?? null, reversalOfId: input.reversalOfId ?? null, createdById: actor.id, lines: { create: lines } },
    include: { lines: true },
  });
  await audit(tx, { actorId: actor.id, action: "ledger.entry_posted", entityType: "JournalEntry", entityId: entry.id, clientId, details: { date: input.date, source: input.source, totalCents: dr, lines: lines.length } });
  return entry;
}

export async function postJournalEntry(actor: Actor, clientId: string, input: { date: string; memo: string; lines: LineInput[]; adjusting?: boolean; basis?: "BOTH" | "CASH_ONLY" | "ACCRUAL_ONLY" }) {
  await assertLedgerWrite(actor, clientId);
  const basis = input.basis ?? "BOTH";
  if (!["BOTH", "CASH_ONLY", "ACCRUAL_ONLY"].includes(basis)) throw new ValidationError("Choose which statements this entry belongs to.");
  return prisma.$transaction((tx) => postJournalEntryTx(tx, actor, clientId, input));
}

/**
 * postJournalEntry inside the caller's transaction. `sourceKey` makes the posting
 * once-only (a second post with the same key is refused). The caller checks access.
 */
export async function postJournalEntryTx(tx: Tx, actor: Actor, clientId: string, input: { date: string; memo: string; lines: LineInput[]; adjusting?: boolean; basis?: "BOTH" | "CASH_ONLY" | "ACCRUAL_ONLY"; sourceKey?: string; reason?: string }) {
  const basis = input.basis ?? "BOTH";
  if (!["BOTH", "CASH_ONLY", "ACCRUAL_ONLY"].includes(basis)) throw new ValidationError("Choose which statements this entry belongs to.");
  return post(tx, actor, clientId, { date: input.date, memo: input.memo, lines: input.lines, source: input.adjusting ? "ADJUSTMENT" : "MANUAL", basis, sourceKey: input.sourceKey ?? null, reason: input.reason ?? null });
}

/**
 * Corrections never edit history: the entry is reversed by a mirror entry (dated in an open
 * period) and both stay. A bank transaction whose entry is reversed goes back to review.
 */
export async function reverseEntry(actor: Actor, clientId: string, entryId: string, input: { date: string; reason: string }) {
  await assertLedgerWrite(actor, clientId);
  const reason = input.reason.trim();
  if (reason.length < 5) throw new ValidationError("Record why this entry is being reversed.");
  return prisma.$transaction(async (tx) => {
    const e = await tx.journalEntry.findFirst({ where: { id: entryId, clientId }, include: { lines: true, reversedBy: { select: { id: true } } } });
    if (!e) throw new ValidationError("Entry not found.");
    if (e.reversalOfId) throw new ValidationError("A reversal can't itself be reversed. Post a new entry instead.");
    if (e.reversedBy) throw new ValidationError("That entry was already reversed.");
    if (e.source === "OPENING") throw new ValidationError("Opening balances are corrected with an adjusting entry, not reversed.");
    if (input.date < ymdOf(e.date)) throw new ValidationError("A reversal can't be dated before the entry it reverses.");
    const r = await post(tx, actor, clientId, {
      date: input.date, memo: `Reversal of: ${e.memo}`.slice(0, 300), source: "REVERSAL", basis: e.basis as PostInput["basis"], reason: reason.slice(0, 300), reversalOfId: e.id,
      lines: e.lines.map((l) => ({ accountId: l.accountId, debit: l.creditCents ? (l.creditCents / 100).toFixed(2) : undefined, credit: l.debitCents ? (l.debitCents / 100).toFixed(2) : undefined, description: l.description ?? undefined })),
    });
    // The bank row(s) behind it are reviewed again, so the transaction is never lost or doubled.
    const back = await tx.bankTransaction.updateMany({ where: { clientId, journalEntryId: e.id }, data: { status: "UNREVIEWED", journalEntryId: null, reviewedById: null, reviewedAt: null, flag: null, flagNote: null } });
    await audit(tx, { actorId: actor.id, action: "ledger.entry_reversed", entityType: "JournalEntry", entityId: e.id, clientId, details: { reversalId: r.id, reason: reason.slice(0, 300), bankRowsReopened: back.count } });
    return r;
  });
}

/**
 * Opening balances, posted once: each balance-sheet account's balance on the opening date
 * (as the client's statements show it). The difference goes to Opening Balance Equity.
 */
export async function postOpeningBalances(actor: Actor, clientId: string, input: { date: string; balances: { accountId: string; amount: string }[] }) {
  await assertLedgerWrite(actor, clientId);
  return prisma.$transaction(async (tx) => {
    const book = await bookOf(clientId, tx);
    if (book.openingDate || (await tx.journalEntry.count({ where: { clientId, sourceKey: "opening" } }))) throw new ValidationError("Opening balances were already posted. Correct them with an adjusting entry.");
    if (await tx.journalEntry.count({ where: { clientId, date: { lt: toDate(input.date) } } })) throw new ValidationError("There are entries before that date. Choose an opening date on or before the first entry.");
    const ids = input.balances.filter((b) => b.amount.trim()).map((b) => b.accountId);
    const accounts = await tx.ledgerAccount.findMany({ where: { id: { in: ids }, clientId } });
    if (accounts.length !== new Set(ids).size) throw new ValidationError("Every balance must be for one of this client's own accounts.");
    if (accounts.some((a) => a.type === "INCOME" || a.type === "EXPENSE")) throw new ValidationError("Opening balances are for asset, liability and equity accounts only.");
    const plug = await tx.ledgerAccount.findFirst({ where: { clientId, subtype: "OPENING_BALANCE" } });
    if (!plug) throw new ValidationError("Add an Opening Balance Equity account first.");
    const lines: LineInput[] = [];
    let net = 0; // debits minus credits
    for (const b of input.balances) {
      if (!b.amount.trim()) continue;
      const a = accounts.find((x) => x.id === b.accountId)!;
      const cents = parseCents(b.amount, `opening balance for ${a.name}`);
      if (!cents) continue;
      // A positive balance sits on the account's normal side.
      const debit = DEBIT_NORMAL.has(a.type) ? cents > 0 : cents < 0;
      const abs = (Math.abs(cents) / 100).toFixed(2);
      lines.push(debit ? { accountId: a.id, debit: abs } : { accountId: a.id, credit: abs });
      net += debit ? Math.abs(cents) : -Math.abs(cents);
    }
    if (!lines.length) throw new ValidationError("Enter at least one opening balance.");
    if (net) lines.push(net > 0 ? { accountId: plug.id, credit: (net / 100).toFixed(2) } : { accountId: plug.id, debit: (-net / 100).toFixed(2) });
    if (lines.length < 2) throw new ValidationError("Enter at least one opening balance.");
    const e = await post(tx, actor, clientId, { date: input.date, memo: "Opening balances", lines, source: "OPENING", sourceKey: "opening" });
    await tx.ledgerBook.update({ where: { clientId }, data: { openingDate: toDate(input.date) } });
    return e;
  });
}

// --- Bank statement import -------------------------------------------------------------------

/** Minimal RFC-4180 CSV parser (quoted fields, escaped quotes, CRLF). */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let q = false;
  const t = text.replace(/^﻿/, "");
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (q) {
      if (c === '"' && t[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') q = false;
      else field += c;
    } else if (c === '"') q = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && t[i + 1] === "\n") i++;
      row.push(field); field = "";
      if (row.some((f) => f.trim())) rows.push(row);
      row = [];
    } else field += c;
  }
  row.push(field);
  if (row.some((f) => f.trim())) rows.push(row);
  return rows;
}

function parseBankDate(s: string): string | null {
  const v = s.trim();
  let m = v.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) { const d = `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`; return isYmd(d) ? d : null; }
  m = v.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/);
  if (m) { const y = m[3].length === 2 ? `20${m[3]}` : m[3]; const d = `${y}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}`; return isYmd(d) ? d : null; }
  return null;
}

/** balanceCents: the bank's running balance after this row, only when the file has a balance column. */
export type ParsedRow = { date: string; amountCents: number; description: string; balanceCents?: number | null };

/**
 * An optional running-balance column ("Balance", "Running Balance", "Ledger Balance", "Available
 * Balance", …). When a file has several, the running/ledger balance is preferred over available.
 */
const BALANCE_HEADERS = [/^(running |ledger |current |account )?balance( \(usd\))?$/, /^balance (after|amount)$/, /^available balance( \(usd\))?$/];
function balanceColumn(head: string[]) {
  for (const re of BALANCE_HEADERS) {
    const i = head.findIndex((h) => re.test(h));
    if (i >= 0) return i;
  }
  return -1;
}

/**
 * The newest running balance in a bank file: the row last in time. Banks export oldest-first or
 * newest-first; the dates say which. Same-day rows follow that order. When the dates don't say
 * (all on one day, or out of order), nothing is picked.
 */
export function newestBalance(rows: ParsedRow[]): { status: "OK"; date: string; balanceCents: number } | { status: "AMBIGUOUS" | "NO_BALANCE"; reason: string } {
  if (!rows.length) return { status: "NO_BALANCE", reason: "No rows with a balance." };
  const dates = rows.map((r) => r.date);
  const asc = dates.every((d, i) => i === 0 || dates[i - 1] <= d);
  const desc = dates.every((d, i) => i === 0 || dates[i - 1] >= d);
  let last: ParsedRow;
  if (rows.length === 1) last = rows[0];
  else if (asc && !desc) last = rows[rows.length - 1];
  else if (desc && !asc) last = rows[0];
  else return { status: "AMBIGUOUS", reason: "Couldn't tell which balance is newest (the rows aren't in date order, or they're all on one day). Enter the balance by hand." };
  if (last.balanceCents == null) return { status: "NO_BALANCE", reason: "The newest row has no balance." };
  return { status: "OK", date: last.date, balanceCents: last.balanceCents };
}

/** Reads a bank's CSV export: a date column, a description column, and either one signed amount or debit/credit columns (plus an optional running balance). */
export function parseBankCsv(text: string): { rows: ParsedRow[]; problems: string[]; hasBalance: boolean } {
  const all = parseCsv(text);
  if (all.length < 2) throw new ValidationError("That file has no transactions.");
  const head = all[0].map((h) => h.trim().toLowerCase());
  const find = (re: RegExp) => head.findIndex((h) => re.test(h));
  const iDate = find(/^(posting |post |transaction |trans )?date$|^date posted$|^posted date$/);
  const iDesc = find(/desc|memo|payee|details|^name$|narrative/);
  const iAmt = find(/^amount$|^amount \(usd\)$|^transaction amount$/);
  const iDebit = find(/debit|withdraw|money out|^payments?$/);
  const iCredit = find(/credit|deposit|money in/);
  const iBal = balanceColumn(head);
  if (iDate < 0 || iDesc < 0 || (iAmt < 0 && (iDebit < 0 || iCredit < 0))) throw new ValidationError("Couldn't find the Date, Description and Amount (or Debit and Credit) columns. Export the statement as CSV with a header row.");
  const rows: ParsedRow[] = [];
  const problems: string[] = [];
  for (let r = 1; r < all.length; r++) {
    const cells = all[r];
    const date = parseBankDate(cells[iDate] ?? "");
    const description = (cells[iDesc] ?? "").replace(/\s+/g, " ").trim().slice(0, 300);
    try {
      let amountCents: number;
      if (iAmt >= 0) amountCents = parseCents(cells[iAmt] ?? "");
      else {
        const d = (cells[iDebit] ?? "").trim() ? Math.abs(parseCents(cells[iDebit])) : 0;
        const c = (cells[iCredit] ?? "").trim() ? Math.abs(parseCents(cells[iCredit])) : 0;
        amountCents = c - d;
      }
      if (!date) throw new Error("date");
      if (!amountCents) { problems.push(`Row ${r + 1}: zero amount, skipped`); continue; }
      const row: ParsedRow = { date, amountCents, description: description || "(no description)" };
      if (iBal >= 0) {
        // An unreadable balance never stops the transaction itself from importing.
        const raw = (cells[iBal] ?? "").trim();
        let bal: number | null = null;
        try { bal = raw ? parseCents(raw) : null; } catch { bal = null; }
        row.balanceCents = bal;
      }
      rows.push(row);
    } catch {
      problems.push(`Row ${r + 1}: couldn't read the ${!date ? "date" : "amount"}, skipped`);
    }
  }
  return { rows, problems, hasBalance: iBal >= 0 };
}

export const normDesc = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]+/g, " ").trim();
/** Identical rows on the same day (two $38.50 fees) are kept apart by their order in the statement. */
export function fingerprints(rows: ParsedRow[]) {
  const seen = new Map<string, number>();
  return rows.map((r) => {
    const base = `${r.date}|${r.amountCents}|${normDesc(r.description)}`;
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    return createHash("sha256").update(`${base}|${n}`).digest("hex");
  });
}

/**
 * Imports a bank or card statement CSV into one of the client's bank/credit-card accounts.
 * Rows already imported (for example from an overlapping statement) are skipped, never doubled.
 * Imported rows are not posted until staff review them.
 */
export async function importBankCsv(actor: Actor, clientId: string, accountId: string, input: { fileName: string; text: string }, opts: { manualAccountId?: string | null; now?: Date; idempotencyKey?: string | null } = {}) {
  await assertLedgerWrite(actor, clientId, "banking");
  const account = await prisma.ledgerAccount.findFirst({ where: { id: accountId, clientId } });
  if (!account || !isFeedSubtype(account.subtype)) throw new ValidationError("Choose one of this client's bank or credit card accounts.");
  if (input.text.length > 5_000_000) throw new ValidationError("That file is too large. Import one statement at a time.");
  const { rows, problems, hasBalance } = parseBankCsv(input.text);
  if (!rows.length) throw new ValidationError(`No transactions could be read. ${problems.slice(0, 3).join("; ")}`);
  const prints = fingerprints(rows);
  const sha = createHash("sha256").update(input.text).digest("hex");
  // A double-click or retry of the same import form never imports twice.
  return once(opts.idempotencyKey, actor, "bank_import", () => prisma.$transaction(async (tx) => {
    // Imports and daily retrieval for one client run one at a time.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${"bank-rows:" + clientId}))`;
    const dates = rows.map((r) => r.date).sort();
    const imp = await tx.bankImport.create({ data: { clientId, accountId, fileName: input.fileName.slice(0, 200), fileSha256: sha, rows: rows.length, added: 0, duplicates: 0, firstDate: toDate(dates[0]), lastDate: toDate(dates.at(-1)!), createdById: actor.id } });
    const seen = new Set(
      (await tx.bankTransaction.findMany({ where: { accountId, OR: [{ fingerprint: { in: prints } }, { statementFingerprint: { in: prints } }] }, select: { fingerprint: true, statementFingerprint: true } }))
        .flatMap((r) => [r.fingerprint, r.statementFingerprint]).filter((x): x is string => !!x),
    );
    let added = 0, duplicates = 0, matched = 0, flagged = 0;
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      if (seen.has(prints[i])) { duplicates++; continue; }
      // Already brought in by daily retrieval? Confirm that row instead of adding a second one.
      const m = await crossSourceMatch(tx, accountId, r, "CSV");
      if (m.match) {
        await tx.bankTransaction.update({ where: { id: m.match.id }, data: { statementFingerprint: prints[i] } });
        matched++;
        continue;
      }
      // Already brought in from another file of the same period (a bank CSV and the PDF statement
      // word the same transaction differently)? Link it instead of adding a second one.
      const f = await fileSourceMatch(tx, accountId, r, { importId: imp.id, first: dates[0], last: dates.at(-1)! });
      if (f.match) {
        await tx.bankTransaction.update({ where: { id: f.match.id }, data: { statementFingerprint: prints[i] } });
        matched++;
        continue;
      }
      const flag = m.ambiguous
        ? { flag: "POSSIBLE_DUPLICATE", flagNote: "Looks like more than one row retrieved from the bank. Check before posting." }
        : f.ambiguous ? { flag: "POSSIBLE_DUPLICATE", flagNote: "Another file for this period has a transaction like this one. Check before posting." } : {};
      await tx.bankTransaction.create({
        data: { clientId, accountId, importId: imp.id, date: toDate(r.date), amountCents: r.amountCents, description: r.description, fingerprint: prints[i], source: "CSV", ...flag },
      });
      added++;
      if (m.ambiguous || f.ambiguous) flagged++;
      seen.add(prints[i]);
    }
    // Rows before the opening date are already inside the opening balances: kept, but excluded with that reason.
    const book = await bookOf(clientId, tx);
    if (book.openingDate) await tx.bankTransaction.updateMany({ where: { importId: imp.id, status: "UNREVIEWED", date: { lt: book.openingDate } }, data: { status: "EXCLUDED", excludedReason: "Before the opening balances date (already included in the opening balance)" } });
    // The file's running balance, if it has one, becomes the business's "Updated by our office" balance.
    const balance = hasBalance ? await recordFileBalance(tx, actor, clientId, account, rows, { fileName: input.fileName, importId: imp.id, manualAccountId: opts.manualAccountId ?? null, now: opts.now ?? new Date() }) : null;
    const updated = await tx.bankImport.update({ where: { id: imp.id }, data: { added, duplicates: duplicates + matched, skipped: problems.length, balanceStatus: balance?.status ?? null } });
    await audit(tx, { actorId: actor.id, action: "ledger.bank_imported", entityType: "BankImport", entityId: imp.id, clientId, details: { account: account.code, rows: rows.length, added, duplicates, matchedToRetrieved: matched, flagged, skipped: problems.length, ...(balance ? { balance: balance.status } : {}) } });
    return { ...updated, matched, flagged, problems, balance };
  }));
}

export const MATCH_WINDOW_DAYS = 3;
const words = (s: string) => new Set(normDesc(s).split(" ").filter((w) => w.length > 2 && !/^\d+$/.test(w)));

/**
 * The one existing row from the OTHER source (statement vs. daily retrieval) that is the same
 * transaction: same account, same amount, dated within a few days. Several equally good
 * candidates are "ambiguous" — nothing is merged; the new row is flagged for staff instead.
 */
export async function crossSourceMatch(tx: Tx, accountId: string, row: { date: string; amountCents: number; description: string }, incoming: "CSV" | "PLAID") {
  const d = toDate(row.date).getTime();
  const candidates = await tx.bankTransaction.findMany({
    where: {
      accountId, amountCents: row.amountCents,
      date: { gte: new Date(d - MATCH_WINDOW_DAYS * 86_400_000), lte: new Date(d + MATCH_WINDOW_DAYS * 86_400_000) },
      ...(incoming === "PLAID" ? { providerId: null } : { providerId: { not: null }, statementFingerprint: null }),
    },
  });
  if (!candidates.length) return { match: null, ambiguous: false };
  const mine = words(row.description);
  const score = (c: (typeof candidates)[number]) => (ymdOf(c.date) === row.date ? 2 : 0) + ([...words(c.description)].some((w) => mine.has(w)) ? 1 : 0) - Math.abs(c.date.getTime() - d) / 86_400_000 / 10;
  const ranked = candidates.map((c) => ({ c, s: score(c) })).sort((a, b) => b.s - a.s);
  // Identical rows (two $38.50 fees the same day) are interchangeable: link them one for one.
  const same = (x: (typeof candidates)[number], y: (typeof candidates)[number]) => x.date.getTime() === y.date.getTime() && normDesc(x.description) === normDesc(y.description);
  if (ranked.length > 1 && ranked[0].s - ranked[1].s < 0.5 && !same(ranked[0].c, ranked[1].c)) return { match: null, ambiguous: true };
  return { match: ranked[0].c, ambiguous: false };
}

/**
 * The one row already imported from ANOTHER file (bank CSV or PDF statement) that is the same
 * transaction: same account and amount, dated within a few days, not yet linked to a file, and
 * only when both files cover each other's date (so a row just outside one file's period is never
 * merged with a different transaction). Several equally good candidates: nothing is merged and the
 * new row is flagged for staff.
 */
export async function fileSourceMatch(tx: Tx, accountId: string, row: { date: string; amountCents: number; description: string }, file: { importId: string; first: string; last: string }) {
  const d = toDate(row.date).getTime();
  const lo = Math.max(d - MATCH_WINDOW_DAYS * 86_400_000, toDate(file.first).getTime());
  const hi = Math.min(d + MATCH_WINDOW_DAYS * 86_400_000, toDate(file.last).getTime());
  const candidates = (await tx.bankTransaction.findMany({
    where: { accountId, amountCents: row.amountCents, providerId: null, statementFingerprint: null, importId: { not: file.importId }, date: { gte: new Date(lo), lte: new Date(hi) } },
    include: { import: { select: { firstDate: true, lastDate: true } } },
  })).filter((c) => !!c.import?.firstDate && !!c.import.lastDate && c.import.firstDate.getTime() <= d && c.import.lastDate.getTime() >= d);
  if (!candidates.length) return { match: null, ambiguous: false };
  const mine = words(row.description);
  const score = (c: (typeof candidates)[number]) => (ymdOf(c.date) === row.date ? 2 : 0) + ([...words(c.description)].some((w) => mine.has(w)) ? 1 : 0) - Math.abs(c.date.getTime() - d) / 86_400_000 / 10;
  const ranked = candidates.map((c) => ({ c, s: score(c) })).sort((a, b) => b.s - a.s);
  const same = (x: (typeof candidates)[number], y: (typeof candidates)[number]) => x.date.getTime() === y.date.getTime() && normDesc(x.description) === normDesc(y.description);
  if (ranked.length > 1 && ranked[0].s - ranked[1].s < 0.5 && !same(ranked[0].c, ranked[1].c)) return { match: null, ambiguous: true };
  return { match: ranked[0].c, ambiguous: false };
}

const TRANSFER_WINDOW_DAYS = 5;

/**
 * Posts one reviewed bank row to a category. When the category is another of the client's bank
 * or card accounts (a transfer or card payment), the matching row on that account is linked to
 * the same entry, so the movement is recorded once, not twice.
 */
export async function categorizeBankTransaction(actor: Actor, clientId: string, txnId: string, input: { accountId: string; memo?: string }) {
  await assertLedgerWrite(actor, clientId, "banking");
  return prisma.$transaction((tx) => categorizeBankTransactionTx(tx, actor, clientId, txnId, input));
}

/**
 * The same posting inside the caller's transaction (used when Tabitha approves a Coetha
 * proposal, so the approval and the posting succeed or fail together). The caller has
 * already checked access with assertLedgerWrite.
 */
export async function categorizeBankTransactionTx(tx: Tx, actor: Actor, clientId: string, txnId: string, input: { accountId: string; memo?: string }) {
  {
    const t = await tx.bankTransaction.findFirst({ where: { id: txnId, clientId }, include: { account: true } });
    if (!t) throw new ValidationError("Bank transaction not found.");
    if (t.status !== "UNREVIEWED") throw new ValidationError(t.status === "POSTED" ? "That transaction is already posted." : "That transaction was excluded. Include it again first.");
    const cat = await tx.ledgerAccount.findFirst({ where: { id: input.accountId, clientId, active: true } });
    if (!cat) throw new ValidationError("Choose one of this client's active accounts.");
    if (cat.id === t.accountId) throw new ValidationError("Choose a category other than the bank account itself.");
    if (cat.subtype === "OPENING_BALANCE") throw new ValidationError("Bank activity can't be posted to Opening Balance Equity.");
    const amt = (Math.abs(t.amountCents) / 100).toFixed(2);
    const date = ymdOf(t.date);
    // Claim the row first, so two people can't post it at the same moment.
    const claimed = await tx.bankTransaction.updateMany({ where: { id: t.id, status: "UNREVIEWED" }, data: { status: "POSTED", postings: { increment: 1 }, reviewedById: actor.id, reviewedAt: new Date(), flag: null, flagNote: null } });
    if (!claimed.count) throw new ValidationError("That transaction was just posted by someone else.");
    const lines: LineInput[] = t.amountCents > 0 ? [{ accountId: t.accountId, debit: amt }, { accountId: cat.id, credit: amt }] : [{ accountId: cat.id, debit: amt }, { accountId: t.accountId, credit: amt }];
    const e = await post(tx, actor, clientId, { date, memo: (input.memo?.trim() || t.description).slice(0, 300), lines, source: "BANK", sourceKey: `bank:${t.id}:${t.postings + 1}` });
    await tx.bankTransaction.update({ where: { id: t.id }, data: { journalEntryId: e.id } });
    let matched: string | null = null;
    if (isFeedSubtype(cat.subtype)) {
      const lo = new Date(t.date.getTime() - TRANSFER_WINDOW_DAYS * 86_400_000);
      const hi = new Date(t.date.getTime() + TRANSFER_WINDOW_DAYS * 86_400_000);
      // Money out of one account shows as money in (or a payment) on the other.
      const other = await tx.bankTransaction.findFirst({ where: { clientId, accountId: cat.id, status: "UNREVIEWED", amountCents: -t.amountCents, date: { gte: lo, lte: hi } }, orderBy: { date: "asc" } });
      if (other) {
        await tx.bankTransaction.update({ where: { id: other.id }, data: { status: "POSTED", journalEntryId: e.id, postings: { increment: 1 }, reviewedById: actor.id, reviewedAt: new Date() } });
        matched = other.id;
      }
    }
    await audit(tx, { actorId: actor.id, action: "ledger.bank_posted", entityType: "BankTransaction", entityId: t.id, clientId, details: { entryId: e.id, category: cat.code, matchedTransferRow: matched } });
    return { entry: e, matchedTransferId: matched };
  }
}

/** Excluded rows (a duplicate in the file, a personal item kept off the books) stay visible with the reason. */
export async function excludeBankTransaction(actor: Actor, clientId: string, txnId: string, reason: string) {
  await assertLedgerWrite(actor, clientId, "banking");
  if (reason.trim().length < 3) throw new ValidationError("Record why this transaction is excluded.");
  const r = await prisma.bankTransaction.updateMany({ where: { id: txnId, clientId, status: "UNREVIEWED" }, data: { status: "EXCLUDED", excludedReason: reason.trim().slice(0, 200), reviewedById: actor.id, reviewedAt: new Date(), flag: null, flagNote: null } });
  if (!r.count) throw new ValidationError("Only an unreviewed transaction can be excluded. Reverse a posted one instead.");
  await audit(prisma, { actorId: actor.id, action: "ledger.bank_excluded", entityType: "BankTransaction", entityId: txnId, clientId, details: { reason: reason.trim().slice(0, 200) } });
}

/** A person confirms a flagged, already-posted row is fine as it is (recorded with their note). */
export async function clearBankFlag(actor: Actor, clientId: string, txnId: string, note: string) {
  await assertLedgerWrite(actor, clientId, "banking");
  if (note.trim().length < 5) throw new ValidationError("Note what you checked.");
  const t = await prisma.bankTransaction.findFirst({ where: { id: txnId, clientId, flag: { not: null } } });
  if (!t) throw new ValidationError("That transaction isn't flagged.");
  await prisma.bankTransaction.update({ where: { id: t.id }, data: { flag: null, flagNote: null } });
  await audit(prisma, { actorId: actor.id, action: "ledger.bank_flag_cleared", entityType: "BankTransaction", entityId: t.id, clientId, details: { flag: t.flag, note: note.trim().slice(0, 300) } });
}

export async function includeBankTransaction(actor: Actor, clientId: string, txnId: string) {
  await assertLedgerWrite(actor, clientId, "banking");
  const r = await prisma.bankTransaction.updateMany({ where: { id: txnId, clientId, status: "EXCLUDED" }, data: { status: "UNREVIEWED", excludedReason: null, reviewedById: null, reviewedAt: null } });
  if (!r.count) throw new ValidationError("That transaction isn't excluded.");
  await audit(prisma, { actorId: actor.id, action: "ledger.bank_included", entityType: "BankTransaction", entityId: txnId, clientId });
}

// --- Balances, reconciliation and reports ------------------------------------------------------

const basisFilter = (basis: Basis) => ({ in: basis === "CASH" ? ["BOTH", "CASH_ONLY"] : ["BOTH", "ACCRUAL_ONLY"] });

/** Natural-sign balance per account (debit-normal: debits − credits; credit-normal: credits − debits). */
async function balancesBy(clientId: string, where: Prisma.JournalEntryWhereInput) {
  const sums = await prisma.journalLine.groupBy({ by: ["accountId"], where: { entry: { clientId, ...where } }, _sum: { debitCents: true, creditCents: true } });
  return new Map(sums.map((s) => [s.accountId, { dr: s._sum.debitCents ?? 0, cr: s._sum.creditCents ?? 0 }]));
}
const natural = (type: string, s: { dr: number; cr: number } | undefined) => (s ? (DEBIT_NORMAL.has(type) ? s.dr - s.cr : s.cr - s.dr) : 0);

export async function accountBalance(clientId: string, accountId: string, asOf: string, basis: Basis = "CASH") {
  const a = await prisma.ledgerAccount.findFirst({ where: { id: accountId, clientId } });
  if (!a) throw new ValidationError("Account not found.");
  const m = await balancesBy(clientId, { date: { lte: toDate(asOf) }, basis: basisFilter(basis) });
  return natural(a.type, m.get(accountId));
}

/**
 * Reconciles a bank or card account to the statement's ending balance. Saved only when the
 * ledger matches the statement to the cent and every bank row through that date is reviewed.
 */
export async function reconcileAccount(actor: Actor, clientId: string, accountId: string, input: { statementDate: string; statementBalance: string }) {
  await assertLedgerWrite(actor, clientId, "banking");
  if (!isYmd(input.statementDate)) throw new ValidationError("Enter the statement's ending date.");
  const account = await prisma.ledgerAccount.findFirst({ where: { id: accountId, clientId } });
  if (!account || !isFeedSubtype(account.subtype)) throw new ValidationError("Choose one of this client's bank or credit card accounts.");
  const statementCents = parseCents(input.statementBalance, "statement ending balance");
  const ledgerCents = await accountBalance(clientId, accountId, input.statementDate, "CASH");
  const unreviewed = await prisma.bankTransaction.count({ where: { clientId, accountId, status: "UNREVIEWED", date: { lte: toDate(input.statementDate) } } });
  const difference = statementCents - ledgerCents;
  if (difference !== 0 || unreviewed > 0) return { reconciled: false as const, statementCents, ledgerCents, difference, unreviewed };
  const rec = await prisma.bankReconciliation.upsert({
    where: { accountId_statementDate: { accountId, statementDate: toDate(input.statementDate) } },
    create: { clientId, accountId, statementDate: toDate(input.statementDate), statementBalanceCents: statementCents, ledgerBalanceCents: ledgerCents, completedById: actor.id },
    update: { statementBalanceCents: statementCents, ledgerBalanceCents: ledgerCents, completedById: actor.id },
  });
  await audit(prisma, { actorId: actor.id, action: "ledger.reconciled", entityType: "BankReconciliation", entityId: rec.id, clientId, details: { account: account.code, statementDate: input.statementDate, balanceCents: statementCents } });
  return { reconciled: true as const, statementCents, ledgerCents, difference: 0, unreviewed: 0, id: rec.id };
}

export type ReportRow = { accountId: string; code: string; name: string; months: number[]; total: number };

/** Profit & Loss with a column per month and a total, from this client's entries only. Owner draws are equity, so never here. */
export async function profitAndLoss(actor: Actor, clientId: string, input: { from: string; to: string; basis?: Basis }) {
  await assertLedger(actor, clientId);
  return profitAndLossFor(clientId, input);
}

/**
 * The same report without a staff actor. Callers check access first: the client portal uses it
 * only after requireClientAccess(…, "bookkeeping"), and only for months whose statements were released.
 */
export async function profitAndLossFor(clientId: string, input: { from: string; to: string; basis?: Basis }) {
  const book = await bookOf(clientId);
  if (!isYmd(input.from) || !isYmd(input.to) || input.from > input.to) throw new ValidationError("Choose a valid date range.");
  const basis = input.basis ?? (book.basis as Basis);
  const months: string[] = [];
  for (let m = monthOf(input.from); m <= monthOf(input.to) && months.length < 36; m = addMonths(m, 1)) months.push(m);
  const [accounts, lines] = await Promise.all([
    prisma.ledgerAccount.findMany({ where: { clientId, type: { in: ["INCOME", "EXPENSE"] } }, orderBy: { code: "asc" } }),
    prisma.journalLine.findMany({ where: { entry: { clientId, date: { gte: toDate(input.from), lte: toDate(input.to) }, basis: basisFilter(basis) }, account: { type: { in: ["INCOME", "EXPENSE"] } } }, select: { accountId: true, debitCents: true, creditCents: true, entry: { select: { date: true } } } }),
  ]);
  const grid = new Map<string, number[]>();
  for (const l of lines) {
    const a = accounts.find((x) => x.id === l.accountId)!;
    const i = months.indexOf(monthOf(ymdOf(l.entry.date)));
    if (i < 0) continue;
    const row = grid.get(a.id) ?? months.map(() => 0);
    row[i] += a.type === "INCOME" ? l.creditCents - l.debitCents : l.debitCents - l.creditCents;
    grid.set(a.id, row);
  }
  const section = (pred: (a: (typeof accounts)[number]) => boolean): ReportRow[] =>
    accounts.filter(pred).filter((a) => grid.has(a.id)).map((a) => { const m = grid.get(a.id)!; return { accountId: a.id, code: a.code, name: a.name, months: m, total: m.reduce((x, y) => x + y, 0) }; });
  const sum = (rows: ReportRow[]) => ({ months: months.map((_, i) => rows.reduce((n, r) => n + r.months[i], 0)), total: rows.reduce((n, r) => n + r.total, 0) });
  const income = section((a) => a.type === "INCOME" && a.subtype !== "OTHER_INCOME");
  const cogs = section((a) => a.subtype === "COGS");
  const expenses = section((a) => a.type === "EXPENSE" && a.subtype !== "COGS" && a.subtype !== "OTHER_EXPENSE");
  const otherIncome = section((a) => a.subtype === "OTHER_INCOME");
  const otherExpense = section((a) => a.subtype === "OTHER_EXPENSE");
  const [ti, tc, te, toi, toe] = [sum(income), sum(cogs), sum(expenses), sum(otherIncome), sum(otherExpense)];
  const combine = (f: (i: number) => number) => ({ months: months.map((_, i) => f(i)), total: 0 });
  const gross = combine((i) => ti.months[i] - tc.months[i]); gross.total = ti.total - tc.total;
  const operating = combine((i) => gross.months[i] - te.months[i]); operating.total = gross.total - te.total;
  const net = combine((i) => operating.months[i] + toi.months[i] - toe.months[i]); net.total = operating.total + toi.total - toe.total;
  return { basis, from: input.from, to: input.to, months, income, totalIncome: ti, cogs, totalCogs: tc, grossProfit: gross, expenses, totalExpenses: te, operatingIncome: operating, otherIncome, totalOtherIncome: toi, otherExpense, totalOtherExpense: toe, netIncome: net };
}

function fiscalYearStart(asOf: string, startMonth: number) {
  const y = Number(asOf.slice(0, 4));
  const m = Number(asOf.slice(5, 7));
  return `${m >= startMonth ? y : y - 1}-${String(startMonth).padStart(2, "0")}-01`;
}

/** Balance Sheet as of a date. Net income before this fiscal year rolls into retained earnings. */
export async function balanceSheet(actor: Actor, clientId: string, input: { asOf: string; basis?: Basis }) {
  await assertLedger(actor, clientId);
  const book = await bookOf(clientId);
  if (!isYmd(input.asOf)) throw new ValidationError("Choose the balance sheet date.");
  const basis = input.basis ?? (book.basis as Basis);
  const fyStart = fiscalYearStart(input.asOf, book.fiscalYearStartMonth);
  const [accounts, all, prior] = await Promise.all([
    prisma.ledgerAccount.findMany({ where: { clientId }, orderBy: { code: "asc" } }),
    balancesBy(clientId, { date: { lte: toDate(input.asOf) }, basis: basisFilter(basis) }),
    balancesBy(clientId, { date: { lt: toDate(fyStart) }, basis: basisFilter(basis) }),
  ]);
  const row = (a: (typeof accounts)[number]) => ({ accountId: a.id, code: a.code, name: a.name, subtype: a.subtype, amount: natural(a.type, all.get(a.id)) });
  const pick = (type: string) => accounts.filter((a) => a.type === type).map(row).filter((r) => r.amount !== 0);
  const ni = (m: Map<string, { dr: number; cr: number }>) => accounts.reduce((n, a) => n + (a.type === "INCOME" ? natural("INCOME", m.get(a.id)) : a.type === "EXPENSE" ? -natural("EXPENSE", m.get(a.id)) : 0), 0);
  const priorEarnings = ni(prior);
  const currentEarnings = ni(all) - priorEarnings;
  const assets = pick("ASSET");
  const liabilities = pick("LIABILITY");
  const equity = pick("EQUITY");
  const totalAssets = assets.reduce((n, r) => n + r.amount, 0);
  const totalLiabilities = liabilities.reduce((n, r) => n + r.amount, 0);
  const totalEquity = equity.reduce((n, r) => n + r.amount, 0) + priorEarnings + currentEarnings;
  return {
    basis, asOf: input.asOf, fiscalYearStart: fyStart, assets, totalAssets, liabilities, totalLiabilities, equity,
    retainedEarningsFromPriorYears: priorEarnings, netIncomeThisYear: currentEarnings, totalEquity,
    totalLiabilitiesAndEquity: totalLiabilities + totalEquity,
    balanced: totalAssets === totalLiabilities + totalEquity,
  };
}

// --- Closing approved periods ------------------------------------------------------------------

/** Tabitha closes the books through a date once statements are approved. Nothing on or before it can change. */
export async function closeBooksThrough(actor: Actor, clientId: string, through: string) {
  await assertOwner(actor, "close a client's books");
  if (!isYmd(through)) throw new ValidationError("Choose the last day to close.");
  const book = await bookOf(clientId);
  if (book.lockedThrough && through <= ymdOf(book.lockedThrough)) throw new ValidationError(`Already closed through ${ymdOf(book.lockedThrough)}.`);
  await prisma.ledgerBook.update({ where: { clientId }, data: { lockedThrough: toDate(through), lockedById: actor.id, lockedAt: new Date() } });
  await audit(prisma, { actorId: actor.id, action: "ledger.closed_through", entityType: "LedgerBook", entityId: clientId, clientId, details: { through, previous: book.lockedThrough ? ymdOf(book.lockedThrough) : null } });
}

/** Reopening is Tabitha's decision, with a reason, and is recorded in the history. */
export async function reopenBooks(actor: Actor, clientId: string, input: { through: string | null; reason: string }) {
  await assertOwner(actor, "reopen a closed period");
  if (input.reason.trim().length < 5) throw new ValidationError("Record why the period is being reopened.");
  if (input.through && !isYmd(input.through)) throw new ValidationError("Choose a valid date.");
  const book = await bookOf(clientId);
  if (!book.lockedThrough) throw new ValidationError("Nothing is closed.");
  if (input.through && input.through >= ymdOf(book.lockedThrough)) throw new ValidationError("Choose a date before the current closed-through date.");
  await prisma.ledgerBook.update({ where: { clientId }, data: { lockedThrough: input.through ? toDate(input.through) : null, lockedById: actor.id, lockedAt: new Date() } });
  await audit(prisma, { actorId: actor.id, action: "ledger.reopened", entityType: "LedgerBook", entityId: clientId, clientId, details: { from: ymdOf(book.lockedThrough), to: input.through, reason: input.reason.trim().slice(0, 300) } });
}

export async function setBasis(actor: Actor, clientId: string, basis: Basis) {
  await assertOwner(actor, "change a client's reporting basis");
  if (basis !== "CASH" && basis !== "ACCRUAL") throw new ValidationError("Choose cash or accrual basis.");
  const book = await bookOf(clientId);
  await prisma.ledgerBook.update({ where: { clientId }, data: { basis } });
  await audit(prisma, { actorId: actor.id, action: "ledger.basis_changed", entityType: "LedgerBook", entityId: clientId, clientId, details: { from: book.basis, to: basis } });
}

// --- Review flags (what Coetha and staff must look at; nothing is guessed) --------------------

const DRAW_WORDS = /\b(OWNER DRAW|DRAW|TRANSFER TO .*(SAVINGS|PERSONAL)|ZELLE TO|VENMO|CASH APP|ATM WITHDRAWAL)\b/;

export type Flag = { kind: "CARD_PAYMENT_AS_EXPENSE" | "UNREVIEWED" | "CLOSED_PERIOD" | "MISSING_STATEMENT" | "UNRECONCILED" | "SUSPENSE" | "POSSIBLE_DRAW" | "NO_OPENING" | "POSSIBLE_DUPLICATE_INCOME" | "UNDEPOSITED" | "BANK_ROW_FLAGGED" | "BANK_CONNECTION"; severity: "HIGH" | "MEDIUM"; message: string };

export async function ledgerFlags(actor: Actor, clientId: string, today = todayCentral()) {
  await assertLedger(actor, clientId);
  const book = await bookOf(clientId);
  const flags: Flag[] = [];
  if (!book.openingDate) flags.push({ kind: "NO_OPENING", severity: "HIGH", message: "Opening balances haven't been entered, so the Balance Sheet can't tie to the bank yet." });
  const unreviewed = await prisma.bankTransaction.findMany({ where: { clientId, status: "UNREVIEWED" }, select: { date: true }, orderBy: { date: "asc" } });
  const rowFlags = await prisma.bankTransaction.groupBy({ by: ["flag"], where: { clientId, flag: { not: null }, status: { not: "EXCLUDED" } }, _count: true });
  const FLAG_TEXT: Record<string, string> = { POSSIBLE_DUPLICATE: "may be duplicates between a statement import and daily retrieval", CHANGED_AFTER_POSTING: "were changed by the bank after they were posted", REMOVED_AFTER_POSTING: "were removed by the bank after they were posted" };
  for (const f of rowFlags) flags.push({ kind: "BANK_ROW_FLAGGED", severity: "HIGH", message: `${f._count} bank transaction${f._count === 1 ? "" : "s"} ${FLAG_TEXT[f.flag!] ?? "need a closer look"}.` });
  const conns = await prisma.bankConnection.findMany({ where: { clientId, status: { not: "DISCONNECTED" } }, select: { institutionName: true, status: true, lastSuccessAt: true } });
  for (const c of conns) {
    const name = c.institutionName ?? "Bank connection";
    if (c.status === "NEEDS_REAUTH") flags.push({ kind: "BANK_CONNECTION", severity: "HIGH", message: `${name}: the client needs to sign in to the bank again before daily retrieval can continue.` });
    else if (c.status === "ERROR") flags.push({ kind: "BANK_CONNECTION", severity: "HIGH", message: `${name}: the last daily retrieval failed.` });
    else if (!c.lastSuccessAt || Date.now() - c.lastSuccessAt.getTime() > 36 * 3600_000) flags.push({ kind: "BANK_CONNECTION", severity: "MEDIUM", message: `${name}: no successful retrieval in the last 36 hours.` });
  }
  if (unreviewed.length) flags.push({ kind: "UNREVIEWED", severity: "HIGH", message: `${unreviewed.length} bank transaction${unreviewed.length === 1 ? "" : "s"} not yet reviewed (oldest ${ymdOf(unreviewed[0].date)}).` });
  if (book.lockedThrough) {
    const late = unreviewed.filter((u) => u.date <= book.lockedThrough!).length;
    if (late) flags.push({ kind: "CLOSED_PERIOD", severity: "HIGH", message: `${late} imported bank transaction${late === 1 ? "" : "s"} fall in a closed period (through ${ymdOf(book.lockedThrough)}) — possibly missing from approved statements. Tabitha decides how to correct.` });
  }
  const lastMonth = addMonths(monthOf(today), -1);
  const banks = await prisma.ledgerAccount.findMany({ where: { clientId, active: true, subtype: { in: FEED_SUBTYPES } } });
  for (const b of banks) {
    const [range, recon] = await Promise.all([
      prisma.bankTransaction.aggregate({ where: { accountId: b.id }, _min: { date: true }, _max: { date: true } }),
      prisma.bankReconciliation.findFirst({ where: { accountId: b.id }, orderBy: { statementDate: "desc" } }),
    ]);
    if (!range._min.date) {
      flags.push({ kind: "MISSING_STATEMENT", severity: "MEDIUM", message: `${b.name}: no statement imported yet.` });
      continue;
    }
    // Months between the first imported row and last month with no rows at all.
    const months = new Set((await prisma.bankTransaction.findMany({ where: { accountId: b.id }, select: { date: true } })).map((t) => monthOf(ymdOf(t.date))));
    const gaps: string[] = [];
    for (let m = monthOf(ymdOf(range._min.date)); m <= lastMonth && gaps.length < 12; m = addMonths(m, 1)) if (!months.has(m)) gaps.push(m);
    if (gaps.length) flags.push({ kind: "MISSING_STATEMENT", severity: "HIGH", message: `${b.name}: no transactions imported for ${gaps.join(", ")} — the statement may be missing.` });
    if (!recon || ymdOf(recon.statementDate) < lastDayOf(lastMonth)) flags.push({ kind: "UNRECONCILED", severity: "HIGH", message: `${b.name}: not reconciled through ${lastDayOf(lastMonth)}${recon ? ` (last reconciled ${ymdOf(recon.statementDate)})` : ""}.` });
  }
  const suspense = await prisma.journalLine.aggregate({ where: { entry: { clientId }, account: { subtype: "SUSPENSE" } }, _sum: { debitCents: true, creditCents: true } });
  const parked = (suspense._sum.debitCents ?? 0) - (suspense._sum.creditCents ?? 0);
  if (parked) flags.push({ kind: "SUSPENSE", severity: "MEDIUM", message: `${usd(parked)} is in Ask My Accountant and needs a proper category.` });
  // Bank rows that look like owner draws but were posted to an expense account.
  const posted = await prisma.bankTransaction.findMany({ where: { clientId, status: "POSTED", amountCents: { lt: 0 } }, select: { description: true, journalEntry: { select: { lines: { select: { account: { select: { type: true, subtype: true } } } } } } } });
  const drawLike = posted.filter((t) => DRAW_WORDS.test(normDesc(t.description)) && t.journalEntry?.lines.some((l) => l.account.type === "EXPENSE" && l.account.subtype !== "SUSPENSE")).length;
  // Processor payouts (Stripe, Square, PayPal) posted straight to income: invoice payments already recorded
  // that income, so the payout belongs to Payments in Transit. Counting both would double the income.
  const payouts = await prisma.bankTransaction.count({ where: { clientId, status: "POSTED", amountCents: { gt: 0 }, description: { contains: "STRIPE", mode: "insensitive" }, journalEntry: { lines: { some: { account: { type: "INCOME" } } } } } });
  if (payouts && (await prisma.clientInvoicePayment.count({ where: { clientId } }))) flags.push({ kind: "POSSIBLE_DUPLICATE_INCOME", severity: "HIGH", message: `${payouts} Stripe deposit${payouts === 1 ? " was" : "s were"} posted to income while invoice payments are also recorded. Post payouts to Payments in Transit so income isn't counted twice.` });
  const clearing = await prisma.ledgerAccount.findFirst({ where: { clientId, subtype: "CLEARING" } });
  if (clearing) {
    const old = toDate(ymdOf(new Date(toDate(today).getTime() - 10 * 86_400_000)));
    const waiting = natural("ASSET", (await balancesBy(clientId, { date: { lte: old }, basis: basisFilter("CASH") })).get(clearing.id));
    if (waiting > 0) flags.push({ kind: "UNDEPOSITED", severity: "MEDIUM", message: `${usd(waiting)} in Payments in Transit is more than 10 days old and hasn't been matched to a bank deposit.` });
  }
  // A payment from the bank to a card / LOC / loan posted to an expense would double-count the
  // charges already on the card (or book principal as expense).
  const cardWords = /\b(PAYMENT|PMT|AUTOPAY|EPAY|CARD PMT|LOAN PMT)\b/;
  const payAsExpense = posted.filter((t) => cardWords.test(normDesc(t.description)) && /\b(CARD|CREDIT|AMEX|VISA|MASTERCARD|DISCOVER|LOAN|LINE OF CREDIT|LOC)\b/.test(normDesc(t.description)) && t.journalEntry?.lines.some((l) => l.account.type === "EXPENSE" && l.account.subtype !== "SUSPENSE")).length;
  if (payAsExpense) flags.push({ kind: "CARD_PAYMENT_AS_EXPENSE", severity: "HIGH", message: `${payAsExpense} card or loan payment${payAsExpense === 1 ? " was" : "s were"} posted as an expense. A payment to a card, line of credit or loan is a transfer to the liability account; the charges were already expensed on the card.` });
  if (drawLike) flags.push({ kind: "POSSIBLE_DRAW", severity: "MEDIUM", message: `${drawLike} withdrawal${drawLike === 1 ? "" : "s"} that look like owner draws or personal transfers were posted as expenses. Owner draws belong in equity unless Tabitha approved an exception.` });
  return flags;
}

/** Everything the ledger page shows for one client. */
export async function ledgerOverview(actor: Actor, clientId: string) {
  await assertLedger(actor, clientId);
  const book = await prisma.ledgerBook.findUnique({ where: { clientId } });
  if (!book) return { book: null as null };
  const [accounts, entries, bank, imports, recons] = await Promise.all([
    prisma.ledgerAccount.findMany({ where: { clientId }, orderBy: { code: "asc" } }),
    prisma.journalEntry.findMany({ where: { clientId }, orderBy: [{ date: "desc" }, { createdAt: "desc" }], take: 100, include: { lines: { include: { account: { select: { code: true, name: true } } } }, reversedBy: { select: { id: true, date: true } } } }),
    prisma.bankTransaction.findMany({ where: { clientId }, orderBy: [{ status: "desc" }, { date: "desc" }], take: 300, include: { account: { select: { code: true, name: true } }, journalEntry: { select: { id: true, lines: { select: { accountId: true } } } } } }),
    prisma.bankImport.findMany({ where: { clientId }, orderBy: { createdAt: "desc" }, take: 20 }),
    prisma.bankReconciliation.findMany({ where: { clientId }, orderBy: { statementDate: "desc" }, take: 24, include: { account: { select: { name: true } } } }),
  ]);
  return { book, accounts, entries, bank, imports, recons };
}
