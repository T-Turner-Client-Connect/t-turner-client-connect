import Link from "next/link";
import { connection } from "next/server";
import { ActionForm } from "@/components/action-form";
import { Badge, Button, Card, EmptyState, Field, PageHeader } from "@/components/ui";
import { bulkReleaseAction, bulkReturnsAction, returnStepAction } from "@/app/actions/tax-returns";
import { bulkDeliverAction } from "@/app/actions/accepted-returns";
import { AcceptanceQueue } from "@/components/acceptance-queue";
import { PresetReason } from "@/components/preset-reason";
import { DEFAULT_VERIFICATION } from "@/lib/tax/accepted";
import { SUMMARY_STATUS } from "@/lib/services/tax-summary";
import { requireUser } from "@/lib/auth/session";
import { prisma } from "@/lib/prisma";
import { isReportApprover } from "@/lib/services/bookkeeping-clients";
import { filingLabel, RETURN_COPY_STATUS, returnsQueue } from "@/lib/services/tax-returns";
import { fmtDateTime } from "@/lib/format";

export const metadata = { title: "Tax returns" };

const STATES = "AL AK AZ AR CA CO CT DE DC FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY".split(" ");

export default async function TaxReturnsPage() {
  await connection();
  const user = await requireUser();
  const [q, approver, clients, summaries] = await Promise.all([
    returnsQueue(),
    isReportApprover(user),
    prisma.client.findMany({ where: { archivedAt: null }, select: { id: true, displayName: true, businessName: true }, orderBy: { displayName: "asc" } }),
    prisma.taxReturnSummary.findMany({ where: { status: { in: ["SENT", "CHANGES_REQUESTED", "CLIENT_APPROVED"] } }, include: { client: { select: { id: true, displayName: true } } }, orderBy: [{ status: "asc" }, { updatedAt: "desc" }], take: 100 }),
  ]);
  const options = clients.map((c) => ({ id: c.id, name: c.businessName && c.businessName !== c.displayName ? `${c.businessName} (${c.displayName})` : c.displayName }));
  const ready = q.drafts.filter((d) => d.reviewStatus === "AWAITING_REVIEW");
  const thisYear = new Date().getFullYear();
  const years = Array.from({ length: 8 }, (_, k) => thisYear - k);
  const today = new Date().toLocaleDateString("en-CA", { timeZone: "America/Chicago" });
  const drafts = q.drafts.filter((d) => d.reviewStatus === "DRAFT");

  return (
    <>
      <PageHeader title="Tax returns" subtitle="Step 1: clients approve a Tax Return Summary before filing (Tabitha files). Step 2: after IRS/state acceptance, deliver accepted returns — federal and state together — in one step." />
      <Card title={`Step 1 · Tax Return Summaries — ${summaries.length} open`} className="mb-4">
        <ul className="divide-y divide-ivory-200 text-sm" data-testid="summary-overview">
          {summaries.map((s) => (
            <li key={s.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
              <span className="min-w-0"><Link className="underline" href={`/clients/${s.client.id}?tab=taxes`}>{s.client.displayName}</Link> · {s.taxYear}{s.filingType === "AMENDED" ? " amended" : ""} · v{s.version}</span>
              <Badge tone={SUMMARY_STATUS[s.status].tone as never}>{SUMMARY_STATUS[s.status].label}</Badge>
            </li>
          ))}
          {summaries.length === 0 && <li className="py-2 text-slate-600">No summaries waiting. Start one from the client&apos;s Taxes tab.</li>}
        </ul>
      </Card>
      <Card title="Step 2 · Upload accepted returns (several at once)" className="mb-4">
        <ActionForm action={bulkReturnsAction} className="flex flex-wrap items-end gap-2" resetOnSuccess>
          <Field label="Return PDFs (up to 50)"><input className="input" type="file" name="files" multiple accept="application/pdf" required /></Field>
          <Button type="submit">Add to review queue</Button>
        </ActionForm>
        <p className="mt-2 text-xs text-slate-600">Only returns the IRS or state has accepted. Each file waits below until you confirm the client, tax year, return and its <strong>Accepted on</strong> date (and a state, when one PDF covers federal + state). Each row goes through the same one-step delivery as a client&apos;s Taxes tab{approver ? "" : " — and waits for Tabitha to confirm acceptance"}. Suggestions come from file names only and are never applied automatically. The same file is never queued twice.</p>
      </Card>
      <div id="confirm-acceptance"><AcceptanceQueue approver={approver} /></div>

      <Card title={`Review queue — ${q.intakes.length}`} className="mb-4">
        {q.intakes.length === 0 ? <EmptyState title="Nothing waiting">Uploaded returns appear here for confirmation.</EmptyState> : (
          <ActionForm action={bulkDeliverAction} className="space-y-3">
            <ul className="divide-y divide-ivory-200" data-testid="intake-queue">
              {q.intakes.map((i) => (
                <li key={i.id} className="py-3" data-file={i.originalName}>
                  <input type="hidden" name="row" value={i.id} />
                  <input type="hidden" name={`${i.id}:name`} value={i.originalName} />
                  <p className="text-sm"><strong>{i.originalName}</strong> · uploaded {fmtDateTime(i.createdAt)}</p>
                  <p className="text-xs text-slate-600" data-testid="intake-suggestion">{i.suggested ? <>Suggested: <strong>{i.suggested.businessName || i.suggested.displayName}</strong> — {i.matchReason}. Confirm or change it.</> : <>No suggestion — {i.matchReason}. Choose the client.</>}</p>
                  <div className="mt-2 grid gap-2 sm:grid-cols-4 lg:grid-cols-8">
                    <Field label="Client / business" className="sm:col-span-2">
                      <select className="input" name={`${i.id}:clientId`} defaultValue={i.suggestedClientId ?? ""}>
                        <option value="">Choose — required</option>
                        {options.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                      </select>
                    </Field>
                    <Field label="Tax year">
                      <select className="input" name={`${i.id}:taxYear`} defaultValue={i.suggestedYear ?? ""}>
                        <option value="">Choose…</option>
                        {years.map((y) => <option key={y} value={y}>{y}</option>)}
                      </select>
                    </Field>
                    <Field label="Original or amended">
                      <select className="input" name={`${i.id}:filingType`} defaultValue="ORIGINAL"><option value="ORIGINAL">Original</option><option value="AMENDED">Amended</option></select>
                    </Field>
                    <Field label="Federal or state">
                      <select className="input" name={`${i.id}:jurisdiction`} defaultValue="FEDERAL">
                        <option value="FEDERAL">Federal</option>
                        {STATES.map((st) => <option key={st} value={st}>{st} (state)</option>)}
                      </select>
                    </Field>
                    <Field label="Return type"><input className="input" name={`${i.id}:returnType`} defaultValue={i.suggestedType ?? ""} placeholder="1040, 1120-S…" /></Field>
                    <Field label="Accepted on" hint="Blank only if already accepted (e.g. TaxAct import)."><input className="input" type="date" name={`${i.id}:acceptedOn`} max={today} data-testid="row-accepted-on" /></Field>
                    <Field label="Submission ID"><input className="input" name={`${i.id}:submissionId`} placeholder="Optional" /></Field>
                  </div>
                  <details className="mt-1 text-sm">
                    <summary className="cursor-pointer underline">Same PDF also covers a state return</summary>
                    <div className="mt-2 grid gap-2 sm:grid-cols-4">
                      <Field label="State">
                        <select className="input" name={`${i.id}:stateCode`} defaultValue="">
                          <option value="">None</option>
                          {STATES.map((st) => <option key={st} value={st}>{st}</option>)}
                        </select>
                      </Field>
                      <Field label="State form" hint="e.g. 40 for Alabama"><input className="input" name={`${i.id}:stateReturnType`} /></Field>
                      <Field label="State accepted on" hint="Blank = same as federal"><input className="input" type="date" name={`${i.id}:stateAcceptedOn`} max={today} /></Field>
                      <Field label="State submission ID"><input className="input" name={`${i.id}:stateSubmissionId`} placeholder="Optional" /></Field>
                    </div>
                  </details>
                  <div className="mt-2 flex flex-wrap items-end gap-2">
                    <Button type="submit" name="only" value={i.id} variant="secondary">Deliver this row</Button>
                    <input className="input w-64" name={`${i.id}:reason`} placeholder="Why remove it? (e.g. wrong file)" aria-label="Reason" />
                    <Button type="submit" name="discard" value={i.id} variant="ghost">Remove from queue</Button>
                  </div>
                </li>
              ))}
            </ul>
            <div className="space-y-2 rounded-lg border border-ivory-200 bg-ivory-50 p-3 text-sm">
              <Field label="How you verified the acceptance (all rows)"><input className="input" name="verificationNote" defaultValue={DEFAULT_VERIFICATION} /></Field>
              <label className="flex items-start gap-2"><input type="checkbox" name="relabelAck" className="mt-1 accent-navy-900" /> If a PDF was saved earlier as that filing&apos;s acknowledgment, re-label it as the return</label>
              {approver ? (
                <div className="rounded-lg border border-gold-500/50 bg-gold-50 p-3" data-testid="bulk-owner-box">
                  <p className="font-semibold">Owner filing — your confirmation for these rows</p>
                  <label className="mt-1 flex items-start gap-2"><input type="checkbox" name="form8879" className="mt-1 accent-navy-900" /> Signed IRS Form 8879 (and any state e-file authorization) is on file for each return I deliver here.</label>
                  <PresetReason className="mt-2" label="For returns with no client-approved summary — reason" />
                  <label className="mt-2 flex items-start gap-2"><input type="checkbox" name="sendToClient" defaultChecked className="mt-1 accent-navy-900" /> Send each to the client&apos;s vault now (shown once the malware scan passes)</label>
                  <label className="ml-6 flex items-start gap-2"><input type="checkbox" name="notifyClient" className="mt-1 accent-navy-900" /> Notify each client by email (optional, never a text)</label>
                </div>
              ) : (
                <p className="text-xs text-slate-600">Only Tabitha records a return as submitted or accepted: rows you deliver are saved as “Ready for Tabitha to confirm acceptance”. Nothing is marked submitted.</p>
              )}
              <Button type="submit">Deliver all rows with an accepted date</Button>
            </div>
          </ActionForm>
        )}
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card title={approver ? `Ready to send — ${ready.length}` : `Waiting for Tabitha's release — ${ready.length}`}>
          {approver && ready.length > 0 ? (
            <ActionForm action={bulkReleaseAction} className="space-y-2" confirm="Send the checked accepted returns to these clients' vaults?">
              <ul className="divide-y divide-ivory-200 text-sm" data-testid="ready-list">
                {ready.map((d) => (
                  <li key={d.id} className="flex flex-wrap items-center gap-2 py-2">
                    <input type="checkbox" name="documentId" value={d.id} defaultChecked disabled={d.scanStatus !== "CLEAN"} className="accent-navy-900" aria-label={`Send ${d.title}`} />
                    <span className="min-w-0"><Link className="underline" href={`/clients/${d.client.id}?tab=taxes`}>{d.title}</Link> · {d.client.businessName || d.client.displayName}{d.version && d.version > 1 ? ` · version ${d.version}` : ""}</span>
                  </li>
                ))}
              </ul>
              <Button type="submit" variant="gold">Send checked returns to clients</Button>
            </ActionForm>
          ) : (
            <ul className="divide-y divide-ivory-200 text-sm" data-testid="ready-list">
              {ready.map((d) => (
                <li key={d.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                  <span className="min-w-0"><Link className="underline" href={`/clients/${d.client.id}?tab=taxes`}>{d.title}</Link> · {d.client.businessName || d.client.displayName}</span>
                  <Badge tone="gold">Waiting for Tabitha</Badge>
                </li>
              ))}
              {ready.length === 0 && <li className="py-2 text-slate-600">None.</li>}
            </ul>
          )}
        </Card>
        <Card title={`Uploaded, not sent yet — ${drafts.length}`}>
          <ul className="divide-y divide-ivory-200 text-sm" data-testid="draft-list">
            {drafts.map((d) => {
              const fl = filingLabel(d.filing?.filingStatus);
              return (
                <li key={d.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                  <span><Link className="underline" href={`/clients/${d.client.id}?tab=taxes`}>{d.title}</Link> · {d.client.businessName || d.client.displayName} <Badge tone="gray">{RETURN_COPY_STATUS.DRAFT.label}</Badge>{fl && <Badge tone={fl.tone} className="ml-1">{fl.label}</Badge>}</span>
                  {approver ? (
                    <ActionForm action={returnStepAction.bind(null, d.id, "release")}><Button type="submit" variant="gold" disabled={d.scanStatus !== "CLEAN"}>Send to client</Button></ActionForm>
                  ) : (
                    <ActionForm action={returnStepAction.bind(null, d.id, "submit")}><Button type="submit" variant="secondary" disabled={d.scanStatus !== "CLEAN"}>Ask Tabitha to release</Button></ActionForm>
                  )}
                </li>
              );
            })}
            {drafts.length === 0 && <li className="py-2 text-slate-600">None.</li>}
          </ul>
        </Card>
      </div>
      <p className="mt-4 text-xs text-slate-600">“Accepted Return” appears only when the filing record shows Accepted with the acknowledgment or a described verification. Uploading a PDF never marks a return accepted.</p>
    </>
  );
}
