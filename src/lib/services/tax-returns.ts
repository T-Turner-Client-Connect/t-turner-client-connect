import "server-only";
import { prisma } from "@/lib/prisma";
import { audit } from "@/lib/audit";
import { ForbiddenError, type Actor } from "@/lib/auth/actor";
import type { PortalActor } from "@/lib/portal/session";
import { requireClientAccess } from "@/lib/portal/access";
import { storage } from "@/lib/storage";
import { sendEmail, brandedEmailHtml } from "@/lib/email";
import { appUrl } from "@/lib/integrations";
import { BUSINESS } from "@/lib/business";
import { normalizeJurisdiction, normalizeReturnType } from "@/lib/tax/normalize";
import { ValidationError } from "./clients";
import { isReportApprover } from "./bookkeeping-clients";
import { clientMayReceive, notifyClientUsers, readDocumentBytes, staffUploadDocument, storeDocumentFile } from "./documents";
import { createFiling } from "./tax";

/**
 * Tax Return Delivery. Completed returns exported from TaxAct are filed to a
 * client/business, tax year, return type and jurisdiction (federal or a
 * state), original or amended — never a bookkeeping month. Every copy is a
 * staff-only Draft until staff mark it Ready for review and Tabitha releases
 * it; the malware scan must pass first. "Accepted" comes only from the
 * filing record's verified acknowledgment, never from uploading a PDF.
 */
export const RETURN_COPY_STATUS = {
  DRAFT: { label: "Draft (staff only)", tone: "gray" },
  AWAITING_REVIEW: { label: "Ready for Tabitha's review", tone: "gold" },
  APPROVED: { label: "Released to the client", tone: "green" },
} as const;

/** Filing status shown beside a return — from the filing record, never from the PDF. */
export function filingLabel(status: string | null | undefined) {
  if (status === "ACCEPTED") return { label: "Accepted Return", tone: "green" as const };
  if (status === "REJECTED") return { label: "Rejected", tone: "red" as const };
  if (status === "SUBMITTED" || status === "PENDING_ACKNOWLEDGMENT") return { label: "Submitted — awaiting acknowledgment", tone: "navy" as const };
  return null;
}

export type ReturnFields = { clientId: string; taxYear: number; returnType: string; jurisdiction: string; filingType: "ORIGINAL" | "AMENDED" };

function checkFields(f: Partial<ReturnFields>) {
  const thisYear = new Date().getFullYear();
  if (!f.clientId) throw new ValidationError("Choose the client or business.");
  if (!Number.isInteger(f.taxYear) || f.taxYear! < 2000 || f.taxYear! > thisYear) throw new ValidationError("Choose the tax year of the return.");
  const returnType = normalizeReturnType(f.returnType);
  if (!returnType) throw new ValidationError("Enter the return type (for example 1040, 1120-S, 1065, 990, or the state form).");
  const jurisdiction = normalizeJurisdiction(f.jurisdiction ?? "");
  if (!jurisdiction) throw new ValidationError("Choose Federal or the state.");
  if (f.filingType !== "ORIGINAL" && f.filingType !== "AMENDED") throw new ValidationError("Choose original or amended.");
  return { clientId: f.clientId, taxYear: f.taxYear!, returnType, jurisdiction, filingType: f.filingType };
}

const docTypeFor = (f: { jurisdiction: string; filingType: string }) => (f.filingType === "AMENDED" ? "AMENDED_RETURN" : f.jurisdiction === "FEDERAL" ? "FEDERAL_RETURN" : "STATE_RETURN");

