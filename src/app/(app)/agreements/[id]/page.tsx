import Link from "next/link";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { ActionForm } from "@/components/action-form";
import { AgreementBuilder } from "@/components/agreements/builder";
import { AgreementText, StatusBadge } from "@/components/agreements/bits";
import { Button, Card, Notice, PageHeader } from "@/components/ui";
import { addInvoiceAction, askToSendAction, newLinkAction, prepareRenewalAction, sendAgreementAction, updateAgreementAction, voidAgreementAction } from "@/app/actions/agreements";
import { requireUser } from "@/lib/auth/session";
import { can } from "@/lib/auth/permissions";
import { prisma } from "@/lib/prisma";
import { isReportApprover } from "@/lib/services/bookkeeping-clients";
import { agreementDetail, library, portalRecipients, prefillOptions, renderFor, sendBlockers, templates } from "@/lib/services/agreements";
import { downloadToken } from "@/lib/services/documents";
import type { AgreementOptions } from "@/lib/agreements/catalog";
import { fmtDate, fmtDateTime } from "@/lib/format";

export const metadata = { title: "Agreement" };

export default async function AgreementPage({ params }: { params: Promise<{ id: string }> }) {
  await connection();
  const user = await requireUser();
  const { id } = await params;
  const a = await agreementDetail(id);
  if (!a) notFound();
  const full = await prisma.clientAgreement.findUniqueOrThrow({ where: { id }, include: { client: { select: { displayName: true, businessName: true, clientType: true } } } });
  const [r, owner, mayInvoice, recipients] = await Promise.all([renderFor(full), isReportApprover(user), can(user, "billing", "create"), portalRecipients(a.clientId)]);
  const editable = a.status === "DRAFT" || a.status === "WAITING_FOR_OWNER";
  const blockers = editable ? await sendBlockers(full) : [];
  const o = a.options as unknown as AgreementOptions;
  const tpl = editable ? (await templates()).find((t) => t.key === a.template.key) : null;
  const lib = editable ? await library() : [];
  // The draft keeps the template version it started with.
  const tv = editable ? await prisma.agreementTemplateVersion.findUnique({ where: { templateId_version: { templateId: a.templateId, version: a.templateVersion } } }) : null;

  return (
    <>
      <PageHeader
        title={a.title}
        subtitle={<span className="flex flex-wrap items-center gap-2"><Link className="underline" href={`/clients/${a.clientId}?tab=services`}>{a.clientLabel}</Link> · {a.template.name} · template v{a.templateVersion} <StatusBadge status={a.display} /></span>}
        actions={<Link className="text-sm underline" href="/agreements">← All agreements</Link>}
      />

      <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)]">
        <Card title={r.frozen ? "Agreement text (frozen when sent)" : "Preview (draft)"}>
          <AgreementText r={r} />
          {r.questions.length > 0 && <ul className="mt-4 space-y-1 text-sm">{r.questions.map((q) => <li key={q.key}><strong>{q.text}</strong> {q.choices.join(" / ")}</li>)}</ul>}
          {r.frozen && <p className="mt-4 break-all text-xs text-slate-600">Text fingerprint (SHA-256): {a.textHash}</p>}
        </Card>

        <div className="space-y-4">
          {editable && (
            <Card title="Send">
              {blockers.length > 0 ? (
                <div data-testid="send-blockers"><Notice tone="warn" title="Not ready to send"><ul className="list-disc pl-5">{blockers.map((b) => <li key={b}>{b}</li>)}</ul></Notice></div>
              ) : <p className="mb-2 text-sm text-emerald-800">Ready to send.</p>}
              {a.status === "WAITING_FOR_OWNER" && <p className="my-2 text-sm text-slate-700">Waiting for Tabitha since {fmtDateTime(a.requestedAt)}.</p>}
              {owner ? (
                <div className="mt-3 flex flex-wrap gap-2">
                  {recipients.length > 0 && <ActionForm action={sendAgreementAction.bind(null, id, "PORTAL")}><Button type="submit" variant="gold" disabled={blockers.length > 0} data-testid="send-portal">Send through the portal ({recipients.length} login{recipients.length === 1 ? "" : "s"})</Button></ActionForm>}
                  <ActionForm action={sendAgreementAction.bind(null, id, "LINK")}><Button type="submit" variant={recipients.length ? "secondary" : "gold"} disabled={blockers.length > 0} data-testid="send-link">Create a secure signing link</Button></ActionForm>
                  <p className="w-full text-xs text-slate-600">{recipients.length ? "The portal notice carries only a sign-in link." : "This client has no portal login. The link works once and expires in 14 days; you copy it, or email it from here after sending."}</p>
                </div>
              ) : a.status === "DRAFT" ? (
                <ActionForm action={askToSendAction.bind(null, id)} className="mt-3"><Button type="submit" variant="gold" data-testid="ask-tabitha">Ask Tabitha to send</Button></ActionForm>
              ) : null}
            </Card>
          )}

          {(a.status === "SENT" || a.status === "EXPIRED") && (
            <Card title="Waiting for the client">
              <p className="text-sm">Sent {fmtDateTime(a.sentAt)} by {a.sentVia === "LINK" ? "secure signing link" : "portal notice"}.{a.signBy && ` Sign by ${fmtDate(a.signBy)}.`}</p>
              <ul className="mt-2 text-xs text-slate-600">{a.links.map((l) => <li key={l.id}>Link made {fmtDateTime(l.createdAt)} · {l.usedAt ? `used ${fmtDateTime(l.usedAt)}` : l.revokedAt ? "replaced" : l.expiresAt < new Date() ? "expired" : `expires ${fmtDate(l.expiresAt)}`}{l.emailedTo ? ` · emailed to ${l.emailedTo}` : ""}</li>)}</ul>
              {owner && (
                <div className="mt-3 flex flex-wrap gap-2">
                  <ActionForm action={newLinkAction.bind(null, id, false)}><Button type="submit" variant="secondary" data-testid="new-link">New signing link</Button></ActionForm>
                  <ActionForm action={newLinkAction.bind(null, id, true)} confirm="Email a new signing link to the client's email on file? Earlier links stop working."><Button type="submit" variant="ghost">Email a new link to the client</Button></ActionForm>
                </div>
              )}
            </Card>
          )}

          {a.status === "SIGNED" && (
            <Card title="Signed">
              <dl className="grid gap-1 text-sm" data-testid="signing-evidence">
                <div><dt className="inline font-semibold">Signed: </dt><dd className="inline">{fmtDateTime(a.signedAt)} by {a.signerName}</dd></div>
                <div><dt className="inline font-semibold">Confirmed: </dt><dd className="inline">{a.signerAddress} · {a.signerPhone} · {a.signerEmail}</dd></div>
                {(a.signerAnswers as { question: string; answer: string }[] | null)?.map((q) => <div key={q.question}><dt className="inline font-semibold">{q.question} </dt><dd className="inline">{q.answer}</dd></div>)}
                <div><dt className="inline font-semibold">Via: </dt><dd className="inline">{a.signedViaLinkId ? `secure link ${a.signedViaLinkId}` : `portal login ${a.signedByPortalId}`}</dd></div>
                <div><dt className="inline font-semibold">IP / browser: </dt><dd className="inline break-all">{a.signerIp ?? "—"} · {a.signerAgent ?? "—"}</dd></div>
              </dl>
              {a.pdfDocumentId && <a className="mt-2 inline-block font-semibold underline" href={`/api/documents/${downloadToken(a.pdfDocumentId, { staffId: user.id })}`} target="_blank" rel="noopener" data-testid="signed-pdf">Signed PDF (Documents › Contracts)</a>}
              {a.termEndDate && <p className="mt-2 text-sm">Term ends {fmtDate(a.termEndDate)}.</p>}
              {a.termEndDate && (a.display === "RENEWAL_DUE" || a.display === "EXPIRED") && (
                <ActionForm action={prepareRenewalAction.bind(null, id)} className="mt-2"><Button type="submit" variant="gold" data-testid="prepare-renewal">Prepare renewal (+{o.renewalIncreasePct ?? 3}%)</Button></ActionForm>
              )}
              {a.renewals.length > 0 && <p className="mt-2 text-sm"><Link className="underline" href={`/agreements/${a.renewals[0].id}`}>Renewal draft</Link></p>}
            </Card>
          )}
          {a.status === "DECLINED" && <Notice tone="warn" title={`Declined ${fmtDateTime(a.declinedAt)}`}>{a.declineReason}</Notice>}
          {a.renews && <p className="text-sm">Renews <Link className="underline" href={`/agreements/${a.renews.id}`}>{a.renews.title}</Link>.</p>}

          {a.status !== "VOID" && (
            <Card title="Invoice">
              {a.invoices.length ? (
                <ul className="text-sm" data-testid="linked-invoices">{a.invoices.map((i) => <li key={i.id}><Link className="underline" href={`/owner/invoices/${i.id}`}>{i.number}</Link> · {i.state === "DRAFT" ? "Draft" : i.state.charAt(0) + i.state.slice(1).toLowerCase()}</li>)}</ul>
              ) : mayInvoice ? (
                <ActionForm action={addInvoiceAction.bind(null, id)}><Button type="submit" variant="secondary" data-testid="add-invoice">Add invoice to this agreement</Button></ActionForm>
              ) : <p className="text-sm text-slate-600">Adding an invoice needs Billing → Create access.</p>}
              <p className="mt-2 text-xs text-slate-600">Made in the existing Invoices system as a draft, from this agreement&apos;s fees. Nothing is sent.</p>
            </Card>
          )}

          {(editable || ((a.status === "SENT" || a.status === "EXPIRED") && owner)) && (
            <details className="rounded-xl border border-navy-100 bg-white p-3 text-sm">
              <summary className="cursor-pointer font-semibold">Void this agreement</summary>
              <ActionForm action={voidAgreementAction.bind(null, id)} className="mt-2 flex gap-2"><input className="input" name="reason" placeholder="Reason" required aria-label="Reason" /><Button type="submit" variant="danger">Void</Button></ActionForm>
            </details>
          )}

          <Card title="History">
            <ul className="space-y-1 text-xs text-slate-700" data-testid="agreement-history">{a.history.map((h) => <li key={h.id}>{fmtDateTime(h.createdAt)} · {h.action.replace("agreement_center.", "").replace(/_/g, " ")}{h.actor ? ` · ${h.actor.name}` : " · client"}</li>)}</ul>
          </Card>
        </div>
      </div>

      {editable && tpl && (
        <details className="mt-6 rounded-xl border border-navy-100 bg-ivory-50 p-4" open={blockers.length > 0}>
          <summary className="cursor-pointer font-serif text-lg font-bold text-navy-900">Edit options</summary>
          <div className="mt-4">
            <AgreementBuilder
              action={updateAgreementAction.bind(null, id)}
              templates={[{ key: tpl.key, name: tpl.name, description: tpl.description, title: tv?.title ?? tpl.title, intro: tv?.intro ?? tpl.intro, clauseKeys: tv?.clauseKeys ?? tpl.clauseKeys, version: a.templateVersion }]}
              library={lib.map((c) => ({ key: c.key, title: c.title, kind: c.kind, version: c.version, status: c.status, body: c.body }))}
              clientName={a.clientLabel}
              clientId={a.clientId}
              prefills={{ [tpl.key]: await prefillOptions(a.clientId, tpl.key) }}
              initialTemplate={tpl.key}
              initialOptions={o}
              initialTitle={a.title}
              lockTemplate
            />
          </div>
        </details>
      )}
    </>
  );
}
