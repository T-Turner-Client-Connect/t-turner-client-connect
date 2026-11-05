import "server-only";
import type { CoethaOptOut } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { audit } from "@/lib/audit";
import { ForbiddenError, type Actor } from "@/lib/auth/actor";
import { ValidationError } from "./clients";
import { canUseLedger } from "./ledger";

/**
 * "Client prefers no Coetha". When a client tells the office (by phone, email, a portal message
 * or in person) that they'd rather their books were prepared without Coetha, staff record it
 * here. While it is set, every Coetha run (manual and daily), every draft and every document
 * request Coetha would generate for that client is refused with COETHA_OPTED_OUT; the office
 * keeps doing the bookkeeping by hand. Clearing it restores Coetha. Both are audit-logged.
 *
 * This is a per-client preference only. It never changes Coetha's owner switch or API key
 * requirement, and nothing here asks clients to authorize Coetha.
 */

export const OPT_OUT_VIA = { PHONE: "Phone", EMAIL: "Email", PORTAL_MESSAGE: "Portal message", IN_PERSON: "In person" } as const;
export type OptOutVia = keyof typeof OPT_OUT_VIA;

export const COETHA_OPTED_OUT =
  "This client prefers no Coetha, so Coetha won't run, prepare drafts or request documents for them. Their books are prepared by our team without Coetha. To change this, clear “Client prefers no Coetha” on their bookkeeping dashboard.";

export function coethaOptOutOf(clientId: string) {
  return prisma.coethaOptOut.findUnique({ where: { clientId } });
}

/** Throws COETHA_OPTED_OUT when the client prefers no Coetha. Every Coetha entry point calls it. */
export async function assertCoethaAllowed(clientId: string): Promise<void> {
  if (await prisma.coethaOptOut.count({ where: { clientId } })) throw new ValidationError(COETHA_OPTED_OUT);
}

/** Clients who prefer no Coetha (for the daily runs and the bookkeeping list badge). */
export async function optedOutClientIds(): Promise<Set<string>> {
  return new Set((await prisma.coethaOptOut.findMany({ select: { clientId: true } })).map((r) => r.clientId));
}

/** Staff who can edit this client's books: Admins, the assigned staff member, or General ledger → Edit. */
export async function canSetCoethaOptOut(actor: Actor, clientId: string) {
  return canUseLedger(actor, clientId, "ledger", "edit");
}
async function assertCanSet(actor: Actor, clientId: string) {
  if (!(await canSetCoethaOptOut(actor, clientId))) throw new ForbiddenError("Only Admins, the staff member assigned to this client and staff Tabitha allows to edit books can record this.");
}

const ymd = /^(\d{4})-(\d{2})-(\d{2})$/;

export async function setCoethaOptOut(actor: Actor, clientId: string, input: { toldOn: string; via: string; note?: string | null }): Promise<CoethaOptOut> {
  await assertCanSet(actor, clientId);
  const m = ymd.exec(input.toldOn ?? "");
  const toldOn = m ? new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))) : null;
  if (!toldOn || Number.isNaN(toldOn.getTime())) throw new ValidationError("Enter the date the client told us.");
  if (toldOn.getTime() > Date.now() + 36 * 3600_000) throw new ValidationError("The date can't be in the future.");
  if (!(input.via in OPT_OUT_VIA)) throw new ValidationError("Choose how the client told us.");
  const note = input.note?.trim().slice(0, 1000) || null;
  const client = await prisma.client.findUnique({ where: { id: clientId }, select: { id: true } });
  if (!client) throw new ValidationError("Client not found.");
  return prisma.$transaction(async (tx) => {
    const before = await tx.coethaOptOut.findUnique({ where: { clientId } });
    const row = await tx.coethaOptOut.upsert({
      where: { clientId },
      create: { clientId, toldOn, via: input.via, note, recordedById: actor.id },
      update: { toldOn, via: input.via, note, recordedById: actor.id },
    });
    await audit(tx, { actorId: actor.id, action: before ? "coetha.opt_out_updated" : "coetha.opt_out_set", entityType: "Client", entityId: clientId, clientId, details: { toldOn: input.toldOn, via: input.via, note: !!note } });
    return row;
  });
}

export async function clearCoethaOptOut(actor: Actor, clientId: string): Promise<void> {
  await assertCanSet(actor, clientId);
  await prisma.$transaction(async (tx) => {
    const r = await tx.coethaOptOut.deleteMany({ where: { clientId } });
    if (!r.count) throw new ValidationError("This client isn't marked as preferring no Coetha.");
    await audit(tx, { actorId: actor.id, action: "coetha.opt_out_cleared", entityType: "Client", entityId: clientId, clientId });
  });
}

/** For the dashboard: the preference with the name of who recorded it. */
export async function coethaOptOutView(clientId: string) {
  const row = await coethaOptOutOf(clientId);
  if (!row) return null;
  const by = await prisma.user.findUnique({ where: { id: row.recordedById }, select: { name: true } });
  return { ...row, recordedByName: by?.name ?? "Staff", viaLabel: OPT_OUT_VIA[row.via as OptOutVia] ?? row.via };
}
