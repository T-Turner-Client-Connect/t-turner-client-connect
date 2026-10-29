"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import type { ContentCategory, SocialPlatform } from "@prisma/client";
import { requireUser } from "@/lib/auth/session";
import { dateOrNull, run, str, type ActionState } from "@/lib/action";
import {
  approvePost,
  approveTopic,
  archiveTopic,
  changeSchedule,
  confirmManualPost,
  createSocialPost,
  draftFromTopic,
  regenerateCaptions,
  returnToDraft,
  saveSocialDraft,
  saveTopic,
  submitForApproval,
  suggestMonth,
} from "@/lib/services/social";
import { saveUpload } from "@/lib/services/files";
import { parseHashtags } from "@/lib/social/suggest";
import { chicagoLocalToUtc } from "@/lib/tz";
import { ValidationError } from "@/lib/services/clients";

const PLATFORMS: SocialPlatform[] = ["FACEBOOK", "INSTAGRAM", "TIKTOK"];
const CATEGORIES: ContentCategory[] = ["SERVICE", "TAX_SEASON", "BOOKKEEPING_TIP", "BUSINESS_SETUP", "NONPROFIT", "OFFICE_ANNOUNCEMENT", "HOLIDAY"];
const platformsFrom = (fd: FormData) => fd.getAll("platform").map(String).filter((p): p is SocialPlatform => PLATFORMS.includes(p as SocialPlatform));

function refresh(postId?: string) {
  revalidatePath("/social", "layout");
  if (postId) revalidatePath(`/social/${postId}`);
}

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
  input: { title: string; scheduledAt: string | null; timeSuggested?: boolean; targets: { platform: SocialPlatform; caption: string; hashtags: string; mediaIds: string[] }[] },
): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    // The planned time is entered in office (Central) time.
    const when = input.scheduledAt ? chicagoLocalToUtc(input.scheduledAt) : null;
    if (input.scheduledAt && !when) throw new ValidationError("Choose a valid date and time.");
    const res = await saveSocialDraft(actor, postId, {
      title: input.title,
      scheduledAt: when,
      timeSuggested: input.timeSuggested,
      targets: input.targets.map((t) => ({ platform: t.platform, caption: t.caption, hashtags: parseHashtags(t.hashtags), mediaIds: t.mediaIds })),
    });
    refresh(postId);
    if (!res.changed) return "No changes to save.";
    return res.status === "PENDING_APPROVAL" ? "Saved. Because the content or time changed, the post is back in Awaiting approval." : "Draft saved.";
  });
}

export async function socialStepAction(postId: string, step: "submit" | "approve" | "reject" | "draft" | "regenerate", _prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    if (step === "submit") await submitForApproval(actor, postId);
    if (step === "approve") await approvePost(actor, postId, true, str(fd, "note"), fd.get("claimsVerified") === "on");
    if (step === "reject") await approvePost(actor, postId, false, str(fd, "note"));
    if (step === "draft") await returnToDraft(actor, postId);
    if (step === "regenerate") await regenerateCaptions(actor, postId);
    refresh(postId);
    return {
      submit: "Sent for approval.",
      approve: "Approved and scheduled. You'll get an in-site reminder when it's time to post — nothing posts automatically.",
      reject: "Sent back with your note.",
      draft: "Back to draft.",
      regenerate: "New wording suggested from the approved topic. Review and edit before approval.",
    }[step];
  });
}

export async function rescheduleSocialAction(postId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    const when = dateOrNull(fd, "when");
    if (!when) throw new ValidationError("Choose a date and time.");
    const res = await changeSchedule(actor, postId, when);
    refresh(postId);
    return res.changed ? "New time saved. The post is back in Awaiting approval." : "That's already the scheduled time.";
  });
}

export async function confirmManualAction(postId: string, targetId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    await confirmManualPost(actor, targetId, str(fd, "permalink"));
    refresh(postId);
    return "Marked as posted manually.";
  });
}

export async function uploadSocialMediaAction(postId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    const file = fd.get("file");
    if (!(file instanceof File) || file.size === 0) throw new ValidationError("Choose a flyer, photo or video.");
    await saveUpload(actor, { kind: "FLYER", bytes: new Uint8Array(await file.arrayBuffer()), originalName: file.name, title: str(fd, "title") });
    refresh(postId);
    return "Added to the marketing media library. Select it for each platform below.";
  });
}

export async function saveTopicAction(topicId: string | null, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    const category = str(fd, "category") as ContentCategory;
    if (!CATEGORIES.includes(category)) throw new ValidationError("Choose a category.");
    await saveTopic(actor, { category, title: str(fd, "title"), keyMessage: str(fd, "keyMessage"), callToAction: str(fd, "callToAction"), hashtags: parseHashtags(str(fd, "hashtags")), eventDate: str(fd, "eventDate") || null }, topicId ?? undefined);
    refresh();
    return actor.role === "ADMIN" ? "Topic saved. Approve it so suggestions can use it." : "Topic saved. An Admin needs to approve it before suggestions use it.";
  });
}

export async function topicStepAction(topicId: string, step: "approve" | "archive", _prev: ActionState): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    if (step === "approve") await approveTopic(actor, topicId);
    else await archiveTopic(actor, topicId);
    refresh();
    return step === "approve" ? "Approved for suggestions." : "Archived.";
  });
}

export async function draftFromTopicAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  let id = "";
  const r = await run(async () => {
    id = (await draftFromTopic(actor, str(fd, "topicId"), platformsFrom(fd))).id;
  });
  if (r?.ok) redirect(`/social/${id}`);
  return r;
}

export async function suggestMonthAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    const ids = await suggestMonth(actor, str(fd, "month"), platformsFrom(fd));
    refresh();
    return ids.length
      ? `Suggested ${ids.length} draft${ids.length === 1 ? "" : "s"}. Add media, edit, and send each for approval.`
      : "No new suggestions — every approved topic is already planned this month, or there are no approved topics yet.";
  });
}
