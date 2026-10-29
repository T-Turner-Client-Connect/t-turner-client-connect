import "server-only";
import type { PortalRole } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { audit } from "@/lib/audit";
import type { Actor } from "@/lib/auth/actor";
import { hashPassword, passwordProblem } from "@/lib/auth/password";
import { hashToken, newToken } from "@/lib/auth/tokens";
import { normalizeEmail, normalizePhone } from "@/lib/normalize";
import { ValidationError } from "./clients";

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const RESET_TTL_MS = 60 * 60 * 1000;

export type PortalPermissions = { canMessage: boolean; canUpload: boolean; canViewBookkeeping: boolean; canViewTax: boolean; canViewContracts: boolean };

/**
 * Invites someone to a client's portal. If they already have a portal login
 * (e.g. an owner with a second business) access is granted to the existing
 * login instead and no new invitation is needed.
 */
export async function invitePortalUser(
  actor: Actor,
  clientId: string,
  input: { email: string; name: string; role: PortalRole; contactId?: string | null; permissions?: Partial<PortalPermissions> },
): Promise<{ token?: string; grantedExisting?: boolean }> {
  const email = normalizeEmail(input.email);
  if (!email) throw new ValidationError("Enter a valid email address.");
  if (!input.name.trim()) throw new ValidationError("Enter their name.");
  const client = await prisma.client.findUnique({ where: { id: clientId } });
  if (!client || client.archivedAt) throw new ValidationError("This client is archived or missing.");
  if (input.contactId && !(await prisma.contact.count({ where: { id: input.contactId, clientId } }))) throw new ValidationError("Contact not found.");
  const perms = { canMessage: true, canUpload: true, canViewBookkeeping: true, canViewTax: input.role === "OWNER", canViewContracts: true, ...input.permissions };

  const existing = await prisma.portalUser.findUnique({ where: { email } });
  if (existing) {
    await prisma.$transaction(async (tx) => {
      await tx.portalAccess.upsert({
        where: { portalUserId_clientId: { portalUserId: existing.id, clientId } },
        update: { revokedAt: null, role: input.role, ...perms, grantedById: actor.id },
        create: { portalUserId: existing.id, clientId, role: input.role, ...perms, grantedById: actor.id },
      });
      await audit(tx, { actorId: actor.id, action: "portal.access_granted", entityType: "PortalUser", entityId: existing.id, clientId, details: { role: input.role, ...perms } });
    });
    return { grantedExisting: true };
  }

  const token = newToken();
  await prisma.$transaction(async (tx) => {
    await tx.portalInvite.updateMany({ where: { email, clientId, acceptedAt: null, revokedAt: null }, data: { revokedAt: new Date() } });
    const invite = await tx.portalInvite.create({
      data: { email, name: input.name.trim(), clientId, role: input.role, contactId: input.contactId ?? null, tokenHash: hashToken(token), expiresAt: new Date(Date.now() + INVITE_TTL_MS), invitedById: actor.id },
    });
    await audit(tx, { actorId: actor.id, action: "portal.invited", entityType: "PortalInvite", entityId: invite.id, clientId, details: { role: input.role, ...perms } });
  });
  // New logins start with the default permissions (tax documents visible to
  // owners only); staff can adjust them on the client page after acceptance.
  return { token };
}

export async function findOpenPortalInvite(token: string) {
  const invite = await prisma.portalInvite.findUnique({ where: { tokenHash: hashToken(token) }, include: { client: { select: { displayName: true, archivedAt: true } } } });
  if (!invite || invite.acceptedAt || invite.revokedAt || invite.expiresAt < new Date() || invite.client.archivedAt) return null;
  return invite;
}

export async function acceptPortalInvite(token: string, password: string) {
  const invite = await findOpenPortalInvite(token);
  if (!invite) throw new ValidationError("This invitation is invalid or has expired. Ask TTurner & Associates Group for a new one.");
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
    await tx.portalAccess.create({
      data: { portalUserId: user.id, clientId: invite.clientId, role: invite.role, canViewTax: invite.role === "OWNER", grantedById: invite.invitedById },
    });
    await audit(tx, { actorId: null, action: "portal.invite_accepted", entityType: "PortalUser", entityId: user.id, clientId: invite.clientId });
    return user;
  });
}

export async function updatePortalAccess(actor: Actor, accessId: string, input: Partial<PortalPermissions> & { revoke?: boolean }) {
  const { revoke, ...perms } = input;
  await prisma.$transaction(async (tx) => {
    const access = await tx.portalAccess.update({ where: { id: accessId }, data: { ...perms, revokedAt: revoke ? new Date() : revoke === false ? null : undefined } });
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