/** One return into a client's file: staff-only Draft, linked to its filing record; a later copy becomes a new version. */
export async function fileReturn(actor: Actor, input: ReturnFields & { bytes: Uint8Array; originalName: string }) {
  const f = checkFields(input);
  const client = await prisma.client.findUnique({ where: { id: f.clientId } });
  if (!client || client.archivedAt) throw new ValidationError("Client not found.");
  const filing =
    (await prisma.filingRecord.findFirst({ where: { clientId: f.clientId, taxYear: f.taxYear, returnType: f.returnType, jurisdiction: f.jurisdiction, filingType: f.filingType } })) ??
    (await createFiling(actor, { clientId: f.clientId, taxYear: f.taxYear, returnType: f.returnType, jurisdiction: f.jurisdiction, filingType: f.filingType }));
  const previous = await prisma.document.findFirst({ where: { filingId: filing.id, filingDocType: "RETURN", deletedAt: null, supersededAt: null }, orderBy: { createdAt: "desc" } });
  // The same file can't be filed twice for a client (checked by content, not name).
  const doc = await staffUploadDocument(actor, { clientId: f.clientId, category: "TAXES", title: `${f.taxYear} ${f.returnType} — ${f.jurisdiction === "FEDERAL" ? "Federal" : f.jurisdiction}${f.filingType === "AMENDED" ? " (amended)" : ""}`, year: f.taxYear, visibility: "STAFF_ONLY", docType: docTypeFor(f), bytes: input.bytes, originalName: input.originalName });
  const version = (previous?.version ?? (previous ? 1 : 0)) + 1;
  await prisma.document.update({ where: { id: doc.id }, data: { filingId: filing.id, filingDocType: "RETURN", reviewStatus: "DRAFT", version, replacesId: previous?.id ?? null } });
  await audit(prisma, { actorId: actor.id, action: "tax.return_filed", entityType: "Document", entityId: doc.id, clientId: f.clientId, details: { ...f, version, replaces: previous?.id ?? null } });
  return prisma.document.findUniqueOrThrow({ where: { id: doc.id } });
}

// --- Bulk upload and review queue -------------------------------------------------

const words = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").split(" ").filter((w) => w.length >= 3 && !["llc", "inc", "corp", "the", "and", "pdf", "return", "tax"].includes(w));

/** A suggestion from the file name only — never applied without staff confirmation. */
export async function suggestMatch(originalName: string) {
  const year = /(?:^|\D)(20\d{2})(?:\D|$)/.exec(originalName)?.[1];
  const type = /(1040-?(?:SR|X)?|1120-?S|1120|1065|990-?(?:EZ|N|PF)?|1041)/i.exec(originalName)?.[1]?.toUpperCase();
  const name = words(originalName.replace(/\.[^.]+$/, ""));
  const clients = await prisma.client.findMany({ where: { archivedAt: null }, select: { id: true, displayName: true, businessName: true } });
  const hits = clients.filter((c) => {
    const w = words(c.businessName || c.displayName);
    return w.length > 0 && w.every((x) => name.includes(x));
  });
  return {
    suggestedYear: year ? Number(year) : null,
    suggestedType: type ?? null,
    // Only a single, unambiguous name match is suggested.
    suggestedClientId: hits.length === 1 ? hits[0].id : null,
    matchReason: hits.length === 1 ? `File name contains “${hits[0].businessName || hits[0].displayName}”` : hits.length > 1 ? `Ambiguous: ${hits.length} clients match the file name` : "No client name found in the file name",
  };
}

export async function bulkUploadReturns(actor: Actor, files: { bytes: Uint8Array; originalName: string }[]) {
  if (!files.length) throw new ValidationError("Choose the returns to upload.");
  if (files.length > 50) throw new ValidationError("Upload up to 50 returns at a time.");
  const out = [];
  for (const f of files) {
    const stored = await storeDocumentFile(f.bytes, f.originalName, { staff: actor });
    const sha = stored.fileData.sha256 as string;
    // Same file already queued or already in a client's file: skip it, don't store a second copy.
    const dupIntake = await prisma.returnIntake.findFirst({ where: { sha256: sha, status: { not: "DISCARDED" } } });
    const dupDoc = await prisma.storedFile.findFirst({ where: { sha256: sha, kind: "CLIENT_DOCUMENT", NOT: { storageKey: stored.storageKey } } });
    if (dupIntake || dupDoc) {
      await storage.remove(stored.storageKey).catch(() => {});
      out.push({ originalName: f.originalName, duplicate: true });
      continue;
    }
    const file = await prisma.storedFile.create({ data: stored.fileData });
    const s = await suggestMatch(f.originalName);
    const intake = await prisma.returnIntake.create({ data: { fileId: file.id, originalName: file.originalName, sha256: sha, uploadedById: actor.id, ...s } });
    out.push({ originalName: f.originalName, duplicate: false, intakeId: intake.id });
  }
  await audit(prisma, { actorId: actor.id, action: "tax.returns_bulk_uploaded", entityType: "ReturnIntake", entityId: "bulk", details: { files: files.length, queued: out.filter((o) => !o.duplicate).length } });
  return out;
}

