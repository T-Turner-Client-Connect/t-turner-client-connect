import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, LockKeyhole } from "lucide-react";
import { ActionForm } from "@/components/action-form";
import { Badge, Button, Card, Field, Notice, PageHeader, Stat } from "@/components/ui";
import { requireOffice } from "@/lib/auth/owner";
import { CADENCES, SCHEDULE_KINDS, SCHEDULE_STATUS, scheduleDetail, type Cadence, type ScheduleKind } from "@/lib/services/billing-schedules";
import { generateItemAction, scheduleDecisionAction, updateScheduleAction } from "@/app/actions/invoice-requests";
import { STATE_LABELS } from "@/lib/billing/labels";
import { money } from "@/lib/billing/pricing";
import { fmtDate, fmtDateTime } from "@/lib/format";
import { ymd } from "@/lib/services/owner-billing";

export const metadata = { title: "Billing schedule" };

const ACTION_TEXT: Record<string, string> = {
  "billing.schedule_proposed": "Proposed (awaiting Tabitha's approval)",
  "billing.schedule_created": "Created and approved by Tabitha",
  "billing.schedule_approved": "Approved by Tabitha",
  "billing.schedule_declined": "Declined",
  "billing.schedule_changed": "Changed (future invoices)",
  "billing.schedule_paused": "Paused",
  "billing.schedule_resumed": "Resumed",
  "billing.schedule_ended": "Ended",
  "billing.schedule_completed": "Finished (last invoice made)",
  "billing.schedule_cycle_created": "Invoice created as a draft",
  "billing.schedule_cycle_failed": "Couldn't create an invoice",
  "billing.schedule_item_generated": "Invoice made by staff",
};

