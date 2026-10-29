/**
 * Quote / invoice math. All money is integer cents; percentages are basis
 * points (100 = 1%). Rounding is half-up to the cent at each step, and every
 * step is shown to the client before acceptance — no hidden amounts.
 *
 * Order of calculation (also printed on the quote):
 *   1. Services subtotal = Σ quantity × unit price
 *   2. Discount on services (flat $, capped at the subtotal, or % of the subtotal)
 *   3. Sales tax = tax rate × (services after discount)
 *   4. Full-payment total = services after discount + tax
 *   5. Payment-plan fee (plan only) = flat $, or % × (services after discount, before tax)
 *      — optionally reduced by the discount if the owner chose that
 *   6. Plan total = full-payment total + plan fee after any fee discount
 *   7. Deposit (flat $ or % of the chosen option's total), then the rest in installments
 */
export type AmountKind = "NONE" | "FLAT" | "PERCENT";
export type Option = "FULL" | "PLAN";

export type PricingInput = {
  lines: { service: string; description?: string | null; quantity: number; unitCents: number }[];
  discountType: AmountKind;
  discountValue: number;
  discountCoversPlanFee: boolean;
  taxRateBps: number;
  planFeeType: AmountKind;
  planFeeValue: number;
  depositType: AmountKind;
  depositValue: number;
  allowFull: boolean;
  allowPlan: boolean;
  issueDate: string; // YYYY-MM-DD
  dueDate: string;
  planInstallments: number;
  planFirstDueDate: string | null;
  planIntervalMonths: number;
};

export type ScheduleItem = { seq: number; label: string; dueDate: string; amountCents: number };

export type OptionTerms = {
  option: Option;
  planFeeCents: number;
  planFeeDiscountCents: number;
  totalCents: number;
  depositCents: number;
  schedule: ScheduleItem[];
};

export type Breakdown = {
  lines: { service: string; description: string | null; quantity: number; unitCents: number; amountCents: number }[];
  subtotalCents: number;
  serviceDiscountCents: number;
  servicesAfterDiscountCents: number;
  taxCents: number;
  fullTotalCents: number;
  options: Partial<Record<Option, OptionTerms>>;
  explanation: string[];
};

const pct = (base: number, bps: number) => Math.round((base * bps) / 10000);

