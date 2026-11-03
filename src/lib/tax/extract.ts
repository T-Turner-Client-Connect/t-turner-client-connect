/**
 * Reads tax figures from TEXT-BASED PDFs (TaxAct prints and many payer
 * PDFs). Everything returned is a proposal for staff to verify — never a
 * final figure:
 * - scanned/photographed PDFs have no text layer and are reported as
 *   unreadable (no OCR, no guessing);
 * - a value is only taken when a recognizable label is followed by a
 *   dollar amount; otherwise the field is left out and the item is flagged;
 * - full SSNs and account numbers are never returned: last four only, and
 *   evidence text is masked.
 */

export type Amount = { key: string; label: string; cents: number };
export type ExtractedItem = { formType: string; section: Section; payerName: string; amounts: Amount[]; page: number; evidence: string; incomplete: string[] };
export type Section = "INCOME" | "ADJUSTMENT" | "DEDUCTION" | "CREDIT" | "PAYMENT" | "OTHER";
export type PageText = { page: number; text: string };
export type ExtractResult = {
  readable: boolean;
  reason?: string;
  pages: number;
  items: ExtractedItem[];
  // Form 1040 lines found (cents), keyed by RETURN_LINES keys.
  returnLines: Record<string, number>;
  isPreparedReturn: boolean;
  ssnLast4: string[];
  deposit: { routingLast4: string | null; accountLast4: string | null } | null;
  unrecognizedPages: number[];
  // Forms that list each payer on the return itself (so a missing payer can be detected).
  detailForms: string[];
};

// --- Masking -------------------------------------------------------------------------

export function maskSensitive(text: string) {
  return text
    .replace(/\b(\d{3})[- ]?(\d{2})[- ]?(\d{4})\b/g, (_m, _a, _b, c) => `XXX-XX-${c}`)
    .replace(/\b\d{5,13}(\d{4})\b/g, (_m, last) => `••••${last}`);
}

// --- Amount parsing ------------------------------------------------------------------

const MONEY = /\(?-?\$?\s?(\d{1,3}(?:,\d{3})+(?:\.\d{0,2})?|\d+\.\d{0,2}|\d{4,}(?:\.\d{0,2})?)\)?/;

/** "52,340." → 5234000; "(1,200.00)" → -120000. Small bare integers are refused (they are usually line or box numbers). */
export function parseMoney(raw: string): number | null {
  const m = MONEY.exec(raw);
  if (!m) return null;
  const neg = /^\(|^-/.test(m[0].trim());
  const n = Number(m[1].replace(/,/g, "").replace(/\.$/, ""));
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 100) * (neg ? -1 : 1);
}

/**
 * The amount for a label: the LAST dollar amount on the rest of the label's
 * line (amounts sit at the end of the line; this skips form numbers such as
 * "Form 8888" mid-sentence), else the first amount on the next line.
 */
function amountAfter(text: string, label: RegExp, window = 160): { cents: number; snippet: string } | null {
  const m = label.exec(text);
  if (!m) return null;
  const start = m.index + m[0].length;
  const after = text.slice(start, start + window);
  const nl = after.indexOf("\n");
  const sameLine = nl === -1 ? after : after.slice(0, nl);
  const all = [...sameLine.matchAll(new RegExp(MONEY.source, "g"))].filter((v) => !/^\s*(?:is|are|was)\b/i.test(sameLine.slice((v.index ?? 0) + v[0].length)));
  let pick: { text: string; end: number } | null = all.length ? { text: all[all.length - 1][0], end: (all[all.length - 1].index ?? 0) + all[all.length - 1][0].length } : null;
  if (!pick && nl !== -1) {
    const next = after.slice(nl + 1).split("\n")[0] ?? "";
    const v = MONEY.exec(next);
    if (v && v.index < 3) pick = { text: v[0], end: nl + 1 + v.index + v[0].length };
  }
  if (!pick) return null;
  const cents = parseMoney(pick.text);
  if (cents === null) return null;
  return { cents, snippet: maskSensitive(text.slice(m.index, start + pick.end)).replace(/\s+/g, " ").trim() };
}

