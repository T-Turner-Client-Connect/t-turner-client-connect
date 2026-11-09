import "server-only";
import type { Actor } from "@/lib/auth/actor";
import { can } from "@/lib/auth/permissions";
import { isReportApprover } from "./bookkeeping-clients";
import { canEditTaxPrep } from "./tax-prep";

/**
 * Who may record a return as accepted and send it straight to the client's vault (owner's
 * decision, Nov 9, 2026), without waiting for Tabitha:
 *  - Tabitha and Admins;
 *  - the client's assigned staff member, or the staff member assigned to one of the client's
 *    tax services;
 *  - staff Tabitha granted the office-wide permission "Tax → All clients" (only she can grant it).
 * Anyone else's upload waits for one of these to send it. The delivery form requires the tax year,
 * form, jurisdiction and acceptance details; the Form 8879 / summary gate applies to every sender
 * and is recorded on the filing's history; every send is audited with who sent it. Changing,
 * moving or removing a return the client can already see stays Tabitha's alone.
 */
export async function canSendReturns(actor: Actor, clientId: string): Promise<boolean> {
  if (actor.role === "ADMIN" || (await isReportApprover(actor))) return true;
  if (await can(actor, "tax", "all_clients")) return true;
  return canEditTaxPrep(actor, clientId);
}

export const NOT_RETURN_SENDER = "Only Tabitha, an Admin, the staff member assigned to this client, or staff with Tax → All clients can send its tax return. It's saved; one of them can send it.";

/** Why this person may send (recorded on every delivery's audit entry). */
export async function senderBasis(actor: Actor, clientId: string): Promise<"OWNER" | "ADMIN" | "TAX_ALL_CLIENTS" | "ASSIGNED" | "NONE"> {
  if (await isReportApprover(actor)) return "OWNER";
  if (actor.role === "ADMIN") return "ADMIN";
  if (await canEditTaxPrep(actor, clientId)) return "ASSIGNED";
  if (await can(actor, "tax", "all_clients")) return "TAX_ALL_CLIENTS";
  return "NONE";
}
