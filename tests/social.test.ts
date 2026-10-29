import { beforeEach, describe, expect, it } from "vitest";
import { makeUser, prisma, resetDb } from "./db";
import { validateTarget } from "@/lib/social/rules";
import { approvePost, confirmManualPost, createSocialPost, markDueManualTargets, saveSocialDraft, schedulePost, submitForApproval } from "@/lib/services/social";
import { ForbiddenError } from "@/lib/auth/actor";

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

describe("social workflow", () => {
  it("requires valid content and admin approval; manual posts need a real link and never show as Published", async () => {
    const tabitha = await makeUser("ADMIN");
    const daria = await makeUser("STAFF");
    const file = await prisma.storedFile.create({
      data: { kind: "FLYER", storageKey: "flyer/test", originalName: "flyer.jpg", title: "Tax season", mimeType: "image/jpeg", sizeBytes: 300_000, width: 1080, height: 1350, uploadedById: daria.id },
    });
    const post = await createSocialPost(daria, "Tax season kickoff");
    await saveSocialDraft(daria, post.id, { title: "Tax season kickoff", scheduledAt: null, targets: [{ platform: "INSTAGRAM", caption: "Book now", mediaIds: [] }] });
    await expect(submitForApproval(daria, post.id)).rejects.toThrow(/at least one image/);
    await saveSocialDraft(daria, post.id, {
      title: "Tax season kickoff",
      scheduledAt: null,
      targets: [
        { platform: "INSTAGRAM", caption: "Book now #taxes", mediaIds: [file.id] },
        { platform: "FACEBOOK", caption: "Book your appointment today.", mediaIds: [file.id] },
      ],
    });
    await submitForApproval(daria, post.id);
    await expect(approvePost(daria, post.id, true)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(schedulePost(daria, post.id, new Date(Date.now() + 3600_000))).rejects.toThrow(/approved/);
    await approvePost(tabitha, post.id, true);
    await schedulePost(daria, post.id, new Date(Date.now() + 3600_000));

    expect(await markDueManualTargets(new Date())).toBe(0);
    expect(await markDueManualTargets(new Date(Date.now() + 2 * 3600_000))).toBe(2);
    const targets = await prisma.socialPostTarget.findMany({ where: { postId: post.id } });
    expect(targets.every((t) => t.status === "REQUIRES_MANUAL_POSTING")).toBe(true);

    const ig = targets.find((t) => t.platform === "INSTAGRAM")!;
    await expect(confirmManualPost(daria, ig.id, "https://example.com/not-instagram")).rejects.toThrow(/Instagram/);
    await confirmManualPost(daria, ig.id, "https://www.instagram.com/p/ABC123/");
    const after = await prisma.socialPostTarget.findUniqueOrThrow({ where: { id: ig.id } });
    expect(after.status).toBe("POSTED_MANUALLY");
    expect(await prisma.socialPostTarget.count({ where: { status: "PUBLISHED" } })).toBe(0);
  });
});
