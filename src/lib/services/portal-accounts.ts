import "server-only";
import { assertLoginBusinessViewChange } from "./business-access";
import type { PortalRole } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { audit } from "@/lib/audit";
import { assertAdmin, type Actor } from "@/lib/auth/actor";
import { hashPassword, passwordProblem } from "@/lib/auth/password";
import { hashToken, newToken } from "@/lib/auth/tokens";
import { normalizeEmail, normalizePhone } from "@/lib/normalize";
import { ValidationError } from "./clients";
import { normalizePermissions, OWNER_FLAGS } from "@/lib/portal/owner-areas";
import type { Prisma } from "@prisma/client";
import { syncPayrollApproverRow } from "./payroll-approver-sync";

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const RESET_TTL_MS = 60 * 60 * 1000;

export type PortalPermissions = {
  canMessage: boolean;
  canUpload: boolean;
  canViewBookkeeping: boolean;
  canViewTax: boolean;
  canViewContracts: boolean;
  canViewIdentity: boolean;
  canViewBilling?: boolean;
  canViewDocuments?: boolean;
  canViewPayroll?: boolean;
  canUploadPayroll?: boolean;
  canApprovePayroll?: boolean;
};

/**
 * Invites someone to a client's portal. If they already have a portal login
 * (e.g. an owner with a second business) access is granted to the existing
 * login instead and no new invitation is needed.
 */
export async function invitePortalUser(
  actor: Actor,
  clientId: string,
  input: { email: string; name: string; role: PortalRole; contactId?: string | null; permissions?: Partial<PortalPermissions>; businessOwnerId?: string | null },
): Promise<{ token?: string; grantedExisting?: boolean; portalUserId?: string }> {
  const email = normalizeEmail(input.email);
  if (!email) throw new ValidationError("Enter a valid email address.");
  if (!input.name.trim()) throw new ValidationError("Enter their name.");
  const client = await prisma.client.findUnique({ where: { id: clientId } });
  if (!client || client.archivedAt) throw new ValidationError("This client is archived or missing.");
  if (input.contactId && !(await prisma.contact.count({ where: { id: input.contactId, clientId } }))) throw new ValidationError("Contact not found.");
  const perms = { canMessage: true, canUpload: true, canViewBookkeeping: false, canViewTax: input.role === "OWNER", canViewContracts: true, canViewIdentity: input.role === "OWNER", ...input.permissions };

  // The business view is never part of an invitation; the owner turns it on per login
  // for a Managed Business afterwards (see business-access.ts).
  if (perms.canViewBookkeeping) throw new ValidationError("Business access is turned on separately by Tabitha after the invitation.");
  const existing = await prisma.portalUser.findUnique({ where: { email } });
  if (existing) {
    await prisma.$transaction(async (tx) => {
      await tx.portalAccess.upsert({
        where: { portalUserId_clientId: { portalUserId: existing.id, clientId } },
        update: { revokedAt: null, role: input.role, ...perms, grantedById: actor.id },
        create: { portalUserId: existing.id, clientId, role: input.role, ...perms, grantedById: actor.id },
      });
      if (input.businessOwnerId) await tx.businessOwner.update({ where: { id: input.businessOwnerId }, data: { portalUserId: existing.id } });
      if (perms.canApprovePayroll !== undefined) await syncPayrollApproverRow(tx, { clientId, portalUserId: existing.id, on: perms.canApprovePayroll, actorId: actor.id });
      await audit(tx, { actorId: actor.id, action: "portal.access_granted", entityType: "PortalUser", entityId: existing.id, clientId, details: { role: input.role, ...perms, businessOwnerId: input.businessOwnerId ?? null } });
    });
    return { grantedExisting: true, portalUserId: existing.id };
  }

  const token = newToken();
  await prisma.$transaction(async (tx) => {
    await tx.portalInvite.updateMany({ where: { email, clientId, acceptedAt: null, revokedAt: null }, data: { revokedAt: new Date() } });
    const invite = await tx.portalInvite.create({
      data: {
        email,
        name: input.name.trim(),
        clientId,
        role: input.role,
        contactId: input.contactId ?? null,
        tokenHash: hashToken(token),
        expiresAt: new Date(Date.now() + INVITE_TTL_MS),
        invitedById: actor.id,
        // A business owner's login starts with exactly the permissions chosen for them.
        ...(input.businessOwnerId ? { businessOwnerId: input.businessOwnerId, permissions: perms as Prisma.InputJsonValue } : {}),
      },
    });
    await audit(tx, { actorId: actor.id, action: "portal.invited", entityType: "PortalInvite", entityId: invite.id, clientId, details: { role: input.role, ...perms, businessOwnerId: input.businessOwnerId ?? null } });
  });
  // New logins start with the default permissions (tax documents visible to
  // owners only); staff can adjust them on the client page after acceptance.
  return { token };
}

