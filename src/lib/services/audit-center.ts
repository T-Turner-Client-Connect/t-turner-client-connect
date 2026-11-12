import "server-only";
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from "pdf-lib";
import { prisma } from "@/lib/prisma";
import { audit } from "@/lib/audit";
import type { Actor } from "@/lib/auth/actor";
import { ForbiddenError } from "@/lib/auth/actor";
import type { PortalActor } from "@/lib/portal/session";
import { requireClientAccess } from "@/lib/portal/access";
import { ValidationError } from "./clients";
import { notifyClientUsers, portalUploadDocument, readDocumentBytes, staffUploadDocument } from "./documents";
import { canSendReturns } from "./return-senders";
import { isReportApprover } from "./bookkeeping-clients";
import { buildLetterPdf } from "@/lib/client-letters/pdf";
import { BK_PORTAL_COETHA_V1, type LetterBlock, type LetterTemplate } from "@/lib/client-letters/templates";
import { pdfToPages, parseReturnPages } from "@/lib/tax/return-parser/parse";
import { BUSINESS } from "@/lib/business";

/**
 * Tax Audit Preparation Center. An audit is a NoticeCase with an audit kind (FEDERAL or STATE): the
 * notice and every file stay ordinary Documents in the client's vault (never copied), and the case
 * adds the items under examination, the documents supporting each (links with the amount each
 * supports), the documents still needed (DocumentRequests the client answers in their Audit
 * section) and one printable audit package.
 *
 * Amounts: the reported amount is the filed return's; the supported amount is only the sum of what
 * the linked documents show. Neither is ever adjusted to agree with the other; a difference is
 * always shown and, when material, sent to Tabitha. Nothing is sent to an agency from here.
 */

export const AUDIT_KINDS = { FEDERAL: "Federal Audit", STATE: "State Audit" } as const;
export type AuditKind = keyof typeof AUDIT_KINDS;

export const AUDIT_STATUS = {
  NOTICE_RECEIVED: "Notice Received",
  COETHA_REVIEWING: "Coetha Reviewing",
  WAITING_ON_DOCUMENTS: "Waiting on Documents",
  DOCUMENTS_UNDER_REVIEW: "Documents Under Review",
  DISCREPANCY: "Discrepancy Identified",
  READY_FOR_FINAL_REVIEW: "Ready for Final Review",
  PACKAGE_READY: "Package Ready to Print",
  SUBMITTED: "Submitted by Client",
  AWAITING_AGENCY: "Awaiting Agency Response",
  CLOSED: "Audit Closed",
} as const;
export type AuditStatus = keyof typeof AUDIT_STATUS;
/** Statuses set by an event (release, submission) or by staff; the rest follow the records. */
const EVENT_STATUSES: AuditStatus[] = ["PACKAGE_READY", "SUBMITTED", "AWAITING_AGENCY", "CLOSED"];
/** A difference at or above this is material and goes to Tabitha. */
export const MATERIAL_CENTS = 100;

