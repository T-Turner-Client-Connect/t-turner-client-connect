import "server-only";
import type { Prisma, Role } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { audit } from "@/lib/audit";
import { assertOwner } from "@/lib/auth/owner";
import type { Actor } from "@/lib/auth/actor";
import { ForbiddenError } from "@/lib/auth/actor";
import { ALL_KEYS, GRANTABLE_KEYS, labelOf } from "@/lib/permissions";
import {
  REVIEW_TASK_TITLE,
  VENDORS,
  offboardingChecklist,
  reviewStatus,
  type VendorAnswer,
} from "@/lib/access-review";
import { ValidationError } from "./clients";
import { applyStaffUpdate } from "./users";

/**
 * Owner's Office → Access review (owner only). Two things Plaid asks about:
 * - periodic access reviews: a quarterly snapshot of every staff account (role, grants, two-step,
 *   last sign-in) plus a vendor-account checklist, saved with the owner's summary;
 * - de-provisioning: "Offboard" deactivates the Client Connect account at once (sessions end,
 *   grants are removed) and turns every system outside Client Connect into owner tasks.
 * Every call checks the primary owner binding in the database (assertOwner).
 */

const LEGACY_GRANTS = [
  { field: "identityAccessAll", label: "Identity documents for every client (Settings → Team)" },
  { field: "bookkeepingBillingAccess", label: "Bookkeeping billing (legacy toggle)" },
  { field: "businessConversionAccess", label: "May request Managed Business conversions" },
  { field: "ownerPermissionsAccess", label: "May set business owners' portal permissions" },
] as const;

export type StaffSnapshotRow = {
  id: string;
  name: string;
  email: string;
  role: Role;
  active: boolean;
  isOwner: boolean;
  grants: { key: string; label: string }[];
  otherGrants: string[];
  twoStep: boolean;
  lastLoginAt: string | null;
  createdAt: string;
};

export type AccessChange = { at: string; actorName: string; userName: string; text: string };

/** Every staff account — active and inactive — as it stands right now. */
async function staffSnapshot(): Promise<StaffSnapshotRow[]> {
  const [users, primary, grants] = await Promise.all([
    prisma.user.findMany({ orderBy: [{ active: "desc" }, { name: "asc" }] }),
    prisma.ownerAccess.findFirst({ where: { isPrimary: true, revokedAt: null }, select: { userId: true } }),
    prisma.staffPermission.findMany({ select: { userId: true, area: true, action: true } }),
  ]);
  const grantable = new Set<string>(GRANTABLE_KEYS);
  const catalog = new Map(ALL_KEYS.map((k, i) => [k as string, i]));
  return users.map((u) => {
    const isOwner = u.id === primary?.userId;
    const keys = isOwner
      ? []
      : grants
          .filter((g) => g.userId === u.id)
          .map((g) => `${g.area}.${g.action}`)
          .filter((k) => grantable.has(k))
          .sort((a, b) => (catalog.get(a) ?? 0) - (catalog.get(b) ?? 0));
    return {
      id: u.id,
      name: u.name,
      email: u.email,
      role: u.role,
      active: u.active,
      isOwner,
      grants: isOwner ? [{ key: "owner", label: "Owner — every permission (permanent)" }] : keys.map((k) => ({ key: k, label: labelOf(k) })),
      otherGrants: LEGACY_GRANTS.filter((g) => u[g.field]).map((g) => g.label),
      twoStep: !!u.mfaEnabledAt,
      lastLoginAt: u.lastLoginAt?.toISOString() ?? null,
      createdAt: u.createdAt.toISOString(),
    };
  });
}

/**
 * Access changes since `since` (all time when null): permission grants and revokes (transfers),
 * role and active changes from Settings → Team, and offboardings. Newest first.
 */
