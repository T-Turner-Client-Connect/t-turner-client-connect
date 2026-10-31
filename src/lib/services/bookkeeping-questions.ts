import "server-only";
import { prisma } from "@/lib/prisma";
import { audit } from "@/lib/audit";
import type { Actor } from "@/lib/auth/actor";
import { isFutureDay, chicagoToday } from "@/lib/dates";
import { ValidationError } from "./clients";
import { staffSendMessage } from "./messaging";
import { openWorkPeriod, workMonth } from "./bookkeeping-clients";

/**
 * Questions staff ask about a client's bookkeeping month. Each is a secure
 * portal conversation tied to the month, with a response due date and a
 * status: OPEN (waiting on the client) → ANSWERED (client replied; staff to
 * review) → RESOLVED. A client's reply never resolves it by itself.
 */
export const QUESTION_STATUS = {
  OPEN: { label: "Waiting on client", tone: "amber" },
  ANSWERED: { label: "Answered — staff review needed", tone: "gold" },
  RESOLVED: { label: "Resolved", tone: "green" },
} as const;

const ymd = (s: string) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  return m ? new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 23, 59)) : null;
};

export async function askClientQuestion(actor: Actor, clientId: string, periodId: string, input: { subject: string; body: string; dueOn?: string }) {
  const period = await prisma.bookkeepingPeriod.findFirst({ where: { id: periodId, clientId } });
  if (!period) throw new ValidationError("Month not found.");
  if (!input.subject.trim()) throw new ValidationError("Give the question a short subject (for example, “$1,240 deposit on March 4”).");
  if (!input.body.trim()) throw new ValidationError("Write the question.");
  let responseDueAt: Date | null = null;
  if (input.dueOn) {
    responseDueAt = ymd(input.dueOn);
    if (!responseDueAt) throw new ValidationError("Enter a valid response date.");
    if (input.dueOn < chicagoToday()) throw new ValidationError("The response date can't be in the past.");
  }
  const msg = await staffSendMessage(actor, { clientId, subject: input.subject, body: input.body, channel: "PORTAL", periodId });
  await prisma.conversation.update({ where: { id: msg.conversationId }, data: { questionStatus: "OPEN", responseDueAt, askedById: actor.id } });
  await audit(prisma, { actorId: actor.id, action: "bookkeeping.question_asked", entityType: "Conversation", entityId: msg.conversationId, clientId, details: { periodId, responseDueAt: responseDueAt?.toISOString() ?? null } });
  return msg.conversationId;
}

export async function resolveQuestion(actor: Actor, clientId: string, conversationId: string) {
  const c = await prisma.conversation.findFirst({ where: { id: conversationId, clientId, questionStatus: { not: null } } });
  if (!c) throw new ValidationError("Question not found.");
  if (c.questionStatus === "RESOLVED") return;
  await prisma.conversation.update({ where: { id: c.id }, data: { questionStatus: "RESOLVED", resolvedAt: new Date(), resolvedById: actor.id, awaitingStaff: false } });
  await audit(prisma, { actorId: actor.id, action: "bookkeeping.question_resolved", entityType: "Conversation", entityId: c.id, clientId });
}

/**
 * Called when the client replies in the portal: an open question becomes
 * "answered" and the client's assigned staff member (or whoever asked) gets a task.
 */
export async function onClientReply(conversationId: string) {
  const c = await prisma.conversation.findUnique({ where: { id: conversationId }, include: { client: { select: { displayName: true, assignedToId: true } } } });
  if (!c || c.questionStatus !== "OPEN") return;
  await prisma.conversation.update({ where: { id: c.id }, data: { questionStatus: "ANSWERED" } });
  const assignee = c.client.assignedToId ?? c.askedById;
  const creator = c.askedById ?? assignee;
  if (creator) {
    await prisma.task.create({
      data: { title: `${c.client.displayName} answered: ${c.subject}`, details: "The client replied in the portal. Review the answer, then mark the question resolved in the bookkeeping workspace.", clientId: c.clientId, assigneeId: assignee, createdById: creator, priority: "NORMAL" },
    });
  }
  await prisma.auditLog.create({ data: { action: "bookkeeping.question_answered", entityType: "Conversation", entityId: c.id, clientId: c.clientId } });
}

/** A revised completion estimate, recorded beside the original target (never replacing it). */
export async function reviseTarget(actor: Actor, clientId: string, periodId: string, input: { targetOn: string; reason: string }) {
  const period = await prisma.bookkeepingPeriod.findFirst({ where: { id: periodId, clientId } });
  if (!period) throw new ValidationError("Month not found.");
  const d = ymd(input.targetOn);
  if (!d) throw new ValidationError("Enter the revised date.");
  if (!isFutureDay(input.targetOn) && input.targetOn !== chicagoToday()) throw new ValidationError("A revised estimate should be today or later.");
  if (input.reason.trim().length < 5) throw new ValidationError("Say why the estimate changed (for example, “waiting on March bank statement”).");
  const r = await prisma.periodTargetRevision.create({ data: { periodId, targetOn: d, reason: input.reason.trim().slice(0, 300), createdById: actor.id } });
  await audit(prisma, { actorId: actor.id, action: "bookkeeping.target_revised", entityType: "BookkeepingPeriod", entityId: periodId, clientId, details: { targetOn: input.targetOn, reason: r.reason } });
  return r;
}

/**
 * Opens the work month for every active bookkeeping client on (or after) the
 * 1st, Chicago time. Runs from the 10-minute schedule; does its work once a month.
 */
export async function autoOpenWorkMonth(now = new Date()) {
  const { year, month } = workMonth("MONTHLY", now);
  const key = `${year}-${String(month).padStart(2, "0")}`;
  const beat = await prisma.systemHeartbeat.findUnique({ where: { key: "periods-opened" } });
  if ((beat?.detail as { month?: string } | null)?.month === key) return { opened: 0, month: key, skipped: true };
  const owner = await prisma.ownerAccess.findFirst({ where: { isPrimary: true, revokedAt: null }, select: { userId: true } });
  const actorId = owner?.userId ?? (await prisma.user.findFirst({ where: { role: "ADMIN", active: true }, orderBy: { createdAt: "asc" }, select: { id: true } }))?.id;
  if (!actorId) return { opened: 0, month: key, skipped: true };
  const actor = (await prisma.user.findUniqueOrThrow({ where: { id: actorId } })) as unknown as Actor;
  const profiles = await prisma.bookkeepingProfile.findMany({ where: { active: true, client: { archivedAt: null } }, select: { clientId: true } });
  let opened = 0;
  for (const p of profiles) {
    if (!(await prisma.bookkeepingPeriod.count({ where: { clientId: p.clientId, year, month } }))) opened++;
    await openWorkPeriod(actor, p.clientId, year, month);
  }
  await prisma.systemHeartbeat.upsert({ where: { key: "periods-opened" }, create: { key: "periods-opened", at: new Date(), detail: { month: key, opened } }, update: { at: new Date(), detail: { month: key, opened } } });
  return { opened, month: key, skipped: false };
}
