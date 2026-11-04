import { CalendarCheck, CalendarDays, CircleCheck, CreditCard, History, Landmark, Plus, Repeat, Settings, Wallet } from "lucide-react";
import { ActionForm } from "@/components/action-form";
import { Badge, Button, Field } from "@/components/ui";
import { recordManualPaymentAction, voidManualPaymentAction } from "@/app/actions/manual-billing";
import { saveBillingAction } from "@/app/actions/bookkeeping-clients";
import { PAY_METHODS, type manualBillingView, type PayMethod } from "@/lib/services/manual-billing";
import { MarkMonthsPaid, MethodFields } from "@/components/manual-billing-forms";
import { YearTabs } from "@/components/year-tabs";
import { fmtDate, fmtDateTime } from "@/lib/format";

type View = Awaited<ReturnType<typeof manualBillingView>>;
const usd = (c: number | null | undefined) => (c == null ? "—" : `$${(c / 100).toLocaleString("en-US", { minimumFractionDigits: 2 })}`);
const ymdDate = (d: string) => fmtDate(new Date(`${d}T12:00:00Z`));
const monthLabel = (m: string) => new Date(`${m}-15T12:00:00Z`).toLocaleDateString("en-US", { month: "short", year: "numeric", timeZone: "UTC" });
const ordinal = (d: number) => `${d}${d % 10 === 1 && d !== 11 ? "st" : d % 10 === 2 && d !== 12 ? "nd" : d % 10 === 3 && d !== 13 ? "rd" : "th"}`;
const iso = (d: Date | null | undefined) => (d ? d.toISOString().slice(0, 10) : "");
const today = () => new Date().toLocaleDateString("en-CA", { timeZone: "America/Chicago" });

/**
 * Office-managed billing (clients NOT billed through Square), in the same style as the Square box.
 * Every figure comes from payments recorded here; nothing is presented as Square-verified.
 */
