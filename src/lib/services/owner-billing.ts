import "server-only";
import type { AmountType, Invoice, InvoiceLine, Installment, Payment, PaymentMethod, PaymentOption, Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import type { Actor } from "@/lib/auth/actor";
import { assertOffice, ownerAudit } from "@/lib/auth/owner";
import { assertCanApplyCredits, assertCanRecordPayments, assertCanRefund, assertCanSendInvoices, assertCanVoid } from "@/lib/auth/billing-permissions";
import type { PortalActor } from "@/lib/portal/session";
import { requireClientAccess } from "@/lib/portal/access";
import {
  AGING_BUCKETS,
  agingBucket,
  cashCollectedCents,
  collectedCents,
  creditedCents,
  computeBreakdown,
  PricingError,
  scheduleStatus,
  validatePricing,
  type Breakdown,
  type Option,
  type PricingInput,
  type ScheduleItem,
} from "@/lib/billing/pricing";
import { termsSnapshot } from "@/lib/billing/terms";
import { invoiceStatus, type InvoiceStatusKey } from "@/lib/billing/invoice-status";
import { ValidationError } from "./clients";
import { queuePortalNotification } from "./notifications";

/**
 * Owner's Office billing: quotes, invoices, payment plans and payments.
 * Every staff-side function checks owner access against the database. Payments are recorded by
 * hand here, or automatically from Square for invoices sent through Square
 * (square-invoicing.ts) — nothing here charges a card or bank account.
 *
 * Who may do what: Staff Access & Permissions (lib/permissions.ts), through
 * lib/auth/billing-permissions.ts — Billing → Create/Edit for drafts, Send to approve and send,
 * Record payments, Refund, Credits & waivers and Void each separately. The owner holds them all.
 */

export const ymd = (d: Date) => d.toISOString().slice(0, 10);
const dateOnly = (s: string) => new Date(`${s}T00:00:00.000Z`);
export const todayYmd = () => new Date().toLocaleDateString("en-CA", { timeZone: "America/Chicago" });

export async function billingSettings() {
  const found = await prisma.billingSettings.findUnique({ where: { id: "default" } });
  if (found) return found;
  // Two first requests can race to create the row; the loser just reads it.
  return prisma.billingSettings.create({ data: { id: "default" } }).catch(() => prisma.billingSettings.findUniqueOrThrow({ where: { id: "default" } }));
}

export type SettingsInput = {
  planFeeType: AmountType;
  planFeeValue: number;
  maxInstallments: number;
  defaultInstallments: number;
  defaultDiscountType: AmountType;
  defaultDiscountValue: number;
  defaultTaxRateBps: number;
  defaultDepositType: AmountType;
  defaultDepositValue: number;
  defaultPaymentTerms: string | null;
  planFeeRulesConfirmed: boolean;
};

/** Fee and default settings: primary owner (full access) only. */
export async function updateBillingSettings(actor: Actor, input: SettingsInput) {
  await assertOffice(actor, "billing", "settings");
  // The payment-plan fee was removed by the owner's decision: plans never add a fee.
  if (input.planFeeType !== "NONE") throw new ValidationError("Payment plans don't carry a fee.");
  if (input.maxInstallments < 2 || input.maxInstallments > 24) throw new ValidationError("Allow between 2 and 24 installments.");
  if (input.defaultInstallments < 2 || input.defaultInstallments > input.maxInstallments) throw new ValidationError("The default number of installments must be within your limit.");
  const before = await billingSettings();
  const data = {
    planFeeType: input.planFeeType,
    planFeeValue: input.planFeeType === "NONE" ? 0 : input.planFeeValue,
    maxInstallments: input.maxInstallments,
    defaultInstallments: input.defaultInstallments,
    defaultDiscountType: input.defaultDiscountType,
    defaultDiscountValue: input.defaultDiscountType === "NONE" ? 0 : input.defaultDiscountValue,
    defaultTaxRateBps: input.defaultTaxRateBps,
    defaultDepositType: input.defaultDepositType,
    defaultDepositValue: input.defaultDepositType === "NONE" ? 0 : input.defaultDepositValue,
    defaultPaymentTerms: input.defaultPaymentTerms?.trim() || null,
    planFeeRulesConfirmedAt: input.planFeeType === "NONE" ? before.planFeeRulesConfirmedAt : before.planFeeRulesConfirmedAt ?? new Date(),
    updatedById: actor.id,
  };
  await prisma.billingSettings.update({ where: { id: "default" }, data });
  await ownerAudit(actor.id, "billing.settings_updated", "BillingSettings", "default");
}

type FullInvoice = Invoice & { lines: InvoiceLine[]; installments: Installment[]; payments: Payment[] };

export function pricingInputOf(inv: Invoice & { lines: InvoiceLine[] }): PricingInput {
  return {
    lines: [...inv.lines].sort((a, b) => a.sortOrder - b.sortOrder).map((l) => ({ service: l.service, description: l.description, quantity: l.quantity, unitCents: l.unitCents })),
    discountType: inv.discountType,
    discountValue: inv.discountValue,
    discountCoversPlanFee: inv.discountCoversPlanFee,
    taxRateBps: inv.taxRateBps,
    planFeeType: inv.planFeeType,
    planFeeValue: inv.planFeeValue,
    depositType: inv.depositType,
    depositValue: inv.depositValue,
    allowFull: inv.allowFull,
    allowPlan: inv.allowPlan,
    issueDate: ymd(inv.issueDate),
    dueDate: ymd(inv.dueDate),
    planInstallments: inv.planInstallments,
    planFirstDueDate: inv.planFirstDueDate ? ymd(inv.planFirstDueDate) : null,
    planIntervalMonths: inv.planIntervalMonths,
  };
}

export function breakdownOf(inv: Invoice & { lines: InvoiceLine[] }): Breakdown {
  return computeBreakdown(pricingInputOf(inv));
}

export type QuoteInput = {
  clientId: string;
  title: string;
  issueDate: string;
  dueDate: string;
  memo?: string | null;
  paymentTerms?: string | null;
  privateNote?: string | null;
  lines: { service: string; description?: string | null; quantity: number; unitCents: number }[];
  allowFull: boolean;
  allowPlan: boolean;
  depositType: AmountType;
  depositValue: number;
  discountType: AmountType;
  discountValue: number;
  discountCoversPlanFee: boolean;
  taxRateBps: number;
  planInstallments: number;
  planFirstDueDate?: string | null;
  planIntervalMonths: number;
  // Per-quote fee override — primary owner with full access only.
  planFeeOverride?: { type: AmountType; value: number } | null;
};

/**
 * Payment-plan fee: removed by the owner's decision (Nov 2026). Choosing a payment
 * plan never adds a fee. Quotes already accepted keep the terms they were accepted with.
 */
async function planFeeFor(_actor: Actor, override: QuoteInput["planFeeOverride"]) {
  if (override) throw new ValidationError("Payment plans don't carry a fee.");
  const s = await billingSettings();
  return { type: "NONE" as AmountType, value: 0, maxInstallments: s.maxInstallments, confirmed: s.planFeeRulesConfirmedAt };
}

function checkPricing(input: PricingInput, maxInstallments: number) {
  try {
    validatePricing(input, { maxInstallments });
  } catch (e) {
    if (e instanceof PricingError) throw new ValidationError(e.message);
    throw e;
  }
}

/**
 * Next invoice number for the year. A transaction-scoped lock serializes concurrent creates,
 * the highest existing number (not a count) is the base, and Invoice.number is unique in the
 * database, so a number can never be issued twice.
 */
export async function nextNumber(tx: Prisma.TransactionClient, year: number) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('invoice-number'))`;
  const rows = await tx.$queryRaw<{ n: number | null }[]>`
    SELECT MAX(CAST(SUBSTRING("number" FROM ${`^INV-${year}-([0-9]+)$`}) AS INTEGER)) AS n FROM "Invoice" WHERE "number" LIKE ${`INV-${year}-%`}`;
  return `INV-${year}-${String(Number(rows[0]?.n ?? 0) + 1).padStart(4, "0")}`;
}

/** The number the next invoice dated in this year would get (shown on the Create Invoice screen). */
export async function previewNextNumber(year: number) {
  return prisma.$transaction((tx) => nextNumber(tx, year));
}

/** Runs an invoice create, retrying if another create won the same number (unique constraint). */
export async function withNumberRetry<T>(fn: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (e) {
      const code = (e as { code?: string }).code;
      if (code !== "P2002" || attempt >= 4) throw e;
    }
  }
}

function invoiceData(input: QuoteInput, fee: { type: AmountType; value: number }) {
  return {
    title: input.title.trim().slice(0, 200),
    issueDate: dateOnly(input.issueDate),
    dueDate: dateOnly(input.dueDate),
    memo: input.memo?.trim() || null,
    paymentTerms: input.paymentTerms?.trim() || null,
    privateNote: input.privateNote?.trim() || null,
    allowFull: input.allowFull,
    allowPlan: input.allowPlan,
    depositType: input.depositType,
    depositValue: input.depositType === "NONE" ? 0 : input.depositValue,
    discountType: input.discountType,
    discountValue: input.discountType === "NONE" ? 0 : input.discountValue,
    discountCoversPlanFee: input.discountType !== "NONE" && input.discountCoversPlanFee,
    taxRateBps: input.taxRateBps,
    planFeeType: input.allowPlan ? fee.type : ("NONE" as AmountType),
    planFeeValue: input.allowPlan ? fee.value : 0,
    planInstallments: input.planInstallments,
    planFirstDueDate: input.allowPlan && input.planFirstDueDate ? dateOnly(input.planFirstDueDate) : null,
    planIntervalMonths: input.planIntervalMonths,
  };
}

function asPricing(input: QuoteInput, fee: { type: AmountType; value: number }): PricingInput {
  return {
    lines: input.lines,
    discountType: input.discountType,
    discountValue: input.discountValue,
    discountCoversPlanFee: input.discountCoversPlanFee,
    taxRateBps: input.taxRateBps,
    planFeeType: input.allowPlan ? fee.type : "NONE",
    planFeeValue: input.allowPlan ? fee.value : 0,
    depositType: input.depositType,
    depositValue: input.depositValue,
    allowFull: input.allowFull,
    allowPlan: input.allowPlan,
    issueDate: input.issueDate,
    dueDate: input.dueDate,
    planInstallments: input.planInstallments,
    planFirstDueDate: input.planFirstDueDate ?? null,
    planIntervalMonths: input.planIntervalMonths,
  };
}

export async function createQuote(actor: Actor, input: QuoteInput) {
  await assertOffice(actor, "billing", "create");
  if (!input.title.trim()) throw new ValidationError("Give the quote a title (e.g. 2026 tax preparation).");
  if (!(await prisma.client.count({ where: { id: input.clientId, archivedAt: null } }))) throw new ValidationError("Choose a client.");
  const fee = await planFeeFor(actor, input.planFeeOverride);
  if (input.allowPlan && fee.type !== "NONE" && !fee.confirmed) throw new ValidationError("Confirm the payment-plan fee rules in Billing settings before offering plans.");
  checkPricing(asPricing(input, fee), fee.maxInstallments);
  const contact = await billingContactOf(input.clientId);
  const inv = await withNumberRetry(() =>
    prisma.$transaction(async (tx) => {
      const number = await nextNumber(tx, Number(input.issueDate.slice(0, 4)));
      return tx.invoice.create({
        data: {
          number,
          clientId: input.clientId,
          createdById: actor.id,
          ...contact,
          ...invoiceData(input, fee),
          lines: { create: input.lines.map((l, i) => ({ service: l.service.trim().slice(0, 200), description: l.description?.trim() || null, quantity: l.quantity, unitCents: l.unitCents, sortOrder: i })) },
        },
      });
    }),
  );
  await ownerAudit(actor.id, "billing.quote_created", "Invoice", inv.id);
  return inv;
}

/** Drafts only — once offered or issued, the terms are fixed. */
export async function updateDraft(actor: Actor, invoiceId: string, input: QuoteInput) {
  await assertOffice(actor, "billing", "edit");
  const inv = await prisma.invoice.findUnique({ where: { id: invoiceId } });
  if (!inv) throw new ValidationError("Not found.");
  if (inv.state !== "DRAFT") throw new ValidationError("Only drafts can be edited. Withdraw the quote first.");
  const fee = await planFeeFor(actor, input.planFeeOverride);
  checkPricing(asPricing(input, fee), fee.maxInstallments);
  await prisma.$transaction(async (tx) => {
    const res = await tx.invoice.updateMany({ where: { id: invoiceId, state: "DRAFT" }, data: { ...invoiceData(input, fee), clientId: input.clientId } });
    if (res.count !== 1) throw new ValidationError("Only drafts can be edited.");
    await tx.invoiceLine.deleteMany({ where: { invoiceId } });
    await tx.invoiceLine.createMany({ data: input.lines.map((l, i) => ({ invoiceId, service: l.service.trim().slice(0, 200), description: l.description?.trim() || null, quantity: l.quantity, unitCents: l.unitCents, sortOrder: i })) });
  });
  await ownerAudit(actor.id, "billing.quote_updated", "Invoice", invoiceId);
}

/**
 * The client's name and billing contact, copied from the master client record so staff never
 * re-type them: the business name (or display name), the record's email/phone, or the first
 * contact's when the record has none, and the mailing address.
 */
export async function billingContactOf(clientId: string) {
  const c = await prisma.client.findUnique({ where: { id: clientId }, include: { contacts: { orderBy: { createdAt: "asc" } } } });
  if (!c) throw new ValidationError("Choose a client.");
  const contact = c.contacts.find((x) => x.email || x.phone);
  const cityLine = [c.city, [c.state, c.postalCode].filter(Boolean).join(" ")].filter(Boolean).join(", ");
  const address = [c.addressLine1, c.addressLine2, cityLine].filter(Boolean).join("\n");
  return {
    billingName: c.businessName || c.displayName,
    billingEmail: c.email || contact?.email || null,
    billingPhone: c.phone || contact?.phone || null,
    billingAddress: address || null,
  };
}

async function loadFull(id: string): Promise<FullInvoice & { client: { id: string; displayName: string } }> {
  const inv = await prisma.invoice.findUnique({ where: { id }, include: { lines: true, installments: { orderBy: { seq: "asc" } }, payments: { orderBy: { createdAt: "asc" } }, client: { select: { id: true, displayName: true } } } });
  if (!inv) throw new ValidationError("Not found.");
  return inv;
}

/**
 * Portal notices. `emailedTo`: an address that already got our invoice email with the Square
 * link — that portal user gets only the text notice (if they take texts), not a second email.
 */
export async function notifyBilling(clientId: string, kind: "QUOTE_READY" | "NEW_INVOICE", invoiceId: string, emailedTo?: string | null) {
  const grants = await prisma.portalAccess.findMany({ where: { clientId, revokedAt: null, canViewBilling: true }, include: { portalUser: { select: { email: true } } } });
  for (const g of grants) {
    const already = !!emailedTo && g.portalUser.email.trim().toLowerCase() === emailedTo.trim().toLowerCase();
    await queuePortalNotification(g.portalUserId, kind, `${kind}:${invoiceId}`, already ? ["SMS"] : undefined);
  }
}

/** Publishes a quote to the client's portal for acceptance. */
export async function offerQuote(actor: Actor, invoiceId: string) {
  await assertOffice(actor, "billing", "send");
  const inv = await loadFull(invoiceId);
  if (inv.state !== "DRAFT" && inv.state !== "PENDING_APPROVAL") throw new ValidationError("This quote was already sent.");
  const s = await billingSettings();
  checkPricing(pricingInputOf(inv), s.maxInstallments);
  const now = new Date();
  const res = await prisma.invoice.updateMany({ where: { id: invoiceId, state: { in: ["DRAFT", "PENDING_APPROVAL"] } }, data: { state: "OFFERED", publishedAt: now, approvedAt: now, approvedById: actor.id } });
  if (res.count !== 1) throw new ValidationError("This quote was already sent.");
  await ownerAudit(actor.id, "billing.quote_offered", "Invoice", invoiceId);
  await notifyBilling(inv.clientId, "QUOTE_READY", invoiceId);
}

/** Takes an offered quote back to draft (only before the client accepts). */
export async function withdrawQuote(actor: Actor, invoiceId: string) {
  await assertOffice(actor, "billing", "send");
  const res = await prisma.invoice.updateMany({ where: { id: invoiceId, state: "OFFERED" }, data: { state: "DRAFT", publishedAt: null } });
  if (res.count !== 1) throw new ValidationError("Only an offered quote that hasn't been accepted can be withdrawn.");
  await ownerAudit(actor.id, "billing.quote_withdrawn", "Invoice", invoiceId);
}

async function freeze(tx: Prisma.TransactionClient, inv: FullInvoice & { client: { displayName: string } }, option: Option, extra: { acceptedAt?: Date; acceptedByPortalId?: string; acceptedFromIp?: string | null }) {
  const breakdown = breakdownOf(inv);
  const { terms, hash } = termsSnapshot({ invoiceNumber: inv.number, title: inv.title, clientName: inv.client.displayName, breakdown, option, paymentTerms: inv.paymentTerms, memo: inv.memo });
  await tx.installment.deleteMany({ where: { invoiceId: inv.id } });
  await tx.installment.createMany({ data: terms.schedule.map((s) => ({ invoiceId: inv.id, seq: s.seq, label: s.label, dueDate: dateOnly(s.dueDate), amountCents: s.amountCents })) });
  await tx.invoice.update({ where: { id: inv.id }, data: { acceptedOption: option, acceptedTerms: terms as unknown as Prisma.InputJsonValue, acceptedTermsHash: hash, ...extra } });
  return { terms, hash };
}

/**
 * The owner's approval: publishes a plain invoice (full payment, no acceptance step) to the
 * client's portal and sends the "new invoice" notice (email through sendEmail, by the client's
 * notification settings). Drafts and invoices pending approval only; owner (full access) only.
 */
export async function issueInvoice(actor: Actor, invoiceId: string, opts: { checkOptions?: (inv: Invoice) => Promise<void>; notify?: boolean } = {}) {
  await assertCanSendInvoices(actor);
  const inv = await loadFull(invoiceId);
  if (inv.state !== "DRAFT" && inv.state !== "PENDING_APPROVAL") throw new ValidationError("Only drafts and invoices waiting for approval can be sent.");
  if (!inv.allowFull) throw new ValidationError("Issuing directly bills the full amount. For a payment plan, send it as a quote so the client can choose and accept.");
  checkPricing(pricingInputOf(inv), (await billingSettings()).maxInstallments);
  if (opts.checkOptions) await opts.checkOptions(inv);
  const now = new Date();
  await prisma.$transaction(async (tx) => {
    const res = await tx.invoice.updateMany({ where: { id: invoiceId, state: { in: ["DRAFT", "PENDING_APPROVAL"] } }, data: { state: "ISSUED", publishedAt: now, approvedAt: now, approvedById: actor.id } });
    if (res.count !== 1) throw new ValidationError("Only drafts and invoices waiting for approval can be sent.");
    await freeze(tx, inv, "FULL", {});
  });
  await ownerAudit(actor.id, "billing.invoice_approved", "Invoice", invoiceId, { from: inv.state });
  await ownerAudit(actor.id, "billing.invoice_issued", "Invoice", invoiceId);
  if (opts.notify !== false) await notifyBilling(inv.clientId, "NEW_INVOICE", invoiceId);
}

export async function voidInvoice(actor: Actor, invoiceId: string, reason: string) {
  await assertCanVoid(actor);
  if (!reason.trim()) throw new ValidationError("Give a reason for voiding.");
  const inv = await loadFull(invoiceId);
  if (inv.state === "VOID") throw new ValidationError("Already void.");
  if (cashCollectedCents(inv.payments) !== 0) throw new ValidationError("Refund or reverse the recorded payments before voiding.");
  // Sent through Square: cancel it there first (refused if the client has paid in Square).
  if (inv.squareInvoiceId) await (await import("./square-invoicing")).cancelSquareInvoiceForVoid(actor.id, invoiceId);
  const res = await prisma.invoice.updateMany({ where: { id: invoiceId, state: { notIn: ["VOID"] } }, data: { state: "VOID", voidedAt: new Date(), voidReason: reason.trim().slice(0, 300) } });
  if (res.count !== 1) throw new ValidationError("Already void.");
  await ownerAudit(actor.id, "billing.invoice_voided", "Invoice", invoiceId, { reason: reason.trim().slice(0, 300), from: inv.state });
}

// ---------------------------------------------------------------------------
// Client side (portal)
// ---------------------------------------------------------------------------

/**
 * Quotes and invoices explicitly published to this account (a voided invoice that was sent stays
 * in the history as Voided). Never drafts, invoices waiting for approval, private notes, or who
 * created or approved them.
 */
export async function portalBilling(user: PortalActor, clientId: string) {
  await requireClientAccess(user.id, clientId, "billing");
  const rows = await prisma.invoice.findMany({
    where: { clientId, publishedAt: { not: null }, state: { in: ["OFFERED", "ACCEPTED", "ISSUED", "DECLINED", "VOID"] } },
    include: { lines: true, installments: { orderBy: { seq: "asc" } }, payments: { where: { status: "SUCCEEDED" }, orderBy: { receivedOn: "asc" } } },
    orderBy: { issueDate: "desc" },
  });
  const today = todayYmd();
  return rows.map((inv) => {
    const breakdown = breakdownOf(inv);
    const terms = inv.acceptedTerms as unknown as { totalCents: number; schedule: ScheduleItem[] } | null;
    const collected = collectedCents(inv.payments);
    const schedule = terms ? scheduleStatus(terms.schedule, collected, today) : [];
    const voided = inv.state === "VOID";
    const status: InvoiceStatusKey = invoiceStatus({ state: inv.state, viewedAt: inv.viewedAt, dueDate: ymd(inv.dueDate), totalCents: terms?.totalCents ?? null, appliedCents: collected, overdueInstallment: schedule.some((x) => x.state === "OVERDUE") }, today);
    return {
      id: inv.id,
      number: inv.number,
      title: inv.title,
      state: inv.state,
      status,
      formType: inv.formType,
      issueDate: ymd(inv.issueDate),
      dueDate: ymd(inv.dueDate),
      billTo: { name: inv.billingName, email: inv.billingEmail, phone: inv.billingPhone, address: inv.billingAddress },
      offeredMethods: inv.offeredMethods,
      squarePaymentUrl: inv.squarePaymentUrl,
      squarePublicUrl: inv.squarePublicUrl,
      squareStatus: inv.squareStatus,
      creditedCents: creditedCents(inv.payments),
      memo: inv.memo,
      paymentTerms: inv.paymentTerms,
      breakdown,
      acceptedOption: inv.acceptedOption,
      acceptedAt: inv.acceptedAt,
      totalCents: terms?.totalCents ?? null,
      collectedCents: collected,
      balanceCents: voided ? 0 : terms ? terms.totalCents - collected : null,
      schedule: voided ? [] : schedule,
      payments: inv.payments.map((p) => ({ id: p.id, kind: p.kind, amountCents: p.amountCents, receivedOn: ymd(p.receivedOn), method: p.method })),
    };
  });
}

/**
 * The client accepts one offered option. The terms hash the client saw must
 * match the current terms, so a stale page can't accept different numbers.
 * Accepting never authorizes automatic charges.
 */
export async function portalAcceptQuote(user: PortalActor, input: { invoiceId: string; option: PaymentOption; termsHash: string; agreed: boolean; ip: string | null }) {
  const inv = await loadFull(input.invoiceId);
  await requireClientAccess(user.id, inv.clientId, "billing");
  if (inv.state !== "OFFERED" || !inv.publishedAt) throw new ValidationError("This quote isn't open for acceptance.");
  if (!input.agreed) throw new ValidationError("Check the box to confirm you agree to these terms.");
  const breakdown = breakdownOf(inv);
  if (!breakdown.options[input.option]) throw new ValidationError("That payment option isn't offered on this quote.");
  const current = termsSnapshot({ invoiceNumber: inv.number, title: inv.title, clientName: inv.client.displayName, breakdown, option: input.option, paymentTerms: inv.paymentTerms, memo: inv.memo });
  if (current.hash !== input.termsHash) throw new ValidationError("These terms changed since you opened the page. Please review them again.");
  await prisma.$transaction(async (tx) => {
    const res = await tx.invoice.updateMany({ where: { id: inv.id, state: "OFFERED" }, data: { state: "ACCEPTED" } });
    if (res.count !== 1) throw new ValidationError("This quote was already answered.");
    await freeze(tx, inv, input.option, { acceptedAt: new Date(), acceptedByPortalId: user.id, acceptedFromIp: input.ip });
  });
  await ownerAudit(`portal:${user.id}`, "billing.quote_accepted", "Invoice", inv.id, { option: input.option, termsHash: current.hash });
  return current;
}

export function quoteTermsHash(inv: { number: string; title: string; paymentTerms: string | null; memo: string | null }, clientName: string, breakdown: Breakdown, option: Option) {
  return termsSnapshot({ invoiceNumber: inv.number, title: inv.title, clientName, breakdown, option, paymentTerms: inv.paymentTerms, memo: inv.memo }).hash;
}

export async function portalDeclineQuote(user: PortalActor, invoiceId: string) {
  const inv = await prisma.invoice.findUnique({ where: { id: invoiceId } });
  if (!inv) throw new ValidationError("Not found.");
  await requireClientAccess(user.id, inv.clientId, "billing");
  const res = await prisma.invoice.updateMany({ where: { id: invoiceId, state: "OFFERED" }, data: { state: "DECLINED", declinedAt: new Date() } });
  if (res.count !== 1) throw new ValidationError("This quote isn't open.");
  await ownerAudit(`portal:${user.id}`, "billing.quote_declined", "Invoice", invoiceId);
}

// ---------------------------------------------------------------------------
// Payments (manual until a provider is connected)
// ---------------------------------------------------------------------------

export type PaymentInput = {
  invoiceId: string;
  kind: "PAYMENT" | "REFUND" | "CREDIT";
  status: "SUCCEEDED" | "FAILED";
  amountCents: number;
  receivedOn: string;
  method: PaymentMethod;
  reference?: string | null;
  note?: string | null;
  // The form's one-time key (ActionForm idempotent): the same submission can't be recorded twice.
  idempotencyKey?: string | null;
};

/**
 * Records an offline payment, refund, failed attempt or balance adjustment.
 * Under a per-invoice lock: payments and credits can never exceed the remaining balance, a refund
 * can't exceed the cash collected, and a duplicate is refused — the same form submitted twice, a
 * reference already recorded for this client, or the same amount, date and method on this invoice.
 */
export async function recordPayment(actor: Actor, input: PaymentInput) {
  // Payments received → Record payments; refunds → Refund; credits → Credits & waivers.
  if (input.kind === "REFUND") await assertCanRefund(actor);
  else if (input.kind === "CREDIT") await assertCanApplyCredits(actor);
  else await assertCanRecordPayments(actor);
  if (!Number.isInteger(input.amountCents) || input.amountCents <= 0) throw new ValidationError("Enter an amount greater than $0.");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.receivedOn) || input.receivedOn > todayYmd()) throw new ValidationError("Enter the date the money moved (not in the future).");
  if (input.kind === "CREDIT" && !input.note?.trim()) throw new ValidationError("Give a reason for the adjustment.");
  const key = input.idempotencyKey?.trim().slice(0, 100) || null;
  if (key && (await prisma.payment.count({ where: { idempotencyKey: key } }))) throw new ValidationError("This payment was already recorded.");
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`invoice-pay:${input.invoiceId}`}))`;
    const inv = await tx.invoice.findUnique({ where: { id: input.invoiceId }, include: { payments: true } });
    if (!inv) throw new ValidationError("Not found.");
    if (inv.state !== "ACCEPTED" && inv.state !== "ISSUED") throw new ValidationError("Payments can be recorded on accepted quotes and issued invoices only.");
    const terms = inv.acceptedTerms as unknown as { totalCents: number };
    const collected = collectedCents(inv.payments);
    if (input.status === "SUCCEEDED") {
      if ((input.kind === "PAYMENT" || input.kind === "CREDIT") && collected + input.amountCents > terms.totalCents) {
        throw new ValidationError(`That's more than the remaining balance of $${((terms.totalCents - collected) / 100).toFixed(2)}.`);
      }
      if (input.kind === "REFUND" && input.amountCents > cashCollectedCents(inv.payments)) throw new ValidationError("A refund can't exceed what was collected.");
      if (input.kind === "PAYMENT") {
        const ref = input.reference?.trim();
        const sameRef = (r: string | null) => (r ?? "").trim().toLowerCase() === (ref ?? "").toLowerCase();
        const succeeded = inv.payments.filter((p) => p.status === "SUCCEEDED" && p.kind === "PAYMENT");
        // Same amount and date, and the same reference (or, with no reference, the same method).
        if (succeeded.some((p) => p.amountCents === input.amountCents && ymd(p.receivedOn) === input.receivedOn && sameRef(p.reference) && (ref || p.method === input.method))) {
          throw new ValidationError("This payment looks like a duplicate: the same amount, date and reference are already recorded on this invoice.");
        }
        if (ref) {
          const dup = await tx.payment.findFirst({ where: { clientId: inv.clientId, kind: "PAYMENT", status: "SUCCEEDED", reference: { equals: ref, mode: "insensitive" } } });
          if (dup) throw new ValidationError("A payment with this reference number is already recorded for this client.");
        }
      }
    }
    const p = await tx.payment.create({
      data: {
        invoiceId: inv.id,
        clientId: inv.clientId,
        kind: input.kind,
        status: input.status,
        amountCents: input.amountCents,
        receivedOn: dateOnly(input.receivedOn),
        method: input.method,
        source: input.kind === "CREDIT" ? "adjustment" : "manual",
        reference: input.reference?.trim().slice(0, 100) || null,
        note: input.note?.trim().slice(0, 300) || null,
        failureNote: input.status === "FAILED" ? input.note?.trim() || "Payment failed" : null,
        idempotencyKey: key,
        createdById: actor.id,
      },
    });
    const action = input.kind === "CREDIT" ? "billing.adjustment_applied" : `billing.${input.kind.toLowerCase()}_${input.status.toLowerCase()}`;
    await tx.ownerAuditLog.create({ data: { actorId: actor.id, action, entityType: "Payment", entityId: p.id, details: { invoiceId: inv.id, amountCents: input.amountCents, method: input.method } } });
    return p;
  }).catch((e: unknown) => {
    // Two submits with the same key racing past the check: the unique key stops the second.
    if ((e as { code?: string }).code === "P2002") throw new ValidationError("This payment was already recorded.");
    throw e;
  });
}

