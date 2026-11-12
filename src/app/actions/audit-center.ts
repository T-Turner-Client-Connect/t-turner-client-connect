"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requirePortalUser } from "@/lib/portal/session";
import { requireUser } from "@/lib/auth/session";
import { run, str, type ActionState } from "@/lib/action";
import {
  addAgencyCorrespondence, addAuditItem, buildAuditPackage, splitNoticeToNewAudit, linkAuditDocument, openAuditByClient, openAuditByStaff, recordAuditSubmission, releaseAuditPackage,
  requestAuditDocument, setAuditStatus, staffUploadForAudit, unlinkAuditDocument, updateAuditDetails, updateAuditItem, uploadForAudit,
} from "@/lib/services/audit-center";

const filesOf = async (fd: FormData, name = "file") =>
  Promise.all(fd.getAll(name).filter((f): f is File => f instanceof File && f.size > 0).map(async (f) => ({ bytes: new Uint8Array(await f.arrayBuffer()), originalName: f.name })));
const openInput = (fd: FormData) => ({ kind: str(fd, "kind"), stateCode: str(fd, "stateCode"), taxYear: str(fd, "taxYear"), receivedOn: str(fd, "receivedOn"), responseDueOn: str(fd, "responseDueOn"), message: str(fd, "message") });

// --- Client portal ---------------------------------------------------------------------------------

export async function openAuditAction(clientId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const user = await requirePortalUser();
  let id = "";
  const r = await run(async () => {
    const k = await openAuditByClient(user, clientId, openInput(fd), await filesOf(fd));
    id = k.id;
    return "addedTo" in k ? "Received — added to your open audit for the same tax year." : "Received — our office has your audit notice.";
  });
  if (id) { revalidatePath("/client", "layout"); redirect(`/client/audit/${id}?account=${clientId}`); }
  return r;
}

export async function auditUploadAction(clientId: string, caseId: string, requestId: string | null, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const user = await requirePortalUser();
  return run(async () => {
    const docs = await uploadForAudit(user, clientId, caseId, requestId, await filesOf(fd));
    revalidatePath("/client", "layout");
    return `Received ${docs.length} file${docs.length === 1 ? "" : "s"}. Coetha will review ${docs.length === 1 ? "it" : "them"} for your audit.`;
  });
}

export async function auditSubmittedAction(clientId: string, caseId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const user = await requirePortalUser();
  return run(async () => {
    await recordAuditSubmission(user, clientId, caseId, { submittedOn: str(fd, "submittedOn"), method: str(fd, "method") }, await filesOf(fd));
    revalidatePath("/client", "layout");
    return "Recorded. Our office has been told you submitted your response.";
  });
}

// --- Staff -----------------------------------------------------------------------------------------

const refresh = (caseId?: string) => { revalidatePath("/notices"); if (caseId) revalidatePath(`/notices/${caseId}`); };

export async function staffOpenAuditAction(clientId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  let id = "";
  const r = await run(async () => { id = (await openAuditByStaff(actor, clientId || str(fd, "clientId"), openInput(fd), await filesOf(fd))).id; return "Audit opened."; });
  if (id) { refresh(); redirect(`/notices/${id}`); }
  return r;
}

export async function auditDetailsAction(caseId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    await updateAuditDetails(actor, caseId, { auditType: str(fd, "auditType"), noticeReference: str(fd, "noticeReference"), responseDueOn: str(fd, "responseDueOn"), respondTo: str(fd, "respondTo"), responseInstructions: str(fd, "responseInstructions") });
    refresh(caseId);
    return "Saved.";
  });
}

export async function addAuditItemAction(caseId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    await addAuditItem(actor, caseId, { label: str(fd, "label"), schedule: str(fd, "schedule"), returnLine: str(fd, "returnLine"), reported: str(fd, "reported"), requested: str(fd, "requested") });
    refresh(caseId);
    return "Item added.";
  });
}

export async function updateAuditItemAction(caseId: string, itemId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    await updateAuditItem(actor, itemId, { label: str(fd, "label"), schedule: str(fd, "schedule"), returnLine: str(fd, "returnLine"), reported: str(fd, "reported"), requested: str(fd, "requested"), explanation: str(fd, "explanation"), note: str(fd, "note") });
    refresh(caseId);
    return "Saved.";
  });
}

export async function linkAuditDocumentAction(caseId: string, itemId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    await linkAuditDocument(actor, itemId, str(fd, "documentId"), { amount: str(fd, "amount"), note: str(fd, "note") });
    refresh(caseId);
    return "Linked.";
  });
}

export async function unlinkAuditDocumentAction(caseId: string, itemId: string, documentId: string, _prev: ActionState, _fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => { await unlinkAuditDocument(actor, itemId, documentId); refresh(caseId); return "Removed from the item (the document stays in the client's files)."; });
}

export async function requestAuditDocumentAction(caseId: string, itemId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => { await requestAuditDocument(actor, itemId, { title: str(fd, "title"), instructions: str(fd, "instructions") }); refresh(caseId); return "Requested. The client sees it in their Audit section with an upload button."; });
}

export async function staffAuditUploadAction(caseId: string, itemId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    const [f] = await filesOf(fd);
    if (!f) return "Choose a file.";
    await staffUploadForAudit(actor, itemId, f, { amount: str(fd, "amount"), note: str(fd, "note") });
    refresh(caseId);
    return "Uploaded and linked.";
  });
}

export async function buildAuditPackageAction(caseId: string, _prev: ActionState, _fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    const r = await buildAuditPackage(actor, caseId);
    refresh(caseId);
    return `Package built: ${r.exhibits} exhibit${r.exhibits === 1 ? "" : "s"}${r.notIncluded.length ? `; ${r.notIncluded.length} not included (see the index)` : ""}.`;
  });
}

export async function releaseAuditPackageAction(caseId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => { await releaseAuditPackage(actor, caseId, { acknowledgeOpenItems: fd.get("acknowledgeOpenItems") === "on" }); refresh(caseId); return "Released. The client sees Audit Package — Ready to Print."; });
}

export async function splitNoticeAction(caseId: string, documentId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  let id = "";
  const r = await run(async () => { id = (await splitNoticeToNewAudit(actor, documentId, str(fd, "reason") || "A separate examination")).id; return "Moved to its own audit."; });
  if (id) { refresh(caseId); redirect(`/notices/${id}`); }
  return r;
}

export async function agencyCorrespondenceAction(caseId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => { await addAgencyCorrespondence(actor, caseId, await filesOf(fd), str(fd, "note")); refresh(caseId); return "Added to the audit."; });
}

export async function auditStatusAction(caseId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => { await setAuditStatus(actor, caseId, str(fd, "status"), str(fd, "resolution")); refresh(caseId); return "Status saved."; });
}