const STATES = new Set("AL AK AZ AR CA CO CT DE DC FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY".split(" "));
const usd = (c: number) => `${c < 0 ? "-" : ""}$${(Math.abs(c) / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const day = (s?: string | null) => (s && /^\d{4}-\d{2}-\d{2}$/.test(s) ? new Date(`${s}T12:00:00Z`) : null);
const clip = (s: unknown, n: number) => (typeof s === "string" ? s.trim().slice(0, n) || null : null);
export const parseMoney = (v: unknown): number | null => {
  if (v == null || v === "") return null;
  const s = String(v).replace(/[$,\s]/g, "");
  if (!/^-?\d+(\.\d{1,2})?$/.test(s)) throw new ValidationError("Enter the amount like 1234.56.");
  return Math.round(Number(s) * 100);
};

// --- Who may work an audit -------------------------------------------------------------------------

/** Staff who may work a client's audit: the same people who may send its tax returns. */
export async function assertAuditStaff(actor: Actor, clientId: string) {
  if (!(await canSendReturns(actor, clientId))) throw new ForbiddenError("Only Tabitha, an Admin, the client's assigned staff member, or staff with Tax → All clients can work this audit.");
}

async function caseFor(actor: Actor, caseId: string) {
  const c = await prisma.noticeCase.findUnique({ where: { id: caseId } });
  if (!c || !c.auditKind) throw new ValidationError("That audit wasn't found.");
  await assertAuditStaff(actor, c.clientId);
  return c;
}

// --- Office alerts ---------------------------------------------------------------------------------

/** A task for Tabitha (and the client's assigned staff member), once per key. */
async function alertOffice(caseId: string, key: string, title: string, details: string, opts: { urgent?: boolean; ownerOnly?: boolean } = {}) {
  const c = await prisma.noticeCase.findUniqueOrThrow({ where: { id: caseId }, include: { client: { select: { displayName: true, assignedToId: true } } } });
  const owner = await prisma.ownerAccess.findFirst({ where: { isPrimary: true, revokedAt: null }, select: { userId: true } });
  const creator = owner?.userId ?? (await prisma.user.findFirst({ where: { role: "ADMIN", active: true }, orderBy: { createdAt: "asc" }, select: { id: true } }))?.id;
  if (!creator) return;
  const marker = `[audit:${caseId}:${key}]`;
  if (await prisma.task.count({ where: { details: { contains: marker } } })) return;
  const who = [...new Set([owner?.userId, opts.ownerOnly ? null : c.client.assignedToId].filter(Boolean))] as string[];
  for (const assigneeId of who.length ? who : [null]) {
    await prisma.task.create({ data: { title: `${title} — ${c.client.displayName}`.slice(0, 200), details: `${details}\n\nOpen: /notices/${caseId} ${marker}`, clientId: c.clientId, assigneeId, createdById: creator, priority: opts.urgent ? "HIGH" : "NORMAL", dueAt: c.responseDueOn } });
  }
}

// --- Opening an audit ------------------------------------------------------------------------------

export type AuditOpenInput = { kind: string; stateCode?: string; taxYear: string; receivedOn?: string; responseDueOn?: string; message?: string };
type Upload = { bytes: Uint8Array; originalName: string };

function validateOpen(input: AuditOpenInput) {
  if (!(input.kind in AUDIT_KINDS)) throw new ValidationError("Choose Federal Audit or State Audit.");
  const stateCode = input.kind === "STATE" ? (input.stateCode ?? "").trim().toUpperCase() : null;
  if (input.kind === "STATE" && !STATES.has(stateCode!)) throw new ValidationError("Choose the state that sent the audit notice.");
  const taxYear = Number(input.taxYear);
  const thisYear = new Date().getFullYear();
  if (!Number.isInteger(taxYear) || taxYear < thisYear - 15 || taxYear > thisYear) throw new ValidationError("Choose the tax year on the audit notice.");
  const receivedOn = day(input.receivedOn), responseDueOn = day(input.responseDueOn);
  if (input.receivedOn && !receivedOn) throw new ValidationError("Enter the date you received it, or leave it blank.");
  if (input.responseDueOn && !responseDueOn) throw new ValidationError("Enter the response deadline, or leave it blank if you're not sure.");
  return { kind: input.kind as AuditKind, stateCode, taxYear, receivedOn, responseDueOn };
}

/** The filed return under examination: the jurisdiction's original return for the year, as stored. */
async function filedReturn(clientId: string, taxYear: number, kind: AuditKind, stateCode: string | null) {
  const f = await prisma.filingRecord.findFirst({ where: { clientId, taxYear, jurisdiction: kind === "FEDERAL" ? "FEDERAL" : stateCode ?? "-", filingType: "ORIGINAL" }, orderBy: { createdAt: "desc" }, select: { id: true } });
  return f?.id ?? null;
}

/** A client opens a Federal or State audit in their portal and uploads the notice. */
export async function openAuditByClient(user: PortalActor, clientId: string, input: AuditOpenInput, files: Upload[]) {
  await requireClientAccess(user.id, clientId, "upload");
  if (!files.length) throw new ValidationError("Choose the audit notice to upload (a photo or PDF).");
  if (files.length > 10) throw new ValidationError("Upload up to 10 files at a time.");
  const v = validateOpen(input);
  const kase = await prisma.noticeCase.create({
    data: {
      clientId, taxYear: v.taxYear, agency: v.kind === "FEDERAL" ? "IRS" : "STATE", agencyDetail: v.stateCode, auditKind: v.kind, stateCode: v.stateCode, auditStatus: "NOTICE_RECEIVED",
      receivedOn: v.receivedOn, responseDueOn: v.responseDueOn, clientMessage: clip(input.message, 2000), createdByPortalId: user.id, filingId: await filedReturn(clientId, v.taxYear, v.kind, v.stateCode),
    },
  });
  for (const f of files) {
    const doc = await portalUploadDocument(user, { clientId, year: v.taxYear, docType: "AGENCY_LETTER", title: `${AUDIT_KINDS[v.kind]} notice${v.stateCode ? ` (${v.stateCode})` : ""} — ${v.taxYear}`, bytes: f.bytes, originalName: f.originalName });
    await prisma.document.update({ where: { id: doc.id }, data: { noticeCaseId: kase.id } });
  }
  await audit(prisma, { actorId: null, action: "audit.opened_by_client", entityType: "NoticeCase", entityId: kase.id, clientId, details: { portalUserId: user.id, kind: v.kind, stateCode: v.stateCode, taxYear: v.taxYear, files: files.length } });
  await alertOffice(kase.id, "opened", `${AUDIT_KINDS[v.kind]}${v.stateCode ? ` (${v.stateCode})` : ""} notice uploaded for ${v.taxYear}`, "The client uploaded an audit notice in the portal.", { urgent: true });
  return kase;
}

/** Staff open an audit on the client's behalf (for example a notice that came to the office). */
export async function openAuditByStaff(actor: Actor, clientId: string, input: AuditOpenInput, files: Upload[]) {
  await assertAuditStaff(actor, clientId);
  const v = validateOpen(input);
  const kase = await prisma.noticeCase.create({
    data: {
      clientId, taxYear: v.taxYear, agency: v.kind === "FEDERAL" ? "IRS" : "STATE", agencyDetail: v.stateCode, auditKind: v.kind, stateCode: v.stateCode, auditStatus: "NOTICE_RECEIVED",
      receivedOn: v.receivedOn, responseDueOn: v.responseDueOn, clientMessage: clip(input.message, 2000), createdByStaffId: actor.id, filingId: await filedReturn(clientId, v.taxYear, v.kind, v.stateCode),
    },
  });
  for (const f of files) {
    const doc = await staffUploadDocument(actor, { clientId, category: "TAXES", year: v.taxYear, docType: "AGENCY_LETTER", title: `${AUDIT_KINDS[v.kind]} notice${v.stateCode ? ` (${v.stateCode})` : ""} — ${v.taxYear}`, visibility: "STAFF_ONLY", bytes: f.bytes, originalName: f.originalName });
    await prisma.document.update({ where: { id: doc.id }, data: { noticeCaseId: kase.id } });
  }
  await audit(prisma, { actorId: actor.id, action: "audit.opened_by_staff", entityType: "NoticeCase", entityId: kase.id, clientId, details: { kind: v.kind, stateCode: v.stateCode, taxYear: v.taxYear, files: files.length } });
  await alertOffice(kase.id, "opened", `${AUDIT_KINDS[v.kind]}${v.stateCode ? ` (${v.stateCode})` : ""} opened for ${v.taxYear}`, `Opened by ${actor.name}.`);
  return kase;
}

/** The notice details as verified (agency office, reference, type, deadline, how to respond). */
export async function updateAuditDetails(actor: Actor, caseId: string, input: { auditType?: string; noticeReference?: string; responseDueOn?: string; respondTo?: string; responseInstructions?: string }) {
  const c = await caseFor(actor, caseId);
  const responseDueOn = input.responseDueOn !== undefined ? day(input.responseDueOn) : c.responseDueOn;
  if (input.responseDueOn && !responseDueOn) throw new ValidationError("Enter the response deadline as a date.");
  const data = {
    auditType: input.auditType !== undefined ? clip(input.auditType, 120) : c.auditType,
    noticeReference: input.noticeReference !== undefined ? clip(input.noticeReference, 80) : c.noticeReference,
    responseDueOn,
    respondTo: input.respondTo !== undefined ? clip(input.respondTo, 600) : c.respondTo,
    responseInstructions: input.responseInstructions !== undefined ? clip(input.responseInstructions, 2000) : c.responseInstructions,
    updatedById: actor.id,
  };
  await prisma.noticeCase.update({ where: { id: caseId }, data });
  await audit(prisma, { actorId: actor.id, action: "audit.details_updated", entityType: "NoticeCase", entityId: caseId, clientId: c.clientId, details: { ...data, responseDueOn: responseDueOn?.toISOString() ?? null } });
}

// --- Items under examination, supporting documents, missing documents --------------------------------

export async function addAuditItem(actor: Actor, caseId: string, input: { label: string; schedule?: string; returnLine?: string; reported?: string; requested?: string }) {
  const c = await caseFor(actor, caseId);
  const label = clip(input.label, 200);
  if (!label) throw new ValidationError("Name the item under examination (for example Schedule A — charitable contributions).");
  const position = await prisma.auditItem.count({ where: { caseId } });
  const item = await prisma.auditItem.create({ data: { caseId, position, label, schedule: clip(input.schedule, 60), returnLine: clip(input.returnLine, 40), reportedCents: parseMoney(input.reported), requested: clip(input.requested, 1000), createdById: actor.id } });
  await audit(prisma, { actorId: actor.id, action: "audit.item_added", entityType: "AuditItem", entityId: item.id, clientId: c.clientId, details: { caseId, label, reportedCents: item.reportedCents } });
  await refreshAuditStatus(caseId);
  return item;
}

export async function updateAuditItem(actor: Actor, itemId: string, input: { label?: string; schedule?: string; returnLine?: string; reported?: string; requested?: string; explanation?: string; note?: string }) {
  const item = await prisma.auditItem.findUnique({ where: { id: itemId } });
  if (!item) throw new ValidationError("That audit item wasn't found.");
  const c = await caseFor(actor, item.caseId);
  const data = {
    label: input.label !== undefined ? clip(input.label, 200) ?? item.label : item.label,
    schedule: input.schedule !== undefined ? clip(input.schedule, 60) : item.schedule,
    returnLine: input.returnLine !== undefined ? clip(input.returnLine, 40) : item.returnLine,
    reportedCents: input.reported !== undefined ? parseMoney(input.reported) : item.reportedCents,
    requested: input.requested !== undefined ? clip(input.requested, 1000) : item.requested,
    explanation: input.explanation !== undefined ? clip(input.explanation, 3000) : item.explanation,
    note: input.note !== undefined ? clip(input.note, 1000) : item.note,
  };
  await prisma.auditItem.update({ where: { id: itemId }, data });
  await audit(prisma, { actorId: actor.id, action: "audit.item_updated", entityType: "AuditItem", entityId: itemId, clientId: c.clientId, details: { from: { reportedCents: item.reportedCents }, to: { reportedCents: data.reportedCents } } });
  await refreshAuditStatus(item.caseId);
}

/** Link a document already in this client's files to an item, with the amount it supports. Never copies it. */
export async function linkAuditDocument(actor: Actor | null, itemId: string, documentId: string, input: { amount?: string; note?: string }, by: "STAFF" | "COETHA" = "STAFF") {
  const item = await prisma.auditItem.findUnique({ where: { id: itemId }, include: { case: true } });
  if (!item) throw new ValidationError("That audit item wasn't found.");
  if (actor) await caseFor(actor, item.caseId);
  const doc = await prisma.document.findFirst({ where: { id: documentId, clientId: item.case.clientId, deletedAt: null }, select: { id: true, title: true } });
  if (!doc) throw new ValidationError("That document isn't in this client's files.");
  const amountCents = parseMoney(input.amount);
  const row = await prisma.auditItemDocument.upsert({
    where: { itemId_documentId: { itemId, documentId } },
    create: { itemId, documentId, amountCents, note: clip(input.note, 500), addedById: actor?.id ?? null, addedBy: by },
    update: { amountCents, note: clip(input.note, 500), addedById: actor?.id ?? null, addedBy: by },
  });
  await audit(prisma, { actorId: actor?.id ?? null, action: "audit.document_linked", entityType: "AuditItem", entityId: itemId, clientId: item.case.clientId, details: { documentId, title: doc.title, amountCents, by } });
  // A request this document answered is now reviewed.
  await prisma.documentRequest.updateMany({ where: { auditItemId: itemId, status: "SUBMITTED", documents: { some: { id: documentId } } }, data: { status: "ACCEPTED" } });
  await refreshAuditStatus(item.caseId);
  return row;
}

export async function unlinkAuditDocument(actor: Actor, itemId: string, documentId: string) {
  const item = await prisma.auditItem.findUnique({ where: { id: itemId } });
  if (!item) throw new ValidationError("That audit item wasn't found.");
  const c = await caseFor(actor, item.caseId);
  await prisma.auditItemDocument.deleteMany({ where: { itemId, documentId } });
  await audit(prisma, { actorId: actor.id, action: "audit.document_unlinked", entityType: "AuditItem", entityId: itemId, clientId: c.clientId, details: { documentId } });
  await refreshAuditStatus(item.caseId);
}

/** Ask the client for a missing document for one item; it appears in their Audit section with an upload. */
export async function requestAuditDocument(actor: Actor | null, itemId: string, input: { title: string; instructions?: string }) {
  const item = await prisma.auditItem.findUnique({ where: { id: itemId }, include: { case: true } });
  if (!item) throw new ValidationError("That audit item wasn't found.");
  if (actor) await caseFor(actor, item.caseId);
  const title = clip(input.title, 200);
  if (!title) throw new ValidationError("Say which document is needed.");
  const draftKey = `audit:${itemId}:${title.toLowerCase()}`.slice(0, 190);
  const existing = await prisma.documentRequest.findUnique({ where: { clientId_draftKey: { clientId: item.case.clientId, draftKey } } });
  if (existing) return existing;
  const createdById = actor?.id ?? (await prisma.ownerAccess.findFirst({ where: { isPrimary: true, revokedAt: null }, select: { userId: true } }))?.userId;
  if (!createdById) throw new ValidationError("No office user to send the request from.");
  const r = await prisma.documentRequest.create({
    data: {
      clientId: item.case.clientId, title, instructions: clip(input.instructions, 1000), reason: `Needed for your ${AUDIT_KINDS[item.case.auditKind as AuditKind] ?? "audit"} (${item.case.taxYear}): ${item.label}`,
      category: "TAXES", kind: "SUPPORTING", taxYear: item.case.taxYear, status: "OPEN", source: actor ? "STAFF" : "COETHA", draftKey, auditItemId: itemId, createdById, dueAt: item.case.responseDueOn,
    },
  });
  await audit(prisma, { actorId: actor?.id ?? null, action: "audit.document_requested", entityType: "DocumentRequest", entityId: r.id, clientId: item.case.clientId, details: { itemId, title } });
  await notifyClientUsers(item.case.clientId, "DOCUMENT_REQUEST", `audit-request:${r.id}`);
  await refreshAuditStatus(item.caseId);
  return r;
}

/** The client uploads a requested document (or another document for the audit) in their Audit section. */
export async function uploadForAudit(user: PortalActor, clientId: string, caseId: string, requestId: string | null, files: Upload[]) {
  const c = await prisma.noticeCase.findFirst({ where: { id: caseId, clientId, auditKind: { not: null } } });
  if (!c) throw new ValidationError("That audit wasn't found.");
  await requireClientAccess(user.id, clientId, "upload");
  if (!files.length) throw new ValidationError("Choose a file to upload.");
  if (requestId && !(await prisma.documentRequest.count({ where: { id: requestId, clientId, auditItem: { caseId } } }))) throw new ValidationError("That request isn't part of this audit.");
  const docs = [];
  for (const f of files.slice(0, 10)) {
    const doc = await portalUploadDocument(user, { clientId, requestId, year: c.taxYear ?? "unsure", title: `Audit document — ${c.taxYear ?? ""}`.trim(), bytes: f.bytes, originalName: f.originalName });
    await prisma.document.update({ where: { id: doc.id }, data: { noticeCaseId: caseId } });
    docs.push(doc);
  }
  await audit(prisma, { actorId: null, action: "audit.client_uploaded", entityType: "NoticeCase", entityId: caseId, clientId, details: { portalUserId: user.id, requestId, files: docs.length } });
  await refreshAuditStatus(caseId);
  return docs;
}

/** Staff upload a document on the client's behalf, straight onto an item. */
export async function staffUploadForAudit(actor: Actor, itemId: string, file: Upload, input: { amount?: string; note?: string }) {
  const item = await prisma.auditItem.findUnique({ where: { id: itemId }, include: { case: true } });
  if (!item) throw new ValidationError("That audit item wasn't found.");
  await caseFor(actor, item.caseId);
  const doc = await staffUploadDocument(actor, { clientId: item.case.clientId, category: "TAXES", year: item.case.taxYear ?? undefined, title: `Audit support — ${item.label}`.slice(0, 200), visibility: "STAFF_ONLY", bytes: file.bytes, originalName: file.originalName });
  await prisma.document.update({ where: { id: doc.id }, data: { noticeCaseId: item.caseId } });
  await linkAuditDocument(actor, itemId, doc.id, input);
  return doc;
}

// --- Reconciliation and status ---------------------------------------------------------------------

export type ItemCheck = { state: "NOT_READ" | "MISSING" | "SUPPORTED" | "DIFFERENCE"; supportedCents: number | null; differenceCents: number | null };

/** Reported vs supported for one item. Supported is only what linked documents show; nothing is forced to agree. */
export function checkItem(reportedCents: number | null, links: { amountCents: number | null }[]): ItemCheck {
  const counted = links.filter((l) => l.amountCents != null);
  const supportedCents = counted.length ? counted.reduce((n, l) => n + l.amountCents!, 0) : null;
  if (!links.length) return { state: "MISSING", supportedCents: null, differenceCents: reportedCents };
  if (reportedCents == null) return { state: "NOT_READ", supportedCents, differenceCents: null };
  const differenceCents = reportedCents - (supportedCents ?? 0);
  return { state: differenceCents === 0 ? "SUPPORTED" : "DIFFERENCE", supportedCents, differenceCents };
}

/** Sets the status from the records (unless an event or staff set a later one) and alerts on changes. */
export async function refreshAuditStatus(caseId: string) {
  const c = await prisma.noticeCase.findUnique({ where: { id: caseId }, include: { items: { include: { documents: true, requests: { select: { status: true } } } } } });
  if (!c || !c.auditKind) return null;
  if (c.auditStatus && EVENT_STATUSES.includes(c.auditStatus as AuditStatus)) return c.auditStatus as AuditStatus;
  const checks = c.items.map((i) => ({ i, k: checkItem(i.reportedCents, i.documents) }));
  const requests = c.items.flatMap((i) => i.requests);
  const material = checks.filter(({ k }) => k.state === "DIFFERENCE" && Math.abs(k.differenceCents ?? 0) >= MATERIAL_CENTS);
  let next: AuditStatus;
  if (requests.some((r) => r.status === "SUBMITTED")) next = "DOCUMENTS_UNDER_REVIEW";
  else if (requests.some((r) => r.status === "OPEN")) next = "WAITING_ON_DOCUMENTS";
  else if (material.length) next = "DISCREPANCY";
  else if (c.items.length && checks.every(({ k }) => k.state === "SUPPORTED" || (k.state === "DIFFERENCE" && Math.abs(k.differenceCents ?? 0) < MATERIAL_CENTS))) next = "READY_FOR_FINAL_REVIEW";
  else if (c.items.length) next = "COETHA_REVIEWING";
  else next = "NOTICE_RECEIVED";
  if (next !== c.auditStatus) {
    await prisma.noticeCase.update({ where: { id: caseId }, data: { auditStatus: next, status: c.status === "RECEIVED" && next !== "NOTICE_RECEIVED" ? "UNDER_REVIEW" : c.status } });
    await audit(prisma, { actorId: null, action: "audit.status_changed", entityType: "NoticeCase", entityId: caseId, clientId: c.clientId, details: { from: c.auditStatus, to: next } });
    if (next === "DISCREPANCY") {
      await alertOffice(caseId, `discrepancy:${material.map(({ i, k }) => `${i.id}=${k.differenceCents}`).join(",")}`, "Audit discrepancy identified", material.map(({ i, k }) => `${i.label}: reported ${usd(i.reportedCents ?? 0)}, supported ${usd(k.supportedCents ?? 0)}, difference ${usd(k.differenceCents ?? 0)}`).join("\n"), { urgent: true, ownerOnly: true });
    }
    if (next === "WAITING_ON_DOCUMENTS") await alertOffice(caseId, `missing:${requests.length}`, "Audit documents missing", "Supporting documents were requested from the client.");
    if (next === "READY_FOR_FINAL_REVIEW") await alertOffice(caseId, `review-done:${c.items.length}`, "Audit document review complete", "Every item is supported. Build the package and release it.", { ownerOnly: true });
  }
  return next;
}

/** Staff-set statuses after the package goes out. */
export async function setAuditStatus(actor: Actor, caseId: string, status: string) {
  const c = await caseFor(actor, caseId);
  if (status !== "AWAITING_AGENCY" && status !== "CLOSED") throw new ValidationError("Choose Awaiting Agency Response or Audit Closed.");
  await prisma.noticeCase.update({ where: { id: caseId }, data: { auditStatus: status, status: status === "CLOSED" ? "CLOSED" : "RESPONDED", updatedById: actor.id } });
  await audit(prisma, { actorId: actor.id, action: "audit.status_changed", entityType: "NoticeCase", entityId: caseId, clientId: c.clientId, details: { from: c.auditStatus, to: status } });
}

// --- Views -------------------------------------------------------------------------------------------

const docSelect = { id: true, title: true, docType: true, year: true, createdAt: true, scanStatus: true, visibility: true, uploadedByPortalId: true, file: { select: { originalName: true, mimeType: true } } } as const;

export async function auditCaseView(caseId: string) {
  const c = await prisma.noticeCase.findUnique({
    where: { id: caseId },
    include: {
      client: { select: { id: true, displayName: true } },
      documents: { where: { deletedAt: null }, select: docSelect, orderBy: { createdAt: "asc" } },
      items: { orderBy: { position: "asc" }, include: { documents: { include: { document: { select: docSelect } } }, requests: { select: { id: true, title: true, instructions: true, status: true, documents: { where: { deletedAt: null }, select: docSelect } } } } },
    },
  });
  if (!c || !c.auditKind) return null;
  const items = c.items.map((i) => ({ ...i, check: checkItem(i.reportedCents, i.documents) }));
  const received = new Set([...items.flatMap((i) => i.documents.map((d) => d.documentId)), ...items.flatMap((i) => i.requests.flatMap((r) => r.documents.map((d) => d.id)))]);
  const totals = {
    items: items.length,
    received: received.size,
    verified: items.reduce((n, i) => n + i.documents.filter((d) => d.amountCents != null).length, 0),
    missing: items.reduce((n, i) => n + i.requests.filter((r) => r.status === "OPEN").length, 0),
    discrepancies: items.filter((i) => i.check.state === "DIFFERENCE").length,
  };
  const pkg = c.packageDocumentId ? await prisma.document.findUnique({ where: { id: c.packageDocumentId }, select: { id: true, version: true, createdAt: true, visibility: true } }) : null;
  return { ...c, items, totals, package: pkg };
}

export async function staffAuditCase(actor: Actor, caseId: string) {
  await caseFor(actor, caseId);
  const v = (await auditCaseView(caseId))!;
  const files = await prisma.document.findMany({ where: { clientId: v.clientId, deletedAt: null, OR: [{ year: v.taxYear }, { noticeCaseId: caseId }] }, select: docSelect, orderBy: { createdAt: "desc" }, take: 300 });
  const filing = v.filingId ? await prisma.filingRecord.findUnique({ where: { id: v.filingId }, select: { returnType: true, jurisdiction: true, filingStatus: true } }) : null;
  return { ...v, files, filing, canRelease: await isReportApprover(actor) };
}

/** Every audit across clients the person may work, soonest deadline first. */
export async function auditList(actor: Actor) {
  const cases = await prisma.noticeCase.findMany({ where: { auditKind: { not: null } }, include: { client: { select: { id: true, displayName: true } }, items: { include: { documents: { select: { amountCents: true } }, requests: { select: { status: true } } } } }, orderBy: [{ responseDueOn: "asc" }, { createdAt: "asc" }] });
  const out = [];
  for (const c of cases) {
    if (!(await canSendReturns(actor, c.clientId))) continue;
    out.push({
      id: c.id, client: c.client, kind: c.auditKind as AuditKind, stateCode: c.stateCode, taxYear: c.taxYear, status: (c.auditStatus ?? "NOTICE_RECEIVED") as AuditStatus, responseDueOn: c.responseDueOn,
      items: c.items.map((i) => i.label),
      received: c.items.reduce((n, i) => n + i.documents.length, 0),
      verified: c.items.reduce((n, i) => n + i.documents.filter((d) => d.amountCents != null).length, 0),
      missing: c.items.reduce((n, i) => n + i.requests.filter((r) => r.status === "OPEN").length, 0),
      packageReady: !!c.packageDocumentId,
    });
  }
  return out;
}

/** Client side: their audits (never another taxpayer's), with what's needed and the released package only. */
export async function portalAudits(user: PortalActor, clientId: string) {
  await requireClientAccess(user.id, clientId, "tax");
  const cases = await prisma.noticeCase.findMany({ where: { clientId, auditKind: { not: null } }, orderBy: { createdAt: "desc" } });
  const out = [];
  for (const c of cases) out.push(await portalAuditCase(user, clientId, c.id));
  return out;
}

export async function portalAuditCase(user: PortalActor, clientId: string, caseId: string) {
  await requireClientAccess(user.id, clientId, "tax");
  const v = await auditCaseView(caseId);
  if (!v || v.clientId !== clientId) throw new ValidationError("That audit wasn't found.");
  const released = !!v.releasedAt && v.package?.visibility === "PUBLISHED";
  return {
    id: v.id, kind: v.auditKind as AuditKind, stateCode: v.stateCode, taxYear: v.taxYear, status: (v.auditStatus ?? "NOTICE_RECEIVED") as AuditStatus, responseDueOn: v.responseDueOn,
    respondTo: released ? v.respondTo : null, responseInstructions: released ? v.responseInstructions : null,
    needed: v.items.flatMap((i) => i.requests.filter((r) => r.status === "OPEN").map((r) => ({ id: r.id, title: r.title, instructions: r.instructions, item: i.label }))),
    received: [...v.documents.filter((d) => d.uploadedByPortalId || d.docType === "AGENCY_LETTER"), ...v.items.flatMap((i) => i.requests.flatMap((r) => r.documents))].filter((d, i, a) => a.findIndex((x) => x.id === d.id) === i).map((d) => ({ id: d.id, title: d.title, at: d.createdAt })),
    items: v.items.map((i) => i.label),
    packageReady: released,
    submittedAt: v.submittedAt,
  };
}

// --- The audit package -----------------------------------------------------------------------------

const NAVY = rgb(0.04, 0.1, 0.27);
const safe = (t: string) => t.replace(/[^\x20-\x7E -ÿ–—•‘’“”…·]/g, "?");
const FORM_OF: [RegExp, string][] = [[/schedule a\b/i, "SA"], [/schedule 1\b/i, "S1"], [/schedule 2\b/i, "S2"], [/schedule 3\b/i, "S3"], [/schedule 8812|8812/i, "S8812"], [/form 1040\b|^1040$/i, "F1040"], [/form 40\b|alabama/i, "AL40"]];

/** Simple text pages (index, reconciliation, explanations) in the firm's style. */
async function textPages(pdf: PDFDocument, title: string, lines: { text: string; bold?: boolean; indent?: number }[]) {
  const font = await pdf.embedFont(StandardFonts.Helvetica), bold = await pdf.embedFont(StandardFonts.HelveticaBold), serif = await pdf.embedFont(StandardFonts.TimesRomanBold);
  const W = 612, H = 792, M = 54;
  let page: PDFPage = pdf.addPage([W, H]);
  let y = H - M;
  const head = () => {
    page.drawText(safe(title), { x: M, y, size: 16, font: serif, color: NAVY });
    y -= 10;
    page.drawLine({ start: { x: M, y }, end: { x: W - M, y }, thickness: 1.2, color: rgb(0.78, 0.62, 0.16) });
    y -= 20;
  };
  head();
  const wrap = (t: string, f: PDFFont, size: number, width: number) => {
    const words = safe(t).split(/\s+/), out: string[] = [];
    let cur = "";
    for (const w of words) { const next = cur ? `${cur} ${w}` : w; if (f.widthOfTextAtSize(next, size) > width && cur) { out.push(cur); cur = w; } else cur = next; }
    if (cur) out.push(cur);
    return out;
  };
  for (const l of lines) {
    const f = l.bold ? bold : font, x = M + (l.indent ?? 0);
    for (const row of wrap(l.text, f, 10, W - M - x)) {
      if (y < M + 20) { page = pdf.addPage([W, H]); y = H - M; head(); }
      page.drawText(row, { x, y, size: 10, font: f, color: rgb(0.1, 0.1, 0.1) });
      y -= 14;
    }
    y -= 2;
  }
}

/**
 * One printable PDF: cover letter on letterhead → document index → the relevant return pages →
 * supporting documents in item order → reconciliation summary → explanations. Saved as a staff-only
 * draft (a new version replaces the old) until Tabitha releases it.
 */
export async function buildAuditPackage(actor: Actor, caseId: string) {
  const c = await caseFor(actor, caseId);
  const v = (await auditCaseView(caseId))!;
  if (!v.items.length) throw new ValidationError("Add the items under examination first.");
  const client = await prisma.client.findUniqueOrThrow({ where: { id: c.clientId }, select: { displayName: true } });
  const agency = c.auditKind === "FEDERAL" ? "Internal Revenue Service" : `${c.stateCode} Department of Revenue`;
  const today = new Date().toLocaleDateString("en-US", { timeZone: "America/Chicago", dateStyle: "long" });

  // Exhibits: the return pages, then each item's documents (clean scans only), in item order.
  const exhibits: { title: string; item: string; bytes: Uint8Array; mime: string }[] = [];
  const left: string[] = [];
  const ret = c.filingId ? await prisma.document.findFirst({ where: { clientId: c.clientId, filingId: c.filingId, filingDocType: "RETURN", deletedAt: null, supersededAt: null }, include: { file: true }, orderBy: { createdAt: "desc" } }) : null;
  let returnNote = "The filed return is not on file in Client Connect; attach it before submitting.";
  if (ret?.file && ret.scanStatus === "CLEAN") {
    const bytes = await readDocumentBytes(ret.file);
    if (bytes) {
      let pages: number[] | null = null;
      const parsed = await pdfToPages(bytes).then((p) => (p ? parseReturnPages(p) : null)).catch(() => null);
      const wanted = new Set(v.items.flatMap((i) => FORM_OF.filter(([re]) => re.test(i.schedule ?? i.label)).map(([, f]) => f)));
      if (parsed && wanted.size) {
        const forms = parsed.forms as Record<string, number[]>;
        const set = new Set<number>([...(forms.F1040 ?? []).slice(0, 2), ...[...wanted].flatMap((f) => forms[f] ?? [])]);
        if (set.size) pages = [...set].sort((a, b) => a - b);
      }
      if (pages) {
        const src = await PDFDocument.load(bytes, { ignoreEncryption: true });
        const out = await PDFDocument.create();
        for (const p of await out.copyPages(src, pages.map((n) => n - 1).filter((n) => n >= 0 && n < src.getPageCount()))) out.addPage(p);
        exhibits.push({ title: `Filed return — relevant pages (${pages.join(", ")})`, item: "Tax return", bytes: await out.save(), mime: "application/pdf" });
      } else exhibits.push({ title: "Filed return", item: "Tax return", bytes, mime: "application/pdf" });
      returnNote = "";
    }
  }
  for (const i of v.items) {
    for (const l of i.documents) {
      const d = await prisma.document.findUnique({ where: { id: l.documentId }, include: { file: true } });
      if (!d?.file || d.deletedAt) continue;
      if (d.scanStatus !== "CLEAN") { left.push(`${d.title} (${i.label}): not included until its virus scan is clean`); continue; }
      const bytes = await readDocumentBytes(d.file);
      if (!bytes) { left.push(`${d.title}: file unavailable`); continue; }
      if (!["application/pdf", "image/png", "image/jpeg"].includes(d.file.mimeType)) { left.push(`${d.title}: not a printable file (PDF, PNG or JPEG)`); continue; }
      exhibits.push({ title: d.title, item: i.label, bytes, mime: d.file.mimeType });
    }
  }

  // Cover letter on letterhead.
  const t: LetterTemplate = {
    version: "audit-response-v1",
    documentTitle: `Audit response — ${v.taxYear}`,
    label: "Audit response",
    letterhead: BK_PORTAL_COETHA_V1.letterhead,
    reLine: safe(`Re: ${client.displayName} — ${c.auditKind === "FEDERAL" ? "Federal" : `${c.stateCode} state`} examination, tax year ${c.taxYear}${c.noticeReference ? `, notice ${c.noticeReference}` : ""}`),
    blocks: [
      { text: `On behalf of our client, ${client.displayName}, we are responding to your ${c.auditType ? `${c.auditType} ` : ""}examination notice${c.noticeReference ? ` ${c.noticeReference}` : ""} for tax year ${c.taxYear}. Enclosed are the documents supporting the items under examination, organized in the order of the items listed below, with an index and a reconciliation of the amounts reported on the return to the amounts supported by the enclosed records.` },
      { lead: "Items addressed in this response", bullets: v.items.map((i, n) => `${n + 1}. ${i.label}${i.schedule ? ` (${i.schedule}${i.returnLine ? `, line ${i.returnLine}` : ""})` : ""}`) },
      { text: "Please contact our office with any questions about this response." },
    ] as LetterBlock[],
    closing: "Sincerely,",
    signature: BUSINESS.legalName,
    email: { subject: "", heading: "" },
  };
  const cover = await buildLetterPdf(t, { date: today, businessName: agency, ownerName: c.respondTo?.split("\n")[0] || "Examination", ownerFirstName: "Sir or Madam" });

  const pdf = await PDFDocument.create();
  pdf.setTitle(safe(`Audit package — ${client.displayName} — ${c.taxYear}`));
  pdf.setAuthor(BUSINESS.legalName);
  for (const p of await pdf.copyPages(await PDFDocument.load(cover), [...Array((await PDFDocument.load(cover)).getPageCount()).keys()])) pdf.addPage(p);

  await textPages(pdf, "Audit Document Index", [
    { text: `Taxpayer: ${client.displayName} · Tax year ${c.taxYear} · ${c.auditKind === "FEDERAL" ? "Federal (IRS)" : `State (${c.stateCode})`}${c.noticeReference ? ` · Notice ${c.noticeReference}` : ""}` },
    ...exhibits.map((e, n) => ({ text: `Exhibit ${n + 1}: ${e.title} — ${e.item}` })),
    ...(returnNote ? [{ text: returnNote, bold: true }] : []),
    ...(left.length ? [{ text: "Listed but not enclosed:", bold: true }, ...left.map((l) => ({ text: l, indent: 12 }))] : []),
  ]);

  // Exhibits, each page stamped.
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  for (const [n, e] of exhibits.entries()) {
    const before = pdf.getPageCount();
    try {
      if (e.mime === "application/pdf") {
        const src = await PDFDocument.load(e.bytes, { ignoreEncryption: true });
        for (const p of await pdf.copyPages(src, src.getPageIndices())) pdf.addPage(p);
      } else {
        const img = e.mime === "image/png" ? await pdf.embedPng(e.bytes) : await pdf.embedJpg(e.bytes);
        const W = 612, H = 792, M = 36, s = Math.min((W - 2 * M) / img.width, (H - 2 * M - 20) / img.height, 1);
        const page = pdf.addPage([W, H]);
        page.drawImage(img, { x: (W - img.width * s) / 2, y: (H - img.height * s) / 2, width: img.width * s, height: img.height * s });
      }
    } catch { left.push(`${e.title}: could not be read`); continue; }
    for (let p = before; p < pdf.getPageCount(); p++) pdf.getPage(p).drawText(safe(`Exhibit ${n + 1} · ${e.title}`).slice(0, 110), { x: 36, y: 14, size: 8, font, color: rgb(0.3, 0.3, 0.3) });
  }

  // Reconciliation summary and explanations.
  await textPages(pdf, "Reconciliation Summary", [
    { text: "Amounts reported on the filed return compared with the amounts supported by the enclosed documents. Differences are shown as they are; no amount has been adjusted.", indent: 0 },
    ...v.items.flatMap((i, n) => [
      { text: `${n + 1}. ${i.label}`, bold: true },
      { text: `Reported on the return: ${i.reportedCents != null ? usd(i.reportedCents) : "not stated"} · Supported by documents: ${i.check.supportedCents != null ? usd(i.check.supportedCents) : "none counted"} · Difference: ${i.check.differenceCents != null ? usd(i.check.differenceCents) : "—"}`, indent: 12 },
      ...i.documents.map((d) => ({ text: `${d.document.title}${d.amountCents != null ? `: ${usd(d.amountCents)}` : " (supporting, amount not counted)"}`, indent: 24 })),
    ]),
  ]);
  const explained = v.items.filter((i) => i.explanation);
  if (explained.length) await textPages(pdf, "Additional Explanations", explained.flatMap((i) => [{ text: i.label, bold: true }, { text: i.explanation! }]));
  if (c.respondTo || c.responseInstructions || c.responseDueOn) {
    await textPages(pdf, "How to Submit This Response", [
      ...(c.responseDueOn ? [{ text: `Respond by: ${c.responseDueOn.toLocaleDateString("en-US", { timeZone: "UTC", dateStyle: "long" })}`, bold: true }] : []),
      ...(c.respondTo ? [{ text: "Send to:", bold: true }, ...c.respondTo.split("\n").map((l) => ({ text: l, indent: 12 }))] : []),
      ...(c.responseInstructions ? [{ text: "Instructions from the notice:", bold: true }, { text: c.responseInstructions, indent: 12 }] : []),
      { text: "Our office does not send this response to the agency. Submit it as the notice instructs and keep proof of submission; upload it in your Client Connect Audit section." },
    ]);
  }

  const bytes = await pdf.save();
  let doc;
  try {
    doc = await staffUploadDocument(actor, { clientId: c.clientId, category: "TAXES", year: c.taxYear ?? undefined, docType: "AUDIT_PACKAGE", title: `Audit package — ${c.auditKind === "FEDERAL" ? "Federal" : c.stateCode} ${c.taxYear}`, visibility: "STAFF_ONLY", bytes, originalName: `audit-package-${c.taxYear}.pdf`, notify: false });
  } catch (err) {
    // Nothing changed since the last build: the same package is already saved.
    if (err instanceof ValidationError && /already saved/.test(err.message) && c.packageDocumentId) return { documentId: c.packageDocumentId, exhibits: exhibits.length, notIncluded: left, unchanged: true };
    throw err;
  }
  const prev = c.packageDocumentId ? await prisma.document.findUnique({ where: { id: c.packageDocumentId }, select: { id: true, version: true } }) : null;
  await prisma.$transaction([
    ...(prev ? [prisma.document.update({ where: { id: prev.id }, data: { supersededAt: new Date() } })] : []),
    prisma.document.update({ where: { id: doc.id }, data: { noticeCaseId: caseId, version: (prev?.version ?? 0) + 1, replacesId: prev?.id ?? null } }),
    // A new version waits for Tabitha's release again (a status the release set goes back to final review).
    prisma.noticeCase.update({ where: { id: caseId }, data: { packageDocumentId: doc.id, releasedAt: null, releasedById: null, ...(c.auditStatus === "PACKAGE_READY" ? { auditStatus: "READY_FOR_FINAL_REVIEW" } : {}) } }),
  ]);
  await audit(prisma, { actorId: actor.id, action: "audit.package_built", entityType: "NoticeCase", entityId: caseId, clientId: c.clientId, details: { documentId: doc.id, exhibits: exhibits.length, notIncluded: left.length } });
  await alertOffice(caseId, `package:${doc.id}`, "Audit package prepared", `Version ${(prev?.version ?? 0) + 1}, ${exhibits.length} exhibit${exhibits.length === 1 ? "" : "s"}. Review and release it to the client.`, { ownerOnly: true });
  return { documentId: doc.id, exhibits: exhibits.length, notIncluded: left };
}

/** Tabitha releases the package: the client sees "Audit Package — Ready to Print". */
export async function releaseAuditPackage(actor: Actor, caseId: string) {
  const c = await caseFor(actor, caseId);
  if (!(await isReportApprover(actor))) throw new ForbiddenError("Only Tabitha releases an audit package to the client.");
  if (!c.packageDocumentId) throw new ValidationError("Build the audit package first.");
  const now = new Date();
  await prisma.$transaction([
    prisma.document.update({ where: { id: c.packageDocumentId }, data: { visibility: "PUBLISHED", publishedAt: now } }),
    prisma.noticeCase.update({ where: { id: caseId }, data: { releasedAt: now, releasedById: actor.id, auditStatus: "PACKAGE_READY" } }),
  ]);
  await audit(prisma, { actorId: actor.id, action: "audit.package_released", entityType: "NoticeCase", entityId: caseId, clientId: c.clientId, details: { documentId: c.packageDocumentId } });
  await notifyClientUsers(c.clientId, "AUDIT_PACKAGE_READY", c.packageDocumentId);
}

/** The released package for the client (and a record of each view or download). */
export async function portalAuditPackage(user: PortalActor, clientId: string, caseId: string, mode: "view" | "download") {
  await requireClientAccess(user.id, clientId, "tax");
  const c = await prisma.noticeCase.findFirst({ where: { id: caseId, clientId, auditKind: { not: null } } });
  if (!c?.packageDocumentId || !c.releasedAt) throw new ValidationError("The audit package isn't ready yet.");
  const d = await prisma.document.findFirst({ where: { id: c.packageDocumentId, clientId, visibility: "PUBLISHED", deletedAt: null }, include: { file: true } });
  if (!d?.file) throw new ValidationError("The audit package isn't ready yet.");
  const bytes = await readDocumentBytes(d.file);
  if (!bytes) throw new ValidationError("The audit package isn't available right now.");
  await audit(prisma, { actorId: null, action: mode === "download" ? "audit.package_downloaded" : "audit.package_viewed", entityType: "NoticeCase", entityId: caseId, clientId, details: { portalUserId: user.id, documentId: d.id } });
  if (mode === "download") await alertOffice(caseId, `downloaded:${d.id}`, "Client downloaded the audit package", "Downloading is not submission; the status changes only when the client records the submission.", { ownerOnly: true });
  return { bytes, name: `audit-package-${c.taxYear}.pdf` };
}

/** The client records that they submitted the response, with optional proof (a receipt, confirmation). */
export async function recordAuditSubmission(user: PortalActor, clientId: string, caseId: string, input: { submittedOn: string; method: string }, proof: Upload[]) {
  await requireClientAccess(user.id, clientId, "upload");
  const c = await prisma.noticeCase.findFirst({ where: { id: caseId, clientId, auditKind: { not: null } } });
  if (!c) throw new ValidationError("That audit wasn't found.");
  if (!c.releasedAt) throw new ValidationError("The audit package hasn't been released yet.");
  const on = day(input.submittedOn);
  if (!on) throw new ValidationError("Enter the date you submitted the response.");
  const method = clip(input.method, 120);
  if (!method) throw new ValidationError("Say how you submitted it (mail, fax, the agency's portal...).");
  for (const f of proof.slice(0, 5)) {
    const doc = await portalUploadDocument(user, { clientId, year: c.taxYear ?? "unsure", docType: "AGENCY_LETTER", title: `Audit response — proof of submission (${c.taxYear})`, bytes: f.bytes, originalName: f.originalName });
    await prisma.document.update({ where: { id: doc.id }, data: { noticeCaseId: caseId } });
  }
  await prisma.noticeCase.update({ where: { id: caseId }, data: { submittedAt: on, submittedByPortalId: user.id, submissionMethod: method, auditStatus: "SUBMITTED", status: "RESPONDED" } });
  await audit(prisma, { actorId: null, action: "audit.submitted_by_client", entityType: "NoticeCase", entityId: caseId, clientId, details: { portalUserId: user.id, submittedOn: input.submittedOn, method, proofFiles: proof.length } });
  await alertOffice(caseId, "submitted", "Client recorded the audit response as submitted", `Submitted ${input.submittedOn} by ${method}${proof.length ? `; ${proof.length} proof file${proof.length === 1 ? "" : "s"} uploaded` : "; no proof uploaded"}.`);
}

/** Daily: audits whose response deadline is 14 or 7 days away (once each) or passed. */
export async function auditDeadlineAlerts(now = new Date()) {
  const cases = await prisma.noticeCase.findMany({ where: { auditKind: { not: null }, responseDueOn: { not: null }, auditStatus: { notIn: ["SUBMITTED", "AWAITING_AGENCY", "CLOSED"] } }, select: { id: true, responseDueOn: true } });
  let sent = 0;
  for (const c of cases) {
    const days = Math.ceil((c.responseDueOn!.getTime() - now.getTime()) / 86_400_000);
    const key = days < 0 ? "passed" : days <= 7 ? "7" : days <= 14 ? "14" : null;
    if (!key) continue;
    await alertOffice(c.id, `deadline:${key}`, days < 0 ? "Audit response deadline passed" : `Audit response due in ${days} day${days === 1 ? "" : "s"}`, `Deadline ${c.responseDueOn!.toISOString().slice(0, 10)}.`, { urgent: true });
    sent++;
  }
  return { checked: cases.length, alerted: sent };
}
