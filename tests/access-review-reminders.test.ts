import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { grantPerms, prisma, resetDb } from "./db";
import { ForbiddenError, type Actor } from "@/lib/auth/actor";
import { hashPassword } from "@/lib/auth/password";
import { claimOwnerOffice } from "@/lib/auth/owner";
import { GRANTABLE_KEYS } from "@/lib/permissions";
import { ACCESS_REVIEW_PATH, REVIEW_TASK_TITLE, VENDORS, nextReviewDue, reminderBannerText, reminderStage } from "@/lib/access-review";
import {
  accessReviewBanner,
  accessReviewBoard,
  completeAccessReview,
  correctAccessReview,
  ensureAccessReviewDueEmail,
  ensureAccessReviewReminder,
  runAccessReviewReminders,
} from "@/lib/services/access-review";
import { setTaskDone, saveTask, visibleTasksWhere } from "@/lib/services/tasks";

/**
 * Access-review reminders: the owner-only task (from 14 days before the due date), the one due
 * email per review cycle, and the Owner's Office banner. Fictional office only: "Tabitha Turner"
 * (owner), "Daria Fictional" (staff holding every grant), "Marcus Fictional" (an Admin who isn't
 * the owner). The email provider is a local stub (resend.mock); nothing leaves the machine.
 */
const PASSWORD = "Owner-Strong-Pass-1";
const APP = "https://client.example.test";
const LINK = `${APP}/owner/access-review`;
// Worked example: review completed Nov 5, 2026 at 9:39 am Chicago (CST = UTC−6).
const COMPLETED = new Date("2026-11-05T15:39:00Z");
/** A Chicago wall-clock time as a Date (CST −6 in winter, CDT −5 from Mar 14, 2027). */
const chi = (local: string) => {
  const d = new Date(`${local}:00Z`);
  const cdt = d >= new Date("2027-03-14T08:00:00Z") && d < new Date("2027-11-07T07:00:00Z");
  return new Date(d.getTime() + (cdt ? 5 : 6) * 3600_000);
};

let signedIn: Actor | null = null;
vi.mock("@/lib/auth/session", async (orig) => ({ ...(await orig<object>()), requireUser: async () => signedIn, getCurrentUser: async () => signedIn }));
const { default: TasksPage } = await import("@/app/(app)/tasks/page");
const { default: OwnerOverview } = await import("@/app/(app)/owner/(office)/page");

type Sent = { to: string[]; subject: string; text: string; html: string };
let sent: Sent[] = [];
let failNext = 0;

