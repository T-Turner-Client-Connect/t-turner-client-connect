/**
 * Owner's Office → ADP Revenue Share: labels, money parsing, the statement total check, the CSV
 * column mapping and the report math. Pure functions only (no database), so the CSV preview in
 * the browser and the server that saves the lines use exactly the same rules.
 */

export const REFERRAL_STATUSES = ["REFERRED", "SOLD", "ACTIVE", "CANCELLED", "DECLINED"] as const;
export type ReferralStatus = (typeof REFERRAL_STATUSES)[number];
export const REFERRAL_STATUS_LABELS: Record<ReferralStatus, string> = {
  REFERRED: "Referred",
  SOLD: "Sold",
  ACTIVE: "Active",
  CANCELLED: "Cancelled",
  DECLINED: "Declined",
};

export const ADP_PRODUCTS = ["RUN", "WFN", "OTHER"] as const;
export type AdpProduct = (typeof ADP_PRODUCTS)[number];
export const ADP_PRODUCT_LABELS: Record<AdpProduct, string> = { RUN: "RUN Powered by ADP", WFN: "ADP Workforce Now", OTHER: "Other" };
export const productLabel = (product: string, other?: string | null) =>
  product === "OTHER" ? (other?.trim() ? other.trim() : "Other ADP product") : (ADP_PRODUCT_LABELS[product as AdpProduct] ?? product);

export const LINE_TYPES = ["COMMISSION", "RESIDUAL", "BONUS", "ADJUSTMENT"] as const;
export type LineType = (typeof LINE_TYPES)[number];
export const LINE_TYPE_LABELS: Record<LineType, string> = { COMMISSION: "Commission", RESIDUAL: "Residual", BONUS: "Bonus", ADJUSTMENT: "Adjustment" };

export const PAYMENT_METHODS = ["ACH", "CHECK", "OTHER"] as const;
export type AdpPaymentMethod = (typeof PAYMENT_METHODS)[number];
export const PAYMENT_METHOD_LABELS: Record<AdpPaymentMethod, string> = { ACH: "ACH deposit", CHECK: "Check", OTHER: "Other" };

export const STATEMENT_FILE_TYPES = "PDF, CSV or Excel (.xlsx)";

/** ADP pays about this many days after each ADP fiscal quarter ends. */
export const ADP_PAYMENT_LAG_DAYS = 45;

export const DEFAULT_FISCAL_NOTE =
  "ADP's fiscal year is not the calendar year: it runs July 1 – June 30 (fiscal Q1 = Jul–Sep, Q2 = Oct–Dec, Q3 = Jan–Mar, Q4 = Apr–Jun). " +
  "ADP pays Revenue Share about 45 days after each fiscal quarter ends, so a quarter's earnings usually arrive in the following calendar month or two. " +
  "Monthly and annual views here use calendar months; check the period on each ADP statement against your ADP agreement.";

// --- Money --------------------------------------------------------------------------------------

export class AdpInputError extends Error {}

/**
 * "1,234.56", "$80", "-12.50" or "(12.50)" (accounting negative) → cents. Returns null when the
 * text isn't an amount. Negative amounts are allowed only where `allowNegative` is set.
 */
export function parseCents(raw: string, opts: { allowNegative?: boolean } = {}): number | null {
  let v = raw.trim().replace(/[$,\s]/g, "").replace(/USD$/i, "");
  let negative = false;
  if (/^\(.*\)$/.test(v)) {
    negative = true;
    v = v.slice(1, -1);
  }
  if (v.startsWith("-")) {
    negative = !negative;
    v = v.slice(1);
  } else if (v.endsWith("-")) {
    negative = !negative;
    v = v.slice(0, -1);
  }
  if (!/^\d+(\.\d{1,2})?$/.test(v) && !/^\.\d{1,2}$/.test(v)) return null;
  const cents = Math.round(Number(v) * 100);
  if (!Number.isSafeInteger(cents) || cents > 100_000_000_00) return null;
  if (negative && !opts.allowNegative) return null;
  return negative ? -cents : cents;
}

