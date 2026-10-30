import "server-only";
import { prisma } from "@/lib/prisma";
import { audit } from "@/lib/audit";
import { assertAdmin, ForbiddenError, type Actor } from "@/lib/auth/actor";
import { OWNER_EMAIL } from "@/lib/business";
import { normalizeEmail } from "@/lib/normalize";
import { ValidationError } from "./clients";
import { MONTHS, openPeriod } from "./bookkeeping";
import { notifyClientUsers } from "./documents";

/**
 * Bookkeeping Clients: the staff list of monthly/quarterly bookkeeping
 * accounts, each month's checklist, and the report review flow. Financial
 * reports (P&L, Balance Sheet…) reach a client only after the owner approves
 * them: staff submit → owner approves (or asks for changes) → staff deliver.
 */

export const FREQUENCIES = { MONTHLY: "Monthly", QUARTERLY: "Quarterly" } as const;
export const PAYROLL_FREQUENCIES = { WEEKLY: "Weekly", BIWEEKLY: "Every two weeks", SEMIMONTHLY: "Twice a month", MONTHLY: "Monthly" } as const;

// Document kinds collected for bookkeeping (stored in Document.docType).
export const BK_DOC_TYPES = {
  BANK_STATEMENT: "Bank statement",
  CARD_STATEMENT: "Credit card statement",
  PAYROLL_REPORT: "Payroll report",
  RECEIPTS: "Receipts / bills",
  BK_OTHER: "Other bookkeeping document",
} as const;
export const isBkDocType = (t: string): t is keyof typeof BK_DOC_TYPES => t in BK_DOC_TYPES;

type ItemDef = { key: string; label: string; kind: "CLIENT_DOCUMENT" | "STAFF_TASK"; docType?: keyof typeof BK_DOC_TYPES; payrollOnly?: boolean; reportMonthsOnly?: boolean };
export const CHECKLIST: ItemDef[] = [
  { key: "BANK_STATEMENTS", label: "Bank statements", kind: "CLIENT_DOCUMENT", docType: "BANK_STATEMENT" },
  { key: "CARD_STATEMENTS", label: "Credit card statements", kind: "CLIENT_DOCUMENT", docType: "CARD_STATEMENT" },
  { key: "PAYROLL_REPORTS", label: "Payroll reports", kind: "CLIENT_DOCUMENT", docType: "PAYROLL_REPORT", payrollOnly: true },
  { key: "RECEIPTS", label: "Receipts and bills", kind: "CLIENT_DOCUMENT", docType: "RECEIPTS" },
  { key: "CATEGORIZE", label: "Categorize transactions", kind: "STAFF_TASK" },
  { key: "RECONCILE", label: "Reconcile bank and card accounts", kind: "STAFF_TASK" },
  { key: "PAYROLL_ENTRIES", label: "Record payroll", kind: "STAFF_TASK", payrollOnly: true },
  { key: "PREPARE_REPORTS", label: "Prepare P&L and Balance Sheet", kind: "STAFF_TASK", reportMonthsOnly: true },
];

export const REVIEW_LABELS: Record<string, string> = {
  DRAFT: "Draft — staff work",
  AWAITING_REVIEW: "Awaiting Tabitha's review",
  CHANGES_REQUESTED: "Changes requested",
  APPROVED: "Approved — ready to deliver",
};

/** The owner (Tabitha) approves reports: the primary Owner's Office account, or the owner's email before it's claimed. */
export async function isReportApprover(actor: { id: string; role: string; email: string }) {
  if (actor.role !== "ADMIN") return false;
  const primary = await prisma.ownerAccess.findFirst({ where: { isPrimary: true, revokedAt: null }, select: { userId: true } });
  if (primary) return primary.userId === actor.id;
  return normalizeEmail(actor.email) === OWNER_EMAIL;
}

async function assertApprover(actor: Actor) {
  if (!(await isReportApprover(actor))) throw new ForbiddenError("Only Tabitha can approve financial reports.");
}

export const isReport = (d: { category: string; reportType: string | null }) => d.category === "BOOKKEEPING" && !!d.reportType;

// --- Profiles --------------------------------------------------------------------

