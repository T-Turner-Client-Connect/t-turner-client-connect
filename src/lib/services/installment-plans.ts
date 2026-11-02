import "server-only";
import { createHash } from "node:crypto";
import type { InstallmentPlan } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { assertOwner, ownerAudit } from "@/lib/auth/owner";
import { ForbiddenError, type Actor } from "@/lib/auth/actor";
import type { PortalActor } from "@/lib/portal/session";
import { requireClientAccess } from "@/lib/portal/access";
import { computePlan, lateFeeFor, PlanError, qualifyingMonths, type LateFeePolicy, type PlanCard, type PlanSchedule } from "@/lib/billing/installment-plan";
import { usd } from "@/lib/billing/payment-fees";
import { addMonths } from "@/lib/billing/pricing";
import { ValidationError } from "./clients";
import { feeSettings } from "./service-agreements";
import { breakdownOf } from "./owner-billing";

/**
 * In-house payment plans. The client picks only the number of months (from
 * the options their price qualifies for) and credit vs. debit; the server
 * computes the fee, deposit and schedule and fingerprints the exact terms.
 * Statuses: Requested → Pending Approval (client accepted) → Approved or
 * Declined → Deposit Pending (card on file authorized) → Active → Past Due /
 * Paid in Full. No charge may happen until the client accepted, the owner
 * approved and a card-on-file authorization is recorded.
 */

export const PLAN_STATUS = {
  REQUESTED: "Requested",
  PENDING_APPROVAL: "Pending Approval",
  APPROVED: "Approved",
  DECLINED: "Declined",
  DEPOSIT_PENDING: "Deposit Pending",
  ACTIVE: "Active",
  PAST_DUE: "Past Due",
  PAID_IN_FULL: "Paid in Full",
  CANCELLED: "Cancelled",
} as const;
export type PlanStatus = keyof typeof PLAN_STATUS;

export const PLAN_CONSENT =
  "I agree to this payment plan: the deposit and each installment on the dates shown, charged to the card I authorize on file. I understand the plan starts only after T. Turner & Associates, LLC approves it, that no fee is added for choosing a plan, and that I can contact the office to cancel future charges or dispute a charge.";

const thisDay = () => new Date().toLocaleDateString("en-CA", { timeZone: "America/Chicago" });
// Keys sorted so the fingerprint is the same before and after the terms are stored (Postgres reorders JSON keys).
const canonical = (v: unknown): string => (Array.isArray(v) ? `[${v.map(canonical).join(",")}]` : v && typeof v === "object" ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`).join(",")}}` : JSON.stringify(v));
const sha = (v: unknown) => createHash("sha256").update(canonical(v)).digest("hex");

/** What the client sees for each qualifying term, computed by the server. */
export async function planOptions(serviceCents: number, card: PlanCard, firstDueDate = addMonths(thisDay(), 1)) {
  const settings = await feeSettings();
  return qualifyingMonths(serviceCents).map((months) => computePlan({ serviceCents, months, card, firstDueDate, feeSettings: settings }));
}

function termsOf(title: string, clientName: string, p: PlanSchedule) {
  return {
    title,
    clientName,
    serviceCents: p.serviceCents,
    card: p.card,
    feeCents: p.feeCents,
    feeNote: p.feeNote,
    totalCents: p.totalCents,
    depositCents: p.depositCents,
    months: p.months,
    installments: p.installments,
    consent: PLAN_CONSENT,
  };
}

