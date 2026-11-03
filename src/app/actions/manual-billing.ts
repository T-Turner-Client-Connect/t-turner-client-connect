"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth/session";
import { run, str, type ActionState } from "@/lib/action";
import { recordManualPayment, voidManualPayment } from "@/lib/services/manual-billing";

const refresh = () => revalidatePath("/bookkeeping", "layout");

export async function recordManualPaymentAction(clientId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    const p = await recordManualPayment(actor, clientId, {
      amount: str(fd, "amount"),
      paidOn: str(fd, "paidOn"),
      periodMonth: str(fd, "periodMonth"),
      method: str(fd, "method"),
      reference: str(fd, "reference"),
      note: str(fd, "note"),
    });
    refresh();
    return `Payment of $${(p.amountCents / 100).toFixed(2)} recorded.`;
  });
}

export async function voidManualPaymentAction(paymentId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    await voidManualPayment(actor, paymentId, str(fd, "reason"));
    refresh();
    return "Payment voided. It stays in the history with your reason.";
  });
}
