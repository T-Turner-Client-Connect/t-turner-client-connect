import "server-only";
import { BK_UPLOAD_TYPES, isBkUploadType } from "@/lib/bk-uploads";
import { prisma } from "@/lib/prisma";
import { audit } from "@/lib/audit";
import { assertAdmin, ForbiddenError, type Actor } from "@/lib/auth/actor";
import { BASIS, longDate, PERIOD_TYPES, reportPeriod, type PeriodType } from "@/lib/bookkeeping-periods";
import { OWNER_EMAIL } from "@/lib/business";
import type { ReportType } from "@prisma/client";
import { buildDisplayName, normalizeEmail, normalizePhone } from "@/lib/normalize";
import { createClient, saveContact, ValidationError, type ClientInput } from "./clients";
import { MONTHS, openPeriod } from "./bookkeeping";
import { notifyClientUsers, REPORT_LABELS, staffUploadDocument } from "./documents";
import { ownerAndBusiness } from "./related-businesses";

/**
 * Bookkeeping Clients: the staff list of monthly/quarterly bookkeeping
 * accounts, each month's checklist, and the report review flow. Financial
 * reports (P&L, Balance Sheet…) reach a client only after the owner approves
 * them: staff submit → owner approves (or asks for changes) → staff deliver.
 */

export const FREQUENCIES = { MONTHLY: "Monthly", QUARTERLY: "Quarterly" } as const;
export const PAYROLL_FREQUENCIES = { WEEKLY: "Weekly", BIWEEKLY: "Every two weeks", SEMIMONTHLY: "Twice a month", MONTHLY: "Monthly" } as const;

// Document kinds collected for bookkeeping (stored in Document.docType).
// "What are you uploading?" — the full list (src/lib/bk-uploads.ts).
export const BK_DOC_TYPES = BK_UPLOAD_TYPES;
export const isBkDocType = isBkUploadType;

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

export type ProfileInput = { active: boolean; frequency: string; payroll: boolean; payrollFrequency?: string | null; payrollProvider?: string | null; accounts?: string | null; notes?: string | null; assignedToId?: string | null } & Deadlines;

/** Saves a client's bookkeeping settings. assignedToId: undefined keeps the current assignee, null unassigns. */
export async function saveProfile(actor: Actor, clientId: string, input: ProfileInput) {
  for (const d of [input.documentsDueDay, input.reportsDueDay]) {
    if (d != null && (!Number.isInteger(d) || d < 1 || d > 31)) throw new ValidationError("Due days must be 1–31 (31 = last day of the month).");
  }
  if (!(input.frequency in FREQUENCIES)) throw new ValidationError("Choose monthly or quarterly.");
  if (input.payroll && input.payrollFrequency && !(input.payrollFrequency in PAYROLL_FREQUENCIES)) throw new ValidationError("Choose how often payroll runs.");
  const client = await prisma.client.findUnique({ where: { id: clientId } });
  if (!client) throw new ValidationError("Client not found.");
  if (client.archivedAt) throw new ValidationError(`${client.displayName} is archived. Restore the client in Clients first.`);
  if (input.assignedToId && !(await prisma.user.count({ where: { id: input.assignedToId, active: true } }))) throw new ValidationError("Choose an active staff member.");
  if (input.assignedToId !== undefined && input.assignedToId !== client.assignedToId) assertAdmin(actor);
  const data = {
    active: input.active,
    frequency: input.frequency,
    payroll: input.payroll,
    payrollFrequency: input.payroll ? input.payrollFrequency || null : null,
    payrollProvider: input.payroll ? input.payrollProvider?.trim().slice(0, 80) || null : null,
    accounts: input.accounts?.trim().slice(0, 300) || null,
    notes: input.notes?.trim().slice(0, 1000) || null,
    ...(input.documentsDueDay !== undefined ? { documentsDueDay: input.documentsDueDay } : {}),
    ...(input.reportsDueDay !== undefined ? { reportsDueDay: input.reportsDueDay } : {}),
    updatedById: actor.id,
  };
  await prisma.bookkeepingProfile.upsert({ where: { clientId }, create: { clientId, ...data }, update: data });
  // Only an Admin changes who a bookkeeping client is assigned to.
  if (input.assignedToId !== undefined && input.assignedToId !== client.assignedToId) {
    assertAdmin(actor);
    await prisma.client.update({ where: { id: clientId }, data: { assignedToId: input.assignedToId } });
    await audit(prisma, { actorId: actor.id, action: "client.updated", entityType: "Client", entityId: clientId, clientId, details: { fields: ["assignedToId"] } });
  }
  await audit(prisma, { actorId: actor.id, action: "bookkeeping.profile_saved", entityType: "Client", entityId: clientId, clientId, details: { frequency: data.frequency, payroll: data.payroll } });
}