/** Staff or the client request a plan for an amount owed. The client never supplies amounts. */
export async function requestPlan(who: { staff: Actor } | { portal: PortalActor }, input: { clientId: string; title: string; serviceCents: number; months: number; card: string; invoiceId?: string | null; serviceId?: string | null }) {
  if ("portal" in who) {
    await requireClientAccess(who.portal.id, input.clientId, "billing");
    // A client can only request a plan for an amount the office has set (an invoice or a service agreement on their account).
    if (!input.invoiceId && !input.serviceId) throw new ForbiddenError("Ask our office to set up the amount for your plan.");
  }
  const client = await prisma.client.findUnique({ where: { id: input.clientId }, select: { displayName: true, archivedAt: true } });
  if (!client || client.archivedAt) throw new ValidationError("Client not found.");
  let serviceCents = input.serviceCents;
  let title = input.title;
  if (input.invoiceId) {
    const inv = await prisma.invoice.findFirst({ where: { id: input.invoiceId, clientId: input.clientId, state: { in: ["OFFERED", "ACCEPTED", "ISSUED"] } }, include: { lines: true } });
    if (!inv) throw new ValidationError("That invoice can't be put on a plan.");
    // The amount comes from the invoice, not from the request.
    // The amount owed (after discount and tax) as the invoice states it for payment in full.
    serviceCents = breakdownOf(inv).options.FULL?.totalCents ?? inv.lines.reduce((a, l) => a + l.quantity * l.unitCents, 0);
    title = inv.title;
  }
  if (input.card !== "CARD_CREDIT" && input.card !== "CARD_DEBIT") throw new ValidationError("Choose a credit or debit card for the plan.");
  if (await prisma.installmentPlan.count({ where: { clientId: input.clientId, invoiceId: input.invoiceId ?? undefined, serviceId: input.serviceId ?? undefined, status: { in: ["REQUESTED", "PENDING_APPROVAL", "APPROVED", "DEPOSIT_PENDING", "ACTIVE", "PAST_DUE"] } } }) && (input.invoiceId || input.serviceId)) {
    throw new ValidationError("A payment plan for this is already open.");
  }
  let p: PlanSchedule;
  try {
    p = computePlan({ serviceCents, months: input.months, card: input.card, firstDueDate: addMonths(thisDay(), 1), feeSettings: await feeSettings() });
  } catch (e) {
    if (e instanceof PlanError) throw new ValidationError(e.message);
    throw e;
  }
  const terms = termsOf(title.trim().slice(0, 120) || "Payment plan", client.displayName, p);
  const plan = await prisma.installmentPlan.create({
    data: {
      clientId: input.clientId,
      invoiceId: input.invoiceId ?? null,
      serviceId: input.serviceId ?? null,
      title: terms.title,
      serviceCents: p.serviceCents,
      card: p.card,
      months: p.months,
      feeCents: p.feeCents,
      totalCents: p.totalCents,
      depositCents: p.depositCents,
      schedule: p.installments,
      terms,
      termsHash: sha(terms),
      requestedById: "staff" in who ? who.staff.id : null,
      requestedByPortalId: "portal" in who ? who.portal.id : null,
    },
  });
  await ownerAudit("staff" in who ? who.staff.id : `portal:${who.portal.id}`, "plan.requested", "InstallmentPlan", plan.id, { clientId: input.clientId, months: p.months, totalCents: p.totalCents });
  return plan;
}

/** The client accepts the exact terms shown (fingerprint must match). Moves the plan to Pending Approval. */
export async function acceptPlan(user: PortalActor, input: { planId: string; termsHash: string; agreed: boolean; name: string; ip?: string | null }) {
  const plan = await prisma.installmentPlan.findUnique({ where: { id: input.planId } });
  if (!plan) throw new ForbiddenError("You don't have access to that plan.");
  await requireClientAccess(user.id, plan.clientId, "billing");
  if (plan.status !== "REQUESTED") throw new ValidationError("This plan isn't waiting for your acceptance.");
  if (input.agreed !== true) throw new ValidationError("Check the box to agree to the payment plan.");
  const name = input.name.trim().replace(/\s+/g, " ");
  if (name.length < 3 || !/\s/.test(name)) throw new ValidationError("Type your full name to sign.");
  if (input.termsHash !== plan.termsHash || sha(plan.terms) !== plan.termsHash) throw new ValidationError("The plan changed since this page loaded. Review it and accept again.");
  const claimed = await prisma.installmentPlan.updateMany({ where: { id: plan.id, status: "REQUESTED" }, data: { status: "PENDING_APPROVAL", acceptedAt: new Date(), acceptedByPortalId: user.id, acceptedName: name, acceptedIp: input.ip?.slice(0, 64) ?? null } });
  if (claimed.count !== 1) throw new ValidationError("This plan isn't waiting for your acceptance.");
  await ownerAudit(`portal:${user.id}`, "plan.accepted", "InstallmentPlan", plan.id, { termsHash: plan.termsHash });
}

