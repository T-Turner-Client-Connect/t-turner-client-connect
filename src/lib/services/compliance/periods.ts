import "server-only";
import { createHash } from "node:crypto";
import type { ComplianceFilingPeriod, Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { audit } from "@/lib/audit";
import { ForbiddenError, type Actor } from "@/lib/auth/actor";
import type { PortalActor } from "@/lib/portal/session";
import { ValidationError } from "@/lib/services/clients";
import { staffUploadDocument } from "@/lib/services/documents";
import { addMonths, adjustDue } from "@/lib/compliance/dates";
import { assertComplianceManage } from "./access";
import { COMPLETE_FILING, createNextPeriod, effectiveDue, isComplete } from "./obligations";

/**
 * Filing periods: preparation, the client approval gate, and evidence.
 *
 * - Filing status and payment status are separate fields and change separately.
 * - Submitted needs a confirmation number OR uploaded filing evidence, plus the verifier and time.
 *   It is refused while the obligation requires client approval and the current return version
 *   isn't approved (by a hash that still matches).
 * - Accepted needs acceptance evidence (agency acknowledgement / acceptance notice).
 * - Paid needs a payment confirmation or receipt.
 * - A button alone never marks anything filed, accepted or paid.
 * - Any material change (a new return/supporting document, the amount, the period or its due date)
 *   invalidates the current version and its approval; staff send a new version.
 * Nothing here contacts an agency: staff file in the government portal ("Open portal").
 */

export const FILING_STATUS = {
  NOT_STARTED: "Not Started",
  PREPARING: "Preparing",
  AWAITING_APPROVAL: "Awaiting Approval",
  APPROVED: "Approved",
  SUBMITTED: "Submitted",
  ACCEPTED: "Accepted",
  REJECTED: "Rejected",
  NOT_REQUIRED: "Not required / no filing",
} as const;
export const PAYMENT_STATUS = { UNKNOWN: "Payment not determined", NOT_APPLICABLE: "No payment due", DUE: "Payment due", PAID: "Paid" } as const;
/** Filing channel placeholder: MANUAL only. MAT_BULK is disabled until the owner approves a MAT bulk-file export. */
export const FILING_CHANNELS = { MANUAL: { label: "Manual — staff file in the government portal", enabled: true }, MAT_BULK: { label: "MAT bulk-file export (future, owner approval required)", enabled: false } } as const;
export const DOC_KINDS = { RETURN: "Return (PDF)", SUPPORTING: "Supporting document / workup", FILING_CONFIRMATION: "Filing confirmation", ACCEPTANCE: "Acceptance notice / acknowledgement", PAYMENT_RECEIPT: "Payment confirmation / receipt", REJECTION: "Rejection notice", EXTENSION: "Extension confirmation", AUTHORIZATION: "Authorization (2848 / 2848A / 8821)", EXEMPTION: "Exemption document", NOT_REQUIRED: "Not-required / no-activity evidence", OTHER: "Other" } as const;
export type DocKind = keyof typeof DOC_KINDS;

const iso = (x: Date | null | undefined) => (x ? x.toISOString().slice(0, 10) : null);
const MATERIAL_KINDS = ["RETURN", "SUPPORTING"];

export async function periodOr404(periodId: string) {
  const p = await prisma.complianceFilingPeriod.findUnique({ where: { id: periodId }, include: { obligation: true } });
  if (!p) throw new ValidationError("Period not found.");
  return p;
}

export function contentHashOf(input: { periodId: string; periodStart: string; periodEnd: string; dueDate: string | null; amountDueCents: number | null; shas: string[] }) {
  return createHash("sha256").update(JSON.stringify({ ...input, shas: [...input.shas].sort() })).digest("hex");
}

/** Invalidates the live (non-superseded) version and its approval; the period goes back to Preparing. */
async function invalidateCurrent(tx: Prisma.TransactionClient, periodId: string, reason: string, actorId: string) {
  const live = await tx.complianceReturnVersion.findMany({ where: { periodId, status: { notIn: ["SUPERSEDED"] } } });
  if (!live.length) return 0;
  await tx.complianceReturnVersion.updateMany({ where: { id: { in: live.map((v) => v.id) } }, data: { status: "SUPERSEDED", invalidatedAt: new Date(), invalidatedReason: reason } });
  await tx.complianceFilingPeriod.updateMany({ where: { id: periodId, filingStatus: { in: ["AWAITING_APPROVAL", "APPROVED"] } }, data: { filingStatus: "PREPARING" } });
  const p = await tx.complianceFilingPeriod.findUniqueOrThrow({ where: { id: periodId } });
  await audit(tx, { actorId, action: "compliance.version_invalidated", entityType: "ComplianceFilingPeriod", entityId: periodId, clientId: p.clientId, details: { reason, versions: live.map((v) => v.version) } });
  return live.length;
}

/** Uploads a file into the entity's Tax & Compliance folder (Document category TAXES, docType COMPLIANCE_<kind>, staff-only). */
export async function uploadComplianceDocument(actor: Actor, input: { entityId: string; periodId?: string | null; kind: DocKind; title?: string; bytes: Uint8Array; originalName: string }) {
  await assertComplianceManage(actor);
  if (!(input.kind in DOC_KINDS)) throw new ValidationError("Choose what this document is.");
  const entity = await prisma.complianceEntity.findUnique({ where: { id: input.entityId } });
  if (!entity) throw new ValidationError("Entity not found.");
  let period: ComplianceFilingPeriod | null = null;
  if (input.periodId) {
    period = await prisma.complianceFilingPeriod.findUnique({ where: { id: input.periodId } });
    // Entity separation: a period's documents belong to that period's entity only.
    if (!period || period.entityId !== entity.id) throw new ValidationError("That period belongs to a different entity.");
  }
  const doc = await staffUploadDocument(actor, {
    clientId: entity.clientId,
    category: "TAXES",
    title: input.title?.trim() || `${DOC_KINDS[input.kind]}${period ? ` — ${period.periodKey}` : ""}`,
    year: period ? period.periodEnd.getUTCFullYear() : null,
    visibility: "STAFF_ONLY",
    docType: `COMPLIANCE_${input.kind}`,
    coverage: period ? { kind: "RANGE", year: period.periodEnd.getUTCFullYear(), month: null, start: period.periodStart, end: period.periodEnd } : null,
    bytes: input.bytes,
    originalName: input.originalName,
    notify: false,
  });
  const link = await prisma.$transaction(async (tx) => {
    const link = await tx.complianceDocument.create({ data: { documentId: doc.id, entityId: entity.id, obligationId: period?.obligationId ?? null, periodId: period?.id ?? null, kind: input.kind, createdById: actor.id } });
    if (period && MATERIAL_KINDS.includes(input.kind)) await invalidateCurrent(tx, period.id, `New ${DOC_KINDS[input.kind].toLowerCase()} added`, actor.id);
    await audit(tx, { actorId: actor.id, action: "compliance.document_added", entityType: "ComplianceEntity", entityId: entity.id, clientId: entity.clientId, details: { kind: input.kind, periodId: period?.id ?? null, documentId: doc.id } });
    return link;
  });
  return { document: doc, link };
}

async function docInPeriod(documentId: string | null | undefined, period: { id: string; entityId: string }, kinds?: string[]) {
  if (!documentId) return null;
  const link = await prisma.complianceDocument.findUnique({ where: { documentId }, include: { document: { select: { deletedAt: true } } } });
  if (!link || link.entityId !== period.entityId || (link.periodId && link.periodId !== period.id) || link.document.deletedAt) throw new ValidationError("That document isn't in this entity's Tax & Compliance folder for this period.");
  if (kinds && !kinds.includes(link.kind)) throw new ValidationError(`Upload the right kind of evidence (${kinds.map((k) => DOC_KINDS[k as DocKind]).join(" or ")}).`);
  return link;
}

export async function startPreparing(actor: Actor, periodId: string) {
  await assertComplianceManage(actor);
  const p = await periodOr404(periodId);
  if (p.filingStatus !== "NOT_STARTED" && p.filingStatus !== "REJECTED") throw new ValidationError("Preparation has already started.");
  await prisma.complianceFilingPeriod.update({ where: { id: periodId }, data: { filingStatus: "PREPARING" } });
  await audit(prisma, { actorId: actor.id, action: "compliance.period_preparing", entityType: "ComplianceFilingPeriod", entityId: periodId, clientId: p.clientId });
}

/** Amount due changes are material: they invalidate the current version and its approval. */
export async function setAmountDue(actor: Actor, periodId: string, amountDueCents: number | null) {
  await assertComplianceManage(actor);
  const p = await periodOr404(periodId);
  if (amountDueCents !== null && (!Number.isInteger(amountDueCents) || amountDueCents < 0)) throw new ValidationError("Enter the amount due in dollars and cents.");
  if (isComplete(p)) throw new ValidationError("This period is already filed. Use an amended return.");
  await prisma.$transaction(async (tx) => {
    await tx.complianceFilingPeriod.update({ where: { id: periodId }, data: { amountDueCents, paymentStatus: amountDueCents === 0 ? "NOT_APPLICABLE" : amountDueCents ? (p.paymentStatus === "PAID" ? "PAID" : "DUE") : p.paymentStatus } });
    if (p.amountDueCents !== amountDueCents) await invalidateCurrent(tx, periodId, "Amount due changed", actor.id);
    await audit(tx, { actorId: actor.id, action: "compliance.amount_set", entityType: "ComplianceFilingPeriod", entityId: periodId, clientId: p.clientId, details: { changed: p.amountDueCents !== amountDueCents } });
  });
}

/** Staff enter a due date the rule can't compute (MANUAL rules) or correct one; material change. */
export async function setPeriodDueDate(actor: Actor, periodId: string, dueDate: string, note: string) {
  await assertComplianceManage(actor);
  const p = await periodOr404(periodId);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dueDate)) throw new ValidationError("Enter the due date.");
  if (note.trim().length < 5) throw new ValidationError("Say where the date comes from (notice, license, agency page).");
  const adjusted = adjustDue(dueDate, p.obligation.weekendRule);
  const prep = new Date(new Date(`${adjusted}T00:00:00Z`).getTime() - p.obligation.prepLeadDays * 86400_000);
  await prisma.$transaction(async (tx) => {
    await tx.complianceFilingPeriod.update({ where: { id: periodId }, data: { statutoryDue: new Date(`${dueDate}T00:00:00Z`), adjustedDue: new Date(`${adjusted}T00:00:00Z`), prepDeadline: prep, dueNote: note.trim().slice(0, 300), dueCertainty: "NEEDS_VERIFICATION" } });
    await invalidateCurrent(tx, periodId, "Due date changed", actor.id);
    await audit(tx, { actorId: actor.id, action: "compliance.due_date_set", entityType: "ComplianceFilingPeriod", entityId: periodId, clientId: p.clientId, details: { dueDate, adjusted } });
  });
}

