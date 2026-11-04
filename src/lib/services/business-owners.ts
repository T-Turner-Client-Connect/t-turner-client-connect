import "server-only";
import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { audit } from "@/lib/audit";
import { ForbiddenError, type Actor } from "@/lib/auth/actor";
import { can, isPrimaryOwner } from "@/lib/auth/permissions";
import { formatPhone, normalizeEmail, normalizePhone } from "@/lib/normalize";
import { normalizePermissions, OWNER_DEFAULT_PERMISSIONS, OWNER_FLAGS, OWNER_TITLES, pct, type OwnerFlag, type OwnerPermissions } from "@/lib/portal/owner-areas";
import { ValidationError } from "./clients";
import { invitePortalUser } from "./portal-accounts";
import { assertLoginBusinessViewChange } from "./business-access";
import { syncPayrollApproverRow } from "./payroll-approver-sync";

/**
 * Business owners: any number of owners on one BUSINESS client (e.g. four
 * members of an LLC), each with their own portal login.
 *
 * - Name, email and phone live on a Contact (one per owner); ownership %, title,
 *   K-1 and notes live on BusinessOwner. Removing an owner archives them.
 * - Ownership never grants access. Each owner's login starts with their OWN K-1s
 *   and Messages only; Tabitha (or staff she authorized) grants anything else,
 *   area by area, and may share one owner's K-1s with another, pair by pair.
 * - Every change is audited and read fresh by the portal gate, so it applies at once.
 */

const MAX_BPS = 10_000;

// --- Who may set owner permissions -----------------------------------------------

/**
 * Tabitha, staff holding "Business access management -> Manage" (what full Owner's Office access
 * became in Staff Access & Permissions), or a staff member she authorized on the Business access tab.
 */
export async function canManageOwnerPermissions(actor: Actor) {
  if (await can(actor, "business_access", "manage")) return true;
  const u = await prisma.user.findUnique({ where: { id: actor.id }, select: { ownerPermissionsAccess: true, active: true } });
  return !!(u?.active && u.ownerPermissionsAccess);
}

export async function assertOwnerPermissionManager(actor: Actor) {
  if (!(await canManageOwnerPermissions(actor))) throw new ForbiddenError("Only Tabitha, or staff she has authorized, can change a business owner's portal permissions.");
}

/** Tabitha only: lets a staff member set business owners' portal permissions. */
export async function setOwnerPermissionsManager(actor: Actor, userId: string, on: boolean) {
  if (!(await isPrimaryOwner(actor.id))) throw new ForbiddenError("Only Tabitha can authorize staff to set owner permissions.");
  await prisma.$transaction(async (tx) => {
    const u = await tx.user.findUnique({ where: { id: userId }, select: { ownerPermissionsAccess: true } });
    if (!u) throw new ValidationError("Staff member not found.");
    if (u.ownerPermissionsAccess === on) return;
    await tx.user.update({ where: { id: userId }, data: { ownerPermissionsAccess: on, ownerPermissionsGrantedBy: on ? actor.id : null, ownerPermissionsGrantedAt: on ? new Date() : null } });
    await audit(tx, { actorId: actor.id, action: on ? "owner_permissions.manager_granted" : "owner_permissions.manager_revoked", entityType: "User", entityId: userId });
  });
}

// --- Owners ----------------------------------------------------------------------

const opt = z.string().trim().max(500).transform((s) => (s === "" ? null : s)).nullable().optional();
const ownerSchema = z.object({
  name: z.string().trim().min(1, "Enter the owner's name.").max(200),
  email: opt,
  phone: opt,
  ownership: opt,
  title: opt,
  receivesK1: z.boolean().optional(),
  notes: z.string().trim().max(2000).optional(),
});
export type OwnerInput = z.input<typeof ownerSchema>;

/** "25", "25%", "33.33" → basis points (2500, 3333). Empty → null. */
export function parseOwnership(input: string | null | undefined): number | null {
  const t = (input ?? "").replace("%", "").trim();
  if (!t) return null;
  if (!/^\d{1,3}(\.\d{1,2})?$/.test(t)) throw new ValidationError("Enter ownership as a percentage, e.g. 25 or 33.33.");
  const bps = Math.round(Number(t) * 100);
  if (bps <= 0 || bps > MAX_BPS) throw new ValidationError("Ownership must be more than 0% and at most 100%.");
  return bps;
}

/** Totals for the card: over 100% is refused when saving; anything but exactly 100% is a warning. */
export function ownershipCheck(bpsList: (number | null)[]) {
  const total = bpsList.reduce<number>((s, b) => s + (b ?? 0), 0);
  const missing = bpsList.filter((b) => b === null).length;
  const warning = total > MAX_BPS ? `Ownership totals ${pct(total)}, more than 100%.` : total !== MAX_BPS ? `Ownership totals ${pct(total)}${missing ? ` (${missing} owner${missing === 1 ? "" : "s"} with no % yet)` : ""}, not 100%.` : null;
  return { total, warning };
}

