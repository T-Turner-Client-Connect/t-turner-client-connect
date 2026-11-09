import Link from "next/link";
import { notFound } from "next/navigation";
import clsx from "clsx";
import { FileText } from "lucide-react";
import { ActionForm } from "@/components/action-form";
import { Badge, Button, Card, Field, Notice, PageHeader } from "@/components/ui";
import { HoursForm } from "@/components/payroll-taxes/hours-form";
import { Countdown, fmtDay, fmtWhen, OverdueFlag, QueueBadge, RemindersOffBanner, VersionTag } from "@/components/payroll-taxes/bits";
import { DELIVERY_LABEL, money } from "@/components/payroll/status";
import {
  assignCycleAction, clearErrorAction, flagErrorAction, manualTotalsAction, markHoursRequestedAction, markProcessedAction, markSubmittedAction, recordHoursAction, sendForApprovalAction, uploadPreviewAction,
} from "@/app/actions/payroll-taxes";
import { requirePayrollTaxPage } from "@/lib/payroll-taxes/access";
import { cycleDetail, payrollTaxSettings } from "@/lib/services/payroll-taxes";
import { cycleAdpStatus } from "@/lib/services/adp-run";
import { cycleFileAction, fileImportedAction } from "@/app/actions/adp-run";
import { downloadToken } from "@/lib/services/documents";
import { ForbiddenError } from "@/lib/auth/actor";
import { CHANGE_FLAGS, OTHER_PAY, REMINDER_STEPS, type OtherPayKind } from "@/lib/payroll/queue";
import { employeeTaxes } from "@/lib/payroll/register";
import { RUN_STATUS } from "@/lib/payroll/fields";

export const metadata = { title: "Pay cycle" };

const input = "w-full rounded-lg border border-ivory-200 px-3 py-2 text-sm focus:border-navy-700 focus:outline-none";
const ymd = (d: Date) => d.toISOString().slice(0, 10);
const payLines = (pay?: Partial<Record<OtherPayKind, number>>) =>
  Object.entries(pay ?? {}).map(([k, v]) => { const def = OTHER_PAY[k as OtherPayKind]; return `${def.label}: ${def.unit === "HOURS" ? `${v} hrs` : `$${Number(v).toFixed(2)}`}`; });