/** Version N of the return package: the period's return + supporting documents, the amount and the dates, hashed. */
export async function createReturnVersion(actor: Actor, periodId: string, opts: { note?: string } = {}) {
  await assertComplianceManage(actor);
  const p = await periodOr404(periodId);
  if (isComplete(p)) throw new ValidationError("This period is already filed.");
  const links = await prisma.complianceDocument.findMany({ where: { periodId, kind: { in: MATERIAL_KINDS }, document: { deletedAt: null } }, include: { document: { include: { file: { select: { sha256: true } } } } } });
  if (!links.some((l) => l.kind === "RETURN")) throw new ValidationError("Upload the return PDF for this period first.");
  const shas = links.map((l) => l.document.file.sha256).filter((s): s is string => !!s);
  const due = iso(effectiveDue(p));
  const contentHash = contentHashOf({ periodId, periodStart: iso(p.periodStart)!, periodEnd: iso(p.periodEnd)!, dueDate: due, amountDueCents: p.amountDueCents, shas });
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`cc-version:${periodId}`}))`;
    const last = await tx.complianceReturnVersion.findFirst({ where: { periodId }, orderBy: { version: "desc" } });
    if (last && last.status !== "SUPERSEDED" && last.contentHash === contentHash) return last;
    await invalidateCurrent(tx, periodId, "Replaced by a newer version", actor.id);
    const v = await tx.complianceReturnVersion.create({ data: { periodId, version: (last?.version ?? 0) + 1, documentIds: links.map((l) => l.documentId), documentShas: shas, amountDueCents: p.amountDueCents, periodStart: p.periodStart, periodEnd: p.periodEnd, dueDate: effectiveDue(p), contentHash, preparedById: actor.id, note: opts.note?.trim().slice(0, 1000) || null } });
    await tx.complianceFilingPeriod.update({ where: { id: periodId }, data: { filingStatus: "PREPARING" } });
    await audit(tx, { actorId: actor.id, action: "compliance.version_created", entityType: "ComplianceFilingPeriod", entityId: periodId, clientId: p.clientId, details: { version: v.version, contentHash } });
    return v;
  });
}

/** Sends the version to the client: "A tax return is ready for your review" (HELD while the switches are off). */
export async function sendForApproval(actor: Actor, versionId: string) {
  await assertComplianceManage(actor);
  const v = await prisma.complianceReturnVersion.findUnique({ where: { id: versionId }, include: { period: { include: { obligation: true, entity: true } } } });
  if (!v || v.status === "SUPERSEDED") throw new ValidationError("This version was replaced. Send the newest one.");
  if (v.status !== "DRAFT" && v.status !== "CHANGES_REQUESTED") throw new ValidationError("This version was already sent.");
  const o = v.period.obligation;
  if (!o.clientApprovalRequired) throw new ValidationError("This obligation doesn't use client approval.");
  if (!o.clientVisible || !v.period.entity.portalVisible) throw new ValidationError("Turn on client visibility for this entity and obligation first, so the client can see the return.");
  await prisma.$transaction([
    prisma.complianceReturnVersion.update({ where: { id: versionId }, data: { status: "SENT", sentAt: new Date(), sentById: actor.id } }),
    prisma.complianceFilingPeriod.update({ where: { id: v.periodId }, data: { filingStatus: "AWAITING_APPROVAL" } }),
  ]);
  await audit(prisma, { actorId: actor.id, action: "compliance.version_sent", entityType: "ComplianceFilingPeriod", entityId: v.periodId, clientId: v.period.clientId, details: { version: v.version } });
  const { notifyClientForPeriod } = await import("./reminders");
  return notifyClientForPeriod(v.periodId, `RETURN_READY:${v.version}`, "COMPLIANCE_RETURN_READY");
}

/** The live, approved version whose hash still matches — or null. */
export async function currentApproval(periodId: string) {
  const v = await prisma.complianceReturnVersion.findFirst({ where: { periodId, status: "APPROVED", invalidatedAt: null }, orderBy: { version: "desc" }, include: { approvals: { where: { decision: "APPROVED" }, orderBy: { createdAt: "desc" }, take: 1 } } });
  const a = v?.approvals[0];
  if (!v || !a || a.contentHash !== v.contentHash) return null;
  const p = await prisma.complianceFilingPeriod.findUniqueOrThrow({ where: { id: periodId } });
  // A material change since (amount, dates) also breaks the approval even if nobody invalidated it.
  if (v.amountDueCents !== p.amountDueCents || iso(v.dueDate) !== iso(effectiveDue(p)) || iso(v.periodEnd) !== iso(p.periodEnd)) return null;
  return { version: v, approval: a };
}

// --- Client decision (portal) ----------------------------------------------------------------

export async function clientDecide(user: PortalActor, versionId: string, input: { decision: "APPROVED" | "CHANGES_REQUESTED"; signerName: string; comments?: string; contentHash: string }, meta: { ip?: string | null; userAgent?: string | null }) {
  const v = await prisma.complianceReturnVersion.findUnique({ where: { id: versionId }, include: { period: true } });
  if (!v) throw new ForbiddenError("Not found.");
  const { portalMayActOnPeriod } = await import("./views");
  if (!(await portalMayActOnPeriod(user.id, v.period))) throw new ForbiddenError("Not found.");
  if (v.status !== "SENT") throw new ValidationError(v.status === "SUPERSEDED" ? "This version was replaced by a newer one. Please review the newest version." : "This version isn't waiting for your decision.");
  if (input.contentHash !== v.contentHash) throw new ValidationError("This return changed while you were reviewing it. Please reload and review the current version.");
  if (input.decision !== "APPROVED" && input.decision !== "CHANGES_REQUESTED") throw new ValidationError("Choose Approve or Request changes.");
  const signer = input.signerName.trim();
  if (signer.length < 2) throw new ValidationError("Type your full name.");
  const comments = input.comments?.trim().slice(0, 2000) || null;
  if (input.decision === "CHANGES_REQUESTED" && !comments) throw new ValidationError("Tell us what should change.");
  const approval = await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`cc-version:${v.periodId}`}))`;
    const fresh = await tx.complianceReturnVersion.findUniqueOrThrow({ where: { id: versionId } });
    if (fresh.status !== "SENT") throw new ValidationError("This version isn't waiting for your decision.");
    const a = await tx.complianceApproval.create({ data: { returnVersionId: versionId, periodId: v.periodId, decision: input.decision, portalUserId: user.id, signerName: signer.slice(0, 120), ipAddress: meta.ip?.slice(0, 64) ?? null, userAgent: meta.userAgent?.slice(0, 300) ?? null, contentHash: v.contentHash, comments } });
    await tx.complianceReturnVersion.update({ where: { id: versionId }, data: { status: input.decision === "APPROVED" ? "APPROVED" : "CHANGES_REQUESTED" } });
    await tx.complianceFilingPeriod.update({ where: { id: v.periodId }, data: { filingStatus: input.decision === "APPROVED" ? "APPROVED" : "PREPARING" } });
    await audit(tx, { actorId: null, action: input.decision === "APPROVED" ? "compliance.client_approved" : "compliance.client_requested_changes", entityType: "ComplianceFilingPeriod", entityId: v.periodId, clientId: v.period.clientId, details: { portalUserId: user.id, version: v.version, contentHash: v.contentHash } });
    return a;
  });
  const { notifyStaffOfDecision } = await import("./reminders");
  await notifyStaffOfDecision(v.periodId, approval.id, input.decision);
  return approval;
}