export async function saveProfile(actor: Actor, clientId: string, input: { active: boolean; frequency: string; payroll: boolean; payrollFrequency?: string | null; payrollProvider?: string | null; accounts?: string | null; notes?: string | null; assignedToId?: string | null }) {
  if (!(input.frequency in FREQUENCIES)) throw new ValidationError("Choose monthly or quarterly.");
  if (input.payroll && input.payrollFrequency && !(input.payrollFrequency in PAYROLL_FREQUENCIES)) throw new ValidationError("Choose how often payroll runs.");
  const client = await prisma.client.findUnique({ where: { id: clientId } });
  if (!client) throw new ValidationError("Client not found.");
  const data = {
    active: input.active,
    frequency: input.frequency,
    payroll: input.payroll,
    payrollFrequency: input.payroll ? input.payrollFrequency || null : null,
    payrollProvider: input.payroll ? input.payrollProvider?.trim().slice(0, 80) || null : null,
    accounts: input.accounts?.trim().slice(0, 300) || null,
    notes: input.notes?.trim().slice(0, 1000) || null,
    updatedById: actor.id,
  };
  await prisma.bookkeepingProfile.upsert({ where: { clientId }, create: { clientId, ...data }, update: data });
  if (input.assignedToId !== undefined && (input.assignedToId || null) !== client.assignedToId) {
    assertAdmin(actor); // only an Admin reassigns clients
    await prisma.client.update({ where: { id: clientId }, data: { assignedToId: input.assignedToId || null } });
  }
  await audit(prisma, { actorId: actor.id, action: "bookkeeping.profile_saved", entityType: "Client", entityId: clientId, clientId, details: { frequency: data.frequency, payroll: data.payroll } });
}

/**
 * The month being worked: last month, for monthly and quarterly clients
 * alike (quarterly clients still send documents every month). Reports are
 * prepared every month for monthly clients and at quarter end (March, June,
 * September, December) for quarterly clients.
 */
export function workMonth(_frequency: string, now = new Date()) {
  const d = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  return { year: d.getFullYear(), month: d.getMonth() + 1 };
}

export const isQuarterEnd = (month: number) => month % 3 === 0;
export const reportsDue = (frequency: string, month: number) => frequency !== "QUARTERLY" || isQuarterEnd(month);

/**
 * Due dates used for "overdue": client documents by the 10th of the
 * following month; reports delivered by the end of the following month.
 */
export function periodDeadlines(year: number, month: number) {
  return { documents: new Date(year, month, 10, 23, 59), reports: new Date(year, month + 1, 0, 23, 59) };
}

export const periodLabel = (frequency: string, year: number, month: number) => `${MONTHS[month - 1]} ${year}${frequency === "QUARTERLY" && isQuarterEnd(month) ? ` (Q${month / 3} close)` : ""}`;

/** Opens a month (or quarter) and adds the standard checklist for this client. */
export async function openWorkPeriod(actor: Actor, clientId: string, year: number, month: number) {
  const period = await openPeriod(actor, clientId, year, month);
  const profile = await prisma.bookkeepingProfile.findUnique({ where: { clientId } });
  // Payroll reports only for payroll clients; reports only in report months (every month, or quarter end).
  const items = CHECKLIST.filter((i) => (!i.payrollOnly || profile?.payroll) && (!i.reportMonthsOnly || reportsDue(profile?.frequency ?? "MONTHLY", month)));
  await prisma.bookkeepingChecklistItem.createMany({
    data: items.map((i, k) => ({ periodId: period.id, key: i.key, label: i.label, kind: i.kind, sortOrder: k })),
    skipDuplicates: true,
  });
  return period;
}

/** Opens the current work period for every active bookkeeping client. */
export async function openWorkPeriodsForAll(actor: Actor, now = new Date()) {
  const profiles = await prisma.bookkeepingProfile.findMany({ where: { active: true, client: { archivedAt: null } } });
  let opened = 0;
  for (const p of profiles) {
    const { year, month } = workMonth(p.frequency, now);
    const existed = await prisma.bookkeepingPeriod.count({ where: { clientId: p.clientId, year, month } });
    await openWorkPeriod(actor, p.clientId, year, month);
    if (!existed) opened++;
  }
  return { opened, total: profiles.length };
}

