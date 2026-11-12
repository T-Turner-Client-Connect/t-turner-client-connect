import type { PageText } from "./return-parser/parse";

/**
 * Reads WHO and WHICH YEAR a completed return is for, from the text printed inside the PDF (never
 * the file name), and compares it with the client and year staff selected. Pure: no database, no
 * network, no AI.
 *
 *   VERIFIED  — the printed name(s), year and form agree with the selection.
 *   REJECTED  — the return positively belongs to someone else, another year or another form. No
 *               override: staff correct the selection or upload the right file.
 *   UNCERTAIN — it can't be confirmed (a scan without text, a name that is close but not the same,
 *               no EIN on file…). Held for authorized review; never filed until a match is verified.
 */

export type ReturnFamily = "1040" | "1040-X" | "1065" | "1120-S" | "1120" | "1041" | "990";
export type Person = { first: string; last: string };

export type Expected = {
  taxYear: number;
  /** FEDERAL, a two-letter state code, or ANY (a tax return saved without saying which). */
  jurisdiction: string;
  filingType: "ORIGINAL" | "AMENDED";
  /** The form staff chose (1040, 1120-S, 40…), when known. */
  returnType?: string | null;
  /** Individual: the taxpayer and spouse on file (plus confirmed former/alternate names). */
  taxpayer?: Person | null;
  spouse?: Person | null;
  aliases?: Person[];
  /** Business, estate or trust: its legal name and EIN on file (EIN digits only). */
  business?: { name: string; ein: string | null } | null;
};

export type Finding = { code: string; message: string };
export type Verdict =
  | { result: "VERIFIED"; read: ReadReturn; notes: Finding[] }
  | { result: "REJECTED"; read: ReadReturn | null; reason: Finding }
  | { result: "UNCERTAIN"; read: ReadReturn | null; reasons: Finding[] };

export type ReadReturn = {
  federal: ReturnFamily | null;
  states: string[];
  amended: boolean;
  year: number | null;
  taxpayer: Person | null;
  spouse: Person | null;
  businessName: string | null;
  ein: string | null;
  text: string;
};

export const MSG = {
  WRONG_YEAR: (printed: number, selected: number) => `Upload Rejected — This document is for tax year ${printed}, but you selected ${selected}. Please select the correct year or upload the correct return.`,
  WRONG_TAXPAYER: "Upload Rejected — The taxpayer name on this return does not match the selected client. Please verify the client and upload the correct document.",
  WRONG_BUSINESS: "Upload Rejected — The business name on this return does not match the selected client. Please verify the client and upload the correct document.",
  WRONG_EIN: "Upload Rejected — The EIN on this return does not match the EIN on file for the selected client. Please verify the client and upload the correct document.",
  WRONG_SPOUSE: "Upload Rejected — The spouse named on this joint return does not match the spouse on file for the selected client. Correct the client's spouse on file, or upload the correct return.",
  WRONG_FORM: (printed: string, selected: string) => `Upload Rejected — This document is a ${printed}, but you selected ${selected}. Please select the correct return type or upload the correct return.`,
  NOT_VERIFIABLE: "Upload Not Accepted — We could not verify the taxpayer name and tax year. Please upload a clearer copy.",
};

const STATES: Record<string, string> = {
  AL: "Alabama", AK: "Alaska", AZ: "Arizona", AR: "Arkansas", CA: "California", CO: "Colorado", CT: "Connecticut", DE: "Delaware", DC: "District of Columbia",
  FL: "Florida", GA: "Georgia", HI: "Hawaii", ID: "Idaho", IL: "Illinois", IN: "Indiana", IA: "Iowa", KS: "Kansas", KY: "Kentucky", LA: "Louisiana", ME: "Maine",
  MD: "Maryland", MA: "Massachusetts", MI: "Michigan", MN: "Minnesota", MS: "Mississippi", MO: "Missouri", MT: "Montana", NE: "Nebraska", NV: "Nevada",
  NH: "New Hampshire", NJ: "New Jersey", NM: "New Mexico", NY: "New York", NC: "North Carolina", ND: "North Dakota", OH: "Ohio", OK: "Oklahoma", OR: "Oregon",
  PA: "Pennsylvania", RI: "Rhode Island", SC: "South Carolina", SD: "South Dakota", TN: "Tennessee", TX: "Texas", UT: "Utah", VT: "Vermont", VA: "Virginia",
  WA: "Washington", WV: "West Virginia", WI: "Wisconsin", WY: "Wyoming",
};

