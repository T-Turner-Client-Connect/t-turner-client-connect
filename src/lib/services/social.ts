import "server-only";
import type { ContentCategory, Prisma, SocialPlatform, SocialPost, SocialPostTarget } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { audit } from "@/lib/audit";
import { assertAdmin, type Actor } from "@/lib/auth/actor";
import { validatePermalinkOrThrow } from "./social-helpers";
import { validateTarget, type MediaInfo } from "@/lib/social/rules";
import { flagClaims, nextRecommendedSlot, normalizeHashtags, suggestCaption } from "@/lib/social/suggest";
import { chicagoLocalToUtc, chicagoParts } from "@/lib/tz";
import { ValidationError } from "./clients";

/**
 * Social workflow: Draft → Awaiting approval → Approved/Scheduled → Ready to
 * publish → Posted manually (per platform). Scheduling prepares a post and
 * reminds staff; nothing is published automatically and a post is never shown
 * as published because its time passed. Any change to approved content or its
 * time sends it back to Awaiting approval. Media come only from the marketing
 * library (never client documents).
 */
const PLATFORMS: SocialPlatform[] = ["FACEBOOK", "INSTAGRAM", "TIKTOK"];
const LIVE = new Set(["POSTED_MANUALLY", "PUBLISHED"]);

type TargetInput = { platform: SocialPlatform; caption: string; hashtags?: string[]; mediaIds: string[] };
type PostWithTargets = SocialPost & { targets: SocialPostTarget[] };

async function mediaInfo(ids: string[]): Promise<MediaInfo[]> {
  if (!ids.length) return [];
  const files = await prisma.storedFile.findMany({ where: { id: { in: ids }, kind: "FLYER", archivedAt: null } });
  if (files.length !== new Set(ids).size) throw new ValidationError("Choose media from the marketing media library.");
  const byId = new Map(files.map((f) => [f.id, f]));
  return ids.map((id) => byId.get(id)!);
}

function snapshot(p: { title: string; scheduledAt: Date | null; status: string }, targets: TargetInput[]) {
  return {
    title: p.title,
    scheduledAt: p.scheduledAt?.toISOString() ?? null,
    status: p.status,
    targets: targets.map((t) => ({ platform: t.platform, caption: t.caption, hashtags: t.hashtags ?? [], mediaIds: t.mediaIds })),
  };
}

async function revision(db: Prisma.TransactionClient | typeof prisma, actorId: string, postId: string, action: string) {
  const p = await db.socialPost.findUniqueOrThrow({ where: { id: postId }, include: { targets: { orderBy: { platform: "asc" } } } });
  await db.socialPostRevision.create({ data: { postId, actorId, action, snapshot: snapshot(p, p.targets) as Prisma.InputJsonValue } });
}

async function load(postId: string): Promise<PostWithTargets> {
  const post = await prisma.socialPost.findUnique({ where: { id: postId }, include: { targets: true } });
  if (!post) throw new ValidationError("Post not found.");
  return post;
}

export async function createSocialPost(actor: Actor, title: string) {
  if (!title.trim()) throw new ValidationError("Give the post a working title.");
  const post = await prisma.socialPost.create({ data: { title: title.trim().slice(0, 150), createdById: actor.id } });
  await revision(prisma, actor.id, post.id, "created");
  await audit(prisma, { actorId: actor.id, action: "social.created", entityType: "SocialPost", entityId: post.id });
  return post;
}

const sameTarget = (a: TargetInput, b: SocialPostTarget) =>
  a.caption === b.caption && JSON.stringify(normalizeHashtags(a.hashtags ?? [])) === JSON.stringify(b.hashtags) && JSON.stringify(a.mediaIds) === JSON.stringify(b.mediaIds);

/**
 * Saves wording, hashtags, media and the planned time. Approved or scheduled
 * posts may be edited, but any real change returns them to Awaiting approval.
 * Platforms already posted are locked.
 */
