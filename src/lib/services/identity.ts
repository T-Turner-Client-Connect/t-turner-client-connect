import "server-only";
import { prisma } from "@/lib/prisma";
import { audit } from "@/lib/audit";
import { assertAdmin, ForbiddenError, type Actor } from "@/lib/auth/actor";
import { requireClientAccess } from "@/lib/portal/access";
import type { PortalActor } from "@/lib/portal/session";
import { daysBetween, officeToday } from "@/lib/tax/deadlines";
import { ValidationError } from "./clients";
import { retentionDate, storeDocumentFile } from "./documents";
import { queuePortalNotification } from "./notifications";
import { queueStaffAlert } from "./staff-alerts";
import { storage } from "@/lib/storage";

/**
 * Identity Documents: a permanent section of each client's vault, separate
 * from yearly tax folders. Files are Documents in the IDENTITY category, so
 * malware scanning, private storage, access logs and the retention policy
 * all apply. Every upload is "Pending verification" until staff review it.
 * Only Admins, the client's assigned staff member, and portal account
 * holders granted identity access can open them. Notifications never name
 * the document type or include any identity details.
 */

export const ID_TYPES = {
  DRIVERS_LICENSE: { label: "Driver's license", expires: true, replaceReasons: ["Renewed license", "Name or address change", "Corrected information", "Unreadable copy", "Other"] },
  BIRTH_CERTIFICATE: { label: "Birth certificate", expires: false, replaceReasons: ["Corrected certificate", "Updated certificate", "Unreadable copy", "Other"] },
  SOCIAL_SECURITY_CARD: { label: "Social Security card", expires: false, replaceReasons: ["Name change", "Corrected information", "Unreadable copy", "Other"] },
  PASSPORT: { label: "Passport", expires: true, replaceReasons: ["Renewed passport", "Name change", "Corrected information", "Unreadable copy", "Other"] },
} as const;
export type IdType = keyof typeof ID_TYPES;
/** Kept when we have one, but never listed as missing (a passport is optional). */
export const OPTIONAL_ID_TYPES: readonly IdType[] = ["PASSPORT"];
/** The slots shown for one person: every required type, plus optional ones only when something is on file. */
const slotTypesFor = (records: { type: string }[]) => (Object.keys(ID_TYPES) as IdType[]).filter((t) => !OPTIONAL_ID_TYPES.includes(t) || records.some((r) => r.type === t));
export const isIdType = (t: string): t is IdType => t in ID_TYPES;

// OWNER: one business owner on a business account (IdentityPerson.businessOwnerId). Their identity
// documents are sent only when our office asks, and open only for that owner's login (plus staff).
export const ID_ROLES = { CLIENT: "Client", SPOUSE: "Spouse", DEPENDENT: "Dependent", OWNER: "Business owner" } as const;
export type IdRole = keyof typeof ID_ROLES;

export const ID_STATUS = {
  PENDING_VERIFICATION: "Pending verification",
  VERIFIED: "Verified",
  REJECTED: "Not accepted",
  REPLACED: "Replaced",
  EXPIRED: "Expired",
} as const;

export const REMINDER_DAYS = [60, 30, 7] as const;

/**
 * Social Security cards (whose images show the full number) and birth
 * certificates are Admin-only: no client, no portal user and no non-Admin
 * staff member can view, download, print or export them. Clients may upload
 * or replace them and see verification status only.
 */
export const ADMIN_ONLY_TYPES = ["SOCIAL_SECURITY_CARD", "BIRTH_CERTIFICATE"] as const;
export const isAdminOnlyType = (t: string | null | undefined) => !!t && (ADMIN_ONLY_TYPES as readonly string[]).includes(t);

/** Whether a staff member may open (view/download/print) one identity file. */
export async function canStaffOpenIdentityFile(actor: { id: string; role: string }, clientId: string, type: string | null) {
  if (isAdminOnlyType(type)) {
    const u = await prisma.user.findUnique({ where: { id: actor.id }, select: { role: true, active: true } });
    return !!u?.active && u.role === "ADMIN";
  }
  return canStaffViewIdentity(actor, clientId);
}

/**
 * Identity files are for our office only (Tabitha's rule): once uploaded, no portal login can view,
 * download or print one, of any type. Clients still see each document's status (on file, pending,
 * missing, expired) and can upload or replace their own.
 */
export async function portalMayOpenIdentityFile(portalUserId: string, clientId: string, type: string | null) {
  void portalUserId; void clientId; void type;
  return false;
}

/** Masked display for a Social Security card; the full number is never stored. */
export const maskedSsn = (last4: string | null) => `•••-••-${last4 ?? "••••"}`;

// --- Who may see identity documents ------------------------------------------

/** Admins and the staff member assigned to the client. */
/**
 * Admins, the staff member assigned to the client, and staff an Admin has
 * explicitly granted identity access for all clients. That grant never
 * opens the Owner's Office, which is bound to the owner's own account.
 */
export async function canStaffViewIdentity(actor: { id: string; role: string }, clientId: string) {
  if (actor.role === "ADMIN") return true;
  const [c, u] = await Promise.all([
    prisma.client.findUnique({ where: { id: clientId }, select: { assignedToId: true } }),
    prisma.user.findUnique({ where: { id: actor.id }, select: { identityAccessAll: true, active: true } }),
  ]);
  if (!c || !u?.active) return false;
  return c.assignedToId === actor.id || u.identityAccessAll;
}

/** Admin-only: let a staff member open identity documents for every client. */
export async function setIdentityAccessAll(admin: Actor, userId: string, on: boolean) {
  assertAdmin(admin);
  const u = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
  if (u.role === "ADMIN") throw new ValidationError("Admins already have identity access.");
  await prisma.user.update({ where: { id: userId }, data: { identityAccessAll: on, identityAccessGrantedBy: on ? admin.id : null, identityAccessGrantedAt: on ? new Date() : null } });
  await audit(prisma, { actorId: admin.id, action: on ? "identity.access_granted" : "identity.access_removed", entityType: "User", entityId: userId });
}

async function requireStaff(actor: Actor, clientId: string) {
  if (!(await canStaffViewIdentity(actor, clientId))) throw new ForbiddenError("Only an Admin or the client's assigned staff member can work with identity documents.");
}

async function requirePortal(user: PortalActor, clientId: string, upload = false) {
  const access = await requireClientAccess(user.id, clientId, upload ? "upload" : undefined);
  if (!access.canViewIdentity) throw new ForbiddenError("Identity documents aren't included in your access to this account.");
  return access;
}

