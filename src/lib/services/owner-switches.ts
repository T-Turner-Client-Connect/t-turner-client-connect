import "server-only";
import { prisma } from "@/lib/prisma";
import { audit } from "@/lib/audit";
import { ownerAudit } from "@/lib/auth/owner";
import { ForbiddenError, type Actor } from "@/lib/auth/actor";
import { isReportApprover } from "./bookkeeping-clients";

/**
 * Tabitha's own on/off switches for features that touch real financial data. Each one is a
 * database setting (default OFF), changed only by the primary owner, and every change is
 * written to both the office audit log and the Owner's Office log.
 */

export type OwnerSwitch = "liveBanking" | "coetha" | "coethaAutoSend" | "portalInvites" | "taxSummaryAutoSend";

export const SWITCH_LABEL: Record<OwnerSwitch, string> = { liveBanking: "Live bank connections", coetha: "Coetha AI", coethaAutoSend: "Coetha sends routine document requests automatically", portalInvites: "Portal invitations authorized", taxSummaryAutoSend: "Send tax summaries automatically" };
const LABEL = SWITCH_LABEL;
const ACTION: Record<OwnerSwitch, string> = { liveBanking: "banking.live_connections", coetha: "coetha.enabled", coethaAutoSend: "coetha.auto_send_requests", portalInvites: "portal_invites.authorized", taxSummaryAutoSend: "tax.summary_auto_send" };

export async function ownerSwitches() {
  const s = await prisma.integrationSettings.findUnique({ where: { id: "default" } });
  return {
    liveBanking: { on: s?.liveBankingEnabled ?? false, changedAt: s?.liveBankingChangedAt ?? null, changedById: s?.liveBankingChangedById ?? null },
    coetha: { on: s?.coethaEnabled ?? false, changedAt: s?.coethaChangedAt ?? null, changedById: s?.coethaChangedById ?? null },
    coethaAutoSend: { on: s?.coethaAutoSendRequests ?? true, changedAt: s?.coethaAutoSendChangedAt ?? null, changedById: s?.coethaAutoSendChangedById ?? null },
    portalInvites: { on: s?.portalInvitesAuthorized === true, changedAt: s?.portalInvitesChangedAt ?? null, changedById: s?.portalInvitesChangedById ?? null },
    taxSummaryAutoSend: { on: s?.taxSummaryAutoSend === true, changedAt: s?.taxSummaryAutoSendAt ?? null, changedById: s?.taxSummaryAutoSendById ?? null },
  };
}

export async function liveBankingOn(): Promise<boolean> {
  return (await prisma.integrationSettings.findUnique({ where: { id: "default" }, select: { liveBankingEnabled: true } }))?.liveBankingEnabled ?? false;
}

/** Tabitha's setting: Coetha's ROUTINE document requests go to clients without a staff click. On by default (her approval, PR #82); she can turn it off. */
export async function coethaAutoSendOn(): Promise<boolean> {
  return (await prisma.integrationSettings.findUnique({ where: { id: "default" }, select: { coethaAutoSendRequests: true } }))?.coethaAutoSendRequests ?? true;
}

/** Tabitha's safety lock on Prepared invitations: batches can be prepared and approved, but Send is refused until she authorizes it. Off by default. */
export async function portalInvitesAuthorized(): Promise<boolean> {
  return (await prisma.integrationSettings.findUnique({ where: { id: "default" }, select: { portalInvitesAuthorized: true } }))?.portalInvitesAuthorized === true;
}

/** Tabitha's switch "Send tax summaries automatically". Off by default (null or false). */
export async function taxSummaryAutoSendOn(): Promise<boolean> {
  return (await prisma.integrationSettings.findUnique({ where: { id: "default" }, select: { taxSummaryAutoSend: true } }))?.taxSummaryAutoSend === true;
}

export async function coethaOn(): Promise<boolean> {
  return (await prisma.integrationSettings.findUnique({ where: { id: "default" }, select: { coethaEnabled: true } }))?.coethaEnabled ?? false;
}

/** Only the primary owner (Tabitha) may flip these. Staff Admins and delegated owners cannot. */
export async function setOwnerSwitch(actor: Actor, which: OwnerSwitch, on: boolean) {
  if (!(await isReportApprover(actor))) throw new ForbiddenError(`Only Tabitha can turn ${LABEL[which]} on or off.`);
  const now = new Date();
  const data =
    which === "liveBanking"
      ? { liveBankingEnabled: on, liveBankingChangedById: actor.id, liveBankingChangedAt: now, updatedById: actor.id }
      : which === "coetha"
        ? { coethaEnabled: on, coethaChangedById: actor.id, coethaChangedAt: now, updatedById: actor.id }
        : which === "coethaAutoSend"
          ? { coethaAutoSendRequests: on, coethaAutoSendChangedById: actor.id, coethaAutoSendChangedAt: now, updatedById: actor.id }
          : which === "portalInvites"
            ? { portalInvitesAuthorized: on, portalInvitesChangedById: actor.id, portalInvitesChangedAt: now, updatedById: actor.id }
            : { taxSummaryAutoSend: on, taxSummaryAutoSendById: actor.id, taxSummaryAutoSendAt: now, updatedById: actor.id };
  const before = await ownerSwitches();
  await prisma.integrationSettings.upsert({ where: { id: "default" }, create: { id: "default", ...data }, update: data });
  const action = `${ACTION[which]}_${on ? "on" : "off"}`;
  const details = { switch: LABEL[which], from: before[which].on, to: on };
  await audit(prisma, { actorId: actor.id, action, entityType: "IntegrationSettings", entityId: "default", details });
  await ownerAudit(actor.id, action, "IntegrationSettings", "default", details);
}
