import { createHash } from "node:crypto";
import { PAYROLL_FIELDS, type PayrollField, type PayrollPreset } from "./fields";

/**
 * Reads payroll register / payroll journal exports (ADP RUN, ADP Workforce Now, Paychex Flex,
 * or any layout mapped by hand) into totals per check date. Pure: no database, no guessing of
 * amounts. A pay date whose figures don't tie out (gross − employee taxes − deductions ≠ net)
 * is reported, never "fixed".
 *
 * The presets match column headers commonly seen in each provider's exports. They are not
 * copies of an official file specification (none is published for these reports), so the
 * importer always shows the mapping and lets staff change it before anything is created.
 */

export class RegisterError extends Error {}

export type Mapping = Record<number, PayrollField | "">;
export type Amounts = {
  hoursHundredths: number;
  grossCents: number;
  federalWhCents: number;
  ssEeCents: number;
  medicareEeCents: number;
  stateWhCents: number;
  otherEeTaxCents: number;
  employerTaxCents: number;
  deductionsCents: number;
  netPayCents: number;
};
export type EmployeeLine = Amounts & { employeeName: string };
export type PayDateTotals = Amounts & {
  checkDate: string;
  periodStart: string | null;
  periodEnd: string | null;
  employees: number;
  lines: EmployeeLine[];
  /** gross − employee taxes − deductions − net. Zero when the pay date ties out. */
  differenceCents: number;
  totalsHash: string;
};

export const AMOUNT_KEYS: (keyof Amounts)[] = ["hoursHundredths", "grossCents", "federalWhCents", "ssEeCents", "medicareEeCents", "stateWhCents", "otherEeTaxCents", "employerTaxCents", "deductionsCents", "netPayCents"];
const FIELD_KEY: Partial<Record<PayrollField, keyof Amounts>> = {
  hours: "hoursHundredths",
  gross: "grossCents",
  federalWh: "federalWhCents",
  ssEe: "ssEeCents",
  medicareEe: "medicareEeCents",
  stateWh: "stateWhCents",
  otherEeTax: "otherEeTaxCents",
  employerTax: "employerTaxCents",
  deductions: "deductionsCents",
  netPay: "netPayCents",
};
// Withholding, deduction and employer-tax columns are sometimes exported as negatives.
const WITHHOLDING: (keyof Amounts)[] = ["federalWhCents", "ssEeCents", "medicareEeCents", "stateWhCents", "otherEeTaxCents", "employerTaxCents", "deductionsCents"];
const SINGLE: PayrollField[] = ["checkDate", "periodStart", "periodEnd", "employee"];

export const zero = (): Amounts => ({ hoursHundredths: 0, grossCents: 0, federalWhCents: 0, ssEeCents: 0, medicareEeCents: 0, stateWhCents: 0, otherEeTaxCents: 0, employerTaxCents: 0, deductionsCents: 0, netPayCents: 0 });
export const employeeTaxes = (a: Amounts) => a.federalWhCents + a.ssEeCents + a.medicareEeCents + a.stateWhCents + a.otherEeTaxCents;
export const differenceOf = (a: Amounts) => a.grossCents - employeeTaxes(a) - a.deductionsCents - a.netPayCents;
/** Total payroll cost to the business: gross wages plus employer taxes. */
export const payrollCost = (a: Pick<Amounts, "grossCents" | "employerTaxCents">) => a.grossCents + a.employerTaxCents;

// --- Cells ------------------------------------------------------------------------------

/** "1,234.56", "$1,234.56", "(12.00)", "-12" → cents; blank → 0; anything else → null. */
export function cents(raw: string): number | null {
  const v = raw.trim();
  if (!v || v === "-" || v === "—") return 0;
  const neg = /^\(.*\)$/.test(v) || v.startsWith("-") || v.endsWith("-");
  const s = v.replace(/[()$,\s-]/g, "");
  if (!/^\d+(\.\d+)?$/.test(s)) return null;
  const c = Math.round(Number(s) * 100);
  return neg ? -c : c;
}

const isYmd = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s) && new Date(`${s}T00:00:00Z`).toISOString().startsWith(s);

