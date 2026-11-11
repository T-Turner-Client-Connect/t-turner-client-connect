import "server-only";
import { prisma } from "@/lib/prisma";
import { balanceDay } from "./banking";
import { clientManualBalances, MANUAL_STALE_DAYS, type ClientManualBalance } from "./manual-bank";
import { clientBankBalancesVisible } from "./owner-switches";

/**
 * One business's bank balances, account by account: each bank-feed (Plaid) account as the bank
 * last reported it, today's change and the latest posted transactions; and each account our
 * office keeps up by hand (manual-bank.ts), labeled "Updated by our office".
 * This module never checks access itself: the staff overview calls it after canUseLedger,
 * the client portal after requireClientAccess(…, "bookkeeping"). Only this client's rows are read.
 *
 * Office-entered balances reach this feed (and so any client screen) only while Tabitha's
 * owner switch "Show office-entered bank balances to clients" is on. It is off by default; while
 * it's off the feed carries bank-feed (Plaid) accounts only. Staff screens read our balances
 * directly (manual-bank.ts), so the office keeps working with them either way.
 *
 * Source per account (never one rule for the whole business):
 * - A manual account and a Plaid account are the SAME real account when they're linked to the
 *   same GL account, or have the same institution and last 4. It's listed and counted once:
 *   the Plaid figure while that connection is active and current, else ours — unless staff set
 *   the account's balance source to Office-entered.
 * - Every other Plaid account and every manual account with a balance is listed on its own.
 * - Cash in bank (checking + savings) and credit cards owed are kept apart; netCents is only
 *   for the ticker's clearly labeled "cash less cards" figure.
 */

export const CLIENT_REFRESH_MINUTES = 5;
/** Older than this, figures are labeled as not current (banks normally report several times a day). */
export const STALE_HOURS = 36;

export type FeedAccount = {
  id: string;
  name: string;
  mask: string | null;
  kind: "CASH" | "CREDIT" | "OTHER";
  institution: string | null;
  currentCents: number | null;
  availableCents: number | null;
  changeCents: number | null;
  asOf: string | null;
  /** Balances from an imported bank file are as of a day, not a time. */
  asOfDateOnly?: boolean;
  /** PLAID: from the bank feed; OFFICE: updated by our office. */
  source: "PLAID" | "OFFICE";
  /** This account's figure is older than its source's limit (STALE_HOURS / MANUAL_STALE_DAYS). */
  stale: boolean;
};
export type FeedTxn = { id: string; date: string; description: string; amountCents: number; account: string };
export type BankFeed = {
  /** Which sources the listed accounts come from: PLAID, MANUAL (our office), MIXED (both) or NONE yet. */
  source: "PLAID" | "MANUAL" | "MIXED" | "NONE";
  connected: boolean;
  needsAttention: boolean;
  accounts: FeedAccount[];
  /** Checking + savings. */
  cashCents: number | null;
  /** Owed on credit cards (and loans on the bank feed): a liability, never netted in the client view. */
  creditCents: number | null;
  /** Cash less cards owed — only for the ticker, labeled as such. */
  netCents: number | null;
  updatedAt: string | null;
  // The last successful retrieval from the bank, and whether the data is older than a day and a half.
  lastSyncAt: string | null;
  stale: boolean;
  /** The newest office balance came from a bank file, so it is shown as of a date. */
  updatedDateOnly?: boolean;
  // Plaid sandbox: test data, never a real bank. Always labeled as such.
  sandbox: boolean;
  transactions: FeedTxn[];
  nextRefreshAt: string | null;
};

/** Cash in the bank less what is owed on cards and loans. */
function netOf(accounts: FeedAccount[]) {
  const withBalance = accounts.filter((a) => a.currentCents !== null && a.kind !== "OTHER");
  return withBalance.length ? withBalance.reduce((t, a) => t + (a.kind === "CASH" ? a.currentCents! : -a.currentCents!), 0) : null;
}
function sumOf(accounts: FeedAccount[], kind: FeedAccount["kind"]) {
  const xs = accounts.filter((a) => a.kind === kind && a.currentCents !== null);
  return xs.length ? xs.reduce((t, a) => t + a.currentCents!, 0) : null;
}

