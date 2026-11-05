import "server-only";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { audit } from "@/lib/audit";
import { brandedEmailHtml, sendEmail } from "@/lib/email";
import { appUrl } from "@/lib/integrations";
import { daysBetween, officeToday } from "@/lib/tax/deadlines";
import { queuePortalNotification } from "@/lib/services/notifications";
import { complianceSettings } from "./settings";
import { primaryOwnerId } from "./access";
import { COMPLETE_FILING, effectiveDue } from "./obligations";

/**
 * Reminders and safeguards. Runs from the hourly cron (and right after an obligation is
 * activated, so a deadline already inside 30 days gets its reminder and prep task at once).
 *
 * - Prep task (Task, assigned) at prepTaskDays (30) before the adjusted due date; it stays open
 *   until the period completes.
 * - Staff reminders at each configured step (30/15/7/3/1 days) — the nearest step reached is sent,
 *   once — and a daily overdue escalation to the assigned staff AND the owner until resolved.
 * - Every reminder is one ComplianceReminder row per period, step, recipient and channel with a
 *   unique key, so concurrent or repeated runs can't duplicate anything.
 * - In-app reminders always work. Staff email only with the owner's "Compliance staff email
 *   reminders" switch; client notices only with "Compliance client notifications authorized" AND
 *   the entity's own switch. While a switch is off the send is recorded as HELD (nothing sent).
 *   Client SMS follow the existing portal notification preferences and consent checks.
 */

const isDup = (e: unknown) => e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002";

async function claim(data: { periodId: string; step: string; recipient: string; channel: string; status: string; detail?: string | null }) {
  const dedupeKey = `${data.periodId}:${data.step}:${data.recipient}:${data.channel}`;
  try {
    return await prisma.complianceReminder.create({ data: { ...data, dedupeKey } });
  } catch (e) {
    if (isDup(e)) return null;
    throw e;
  }
}

type PeriodCtx = Prisma.ComplianceFilingPeriodGetPayload<{ include: { obligation: true; entity: { include: { client: { select: { displayName: true } } } } } }>;

const periodLabel = (p: PeriodCtx) => `${p.obligation.formName} (${p.periodKey}) — ${p.entity.legalName || p.entity.dba || p.entity.client.displayName}`;

/** In-app + (switch-gated) email reminder to one staff member. Returns true when newly created. */
async function remindStaff(p: PeriodCtx, step: string, userId: string, line: string, staffEmail: boolean) {
  const row = await claim({ periodId: p.id, step, recipient: `staff:${userId}`, channel: "IN_APP", status: "CREATED", detail: line.slice(0, 300) });
  if (!row) return false;
  const emailRow = await claim({ periodId: p.id, step, recipient: `staff:${userId}`, channel: "EMAIL", status: staffEmail ? "QUEUED" : "HELD", detail: staffEmail ? null : "Held — Compliance staff email reminders switch is off" });
  if (emailRow && staffEmail) {
    const user = await prisma.user.findUnique({ where: { id: userId }, select: { email: true, active: true } });
    if (user?.active) {
      const url = `${appUrl()}/compliance/periods/${p.id}`;
      // Link only: no amounts or tax details in email.
      const r = await sendEmail({ to: user.email, subject: `Tax & Compliance reminder: ${p.obligation.formName}`, text: `${line}\n\nOpen it in Client Connect: ${url}`, html: brandedEmailHtml({ heading: "Tax & Compliance reminder", paragraphs: [line], button: { label: "Open in Client Connect", url } }), idempotencyKey: emailRow.dedupeKey, tags: { category: "compliance_reminder" } });
      await prisma.complianceReminder.update({ where: { id: emailRow.id }, data: { status: r.ok ? "SENT" : "FAILED", detail: r.ok ? "Accepted by email provider" : r.detail.slice(0, 300) } });
    }
  }
  return true;
}

/** Portal logins that may see this period (same rule as the client page). */
async function clientRecipients(periodId: string) {
  const p = await prisma.complianceFilingPeriod.findUniqueOrThrow({ where: { id: periodId } });
  const { portalMayActOnPeriod } = await import("./views");
  const grants = await prisma.portalAccess.findMany({ where: { clientId: p.clientId, revokedAt: null, portalUser: { active: true } }, select: { portalUserId: true } });
  const out: string[] = [];
  for (const g of grants) if (await portalMayActOnPeriod(g.portalUserId, p)) out.push(g.portalUserId);
  return out;
}