/** The business-owner record(s) this login is, on this client. */
async function ownerIdsOf(portalUserId: string, clientId: string) {
  return (await prisma.businessOwner.findMany({ where: { clientId, portalUserId, archivedAt: null }, select: { id: true } })).map((o) => o.id);
}

/**
 * An owner's identity documents on a business-only account: only while our office has an open
 * identity request for that owner (DocumentRequest kind OWNER_PERSONAL, an identity docType,
 * DocumentRequest.businessOwnerId), and only by that owner's own login.
 */
async function requireOwnerIdentity(user: PortalActor, clientId: string, person: { businessOwnerId: string | null }, type: string) {
  // The office asked this owner for it: answering needs no upload access to the business's files.
  await requireClientAccess(user.id, clientId);
  if (!person.businessOwnerId || !(await ownerIdsOf(user.id, clientId)).includes(person.businessOwnerId)) throw new ForbiddenError("That person's documents aren't yours to send.");
  const open = await prisma.documentRequest.count({ where: { clientId, businessOwnerId: person.businessOwnerId, kind: "OWNER_PERSONAL", status: "OPEN", docType: type } });
  if (!open) throw new ForbiddenError("Our office hasn't asked for this document. Please message us first.");
}

/**
 * Download check used by the document link route (portal side) for identity files NOT tied to a
 * business owner. On a business account there are none a login may open: an identity file there
 * opens only for the owner it's assigned to (Document.businessOwnerId, checked in authorizeDownload).
 */
export async function portalMayOpenIdentity(portalUserId: string, clientId: string) {
  const access = await prisma.portalAccess.findFirst({ where: { portalUserId, clientId, revokedAt: null, client: { archivedAt: null } }, include: { client: { select: { clientType: true } } } });
  if (!access || access.client.clientType === "BUSINESS") return false;
  return access.canViewIdentity;
}

// --- Business accounts ----------------------------------------------------------------
//
// On a BUSINESS client, identity documents belong to one owner each (IdentityPerson.businessOwnerId,
// and Document.businessOwnerId on the file) and appear in the portal only for that owner's own login.
// Anything filed on the business's own record (the CLIENT/SPOUSE/DEPENDENT people, from before owner
// records existed) is staff-only until a staff member assigns it to an owner. Portal logins can't
// upload to, add people to, or remove people from the business's own record.

/** Whether this client is a business account (identity documents are per-owner there). */
export async function isBusinessClient(clientId: string) {
  const c = await prisma.client.findUnique({ where: { id: clientId }, select: { clientType: true } });
  return c?.clientType === "BUSINESS";
}

const BUSINESS_RECORD_REFUSED = "On a business account, identity documents are kept for each owner separately. Our office will ask you if we need yours.";

// --- People ---------------------------------------------------------------------

/** The client always has a person record; spouses and dependents are added as needed. */
export async function ensureClientPerson(clientId: string) {
  const existing = await prisma.identityPerson.findFirst({ where: { clientId, role: "CLIENT", archivedAt: null } });
  if (existing) return existing;
  const c = await prisma.client.findUniqueOrThrow({ where: { id: clientId }, select: { displayName: true, firstName: true, lastName: true } });
  return prisma.identityPerson.create({ data: { clientId, role: "CLIENT", name: [c.firstName, c.lastName].filter(Boolean).join(" ") || c.displayName } });
}

export async function addPerson(who: { staff: Actor } | { portal: PortalActor }, clientId: string, input: { role: string; name: string }) {
  if ("staff" in who) await requireStaff(who.staff, clientId);
  else {
    await requirePortal(who.portal, clientId, true);
    if (await isBusinessClient(clientId)) throw new ForbiddenError(BUSINESS_RECORD_REFUSED);
  }
  if (input.role !== "SPOUSE" && input.role !== "DEPENDENT") throw new ValidationError("Choose spouse or dependent.");
  const name = input.name.trim().slice(0, 120);
  if (!name) throw new ValidationError("Enter their name.");
  if (input.role === "SPOUSE" && (await prisma.identityPerson.count({ where: { clientId, role: "SPOUSE", archivedAt: null } }))) throw new ValidationError("A spouse is already listed.");
  const p = await prisma.identityPerson.create({ data: { clientId, role: input.role, name } });
  await audit(prisma, { actorId: "staff" in who ? who.staff.id : null, action: "identity.person_added", entityType: "IdentityPerson", entityId: p.id, clientId, details: { role: input.role } });
  return p;
}

/**
 * Removes a spouse or dependent from the list (kept in history, never erased).
 * A client may remove someone they added only until anything has been submitted for that
 * person; after that only our office can remove them, so submitted records stay intact.
 */
export async function removePerson(who: { staff: Actor } | { portal: PortalActor }, clientId: string, personId: string, reason?: string) {
  if ("staff" in who) await requireStaff(who.staff, clientId);
  else {
    await requirePortal(who.portal, clientId, true);
    if (await isBusinessClient(clientId)) throw new ForbiddenError(BUSINESS_RECORD_REFUSED);
  }
  const person = await prisma.identityPerson.findFirst({ where: { id: personId, clientId, archivedAt: null } });
  if (!person) throw new ValidationError("That person isn't listed.");
  if (person.role === "CLIENT") throw new ValidationError("The account holder can't be removed.");
  const submitted = await prisma.identityDocument.count({ where: { personId } });
  if ("portal" in who && submitted > 0) throw new ValidationError("Documents were already submitted for this person, so only our office can remove them. Please send us a message.");
  await prisma.identityPerson.update({ where: { id: personId }, data: { archivedAt: new Date() } });
  await audit(prisma, { actorId: "staff" in who ? who.staff.id : null, action: "identity.person_removed", entityType: "IdentityPerson", entityId: personId, clientId, details: { role: person.role, byClient: "portal" in who, documentsKept: submitted, reason: reason?.trim().slice(0, 300) || null } });
}

// --- Uploads ------------------------------------------------------------------------

export type IdUploadInput = { clientId: string; personId: string; type: string; expiresOn?: string | null; replacementReason?: string | null; bytes: Uint8Array; originalName: string };

