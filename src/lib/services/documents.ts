import "server-only";
import { randomUUID } from "node:crypto";
import type { DocumentCategory, DocumentVisibility, ReportType } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { audit } from "@/lib/audit";
import { assertAdmin, ForbiddenError, type Actor } from "@/lib/auth/actor";
import type { PortalActor } from "@/lib/portal/session";
import { allowedCategories, requireClientAccess } from "@/lib/portal/access";
import { storage } from "@/lib/storage";
import { sign, verifySignature } from "@/lib/crypto";
import { imageSize, MAX_UPLOAD_BYTES, MAX_UPLOAD_LABEL, sniffType } from "@/lib/files";
import { scanBytes } from "@/lib/scan";
import { ValidationError } from "./clients";
import { queuePortalNotification } from "./notifications";

export const CATEGORY_LABELS: Record<DocumentCategory, string> = {
  BOOKKEEPING: "Bookkeeping",
  TAXES: "Taxes",
  CONTRACTS: "Contracts",
  CLIENT_UPLOADS: "Client uploads",
  OTHER: "Other",
};

export const REPORT_LABELS: Record<ReportType, string> = {
  PROFIT_AND_LOSS: "Profit & loss",
  BALANCE_SHEET: "Balance sheet",
  OTHER_REPORT: "Other report",
};

type Uploader = { staff: Actor } | { portal: PortalActor };

export async function storeDocumentFile(bytes: Uint8Array, originalName: string, uploader: Uploader) {
  if (bytes.length === 0) throw new ValidationError("The file is empty.");
  if (bytes.length > MAX_UPLOAD_BYTES) throw new ValidationError(`Files can be up to ${MAX_UPLOAD_LABEL}.`);
  const type = sniffType(bytes);
  if (!type) throw new ValidationError("Upload a PDF, JPG, or PNG file.");
  const scan = await scanBytes(bytes);
  if (scan === "INFECTED") throw new ValidationError("This file was flagged by the virus scanner and was not saved.");
  const size = type.mime.startsWith("image/") ? imageSize(bytes, type.mime) : null;
  const storageKey = `client_document/${randomUUID()}`;
  await storage.put(storageKey, bytes);
  const name = originalName.replace(/[^\w.\- ()]/g, "_").slice(0, 150) || `document.${type.ext}`;
  return {
    storageKey,
    scan,
    fileData: {
      kind: "CLIENT_DOCUMENT" as const,
      storageKey,
      originalName: name,
      title: name.replace(/\.[^.]+$/, ""),
      mimeType: type.mime,
      sizeBytes: bytes.length,
      width: size?.width ?? null,
      height: size?.height ?? null,
      uploadedById: "staff" in uploader ? uploader.staff.id : null,
      uploadedByPortalUserId: "portal" in uploader ? uploader.portal.id : null,
    },
  };
}

export async function retentionDate(category: DocumentCategory): Promise<Date | null> {
  const policy = await prisma.retentionPolicy.findUnique({ where: { category } });
  if (!policy?.years) return null;
  const d = new Date();
  d.setFullYear(d.getFullYear() + policy.years);
  return d;
}

export type StaffUploadInput = {
  clientId: string;
  category: DocumentCategory;
  title?: string;
  year?: number | null;
  month?: number | null;
  visibility: DocumentVisibility;
  reportType?: ReportType | null;
  periodId?: string | null;
  bytes: Uint8Array;
  originalName: string;
  notify?: boolean;
};

export async function staffUploadDocument(actor: Actor, input: StaffUploadInput) {
  const client = await prisma.client.findUnique({ where: { id: input.clientId } });
  if (!client) throw new ValidationError("Client not found.");
  if (input.month && (input.month < 1 || input.month > 12)) throw new ValidationError("Month must be 1–12.");
  if (input.periodId && !(await prisma.bookkeepingPeriod.count({ where: { id: input.periodId, clientId: input.clientId } }))) throw new ValidationError("Bookkeeping month not found.");
  const stored = await storeDocumentFile(input.bytes, input.originalName, { staff: actor });
  try {
    const doc = await prisma.$transaction(async (tx) => {
      const file = await tx.storedFile.create({ data: stored.fileData });
      const published = input.visibility === "PUBLISHED";
      const doc = await tx.document.create({
        data: {
          clientId: input.clientId,
          category: input.category,
          title: input.title?.trim().slice(0, 200) || file.title,
          year: input.year ?? null,
          month: input.month ?? null,
          visibility: input.visibility,
          publishedAt: published ? new Date() : null,
          reportType: input.reportType ?? null,
          periodId: input.periodId ?? null,
          fileId: file.id,
          scanStatus: stored.scan,
          uploadedByStaffId: actor.id,
          retainUntil: await retentionDate(input.category),
        },
      });
      await tx.documentAccessLog.create({ data: { documentId: doc.id, action: "UPLOAD", staffUserId: actor.id } });
      await audit(tx, { actorId: actor.id, action: "document.uploaded", entityType: "Document", entityId: doc.id, clientId: input.clientId, details: { category: input.category, visibility: input.visibility } });
      return doc;
    });
    if (doc.visibility === "PUBLISHED" && input.notify !== false) await notifyClientUsers(doc.clientId, "NEW_DOCUMENT", doc.id, doc.category);
    return doc;
  } catch (err) {
    await storage.remove(stored.storageKey).catch(() => {});
    throw err;
  }
}

