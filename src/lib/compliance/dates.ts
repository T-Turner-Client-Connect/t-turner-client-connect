/**
 * Tax & Compliance Center — calendar math. Pure (no database). Dates are calendar dates
 * ("YYYY-MM-DD") so they never shift with time zones.
 *
 * Every due date is computed from the ACTUAL reporting period and the rule's due-date code —
 * never "the same day every month". Codes:
 *   DOM:<day>:<n>          day <day> of the n-th month after the period's last month (31 = last day)
 *   EOM:<n>                last day of the n-th month after the period's last month
 *   FIXED:<MM>-<DD>:<k>    a fixed date in (the period end's year + k)
 *   MANUAL                 no computed date (entered by staff, or a linked license's renewal date)
 * Weekend/holiday rules:
 *   NEXT_BUSINESS_DAY_FEDERAL  Saturday, Sunday or a District of Columbia legal holiday → next business day (IRS)
 *   NEXT_BUSINESS_DAY_ALABAMA  Saturday, Sunday or an Alabama state holiday (Code of Ala. §1-3-8) → next business day
 *   NO_ADJUSTMENT              the date stands as computed
 */
import { addDays, dcHolidays, iso, nextBusinessDay } from "@/lib/tax/deadlines";

export const FREQUENCIES = { MONTHLY: "Monthly", QUARTERLY: "Quarterly", SEMIANNUAL: "Semiannual", ANNUAL: "Annual", ONE_TIME: "One-time" } as const;
export type Frequency = keyof typeof FREQUENCIES;
export const isFrequency = (v: string): v is Frequency => v in FREQUENCIES;

export const WEEKEND_RULES = {
  NEXT_BUSINESS_DAY_FEDERAL: "Weekend or federal (DC) legal holiday → next business day",
  NEXT_BUSINESS_DAY_ALABAMA: "Weekend or Alabama state holiday → next business day",
  NO_ADJUSTMENT: "No weekend/holiday adjustment",
} as const;
export type WeekendRule = keyof typeof WEEKEND_RULES;

const toDate = (s: string) => new Date(`${s}T00:00:00Z`);
const weekday = (s: string) => toDate(s).getUTCDay();
export const lastDayOfMonth = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();

function nthWeekday(y: number, m: number, dow: number, n: number) {
  const first = new Date(Date.UTC(y, m - 1, 1)).getUTCDay();
  return iso(y, m, 1 + ((dow - first + 7) % 7) + (n - 1) * 7);
}
function lastWeekday(y: number, m: number, dow: number) {
  const ld = lastDayOfMonth(y, m);
  const last = new Date(Date.UTC(y, m - 1, ld)).getUTCDay();
  return iso(y, m, ld - ((last - dow + 7) % 7));
}
const observed = (s: string) => (weekday(s) === 6 ? addDays(s, -1) : weekday(s) === 0 ? addDays(s, 1) : s);

/**
 * Alabama state holidays (Code of Alabama §1-3-8) as observed by state offices. Candidate list —
 * rules using it are NEEDS_VERIFICATION until the owner confirms against the official calendar.
 */
export function alabamaHolidays(y: number): Set<string> {
  return new Set([
    observed(iso(y, 1, 1)),
    nthWeekday(y, 1, 1, 3), // Robert E. Lee / Martin Luther King Jr.
    nthWeekday(y, 2, 1, 3), // George Washington / Thomas Jefferson
    nthWeekday(y, 4, 1, 4), // Confederate Memorial Day
    lastWeekday(y, 5, 1), // National Memorial Day
    nthWeekday(y, 6, 1, 1), // Jefferson Davis's birthday
    observed(iso(y, 7, 4)),
    nthWeekday(y, 9, 1, 1), // Labor Day
    nthWeekday(y, 10, 1, 2), // Columbus Day / American Indian Heritage Day
    observed(iso(y, 11, 11)),
    nthWeekday(y, 11, 4, 4), // Thanksgiving
    observed(iso(y, 12, 25)),
  ]);
}

export function nextAlabamaBusinessDay(s: string) {
  let d = s;
  for (let i = 0; i < 10; i++) {
    const w = weekday(d);
    if (w !== 0 && w !== 6 && !alabamaHolidays(Number(d.slice(0, 4))).has(d)) return d;
    d = addDays(d, 1);
  }
  return d;
}

export function adjustDue(date: string, rule: string): string {
  if (rule === "NEXT_BUSINESS_DAY_FEDERAL") return nextBusinessDay(date);
  if (rule === "NEXT_BUSINESS_DAY_ALABAMA") return nextAlabamaBusinessDay(date);
  return date;
}
export { dcHolidays };

// --- Periods ------------------------------------------------------------------------------------

export type Period = { key: string; start: string; end: string };

const monthIdx = (y: number, m: number) => y * 12 + (m - 1);
const fromIdx = (i: number) => ({ y: Math.floor(i / 12), m: (i % 12) + 1 });
const endOf = (y: number, m: number) => iso(y, m, lastDayOfMonth(y, m));
const pad = (n: number) => String(n).padStart(2, "0");

