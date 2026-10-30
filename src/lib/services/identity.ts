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
} as const;
export type IdType = keyof typeof ID_TYPES;
export const isIdType = (t: string): t is IdType => t in ID_TYPES;

export const ID_ROLES = { CLIENT: "Client", SPOUSE: "Spouse", DEPENDENT: "Dependent" } as const;
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

/** Portal users may open only non-restricted identity files (driver's licenses), with identity access. */
export async function portalMayOpenIdentityFile(portalUserId: string, clientId: string, type: string | null) {
  if (isAdminOnlyType(type)) return false;
  return portalMayOpenIdentity(portalUserId, clientId);
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

/** Download check used by the document link route (portal side). */
export async function portalMayOpenIdentity(portalUserId: string, clientId: string) {
  const access = await prisma.portalAccess.findFirst({ where: { portalUserId, clientId, revokedAt: null, client: { archivedAt: null } } });
  return !!access?.canViewIdentity;
}

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
  else await requirePortal(who.portal, clientId, true);
  if (input.role !== "SPOUSE" && input.role !== "DEPENDENT") throw new ValidationError("Choose spouse or dependent.");
  const name = input.name.trim().slice(0, 120);
  if (!name) throw new ValidationError("Enter their name.");
  if (input.role === "SPOUSE" && (await prisma.identityPerson.count({ where: { clientId, role: "SPOUSE", archivedAt: null } }))) throw new ValidationError("A spouse is already listed.");
  const p = await prisma.identityPerson.create({ data: { clientId, role: input.role, name } });
  await audit(prisma, { actorId: "staff" in who ? who.staff.id : null, action: "identity.person_added", entityType: "IdentityPerson", entityId: p.id, clientId, details: { role: input.role } });
  return p;
}

// --- Uploads ------------------------------------------------------------------------

export type IdUploadInput = { clientId: string; personId: string; type: string; expiresOn?: string | null; replacementReason?: string | null; bytes: Uint8Array; originalName: string };

export async function uploadIdentityDocument(who: { staff: Actor } | { portal: PortalActor }, input: IdUploadInput) {
  if ("staff" in who) await requireStaff(who.staff, input.clientId);
  else await requirePortal(who.portal, input.clientId, true);
  if (!isIdType(input.type)) throw new ValidationError("Choose the kind of document.");
  const person = await prisma.identityPerson.findFirst({ where: { id: input.personId, clientId: input.clientId, archivedAt: null } });
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
  await notifyHolders(rec.clientId, "ID_NEEDS_ATTENTION", `id-rejected:${id}`);
}

/**
 * A staff task to review each upload (closed on verify or decline). Assigned
 * to the client's staff member; the task text has no identity details.
 */
async function openVerificationTask(recordId: string, uploaderStaffId: string | null) {
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

async function notifyHolders(clientId: string, kind: string, refKey: string) {
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
    prisma.identityDocument.findMany({ where: { clientId }, orderBy: { createdAt: "desc" } }),
  ]);
  const order = { CLIENT: 0, SPOUSE: 1, DEPENDENT: 2 } as Record<string, number>;
  return people
    .sort((a, b) => order[a.role] - order[b.role])
    .map((p) => ({
      person: p,
      slots: (Object.keys(ID_TYPES) as IdType[]).map((type) => ({ type, ...summarizeSlot(records.filter((r) => r.personId === p.id && r.type === type)) })),
    }));
}

export async function portalIdentityOverview(user: PortalActor, clientId: string) {
  await requirePortal(user, clientId);
  return identityOverview(clientId);
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
      if (!pending) await notifyHolders(l.clientId, "ID_EXPIRED", `id-expired:${l.id}`);
      expired++;
      continue;
    }
    if (pending) continue;
    const due = [...REMINDER_DAYS].reverse().find((t) => days <= t); // smallest threshold reached
    if (!due || l.remindersSent.includes(String(due))) continue;
    // Mark this and any larger thresholds as sent so a late upload gets one reminder, not three.
    const mark = REMINDER_DAYS.filter((t) => t >= due).map(String).filter((t) => !l.remindersSent.includes(t));
    await prisma.identityDocument.update({ where: { id: l.id }, data: { remindersSent: { push: mark } } });
    await notifyHolders(l.clientId, "ID_EXPIRING", `id-expiring-${due}:${l.id}`);
    reminded++;
  }
  return { reminded, expired };
}

/** For annual tax checklists: what's on file, by reference (never another copy). */
export async function identityChecklist(clientId: string) {
  const overview = await identityOverview(clientId);
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
