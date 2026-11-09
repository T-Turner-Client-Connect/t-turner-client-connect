/**
 * Access review & offboarding — the catalog. Pure data (no database, no "server-only") so the
 * Owner's Office screens, the server checks and the tests read the same lists.
 *
 * Nothing here holds a credential or calls a vendor: the vendor list is a checklist the owner
 * answers by signing in to each service herself.
 */

/** A review is due this many days after the last completed one. */
export const REVIEW_INTERVAL_DAYS = 90;
const DAY = 24 * 60 * 60 * 1000;

export type Vendor = { key: string; label: string; what: string; offboard: string };

/** Accounts outside Client Connect that hold firm or client data. Order = display order. */
export const VENDORS: Vendor[] = [
  { key: "netlify", label: "Netlify", what: "Hosting, database and environment settings for Client Connect.", offboard: "Remove them from the Netlify team (or confirm they never had a seat)." },
  { key: "google_workspace", label: "Google Workspace (email)", what: "Firm email, calendar and shared drives.", offboard: "Suspend their Google Workspace email, forward or delegate the mailbox, and transfer Drive files." },
  { key: "github", label: "GitHub", what: "Client Connect source code.", offboard: "Remove them from the GitHub organization and any repository they were added to." },
  { key: "plaid", label: "Plaid Dashboard", what: "Bank-feed keys and connected institutions.", offboard: "Remove them from the Plaid Dashboard team." },
  { key: "square", label: "Square", what: "Payments, invoices and the card-on-file record.", offboard: "Remove their Square team member account or permission set, and any device code." },
  { key: "resend", label: "Resend", what: "Outgoing email (API keys and sending domain).", offboard: "Remove them from the Resend team; rotate any API key they could see." },
  { key: "twilio", label: "Twilio", what: "Text messaging (account SID and auth token).", offboard: "Remove them from the Twilio console users; rotate the auth token if they could see it." },
  { key: "jotform", label: "Jotform", what: "Client intake forms and submissions.", offboard: "Remove them from Jotform (team or sub-user) and transfer forms they own." },
  { key: "cloudmersive", label: "Cloudmersive", what: "Virus scanning of uploaded files (API key).", offboard: "Confirm they have no Cloudmersive login; rotate the API key if they could see it." },
  { key: "anthropic", label: "Anthropic", what: "The Coetha AI API key and console.", offboard: "Remove them from the Anthropic console organization; rotate the API key if they could see it." },
  { key: "taxact", label: "TaxAct", what: "Professional tax preparation software and client returns.", offboard: "Disable their TaxAct login (preparer seat) and reassign any returns in progress." },
];

export const VENDOR_KEYS = VENDORS.map((v) => v.key);

export type VendorAnswer = { key: string; label: string; appropriate: boolean; twoStep: boolean; note: string };

/** Lines on every offboarding checklist, after the vendor accounts. */
export const OFFBOARDING_EXTRAS: { key: string; label: string }[] = [
  { key: "reassign_work", label: "Client Connect: reassign their clients and open tasks to someone else" },
  { key: "alarm_codes", label: "Change the office alarm codes" },
  { key: "shared_passwords", label: "Change any shared passwords they knew (Wi-Fi, shared mailboxes, password manager items)" },
  { key: "keys_devices", label: "Collect office keys, laptops, phones, security keys and the scan key" },
];

/** The checklist for one offboarding: TaxAct and Google Workspace first, then the rest of the vendors, then the office items. */
export function offboardingChecklist(): { key: string; label: string }[] {
  const first = ["taxact", "google_workspace"];
  const ordered = [...first.map((k) => VENDORS.find((v) => v.key === k)!), ...VENDORS.filter((v) => !first.includes(v.key))];
  return [...ordered.map((v) => ({ key: `vendor:${v.key}`, label: `${v.label}: ${v.offboard}` })), ...OFFBOARDING_EXTRAS];
}

/** When the next review is due: immediately if there has never been one, otherwise 90 days after the last. */
export function nextReviewDue(lastCompletedAt: Date | null | undefined): Date | null {
  return lastCompletedAt ? new Date(lastCompletedAt.getTime() + REVIEW_INTERVAL_DAYS * DAY) : null;
}

export type ReviewStatus = { dueAt: Date | null; due: boolean; overdue: boolean; daysLeft: number | null };

export function reviewStatus(lastCompletedAt: Date | null | undefined, now = new Date()): ReviewStatus {
  const dueAt = nextReviewDue(lastCompletedAt);
  if (!dueAt) return { dueAt: null, due: true, overdue: false, daysLeft: null };
  const daysLeft = Math.ceil((dueAt.getTime() - now.getTime()) / DAY);
  return { dueAt, due: now >= dueAt, overdue: now.getTime() - dueAt.getTime() >= DAY, daysLeft };
}

/** Title of the owner's reminder task (also its dedupe key: one open task at a time). */
export const REVIEW_TASK_TITLE = "Quarterly access review due";

/** Where every reminder (task, banner, email) sends the owner. */
export const ACCESS_REVIEW_PATH = "/owner/access-review";

/** The reminder task appears (as "upcoming") this many days before the due date. */
export const UPCOMING_WINDOW_DAYS = 14;

