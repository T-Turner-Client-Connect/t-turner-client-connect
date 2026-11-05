import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { grantPerms, prisma, resetDb } from "./db";
import { ForbiddenError, type Actor } from "@/lib/auth/actor";
import { hashPassword } from "@/lib/auth/password";
import { claimOwnerOffice, officeTabs } from "@/lib/auth/owner";
import { officeAccessFor, setStaffPermissions } from "@/lib/auth/permissions";
import { GRANTABLE_KEYS } from "@/lib/permissions";
import { REVIEW_TASK_TITLE, VENDORS, nextReviewDue, offboardingChecklist, reviewStatus } from "@/lib/access-review";
import {
  accessReviewBoard,
  completeAccessReview,
  ensureAccessReviewReminder,
  getAccessReview,
  offboardStaff,
  offboardingBoard,
  setOffboardingItemDone,
  type StaffSnapshotRow,
} from "@/lib/services/access-review";
import { updateStaff } from "@/lib/services/users";

/** Fictional office only: "Tabitha Turner" (owner), "Daria Fictional", "Marcus Fictional". No network. */
const PASSWORD = "Owner-Strong-Pass-1";
const DAY = 24 * 60 * 60 * 1000;

beforeEach(async () => {
  await resetDb();
  vi.stubEnv("NOTIFICATIONS_ENABLED", "false");
  vi.stubGlobal("fetch", async (url: string | URL) => {
    throw new Error(`Unexpected network call in a test: ${String(url)}`);
  });
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

async function staffAccount(email: string, name: string, role: "ADMIN" | "STAFF", mfa = true): Promise<Actor> {
  const u = await prisma.user.create({ data: { email, name, role, passwordHash: await hashPassword(PASSWORD), mfaEnabledAt: mfa ? new Date() : null } });
  return { id: u.id, role: u.role, name: u.name, email: u.email };
}

async function office() {
  const tab = await staffAccount("tabitha@tturnerassociates.com", "Tabitha Turner", "ADMIN");
  const daria = await staffAccount("daria.fictional@example.com", "Daria Fictional", "STAFF");
  const marcus = await staffAccount("marcus.fictional@example.com", "Marcus Fictional", "ADMIN", false);
  await claimOwnerOffice(tab, PASSWORD);
  return { tab, daria, marcus };
}

const allVendors = (over: Record<string, { appropriate?: boolean; twoStep?: boolean; note?: string }> = {}) =>
  Object.fromEntries(VENDORS.map((v) => [v.key, { appropriate: true, twoStep: true, note: "", ...over[v.key] }]));

const session = (userId: string, tokenHash: string) => prisma.session.create({ data: { userId, tokenHash, mfaPassed: true, expiresAt: new Date(Date.now() + 3600_000) } });

describe("owner-only access", () => {
  it("shows the Access review tab to the owner only — not even to staff holding every grant", async () => {
    const { tab, daria } = await office();
    await grantPerms(daria.id, GRANTABLE_KEYS);
    expect(officeTabs(await officeAccessFor(tab.id)).map((t) => t.href)).toContain("/owner/access-review");
    expect(officeTabs(await officeAccessFor(daria.id)).map((t) => t.href)).not.toContain("/owner/access-review");
  });

  it("refuses every access-review and offboarding call from staff (and Admins who aren't the owner)", async () => {
    const { tab, daria, marcus } = await office();
    await grantPerms(daria.id, GRANTABLE_KEYS);
    const review = await completeAccessReview(tab, { summary: "Fictional baseline review.", vendors: allVendors() });
    for (const who of [daria, marcus]) {
      await expect(accessReviewBoard(who)).rejects.toBeInstanceOf(ForbiddenError);
      await expect(completeAccessReview(who, { summary: "Not allowed", vendors: allVendors() })).rejects.toBeInstanceOf(ForbiddenError);
      await expect(getAccessReview(who, review.id)).rejects.toBeInstanceOf(ForbiddenError);
      await expect(offboardingBoard(who)).rejects.toBeInstanceOf(ForbiddenError);
    }
    await expect(offboardStaff(daria, { userId: marcus.id, reason: "Not allowed", effectiveDate: "2026-11-04" })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(offboardStaff(marcus, { userId: daria.id, reason: "Not allowed", effectiveDate: "2026-11-04" })).rejects.toBeInstanceOf(ForbiddenError);
    // Nothing changed.
    expect((await prisma.user.findUniqueOrThrow({ where: { id: daria.id } })).active).toBe(true);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: marcus.id } })).active).toBe(true);
    expect(await prisma.staffOffboarding.count()).toBe(0);
    expect(await prisma.accessReview.count()).toBe(1);
  });

  it("never lets the owner offboard herself", async () => {
    const { tab } = await office();
    await expect(offboardStaff(tab, { userId: tab.id, reason: "Test", effectiveDate: "2026-11-04" })).rejects.toBeInstanceOf(ForbiddenError);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: tab.id } })).active).toBe(true);
  });
});

