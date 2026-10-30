"use server";

import { revalidatePath } from "next/cache";
import type { DocumentCategory, DocumentVisibility, MessageChannel, PeriodStatus, PortalRole, ReportType, RequestStatus } from "@prisma/client";
import { requireUser } from "@/lib/auth/session";
import { dateOrNull, run, str, type ActionState } from "@/lib/action";
import { ValidationError } from "@/lib/services/clients";
import { acknowledgeDocuments, deleteDocument, scanQuarantined, setRetention, setVisibility, staffUploadDocument } from "@/lib/services/documents";
import { scanConfigured, scannerSelfTest } from "@/lib/scan";
import { markStaffRead, setConversationState, staffSendMessage } from "@/lib/services/messaging";
import { addDeadline, createDocumentRequest, openPeriod, postClientUpdate, publishAnnouncement, setPeriodStatus, setRequestStatus } from "@/lib/services/bookkeeping";
import { invitePortalUser, updatePortalAccess } from "@/lib/services/portal-accounts";
import { assignContract, attachContractPdf, staffVerifyContract } from "@/lib/services/contracts";
import { createSignatureRequest, recordOfflineSigned, sendSignatureRequest } from "@/lib/services/signatures";
import { resetMfa } from "@/lib/services/mfa";
import { sendTestText, updateStaffAlertSettings } from "@/lib/services/staff-alerts";
import { isTaxDocType } from "@/lib/document-types";
import { appUrl } from "@/lib/integrations";
import { prisma } from "@/lib/prisma";

const intOrNull = (v: string) => (v && /^\d+$/.test(v) ? Number(v) : null);

async function fileFrom(fd: FormData, key = "file") {
  const f = fd.get(key);
  if (!(f instanceof File) || f.size === 0) throw new ValidationError("Choose a file.");
  return { bytes: new Uint8Array(await f.arrayBuffer()), originalName: f.name };
}

const refresh = (clientId: string) => revalidatePath(`/clients/${clientId}`);

// --- Messages --------------------------------------------------------------

export async function staffMessageAction(clientId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    await staffSendMessage(actor, {
      clientId,
      conversationId: str(fd, "conversationId") || null,
      subject: str(fd, "subject"),
      body: str(fd, "body"),
      channel: (str(fd, "channel") || "PORTAL") as MessageChannel,
      attachmentIds: fd.getAll("attachmentIds").map(String),
      periodId: str(fd, "periodId") || null,
      idempotencyKey: str(fd, "idempotencyKey") || undefined,
    });
    refresh(clientId);
    revalidatePath("/inbox");
    return "Message sent.";
  });
}

export async function markReadAction(conversationId: string) {
  await requireUser();
  await markStaffRead(conversationId);
}

export async function conversationStateAction(clientId: string, conversationId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    const closed = str(fd, "closed");
    await setConversationState(actor, conversationId, { assignedToId: str(fd, "assignedToId") || null, closed: closed ? closed === "true" : undefined });
    refresh(clientId);
    revalidatePath("/inbox");
    revalidatePath("/queue");
  });
}

// --- Documents -------------------------------------------------------------

export async function uploadDocumentAction(fixedClientId: string | null, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    const clientId = fixedClientId ?? str(fd, "clientId");
    if (!clientId) throw new ValidationError("Choose a client.");
    const docType = str(fd, "docType");
    if (docType && !isTaxDocType(docType)) throw new ValidationError("Choose a valid document type.");
    if (str(fd, "category") === "IDENTITY") throw new ValidationError("Upload identity documents in the client's Identity Documents section.");
    // Tax records go into the client's yearly vault: year and type are required.
    if (str(fd, "category") === "TAXES") {
      const y = intOrNull(str(fd, "year"));
      if (!y || y < 2000 || y > new Date().getFullYear() + 1) throw new ValidationError("Enter the tax year for this tax record.");
      if (!docType) throw new ValidationError("Choose the tax document type (federal return, state return, amended return…).");
    }
    const file = await fileFrom(fd);
    const doc = await staffUploadDocument(actor, {
      clientId,
      docType: docType || null,
      category: str(fd, "category") as DocumentCategory,
      title: str(fd, "title"),
      year: intOrNull(str(fd, "year")),
      month: intOrNull(str(fd, "month")),
      visibility: (str(fd, "visibility") || "STAFF_ONLY") as DocumentVisibility,
      reportType: (str(fd, "reportType") || null) as ReportType | null,
      periodId: str(fd, "periodId") || null,
      ...file,
    });
    refresh(clientId);
    revalidatePath("/documents");
    return doc.scanStatus === "CLEAN"
      ? `Uploaded and scanned clean${doc.visibility === "PUBLISHED" ? " — now visible in the client's portal" : ""}.`
      : doc.scanStatus === "NOT_SCANNED"
        ? "Uploaded, but quarantined: malware scanning isn't set up on this site yet, so no one can download it and clients won't see it until a scanner is connected and the file passes."
        : "Uploaded. The file is quarantined until the malware scan finishes (re-checked automatically every 10 minutes) — no one can download it and clients won't see it until it passes.";
  });
}

