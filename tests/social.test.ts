import { beforeEach, describe, expect, it } from "vitest";
import { makeUser, prisma, resetDb } from "./db";
import { validateTarget } from "@/lib/social/rules";
import {
  approvePost,
  approveTopic,
  changeSchedule,
  confirmManualPost,
  createSocialPost,
  draftFromTopic,
  markDueManualTargets,
  readyToPublish,
  regenerateCaptions,
  saveSocialDraft,
  saveTopic,
  submitForApproval,
  suggestMonth,
} from "@/lib/services/social";
import { ForbiddenError } from "@/lib/auth/actor";
import { flagClaims, nextRecommendedSlot, suggestCaption } from "@/lib/social/suggest";
import { chicagoLocalToUtc, utcToChicagoLocal } from "@/lib/tz";

beforeEach(resetDb);

const jpg = (w: number, h: number) => ({ id: "x", mimeType: "image/jpeg", sizeBytes: 200_000, width: w, height: h, title: "Flyer" });

describe("platform validation", () => {
  it("applies Instagram and TikTok rules", () => {
    expect(validateTarget("INSTAGRAM", "Hi", [])).toContain("Instagram posts need at least one image or video.");
    expect(validateTarget("INSTAGRAM", "Hi", [{ ...jpg(1080, 1080), mimeType: "image/png" }]).join()).toMatch(/JPEG/);
    expect(validateTarget("INSTAGRAM", "Hi", [jpg(1080, 2400)]).join()).toMatch(/4:5/);
    expect(validateTarget("INSTAGRAM", "Hi", [jpg(1080, 1350)])).toEqual([]);
    expect(validateTarget("TIKTOK", "Hi", []).join()).toMatch(/video or photos/);
    expect(validateTarget("FACEBOOK", "Text-only is fine on Facebook", [])).toEqual([]);
    expect(validateTarget("FACEBOOK", "x", [{ ...jpg(1, 1), mimeType: "application/pdf" }]).join()).toMatch(/PDF/);
  });
});

async function flyer(uploadedById: string, kind: "FLYER" | "CLIENT_DOCUMENT" = "FLYER") {
  return prisma.storedFile.create({
    data: { kind, storageKey: `${kind.toLowerCase()}/${Math.random()}`, originalName: "f.jpg", title: "Tax season", mimeType: "image/jpeg", sizeBytes: 300_000, width: 1080, height: 1350, uploadedById },
  });
}

describe("Central time", () => {
  it("converts office wall time to UTC across daylight saving", () => {
    expect(chicagoLocalToUtc("2026-07-01T11:30")!.toISOString()).toBe("2026-07-01T16:30:00.000Z"); // CDT −5
    expect(chicagoLocalToUtc("2026-12-01T11:30")!.toISOString()).toBe("2026-12-01T17:30:00.000Z"); // CST −6
    expect(chicagoLocalToUtc("2026-11-01T01:30")).not.toBeNull(); // repeated hour still resolves
    expect(utcToChicagoLocal(new Date("2026-03-09T00:30:00Z"))).toBe("2026-03-08T19:30");
  });

  it("recommends weekday slots in Central time, never in the past", () => {
    const after = new Date("2026-11-02T20:00:00Z"); // Monday 2pm CT
    const slot = nextRecommendedSlot(["FACEBOOK"], after);
    expect(utcToChicagoLocal(slot)).toBe("2026-11-03T11:30"); // Tuesday 11:30 CT
    expect(utcToChicagoLocal(nextRecommendedSlot(["TIKTOK"], after))).toBe("2026-11-03T18:30");
    expect(slot.getTime()).toBeGreaterThan(after.getTime());
  });
});

describe("suggestions and claim flags", () => {
  const topic = { category: "BOOKKEEPING_TIP" as const, title: "Reconcile monthly", keyMessage: "Reconcile your bank accounts every month so surprises don't pile up.", callToAction: null, hashtags: ["SmallBiz"] };

  it("builds platform captions only from the approved topic, rotating wording on regenerate", () => {
    const fb = suggestCaption(topic, "FACEBOOK", 0);
    const ig = suggestCaption(topic, "INSTAGRAM", 0);
    const tt = suggestCaption(topic, "TIKTOK", 0);
    expect(fb.caption).toContain(topic.keyMessage);
    expect(ig.hashtags).toEqual(["SmallBiz", "Bookkeeping", "SmallBusinessTips"]);
    expect(suggestCaption({ ...topic, hashtags: ["A", "B", "C", "D"] }, "FACEBOOK", 0).hashtags).toHaveLength(3);
    expect(tt.hashtags.length).toBeLessThanOrEqual(5);
    expect(suggestCaption(topic, "INSTAGRAM", 1).caption).not.toBe(ig.caption);
    for (const c of [fb, ig, tt]) expect(flagClaims(c.caption)).toEqual([]); // the generator adds no claims
  });

  it("flags dates, tax rules, prices, guarantees, testimonials and hours", () => {
    const kinds = (t: string) => flagClaims(t).map((f) => f.kind);
    expect(kinds("File by April 15!")).toContain("Date or deadline");
    expect(kinds("New 2026 standard deduction rules")).toContain("Tax year or tax rule");
    expect(kinds("Only $99 this week, 20% off")).toContain("Price or promotion");
    expect(kinds("We guarantee the biggest refund")).toContain("Guarantee or outcome");
    expect(kinds("“Best accountant ever!” — a client")).toContain("Testimonial or review");
    expect(kinds("Open Saturdays 9am–1pm")).toContain("Hours or availability");
    expect(flagClaims("Keep receipts organized in one folder.")).toEqual([]);
  });
});

