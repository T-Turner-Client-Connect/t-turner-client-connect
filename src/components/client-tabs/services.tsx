import type { Actor } from "@/lib/auth/actor";
import { ActionForm } from "@/components/action-form";
import { Badge, Button, Card, EmptyState, Field, Notice } from "@/components/ui";
import {
  createServiceAction, ownerOverrideAction, paymentAuthAction, prepareAgreementAction, sendAgreementAction, serviceStatusAction, voidAgreementAction,
} from "@/app/actions/service-agreements";
import { prisma } from "@/lib/prisma";
import { can } from "@/lib/auth/permissions";
import { downloadToken } from "@/lib/services/documents";
import { clientServices, DEFAULT_PAYMENT_TERMS, methodLabel, SERVICE_STATUS, SERVICE_TYPES, startGate } from "@/lib/services/service-agreements";
import { usd } from "@/lib/billing/payment-fees";
import type { AgreementSelection, AgreementTerms } from "@/lib/billing/agreement-terms";
import { fmtDateTime } from "@/lib/format";

const STATUS_TONE: Record<string, "gray" | "amber" | "green" | "red" | "gold"> = {
  AGREEMENT_PENDING: "gray", AGREEMENT_SENT: "amber", AGREEMENT_VIEWED: "amber", AGREEMENT_SIGNED: "green", AWAITING_PAYMENT_AUTHORIZATION: "amber",
  APPROVED_TO_BEGIN: "green", IN_PROGRESS: "gold", COMPLETED: "green", CLOSED: "gray",
};
const AGREEMENT_LABEL = { DRAFT: "Draft (not sent)", SENT: "Sent", VIEWED: "Viewed", SIGNED: "Signed", SUPERSEDED: "Superseded", VOID: "Void" } as const;

/**
 * Services & Agreements: every billable service this client has with us, each
 * with its own tax year or period, staff, status and pricing agreement.
 */
