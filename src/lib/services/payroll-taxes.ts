import "server-only";
import { createHash } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { audit } from "@/lib/audit";
import { ForbiddenError, type Actor } from "@/lib/auth/actor";
import { assertOwner, ownerAudit } from "@/lib/auth/owner";
import { isPrimaryOwner } from "@/lib/auth/permissions";
import { requireClientAccess } from "@/lib/portal/access";
import { chicagoLocalToUtc } from "@/lib/tz";
import { isPayrollSystem } from "@/lib/payroll/fields";
import { differenceOf, type Amounts, type PayDateTotals } from "@/lib/payroll/register";
import { addDays, DEADLINE_TIME, DEFAULT_OFFSETS, isFrequency, planCycles, scheduleProblems, type Frequency, type ScheduleRule } from "@/lib/payroll/schedule";
import { CHANGE_FLAGS, DEFAULT_PLAN, normalizePlan, toQueueRow, sortQueue, type ChangeFlag, type CycleFacts, type HoursSubmission, type QueueRow, type ReminderStep } from "@/lib/payroll/queue";
import { assertPayrollTaxManage, assertPayrollTaxView, cycleScope, payrollTaxAccess, scheduleScope, type PayrollTaxAccess } from "@/lib/payroll-taxes/access";
import { ValidationError } from "./clients";
import { canUseLedger, todayCentral, usd, ymdOf } from "./ledger";
import { staffUploadDocument } from "./documents";
import { attachRunDocument, createRunsFromPayDates, editPayrollRun, event, importPayrollRegister, loadRun, assertStaff, type VersionDocument } from "./payroll";
import { isPayrollApprover, requestPayrollApproval, requiredApprovers, submitPayrollRun } from "./payroll-approval";

/**
 * ADP Payroll & Taxes workspace (Stage 1: payroll). Builds on the existing pay runs, versions and
 * owner approvals (payroll.ts / payroll-approval.ts); adds per-client schedules, pay cycles, the
 * work queue and the records around each cycle.
 *
 * Safety:
 * - Nothing here submits payroll, files taxes or moves money. "Submitted in ADP" and "Processed"
 *   record what a person did in ADP.
 * - Generating cycles sends nothing. Reminders live in payroll-reminders.ts and are HELD while the
 *   owner's master switch is off.
 * - Every read is scoped (VIEW users see their assigned clients); every write needs MANAGE.
 * - Existing client records only: nothing here creates a client.
 */

type Tx = Prisma.TransactionClient;
const d = (s: string) => new Date(`${s}T00:00:00Z`);
export const deadlineAt = (date: string, time = DEADLINE_TIME) => chicagoLocalToUtc(`${date}T${time}`)!;

// --- Settings ----------------------------------------------------------------------------------

export async function payrollTaxSettings() {
  const found = await prisma.payrollTaxSettings.findUnique({ where: { id: "default" } });
  if (found) return found;
  return prisma.payrollTaxSettings.create({ data: { id: "default" } }).catch(() => prisma.payrollTaxSettings.findUniqueOrThrow({ where: { id: "default" } }));
}

/** Owner only: "Payroll & tax client reminders authorized". Recorded in the owner audit log. */
export async function setClientRemindersAuthorized(actor: Actor, on: boolean) {
  await assertOwner(actor);
  const before = await payrollTaxSettings();
  if (before.clientRemindersAuthorized === on) return before;
  const after = await prisma.payrollTaxSettings.update({ where: { id: "default" }, data: { clientRemindersAuthorized: on, changedAt: new Date(), changedById: actor.id } });
  await ownerAudit(actor.id, on ? "payroll_taxes.client_reminders_authorized" : "payroll_taxes.client_reminders_revoked", "PayrollTaxSettings", "default", { from: before.clientRemindersAuthorized, to: on });
  await audit(prisma, { actorId: actor.id, action: on ? "payroll_taxes.client_reminders_on" : "payroll_taxes.client_reminders_off", entityType: "PayrollTaxSettings", entityId: "default" });
  return after;
}

// --- Staff --------------------------------------------------------------------------------------

/** Active staff who can open the workspace (the owner, and anyone granted View or Manage). */
export async function assignableStaff() {
  const [owner, grants] = await Promise.all([
    prisma.ownerAccess.findFirst({ where: { isPrimary: true, revokedAt: null, user: { active: true } }, select: { userId: true } }),
    prisma.staffPermission.findMany({ where: { area: "payroll_taxes", action: { in: ["view", "manage"] }, user: { active: true } }, select: { userId: true } }),
  ]);
  const ids = [...new Set([...(owner ? [owner.userId] : []), ...grants.map((g) => g.userId)])];
  return prisma.user.findMany({ where: { id: { in: ids }, active: true }, select: { id: true, name: true, email: true }, orderBy: { name: "asc" } });
}

async function assertAssignable(staffId: string | null) {
  if (!staffId) return;
  if (!(await assignableStaff()).some((s) => s.id === staffId)) throw new ValidationError("Assign someone who has ADP Payroll & Taxes access (the owner grants it in Staff Access & Permissions).");
}

// --- Schedules ----------------------------------------------------------------------------------

export type ScheduleInput = {
  frequency: string;
  anchorPayDate: string;
  semiMonthlyDays?: number[];
  periodEndLagDays: number;
  hoursRequestLeadDays: number;
  hoursDueDays: number;
  approvalDueDays: number;
  adpCutoffDays: number;
  assignedStaffId?: string | null;
  active: boolean;
  clientRemindersEnabled: boolean;
  notes?: string | null;
};

const ruleOf = (s: { frequency: string; anchorPayDate: Date; semiMonthlyDays: number[]; periodEndLagDays: number; hoursRequestLeadDays: number; hoursDueDays: number; approvalDueDays: number; adpCutoffDays: number }): ScheduleRule => ({
  frequency: s.frequency as Frequency,
  anchorPayDate: ymdOf(s.anchorPayDate),
  semiMonthlyDays: s.semiMonthlyDays,
  periodEndLagDays: s.periodEndLagDays,
  hoursRequestLeadDays: s.hoursRequestLeadDays,
  hoursDueDays: s.hoursDueDays,
  approvalDueDays: s.approvalDueDays,
  adpCutoffDays: s.adpCutoffDays,
});