// --- Adding clients -------------------------------------------------------------------

export class AlreadyEnrolledError extends ValidationError {}

/** Adds an existing CRM client (or reactivates a paused one). Never creates a client. */
export async function enrollExistingClient(actor: Actor, clientId: string, input: ProfileInput) {
  const client = await prisma.client.findUnique({ where: { id: clientId }, include: { bookkeepingProfile: true } });
  if (!client) throw new ValidationError("Client not found. Choose a client from the list.");
  if (client.bookkeepingProfile?.active) throw new AlreadyEnrolledError(`${client.displayName} is already a Bookkeeping Client.`);
  await saveProfile(actor, clientId, { ...input, active: true });
  return { client, reactivated: !!client.bookkeepingProfile };
}

export type ClientMatch = { id: string; displayName: string; email: string | null; phone: string | null; archived: boolean; enrolled: boolean; by: ("email" | "phone" | "name")[] };

/** CRM records that may be the same person or business: same email, same phone, or the same name. */
export async function findClientMatches(input: Pick<ClientInput, "firstName" | "lastName" | "businessName" | "email" | "phone">): Promise<ClientMatch[]> {
  const email = normalizeEmail(input.email);
  const phone = normalizePhone(input.phone);
  const name = input.firstName || input.lastName || input.businessName ? buildDisplayName({ firstName: input.firstName ?? null, lastName: input.lastName ?? null, businessName: input.businessName ?? null }).trim() : "";
  const or = [
    ...(email ? [{ emailNormalized: email }, { contacts: { some: { emailNormalized: email } } }] : []),
    ...(phone ? [{ phoneNormalized: phone }, { contacts: { some: { phoneNormalized: phone } } }] : []),
    ...(name ? [{ displayName: { equals: name, mode: "insensitive" as const } }, ...(input.businessName ? [{ businessName: { equals: input.businessName.trim(), mode: "insensitive" as const } }] : [])] : []),
  ];
  if (!or.length) return [];
  const found = await prisma.client.findMany({ where: { OR: or }, include: { bookkeepingProfile: { select: { active: true } }, contacts: { select: { emailNormalized: true, phoneNormalized: true } } }, take: 10 });
  return found.map((c) => ({
    id: c.id,
    displayName: c.displayName,
    email: c.email,
    phone: c.phone,
    archived: !!c.archivedAt,
    enrolled: !!c.bookkeepingProfile?.active,
    by: [
      ...(email && (c.emailNormalized === email || c.contacts.some((x) => x.emailNormalized === email)) ? ["email" as const] : []),
      ...(phone && (c.phoneNormalized === phone || c.contacts.some((x) => x.phoneNormalized === phone)) ? ["phone" as const] : []),
      ...(name && (c.displayName.toLowerCase() === name.toLowerCase() || (!!input.businessName && c.businessName?.toLowerCase() === input.businessName.trim().toLowerCase())) ? ["name" as const] : []),
    ],
  }));
}

export class PossibleDuplicateError extends ValidationError {
  constructor(public matches: ClientMatch[], public nameOnly: boolean) {
    super(
      nameOnly
        ? `A client with this name is already in the CRM (${matches.map((m) => m.displayName).join(", ")}). Enroll the existing record, or tick "This is a different client" to create a new one.`
        : `This email or phone number already belongs to ${matches.map((m) => m.displayName).join(", ")} in the CRM. Enroll the existing record instead of creating a duplicate.`,
    );
  }
}

/**
 * Creates a new CRM client and enrolls them. Refuses when the email or phone
 * already belongs to a client; a name-only match needs differentClient=true.
 */
