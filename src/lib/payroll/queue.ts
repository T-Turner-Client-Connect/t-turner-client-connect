/**
 * The ADP Payroll & Taxes work queue: where each pay cycle stands, its next deadline, and the next
 * thing the office does. Pure (browser-safe), so the screens, the reminder engine and the tests
 * read the same mapping.
 */
import { daysBetween } from "./schedule";

export const QUEUE_STATUS = {
  UPCOMING: { label: "Upcoming", tone: "gray" },
  WAITING_ON_HOURS: { label: "Waiting on hours", tone: "amber" },
  PREVIEW_TO_PREPARE: { label: "Preview to prepare", tone: "navy" },
  AWAITING_CLIENT_APPROVAL: { label: "Awaiting client approval", tone: "gold" },
  NEEDS_CORRECTION: { label: "Needs correction", tone: "red" },
  READY_TO_PROCESS: { label: "Ready to process", tone: "green" },
  SUBMITTED_IN_ADP: { label: "Submitted in ADP", tone: "navy" },
  // Future provider API: ADP acknowledged the pay data. Still not processed until verified.
  ACCEPTED_BY_ADP: { label: "Accepted by ADP", tone: "navy" },
  PROCESSED: { label: "Processed", tone: "green" },
} as const;
export type QueueStatus = keyof typeof QUEUE_STATUS;

export type CycleFacts = {
  payDate: string;
  hoursRequestDate: string;
  hoursDueDate: string;
  approvalDueDate: string;
  adpCutoffDate: string;
  hoursRequestedAt: Date | null;
  hoursSubmittedAt: Date | null;
  errorFlaggedAt: Date | null;
  processedAt: Date | null;
  /** The linked pay run, if any (a DISCARDED run counts as none). */
  run: { status: string; currentVersionId: string | null; fullyApprovedVersionId?: string | null } | null;
};

/** The one mapping from a cycle's facts to its queue status. */
export function queueStatus(c: CycleFacts, today: string): QueueStatus {
  const run = c.run && c.run.status !== "DISCARDED" ? c.run : null;
  // PROCESSED only once verified (cycle.processedAt is set with its verification); never from SUBMITTED.
  if (c.processedAt || run?.status === "PROCESSED") return "PROCESSED";
  if (run?.status === "PROVIDER_ACCEPTED") return "ACCEPTED_BY_ADP";
  if (run?.status === "SUBMITTED") return "SUBMITTED_IN_ADP";
  if (c.errorFlaggedAt || run?.status === "DENIED") return "NEEDS_CORRECTION";
  // Ready only when the approvals are on the CURRENT version (the approval service resets the
  // status when a new version is made, so FULLY_APPROVED already implies it).
  if (run?.status === "FULLY_APPROVED") return "READY_TO_PROCESS";
  if (run?.status === "AWAITING_APPROVAL") return "AWAITING_CLIENT_APPROVAL";
  if (run || c.hoursSubmittedAt) return "PREVIEW_TO_PREPARE";
  if (c.hoursRequestedAt || today >= c.hoursRequestDate) return "WAITING_ON_HOURS";
  return "UPCOMING";
}

export const ITEM_LABEL: Record<QueueStatus, string> = {
  UPCOMING: "Hours request goes out",
  WAITING_ON_HOURS: "Hours due from client",
  PREVIEW_TO_PREPARE: "Preview to client for approval",
  AWAITING_CLIENT_APPROVAL: "Client approval due",
  NEEDS_CORRECTION: "Revised preview due",
  READY_TO_PROCESS: "Submit in ADP by cutoff",
  SUBMITTED_IN_ADP: "Pay date (confirm processed)",
  ACCEPTED_BY_ADP: "Pay date (confirm processed)",
  PROCESSED: "Processed",
};

export const NEXT_ACTION: Record<QueueStatus, string> = {
  UPCOMING: "Open cycle",
  WAITING_ON_HOURS: "Record hours",
  PREVIEW_TO_PREPARE: "Prepare preview",
  AWAITING_CLIENT_APPROVAL: "View approvals",
  NEEDS_CORRECTION: "Send revised preview",
  READY_TO_PROCESS: "Mark submitted in ADP",
  SUBMITTED_IN_ADP: "Mark processed",
  ACCEPTED_BY_ADP: "Mark processed",
  PROCESSED: "View confirmation",
};

/** The deadline that matters for this status (the one a countdown shows). */
export function deadlineFor(c: CycleFacts, s: QueueStatus): string | null {
  switch (s) {
    case "UPCOMING": return c.hoursRequestDate;
    case "WAITING_ON_HOURS": return c.hoursDueDate;
    case "PREVIEW_TO_PREPARE":
    case "AWAITING_CLIENT_APPROVAL":
    case "NEEDS_CORRECTION": return c.approvalDueDate;
    case "READY_TO_PROCESS": return c.adpCutoffDate;
    case "SUBMITTED_IN_ADP":
    case "ACCEPTED_BY_ADP": return c.payDate;
    case "PROCESSED": return null;
  }
}

/**
 * Overdue: the deadline for where the cycle stands has passed (the day after it). An UPCOMING
 * cycle is overdue once hours are past due; submitted and processed cycles never are.
 */
