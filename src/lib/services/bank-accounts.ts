import "server-only";
import { prisma } from "@/lib/prisma";
import { audit } from "@/lib/audit";
import type { Actor } from "@/lib/auth/actor";
import { ValidationError } from "./clients";
import { assertManagedBusiness, normDesc, parseCents, reconcileAccount, todayCentral, toDate, usd, ymdOf } from "./ledger";
import { assertCanManageBanking, assertCanViewBanking, assertTabithaApproves } from "./bk-permissions";

/**
 * Banking & Credit Card Connections: the business's registry of bank, card, line-of-credit and
 * loan accounts, how each one is connected and fed, and one reconciliation per account per month.
 *
 * Model (nothing duplicated):
 * - BookkeepingAccount is the REGISTRY entry the office and the client recognize: institution,
 *   nickname, type, last 4 only, opening balance + date, statement closing day, sub-cards.
 *   It never stores usernames, passwords, full numbers or security codes.
 * - LedgerAccount is its GL account (BookkeepingAccount.ledgerAccountId): an ASSET for checking
 *   and savings; a LIABILITY for credit cards, lines of credit and loans.
 * - BankConnectionAccount is the Plaid side (one per account Plaid exposes). It feeds the GL
 *   account; several employee / authorized-user cards on ONE shared credit account feed that
 *   one liability account (sharedWithId), so nothing is counted twice.
 * - AccountReconciliation is one per registry account per month.
 */

export const REGISTRY_TYPES = {
  CHECKING: { label: "Checking", gl: "BANK", glType: "ASSET", from: 1010, to: 1099 },
  SAVINGS: { label: "Savings", gl: "BANK", glType: "ASSET", from: 1010, to: 1099 },
  CREDIT_CARD: { label: "Credit card", gl: "CREDIT_CARD", glType: "LIABILITY", from: 2110, to: 2199 },
  LINE_OF_CREDIT: { label: "Line of credit", gl: "LINE_OF_CREDIT", glType: "LIABILITY", from: 2300, to: 2399 },
  LOAN: { label: "Loan", gl: "LOAN", glType: "LIABILITY", from: 2510, to: 2599 },
  MERCHANT: { label: "Merchant / payment processor", gl: null, glType: null, from: 0, to: 0 },
  OTHER: { label: "Other", gl: null, glType: null, from: 0, to: 0 },
} as const;
export type RegistryType = keyof typeof REGISTRY_TYPES;
export const isLiabilityType = (t: string) => REGISTRY_TYPES[t as RegistryType]?.glType === "LIABILITY";
export const reconciles = (t: string) => !!REGISTRY_TYPES[t as RegistryType]?.gl;

// Anything that looks like a credential or a full account number is refused outright.
const SECRET = /\b(password|passcode|pwd|pin|username|user ?id|login|security (code|question|answer)|cvv|cvc|csc|routing|one[- ]time code|otp)\b/i;
const LONG_NUMBER = /\d[\d\s-]{6,}\d/;
const clean = (v: string | null | undefined, n: number) => v?.replace(/\s+/g, " ").trim().slice(0, n) || null;

export function checkText(...vals: (string | null | undefined)[]) {
  for (const v of vals) {
    if (!v) continue;
    if (SECRET.test(v)) throw new ValidationError("Don't save usernames, passwords, PINs, security codes or routing numbers. Only the institution, a nickname and the last 4 digits are kept.");
    if (LONG_NUMBER.test(v)) throw new ValidationError("Don't save full account or card numbers. Enter only the last 4 digits.");
  }
}

export type RegisterInput = {
  institution: string;
  accountType: string;
  nickname?: string | null;
  last4?: string | null;
  openingBalance?: string | null;
  openingBalanceDate?: string | null;
  statementDay?: number | null;
  /** "NEW" creates the GL account, "NONE" leaves it unassigned, otherwise an existing ledger account id. */
  gl?: string | null;
  parentAccountId?: string | null;
  cardholderLabel?: string | null;
  monitored?: boolean;
};

async function nextCode(clientId: string, from: number, to: number) {
  const used = new Set((await prisma.ledgerAccount.findMany({ where: { clientId }, select: { code: true } })).map((a) => a.code));
  for (let c = from; c <= to; c++) if (!used.has(String(c))) return String(c);
  throw new ValidationError("No free account numbers left in that range. Add the GL account in the chart of accounts and assign it.");
}

export const registryLabel = (a: { institution: string; nickname?: string | null; accountType: string; last4: string | null }) =>
  `${a.nickname || a.institution}${a.last4 ? ` ••${a.last4}` : ""}`;

