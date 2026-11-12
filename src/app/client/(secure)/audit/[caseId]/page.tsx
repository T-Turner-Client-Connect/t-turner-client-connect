import Link from "next/link";
import { notFound } from "next/navigation";
import { ActionForm } from "@/components/action-form";
import { Badge, Button, Card, Field, PageHeader } from "@/components/ui";
import { auditSubmittedAction, auditUploadAction } from "@/app/actions/audit-center";
import { portalViewer } from "@/lib/portal/viewer";
import { PreviewDisabled } from "@/components/portal/preview-off";
import { AUDIT_KINDS, AUDIT_STATUS, portalAuditCase } from "@/lib/services/audit-center";
import { fmtDate } from "@/lib/format";

export const metadata = { title: "Audit" };

export default async function AuditCasePage({ params, searchParams }: { params: Promise<{ caseId: string }>; searchParams: Promise<{ account?: string }> }) {
  const { caseId } = await params;
  const sp = await searchParams;
  const v = await portalViewer("audit", sp.account);
  const { user, current } = v;
  if (!current || !user) return notFound();
  const a = await portalAuditCase(user, current.clientId, caseId).catch(() => null);
  if (!a) return notFound();
  const q = `?account=${current.clientId}`;
  const pkg = `/api/client/audit/${a.id}/package${q}`;
  return (
    <>
      <p className="mb-2 text-sm"><Link className="underline" href={`/client/audit${q}`}>← Audit</Link></p>
      <PageHeader title={`${AUDIT_KINDS[a.kind]}${a.stateCode ? ` (${a.stateCode})` : ""} — tax year ${a.taxYear}`} subtitle={`Status: ${a.packageReady && a.status === "PACKAGE_READY" ? "Audit Package — Ready to Print" : AUDIT_STATUS[a.status]}${a.responseDueOn ? ` · response due ${fmtDate(a.responseDueOn)}` : ""}`} />

      {a.packageReady && (
        <Card title="Audit Package — Ready to Print" className="mb-4" >
          <div data-testid="audit-package-ready" className="flex flex-wrap gap-3">
            <a className="btn btn-primary inline-flex rounded-lg bg-navy-900 px-4 py-2 text-sm font-semibold text-white" href={pkg} target="_blank" rel="noreferrer">View Audit Package</a>
            <a className="inline-flex rounded-lg border-[1.5px] border-navy-900 px-4 py-2 text-sm font-semibold text-navy-900" href={`${pkg}&download=1`}>Download Complete PDF</a>
            <a className="inline-flex rounded-lg border-[1.5px] border-navy-900 px-4 py-2 text-sm font-semibold text-navy-900" href={pkg} target="_blank" rel="noreferrer">Print Audit Package</a>
          </div>
          {(a.respondTo || a.responseInstructions || a.responseDueOn) && (
            <div className="mt-3 text-sm text-slate-700">
              {a.responseDueOn && <p><strong>Respond by:</strong> {fmtDate(a.responseDueOn)}</p>}
              {a.respondTo && <p className="whitespace-pre-line"><strong>Send to:</strong> {a.respondTo}</p>}
              {a.responseInstructions && <p className="whitespace-pre-line"><strong>Instructions:</strong> {a.responseInstructions}</p>}
            </div>
          )}
          <p className="mt-2 text-xs text-slate-600">Our office does not send this to the agency. Submit it as the notice instructs, then record it below.</p>
        </Card>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        <Card title={`Documents needed (${a.needed.length})`}>
          {a.needed.length ? (
            <ul className="space-y-4" data-testid="audit-needed">
              {a.needed.map((n) => (
                <li key={n.id} className="text-sm">
                  <p className="font-semibold text-navy-900">{n.title}</p>
                  <p className="text-xs text-slate-600">For: {n.item}{n.instructions ? ` · ${n.instructions}` : ""}</p>
                  {current.canUpload && (
                    <PreviewDisabled readOnly={v.readOnly}>
                      <ActionForm action={v.act(auditUploadAction, current.clientId, a.id, n.id)} className="mt-1 flex flex-wrap items-center gap-2" resetOnSuccess>
                        <input className="input w-auto" type="file" name="file" multiple required accept="application/pdf,image/*" />
                        <Button type="submit" variant="secondary">Upload</Button>
                      </ActionForm>
                    </PreviewDisabled>
                  )}
                </li>
              ))}
            </ul>
          ) : <p className="text-sm text-slate-600">Nothing is needed from you right now.</p>}
          {current.canUpload && (
            <details className="mt-4 text-sm">
              <summary className="cursor-pointer text-navy-700">Send another document for this audit</summary>
              <PreviewDisabled readOnly={v.readOnly}>
                <ActionForm action={v.act(auditUploadAction, current.clientId, a.id, null)} className="mt-2 flex flex-wrap items-center gap-2" resetOnSuccess>
                  <input className="input w-auto" type="file" name="file" multiple required accept="application/pdf,image/*" />
                  <Button type="submit" variant="secondary">Upload</Button>
                </ActionForm>
              </PreviewDisabled>
            </details>
          )}
        </Card>
        <Card title={`Documents received (${a.received.length})`}>
          {a.received.length ? (
            <ul className="divide-y divide-ivory-200 text-sm" data-testid="audit-received">
              {a.received.map((d) => <li key={d.id} className="py-1.5">{d.title} <span className="text-xs text-slate-500">· {fmtDate(d.at)}</span></li>)}
            </ul>
          ) : <p className="text-sm text-slate-600">None yet.</p>}
          {a.items.length > 0 && (
            <>
              <p className="mt-4 text-xs font-semibold uppercase tracking-wide text-slate-500">Items being examined</p>
              <ul className="mt-1 list-disc pl-5 text-sm">{a.items.map((i) => <li key={i}>{i}</li>)}</ul>
            </>
          )}
        </Card>
      </div>

      {a.packageReady && (
        <Card title="Record your submission" className="mt-4 max-w-2xl">
          {a.submittedAt ? (
            <p className="text-sm"><Badge tone="green">Submitted</Badge> on {fmtDate(a.submittedAt)}. Our office has been told.</p>
          ) : current.canUpload ? (
            <PreviewDisabled readOnly={v.readOnly}>
              <ActionForm action={v.act(auditSubmittedAction, current.clientId, a.id)} className="grid gap-3 sm:grid-cols-2">
                <Field label="Date you submitted it"><input className="input" type="date" name="submittedOn" required /></Field>
                <Field label="How you submitted it"><input className="input" name="method" required placeholder="Mail, fax, the agency's online portal..." /></Field>
                <Field label="Proof of submission (optional): receipt, confirmation page" className="sm:col-span-2"><input className="input" type="file" name="file" multiple accept="application/pdf,image/*" /></Field>
                <div className="sm:col-span-2"><Button type="submit">I submitted my response</Button></div>
              </ActionForm>
            </PreviewDisabled>
          ) : null}
        </Card>
      )}
    </>
  );
}
