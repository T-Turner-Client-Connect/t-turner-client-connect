import { ActionForm } from "@/components/action-form";
import { Badge, Button, Card, Field, Notice, PageHeader } from "@/components/ui";
import { grantOwnerAction, revokeOwnerAction, saveBillingSettingsAction } from "@/app/actions/owner";
import { requireOwner } from "@/lib/auth/owner";
import { billingSettings } from "@/lib/services/owner-billing";
import { fmtDateTime } from "@/lib/format";
import { prisma } from "@/lib/prisma";
import { FeeSettingsCard } from "@/components/owner/fee-settings";
import { PlanSettingsCards } from "@/components/owner/plan-settings";
import { refundFeeNoteAction, squareLinksAction } from "@/app/actions/firm-invoices";
import { squareSettings } from "@/lib/square";

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
  const { actor, access } = await requireOwner("full");
  const [s, staff, grants, log] = await Promise.all([
    billingSettings(),
    prisma.user.findMany({ where: { active: true, id: { not: actor.id } }, orderBy: { name: "asc" } }),
    prisma.ownerAccess.findMany({ where: { isPrimary: false }, include: { user: { select: { name: true, email: true } } }, orderBy: { grantedAt: "desc" } }),
    prisma.ownerAuditLog.findMany({ orderBy: { createdAt: "desc" }, take: 40 }),
  ]);
  return (
    <>
      <PageHeader title="Billing settings & access" />
      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Quote and payment-plan defaults">
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
        </Card>

        <div className="space-y-4">
          <Card title="Invoice payment options">
            <div className="space-y-4 text-sm" data-testid="invoice-payment-settings">
              <div>
                <p className="font-semibold text-navy-900">Square payment links on invoices{" "}
                  {s.squareLinksEnabledAt ? <Badge tone="green">On</Badge> : <Badge tone="gray">Not enabled</Badge>}
                </p>
                <p className="mt-1 text-slate-700">
                  When on, a client sees a &ldquo;Pay securely with Square&rdquo; button on an invoice that offers Square and has a link from the firm&apos;s own Square account attached. Client Connect never creates or sends Square invoices, never charges a card and never stores card details.
                  {!squareSettings().configured && " Square isn't configured on this site, so no link is shown even when this is on."}
                </p>
                <ActionForm action={squareLinksAction.bind(null, !s.squareLinksEnabledAt)} className="mt-2" confirm={s.squareLinksEnabledAt ? undefined : "Turn on Square payment links? Clients will see the Square link on invoices that offer Square."}>
                  <Button type="submit" variant="secondary">{s.squareLinksEnabledAt ? "Turn off Square links" : "Turn on Square links"}</Button>
                </ActionForm>
              </div>
              <div className="border-t border-ivory-200 pt-4">
                <p className="font-semibold text-navy-900">Republic Bank Refund Transfer — confirmed fees</p>
                <p className="mt-1 text-slate-700">Shown to clients exactly as written, with Republic Bank&apos;s disclosures. Leave empty until the fees are confirmed: no amount is shown or assumed.</p>
                <ActionForm action={refundFeeNoteAction} className="mt-2 space-y-2">
                  <textarea className="input" name="note" rows={2} maxLength={1000} defaultValue={s.refundTransferFeeNote ?? ""} aria-label="Confirmed Refund Transfer fees" />
                  <Button type="submit" variant="secondary">Save</Button>
                </ActionForm>
              </div>
              <p className="text-xs text-slate-600">Which methods can be offered on invoices is set under &ldquo;Payment instructions clients see&rdquo; below: only methods turned on there can be chosen.</p>
            </div>
          </Card>
          <Card title="Payment provider">
            <p className="text-sm"><Badge tone="gray">Not connected</Badge></p>
            <p className="mt-2 text-sm text-slate-700">
              No payment provider is connected. Clients see their invoices and schedules, and you record payments by hand. Online payments, automatic receipts and
              provider-confirmed failures/refunds need a provider account (for example Stripe or Square) — see docs/BILLING.md.
            </p>
          </Card>
          {access.isPrimary && (
            <Card title="Who can open the Owner's Office">
              <ul className="mb-3 divide-y divide-navy-100 text-sm">
                <li className="py-2"><strong>You</strong> — full access (owner)</li>
                {grants.map((g) => (
                  <li key={g.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                    <span>{g.user.name} ({g.user.email}) · {g.scope === "FULL" ? "Full access" : "Billing only"} {g.revokedAt && <Badge tone="gray">Removed</Badge>}</span>
                    {!g.revokedAt && <ActionForm action={revokeOwnerAction.bind(null, g.userId)} confirm={`Remove ${g.user.name}'s access?`}><Button variant="ghost">Remove</Button></ActionForm>}
                  </li>
                ))}
              </ul>
              <ActionForm action={grantOwnerAction} className="grid gap-2" resetOnSuccess>
                <Field label="Staff member"><select className="input" name="userId" required><option value="">Choose…</option>{staff.map((u) => <option key={u.id} value={u.id}>{u.name} ({u.email})</option>)}</select></Field>
                <Field label="Access"><select className="input" name="scope"><option value="BILLING">Billing only — quotes, invoices, payments</option><option value="FULL">Full — including expenses and totals</option></select></Field>
                <Field label="Confirm your password"><input className="input" type="password" name="password" required autoComplete="current-password" /></Field>
                <Button type="submit" variant="secondary">Grant access</Button>
              </ActionForm>
            </Card>
          )}
          <Card title="Private activity log">
            <ul className="max-h-80 divide-y divide-navy-100 overflow-y-auto text-xs">
              {log.map((l) => <li key={l.id} className="flex justify-between gap-2 py-1.5"><code>{l.action}</code><span className="text-slate-600">{fmtDateTime(l.createdAt)}</span></li>)}
            </ul>
          </Card>
          <Notice tone="info">Only you see this log. Owner activity is never written to the shared staff audit log.</Notice>
        </div>
      </div>
      <div className="mt-4"><FeeSettingsCard /></div>
      <PlanSettingsCards />
    </>
  );
}
