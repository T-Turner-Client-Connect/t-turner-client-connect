import "server-only";
import { cache } from "react";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { hashToken, newToken } from "./tokens";
import { assertAdmin, type Actor } from "./actor";

const SECURE = process.env.NODE_ENV === "production";
// "__Host-" cookies must be Secure, path=/ and host-only — the strongest scope.
export const SESSION_COOKIE = SECURE ? "__Host-tcc_session" : "tcc_session";

const ABSOLUTE_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;
const IDLE_TIMEOUT_MS = 12 * 60 * 60 * 1000;
const TOUCH_INTERVAL_MS = 5 * 60 * 1000;

/** Starts a session that only reaches the MFA screens until verified. */
export async function createSession(userId: string): Promise<void> {
  const token = newToken();
  const expiresAt = new Date(Date.now() + ABSOLUTE_LIFETIME_MS);
  await prisma.session.create({ data: { tokenHash: hashToken(token), userId, expiresAt, mfaPassed: false } });
  const jar = await cookies();
  jar.set(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: SECURE,
    sameSite: "lax",
    path: "/",
    expires: expiresAt,
  });
}

export async function destroySession(): Promise<void> {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  if (token) await prisma.session.deleteMany({ where: { tokenHash: hashToken(token) } });
  jar.delete(SESSION_COOKIE);
}

type SessionState = { actor: Actor; sessionId: string; mfaPassed: boolean; mfaEnrolled: boolean };

/** The session behind the cookie, whether or not MFA is done yet. */
export const getSessionState = cache(async (): Promise<SessionState | null> => {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  if (!token) return null;
  const session = await prisma.session.findUnique({
    where: { tokenHash: hashToken(token) },
    include: { user: true },
  });
  if (!session) return null;
  const now = Date.now();
  if (
    session.expiresAt.getTime() < now ||
    now - session.lastSeenAt.getTime() > IDLE_TIMEOUT_MS ||
    !session.user.active ||
    !session.user.passwordHash
  ) {
    await prisma.session.delete({ where: { id: session.id } }).catch(() => {});
    return null;
  }
  if (now - session.lastSeenAt.getTime() > TOUCH_INTERVAL_MS) {
    await prisma.session.update({ where: { id: session.id }, data: { lastSeenAt: new Date() } });
  }
  const { id, role, name, email } = session.user;
  return { actor: { id, role, name, email }, sessionId: session.id, mfaPassed: session.mfaPassed, mfaEnrolled: !!session.user.mfaEnabledAt };
});

/** Fully signed-in staff member (password + second factor), or null. */
export const getCurrentUser = cache(async (): Promise<Actor | null> => {
  const state = await getSessionState();
  return state?.mfaPassed ? state.actor : null;
});

export async function markMfaPassed(sessionId: string): Promise<void> {
  await prisma.session.update({ where: { id: sessionId }, data: { mfaPassed: true, lastSeenAt: new Date() } });
}

export async function requireUser(): Promise<Actor> {
  const state = await getSessionState();
  if (!state) redirect("/staff/login");
  if (!state.mfaPassed) redirect(state.mfaEnrolled ? "/staff/mfa" : "/staff/mfa/setup");
  return state.actor;
}

export async function requireAdmin(): Promise<Actor> {
  const user = await requireUser();
  assertAdmin(user);
  return user;
}

export async function clientIp(): Promise<string | null> {
  const h = await headers();
  return h.get("x-nf-client-connection-ip") ?? h.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null;
}

export async function revokeAllSessions(userId: string): Promise<void> {
  await prisma.session.deleteMany({ where: { userId } });
}
