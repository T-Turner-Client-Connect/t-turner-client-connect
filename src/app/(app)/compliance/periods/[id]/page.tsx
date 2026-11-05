import Link from "next/link";
import { notFound } from "next/navigation";
import { ExternalLink } from "lucide-react";
import { ActionForm } from "@/components/action-form";
import { Badge, Button, Card, Notice, PageHeader } from "@/components/ui";
import { ComplianceNav, fmtD, money, NeedsVerification, StatusBadge, SwitchesBanner } from "@/components/compliance/bits";
import { requireCompliancePage } from "@/lib/compliance/page-gate";
import { clientStatus, periodWorkspace } from "@/lib/services/compliance/views";
import { DOC_KINDS, FILING_CHANNELS, PAYMENT_STATUS } from "@/lib/services/compliance/periods";
import { complianceSettings } from "@/lib/services/compliance/settings";
import { downloadToken } from "@/lib/services/documents";
import * as A from "@/app/actions/compliance";

export const metadata = { title: "Filing period" };

const STEPS = ["Prepare", "Version ready", "Sent to client", "Client decision", "Submitted (evidence)", "Accepted (evidence)", "Paid (receipt)"];

export default async function PeriodPage({ params }: { params: Promise<{ id: string }> }) {
  const { actor, access } = await requireCompliancePage();
  const { id } = await params;
  const w = await periodWorkspace(actor, id);
  if (!w) notFound();
  const { p } = w;
  const o = p.obligation;
  const manage = access.level === "MANAGE";
  const settings = await complianceSettings();
  const name = (uid: string | null) => w.users.find((u) => u.id === uid)?.name ?? "—";
  const live = p.versions.find((v) => v.status !== "SUPERSEDED");
  const docs = p.documents.filter((d) => !d.document.deletedAt);
  const docOpts = (kinds: string[]) => docs.filter((d) => kinds.includes(d.kind));
  const portalUrl = o.filingAccount?.portalUrl ?? o.filingAccount?.firmAccount?.portalUrl ?? null;
  const reached = [p.filingStatus !== "NOT_STARTED", !!live, !!live?.sentAt, p.versions.some((v) => v.approvals.length), ["SUBMITTED", "ACCEPTED"].includes(p.filingStatus), p.filingStatus === "ACCEPTED", p.paymentStatus === "PAID" || p.paymentStatus === "NOT_APPLICABLE"];
  const evidenceFields = (kinds: string[], refLabel: string) => (
    <>
      <input name="reference" placeholder={refLabel} className="input" />
      <select name="documentId" className="input" aria-label="Evidence document"><option value="">— or choose an uploaded document —</option>{docOpts(kinds).map((d) => <option key={d.documentId} value={d.documentId}>{d.document.title}</option>)}</select>
    </>
  );
  return (
    <>
      <PageHeader title={`${o.formName} — ${p.periodKey}${p.kind === "AMENDED" ? " (amended)" : ""}`} subtitle={<span className="flex flex-wrap items-center gap-2"><Link href={`/compliance/entities/${p.entityId}`} className="underline">{p.entity.legalName || p.entity.dba || "(legal name missing)"}</Link><span>{p.entity.client.displayName}</span><StatusBadge status={clientStatus(p)} /><Badge tone={p.paymentStatus === "PAID" ? "green" : "gray"}>{PAYMENT_STATUS[p.paymentStatus as keyof typeof PAYMENT_STATUS]}</Badge></span>}
        actions={portalUrl ? <a href={portalUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-2 rounded-lg bg-gold-500 px-4 py-2 text-sm font-semibold text-navy-950" data-testid="open-portal">Open portal <ExternalLink className="size-4" aria-hidden /></a> : <span className="text-sm text-amber-800">No portal linked (Accounts &amp; Portals)</span>} />
      <SwitchesBanner clientNotificationsAuthorized={settings.clientNotificationsAuthorized} staffEmailReminders={settings.staffEmailReminders} isOwner={access.isOwner} />
      <ComplianceNav current="" isOwner={access.isOwner} />

      <div className="grid gap-5 lg:grid-cols-3">
        <Card title="Period" className="lg:col-span-1">
          <dl className="space-y-1.5 text-sm" data-testid="period-facts">
            <div><dt className="inline font-semibold">Period: </dt><dd className="inline">{fmtD(p.periodStart)} – {fmtD(p.periodEnd)}</dd></div>
            <div><dt className="inline font-semibold">Statutory due: </dt><dd className="inline">{fmtD(p.statutoryDue)}</dd></div>
            <div><dt className="inline font-semibold">Adjusted due: </dt><dd className="inline">{fmtD(p.adjustedDue)} {p.dueCertainty !== "CONFIRMED" && <NeedsVerification />}</dd></div>
            {p.extendedDue && <div><dt className="inline font-semibold">Extended to: </dt><dd className="inline">{fmtD(p.extendedDue)}</dd></div>}
            <div><dt className="inline font-semibold">Internal prep deadline: </dt><dd className="inline">{fmtD(p.prepDeadline)}</dd></div>
            {p.dueNote && <p className="text-xs text-amber-900">{p.dueNote}</p>}
            <div><dt className="inline font-semibold">Rule: </dt><dd className="inline">{o.dueRuleDescription}{o.rule && ` (v${o.rule.version}, ${o.rule.verificationStatus === "VERIFIED" ? "verified" : "needs verification"})`}</dd></div>
            <div><dt className="inline font-semibold">Amount due: </dt><dd className="inline">{money(p.amountDueCents)}</dd></div>
            <div><dt className="inline font-semibold">Client approval: </dt><dd className="inline">{o.clientApprovalRequired ? (w.approval ? <Badge tone="green">Approved v{w.approval.version.version}</Badge> : <Badge tone="red">Required — missing</Badge>) : "Not required"}</dd></div>
            <div><dt className="inline font-semibold">Filed: </dt><dd className="inline">{fmtD(p.actualFilingDate)} {p.confirmationNumber && `· conf. ${p.confirmationNumber}`} {p.verifiedById && `· verified by ${name(p.verifiedById)} ${p.verifiedAt?.toISOString().slice(0, 16).replace("T", " ")} UTC`}</dd></div>
            <div><dt className="inline font-semibold">Filing channel: </dt><dd className="inline">{FILING_CHANNELS.MANUAL.label}. <span className="text-slate-500">{FILING_CHANNELS.MAT_BULK.label}: disabled.</span></dd></div>
            <div><dt className="inline font-semibold">Prep task: </dt><dd className="inline">{w.task ? `${w.task.status === "OPEN" ? "Open" : "Done"} — ${w.task.title}` : "Created 30 days before the due date"}</dd></div>
            {o.requiredDocs.length > 0 && <div><dt className="font-semibold">Required supporting documents</dt><dd><ul className="list-disc pl-5 text-xs">{o.requiredDocs.map((r) => <li key={r}>{r}</li>)}</ul></dd></div>}
          </dl>
          {manage && (
            <div className="mt-4 space-y-2">
              {(p.filingStatus === "NOT_STARTED" || p.filingStatus === "REJECTED") && <ActionForm action={A.startPreparingAction.bind(null, p.id)}><Button variant="secondary">Start preparing</Button></ActionForm>}
              <ActionForm action={A.amountAction.bind(null, p.id)} className="flex gap-2"><input name="amount" defaultValue={p.amountDueCents !== null ? (p.amountDueCents / 100).toFixed(2) : ""} placeholder="Amount due" className="input" /><Button variant="secondary">Save amount</Button></ActionForm>
              <details className="text-sm"><summary className="cursor-pointer underline">Enter / correct the due date</summary><ActionForm action={A.dueDateAction.bind(null, p.id)} className="mt-2 grid gap-2"><input type="date" name="dueDate" required className="input" /><input name="note" required placeholder="Source (notice, license, agency page)" className="input" /><Button variant="secondary">Save due date</Button></ActionForm></details>
              {o.extensionMonths && !p.extendedDue && !["SUBMITTED", "ACCEPTED"].includes(p.filingStatus) && <details className="text-sm"><summary className="cursor-pointer underline">Record extension (evidence required)</summary><ActionForm action={A.extensionAction.bind(null, p.id)} className="mt-2 grid gap-2">{evidenceFields(["EXTENSION"], "Extension confirmation number")}<Button variant="secondary">Record extension</Button></ActionForm></details>}
              {["SUBMITTED", "ACCEPTED", "NOT_REQUIRED"].includes(p.filingStatus) && p.kind === "ORIGINAL" && <details className="text-sm"><summary className="cursor-pointer underline">Start an amended return</summary><ActionForm action={A.amendedAction.bind(null, p.id)} className="mt-2 grid gap-2"><input name="reason" required placeholder="Why amend?" className="input" /><Button variant="secondary">Start amended return</Button></ActionForm></details>}
            </div>
          )}
        </Card>

        <div className="space-y-5 lg:col-span-2">
          <Card title="Approval & filing flow">
            <ol className="mb-4 flex flex-wrap gap-2 text-xs" data-testid="flow-steps">{STEPS.map((s, i) => <li key={s} className={`rounded-full px-3 py-1 font-semibold ${reached[i] ? "bg-emerald-100 text-emerald-900" : "bg-slate-100 text-slate-600"}`}>{i + 1}. {s}</li>)}</ol>
            <h3 className="font-semibold">Return package documents</h3>
            <ul className="mb-3 divide-y divide-ivory-200 text-sm">{docs.map((d) => <li key={d.id} className="flex flex-wrap items-center justify-between gap-2 py-1.5"><span>{d.document.title} · {DOC_KINDS[d.kind as keyof typeof DOC_KINDS] ?? d.kind} · sha256 {d.document.file.sha256?.slice(0, 10)}…{d.document.scanStatus !== "CLEAN" && <Badge tone="amber" className="ml-1">Not scanned</Badge>}{d.publishedAt && <Badge tone="green" className="ml-1">Released</Badge>}</span><span className="flex gap-3">{d.document.scanStatus === "CLEAN" && <a className="underline" href={`/api/documents/${downloadToken(d.documentId, { staffId: actor.id })}`}>View</a>}{manage && ["RETURN", "FILING_CONFIRMATION", "ACCEPTANCE", "PAYMENT_RECEIPT"].includes(d.kind) && ["SUBMITTED", "ACCEPTED"].includes(p.filingStatus) && <ActionForm action={A.publishDocAction.bind(null, p.id, d.documentId, !d.publishedAt)}><button className="text-xs underline">{d.publishedAt ? "Withdraw from client" : "Release to client"}</button></ActionForm>}</span></li>)}{!docs.length && <li className="py-1.5 text-slate-600">No documents yet.</li>}</ul>
            {manage && <ActionForm action={A.uploadComplianceDocAction.bind(null, p.entityId, p.id)} resetOnSuccess className="mb-4 flex flex-wrap gap-2"><select name="kind" className="input w-auto" aria-label="Kind">{Object.entries(DOC_KINDS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select><input name="title" placeholder="Title" className="input w-48" /><input type="file" name="file" required accept="application/pdf,image/png,image/jpeg" className="text-sm" /><Button variant="secondary">Upload</Button></ActionForm>}
            <p className="mb-3 text-xs text-slate-600">A new return or supporting document, a new amount, or a changed due date invalidates the current version and its approval.</p>

            <h3 className="font-semibold">Return versions</h3>
            <ul className="mb-3 space-y-2 text-sm" data-testid="versions">
              {p.versions.map((v) => (
                <li key={v.id} className="rounded-lg border border-ivory-200 p-3">
                  <p><strong>Version {v.version}</strong> · {v.status}{v.invalidatedReason && ` — ${v.invalidatedReason}`} · amount {money(v.amountDueCents)} · due {fmtD(v.dueDate)} · hash <code>{v.contentHash.slice(0, 16)}…</code> · {v.documentIds.length} document(s) · prepared by {name(v.preparedById)}</p>
                  {v.approvals.map((a) => { const pu = w.portalUsers.find((x) => x.id === a.portalUserId); return <p key={a.id} className={`mt-1 text-xs ${a.decision === "APPROVED" ? "text-emerald-800" : "text-red-800"}`}>{a.decision === "APPROVED" ? "Approved" : "Changes requested"} by {a.signerName} ({pu?.email ?? "portal user"}) on {a.createdAt.toISOString().slice(0, 19).replace("T", " ")} UTC · IP {a.ipAddress ?? "—"} · hash {a.contentHash.slice(0, 12)}…{a.comments && <> · “{a.comments}”</>}</p>; })}
                  {manage && (v.status === "DRAFT" || v.status === "CHANGES_REQUESTED") && o.clientApprovalRequired && <ActionForm action={A.sendVersionAction.bind(null, p.id, v.id)} className="mt-2"><Button className="min-h-8 px-3 py-1 text-xs">Send to client for approval</Button></ActionForm>}
                </li>
              ))}
              {!p.versions.length && <li className="text-slate-600">No versions yet.</li>}
            </ul>
            {manage && !["SUBMITTED", "ACCEPTED", "NOT_REQUIRED"].includes(p.filingStatus) && <ActionForm action={A.createVersionAction.bind(null, p.id)} className="mb-4 flex gap-2"><input name="note" placeholder="Note to the client (optional)" className="input" /><Button variant="secondary">Create version from current documents</Button></ActionForm>}

            {manage && (
              <div className="grid gap-4 border-t border-ivory-200 pt-4 sm:grid-cols-2">
                {!["SUBMITTED", "ACCEPTED", "NOT_REQUIRED"].includes(p.filingStatus) && (
                  <ActionForm action={A.submittedAction.bind(null, p.id)} className="grid gap-2" >
                    <p className="font-semibold">Record Submitted</p>
                    {o.clientApprovalRequired && !w.approval && <Notice tone="warn">Client approval is required and missing — Submitted will be refused.</Notice>}
                    {evidenceFields(["FILING_CONFIRMATION", "ACCEPTANCE", "RETURN"], "Confirmation number")}
                    <input type="date" name="filedOn" className="input" aria-label="Filed on" />
                    <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="zeroReturn" /> No-activity / zero return</label>
                    <Button>Record Submitted (I verified it)</Button>
                  </ActionForm>
                )}
                {p.filingStatus === "SUBMITTED" && (
                  <>
                    <ActionForm action={A.acceptedAction.bind(null, p.id)} className="grid gap-2"><p className="font-semibold">Record Accepted</p>{evidenceFields(["ACCEPTANCE"], "Acknowledgement number")}<Button>Record Accepted</Button></ActionForm>
                    <ActionForm action={A.rejectedAction.bind(null, p.id)} className="grid gap-2"><p className="font-semibold">Record Rejected</p>{evidenceFields(["REJECTION"], "Rejection reference")}<input name="reason" required placeholder="Reason" className="input" /><Button variant="danger">Record Rejected</Button></ActionForm>
                  </>
                )}
                {p.paymentStatus !== "PAID" && (
                  <ActionForm action={A.paymentAction.bind(null, p.id)} className="grid gap-2"><p className="font-semibold">Record payment (separate from filing)</p>{evidenceFields(["PAYMENT_RECEIPT"], "Payment confirmation number")}<Button variant="secondary">Record Paid</Button></ActionForm>
                )}
                {p.paymentStatus === "UNKNOWN" && <ActionForm action={A.noPaymentAction.bind(null, p.id)}><Button variant="ghost">No payment due</Button></ActionForm>}
                {!["SUBMITTED", "ACCEPTED", "NOT_REQUIRED"].includes(p.filingStatus) && (
                  <ActionForm action={A.notRequiredAction.bind(null, p.id)} className="grid gap-2"><p className="font-semibold">Not required / no filing</p>{evidenceFields(["NOT_REQUIRED", "OTHER", "FILING_CONFIRMATION"], "Agency reference")}<input name="reason" required placeholder="Why no filing is required" className="input" /><Button variant="secondary">Record not required</Button></ActionForm>
                )}
              </div>
            )}
          </Card>

          <Card title="Evidence log">
            <ul className="text-sm" data-testid="evidence-log">{p.evidence.map((x) => <li key={x.id} className="py-0.5">{x.recordedAt.toISOString().slice(0, 16).replace("T", " ")} · <strong>{x.kind}</strong> · {x.reference ?? "—"}{x.documentId && " · document"}{x.note && ` · ${x.note}`} · by {name(x.recordedById)}</li>)}{!p.evidence.length && <li className="text-slate-600">No evidence recorded.</li>}</ul>
          </Card>
          <Card title="Reminders for this period">
            <ul className="text-xs" data-testid="period-reminders">{p.reminders.map((r) => <li key={r.id} className="py-0.5">{r.createdAt.toISOString().slice(0, 16).replace("T", " ")} · {r.step} · {r.channel} · <Badge tone={r.status === "HELD" ? "amber" : r.status === "SENT" || r.status === "CREATED" ? "green" : "gray"}>{r.status}</Badge> {r.detail}</li>)}{!p.reminders.length && <li className="text-slate-600">None yet.</li>}</ul>
          </Card>
        </div>
      </div>
    </>
  );
}
