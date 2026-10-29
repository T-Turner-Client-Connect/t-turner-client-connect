import "server-only";
import { createHash, randomUUID } from "node:crypto";
import type { DocumentCategory, DocumentVisibility, ReportType } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { audit } from "@/lib/audit";
import { assertAdmin, ForbiddenError, type Actor } from "@/lib/auth/actor";
import type { PortalActor } from "@/lib/portal/session";
import { allowedCategories, requireClientAccess } from "@/lib/portal/access";
import { storage } from "@/lib/storage";
import { sign, verifySignature } from "@/lib/crypto";
import { imageSize, MAX_UPLOAD_BYTES, MAX_UPLOAD_LABEL, sniffType } from "@/lib/files";
import { scanBytes, scanConfigured } from "@/lib/scan";
import { queueStaffAlert } from "./staff-alerts";
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

// "system": files received from an integration (e.g. a Jotform submission).
type Uploader = { staff: Actor } | { portal: PortalActor } | { system: string };

export const sha256Of = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

/**
 * Originals are stored once per client: the same file (by content) can't be
 * added twice. Points the uploader at the copy already in the vault.
 */
export async function assertNotDuplicate(clientId: string, sha256: string, forClient = false) {
  const existing = await prisma.document.findFirst({ where: { clientId, deletedAt: null, file: { sha256 } }, select: { title: true, year: true } });
  // Clients aren't told the title (it may be a staff-only draft).
  if (existing && forClient) throw new ValidationError("We already have this exact file, so it wasn't added again.");
  if (existing) throw new ValidationError(`This file is already saved${existing.year ? ` under ${existing.year}` : ""} as “${existing.title}”, so it wasn't added again.`);
}

export async function storeDocumentFile(bytes: Uint8Array, originalName: string, uploader: Uploader, clientId?: string) {
  if (bytes.length === 0) throw new ValidationError("The file is empty.");
  if (bytes.length > MAX_UPLOAD_BYTES) throw new ValidationError(`Files can be up to ${MAX_UPLOAD_LABEL}.`);
  const type = sniffType(bytes);
  if (!type) throw new ValidationError("Upload a PDF, JPG, or PNG file.");
  const sha256 = sha256Of(bytes);
  if (clientId) await assertNotDuplicate(clientId, sha256, "portal" in uploader);
  const scan = await scanBytes(bytes, originalName);
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
      sha256,
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
  docType?: string | null;
  bytes: Uint8Array;
  originalName: string;
  notify?: boolean;
};

export async function staffUploadDocument(actor: Actor, input: StaffUploadInput) {
  const client = await prisma.client.findUnique({ where: { id: input.clientId } });
  if (!client) throw new ValidationError("Client not found.");
  if (input.month && (input.month < 1 || input.month > 12)) throw new ValidationError("Month must be 1–12.");
  if (input.periodId && !(await prisma.bookkeepingPeriod.count({ where: { id: input.periodId, clientId: input.clientId } }))) throw new ValidationError("Bookkeeping month not found.");
  const stored = await storeDocumentFile(input.bytes, input.originalName, { staff: actor }, input.clientId);
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
          docType: input.docType ?? null,
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
    // Clients are told only once the file has passed the malware scan.
    if (doc.visibility === "PUBLISHED" && doc.scanStatus === "CLEAN" && input.notify !== false) await notifyClientUsers(doc.clientId, "NEW_DOCUMENT", doc.id, doc.category);
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
  if (visibility === "PUBLISHED" && !doc.publishedAt && doc.scanStatus === "CLEAN") await notifyClientUsers(doc.clientId, "NEW_DOCUMENT", doc.id, doc.category);
}

/** Client upload, optionally answering a document request. */
export async function portalUploadDocument(
  user: PortalActor,
  input: { clientId: string; requestId?: string | null; periodId?: string | null; title?: string; year?: number | "unsure" | null; docType?: string | null; bytes: Uint8Array; originalName: string },
) {
  await requireClientAccess(user.id, input.clientId, "upload");
  const thisYear = new Date().getFullYear();
  if (typeof input.year === "number" && (input.year < thisYear - 15 || input.year > thisYear + 1)) throw new ValidationError("Choose a tax year from the list.");
  let periodId = input.periodId ?? null;
  if (input.requestId) {
    const req = await prisma.documentRequest.findFirst({ where: { id: input.requestId, clientId: input.clientId } });
    if (!req || req.status === "CANCELLED" || req.status === "ACCEPTED") throw new ValidationError("That request is closed.");
    periodId = req.periodId;
  } else if (periodId && !(await prisma.bookkeepingPeriod.count({ where: { id: periodId, clientId: input.clientId } }))) {
    throw new ForbiddenError();
  }
  const period = periodId ? await prisma.bookkeepingPeriod.findUnique({ where: { id: periodId } }) : null;
  const stored = await storeDocumentFile(input.bytes, input.originalName, { portal: user }, input.clientId);
  try {
    const saved = await prisma.$transaction(async (tx) => {
      const file = await tx.storedFile.create({ data: stored.fileData });
      const doc = await tx.document.create({
        data: {
          clientId: input.clientId,
          category: "CLIENT_UPLOADS",
          title: input.title?.trim().slice(0, 200) || file.title,
          // The client confirms the year; "Not sure" stays empty for staff to classify.
          year: period?.year ?? (typeof input.year === "number" ? input.year : null),
          month: period?.month ?? null,
          // Uploads by the client are visible back to the client.
          visibility: "PUBLISHED",
          publishedAt: new Date(),
          fileId: file.id,
          scanStatus: stored.scan,
          uploadedByPortalId: user.id,
          // Stays "Needs Review" until a staff member acknowledges it.
          needsReview: true,
          periodId,
          requestId: input.requestId ?? null,
          docType: input.docType ?? null,
          retainUntil: await retentionDate("CLIENT_UPLOADS"),
        },
      });
      if (input.requestId) await tx.documentRequest.update({ where: { id: input.requestId }, data: { status: "SUBMITTED" } });
      await tx.documentAccessLog.create({ data: { documentId: doc.id, action: "UPLOAD", portalUserId: user.id } });
      await audit(tx, { actorId: null, action: "document.client_uploaded", entityType: "Document", entityId: doc.id, clientId: input.clientId, details: { portalUserId: user.id, requestId: input.requestId ?? null } });
      return doc;
    });
    // Grouped office alerts: a text inside weekday hours and a link-only email.
    await queueStaffAlert({ documentId: saved.id });
    return saved;
  } catch (err) {
    await storage.remove(stored.storageKey).catch(() => {});
    throw err;
  }
}