// ---------------------------------------------------------------------------
// Owner dashboard numbers (full access only)
// ---------------------------------------------------------------------------

export type InvoiceRow = {
  id: string;
  number: string;
  title: string;
  clientId: string;
  clientName: string;
  state: string;
  option: PaymentOption | null;
  invoicedOn: string | null;
  totalCents: number;
  collectedCents: number;
  balanceCents: number;
  overdueCents: number;
  nextDue: string | null;
  oldestOverdueDays: number;
  services: string[];
  status: InvoiceStatusKey;
  dueDate: string;
  formType: string;
};

/** Accepted/issued invoices with balances, using only recorded payments. */
export async function invoiceRows(actor: Actor, filter: { clientId?: string; state?: string } = {}): Promise<InvoiceRow[]> {
  await assertOffice(actor, "billing", "view");
  return rowsOf(filter);
}

async function rowsOf(filter: { clientId?: string; state?: string } = {}): Promise<InvoiceRow[]> {
  const rows = await prisma.invoice.findMany({
    where: { ...(filter.clientId ? { clientId: filter.clientId } : {}), ...(filter.state ? { state: filter.state as Invoice["state"] } : {}) },
    include: { lines: true, payments: true, client: { select: { displayName: true } } },
    orderBy: { issueDate: "desc" },
  });
  const today = todayYmd();
  return rows.map((inv) => {
    const terms = inv.acceptedTerms as unknown as { totalCents: number; schedule: ScheduleItem[] } | null;
    const collected = collectedCents(inv.payments);
    const counts = terms && (inv.state === "ACCEPTED" || inv.state === "ISSUED");
    const sched = counts ? scheduleStatus(terms!.schedule, collected, today) : [];
    const overdue = sched.filter((s) => s.state === "OVERDUE");
    const next = sched.find((s) => s.dueCents > 0);
    return {
      id: inv.id,
      number: inv.number,
      title: inv.title,
      clientId: inv.clientId,
      clientName: inv.client.displayName,
      state: inv.state,
      option: inv.acceptedOption,
      invoicedOn: counts ? ymd(inv.acceptedAt ?? inv.issueDate) : null,
      totalCents: counts ? terms!.totalCents : 0,
      collectedCents: collected,
      balanceCents: counts ? terms!.totalCents - collected : 0,
      overdueCents: overdue.reduce((s, o) => s + o.dueCents, 0),
      nextDue: next?.dueDate ?? null,
      oldestOverdueDays: overdue.reduce((m, o) => Math.max(m, o.daysOverdue), 0),
      services: inv.lines.map((l) => l.service),
      status: invoiceStatus({ state: inv.state, viewedAt: inv.viewedAt, dueDate: ymd(inv.dueDate), totalCents: terms?.totalCents ?? null, appliedCents: collected, overdueInstallment: overdue.length > 0 }, today),
      dueDate: ymd(inv.dueDate),
      formType: inv.formType,
    };
  });
}

