import "server-only";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import type { Actor } from "@/lib/auth/actor";
import { assertOffice } from "@/lib/auth/owner";
import { requireClientAccess } from "@/lib/portal/access";
import type { PortalActor } from "@/lib/portal/session";
import { ValidationError } from "./clients";

/**
 * Pay From My Refund (Republic Bank Refund Transfer) — tracking only.
 *
 * The client asks (with the Treasury Offset Program check and acknowledgments); once the return
 * is done the office enters the preparation fee owed; when Republic Bank's deposit arrives the
 * office clears it. Nothing here submits a bank-product application or authorizes a deduction —
 * Republic Bank's own application and agreement do that — and a fee is never shown as paid until
 * the deposit is actually recorded.
 */

export const RT_STATUS = {
  REQUESTED: { label: "Pending review", tone: "pending" },
  AWAITING_DEPOSIT: { label: "Awaiting refund deposit", tone: "open" },
  RECEIVED: { label: "Paid from refund", tone: "paid" },
  SHORT: { label: "Partly paid — balance due", tone: "partial" },
  NOT_RECEIVED: { label: "Not received — pay another way", tone: "overdue" },
  CANCELLED: { label: "Cancelled", tone: "muted" },
} as const;
export type RtStatus = keyof typeof RT_STATUS;

export const DEBT_CHECK = { CHECKED: "Yes, I called and checked.", NOT_CHECKED: "No, I have not checked.", NEEDS_HELP: "I am unsure and need assistance." } as const;
export const OFFSET_RISK = { NO: "No", YES: "Yes", NOT_SURE: "Not sure" } as const;

type Tx = Prisma.TransactionClient;
const cents = (v: string) => {
  const n = Number(String(v).replace(/[$,\s]/g, ""));
  if (!Number.isFinite(n) || n <= 0 || n > 100000) throw new ValidationError("Enter an amount in dollars, like 300 or 300.00.");
  return Math.round(n * 100);
};
async function event(tx: Tx, e: { paymentId: string; action: string; fromStatus?: string | null; toStatus?: string | null; amountCents?: number | null; actorUserId?: string | null; actorPortalUserId?: string | null; note?: string | null }) {
  await tx.refundTransferEvent.create({ data: { ...e, note: e.note?.trim().slice(0, 500) || null } });
}

/** Client: ask to pay the preparation fee from the refund. Stays Pending review until the office approves. */
export async function requestRefundTransfer(user: PortalActor, clientId: string, input: { taxYear: number; debtCheck: string; offsetRisk: string; acknowledged: boolean }) {
  await requireClientAccess(user.id, clientId, "billing");
  if (!(input.debtCheck in DEBT_CHECK)) throw new ValidationError("Tell us whether you checked for outstanding debts.");
  if (!(input.offsetRisk in OFFSET_RISK)) throw new ValidationError("Tell us whether you or your spouse may owe debts that could reduce your refund.");
  if (!input.acknowledged) throw new ValidationError("Please check the acknowledgment box to continue.");
  const thisYear = new Date().getFullYear();
  if (!Number.isInteger(input.taxYear) || input.taxYear < thisYear - 2 || input.taxYear > thisYear) throw new ValidationError("Choose a tax year from the list.");
  return prisma.$transaction(async (tx) => {
    const existing = await tx.refundTransferPayment.findUnique({ where: { clientId_taxYear: { clientId, taxYear: input.taxYear } } });
    if (existing && existing.status !== "CANCELLED") throw new ValidationError(`You already chose Pay From My Refund for ${input.taxYear}. Our office will follow up.`);
    const data = { status: "REQUESTED", debtCheck: input.debtCheck, offsetRisk: input.offsetRisk, acknowledgedAt: new Date(), amountCents: null, receivedCents: null, receivedOn: null };
    const p = existing ? await tx.refundTransferPayment.update({ where: { id: existing.id }, data }) : await tx.refundTransferPayment.create({ data: { clientId, taxYear: input.taxYear, ...data } });
    // A possible offset or an unchecked debt status is flagged for the office in the history line.
    const flag = input.offsetRisk !== "NO" || input.debtCheck !== "CHECKED" ? "Flag: check for possible refund offset before approving." : null;
    await event(tx, { paymentId: p.id, action: "REQUESTED", fromStatus: existing?.status ?? null, toStatus: "REQUESTED", actorPortalUserId: user.id, note: [DEBT_CHECK[input.debtCheck as keyof typeof DEBT_CHECK], `Possible offset: ${OFFSET_RISK[input.offsetRisk as keyof typeof OFFSET_RISK]}`, flag].filter(Boolean).join(" · ") });
    return p;
  });
}

