/**
 * Payment methods offered on pricing agreements and the fee each may carry.
 *
 * Business policy: cash and Zelle never carry a fee. Other methods may carry
 * the owner's configured fee — but only after the owner turns it on and records
 * how it was verified as permitted. Until then the method has no fee.
 *
 * Card rules built in (not configurable):
 * - Debit cards (including Apple Pay with a debit card) are never surcharged;
 *   card-network rules prohibit surcharging debit and prepaid cards.
 * - A credit-card surcharge is capped at 3%. Visa's rules cap surcharges at 3%
 *   (Mastercard's cap is higher), and a surcharge can't exceed the business's
 *   actual cost of card acceptance — the owner's verification note should say so.
 *   A configured 3.5% target is reduced to the cap, never applied above it.
 * Nothing here charges anyone; it only calculates what an agreement discloses.
 */

export const PAYMENT_METHODS = {
  REFUND_TRANSFER: { label: "Deduct My Tax Preparation Fees From My Tax Refund", short: "Refund transfer", group: "refund", taxOnly: true },
  CHECK: { label: "Check", short: "Check", group: "configurable", taxOnly: false },
  CASH: { label: "Cash", short: "Cash", group: "never", taxOnly: false },
  CARD_CREDIT: { label: "Credit card", short: "Credit card", group: "credit", taxOnly: false },
  CARD_DEBIT: { label: "Debit card", short: "Debit card", group: "debit", taxOnly: false },
  ZELLE: { label: "Zelle", short: "Zelle", group: "never", taxOnly: false },
  VENMO: { label: "Venmo", short: "Venmo", group: "configurable", taxOnly: false },
  APPLE_PAY_CREDIT: { label: "Apple Pay (with a credit card)", short: "Apple Pay (credit)", group: "credit", taxOnly: false },
  APPLE_PAY_DEBIT: { label: "Apple Pay (with a debit card)", short: "Apple Pay (debit)", group: "debit", taxOnly: false },
  CASH_APP: { label: "Cash App", short: "Cash App", group: "configurable", taxOnly: false },
} as const;
export type MethodKey = keyof typeof PAYMENT_METHODS;
export const METHOD_KEYS = Object.keys(PAYMENT_METHODS) as MethodKey[];

/** Settings rows are keyed by these. Credit card and Apple Pay (credit) share one card-surcharge setting. */
export const FEE_SETTING_KEYS = ["CARD_CREDIT", "CHECK", "VENMO", "CASH_APP", "REFUND_TRANSFER"] as const;
export type FeeSettingKey = (typeof FEE_SETTING_KEYS)[number];
export const settingKeyFor = (m: MethodKey): FeeSettingKey | null =>
  m === "CARD_CREDIT" || m === "APPLE_PAY_CREDIT" ? "CARD_CREDIT" : (FEE_SETTING_KEYS as readonly string[]).includes(m) ? (m as FeeSettingKey) : null;

export const CARD_SURCHARGE_CAP_BPS = 300;

export type FeeSetting = { method: string; enabled: boolean; percentBps: number; flatCents: number; verifiedAt: Date | null; providerName?: string | null };
export type RefundTransfer = { eligible: boolean; feeCents: number } | null;

export type MethodQuote = {
  method: MethodKey;
  label: string;
  available: boolean;
  feeCents: number;
  totalCents: number;
  note: string;
};

const pct = (cents: number, bps: number) => Math.round((cents * bps) / 10_000);

/** The fee for one method on a base amount, with the reason it does or doesn't apply. */
export function quoteMethod(method: MethodKey, baseCents: number, settings: FeeSetting[], opts: { kind: "SERVICE" | "TAX_PAYMENT_SELECTION"; refundTransfer?: RefundTransfer }): MethodQuote {
  const def = PAYMENT_METHODS[method];
  const out = (available: boolean, feeCents: number, note: string): MethodQuote => ({ method, label: def.label, available, feeCents, totalCents: baseCents + feeCents, note });
  if (def.taxOnly && opts.kind !== "TAX_PAYMENT_SELECTION") return out(false, 0, "Only for tax preparation.");
  if (def.group === "never") return out(true, 0, "No additional transfer fee.");
  if (def.group === "debit") return out(true, 0, "No fee — debit cards can't be surcharged.");
  const key = settingKeyFor(method)!;
  const s = settings.find((x) => x.method === key);
  const active = !!s?.enabled && !!s.verifiedAt;
  if (def.group === "refund") {
    if (!active || !s?.providerName) return out(false, 0, "Not offered — no refund-transfer provider is set up.");
    if (!opts.refundTransfer?.eligible) return out(false, 0, "Not available for this return.");
    const fee = Math.max(0, Math.round(opts.refundTransfer.feeCents));
    return out(true, fee, `Includes ${s.providerName}'s refund-transfer fee. The provider handles the refund; we never redirect it ourselves.`);
  }
  if (!active) return out(true, 0, "No additional fee.");
  if (def.group === "credit") {
    const bps = Math.min(s!.percentBps, CARD_SURCHARGE_CAP_BPS);
    const capped = s!.percentBps > CARD_SURCHARGE_CAP_BPS;
    return out(true, pct(baseCents, bps), `${(bps / 100).toFixed(2).replace(/\.?0+$/, "")}% credit-card surcharge${capped ? " (reduced to the 3% card-network maximum)" : ""}. No surcharge on debit cards.`);
  }
  const fee = pct(baseCents, s!.percentBps) + s!.flatCents;
  return out(true, fee, fee ? `${[s!.percentBps ? `${(s!.percentBps / 100).toFixed(2).replace(/\.?0+$/, "")}%` : "", s!.flatCents ? `$${(s!.flatCents / 100).toFixed(2)}` : ""].filter(Boolean).join(" + ")} payment fee.` : "No additional fee.");
}

/** Every method's quote, in display order. */
export function quoteAll(baseCents: number, settings: FeeSetting[], opts: { kind: "SERVICE" | "TAX_PAYMENT_SELECTION"; refundTransfer?: RefundTransfer }) {
  return METHOD_KEYS.map((m) => quoteMethod(m, baseCents, settings, opts)).filter((q) => !(PAYMENT_METHODS[q.method].taxOnly && opts.kind !== "TAX_PAYMENT_SELECTION"));
}

export const usd = (cents: number) => `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
