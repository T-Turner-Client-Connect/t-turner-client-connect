import "server-only";
import type { DocumentCategory, PeriodStatus, RequestStatus } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { audit } from "@/lib/audit";
import { assertAdmin, type Actor } from "@/lib/auth/actor";
import { ValidationError } from "./clients";
import { notifyClientUsers } from "./documents";

export const PERIOD_LABELS: Record<PeriodStatus, string> = {
  AWAITING_DOCUMENTS: "Awaiting documents",
  IN_PROGRESS: "In progress",
  READY_FOR_REVIEW: "Ready for review",
  COMPLETE: "Complete",
};

export const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

export async function openPeriod(actor: Actor, clientId: string, year: number, month: number) {
  if (!Number.isInteger(year) || year < 2000 || year > 2100 || month < 1 || month > 12) throw new ValidationError("Choose a valid month and year.");
  const period = await prisma.bookkeepingPeriod.upsert({
    where: { clientId_year_month: { clientId, year, month } },
    update: {},
    create: { clientId, year, month, updatedById: actor.id },
  });
  await audit(prisma, { actorId: actor.id, action: "bookkeeping.period_opened", entityType: "BookkeepingPeriod", entityId: period.id, clientId });
  return period;
}

export async function setPeriodStatus(actor: Actor, periodId: string, status: PeriodStatus, staffNote?: string) {
  // Telling the client a month is ready (or complete) requires every report in it to be approved and delivered.
  if (status === "READY_FOR_REVIEW" || status === "COMPLETE") {
    const pending = await prisma.document.count({ where: { periodId, deletedAt: null, category: "BOOKKEEPING", reportType: { not: null }, visibility: "STAFF_ONLY" } });
    if (pending) throw new ValidationError("Some reports for this month haven't been approved and delivered yet.");
  }
  const period = await prisma.bookkeepingPeriod.update({ where: { id: periodId }, data: { status, staffNote: staffNote?.trim() || undefined, updatedById: actor.id } });
  await audit(prisma, { actorId: actor.id, action: "bookkeeping.status_changed", entityType: "BookkeepingPeriod", entityId: periodId, clientId: period.clientId, details: { status } });
  if (status === "READY_FOR_REVIEW" || status === "COMPLETE") await notifyClientUsers(period.clientId, "ACCOUNT_UPDATE", `period:${periodId}:${status}`, "BOOKKEEPING");
  return period;
}

export async function createDocumentRequest(
  actor: Actor,
  input: { clientId: string; title: string; instructions?: string; dueAt?: Date | null; remindAt?: Date | null; periodId?: string | null; category?: DocumentCategory },
) {
  if (!input.title.trim()) throw new ValidationError("Say what you need.");
  if (input.periodId && !(await prisma.bookkeepingPeriod.count({ where: { id: input.periodId, clientId: input.clientId } }))) throw new ValidationError("Month not found.");
  const req = await prisma.documentRequest.create({
    data: {
      clientId: input.clientId,
      title: input.title.trim().slice(0, 200),
      instructions: input.instructions?.trim() || null,
      dueAt: input.dueAt ?? null,
      remindAt: input.remindAt ?? null,
      periodId: input.periodId ?? null,
      category: input.category ?? "CLIENT_UPLOADS",
      createdById: actor.id,
    },
  });
  await audit(prisma, { actorId: actor.id, action: "request.created", entityType: "DocumentRequest", entityId: req.id, clientId: input.clientId });
  await notifyClientUsers(input.clientId, "DOCUMENT_REQUEST", `request:${req.id}`);
  return req;
}

export async function setRequestStatus(actor: Actor, requestId: string, status: RequestStatus) {
  const req = await prisma.documentRequest.update({ where: { id: requestId }, data: { status } });
  await audit(prisma, { actorId: actor.id, action: "request.status_changed", entityType: "DocumentRequest", entityId: requestId, clientId: req.clientId, details: { status } });
}

// --- Updates, announcements, deadlines -----------------------------------

export async function postClientUpdate(actor: Actor, clientId: string, title: string, body: string) {
  if (!title.trim() || !body.trim()) throw new ValidationError("Add a title and a message.");
  const a = await prisma.announcement.create({ data: { clientId, title: title.trim().slice(0, 200), body: body.trim().slice(0, 5000), publishedAt: new Date(), createdById: actor.id } });
  await audit(prisma, { actorId: actor.id, action: "update.posted", entityType: "Announcement", entityId: a.id, clientId });
  await notifyClientUsers(clientId, "ACCOUNT_UPDATE", `update:${a.id}`);
  return a;
}

/**
 * Announcements appear on the portal dashboards of clients in the chosen
 * groups. They don't trigger texts or emails, so they can't become
 * promotional messages sent without marketing permission.
 */
export async function publishAnnouncement(actor: Actor, input: { title: string; body: string; groupIds: string[]; expiresAt?: Date | null }) {
  assertAdmin(actor);
  if (!input.title.trim() || !input.body.trim()) throw new ValidationError("Add a title and a message.");
  if (!input.groupIds.length) throw new ValidationError("Choose at least one group.");
  const a = await prisma.announcement.create({
    data: {
      title: input.title.trim().slice(0, 200),
      body: input.body.trim().slice(0, 5000),
      publishedAt: new Date(),
      expiresAt: input.expiresAt ?? null,
      createdById: actor.id,
      groups: { create: input.groupIds.map((groupId) => ({ groupId })) },
    },
  });
  await audit(prisma, { actorId: actor.id, action: "announcement.published", entityType: "Announcement", entityId: a.id, details: { groups: input.groupIds.length } });
  return a;
}

export async function addDeadline(actor: Actor, clientId: string, title: string, dueAt: Date | null, visibleToClient: boolean) {
  if (!title.trim() || !dueAt) throw new ValidationError("Add a title and a date.");
  const d = await prisma.clientDeadline.create({ data: { clientId, title: title.trim().slice(0, 200), dueAt, visibleToClient, createdById: actor.id } });
  await audit(prisma, { actorId: actor.id, action: "deadline.added", entityType: "ClientDeadline", entityId: d.id, clientId });
  return d;
}

export function announcementsFor(clientIds: string[], now = new Date()) {
  return prisma.announcement.findMany({
    where: {
      publishedAt: { lte: now },
      OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
      AND: [{ OR: [{ clientId: { in: clientIds } }, { groups: { some: { group: { clients: { some: { clientId: { in: clientIds } } } } } } }] }],
    },
    orderBy: { publishedAt: "desc" },
    take: 20,
  });
}