const kindOf = (type: string): FeedAccount["kind"] => (type === "depository" ? "CASH" : type === "credit" || type === "loan" ? "CREDIT" : "OTHER");
const norm = (s: string | null | undefined) => (s ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");

type PlaidRow = { id: string; name: string; mask: string | null; type: string; ledgerAccountId: string | null; currentBalanceCents: number | null; availableBalanceCents: number | null; balanceAsOf: Date | null; institution: string | null; connStatus: string };

/** Is this manual account the same real account as this Plaid account? */
export function sameAccount(m: Pick<ClientManualBalance, "ledgerAccountId" | "institution" | "last4">, p: Pick<PlaidRow, "ledgerAccountId" | "institution" | "mask">) {
  if (m.ledgerAccountId && p.ledgerAccountId && m.ledgerAccountId === p.ledgerAccountId) return true;
  return !!m.last4 && m.last4 === p.mask && !!norm(m.institution) && norm(m.institution) === norm(p.institution);
}

const plaidFresh = (p: PlaidRow, now: Date) => p.connStatus === "ACTIVE" && p.currentBalanceCents !== null && !!p.balanceAsOf && now.getTime() - p.balanceAsOf.getTime() <= STALE_HOURS * 3600_000;

/**
 * Picks one figure per real account. Returns the Plaid accounts to show and the manual ones,
 * each real account exactly once.
 */
export function chooseSources(plaid: PlaidRow[], manual: ClientManualBalance[], now: Date) {
  const paired = new Set<string>(); // Plaid accounts already matched to one of ours
  const replaced = new Set<string>(); // ... and shown with our figure instead
  const showManual: ClientManualBalance[] = [];
  for (const m of manual) {
    const p = plaid.find((x) => !paired.has(x.id) && sameAccount(m, x));
    if (p) paired.add(p.id);
    const useOffice = m.balanceCents !== null && (!p || m.balanceSource === "OFFICE" || !plaidFresh(p, now));
    if (!useOffice) continue;
    showManual.push(m);
    if (p) replaced.add(p.id);
  }
  return { showPlaid: plaid.filter((p) => !replaced.has(p.id)), showManual };
}

/** Each registered bank or card account's balance in the books, as office balances (as of the latest activity). */
async function booksBalances(clientId: string): Promise<ClientManualBalance[]> {
  const regs = await prisma.bookkeepingAccount.findMany({ where: { clientId, active: true, parentAccountId: null, ledgerAccountId: { not: null } }, select: { id: true, institution: true, nickname: true, last4: true, accountType: true, ledgerAccountId: true } });
  const out: ClientManualBalance[] = [];
  for (const r of regs) {
    const kind = r.accountType === "CHECKING" || r.accountType === "SAVINGS" ? "CASH" : r.accountType === "CREDIT_CARD" ? "CREDIT" : null;
    if (!kind) continue;
    const [sum, last] = await Promise.all([
      prisma.journalLine.aggregate({ where: { accountId: r.ledgerAccountId!, entry: { clientId } }, _sum: { debitCents: true, creditCents: true } }),
      prisma.journalLine.findFirst({ where: { accountId: r.ledgerAccountId!, entry: { clientId } }, orderBy: { entry: { date: "desc" } }, select: { entry: { select: { date: true } } } }),
    ]);
    if (!last) continue;
    const dr = sum._sum.debitCents ?? 0, cr = sum._sum.creditCents ?? 0;
    out.push({ id: `books:${r.id}`, name: r.nickname || r.institution, institution: r.institution, last4: r.last4, kind, ledgerAccountId: r.ledgerAccountId, balanceSource: "OFFICE", balanceCents: kind === "CASH" ? dr - cr : cr - dr, asOf: last.entry.date, fromFile: true });
  }
  return out;
}

export async function bankFeed(clientId: string, opts: { transactions?: number; now?: Date } = {}): Promise<BankFeed> {
  const now = opts.now ?? new Date();
  const officeVisible = await clientBankBalancesVisible();
  const [conns, manual] = await Promise.all([
    prisma.bankConnection.findMany({
      where: { clientId, status: { not: "DISCONNECTED" } },
      orderBy: { createdAt: "asc" },
      select: { id: true, institutionName: true, status: true, environment: true, lastSuccessAt: true, lastClientRefreshAt: true, accounts: { orderBy: { createdAt: "asc" } } },
    }),
    officeVisible ? clientManualBalances(clientId) : Promise.resolve([] as ClientManualBalance[]),
  ]);
  // No bank feed and no balance entered by the office: the balance per the books (the same figure
  // staff see), dated to the books' latest bank activity. Only when Tabitha shows balances to clients.
  if (officeVisible && !conns.length && !manual.some((m) => m.balanceCents !== null)) manual.push(...(await booksBalances(clientId)));

  const all: PlaidRow[] = conns.flatMap((c) => c.accounts.map((a) => ({ id: a.id, name: a.name, mask: a.mask, type: a.type, ledgerAccountId: a.ledgerAccountId, currentBalanceCents: a.currentBalanceCents, availableBalanceCents: a.availableBalanceCents, balanceAsOf: a.balanceAsOf, institution: c.institutionName, connStatus: c.status })));
  const { showPlaid, showManual } = chooseSources(all, manual, now);
  const today = balanceDay(now);
  const snaps = showPlaid.length
    ? await prisma.bankBalanceDaily.findMany({ where: { clientId, accountId: { in: showPlaid.map((a) => a.id) }, day: { gte: new Date(today.getTime() - 14 * 86400000) } }, orderBy: { day: "desc" } })
    : [];
  const plaidAccounts: FeedAccount[] = showPlaid.map((a) => {
    const mine = snaps.filter((s) => s.accountId === a.id);
    const todays = mine.find((s) => s.day.getTime() === today.getTime());
    const before = mine.find((s) => s.day.getTime() < today.getTime());
    return {
      id: a.id,
      name: a.name,
      mask: a.mask,
      kind: kindOf(a.type),
      institution: a.institution,
      currentCents: a.currentBalanceCents,
      availableCents: a.availableBalanceCents,
      changeCents: todays && before ? todays.currentBalanceCents - before.currentBalanceCents : null,
      asOf: a.balanceAsOf?.toISOString() ?? null,
      source: "PLAID",
      stale: !a.balanceAsOf || now.getTime() - a.balanceAsOf.getTime() > STALE_HOURS * 3600_000,
    };
  });
  const officeAccounts: FeedAccount[] = showManual.map((r) => ({
    id: r.id, name: r.name, mask: r.last4, kind: r.kind, institution: r.institution, currentCents: r.balanceCents, availableCents: null, changeCents: null,
    asOf: r.asOf!.toISOString(), asOfDateOnly: r.fromFile, source: "OFFICE", stale: now.getTime() - r.asOf!.getTime() > MANUAL_STALE_DAYS * 86_400_000,
  }));
  const accounts = [...plaidAccounts, ...officeAccounts];
  const source: BankFeed["source"] = plaidAccounts.length && officeAccounts.length ? "MIXED" : officeAccounts.length ? "MANUAL" : plaidAccounts.length || conns.length ? "PLAID" : "NONE";

  // Freshness: the bank feed's as before (its accounts and its last successful sync); ours by MANUAL_STALE_DAYS.
  const plaidTimes = [...all.map((a) => a.balanceAsOf), ...conns.map((c) => c.lastSuccessAt)].filter((d): d is Date => !!d).map((d) => d.getTime());
  const officeTimes = showManual.map((r) => r.asOf!.getTime());
  const newestOffice = officeTimes.length ? Math.max(...officeTimes) : null;
  const plaidStale = !plaidTimes.length || now.getTime() - Math.max(...plaidTimes) > STALE_HOURS * 3600_000;
  const officeStale = newestOffice !== null && now.getTime() - newestOffice > MANUAL_STALE_DAYS * 86_400_000;
  const times = [...(plaidAccounts.length || !officeTimes.length ? plaidTimes : []), ...officeTimes];
  const stale = source === "MANUAL" ? officeStale : source === "MIXED" ? plaidStale && officeStale : conns.length ? plaidStale : false;

  const syncs = conns.map((c) => c.lastSuccessAt?.getTime()).filter((t): t is number => !!t);
  const ledgerIds = all.map((a) => a.ledgerAccountId).filter((x): x is string => !!x);
  const txns = ledgerIds.length
    ? await prisma.bankTransaction.findMany({
        where: { clientId, accountId: { in: ledgerIds }, status: { not: "EXCLUDED" } },
        orderBy: [{ date: "desc" }, { createdAt: "desc" }],
        take: opts.transactions ?? 8,
        select: { id: true, date: true, description: true, amountCents: true, accountId: true },
      })
    : [];
  const label = (ledgerId: string) => {
    const a = all.find((x) => x.ledgerAccountId === ledgerId);
    return a ? `${a.name}${a.mask ? ` ••${a.mask}` : ""}` : "Bank account";
  };
  const lastRefresh = Math.max(0, ...conns.map((c) => c.lastClientRefreshAt?.getTime() ?? 0));
  const next = lastRefresh ? lastRefresh + CLIENT_REFRESH_MINUTES * 60_000 : 0;
  return {
    source,
    connected: conns.length > 0,
    needsAttention: conns.some((c) => c.status === "NEEDS_REAUTH" || c.status === "ERROR"),
    sandbox: conns.some((c) => c.environment === "SANDBOX"),
    accounts,
    cashCents: sumOf(accounts, "CASH"),
    creditCents: sumOf(accounts, "CREDIT"),
    netCents: netOf(accounts),
    updatedAt: times.length ? new Date(Math.max(...times)).toISOString() : null,
    lastSyncAt: syncs.length ? new Date(Math.max(...syncs)).toISOString() : null,
    stale,
    updatedDateOnly: newestOffice !== null && !!showManual.find((r) => r.asOf!.getTime() === newestOffice)?.fromFile,
    transactions: txns.map((t) => ({ id: t.id, date: t.date.toISOString().slice(0, 10), description: t.description, amountCents: t.amountCents, account: label(t.accountId) })),
    nextRefreshAt: next > now.getTime() ? new Date(next).toISOString() : null,
  };
}
