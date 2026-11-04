"use server";

import { revalidatePath } from "next/cache";
import { requirePortalUser } from "@/lib/portal/session";
import { requireUser } from "@/lib/auth/session";
import { run, str, type ActionState } from "@/lib/action";
import { ValidationError } from "@/lib/services/clients";
import { requestInvoice } from "@/lib/services/invoice-requests";
import { approveSchedule, declineSchedule, endSchedule, generateScheduleItem, pauseSchedule, resumeSchedule, updateSchedule } from "@/lib/services/billing-schedules";

/** "1,234.56" or "$80" → cents; blank → null. */
function optionalCents(raw: string, what = "amount"): number | null {
  const v = raw.replace(/[$,\s]/g, "");
  if (!v) return null;
  if (!/^\d+(\.\d{1,2})?$/.test(v)) throw new ValidationError(`Enter the ${what} as dollars and cents, e.g. 350.00.`);
  return Math.round(Number(v) * 100);
}

/** Client portal: "Pay with an Invoice" — what it's for, so the office knows who and what. */
export async function requestInvoiceAction(clientId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const user = await requirePortalUser();
  return run(async () => {
    const items = fd.getAll("item").map(String).map((v) => {
      const [kind, ...rest] = v.split("|");
      return { kind, ref: rest.join("|") || null };
    });
    const year = str(fd, "taxYear");
    await requestInvoice(user, {
      clientId,
      items,
      note: str(fd, "note"),
      taxYear: year ? Number(year) : null,
      amountCents: optionalCents(str(fd, "amount")),
      idempotencyKey: str(fd, "idempotencyKey") || null,
    });
    revalidatePath("/client/billing");
    revalidatePath("/client/messages");
    return "Request sent. Our office will create your invoice and send it to your portal.";
  });
}

const schedulePath = (id: string) => `/owner/billing/schedules/${id}`;

export async function scheduleDecisionAction(scheduleId: string, decision: "approve" | "decline" | "pause" | "resume" | "end", _prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    if (decision === "approve") await approveSchedule(actor, scheduleId);
    if (decision === "decline") await declineSchedule(actor, scheduleId, str(fd, "reason"));
    if (decision === "pause") await pauseSchedule(actor, scheduleId);
    if (decision === "resume") await resumeSchedule(actor, scheduleId);
    if (decision === "end") await endSchedule(actor, scheduleId, str(fd, "reason"));
    revalidatePath(schedulePath(scheduleId));
    revalidatePath("/owner/billing");
    return { approve: "Approved. Invoices due now were created as drafts.", decline: "Declined.", pause: "Paused. No invoices are made while it's paused.", resume: "Resumed. Paused months aren't back-billed.", end: "Ended. No more invoices will be made." }[decision];
  });
}

export async function updateScheduleAction(scheduleId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    const amount = optionalCents(str(fd, "amount"));
    const max = str(fd, "maxInvoices");
    await updateSchedule(actor, scheduleId, {
      ...(amount != null ? { amountCents: amount } : {}),
      ...(str(fd, "cadence") ? { cadence: str(fd, "cadence") } : {}),
      endDate: str(fd, "endDate") || null,
      maxInvoices: max ? Number(max) : null,
      ...(str(fd, "invoiceDay") ? { invoiceDay: Number(str(fd, "invoiceDay")) } : {}),
      ...(str(fd, "dueInDays") ? { dueInDays: Number(str(fd, "dueInDays")) } : {}),
      autoSend: fd.get("autoSend") === "on",
    });
    revalidatePath(schedulePath(scheduleId));
    return "Saved. Future invoices use these settings; invoices already made aren't changed.";
  });
}

export async function generateItemAction(scheduleId: string, periodKey: string, _prev: ActionState): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    const id = await generateScheduleItem(actor, scheduleId, periodKey);
    revalidatePath(schedulePath(scheduleId));
    return { ok: "Invoice created as a draft.", next: { href: `/owner/invoices/${id}`, label: "Open the invoice" } };
  });
}
