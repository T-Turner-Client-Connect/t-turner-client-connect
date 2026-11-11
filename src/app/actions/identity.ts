"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth/session";
import { requirePortalUser } from "@/lib/portal/session";
import { run, str, type ActionState } from "@/lib/action";
import { ValidationError } from "@/lib/services/clients";
import { addPerson, assignIdentityToOwner, confirmIdentityReminderReceived, removePerson, rejectIdentityDocument, sendIdentityReminderTest, setIdentityAccessAll, uploadIdentityDocument, verifyIdentityDocument } from "@/lib/services/identity";

async function fileFrom(fd: FormData) {
  const f = fd.get("file");
  if (!(f instanceof File) || f.size === 0) throw new ValidationError("Choose a file.");
  return { bytes: new Uint8Array(await f.arrayBuffer()), originalName: f.name };
}

function uploadInput(clientId: string, fd: FormData) {
  return { clientId, personId: str(fd, "personId"), type: str(fd, "type"), expiresOn: str(fd, "expiresOn") || null, replacementReason: str(fd, "replacementReason") || null };
}

const PENDING_MSG = "Uploaded securely. It's marked Pending Verification until our team reviews it.";

export async function portalIdentityUploadAction(clientId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const user = await requirePortalUser();
  return run(async () => {
    await uploadIdentityDocument({ portal: user }, { ...uploadInput(clientId, fd), ...(await fileFrom(fd)) });
    revalidatePath("/client", "layout");
    return PENDING_MSG;
  });
}

export async function portalAddPersonAction(clientId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const user = await requirePortalUser();
  return run(async () => {
    await addPerson({ portal: user }, clientId, { role: str(fd, "role"), name: str(fd, "name") });
    revalidatePath("/client/identity");
    return "Added.";
  });
}

export async function portalRemovePersonAction(clientId: string, personId: string, _prev: ActionState): Promise<ActionState> {
  const user = await requirePortalUser();
  return run(async () => {
    await removePerson({ portal: user }, clientId, personId);
    revalidatePath("/client", "layout");
    return "Removed.";
  });
}

export async function staffRemovePersonAction(clientId: string, personId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    await removePerson({ staff: actor }, clientId, personId, str(fd, "reason"));
    revalidatePath(`/clients/${clientId}`);
    return "Removed from the list. Their documents and history are kept.";
  });
}

export async function staffIdentityUploadAction(clientId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    await uploadIdentityDocument({ staff: actor }, { ...uploadInput(clientId, fd), ...(await fileFrom(fd)) });
    revalidatePath(`/clients/${clientId}`);
    return "Uploaded. It stays Pending Verification until a staff member verifies it.";
  });
}

/** Staff: tie a business account's unassigned identity document to the owner it belongs to (audited). */
export async function assignIdentityToOwnerAction(clientId: string, id: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    if (str(fd, "confirm") !== "1") throw new ValidationError("Confirm the document belongs to this owner.");
    await assignIdentityToOwner(actor, id, str(fd, "businessOwnerId"));
    revalidatePath(`/clients/${clientId}`);
    return "Assigned. Only that owner sees it in the portal.";
  });
}

export async function staffAddPersonAction(clientId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    await addPerson({ staff: actor }, clientId, { role: str(fd, "role"), name: str(fd, "name") });
    revalidatePath(`/clients/${clientId}`);
    return "Added.";
  });
}

export async function verifyIdentityAction(clientId: string, id: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    await verifyIdentityDocument(actor, id, { expiresOn: str(fd, "expiresOn") || null, last4: str(fd, "last4") || null });
    revalidatePath(`/clients/${clientId}`);
    return "Verified.";
  });
}

export async function rejectIdentityAction(clientId: string, id: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    await rejectIdentityDocument(actor, id, str(fd, "reason"));
    revalidatePath(`/clients/${clientId}`);
    return "Declined. The client was asked to upload a new copy.";
  });
}

export async function identityAccessAction(userId: string, on: boolean, _prev: ActionState): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    await setIdentityAccessAll(actor, userId, on);
    revalidatePath("/settings");
    return on ? "Identity documents allowed for all clients (Owner's Office unchanged)." : "Limited to assigned clients.";
  });
}

