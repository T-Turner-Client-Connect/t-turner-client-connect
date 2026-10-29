"use server";

import { redirect } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { run, str, type ActionState } from "@/lib/action";
import { clientIp, createSession, destroySession } from "@/lib/auth/session";
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
  redirect("/");
}

export async function logoutAction() {
  await destroySession();
  redirect("/login");
}

export async function setupAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const result = await run(async () => {
    if (str(fd, "password") !== str(fd, "confirm")) throw new ValidationError("The passwords don't match.");
    const user = await bootstrapFirstAdmin({ setupToken: str(fd, "setupToken"), name: str(fd, "name"), email: str(fd, "email"), password: str(fd, "password") });
    await createSession(user.id);
  });
  if (result?.ok) redirect("/");
  return result;
}

export async function acceptInviteAction(token: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const result = await run(async () => {
    if (str(fd, "password") !== str(fd, "confirm")) throw new ValidationError("The passwords don't match.");
    const user = await acceptInvite(token, str(fd, "password"));
    await createSession(user.id);
  });
  if (result?.ok) redirect("/");
  return result;
}

export async function forgotPasswordAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  return run(async () => {
    const reset = await createPasswordReset(str(fd, "email"), null);
    if (reset) {
      await sendTransactionalEmail(
        reset.user.email,
        "Reset your TTurner Client Connect password",
        `Hi ${reset.user.name},\n\nUse this link within one hour to choose a new password:\n${appUrl()}/reset-password/${reset.token}\n\nIf you didn't ask for this, you can ignore this email.`,
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
  if (result?.ok) redirect("/login?reset=1");
  return result;
}
