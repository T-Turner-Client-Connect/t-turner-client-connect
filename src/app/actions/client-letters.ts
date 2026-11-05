"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth/session";
import { run, str, type ActionState } from "@/lib/action";
import { discardLetterBatch, LETTER_STATUS, markLetterMailed, prepareLetterBatch, resendLetter, sendLetterBatch, setLetterExcluded } from "@/lib/services/client-letters";

// Every service call re-checks that this is the owner herself (assertOwner).
const refresh = () => revalidatePath("/owner/client-letters");

export async function prepareLettersAction(_prev: ActionState): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    await prepareLetterBatch(actor);
    refresh();
    return "Letters prepared. Review them, preview any letter, exclude anyone who shouldn't get it, then send.";
  });
}

export async function excludeLetterAction(letterId: string, excluded: boolean, _prev: ActionState): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    await setLetterExcluded(actor, letterId, excluded);
    refresh();
    return excluded ? "Excluded from this batch." : "Included again.";
  });
}

export async function discardBatchAction(batchId: string, _prev: ActionState): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    await discardLetterBatch(actor, batchId);
    refresh();
    return "Prepared batch discarded. Nothing was sent.";
  });
}

export async function sendBatchAction(batchId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    const counts = await sendLetterBatch(actor, batchId, str(fd, "confirm"));
    refresh();
    const parts = Object.entries(counts).map(([k, n]) => `${n} ${LETTER_STATUS[k as keyof typeof LETTER_STATUS] ?? k}`);
    return `Batch sent: ${parts.join(" · ") || "no letters"}. Every letter was filed in the client's Documents.`;
  });
}

export async function resendLetterAction(letterId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    const r = await resendLetter(actor, letterId, str(fd, "confirm"));
    refresh();
    return `Sent again (${LETTER_STATUS[r.status]}). A new copy was filed in the client's Documents.`;
  });
}

export async function markMailedAction(letterId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    await markLetterMailed(actor, letterId, str(fd, "on"));
    refresh();
    return "Recorded as mailed / handed.";
  });
}