/** Client: this account's Pay From My Refund records (its own only). */
export async function portalRefundTransfers(user: PortalActor, clientId: string) {
  await requireClientAccess(user.id, clientId, "billing");
  return prisma.refundTransferPayment.findMany({ where: { clientId }, orderBy: { taxYear: "desc" } });
}

// --- Office (owner, or staff the owner gave billing access) -------------------------------------

/** Office: add or update the fee owed for a client's tax year (approves a request). */
export async function setRefundTransferAmount(actor: Actor, input: { clientId: string; taxYear: number; amount: string; note?: string }) {
  await assertOffice(actor, "billing", "edit");
  const amountCents = cents(input.amount);
  if (!Number.isInteger(input.taxYear) || input.taxYear < 2015 || input.taxYear > new Date().getFullYear()) throw new ValidationError("Choose the tax year.");
  const client = await prisma.client.findUnique({ where: { id: input.clientId }, select: { archivedAt: true } });
  if (!client || client.archivedAt) throw new ValidationError("Choose a client.");
  return prisma.$transaction(async (tx) => {
    const existing = await tx.refundTransferPayment.findUnique({ where: { clientId_taxYear: { clientId: input.clientId, taxYear: input.taxYear } } });
    if (existing && (existing.status === "RECEIVED" || existing.status === "SHORT")) throw new ValidationError("A deposit is already recorded for this year. Undo it first if the amount was wrong.");
    const p = existing
      ? await tx.refundTransferPayment.update({ where: { id: existing.id }, data: { status: "AWAITING_DEPOSIT", amountCents } })
      : await tx.refundTransferPayment.create({ data: { clientId: input.clientId, taxYear: input.taxYear, status: "AWAITING_DEPOSIT", amountCents, createdById: actor.id } });
    await event(tx, { paymentId: p.id, action: existing ? "AMOUNT_SET" : "ADDED", fromStatus: existing?.status ?? null, toStatus: "AWAITING_DEPOSIT", amountCents, actorUserId: actor.id, note: input.note });
    return p;
  });
}

/** Office: the Republic Bank deposit arrived. Less than owed → SHORT (the rest is owed another way). */
export async function recordRefundDeposit(actor: Actor, paymentId: string, input: { amount: string; receivedOn: string; note?: string }) {
  await assertOffice(actor, "receivables", "reconcile");
  const receivedCents = cents(input.amount);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.receivedOn)) throw new ValidationError("Enter the date the deposit arrived.");
  return prisma.$transaction(async (tx) => {
    const p = await tx.refundTransferPayment.findUnique({ where: { id: paymentId } });
    if (!p) throw new ValidationError("Not found.");
    if (p.status !== "AWAITING_DEPOSIT" || p.amountCents == null) throw new ValidationError("Enter the fee owed before recording a deposit.");
    const status = receivedCents >= p.amountCents ? "RECEIVED" : "SHORT";
    const done = await tx.refundTransferPayment.updateMany({ where: { id: paymentId, status: "AWAITING_DEPOSIT" }, data: { status, receivedCents, receivedOn: new Date(`${input.receivedOn}T00:00:00Z`) } });
    if (!done.count) throw new ValidationError("This was just updated. Refresh and try again.");
    await event(tx, { paymentId, action: "DEPOSIT_RECEIVED", fromStatus: p.status, toStatus: status, amountCents: receivedCents, actorUserId: actor.id, note: input.note });
  });
}