export async function setChecklistItem(actor: Actor, itemId: string, status: "OPEN" | "DONE" | "NOT_NEEDED") {
  const item = await prisma.bookkeepingChecklistItem.findUniqueOrThrow({ where: { id: itemId }, include: { period: true } });
  await prisma.bookkeepingChecklistItem.update({ where: { id: itemId }, data: { status, doneById: status === "OPEN" ? null : actor.id, doneAt: status === "OPEN" ? null : new Date() } });
  await audit(prisma, { actorId: actor.id, action: "bookkeeping.checklist_updated", entityType: "BookkeepingChecklistItem", entityId: itemId, clientId: item.period.clientId, details: { key: item.key, status } });
}

/** Labels a document in a month (e.g. a client upload) so it counts toward the checklist. */
export async function classifyDocument(actor: Actor, documentId: string, docType: string) {
  if (!isBkDocType(docType)) throw new ValidationError("Choose the kind of document.");
  const doc = await prisma.document.findUniqueOrThrow({ where: { id: documentId } });
  if (!doc.periodId) throw new ValidationError("This document isn't attached to a bookkeeping month.");
  await prisma.document.update({ where: { id: documentId }, data: { docType } });
  await audit(prisma, { actorId: actor.id, action: "bookkeeping.document_classified", entityType: "Document", entityId: documentId, clientId: doc.clientId, details: { docType } });
}

// --- Report review -----------------------------------------------------------------

async function loadReport(documentId: string) {
  const doc = await prisma.document.findUnique({ where: { id: documentId } });
  if (!doc || doc.deletedAt || !isReport(doc)) throw new ValidationError("Report not found.");
  return doc;
}

export async function submitReportForReview(actor: Actor, documentId: string) {
  const doc = await loadReport(documentId);
  if (doc.visibility === "PUBLISHED") throw new ValidationError("This report was already delivered.");
  if (doc.reviewStatus === "AWAITING_REVIEW") return;
  if (doc.scanStatus !== "CLEAN") throw new ValidationError("This file hasn't passed the malware scan yet.");
  await prisma.document.update({ where: { id: documentId }, data: { reviewStatus: "AWAITING_REVIEW", submittedForReviewAt: new Date(), submittedForReviewById: actor.id, reviewNote: null } });
  await audit(prisma, { actorId: actor.id, action: "bookkeeping.report_submitted", entityType: "Document", entityId: documentId, clientId: doc.clientId });
}

export async function approveReport(actor: Actor, documentId: string) {
  await assertApprover(actor);
  const doc = await loadReport(documentId);
  if (doc.reviewStatus !== "AWAITING_REVIEW") throw new ValidationError("Only reports awaiting review can be approved.");
  await prisma.document.update({ where: { id: documentId }, data: { reviewStatus: "APPROVED", approvedAt: new Date(), approvedById: actor.id } });
  await audit(prisma, { actorId: actor.id, action: "bookkeeping.report_approved", entityType: "Document", entityId: documentId, clientId: doc.clientId });
}

export async function requestReportChanges(actor: Actor, documentId: string, note: string) {
  await assertApprover(actor);
  const doc = await loadReport(documentId);
  if (doc.reviewStatus !== "AWAITING_REVIEW" && doc.reviewStatus !== "APPROVED") throw new ValidationError("This report isn't in review.");
  if (doc.visibility === "PUBLISHED") throw new ValidationError("This report was already delivered.");
  if (!note.trim()) throw new ValidationError("Say what needs to change.");
  await prisma.document.update({ where: { id: documentId }, data: { reviewStatus: "CHANGES_REQUESTED", reviewNote: note.trim().slice(0, 1000), approvedAt: null, approvedById: null } });
  await audit(prisma, { actorId: actor.id, action: "bookkeeping.report_changes_requested", entityType: "Document", entityId: documentId, clientId: doc.clientId });
}

/** Publishes an approved report to the client's portal and sends the usual generic notice. */
export async function deliverReport(actor: Actor, documentId: string) {
  const doc = await loadReport(documentId);
  if (doc.reviewStatus !== "APPROVED") throw new ValidationError("Tabitha must approve this report before it's delivered.");
  if (doc.visibility === "PUBLISHED") return;
  await prisma.$transaction([
    prisma.document.update({ where: { id: documentId }, data: { visibility: "PUBLISHED", publishedAt: new Date() } }),
    prisma.documentAccessLog.create({ data: { documentId, action: "PUBLISH", staffUserId: actor.id } }),
    prisma.auditLog.create({ data: { actorId: actor.id, action: "bookkeeping.report_delivered", entityType: "Document", entityId: documentId, clientId: doc.clientId } }),
  ]);
  if (doc.scanStatus === "CLEAN") await notifyClientUsers(doc.clientId, "NEW_DOCUMENT", doc.id, doc.category);
}