/** The schedule editor's values: the saved schedule, else prefilled from the bookkeeping profile. */
export async function scheduleForm(actor: Actor, clientId: string) {
  const access = await assertPayrollTaxView(actor);
  const client = await prisma.client.findUnique({ where: { id: clientId }, select: { id: true, displayName: true, businessName: true, assignedToId: true, archivedAt: true, bookkeepingProfile: { select: { payroll: true, payrollFrequency: true, payrollPayDate: true, payrollSystem: true, payrollProvider: true } } } });
  if (!client || client.archivedAt) throw new ForbiddenError("Not found.");
  const schedule = await prisma.payrollSchedule.findUnique({ where: { clientId } });
  if (!access.allClients && !(schedule && (schedule.assignedStaffId === actor.id || client.assignedToId === actor.id))) throw new ForbiddenError("Not found.");
  const p = client.bookkeepingProfile;
  const prefill = {
    frequency: schedule?.frequency ?? (isFrequency(p?.payrollFrequency) ? p!.payrollFrequency! : "WEEKLY"),
    anchorPayDate: schedule ? ymdOf(schedule.anchorPayDate) : p?.payrollPayDate ? ymdOf(p.payrollPayDate) : "",
    semiMonthlyDays: schedule?.semiMonthlyDays.length ? schedule.semiMonthlyDays : [15, 31],
    periodEndLagDays: schedule?.periodEndLagDays ?? DEFAULT_OFFSETS.periodEndLagDays,
    hoursRequestLeadDays: schedule?.hoursRequestLeadDays ?? DEFAULT_OFFSETS.hoursRequestLeadDays,
    hoursDueDays: schedule?.hoursDueDays ?? DEFAULT_OFFSETS.hoursDueDays,
    approvalDueDays: schedule?.approvalDueDays ?? DEFAULT_OFFSETS.approvalDueDays,
    adpCutoffDays: schedule?.adpCutoffDays ?? DEFAULT_OFFSETS.adpCutoffDays,
    assignedStaffId: schedule?.assignedStaffId ?? null,
    active: schedule?.active ?? true,
    clientRemindersEnabled: schedule?.clientRemindersEnabled ?? false,
    notes: schedule?.notes ?? "",
  };
  const preview = prefill.anchorPayDate && !scheduleProblems({ ...prefill, frequency: prefill.frequency as Frequency }).length ? planCycles({ ...prefill, frequency: prefill.frequency as Frequency }, todayCentral(), 42) : [];
  return { client: { id: client.id, name: client.businessName || client.displayName, payroll: !!p?.payroll, provider: p?.payrollProvider ?? null }, schedule, prefill, fromProfile: !schedule && !!(p?.payrollFrequency || p?.payrollPayDate), preview, staff: await assignableStaff(), canManage: access.level === "MANAGE" };
}

export async function saveSchedule(actor: Actor, clientId: string, input: ScheduleInput) {
  await assertStaff(actor);
  await assertPayrollTaxManage(actor);
  const client = await prisma.client.findUnique({ where: { id: clientId }, select: { id: true, archivedAt: true } });
  // Existing client records only; nothing here creates one.
  if (!client || client.archivedAt) throw new ValidationError("Choose an existing, active client.");
  const semi = input.frequency === "SEMIMONTHLY" ? [...(input.semiMonthlyDays ?? [])].sort((a, b) => a - b) : [];
  const rule = { ...input, semiMonthlyDays: semi };
  const problems = scheduleProblems(rule as Partial<ScheduleRule>);
  if (problems.length) throw new ValidationError(problems.join(" "));
  await assertAssignable(input.assignedStaffId ?? null);
  const data = {
    frequency: input.frequency,
    anchorPayDate: d(input.anchorPayDate),
    semiMonthlyDays: semi,
    periodEndLagDays: input.periodEndLagDays,
    hoursRequestLeadDays: input.hoursRequestLeadDays,
    hoursDueDays: input.hoursDueDays,
    approvalDueDays: input.approvalDueDays,
    adpCutoffDays: input.adpCutoffDays,
    assignedStaffId: input.assignedStaffId || null,
    active: input.active,
    clientRemindersEnabled: input.clientRemindersEnabled,
    notes: input.notes?.trim().slice(0, 500) || null,
  };
  const before = await prisma.payrollSchedule.findUnique({ where: { clientId } });
  const saved = await prisma.payrollSchedule.upsert({ where: { clientId }, create: { clientId, createdById: actor.id, ...data }, update: { ...data, updatedById: actor.id } });
  const view = (s: typeof saved | null) => (s ? { frequency: s.frequency, anchorPayDate: ymdOf(s.anchorPayDate), semiMonthlyDays: s.semiMonthlyDays, offsets: [s.periodEndLagDays, s.hoursRequestLeadDays, s.hoursDueDays, s.approvalDueDays, s.adpCutoffDays], assignedStaffId: s.assignedStaffId, active: s.active, clientRemindersEnabled: s.clientRemindersEnabled } : null);
  await audit(prisma, { actorId: actor.id, action: before ? "payroll_taxes.schedule_updated" : "payroll_taxes.schedule_created", entityType: "PayrollSchedule", entityId: saved.id, clientId, details: { before: view(before), after: view(saved) } as Prisma.InputJsonValue });
  if ((before?.assignedStaffId ?? null) !== saved.assignedStaffId) await audit(prisma, { actorId: actor.id, action: "payroll_taxes.schedule_assigned", entityType: "PayrollSchedule", entityId: saved.id, clientId, details: { from: before?.assignedStaffId ?? null, to: saved.assignedStaffId } });
  const gen = await generateCycles({ clientId });
  return { schedule: saved, ...gen };
}

/** Clients that could get a schedule: existing, active, not yet scheduled (payroll clients first). */
export async function schedulableClients(actor: Actor) {
  await assertPayrollTaxManage(actor);
  return prisma.client.findMany({
    where: { archivedAt: null, payrollSchedule: null, bookkeepingProfile: { is: { payroll: true } } },
    select: { id: true, displayName: true, businessName: true },
    orderBy: { displayName: "asc" },
    take: 200,
  });
}

export async function listSchedules(actor: Actor) {
  const access = await assertPayrollTaxView(actor);
  const today = todayCentral();
  const rows = await prisma.payrollSchedule.findMany({
    where: scheduleScope(access),
    include: { client: { select: { id: true, displayName: true, businessName: true } }, cycles: { where: { payDate: { gte: d(today) } }, orderBy: { payDate: "asc" }, take: 1 } },
    orderBy: { client: { displayName: "asc" } },
  });
  const staff = await staffNames(rows.map((r) => r.assignedStaffId));
  return rows.map((r) => ({ ...r, clientName: r.client.businessName || r.client.displayName, nextPayDate: r.cycles[0] ? ymdOf(r.cycles[0].payDate) : null, assignedName: r.assignedStaffId ? staff.get(r.assignedStaffId) ?? "Former staff member" : null }));
}

async function staffNames(ids: (string | null | undefined)[]) {
  const list = [...new Set(ids.filter((x): x is string => !!x))];
  const users = list.length ? await prisma.user.findMany({ where: { id: { in: list } }, select: { id: true, name: true } }) : [];
  return new Map(users.map((u) => [u.id, u.name]));
}

// --- Generator -----------------------------------------------------------------------------------

/** A cycle nobody has touched yet: safe to move or remove when its schedule changes. */
const untouched = { hoursRequestedAt: null, hoursSubmittedAt: null, payrollRunId: null, processedAt: null, errorFlaggedAt: null, assignedStaffId: null, reminders: { none: {} } } satisfies Prisma.PayrollCycleWhereInput;

