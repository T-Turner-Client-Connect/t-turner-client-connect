// Open start times for one office day. Pure: every input is passed in, so the
// same rules run in tests, on the booking page and inside the booking
// transaction (which re-checks with fresh data before saving).
import { chicagoLocalToUtc } from "@/lib/tz";

export type MonthConfig = { year: number; month: number; weekdays: number[]; openTime: string; closeTime: string; maxPerDay: number; publishedAt: Date | null };
export type DateRule = { date: string; kind: string; startTime: string | null; endTime: string | null; staffId: string | null; maxPerDay: number | null };
export type StaffHours = { userId: string; weekdays: number[]; startTime: string | null; endTime: string | null };
/** A time someone is already holding. staffId null = blocks every staff member. */
export type Busy = { start: Date; end: Date; staffId: string | null; appointmentId: string };

export type DayInput = {
  date: string; // YYYY-MM-DD (Central)
  minutes: number;
  month: MonthConfig | null;
  rules: DateRule[];
  staff: StaffHours[];
  busy: Busy[];
  // Appointments already holding this day (for the daily limit).
  dayCount: number;
  stepMin: number;
  earliest: Date; // now + minimum notice
  ignoreAppointmentId?: string; // when moving an appointment, its own time doesn't conflict
};

export type Slot = { time: string; start: Date; end: Date; staffId: string };

const toMin = (hhmm: string) => {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
};
export const minToHHMM = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;

/** ISO weekday (1 = Monday … 7 = Sunday) of a calendar date. */
export function isoWeekday(date: string) {
  const [y, m, d] = date.split("-").map(Number);
  const w = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return w === 0 ? 7 : w;
}

export function daysInMonth(year: number, month: number) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

export function monthDates(year: number, month: number) {
  return Array.from({ length: daysInMonth(year, month) }, (_, i) => `${year}-${String(month).padStart(2, "0")}-${String(i + 1).padStart(2, "0")}`);
}

export const atOffice = (date: string, hhmm: string) => chicagoLocalToUtc(`${date}T${hhmm}`)!;

type Range = [number, number];

function subtract(ranges: Range[], cut: Range): Range[] {
  const out: Range[] = [];
  for (const [a, b] of ranges) {
    if (cut[1] <= a || cut[0] >= b) out.push([a, b]);
    else {
      if (cut[0] > a) out.push([a, cut[0]]);
      if (cut[1] < b) out.push([cut[1], b]);
    }
  }
  return out;
}

const ruleRange = (r: DateRule, fallback: Range): Range => (r.startTime && r.endTime ? [toMin(r.startTime), toMin(r.endTime)] : fallback);

/** The office's bookable windows that day (minutes from midnight), before staff and bookings. */
export function officeWindows(date: string, month: MonthConfig | null, rules: DateRule[]): { windows: Range[]; maxPerDay: number } {
  if (!month || !month.publishedAt) return { windows: [], maxPerDay: 0 };
  const hours: Range = [toMin(month.openTime), toMin(month.closeTime)];
  const dayRules = rules.filter((r) => r.date === date && !r.staffId);
  const special = dayRules.filter((r) => r.kind === "SPECIAL");
  let windows: Range[] = special.length ? special.map((r) => ruleRange(r, hours)) : month.weekdays.includes(isoWeekday(date)) ? [hours] : [];
  for (const b of dayRules.filter((r) => r.kind === "BLOCK")) windows = subtract(windows, ruleRange(b, [0, 24 * 60]));
  const limit = special.find((r) => r.maxPerDay != null)?.maxPerDay ?? month.maxPerDay;
  return { windows: windows.filter(([a, b]) => b > a), maxPerDay: limit };
}

/** Open start times for an appointment of `minutes` on `date`. */
export function daySlots(input: DayInput): Slot[] {
  const { date, minutes, month, rules, staff } = input;
  if (minutes <= 0) return [];
  const { windows, maxPerDay } = officeWindows(date, month, rules);
  if (!windows.length || input.dayCount >= maxPerDay) return [];
  const weekday = isoWeekday(date);
  const office: Range = [toMin(month!.openTime), toMin(month!.closeTime)];
  const staffWindows = staff
    .filter((s) => s.weekdays.includes(weekday) || rules.some((r) => r.date === date && r.kind === "SPECIAL" && !r.staffId))
    .map((s) => {
      let w: Range[] = [s.startTime && s.endTime ? [toMin(s.startTime), toMin(s.endTime)] : office];
      // Special availability for the whole office opens that day for every staff member.
      if (rules.some((r) => r.date === date && r.kind === "SPECIAL" && !r.staffId)) w = windows;
      for (const b of rules.filter((r) => r.date === date && r.kind === "BLOCK" && r.staffId === s.userId)) w = subtract(w, ruleRange(b, [0, 24 * 60]));
      for (const sp of rules.filter((r) => r.date === date && r.kind === "SPECIAL" && r.staffId === s.userId)) w.push(ruleRange(sp, office));
      return { userId: s.userId, w };
    });
  const busy = input.busy.filter((b) => b.appointmentId !== input.ignoreAppointmentId);
  const out: Slot[] = [];
  for (const [a, b] of windows) {
    for (let t = a; t + minutes <= b; t += input.stepMin) {
      const start = atOffice(date, minToHHMM(t));
      const end = new Date(start.getTime() + minutes * 60_000);
      if (start < input.earliest) continue;
      const who = staffWindows.find(
        (s) => s.w.some(([x, y]) => t >= x && t + minutes <= y) && !busy.some((bz) => (bz.staffId === null || bz.staffId === s.userId) && bz.start < end && bz.end > start),
      );
      if (who) out.push({ time: minToHHMM(t), start, end, staffId: who.userId });
    }
  }
  return out;
}

/** "Tue, Nov 17, 2026" for a calendar date. */
export function dateLabel(date: string, opts: Intl.DateTimeFormatOptions = { weekday: "short", month: "short", day: "numeric", year: "numeric" }) {
  const [y, m, d] = date.split("-").map(Number);
  return new Intl.DateTimeFormat("en-US", { ...opts, timeZone: "UTC" }).format(new Date(Date.UTC(y, m - 1, d)));
}

/** "10:30 AM" for an "HH:MM" office time. */
export function timeLabel(hhmm: string) {
  const [h, m] = hhmm.split(":").map(Number);
  return `${((h + 11) % 12) + 1}:${String(m).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
}

/** 15-minute blocks an appointment occupies (the double-booking guard). */
export function blocksFor(start: Date, end: Date): Date[] {
  const out: Date[] = [];
  const step = 15 * 60_000;
  const first = Math.floor(start.getTime() / step) * step;
  for (let t = first; t < end.getTime(); t += step) out.push(new Date(t));
  return out;
}