/** Who owes what, aged by how late each unpaid installment is. */
export async function receivables(actor: Actor) {
  await assertOffice(actor, "receivables", "view");
  const rows = (await rowsOf()).filter((r) => r.balanceCents > 0);
  const invs = await prisma.invoice.findMany({ where: { id: { in: rows.map((r) => r.id) } }, include: { payments: true } });
  const today = todayYmd();
  const aging = Object.fromEntries(AGING_BUCKETS.map((b) => [b, 0])) as Record<(typeof AGING_BUCKETS)[number], number>;
  for (const inv of invs) {
    const terms = inv.acceptedTerms as unknown as { schedule: ScheduleItem[] };
    for (const s of scheduleStatus(terms.schedule, collectedCents(inv.payments), today)) if (s.dueCents > 0) aging[agingBucket(s.daysOverdue)] += s.dueCents;
  }
  const byClient = new Map<string, { clientId: string; clientName: string; balanceCents: number; overdueCents: number; services: Set<string>; invoices: string[] }>();
  for (const r of rows) {
    const c = byClient.get(r.clientId) ?? { clientId: r.clientId, clientName: r.clientName, balanceCents: 0, overdueCents: 0, services: new Set<string>(), invoices: [] };
    c.balanceCents += r.balanceCents;
    c.overdueCents += r.overdueCents;
    r.services.forEach((s) => c.services.add(s));
    c.invoices.push(r.number);
    byClient.set(r.clientId, c);
  }
  return {
    rows,
    aging,
    totalOutstandingCents: rows.reduce((s, r) => s + r.balanceCents, 0),
    clients: [...byClient.values()].map((c) => ({ ...c, services: [...c.services] })).sort((a, b) => b.balanceCents - a.balanceCents),
  };
}

