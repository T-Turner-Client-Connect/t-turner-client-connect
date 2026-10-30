import "server-only";
import { cookies, headers } from "next/headers";
import { prisma } from "@/lib/prisma";
import { assertAdmin, type Actor } from "./actor";
import { hashToken, newToken } from "./tokens";
import { ValidationError } from "@/lib/services/clients";

/**
 * Client sign-in mode. Clients use password + emailed code only after email
 * delivery has been proven (an Admin received a test code and entered it) and
 * an Admin switched it on. Until then clients keep the authenticator flow, so
 * nobody is locked out by an email setup problem.
 */
export async function authSettings() {
  const found = await prisma.authSettings.findUnique({ where: { id: "default" } });
  if (found) return found;
  // Two first requests can race to create the row; the loser just reads it.
  return prisma.authSettings.create({ data: { id: "default" } }).catch(() => prisma.authSettings.findUniqueOrThrow({ where: { id: "default" } }));
}

export const emailProviderConfigured = () => Boolean(process.env.RESEND_API_KEY && process.env.EMAIL_FROM_ADDRESS);

export async function clientEmailCodesActive() {
  const s = await authSettings();
  return s.clientEmailCodes && !!s.emailDeliveryVerifiedAt && emailProviderConfigured();
}

/**
 * Whether this client signs in with emailed codes: everyone once the switch is
 * on, and self-signup accounts (which only exist after delivery was proven and
 * have no authenticator app) as soon as delivery is proven.
 */
export async function emailCodesFor(portalUserId: string) {
  if (await clientEmailCodesActive()) return true;
  const s = await authSettings();
  if (!s.emailDeliveryVerifiedAt || !emailProviderConfigured()) return false;
  const u = await prisma.portalUser.findUnique({ where: { id: portalUserId }, select: { origin: true, mfaEnabledAt: true } });
  return u?.origin === "SELF_SIGNUP" && !u.mfaEnabledAt;
}

export async function setClientEmailCodes(actor: Actor, on: boolean) {
  assertAdmin(actor);
  const s = await authSettings();
  if (on && (!emailProviderConfigured() || !s.emailDeliveryVerifiedAt)) {
    throw new ValidationError("First confirm email delivery: send yourself a test code and enter it. Email codes stay off until delivery is proven.");
  }
  await prisma.authSettings.update({ where: { id: "default" }, data: { clientEmailCodes: on, enabledById: actor.id, enabledAt: new Date() } });
  await prisma.auditLog.create({ data: { actorId: actor.id, action: on ? "auth.client_email_codes_on" : "auth.client_email_codes_off", entityType: "AuthSettings", entityId: "default" } });
}

// ---------------------------------------------------------------------------
// Remember this device (clients only)
// ---------------------------------------------------------------------------

const SECURE = process.env.NODE_ENV === "production";
export const TRUST_COOKIE = SECURE ? "__Host-tcc_trusted" : "tcc_trusted";

function deviceLabel(ua: string | null) {
  if (!ua) return "Unknown browser";
  const os = /iPhone|iPad/.test(ua) ? "iPhone/iPad" : /Android/.test(ua) ? "Android" : /Mac OS X/.test(ua) ? "Mac" : /Windows/.test(ua) ? "Windows" : "Computer";
  const browser = /Edg\//.test(ua) ? "Edge" : /Chrome\//.test(ua) ? "Chrome" : /Firefox\//.test(ua) ? "Firefox" : /Safari\//.test(ua) ? "Safari" : "Browser";
  return `${browser} on ${os}`;
}

export async function rememberDevice(portalUserId: string) {
  const days = (await authSettings()).trustedDeviceDays;
  const token = newToken();
  const expiresAt = new Date(Date.now() + days * 86400_000);
  await prisma.trustedDevice.create({ data: { portalUserId, tokenHash: hashToken(token), label: deviceLabel((await headers()).get("user-agent")), expiresAt } });
  (await cookies()).set(TRUST_COOKIE, token, { httpOnly: true, secure: SECURE, sameSite: "lax", path: "/", expires: expiresAt });
}

/** True when this browser holds an unexpired, unrevoked trusted-device cookie for this client. */
export async function trustedDeviceFor(portalUserId: string) {
  const token = (await cookies()).get(TRUST_COOKIE)?.value;
  if (!token) return false;
  const res = await prisma.trustedDevice.updateMany({
    where: { tokenHash: hashToken(token), portalUserId, revokedAt: null, expiresAt: { gt: new Date() } },
    data: { lastUsedAt: new Date() },
  });
  return res.count === 1;
}

export async function revokeTrustedDevice(portalUserId: string, deviceId: string) {
  await prisma.trustedDevice.updateMany({ where: { id: deviceId, portalUserId, revokedAt: null }, data: { revokedAt: new Date() } });
}

/** Password reset, email change or a staff request: forget every remembered device. */
export async function revokeAllTrustedDevices(portalUserId: string) {
  await prisma.trustedDevice.updateMany({ where: { portalUserId, revokedAt: null }, data: { revokedAt: new Date() } });
}
