import Link from "next/link";
import { ActionForm } from "@/components/action-form";
import { Badge, Button, Card, Field, Notice, PageHeader } from "@/components/ui";
import { redirect } from "next/navigation";
import { saveBillingSettingsAction } from "@/app/actions/owner";
import { billingSettingsVisible, requireOffice } from "@/lib/auth/owner";
import { SettingsNav } from "@/components/owner/settings-nav";
import { billingSettings } from "@/lib/services/owner-billing";
import { fmtDateTime } from "@/lib/format";
import { prisma } from "@/lib/prisma";
import { FeeSettingsCard } from "@/components/owner/fee-settings";
import { PlanSettingsCards } from "@/components/owner/plan-settings";
import { refundFeeNoteAction, squareLinksAction } from "@/app/actions/firm-invoices";
import { squareSettings } from "@/lib/square";
import { squareDeliveryAction, squareSendingAction } from "@/app/actions/square-invoicing";
import { squareSendingState } from "@/lib/services/square-invoicing";
import { squareHealth } from "@/lib/services/square-health";

const plain = (type: string, v: number) => (type === "FLAT" || type === "PERCENT" ? (v / 100).toString() : "");

function AmountPicker({ name, type, value, label, hint }: { name: string; type: string; value: number; label: string; hint?: string }) {
  return (
    <Field label={label} hint={hint}>
      <div className="flex gap-2">
        <select className="input w-32" name={`${name}Type`} defaultValue={type}><option value="NONE">None</option><option value="FLAT">Flat $</option><option value="PERCENT">%</option></select>
        <input className="input" name={`${name}Value`} inputMode="decimal" defaultValue={plain(type, value)} aria-label={`${label} amount`} />
      </div>
    </Field>
  );
}