/**
 * Fills a rolling horizon (6 weeks by default) of pay cycles for every active schedule. Idempotent:
 * one cycle per client per pay date (unique), so running it again creates nothing. Untouched future
 * cycles follow schedule changes (moved deadlines, removed dates). It sends nothing.
 */
export async function generateCycles(opts: { now?: Date; horizonDays?: number; clientId?: string } = {}) {
  const today = opts.now ? opts.now.toLocaleDateString("en-CA", { timeZone: "America/Chicago" }) : todayCentral();
  const horizon = opts.horizonDays ?? 42;
  const schedules = await prisma.payrollSchedule.findMany({ where: { ...(opts.clientId ? { clientId: opts.clientId } : {}), client: { archivedAt: null } } });
  let created = 0;
  let updated = 0;
  let removed = 0;
  for (const s of schedules) {
    const plan = s.active ? planCycles(ruleOf(s), today, horizon) : [];
    const dates = plan.map((c) => c.payDate);
    // Untouched future cycles no longer on the schedule (or the schedule is paused) go away.
    const gone = await prisma.payrollCycle.deleteMany({ where: { scheduleId: s.id, payDate: { gte: d(today), ...(dates.length ? { notIn: dates.map(d) } : {}) }, ...untouched } });
    removed += gone.count;
    for (const c of plan) {
      const data = { periodStart: d(c.periodStart), periodEnd: d(c.periodEnd), hoursRequestDate: d(c.hoursRequestDate), hoursDueDate: d(c.hoursDueDate), approvalDueDate: d(c.approvalDueDate), adpCutoffDate: d(c.adpCutoffDate) };
      const existing = await prisma.payrollCycle.findUnique({ where: { clientId_payDate: { clientId: s.clientId, payDate: d(c.payDate) } } });
      if (!existing) {
        const r = await prisma.payrollCycle.createMany({ data: [{ clientId: s.clientId, scheduleId: s.id, payDate: d(c.payDate), ...data }], skipDuplicates: true });
        created += r.count;
      } else if (existing.scheduleId === s.id && Object.entries(data).some(([k, v]) => (existing as unknown as Record<string, Date>)[k].getTime() !== v.getTime())) {
        const r = await prisma.payrollCycle.updateMany({ where: { id: existing.id, ...untouched }, data });
        updated += r.count;
      }
    }
  }
  if (created || updated || removed) await audit(prisma, { actorId: null, action: "payroll_taxes.cycles_generated", entityType: "PayrollCycle", clientId: opts.clientId ?? null, details: { created, updated, removed, horizonDays: horizon, today } });
  return { created, updated, removed };
}

// --- Queue ---------------------------------------------------------------------------------------

const CYCLE_INCLUDE = {
  client: { select: { id: true, displayName: true, businessName: true, assignedToId: true } },
  schedule: { select: { assignedStaffId: true, clientRemindersEnabled: true, active: true } },
} satisfies Prisma.PayrollCycleInclude;
type CycleWith = Prisma.PayrollCycleGetPayload<{ include: typeof CYCLE_INCLUDE }>;

export const assigneeOf = (c: { assignedStaffId: string | null; schedule: { assignedStaffId: string | null } }) => c.assignedStaffId ?? c.schedule.assignedStaffId;

async function runsFor(cycles: { payrollRunId: string | null }[]) {
  const ids = cycles.map((c) => c.payrollRunId).filter((x): x is string => !!x);
  const runs = ids.length ? await prisma.payrollRun.findMany({ where: { id: { in: ids } }, select: { id: true, status: true, currentVersionId: true, approvalRound: true } }) : [];
  const versions = runs.length ? await prisma.payrollRunVersion.findMany({ where: { id: { in: runs.map((r) => r.currentVersionId!).filter(Boolean) } }, select: { id: true, number: true } }) : [];
  return new Map(runs.map((r) => [r.id, { ...r, versionNumber: versions.find((v) => v.id === r.currentVersionId)?.number ?? null }]));
}

export function factsOf(c: { payDate: Date; hoursRequestDate: Date; hoursDueDate: Date; approvalDueDate: Date; adpCutoffDate: Date; hoursRequestedAt: Date | null; hoursSubmittedAt: Date | null; errorFlaggedAt: Date | null; processedAt: Date | null }, run: { status: string; currentVersionId: string | null } | null): CycleFacts {
  return { payDate: ymdOf(c.payDate), hoursRequestDate: ymdOf(c.hoursRequestDate), hoursDueDate: ymdOf(c.hoursDueDate), approvalDueDate: ymdOf(c.approvalDueDate), adpCutoffDate: ymdOf(c.adpCutoffDate), hoursRequestedAt: c.hoursRequestedAt, hoursSubmittedAt: c.hoursSubmittedAt, errorFlaggedAt: c.errorFlaggedAt, processedAt: c.processedAt, run };
}

export type QueueData = { cycleId: string; clientId: string; clientName: string; payDate: string; assigneeId: string | null; assigneeName: string | null; versionNumber: number | null; runStatus: string | null };
export type QueueFilter = "mine" | "all" | "overdue";

async function scopedCycles(access: PayrollTaxAccess, where: Prisma.PayrollCycleWhereInput) {
  return prisma.payrollCycle.findMany({ where: { AND: [cycleScope(access), where] }, include: CYCLE_INCLUDE, orderBy: { payDate: "asc" } });
}

async function rowsOf(cycles: CycleWith[], today: string): Promise<QueueRow<QueueData>[]> {
  const runs = await runsFor(cycles);
  const names = await staffNames(cycles.map(assigneeOf));
  return cycles.map((c) => {
    const run = c.payrollRunId ? runs.get(c.payrollRunId) ?? null : null;
    const assigneeId = assigneeOf(c);
    return toQueueRow(factsOf(c, run), today, { cycleId: c.id, clientId: c.clientId, clientName: c.client.businessName || c.client.displayName, payDate: ymdOf(c.payDate), assigneeId, assigneeName: assigneeId ? names.get(assigneeId) ?? "Former staff member" : null, versionNumber: run?.versionNumber ?? null, runStatus: run?.status ?? null });
  });
}

/** The work queue above the tabs. "Assigned to me" is the default; overdue rows are pinned first. */
export async function workQueue(actor: Actor, filter: QueueFilter = "mine", today = todayCentral()) {
  const access = await assertPayrollTaxView(actor);
  const cycles = await scopedCycles(access, { payDate: { gte: d(addDays(today, -21)) }, OR: [{ processedAt: null }, { processedAt: { gte: new Date(Date.now() - 7 * 86400_000) } }] });
  let rows = await rowsOf(cycles, today);
  if (filter === "mine") rows = rows.filter((r) => r.data.assigneeId === actor.id);
  if (filter === "overdue") rows = rows.filter((r) => r.overdue);
  return { access, rows: sortQueue(rows), overdueCount: rows.filter((r) => r.overdue).length };
}

