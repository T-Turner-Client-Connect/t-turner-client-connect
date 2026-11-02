import { ActionForm } from "@/components/action-form";
import { Badge, Button, Card, Field } from "@/components/ui";
import { instructionAction, lateFeePolicyAction } from "@/app/actions/installment-plans";
import { prisma } from "@/lib/prisma";
import { lateFeePolicy, PAY_METHODS } from "@/lib/services/installment-plans";
import { fmtDateTime } from "@/lib/format";

// Suggested instructions from the owner's details; nothing shows to clients until saved here.
const SUGGESTED: Partial<Record<keyof typeof PAY_METHODS, string>> = {
  CASH: "Pay in person at our office. No fee.",
  ZELLE: "Send to 205-420-1825 (Tabitha Turner). No fee. Include your name and invoice number in the memo.",
  CASH_APP: "Send to $TTHOMPSON25 (Tabitha Thompson — the owner of T. Turner & Associates). Include your invoice number.",
  VENMO: "Send to @Tabitha-Thompson-7 (Tabitha Thompson — the owner of T. Turner & Associates). Include your invoice number.",
  APPLE_PAY: "Pay with Apple Pay through the Square payment link on your invoice.",
  SQUARE_INVOICE: "Pay by card through the secure Square link on your invoice.",
  SQUARE_AFTERPAY: "Shown on the Square payment page only when Afterpay is available for your purchase.",
};

/** Owner's Office → Settings: payment instructions by method, and the late-fee policy. */
export async function PlanSettingsCards() {
  const [rows, policy] = await Promise.all([prisma.paymentInstruction.findMany(), lateFeePolicy()]);
  return (
    <div className="mt-4 grid gap-4 lg:grid-cols-2">
      <Card title="Payment instructions clients see">
        <p className="mb-2 text-xs text-slate-600">One method is selected per invoice or plan; clients see only that method&apos;s instructions. Venmo and Cash App should be business profiles for business payments — please confirm with each app.</p>
        <div className="space-y-2" data-testid="instructions">
          {(Object.keys(PAY_METHODS) as (keyof typeof PAY_METHODS)[]).filter((m) => m !== "IN_HOUSE_PLAN").map((m) => {
            const r = rows.find((x) => x.method === m);
            return (
              <details key={m} className="rounded-xl bg-ivory-50 p-3 text-sm" data-method={m}>
                <summary className="cursor-pointer font-semibold">{PAY_METHODS[m].label} {r?.active ? <Badge tone="green">Shown</Badge> : <Badge tone="gray">Not shown</Badge>} <span className="font-normal text-slate-600">· {PAY_METHODS[m].fee}</span></summary>
                <ActionForm action={instructionAction.bind(null, m)} className="mt-2 space-y-2">
                  <Field label="Instructions"><textarea className="input" name="details" rows={2} defaultValue={r?.details ?? SUGGESTED[m] ?? ""} /></Field>
                  <label className="flex items-center gap-2"><input type="checkbox" name="active" defaultChecked={r?.active ?? false} /> Offer this method</label>
                  <Button type="submit" variant="secondary">Save</Button>
                </ActionForm>
              </details>
            );
          })}
        </div>
      </Card>

      <Card title="Late-fee policy">
        <div className="text-sm" data-testid="late-fee-policy">
          <p className="mb-2">{policy.enabled ? <Badge tone="red">On</Badge> : <Badge tone="gray">Off</Badge>} Proposed: {policy.graceDays}-day grace, then {policy.rateBps / 100}% of the unpaid principal for each further {policy.periodDays}-day period, never compounded{policy.capBps ? `, capped at ${policy.capBps / 100}%` : ""}.</p>
          <p className="mb-2 rounded-lg bg-amber-50 p-2 text-xs text-amber-900">Keep this off until it&apos;s reviewed: 10% every 5 days is about 60% a month, and penalties at that level are often unenforceable and may conflict with Alabama law. It also must be in each client&apos;s signed agreement.</p>
          <ActionForm action={lateFeePolicyAction} className="grid gap-2 sm:grid-cols-2">
            <Field label="Grace days"><input className="input" name="graceDays" inputMode="numeric" defaultValue={policy.graceDays} /></Field>
            <Field label="Period (days)"><input className="input" name="periodDays" inputMode="numeric" defaultValue={policy.periodDays} /></Field>
            <Field label="Rate per period (%)"><input className="input" name="rate" inputMode="decimal" defaultValue={policy.rateBps / 100} /></Field>
            <Field label="Cap (% of unpaid principal, optional)"><input className="input" name="cap" inputMode="decimal" defaultValue={policy.capBps ? policy.capBps / 100 : ""} /></Field>
            <Field label="Legal review (required to turn on)" className="sm:col-span-2"><textarea className="input" name="reviewedNote" rows={2} defaultValue={policy.reviewedNote ?? ""} /></Field>
            <label className="flex items-center gap-2 sm:col-span-2"><input type="checkbox" name="enabled" defaultChecked={policy.enabled} /> Turn late fees on</label>
            <div><Button type="submit" variant="secondary">Save policy</Button></div>
            {policy.reviewedAt && <p className="text-xs text-slate-600 sm:col-span-2">Reviewed {fmtDateTime(policy.reviewedAt)}</p>}
          </ActionForm>
        </div>
      </Card>
    </div>
  );
}
