/**
 * Agreements & Contracts: the clause library, the templates and the option model.
 * Pure code (no database), shared by the server, the live preview and the tests.
 *
 * Wording rules:
 * - Clauses from Tabitha's Jotform "Client Service & Payment Agreement" are copied
 *   verbatim and seeded APPROVED. Only the client's name and amounts are placeholders.
 * - Every other clause is plain-English wording drafted for her and seeded DRAFT —
 *   "needs Tabitha's approval". A DRAFT clause can't be sent until she approves it.
 * - No fee, rate or legal term is invented: amounts, dates, notice days and the
 *   renewal increase all come from the options staff fill in. A blank one shows as
 *   [PLACEHOLDER] and blocks sending.
 */

export const FIRM_NAME = "T. Turner & Associates, LLC";

export type ClauseKind = "ACK" | "TERM";
export type ClauseSeed = { key: string; title: string; kind: ClauseKind; body: string; source: "JOTFORM" | "DRAFTED"; sortOrder: number };

/** Her Jotform clauses, verbatim (placeholders only where the form had the client's figures). */
const JOTFORM: ClauseSeed[] = [
  { key: "pp_invoice_total", title: "Invoice and total", kind: "ACK", source: "JOTFORM", sortOrder: 10, body: "I have received and reviewed Invoice #{{INVOICE_NUMBER}} and agree that the total amount due is {{TOTAL}}." },
  { key: "pp_payment_schedule", title: "Payment schedule", kind: "ACK", source: "JOTFORM", sortOrder: 20, body: "I agree to pay {{PAYMENT_SCHEDULE}}." },
  { key: "pp_early_delivery", title: "Early delivery courtesy", kind: "ACK", source: "JOTFORM", sortOrder: 30, body: "I understand that I am receiving all completed documents early, after my first payment, as a courtesy, and that I still owe the remaining {{BALANCE}}." },
  { key: "non_cancellable", title: "Non-cancellable after delivery", kind: "ACK", source: "JOTFORM", sortOrder: 40, body: "I understand this agreement cannot be cancelled or voided because the work has already been completed and delivered." },
  { key: "bundled_bookkeeping", title: "Bookkeeping required for the tax return", kind: "ACK", source: "JOTFORM", sortOrder: 50, body: "I understand my {{YEAR}} tax return cannot be prepared without complete {{YEAR}} bookkeeping. The {{PERIOD}} bookkeeping ({{MONTHLY}} per month) is required as part of my {{YEAR}} tax return, cannot be separated from it, is not included in the {{TOTAL}}, and begins when I notify the Firm." },
  { key: "late_payment", title: "Late payment and collections", kind: "ACK", source: "JOTFORM", sortOrder: 60, body: "I agree to the late payment terms, including collection costs and attorney's fees if collection becomes necessary." },
  { key: "payment_methods", title: "Payment methods", kind: "ACK", source: "JOTFORM", sortOrder: 70, body: "I understand payments may be made by {{PAYMENT_METHODS}}{{CARD_FEE_NOTE}}." },
  { key: "esign", title: "Electronic signature", kind: "ACK", source: "JOTFORM", sortOrder: 90, body: "I agree to sign electronically." },
];

