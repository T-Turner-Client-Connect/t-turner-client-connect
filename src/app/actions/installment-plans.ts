"use server";

import { revalidatePath } from "next/cache";
import { requireUser, clientIp } from "@/lib/auth/session";
import { requirePortalUser } from "@/lib/portal/session";
import { run, str, type ActionState } from "@/lib/action";
import { ValidationError } from "@/lib/services/clients";
import {
  acceptPlan, approvePlan, chooseInvoiceMethod, decideMethodChange, declinePlan, recordPlanPayment, requestPlan, saveLateFeePolicy, savePaymentInstruction, waiveFee,
} from "@/lib/services/installment-plans";

const cents = (v: string) => {
  const n = Number(v.replace(/[$,\s]/g, ""));
  if (!v.trim() || !Number.isFinite(n)) throw new ValidationError("Enter an amount in dollars and cents.");
  return Math.round(n * 100);
};
const refreshOwner = () => revalidatePath("/owner/plans");
const refreshPortal = () => revalidatePath("/client/billing");

// --- Owner ------------------------------------------------------------------------

export async function approvePlanAction(planId: string, _prev: ActionState): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    await approvePlan(actor, planId);
    refreshOwner();
    return "Approved. Nothing is charged until the client's card-on-file authorization is recorded.";
  });
}

export async function declinePlanAction(planId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    await declinePlan(actor, planId, str(fd, "reason"));
    refreshOwner();
    return "Declined.";
  });
}

export async function planPaymentAction(planId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    await recordPlanPayment(actor, planId, cents(str(fd, "amount")), str(fd, "note"));
    refreshOwner();
    return "Payment recorded.";
  });
}

export async function staffRequestPlanAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    const p = await requestPlan({ staff: actor }, { clientId: str(fd, "clientId"), title: str(fd, "title"), serviceCents: cents(str(fd, "amount")), months: Number(str(fd, "months")), card: str(fd, "card"), invoiceId: str(fd, "invoiceId") || null });
    refreshOwner();
    return `Plan prepared (${p.months} months). The client accepts it in their portal, then it comes back here for your approval.`;
  });
}

export async function methodChangeDecisionAction(changeId: string, approve: boolean, _prev: ActionState): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    await decideMethodChange(actor, changeId, approve);
    refreshOwner();
    return approve ? "Payment method changed." : "Change declined.";
  });
}

export async function lateFeePolicyAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    const cap = str(fd, "cap");
    await saveLateFeePolicy(actor, { enabled: fd.get("enabled") === "on", graceDays: Number(str(fd, "graceDays")), periodDays: Number(str(fd, "periodDays")), rateBps: Math.round(Number(str(fd, "rate")) * 100), capBps: cap ? Math.round(Number(cap) * 100) : null, reviewedNote: str(fd, "reviewedNote") });
    revalidatePath("/owner/settings");
    return "Saved.";
  });
}

export async function instructionAction(method: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    await savePaymentInstruction(actor, method, { details: str(fd, "details"), active: fd.get("active") === "on" });
    revalidatePath("/owner/settings");
    return "Saved.";
  });
}

export async function waiveFeeAction(clientId: string, planId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    await waiveFee(actor, { clientId, planId, amountCents: cents(str(fd, "amount")), reason: str(fd, "reason") });
    refreshOwner();
    return "Fee waived (logged).";
  });
}

// --- Client portal ---------------------------------------------------------------------

export async function portalRequestPlanAction(clientId: string, invoiceId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const user = await requirePortalUser();
  return run(async () => {
    await requestPlan({ portal: user }, { clientId, title: "", serviceCents: 0, months: Number(str(fd, "months")), card: str(fd, "card"), invoiceId });
    refreshPortal();
    return "Your plan is ready to review below. Accept it to send it to our office for approval.";
  });
}

export async function portalAcceptPlanAction(planId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const user = await requirePortalUser();
  return run(async () => {
    await acceptPlan(user, { planId, termsHash: str(fd, "termsHash"), agreed: fd.get("agree") === "on", name: str(fd, "name"), ip: await clientIp() });
    refreshPortal();
    return "Accepted. Our office will review your plan; nothing is charged until it's approved and you've authorized your card.";
  });
}

export async function portalChooseMethodAction(invoiceId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const user = await requirePortalUser();
  return run(async () => {
    const r = await chooseInvoiceMethod({ portal: user }, invoiceId, str(fd, "method"), str(fd, "reason"));
    refreshPortal();
    return r.pending ? "Your request to change the payment method was sent to our office for approval." : "Payment method saved.";
  });
}
