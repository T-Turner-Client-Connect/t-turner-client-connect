import { CalendarDays, CircleCheck, CreditCard, History, Repeat, Wallet } from "lucide-react";
import { Badge } from "@/components/ui";
import { YearTabs } from "@/components/year-tabs";
import { fmtDate } from "@/lib/format";

type Tone = "green" | "red" | "amber" | "gray" | "navy" | "gold";
export type BillingRow = { key: string; due: string | null; amountCents: number | null; detail?: string | null; paidOn: string | null; status: string; tone: Tone; link?: { href: string; label: string } | null; upcoming?: boolean };
export type MonthlyBilling = {
  title: string;
  amountCents: number | null;
  schedule: string; // "Monthly"
  dueDay: string | null; // "Due on the 17th"
  payWith: string | null; // "Card on file" / "Check"
  status: { label: string; tone: Tone };
  next: { date: string; amountCents: number | null } | null;
  last: { date: string; amountCents: number | null } | null;
  overdueCents: number;
  overdueNote?: string | null;
  rows: BillingRow[];
  source: string; // footnote: where the figures come from
};

const usd = (c: number | null | undefined) => (c == null ? "—" : `$${(c / 100).toLocaleString("en-US", { minimumFractionDigits: 2 })}`);
const day = (d: string) => fmtDate(new Date(`${d.slice(0, 10)}T12:00:00Z`));

