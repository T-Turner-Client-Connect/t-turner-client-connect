"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth/session";
import { run, str, type ActionState } from "@/lib/action";
import { markMonthsPaid, recordManualPayment, voidManualPayment } from "@/lib/services/manual-billing";

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

export async function markMonthsPaidAction(clientId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    const r = await markMonthsPaid(actor, clientId, {
      months: fd.getAll("months").map(String),
      amountEach: str(fd, "amountEach"),
      method: str(fd, "method"),
      reference: str(fd, "reference"),
      dateMode: str(fd, "dateMode") === "ONE_DATE" ? "ONE_DATE" : "DUE_DATE",
      paidOn: str(fd, "paidOn"),
      note: str(fd, "note"),
    });
    refresh();
    const label = (m: string) => new Date(`${m}-15T12:00:00Z`).toLocaleDateString("en-US", { month: "short", year: "numeric", timeZone: "UTC" });
    return [
      `Recorded ${r.recorded.length} month${r.recorded.length === 1 ? "" : "s"}.`,
      r.skipped.length ? `Skipped ${r.skipped.length} already paid.` : "",
      r.partial.length ? `Not changed — partly paid: ${r.partial.map(label).join(", ")}. Record the remaining amount with Record a Payment.` : "",
    ].filter(Boolean).join(" ");
  });
}