export async function saveSocialDraft(actor: Actor, postId: string, input: { title: string; scheduledAt: Date | null; targets: TargetInput[]; timeSuggested?: boolean }, action = "edited") {
  const post = await load(postId);
  if (post.status === "COMPLETED" || post.status === "CANCELLED") throw new ValidationError("This post is finished and can't be edited.");
  if (!input.title.trim()) throw new ValidationError("Give the post a working title.");
  for (const t of input.targets) {
    if (!PLATFORMS.includes(t.platform)) throw new ValidationError("Unknown platform.");
    await mediaInfo(t.mediaIds);
  }
  for (const live of post.targets.filter((t) => LIVE.has(t.status))) {
    const next = input.targets.find((t) => t.platform === live.platform);
    if (!next || !sameTarget(next, live)) throw new ValidationError(`The ${live.platform.toLowerCase()} version is already posted and can't be changed or removed.`);
  }
  const timeChanged = (post.scheduledAt?.getTime() ?? null) !== (input.scheduledAt?.getTime() ?? null);
  const contentChanged =
    post.title !== input.title.trim().slice(0, 150) ||
    post.targets.length !== input.targets.length ||
    input.targets.some((t) => {
      const existing = post.targets.find((x) => x.platform === t.platform);
      return !existing || !sameTarget(t, existing);
    });
  if (!timeChanged && !contentChanged) return { changed: false, status: post.status };
  const wasApproved = post.status === "APPROVED" || post.status === "SCHEDULED";
  const status = post.status === "DRAFT" ? "DRAFT" : "PENDING_APPROVAL";
  await prisma.$transaction(async (tx) => {
    await tx.socialPost.update({
      where: { id: postId },
      data: {
        title: input.title.trim().slice(0, 150),
        scheduledAt: input.scheduledAt,
        timeSuggested: timeChanged ? !!input.timeSuggested : post.timeSuggested,
        status,
        approvedById: null,
        approvedAt: null,
        claimsVerifiedAt: null,
        claimsVerifiedById: null,
      },
    });
    await tx.socialPostTarget.deleteMany({ where: { postId, platform: { notIn: input.targets.map((t) => t.platform) }, status: { notIn: ["POSTED_MANUALLY", "PUBLISHED"] } } });
    for (const t of input.targets) {
      if (post.targets.some((x) => x.platform === t.platform && LIVE.has(x.status))) continue;
      const data = { caption: t.caption.slice(0, 70000), hashtags: normalizeHashtags(t.hashtags ?? []), mediaIds: t.mediaIds, status: "DRAFT" as const, reminderAt: null };
      await tx.socialPostTarget.upsert({ where: { postId_platform: { postId, platform: t.platform } }, update: data, create: { postId, platform: t.platform, ...data } });
    }
    await revision(tx, actor.id, postId, wasApproved ? `${action}_returned_to_awaiting_approval` : action);
  });
  return { changed: true, status };
}

export async function postProblems(postId: string) {
  const post = await prisma.socialPost.findUniqueOrThrow({ where: { id: postId }, include: { targets: true } });
  const problems: string[] = [];
  if (!post.targets.length) problems.push("Choose at least one platform.");
  if (!post.scheduledAt) problems.push("Choose the date and time to post.");
  for (const t of post.targets) {
    const caption = t.hashtags.length ? `${t.caption}\n\n${t.hashtags.map((h) => `#${h}`).join(" ")}` : t.caption;
    problems.push(...validateTarget(t.platform, caption, await mediaInfo(t.mediaIds)));
  }
  return problems;
}

/** Wording that must be checked by a person before approval. */
export async function postClaimFlags(postId: string) {
  const post = await prisma.socialPost.findUniqueOrThrow({ where: { id: postId }, include: { targets: true } });
  const text = [post.title, ...post.targets.map((t) => `${t.caption} ${t.hashtags.join(" ")}`)].join("\n");
  return flagClaims(text);
}

export async function submitForApproval(actor: Actor, postId: string) {
  const post = await load(postId);
  if (post.status !== "DRAFT") throw new ValidationError("Only drafts can be sent for approval.");
  const problems = await postProblems(postId);
  if (problems.length) throw new ValidationError(problems[0]);
  await prisma.socialPost.update({ where: { id: postId }, data: { status: "PENDING_APPROVAL" } });
  await revision(prisma, actor.id, postId, "submitted");
  await audit(prisma, { actorId: actor.id, action: "social.submitted", entityType: "SocialPost", entityId: postId });
}

/**
 * Approve (→ Scheduled at the planned time) or send back with a note.
 * Flagged time-sensitive claims must be confirmed as verified first.
 */