async function businessClient(clientId: string) {
  const c = await prisma.client.findUnique({ where: { id: clientId }, select: { id: true, clientType: true, archivedAt: true, displayName: true } });
  if (!c || c.archivedAt) throw new ValidationError("Client not found.");
  if (c.clientType !== "BUSINESS") throw new ValidationError("Owners are listed on business clients.");
  return c;
}

export async function saveBusinessOwner(actor: Actor, clientId: string, ownerId: string | null, input: OwnerInput) {
  await businessClient(clientId);
  const parsed = ownerSchema.safeParse(input);
  if (!parsed.success) throw new ValidationError(parsed.error.issues[0]?.message ?? "Check the form.");
  const v = parsed.data;
  const emailNormalized = normalizeEmail(v.email);
  if (v.email && !emailNormalized) throw new ValidationError("That email address doesn't look right.");
  const phoneNormalized = normalizePhone(v.phone);
  if (v.phone && !phoneNormalized) throw new ValidationError("Enter a 10-digit US phone number, or an international number starting with +.");
  const ownershipBps = parseOwnership(v.ownership);
  const title = v.title ? v.title.toUpperCase() : null;
  if (title && !(title in OWNER_TITLES)) throw new ValidationError("Choose the owner's title.");

  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`owners:${clientId}`}))`;
    const before = ownerId ? await tx.businessOwner.findFirst({ where: { id: ownerId, clientId, archivedAt: null }, include: { contact: true } }) : null;
    if (ownerId && !before) throw new ValidationError("Owner not found.");
    const others = await tx.businessOwner.findMany({ where: { clientId, archivedAt: null, ...(ownerId ? { id: { not: ownerId } } : {}) }, include: { contact: { select: { emailNormalized: true } } } });
    const total = others.reduce((s, o) => s + (o.ownershipBps ?? 0), 0) + (ownershipBps ?? 0);
    if (total > MAX_BPS) throw new ValidationError(`Ownership can't total more than 100%. With this owner it would be ${pct(total)}.`);
    // Each owner has their own login, so two owners can't share an email address.
    if (emailNormalized && others.some((o) => o.contact.emailNormalized === emailNormalized)) throw new ValidationError("Another owner already uses that email address. Each owner needs their own.");

    const contactData = { name: v.name, title: title ? OWNER_TITLES[title as keyof typeof OWNER_TITLES] : null, email: v.email ?? null, emailNormalized, phone: phoneNormalized ? formatPhone(phoneNormalized) : null, phoneNormalized };
    const ownerData = { ownershipBps, title, receivesK1: v.receivesK1 ?? true, notes: v.notes?.trim() || null };
    let owner;
    if (before) {
      await tx.contact.update({ where: { id: before.contactId }, data: contactData });
      owner = await tx.businessOwner.update({ where: { id: before.id }, data: ownerData });
      const fields = [
        ...(["name", "email", "phone"] as const).filter((k) => (before.contact[k] ?? null) !== (contactData[k] ?? null)),
        ...(["ownershipBps", "title", "receivesK1", "notes"] as const).filter((k) => before[k] !== ownerData[k]),
      ];
      if (fields.length) {
        await audit(tx, { actorId: actor.id, action: "business_owner.updated", entityType: "BusinessOwner", entityId: owner.id, clientId, details: { fields, ...(fields.includes("ownershipBps") ? { ownershipFrom: before.ownershipBps, ownershipTo: ownershipBps } : {}) } });
      }
    } else {
      const contact = await tx.contact.create({ data: { ...contactData, clientId } });
      owner = await tx.businessOwner.create({ data: { ...ownerData, clientId, contactId: contact.id, createdById: actor.id } });
      await audit(tx, { actorId: actor.id, action: "business_owner.added", entityType: "BusinessOwner", entityId: owner.id, clientId, details: { name: v.name, ownershipBps, title, receivesK1: ownerData.receivesK1 } });
    }
    return { owner, ...ownershipCheck([...others.map((o) => o.ownershipBps), ownershipBps]) };
  });
}

/**
 * Removes an owner (archive, never delete): their login loses this business at
 * once, open invitations are cancelled, and any K-1 sharing to or from them ends.
 * Their K-1s and history stay on file for staff.
 */
