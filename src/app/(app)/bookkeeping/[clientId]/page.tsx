import Link from "next/link";
import { connection } from "next/server";
import { notFound } from "next/navigation";
import { ActionForm } from "@/components/action-form";
import { Badge, Button, Card, Field, LinkButton, Notice, PageHeader } from "@/components/ui";
import {
  checklistItemAction, classifyDocumentAction, deliverApprovedAction, openPeriodForClientAction, reportStepAction, requestChangesAction, saveBookkeepingProfileAction, uploadBookkeepingFileAction, uploadMonthlyFinancialsAction,
} from "@/app/actions/bookkeeping-clients";
import { periodStatusAction, requestDocumentAction, staffMessageAction } from "@/app/actions/workspace";
import { requireUser } from "@/lib/auth/session";
import { prisma } from "@/lib/prisma";
import { BK_DOC_TYPES, bookkeepingWorkspace, FREQUENCIES, HISTORY_LABELS, isReportApprover, PAYROLL_FREQUENCIES, periodLabel, reportCaption, reportHistory, reportsDue, REVIEW_LABELS, STAGES, workMonth } from "@/lib/services/bookkeeping-clients";
import { BASIS, PERIOD_TYPES, reportPeriod, type PeriodType } from "@/lib/bookkeeping-periods";
import { accountLabel } from "@/lib/services/bookkeeping-profile";
import { packetsInPeriod } from "@/lib/services/financial-packet";
import { MONTHS, PERIOD_LABELS } from "@/lib/services/bookkeeping";
import { downloadToken, REPORT_LABELS } from "@/lib/services/documents";
import { ScanStatus } from "@/components/scan-status";
import { scanHealth } from "@/lib/services/documents";
import { fmtDate, fmtDateTime } from "@/lib/format";

export const metadata = { title: "Bookkeeping workspace" };

const WAITING = {
  WAITING_CLIENT: { text: "Waiting on client", tone: "amber" },
  RECEIVED: { text: "Received — staff to review", tone: "navy" },
  STAFF_TODO: { text: "Staff work", tone: "navy" },
  DONE: { text: "Done", tone: "green" },
  NOT_NEEDED: { text: "Not needed", tone: "gray" },
} as const;
const REVIEW_TONE: Record<string, "gray" | "gold" | "red" | "green"> = { DRAFT: "gray", AWAITING_REVIEW: "gold", CHANGES_REQUESTED: "red", APPROVED: "green" };