async function accessChangesSince(since: Date | null, take = 200): Promise<AccessChange[]> {
  const after = since ? { gt: since } : undefined;
  const [perms, updates, offboardings] = await Promise.all([
    prisma.staffPermissionEvent.findMany({ where: { createdAt: after }, orderBy: { createdAt: "desc" }, take }),
    prisma.auditLog.findMany({ where: { action: "user.updated", entityType: "User", createdAt: after }, orderBy: { createdAt: "desc" }, take }),
    prisma.staffOffboarding.findMany({ where: { createdAt: after }, orderBy: { createdAt: "desc" }, take }),
  ]);
  const ids = [...new Set([...perms.flatMap((p) => [p.actorId, p.userId]), ...updates.flatMap((u) => [u.actorId ?? "", u.entityId ?? ""])])].filter(Boolean);
  const names = new Map((await prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } })).map((u) => [u.id, u.name]));
  const name = (id: string | null) => (id === "system" ? "Data migration" : (names.get(id ?? "") ?? "Former staff member"));
  const rows: AccessChange[] = [
    ...perms.map((p) => ({
      at: p.createdAt.toISOString(),
      actorName: name(p.actorId),
      userName: name(p.userId),
      text: `${p.toAllowed ? "Granted" : "Removed"} ${labelOf(`${p.area}.${p.action}`)}${p.source === "offboarding" ? " (offboarding)" : ""}`,
    })),
    ...updates.map((u) => {
      const d = (u.details ?? {}) as { role?: string; active?: boolean };
      const parts = [d.role ? `Role changed to ${d.role === "ADMIN" ? "Admin" : "Staff"}` : null, d.active === false ? "Account deactivated (sessions ended)" : d.active === true ? "Account reactivated" : null].filter(Boolean);
      return { at: u.createdAt.toISOString(), actorName: name(u.actorId), userName: name(u.entityId), text: parts.join("; ") || "Account updated" };
    }),
    ...offboardings.map((o) => ({ at: o.createdAt.toISOString(), actorName: o.offboardedByName, userName: o.userName, text: `Offboarded (effective ${o.effectiveDate.toISOString().slice(0, 10)})` })),
  ];
  return rows.sort((a, b) => b.at.localeCompare(a.at)).slice(0, take);
}

const lastReview = () => prisma.accessReview.findFirst({ orderBy: { completedAt: "desc" } });

/** The Access review screen: live snapshot, what changed since the last review, and history. */
export async function accessReviewBoard(actor: Actor, now = new Date()) {
  await assertOwner(actor);
  const last = await lastReview();
  const [staff, changes, history] = await Promise.all([
    staffSnapshot(),
    accessChangesSince(last?.completedAt ?? null, 100),
    prisma.accessReview.findMany({ orderBy: { completedAt: "desc" }, take: 40, select: { id: true, completedAt: true, reviewerName: true, summary: true, vendorAnswers: true, staffSnapshot: true } }),
  ]);
  return {
    status: reviewStatus(last?.completedAt, now),
    last,
    staff,
    changes,
    history: history.map((h) => {
      const answers = (h.vendorAnswers ?? []) as VendorAnswer[];
      return {
        id: h.id,
        completedAt: h.completedAt,
        reviewerName: h.reviewerName,
        summary: h.summary,
        staffCount: ((h.staffSnapshot ?? []) as unknown[]).length,
        flagged: answers.filter((a) => !a.appropriate || !a.twoStep).length,
      };
    }),
  };
}

export type ReviewInput = {
  summary: string;
  findings?: string;
  vendors: Record<string, { appropriate?: boolean; twoStep?: boolean; note?: string }>;
};

/**
 * Completes a review. The staff snapshot is taken on the server at this moment (never from the
 * form); the owner's answers cover the vendor accounts. Closes the open reminder task, if any.
 */