// --- Evidence -----------------------------------------------------------------------------

type Evidence = { confirmationNumber?: string | null; documentId?: string | null; note?: string | null };
const clean = (s: string | null | undefined, n = 120) => (s ?? "").trim().slice(0, n) || null;

async function finish(periodId: string, actorId: string) {
  const p = await prisma.complianceFilingPeriod.findUniqueOrThrow({ where: { id: periodId } });
  if (p.prepTaskId) await prisma.task.updateMany({ where: { id: p.prepTaskId, status: "OPEN" }, data: { status: "DONE", completedAt: new Date() } });
  await createNextPeriod(periodId);
  void actorId;
}

/** Submitted: confirmation number OR filing evidence, the approval gate, verifier + time. */
export async function recordSubmitted(actor: Actor, periodId: string, input: Evidence & { filedOn?: string | null; zeroReturn?: boolean; channel?: string }) {
  await assertComplianceManage(actor);
  const p = await periodOr404(periodId);
  if (isComplete(p) && p.filingStatus !== "NOT_REQUIRED") throw new ValidationError("This period is already recorded as filed.");
  if (input.channel && input.channel !== "MANUAL") throw new ValidationError("Only manual filing is available. MAT bulk-file export is disabled until the owner approves it.");
  const conf = clean(input.confirmationNumber);
  const link = await docInPeriod(input.documentId, p, ["FILING_CONFIRMATION", "ACCEPTANCE", "RETURN"]);
  if (!conf && !link) throw new ValidationError("Submitted needs the confirmation number or the uploaded filing confirmation.");
  if (p.obligation.clientApprovalRequired && !(await currentApproval(periodId))) throw new ValidationError("Client approval is required and missing for the current version. It can't be marked Submitted.");
  const filedOn = input.filedOn && /^\d{4}-\d{2}-\d{2}$/.test(input.filedOn) ? new Date(`${input.filedOn}T00:00:00Z`) : new Date(new Date().toISOString().slice(0, 10) + "T00:00:00Z");
  await prisma.$transaction(async (tx) => {
    await tx.complianceEvidence.create({ data: { periodId, kind: "FILING_CONFIRMATION", documentId: link?.documentId ?? null, reference: conf, note: clean(input.note, 500), recordedById: actor.id } });
    await tx.complianceFilingPeriod.update({ where: { id: periodId }, data: { filingStatus: "SUBMITTED", submittedAt: new Date(), actualFilingDate: filedOn, confirmationNumber: conf, verifiedById: actor.id, verifiedAt: new Date(), zeroReturn: !!input.zeroReturn, completedAt: new Date(), rejectedAt: null } });
    await audit(tx, { actorId: actor.id, action: "compliance.submitted", entityType: "ComplianceFilingPeriod", entityId: periodId, clientId: p.clientId, details: { hasConfirmation: !!conf, documentId: link?.documentId ?? null, zeroReturn: !!input.zeroReturn } });
  });
  await finish(periodId, actor.id);
  const { notifyClientForPeriod } = await import("./reminders");
  await notifyClientForPeriod(periodId, `FILED:${periodId}`, "COMPLIANCE_RETURN_FILED");
}