/** The federal form a page's title shows (checked in order: the longer titles first). */
const FEDERAL: { family: ReturnFamily; re: RegExp }[] = [
  { family: "1040-X", re: /form\s*1040[-—–\s]?X\b|amended\s*U\.?S\.?\s*individual\s*income\s*tax\s*return/i },
  { family: "1120-S", re: /form\s*1120[-—–\s]?S\b|U\.?S\.?\s*income\s*tax\s*return\s*for\s*an\s*S\s*corporation/i },
  { family: "1065", re: /form\s*1065\b|U\.?S\.?\s*return\s*of\s*partnership\s*income/i },
  { family: "1041", re: /form\s*1041\b|U\.?S\.?\s*income\s*tax\s*return\s*for\s*estates\s*and\s*trusts/i },
  { family: "1120", re: /form\s*1120\b(?![-—–\s]?S\b)|U\.?S\.?\s*corporation\s*income\s*tax\s*return/i },
  { family: "990", re: /form\s*990(?:[-—–\s]?(?:EZ|PF|N))?\b|return\s*of\s*organization\s*exempt\s*from\s*income\s*tax/i },
  { family: "1040", re: /form\s*1040(?:[-—–\s]?SR)?\b[\s\S]{0,120}?individual\s*income\s*tax\s*return|U\.?S\.?\s*individual\s*income\s*tax\s*return/i },
];

/** The selected return type as a family ("1120S" → "1120-S", "1040-SR" → "1040", a state form → null). */
export function familyOf(returnType: string | null | undefined, filingType: "ORIGINAL" | "AMENDED"): ReturnFamily | null {
  const t = (returnType ?? "").toUpperCase().replace(/[\s—–]/g, "").replace(/^FORM/, "");
  if (!t) return null;
  if (/^1040-?X$/.test(t)) return "1040-X";
  if (/^1040(-?SR)?$/.test(t)) return filingType === "AMENDED" ? "1040-X" : "1040";
  if (/^1120-?S$/.test(t)) return "1120-S";
  if (/^1120$/.test(t)) return "1120";
  if (/^1065$/.test(t)) return "1065";
  if (/^1041$/.test(t)) return "1041";
  if (/^990(-?(EZ|PF|N))?$/.test(t)) return "990";
  return null;
}

const norm = (s: string) => s.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
const BUSINESS_NOISE = /\b(llc|l l c|inc|incorporated|corp|corporation|co|company|ltd|pllc|pc|lp|llp|the|of|and|dba)\b/g;
const bizKey = (s: string) => norm(s).replace(BUSINESS_NOISE, " ").replace(/\s+/g, " ").trim();

/** The tax year a return is for, from the form's own header (not revision dates or later references). */
function yearFrom(page: string, family: ReturnFamily | null): number | null {
  const head = page.slice(0, 700);
  if (family === "1040-X") {
    const m = /calendar\s*year\s*(20\d\d)|tax\s*year\s*(?:ending|ended)?[^\n]{0,30}?(20\d\d)/i.exec(page);
    return m ? Number(m[1] ?? m[2]) : null;
  }
  const cal = /for\s*(?:the\s*)?calendar\s*year\s*(20\d\d)|for\s*the\s*year\s*jan\.?\s*1\s*[-–—]\s*dec\.?\s*31,?\s*(20\d\d)/i.exec(head);
  if (cal) return Number(cal[1] ?? cal[2]);
  // "Form 1040 2025", "2025 Form 40", "Form 1120-S (2025)" — skip "(Rev. …)" and catalog numbers.
  const cleaned = head.replace(/\(?rev\.?\s*[a-z]*\.?\s*20\d\d\)?/gi, " ").replace(/cat\.?\s*no\.?\s*\d+\w*/gi, " ");
  const m = /(?<![\d,$.\/-])(20\d\d)(?![\d,%])/.exec(cleaned);
  return m ? Number(m[1]) : null;
}

const NAME_TOKEN = String.raw`[A-Za-z][A-Za-z'’.\-]*`;

