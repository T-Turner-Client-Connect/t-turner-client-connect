import { ActionForm } from "@/components/action-form";
import { Badge, Button, Card, Field } from "@/components/ui";
import { saveFeeSettingAction } from "@/app/actions/service-agreements";
import { feeSettings } from "@/lib/services/service-agreements";
import { CARD_SURCHARGE_CAP_BPS } from "@/lib/billing/payment-fees";
import { fmtDateTime } from "@/lib/format";

const ROWS = [
  { key: "CARD_CREDIT", label: "Credit card and Apple Pay (credit card)", pct: true, flat: false, hint: `Percentage only. Applied to credit cards only — never debit — and never above ${CARD_SURCHARGE_CAP_BPS / 100}% even if a higher target is entered. Card networks also require notice before you start surcharging.` },
  { key: "CHECK", label: "Check", pct: true, flat: true, hint: "Only a fee that actually applies to you and is permitted." },
  { key: "VENMO", label: "Venmo", pct: true, flat: true, hint: "For example, the fee Venmo charges your business account." },
  { key: "CASH_APP", label: "Cash App", pct: true, flat: true, hint: "For example, the fee Cash App charges your business account." },
  { key: "REFUND_TRANSFER", label: "Refund transfer (fees deducted from the tax refund)", pct: false, flat: false, hint: "Offered only on returns staff mark eligible. The provider's fee is entered on each agreement. We never redirect a refund ourselves." },
] as const;

/** Owner's Office → Settings: fees by payment method. Cash and Zelle are always free (policy) and aren't listed. */
export async function FeeSettingsCard() {
  const rows = await feeSettings();
  return (
    <Card title="Payment-method fees">
      <p className="mb-3 text-sm text-slate-700" data-testid="fee-policy">
        Cash and Zelle never carry a fee, and debit cards (including Apple Pay with a debit card) are never surcharged. Every other fee stays <strong>off</strong> until you turn it on and record how you verified it&apos;s permitted. Agreements show each method&apos;s fee and total before the client signs; signed agreements never change.
      </p>
      <div className="space-y-3">
        {ROWS.map((r) => {
          const s = rows.find((x) => x.method === r.key);
          const active = !!s?.enabled && !!s.verifiedAt;
          return (
            <details key={r.key} className="rounded-xl bg-ivory-50 p-3 text-sm" data-testid="fee-row" data-method={r.key}>
              <summary className="cursor-pointer font-semibold">
                {r.label}{" "}
                {active ? <Badge tone="green">On{s!.percentBps ? ` · ${s!.percentBps / 100}%` : ""}{s!.flatCents ? ` · $${(s!.flatCents / 100).toFixed(2)}` : ""}{s!.providerName ? ` · ${s!.providerName}` : ""}</Badge> : <Badge tone="gray">Off — no fee</Badge>}
              </summary>
              <ActionForm action={saveFeeSettingAction.bind(null, r.key)} className="mt-2 grid gap-2 sm:grid-cols-2">
                <label className="flex items-center gap-2 sm:col-span-2"><input type="checkbox" name="enabled" defaultChecked={!!s?.enabled} /> Turn this fee on</label>
                {r.pct && <Field label="Percentage" hint={r.key === "CARD_CREDIT" ? "e.g. 3 (a 3.5 target is reduced to 3)" : undefined}><input className="input" name="percent" inputMode="decimal" defaultValue={s?.percentBps ? (s.percentBps / 100).toString() : ""} /></Field>}
                {r.flat && <Field label="Flat amount ($)"><input className="input" name="flat" inputMode="decimal" defaultValue={s?.flatCents ? (s.flatCents / 100).toFixed(2) : ""} /></Field>}
                {r.key === "REFUND_TRANSFER" && <Field label="Provider"><input className="input" name="providerName" defaultValue={s?.providerName ?? ""} placeholder="Bank product offered through your tax software" /></Field>}
                <Field label="How you verified it's permitted" hint={r.hint} className="sm:col-span-2"><textarea className="input" name="verifiedNote" rows={2} defaultValue={s?.verifiedNote ?? ""} /></Field>
                <div className="flex items-center gap-3 sm:col-span-2">
                  <Button type="submit" variant="secondary">Save</Button>
                  {s?.verifiedAt && <span className="text-xs text-slate-600">Verified {fmtDateTime(s.verifiedAt)}</span>}
                </div>
              </ActionForm>
            </details>
          );
        })}
      </div>
    </Card>
  );
}