export default async function BookkeepingWorkspace({ params, searchParams }: { params: Promise<{ clientId: string }>; searchParams: Promise<{ period?: string; year?: string; month?: string }> }) {
  await connection();
  const user = await requireUser();
  const { clientId } = await params;
  const sp = await searchParams;
  if (!(await prisma.client.count({ where: { id: clientId } }))) notFound();
  // Year + month picker: go to that month if it's open, otherwise offer to open it.
  const picked = sp.year && sp.month ? { year: Number(sp.year), month: Number(sp.month) } : null;
  const pickedPeriod = picked ? await prisma.bookkeepingPeriod.findUnique({ where: { clientId_year_month: { clientId, year: picked.year, month: picked.month } }, select: { id: true } }).catch(() => null) : null;
  const notOpened = picked && !pickedPeriod && picked.month >= 1 && picked.month <= 12 ? picked : null;
  const [ws, approver, staff] = await Promise.all([
    bookkeepingWorkspace(clientId, pickedPeriod?.id ?? sp.period),
    isReportApprover(user),
    prisma.user.findMany({ where: { active: true }, select: { id: true, name: true }, orderBy: { name: "asc" } }),
  ]);
  const { client, profile, period, summary } = ws;
  const freq = profile?.frequency ?? "MONTHLY";
  const label = period ? periodLabel(freq, period.year, period.month) : null;
  const link = (id: string) => `/api/documents/${downloadToken(id, { staffId: user.id })}`;
  const work = workMonth(freq);
  const target = notOpened ?? (period ? { year: period.year, month: period.month } : work);
  const thisYear = new Date().getFullYear();
  const years = Array.from({ length: 8 }, (_, i) => thisYear + 1 - i);
  // Earlier versions of each report (kept as history), newest first.
  const history = (d: { replacesId: string | null }) => {
    const out = [];
    let id = d.replacesId;
    while (id && out.length < 50) {
      const prev = period?.documents.find((x) => x.id === id);
      if (!prev) break;
      out.push(prev);
      id = prev.replacesId;
    }
    return out;
  };
  const statements = period?.documents.filter((d) => !(d.category === "BOOKKEEPING" && d.reportType)) ?? [];
  const byKind = (k: string) => statements.filter((d) => d.docType === k);
  const unlabeled = statements.filter((d) => !d.docType || !(d.docType in BK_DOC_TYPES));
  const conversations = period ? period.conversations : [];
  const [accounts, fiscal] = await Promise.all([
    prisma.bookkeepingAccount.findMany({ where: { clientId, active: true }, orderBy: { institution: "asc" } }),
    prisma.client.findUniqueOrThrow({ where: { id: clientId }, select: { fiscalYearEnd: true } }),
  ]);
  const packets = period ? await packetsInPeriod(period.id, { staff: true }) : [];
  const histories = new Map(await Promise.all((summary?.reports ?? []).map(async (d) => [d.id, await reportHistory(d.id)] as const)));
  const isAdminUser = user.role === "ADMIN";
  const health = await scanHealth();
  const otherThreads = await prisma.conversation.findMany({ where: { clientId, periodId: null }, orderBy: { lastMessageAt: "desc" }, take: 5, select: { id: true, subject: true, awaitingStaff: true, lastMessageAt: true } });

  const fileRow = (d: (typeof statements)[number]) => (
    <li key={d.id} className="flex flex-wrap items-center justify-between gap-2 py-1.5">
      <span>
        {d.scanStatus === "CLEAN" ? <a className="underline" href={link(d.id)} target="_blank" rel="noopener">{d.title}</a> : <span>{d.title}</span>}
        <span className="text-xs text-slate-500"> · {d.uploadedByPortal ? `client (${d.uploadedByPortal.name})` : d.uploadedByStaff?.name ?? "staff"} · {fmtDate(d.createdAt)}</span>
        <span className="ml-1"><ScanStatus doc={d} health={health} /></span>
      </span>
    </li>
  );

  return (
    <>
      <p className="mb-2 text-sm"><Link className="underline" href="/bookkeeping">← Bookkeeping Clients</Link></p>
      <PageHeader
        title={client.displayName}
        subtitle={
          <>
            {profile ? `${FREQUENCIES[freq as keyof typeof FREQUENCIES]} bookkeeping` : "Not on the bookkeeping list yet"} · Assigned: {client.assignedTo?.name ?? "unassigned"}
            {profile?.payroll && ` · Payroll ${profile.payrollFrequency ? PAYROLL_FREQUENCIES[profile.payrollFrequency as keyof typeof PAYROLL_FREQUENCIES].toLowerCase() : ""}${profile.payrollProvider ? ` (${profile.payrollProvider})` : ""}`}
            {" · "}<Link className="underline" href={`/clients/${clientId}`}>Client record</Link>
          </>
        }
        actions={
          <div className="flex flex-wrap gap-2">
            <LinkButton href={`/bookkeeping/${clientId}/profile`} variant="secondary" data-testid="business-profile-button">Business profile</LinkButton>
            <LinkButton href="#upload-financials" data-testid="upload-financials-button">Upload Monthly Financials</LinkButton>
          </div>
        }
      />
      {(!profile || !profile.active) && (
        <div className="mb-4">
          <Notice tone="warn" title={profile ? "Bookkeeping is paused for this client" : "Not a Bookkeeping Client yet"}>
            {profile ? "Set Status to Active in Service details to show them on the list again." : <>Save the Service details on the left, or use <Link className="underline" href={`/bookkeeping/new?client=${clientId}`}>Add Bookkeeping Client</Link>, to put them on the list.</>}
          </Notice>
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-4">
        <aside className="space-y-4 lg:col-span-1">
          <Card title="Year and month">
            <form method="get" className="mb-3 flex flex-wrap items-end gap-2" data-testid="month-picker">
              <Field label="Year"><select className="input w-24" name="year" defaultValue={target.year}>{years.map((y) => <option key={y} value={y}>{y}</option>)}</select></Field>
              <Field label="Month"><select className="input w-32" name="month" defaultValue={target.month}>{MONTHS.map((m, i) => <option key={m} value={i + 1}>{m}</option>)}</select></Field>
              <Button type="submit" variant="secondary">Go</Button>
            </form>
            <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Opened months</p>
            <ul className="space-y-1 text-sm" data-testid="prior-months">
              {ws.periods.map((p) => (
                <li key={p.id}>
                  <Link href={`/bookkeeping/${clientId}?period=${p.id}`} className={`flex items-center justify-between gap-2 rounded-lg px-2 py-1.5 ${p.id === period?.id ? "bg-navy-900 text-white" : "hover:bg-ivory-50"}`}>
                    <span>{periodLabel(freq, p.year, p.month)}</span>
                    <Badge tone={STAGES[p.summary.stage].tone}>{STAGES[p.summary.stage].label}</Badge>
                  </Link>
                </li>
              ))}
              {ws.periods.length === 0 && <li className="text-slate-600">No months yet. Choose a year and month above.</li>}
            </ul>
          </Card>
          <Card title="Service details">
            <ActionForm action={saveBookkeepingProfileAction.bind(null, clientId)} className="space-y-2 text-sm">
              <Field label="Schedule"><select className="input" name="frequency" defaultValue={freq}>{Object.entries(FREQUENCIES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></Field>
              {isAdminUser ? (
                <Field label="Assigned staff">
                  <select className="input" name="assignedToId" defaultValue={client.assignedToId ?? "none"}><option value="none">Unassigned</option>{staff.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select>
                </Field>
              ) : (
                <p className="text-xs text-slate-600">Assigned staff: {client.assignedTo?.name ?? "unassigned"} (only an Admin changes this)</p>
              )}
              <label className="flex items-center gap-2"><input type="checkbox" name="payroll" defaultChecked={profile?.payroll} /> Runs payroll</label>
              <Field label="Payroll frequency"><select className="input" name="payrollFrequency" defaultValue={profile?.payrollFrequency ?? ""}><option value="">—</option>{Object.entries(PAYROLL_FREQUENCIES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></Field>
              <Field label="Payroll provider"><input className="input" name="payrollProvider" defaultValue={profile?.payrollProvider ?? ""} /></Field>
              <Field label="Accounts to collect"><input className="input" name="accounts" defaultValue={profile?.accounts ?? ""} /></Field>
              <Field label="Documents due (month after)" hint="Leave blank for no deadline.">
                <select className="input" name="documentsDueDay" defaultValue={profile?.documentsDueDay ?? ""}><option value="">No deadline</option>{Array.from({ length: 31 }, (_, i) => i + 1).map((d) => <option key={d} value={d}>{d === 31 ? "Last day" : `Day ${d}`}</option>)}</select>
              </Field>
              <Field label="Reports due (month after)" hint="Quarterly clients: applies to quarter-end months.">
                <select className="input" name="reportsDueDay" defaultValue={profile?.reportsDueDay ?? ""}><option value="">No deadline</option>{Array.from({ length: 31 }, (_, i) => i + 1).map((d) => <option key={d} value={d}>{d === 31 ? "Last day" : `Day ${d}`}</option>)}</select>
              </Field>
              <Field label="Notes"><textarea className="input" name="notes" rows={2} defaultValue={profile?.notes ?? ""} /></Field>
              <Field label="Status"><select className="input" name="active" defaultValue={String(profile?.active ?? true)}><option value="true">Active</option><option value="false">Paused</option></select></Field>
              <Button type="submit" variant="secondary">Save</Button>
            </ActionForm>
          </Card>
        </aside>

        <div className="space-y-4 lg:col-span-3">
          {notOpened && (
            <section className="rounded-2xl border border-gold-300 bg-ivory-50 p-5" data-testid="not-opened">
              <p className="font-semibold">{MONTHS[notOpened.month - 1]} {notOpened.year} isn&apos;t opened yet.</p>
              <p className="text-sm text-slate-600">Opening it creates the month&apos;s checklist. Uploading a report for this month (below) also opens it.</p>
              <ActionForm action={openPeriodForClientAction.bind(null, clientId)} className="mt-2">
                <input type="hidden" name="year" value={notOpened.year} />
                <input type="hidden" name="month" value={notOpened.month} />
                <Button type="submit">Open {MONTHS[notOpened.month - 1]} {notOpened.year}</Button>
              </ActionForm>
            </section>
          )}
          {!period || !summary ? (
            !notOpened && <Notice title="No month open yet">Choose a year and month on the left, or upload a report below — that opens the month too.</Notice>
          ) : (
            <>
              <section className="flex flex-wrap items-center justify-between gap-3 rounded-2xl bg-navy-900 px-5 py-4 text-white" data-testid="period-header">
                <div>
                  <p className="text-xs uppercase tracking-[0.2em] text-gold-300">{label}</p>
                  <p className="font-serif text-2xl font-bold text-white">{STAGES[summary.stage].label}</p>
                  <p className="text-sm text-navy-100">{summary.done} of {summary.total} checklist items · {summary.missing} missing from the client · client status: {PERIOD_LABELS[period.status]}</p>
                  <p className="text-xs text-navy-100">
                    {summary.due.documents ? `Documents due ${fmtDate(summary.due.documents)}` : "No document deadline set"}
                    {reportsDue(freq, period.month) ? (summary.due.reports ? ` · reports due ${fmtDate(summary.due.reports)}` : " · no report deadline set") : " · reports at quarter end"}
                  </p>
                  {summary.overdue.length > 0 && <p className="mt-1 inline-block rounded-full bg-red-600 px-3 py-0.5 text-xs font-semibold text-white" data-testid="overdue">{summary.overdue.join(" · ")}</p>}
                </div>
                <ActionForm action={periodStatusAction.bind(null, clientId, period.id)} className="flex flex-wrap items-end gap-2 text-navy-900">
                  <select className="input w-auto" name="status" defaultValue={period.status} aria-label="Client-facing status">{Object.entries(PERIOD_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
                  <Button type="submit" variant="gold">Update</Button>
                </ActionForm>
              </section>

              <Card title="Monthly checklist">
                <ul className="divide-y divide-navy-100 text-sm" data-testid="checklist">
                  {summary.items.map((i) => (
                    <li key={i.id} className="flex flex-wrap items-center justify-between gap-2 py-2" data-item={i.key}>
                      <span>
                        <strong>{i.label}</strong> <span className="text-xs text-slate-500">· {i.kind === "CLIENT_DOCUMENT" ? "from client" : "staff"}</span>
                        {i.files.length > 0 && <span className="block text-xs text-slate-600">{i.files.length} file{i.files.length === 1 ? "" : "s"} received</span>}
                      </span>
                      <span className="flex flex-wrap items-center gap-1">
                        <Badge tone={WAITING[i.state].tone}>{WAITING[i.state].text}</Badge>
                        {i.status !== "DONE" && <form action={checklistItemAction.bind(null, clientId, i.id, "DONE")}><Button variant="ghost">Mark done</Button></form>}
                        {i.status === "OPEN" && <form action={checklistItemAction.bind(null, clientId, i.id, "NOT_NEEDED")}><Button variant="ghost">Not needed</Button></form>}
                        {i.status !== "OPEN" && <form action={checklistItemAction.bind(null, clientId, i.id, "OPEN")}><Button variant="ghost">Reopen</Button></form>}
                      </span>
                    </li>
                  ))}
                </ul>
                {period.requests.length > 0 && (
                  <div className="mt-3">
                    <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Extra requests</p>
                    <ul className="text-sm">{period.requests.map((r) => <li key={r.id}>{r.title} · <Badge tone={r.status === "OPEN" ? "amber" : r.status === "SUBMITTED" ? "gold" : "gray"}>{r.status === "OPEN" ? "Waiting on client" : r.status === "SUBMITTED" ? "Client uploaded — review" : r.status.toLowerCase()}</Badge></li>)}</ul>
                  </div>
                )}
                <details className="mt-2">
                  <summary className="cursor-pointer text-sm underline">Request something else from the client</summary>
                  <ActionForm action={requestDocumentAction.bind(null, clientId)} className="mt-2 flex flex-wrap items-end gap-2" resetOnSuccess>
                    <input type="hidden" name="periodId" value={period.id} />
                    <Field label="What you need"><input className="input w-72" name="title" required placeholder="e.g. Square sales report" /></Field>
                    <Field label="Due"><input className="input" type="date" name="dueAt" /></Field>
                    <Button type="submit" variant="secondary">Request</Button>
                  </ActionForm>
                </details>
              </Card>

              <div className="grid gap-4 xl:grid-cols-2">
                <Card title="Bank & card statements">
                  <ul className="text-sm">{[...byKind("BANK_STATEMENT"), ...byKind("CARD_STATEMENT")].map(fileRow)}</ul>
                  {!byKind("BANK_STATEMENT").length && !byKind("CARD_STATEMENT").length && <p className="text-sm text-slate-600">None yet.</p>}
                </Card>
                <Card title="Payroll reports">
                  {profile?.payroll ? (
                    <>
                      <ul className="text-sm">{byKind("PAYROLL_REPORT").map(fileRow)}</ul>
                      {!byKind("PAYROLL_REPORT").length && <p className="text-sm text-slate-600">None yet.</p>}
                    </>
                  ) : (
                    <p className="text-sm text-slate-600">This client doesn&apos;t run payroll.</p>
                  )}
                </Card>
              </div>

              {(unlabeled.length > 0 || byKind("RECEIPTS").length > 0) && (
                <Card title="Other files this month">
                  <ul className="divide-y divide-navy-100 text-sm">
                    {[...byKind("RECEIPTS"), ...unlabeled].map((d) => (
                      <li key={d.id} className="flex flex-wrap items-center justify-between gap-2 py-1.5">
                        {fileRow(d)}
                        {(!d.docType || !(d.docType in BK_DOC_TYPES)) && (
                          <ActionForm action={classifyDocumentAction.bind(null, clientId, d.id)} className="flex items-center gap-1" showSuccess={false}>
                            <select className="input w-auto text-xs" name="docType" defaultValue="" aria-label="Label as"><option value="" disabled>Label as…</option>{Object.entries(BK_DOC_TYPES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
                            <Button type="submit" variant="ghost">Save</Button>
                          </ActionForm>
                        )}
                      </li>
                    ))}
                  </ul>
                </Card>
              )}

              <Card title="Financial packets">
                {packets.length === 0 ? (
                  <p className="text-sm text-slate-600">No reports yet for {label}. Use Upload Monthly Financials.</p>
                ) : (
                  <ul className="divide-y divide-navy-100 text-sm" data-testid="packets">
                    {packets.map((t) => {
                      const r = reportPeriod(period.year, period.month, t, fiscal.fiscalYearEnd);
                      const inPacket = summary.reports.filter((d) => (d.reportPeriodType ?? "MONTH") === t);
                      const approved = inPacket.filter((d) => d.reviewStatus === "APPROVED" && d.visibility !== "PUBLISHED").length;
                      const delivered = inPacket.filter((d) => d.visibility === "PUBLISHED").length;
                      return (
                        <li key={t} className="flex flex-wrap items-center justify-between gap-2 py-2" data-packet={t}>
                          <span>
                            <strong>{PERIOD_TYPES[t]} packet</strong> · {r.cover}
                            <span className="block text-xs text-slate-600">{inPacket.length} report{inPacket.length === 1 ? "" : "s"} · {delivered} delivered · {approved} approved, not yet delivered</span>
                          </span>
                          <span className="flex flex-wrap items-center gap-2">
                            <a className="underline" href={`/api/bookkeeping/packet?period=${period.id}&type=${t}`} target="_blank" rel="noopener" data-testid="packet-preview">Preview packet PDF</a>
                            {/* Stays mounted (disabled when nothing's waiting) so the delivery confirmation remains visible. */}
                            <ActionForm action={deliverApprovedAction.bind(null, clientId, period.id, t)} confirm="Publish every approved report in this packet to the client's portal and notify them?">
                              <Button type="submit" variant="secondary" disabled={approved === 0}>Deliver all approved</Button>
                            </ActionForm>
                          </span>
                        </li>
                      );
                    })}
                  </ul>
                )}
                <p className="mt-2 text-xs text-slate-600">The packet PDF has a cover page (period, basis, prepared for / by, contents) followed by your uploaded statements. Drafts are stamped and never reach the client.</p>
              </Card>

              <Card title="Financial reports">
                <div id="reports" className="scroll-mt-6" />
                {summary.reports.length === 0 && <p className="text-sm text-slate-600">{reportsDue(freq, period.month) ? "No reports yet. Upload a draft below." : "Quarterly client: reports are prepared for the quarter-end month."}</p>}
                <ul className="divide-y divide-navy-100 text-sm" data-testid="reports">
                  {summary.reports.map((d) => {
                    const status = d.visibility === "PUBLISHED" ? "DELIVERED" : d.reviewStatus ?? "DRAFT";
                    return (
                      <li key={(history(d).at(-1) ?? d).id} className="py-3" data-report={d.reportType}>
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <span>
                            <strong>{d.reportType ? REPORT_LABELS[d.reportType] : "Report"}</strong> <Badge tone="gray">v{d.version ?? 1}</Badge> · {d.scanStatus === "CLEAN" ? <a className="underline" href={link(d.id)} target="_blank" rel="noopener">{d.title}</a> : d.title}
                            <span className="ml-1"><ScanStatus doc={d} health={health} /></span>
                            <span className="block text-xs text-slate-600" data-testid="report-caption">{PERIOD_TYPES[(d.reportPeriodType ?? "MONTH") as PeriodType]} · {reportCaption(d, period.year, period.month, fiscal.fiscalYearEnd)}{d.bookkeepingAccount && ` · ${accountLabel(d.bookkeepingAccount)}`}</span>
                            {d.submittedForReviewAt && <span className="block text-xs text-slate-500">Submitted {fmtDateTime(d.submittedForReviewAt)}{d.approvedAt && ` · approved ${fmtDateTime(d.approvedAt)}`}{d.publishedAt && d.visibility === "PUBLISHED" && ` · delivered ${fmtDateTime(d.publishedAt)}`}</span>}
                          </span>
                          <Badge tone={status === "DELIVERED" ? "green" : REVIEW_TONE[status]}>{status === "DELIVERED" ? "Delivered to client" : REVIEW_LABELS[status]}</Badge>
                        </div>
                        {d.reviewNote && d.reviewStatus === "CHANGES_REQUESTED" && <p className="mt-1 rounded-lg bg-red-50 px-3 py-2 text-red-900">Tabitha: {d.reviewNote}</p>}
                        <div className="mt-2 flex flex-wrap gap-2">
                          {(status === "DRAFT" || status === "CHANGES_REQUESTED") && d.scanStatus !== "CLEAN" && <span className="text-xs text-slate-600">Can be submitted for review once the malware scan passes.</span>}
                          {(status === "DRAFT" || status === "CHANGES_REQUESTED") && d.scanStatus === "CLEAN" && (
                            <ActionForm action={reportStepAction.bind(null, clientId, d.id, "submit")}><Button type="submit" variant="secondary">Submit for Tabitha&apos;s review</Button></ActionForm>
                          )}
                          {status === "AWAITING_REVIEW" && approver && (
                            <>
                              <ActionForm action={reportStepAction.bind(null, clientId, d.id, "approve")}><Button type="submit" variant="gold">Approve</Button></ActionForm>
                              <ActionForm action={requestChangesAction.bind(null, clientId, d.id)} className="flex items-end gap-2">
                                <input className="input w-64" name="note" placeholder="What needs to change?" required aria-label="Changes needed" />
                                <Button type="submit" variant="ghost">Request changes</Button>
                              </ActionForm>
                            </>
                          )}
                          {status === "AWAITING_REVIEW" && !approver && <span className="text-xs text-slate-600">Waiting for Tabitha.</span>}
                          {status === "APPROVED" && (
                            <ActionForm action={reportStepAction.bind(null, clientId, d.id, "deliver")} confirm="Publish this approved report to the client's portal and notify them?"><Button type="submit">Deliver to client</Button></ActionForm>
                          )}
                        </div>
                        <details className="mt-2" data-testid="revise">
                          <summary className="cursor-pointer text-sm underline">Upload a revised version</summary>
                          <ActionForm action={uploadMonthlyFinancialsAction.bind(null, clientId)} className="mt-2 flex flex-wrap items-end gap-2" resetOnSuccess idempotent>
                            <input type="hidden" name="replacesId" value={d.id} />
                            <input type="hidden" name="year" value={period.year} />
                            <input type="hidden" name="month" value={period.month} />
                            <input type="hidden" name="reportType" value={d.reportType ?? "OTHER_REPORT"} />
                            <input type="hidden" name="periodType" value={d.reportPeriodType ?? "MONTH"} />
                            {d.reportBasis && <input type="hidden" name="basis" value={d.reportBasis} />}
                            {d.reportIncludesYtd && <input type="hidden" name="includesYtd" value="on" />}
                            {d.reportAsOf && <input type="hidden" name="asOf" value={`${d.reportAsOf.getFullYear()}-${String(d.reportAsOf.getMonth() + 1).padStart(2, "0")}-${String(d.reportAsOf.getDate()).padStart(2, "0")}`} />}
                            <Field label={`Revised file (becomes v${(d.version ?? 1) + 1})`}><input className="input" type="file" name="file" accept="application/pdf,image/png,image/jpeg" /></Field>
                            <Button type="submit" variant="secondary">Upload revision</Button>
                          </ActionForm>
                          <p className="mt-1 text-xs text-slate-600">The revision starts as a staff-only draft and needs Tabitha&apos;s approval.{status === "DELIVERED" && " The client keeps this delivered version until the revision is approved and delivered."}</p>
                        </details>
                        {(histories.get(d.id)?.length ?? 0) > 0 && (
                          <details className="mt-1" data-testid="approval-history">
                            <summary className="cursor-pointer text-xs text-slate-600 underline">Revision &amp; approval history</summary>
                            <ol className="mt-1 space-y-0.5 text-xs text-slate-600">
                              {histories.get(d.id)!.map((h, i) => <li key={i}>{fmtDateTime(h.at)} · v{h.version} · {HISTORY_LABELS[h.action] ?? h.action} · {h.by}</li>)}
                            </ol>
                          </details>
                        )}
                        {history(d).length > 0 && (
                          <details className="mt-1" data-testid="version-history">
                            <summary className="cursor-pointer text-xs text-slate-600 underline">Version history ({history(d).length} earlier)</summary>
                            <ul className="mt-1 space-y-0.5 text-xs text-slate-600">
                              {history(d).map((h) => (
                                <li key={h.id}>
                                  v{h.version ?? 1} · {h.scanStatus === "CLEAN" ? <a className="underline" href={link(h.id)} target="_blank" rel="noopener">{h.title}</a> : h.title} · uploaded {fmtDateTime(h.createdAt)}{h.uploadedByStaff ? ` by ${h.uploadedByStaff.name}` : ""}
                                  {h.approvedAt && ` · approved ${fmtDate(h.approvedAt)}`}{h.publishedAt && ` · delivered ${fmtDate(h.publishedAt)}`}
                                  {h.visibility === "PUBLISHED" ? " · still shown to client until the new version is delivered" : " · replaced"}
                                </li>
                              ))}
                            </ul>
                          </details>
                        )}
                      </li>
                    );
                  })}
                </ul>
                <p className="mt-2 text-xs text-slate-600">Reports are always saved as drafts. Only Tabitha can approve them, and nothing reaches the client (portal or message) until she does.</p>
              </Card>

              <Card title={`Add a client document to ${label}`}>
                <ActionForm action={uploadBookkeepingFileAction.bind(null, clientId, period.id)} className="grid gap-2 sm:grid-cols-3" resetOnSuccess idempotent>
                  <Field label="File" className="sm:col-span-3"><input className="input" type="file" name="file" accept="application/pdf,image/png,image/jpeg" required /></Field>
                  <Field label="What is it?">
                    <select className="input" name="kind" required defaultValue="">
                      <option value="" disabled>Choose…</option>
                      {Object.entries(BK_DOC_TYPES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                    </select>
                  </Field>
                  <Field label="Account (optional)">
                    <select className="input" name="accountId" defaultValue=""><option value="">—</option>{accounts.map((a) => <option key={a.id} value={a.id}>{accountLabel(a)}</option>)}</select>
                  </Field>
                  <Field label="Title (optional)"><input className="input" name="title" placeholder={`${label} bank statement`} /></Field>
                  <div className="flex items-end"><Button type="submit" variant="secondary">Upload</Button></div>
                </ActionForm>
                <p className="mt-2 text-xs text-slate-600">Statements, payroll reports and receipts (staff only). For a P&amp;L or Balance Sheet, use Upload Monthly Financials.</p>
              </Card>

              <Card title="Messages">
                <ul className="space-y-1 text-sm" data-testid="bk-messages">
                  {[...conversations, ...otherThreads].slice(0, 8).map((c) => (
                    <li key={c.id}><Link className="underline" href={`/clients/${clientId}?tab=messages&c=${c.id}`}>{c.subject ?? "Conversation"}</Link> <span className="text-xs text-slate-500">· {fmtDate(c.lastMessageAt)}</span> {c.awaitingStaff && <Badge tone="gold">Needs reply</Badge>}</li>
                  ))}
                  {!conversations.length && !otherThreads.length && <li className="text-slate-600">No messages yet.</li>}
                </ul>
                <details className="mt-2">
                  <summary className="cursor-pointer text-sm underline">Ask the client about {label}</summary>
                  <ActionForm action={staffMessageAction.bind(null, clientId)} className="mt-2 space-y-2" resetOnSuccess idempotent>
                    <input type="hidden" name="periodId" value={period.id} />
                    <input type="hidden" name="channel" value="PORTAL" />
                    <input type="hidden" name="subject" value={`Question about ${label}`} />
                    <textarea className="input" name="body" rows={3} required aria-label="Question" />
                    <Button type="submit">Send through portal</Button>
                  </ActionForm>
                </details>
              </Card>
            </>
          )}

          <section id="upload-financials" className="scroll-mt-6">
            <Card title="Upload Monthly Financials">
              <p className="mb-3 text-sm text-slate-600">A complete financial packet, or individual reports — Profit &amp; Loss, Gross Receipts, Balance Sheet, Bank Reconciliation, supporting schedules. It&apos;s filed under {client.displayName} → year → month, saved as a <strong>staff-only draft</strong>, and reaches the client only after Tabitha approves it and staff deliver it.</p>
              <ActionForm action={uploadMonthlyFinancialsAction.bind(null, clientId)} className="grid gap-3 sm:grid-cols-4" resetOnSuccess idempotent>
                <Field label="Year"><select className="input" name="year" defaultValue={target.year}>{years.map((y) => <option key={y} value={y}>{y}</option>)}</select></Field>
                <Field label="Month or quarter">
                  <select className="input" name="period" defaultValue={freq === "QUARTERLY" && target.month % 3 === 0 ? `Q${target.month / 3}` : `M${target.month}`}>
                    <optgroup label="Month">{MONTHS.map((m, i) => <option key={m} value={`M${i + 1}`}>{m}</option>)}</optgroup>
                    <optgroup label="Quarter">{[1, 2, 3, 4].map((q) => <option key={q} value={`Q${q}`}>Q{q} (ends {MONTHS[q * 3 - 1]})</option>)}</optgroup>
                  </select>
                </Field>
                <Field label="Covers">
                  <select className="input" name="covers" defaultValue="PERIOD">
                    <option value="PERIOD">Just that month / quarter</option>
                    <option value="YTD">Year to date through it</option>
                  </select>
                </Field>
                <Field label="Report">
                  <select className="input" name="reportType" defaultValue="">
                    <option value="">Choose…</option>
                    {Object.entries(REPORT_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                  </select>
                </Field>
                <Field label="Accounting basis">
                  <select className="input" name="basis" defaultValue={profile?.accountingBasis ?? ""}><option value="">{profile?.accountingBasis ? "—" : "Choose… (or set in Business profile)"}</option>{Object.entries(BASIS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
                </Field>
                <Field label="Balance Sheet “as of”" hint="Defaults to the period end"><input className="input" type="date" name="asOf" /></Field>
                <Field label="Account (bank reconciliation)">
                  <select className="input" name="accountId" defaultValue=""><option value="">—</option>{accounts.map((a) => <option key={a.id} value={a.id}>{accountLabel(a)}</option>)}</select>
                </Field>
                <label className="flex items-end gap-2 pb-2 text-sm"><input type="checkbox" name="includesYtd" defaultChecked /> Shows monthly detail and year-to-date totals</label>
                <Field label="Title (optional)" className="sm:col-span-2"><input className="input" name="title" placeholder="e.g. Profit & Loss — September 2026" /></Field>
                <Field label="File (PDF, PNG or JPG, up to 5 MB)" className="sm:col-span-2"><input className="input" type="file" name="file" accept="application/pdf,image/png,image/jpeg" /></Field>
                <div className="flex items-end sm:col-span-4"><Button type="submit">Upload report</Button></div>
              </ActionForm>
              <p className="mt-2 text-xs text-slate-600">Uploading a P&amp;L or Balance Sheet for a month that already has one saves it as the next version; earlier versions stay in the history.</p>
            </Card>
          </section>
        </div>
      </div>
    </>
  );
}
