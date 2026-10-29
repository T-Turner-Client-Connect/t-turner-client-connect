import type { ClientType } from "@prisma/client";
import { buildDisplayName, looksLikeTaxId, normalizeEmail, normalizePhone, splitList } from "@/lib/normalize";
import { isImportField, type ImportField } from "./fields";

export type MappedRow = Partial<Record<ImportField, string>>;

/** A cleaned import row: only allow-listed fields, trimmed, normalized. */
export type CleanRow = {
  firstName: string | null;
  lastName: string | null;
  businessName: string | null;
  displayName: string;
  email: string | null;
  emailNormalized: string | null;
  phone: string | null;
  phoneNormalized: string | null;
  addressLine1: string | null;
  addressLine2: string | null;
  city: string | null;
  state: string | null;
  postalCode: string | null;
  clientType: ClientType | null;
  services: string[];
  tags: string[];
  groups: string[];
  notes: string | null;
};

function parseClientType(value: string | undefined): ClientType | null {
  const v = value?.trim().toLowerCase();
  if (!v) return null;
  if (/non-?profit|charity|church|501/.test(v)) return "NONPROFIT";
  if (/business|company|llc|corp|inc|s-?corp|partnership|sole/.test(v)) return "BUSINESS";
  if (/individual|person|1040|personal/.test(v)) return "INDIVIDUAL";
  return null;
}

export function cleanRow(raw: Record<string, unknown>): { row: CleanRow; errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];
  const get = (key: ImportField): string | null => {
    const v = raw[key];
    if (v === undefined || v === null) return null;
    const s = String(v).trim().slice(0, 500);
    return s === "" ? null : s;
  };

  // Ignore anything outside the allow-list.
  const ignored = Object.keys(raw).filter((k) => !isImportField(k));
  if (ignored.length) warnings.push(`Ignored ${ignored.length} unapproved field(s)`);

  for (const key of Object.keys(raw)) {
    if (!isImportField(key) || key === "phone" || key === "postalCode") continue;
    const v = raw[key];
    if (typeof v === "string" && looksLikeTaxId(v)) {
      errors.push(`"${key}" looks like it contains an SSN/EIN — row blocked`);
    }
  }

  let firstName = get("firstName");
  let lastName = get("lastName");
  const fullName = get("fullName");
  if (!firstName && !lastName && fullName) {
    if (fullName.includes(",")) {
      const [last, first] = fullName.split(",", 2).map((s) => s.trim());
      lastName = last || null;
      firstName = first || null;
    } else {
      const parts = fullName.split(/\s+/);
      lastName = parts.length > 1 ? parts.pop()! : null;
      firstName = parts.join(" ") || null;
    }
  }
  const businessName = get("businessName");

  const email = get("email");
  const emailNormalized = normalizeEmail(email);
  if (email && !emailNormalized) warnings.push(`Email "${email}" isn't valid and will be left blank`);

  const phone = get("phone");
  const phoneNormalized = normalizePhone(phone);
  if (phone && !phoneNormalized) warnings.push(`Phone "${phone}" isn't a valid number and will be left blank`);

  if (!firstName && !lastName && !businessName) errors.push("No name or business name");
  if (!emailNormalized && !phoneNormalized) warnings.push("No usable email or phone");

  const rawType = get("clientType");
  const clientType = parseClientType(rawType ?? undefined);
  if (rawType && !clientType) warnings.push(`Unknown client type "${rawType}"`);

  const row: CleanRow = {
    firstName,
    lastName,
    businessName,
    displayName: buildDisplayName({ firstName, lastName, businessName }),
    email: emailNormalized ? email : null,
    emailNormalized,
    phone: phoneNormalized ? phone : null,
    phoneNormalized,
    addressLine1: get("addressLine1"),
    addressLine2: get("addressLine2"),
    city: get("city"),
    state: get("state")?.toUpperCase() ?? null,
    postalCode: get("postalCode"),
    clientType: clientType ?? (businessName && !firstName && !lastName ? "BUSINESS" : null),
    services: splitList(get("services")),
    tags: splitList(get("tags")),
    groups: splitList(get("groups")),
    notes: get("notes"),
  };
  return { row, errors, warnings };
}

export type MatchCandidate = {
  id: string;
  displayName: string;
  lastName: string | null;
  businessName: string | null;
  emailNormalized: string | null;
  phoneNormalized: string | null;
  contactEmails: string[];
  contactPhones: string[];
};

export type MatchResult = {
  match: "NEW" | "MATCH" | "AMBIGUOUS" | "ERROR";
  candidateIds: string[];
  notes: string[];
};

function nameCompatible(row: CleanRow, c: MatchCandidate): boolean {
  const lower = (s: string | null) => s?.trim().toLowerCase() || null;
  if (row.lastName && c.lastName && lower(row.lastName) === lower(c.lastName)) return true;
  if (row.businessName && c.businessName && lower(row.businessName) === lower(c.businessName)) return true;
  if (lower(row.displayName) === lower(c.displayName)) return true;
  // Not enough information to disagree.
  return !(row.lastName && c.lastName) && !(row.businessName && c.businessName);
}

/**
 * Duplicate detection on normalized email and phone. A single candidate that
 * matches on every provided identifier and has a compatible name is a MATCH;
 * conflicting or multiple candidates need a person to decide.
 */
export function classifyRow(
  row: CleanRow,
  errors: string[],
  candidates: MatchCandidate[],
  seenInFile: Map<string, number>,
  rowNumber: number,
): MatchResult {
  if (errors.length) return { match: "ERROR", candidateIds: [], notes: [] };
  const notes: string[] = [];

  for (const key of [row.emailNormalized && `e:${row.emailNormalized}`, row.phoneNormalized && `p:${row.phoneNormalized}`]) {
    if (!key) continue;
    const earlier = seenInFile.get(key);
    if (earlier !== undefined && earlier !== rowNumber) {
      notes.push(`Same ${key.startsWith("e:") ? "email" : "phone"} as row ${earlier} in this file`);
    } else if (earlier === undefined) {
      seenInFile.set(key, rowNumber);
    }
  }

  const byEmail = row.emailNormalized
    ? candidates.filter((c) => c.emailNormalized === row.emailNormalized || c.contactEmails.includes(row.emailNormalized!))
    : [];
  const byPhone = row.phoneNormalized
    ? candidates.filter((c) => c.phoneNormalized === row.phoneNormalized || c.contactPhones.includes(row.phoneNormalized!))
    : [];
  const ids = Array.from(new Set([...byEmail, ...byPhone].map((c) => c.id)));

  if (ids.length === 0) {
    return { match: notes.length ? "AMBIGUOUS" : "NEW", candidateIds: [], notes };
  }
  if (ids.length > 1) {
    notes.push("Email and phone match different existing clients");
    return { match: "AMBIGUOUS", candidateIds: ids, notes };
  }
  const candidate = candidates.find((c) => c.id === ids[0])!;
  if (!nameCompatible(row, candidate)) {
    notes.push(`Contact details match ${candidate.displayName}, but the name is different`);
    return { match: "AMBIGUOUS", candidateIds: ids, notes };
  }
  return { match: notes.length ? "AMBIGUOUS" : "MATCH", candidateIds: ids, notes };
}
