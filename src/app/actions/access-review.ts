"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth/session";
import { run, str, type ActionState } from "@/lib/action";
import { VENDORS } from "@/lib/access-review";
import { completeAccessReview, correctAccessReview, offboardStaff, setOffboardingItemDone } from "@/lib/services/access-review";

// Every action re-checks the owner binding in the service (assertOwner): a direct POST from anyone
// else gets "Not found."

export async function completeAccessReviewAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    const vendors = Object.fromEntries(
      VENDORS.map((v) => [v.key, { appropriate: fd.get(`appropriate:${v.key}`) === "on", twoStep: fd.get(`twoStep:${v.key}`) === "on", note: str(fd, `note:${v.key}`) }]),
    );
    const review = await completeAccessReview(actor, { summary: str(fd, "summary"), findings: str(fd, "findings"), vendors });
    revalidatePath("/owner/access-review");
    revalidatePath("/tasks");
    return { ok: "Access review saved. The next one is due in 90 days.", next: { href: `/owner/access-review/reviews/${review.id}`, label: "Open the printable record" } };
  });
}

export async function offboardStaffAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    const r = await offboardStaff(actor, { userId: str(fd, "userId"), reason: str(fd, "reason"), effectiveDate: str(fd, "effectiveDate") });
    revalidatePath("/owner/access-review");
    revalidatePath("/owner/access-review/offboarding");
    revalidatePath("/settings");
    revalidatePath("/tasks");
    return `${r.userName} is offboarded: their Client Connect account is deactivated (${r.sessionsEnded} session${r.sessionsEnded === 1 ? "" : "s"} ended) and ${r.removedGrants.length} grant${r.removedGrants.length === 1 ? " was" : "s were"} removed. ${r.items} checklist tasks were added for you.`;
  });
}

export async function offboardingItemAction(itemId: string, done: boolean, _prev: ActionState): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    await setOffboardingItemDone(actor, itemId, done);
    revalidatePath("/owner/access-review/offboarding");
    revalidatePath("/tasks");
    return done ? "Marked done." : "Reopened.";
  });
}

/**
 * Saves a correction to a completed review (owner only, re-checked in the service). The form sends
 * the vendor keys printed on that review and the revision number it was opened at.
 */
export async function correctAccessReviewAction(reviewId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  const result = await run(async () => {
    const keys = fd.getAll("vendorKey").filter((k): k is string => typeof k === "string");
    const vendors = Object.fromEntries(keys.map((k) => [k, { appropriate: fd.get(`appropriate:${k}`) === "on", twoStep: fd.get(`twoStep:${k}`) === "on", note: str(fd, `note:${k}`) }]));
    const expectedRevision = Number.parseInt(str(fd, "expectedRevision"), 10);
    await correctAccessReview(actor, reviewId, { expectedRevision, reason: str(fd, "reason"), summary: str(fd, "summary"), findings: str(fd, "findings"), vendors });
    revalidatePath("/owner/access-review");
    revalidatePath(`/owner/access-review/reviews/${reviewId}`);
  });
  if (result?.ok) redirect(`/owner/access-review/reviews/${reviewId}?corrected=1`);
  return result;
}
