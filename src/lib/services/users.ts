import "server-only";
import type { Role } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { audit } from "@/lib/audit";
import { assertAdmin, type Actor } from "@/lib/auth/actor";
import { hashPassword, passwordProblem } from "@/lib/auth/password";
import { hashToken, newToken } from "@/lib/auth/tokens";
import { normalizeEmail } from "@/lib/normalize";
import { ValidationError } from "./clients";

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const RESET_TTL_MS = 60 * 60 * 1000;

/** First-run only: creates the first Admin when no staff accounts exist. */
export async function bootstrapFirstAdmin(input: { setupToken: string; name: string; email: string; password: string }) {
  const expected = process.env.SETUP_TOKEN;
  if (!expected || expected.length < 16) throw new ValidationError("Set a SETUP_TOKEN environment variable (16+ characters) first.");
  if (input.setupToken !== expected) throw new ValidationError("That setup code isn't right.");
  if ((await prisma.user.count()) > 0) throw new ValidationError("Setup has already been completed.");
  const email = normalizeEmail(input.email);
  if (!email) throw new ValidationError("Enter a valid email address.");
  if (!input.name.trim()) throw new ValidationError("Enter your name.");
  const problem = passwordProblem(input.password);
  if (problem) throw new ValidationError(problem);
  return prisma.$transaction(async (tx) => {
    // Re-check inside the transaction so two simultaneous setups can't both win.
    if ((await tx.user.count()) > 0) throw new ValidationError("Setup has already been completed.");
    const user = await tx.user.create({ data: { email, name: input.name.trim(), role: "ADMIN", passwordHash: await hashPassword(input.password) } });
    await audit(tx, { actorId: user.id, action: "user.bootstrap_admin", entityType: "User", entityId: user.id });
    return user;
  });
}

export async function createInvite(actor: Actor, input: { email: string; name: string; role: Role }) {
  assertAdmin(actor);
  const email = normalizeEmail(input.email);
  if (!email) throw new ValidationError("Enter a valid email address.");
  if (!input.name.trim()) throw new ValidationError("Enter their name.");
  if (await prisma.user.findUnique({ where: { email } })) throw new ValidationError("That person already has an account.");
  const token = newToken();
  await prisma.$transaction(async (tx) => {
    await tx.invite.updateMany({ where: { email, acceptedAt: null, revokedAt: null }, data: { revokedAt: new Date() } });
    const invite = await tx.invite.create({
      data: { email, name: input.name.trim(), role: input.role, tokenHash: hashToken(token), expiresAt: new Date(Date.now() + INVITE_TTL_MS), invitedById: actor.id },
    });
    await audit(tx, { actorId: actor.id, action: "user.invited", entityType: "Invite", entityId: invite.id, details: { email, role: input.role } });
  });
  return token;
}

export async function findOpenInvite(token: string) {
  const invite = await prisma.invite.findUnique({ where: { tokenHash: hashToken(token) } });
  if (!invite || invite.acceptedAt || invite.revokedAt || invite.expiresAt < new Date()) return null;
  return invite;
}

export async function acceptInvite(token: string, password: string) {
  const invite = await findOpenInvite(token);
  if (!invite) throw new ValidationError("This invitation link is invalid or has expired. Ask an Admin for a new one.");
  const problem = passwordProblem(password);
  if (problem) throw new ValidationError(problem);
  const passwordHash = await hashPassword(password);
  return prisma.$transaction(async (tx) => {
    const claimed = await tx.invite.updateMany({ where: { id: invite.id, acceptedAt: null }, data: { acceptedAt: new Date() } });
    if (claimed.count !== 1) throw new ValidationError("This invitation has already been used.");
    if (await tx.user.findUnique({ where: { email: invite.email } })) throw new ValidationError("That person already has an account.");
    const user = await tx.user.create({ data: { email: invite.email, name: invite.name, role: invite.role, passwordHash } });
    await audit(tx, { actorId: user.id, action: "user.invite_accepted", entityType: "User", entityId: user.id });
    return user;
  });
}

export async function revokeInvite(actor: Actor, inviteId: string) {
  assertAdmin(actor);
  await prisma.$transaction([
    prisma.invite.update({ where: { id: inviteId }, data: { revokedAt: new Date() } }),
    prisma.auditLog.create({ data: { actorId: actor.id, action: "user.invite_revoked", entityType: "Invite", entityId: inviteId } }),
  ]);
}

/** Returns a reset token, or null if the email has no active account. */
export async function createPasswordReset(email: string, requestedBy: Actor | null): Promise<{ token: string; user: { email: string; name: string } } | null> {
  const normalized = normalizeEmail(email);
  if (!normalized) return null;
  const user = await prisma.user.findUnique({ where: { email: normalized } });
  if (!user || !user.active) return null;
  if (requestedBy && requestedBy.id !== user.id) assertAdmin(requestedBy);
  const token = newToken();
  await prisma.$transaction([
    prisma.passwordResetToken.updateMany({ where: { userId: user.id, usedAt: null }, data: { usedAt: new Date() } }),
    prisma.passwordResetToken.create({ data: { userId: user.id, tokenHash: hashToken(token), expiresAt: new Date(Date.now() + RESET_TTL_MS) } }),
    prisma.auditLog.create({ data: { actorId: requestedBy?.id ?? null, action: "user.password_reset_requested", entityType: "User", entityId: user.id } }),
  ]);
  return { token, user: { email: user.email, name: user.name } };
}

export async function resetPassword(token: string, password: string) {
  const problem = passwordProblem(password);
  if (problem) throw new ValidationError(problem);
  const record = await prisma.passwordResetToken.findUnique({ where: { tokenHash: hashToken(token) } });
  if (!record || record.usedAt || record.expiresAt < new Date()) throw new ValidationError("This reset link is invalid or has expired.");
  const passwordHash = await hashPassword(password);
  await prisma.$transaction(async (tx) => {
    const claimed = await tx.passwordResetToken.updateMany({ where: { id: record.id, usedAt: null }, data: { usedAt: new Date() } });
    if (claimed.count !== 1) throw new ValidationError("This reset link has already been used.");
    await tx.user.update({ where: { id: record.userId }, data: { passwordHash } });
    // Sign out everywhere after a password change.
    await tx.session.deleteMany({ where: { userId: record.userId } });
    await audit(tx, { actorId: record.userId, action: "user.password_reset", entityType: "User", entityId: record.userId });
  });
}

export async function updateStaff(actor: Actor, userId: string, input: { role?: Role; active?: boolean }) {
  assertAdmin(actor);
  const target = await prisma.user.findUnique({ where: { id: userId } });
  if (!target) throw new ValidationError("Staff member not found.");
  const losingAdmin = target.role === "ADMIN" && (input.role === "STAFF" || input.active === false);
  if (losingAdmin) {
    const admins = await prisma.user.count({ where: { role: "ADMIN", active: true } });
    if (admins <= 1) throw new ValidationError("Keep at least one active Admin.");
  }
  await prisma.$transaction(async (tx) => {
    await tx.user.update({ where: { id: userId }, data: input });
    if (input.active === false) await tx.session.deleteMany({ where: { userId } });
    await audit(tx, { actorId: actor.id, action: "user.updated", entityType: "User", entityId: userId, details: input });
  });
}