/** Assigns (or creates) the GL account for a registry entry: an asset for bank accounts, a liability for cards, LOC and loans. */
async function assignGl(clientId: string, type: RegistryType, gl: string | null | undefined, name: string, institution: string, last4: string | null, keepId?: string | null) {
  const def = REGISTRY_TYPES[type];
  if (!def.gl || !gl || gl === "NONE") return null;
  const book = await prisma.ledgerBook.findUnique({ where: { clientId } });
  if (!book) return null; // GL is assigned once the books are set up.
  if (gl === "NEW") {
    const code = await nextCode(clientId, def.from, def.to);
    const a = await prisma.ledgerAccount.create({ data: { clientId, code, name: name.slice(0, 120), type: def.glType!, subtype: def.gl, institution: institution.slice(0, 80), last4 } });
    return a.id;
  }
  const a = await prisma.ledgerAccount.findFirst({ where: { id: gl, clientId, active: true }, include: { registryAccount: { select: { id: true } } } });
  if (!a) throw new ValidationError("Choose one of this business's own GL accounts.");
  if (a.subtype !== def.gl) throw new ValidationError(`A ${def.label.toLowerCase()} posts to a ${def.glType === "ASSET" ? "bank (asset)" : "liability"} GL account of the same kind.`);
  if (a.registryAccount && a.registryAccount.id !== keepId) throw new ValidationError("That GL account already belongs to another registered account.");
  return a.id;
}

/** Registers one account (unlimited per business). Authorized staff only. */
export async function registerAccount(actor: Actor, clientId: string, input: RegisterInput) {
  await assertCanManageBanking(actor, clientId);
  await assertManagedBusiness(clientId);
  if (!(input.accountType in REGISTRY_TYPES)) throw new ValidationError("Choose the account type.");
  const type = input.accountType as RegistryType;
  const institution = clean(input.institution, 120);
  if (!institution) throw new ValidationError("Enter the bank or card company.");
  const last4 = input.last4?.trim() || null;
  if (last4 && !/^\d{4}$/.test(last4)) throw new ValidationError("Enter only the last 4 digits.");
  const nickname = clean(input.nickname, 80);
  const cardholderLabel = clean(input.cardholderLabel, 80);
  checkText(institution, nickname, cardholderLabel);
  if (input.statementDay != null && (!Number.isInteger(input.statementDay) || input.statementDay < 1 || input.statementDay > 31)) throw new ValidationError("Statement closing day: 1–31.");
  const opening = input.openingBalance?.trim() ? parseCents(input.openingBalance, "opening balance") : null;
  if (opening != null && !input.openingBalanceDate) throw new ValidationError("Enter the date of the opening balance.");
  let parent = null;
  if (input.parentAccountId) {
    parent = await prisma.bookkeepingAccount.findFirst({ where: { id: input.parentAccountId, clientId, active: true } });
    if (!parent || parent.accountType !== "CREDIT_CARD" || parent.parentAccountId) throw new ValidationError("An employee card belongs under one of this business's own credit card accounts.");
    if (type !== "CREDIT_CARD") throw new ValidationError("Only a card can be an employee card on a shared account.");
  }
  const name = `${nickname || institution}${last4 ? ` ••${last4}` : ""}`;
  // An employee card has no GL account of its own: its charges belong to the shared liability.
  const ledgerAccountId = parent ? null : await assignGl(clientId, type, input.gl ?? "NEW", name, institution, last4);
  const a = await prisma.bookkeepingAccount.create({
    data: {
      clientId, institution, accountType: type, last4, nickname, accessStatus: "NOT_REQUESTED", updatedById: actor.id,
      ledgerAccountId, openingBalanceCents: parent ? null : opening, openingBalanceDate: !parent && input.openingBalanceDate ? toDate(input.openingBalanceDate) : null,
      statementDay: input.statementDay ?? null, monitored: input.monitored ?? true, parentAccountId: parent?.id ?? null, cardholderLabel,
    },
  });
  await audit(prisma, { actorId: actor.id, action: "banking.account_registered", entityType: "BookkeepingAccount", entityId: a.id, clientId, details: { type, institution, last4, ledgerAccountId, parentAccountId: parent?.id ?? null } });
  return a;
}

export async function updateRegistryAccount(actor: Actor, clientId: string, id: string, input: Partial<RegisterInput> & { active?: boolean }) {
  await assertCanManageBanking(actor, clientId);
  const a = await prisma.bookkeepingAccount.findFirst({ where: { id, clientId } });
  if (!a) throw new ValidationError("Account not found.");
  const nickname = input.nickname !== undefined ? clean(input.nickname, 80) : a.nickname;
  const cardholderLabel = input.cardholderLabel !== undefined ? clean(input.cardholderLabel, 80) : a.cardholderLabel;
  checkText(nickname, cardholderLabel);
  const last4 = input.last4 !== undefined ? input.last4?.trim() || null : a.last4;
  if (last4 && !/^\d{4}$/.test(last4)) throw new ValidationError("Enter only the last 4 digits.");
  const opening = input.openingBalance !== undefined ? (input.openingBalance?.trim() ? parseCents(input.openingBalance, "opening balance") : null) : a.openingBalanceCents;
  let ledgerAccountId = a.ledgerAccountId;
  if (input.gl !== undefined && !a.parentAccountId) ledgerAccountId = input.gl === "NONE" ? null : await assignGl(clientId, a.accountType as RegistryType, input.gl, `${nickname || a.institution}${last4 ? ` ••${last4}` : ""}`, a.institution, last4, a.id);
  const updated = await prisma.bookkeepingAccount.update({
    where: { id },
    data: {
      nickname, cardholderLabel, last4, ledgerAccountId, openingBalanceCents: opening,
      ...(input.openingBalanceDate !== undefined ? { openingBalanceDate: input.openingBalanceDate ? toDate(input.openingBalanceDate) : null } : {}),
      ...(input.statementDay !== undefined ? { statementDay: input.statementDay } : {}),
      ...(input.monitored !== undefined ? { monitored: input.monitored } : {}),
      ...(input.active !== undefined ? { active: input.active } : {}),
      updatedById: actor.id,
    },
  });
  await audit(prisma, { actorId: actor.id, action: "banking.account_updated", entityType: "BookkeepingAccount", entityId: id, clientId, details: { before: { last4: a.last4, ledgerAccountId: a.ledgerAccountId, monitored: a.monitored, active: a.active }, after: { last4: updated.last4, ledgerAccountId: updated.ledgerAccountId, monitored: updated.monitored, active: updated.active } } });
  return updated;
}