export async function enrollNewClient(actor: Actor, clientInput: ClientInput, input: ProfileInput, opts: { differentClient?: boolean } = {}) {
  if (!input.frequency || !(input.frequency in FREQUENCIES)) throw new ValidationError("Choose monthly or quarterly.");
  if (input.assignedToId !== undefined) assertAdmin(actor);
  const matches = await findClientMatches(clientInput);
  const strong = matches.filter((m) => m.by.includes("email") || m.by.includes("phone"));
  if (strong.length) throw new PossibleDuplicateError(strong, false);
  if (matches.length && !opts.differentClient) throw new PossibleDuplicateError(matches, true);
  // A business is named for the business; the person typed in becomes its contact.
  const isOrg = clientInput.clientType !== "INDIVIDUAL" && !!clientInput.businessName?.trim();
  const person = [clientInput.firstName, clientInput.lastName].map((x) => x?.trim()).filter(Boolean).join(" ");
  const client = await createClient(actor, { ...clientInput, ...(isOrg ? { firstName: null, lastName: null } : {}), assignedToId: input.assignedToId ?? null, services: "Bookkeeping" });
  if (isOrg && person) await saveContact(actor, client.id, null, { name: person, title: "Primary contact", email: clientInput.email, phone: clientInput.phone });
  await saveProfile(actor, client.id, { ...input, active: true, assignedToId: undefined });
  return client;
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
 * Due dates come from each client's settings (day of the month after the
 * work month; 31 = last day). There is no built-in default: a client with no
 * day set has no deadline and is never shown as overdue for it.
 */
export function dueOn(year: number, month: number, day: number | null | undefined) {
  if (!day) return null;
  const last = new Date(year, month + 1, 0).getDate(); // last day of the following month
  return new Date(year, month, Math.min(day, last), 23, 59);
}

export type Deadlines = { documentsDueDay?: number | null; reportsDueDay?: number | null };

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
  if (doc.supersededAt) throw new ValidationError("A newer version of this report was uploaded. Work on the newest version.");
  return doc;
}

/**
 * Uploads a finished financial report into a client's year → month file (the
 * month is opened if needed). It's a staff-only draft until Tabitha approves
 * it. Uploading a P&L or Balance Sheet where that month already has one, or
 * choosing "replaces", makes it the next version: the earlier version is kept
 * as history and, if it was delivered, stays with the client until the new
 * version is approved and delivered.
 */
export type ReportUpload = {
  clientId: string;
  year: number;
  month: number;
  reportType: string;
  periodType?: string | null;
  basis?: string | null;
  includesYtd?: boolean | null;
  asOf?: Date | null;
  accountId?: string | null;
  title?: string;
  replacesId?: string | null;
  bytes: Uint8Array;
  originalName: string;
};

// Report kinds where a second upload for the same period is a revision, not a new report.
const VERSIONED = new Set(["FINANCIAL_PACKET", "PROFIT_AND_LOSS", "GROSS_RECEIPTS", "BALANCE_SHEET", "BANK_RECONCILIATION"]);

