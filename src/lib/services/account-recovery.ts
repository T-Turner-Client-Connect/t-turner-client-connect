import "server-only";
import { prisma } from "@/lib/prisma";
import { assertAdmin, type Actor } from "@/lib/auth/actor";
import { sendEmail, brandedEmailHtml } from "@/lib/email";
import { appUrl } from "@/lib/integrations";
import { BUSINESS } from "@/lib/business";
import { normalizeEmail } from "@/lib/normalize";
import { ValidationError } from "./clients";
import { createPortalReset } from "./portal-accounts";
import { resetMfa, sendEmailCode } from "./mfa";

/**
 * Account Access & Recovery for a client's portal logins (Admins only).
 *
 * Every action works on the client's portal login only — a person who is
 * also staff keeps a completely separate staff account that nothing here
 * touches. No password or code is ever shown; links go to the address on
 * file, or (after the Admin verifies the person directly) a single-use,
 * expiring link is shown once for private delivery. Every action is logged
 * with the Admin, client, action and time; sensitive ones also record how
 * identity was verified. Limits are cleared only for the one address.
 */

export const LOCK_WINDOW_MS = 15 * 60 * 1000;
export const LOCK_AFTER = 5;

export const maskPhone = (p: string | null | undefined) => {
  const d = (p ?? "").replace(/\D/g, "");
  return d.length >= 4 ? `(•••) •••-${d.slice(-4)}` : null;
};

type Status = "ACTIVE" | "LOCKED" | "AWAITING_VERIFICATION" | "DISABLED";
export const STATUS_LABELS: Record<Status | "NOT_ACTIVATED", { label: string; tone: "green" | "red" | "amber" | "gray" }> = {
  ACTIVE: { label: "Active", tone: "green" },
  LOCKED: { label: "Temporarily locked (too many sign-in attempts)", tone: "red" },
  AWAITING_VERIFICATION: { label: "Awaiting email verification", tone: "amber" },
  DISABLED: { label: "Disabled", tone: "gray" },
  NOT_ACTIVATED: { label: "Not activated", tone: "amber" },
};

/** A portal login that has access to this client — the only logins these actions can touch. */
async function loginForClient(clientId: string, portalUserId: string) {
  const access = await prisma.portalAccess.findFirst({ where: { clientId, portalUserId, revokedAt: null }, include: { portalUser: true } });
  if (!access) throw new ValidationError("That login doesn't have access to this client.");
  return access.portalUser;
}

function requireVerification(input: { verified?: boolean; note?: string }) {
  if (!input.verified || (input.note ?? "").trim().length < 5) throw new ValidationError("Confirm you verified this person's identity directly, and note how (for example: in person with photo ID, or a call to the number on file).");
}

async function log(actor: Actor, clientId: string, action: string, details: Record<string, unknown>) {
  await prisma.auditLog.create({ data: { actorId: actor.id, action: `portal.recovery.${action}`, entityType: "Client", entityId: clientId, clientId, details: details as never } });
}

