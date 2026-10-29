import "server-only";
import { createHash, randomInt, timingSafeEqual } from "node:crypto";
import QRCode from "qrcode";
import { prisma } from "@/lib/prisma";
import { decryptSecret, encryptSecret } from "@/lib/crypto";
import { newRecoveryCodes, newTotpSecret, otpauthUri, totpAt } from "@/lib/auth/totp";
import { assertAdmin, ForbiddenError, type Actor } from "@/lib/auth/actor";
import { verifyPassword } from "@/lib/auth/password";
import { brandedEmailHtml, sendEmail } from "@/lib/email";
import { BUSINESS } from "@/lib/business";
import { ValidationError } from "./clients";
import { authSettings, emailCodesFor, emailProviderConfigured } from "@/lib/auth/client-auth";

/**
 * Two-step verification for staff and clients.
 * - Authenticator app (TOTP): the default; codes are never "sent" or resent,
 *   and each code is accepted once (replay-protected by time step).
 * - Recovery codes: one-time, stored as hashes (they keep working even if the
 *   encryption key changed).
 * - Email codes (clients only): password + a code emailed to the account's
 *   address, once email delivery has been proven and an Admin switched it on.
 *   Single use, 10-minute expiry, 5 attempts, 60-second resend cooldown and an
 *   hourly limit. "Sent" is shown only when the provider accepted the email.
 * - Staff always use an authenticator app plus recovery codes.
 */
export type MfaSubject = { kind: "staff" | "portal"; id: string };

const hashCode = (code: string) => createHash("sha256").update(code.replace(/[\s-]/g, "").toUpperCase()).digest("hex");
const owner = (s: MfaSubject) => (s.kind === "staff" ? { userId: s.id } : { portalUserId: s.id });

export const EMAIL_CODE_TTL_MS = 10 * 60 * 1000;
export const RESEND_COOLDOWN_MS = 60 * 1000;
export const MAX_SENDS_PER_HOUR = 5;
export const MAX_CODE_ATTEMPTS = 5;

async function load(subject: MfaSubject) {
  const select = { email: true, name: true, mfaSecretEnc: true, mfaEnabledAt: true, mfaLastStep: true, emailVerifiedAt: true, passwordHash: true } as const;
  return subject.kind === "staff" ? prisma.user.findUnique({ where: { id: subject.id }, select }) : prisma.portalUser.findUnique({ where: { id: subject.id }, select });
}

async function save(subject: MfaSubject, data: { mfaSecretEnc?: string | null; mfaEnabledAt?: Date | null; mfaLastStep?: number | null; emailVerifiedAt?: Date | null }) {
  if (subject.kind === "staff") await prisma.user.update({ where: { id: subject.id }, data });
  else await prisma.portalUser.update({ where: { id: subject.id }, data });
}

function tryDecrypt(enc: string | null): string | null {
  if (!enc) return null;
  try {
    return decryptSecret(enc);
  } catch {
    // Written with a different APP_ENCRYPTION_KEY (or corrupted).
    return null;
  }
}

export function maskEmail(email: string) {
  const [user, domain] = email.split("@");
  if (!domain) return "your email";
  const shown = user.length <= 2 ? user[0] : `${user[0]}${"•".repeat(Math.min(6, user.length - 2))}${user.at(-1)}`;
  return `${shown}@${domain}`;
}

/** Creates (or re-shows) a pending authenticator secret and its QR code. */
export async function beginEnrollment(subject: MfaSubject) {
  const row = await load(subject);
  if (!row) throw new ValidationError("Account not found.");
  if (row.mfaEnabledAt) throw new ValidationError("Two-step verification is already set up.");
  let secret = tryDecrypt(row.mfaSecretEnc);
  if (!secret) {
    secret = newTotpSecret();
    await save(subject, { mfaSecretEnc: encryptSecret(secret) });
  }
  const uri = otpauthUri(secret, row.email);
  const qrSvg = await QRCode.toString(uri, { type: "svg", margin: 1, color: { dark: "#001452", light: "#ffffff" } });
  return { secret, qrSvg };
}

/** The time step a 6-digit code matches (current ±1 for clock drift), or null. */
function matchingStep(secret: string, code: string, now = Date.now()): number | null {
  const clean = code.replace(/\s/g, "");
  if (!/^\d{6}$/.test(clean)) return null;
  const step = Math.floor(now / 30_000);
  for (const d of [-1, 0, 1]) {
    if (timingSafeEqual(Buffer.from(totpAt(secret, step + d)), Buffer.from(clean))) return step + d;
  }
  return null;
}

