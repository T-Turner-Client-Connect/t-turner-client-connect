import { Field } from "@/components/ui";
import { FREQUENCIES, PAYROLL_FREQUENCIES } from "@/lib/services/bookkeeping-clients";

const DAYS = Array.from({ length: 31 }, (_, i) => i + 1);

/** Schedule, assigned staff, payroll and due-day fields shared by both Add Bookkeeping Client forms. */
export function BookkeepingServiceFields({ staff, assignedDefault = "", canAssign }: { staff: { id: string; name: string }[]; assignedDefault?: string; canAssign: boolean }) {
  return (
    <>
      <Field label="Service schedule">
        <select className="input" name="frequency" defaultValue="MONTHLY" required>
          {Object.entries(FREQUENCIES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
      </Field>
      {canAssign ? (
        <Field label="Assigned staff">
          <select className="input" name="assignedToId" defaultValue={assignedDefault}>
            <option value="">Keep as is</option>
            <option value="none">Unassigned</option>
            {staff.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </Field>
      ) : (
        <p className="self-end pb-2 text-xs text-slate-600">Assigned staff is set by an Admin.</p>
      )}
      <Field label="Accounts to collect" hint="Optional">
        <input className="input" name="accounts" placeholder="e.g. Regions business checking, Amex" />
      </Field>
      <fieldset className="rounded-xl border border-ivory-200 p-3 sm:col-span-3">
        <legend className="px-1 text-sm font-semibold">Payroll</legend>
        <div className="grid gap-2 sm:grid-cols-3">
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="payroll" /> Client runs payroll (adds payroll reports to each month)</label>
          <Field label="Payroll frequency">
            <select className="input" name="payrollFrequency" defaultValue=""><option value="">—</option>{Object.entries(PAYROLL_FREQUENCIES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
          </Field>
          <Field label="Payroll provider"><input className="input" name="payrollProvider" placeholder="e.g. Gusto, ADP" /></Field>
        </div>
      </fieldset>
      <Field label="Documents due (month after)" hint="Optional — no deadline if blank">
        <select className="input" name="documentsDueDay" defaultValue=""><option value="">No deadline</option>{DAYS.map((d) => <option key={d} value={d}>{d === 31 ? "Last day" : `Day ${d}`}</option>)}</select>
      </Field>
      <Field label="P&L target (month after)" hint="Blank = the office default, the 15th">
        <select className="input" name="reportsDueDay" defaultValue=""><option value="">Office default — the 15th</option>{DAYS.map((d) => <option key={d} value={d}>{d === 31 ? "Last day" : `Day ${d}`}</option>)}</select>
      </Field>
    </>
  );
}
