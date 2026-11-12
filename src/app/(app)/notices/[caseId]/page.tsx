import Link from "next/link";
import { connection } from "next/server";
import { notFound } from "next/navigation";
import { ActionForm } from "@/components/action-form";
import { Badge, Button, Card, Field, PageHeader } from "@/components/ui";
import { requireUser } from "@/lib/auth/session";
import { downloadToken } from "@/lib/services/documents";
import { fmtDate, fmtDateTime } from "@/lib/format";
import {
  addAuditItemAction, agencyCorrespondenceAction, auditDetailsAction, splitNoticeAction, auditStatusAction, buildAuditPackageAction, linkAuditDocumentAction, releaseAuditPackageAction,
  requestAuditDocumentAction, staffAuditUploadAction, unlinkAuditDocumentAction, updateAuditItemAction,
} from "@/app/actions/audit-center";
import { AUDIT_KINDS, AUDIT_STATUS, staffAuditCase, type AuditKind, type AuditStatus } from "@/lib/services/audit-center";

export const metadata = { title: "Audit" };

const usd = (c: number | null | undefined) => (c == null ? "—" : `${c < 0 ? "-" : ""}$${(Math.abs(c) / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
const money = (c: number | null) => (c == null ? "" : (c / 100).toFixed(2));
const STATE_TONE: Record<string, "green" | "red" | "amber" | "gray"> = { SUPPORTED: "green", DIFFERENCE: "red", MISSING: "amber", NOT_READ: "gray" };
const STATE_LABEL: Record<string, string> = { SUPPORTED: "Supported", DIFFERENCE: "Difference", MISSING: "No documents yet", NOT_READ: "Reported amount not entered" };

export default async function AuditCasePage({ params }: { params: Promise<{ caseId: string }> }) {
  await connection();
  const actor = await requireUser();
  const { caseId } = await params;
  const a = await staffAuditCase(actor, caseId).catch(() => null);
  if (!a) notFound();
  const link = (id: string) => `/api/documents/${downloadToken(id, { staffId: actor.id })}`;
  const status = (a.auditStatus ?? "NOTICE_RECEIVED") as AuditStatus;
  return (
    <>
      <p className="mb-2 text-sm"><Link className="underline" href="/notices">← Audit Center</Link></p>
      <PageHeader
        title={`${a.client.displayName} — ${AUDIT_KINDS[a.auditKind as AuditKind]}${a.stateCode ? ` (${a.stateCode})` : ""}, tax year ${a.taxYear}`}
        subtitle={`${AUDIT_STATUS[status]} · ${a.totals.items} item${a.totals.items === 1 ? "" : "s"} · ${a.totals.received} documents received · ${a.totals.verified} verified · ${a.totals.missing} missing · ${a.totals.discrepancies} with a difference${a.responseDueOn ? ` · respond by ${fmtDate(a.responseDueOn)}` : " · deadline unknown"}`}
      />
      {a.open.length > 0 && (
        <div className="mb-4 rounded-xl border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900" data-testid="audit-open-items">
          <p className="font-semibold">Not fully ready — {a.open.length} open item{a.open.length === 1 ? "" : "s"}</p>
          <ul className="mt-1 list-disc pl-5">{a.open.map((o) => <li key={o}>{o}</li>)}</ul>
        </div>
      )}
      <div className="grid gap-4 lg:grid-cols-3">
        <div className="space-y-4 lg:col-span-2">
          <Card title="Items under examination">
            {a.items.length ? (
              <ul className="space-y-5" data-testid="audit-items">
                {a.items.map((i, n) => (
                  <li key={i.id} className="rounded-lg border border-ivory-200 p-3">
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <div>
                        <p className="font-semibold text-navy-900">{n + 1}. {i.label} <Badge tone={STATE_TONE[i.check.state]}>{STATE_LABEL[i.check.state]}</Badge></p>
                        <p className="text-xs text-slate-600">{[i.schedule, i.returnLine && `line ${i.returnLine}`].filter(Boolean).join(", ")}{i.requested ? ` · Agency asked for: ${i.requested}` : ""}</p>
                      </div>
                      <table className="text-right text-xs" data-testid="audit-reconciliation">
                        <tbody>
                          <tr><td className="pr-2 text-slate-500">Reported</td><td className="font-semibold">{usd(i.reportedCents)}</td></tr>
                          <tr><td className="pr-2 text-slate-500">Supported</td><td className="font-semibold">{usd(i.check.supportedCents)}</td></tr>
                          <tr><td className="pr-2 text-slate-500">Difference</td><td className={i.check.differenceCents ? "font-semibold text-red-700" : "font-semibold"}>{usd(i.check.differenceCents)}</td></tr>
                        </tbody>
                      </table>
                    </div>
                    <ul className="mt-2 space-y-1 text-sm">
                      {i.documents.map((d) => (
                        <li key={d.id} className="flex flex-wrap items-center gap-2">
                          <a className="underline" href={link(d.documentId)} target="_blank" rel="noreferrer">{d.document.title}</a>
                          <span className="text-xs text-slate-600">{d.amountCents != null ? usd(d.amountCents) : "amount not counted"}{d.addedBy === "COETHA" ? " · Coetha" : ""}{d.note ? ` · ${d.note}` : ""}</span>
                          <ActionForm action={unlinkAuditDocumentAction.bind(null, a.id, i.id, d.documentId)} showSuccess={false}><button type="submit" className="text-xs text-navy-700 underline">Remove</button></ActionForm>
                        </li>
                      ))}
                      {i.requests.map((r) => (
                        <li key={r.id} className="text-xs"><Badge tone={r.status === "OPEN" ? "amber" : r.status === "SUBMITTED" ? "navy" : "green"}>{r.status === "OPEN" ? "Requested from client" : r.status === "SUBMITTED" ? "Client uploaded — review" : "Received"}</Badge> {r.title}{r.documents.map((d) => <a key={d.id} className="ml-2 underline" href={link(d.id)} target="_blank" rel="noreferrer">{d.title}</a>)}</li>
                      ))}
                    </ul>
                    <details className="mt-2 text-sm">
                      <summary className="cursor-pointer text-navy-700">Link a document, request one, upload, or edit</summary>
                      <ActionForm action={linkAuditDocumentAction.bind(null, a.id, i.id)} className="mt-2 flex flex-wrap items-end gap-2" resetOnSuccess>
                        <Field label="Document already on file"><select className="input max-w-xs" name="documentId" required defaultValue=""><option value="" disabled>Choose</option>{a.files.map((f) => <option key={f.id} value={f.id}>{f.title}{f.year ? ` (${f.year})` : ""}</option>)}</select></Field>
                        <Field label="Amount it supports"><input className="input w-28" name="amount" inputMode="decimal" placeholder="0.00" /></Field>
                        <Field label="Note"><input className="input w-40" name="note" /></Field>
                        <Button type="submit" variant="secondary">Link</Button>
                      </ActionForm>
                      <ActionForm action={requestAuditDocumentAction.bind(null, a.id, i.id)} className="mt-2 flex flex-wrap items-end gap-2" resetOnSuccess>
                        <Field label="Ask the client for"><input className="input w-64" name="title" required placeholder="e.g. Receipts for 2025 church donations" /></Field>
                        <Field label="Instructions"><input className="input w-56" name="instructions" /></Field>
                        <Button type="submit" variant="secondary">Request</Button>
                      </ActionForm>
                      <ActionForm action={staffAuditUploadAction.bind(null, a.id, i.id)} className="mt-2 flex flex-wrap items-end gap-2" resetOnSuccess>
                        <Field label="Upload for the client"><input className="input w-56" type="file" name="file" required accept="application/pdf,image/*" /></Field>
                        <Field label="Amount it supports"><input className="input w-28" name="amount" inputMode="decimal" /></Field>
                        <Button type="submit" variant="secondary">Upload</Button>
                      </ActionForm>
                      <ActionForm action={updateAuditItemAction.bind(null, a.id, i.id)} className="mt-3 grid gap-2 sm:grid-cols-2">
                        <Field label="Item"><input className="input" name="label" defaultValue={i.label} /></Field>
                        <Field label="Form / schedule"><input className="input" name="schedule" defaultValue={i.schedule ?? ""} /></Field>
                        <Field label="Line"><input className="input" name="returnLine" defaultValue={i.returnLine ?? ""} /></Field>
                        <Field label="Reported on the filed return"><input className="input" name="reported" defaultValue={money(i.reportedCents)} /></Field>
                        <Field label="What the agency asked for" className="sm:col-span-2"><input className="input" name="requested" defaultValue={i.requested ?? ""} /></Field>
                        <Field label="Explanation for the package (facts supported by the records)" className="sm:col-span-2"><textarea className="input" name="explanation" rows={2} defaultValue={i.explanation ?? ""} /></Field>
                        <div><Button type="submit" variant="secondary">Save item</Button></div>
                      </ActionForm>
                    </details>
                  </li>
                ))}
              </ul>
            ) : <p className="text-sm text-slate-600">No items yet. Add each item the notice examines.</p>}
            <details className="mt-4 text-sm">
              <summary className="cursor-pointer font-semibold text-navy-700">Add an item under examination</summary>
              <ActionForm action={addAuditItemAction.bind(null, a.id)} className="mt-2 grid gap-2 sm:grid-cols-2" resetOnSuccess>
                <Field label="Item"><input className="input" name="label" required placeholder="Schedule A — charitable contributions" /></Field>
                <Field label="Form / schedule"><input className="input" name="schedule" placeholder="Schedule A" /></Field>
                <Field label="Line"><input className="input" name="returnLine" placeholder="12" /></Field>
                <Field label="Reported on the filed return"><input className="input" name="reported" inputMode="decimal" placeholder="0.00" /></Field>
                <Field label="What the agency asked for" className="sm:col-span-2"><input className="input" name="requested" /></Field>
                <div><Button type="submit">Add item</Button></div>
              </ActionForm>
            </details>
          </Card>
        </div>

        <div className="space-y-4">
          <Card title="Audit package">
            {a.package ? (
              <p className="text-sm">Version {a.package.version ?? 1} built {fmtDate(a.package.createdAt)} · <a className="underline" href={link(a.package.id)} target="_blank" rel="noreferrer">Open</a>{a.releasedAt ? <> · <Badge tone="green">Released {fmtDate(a.releasedAt)}</Badge></> : <> · <Badge tone="amber">Not released</Badge></>}</p>
            ) : <p className="text-sm text-slate-600">Not built yet.</p>}
            <div className="mt-3 flex flex-wrap gap-2">
              <ActionForm action={buildAuditPackageAction.bind(null, a.id)}><Button type="submit" variant="secondary">{a.package ? "Rebuild package" : "Build package"}</Button></ActionForm>
              {a.canRelease && a.package && !a.releasedAt && (
                <ActionForm action={releaseAuditPackageAction.bind(null, a.id)} confirm="Release the audit package to the client?" className="flex flex-wrap items-center gap-2">
                  {a.open.length > 0 && <label className="flex items-center gap-1 text-xs"><input type="checkbox" name="acknowledgeOpenItems" /> Release marked “Not Fully Ready”</label>}
                  <Button type="submit">Release to client</Button>
                </ActionForm>
              )}
            </div>
            {a.submittedAt && <p className="mt-2 text-sm"><Badge tone="green">Client submitted</Badge> {fmtDate(a.submittedAt)} by {a.submissionMethod}</p>}
            {a.versions.length > 0 && (
              <ul className="mt-3 space-y-1 text-xs" data-testid="audit-package-versions">
                {a.versions.map((p) => <li key={p.id}><a className="underline" href={link(p.id)} target="_blank" rel="noreferrer">Version {p.version ?? 1}</a> · built {fmtDate(p.createdAt)}{p.publishedAt ? ` · released ${fmtDate(p.publishedAt)}` : ""}{p.supersededAt ? " · replaced" : " · current"}</li>)}
              </ul>
            )}
            <ActionForm action={auditStatusAction.bind(null, a.id)} className="mt-3 space-y-2">
              <Field label="After submission"><select className="input" name="status" defaultValue={status === "CLOSED" ? "CLOSED" : "AWAITING_AGENCY"}><option value="AWAITING_AGENCY">Awaiting Agency Response</option><option value="CLOSED">Audit Closed</option></select></Field>
              <Field label="Final resolution (required to close)"><textarea className="input" name="resolution" rows={2} defaultValue={a.resolution ?? ""} /></Field>
              <Button type="submit" variant="ghost">Set</Button>
            </ActionForm>
            <ActionForm action={agencyCorrespondenceAction.bind(null, a.id)} className="mt-3 flex flex-wrap items-end gap-2" resetOnSuccess>
              <Field label="Agency response or later letter"><input className="input w-56" type="file" name="file" multiple required accept="application/pdf,image/*" /></Field>
              <Button type="submit" variant="secondary">Add</Button>
            </ActionForm>
          </Card>
          <Card title="Notice details">
            <ActionForm action={auditDetailsAction.bind(null, a.id)} className="space-y-2">
              <Field label="Type of audit"><input className="input" name="auditType" defaultValue={a.auditType ?? ""} placeholder="Correspondence examination" /></Field>
              <Field label="Notice / letter number"><input className="input" name="noticeReference" defaultValue={a.noticeReference ?? ""} /></Field>
              <Field label="Response deadline"><input className="input" type="date" name="responseDueOn" defaultValue={a.responseDueOn?.toISOString().slice(0, 10) ?? ""} /></Field>
              <Field label="Send the response to (office and address)"><textarea className="input" name="respondTo" rows={3} defaultValue={a.respondTo ?? ""} /></Field>
              <Field label="How to respond (from the notice)"><textarea className="input" name="responseInstructions" rows={3} defaultValue={a.responseInstructions ?? ""} /></Field>
              <Button type="submit" variant="secondary">Save details</Button>
            </ActionForm>
            <p className="mt-2 text-xs text-slate-600">Filed return: {a.filing ? `${a.filing.returnType} ${a.filing.jurisdiction} (${a.filing.filingStatus.toLowerCase()})` : "not found in Client Connect for this year"}</p>
          </Card>
          <Card title="Notices, correspondence and files">
            <ul className="space-y-1 text-sm">
              {a.documents.map((d) => (
                <li key={d.id}>
                  <a className="underline" href={link(d.id)} target="_blank" rel="noreferrer">{d.title}</a> <span className="text-xs text-slate-500">· {fmtDate(d.createdAt)}{d.uploadedByPortalId ? " · from client" : ""}</span>
                  {d.title.startsWith("Additional notice") && (
                    <ActionForm action={splitNoticeAction.bind(null, a.id, d.id)} className="mt-1 flex items-center gap-1" confirm="Move this notice to its own audit?">
                      <input className="input h-8 w-40 text-xs" name="reason" placeholder="Why it's separate" />
                      <button type="submit" className="text-xs text-navy-700 underline">Separate audit</button>
                    </ActionForm>
                  )}
                </li>
              ))}
            </ul>
            {a.clientMessage && <p className="mt-2 text-xs text-slate-600">Client: “{a.clientMessage}”</p>}
            {a.resolution && <p className="mt-2 text-sm"><strong>Resolution:</strong> {a.resolution}</p>}
          </Card>
          <Card title="Audit history">
            <ul className="max-h-96 space-y-1 overflow-y-auto text-xs" data-testid="audit-history">
              {a.activity.map((e) => <li key={e.id}><span className="text-slate-500">{fmtDateTime(e.at)}</span> · {e.what} <span className="text-slate-500">({e.who})</span></li>)}
            </ul>
          </Card>
        </div>
      </div>
    </>
  );
}