/** 2026-10-23, 10/23/2026, 10/23/26, 10-23-2026, an Excel serial day number, or an ISO timestamp. */
export function parseDate(raw: string): string | null {
  const v = raw.trim();
  let m = v.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ].*)?$/);
  if (m) {
    const d = `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`;
    return isYmd(d) ? d : null;
  }
  m = v.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2}|\d{4})$/);
  if (m) {
    const y = m[3].length === 2 ? `20${m[3]}` : m[3];
    const d = `${y}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}`;
    return isYmd(d) ? d : null;
  }
  if (/^\d{5}(\.0+)?$/.test(v)) {
    const n = Number(v);
    if (n > 36000 && n < 60000) return new Date(Date.UTC(1899, 11, 30) + n * 86400000).toISOString().slice(0, 10);
  }
  return null;
}

// --- Header recognition ------------------------------------------------------------------

const norm = (h: string) => h.toLowerCase().replace(/[_\n\r]+/g, " ").replace(/\s+/g, " ").trim();
const TAXY = /tax|social|soc\.? ?sec|oasdi|medicare|futa|suta|\bsui\b|\bsdi\b|fica|unemployment|\bss\b|\bmed\b/;
const EMPLOYER = /\ber\b|employer|company|\bco\b|futa|suta|\bsui\b/;
const TOTAL = /^total\b|\btotal$/;

// Provider-specific header names first (seen in each provider's exports), then the general rules.
const PROVIDER_ALIASES: Record<PayrollPreset, [PayrollField, RegExp][]> = {
  ADP_RUN: [
    ["checkDate", /^check date$/],
    ["employee", /^employee( name)?$/],
    ["hours", /^total hours$/],
    ["gross", /^gross( pay)?$/],
    ["federalWh", /^federal income tax$/],
    ["netPay", /^net pay$/],
  ],
  ADP_WFN: [
    ["checkDate", /^pay date$/],
    ["employee", /^(associate name|name)$/],
    ["gross", /^gross pay$/],
    ["federalWh", /^federal tax$/],
    ["netPay", /^net pay$/],
  ],
  PAYCHEX_FLEX: [
    ["checkDate", /^check date$/],
    ["employee", /^(employee|employee name)$/],
    ["gross", /^gross$/],
    ["federalWh", /^fed(eral)? inc(ome)? tax$/],
    ["netPay", /^net( pay)?$/],
  ],
  OTHER: [],
};