export async function completeAccessReview(actor: Actor, input: ReviewInput, now = new Date()) {
  await assertOwner(actor);
  const summary = input.summary.trim();
  if (summary.length < 3) throw new ValidationError("Write a short summary of the review before completing it.");
  if (summary.length > 5000) throw new ValidationError("Keep the summary under 5,000 characters.");
  const findings = (input.findings ?? "").trim().slice(0, 10000) || null;
  const answers: VendorAnswer[] = VENDORS.map((v) => {
    const a = input.vendors[v.key] ?? {};
    return { key: v.key, label: v.label, appropriate: !!a.appropriate, twoStep: !!a.twoStep, note: (a.note ?? "").trim().slice(0, 1000) };
  });
  const previous = await lastReview();
  const [snapshot, changes] = await Promise.all([staffSnapshot(), accessChangesSince(previous?.completedAt ?? null)]);
  return prisma.$transaction(async (tx) => {
    const review = await tx.accessReview.create({
      data: {
        reviewerId: actor.id,
        reviewerName: actor.name,
        completedAt: now,
        summary,
        findings,
        staffSnapshot: snapshot as unknown as Prisma.InputJsonValue,
        vendorAnswers: answers as unknown as Prisma.InputJsonValue,
        changes: changes as unknown as Prisma.InputJsonValue,
      },
    });
    const closed = await tx.task.updateMany({ where: { title: REVIEW_TASK_TITLE, status: "OPEN" }, data: { status: "DONE", completedAt: now } });
    await tx.ownerAuditLog.create({
      data: {
        actorId: actor.id,
        action: "access_review.completed",
        entityType: "AccessReview",
        entityId: review.id,
        details: {
          staffAccounts: snapshot.length,
          activeAccounts: snapshot.filter((s) => s.active).length,
          activeWithoutTwoStep: snapshot.filter((s) => s.active && !s.twoStep).map((s) => s.id),
          vendorsNotAppropriate: answers.filter((a) => !a.appropriate).map((a) => a.key),
          vendorsWithoutTwoStep: answers.filter((a) => !a.twoStep).map((a) => a.key),
          changesSincePrevious: changes.length,
          reminderTasksClosed: closed.count,
        },
      },
    });
    return review;
  });
}

/** One saved review, for the printable view. */
export async function getAccessReview(actor: Actor, id: string) {
  await assertOwner(actor);
  const r = await prisma.accessReview.findUnique({ where: { id } });
  if (!r) return null;
  return { ...r, staff: r.staffSnapshot as unknown as StaffSnapshotRow[], vendors: r.vendorAnswers as unknown as VendorAnswer[], changeList: (r.changes ?? []) as unknown as AccessChange[] };
}

/**
 * Cron (hourly, automations): when a review is due — immediately if none has ever been completed,
 * otherwise 90 days after the last — the owner gets one high-priority task. One open task at a time:
 * a retried or overlapping run finds it and does nothing.
 */
export async function ensureAccessReviewReminder(now = new Date()): Promise<"created" | "open" | "not_due" | "no_owner"> {
  const owner = await prisma.ownerAccess.findFirst({ where: { isPrimary: true, revokedAt: null, user: { active: true } }, select: { userId: true } });
  if (!owner) return "no_owner";
  const last = await lastReview();
  const status = reviewStatus(last?.completedAt, now);
  if (!status.due) return "not_due";
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('access-review-reminder'))`;
    if (await tx.task.count({ where: { title: REVIEW_TASK_TITLE, status: "OPEN" } })) return "open" as const;
    await tx.task.create({
      data: {
        title: REVIEW_TASK_TITLE,
        details: last
          ? `The last access review was completed ${last.completedAt.toISOString().slice(0, 10)}. Open Owner's Office → Access review, check every staff account and vendor account, and complete the review with a summary.`
          : "No access review has been completed yet. Open Owner's Office → Access review, check every staff account and vendor account, and complete the review with a summary.",
        priority: "HIGH",
        dueAt: status.dueAt ?? now,
        assigneeId: owner.userId,
        createdById: owner.userId,
      },
    });
    await tx.ownerAuditLog.create({ data: { actorId: owner.userId, action: "access_review.reminder_created", entityType: "AccessReview", entityId: last?.id ?? null, details: { dueAt: (status.dueAt ?? now).toISOString(), automated: true } } });
    return "created" as const;
  });
}

// ---------------------------------------------------------------------------------------------
// Offboarding
// ---------------------------------------------------------------------------------------------

export type OffboardInput = { userId: string; reason: string; effectiveDate: string };