// --- Shared credit accounts (employee / authorized-user cards) -----------------------------------

export type PlaidSide = { id: string; type: string; subtype: string | null; mask: string | null; name: string; currentBalanceCents: number | null; creditLimitCents: number | null };

/**
 * Detects employee / authorized-user cards that Plaid reports as separate accounts but that are
 * really ONE shared credit account. A pure rule, explained to staff:
 *   credit-card accounts in the same bank login with the SAME credit limit AND the SAME current
 *   balance (to the cent) and the same product name (ignoring card digits) are one account.
 * The first card (lowest mask) is the primary; the rest are suggested as its sub-cards. Staff
 * confirm the suggestion or mark a card "separate account" (override); nothing is merged silently.
 * When Plaid reports only one account for a shared line (the common case), the employee cards
 * are registered by hand as sub-cards of that account instead.
 */
export function detectSharedCards(accounts: PlaidSide[]): { id: string; sharedWithId: string; reason: string }[] {
  const cards = accounts.filter((a) => a.type === "credit" && (a.subtype ?? "credit card") === "credit card" && a.creditLimitCents != null && a.currentBalanceCents != null);
  const key = (a: PlaidSide) => `${a.name.toUpperCase().replace(/[^A-Z]+/g, " ").trim()}|${a.creditLimitCents}|${a.currentBalanceCents}`;
  const groups = new Map<string, PlaidSide[]>();
  for (const c of cards) groups.set(key(c), [...(groups.get(key(c)) ?? []), c]);
  const out: { id: string; sharedWithId: string; reason: string }[] = [];
  for (const g of groups.values()) {
    if (g.length < 2) continue;
    const [primary, ...rest] = [...g].sort((a, b) => (a.mask ?? "").localeCompare(b.mask ?? ""));
    for (const r of rest) out.push({ id: r.id, sharedWithId: primary.id, reason: `Same credit limit (${usd(r.creditLimitCents!)}) and same balance (${usd(r.currentBalanceCents!)}) as ••${primary.mask ?? "?"} — looks like an employee card on one shared account.` });
  }
  return out;
}

/** Applies detection to one connection's accounts (after linking or refreshing balances). Staff decisions are kept. */
export async function applySharedCardDetection(connectionId: string) {
  const accts = await prisma.bankConnectionAccount.findMany({ where: { connectionId } });
  const found = detectSharedCards(accts);
  for (const f of found) {
    const ca = accts.find((a) => a.id === f.id)!;
    if (ca.sharedStatus === "SEPARATE" || ca.sharedStatus === "CONFIRMED") continue;
    await prisma.bankConnectionAccount.update({ where: { id: f.id }, data: { sharedWithId: f.sharedWithId, sharedStatus: "SUGGESTED", sharedReason: f.reason } });
  }
  return found.length;
}

/** Staff confirm a detected employee card (one shared liability) or override it as a separate account. */
export async function decideSharedCard(actor: Actor, clientId: string, connectionAccountId: string, decision: "CONFIRM" | "SEPARATE") {
  await assertCanManageBanking(actor, clientId);
  const ca = await prisma.bankConnectionAccount.findFirst({ where: { id: connectionAccountId, connection: { clientId } } });
  if (!ca || !ca.sharedWithId) throw new ValidationError("That card isn't marked as part of a shared account.");
  const primary = await prisma.bankConnectionAccount.findUniqueOrThrow({ where: { id: ca.sharedWithId } });
  await prisma.bankConnectionAccount.update({
    where: { id: ca.id },
    data: decision === "CONFIRM" ? { sharedStatus: "CONFIRMED", ledgerAccountId: primary.ledgerAccountId } : { sharedStatus: "SEPARATE", ledgerAccountId: null },
  });
  await audit(prisma, { actorId: actor.id, action: decision === "CONFIRM" ? "banking.shared_card_confirmed" : "banking.shared_card_separated", entityType: "BankConnectionAccount", entityId: ca.id, clientId, details: { primary: primary.id, mask: ca.mask } });
}