export async function setVisibility(actor: Actor, documentId: string, visibility: DocumentVisibility) {
  const doc = await prisma.document.findUnique({ where: { id: documentId } });
  if (!doc || doc.deletedAt) throw new ValidationError("Document not found.");
  if (visibility === "PUBLISHED" && doc.scanStatus === "INFECTED") throw new ValidationError("Infected files can't be published.");
  await prisma.$transaction([
    prisma.document.update({ where: { id: documentId }, data: { visibility, publishedAt: visibility === "PUBLISHED" ? doc.publishedAt ?? new Date() : null } }),
    prisma.documentAccessLog.create({ data: { documentId, action: visibility === "PUBLISHED" ? "PUBLISH" : "UNPUBLISH", staffUserId: actor.id } }),
    prisma.auditLog.create({ data: { actorId: actor.id, action: visibility === "PUBLISHED" ? "document.published" : "document.unpublished", entityType: "Document", entityId: documentId, clientId: doc.clientId } }),
  ]);
  if (visibility === "PUBLISHED" && !doc.publishedAt) await notifyClientUsers(doc.clientId, "NEW_DOCUMENT", doc.id, doc.category);
}

/** Client upload, optionally answering a document request. */
export async function portalUploadDocument(
  user: PortalActor,
  input: { clientId: string; requestId?: string | null; periodId?: string | null; title?: string; bytes: Uint8Array; originalName: string },
) {
  await requireClientAccess(user.id, input.clientId, "upload");
  let periodId = input.periodId ?? null;
  if (input.requestId) {
    const req = await prisma.documentRequest.findFirst({ where: { id: input.requestId, clientId: input.clientId } });
    if (!req || req.status === "CANCELLED" || req.status === "ACCEPTED") throw new ValidationError("That request is closed.");
    periodId = req.periodId;
  } else if (periodId && !(await prisma.bookkeepingPeriod.count({ where: { id: periodId, clientId: input.clientId } }))) {
    throw new ForbiddenError();
  }
  const period = periodId ? await prisma.bookkeepingPeriod.findUnique({ where: { id: periodId } }) : null;
  const stored = await storeDocumentFile(input.bytes, input.originalName, { portal: user });
  try {
    return await prisma.$transaction(async (tx) => {
      const file = await tx.storedFile.create({ data: stored.fileData });
      const doc = await tx.document.create({
        data: {
          clientId: input.clientId,
          category: "CLIENT_UPLOADS",
          title: input.title?.trim().slice(0, 200) || file.title,
          year: period?.year ?? new Date().getFullYear(),
          month: period?.month ?? null,
          // Uploads by the client are visible back to the client.
          visibility: "PUBLISHED",
          publishedAt: new Date(),
          fileId: file.id,
          scanStatus: stored.scan,
          uploadedByPortalId: user.id,
          periodId,
          requestId: input.requestId ?? null,
          retainUntil: await retentionDate("CLIENT_UPLOADS"),
        },
      });
      if (input.requestId) await tx.documentRequest.update({ where: { id: input.requestId }, data: { status: "SUBMITTED" } });
      await tx.documentAccessLog.create({ data: { documentId: doc.id, action: "UPLOAD", portalUserId: user.id } });
      await audit(tx, { actorId: null, action: "document.client_uploaded", entityType: "Document", entityId: doc.id, clientId: input.clientId, details: { portalUserId: user.id, requestId: input.requestId ?? null } });
      return doc;
    });
  } catch (err) {
    await storage.remove(stored.storageKey).catch(() => {});
    throw err;
  }
}

