"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth/session";
import { run, str, type ActionState } from "@/lib/action";
import { SquareError } from "@/lib/square";
import { ValidationError } from "@/lib/services/clients";
import {
  addClientToSquareBilling, linkSquareBilling, removeClientFromSquareBilling, setSquareBillingExpected, syncAllSquareBilling, syncSquareBilling, verifyExistingAuthorization,
} from "@/lib/services/square-billing";

const refresh = () => revalidatePath("/bookkeeping", "layout");
// Square's own message (never card data) is safe to show.
const square = async <T,>(fn: () => Promise<T>) => {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof SquareError) throw new ValidationError(err.message);
    throw err;
  }
};

export async function linkSquareBillingAction(customerId: string, seriesKey: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    const a = await square(() => linkSquareBilling(actor, { customerId, seriesKey, clientIds: fd.getAll("clientIds").map(String) }));
    refresh();
    return a.syncedAt ? "Linked and synced from Square. Nothing was changed or charged in Square." : `Linked, but Square couldn't be read yet: ${a.syncError ?? "try Sync now"}. Nothing was changed or charged.`;
  });
}

export async function addToSquareBillingAction(arrangementId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    await addClientToSquareBilling(actor, arrangementId, str(fd, "clientId"));
    refresh();
    return "Added to the same Square bill. It's still one charge per cycle.";
  });
}

export async function removeFromSquareBillingAction(arrangementId: string, clientId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    await removeClientFromSquareBilling(actor, arrangementId, clientId, str(fd, "reason"));
    refresh();
    return "Link removed in Client Connect. Billing in Square is unchanged.";
  });
}

export async function syncSquareBillingAction(arrangementId: string, _prev: ActionState): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    await square(() => syncSquareBilling(actor, arrangementId));
    refresh();
    return "Synced from Square (read only).";
  });
}

export async function syncAllSquareBillingAction(_prev: ActionState): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    const r = await square(() => syncAllSquareBilling(actor));
    refresh();
    return r.failed.length ? `Synced ${r.ok}; ${r.failed.length} couldn't be read: ${r.failed.slice(0, 3).join(" · ")}` : `Synced ${r.ok} Square billing link${r.ok === 1 ? "" : "s"} (read only).`;
  });
}

export async function verifySquareAuthorizationAction(arrangementId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    await verifyExistingAuthorization(actor, arrangementId, str(fd, "note"));
    refresh();
    return "Existing Square authorization verified. Nothing new was asked of the client.";
  });
}

export async function setSquareExpectedAction(clientId: string, expected: boolean, _prev: ActionState): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    await setSquareBillingExpected(actor, clientId, expected);
    refresh();
    return expected ? "Marked as billed through Square." : "Marked as not billed through Square.";
  });
}
