import "server-only";
import type { SocialPlatform } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { audit } from "@/lib/audit";
import { assertAdmin, type Actor } from "@/lib/auth/actor";
import { validatePermalinkOrThrow } from "./social-helpers";
import { validateTarget, type MediaInfo } from "@/lib/social/rules";
import { ValidationError } from "./clients";

const PLATFORMS: SocialPlatform[] = ["FACEBOOK", "INSTAGRAM", "TIKTOK"];

async function mediaInfo(ids: string[]): Promise<MediaInfo[]> {
  if (!ids.length) return [];
  const files = await prisma.storedFile.findMany({ where: { id: { in: ids }, kind: "FLYER", archivedAt: null } });
  if (files.length !== new Set(ids).size) throw new ValidationError("Choose media from the media library.");
  const byId = new Map(files.map((f) => [f.id, f]));
  return ids.map((id) => byId.get(id)!);
}

async function editable(postId: string) {
  const post = await prisma.socialPost.findUnique({ where: { id: postId } });
  if (!post) throw new ValidationError("Post not found.");
  if (post.status !== "DRAFT" && post.status !== "PENDING_APPROVAL") throw new ValidationError("Approved or scheduled posts can't be edited. Return it to draft first.");
  return post;
}

export async function createSocialPost(actor: Actor, title: string) {
  if (!title.trim()) throw new ValidationError("Give the post a working title.");
  const post = await prisma.socialPost.create({ data: { title: title.trim().slice(0, 150), createdById: actor.id } });
  await audit(prisma, { actorId: actor.id, action: "social.created", entityType: "SocialPost", entityId: post.id });
  return post;
}

/** Saves the per-platform caption and media. Platforms not listed are removed. */
export async function saveSocialDraft(
  actor: Actor,
  postId: string,
  input: { title: string; scheduledAt: Date | null; targets: { platform: SocialPlatform; caption: string; mediaIds: string[] }[] },
) {
  const post = await editable(postId);
  if (!input.title.trim()) throw new ValidationError("Give the post a working title.");
  for (const t of input.targets) {
    if (!PLATFORMS.includes(t.platform)) throw new ValidationError("Unknown platform.");
    await mediaInfo(t.mediaIds);
  }
  await prisma.$transaction(async (tx) => {
    await tx.socialPost.update({ where: { id: postId }, data: { title: input.title.trim().slice(0, 150), scheduledAt: input.scheduledAt, status: "DRAFT", approvedById: null, approvedAt: null } });
    await tx.socialPostTarget.deleteMany({ where: { postId, platform: { notIn: input.targets.map((t) => t.platform) } } });
    for (const t of input.targets) {
      await tx.socialPostTarget.upsert({
        where: { postId_platform: { postId, platform: t.platform } },
        update: { caption: t.caption.slice(0, 70000), mediaIds: t.mediaIds, status: "DRAFT" },
        create: { postId, platform: t.platform, caption: t.caption.slice(0, 70000), mediaIds: t.mediaIds },
      });
    }
  });
  if (post.status === "PENDING_APPROVAL") await audit(prisma, { actorId: actor.id, action: "social.edited_returned_to_draft", entityType: "SocialPost", entityId: postId });
}

export async function postProblems(postId: string) {
  const post = await prisma.socialPost.findUniqueOrThrow({ where: { id: postId }, include: { targets: true } });
  const problems: string[] = [];
  if (!post.targets.length) problems.push("Choose at least one platform.");
  for (const t of post.targets) problems.push(...validateTarget(t.platform, t.caption, await mediaInfo(t.mediaIds)));
  return problems;
}

export async function submitForApproval(actor: Actor, postId: string) {
  await editable(postId);
  const problems = await postProblems(postId);
  if (problems.length) throw new ValidationError(problems[0]);
  await prisma.socialPost.update({ where: { id: postId }, data: { status: "PENDING_APPROVAL" } });
  await audit(prisma, { actorId: actor.id, action: "social.submitted", entityType: "SocialPost", entityId: postId });
}

