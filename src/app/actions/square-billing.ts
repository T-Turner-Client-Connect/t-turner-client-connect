"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth/session";
import { run, str, type ActionState } from "@/lib/action";
import { SquareError } from "@/lib/square";
import { paymentStatus, scheduleText } from "@/lib/services/square-billing";
import { ValidationError } from "@/lib/services/clients";
import { noteSquareAuthFailure, runSquareHealthCheck } from "@/lib/services/square-health";
import {
  addClientToSquareBilling, linkSquareBilling, lookupSquareBilling, reviewSquareSeries, suggestSquareMatches, removeClientFromSquareBilling, setSquareBillingExpected, syncAllSquareBilling, syncClientSquareBilling, syncSquareBilling, verifyExistingAuthorization,
} from "@/lib/services/square-billing";

const refresh = () => revalidatePath("/bookkeeping", "layout");
// Square's own message (never card data) is safe to show.
const square = async <T,>(fn: () => Promise<T>) => {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof SquareError) {
      await noteSquareAuthFailure(err.status, err.code);
      throw new ValidationError(err.message);
    }
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

export async function syncClientSquareBillingAction(clientId: string, _prev: ActionState): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    const n = await square(() => syncClientSquareBilling(actor, clientId));
    refresh();
    return `Synced ${n} Square series from Square (read only). Nothing was changed or charged.`;
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

type OtherSeries = { seriesKey: string; title: string | null; amountCents: number | null; schedule: string; lastDueDate: string | null; reason: string; decision: { decision: string; reason: string; decidedAt: string } | null; matched: boolean };
export type SquareSearchResult = {
  id: string;
  name: string | null;
  company: string | null;
  email: string | null;
  phone: string | null;
  // Not offered for linking: series waiting for the owner's review, and series ended (history only).
  review: OtherSeries[];
  ended: OtherSeries[];
  series: { seriesKey: string; title: string | null; amountCents: number | null; matched: boolean; schedule: string; cadence: string; dueDay: number | null; lastPaidDate: string | null; lastPaidCents: number | null; nextDueDate: string | null; autopay: boolean; status: string; statusTone: string; linkedTo: string[] }[];
};

/** In-card Square search (read only): by name, email, phone, Square customer ID or recurring series number. Never creates or changes anything in Square. */
type Found = Awaited<ReturnType<typeof lookupSquareBilling>>[number];
const serialize = (c: Found): SquareSearchResult => ({
  id: c.id,
  name: c.name,
  company: c.company,
  email: c.email,
  phone: c.phone,
  series: c.series.map((x) => ({
    seriesKey: x.seriesKey,
    title: x.title ?? null,
    amountCents: x.amountCents,
    matched: x.matched,
    schedule: scheduleText(x),
    cadence: x.cadence,
    dueDay: x.dueDay,
    lastPaidDate: x.lastPaidDueDate ? new Date(x.lastPaidDueDate).toISOString().slice(0, 10) : null,
    lastPaidCents: x.lastPaidCents,
    nextDueDate: x.nextDueDate ? new Date(x.nextDueDate).toISOString().slice(0, 10) : null,
    autopay: !!x.autopay,
    status: paymentStatus(x).label,
    statusTone: paymentStatus(x).tone,
    linkedTo: x.linked ? x.linked.members.map((m) => m.client.businessName || m.client.displayName) : [],
  })),
  review: c.review.map(other),
  ended: c.ended.map(other),
});
function other(x: Found["ended"][number]): OtherSeries {
  return {
    seriesKey: x.seriesKey, title: x.title ?? null, amountCents: x.amountCents, schedule: scheduleText({ cadence: x.cadence, dueDay: null }),
    lastDueDate: x.lastDueDate ? new Date(x.lastDueDate).toISOString().slice(0, 10) : null, reason: x.reason,
    decision: x.decision ? { decision: x.decision.decision, reason: x.decision.reason, decidedAt: new Date(x.decision.decidedAt).toISOString().slice(0, 10) } : null, matched: x.matched,
  };
}

async function squareRead<T>(fn: () => Promise<T>): Promise<T | { error: string }> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof SquareError) {
      await noteSquareAuthFailure(err.status, err.code);
      return { error: err.message };
    }
    if (err instanceof ValidationError) return { error: err.message };
    if (err instanceof Error && err.name === "ForbiddenError") return { error: err.message };
    return { error: "Square couldn't be searched right now. Nothing was changed — please try again." };
  }
}

/** In-card Square search (read only): by name, email, phone, Square customer ID or recurring series number. Never creates or changes anything in Square. */
export async function squareSearchAction(query: string): Promise<{ error?: string; results?: SquareSearchResult[] }> {
  const actor = await requireUser();
  const r = await squareRead(() => lookupSquareBilling(actor, { query }));
  return "error" in r ? r : { results: r.map(serialize) };
}

/** Runs automatically when an unlinked client's billing card opens: suggestions from the client's saved details (read only). */
export async function squareSuggestAction(clientId: string): Promise<{ error?: string; results?: (SquareSearchResult & { score: number; reasons: string[] })[]; confident?: string | null; searched?: number }> {
  const actor = await requireUser();
  const r = await squareRead(() => suggestSquareMatches(actor, clientId));
  if ("error" in r) return r;
  return { results: r.results.map((c) => ({ ...serialize(c), ...r.scores[c.id] })), confident: r.confident, searched: r.searched.length };
}

/** Live, read-only check that Square accepts the token and every read Client Connect needs. */
export async function checkSquareConnectionAction(_prev: ActionState): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    const r = await runSquareHealthCheck(actor);
    refresh();
    revalidatePath("/bookkeeping/square-billing");
    return r.summary;
  });
}

/** Owner only: settle a series Square's invoices can't (Active or Ended), with a reason. Changes nothing in Square. */
export async function reviewSquareSeriesAction(customerId: string, seriesKey: string, decision: "ACTIVE" | "ENDED", _prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    const r = await square(() => reviewSquareSeries(actor, { customerId, seriesKey, decision, reason: str(fd, "reason") }));
    refresh();
    return r.status === "ACTIVE" ? `Series ${seriesKey} marked active. It can now be linked.` : `Series ${seriesKey} marked ended — kept as history, out of current billing. Nothing was changed in Square.`;
  });
}