export async function setVisibilityAction(clientId: string, documentId: string, visibility: DocumentVisibility) {
  const actor = await requireUser();
  await setVisibility(actor, documentId, visibility);
  refresh(clientId);
}

export async function deleteDocumentAction(clientId: string, documentId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    await deleteDocument(actor, documentId, str(fd, "reason"));
    refresh(clientId);
    return "Document deleted.";
  });
}

export async function retentionAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    await setRetention(actor, str(fd, "category") as DocumentCategory, intOrNull(str(fd, "years")));
    revalidatePath("/settings");
    return "Retention updated.";
  });
}

// --- Bookkeeping & requests ------------------------------------------------

export async function openPeriodAction(clientId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    await openPeriod(actor, clientId, Number(str(fd, "year")), Number(str(fd, "month")));
    refresh(clientId);
    return "Month opened.";
  });
}

export async function periodStatusAction(clientId: string, periodId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    await setPeriodStatus(actor, periodId, str(fd, "status") as PeriodStatus, str(fd, "staffNote"));
    refresh(clientId);
    revalidatePath("/queue");
    return "Status updated.";
  });
}

export async function requestDocumentAction(clientId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    await createDocumentRequest(actor, {
      clientId,
      title: str(fd, "title"),
      instructions: str(fd, "instructions"),
      dueAt: dateOrNull(fd, "dueAt"),
      remindAt: dateOrNull(fd, "remindAt"),
      periodId: str(fd, "periodId") || null,
    });
    refresh(clientId);
    return "Request sent to the client's portal.";
  });
}

export async function requestStatusAction(clientId: string, requestId: string, status: RequestStatus) {
  const actor = await requireUser();
  await setRequestStatus(actor, requestId, status);
  refresh(clientId);
  revalidatePath("/queue");
}

// --- Portal access, updates, deadlines -----------------------------------

export async function invitePortalAction(clientId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    const res = await invitePortalUser(actor, clientId, {
      email: str(fd, "email"),
      name: str(fd, "name"),
      role: (str(fd, "role") || "OWNER") as PortalRole,
      contactId: str(fd, "contactId") || null,
    });
    refresh(clientId);
    return res.grantedExisting
      ? "They already have a portal login, so this account was added to it."
      : `Portal invitation created. Send this one-time link privately (valid 7 days): ${appUrl()}/client/invite/${res.token}`;
  });
}

export async function portalAccessAction(clientId: string, accessId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    const on = (k: string) => fd.get(k) === "on";
    const revoke = str(fd, "revoke");
    await updatePortalAccess(actor, accessId, {
      canMessage: on("canMessage"),
      canUpload: on("canUpload"),
      canViewBookkeeping: on("canViewBookkeeping"),
      canViewTax: on("canViewTax"),
      canViewContracts: on("canViewContracts"),
      canViewIdentity: on("canViewIdentity"),
      ...(revoke ? { revoke: revoke === "true" } : {}),
    });
    refresh(clientId);
    return "Access updated.";
  });
}

export async function resetPortalMfaAction(clientId: string, portalUserId: string, _prev: ActionState): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    const allowed = await prisma.portalAccess.count({ where: { portalUserId, clientId } });
    if (!allowed) throw new ValidationError("Not a portal user for this client.");
    await resetMfa(actor, { kind: "portal", id: portalUserId });
    refresh(clientId);
    return "Two-step verification reset. They'll set it up again at their next sign-in.";
  });
}

export async function resetStaffMfaAction(userId: string, _prev: ActionState): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    await resetMfa(actor, { kind: "staff", id: userId });
    revalidatePath("/settings");
    return "Two-step verification reset. They'll set it up again at their next sign-in.";
  });
}

export async function clientUpdateAction(clientId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    await postClientUpdate(actor, clientId, str(fd, "title"), str(fd, "body"));
    refresh(clientId);
    return "Update posted to their portal.";
  });
}

export async function deadlineAction(clientId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    await addDeadline(actor, clientId, str(fd, "title"), dateOrNull(fd, "dueAt"), fd.get("visibleToClient") === "on");
    refresh(clientId);
    return "Deadline added.";
  });
}

