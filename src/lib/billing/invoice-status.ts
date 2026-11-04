/**
 * Firm invoices (T. Turner & Associates billing its own clients): statuses, services and the
 * payment options an invoice can offer. Pure helpers — safe in client components and tests.
 * Managed bookkeeping clients' own invoicing (ClientInvoice) is separate and never uses these.
 */

export const INVOICE_STATUS = {
  DRAFT: { label: "Draft", badge: "gray", tone: "muted" },
  PENDING_APPROVAL: { label: "Pending approval", badge: "amber", tone: "pending" },
  QUOTE_OFFERED: { label: "Awaiting acceptance", badge: "gold", tone: "pending" },
  DECLINED: { label: "Declined", badge: "amber", tone: "muted" },
  SENT: { label: "Sent", badge: "navy", tone: "open" },
  VIEWED: { label: "Viewed", badge: "navy", tone: "open" },
  PARTIALLY_PAID: { label: "Partially Paid", badge: "gold", tone: "partial" },
  PAID: { label: "Paid", badge: "green", tone: "paid" },
  OVERDUE: { label: "Overdue", badge: "red", tone: "overdue" },
  VOIDED: { label: "Voided", badge: "gray", tone: "muted" },
} as const;
export type InvoiceStatusKey = keyof typeof INVOICE_STATUS;

/**
 * One status for an invoice. Overdue is computed from the due date (or an overdue installment)
 * and the remaining balance; Viewed comes from the client opening it in the portal.
 */
export function invoiceStatus(
  inv: { state: string; viewedAt: Date | string | null; dueDate: string; totalCents: number | null; appliedCents: number; overdueInstallment?: boolean },
  today: string,
): InvoiceStatusKey {
  switch (inv.state) {
    case "VOID":
      return "VOIDED";
    case "DRAFT":
      return "DRAFT";
    case "PENDING_APPROVAL":
      return "PENDING_APPROVAL";
    case "OFFERED":
      return "QUOTE_OFFERED";
    case "DECLINED":
      return "DECLINED";
  }
  const total = inv.totalCents ?? 0;
  const balance = total - inv.appliedCents;
  if (total > 0 && balance <= 0) return "PAID";
  if (balance > 0 && (inv.overdueInstallment || inv.dueDate < today)) return "OVERDUE";
  if (inv.appliedCents > 0) return "PARTIALLY_PAID";
  return inv.viewedAt ? "VIEWED" : "SENT";
}

/** Services on the Create Invoice screen. Tax Preparation is the default. */
export const FIRM_SERVICES = [
  "Tax Preparation",
  "Business Tax Preparation",
  "Amended Return",
  "Bookkeeping",
  "Payroll",
  "Nonprofit Services",
  "Business Formation",
  "IRS Notice / Correspondence",
  "Consulting",
  "Other",
] as const;
export const DEFAULT_SERVICE = "Tax Preparation";
/** Refund Transfer is for eligible tax returns only. */
export const TAX_RETURN_SERVICES: readonly string[] = ["Tax Preparation", "Business Tax Preparation", "Amended Return"];

/**
 * Payment options an invoice can offer, in display order. A method can be offered only after the
 * owner approves it (an active payment instruction in Billing settings). No method carries a
 * surcharge or card fee here.
 */
export const FIRM_METHODS = ["SQUARE_INVOICE", "ZELLE", "CASH_APP", "VENMO", "CASH", "REFUND_TRANSFER"] as const;
export type FirmMethod = (typeof FIRM_METHODS)[number];

export const FIRM_METHOD_INFO: Record<FirmMethod, { label: string; sub: string }> = {
  SQUARE_INVOICE: { label: "Square — secure card payment", sub: "Pay by card through Square's secure page. We never see or store your card number." },
  ZELLE: { label: "Zelle®", sub: "Send a payment with Zelle" },
  CASH_APP: { label: "Cash App®", sub: "Pay with Cash App" },
  VENMO: { label: "Venmo®", sub: "Pay with Venmo" },
  CASH: { label: "Cash", sub: "Office payments only" },
  REFUND_TRANSFER: { label: "Republic Bank Refund Transfer", sub: "Eligible tax returns only, subject to staff approval and bank-product requirements" },
};