export default async function OwnerSettingsPage() {
  const { access } = await requireOffice();
  // Billing settings: Billing → Change billing settings and/or Square → Change integrations.
  if (!billingSettingsVisible(access)) redirect("/owner/settings/staff-access");
  const settings = access.can("billing", "settings");
  const integrations = access.can("square", "integrations");
  // The "Send invoices through Square" switch and delivery options are payment integrations.
  const mayChange = integrations;
  const [s, log, sending, health] = await Promise.all([
    billingSettings(),
    access.isOwner ? prisma.ownerAuditLog.findMany({ orderBy: { createdAt: "desc" }, take: 40 }) : [],
    squareSendingState(),
    squareHealth(),
  ]);
  const enabledBy = sending.enabledById ? await prisma.user.findUnique({ where: { id: sending.enabledById }, select: { name: true } }) : null;
  return (
    <>
      <PageHeader title="Settings" />
      <SettingsNav access={access} current="billing" />
      <div className="grid gap-4 lg:grid-cols-2">
        {settings ? <Card title="Quote and payment-plan defaults">
          <ActionForm action={saveBillingSettingsAction} className="space-y-3">
            <input type="hidden" name="planFeeType" value="NONE" />
            <p className="rounded-lg bg-ivory-50 p-3 text-sm" data-testid="no-plan-fee">No payment-plan fee: choosing a payment plan never adds a fee. Card processing fees are set separately under Payment-method fees.</p>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Most installments allowed"><input className="input" name="maxInstallments" inputMode="numeric" defaultValue={s.maxInstallments} /></Field>
              <Field label="Default installments"><input className="input" name="defaultInstallments" inputMode="numeric" defaultValue={s.defaultInstallments} /></Field>
            </div>
            <AmountPicker name="defaultDiscount" type={s.defaultDiscountType} value={s.defaultDiscountValue} label="Default discount on new quotes" />
            <AmountPicker name="defaultDeposit" type={s.defaultDepositType} value={s.defaultDepositValue} label="Default deposit" />
            <Field label="Default sales tax rate (%)"><input className="input" name="defaultTaxRate" inputMode="decimal" defaultValue={(s.defaultTaxRateBps / 100).toString()} /></Field>
            <Field label="Default payment terms"><textarea className="input" name="defaultPaymentTerms" rows={3} defaultValue={s.defaultPaymentTerms ?? ""} /></Field>
            <Button type="submit">Save settings</Button>
          </ActionForm>
        </Card> : <div />}

        <div className="space-y-4">
          <Card title="Invoice payment options">
            <div className="space-y-4 text-sm" data-testid="invoice-payment-settings">
              <div>
                <p className="font-semibold text-navy-900">Manual Square links (fallback){" "}
                  {s.squareLinksEnabledAt ? <Badge tone="green">On</Badge> : <Badge tone="gray">Not enabled</Badge>}
                </p>
                <p className="mt-1 text-slate-700">
                  Only for an invoice that is <em>not</em> sent through Square: when on, a link pasted by hand from the firm&apos;s Square account shows as &ldquo;Pay securely with Square&rdquo;. Invoices sent through Square get their own link automatically. Client Connect never charges a card and never stores card details.
                  {!squareSettings().configured && " Square isn't configured on this site, so no link is shown even when this is on."}
                </p>
{integrations && (
                <ActionForm action={squareLinksAction.bind(null, !s.squareLinksEnabledAt)} className="mt-2" confirm={s.squareLinksEnabledAt ? undefined : "Turn on Square payment links? Clients will see the Square link on invoices that offer Square."}>
                  <Button type="submit" variant="secondary">{s.squareLinksEnabledAt ? "Turn off Square links" : "Turn on Square links"}</Button>
                </ActionForm>
                )}
              </div>
              <div className="border-t border-ivory-200 pt-4">
                <p className="font-semibold text-navy-900">Republic Bank Refund Transfer — confirmed fees</p>
                <p className="mt-1 text-slate-700">Shown to clients exactly as written, with Republic Bank&apos;s disclosures. Leave empty until the fees are confirmed: no amount is shown or assumed.</p>
{settings ? (
                <ActionForm action={refundFeeNoteAction} className="mt-2 space-y-2">
                  <textarea className="input" name="note" rows={2} maxLength={1000} defaultValue={s.refundTransferFeeNote ?? ""} aria-label="Confirmed Refund Transfer fees" />
                  <Button type="submit" variant="secondary">Save</Button>
                </ActionForm>
                ) : <p className="mt-2 text-sm">{s.refundTransferFeeNote || "None confirmed."}</p>}
              </div>
              <p className="text-xs text-slate-600">Which methods can be offered on invoices is set under &ldquo;Payment instructions clients see&rdquo; below: only methods turned on there can be chosen.</p>
            </div>
          </Card>
          <Card title="Send invoices through Square">
            <div className="space-y-3 text-sm" data-testid="square-sending-settings">
              <p className="flex flex-wrap items-center gap-2">
                {sending.enabled ? <Badge tone="green">On</Badge> : <Badge tone="gray">Off</Badge>}
                <span className="text-slate-700">Uses the firm&apos;s existing Square connection (the same one that imports recurring billing) — Square {sending.env === "production" ? "production" : "SANDBOX (test)"}.</span>
              </p>
              {sending.enabled && sending.enabledAt && <p className="text-xs text-slate-600">Turned on {fmtDateTime(sending.enabledAt)}{enabledBy ? ` by ${enabledBy.name}` : ""}.</p>}
              <p className="text-slate-700">
                When on, an approved invoice that offers Square is created in Square and published with a secure payment link (card{sending.acceptBank ? " or bank transfer" : ""}). Square&apos;s payments are recorded on the invoice automatically. When off, everything else works and nothing is sent to Square.
              </p>
              <ul className="space-y-1 text-xs text-slate-700">
                <li>Square connection: {!sending.configured ? <Badge tone="red">Not configured</Badge> : health.state === "WORKING" ? <Badge tone="green">Working</Badge> : health.state === "FAILING" ? <Badge tone="red">Failing</Badge> : <Badge tone="amber">Not checked yet</Badge>} <Link className="underline" href="/bookkeeping/square-billing">Check Square connection</Link></li>
                <li>Payment notifications (webhook): {sending.webhookKeySet ? <Badge tone="green">Signature key set</Badge> : <Badge tone="amber">SQUARE_WEBHOOK_SIGNATURE_KEY not set</Badge>} — notification URL <code className="break-all">{sending.webhookUrl}</code></li>
                {sending.env !== "production" && <li><Badge tone="amber">SQUARE_ENVIRONMENT isn&apos;t &ldquo;production&rdquo;</Badge> — invoices would go to Square&apos;s test system, not real clients.</li>}
              </ul>
              {mayChange ? (
                <>
                  <ActionForm action={squareSendingAction.bind(null, !sending.enabled)} confirm={sending.enabled ? "Turn off sending invoices through Square? Invoices already in Square stay there and payments still record." : `Turn on sending invoices through Square (${sending.env})? Approved invoices that offer Square will be created and published in your Square account, and clients can pay them.`}>
                    <Button type="submit" variant={sending.enabled ? "secondary" : "gold"} data-testid="square-sending-toggle">{sending.enabled ? "Turn off Square sending" : "Turn on Square sending"}</Button>
                  </ActionForm>
                  <ActionForm action={squareDeliveryAction} className="space-y-2 border-t border-ivory-200 pt-3">
                    <Field label="How the client gets the Square invoice">
                      <select className="input" name="delivery" defaultValue={sending.delivery}>
                        <option value="SHARE_MANUALLY">Our branded email with the Square link (recommended)</option>
                        <option value="EMAIL">Square emails the client directly</option>
                      </select>
                    </Field>
                    <label className="flex items-center gap-2"><input type="checkbox" name="acceptBank" defaultChecked={sending.acceptBank} className="size-4 accent-navy-900" /> Also accept bank transfer (ACH) on Square invoices</label>
                    <Button type="submit" variant="secondary">Save delivery</Button>
                  </ActionForm>
                </>
              ) : (
                <p className="text-xs text-slate-600">Only Tabitha can change this.</p>
              )}
              <p className="text-xs text-slate-600">No surcharge or card fee is added. Steps to go live: docs/square-invoicing.md.</p>
            </div>
          </Card>
          <Card title="Who can open the Owner's Office">
            <p className="text-sm text-slate-700">Each staff member&apos;s access is set area by area under <a className="font-semibold underline" href="/owner/settings/staff-access">Staff Access &amp; Permissions</a>. You remain the owner with full access, permanently.</p>
          </Card>
          {access.isOwner && <Card title="Private activity log">
            <ul className="max-h-80 divide-y divide-navy-100 overflow-y-auto text-xs">
              {log.map((l) => <li key={l.id} className="flex justify-between gap-2 py-1.5"><code>{l.action}</code><span className="text-slate-600">{fmtDateTime(l.createdAt)}</span></li>)}
            </ul>
          </Card>}
          {access.isOwner && <Notice tone="info">Only you see this log. Owner activity is never written to the shared staff audit log.</Notice>}
        </div>
      </div>
      {settings && <div className="mt-4"><FeeSettingsCard /></div>}
      <PlanSettingsCards instructions={integrations} lateFees={settings} />
    </>
  );
}
