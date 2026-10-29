import "server-only";
import { Prisma, type AutomationKind } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { audit } from "@/lib/audit";
import { assertAdmin, type Actor } from "@/lib/auth/actor";
import { ValidationError } from "./clients";
import { dispatchPendingNotifications, queuePortalNotification } from "./notifications";
import { markDueManualTargets } from "./social";

export const AUTOMATION_TEMPLATES: Record<AutomationKind, { name: string; offsetDays: number; repeatEveryDays: number | null; maxReminders: number; describe: string }> = {
  MISSING_DOCUMENT_REMINDER: {
    name: "Missing-document reminders",
    offsetDays: -3,
    repeatEveryDays: 4,
    maxReminders: 3,
    describe: "Reminds clients about open document requests, starting before the due date.",
  },
  APPOINTMENT_REMINDER: {
    name: "Appointment reminders",
    offsetDays: -1,
    repeatEveryDays: null,
    maxReminders: 1,
    describe: "One reminder before each scheduled appointment.",
  },
  CONTRACT_FOLLOW_UP: {
    name: "Outstanding-contract follow-ups",
    offsetDays: 3,
    repeatEveryDays: 5,
    maxReminders: 3,
    describe: "Follows up on assigned contracts that haven't been completed.",
  },
};

/** Creates the three templates (paused) if they don't exist yet. */
export async function ensureAutomationRules() {
  for (const [kind, t] of Object.entries(AUTOMATION_TEMPLATES) as [AutomationKind, (typeof AUTOMATION_TEMPLATES)[AutomationKind]][]) {
    await prisma.automationRule.upsert({
      where: { kind },
      update: {},
      create: { kind, name: t.name, enabled: false, offsetDays: t.offsetDays, repeatEveryDays: t.repeatEveryDays, maxReminders: t.maxReminders },
    });
  }
}

export async function updateRule(actor: Actor, ruleId: string, input: { enabled: boolean; offsetDays: number; repeatEveryDays: number | null; maxReminders: number }) {
  assertAdmin(actor);
  if (!Number.isInteger(input.offsetDays) || Math.abs(input.offsetDays) > 60) throw new ValidationError("Timing must be within 60 days.");
  if (input.repeatEveryDays !== null && (input.repeatEveryDays < 1 || input.repeatEveryDays > 60)) throw new ValidationError("Repeat every 1–60 days, or leave blank.");
  if (input.maxReminders < 1 || input.maxReminders > 10) throw new ValidationError("Send 1–10 reminders at most.");
  await prisma.automationRule.update({ where: { id: ruleId }, data: { ...input, updatedById: actor.id } });
  await audit(prisma, { actorId: actor.id, action: input.enabled ? "automation.enabled" : "automation.paused", entityType: "AutomationRule", entityId: ruleId, details: input });
}

/** Stops all future reminders for one item (e.g. a request handled by phone). */
export async function cancelReminders(actor: Actor, ruleId: string, targetKey: string, clientId?: string | null) {
  await prisma.automationRun.upsert({
    where: { dedupeKey: `${ruleId}:${targetKey}:stop` },
    update: {},
    create: { ruleId, targetKey, clientId: clientId ?? null, dedupeKey: `${ruleId}:${targetKey}:stop`, outcome: "CANCELLED" },
  });
  await audit(prisma, { actorId: actor.id, action: "automation.cancelled_for_item", entityType: "AutomationRule", entityId: ruleId, clientId: clientId ?? null, details: { targetKey } });
}

const DAY = 24 * 60 * 60 * 1000;

type Target = { key: string; clientId: string; anchor: Date; kind: string };

async function targetsFor(kind: AutomationKind, now: Date): Promise<Target[]> {
  if (kind === "MISSING_DOCUMENT_REMINDER") {
    const reqs = await prisma.documentRequest.findMany({ where: { status: "OPEN", dueAt: { not: null }, client: { archivedAt: null } }, select: { id: true, clientId: true, dueAt: true } });
    return reqs.map((r) => ({ key: `request:${r.id}`, clientId: r.clientId, anchor: r.dueAt!, kind: "DOCUMENT_REQUEST" }));
  }
  if (kind === "APPOINTMENT_REMINDER") {
    const appts = await prisma.appointment.findMany({ where: { cancelledAt: null, startsAt: { gt: now }, client: { archivedAt: null } }, select: { id: true, clientId: true, startsAt: true } });
    return appts.map((a) => ({ key: `appointment:${a.id}`, clientId: a.clientId, anchor: a.startsAt, kind: "APPOINTMENT_REMINDER" }));
  }
  const contracts = await prisma.contractAssignment.findMany({ where: { status: "ASSIGNED", client: { archivedAt: null } }, select: { id: true, clientId: true, createdAt: true } });
  return contracts.map((c) => ({ key: `contract:${c.id}`, clientId: c.clientId, anchor: c.createdAt, kind: "CONTRACT_ASSIGNED" }));
}

/**
 * One pass of every enabled rule. Each reminder has a unique dedupe key
 * (rule + item + reminder number), so overlapping or retried runs can't send
 * twice. Conditions are re-checked at run time; paused rules do nothing.
 */
export async function runAutomations(now = new Date()) {
  await ensureAutomationRules();
  const rules = await prisma.automationRule.findMany({ where: { enabled: true } });
  const summary: Record<string, number> = {};
  for (const rule of rules) {
    let queued = 0;
    for (const t of await targetsFor(rule.kind, now)) {
      const prior = await prisma.automationRun.findMany({ where: { ruleId: rule.id, targetKey: t.key }, select: { dedupeKey: true, outcome: true } });
      if (prior.some((p) => p.outcome === "CANCELLED")) continue;
      const sent = prior.filter((p) => !p.dedupeKey.endsWith(":stop")).length;
      if (sent >= rule.maxReminders) continue;
      if (sent > 0 && !rule.repeatEveryDays) continue;
      const dueAt = new Date(t.anchor.getTime() + rule.offsetDays * DAY + sent * (rule.repeatEveryDays ?? 0) * DAY);
      if (now < dueAt) continue;
      const grants = await prisma.portalAccess.findMany({ where: { clientId: t.clientId, revokedAt: null, portalUser: { active: true } } });
      const dedupeKey = `${rule.id}:${t.key}:${sent}`;
      try {
        await prisma.automationRun.create({
          data: { ruleId: rule.id, targetKey: t.key, clientId: t.clientId, dedupeKey, outcome: grants.length ? "QUEUED" : "SKIPPED:no portal login" },
        });
      } catch (err) {
        // Another run already claimed this reminder.
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") continue;
        throw err;
      }
      for (const g of grants) await queuePortalNotification(g.portalUserId, t.kind, `auto:${dedupeKey}`);
      if (grants.length) queued++;
    }
    summary[rule.kind] = queued;
  }
  summary.SOCIAL_DUE_FOR_MANUAL_POSTING = await markDueManualTargets(now);
  await dispatchPendingNotifications();
  return summary;
}
