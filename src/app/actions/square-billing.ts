"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth/session";
import { run, str, type ActionState } from "@/lib/action";
import { SquareError } from "@/lib/square";
import { paymentStatus, scheduleText } from "@/lib/services/square-billing";
import { ValidationError } from "@/lib/services/clients";
import {
  addClientToSquareBilling, linkSquareBilling, lookupSquareBilling, removeClientFromSquareBilling, setSquareBillingExpected, syncAllSquareBilling, syncSquareBilling, verifyExistingAuthorization,
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
    if (fd.get("confirmMatch") !== "on") throw new ValidationError("Confirm that this Square customer is the same client before linking.");
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

export type SquareSearchResult = {
  id: string;
  name: string | null;
  company: string | null;
  email: string | null;
  phone: string | null;
  series: { seriesKey: string; title: string | null; amountCents: number | null; schedule: string; nextDueDate: string | null; autopay: boolean; status: string; statusTone: string; linkedTo: string[] }[];
};

/** In-card Square search (read only): by name, email or phone. Never creates or changes anything in Square. */
export async function squareSearchAction(query: string): Promise<{ error?: string; results?: SquareSearchResult[] }> {
  const actor = await requireUser();
  try {
    const found = await lookupSquareBilling(actor, { query });
    return {
      results: found.map((c) => ({
        id: c.id,
        name: c.name,
        company: c.company,
        email: c.email,
        phone: c.phone,
        series: c.series.map((x) => ({
          seriesKey: x.seriesKey,
          title: x.title ?? null,
          amountCents: x.amountCents,
          schedule: scheduleText(x),
          nextDueDate: x.nextDueDate ? new Date(x.nextDueDate).toISOString().slice(0, 10) : null,
          autopay: !!x.autopay,
          status: paymentStatus(x).label,
          statusTone: paymentStatus(x).tone,
          linkedTo: x.linked ? x.linked.members.map((m) => m.client.businessName || m.client.displayName) : [],
        })),
      })),
    };
  } catch (err) {
    if (err instanceof SquareError || err instanceof ValidationError) return { error: err.message };
    if (err instanceof Error && err.name === "ForbiddenError") return { error: err.message };
    return { error: "Square couldn't be searched right now. Nothing was changed — please try again." };
  }
}