beforeEach(async () => {
  await resetDb();
  signedIn = null;
  sent = [];
  failNext = 0;
  vi.stubEnv("NOTIFICATIONS_ENABLED", "false");
  vi.stubEnv("RESEND_API_KEY", "re_test");
  vi.stubEnv("EMAIL_FROM_ADDRESS", "office@example.com");
  vi.stubEnv("RESEND_API_BASE", "https://resend.mock");
  vi.stubEnv("APP_URL", APP);
  vi.stubGlobal("fetch", async (url: string | URL, init?: RequestInit) => {
    if (String(url) !== "https://resend.mock/emails") throw new Error(`Unexpected network call in a test: ${String(url)}`);
    if (failNext > 0) {
      failNext--;
      return new Response(JSON.stringify({ message: "stub outage" }), { status: 500 });
    }
    sent.push(JSON.parse(String(init?.body)));
    return new Response(JSON.stringify({ id: `stub-${sent.length}` }), { status: 200 });
  });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

async function staffAccount(email: string, name: string, role: "ADMIN" | "STAFF"): Promise<Actor> {
  const u = await prisma.user.create({ data: { email, name, role, passwordHash: await hashPassword(PASSWORD), mfaEnabledAt: new Date() } });
  return { id: u.id, role: u.role, name: u.name, email: u.email };
}

const allVendors = () => Object.fromEntries(VENDORS.map((v) => [v.key, { appropriate: true, twoStep: true, note: "" }]));

async function office(withReview = true) {
  const tab = await staffAccount("tabitha@tturnerassociates.com", "Tabitha Turner", "ADMIN");
  const daria = await staffAccount("daria.fictional@example.com", "Daria Fictional", "STAFF");
  const marcus = await staffAccount("marcus.fictional@example.com", "Marcus Fictional", "ADMIN");
  await claimOwnerOffice(tab, PASSWORD);
  await grantPerms(daria.id, GRANTABLE_KEYS);
  await grantPerms(marcus.id, GRANTABLE_KEYS);
  const review = withReview ? await completeAccessReview(tab, { summary: "Fictional Q4 review: all access appropriate.", vendors: allVendors() }, COMPLETED) : null;
  return { tab, daria, marcus, review };
}

const reminders = () => prisma.task.findMany({ where: { title: REVIEW_TASK_TITLE }, orderBy: { createdAt: "asc" } });

/** Renders a server page as a given person at a simulated time. */
async function render(as: Actor, at: Date, page: (p: never) => Promise<ReactElement>, searchParams: Record<string, string> = {}) {
  signedIn = as;
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(at);
  try {
    let el = await page({ searchParams: Promise.resolve(searchParams) } as never);
    // The calendar view is an async server component returned as an element: resolve it here.
    while (typeof el.type === "function" && el.type.constructor.name === "AsyncFunction") el = await (el.type as (p: unknown) => Promise<ReactElement>)(el.props);
    return renderToStaticMarkup(el);
  } finally {
    vi.useRealTimers();
  }
}

describe("the worked example (America/Chicago)", () => {
  it("due Feb 3, 2027; upcoming from Jan 20; one email on Feb 3; still open Mar 1; a Feb 10 review closes it and moves the next due to May 11", async () => {
    const { tab } = await office();
    const due = nextReviewDue(COMPLETED)!;
    expect(due.toISOString()).toBe("2027-02-03T15:39:00.000Z");

    expect(await ensureAccessReviewReminder(chi("2027-01-19T23:59"))).toBe("not_due");
    expect(await ensureAccessReviewReminder(chi("2027-01-20T00:05"))).toBe("created");
    const [task] = await reminders();
    expect(task).toMatchObject({ status: "OPEN", ownerOnly: true, assigneeId: tab.id, priority: "HIGH", reminderKey: expect.stringMatching(/^access-review:/) });
    expect(task.dueAt?.toISOString()).toBe(due.toISOString());
    expect(task.details).toContain("Wednesday, February 3, 2027");
    expect(task.details).toContain(LINK);

    // The day before: still upcoming, no email.
    expect(await ensureAccessReviewDueEmail(chi("2027-02-02T23:30"))).toBe("not_due");
    // Just after midnight Chicago on Feb 3 (before 9:39 am): the due date has arrived.
    expect(await runAccessReviewReminders(chi("2027-02-03T00:30"))).toEqual({ task: "open", email: "sent" });
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toEqual(["tabitha@tturnerassociates.com"]);
    for (let h = 1; h < 24 * 26; h += 6) await runAccessReviewReminders(new Date(chi("2027-02-03T00:30").getTime() + h * 3600_000));
    expect(sent).toHaveLength(1);

    // Mar 1, no new review: still one open task, overdue by 26 days.
    const mar1 = chi("2027-03-01T10:00");
    expect(await runAccessReviewReminders(mar1)).toEqual({ task: "open", email: "already_sent" });
    expect((await reminders()).map((t) => t.status)).toEqual(["OPEN"]);
    expect(await accessReviewBanner(tab, mar1)).toMatchObject({ stage: "overdue", title: "Access review overdue by 26 days", href: ACCESS_REVIEW_PATH });

    // A new review on Feb 10 (in the simulated past relative to Mar 1, it's the completion that counts).
    const feb10 = chi("2027-02-10T10:00");
    const second = await completeAccessReview(tab, { summary: "Fictional Q1 review.", vendors: allVendors() }, feb10);
    expect((await reminders()).map((t) => t.status)).toEqual(["DONE"]);
    const next = nextReviewDue(second.completedAt)!;
    expect(new Intl.DateTimeFormat("en-CA", { timeZone: "America/Chicago" }).format(next)).toBe("2027-05-11");
    expect((await accessReviewBoard(tab, feb10)).status.dueAt?.getTime()).toBe(next.getTime());

    // The next cycle: quiet until Apr 27, then a new (single) task, and one new email on May 11.
    expect(await runAccessReviewReminders(chi("2027-04-26T12:00"))).toEqual({ task: "not_due", email: "not_due" });
    expect(await runAccessReviewReminders(chi("2027-04-27T12:00"))).toEqual({ task: "created", email: "not_due" });
    expect(await runAccessReviewReminders(chi("2027-05-11T08:00"))).toEqual({ task: "open", email: "sent" });
    expect(await runAccessReviewReminders(chi("2027-05-11T09:00"))).toEqual({ task: "open", email: "already_sent" });
    const all = await reminders();
    expect(all.map((t) => t.status)).toEqual(["DONE", "OPEN"]);
    expect(new Set(all.map((t) => t.reminderKey)).size).toBe(2);
    expect(sent).toHaveLength(2);
  });
});

describe("upcoming window", () => {
  it("creates the task 14 days before the due date — not at 15 — and labels it upcoming until due", async () => {
    await office();
    const due = nextReviewDue(COMPLETED)!;
    const daysBefore = (n: number) => new Date(due.getTime() - n * 86400_000);
    expect(reminderStage(COMPLETED, daysBefore(15))).toMatchObject({ stage: "quiet", daysUntil: 15 });
    expect(reminderStage(COMPLETED, daysBefore(14))).toMatchObject({ stage: "upcoming", daysUntil: 14 });
    expect(reminderStage(COMPLETED, daysBefore(13))).toMatchObject({ stage: "upcoming", daysUntil: 13 });
    expect(reminderStage(COMPLETED, due)).toMatchObject({ stage: "due" });
    expect(reminderStage(COMPLETED, new Date(due.getTime() + 86400_000))).toMatchObject({ stage: "overdue", daysOverdue: 1 });

    expect(await ensureAccessReviewReminder(daysBefore(15))).toBe("not_due");
    expect(await prisma.task.count()).toBe(0);
    expect(await ensureAccessReviewReminder(daysBefore(14))).toBe("created");
    expect(await ensureAccessReviewReminder(daysBefore(13))).toBe("open");
    expect(await prisma.task.count()).toBe(1);
    // No email while upcoming.
    expect(await ensureAccessReviewDueEmail(daysBefore(13))).toBe("not_due");
    expect(sent).toHaveLength(0);
  });
});

describe("no duplicates", () => {
  it("concurrent and repeated runs make exactly one task and one email per cycle", async () => {
    await office();
    const due = nextReviewDue(COMPLETED)!;
    await Promise.all(Array.from({ length: 8 }, () => ensureAccessReviewReminder(new Date(due.getTime() - 3 * 86400_000))));
    expect(await prisma.task.count({ where: { title: REVIEW_TASK_TITLE } })).toBe(1);

    const results = await Promise.all(Array.from({ length: 8 }, () => runAccessReviewReminders(new Date(due.getTime() + 3600_000))));
    expect(results.filter((r) => r.email === "sent")).toHaveLength(1);
    expect(results.every((r) => r.task === "open")).toBe(true);
    expect(sent).toHaveLength(1);
    expect(await prisma.ownerReminderLog.count()).toBe(1);
    expect(await prisma.task.count({ where: { title: REVIEW_TASK_TITLE } })).toBe(1);
  });

  it("a failed send is retried on the next run and still sends only once", async () => {
    await office();
    const due = nextReviewDue(COMPLETED)!;
    failNext = 1;
    expect(await ensureAccessReviewDueEmail(due)).toBe("not_sent");
    expect(await prisma.ownerReminderLog.count()).toBe(0);
    expect(await ensureAccessReviewDueEmail(new Date(due.getTime() + 3600_000))).toBe("sent");
    expect(await ensureAccessReviewDueEmail(new Date(due.getTime() + 7200_000))).toBe("already_sent");
    expect(sent).toHaveLength(1);
  });

  it("never reviewed: due now, one task and one email for the 'none' cycle; the first review closes it", async () => {
    const { tab } = await office(false);
    const now = chi("2026-11-05T12:00");
    expect(await runAccessReviewReminders(now)).toEqual({ task: "created", email: "sent" });
    expect(await runAccessReviewReminders(now)).toEqual({ task: "open", email: "already_sent" });
    expect((await reminders())[0].reminderKey).toBe("access-review:none");
    expect(sent[0].text).toContain("No quarterly access review has been completed yet");
    expect(await accessReviewBanner(tab, now)).toMatchObject({ stage: "due", title: "Access review due" });
    await completeAccessReview(tab, { summary: "Fictional first review.", vendors: allVendors() }, now);
    expect((await reminders()).map((t) => t.status)).toEqual(["DONE"]);
    expect(await accessReviewBanner(tab, now)).toBeNull();
  });

  it("adopts a reminder created before this change instead of adding a second one", async () => {
    const { tab } = await office();
    const old = await prisma.task.create({ data: { title: REVIEW_TASK_TITLE, priority: "HIGH", dueAt: nextReviewDue(COMPLETED), assigneeId: tab.id, createdById: tab.id } });
    expect(await ensureAccessReviewReminder(nextReviewDue(COMPLETED)!)).toBe("open");
    const t = await prisma.task.findUniqueOrThrow({ where: { id: old.id } });
    expect(t).toMatchObject({ ownerOnly: true, reminderKey: expect.stringMatching(/^access-review:/) });
    expect(await prisma.task.count()).toBe(1);
  });
});

describe("overdue persistence", () => {
  it("stays open while overdue; the owner can't mark it done — only a new review closes it", async () => {
    const { tab } = await office();
    const due = nextReviewDue(COMPLETED)!;
    await ensureAccessReviewReminder(due);
    const [task] = await reminders();
    await expect(setTaskDone(tab, task.id, true)).rejects.toThrow(/complete the access review/);
    for (const d of [10, 40, 120]) expect(await ensureAccessReviewReminder(new Date(due.getTime() + d * 86400_000))).toBe("open");
    expect((await reminders()).map((t) => t.status)).toEqual(["OPEN"]);
    // Even if it were closed some other way, the next run reopens the same task (never a second).
    await prisma.task.update({ where: { id: task.id }, data: { status: "DONE" } });
    expect(await ensureAccessReviewReminder(new Date(due.getTime() + 121 * 86400_000))).toBe("created");
    expect((await reminders()).map((t) => [t.id, t.status])).toEqual([[task.id, "OPEN"]]);
  });
});

describe("Edit Review corrections", () => {
  it("don't move the due date, start a new cycle, or create a second task or email", async () => {
    const { tab, review } = await office();
    const due = nextReviewDue(COMPLETED)!;
    await ensureAccessReviewReminder(new Date(due.getTime() - 5 * 86400_000));
    expect(await ensureAccessReviewDueEmail(due)).toBe("sent");
    const before = (await reminders())[0];

    await correctAccessReview(tab, review!.id, { expectedRevision: 0, reason: "Fictional typo fix", summary: "Fictional Q4 review: all access appropriate (corrected).", vendors: {} }, new Date(due.getTime() + 2 * 86400_000));
    const stored = await prisma.accessReview.findUniqueOrThrow({ where: { id: review!.id } });
    expect(stored.completedAt.getTime()).toBe(COMPLETED.getTime());
    expect(await prisma.accessReview.count()).toBe(1);
    expect((await accessReviewBoard(tab, new Date(due.getTime() + 3 * 86400_000))).status.dueAt?.getTime()).toBe(due.getTime());

    expect(await runAccessReviewReminders(new Date(due.getTime() + 3 * 86400_000))).toEqual({ task: "open", email: "already_sent" });
    const after = await reminders();
    expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({ id: before.id, status: "OPEN", reminderKey: before.reminderKey });
    expect(after[0].dueAt?.getTime()).toBe(due.getTime());
    expect(sent).toHaveLength(1);
  });
});

describe("owner-only visibility", () => {
  it("staff (even with every grant, or an Admin who isn't the owner) never see the task, the banner or the email", async () => {
    const { tab, daria, marcus } = await office();
    const due = nextReviewDue(COMPLETED)!;
    await runAccessReviewReminders(due);
    const [task] = await reminders();

    expect(await visibleTasksWhere(tab.id)).toEqual({});
    for (const who of [daria, marcus]) {
      expect(await prisma.task.count({ where: { ...(await visibleTasksWhere(who.id)), status: "OPEN" } })).toBe(0);
      await expect(setTaskDone(who, task.id, false)).rejects.toBeInstanceOf(ForbiddenError);
      await expect(saveTask(who, task.id, { title: "Hijack", assigneeId: who.id })).rejects.toBeInstanceOf(ForbiddenError);
      expect(await accessReviewBanner(who, due)).toBeNull();

      const list = await render(who, due, TasksPage as never, { view: "open", who: "all" });
      expect(list).not.toContain(REVIEW_TASK_TITLE);
      const cal = await render(who, due, TasksPage as never, { view: "calendar", month: "2027-02" });
      expect(cal).not.toContain(REVIEW_TASK_TITLE);
      const overview = await render(who, due, OwnerOverview as never);
      expect(overview).not.toContain("access-review-banner");
    }
    // The email went to the owner's own address only.
    expect(sent.flatMap((s) => s.to)).toEqual(["tabitha@tturnerassociates.com"]);
    expect((await prisma.task.findUniqueOrThrow({ where: { id: task.id } })).title).toBe(REVIEW_TASK_TITLE);
  });

  it("the owner sees it in Tasks (upcoming, then due) and on the Calendar on the due date, with the link", async () => {
    const { tab } = await office();
    const due = nextReviewDue(COMPLETED)!;
    const jan25 = chi("2027-01-25T10:00");
    await ensureAccessReviewReminder(jan25);
    const upcoming = await render(tab, jan25, TasksPage as never, { view: "open", who: "all" });
    expect(upcoming).toContain(REVIEW_TASK_TITLE);
    expect(upcoming).toContain(">Upcoming<");
    expect(upcoming).toContain(LINK);
    expect(upcoming).toContain(`href="${ACCESS_REVIEW_PATH}"`);
    // Its row offers "Open access review", not "Mark done".
    const row = upcoming.slice(upcoming.indexOf('data-testid="access-review-reminder-task"'), upcoming.indexOf("</li>", upcoming.indexOf('data-testid="access-review-reminder-task"')));
    expect(row).toContain("Open access review");
    expect(row).not.toContain("Mark done");
    expect(row).toContain("Only you can see this");

    const onDue = await render(tab, due, TasksPage as never, { view: "open", who: "me" });
    expect(onDue).toContain(REVIEW_TASK_TITLE);
    expect(onDue).not.toContain(">Upcoming<");

    const cal = await render(tab, due, TasksPage as never, { view: "calendar", month: "2027-02" });
    expect(cal).toContain(REVIEW_TASK_TITLE);
    expect(cal).toContain(`href="${ACCESS_REVIEW_PATH}"`);
  });
});

describe("Owner's Office banner", () => {
  it("shows upcoming / due / overdue states, linking to Access review, and nothing while quiet", async () => {
    const { tab } = await office();
    expect(await accessReviewBanner(tab, chi("2027-01-19T12:00"))).toBeNull();
    expect(await accessReviewBanner(tab, chi("2027-01-20T12:00"))).toMatchObject({ stage: "upcoming", title: "Access review upcoming in 14 days" });
    expect(await accessReviewBanner(tab, chi("2027-02-02T12:00"))).toMatchObject({ stage: "upcoming", title: "Access review upcoming in 1 day" });
    expect(await accessReviewBanner(tab, chi("2027-02-03T12:00"))).toMatchObject({ stage: "due", title: "Access review due", detail: "Due today, Wednesday, February 3, 2027." });
    expect(await accessReviewBanner(tab, chi("2027-02-04T12:00"))).toMatchObject({ stage: "overdue", title: "Access review overdue by 1 day" });
    expect(reminderBannerText({ stage: "quiet", dueAt: new Date(), daysUntil: 30 })).toBeNull();

    for (const [at, text] of [
      [chi("2027-01-27T09:00"), "Access review upcoming in 7 days"],
      [chi("2027-02-03T09:00"), "Access review due"],
      [chi("2027-02-13T09:00"), "Access review overdue by 10 days"],
    ] as const) {
      const html = await render(tab, at, OwnerOverview as never);
      expect(html).toContain('data-testid="access-review-banner"');
      expect(html).toContain(text);
      expect(html).toContain(`href="${ACCESS_REVIEW_PATH}"`);
    }
    expect(await render(tab, chi("2027-01-10T09:00"), OwnerOverview as never)).not.toContain("access-review-banner");
  });
});

describe("due email", () => {
  it("has the direct absolute link in both the text and the HTML, and no staff or client recipients", async () => {
    await office();
    await prisma.client.create({ data: { displayName: "Fictional Client LLC", email: "client.fictional@example.com" } }).catch(() => null);
    expect(await ensureAccessReviewDueEmail(nextReviewDue(COMPLETED)!)).toBe("sent");
    expect(sent).toHaveLength(1);
    expect(sent[0].subject).toBe("Quarterly access review due");
    expect(sent[0].text).toContain(LINK);
    expect(sent[0].html).toContain(`href="${LINK}"`);
    expect(sent[0].text).toContain("Wednesday, February 3, 2027");
    expect(sent[0].to).toEqual(["tabitha@tturnerassociates.com"]);
  });

  it("sends nothing before the owner has claimed the Owner's Office", async () => {
    await staffAccount("daria.fictional@example.com", "Daria Fictional", "STAFF");
    expect(await runAccessReviewReminders()).toEqual({ task: "no_owner", email: "no_owner" });
    expect(sent).toHaveLength(0);
    expect(await prisma.task.count()).toBe(0);
  });
});