/** Staff confirm client, year, type and jurisdiction; only then is the file placed in that client's file (as a Draft). */
export async function confirmIntake(actor: Actor, intakeId: string, fields: ReturnFields) {
  const intake = await prisma.returnIntake.findUnique({ where: { id: intakeId } });
  if (!intake || intake.status !== "PENDING") throw new ValidationError("That upload is no longer waiting for review.");
  const file = await prisma.storedFile.findUniqueOrThrow({ where: { id: intake.fileId } });
  const bytes = await readDocumentBytes(file);
  if (!bytes) throw new ValidationError("The uploaded file couldn't be read. Upload it again.");
  const doc = await fileReturn(actor, { ...fields, bytes, originalName: intake.originalName });
  await prisma.returnIntake.update({ where: { id: intakeId }, data: { status: "FILED", documentId: doc.id, filedById: actor.id, filedAt: new Date() } });
  // The queued copy is no longer needed; the client's file holds its own.
  await storage.remove(file.storageKey).catch(() => {});
  await prisma.storedFile.delete({ where: { id: file.id } }).catch(() => {});
  return doc;
}

export async function discardIntake(actor: Actor, intakeId: string, reason: string) {
  const intake = await prisma.returnIntake.findUnique({ where: { id: intakeId } });
  if (!intake || intake.status !== "PENDING") throw new ValidationError("That upload is no longer waiting for review.");
  if (reason.trim().length < 3) throw new ValidationError("Say why it's being removed.");
  const file = await prisma.storedFile.findUnique({ where: { id: intake.fileId } });
  if (file) {
    await storage.remove(file.storageKey).catch(() => {});
    await prisma.storedFile.delete({ where: { id: file.id } }).catch(() => {});
  }
  await prisma.returnIntake.update({ where: { id: intakeId }, data: { status: "DISCARDED", discardedReason: reason.trim().slice(0, 200), filedById: actor.id, filedAt: new Date() } });
  await audit(prisma, { actorId: actor.id, action: "tax.return_intake_discarded", entityType: "ReturnIntake", entityId: intakeId, details: { reason: reason.trim() } });
}

// --- Review and release ------------------------------------------------------------

async function loadReturn(documentId: string) {
  const d = await prisma.document.findUnique({ where: { id: documentId } });
  if (!d || d.deletedAt || d.filingDocType !== "RETURN") throw new ValidationError("Return not found.");
  return d;
}

export async function submitReturnForRelease(actor: Actor, documentId: string) {
  const d = await loadReturn(documentId);
  if (d.reviewStatus !== "DRAFT") throw new ValidationError("Only a draft can be sent for review.");
  if (d.scanStatus !== "CLEAN") throw new ValidationError("This file hasn't passed the malware scan yet.");
  await prisma.document.update({ where: { id: d.id }, data: { reviewStatus: "AWAITING_REVIEW", submittedForReviewAt: new Date(), submittedForReviewById: actor.id } });
  await audit(prisma, { actorId: actor.id, action: "tax.return_submitted", entityType: "Document", entityId: d.id, clientId: d.clientId });
}

/** Only Tabitha releases a return to the client. A newer released version replaces older ones in the portal. */
export async function releaseReturn(actor: Actor, documentId: string) {
  if (!(await isReportApprover(actor))) throw new ForbiddenError("Only Tabitha can release a tax return to the client.");
  const d = await loadReturn(documentId);
  if (d.reviewStatus !== "AWAITING_REVIEW") throw new ValidationError("Send the return for review first.");
  if (d.scanStatus !== "CLEAN") throw new ValidationError("This file hasn't passed the malware scan, so it can't be released.");
  const older = d.filingId ? await prisma.document.findMany({ where: { filingId: d.filingId, filingDocType: "RETURN", id: { not: d.id }, visibility: "PUBLISHED" } }) : [];
  await prisma.$transaction([
    prisma.document.update({ where: { id: d.id }, data: { reviewStatus: "APPROVED", approvedAt: new Date(), approvedById: actor.id, visibility: "PUBLISHED", publishedAt: new Date() } }),
    ...older.map((o) => prisma.document.update({ where: { id: o.id }, data: { visibility: "STAFF_ONLY", supersededAt: new Date() } })),
    prisma.documentAccessLog.create({ data: { documentId: d.id, action: "PUBLISH", staffUserId: actor.id } }),
  ]);
  await audit(prisma, { actorId: actor.id, action: "tax.return_released", entityType: "Document", entityId: d.id, clientId: d.clientId, details: { replaced: older.map((o) => o.id) } });
  await notifyClientUsers(d.clientId, "FILING_UPDATE", d.id, d.category);
}

