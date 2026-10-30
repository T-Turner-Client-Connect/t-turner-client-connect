import "server-only";
import { prisma } from "@/lib/prisma";
import { audit } from "@/lib/audit";
import { assertAdmin, type Actor } from "@/lib/auth/actor";
import { isStateCode, stateName } from "@/lib/resources/catalog";
import { buildCountdowns, isDeadlineKind, officeToday, suggestedDates, type ClientProfile } from "@/lib/tax/deadlines";
import { ValidationError } from "./clients";

/**
 * News, Updates & Tax Countdowns. Announcements are read-only for clients
 * and never send texts or emails when published (so nothing promotional goes
 * out automatically). Tax dates are shown only after review with a source.
 */

export const AUDIENCES = { ALL: "All clients", INDIVIDUAL: "Individual clients", BUSINESS: "Business clients", BOOKKEEPING: "Bookkeeping clients" } as const;
export const TOPICS = {
  TAX_SEASON: "Tax season",
  DOCUMENT_TIPS: "Document tips",
  OFFICE_HOURS: "Office hours",
  HOLIDAY: "Holiday closure",
  SERVICE: "Service update",
  DEADLINE: "Upcoming deadline",
  GENERAL: "News",
} as const;

// --- Announcements -----------------------------------------------------------

export type AnnouncementInput = { title: string; body: string; audience: string; topic: string; pinned: boolean; publishAt: Date | null; expiresAt: Date | null };

function cleanAnnouncement(input: AnnouncementInput) {
  if (!input.title.trim() || !input.body.trim()) throw new ValidationError("Add a title and a message.");
  if (!(input.audience in AUDIENCES)) throw new ValidationError("Choose who should see it.");
  if (!(input.topic in TOPICS)) throw new ValidationError("Choose a topic.");
  const publishedAt = input.publishAt ?? new Date();
  if (input.expiresAt && input.expiresAt <= publishedAt) throw new ValidationError("The end date must be after the start date.");
  return { title: input.title.trim().slice(0, 200), body: input.body.trim().slice(0, 5000), audience: input.audience, topic: input.topic, pinned: input.pinned, publishedAt, expiresAt: input.expiresAt };
}

export async function saveAnnouncement(actor: Actor, input: AnnouncementInput, id?: string) {
  assertAdmin(actor);
  const data = cleanAnnouncement(input);
  if (id) {
    const existing = await prisma.announcement.findUnique({ where: { id } });
    if (!existing || existing.clientId) throw new ValidationError("Announcement not found.");
  }
  const a = id ? await prisma.announcement.update({ where: { id }, data }) : await prisma.announcement.create({ data: { ...data, createdById: actor.id } });
  await audit(prisma, { actorId: actor.id, action: id ? "announcement.updated" : "announcement.created", entityType: "Announcement", entityId: a.id, details: { audience: a.audience, pinned: a.pinned, scheduled: a.publishedAt! > new Date() } });
  return a;
}

export async function setAnnouncementPinned(actor: Actor, id: string, pinned: boolean) {
  assertAdmin(actor);
  await prisma.announcement.update({ where: { id }, data: { pinned } });
  await audit(prisma, { actorId: actor.id, action: pinned ? "announcement.pinned" : "announcement.unpinned", entityType: "Announcement", entityId: id });
}

export async function expireAnnouncement(actor: Actor, id: string) {
  assertAdmin(actor);
  await prisma.announcement.update({ where: { id }, data: { expiresAt: new Date() } });
  await audit(prisma, { actorId: actor.id, action: "announcement.expired", entityType: "Announcement", entityId: id });
}

export async function staffAnnouncements() {
  return prisma.announcement.findMany({ where: { clientId: null }, include: { groups: { include: { group: { select: { name: true } } } } }, orderBy: [{ publishedAt: "desc" }], take: 100 });
}

/** Live announcements for one client: their audience, their groups, and updates posted to them. */
export async function announcementsForClient(clientId: string, now = new Date()) {
  const client = await prisma.client.findUniqueOrThrow({ where: { id: clientId }, select: { clientType: true, services: true, _count: { select: { periods: true } } } });
  const audiences = ["ALL", client.clientType === "INDIVIDUAL" ? "INDIVIDUAL" : "BUSINESS"];
  if (client._count.periods > 0 || client.services.some((s) => /bookkeep/i.test(s))) audiences.push("BOOKKEEPING");
  const rows = await prisma.announcement.findMany({
    where: {
      publishedAt: { lte: now },
      OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
      AND: [{ OR: [{ clientId }, { audience: { in: audiences } }, { groups: { some: { group: { clients: { some: { clientId } } } } } }] }],
    },
    orderBy: [{ pinned: "desc" }, { publishedAt: "desc" }],
    take: 20,
  });
  return rows;
}

// --- Tax dates -----------------------------------------------------------------

export type DeadlineInput = { kind: string; taxYear: number; jurisdiction: string; reliefState?: string; dueDate: string; timeNote?: string; notes?: string; sourceUrl: string };

