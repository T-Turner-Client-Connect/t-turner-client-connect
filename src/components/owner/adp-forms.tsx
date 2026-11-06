import { Field } from "@/components/ui";
import { ADP_PRODUCTS, ADP_PRODUCT_LABELS, LINE_TYPES, LINE_TYPE_LABELS, PAYMENT_METHODS, PAYMENT_METHOD_LABELS } from "@/lib/adp-revenue-share";
import { AdpClientPicker, type PickerClient } from "./adp-client-picker";

const dollarsOf = (cents: number | null | undefined) => (cents === null || cents === undefined ? "" : (cents / 100).toFixed(2));

/** Referral fields (create and edit). Client OR prospect name; clients are only ever chosen, never created. */
export function ReferralFields({ clients, today, r }: { clients: PickerClient[]; today: string; r?: { clientId: string | null; prospectName: string | null; referredOn: string; product: string; productOther: string | null; adpReference: string | null; notes: string | null } }) {
  return (
    <div className="grid gap-3">
      <AdpClientPicker clients={clients} defaultId={r?.clientId ?? ""} label="Client (if they're already a client)" emptyHint="No client matches. Enter them as a prospect below; link the client later." testId="referral-client" />
      <Field label="Or prospect name" hint="A business that isn't a client yet. Link it to the client record later.">
        <input className="input" name="prospectName" defaultValue={r?.prospectName ?? ""} maxLength={200} />
      </Field>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Date referred"><input className="input" type="date" name="referredOn" defaultValue={r?.referredOn ?? today} required /></Field>
        <Field label="ADP product">
          <select className="input" name="product" defaultValue={r?.product ?? "RUN"} required>
            {ADP_PRODUCTS.map((p) => <option key={p} value={p}>{ADP_PRODUCT_LABELS[p]}</option>)}
          </select>
        </Field>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Other product (if “Other”)"><input className="input" name="productOther" defaultValue={r?.productOther ?? ""} maxLength={120} placeholder="e.g. ADP TotalSource" /></Field>
        <Field label="ADP referral / reference ID (optional)"><input className="input" name="adpReference" defaultValue={r?.adpReference ?? ""} maxLength={120} /></Field>
      </div>
      <Field label="Notes"><textarea className="input" name="notes" rows={2} defaultValue={r?.notes ?? ""} maxLength={5000} /></Field>
    </div>
  );
}

export function StatementHeaderFields({ s, today }: { s?: { periodLabel: string; periodStart: string; periodEnd: string; statementDate: string; reportedTotalCents: number; notes: string | null }; today: string }) {
  return (
    <div className="grid gap-3">
      <Field label="Period label" hint="As ADP names it, e.g. “ADP FY2027 Q1 (Jul–Sep 2026)”."><input className="input" name="periodLabel" defaultValue={s?.periodLabel ?? ""} required maxLength={120} /></Field>
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Period start"><input className="input" type="date" name="periodStart" defaultValue={s?.periodStart ?? ""} required /></Field>
        <Field label="Period end"><input className="input" type="date" name="periodEnd" defaultValue={s?.periodEnd ?? ""} required /></Field>
        <Field label="Statement date"><input className="input" type="date" name="statementDate" defaultValue={s?.statementDate ?? today} required /></Field>
      </div>
      <Field label="Statement total" hint="The total printed on ADP's statement. A warning shows if the lines don't add up to it."><input className="input" name="reportedTotal" inputMode="decimal" placeholder="0.00" defaultValue={dollarsOf(s?.reportedTotalCents)} required /></Field>
      <Field label="Notes"><textarea className="input" name="notes" rows={2} defaultValue={s?.notes ?? ""} maxLength={5000} /></Field>
    </div>
  );
}

export function LineFields({ referrals, clients, l, idPrefix }: { referrals: { id: string; label: string }[]; clients: PickerClient[]; l?: { type: string; amountCents: number; referralId: string | null; clientId: string | null; adpName: string | null; note: string | null }; idPrefix: string }) {
  return (
    <div className="grid gap-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Type">
          <select className="input" name="type" defaultValue={l?.type ?? "COMMISSION"} required>
            {LINE_TYPES.map((t) => <option key={t} value={t}>{LINE_TYPE_LABELS[t]}</option>)}
          </select>
        </Field>
        <Field label="Amount" hint="Adjustments may be negative, e.g. -25.00."><input className="input" name="amount" inputMode="decimal" placeholder="0.00" defaultValue={dollarsOf(l?.amountCents)} required /></Field>
      </div>
      <Field label="Referral">
        <select className="input" name="referralId" defaultValue={l?.referralId ?? ""}>
          <option value="">— No referral —</option>
          {referrals.map((r) => <option key={r.id} value={r.id}>{r.label}</option>)}
        </select>
      </Field>
      <AdpClientPicker clients={clients} defaultId={l?.clientId ?? ""} label="Or a client directly (optional)" testId={`${idPrefix}-client`} />
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Name on ADP's statement (optional)"><input className="input" name="adpName" defaultValue={l?.adpName ?? ""} maxLength={200} /></Field>
        <Field label="Note"><input className="input" name="note" defaultValue={l?.note ?? ""} maxLength={1000} /></Field>
      </div>
    </div>
  );
}

export function PaymentFields({ p, today }: { p?: { receivedOn: string; amountCents: number; method: string; methodOther: string | null; periodsCovered: string | null; reference: string | null; note: string | null }; today: string }) {
  return (
    <div className="grid gap-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Date received"><input className="input" type="date" name="receivedOn" defaultValue={p?.receivedOn ?? today} required /></Field>
        <Field label="Amount"><input className="input" name="amount" inputMode="decimal" placeholder="0.00" defaultValue={dollarsOf(p?.amountCents)} required /></Field>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Method">
          <select className="input" name="method" defaultValue={p?.method ?? "ACH"} required>
            {PAYMENT_METHODS.map((m) => <option key={m} value={m}>{PAYMENT_METHOD_LABELS[m]}</option>)}
          </select>
        </Field>
        <Field label="Other method (if “Other”)"><input className="input" name="methodOther" defaultValue={p?.methodOther ?? ""} maxLength={120} /></Field>
      </div>
      <Field label="Period(s) covered" hint="e.g. “ADP FY2027 Q1”, or two quarters if ADP paid them together."><input className="input" name="periodsCovered" defaultValue={p?.periodsCovered ?? ""} maxLength={200} /></Field>
      <Field label="Reference (ACH trace or check number)"><input className="input" name="reference" defaultValue={p?.reference ?? ""} maxLength={120} /></Field>
      <Field label="Note"><input className="input" name="note" defaultValue={p?.note ?? ""} maxLength={2000} /></Field>
    </div>
  );
}

/** Soft-delete form body: a reason is always required; nothing is erased. */
export function ReasonField({ label = "Reason (required)", name = "reason", hint }: { label?: string; name?: string; hint?: string }) {
  return (
    <Field label={label} hint={hint}>
      <input className="input" name={name} required minLength={3} maxLength={2000} />
    </Field>
  );
}