/**
 * Monthly totals. "Invoiced" = accepted quotes / issued invoices by the date
 * they were accepted or issued; "Collected" = money actually received, minus
 * refunds. Unpaid invoices never count as cash.
 */
export async function monthlySummary(actor: Actor, year: number) {
  await assertOffice(actor, "revenue", "view");
  const start = new Date(Date.UTC(year, 0, 1));
  const end = new Date(Date.UTC(year + 1, 0, 1));
  const [invoices, payments, expenses] = await Promise.all([
    prisma.invoice.findMany({ where: { state: { in: ["ACCEPTED", "ISSUED"] } }, select: { acceptedAt: true, issueDate: true, acceptedTerms: true, state: true } }),
    prisma.payment.findMany({ where: { status: "SUCCEEDED", receivedOn: { gte: start, lt: end } } }),
    prisma.expense.findMany({ where: { deletedAt: null, spentOn: { gte: start, lt: end } } }),
  ]);
  const months = Array.from({ length: 12 }, (_, m) => ({ month: m + 1, invoicedCents: 0, collectedCents: 0, refundedCents: 0, expensesCents: 0, netCashCents: 0 }));
  for (const inv of invoices) {
    const d = inv.state === "ACCEPTED" && inv.acceptedAt ? inv.acceptedAt : inv.issueDate;
    if (d.getUTCFullYear() !== year) continue;
    months[d.getUTCMonth()].invoicedCents += (inv.acceptedTerms as unknown as { totalCents: number }).totalCents;
  }
  for (const p of payments) {
    const m = months[p.receivedOn.getUTCMonth()];
    // Credits adjust a balance; they are not cash received.
    if (p.kind === "CREDIT") continue;
    if (p.kind === "REFUND") m.refundedCents += p.amountCents;
    else m.collectedCents += p.amountCents;
  }
  for (const e of expenses) months[e.spentOn.getUTCMonth()].expensesCents += e.amountCents;
  for (const m of months) m.netCashCents = m.collectedCents - m.refundedCents - m.expensesCents;
  const total = months.reduce(
    (t, m) => ({ invoicedCents: t.invoicedCents + m.invoicedCents, collectedCents: t.collectedCents + m.collectedCents, refundedCents: t.refundedCents + m.refundedCents, expensesCents: t.expensesCents + m.expensesCents, netCashCents: t.netCashCents + m.netCashCents }),
    { invoicedCents: 0, collectedCents: 0, refundedCents: 0, expensesCents: 0, netCashCents: 0 },
  );
  return { months, total };
}
