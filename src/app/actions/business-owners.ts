"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth/session";
import { requirePortalUser } from "@/lib/portal/session";
import { run, str, type ActionState } from "@/lib/action";
import { appUrl } from "@/lib/integrations";
import { OWNER_FLAGS } from "@/lib/portal/owner-areas";
import { archiveBusinessOwner, inviteBusinessOwner, saveBusinessOwner, setK1Share, setOwnerPermissions, setOwnerPermissionsManager } from "@/lib/services/business-owners";
import { staffUploadDocument } from "@/lib/services/documents";
import { decidePersonalTaxRequest, requestPersonalTax } from "@/lib/services/personal-tax-requests";
import { ValidationError } from "@/lib/services/clients";

const refresh = (clientId: string) => revalidatePath(`/clients/${clientId}`);

export async function saveOwnerAction(clientId: string, ownerId: string | null, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    const res = await saveBusinessOwner(actor, clientId, ownerId, {
      name: str(fd, "name"),
      email: str(fd, "email"),
      phone: str(fd, "phone"),
      ownership: str(fd, "ownership"),
      title: str(fd, "title"),
      receivesK1: fd.get("receivesK1") === "on",
      notes: str(fd, "notes"),
    });
    refresh(clientId);
    return `${ownerId ? "Owner updated." : "Owner added."}${res.warning ? ` Note: ${res.warning}` : ""}`;
  });
}

export async function archiveOwnerAction(clientId: string, ownerId: string) {
  const actor = await requireUser();
  await archiveBusinessOwner(actor, clientId, ownerId);
  refresh(clientId);
}

export async function inviteOwnerAction(clientId: string, ownerId: string, _prev: ActionState): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    const res = await inviteBusinessOwner(actor, clientId, ownerId);
    refresh(clientId);
    return res.grantedExisting
      ? "They already have a portal login, so this business was added to it (own K-1s and Messages only)."
      : `Invitation created. Send this one-time link privately (valid 7 days): ${appUrl()}/client/invite/${res.token}`;
  });
}

export async function ownerPermissionsAction(clientId: string, ownerId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    const next = Object.fromEntries(OWNER_FLAGS.map((f) => [f, fd.get(f) === "on"]));
    const { changed } = await setOwnerPermissions(actor, clientId, ownerId, next);
    // K-1 sharing: one checkbox per other owner ("k1:<holderId>").
    const holders = fd.getAll("k1Holder").map(String);
    for (const h of holders) await setK1Share(actor, clientId, ownerId, h, fd.get(`k1:${h}`) === "on");
    refresh(clientId);
    return changed || holders.length ? "Permissions saved. They apply right away." : "No changes.";
  });
}

export async function uploadK1Action(clientId: string, ownerId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    const file = fd.get("file");
    if (!(file instanceof File) || file.size === 0) throw new ValidationError("Choose the K-1 file.");
    const year = Number(str(fd, "year")) || null;
    await staffUploadDocument(actor, {
      clientId,
      category: "OWNER_K1",
      businessOwnerId: ownerId,
      title: str(fd, "title") || `Schedule K-1${year ? ` ${year}` : ""}`,
      year,
      visibility: fd.get("publish") === "on" ? "PUBLISHED" : "STAFF_ONLY",
      bytes: new Uint8Array(await file.arrayBuffer()),
      originalName: file.name,
    });
    refresh(clientId);
    return "K-1 saved. Only this owner (and staff) can open it.";
  });
}

export async function ownerPermissionsManagerAction(userId: string, on: boolean, _prev: ActionState): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    await setOwnerPermissionsManager(actor, userId, on);
    revalidatePath("/owner/business-access");
    return on ? "They can now set business owners' portal permissions." : "Removed.";
  });
}

export async function decidePersonalTaxAction(clientId: string, requestId: string, accept: boolean, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    await decidePersonalTaxRequest(actor, requestId, { accept, existingClientId: str(fd, "existingClientId") || null });
    refresh(clientId);
    return accept ? "Accepted. Their own Personal account now has Individual tax preparation." : "Declined.";
  });
}

// --- Portal ---------------------------------------------------------------------

export async function portalRequestPersonalTaxAction(clientId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const user = await requirePortalUser();
  return run(async () => {
    await requestPersonalTax(user, clientId, str(fd, "note"));
    revalidatePath("/client", "layout");
    return "Thank you! Our office will contact you about personal tax preparation.";
  });
}