function nameAfter(text: string, label: RegExp): string | null {
  const m = label.exec(text);
  if (!m) return null;
  const rest = text.slice(m.index + m[0].length).replace(/^[\s:,.-]+/, "");
  const line = rest.split(/\n/)[0] ?? "";
  const name = line.replace(/\s{2,}.*$/, "").replace(/[\d$].*$/, "").trim();
  return name.length >= 2 && name.length <= 80 ? name : null;
}

// --- Source-document forms -------------------------------------------------------------

type FieldSpec = { key: string; label: string; re: RegExp; required?: boolean };
type FormSpec = { formType: string; section: Section; detect: RegExp; payer: RegExp; fields: FieldSpec[] };

const FORMS: FormSpec[] = [
  {
    formType: "W-2", section: "INCOME", detect: /\bW-2\b[\s\S]{0,80}wage and tax statement|wage and tax statement/i, payer: /employer'?s name(?:, address,? and ZIP code)?/i,
    fields: [
      { key: "wages", label: "Wages (box 1)", re: /wages, tips,? other comp(?:ensation|\.)?/i, required: true },
      { key: "fedWithheld", label: "Federal income tax withheld (box 2)", re: /federal income tax withheld/i, required: true },
      { key: "ssWages", label: "Social security wages (box 3)", re: /social security wages/i },
      { key: "stateWages", label: "State wages (box 16)", re: /state wages,? tips,? etc/i },
      { key: "stateWithheld", label: "State income tax (box 17)", re: /state income tax/i },
    ],
  },
  {
    formType: "1099-R", section: "INCOME", detect: /1099-R\b|distributions from pensions/i, payer: /payer'?s name(?:, street address[^\n]*)?/i,
    fields: [
      { key: "gross", label: "Gross distribution (box 1)", re: /gross distribution/i, required: true },
      { key: "taxable", label: "Taxable amount (box 2a)", re: /taxable amount/i, required: true },
      { key: "fedWithheld", label: "Federal income tax withheld (box 4)", re: /federal income tax withheld/i },
    ],
  },
  {
    formType: "1099-NEC", section: "INCOME", detect: /1099-NEC\b|nonemployee compensation/i, payer: /payer'?s name(?:, street address[^\n]*)?/i,
    fields: [
      { key: "nec", label: "Nonemployee compensation (box 1)", re: /nonemployee compensation/i, required: true },
      { key: "fedWithheld", label: "Federal income tax withheld (box 4)", re: /federal income tax withheld/i },
    ],
  },
  {
    formType: "1099-MISC", section: "INCOME", detect: /1099-MISC\b|miscellaneous (?:information|income)/i, payer: /payer'?s name(?:, street address[^\n]*)?/i,
    fields: [
      { key: "rents", label: "Rents (box 1)", re: /\brents\b/i },
      { key: "royalties", label: "Royalties (box 2)", re: /royalties/i },
      { key: "other", label: "Other income (box 3)", re: /other income/i },
      { key: "fedWithheld", label: "Federal income tax withheld (box 4)", re: /federal income tax withheld/i },
    ],
  },
  {
    formType: "1099-INT", section: "INCOME", detect: /1099-INT\b|interest income/i, payer: /payer'?s name(?:, street address[^\n]*)?/i,
    fields: [
      { key: "interest", label: "Interest income (box 1)", re: /interest income/i, required: true },
      { key: "fedWithheld", label: "Federal income tax withheld (box 4)", re: /federal income tax withheld/i },
    ],
  },
  {
    formType: "1099-DIV", section: "INCOME", detect: /1099-DIV\b|dividends and distributions/i, payer: /payer'?s name(?:, street address[^\n]*)?/i,
    fields: [
      { key: "ordinary", label: "Total ordinary dividends (box 1a)", re: /total ordinary dividends/i, required: true },
      { key: "qualified", label: "Qualified dividends (box 1b)", re: /qualified dividends/i },
      { key: "capGain", label: "Capital gain distributions (box 2a)", re: /total capital gain distr/i },
      { key: "fedWithheld", label: "Federal income tax withheld (box 4)", re: /federal income tax withheld/i },
    ],
  },
  {
    formType: "1099-K", section: "INCOME", detect: /1099-K\b|payment card and third party network/i, payer: /(?:filer|payer)'?s name/i,
    fields: [{ key: "gross", label: "Gross amount (box 1a)", re: /gross amount of payment/i, required: true }],
  },
  {
    formType: "1099-G", section: "INCOME", detect: /1099-G\b|certain government payments/i, payer: /payer'?s name(?:, street address[^\n]*)?/i,
    fields: [
      { key: "unemployment", label: "Unemployment compensation (box 1)", re: /unemployment compensation/i },
      { key: "stateRefund", label: "State or local income tax refund (box 2)", re: /state or local income tax refunds?/i },
      { key: "fedWithheld", label: "Federal income tax withheld (box 4)", re: /federal income tax withheld/i },
    ],
  },
  {
    formType: "SSA-1099", section: "INCOME", detect: /SSA-1099|social security benefit statement/i, payer: /^(?!)/,
    fields: [
      { key: "netBenefits", label: "Net benefits (box 5)", re: /net benefits for/i, required: true },
      { key: "fedWithheld", label: "Voluntary federal income tax withheld (box 6)", re: /voluntary federal income tax withheld/i },
    ],
  },
  {
    formType: "1098", section: "DEDUCTION", detect: /\b1098\b[\s\S]{0,60}mortgage interest statement|mortgage interest statement/i, payer: /recipient'?s\/lender'?s name|lender'?s name/i,
    fields: [
      { key: "mortgageInterest", label: "Mortgage interest (box 1)", re: /mortgage interest received/i, required: true },
      { key: "points", label: "Points paid (box 6)", re: /points paid/i },
      { key: "propertyTax", label: "Property tax (box 10 / other)", re: /(?:real estate|property) tax/i },
    ],
  },
  {
    formType: "1098-T", section: "CREDIT", detect: /1098-T\b|tuition statement/i, payer: /filer'?s name/i,
    fields: [
      { key: "tuition", label: "Payments received for qualified tuition (box 1)", re: /payments received for qualified tuition/i, required: true },
      { key: "scholarships", label: "Scholarships or grants (box 5)", re: /scholarships or grants/i },
    ],
  },
  {
    formType: "1098-E", section: "ADJUSTMENT", detect: /1098-E\b|student loan interest statement/i, payer: /recipient'?s name|lender'?s name/i,
    fields: [{ key: "studentLoanInterest", label: "Student loan interest (box 1)", re: /student loan interest received/i, required: true }],
  },
];

