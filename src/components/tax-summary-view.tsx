import type { TaxReturnSummary, TaxSummaryItem } from "@prisma/client";
import type { Amount } from "@/lib/tax/extract";
import { FORM_LABELS } from "@/lib/tax/form-labels";
import { Badge } from "@/components/ui";
import { FILING_STATUSES, maskedAccount, money, resultLabel, type Dependent, type StateResult } from "@/lib/services/tax-summary";

/** The figures exactly as the client sees and approves them. Bank details are last four only. */
const SECTION_TITLES: Record<string, string> = { INCOME: "Income — each item on your return", ADJUSTMENT: "Adjustments to income", DEDUCTION: "Deductions", CREDIT: "Credits", PAYMENT: "Payments and withholding", OTHER: "Other entries" };

/** Every verified entry on the return, one by one (each employer and payer separately). */
export function SummaryItems({ items, flagName }: { items: TaxSummaryItem[]; flagName?: boolean }) {
  const sections = Object.keys(SECTION_TITLES).filter((k) => items.some((i) => i.section === k));
  if (!items.length) return null;
  return (
    <div className="space-y-3" data-testid="client-items">
      {sections.map((sec) => (
        <div key={sec} className="rounded-xl border border-ivory-200 p-3">
          <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">{SECTION_TITLES[sec]}</p>
          <ul className="divide-y divide-ivory-100">
            {items.filter((i) => i.section === sec).map((i) => (
              <li key={i.id} className="py-2" data-testid="client-item">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <p className="min-w-0 font-semibold text-navy-900">{i.payerName} <span className="font-normal text-slate-600">· {FORM_LABELS[i.formType] ?? i.formType}{i.recipient === "SPOUSE" ? " · spouse" : ""}</span></p>
                </div>
                <dl className="mt-1 grid gap-x-4 gap-y-0.5 text-sm sm:grid-cols-2">
                  {((i.returnAmounts as Amount[] | null) ?? []).map((a) => (
                    <div key={a.key} className="flex justify-between gap-2"><dt className="text-slate-600">{a.label}</dt><dd className="tabular-nums">{money(a.cents)}</dd></div>
                  ))}
                </dl>
                {flagName && (
                  <label className="mt-1 flex flex-wrap items-center gap-2 text-xs text-amber-900">
                    <input type="checkbox" name="wrongItem" value={i.id} className="accent-navy-900" /> This is wrong
                    <input className="input h-8 min-w-0 flex-1 text-xs" name={`itemNote_${i.id}`} placeholder="What should it be?" aria-label={`What's wrong with ${i.payerName}`} />
                  </label>
                )}
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}

export function SummaryFigures({ s }: { s: TaxReturnSummary }) {
  const deps = (s.dependents as Dependent[]) ?? [];
  const states = (s.stateResults as StateResult[]) ?? [];
  const fed = resultLabel(s.federalResultCents);
  const row = (label: string, value: React.ReactNode, strong = false) => (
    <div className="flex items-baseline justify-between gap-3 border-b border-ivory-100 py-1.5 last:border-0">
      <dt className="text-slate-600">{label}</dt>
      <dd className={`min-w-0 text-right ${strong ? "font-semibold text-navy-900" : "text-navy-900"}`}>{value}</dd>
    </div>
  );
  return (
    <div className="grid gap-4 text-sm md:grid-cols-2" data-testid="summary-figures">
      <dl className="rounded-xl border border-ivory-200 p-3">
        <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-500">Who is on the return</p>
        {row("Tax year", `${s.taxYear}${s.filingType === "AMENDED" ? " (amended)" : ""}`)}
        {row("Filing status", FILING_STATUSES[s.filingStatus as keyof typeof FILING_STATUSES] ?? s.filingStatus, true)}
        {row("Taxpayer", s.taxpayerName)}
        {s.spouseName && row(s.filingStatus === "MFS" ? "Spouse (filing separately)" : "Spouse", s.spouseName)}
        {s.taxpayerSsnLast4 && row("Taxpayer SSN", `XXX-XX-${s.taxpayerSsnLast4}`)}
        {s.spouseName && s.spouseSsnLast4 && row("Spouse SSN", `XXX-XX-${s.spouseSsnLast4}`)}
        {row("Dependents claimed", deps.length ? <span className="break-words">{deps.map((d) => `${d.name}${d.relationship ? ` (${d.relationship})` : ""}`).join(", ")}</span> : "None")}
      </dl>
      <dl className="rounded-xl border border-ivory-200 p-3">
        <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-500">Totals from your return</p>
        {row("Wages", money(s.wagesCents))}
        {row("Other income", money(s.otherIncomeCents))}
        {row("Total income", money(s.totalIncomeCents), true)}
        {row("Adjusted gross income (AGI)", money(s.agiCents), true)}
        {row(s.deductionType === "ITEMIZED" ? "Itemized deductions" : "Standard deduction", money(s.deductionCents))}
        {row("Taxable income", money(s.taxableIncomeCents), true)}
      </dl>
      <dl className="rounded-xl border border-ivory-200 p-3">
        <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-500">Refund or amount owed</p>
        {row("Federal", <Badge tone={fed.tone}>{fed.label}</Badge>, true)}
        {states.length === 0 && row("State", "No state return")}
        {states.map((st) => {
          const l = resultLabel(st.resultCents);
          return <div key={st.state}>{row(`State — ${st.state}`, <Badge tone={l.tone}>{l.label}</Badge>, true)}</div>;
        })}
      </dl>
      <dl className="rounded-xl border border-ivory-200 p-3">
        <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-500">Direct deposit (please verify)</p>
        {s.depositAccountLast4 ? (
          <>
            {s.depositBankName && row("Bank", s.depositBankName)}
            {row("Account type", s.depositAccountType === "SAVINGS" ? "Savings" : "Checking")}
            {row("Routing number", maskedAccount(s.depositRoutingLast4))}
            {row("Account number", maskedAccount(s.depositAccountLast4))}
          </>
        ) : (
          <p className="py-1.5 text-slate-600">No direct deposit on this return.</p>
        )}
      </dl>
      {s.officeNote && <p className="rounded-xl bg-ivory-50 p-3 text-navy-900 md:col-span-2"><strong>Note from our office:</strong> {s.officeNote}</p>}
    </div>
  );
}
