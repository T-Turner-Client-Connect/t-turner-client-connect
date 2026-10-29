"use server";

import { revalidatePath } from "next/cache";
import { requirePortalUser } from "@/lib/portal/session";
import { run, str, type ActionState } from "@/lib/action";
import { ValidationError } from "@/lib/services/clients";
import { portalAcceptQuote, portalDeclineQuote } from "@/lib/services/owner-billing";
import { clientIp } from "@/lib/auth/session";

export async function acceptQuoteAction(invoiceId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const user = await requirePortalUser();
  return run(async () => {
    const [option, termsHash] = str(fd, "choice").split("|");
    if (option !== "FULL" && option !== "PLAN") throw new ValidationError("Choose how you'd like to pay.");
    await portalAcceptQuote(user, { invoiceId, option, termsHash: termsHash ?? "", agreed: fd.get("agree") === "on", ip: await clientIp() });
    revalidatePath("/client/billing");
    return "Thank you — your acceptance is recorded. Your payment schedule is below. Nothing is charged automatically.";
  });
}

export async function declineQuoteAction(invoiceId: string, _prev: ActionState): Promise<ActionState> {
  const user = await requirePortalUser();
  return run(async () => {
    await portalDeclineQuote(user, invoiceId);
    revalidatePath("/client/billing");
    return "You declined this quote. Message us if you'd like to talk it over.";
  });
}