export async function uploadIdentityDocument(who: { staff: Actor } | { portal: PortalActor }, input: IdUploadInput) {
  if (!isIdType(input.type)) throw new ValidationError("Choose the kind of document.");
  const person = await prisma.identityPerson.findFirst({ where: { id: input.personId, clientId: input.clientId, archivedAt: null } });
  if ("staff" in who) await requireStaff(who.staff, input.clientId);
  // A business owner's own identity document: only on our office's request, only by that owner.
  else if (person?.businessOwnerId) await requireOwnerIdentity(who.portal, input.clientId, person, input.type);
  else {
    await requirePortal(who.portal, input.clientId, true);
    // Never to a business account's own record: identity documents there are filed per owner.
    if (await isBusinessClient(input.clientId)) throw new ForbiddenError(BUSINESS_RECORD_REFUSED);
  }
  if (!person) throw new ValidationError("Choose whose document this is.");
  const t = ID_TYPES[input.type];
  let expiresOn: string | null = null;
  if (t.expires) {
    if (!input.expiresOn || !/^\d{4}-\d{2}-\d{2}$/.test(input.expiresOn) || Number.isNaN(Date.parse(input.expiresOn))) throw new ValidationError("Enter the expiration date printed on the license.");
    if (input.expiresOn < officeToday()) throw new ValidationError("This license has already expired. Please upload the renewed license.");
    expiresOn = input.expiresOn;
  }
  // Replacing an existing document needs a reason (renewal, name change, correction…).
  const existing = await prisma.identityDocument.count({ where: { personId: person.id, type: input.type, status: { in: ["VERIFIED", "PENDING_VERIFICATION", "EXPIRED"] } } });
  const reason = input.replacementReason?.trim().slice(0, 120) || null;
  if (existing && !reason) throw new ValidationError("Tell us why you're replacing the document on file.");

  // The same file is already on file for this client (e.g. a questionnaire upload that wasn't
  // filed into Identity): that one stored copy moves into Identity Documents instead of the upload
  // being refused as a duplicate.
  const { sha256Of } = await import("./documents");
  const onFile = await prisma.document.findFirst({ where: { clientId: input.clientId, deletedAt: null, file: { sha256: sha256Of(input.bytes) } }, select: { id: true, category: true } });
  if (onFile && onFile.category === "IDENTITY") throw new ValidationError("This exact file is already in Identity Documents.");
  if (onFile) {
    const { fileIntoIdentity } = await import("./identity-import");
    const r = await fileIntoIdentity("staff" in who ? who.staff : null, { clientId: input.clientId, documentId: onFile.id, filing: { type: input.type, role: (person.role === "OWNER" ? "CLIENT" : person.role) as Exclude<IdRole, "OWNER"> }, takenAt: new Date(), personId: person.id });
    if (!r.filed) throw new ValidationError(`This file is already saved for this client, and it couldn't be moved into Identity Documents: ${r.reason ?? "unknown reason"}`);
    const rec = await prisma.identityDocument.findFirstOrThrow({ where: { documentId: onFile.id }, orderBy: { createdAt: "desc" } });
    // What this upload said (license expiration, replacement reason) goes with it.
    const updated = await prisma.identityDocument.update({ where: { id: rec.id }, data: { expiresOn, replacementReason: reason, uploadedByStaffId: "staff" in who ? who.staff.id : rec.uploadedByStaffId, uploadedByPortalId: "portal" in who ? who.portal.id : null } });
    // A business owner's document belongs to that owner only.
    if (person.businessOwnerId) await prisma.document.update({ where: { id: onFile.id }, data: { businessOwnerId: person.businessOwnerId } });
    await audit(prisma, { actorId: "staff" in who ? who.staff.id : null, action: "identity.uploaded", entityType: "IdentityDocument", entityId: rec.id, clientId: input.clientId, details: { type: input.type, role: person.role, replacement: !!existing, fromFileOnFile: true } });
    if ("portal" in who) await queueStaffAlert({ documentId: onFile.id });
    return updated;
  }

  const uploader = "staff" in who ? { staff: who.staff } : { portal: who.portal };
  const stored = await storeDocumentFile(input.bytes, input.originalName, uploader, input.clientId, { encrypt: true });
  try {
    const rec = await prisma.$transaction(async (tx) => {
      const file = await tx.storedFile.create({ data: stored.fileData });
      const doc = await tx.document.create({
        data: {
          clientId: input.clientId,
          category: "IDENTITY",
          // Generic title: no names or numbers in lists, alerts or logs.
          title: `${t.label} — ${ID_ROLES[person.role as IdRole]}`,
          // Visible only through the Identity Documents section (never in yearly folders).
          visibility: "PUBLISHED",
          publishedAt: new Date(),
          fileId: file.id,
          scanStatus: stored.scan,
          ...stored.scanMeta,
          uploadedByStaffId: "staff" in who ? who.staff.id : null,
          uploadedByPortalId: "portal" in who ? who.portal.id : null,
          needsReview: true,
          docType: input.type,
          // A business owner's identity document belongs to that owner only.
          businessOwnerId: person.businessOwnerId,
          retainUntil: await retentionDate("IDENTITY"),
        },
      });
      await tx.documentAccessLog.create({ data: { documentId: doc.id, action: "UPLOAD", staffUserId: "staff" in who ? who.staff.id : null, portalUserId: "portal" in who ? who.portal.id : null } });
      const rec = await tx.identityDocument.create({
        data: {
          clientId: input.clientId,
          personId: person.id,
          type: input.type,
          documentId: doc.id,
          expiresOn,
          replacementReason: reason,
          uploadedByStaffId: "staff" in who ? who.staff.id : null,
          uploadedByPortalId: "portal" in who ? who.portal.id : null,
        },
      });
      await audit(tx, { actorId: "staff" in who ? who.staff.id : null, action: "identity.uploaded", entityType: "IdentityDocument", entityId: rec.id, clientId: input.clientId, details: { type: input.type, role: person.role, replacement: !!existing } });
      // Answers our office's open request for this owner's document.
      if (person.businessOwnerId) {
        const req = await tx.documentRequest.findFirst({ where: { clientId: input.clientId, businessOwnerId: person.businessOwnerId, kind: "OWNER_PERSONAL", status: "OPEN", docType: input.type }, select: { id: true } });
        if (req) {
          await tx.documentRequest.update({ where: { id: req.id }, data: { status: "SUBMITTED" } });
          await tx.document.update({ where: { id: doc.id }, data: { requestId: req.id } });
        }
      }
      return rec;
    });
    await openVerificationTask(rec.id, "staff" in who ? who.staff.id : null);
    if ("portal" in who) await queueStaffAlert({ documentId: rec.documentId });
    return rec;
  } catch (err) {
    await storage.remove(stored.storageKey).catch(() => {});
    throw err;
  }
}

// --- Staff review -------------------------------------------------------------------

/**
 * Staff verify an upload after checking the image. A license needs its
 * expiration date confirmed; a Social Security card may record only the last
 * four digits. The previous verified document of that kind becomes Replaced.
 */
