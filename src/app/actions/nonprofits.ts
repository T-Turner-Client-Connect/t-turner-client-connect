"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth/session";
import { dateOrNull, run, str, type ActionState } from "@/lib/action";
import { correctNonprofitFiling, markNonprofitFiled, recordNonprofitOutcome, saveNonprofitProfile } from "@/lib/services/nonprofits";
import { createAndLinkNonprofit, linkExistingNonprofit, setFilingService, setHasNonprofit } from "@/lib/services/nonprofit-links";

const refresh = () => revalidatePath("/nonprofits");

export async function saveNonprofitAction(clientId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    await saveNonprofitProfile(actor, clientId, { formType: str(fd, "formType"), otherForm: str(fd, "otherForm"), formBasis: str(fd, "formBasis"), reminderDays: str(fd, "reminderDays"), notifyClient: fd.get("notifyClient") === "on" });
    refresh();
    return "Saved.";
  });
}

export async function markFiledAction(clientId: string, taxYear: number, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    await markNonprofitFiled(actor, clientId, taxYear, { filedAt: dateOrNull(fd, "filedAt"), confirmation: str(fd, "confirmation"), ackDocumentId: str(fd, "ackDocumentId") || null });
    refresh();
    return "Marked filed (submitted). It shows Accepted only after you record the IRS acknowledgment.";
  });
}

export async function outcomeAction(clientId: string, taxYear: number, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    const outcome = str(fd, "outcome") === "REJECTED" ? "REJECTED" : "ACCEPTED";
    await recordNonprofitOutcome(actor, clientId, taxYear, { outcome, at: dateOrNull(fd, "at"), evidenceDocumentId: str(fd, "evidenceDocumentId") || null, note: str(fd, "note"), rejectionCodes: str(fd, "rejectionCodes") });
    refresh();
    return outcome === "ACCEPTED" ? "Accepted recorded with its evidence." : "Rejection recorded.";
  });
}

export async function correctFilingAction(clientId: string, filingId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    await correctNonprofitFiling(actor, clientId, filingId, { confirmation: str(fd, "confirmation"), reason: str(fd, "reason") });
    refresh();
    return "Correction logged.";
  });
}

// --- Nonprofits from any client record -------------------------------------

const refreshClient = (clientId: string) => {
  revalidatePath(`/clients/${clientId}`);
  refresh();
};

export async function hasNonprofitAction(clientId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    await setHasNonprofit(actor, clientId, str(fd, "hasNonprofit"));
    refreshClient(clientId);
    return "Saved.";
  });
}

export async function createNonprofitAction(clientId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    const org = await createAndLinkNonprofit(actor, clientId, { name: str(fd, "name"), email: str(fd, "email") || undefined, phone: str(fd, "phone") || undefined });
    refreshClient(clientId);
    return `${org.displayName} created as its own nonprofit record and linked.`;
  });
}

export async function linkNonprofitAction(clientId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    await linkExistingNonprofit(actor, clientId, str(fd, "orgId"));
    refreshClient(clientId);
    return "Linked.";
  });
}

export async function filingServiceAction(clientId: string, orgId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    await setFilingService(actor, orgId, str(fd, "filingService"));
    refreshClient(clientId);
    revalidatePath(`/clients/${orgId}`);
    return "Saved.";
  });
}