/** Confirms the first code and returns one-time recovery codes (shown once). */
export async function confirmEnrollment(subject: MfaSubject, code: string): Promise<string[]> {
  const row = await load(subject);
  const secret = tryDecrypt(row?.mfaSecretEnc ?? null);
  if (!row || !secret || row.mfaEnabledAt) throw new ValidationError("Start setup again.");
  const step = matchingStep(secret, code);
  if (step === null) throw new ValidationError("That code didn't match. Check that your phone's time is set automatically, then enter the newest 6-digit code.");
  const codes = newRecoveryCodes(10);
  await prisma.$transaction([
    prisma.mfaRecoveryCode.deleteMany({ where: owner(subject) }),
    prisma.mfaRecoveryCode.createMany({ data: codes.map((c) => ({ ...owner(subject), codeHash: hashCode(c) })) }),
  ]);
  await save(subject, { mfaEnabledAt: new Date(), mfaLastStep: step });
  await prisma.auditLog.create({
    data: { actorId: subject.kind === "staff" ? subject.id : null, action: "mfa.enrolled", entityType: subject.kind === "staff" ? "User" : "PortalUser", entityId: subject.id },
  });
  return codes;
}

export type VerifyResult = { ok: true } | { ok: false; reason: "wrong" | "secret_unreadable" | "not_enrolled" | "replayed" | "expired" | "too_many_attempts" | "no_code" };

/** Authenticator code: accepted once per 30-second step. */
export async function verifyAuthenticator(subject: MfaSubject, code: string): Promise<VerifyResult> {
  const row = await load(subject);
  if (!row?.mfaEnabledAt || !row.mfaSecretEnc) return { ok: false, reason: "not_enrolled" };
  const secret = tryDecrypt(row.mfaSecretEnc);
  if (!secret) return { ok: false, reason: "secret_unreadable" };
  const step = matchingStep(secret, code);
  if (step === null) return { ok: false, reason: "wrong" };
  const where = { id: subject.id, OR: [{ mfaLastStep: null }, { mfaLastStep: { lt: step } }] };
  const res = subject.kind === "staff" ? await prisma.user.updateMany({ where, data: { mfaLastStep: step } }) : await prisma.portalUser.updateMany({ where, data: { mfaLastStep: step } });
  return res.count === 1 ? { ok: true } : { ok: false, reason: "replayed" };
}

export async function verifyRecoveryCode(subject: MfaSubject, code: string): Promise<VerifyResult> {
  if (!code.trim()) return { ok: false, reason: "wrong" };
  const used = await prisma.mfaRecoveryCode.updateMany({ where: { ...owner(subject), codeHash: hashCode(code), usedAt: null }, data: { usedAt: new Date() } });
  if (used.count === 1) {
    await prisma.auditLog.create({ data: { actorId: subject.kind === "staff" ? subject.id : null, action: "mfa.recovery_code_used", entityType: subject.kind === "staff" ? "User" : "PortalUser", entityId: subject.id } });
    return { ok: true };
  }
  return { ok: false, reason: "wrong" };
}

/** Back-compat helper: authenticator code or a recovery code. */
export async function verifySecondFactor(subject: MfaSubject, code: string): Promise<boolean> {
  if ((await verifyAuthenticator(subject, code)).ok) return true;
  return (await verifyRecoveryCode(subject, code)).ok;
}

export const emailConfigured = emailProviderConfigured;

/** Why email codes are or aren't offered — shown to the person, never a secret. */
export async function emailCodeAvailability(subject: MfaSubject) {
  const row = await load(subject);
  if (!row) return { available: false, reason: "Account not found." };
  if (subject.kind === "staff") return { available: false, reason: "Staff sign in with an authenticator app and recovery codes." };
  if (!(await emailCodesFor(subject.id))) return { available: false, reason: "Email codes aren't switched on yet — the office is finishing email setup." };
  return { available: true, reason: null as string | null, masked: maskEmail(row.email) };
}

/** Sign-in diagnostics: states only, no secrets. */
export async function enrollmentStatus(subject: MfaSubject) {
  const row = await load(subject);
  if (!row) return null;
  const [remaining, email] = await Promise.all([prisma.mfaRecoveryCode.count({ where: { ...owner(subject), usedAt: null } }), emailCodeAvailability(subject)]);
  return {
    enrolledAt: row.mfaEnabledAt,
    authenticatorReadable: row.mfaSecretEnc ? tryDecrypt(row.mfaSecretEnc) !== null : false,
    recoveryCodesRemaining: remaining,
    emailVerified: !!row.emailVerifiedAt,
    email,
  };
}

/**
 * Emails a 6-digit code. Returns where it went (masked) only when the email
 * provider accepted the message; otherwise a clear error.
 */