function personAfter(text: string, label: RegExp): Person | null {
  const m = label.exec(text);
  if (!m) return null;
  const rest = text.slice(m.index + m[0].length);
  // The name is on the label's own line or the line right below it; a later line is another field.
  for (const line of rest.split("\n").slice(0, 2)) {
    if (/filing|status|form\b|income|address|total|dependent|home|wages|street|city|apt/i.test(line)) continue;
    const clean = line
      .replace(/\b(?:\d{3}|XXX)-(?:\d{2}|XX)-\d{4}\b/gi, " ")
      .replace(/last\s*name|first\s*name|middle\s*initial|social\s*security\s*number|spouse['’]?s?/gi, " ")
      .replace(/[:|]/g, " ")
      .trim();
    const words = clean.split(/\s+/).filter((w) => new RegExp(`^${NAME_TOKEN}$`).test(w) && w.length > 1);
    if (words.length >= 2) return { first: words[0], last: words[words.length - 1] };
  }
  return null;
}

function businessNameFrom(text: string): string | null {
  const m = /(?:^|\n)\s*(?:name(?:\s*of\s*(?:estate\s*or\s*trust|partnership|corporation|organization))?)\s*:?\s*([^\n]{3,90})/i.exec(text);
  if (!m) return null;
  const v = m[1].replace(/employer\s*identification.*$/i, "").replace(/\b\d{2}-\d{7}\b.*$/, "").trim();
  return v.length >= 3 ? v : null;
}

/** Reads the identifying facts printed in a return. Null when the file has no readable text. */
export function readReturn(pages: PageText[]): ReadReturn | null {
  const text = pages.map((p) => p.text).join("\n");
  const chars = text.replace(/\s/g, "").length;
  if (!pages.length || chars < Math.max(60, pages.length * 25)) return null;
  let federal: ReturnFamily | null = null;
  let year: number | null = null;
  let amended = false;
  const states = new Set<string>();
  let stateYear: number | null = null;
  for (const p of pages) {
    const head = p.text.slice(0, 500);
    if (!federal) {
      const f = FEDERAL.find((x) => x.re.test(head));
      if (f) {
        federal = f.family;
        year = yearFrom(p.text, f.family);
      }
    }
    for (const [code, name] of Object.entries(STATES)) {
      if (new RegExp(`\\b${name}\\b`, "i").test(head) && /(income\s*tax\s*return|form\s*40\b|individual\s*income|fiduciary|corporate\s*income|business\s*privilege|partnership\s*return|composite)/i.test(head)) {
        states.add(code);
        stateYear ??= yearFrom(p.text, null);
      }
    }
    if (/\bamended\s*return\b[^\n]{0,20}(?:\[\s*[xX✓✔]\s*\]|[☒☑✔✓■]|\bX\b)|(?:\[\s*[xX✓✔]\s*\]|[☒☑✔✓■])\s*amended/i.test(head)) amended = true;
  }
  if (federal === "1040-X") amended = true;
  year ??= stateYear;
  const individual = federal === "1040" || federal === "1040-X" || (!federal && states.size > 0);
  const taxpayer = individual ? personAfter(text, /your\s*first\s*name(?:\s*and\s*(?:middle\s*)?initial)?/i) : null;
  const spouse = individual ? personAfter(text, /(?:if\s*joint\s*return,?\s*)?spouse['’]?s\s*first\s*name(?:\s*and\s*(?:middle\s*)?initial)?/i) : null;
  const businessName = federal && !individual ? businessNameFrom(text) : null;
  const ein = /employer\s*identification\s*(?:number|no\.?)[^\d\n]{0,40}(\d{2}-?\d{7})\b/i.exec(text)?.[1]?.replace(/-/g, "") ?? (federal && !individual ? /\b(\d{2}-\d{7})\b/.exec(text)?.[1]?.replace(/-/g, "") ?? null : null);
  return { federal, states: [...states], amended, year, taxpayer, spouse, businessName, ein, text };
}

type NameMatch = "SAME" | "CLOSE" | "DIFFERENT";
function compare(a: Person, b: Person): NameMatch {
  const fa = norm(a.first), fb = norm(b.first), la = norm(a.last), lb = norm(b.last);
  const lastSame = la === lb || la.split(" ").includes(lb) || lb.split(" ").includes(la) || la.replace(/ /g, "") === lb.replace(/ /g, "");
  const firstSame = fa === fb || fa.split(" ")[0] === fb.split(" ")[0];
  if (lastSame && firstSame) return "SAME";
  // A shortened first name ("Kat"/"Katherine"), an initial, or a changed last name: close, not the same.
  const firstClose = !!fa && !!fb && (fa.startsWith(fb) || fb.startsWith(fa));
  if ((lastSame && firstClose) || firstSame || lastSame) return "CLOSE";
  return "DIFFERENT";
}
const best = (p: Person, candidates: (Person | null | undefined)[]): NameMatch => {
  const r = candidates.filter((c): c is Person => !!c).map((c) => compare(p, c));
  return r.includes("SAME") ? "SAME" : r.includes("CLOSE") ? "CLOSE" : "DIFFERENT";
};

/** Searches the whole text for a person's name (forms whose name layout isn't read field by field). */
function nameInText(text: string, p: Person): NameMatch {
  const t = ` ${norm(text)} `;
  const first = ` ${norm(p.first).split(" ")[0]} `, last = ` ${norm(p.last)} `;
  const hasFirst = t.includes(first), hasLast = t.includes(last);
  return hasFirst && hasLast ? "SAME" : hasFirst || hasLast ? "CLOSE" : "DIFFERENT";
}

const LABEL: Record<ReturnFamily, string> = { "1040": "Form 1040", "1040-X": "Form 1040-X (amended)", "1065": "Form 1065", "1120-S": "Form 1120-S", "1120": "Form 1120", "1041": "Form 1041", "990": "Form 990" };

export function checkIdentity(read: ReadReturn | null, exp: Expected): Verdict {
  if (!read) return { result: "UNCERTAIN", read: null, reasons: [{ code: "UNREADABLE", message: MSG.NOT_VERIFIABLE }] };
  const uncertain: Finding[] = [];
  const notes: Finding[] = [];
  const reject = (code: string, message: string): Verdict => ({ result: "REJECTED", read, reason: { code, message } });

  // 1. The year printed on the return.
  if (read.year == null) uncertain.push({ code: "YEAR_UNREADABLE", message: MSG.NOT_VERIFIABLE });
  else if (read.year !== exp.taxYear) return reject("WRONG_YEAR", MSG.WRONG_YEAR(read.year, exp.taxYear));

  // 2. The form: federal family, state, original vs amended.
  const wanted = exp.jurisdiction === "FEDERAL" ? familyOf(exp.returnType, exp.filingType) : null;
  if (exp.jurisdiction === "ANY") {
    // Saved as a tax return without saying which one: only original vs amended is checked.
    if (read.federal === "1040-X" && exp.filingType !== "AMENDED") return reject("WRONG_FORM", MSG.WRONG_FORM(LABEL["1040-X"], "an original return"));
    if (!read.federal && !read.states.length) uncertain.push({ code: "FORM_UNREADABLE", message: "The return's form couldn't be identified." });
  } else if (exp.jurisdiction === "FEDERAL") {
    if (!read.federal) {
      if (read.states.length) return reject("WRONG_FORM", MSG.WRONG_FORM(`${STATES[read.states[0]] ?? read.states[0]} state return`, "a federal return"));
      uncertain.push({ code: "FORM_UNREADABLE", message: "The federal form couldn't be identified." });
    } else {
      const amendedSelected = exp.filingType === "AMENDED";
      if (read.federal === "1040-X" && !amendedSelected) return reject("WRONG_FORM", MSG.WRONG_FORM(LABEL["1040-X"], "an original return"));
      if (read.federal === "1040" && amendedSelected) return reject("WRONG_FORM", MSG.WRONG_FORM("Form 1040 (original)", "an amended return"));
      if (wanted && wanted !== read.federal && !(wanted === "1040" && read.federal === "1040-X")) return reject("WRONG_FORM", MSG.WRONG_FORM(LABEL[read.federal], LABEL[wanted]));
      if (!wanted && exp.business && (read.federal === "1040" || read.federal === "1040-X")) return reject("WRONG_FORM", MSG.WRONG_FORM(LABEL[read.federal], "a business, estate or trust return"));
      if (!wanted && !exp.business && exp.taxpayer && !["1040", "1040-X"].includes(read.federal)) return reject("WRONG_FORM", MSG.WRONG_FORM(LABEL[read.federal], "an individual return"));
      if (amendedSelected && !["1040-X"].includes(read.federal) && !read.amended) uncertain.push({ code: "AMENDED_UNCONFIRMED", message: "The return doesn't show that it is amended." });
    }
  } else {
    const st = exp.jurisdiction.toUpperCase();
    if (!read.states.includes(st)) {
      if (read.states.length) return reject("WRONG_FORM", MSG.WRONG_FORM(`${STATES[read.states[0]] ?? read.states[0]} state return`, `a ${STATES[st] ?? st} return`));
      if (read.federal) return reject("WRONG_FORM", MSG.WRONG_FORM(`federal ${LABEL[read.federal]}`, `a ${STATES[st] ?? st} state return`));
      uncertain.push({ code: "FORM_UNREADABLE", message: `The ${STATES[st] ?? st} return couldn't be identified.` });
    }
    if (exp.filingType === "AMENDED" && !read.amended) uncertain.push({ code: "AMENDED_UNCONFIRMED", message: "The state return doesn't show that it is amended." });
  }

  // 3. Whose return it is.
  if (exp.business) {
    const onFile = exp.business.ein?.replace(/\D/g, "") || null;
    if (read.ein && onFile && read.ein !== onFile) return reject("WRONG_EIN", MSG.WRONG_EIN);
    const nameKey = bizKey(exp.business.name);
    const printed = read.businessName ? bizKey(read.businessName) : null;
    const inText = nameKey ? ` ${bizKey(read.text)} `.includes(` ${nameKey} `) : false;
    const nameSame = !!nameKey && ((printed && (printed === nameKey || printed.includes(nameKey) || nameKey.includes(printed))) || inText);
    if (read.ein && onFile && read.ein === onFile) {
      if (!nameSame) uncertain.push({ code: "NAME_VARIATION", message: "The EIN matches, but the business name on the return differs from the name on file." });
    } else if (!nameSame) {
      return printed || read.text ? reject("WRONG_BUSINESS", MSG.WRONG_BUSINESS) : { result: "UNCERTAIN", read, reasons: [{ code: "NAME_UNREADABLE", message: MSG.NOT_VERIFIABLE }] };
    } else if (!onFile) uncertain.push({ code: "NO_EIN_ON_FILE", message: "There's no EIN on file for this client to compare with the return. Add the EIN to the client record, then upload again." });
    else if (!read.ein) uncertain.push({ code: "EIN_UNREADABLE", message: "The EIN on the return couldn't be read." });
  } else if (exp.taxpayer) {
    const people = [exp.taxpayer, ...(exp.aliases ?? [])];
    // The selected client may be listed second on a joint return.
    const primary = read.taxpayer ? best(read.taxpayer, people) : nameInText(read.text, exp.taxpayer);
    const asSpouse = read.spouse ? best(read.spouse, people) : "DIFFERENT";
    const clientMatch: NameMatch = primary === "SAME" || asSpouse === "SAME" ? "SAME" : primary === "CLOSE" || asSpouse === "CLOSE" ? "CLOSE" : "DIFFERENT";
    if (clientMatch === "DIFFERENT") return reject("WRONG_TAXPAYER", MSG.WRONG_TAXPAYER);
    if (clientMatch === "CLOSE") uncertain.push({ code: "NAME_VARIATION", message: "The name on the return is close to, but not the same as, the client's name on file (a name change, nickname or initial?)." });
    // A joint return: the other person must be the spouse on file.
    const other = asSpouse === "SAME" && primary !== "SAME" ? read.taxpayer : read.spouse;
    if (other && exp.spouse) {
      const s = compare(other, exp.spouse);
      if (s === "DIFFERENT") return reject("WRONG_SPOUSE", MSG.WRONG_SPOUSE);
      if (s === "CLOSE") uncertain.push({ code: "SPOUSE_VARIATION", message: "The spouse's name on the return is close to, but not the same as, the spouse on file." });
    } else if (other && !exp.spouse) uncertain.push({ code: "NO_SPOUSE_ON_FILE", message: "This is a joint return, but no spouse is on file for this client. Add the spouse to the client record, then upload again." });
    if (!read.taxpayer && primary === "SAME") notes.push({ code: "NAME_FOUND_IN_TEXT", message: "The client's name was found in the return's text." });
  } else {
    uncertain.push({ code: "NO_NAME_ON_FILE", message: "The client record has no name to compare with the return." });
  }

  return uncertain.length ? { result: "UNCERTAIN", read, reasons: uncertain } : { result: "VERIFIED", read, notes };
}