export function isOverdue(c: CycleFacts, s: QueueStatus, today: string): boolean {
  if (s === "PROCESSED" || s === "SUBMITTED_IN_ADP" || s === "ACCEPTED_BY_ADP") return false;
  const d = s === "UPCOMING" ? c.hoursDueDate : deadlineFor(c, s);
  return !!d && today > d;
}

export type QueueRow<T = unknown> = { status: QueueStatus; overdue: boolean; deadline: string | null; daysLeft: number | null; item: string; action: string; data: T };

export function toQueueRow<T>(c: CycleFacts, today: string, data: T): QueueRow<T> {
  const status = queueStatus(c, today);
  const deadline = deadlineFor(c, status);
  return { status, overdue: isOverdue(c, status, today), deadline, daysLeft: deadline ? daysBetween(today, deadline) : null, item: ITEM_LABEL[status], action: NEXT_ACTION[status], data };
}

/** Overdue first (pinned), then by deadline, processed last. */
export function sortQueue<T>(rows: QueueRow<T>[]): QueueRow<T>[] {
  return [...rows].sort((a, b) => Number(b.overdue) - Number(a.overdue) || Number(a.status === "PROCESSED") - Number(b.status === "PROCESSED") || (a.deadline ?? "9999").localeCompare(b.deadline ?? "9999"));
}

/** Step keys of the reminder plan, in order. */
export const REMINDER_STEPS = {
  HOURS_REQUEST: { label: "Hours request", when: "On the hours request date (9 a.m. Central)", audience: "CLIENT" },
  HOURS_FOLLOWUP: { label: "Hours follow-up", when: "Hours before hours are due", audience: "CLIENT" },
  APPROVAL_REQUEST: { label: "Approval request", when: "When the preview is sent for approval (the existing request also emails a secure link)", audience: "CLIENT" },
  APPROVAL_REMINDER_1: { label: "Approval reminder", when: "Hours before the approval deadline", audience: "CLIENT" },
  APPROVAL_REMINDER_2: { label: "Final approval reminder", when: "Hours before the approval deadline", audience: "CLIENT" },
  OVERDUE_ALERT: { label: "Overdue alert to staff", when: "At the deadline, to the assigned staff member and the owner", audience: "STAFF" },
} as const;
export type ReminderStepKey = keyof typeof REMINDER_STEPS;
export const CHANNELS = { EMAIL: "Email", SMS: "Text (only with consent)", PORTAL: "Portal notice" } as const;
export type ReminderChannel = keyof typeof CHANNELS;
export type ReminderStep = { key: ReminderStepKey; enabled: boolean; hoursBefore: number | null; channels: ReminderChannel[] };

/** The defaults: hours request on the request date, follow-up 24h before hours due, approval at request / 24h / 4h, overdue alert at the deadline. */
export const DEFAULT_PLAN: ReminderStep[] = [
  { key: "HOURS_REQUEST", enabled: true, hoursBefore: null, channels: ["EMAIL", "SMS"] },
  { key: "HOURS_FOLLOWUP", enabled: true, hoursBefore: 24, channels: ["EMAIL", "SMS"] },
  { key: "APPROVAL_REQUEST", enabled: true, hoursBefore: null, channels: ["PORTAL"] },
  { key: "APPROVAL_REMINDER_1", enabled: true, hoursBefore: 24, channels: ["EMAIL", "SMS"] },
  { key: "APPROVAL_REMINDER_2", enabled: true, hoursBefore: 4, channels: ["EMAIL", "SMS"] },
  { key: "OVERDUE_ALERT", enabled: true, hoursBefore: null, channels: ["EMAIL", "PORTAL"] },
];

/** A stored plan, cleaned against the known steps (unknown keys dropped, missing ones defaulted). */
export function normalizePlan(raw: unknown): ReminderStep[] {
  const list = Array.isArray(raw) ? raw : [];
  return DEFAULT_PLAN.map((d) => {
    const r = list.find((x) => x && typeof x === "object" && (x as ReminderStep).key === d.key) as Partial<ReminderStep> | undefined;
    if (!r) return d;
    const channels = Array.isArray(r.channels) ? (r.channels.filter((c) => c in CHANNELS) as ReminderChannel[]) : d.channels;
    const hb = d.hoursBefore === null ? null : Number.isInteger(r.hoursBefore) && (r.hoursBefore as number) >= 1 && (r.hoursBefore as number) <= 168 ? (r.hoursBefore as number) : d.hoursBefore;
    return { key: d.key, enabled: r.enabled !== false, hoursBefore: hb, channels: [...new Set(channels)] };
  });
}

/** Change flags a client can tick with their hours. */
export const CHANGE_FLAGS = {
  NEW_HIRE: "New hire",
  TERMINATION: "Termination",
  RATE_CHANGE: "Pay rate change",
  BONUS: "Bonus",
  PTO: "PTO / time off",
} as const;
export type ChangeFlag = keyof typeof CHANGE_FLAGS;
export type HoursSubmission = {
  noChanges: boolean;
  employees: { name: string; regularHours: number; overtimeHours: number; notes: string }[];
  flags: ChangeFlag[];
  notes: string;
};