const SCHEDULE_C: FormSpec = {
  formType: "SCH-C", section: "INCOME", detect: /SCHEDULE C\b[\s\S]{0,80}profit or loss from business/i, payer: /name of proprietor|business name/i,
  fields: [
    { key: "grossReceipts", label: "Gross receipts (line 1)", re: /gross receipts or sales/i, required: true },
    { key: "expenses", label: "Total expenses (line 28)", re: /total expenses before expenses for business use/i },
    { key: "netProfit", label: "Net profit or loss (line 31)", re: /net profit or \(loss\)/i, required: true },
  ],
};

function extractForm(spec: FormSpec, p: PageText): ExtractedItem {
  const amounts: Amount[] = [];
  const incomplete: string[] = [];
  const snippets: string[] = [];
  for (const f of spec.fields) {
    const a = amountAfter(p.text, f.re);
    if (a) {
      amounts.push({ key: f.key, label: f.label, cents: a.cents });
      snippets.push(a.snippet);
    } else if (f.required) incomplete.push(f.label);
  }
  const bizName = spec.formType === "SCH-C" ? nameAfter(p.text, /business name/i) ?? nameAfter(p.text, /principal business or profession/i) : null;
  const payerName = bizName ?? nameAfter(p.text, spec.payer) ?? (spec.formType === "SSA-1099" ? "Social Security Administration" : "");
  if (!payerName) incomplete.push("Payer / employer name");
  return { formType: spec.formType, section: spec.section, payerName: payerName || "Unknown payer", amounts, page: p.page, evidence: snippets.join(" | ").slice(0, 600), incomplete };
}

// --- Form 1040 lines and Schedule B payer detail ----------------------------------------