/** The firm's own handles, as given by Tabitha. Saved payment instructions take their place. */
export const FIRM_METHOD_DEFAULTS: Partial<Record<FirmMethod, string>> = {
  ZELLE: "Send to: Tabitha Turner\nPhone: 205-420-1825",
  CASH_APP: "Send to: $TThompson25",
  VENMO: "Send to: @Tabitha-Thompson-7",
  CASH: "Cash is accepted in our office only. Please do not mail cash.",
};

export const REFUND_TRANSFER_TERMS = [
  "Available for eligible tax returns only, subject to staff approval and Republic Bank's bank-product requirements.",
  "Choosing a Refund Transfer does not guarantee payment. If your refund is reduced, delayed, intercepted or not enough, the remaining balance is still due by another approved payment method.",
  "Republic Bank's own disclosures, application and agreement apply and are provided before you authorize the service.",
];

/** Only https links to Square's own payment pages can be attached to an invoice. */
export function isSquarePaymentUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    if (u.protocol !== "https:" || u.username || u.password) return false;
    const h = u.hostname.toLowerCase();
    return ["square.link", "squareup.com", "squareupsandbox.com", "checkout.square.site"].some((d) => h === d || h.endsWith(`.${d}`));
  } catch {
    return false;
  }
}

/** Square invoice statuses a client can still pay. */
export const SQUARE_PAYABLE = ["UNPAID", "SCHEDULED", "PARTIALLY_PAID"];

/**
 * The Square page the client pays on. An invoice sent through Square uses the page Square created
 * for it (public_url) while it's payable there; once paid or canceled in Square there's no button.
 * Otherwise a link pasted by hand (the fallback) shows only after the owner turns manual Square
 * links on and Square is configured.
 */
export function squarePayUrl(inv: { squarePublicUrl?: string | null; squareStatus?: string | null; squarePaymentUrl?: string | null }, manualLinksLive: boolean): string | null {
  if (inv.squarePublicUrl) return SQUARE_PAYABLE.includes(inv.squareStatus ?? "") && isSquarePaymentUrl(inv.squarePublicUrl) ? inv.squarePublicUrl : null;
  return manualLinksLive && inv.squarePaymentUrl && isSquarePaymentUrl(inv.squarePaymentUrl) ? inv.squarePaymentUrl : null;
}

export type ClientPaymentOption = {
  method: FirmMethod;
  label: string;
  sub: string;
  details: string | null;
  // The Square payment page (see squarePayUrl) — null when there's nothing payable in Square.
  url: string | null;
  // Shown instead of a link while Square payments aren't enabled.
  notEnabled: boolean;
  terms: string[] | null;
  // Republic Bank fees exactly as the owner confirmed them; null = none confirmed (no amounts shown).
  feeNote: string | null;
};

/**
 * What the client sees under "Ways to pay": only the methods staff offered on this invoice that
 * the owner has approved, in a fixed order. No surcharges or card fees are ever added here.
 */
export function clientPaymentOptions(
  offered: string[],
  approved: { method: string; details: string }[],
  ctx: { squareUrl: string | null; refundFeeNote: string | null },
): ClientPaymentOption[] {
  return FIRM_METHODS.filter((m) => offered.includes(m) && approved.some((a) => a.method === m)).map((m) => {
    const info = FIRM_METHOD_INFO[m];
    const details = approved.find((a) => a.method === m)?.details || FIRM_METHOD_DEFAULTS[m] || null;
    if (m === "SQUARE_INVOICE") {
      const url = ctx.squareUrl && isSquarePaymentUrl(ctx.squareUrl) ? ctx.squareUrl : null;
      return { method: m, label: info.label, sub: url ? info.sub : "Card payment through Square isn't turned on for this invoice yet. Please use another option below or contact our office.", details: null, url, notEnabled: !url, terms: null, feeNote: null };
    }
    if (m === "REFUND_TRANSFER") return { method: m, label: info.label, sub: info.sub, details: null, url: null, notEnabled: false, terms: REFUND_TRANSFER_TERMS, feeNote: ctx.refundFeeNote?.trim() || null };
    return { method: m, label: info.label, sub: info.sub, details, url: null, notEnabled: false, terms: null, feeNote: null };
  });
}

/** Shows the record's ID compactly for staff ("…k2x9a1b3"). */
export const shortId = (id: string) => (id.length > 10 ? `…${id.slice(-8)}` : id);