/** Documents a portal user may see for one client. */
export async function portalDocuments(user: PortalActor, clientId: string) {
  const access = await requireClientAccess(user.id, clientId);
  return prisma.document.findMany({
    // Quarantined files (not yet scanned clean) never reach the portal.
    where: { clientId, deletedAt: null, visibility: "PUBLISHED", category: { in: allowedCategories(access) }, scanStatus: "CLEAN" },
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
  // Quarantine: nobody — staff or client — downloads a file until it has scanned clean.
  if (doc.scanStatus !== "CLEAN") return null;
  if (viewer.portalUserId) {
    if (doc.visibility !== "PUBLISHED") return null;
    try {
      const access = await requireClientAccess(viewer.portalUserId, doc.clientId);
      if (!allowedCategories(access).includes(doc.category as never)) return null;
    } catch {
      return null;
    }
    if (isHistorical(doc) && !(await portalVerified(viewer.portalUserId))) return null;
  }
  return doc;
}

/**
 * Past-year records from our office (before last tax year) open only for a
 * portal login with a proven email address or staff-confirmed identity.
 * The client's own uploads are never locked.
 */
export function isHistorical(doc: { year: number | null; uploadedByStaffId: string | null }, now = new Date()) {
  return !!doc.uploadedByStaffId && doc.year !== null && doc.year < now.getFullYear() - 1;
}

export async function portalVerified(portalUserId: string) {
  const u = await prisma.portalUser.findUnique({ where: { id: portalUserId }, select: { emailVerifiedAt: true, identityVerifiedAt: true } });
  return !!(u?.emailVerifiedAt || u?.identityVerifiedAt);
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

// --- Malware scan quarantine ------------------------------------------------

/**
 * Re-scans quarantined client documents. CLEAN releases the file (and sends
 * the client's "new document" notice if it was published); INFECTED destroys
 * the stored bytes and keeps only the record. Safe to run repeatedly.
 */
export async function scanQuarantined(limit = 25) {
  if (!scanConfigured()) return { scanned: 0, clean: 0, infected: 0 };
  const docs = await prisma.document.findMany({
    where: { deletedAt: null, scanStatus: { in: ["NOT_SCANNED", "PENDING"] } },
    include: { file: true },
    orderBy: { createdAt: "asc" },
    take: limit,
  });
  let clean = 0;
  let infected = 0;
  for (const d of docs) {
    const bytes = await storage.get(d.file.storageKey);
    if (!bytes) continue;
    const result = await scanBytes(bytes, d.file.originalName);
    if (result === "CLEAN") {
      const res = await prisma.document.updateMany({ where: { id: d.id, scanStatus: { in: ["NOT_SCANNED", "PENDING"] } }, data: { scanStatus: "CLEAN" } });
      if (res.count === 1) {
        clean++;
        await prisma.auditLog.create({ data: { action: "document.scan_clean", entityType: "Document", entityId: d.id, clientId: d.clientId } });
        if (d.visibility === "PUBLISHED" && d.uploadedByStaffId) await notifyClientUsers(d.clientId, "NEW_DOCUMENT", d.id, d.category);
      }
    } else if (result === "INFECTED") {
      await storage.remove(d.file.storageKey).catch(() => {});
      await prisma.document.update({ where: { id: d.id }, data: { scanStatus: "INFECTED", visibility: "STAFF_ONLY" } });
      await prisma.auditLog.create({ data: { action: "document.scan_infected_destroyed", entityType: "Document", entityId: d.id, clientId: d.clientId } });
      infected++;
    } else if (d.scanStatus === "NOT_SCANNED") {
      await prisma.document.update({ where: { id: d.id }, data: { scanStatus: "PENDING" } });
    }
  }
  return { scanned: docs.length, clean, infected };
}

export async function quarantinedDocuments() {
  return prisma.document.findMany({
    where: { deletedAt: null, scanStatus: { not: "CLEAN" } },
    include: { client: { select: { id: true, displayName: true } } },
    orderBy: { createdAt: "desc" },
    take: 100,
  });
}

/** Staff acknowledge a client upload (clears "Needs Review"). */
export async function acknowledgeDocuments(actor: Actor, clientId: string, documentIds?: string[]) {
  const res = await prisma.document.updateMany({
    where: { clientId, needsReview: true, ...(documentIds ? { id: { in: documentIds } } : {}) },
    data: { needsReview: false, reviewedAt: new Date(), reviewedById: actor.id },
  });
  if (res.count) await prisma.auditLog.create({ data: { actorId: actor.id, action: "document.reviewed", entityType: "Client", entityId: clientId, clientId, details: { count: res.count } } });
  return res.count;
}
