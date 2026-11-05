import "server-only";
import { prisma } from "@/lib/prisma";
import { audit } from "@/lib/audit";
import type { Actor } from "@/lib/auth/actor";
import { brandedEmailHtml, sendEmail } from "@/lib/email";
import { appUrl } from "@/lib/integrations";
import { sendSms } from "@/lib/twilio";
import { assertPayrollTaxManage } from "@/lib/payroll-taxes/access";
import { deadlineFor, queueStatus, QUEUE_STATUS, REMINDER_STEPS, type ReminderChannel, type ReminderStepKey } from "@/lib/payroll/queue";
import { ValidationError } from "./clients";
import { ymdOf } from "./ledger";
import { canSend } from "./comm-prefs";
import { clientTextingOn, staffAlertSettings } from "./staff-alerts";
import { clientSmsAllowedNow, queuePortalNotification } from "./notifications";
import { isPayrollApprover, requiredApprovers } from "./payroll-approval";
import { assigneeOf, deadlineAt, factsOf, payrollTaxSettings, reminderPlan } from "./payroll-taxes";

/**
 * Automated payroll reminders (ADP Payroll & Taxes workspace), run hourly from the automations cron.
 *
 * - Steps are relative to each cycle's deadlines; the plan (global or per client) chooses which run
 *   and on which channels.
 * - One decision per step, per cycle (and approval round), per recipient, per channel: the dedupe
 *   key is unique, so a step never repeats.
 * - Reminders stop as soon as the client acts (hours submitted, or the approver decided): the
 *   condition is re-checked on every run, right before sending.
 * - CLIENT reminders are recorded as HELD, never sent, unless the owner's master switch
 *   ("Payroll & tax client reminders authorized") AND the client's own switch are both on.
 * - Texts only where existing consent allows (texting switch, service consent, STOP, quiet hours).
 * - Messages carry no amounts and no employee names: a short notice and a sign-in link.
 * - STAFF alerts (overdue) go only to staff: the assigned staff member and the owner.
 */

export const HELD_SWITCH = "Held: “Payroll & tax client reminders authorized” is off (owner switch). Nothing was sent.";
export const HELD_CLIENT = "Held: client reminders are off for this client. Nothing was sent.";

type Recipient = { key: string; audience: "CLIENT" | "STAFF"; name: string; email: string | null; phone: string | null; portalUserId?: string; userId?: string };

const signInUrl = () => `${appUrl()}/client/payroll`;
const staffUrl = (cycleId: string) => `${appUrl()}/payroll-taxes/cycles/${cycleId}`;
const fmt = (s: string) => new Date(`${s}T12:00:00Z`).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });

/** The words of each reminder. No amounts, no employee names, a sign-in link. */
export function reminderMessage(step: ReminderStepKey, business: string, due: string, cycleId: string) {
  const when = fmt(due);
  switch (step) {
    case "HOURS_REQUEST":
    case "HOURS_FOLLOWUP": {
      const lead = step === "HOURS_REQUEST" ? `Payroll hours for ${business} are needed by ${when}.` : `Reminder: payroll hours for ${business} are due ${when}.`;
      return { subject: `Payroll hours needed — ${business}`, heading: "Payroll hours needed", line: `${lead} Sign in to send them (or tell us nothing changed).`, url: signInUrl(), sms: `T. Turner & Associates: ${lead} Sign in to send them: ${signInUrl()} Reply STOP to opt out.` };
    }
    case "APPROVAL_REQUEST":
    case "APPROVAL_REMINDER_1":
    case "APPROVAL_REMINDER_2": {
      const lead = step === "APPROVAL_REQUEST" ? `Payroll for ${business} is ready for your approval (due ${when}).` : `Reminder: payroll for ${business} needs your approval by ${when}.`;
      const url = `${appUrl()}/client/payroll-approval`;
      return { subject: `Payroll approval needed — ${business}`, heading: "Payroll needs your approval", line: `${lead} Sign in to review it.`, url, sms: `T. Turner & Associates: ${lead} Sign in to review: ${url} Reply STOP to opt out.` };
    }
    case "OVERDUE_ALERT":
      return { subject: `Overdue payroll step — ${business}`, heading: "Payroll step overdue", line: `A payroll step for ${business} was due ${when} and isn't done. Open the cycle in ADP Payroll & Taxes.`, url: staffUrl(cycleId), sms: "" };
  }
}