/** Plain-English drafts for Tabitha to approve or rewrite. Never sent while DRAFT. */
const DRAFTED: ClauseSeed[] = [
  { key: "scope_services", title: "Services", kind: "TERM", source: "DRAFTED", sortOrder: 1, body: "The Firm will provide the following services: {{SERVICES}}.{{SERVICE_NOTES}}" },
  { key: "scope_bookkeeping", title: "Bookkeeping services", kind: "TERM", source: "DRAFTED", sortOrder: 2, body: "The Firm will keep the books for {{CLIENT_NAME}} {{BOOKKEEPING_FREQUENCY}} for {{PERIOD}}, using the bank, card and other records the client provides." },
  { key: "scope_tax_individual", title: "Individual tax return", kind: "TERM", source: "DRAFTED", sortOrder: 2, body: "The Firm will prepare the client's {{YEAR}} federal individual income tax return and any state return listed above, from the information the client provides." },
  { key: "scope_tax_business", title: "Business tax return", kind: "TERM", source: "DRAFTED", sortOrder: 2, body: "The Firm will prepare the {{YEAR}} business income tax return (Form 1065, 1120-S or 1120, as applies) for {{CLIENT_NAME}}, and any state return listed above, from the records the business provides." },
  { key: "scope_payroll", title: "Payroll services", kind: "TERM", source: "DRAFTED", sortOrder: 2, body: "The Firm will process payroll for {{CLIENT_NAME}} on the schedule agreed with the client, from the hours and pay information the client approves." },
  { key: "scope_engagement", title: "Engagement", kind: "TERM", source: "DRAFTED", sortOrder: 2, body: "This agreement starts the Firm's work with {{CLIENT_NAME}} for each service listed above. Each service is billed as shown in the fees section." },
  { key: "scope_nonprofit", title: "Nonprofit compliance", kind: "TERM", source: "DRAFTED", sortOrder: 2, body: "The Firm will help {{CLIENT_NAME}} with the nonprofit filings and compliance tasks listed above, from the records and approvals the organization provides." },
  { key: "scope_formation", title: "Business formation", kind: "TERM", source: "DRAFTED", sortOrder: 2, body: "The Firm will prepare and file the business formation documents listed above for {{CLIENT_NAME}}. Government filing fees are paid by the client unless the fees section says otherwise." },
  { key: "scope_consulting", title: "Consulting and advisory", kind: "TERM", source: "DRAFTED", sortOrder: 2, body: "The Firm will provide the consulting and advisory services listed above to {{CLIENT_NAME}}. Advice is based on the information the client provides." },
  { key: "fees", title: "Fees and billing", kind: "TERM", source: "DRAFTED", sortOrder: 5, body: "Fees: {{FEE_SUMMARY}}. Billing: {{BILLING_FREQUENCY}}." },
  { key: "term_start", title: "Start date and term", kind: "TERM", source: "DRAFTED", sortOrder: 6, body: "This agreement starts on {{START_DATE}} and {{TERM_TEXT}}." },
  { key: "auto_renewal", title: "Automatic renewal", kind: "TERM", source: "DRAFTED", sortOrder: 7, body: "Unless either party gives written notice before {{TERM_END}}, this agreement renews for another 12 months, and the fees increase by {{RENEWAL_INCREASE}}% at each renewal." },
  { key: "termination", title: "Ending the agreement", kind: "TERM", source: "DRAFTED", sortOrder: 8, body: "Either party may end this agreement by giving {{NOTICE_DAYS}} days' written notice. Fees for work done before the end date are still owed." },
  { key: "refund_transfer", title: "Paying from a tax refund", kind: "TERM", source: "DRAFTED", sortOrder: 75, body: "If the client chooses a refund transfer, the Firm's fees are paid from the tax refund through the refund-transfer provider. The provider's own application, terms and fees apply." },
  { key: "client_responsibilities", title: "Client responsibilities", kind: "TERM", source: "DRAFTED", sortOrder: 80, body: "The client agrees to give the Firm complete and accurate records and information on time, and to review the Firm's work before it is filed or relied on. The Firm relies on the information the client provides and does not audit it." },
  { key: "confidentiality", title: "Confidentiality", kind: "TERM", source: "DRAFTED", sortOrder: 85, body: "The Firm keeps the client's information confidential and uses it only to provide these services, except where the law requires otherwise or the client agrees in writing." },
];

export const CLAUSE_SEEDS: ClauseSeed[] = [...DRAFTED, ...JOTFORM];
export const JOTFORM_CLAUSE_KEYS = JOTFORM.map((c) => c.key);

// --- Options ----------------------------------------------------------------------

export const FEE_STRUCTURES = { FLAT: "Flat fee", MONTHLY: "Monthly fee", PER_RETURN: "Per return", HOURLY: "Hourly" } as const;
export const BILLING_FREQUENCIES = { ONE_TIME: "One time", MONTHLY: "Monthly", QUARTERLY: "Quarterly", ANNUALLY: "Annually", PER_RETURN: "When each return is completed" } as const;
export const TERMS = { ONE_TIME: "One-time engagement", MONTH_TO_MONTH: "Month-to-month", TWELVE_MONTHS: "12 months" } as const;
export const AGREEMENT_METHODS = {
  ZELLE: "Zelle",
  CASH_APP: "Cash App",
  APPLE_PAY: "Apple Pay",
  PAYMENT_LINK: "payment link",
  CARD: "credit or debit card",
  CHECK: "check",
  REFUND_TRANSFER: "refund transfer (tax services)",
} as const;
export type AgreementMethod = keyof typeof AGREEMENT_METHODS;

