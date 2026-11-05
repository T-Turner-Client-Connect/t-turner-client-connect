import Link from "next/link";
import type { Actor } from "@/lib/auth/actor";
import { returnStepAction } from "@/app/actions/tax-returns";
import { convertToReturnCopyAction, deliverAcceptedReturnAction, editFilingDetailsAction, moveFilingDocAction, relabelFilingDocAction, removeFilingAction, removeFilingDocAction } from "@/app/actions/accepted-returns";
import { AcceptedReturnFields } from "@/components/accepted-return-fields";
import { AcceptanceQueue } from "@/components/acceptance-queue";
import { PresetReason } from "@/components/preset-reason";
import { deliveryContext } from "@/lib/services/accepted-returns";
import { nextFilingStatus } from "@/lib/services/tax";
import { utcToChicagoLocal } from "@/lib/tz";
import { isReportApprover } from "@/lib/services/bookkeeping-clients";
import { ActionForm } from "@/components/action-form";
import { Badge, Button, Card, EmptyState, Field, Notice } from "@/components/ui";
import { amendmentOutcomeAction, attachFilingDocAction, createFilingAction, filingStatusAction, prepStatusAction, publishFilingAction, setTaxSoftwareIdAction } from "@/app/actions/tax";
import { prisma } from "@/lib/prisma";
import { downloadToken } from "@/lib/services/documents";
import { AMENDMENT_LABELS, FILING_LABELS, filingStatusLabel, filingTitle, PREP_LABELS } from "@/lib/tax/normalize";
import { fmtDate, fmtDateTime } from "@/lib/format";
import { TaxCenterStaff } from "./tax-center-staff";
import { TaxPrepCases } from "./tax-prep-cases";
import { TaxSummaryStaff } from "./tax-summary-staff";
import { summaryRequirement } from "@/lib/services/tax-summary";

const DOC_TYPE = { RETURN: "Return", OFFICIAL_ACK: "Official acknowledgment", AGENCY_NOTICE: "Agency notice", CORRESPONDENCE: "Correspondence", FIRM_SUMMARY: "Our summary" } as const;

export type DeliverPrefill = { year?: number; state?: boolean; amended?: boolean };

