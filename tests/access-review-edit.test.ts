import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { grantPerms, prisma, resetDb } from "./db";
import { ForbiddenError, type Actor } from "@/lib/auth/actor";
import { hashPassword } from "@/lib/auth/password";
import { claimOwnerOffice } from "@/lib/auth/owner";
import { GRANTABLE_KEYS } from "@/lib/permissions";
import { REVIEW_TASK_TITLE, VENDORS, correctionRows } from "@/lib/access-review";
import {
  accessReviewBoard,
  completeAccessReview,
  correctAccessReview,
  ensureAccessReviewReminder,
  getAccessReview,
  type CorrectionInput,
} from "@/lib/services/access-review";

/**
 * Correcting a completed access review. Fictional office only: "Tabitha Turner" (owner),
 * "Daria Fictional" (staff holding every grant), "Marcus Fictional" (an Admin who isn't the owner).
 */
const PASSWORD = "Owner-Strong-Pass-1";
const DAY = 24 * 60 * 60 * 1000;
const COMPLETED = new Date("2026-08-10T15:30:00Z");

let signedIn: Actor | null = null;
vi.mock("@/lib/auth/session", async (orig) => ({ ...(await orig<object>()), requireUser: async () => signedIn, getCurrentUser: async () => signedIn }));
const { default: RecordPage } = await import("@/app/(app)/owner/(office)/access-review/reviews/[id]/page");
const { default: EditPage } = await import("@/app/(app)/owner/(office)/access-review/reviews/[id]/edit/page");
const { default: ReviewPage } = await import("@/app/(app)/owner/(office)/access-review/page");

