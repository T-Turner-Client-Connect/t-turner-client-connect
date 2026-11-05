"use client";

import { createContext, useCallback, useContext, useEffect, useState } from "react";
import { Landmark, RefreshCw } from "lucide-react";
import type { BankFeed } from "@/lib/services/bank-feed";
import { asOfLabel, BankTicker, usdc } from "@/components/bank/bank-ticker";

/**
 * The business dashboard's live bank data. Polls the client's own authenticated JSON route
 * every 20 seconds while the page is visible and shows new data the moment it arrives.
 * Banks report on their own schedule (several times a day) — the UI says when they last did.
 */
const POLL_MS = 20_000;

type Live = { feed: BankFeed; refresh: () => Promise<void>; refreshing: boolean; note: string | null; now: Date; live: boolean };
const Ctx = createContext<Live | null>(null);
const useLive = () => {
  const v = useContext(Ctx);
  if (!v) throw new Error("LiveBankProvider missing");
  return v;
};

/**
 * `live={false}` (staff View as Client): shows the server-loaded feed only. The client's JSON
 * routes need a portal session, so nothing is fetched and Refresh is never offered.
 */
export function LiveBankProvider({ account, initial, live = true, children }: { account: string; initial: BankFeed; live?: boolean; children: React.ReactNode }) {
  const [feed, setFeed] = useState(initial);
  const [now, setNow] = useState(() => new Date());
  const [refreshing, setRefreshing] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    if (!live || !initial.connected) return;
    let stopped = false;
    const load = async () => {
      if (document.visibilityState !== "visible") return;
      try {
        const res = await fetch(`/api/client/bank?account=${encodeURIComponent(account)}`, { cache: "no-store" });
        if (res.ok && !stopped) setFeed((await res.json()) as BankFeed);
      } catch {
        // Offline for a moment: keep showing the last data with its time.
      }
      if (!stopped) setNow(new Date());
    };
    const t = setInterval(load, POLL_MS);
    document.addEventListener("visibilitychange", load);
    return () => {
      stopped = true;
      clearInterval(t);
      document.removeEventListener("visibilitychange", load);
    };
  }, [account, initial.connected, live]);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    setNote(null);
    try {
      const res = await fetch("/api/client/bank/refresh", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ account }) });
      const body = (await res.json().catch(() => ({}))) as { feed?: BankFeed; message?: string; error?: string };
      if (body.feed) setFeed(body.feed);
      setNote(body.message ?? body.error ?? (res.ok ? "Checked with your bank." : "Couldn't refresh just now."));
    } catch {
      setNote("You appear to be offline. Try again in a moment.");
    } finally {
      setRefreshing(false);
      setNow(new Date());
    }
  }, [account]);

  return <Ctx.Provider value={{ feed, refresh, refreshing, note, now, live }}>{children}</Ctx.Provider>;
}

export function LiveBankTicker() {
  const { feed, now } = useLive();
  return <BankTicker feed={feed} now={now} />;
}

/** Bank Balance KPI, from the live feed: the total of cash accounts, "(N Accounts)" and when the bank last reported. */
export function LiveBankKpi({ className }: { className: string }) {
  const { feed, now } = useLive();
  const cash = feed.accounts.filter((a) => a.kind === "CASH" && a.currentCents !== null);
  return (
    <div className={className} data-testid="kpi-bank">
      <Landmark className="size-10 shrink-0 text-gold-600" aria-hidden />
      <div className="min-w-0">
        <p className="text-sm font-medium text-navy-800">Bank Balance{cash.length ? <span className="whitespace-nowrap text-slate-600"> ({cash.length} Account{cash.length === 1 ? "" : "s"})</span> : null}</p>
        <p className="truncate font-serif text-2xl font-bold text-navy-900" data-testid="kpi-bank-value">{cash.length ? usdc(cash.reduce((t, a) => t + a.currentCents!, 0)) : "—"}</p>
        <p className="text-xs text-slate-600">{feed.connected ? `${feed.sandbox ? "Test data" : feed.stale ? "Not current" : "As of"} ${asOfLabel(feed.updatedAt, now)}` : "Bank feed being set up"}</p>
      </div>
    </div>
  );
}

