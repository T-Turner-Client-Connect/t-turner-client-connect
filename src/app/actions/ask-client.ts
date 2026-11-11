"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth/session";
import { requirePortalUser } from "@/lib/portal/session";
import { run, str, type ActionState } from "@/lib/action";
import { addAskItem, editAskItem, portalExplainRequest, removeAskItem, sendAskItems } from "@/lib/services/ask-client";

const refresh = (clientId: string) => revalidatePath(`/bookkeeping/${clientId}/ask-client`);
const itemFrom = (fd: FormData) => ({
  title: str(fd, "title"), reason: str(fd, "reason"), instructions: str(fd, "instructions"), dueAt: str(fd, "dueAt") || null,
  bookkeepingAccountId: str(fd, "accountId") || null, start: str(fd, "start") || null, end: str(fd, "end") || null,
});

export async function addAskItemAction(clientId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    const r = await addAskItem(actor, clientId, itemFrom(fd));
    refresh(clientId);
    return r.received ? "That's already on file, so it wasn't added." : "Added to the draft list. Nothing has been sent.";
  });
}

export async function editAskItemAction(clientId: string, requestId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    await editAskItem(actor, clientId, requestId, itemFrom(fd));
    refresh(clientId);
    return "Saved.";
  });
}

export async function removeAskItemAction(clientId: string, requestId: string, _prev: ActionState, _fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    await removeAskItem(actor, clientId, requestId);
    refresh(clientId);
    return "Removed.";
  });
}

export async function sendAskItemsAction(clientId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    const n = await sendAskItems(actor, clientId, fd.getAll("ids").map(String));
    refresh(clientId);
    return `Sent ${n} request${n === 1 ? "" : "s"} to the client's portal.`;
  });
}

/** Portal: the client's written explanation for one request. */
export async function portalExplainAction(clientId: string, requestId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const user = await requirePortalUser();
  return run(async () => {
    await portalExplainRequest(user, clientId, requestId, str(fd, "explanation"));
    revalidatePath("/client", "layout");
    return "Thank you. Your explanation was sent securely to our office.";
  });
}
