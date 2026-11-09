import { FIELDS, type FormCode } from "./line-map";
import { readForm, type Reading } from "./read-lines";

/**
 * Splits a prepared-return PDF (as page texts) into the forms it contains
 * and reads each one: line amounts, names, filing status, dependents,
 * direct deposit and the tax year. Pure — no database, no network, no AI.
 */

export type PageText = { page: number; text: string };

export const FILING_STATUS_TEXT: { code: "SINGLE" | "MFJ" | "MFS" | "HOH" | "QSS"; re: RegExp }[] = [
  { code: "SINGLE", re: /single/i },
  { code: "MFJ", re: /married\s*filing\s*jointly/i },
  { code: "MFS", re: /married\s*filing\s*separately(?:\s*\(MFS\))?/i },
  { code: "HOH", re: /head\s*of\s*household(?:\s*\(HOH\))?/i },
  { code: "QSS", re: /qualifying\s*surviving\s*spouse(?:\s*\(QSS\))?/i },
];

export type Person = { first: string; last: string };
export type Dependent = { name: string; relationship: string; birthYear: number | null };

export type ParsedReturn = {
  readable: boolean;
  pages: number;
  /** Pages found for each supported form. */
  forms: Partial<Record<FormCode, number[]>>;
  /** Each supported form's printed tax year(s). */
  years: Partial<Record<FormCode, number[]>>;
  readings: Record<string, Reading>;
  taxpayer: Person | null;
  spouse: Person | null;
  alTaxpayer: Person | null;
  filingStatus: { code: string | null; note?: string };
  dependents: Dependent[] | null;
  dependentsNote?: string;
  deposit: { routingLast4: string | null; accountLast4: string | null; type: "CHECKING" | "SAVINGS" | null } | null;
  /** Business returns (phase 2) and other returns this summary doesn't handle. */
  businessReturn: string | null;
  unsupported: string[];
  /** More than one Form 1040 first page: possibly two people's returns in one file. */
  multipleReturns: boolean;
  /** Names printed on a Form 8879 in the file (signed e-file authorization). */
  form8879: { taxpayer: Person | null; spouse: Person | null } | null;
  /** An Alabama e-file authorization/declaration page is in the file. */
  alabamaEfile: boolean;
};

const BUSINESS: { form: string; re: RegExp }[] = [
  { form: "1120-S", re: /form\s*1120[-—–]?S\b|U\.?S\.?\s*Income\s*Tax\s*Return\s*for\s*an\s*S\s*Corporation/i },
  { form: "1065", re: /form\s*1065\b|U\.?S\.?\s*Return\s*of\s*Partnership\s*Income/i },
  { form: "1120", re: /form\s*1120\b(?![-—–]?S)|U\.?S\.?\s*Corporation\s*Income\s*Tax\s*Return/i },
];

const CHECK = String.raw`(?:\[\s*[xX✓✔]\s*\]|[☒☑✔✓■]|\bX\b)`;

/** Which supported form a page belongs to (null = worksheet, 8879, statement… — not read). */
export function classifyPage(text: string): { form: FormCode | null; business?: string; unsupported?: string; firstPage?: boolean; alabamaEfile?: boolean } {
  const head = text.slice(0, 400);
  // Form titles are at the top of the page; later lines mention other forms ("from Schedule A").
  const top = (text.split("\n")[0] ?? "").slice(0, 200);
  for (const b of BUSINESS) if (b.re.test(head)) return { form: null, business: b.form };
  if (/form\s*8879\b|IRS\s*e-file\s*signature\s*authorization/i.test(top)) return { form: "F8879" };
  if (/alabama/i.test(head) && /(?:e-?file|electronic\s*filing)\s*(?:signature\s*)?(?:authorization|declaration)/i.test(head)) return { form: null, alabamaEfile: true };
  if (/form\s*8453\b|form\s*40V\b|payment\s*voucher/i.test(head)) return { form: null };
  if (/schedule\s*8812\b/i.test(top)) return { form: "S8812" };
  if (/schedule\s*A\b/i.test(top) && /alabama/i.test(top)) return { form: "ALSA" };
  if (/schedule\s*A\b/i.test(top) && /itemized\s*deductions/i.test(top)) return { form: "SA" };
  if (/schedule\s*1\b/i.test(top) && /additional\s*income\s*and\s*adjustments/i.test(top)) return { form: "S1" };
  if (/schedule\s*2\b/i.test(top) && /additional\s*taxes/i.test(top)) return { form: "S2" };
  if (/schedule\s*3\b/i.test(top) && /additional\s*credits\s*and\s*payments/i.test(top)) return { form: "S3" };
  if (/alabama/i.test(head) && /form\s*40\s*NR\b|nonresident/i.test(head)) return { form: null, unsupported: "Alabama Form 40NR" };
  if (/alabama/i.test(head) && /form\s*40\b(?!\s*[AV]\b)/i.test(head)) return { form: "AL40", firstPage: /individual\s*income\s*tax\s*return/i.test(head) };
  if (/form\s*1040[-—–]?NR\b/i.test(head)) return { form: null, unsupported: "Form 1040-NR" };
  if (/form\s*1040[-—–]?X\b|amended\s*U\.?S\.?\s*individual/i.test(head)) return { form: null, unsupported: "Form 1040-X" };
  if (/form\s*1040\b/i.test(head) && /individual\s*income\s*tax\s*return/i.test(head)) return { form: "F1040", firstPage: true };
  if (/form\s*1040\s*(?:\(20\d\d\))?\s*page\s*2/i.test(head)) return { form: "F1040" };
  return { form: null };
}

