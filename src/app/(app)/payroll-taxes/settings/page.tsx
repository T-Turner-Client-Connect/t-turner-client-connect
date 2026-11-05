import Link from "next/link";
import { notFound } from "next/navigation";
import { ShieldAlert } from "lucide-react";
import { ActionForm } from "@/components/action-form";
import { Badge, Button, Card, Notice, PageHeader } from "@/components/ui";
import { fmtWhen, RemindersOffBanner } from "@/components/payroll-taxes/bits";
import { resetClientPlanAction, saveReminderPlanAction, sendTestAction, setRemindersAuthorizedAction } from "@/app/actions/payroll-taxes";
import { requirePayrollTaxPage } from "@/lib/payroll-taxes/access";
import { hasClientPlan, listSchedules, payrollTaxSettings, reminderPlan } from "@/lib/services/payroll-taxes";
import { prisma } from "@/lib/prisma";
import { CHANNELS, REMINDER_STEPS, type ReminderChannel, type ReminderStep } from "@/lib/payroll/queue";

export const metadata = { title: "Payroll reminder settings" };

function PlanForm({ steps, action }: { steps: ReminderStep[]; action: Parameters<typeof ActionForm>[0]["action"] }) {
  return (
    <ActionForm action={action} className="space-y-3">
      <div className="divide-y divide-ivory-200 rounded-xl border border-ivory-200" data-testid="reminder-plan">
        {steps.map((s) => {
          const def = REMINDER_STEPS[s.key];
          return (
            <div key={s.key} className="grid gap-2 px-3 py-3 sm:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)] sm:items-center">
              <div>
                <label className="flex items-center gap-2 font-semibold text-navy-900"><input type="checkbox" name={`${s.key}.enabled`} defaultChecked={s.enabled} className="size-4 accent-[#0a1a44]" /> {def.label} {def.audience === "STAFF" ? <Badge tone="navy">Staff only</Badge> : <Badge tone="gold">Client</Badge>}</label>
                <p className="ml-6 text-xs text-slate-600">
                  {s.hoursBefore !== null ? <><input type="number" name={`${s.key}.hoursBefore`} min={1} max={168} defaultValue={s.hoursBefore} className="w-16 rounded border border-ivory-200 px-1 py-0.5 text-xs" aria-label={`${def.label}: hours before`} /> {def.when.toLowerCase()}</> : def.when}
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                {(Object.entries(CHANNELS) as [ReminderChannel, string][]).filter(([c]) => !(def.audience === "STAFF" && c === "SMS")).map(([c, label]) => (
                  <label key={c} className="inline-flex items-center gap-1.5 rounded-full border border-ivory-200 px-2.5 py-1 text-xs font-semibold text-navy-900">
                    <input type="checkbox" name={`${s.key}.${c}`} defaultChecked={s.channels.includes(c)} className="size-3.5 accent-[#0a1a44]" /> {def.audience === "STAFF" && c === "PORTAL" ? "Task for the assigned staff" : label}
                  </label>
                ))}
              </div>
            </div>
          );
        })}
      </div>
      <p className="text-xs text-slate-600">Reminders stop as soon as the client acts (hours sent, or the approver decided). Each step goes once per pay cycle per person and channel. Messages never include amounts or employee names — only a short notice and a sign-in link.</p>
      <Button type="submit">Save plan</Button>
    </ActionForm>
  );
}