export async function archiveBusinessOwner(actor: Actor, clientId: string, ownerId: string, reason = "") {
  await prisma.$transaction(async (tx) => {
    const o = await tx.businessOwner.findFirst({ where: { id: ownerId, clientId, archivedAt: null }, include: { contact: { select: { name: true } } } });
    if (!o) throw new ValidationError("Owner not found.");
    const now = new Date();
    await tx.businessOwner.update({ where: { id: o.id }, data: { archivedAt: now, archivedById: actor.id } });
    if (o.portalUserId) await tx.portalAccess.updateMany({ where: { clientId, portalUserId: o.portalUserId, revokedAt: null }, data: { revokedAt: now } });
    await tx.portalInvite.updateMany({ where: { clientId, businessOwnerId: o.id, acceptedAt: null, revokedAt: null }, data: { revokedAt: now } });
    await tx.ownerK1Grant.updateMany({ where: { revokedAt: null, OR: [{ viewerOwnerId: o.id }, { holderOwnerId: o.id }] }, data: { revokedAt: now, revokedById: actor.id } });
    await audit(tx, { actorId: actor.id, action: "business_owner.archived", entityType: "BusinessOwner", entityId: o.id, clientId, details: { name: o.contact.name, reason: reason.trim().slice(0, 300) || null, loginRevoked: !!o.portalUserId } });
  });
}

export type InviteStatus = "NOT_INVITED" | "INVITED" | "ACTIVE" | "EXPIRED" | "REVOKED";
export const INVITE_STATUS_LABEL: Record<InviteStatus, string> = { NOT_INVITED: "Not invited", INVITED: "Invited", ACTIVE: "Active", EXPIRED: "Invitation expired", REVOKED: "Access removed" };

/** Owners on the Owners card, with each one's login status and current permissions. */
export async function listBusinessOwners(clientId: string, opts: { includeArchived?: boolean } = {}) {
  const now = new Date();
  const owners = await prisma.businessOwner.findMany({
    where: { clientId, ...(opts.includeArchived ? {} : { archivedAt: null }) },
    include: {
      contact: true,
      portalUser: { select: { id: true, email: true, lastLoginAt: true, passwordHash: true, active: true } },
      k1Viewing: { where: { revokedAt: null }, select: { holderOwnerId: true } },
      _count: { select: { k1Documents: { where: { deletedAt: null } } } },
    },
    orderBy: [{ archivedAt: { sort: "asc", nulls: "first" } }, { createdAt: "asc" }],
  });
  const [invites, accesses] = await Promise.all([
    prisma.portalInvite.findMany({ where: { clientId, businessOwnerId: { in: owners.map((o) => o.id) } }, orderBy: { createdAt: "desc" } }),
    prisma.portalAccess.findMany({ where: { clientId, portalUserId: { in: owners.map((o) => o.portalUserId).filter((x): x is string => !!x) } } }),
  ]);
  const rows = owners.map((o) => {
    const access = o.portalUserId ? accesses.find((a) => a.portalUserId === o.portalUserId) ?? null : null;
    const invite = invites.find((i) => i.businessOwnerId === o.id) ?? null;
    const openInvite = invite && !invite.acceptedAt && !invite.revokedAt && invite.expiresAt > now ? invite : null;
    const status: InviteStatus = access && !access.revokedAt && o.portalUser?.active ? "ACTIVE" : access?.revokedAt ? "REVOKED" : openInvite ? "INVITED" : invite && !invite.acceptedAt && !invite.revokedAt ? "EXPIRED" : "NOT_INVITED";
    // What the login has now (or will start with, for an open invitation).
    const permissions: OwnerPermissions | null = access && !access.revokedAt ? (Object.fromEntries(OWNER_FLAGS.map((f) => [f, access[f]])) as OwnerPermissions) : openInvite ? normalizePermissions(openInvite.permissions) : null;
    return { ...o, status, access, openInvite, permissions };
  });
  const active = rows.filter((o) => !o.archivedAt);
  return { owners: rows, ...ownershipCheck(active.map((o) => o.ownershipBps)) };
}

/**
 * "Invite to portal": that owner's own invitation through the usual invite flow,
 * a separate login with access to this business. It starts with their own K-1s
 * and Messages only. No email is sent from here; staff send the link privately.
 */
export async function inviteBusinessOwner(actor: Actor, clientId: string, ownerId: string) {
  await businessClient(clientId);
  const o = await prisma.businessOwner.findFirst({ where: { id: ownerId, clientId, archivedAt: null }, include: { contact: true } });
  if (!o) throw new ValidationError("Owner not found.");
  if (!o.contact.emailNormalized) throw new ValidationError(`Add ${o.contact.name}'s email address first.`);
  if (o.portalUserId && (await prisma.portalAccess.count({ where: { clientId, portalUserId: o.portalUserId, revokedAt: null } }))) throw new ValidationError(`${o.contact.name} already has portal access to this business.`);
  const res = await invitePortalUser(actor, clientId, {
    email: o.contact.emailNormalized,
    name: o.contact.name,
    role: "OWNER",
    contactId: o.contactId,
    businessOwnerId: o.id,
    permissions: { ...OWNER_DEFAULT_PERMISSIONS, canViewIdentity: false },
  });
  await audit(prisma, { actorId: actor.id, action: "business_owner.invited", entityType: "BusinessOwner", entityId: o.id, clientId, details: { grantedExisting: !!res.grantedExisting } });
  return res;
}

