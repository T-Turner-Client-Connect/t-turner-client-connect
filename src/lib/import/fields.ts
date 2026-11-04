// Contact fields an import may write. Anything not listed here is dropped on
// the server, whatever the browser sends.

export const IMPORT_FIELDS = {
  firstName: "First name (taxpayer)",
  middleName: "Middle name / initial (taxpayer)",
  lastName: "Last name (taxpayer)",
  fullName: "Full name (joint names kept as taxpayer + spouse)",
  spouseFirstName: "Spouse first name",
  spouseMiddleName: "Spouse middle name / initial",
  spouseLastName: "Spouse last name",
  spouseFullName: "Spouse full name",
  spouseEmail: "Spouse email",
  spousePhone: "Spouse phone",
  businessName: "Business name",
  email: "Email",
  phone: "Phone (mobile preferred)",
  addressLine1: "Street address line 1",
  addressLine2: "Address line 2",
  city: "City",
  state: "State",
  postalCode: "ZIP / postal code",
  cityStateZip: "City, State ZIP (one column)",
  mailingAddressLine1: "Mailing address line 1 (if different from street)",
  mailingAddressLine2: "Mailing address line 2",
  mailingCity: "Mailing city",
  mailingState: "Mailing state",
  mailingPostalCode: "Mailing ZIP",
  returnType: "Tax return type / form (e.g. 1040, 1120-S)",
  filingStatus: "Filing status (Single, MFJ, MFS, HOH, QSS)",
  taxYear: "Tax year",
  clientType: "Client type (Individual / Business / Nonprofit)",
  services: "Services (comma-separated)",
  tags: "Tags (comma-separated)",
  groups: "Groups (comma-separated)",
  notes: "Notes",
} as const;

export type ImportField = keyof typeof IMPORT_FIELDS;
export const IMPORT_FIELD_KEYS = Object.keys(IMPORT_FIELDS) as ImportField[];

export function isImportField(key: string): key is ImportField {
  return Object.prototype.hasOwnProperty.call(IMPORT_FIELDS, key);
}

// Column headers that indicate tax or financial data. These columns can't be
// mapped at all.
const SENSITIVE_HEADER_PATTERNS: RegExp[] = [
  /\bssn\b/i,
  /social\s*sec/i,
  /\b(tin|itin|ein|fein)\b/i,
  /tax\s*(payer)?\s*id/i,
  /\bdob\b/i,
  /birth/i,
  /\bage\b/i,
  /income/i,
  /\bagi\b/i,
  /wage/i,
  /salary/i,
  /refund/i,
  /balance\s*due/i,
  /amount\s*(owed|due)/i,
  /bank/i,
  /routing/i,
  /account\s*(no|num|#)/i,
  /\bacct\b/i,
  /dependent/i,
  /\bpin\b/i,
  /driver'?s?\s*lic/i,
  /\bid\s*(no|num|#)/i,
  /passport/i,
  /return/i,
  /\bw-?2\b/i,
  /1099/i,
  /deduction/i,
];

// Tax-preparation headers that ARE allowed even though they mention "return":
// the return type / form, filing status and tax year (needed to open the right
// tax-preparation case). Return figures, refunds, e-file status, IDs etc. stay blocked.
const TAX_PREP_HEADERS: RegExp[] = [
  /^(tax[\s_-]*)?return[\s_-]*(type|form)$/i,
  /^(federal[\s_-]*)?(form|form[\s_-]*type|return)$/i,
  /^(taxpayer[\s_-]*|federal[\s_-]*)?filing[\s_-]*status$/i,
  /^(tax|return)[\s_-]*year$/i,
];

export function isSensitiveHeader(header: string): boolean {
  const h = header.trim();
  if (TAX_PREP_HEADERS.some((re) => re.test(h))) return false;
  return SENSITIVE_HEADER_PATTERNS.some((re) => re.test(h));
}

// Recognizes TaxAct Client Manager and common spreadsheet headers. Order
// matters: spouse columns are checked before the taxpayer's.
const P = String.raw`^((taxpayer|tp|primary|client|customer)('?s)?[\s_-]*)?`;
const SP = String.raw`^(spouse|sp)('?s)?[\s_-]*`;
const GUESSES: [ImportField, RegExp][] = [
  ["spouseEmail", new RegExp(SP + String.raw`(e-?mail)([\s_-]*address)?$`, "i")],
  ["spousePhone", new RegExp(SP + String.raw`((cell|mobile|home|work|day(time)?)[\s_-]*)?(phone|mobile|cell|telephone)([\s_-]*(no|number|#))?$`, "i")],
  ["spouseFirstName", new RegExp(SP + String.raw`(first|given)([\s_-]*name)?$`, "i")],
  ["spouseMiddleName", new RegExp(SP + String.raw`(middle([\s_-]*(name|initial))?|mi|m\.i\.?)$`, "i")],
  ["spouseLastName", new RegExp(SP + String.raw`(last|family|sur)([\s_-]*name)?$`, "i")],
  ["spouseFullName", new RegExp(SP + String.raw`((full[\s_-]*)?name)?$`, "i")],
  ["firstName", new RegExp(P + String.raw`(first|given)([\s_-]*name)?$`, "i")],
  ["middleName", new RegExp(P + String.raw`(middle([\s_-]*(name|initial))?|mi|m\.i\.?)$`, "i")],
  ["lastName", new RegExp(P + String.raw`(last|family|sur)([\s_-]*name)?$`, "i")],
  ["fullName", /^(full[\s_-]*)?name$|^(client|taxpayer|tp|primary|customer|household|display)[\s_-]*(full[\s_-]*)?name$|^name[\s_-]*\(.*\)$|^(taxpayer|client)$/i],
  ["businessName", /business|company|organization|^entity[\s_-]*name$|^dba$|employer[\s_-]*name/i],
  ["email", /e-?mail/i],
  ["cityStateZip", /^city[\s,\/_-]*state[\s,\/_-]*(and[\s_-]*)?zip/i],
  ["phone", /phone|mobile|cell|telephone|^tel$/i],
  ["addressLine2", /address[\s_-]*(2|line[\s_-]*2)|^apt|suite|^unit/i],
  ["addressLine1", /^((mailing|street|home|taxpayer|tp|residential|primary|physical)[\s_-]*)?(street[\s_-]*)?(address|street)([\s_-]*(1|line[\s_-]*1))?$/i],
  ["city", /^((mailing|home|taxpayer|tp|residential)[\s_-]*)?(city|town)$/i],
  ["state", /^((mailing|home|taxpayer|tp|resident(ial)?)[\s_-]*)?(state|st|province)$/i],
  ["postalCode", /zip|postal/i],
  ["filingStatus", /filing[\s_-]*status/i],
  ["returnType", /^(tax[\s_-]*)?return[\s_-]*(type|form)$|^(federal[\s_-]*)?(form|form[\s_-]*type|return)$/i],
  ["taxYear", /^(tax|return)[\s_-]*year$/i],
  ["clientType", /client[\s_-]*(type|category)|^type$|^category$/i],
  ["services", /services?/i],
  ["tags", /tags?/i],
  ["groups", /groups?/i],
  ["notes", /notes?|comments?/i],
];

/** Suggested CRM field for a header, or null. Sensitive headers never map. */
export function guessField(header: string): ImportField | null {
  if (isSensitiveHeader(header)) return null;
  const h = header.trim();
  return GUESSES.find(([, re]) => re.test(h))?.[0] ?? null;
}

export const MAX_IMPORT_ROWS = 5000;