/** Accepted: agency acknowledgement or acceptance notice, recorded separately from Submitted. */
export async function recordAccepted(actor: Actor, periodId: string, input: Evidence) {
  await assertComplianceManage(actor);
  const p = await periodOr404(periodId);
  if (p.filingStatus !== "SUBMITTED") throw new ValidationError("Record the submission (with its evidence) before acceptance.");
  const ref = clean(input.confirmationNumber);
  const link = await docInPeriod(input.documentId, p, ["ACCEPTANCE"]);
  if (!link && !ref) throw new ValidationError("Accepted needs the agency's acknowledgement or acceptance notice (upload it, or enter the acknowledgement number).");
  await prisma.$transaction(async (tx) => {
    await tx.complianceEvidence.create({ data: { periodId, kind: "ACCEPTANCE", documentId: link?.documentId ?? null, reference: ref, note: clean(input.note, 500), recordedById: actor.id } });
    await tx.complianceFilingPeriod.update({ where: { id: periodId }, data: { filingStatus: "ACCEPTED", acceptedAt: new Date(), acceptedById: actor.id } });
    await audit(tx, { actorId: actor.id, action: "compliance.accepted", entityType: "ComplianceFilingPeriod", entityId: periodId, clientId: p.clientId, details: { documentId: link?.documentId ?? null, hasReference: !!ref } });
  });
}

