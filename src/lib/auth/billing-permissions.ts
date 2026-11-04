import "server-only";
import { ForbiddenError, type Actor } from "./actor";
import { ownerAccessFor } from "./owner";

/**
 * Who may do what with firm invoices and Square. Every billing server function routes its check
 * through these helpers, so the staff-permission matrix (built on another branch) can rewire them
 * in one place.
 *
 * For now: the owner, or staff the owner gave delegated billing access (OwnerAccess, scope
 * BILLING), may send invoices, record payments and reconcile Square payments. Billing settings —
 * including the "Send invoices through Square" switch — are the primary owner's alone. Refunds,
 * credits and voids stay with the owner's full access (canRefundOrVoid).
 */
async function access(actor: Actor) {
  return ownerAccessFor(actor.id);
}

export async function canSendInvoices(actor: Actor) {
  return !!(await access(actor));
}

export async function canRecordPayments(actor: Actor) {
  return !!(await access(actor));
}

export async function canReconcile(actor: Actor) {
  return !!(await access(actor));
}

/** Owner only: the primary owner with full access. */
export async function canChangeBillingSettings(actor: Actor) {
  const a = await access(actor);
  return !!(a && a.isPrimary && a.scope === "FULL");
}

/** Refunds, credits (adjustments) and voids: the owner's full access. */
export async function canRefundOrVoid(actor: Actor) {
  return (await access(actor))?.scope === "FULL";
}

const guard = (check: (a: Actor) => Promise<boolean>, message: string) => async (actor: Actor) => {
  if (!(await check(actor))) throw new ForbiddenError(message);
};

export const assertCanSendInvoices = guard(canSendInvoices, "Only the owner or staff with billing access can send invoices.");
export const assertCanRecordPayments = guard(canRecordPayments, "Only the owner or staff with billing access can record payments.");
export const assertCanReconcile = guard(canReconcile, "Only the owner or staff with billing access can reconcile Square payments.");
export const assertCanChangeBillingSettings = guard(canChangeBillingSettings, "Only Tabitha can change billing settings.");
export const assertCanRefundOrVoid = guard(canRefundOrVoid, "Only the owner can record refunds, apply credits or void invoices.");