/** Owner only: approve a plan the client accepted. Approval alone never charges anything. */
export async function approvePlan(actor: Actor, planId: string) {
  await assertOwner(actor, "full");
  const plan = await prisma.installmentPlan.findUnique({ where: { id: planId } });
  if (!plan) throw new ValidationError("Plan not found.");
  if (plan.status !== "PENDING_APPROVAL") throw new ValidationError(plan.status === "REQUESTED" ? "The client hasn't accepted the plan terms yet." : `A plan that's ${PLAN_STATUS[plan.status as PlanStatus]} can't be approved.`);
  await prisma.installmentPlan.update({ where: { id: plan.id }, data: { status: plan.cardAuthorizedAt ? "DEPOSIT_PENDING" : "APPROVED", approvedAt: new Date(), approvedById: actor.id } });
  await ownerAudit(actor.id, "plan.approved", "InstallmentPlan", plan.id, { totalCents: plan.totalCents });
}

export async function declinePlan(actor: Actor, planId: string, reason: string) {
  await assertOwner(actor, "full");
  if (!reason.trim()) throw new ValidationError("Give the client a reason.");
  const plan = await prisma.installmentPlan.findUnique({ where: { id: planId } });
  if (!plan || !["REQUESTED", "PENDING_APPROVAL", "APPROVED"].includes(plan.status)) throw new ValidationError("This plan can't be declined now.");
  await prisma.installmentPlan.update({ where: { id: plan.id }, data: { status: "DECLINED", declinedAt: new Date(), declinedById: actor.id, declineReason: reason.trim().slice(0, 300) } });
  await ownerAudit(actor.id, "plan.declined", "InstallmentPlan", plan.id, { reason: reason.trim().slice(0, 300) });
}

/**
 * Records the card-on-file authorization (called by the Square integration with
 * Square's card reference — never card numbers). A debit card on a plan priced
 * for credit must be re-quoted: no credit surcharge on a debit card.
 */
export async function recordCardAuthorization(planId: string, input: { reference: string; cardType: "CREDIT" | "DEBIT" | "PREPAID" | "UNKNOWN" }) {
  const plan = await prisma.installmentPlan.findUnique({ where: { id: planId } });
  if (!plan || !["PENDING_APPROVAL", "APPROVED"].includes(plan.status)) throw new ValidationError("This plan isn't waiting for a card.");
  if (plan.card === "CARD_CREDIT" && plan.feeCents > 0 && input.cardType !== "CREDIT") throw new ValidationError("This card isn't a credit card, so the credit-card fee can't apply. The plan needs to be re-quoted for a debit card.");
  await prisma.installmentPlan.update({ where: { id: plan.id }, data: { cardAuthorizedAt: new Date(), cardAuthorizationRef: input.reference.slice(0, 120), verifiedCardType: input.cardType, ...(plan.status === "APPROVED" ? { status: "DEPOSIT_PENDING" } : {}) } });
  await ownerAudit(`system:square`, "plan.card_authorized", "InstallmentPlan", plan.id, { cardType: input.cardType });
}