// --- Stages ------------------------------------------------------------------------------

export const STAGES = {
  AWAITING_REVIEW: { label: "Awaiting Tabitha's review", tone: "gold" },
  READY_TO_DELIVER: { label: "Ready to deliver", tone: "green" },
  STAFF_WORK: { label: "Awaiting staff work", tone: "navy" },
  CLIENT_DOCUMENTS: { label: "Waiting on client documents", tone: "amber" },
  DELIVERED: { label: "Delivered", tone: "gray" },
  COLLECTED: { label: "Collected — report at quarter end", tone: "gray" },
  NOT_OPENED: { label: "Month not opened", tone: "red" },
} as const;
export type Stage = keyof typeof STAGES;

type PeriodFull = Awaited<ReturnType<typeof loadPeriod>>;
async function loadPeriod(periodId: string) {
  return prisma.bookkeepingPeriod.findUniqueOrThrow({
    where: { id: periodId },
    include: {
      checklist: { orderBy: { sortOrder: "asc" } },
      documents: { where: { deletedAt: null }, orderBy: { createdAt: "desc" }, include: { uploadedByPortal: { select: { name: true } }, uploadedByStaff: { select: { name: true } } } },
      requests: { orderBy: { createdAt: "asc" } },
      conversations: { orderBy: { lastMessageAt: "desc" }, select: { id: true, subject: true, awaitingStaff: true, lastMessageAt: true } },
    },
  });
}

/** Checklist lines with who they're waiting on. */
export function checklistView(p: PeriodFull) {
  return p.checklist.map((i) => {
    const def = CHECKLIST.find((c) => c.key === i.key);
    const files = def?.docType ? p.documents.filter((d) => d.docType === def.docType) : [];
    let state: "DONE" | "NOT_NEEDED" | "RECEIVED" | "WAITING_CLIENT" | "STAFF_TODO";
    if (i.status === "DONE") state = "DONE";
    else if (i.status === "NOT_NEEDED") state = "NOT_NEEDED";
    else if (i.kind === "CLIENT_DOCUMENT") state = files.length ? "RECEIVED" : "WAITING_CLIENT";
    else state = "STAFF_TODO";
    return { ...i, files, state };
  });
}

export function periodSummary(p: PeriodFull, frequency = "MONTHLY", now = new Date()) {
  const items = checklistView(p);
  const reports = p.documents.filter(isReport);
  const missing = items.filter((i) => i.state === "WAITING_CLIENT").length + p.requests.filter((r) => r.status === "OPEN").length;
  const done = items.filter((i) => i.state === "DONE" || i.state === "NOT_NEEDED" || i.state === "RECEIVED").length;
  let stage: Stage;
  if (reports.some((r) => r.reviewStatus === "AWAITING_REVIEW")) stage = "AWAITING_REVIEW";
  else if (reports.some((r) => r.reviewStatus === "APPROVED" && r.visibility !== "PUBLISHED")) stage = "READY_TO_DELIVER";
  else if (p.status === "COMPLETE" || (reports.length > 0 && reports.every((r) => r.visibility === "PUBLISHED"))) stage = "DELIVERED";
  else if (!reports.length && !items.some((i) => i.state === "RECEIVED") && items.some((i) => i.state === "WAITING_CLIENT")) stage = "CLIENT_DOCUMENTS";
  else if (!reportsDue(frequency, p.month) && items.every((i) => i.state !== "WAITING_CLIENT" && i.state !== "STAFF_TODO")) stage = "COLLECTED";
  else stage = "STAFF_WORK";
  const due = periodDeadlines(p.year, p.month);
  const overdue: string[] = [];
  if (items.some((i) => i.state === "WAITING_CLIENT") && now > due.documents) overdue.push("Client documents overdue");
  if (p.requests.some((r) => r.status === "OPEN" && r.dueAt && r.dueAt < now)) overdue.push("Requested item past due");
  if (reportsDue(frequency, p.month) && stage !== "DELIVERED" && now > due.reports) overdue.push("Reports overdue");
  return { items, reports, missing, done, total: items.length, stage, overdue, due };
}