export async function identityReminderTestAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    const rows = await sendIdentityReminderTest(actor, str(fd, "email"));
    revalidatePath("/settings");
    return rows.map((r) => `${r.channel === "EMAIL" ? "Email" : "Text"}: ${r.status === "SENT" ? "accepted by the provider" : r.status.toLowerCase()}${r.statusDetail ? ` (${r.statusDetail})` : ""}`).join(" · ") || "Nothing was sent.";
  });
}

export async function confirmReminderReceivedAction(channel: "EMAIL" | "SMS", _prev: ActionState): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    await confirmIdentityReminderReceived(actor, channel);
    revalidatePath("/settings");
    return "Recorded.";
  });
}

/** "Move Jotform ID documents to Identity" for one client (staff with identity access). */
export async function moveQuestionnaireIdentityAction(clientId: string, _prev: ActionState): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    const { moveQuestionnaireIdentity } = await import("@/lib/services/identity-import");
    const r = await moveQuestionnaireIdentity(actor, clientId);
    revalidatePath(`/clients/${clientId}`);
    const parts = [`${r.filed.length} filed into Identity Documents`];
    if (r.left.length) parts.push(`${r.left.length} need staff to file (${[...new Set(r.left.map((x) => x.reason))].join(" ")})`);
    if (r.unrecognized) parts.push(`${r.unrecognized} other questionnaire uploads aren't identity documents or don't say which; file any of those below`);
    return `${parts.join("; ")}.`;
  });
}

/** File one questionnaire upload into Identity by hand: what it is and whose it is. */
export async function fileQuestionnaireUploadAction(clientId: string, documentId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    const { fileQuestionnaireUploadByHand } = await import("@/lib/services/identity-import");
    const r = await fileQuestionnaireUploadByHand(actor, clientId, documentId, { type: str(fd, "type"), personId: str(fd, "personId") });
    revalidatePath(`/clients/${clientId}`);
    return `Filed: ${r.label}. It's Pending Verification.`;
  });
}

/** Optional IRS Identity Protection PIN: whether this person has one (client or staff). */
export async function portalIpPinFlagAction(clientId: string, personId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const user = await requirePortalUser();
  return run(async () => {
    const { setHasIpPin } = await import("@/lib/services/identity");
    const on = str(fd, "has") === "yes";
    await setHasIpPin({ portal: user }, clientId, personId, on);
    revalidatePath("/client", "layout");
    return on ? "Noted. Please add this year's IP PIN below." : "Noted: no IP PIN.";
  });
}

/** This year's IP PIN, saved encrypted (the portal never shows it again). */
export async function portalIpPinSaveAction(clientId: string, personId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const user = await requirePortalUser();
  return run(async () => {
    const { saveIpPin } = await import("@/lib/services/identity");
    await saveIpPin({ portal: user }, clientId, personId, str(fd, "pin"));
    revalidatePath("/client", "layout");
    return "Saved securely. Thank you.";
  });
}

export async function staffIpPinFlagAction(clientId: string, personId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    const { setHasIpPin } = await import("@/lib/services/identity");
    await setHasIpPin({ staff: actor }, clientId, personId, str(fd, "has") === "yes");
    revalidatePath(`/clients/${clientId}`);
    return "Saved.";
  });
}

export async function staffIpPinSaveAction(clientId: string, personId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    const { saveIpPin } = await import("@/lib/services/identity");
    await saveIpPin({ staff: actor }, clientId, personId, str(fd, "pin"));
    revalidatePath(`/clients/${clientId}`);
    return "IP PIN saved (encrypted).";
  });
}

/** Staff view one IP PIN to prepare the return; the view is logged. */
export async function staffIpPinRevealAction(clientId: string, personId: string, _prev: ActionState): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    const { revealIpPin } = await import("@/lib/services/identity");
    return `IP PIN: ${await revealIpPin(actor, clientId, personId)} (this view was logged)`;
  });
}