function cleanDeadline(input: DeadlineInput) {
  if (!isDeadlineKind(input.kind)) throw new ValidationError("Choose which deadline this is.");
  if (!Number.isInteger(input.taxYear) || input.taxYear < 2020 || input.taxYear > 2100) throw new ValidationError("Enter the tax year the return covers.");
  const jurisdiction = input.jurisdiction.trim().toUpperCase() || "US";
  if (jurisdiction !== "US" && !isStateCode(jurisdiction)) throw new ValidationError("Choose IRS (US) or a state.");
  const reliefState = (input.reliefState ?? "").trim().toUpperCase();
  if (reliefState && (!isStateCode(reliefState) || jurisdiction !== "US")) throw new ValidationError("Relief applies to an IRS date for one state.");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.dueDate) || Number.isNaN(Date.parse(`${input.dueDate}T00:00:00Z`))) throw new ValidationError("Enter the date.");
  let sourceUrl: string;
  try {
    const u = new URL(input.sourceUrl.trim());
    if (u.protocol !== "https:") throw new Error();
    sourceUrl = u.toString();
  } catch {
    throw new ValidationError("Add the official https:// source you checked (IRS or state agency).");
  }
  if (reliefState && !input.notes?.trim()) throw new ValidationError("Describe the relief (which areas and why).");
  return { kind: input.kind, taxYear: input.taxYear, jurisdiction, reliefState, dueDate: input.dueDate, timeNote: input.timeNote?.trim().slice(0, 200) || null, notes: input.notes?.trim().slice(0, 600) || null, sourceUrl };
}

/** Saving a date records it as reviewed by this Admin today. */
export async function saveDeadline(actor: Actor, input: DeadlineInput, id?: string) {
  assertAdmin(actor);
  const data = { ...cleanDeadline(input), lastReviewedAt: new Date(), reviewedById: actor.id };
  const clash = await prisma.taxDeadline.findFirst({ where: { kind: data.kind, taxYear: data.taxYear, jurisdiction: data.jurisdiction, reliefState: data.reliefState, ...(id ? { NOT: { id } } : {}) } });
  if (clash) throw new ValidationError("That deadline already exists — edit it instead.");
  const d = id ? await prisma.taxDeadline.update({ where: { id }, data }) : await prisma.taxDeadline.create({ data });
  await audit(prisma, { actorId: actor.id, action: id ? "tax_deadline.updated" : "tax_deadline.created", entityType: "TaxDeadline", entityId: d.id, details: { kind: d.kind, taxYear: d.taxYear, dueDate: d.dueDate, sourceUrl: d.sourceUrl } });
  return d;
}

/** Re-confirms a date against its source without changing it. */
export async function markDeadlineReviewed(actor: Actor, id: string) {
  assertAdmin(actor);
  await prisma.taxDeadline.update({ where: { id }, data: { lastReviewedAt: new Date(), reviewedById: actor.id } });
  await audit(prisma, { actorId: actor.id, action: "tax_deadline.reviewed", entityType: "TaxDeadline", entityId: id });
}

export async function setDeadlineHidden(actor: Actor, id: string, hidden: boolean) {
  assertAdmin(actor);
  await prisma.taxDeadline.update({ where: { id }, data: { hidden } });
  await audit(prisma, { actorId: actor.id, action: hidden ? "tax_deadline.hidden" : "tax_deadline.shown", entityType: "TaxDeadline", entityId: id });
}

export async function listDeadlines() {
  return prisma.taxDeadline.findMany({ orderBy: [{ dueDate: "asc" }, { jurisdiction: "asc" }] });
}

/** IRS-rule dates for the next tax year that aren't saved yet, for staff to review. */
export async function missingSuggestions(today = officeToday()) {
  const rows = await prisma.taxDeadline.findMany({ where: { jurisdiction: "US", reliefState: "" }, select: { kind: true, taxYear: true } });
  const have = new Set(rows.map((r) => `${r.kind}:${r.taxYear}`));
  const y = Number(today.slice(0, 4));
  return [y - 1, y].flatMap((ty) => suggestedDates(ty)).filter((s) => s.dueDate >= today && !have.has(`${s.kind}:${s.taxYear}`));
}

/** Countdown cards for a client (personalized) or the general version (null). */
export async function countdownsFor(clientId: string | null, now = new Date()) {
  const today = officeToday(now);
  const rows = await prisma.taxDeadline.findMany({ where: { hidden: false } });
  let profile: ClientProfile | null = null;
  let extensions: { taxYear: number; jurisdiction: string }[] = [];
  if (clientId) {
    const c = await prisma.client.findUniqueOrThrow({ where: { id: clientId }, select: { clientType: true, entityType: true, fiscalYearEnd: true, state: true } });
    profile = { clientType: c.clientType, entityType: c.entityType, fiscalYearEnd: c.fiscalYearEnd, state: c.state && isStateCode(c.state.toUpperCase()) ? c.state.toUpperCase() : null };
    // Only an extension our office recorded as accepted counts as confirmed.
    extensions = await prisma.filingRecord.findMany({ where: { clientId, filingType: "EXTENSION", filingStatus: "ACCEPTED", visibleToClient: true }, select: { taxYear: true, jurisdiction: true } });
  }
  return { today, cards: buildCountdowns({ rows, today, profile, extensions, stateName }) };
}