export async function uploadMonthlyReport(actor: Actor, input: ReportUpload) {
  if (!(input.reportType in REPORT_LABELS)) throw new ValidationError("Choose the kind of report (for example Profit & Loss Statement or Balance Sheet).");
  const reportType = input.reportType as ReportType;
  const thisYear = new Date().getFullYear();
  if (!Number.isInteger(input.year) || input.year < 2000 || input.year > thisYear + 1) throw new ValidationError("Choose the year.");
  if (!Number.isInteger(input.month) || input.month < 1 || input.month > 12) throw new ValidationError("Choose the month.");
  const client = await prisma.client.findUnique({ where: { id: input.clientId }, select: { id: true, archivedAt: true, fiscalYearEnd: true, bookkeepingProfile: { select: { accountingBasis: true } } } });
  if (!client) throw new ValidationError("Client not found.");
  const periodType = (input.periodType || "MONTH") as PeriodType;
  if (!(periodType in PERIOD_TYPES)) throw new ValidationError("Choose month, quarter or year to date.");
  const range = reportPeriod(input.year, input.month, periodType, client.fiscalYearEnd); // validates quarter months
  const basis = input.basis || client.bookkeepingProfile?.accountingBasis || null;
  if (!basis && input.reportType !== "SUPPORTING_SCHEDULE" && input.reportType !== "OTHER_REPORT") throw new ValidationError("Choose the accounting basis (cash, accrual or modified cash), or set it in the client's business profile.");
  if (basis && !(basis in BASIS)) throw new ValidationError("Choose the accounting basis.");
  let asOf: Date | null = null;
  if (input.reportType === "BALANCE_SHEET" || input.reportType === "FINANCIAL_PACKET") {
    asOf = input.asOf ?? range.end;
    if (asOf > range.end || asOf < range.start) throw new ValidationError(`The Balance Sheet "as of" date must fall within ${range.range}.`);
  }
  let accountId: string | null = null;
  if (input.accountId) {
    const acct = await prisma.bookkeepingAccount.findFirst({ where: { id: input.accountId, clientId: input.clientId } });
    if (!acct) throw new ValidationError("That account isn't on this client's profile.");
    accountId = acct.id;
  }
  let previous = null;
  if (input.replacesId) {
    previous = await prisma.document.findFirst({ where: { id: input.replacesId, clientId: input.clientId, deletedAt: null, category: "BOOKKEEPING", reportType: { not: null } }, include: { period: true } });
    if (!previous) throw new ValidationError("The report you're replacing wasn't found for this client.");
    if (previous.supersededAt) throw new ValidationError("That version was already replaced. Upload a revision of the newest version.");
    if (previous.period && (previous.period.year !== input.year || previous.period.month !== input.month)) throw new ValidationError("A revised report must be for the same month as the version it replaces.");
  }
  const period = await openWorkPeriod(actor, input.clientId, input.year, input.month);
  if (previous && (previous.reportPeriodType ?? "MONTH") !== periodType) throw new ValidationError("A revision must cover the same reporting period (month, quarter or year to date) as the version it replaces.");
  if (!previous && VERSIONED.has(reportType)) {
    previous = await prisma.document.findFirst({
      where: { periodId: period.id, deletedAt: null, reportType, supersededAt: null, OR: periodType === "MONTH" ? [{ reportPeriodType: "MONTH" }, { reportPeriodType: null }] : [{ reportPeriodType: periodType }], ...(reportType === "BANK_RECONCILIATION" ? { bookkeepingAccountId: accountId } : {}) },
      orderBy: { createdAt: "desc" },
      include: { period: true },
    });
  }
  const doc = await staffUploadDocument(actor, {
    clientId: input.clientId,
    category: "BOOKKEEPING",
    title: input.title?.trim() || `${REPORT_LABELS[previous?.reportType ?? reportType]} — ${reportPeriod(input.year, input.month, periodType, client.fiscalYearEnd).short}`,
    year: input.year,
    month: input.month,
    periodId: period.id,
    visibility: "STAFF_ONLY",
    reportType: previous?.reportType ?? reportType,
    bytes: input.bytes,
    originalName: input.originalName,
  });
  const version = previous ? (previous.version ?? 1) + 1 : 1;
  await prisma.$transaction([
    ...(previous ? [prisma.document.update({ where: { id: previous.id }, data: { supersededAt: new Date() } })] : []),
    prisma.document.update({
      where: { id: doc.id },
      data: { version, replacesId: previous?.id ?? null, reportPeriodType: periodType, reportBasis: basis, reportIncludesYtd: input.includesYtd ?? periodType === "YEAR_TO_DATE", reportAsOf: asOf, bookkeepingAccountId: accountId ?? previous?.bookkeepingAccountId ?? null },
    }),
    prisma.auditLog.create({ data: { actorId: actor.id, action: "bookkeeping.report_uploaded", entityType: "Document", entityId: doc.id, clientId: input.clientId, details: { reportType: previous?.reportType ?? reportType, year: input.year, month: input.month, periodType, basis, version, replaces: previous?.id ?? null } } }),
  ]);
  return { document: { ...doc, version, reportPeriodType: periodType }, period, version, replaced: previous, range };
}

/** All versions of a report, newest first. */
export async function reportVersions(documentId: string) {
  const out = [];
  let cur = await prisma.document.findUnique({ where: { id: documentId } });
  // Walk forward to the newest version first.
  while (cur) {
    const next = await prisma.document.findUnique({ where: { replacesId: cur.id } });
    if (!next) break;
    cur = next;
  }
  for (let i = 0; cur && i < 50; i++) {
    out.push(cur);
    cur = cur.replacesId ? await prisma.document.findUnique({ where: { id: cur.replacesId } }) : null;
  }
  return out;
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
  if (doc.scanStatus !== "CLEAN") throw new ValidationError("This file hasn't passed the malware scan, so it can't be delivered.");
  if (doc.visibility === "PUBLISHED") return;
  // A delivered revision takes the place of earlier delivered versions in the client's portal; staff keep them as history.
  const older = (await reportVersions(documentId)).filter((d) => d.id !== documentId && d.visibility === "PUBLISHED");
  await prisma.$transaction([
    prisma.document.update({ where: { id: documentId }, data: { visibility: "PUBLISHED", publishedAt: new Date() } }),
    prisma.documentAccessLog.create({ data: { documentId, action: "PUBLISH", staffUserId: actor.id } }),
    ...older.flatMap((o) => [
      prisma.document.update({ where: { id: o.id }, data: { visibility: "STAFF_ONLY" } }),
      prisma.documentAccessLog.create({ data: { documentId: o.id, action: "UNPUBLISH", staffUserId: actor.id } }),
    ]),
    prisma.auditLog.create({ data: { actorId: actor.id, action: "bookkeeping.report_delivered", entityType: "Document", entityId: documentId, clientId: doc.clientId, details: older.length ? { replacedDelivered: older.map((o) => o.id) } : undefined } }),
  ]);
  if (doc.scanStatus === "CLEAN") await notifyClientUsers(doc.clientId, "NEW_DOCUMENT", doc.id, doc.category);
}

