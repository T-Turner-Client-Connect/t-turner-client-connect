import "server-only";
import type { AmountType, Invoice, InvoiceLine, Installment, Payment, PaymentMethod, PaymentOption, Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import type { Actor } from "@/lib/auth/actor";
import { ForbiddenError } from "@/lib/auth/actor";
import { assertOwner, ownerAccessFor, ownerAudit } from "@/lib/auth/owner";
import type { PortalActor } from "@/lib/portal/session";
import { requireClientAccess } from "@/lib/portal/access";
import {
  AGING_BUCKETS,
  agingBucket,
  collectedCents,
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
import { ValidationError } from "./clients";
import { queuePortalNotification } from "./notifications";

/**
 * Owner's Office billing: quotes, invoices, payment plans and payments.
 * Every staff-side function checks owner access against the database. Only
 * "Recorded manually" payments exist until a payment provider is connected —
 * nothing here charges a card or bank account.
 */

export const ymd = (d: Date) => d.toISOString().slice(0, 10);
const dateOnly = (s: string) => new Date(`${s}T00:00:00.000Z`);
export const todayYmd = () => new Date().toLocaleDateString("en-CA", { timeZone: "America/Chicago" });

export async function billingSettings() {
  return (await prisma.billingSettings.findUnique({ where: { id: "default" } })) ?? (await prisma.billingSettings.create({ data: { id: "default" } }));
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
  await assertOwner(actor, "full");
  if (input.planFeeType !== "NONE" && !input.planFeeRulesConfirmed) {
    throw new ValidationError("Confirm you've checked your payment provider's rules and the legal requirements before turning on a payment-plan fee.");
  }
  if (input.planFeeType === "PERCENT" && (input.planFeeValue <= 0 || input.planFeeValue > 2500)) throw new ValidationError("Set a payment-plan fee between 0.01% and 25%.");
  if (input.planFeeType === "FLAT" && (input.planFeeValue <= 0 || input.planFeeValue > 100_000)) throw new ValidationError("Set a flat payment-plan fee between $0.01 and $1,000.");
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

async function planFeeFor(actor: Actor, override: QuoteInput["planFeeOverride"]) {
  const s = await billingSettings();
  if (override) {
    const access = await ownerAccessFor(actor.id);
    if (!access || access.scope !== "FULL") throw new ForbiddenError("Only the owner can change the payment-plan fee on a quote.");
    return { type: override.type, value: override.value, maxInstallments: s.maxInstallments, confirmed: s.planFeeRulesConfirmedAt };
  }
  return { type: s.planFeeType, value: s.planFeeValue, maxInstallments: s.maxInstallments, confirmed: s.planFeeRulesConfirmedAt };
}

function checkPricing(input: PricingInput, maxInstallments: number) {
  try {
    validatePricing(input, { maxInstallments });
  } catch (e) {
    if (e instanceof PricingError) throw new ValidationError(e.message);
    throw e;
  }
}

async function nextNumber(tx: Prisma.TransactionClient, year: number) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('invoice-number'))`;
  const count = await tx.invoice.count({ where: { number: { startsWith: `INV-${year}-` } } });
  return `INV-${year}-${String(count + 1).padStart(4, "0")}`;
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
  await assertOwner(actor, "billing");
  if (!input.title.trim()) throw new ValidationError("Give the quote a title (e.g. 2026 tax preparation).");
  if (!(await prisma.client.count({ where: { id: input.clientId, archivedAt: null } }))) throw new ValidationError("Choose a client.");
  const fee = await planFeeFor(actor, input.planFeeOverride);
  if (input.allowPlan && fee.type !== "NONE" && !fee.confirmed) throw new ValidationError("Confirm the payment-plan fee rules in Billing settings before offering plans.");
  checkPricing(asPricing(input, fee), fee.maxInstallments);
  const inv = await prisma.$transaction(async (tx) => {
    const number = await nextNumber(tx, Number(input.issueDate.slice(0, 4)));
    return tx.invoice.create({
      data: {
        number,
        clientId: input.clientId,
        createdById: actor.id,
        ...invoiceData(input, fee),
        lines: { create: input.lines.map((l, i) => ({ service: l.service.trim().slice(0, 200), description: l.description?.trim() || null, quantity: l.quantity, unitCents: l.unitCents, sortOrder: i })) },
      },
    });
  });
  await ownerAudit(actor.id, "billing.quote_created", "Invoice", inv.id);
  return inv;
}

/** Drafts only — once offered or issued, the terms are fixed. */
export async function updateDraft(actor: Actor, invoiceId: string, input: QuoteInput) {
  await assertOwner(actor, "billing");
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

async function loadFull(id: string): Promise<FullInvoice & { client: { id: string; displayName: string } }> {
  const inv = await prisma.invoice.findUnique({ where: { id }, include: { lines: true, installments: { orderBy: { seq: "asc" } }, payments: { orderBy: { createdAt: "asc" } }, client: { select: { id: true, displayName: true } } } });
  if (!inv) throw new ValidationError("Not found.");
  return inv;
}

async function notifyBilling(clientId: string, kind: "QUOTE_READY" | "NEW_INVOICE", invoiceId: string) {
  const grants = await prisma.portalAccess.findMany({ where: { clientId, revokedAt: null, canViewBilling: true } });
  for (const g of grants) await queuePortalNotification(g.portalUserId, kind, `${kind}:${invoiceId}`);
}

/** Publishes a quote to the client's portal for acceptance. */
export async function offerQuote(actor: Actor, invoiceId: string) {
  await assertOwner(actor, "billing");
  const inv = await loadFull(invoiceId);
  if (inv.state !== "DRAFT") throw new ValidationError("This quote was already sent.");
  const s = await billingSettings();
  checkPricing(pricingInputOf(inv), s.maxInstallments);
  const res = await prisma.invoice.updateMany({ where: { id: invoiceId, state: "DRAFT" }, data: { state: "OFFERED", publishedAt: new Date() } });
  if (res.count !== 1) throw new ValidationError("This quote was already sent.");
  await ownerAudit(actor.id, "billing.quote_offered", "Invoice", invoiceId);
  await notifyBilling(inv.clientId, "QUOTE_READY", invoiceId);
}

/** Takes an offered quote back to draft (only before the client accepts). */
export async function withdrawQuote(actor: Actor, invoiceId: string) {
  await assertOwner(actor, "billing");
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

/** Publishes a plain invoice (full payment, no acceptance step). */
export async function issueInvoice(actor: Actor, invoiceId: string) {
  await assertOwner(actor, "billing");
  const inv = await loadFull(invoiceId);
  if (inv.state !== "DRAFT") throw new ValidationError("Only drafts can be issued.");
  if (!inv.allowFull) throw new ValidationError("Issuing directly bills the full amount. For a payment plan, send it as a quote so the client can choose and accept.");
  checkPricing(pricingInputOf(inv), (await billingSettings()).maxInstallments);
  await prisma.$transaction(async (tx) => {
    const res = await tx.invoice.updateMany({ where: { id: invoiceId, state: "DRAFT" }, data: { state: "ISSUED", publishedAt: new Date() } });
    if (res.count !== 1) throw new ValidationError("Only drafts can be issued.");
    await freeze(tx, inv, "FULL", {});
  });
  await ownerAudit(actor.id, "billing.invoice_issued", "Invoice", invoiceId);
  await notifyBilling(inv.clientId, "NEW_INVOICE", invoiceId);
}

export async function voidInvoice(actor: Actor, invoiceId: string, reason: string) {
  await assertOwner(actor, "billing");
  if (!reason.trim()) throw new ValidationError("Give a reason for voiding.");
  const inv = await loadFull(invoiceId);
  if (collectedCents(inv.payments) !== 0) throw new ValidationError("Refund or reverse the recorded payments before voiding.");
  const res = await prisma.invoice.updateMany({ where: { id: invoiceId, state: { notIn: ["VOID"] } }, data: { state: "VOID", voidedAt: new Date(), voidReason: reason.trim().slice(0, 300) } });
  if (res.count !== 1) throw new ValidationError("Already void.");
  await ownerAudit(actor.id, "billing.invoice_voided", "Invoice", invoiceId);
}

// ---------------------------------------------------------------------------
// Client side (portal)
// ---------------------------------------------------------------------------

/** Quotes and invoices explicitly published to this account. No private notes. */
export async function portalBilling(user: PortalActor, clientId: string) {
  await requireClientAccess(user.id, clientId, "billing");
  const rows = await prisma.invoice.findMany({
    where: { clientId, publishedAt: { not: null }, state: { in: ["OFFERED", "ACCEPTED", "ISSUED", "DECLINED"] } },
    include: { lines: true, installments: { orderBy: { seq: "asc" } }, payments: { where: { status: "SUCCEEDED" }, orderBy: { receivedOn: "asc" } } },
    orderBy: { issueDate: "desc" },
  });
  const today = todayYmd();
  return rows.map((inv) => {
    const breakdown = breakdownOf(inv);
    const terms = inv.acceptedTerms as unknown as { totalCents: number; schedule: ScheduleItem[] } | null;
    const collected = collectedCents(inv.payments);
    const schedule = terms ? scheduleStatus(terms.schedule, collected, today) : [];
    return {
      id: inv.id,
      number: inv.number,
      title: inv.title,
      state: inv.state,
      issueDate: ymd(inv.issueDate),
      memo: inv.memo,
      paymentTerms: inv.paymentTerms,
      breakdown,
      acceptedOption: inv.acceptedOption,
      acceptedAt: inv.acceptedAt,
      totalCents: terms?.totalCents ?? null,
      collectedCents: collected,
      balanceCents: terms ? terms.totalCents - collected : null,
      schedule,
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
  kind: "PAYMENT" | "REFUND";
  status: "SUCCEEDED" | "FAILED";
  amountCents: number;
  receivedOn: string;
  method: PaymentMethod;
  reference?: string | null;
  note?: string | null;
};

export async function recordPayment(actor: Actor, input: PaymentInput) {
  await assertOwner(actor, "billing");
  if (!Number.isInteger(input.amountCents) || input.amountCents <= 0) throw new ValidationError("Enter an amount greater than $0.");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.receivedOn) || input.receivedOn > todayYmd()) throw new ValidationError("Enter the date the money moved (not in the future).");
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`invoice-pay:${input.invoiceId}`}))`;
    const inv = await tx.invoice.findUnique({ where: { id: input.invoiceId }, include: { payments: true } });
    if (!inv) throw new ValidationError("Not found.");
    if (inv.state !== "ACCEPTED" && inv.state !== "ISSUED") throw new ValidationError("Payments can be recorded on accepted quotes and issued invoices only.");
    const terms = inv.acceptedTerms as unknown as { totalCents: number };
    const collected = collectedCents(inv.payments);
    if (input.status === "SUCCEEDED") {
      if (input.kind === "PAYMENT" && collected + input.amountCents > terms.totalCents) {
        throw new ValidationError(`That's more than the remaining balance of $${((terms.totalCents - collected) / 100).toFixed(2)}.`);
      }
      if (input.kind === "REFUND" && input.amountCents > collected) throw new ValidationError("A refund can't exceed what was collected.");
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
        source: "manual",
        reference: input.reference?.trim() || null,
        note: input.note?.trim() || null,
        failureNote: input.status === "FAILED" ? input.note?.trim() || "Payment failed" : null,
        createdById: actor.id,
      },
    });
    await tx.ownerAuditLog.create({ data: { actorId: actor.id, action: `billing.${input.kind.toLowerCase()}_${input.status.toLowerCase()}`, entityType: "Payment", entityId: p.id } });
    return p;
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
};

/** Accepted/issued invoices with balances, using only recorded payments. */
export async function invoiceRows(actor: Actor, filter: { clientId?: string; state?: string } = {}): Promise<InvoiceRow[]> {
  await assertOwner(actor, "billing");
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
    };
  });
}

/** Who owes what, aged by how late each unpaid installment is. */
export async function receivables(actor: Actor) {
  await assertOwner(actor, "full");
  const rows = (await invoiceRows(actor)).filter((r) => r.balanceCents > 0);
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
  await assertOwner(actor, "full");
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
