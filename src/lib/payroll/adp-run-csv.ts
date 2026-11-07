import Papa from "papaparse";

/**
 * ADP RUN "Time Sheet Import" file (RUN Powered by ADP®, Time Sheet Import guide GTSG-V0418A,
 * "File Specifications" and "Time Sheet File Record Layout Using a Payroll Assigned Identifier"):
 *
 *   Row 1  ##GENERIC## V1.0                       (file identifier with a version number)
 *   Row 2  the 11 column titles, in this order
 *   Row 3+ one row per employee per earnings code
 *
 * - .csv, comma delimited; one company code and one pay frequency per file; the company code, pay
 *   frequency and pay period start/end are identical on every row.
 * - Company code: the IID, or Branch Code + ADP Code (ADP's example "RFCAV").
 * - Pay frequency: B (biweekly) · W (weekly) · S (semimonthly) · M (monthly) · Q (quarterly).
 * - Dates MM/DD/YYYY; Pay Hours and Dollars numeric [11.2] with the decimal written out.
 * - Separate Check 0–9 (0 = the regular check). Rate Code is a code (BASE, RATE_2…RATE_5,
 *   HRLY4SLRY1), never a rate value. Worked In Dept only when the company has departments.
 *
 * Pure functions only (no database), so the same code builds the file, validates it and is tested
 * with fictional data.
 */

export const FILE_IDENTIFIER = "##GENERIC## V1.0";
export const EMPLOYEE_ID_TITLES = ["Company Code", "Pay Frequency", "Pay Period Start", "Pay Period End", "Employee ID", "Earnings Code", "Pay Hours", "Dollars", "Separate Check", "Worked In Dept", "Rate Code"] as const;
export const TIME_CLOCK_TITLES = ["Company Code", "Pay Frequency", "Pay Period Start", "Pay Period End", "Employee Time Clock ID", "Earnings Code", "Pay Hours", "Dollars", "Separate Check", "Worked In Dept", "Rate Code"] as const;
export type IdentifierType = "EMPLOYEE_ID" | "TIME_CLOCK_ID";

/** Client Connect schedule frequency → ADP pay frequency letter. */
export const ADP_FREQUENCY: Record<string, string> = { WEEKLY: "W", BIWEEKLY: "B", SEMIMONTHLY: "S", MONTHLY: "M" };
export const ADP_FREQUENCY_LABEL: Record<string, string> = { W: "Weekly", B: "Biweekly", S: "Semimonthly", M: "Monthly", Q: "Quarterly" };
export const RATE_CODES = ["BASE", "RATE_2", "RATE_3", "RATE_4", "RATE_5", "HRLY4SLRY1"] as const;

/** What Client Connect sends today (from the hours entry) and the earnings code each uses. */
export const EARNING_KINDS = { REGULAR: "Regular hours", OVERTIME: "Overtime hours" } as const;
export type EarningKind = keyof typeof EARNING_KINDS;

/** Payroll items the Time Sheet Import doesn't carry: they stay in RUN, entered there as today. */
export const NOT_IN_IMPORT = [
  "Deductions, garnishments and benefit changes",
  "Tax setup or one-time tax changes",
  "New hires, rehires and terminations (RUN's New Hire Wizard and Employment Info)",
  "Pay rate amounts (the file carries rate codes only)",
  "Direct deposit and bank details",
  "1099 contractor payments (the guide covers active employees only)",
  "Employees on leave or terminated before the period start (RUN excludes them)",
] as const;

const COMPANY_CODE = /^[A-Za-z0-9]{2,10}$/;
const EMPLOYEE_ID = /^[A-Za-z0-9]{1,15}$/;
const EARNINGS_CODE = /^[A-Za-z0-9_\-]{1,10}$/;
const DEPT = /^\d{1,6}$/;

export const normalizeCompanyCode = (s: string) => s.replace(/\s+/g, "").toUpperCase();
export const nameKey = (s: string) => s.normalize("NFKD").replace(/[^\p{L}\p{N}]+/gu, " ").trim().toLowerCase();

/** Branch + Code (both from ADP Accountant Connect), e.g. "XX" + "ABC" → "XXABC" (ADP's own example is "RFCAV"). */
export function branchCompanyCode(branch: string, code: string) {
  return normalizeCompanyCode(`${branch}${code}`);
}

export function isCompanyCode(s: string) {
  return COMPANY_CODE.test(normalizeCompanyCode(s));
}

const mmddyyyy = (ymd: string) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd);
  if (!m) throw new Error(`Bad date ${ymd}`);
  return `${m[2]}/${m[3]}/${m[1]}`;
};
const money = (hundredths: number) => (hundredths / 100).toFixed(2);

// --- Template -------------------------------------------------------------------------------------

