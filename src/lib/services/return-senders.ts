import "server-only";
import type { Actor } from "@/lib/auth/actor";
import { isReportApprover } from "./bookkeeping-clients";
import { canEditTaxPrep } from "./tax-prep";

/**
 * Who may record a return as accepted and send it to the client: Tabitha, an Admin, the client's
 * assigned staff member, or the staff member assigned to one of the client's tax services (the
 * same people who prepare the client's return). Every send is audited with who sent it.
 * Changing, moving or removing a return the client can already see stays with Tabitha.
 */
export async function canSendReturns(actor: Actor, clientId: string): Promise<boolean> {
  if (await isReportApprover(actor)) return true;
  return canEditTaxPrep(actor, clientId);
}

export const NOT_RETURN_SENDER = "Only Tabitha, an Admin or the staff member assigned to this client can send its tax return. Ask Tabitha to assign you to the client (or its tax service).";
