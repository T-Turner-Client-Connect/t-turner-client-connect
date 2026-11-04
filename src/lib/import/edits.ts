// Address, contact and return-type details that staff enter or correct on an
// import preview row, before the client is created. Pure helpers: the import
// service stores the edits on the row and applies them on commit, and the
// preview uses the same functions, so what staff see is what gets saved.
import { formatPhone, normalizeEmail, normalizePhone } from "@/lib/normalize";
import { isReturnType, type ReturnTypeCode } from "@/lib/tax/return-types";
import type { CleanRow } from "./rows";

export const ADDRESS_FIELDS = ["addressLine1", "addressLine2", "city", "state", "postalCode"] as const;
export const MAILING_FIELDS = ["mailingAddressLine1", "mailingAddressLine2", "mailingCity", "mailingState", "mailingPostalCode"] as const;
export const CONTACT_FIELDS = ["phone", "email"] as const;
type TextField = (typeof ADDRESS_FIELDS)[number] | (typeof MAILING_FIELDS)[number] | (typeof CONTACT_FIELDS)[number];
export const TEXT_EDIT_FIELDS: readonly TextField[] = [...ADDRESS_FIELDS, ...MAILING_FIELDS, ...CONTACT_FIELDS];
/** Client fields the preview editor owns (its "Use imported value" approvals). */
export const EDITOR_FIELDS = [...TEXT_EDIT_FIELDS, "mailingSameAsAddress"] as const;

export const EDIT_LABELS: Record<string, string> = {
  addressLine1: "Street address",
  addressLine2: "Address line 2",
  city: "City",
  state: "State",
  postalCode: "ZIP",
  mailingAddressLine1: "Mailing street address",
  mailingAddressLine2: "Mailing address line 2",
  mailingCity: "Mailing city",
  mailingState: "Mailing state",
  mailingPostalCode: "Mailing ZIP",
  mailingSameAsAddress: "Mailing address same as street address",
  phone: "Phone",
  email: "Email",
  returnType: "Return type / filing status",
};

export type RowEdits = Partial<Record<TextField, string>> & { mailingSameAsAddress?: boolean; returnType?: ReturnTypeCode };

/** Tags set on the client when an import is allowed to go ahead incomplete. */
export const ADDRESS_NEEDED_TAG = "Address Needed";
export const FILING_STATUS_NEEDED_TAG = "Filing Status Needed";

export type MissingInfo = "Address" | "Phone" | "Email" | "Filing status";

const ZIP_RE = /^\d{5}(-?\d{4})?$/;

/**
 * Checks what staff typed. Blank means "nothing entered" (the file's value,
 * if any, stays). Returns readable errors rather than guessing a fix.
 */
export function validateEdits(input: Record<string, unknown>): { edits: RowEdits; errors: string[] } {
  const edits: RowEdits = {};
  const errors: string[] = [];
  for (const f of TEXT_EDIT_FIELDS) {
    const raw = input[f];
    if (typeof raw !== "string") continue;
    const v = raw.trim().slice(0, 200);
    if (!v) continue;
    if (f === "state" || f === "mailingState") {
      if (!/^[A-Za-z]{2}$/.test(v)) errors.push(`${EDIT_LABELS[f]}: use the 2-letter abbreviation (e.g. AL).`);
      else edits[f] = v.toUpperCase();
    } else if (f === "postalCode" || f === "mailingPostalCode") {
      if (!ZIP_RE.test(v)) errors.push(`${EDIT_LABELS[f]}: enter a 5-digit ZIP (or ZIP+4).`);
      else edits[f] = v;
    } else if (f === "phone") {
      const n = normalizePhone(v);
      if (!n) errors.push("Phone: enter a 10-digit US number, or an international number starting with +.");
      else edits.phone = formatPhone(n);
    } else if (f === "email") {
      if (!normalizeEmail(v)) errors.push("Email: that address doesn't look right.");
      else edits.email = v;
    } else edits[f] = v;
  }
  if (typeof input.mailingSameAsAddress === "boolean") edits.mailingSameAsAddress = input.mailingSameAsAddress;
  const rt = input.returnType;
  if (typeof rt === "string" && rt) {
    // "Other" needs the form name, which is entered on the client's Taxes tab.
    if (!isReturnType(rt) || rt === "OTHER") errors.push("Return type: choose one from the list.");
    else edits.returnType = rt;
  }
  return { edits, errors };
}