export function money(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  return `${sign}$${(Math.abs(cents) / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function describeAmount(type: AmountKind, value: number): string {
  if (type === "FLAT") return money(value);
  if (type === "PERCENT") return `${(value / 100).toLocaleString("en-US", { maximumFractionDigits: 2 })}%`;
  return "none";
}

/** Adds whole months to a YYYY-MM-DD date, clamping to the month's last day. */
export function addMonths(date: string, months: number): string {
  const [y, m, d] = date.split("-").map(Number);
  const target = new Date(Date.UTC(y, m - 1 + months, 1));
  const last = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(d, last));
  return target.toISOString().slice(0, 10);
}

export class PricingError extends Error {}

export function validatePricing(i: PricingInput, settings: { maxInstallments: number }) {
  if (i.lines.length === 0) throw new PricingError("Add at least one service line.");
  for (const l of i.lines) {
    if (!l.service.trim()) throw new PricingError("Each line needs a service name.");
    if (!Number.isInteger(l.quantity) || l.quantity < 1 || l.quantity > 1000) throw new PricingError("Quantities must be whole numbers from 1 to 1,000.");
    if (!Number.isInteger(l.unitCents) || l.unitCents < 0 || l.unitCents > 100_000_000) throw new PricingError("Enter a valid price for each line.");
    // The plan fee is calculated, never typed in as a line — prevents charging it twice.
    if (/payment[\s-]*plan\s*fee|installment\s*fee|convenience\s*fee|surcharge/i.test(`${l.service} ${l.description ?? ""}`)) {
      throw new PricingError("Don't add plan fees or surcharges as a line — the payment-plan fee is added automatically from your settings.");
    }
  }
  if (!i.allowFull && !i.allowPlan) throw new PricingError("Offer full payment, a payment plan, or both.");
  const checkAmount = (label: string, type: AmountKind, value: number) => {
    if (type === "NONE") return;
    if (!Number.isInteger(value) || value < 0) throw new PricingError(`Enter a valid ${label}.`);
    if (type === "PERCENT" && value > 10000) throw new PricingError(`A ${label} can't be more than 100%.`);
  };
  checkAmount("discount", i.discountType, i.discountValue);
  checkAmount("deposit", i.depositType, i.depositValue);
  checkAmount("payment-plan fee", i.planFeeType, i.planFeeValue);
  if (!Number.isInteger(i.taxRateBps) || i.taxRateBps < 0 || i.taxRateBps > 2000) throw new PricingError("Enter a tax rate between 0% and 20%.");
  if (i.dueDate < i.issueDate) throw new PricingError("The due date can't be before the quote date.");
  if (i.allowPlan) {
    if (i.planFeeType === "NONE" || i.planFeeValue <= 0) throw new PricingError("Set your payment-plan fee in Billing settings before offering a plan.");
    if (!Number.isInteger(i.planInstallments) || i.planInstallments < 2 || i.planInstallments > settings.maxInstallments) {
      throw new PricingError(`Payment plans need 2 to ${settings.maxInstallments} installments (your Billing settings limit).`);
    }
    if (!i.planFirstDueDate || i.planFirstDueDate < i.issueDate) throw new PricingError("Choose the first installment's due date (on or after the quote date).");
    if (![1, 2, 3].includes(i.planIntervalMonths)) throw new PricingError("Installments can be 1, 2 or 3 months apart.");
  }
}

export function computeBreakdown(i: PricingInput): Breakdown {
  const lines = i.lines.map((l) => ({ service: l.service.trim(), description: l.description?.trim() || null, quantity: l.quantity, unitCents: l.unitCents, amountCents: l.quantity * l.unitCents }));
  const subtotal = lines.reduce((s, l) => s + l.amountCents, 0);
  const serviceDiscount =
    i.discountType === "FLAT" ? Math.min(i.discountValue, subtotal) : i.discountType === "PERCENT" ? Math.min(pct(subtotal, i.discountValue), subtotal) : 0;
  const services = subtotal - serviceDiscount;
  const tax = pct(services, i.taxRateBps);
  const fullTotal = services + tax;

  const explanation = [
    `Services subtotal ${money(subtotal)}.`,
    serviceDiscount ? `Discount (${describeAmount(i.discountType, i.discountValue)}) on services: −${money(serviceDiscount)}.` : "No discount.",
    i.taxRateBps ? `Sales tax ${describeAmount("PERCENT", i.taxRateBps)} on ${money(services)}: ${money(tax)}.` : "No sales tax.",
  ];

  const deposit = (total: number) =>
    i.depositType === "FLAT" ? Math.min(i.depositValue, total) : i.depositType === "PERCENT" ? Math.min(pct(total, i.depositValue), total) : 0;

  const options: Breakdown["options"] = {};
  if (i.allowFull) {
    const dep = deposit(fullTotal);
    const schedule: ScheduleItem[] = [];
    if (dep > 0) schedule.push({ seq: 1, label: "Deposit", dueDate: i.issueDate, amountCents: dep });
    if (fullTotal - dep > 0 || schedule.length === 0) schedule.push({ seq: schedule.length + 1, label: dep > 0 ? "Balance" : "Payment in full", dueDate: i.dueDate, amountCents: fullTotal - dep });
    options.FULL = { option: "FULL", planFeeCents: 0, planFeeDiscountCents: 0, totalCents: fullTotal, depositCents: dep, schedule };
  }
  if (i.allowPlan) {
    const fee = i.planFeeType === "FLAT" ? i.planFeeValue : i.planFeeType === "PERCENT" ? pct(services, i.planFeeValue) : 0;
    let feeDiscount = 0;
    if (i.discountCoversPlanFee) {
      if (i.discountType === "PERCENT") feeDiscount = pct(fee, i.discountValue);
      if (i.discountType === "FLAT") feeDiscount = Math.max(0, Math.min(i.discountValue - serviceDiscount, fee));
    }
    const total = fullTotal + fee - feeDiscount;
    const dep = deposit(total);
    const rest = total - dep;
    const n = i.planInstallments;
    const each = Math.floor(rest / n);
    const schedule: ScheduleItem[] = [];
    if (dep > 0) schedule.push({ seq: 1, label: "Deposit", dueDate: i.issueDate, amountCents: dep });
    for (let k = 0; k < n; k++) {
      // Any leftover cents go on the last installment so the schedule adds up exactly.
      const amount = k === n - 1 ? rest - each * (n - 1) : each;
      schedule.push({ seq: schedule.length + 1, label: `Installment ${k + 1} of ${n}`, dueDate: addMonths(i.planFirstDueDate!, k * i.planIntervalMonths), amountCents: amount });
    }
    options.PLAN = { option: "PLAN", planFeeCents: fee, planFeeDiscountCents: feeDiscount, totalCents: total, depositCents: dep, schedule };
    explanation.push(
      i.planFeeType === "PERCENT"
        ? `Payment-plan fee: ${describeAmount("PERCENT", i.planFeeValue)} of the services after discount (${money(services)}, before tax) = ${money(fee)}. Charged once, only if you choose the payment plan.`
        : `Payment-plan fee: flat ${money(fee)}. Charged once, only if you choose the payment plan.`,
    );
    if (feeDiscount) explanation.push(`Discount applied to the payment-plan fee: −${money(feeDiscount)}.`);
  }
  return { lines, subtotalCents: subtotal, serviceDiscountCents: serviceDiscount, servicesAfterDiscountCents: services, taxCents: tax, fullTotalCents: fullTotal, options, explanation };
}

