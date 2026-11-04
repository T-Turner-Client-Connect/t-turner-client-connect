"use server";
import { cookies, headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { run, str, type ActionState } from "@/lib/action";
import { clientIp } from "@/lib/auth/session";
import { getPortalUser, requirePortalUser } from "@/lib/portal/session";
import { decideByLink, decidePayroll, resolveLink, sendLinkCode, setNotifyChannel, verifyLink } from "@/lib/services/payroll-approval";
import { ValidationError } from "@/lib/services/clients";
import { PAYROLL_VERIFY_COOKIE } from "@/lib/payroll/cookie";

/**
 * Business owners' payroll actions. The ONLY payroll writes a portal login can make: approve or
 * deny (with a comment) and choose how they're notified. Everything is re-checked on the server.
 */

const SECURE = process.env.NODE_ENV === "production";
const VERIFY_COOKIE = PAYROLL_VERIFY_COOKIE;
const decisionOf = (fd: FormData) => {
  const d = str(fd, "decision");
  if (d !== "APPROVED" && d !== "DENIED") throw new ValidationError("Choose Approve Payroll or Deny Payroll.");
  return d;
};

export async function portalPayrollDecisionAction(clientId: string, runId: string, versionId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const user = await requirePortalUser();
  return run(async () => {
    const decision = decisionOf(fd);
    await decidePayroll(user.id, clientId, runId, { decision, comment: str(fd, "comment"), versionId }, { channel: "PORTAL", verifiedBy: "PORTAL_SESSION", ip: await clientIp(), userAgent: (await headers()).get("user-agent") });
    revalidatePath("/client/payroll-approval");
    return decision === "APPROVED" ? "Approved. Thank you — the office has been notified." : "Denied. The office will review it and send a corrected payroll.";
  });
}

export async function portalNotifyChannelAction(clientId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const user = await requirePortalUser();
  return run(async () => {
    await setNotifyChannel({ portalUserId: user.id }, clientId, user.id, str(fd, "channel"));
    revalidatePath("/client/payroll-approval");
    return "Saved. We'll use this for payroll approval requests.";
  });
}

// --- Texted / emailed links (no portal session needed to open; identity is confirmed first) -----

export async function linkSendCodeAction(token: string, _prev: ActionState, _fd: FormData): Promise<ActionState> {
  return run(async () => {
    const { destination } = await sendLinkCode(token);
    return `We emailed a 6-digit code to ${destination}. It expires in 10 minutes.`;
  });
}

export async function linkVerifyAction(token: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  return run(async () => {
    const { nonce } = await verifyLink(token, { code: str(fd, "code") || undefined, password: str(fd, "password") || undefined, authenticatorCode: str(fd, "authenticatorCode") || undefined });
    const { link } = await resolveLink(token);
    (await cookies()).set(VERIFY_COOKIE, `${link!.id}.${nonce}`, { httpOnly: true, secure: SECURE, sameSite: "strict", path: "/", maxAge: 30 * 60 });
    revalidatePath(`/payroll-approval/${token}`);
    return "Confirmed. You can record your decision now.";
  });
}

export async function linkDecideAction(token: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  return run(async () => {
    const decision = decisionOf(fd);
    const session = await getPortalUser();
    const { link } = await resolveLink(token);
    const raw = (await cookies()).get(VERIFY_COOKIE)?.value ?? "";
    const [linkId, nonce] = raw.split(".");
    await decideByLink(token, { decision, comment: str(fd, "comment"), sessionPortalUserId: session?.id ?? null, nonce: link && linkId === link.id ? nonce : null, ip: await clientIp(), userAgent: (await headers()).get("user-agent") });
    (await cookies()).delete(VERIFY_COOKIE);
    revalidatePath(`/payroll-approval/${token}`);
    return decision === "APPROVED" ? "Approved. Your decision is recorded." : "Denied. The office will review it.";
  });
}
