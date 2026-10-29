"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { run, str, type ActionState } from "@/lib/action";
import { clientIp, getCurrentUser, getSessionState, markMfaPassed } from "@/lib/auth/session";
import { getPortalSessionState, getPortalUser, markPortalMfaPassed } from "@/lib/portal/session";
import { rememberDevice, setClientEmailCodes } from "@/lib/auth/client-auth";
import { ownerRecovery, REASON_TEXT, sendEmailCode, verifyAuthenticator, verifyEmailCode, verifyRecoveryCode, type MfaSubject, type VerifyResult } from "@/lib/services/mfa";

type Kind = "staff" | "portal";
const WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILURES = 5;

/** The half-signed-in session (password done, second step pending). */
async function pending(kind: Kind) {
  if (kind === "staff") {
    const s = await getSessionState();
    if (!s) redirect("/staff/login");
    return { subject: { kind, id: s.actor.id } as MfaSubject, sessionId: s.sessionId, passed: s.mfaPassed };
  }
  const s = await getPortalSessionState();
  if (!s) redirect("/client/login");
  return { subject: { kind, id: s.actor.id } as MfaSubject, sessionId: s.sessionId, passed: s.mfaPassed };
}

const lockKey = (s: MfaSubject) => `mfa:${s.kind}:${s.id}`;
async function locked(s: MfaSubject) {
  return (await prisma.loginAttempt.count({ where: { email: lockKey(s), success: false, createdAt: { gte: new Date(Date.now() - WINDOW_MS) } } })) >= MAX_FAILURES;
}

/** Second step at sign-in: authenticator app, recovery code, or emailed code. */
export async function verifySignInAction(kind: Kind, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const p = await pending(kind);
  if (p.passed) redirect(kind === "staff" ? "/" : "/client");
  if (await locked(p.subject)) return { error: "Too many wrong codes. For your security, wait 15 minutes and try again." };
  const method = str(fd, "method");
  const code = str(fd, "code");
  let result: VerifyResult;
  if (method === "recovery") result = await verifyRecoveryCode(p.subject, code);
  else if (method === "email" && kind === "portal") result = await verifyEmailCode(p.subject, "SIGN_IN", code);
  else result = await verifyAuthenticator(p.subject, code);
  if (!result.ok) {
    if (result.reason === "wrong" || result.reason === "replayed") await prisma.loginAttempt.create({ data: { email: lockKey(p.subject), ip: await clientIp(), success: false } });
    const text = method === "recovery" && result.reason === "wrong" ? "That recovery code didn't work. Each code works once — try another unused one." : REASON_TEXT[result.reason];
    return { error: text };
  }
  if (kind === "staff") await markMfaPassed(p.sessionId);
  else {
    await markPortalMfaPassed(p.sessionId);
    if (method === "email" && fd.get("remember") === "on") await rememberDevice(p.subject.id);
  }
  redirect(kind === "staff" ? "/" : "/client");
}

/** "Send me a code" / "Resend" for emailed sign-in codes. */
export async function sendSignInCodeAction(kind: Kind, _prev: ActionState): Promise<ActionState> {
  const p = await pending(kind);
  return run(async () => {
    const { destination } = await sendEmailCode(p.subject, "SIGN_IN");
    return `We emailed a 6-digit code to ${destination}. It expires in 10 minutes.`;
  });
}

/** Owner recovery (staff only): password + the one-time STAFF_RECOVERY_CODE from Netlify. */
export async function ownerRecoveryAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const p = await pending("staff");
  const result = await run(async () => {
    await ownerRecovery(p.subject.id, p.sessionId, { password: str(fd, "password"), recoveryCode: str(fd, "recoveryCode") });
  });
  if (result?.ok) redirect("/staff/mfa/setup?recovered=1");
  return result;
}

/** Fully signed-in: prove the account's email so email codes become available. */
async function signedIn(kind: Kind): Promise<MfaSubject> {
  if (kind === "staff") {
    const u = await getCurrentUser();
    if (!u) redirect("/staff/login");
    return { kind, id: u.id };
  }
  const u = await getPortalUser();
  if (!u) redirect("/client/login");
  return { kind, id: u.id };
}

export async function sendVerifyEmailAction(kind: Kind, _prev: ActionState): Promise<ActionState> {
  const subject = await signedIn(kind);
  return run(async () => {
    const { destination } = await sendEmailCode(subject, "VERIFY_EMAIL");
    return `We emailed a 6-digit code to ${destination}. Enter it below within 10 minutes.`;
  });
}

export async function confirmVerifyEmailAction(kind: Kind, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const subject = await signedIn(kind);
  const r = await verifyEmailCode(subject, "VERIFY_EMAIL", str(fd, "code"));
  if (!r.ok) return { error: REASON_TEXT[r.reason] };
  revalidatePath(kind === "staff" ? "/settings" : "/client/account");
  return { ok: "Email delivery confirmed.", at: Date.now() };
}

export async function clientEmailCodesAction(on: boolean, _prev: ActionState): Promise<ActionState> {
  const actor = await getCurrentUser();
  if (!actor) redirect("/staff/login");
  return run(async () => {
    await setClientEmailCodes(actor, on);
    revalidatePath("/settings");
    return on ? "Clients now sign in with a password and an emailed code." : "Clients are back to authenticator-app codes.";
  });
}
