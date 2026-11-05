import Link from "next/link";
import { notFound } from "next/navigation";
import { ActionForm } from "@/components/action-form";
import { Badge, Button, Card, Field, Notice, PageHeader } from "@/components/ui";
import { fmtDay, RemindersOffBanner } from "@/components/payroll-taxes/bits";
import { saveScheduleAction } from "@/app/actions/payroll-taxes";
import { requirePayrollTaxPage } from "@/lib/payroll-taxes/access";
import { payrollTaxSettings, scheduleForm } from "@/lib/services/payroll-taxes";
import { ForbiddenError } from "@/lib/auth/actor";
import { FREQUENCIES, OFFSET_LABELS } from "@/lib/payroll/schedule";

export const metadata = { title: "Payroll schedule" };

const input = "w-full rounded-lg border border-ivory-200 px-3 py-2 text-sm focus:border-navy-700 focus:outline-none disabled:bg-ivory-100";

export default async function ScheduleEditor({ params }: { params: Promise<{ clientId: string }> }) {
  const { actor, access } = await requirePayrollTaxPage();
  const { clientId } = await params;
  const form = await scheduleForm(actor, clientId).catch((e) => {
    if (e instanceof ForbiddenError) notFound();
    throw e;
  });
  const settings = await payrollTaxSettings();
  const p = form.prefill;
  const ro = !form.canManage;
  return (
    <>
      <PageHeader title={`Payroll schedule — ${form.client.name}`} subtitle={<Link href="/payroll-taxes?tab=payroll&f=all" className="underline">← ADP Payroll &amp; Taxes</Link>} />
      {!settings.clientRemindersAuthorized && <RemindersOffBanner isOwner={access.isOwner} />}
      {form.fromProfile && <div className="mb-4"><Notice tone="info">Prefilled from this client&apos;s Bookkeeping profile (payroll frequency and known pay date). Check it, then save.</Notice></div>}
      {!form.client.payroll && <div className="mb-4"><Notice tone="warn">Payroll isn&apos;t turned on in this client&apos;s Bookkeeping settings, so ADP register imports won&apos;t work until it is. Keyed-in totals and PDFs still work.</Notice></div>}
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)]">
        <Card title="Schedule">
          <ActionForm action={saveScheduleAction.bind(null, clientId)} className="space-y-4">
            <fieldset disabled={ro} className="space-y-4">
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="How often payroll runs">
                  <select name="frequency" defaultValue={p.frequency} className={input} data-testid="frequency">
                    {Object.entries(FREQUENCIES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                  </select>
                </Field>
                <Field label="A known pay date" hint="Weekly, every two weeks and monthly pay dates follow from it.">
                  <input type="date" name="anchorPayDate" defaultValue={p.anchorPayDate} required className={input} />
                </Field>
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="Twice a month: first pay day" hint="Day of the month (1–31).">
                  <input type="number" name="semi1" min={1} max={31} defaultValue={p.semiMonthlyDays[0]} className={input} />
                </Field>
                <Field label="Twice a month: second pay day" hint="31 means the last day of the month.">
                  <input type="number" name="semi2" min={1} max={31} defaultValue={p.semiMonthlyDays[1]} className={input} />
                </Field>
              </div>
              <div className="rounded-xl border border-ivory-200 bg-ivory-50 p-3">
                <p className="mb-2 text-sm font-semibold text-navy-900">Deadlines before each pay date</p>
                <p className="mb-3 text-xs text-slate-600">Business days. A pay date on a weekend or US federal holiday moves to the business day before it, and so does every deadline — always earlier, never later.</p>
                <div className="grid gap-3 sm:grid-cols-2">
                  {(["hoursRequestLeadDays", "hoursDueDays", "approvalDueDays", "adpCutoffDays", "periodEndLagDays"] as const).map((k) => (
                    <Field key={k} label={OFFSET_LABELS[k]}>
                      <input type="number" name={k} min={0} max={k === "periodEndLagDays" ? 31 : 20} defaultValue={p[k]} required className={input} />
                    </Field>
                  ))}
                </div>
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="Assigned staff member" hint="Can be changed for a single pay cycle on the cycle page.">
                  <select name="assignedStaffId" defaultValue={p.assignedStaffId ?? ""} className={input}>
                    <option value="">Unassigned</option>
                    {form.staff.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                  </select>
                </Field>
                <div className="space-y-2 pt-6 text-sm">
                  <label className="flex items-center gap-2"><input type="checkbox" name="active" defaultChecked={p.active} className="size-4 accent-[#0a1a44]" /> Active (generate pay cycles)</label>
                  <label className="flex items-center gap-2"><input type="checkbox" name="clientRemindersEnabled" defaultChecked={p.clientRemindersEnabled} className="size-4 accent-[#0a1a44]" data-testid="client-reminders" /> Automated reminders to this client</label>
                  <p className="text-xs text-slate-600">Reminders also need the owner&apos;s “Payroll &amp; tax client reminders authorized” switch{settings.clientRemindersAuthorized ? " (on)." : " — currently off, so they're held."}</p>
                </div>
              </div>
              <Field label="Notes (office only)">
                <textarea name="notes" rows={2} defaultValue={p.notes} className={input} />
              </Field>
            </fieldset>
            {ro ? <Notice tone="info">You have view-only access to ADP Payroll &amp; Taxes.</Notice> : <Button type="submit">Save schedule</Button>}
            <p className="text-xs text-slate-600">Saving creates the next 6 weeks of pay cycles. It sends nothing.</p>
          </ActionForm>
        </Card>
        <Card title="Next 6 weeks">
          {!form.preview.length ? <p className="text-sm text-slate-600">Enter a known pay date to see the upcoming cycles.</p> : (
            <ul className="space-y-2 text-sm" data-testid="schedule-preview">
              {form.preview.map((c) => (
                <li key={c.payDate} className="rounded-lg border border-ivory-200 px-3 py-2">
                  <p className="font-semibold text-navy-900">Pay date {fmtDay(c.payDate)} {c.payDate !== c.nominalPayDate && <Badge tone="amber">moved from {fmtDay(c.nominalPayDate)}</Badge>}</p>
                  <p className="text-xs text-slate-600">Period {fmtDay(c.periodStart)} – {fmtDay(c.periodEnd)}</p>
                  <p className="mt-1 text-xs text-slate-700">Request hours {fmtDay(c.hoursRequestDate)} · Hours due {fmtDay(c.hoursDueDate)} · Approval due {fmtDay(c.approvalDueDate)} · ADP cutoff {fmtDay(c.adpCutoffDate)}</p>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </>
  );
}