/**
 * Puts an identity document on the right person (e.g. a child's Social Security card that a
 * questionnaire upload filed on the parent). The same record and file move; nothing is copied.
 * A document that was verified stays verified on its new person when that person has no
 * verified one of its kind yet; otherwise it waits for verification. If it was the person's
 * current document, their previous verified copy (if any) becomes current again.
 */
export async function moveIdentityDocument(actor: Actor, id: string, toPersonId: string) {
  const rec = await prisma.identityDocument.findUniqueOrThrow({ where: { id } });
  await requireStaff(actor, rec.clientId);
  if (isAdminOnlyType(rec.type)) assertAdmin(actor);
  if (rec.status === "REJECTED") throw new ValidationError("A declined document can't be moved; upload it on the right person instead.");
  const to = await prisma.identityPerson.findFirst({ where: { id: toPersonId, clientId: rec.clientId, archivedAt: null } });
  if (!to) throw new ValidationError("Choose a person listed for this client.");
  if (to.id === rec.personId) throw new ValidationError("It's already on that person.");
  const wasCurrent = rec.status === "VERIFIED" || rec.status === "EXPIRED";
  const targetVerified = await prisma.identityDocument.count({ where: { personId: to.id, type: rec.type, status: "VERIFIED" } });
  const status = rec.verifiedAt && !targetVerified && rec.status !== "PENDING_VERIFICATION" ? (rec.status === "EXPIRED" ? "EXPIRED" : "VERIFIED") : "PENDING_VERIFICATION";
  const moved = await prisma.$transaction(async (tx) => {
    const m = await tx.identityDocument.update({ where: { id }, data: { personId: to.id, status, replacedAt: null } });
    await tx.document.update({ where: { id: rec.documentId }, data: { businessOwnerId: to.businessOwnerId ?? null } });
    // The person it came from: their last verified copy becomes current again.
    if (wasCurrent) {
      const prev = await tx.identityDocument.findFirst({ where: { personId: rec.personId, type: rec.type, status: "REPLACED", verifiedAt: { not: null } }, orderBy: { verifiedAt: "desc" } });
      if (prev) await tx.identityDocument.update({ where: { id: prev.id }, data: { status: "VERIFIED", replacedAt: null } });
    }
    await audit(tx, { actorId: actor.id, action: "identity.moved", entityType: "IdentityDocument", entityId: id, clientId: rec.clientId, details: { type: rec.type, fromPersonId: rec.personId, toPersonId: to.id, toRole: to.role, status } });
    return m;
  });
  if (status === "PENDING_VERIFICATION" && !rec.verificationTaskId) await openVerificationTask(id, actor.id);
  return moved;
}

/**
 * Removes an identity document filed by mistake or no longer wanted (e.g. an old license once the
 * new one is in). Admin only, with a reason. The file goes to the owner's "Recently deleted" list
 * (recoverable for 30 days, as every deletion); the record leaves the person's list. If it was the
 * person's current document, their previous verified copy becomes current again.
 */
export async function removeIdentityDocument(actor: Actor, id: string, reason: string) {
  assertAdmin(actor);
  const why = reason.trim().slice(0, 300);
  if (!why) throw new ValidationError("Say why this document is being removed.");
  const rec = await prisma.identityDocument.findUniqueOrThrow({ where: { id } });
  await requireStaff(actor, rec.clientId);
  if (rec.status === "REMOVED") throw new ValidationError("This document was already removed.");
  const { deleteDocument } = await import("./documents");
  await deleteDocument(actor, rec.documentId, `Identity document removed: ${why}`);
  const wasCurrent = rec.status === "VERIFIED" || rec.status === "EXPIRED";
  await prisma.$transaction(async (tx) => {
    await tx.identityDocument.update({ where: { id }, data: { status: "REMOVED", replacedAt: new Date() } });
    if (rec.verificationTaskId) await tx.task.updateMany({ where: { id: rec.verificationTaskId, status: "OPEN" }, data: { status: "DONE", completedAt: new Date() } });
    if (wasCurrent) {
      const prev = await tx.identityDocument.findFirst({ where: { personId: rec.personId, type: rec.type, status: "REPLACED", verifiedAt: { not: null } }, orderBy: { verifiedAt: "desc" } });
      if (prev) await tx.identityDocument.update({ where: { id: prev.id }, data: { status: "VERIFIED", replacedAt: null } });
    }
    await audit(tx, { actorId: actor.id, action: "identity.removed", entityType: "IdentityDocument", entityId: id, clientId: rec.clientId, details: { type: rec.type, reason: why, wasCurrent } });
  });
}

export async function verifyIdentityDocument(actor: Actor, id: string, input: { expiresOn?: string | null; last4?: string | null }) {
  const rec = await prisma.identityDocument.findUniqueOrThrow({ where: { id }, include: { person: true } });
  await requireStaff(actor, rec.clientId);
  // Reviewing means looking at the image, so Admin-only documents need an Admin.
  if (isAdminOnlyType(rec.type)) assertAdmin(actor);
  if (rec.status !== "PENDING_VERIFICATION") throw new ValidationError("Only documents pending verification can be verified.");
  const doc = await prisma.document.findUniqueOrThrow({ where: { id: rec.documentId } });
  if (doc.scanStatus !== "CLEAN") throw new ValidationError("This file hasn't passed the malware scan yet, so it can't be reviewed.");
  let expiresOn = rec.expiresOn;
  if (rec.type === "DRIVERS_LICENSE") {
    expiresOn = input.expiresOn || rec.expiresOn;
    if (!expiresOn || !/^\d{4}-\d{2}-\d{2}$/.test(expiresOn)) throw new ValidationError("Confirm the expiration date shown on the license.");
    if (expiresOn < officeToday()) throw new ValidationError("This license is expired. Ask the client for the renewed license instead of verifying it.");
  }
  const last4 = rec.type === "SOCIAL_SECURITY_CARD" && input.last4 ? input.last4.trim() : null;
  if (last4 !== null && !/^\d{4}$/.test(last4)) throw new ValidationError("Enter only the last four digits.");
  const now = new Date();
  await prisma.$transaction(async (tx) => {
    await tx.identityDocument.updateMany({ where: { personId: rec.personId, type: rec.type, status: { in: ["VERIFIED", "EXPIRED"] }, NOT: { id } }, data: { status: "REPLACED", replacedAt: now } });
    await tx.identityDocument.update({ where: { id }, data: { status: "VERIFIED", verifiedAt: now, verifiedById: actor.id, expiresOn, last4, rejectedReason: null } });
    if (rec.verificationTaskId) await tx.task.updateMany({ where: { id: rec.verificationTaskId, status: "OPEN" }, data: { status: "DONE", completedAt: now } });
    await tx.document.update({ where: { id: rec.documentId }, data: { needsReview: false, reviewedAt: now, reviewedById: actor.id } });
    await audit(tx, { actorId: actor.id, action: "identity.verified", entityType: "IdentityDocument", entityId: id, clientId: rec.clientId, details: { type: rec.type } });
  });
}

