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
