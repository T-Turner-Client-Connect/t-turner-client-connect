import Link from "next/link";
import { connection } from "next/server";
import { notFound } from "next/navigation";
import { ActionForm } from "@/components/action-form";
import { Badge, Button, Card, Field, Notice, PageHeader } from "@/components/ui";
import {
  checklistItemAction, classifyDocumentAction, openPeriodForClientAction, reportStepAction, requestChangesAction, saveBookkeepingProfileAction, uploadBookkeepingFileAction,
} from "@/app/actions/bookkeeping-clients";
import { periodStatusAction, requestDocumentAction, staffMessageAction } from "@/app/actions/workspace";
import { requireUser } from "@/lib/auth/session";
import { prisma } from "@/lib/prisma";
import { BK_DOC_TYPES, bookkeepingWorkspace, FREQUENCIES, isReportApprover, PAYROLL_FREQUENCIES, periodLabel, reportsDue, REVIEW_LABELS, STAGES, workMonth } from "@/lib/services/bookkeeping-clients";
import { MONTHS, PERIOD_LABELS } from "@/lib/services/bookkeeping";
import { downloadToken, REPORT_LABELS } from "@/lib/services/documents";
import { SCAN_LABELS } from "@/lib/scan-labels";
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

export default async function BookkeepingWorkspace({ params, searchParams }: { params: Promise<{ clientId: string }>; searchParams: Promise<{ period?: string }> }) {
  await connection();
  const user = await requireUser();
  const { clientId } = await params;
  const sp = await searchParams;
  if (!(await prisma.client.count({ where: { id: clientId } }))) notFound();
  const [ws, approver, staff] = await Promise.all([
    bookkeepingWorkspace(clientId, sp.period),
    isReportApprover(user),
    prisma.user.findMany({ where: { active: true }, select: { id: true, name: true }, orderBy: { name: "asc" } }),
  ]);
  const { client, profile, period, summary } = ws;
  const freq = profile?.frequency ?? "MONTHLY";
  const label = period ? periodLabel(freq, period.year, period.month) : null;
  const link = (id: string) => `/api/documents/${downloadToken(id, { staffId: user.id })}`;
  const work = workMonth(freq);
  const statements = period?.documents.filter((d) => !(d.category === "BOOKKEEPING" && d.reportType)) ?? [];
  const byKind = (k: string) => statements.filter((d) => d.docType === k);
  const unlabeled = statements.filter((d) => !d.docType || !(d.docType in BK_DOC_TYPES));
  const conversations = period ? period.conversations : [];
  const otherThreads = await prisma.conversation.findMany({ where: { clientId, periodId: null }, orderBy: { lastMessageAt: "desc" }, take: 5, select: { id: true, subject: true, awaitingStaff: true, lastMessageAt: true } });

  const fileRow = (d: (typeof statements)[number]) => (
    <li key={d.id} className="flex flex-wrap items-center justify-between gap-2 py-1.5">
      <span>
        {d.scanStatus === "CLEAN" ? <a className="underline" href={link(d.id)} target="_blank" rel="noopener">{d.title}</a> : <span>{d.title}</span>}
        <span className="text-xs text-slate-500"> · {d.uploadedByPortal ? `client (${d.uploadedByPortal.name})` : d.uploadedByStaff?.name ?? "staff"} · {fmtDate(d.createdAt)}</span>
        {d.scanStatus !== "CLEAN" && <Badge tone={SCAN_LABELS[d.scanStatus].tone} className="ml-1">{SCAN_LABELS[d.scanStatus].text}</Badge>}
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
      />

      <div className="grid gap-4 lg:grid-cols-4">
        <aside className="space-y-4 lg:col-span-1">
          <Card title="Months">
            <ul className="space-y-1 text-sm" data-testid="prior-months">
              {ws.periods.map((p) => (
                <li key={p.id}>
                  <Link href={`/bookkeeping/${clientId}?period=${p.id}`} className={`flex items-center justify-between gap-2 rounded-lg px-2 py-1.5 ${p.id === period?.id ? "bg-navy-900 text-white" : "hover:bg-ivory-50"}`}>
                    <span>{periodLabel(freq, p.year, p.month)}</span>
                    <Badge tone={STAGES[p.summary.stage].tone}>{STAGES[p.summary.stage].label}</Badge>
                  </Link>
                </li>
              ))}
              {ws.periods.length === 0 && <li className="text-slate-600">No months yet.</li>}
            </ul>
            <ActionForm action={openPeriodForClientAction.bind(null, clientId)} className="mt-3 flex flex-wrap items-end gap-2">
              <Field label="Month"><select className="input" name="month" defaultValue={work.month}>{MONTHS.map((m, i) => <option key={m} value={i + 1}>{m}</option>)}</select></Field>
              <Field label="Year"><input className="input w-20" name="year" inputMode="numeric" defaultValue={work.year} /></Field>
              <Button type="submit" variant="secondary">Open</Button>
            </ActionForm>
          </Card>
          <Card title="Service details">
            <ActionForm action={saveBookkeepingProfileAction.bind(null, clientId)} className="space-y-2 text-sm">
              <Field label="Schedule"><select className="input" name="frequency" defaultValue={freq}>{Object.entries(FREQUENCIES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></Field>
              {user.role === "ADMIN" && (
                <Field label="Assigned staff">
                  <select className="input" name="assignedToId" defaultValue={client.assignedToId ?? ""}><option value="">Unassigned</option>{staff.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select>
                </Field>
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
          {!period || !summary ? (
            <Notice title="No month open yet">Open a month on the left to create its checklist.</Notice>
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

              <Card title="Financial reports (P&L, Balance Sheet)">
                <div id="reports" className="scroll-mt-6" />
                {summary.reports.length === 0 && <p className="text-sm text-slate-600">{reportsDue(freq, period.month) ? "No reports yet. Upload a draft below." : "Quarterly client: reports are prepared for the quarter-end month."}</p>}
                <ul className="divide-y divide-navy-100 text-sm" data-testid="reports">
                  {summary.reports.map((d) => {
                    const status = d.visibility === "PUBLISHED" ? "DELIVERED" : d.reviewStatus ?? "DRAFT";
                    return (
                      <li key={d.id} className="py-3" data-report={d.reportType}>
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <span>
                            <strong>{d.reportType ? REPORT_LABELS[d.reportType] : "Report"}</strong> · {d.scanStatus === "CLEAN" ? <a className="underline" href={link(d.id)} target="_blank" rel="noopener">{d.title}</a> : d.title}
                            {d.submittedForReviewAt && <span className="block text-xs text-slate-500">Submitted {fmtDateTime(d.submittedForReviewAt)}{d.approvedAt && ` · approved ${fmtDateTime(d.approvedAt)}`}{d.publishedAt && d.visibility === "PUBLISHED" && ` · delivered ${fmtDateTime(d.publishedAt)}`}</span>}
                          </span>
                          <Badge tone={status === "DELIVERED" ? "green" : REVIEW_TONE[status]}>{status === "DELIVERED" ? "Delivered to client" : REVIEW_LABELS[status]}</Badge>
                        </div>
                        {d.reviewNote && d.reviewStatus === "CHANGES_REQUESTED" && <p className="mt-1 rounded-lg bg-red-50 px-3 py-2 text-red-900">Tabitha: {d.reviewNote}</p>}
                        <div className="mt-2 flex flex-wrap gap-2">
                          {(status === "DRAFT" || status === "CHANGES_REQUESTED") && (
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
                      </li>
                    );
                  })}
                </ul>
                <p className="mt-2 text-xs text-slate-600">Reports are always saved as drafts. Only Tabitha can approve them, and nothing reaches the client (portal or message) until she does.</p>
              </Card>

              <Card title="Add a file to this month">
                <ActionForm action={uploadBookkeepingFileAction.bind(null, clientId, period.id)} className="grid gap-2 sm:grid-cols-3" resetOnSuccess idempotent>
                  <Field label="File" className="sm:col-span-3"><input className="input" type="file" name="file" accept="application/pdf,image/png,image/jpeg" required /></Field>
                  <Field label="What is it?">
                    <select className="input" name="kind" required defaultValue="">
                      <option value="" disabled>Choose…</option>
                      <optgroup label="Reports (draft → Tabitha's review)">{Object.entries(REPORT_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</optgroup>
                      <optgroup label="Client records">{Object.entries(BK_DOC_TYPES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</optgroup>
                    </select>
                  </Field>
                  <Field label="Title (optional)"><input className="input" name="title" placeholder={`${label} Profit & Loss`} /></Field>
                  <div className="flex items-end"><Button type="submit">Upload</Button></div>
                </ActionForm>
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
        </div>
      </div>
    </>
  );
}