/** Client notice for a period (gated by both switches). Returns what happened per recipient. */
export async function notifyClientForPeriod(periodId: string, step: string, kind: string) {
  const [settings, p] = await Promise.all([complianceSettings(), prisma.complianceFilingPeriod.findUniqueOrThrow({ where: { id: periodId }, include: { entity: true } })]);
  const allowed = settings.clientNotificationsAuthorized && p.entity.clientNotificationsEnabled;
  const why = !settings.clientNotificationsAuthorized ? "Held — Compliance client notifications switch is off" : "Held — client notifications are off for this entity";
  const results: { portalUserId: string; status: string }[] = [];
  for (const portalUserId of await clientRecipients(periodId)) {
    const row = await claim({ periodId, step, recipient: `portal:${portalUserId}`, channel: "PORTAL", status: allowed ? "QUEUED" : "HELD", detail: allowed ? kind : why });
    if (!row) continue;
    if (allowed) {
      await queuePortalNotification(portalUserId, kind, `cc:${row.dedupeKey}`);
      await prisma.complianceReminder.update({ where: { id: row.id }, data: { status: "SENT", detail: `${kind} queued for the login's email/text preferences` } });
    }
    results.push({ portalUserId, status: allowed ? "SENT" : "HELD" });
  }
  return results;
}

/** Approval or change request: assigned staff and owner are told immediately. */
export async function notifyStaffOfDecision(periodId: string, approvalId: string, decision: string) {
  const [settings, owner, p] = await Promise.all([complianceSettings(), primaryOwnerId(), prisma.complianceFilingPeriod.findUniqueOrThrow({ where: { id: periodId }, include: { obligation: true, entity: { include: { client: { select: { displayName: true } } } } } })]);
  const line = `${decision === "APPROVED" ? "Client approved" : "Client requested changes to"} ${periodLabel(p)}.`;
  for (const uid of new Set([p.obligation.assignedStaffId, owner].filter((x): x is string => !!x))) await remindStaff(p, `APPROVAL_DECISION:${approvalId}`, uid, line, settings.staffEmailReminders);
}

async function ensurePrepTask(p: PeriodCtx, assignee: string | null, ownerId: string, due: Date) {
  if (p.prepTaskId) return false;
  try {
    return await prisma.$transaction(async (tx) => {
      await tx.complianceReminder.create({ data: { periodId: p.id, step: "PREP_TASK", recipient: `staff:${assignee ?? ownerId}`, channel: "IN_APP", status: "CREATED", dedupeKey: `${p.id}:PREP_TASK` } });
      const task = await tx.task.create({
        data: {
          title: `Prepare ${p.obligation.formName} — ${p.periodKey} (${p.entity.legalName || p.entity.dba || p.entity.client.displayName})`.slice(0, 200),
          details: `Tax & Compliance preparation task. Due ${due.toISOString().slice(0, 10)}${p.dueCertainty !== "CONFIRMED" ? " (Needs verification)" : ""}; internal prep deadline ${p.prepDeadline?.toISOString().slice(0, 10) ?? "—"}. This task stays open until the filing is recorded with its evidence. Open: /compliance/periods/${p.id}`,
          dueAt: p.prepDeadline ?? due,
          priority: "HIGH",
          clientId: p.clientId,
          assigneeId: assignee ?? ownerId,
          createdById: ownerId,
        },
      });
      await tx.complianceFilingPeriod.update({ where: { id: p.id }, data: { prepTaskId: task.id } });
      return true;
    });
  } catch (e) {
    if (isDup(e)) return false;
    throw e;
  }
}

