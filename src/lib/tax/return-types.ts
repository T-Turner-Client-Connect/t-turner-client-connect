// Tax Return Type for a tax-preparation case. This is NOT the client category
// (Individual / Business / Nonprofit): a client's category says who they are,
// the return type says which return is being prepared for a given tax year.

export const RETURN_TYPES = {
  "1040_SINGLE": "1040 – Single",
  "1040_MFJ": "1040 – Married Filing Jointly",
  "1040_MFS": "1040 – Married Filing Separately",
  "1040_HOH": "1040 – Head of Household",
  "1040_QSS": "1040 – Qualifying Surviving Spouse",
  "1065": "1065 – Partnership",
  "1120S": "1120-S – S Corporation",
  "1120": "1120 – C Corporation",
  "990": "990 series – Nonprofit",
  "1041": "1041 – Estate or Trust",
  OTHER: "Other return form",
} as const;

export type ReturnTypeCode = keyof typeof RETURN_TYPES;
export const RETURN_TYPE_CODES = Object.keys(RETURN_TYPES) as ReturnTypeCode[];

export function isReturnType(v: string | null | undefined): v is ReturnTypeCode {
  return !!v && Object.prototype.hasOwnProperty.call(RETURN_TYPES, v);
}

/** Return types that have a spouse on the return. */
export const SPOUSE_RETURN_TYPES: ReturnTypeCode[] = ["1040_MFJ", "1040_MFS"];
export const isJointReturn = (t: string | null | undefined) => t === "1040_MFJ";

export function returnTypeLabel(code: string | null | undefined, other?: string | null): string {
  if (!code) return "Not selected";
  if (code === "OTHER") return other ? `Other – ${other}` : RETURN_TYPES.OTHER;
  return isReturnType(code) ? RETURN_TYPES[code] : code;
}

const FILING_STATUS: [RegExp, ReturnTypeCode][] = [
  [/^(mfj|2)$|married\s*filing\s*joint|\bjoint(ly)?\b/i, "1040_MFJ"],
  [/^(mfs|3)$|married\s*filing\s*separate|\bseparate(ly)?\b/i, "1040_MFS"],
  [/^(hoh|4)$|head\s*of\s*h(ouse)?h(old)?/i, "1040_HOH"],
  [/^(qss|qw|qw\(?\s*er\s*\)?|5)$|qualifying\s*(surviving\s*spouse|widow)/i, "1040_QSS"],
  [/^(s|1)$|^single$/i, "1040_SINGLE"],
];

/**
 * Reads TaxAct's return type and/or filing status cells into one code.
 * Returns null when the text isn't recognized — staff then select it.
 */
export function parseReturnType(returnType: string | null | undefined, filingStatus: string | null | undefined): { code: ReturnTypeCode | null; other: string | null } {
  const rt = returnType?.trim() ?? "";
  const fs = filingStatus?.trim() ?? "";
  const status = (text: string) => FILING_STATUS.find(([re]) => re.test(text))?.[1] ?? null;
  const form = rt.toUpperCase().replace(/^FORM\s*/, "").replace(/\s+/g, "");

  if (/^1120-?S|S-?CORP/.test(form) || /s\s*corp/i.test(rt)) return { code: "1120S", other: null };
  if (/^1120(?!-?S)/.test(form) || /c\s*corp/i.test(rt)) return { code: "1120", other: null };
  if (/^1065/.test(form) || /partnership/i.test(rt)) return { code: "1065", other: null };
  if (/^990/.test(form) || /non-?profit|exempt/i.test(rt)) return { code: "990", other: null };
  if (/^1041/.test(form) || /estate|trust/i.test(rt)) return { code: "1041", other: null };
  if (/^1040(?!-?(NR|X|SS|PR|ES))/.test(form) || /individual/i.test(rt) || (!rt && fs)) {
    // 1040: the filing status picks the exact type. "1040 MFJ" in one cell works too.
    return { code: status(fs) ?? status(rt.replace(/^(form\s*)?1040\s*[-–:]?\s*/i, "")), other: null };
  }
  if (rt) {
    const st = status(rt);
    if (st) return { code: st, other: null };
    if (/^\d{3,4}/.test(form)) return { code: "OTHER", other: rt.slice(0, 40) };
  }
  return { code: null, other: null };
}

export type PersonName = { first: string | null; middle: string | null; last: string | null };
export type ParsedName = { primary: PersonName; spouse: PersonName | null };

const JOINER = /\s+(?:&|and|\+)\s+|\s*&\s*/i;

function person(text: string, fallbackLast: string | null = null): PersonName {
  const parts = text.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return { first: null, middle: null, last: fallbackLast };
  if (parts.length === 1) return fallbackLast ? { first: parts[0], middle: null, last: fallbackLast } : { first: parts[0], middle: null, last: null };
  const last = parts.pop()!;
  const first = parts.shift()!;
  return { first, middle: parts.join(" ") || null, last };
}

/**
 * Splits a name cell into the primary taxpayer and (for a joint return) the
 * spouse — never one person named "Allison R Stockton & Jonathan".
 *   "Allison R Stockton & Jonathan Scoggins" → Allison R Stockton + Jonathan Scoggins
 *   "John & Jane Doe" / "Doe, John & Jane"   → John Doe + Jane Doe
 *   "Doe, John"                              → John Doe
 */
export function parseTaxpayerName(full: string | null | undefined): ParsedName | null {
  const text = full?.replace(/\s+/g, " ").trim();
  if (!text) return null;
  if (text.includes(",")) {
    const [last, rest] = text.split(",", 2).map((s) => s.trim());
    const [a, b] = (rest ?? "").split(JOINER, 2);
    return { primary: withLast(a, last || null), spouse: b ? withLast(b, last || null) : null };
  }
  const [a, b] = text.split(JOINER, 2);
  if (b === undefined) return { primary: person(a), spouse: null };
  const spouse = person(b);
  // "John & Jane Doe" / "Allison R & Jonathan Stockton": the first person has
  // no last name of their own, so they share the spouse's.
  const primary = hasOwnLastName(a) ? person(a) : withLast(a, spouse.last);
  return { primary, spouse };
}

/** "Allison R Stockton" → yes; "John" or "Allison R" (ends in an initial) → no. */
export function hasOwnLastName(text: string): boolean {
  const words = text.trim().split(/\s+/).filter(Boolean);
  return words.length >= 2 && !/^[a-z]\.?$/i.test(words[words.length - 1]);
}

function withLast(text: string, last: string | null): PersonName {
  const words = text.trim().split(/\s+/).filter(Boolean);
  return { first: words[0] ?? null, middle: words.slice(1).join(" ") || null, last };
}

/** True when a stored first/last name holds two people ("Allison R Stockton &"). */
export function looksCombined(name: { firstName?: string | null; lastName?: string | null; displayName?: string | null }): boolean {
  return [name.firstName, name.lastName].some((s) => !!s && /(^|\s)(&|and|\+)(\s|$)|&/i.test(s));
}

export const joinName = (p: PersonName | null) => (p ? [p.first, p.middle, p.last].filter(Boolean).join(" ") : "");
