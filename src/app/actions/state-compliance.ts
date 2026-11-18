"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth/session";
import { run, str, type ActionState } from "@/lib/action";
import { staffUploadDocument } from "@/lib/services/documents";
import { ValidationError } from "@/lib/services/clients";
import { addRegistration, addRequirement, completeFiling, flagFiling, markNotRequired, setFilingStatus } from "@/lib/services/state-compliance";

const refresh = (clientId: string) => { revalidatePath(`/clients/${clientId}`); revalidatePath("/owner"); };

export async function addRegistrationAction(clientId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    await addRegistration(actor, clientId, { state: str(fd, "state"), kind: str(fd, "kind"), entityId: str(fd, "entityId"), agency: str(fd, "agency"), formedOn: str(fd, "formedOn"), note: str(fd, "note") });
    refresh(clientId);
    return "Registration saved.";
  });
}

export async function addRequirementAction(clientId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    const r = await addRequirement(actor, clientId, { state: str(fd, "state"), registrationId: str(fd, "registrationId") || null, category: str(fd, "category"), name: str(fd, "name"), agency: str(fd, "agency"), filingUrl: str(fd, "filingUrl"), frequency: str(fd, "frequency"), dueMonth: Number(str(fd, "dueMonth")), dueDay: Number(str(fd, "dueDay")), startYear: Number(str(fd, "startYear")), note: str(fd, "note") });
    refresh(clientId);
    return `Tracking “${r.name}”. Each year from ${r.startYear} has its own filing below.`;
  });
}

export async function setFilingStatusAction(clientId: string, filingId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    await setFilingStatus(actor, clientId, filingId, str(fd, "status"), str(fd, "note"));
    refresh(clientId);
    return "Status saved.";
  });
}

export async function flagFilingAction(clientId: string, filingId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    await flagFiling(actor, clientId, filingId, { finalDeadline: str(fd, "finalDeadline") || undefined, urgent: fd.get("urgent") === "on", reason: str(fd, "reason") });
    refresh(clientId);
    return "Saved.";
  });
}

export async function completeFilingAction(clientId: string, filingId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    const file = fd.get("file");
    let documentId: string | null = null;
    if (file instanceof File && file.size) {
      if (file.size > 15_000_000) throw new ValidationError("That file is too large.");
      const doc = await staffUploadDocument(actor, { clientId, category: "OTHER", title: `State filing confirmation — ${str(fd, "label")}`.slice(0, 200), visibility: "STAFF_ONLY", bytes: new Uint8Array(await file.arrayBuffer()), originalName: file.name, docType: "STATE_FILING_CONFIRMATION", notify: false });
      documentId = doc.id;
    }
    await completeFiling(actor, clientId, filingId, { filedOn: str(fd, "filedOn"), confirmationNumber: str(fd, "confirmationNumber"), documentId, note: str(fd, "note") });
    refresh(clientId);
    return "Marked filed. The next period was added.";
  });
}

export async function markNotRequiredAction(clientId: string, filingId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    await markNotRequired(actor, clientId, filingId, str(fd, "reason"));
    refresh(clientId);
    return "Marked not required.";
  });
}
