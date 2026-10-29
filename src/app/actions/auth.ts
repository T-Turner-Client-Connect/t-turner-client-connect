"use server";

import { redirect } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { run, str, type ActionState } from "@/lib/action";
import { clientIp, createSession, destroySession, getSessionState, markMfaPassed } from "@/lib/auth/session";
import { confirmEnrollment, verifySecondFactor } from "@/lib/services/mfa";
import { verifyPassword } from "@/lib/auth/password";
import { normalizeEmail } from "@/lib/normalize";
import { acceptInvite, bootstrapFirstAdmin, createPasswordReset, resetPassword } from "@/lib/services/users";
import { ValidationError } from "@/lib/services/clients";
import { sendTransactionalEmail } from "@/lib/email";
import { appUrl } from "@/lib/integrations";

// Compared against when the email is unknown, so timing doesn't reveal accounts.
const DUMMY_HASH = "$2b$12$E1k2M6uQD48nLE0mEp8P1.FE9D7aHL9fhG0NA73m3ZSPghUDtYUHW";
const WINDOW_MS = 15 * 60 * 1000;

export async function loginAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const email = normalizeEmail(str(fd, "email")) ?? "";
  const password = str(fd, "password");
  const ip = await clientIp();
  const since = new Date(Date.now() - WINDOW_MS);
  const [byEmail, byIp] = await Promise.all([
    prisma.loginAttempt.count({ where: { email, success: false, createdAt: { gte: since } } }),
    ip ? prisma.loginAttempt.count({ where: { ip, success: false, createdAt: { gte: since } } }) : 0,
  ]);
  if (byEmail >= 5 || byIp >= 30) {
    return { error: "Too many sign-in attempts. Wait 15 minutes, or reset your password." };
  }
  const user = email ? await prisma.user.findUnique({ where: { email } }) : null;
  const ok = await verifyPassword(password, user?.passwordHash ?? DUMMY_HASH);
  if (!user || !ok || !user.active || !user.passwordHash) {
    await prisma.loginAttempt.create({ data: { email, ip, success: false } });
    return { error: "That email and password don't match an active account." };
  }
  await prisma.loginAttempt.create({ data: { email, ip, success: true } });
  await prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
  await createSession(user.id);
  redirect(user.mfaEnabledAt ? "/staff/mfa" : "/staff/mfa/setup");
}

export async function logoutAction() {
  await destroySession();
  redirect("/staff/login");
}

export async function setupAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const result = await run(async () => {
    if (str(fd, "password") !== str(fd, "confirm")) throw new ValidationError("The passwords don't match.");
    const user = await bootstrapFirstAdmin({ setupToken: str(fd, "setupToken"), name: str(fd, "name"), email: str(fd, "email"), password: str(fd, "password") });
    await createSession(user.id);
  });
  if (result?.ok) redirect("/staff/mfa/setup");
  return result;
}

export async function acceptInviteAction(token: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const result = await run(async () => {
    if (str(fd, "password") !== str(fd, "confirm")) throw new ValidationError("The passwords don't match.");
    const user = await acceptInvite(token, str(fd, "password"));
    await createSession(user.id);
  });
  if (result?.ok) redirect("/staff/mfa/setup");
  return result;
}

export async function forgotPasswordAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  return run(async () => {
    const reset = await createPasswordReset(str(fd, "email"), null);
    if (reset) {
      await sendTransactionalEmail(
        reset.user.email,
        "Reset your TTurner Client Connect password",
        `Hi ${reset.user.name},\n\nUse this link within one hour to choose a new password:\n${appUrl()}/staff/reset-password/${reset.token}\n\nIf you didn't ask for this, you can ignore this email.`,
      );
    }
    // Same answer whether or not the account exists.
    return "If that email belongs to a staff account, a reset link is on its way. No email? Ask an Admin to create a reset link for you from Settings.";
  });
}

export async function resetPasswordAction(token: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const result = await run(async () => {
    if (str(fd, "password") !== str(fd, "confirm")) throw new ValidationError("The passwords don't match.");
    await resetPassword(token, str(fd, "password"));
  });
  if (result?.ok) redirect("/staff/login?reset=1");
  return result;
}

const MFA_MAX_FAILURES = 5;

async function mfaLocked(key: string) {
  const since = new Date(Date.now() - WINDOW_MS);
  return (await prisma.loginAttempt.count({ where: { email: key, success: false, createdAt: { gte: since } } })) >= MFA_MAX_FAILURES;
}

export async function verifyMfaAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const state = await getSessionState();
  if (!state) redirect("/staff/login");
  const key = `mfa:staff:${state.actor.id}`;
  if (await mfaLocked(key)) return { error: "Too many wrong codes. Wait 15 minutes and try again." };
  if (!(await verifySecondFactor({ kind: "staff", id: state.actor.id }, str(fd, "code")))) {
    await prisma.loginAttempt.create({ data: { email: key, ip: await clientIp(), success: false } });
    return { error: "That code didn't work. Use the newest code from your authenticator app, or a recovery code." };
  }
  await markMfaPassed(state.sessionId);
  redirect("/");
}

export async function confirmMfaSetupAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const state = await getSessionState();
  if (!state) redirect("/staff/login");
  let codes: string[] = [];
  const result = await run(async () => {
    codes = await confirmEnrollment({ kind: "staff", id: state.actor.id }, str(fd, "code"));
    await markMfaPassed(state.sessionId);
  });
  return result?.ok ? { ...result, codes } : result;
}