const ymd = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Offboards a staff member (terminated, or leaving the firm). In one transaction:
 * - deactivates the account through the same path as Settings → Team (every session ends);
 * - removes every Staff Access & Permissions grant (recorded in the permission history) and the
 *   older per-person grants; revokes any non-primary Owner's Office row, open invitation and
 *   unused password-reset link; takes them off the appointment calendar;
 * - records the offboarding and a checklist of owner tasks for every system outside Client Connect.
 * Owner only. Nobody can offboard the owner or themselves.
 */
export async function offboardStaff(actor: Actor, input: OffboardInput, now = new Date()) {
  await assertOwner(actor);
  const reason = input.reason.trim();
  if (reason.length < 3) throw new ValidationError("Give a reason for the offboarding.");
  if (reason.length > 2000) throw new ValidationError("Keep the reason under 2,000 characters.");
  if (!ymd.test(input.effectiveDate) || Number.isNaN(Date.parse(`${input.effectiveDate}T00:00:00Z`))) throw new ValidationError("Choose the effective date.");
  const effectiveDate = new Date(`${input.effectiveDate}T00:00:00Z`);
  if (input.userId === actor.id) throw new ForbiddenError("You can't offboard yourself.");
  const target = await prisma.user.findUnique({ where: { id: input.userId } });
  if (!target) throw new ValidationError("Staff member not found.");
  if (await prisma.ownerAccess.count({ where: { userId: target.id, isPrimary: true } })) throw new ForbiddenError("The owner's account can't be offboarded.");

  // Tasks are due on the effective date (or today, if that date has passed), at 18:00 UTC (midday in Chicago).
  const dueAt = new Date(Math.max(new Date(`${input.effectiveDate}T18:00:00Z`).getTime(), now.getTime()));

  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`staff-perm:${target.id}`}))`;
    const { sessionsEnded } = target.active ? await applyStaffUpdate(tx, actor, target.id, { active: false }) : { sessionsEnded: (await tx.session.deleteMany({ where: { userId: target.id } })).count };

    const rows = await tx.staffPermission.findMany({ where: { userId: target.id } });
    const removedKeys = rows.map((r) => `${r.area}.${r.action}`);
    if (rows.length) {
      await tx.staffPermission.deleteMany({ where: { userId: target.id } });
      await tx.staffPermissionEvent.createMany({ data: rows.map((r) => ({ actorId: actor.id, userId: target.id, area: r.area, action: r.action, fromAllowed: true, toAllowed: false, source: "offboarding" })) });
      await tx.ownerAuditLog.create({ data: { actorId: actor.id, action: "staff.permissions_changed", entityType: "User", entityId: target.id, details: { added: [], removed: removedKeys, source: "offboarding" } } });
    }
    const legacy = LEGACY_GRANTS.filter((g) => target[g.field]).map((g) => g.field);
    if (legacy.length) {
      await tx.user.update({ where: { id: target.id }, data: { identityAccessAll: false, bookkeepingBillingAccess: false, businessConversionAccess: false, ownerPermissionsAccess: false } });
    }
    await tx.ownerAccess.updateMany({ where: { userId: target.id, isPrimary: false, revokedAt: null }, data: { revokedAt: now } });
    await tx.invite.updateMany({ where: { email: target.email, acceptedAt: null, revokedAt: null }, data: { revokedAt: now } });
    await tx.passwordResetToken.updateMany({ where: { userId: target.id, usedAt: null }, data: { usedAt: now } });
    await tx.appointmentStaff.updateMany({ where: { userId: target.id, active: true }, data: { active: false } });

    const [clients, openTasks] = await Promise.all([
      tx.client.count({ where: { assignedToId: target.id } }),
      tx.task.count({ where: { assigneeId: target.id, status: "OPEN" } }),
    ]);

    const record = await tx.staffOffboarding.create({
      data: {
        userId: target.id,
        userName: target.name,
        userEmail: target.email,
        userRole: target.role,
        reason,
        effectiveDate,
        offboardedById: actor.id,
        offboardedByName: actor.name,
        removedGrants: [...removedKeys, ...legacy.map((f) => `legacy:${f}`)],
        sessionsEnded,
        createdAt: now,
      },
    });

    // The reason stays on the offboarding record (owner only); tasks carry no reason.
    const items = offboardingChecklist();
    for (const [i, item] of items.entries()) {
      const details =
        item.key === "reassign_work"
          ? `${target.name} has ${clients} assigned client${clients === 1 ? "" : "s"} and ${openTasks} open task${openTasks === 1 ? "" : "s"} in Client Connect. Their Client Connect account is already deactivated.`
          : `Offboarding ${target.name} (${target.email}), effective ${input.effectiveDate}. Their Client Connect account is already deactivated; this step is outside Client Connect. Mark it done when finished (Owner's Office → Access review → Offboarding, or here).`;
      const task = await tx.task.create({
        data: { title: `Offboard ${target.name} — ${item.label}`.slice(0, 200), details, priority: "HIGH", dueAt, assigneeId: actor.id, createdById: actor.id },
      });
      await tx.staffOffboardingItem.create({ data: { offboardingId: record.id, seq: i, key: item.key, label: item.label, taskId: task.id } });
    }

    await tx.ownerAuditLog.create({
      data: {
        actorId: actor.id,
        action: "staff.offboarded",
        entityType: "User",
        entityId: target.id,
        details: { offboardingId: record.id, effectiveDate: input.effectiveDate, sessionsEnded, removedGrants: record.removedGrants, checklistItems: items.length },
      },
    });
    // The shared log says the account was offboarded (no reason: that stays in the Owner's Office).
    await audit(tx, { actorId: actor.id, action: "user.offboarded", entityType: "User", entityId: target.id, details: { effectiveDate: input.effectiveDate } });
    return { ...record, items: items.length };
  });
}

