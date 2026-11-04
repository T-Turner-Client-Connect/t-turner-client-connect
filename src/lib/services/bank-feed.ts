import "server-only";
import { prisma } from "@/lib/prisma";
import { balanceDay } from "./banking";

/**
 * One business's bank feed as the bank last reported it: each connected account's balance,
 * today's change against the latest earlier day, and the latest posted transactions.
 * This module never checks access itself: the staff overview calls it after canUseLedger,
 * the client portal after requireClientAccess(…, "bookkeeping"). Only this client's rows are read.
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
};
export type FeedTxn = { id: string; date: string; description: string; amountCents: number; account: string };
export type BankFeed = {
  connected: boolean;
  needsAttention: boolean;
  accounts: FeedAccount[];
  netCents: number | null;
  updatedAt: string | null;
  // The last successful retrieval from the bank, and whether the data is older than a day and a half.
  lastSyncAt: string | null;
  stale: boolean;
  // Plaid sandbox: test data, never a real bank. Always labeled as such.
  sandbox: boolean;
  transactions: FeedTxn[];
  nextRefreshAt: string | null;
};

const kindOf = (type: string): FeedAccount["kind"] => (type === "depository" ? "CASH" : type === "credit" || type === "loan" ? "CREDIT" : "OTHER");

export async function bankFeed(clientId: string, opts: { transactions?: number; now?: Date } = {}): Promise<BankFeed> {
  const now = opts.now ?? new Date();
  const conns = await prisma.bankConnection.findMany({
    where: { clientId, status: { not: "DISCONNECTED" } },
    orderBy: { createdAt: "asc" },
    select: { id: true, institutionName: true, status: true, environment: true, lastSuccessAt: true, lastClientRefreshAt: true, accounts: { orderBy: { createdAt: "asc" } } },
  });
  if (!conns.length) return { connected: false, needsAttention: false, accounts: [], netCents: null, updatedAt: null, lastSyncAt: null, stale: false, sandbox: false, transactions: [], nextRefreshAt: null };

  const all = conns.flatMap((c) => c.accounts.map((a) => ({ ...a, institution: c.institutionName })));
  const today = balanceDay(now);
  const snaps = all.length
    ? await prisma.bankBalanceDaily.findMany({ where: { clientId, accountId: { in: all.map((a) => a.id) }, day: { gte: new Date(today.getTime() - 14 * 86400000) } }, orderBy: { day: "desc" } })
    : [];
  const accounts: FeedAccount[] = all.map((a) => {
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
    };
  });
  const withBalance = accounts.filter((a) => a.currentCents !== null && a.kind !== "OTHER");
  // Cash in the bank less what is owed on cards and loans.
  const netCents = withBalance.length ? withBalance.reduce((t, a) => t + (a.kind === "CASH" ? a.currentCents! : -a.currentCents!), 0) : null;
  const times = [...all.map((a) => a.balanceAsOf), ...conns.map((c) => c.lastSuccessAt)].filter((d): d is Date => !!d).map((d) => d.getTime());
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
    connected: true,
    needsAttention: conns.some((c) => c.status === "NEEDS_REAUTH" || c.status === "ERROR"),
    sandbox: conns.some((c) => c.environment === "SANDBOX"),
    accounts,
    netCents,
    updatedAt: times.length ? new Date(Math.max(...times)).toISOString() : null,
    lastSyncAt: syncs.length ? new Date(Math.max(...syncs)).toISOString() : null,
    stale: !times.length || now.getTime() - Math.max(...times) > STALE_HOURS * 3600_000,
    transactions: txns.map((t) => ({ id: t.id, date: t.date.toISOString().slice(0, 10), description: t.description, amountCents: t.amountCents, account: label(t.accountId) })),
    nextRefreshAt: next > now.getTime() ? new Date(next).toISOString() : null,
  };
}