/** The single gate every automatic charge must pass. */
export function chargeAllowed(plan: Pick<InstallmentPlan, "status" | "acceptedAt" | "approvedAt" | "cardAuthorizedAt">) {
  if (!plan.acceptedAt) return { ok: false as const, reason: "The client hasn't accepted the plan." };
  if (!plan.approvedAt) return { ok: false as const, reason: "The owner hasn't approved the plan." };
  if (!plan.cardAuthorizedAt) return { ok: false as const, reason: "No card-on-file authorization." };
  if (!["DEPOSIT_PENDING", "ACTIVE", "PAST_DUE"].includes(plan.status)) return { ok: false as const, reason: `The plan is ${PLAN_STATUS[plan.status as PlanStatus]}.` };
  return { ok: true as const, reason: "" };
}

/** Paid, due and overdue amounts by installment, and the plan's status from the payments recorded. */
export function planProgress(plan: Pick<InstallmentPlan, "status" | "depositCents" | "totalCents" | "paidCents" | "schedule" | "approvedAt">, today: string, policy: LateFeePolicy) {
  const items = [{ seq: 0, label: "Deposit", dueDate: plan.approvedAt ? plan.approvedAt.toISOString().slice(0, 10) : today, amountCents: plan.depositCents }, ...(plan.schedule as { seq: number; dueDate: string; amountCents: number }[]).map((i) => ({ ...i, label: `Installment ${i.seq}` }))];
  let left = plan.paidCents;
  const rows = items.map((i) => {
    const paid = Math.min(left, i.amountCents);
    left -= paid;
    const unpaid = i.amountCents - paid;
    const overdue = unpaid > 0 && i.dueDate < today;
    return { ...i, paidCents: paid, unpaidCents: unpaid, overdue, lateFeeCents: lateFeeFor(unpaid, i.dueDate, today, policy) };
  });
  const balanceCents = plan.totalCents - Math.min(plan.paidCents, plan.totalCents);
  let status = plan.status as PlanStatus;
  if (["DEPOSIT_PENDING", "ACTIVE", "PAST_DUE"].includes(status)) {
    status = balanceCents === 0 ? "PAID_IN_FULL" : rows.some((r) => r.overdue) ? "PAST_DUE" : rows[0].unpaidCents === 0 ? "ACTIVE" : "DEPOSIT_PENDING";
  }
  return { rows, balanceCents, overdueCents: rows.filter((r) => r.overdue).reduce((a, r) => a + r.unpaidCents, 0), lateFeesCents: rows.reduce((a, r) => a + r.lateFeeCents, 0), status };
}

/** Owner: records a verified payment against a plan (manual or confirmed by Square). */
export async function recordPlanPayment(actor: Actor, planId: string, amountCents: number, note: string) {
  await assertOwner(actor, "billing");
  if (!Number.isInteger(amountCents) || amountCents <= 0) throw new ValidationError("Enter the amount received.");
  const plan = await prisma.installmentPlan.findUnique({ where: { id: planId } });
  if (!plan || !plan.approvedAt) throw new ValidationError("Payments apply only to approved plans.");
  if (plan.paidCents + amountCents > plan.totalCents) throw new ValidationError(`That's more than the remaining balance (${usd(plan.totalCents - plan.paidCents)}).`);
  const paidCents = plan.paidCents + amountCents;
  await prisma.installmentPlan.update({ where: { id: plan.id }, data: { paidCents, ...(paidCents === plan.totalCents ? { status: "PAID_IN_FULL" } : paidCents >= plan.depositCents && ["APPROVED", "DEPOSIT_PENDING"].includes(plan.status) ? { status: "ACTIVE" } : {}) } });
  await ownerAudit(actor.id, "plan.payment_recorded", "InstallmentPlan", plan.id, { amountCents, note: note.slice(0, 200) });
}

export async function lateFeePolicy(): Promise<LateFeePolicy & { reviewedNote: string | null; reviewedAt: Date | null }> {
  const s = await prisma.lateFeeSettings.findUnique({ where: { id: "default" } });
  return { enabled: s?.enabled ?? false, graceDays: s?.graceDays ?? 5, periodDays: s?.periodDays ?? 5, rateBps: s?.rateBps ?? 1000, capBps: s?.capBps ?? null, reviewedNote: s?.reviewedNote ?? null, reviewedAt: s?.reviewedAt ?? null };
}