/** Rejected: needs the rejection notice or reference and a reason. The period reopens (prep task too). */
export async function recordRejected(actor: Actor, periodId: string, input: Evidence & { reason: string }) {
  await assertComplianceManage(actor);
  const p = await periodOr404(periodId);
  if (p.filingStatus !== "SUBMITTED") throw new ValidationError("Only a submitted filing can be rejected.");
  const ref = clean(input.confirmationNumber);
  const link = await docInPeriod(input.documentId, p, ["REJECTION"]);
  if (!link && !ref) throw new ValidationError("Record the rejection notice or the agency's reference.");
  if (input.reason.trim().length < 3) throw new ValidationError("Give the rejection reason.");
  await prisma.$transaction(async (tx) => {
    await tx.complianceEvidence.create({ data: { periodId, kind: "REJECTION", documentId: link?.documentId ?? null, reference: ref, note: input.reason.trim().slice(0, 500), recordedById: actor.id } });
    await tx.complianceFilingPeriod.update({ where: { id: periodId }, data: { filingStatus: "REJECTED", rejectedAt: new Date(), rejectionReason: input.reason.trim().slice(0, 500), completedAt: null } });
    if (p.prepTaskId) await tx.task.updateMany({ where: { id: p.prepTaskId }, data: { status: "OPEN", completedAt: null } });
    await invalidateCurrent(tx, periodId, "Filing rejected", actor.id);
    await audit(tx, { actorId: actor.id, action: "compliance.rejected", entityType: "ComplianceFilingPeriod", entityId: periodId, clientId: p.clientId });
  });
}