export function ManualBillingPanel({ clientId, view, owner, officeStatus }: { clientId: string; view: View; owner: boolean; officeStatus: string }) {
  const { billing, payments, ledger, lastPayment } = view;
  const recorded = payments;
  // Payment history by the year of the billing month — click a year to see it.
  const years = [...new Set(recorded.map((p) => p.periodMonth.slice(0, 4)))].sort().reverse();
  const periodOptions = ledger ? ledger.monthChoices : [];
  const row = (p: View["payments"][number]) => (
    <tr key={p.id} className={p.voidedAt ? "text-slate-400 line-through decoration-slate-300" : ""} data-payment={p.id}>
      <td className="whitespace-nowrap px-2 py-2">{fmtDate(p.paidOn)}</td>
      <td className="whitespace-nowrap px-2">{monthLabel(p.periodMonth)}</td>
      <td className="whitespace-nowrap px-2 text-right">{usd(p.amountCents)}</td>
      <td className="px-2">{PAY_METHODS[p.method as PayMethod] ?? p.method}{p.reference ? <span className="block text-xs text-slate-500 no-underline">Ref {p.reference}</span> : null}</td>
      <td className="px-2 text-center">{p.voidedAt ? <Badge tone="gray">Voided</Badge> : <Badge tone="green">Recorded</Badge>}</td>
      <td className="px-2 text-xs">
        {p.voidedAt ? <span className="no-underline">{p.voidReason}</span> : owner ? (
          <details>
            <summary className="cursor-pointer underline">Void</summary>
            <ActionForm action={voidManualPaymentAction.bind(null, p.id)} className="mt-1 flex flex-wrap gap-1" confirm="Void this recorded payment? It stays in the history with your reason.">
              <input className="input w-40 text-xs" name="reason" placeholder="Why? (required)" aria-label="Reason" />
              <Button type="submit" variant="ghost">Void</Button>
            </ActionForm>
          </details>
        ) : null}
      </td>
    </tr>
  );
  return (
    <div className="space-y-4" data-testid="manual-billing">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-ivory-200 pb-4">
        <div className="flex items-center gap-3">
          <span aria-hidden className="grid size-14 place-items-center rounded-2xl border-2 border-gold-500 bg-gold-100/40 text-gold-600"><CreditCard className="size-7" /></span>
          <div>
            <h2 className="font-serif text-xl font-bold leading-tight text-navy-900">Billing &amp; Payments</h2>
            <p className="text-sm font-semibold text-gold-700">Office-managed billing – not through Square</p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex items-center gap-3 rounded-2xl border border-ivory-200 bg-white px-4 py-2.5 shadow-sm">
            <span aria-hidden className="grid size-9 place-items-center rounded-lg bg-navy-950 text-gold-300"><Landmark className="size-5" /></span>
            <div className="text-sm leading-tight">
              <p className="font-semibold text-navy-900">Payments recorded by our office</p>
              <p className="text-slate-600">{lastPayment ? `Last recorded: ${fmtDateTime(lastPayment.createdAt)}` : "No payments recorded yet"}</p>
            </div>
          </div>
          <a href="#record-payment" className="inline-flex items-center gap-2 rounded-xl bg-gold-500 px-5 py-2.5 text-base font-semibold text-navy-950 shadow hover:bg-gold-300"><Plus aria-hidden className="size-5" /> Record Payment</a>
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
        <div className="space-y-4">
          {/* Monthly billing card */}
          <div>
            <span className="relative z-10 ml-4 inline-block rounded-t-lg bg-gradient-to-b from-gold-300 to-gold-500 px-4 py-1 text-sm font-bold text-navy-950 shadow-sm">Monthly Billing</span>
            <div className="overflow-hidden rounded-2xl border-2 border-gold-500 bg-gradient-to-br from-navy-950 to-navy-900 text-white shadow-lg" data-testid="manual-billing-card">
              {!ledger ? (
                <div className="p-6">
                  <p className="text-lg font-bold">Set up this client&apos;s monthly billing</p>
                  <p className="mt-1 text-sm text-slate-200">Enter the monthly fee and billing day under Billing Settings. Status, balances and the next due date are then worked out from the payments you record.</p>
                </div>
              ) : (
                <>
                  <div className="flex flex-wrap items-start justify-between gap-3 p-5">
                    <div className="flex gap-4">
                      <span aria-hidden className="hidden size-16 shrink-0 place-items-center rounded-full border-2 border-gold-500/70 text-gold-300 sm:grid"><CalendarDays className="size-8" /></span>
                      <div>
                        <p className="text-xl font-bold">Monthly Bookkeeping</p>
                        <p className="text-sm text-slate-200">Billed by our office</p>
                        <p className="mt-1 font-serif text-3xl font-bold text-gold-300" data-testid="manual-fee">{usd(billing?.monthlyFeeCents)}</p>
                        <p className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-slate-100">
                          <span className="inline-flex items-center gap-1.5"><Repeat aria-hidden className="size-4" />Monthly</span>
                          <span aria-hidden className="text-white/30">|</span>
                          <span className="inline-flex items-center gap-1.5"><CalendarDays aria-hidden className="size-4" />Due on the {ordinal(billing!.billingDay!)}</span>
                          {lastPayment && <><span aria-hidden className="text-white/30">|</span><span className="inline-flex items-center gap-1.5"><Wallet aria-hidden className="size-4" />{PAY_METHODS[lastPayment.method as PayMethod] ?? lastPayment.method}</span></>}
                        </p>
                      </div>
                    </div>
                    <span className={`inline-flex items-center gap-1 rounded-full border px-3 py-1 text-sm font-semibold ${ledger.status.tone === "red" ? "border-red-400 bg-red-500/15 text-red-300" : "border-emerald-400 bg-emerald-500/15 text-emerald-300"}`} data-testid="manual-status">{ledger.status.tone === "red" ? "Past due" : <><CircleCheck aria-hidden className="size-4" /> Active</>}</span>
                  </div>
                  <div className="grid divide-y divide-white/15 border-t border-white/15 sm:grid-cols-3 sm:divide-x sm:divide-y-0">
                    <div className="flex gap-3 p-4"><CalendarDays aria-hidden className="mt-0.5 size-6 shrink-0 text-gold-300" /><div><p className="text-sm text-slate-300">Next Payment</p><p className="text-xl font-bold" data-testid="manual-next">{ledger.next ? ymdDate(ledger.next.due) : "—"}</p>{ledger.next && <p className="text-sm text-slate-200">{usd(ledger.next.amountCents)} for {monthLabel(ledger.next.month)}</p>}</div></div>
                    <div className="flex gap-3 p-4"><CircleCheck aria-hidden className="mt-0.5 size-6 shrink-0 text-gold-300" /><div><p className="text-sm text-slate-300">Status</p><p className={`text-lg font-bold ${ledger.status.tone === "red" ? "text-red-300" : ledger.status.tone === "green" ? "text-emerald-300" : "text-gold-300"}`}>{ledger.status.label}</p>{ledger.overdueCents > 0 && <p className="text-sm text-red-200">{usd(ledger.overdueCents)} owed</p>}</div></div>
                    <div className="flex gap-3 p-4"><Wallet aria-hidden className="mt-0.5 size-6 shrink-0 text-gold-300" /><div><p className="text-sm text-slate-300">Last Payment</p><p className="text-xl font-bold">{lastPayment ? fmtDate(lastPayment.paidOn) : "—"}</p><p className="text-sm text-slate-200">{lastPayment ? `${usd(lastPayment.amountCents)} for ${monthLabel(lastPayment.periodMonth)}` : "None recorded yet"}</p></div></div>
                  </div>
                  <p className="border-t border-white/15 px-5 py-2 text-xs text-slate-300">From payments recorded by our office — not Square-verified.</p>
                </>
              )}
            </div>
          </div>

          {/* Payment history */}
          <div className="rounded-2xl border border-ivory-200 bg-white p-4 shadow-sm" data-testid="manual-payment-history">
            <p className="mb-2 flex items-center gap-2 text-lg font-bold text-navy-900"><History aria-hidden className="size-5" /> Payment History <span className="text-sm font-normal text-slate-600">(by year)</span></p>
            {recorded.length === 0 && !ledger?.next ? <p className="text-sm text-slate-600">No payments recorded yet.</p> : (
              <div className="overflow-x-auto">
                <table className="w-full text-[13px]">
                  <thead><tr className="bg-navy-950 text-left text-white"><th className="rounded-l-md px-2 py-1.5">Date paid</th><th className="px-2">For month</th><th className="px-2 text-right">Amount</th><th className="px-2">Method</th><th className="px-2 text-center">Status</th><th className="rounded-r-md px-2"></th></tr></thead>
                  <tbody className="divide-y divide-ivory-200">
                    {ledger?.next && (
                      <tr className="bg-gold-100/50" data-testid="manual-upcoming-row">
                        <td className="whitespace-nowrap px-2 py-2 font-semibold">Due {ymdDate(ledger.next.due)}</td>
                        <td className="whitespace-nowrap px-2">{monthLabel(ledger.next.month)}</td>
                        <td className="whitespace-nowrap px-2 text-right font-semibold">{usd(ledger.next.amountCents)}</td>
                        <td className="px-2 text-xs text-slate-600">—</td>
                        <td className="px-2 text-center"><Badge tone="navy">Upcoming</Badge></td>
                        <td />
                      </tr>
                    )}
                  </tbody>
                </table>
                <YearTabs testId="manual-years" years={years} panels={Object.fromEntries(years.map((y) => [y, (
                  <table key={y} className="w-full text-[13px]"><tbody className="divide-y divide-ivory-200">{recorded.filter((p) => p.periodMonth.startsWith(y)).map(row)}</tbody></table>
                )]))} />

              </div>
            )}
            <p className="mt-2 text-xs text-slate-500">Recorded by our office. A mistaken entry is voided with a reason (owner only) — nothing is deleted.</p>
          </div>
        </div>

        <div className="space-y-4">
          {/* Record a payment */}
          <div id="record-payment" className="scroll-mt-24 rounded-2xl border-2 border-gold-500 bg-white p-4 shadow-sm" data-testid="record-payment">
            <p className="flex items-center gap-2 text-lg font-bold text-navy-900"><Plus aria-hidden className="size-5 text-gold-600" /> Record a Payment</p>
            {!ledger ? <p className="mt-2 text-sm text-slate-600">Set the monthly fee and billing day first (Billing Settings below).</p> : (
              <ActionForm action={recordManualPaymentAction.bind(null, clientId)} className="mt-3 space-y-3" resetOnSuccess showSuccess>
                <div className="grid gap-3 sm:grid-cols-2">
                  <Field label="Amount received ($)"><input className="input" name="amount" inputMode="decimal" defaultValue={((ledger.next?.amountCents ?? billing?.monthlyFeeCents ?? 0) / 100).toFixed(2)} /></Field>
                  <Field label="Date received"><input className="input" type="date" name="paidOn" max={today()} defaultValue={today()} /></Field>
                  <Field label="For billing month"><select className="input" name="periodMonth" defaultValue={ledger.defaultPeriod}>{periodOptions.map((p) => <option key={p.month} value={p.month}>{monthLabel(p.month)}{p.state === "PAID" ? " (paid)" : p.state === "BEFORE_START" ? " (before billing start)" : p.owedCents != null && p.owedCents < (billing?.monthlyFeeCents ?? 0) ? ` (${usd(p.owedCents)} left)` : ""}</option>)}</select></Field>
                  <MethodFields methods={PAY_METHODS} defaultMethod={lastPayment?.method ?? "CHECK"} />
                </div>
                <Field label="Note (optional)"><input className="input" name="note" /></Field>
                <Button type="submit" variant="gold" className="w-full rounded-xl py-2.5 text-base">Save payment</Button>
              </ActionForm>
            )}
          </div>

          {/* Mark several months paid */}
          {billing?.monthlyFeeCents ? (
            <details className="rounded-2xl border border-ivory-200 bg-white p-4 shadow-sm" data-testid="mark-months">
              <summary className="flex cursor-pointer items-center gap-2 text-lg font-bold text-navy-900"><CalendarCheck aria-hidden className="size-5 text-gold-600" /> Mark Months Paid</summary>
              <p className="mt-1 text-xs text-slate-600">For catching up past payments: pick a year, tick the months (or Whole year), enter the amount once.</p>
              <MarkMonthsPaid clientId={clientId} feeCents={billing.monthlyFeeCents} paidMonths={view.paidMonths} partialMonths={view.partialMonths} methods={PAY_METHODS} defaultMethod={lastPayment?.method ?? "CASH_APP"} thisYear={Number(today().slice(0, 4))} />
            </details>
          ) : null}

          {/* Billing settings */}
          <details className="rounded-2xl border border-ivory-200 bg-ivory-50 p-4 shadow-sm" open={!ledger} data-testid="manual-settings">
            <summary className="flex cursor-pointer items-center gap-2 text-lg font-bold text-navy-900"><Settings aria-hidden className="size-5 text-gold-600" /> Billing Settings</summary>
            <ActionForm action={saveBillingAction.bind(null, clientId)} className="mt-3 space-y-3" showSuccess>
              <input type="hidden" name="paymentStatus" value={officeStatus} />
              <Field label="Monthly fee ($)"><input className="input" name="monthlyFee" inputMode="decimal" defaultValue={billing?.monthlyFeeCents != null ? (billing.monthlyFeeCents / 100).toFixed(2) : ""} /></Field>
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="Billing start date"><input className="input" type="date" name="billingStartDate" defaultValue={iso(billing?.billingStartDate)} /></Field>
                <Field label="Due day of the month"><select className="input" name="billingDay" defaultValue={billing?.billingDay ?? ""}><option value="">—</option>{Array.from({ length: 28 }, (_, i) => i + 1).map((d) => <option key={d} value={d}>{d}</option>)}</select></Field>
              </div>
              <Field label="Billing notes"><input className="input" name="notes" defaultValue={billing?.notes ?? ""} /></Field>
              <Button type="submit" variant="secondary" className="w-full">Save settings</Button>
            </ActionForm>
          </details>
        </div>
      </div>
    </div>
  );
}
