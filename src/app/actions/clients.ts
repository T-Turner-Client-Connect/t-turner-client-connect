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
    middleName: str(fd, "middleName"),
    spouseFirstName: str(fd, "spouseFirstName"),
    spouseMiddleName: str(fd, "spouseMiddleName"),
    spouseLastName: str(fd, "spouseLastName"),
    spouseEmail: str(fd, "spouseEmail"),
    spousePhone: str(fd, "spousePhone"),
    preferredName: str(fd, "preferredName"),
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
    await saveContact(actor, clientId, contactId, { name: str(fd, "name"), preferredName: str(fd, "preferredName"), title: str(fd, "title"), email: str(fd, "email"), phone: str(fd, "phone") });
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

/** Explicit Admin action replacing deploy-time seeding. Never changes existing groups. */
export async function addSuggestedGroupsAction(_prev: ActionState): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    const { assertAdmin } = await import("@/lib/auth/actor");
    assertAdmin(actor);
    const { SUGGESTED_GROUPS } = await import("@/lib/data/default-groups");
    const { prisma } = await import("@/lib/prisma");
    let added = 0;
    for (const [name, description] of SUGGESTED_GROUPS) {
      const exists = await prisma.group.findFirst({ where: { name: { equals: name, mode: "insensitive" } } });
      if (!exists) {
        await prisma.group.create({ data: { name, description } });
        added++;
      }
    }
    await prisma.auditLog.create({ data: { actorId: actor.id, action: "group.suggested_added", entityType: "Group", details: { added } } });
    revalidatePath("/groups");
    return added ? `Added ${added} suggested group(s).` : "All suggested groups already exist.";
  });
}

/**
 * Staff: update a client's Communication Preferences at the client's request
 * (phone call, email, in person). The note saying how they asked is required
 * and goes into the preference history.
 */
export async function staffCommPrefsAction(clientId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    const note = str(fd, "note").trim();
    if (!note) throw new ValidationError('Say how the client asked for this (e.g. "Phone call with Avery, 11/4").');
    const contactId = str(fd, "contactId") || null;
    const { prisma } = await import("@/lib/prisma");
    if (contactId && !(await prisma.contact.count({ where: { id: contactId, clientId } }))) throw new ValidationError("Contact not found.");
    const pick = (k: string) => (str(fd, k) === "on" ? true : str(fd, k) === "off" ? false : undefined);
    const changes = { promoSms: pick("promoSms"), promoEmail: pick("promoEmail"), generalUpdates: pick("generalUpdates") };
    if (Object.values(changes).every((v) => v === undefined)) throw new ValidationError("Choose at least one change.");
    const { setCommunicationPreferences } = await import("@/lib/services/comm-prefs");
    const r = await setCommunicationPreferences({ targets: [{ clientId, contactId }], changes, source: "STAFF", actorId: actor.id, note });
    revalidatePath(`/clients/${clientId}`);
    return r.changed.length ? "Communication preferences updated and logged." : "Nothing changed — those were already the client's choices.";
  });
}