/** Every deadline of every visible cycle in a month (Due Dates tab). */
export async function dueDates(actor: Actor, month: string, today = todayCentral()) {
  const access = await assertPayrollTaxView(actor);
  const start = `${month}-01`;
  const end = ymdOf(new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 1)));
  const cycles = await scopedCycles(access, { OR: [{ payDate: { gte: d(start), lt: d(end) } }, { hoursDueDate: { gte: d(start), lt: d(end) } }, { approvalDueDate: { gte: d(start), lt: d(end) } }, { adpCutoffDate: { gte: d(start), lt: d(end) } }] });
  const rows = await rowsOf(cycles, today);
  const items: { date: string; kind: "HOURS_DUE" | "APPROVAL_DUE" | "ADP_CUTOFF" | "PAY_DATE"; label: string; clientName: string; cycleId: string; overdue: boolean; done: boolean }[] = [];
  for (const r of rows) {
    const c = cycles.find((x) => x.id === r.data.cycleId)!;
    const f = factsOf(c, null);
    const doneHours = !!c.hoursSubmittedAt || !!r.data.runStatus;
    const doneApproval = ["FULLY_APPROVED", "SUBMITTED", "PROCESSED"].includes(r.data.runStatus ?? "") || !!c.processedAt;
    const doneAdp = ["SUBMITTED", "PROCESSED"].includes(r.data.runStatus ?? "") || !!c.processedAt;
    const doneAll = !!c.processedAt || r.data.runStatus === "PROCESSED";
    const push = (date: string, kind: (typeof items)[number]["kind"], label: string, done: boolean) => items.push({ date, kind, label, clientName: r.data.clientName, cycleId: c.id, overdue: !done && today > date, done });
    push(f.hoursDueDate, "HOURS_DUE", "Hours due", doneHours);
    push(f.approvalDueDate, "APPROVAL_DUE", "Client approval due", doneApproval);
    push(f.adpCutoffDate, "ADP_CUTOFF", "ADP processing cutoff", doneAdp);
    push(f.payDate, "PAY_DATE", "Pay date", doneAll);
  }
  const inMonth = items.filter((i) => i.date >= start && i.date < end).sort((a, b) => a.date.localeCompare(b.date) || a.clientName.localeCompare(b.clientName));
  return { month, start, end, items: inMonth };
}

/** Client Approvals tab: who approved what, by round and version (from PayrollApproval). */
export async function clientApprovals(actor: Actor, today = todayCentral()) {
  const access = await assertPayrollTaxView(actor);
  const cycles = await scopedCycles(access, { payrollRunId: { not: null }, payDate: { gte: d(addDays(today, -60)) } });
  const runIds = cycles.map((c) => c.payrollRunId!);
  const [runs, approvals, versions] = await Promise.all([
    prisma.payrollRun.findMany({ where: { id: { in: runIds } }, select: { id: true, status: true, approvalRound: true, currentVersionId: true, approvalRequestedAt: true } }),
    prisma.payrollApproval.findMany({ where: { runId: { in: runIds } }, orderBy: { createdAt: "asc" }, include: { version: { select: { number: true } } } }),
    prisma.payrollRunVersion.findMany({ where: { runId: { in: runIds } }, select: { id: true, runId: true, number: true } }),
  ]);
  const out = [];
  for (const c of cycles) {
    const run = runs.find((r) => r.id === c.payrollRunId);
    if (!run) continue;
    const { required, all } = await requiredApprovers(c.clientId);
    const mine = approvals.filter((a) => a.runId === run.id);
    out.push({
      cycleId: c.id,
      clientName: c.client.businessName || c.client.displayName,
      payDate: ymdOf(c.payDate),
      runStatus: run.status,
      round: run.approvalRound,
      currentVersion: versions.find((v) => v.id === run.currentVersionId)?.number ?? null,
      approvers: all.map((a) => {
        const current = mine.find((x) => x.portalUserId === a.portalUserId && x.round === run.approvalRound && x.versionId === run.currentVersionId);
        return { name: a.portalUser.name, required: required.some((r) => r.portalUserId === a.portalUserId), decision: current?.decision ?? (run.status === "AWAITING_APPROVAL" ? "PENDING" : null), at: current?.createdAt ?? null, comment: current?.comment ?? null };
      }),
      history: mine.map((a) => ({ name: a.approverName, decision: a.decision, round: a.round, version: a.version.number, at: a.createdAt, channel: a.channel, comment: a.comment })),
    });
  }
  return out;
}

/** Completed Work tab: processed cycles with their ADP confirmations. */
export async function completedWork(actor: Actor) {
  const access = await assertPayrollTaxView(actor);
  const cycles = await prisma.payrollCycle.findMany({ where: { AND: [cycleScope(access), { processedAt: { not: null } }] }, include: CYCLE_INCLUDE, orderBy: { payDate: "desc" }, take: 100 });
  const docs = await prisma.document.findMany({ where: { id: { in: cycles.map((c) => c.confirmationDocumentId!).filter(Boolean) }, deletedAt: null }, select: { id: true, title: true } });
  const runs = await runsFor(cycles);
  const names = await staffNames(cycles.map((c) => c.processedById));
  return cycles.map((c) => ({ cycleId: c.id, clientName: c.client.businessName || c.client.displayName, payDate: ymdOf(c.payDate), processedAt: c.processedAt!, processedBy: c.processedById ? names.get(c.processedById) ?? "Former staff member" : null, confirmation: docs.find((x) => x.id === c.confirmationDocumentId) ?? null, note: c.confirmationNote, versionNumber: c.payrollRunId ? runs.get(c.payrollRunId)?.versionNumber ?? null : null }));
}

// --- One cycle ----------------------------------------------------------------------------------

async function loadCycle(actor: Actor, cycleId: string, need: "view" | "manage") {
  const access = need === "manage" ? await assertPayrollTaxManage(actor) : await assertPayrollTaxView(actor);
  const cycle = await prisma.payrollCycle.findFirst({ where: { AND: [{ id: cycleId }, cycleScope(access)] }, include: CYCLE_INCLUDE });
  if (!cycle) throw new ForbiddenError("Not found.");
  return { access, cycle };
}