/** True when this Plaid account's transactions belong to another card's (shared) liability account. */
export const feedsShared = (ca: { sharedWithId: string | null; sharedStatus: string | null }) => !!ca.sharedWithId && (ca.sharedStatus === "SUGGESTED" || ca.sharedStatus === "CONFIRMED");

/** Maps Plaid's account kind to a registry type. */
export function registryTypeOf(ca: { type: string; subtype: string | null }): RegistryType {
  const st = (ca.subtype ?? "").toLowerCase();
  if (ca.type === "depository") return st === "savings" || st === "money market" || st === "cd" ? "SAVINGS" : "CHECKING";
  if (ca.type === "credit") return st.includes("line of credit") ? "LINE_OF_CREDIT" : "CREDIT_CARD";
  if (ca.type === "loan") return st.includes("line of credit") ? "LINE_OF_CREDIT" : "LOAN";
  return "OTHER";
}

/**
 * "Coetha monitors this account": links a Plaid account to a registry account (or creates one,
 * with its GL account) so its transactions are retrieved into that GL account. null stops it.
 */
export async function monitorConnectionAccount(actor: Actor, clientId: string, connectionAccountId: string, registryId: string | "NEW" | null) {
  await assertCanManageBanking(actor, clientId);
  await assertManagedBusiness(clientId);
  const ca = await prisma.bankConnectionAccount.findFirst({ where: { id: connectionAccountId, connection: { clientId } }, include: { connection: true } });
  if (!ca) throw new ValidationError("Bank account not found.");
  let ledgerAccountId: string | null = null;
  let regId: string | null = null;
  if (registryId === "NEW") {
    const r = await registerAccount(actor, clientId, { institution: ca.connection.institutionName ?? "Bank", accountType: registryTypeOf(ca), nickname: ca.name.slice(0, 80).replace(LONG_NUMBER, "").trim() || null, last4: ca.mask && /^\d{4}$/.test(ca.mask) ? ca.mask : null, gl: "NEW" });
    ledgerAccountId = r.ledgerAccountId;
    regId = r.id;
  } else if (registryId) {
    const r = await prisma.bookkeepingAccount.findFirst({ where: { id: registryId, clientId, active: true }, include: { parentAccount: true } });
    if (!r) throw new ValidationError("Choose one of this business's registered accounts.");
    ledgerAccountId = r.parentAccount?.ledgerAccountId ?? r.ledgerAccountId;
    regId = r.id;
    if (!ledgerAccountId) throw new ValidationError("Assign a GL account to that registered account first.");
  }
  if (ledgerAccountId && !feedsShared(ca)) {
    const taken = await prisma.bankConnectionAccount.findFirst({ where: { ledgerAccountId, NOT: { id: ca.id }, OR: [{ sharedWithId: null }, { sharedStatus: "SEPARATE" }] } });
    if (taken) throw new ValidationError("That account already receives another bank account's transactions.");
  }
  await prisma.bankConnectionAccount.update({ where: { id: ca.id }, data: { ledgerAccountId } });
  // Detected employee cards follow their primary card into the same liability account.
  await prisma.bankConnectionAccount.updateMany({ where: { sharedWithId: ca.id, sharedStatus: { in: ["SUGGESTED", "CONFIRMED"] } }, data: { ledgerAccountId } });
  if (regId) await prisma.bookkeepingAccount.update({ where: { id: regId }, data: { accessStatus: "OFFICIAL_CONNECTION", accessMethod: "OFFICIAL_CONNECTION", monitored: true } });
  await audit(prisma, { actorId: actor.id, action: ledgerAccountId ? "banking.account_monitored" : "banking.account_unmonitored", entityType: "BankConnectionAccount", entityId: ca.id, clientId, details: { registryId: regId, ledgerAccountId } });
}

// --- Registry view -------------------------------------------------------------------------------

export type ConnStatus = "CONNECTED" | "NEEDS_REAUTH" | "ERROR" | "NOT_CONNECTED" | "MANUAL";
export const CONN_LABEL: Record<ConnStatus, string> = { CONNECTED: "Connected", NEEDS_REAUTH: "Client must sign in again", ERROR: "Last sync failed", NOT_CONNECTED: "Not connected", MANUAL: "Statements only" };