export async function TaxesTab({ clientId, user, deliver }: { clientId: string; user: Actor; deliver?: DeliverPrefill }) {
  const [client, filings, docs] = await Promise.all([
    prisma.client.findUniqueOrThrow({ where: { id: clientId }, select: { taxSoftwareId: true } }),
    prisma.filingRecord.findMany({
      where: { clientId },
      include: { documents: { where: { deletedAt: null }, orderBy: { createdAt: "desc" } }, events: { orderBy: { createdAt: "desc" }, take: 8 } },
      orderBy: [{ taxYear: "desc" }, { filingType: "asc" }, { jurisdiction: "asc" }],
    }),
    prisma.document.findMany({ where: { clientId, deletedAt: null, category: "TAXES" }, select: { id: true, title: true }, orderBy: { createdAt: "desc" } }),
  ]);
  const approver = await isReportApprover(user);
  const requirements = new Map(await Promise.all(filings.map(async (f) => [f.id, await summaryRequirement(f)] as const)));
  const staffNames = new Map((await prisma.user.findMany({ select: { id: true, name: true } })).map((u) => [u.id, u.name]));
  const years = Array.from(new Set(filings.map((f) => f.taxYear)));
  const ctx = await deliveryContext(clientId, user);
  const canFix = approver || user.role === "ADMIN";
  // Acknowledgments on return filings — the usual home of a misfiled return PDF.
  const savedAsAck = filings.filter((f) => f.filingType !== "EXTENSION").flatMap((f) => f.documents.filter((d) => d.filingDocType === "OFFICIAL_ACK"));

  const thisYear = new Date().getFullYear();

  return (
    <div className="space-y-4">
      <div id="finish-send" className="space-y-4">
        <AcceptanceQueue approver={approver} clientId={clientId} />
        <Card title="Finish & Send a Return">
          <p className="mb-3 text-sm text-slate-600">
            Already e-filed and accepted? Do it all here: mark it Accepted, attach the return and {approver ? "send it to the client" : "send it to Tabitha for release"}.
          </p>
          <ActionForm action={deliverAcceptedReturnAction.bind(null, clientId)} className="space-y-3" resetOnSuccess idempotent>
            <AcceptedReturnFields ctx={ctx} defaultYear={deliver?.year} startWithState={deliver?.state} amended={deliver?.amended} />
            <div>
              <Button type="submit" variant={approver ? "gold" : "primary"} data-testid="finish-send-button">{approver ? "Mark Accepted & Send to Client" : "Mark Accepted & Send to Tabitha for release"}</Button>{" "}
              <span className="text-xs text-slate-600">Several clients at once? Use <Link className="underline" href="/taxes/returns">Tax returns</Link>.</span>
            </div>
          </ActionForm>
          {savedAsAck.length > 0 && (
          <div className="mt-3 rounded-lg border border-gold-500/50 bg-gold-50 p-3 text-sm" data-testid="saved-as-ack">
            <p className="font-semibold">Saved as an acknowledgment — is one of these the return?</p>
            <ul className="mt-1 space-y-1">
              {savedAsAck.map((d) => (
                <li key={d.id} className="flex flex-wrap items-center gap-2">
                  <span>{d.title}</span>
                  <Badge tone={d.visibility === "PUBLISHED" ? "green" : "gray"}>{d.visibility === "PUBLISHED" ? "Published" : "Staff only"}</Badge>
                  {(d.visibility !== "PUBLISHED" || approver) && (
                    <ActionForm action={convertToReturnCopyAction.bind(null, d.id)}><Button type="submit" variant="secondary" className="px-2 py-1 text-xs">Use this file as the return copy</Button></ActionForm>
                  )}
                </li>
              ))}
            </ul>
          </div>
          )}
        </Card>
      </div>
      <TaxPrepCases clientId={clientId} user={user} />
      <TaxCenterStaff clientId={clientId} user={user} />
      <TaxSummaryStaff clientId={clientId} user={user} />

      {years.length === 0 && <EmptyState title="No filings yet">Use Finish &amp; Send a Return above, or import e-file statuses from TaxAct.</EmptyState>}

      {years.map((year) => (
        <section key={year} className="space-y-3">
          <h2 className="text-xl font-semibold">{year} tax year</h2>
          <div className="grid gap-4 xl:grid-cols-2">
            {filings.filter((f) => f.taxYear === year).map((f) => {
              const label = filingStatusLabel(f);
              const req = requirements.get(f.id);
              const accepted = f.filingStatus === "ACCEPTED";
              const when = f.acknowledgedAt ?? f.statusAsOf;
              return (
                <Card key={f.id} title={filingTitle(f)} actions={<Badge tone={f.filingType === "EXTENSION" ? "gold" : f.filingType === "AMENDED" ? "amber" : "navy"}>{f.filingType === "ORIGINAL" ? "Original" : f.filingType === "EXTENSION" ? "Extension" : "Amended"}{f.method === "PAPER" ? " · paper" : ""}</Badge>}>
                  <p className="text-sm" data-testid="filing-summary">
                    <strong className={accepted ? "text-emerald-800" : f.filingStatus === "REJECTED" ? "text-red-800" : "text-navy-900"}>{label}</strong>
                    {when && <> · {fmtDate(when)}</>}
                    {f.filingReference && <> · Ref {f.filingReference}</>}
                    <span className="text-slate-500"> · Prep: {PREP_LABELS[f.prepStatus]}</span>
                  </p>
                  {f.filingType === "AMENDED" && f.amendmentOutcome !== "NONE" && <p className="mt-1 text-sm">After acceptance: <strong>{AMENDMENT_LABELS[f.amendmentOutcome]}</strong></p>}
                  {f.rejectionCodes && <Notice tone="error">Rejection codes: {f.rejectionCodes}</Notice>}
                  {f.documents.length ? (
                    <ul className="mt-2 space-y-1 text-sm">
                          {f.documents.map((d) => (
                            <li key={d.id}>
                              <a className="underline" href={`/api/documents/${downloadToken(d.id, { staffId: user.id })}`} target="_blank" rel="noopener">{d.title}</a>{" "}
                              <Badge tone="gray">{DOC_TYPE[(d.filingDocType ?? "CORRESPONDENCE") as keyof typeof DOC_TYPE]}</Badge>{" "}
                              <Badge tone={d.visibility === "PUBLISHED" ? "green" : "gray"}>{d.visibility === "PUBLISHED" ? (d.scanStatus === "CLEAN" ? "Client can see it" : "Shown after the scan") : d.reviewStatus === "AWAITING_REVIEW" ? "Waiting for Tabitha" : "Staff only"}</Badge>
                              {d.filingDocType === "RETURN" && accepted && approver && (d.reviewStatus === "DRAFT" || d.reviewStatus === "AWAITING_REVIEW") && (
                                <ActionForm action={returnStepAction.bind(null, d.id, "release")} className="ml-1 inline-block"><Button type="submit" variant="gold" className="px-2 py-0.5 text-xs" disabled={d.scanStatus === "INFECTED"}>Send to client</Button></ActionForm>
                              )}
                              {d.filingDocType && d.filingDocType !== "RETURN" && d.filingDocType !== "FIRM_SUMMARY" && (d.visibility !== "PUBLISHED" || approver) && (
                                <ActionForm action={convertToReturnCopyAction.bind(null, d.id)} className="ml-1 inline-block" confirm={`Use “${d.title}” as the ${f.taxYear} return copy? It's re-labeled in place (audited).`}>
                                  <Button type="submit" variant="ghost" className="px-2 py-0.5 text-xs" data-testid="ack-is-return">This is the return, not the acknowledgment</Button>
                                </ActionForm>
                              )}
                              {(d.visibility !== "PUBLISHED" || approver) && (
                                <details className="ml-1 inline-block align-top text-xs" data-testid="fix-filing-doc">
                                  <summary className="cursor-pointer text-slate-600 underline">Misfiled? Fix</summary>
                                  <div className="mt-1 space-y-1 rounded-lg border border-ivory-200 bg-white p-2">
                                    <ActionForm action={relabelFilingDocAction.bind(null, d.id)} className="flex flex-wrap items-end gap-1">
                                      <select className="input w-auto" name="to" defaultValue={d.filingDocType === "RETURN" ? "OFFICIAL_ACK" : "RETURN"} aria-label="Re-label as">
                                        <option value="RETURN">The return</option><option value="OFFICIAL_ACK">Official acknowledgment</option><option value="AGENCY_NOTICE">Agency notice</option><option value="CORRESPONDENCE">Correspondence</option>
                                      </select>
                                      <Button type="submit" variant="secondary">Re-label</Button>
                                    </ActionForm>
                                    <ActionForm action={removeFilingDocAction.bind(null, d.id)} className="flex flex-wrap items-end gap-1" confirm="Remove this document from the filing? It's kept in the audit trail.">
                                      <input className="input w-48" name="reason" placeholder="Why remove it? (e.g. wrong file)" aria-label="Why remove it?" />
                                      <Button type="submit" variant="ghost">Remove</Button>
                                    </ActionForm>
                                    {canFix && filings.length > 1 && (
                                      <ActionForm action={moveFilingDocAction.bind(null, d.id)} className="flex flex-wrap items-end gap-1">
                                        <select className="input w-auto" name="filingId" defaultValue="" aria-label="Move to filing" required>
                                          <option value="">Move to another filing…</option>
                                          {filings.filter((o) => o.id !== f.id).map((o) => <option key={o.id} value={o.id}>{filingTitle(o)}</option>)}
                                        </select>
                                        <Button type="submit" variant="secondary">Move</Button>
                                      </ActionForm>
                                    )}
                                    {d.visibility === "PUBLISHED" && <p className="text-slate-600">Published to the client — only you can change it.</p>}
                                  </div>
                                </details>
                              )}
                            </li>
                          ))}
                    </ul>
                  ) : (
                    <p className="mt-2 text-sm text-slate-600">No documents yet.</p>
                  )}

                  <details className="mt-3 rounded-lg border border-ivory-200 p-2" data-testid="more-options">
                    <summary className="cursor-pointer text-sm font-semibold text-slate-700">More options</summary>
                    <p className="mt-1 text-xs text-slate-600">For the rare cases: Submitted, Rejected, extensions, notices.</p>
                    <div className="mt-3 space-y-3">
                    <ActionForm action={prepStatusAction.bind(null, clientId, f.id)} className="flex flex-wrap items-end gap-2" showSuccess={false}>
                      <Field label="Preparation status">
                        <select className="input" name="prepStatus" defaultValue={f.prepStatus}>{Object.entries(PREP_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
                      </Field>
                      <Button type="submit" variant="secondary">Update</Button>
                    </ActionForm>

                    <details>
                      <summary className="cursor-pointer text-sm font-semibold underline">Record a filing status (audited)</summary>
                      <ActionForm action={filingStatusAction.bind(null, clientId, f.id)} className="mt-2 grid gap-2 sm:grid-cols-2" resetOnSuccess>
                        <Field label="Status">
                          <select className="input" name="filingStatus" defaultValue={nextFilingStatus(f.filingStatus)} data-testid="status-select">{Object.entries(FILING_LABELS).map(([k, v]) => <option key={k} value={k}>{v}{k === f.filingStatus ? " (current)" : ""}</option>)}</select>
                        </Field>
                        <Field label="Status date" hint={f.statusAsOf ? <span data-testid="status-date-hint">Must be after {fmtDateTime(f.statusAsOf)} ({FILING_LABELS[f.filingStatus].toLowerCase()} recorded then). Leave empty for now.</span> : "Leave empty for now."}>
                          <input className="input" type="datetime-local" name="eventAt" min={f.statusAsOf ? utcToChicagoLocal(f.statusAsOf) : undefined} max={utcToChicagoLocal(new Date())} />
                        </Field>
                        {f.filingType !== "EXTENSION" && (
                          <Field label="Accepted return PDF (client copy)" className="sm:col-span-2" hint={approver ? "For Accepted: the return itself. It's filed on this return and sent straight to the client's vault (shown once the malware scan passes)." : "For Accepted: the return itself. It's filed on this return; Tabitha releases it to the client."}>
                            <input className="input" type="file" name="returnFile" accept="application/pdf" data-testid="status-return-file" />
                          </Field>
                        )}
                        <Field label="IRS/state acceptance confirmation (not the return)" hint="Optional. The acknowledgment notice only — put the return PDF in the box above."><input className="input" type="file" name="ackFile" accept="application/pdf,image/png,image/jpeg" /></Field>
                        <Field label="…or an existing acknowledgment">
                          <select className="input" name="evidenceDocumentId" defaultValue=""><option value="">—</option>{docs.map((d) => <option key={d.id} value={d.id}>{d.title}</option>)}</select>
                        </Field>
                        <Field label="How you verified it" className="sm:col-span-2" hint="Required for Accepted without a document, e.g. “Checked IRS ack in TaxAct E-file Center 4/2”.">
                          <input className="input" name="verificationNote" />
                        </Field>
                        {f.filingStatus === "NOT_SUBMITTED" && f.filingType !== "EXTENSION" && req?.required && (
                          <div className="rounded-lg border border-gold-500/50 bg-gold-50 p-3 text-sm sm:col-span-2" data-testid="owner-filing-gate">
                            <p className="font-semibold">Owner filing — Tabitha only</p>
                            <p className="text-xs text-slate-700">{req.approved ? `Client approved the ${f.taxYear} summary (version ${req.approved.version}) — ready for owner filing.` : `No client-approved ${f.taxYear} summary yet. Send the summary for approval first.`}</p>
                            {f.method === "ELECTRONIC" && <label className="mt-2 flex items-start gap-2"><input type="checkbox" name="form8879" className="mt-1 accent-navy-900" /> Signed IRS Form 8879 (and any state e-file authorization) is on file. The summary approval does not replace it.</label>}
                            {!req.approved && <PresetReason className="mt-2" />}
                            {!approver && <p className="mt-1 text-xs font-semibold text-red-800">Only Tabitha can record a return as submitted.</p>}
                          </div>
                        )}
                        <Field label="Submission ID / reference"><input className="input" name="filingReference" defaultValue={f.filingReference ?? ""} /></Field>
                        <Field label="Rejection codes"><input className="input" name="rejectionCodes" /></Field>
                        <div><Button type="submit">Record status</Button></div>
                      </ActionForm>
                    </details>

                    {f.filingType === "AMENDED" && (
                      <details>
                        <summary className="cursor-pointer text-sm font-semibold underline">Amendment outcome (after acceptance)</summary>
                        <ActionForm action={amendmentOutcomeAction.bind(null, clientId, f.id)} className="mt-2 flex flex-wrap items-end gap-2">
                          <select className="input w-auto" name="outcome" defaultValue={f.amendmentOutcome} aria-label="Outcome">{Object.entries(AMENDMENT_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
                          <input className="input w-56" name="note" placeholder="Source (e.g. IRS letter 3/4)" aria-label="Source" />
                          <Button type="submit" variant="secondary">Save</Button>
                        </ActionForm>
                        <p className="mt-1 text-xs text-slate-600">Acceptance for processing is not the same as processing complete, changes approved, or a refund issued.</p>
                      </details>
                    )}

                      <details className="mt-1">
                        <summary className="cursor-pointer text-sm underline">Attach acknowledgment, notice or correspondence</summary>
                        <ActionForm action={attachFilingDocAction.bind(null, clientId, f.id)} className="mt-2 grid gap-2 sm:grid-cols-2" resetOnSuccess>
                          <select className="input" name="docType" defaultValue="OFFICIAL_ACK" aria-label="Document type">
                            <option value="OFFICIAL_ACK">Official acknowledgment</option><option value="AGENCY_NOTICE">Agency notice</option><option value="CORRESPONDENCE">Correspondence</option>
                          </select>
                          <select className="input" name="documentId" defaultValue="" aria-label="Existing document"><option value="">Upload a new file…</option>{docs.map((d) => <option key={d.id} value={d.id}>{d.title}</option>)}</select>
                          <input className="input" type="file" name="file" accept="application/pdf,image/png,image/jpeg" aria-label="File" />
                          <input className="input" name="title" placeholder="Title" aria-label="Title" />
                          <div><Button type="submit" variant="secondary">Attach</Button></div>
                        </ActionForm>
                      </details>

                    <ActionForm action={publishFilingAction.bind(null, clientId, f.id)} className="rounded-lg border border-ivory-200 bg-ivory-50 p-3 text-sm">
                      <p className="mb-2 font-semibold">Publish to client portal</p>
                      <label className="flex items-center gap-2"><input type="checkbox" name="notifyClient" className="accent-navy-900" /> Notify the client</label>
                      <div className="ml-6 flex gap-4">
                        <label className="flex items-center gap-1"><input type="checkbox" name="notify" value="EMAIL" defaultChecked className="accent-navy-900" /> Email</label>
                        <label className="flex items-center gap-1"><input type="checkbox" name="notify" value="SMS" className="accent-navy-900" /> Text</label>
                        <span className="text-slate-500">(portal notice always)</span>
                      </div>
                      <p className="my-2 text-xs text-slate-600">Notices say a filing update is available with a sign-in link — no return, amounts or IDs. {f.filingType === "EXTENSION" && accepted && "Clients will see “Extension Accepted”, separate from the return."}</p>
                      <Button type="submit" variant="secondary">Publish status & documents</Button>
                    </ActionForm>

                    {canFix && (
                      <details className="text-sm" data-testid="fix-filing">
                        <summary className="cursor-pointer font-semibold underline">Edit filing details or remove this filing</summary>
                        <ActionForm action={editFilingDetailsAction.bind(null, f.id)} className="mt-2 grid gap-2 sm:grid-cols-2">
                          <Field label="Tax year"><input className="input" name="taxYear" defaultValue={f.taxYear} inputMode="numeric" required /></Field>
                          <Field label="Return type" hint="e.g. 40 for an Alabama return entered as 1040"><input className="input" name="returnType" defaultValue={f.returnType} required /></Field>
                          <Field label="Jurisdiction"><input className="input" name="jurisdiction" defaultValue={f.jurisdiction === "FEDERAL" ? "Federal" : f.jurisdiction} required /></Field>
                          <Field label="Filing type">
                            <select className="input" name="filingType" defaultValue={f.filingType}><option value="ORIGINAL">Original return</option><option value="AMENDED">Amended return</option><option value="EXTENSION">Extension</option></select>
                          </Field>
                          <Field label="Why the correction? (required)" className="sm:col-span-2"><input className="input" name="reason" required /></Field>
                          <div><Button type="submit" variant="secondary">Save corrected details</Button></div>
                        </ActionForm>
                        <ActionForm action={removeFilingAction.bind(null, f.id)} className="mt-3 flex flex-wrap items-end gap-2 border-t border-ivory-200 pt-3" confirm="Remove this filing? Its full history is kept in the audit log and its documents stay in the client's file.">
                          <Field label="Remove filing (created by mistake) — why?"><input className="input w-72" name="reason" required /></Field>
                          <Button type="submit" variant="danger">Remove filing</Button>
                        </ActionForm>
                        <p className="mt-1 text-xs text-slate-600">Only you or an Admin can do this. A filing whose return copy is already in the client&apos;s vault can&apos;t be removed until that copy is moved to the right filing.</p>
                      </details>
                    )}

                    <details className="text-xs">
                      <summary className="cursor-pointer text-slate-600">Status history</summary>
                      <ul className="mt-1 space-y-0.5 text-slate-600">
                        {f.events.map((e) => (
                          <li key={e.id}>
                            {fmtDate(e.eventAt)} · {e.field === "PREP" ? "Preparation" : e.field === "AMENDMENT" ? "Amendment" : e.field === "OWNER_CONFIRM" ? "Tabitha's confirmation" : e.field === "DETAILS" ? "Details corrected" : "Filing"}: {e.fromValue?.toLowerCase().replace(/_/g, " ") ?? "—"} → {e.toValue.toLowerCase().replace(/_/g, " ")} · {e.source === "TAXACT_IMPORT" ? "TaxAct import" : staffNames.get(e.actorId ?? "") ?? "staff"}
                            {e.verificationNote && ` · “${e.verificationNote}”`}
                          </li>
                        ))}
                      </ul>
                    </details>
                    </div>
                  </details>
                </Card>
              );
            })}
          </div>
        </section>
      ))}

      <details className="rounded-xl border border-ivory-200 bg-white p-3">
        <summary className="cursor-pointer text-sm font-semibold text-slate-700">Add a filing by hand · TaxAct client ID</summary>
        <div className="mt-3 grid gap-4 lg:grid-cols-2">
        <Card title="Add a filing">
          <ActionForm action={createFilingAction.bind(null, clientId)} className="grid gap-2 sm:grid-cols-2" resetOnSuccess>
            <Field label="Tax year"><input className="input" name="taxYear" defaultValue={thisYear - 1} inputMode="numeric" required /></Field>
            <Field label="Return type"><input className="input" name="returnType" placeholder="1040, 1120-S, 4868, 1040-X…" required /></Field>
            <Field label="Jurisdiction" hint="Federal, or a two-letter state. Each state is its own filing.">
              <input className="input" name="jurisdiction" defaultValue="Federal" required />
            </Field>
            <Field label="Filing type">
              <select className="input" name="filingType" defaultValue="ORIGINAL"><option value="ORIGINAL">Original return</option><option value="EXTENSION">Extension</option><option value="AMENDED">Amended return</option></select>
            </Field>
            <Field label="Method">
              <select className="input" name="method" defaultValue="ELECTRONIC"><option value="ELECTRONIC">E-file</option><option value="PAPER">Paper (mailed)</option></select>
            </Field>
            <div className="flex items-end"><Button type="submit">Add filing</Button></div>
          </ActionForm>
        </Card>
        <Card title="TaxAct link">
          <ActionForm action={setTaxSoftwareIdAction.bind(null, clientId)} className="flex flex-wrap items-end gap-2">
            <Field label="TaxAct client ID" hint="Used to match e-file status imports. Records are never matched by name alone.">
              <input className="input" name="taxSoftwareId" defaultValue={client.taxSoftwareId ?? ""} />
            </Field>
            <Button type="submit" variant="secondary">Save</Button>
          </ActionForm>
        </Card>
        </div>
      </details>
    </div>
  );
}
