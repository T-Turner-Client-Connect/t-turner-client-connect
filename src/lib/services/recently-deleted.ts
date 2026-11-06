import "server-only";
import { prisma } from "@/lib/prisma";
import { assertOwner, ownerAudit } from "@/lib/auth/owner";
import type { Actor } from "@/lib/auth/actor";
import { storage, type Driver } from "@/lib/storage";
import { ValidationError } from "./clients";
import { backedUpKeys } from "./file-encryption";

/**
 * "Recently deleted" (Owner's Office). deleteDocument (documents.ts) hides a document from every
 * staff and client list and sets purgeAfter = deletion + 30 days; the bytes stay. From here the
 * owner can restore it, or delete it permanently now (typed confirmation + reason). The nightly
 * purge removes bytes only for documents past purgeAfter whose file is in a successful backup.
 * Every restore, permanent deletion and purge is recorded (audit log, access log, owner log).
 */

export const PERMANENT_DELETE_PHRASE = "DELETE PERMANENTLY";

export async function recentlyDeleted(actor: Actor) {
  await assertOwner(actor);
  const docs = await prisma.document.findMany({
    // Deletions from before recoverable deletion (no purgeAfter) already had their bytes removed.
    where: { deletedAt: { not: null }, purgedAt: null, purgeAfter: { not: null } },
    include: { client: { select: { id: true, displayName: true } }, file: { select: { storageKey: true, sizeBytes: true, originalName: true } } },
    orderBy: { deletedAt: "desc" },
    take: 500,
  });
  const backed = await backedUpKeys(docs.map((d) => d.file.storageKey));
  const deleters = new Map((await prisma.user.findMany({ where: { id: { in: docs.map((d) => d.deletedById).filter((x): x is string => !!x) } }, select: { id: true, name: true } })).map((u) => [u.id, u.name]));
  const now = Date.now();
  return docs.map((d) => ({ ...d, backedUp: backed.has(d.file.storageKey), deletedByName: d.deletedById ? deleters.get(d.deletedById) ?? "Staff" : null, daysLeft: d.purgeAfter ? Math.max(0, Math.ceil((d.purgeAfter.getTime() - now) / 86_400_000)) : null }));
}

export async function restoreDeletedDocument(actor: Actor, documentId: string) {
  await assertOwner(actor);
  const doc = await prisma.document.findUnique({ where: { id: documentId }, include: { file: true } });
  if (!doc || !doc.deletedAt) throw new ValidationError("That document isn't in Recently deleted.");
  if (doc.purgedAt) throw new ValidationError("This document's file was already removed permanently, so it can't be restored here. It may still be in an older backup.");
  if (!(await storage.get(doc.file.storageKey))) throw new ValidationError("The stored file is missing, so the document can't be restored. Check the backups.");
  const deletion = await prisma.auditLog.findFirst({ where: { entityType: "Document", entityId: documentId, action: "document.deleted" }, orderBy: { createdAt: "desc" } });
  const before = (deletion?.details as { visibilityBefore?: string } | null)?.visibilityBefore;
  const visibility = before === "PUBLISHED" || before === "STAFF_ONLY" ? before : "STAFF_ONLY";
  const now = new Date();
  await prisma.$transaction([
    prisma.document.update({ where: { id: documentId }, data: { deletedAt: null, deletedById: null, purgeAfter: null, restoredAt: now, restoredById: actor.id, visibility } }),
    prisma.documentAccessLog.create({ data: { documentId, action: "RESTORE", staffUserId: actor.id } }),
    prisma.auditLog.create({ data: { actorId: actor.id, action: "document.restored", entityType: "Document", entityId: documentId, clientId: doc.clientId, details: { title: doc.title, deletedAt: doc.deletedAt.toISOString(), deletionReason: doc.deletionReason, visibility } } }),
  ]);
  await ownerAudit(actor.id, "document.restored", "Document", documentId, { title: doc.title });
}

async function removeBytes(doc: { id: string; file: { storageKey: string; id: string } }, store: Driver) {
  await store.remove(doc.file.storageKey);
  // A plaintext original kept by the encryption job is a copy of the same document: it goes too.
  const originals = await prisma.pendingOriginalRemoval.findMany({ where: { sourceType: "StoredFile", sourceId: doc.file.id, removedAt: null } });
  for (const o of originals) {
    await store.remove(o.originalKey).catch(() => {});
    await prisma.pendingOriginalRemoval.update({ where: { id: o.id }, data: { removedAt: new Date() } });
  }
  // Backups keep it only as long as the retention policy keeps the nights that list it.
  await prisma.backupFileIndex.updateMany({ where: { storageKey: doc.file.storageKey, goneAt: null }, data: { goneAt: new Date() } });
}

/** Owner-only: removes the bytes now, without waiting 30 days. Needs the typed phrase and a reason. */
export async function deletePermanentlyNow(actor: Actor, documentId: string, typed: string, reason: string, store: Driver = storage) {
  await assertOwner(actor);
  if (typed.trim() !== PERMANENT_DELETE_PHRASE) throw new ValidationError(`Type ${PERMANENT_DELETE_PHRASE} to confirm.`);
  if (reason.trim().length < 3) throw new ValidationError("Record why this document is being removed permanently.");
  const doc = await prisma.document.findUnique({ where: { id: documentId }, include: { file: true } });
  if (!doc || !doc.deletedAt) throw new ValidationError("Only a document in Recently deleted can be removed permanently.");
  if (doc.purgedAt) throw new ValidationError("Already removed permanently.");
  await removeBytes(doc, store);
  const now = new Date();
  await prisma.$transaction([
    prisma.document.update({ where: { id: documentId }, data: { purgedAt: now, purgedById: actor.id } }),
    prisma.documentAccessLog.create({ data: { documentId, action: "PURGE", staffUserId: actor.id } }),
    prisma.auditLog.create({ data: { actorId: actor.id, action: "document.purged_now", entityType: "Document", entityId: documentId, clientId: doc.clientId, details: { title: doc.title, reason: reason.trim().slice(0, 500), deletedAt: doc.deletedAt.toISOString() } } }),
  ]);
  await ownerAudit(actor.id, "document.purged_now", "Document", documentId, { title: doc.title, reason: reason.trim().slice(0, 500) });
}

/**
 * Nightly purge (runs after a successful backup). Removes bytes only for deleted documents past
 * purgeAfter whose file is confirmed in at least one successful backup. Everything else waits.
 */
export async function purgeExpiredDeletions(now = new Date(), store: Driver = storage) {
  const due = await prisma.document.findMany({ where: { deletedAt: { not: null }, purgedAt: null, purgeAfter: { lte: now } }, include: { file: true }, take: 500 });
  const backed = await backedUpKeys(due.map((d) => d.file.storageKey));
  let purged = 0, waitingForBackup = 0;
  for (const d of due) {
    if (!backed.has(d.file.storageKey)) {
      waitingForBackup++;
      continue;
    }
    await removeBytes(d, store);
    await prisma.$transaction([
      prisma.document.update({ where: { id: d.id }, data: { purgedAt: now } }),
      prisma.documentAccessLog.create({ data: { documentId: d.id, action: "PURGE" } }),
      prisma.auditLog.create({ data: { action: "document.purged", entityType: "Document", entityId: d.id, clientId: d.clientId, details: { title: d.title, deletedAt: d.deletedAt!.toISOString(), purgeAfter: d.purgeAfter?.toISOString() ?? null, backedUp: true } } }),
    ]);
    purged++;
  }
  return { purged, waitingForBackup };
}
