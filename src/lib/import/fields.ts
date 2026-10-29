// Contact fields an import may write. Anything not listed here is dropped on
// the server, whatever the browser sends.

export const IMPORT_FIELDS = {
  firstName: "First name",
  lastName: "Last name",
  fullName: "Full name (split into first/last)",
  businessName: "Business name",
  email: "Email",
  phone: "Phone (mobile preferred)",
  addressLine1: "Address line 1",
  addressLine2: "Address line 2",
  city: "City",
  state: "State",
  postalCode: "ZIP / postal code",
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
  /filing\s*status/i,
  /\bpin\b/i,
  /driver'?s?\s*lic/i,
  /\bid\s*(no|num|#)/i,
  /passport/i,
  /return/i,
  /\bw-?2\b/i,
  /1099/i,
  /deduction/i,
];

export function isSensitiveHeader(header: string): boolean {
  return SENSITIVE_HEADER_PATTERNS.some((re) => re.test(header));
}

const GUESSES: [ImportField, RegExp][] = [
  ["firstName", /^(first|given)[\s_-]*name$|^first$/i],
  ["lastName", /^(last|family|sur)[\s_-]*name$|^last$/i],
  ["fullName", /^(full[\s_-]*)?name$|^client[\s_-]*name$|^taxpayer[\s_-]*name$/i],
  ["businessName", /business|company|organization|employer[\s_-]*name/i],
  ["email", /e-?mail/i],
  ["phone", /phone|mobile|cell/i],
  ["addressLine1", /^(street|address)([\s_-]*(1|line[\s_-]*1))?$/i],
  ["addressLine2", /address[\s_-]*(2|line[\s_-]*2)|apt|suite|unit/i],
  ["city", /^city$/i],
  ["state", /^state$|province/i],
  ["postalCode", /zip|postal/i],
  ["clientType", /client[\s_-]*type|^type$/i],
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
