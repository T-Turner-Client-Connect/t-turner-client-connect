import Link from "next/link";
import { ActionForm } from "@/components/action-form";
import { ConfirmButton } from "@/components/confirm-button";
import { Badge, Button, Card, EmptyState, Field } from "@/components/ui";
import { openPeriodAction, periodStatusAction, requestDocumentAction, requestStatusAction, staffMessageAction, uploadDocumentAction } from "@/app/actions/workspace";
import { prisma } from "@/lib/prisma";
import { MONTHS, PERIOD_LABELS } from "@/lib/services/bookkeeping";
import { REPORT_LABELS } from "@/lib/services/documents";
import { fmtDate } from "@/lib/format";

const PERIOD_TONE = { AWAITING_DOCUMENTS: "amber", IN_PROGRESS: "navy", READY_FOR_REVIEW: "gold", COMPLETE: "green" } as const;
const REQ_TONE = { OPEN: "amber", SUBMITTED: "gold", ACCEPTED: "green", CANCELLED: "gray" } as const;

export async function BookkeepingTab({ clientId }: { clientId: string }) {
  const periods = await prisma.bookkeepingPeriod.findMany({
    where: { clientId },
    include: {
      documents: { where: { deletedAt: null }, orderBy: { createdAt: "desc" }, include: { uploadedByPortal: { select: { name: true } } } },
      requests: { orderBy: { createdAt: "asc" }, include: { _count: { select: { documents: true } } } },
      conversations: { select: { id: true, subject: true, awaitingStaff: true } },
    },
    orderBy: [{ year: "desc" }, { month: "desc" }],
  });
  const looseRequests = await prisma.documentRequest.findMany({ where: { clientId, periodId: null }, orderBy: { createdAt: "desc" }, include: { _count: { select: { documents: true } } } });
  const now = new Date();
  const prev = new Date(now.getFullYear(), now.getMonth() - 1, 1);

  const requestRow = (r: (typeof looseRequests)[number]) => (
    <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm">
      <span>
        <span className="font-medium">{r.title}</span>
        {r.dueAt && <span className="text-slate-600"> · due {fmtDate(r.dueAt)}</span>}
        {r._count.documents > 0 && <span className="text-slate-600"> · {r._count.documents} file(s) received</span>}
      </span>
      <span className="flex flex-wrap items-center gap-1">
        <Badge tone={REQ_TONE[r.status]}>{r.status === "SUBMITTED" ? "Client uploaded — review" : r.status.charAt(0) + r.status.slice(1).toLowerCase()}</Badge>
        {r.status === "SUBMITTED" && (
          <>
            <ConfirmButton action={requestStatusAction.bind(null, clientId, r.id, "ACCEPTED")} variant="ghost">Accept</ConfirmButton>
            <ConfirmButton action={requestStatusAction.bind(null, clientId, r.id, "OPEN")} variant="ghost">Need more</ConfirmButton>
          </>
        )}
        {r.status === "OPEN" && <ConfirmButton action={requestStatusAction.bind(null, clientId, r.id, "CANCELLED")} variant="ghost" confirm="Cancel this request?">Cancel</ConfirmButton>}
      </span>
    </li>
  );

  return (
    <div className="space-y-4">
      <Card title="Monthly workspaces">
        <ActionForm action={openPeriodAction.bind(null, clientId)} className="flex flex-wrap items-end gap-2">
          <Field label="Month">
            <select className="input" name="month" defaultValue={prev.getMonth() + 1}>
              {MONTHS.map((m, i) => <option key={m} value={i + 1}>{m}</option>)}
            </select>
          </Field>
          <Field label="Year"><input className="input w-28" name="year" inputMode="numeric" defaultValue={prev.getFullYear()} /></Field>
          <Button type="submit">Open month</Button>
        </ActionForm>
        <p className="mt-2 text-xs text-slate-600">Reports are uploaded by staff. No accounting software (QuickBooks etc.) is connected.</p>
      </Card>

      {periods.length === 0 && <EmptyState title="No bookkeeping months yet">Open a month to start collecting documents and publishing reports.</EmptyState>}

      {periods.map((p) => {
        const reports = p.documents.filter((d) => d.category === "BOOKKEEPING");
        const uploads = p.documents.filter((d) => d.uploadedByPortalId);
        return (
          <Card key={p.id} title={`${MONTHS[p.month - 1]} ${p.year}`} actions={<Badge tone={PERIOD_TONE[p.status]}>{PERIOD_LABELS[p.status]}</Badge>}>
            <div className="grid gap-4 lg:grid-cols-2">
              <div className="space-y-3">
                <ActionForm action={periodStatusAction.bind(null, clientId, p.id)} className="flex flex-wrap items-end gap-2">
                  <Field label="Status">
                    <select className="input" name="status" defaultValue={p.status}>
                      {Object.entries(PERIOD_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                    </select>
                  </Field>
                  <Field label="Note to client (optional)"><input className="input" name="staffNote" defaultValue={p.staffNote ?? ""} /></Field>
                  <Button type="submit" variant="secondary">Update</Button>
                </ActionForm>
                <div>
                  <h3 className="mb-1 text-sm font-semibold">Reports</h3>
                  {reports.length ? (
                    <ul className="text-sm">
                      {reports.map((d) => (
                        <li key={d.id}>
                          {d.title} {d.reportType && <Badge tone="navy">{REPORT_LABELS[d.reportType]}</Badge>} <Badge tone={d.visibility === "PUBLISHED" ? "green" : "gray"}>{d.visibility === "PUBLISHED" ? "Published" : "Staff only"}</Badge>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="text-sm text-slate-600">No reports yet.</p>
                  )}
                  <details className="mt-2">
                    <summary className="cursor-pointer text-sm underline">Upload a report for this month</summary>
                    <ActionForm action={uploadDocumentAction.bind(null, clientId)} className="mt-2 space-y-2" resetOnSuccess>
                      <input type="hidden" name="periodId" value={p.id} />
                      <input type="hidden" name="category" value="BOOKKEEPING" />
                      <input type="hidden" name="year" value={p.year} />
                      <input type="hidden" name="month" value={p.month} />
                      <input className="input" type="file" name="file" accept="application/pdf,image/png,image/jpeg" required aria-label="Report file" />
                      <div className="grid gap-2 sm:grid-cols-2">
                        <select className="input" name="reportType" defaultValue="PROFIT_AND_LOSS" aria-label="Report type">
                          {Object.entries(REPORT_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                        </select>
                        <select className="input" name="visibility" defaultValue="STAFF_ONLY" aria-label="Visibility">
                          <option value="STAFF_ONLY">Staff only (draft)</option>
                          <option value="PUBLISHED">Publish to client</option>
                        </select>
                      </div>
                      <input className="input" name="title" placeholder={`e.g. ${MONTHS[p.month - 1]} ${p.year} Profit & Loss`} aria-label="Report title" />
                      <Button type="submit">Upload report</Button>
                    </ActionForm>
                  </details>
                </div>
                {uploads.length > 0 && (
                  <div>
                    <h3 className="mb-1 text-sm font-semibold">Client uploads</h3>
                    <ul className="text-sm">{uploads.map((d) => <li key={d.id}>{d.title} <span className="text-slate-600">· {d.uploadedByPortal?.name} · {fmtDate(d.createdAt)}</span></li>)}</ul>
                    <p className="text-xs text-slate-600">Open them from the Documents tab.</p>
                  </div>
                )}
              </div>
              <div className="space-y-3">
                <div>
                  <h3 className="text-sm font-semibold">Document checklist</h3>
                  {p.requests.length ? <ul className="divide-y divide-navy-100">{p.requests.map(requestRow)}</ul> : <p className="text-sm text-slate-600">Nothing requested yet.</p>}
                  <details className="mt-2">
                    <summary className="cursor-pointer text-sm underline">Request a document</summary>
                    <ActionForm action={requestDocumentAction.bind(null, clientId)} className="mt-2 space-y-2" resetOnSuccess>
                      <input type="hidden" name="periodId" value={p.id} />
                      <input className="input" name="title" required placeholder="e.g. Business checking statement" aria-label="What you need" />
                      <textarea className="input" name="instructions" rows={2} placeholder="Instructions (optional)" aria-label="Instructions" />
                      <div className="grid grid-cols-2 gap-2">
                        <Field label="Due"><input className="input" type="date" name="dueAt" /></Field>
                        <Field label="Reminder"><input className="input" type="date" name="remindAt" /></Field>
                      </div>
                      <Button type="submit">Add to checklist</Button>
                    </ActionForm>
                  </details>
                </div>
                <div>
                  <h3 className="text-sm font-semibold">Questions about this month</h3>
                  {p.conversations.length ? (
                    <ul className="text-sm">
                      {p.conversations.map((c) => (
                        <li key={c.id}><Link className="underline" href={`/clients/${clientId}?tab=messages&c=${c.id}`}>{c.subject}</Link> {c.awaitingStaff && <Badge tone="gold">Needs reply</Badge>}</li>
                      ))}
                    </ul>
                  ) : (
                    <p className="text-sm text-slate-600">None yet.</p>
                  )}
                  <details className="mt-2">
                    <summary className="cursor-pointer text-sm underline">Ask the client a question</summary>
                    <ActionForm action={staffMessageAction.bind(null, clientId)} className="mt-2 space-y-2" resetOnSuccess idempotent>
                      <input type="hidden" name="periodId" value={p.id} />
                      <input type="hidden" name="channel" value="PORTAL" />
                      <input type="hidden" name="subject" value={`Question about ${MONTHS[p.month - 1]} ${p.year}`} />
                      <textarea className="input" name="body" rows={3} required aria-label="Question" />
                      <Button type="submit">Send through portal</Button>
                    </ActionForm>
                  </details>
                </div>
              </div>
            </div>
          </Card>
        );
      })}

      <Card title="Other document requests">
        {looseRequests.length ? <ul className="divide-y divide-navy-100">{looseRequests.map(requestRow)}</ul> : <p className="text-sm text-slate-600">None.</p>}
        <details className="mt-2">
          <summary className="cursor-pointer text-sm underline">Request a document (not tied to a month)</summary>
          <ActionForm action={requestDocumentAction.bind(null, clientId)} className="mt-2 grid gap-2 sm:grid-cols-2" resetOnSuccess>
            <input className="input sm:col-span-2" name="title" required placeholder="e.g. 2025 W-2 from your employer" aria-label="What you need" />
            <textarea className="input sm:col-span-2" name="instructions" rows={2} placeholder="Instructions (optional)" aria-label="Instructions" />
            <Field label="Due"><input className="input" type="date" name="dueAt" /></Field>
            <Field label="Reminder"><input className="input" type="date" name="remindAt" /></Field>
            <div><Button type="submit">Request</Button></div>
          </ActionForm>
        </details>
      </Card>
    </div>
  );
}