/** The reporting period containing `date`. Annual periods follow the fiscal year end month (default December). */
export function periodContaining(freq: Frequency, date: string, fyeMonth = 12): Period {
  const y = Number(date.slice(0, 4));
  const m = Number(date.slice(5, 7));
  if (freq === "MONTHLY") return { key: `${y}-${pad(m)}`, start: iso(y, m, 1), end: endOf(y, m) };
  if (freq === "QUARTERLY") {
    const q = Math.ceil(m / 3);
    return { key: `${y}-Q${q}`, start: iso(y, q * 3 - 2, 1), end: endOf(y, q * 3) };
  }
  if (freq === "SEMIANNUAL") {
    const h = m <= 6 ? 1 : 2;
    return { key: `${y}-H${h}`, start: iso(y, h === 1 ? 1 : 7, 1), end: endOf(y, h === 1 ? 6 : 12) };
  }
  if (freq === "ONE_TIME") return { key: "ONCE", start: date, end: date };
  // ANNUAL: the year ending in fyeMonth on or after `date`.
  const endYear = m <= fyeMonth ? y : y + 1;
  const s = fromIdx(monthIdx(endYear, fyeMonth) - 11);
  return { key: fyeMonth === 12 ? `TY${endYear}` : `FY${endYear}-${pad(fyeMonth)}`, start: iso(s.y, s.m, 1), end: endOf(endYear, fyeMonth) };
}

export function nextPeriod(freq: Frequency, p: Period, fyeMonth = 12): Period | null {
  if (freq === "ONE_TIME") return null;
  return periodContaining(freq, addDays(p.end, 1), fyeMonth);
}

/** The statutory due date (before weekend/holiday adjustment) for a period under a due code, or null for MANUAL. */
export function statutoryDue(code: string, p: Period): string | null {
  const ey = Number(p.end.slice(0, 4));
  const em = Number(p.end.slice(5, 7));
  const parts = code.split(":");
  if (parts[0] === "DOM" || parts[0] === "EOM") {
    const day = parts[0] === "EOM" ? 31 : Number(parts[1]);
    const n = Number(parts[0] === "EOM" ? parts[1] : parts[2]);
    if (!Number.isInteger(day) || !Number.isInteger(n)) throw new Error(`Bad due code ${code}`);
    const t = fromIdx(monthIdx(ey, em) + n);
    return iso(t.y, t.m, Math.min(day, lastDayOfMonth(t.y, t.m)));
  }
  if (parts[0] === "FIXED") {
    const [mm, dd] = parts[1].split("-").map(Number);
    const k = Number(parts[2] ?? 0);
    const y = ey + k;
    return iso(y, mm, Math.min(dd, lastDayOfMonth(y, mm)));
  }
  if (parts[0] === "MANUAL") return null;
  throw new Error(`Unknown due code ${code}`);
}

export function describeDueCode(code: string): string {
  const parts = code.split(":");
  const ord = (n: number) => (n === 1 ? "1st" : n === 2 ? "2nd" : n === 3 ? "3rd" : `${n}th`);
  if (parts[0] === "EOM") return `Last day of the ${ord(Number(parts[1]))} month after the period ends`;
  if (parts[0] === "DOM") return Number(parts[1]) >= 31 ? `Last day of the ${ord(Number(parts[2]))} month after the period ends` : `${ord(Number(parts[1]))} day of the ${ord(Number(parts[2]))} month after the period ends`;
  if (parts[0] === "FIXED") return `${parts[1]} of ${Number(parts[2] ?? 0) === 0 ? "the period's year" : `the year after the period ends`}`;
  return "Entered by staff (no computed date)";
}

export type DueDates = { statutory: string | null; adjusted: string | null; prep: string | null };

export function dueDatesFor(code: string, weekendRule: string, p: Period, prepLeadDays = 10): DueDates {
  const statutory = statutoryDue(code, p);
  if (!statutory) return { statutory: null, adjusted: null, prep: null };
  const adjusted = adjustDue(statutory, weekendRule);
  return { statutory, adjusted, prep: addDays(adjusted, -prepLeadDays) };
}

/** Adds whole months to a date (end-of-month safe), for extensions. */
export function addMonths(date: string, n: number) {
  const y = Number(date.slice(0, 4));
  const m = Number(date.slice(5, 7));
  const d = Number(date.slice(8, 10));
  const t = fromIdx(monthIdx(y, m) + n);
  return iso(t.y, t.m, Math.min(d, lastDayOfMonth(t.y, t.m)));
}

/**
 * The periods an obligation should have on `today`: starting with the first period whose
 * adjusted due date is on or after `startDate` (no invented history), every period due within
 * `horizonDays`, and always at least the next one due.
 */
export function periodsToCreate(input: { frequency: Frequency; code: string; weekendRule: string; fyeMonth?: number; startDate: string; today: string; horizonDays?: number; prepLeadDays?: number }): (Period & DueDates)[] {
  const { frequency, code, weekendRule, startDate, today } = input;
  const fye = input.fyeMonth ?? 12;
  const horizon = addDays(today, input.horizonDays ?? 45);
  if (code === "MANUAL" || frequency === "ONE_TIME") {
    const p = periodContaining(frequency === "ONE_TIME" ? "ONE_TIME" : frequency, startDate, fye);
    return [{ ...p, ...dueDatesFor(code, weekendRule, p, input.prepLeadDays) }];
  }
  // Walk back far enough to find the first period due on/after startDate.
  let p: Period | null = periodContaining(frequency, addDays(startDate, -800), fye);
  const out: (Period & DueDates)[] = [];
  for (let i = 0; p && i < 400; i++) {
    const dd = dueDatesFor(code, weekendRule, p, input.prepLeadDays);
    if (dd.adjusted && dd.adjusted >= startDate) {
      if (dd.adjusted <= horizon || out.length === 0 || !out.some((o) => o.adjusted! >= today)) out.push({ ...p, ...dd });
      else break;
    }
    p = nextPeriod(frequency, p, fye);
  }
  return out;
}