/** Documents a portal user may see for one client. */
export async function portalDocuments(user: PortalActor, clientId: string) {
  const access = await requireClientAccess(user.id, clientId);
  return prisma.document.findMany({
    where: { clientId, deletedAt: null, visibility: "PUBLISHED", category: { in: allowedCategories(access) }, scanStatus: { not: "INFECTED" } },
    include: { file: { select: { mimeType: true, sizeBytes: true, originalName: true } } },
    orderBy: [{ year: "desc" }, { month: "desc" }, { createdAt: "desc" }],
  });
}

// --- Expiring download links ----------------------------------------------

const LINK_TTL_MS = 15 * 60 * 1000;

/** A short-lived link bound to one document and one viewer. */
export function downloadToken(documentId: string, viewer: { staffId?: string; portalUserId?: string }, now = Date.now()) {
  const who = viewer.staffId ? `s:${viewer.staffId}` : `p:${viewer.portalUserId}`;
  const exp = now + LINK_TTL_MS;
  const payload = `${documentId}.${who}.${exp}`;
  return `${payload}.${sign(payload)}`;
}

export function parseDownloadToken(token: string, now = Date.now()) {
  const parts = token.split(".");
  if (parts.length !== 4) return null;
  const [documentId, who, exp, signature] = parts;
  if (!verifySignature(`${documentId}.${who}.${exp}`, signature)) return null;
  if (Number(exp) < now) return null;
  return { documentId, who };
}

/**
 * Re-checks authorization at download time: the link must match the signed-in
 * viewer, and portal users must still have access to that client/category.
 */
export async function authorizeDownload(token: string, viewer: { staffId?: string; portalUserId?: string }) {
  const parsed = parseDownloadToken(token);
  if (!parsed) return null;
  const expectedWho = viewer.staffId ? `s:${viewer.staffId}` : `p:${viewer.portalUserId}`;
  if (parsed.who !== expectedWho) return null;
  const doc = await prisma.document.findUnique({ where: { id: parsed.documentId }, include: { file: true } });
  if (!doc || doc.deletedAt) return null;
  if (viewer.portalUserId) {
    if (doc.visibility !== "PUBLISHED" || doc.scanStatus === "INFECTED") return null;
    try {
      const access = await requireClientAccess(viewer.portalUserId, doc.clientId);
      if (!allowedCategories(access).includes(doc.category as never)) return null;
    } catch {
      return null;
    }
  }
  return doc;
}

// --- Retention & audited deletion -----------------------------------------

export async function setRetention(actor: Actor, category: DocumentCategory, years: number | null) {
  assertAdmin(actor);
  if (years !== null && (years < 1 || years > 50)) throw new ValidationError("Choose 1–50 years, or keep until deleted.");
  await prisma.retentionPolicy.upsert({ where: { category }, update: { years, updatedById: actor.id }, create: { category, years, updatedById: actor.id } });
  await audit(prisma, { actorId: actor.id, action: "retention.updated", entityType: "RetentionPolicy", entityId: category, details: { years } });
}

/** Admin-only. Destroys the stored file, keeps a tombstone and audit trail. */
export async function deleteDocument(actor: Actor, documentId: string, reason: string) {
  assertAdmin(actor);
  if (!reason.trim()) throw new ValidationError("Record why this document is being deleted.");
  const doc = await prisma.document.findUnique({ where: { id: documentId }, include: { file: true } });
  if (!doc || doc.deletedAt) throw new ValidationError("Document not found.");
  const pinned = await prisma.signatureRequest.count({ where: { OR: [{ signedDocumentId: documentId }, { auditTrailDocumentId: documentId }] } });
  if (pinned) throw new ValidationError("Signed documents and signature audit trails can't be deleted here.");
  await storage.remove(doc.file.storageKey);
  await prisma.$transaction([
    prisma.document.update({ where: { id: documentId }, data: { deletedAt: new Date(), deletedById: actor.id, deletionReason: reason.trim().slice(0, 500), visibility: "STAFF_ONLY" } }),
    prisma.documentAccessLog.create({ data: { documentId, action: "DELETE", staffUserId: actor.id } }),
    prisma.auditLog.create({ data: { actorId: actor.id, action: "document.deleted", entityType: "Document", entityId: documentId, clientId: doc.clientId, details: { reason: reason.trim().slice(0, 500), title: doc.title } } }),
  ]);
}

async function notifyClientUsers(clientId: string, kind: string, refId: string, category?: DocumentCategory) {
  const grants = await prisma.portalAccess.findMany({ where: { clientId, revokedAt: null } });
  for (const g of grants) {
    if (category && !allowedCategories(g).includes(category as never)) continue;
    await queuePortalNotification(g.portalUserId, kind, `${kind}:${refId}`);
  }
}

export { notifyClientUsers };