/** Paid: a payment confirmation or receipt. Payment status only — never the filing status. */
export async function recordPayment(actor: Actor, periodId: string, input: Evidence) {
  await assertComplianceManage(actor);
  const p = await periodOr404(periodId);
  const conf = clean(input.confirmationNumber);
  const link = await docInPeriod(input.documentId, p, ["PAYMENT_RECEIPT"]);
  if (!conf && !link) throw new ValidationError("Paid needs the payment confirmation number or the uploaded receipt.");
  await prisma.$transaction(async (tx) => {
    await tx.complianceEvidence.create({ data: { periodId, kind: "PAYMENT", documentId: link?.documentId ?? null, reference: conf, note: clean(input.note, 500), recordedById: actor.id } });
    await tx.complianceFilingPeriod.update({ where: { id: periodId }, data: { paymentStatus: "PAID", paidAt: new Date(), paidById: actor.id, paymentConfirmation: conf } });
    await audit(tx, { actorId: actor.id, action: "compliance.paid", entityType: "ComplianceFilingPeriod", entityId: periodId, clientId: p.clientId, details: { hasConfirmation: !!conf, documentId: link?.documentId ?? null } });
  });
}

/** No payment due (e.g. zero return, refund). Payment status only. */
export async function markNoPaymentDue(actor: Actor, periodId: string) {
  await assertComplianceManage(actor);
  const p = await periodOr404(periodId);
  if (p.paymentStatus === "PAID") throw new ValidationError("A payment is already recorded.");
  await prisma.complianceFilingPeriod.update({ where: { id: periodId }, data: { paymentStatus: "NOT_APPLICABLE" } });
  await audit(prisma, { actorId: actor.id, action: "compliance.no_payment_due", entityType: "ComplianceFilingPeriod", entityId: periodId, clientId: p.clientId });
}