/** Everything the Banking & Credit Card Connections screen shows, for ONE business. */
export async function bankingRegistry(actor: Actor, clientId: string) {
  await assertCanViewBanking(actor, clientId);
  const [accounts, conns, ledger] = await Promise.all([
    prisma.bookkeepingAccount.findMany({ where: { clientId }, orderBy: [{ accountType: "asc" }, { institution: "asc" }, { last4: "asc" }], include: { ledgerAccount: { select: { id: true, code: true, name: true, type: true } } } }),
    prisma.bankConnection.findMany({ where: { clientId }, orderBy: { createdAt: "asc" }, include: { accounts: true } }),
    prisma.ledgerAccount.findMany({ where: { clientId, active: true }, orderBy: { code: "asc" }, select: { id: true, code: true, name: true, subtype: true, registryAccount: { select: { id: true } } } }),
  ]);
  const caRows = conns.flatMap((c) => c.accounts.map((a) => ({ ...a, connection: c })));
  const statusOf = (r: (typeof accounts)[number]) => {
    const lid = r.parentAccountId ? accounts.find((p) => p.id === r.parentAccountId)?.ledgerAccountId : r.ledgerAccountId;
    const fed = caRows.filter((ca) => lid && ca.ledgerAccountId === lid && ca.connection.status !== "DISCONNECTED");
    if (!fed.length) return { status: (r.accessStatus === "STATEMENTS_ONLY" ? "MANUAL" : "NOT_CONNECTED") as ConnStatus, lastSync: null as Date | null, feeds: fed };
    const c = fed[0].connection;
    const status: ConnStatus = c.status === "NEEDS_REAUTH" ? "NEEDS_REAUTH" : c.status === "ERROR" ? "ERROR" : "CONNECTED";
    return { status, lastSync: fed.map((f) => f.connection.lastSuccessAt).filter((d): d is Date => !!d).sort((a, b) => b.getTime() - a.getTime())[0] ?? null, feeds: fed };
  };
  const top = accounts.filter((a) => !a.parentAccountId);
  const rows = top.map((a) => ({ ...a, ...statusOf(a), subCards: accounts.filter((s) => s.parentAccountId === a.id).map((s) => ({ ...s })) }));
  const sharedSuggestions = caRows.filter((ca) => ca.sharedWithId && ca.sharedStatus === "SUGGESTED").map((ca) => ({ ...ca, primary: caRows.find((p) => p.id === ca.sharedWithId) ?? null }));
  const unmonitored = caRows.filter((ca) => !ca.ledgerAccountId && ca.connection.status !== "DISCONNECTED" && ca.sharedStatus !== "SUGGESTED" && ca.sharedStatus !== "CONFIRMED");
  const institutions = new Set(conns.filter((c) => c.status !== "DISCONNECTED").map((c) => c.institutionName ?? c.id)).size;
  return { rows, ledger, connections: conns.map(({ accessTokenEnc: _t, cursor: _c, ...c }) => c), sharedSuggestions, unmonitored, institutions, connected: rows.filter((r) => r.status === "CONNECTED").length, lastSync: rows.map((r) => r.lastSync).filter((d): d is Date => !!d).sort((a, b) => b.getTime() - a.getTime())[0] ?? null };
}

// --- Monthly reconciliation ----------------------------------------------------------------------

const pad = (n: number) => String(n).padStart(2, "0");
const lastDayNum = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();
const prevYm = (y: number, m: number) => (m === 1 ? { y: y - 1, m: 12 } : { y, m: m - 1 });

/** The statement window for an account's month: (previous closing, this closing]. */
export function statementWindow(y: number, m: number, statementDay: number | null | undefined) {
  const close = (yy: number, mm: number) => `${yy}-${pad(mm)}-${pad(Math.min(statementDay ?? 31, lastDayNum(yy, mm)))}`;
  const p = prevYm(y, m);
  const end = close(y, m);
  const prevEnd = close(p.y, p.m);
  const start = ymdOf(new Date(toDate(prevEnd).getTime() + 86_400_000));
  return { start, end };
}

/**
 * Reconciliation arithmetic for one statement. Bank rows store money IN as positive.
 * - Bank (asset): expected ending = beginning + credits − debits.
 * - Card / LOC / loan (liability, balance = amount owed): payments and credits reduce what is
 *   owed and charges increase it: expected ending = beginning − (payments − charges).
 * Difference = statement ending − expected ending (0 = reconciled).
 */
export function reconMath(kind: "ASSET" | "LIABILITY", beginningCents: number | null, endingCents: number | null, amounts: number[]) {
  const credits = amounts.filter((a) => a > 0).reduce((n, a) => n + a, 0);
  const debits = -amounts.filter((a) => a < 0).reduce((n, a) => n + a, 0);
  const net = credits - debits;
  const expectedEnding = beginningCents == null ? null : kind === "ASSET" ? beginningCents + net : beginningCents - net;
  const differenceCents = endingCents == null || expectedEnding == null ? null : endingCents - expectedEnding;
  return { paymentsCreditsCents: credits, chargesDebitsCents: debits, expectedEnding, differenceCents };
}

const median = (xs: number[]) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};

/**
 * Coetha prepares (or refreshes) one account's reconciliation for a month from real data:
 * imported rows in the statement window, the statement on file, the previous month's ending
 * balance (or the registered opening balance), and the ending balance from the statement.
 * An APPROVED record is never changed. Exceptions are flagged for a person.
 */