/**
 * Sets one owner's portal permissions (the matrix). Applies to their login right
 * away, or to their open invitation. Banking turns on only for a Managed
 * Business and only by Tabitha (the existing business-view rule).
 */
export async function setOwnerPermissions(actor: Actor, clientId: string, ownerId: string, next: Partial<OwnerPermissions>) {
  await assertOwnerPermissionManager(actor);
  const { owners } = await listBusinessOwners(clientId);
  const o = owners.find((x) => x.id === ownerId);
  if (!o) throw new ValidationError("Owner not found.");
  if (!o.permissions) throw new ValidationError(`Invite ${o.contact.name} to the portal first. Permissions apply to their own login.`);
  const merged = { ...o.permissions, ...normalizePartial(next) };
  const changes = Object.fromEntries(OWNER_FLAGS.filter((f) => merged[f] !== o.permissions![f]).map((f) => [f, { from: o.permissions![f], to: merged[f] }]));
  if (!Object.keys(changes).length) return { changed: 0 };
  await prisma.$transaction(async (tx) => {
    if (o.access && !o.access.revokedAt) {
      if ("canViewBookkeeping" in changes) await assertLoginBusinessViewChange(tx, actor, o.access.id, merged.canViewBookkeeping);
      await tx.portalAccess.update({ where: { id: o.access.id }, data: merged });
      if ("canApprovePayroll" in changes) await syncPayrollApproverRow(tx, { clientId, portalUserId: o.access.portalUserId, on: merged.canApprovePayroll, actorId: actor.id });
    } else if (o.openInvite) {
      if (merged.canViewBookkeeping) throw new ValidationError("Banking & financial dashboard is turned on after the owner accepts the invitation.");
      await tx.portalInvite.update({ where: { id: o.openInvite.id }, data: { permissions: merged as Prisma.InputJsonValue } });
    }
    await audit(tx, { actorId: actor.id, action: "business_owner.permissions_changed", entityType: "BusinessOwner", entityId: o.id, clientId, details: { changes, appliedTo: o.access ? "login" : "invitation" } as Prisma.InputJsonValue });
  });
  return { changed: Object.keys(changes).length };
}

function normalizePartial(p: Partial<OwnerPermissions>) {
  return Object.fromEntries(Object.entries(p).filter(([k, v]) => (OWNER_FLAGS as string[]).includes(k) && typeof v === "boolean")) as Partial<Record<OwnerFlag, boolean>>;
}

/**
 * K-1 sharing: an explicit exception, per viewer and per K-1 holder. Without it
 * an owner never sees another owner's K-1. Ownership % plays no part.
 */
export async function setK1Share(actor: Actor, clientId: string, viewerOwnerId: string, holderOwnerId: string, on: boolean) {
  await assertOwnerPermissionManager(actor);
  if (viewerOwnerId === holderOwnerId) throw new ValidationError("Every owner already sees their own K-1.");
  const pair = await prisma.businessOwner.findMany({ where: { id: { in: [viewerOwnerId, holderOwnerId] }, clientId, archivedAt: null }, include: { contact: { select: { name: true } } } });
  if (pair.length !== 2) throw new ValidationError("Owner not found.");
  await prisma.$transaction(async (tx) => {
    const existing = await tx.ownerK1Grant.findUnique({ where: { viewerOwnerId_holderOwnerId: { viewerOwnerId, holderOwnerId } } });
    if (on) {
      if (existing && !existing.revokedAt) return;
      if (existing) await tx.ownerK1Grant.update({ where: { id: existing.id }, data: { revokedAt: null, revokedById: null, grantedById: actor.id, createdAt: new Date() } });
      else await tx.ownerK1Grant.create({ data: { clientId, viewerOwnerId, holderOwnerId, grantedById: actor.id } });
    } else {
      if (!existing || existing.revokedAt) return;
      await tx.ownerK1Grant.update({ where: { id: existing.id }, data: { revokedAt: new Date(), revokedById: actor.id } });
    }
    await audit(tx, { actorId: actor.id, action: on ? "business_owner.k1_shared" : "business_owner.k1_unshared", entityType: "BusinessOwner", entityId: holderOwnerId, clientId, details: { viewerOwnerId, holderOwnerId } });
  });
}

/** The business owner record for a login on one business (null when the login isn't an owner). */
export async function ownerForLogin(portalUserId: string, clientId: string) {
  return prisma.businessOwner.findFirst({ where: { portalUserId, clientId, archivedAt: null } });
}