/** Each account's balance and the latest transactions, with an honest "updated" time and Refresh now. */
export function LiveBankCard({ className, canRefresh }: { className: string; canRefresh: boolean }) {
  const { feed, refresh, refreshing, note, now, live } = useLive();
  const waitUntil = feed.nextRefreshAt && new Date(feed.nextRefreshAt) > now ? new Date(feed.nextRefreshAt) : null;
  return (
    <section className={className} data-testid="live-bank">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-ivory-200 pb-3">
        <div className="flex items-start gap-3">
          <Landmark className="size-8 shrink-0 text-gold-600" aria-hidden />
          <div>
            <h2 className="font-serif text-lg font-bold text-navy-900">Bank Accounts</h2>
            <p className="text-sm text-navy-800" data-testid="bank-updated" aria-live="polite">
              {feed.connected ? (feed.updatedAt ? `Banks send updates several times a day; last update ${asOfLabel(feed.updatedAt, now)}` : "Waiting for your bank's first report") : "Secure, read-only bank feed"}
            </p>
            {feed.connected && <p className="text-xs text-slate-600" data-testid="bank-last-sync">Last successful sync with your bank: {feed.lastSyncAt ? asOfLabel(feed.lastSyncAt, now) : "not yet"}</p>}
          </div>
        </div>
        {feed.connected && canRefresh && live && (
          <button type="button" onClick={refresh} disabled={refreshing || !!waitUntil} className="inline-flex items-center gap-2 rounded-lg border-[1.5px] border-navy-900 bg-white px-3 py-1.5 text-sm font-semibold text-navy-900 hover:bg-ivory-50 disabled:cursor-not-allowed disabled:opacity-60" data-testid="bank-refresh">
            <RefreshCw className={`size-4 ${refreshing ? "animate-spin" : ""}`} aria-hidden />
            {refreshing ? "Checking…" : waitUntil ? `Refresh again at ${asOfLabel(waitUntil.toISOString(), now)}` : "Refresh now"}
          </button>
        )}
      </div>
      {note && <p className="mt-2 text-sm text-navy-800" role="status" data-testid="bank-refresh-note">{note}</p>}
      {!feed.connected ? (
        <p className="mt-3 text-sm text-navy-800" data-testid="bank-none">Our office is setting up your bank feed — balances will appear here automatically.</p>
      ) : (
        <>
          {feed.sandbox && <p className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-sm font-semibold text-red-800" data-testid="bank-sandbox">Test connection — these are sample figures from the bank&apos;s test system, not your real accounts.</p>}
          {feed.stale && !feed.sandbox && <p className="mt-3 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900" data-testid="bank-stale">Not current: your bank hasn&apos;t sent an update since {asOfLabel(feed.updatedAt, now)}. Our office is checking the connection; the figures below are from that time.</p>}
          {feed.needsAttention && <p className="mt-3 rounded-lg bg-gold-50 px-3 py-2 text-sm text-navy-900">Our office is reconnecting your bank feed. The figures below are the latest your bank sent.</p>}
          <ul className="mt-3 divide-y divide-ivory-200" data-testid="bank-accounts">
            {feed.accounts.map((a) => (
              <li key={a.id} className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 py-2">
                <span className="min-w-0 text-sm font-semibold text-navy-900">{a.name}{a.mask && <span className="font-normal text-slate-600"> ••{a.mask}</span>}{a.institution && <span className="block text-xs font-normal text-slate-600">{a.institution}</span>}</span>
                <span className="text-right">
                  <span className="block font-serif text-base font-bold text-navy-900">{a.currentCents !== null ? usdc(a.currentCents) : "—"}</span>
                  <span className="block text-xs text-slate-600">{a.availableCents !== null && a.kind === "CASH" ? `${usdc(a.availableCents)} available · ` : ""}as of {asOfLabel(a.asOf, now)}</span>
                </span>
              </li>
            ))}
          </ul>
          <h3 className="mt-4 text-sm font-semibold text-navy-900">Recent transactions</h3>
          {feed.transactions.length ? (
            <ul className="mt-1 divide-y divide-ivory-200 text-sm" data-testid="bank-transactions">
              {feed.transactions.map((t) => (
                <li key={t.id} className="flex items-start justify-between gap-3 py-1.5">
                  <span className="min-w-0">
                    <span className="block truncate text-navy-900">{t.description}</span>
                    <span className="block text-xs text-slate-600">{new Date(`${t.date}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" })} · {t.account}</span>
                  </span>
                  <span className={`shrink-0 font-semibold ${t.amountCents >= 0 ? "text-emerald-700" : "text-navy-900"}`}>{t.amountCents >= 0 ? "+" : ""}{usdc(t.amountCents)}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-1 text-sm text-slate-600">Posted transactions appear here as your bank reports them.</p>
          )}
          <p className="mt-3 text-xs text-slate-500">Banks report balances and transactions several times a day; {live ? "this page shows each update as soon as it arrives." : "View as Client shows the figures as of when this page opened."}</p>
        </>
      )}
    </section>
  );
}