describe("quarterly access review", () => {
  it("saves a server-side snapshot of every staff account and the vendor answers, and audits it", async () => {
    const { tab, daria, marcus } = await office();
    await setStaffPermissions(tab, daria.id, ["billing.view", "billing.create"]);
    await prisma.user.update({ where: { id: daria.id }, data: { lastLoginAt: new Date("2026-11-01T15:00:00Z") } });
    await updateStaff(tab, marcus.id, { role: "STAFF" }); // a transfer: role change

    const board = await accessReviewBoard(tab);
    expect(board.status.due).toBe(true);
    expect(board.status.dueAt).toBeNull();
    // Transfers (role and permission changes) appear in the review's change list.
    expect(board.changes.some((c) => c.userName === "Daria Fictional" && c.text.includes("Billing and invoicing → Create"))).toBe(true);
    expect(board.changes.some((c) => c.userName === "Marcus Fictional" && c.text.includes("Role changed to Staff"))).toBe(true);

    const review = await completeAccessReview(tab, {
      summary: "Fictional Q4 review: all access appropriate.",
      findings: "Asked Marcus to set up two-step.",
      vendors: allVendors({ github: { twoStep: false, note: "Fictional: one seat without 2FA" } }),
    });
    const saved = await getAccessReview(tab, review.id);
    expect(saved?.reviewerId).toBe(tab.id);
    expect(saved?.summary).toBe("Fictional Q4 review: all access appropriate.");
    const staff = saved!.staff as StaffSnapshotRow[];
    expect(staff.map((s) => s.name).sort()).toEqual(["Daria Fictional", "Marcus Fictional", "Tabitha Turner"]);
    const d = staff.find((s) => s.id === daria.id)!;
    expect(d.grants.map((g) => g.key)).toEqual(["billing.view", "billing.create"]);
    expect(d.grants[0].label).toBe("Billing and invoicing → View");
    expect(d.twoStep).toBe(true);
    expect(d.lastLoginAt).toBe("2026-11-01T15:00:00.000Z");
    const m = staff.find((s) => s.id === marcus.id)!;
    expect(m.twoStep).toBe(false);
    expect(m.role).toBe("STAFF");
    expect(staff.find((s) => s.id === tab.id)!.isOwner).toBe(true);
    expect(saved!.vendors).toHaveLength(VENDORS.length);
    expect(saved!.vendors.find((v) => v.key === "github")).toMatchObject({ appropriate: true, twoStep: false, note: "Fictional: one seat without 2FA" });
    expect(saved!.changeList.length).toBeGreaterThan(0);

    const log = await prisma.ownerAuditLog.findFirst({ where: { action: "access_review.completed", entityId: review.id } });
    expect(log?.actorId).toBe(tab.id);
    expect(log?.details).toMatchObject({ staffAccounts: 3, vendorsWithoutTwoStep: ["github"], activeWithoutTwoStep: [marcus.id] });

    // After completion the next review is 90 days out and the change list starts over.
    const after = await accessReviewBoard(tab);
    expect(after.status.due).toBe(false);
    expect(after.status.dueAt?.getTime()).toBe(review.completedAt.getTime() + 90 * DAY);
    expect(after.changes).toHaveLength(0);
    expect(after.history.map((h) => h.id)).toEqual([review.id]);
    expect(after.history[0].flagged).toBe(1);
  });

  it("requires a summary", async () => {
    const { tab } = await office();
    await expect(completeAccessReview(tab, { summary: "  ", vendors: allVendors() })).rejects.toThrow(/summary/);
    expect(await prisma.accessReview.count()).toBe(0);
  });

  it("works out the due date: now when none exists, then 90 days after the last", () => {
    const last = new Date("2026-08-01T12:00:00Z");
    expect(nextReviewDue(null)).toBeNull();
    expect(reviewStatus(null).due).toBe(true);
    expect(nextReviewDue(last)?.toISOString()).toBe("2026-10-30T12:00:00.000Z");
    expect(reviewStatus(last, new Date("2026-10-29T12:00:00Z"))).toMatchObject({ due: false, daysLeft: 1 });
    expect(reviewStatus(last, new Date("2026-10-30T12:00:00Z"))).toMatchObject({ due: true, overdue: false });
    expect(reviewStatus(last, new Date("2026-11-04T12:00:00Z"))).toMatchObject({ due: true, overdue: true });
  });
});