/** Not required / no activity (where no return is filed): needs evidence and a reason. */
export async function recordNotRequired(actor: Actor, periodId: string, input: Evidence & { reason: string }) {
  await assertComplianceManage(actor);
  const p = await periodOr404(periodId);
  if (COMPLETE_FILING.includes(p.filingStatus)) throw new ValidationError("This period is already complete.");
  const ref = clean(input.confirmationNumber);
  const link = await docInPeriod(input.documentId, p, ["NOT_REQUIRED", "OTHER", "FILING_CONFIRMATION"]);
  if (!link && !ref) throw new ValidationError("Not required needs evidence: upload it, or enter the agency reference that shows no filing is required.");
  if (input.reason.trim().length < 5) throw new ValidationError("Explain why no filing is required.");
  await prisma.$transaction(async (tx) => {
    await tx.complianceEvidence.create({ data: { periodId, kind: "NOT_REQUIRED", documentId: link?.documentId ?? null, reference: ref, note: input.reason.trim().slice(0, 500), recordedById: actor.id } });
    await tx.complianceFilingPeriod.update({ where: { id: periodId }, data: { filingStatus: "NOT_REQUIRED", completedAt: new Date(), verifiedById: actor.id, verifiedAt: new Date(), paymentStatus: p.paymentStatus === "PAID" ? "PAID" : "NOT_APPLICABLE" } });
    await audit(tx, { actorId: actor.id, action: "compliance.not_required", entityType: "ComplianceFilingPeriod", entityId: periodId, clientId: p.clientId });
  });
  await finish(periodId, actor.id);
}