/**
 * Looks up an invitation WITHOUT using it: opening or previewing the link (or
 * an email security scanner fetching it) never consumes it — only completing
 * the password step does. When a link isn't valid, the server log says why
 * (never the token or address).
 */
export async function findOpenPortalInvite(token: string) {
  const invite = await prisma.portalInvite.findUnique({ where: { tokenHash: hashToken(token) }, include: { client: { select: { displayName: true, archivedAt: true } } } });
  const why = !invite ? "not found in this site's database (sent from another site, e.g. a preview, or mistyped)" : invite.acceptedAt ? "already used" : invite.revokedAt ? "replaced by a newer invitation" : invite.expiresAt < new Date() ? "expired" : invite.client.archivedAt ? "client archived" : null;
  if (why) {
    console.info(`Portal invitation link not valid: ${why}`);
    return null;
  }
  return invite;
}

export async function acceptPortalInvite(token: string, password: string) {
  const invite = await findOpenPortalInvite(token);
  if (!invite) throw new ValidationError("This invitation is invalid or has expired. Ask T. Turner & Associates for a new one.");
  const problem = passwordProblem(password);
  if (problem) throw new ValidationError(problem);
  const passwordHash = await hashPassword(password);
  return prisma.$transaction(async (tx) => {
    const claimed = await tx.portalInvite.updateMany({ where: { id: invite.id, acceptedAt: null }, data: { acceptedAt: new Date() } });
    if (claimed.count !== 1) throw new ValidationError("This invitation has already been used.");
    if (await tx.portalUser.findUnique({ where: { email: invite.email } })) throw new ValidationError("You already have a portal login. Sign in instead.");
    const contactTaken = invite.contactId ? await tx.portalUser.findUnique({ where: { contactId: invite.contactId } }) : null;
    const user = await tx.portalUser.create({
      // Only an emailed link proves the address; a link staff copied off the screen doesn't.
      data: { email: invite.email, name: invite.name, passwordHash, contactId: contactTaken ? null : invite.contactId, emailVerifiedAt: invite.sentByEmail ? new Date() : null, origin: "INVITED" },
    });
    // A business owner's invitation carries its own permissions (their own K-1s always open);
    // anything else starts from the usual defaults.
    const ownerPerms = invite.businessOwnerId ? { ...normalizePermissions(invite.permissions), canViewBookkeeping: false, canViewIdentity: false } : null;
    await tx.portalAccess.create({
      data: { portalUserId: user.id, clientId: invite.clientId, role: invite.role, canViewTax: invite.role === "OWNER", canViewIdentity: invite.role === "OWNER", ...(ownerPerms ?? {}), grantedById: invite.invitedById },
    });
    if (invite.businessOwnerId) await tx.businessOwner.updateMany({ where: { id: invite.businessOwnerId, clientId: invite.clientId, archivedAt: null }, data: { portalUserId: user.id } });
    if (ownerPerms?.canApprovePayroll) await syncPayrollApproverRow(tx, { clientId: invite.clientId, portalUserId: user.id, on: true, actorId: invite.invitedById });
    await audit(tx, { actorId: null, action: "portal.invite_accepted", entityType: "PortalUser", entityId: user.id, clientId: invite.clientId });
    return user;
  });
}

