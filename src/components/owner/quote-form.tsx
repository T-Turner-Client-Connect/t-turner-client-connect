"use client";

import { useMemo, useState } from "react";
import { ActionForm } from "@/components/action-form";
import { Button, Field } from "@/components/ui";
import { computeBreakdown, describeAmount, money, PricingError, validatePricing, type AmountKind, type PricingInput } from "@/lib/billing/pricing";

type Line = { service: string; description: string; quantity: string; price: string };

export type QuoteDefaults = {
  clientId: string;
  title: string;
  issueDate: string;
  dueDate: string;
  memo: string;
  paymentTerms: string;
  privateNote: string;
  lines: Line[];
  allowFull: boolean;
  allowPlan: boolean;
  depositType: AmountKind;
  depositValue: string;
  discountType: AmountKind;
  discountValue: string;
  discountCoversPlanFee: boolean;
  taxRate: string;
  planInstallments: string;
  planFirstDueDate: string;
  planIntervalMonths: string;
};

const toCents = (v: string) => Math.round(Number(v.replace(/[$,\s]/g, "") || "0") * 100);
const toBps = (v: string) => Math.round(Number(v.replace(/[%\s]/g, "") || "0") * 100);
const toValue = (type: AmountKind, v: string) => (type === "FLAT" ? toCents(v) : type === "PERCENT" ? toBps(v) : 0);