export type PaymentRow = { kind: "PAYMENT" | "REFUND"; status: "SUCCEEDED" | "FAILED" | "PENDING"; amountCents: number };

/** Cash actually collected: successful payments minus successful refunds. Pending and failed never count. */
export function collectedCents(payments: PaymentRow[]): number {
  return payments.reduce((s, p) => (p.status !== "SUCCEEDED" ? s : p.kind === "REFUND" ? s - p.amountCents : s + p.amountCents), 0);
}

export type InstallmentStatus = ScheduleItem & { paidCents: number; dueCents: number; state: "PAID" | "PARTIAL" | "DUE" | "OVERDUE"; daysOverdue: number };

/** Applies collected cash to the schedule in order and flags overdue amounts. */
export function scheduleStatus(schedule: ScheduleItem[], collected: number, today: string): InstallmentStatus[] {
  let left = Math.max(0, collected);
  return schedule.map((s) => {
    const paid = Math.min(left, s.amountCents);
    left -= paid;
    const due = s.amountCents - paid;
    const overdue = due > 0 && s.dueDate < today;
    const daysOverdue = overdue ? Math.round((Date.parse(today) - Date.parse(s.dueDate)) / 86400000) : 0;
    return { ...s, paidCents: paid, dueCents: due, state: due === 0 ? "PAID" : overdue ? "OVERDUE" : paid > 0 ? "PARTIAL" : "DUE", daysOverdue };
  });
}

export const AGING_BUCKETS = ["Current", "1–30 days", "31–60 days", "61–90 days", "Over 90 days"] as const;
export type AgingBucket = (typeof AGING_BUCKETS)[number];

export function agingBucket(daysOverdue: number): AgingBucket {
  if (daysOverdue <= 0) return "Current";
  if (daysOverdue <= 30) return "1–30 days";
  if (daysOverdue <= 60) return "31–60 days";
  if (daysOverdue <= 90) return "61–90 days";
  return "Over 90 days";
}