export async function runComplianceReminders(now = new Date(), scope: { obligationIds?: string[]; periodIds?: string[] } = {}) {
  const [settings, ownerId] = await Promise.all([complianceSettings(), primaryOwnerId()]);
  const summary = { prepTasks: 0, reminders: 0, overdue: 0, approvalReminders: 0, escalations: 0, reopenedTasks: 0 };
  if (!ownerId) return summary;
  const today = officeToday(now);
  const periods = await prisma.complianceFilingPeriod.findMany({
    where: {
      filingStatus: { notIn: COMPLETE_FILING },
      obligation: { status: "ACTIVE", ...(scope.obligationIds ? { id: { in: scope.obligationIds } } : {}) },
      ...(scope.periodIds ? { id: { in: scope.periodIds } } : {}),
      OR: [{ adjustedDue: { not: null } }, { extendedDue: { not: null } }],
    },
    include: { obligation: true, entity: { include: { client: { select: { displayName: true } } } } },
  });
  const steps = [...settings.reminderDays].sort((a, b) => b - a);
  for (const p of periods) {
    const due = effectiveDue(p)!;
    const dueIso = due.toISOString().slice(0, 10);
    const days = daysBetween(today, dueIso);
    const assignee = p.obligation.assignedStaffId;
    const staff = assignee ?? ownerId;
    const certainty = p.dueCertainty === "CONFIRMED" ? "" : " (due date needs verification)";
    if (days <= settings.prepTaskDays && (await ensurePrepTask(p, assignee, ownerId, due))) summary.prepTasks++;
    // The prep task stays open until the period completes: reopen it if someone closed it.
    if (p.prepTaskId) {
      const r = await prisma.task.updateMany({ where: { id: p.prepTaskId, status: "DONE" }, data: { status: "OPEN", completedAt: null } });
      if (r.count) {
        summary.reopenedTasks++;
        await audit(prisma, { actorId: null, action: "compliance.prep_task_reopened", entityType: "Task", entityId: p.prepTaskId, clientId: p.clientId });
      }
    }
    if (days >= 0) {
      const reached = steps.filter((s) => days <= s);
      if (reached.length) {
        const step = reached[reached.length - 1];
        if (await remindStaff(p, `D${step}`, staff, `${periodLabel(p)} is due ${dueIso}${certainty} — ${days === 0 ? "today" : `${days} day${days === 1 ? "" : "s"} left`}.`, settings.staffEmailReminders)) summary.reminders++;
      }
    } else {
      for (const uid of new Set([staff, ownerId])) {
        if (await remindStaff(p, `OVERDUE:${today}`, uid, `OVERDUE: ${periodLabel(p)} was due ${dueIso}${certainty} (${-days} day${days === -1 ? "" : "s"} ago) and isn't recorded as filed.`, settings.staffEmailReminders)) summary.overdue++;
      }
    }
    // Pending client approval: client reminders (gated) and escalation when it threatens the deadline.
    if (p.filingStatus === "AWAITING_APPROVAL") {
      const sent = await prisma.complianceReturnVersion.findFirst({ where: { periodId: p.id, status: "SENT" }, orderBy: { version: "desc" } });
      if (sent?.sentAt) {
        const since = daysBetween(sent.sentAt.toISOString().slice(0, 10), today);
        const every = settings.approvalReminderEveryDays;
        if (since >= every) {
          const bucket = Math.floor(since / every);
          const r = await notifyClientForPeriod(p.id, `APPROVAL_REMINDER:v${sent.version}:${bucket}`, "COMPLIANCE_APPROVAL_REMINDER");
          summary.approvalReminders += r.length;
        }
        if (days <= settings.approvalEscalationDays) {
          for (const uid of new Set([staff, ownerId])) {
            if (await remindStaff(p, `APPROVAL_ESCALATION:${today}`, uid, `Client approval still pending for ${periodLabel(p)} — due ${dueIso}${certainty}.`, settings.staffEmailReminders)) summary.escalations++;
          }
        }
      }
    }
  }
  return summary;
}

/** The hourly cron's compliance pass: rules loaded, periods current, reminders, yearly review task. */
export async function runComplianceCron(now = new Date()) {
  const { ensureRulesLoaded, ensureRuleReviewTask } = await import("./rules");
  const { ensurePeriods } = await import("./obligations");
  await ensureRulesLoaded();
  const today = officeToday(now);
  let periods = 0;
  for (const o of await prisma.complianceObligation.findMany({ where: { status: "ACTIVE" }, select: { id: true } })) periods += await ensurePeriods(o.id, today);
  const reminders = await runComplianceReminders(now);
  const reviewTask = await ensureRuleReviewTask(now);
  return { periods, ...reminders, reviewTask };
}
