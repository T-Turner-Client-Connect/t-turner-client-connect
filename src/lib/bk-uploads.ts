// Bookkeeping uploads: what a file is, the period it covers, and its "as of"
// date — kept separate from when and by whom it was uploaded. Pure helpers,
// shared by the staff and client upload forms and the file lists.

export const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** "What are you uploading?" — in the order the office asked for. */
export const BK_UPLOAD_TYPES = {
  PNL: "P&L (profit & loss)",
  BALANCE_SHEET: "Balance Sheet",
  FINANCIAL_PACKET: "Full financial packet",
  BANK_STATEMENT: "Bank statement",
  CARD_STATEMENT: "Credit-card statement",
  PAYROLL_REPORT: "Payroll report",
  RECEIPTS: "Receipts",
  SUPPORTING_SCHEDULE: "Supporting schedule",
  BK_OTHER: "Other",
} as const;
export type BkUploadType = keyof typeof BK_UPLOAD_TYPES;
export const isBkUploadType = (t: string): t is BkUploadType => t in BK_UPLOAD_TYPES;

/** Types with an "as of" date (figures at a point in time). Required for a Balance Sheet. */
export const AS_OF_TYPES: BkUploadType[] = ["BALANCE_SHEET", "FINANCIAL_PACKET", "BANK_STATEMENT", "CARD_STATEMENT"];
export const AS_OF_REQUIRED: BkUploadType[] = ["BALANCE_SHEET"];

export type PeriodInput = { kind: string; year?: string; month?: string; quarter?: string; start?: string; end?: string };
export type Coverage = { kind: "MONTH" | "QUARTER" | "RANGE"; year: number; month: number | null; start: Date; end: Date };

const ymd = (s?: string) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s ?? "");
  if (!m) return null;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12));
  return d.getUTCMonth() === Number(m[2]) - 1 ? d : null;
};
const lastDay = (y: number, m: number) => new Date(Date.UTC(y, m, 0, 12));

export class PeriodError extends Error {}

/** The reporting period a person chose: a month, a quarter or a date range. Required — never guessed. */
export function parseCoverage(p: PeriodInput, now = new Date()): Coverage {
  const thisYear = now.getUTCFullYear();
  if (p.kind === "RANGE") {
    const start = ymd(p.start), end = ymd(p.end);
    if (!start || !end) throw new PeriodError("Enter the first and last day the document covers.");
    if (end < start) throw new PeriodError("The end date is before the start date.");
    if (start.getUTCFullYear() < thisYear - 15 || end.getUTCFullYear() > thisYear + 1) throw new PeriodError("Check the dates the document covers.");
    const sameMonth = start.getUTCFullYear() === end.getUTCFullYear() && start.getUTCMonth() === end.getUTCMonth();
    return { kind: "RANGE", year: end.getUTCFullYear(), month: sameMonth ? end.getUTCMonth() + 1 : null, start, end };
  }
  const year = Number(p.year);
  if (!Number.isInteger(year) || year < thisYear - 15 || year > thisYear + 1) throw new PeriodError("Choose the reporting year.");
  if (p.kind === "QUARTER") {
    const q = Number(p.quarter);
    if (![1, 2, 3, 4].includes(q)) throw new PeriodError("Choose the quarter.");
    return { kind: "QUARTER", year, month: null, start: new Date(Date.UTC(year, (q - 1) * 3, 1, 12)), end: lastDay(year, q * 3) };
  }
  if (p.kind === "MONTH") {
    const month = Number(p.month);
    if (!Number.isInteger(month) || month < 1 || month > 12) throw new PeriodError("Choose the reporting month.");
    return { kind: "MONTH", year, month, start: new Date(Date.UTC(year, month - 1, 1, 12)), end: lastDay(year, month) };
  }
  throw new PeriodError("Choose the reporting period: a month, a quarter or a date range.");
}

export function parseAsOf(type: string, value?: string) {
  if (!value) {
    if (AS_OF_REQUIRED.includes(type as BkUploadType)) throw new PeriodError("Enter the Balance Sheet's “as of” date.");
    return null;
  }
  const d = ymd(value);
  if (!d) throw new PeriodError("Enter a valid “as of” date.");
  return d;
}

const fmt = (d: Date) => d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });

/** "January 2026", "Q1 2026", "Jan 5, 2026 – Feb 4, 2026", or null when the file has no recorded period. */
export function periodText(d: { year: number | null; month: number | null; reportPeriodType?: string | null; periodStart?: Date | null; periodEnd?: Date | null }) {
  if (d.periodStart && d.periodEnd) {
    if (d.reportPeriodType === "QUARTER") return `Q${Math.floor(d.periodStart.getUTCMonth() / 3) + 1} ${d.periodStart.getUTCFullYear()}`;
    if (d.reportPeriodType === "MONTH" || (d.reportPeriodType == null && d.month && d.year)) return `${MONTH_NAMES[d.periodStart.getUTCMonth()]} ${d.periodStart.getUTCFullYear()}`;
    return `${fmt(d.periodStart)} – ${fmt(d.periodEnd)}`;
  }
  if (d.year && d.month) return `${MONTH_NAMES[d.month - 1]} ${d.year}`;
  return null;
}

/** What still needs a person to fill in. Older files are flagged, never assigned a guessed period. */
export function missingInfo(d: { docType: string | null; reportType?: string | null; year: number | null; month: number | null; periodStart?: Date | null; periodEnd?: Date | null; reportPeriodType?: string | null; reportAsOf?: Date | null }) {
  const out: string[] = [];
  if (!d.docType && !d.reportType) out.push("Category not recorded");
  if (!periodText(d)) out.push("Reporting period not recorded");
  if ((d.docType === "BALANCE_SHEET" || d.reportType === "BALANCE_SHEET") && !d.reportAsOf) out.push("“As of” date missing");
  return out;
}

export const asOfText = (d: { reportAsOf?: Date | null }) => (d.reportAsOf ? fmt(d.reportAsOf) : null);

/** Reads the shared upload fields from a form. Throws PeriodError with a plain message when something is missing. */
export function uploadFieldsFromForm(fd: FormData, typeName = "docType") {
  const get = (k: string) => String(fd.get(k) ?? "").trim();
  const type = get(typeName);
  if (!isBkUploadType(type)) throw new PeriodError("Choose what you're uploading.");
  const coverage = parseCoverage({ kind: get("periodKind"), year: get("periodYear"), month: get("periodMonth"), quarter: get("periodQuarter"), start: get("periodStart"), end: get("periodEnd") });
  return { type, coverage, asOf: parseAsOf(type, get("asOf")) };
}