export default async function CyclePage({ params }: { params: Promise<{ cycleId: string }> }) {
  const { actor, access } = await requirePayrollTaxPage();
  const { cycleId } = await params;
  const d = await cycleDetail(actor, cycleId).catch((e) => {
    if (e instanceof ForbiddenError) notFound();
    throw e;
  });
  const settings = await payrollTaxSettings();
  const adp = await cycleAdpStatus(actor, cycleId);
  const { cycle, run, version, row, canManage } = d;
  const name = cycle.client.businessName || cycle.client.displayName;
  const docLink = (id: string) => `/api/documents/${downloadToken(id, { staffId: actor.id })}`;
  const docTitle = (id: string | null) => d.docs.find((x) => x.id === id)?.title ?? "Document";
  const currentRound = run ? d.approvals.filter((a) => a.round === run.approvalRound && a.versionId === run.currentVersionId) : [];
  const lastDenial = run ? [...d.approvals].reverse().find((a) => a.decision === "DENIED") : null;
  const assignee = cycle.assignedStaffId ?? cycle.schedule.assignedStaffId;
  const status = row.status;
  const locked = !!cycle.processedAt || run?.status === "SUBMITTED" || run?.status === "PROVIDER_ACCEPTED" || run?.status === "PROCESSED";

  return (
    <>
      <PageHeader
        title={`${name} — pay date ${fmtDay(ymd(cycle.payDate))}`}
        subtitle={<Link href="/payroll-taxes" className="underline">← ADP Payroll &amp; Taxes</Link>}
        actions={<span className="flex flex-wrap items-center gap-2">{row.overdue && <OverdueFlag />}<QueueBadge status={status} />{version && <VersionTag n={version.number} />}</span>}
      />
      {!settings.clientRemindersAuthorized && <RemindersOffBanner isOwner={access.isOwner} />}

      <section className="mb-4 grid gap-2 sm:grid-cols-5" data-testid="cycle-deadlines">
        {[
          ["Pay period", `${fmtDay(ymd(cycle.periodStart))} – ${fmtDay(ymd(cycle.periodEnd))}`],
          ["Hours due", fmtDay(ymd(cycle.hoursDueDate))],
          ["Client approval due", fmtDay(ymd(cycle.approvalDueDate))],
          ["ADP processing cutoff", fmtDay(ymd(cycle.adpCutoffDate))],
          ["Pay date", fmtDay(ymd(cycle.payDate))],
        ].map(([k, v]) => (
          <div key={k} className="rounded-xl border border-ivory-200 bg-white px-3 py-2">
            <p className="text-xs font-semibold text-slate-500">{k}</p>
            <p className="font-semibold text-navy-900">{v}</p>
          </div>
        ))}
      </section>
      <p className="mb-4 text-sm text-slate-700">Next: <strong>{row.item}</strong>{row.deadline && <> by {fmtDay(row.deadline)} (<Countdown days={row.daysLeft} overdue={row.overdue} />)</>}. Assigned to <strong>{assignee ? d.names.get(assignee) ?? "a former staff member" : "nobody yet"}</strong>{cycle.assignedStaffId ? " (this cycle only)" : ""}.</p>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="1. Hours from the client">
          {cycle.hoursSubmittedAt && d.hours ? (
            <div className="mb-3 rounded-xl border border-emerald-200 bg-emerald-50 p-3 text-sm" data-testid="hours-received">
              <p className="font-semibold text-emerald-900">Received {fmtWhen(cycle.hoursSubmittedAt)}{d.hoursBy ? ` from ${d.hoursBy}` : ""}</p>
              {d.hours.noChanges ? <p>No changes — same as last period.</p> : (
                <table className="mt-2 w-full text-xs"><thead className="text-left text-slate-600"><tr><th>Employee</th><th>Regular</th><th>Overtime</th><th>Notes</th></tr></thead>
                  <tbody>{d.hours.employees.map((e, i) => <tr key={i}><td>{e.name}</td><td>{e.regularHours}</td><td>{e.overtimeHours}</td><td>{[e.notes, ...payLines(e.pay)].filter(Boolean).join(" · ")}</td></tr>)}</tbody></table>
              )}
              {d.hours.flags.length > 0 && <p className="mt-2 flex flex-wrap gap-1">{d.hours.flags.map((f) => <Badge key={f} tone="amber">{CHANGE_FLAGS[f]}</Badge>)}</p>}
              {d.hours.notes && <p className="mt-2 text-slate-700">“{d.hours.notes}”</p>}
            </div>
          ) : (
            <p className="mb-3 text-sm text-slate-600">{cycle.hoursRequestedAt ? `Requested ${fmtWhen(cycle.hoursRequestedAt)}. Waiting on the client.` : `Hours are requested on ${fmtDay(ymd(cycle.hoursRequestDate))}.`}</p>
          )}
          {canManage && !locked && (!run || run.status === "DRAFT") && (
            <details className="rounded-xl border border-ivory-200 p-3" open={!cycle.hoursSubmittedAt}>
              <summary className="cursor-pointer text-sm font-semibold text-navy-900">{cycle.hoursSubmittedAt ? "Replace the hours" : "Record hours the client gave you"}</summary>
              <div className="mt-3"><HoursForm action={recordHoursAction.bind(null, cycle.id)} initial={d.hours} submitLabel="Record hours" /></div>
              {!cycle.hoursRequestedAt && !cycle.hoursSubmittedAt && (
                <ActionForm action={markHoursRequestedAction.bind(null, cycle.id)} className="mt-3">
                  <Button type="submit" variant="ghost" className="text-xs">I asked for hours by phone / email (record it — sends nothing)</Button>
                </ActionForm>
              )}
            </details>
          )}
        </Card>

        <Card title={<span className="flex items-center gap-2">2. Preview workup {version && <VersionTag n={version.number} />}</span>}>
          {version ? (
            <div className="mb-3 space-y-2 text-sm" data-testid="current-version">
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                {[["Employees", String(version.employees)], ["Gross", money(version.grossCents)], ["Employee taxes", money(employeeTaxes(version))], ["Net pay", money(version.netPayCents)], ["Deductions", money(version.deductionsCents)], ["Employer taxes", money(version.employerTaxCents)], ["Total cost", money(version.grossCents + version.employerTaxCents)], ["Run status", run!.status === "AWAITING_APPROVAL" && (d.delivery === "NOT_SENT" || d.delivery === "FAILED") ? DELIVERY_LABEL[d.delivery] : RUN_STATUS[run!.status as keyof typeof RUN_STATUS] ?? run!.status]].map(([k, v]) => (
                  <div key={k} className="rounded-lg bg-ivory-100 px-2 py-1.5"><p className="text-[11px] text-slate-500">{k}</p><p className="font-semibold text-navy-900">{v}</p></div>
                ))}
              </div>
              {version.documentId ? (
                <a href={docLink(version.documentId)} className="inline-flex items-center gap-1.5 font-semibold text-navy-900 underline" data-testid="preview-doc"><FileText className="size-4" aria-hidden /> {docTitle(version.documentId)} (v{version.number})</a>
              ) : <p className="text-xs text-amber-800">No ADP preview PDF attached to v{version.number}.</p>}
              {d.employeeDetail ? (
                version.lines.length > 0 && (
                  <details><summary className="cursor-pointer text-xs font-semibold text-navy-900">Employee detail ({version.lines.length})</summary>
                    <ul className="mt-1 text-xs text-slate-700">{version.lines.map((l) => <li key={l.id}>{l.employeeName}: {money(l.grossCents)} gross, {money(l.netPayCents)} net</li>)}</ul>
                  </details>
                )
              ) : <p className="text-xs text-slate-500">Employee-level detail is shown to Admins and the client&apos;s assigned bookkeeper (the same rule as the client&apos;s Payroll &amp; ADP screen).</p>}
              <ol className="mt-2 space-y-1 border-l-2 border-ivory-200 pl-3 text-xs text-slate-700" data-testid="versions">
                {d.versions.map((v) => (
                  <li key={v.id} className={clsx(v.id === version.id && "font-semibold text-navy-900")}>v{v.number} · {fmtWhen(v.createdAt)} · {money(v.grossCents)} gross{v.documentId ? ` · ${docTitle(v.documentId)}` : ""}{v.reason ? ` — ${v.reason}` : ""}</li>
                ))}
              </ol>
            </div>
          ) : <p className="mb-3 text-sm text-slate-600">No preview yet. Upload ADP&apos;s preview, import the register, or key in the totals.</p>}
          {canManage && !locked && (
            <div className="space-y-3">
              {(status === "NEEDS_CORRECTION" || status === "CHANGES_REQUESTED") && <Notice tone="error" title={status === "CHANGES_REQUESTED" ? "Changes Requested" : "Needs correction"}>{cycle.errorFlaggedAt ? `Flagged by staff: ${cycle.errorNote}` : lastDenial ? `${lastDenial.approverName} denied v${lastDenial.version.number}: “${lastDenial.comment}”` : ""} Fix it in ADP, then attach the revised preview (it becomes the next version) and send it again.</Notice>}
              <details className="rounded-xl border border-ivory-200 p-3" open={!run}>
                <summary className="cursor-pointer text-sm font-semibold text-navy-900">{run ? "Attach a revised ADP preview (PDF)" : "Upload ADP's preview or register"}</summary>
                <ActionForm action={uploadPreviewAction.bind(null, cycle.id)} className="mt-3 space-y-2" resetOnSuccess>
                  <input type="file" name="file" accept=".pdf,.csv,.xlsx,application/pdf" required className="block w-full text-sm" data-testid="preview-file" />
                  <p className="text-xs text-slate-600">PDF: kept in the client&apos;s file (staff only) and shown to the approvers with this version. CSV / .xlsx: imported with the existing ADP register import (ADP RUN / Workforce Now layouts).</p>
                  {!run && (
                    <select name="preset" defaultValue={d.profile?.payrollSystem === "ADP_WFN" ? "ADP_WFN" : "ADP_RUN"} className={input}>
                      <option value="ADP_RUN">ADP RUN register</option>
                      <option value="ADP_WFN">ADP Workforce Now register</option>
                    </select>
                  )}
                  <Button type="submit" variant="secondary">Upload</Button>
                </ActionForm>
              </details>
              <details className="rounded-xl border border-ivory-200 p-3">
                <summary className="cursor-pointer text-sm font-semibold text-navy-900">{run ? "Key in corrected totals" : "Key in totals from ADP's preview"}</summary>
                <ActionForm action={manualTotalsAction.bind(null, cycle.id)} className="mt-3 grid gap-2 sm:grid-cols-2">
                  <Field label="Employees paid"><input name="employees" type="number" min={1} required defaultValue={version?.employees ?? ""} className={input} /></Field>
                  <Field label="Total hours"><input name="hours" inputMode="decimal" defaultValue={version ? version.hoursHundredths / 100 : ""} className={input} /></Field>
                  <Field label="Gross wages"><input name="gross" inputMode="decimal" required defaultValue={version ? (version.grossCents / 100).toFixed(2) : ""} className={input} /></Field>
                  <Field label="Employee taxes withheld"><input name="employeeTaxes" inputMode="decimal" defaultValue={version ? (employeeTaxes(version) / 100).toFixed(2) : ""} className={input} /></Field>
                  <Field label="Deductions"><input name="deductions" inputMode="decimal" defaultValue={version ? (version.deductionsCents / 100).toFixed(2) : ""} className={input} /></Field>
                  <Field label="Net pay"><input name="net" inputMode="decimal" required defaultValue={version ? (version.netPayCents / 100).toFixed(2) : ""} className={input} /></Field>
                  <Field label="Employer taxes"><input name="employerTaxes" inputMode="decimal" defaultValue={version ? (version.employerTaxCents / 100).toFixed(2) : ""} className={input} /></Field>
                  <Field label="ADP preview PDF (optional)"><input type="file" name="file" accept=".pdf,application/pdf" className="block w-full text-sm" /></Field>
                  <Field label="What changed (for the version history)" className="sm:col-span-2"><input name="reason" className={input} placeholder={run ? "Corrected the bonus per the client" : "Totals from ADP's payroll preview"} /></Field>
                  <div className="sm:col-span-2"><Button type="submit" variant="secondary">{run ? `Save as v${(version?.number ?? 0) + 1}` : "Save as v1"}</Button></div>
                </ActionForm>
              </details>
            </div>
          )}
        </Card>

        <Card title="3. Client approval">
          {!d.approvers.all.length ? <Notice tone="warn">No payroll approvers are set for this business. The owner chooses them in Owner&apos;s Office → Payroll approvers.</Notice> : (
            <ul className="mb-3 space-y-1.5 text-sm" data-testid="approver-status">
              {d.approvers.all.map((a) => {
                const dec = currentRound.find((x) => x.portalUserId === a.portalUserId);
                const req = d.approvers.required.some((r) => r.portalUserId === a.portalUserId);
                return (
                  <li key={a.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-ivory-200 px-3 py-1.5">
                    <span className="font-semibold text-navy-900">{a.portalUser.name}{req && <span className="ml-1 text-xs font-normal text-slate-500">(required)</span>}</span>
                    <span className={clsx("text-xs font-semibold", dec?.decision === "APPROVED" ? "text-emerald-700" : dec?.decision === "DENIED" ? "text-red-700" : "text-slate-600")}>
                      {dec ? `${dec.decision === "APPROVED" ? "Approved" : "Denied"} v${dec.version.number} · round ${dec.round} · ${fmtWhen(dec.createdAt)}` : run?.status === "AWAITING_APPROVAL" ? `Waiting · round ${run.approvalRound}` : "—"}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
          {d.approvals.length > 0 && (
            <details className="mb-3 text-xs text-slate-700"><summary className="cursor-pointer font-semibold text-navy-900">Every decision ({d.approvals.length})</summary>
              <ul className="mt-1 space-y-0.5">{d.approvals.map((a) => <li key={a.id}>{fmtWhen(a.createdAt)} — {a.approverName} {a.decision === "APPROVED" ? "approved" : "denied"} v{a.version.number} (round {a.round}, {a.channel === "PORTAL" ? "portal" : "secure link"}){a.comment ? `: “${a.comment}”` : ""}</li>)}</ul>
            </details>
          )}
          {canManage && run && (run.status === "DRAFT" || run.status === "DENIED") && !locked && (
            <ActionForm action={sendForApprovalAction.bind(null, cycle.id)} confirm={`Send v${version?.number} to ${name}'s payroll approvers? This starts a new approval round.`}>
              <Button type="submit" variant="gold">{run.approvalRound > 0 ? `Send revised preview (v${version?.number})` : `Send for client approval (v${version?.number})`}</Button>
            </ActionForm>
          )}
          {canManage && !locked && (
            cycle.errorFlaggedAt ? (
              <ActionForm action={clearErrorAction.bind(null, cycle.id)} className="mt-3"><Button type="submit" variant="ghost" className="text-xs">Clear the error flag</Button></ActionForm>
            ) : (
              <details className="mt-3 text-sm"><summary className="cursor-pointer font-semibold text-red-700">Flag an error</summary>
                <ActionForm action={flagErrorAction.bind(null, cycle.id)} className="mt-2 space-y-2"><input name="note" required placeholder="What needs correcting?" className={input} /><Button type="submit" variant="danger">Flag — needs correction</Button></ActionForm>
              </details>
            )
          )}
        </Card>

        <Card title="4. ADP">
          {cycle.processedAt ? (
            <div className="space-y-1 text-sm" data-testid="processed">
              <p className="font-semibold text-emerald-800">Processed {fmtWhen(cycle.processedAt)}{cycle.processedById ? ` · recorded by ${d.names.get(cycle.processedById) ?? "staff"}` : ""}</p>
              {cycle.confirmationDocumentId && <a href={docLink(cycle.confirmationDocumentId)} className="inline-flex items-center gap-1.5 font-semibold text-navy-900 underline"><FileText className="size-4" aria-hidden /> {docTitle(cycle.confirmationDocumentId)}</a>}
              {cycle.confirmationNote && <p className="text-slate-700">{cycle.confirmationNote}</p>}
            </div>
          ) : run?.status === "SUBMITTED" || run?.status === "PROVIDER_ACCEPTED" ? (
            <>
              <p className="mb-2 text-sm text-slate-700">Submitted in ADP {run.submittedAt ? fmtWhen(run.submittedAt) : ""}. When ADP confirms, attach its confirmation or payroll summary.</p>
              {canManage && (
                <ActionForm action={markProcessedAction.bind(null, cycle.id)} className="space-y-2">
                  <input type="file" name="file" accept=".pdf,application/pdf" required className="block w-full text-sm" data-testid="confirmation-file" />
                  <input name="note" placeholder="Confirmation details (optional), e.g. ADP confirmation number" className={input} />
                  <Button type="submit">Mark processed</Button>
                </ActionForm>
              )}
            </>
          ) : run?.status === "FULLY_APPROVED" ? (
            canManage ? (
              <ActionForm action={markSubmittedAction.bind(null, cycle.id)} className="space-y-2" confirm="Record that you submitted this payroll in ADP? Client Connect doesn't submit anything to ADP.">
                <p className="text-sm text-slate-700">Every required approver approved v{version?.number}. Submit it in ADP yourself, then record it here.</p>
                <input name="note" placeholder="Note (optional)" className={input} />
                <Button type="submit" variant="gold">Mark submitted in ADP</Button>
              </ActionForm>
            ) : <p className="text-sm text-slate-700">Ready to process in ADP.</p>
          ) : <p className="text-sm text-slate-600">After every required approver approves the current version, the office submits it in ADP and records it here. Nothing is submitted automatically.</p>}
        </Card>
      </div>

      <Card title="ADP RUN import (Time Sheet Import)" className="mt-4">
        <div data-testid="adp-csv">
          {!adp.allowed ? (
            <p className="text-sm text-slate-700">ADP setup and files for this business are available only to staff assigned to it (or given All clients by the owner).</p>
          ) : !adp.setupReady ? (
            <p className="text-sm text-slate-700">Download ADP CSV turns on after this business&apos;s one-time setup. Still to do: {adp.missing.join("; ")}. <Link href={`/payroll-taxes/schedules/${cycle.clientId}/adp`} className="font-semibold underline">Open ADP RUN import setup</Link></p>
          ) : adp.processed ? (
            <p className="text-sm text-slate-700">This payroll is processed.</p>
          ) : !adp.hoursIn ? (
            <p className="text-sm text-slate-700">Enter or receive this period&apos;s hours first (step 1). They&apos;re entered once here and go into the file as they are.</p>
          ) : adp.noChanges ? (
            <p className="text-sm text-slate-700">“No changes — same as last period”: RUN&apos;s standard hours apply, so no file is needed.</p>
          ) : (
            <div className="space-y-3 text-sm">
              {adp.active && (
                <div className="rounded-lg border border-ivory-200 bg-ivory-50 p-3">
                  <p className="font-semibold text-navy-900">{adp.active.fileName}</p>
                  <p className="text-xs text-slate-600">{adp.active.employees} employees · {adp.active.rows} rows · {(adp.active.hoursHundredths / 100).toFixed(2)} hours{adp.active.dollarsCents ? ` · $${(adp.active.dollarsCents / 100).toFixed(2)} other pay` : ""} · downloaded {adp.active.downloads}×{adp.active.importedAt ? ` · imported into RUN ${fmtWhen(adp.active.importedAt)}` : ""}</p>
                  {adp.active.importedAt && <p className="mt-1 text-xs font-semibold text-amber-800">Already imported into RUN — don&apos;t import it again.</p>}
                  {canManage && !adp.active.importedAt && adp.active.downloads > 0 && (
                    <ActionForm action={fileImportedAction.bind(null, adp.active.id)} className="mt-2" confirm="Record that you imported this file in RUN (Home > Time Sheet Import)?">
                      <Button type="submit" variant="secondary">I imported it into RUN</Button>
                    </ActionForm>
                  )}
                </div>
              )}
              {adp.check && (
                <div data-testid="adp-transfer-check" className="space-y-2">
                  {adp.check.ok ? (
                    <>
                      <p className="text-xs font-semibold text-emerald-800">Everything entered transfers to ADP:</p>
                      <table className="w-full text-left text-xs"><thead><tr className="text-slate-500"><th>Employee</th><th>Pay</th><th>ADP code</th><th>Amount</th></tr></thead>
                        <tbody>{adp.check.lines.map((l, i) => <tr key={i}><td>{l.name}</td><td>{l.label}</td><td>{l.code}</td><td>{l.amount}</td></tr>)}</tbody></table>
                    </>
                  ) : (
                    <Notice tone="warn" title="Not ready to download">
                      {adp.check.cannotTransfer.length > 0 && (<><p className="font-semibold">Can&apos;t transfer:</p><ul className="list-disc pl-4">{adp.check.cannotTransfer.map((c) => <li key={c}>{c}</li>)}</ul></>)}
                      {adp.check.problems.length > 0 && <ul className="mt-1 list-disc pl-4">{adp.check.problems.map((c) => <li key={c}>{c}</li>)}</ul>}
                    </Notice>
                  )}
                </div>
              )}
              {canManage && adp.check?.ok !== false && (
                <ActionForm action={cycleFileAction.bind(null, cycle.id)} className="space-y-2">
                  {adp.active?.importedAt && <input name="replaceReason" placeholder="Only if the hours changed after import: why (delete the old pay data file in RUN first)" className={input} />}
                  <Button type="submit" variant="gold">Download ADP CSV</Button>
                </ActionForm>
              )}
              <p className="text-xs text-slate-600">In RUN: Home &gt; Time Sheet Import → Browse → Import Pay Data → review Pay Data Approval. Use “Accept Import Only” unless you also entered hours in RUN&apos;s Payroll Worksheet. Then review and submit payroll in RUN as usual.</p>
            </div>
          )}
        </div>
      </Card>

      {canManage && (
        <Card title="Assignment for this pay cycle" className="mt-4">
          <ActionForm action={assignCycleAction.bind(null, cycle.id)} className="flex flex-wrap items-end gap-2">
            <select name="staffId" defaultValue={cycle.assignedStaffId ?? ""} className="rounded-lg border border-ivory-200 px-3 py-2 text-sm" aria-label="Assigned staff for this cycle">
              <option value="">Use the schedule&apos;s ({cycle.schedule.assignedStaffId ? d.names.get(cycle.schedule.assignedStaffId) ?? "former staff" : "unassigned"})</option>
              {d.staff.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
            <Button type="submit" variant="secondary">Save</Button>
          </ActionForm>
        </Card>
      )}

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <Card title="Timeline">
          {!d.events.length ? <p className="text-sm text-slate-600">Nothing yet.</p> : (
            <ol className="space-y-1 text-xs text-slate-700" data-testid="timeline">{d.events.map((e) => <li key={e.id}>{fmtWhen(e.createdAt)} — <strong>{e.kind.replace(/_/g, " ").toLowerCase()}</strong>{e.versionNumber ? ` v${e.versionNumber}` : ""}{e.actorName ? ` · ${e.actorName}` : ""}{e.note ? ` — ${e.note}` : ""}</li>)}</ol>
          )}
        </Card>
        <Card title="Reminders">
          {!d.reminders.length ? <p className="text-sm text-slate-600">No reminders yet.</p> : (
            <ul className="space-y-1 text-xs text-slate-700" data-testid="reminders">{d.reminders.map((r) => <li key={r.id}>{fmtWhen(r.createdAt)} — {REMINDER_STEPS[r.step.split(":")[0] as keyof typeof REMINDER_STEPS]?.label ?? r.step}{r.round ? ` (round ${r.round})` : ""} · {r.channel.toLowerCase()} · <strong className={r.status === "HELD" ? "text-amber-800" : r.status === "SENT" ? "text-emerald-700" : "text-slate-700"}>{r.status.toLowerCase()}</strong>{r.detail ? ` — ${r.detail}` : ""}</li>)}</ul>
          )}
        </Card>
      </div>
    </>
  );
}
