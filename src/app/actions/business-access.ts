"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth/session";
import { run, str, type ActionState } from "@/lib/action";
import { ValidationError } from "@/lib/services/clients";
import {
  approveBusinessAccess,
  cancelBusinessAccessRequest,
  declineBusinessAccess,
  removeBusinessAccess,
  requestBusinessAccess,
  setConversionRequester,
} from "@/lib/services/business-access";

// Every action re-checks who is asking inside the service (owner or authorized requester).
const refresh = (clientId?: string) => {
  if (clientId) revalidatePath(`/clients/${clientId}`);
  revalidatePath("/owner/business-access");
};

export async function requestBusinessAccessAction(clientId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    await requestBusinessAccess(actor, clientId, { services: fd.getAll("services").map(String), reason: str(fd, "reason") });
    refresh(clientId);
    return "Request sent to Tabitha for approval. Nothing changes for the client until she approves.";
  });
}

export async function approveBusinessAccessAction(requestId: string, clientId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    await approveBusinessAccess(actor, requestId, str(fd, "note"));
    refresh(clientId);
    return "Approved. This business is now a Managed Business Client. Turn on the business view for each login that should see it.";
  });
}

export async function declineBusinessAccessAction(requestId: string, clientId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    await declineBusinessAccess(actor, requestId, str(fd, "note"));
    refresh(clientId);
    return "Declined. The client stays a Regular Tax Client.";
  });
}

export async function cancelBusinessAccessAction(requestId: string, clientId: string, _prev: ActionState): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    await cancelBusinessAccessRequest(actor, requestId);
    refresh(clientId);
    return "Request withdrawn.";
  });
}

export async function removeBusinessAccessAction(clientId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    if (str(fd, "confirm") !== "REMOVE") throw new ValidationError("Type REMOVE to confirm.");
    await removeBusinessAccess(actor, clientId, str(fd, "reason"));
    refresh(clientId);
    return "Business access removed. The client's logins can no longer open the Business side. All records are kept.";
  });
}

export async function setConversionRequesterAction(userId: string, on: boolean, _prev: ActionState): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    await setConversionRequester(actor, userId, on);
    refresh();
    return on ? "They can now request conversions. Only you can approve." : "They can no longer request conversions.";
  });
}