export const fmtCents = (cents: number) => {
  const sign = cents < 0 ? "-" : "";
  return `${sign}$${(Math.abs(cents) / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
};

// --- Statement total check ----------------------------------------------------------------------

export type TotalCheck = { reportedCents: number; linesCents: number; differenceCents: number; matches: boolean };

/** The statement total must equal the sum of its (non-removed) lines; otherwise it shows a warning. */
export function statementTotalCheck(reportedCents: number, lines: { amountCents: number; archivedAt?: Date | string | null }[]): TotalCheck {
  const linesCents = lines.filter((l) => !l.archivedAt).reduce((s, l) => s + l.amountCents, 0);
  return { reportedCents, linesCents, differenceCents: reportedCents - linesCents, matches: reportedCents === linesCents };
}

export function totalWarning(c: TotalCheck): string | null {
  if (c.matches) return null;
  const which = c.differenceCents > 0 ? "more than" : "less than";
  return `The statement total (${fmtCents(c.reportedCents)}) is ${fmtCents(Math.abs(c.differenceCents))} ${which} the sum of its lines (${fmtCents(c.linesCents)}). Check the lines against ADP's statement.`;
}

// --- Dates & ADP fiscal quarters ----------------------------------------------------------------

export const isYmd = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(new Date(`${s}T00:00:00Z`).getTime()) && new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s;
export const ymdOf = (d: Date) => d.toISOString().slice(0, 10);
/** A date-only value ("Nov 5, 2026"), read in UTC so it never shifts a day. */
export const fmtDay = (d: Date | string | null | undefined) =>
  d ? new Date(typeof d === "string" ? `${d}T00:00:00Z` : d).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" }) : "—";

export const statusTone = (s: string) => (({ REFERRED: "navy", SOLD: "gold", ACTIVE: "green", CANCELLED: "gray", DECLINED: "red" }) as const)[s as ReferralStatus] ?? ("gray" as const);

const addDays = (s: string, days: number) => ymdOf(new Date(new Date(`${s}T00:00:00Z`).getTime() + days * 86_400_000));

/**
 * ADP's fiscal quarter for a date (fiscal year July 1 – June 30, named by the year it ends:
 * FY2027 = Jul 1, 2026 – Jun 30, 2027), and when its payment is expected (~45 days after it ends).
 */
export function adpFiscalQuarter(ymd: string) {
  const y = Number(ymd.slice(0, 4));
  const m = Number(ymd.slice(5, 7));
  const fy = m >= 7 ? y + 1 : y;
  const q = m >= 7 ? (m <= 9 ? 1 : 2) : m <= 3 ? 3 : 4;
  const startMonth = [7, 10, 1, 4][q - 1];
  const startYear = q <= 2 ? fy - 1 : fy;
  const start = `${startYear}-${String(startMonth).padStart(2, "0")}-01`;
  const endMonthDate = new Date(Date.UTC(startYear, startMonth - 1 + 3, 0));
  const end = ymdOf(endMonthDate);
  return { fy, q, label: `ADP FY${fy} Q${q}`, start, end, expectedPaymentBy: addDays(end, ADP_PAYMENT_LAG_DAYS) };
}

// --- CSV import mapping -------------------------------------------------------------------------

/** Which column holds what. ADP publishes no fixed layout, so the owner picks every column. */
export type CsvMapping = {
  headerRow: boolean;
  amount: number;
  /** A column with the line type, or null to use `fixedType` for every row. */
  type: number | null;
  fixedType: LineType | null;
  name: number | null;
  note: number | null;
};

export type CsvPreviewRow = {
  /** Row number in the file (1-based, as a spreadsheet shows it). */
  rowNumber: number;
  include: boolean;
  name: string;
  type: LineType | null;
  amountCents: number | null;
  note: string;
  error: string | null;
};

const TYPE_WORDS: [RegExp, LineType][] = [
  [/commission/i, "COMMISSION"],
  [/residual/i, "RESIDUAL"],
  [/bonus|incentive|spiff/i, "BONUS"],
  [/adjust|chargeback|clawback|reversal|credit/i, "ADJUSTMENT"],
];

/** "Residual", "COMMISSION", "Bonus payment" → the line type (exact words only, never a guess at a referral). */
export function parseLineType(raw: string): LineType | null {
  const v = raw.trim();
  if (!v) return null;
  const exact = LINE_TYPES.find((t) => t === v.toUpperCase());
  if (exact) return exact;
  const hits = TYPE_WORDS.filter(([re]) => re.test(v)).map(([, t]) => t);
  return hits.length === 1 ? hits[0] : null;
}

export function csvHeaders(grid: string[][], headerRow: boolean): string[] {
  const width = Math.max(0, ...grid.slice(0, 50).map((r) => r.length));
  return Array.from({ length: width }, (_, i) => (headerRow ? grid[0]?.[i]?.trim() : "") || `Column ${i + 1}`);
}

/**
 * Applies the owner's mapping to every row: what each line would be, and why a row can't be
 * imported. Rows the owner unticks (`excluded`, by row number) and blank rows are left out.
 */