export async function approvePost(actor: Actor, postId: string, approve: boolean, note?: string, claimsVerified = false) {
  const post = await load(postId);
  if (post.status !== "PENDING_APPROVAL") throw new ValidationError("This post isn't waiting for approval.");
  if (approve) {
    const problems = await postProblems(postId);
    if (problems.length) throw new ValidationError(problems[0]);
    const flags = await postClaimFlags(postId);
    if (flags.length && !claimsVerified) throw new ValidationError(`Verify the flagged wording before approving (${flags.length} item${flags.length === 1 ? "" : "s"}: ${flags.slice(0, 3).map((f) => `“${f.text}”`).join(", ")}).`);
    await prisma.$transaction(async (tx) => {
      const res = await tx.socialPost.updateMany({
        where: { id: postId, status: "PENDING_APPROVAL" },
        data: { status: "SCHEDULED", approvedById: actor.id, approvedAt: new Date(), approvalNote: note?.trim() || null, ...(flags.length ? { claimsVerifiedAt: new Date(), claimsVerifiedById: actor.id } : {}) },
      });
      if (res.count !== 1) throw new ValidationError("This post was just changed. Refresh and review it again.");
      await tx.socialPostTarget.updateMany({ where: { postId, status: { notIn: ["POSTED_MANUALLY", "PUBLISHED"] } }, data: { status: "SCHEDULED", publishMode: "MANUAL", reminderAt: null } });
      await revision(tx, actor.id, postId, flags.length ? "approved_claims_verified" : "approved");
    });
  } else {
    await prisma.socialPost.update({ where: { id: postId }, data: { status: "DRAFT", approvalNote: note?.trim() || "Changes requested" } });
    await revision(prisma, actor.id, postId, "changes_requested");
  }
  await audit(prisma, { actorId: actor.id, action: approve ? "social.approved" : "social.changes_requested", entityType: "SocialPost", entityId: postId });
}

/** Moving a scheduled time is a change: the post goes back to Awaiting approval. */
export async function changeSchedule(actor: Actor, postId: string, when: Date) {
  const post = await load(postId);
  if (when.getTime() < Date.now() - 60_000) throw new ValidationError("Choose a time in the future.");
  return saveSocialDraft(
    actor,
    postId,
    { title: post.title, scheduledAt: when, targets: post.targets.map((t) => ({ platform: t.platform, caption: t.caption, hashtags: t.hashtags, mediaIds: t.mediaIds })) },
    "rescheduled",
  );
}

/** Legacy step for posts approved before approval included the time. */
export async function schedulePost(actor: Actor, postId: string, when: Date) {
  const post = await load(postId);
  if (post.status !== "APPROVED") throw new ValidationError("Only approved posts can be scheduled.");
  if (post.scheduledAt && post.scheduledAt.getTime() !== when.getTime()) return changeSchedule(actor, postId, when);
  await prisma.$transaction(async (tx) => {
    await tx.socialPost.update({ where: { id: postId }, data: { status: "SCHEDULED", scheduledAt: when } });
    await tx.socialPostTarget.updateMany({ where: { postId, status: { notIn: ["POSTED_MANUALLY", "PUBLISHED"] } }, data: { status: "SCHEDULED", publishMode: "MANUAL" } });
    await revision(tx, actor.id, postId, "scheduled");
  });
}

export async function returnToDraft(actor: Actor, postId: string) {
  const post = await load(postId);
  if (post.targets.some((t) => LIVE.has(t.status))) throw new ValidationError("Part of this post is already live.");
  await prisma.$transaction([
    prisma.socialPost.update({ where: { id: postId }, data: { status: "DRAFT", approvedById: null, approvedAt: null, claimsVerifiedAt: null, claimsVerifiedById: null } }),
    prisma.socialPostTarget.updateMany({ where: { postId }, data: { status: "DRAFT", reminderAt: null } }),
  ]);
  await revision(prisma, actor.id, postId, "returned_to_draft");
}

/**
 * Due scheduled platforms become "Ready to publish" with a one-time reminder
 * (reminderAt). Safe to run on every page load or cron: each platform is
 * claimed exactly once.
 */
export async function markDueManualTargets(now = new Date()) {
  const res = await prisma.socialPostTarget.updateMany({
    where: { status: "SCHEDULED", publishMode: "MANUAL", reminderAt: null, post: { status: "SCHEDULED", scheduledAt: { lte: now } } },
    data: { status: "REQUIRES_MANUAL_POSTING", reminderAt: now },
  });
  return res.count;
}

/** Platforms waiting to be posted by hand — the in-site reminder list. */
export async function readyToPublish() {
  await markDueManualTargets();
  return prisma.socialPostTarget.findMany({
    where: { status: "REQUIRES_MANUAL_POSTING" },
    include: { post: { select: { id: true, title: true, scheduledAt: true } } },
    orderBy: { reminderAt: "asc" },
    take: 50,
  });
}