/** The field a column header most likely holds ("" = ignore). Never maps a "rate" column. */
export function guessPayrollField(header: string, preset: PayrollPreset = "OTHER"): PayrollField | "" {
  const h = norm(header);
  if (!h || /\brate\b|\bytd\b|year to date|\bid\b|ssn|social security number|account|routing|department|dept|location|check (no|number|#)|^memo/.test(h)) return "";
  for (const [field, re] of PROVIDER_ALIASES[preset]) if (re.test(h)) return field;
  if (/^(check|pay|payment|paid) ?date$|^check dt$|^pay day$|^check ?date$/.test(h)) return "checkDate";
  if (/period (start|begin)|^period from$|^begin date$|^pay period start/.test(h)) return "periodStart";
  if (/period end|^period to$|^end date$|week ending/.test(h)) return "periodEnd";
  if (/^(employee|employee name|name|worker|worker name|emp name|associate|associate name|employee full name)$/.test(h)) return "employee";
  if (/hours|\bhrs\b/.test(h)) return "hours";
  if (TAXY.test(h) && EMPLOYER.test(h)) return "employerTax";
  if (/employer (tax|taxes|liab)/.test(h)) return "employerTax";
  if (/^net( pay| amount| check| wages)?$|net pay|take home/.test(h)) return "netPay";
  if (/^(total )?gross( pay| wages| earnings| amount)?$|gross pay|gross wages|^total earnings$/.test(h)) return "gross";
  if (/federal income|fed(eral)? ?(w\/?h|withholding|income|inc|tax)\b|^fitw?$|^fwt$/.test(h)) return "federalWh";
  if (/social security|soc\.? ?sec|oasdi|fica ?-? ?ss|^ss( ee)?$|^ss\b/.test(h)) return "ssEe";
  if (/medicare|fica ?-? ?med|^med( ee)?$/.test(h)) return "medicareEe";
  if (/state (income|inc|w\/?h|withholding|tax)|^sit$|^swt$|^[a-z]{2} (sit|swt|inc(ome)? tax|withholding|w\/h|state tax)$/.test(h)) return "stateWh";
  if (TAXY.test(h) && /local|city|county|school|sdi|pfl|fli|occupational|\bee\b|employee/.test(h) && !/total/.test(h)) return "otherEeTax";
  if (/deduction|401 ?\(?k|403 ?\(?b|retire|medical|dental|vision|health|\bhsa\b|\bfsa\b|garnish|child support|loan|insurance|union|pre-?tax|post-?tax|roth/.test(h)) return "deductions";
  return "";
}

/** Suggested mapping for a header row. Where a field has a "Total …" column and itemized ones, only the total is kept. */
export function autoMap(headers: string[], preset: PayrollPreset = "OTHER"): Mapping {
  const m: Mapping = {};
  headers.forEach((h, i) => (m[i] = guessPayrollField(h, preset)));
  const byField = new Map<PayrollField, number[]>();
  for (const [i, f] of Object.entries(m)) if (f) byField.set(f, [...(byField.get(f) ?? []), Number(i)]);
  for (const [f, cols] of byField) {
    if (cols.length < 2) continue;
    if (SINGLE.includes(f)) {
      cols.slice(1).forEach((c) => (m[c] = ""));
      continue;
    }
    const totals = cols.filter((c) => TOTAL.test(norm(headers[c])));
    if (totals.length) cols.filter((c) => !totals.includes(c)).forEach((c) => (m[c] = ""));
  }
  return m;
}

/** The header row: within the first 20 rows, the one that best looks like a register header. */
export function findHeaderRow(grid: string[][], preset: PayrollPreset = "OTHER"): number {
  let best = -1;
  let bestScore = 0;
  for (let r = 0; r < Math.min(grid.length, 20); r++) {
    const fields = new Set(grid[r].map((h) => guessPayrollField(h, preset)).filter(Boolean));
    const score = fields.size + (fields.has("netPay") ? 2 : 0) + (fields.has("gross") ? 2 : 0) + (fields.has("checkDate") ? 1 : 0);
    if (score > bestScore && (fields.has("gross") || fields.has("netPay"))) {
      best = r;
      bestScore = score;
    }
  }
  // Nothing recognizable: the first row is taken as the header so the columns can be mapped by hand.
  return best < 0 ? 0 : best;
}

// --- Totals --------------------------------------------------------------------------------

export function totalsHash(t: Amounts & { checkDate: string; employees: number }) {
  const parts = [t.checkDate, t.employees, ...AMOUNT_KEYS.map((k) => t[k])];
  return createHash("sha256").update(parts.join("|")).digest("hex").slice(0, 32);
}

/** The header row, its column names and the suggested mapping (for the manual mapping screen). */
export function headersOf(grid: string[][], preset: PayrollPreset = "OTHER", headerRow?: number | null) {
  const rowsIn = grid.filter((r) => r.some((c) => String(c ?? "").trim() !== ""));
  if (!rowsIn.length) throw new RegisterError("That file has no payroll rows.");
  const row = headerRow != null && headerRow >= 0 && headerRow < rowsIn.length ? headerRow : findHeaderRow(rowsIn, preset);
  const headers = rowsIn[row].map((h, i) => String(h ?? "").trim() || `Column ${i + 1}`);
  return { headerRow: row, headers, mapping: autoMap(headers, preset), sample: rowsIn.slice(row + 1, row + 4) };
}

export type ParsedRegister = { headers: string[]; headerRow: number; mapping: Mapping; payDates: PayDateTotals[]; rows: number; skipped: string[] };

/**
 * Totals per check date. `defaultCheckDate` is used when the file has no date column
 * (some reports print the check date once in the title instead).
 */
export function readRegister(grid: string[][], opts: { preset?: PayrollPreset; mapping?: Mapping; defaultCheckDate?: string | null; headerRow?: number | null } = {}): ParsedRegister {
  const preset = opts.preset ?? "OTHER";
  const rowsIn = grid.filter((r) => r.some((c) => String(c ?? "").trim() !== ""));
  if (rowsIn.length < 2) throw new RegisterError("That file has no payroll rows.");
  const headerRow = opts.headerRow != null && opts.headerRow >= 0 && opts.headerRow < rowsIn.length - 1 ? opts.headerRow : findHeaderRow(rowsIn, preset);
  const headers = rowsIn[headerRow].map((h, i) => String(h ?? "").trim() || `Column ${i + 1}`);
  const mapping: Mapping = opts.mapping ?? autoMap(headers, preset);
  const cols = (f: PayrollField) => Object.entries(mapping).filter(([, v]) => v === f).map(([k]) => Number(k));
  for (const f of SINGLE) if (cols(f).length > 1) throw new RegisterError(`Only one column can be "${PAYROLL_FIELDS[f]}".`);
  if (!cols("gross").length || !cols("netPay").length) throw new RegisterError("Couldn't find the Gross wages and Net pay columns. Map them below (and the check date), or export the register with column headings.");
  const dateDefault = opts.defaultCheckDate ? parseDate(opts.defaultCheckDate) : null;
  if (!cols("checkDate").length && !dateDefault) throw new RegisterError("Map the Check / pay date column, or enter the check date for this file.");
  const [iDate] = cols("checkDate");
  const [iEmp] = cols("employee");
  const [iStart] = cols("periodStart");
  const [iEnd] = cols("periodEnd");

  type Row = Amounts & { checkDate: string; employee: string; periodStart: string | null; periodEnd: string | null };
  const out: Row[] = [];
  const skipped: string[] = [];
  let carryDate: string | null = null;
  for (let r = headerRow + 1; r < rowsIn.length; r++) {
    const cells = rowsIn[r].map((c) => String(c ?? ""));
    const label = `${cells[iEmp ?? -1] ?? ""} ${cells[0] ?? ""}`.trim();
    // Subtotal / grand-total rows would count the same pay twice.
    if (/^(grand |company |report |department |dept |)totals?\b|\btotals?:?$|^total for\b/i.test(label) || /^(grand |company |report )?totals?\b/i.test((cells[0] ?? "").trim())) {
      skipped.push(`Row ${r + 1}: a totals row (not counted twice)`);
      continue;
    }
    const a = zero();
    let bad = "";
    for (const [f, key] of Object.entries(FIELD_KEY) as [PayrollField, keyof Amounts][]) {
      for (const c of cols(f)) {
        const v = cents(cells[c] ?? "");
        if (v === null) bad = `"${cells[c]}" in ${headers[c]} isn't an amount`;
        else a[key] += v;
      }
    }
    if (bad) {
      skipped.push(`Row ${r + 1}: ${bad}`);
      continue;
    }
    if (AMOUNT_KEYS.every((k) => a[k] === 0)) continue;
    const dateCell = iDate === undefined ? "" : (cells[iDate] ?? "").trim();
    let checkDate: string | null = dateCell ? parseDate(dateCell) : (carryDate ?? dateDefault);
    if (dateCell && !checkDate) {
      skipped.push(`Row ${r + 1}: "${dateCell}" isn't a date`);
      continue;
    }
    if (!checkDate) checkDate = dateDefault;
    if (!checkDate) {
      skipped.push(`Row ${r + 1}: no check date`);
      continue;
    }
    if (dateCell) carryDate = checkDate;
    out.push({ ...a, checkDate, employee: (iEmp === undefined ? "" : cells[iEmp] ?? "").replace(/\s+/g, " ").trim().slice(0, 120), periodStart: iStart === undefined ? null : parseDate(cells[iStart] ?? ""), periodEnd: iEnd === undefined ? null : parseDate(cells[iEnd] ?? "") });
  }
  if (!out.length) throw new RegisterError(`No payroll rows could be read.${skipped.length ? ` ${skipped.slice(0, 3).join("; ")}` : ""}`);
  // A column exported as negatives is a withholding convention, not a refund.
  for (const k of WITHHOLDING) {
    if (out.reduce((n, r) => n + r[k], 0) < 0) for (const r of out) r[k] = -r[k];
  }
  // Hours were read as cents of an hour: 40.25 hours → 4025 hundredths. (cents() already ×100.)
  const byDate = new Map<string, Row[]>();
  for (const r of out) byDate.set(r.checkDate, [...(byDate.get(r.checkDate) ?? []), r]);
  const payDates: PayDateTotals[] = [...byDate.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([checkDate, rows]) => {
      const lines = new Map<string, EmployeeLine>();
      rows.forEach((r, i) => {
        const name = r.employee || `Line ${i + 1}`;
        const l = lines.get(name) ?? { ...zero(), employeeName: name };
        for (const k of AMOUNT_KEYS) l[k] += r[k];
        lines.set(name, l);
      });
      const t = zero();
      for (const r of rows) for (const k of AMOUNT_KEYS) t[k] += r[k];
      const starts = rows.map((r) => r.periodStart).filter((x): x is string => !!x).sort();
      const ends = rows.map((r) => r.periodEnd).filter((x): x is string => !!x).sort();
      const employees = lines.size;
      return { ...t, checkDate, periodStart: starts[0] ?? null, periodEnd: ends.at(-1) ?? null, employees, lines: [...lines.values()], differenceCents: differenceOf(t), totalsHash: totalsHash({ ...t, checkDate, employees }) };
    });
  return { headers, headerRow, mapping, payDates, rows: out.length, skipped };
}

// --- Journal entry -----------------------------------------------------------------------

export type PayrollAccounts = { wages: string; employerTax: string; taxLiability: string; deductionsLiability: string; cash: string };
export type DraftLine = { accountId: string; debitCents: number; creditCents: number; description: string };

/**
 * The payroll journal entry for one pay date:
 * Dr wages expense (gross) and employer tax expense; Cr cash (net pay), payroll taxes payable
 * (each withholding and the employer share, as separate lines) and deductions payable.
 * Balances exactly when the pay date ties out (differenceOf = 0).
 */
export function payrollEntryLines(a: Amounts, acct: PayrollAccounts): DraftLine[] {
  const lines: DraftLine[] = [
    { accountId: acct.wages, debitCents: a.grossCents, creditCents: 0, description: "Gross wages" },
    { accountId: acct.employerTax, debitCents: a.employerTaxCents, creditCents: 0, description: "Employer payroll taxes" },
    { accountId: acct.cash, debitCents: 0, creditCents: a.netPayCents, description: "Net pay" },
    { accountId: acct.taxLiability, debitCents: 0, creditCents: a.federalWhCents, description: "Federal income tax withheld" },
    { accountId: acct.taxLiability, debitCents: 0, creditCents: a.ssEeCents, description: "Social Security withheld (employee)" },
    { accountId: acct.taxLiability, debitCents: 0, creditCents: a.medicareEeCents, description: "Medicare withheld (employee)" },
    { accountId: acct.taxLiability, debitCents: 0, creditCents: a.stateWhCents, description: "State income tax withheld" },
    { accountId: acct.taxLiability, debitCents: 0, creditCents: a.otherEeTaxCents, description: "Other employee taxes withheld" },
    { accountId: acct.taxLiability, debitCents: 0, creditCents: a.employerTaxCents, description: "Employer payroll taxes due" },
    { accountId: acct.deductionsLiability, debitCents: 0, creditCents: a.deductionsCents, description: "Employee deductions withheld" },
  ];
  return lines.filter((l) => l.debitCents > 0 || l.creditCents > 0);
}

/** Canonical content hash of a version's figures and lines (what an approval binds to). */
export function versionHash(v: Amounts & { checkDate: string; periodStart: string | null; periodEnd: string | null; employees: number; lines: EmployeeLine[] }) {
  const body = JSON.stringify({
    d: v.checkDate, s: v.periodStart, e: v.periodEnd, n: v.employees,
    t: AMOUNT_KEYS.map((k) => v[k]),
    l: v.lines.map((l) => [l.employeeName, ...AMOUNT_KEYS.map((k) => l[k])]),
  });
  return createHash("sha256").update(body).digest("hex");
}