export function mapCsvRows(grid: string[][], m: CsvMapping, excluded: Iterable<number> = []): CsvPreviewRow[] {
  const skip = new Set(excluded);
  const width = Math.max(0, ...grid.map((r) => r.length));
  const valid = (c: number | null) => c === null || (Number.isInteger(c) && c >= 0 && c < width);
  if (!Number.isInteger(m.amount) || m.amount < 0 || m.amount >= width) throw new AdpInputError("Choose the column that holds the amount.");
  if (!valid(m.type) || !valid(m.name) || !valid(m.note)) throw new AdpInputError("One of the chosen columns isn't in the file.");
  if (m.type === null && !m.fixedType) throw new AdpInputError("Choose the column that holds the line type, or one type for every line.");
  if (m.fixedType && !LINE_TYPES.includes(m.fixedType)) throw new AdpInputError("Choose a line type.");
  const rows: CsvPreviewRow[] = [];
  grid.forEach((r, i) => {
    if (m.headerRow && i === 0) return;
    if (r.every((c) => !String(c ?? "").trim())) return;
    const at = (c: number | null) => (c === null ? "" : String(r[c] ?? "").trim());
    const rawAmount = at(m.amount);
    const type = m.type === null ? m.fixedType : parseLineType(at(m.type));
    const amountCents = rawAmount ? parseCents(rawAmount, { allowNegative: true }) : null;
    let error: string | null = null;
    if (!rawAmount) error = "No amount";
    else if (amountCents === null) error = `“${rawAmount.slice(0, 40)}” isn't an amount`;
    else if (!type) error = m.type === null ? "No line type" : `Type “${at(m.type).slice(0, 40)}” isn't Commission, Residual, Bonus or Adjustment`;
    else if (amountCents < 0 && type !== "ADJUSTMENT") error = "Only adjustments can be negative";
    rows.push({
      rowNumber: i + 1,
      include: !skip.has(i + 1) && !error,
      name: at(m.name).slice(0, 200),
      type,
      amountCents,
      note: at(m.note).slice(0, 1000),
      error,
    });
  });
  return rows;
}

// --- Reports ------------------------------------------------------------------------------------

export type ReportBasis = "statementDate" | "periodEnd";

export type ReportLine = {
  amountCents: number;
  type: string;
  statementId: string;
  statementDate: string;
  periodEnd: string;
  clientKey: string;
  clientLabel: string;
  productKey: string;
  productLabel: string;
};

export type ReportPayment = { id: string; amountCents: number; receivedOn: string; statementId: string | null };

export type Row = { key: string; label: string; earnedCents: number; receivedCents: number; outstandingCents: number };

export const UNMATCHED_KEY = "__unmatched";
export const UNMATCHED_LABEL = "Payments not yet matched to a statement";
const NO_LINES_KEY = "__nolines";
const NO_LINES_LABEL = "Matched statement has no lines";

const row = (key: string, label: string): Row => ({ key, label, earnedCents: 0, receivedCents: 0, outstandingCents: 0 });
const finish = (rows: Iterable<Row>) =>
  [...rows].map((r) => ({ ...r, outstandingCents: r.earnedCents - r.receivedCents })).sort((a, b) => (a.key.startsWith("__") ? 1 : 0) - (b.key.startsWith("__") ? 1 : 0) || b.earnedCents - a.earnedCents || a.label.localeCompare(b.label));

/**
 * Splits a payment across the matched statement's lines in proportion to each line, to the cent
 * (largest remainder), so a by-client or by-product view can show what was received for each.
 */
export function allocate(totalCents: number, weights: number[]): number[] {
  const sum = weights.reduce((s, w) => s + w, 0);
  if (!weights.length || sum === 0) return weights.map(() => 0);
  const raw = weights.map((w) => (totalCents * w) / sum);
  const floors = raw.map((r) => Math.floor(r));
  let left = totalCents - floors.reduce((s, f) => s + f, 0);
  const order = raw.map((r, i) => ({ i, frac: r - Math.floor(r) })).sort((a, b) => b.frac - a.frac || a.i - b.i);
  for (const o of order) {
    if (left <= 0) break;
    floors[o.i] += 1;
    left -= 1;
  }
  return floors;
}

const inPeriod = (ymd: string, year: number, month: number | null) => Number(ymd.slice(0, 4)) === year && (month === null || Number(ymd.slice(5, 7)) === month);

