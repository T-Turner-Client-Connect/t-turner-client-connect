"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import type { SocialPlatform } from "@prisma/client";
import { requireUser } from "@/lib/auth/session";
import { dateOrNull, run, str, type ActionState } from "@/lib/action";
import { approvePost, confirmManualPost, createSocialPost, returnToDraft, saveSocialDraft, schedulePost, submitForApproval } from "@/lib/services/social";
import { ValidationError } from "@/lib/services/clients";

export async function createSocialAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  let id = "";
  const r = await run(async () => {
    id = (await createSocialPost(actor, str(fd, "title"))).id;
  });
  if (r?.ok) redirect(`/social/${id}`);
  return r;
}

export async function saveSocialDraftAction(
  postId: string,
  input: { title: string; scheduledAt: string | null; targets: { platform: SocialPlatform; caption: string; mediaIds: string[] }[] },
): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    const when = input.scheduledAt ? new Date(input.scheduledAt) : null;
    if (when && Number.isNaN(when.getTime())) throw new ValidationError("Choose a valid date and time.");
    await saveSocialDraft(actor, postId, { title: input.title, scheduledAt: when, targets: input.targets });
    revalidatePath(`/social/${postId}`);
    return "Draft saved.";
  });
}

export async function socialStepAction(postId: string, step: "submit" | "approve" | "reject" | "draft", _prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    if (step === "submit") await submitForApproval(actor, postId);
    if (step === "approve") await approvePost(actor, postId, true, str(fd, "note"));
    if (step === "reject") await approvePost(actor, postId, false, str(fd, "note"));
    if (step === "draft") await returnToDraft(actor, postId);
    revalidatePath(`/social/${postId}`);
    revalidatePath("/social");
    return { submit: "Sent for approval.", approve: "Approved.", reject: "Returned with changes requested.", draft: "Back to draft." }[step];
  });
}

export async function scheduleSocialAction(postId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    const when = dateOrNull(fd, "when");
    if (!when) throw new ValidationError("Choose a date and time.");
    await schedulePost(actor, postId, when);
    revalidatePath(`/social/${postId}`);
    return "Scheduled. At that time it will be marked “Requires manual posting” until direct publishing is connected.";
  });
}

export async function confirmManualAction(postId: string, targetId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    await confirmManualPost(actor, targetId, str(fd, "permalink"));
    revalidatePath(`/social/${postId}`);
    return "Recorded as posted manually.";
  });
}
