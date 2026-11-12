"use server";
import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth/session";
import { run, str, type ActionState } from "@/lib/action";
import { addBusinessTax, addSuggestedTaxes, recordTaxFiling, removeBusinessTax, undoTaxFiling, updateBusinessTax } from "@/lib/services/business-taxes";

const refresh = () => revalidatePath("/bookkeeping", "layout");

export async function addSuggestedTaxesAction(clientId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    const keys = fd.getAll("kind").map(String);
    if (!keys.length) return "Check at least one item to add.";
    const added = await addSuggestedTaxes(actor, clientId, keys);
    refresh();
    return `Added ${added.length} item${added.length === 1 ? "" : "s"}. Check each schedule and add the account numbers.`;
  });
}

export async function addBusinessTaxAction(clientId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    const r = await addBusinessTax(actor, clientId, { kind: str(fd, "kind") || "OTHER", name: str(fd, "name"), agency: str(fd, "agency"), accountNumber: str(fd, "accountNumber"), frequency: str(fd, "frequency"), dueDay: str(fd, "dueDay"), dueMonth: str(fd, "dueMonth"), trackFrom: str(fd, "trackFrom"), note: str(fd, "note") });
    refresh();
    return r.license ? `${r.name} added to the licenses.` : `${r.name} added.`;
  });
}

export async function updateBusinessTaxAction(id: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    await updateBusinessTax(actor, id, { name: str(fd, "name"), agency: str(fd, "agency"), accountNumber: str(fd, "accountNumber"), frequency: str(fd, "frequency"), dueDay: str(fd, "dueDay"), dueMonth: str(fd, "dueMonth"), trackFrom: str(fd, "trackFrom"), note: str(fd, "note") });
    refresh();
    return "Saved.";
  });
}

export async function removeBusinessTaxAction(id: string, _prev: ActionState, _fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    await removeBusinessTax(actor, id);
    refresh();
    return "Removed (kept in the history).";
  });
}

export async function recordTaxFilingAction(id: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    await recordTaxFiling(actor, id, { period: str(fd, "period"), status: str(fd, "status"), amount: str(fd, "amount"), confirmation: str(fd, "confirmation"), filedOn: str(fd, "filedOn"), note: str(fd, "note") });
    refresh();
    return str(fd, "status") === "NOT_REQUIRED" ? "Marked not required." : "Marked filed.";
  });
}

export async function undoTaxFilingAction(filingId: string, _prev: ActionState, _fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    await undoTaxFiling(actor, filingId);
    refresh();
    return "Undone.";
  });
}