/** Delivers every approved report in a month (or one reporting period of it) — one notice per report, as usual. */
export async function deliverApprovedReports(actor: Actor, periodId: string, periodType?: string | null) {
  const docs = await prisma.document.findMany({
    where: { periodId, deletedAt: null, supersededAt: null, category: "BOOKKEEPING", reportType: { not: null }, reviewStatus: "APPROVED", visibility: "STAFF_ONLY", ...(periodType ? (periodType === "MONTH" ? { OR: [{ reportPeriodType: "MONTH" }, { reportPeriodType: null }] } : { reportPeriodType: periodType }) : {}) },
  });
  if (!docs.length) throw new ValidationError("Nothing approved is waiting to be delivered.");
  for (const d of docs) await deliverReport(actor, d.id);
  return docs.length;
}

/** Revision and approval history for a report (all versions, oldest first). */
export async function reportHistory(documentId: string) {
  const versions = await reportVersions(documentId);
  const ids = versions.map((v) => v.id);
  const events = await prisma.auditLog.findMany({
    where: { entityType: "Document", entityId: { in: ids }, action: { in: ["bookkeeping.report_uploaded", "bookkeeping.report_submitted", "bookkeeping.report_approved", "bookkeeping.report_changes_requested", "bookkeeping.report_delivered"] } },
    include: { actor: { select: { name: true } } },
    orderBy: { createdAt: "asc" },
  });
  const verOf = new Map(versions.map((v) => [v.id, v.version ?? 1]));
  return events.map((e) => ({ at: e.createdAt, by: e.actor?.name ?? "System", version: verOf.get(e.entityId ?? "") ?? 1, action: e.action.replace("bookkeeping.report_", "") }));
}

export const HISTORY_LABELS: Record<string, string> = { uploaded: "Uploaded", submitted: "Submitted for review", approved: "Approved by Tabitha", changes_requested: "Changes requested", delivered: "Delivered to client" };