/** Staff confirm they posted one platform by hand; the post link is optional. */
export async function confirmManualPost(actor: Actor, targetId: string, permalink: string) {
  const t = await prisma.socialPostTarget.findUniqueOrThrow({ where: { id: targetId } });
  if (t.status !== "REQUIRES_MANUAL_POSTING" && t.status !== "SCHEDULED") throw new ValidationError("This isn't waiting to be posted.");
  const link = permalink.trim();
  if (link) validatePermalinkOrThrow(t.platform, link);
  const res = await prisma.socialPostTarget.updateMany({
    where: { id: targetId, status: { in: ["REQUIRES_MANUAL_POSTING", "SCHEDULED"] } },
    data: { status: "POSTED_MANUALLY", permalink: link || null, publishedAt: new Date(), confirmedById: actor.id },
  });
  if (res.count !== 1) throw new ValidationError("Already recorded.");
  const remaining = await prisma.socialPostTarget.count({ where: { postId: t.postId, status: { notIn: ["POSTED_MANUALLY", "PUBLISHED", "CANCELLED"] } } });
  if (!remaining) await prisma.socialPost.update({ where: { id: t.postId }, data: { status: "COMPLETED" } });
  await revision(prisma, actor.id, t.postId, `posted_manually_${t.platform.toLowerCase()}`);
  await audit(prisma, { actorId: actor.id, action: "social.manual_post_confirmed", entityType: "SocialPostTarget", entityId: targetId, details: { platform: t.platform } });
}

// ---------------------------------------------------------------------------
// Content topics and suggestions
// ---------------------------------------------------------------------------

export type TopicInput = { category: ContentCategory; title: string; keyMessage: string; callToAction?: string | null; hashtags: string[]; eventDate?: string | null };

/** Anyone can propose a topic; suggestions use it only after an Admin approves it. */
export async function saveTopic(actor: Actor, input: TopicInput, topicId?: string) {
  if (!input.title.trim() || !input.keyMessage.trim()) throw new ValidationError("Add a title and the approved message.");
  if ((input.category === "HOLIDAY" || input.category === "OFFICE_ANNOUNCEMENT") && !input.eventDate) throw new ValidationError("Enter the date for this holiday or announcement.");
  const data = {
    category: input.category,
    title: input.title.trim().slice(0, 120),
    keyMessage: input.keyMessage.trim().slice(0, 1500),
    callToAction: input.callToAction?.trim() || null,
    hashtags: normalizeHashtags(input.hashtags).slice(0, 15),
    eventDate: input.eventDate ? new Date(`${input.eventDate}T00:00:00.000Z`) : null,
    // Any edit needs fresh approval.
    approvedById: null,
    approvedAt: null,
  };
  const topic = topicId ? await prisma.contentTopic.update({ where: { id: topicId }, data }) : await prisma.contentTopic.create({ data: { ...data, createdById: actor.id } });
  await audit(prisma, { actorId: actor.id, action: topicId ? "social.topic_updated" : "social.topic_created", entityType: "ContentTopic", entityId: topic.id });
  return topic;
}

export async function approveTopic(actor: Actor, topicId: string) {
  assertAdmin(actor);
  await prisma.contentTopic.update({ where: { id: topicId }, data: { approvedById: actor.id, approvedAt: new Date() } });
  await audit(prisma, { actorId: actor.id, action: "social.topic_approved", entityType: "ContentTopic", entityId: topicId });
}

export async function archiveTopic(actor: Actor, topicId: string) {
  await prisma.contentTopic.update({ where: { id: topicId }, data: { archivedAt: new Date() } });
  await audit(prisma, { actorId: actor.id, action: "social.topic_archived", entityType: "ContentTopic", entityId: topicId });
}

function captionsFor(topic: Parameters<typeof suggestCaption>[0], platforms: SocialPlatform[], variant: number, keepMedia: Map<SocialPlatform, string[]>) {
  return platforms.map((platform) => ({ platform, ...suggestCaption(topic, platform, variant), mediaIds: keepMedia.get(platform) ?? [] }));
}

