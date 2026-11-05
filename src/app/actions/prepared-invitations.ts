"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import type { PortalRole } from "@prisma/client";
import { requireUser } from "@/lib/auth/session";
import { run, str, type ActionState } from "@/lib/action";
import { ValidationError } from "@/lib/services/clients";
import { INVITE_PERMISSION_FLAGS } from "@/lib/portal/invite-permissions";
import { setOwnerSwitch } from "@/lib/services/owner-switches";
import {
  addClientsToBatch,
  approveInviteRows,
  confirmSharedEmail,
  createInviteBatch,
  editInviteRow,
  removeInviteRow,
  sendInviteBatch,
  unapproveInviteRow,
} from "@/lib/services/prepared-invitations";

const BASE = "/clients/invitations";
const ids = (fd: FormData, key: string) => fd.getAll(key).filter((v): v is string => typeof v === "string" && !!v);

/** Prepare: the checked clients go into a new draft batch, or into the chosen draft batch. */
export async function prepareInvitationsAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  let target = "";
  const res = await run(async () => {
    const clientIds = ids(fd, "clientIds");
    if (!clientIds.length) throw new ValidationError("Tick at least one client.");
    const into = str(fd, "batchId");
    if (into) {
      const r = await addClientsToBatch(actor, into, clientIds);
      target = `${BASE}/${into}`;
      return `${r.added} added${r.alreadyIn ? ` (${r.alreadyIn} already in this batch)` : ""}.`;
    }
    const batch = await createInviteBatch(actor, { title: str(fd, "title"), clientIds, importBatchId: str(fd, "importBatchId") || null });
    target = `${BASE}/${batch.id}`;
    return "Draft batch created.";
  });
  if (target && res?.ok) redirect(target);
  return res;
}

export async function editInviteRowAction(batchId: string, rowId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    // Only the boxes the form showed (staff who aren't Admins don't see the ID documents box).
    const shown = new Set(ids(fd, "shown"));
    const permissions = Object.fromEntries(INVITE_PERMISSION_FLAGS.filter((f) => shown.has(f)).map((f) => [f, fd.get(f) === "on"]));
    const { changed } = await editInviteRow(actor, rowId, { inviteeName: str(fd, "inviteeName"), email: str(fd, "email"), role: (str(fd, "role") || "OWNER") as PortalRole, permissions });
    revalidatePath(`${BASE}/${batchId}`);
    return changed.length ? "Saved. This row needs Tabitha's approval again." : "No changes.";
  });
}

export async function removeInviteRowAction(batchId: string, rowId: string, _prev: ActionState): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    await removeInviteRow(actor, rowId);
    revalidatePath(`${BASE}/${batchId}`);
    return "Removed from the batch.";
  });
}

export async function confirmSharedEmailAction(batchId: string, rowId: string, _prev: ActionState): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    await confirmSharedEmail(actor, rowId);
    revalidatePath(`${BASE}/${batchId}`);
    return "Recorded: this address belongs to the same person.";
  });
}

export async function approveInviteRowsAction(batchId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    const all = str(fd, "scope") === "all";
    const r = await approveInviteRows(actor, batchId, all ? "ALL" : { rowIds: ids(fd, "rowIds") });
    revalidatePath(`${BASE}/${batchId}`);
    return `Approved ${r.approved}.${r.blocked.length ? ` Not approved (fix or remove first): ${r.blocked.length}.` : ""} Nothing has been sent.`;
  });
}

export async function unapproveInviteRowAction(batchId: string, rowId: string, _prev: ActionState): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    await unapproveInviteRow(actor, rowId);
    revalidatePath(`${BASE}/${batchId}`);
    return "Approval removed.";
  });
}

export async function sendInviteBatchAction(batchId: string, _prev: ActionState): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    const t = await sendInviteBatch(actor, batchId);
    revalidatePath(`${BASE}/${batchId}`);
    const parts = [`${t.SENT} sent (accepted by the email provider)`, t.EMAIL_FAILED && `${t.EMAIL_FAILED} email failed`, t.ACCESS_ADDED && `${t.ACCESS_ADDED} added to an existing login`, t.SKIPPED && `${t.SKIPPED} skipped`, t.NO_EMAIL && `${t.NO_EMAIL} with no email`].filter(Boolean);
    return `${parts.join(", ")}. Delivery shows below when Resend reports it.`;
  });
}

/** Tabitha's "Portal invitations authorized" switch (owner only; enforced and audited in the service). */
export async function portalInvitesSwitchAction(on: boolean, back: string, _prev: ActionState): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    await setOwnerSwitch(actor, "portalInvites", on);
    revalidatePath(back.startsWith(BASE) ? back : BASE);
    return on ? "Portal invitations authorized. Approved invitations can now be sent." : "Portal invitations are on hold. Nothing will be sent until you authorize them again.";
  });
}
