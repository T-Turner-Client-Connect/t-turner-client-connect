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
import { checkSchedule, proposeSchedule, type ScheduleInput } from "@/lib/services/billing-schedules";
import { prisma } from "@/lib/prisma";

/** "1,234.56" or "$80" → cents. */
function cents(raw: string): number {
  const v = raw.replace(/[$,\s]/g, "");
  if (!/^\d+(\.\d{1,2})?$/.test(v)) throw new ValidationError("Enter the invoice amount as dollars and cents, e.g. 350.00.");
  return Math.round(Number(v) * 100);
}

function inputFrom(fd: FormData, amountOptional = false): FirmInvoiceInput {
  return {
    clientId: str(fd, "clientId"),
    service: str(fd, "service"),
    amountCents: amountOptional && !str(fd, "amount").trim() ? 0 : cents(str(fd, "amount")),
    description: str(fd, "description"),
    issueDate: str(fd, "issueDate"),
    dueDate: str(fd, "dueDate"),
    privateNote: str(fd, "privateNote"),
    offeredMethods: fd.getAll("method").map(String),
    squarePaymentUrl: str(fd, "squarePaymentUrl"),
  };
}

const num = (fd: FormData, k: string) => (str(fd, k).trim() ? Number(str(fd, k)) : null);

/** The "Payment type" part of Create Invoice: null for a one-time invoice. */
function scheduleFrom(fd: FormData, input: FirmInvoiceInput, origin: { requestId: string | null }): ScheduleInput | null {
  const kind = str(fd, "paymentType") || "ONE_TIME";
  if (kind === "ONE_TIME") return null;
  const total = str(fd, "planTotal");
  return {
    clientId: input.clientId,
    kind,
    service: input.service,
    description: input.description,
    amountCents: input.amountCents,
    totalCents: total ? cents(total) : null,
    installments: num(fd, "installments"),
    cadence: str(fd, "cadence") || null,
    startDate: str(fd, "startDate") || input.issueDate,
    endDate: str(fd, "endDate") || null,
    maxInvoices: num(fd, "maxInvoices"),
    invoiceDay: num(fd, "invoiceDay"),
    dueInDays: num(fd, "dueInDays"),
    balanceDate: str(fd, "balanceDate") || null,
    autoSend: fd.get("autoSend") === "on",
    offeredMethods: input.offeredMethods,
    privateNote: input.privateNote,
    requestId: origin.requestId,
    confirmDuplicate: fd.get("confirmDuplicate") === "on",
  };
}

/**
 * Create or edit a draft; "submit" also hands it to the owner for approval. With a payment type
 * other than one-time, a billing schedule is made instead: Tabitha's is active at once (its first
 * cycle is created as a draft when due); anyone else's waits for her approval and creates nothing.
 */
export async function saveFirmInvoiceAction(invoiceId: string | null, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  let id = invoiceId;
  let to: string | null = null;
  const origin = { requestId: str(fd, "requestId") || null, conversationId: str(fd, "conversationId") || null };
  const result = await run(async () => {
    const kind = str(fd, "paymentType") || "ONE_TIME";
    const input = { ...inputFrom(fd, kind === "INSTALLMENTS"), ...(kind !== "ONE_TIME" && !invoiceId ? { issueDate: str(fd, "startDate"), dueDate: str(fd, "startDate") } : {}) };
    const schedule = scheduleFrom(fd, input, origin);
    if (schedule && !invoiceId) {
      // A schedule from Create Invoice: no separate invoice; its cycles are the invoices.
      if (origin.conversationId && !origin.requestId) {
        throw new ValidationError("For an older request without details, create a one-time invoice first, then make it recurring from Edit.");
      }
      const s = await proposeSchedule(actor, schedule);
      const first = await prisma.billingScheduleItem.findFirst({ where: { scheduleId: s.id, invoiceId: { not: null } }, orderBy: { seq: "asc" }, select: { invoiceId: true } });
      to = first?.invoiceId ? `/owner/invoices/${first.invoiceId}` : `/owner/billing/schedules/${s.id}`;
      return;
    }
    if (schedule) await checkSchedule(actor, { ...schedule, firstInvoiceId: invoiceId });
    if (invoiceId) await updateFirmInvoice(actor, invoiceId, input);
    else id = (await createFirmInvoice(actor, input, origin)).id;
    if (schedule) {
      const s = await proposeSchedule(actor, { ...schedule, firstInvoiceId: id });
      to = `/owner/billing/schedules/${s.id}`;
    }
    if (str(fd, "intent") === "submit") await submitForApproval(actor, id!);
  });
  if (result?.ok) redirect(to ?? `/owner/invoices/${id}`);
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
