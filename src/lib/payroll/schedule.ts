/**
 * Payroll schedule date math for the ADP Payroll & Taxes workspace. Pure (no database), shared by
 * the generator, the screens and the tests. Dates are calendar dates ("YYYY-MM-DD", UTC math) so
 * they never shift with time zones.
 *
 * Rules:
 * - A pay date that lands on a weekend or US federal holiday moves EARLIER to the business day
 *   before it, never later (employees are paid on time).
 * - Every office deadline (hours request, hours due, approval due, ADP processing cutoff) is a
 *   number of business days before the (adjusted) pay date, so it is always a business day and
 *   always earlier.
 */

export const FREQUENCIES = {
  WEEKLY: "Weekly",
  BIWEEKLY: "Every two weeks",
  SEMIMONTHLY: "Twice a month",
  MONTHLY: "Monthly",
} as const;
export type Frequency = keyof typeof FREQUENCIES;
export const isFrequency = (v: string | null | undefined): v is Frequency => !!v && v in FREQUENCIES;

/** "31" in a semimonthly or monthly schedule means the last day of the month. */
export const LAST_DAY = 31;

/** Deadlines are due by this time (Central) on their date. */
export const DEADLINE_TIME = "17:00";

const pad = (n: number) => String(n).padStart(2, "0");
export const ymd = (y: number, m: number, d: number) => `${y}-${pad(m)}-${pad(d)}`;
const toDate = (s: string) => new Date(`${s}T00:00:00Z`);
const fromDate = (d: Date) => ymd(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
export const addDays = (s: string, n: number) => fromDate(new Date(toDate(s).getTime() + n * 86400_000));
export const weekday = (s: string) => toDate(s).getUTCDay();
export const daysBetween = (from: string, to: string) => Math.round((toDate(to).getTime() - toDate(from).getTime()) / 86400_000);
export const isYmd = (s: string | null | undefined): s is string => !!s && /^\d{4}-\d{2}-\d{2}$/.test(s) && toDate(s).toISOString().startsWith(s);
const lastDayOfMonth = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();

function nthWeekday(y: number, m: number, dow: number, n: number) {
  const first = new Date(Date.UTC(y, m - 1, 1)).getUTCDay();
  return ymd(y, m, 1 + ((dow - first + 7) % 7) + (n - 1) * 7);
}
function lastWeekday(y: number, m: number, dow: number) {
  const last = lastDayOfMonth(y, m);
  const w = new Date(Date.UTC(y, m - 1, last)).getUTCDay();
  return ymd(y, m, last - ((w - dow + 7) % 7));
}
/** Saturday holidays are observed the Friday before, Sunday holidays the Monday after (5 U.S.C. 6103). */
function observed(s: string) {
  const w = weekday(s);
  return w === 6 ? addDays(s, -1) : w === 0 ? addDays(s, 1) : s;
}

const holidayCache = new Map<number, Set<string>>();

/**
 * The eleven US federal holidays (5 U.S.C. 6103), as observed: New Year's Day, Martin Luther King
 * Jr. Day, Washington's Birthday, Memorial Day, Juneteenth, Independence Day, Labor Day, Columbus
 * Day, Veterans Day, Thanksgiving and Christmas. (Inauguration Day is a DC-area holiday only.)
 */
export function federalHolidays(y: number): Set<string> {
  const hit = holidayCache.get(y);
  if (hit) return hit;
  const fixed = [ymd(y, 1, 1), ymd(y, 6, 19), ymd(y, 7, 4), ymd(y, 11, 11), ymd(y, 12, 25)].map(observed);
  const floating = [nthWeekday(y, 1, 1, 3), nthWeekday(y, 2, 1, 3), lastWeekday(y, 5, 1), nthWeekday(y, 9, 1, 1), nthWeekday(y, 10, 1, 2), nthWeekday(y, 11, 4, 4)];
  // New Year's Day on a Saturday is observed on Friday, December 31 of the year before.
  const nextNewYear = observed(ymd(y + 1, 1, 1));
  const set = new Set([...fixed, ...floating, ...(nextNewYear.startsWith(`${y}-`) ? [nextNewYear] : [])]);
  holidayCache.set(y, set);
  return set;
}

export const isHoliday = (s: string) => federalHolidays(Number(s.slice(0, 4))).has(s);
export const isBusinessDay = (s: string) => weekday(s) !== 0 && weekday(s) !== 6 && !isHoliday(s);

/** The date itself if it's a business day, else the nearest business day BEFORE it. */
export function onOrBeforeBusinessDay(s: string) {
  let d = s;
  while (!isBusinessDay(d)) d = addDays(d, -1);
  return d;
}

/** The n-th business day before `s` (n = 0: `s` itself, moved earlier if it isn't a business day). */
export function businessDaysBefore(s: string, n: number) {
  let d = onOrBeforeBusinessDay(s);
  for (let i = 0; i < n; i++) d = onOrBeforeBusinessDay(addDays(d, -1));
  return d;
}

export type ScheduleRule = {
  frequency: Frequency;
  anchorPayDate: string;
  semiMonthlyDays?: number[];
  periodEndLagDays: number;
  hoursRequestLeadDays: number;
  hoursDueDays: number;
  approvalDueDays: number;
  adpCutoffDays: number;
};

export const DEFAULT_OFFSETS = { periodEndLagDays: 5, hoursRequestLeadDays: 5, hoursDueDays: 3, approvalDueDays: 2, adpCutoffDays: 2 } as const;

/** Problems with a schedule, in words staff can act on (empty = valid). */
export function scheduleProblems(r: Partial<ScheduleRule>): string[] {
  const out: string[] = [];
  if (!isFrequency(r.frequency)) out.push("Choose how often payroll runs.");
  if (!isYmd(r.anchorPayDate)) out.push("Enter a known pay date (YYYY-MM-DD).");
  if (r.frequency === "SEMIMONTHLY") {
    const d = r.semiMonthlyDays ?? [];
    if (d.length !== 2 || d.some((x) => !Number.isInteger(x) || x < 1 || x > LAST_DAY) || d[0] === d[1]) out.push("Choose the two pay days of the month (1–31; 31 means the last day).");
  }
  const n = (k: keyof typeof DEFAULT_OFFSETS, max: number) => {
    const v = r[k];
    if (!Number.isInteger(v) || (v as number) < 0 || (v as number) > max) out.push(`${OFFSET_LABELS[k]} must be a whole number from 0 to ${max}.`);
  };
  n("periodEndLagDays", 31);
  n("hoursRequestLeadDays", 20);
  n("hoursDueDays", 20);
  n("approvalDueDays", 20);
  n("adpCutoffDays", 20);
  if (!out.length) {
    const { hoursRequestLeadDays: a, hoursDueDays: b, approvalDueDays: c, adpCutoffDays: d } = r as ScheduleRule;
    if (!(a > b)) out.push("The hours request must go out before hours are due (more business days before the pay date).");
    if (!(b >= c)) out.push("Hours must be due on or before the approval deadline.");
    if (!(c >= d)) out.push("Client approval must be due on or before ADP's processing cutoff.");
  }
  return out;
}

export const OFFSET_LABELS = {
  periodEndLagDays: "Days between the end of the pay period and the pay date",
  hoursRequestLeadDays: "Hours request (business days before the pay date)",
  hoursDueDays: "Hours due (business days before the pay date)",
  approvalDueDays: "Client approval due (business days before the pay date)",
  adpCutoffDays: "ADP processing cutoff (business days before the pay date)",
} as const;

/** Scheduled (unadjusted) pay dates in [from, to], plus the one just before `from` (for the first period). */
export function nominalPayDates(r: Pick<ScheduleRule, "frequency" | "anchorPayDate" | "semiMonthlyDays">, from: string, to: string): string[] {
  const out: string[] = [];
  const anchor = r.anchorPayDate;
  if (r.frequency === "WEEKLY" || r.frequency === "BIWEEKLY") {
    const step = r.frequency === "WEEKLY" ? 7 : 14;
    // First date on or after (from − one step), aligned to the anchor.
    const start = addDays(from, -step);
    const k = Math.ceil(daysBetween(anchor, start) / step);
    for (let d = addDays(anchor, k * step); d <= to; d = addDays(d, step)) out.push(d);
    return out;
  }
  const days = r.frequency === "SEMIMONTHLY" ? [...(r.semiMonthlyDays ?? [])].sort((a, b) => a - b) : [Number(anchor.slice(8, 10)) === lastDayOfMonth(Number(anchor.slice(0, 4)), Number(anchor.slice(5, 7))) ? LAST_DAY : Number(anchor.slice(8, 10))];
  // Start two months early so the scheduled date just before `from` is included.
  let y = Number(from.slice(0, 4));
  let m = Number(from.slice(5, 7)) - 2;
  if (m < 1) { m += 12; y--; }
  while (ymd(y, m, 1) <= to) {
    for (const day of days) {
      const d = ymd(y, m, Math.min(day, lastDayOfMonth(y, m)));
      if (d <= to) out.push(d);
    }
    m++;
    if (m === 13) { m = 1; y++; }
  }
  const firstIn = out.findIndex((d) => d >= from);
  if (firstIn === -1) return [];
  return out.slice(Math.max(0, firstIn - 1));
}

export type CycleDates = {
  nominalPayDate: string;
  payDate: string;
  periodStart: string;
  periodEnd: string;
  hoursRequestDate: string;
  hoursDueDate: string;
  approvalDueDate: string;
  adpCutoffDate: string;
};

/** One cycle's dates from its scheduled pay date and the previous scheduled pay date. */
export function cycleDates(r: ScheduleRule, nominal: string, previousNominal: string): CycleDates {
  const payDate = onOrBeforeBusinessDay(nominal);
  const periodEnd = addDays(nominal, -r.periodEndLagDays);
  const periodStart = addDays(addDays(previousNominal, -r.periodEndLagDays), 1);
  return {
    nominalPayDate: nominal,
    payDate,
    periodStart,
    periodEnd,
    hoursRequestDate: businessDaysBefore(payDate, r.hoursRequestLeadDays),
    hoursDueDate: businessDaysBefore(payDate, r.hoursDueDays),
    approvalDueDate: businessDaysBefore(payDate, r.approvalDueDays),
    adpCutoffDate: businessDaysBefore(payDate, r.adpCutoffDays),
  };
}

/** Every cycle whose pay date falls in [today, today + horizonDays]. */
export function planCycles(r: ScheduleRule, today: string, horizonDays = 42): CycleDates[] {
  const to = addDays(today, horizonDays);
  const nominal = nominalPayDates(r, today, to);
  const out: CycleDates[] = [];
  for (let i = 1; i < nominal.length; i++) {
    const c = cycleDates(r, nominal[i], nominal[i - 1]);
    if (c.payDate >= today && c.payDate <= to) out.push(c);
  }
  // Two scheduled dates can't collapse onto one pay date in practice, but keep one per date.
  return out.filter((c, i) => out.findIndex((x) => x.payDate === c.payDate) === i);
}

/** "in 3 days", "today", "2 days overdue". */
export function countdown(days: number) {
  if (days === 0) return "today";
  if (days === 1) return "tomorrow";
  if (days > 1) return `in ${days} days`;
  return days === -1 ? "1 day overdue" : `${-days} days overdue`;
}