/** Rewrites captions/hashtags from the post's approved topic with the next wording variant. */
export async function regenerateCaptions(actor: Actor, postId: string) {
  const post = await prisma.socialPost.findUniqueOrThrow({ where: { id: postId }, include: { targets: true, topic: true } });
  if (!post.topic?.approvedAt || post.topic.archivedAt) throw new ValidationError("Regenerate works for posts made from an approved content topic.");
  const variant = post.generatorVariant + 1;
  const live = post.targets.filter((t) => LIVE.has(t.status));
  const media = new Map(post.targets.map((t) => [t.platform, t.mediaIds]));
  const fresh = captionsFor(post.topic, post.targets.filter((t) => !LIVE.has(t.status)).map((t) => t.platform), variant, media);
  const result = await saveSocialDraft(
    actor,
    postId,
    { title: post.title, scheduledAt: post.scheduledAt, timeSuggested: post.timeSuggested, targets: [...live.map((t) => ({ platform: t.platform, caption: t.caption, hashtags: t.hashtags, mediaIds: t.mediaIds })), ...fresh] },
    "regenerated",
  );
  await prisma.socialPost.update({ where: { id: postId }, data: { generatorVariant: variant } });
  return result;
}

/** Creates a draft from one approved topic at the next recommended time. */
export async function draftFromTopic(actor: Actor, topicId: string, platforms: SocialPlatform[], when?: Date | null, timeIsSuggestion = !when) {
  const topic = await prisma.contentTopic.findUnique({ where: { id: topicId } });
  if (!topic?.approvedAt || topic.archivedAt) throw new ValidationError("Choose an approved content topic.");
  if (!platforms.length) throw new ValidationError("Choose at least one platform.");
  const at = when ?? nextRecommendedSlot(platforms, new Date());
  const post = await prisma.socialPost.create({ data: { title: topic.title, createdById: actor.id, topicId, scheduledAt: at, timeSuggested: timeIsSuggestion } });
  await prisma.socialPostTarget.createMany({ data: captionsFor(topic, platforms, 0, new Map()).map((t) => ({ postId: post.id, platform: t.platform, caption: t.caption, hashtags: t.hashtags, mediaIds: [] })) });
  await revision(prisma, actor.id, post.id, "suggested_from_topic");
  return post;
}

/**
 * Suggests a month of drafts from approved topics (America/Chicago):
 * dated topics (holidays, announcements) on/just before their entered date,
 * tax-season topics only January–April, and one evergreen topic per week.
 * Skips any topic already planned that month, so running it twice is safe.
 */
export async function suggestMonth(actor: Actor, month: string, platforms: SocialPlatform[]) {
  if (!/^\d{4}-\d{2}$/.test(month)) throw new ValidationError("Choose a month.");
  if (!platforms.length) throw new ValidationError("Choose at least one platform.");
  const [y, m] = month.split("-").map(Number);
  const monthStart = chicagoLocalToUtc(`${month}-01T00:00`)!;
  const nextMonth = m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, "0")}`;
  const monthEnd = chicagoLocalToUtc(`${nextMonth}-01T00:00`)!;
  const now = new Date();
  const topics = await prisma.contentTopic.findMany({ where: { approvedAt: { not: null }, archivedAt: null }, orderBy: { createdAt: "asc" } });
  const planned = new Set((await prisma.socialPost.findMany({ where: { topicId: { not: null }, scheduledAt: { gte: monthStart, lt: monthEnd }, status: { not: "CANCELLED" } }, select: { topicId: true } })).map((p) => p.topicId));
  const created: string[] = [];
  const inMonth = (d: Date) => d >= monthStart && d < monthEnd && d > now;

  for (const t of topics.filter((t) => t.eventDate && !planned.has(t.id))) {
    const ev = t.eventDate!.toISOString().slice(0, 10);
    const lead = t.category === "OFFICE_ANNOUNCEMENT" ? 3 : 0;
    const day = new Date(Date.parse(`${ev}T12:00:00Z`) - lead * 86400_000).toISOString().slice(0, 10);
    const at = chicagoLocalToUtc(`${day}T10:00`)!;
    if (!inMonth(at)) continue;
    created.push((await draftFromTopic(actor, t.id, platforms, at, true)).id);
  }
  const evergreen = topics.filter((t) => !t.eventDate && !planned.has(t.id) && (t.category !== "TAX_SEASON" || m <= 4));
  for (let week = 0, i = 0; week < 5 && i < evergreen.length; week++) {
    const from = new Date(Math.max(monthStart.getTime() + week * 7 * 86400_000, now.getTime()));
    const at = nextRecommendedSlot(platforms, from, 0);
    if (!inMonth(at) || chicagoParts(at).month !== m) continue;
    created.push((await draftFromTopic(actor, evergreen[i++].id, platforms, at, true)).id);
  }
  await audit(prisma, { actorId: actor.id, action: "social.month_suggested", entityType: "SocialPost", details: { month, count: created.length } });
  return created;
}