describe("review reminder (automations cron)", () => {
  it("creates one high-priority task for the owner when due, never a second while it's open, and closes it on completion", async () => {
    const { tab } = await office();
    expect(await ensureAccessReviewReminder()).toBe("created");
    expect(await ensureAccessReviewReminder()).toBe("open");
    await Promise.all([ensureAccessReviewReminder(), ensureAccessReviewReminder()]);
    const tasks = await prisma.task.findMany({ where: { title: REVIEW_TASK_TITLE } });
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({ priority: "HIGH", status: "OPEN", assigneeId: tab.id });

    const review = await completeAccessReview(tab, { summary: "Fictional review done.", vendors: allVendors() });
    expect((await prisma.task.findUniqueOrThrow({ where: { id: tasks[0].id } })).status).toBe("DONE");
    expect(await ensureAccessReviewReminder()).toBe("not_due");
    // More than 14 days before the next due date: nothing yet (the upcoming window is tested in access-review-reminders.test.ts).
    expect(await ensureAccessReviewReminder(new Date(review.completedAt.getTime() + 75 * DAY))).toBe("not_due");

    // 90 days later: due again, a new single task.
    const later = new Date(review.completedAt.getTime() + 91 * DAY);
    expect(await ensureAccessReviewReminder(later)).toBe("created");
    expect(await ensureAccessReviewReminder(later)).toBe("open");
    expect(await prisma.task.count({ where: { title: REVIEW_TASK_TITLE, status: "OPEN" } })).toBe(1);
  });

  it("does nothing before the owner has claimed the Owner's Office", async () => {
    await staffAccount("someone.fictional@example.com", "Someone Fictional", "ADMIN");
    expect(await ensureAccessReviewReminder()).toBe("no_owner");
    expect(await prisma.task.count()).toBe(0);
  });
});