export async function prepareReconciliation(clientId: string, registryId: string, year: number, month: number, opts: { today?: string; preparedById?: string | null } = {}) {
  const r = await prisma.bookkeepingAccount.findFirst({ where: { id: registryId, clientId } });
  if (!r || r.parentAccountId || !reconciles(r.accountType)) return null;
  const existing = await prisma.accountReconciliation.findUnique({ where: { bookkeepingAccountId_year_month: { bookkeepingAccountId: r.id, year, month } } });
  if (existing?.status === "APPROVED") return existing;
  const today = opts.today ?? todayCentral();
  const w = statementWindow(year, month, r.statementDay);
  const kind = isLiabilityType(r.accountType) ? "LIABILITY" : "ASSET";
  const rows = r.ledgerAccountId
    ? await prisma.bankTransaction.findMany({ where: { clientId, accountId: r.ledgerAccountId, status: { not: "EXCLUDED" }, date: { gte: toDate(w.start), lte: toDate(w.end) } }, select: { amountCents: true, status: true, flag: true, description: true } })
    : [];
  const prev = prevYm(year, month);
  const before = await prisma.accountReconciliation.findUnique({ where: { bookkeepingAccountId_year_month: { bookkeepingAccountId: r.id, year: prev.y, month: prev.m } } });
  let beginning = existing?.beginningBalanceCents ?? before?.endingBalanceCents ?? null;
  if (beginning == null && r.openingBalanceCents != null && r.openingBalanceDate && ymdOf(r.openingBalanceDate) < w.start) beginning = r.openingBalanceCents;
  // Plaid Liabilities (when enabled): the issuer's last statement balance for this statement period.
  const liab = existing?.endingBalanceCents == null && kind === "LIABILITY" && r.ledgerAccountId
    ? await prisma.bankConnectionAccount.findFirst({ where: { ledgerAccountId: r.ledgerAccountId, liabilitiesAt: { not: null }, connection: { clientId, status: { not: "DISCONNECTED" } } }, orderBy: { liabilitiesAt: "desc" } })
    : null;
  const liabFits = !!liab?.lastStatementDate && liab.lastStatementBalanceCents != null && ymdOf(liab.lastStatementDate) >= w.start && ymdOf(liab.lastStatementDate) <= ymdOf(new Date(toDate(w.end).getTime() + 5 * 86_400_000));
  const ending = existing?.endingBalanceCents ?? (liabFits ? liab!.lastStatementBalanceCents : null);
  // The statement on file for this account and month (uploaded, retrieved, or sent against a request).
  const [y0, m0] = w.end.split("-").map(Number);
  const statement = await prisma.document.findFirst({
    where: { clientId, deletedAt: null, bookkeepingAccountId: r.id, docType: { in: ["BANK_STATEMENT", "CARD_STATEMENT"] }, OR: [{ periodEnd: { gte: toDate(w.start), lte: new Date(toDate(w.end).getTime() + 5 * 86_400_000) } }, { year: y0, month: m0 }] },
    orderBy: { createdAt: "desc" },
    select: { id: true },
  });
  const requested = statement ? null : await prisma.documentRequest.findFirst({ where: { clientId, bookkeepingAccountId: r.id, kind: "STATEMENT", status: { in: ["DRAFT", "OPEN", "SUBMITTED"] }, periodEnd: { gte: toDate(w.start), lte: toDate(w.end) } }, select: { id: true, status: true } });
  const statementStatus = statement ? "RECEIVED" : requested ? "REQUESTED" : "MISSING";
  const math = reconMath(kind, beginning, ending, rows.map((x) => x.amountCents));
  const unmatched = rows.filter((x) => x.status === "UNREVIEWED").length;
  const exceptions: string[] = [];
  if (math.differenceCents) exceptions.push(`Difference of ${usd(math.differenceCents)} between the statement and the imported activity — a transaction may be missing or duplicated.`);
  if (!rows.length && today > w.end) exceptions.push("No transactions imported for this statement period. Check the bank feed or the statement.");
  if (liab?.liabilityOverdue) exceptions.push("The card issuer reports this account's payment as overdue.");
  const flagged = rows.filter((x) => x.flag).length;
  if (flagged) exceptions.push(`${flagged} transaction${flagged === 1 ? "" : "s"} flagged as possible duplicates or changed by the bank.`);
  const typical = median(rows.map((x) => Math.abs(x.amountCents)));
  const unusual = rows.filter((x) => Math.abs(x.amountCents) >= 100_000 && Math.abs(x.amountCents) >= typical * 5);
  if (unusual.length) exceptions.push(`Unusual activity: ${unusual.slice(0, 3).map((x) => `${usd(x.amountCents)} “${x.description.slice(0, 40)}”`).join(", ")}${unusual.length > 3 ? "…" : ""}.`);
  let status: string;
  if (today <= w.end) status = "NOT_DUE";
  else if (ending == null || beginning == null) status = "AWAITING_DATA";
  else if (math.differenceCents !== 0) status = "EXCEPTION";
  else if (unmatched > 0 || flagged > 0) status = "IN_PROGRESS";
  else status = "READY";
  const data = {
    clientId, statementClosingDate: toDate(w.end), beginningBalanceCents: beginning, endingBalanceCents: ending,
    ...(existing?.endingBalanceCents == null && liabFits ? { balanceSource: "PLAID_LIABILITIES" } : {}),
    transactionsImported: rows.length, paymentsCreditsCents: math.paymentsCreditsCents, chargesDebitsCents: math.chargesDebitsCents,
    unmatchedCount: unmatched, differenceCents: math.differenceCents, statementStatus, statementDocumentId: statement?.id ?? null,
    status, exceptions, preparedAt: new Date(), preparedById: opts.preparedById ?? null,
  };
  const rec = await prisma.accountReconciliation.upsert({ where: { bookkeepingAccountId_year_month: { bookkeepingAccountId: r.id, year, month } }, create: { bookkeepingAccountId: r.id, year, month, ...data }, update: data });
  if (!existing || existing.status !== rec.status) await audit(prisma, { actorId: opts.preparedById ?? null, action: "banking.reconciliation_prepared", entityType: "AccountReconciliation", entityId: rec.id, clientId, details: { account: registryLabel(r), month: `${year}-${pad(month)}`, status: rec.status, differenceCents: rec.differenceCents } });
  return rec;
}

