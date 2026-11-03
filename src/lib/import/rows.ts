import type { ClientType } from "@prisma/client";
import { buildDisplayName, formatPhone, householdName, looksLikeTaxId, normalizeEmail, normalizePhone, splitList } from "@/lib/normalize";
import { hasOwnLastName, joinName, parseReturnType, parseTaxpayerName, type PersonName, type ReturnTypeCode } from "@/lib/tax/return-types";
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
  // Tax preparation (optional — present when the file has them).
  primary?: PersonName | null;
  spouse?: PersonName | null;
  spouseEmail?: string | null;
  spousePhone?: string | null;
  returnType?: ReturnTypeCode | null;
  otherReturnForm?: string | null;
  // As written in the file, so staff can see what wasn't recognized.
  returnTypeText?: string | null;
  taxYear?: number | null;
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

  // Names. A joint return is ONE row with a taxpayer and a spouse — never one
  // person whose first name is "Allison R Stockton & Jonathan".
  let primary: PersonName | null = null;
  let spouse: PersonName | null = null;
  const firstCell = get("firstName");
  const lastCell = get("lastName");
  const fullName = get("fullName");
  if (firstCell || lastCell) {
    const joined = [firstCell, get("middleName"), lastCell].filter(Boolean).join(" ");
    // "John & Jane" + "Doe" share the last name; "Allison R Stockton & Jonathan"
    // + "Scoggins" is a full name that was split in the wrong place.
    const firstPart = firstCell?.split(/\s+(?:&|and|\+)\s+|\s*&\s*/i)[0] ?? "";
    const parsed = /&|\s(and|\+)\s/i.test(joined)
      ? parseTaxpayerName(lastCell && firstCell && !hasOwnLastName(firstPart) ? `${lastCell}, ${[firstCell, get("middleName")].filter(Boolean).join(" ")}` : joined)
      : null;
    if (parsed) {
      primary = parsed.primary;
      spouse = parsed.spouse;
    } else {
      primary = { first: firstCell, middle: get("middleName"), last: lastCell };
    }
  } else if (fullName) {
    const parsed = parseTaxpayerName(fullName)!;
    primary = parsed.primary;
    spouse = parsed.spouse;
    if (!primary.middle && get("middleName")) primary.middle = get("middleName");
  }
  const spouseCols: PersonName = { first: get("spouseFirstName"), middle: get("spouseMiddleName"), last: get("spouseLastName") };
  const spouseFull = get("spouseFullName");
  if (spouseCols.first || spouseCols.last) {
    spouse = { first: spouseCols.first ?? spouse?.first ?? null, middle: spouseCols.middle ?? spouse?.middle ?? null, last: spouseCols.last ?? spouse?.last ?? primary?.last ?? null };
  } else if (spouseFull) {
    const sp = parseTaxpayerName(spouseFull)!.primary;
    spouse = sp.last ? sp : { ...sp, last: primary?.last ?? null };
  }
  if (spouse && !spouse.first && !spouse.last) spouse = null;
  if (spouse) warnings.push(`Joint taxpayers: ${joinName(primary)} (taxpayer) and ${joinName(spouse)} (spouse) — kept on one client record`);
  // The client record's name is the primary taxpayer; the middle name/initial
  // stays with the first name so "Allison R Stockton" reads as written.
  const firstName = primary ? [primary.first, primary.middle].filter(Boolean).join(" ") || null : null;
  const lastName = primary?.last ?? null;
  const businessName = get("businessName");

  const email = get("email");
  const emailNormalized = normalizeEmail(email);
  if (email && !emailNormalized) warnings.push(`Email "${email}" isn't valid and will be left blank`);

  const phone = get("phone");
  const phoneNormalized = normalizePhone(phone);
  if (phone && !phoneNormalized) warnings.push(`Phone "${phone}" isn't a valid number and will be left blank`);

  const spouseEmailRaw = get("spouseEmail");
  const spouseEmail = normalizeEmail(spouseEmailRaw) ? spouseEmailRaw : null;
  if (spouseEmailRaw && !spouseEmail) warnings.push(`Spouse email "${spouseEmailRaw}" isn't valid and will be left blank`);
  const spousePhoneRaw = get("spousePhone");
  const spousePhoneNorm = normalizePhone(spousePhoneRaw);
  if (spousePhoneRaw && !spousePhoneNorm) warnings.push(`Spouse phone "${spousePhoneRaw}" isn't a valid number and will be left blank`);

  // "Birmingham, AL 35203" in one column.
  let city = get("city");
  let state = get("state");
  let postalCode = get("postalCode");
  const csz = get("cityStateZip");
  if (csz) {
    const m = /^\s*(.+?)[,\s]+([A-Za-z]{2})\.?\s+(\d{5}(?:-?\d{4})?)\s*$/.exec(csz);
    if (m) {
      city ??= m[1].trim();
      state ??= m[2];
      postalCode ??= m[3];
    } else warnings.push(`Couldn't read city/state/ZIP from "${csz}"`);
  }

  // Return type / filing status, when the file supplies them.
  const rtText = get("returnType");
  const fsText = get("filingStatus");
  const rt = rtText || fsText ? parseReturnType(rtText, fsText) : { code: null, other: null };
  const returnTypeText = [rtText, fsText].filter(Boolean).join(" · ") || null;
  if (returnTypeText && !rt.code) {
    warnings.push(/^(form\s*)?1040$/i.test(rtText ?? "") && !fsText ? "Form 1040 without a filing status — staff will select the exact return type" : `Return type "${returnTypeText}" wasn't recognized — staff will select it`);
  }
  if (rt.code === "1040_MFJ" && !spouse) warnings.push("Married Filing Jointly, but no spouse name in the file — add the spouse on the client's Taxes tab");
  const yearText = get("taxYear");
  const taxYear = yearText && /^(19|20)\d\d$/.test(yearText) ? Number(yearText) : null;
  if (yearText && !taxYear) warnings.push(`Tax year "${yearText}" isn't a year`);

  if (!firstName && !lastName && !businessName) errors.push("No name or business name");
  if (!emailNormalized && !phoneNormalized) warnings.push("No usable email or phone");

  const rawType = get("clientType");
  const clientType = parseClientType(rawType ?? undefined);
  if (rawType && !clientType) warnings.push(`Unknown client type "${rawType}"`);

  const row: CleanRow = {
    firstName,
    lastName,
    businessName,
    // Joint return: the household on one record ("Allison R Stockton & Jonathan Scoggins").
    displayName:
      spouse && rt.code !== "1040_MFS" && !businessName
        ? householdName({ first: firstName, last: lastName }, { first: [spouse.first, spouse.middle].filter(Boolean).join(" ") || null, last: spouse.last })
        : buildDisplayName({ firstName, lastName, businessName }),
    email: emailNormalized ? email : null,
    emailNormalized,
    // Stored cleaned, e.g. "(205)705-0028 M" → "(205) 705-0028".
    phone: phoneNormalized ? formatPhone(phoneNormalized) : null,
    phoneNormalized,
    addressLine1: get("addressLine1"),
    addressLine2: get("addressLine2"),
    city,
    state: state?.toUpperCase() ?? null,
    postalCode,
    clientType: clientType ?? (businessName && !firstName && !lastName ? "BUSINESS" : null),
    services: splitList(get("services")),
    tags: splitList(get("tags")),
    groups: splitList(get("groups")),
    notes: get("notes"),
    primary,
    spouse,
    spouseEmail,
    spousePhone: spousePhoneNorm ? formatPhone(spousePhoneNorm) : null,
    returnType: rt.code,
    otherReturnForm: rt.other,
    returnTypeText,
    taxYear,
  };
  return { row, errors, warnings };
}