/** What the Admin panel shows. Never includes passwords, codes, secrets or tokens. */
export async function accountAccessView(actor: Actor, clientId: string) {
  assertAdmin(actor);
  const since = new Date(Date.now() - LOCK_WINDOW_MS);
  const [access, invites, staff, recent] = await Promise.all([
    prisma.portalAccess.findMany({ where: { clientId, revokedAt: null }, include: { portalUser: { include: { _count: { select: { sessions: true } } } } }, orderBy: { createdAt: "asc" } }),
    prisma.portalInvite.findMany({ where: { clientId, acceptedAt: null, revokedAt: null }, orderBy: { createdAt: "desc" } }),
    prisma.user.findMany({ select: { email: true } }),
    prisma.auditLog.findMany({ where: { clientId, OR: [{ action: { startsWith: "portal.recovery." } }, { action: { startsWith: "portal.activation" } }, { action: "portal.private_activation_link_created" }] }, include: { actor: { select: { name: true } } }, orderBy: { createdAt: "desc" }, take: 15 }),
  ]);
  const staffSet = new Set(staff.map((s) => s.email));
  const logins = await Promise.all(
    access.map(async (a) => {
      const u = a.portalUser;
      const [failures, devices] = await Promise.all([
        prisma.loginAttempt.count({ where: { email: `portal:${u.email}`, success: false, createdAt: { gte: since } } }),
        prisma.trustedDevice.count({ where: { portalUserId: u.id, revokedAt: null, expiresAt: { gt: new Date() } } }),
      ]);
      const status: Status = !u.active ? "DISABLED" : failures >= LOCK_AFTER ? "LOCKED" : !u.emailVerifiedAt && !u.identityVerifiedAt ? "AWAITING_VERIFICATION" : "ACTIVE";
      return {
        id: u.id, name: u.name, email: u.email, role: a.role, emailVerified: !!u.emailVerifiedAt, identityVerified: !!u.identityVerifiedAt,
        phone: maskPhone(u.phone), mfaEnrolled: !!u.mfaEnabledAt, lastLoginAt: u.lastLoginAt, sessions: u._count.sessions, devices, failures, status,
        alsoStaff: staffSet.has(u.email),
      };
    }),
  );
  const pending = invites.filter((i) => i.expiresAt > new Date() && !logins.some((l) => l.email === i.email));
  const expired = invites.filter((i) => i.expiresAt <= new Date() && !logins.some((l) => l.email === i.email));
  return { logins, pending, expired, recent };
}

/** Emails a password-reset link (valid 1 hour, single use) to the login's own address. Reports what Resend said. */
export async function sendPasswordResetEmail(actor: Actor, clientId: string, portalUserId: string) {
  assertAdmin(actor);
  const u = await loginForClient(clientId, portalUserId);
  const reset = await createPortalReset(u.email);
  if (!reset) throw new ValidationError("This login isn't active.");
  const link = `${appUrl()}/client/reset-password/${reset.token}`;
  const lines = ["We received a request to reset your client portal password.", "This link works once and expires in one hour. If you didn't expect it, call our office."];
  const res = await sendEmail({
    to: u.email,
    subject: `Reset your ${BUSINESS.platformName} password`,
    text: `${lines.join("\n\n")}\n\n${link}\n\n${BUSINESS.displayName}`,
    html: brandedEmailHtml({ heading: "Reset your password", paragraphs: lines, button: { label: "Choose a new password", url: link }, footer: BUSINESS.displayName }),
    tags: { category: "account_security" },
  });
  await log(actor, clientId, "password_reset_emailed", { portalUserId, to: u.email, ok: res.ok, providerId: res.ok ? res.providerId : null, error: res.ok ? null : res.detail });
  if (!res.ok) throw new ValidationError(`The reset email wasn't sent: ${res.detail} You can create a private recovery link instead after verifying their identity.`);
  return `Password-reset link emailed to ${u.email} (Resend accepted it${res.providerId ? `, ID ${res.providerId}` : ""}). It expires in one hour.`;
}

/** Sends the login a new email-verification code, under the normal code limits. The Admin never sees the code. */
export async function resendVerificationCode(actor: Actor, clientId: string, portalUserId: string) {
  assertAdmin(actor);
  const u = await loginForClient(clientId, portalUserId);
  if (u.emailVerifiedAt) throw new ValidationError("This email is already verified.");
  try {
    const r = await sendEmailCode({ kind: "portal", id: u.id }, "VERIFY_EMAIL");
    await log(actor, clientId, "verification_code_sent", { portalUserId, to: r.destination, ok: true });
    return `A new verification code was emailed to ${r.destination}. Only the client sees it.`;
  } catch (err) {
    await log(actor, clientId, "verification_code_sent", { portalUserId, ok: false, error: err instanceof Error ? err.message : "failed" });
    throw err;
  }
}

