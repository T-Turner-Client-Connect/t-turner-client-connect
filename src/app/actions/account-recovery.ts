"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth/session";
import { run, str, type ActionState } from "@/lib/action";
import {
  privateRecoveryLink, resendVerificationCode, resetAttemptLimit, resetClientTwoStep, revokeSessions, sendPasswordResetEmail,
} from "@/lib/services/account-recovery";

type Step = "reset_email" | "verify_code" | "limit" | "two_step" | "sessions" | "private_link";

/** One entry point for the Account Access & Recovery panel. Each step checks Admin and the client↔login link on the server. */
export async function recoveryAction(clientId: string, portalUserId: string | null, step: Step, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  const verify = { verified: fd.get("verified") === "on", note: str(fd, "note") };
  let link: string | null = null;
  const state = await run(async () => {
    const id = portalUserId ?? "";
    let msg: string;
    if (step === "reset_email") msg = await sendPasswordResetEmail(actor, clientId, id);
    else if (step === "verify_code") msg = await resendVerificationCode(actor, clientId, id);
    else if (step === "limit") msg = await resetAttemptLimit(actor, clientId, str(fd, "email"), verify);
    else if (step === "two_step") msg = await resetClientTwoStep(actor, clientId, id, verify);
    else if (step === "sessions") msg = await revokeSessions(actor, clientId, id);
    else {
      const r = await privateRecoveryLink(actor, clientId, id, verify);
      link = r.link;
      msg = r.message;
    }
    revalidatePath(`/clients/${clientId}`);
    return msg;
  });
  return link && state?.ok ? { ...state, link } : state;
}