export async function cycleDetail(actor: Actor, cycleId: string, today = todayCentral()) {
  const { access, cycle } = await loadCycle(actor, cycleId, "view");
  const runRow = cycle.payrollRunId ? await prisma.payrollRun.findUnique({ where: { id: cycle.payrollRunId } }) : null;
  const current = runRow?.currentVersionId ? await prisma.payrollRunVersion.findUnique({ where: { id: runRow.currentVersionId }, include: { lines: { orderBy: { sortOrder: "asc" } } } }) : null;
  const [versions, approvals, events, reminders, approvers] = await Promise.all([
    runRow ? prisma.payrollRunVersion.findMany({ where: { runId: runRow.id }, orderBy: { number: "asc" }, select: { id: true, number: true, createdAt: true, reason: true, documentId: true, grossCents: true, netPayCents: true, employerTaxCents: true, contentHash: true } }) : [],
    runRow ? prisma.payrollApproval.findMany({ where: { runId: runRow.id }, orderBy: { createdAt: "asc" }, include: { version: { select: { number: true } } } }) : [],
    runRow ? prisma.payrollRunEvent.findMany({ where: { runId: runRow.id }, orderBy: { createdAt: "asc" } }) : [],
    prisma.payrollReminder.findMany({ where: { cycleId }, orderBy: { createdAt: "desc" }, take: 50 }),
    requiredApprovers(cycle.clientId),
  ]);
  const docIds = [...new Set([...versions.map((v) => v.documentId), cycle.confirmationDocumentId].filter((x): x is string => !!x))];
  const docs = docIds.length ? await prisma.document.findMany({ where: { id: { in: docIds } }, select: { id: true, title: true, createdAt: true } }) : [];
  const [row] = await rowsOf([cycle], today);
  const names = await staffNames([assigneeOf(cycle), cycle.processedById, cycle.errorFlaggedById, cycle.hoursSubmittedByStaff]);
  const portalBy = cycle.hoursSubmittedByPortal ? await prisma.portalUser.findUnique({ where: { id: cycle.hoursSubmittedByPortal }, select: { name: true } }) : null;
  // Employee-level detail: the same check the existing pay-run screen uses (the books rule).
  const employeeDetail = await canUseLedger(actor, cycle.clientId);
  const profile = await prisma.bookkeepingProfile.findUnique({ where: { clientId: cycle.clientId }, select: { payroll: true, payrollSystem: true } });
  return {
    access,
    canManage: access.level === "MANAGE",
    cycle,
    row,
    run: runRow,
    version: current ? { ...current, lines: employeeDetail ? current.lines : [] } : null,
    employeeDetail,
    versions,
    approvals,
    events,
    reminders,
    approvers,
    docs,
    profile,
    hours: (cycle.hoursSubmission as HoursSubmission | null) ?? null,
    hoursBy: portalBy?.name ?? (cycle.hoursSubmittedByStaff ? `${names.get(cycle.hoursSubmittedByStaff) ?? "Staff"} (for the client)` : null),
    names,
    staff: await assignableStaff(),
  };
}

// --- Assignment ----------------------------------------------------------------------------------

export async function setCycleAssignee(actor: Actor, cycleId: string, staffId: string | null) {
  const { cycle } = await loadCycle(actor, cycleId, "manage");
  await assertAssignable(staffId);
  await prisma.payrollCycle.update({ where: { id: cycle.id }, data: { assignedStaffId: staffId || null } });
  await audit(prisma, { actorId: actor.id, action: "payroll_taxes.cycle_assigned", entityType: "PayrollCycle", entityId: cycle.id, clientId: cycle.clientId, details: { from: cycle.assignedStaffId, to: staffId || null, scheduleDefault: cycle.schedule.assignedStaffId } });
}

// --- Hours ----------------------------------------------------------------------------------------

const MAX_EMPLOYEES = 200;

/** Cleans a submitted hours form; refuses anything that isn't hours, notes or the change flags. */
export function parseHours(raw: unknown): HoursSubmission {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const noChanges = r.noChanges === true;
  const list = Array.isArray(r.employees) ? r.employees : [];
  if (list.length > MAX_EMPLOYEES) throw new ValidationError(`Up to ${MAX_EMPLOYEES} employees per submission.`);
  const num = (v: unknown, label: string) => {
    const s = typeof v === "number" ? v : typeof v === "string" && v.trim() ? Number(v) : 0;
    if (!Number.isFinite(s) || s < 0 || s > 200) throw new ValidationError(`${label} must be a number of hours from 0 to 200.`);
    return Math.round(s * 100) / 100;
  };
  const employees = list
    .map((e) => (e && typeof e === "object" ? (e as Record<string, unknown>) : {}))
    .map((e) => ({ name: String(e.name ?? "").trim().slice(0, 120), regularHours: num(e.regularHours, "Regular hours"), overtimeHours: num(e.overtimeHours, "Overtime hours"), notes: String(e.notes ?? "").trim().slice(0, 300) }))
    .filter((e) => e.name || e.regularHours || e.overtimeHours || e.notes);
  if (employees.some((e) => !e.name)) throw new ValidationError("Give each row an employee name.");
  const flags = (Array.isArray(r.flags) ? r.flags : []).filter((f): f is ChangeFlag => typeof f === "string" && f in CHANGE_FLAGS);
  const notes = String(r.notes ?? "").trim().slice(0, 2000);
  if (!noChanges && !employees.length) throw new ValidationError("Enter each employee's hours, or choose “No changes — same as last period”.");
  return { noChanges, employees: noChanges ? [] : employees, flags: [...new Set(flags)], notes };
}

function assertHoursOpen(cycle: { processedAt: Date | null }, run: { status: string } | null) {
  if (cycle.processedAt) throw new ValidationError("This payroll is already processed.");
  if (run && run.status !== "DRAFT" && run.status !== "DISCARDED") throw new ValidationError("The office has already prepared this payroll. Send any changes as a message to the office.");
}

/** Staff record hours the client gave them (phone, email, paper). */
export async function recordHoursByStaff(actor: Actor, cycleId: string, raw: unknown) {
  await assertStaff(actor);
  const { cycle } = await loadCycle(actor, cycleId, "manage");
  const run = cycle.payrollRunId ? await prisma.payrollRun.findUnique({ where: { id: cycle.payrollRunId } }) : null;
  assertHoursOpen(cycle, run);
  const hours = parseHours(raw);
  await prisma.payrollCycle.update({ where: { id: cycle.id }, data: { hoursSubmission: hours as unknown as Prisma.InputJsonValue, hoursSubmittedAt: new Date(), hoursSubmittedByStaff: actor.id, hoursSubmittedByPortal: null } });
  await audit(prisma, { actorId: actor.id, action: "payroll_taxes.hours_recorded", entityType: "PayrollCycle", entityId: cycle.id, clientId: cycle.clientId, details: { employees: hours.employees.length, noChanges: hours.noChanges, flags: hours.flags, resubmitted: !!cycle.hoursSubmittedAt } });
}

/** Staff note that they asked for hours outside Client Connect (no message is sent). */
export async function markHoursRequested(actor: Actor, cycleId: string) {
  const { cycle } = await loadCycle(actor, cycleId, "manage");
  if (cycle.hoursRequestedAt) return;
  await prisma.payrollCycle.update({ where: { id: cycle.id }, data: { hoursRequestedAt: new Date() } });
  await audit(prisma, { actorId: actor.id, action: "payroll_taxes.hours_requested_manually", entityType: "PayrollCycle", entityId: cycle.id, clientId: cycle.clientId });
}