/** How a report describes its period: "As of September 30, 2026 • Cash Basis", etc. */
export function reportCaption(d: { reportType: string | null; reportPeriodType: string | null; reportBasis: string | null; reportAsOf: Date | null; reportIncludesYtd: boolean | null }, year: number, month: number, fiscalYearEnd?: number | null) {
  const r = reportPeriod(year, month, (d.reportPeriodType ?? "MONTH") as PeriodType, fiscalYearEnd);
  const when = d.reportType === "BALANCE_SHEET" ? `As of ${longDate(d.reportAsOf ?? r.end)}` : r.range;
  const basis = d.reportBasis ? BASIS[d.reportBasis as keyof typeof BASIS] : null;
  const ytd = d.reportType !== "BALANCE_SHEET" && d.reportIncludesYtd && (d.reportPeriodType ?? "MONTH") !== "YEAR_TO_DATE" ? "with year-to-date totals" : null;
  return [when, basis, ytd].filter(Boolean).join(" • ");
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
      documents: { where: { deletedAt: null }, orderBy: { createdAt: "desc" }, include: { uploadedByPortal: { select: { name: true } }, uploadedByStaff: { select: { name: true } }, bookkeepingAccount: true } },
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

export function periodSummary(p: PeriodFull, frequency = "MONTHLY", now = new Date(), deadlines: Deadlines = {}) {
  const items = checklistView(p);
  const reports = p.documents.filter((d) => isReport(d) && !d.supersededAt);
  const missing = items.filter((i) => i.state === "WAITING_CLIENT").length + p.requests.filter((r) => r.status === "OPEN").length;
  const done = items.filter((i) => i.state === "DONE" || i.state === "NOT_NEEDED" || i.state === "RECEIVED").length;
  let stage: Stage;
  if (reports.some((r) => r.reviewStatus === "AWAITING_REVIEW")) stage = "AWAITING_REVIEW";
  else if (reports.some((r) => r.reviewStatus === "APPROVED" && r.visibility !== "PUBLISHED")) stage = "READY_TO_DELIVER";
  else if (p.status === "COMPLETE" || (reports.length > 0 && reports.every((r) => r.visibility === "PUBLISHED"))) stage = "DELIVERED";
  else if (!reports.length && !items.some((i) => i.state === "RECEIVED") && items.some((i) => i.state === "WAITING_CLIENT")) stage = "CLIENT_DOCUMENTS";
  else if (!reportsDue(frequency, p.month) && items.every((i) => i.state !== "WAITING_CLIENT" && i.state !== "STAFF_TODO")) stage = "COLLECTED";
  else stage = "STAFF_WORK";
  const due = { documents: dueOn(p.year, p.month, deadlines.documentsDueDay), reports: reportsDue(frequency, p.month) ? dueOn(p.year, p.month, deadlines.reportsDueDay) : null };
  const overdue: string[] = [];
  if (due.documents && items.some((i) => i.state === "WAITING_CLIENT") && now > due.documents) overdue.push("Client documents overdue");
  if (p.requests.some((r) => r.status === "OPEN" && r.dueAt && r.dueAt < now)) overdue.push("Requested item past due");
  if (due.reports && stage !== "DELIVERED" && now > due.reports) overdue.push("Reports overdue");
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
    const summaries = await Promise.all(recent.map(async (r) => ({ ...r, summary: periodSummary(await loadPeriod(r.id), p.frequency, now, p) })));
    const current = summaries.find((r) => r.year === year && r.month === month) ?? null;
    const summary = current?.summary ?? null;
    // Earlier months still not finished also count as overdue.
    const olderOverdue = summaries.filter((r) => r !== current && r.summary.overdue.length > 0 && r.summary.stage !== "DELIVERED");
    const overdue = [...(summary?.overdue ?? []), ...olderOverdue.map((r) => `${periodLabel(p.frequency, r.year, r.month)} not finished`)];
    const missing = summaries.reduce((n, r) => n + (r.summary.stage === "DELIVERED" ? 0 : r.summary.missing), 0);
    const awaitingReview = summaries.some((r) => r.summary.stage === "AWAITING_REVIEW");
    const unread = await prisma.conversation.count({ where: { clientId: p.clientId, awaitingStaff: true } });
    const names = await ownerAndBusiness(p.clientId);
    rows.push({ profile: p, client: p.client, owner: names?.owner ?? null, business: names?.business ?? null, order: names?.order ?? 0, workLabel: periodLabel(p.frequency, year, month), reportMonth: reportsDue(p.frequency, month), periodId: current?.id ?? null, summary, stage: (summary?.stage ?? "NOT_OPENED") as Stage, overdue, missing, awaitingReview, unread });
  }
  // One row per business, grouped by owner (e.g. Steven Cox · Energy Solutions, then Steven Cox · Drive Time).
  const who = (r: { owner: string | null; business: string | null; client: { displayName: string } }) => (r.owner ?? r.business ?? r.client.displayName).toLowerCase();
  rows.sort((a, b) => who(a).localeCompare(who(b)) || a.order - b.order || (a.business ?? "").localeCompare(b.business ?? ""));
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
  const dl = { documentsDueDay: profile?.documentsDueDay ?? null, reportsDueDay: profile?.reportsDueDay ?? null };
  const prior = await Promise.all(periods.map(async (p) => ({ ...p, summary: periodSummary(await loadPeriod(p.id), freq, new Date(), dl) })));
  return { client, profile, periods: prior, period, summary: period ? periodSummary(period, freq, new Date(), dl) : null };
}

/** Reports waiting for the owner, across all clients. */
export function reportsAwaitingReview() {
  return prisma.document.findMany({
    where: { deletedAt: null, supersededAt: null, category: "BOOKKEEPING", reportType: { not: null }, reviewStatus: "AWAITING_REVIEW" },
    include: { client: { select: { id: true, displayName: true } }, period: { select: { id: true, year: true, month: true } } },
    orderBy: { submittedForReviewAt: "asc" },
  });
}