/**
 * Earned (statement lines) vs received (payments), outstanding = earned − received:
 *  - months: the 12 calendar months of `year`;
 *  - years: every year with activity;
 *  - byClient / byProduct: the selected year (or month), received split across the matched
 *    statement's lines; payments not matched to a statement get their own row.
 * Earned is dated by the statement date (default) or the statement's period end.
 */
export function buildReport(input: { lines: ReportLine[]; payments: ReportPayment[]; year: number; month?: number | null; basis?: ReportBasis }) {
  const basis = input.basis ?? "statementDate";
  const month = input.month ?? null;
  const dateOf = (l: ReportLine) => (basis === "periodEnd" ? l.periodEnd : l.statementDate);

  const months = Array.from({ length: 12 }, (_, i) => row(String(i + 1), new Date(Date.UTC(2000, i, 1)).toLocaleString("en-US", { month: "long", timeZone: "UTC" })));
  const years = new Map<string, Row>();
  const yearRow = (y: string) => years.get(y) ?? years.set(y, row(y, y)).get(y)!;
  for (const l of input.lines) {
    const d = dateOf(l);
    yearRow(d.slice(0, 4)).earnedCents += l.amountCents;
    if (Number(d.slice(0, 4)) === input.year) months[Number(d.slice(5, 7)) - 1].earnedCents += l.amountCents;
  }
  for (const p of input.payments) {
    yearRow(p.receivedOn.slice(0, 4)).receivedCents += p.amountCents;
    if (Number(p.receivedOn.slice(0, 4)) === input.year) months[Number(p.receivedOn.slice(5, 7)) - 1].receivedCents += p.amountCents;
  }

  const byStatement = new Map<string, ReportLine[]>();
  for (const l of input.lines) byStatement.set(l.statementId, [...(byStatement.get(l.statementId) ?? []), l]);
  const group = (keyOf: (l: ReportLine) => [string, string]) => {
    const m = new Map<string, Row>();
    const get = (k: string, label: string) => m.get(k) ?? m.set(k, row(k, label)).get(k)!;
    for (const l of input.lines) if (inPeriod(dateOf(l), input.year, month)) get(...keyOf(l)).earnedCents += l.amountCents;
    for (const p of input.payments) {
      if (!inPeriod(p.receivedOn, input.year, month)) continue;
      const lines = p.statementId ? byStatement.get(p.statementId) ?? [] : [];
      if (!p.statementId) {
        get(UNMATCHED_KEY, UNMATCHED_LABEL).receivedCents += p.amountCents;
        continue;
      }
      const shares = allocate(p.amountCents, lines.map((l) => l.amountCents));
      if (!lines.length || shares.every((s) => s === 0)) {
        get(NO_LINES_KEY, NO_LINES_LABEL).receivedCents += p.amountCents;
        continue;
      }
      lines.forEach((l, i) => (get(...keyOf(l)).receivedCents += shares[i]));
    }
    return finish(m.values());
  };

  const sum = (rows: Row[]) => rows.reduce((t, r) => ({ ...t, earnedCents: t.earnedCents + r.earnedCents, receivedCents: t.receivedCents + r.receivedCents }), row("total", "Total"));
  const monthRows = finish(months).sort((a, b) => Number(a.key) - Number(b.key));
  const yearRows = finish(years.values()).sort((a, b) => a.key.localeCompare(b.key));
  const byClient = group((l) => [l.clientKey, l.clientLabel]);
  const byProduct = group((l) => [l.productKey, l.productLabel]);
  const withOutstanding = (r: Row) => ({ ...r, outstandingCents: r.earnedCents - r.receivedCents });
  const periodRows = month === null ? monthRows : [monthRows[month - 1]];
  return {
    basis,
    year: input.year,
    month,
    months: monthRows,
    years: yearRows,
    byClient,
    byProduct,
    total: withOutstanding(sum(periodRows)),
    yearTotal: withOutstanding(sum(monthRows)),
    allTime: withOutstanding(sum(yearRows)),
  };
}
export type AdpReport = ReturnType<typeof buildReport>;

/** Reports page / export query: ?year=2026&month=3&basis=periodEnd (defaults: this year, whole year, statement date). */
export function reportParams(sp: { year?: string; month?: string; basis?: string }, today = new Date().toISOString().slice(0, 10)) {
  const y = Number(sp.year);
  const year = Number.isInteger(y) && y >= 2000 && y <= 2100 ? y : Number(today.slice(0, 4));
  const m = Number(sp.month);
  const month = Number.isInteger(m) && m >= 1 && m <= 12 ? m : null;
  const basis: ReportBasis = sp.basis === "periodEnd" ? "periodEnd" : "statementDate";
  return { year, month, basis };
}