function yearsIn(head: string) {
  return [...new Set([...head.matchAll(/(?<![\d,$.])(20\d\d)(?![\d,])/g)].map((m) => Number(m[1])))];
}

const NAME = String.raw`([A-Za-z][A-Za-z'’.\-]*(?:\s+[A-Za-z][A-Za-z'’.\-]*)*?)`;

function readPerson(text: string, firstLabel: RegExp, lastLabel = /last\s*name/i): Person | null {
  const m = firstLabel.exec(text);
  if (!m) return null;
  const rest = text.slice(m.index + m[0].length);
  const line = rest.split("\n")[0] ?? "";
  // Layout 1: "<first label> Jordan  Last name Sample" on one line.
  const inline = new RegExp(String.raw`^\s*:?\s*${NAME}\s+${lastLabel.source}\s*:?\s*${NAME}\s*(?:$|\s{2,}|(?:your|spouse|social|\d))`, "i").exec(line);
  if (inline && inline[1] && inline[2]) return { first: inline[1].trim(), last: inline[2].trim() };
  // Layout 2: the label row, then the values row: "Jordan A  Sample  123-45-6789".
  const headerRow = new RegExp(String.raw`^\s*${lastLabel.source}`, "i").test(line);
  if (headerRow) {
    const values = (rest.split("\n")[1] ?? "").replace(/\b\d{3}-\d{2}-\d{4}\b|XXX-XX-\d{4}/gi, "").trim();
    const parts = values.split(/\s{2,}|\t/).filter(Boolean);
    if (parts.length >= 2) return { first: parts[0].trim(), last: parts[1].trim() };
  }
  return null;
}

