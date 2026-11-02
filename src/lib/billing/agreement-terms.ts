import { createHash } from "node:crypto";
import type { MethodQuote } from "./payment-fees";

/** Exactly what a pricing agreement shows the client. Frozen per version. */
export type AgreementTerms = {
  business: string;
  agreementTitle: string;
  kind: "SERVICE" | "TAX_PAYMENT_SELECTION";
  version: number;
  clientName: string;
  businessName: string | null;
  serviceTitle: string;
  serviceTypeLabel: string;
  taxYear: number | null;
  periodLabel: string | null;
  description: string | null;
  lines: { label: string; cents: number }[];
  baseCents: number;
  options: MethodQuote[];
  paymentTerms: string;
  refundTransfer: { eligible: boolean; feeCents: number; provider: string | null } | null;
  // Acknowledgments the client agrees to by signing (e.g. the grant assistance disclaimer).
  disclaimers?: { title: string; text: string }[];
};

export type AgreementSelection = { method: string; label: string; feeCents: number; totalCents: number; note: string };

export const AGREEMENT_TITLES = {
  SERVICE: "Service Pricing & Payment Agreement",
  TAX_PAYMENT_SELECTION: "Tax Preparation Payment Selection & Fee Agreement",
} as const;

export const CONSENT_TEXT =
  "I have reviewed the service, price, payment method, any processing or transfer fee and the total shown above. I agree to these pricing and payment terms, and I agree to sign this agreement electronically. Typing my name and selecting Sign is my signature.";

/** Fingerprint of the terms plus the client's selection: what was signed is exactly what was shown. */
export function termsHash(terms: AgreementTerms, selection: AgreementSelection | null) {
  return createHash("sha256").update(JSON.stringify({ terms, selection })).digest("hex");
}
