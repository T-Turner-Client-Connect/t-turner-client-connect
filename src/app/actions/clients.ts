"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import type { Channel, ConsentKind, ConsentStatus, SuppressionReason } from "@prisma/client";
import { requireUser } from "@/lib/auth/session";
import { dateOrNull, run, str, type ActionState } from "@/lib/action";
import {
  addNote,
  addSuppression,
  createClient,
  createGroup,
  deleteGroup,
  liftSuppression,
  recordConsent,
  removeContact,
  saveContact,
  setArchived,
  updateClient,
  ValidationError,
  type ClientInput,
} from "@/lib/services/clients";
import { saveUpload } from "@/lib/services/files";

function clientInput(fd: FormData): ClientInput {
  return {
    firstName: str(fd, "firstName"),
    lastName: str(fd, "lastName"),
    businessName: str(fd, "businessName"),
    email: str(fd, "email"),
    phone: str(fd, "phone"),
    addressLine1: str(fd, "addressLine1"),
    addressLine2: str(fd, "addressLine2"),
    city: str(fd, "city"),
    state: str(fd, "state"),
    postalCode: str(fd, "postalCode"),
    clientType: str(fd, "clientType") as ClientInput["clientType"],
    status: str(fd, "status") as ClientInput["status"],
    services: str(fd, "services"),
    tags: str(fd, "tags"),
    notes: str(fd, "notes"),
    assignedToId: str(fd, "assignedToId"),
    groupIds: fd.getAll("groupIds").map(String),
  };
}

export async function createClientAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  let id = "";
  const result = await run(async () => {
    id = (await createClient(actor, clientInput(fd))).id;
  });
  if (result?.ok) redirect(`/clients/${id}`);
  return result;
}

export async function updateClientAction(clientId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  const result = await run(async () => {
    await updateClient(actor, clientId, clientInput(fd));
  });
  if (result?.ok) redirect(`/clients/${clientId}`);
  return result;
}

export async function setArchivedAction(clientId: string, archived: boolean) {
  const actor = await requireUser();
  await setArchived(actor, clientId, archived);
  revalidatePath(`/clients/${clientId}`);
}

export async function saveContactAction(clientId: string, contactId: string | null, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    await saveContact(actor, clientId, contactId, { name: str(fd, "name"), title: str(fd, "title"), email: str(fd, "email"), phone: str(fd, "phone") });
    revalidatePath(`/clients/${clientId}`);
    return contactId ? "Contact updated." : "Contact added.";
  });
}

export async function removeContactAction(clientId: string, contactId: string) {
  const actor = await requireUser();
  await removeContact(actor, clientId, contactId);
  revalidatePath(`/clients/${clientId}`);
}

export async function addNoteAction(clientId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    await addNote(actor, clientId, str(fd, "body"));
    revalidatePath(`/clients/${clientId}`);
    return "Note added.";
  });
}

export async function recordConsentAction(clientId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    let evidenceFileId: string | null = null;
    const file = fd.get("evidence");
    if (file instanceof File && file.size > 0) {
      const stored = await saveUpload(actor, { kind: "CONSENT_EVIDENCE", bytes: new Uint8Array(await file.arrayBuffer()), originalName: file.name });
      evidenceFileId = stored.id;
    }
    await recordConsent(actor, clientId, {
      contactId: str(fd, "contactId") || null,
      kind: str(fd, "kind") as ConsentKind,
      status: str(fd, "status") as ConsentStatus,
      scope: str(fd, "scope"),
      source: str(fd, "source"),
      evidenceNote: str(fd, "evidenceNote"),
      evidenceFileId,
      effectiveAt: dateOrNull(fd, "effectiveAt"),
      expiresAt: dateOrNull(fd, "expiresAt"),
    });
    revalidatePath(`/clients/${clientId}`);
    return "Permission recorded.";
  });
}

export async function createGroupAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    await createGroup(actor, str(fd, "name"), str(fd, "description"));
    revalidatePath("/groups");
    return "Group created.";
  });
}

export async function deleteGroupAction(groupId: string, _prev: ActionState): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    await deleteGroup(actor, groupId);
    revalidatePath("/groups");
    return "Group deleted. Clients were not changed.";
  });
}

export async function addSuppressionAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    const channel = str(fd, "channel") as Channel;
    if (channel !== "EMAIL" && channel !== "SMS") throw new ValidationError("Choose email or text.");
    await addSuppression(actor, channel, str(fd, "address"), (str(fd, "reason") || "MANUAL") as SuppressionReason, str(fd, "note"));
    revalidatePath("/settings");
    return "Added to the do-not-contact list.";
  });
}

export async function liftSuppressionAction(suppressionId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    await liftSuppression(actor, suppressionId, str(fd, "note"));
    revalidatePath("/settings");
    return "Opt-out lifted.";
  });
}
