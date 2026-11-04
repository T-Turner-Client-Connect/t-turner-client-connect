"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth/session";
import { run, str, type ActionState } from "@/lib/action";
import {
  applySquarePaymentToInvoice,
  dismissSquarePayment,
  refreshSquareInvoice,
  resendSquareLink,
  runSquareReconcileNow,
  sendInvoiceViaSquare,
  setSquareDeliveryOptions,
  setSquareSending,
  SQUARE_STATUS_LABELS,
} from "@/lib/services/square-invoicing";

export async function sendViaSquareAction(invoiceId: string, _prev: ActionState): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    const r = await sendInvoiceViaSquare(actor, invoiceId);
    revalidatePath(`/owner/invoices/${invoiceId}`);
    if (r.already) return "Already sent through Square.";
    if (r.emailProblem) return `Sent through Square. ${r.emailProblem}`;
    return r.delivery === "EMAIL" ? "Sent through Square. Square emailed the invoice to the client." : `Sent through Square. The payment link was emailed to ${r.emailedTo}.`;
  });
}

export async function refreshSquareAction(invoiceId: string, _prev: ActionState): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    const r = await refreshSquareInvoice(actor, invoiceId);
    revalidatePath(`/owner/invoices/${invoiceId}`);
    return r ? `Square: ${SQUARE_STATUS_LABELS[r.status ?? ""] ?? r.status ?? "unknown"}${r.newPayments ? ` — ${r.newPayments} new payment(s) recorded` : ""}.` : "Not sent through Square.";
  });
}

export async function resendSquareLinkAction(invoiceId: string, _prev: ActionState): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => `Square payment link emailed to ${await resendSquareLink(actor, invoiceId)}.`);
}

export async function squareSendingAction(enabled: boolean, _prev: ActionState): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    await setSquareSending(actor, enabled);
    revalidatePath("/owner/settings");
    return enabled ? "Send invoices through Square is on." : "Send invoices through Square is off. Nothing new goes to Square.";
  });
}

export async function squareDeliveryAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    await setSquareDeliveryOptions(actor, { delivery: str(fd, "delivery"), acceptBank: fd.get("acceptBank") === "on" });
    revalidatePath("/owner/settings");
    return "Saved.";
  });
}

export async function reconcileNowAction(_prev: ActionState): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    const r = await runSquareReconcileNow(actor);
    revalidatePath("/owner/reconcile");
    if ("skipped" in r && r.skipped) return `Not run: ${r.skipped}.`;
    return `Checked ${r.checked} Square invoice(s); ${r.newPayments} new payment(s) recorded${r.failed ? `; ${r.failed} couldn't be read` : ""}.`;
  });
}

export async function applySquarePaymentAction(seenId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    await applySquarePaymentToInvoice(actor, seenId, str(fd, "invoiceId"));
    revalidatePath("/owner/reconcile");
    return "Payment recorded on the invoice.";
  });
}

export async function dismissSquarePaymentAction(seenId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    await dismissSquarePayment(actor, seenId, str(fd, "note"));
    revalidatePath("/owner/reconcile");
    return "Marked as reviewed.";
  });
}
