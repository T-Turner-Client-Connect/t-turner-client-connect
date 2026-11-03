// Pure helpers shared by imports, duplicate detection and recipient dedupe.

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function normalizeEmail(input: string | null | undefined): string | null {
  if (!input) return null;
  const email = input.trim().toLowerCase();
  return EMAIL_RE.test(email) ? email : null;
}

export function isValidEmail(input: string | null | undefined): boolean {
  return normalizeEmail(input) !== null;
}

/**
 * Normalizes a phone number to E.164. US/Canada numbers may be written with
 * or without the leading 1. Returns null when the number can't be trusted.
 */
export function normalizePhone(input: string | null | undefined): string | null {
  if (!input) return null;
  // Tax software appends a line-type marker: "(205)705-0028 M" (mobile),
  // "H" (home), "W" (work), or "(cell)". Drop it before reading digits.
  const trimmed = input
    .trim()
    .replace(/\s*[([]?\s*(?:m|h|w|c|o|f|cell|mobile|home|work|office|fax|day|eve|evening)\s*[)\]]?\.?$/i, "")
    .replace(/^\s*(?:m|h|w|c|cell|mobile|home|work)\s*[:-]\s*/i, "");
  // Drop extensions like "x123" or "ext. 4".
  const main = trimmed.split(/\s*(?:x|ext\.?|extension)\s*\d+$/i)[0];
  const digits = main.replace(/\D/g, "");
  if (main.startsWith("+")) {
    return digits.length >= 8 && digits.length <= 15 ? `+${digits}` : null;
  }
  if (digits.length === 10 && !/^[01]/.test(digits)) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return null;
}

export function formatPhone(e164: string | null | undefined): string {
  if (!e164) return "";
  const m = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(e164);
  return m ? `(${m[1]}) ${m[2]}-${m[3]}` : e164;
}

/**
 * Household name for one joint return: "John & Jane Doe" when they share a
 * last name, otherwise "Allison R Stockton & Jonathan Scoggins".
 */
export function householdName(primary: { first?: string | null; last?: string | null }, spouse: { first?: string | null; last?: string | null }): string {
  const p = [primary.first, primary.last].map((s) => s?.trim()).filter(Boolean).join(" ");
  const s = [spouse.first, spouse.last].map((x) => x?.trim()).filter(Boolean).join(" ");
  if (!s) return p;
  if (!p) return s;
  const pl = primary.last?.trim().toLowerCase();
  if (pl && pl === spouse.last?.trim().toLowerCase() && primary.first && spouse.first) {
    return `${primary.first.trim()} & ${spouse.first.trim()} ${primary.last!.trim()}`;
  }
  return `${p} & ${s}`;
}

export function buildDisplayName(parts: {
  firstName?: string | null;
  lastName?: string | null;
  businessName?: string | null;
}): string {
  const person = [parts.firstName, parts.lastName].map((s) => s?.trim()).filter(Boolean).join(" ");
  return person || parts.businessName?.trim() || "Unnamed client";
}

export function splitList(input: string | null | undefined): string[] {
  if (!input) return [];
  return Array.from(
    new Set(
      input
        .split(/[,;|]/)
        .map((s) => s.trim())
        .filter(Boolean),
    ),
  );
}

// Looks like a US SSN / ITIN / EIN. Used to refuse sensitive data that was
// pasted into an otherwise allowed field (e.g. notes) during an import.
const TAX_ID_RE = /\b(\d{3}-\d{2}-\d{4}|\d{2}-\d{7})\b/;
export function looksLikeTaxId(value: string): boolean {
  return TAX_ID_RE.test(value);
}