/**
 * One review cycle = the time between two completed reviews. Its key is the latest review's id
 * ("none" before the first review); a correction (Edit Review) never creates a review, so it never
 * starts a new cycle.
 */
export const reviewCycleKey = (lastReviewId: string | null | undefined) => lastReviewId ?? "none";
export const reminderTaskKey = (cycle: string) => `access-review:${cycle}`;
export const dueEmailKey = (cycle: string) => `access-review-due-email:${cycle}`;

/** Days since 1970-01-01 of the America/Chicago calendar date of this instant. */
function chicagoDay(d: Date): number {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone: "America/Chicago", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(d).map((x) => [x.type, x.value]),
  );
  return Math.round(Date.UTC(+p.year, +p.month - 1, +p.day) / DAY);
}

/** A due date as the office reads it: "Wednesday, February 3, 2027" (America/Chicago). */
export function fmtDueDate(d: Date): string {
  return new Intl.DateTimeFormat("en-US", { timeZone: "America/Chicago", weekday: "long", month: "long", day: "numeric", year: "numeric" }).format(d);
}

export type ReminderStage =
  | { stage: "quiet"; dueAt: Date; daysUntil: number }
  | { stage: "upcoming"; dueAt: Date; daysUntil: number }
  | { stage: "due"; dueAt: Date | null; daysUntil: 0 }
  | { stage: "overdue"; dueAt: Date; daysOverdue: number };

/**
 * Where the owner is in the reminder schedule, counted in America/Chicago calendar days:
 * quiet (more than 14 days left) → upcoming (14…1 days left: the task exists, labelled upcoming)
 * → due (the due date itself, or never reviewed) → overdue (every day after, until a new review).
 */
export function reminderStage(lastCompletedAt: Date | null | undefined, now = new Date()): ReminderStage {
  return stageForDue(nextReviewDue(lastCompletedAt), now);
}

/** The same schedule from a due date (null = never reviewed, so due now). */
export function stageForDue(dueAt: Date | null, now = new Date()): ReminderStage {
  if (!dueAt) return { stage: "due", dueAt: null, daysUntil: 0 };
  const days = chicagoDay(dueAt) - chicagoDay(now);
  if (days > UPCOMING_WINDOW_DAYS) return { stage: "quiet", dueAt, daysUntil: days };
  if (days > 0) return { stage: "upcoming", dueAt, daysUntil: days };
  if (days === 0) return { stage: "due", dueAt, daysUntil: 0 };
  return { stage: "overdue", dueAt, daysOverdue: -days };
}

/** The Owner's Office banner line for a stage (null while quiet). */
export function reminderBannerText(s: ReminderStage): { title: string; detail: string } | null {
  const plural = (n: number) => `${n} day${n === 1 ? "" : "s"}`;
  if (s.stage === "quiet") return null;
  if (s.stage === "upcoming") return { title: `Access review upcoming in ${plural(s.daysUntil)}`, detail: `Due ${fmtDueDate(s.dueAt)}.` };
  if (s.stage === "overdue") return { title: `Access review overdue by ${plural(s.daysOverdue)}`, detail: `It was due ${fmtDueDate(s.dueAt)}. The reminder stays open until you complete a new review.` };
  return { title: "Access review due", detail: s.dueAt ? `Due today, ${fmtDueDate(s.dueAt)}.` : "No access review has been completed yet." };
}

/** The only parts of a completed review that can ever be corrected (summary, findings, vendor answers). */
export type EditableReview = { summary: string; findings: string | null; vendorAnswers: VendorAnswer[] };

export type CorrectionRow = { field: string; label: string; previous: string; updated: string };

const VENDOR_FIELD_LABELS = { appropriate: "Access still appropriate", twoStep: "Two-step verification on", note: "Note" } as const;

/** One correction as readable lines: each changed field (or vendor answer) with previous → updated. */
export function correctionRows(c: { previous: EditableReview; updated: EditableReview; changedFields: string[] }): CorrectionRow[] {
  const yes = (b: boolean | undefined) => (b ? "Yes" : "Not confirmed");
  const text = (t: string | null | undefined) => (t && t.length ? t : "—");
  return c.changedFields.map((field) => {
    if (field === "summary") return { field, label: "Summary", previous: text(c.previous.summary), updated: text(c.updated.summary) };
    if (field === "findings") return { field, label: "Findings and changes made", previous: text(c.previous.findings), updated: text(c.updated.findings) };
    const m = /^vendor:([^.]+)\.(appropriate|twoStep|note)$/.exec(field);
    if (!m) return { field, label: field, previous: "—", updated: "—" };
    const [, key, f] = m as unknown as [string, string, keyof typeof VENDOR_FIELD_LABELS];
    const b = c.previous.vendorAnswers.find((v) => v.key === key);
    const a = c.updated.vendorAnswers.find((v) => v.key === key);
    const label = `${a?.label ?? b?.label ?? key} — ${VENDOR_FIELD_LABELS[f]}`;
    if (f === "note") return { field, label, previous: text(b?.note), updated: text(a?.note) };
    return { field, label, previous: yes(b?.[f]), updated: yes(a?.[f]) };
  });
}