export async function rejectIdentityDocument(actor: Actor, id: string, reason: string) {
  const rec = await prisma.identityDocument.findUniqueOrThrow({ where: { id } });
  await requireStaff(actor, rec.clientId);
  if (isAdminOnlyType(rec.type)) assertAdmin(actor);
  if (rec.status !== "PENDING_VERIFICATION") throw new ValidationError("Only documents pending verification can be declined.");
  if (!reason.trim()) throw new ValidationError("Tell the client why (e.g. unreadable, cut off, wrong document).");
  const now = new Date();
  await prisma.$transaction(async (tx) => {
    await tx.identityDocument.update({ where: { id }, data: { status: "REJECTED", rejectedReason: reason.trim().slice(0, 300) } });
    if (rec.verificationTaskId) await tx.task.updateMany({ where: { id: rec.verificationTaskId, status: "OPEN" }, data: { status: "DONE", completedAt: now } });
    await tx.document.update({ where: { id: rec.documentId }, data: { needsReview: false, reviewedAt: now, reviewedById: actor.id } });
    await audit(tx, { actorId: actor.id, action: "identity.rejected", entityType: "IdentityDocument", entityId: id, clientId: rec.clientId, details: { type: rec.type } });
  });
  await notifyHolders(rec.clientId, "ID_NEEDS_ATTENTION", `id-rejected:${id}`, rec.personId);
}

/**
 * A staff task to review each upload (closed on verify or decline). Assigned
 * to the client's staff member; the task text has no identity details.
 */
export async function openVerificationTask(recordId: string, uploaderStaffId: string | null) {
  const rec = await prisma.identityDocument.findUniqueOrThrow({ where: { id: recordId }, include: { person: true, client: { select: { displayName: true, assignedToId: true } } } });
  const creator = uploaderStaffId ?? rec.client.assignedToId ?? (await prisma.user.findFirst({ where: { role: "ADMIN", active: true }, orderBy: { createdAt: "asc" }, select: { id: true } }))?.id;
  if (!creator) return;
  const label = ID_TYPES[rec.type as IdType].label;
  const task = await prisma.task.create({
    data: {
      title: `Verify ${rec.replacementReason ? "replacement " : ""}${label.toLowerCase()} — ${rec.client.displayName}`,
      details: `${ID_ROLES[rec.person.role as IdRole]}'s ${label.toLowerCase()} is Pending Verification${rec.replacementReason ? ` (${rec.replacementReason})` : ""}. Review it in the client's Documents tab → Identity Documents.`,
      clientId: rec.clientId,
      assigneeId: rec.client.assignedToId,
      createdById: creator,
      priority: rec.type === "DRIVERS_LICENSE" && rec.replacementReason ? "HIGH" : "NORMAL",
    },
  });
  await prisma.identityDocument.update({ where: { id: recordId }, data: { verificationTaskId: task.id } });
}

/**
 * Generic notices to the logins that may see this person's documents. On a business account that
 * is only the owner the person is (none for the business's own, unassigned record).
 */
async function notifyHolders(clientId: string, kind: string, refKey: string, personId: string) {
  if (await isBusinessClient(clientId)) {
    const person = await prisma.identityPerson.findUnique({ where: { id: personId }, select: { businessOwner: { select: { portalUserId: true, archivedAt: true } } } });
    const login = person?.businessOwner && !person.businessOwner.archivedAt ? person.businessOwner.portalUserId : null;
    if (login && (await prisma.portalAccess.count({ where: { clientId, portalUserId: login, revokedAt: null } }))) await queuePortalNotification(login, kind, refKey);
    return;
  }
  const grants = await prisma.portalAccess.findMany({ where: { clientId, revokedAt: null, canViewIdentity: true } });
  for (const g of grants) await queuePortalNotification(g.portalUserId, kind, refKey);
}

// --- Overview, reminders, checklist -------------------------------------------------

type Rec = Awaited<ReturnType<typeof prisma.identityDocument.findMany>>[number];

export function summarizeSlot(records: Rec[], today = officeToday()) {
  const sorted = [...records].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  const current = sorted.find((r) => r.status === "VERIFIED" || r.status === "EXPIRED") ?? null;
  const pending = sorted.filter((r) => r.status === "PENDING_VERIFICATION");
  const rejected = sorted.find((r) => r.status === "REJECTED" && (!current || r.createdAt > current.createdAt) && !pending.some((p) => p.createdAt > r.createdAt)) ?? null;
  const daysLeft = current?.status === "VERIFIED" && current.expiresOn ? daysBetween(today, current.expiresOn) : null;
  return { current, pending, rejected, history: sorted, daysLeft };
}

/** Everything for one client's Identity Documents section. */
export async function identityOverview(clientId: string) {
  await ensureClientPerson(clientId);
  const [people, records] = await Promise.all([
    prisma.identityPerson.findMany({ where: { clientId, archivedAt: null }, orderBy: [{ createdAt: "asc" }] }),
    prisma.identityDocument.findMany({ where: { clientId, status: { not: "REMOVED" } }, orderBy: { createdAt: "desc" } }),
  ]);
  const order = { CLIENT: 0, SPOUSE: 1, DEPENDENT: 2, OWNER: 3 } as Record<string, number>;
  return people
    .sort((a, b) => order[a.role] - order[b.role])
    .map((p) => ({
      person: p,
      slots: slotTypesFor(records.filter((r) => r.personId === p.id)).map((type) => ({ type, ...summarizeSlot(records.filter((r) => r.personId === p.id && r.type === type)) })),
    }));
}

/**
 * What one portal viewer may see of an account's identity documents (no access check; callers
 * check access). Individuals: the account's people (never a business-owner record). Business
 * accounts: only the viewer's OWN owner record(s) — never the business's own record (unassigned,
 * staff-only) and never another owner's. No viewer (View as Client): nothing on a business account.
 */