export const RETURN_LINES: { key: string; label: string; re: RegExp }[] = [
  { key: "wages", label: "Wages (1040 line 1z)", re: /add lines 1a through 1h/i },
  { key: "w2Wages", label: "W-2 wages (1040 line 1a)", re: /total amount from form\(?s\)? W-2,? box 1/i },
  { key: "taxableInterest", label: "Taxable interest (line 2b)", re: /(?:2b|\bb)\s+taxable interest/i },
  { key: "ordinaryDividends", label: "Ordinary dividends (line 3b)", re: /(?:3b|\bb)\s+ordinary dividends/i },
  { key: "iraTaxable", label: "IRA distributions, taxable (line 4b)", re: /4b\s+taxable amount|IRA distributions[\s\S]{0,40}?\bb\s+taxable amount/i },
  { key: "pensionsTaxable", label: "Pensions and annuities, taxable (line 5b)", re: /5b\s+taxable amount|pensions and annuities[\s\S]{0,40}?\bb\s+taxable amount/i },
  { key: "ssTaxable", label: "Social security benefits, taxable (line 6b)", re: /6b\s+taxable amount|social security benefits[\s\S]{0,40}?\bb\s+taxable amount/i },
  { key: "capitalGain", label: "Capital gain or (loss) (line 7)", re: /capital gain or \(loss\)/i },
  { key: "additionalIncome", label: "Additional income from Schedule 1 (line 8)", re: /additional income from schedule 1/i },
  { key: "totalIncome", label: "Total income (line 9)", re: /this is your total income/i },
  { key: "adjustments", label: "Adjustments to income (line 10)", re: /adjustments to income from schedule 1/i },
  { key: "agi", label: "Adjusted gross income (line 11)", re: /this is your adjusted gross income/i },
  { key: "deduction", label: "Standard or itemized deduction (line 12)", re: /standard deduction or itemized deductions/i },
  { key: "taxableIncome", label: "Taxable income (line 15)", re: /this is your taxable income/i },
  { key: "childTaxCredit", label: "Child tax credit / credit for other dependents (line 19)", re: /child tax credit or credit for other dependents/i },
  { key: "totalTax", label: "Total tax (line 24)", re: /this is your total tax/i },
  { key: "w2Withholding", label: "Federal withholding — W-2s (line 25a)", re: /(?:25a|\ba)\s+form\(?s\)?\s+W-2\b/i },
  { key: "form1099Withholding", label: "Federal withholding — 1099s (line 25b)", re: /(?:25b|\bb)\s+form\(?s\)?\s+1099\b/i },
  { key: "eic", label: "Earned income credit (line 27)", re: /earned income credit \(EIC\)/i },
  { key: "refund", label: "Refund (line 35a)", re: /amount of line 34 you want refunded to you/i },
  { key: "owed", label: "Amount you owe (line 37)", re: /this is the amount you owe/i },
];