async function clientRecipients(clientId: string, approversOnly: boolean): Promise<Recipient[]> {
  const { all } = await requiredApprovers(clientId);
  let users: { id: string; name: string; email: string; phoneNormalized: string | null }[] = [];
  if (all.length) {
    users = await prisma.portalUser.findMany({ where: { id: { in: all.map((a) => a.portalUserId) }, active: true }, select: { id: true, name: true, email: true, phoneNormalized: true } });
  } else if (!approversOnly) {
    // No approvers yet: the business's owner logins allowed to send payroll.
    const access = await prisma.portalAccess.findMany({ where: { clientId, revokedAt: null, role: "OWNER", canUploadPayroll: true, portalUser: { active: true } }, include: { portalUser: { select: { id: true, name: true, email: true, phoneNormalized: true } } } });
    users = access.map((a) => a.portalUser);
  }
  return users.map((u) => ({ key: `portal:${u.id}`, audience: "CLIENT", name: u.name, email: u.email, phone: u.phoneNormalized, portalUserId: u.id }));
}

async function staffRecipients(cycle: { assignedStaffId: string | null; schedule: { assignedStaffId: string | null } }): Promise<Recipient[]> {
  const owner = await prisma.ownerAccess.findFirst({ where: { isPrimary: true, revokedAt: null, user: { active: true } }, select: { userId: true } });
  const ids = [...new Set([assigneeOf(cycle), owner?.userId].filter((x): x is string => !!x))];
  const users = await prisma.user.findMany({ where: { id: { in: ids }, active: true }, select: { id: true, name: true, email: true } });
  return users.map((u) => ({ key: `staff:${u.id}`, audience: "STAFF", name: u.name, email: u.email, phone: null, userId: u.id }));
}

type Outcome = { status: "SENT" | "FAILED" | "SKIPPED" | "HELD"; detail: string } | "RETRY_LATER";

async function deliver(r: Recipient, channel: ReminderChannel, step: ReminderStepKey, msg: ReturnType<typeof reminderMessage>, ctx: { authorized: boolean; clientOn: boolean; dedupeKey: string; cycleId: string; clientId: string; now: Date }): Promise<Outcome> {
  if (r.audience === "CLIENT") {
    if (!ctx.authorized) return { status: "HELD", detail: HELD_SWITCH };
    if (!ctx.clientOn) return { status: "HELD", detail: HELD_CLIENT };
  }
  if (channel === "PORTAL") {
    if (r.audience === "STAFF") {
      // A staff "portal notice" is a task in Tasks & Calendar for the assigned staff member.
      if (!r.userId) return { status: "SKIPPED", detail: "No staff account" };
      const creator = r.userId;
      await prisma.task.create({ data: { title: msg.subject, details: `${msg.line} ${msg.url}`.slice(0, 1000), priority: "HIGH", clientId: ctx.clientId, assigneeId: r.userId, createdById: creator } });
      return { status: "SENT", detail: "Task created" };
    }
    await queuePortalNotification(r.portalUserId!, step.startsWith("HOURS") ? "PAYROLL_HOURS_REQUEST" : "PAYROLL_APPROVAL_REMINDER", `payroll-reminder:${ctx.dedupeKey}`);
    return { status: "SENT", detail: "Portal notice queued (sent by the client's own notification choices)" };
  }
  if (process.env.NOTIFICATIONS_ENABLED !== "true") return { status: "SKIPPED", detail: "Notifications are turned off (NOTIFICATIONS_ENABLED is not true)" };
  if (channel === "EMAIL") {
    if (!r.email) return { status: "SKIPPED", detail: "No email address" };
    if (r.audience === "CLIENT") {
      const ok = await canSend({ channel: "EMAIL", address: r.email, category: "ESSENTIAL" });
      if (!ok.ok) return { status: "SKIPPED", detail: ok.reason };
    }
    const res = await sendEmail({ to: r.email, subject: msg.subject, text: `${msg.line}\n\n${msg.url}\n\nT. Turner & Associates`, html: brandedEmailHtml({ heading: msg.heading, paragraphs: [msg.line], button: { label: "Sign in", url: msg.url }, footer: "T. Turner & Associates" }), idempotencyKey: `payroll-reminder/${ctx.dedupeKey}`, tags: { category: "payroll_reminder" } });
    return res.ok ? { status: "SENT", detail: "Accepted by email provider" } : { status: "FAILED", detail: res.detail };
  }
  // SMS: clients only, and only where existing consent allows it.
  if (r.audience !== "CLIENT") return { status: "SKIPPED", detail: "Staff alerts aren't texted from here" };
  if (!(await clientTextingOn())) return { status: "SKIPPED", detail: "Text messages from the office are switched off" };
  if (!r.phone) return { status: "SKIPPED", detail: "No mobile number on the login" };
  const ok = await canSend({ channel: "SMS", address: r.phone, category: "ESSENTIAL" });
  if (!ok.ok) return { status: "SKIPPED", detail: ok.reason };
  if (!clientSmsAllowedNow(ctx.now)) return "RETRY_LATER";
  const res = await sendSms(r.phone, msg.sms);
  return { status: res.ok ? "SENT" : "FAILED", detail: res.detail };
}