/** The existing service catalog (ServiceType), as the agreement names it. */
export const SERVICE_LABELS = {
  TAX_INDIVIDUAL: "Individual tax return",
  TAX_BUSINESS: "Business tax return (1065/1120-S/1120)",
  K1_PREPARATION: "K-1 preparation for owners",
  TAX_AMENDED: "Amended tax return",
  TAX_NONPROFIT: "Nonprofit tax return",
  BOOKKEEPING: "Bookkeeping",
  PAYROLL: "Payroll",
  NONPROFIT_SERVICES: "Nonprofit services",
  BUSINESS_FORMATION: "Business formation",
  CONSULTING: "Consulting",
  PROPERTY_MANAGEMENT: "Property management",
  IRS_CORRESPONDENCE: "IRS correspondence",
  OTHER: "Other service",
} as const;
export type ServiceKey = keyof typeof SERVICE_LABELS;
export const TAX_SERVICES: ServiceKey[] = ["TAX_INDIVIDUAL", "TAX_BUSINESS", "K1_PREPARATION", "TAX_AMENDED", "TAX_NONPROFIT", "IRS_CORRESPONDENCE"];

export type Toggles = {
  latePayment: boolean;
  nonCancellable: boolean;
  bundledService: boolean;
  clientResponsibilities: boolean;
  confidentiality: boolean;
  esign: boolean;
};

export type AgreementOptions = {
  services: ServiceKey[];
  serviceNotes: string;
  taxYear: number | null;
  periodLabel: string;
  feeStructure: keyof typeof FEE_STRUCTURES;
  fees: { label: string; cents: number }[];
  billingFrequency: keyof typeof BILLING_FREQUENCIES;
  invoiceNumber: string;
  depositCents: number;
  installments: { cents: number; date: string }[];
  startDate: string;
  term: keyof typeof TERMS;
  autoRenew: boolean;
  renewalIncreasePct: number;
  terminationNoticeDays: number | null;
  paymentMethods: AgreementMethod[];
  toggles: Toggles;
  // Bundled-service clause: the monthly bookkeeping fee and its period.
  bundledMonthlyCents: number | null;
  bundledPeriod: string;
  // Questions the client answers when signing (Payment Plan style).
  askServiceSelection: boolean;
  serviceQuestion: string;
  askPaymentMethod: boolean;
  // Custom template: the clauses picked by hand.
  customClauseKeys: string[];
};

export type TemplateSeed = { key: string; name: string; description: string; title: string; intro: string; clauseKeys: string[]; defaults: Partial<AgreementOptions>; sortOrder: number };

const allToggles = (over: Partial<Toggles> = {}): Toggles => ({ latePayment: true, nonCancellable: false, bundledService: false, clientResponsibilities: true, confidentiality: true, esign: true, ...over });
const INTRO = "This agreement is between {{FIRM}} (the \"Firm\") and {{CLIENT_NAME}} (the \"client\").";