describe("social workflow", () => {
  it("staff approve with flagged-claim verification; edits to approved posts go back to Awaiting approval", async () => {
    const daria = await makeUser("STAFF");
    const file = await flyer(daria.id);
    const post = await createSocialPost(daria, "Tax season kickoff");
    const when = new Date(Date.now() + 3600_000);
    await saveSocialDraft(daria, post.id, { title: "Tax season kickoff", scheduledAt: when, targets: [{ platform: "INSTAGRAM", caption: "Book now", hashtags: [], mediaIds: [] }] });
    await expect(submitForApproval(daria, post.id)).rejects.toThrow(/at least one image/);
    await saveSocialDraft(daria, post.id, {
      title: "Tax season kickoff",
      scheduledAt: when,
      targets: [
        { platform: "INSTAGRAM", caption: "Book your appointment before the April 15 deadline.", hashtags: ["#TaxSeason", "TaxSeason"], mediaIds: [file.id] },
        { platform: "FACEBOOK", caption: "Book your appointment today.", hashtags: [], mediaIds: [file.id] },
      ],
    });
    const ig0 = await prisma.socialPostTarget.findFirstOrThrow({ where: { postId: post.id, platform: "INSTAGRAM" } });
    expect(ig0.hashtags).toEqual(["TaxSeason"]); // de-duplicated
    await submitForApproval(daria, post.id);
    await expect(approvePost(daria, post.id, true)).rejects.toThrow(/Verify the flagged wording/);
    await approvePost(daria, post.id, true, "ok", true);
    let p = await prisma.socialPost.findUniqueOrThrow({ where: { id: post.id } });
    expect(p.status).toBe("SCHEDULED");
    expect(p.approvedById).toBe(daria.id);
    expect(p.claimsVerifiedAt).not.toBeNull();

    // Saving identical content changes nothing.
    const same = await saveSocialDraft(daria, post.id, {
      title: "Tax season kickoff",
      scheduledAt: when,
      targets: [
        { platform: "FACEBOOK", caption: "Book your appointment today.", hashtags: [], mediaIds: [file.id] },
        { platform: "INSTAGRAM", caption: "Book your appointment before the April 15 deadline.", hashtags: ["TaxSeason"], mediaIds: [file.id] },
      ],
    });
    expect(same.changed).toBe(false);
    // A wording change sends it back for approval and clears approval + verification.
    await saveSocialDraft(daria, post.id, { title: "Tax season kickoff", scheduledAt: when, targets: [{ platform: "FACEBOOK", caption: "Book today.", hashtags: [], mediaIds: [file.id] }, { platform: "INSTAGRAM", caption: "Book now.", hashtags: [], mediaIds: [file.id] }] });
    p = await prisma.socialPost.findUniqueOrThrow({ where: { id: post.id } });
    expect(p.status).toBe("PENDING_APPROVAL");
    expect(p.approvedAt).toBeNull();
    expect(p.claimsVerifiedAt).toBeNull();
    await approvePost(daria, post.id, true);
    // Moving the time also needs approval again.
    await changeSchedule(daria, post.id, new Date(Date.now() + 7200_000));
    expect((await prisma.socialPost.findUniqueOrThrow({ where: { id: post.id } })).status).toBe("PENDING_APPROVAL");
    const history = await prisma.socialPostRevision.findMany({ where: { postId: post.id }, orderBy: { createdAt: "asc" } });
    expect(history.map((h) => h.action)).toEqual(expect.arrayContaining(["created", "submitted", "approved_claims_verified", "edited_returned_to_awaiting_approval", "rescheduled_returned_to_awaiting_approval"]));
  });

  it("due posts become Ready to publish once (no duplicate reminders) and never Published", async () => {
    const daria = await makeUser("STAFF");
    const file = await flyer(daria.id);
    const post = await createSocialPost(daria, "Bookkeeping tip");
    const when = new Date(Date.now() + 3600_000);
    await saveSocialDraft(daria, post.id, { title: "Bookkeeping tip", scheduledAt: when, targets: [{ platform: "INSTAGRAM", caption: "Keep receipts in one place.", hashtags: [], mediaIds: [file.id] }, { platform: "FACEBOOK", caption: "Keep receipts in one place.", hashtags: [], mediaIds: [] }] });
    await submitForApproval(daria, post.id);
    await approvePost(daria, post.id, true);
    expect(await markDueManualTargets(new Date())).toBe(0);
    const later = new Date(Date.now() + 2 * 3600_000);
    expect(await markDueManualTargets(later)).toBe(2);
    expect(await markDueManualTargets(later)).toBe(0); // already reminded
    expect(await prisma.socialPostTarget.count({ where: { status: "PUBLISHED" } })).toBe(0);

    const ig = await prisma.socialPostTarget.findFirstOrThrow({ where: { postId: post.id, platform: "INSTAGRAM" } });
    await expect(confirmManualPost(daria, ig.id, "https://example.com/x")).rejects.toThrow(/Instagram/);
    await confirmManualPost(daria, ig.id, ""); // link is optional
    await expect(confirmManualPost(daria, ig.id, "")).rejects.toThrow(/isn't waiting/);
    expect((await prisma.socialPost.findUniqueOrThrow({ where: { id: post.id } })).status).toBe("SCHEDULED"); // Facebook still pending
    const fb = await prisma.socialPostTarget.findFirstOrThrow({ where: { postId: post.id, platform: "FACEBOOK" } });
    await confirmManualPost(daria, fb.id, "https://www.facebook.com/tturner/posts/1");
    expect((await prisma.socialPost.findUniqueOrThrow({ where: { id: post.id } })).status).toBe("COMPLETED");
    // The posted Instagram version is locked.
    await expect(
      saveSocialDraft(daria, post.id, { title: "x", scheduledAt: when, targets: [{ platform: "INSTAGRAM", caption: "changed", hashtags: [], mediaIds: [file.id] }] }),
    ).rejects.toThrow(/finished/);
  });

  it("uses only marketing media, never client documents", async () => {
    const daria = await makeUser("STAFF");
    const doc = await flyer(daria.id, "CLIENT_DOCUMENT");
    const post = await createSocialPost(daria, "x");
    await expect(saveSocialDraft(daria, post.id, { title: "x", scheduledAt: null, targets: [{ platform: "FACEBOOK", caption: "x", hashtags: [], mediaIds: [doc.id] }] })).rejects.toThrow(/marketing media library/);
  });

  it("suggestions use only Admin-approved topics, never duplicate a month, and regenerate rotates wording", async () => {
    const tab = await makeUser("ADMIN");
    const daria = await makeUser("STAFF");
    const tip = await saveTopic(daria, { category: "BOOKKEEPING_TIP", title: "Reconcile monthly", keyMessage: "Reconcile your bank accounts every month.", hashtags: ["Bookkeeping"] });
    const tax = await saveTopic(daria, { category: "TAX_SEASON", title: "Gather your documents", keyMessage: "Start a folder for your tax documents as they arrive.", hashtags: [] });
    await expect(saveTopic(daria, { category: "HOLIDAY", title: "Thanksgiving", keyMessage: "Happy Thanksgiving!", hashtags: [] })).rejects.toThrow(/date/);
    const holiday = await saveTopic(daria, { category: "HOLIDAY", title: "Thanksgiving", keyMessage: "Wishing you a happy Thanksgiving.", hashtags: [], eventDate: "2026-11-26" });
    expect(await suggestMonth(daria, "2026-11", ["FACEBOOK"])).toEqual([]); // nothing approved yet
    await expect(approveTopic(daria, tip.id)).rejects.toBeInstanceOf(ForbiddenError);
    for (const t of [tip, tax, holiday]) await approveTopic(tab, t.id);

    const ids = await suggestMonth(daria, "2026-11", ["FACEBOOK", "INSTAGRAM"]);
    const posts = await prisma.socialPost.findMany({ where: { id: { in: ids } }, include: { targets: true } });
    expect(posts.map((p) => p.title).sort()).toEqual(["Reconcile monthly", "Thanksgiving"]); // tax-season topic skipped in November
    expect(posts.every((p) => p.status === "DRAFT" && p.timeSuggested)).toBe(true);
    const tg = posts.find((p) => p.title === "Thanksgiving")!;
    expect(utcToChicagoLocal(tg.scheduledAt!)).toBe("2026-11-26T10:00");
    expect(await suggestMonth(daria, "2026-11", ["FACEBOOK", "INSTAGRAM"])).toEqual([]); // no duplicates

    const jan = await suggestMonth(daria, "2027-01", ["FACEBOOK"]);
    expect((await prisma.socialPost.findMany({ where: { id: { in: jan } } })).map((p) => p.title)).toContain("Gather your documents");

    const draft = await draftFromTopic(daria, tip.id, ["INSTAGRAM"]);
    const before = (await prisma.socialPostTarget.findFirstOrThrow({ where: { postId: draft.id } })).caption;
    await regenerateCaptions(daria, draft.id);
    const after = (await prisma.socialPostTarget.findFirstOrThrow({ where: { postId: draft.id } })).caption;
    expect(after).not.toBe(before);
    expect(after).toContain("Reconcile your bank accounts every month.");
    expect((await readyToPublish()).length).toBe(0);
  });
});