export async function identityOverviewForViewer(clientId: string, portalUserId: string | null) {
  if (await isBusinessClient(clientId)) {
    if (!portalUserId) return [];
    const mine = await ownerIdsOf(portalUserId, clientId);
    if (!mine.length) return [];
    const [people, docs] = await Promise.all([
      prisma.identityPerson.findMany({ where: { clientId, archivedAt: null, businessOwnerId: { in: mine } }, orderBy: [{ createdAt: "asc" }] }),
      // Belt and braces: only files tagged to this login's owner record (Document.businessOwnerId).
      prisma.document.findMany({ where: { clientId, category: "IDENTITY", businessOwnerId: { in: mine } }, select: { id: true } }),
    ]);
    if (!people.length) return [];
    const tagged = new Set(docs.map((d) => d.id));
    const records = (await prisma.identityDocument.findMany({ where: { clientId, personId: { in: people.map((p) => p.id) } }, orderBy: { createdAt: "desc" } })).filter((r) => tagged.has(r.documentId));
    return people.map((p) => ({ person: p, slots: slotTypesFor(records.filter((r) => r.personId === p.id)).map((type) => ({ type, ...summarizeSlot(records.filter((r) => r.personId === p.id && r.type === type)) })) }));
  }
  return (await identityOverview(clientId)).filter((e) => !e.person.businessOwnerId);
}

/**
 * A login's identity overview. Individuals: needs identity access. Business accounts: only the
 * login's own owner record (its own documents need no access to the business's files).
 */
export async function portalIdentityOverview(user: PortalActor, clientId: string) {
  if (await isBusinessClient(clientId)) await requireClientAccess(user.id, clientId);
  else await requirePortal(user, clientId);
  return identityOverviewForViewer(clientId, user.id);
}

/**
 * A business-only account's Identity Documents page: only the signed-in owner's own record, and
 * only while our office has an open identity request for that owner. Null when there's none.
 */
export async function ownerIdentityOverview(user: PortalActor, clientId: string) {
  await requireClientAccess(user.id, clientId);
  const req = await prisma.documentRequest.findFirst({ where: { clientId, kind: "OWNER_PERSONAL", status: "OPEN", docType: { in: Object.keys(ID_TYPES) }, businessOwner: { portalUserId: user.id, archivedAt: null } }, select: { businessOwnerId: true, docType: true } });
  if (req?.businessOwnerId) {
    const { ensureOwnerPerson } = await import("./owner-personal-docs");
    await ensureOwnerPerson(clientId, req.businessOwnerId);
  }
  // The login's own owner record(s): an open request, or documents already assigned to them.
  const mine = await identityOverviewForViewer(clientId, user.id);
  return mine.length ? mine : null;
}

// --- Staff: assign a business record's identity document to one owner ------------------

/**
 * Identity documents on a business account that aren't tied to an owner (Document.businessOwnerId
 * null): filed on the business's own record before owner records existed. Staff-only — no portal
 * login sees or opens them — until a staff member assigns each to the owner it belongs to.
 */
export async function unassignedBusinessIdentity(actor: Actor, clientId: string) {
  await requireStaff(actor, clientId);
  if (!(await isBusinessClient(clientId))) return null;
  const [untagged, owners] = await Promise.all([
    prisma.document.findMany({ where: { clientId, category: "IDENTITY", businessOwnerId: null }, select: { id: true } }),
    prisma.businessOwner.findMany({ where: { clientId, archivedAt: null }, include: { contact: { select: { name: true } } }, orderBy: { createdAt: "asc" } }),
  ]);
  const records = await prisma.identityDocument.findMany({ where: { clientId, documentId: { in: untagged.map((d) => d.id) } }, include: { person: { select: { name: true, role: true } } }, orderBy: { createdAt: "asc" } });
  return { records, owners: owners.map((o) => ({ id: o.id, name: o.contact.name })) };
}

/**
 * "Assign to owner": ties one identity document on a business account to the owner it belongs to.
 * The record moves to that owner's identity person and the file gets Document.businessOwnerId, so it
 * opens in the portal only for that owner's login (Admin-only types still never open in the portal).
 * The stored file is never deleted, moved or re-encrypted. Audited. Admin-only types need an Admin
 * (assigning means looking at the image).
 */
export async function assignIdentityToOwner(actor: Actor, identityDocumentId: string, businessOwnerId: string) {
  const rec = await prisma.identityDocument.findUnique({ where: { id: identityDocumentId }, include: { person: true } });
  if (!rec) throw new ValidationError("That identity document wasn't found.");
  const file = await prisma.document.findUniqueOrThrow({ where: { id: rec.documentId }, select: { businessOwnerId: true } });
  await requireStaff(actor, rec.clientId);
  if (isAdminOnlyType(rec.type)) assertAdmin(actor);
  if (!(await isBusinessClient(rec.clientId))) throw new ValidationError("Only identity documents on a business account are assigned to an owner.");
  if (file.businessOwnerId) throw new ValidationError("This document is already assigned to an owner.");
  const owner = await prisma.businessOwner.findFirst({ where: { id: businessOwnerId, clientId: rec.clientId, archivedAt: null }, select: { id: true } });
  if (!owner) throw new ValidationError("Choose one of this business's owners.");
  const { ensureOwnerPerson } = await import("./owner-personal-docs");
  const person = await ensureOwnerPerson(rec.clientId, owner.id);
  await prisma.$transaction(async (tx) => {
    // Guarded: two staff assigning at once can't both win.
    const moved = await tx.document.updateMany({ where: { id: rec.documentId, businessOwnerId: null }, data: { businessOwnerId: owner.id } });
    if (!moved.count) throw new ValidationError("This document is already assigned to an owner.");
    await tx.identityDocument.update({ where: { id: rec.id }, data: { personId: person.id } });
    await audit(tx, {
      actorId: actor.id, action: "identity.assigned_to_owner", entityType: "IdentityDocument", entityId: rec.id, clientId: rec.clientId,
      details: { type: rec.type, businessOwnerId: owner.id, fromPersonId: rec.personId, fromRole: rec.person.role, toPersonId: person.id, documentId: rec.documentId },
    });
  });
}

export async function staffIdentityOverview(actor: Actor, clientId: string) {
  await requireStaff(actor, clientId);
  return identityOverview(clientId);
}

/** Portal reminders (shown in the portal only; never sent with details). */
export function identityAlerts(overview: Awaited<ReturnType<typeof identityOverview>>) {
  const out: { tone: "warn" | "error" | "info"; text: string }[] = [];
  for (const { person, slots } of overview) {
    for (const s of slots) {
      const label = `${person.name}'s ${ID_TYPES[s.type].label.toLowerCase()}`;
      // A pending or declined replacement never hides that the license on file has expired.
      if (s.current?.status === "EXPIRED") out.push({ tone: "error", text: s.pending.length ? `${label} has expired. Your renewed license was received and is awaiting verification.` : `${label} has expired. Please upload the renewed license.` });
      else if (s.daysLeft !== null && s.daysLeft <= 60 && !s.pending.length) out.push({ tone: "warn", text: `${label} expires in ${s.daysLeft === 0 ? "less than a day" : `${s.daysLeft} day${s.daysLeft === 1 ? "" : "s"}`}. Please upload the updated license.` });
      if (s.rejected) out.push({ tone: "error", text: `We couldn't accept the ${ID_TYPES[s.type].label.toLowerCase()} uploaded for ${person.name}: ${s.rejected.rejectedReason}` });
    }
  }
  return out;
}