export default async function ReminderSettings({ searchParams }: { searchParams: Promise<{ client?: string }> }) {
  const { actor, access } = await requirePayrollTaxPage();
  if (access.level !== "MANAGE") notFound();
  const sp = await searchParams;
  const [settings, global, schedules] = await Promise.all([payrollTaxSettings(), reminderPlan("global"), listSchedules(actor)]);
  const client = schedules.find((s) => s.clientId === sp.client) ?? null;
  const clientPlan = client ? await reminderPlan(client.clientId) : null;
  const clientHasOwn = client ? await hasClientPlan(client.clientId) : false;
  const held = await prisma.payrollReminder.findMany({ where: { status: "HELD" }, orderBy: { createdAt: "desc" }, take: 10, include: { cycle: { select: { client: { select: { displayName: true, businessName: true } } } } } });
  return (
    <>
      <PageHeader title="Payroll reminder settings" subtitle={<Link href="/payroll-taxes" className="underline">← ADP Payroll &amp; Taxes</Link>} />
      {!settings.clientRemindersAuthorized && <RemindersOffBanner isOwner={access.isOwner} />}
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)]">
        <div className="space-y-4">
          <Card title={<span className="flex items-center gap-2"><ShieldAlert className="size-5 text-gold-600" aria-hidden /> Payroll &amp; tax client reminders authorized</span>}>
            <p className="mb-3 text-sm text-slate-700">
              Status: {settings.clientRemindersAuthorized ? <Badge tone="green">On</Badge> : <Badge tone="red">Off</Badge>}
              {settings.changedAt && <span className="ml-2 text-xs text-slate-500">changed {fmtWhen(settings.changedAt)}</span>}
            </p>
            <p className="mb-3 text-sm text-slate-600">While off, automated client reminders are recorded as <strong>held</strong> with the reason and never sent. Each client also needs its own reminders switch on (schedule page). Overdue alerts to staff are not affected.</p>
            {access.isOwner ? (
              <ActionForm action={setRemindersAuthorizedAction} confirm={settings.clientRemindersAuthorized ? "Turn automated client reminders off?" : "Authorize automated payroll reminders to clients whose own reminders switch is on? This is recorded in the owner audit log."}>
                <input type="hidden" name="on" value={settings.clientRemindersAuthorized ? "false" : "true"} />
                <Button type="submit" variant={settings.clientRemindersAuthorized ? "danger" : "gold"} data-testid="master-switch">{settings.clientRemindersAuthorized ? "Turn off client reminders" : "Authorize client reminders"}</Button>
              </ActionForm>
            ) : <Notice tone="info">Only the owner can change this switch.</Notice>}
          </Card>
          <Card title="Send test to office">
            <p className="mb-3 text-sm text-slate-600">Sends one sample hours-request email to the office&apos;s own address (Settings → Staff alerts). It never goes to a client.</p>
            <ActionForm action={sendTestAction}><Button type="submit" variant="secondary">Send test to office</Button></ActionForm>
          </Card>
          <Card title="Live ADP submission">
            <p className="text-sm text-slate-700">Status: <Badge tone="gray">Not available</Badge></p>
            <p className="mt-2 text-sm text-slate-600">Submitting pay data to ADP and checking that ADP processed it will need ADP&apos;s API approval, the client&apos;s authorization and the owner&apos;s switch — none of which exist yet. Until then, staff submit in ADP and record it here; “Processed” is recorded only with ADP&apos;s confirmation attached.</p>
          </Card>
          <Card title="Recently held">
            {!held.length ? <p className="text-sm text-slate-600">Nothing held.</p> : (
              <ul className="space-y-1 text-xs text-slate-700" data-testid="held-list">{held.map((h) => <li key={h.id}>{fmtWhen(h.createdAt)} — {h.cycle.client.businessName || h.cycle.client.displayName} · {REMINDER_STEPS[h.step.split(":")[0] as keyof typeof REMINDER_STEPS]?.label ?? h.step} · {h.channel.toLowerCase()}</li>)}</ul>
            )}
          </Card>
        </div>
        <div className="space-y-4">
          <Card title="Office-wide reminder plan">
            <PlanForm steps={global} action={saveReminderPlanAction.bind(null, "global")} />
          </Card>
          <Card title="One client's plan" actions={
            <form className="flex items-center gap-2">
              <select name="client" defaultValue={client?.clientId ?? ""} aria-label="Client" className="rounded-lg border border-ivory-200 px-2 py-1.5 text-sm">
                <option value="">Choose a client…</option>
                {schedules.map((s) => <option key={s.clientId} value={s.clientId}>{s.clientName}</option>)}
              </select>
              <button className="rounded-lg border border-ivory-200 px-3 py-1.5 text-sm font-semibold">Open</button>
            </form>
          }>
            {client && clientPlan ? (
              <>
                <p className="mb-3 text-sm text-slate-600">{clientHasOwn ? `${client.clientName} has its own plan.` : `${client.clientName} follows the office-wide plan. Saving here gives it its own.`}</p>
                <PlanForm steps={clientPlan} action={saveReminderPlanAction.bind(null, client.clientId)} />
                {clientHasOwn && <ActionForm action={resetClientPlanAction.bind(null, client.clientId)} className="mt-2"><Button type="submit" variant="ghost" className="text-xs">Use the office-wide plan again</Button></ActionForm>}
              </>
            ) : <p className="text-sm text-slate-600">Choose a client to give it its own steps or channels.</p>}
          </Card>
        </div>
      </div>
    </>
  );
}
