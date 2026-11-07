import "server-only";
import type { Prisma, Role } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { audit } from "@/lib/audit";
import { assertOwner, primaryOwnerAccess } from "@/lib/auth/owner";
import { appUrl } from "@/lib/integrations";
import { brandedEmailHtml, sendEmail } from "@/lib/email";
import type { Actor } from "@/lib/auth/actor";
import { ForbiddenError } from "@/lib/auth/actor";
import { ALL_KEYS, GRANTABLE_KEYS, labelOf } from "@/lib/permissions";
import {
  ACCESS_REVIEW_PATH,
  REVIEW_TASK_TITLE,
  VENDORS,
  dueEmailKey,
  fmtDueDate,
  reminderBannerText,
  reminderStage,
  reminderTaskKey,
  reviewCycleKey,
  type ReminderStage,
  offboardingChecklist,
  reviewStatus,
  type EditableReview,
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
    prisma.accessReview.findMany({ orderBy: { completedAt: "desc" }, take: 40, select: { id: true, completedAt: true, reviewerName: true, summary: true, vendorAnswers: true, staffSnapshot: true, _count: { select: { revisions: true } } } }),
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
        corrections: h._count.revisions,
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
    const closed = await tx.task.updateMany({ where: { status: "OPEN", OR: [{ title: REVIEW_TASK_TITLE }, { reminderKey: { startsWith: "access-review:" } }] }, data: { status: "DONE", completedAt: now } });
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

/** One saved review, for the printable view, with its correction history (oldest first). */
export async function getAccessReview(actor: Actor, id: string) {
  await assertOwner(actor);
  const r = await prisma.accessReview.findUnique({ where: { id }, include: { revisions: { orderBy: { revisionNumber: "asc" } } } });
  if (!r) return null;
  const { revisions, ...review } = r;
  const corrections: ReviewCorrection[] = revisions.map((v) => ({
    id: v.id,
    revisionNumber: v.revisionNumber,
    editedById: v.editedById,
    editedByName: v.editedByName,
    editedAt: v.editedAt,
    reason: v.reason,
    previous: v.previous as unknown as EditableReview,
    updated: v.updated as unknown as EditableReview,
    changedFields: v.changedFields,
  }));
  return {
    ...review,
    staff: r.staffSnapshot as unknown as StaffSnapshotRow[],
    vendors: r.vendorAnswers as unknown as VendorAnswer[],
    changeList: (r.changes ?? []) as unknown as AccessChange[],
    corrections,
    revision: corrections.at(-1)?.revisionNumber ?? 0,
    lastCorrection: corrections.at(-1) ?? null,
    // The values exactly as the review was completed: the first correction's "previous", or the review itself.
    original: corrections[0]?.previous ?? editableOf(review),
  };
}

// ---------------------------------------------------------------------------------------------
// Corrections (owner only)
// ---------------------------------------------------------------------------------------------

export type { EditableReview };

export type ReviewCorrection = {
  id: string;
  revisionNumber: number;
  editedById: string;
  editedByName: string;
  editedAt: Date;
  reason: string;
  previous: EditableReview;
  updated: EditableReview;
  changedFields: string[];
};

export type CorrectionInput = {
  /** The revision number the edit form was opened at (0 = never corrected). */
  expectedRevision: number;
  reason: string;
  summary: string;
  findings?: string;
  vendors: Record<string, { appropriate?: boolean; twoStep?: boolean; note?: string }>;
};

const CORRECTION_KEYS = new Set(["expectedRevision", "reason", "summary", "findings", "vendors"]);
const VENDOR_FIELDS = new Set(["appropriate", "twoStep", "note"]);

function editableOf(r: { summary: string; findings: string | null; vendorAnswers: unknown }): EditableReview {
  return { summary: r.summary, findings: r.findings, vendorAnswers: r.vendorAnswers as VendorAnswer[] };
}

/** "vendor:github.twoStep"-style names of what differs between two versions (summary and findings first). */
export function changedFieldsOf(before: EditableReview, after: EditableReview): string[] {
  const out: string[] = [];
  if (before.summary !== after.summary) out.push("summary");
  if ((before.findings ?? null) !== (after.findings ?? null)) out.push("findings");
  for (const a of after.vendorAnswers) {
    const b = before.vendorAnswers.find((x) => x.key === a.key);
    for (const f of ["appropriate", "twoStep", "note"] as const) if (!b || b[f] !== a[f]) out.push(`vendor:${a.key}.${f}`);
  }
  return out;
}

/**
 * Corrects a completed review: only its summary, findings and vendor answers. Everything else —
 * staff snapshot, completion time, reviewer, change list, created time — is never touched, so the
 * 90-day schedule (based on completedAt) stays where it was and no new review is created.
 * Each save appends one AccessReviewRevision holding the exact previous and updated values (the
 * first one's "previous" is the original) and one OwnerAuditLog entry. Refused when nothing
 * changed, when the reason is missing, or when someone saved a correction after the form was opened.
 */
export async function correctAccessReview(actor: Actor, reviewId: string, input: CorrectionInput, now = new Date()) {
  await assertOwner(actor);
  // Only the editable fields are accepted: anything else (completedAt, staffSnapshot, reviewer…) is refused.
  const extra = Object.keys(input ?? {}).filter((k) => !CORRECTION_KEYS.has(k));
  if (extra.length) throw new ValidationError(`These can't be changed on a completed review: ${extra.join(", ")}.`);
  if (!Number.isInteger(input.expectedRevision) || input.expectedRevision < 0) throw new ValidationError("Reload the review and try again.");
  const reason = (input.reason ?? "").trim();
  if (reason.length < 3) throw new ValidationError("Give a short reason for the correction.");
  if (reason.length > 500) throw new ValidationError("Keep the reason under 500 characters.");
  const summary = (input.summary ?? "").trim();
  if (summary.length < 3) throw new ValidationError("The summary can't be empty.");
  if (summary.length > 5000) throw new ValidationError("Keep the summary under 5,000 characters.");
  const findings = (input.findings ?? "").trim().slice(0, 10000) || null;
  const vendorsIn = input.vendors ?? {};

  return prisma.$transaction(async (tx) => {
    // One correction at a time per review: the row lock makes the revision check below exact.
    const locked = await tx.$queryRaw<{ id: string }[]>`SELECT "id" FROM "AccessReview" WHERE "id" = ${reviewId} FOR UPDATE`;
    if (!locked.length) throw new ValidationError("Access review not found.");
    const review = await tx.accessReview.findUniqueOrThrow({ where: { id: reviewId } });
    const latest = await tx.accessReviewRevision.findFirst({ where: { reviewId }, orderBy: { revisionNumber: "desc" }, select: { revisionNumber: true } });
    const current = latest?.revisionNumber ?? 0;
    if (current !== input.expectedRevision) {
      throw new ValidationError(`This review was corrected (revision ${current}) after you opened it. Nothing was saved — reload the page to see the latest version, then make your correction again.`);
    }
    const before = editableOf(review);
    const known = new Set(before.vendorAnswers.map((v) => v.key));
    const unknown = Object.keys(vendorsIn).filter((k) => !known.has(k));
    if (unknown.length) throw new ValidationError(`These vendor accounts aren't on this review: ${unknown.join(", ")}.`);
    for (const [k, v] of Object.entries(vendorsIn)) {
      const bad = Object.keys(v ?? {}).filter((f) => !VENDOR_FIELDS.has(f));
      if (bad.length) throw new ValidationError(`Only "Access still appropriate", "Two-step verification on" and the note can be changed (${k}).`);
    }
    const vendorAnswers: VendorAnswer[] = before.vendorAnswers.map((a) => {
      const v = vendorsIn[a.key];
      if (!v) return a;
      return {
        key: a.key,
        label: a.label,
        appropriate: v.appropriate === undefined ? a.appropriate : !!v.appropriate,
        twoStep: v.twoStep === undefined ? a.twoStep : !!v.twoStep,
        note: v.note === undefined ? a.note : v.note.trim().slice(0, 1000),
      };
    });
    const after: EditableReview = { summary, findings, vendorAnswers };
    const changedFields = changedFieldsOf(before, after);
    if (!changedFields.length) throw new ValidationError("Nothing changed, so nothing was saved.");

    const revisionNumber = current + 1;
    const revision = await tx.accessReviewRevision.create({
      data: {
        reviewId,
        revisionNumber,
        editedById: actor.id,
        editedByName: actor.name,
        editedAt: now,
        reason,
        previous: before as unknown as Prisma.InputJsonValue,
        updated: after as unknown as Prisma.InputJsonValue,
        changedFields,
      },
    });
    // Only the three editable columns are written; completedAt, staffSnapshot, reviewer, changes and createdAt are not.
    await tx.accessReview.update({ where: { id: reviewId }, data: { summary, findings, vendorAnswers: vendorAnswers as unknown as Prisma.InputJsonValue } });
    await tx.ownerAuditLog.create({
      data: {
        actorId: actor.id,
        action: "access_review.corrected",
        entityType: "AccessReview",
        entityId: reviewId,
        // Field names and vendor keys only — no free text.
        details: {
          reviewId,
          revisionId: revision.id,
          revisionNumber,
          changedFields,
          vendorKeysChanged: [...new Set(changedFields.filter((f) => f.startsWith("vendor:")).map((f) => f.slice(7).split(".")[0]))],
        },
      },
    });
    return revision;
  });
}

// ---------------------------------------------------------------------------------------------
// Reminders: one owner-only task per review cycle (from 14 days before the due date), one email
// when the review becomes due, and the Owner's Office banner. Never shown or sent to staff or clients.
// ---------------------------------------------------------------------------------------------

const primaryOwner = () =>
  prisma.ownerAccess.findFirst({ where: { isPrimary: true, revokedAt: null, user: { active: true } }, select: { userId: true, user: { select: { email: true, name: true } } } });

/** Absolute link to Owner's Office → Access review (the app's base URL). */
export const accessReviewUrl = () => `${appUrl()}${ACCESS_REVIEW_PATH}`;

function reminderDetails(last: { completedAt: Date } | null, s: ReminderStage) {
  const when = s.dueAt ? `due ${fmtDueDate(s.dueAt)}` : "due now";
  const lead = last
    ? `The quarterly access review is ${when} (90 days after the last review, completed ${fmtDueDate(last.completedAt)}).`
    : "No access review has been completed yet, so one is due now.";
  return `${lead} Open Owner's Office → Access review, check every staff account and vendor account, and complete the review with a summary. This reminder closes when the new review is completed.\n${accessReviewUrl()}`;
}

/**
 * Cron (hourly, automations): from 14 days before the due date — immediately if no review has ever
 * been completed — the owner has one high-priority, owner-only task due on the due date. Exactly
 * one task per review cycle (Task.reminderKey is unique, and an advisory lock serializes runs): a
 * retried or overlapping run finds it and does nothing. It stays open while overdue; only
 * completing a new review closes it (completeAccessReview).
 */
export async function ensureAccessReviewReminder(now = new Date()): Promise<"created" | "open" | "not_due" | "no_owner"> {
  const owner = await primaryOwner();
  if (!owner) return "no_owner";
  const last = await lastReview();
  const s = reminderStage(last?.completedAt, now);
  if (s.stage === "quiet") return "not_due";
  const key = reminderTaskKey(reviewCycleKey(last?.id));
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('access-review-reminder'))`;
    const open = await tx.task.findFirst({ where: { title: REVIEW_TASK_TITLE, status: "OPEN" }, select: { id: true, reminderKey: true, ownerOnly: true } });
    if (open) {
      // A reminder from before this change: make it owner-only and part of this cycle.
      if (!open.ownerOnly || !open.reminderKey) await tx.task.update({ where: { id: open.id }, data: { ownerOnly: true, reminderKey: open.reminderKey ?? key } });
      return "open" as const;
    }
    const data = {
      title: REVIEW_TASK_TITLE,
      details: reminderDetails(last, s),
      priority: "HIGH" as const,
      dueAt: s.dueAt ?? now,
      assigneeId: owner.userId,
      ownerOnly: true,
    };
    const existing = await tx.task.findUnique({ where: { reminderKey: key }, select: { id: true } });
    // This cycle's task was closed some other way (e.g. before the review was completed): reopen it, never a second one.
    if (existing) await tx.task.update({ where: { id: existing.id }, data: { ...data, status: "OPEN", completedAt: null } });
    else await tx.task.create({ data: { ...data, reminderKey: key, createdById: owner.userId } });
    await tx.ownerAuditLog.create({ data: { actorId: owner.userId, action: "access_review.reminder_created", entityType: "AccessReview", entityId: last?.id ?? null, details: { dueAt: (s.dueAt ?? now).toISOString(), stage: s.stage, cycle: reviewCycleKey(last?.id), automated: true } } });
    return "created" as const;
  });
}

/** The owner's due email: subject, plain text and branded HTML, all with the direct link. */
export function accessReviewDueEmail(input: { ownerName: string; stage: ReminderStage; lastCompletedAt: Date | null; url: string }) {
  const { stage, lastCompletedAt, url } = input;
  const first = input.ownerName.split(" ")[0] || input.ownerName;
  const dueLine = stage.dueAt
    ? stage.stage === "overdue"
      ? `Your quarterly access review was due ${fmtDueDate(stage.dueAt)}.`
      : `Your quarterly access review is due today, ${fmtDueDate(stage.dueAt)}.`
    : "No quarterly access review has been completed yet, so one is due now.";
  const lastLine = lastCompletedAt ? `The last review was completed ${fmtDueDate(lastCompletedAt)}.` : null;
  const action = "Open Owner's Office → Access review, check every staff account and vendor account, and complete the review with a summary. The reminder in your Tasks closes when you do.";
  const paragraphs = [`Hi ${first},`, dueLine, ...(lastLine ? [lastLine] : []), action];
  return {
    subject: "Quarterly access review due",
    text: `${paragraphs.join("\n\n")}\n\nOpen the access review: ${url}\n\nThis reminder goes only to you as the owner. It is never sent to staff or clients.`,
    html: brandedEmailHtml({
      heading: "Quarterly access review due",
      paragraphs,
      button: { label: "Open the access review", url },
      note: `Direct link: ${url} — This reminder goes only to you as the owner. It is never sent to staff or clients.`,
    }),
  };
}

/**
 * Cron: one email to the owner when the review becomes due (on or after the due date, Chicago
 * time) — at most one per review cycle. The OwnerReminderLog row is claimed first (unique key), so
 * of two overlapping runs only one sends; if the send fails the claim is released and the next
 * hourly run tries again. Goes only to the primary owner's own staff email.
 */
export async function ensureAccessReviewDueEmail(now = new Date()): Promise<"sent" | "already_sent" | "not_due" | "no_owner" | "not_sent"> {
  const owner = await primaryOwner();
  if (!owner) return "no_owner";
  const last = await lastReview();
  const s = reminderStage(last?.completedAt, now);
  if (s.stage === "quiet" || s.stage === "upcoming") return "not_due";
  const key = dueEmailKey(reviewCycleKey(last?.id));
  const claimed = await prisma.ownerReminderLog.createMany({ data: [{ key, kind: "access_review_due_email" }], skipDuplicates: true });
  if (claimed.count === 0) return "already_sent";
  const mail = accessReviewDueEmail({ ownerName: owner.user.name, stage: s, lastCompletedAt: last?.completedAt ?? null, url: accessReviewUrl() });
  const res = await sendEmail({ to: owner.user.email, ...mail, idempotencyKey: key, tags: { category: "owner_reminder" } }).catch(() => ({ ok: false as const, reason: "network" as const, detail: "failed" }));
  if (!res.ok) {
    await prisma.ownerReminderLog.delete({ where: { key } });
    return "not_sent";
  }
  await prisma.ownerReminderLog.update({ where: { key }, data: { sentAt: now, providerId: res.providerId } });
  await prisma.ownerAuditLog.create({ data: { actorId: owner.userId, action: "access_review.due_email_sent", entityType: "AccessReview", entityId: last?.id ?? null, details: { cycle: reviewCycleKey(last?.id), automated: true } } });
  return "sent";
}

/** Hourly cron entry point: the task, then the email. */
export async function runAccessReviewReminders(now = new Date()) {
  const task = await ensureAccessReviewReminder(now).catch(() => "failed" as const);
  const email = await ensureAccessReviewDueEmail(now).catch(() => "failed" as const);
  return { task, email };
}

/**
 * Owner's Office banner: the stage and its text, for the owner only (null for anyone else, and
 * while the review is more than 14 days away).
 */
export async function accessReviewBanner(actor: Pick<Actor, "id">, now = new Date()) {
  if (!(await primaryOwnerAccess(actor.id))) return null;
  const last = await lastReview();
  const stage = reminderStage(last?.completedAt, now);
  const text = reminderBannerText(stage);
  return text ? { ...text, stage: stage.stage, href: ACCESS_REVIEW_PATH } : null;
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
