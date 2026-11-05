import Link from "next/link";
import type { Actor } from "@/lib/auth/actor";
import { returnStepAction } from "@/app/actions/tax-returns";
import { deliverAcceptedReturnAction, relabelFilingDocAction, removeFilingDocAction } from "@/app/actions/accepted-returns";
import { AcceptedReturnFields } from "@/components/accepted-return-fields";
import { AcceptanceQueue } from "@/components/acceptance-queue";
import { PresetReason } from "@/components/preset-reason";
import { deliveryContext } from "@/lib/services/accepted-returns";
import { nextFilingStatus } from "@/lib/services/tax";
import { utcToChicagoLocal } from "@/lib/tz";
import { filingLabel, RETURN_COPY_STATUS } from "@/lib/services/tax-returns";
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
  const [returnDocs, approver] = await Promise.all([
    prisma.document.findMany({ where: { clientId, filingDocType: "RETURN", deletedAt: null }, include: { filing: { select: { filingStatus: true } } }, orderBy: [{ year: "desc" }, { createdAt: "desc" }] }),
    isReportApprover(user),
  ]);
  const requirements = new Map(await Promise.all(filings.map(async (f) => [f.id, await summaryRequirement(f)] as const)));
  const staffNames = new Map((await prisma.user.findMany({ select: { id: true, name: true } })).map((u) => [u.id, u.name]));
  const years = Array.from(new Set(filings.map((f) => f.taxYear)));
  const ctx = await deliveryContext(clientId, user);

  const thisYear = new Date().getFullYear();

  return (
    <div className="space-y-4">
      <TaxPrepCases clientId={clientId} user={user} />
      <TaxCenterStaff clientId={clientId} user={user} />
      <TaxSummaryStaff clientId={clientId} user={user} />
      <AcceptanceQueue approver={approver} clientId={clientId} />
      <div id="deliver-accepted">
      <Card title="Step 2 · Deliver accepted return (federal and state together)">
        <p className="mb-3 text-sm text-slate-600">
          For a return TaxAct already e-filed and the IRS/state accepted. One submit adds the filing if it&apos;s missing, records it as submitted and accepted on the date you enter (both in the status history), keeps the acknowledgment on the filing and files the return PDF.{" "}
          {approver ? "Tick “Send to the client's vault now” and it's delivered in the same step." : "Only Tabitha records a return as submitted or accepted, so your submission waits for her one-click confirmation."}
        </p>
        <ActionForm action={deliverAcceptedReturnAction.bind(null, clientId)} className="grid gap-2 sm:grid-cols-6" resetOnSuccess idempotent>
          <AcceptedReturnFields ctx={ctx} defaultYear={deliver?.year} startWithState={deliver?.state} amended={deliver?.amended} />
          <div className="sm:col-span-6"><Button type="submit">{approver ? "Deliver accepted return" : "Save for Tabitha to confirm"}</Button> <span className="text-xs text-slate-600">For many at once, use <Link className="underline" href="/taxes/returns">Tax returns</Link>.</span></div>
        </ActionForm>
        <ul className="mt-3 divide-y divide-ivory-200 text-sm" data-testid="client-returns">
          {returnDocs.map((d) => {
            const fl = filingLabel(d.filing?.filingStatus);
            const st = RETURN_COPY_STATUS[(d.reviewStatus ?? "DRAFT") as keyof typeof RETURN_COPY_STATUS];
            const waiting = d.reviewStatus === "DRAFT" || d.reviewStatus === "AWAITING_REVIEW";
            const accepted = d.filing?.filingStatus === "ACCEPTED";
            // Tabitha sees "ready to send", never "waiting for Tabitha's release".
            const stLabel = approver && waiting ? (accepted ? "Ready to send" : "Waiting for your acceptance confirmation") : !accepted && waiting ? "Waiting for Tabitha to confirm acceptance" : st.label;
            return (
              <li key={d.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <span className="min-w-0">{d.title}{d.version && d.version > 1 ? ` · version ${d.version}` : ""}{d.supersededAt ? " · replaced by a newer version" : ""} <Badge tone={st.tone as never}>{stLabel}</Badge>{fl && <Badge tone={fl.tone} className="ml-1">{fl.label}</Badge>}</span>
                {waiting && approver && accepted && <ActionForm action={returnStepAction.bind(null, d.id, "release")}><Button type="submit" variant="gold" disabled={d.scanStatus !== "CLEAN"}>Send to client</Button></ActionForm>}
                {d.reviewStatus === "DRAFT" && !approver && accepted && <ActionForm action={returnStepAction.bind(null, d.id, "submit")}><Button type="submit" variant="ghost" disabled={d.scanStatus !== "CLEAN"}>Ask Tabitha to release</Button></ActionForm>}
                {d.reviewStatus === "AWAITING_REVIEW" && !approver && <Badge tone="gold">Waiting for Tabitha</Badge>}
              </li>
            );
          })}
          {returnDocs.length === 0 && <li className="py-2 text-slate-600">No accepted returns delivered yet.</li>}
        </ul>
      </Card>
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
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

      {years.length === 0 && <EmptyState title="No filings yet">Add a filing, or import e-file statuses from TaxAct.</EmptyState>}

      {years.map((year) => (
        <section key={year} className="space-y-3">
          <h2 className="text-xl font-semibold">{year} tax year</h2>
          <div className="grid gap-4 xl:grid-cols-2">
            {filings.filter((f) => f.taxYear === year).map((f) => {
              const label = filingStatusLabel(f);
              const req = requirements.get(f.id);
              const accepted = f.filingStatus === "ACCEPTED";
              return (
                <Card key={f.id} title={filingTitle(f)} actions={<Badge tone={f.filingType === "EXTENSION" ? "gold" : f.filingType === "AMENDED" ? "amber" : "navy"}>{f.filingType === "ORIGINAL" ? "Original" : f.filingType === "EXTENSION" ? "Extension" : "Amended"}{f.method === "PAPER" ? " · paper" : ""}</Badge>}>
                  <div className="mb-3 grid gap-2 text-sm sm:grid-cols-2">
                    <div className="rounded-lg bg-ivory-50 p-3">
                      <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Preparation (internal)</p>
                      <p className="font-semibold text-navy-900">{PREP_LABELS[f.prepStatus]}</p>
                    </div>
                    <div className="rounded-lg bg-ivory-50 p-3">
                      <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Filing status</p>
                      <p className={`font-semibold ${accepted ? "text-emerald-800" : f.filingStatus === "REJECTED" ? "text-red-800" : "text-navy-900"}`}>{label}</p>
                      <p className="text-xs text-slate-600">
                        {f.lastVerifiedAt ? `Verified ${fmtDateTime(f.lastVerifiedAt)} · ${f.statusSource === "TAXACT_IMPORT" ? "TaxAct import" : "staff update"}` : "Not verified yet"}
                        {f.filingReference && ` · Ref ${f.filingReference}`}
                      </p>
                    </div>
                  </div>
                  {f.filingType === "AMENDED" && f.amendmentOutcome !== "NONE" && <p className="mb-2 text-sm">After acceptance: <strong>{AMENDMENT_LABELS[f.amendmentOutcome]}</strong></p>}
                  {f.rejectionCodes && <Notice tone="error">Rejection codes: {f.rejectionCodes}</Notice>}

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
                        <Field label="Upload acknowledgment" hint="Recommended for Accepted/Rejected."><input className="input" type="file" name="ackFile" accept="application/pdf,image/png,image/jpeg" /></Field>
                        <Field label="…or existing document">
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

                    <div>
                      <p className="text-sm font-semibold">Documents for this filing</p>
                      {f.documents.length ? (
                        <ul className="text-sm">
                          {f.documents.map((d) => (
                            <li key={d.id}>
                              <a className="underline" href={`/api/documents/${downloadToken(d.id, { staffId: user.id })}`} target="_blank" rel="noopener">{d.title}</a>{" "}
                              <Badge tone="gray">{DOC_TYPE[(d.filingDocType ?? "CORRESPONDENCE") as keyof typeof DOC_TYPE]}</Badge>{" "}
                              <Badge tone={d.visibility === "PUBLISHED" ? "green" : "gray"}>{d.visibility === "PUBLISHED" ? "Published" : "Staff only"}</Badge>
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
                                    {d.visibility === "PUBLISHED" && <p className="text-slate-600">Published to the client — only you can change it.</p>}
                                  </div>
                                </details>
                              )}
                            </li>
                          ))}
                        </ul>
                      ) : (
                        <p className="text-sm text-slate-600">None attached.</p>
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
                    </div>

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

                    <details className="text-xs">
                      <summary className="cursor-pointer text-slate-600">Status history</summary>
                      <ul className="mt-1 space-y-0.5 text-slate-600">
                        {f.events.map((e) => (
                          <li key={e.id}>
                            {fmtDate(e.eventAt)} · {e.field === "PREP" ? "Preparation" : e.field === "AMENDMENT" ? "Amendment" : e.field === "OWNER_CONFIRM" ? "Tabitha's confirmation" : "Filing"}: {e.fromValue?.toLowerCase().replace(/_/g, " ") ?? "—"} → {e.toValue.toLowerCase().replace(/_/g, " ")} · {e.source === "TAXACT_IMPORT" ? "TaxAct import" : staffNames.get(e.actorId ?? "") ?? "staff"}
                            {e.verificationNote && ` · “${e.verificationNote}”`}
                          </li>
                        ))}
                      </ul>
                    </details>
                  </div>
                </Card>
              );
            })}
          </div>
        </section>
      ))}
    </div>
  );
}
