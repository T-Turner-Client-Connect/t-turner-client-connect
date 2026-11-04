import "server-only";
import { ForbiddenError, type Actor } from "@/lib/auth/actor";
import { canUseLedger } from "./ledger";
import { isReportApprover } from "./bookkeeping-clients";

/**
 * Small permission helpers for the bookkeeping workflow and Banking & Reconciliation.
 * Kept in one place so they can be rewired to the staff-permissions model
 * (`can(actor, "banking", "manage")` etc.) once that lands, without touching callers.
 *
 * Today:
 * - managing accounts and bank connections, preparing reconciliations and sending client
 *   requests: Admins and the staff member assigned to the business (the ledger rule);
 * - approving reconciliations, statements, Coetha's work and the tax classification: Tabitha only.
 */

export async function canManageBanking(actor: Actor, clientId: string) {
  return canUseLedger(actor, clientId);
}
export async function assertCanManageBanking(actor: Actor, clientId: string) {
  if (!(await canManageBanking(actor, clientId))) throw new ForbiddenError("Only Admins and the staff member assigned to this business can manage its bank and card accounts.");
}

export async function canSendClientRequests(actor: Actor, clientId: string) {
  return canUseLedger(actor, clientId);
}
export async function assertCanSendClientRequests(actor: Actor, clientId: string) {
  if (!(await canSendClientRequests(actor, clientId))) throw new ForbiddenError("Only Admins and the staff member assigned to this business can send it document requests.");
}

/** Finalized work (reconciliations, statements, tax classification): Tabitha only. */
export async function assertTabithaApproves(actor: Actor, what: string) {
  if (!(await isReportApprover(actor))) throw new ForbiddenError(`Only Tabitha can approve ${what}.`);
}