/**
 * Daily: license reminders at 60, 30 and 7 days, then Expired. Each reminder
 * is sent once; a pending replacement pauses reminders. Messages only say a
 * document on file needs attention.
 */
export async function runIdentityReminders(now = new Date()) {
  const today = officeToday(now);
  const licenses = await prisma.identityDocument.findMany({ where: { type: "DRIVERS_LICENSE", status: "VERIFIED", expiresOn: { not: null } } });
  let reminded = 0;
  let expired = 0;
  for (const l of licenses) {
    const days = daysBetween(today, l.expiresOn!);
    const pending = await prisma.identityDocument.count({ where: { personId: l.personId, type: l.type, status: "PENDING_VERIFICATION" } });
    if (days < 0) {
      await prisma.identityDocument.update({ where: { id: l.id }, data: { status: "EXPIRED", remindersSent: { push: "EXPIRED" } } });
      await audit(prisma, { actorId: null, action: "identity.expired", entityType: "IdentityDocument", entityId: l.id, clientId: l.clientId });
      if (!pending) await notifyHolders(l.clientId, "ID_EXPIRED", `id-expired:${l.id}`, l.personId);
      expired++;
      continue;
    }
    if (pending) continue;
    const due = [...REMINDER_DAYS].reverse().find((t) => days <= t); // smallest threshold reached
    if (!due || l.remindersSent.includes(String(due))) continue;
    // Mark this and any larger thresholds as sent so a late upload gets one reminder, not three.
    const mark = REMINDER_DAYS.filter((t) => t >= due).map(String).filter((t) => !l.remindersSent.includes(t));
    await prisma.identityDocument.update({ where: { id: l.id }, data: { remindersSent: { push: mark } } });
    await notifyHolders(l.clientId, "ID_EXPIRING", `id-expiring-${due}:${l.id}`, l.personId);
    reminded++;
  }
  return { reminded, expired };
}

/** For annual tax checklists: what's on file, by reference (never another copy). */
export async function identityChecklist(clientId: string) {
  return identityChecklistFor(await identityOverview(clientId));
}

/** The checklist for an overview already narrowed to what a viewer may see (see identityOverviewForViewer). */
export function identityChecklistFor(overview: Awaited<ReturnType<typeof identityOverview>>) {
  return overview.map(({ person, slots }) => ({
    person,
    items: slots
      .filter((s) => s.type !== "BIRTH_CERTIFICATE" || person.role === "DEPENDENT" || s.current || s.pending.length)
      .filter((s) => s.type !== "DRIVERS_LICENSE" || person.role !== "DEPENDENT" || s.current || s.pending.length)
      .map((s) => ({
        type: s.type,
        label: ID_TYPES[s.type].label,
        state: s.current?.status === "VERIFIED" ? "ON_FILE" : s.current?.status === "EXPIRED" ? "EXPIRED" : s.pending.length ? "PENDING" : "NEEDED",
        replacementPending: s.pending.length > 0,
        documentId: s.current?.documentId ?? s.pending[0]?.documentId ?? null,
        expiresOn: s.current?.status === "VERIFIED" ? s.current.expiresOn : null,
        verifiedAt: s.current?.verifiedAt ?? null,
      })),
  }));
}

export const CHECKLIST_LABEL = { ON_FILE: "On file — verified", PENDING: "Received — pending verification", EXPIRED: "Expired — upload the renewed license", NEEDED: "Not on file" } as const;

export function checklistText(i: { state: string; replacementPending?: boolean }) {
  if (i.state === "EXPIRED" && i.replacementPending) return "Expired — replacement awaiting verification";
  return CHECKLIST_LABEL[i.state as keyof typeof CHECKLIST_LABEL];
}

// --- Reminder delivery check (Admin) ---------------------------------------------

/**
 * Sends the real reminder notice (generic text) to one portal login so an
 * Admin can see it arrive. Reminders count as fully active only after
 * NOTIFICATIONS_ENABLED is on and an Admin confirms a test was received.
 */
export async function sendIdentityReminderTest(admin: Actor, portalEmail: string) {
  assertAdmin(admin);
  const u = await prisma.portalUser.findUnique({ where: { email: portalEmail.trim().toLowerCase() } });
  if (!u) throw new ValidationError("No portal login uses that email. Use a test client login you can check.");
  if (!u.notifyByEmail && !(u.notifyBySms && u.phoneNormalized)) throw new ValidationError("That login has email and text notices turned off.");
  const ref = `id-test:${Date.now()}`;
  await queuePortalNotification(u.id, "ID_EXPIRING", ref);
  await audit(prisma, { actorId: admin.id, action: "identity.reminder_test_sent", entityType: "PortalUser", entityId: u.id });
  return prisma.notification.findMany({ where: { idempotencyKey: { startsWith: `${ref}:` } } });
}

export async function confirmIdentityReminderReceived(admin: Actor, channel: "EMAIL" | "SMS") {
  assertAdmin(admin);
  await audit(prisma, { actorId: admin.id, action: "identity.reminder_delivery_confirmed", entityType: "Notification", entityId: channel, details: { channel } });
}

export async function identityReminderStatus() {
  const [recent, confirmations] = await Promise.all([
    prisma.notification.findMany({ where: { kind: { in: ["ID_EXPIRING", "ID_EXPIRED", "ID_NEEDS_ATTENTION"] } }, orderBy: { createdAt: "desc" }, take: 8, include: { portalUser: { select: { email: true } } } }),
    prisma.auditLog.findMany({ where: { action: "identity.reminder_delivery_confirmed" }, orderBy: { createdAt: "desc" }, take: 10 }),
  ]);
  const confirmedAt = (ch: string) => confirmations.find((c) => (c.details as { channel?: string } | null)?.channel === ch)?.createdAt ?? null;
  return { enabled: process.env.NOTIFICATIONS_ENABLED === "true", recent, emailConfirmedAt: confirmedAt("EMAIL"), smsConfirmedAt: confirmedAt("SMS") };
}

// --- IRS Identity Protection PIN (optional) -------------------------------------------------