export async function sendEmailCode(subject: MfaSubject, purpose: "SIGN_IN" | "VERIFY_EMAIL") {
  const row = await load(subject);
  if (!row) throw new ValidationError("Account not found.");
  if (!emailConfigured()) throw new ValidationError("Email isn't set up yet, so no code can be sent.");
  if (purpose === "SIGN_IN" && (subject.kind === "staff" || !(await emailCodesFor(subject.id)))) throw new ValidationError("Email sign-in codes aren't available for this account.");
  const recent = await prisma.mfaChallenge.findMany({
    where: { subjectKind: subject.kind, subjectId: subject.id, channel: "EMAIL", createdAt: { gte: new Date(Date.now() - 3600_000) } },
    orderBy: { createdAt: "desc" },
  });
  const last = recent[0];
  if (last && Date.now() - last.createdAt.getTime() < RESEND_COOLDOWN_MS) {
    const wait = Math.ceil((RESEND_COOLDOWN_MS - (Date.now() - last.createdAt.getTime())) / 1000);
    throw new ValidationError(`Please wait ${wait} seconds before requesting another code.`);
  }
  if (recent.length >= MAX_SENDS_PER_HOUR) throw new ValidationError("Too many codes requested. Try again in an hour, or use your authenticator app or a recovery code.");
  const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
  const destination = maskEmail(row.email);
  // A new code replaces any earlier unused one.
  await prisma.mfaChallenge.updateMany({ where: { subjectKind: subject.kind, subjectId: subject.id, purpose, consumedAt: null }, data: { consumedAt: new Date() } });
  const challenge = await prisma.mfaChallenge.create({
    data: { subjectKind: subject.kind, subjectId: subject.id, purpose, channel: "EMAIL", destination, codeHash: hashCode(code), expiresAt: new Date(Date.now() + EMAIL_CODE_TTL_MS) },
  });
  const heading = purpose === "SIGN_IN" ? "Your sign-in code" : "Verify your email address";
  const lines = [
    `Your ${BUSINESS.platformName} code is ${code}.`,
    "It expires in 10 minutes and works once. If you didn't try to sign in, you can ignore this email and consider changing your password.",
  ];
  const result = await sendEmail({
    to: row.email,
    subject: `${code} is your ${BUSINESS.platformName} code`,
    text: `${lines.join("\n\n")}\n\n${BUSINESS.legalName}`,
    html: brandedEmailHtml({ heading, paragraphs: lines, button: { label: "Go to sign in", url: `${(process.env.APP_URL || "").replace(/\/$/, "")}/${subject.kind === "staff" ? "staff" : "client"}/login` }, footer: BUSINESS.legalName }),
    idempotencyKey: `mfa-code/${challenge.id}`,
    tags: { category: "account_security" },
  });
  if (!result.ok) {
    await prisma.mfaChallenge.update({ where: { id: challenge.id }, data: { consumedAt: new Date(), sendError: result.detail.slice(0, 300) } });
    throw new ValidationError(`We couldn't send the email (${result.detail}) Use your authenticator app or a recovery code instead.`);
  }
  await prisma.mfaChallenge.update({ where: { id: challenge.id }, data: { sentAt: new Date(), providerId: result.providerId } });
  return { destination };
}

/** Checks an emailed code: single use, unexpired, limited attempts. */
export async function verifyEmailCode(subject: MfaSubject, purpose: "SIGN_IN" | "VERIFY_EMAIL", code: string): Promise<VerifyResult> {
  const c = await prisma.mfaChallenge.findFirst({ where: { subjectKind: subject.kind, subjectId: subject.id, purpose, consumedAt: null, sentAt: { not: null } }, orderBy: { createdAt: "desc" } });
  if (!c) return { ok: false, reason: "no_code" };
  if (c.expiresAt < new Date()) return { ok: false, reason: "expired" };
  if (c.attempts >= MAX_CODE_ATTEMPTS) return { ok: false, reason: "too_many_attempts" };
  const match = timingSafeEqual(Buffer.from(c.codeHash), Buffer.from(hashCode(code)));
  if (!match) {
    await prisma.mfaChallenge.update({ where: { id: c.id }, data: { attempts: { increment: 1 } } });
    return { ok: false, reason: c.attempts + 1 >= MAX_CODE_ATTEMPTS ? "too_many_attempts" : "wrong" };
  }
  const res = await prisma.mfaChallenge.updateMany({ where: { id: c.id, consumedAt: null }, data: { consumedAt: new Date() } });
  if (res.count !== 1) return { ok: false, reason: "no_code" };
  // Entering a code that reached the mailbox proves the address.
  const row = await load(subject);
  if (row && !row.emailVerifiedAt) {
    await save(subject, { emailVerifiedAt: new Date() });
    await prisma.auditLog.create({ data: { actorId: subject.kind === "staff" ? subject.id : null, action: "account.email_verified", entityType: subject.kind === "staff" ? "User" : "PortalUser", entityId: subject.id } });
  }
  // An Admin entering a test code proves end-to-end delivery for the office.
  if (purpose === "VERIFY_EMAIL" && subject.kind === "staff") {
    const u = await prisma.user.findUnique({ where: { id: subject.id } });
    if (u?.role === "ADMIN") {
      await authSettings();
      await prisma.authSettings.update({ where: { id: "default" }, data: { emailDeliveryVerifiedAt: new Date(), emailDeliveryVerifiedBy: subject.id } });
    }
  }
  return { ok: true };
}