export async function returnsQueue() {
  const [intakes, drafts] = await Promise.all([
    prisma.returnIntake.findMany({ where: { status: "PENDING" }, orderBy: { createdAt: "asc" } }),
    prisma.document.findMany({
      where: { filingDocType: "RETURN", deletedAt: null, reviewStatus: { in: ["DRAFT", "AWAITING_REVIEW"] } },
      include: { client: { select: { id: true, displayName: true, businessName: true } }, filing: { select: { filingStatus: true, jurisdiction: true, filingType: true, returnType: true, taxYear: true } } },
      orderBy: { createdAt: "asc" },
    }),
  ]);
  const ids = [...new Set(intakes.map((i) => i.suggestedClientId).filter(Boolean))] as string[];
  const suggested = new Map((await prisma.client.findMany({ where: { id: { in: ids } }, select: { id: true, displayName: true, businessName: true } })).map((c) => [c.id, c]));
  return { intakes: intakes.map((i) => ({ ...i, suggested: i.suggestedClientId ? suggested.get(i.suggestedClientId) ?? null : null })), drafts };
}

// --- Email My Copy -----------------------------------------------------------------

/**
 * Emails the client a secure sign-in link to the return in their portal —
 * never the file and never a public link — at the verified address on their
 * own login. The delivery result is recorded and shown.
 */
export async function emailMyCopy(user: PortalActor, clientId: string, documentId: string) {
  await requireClientAccess(user.id, clientId, "tax");
  const login = await prisma.portalUser.findUniqueOrThrow({ where: { id: user.id }, select: { email: true, emailVerifiedAt: true } });
  if (!login.emailVerifiedAt) throw new ValidationError("Verify your email address first (Account settings), so we only send to an address we've confirmed.");
  const d = await prisma.document.findFirst({ where: { id: documentId, clientId, deletedAt: null, visibility: "PUBLISHED", scanStatus: "CLEAN", category: "TAXES" } });
  if (!d || !clientMayReceive(d) || (d.filingDocType === "RETURN" && d.reviewStatus !== "APPROVED")) throw new ValidationError("That return isn't available.");
  const link = `${appUrl()}/client/taxes/filings?account=${clientId}&year=${d.year ?? ""}`;
  const lines = ["You asked for a copy of your tax return.", "For your security we don't attach returns to email. Sign in to view, download or print it."];
  const res = await sendEmail({
    to: login.email,
    subject: `Your ${d.year ?? ""} tax return is in your portal`.replace("  ", " "),
    text: `${lines.join("\n\n")}\n\n${link}\n\n${BUSINESS.displayName}`,
    html: brandedEmailHtml({ heading: "Your tax return copy", paragraphs: lines, button: { label: "Sign in to view it", url: link }, footer: BUSINESS.displayName }),
    tags: { category: "return_copy" },
  });
  await prisma.notification.create({
    data: { portalUserId: user.id, channel: "EMAIL", kind: "RETURN_COPY", status: res.ok ? "SENT" : "FAILED", statusDetail: res.ok ? `Accepted by the email provider${res.providerId ? ` (ID ${res.providerId})` : ""}` : res.detail, sentAt: res.ok ? new Date() : null, idempotencyKey: `RETURN_COPY:${documentId}:${user.id}:${Date.now()}` },
  });
  await prisma.auditLog.create({ data: { action: "tax.return_copy_emailed", entityType: "Document", entityId: d.id, clientId, details: { portalUserId: user.id, ok: res.ok } } });
  return res.ok ? { ok: true as const, message: `Sent to ${login.email}. It contains a sign-in link, not the file.` } : { ok: false as const, message: `Not sent: ${res.detail}` };
}

export async function lastCopyEmails(portalUserId: string) {
  return prisma.notification.findMany({ where: { portalUserId, kind: "RETURN_COPY" }, orderBy: { createdAt: "desc" }, take: 3 });
}