/** The IRS page where a taxpayer signs in (with ID.me) to get this year's IP PIN. */
export const IRS_IP_PIN_URL = "https://www.irs.gov/identity-theft-fraud-scams/get-an-identity-protection-pin";

/** The IP PIN year needed now: the IRS issues a new one each calendar year, used on returns filed that year. */
export const ipPinYear = (today = officeToday()) => Number(today.slice(0, 4));

async function personOf(clientId: string, personId: string) {
  const p = await prisma.identityPerson.findFirst({ where: { id: personId, clientId, archivedAt: null } });
  if (!p) throw new ValidationError("That person isn't listed.");
  return p;
}

/**
 * Optional: only people the IRS gave an Identity Protection PIN need one, and only then is it
 * required to e-file their return. Client (own account) or staff mark whether a person has one.
 */
export async function setHasIpPin(who: { staff: Actor } | { portal: PortalActor }, clientId: string, personId: string, on: boolean) {
  if ("staff" in who) await requireStaff(who.staff, clientId);
  else await requirePortal(who.portal, clientId, true);
  const p = await personOf(clientId, personId);
  await prisma.identityPerson.update({ where: { id: p.id }, data: { hasIpPin: on } });
  await audit(prisma, { actorId: "staff" in who ? who.staff.id : null, action: "identity.ip_pin_flag", entityType: "IdentityPerson", entityId: p.id, clientId, details: { on, byClient: "portal" in who } });
}

/** Saves this year's IP PIN (6 digits), encrypted. The client never sees it again in the portal. */
export async function saveIpPin(who: { staff: Actor } | { portal: PortalActor }, clientId: string, personId: string, pin: string, year = ipPinYear()) {
  if ("staff" in who) await requireStaff(who.staff, clientId);
  else await requirePortal(who.portal, clientId, true);
  const p = await personOf(clientId, personId);
  const v = (pin ?? "").replace(/\s/g, "");
  if (!/^\d{6}$/.test(v)) throw new ValidationError("An IP PIN is 6 digits.");
  const { encryptSecret } = await import("@/lib/crypto");
  const data = { pinEnc: encryptSecret(v), enteredByPortalId: "portal" in who ? who.portal.id : null, enteredByStaffId: "staff" in who ? who.staff.id : null };
  await prisma.$transaction([
    prisma.identityPin.upsert({ where: { personId_year: { personId: p.id, year } }, create: { clientId, personId: p.id, year, ...data }, update: data }),
    prisma.identityPerson.update({ where: { id: p.id }, data: { hasIpPin: true } }),
  ]);
  await audit(prisma, { actorId: "staff" in who ? who.staff.id : null, action: "identity.ip_pin_saved", entityType: "IdentityPerson", entityId: p.id, clientId, details: { year, byClient: "portal" in who } });
}

/** Which people have an IP PIN, and whether this year's is on file (never the PIN itself). */
export async function ipPinStatus(clientId: string, year = ipPinYear()) {
  const pins = await prisma.identityPin.findMany({ where: { clientId, year }, select: { personId: true, updatedAt: true } });
  return { year, onFile: new Map(pins.map((x) => [x.personId, x.updatedAt])) };
}

/** Staff open a PIN to prepare the return (Admins and the assigned staff member); every view is logged. */
export async function revealIpPin(actor: Actor, clientId: string, personId: string, year = ipPinYear()) {
  await requireStaff(actor, clientId);
  const row = await prisma.identityPin.findUnique({ where: { personId_year: { personId, year } } });
  if (!row || row.clientId !== clientId) throw new ValidationError(`No ${year} IP PIN is on file.`);
  const { decryptSecret } = await import("@/lib/crypto");
  await audit(prisma, { actorId: actor.id, action: "identity.ip_pin_viewed", entityType: "IdentityPerson", entityId: personId, clientId, details: { year } });
  return decryptSecret(row.pinEnc);
}

/**
 * Identity is "Completed" when every required document is received (verified or pending review,
 * not expired) and everyone with an IP PIN has this year's on file. Lists what is still needed.
 */
export function identityCompletion(overview: Awaited<ReturnType<typeof identityOverview>>, pins: { year: number; onFile: Map<string, Date> }) {
  const missing: string[] = [];
  for (const { person, items } of identityChecklistFor(overview)) {
    for (const i of items) {
      if (OPTIONAL_ID_TYPES.includes(i.type as IdType)) continue;
      if (i.state === "NEEDED") missing.push(`${person.name}'s ${i.label.toLowerCase()}`);
      if (i.state === "EXPIRED" && !i.replacementPending) missing.push(`${person.name}'s renewed ${i.label.toLowerCase()}`);
    }
    if (person.hasIpPin && !pins.onFile.has(person.id)) missing.push(`${person.name}'s ${pins.year} IP PIN`);
  }
  return { complete: missing.length === 0, missing };
}

/**
 * After a client's questionnaire comes in: if anything is still missing from Identity, a staff task
 * lists it, and (only once client communications are authorized) the client gets the usual
 * generic portal notice. The portal itself always shows what's needed.
 */
export async function requestMissingIdentity(clientId: string) {
  if (await isBusinessClient(clientId)) return null;
  const [overview, pins] = await Promise.all([identityOverview(clientId), ipPinStatus(clientId)]);
  const c = identityCompletion(overview.filter((e) => !e.person.businessOwnerId), pins);
  if (c.complete) return c;
  const client = await prisma.client.findUniqueOrThrow({ where: { id: clientId }, select: { displayName: true, assignedToId: true } });
  const creator = client.assignedToId ?? (await prisma.user.findFirst({ where: { role: "ADMIN", active: true }, orderBy: { createdAt: "asc" }, select: { id: true } }))?.id;
  const title = `Identity documents still needed — ${client.displayName}`;
  if (creator && !(await prisma.task.count({ where: { clientId, title, status: "OPEN" } }))) {
    await prisma.task.create({ data: { title, details: `Still needed in Identity Documents: ${c.missing.join("; ")}. The client sees these as needed in their portal.`, clientId, assigneeId: client.assignedToId, createdById: creator, priority: "NORMAL" } });
  }
  const { clientRolloutAuthorized } = await import("./owner-switches");
  if (await clientRolloutAuthorized()) {
    const grants = await prisma.portalAccess.findMany({ where: { clientId, revokedAt: null, canViewIdentity: true } });
    for (const g of grants) await queuePortalNotification(g.portalUserId, "ID_NEEDS_ATTENTION", `id-missing:${clientId}:${ipPinYear()}:${c.missing.length}`);
  }
  await audit(prisma, { actorId: null, action: "identity.missing_requested", entityType: "Client", entityId: clientId, clientId, details: { items: c.missing.length } });
  return c;
}