export const REASON_TEXT: Record<Exclude<VerifyResult, { ok: true }>["reason"], string> = {
  wrong: "That code didn't work. Check you're using the right code and try again.",
  secret_unreadable:
    "Your authenticator setup can't be read by this site, so authenticator codes can't work right now. This happens when the site's encryption key changed after you set up your app. Use a recovery code, or use the recovery options below — your account and data are safe.",
  not_enrolled: "Two-step verification isn't set up for this account yet.",
  replayed: "That code was already used. Wait for your authenticator app to show the next code.",
  expired: "That code has expired. Request a new one.",
  too_many_attempts: "Too many wrong tries for that code. Request a new one.",
  no_code: "There's no active emailed code. Request a new one.",
};

/** Lost phone: an Admin clears staff MFA; any staff member can clear a client's. */
export async function resetMfa(actor: Actor, subject: MfaSubject) {
  if (subject.kind === "staff") assertAdmin(actor);
  await clearEnrollment(subject);
  if (subject.kind === "staff") await prisma.session.deleteMany({ where: { userId: subject.id } });
  else {
    await prisma.portalSession.deleteMany({ where: { portalUserId: subject.id } });
    await prisma.trustedDevice.updateMany({ where: { portalUserId: subject.id, revokedAt: null }, data: { revokedAt: new Date() } });
  }
  await prisma.auditLog.create({ data: { actorId: actor.id, action: "mfa.reset", entityType: subject.kind === "staff" ? "User" : "PortalUser", entityId: subject.id } });
}

async function clearEnrollment(subject: MfaSubject) {
  await save(subject, { mfaSecretEnc: null, mfaEnabledAt: null, mfaLastStep: null });
  await prisma.mfaRecoveryCode.deleteMany({ where: owner(subject) });
  await prisma.mfaChallenge.updateMany({ where: { subjectKind: subject.kind, subjectId: subject.id, consumedAt: null }, data: { consumedAt: new Date() } });
}

/**
 * Owner recovery for a staff account that can't pass two-step verification
 * and has no other Admin to reset it. Needs the account's password AND the
 * one-time STAFF_RECOVERY_CODE set in Netlify (so only someone with access to
 * the site's hosting can use it). Resets that one account's enrollment so a
 * new authenticator can be set up; verification stays required. Single use.
 */
export async function ownerRecovery(userId: string, sessionId: string, input: { password: string; recoveryCode: string }) {
  const configured = process.env.STAFF_RECOVERY_CODE;
  if (!configured || configured.length < 20) throw new ValidationError("Owner recovery isn't set up. Add a STAFF_RECOVERY_CODE (20+ random characters) in Netlify's environment variables, redeploy, then try again.");
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user?.active || !user.passwordHash) throw new ForbiddenError();
  const tokenHash = createHash("sha256").update(configured).digest("hex");
  const givenOk = input.recoveryCode.length === configured.length && timingSafeEqual(Buffer.from(input.recoveryCode), Buffer.from(configured));
  const passwordOk = await verifyPassword(input.password, user.passwordHash);
  if (!givenOk || !passwordOk) throw new ValidationError("That password or recovery code isn't right.");
  if (await prisma.usedRecoveryToken.findUnique({ where: { tokenHash } })) throw new ValidationError("That recovery code was already used. Set a new STAFF_RECOVERY_CODE in Netlify to recover again.");
  await prisma.usedRecoveryToken.create({ data: { tokenHash, userId } });
  await clearEnrollment({ kind: "staff", id: userId });
  await prisma.session.deleteMany({ where: { userId, id: { not: sessionId } } });
  await prisma.auditLog.create({ data: { actorId: userId, action: "mfa.owner_recovery_used", entityType: "User", entityId: userId } });
}