/** Office: no deposit is coming (refund intercepted, reduced to nothing, or not approved). */
export async function markRefundNotReceived(actor: Actor, paymentId: string, note: string) {
  await assertOffice(actor, "receivables", "reconcile");
  if (!note.trim()) throw new ValidationError("Add a short reason.");
  return changeStatus(actor, paymentId, ["REQUESTED", "AWAITING_DEPOSIT"], "NOT_RECEIVED", "NOT_RECEIVED", note);
}

export async function cancelRefundTransfer(actor: Actor, paymentId: string, note: string) {
  await assertOffice(actor, "billing", "edit");
  if (!note.trim()) throw new ValidationError("Add a short reason.");
  return changeStatus(actor, paymentId, ["REQUESTED", "AWAITING_DEPOSIT", "NOT_RECEIVED"], "CANCELLED", "CANCELLED", note);
}

/** Office: undo a recorded deposit entered by mistake (history keeps both lines). */
export async function undoRefundDeposit(actor: Actor, paymentId: string, note: string) {
  await assertOffice(actor, "receivables", "reconcile");
  if (!note.trim()) throw new ValidationError("Add a short reason.");
  return prisma.$transaction(async (tx) => {
    const p = await tx.refundTransferPayment.findUnique({ where: { id: paymentId } });
    if (!p || (p.status !== "RECEIVED" && p.status !== "SHORT")) throw new ValidationError("No deposit is recorded.");
    await tx.refundTransferPayment.update({ where: { id: paymentId }, data: { status: "AWAITING_DEPOSIT", receivedCents: null, receivedOn: null } });
    await event(tx, { paymentId, action: "DEPOSIT_UNDONE", fromStatus: p.status, toStatus: "AWAITING_DEPOSIT", amountCents: p.receivedCents, actorUserId: actor.id, note });
  });
}

async function changeStatus(actor: Actor, paymentId: string, from: string[], to: RtStatus, action: string, note: string) {
  return prisma.$transaction(async (tx) => {
    const p = await tx.refundTransferPayment.findUnique({ where: { id: paymentId } });
    if (!p || !from.includes(p.status)) throw new ValidationError("This can't be changed from its current status.");
    await tx.refundTransferPayment.update({ where: { id: paymentId }, data: { status: to } });
    await event(tx, { paymentId, action, fromStatus: p.status, toStatus: to, actorUserId: actor.id, note });
  });
}

/** Office tracker: every Pay From My Refund record for a tax year, with totals. */
export async function refundTransferBoard(actor: Actor, taxYear: number) {
  await assertOffice(actor, "billing", "view");
  const rows = await prisma.refundTransferPayment.findMany({
    where: { taxYear },
    include: { client: { select: { id: true, displayName: true, businessName: true } }, events: { orderBy: { createdAt: "desc" }, take: 5 } },
    orderBy: [{ updatedAt: "desc" }],
  });
  const sum = (s: string[], f: (r: (typeof rows)[number]) => number | null) => rows.filter((r) => s.includes(r.status)).reduce((t, r) => t + (f(r) ?? 0), 0);
  return {
    rows,
    totals: {
      pending: rows.filter((r) => r.status === "REQUESTED").length,
      awaitingCount: rows.filter((r) => r.status === "AWAITING_DEPOSIT").length,
      awaitingCents: sum(["AWAITING_DEPOSIT"], (r) => r.amountCents),
      receivedCents: sum(["RECEIVED", "SHORT"], (r) => r.receivedCents),
      followUpCount: rows.filter((r) => r.status === "SHORT" || r.status === "NOT_RECEIVED").length,
      followUpCents: sum(["SHORT"], (r) => (r.amountCents ?? 0) - (r.receivedCents ?? 0)) + sum(["NOT_RECEIVED"], (r) => r.amountCents),
    },
  };
}
