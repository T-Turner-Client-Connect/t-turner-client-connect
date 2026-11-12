/**
 * ADP RUN "Month, Quarter, Year-to-Date Summary" (Payroll Summary) PDF, read directly — no AI.
 *
 * The report lists, per check date: earnings lines and their total (hours, gross), employee tax lines
 * and their total, deduction lines and their total (when any), then net pay followed by the employer
 * tax lines and their total. Month/quarter/year-to-date blocks repeat the same layout and are only
 * used to check the check-date blocks. Every check date must tie out to the cent
 * (gross − employee taxes − deductions = net pay; employer lines = employer total) or nothing is read.
 * Pure: no database, no network.
 */

export type SummaryPayDate = {
  checkDate: string;
  frequency: string | null;
  hours: number;
  grossCents: number;
  federalWhCents: number;
  socialSecurityCents: number;
  medicareCents: number;
  stateWhCents: number;
  otherEmployeeTaxCents: number;
  deductionsCents: number;
  netPayCents: number;
  employerTaxCents: number;
};

export class AdpSummaryError extends Error {}

const AMT = String.raw`\$?-?[\d,]+\.\d{2}`;
const cents = (s: string) => Math.round(Number(s.replace(/[$,]/g, "")) * 100);
const ONLY_AMT = new RegExp(`^(${AMT})$`);
const TWO_AMT = new RegExp(`^(${AMT})\\s+(${AMT})$`);
const DESC_AMT = new RegExp(`^(.*?[A-Za-z].*?)\\s+(${AMT})$`);
const DESC_TWO = new RegExp(`^(.*?[A-Za-z].*?)\\s+(${AMT})\\s+(${AMT})$`);
const NET_LINE = new RegExp(`^(${AMT})\\s+(.*?[A-Za-z].*?)\\s+(${AMT})$`);

/** Is this text an ADP payroll summary (as opposed to a register, a check stub or something else)? */
export function looksLikeAdpSummary(text: string) {
  return /Month,\s*Quarter,\s*Year-to-Date Summary|Payroll Summary/i.test(text) && /Check Date:\s*\d{2}\/\d{2}\/\d{4}/i.test(text);
}

/** Joins a label split over several lines ("FED" / "MEDCARE" / "51.90") back onto its amount. */
function joinWrapped(lines: string[]) {
  const out: string[] = [];
  let pending = "";
  for (const raw of lines) {
    const l = raw.trim();
    if (!l) continue;
    if (/^[A-Za-z][A-Za-z \-/&()]*$/.test(l) && !/^(check date|pay frequency|company|year|description|hours and earnings)/i.test(l)) {
      pending = pending ? `${pending} ${l}` : l;
      continue;
    }
    if (pending && ONLY_AMT.test(l)) {
      out.push(`${pending} ${l}`);
      pending = "";
      continue;
    }
    if (pending) {
      out.push(pending);
      pending = "";
    }
    out.push(l);
  }
  if (pending) out.push(pending);
  return out;
}

const taxKind = (label: string): keyof Pick<SummaryPayDate, "federalWhCents" | "socialSecurityCents" | "medicareCents" | "stateWhCents" | "otherEmployeeTaxCents"> => {
  const l = label.toUpperCase();
  if (/\bFIT\b|FEDERAL INCOME|FED W\/?H/.test(l)) return "federalWhCents";
  if (/SOC\s*SEC|SOCIAL SECURITY|OASDI/.test(l)) return "socialSecurityCents";
  if (/MED\s*CARE|MEDICARE/.test(l)) return "medicareCents";
  if (/\bSIT\b|STATE INCOME|STATE W\/?H/.test(l)) return "stateWhCents";
  return "otherEmployeeTaxCents";
};