/** Admin approval. Re-validates; approval clears if the post is edited. */
export async function approvePost(actor: Actor, postId: string, approve: boolean, note?: string) {
  assertAdmin(actor);
  const post = await prisma.socialPost.findUniqueOrThrow({ where: { id: postId } });
  if (post.status !== "PENDING_APPROVAL") throw new ValidationError("This post isn't waiting for approval.");
  if (approve) {
    const problems = await postProblems(postId);
    if (problems.length) throw new ValidationError(problems[0]);
  }
  await prisma.socialPost.update({
    where: { id: postId },
    data: approve ? { status: "APPROVED", approvedById: actor.id, approvedAt: new Date(), approvalNote: note?.trim() || null } : { status: "DRAFT", approvalNote: note?.trim() || "Changes requested" },
  });
  await audit(prisma, { actorId: actor.id, action: approve ? "social.approved" : "social.changes_requested", entityType: "SocialPost", entityId: postId });
}

/** Schedules an approved post. With no connected accounts every target is manual. */
export async function schedulePost(actor: Actor, postId: string, when: Date) {
  const post = await prisma.socialPost.findUniqueOrThrow({ where: { id: postId }, include: { targets: true } });
  if (post.status !== "APPROVED") throw new ValidationError("Only approved posts can be scheduled.");
  if (when.getTime() < Date.now() - 60_000) throw new ValidationError("Choose a time in the future.");
  await prisma.$transaction([
    prisma.socialPost.update({ where: { id: postId }, data: { status: "SCHEDULED", scheduledAt: when } }),
    prisma.socialPostTarget.updateMany({ where: { postId }, data: { status: "SCHEDULED", publishMode: "MANUAL" } }),
  ]);
  await audit(prisma, { actorId: actor.id, action: "social.scheduled", entityType: "SocialPost", entityId: postId, details: { when: when.toISOString() } });
}

export async function returnToDraft(actor: Actor, postId: string) {
  const post = await prisma.socialPost.findUniqueOrThrow({ where: { id: postId }, include: { targets: true } });
  if (post.targets.some((t) => t.status === "PUBLISHED" || t.status === "POSTED_MANUALLY")) throw new ValidationError("Part of this post is already live.");
  await prisma.$transaction([
    prisma.socialPost.update({ where: { id: postId }, data: { status: "DRAFT", approvedById: null, approvedAt: null } }),
    prisma.socialPostTarget.updateMany({ where: { postId }, data: { status: "DRAFT" } }),
  ]);
  await audit(prisma, { actorId: actor.id, action: "social.returned_to_draft", entityType: "SocialPost", entityId: postId });
}

/**
 * Due scheduled targets without a connected, approved account become
 * "Requires manual posting". Safe to run repeatedly.
 */
export async function markDueManualTargets(now = new Date()) {
  const due = await prisma.socialPostTarget.findMany({ where: { status: "SCHEDULED", publishMode: "MANUAL", post: { scheduledAt: { lte: now } } }, select: { id: true } });
  if (due.length) await prisma.socialPostTarget.updateMany({ where: { id: { in: due.map((d) => d.id) }, status: "SCHEDULED" }, data: { status: "REQUIRES_MANUAL_POSTING" } });
  return due.length;
}

/** Staff confirm they posted it manually, with the link to the live post. */
export async function confirmManualPost(actor: Actor, targetId: string, permalink: string) {
  const t = await prisma.socialPostTarget.findUniqueOrThrow({ where: { id: targetId } });
  if (t.status !== "REQUIRES_MANUAL_POSTING" && t.status !== "SCHEDULED") throw new ValidationError("This isn't waiting to be posted.");
  validatePermalinkOrThrow(t.platform, permalink);
  await prisma.socialPostTarget.update({ where: { id: targetId }, data: { status: "POSTED_MANUALLY", permalink: permalink.trim(), publishedAt: new Date(), confirmedById: actor.id } });
  const remaining = await prisma.socialPostTarget.count({ where: { postId: t.postId, status: { in: ["SCHEDULED", "REQUIRES_MANUAL_POSTING", "DRAFT"] } } });
  if (!remaining) await prisma.socialPost.update({ where: { id: t.postId }, data: { status: "COMPLETED" } });
  await audit(prisma, { actorId: actor.id, action: "social.manual_post_confirmed", entityType: "SocialPostTarget", entityId: targetId, details: { platform: t.platform } });
}