/** Extension filed (7004 / 8868 / state): evidence required. Reminders follow the extended date; payment is still due on the original. */
export async function recordExtension(actor: Actor, periodId: string, input: Evidence) {
  await assertComplianceManage(actor);
  const p = await periodOr404(periodId);
  const months = p.obligation.extensionMonths;
  if (!months) throw new ValidationError("This obligation has no extension in the rules library.");
  if (p.extendedDue) throw new ValidationError("An extension is already recorded.");
  if (!p.statutoryDue) throw new ValidationError("Enter the due date first.");
  const ref = clean(input.confirmationNumber);
  const link = await docInPeriod(input.documentId, p, ["EXTENSION"]);
  if (!link && !ref) throw new ValidationError("Record the extension acknowledgement (upload it or enter its confirmation number).");
  const ext = adjustDue(addMonths(iso(p.statutoryDue)!, months), p.obligation.weekendRule);
  await prisma.$transaction(async (tx) => {
    await tx.complianceEvidence.create({ data: { periodId, kind: "EXTENSION", documentId: link?.documentId ?? null, reference: ref, note: clean(input.note, 500), recordedById: actor.id } });
    await tx.complianceFilingPeriod.update({ where: { id: periodId }, data: { extendedDue: new Date(`${ext}T00:00:00Z`), prepDeadline: new Date(new Date(`${ext}T00:00:00Z`).getTime() - p.obligation.prepLeadDays * 86400_000), dueNote: `Extended to ${ext}. An extension of time to file is not an extension of time to pay.` } });
    await invalidateCurrent(tx, periodId, "Due date extended", actor.id);
    await audit(tx, { actorId: actor.id, action: "compliance.extension_recorded", entityType: "ComplianceFilingPeriod", entityId: periodId, clientId: p.clientId, details: { extendedDue: ext } });
  });
}

/** An amended return for a filed period: its own period (same key, kind AMENDED), no deadline unless entered. */
export async function startAmended(actor: Actor, periodId: string, reason: string) {
  await assertComplianceManage(actor);
  const p = await periodOr404(periodId);
  if (!isComplete(p)) throw new ValidationError("Only a filed period can be amended.");
  if (reason.trim().length < 5) throw new ValidationError("Say why the return is being amended.");
  const n = await prisma.complianceFilingPeriod.findFirst({ where: { obligationId: p.obligationId, periodKey: p.periodKey, kind: "AMENDED" } });
  if (n && !isComplete(n)) throw new ValidationError("An amended return for this period is already in progress.");
  const row = await prisma.complianceFilingPeriod.create({ data: { obligationId: p.obligationId, entityId: p.entityId, clientId: p.clientId, periodKey: n ? `${p.periodKey}#${Date.now().toString(36)}` : p.periodKey, kind: "AMENDED", parentPeriodId: p.id, periodStart: p.periodStart, periodEnd: p.periodEnd, dueCertainty: "NEEDS_VERIFICATION", dueNote: `Amended return: ${reason.trim().slice(0, 200)}` } });
  await audit(prisma, { actorId: actor.id, action: "compliance.amended_started", entityType: "ComplianceFilingPeriod", entityId: row.id, clientId: p.clientId, details: { parent: p.id } });
  return row;
}

export async function setFilingChannel(actor: Actor, periodId: string, channel: string) {
  await assertComplianceManage(actor);
  if (!(channel in FILING_CHANNELS) || !FILING_CHANNELS[channel as keyof typeof FILING_CHANNELS].enabled) throw new ValidationError("Only manual filing is available. MAT bulk-file export is disabled until the owner approves it.");
  await periodOr404(periodId);
}