function parseBlock(lines: string[], checkDate: string, frequency: string | null): SummaryPayDate {
  const fail = (why: string) => new AdpSummaryError(`The ${checkDate} check date couldn't be verified: ${why}. Nothing was imported.`);
  let i = 0;
  // 1. Earnings: "Regular 144.00 3,400.00" … until the total "144.00 3,578.86".
  const earnings: number[] = [];
  let hours = 0, gross = 0;
  for (; i < lines.length; i++) {
    const tot = TWO_AMT.exec(lines[i]);
    if (tot) { hours = Number(tot[1].replace(/[$,]/g, "")); gross = cents(tot[2]); i++; break; }
    const e = DESC_TWO.exec(lines[i]);
    if (!e) throw fail(`an earnings line wasn't readable ("${lines[i].slice(0, 40)}")`);
    earnings.push(cents(e[3]));
  }
  if (earnings.length && earnings.reduce((a, b) => a + b, 0) !== gross) throw fail("the earnings lines don't add up to the gross pay");
  // 2. Employee taxes … until their total (a line with only an amount).
  const p: SummaryPayDate = { checkDate, frequency, hours, grossCents: gross, federalWhCents: 0, socialSecurityCents: 0, medicareCents: 0, stateWhCents: 0, otherEmployeeTaxCents: 0, deductionsCents: 0, netPayCents: 0, employerTaxCents: 0 };
  let taxSum = 0, taxTotal: number | null = null;
  for (; i < lines.length; i++) {
    const only = ONLY_AMT.exec(lines[i]);
    if (only) { taxTotal = cents(only[1]); i++; break; }
    if (NET_LINE.test(lines[i])) break;
    const t = DESC_AMT.exec(lines[i]);
    if (!t) throw fail(`a tax line wasn't readable ("${lines[i].slice(0, 40)}")`);
    p[taxKind(t[1])] += cents(t[2]);
    taxSum += cents(t[2]);
  }
  if (taxTotal != null && taxTotal !== taxSum) throw fail("the employee tax lines don't add up to their total");
  // 3. Deductions (optional) … until their total, then the net pay line.
  let dedSum = 0;
  for (; i < lines.length && !NET_LINE.test(lines[i]); i++) {
    const only = ONLY_AMT.exec(lines[i]);
    if (only) { if (cents(only[1]) !== dedSum) throw fail("the deduction lines don't add up to their total"); continue; }
    const t = DESC_AMT.exec(lines[i]);
    if (!t) throw fail(`a deduction line wasn't readable ("${lines[i].slice(0, 40)}")`);
    dedSum += cents(t[2]);
  }
  p.deductionsCents = dedSum;
  // 4. Net pay with the first employer line, more employer lines, then the employer total.
  const net = NET_LINE.exec(lines[i] ?? "");
  if (net) {
    p.netPayCents = cents(net[1]);
    let er = cents(net[3]);
    let erTotal: number | null = null;
    for (i++; i < lines.length; i++) {
      const only = ONLY_AMT.exec(lines[i]);
      if (only) { erTotal = cents(only[1]); break; }
      const t = DESC_AMT.exec(lines[i]);
      if (!t) break;
      er += cents(t[2]);
    }
    if (erTotal != null && erTotal !== er) throw fail("the employer tax lines don't add up to their total");
    p.employerTaxCents = er;
  } else {
    // No employer lines: the net pay is the last amount on its own.
    const only = ONLY_AMT.exec(lines[i] ?? "");
    if (!only) throw fail("the net pay wasn't found");
    p.netPayCents = cents(only[1]);
  }
  if (p.grossCents - taxSum - p.deductionsCents !== p.netPayCents) throw fail(`gross pay minus taxes and deductions (${((p.grossCents - taxSum - p.deductionsCents) / 100).toFixed(2)}) isn't the net pay (${(p.netPayCents / 100).toFixed(2)})`);
  return p;
}

/** Reads every check date in an ADP summary. Throws AdpSummaryError when anything doesn't tie out. */
export function readAdpSummary(pageLines: string[][]): SummaryPayDate[] {
  const lines = joinWrapped(pageLines.flat());
  const out: SummaryPayDate[] = [];
  let frequency: string | null = null;
  for (let i = 0; i < lines.length; i++) {
    const f = /^Pay Frequency:\s*(.+)$/i.exec(lines[i]);
    if (f) { frequency = f[1].trim(); continue; }
    const m = /^Check Date:\s*(\d{2})\/(\d{2})\/(\d{4})/i.exec(lines[i]);
    if (!m) continue;
    let j = i + 1;
    while (j < lines.length && !/^(Check Date:|Pay Frequency|Company|Year:)/i.test(lines[j])) j++;
    out.push(parseBlock(lines.slice(i + 1, j), `${m[3]}-${m[1]}-${m[2]}`, frequency));
    i = j - 1;
  }
  if (!out.length) throw new AdpSummaryError("No check dates were found in this ADP summary.");
  // The report's own month-to-date blocks must equal the check dates they cover (per pay frequency).
  for (let i = 0; i < lines.length; i++) {
    const mtd = /^Pay Frequency Month To Date \([^)]*\):\s*(.+)$/i.exec(lines[i]);
    if (!mtd) continue;
    const freq = mtd[1].trim();
    let k = i + 1;
    for (; k < lines.length && !TWO_AMT.test(lines[k]); k++);
    const tot = TWO_AMT.exec(lines[k] ?? "");
    const sum = out.filter((p) => p.frequency === freq).reduce((n, p) => n + p.grossCents, 0);
    if (tot && cents(tot[2]) !== sum) throw new AdpSummaryError(`The ${freq} check dates add up to ${(sum / 100).toFixed(2)} gross, but the report's month-to-date shows ${(cents(tot[2]) / 100).toFixed(2)}. Export the report again; nothing was imported.`);
  }
  return out;
}