type Existing = {
  addressLine1?: string | null;
  city?: string | null;
  state?: string | null;
  postalCode?: string | null;
  email?: string | null;
  phone?: string | null;
  mailingSameAsAddress?: boolean | null;
  mailingAddressLine1?: string | null;
  mailingCity?: string | null;
  mailingState?: string | null;
  mailingPostalCode?: string | null;
} | null;

const has = (v: unknown) => v !== null && v !== undefined && v !== "";
const hasMailing = (r: Partial<Record<(typeof MAILING_FIELDS)[number], string | null | undefined>> | null | undefined) => !!r && MAILING_FIELDS.some((f) => has(r[f]));

/**
 * "Mailing address is the same as physical address": ticked by default only
 * when there's no separate mailing address — in the file, in what staff
 * entered, or already on the matched client (whose choice is kept).
 */
export function defaultMailingSame(row: CleanRow, existing: Existing): boolean | null {
  if (hasMailing(row)) return false;
  if (existing && (existing.mailingSameAsAddress !== null && existing.mailingSameAsAddress !== undefined)) return existing.mailingSameAsAddress;
  if (existing && hasMailing(existing)) return false;
  return true;
}

/**
 * The row as it will be imported: the file's values with staff entries on
 * top. A blank entry never clears a value from the file, and nothing is
 * invented — a missing return type stays missing.
 */
export function applyEdits(row: CleanRow, edits: RowEdits | null | undefined, existing: Existing = null): CleanRow {
  const out: CleanRow = { ...row };
  const e = edits ?? {};
  for (const f of TEXT_EDIT_FIELDS) {
    const v = e[f];
    if (!has(v)) continue;
    (out as Record<string, unknown>)[f] = v;
  }
  if (has(e.phone)) out.phoneNormalized = normalizePhone(e.phone!);
  if (has(e.email)) out.emailNormalized = normalizeEmail(e.email!);
  if (e.returnType) {
    out.returnType = e.returnType;
    out.otherReturnForm = null;
  }
  const same = typeof e.mailingSameAsAddress === "boolean" ? e.mailingSameAsAddress : defaultMailingSame(out, existing);
  out.mailingSameAsAddress = same;
  // "Same as street address" stores no copy; the mailing fields stay as they are.
  if (same) for (const f of MAILING_FIELDS) out[f] = null;
  return out;
}

/**
 * What a row still lacks once the matched client's own values are counted
 * (an existing address isn't "missing" just because the file left it out).
 * Address line 2 is optional.
 */
export function missingInfo(row: CleanRow, existing: Existing, opts: { wantsCase: boolean; caseHasReturnType?: boolean }): MissingInfo[] {
  const out: MissingInfo[] = [];
  const pick = (f: keyof NonNullable<Existing> & keyof CleanRow) => has(existing?.[f]) || has(row[f]);
  const street = pick("addressLine1") && pick("city") && pick("state") && pick("postalCode");
  const sameMailing = row.mailingSameAsAddress ?? existing?.mailingSameAsAddress ?? true;
  const mailing = sameMailing || (pick("mailingAddressLine1") && pick("mailingCity") && pick("mailingState") && pick("mailingPostalCode"));
  if (!street || !mailing) out.push("Address");
  if (!pick("phone")) out.push("Phone");
  if (!pick("email")) out.push("Email");
  if (opts.wantsCase && !row.returnType && !opts.caseHasReturnType) out.push("Filing status");
  return out;
}

/** Missing items that hold an import back unless staff choose to flag them. */
export const BLOCKING_MISSING: MissingInfo[] = ["Address", "Filing status"];