/** Owner: edit the late-fee policy. Turning it on requires a recorded legal review. */
export async function saveLateFeePolicy(actor: Actor, input: { enabled: boolean; graceDays: number; periodDays: number; rateBps: number; capBps: number | null; reviewedNote?: string }) {
  await assertOwner(actor, "full");
  if (![input.graceDays, input.periodDays, input.rateBps].every((n) => Number.isInteger(n) && n >= 0) || input.periodDays < 1) throw new ValidationError("Enter whole numbers for the grace period, period and rate.");
  if (input.enabled && (!input.reviewedNote || input.reviewedNote.trim().length < 20)) throw new ValidationError("Record the legal review (applicable law, enforceability, and that clients' signed agreements include this policy) before turning late fees on.");
  const data = { enabled: input.enabled, graceDays: input.graceDays, periodDays: input.periodDays, rateBps: input.rateBps, capBps: input.capBps, ...(input.enabled ? { reviewedNote: input.reviewedNote!.trim().slice(0, 1000), reviewedAt: new Date(), reviewedById: actor.id } : {}) };
  await prisma.lateFeeSettings.upsert({ where: { id: "default" }, create: { id: "default", ...data }, update: data });
  await ownerAudit(actor.id, "billing.late_fee_policy_saved", "LateFeeSettings", "default", { enabled: input.enabled, rateBps: input.rateBps, capBps: input.capBps });
}

export async function waiveFee(actor: Actor, input: { clientId: string; planId?: string; invoiceId?: string; amountCents: number; reason: string }) {
  await assertOwner(actor, "full");
  if (!Number.isInteger(input.amountCents) || input.amountCents <= 0 || !input.reason.trim()) throw new ValidationError("Enter the amount and a reason.");
  const w = await prisma.feeWaiver.create({ data: { clientId: input.clientId, planId: input.planId ?? null, invoiceId: input.invoiceId ?? null, amountCents: input.amountCents, reason: input.reason.trim().slice(0, 300), waivedById: actor.id } });
  await ownerAudit(actor.id, "billing.fee_waived", "FeeWaiver", w.id, { amountCents: input.amountCents });
  return w;
}

// --- Payment method per invoice, instructions, changes ---------------------------------

export const PAY_METHODS = {
  CASH: { label: "Cash", fee: "No fee" },
  ZELLE: { label: "Zelle", fee: "No fee" },
  CASH_APP: { label: "Cash App", fee: "Fee only if approved" },
  VENMO: { label: "Venmo", fee: "Fee only if approved" },
  APPLE_PAY: { label: "Apple Pay", fee: "Card rules apply (no fee on debit)" },
  SQUARE_INVOICE: { label: "Square invoice (card)", fee: "Card rules apply (no fee on debit)" },
  SQUARE_AFTERPAY: { label: "Afterpay (through Square, if eligible)", fee: "Set by Square/Afterpay" },
  IN_HOUSE_PLAN: { label: "In-house payment plan (card on file)", fee: "Card rules apply (no fee on debit)" },
} as const;
export type PayMethod = keyof typeof PAY_METHODS;

export async function paymentInstructions() {
  return prisma.paymentInstruction.findMany({ where: { active: true } });
}

export async function savePaymentInstruction(actor: Actor, method: string, input: { details: string; active: boolean }) {
  await assertOwner(actor, "full");
  if (!(method in PAY_METHODS)) throw new ValidationError("Choose a payment method.");
  if (input.active && !input.details.trim()) throw new ValidationError("Enter the payment instructions clients should see.");
  const label = PAY_METHODS[method as PayMethod].label;
  await prisma.paymentInstruction.upsert({ where: { method }, create: { method, label, details: input.details.trim().slice(0, 1000), active: input.active, updatedById: actor.id }, update: { details: input.details.trim().slice(0, 1000), active: input.active, updatedById: actor.id } });
  await ownerAudit(actor.id, "billing.instruction_saved", "PaymentInstruction", method, { active: input.active });
}