export type TemplateCheck = { ok: true; identifierType: IdentifierType; version: string; titles: string[]; companyCodes: string[] } | { ok: false; problems: string[] };

function rowsOf(text: string): string[][] {
  const parsed = Papa.parse<string[]>(text.replace(/^﻿/, ""), { skipEmptyLines: "greedy" });
  return (parsed.data as string[][]).map((r) => r.map((c) => String(c ?? "").trim()));
}

const sameTitle = (a: string, b: string) => a.replace(/\s+/g, " ").trim().toLowerCase() === b.toLowerCase();

/** Checks a company's Time Sheet Import template (or any file built for it) against ADP's layout. */
export function checkTemplate(text: string): TemplateCheck {
  const rows = rowsOf(text);
  const problems: string[] = [];
  const first = rows[0]?.[0] ?? "";
  const version = /^##GENERIC##\s*V\d+(\.\d+)?$/i.test(first) ? first : "";
  if (!version) problems.push(`Row 1 must be the file identifier with a version number (for example ${FILE_IDENTIFIER}). Found “${first || "nothing"}”.`);
  const titles = (rows[1] ?? []).filter((t, i, all) => t !== "" || i < all.length - 1);
  const trimmed = titles.slice(0, 11);
  const matches = (expected: readonly string[]) => trimmed.length === 11 && expected.every((t, i) => sameTitle(trimmed[i], t));
  const identifierType: IdentifierType | null = matches(EMPLOYEE_ID_TITLES) ? "EMPLOYEE_ID" : matches(TIME_CLOCK_TITLES) ? "TIME_CLOCK_ID" : null;
  if (!identifierType) problems.push(`Row 2 must have ADP's 11 column titles in order: ${EMPLOYEE_ID_TITLES.join(", ")} (or “Employee Time Clock ID” in the fifth column). Found: ${titles.join(", ") || "nothing"}.`);
  if (titles.slice(11).some((t) => t)) problems.push("Row 2 has more than 11 columns.");
  const companyCodes = [...new Set(rows.slice(2).map((r) => normalizeCompanyCode(r[0] ?? "")).filter(Boolean))];
  if (companyCodes.length > 1) problems.push(`The file has more than one company code (${companyCodes.join(", ")}). ADP imports one company at a time.`);
  if (problems.length || !identifierType) return { ok: false, problems };
  return { ok: true, identifierType, version, titles: trimmed, companyCodes };
}

// --- RUN reports (Employee Codes / Earnings Codes / Department Numbers, "Export to Excel" saved as CSV) --

export type ReportEmployee = { adpEmployeeId: string; name: string; payFrequency: string | null; status: string | null };
export type ReportEarning = { code: string; description: string };

function findHeader(rows: string[][], need: RegExp[]): number {
  return rows.findIndex((r) => need.every((re) => r.some((c) => re.test(c))));
}
const col = (header: string[], ...res: RegExp[]) => {
  for (const re of res) {
    const i = header.findIndex((c) => re.test(c));
    if (i >= 0) return i;
  }
  return -1;
};

