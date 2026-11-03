import type { Client } from "@prisma/client";
import { looksCombined } from "@/lib/tax/return-types";
import type { CleanRow } from "./rows";

export const SCALAR_FIELDS = [
  "firstName",
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
] as const;

export const FIELD_LABELS: Record<string, string> = {
  firstName: "First name",
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

type Current = Pick<Client, (typeof SCALAR_FIELDS)[number] | "displayName" | "services" | "tags" | "notes">;

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
export function plannedChanges(current: Current, row: CleanRow, mode: "fill_blanks" | "overwrite", extraServices: string[] = []): PlannedChange[] {
  const out: PlannedChange[] = [];
  const repairName = !!row.spouse && looksCombined(current) && !!(row.firstName || row.lastName);
  for (const field of SCALAR_FIELDS) {
    const incoming = row[field];
    if (!has(incoming)) continue;
    const existing = current[field];
    if (existing === incoming) continue;
    if ((field === "firstName" || field === "lastName") && repairName) {
      out.push({ field, from: existing as string | null, to: String(incoming), kind: "repair" });
      continue;
    }
    if (has(existing) && mode === "fill_blanks") continue;
    out.push({ field, from: (existing as string | null) ?? null, to: String(incoming), kind: has(existing) ? "replace" : "fill" });
  }
  const services = mergeList(current.services, [...row.services, ...extraServices]);
  if (services.length !== current.services.length) out.push({ field: "services", from: current.services.join(", ") || null, to: services.slice(current.services.length).join(", "), kind: "add" });
  const tags = mergeList(current.tags, row.tags);
  if (tags.length !== current.tags.length) out.push({ field: "tags", from: null, to: tags.slice(current.tags.length).join(", "), kind: "add" });
  if (row.notes && !current.notes?.includes(row.notes)) out.push({ field: "notes", from: null, to: row.notes, kind: "add" });
  return out;
}