/** Staff enter the statement balances (when no statement could be retrieved automatically). */
export async function enterStatementBalances(actor: Actor, clientId: string, registryId: string, year: number, month: number, input: { beginning?: string | null; ending: string }) {
  await assertCanManageBanking(actor, clientId);
  const r = await prisma.bookkeepingAccount.findFirst({ where: { id: registryId, clientId } });
  if (!r) throw new ValidationError("Account not found.");
  const ending = parseCents(input.ending, "ending statement balance");
  const beginning = input.beginning?.trim() ? parseCents(input.beginning, "beginning statement balance") : undefined;
  const existing = await prisma.accountReconciliation.findUnique({ where: { bookkeepingAccountId_year_month: { bookkeepingAccountId: r.id, year, month } } });
  if (existing?.status === "APPROVED") throw new ValidationError("Tabitha already approved this reconciliation.");
  const w = statementWindow(year, month, r.statementDay);
  const data = { clientId, endingBalanceCents: ending, balanceSource: "STAFF_ENTRY", statementClosingDate: toDate(w.end), ...(beginning !== undefined ? { beginningBalanceCents: beginning } : {}) };
  await prisma.accountReconciliation.upsert({ where: { bookkeepingAccountId_year_month: { bookkeepingAccountId: r.id, year, month } }, create: { bookkeepingAccountId: r.id, year, month, ...data }, update: data });
  await audit(prisma, { actorId: actor.id, action: "banking.statement_balances_entered", entityType: "BookkeepingAccount", entityId: r.id, clientId, details: { month: `${year}-${pad(month)}`, endingCents: ending, beginningCents: beginning ?? null } });
  return prepareReconciliation(clientId, r.id, year, month, { preparedById: actor.id });
}

/**
 * Tabitha approves a finalized reconciliation. The ledger must agree with the statement to the
 * cent and every row through the closing date must be reviewed (the ledger's own rule); the
 * ledger's reconciled-through record is written at the same time.
 */
export async function approveReconciliation(actor: Actor, clientId: string, reconciliationId: string) {
  await assertTabithaApproves(actor, "a reconciliation");
  const rec = await prisma.accountReconciliation.findFirst({ where: { id: reconciliationId, clientId }, include: { bookkeepingAccount: true } });
  if (!rec) throw new ValidationError("Reconciliation not found.");
  if (rec.status === "APPROVED") return rec;
  if (rec.status !== "READY") throw new ValidationError("Only a balanced reconciliation with every transaction reviewed can be approved.");
  const lid = rec.bookkeepingAccount.ledgerAccountId;
  if (!lid || rec.endingBalanceCents == null || !rec.statementClosingDate) throw new ValidationError("This account has no GL account or statement balance yet.");
  const r = await reconcileAccount(actor, clientId, lid, { statementDate: ymdOf(rec.statementClosingDate), statementBalance: (rec.endingBalanceCents / 100).toFixed(2) });
  if (!r.reconciled) throw new ValidationError(`The books don't agree with the statement yet: ledger ${usd(r.ledgerCents)} vs statement ${usd(r.statementCents)}${r.unreviewed ? `, ${r.unreviewed} transaction(s) not reviewed` : ""}. Post the remaining transactions (and opening balances) first.`);
  const done = await prisma.accountReconciliation.update({ where: { id: rec.id }, data: { status: "APPROVED", approvedById: actor.id, approvedAt: new Date(), bankReconciliationId: r.id } });
  await audit(prisma, { actorId: actor.id, action: "banking.reconciliation_approved", entityType: "AccountReconciliation", entityId: rec.id, clientId, details: { account: registryLabel(rec.bookkeepingAccount), month: `${rec.year}-${pad(rec.month)}`, endingCents: rec.endingBalanceCents } });
  return done;
}

export type Light = "GREEN" | "RED" | "YELLOW" | "GRAY";
/**
 * Green = reconciled AND approved by Tabitha. Yellow = balanced but awaiting her approval, or in
 * progress / awaiting data. Red = missing information or an unresolved difference. Gray = not yet due.
 */
