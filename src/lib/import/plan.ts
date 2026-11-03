import type { Client } from "@prisma/client";
import { looksCombined } from "@/lib/tax/return-types";
import type { CleanRow } from "./rows";

export const SCALAR_FIELDS = [
  "firstName",
  "middleName",
  "lastName",
  "businessName",
  "email",
  "phone",
  "addressLine1",
  "addressLine2",
  "city",
  "state",
  "postalCode",
  "clientType",
  "spouseFirstName",
  "spouseMiddleName",
  "spouseLastName",
  "spouseEmail",
  "spousePhone",
] as const;

export const FIELD_LABELS: Record<string, string> = {
  firstName: "First name",
  middleName: "Middle name / initial",
  spouseFirstName: "Spouse first name",
  spouseMiddleName: "Spouse middle name / initial",
  spouseLastName: "Spouse last name",
  spouseEmail: "Spouse email",
  spousePhone: "Spouse phone",
  lastName: "Last name",
  businessName: "Business name",
  email: "Email",
  phone: "Phone",
  addressLine1: "Address",
  addressLine2: "Address line 2",
  city: "City",
  state: "State",
  postalCode: "ZIP",
  clientType: "Client category",
  services: "Services",
  tags: "Tags",
  notes: "Notes",
};

export type PlannedChange = { field: string; from: string | null; to: string; kind: "fill" | "replace" | "add" | "repair" };

type Current = Pick<Client, (typeof SCALAR_FIELDS)[number] | "displayName" | "services" | "tags" | "notes"> & { assignedToId?: string | null };

/** Fields staff may approve to replace after the side-by-side comparison. */
export const REPLACEABLE_FIELDS = [...SCALAR_FIELDS, "assignedToId"] as const;
FIELD_LABELS.assignedToId = "Assigned staff";

const has = (v: unknown) => v !== null && v !== undefined && v !== "";

/** Case-insensitive union, keeping the existing spelling. */
export function mergeList(current: string[], incoming: string[]): string[] {
  const out = [...current];
  for (const v of incoming) if (!out.some((x) => x.toLowerCase() === v.toLowerCase())) out.push(v);
  return out;
}

/**
 * What an import row would change on an existing client. Shown as a preview
 * before anything is applied, and used by the commit itself, so the preview
 * and the result can't differ. "fill_blanks" never replaces a value already
 * on the record. The one exception is a name that holds two people
 * ("Allison R Stockton & Jonathan" / "Scoggins"), which is repaired into the
 * primary taxpayer when the file names both taxpayer and spouse.
 */
export function plannedChanges(
  current: Current,
  row: CleanRow,
  mode: "fill_blanks" | "overwrite",
  extraServices: string[] = [],
  opts: { approved?: string[]; assignedToId?: string | null } = {},
): PlannedChange[] {
  const out: PlannedChange[] = [];
  const approved = new Set(opts.approved ?? []);
  const repairName = !!row.spouse && looksCombined(current) && !!(row.firstName || row.lastName);
  const incomingOf = (f: (typeof REPLACEABLE_FIELDS)[number]) => (f === "assignedToId" ? opts.assignedToId ?? null : row[f]);
  for (const field of REPLACEABLE_FIELDS) {
    const incoming = incomingOf(field);
    if (!has(incoming)) continue;
    const existing = current[field as keyof Current] as string | null | undefined;
    if (existing === incoming) continue;
    if ((field === "firstName" || field === "lastName") && repairName) {
      out.push({ field, from: existing as string | null, to: String(incoming), kind: "repair" });
      continue;
    }
    if (has(existing) && mode === "fill_blanks" && !approved.has(field)) continue;
    out.push({ field, from: (existing as string | null) ?? null, to: String(incoming), kind: has(existing) ? "replace" : "fill" });
  }
  const services = mergeList(current.services, [...row.services, ...extraServices]);
  if (services.length !== current.services.length) out.push({ field: "services", from: current.services.join(", ") || null, to: services.slice(current.services.length).join(", "), kind: "add" });
  const tags = mergeList(current.tags, row.tags);
  if (tags.length !== current.tags.length) out.push({ field: "tags", from: null, to: tags.slice(current.tags.length).join(", "), kind: "add" });
  if (row.notes && !current.notes?.includes(row.notes)) out.push({ field: "notes", from: null, to: row.notes, kind: "add" });
  return out;
}

export type Comparison = { field: string; label: string; taxact: string | null; connect: string | null; outcome: "same" | "fill" | "differs" | "approved" | "not_in_file" };

/**
 * The side-by-side TaxAct vs Client Connect view for one matched client.
 * "differs" values are kept unless staff tick them (then "approved").
 */
export function compareFields(current: Current, row: CleanRow, opts: { approved?: string[]; assignedToId?: string | null; labelFor?: (field: string, v: string | null) => string | null } = {}): Comparison[] {
  const approved = new Set(opts.approved ?? []);
  const show = (f: string, v: string | null | undefined) => (v === null || v === undefined || v === "" ? null : opts.labelFor ? opts.labelFor(f, String(v)) : String(v));
  return REPLACEABLE_FIELDS.map((field) => {
    const taxact = field === "assignedToId" ? opts.assignedToId ?? null : (row[field] as string | null);
    const connect = (current[field as keyof Current] as string | null | undefined) ?? null;
    const norm = (v: string | null) => v?.trim().toLowerCase() ?? "";
    let outcome: Comparison["outcome"];
    if (!has(taxact)) outcome = "not_in_file";
    else if (!has(connect)) outcome = "fill";
    else if (norm(taxact) === norm(connect)) outcome = "same";
    else outcome = approved.has(field) ? "approved" : "differs";
    return { field, label: FIELD_LABELS[field] ?? field, taxact: show(field, taxact), connect: show(field, connect), outcome };
  });
}
