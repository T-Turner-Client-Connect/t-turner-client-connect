import { ValidationError } from "@/lib/services/clients";

// Reporting periods and accounting basis for bookkeeping reports (shared by
// staff pages, the client portal and the packet PDF).

const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

export const BASIS = { CASH: "Cash Basis", ACCRUAL: "Accrual Basis", MODIFIED_CASH: "Modified Cash Basis" } as const;
export const PERIOD_TYPES = { MONTH: "Month", QUARTER: "Quarter", YEAR_TO_DATE: "Year to date" } as const;
export type PeriodType = keyof typeof PERIOD_TYPES;

// --- Reporting periods -------------------------------------------------------------

const NUM_WORDS = ["", "Month", "Two Months", "Three Months", "Four Months", "Five Months", "Six Months", "Seven Months", "Eight Months", "Nine Months", "Ten Months", "Eleven Months", "Twelve Months"];
export const longDate = (d: Date) => `${MONTH_NAMES[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`;

/**
 * Dates and wording for a report. Month = that month; Quarter = the three
 * months ending in it (month must be 3, 6, 9 or 12); Year to date = from the
 * start of the client's fiscal year through that month.
 */
export function reportPeriod(year: number, month: number, type: PeriodType = "MONTH", fiscalYearEnd?: number | null) {
  const end = new Date(year, month, 0);
  let start: Date;
  if (type === "QUARTER") {
    if (month % 3 !== 0) throw new ValidationError("A quarter ends in March, June, September or December.");
    start = new Date(year, month - 3, 1);
  } else if (type === "YEAR_TO_DATE") {
    const startMonth = ((fiscalYearEnd ?? 12) % 12) + 1;
    start = new Date(month >= startMonth ? year : year - 1, startMonth - 1, 1);
  } else {
    start = new Date(year, month - 1, 1);
  }
  const months = (end.getFullYear() - start.getFullYear()) * 12 + end.getMonth() - start.getMonth() + 1;
  const range = `${longDate(start)} – ${longDate(end)}`;
  const span = type === "QUARTER" ? `Quarter (Q${month / 3})` : NUM_WORDS[months] ?? `${months} Months`;
  return {
    start,
    end,
    months,
    range,
    // "For the Nine Months January 1, 2026 – September 30, 2026"
    cover: months === 1 ? `For the Month Ended ${longDate(end)}` : type === "QUARTER" ? `For the Quarter Ended ${longDate(end)}` : `For the ${span} ${range}`,
    // "Nine Months Ended September 30, 2026"
    ended: months === 1 ? `Month Ended ${longDate(end)}` : type === "QUARTER" ? `Quarter Ended ${longDate(end)}` : `${span} Ended ${longDate(end)}`,
    asOf: `As of ${longDate(end)}`,
    short: type === "QUARTER" ? `Q${month / 3} ${year}` : type === "YEAR_TO_DATE" && months > 1 ? `${MONTH_NAMES[start.getMonth()].slice(0, 3)}–${MONTH_NAMES[end.getMonth()].slice(0, 3)} ${year}` : `${MONTH_NAMES[month - 1]} ${year}`,
  };
}