describe("offboarding", () => {
  it("deactivates the account, ends sessions, clears grants, creates the owner's checklist and audits it", async () => {
    const { tab, daria } = await office();
    await setStaffPermissions(tab, daria.id, ["billing.view", "billing.send", "receivables.view"]);
    await prisma.user.update({ where: { id: daria.id }, data: { identityAccessAll: true } });
    await session(daria.id, "fictional-1");
    await session(daria.id, "fictional-2");
    await prisma.passwordResetToken.create({ data: { userId: daria.id, tokenHash: "fictional-reset", expiresAt: new Date(Date.now() + 3600_000) } });
    await prisma.appointmentStaff.create({ data: { userId: daria.id } });

    const r = await offboardStaff(tab, { userId: daria.id, reason: "Fictional: left the firm.", effectiveDate: "2026-11-06" });
    expect(r.sessionsEnded).toBe(2);

    const u = await prisma.user.findUniqueOrThrow({ where: { id: daria.id } });
    expect(u.active).toBe(false);
    expect(u.identityAccessAll).toBe(false);
    expect(await prisma.session.count({ where: { userId: daria.id } })).toBe(0);
    expect(await prisma.staffPermission.count({ where: { userId: daria.id } })).toBe(0);
    expect((await officeAccessFor(daria.id)).any).toBe(false);
    expect((await prisma.passwordResetToken.findFirstOrThrow({ where: { userId: daria.id } })).usedAt).not.toBeNull();
    expect((await prisma.appointmentStaff.findUniqueOrThrow({ where: { userId: daria.id } })).active).toBe(false);

    // Every removed grant is in the permission history.
    const events = await prisma.staffPermissionEvent.findMany({ where: { userId: daria.id, source: "offboarding" } });
    expect(events.map((e) => `${e.area}.${e.action}`).sort()).toEqual(["billing.send", "billing.view", "receivables.view"]);
    expect(events.every((e) => e.fromAllowed && !e.toAllowed && e.actorId === tab.id)).toBe(true);

    const record = await prisma.staffOffboarding.findUniqueOrThrow({ where: { id: r.id }, include: { items: { include: { task: true }, orderBy: { seq: "asc" } } } });
    expect(record).toMatchObject({ userName: "Daria Fictional", reason: "Fictional: left the firm.", offboardedById: tab.id, sessionsEnded: 2 });
    expect(record.effectiveDate.toISOString().slice(0, 10)).toBe("2026-11-06");
    expect(record.removedGrants).toEqual(expect.arrayContaining(["billing.view", "billing.send", "receivables.view", "legacy:identityAccessAll"]));

    // Checklist: TaxAct, Google Workspace email, every vendor account, alarm codes, shared passwords, keys/devices/scan key.
    const expected = offboardingChecklist();
    expect(record.items.map((i) => i.key)).toEqual(expected.map((e) => e.key));
    expect(record.items[0].label).toMatch(/^TaxAct/);
    expect(record.items[1].label).toMatch(/^Google Workspace/);
    for (const v of VENDORS) expect(record.items.some((i) => i.key === `vendor:${v.key}`)).toBe(true);
    for (const k of ["alarm_codes", "shared_passwords", "keys_devices"]) expect(record.items.some((i) => i.key === k)).toBe(true);
    expect(record.items.find((i) => i.key === "keys_devices")!.label).toMatch(/scan key/);
    for (const i of record.items) {
      expect(i.task).toMatchObject({ assigneeId: tab.id, priority: "HIGH", status: "OPEN" });
      expect(i.task!.details).not.toContain("left the firm"); // the reason stays on the record
    }

    expect(await prisma.ownerAuditLog.count({ where: { action: "staff.offboarded", entityId: daria.id, actorId: tab.id } })).toBe(1);
    expect(await prisma.auditLog.count({ where: { action: "user.updated", entityId: daria.id } })).toBe(1);
    const shared = await prisma.auditLog.findFirstOrThrow({ where: { action: "user.offboarded", entityId: daria.id } });
    expect(JSON.stringify(shared.details)).not.toContain("left the firm");

    // It shows in the next access review's change list and snapshot.
    const board = await accessReviewBoard(tab);
    expect(board.staff.find((s) => s.id === daria.id)).toMatchObject({ active: false, grants: [] });
    expect(board.changes.some((c) => c.userName === "Daria Fictional" && c.text.startsWith("Offboarded"))).toBe(true);
    expect(board.changes.some((c) => c.text.includes("(offboarding)"))).toBe(true);
  });

  it("tracks checklist completion through the tasks", async () => {
    const { tab, daria } = await office();
    const r = await offboardStaff(tab, { userId: daria.id, reason: "Fictional transfer out.", effectiveDate: "2026-11-04" });
    let board = await offboardingBoard(tab);
    expect(board.candidates.map((c) => c.id)).not.toContain(daria.id);
    const entry = board.history.find((h) => h.id === r.id)!;
    expect(entry.done).toBe(0);
    await setOffboardingItemDone(tab, entry.items[0].id, true);
    // Finishing a task on the Tasks page counts too.
    await prisma.task.update({ where: { id: entry.items[1].taskId! }, data: { status: "DONE", completedAt: new Date() } });
    board = await offboardingBoard(tab);
    expect(board.history[0].done).toBe(2);
    expect(board.history[0].total).toBe(offboardingChecklist().length);
    await setOffboardingItemDone(tab, entry.items[0].id, false);
    expect((await offboardingBoard(tab)).history[0].done).toBe(1);
    expect(await prisma.ownerAuditLog.count({ where: { action: "offboarding.item_done" } })).toBe(1);
  });

  it("requires a reason and an effective date", async () => {
    const { tab, daria } = await office();
    await expect(offboardStaff(tab, { userId: daria.id, reason: "", effectiveDate: "2026-11-04" })).rejects.toThrow(/reason/);
    await expect(offboardStaff(tab, { userId: daria.id, reason: "Fictional", effectiveDate: "" })).rejects.toThrow(/effective date/);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: daria.id } })).active).toBe(true);
  });

  it("Settings → Team deactivation still ends sessions (shared path)", async () => {
    const { tab, daria } = await office();
    await session(daria.id, "fictional-3");
    await updateStaff(tab, daria.id, { active: false });
    expect(await prisma.session.count({ where: { userId: daria.id } })).toBe(0);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: daria.id } })).active).toBe(false);
  });
});
