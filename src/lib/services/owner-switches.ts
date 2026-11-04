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

export type OwnerSwitch = "liveBanking" | "coetha" | "coethaAutoSend";

export const SWITCH_LABEL: Record<OwnerSwitch, string> = { liveBanking: "Live bank connections", coetha: "Coetha AI", coethaAutoSend: "Coetha sends document requests automatically" };
const LABEL = SWITCH_LABEL;

export async function ownerSwitches() {
  const s = await prisma.integrationSettings.findUnique({ where: { id: "default" } });
  return {
    liveBanking: { on: s?.liveBankingEnabled ?? false, changedAt: s?.liveBankingChangedAt ?? null, changedById: s?.liveBankingChangedById ?? null },
    coetha: { on: s?.coethaEnabled ?? false, changedAt: s?.coethaChangedAt ?? null, changedById: s?.coethaChangedById ?? null },
    coethaAutoSend: { on: s?.coethaAutoSendRequests ?? false, changedAt: s?.coethaAutoSendChangedAt ?? null, changedById: s?.coethaAutoSendChangedById ?? null },
  };
}

export async function liveBankingOn(): Promise<boolean> {
  return (await prisma.integrationSettings.findUnique({ where: { id: "default" }, select: { liveBankingEnabled: true } }))?.liveBankingEnabled ?? false;
}

/** Tabitha's setting: Coetha's drafted document requests go to clients without a staff click. Off by default. */
export async function coethaAutoSendOn(): Promise<boolean> {
  return (await prisma.integrationSettings.findUnique({ where: { id: "default" }, select: { coethaAutoSendRequests: true } }))?.coethaAutoSendRequests ?? false;
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
        : { coethaAutoSendRequests: on, coethaAutoSendChangedById: actor.id, coethaAutoSendChangedAt: now, updatedById: actor.id };
  const before = await ownerSwitches();
  await prisma.integrationSettings.upsert({ where: { id: "default" }, create: { id: "default", ...data }, update: data });
  const action = `${which === "liveBanking" ? "banking.live_connections" : which === "coetha" ? "coetha.enabled" : "coetha.auto_send_requests"}_${on ? "on" : "off"}`;
  const details = { switch: LABEL[which], from: before[which].on, to: on };
  await audit(prisma, { actorId: actor.id, action, entityType: "IntegrationSettings", entityId: "default", details });
  await ownerAudit(actor.id, action, "IntegrationSettings", "default", details);
}