export function lightOf(rec: { status: string; statementStatus: string } | null): Light {
  if (!rec || rec.status === "NOT_DUE") return "GRAY";
  if (rec.status === "APPROVED") return "GREEN";
  if (rec.status === "EXCEPTION" || (rec.status === "AWAITING_DATA" && rec.statementStatus === "MISSING")) return "RED";
  return "YELLOW";
}
export const REC_LABEL: Record<string, string> = {
  NOT_DUE: "Not yet due", AWAITING_DATA: "Awaiting statement data", IN_PROGRESS: "In progress — transactions to review", EXCEPTION: "Issue — difference to resolve", READY: "Balanced — awaiting Tabitha's approval", APPROVED: "Reconciled and approved by Tabitha",
};

/** Consolidated monthly account progress: every account with its light, plus "X of Y accounts reconciled" (approved by Tabitha only). */
export async function monthlyAccountProgress(actor: Actor, clientId: string, year: number, month: number, opts: { today?: string; refresh?: boolean } = {}) {
  await assertCanViewBanking(actor, clientId);
  const accounts = await prisma.bookkeepingAccount.findMany({ where: { clientId, active: true, parentAccountId: null }, orderBy: [{ accountType: "asc" }, { institution: "asc" }, { last4: "asc" }], include: { subCards: { where: { active: true }, select: { id: true, last4: true, nickname: true, cardholderLabel: true } } } });
  const list = accounts.filter((a) => reconciles(a.accountType));
  const rows = [];
  for (const a of list) {
    const rec = opts.refresh === false
      ? await prisma.accountReconciliation.findUnique({ where: { bookkeepingAccountId_year_month: { bookkeepingAccountId: a.id, year, month } } })
      : await prepareReconciliation(clientId, a.id, year, month, { today: opts.today });
    rows.push({ account: a, rec, light: lightOf(rec) });
  }
  const due = rows.filter((r) => r.light !== "GRAY");
  const reconciled = rows.filter((r) => r.light === "GREEN").length;
  const counts = { GREEN: 0, RED: 0, YELLOW: 0, GRAY: 0 } as Record<Light, number>;
  for (const r of rows) counts[r.light]++;
  return { rows, reconciled, total: rows.length, due: due.length, counts, approved: reconciled, awaitingApproval: rows.filter((r) => r.rec?.status === "READY").length };
}

// --- Card payments are transfers, never expenses -------------------------------------------------

const PAY_WORDS = /\b(PAYMENT|PMT|AUTOPAY|AUTO PAY|EPAY|E PAY|ONLINE PMT|CARD PMT|CRCARDPMT|CC PMT|BILL PAY)\b/;
const THANKS = /\b(THANK YOU|PAYMENT RECEIVED|PAYMENT THANK|AUTOPAY PAYMENT|ONLINE PAYMENT)\b/;

export type CardRef = { ledgerAccountId: string; institution: string; nickname: string | null; last4: string | null; accountType: string };

/**
 * Which card / LOC / loan a payment out of a bank account is paying, from its description
 * (the card's last 4, its institution or nickname next to "payment"/"autopay"). Returns null
 * unless exactly one account fits. Used so a card payment posts as a TRANSFER (bank asset →
 * card liability) even when only the bank side is connected.
 */
export function cardPaymentTarget(description: string, amountCents: number, cards: CardRef[]): CardRef | null {
  if (amountCents >= 0) return null;
  const d = normDesc(description);
  if (!PAY_WORDS.test(d)) return null;
  const word = (s: string | null) => (s ? normDesc(s).split(" ").filter((w) => w.length >= 4 && !["BANK", "CARD", "CREDIT", "BUSINESS", "ACCOUNT"].includes(w)) : []);
  const hits = cards.filter((c) => (c.last4 && d.includes(c.last4)) || [...word(c.institution), ...word(c.nickname)].some((w) => d.includes(w)));
  if (hits.length === 1) return hits[0];
  if (!hits.length && cards.length === 1 && /\b(CARD|CREDIT|AMEX|VISA|MASTERCARD|DISCOVER)\b/.test(d)) return cards[0];
  return null;
}

/** A payment received on a card (money in on the liability) that came from the business's bank. */
export function isCardPaymentReceived(description: string, amountCents: number) {
  return amountCents > 0 && THANKS.test(normDesc(description));
}

/** Registry cards (and LOC/loans) with GL accounts, for one business. */
export async function cardRefs(clientId: string): Promise<CardRef[]> {
  const rows = await prisma.bookkeepingAccount.findMany({ where: { clientId, active: true, parentAccountId: null, accountType: { in: ["CREDIT_CARD", "LINE_OF_CREDIT", "LOAN"] }, ledgerAccountId: { not: null } }, select: { ledgerAccountId: true, institution: true, nickname: true, last4: true, accountType: true } });
  return rows.map((r) => ({ ...r, ledgerAccountId: r.ledgerAccountId! }));
}