export type ListFilters = { assignedTo?: string | null; frequency?: string | null; missing?: boolean; overdue?: boolean; review?: boolean; now?: Date };

/** One row per bookkeeping client for the staff list, with filters. */
export async function bookkeepingClients(f: ListFilters = {}) {
  const now = f.now ?? new Date();
  const assigned = f.assignedTo === "unassigned" ? { assignedToId: null } : f.assignedTo ? { assignedToId: f.assignedTo } : {};
  const profiles = await prisma.bookkeepingProfile.findMany({
    where: { active: true, ...(f.frequency && f.frequency in FREQUENCIES ? { frequency: f.frequency } : {}), client: { archivedAt: null, ...assigned } },
    include: { client: { select: { id: true, displayName: true, assignedTo: { select: { id: true, name: true } } } } },
    orderBy: { client: { displayName: "asc" } },
  });
  const rows = [];
  for (const p of profiles) {
    const { year, month } = workMonth(p.frequency, now);
    const recent = await prisma.bookkeepingPeriod.findMany({ where: { clientId: p.clientId }, orderBy: [{ year: "desc" }, { month: "desc" }], take: 6, select: { id: true, year: true, month: true } });
    const summaries = await Promise.all(recent.map(async (r) => ({ ...r, summary: periodSummary(await loadPeriod(r.id), p.frequency, now) })));
    const current = summaries.find((r) => r.year === year && r.month === month) ?? null;
    const summary = current?.summary ?? null;
    // Earlier months still not finished also count as overdue.
    const olderOverdue = summaries.filter((r) => r !== current && r.summary.overdue.length > 0 && r.summary.stage !== "DELIVERED");
    const overdue = [...(summary?.overdue ?? []), ...olderOverdue.map((r) => `${periodLabel(p.frequency, r.year, r.month)} not finished`)];
    const missing = summaries.reduce((n, r) => n + (r.summary.stage === "DELIVERED" ? 0 : r.summary.missing), 0);
    const awaitingReview = summaries.some((r) => r.summary.stage === "AWAITING_REVIEW");
    const unread = await prisma.conversation.count({ where: { clientId: p.clientId, awaitingStaff: true } });
    rows.push({ profile: p, client: p.client, workLabel: periodLabel(p.frequency, year, month), reportMonth: reportsDue(p.frequency, month), periodId: current?.id ?? null, summary, stage: (summary?.stage ?? "NOT_OPENED") as Stage, overdue, missing, awaitingReview, unread });
  }
  return rows.filter((r) => (!f.missing || r.missing > 0) && (!f.overdue || r.overdue.length > 0) && (!f.review || r.awaitingReview));
}

/** Everything for one client's bookkeeping workspace. */
export async function bookkeepingWorkspace(clientId: string, periodId?: string | null) {
  const [client, profile, periods] = await Promise.all([
    prisma.client.findUniqueOrThrow({ where: { id: clientId }, select: { id: true, displayName: true, assignedTo: { select: { id: true, name: true } }, assignedToId: true } }),
    prisma.bookkeepingProfile.findUnique({ where: { clientId } }),
    prisma.bookkeepingPeriod.findMany({ where: { clientId }, orderBy: [{ year: "desc" }, { month: "desc" }], select: { id: true, year: true, month: true, status: true } }),
  ]);
  const chosen = periods.find((p) => p.id === periodId) ?? periods[0] ?? null;
  const period = chosen ? await loadPeriod(chosen.id) : null;
  const freq = profile?.frequency ?? "MONTHLY";
  const prior = await Promise.all(periods.map(async (p) => ({ ...p, summary: periodSummary(await loadPeriod(p.id), freq) })));
  return { client, profile, periods: prior, period, summary: period ? periodSummary(period, freq) : null };
}

/** Reports waiting for the owner, across all clients. */
export function reportsAwaitingReview() {
  return prisma.document.findMany({
    where: { deletedAt: null, category: "BOOKKEEPING", reportType: { not: null }, reviewStatus: "AWAITING_REVIEW" },
    include: { client: { select: { id: true, displayName: true } }, period: { select: { id: true, year: true, month: true } } },
    orderBy: { submittedForReviewAt: "asc" },
  });
}
