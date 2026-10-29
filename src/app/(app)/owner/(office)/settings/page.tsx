import { ActionForm } from "@/components/action-form";
import { Badge, Button, Card, Field, Notice, PageHeader } from "@/components/ui";
import { grantOwnerAction, revokeOwnerAction, saveBillingSettingsAction } from "@/app/actions/owner";
import { requireOwner } from "@/lib/auth/owner";
import { billingSettings } from "@/lib/services/owner-billing";
import { describeAmount } from "@/lib/billing/pricing";
import { fmtDateTime } from "@/lib/format";
import { prisma } from "@/lib/prisma";

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
        <Card title="Payment-plan fee and defaults">
          <ActionForm action={saveBillingSettingsAction} className="space-y-3">
            <AmountPicker name="planFee" type={s.planFeeType} value={s.planFeeValue} label="Payment-plan fee" hint="Flat $ per plan, or % of the services after discount and before tax. Added once, only when the client chooses a plan." />
            <label className="flex items-start gap-2 rounded-lg bg-amber-50 p-3 text-sm text-amber-900">
              <input type="checkbox" name="planFeeRulesConfirmed" defaultChecked={!!s.planFeeRulesConfirmedAt} className="mt-1" />
              <span>
                I&apos;ve checked my payment provider&apos;s rules and the legal requirements for charging this payment-plan fee. I understand it is a fee for paying in installments — not a card surcharge
                — and that card surcharges are not enabled in this app.
                {s.planFeeRulesConfirmedAt && <span className="block text-xs">Confirmed {fmtDateTime(s.planFeeRulesConfirmedAt)}</span>}
              </span>
            </label>
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
          <p className="mt-3 text-xs text-slate-600">Current plan fee: {describeAmount(s.planFeeType, s.planFeeValue)}. Changes apply to new quotes only.</p>
        </Card>

        <div className="space-y-4">
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
    </>
  );
}