/** "Taxpayer's name Jordan A Sample Social security number …" → first and last name. */
function readFullName(text: string, label: RegExp): Person | null {
  const m = label.exec(text);
  if (!m) return null;
  const line = (text.slice(m.index + m[0].length).split("\n")[0] ?? "").replace(/^\s*:?\s*/, "");
  const name = line.split(/\s*(?:social\s*security|\b(?:\d{3}|XXX)-(?:\d{2}|XX)-\d{4}\b|spouse['’]?s\s*name)/i)[0]?.trim() ?? "";
  if (!/^[A-Za-z][A-Za-z'’.\- ]+$/.test(name)) return null;
  const parts = name.split(/\s+/);
  if (parts.length < 2) return null;
  return { first: parts[0], last: parts[parts.length - 1] };
}

function readFilingStatus(text: string): { code: string | null; note?: string } {
  const start = /filing\s*status/i.exec(text);
  if (!start) return { code: null, note: "The filing status section wasn't found." };
  const block = text.slice(start.index, start.index + 600);
  const checked = FILING_STATUS_TEXT.filter((s) => new RegExp(`${CHECK}\\s*${s.re.source}`, "i").test(block));
  if (checked.length === 1) return { code: checked[0].code };
  if (!checked.length) return { code: null, note: "No filing status box is checked." };
  return { code: null, note: "More than one filing status box is checked." };
}

const SSN = /\b(?:\d{3}|XXX)-(?:\d{2}|XX)-\d{4}\b/i;

function readDependents(text: string): { list: Dependent[] | null; note?: string } {
  const start = /\bdependents\b[^\n]*\n/i.exec(text);
  if (!start) return { list: null, note: "The dependents section wasn't found." };
  const after = text.slice(start.index + start[0].length);
  const end = /^\s*(?:income\b|1a\b)/im.exec(after);
  const block = end ? after.slice(0, end.index) : after.slice(0, 1200);
  const list: Dependent[] = [];
  for (const line of block.split("\n")) {
    const s = SSN.exec(line);
    if (!s) continue;
    const name = line.slice(0, s.index).replace(/^\s*(?:\(\d\)|dependent\s*\d*:?)\s*/i, "").trim();
    const relationship = (line.slice(s.index + s[0].length).split(/\s{2,}|\[|☐|☒|\bX\b|date\s*of\s*birth|\bDOB\b|\bborn\b/i)[0] ?? "").trim();
    const dob = /(?:date\s*of\s*birth|born|DOB)\s*:?\s*(\d{1,2})\/(\d{1,2})\/(\d{4})/i.exec(line);
    if (!name || !/^[A-Za-z][A-Za-z'’.\- ]+$/.test(name)) return { list: null, note: `A dependent's name couldn't be read (“${line.replace(SSN, "XXX-XX-XXXX").trim().slice(0, 60)}”).` };
    list.push({ name, relationship, birthYear: dob ? Number(dob[3]) : null });
  }
  return { list };
}

function readDeposit(text: string): ParsedReturn["deposit"] {
  const routing = /routing\s*number[^\d\n]{0,30}(\d{9})\b/i.exec(text);
  const account = /account\s*number[^\d\n]{0,30}(\d{4,17})\b/i.exec(text);
  if (!routing && !account) return null;
  const checking = new RegExp(`${CHECK}\\s*checking`, "i").test(text);
  const savings = new RegExp(`${CHECK}\\s*savings`, "i").test(text);
  return { routingLast4: routing ? routing[1].slice(-4) : null, accountLast4: account ? account[1].slice(-4) : null, type: checking === savings ? null : checking ? "CHECKING" : "SAVINGS" };
}

export function parseReturnPages(pages: PageText[]): ParsedReturn {
  const chars = pages.reduce((n, p) => n + p.text.replace(/\s/g, "").length, 0);
  const res: ParsedReturn = {
    readable: pages.length > 0 && chars >= Math.max(40, pages.length * 25),
    pages: pages.length, forms: {}, years: {}, readings: {}, taxpayer: null, spouse: null, alTaxpayer: null,
    filingStatus: { code: null }, dependents: null, deposit: null, businessReturn: null, unsupported: [], multipleReturns: false,
    form8879: null, alabamaEfile: false,
  };
  if (!res.readable) return res;
  const byForm: Partial<Record<FormCode, string[]>> = {};
  let firstPages = 0;
  for (const p of pages) {
    const c = classifyPage(p.text);
    if (c.business && !res.businessReturn) res.businessReturn = c.business;
    if (c.unsupported && !res.unsupported.includes(c.unsupported)) res.unsupported.push(c.unsupported);
    if (c.alabamaEfile) res.alabamaEfile = true;
    if (!c.form) continue;
    (res.forms[c.form] ??= []).push(p.page);
    (byForm[c.form] ??= []).push(p.text);
    if (c.form === "F1040" && c.firstPage) firstPages++;
    const ys = yearsIn(p.text.slice(0, 300));
    if (ys.length) res.years[c.form] = [...new Set([...(res.years[c.form] ?? []), ...ys])];
  }
  res.multipleReturns = firstPages > 1;
  for (const form of Object.keys(byForm) as FormCode[]) Object.assign(res.readings, readForm(byForm[form]!.join("\n"), form));
  for (const f of FIELDS) if (!res.readings[f.id]) res.readings[f.id] = { status: "missing" };
  const f1040 = byForm.F1040?.join("\n") ?? "";
  if (f1040) {
    res.taxpayer = readPerson(f1040, /your\s*first\s*name\s*and\s*middle\s*initial/i);
    res.spouse = readPerson(f1040, /if\s*joint\s*return,?\s*spouse['’]?s\s*first\s*name\s*and\s*middle\s*initial/i);
    res.filingStatus = readFilingStatus(f1040);
    const deps = readDependents(f1040);
    res.dependents = deps.list;
    res.dependentsNote = deps.note;
    res.deposit = readDeposit(f1040);
  }
  const e = byForm.F8879?.join("\n") ?? "";
  if (e) res.form8879 = { taxpayer: readFullName(e, /taxpayer['’]?s\s*name/i), spouse: readFullName(e, /spouse['’]?s\s*name/i) };
  const al = byForm.AL40?.join("\n") ?? "";
  if (al) res.alTaxpayer = readPerson(al, /your\s*first\s*name(?:\s*and\s*initial)?/i);
  return res;
}

export async function pdfToPages(bytes: Uint8Array): Promise<PageText[] | null> {
  try {
    const { getDocumentProxy, extractText } = await import("unpdf");
    const pdf = await getDocumentProxy(new Uint8Array(bytes));
    const { text } = await extractText(pdf, { mergePages: false });
    return (text as string[]).map((t, i) => ({ page: i + 1, text: t }));
  } catch {
    return null;
  }
}