export default async function SchedulePage({ params }: { params: Promise<{ id: string }> }) {
  const { actor } = await requireOffice("billing");
  const s = await scheduleDetail(actor, (await params).id);
  if (!s) notFound();
  const st = SCHEDULE_STATUS[s.status];
  const recurring = s.kind === "RECURRING";
  const open = s.status === "ACTIVE" || s.status === "PAUSED";
  return (
    <>
      <Link href="/owner/billing" className="mb-3 inline-flex items-center gap-2 text-sm font-semibold text-navy-900 underline decoration-gold-500 underline-offset-4"><ArrowLeft className="size-4" aria-hidden /> Billing dashboard</Link>
      <PageHeader
        title={`${SCHEDULE_KINDS[s.kind as ScheduleKind]} · ${s.clientName}`}
        subtitle={<><Link className="underline" href={`/clients/${s.clientId}?tab=invoices`}>{s.clientName}</Link> · {s.service} · <Badge tone={st.tone}>{st.label}</Badge></>}
      />
      {s.warnings.length > 0 && (
        <div className="mb-4"><Notice tone="warn" title="Other billing for this client">{s.warnings.map((w) => <span key={w.text} className="block">{w.text}</span>)}</Notice></div>
      )}
      {s.lastProblem && <div className="mb-4"><Notice tone="warn" title="Last run">{s.lastProblem}</Notice></div>}

      <div className="mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {recurring ? <Stat label="Each invoice" value={money(s.amountCents ?? 0)} hint={CADENCES[s.cadence as Cadence]?.label} /> : <Stat label="Plan total" value={money(s.totalCents ?? 0)} />}
        <Stat label="Paid" value={money(s.paidCents)} />
        {recurring ? <Stat label="Outstanding" value={money(s.outstandingCents)} /> : <Stat label="Remaining" value={money(s.remainingCents ?? 0)} />}
        <Stat label="Next invoice" value={s.nextDate ?? "—"} hint={s.nextAmountCents ? money(s.nextAmountCents) : undefined} />
      </div>

      <div className="grid gap-4 lg:grid-cols-[3fr_2fr]">
        <Card title="Invoices">
          <p className="mb-2 text-sm text-slate-600">{s.description}</p>
          <dl className="mb-3 grid gap-x-4 gap-y-1 text-sm sm:grid-cols-2">
            <div><dt className="inline text-slate-600">Starts: </dt><dd className="inline">{fmtDate(s.startDate)}</dd></div>
            {recurring && <div><dt className="inline text-slate-600">Invoice day: </dt><dd className="inline">{s.invoiceDay}</dd></div>}
            <div><dt className="inline text-slate-600">Due in: </dt><dd className="inline">{s.dueInDays} days</dd></div>
            {recurring && <div><dt className="inline text-slate-600">Ends: </dt><dd className="inline">{s.endDate ? fmtDate(s.endDate) : s.maxInvoices ? `after ${s.maxInvoices} invoices` : "No end date"}</dd></div>}
            <div><dt className="inline text-slate-600">Sending: </dt><dd className="inline">{s.autoSend ? "Automatically each cycle (only while live sending is on)" : "Draft for review each cycle"}</dd></div>
            <div><dt className="inline text-slate-600">Proposed by: </dt><dd className="inline">{s.proposedByName ?? "Staff"}{s.approvedByName ? ` · approved by ${s.approvedByName}` : ""}</dd></div>
          </dl>
          {s.items.length === 0 ? (
            <p className="text-sm text-slate-600">{s.status === "PROPOSED" ? "Nothing is invoiced until Tabitha approves it." : "No invoices yet."}</p>
          ) : (
            <ul className="divide-y divide-ivory-200 text-sm" data-testid="schedule-items">
              {s.items.map((it) => (
                <li key={it.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                  <span className="min-w-0">{it.label}<span className="block text-xs text-slate-600">{it.issueDate ? ymd(it.issueDate) : "When the work is done"} · {money(it.amountCents)}</span></span>
                  {it.invoice ? (
                    <span className="flex items-center gap-2"><Link className="font-semibold underline" href={`/owner/invoices/${it.invoice.id}`}>{it.invoice.number}</Link><Badge tone={it.invoice.state === "DRAFT" ? "gold" : "navy"}>{STATE_LABELS[it.invoice.state]?.label ?? it.invoice.state}</Badge></span>
                  ) : s.status === "ACTIVE" && s.mayGenerate ? (
                    <ActionForm action={generateItemAction.bind(null, s.id, it.periodKey)}><Button variant="secondary" type="submit">Create this invoice now</Button></ActionForm>
                  ) : (
                    <span className="text-xs text-slate-500">Not yet</span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </Card>

        <div className="space-y-4">
          <Card title={<span className="flex items-center gap-2"><LockKeyhole className="size-4 text-gold-600" aria-hidden /> Tabitha&apos;s decisions</span>}>
            {!s.mayAuthorize ? (
              <p className="text-sm text-slate-600" data-testid="owner-only-note">Only Tabitha can approve, change, pause, resume or end a schedule or payment plan.</p>
            ) : (
              <div className="space-y-3">
                {s.status === "PROPOSED" && (
                  <div className="flex flex-wrap gap-2">
                    <ActionForm action={scheduleDecisionAction.bind(null, s.id, "approve")}><Button type="submit" data-testid="approve-schedule">Approve</Button></ActionForm>
                    <ActionForm action={scheduleDecisionAction.bind(null, s.id, "decline")}><Button variant="secondary" type="submit">Decline</Button></ActionForm>
                  </div>
                )}
                {open && (
                  <div className="flex flex-wrap gap-2">
                    {s.status === "ACTIVE" ? <ActionForm action={scheduleDecisionAction.bind(null, s.id, "pause")}><Button variant="secondary" type="submit">Pause</Button></ActionForm> : <ActionForm action={scheduleDecisionAction.bind(null, s.id, "resume")}><Button variant="secondary" type="submit">Resume</Button></ActionForm>}
                    <ActionForm action={scheduleDecisionAction.bind(null, s.id, "end")} confirm="End this schedule? No more invoices will be made."><Button variant="ghost" type="submit">End</Button></ActionForm>
                  </div>
                )}
                {(open || s.status === "PROPOSED") && (
                  <ActionForm action={updateScheduleAction.bind(null, s.id)} className="grid gap-3 border-t border-ivory-200 pt-3 sm:grid-cols-2">
                    {recurring && <Field label="Future amount ($)"><input className="input" name="amount" inputMode="decimal" defaultValue={((s.amountCents ?? 0) / 100).toFixed(2)} /></Field>}
                    {recurring && (
                      <Field label="How often"><select className="input" name="cadence" defaultValue={s.cadence ?? "MONTHLY"}>{Object.entries(CADENCES).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}</select></Field>
                    )}
                    {recurring && <Field label="Invoice day"><input className="input" type="number" name="invoiceDay" min={1} max={28} defaultValue={s.invoiceDay} /></Field>}
                    <Field label="Due in (days)"><input className="input" type="number" name="dueInDays" min={0} max={120} defaultValue={s.dueInDays} /></Field>
                    {recurring && <Field label="End date (optional)"><input className="input" type="date" name="endDate" defaultValue={s.endDate ? ymd(s.endDate) : ""} /></Field>}
                    {recurring && <Field label="Number of invoices (optional)"><input className="input" type="number" name="maxInvoices" min={1} max={360} defaultValue={s.maxInvoices ?? ""} /></Field>}
                    {!recurring && <input type="hidden" name="maxInvoices" value={s.maxInvoices ?? ""} />}
                    <label className="flex items-start gap-2 text-sm sm:col-span-2"><input type="checkbox" name="autoSend" defaultChecked={s.autoSend} className="mt-0.5 size-4 accent-navy-900" data-testid="auto-send" /> <span><strong>Send automatically each cycle</strong><span className="block text-xs text-slate-600">Through the normal send path. Nothing goes out while live sending (or, for Square, Square sending) is off.</span></span></label>
                    <div className="sm:col-span-2"><Button type="submit" variant="secondary">Save changes for future invoices</Button></div>
                  </ActionForm>
                )}
              </div>
            )}
          </Card>
          <Card title="History">
            <ol className="space-y-1 text-sm">
              {s.history.map((h) => <li key={h.id}><span className="text-slate-600">{fmtDateTime(h.at)}</span> · {ACTION_TEXT[h.action] ?? h.action} · {h.who}</li>)}
            </ol>
          </Card>
        </div>
      </div>
    </>
  );
}