/** Who at the business may send hours: a payroll approver, or a login allowed to upload payroll. */
export async function mayUploadHours(portalUserId: string, clientId: string) {
  const access = await requireClientAccess(portalUserId, clientId).catch(() => null);
  if (!access) return false;
  return access.canUploadPayroll || (await isPayrollApprover(portalUserId, clientId));
}

/** The client's own hours submission from the portal. Only for their own business's open cycle. */
export async function submitHoursByPortal(portalUserId: string, clientId: string, cycleId: string, raw: unknown) {
  if (!(await mayUploadHours(portalUserId, clientId))) throw new ForbiddenError("You don't have access to that account.");
  const cycle = await prisma.payrollCycle.findFirst({ where: { id: cycleId, clientId, schedule: { active: true } } });
  if (!cycle) throw new ForbiddenError("You don't have access to that account.");
  const run = cycle.payrollRunId ? await prisma.payrollRun.findUnique({ where: { id: cycle.payrollRunId } }) : null;
  assertHoursOpen(cycle, run);
  const hours = parseHours(raw);
  await prisma.payrollCycle.update({ where: { id: cycle.id }, data: { hoursSubmission: hours as unknown as Prisma.InputJsonValue, hoursSubmittedAt: new Date(), hoursSubmittedByPortal: portalUserId, hoursSubmittedByStaff: null } });
  await audit(prisma, { actorId: null, action: "payroll_taxes.hours_submitted_by_client", entityType: "PayrollCycle", entityId: cycle.id, clientId, details: { portalUserId, employees: hours.employees.length, noChanges: hours.noChanges, flags: hours.flags, resubmitted: !!cycle.hoursSubmittedAt } });
}

// --- Workup ---------------------------------------------------------------------------------------

export type UploadedFile = { bytes: Uint8Array; fileName: string };
const isPdf = (f: UploadedFile) => f.bytes.length > 4 && f.bytes[0] === 0x25 && f.bytes[1] === 0x50 && f.bytes[2] === 0x44 && f.bytes[3] === 0x46;
const sha256 = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

async function storePdf(actor: Actor, cycle: { clientId: string; payDate: Date }, file: UploadedFile, docType: "PAYROLL_PREVIEW" | "PAYROLL_CONFIRMATION") {
  if (!isPdf(file)) throw new ValidationError(docType === "PAYROLL_PREVIEW" ? "Attach ADP's preview as a PDF (or import the register as CSV / .xlsx)." : "Attach ADP's confirmation or payroll summary as a PDF.");
  const pay = ymdOf(cycle.payDate);
  const doc = await staffUploadDocument(actor, {
    clientId: cycle.clientId,
    category: "BOOKKEEPING",
    docType,
    visibility: "STAFF_ONLY",
    title: `${docType === "PAYROLL_PREVIEW" ? "ADP payroll preview" : "ADP payroll confirmation"} — pay date ${pay}`,
    year: Number(pay.slice(0, 4)),
    month: Number(pay.slice(5, 7)),
    bytes: file.bytes,
    originalName: file.fileName,
    notify: false,
  });
  return { id: doc.id, sha256: sha256(file.bytes) } satisfies VersionDocument;
}

async function linkRun(tx: Tx | typeof prisma, cycleId: string, runId: string) {
  const taken = await tx.payrollCycle.findFirst({ where: { payrollRunId: runId, NOT: { id: cycleId } } });
  if (taken) throw new ValidationError("That pay run already belongs to another pay cycle.");
  await tx.payrollCycle.update({ where: { id: cycleId }, data: { payrollRunId: runId } });
}

async function currentRun(cycle: { payrollRunId: string | null }) {
  if (!cycle.payrollRunId) return null;
  const run = await prisma.payrollRun.findUnique({ where: { id: cycle.payrollRunId } });
  return run && run.status !== "DISCARDED" ? run : null;
}

/**
 * Staff upload ADP's preview / register report for the cycle:
 * - a PDF is kept in the client's file (BOOKKEEPING, PAYROLL_PREVIEW, staff only) and bound into a
 *   new version of the cycle's pay run (approvers see it on their approval screen);
 * - a CSV / .xlsx goes through the existing register import and the run for this pay date is linked.
 */
export async function uploadPreview(actor: Actor, cycleId: string, file: UploadedFile, opts: { preset?: string } = {}) {
  await assertStaff(actor);
  const { cycle } = await loadCycle(actor, cycleId, "manage");
  if (cycle.processedAt) throw new ValidationError("This payroll is already processed.");
  const run = await currentRun(cycle);
  if (/\.(csv|xlsx)$/i.test(file.fileName)) {
    if (run) throw new ValidationError(`This cycle already has a pay run (v${(await loadRun(cycle.clientId, run.id)).version.number}). Key in corrected totals or attach a revised PDF instead.`);
    const profile = await prisma.bookkeepingProfile.findUnique({ where: { clientId: cycle.clientId } });
    const preset = opts.preset || (isPayrollSystem(profile?.payrollSystem) && profile!.payrollSystem!.startsWith("ADP") ? profile!.payrollSystem! : "ADP_RUN");
    const imp = await importPayrollRegister(actor, cycle.clientId, { bytes: file.bytes, fileName: file.fileName, preset, defaultCheckDate: ymdOf(cycle.payDate) });
    const pay = ymdOf(cycle.payDate);
    const match = await prisma.payrollRun.findFirst({ where: { clientId: cycle.clientId, checkDate: d(pay), status: { not: "DISCARDED" }, OR: [{ id: { in: imp.created } }, { importId: imp.importId }] }, orderBy: { createdAt: "desc" } });
    if (!match) {
      throw new ValidationError(imp.unbalanced.length ? `The register's totals don't tie out (${imp.unbalanced.map((u) => `${u.checkDate}: off by ${usd(u.differenceCents)}`).join(", ")}), so nothing was linked.` : `The register has no pay date ${pay}, so nothing was linked to this cycle. Its pay runs were saved as drafts in the client's payroll.`);
    }
    await linkRun(prisma, cycle.id, match.id);
    await audit(prisma, { actorId: actor.id, action: "payroll_taxes.register_uploaded", entityType: "PayrollCycle", entityId: cycle.id, clientId: cycle.clientId, details: { runId: match.id, importId: imp.importId, documentId: imp.documentId } });
    return { runId: match.id, kind: "REGISTER" as const };
  }
  if (!run) throw new ValidationError("Key in the totals (or import ADP's register) first, then attach the preview PDF — or attach the PDF together with the totals.");
  const doc = await storePdf(actor, cycle, file, "PAYROLL_PREVIEW");
  const v = await attachRunDocument(actor, cycle.clientId, run.id, doc, run.status === "DENIED" ? "Revised ADP preview attached" : "ADP preview attached");
  await audit(prisma, { actorId: actor.id, action: "payroll_taxes.preview_uploaded", entityType: "PayrollCycle", entityId: cycle.id, clientId: cycle.clientId, details: { runId: run.id, documentId: doc.id, version: v.number } });
  return { runId: run.id, kind: "PDF" as const, version: v.number };
}

