/**
 * Reads the monthly Profit & Loss table from a completed financial package (PDF text lines):
 *
 *   Jan Feb Mar ... Sep YTD
 *   REVENUE
 *   Commission Income — Example 33,744.11 23,513.89 ... 273,328.98
 *   OPERATING EXPENSES
 *   Payroll — Gross Wages 12,665.06 ... 122,404.45
 *   Total Operating Expenses ...
 *
 * Dashes are zero; (1,234.56) is negative. Totals, subtotals and net lines are skipped. Nothing is
 * guessed: a line whose numbers don't match the month columns is left out and reported.
 */

const MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];

export type PackageLine = { section: "INCOME" | "EXPENSE"; label: string; amounts: number[] };
export type PackageTable = { months: string[]; lines: PackageLine[]; skipped: string[] };

const NUM = /^(?:\(?-?\$?[\d,]+\.\d{2}\)?|—|–|-)$/;
const cents = (t: string) => {
  if (/^[—–-]$/.test(t)) return 0;
  const neg = /^\(.*\)$/.test(t) || t.startsWith("-");
  const v = Math.round(Number(t.replace(/[()$,-]/g, "")) * 100);
  return neg ? -v : v;
};

export function readPackageTable(lines: string[]): PackageTable | null {
  // The month header: month abbreviations in calendar order, optionally followed by YTD / Total.
  let start = -1;
  let monthNums: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    const toks = lines[i].trim().split(/\s+/).map((t) => t.toUpperCase());
    const ms = toks.filter((t) => MONTHS.includes(t.slice(0, 3)) && t.length <= 4);
    if (ms.length >= 2 && ms.length >= toks.length - 1 && /PROFIT|LOSS|INCOME|P&L/i.test(lines.slice(Math.max(0, i - 3), i).join(" "))) {
      start = i;
      monthNums = ms.map((t) => MONTHS.indexOf(t.slice(0, 3)) + 1);
      break;
    }
  }
  if (start < 0) return null;
  const head = lines.slice(Math.max(0, start - 3), start + 1).join(" ");
  const years = [...head.matchAll(/\b(20\d{2})\b/g)].map((m) => Number(m[1]));
  const year = years.length ? years[years.length - 1] : null;
  if (!year) return null;
  const months = monthNums.map((m) => `${year}-${String(m).padStart(2, "0")}`);
  const n = months.length;

  const out: PackageLine[] = [];
  const skipped: string[] = [];
  let section: "INCOME" | "EXPENSE" | null = null;
  for (const raw of lines.slice(start + 1)) {
    const line = raw.trim();
    if (!line) continue;
    if (/^(BALANCE SHEET|NOTES|STATEMENT OF CASH)/i.test(line)) break;
    if (/^(REVENUE|INCOME|SALES)\b/i.test(line) && !/\d/.test(line)) { section = "INCOME"; continue; }
    if (/EXPENSES?$/i.test(line) && !/\d/.test(line)) { section = "EXPENSE"; continue; }
    if (/^(COST OF (GOODS|SALES))/i.test(line) && !/\d/.test(line)) { section = "EXPENSE"; continue; }
    if (/^NET\b/i.test(line) && !/\d/.test(line)) { section = null; continue; }
    const toks = line.split(/\s+/);
    let k = toks.length;
    while (k > 0 && NUM.test(toks[k - 1])) k--;
    const nums = toks.slice(k);
    const label = toks.slice(0, k).join(" ").trim();
    if (!label || nums.length < n) continue;
    if (/^(TOTAL|NET|GROSS PROFIT|SUBTOTAL)\b/i.test(label)) continue;
    if (!section) continue;
    if (nums.length !== n && nums.length !== n + 1) { skipped.push(label); continue; }
    out.push({ section, label: label.slice(0, 120), amounts: nums.slice(0, n).map(cents) });
  }
  return out.length ? { months, lines: out, skipped } : null;
}
