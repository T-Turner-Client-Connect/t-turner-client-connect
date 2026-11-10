// Which months the bookkeeping pages list. Display only: nothing here reads or writes records.
import { calendarDay, chicagoToday } from "@/lib/dates";

export type Ym = { year: number; month: number };

const ymNum = (x: Ym) => x.year * 12 + (x.month - 1);

/** The month of a date-only value (a statement's period end, "YYYY-MM-DD" text, or a Date stored at UTC midnight or noon). Read as the calendar day it holds, never shifted into another zone. */
export function statementMonth(d: Date | string): Ym {
  const day = calendarDay(d);
  return { year: Number(day.slice(0, 4)), month: Number(day.slice(5, 7)) };
}

/** The office's (America/Chicago) month at a real instant, such as an upload timestamp or "now". */
export function chicagoMonth(now = new Date()): Ym {
  const day = chicagoToday(now);
  return { year: Number(day.slice(0, 4)), month: Number(day.slice(5, 7)) };
}

/** January through December of one year, in order. */
export const yearMonths = (year: number): Ym[] => Array.from({ length: 12 }, (_, i) => ({ year, month: i + 1 }));

/**
 * The months the statements page lists for one year, newest first and with no gaps: from January
 * (or the books' first month, when that is later in the year) through the current month (December
 * for past years). A month that already has a record is always listed, even outside that range.
 */
export function statementTabMonths(year: number, opts: { first?: Ym | null; records?: Ym[]; now?: Date } = {}): Ym[] {
  const cur = chicagoMonth(opts.now);
  let start = opts.first && opts.first.year === year ? opts.first.month : opts.first && opts.first.year > year ? 13 : 1;
  let end = year < cur.year ? 12 : year === cur.year ? cur.month : 0;
  for (const r of opts.records ?? []) {
    if (r.year !== year) continue;
    start = Math.min(start, r.month);
    end = Math.max(end, r.month);
  }
  const out: Ym[] = [];
  for (let m = end; m >= start; m--) out.push({ year, month: m });
  return out;
}

/** The earlier of two months (either may be missing). */
export const earlierMonth = (a: Ym | null | undefined, b: Ym | null | undefined) => (!a ? b ?? null : !b ? a : ymNum(a) <= ymNum(b) ? a : b);