export function QuoteForm({
  action,
  clients,
  defaults,
  fee,
  canOverrideFee,
  submitLabel,
}: {
  action: (prev: { error?: string; ok?: string } | null, fd: FormData) => Promise<{ error?: string; ok?: string } | null>;
  clients: { id: string; displayName: string }[];
  defaults: QuoteDefaults;
  fee: { type: AmountKind; value: number; maxInstallments: number; confirmed: boolean };
  canOverrideFee: boolean;
  submitLabel: string;
}) {
  const [f, setF] = useState(defaults);
  const [feeOverrideType, setFeeOverrideType] = useState<"" | "FLAT" | "PERCENT">("");
  const [feeOverrideValue, setFeeOverrideValue] = useState("");
  const set = <K extends keyof QuoteDefaults>(k: K, v: QuoteDefaults[K]) => setF((x) => ({ ...x, [k]: v }));
  const setLine = (i: number, k: keyof Line, v: string) => setF((x) => ({ ...x, lines: x.lines.map((l, j) => (j === i ? { ...l, [k]: v } : l)) }));

  const effectiveFee = feeOverrideType ? { type: feeOverrideType as AmountKind, value: toValue(feeOverrideType, feeOverrideValue) } : { type: fee.type, value: fee.value };
  const { breakdown, problem } = useMemo(() => {
    const input: PricingInput = {
      lines: f.lines.filter((l) => l.service.trim() || l.price.trim()).map((l) => ({ service: l.service, description: l.description, quantity: Number(l.quantity || "1"), unitCents: toCents(l.price) })),
      discountType: f.discountType,
      discountValue: toValue(f.discountType, f.discountValue),
      discountCoversPlanFee: f.discountCoversPlanFee,
      taxRateBps: toBps(f.taxRate),
      planFeeType: f.allowPlan ? effectiveFee.type : "NONE",
      planFeeValue: f.allowPlan ? effectiveFee.value : 0,
      depositType: f.depositType,
      depositValue: toValue(f.depositType, f.depositValue),
      allowFull: f.allowFull,
      allowPlan: f.allowPlan,
      issueDate: f.issueDate,
      dueDate: f.dueDate,
      planInstallments: Number(f.planInstallments || "0"),
      planFirstDueDate: f.planFirstDueDate || null,
      planIntervalMonths: Number(f.planIntervalMonths || "1"),
    };
    let problem: string | null = null;
    try {
      validatePricing(input, { maxInstallments: fee.maxInstallments });
    } catch (e) {
      problem = e instanceof PricingError ? e.message : "Check the quote details.";
    }
    try {
      return { breakdown: computeBreakdown(input), problem };
    } catch {
      return { breakdown: null, problem };
    }
  }, [f, effectiveFee.type, effectiveFee.value, fee.maxInstallments]);

  return (
    <ActionForm action={action} className="grid gap-6 lg:grid-cols-[1fr_380px]">
      <div className="space-y-5">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Client">
            <select className="input" name="clientId" value={f.clientId} onChange={(e) => set("clientId", e.target.value)} required>
              <option value="">Choose a client…</option>
              {clients.map((c) => (
                <option key={c.id} value={c.id}>{c.displayName}</option>
              ))}
            </select>
          </Field>
          <Field label="Title (shown to the client)"><input className="input" name="title" value={f.title} onChange={(e) => set("title", e.target.value)} required placeholder="2026 tax preparation" /></Field>
          <Field label="Quote / invoice date"><input className="input" type="date" name="issueDate" value={f.issueDate} onChange={(e) => set("issueDate", e.target.value)} required /></Field>
          <Field label="Full payment due"><input className="input" type="date" name="dueDate" value={f.dueDate} onChange={(e) => set("dueDate", e.target.value)} required /></Field>
        </div>

        <fieldset className="space-y-2">
          <legend className="mb-1 font-semibold text-navy-900">Services</legend>
          {f.lines.map((l, i) => (
            <div key={i} className="grid gap-2 rounded-lg border border-navy-100 p-3 sm:grid-cols-[2fr_2fr_80px_120px_auto]">
              <input className="input" name="line_service" aria-label={`Service ${i + 1}`} placeholder="Service" value={l.service} onChange={(e) => setLine(i, "service", e.target.value)} />
              <input className="input" name="line_description" aria-label={`Description ${i + 1}`} placeholder="Description (optional)" value={l.description} onChange={(e) => setLine(i, "description", e.target.value)} />
              <input className="input" name="line_quantity" aria-label={`Quantity ${i + 1}`} inputMode="numeric" value={l.quantity} onChange={(e) => setLine(i, "quantity", e.target.value)} />
              <input className="input" name="line_price" aria-label={`Price ${i + 1}`} inputMode="decimal" placeholder="0.00" value={l.price} onChange={(e) => setLine(i, "price", e.target.value)} />
              <Button type="button" variant="ghost" onClick={() => setF((x) => ({ ...x, lines: x.lines.filter((_, j) => j !== i) }))} disabled={f.lines.length === 1}>Remove</Button>
            </div>
          ))}
          <Button type="button" variant="secondary" onClick={() => setF((x) => ({ ...x, lines: [...x.lines, { service: "", description: "", quantity: "1", price: "" }] }))}>Add a line</Button>
          <p className="text-xs text-slate-600">Don&apos;t add payment-plan fees or surcharges as lines — the plan fee is added automatically from your Billing settings.</p>
        </fieldset>

        <fieldset className="grid gap-3 sm:grid-cols-2">
          <legend className="mb-1 font-semibold text-navy-900">Discount, tax and deposit</legend>
          <Field label="Discount">
            <div className="flex gap-2">
              <select className="input w-32" name="discountType" value={f.discountType} onChange={(e) => set("discountType", e.target.value as AmountKind)}>
                <option value="NONE">None</option><option value="FLAT">$ off</option><option value="PERCENT">% off</option>
              </select>
              {f.discountType !== "NONE" && <input className="input" name="discountValue" inputMode="decimal" aria-label="Discount amount" value={f.discountValue} onChange={(e) => set("discountValue", e.target.value)} />}
            </div>
          </Field>
          <Field label="Sales tax rate (%)" hint="Only if these services are taxable. Leave 0 if not.">
            <input className="input" name="taxRate" inputMode="decimal" value={f.taxRate} onChange={(e) => set("taxRate", e.target.value)} />
          </Field>
          {f.discountType !== "NONE" && (
            <label className="flex items-start gap-2 text-sm sm:col-span-2">
              <input type="checkbox" name="discountCoversPlanFee" checked={f.discountCoversPlanFee} onChange={(e) => set("discountCoversPlanFee", e.target.checked)} className="mt-1" />
              <span>Also apply this discount to the payment-plan fee (otherwise it reduces service charges only)</span>
            </label>
          )}
          <Field label="Deposit required">
            <div className="flex gap-2">
              <select className="input w-32" name="depositType" value={f.depositType} onChange={(e) => set("depositType", e.target.value as AmountKind)}>
                <option value="NONE">None</option><option value="FLAT">$ amount</option><option value="PERCENT">% of total</option>
              </select>
              {f.depositType !== "NONE" && <input className="input" name="depositValue" inputMode="decimal" aria-label="Deposit amount" value={f.depositValue} onChange={(e) => set("depositValue", e.target.value)} />}
            </div>
          </Field>
        </fieldset>

        <fieldset className="space-y-3">
          <legend className="mb-1 font-semibold text-navy-900">Payment options the client may choose</legend>
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="allowFull" checked={f.allowFull} onChange={(e) => set("allowFull", e.target.checked)} /> Full payment</label>
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="allowPlan" checked={f.allowPlan} onChange={(e) => set("allowPlan", e.target.checked)} /> Payment plan</label>
          {f.allowPlan && (
            <div className="grid gap-3 rounded-lg bg-ivory p-3 sm:grid-cols-3">
              <Field label={`Installments (2–${fee.maxInstallments})`}><input className="input" name="planInstallments" inputMode="numeric" value={f.planInstallments} onChange={(e) => set("planInstallments", e.target.value)} /></Field>
              <Field label="First installment due"><input className="input" type="date" name="planFirstDueDate" value={f.planFirstDueDate} onChange={(e) => set("planFirstDueDate", e.target.value)} /></Field>
              <Field label="Every">
                <select className="input" name="planIntervalMonths" value={f.planIntervalMonths} onChange={(e) => set("planIntervalMonths", e.target.value)}>
                  <option value="1">Month</option><option value="2">2 months</option><option value="3">3 months</option>
                </select>
              </Field>
              <p className="text-sm sm:col-span-3">
                Payment-plan fee from your settings: <strong>{fee.type === "NONE" ? "not set" : describeAmount(fee.type, fee.value)}</strong>
                {fee.type === "PERCENT" && " of services after discount, before tax"}. It is added once, only if the client chooses the plan.
                {!fee.confirmed && fee.type !== "NONE" && " Confirm the fee rules in Billing settings first."}
              </p>
              {canOverrideFee && (
                <div className="flex flex-wrap items-end gap-2 sm:col-span-3">
                  <Field label="Override the fee on this quote (owner only)">
                    <select className="input" name="feeOverrideType" value={feeOverrideType} onChange={(e) => setFeeOverrideType(e.target.value as "" | "FLAT" | "PERCENT")}>
                      <option value="">Use my settings</option><option value="FLAT">Flat $</option><option value="PERCENT">%</option>
                    </select>
                  </Field>
                  {feeOverrideType && <input className="input w-32" name="feeOverrideValue" inputMode="decimal" aria-label="Fee override amount" value={feeOverrideValue} onChange={(e) => setFeeOverrideValue(e.target.value)} />}
                </div>
              )}
            </div>
          )}
        </fieldset>

        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Payment terms (shown to the client)"><textarea className="input" name="paymentTerms" rows={3} value={f.paymentTerms} onChange={(e) => set("paymentTerms", e.target.value)} /></Field>
          <Field label="Note to the client"><textarea className="input" name="memo" rows={3} value={f.memo} onChange={(e) => set("memo", e.target.value)} /></Field>
          <Field label="Private note (only you see this)" className="sm:col-span-2"><textarea className="input" name="privateNote" rows={2} value={f.privateNote} onChange={(e) => set("privateNote", e.target.value)} /></Field>
        </div>
        <Button type="submit">{submitLabel}</Button>
      </div>

      <aside className="h-fit rounded-xl border border-gold-500/50 bg-white p-4 shadow-sm lg:sticky lg:top-6" aria-label="What the client will see">
        <h3 className="font-serif text-lg font-bold text-navy-900">What the client will see</h3>
        {problem && <p className="mt-2 rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-900">{problem}</p>}
        {breakdown && (
          <div className="mt-3 space-y-3 text-sm" data-testid="quote-preview">
            <Row label="Services" value={money(breakdown.subtotalCents)} />
            {breakdown.serviceDiscountCents > 0 && <Row label="Discount" value={`−${money(breakdown.serviceDiscountCents)}`} />}
            {breakdown.taxCents > 0 && <Row label="Sales tax" value={money(breakdown.taxCents)} />}
            {(["FULL", "PLAN"] as const).map((k) => {
              const o = breakdown.options[k];
              if (!o) return null;
              return (
                <div key={k} className="rounded-lg bg-navy-50 p-3">
                  <p className="font-semibold text-navy-900">{k === "FULL" ? "Pay in full" : "Payment plan"}</p>
                  {k === "PLAN" && <Row label="Payment-plan fee" value={money(o.planFeeCents)} />}
                  {o.planFeeDiscountCents > 0 && <Row label="Discount on plan fee" value={`−${money(o.planFeeDiscountCents)}`} />}
                  <Row label="Total" value={money(o.totalCents)} strong />
                  <ul className="mt-1 space-y-0.5 text-xs text-slate-700">
                    {o.schedule.map((s) => (
                      <li key={s.seq} className="flex justify-between"><span>{s.label} · due {s.dueDate}</span><span>{money(s.amountCents)}</span></li>
                    ))}
                  </ul>
                </div>
              );
            })}
            <ul className="list-disc space-y-0.5 pl-4 text-xs text-slate-600">{breakdown.explanation.map((e) => <li key={e}>{e}</li>)}</ul>
          </div>
        )}
      </aside>
    </ActionForm>
  );
}

function Row({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className={`flex justify-between ${strong ? "font-bold text-navy-900" : ""}`}>
      <span>{label}</span>
      <span>{value}</span>
    </div>
  );
}
