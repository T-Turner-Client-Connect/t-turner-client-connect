import { ActionForm } from "@/components/action-form";
import { dayOf, hours, money } from "./status";

type Version = {
  number: number;
  checkDate: Date;
  periodStart: Date | null;
  periodEnd: Date | null;
  employees: number;
  hoursHundredths: number;
  grossCents: number;
  deductionsCents: number;
  employerTaxCents: number;
  netPayCents: number;
  federalWhCents: number; ssEeCents: number; medicareEeCents: number; stateWhCents: number; otherEeTaxCents: number;
  lines: { id: string; employeeName: string; hoursHundredths: number; grossCents: number; deductionsCents: number; employerTaxCents: number; netPayCents: number; federalWhCents: number; ssEeCents: number; medicareEeCents: number; stateWhCents: number; otherEeTaxCents: number }[];
};
const eeTax = (x: { federalWhCents: number; ssEeCents: number; medicareEeCents: number; stateWhCents: number; otherEeTaxCents: number }) => x.federalWhCents + x.ssEeCents + x.medicareEeCents + x.stateWhCents + x.otherEeTaxCents;

/** The pending run as an approver sees it — read-only. Same on the portal page and the texted-link page. */
export function ApprovalSummary({ business, version, showDetail }: { business: string; version: Version; showDetail: boolean }) {
  const cost = version.grossCents + version.employerTaxCents;
  return (
    <div className="space-y-4" data-testid="approval-summary">
      <div className="rounded-2xl bg-navy-900 p-5 text-white">
        <p className="text-sm text-navy-100">{business}</p>
        <p className="mt-1 font-serif text-3xl font-bold">{money(cost)}</p>
        <p className="text-sm text-gold-300">Total payroll cost</p>
        <dl className="mt-4 grid grid-cols-2 gap-3 text-sm">
          <div><dt className="text-navy-100">Pay period</dt><dd className="font-semibold">{version.periodStart && version.periodEnd ? `${dayOf(version.periodStart)} – ${dayOf(version.periodEnd)}` : "—"}</dd></div>
          <div><dt className="text-navy-100">Pay date</dt><dd className="font-semibold">{dayOf(version.checkDate)}</dd></div>
          <div><dt className="text-navy-100">Employees</dt><dd className="font-semibold">{version.employees}</dd></div>
          <div><dt className="text-navy-100">Hours</dt><dd className="font-semibold">{hours(version.hoursHundredths)}</dd></div>
        </dl>
      </div>
      <dl className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-5">
        {[["Gross wages", version.grossCents], ["Employee taxes", eeTax(version)], ["Deductions", version.deductionsCents], ["Net pay", version.netPayCents], ["Employer taxes", version.employerTaxCents]].map(([l, v]) => (
          <div key={l as string} className="rounded-xl border border-navy-100 bg-white p-3"><dt className="text-xs text-slate-600">{l}</dt><dd className="font-semibold text-navy-900">{money(v as number)}</dd></div>
        ))}
      </dl>
      {showDetail && !!version.lines.length && (
        <>
          <ul className="space-y-2 sm:hidden">
            {version.lines.map((l) => (
              <li key={l.id} className="rounded-xl border border-navy-100 bg-white p-3 text-sm">
                <p className="font-semibold text-navy-900">{l.employeeName}</p>
                <dl className="mt-1 grid grid-cols-3 gap-x-2 gap-y-1 text-xs">
                  <div><dt className="text-slate-500">Hours</dt><dd>{hours(l.hoursHundredths)}</dd></div>
                  <div><dt className="text-slate-500">Gross</dt><dd>{money(l.grossCents)}</dd></div>
                  <div><dt className="text-slate-500">Deductions</dt><dd>{money(l.deductionsCents)}</dd></div>
                  <div><dt className="text-slate-500">Emp. taxes</dt><dd>{money(eeTax(l))}</dd></div>
                  <div><dt className="text-slate-500">Employer taxes</dt><dd>{money(l.employerTaxCents)}</dd></div>
                  <div><dt className="text-slate-500">Net</dt><dd className="font-semibold">{money(l.netPayCents)}</dd></div>
                </dl>
              </li>
            ))}
          </ul>
          <div className="hidden overflow-x-auto rounded-xl border border-navy-100 bg-white sm:block">
            <table className="w-full text-sm" data-testid="approval-lines">
              <thead className="bg-navy-50 text-left text-xs uppercase tracking-wide text-navy-800"><tr><th className="px-3 py-2">Employee</th><th className="px-3 py-2 text-right">Hours</th><th className="px-3 py-2 text-right">Gross</th><th className="px-3 py-2 text-right">Deductions</th><th className="px-3 py-2 text-right">Employee taxes</th><th className="px-3 py-2 text-right">Employer taxes</th><th className="px-3 py-2 text-right">Net</th></tr></thead>
              <tbody>
                {version.lines.map((l) => (
                  <tr key={l.id} className="border-t border-navy-100"><td className="px-3 py-2 font-medium text-navy-900">{l.employeeName}</td><td className="px-3 py-2 text-right">{hours(l.hoursHundredths)}</td><td className="px-3 py-2 text-right">{money(l.grossCents)}</td><td className="px-3 py-2 text-right">{money(l.deductionsCents)}</td><td className="px-3 py-2 text-right">{money(eeTax(l))}</td><td className="px-3 py-2 text-right">{money(l.employerTaxCents)}</td><td className="px-3 py-2 text-right font-semibold">{money(l.netPayCents)}</td></tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
      {!showDetail && <p className="text-xs text-slate-600">Per-employee figures aren&apos;t shown on your approval screen. Ask the office if you need them.</p>}
      <p className="text-xs text-slate-500">Version {version.number}. You can approve or deny; changes to hours, pay, taxes, deductions, employees or bank accounts are made by the office, which then sends a new version for approval.</p>
    </div>
  );
}

export function DecisionForm({ action }: { action: (prev: { error?: string; ok?: string } | null, fd: FormData) => Promise<{ error?: string; ok?: string } | null> }) {
  return (
    <ActionForm action={action} className="space-y-3 rounded-2xl border border-navy-100 bg-white p-4">
      <label className="block text-sm font-semibold text-navy-900">Comment (optional to approve, needed to deny)
        <textarea name="comment" rows={2} className="input mt-1 w-full" maxLength={1000} placeholder="e.g. Cara's overtime looks high" />
      </label>
      <div className="grid grid-cols-2 gap-3">
        <button type="submit" name="decision" value="APPROVED" className="rounded-xl bg-emerald-700 px-4 py-3 text-base font-bold text-white hover:bg-emerald-800">Approve Payroll</button>
        <button type="submit" name="decision" value="DENIED" className="rounded-xl border-2 border-red-700 px-4 py-3 text-base font-bold text-red-700 hover:bg-red-50">Deny Payroll</button>
      </div>
    </ActionForm>
  );
}