export type ManualTotals = { employees: number; hours?: number; grossCents: number; employeeTaxCents: number; deductionsCents: number; netPayCents: number; employerTaxCents: number; reason?: string | null };

/** Staff key in the preview's totals (origin MANUAL), optionally with ADP's preview PDF. */
export async function saveManualTotals(actor: Actor, cycleId: string, t: ManualTotals, pdf?: UploadedFile | null) {
  await assertStaff(actor);
  const { cycle } = await loadCycle(actor, cycleId, "manage");
  if (cycle.processedAt) throw new ValidationError("This payroll is already processed.");
  const amounts: Amounts = { hoursHundredths: Math.round((t.hours ?? 0) * 100), grossCents: t.grossCents, federalWhCents: t.employeeTaxCents, ssEeCents: 0, medicareEeCents: 0, stateWhCents: 0, otherEeTaxCents: 0, employerTaxCents: t.employerTaxCents, deductionsCents: t.deductionsCents, netPayCents: t.netPayCents };
  if (Object.values(amounts).some((v) => !Number.isInteger(v) || v < 0)) throw new ValidationError("Amounts must be zero or more.");
  if (!Number.isInteger(t.employees) || t.employees < 1 || t.employees > 10000) throw new ValidationError("Enter how many employees are paid.");
  if (!t.grossCents) throw new ValidationError("Enter the gross wages from ADP's preview.");
  const diff = differenceOf(amounts);
  if (diff !== 0) throw new ValidationError(`Gross − employee taxes − deductions must equal net pay. It's off by ${usd(diff)}.`);
  const line = { ...amounts, employeeName: "All employees (totals keyed in from ADP)" };
  const doc = pdf && pdf.bytes.length ? await storePdf(actor, cycle, pdf, "PAYROLL_PREVIEW") : null;
  const run = await currentRun(cycle);
  const pay = ymdOf(cycle.payDate);
  if (run) {
    const v = await editPayrollRun(actor, cycle.clientId, run.id, { lines: [line], employeesOverride: t.employees, reason: t.reason?.trim() || (run.status === "DENIED" ? "Revised totals after the client's comments" : "Totals keyed in from ADP's preview"), ...(doc ? { document: doc } : {}) });
    await audit(prisma, { actorId: actor.id, action: "payroll_taxes.totals_keyed", entityType: "PayrollCycle", entityId: cycle.id, clientId: cycle.clientId, details: { runId: run.id, version: v.number, documentId: doc?.id ?? null } });
    return { runId: run.id, version: v.number };
  }
  const profile = await prisma.bookkeepingProfile.findUnique({ where: { clientId: cycle.clientId } });
  const provider = isPayrollSystem(profile?.payrollSystem) ? profile!.payrollSystem! : "ADP_RUN";
  const totals: PayDateTotals = { ...amounts, checkDate: pay, periodStart: ymdOf(cycle.periodStart), periodEnd: ymdOf(cycle.periodEnd), employees: t.employees, lines: [line], differenceCents: 0, totalsHash: createHash("sha256").update(JSON.stringify(["MANUAL", cycle.id, Date.now(), amounts])).digest("hex").slice(0, 16) };
  const runId = await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${"payroll:" + cycle.clientId}))`;
    const r = await createRunsFromPayDates(tx, actor, cycle.clientId, { provider, origin: "MANUAL", payDates: [totals], document: doc, employeesOverride: t.employees, reason: t.reason?.trim() || "Totals keyed in from ADP's preview" });
    const id = r.created[0];
    if (!id) throw new ValidationError("Those totals couldn't be saved.");
    await linkRun(tx, cycle.id, id);
    await audit(tx, { actorId: actor.id, action: "payroll_taxes.totals_keyed", entityType: "PayrollCycle", entityId: cycle.id, clientId: cycle.clientId, details: { runId: id, version: 1, documentId: doc?.id ?? null } });
    return id;
  });
  return { runId, version: 1 };
}

/** "Send for client approval": the existing request (a new approval round on the current version). */
export async function sendForClientApproval(actor: Actor, cycleId: string) {
  await assertStaff(actor);
  const { cycle } = await loadCycle(actor, cycleId, "manage");
  const run = await currentRun(cycle);
  if (!run) throw new ValidationError("Prepare the preview first (totals or ADP's register).");
  const r = await requestPayrollApproval(actor, cycle.clientId, run.id);
  if (cycle.errorFlaggedAt) await prisma.payrollCycle.update({ where: { id: cycle.id }, data: { errorFlaggedAt: null, errorFlaggedById: null } });
  await audit(prisma, { actorId: actor.id, action: "payroll_taxes.sent_for_approval", entityType: "PayrollCycle", entityId: cycle.id, clientId: cycle.clientId, details: { runId: run.id, round: r.run.approvalRound, notices: r.notices.map((n) => n.status), clearedStaffFlag: !!cycle.errorFlaggedAt } });
  return r;
}

/** Staff flag an error they found themselves: the cycle goes to Needs correction. */
export async function flagCycleError(actor: Actor, cycleId: string, note: string) {
  const { cycle } = await loadCycle(actor, cycleId, "manage");
  const text = note?.trim() ?? "";
  if (text.length < 3) throw new ValidationError("Say what needs correcting.");
  if (cycle.processedAt) throw new ValidationError("This payroll is already processed.");
  await prisma.payrollCycle.update({ where: { id: cycle.id }, data: { errorFlaggedAt: new Date(), errorFlaggedById: actor.id, errorNote: text.slice(0, 1000) } });
  await audit(prisma, { actorId: actor.id, action: "payroll_taxes.error_flagged", entityType: "PayrollCycle", entityId: cycle.id, clientId: cycle.clientId, details: { note: text.slice(0, 300) } });
}

export async function clearCycleError(actor: Actor, cycleId: string) {
  const { cycle } = await loadCycle(actor, cycleId, "manage");
  if (!cycle.errorFlaggedAt) return;
  await prisma.payrollCycle.update({ where: { id: cycle.id }, data: { errorFlaggedAt: null, errorFlaggedById: null } });
  await audit(prisma, { actorId: actor.id, action: "payroll_taxes.error_cleared", entityType: "PayrollCycle", entityId: cycle.id, clientId: cycle.clientId });
}

/** "Mark Submitted in ADP": the existing recorded human step (never automatic). */
export async function markSubmittedInAdp(actor: Actor, cycleId: string, note?: string | null) {
  await assertStaff(actor);
  const { cycle } = await loadCycle(actor, cycleId, "manage");
  const run = await currentRun(cycle);
  if (!run) throw new ValidationError("There's no pay run for this cycle yet.");
  if (cycle.errorFlaggedAt) throw new ValidationError("Clear the error flag (or send a revised preview) before submitting.");
  const r = await submitPayrollRun(actor, cycle.clientId, run.id, { note });
  await audit(prisma, { actorId: actor.id, action: "payroll_taxes.submitted_in_adp", entityType: "PayrollCycle", entityId: cycle.id, clientId: cycle.clientId, details: { runId: run.id } });
  return r;
}

/**
 * "Mark processed": requires ADP's confirmation / payroll summary (PDF, kept in the client file as
 * PAYROLL_CONFIRMATION) plus optional details. Writes a PROCESSED event on the pay run.
 */
export async function markProcessed(actor: Actor, cycleId: string, file: UploadedFile | null, details: { note?: string | null } = {}) {
  await assertStaff(actor);
  const { cycle } = await loadCycle(actor, cycleId, "manage");
  if (cycle.processedAt) throw new ValidationError("This cycle is already marked processed.");
  const run = await currentRun(cycle);
  if (!run || run.status !== "SUBMITTED") throw new ValidationError("Mark it Submitted in ADP first.");
  if (!file || !file.bytes.length) throw new ValidationError("Attach ADP's confirmation or payroll summary (PDF).");
  const doc = await storePdf(actor, cycle, file, "PAYROLL_CONFIRMATION");
  const note = details.note?.trim().slice(0, 500) || null;
  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${"payroll-run:" + run.id}))`;
    const { run: fresh, version } = await loadRun(cycle.clientId, run.id, tx);
    if (fresh.status !== "SUBMITTED") throw new ValidationError("Mark it Submitted in ADP first.");
    await tx.payrollRun.update({ where: { id: run.id }, data: { status: "PROCESSED" } });
    await event(tx, run.id, "PROCESSED", { userId: actor.id, name: actor.name }, { versionNumber: version.number, note: `Processed by ADP — confirmation saved to the client file${note ? `. ${note}` : ""}` });
    await tx.payrollCycle.update({ where: { id: cycle.id }, data: { processedAt: new Date(), processedById: actor.id, confirmationDocumentId: doc.id, confirmationNote: note } });
    await audit(tx, { actorId: actor.id, action: "payroll_taxes.processed", entityType: "PayrollCycle", entityId: cycle.id, clientId: cycle.clientId, details: { runId: run.id, version: version.number, confirmationDocumentId: doc.id } });
  });
}

