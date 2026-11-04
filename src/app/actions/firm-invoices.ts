"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth/session";
import { run, str, type ActionState } from "@/lib/action";
import { ValidationError } from "@/lib/services/clients";
import { recordPayment } from "@/lib/services/owner-billing";
import {
  approveAndSend,
  createFirmInvoice,
  returnToDraft,
  setRefundTransferFeeNote,
  setSquareLinksEnabled,
  submitForApproval,
  updateFirmInvoice,
  type FirmInvoiceInput,
} from "@/lib/services/firm-invoices";

/** "1,234.56" or "$80" → cents. */
function cents(raw: string): number {
  const v = raw.replace(/[$,\s]/g, "");
  if (!/^\d+(\.\d{1,2})?$/.test(v)) throw new ValidationError("Enter the invoice amount as dollars and cents, e.g. 350.00.");
  return Math.round(Number(v) * 100);
}

function inputFrom(fd: FormData): FirmInvoiceInput {
  return {
    clientId: str(fd, "clientId"),
    service: str(fd, "service"),
    amountCents: cents(str(fd, "amount")),
    description: str(fd, "description"),
    issueDate: str(fd, "issueDate"),
    dueDate: str(fd, "dueDate"),
    privateNote: str(fd, "privateNote"),
    offeredMethods: fd.getAll("method").map(String),
    squarePaymentUrl: str(fd, "squarePaymentUrl"),
  };
}

/** Create or edit a draft; "submit" also hands it to the owner for approval. */
export async function saveFirmInvoiceAction(invoiceId: string | null, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  let id = invoiceId;
  const result = await run(async () => {
    const input = inputFrom(fd);
    if (invoiceId) await updateFirmInvoice(actor, invoiceId, input);
    else id = (await createFirmInvoice(actor, input)).id;
    if (str(fd, "intent") === "submit") await submitForApproval(actor, id!);
  });
  if (result?.ok) redirect(`/owner/invoices/${id}`);
  // A draft saved before the submit step failed: open it so the work isn't lost.
  if (!invoiceId && id) redirect(`/owner/invoices/${id}`);
  return result;
}

export async function submitInvoiceAction(invoiceId: string, _prev: ActionState): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    await submitForApproval(actor, invoiceId);
    revalidatePath(`/owner/invoices/${invoiceId}`);
    return "Submitted for the owner's approval.";
  });
}

export async function approveInvoiceAction(invoiceId: string, _prev: ActionState, fd?: FormData): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    const r = await approveAndSend(actor, invoiceId, { viaSquare: fd?.get("viaSquare") === "on" });
    revalidatePath(`/owner/invoices/${invoiceId}`);
    if (r.squareProblem) return `Approved and sent to the client's portal. Square: ${r.squareProblem}`;
    return r.squareUrl ? "Approved, sent to the client's portal and sent through Square." : "Approved and sent to the client's portal.";
  });
}

export async function returnInvoiceAction(invoiceId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    await returnToDraft(actor, invoiceId, str(fd, "note"));
    revalidatePath(`/owner/invoices/${invoiceId}`);
    return "Returned to draft.";
  });
}

export async function adjustInvoiceAction(invoiceId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    const raw = str(fd, "amount").replace(/[$,\s]/g, "");
    if (!/^\d+(\.\d{1,2})?$/.test(raw)) throw new ValidationError("Enter the adjustment as dollars and cents, e.g. 25.00.");
    await recordPayment(actor, { invoiceId, kind: "CREDIT", status: "SUCCEEDED", amountCents: Math.round(Number(raw) * 100), receivedOn: str(fd, "receivedOn"), method: "OTHER", note: str(fd, "reason"), idempotencyKey: str(fd, "idempotencyKey") || null });
    revalidatePath(`/owner/invoices/${invoiceId}`);
    return "Adjustment applied.";
  });
}

export async function squareLinksAction(enabled: boolean, _prev: ActionState): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    await setSquareLinksEnabled(actor, enabled);
    revalidatePath("/owner/settings");
    return enabled ? "Square payment links turned on." : "Square payment links turned off.";
  });
}

export async function refundFeeNoteAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    await setRefundTransferFeeNote(actor, str(fd, "note"));
    revalidatePath("/owner/settings");
    return "Saved.";
  });
}