/** Sets the invoice's one payment method the first time; afterwards changes need the owner's approval. */
export async function chooseInvoiceMethod(who: { staff: Actor } | { portal: PortalActor }, invoiceId: string, method: string, reason?: string) {
  if (!(method in PAY_METHODS) || method === "IN_HOUSE_PLAN") throw new ValidationError("Choose a payment method.");
  const inv = await prisma.invoice.findUnique({ where: { id: invoiceId } });
  if (!inv || inv.state === "DRAFT" || inv.state === "VOID") throw new ForbiddenError("You don't have access to that invoice.");
  if ("portal" in who) await requireClientAccess(who.portal.id, inv.clientId, "billing");
  else await assertOwner(who.staff, "billing");
  if (!inv.paymentMethod) {
    await prisma.invoice.update({ where: { id: inv.id }, data: { paymentMethod: method } });
    await ownerAudit("staff" in who ? who.staff.id : `portal:${who.portal.id}`, "billing.method_selected", "Invoice", inv.id, { method });
    return { changed: true, pending: false };
  }
  if (inv.paymentMethod === method) return { changed: false, pending: false };
  if (await prisma.paymentMethodChange.count({ where: { invoiceId: inv.id, status: "PENDING" } })) throw new ValidationError("A payment-method change is already waiting for approval.");
  await prisma.paymentMethodChange.create({ data: { clientId: inv.clientId, invoiceId: inv.id, fromMethod: inv.paymentMethod, toMethod: method, reason: reason?.trim().slice(0, 300) || null, requestedById: "staff" in who ? who.staff.id : null, requestedByPortalId: "portal" in who ? who.portal.id : null } });
  return { changed: false, pending: true };
}

export async function decideMethodChange(actor: Actor, changeId: string, approve: boolean, note?: string) {
  await assertOwner(actor, "full");
  const c = await prisma.paymentMethodChange.findUnique({ where: { id: changeId } });
  if (!c || c.status !== "PENDING") throw new ValidationError("This request was already decided.");
  await prisma.$transaction(async (tx) => {
    await tx.paymentMethodChange.update({ where: { id: c.id }, data: { status: approve ? "APPROVED" : "DECLINED", decidedById: actor.id, decidedAt: new Date(), decisionNote: note?.trim().slice(0, 300) || null } });
    if (approve && c.invoiceId) await tx.invoice.update({ where: { id: c.invoiceId }, data: { paymentMethod: c.toMethod } });
  });
  await ownerAudit(actor.id, approve ? "billing.method_change_approved" : "billing.method_change_declined", "PaymentMethodChange", c.id, { from: c.fromMethod, to: c.toMethod });
}

/** Owner dashboard: plans needing approval, active/past due, and method changes waiting. */
export async function planQueue(actor: Actor) {
  await assertOwner(actor, "billing");
  const [plans, changes] = await Promise.all([
    prisma.installmentPlan.findMany({ where: { status: { notIn: ["DECLINED", "CANCELLED"] } }, include: { client: { select: { displayName: true } } }, orderBy: { createdAt: "desc" }, take: 200 }),
    prisma.paymentMethodChange.findMany({ where: { status: "PENDING" }, orderBy: { createdAt: "asc" } }),
  ]);
  return { plans, changes };
}

/** The client's plans for their portal. */
export async function portalPlans(user: PortalActor, clientId: string) {
  await requireClientAccess(user.id, clientId, "billing");
  return prisma.installmentPlan.findMany({ where: { clientId, status: { not: "CANCELLED" } }, orderBy: { createdAt: "desc" } });
}