/** The client's monthly billing, in the same navy/gold design as the staff billing box. Read only. */
export function MonthlyBillingCard({ b, testId, showHeading = true }: { b: MonthlyBilling; testId: string; showHeading?: boolean }) {
  const upcoming = b.rows.filter((r) => r.upcoming);
  const past = b.rows.filter((r) => !r.upcoming);
  // Click a year to see that year's payments.
  const years = [...new Set(past.map((r) => (r.due ?? r.paidOn ?? "").slice(0, 4)).filter(Boolean))].sort().reverse();
  const row = (r: BillingRow) => (
    <tr key={r.key} className={r.upcoming ? "bg-gold-100/50" : ""} data-testid={r.upcoming ? `${testId}-upcoming` : undefined}>
      <td className={`whitespace-nowrap px-2 py-2 ${r.upcoming ? "font-semibold" : ""}`}>{r.due ? day(r.due) : "—"}</td>
      <td className={`whitespace-nowrap px-2 text-right ${r.upcoming ? "font-semibold" : ""}`}>{usd(r.amountCents)}{r.detail && <span className="block text-xs font-normal text-slate-600">{r.detail}</span>}</td>
      <td className="whitespace-nowrap px-2">{r.paidOn ? day(r.paidOn) : r.upcoming ? <span className="text-xs text-slate-600">{b.payWith ?? "—"}</span> : "—"}</td>
      <td className="px-2 text-center"><Badge tone={r.tone}>{r.status}</Badge></td>
      <td className="px-2">{r.link ? <a className="underline" href={r.link.href} target="_blank" rel="noopener noreferrer">{r.link.label}</a> : "—"}</td>
    </tr>
  );
  return (
    <section className="mb-6 space-y-4" data-testid={testId}>
      <div className={`flex items-center gap-3 ${showHeading ? "" : "[&>span]:hidden [&_h2]:sr-only"}`}>
        <span aria-hidden className="grid size-12 place-items-center rounded-2xl border-2 border-gold-500 bg-gold-100/40 text-gold-600"><CreditCard className="size-6" /></span>
        <div>
          <h2 className="font-serif text-2xl font-bold leading-tight text-navy-900">Your Monthly Billing</h2>
          <p className="text-sm font-semibold text-gold-700">{b.title}</p>
        </div>
      </div>
      <div>
        <span className="relative z-10 ml-4 inline-block rounded-t-lg bg-gradient-to-b from-gold-300 to-gold-500 px-4 py-1 text-sm font-bold text-navy-950 shadow-sm">Active Recurring Billing</span>
        <div className="overflow-hidden rounded-2xl border-2 border-gold-500 bg-gradient-to-br from-navy-950 to-navy-900 text-white shadow-lg">
          <div className="flex flex-wrap items-start justify-between gap-3 p-5">
            <div className="flex gap-4">
              <span aria-hidden className="hidden size-16 shrink-0 place-items-center rounded-full border-2 border-gold-500/70 text-gold-300 sm:grid"><CalendarDays className="size-8" /></span>
              <div>
                <p className="text-sm text-slate-200">Monthly amount</p>
                <p className="font-serif text-4xl font-bold text-gold-300">{usd(b.amountCents)}</p>
                <p className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-slate-100">
                  <span className="inline-flex items-center gap-1.5"><Repeat aria-hidden className="size-4" />{b.schedule}</span>
                  {b.dueDay && <><span aria-hidden className="text-white/30">|</span><span className="inline-flex items-center gap-1.5"><CalendarDays aria-hidden className="size-4" />{b.dueDay}</span></>}
                  {b.payWith && <><span aria-hidden className="text-white/30">|</span><span className="inline-flex items-center gap-1.5"><CreditCard aria-hidden className="size-4" />{b.payWith}</span></>}
                </p>
              </div>
            </div>
            <span className={`inline-flex items-center gap-1 rounded-full border px-3 py-1 text-sm font-semibold ${b.status.tone === "red" ? "border-red-400 bg-red-500/15 text-red-300" : "border-emerald-400 bg-emerald-500/15 text-emerald-300"}`}>{b.status.tone === "red" ? "Past due" : <><CircleCheck aria-hidden className="size-4" /> Active</>}</span>
          </div>
          <div className="grid divide-y divide-white/15 border-t border-white/15 sm:grid-cols-3 sm:divide-x sm:divide-y-0">
            <div className="flex gap-3 p-4"><CalendarDays aria-hidden className="mt-0.5 size-6 shrink-0 text-gold-300" /><div><p className="text-sm text-slate-300">Next Payment</p><p className="text-xl font-bold">{b.next ? day(b.next.date) : "None scheduled"}</p>{b.next && <p className="text-sm text-slate-200">{usd(b.next.amountCents)}</p>}</div></div>
            <div className="flex gap-3 p-4"><CircleCheck aria-hidden className="mt-0.5 size-6 shrink-0 text-gold-300" /><div><p className="text-sm text-slate-300">Status</p><p className={`text-lg font-bold ${b.status.tone === "red" ? "text-red-300" : b.status.tone === "green" ? "text-emerald-300" : "text-gold-300"}`}>{b.status.label}</p></div></div>
            <div className="flex gap-3 p-4"><Wallet aria-hidden className="mt-0.5 size-6 shrink-0 text-gold-300" /><div><p className="text-sm text-slate-300">Last Payment</p><p className="text-xl font-bold">{b.last ? day(b.last.date) : "—"}</p>{b.last && <p className="text-sm text-slate-200">{usd(b.last.amountCents)}</p>}</div></div>
          </div>
        </div>
      </div>
      {b.overdueCents > 0 && <p className="rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-800" data-testid={`${testId}-overdue`}>Past due: {usd(b.overdueCents)}{b.overdueNote ? ` (${b.overdueNote})` : ""}. Questions? Send us a message.</p>}
      <div className="rounded-2xl border border-ivory-200 bg-white p-4 shadow-sm" data-testid={`${testId}-history`}>
        <p className="mb-2 flex items-center gap-2 text-lg font-bold text-navy-900"><History aria-hidden className="size-5" /> Your Payments <span className="text-sm font-normal text-slate-600">(by year)</span></p>
        {b.rows.length === 0 ? <p className="text-sm text-slate-600">No payments yet.</p> : (
          <div className="overflow-x-auto">
            <table className="w-full text-[13px]">
              <thead><tr className="bg-navy-950 text-left text-white"><th className="rounded-l-md px-2 py-1.5">Due</th><th className="px-2 text-right">Amount</th><th className="px-2">Paid on</th><th className="px-2 text-center">Status</th><th className="rounded-r-md px-2">Receipt</th></tr></thead>
              <tbody className="divide-y divide-ivory-200">{upcoming.slice(0, 1).map(row)}</tbody>
            </table>
            <div className="mt-3">
              <YearTabs testId={`${testId}-years`} years={years} panels={Object.fromEntries(years.map((y) => [y, (
                <table key={y} className="w-full text-[13px]"><tbody className="divide-y divide-ivory-200">{past.filter((r) => (r.due ?? r.paidOn ?? "").startsWith(y)).map(row)}</tbody></table>
              )]))} />
            </div>
          </div>
        )}
        <p className="mt-2 text-xs text-slate-500">{b.source}</p>
      </div>
    </section>
  );
}