/** One pass over every open cycle. Safe to run any number of times. */
export async function runPayrollReminders(now = new Date()) {
  const today = now.toLocaleDateString("en-CA", { timeZone: "America/Chicago" });
  const settings = await payrollTaxSettings();
  const horizon = new Date(`${today}T00:00:00Z`);
  const cycles = await prisma.payrollCycle.findMany({
    where: { processedAt: null, schedule: { active: true }, client: { archivedAt: null }, payDate: { gte: new Date(horizon.getTime() - 14 * 86400_000) }, hoursRequestDate: { lte: new Date(horizon.getTime() + 86400_000) } },
    include: { client: { select: { displayName: true, businessName: true } }, schedule: { select: { assignedStaffId: true, clientRemindersEnabled: true } } },
  });
  const counts = { SENT: 0, FAILED: 0, SKIPPED: 0, HELD: 0 } as Record<string, number>;
  for (const c of cycles) {
    const plan = await reminderPlan(c.clientId);
    const run = c.payrollRunId ? await prisma.payrollRun.findUnique({ where: { id: c.payrollRunId }, select: { id: true, status: true, currentVersionId: true, approvalRound: true } }) : null;
    const facts = factsOf(c, run && run.status !== "DISCARDED" ? run : null);
    const status = queueStatus(facts, today);
    const business = c.client.businessName || c.client.displayName;
    const needsHours = status === "UPCOMING" || status === "WAITING_ON_HOURS";
    const awaiting = run?.status === "AWAITING_APPROVAL";
    const hoursDue = deadlineAt(facts.hoursDueDate);
    const approvalDue = deadlineAt(facts.approvalDueDate);
    for (const step of plan) {
      if (!step.enabled || !step.channels.length) continue;
      let due = false;
      let round: number | null = null;
      let dueDate = facts.hoursDueDate;
      let stepKey: string = step.key;
      let recipients: Recipient[] = [];
      switch (step.key) {
        case "HOURS_REQUEST":
          due = needsHours && now >= deadlineAt(facts.hoursRequestDate, "09:00") && now < hoursDue;
          if (due) recipients = await clientRecipients(c.clientId, false);
          break;
        case "HOURS_FOLLOWUP":
          due = needsHours && now >= new Date(hoursDue.getTime() - (step.hoursBefore ?? 24) * 3600_000) && now < hoursDue;
          if (due) recipients = await clientRecipients(c.clientId, false);
          break;
        case "APPROVAL_REQUEST":
        case "APPROVAL_REMINDER_1":
        case "APPROVAL_REMINDER_2": {
          dueDate = facts.approvalDueDate;
          const at = step.key === "APPROVAL_REQUEST" ? new Date(0) : new Date(approvalDue.getTime() - (step.hoursBefore ?? 24) * 3600_000);
          due = !!awaiting && now >= at && now < approvalDue;
          if (due && run) {
            round = run.approvalRound;
            const decided = await prisma.payrollApproval.findMany({ where: { runId: run.id, round: run.approvalRound }, select: { portalUserId: true } });
            // Stop on action: whoever already decided in this round gets nothing more.
            recipients = (await clientRecipients(c.clientId, true)).filter((r) => !decided.some((x) => x.portalUserId === r.portalUserId));
            const still = [];
            for (const r of recipients) if (await isPayrollApprover(r.portalUserId!, c.clientId)) still.push(r);
            recipients = still;
          }
          break;
        }
        case "OVERDUE_ALERT": {
          const d = deadlineFor(facts, status === "UPCOMING" ? "WAITING_ON_HOURS" : status);
          if (!d || status === "PROCESSED" || status === "SUBMITTED_IN_ADP") break;
          dueDate = d;
          due = now >= deadlineAt(d);
          stepKey = `OVERDUE_ALERT:${status === "UPCOMING" ? "WAITING_ON_HOURS" : status}`;
          if (due) recipients = await staffRecipients(c);
          break;
        }
      }
      if (!due || !recipients.length) continue;
      const msg = reminderMessage(step.key, business, dueDate, c.id);
      for (const r of recipients) {
        for (const channel of step.channels) {
          if (r.audience === "STAFF" && channel === "SMS") continue;
          const dedupeKey = `${c.id}:${stepKey}${round !== null ? `:r${round}` : ""}:${r.key}:${channel}`;
          if (await prisma.payrollReminder.count({ where: { dedupeKey } })) continue;
          const outcome = await deliver(r, channel, step.key, msg, { authorized: settings.clientRemindersAuthorized, clientOn: c.schedule.clientRemindersEnabled, dedupeKey, cycleId: c.id, clientId: c.clientId, now });
          if (outcome === "RETRY_LATER") continue;
          const created = await prisma.payrollReminder.createMany({ data: [{ cycleId: c.id, clientId: c.clientId, step: stepKey, round, audience: r.audience, recipientKey: r.key, channel, status: outcome.status, detail: outcome.detail.slice(0, 300), dedupeKey }], skipDuplicates: true });
          if (created.count) {
            counts[outcome.status]++;
            if (step.key === "HOURS_REQUEST" && outcome.status === "SENT" && !c.hoursRequestedAt) {
              await prisma.payrollCycle.updateMany({ where: { id: c.id, hoursRequestedAt: null }, data: { hoursRequestedAt: now } });
            }
            if (outcome.status === "HELD") await audit(prisma, { actorId: null, action: "payroll_taxes.reminder_held", entityType: "PayrollCycle", entityId: c.id, clientId: c.clientId, details: { step: stepKey, channel, recipient: r.key, reason: outcome.detail } });
            else await audit(prisma, { actorId: null, action: "payroll_taxes.reminder_sent", entityType: "PayrollCycle", entityId: c.id, clientId: c.clientId, details: { step: stepKey, channel, recipient: r.key, status: outcome.status } });
          }
        }
      }
    }
  }
  return counts;
}