// --- Client portal ---------------------------------------------------------------------------------

/**
 * One business's payroll requests for one portal login: open hours requests (with the form),
 * approvals waiting on THIS login (they open on the existing approval page), upcoming deadlines and
 * the payroll documents the office released. Null when this login has no part in payroll here.
 */
export async function portalPayrollRequests(portalUserId: string, clientId: string, today = todayCentral()) {
  const access = await requireClientAccess(portalUserId, clientId);
  const approver = await isPayrollApprover(portalUserId, clientId);
  const uploader = access.canUploadPayroll || approver;
  if (!uploader) return null;
  const schedule = await prisma.payrollSchedule.findUnique({ where: { clientId } });
  if (!schedule?.active) return null;
  const cycles = await prisma.payrollCycle.findMany({ where: { clientId, processedAt: null, payDate: { gte: d(addDays(today, -7)) } }, orderBy: { payDate: "asc" }, take: 12 });
  const runs = await runsFor(cycles);
  const hours = cycles.filter((c) => {
    const run = c.payrollRunId ? runs.get(c.payrollRunId) : null;
    const open = !run || run.status === "DRAFT" || run.status === "DISCARDED";
    return open && (c.hoursRequestedAt || today >= ymdOf(c.hoursRequestDate)) && today <= ymdOf(c.payDate);
  });
  const awaiting = [];
  if (approver) {
    for (const c of cycles) {
      const run = c.payrollRunId ? runs.get(c.payrollRunId) : null;
      if (!run || run.status !== "AWAITING_APPROVAL") continue;
      const decided = await prisma.payrollApproval.count({ where: { runId: run.id, round: run.approvalRound, portalUserId } });
      if (!decided) awaiting.push({ cycleId: c.id, payDate: ymdOf(c.payDate), approvalDue: ymdOf(c.approvalDueDate), version: run.versionNumber });
    }
  }
  const documents = await prisma.document.findMany({ where: { clientId, deletedAt: null, visibility: "PUBLISHED", OR: [{ category: "PAYROLL" }, { docType: { startsWith: "PAYROLL" } }] }, orderBy: { createdAt: "desc" }, take: 20, select: { id: true, title: true, createdAt: true } });
  return {
    approver,
    hours: hours.map((c) => ({ cycleId: c.id, payDate: ymdOf(c.payDate), periodStart: ymdOf(c.periodStart), periodEnd: ymdOf(c.periodEnd), hoursDue: ymdOf(c.hoursDueDate), submittedAt: c.hoursSubmittedAt, submission: (c.hoursSubmission as HoursSubmission | null) ?? null })),
    awaiting,
    deadlines: cycles.slice(0, 4).map((c) => ({ cycleId: c.id, payDate: ymdOf(c.payDate), hoursDue: ymdOf(c.hoursDueDate), approvalDue: ymdOf(c.approvalDueDate) })),
    documents,
  };
}

// --- Reminder plans --------------------------------------------------------------------------------

export async function reminderPlan(key = "global"): Promise<ReminderStep[]> {
  const own = await prisma.payrollReminderPlan.findUnique({ where: { key } });
  if (own) return normalizePlan(own.steps);
  if (key !== "global") return reminderPlan("global");
  return DEFAULT_PLAN;
}

export async function hasClientPlan(clientId: string) {
  return (await prisma.payrollReminderPlan.count({ where: { key: clientId } })) > 0;
}

/** Owner or MANAGE staff: the global plan, or one client's own plan. */
export async function saveReminderPlan(actor: Actor, key: string, raw: unknown) {
  await assertPayrollTaxManage(actor);
  if (key !== "global" && !(await prisma.payrollSchedule.count({ where: { clientId: key } }))) throw new ValidationError("Choose a client with a payroll schedule.");
  const steps = normalizePlan(raw);
  const before = await prisma.payrollReminderPlan.findUnique({ where: { key } });
  await prisma.payrollReminderPlan.upsert({ where: { key }, create: { key, steps: steps as unknown as Prisma.InputJsonValue, updatedById: actor.id }, update: { steps: steps as unknown as Prisma.InputJsonValue, updatedById: actor.id } });
  await audit(prisma, { actorId: actor.id, action: "payroll_taxes.reminder_plan_saved", entityType: "PayrollReminderPlan", entityId: key, clientId: key === "global" ? null : key, details: { before: (before?.steps ?? null) as Prisma.InputJsonValue, after: steps as unknown as Prisma.InputJsonValue } });
  return steps;
}

export async function resetClientPlan(actor: Actor, clientId: string) {
  await assertPayrollTaxManage(actor);
  const r = await prisma.payrollReminderPlan.deleteMany({ where: { key: clientId } });
  if (r.count) await audit(prisma, { actorId: actor.id, action: "payroll_taxes.reminder_plan_reset", entityType: "PayrollReminderPlan", entityId: clientId, clientId });
}

export { payrollTaxAccess, isPrimaryOwner };
