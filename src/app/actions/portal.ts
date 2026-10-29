"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { run, str, type ActionState } from "@/lib/action";
import { clientIp } from "@/lib/auth/session";
import { verifyPassword } from "@/lib/auth/password";
import { normalizeEmail } from "@/lib/normalize";
import { createPortalSession, destroyPortalSession, getPortalSessionState, markPortalMfaPassed, requirePortalUser } from "@/lib/portal/session";
import { acceptPortalInvite, createPortalReset, resetPortalPassword, updateNotificationPrefs } from "@/lib/services/portal-accounts";
import { confirmEnrollment, verifySecondFactor } from "@/lib/services/mfa";
import { portalUploadDocument } from "@/lib/services/documents";
import { markClientRead, portalSendMessage } from "@/lib/services/messaging";
import { ValidationError } from "@/lib/services/clients";
import { setPortalSmsConsent } from "@/lib/services/sms-consent";
import { sendTransactionalEmail } from "@/lib/email";
import { appUrl } from "@/lib/integrations";

const WINDOW_MS = 15 * 60 * 1000;
const DUMMY_HASH = "$2b$12$E1k2M6uQD48nLE0mEp8P1.FE9D7aHL9fhG0NA73m3ZSPghUDtYUHW";

async function failures(key: string) {
  return prisma.loginAttempt.count({ where: { email: key, success: false, createdAt: { gte: new Date(Date.now() - WINDOW_MS) } } });
}

export async function portalLoginAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const email = normalizeEmail(str(fd, "email")) ?? "";
  const key = `portal:${email}`;
  const ip = await clientIp();
  if ((await failures(key)) >= 5) return { error: "Too many sign-in attempts. Wait 15 minutes, or reset your password." };
  const user = email ? await prisma.portalUser.findUnique({ where: { email } }) : null;
  const ok = await verifyPassword(str(fd, "password"), user?.passwordHash ?? DUMMY_HASH);
  if (!user || !ok || !user.active || !user.passwordHash) {
    await prisma.loginAttempt.create({ data: { email: key, ip, success: false } });
    return { error: "That email and password don't match an active portal account." };
  }
  await prisma.loginAttempt.create({ data: { email: key, ip, success: true } });
  await prisma.portalUser.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
  await createPortalSession(user.id);
  redirect(user.mfaEnabledAt ? "/client/mfa" : "/client/mfa/setup");
}

export async function portalLogoutAction() {
  await destroyPortalSession();
  redirect("/client/login");
}

export async function portalAcceptInviteAction(token: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const result = await run(async () => {
    if (str(fd, "password") !== str(fd, "confirm")) throw new ValidationError("The passwords don't match.");
    const user = await acceptPortalInvite(token, str(fd, "password"));
    await createPortalSession(user.id);
  });
  if (result?.ok) redirect("/client/mfa/setup");
  return result;
}

export async function portalForgotAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  return run(async () => {
    const reset = await createPortalReset(str(fd, "email"));
    if (reset) {
      await sendTransactionalEmail(
        reset.user.email,
        "Reset your client portal password",
        `Use this link within one hour to choose a new password for your T. Turner & Associates client portal:\n${appUrl()}/client/reset-password/${reset.token}\n\nIf you didn't ask for this, you can ignore this email.`,
      );
    }
    return "If that email has a portal account, a reset link is on its way. Didn't get it? Call our office and we'll help.";
  });
}

export async function portalResetAction(token: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const result = await run(async () => {
    if (str(fd, "password") !== str(fd, "confirm")) throw new ValidationError("The passwords don't match.");
    await resetPortalPassword(token, str(fd, "password"));
  });
  if (result?.ok) redirect("/client/login?reset=1");
  return result;
}

export async function portalVerifyMfaAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const state = await getPortalSessionState();
  if (!state) redirect("/client/login");
  const key = `mfa:portal:${state.actor.id}`;
  if ((await failures(key)) >= 5) return { error: "Too many wrong codes. Wait 15 minutes and try again." };
  if (!(await verifySecondFactor({ kind: "portal", id: state.actor.id }, str(fd, "code")))) {
    await prisma.loginAttempt.create({ data: { email: key, ip: await clientIp(), success: false } });
    return { error: "That code didn't work. Use the newest code from your authenticator app, or a recovery code." };
  }
  await markPortalMfaPassed(state.sessionId);
  redirect("/client");
}

export async function portalConfirmMfaSetupAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const state = await getPortalSessionState();
  if (!state) redirect("/client/login");
  let codes: string[] = [];
  const result = await run(async () => {
    codes = await confirmEnrollment({ kind: "portal", id: state.actor.id }, str(fd, "code"));
    await markPortalMfaPassed(state.sessionId);
  });
  return result?.ok ? { ...result, codes } : result;
}

async function optionalFile(fd: FormData, key: string) {
  const f = fd.get(key);
  return f instanceof File && f.size > 0 ? { bytes: new Uint8Array(await f.arrayBuffer()), originalName: f.name } : null;
}

export async function portalMessageAction(clientId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const user = await requirePortalUser();
  return run(async () => {
    const file = await optionalFile(fd, "file");
    const attachmentIds = file ? [(await portalUploadDocument(user, { clientId, ...file })).id] : [];
    await portalSendMessage(user, {
      clientId,
      conversationId: str(fd, "conversationId") || null,
      subject: str(fd, "subject"),
      body: str(fd, "body"),
      attachmentIds,
      idempotencyKey: str(fd, "idempotencyKey") || undefined,
    });
    revalidatePath("/client/messages");
    return "Message sent. We'll reply here in your portal.";
  });
}

export async function portalUploadAction(clientId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const user = await requirePortalUser();
  return run(async () => {
    const file = await optionalFile(fd, "file");
    if (!file) throw new ValidationError("Choose a file to upload.");
    await portalUploadDocument(user, { clientId, requestId: str(fd, "requestId") || null, periodId: str(fd, "periodId") || null, title: str(fd, "title"), ...file });
    revalidatePath("/client", "layout");
    return "Uploaded securely. Thank you!";
  });
}

export async function portalMarkReadAction(conversationId: string) {
  const user = await requirePortalUser();
  await markClientRead(user, conversationId);
}

export async function portalPrefsAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const user = await requirePortalUser();
  return run(async () => {
    const notifyBySms = fd.get("notifyBySms") === "on";
    await updateNotificationPrefs(user.id, { notifyByEmail: fd.get("notifyByEmail") === "on", notifyBySms, phone: str(fd, "phone") });
    const updated = await prisma.portalUser.findUniqueOrThrow({ where: { id: user.id } });
    await setPortalSmsConsent(user.id, updated.phoneNormalized, notifyBySms);
    return "Preferences saved.";
  });
}