beforeEach(async () => {
  await resetDb();
  signedIn = null;
  vi.stubEnv("NOTIFICATIONS_ENABLED", "false");
  vi.stubGlobal("fetch", async (url: string | URL) => {
    throw new Error(`Unexpected network call in a test: ${String(url)}`);
  });
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

async function staffAccount(email: string, name: string, role: "ADMIN" | "STAFF"): Promise<Actor> {
  const u = await prisma.user.create({ data: { email, name, role, passwordHash: await hashPassword(PASSWORD), mfaEnabledAt: new Date() } });
  return { id: u.id, role: u.role, name: u.name, email: u.email };
}

async function office() {
  const tab = await staffAccount("tabitha@tturnerassociates.com", "Tabitha Turner", "ADMIN");
  const daria = await staffAccount("daria.fictional@example.com", "Daria Fictional", "STAFF");
  const marcus = await staffAccount("marcus.fictional@example.com", "Marcus Fictional", "ADMIN");
  await claimOwnerOffice(tab, PASSWORD);
  await grantPerms(daria.id, GRANTABLE_KEYS);
  await grantPerms(marcus.id, GRANTABLE_KEYS);
  const review = await completeAccessReview(
    tab,
    {
      summary: "Fictional Q3 review: access appropriate.",
      findings: "Removed one fictional GitHub seat.",
      vendors: Object.fromEntries(VENDORS.map((v) => [v.key, { appropriate: true, twoStep: v.key !== "github", note: v.key === "github" ? "Fictional: 2FA pending" : "" }])),
    },
    COMPLETED,
  );
  return { tab, daria, marcus, review };
}

/** The edit form as submitted: every vendor on the review, with `over` applied. */
async function form(reviewId: string, over: Partial<CorrectionInput> & { vendorOver?: Record<string, { appropriate?: boolean; twoStep?: boolean; note?: string }> } = {}): Promise<CorrectionInput> {
  const r = (await prisma.accessReview.findUniqueOrThrow({ where: { id: reviewId } })) as { summary: string; findings: string | null; vendorAnswers: unknown };
  const answers = r.vendorAnswers as { key: string; appropriate: boolean; twoStep: boolean; note: string }[];
  const { vendorOver = {}, ...rest } = over;
  const revisions = await prisma.accessReviewRevision.count({ where: { reviewId } });
  return {
    expectedRevision: revisions,
    reason: "Fictional: confirmed after the review.",
    summary: r.summary,
    findings: r.findings ?? "",
    vendors: Object.fromEntries(answers.map((a) => [a.key, { appropriate: a.appropriate, twoStep: a.twoStep, note: a.note, ...vendorOver[a.key] }])),
    ...rest,
  };
}

const html = async (el: Promise<unknown>) => renderToStaticMarkup((await el) as ReactElement);
const recordFor = (id: string) => RecordPage({ params: Promise.resolve({ id }), searchParams: Promise.resolve({}) });
const editFor = (id: string) => EditPage({ params: Promise.resolve({ id }) });
const isNotFound = (e: unknown) => typeof e === "object" && e !== null && String((e as { digest?: string }).digest ?? "").includes("404");

describe("who can correct a review", () => {
  it("lets the owner edit, and the record shows Edit Review beside Print record", async () => {
    const { tab, review } = await office();
    signedIn = tab;
    const page = await html(recordFor(review.id));
    expect(page).toContain("Edit Review");
    expect(page).toContain("Print record");
    expect(page).toContain(`/owner/access-review/reviews/${review.id}/edit`);
    const edit = await html(editFor(review.id));
    expect(edit).toContain("Reason for correction");
    expect(edit).toContain('name="expectedRevision" value="0"');

    const rev = await correctAccessReview(tab, review.id, await form(review.id, { vendorOver: { github: { twoStep: true, note: "Fictional: 2FA confirmed" } } }));
    expect(rev.revisionNumber).toBe(1);
  });

  it("refuses staff holding every grant and a non-owner Admin (service and pages)", async () => {
    const { tab, daria, marcus, review } = await office();
    const input = await form(review.id, { summary: "Not allowed" });
    for (const who of [daria, marcus]) {
      await expect(correctAccessReview(who, review.id, input)).rejects.toBeInstanceOf(ForbiddenError);
      await expect(correctAccessReview(who, review.id, input)).rejects.toThrow("Not found.");
      signedIn = who;
      await expect(editFor(review.id)).rejects.toSatisfy(isNotFound);
      await expect(recordFor(review.id)).rejects.toSatisfy(isNotFound);
    }
    expect(await prisma.accessReviewRevision.count()).toBe(0);
    expect((await getAccessReview(tab, review.id))!.summary).toBe("Fictional Q3 review: access appropriate.");
  });
});

describe("what a correction saves", () => {
  it("stores the exact previous and updated values and the changed fields; the original is reconstructible", async () => {
    const { tab, review } = await office();
    const original = await prisma.accessReview.findUniqueOrThrow({ where: { id: review.id } });
    const reviewsBefore = await prisma.accessReview.count();

    const editedAt = new Date("2026-09-01T14:00:00Z");
    await correctAccessReview(
      tab,
      review.id,
      await form(review.id, {
        summary: "Fictional Q3 review: access appropriate (corrected).",
        vendorOver: { github: { twoStep: true, note: "Fictional: 2FA confirmed" }, square: { appropriate: false } },
      }),
      editedAt,
    );
    await correctAccessReview(tab, review.id, await form(review.id, { findings: "", reason: "Fictional: findings belonged to another review." }), new Date("2026-09-02T14:00:00Z"));

    const revs = await prisma.accessReviewRevision.findMany({ where: { reviewId: review.id }, orderBy: { revisionNumber: "asc" } });
    expect(revs.map((r) => r.revisionNumber)).toEqual([1, 2]);
    const [first, second] = revs;
    expect(first).toMatchObject({ editedById: tab.id, editedByName: "Tabitha Turner", reason: "Fictional: confirmed after the review." });
    expect(first.editedAt.toISOString()).toBe(editedAt.toISOString());
    expect(first.changedFields).toEqual(["summary", "vendor:github.twoStep", "vendor:github.note", "vendor:square.appropriate"]);
    // The first revision's "previous" is exactly the review as completed.
    expect(first.previous).toEqual({ summary: original.summary, findings: original.findings, vendorAnswers: original.vendorAnswers });
    const firstUpdated = first.updated as { summary: string; findings: string | null; vendorAnswers: { key: string; appropriate: boolean; twoStep: boolean; note: string }[] };
    expect(firstUpdated.summary).toBe("Fictional Q3 review: access appropriate (corrected).");
    expect(firstUpdated.findings).toBe("Removed one fictional GitHub seat.");
    expect(firstUpdated.vendorAnswers.find((v) => v.key === "github")).toMatchObject({ twoStep: true, note: "Fictional: 2FA confirmed", appropriate: true });
    expect(firstUpdated.vendorAnswers.find((v) => v.key === "square")).toMatchObject({ appropriate: false, twoStep: true });
    // Revisions chain: each one's previous is the one before's updated.
    expect(second.previous).toEqual(first.updated);
    expect(second.changedFields).toEqual(["findings"]);
    expect((second.updated as { findings: string | null }).findings).toBeNull();

    const saved = (await getAccessReview(tab, review.id))!;
    expect(saved.revision).toBe(2);
    expect(saved.findings).toBeNull();
    expect(saved.original).toEqual({ summary: original.summary, findings: original.findings, vendorAnswers: original.vendorAnswers });
    expect(correctionRows(saved.corrections[0]).find((r) => r.field === "vendor:github.twoStep")).toEqual({ field: "vendor:github.twoStep", label: "GitHub — Two-step verification on", previous: "Not confirmed", updated: "Yes" });

    // Never edited: staff snapshot, completion, reviewer, change list, created time. No new review row.
    const after = await prisma.accessReview.findUniqueOrThrow({ where: { id: review.id } });
    expect(after.completedAt.toISOString()).toBe(COMPLETED.toISOString());
    expect(after.staffSnapshot).toEqual(original.staffSnapshot);
    expect(after.changes).toEqual(original.changes);
    expect(after.reviewerId).toBe(original.reviewerId);
    expect(after.reviewerName).toBe(original.reviewerName);
    expect(after.createdAt.toISOString()).toBe(original.createdAt.toISOString());
    expect(await prisma.accessReview.count()).toBe(reviewsBefore);

    // One owner audit entry per save, with field names and vendor keys only (no free text).
    const logs = await prisma.ownerAuditLog.findMany({ where: { action: "access_review.corrected", entityId: review.id }, orderBy: { createdAt: "asc" } });
    expect(logs).toHaveLength(2);
    expect(logs[0].actorId).toBe(tab.id);
    expect(logs[0].details).toMatchObject({ reviewId: review.id, revisionNumber: 1, changedFields: first.changedFields, vendorKeysChanged: ["github", "square"] });
    expect(JSON.stringify(logs.map((l) => l.details))).not.toMatch(/corrected\)|Fictional: /);
  });

  it("refuses fields that are never editable", async () => {
    const { tab, review } = await office();
    const base = await form(review.id, { summary: "Fictional changed summary." });
    for (const extra of [{ completedAt: new Date() }, { staffSnapshot: [] }, { reviewerName: "Someone else" }, { changes: [] }, { createdAt: new Date() }]) {
      await expect(correctAccessReview(tab, review.id, { ...base, ...extra } as CorrectionInput)).rejects.toThrow(/can't be changed/);
    }
    await expect(correctAccessReview(tab, review.id, { ...base, vendors: { ...base.vendors, github: { ...base.vendors.github, label: "Renamed" } as never } })).rejects.toThrow(/Only/);
    await expect(correctAccessReview(tab, review.id, { ...base, vendors: { ...base.vendors, not_a_vendor: { appropriate: true } } })).rejects.toThrow(/aren't on this review/);
    expect(await prisma.accessReviewRevision.count()).toBe(0);
  });

  it("keeps the revision history append-only in the database", async () => {
    const { tab, review } = await office();
    await correctAccessReview(tab, review.id, await form(review.id, { summary: "Fictional corrected summary." }));
    const rev = await prisma.accessReviewRevision.findFirstOrThrow();
    await expect(prisma.accessReviewRevision.update({ where: { id: rev.id }, data: { reason: "rewritten" } })).rejects.toThrow(/append-only/);
    await expect(prisma.accessReviewRevision.delete({ where: { id: rev.id } })).rejects.toThrow(/append-only/);
    expect((await prisma.accessReviewRevision.findFirstOrThrow()).reason).toBe("Fictional: confirmed after the review.");
  });
});

describe("refused saves", () => {
  it("refuses a save with no actual change", async () => {
    const { tab, review } = await office();
    await expect(correctAccessReview(tab, review.id, await form(review.id))).rejects.toThrow(/Nothing changed/);
    // Whitespace-only differences don't count either.
    await expect(correctAccessReview(tab, review.id, await form(review.id, { summary: "  Fictional Q3 review: access appropriate.  " }))).rejects.toThrow(/Nothing changed/);
    expect(await prisma.accessReviewRevision.count()).toBe(0);
    expect(await prisma.ownerAuditLog.count({ where: { action: "access_review.corrected" } })).toBe(0);
  });

  it("refuses a stale form (someone saved a correction after it was opened)", async () => {
    const { tab, review } = await office();
    const opened = await form(review.id, { summary: "Fictional summary from the first tab." });
    await correctAccessReview(tab, review.id, await form(review.id, { summary: "Fictional summary from the second tab." }));
    await expect(correctAccessReview(tab, review.id, opened)).rejects.toThrow(/after you opened it/);
    expect(await prisma.accessReviewRevision.count()).toBe(1);
    expect((await getAccessReview(tab, review.id))!.summary).toBe("Fictional summary from the second tab.");
    // Concurrent saves from the same revision: exactly one wins.
    const a = await form(review.id, { summary: "Fictional concurrent A." });
    const b = await form(review.id, { summary: "Fictional concurrent B." });
    const results = await Promise.allSettled([correctAccessReview(tab, review.id, a), correctAccessReview(tab, review.id, b)]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(await prisma.accessReviewRevision.count()).toBe(2);
  });

  it("requires a reason and a summary", async () => {
    const { tab, review } = await office();
    await expect(correctAccessReview(tab, review.id, await form(review.id, { summary: "Fictional new summary.", reason: "  " }))).rejects.toThrow(/reason/);
    await expect(correctAccessReview(tab, review.id, await form(review.id, { summary: "" }))).rejects.toThrow(/summary/);
    expect(await prisma.accessReviewRevision.count()).toBe(0);
  });
});

describe("the 90-day schedule", () => {
  it("stays based on the original completion after a correction", async () => {
    const { tab, review } = await office();
    const due = COMPLETED.getTime() + 90 * DAY;
    // Corrected 80 days later: still due 90 days after completion, not after the correction.
    await correctAccessReview(tab, review.id, await form(review.id, { summary: "Fictional corrected late." }), new Date(COMPLETED.getTime() + 80 * DAY));
    const board = await accessReviewBoard(tab, new Date(COMPLETED.getTime() + 85 * DAY));
    expect(board.status.dueAt?.getTime()).toBe(due);
    expect(board.history.map((h) => h.id)).toEqual([review.id]);
    expect(board.history[0].corrections).toBe(1);
    // More than 14 days before the due date, so no reminder yet (it appears 14 days before).
    expect(await ensureAccessReviewReminder(new Date(COMPLETED.getTime() + 70 * DAY))).toBe("not_due");
    expect(await ensureAccessReviewReminder(new Date(COMPLETED.getTime() + 91 * DAY))).toBe("created");
    const task = await prisma.task.findFirstOrThrow({ where: { title: REVIEW_TASK_TITLE } });
    expect(task.dueAt?.getTime()).toBe(due);
  });
});

describe("the printable record", () => {
  it("shows the original completion, Last updated, the correction history and the history badge", async () => {
    const { tab, review } = await office();
    await correctAccessReview(tab, review.id, await form(review.id, { vendorOver: { github: { twoStep: true, note: "Fictional: 2FA confirmed" } } }), new Date("2026-09-01T14:00:00Z"));
    await correctAccessReview(tab, review.id, await form(review.id, { summary: "Fictional summary, corrected.", reason: "Fictional: typo in the summary." }), new Date("2026-09-03T16:00:00Z"));
    signedIn = tab;
    const page = await html(recordFor(review.id));
    expect(page).toContain("Completed Aug 10, 2026");
    expect(page).toMatch(/Last updated Sep 3, 2026[^<]*by Tabitha Turner \(revision 2\)/);
    expect(page).toContain("Correction history (2)");
    expect(page).toContain("Fictional: typo in the summary.");
    expect(page).toContain("Fictional: confirmed after the review.");
    expect(page).toContain("GitHub — Two-step verification on");
    expect(page).toContain("Fictional: 2FA pending"); // previous note
    expect(page).toContain("Fictional: 2FA confirmed"); // updated note
    expect(page).toContain("View the original values");
    expect(page).toContain("Fictional Q3 review: access appropriate."); // original summary
    expect(page).toContain("Print record");

    const list = await html(ReviewPage());
    expect(list).toContain("Corrected (2)");
  });
});