/** Clears failed sign-in and activation attempts for one address only, after identity verification. */
export async function resetAttemptLimit(actor: Actor, clientId: string, email: string, input: { verified?: boolean; note?: string }) {
  assertAdmin(actor);
  requireVerification(input);
  const e = normalizeEmail(email);
  if (!e) throw new ValidationError("Choose an address.");
  const client = await prisma.client.findUnique({ where: { id: clientId }, include: { contacts: { select: { emailNormalized: true } } } });
  const logins = await prisma.portalAccess.findMany({ where: { clientId, revokedAt: null }, select: { portalUser: { select: { email: true } } } });
  const allowed = new Set([client?.emailNormalized, ...(client?.contacts ?? []).map((c) => c.emailNormalized), ...logins.map((l) => l.portalUser.email)].filter(Boolean));
  if (!allowed.has(e)) throw new ValidationError("That address isn't on this client's record or one of its portal logins.");
  const { count } = await prisma.loginAttempt.deleteMany({ where: { email: { in: [`portal:${e}`, `activate-email:${e}`] }, success: false } });
  await log(actor, clientId, "attempt_limit_reset", { email: e, cleared: count, note: input.note!.trim().slice(0, 200) });
  return count ? `Cleared ${count} recent failed attempt${count === 1 ? "" : "s"} for ${e} only. Other limits are unchanged.` : `No recent failed attempts for ${e}.`;
}

/** Resets the login's two-step verification and signs it out everywhere. Identity must be verified first. */
export async function resetClientTwoStep(actor: Actor, clientId: string, portalUserId: string, input: { verified?: boolean; note?: string }) {
  assertAdmin(actor);
  requireVerification(input);
  const u = await loginForClient(clientId, portalUserId);
  await resetMfa(actor, { kind: "portal", id: u.id });
  await revokeAll(u.id);
  await log(actor, clientId, "two_step_reset", { portalUserId, note: input.note!.trim().slice(0, 200) });
  return `Two-step verification reset for ${u.email}. They're signed out and will set it up again at their next sign-in.`;
}

async function revokeAll(portalUserId: string) {
  const [s, d] = await prisma.$transaction([
    prisma.portalSession.deleteMany({ where: { portalUserId } }),
    prisma.trustedDevice.updateMany({ where: { portalUserId, revokedAt: null }, data: { revokedAt: new Date() } }),
  ]);
  return { sessions: s.count, devices: d.count };
}

/** Signs the login out everywhere and forgets remembered devices. */
export async function revokeSessions(actor: Actor, clientId: string, portalUserId: string) {
  assertAdmin(actor);
  const u = await loginForClient(clientId, portalUserId);
  const r = await revokeAll(u.id);
  await log(actor, clientId, "sessions_revoked", { portalUserId, ...r });
  return `Signed out ${r.sessions} session${r.sessions === 1 ? "" : "s"} and forgot ${r.devices} remembered device${r.devices === 1 ? "" : "s"} for ${u.email}.`;
}

/**
 * When email can't reach an activated client: after verifying their identity
 * directly, a single-use password-reset link (expires in one hour) shown once
 * to the Admin for private delivery. The client chooses their own password.
 */
export async function privateRecoveryLink(actor: Actor, clientId: string, portalUserId: string, input: { verified?: boolean; note?: string }) {
  assertAdmin(actor);
  requireVerification(input);
  const u = await loginForClient(clientId, portalUserId);
  const reset = await createPortalReset(u.email);
  if (!reset) throw new ValidationError("This login isn't active.");
  await log(actor, clientId, "private_recovery_link_created", { portalUserId, note: input.note!.trim().slice(0, 200) });
  return { link: `${appUrl()}/client/reset-password/${reset.token}`, message: `Single-use recovery link for ${u.email}, valid one hour. Give it in person or read it by phone. They choose their own password — never ask for it or for any code.` };
}