export const TEMPLATE_SEEDS: TemplateSeed[] = [
  { key: "BOOKKEEPING", sortOrder: 1, name: "Bookkeeping Services Agreement (monthly)", description: "Monthly bookkeeping, billed each month, with renewal and notice terms.", title: "Bookkeeping Services Agreement", intro: INTRO, clauseKeys: ["scope_bookkeeping", "fees", "term_start"], defaults: { services: ["BOOKKEEPING"], feeStructure: "MONTHLY", billingFrequency: "MONTHLY", term: "TWELVE_MONTHS", autoRenew: true, paymentMethods: ["ZELLE", "CASH_APP", "APPLE_PAY", "PAYMENT_LINK"], toggles: allToggles() } },
  { key: "TAX_INDIVIDUAL", sortOrder: 2, name: "Tax Preparation — Individual", description: "One individual return for one tax year, priced per return.", title: "Tax Preparation Agreement — Individual", intro: INTRO, clauseKeys: ["scope_tax_individual", "fees"], defaults: { services: ["TAX_INDIVIDUAL"], feeStructure: "PER_RETURN", billingFrequency: "PER_RETURN", term: "ONE_TIME", paymentMethods: ["ZELLE", "CASH_APP", "APPLE_PAY", "PAYMENT_LINK", "REFUND_TRANSFER"], toggles: allToggles() } },
  { key: "TAX_BUSINESS", sortOrder: 3, name: "Tax Preparation — Business (1065/1120-S/1120)", description: "A business return for one tax year, priced per return.", title: "Tax Preparation Agreement — Business", intro: INTRO, clauseKeys: ["scope_tax_business", "fees"], defaults: { services: ["TAX_BUSINESS"], feeStructure: "PER_RETURN", billingFrequency: "PER_RETURN", term: "ONE_TIME", paymentMethods: ["ZELLE", "CASH_APP", "APPLE_PAY", "PAYMENT_LINK"], toggles: allToggles() } },
  { key: "PAYROLL", sortOrder: 4, name: "Payroll Services", description: "Payroll processing, billed monthly.", title: "Payroll Services Agreement", intro: INTRO, clauseKeys: ["scope_payroll", "fees", "term_start"], defaults: { services: ["PAYROLL"], feeStructure: "MONTHLY", billingFrequency: "MONTHLY", term: "MONTH_TO_MONTH", paymentMethods: ["ZELLE", "CASH_APP", "APPLE_PAY", "PAYMENT_LINK"], toggles: allToggles() } },
  { key: "NEW_CLIENT", sortOrder: 5, name: "New Client Engagement (several services)", description: "One agreement for a new client's services — tax, bookkeeping, payroll and more.", title: "New Client Engagement Agreement", intro: INTRO, clauseKeys: ["scope_engagement", "scope_services", "fees", "term_start"], defaults: { services: [], feeStructure: "FLAT", billingFrequency: "ONE_TIME", term: "ONE_TIME", paymentMethods: ["ZELLE", "CASH_APP", "APPLE_PAY", "PAYMENT_LINK"], toggles: allToggles() } },
  { key: "NONPROFIT", sortOrder: 6, name: "Nonprofit Compliance", description: "Nonprofit filings and compliance work for an organization.", title: "Nonprofit Compliance Agreement", intro: INTRO, clauseKeys: ["scope_nonprofit", "scope_services", "fees", "term_start"], defaults: { services: ["NONPROFIT_SERVICES"], feeStructure: "FLAT", billingFrequency: "ONE_TIME", term: "ONE_TIME", paymentMethods: ["ZELLE", "CASH_APP", "APPLE_PAY", "PAYMENT_LINK"], toggles: allToggles() } },
  { key: "FORMATION", sortOrder: 7, name: "Business Formation", description: "Forming a new business entity, one flat fee.", title: "Business Formation Agreement", intro: INTRO, clauseKeys: ["scope_formation", "fees"], defaults: { services: ["BUSINESS_FORMATION"], feeStructure: "FLAT", billingFrequency: "ONE_TIME", term: "ONE_TIME", paymentMethods: ["ZELLE", "CASH_APP", "APPLE_PAY", "PAYMENT_LINK"], toggles: allToggles() } },
  { key: "CONSULTING", sortOrder: 8, name: "Consulting / Advisory", description: "Advisory work, usually hourly.", title: "Consulting & Advisory Agreement", intro: INTRO, clauseKeys: ["scope_consulting", "fees", "term_start"], defaults: { services: ["CONSULTING"], feeStructure: "HOURLY", billingFrequency: "MONTHLY", term: "MONTH_TO_MONTH", paymentMethods: ["ZELLE", "CASH_APP", "APPLE_PAY", "PAYMENT_LINK"], toggles: allToggles() } },
  {
    key: "PAYMENT_PLAN",
    sortOrder: 9,
    name: "Payment Plan Agreement",
    description: "Tabitha's Client Service & Payment Agreement: invoice total, deposit and installments, numbered acknowledgments.",
    title: "Client Service & Payment Agreement",
    intro: INTRO,
    clauseKeys: ["pp_invoice_total", "pp_payment_schedule", "pp_early_delivery"],
    defaults: { services: ["TAX_INDIVIDUAL"], feeStructure: "FLAT", billingFrequency: "ONE_TIME", term: "ONE_TIME", paymentMethods: ["ZELLE", "CASH_APP", "APPLE_PAY", "PAYMENT_LINK"], toggles: allToggles({ nonCancellable: true, bundledService: true, clientResponsibilities: false, confidentiality: false }), askServiceSelection: true, askPaymentMethod: true },
  },
  { key: "CUSTOM", sortOrder: 10, name: "Custom (blank, pick clauses)", description: "Start blank and pick the clauses you want.", title: "Service Agreement", intro: INTRO, clauseKeys: [], defaults: { services: [], feeStructure: "FLAT", billingFrequency: "ONE_TIME", term: "ONE_TIME", paymentMethods: [], toggles: allToggles({ latePayment: false, clientResponsibilities: false, confidentiality: false }) } },
];

