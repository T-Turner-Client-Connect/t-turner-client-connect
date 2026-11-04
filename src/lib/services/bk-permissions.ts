import "server-only";
import { ForbiddenError, type Actor } from "@/lib/auth/actor";
import { canApproveCoethaWork } from "@/lib/auth/permissions";
import { canUseLedger } from "./ledger";

/**
 * Permission helpers for the bookkeeping workflow and Banking & Reconciliation, on top of Staff
 * Access & Permissions (src/lib/auth/permissions.ts):
 * - viewing a business's banking: Admins, the assigned staff member, or "Banking and reconciliation → View";
 * - managing accounts and bank connections, preparing reconciliations, sending client requests:
 *   Admins, the assigned staff member, or "Banking and reconciliation → Edit";
 * - approving reconciliations, Coetha's work and the tax classification: Tabitha only
 *   (canApproveCoethaWork — never grantable).
 */

export async function canViewBanking(actor: Actor, clientId: string) {
  return canUseLedger(actor, clientId, "banking", "view");
}
export async function assertCanViewBanking(actor: Actor, clientId: string) {
  if (!(await canViewBanking(actor, clientId))) throw new ForbiddenError("Only Admins, the staff member assigned to this business and staff Tabitha allows can see its banking.");
}

export async function canManageBanking(actor: Actor, clientId: string) {
  return canUseLedger(actor, clientId, "banking", "edit");
}
export async function assertCanManageBanking(actor: Actor, clientId: string) {
  if (!(await canManageBanking(actor, clientId))) throw new ForbiddenError("Only Admins, the staff member assigned to this business and staff Tabitha allows can manage its bank and card accounts.");
}

export async function canSendClientRequests(actor: Actor, clientId: string) {
  return canManageBanking(actor, clientId);
}
export async function assertCanSendClientRequests(actor: Actor, clientId: string) {
  if (!(await canSendClientRequests(actor, clientId))) throw new ForbiddenError("Only Admins, the staff member assigned to this business and staff Tabitha allows can send it document requests.");
}

/** Finalized work (reconciliations, statements, tax classification): Tabitha only. */
export async function assertTabithaApproves(actor: Actor, what: string) {
  if (!(await canApproveCoethaWork(actor))) throw new ForbiddenError(`Only Tabitha can approve ${what}.`);
}
