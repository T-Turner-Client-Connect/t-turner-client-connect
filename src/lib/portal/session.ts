import "server-only";
import { cache } from "react";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { hashToken, newToken } from "@/lib/auth/tokens";

const SECURE = process.env.NODE_ENV === "production";
// Separate cookie from staff sessions: a client login can never act as staff.
export const PORTAL_COOKIE = SECURE ? "__Host-tcc_portal" : "tcc_portal";

const ABSOLUTE_LIFETIME_MS = 24 * 60 * 60 * 1000;
const IDLE_TIMEOUT_MS = 60 * 60 * 1000;
const TOUCH_INTERVAL_MS = 5 * 60 * 1000;

export type PortalActor = { id: string; name: string; email: string };

export async function createPortalSession(portalUserId: string) {
  const token = newToken();
  const expiresAt = new Date(Date.now() + ABSOLUTE_LIFETIME_MS);
  await prisma.portalSession.create({ data: { tokenHash: hashToken(token), portalUserId, expiresAt } });
  (await cookies()).set(PORTAL_COOKIE, token, { httpOnly: true, secure: SECURE, sameSite: "lax", path: "/", expires: expiresAt });
}

export async function destroyPortalSession() {
  const jar = await cookies();
  const token = jar.get(PORTAL_COOKIE)?.value;
  if (token) await prisma.portalSession.deleteMany({ where: { tokenHash: hashToken(token) } });
  jar.delete(PORTAL_COOKIE);
}

export const getPortalSessionState = cache(async () => {
  const token = (await cookies()).get(PORTAL_COOKIE)?.value;
  if (!token) return null;
  const session = await prisma.portalSession.findUnique({ where: { tokenHash: hashToken(token) }, include: { portalUser: true } });
  if (!session) return null;
  const now = Date.now();
  const u = session.portalUser;
  if (session.expiresAt.getTime() < now || now - session.lastSeenAt.getTime() > IDLE_TIMEOUT_MS || !u.active || !u.passwordHash) {
    await prisma.portalSession.delete({ where: { id: session.id } }).catch(() => {});
    return null;
  }
  if (now - session.lastSeenAt.getTime() > TOUCH_INTERVAL_MS) {
    await prisma.portalSession.update({ where: { id: session.id }, data: { lastSeenAt: new Date() } });
  }
  return { actor: { id: u.id, name: u.name, email: u.email } as PortalActor, sessionId: session.id, mfaPassed: session.mfaPassed, mfaEnrolled: !!u.mfaEnabledAt };
});

export async function markPortalMfaPassed(sessionId: string) {
  await prisma.portalSession.update({ where: { id: sessionId }, data: { mfaPassed: true, lastSeenAt: new Date() } });
}

export async function getPortalUser(): Promise<PortalActor | null> {
  const s = await getPortalSessionState();
  return s?.mfaPassed ? s.actor : null;
}

export async function requirePortalUser(): Promise<PortalActor> {
  const s = await getPortalSessionState();
  if (!s) redirect("/client/login");
  if (!s.mfaPassed) redirect(s.mfaEnrolled ? "/client/mfa" : "/client/mfa/setup");
  return s.actor;
}