export function defaultOptions(over: Partial<AgreementOptions> = {}): AgreementOptions {
  return {
    services: [],
    serviceNotes: "",
    taxYear: null,
    periodLabel: "",
    feeStructure: "FLAT",
    fees: [],
    billingFrequency: "ONE_TIME",
    invoiceNumber: "",
    depositCents: 0,
    installments: [],
    startDate: "",
    term: "ONE_TIME",
    autoRenew: false,
    renewalIncreasePct: 3,
    terminationNoticeDays: null,
    paymentMethods: [],
    toggles: allToggles(),
    bundledMonthlyCents: null,
    bundledPeriod: "",
    askServiceSelection: false,
    serviceQuestion: "",
    askPaymentMethod: false,
    customClauseKeys: [],
    ...over,
  };
}

// --- Rendering ----------------------------------------------------------------------

export const money = (cents: number) => `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
export const longDate = (ymd: string) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(ymd)) return "";
  const [y, m, d] = ymd.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-US", { timeZone: "UTC", month: "long", day: "numeric", year: "numeric" });
};
const list = (xs: string[], word = "and") => (xs.length <= 1 ? xs.join("") : xs.length === 2 ? `${xs[0]} ${word} ${xs[1]}` : `${xs.slice(0, -1).join(", ")}, ${word} ${xs[xs.length - 1]}`);

export const feesTotal = (o: AgreementOptions) => o.fees.reduce((a, f) => a + f.cents, 0);

/** End of the term, for a dated term (12 months from the start). */
export function termEnd(o: Pick<AgreementOptions, "startDate" | "term">): string | null {
  if (o.term !== "TWELVE_MONTHS" || !/^\d{4}-\d{2}-\d{2}$/.test(o.startDate)) return null;
  const [y, m, d] = o.startDate.split("-").map(Number);
  const end = new Date(Date.UTC(y + 1, m - 1, d));
  end.setUTCDate(end.getUTCDate() - 1);
  return end.toISOString().slice(0, 10);
}

/** Which clauses this agreement uses, in order: the template's own, then the ones the options turn on. */
export function clauseKeysFor(templateKeys: string[], o: AgreementOptions, templateKey?: string): string[] {
  if (templateKey === "CUSTOM") return [...new Set(o.customClauseKeys)];
  const keys = [...templateKeys];
  if (templateKey !== "PAYMENT_PLAN") {
    if (o.term === "TWELVE_MONTHS" && o.autoRenew) keys.push("auto_renewal");
    if (o.terminationNoticeDays !== null || o.term !== "ONE_TIME") keys.push("termination");
  }
  if (o.toggles.nonCancellable) keys.push("non_cancellable");
  if (o.toggles.bundledService) keys.push("bundled_bookkeeping");
  if (o.toggles.latePayment) keys.push("late_payment");
  if (o.paymentMethods.length) keys.push("payment_methods");
  if (o.paymentMethods.includes("REFUND_TRANSFER")) keys.push("refund_transfer");
  if (o.toggles.clientResponsibilities) keys.push("client_responsibilities");
  if (o.toggles.confidentiality) keys.push("confidentiality");
  if (o.toggles.esign) keys.push("esign");
  return [...new Set(keys)];
}

/** The values placeholders are filled from. A missing value stays out (shown as [NAME]). */
export function placeholderValues(o: AgreementOptions, ctx: { clientName: string }): Record<string, string> {
  const v: Record<string, string> = { FIRM: FIRM_NAME, CLIENT_NAME: ctx.clientName };
  const total = feesTotal(o);
  if (o.fees.length && total > 0) v.TOTAL = money(total);
  if (o.invoiceNumber.trim()) v.INVOICE_NUMBER = o.invoiceNumber.trim();
  if (o.services.length) v.SERVICES = list(o.services.map((s) => SERVICE_LABELS[s]));
  v.SERVICE_NOTES = o.serviceNotes.trim() ? ` ${o.serviceNotes.trim()}` : "";
  if (o.taxYear) v.YEAR = String(o.taxYear);
  const monthYear = (ymd: string) => longDate(ymd).replace(/ \d+,/, "");
  const end0 = termEnd(o);
  const period = o.bundledPeriod.trim() || o.periodLabel.trim() || (end0 ? `${monthYear(o.startDate)} through ${monthYear(end0)}` : o.term === "MONTH_TO_MONTH" && longDate(o.startDate) ? `each month starting ${monthYear(o.startDate)}` : "");
  if (period) v.PERIOD = period;
  v.BOOKKEEPING_FREQUENCY = o.billingFrequency === "QUARTERLY" ? "each quarter" : "each month";
  if (o.bundledMonthlyCents) v.MONTHLY = money(o.bundledMonthlyCents);
  // Fees.
  if (o.fees.length && o.fees.every((f) => f.label.trim() && f.cents > 0)) {
    const unit = o.feeStructure === "MONTHLY" ? " per month" : o.feeStructure === "PER_RETURN" ? " per return" : o.feeStructure === "HOURLY" ? " per hour" : "";
    v.FEE_SUMMARY = o.fees.map((f) => `${f.label.trim()} ${money(f.cents)}${unit}`).join("; ");
  }
  v.BILLING_FREQUENCY = BILLING_FREQUENCIES[o.billingFrequency].toLowerCase();
  // Payment schedule: "$X upon signing, $Y by DATE, and $Z by DATE".
  const parts: string[] = [];
  if (o.depositCents > 0) parts.push(`${money(o.depositCents)} upon signing`);
  let scheduleOk = o.installments.every((i) => i.cents > 0 && longDate(i.date));
  for (const i of o.installments) parts.push(`${money(i.cents)} by ${longDate(i.date) || "[DATE]"}`);
  if (!parts.length) scheduleOk = false;
  if (scheduleOk) v.PAYMENT_SCHEDULE = list(parts);
  const scheduled = o.depositCents + o.installments.reduce((a, i) => a + i.cents, 0);
  if (o.depositCents > 0 && scheduled > o.depositCents) v.BALANCE = money(scheduled - o.depositCents);
  // Dates and term.
  if (longDate(o.startDate)) v.START_DATE = longDate(o.startDate);
  const end = termEnd(o);
  if (end) v.TERM_END = longDate(end);
  if (o.term === "ONE_TIME") v.TERM_TEXT = "ends when the services above are completed";
  else if (o.term === "MONTH_TO_MONTH") v.TERM_TEXT = "continues month to month until either party ends it";
  else if (end) v.TERM_TEXT = `runs for 12 months, through ${longDate(end)}`;
  v.RENEWAL_INCREASE = String(o.renewalIncreasePct);
  if (o.terminationNoticeDays !== null && o.terminationNoticeDays > 0) v.NOTICE_DAYS = String(o.terminationNoticeDays);
  // Payment methods, her wording: "Zelle, Cash App, Apple Pay, or payment link".
  if (o.paymentMethods.length) v.PAYMENT_METHODS = list(o.paymentMethods.map((m) => AGREEMENT_METHODS[m]), "or");
  v.CARD_FEE_NOTE = o.paymentMethods.includes("PAYMENT_LINK") ? ", and that a credit card processing fee will be added if I pay by payment link" : "";
  return v;
}

export function fill(body: string, values: Record<string, string>) {
  const missing: string[] = [];
  const text = body.replace(/\{\{([A-Z_]+)\}\}/g, (_, k: string) => {
    if (k in values) return values[k];
    missing.push(k);
    return `[${k.replace(/_/g, " ")}]`;
  });
  return { text, missing };
}

export type RenderedClause = { key: string; title: string; kind: ClauseKind; version: number; status: "DRAFT" | "APPROVED"; text: string; missing: string[] };
export type LibraryClause = { key: string; title: string; kind: ClauseKind; version: number; status: "DRAFT" | "APPROVED"; body: string };
export type Rendered = { title: string; intro: string; clauses: RenderedClause[]; questions: { key: string; text: string; choices: string[] }[]; missing: string[]; drafts: string[]; text: string };

/** The full agreement text from the library, the template and the options. */
export function renderAgreement(input: { title: string; intro: string; templateKey: string; templateClauseKeys: string[]; options: AgreementOptions; clientName: string; library: LibraryClause[] }): Rendered {
  const values = placeholderValues(input.options, { clientName: input.clientName });
  const byKey = new Map(input.library.map((c) => [c.key, c]));
  const keys = clauseKeysFor(input.templateClauseKeys, input.options, input.templateKey);
  const intro = fill(input.intro, values);
  const clauses: RenderedClause[] = keys.flatMap((k) => {
    const c = byKey.get(k);
    if (!c) return [];
    const f = fill(c.body, values);
    return [{ key: c.key, title: c.title, kind: c.kind, version: c.version, status: c.status, text: f.text, missing: f.missing }];
  });
  const o = input.options;
  const questions: Rendered["questions"] = [];
  if (o.askServiceSelection) {
    const what = o.serviceQuestion.trim() || (values.PERIOD ? `the ${values.PERIOD} bookkeeping` : "the services above");
    questions.push({ key: "serviceSelection", text: `Do you want to begin ${what} now?`, choices: ["Yes, begin now", "Not yet — I will notify the Firm"] });
  }
  if (o.askPaymentMethod && o.paymentMethods.length) questions.push({ key: "paymentMethod", text: "How do you plan to make your payments?", choices: o.paymentMethods.map((m) => AGREEMENT_METHODS[m].replace(/^./, (x) => x.toUpperCase())) });
  const missing = [...new Set([...intro.missing, ...clauses.flatMap((c) => c.missing)])];
  const drafts = clauses.filter((c) => c.status !== "APPROVED").map((c) => c.title);
  let n = 0;
  const text = [
    input.title,
    intro.text,
    ...clauses.map((c) => `${++n}. ${c.kind === "ACK" ? "[ ] " : ""}${c.title}: ${c.text}`),
    ...questions.map((q) => `${q.text} (${q.choices.join(" / ")})`),
  ].join("\n\n");
  return { title: input.title, intro: intro.text, clauses, questions, missing, drafts, text };
}

/** Plain-English status labels (the list's "Renewal due" and "Expired" are worked out from dates). */
export const STATUS_LABELS = {
  DRAFT: "Draft",
  WAITING_FOR_OWNER: "Waiting for Tabitha",
  SENT: "Sent",
  SIGNED: "Signed",
  DECLINED: "Declined",
  EXPIRED: "Expired",
  VOID: "Void",
  RENEWAL_DUE: "Renewal due",
} as const;
export type DisplayStatus = keyof typeof STATUS_LABELS;

export function displayStatus(a: { status: keyof typeof STATUS_LABELS; termEndDate: Date | null; signBy: Date | null; renewals?: { id: string }[] }, today: string): DisplayStatus {
  if (a.status === "SENT" && a.signBy && a.signBy.toISOString() < new Date().toISOString()) return "EXPIRED";
  if (a.status === "SIGNED" && a.termEndDate && !(a.renewals ?? []).length) {
    const end = a.termEndDate.toISOString().slice(0, 10);
    const t = new Date(`${today}T00:00:00Z`);
    t.setUTCDate(t.getUTCDate() + 30);
    if (end < today) return "EXPIRED";
    if (end <= t.toISOString().slice(0, 10)) return "RENEWAL_DUE";
  }
  return a.status;
}