export type MatchCandidate = {
  id: string;
  displayName: string;
  firstName?: string | null;
  lastName: string | null;
  addressLine1?: string | null;
  postalCode?: string | null;
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

const norm = (s: string | null | undefined) => s?.toLowerCase().replace(/[^a-z0-9&]+/g, " ").trim() || null;

/** Same person or household, allowing for an older combined-name record. */
export function sameName(row: CleanRow, c: MatchCandidate): boolean {
  if (row.businessName && c.businessName && norm(row.businessName) === norm(c.businessName)) return true;
  if (norm(row.displayName) && norm(row.displayName) === norm(c.displayName)) return true;
  const rowPerson = norm([row.firstName, row.lastName].filter(Boolean).join(" "));
  const cPerson = norm([c.firstName, c.lastName].filter(Boolean).join(" "));
  return !!rowPerson && (rowPerson === cPerson || rowPerson === norm(c.displayName));
}

export function sameAddress(row: CleanRow, c: MatchCandidate): boolean {
  const zip = (z: string | null | undefined) => z?.replace(/\D/g, "").slice(0, 5) || null;
  if (row.addressLine1 && c.addressLine1 && norm(row.addressLine1) === norm(c.addressLine1)) return true;
  return !!zip(row.postalCode) && zip(row.postalCode) === zip(c.postalCode) && !(row.addressLine1 && c.addressLine1);
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
    // No email/phone match: fall back to the name plus the address, so a
    // re-imported file finds records that were created without a phone.
    const byName = candidates.filter((c) => sameName(row, c));
    if (byName.length) {
      const withAddress = byName.filter((c) => sameAddress(row, c));
      if (withAddress.length === 1 && byName.length === 1) {
        const inFileDup = notes.length > 0;
        notes.push(`Matched ${withAddress[0].displayName} by name and address (no email/phone match)`);
        return { match: inFileDup ? "AMBIGUOUS" : "MATCH", candidateIds: [withAddress[0].id], notes };
      }
      notes.push(byName.length > 1 ? `Same name as ${byName.length} existing clients` : `Same name as ${byName[0].displayName}, but the address doesn't confirm it`);
      return { match: "AMBIGUOUS", candidateIds: byName.map((c) => c.id), notes };
    }
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
