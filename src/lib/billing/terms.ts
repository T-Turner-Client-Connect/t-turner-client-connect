import "server-only";
import { createHash } from "node:crypto";
import { PricingError, type Breakdown, type Option } from "./pricing";

/** The exact terms a client accepts, and a fingerprint of them for the record. */
export function termsSnapshot(input: { invoiceNumber: string; title: string; clientName: string; breakdown: Breakdown; option: Option; paymentTerms: string | null; memo: string | null }) {
  const chosen = input.breakdown.options[input.option];
  if (!chosen) throw new PricingError("That payment option isn't offered on this quote.");
  const terms = {
    version: 1,
    invoiceNumber: input.invoiceNumber,
    title: input.title,
    client: input.clientName,
    option: input.option,
    lines: input.breakdown.lines,
    subtotalCents: input.breakdown.subtotalCents,
    serviceDiscountCents: input.breakdown.serviceDiscountCents,
    taxCents: input.breakdown.taxCents,
    planFeeCents: chosen.planFeeCents,
    planFeeDiscountCents: chosen.planFeeDiscountCents,
    totalCents: chosen.totalCents,
    depositCents: chosen.depositCents,
    schedule: chosen.schedule,
    explanation: input.breakdown.explanation,
    paymentTerms: input.paymentTerms,
    memo: input.memo,
    automaticCharges: false,
  };
  const hash = createHash("sha256").update(JSON.stringify(terms)).digest("hex");
  return { terms, hash };
}

