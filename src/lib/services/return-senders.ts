import "server-only";
import type { Actor } from "@/lib/auth/actor";

/**
 * Who may record a return as accepted and send it to the client's vault: any active staff member
 * (Staff or Admin) — the owner's decision (Nov 9, 2026). The delivery form itself prevents
 * mistakes: the tax year, form, jurisdiction and acceptance (date and submission reference) are
 * required, and the Form 8879 / summary gate still applies. Every send is audited with who sent
 * it. Changing, moving or removing a return the client can already see stays with Tabitha.
 * Signed-out and deactivated users never reach this (every action requires an active session).
 */
export async function canSendReturns(actor: Actor, _clientId: string): Promise<boolean> {
  return actor.role === "ADMIN" || actor.role === "STAFF";
}

export const NOT_RETURN_SENDER = "Only office staff can send a tax return to the client.";