function scheduleBPayers(p: PageText, part: "interest" | "dividends"): ExtractedItem[] {
  // Payer lines look like "Name of payer   1,234." between the Part header and the total line.
  const start = part === "interest" ? /part i\b[\s\S]{0,40}interest/i : /part ii\b[\s\S]{0,40}ordinary dividends/i;
  const end = part === "interest" ? /add the amounts on line 1|part ii\b/i : /add the amounts on line 5|part iii\b/i;
  const s = start.exec(p.text);
  if (!s) return [];
  const body = p.text.slice(s.index + s[0].length);
  const e = end.exec(body);
  const block = e ? body.slice(0, e.index) : body.slice(0, 1500);
  const out: ExtractedItem[] = [];
  for (const line of block.split(/\n/)) {
    const m = /^\s*([A-Za-z][A-Za-z0-9&.,'\- ]{2,60}?)\s{1,}(\(?\$?\d{1,3}(?:,\d{3})*(?:\.\d{0,2})?\)?)\s*$/.exec(line);
    if (!m || /list name of payer|see instructions|note:/i.test(m[1])) continue;
    const cents = parseMoney(m[2].includes(".") || m[2].includes(",") ? m[2] : `${m[2]}.`);
    if (cents === null) continue;
    const formType = part === "interest" ? "1099-INT" : "1099-DIV";
    const key = part === "interest" ? "interest" : "ordinary";
    out.push({ formType, section: "INCOME", payerName: m[1].trim(), amounts: [{ key, label: part === "interest" ? "Interest (Schedule B Part I)" : "Ordinary dividends (Schedule B Part II)", cents }], page: p.page, evidence: maskSensitive(line.trim()), incomplete: [] });
  }
  return out;
}

// --- Entry points --------------------------------------------------------------------

export function extractFromPages(pages: PageText[]): ExtractResult {
  const chars = pages.reduce((n, p) => n + p.text.replace(/\s/g, "").length, 0);
  const res: ExtractResult = { readable: true, pages: pages.length, items: [], returnLines: {}, isPreparedReturn: false, ssnLast4: [], deposit: null, unrecognizedPages: [], detailForms: [] };
  if (!pages.length || chars < Math.max(40, pages.length * 25)) {
    return { ...res, readable: false, reason: "No readable text — this looks like a scanned or photographed PDF. Enter the figures from the document and verify them." };
  }
  for (const p of pages) {
    let used = false;
    for (const m of p.text.matchAll(/\b\d{3}-\d{2}-(\d{4})\b/g)) if (!res.ssnLast4.includes(m[1])) res.ssnLast4.push(m[1]);
    if (/form 1040\b|U\.S\. Individual Income Tax Return/i.test(p.text) && /total income|adjusted gross income/i.test(p.text)) {
      res.isPreparedReturn = true;
      used = true;
      for (const l of RETURN_LINES) {
        if (res.returnLines[l.key] !== undefined) continue;
        const a = amountAfter(p.text, l.re, 90);
        if (a) res.returnLines[l.key] = a.cents;
      }
      const routing = /routing number[^\d]{0,30}(\d{9})/i.exec(p.text);
      const account = /account number[^\d]{0,30}(\d{4,17})/i.exec(p.text);
      if (routing || account) res.deposit = { routingLast4: routing ? routing[1].slice(-4) : null, accountLast4: account ? account[1].slice(-4) : null };
    }
    if (/SCHEDULE B\b[\s\S]{0,80}interest and ordinary dividends/i.test(p.text)) {
      used = true;
      res.isPreparedReturn = true;
      const ints = scheduleBPayers(p, "interest");
      const divs = scheduleBPayers(p, "dividends");
      res.items.push(...ints, ...divs);
      if (!res.detailForms.includes("1099-INT")) res.detailForms.push("1099-INT", "1099-DIV");
    }
    if (SCHEDULE_C.detect.test(p.text)) {
      used = true;
      res.isPreparedReturn = true;
      res.items.push(extractForm(SCHEDULE_C, p));
      if (!res.detailForms.includes("SCH-C")) res.detailForms.push("SCH-C");
    }
    if (!used) {
      const spec = FORMS.find((f) => f.detect.test(p.text));
      if (spec) {
        res.items.push(extractForm(spec, p));
        used = true;
      }
    }
    if (!used) res.unrecognizedPages.push(p.page);
  }
  // In a prepared return, payer forms printed with it (W-2, 1099-R…) count as return detail.
  if (res.isPreparedReturn) for (const it of res.items) if (!res.detailForms.includes(it.formType)) res.detailForms.push(it.formType);
  return res;
}

export async function pdfPages(bytes: Uint8Array): Promise<PageText[] | null> {
  try {
    const { getDocumentProxy, extractText } = await import("unpdf");
    const pdf = await getDocumentProxy(new Uint8Array(bytes));
    const { text } = await extractText(pdf, { mergePages: false });
    return (text as string[]).map((t, i) => ({ page: i + 1, text: t }));
  } catch {
    return null;
  }
}

export async function extractPdf(bytes: Uint8Array): Promise<ExtractResult> {
  const pages = await pdfPages(bytes);
  if (!pages) return { readable: false, reason: "The PDF couldn't be opened (damaged or password-protected).", pages: 0, items: [], returnLines: {}, isPreparedReturn: false, ssnLast4: [], deposit: null, unrecognizedPages: [], detailForms: [] };
  return extractFromPages(pages);
}

/** Compares payer names loosely ("ACME Corp." ≈ "Acme Corporation"). */
export function samePayer(a: string, b: string) {
  const n = (s: string) => s.toLowerCase().replace(/\b(inc|llc|corp|corporation|co|company|the|na|n\.a)\b/g, "").replace(/[^a-z0-9]/g, "");
  const x = n(a), y = n(b);
  return !!x && !!y && (x === y || x.startsWith(y) || y.startsWith(x));
}