export async function announcementAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    await publishAnnouncement(actor, { title: str(fd, "title"), body: str(fd, "body"), groupIds: fd.getAll("groupIds").map(String), expiresAt: dateOrNull(fd, "expiresAt") });
    revalidatePath("/announcements");
    return "Announcement published to the selected groups' portals.";
  });
}

// --- Contracts & signatures ----------------------------------------------

export async function assignContractAction(clientId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    await assignContract(actor, { clientId, title: str(fd, "title"), jotformFormId: str(fd, "formId"), dueAt: dateOrNull(fd, "dueAt") });
    refresh(clientId);
    return "Contract assigned. It now appears in their portal.";
  });
}

export async function verifyContractAction(clientId: string, assignmentId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    await staffVerifyContract(actor, assignmentId, str(fd, "submissionId"));
    refresh(clientId);
    return "Marked complete (verified by staff in Jotform).";
  });
}

export async function contractPdfAction(clientId: string, assignmentId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    await attachContractPdf(actor, assignmentId, await fileFrom(fd));
    refresh(clientId);
    return "Completed PDF saved to Contracts.";
  });
}

export async function createSignatureAction(clientId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    const signers = [0, 1, 2]
      .map((i) => ({ name: str(fd, `signer${i}Name`), email: str(fd, `signer${i}Email`), role: str(fd, `signer${i}Role`) || "TAXPAYER" }))
      .filter((s) => s.name.trim());
    await createSignatureRequest(actor, { clientId, title: str(fd, "title"), taxYear: intOrNull(str(fd, "taxYear")), packageDocumentId: str(fd, "packageDocumentId"), signers });
    refresh(clientId);
    return "Signature request saved as a draft.";
  });
}

export async function sendSignatureAction(clientId: string, requestId: string, _prev: ActionState): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    await sendSignatureRequest(actor, requestId);
    refresh(clientId);
  });
}

export async function offlineSignedAction(clientId: string, requestId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    await recordOfflineSigned(actor, requestId, await fileFrom(fd), fd.get("publish") === "on");
    refresh(clientId);
    return "Signed copy recorded (signed outside the app).";
  });
}

export async function staffAlertSettingsAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    await updateStaffAlertSettings(actor, {
      smsEnabled: fd.get("smsEnabled") === "on",
      phone: str(fd, "phone"),
      windowStart: str(fd, "windowStart"),
      windowEnd: str(fd, "windowEnd"),
      emailEnabled: fd.get("emailEnabled") === "on",
      email: str(fd, "email"),
    });
    revalidatePath("/settings");
    return "Staff alert settings saved.";
  });
}

export async function sendTestTextAction(_prev: ActionState): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    await sendTestText(actor);
    revalidatePath("/settings");
    return "Twilio accepted the test text. Its delivery result and your reply will appear below — refresh in a minute.";
  });
}

export async function acknowledgeDocumentsAction(clientId: string, documentId: string | null, _prev: ActionState): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    const n = await acknowledgeDocuments(actor, clientId, documentId ? [documentId] : undefined);
    refresh(clientId);
    revalidatePath("/documents");
    return n ? `Marked ${n} document${n === 1 ? "" : "s"} reviewed.` : "Nothing waiting for review.";
  });
}

export async function scanNowAction(_prev: ActionState): Promise<ActionState> {
  await requireUser();
  return run(async () => {
    if (!scanConfigured()) throw new ValidationError("No malware scanner is configured yet, so quarantined files can't be released.");
    const r = await scanQuarantined(50);
    revalidatePath("/documents");
    return `Scanned ${r.scanned}: ${r.clean} passed and were released, ${r.infected} infected and destroyed${r.scanned - r.clean - r.infected ? `, ${r.scanned - r.clean - r.infected} still pending (scanner didn't answer)` : ""}.`;
  });
}

export async function scannerSelfTestAction(_prev: ActionState): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    if (actor.role !== "ADMIN") throw new ValidationError("Only an Admin can run the scanner self-test.");
    const r = await scannerSelfTest();
    await prisma.scannerCheck.create({ data: { provider: r.provider, eicarResult: r.eicar, cleanResult: r.clean, ok: r.ok, runById: actor.id } });
    revalidatePath("/documents");
    if (!r.ok) throw new ValidationError(`Self-test failed: the EICAR test file came back ${r.eicar} (should be INFECTED) and the clean file came back ${r.clean} (should be CLEAN). Files stay quarantined.`);
    return "Self-test passed: the scanner caught the EICAR test file and passed the clean file.";
  });
}