export async function ServicesTab({ clientId, user }: { clientId: string; user: Actor }) {
  const [services, staff, owner] = await Promise.all([
    clientServices(clientId),
    prisma.user.findMany({ where: { active: true }, select: { id: true, name: true }, orderBy: { name: "asc" } }),
    can(user, "billing", "approve"),
  ]);
  const isOwner = owner;
  const thisYear = new Date().getFullYear();
  const years = Array.from({ length: 8 }, (_, i) => thisYear + 1 - i);

  return (
    <div className="space-y-4" data-testid="services-tab">
      <Card title="Add a service">
        <ActionForm action={createServiceAction.bind(null, clientId)} className="grid gap-2 sm:grid-cols-3" resetOnSuccess>
          <Field label="Service">
            <select className="input" name="type" required defaultValue="">
              <option value="" disabled>Choose</option>
              {Object.entries(SERVICE_TYPES).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
            </select>
          </Field>
          <Field label="Tax year" hint="Required for tax services.">
            <select className="input" name="taxYear" defaultValue="">
              <option value="">—</option>
              {years.map((y) => <option key={y} value={y}>{y}</option>)}
            </select>
          </Field>
          <Field label="…or service period" hint="e.g. January–December 2026"><input className="input" name="periodLabel" /></Field>
          <Field label="Title (optional)"><input className="input" name="title" placeholder="Filled in from the service and year" /></Field>
          <Field label="Assigned staff">
            <select className="input" name="assignedToId" defaultValue=""><option value="">Unassigned</option>{staff.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select>
          </Field>
          <Field label="Description (shown on the agreement)"><input className="input" name="description" /></Field>
          <label className="flex items-center gap-2 text-sm sm:col-span-2"><input type="checkbox" name="requiresPaymentAuth" /> Require a payment authorization (deposit, card authorization, refund-transfer application) before work begins</label>
          <div className="flex items-end"><Button type="submit">Add service</Button></div>
        </ActionForm>
      </Card>

      {services.length === 0 && <EmptyState title="No services yet">Add each billable service separately — for example a 2026 individual return and 2026 bookkeeping. Each gets its own agreement.</EmptyState>}

      {services.map((s) => {
        const gate = startGate(s);
        const latest = s.agreements[0];
        const draft = latest?.status === "DRAFT" ? latest : null;
        const terms = (draft?.terms ?? latest?.terms) as unknown as AgreementTerms | undefined;
        const kindIsTax = SERVICE_TYPES[s.type].tax && s.type !== "IRS_CORRESPONDENCE";
        return (
          <div key={s.id} id={`service-${s.id}`} className="scroll-mt-6" data-testid="service-card" data-service={s.title}>
            <Card
              title={<span>{s.title} <span className="text-sm font-normal text-slate-600">· {SERVICE_TYPES[s.type].label}{s.taxYear ? ` · tax year ${s.taxYear}` : s.periodLabel ? ` · ${s.periodLabel}` : ""}</span></span>}
              actions={<span data-testid="service-status"><Badge tone={STATUS_TONE[s.status]}>{SERVICE_STATUS[s.status]}</Badge></span>}
            >
              <p className="mb-2 text-sm text-slate-700">
                Assigned: {s.assignedTo?.name ?? "Unassigned"}
                {s.requiresPaymentAuth && <> · Payment authorization: {s.paymentAuthAt ? `recorded ${fmtDateTime(s.paymentAuthAt)} (${s.paymentAuthNote})` : <strong>required, not recorded</strong>}</>}
              </p>
              {s.overrideAt && <Notice tone="warn">Owner override {fmtDateTime(s.overrideAt)}: {s.overrideReason}</Notice>}
              {!gate.ok && !["COMPLETED", "CLOSED"].includes(s.status) && <p className="mb-2 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900" data-testid="start-gate">Work can&apos;t begin yet: {gate.reason}</p>}

              {/* Agreement versions */}
              {s.agreements.length > 0 && (
                <ul className="mb-3 divide-y divide-ivory-200 text-sm" data-testid="agreement-versions">
                  {s.agreements.map((a) => {
                    const t = a.terms as unknown as AgreementTerms;
                    const sel = a.selection as unknown as AgreementSelection | null;
                    return (
                      <li key={a.id} className="flex flex-wrap items-center justify-between gap-2 py-2" data-version={a.version}>
                        <span>
                          <strong>Version {a.version}</strong> · {t.agreementTitle} · {usd(t.baseCents)} · <Badge tone={a.status === "SIGNED" ? "green" : a.status === "SUPERSEDED" || a.status === "VOID" ? "gray" : "amber"}>{AGREEMENT_LABEL[a.status]}</Badge>
                          {a.sentAt && ` · sent ${fmtDateTime(a.sentAt)}`}
                          {a.viewedAt && ` · viewed ${fmtDateTime(a.viewedAt)}`}
                          {a.signedAt && ` · signed ${fmtDateTime(a.signedAt)} by ${a.signerName}`}
                          {sel && ` · ${methodLabel(sel.method)} — total ${usd(sel.totalCents)}${sel.feeCents ? ` (fee ${usd(sel.feeCents)})` : ""}`}
                          {a.voidReason && ` · void: ${a.voidReason}`}
                        </span>
                        <span className="flex flex-wrap gap-2">
                          {a.pdfDocumentId && <a className="underline" href={`/api/documents/${downloadToken(a.pdfDocumentId, { staffId: user.id })}`} target="_blank" rel="noopener">Signed PDF</a>}
                          {a.status === "DRAFT" && <ActionForm action={sendAgreementAction.bind(null, clientId, a.id)}><Button type="submit" variant="gold">Send to client</Button></ActionForm>}
                          {["DRAFT", "SENT", "VIEWED"].includes(a.status) && (
                            <details>
                              <summary className="cursor-pointer text-xs underline">Void</summary>
                              <ActionForm action={voidAgreementAction.bind(null, clientId, a.id)} className="mt-1 flex gap-1"><input className="input" name="reason" placeholder="Reason" required /><Button type="submit" variant="ghost">Void</Button></ActionForm>
                            </details>
                          )}
                        </span>
                      </li>
                    );
                  })}
                </ul>
              )}

              <div className="grid gap-3 lg:grid-cols-2">
                <details className="rounded-xl bg-ivory-50 p-3 text-sm" open={!latest}>
                  <summary className="cursor-pointer font-semibold">{draft ? `Edit draft (version ${draft.version})` : latest ? "Revise pricing (new version, signed again)" : "Prepare pricing agreement"}</summary>
                  <ActionForm action={prepareAgreementAction.bind(null, clientId, s.id)} className="mt-2 space-y-2">
                    <p className="text-xs text-slate-600">{kindIsTax ? "Tax Preparation Payment Selection & Fee Agreement" : "Service Pricing & Payment Agreement"}. Payment-method fees come from Owner&apos;s Office settings; the client chooses a method and sees the total before signing.</p>
                    {[0, 1, 2, 3].map((i) => (
                      <div key={i} className="flex gap-2">
                        <input className="input flex-1" name={`label${i}`} placeholder={i === 0 ? "Service price (e.g. 2026 Form 1040)" : "Additional charge (optional)"} defaultValue={terms?.lines[i]?.label ?? ""} aria-label={`Charge ${i + 1} description`} />
                        <input className="input w-32" name={`amount${i}`} inputMode="decimal" placeholder="$0.00" defaultValue={terms?.lines[i] ? (terms.lines[i].cents / 100).toFixed(2) : ""} aria-label={`Charge ${i + 1} amount`} />
                      </div>
                    ))}
                    {kindIsTax && (
                      <div className="rounded-lg border border-ivory-200 p-2">
                        <label className="flex items-center gap-2"><input type="checkbox" name="refundTransferEligible" defaultChecked={!!terms?.refundTransfer?.eligible} /> This return is eligible for a refund transfer (fees deducted from the refund)</label>
                        <Field label="Provider's refund-transfer fee" hint="From the provider offered through your tax software. Offered only when a provider is set up in Owner's Office."><input className="input w-32" name="refundTransferFee" inputMode="decimal" defaultValue={terms?.refundTransfer ? (terms.refundTransfer.feeCents / 100).toFixed(2) : ""} /></Field>
                      </div>
                    )}
                    <Field label="Payment terms"><textarea className="input" name="paymentTerms" rows={3} defaultValue={terms?.paymentTerms ?? DEFAULT_PAYMENT_TERMS} /></Field>
                    <Button type="submit" variant="secondary">{draft ? "Save draft" : "Save as draft"}</Button>
                  </ActionForm>
                </details>

                <div className="space-y-2 rounded-xl bg-ivory-50 p-3 text-sm">
                  <ActionForm action={serviceStatusAction.bind(null, clientId, s.id)} className="flex flex-wrap items-end gap-2">
                    <Field label="Work status">
                      <select className="input" name="status" defaultValue=""><option value="" disabled>Choose</option><option value="IN_PROGRESS">In Progress</option><option value="COMPLETED">Completed</option><option value="CLOSED">Closed</option></select>
                    </Field>
                    <Button type="submit" variant="secondary">Update</Button>
                  </ActionForm>
                  {s.requiresPaymentAuth && !s.paymentAuthAt && (
                    <ActionForm action={paymentAuthAction.bind(null, clientId, s.id)} className="flex flex-wrap items-end gap-2">
                      <Field label="Record payment authorization"><input className="input" name="note" placeholder="e.g. Deposit received by Zelle 11/2" /></Field>
                      <Button type="submit" variant="secondary">Record</Button>
                    </ActionForm>
                  )}
                  {isOwner && !s.overrideAt && !gate.ok && (
                    <details>
                      <summary className="cursor-pointer text-xs font-semibold underline">Owner override (documented exception)</summary>
                      <ActionForm action={ownerOverrideAction.bind(null, clientId, s.id)} className="mt-1 space-y-1">
                        <textarea className="input" name="reason" rows={2} placeholder="Why work may begin before the agreement is signed" required />
                        <Button type="submit" variant="ghost">Allow work to begin</Button>
                      </ActionForm>
                    </details>
                  )}
                </div>
              </div>
            </Card>
          </div>
        );
      })}
    </div>
  );
}