/** "Send test to office": one sample, to the office's own email only. Never to a client. */
export async function sendTestToOffice(actor: Actor) {
  await assertPayrollTaxManage(actor);
  const office = (await staffAlertSettings()).email;
  if (!office) throw new ValidationError("Set the office email in Settings → Staff alerts first.");
  const msg = reminderMessage("HOURS_REQUEST", "Sample Business (TEST)", ymdOf(new Date(Date.now() + 3 * 86400_000)), "test");
  const res = await sendEmail({ to: office, subject: `[TEST] ${msg.subject}`, text: `This is a test of the payroll reminder clients would receive. It went only to the office.\n\n${msg.line}\n\n${msg.url}`, html: brandedEmailHtml({ heading: `[TEST] ${msg.heading}`, paragraphs: ["This is a test of the payroll reminder clients would receive. It went only to the office.", msg.line], button: { label: "Sign in", url: msg.url }, footer: "T. Turner & Associates" }), tags: { category: "payroll_reminder_test" } });
  await audit(prisma, { actorId: actor.id, action: "payroll_taxes.test_sent_to_office", entityType: "PayrollTaxSettings", entityId: "default", details: { ok: res.ok, to: office.replace(/^(.).*(@.*)$/, "$1…$2") } });
  return res.ok ? { ok: true as const, to: office } : { ok: false as const, to: office, detail: res.detail };
}

export const STATUS_LABEL = Object.fromEntries(Object.entries(QUEUE_STATUS).map(([k, v]) => [k, v.label]));
export { REMINDER_STEPS };