export async function updatePortalAccess(actor: Actor, accessId: string, input: Partial<PortalPermissions> & { revoke?: boolean }) {
  const { revoke, ...perms } = input;
  // Only an Admin can change who sees identity documents.
  if (perms.canViewIdentity !== undefined) {
    const current = await prisma.portalAccess.findUniqueOrThrow({ where: { id: accessId }, select: { canViewIdentity: true } });
    if (current.canViewIdentity !== perms.canViewIdentity) assertAdmin(actor);
  }
  // A business owner's login: its permissions are set only by Tabitha or staff she authorized
  // (Owners card). Revoking stays open to anyone who manages portal access.
  const current = await prisma.portalAccess.findUniqueOrThrow({ where: { id: accessId } });
  const isOwnerLogin = (await prisma.businessOwner.count({ where: { clientId: current.clientId, portalUserId: current.portalUserId, archivedAt: null } })) > 0;
  if (isOwnerLogin && OWNER_FLAGS.some((f) => f in perms && (perms as Record<string, boolean | undefined>)[f] !== current[f])) {
    const { assertOwnerPermissionManager } = await import("./business-owners");
    await assertOwnerPermissionManager(actor);
  }
  await prisma.$transaction(async (tx) => {
    if (perms.canViewBookkeeping !== undefined) await assertLoginBusinessViewChange(tx, actor, accessId, perms.canViewBookkeeping);

    const access = await tx.portalAccess.update({ where: { id: accessId }, data: { ...perms, revokedAt: revoke ? new Date() : revoke === false ? null : undefined } });
    if (perms.canApprovePayroll !== undefined && perms.canApprovePayroll !== current.canApprovePayroll) await syncPayrollApproverRow(tx, { clientId: access.clientId, portalUserId: access.portalUserId, on: perms.canApprovePayroll, actorId: actor.id });
    await audit(tx, { actorId: actor.id, action: revoke ? "portal.access_revoked" : "portal.access_updated", entityType: "PortalAccess", entityId: accessId, clientId: access.clientId, details: input });
  });
}

export async function createPortalReset(email: string) {
  const normalized = normalizeEmail(email);
  if (!normalized) return null;
  const user = await prisma.portalUser.findUnique({ where: { email: normalized } });
  if (!user || !user.active) return null;
  const token = newToken();
  await prisma.$transaction([
    prisma.portalResetToken.updateMany({ where: { portalUserId: user.id, usedAt: null }, data: { usedAt: new Date() } }),
    prisma.portalResetToken.create({ data: { portalUserId: user.id, tokenHash: hashToken(token), expiresAt: new Date(Date.now() + RESET_TTL_MS) } }),
  ]);
  return { token, user };
}

export async function resetPortalPassword(token: string, password: string) {
  const problem = passwordProblem(password);
  if (problem) throw new ValidationError(problem);
  const record = await prisma.portalResetToken.findUnique({ where: { tokenHash: hashToken(token) } });
  if (!record || record.usedAt || record.expiresAt < new Date()) throw new ValidationError("This reset link is invalid or has expired.");
  const passwordHash = await hashPassword(password);
  await prisma.$transaction(async (tx) => {
    const claimed = await tx.portalResetToken.updateMany({ where: { id: record.id, usedAt: null }, data: { usedAt: new Date() } });
    if (claimed.count !== 1) throw new ValidationError("This reset link has already been used.");
    await tx.portalUser.update({ where: { id: record.portalUserId }, data: { passwordHash } });
    await tx.portalSession.deleteMany({ where: { portalUserId: record.portalUserId } });
    // A new password also forgets every "remembered" device.
    await tx.trustedDevice.updateMany({ where: { portalUserId: record.portalUserId, revokedAt: null }, data: { revokedAt: new Date() } });
    await audit(tx, { actorId: null, action: "portal.password_reset", entityType: "PortalUser", entityId: record.portalUserId });
  });
}

export async function updateNotificationPrefs(portalUserId: string, input: { notifyByEmail: boolean; notifyBySms: boolean; phone: string }) {
  const phoneNormalized = normalizePhone(input.phone);
  if (input.phone && !phoneNormalized) throw new ValidationError("Enter a valid mobile number.");
  if (input.notifyBySms && !phoneNormalized) throw new ValidationError("Add a mobile number to get text notifications.");
  await prisma.portalUser.update({ where: { id: portalUserId }, data: { notifyByEmail: input.notifyByEmail, notifyBySms: input.notifyBySms, phone: input.phone || null, phoneNormalized } });
}
