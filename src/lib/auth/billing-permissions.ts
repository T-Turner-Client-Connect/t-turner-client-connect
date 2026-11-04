import "server-only";
import { ForbiddenError, type Actor } from "./actor";
import { can } from "./permissions";

/**
 * Who may do what with firm invoices and Square, routed through Staff Access & Permissions
 * (src/lib/permissions.ts). Every call reads the database; the primary owner always passes.
 *
 * - Send invoices (approve and send, through Square or the portal) → Billing → Send
 * - Record verified payments                                        → Billing → Record payments
 * - Reconcile Square / other payment records (Reconcile Square tab)  → Accounts receivable → Reconcile
 * - Billing settings                                                  → Billing → Change billing settings
 * - "Send invoices through Square", Square delivery options, pasted Square links
 *                                                                     → Square → Change integrations
 * - Refunds → Billing → Refund; credits → Billing → Credits & waivers; voids → Billing → Void
 * Nobody holds any of these by default except the owner.
 */

export const canSendInvoices = (actor: Actor) => can(actor, "billing", "send");
export const canRecordPayments = (actor: Actor) => can(actor, "billing", "record_payment");
export const canReconcile = (actor: Actor) => can(actor, "receivables", "reconcile");
export const canChangeBillingSettings = (actor: Actor) => can(actor, "billing", "settings");
export const canChangePaymentIntegrations = (actor: Actor) => can(actor, "square", "integrations");
export const canRefund = (actor: Actor) => can(actor, "billing", "refund");
export const canApplyCredits = (actor: Actor) => can(actor, "billing", "adjust");
export const canVoid = (actor: Actor) => can(actor, "billing", "void");

const guard = (check: (a: Actor) => Promise<boolean>, message: string) => async (actor: Actor) => {
  if (!(await check(actor))) throw new ForbiddenError(message);
};

export const assertCanSendInvoices = guard(canSendInvoices, "Sending invoices needs the owner's permission (Billing → Send).");
export const assertCanRecordPayments = guard(canRecordPayments, "Recording payments needs the owner's permission (Billing → Record payments).");
export const assertCanReconcile = guard(canReconcile, "Reconciling payments needs the owner's permission (Accounts receivable → Reconcile).");
export const assertCanChangeBillingSettings = guard(canChangeBillingSettings, "Only Tabitha (or staff she allows) can change billing settings.");
export const assertCanChangePaymentIntegrations = guard(canChangePaymentIntegrations, "Only Tabitha (or staff she allows) can change payment integrations.");
export const assertCanRefund = guard(canRefund, "Only Tabitha (or staff she allows) can record refunds.");
export const assertCanApplyCredits = guard(canApplyCredits, "Only Tabitha (or staff she allows) can apply credits.");
export const assertCanVoid = guard(canVoid, "Only Tabitha (or staff she allows) can void invoices.");
