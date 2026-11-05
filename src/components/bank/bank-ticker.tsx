import { ArrowDown, ArrowUp, Landmark, Minus } from "lucide-react";
import type { BankFeed, FeedAccount } from "@/lib/services/bank-feed";

/** Shared by the staff Client Overview and the client's business dashboard (no server-only imports). */

export const usdc = (c: number) => `${c < 0 ? "-" : ""}$${(Math.abs(c) / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** "2:14 PM" today, "Nov 3, 2:14 PM" on an earlier day (Central time). */
export function asOfLabel(iso: string | null, now = new Date()) {
  if (!iso) return "not reported yet";
  const d = new Date(iso);
  const day = (x: Date) => x.toLocaleDateString("en-US", { timeZone: "America/Chicago" });
  const time = d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: "America/Chicago" });
  return day(d) === day(now) ? time : `${d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "America/Chicago" })}, ${time}`;
}

/** Always with the date: "Nov 3, 2:14 PM" (Central time). For balances entered by our office. */
export function officeAsOf(iso: string | null) {
  if (!iso) return "not entered yet";
  const d = new Date(iso);
  return `${d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "America/Chicago" })}, ${d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: "America/Chicago" })}`;
}
/** "Nov 3, 2026" (Central time). */
export function officeDate(iso: string | null) {
  return iso ? new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "America/Chicago" }) : "not entered yet";
}

/** The KPI / card line for balances entered by our office. Never says "live". */
export function manualLabel(feed: Pick<BankFeed, "stale" | "updatedAt" | "updatedDateOnly">) {
  return feed.stale ? `Not current · as of ${officeDate(feed.updatedAt)}` : `Updated by our office · as of ${feed.updatedDateOnly ? officeDate(feed.updatedAt) : officeAsOf(feed.updatedAt)}`;
}
/** One account's as-of: a date for a bank-file balance, a date and time otherwise. */
export const manualAsOf = (a: Pick<FeedAccount, "asOf" | "asOfDateOnly">) => (a.asOfDateOnly ? officeDate(a.asOf) : officeAsOf(a.asOf));

const name = (a: FeedAccount) => `${a.name}${a.mask ? ` ••${a.mask}` : ""}`;

function Change({ cents, credit }: { cents: number | null; credit: boolean }) {
  if (cents === null) return <span className="text-navy-200">—</span>;
  if (cents === 0) return <span className="inline-flex items-center gap-0.5 text-navy-100"><Minus className="size-3.5" aria-hidden />$0.00</span>;
  const up = cents > 0;
  // On a card, a higher balance owed is not good news.
  const good = credit ? !up : up;
  return (
    <span className={`inline-flex items-center gap-0.5 font-semibold ${good ? "text-emerald-300" : "text-red-300"}`}>
      {up ? <ArrowUp className="size-3.5" aria-hidden /> : <ArrowDown className="size-3.5" aria-hidden />}
      {usdc(Math.abs(cents))}
    </span>
  );
}

function changeText(a: FeedAccount) {
  if (a.changeCents === null) return "no change recorded yet today";
  if (a.changeCents === 0) return "no change since yesterday";
  return `${a.changeCents > 0 ? "up" : "down"} ${usdc(Math.abs(a.changeCents))} since yesterday`;
}

/**
 * A slim navy-and-gold strip under the banner: each account's balance, today's change and
 * "as of", then the total. Scrolls like a stock ticker; pauses on hover or focus; static and
 * wrapped with reduced motion. Screen readers get the same facts as a plain list.
 */
export function BankTicker({ feed, now, noneText = "Our office is setting up your bank feed — balances will appear here automatically." }: { feed: BankFeed; now?: Date; noneText?: string | null }) {
  const manual = feed.source === "MANUAL";
  if (!feed.connected && !manual) {
    return noneText ? (
      <p className="flex items-center gap-2 rounded-xl border border-gold-500/40 bg-navy-950 px-4 py-2 text-sm text-navy-100" data-testid="bank-ticker-none">
        <Landmark className="size-4 shrink-0 text-gold-400" aria-hidden /> {noneText}
      </p>
    ) : null;
  }
  const shown = feed.accounts.filter((a) => a.currentCents !== null);
  if (!shown.length) return null;
  const items = (
    <>
      {(feed.sandbox || feed.stale || manual) && (
        <span className={`inline-flex shrink-0 items-center whitespace-nowrap px-4 py-2 text-xs font-bold uppercase tracking-[0.12em] ${feed.sandbox || feed.stale ? "text-amber-300" : "text-gold-300"}`}>
          {feed.sandbox ? "Test connection — sample figures" : manual ? (feed.stale ? "Not current — last office update shown" : "Updated by our office") : "Not current — last bank update shown"}
        </span>
      )}
      {shown.map((a) => (
        <span key={a.id} className="inline-flex shrink-0 items-center gap-2 whitespace-nowrap px-4 py-2 text-sm">
          <Landmark className="size-4 text-gold-400" aria-hidden />
          <span className="font-semibold text-white">{name(a)}</span>
          <span className="font-serif font-bold text-gold-300">{usdc(a.currentCents!)}</span>
          {a.source !== "OFFICE" && <Change cents={a.changeCents} credit={a.kind === "CREDIT"} />}
          <span className="text-xs text-navy-200">{a.source === "OFFICE" && !manual ? "by our office · " : ""}as of {a.source === "OFFICE" ? manualAsOf(a) : asOfLabel(a.asOf, now)}</span>
          <span className="text-gold-500" aria-hidden>◆</span>
        </span>
      ))}
      {feed.netCents !== null && (
        <span className="inline-flex shrink-0 items-center gap-2 whitespace-nowrap px-4 py-2 text-sm">
          <span className="font-semibold uppercase tracking-[0.12em] text-gold-300">Net: cash less cards owed</span>
          <span className="font-serif font-bold text-white">{usdc(feed.netCents)}</span>
          <span className="text-gold-500" aria-hidden>◆</span>
        </span>
      )}
    </>
  );
  const duration = `${Math.max(25, shown.length * 12)}s`;
  return (
    <section
      className="bank-ticker relative overflow-hidden rounded-xl border border-gold-500/50 bg-gradient-to-r from-navy-950 via-navy-900 to-navy-950 shadow-[0_10px_24px_-18px_rgb(10_26_68/0.7)] focus:outline-none focus-visible:ring-2 focus-visible:ring-gold-400"
      aria-label="Daily bank balances"
      tabIndex={0}
      data-testid="bank-ticker"
    >
      <ul className="sr-only" data-testid="bank-ticker-list">
        {feed.sandbox && <li>Test connection: sample figures, not real accounts.</li>}
        {manual && <li>{feed.stale ? "Not current: these are the last balances our office entered." : "Balances updated by our office."}</li>}
        {feed.stale && !feed.sandbox && !manual && <li>Not current: these are the last figures the bank sent.</li>}
        {shown.map((a) => (
          <li key={a.id}>{name(a)}: {usdc(a.currentCents!)}, {a.source === "OFFICE" ? "updated by our office, " : `${changeText(a)}, `}as of {a.source === "OFFICE" ? manualAsOf(a) : asOfLabel(a.asOf, now)}.</li>
        ))}
        {feed.cashCents !== null && <li>Cash in bank: {usdc(feed.cashCents)}.</li>}
        {feed.creditCents !== null && <li>Credit cards owed: {usdc(feed.creditCents)}.</li>}
        {feed.netCents !== null && <li>Net, cash less cards owed: {usdc(feed.netCents)}.</li>}
      </ul>
      <div aria-hidden className="bank-ticker-track flex w-max" style={{ ["--ticker-duration" as string]: duration }}>
        <div className="flex">{items}</div>
        <div className="bank-ticker-copy flex">{items}</div>
      </div>
    </section>
  );
}