/** Reads the Employee Codes Report. Columns are found by their titles, never by position. */
export function parseEmployeeReport(text: string): { employees: ReportEmployee[]; problems: string[] } {
  const rows = rowsOf(text);
  const h = findHeader(rows, [/^(employee\s*(id|code|#|number)|file\s*(#|number)|associate\s*id)$/i, /name/i]);
  if (h < 0) return { employees: [], problems: ["Couldn't find the Employee ID (or Employee Code) and Name columns. Export the Employee Codes Report from RUN → Reports and save it as CSV."] };
  const header = rows[h];
  const iId = col(header, /^employee\s*(id|code|#|number)$/i, /^file\s*(#|number)$/i, /^associate\s*id$/i);
  const iFirst = col(header, /^first\s*name$/i);
  const iLast = col(header, /^last\s*name$/i);
  const iName = col(header, /^(employee\s*)?name$/i, /name/i);
  const iFreq = col(header, /pay\s*freq/i);
  const iStatus = col(header, /status/i);
  const problems: string[] = [];
  const seen = new Set<string>();
  const employees: ReportEmployee[] = [];
  for (const r of rows.slice(h + 1)) {
    const id = (r[iId] ?? "").trim();
    if (!id) continue;
    const name = iFirst >= 0 && iLast >= 0 ? `${r[iFirst] ?? ""} ${r[iLast] ?? ""}`.trim() : (r[iName] ?? "").trim();
    // "Last, First" → "First Last"
    const display = /^[^,]+,\s*[^,]+$/.test(name) ? name.split(",").map((s) => s.trim()).reverse().join(" ") : name;
    if (!EMPLOYEE_ID.test(id)) { problems.push(`Skipped “${id}”: not an ADP employee ID.`); continue; }
    if (seen.has(id)) { problems.push(`Employee ID ${id} appears more than once in the report.`); continue; }
    seen.add(id);
    employees.push({ adpEmployeeId: id, name: display, payFrequency: iFreq >= 0 ? (r[iFreq] || null) : null, status: iStatus >= 0 ? (r[iStatus] || null) : null });
  }
  if (!employees.length) problems.push("No employees were found in the report.");
  return { employees, problems };
}

/** Reads the Earnings Codes Report. */
export function parseEarningsReport(text: string): { earnings: ReportEarning[]; problems: string[] } {
  const rows = rowsOf(text);
  const h = findHeader(rows, [/code/i, /desc|name/i]);
  if (h < 0) return { earnings: [], problems: ["Couldn't find the Code and Description columns. Export the Earnings Codes Report from RUN → Reports and save it as CSV."] };
  const header = rows[h];
  const iCode = col(header, /^earnings?\s*code$/i, /^code$/i, /code/i);
  const iDesc = col(header, /desc/i, /name/i);
  const seen = new Set<string>();
  const earnings: ReportEarning[] = [];
  for (const r of rows.slice(h + 1)) {
    const code = (r[iCode] ?? "").trim().toUpperCase();
    if (!code || !EARNINGS_CODE.test(code) || seen.has(code)) continue;
    seen.add(code);
    earnings.push({ code, description: (r[iDesc] ?? "").trim() });
  }
  return { earnings, problems: earnings.length ? [] : ["No earnings codes were found in the report."] };
}

// --- The file -------------------------------------------------------------------------------------

export type HoursEntry = { name: string; regularHours: number; overtimeHours: number };
export type EmployeeMap = { name: string; adpEmployeeId: string; active: boolean; departmentCode: string | null; rateCode: string };
export type BuildInput = {
  clientId: string;
  setupClientId: string;
  companyCode: string;
  identifierType: IdentifierType;
  templateTitles: string[];
  templateVersion: string;
  frequency: string; // schedule frequency (WEEKLY…) or an ADP letter
  setupFrequency: string | null; // the ADP letter staff confirmed in setup
  periodStart: string; // YYYY-MM-DD
  periodEnd: string;
  hours: HoursEntry[];
  employees: EmployeeMap[];
  employeeClientIds: string[]; // clientId of every mapping row used (cross-client guard)
  earnings: Partial<Record<EarningKind, string>>;
};
export type BuildResult = { ok: true; csv: string; rows: number; employees: number; hoursHundredths: number; lines: { name: string; adpEmployeeId: string; code: string; hours: string }[] } | { ok: false; problems: string[] };

const hundredths = (n: number) => Math.round(n * 100);

/** Builds the CSV for one company and one pay period, or explains exactly what blocks it. */
export function buildAdpCsv(input: BuildInput): BuildResult {
  const problems: string[] = [];
  if (input.setupClientId !== input.clientId || input.employeeClientIds.some((c) => c !== input.clientId)) problems.push("The ADP setup or an employee mapping belongs to a different business. Nothing was built.");
  const company = normalizeCompanyCode(input.companyCode);
  if (!COMPANY_CODE.test(company)) problems.push("The ADP company code is missing or not valid (letters and numbers, 2–10 characters).");
  const letter = ADP_FREQUENCY[input.frequency] ?? (ADP_FREQUENCY_LABEL[input.frequency] ? input.frequency : "");
  if (!letter) problems.push("This pay schedule's frequency has no ADP pay frequency.");
  if (input.setupFrequency && letter && input.setupFrequency !== letter) problems.push(`The pay schedule is ${ADP_FREQUENCY_LABEL[letter] ?? letter} but the ADP setup says ${ADP_FREQUENCY_LABEL[input.setupFrequency] ?? input.setupFrequency}. Fix one so they match.`);
  if (!(input.periodStart <= input.periodEnd)) problems.push("The pay period dates are not valid.");
  const titles = input.identifierType === "TIME_CLOCK_ID" ? TIME_CLOCK_TITLES : EMPLOYEE_ID_TITLES;
  if (input.templateTitles.length !== 11 || !titles.every((t, i) => sameTitle(input.templateTitles[i] ?? "", t))) problems.push("This company's ADP template hasn't been checked yet (or doesn't match ADP's layout). Upload it in the ADP setup.");
  if (!/^##GENERIC##\s*V\d+(\.\d+)?$/i.test(input.templateVersion)) problems.push("The template's version row is missing.");
  for (const kind of ["REGULAR", "OVERTIME"] as const) {
    const code = input.earnings[kind];
    const used = input.hours.some((h) => (kind === "REGULAR" ? h.regularHours : h.overtimeHours) > 0);
    if (used && (!code || !EARNINGS_CODE.test(code))) problems.push(`Choose the ADP earnings code for ${EARNING_KINDS[kind].toLowerCase()} in the ADP setup.`);
  }
  const byName = new Map(input.employees.map((e) => [nameKey(e.name), e]));
  const usedIds = new Map<string, string>();
  const lines: { name: string; adpEmployeeId: string; code: string; hours: string; dept: string; rate: string }[] = [];
  let total = 0;
  for (const h of input.hours) {
    const reg = hundredths(h.regularHours);
    const ot = hundredths(h.overtimeHours);
    if (!reg && !ot) continue;
    const m = byName.get(nameKey(h.name));
    if (!m) { problems.push(`“${h.name}” isn't matched to an ADP employee ID. Match them in the ADP setup.`); continue; }
    if (!m.active) { problems.push(`“${h.name}” (ADP ${m.adpEmployeeId}) is marked inactive. RUN only imports active employees.`); continue; }
    if (!EMPLOYEE_ID.test(m.adpEmployeeId)) { problems.push(`“${h.name}” has an invalid ADP employee ID.`); continue; }
    if (m.departmentCode && !DEPT.test(m.departmentCode)) { problems.push(`“${h.name}” has an invalid department number.`); continue; }
    if (!(RATE_CODES as readonly string[]).includes(m.rateCode)) { problems.push(`“${h.name}” has an invalid rate code.`); continue; }
    const other = usedIds.get(m.adpEmployeeId);
    if (other) { problems.push(`“${h.name}” and “${other}” both point to ADP employee ${m.adpEmployeeId}.`); continue; }
    usedIds.set(m.adpEmployeeId, h.name);
    for (const [kind, n] of [["REGULAR", reg], ["OVERTIME", ot]] as const) {
      if (!n) continue;
      if (n < 0 || n > 99_999_999_999) { problems.push(`“${h.name}” has hours out of range.`); continue; }
      total += n;
      lines.push({ name: h.name, adpEmployeeId: m.adpEmployeeId, code: input.earnings[kind] ?? "", hours: money(n), dept: m.departmentCode ?? "", rate: m.rateCode });
    }
  }
  if (!lines.length && !problems.length) problems.push("There are no hours to send. (If nothing changed, RUN's standard hours apply and no file is needed.)");
  if (problems.length) return { ok: false, problems: [...new Set(problems)] };
  const head = [[input.templateVersion], input.templateTitles];
  const body = lines.map((l) => [company, letter, mmddyyyy(input.periodStart), mmddyyyy(input.periodEnd), l.adpEmployeeId, l.code, l.hours, "", "0", l.dept, l.rate]);
  const csv = Papa.unparse([...head, ...body], { newline: "\r\n", quotes: false }) + "\r\n";
  return { ok: true, csv, rows: body.length, employees: usedIds.size, hoursHundredths: total, lines: lines.map(({ name, adpEmployeeId, code, hours }) => ({ name, adpEmployeeId, code, hours })) };
}

/** Re-reads a built file and checks every rule again (what RUN checks on import). */
export function verifyAdpCsv(csv: string, expect: { companyCode: string; frequency: string; periodStart: string; periodEnd: string; employeeIds: string[] }): string[] {
  const t = checkTemplate(csv);
  if (!t.ok) return t.problems;
  const rows = rowsOf(csv).slice(2);
  const problems: string[] = [];
  const known = new Set(expect.employeeIds);
  for (const [i, r] of rows.entries()) {
    const at = `Row ${i + 3}`;
    if (normalizeCompanyCode(r[0]) !== normalizeCompanyCode(expect.companyCode)) problems.push(`${at}: wrong company code.`);
    if (r[1] !== expect.frequency) problems.push(`${at}: wrong pay frequency.`);
    if (r[2] !== mmddyyyy(expect.periodStart) || r[3] !== mmddyyyy(expect.periodEnd)) problems.push(`${at}: wrong pay period.`);
    if (!known.has(r[4])) problems.push(`${at}: employee ${r[4]} isn't one of this company's mapped employees.`);
    if (!/^\d{1,9}\.\d{2}$/.test(r[6]) && r[6] !== "") problems.push(`${at}: Pay Hours must have two decimals.`);
    if (!/^[0-9]$/.test(r[8])) problems.push(`${at}: Separate Check must be 0–9.`);
    if (!(RATE_CODES as readonly string[]).includes(r[10])) problems.push(`${at}: invalid rate code.`);
  }
  return problems;
}

/** ADP's suggested name, with the business so files for different clients never look alike. */
export function adpFileName(business: string, frequency: string, periodStart: string, periodEnd: string, test = false) {
  const slug = business.normalize("NFKD").replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "Business";
  const d = (s: string) => mmddyyyy(s).replace(/\//g, "");
  return `${test ? "TEST-" : ""}${slug}-ADP-${ADP_FREQUENCY_LABEL[frequency] ?? frequency}-${d(periodStart)}-${d(periodEnd)}.csv`;
}