/** The Offboarding screen: who can be offboarded and every past offboarding with its checklist. */
export async function offboardingBoard(actor: Actor) {
  await assertOwner(actor);
  const [candidates, history] = await Promise.all([
    prisma.user.findMany({
      where: { active: true, id: { not: actor.id }, OR: [{ ownerAccess: { is: null } }, { ownerAccess: { is: { isPrimary: false } } }] },
      select: { id: true, name: true, email: true, role: true },
      orderBy: { name: "asc" },
    }),
    prisma.staffOffboarding.findMany({
      orderBy: { createdAt: "desc" },
      take: 50,
      include: { items: { orderBy: { seq: "asc" }, include: { task: { select: { id: true, status: true, completedAt: true } } } } },
    }),
  ]);
  return {
    candidates,
    history: history.map((o) => {
      const items = o.items.map((i) => ({ id: i.id, label: i.label, taskId: i.taskId, done: i.task?.status === "DONE", completedAt: i.task?.completedAt ?? null, missing: !i.task }));
      return { ...o, items, done: items.filter((i) => i.done).length, total: items.length };
    }),
  };
}

/** Ticks (or unticks) one checklist line: its task is marked done or reopened. */
export async function setOffboardingItemDone(actor: Actor, itemId: string, done: boolean, now = new Date()) {
  await assertOwner(actor);
  const item = await prisma.staffOffboardingItem.findUnique({ where: { id: itemId } });
  if (!item) throw new ValidationError("Checklist item not found.");
  if (!item.taskId) throw new ValidationError("That checklist task was deleted from Tasks.");
  const taskId = item.taskId;
  await prisma.$transaction(async (tx) => {
    await tx.task.update({ where: { id: taskId }, data: { status: done ? "DONE" : "OPEN", completedAt: done ? now : null } });
    await audit(tx, { actorId: actor.id, action: done ? "task.completed" : "task.reopened", entityType: "Task", entityId: taskId });
    await tx.ownerAuditLog.create({ data: { actorId: actor.id, action: done ? "offboarding.item_done" : "offboarding.item_reopened", entityType: "StaffOffboarding", entityId: item.offboardingId, details: { key: item.key } } });
  });
}
