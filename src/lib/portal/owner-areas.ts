/**
 * The business-owner permission matrix, as data. Each area lists the actions it
 * offers and the PortalAccess flag each action maps to, so the staff screen,
 * the invitation, the server gate and `ownerHasPermission` all read one table.
 * Safe to import from client components (no server code here).
 */

export type OwnerAction = "view" | "upload" | "send" | "approve";

export type OwnerFlag =
  | "canViewDocuments"
  | "canUpload"
  | "canViewPayroll"
  | "canUploadPayroll"
  | "canMessage"
  | "canViewBookkeeping"
  | "canViewBilling"
  | "canViewTax"
  | "canViewContracts"
  | "canApprovePayroll";

export type OwnerArea = {
  key: string;
  label: string;
  hint: string;
  actions: { action: OwnerAction; label: string; flag: OwnerFlag }[];
};

export const OWNER_AREAS = [
  { key: "documents", label: "Business documents", hint: "The business's document vault and other logins' uploads.", actions: [{ action: "view", label: "View", flag: "canViewDocuments" }] },
  { key: "uploads", label: "Uploads", hint: "Send files to the office.", actions: [{ action: "upload", label: "Upload", flag: "canUpload" }] },
  {
    key: "payroll",
    label: "Payroll documents",
    hint: "Payroll reports, 941s, W-2s.",
    actions: [
      { action: "view", label: "View", flag: "canViewPayroll" },
      { action: "upload", label: "Upload", flag: "canUploadPayroll" },
    ],
  },
  { key: "payrollApproval", label: "Payroll approval", hint: "Approve or deny payroll runs. Never allows editing payroll.", actions: [{ action: "approve", label: "Approve/Deny payroll", flag: "canApprovePayroll" }] },
  { key: "messages", label: "Messages", hint: "Their own private threads with the office, plus shared business threads.", actions: [{ action: "send", label: "View & send", flag: "canMessage" }] },
  { key: "banking", label: "Banking & financial dashboard", hint: "Managed Business view (bookkeeping, ledger, statements). Only Tabitha turns this on.", actions: [{ action: "view", label: "View", flag: "canViewBookkeeping" }] },
  { key: "billing", label: "Billing", hint: "Invoices and payments for the business.", actions: [{ action: "view", label: "View & pay", flag: "canViewBilling" }] },
  { key: "taxReturns", label: "Business tax returns", hint: "Filed business returns and signature requests. A full return can include every owner's K-1.", actions: [{ action: "view", label: "View", flag: "canViewTax" }] },
  { key: "contracts", label: "Contracts & agreements", hint: "Engagement letters and pricing agreements.", actions: [{ action: "view", label: "View & sign", flag: "canViewContracts" }] },
] as const satisfies readonly OwnerArea[];

export type OwnerAreaKey = (typeof OWNER_AREAS)[number]["key"] | "k1";

export type OwnerPermissions = Record<OwnerFlag, boolean>;

export const OWNER_FLAGS = OWNER_AREAS.flatMap((a) => a.actions.map((x) => x.flag)) as OwnerFlag[];

/**
 * A newly invited owner: their OWN K-1s (always, not a flag) and Messages.
 * Everything else stays off until Tabitha or authorized staff grant it.
 */
export const OWNER_DEFAULT_PERMISSIONS: OwnerPermissions = {
  canViewDocuments: false,
  canUpload: false,
  canViewPayroll: false,
  canUploadPayroll: false,
  canMessage: true,
  canViewBookkeeping: false,
  canViewBilling: false,
  canViewTax: false,
  canViewContracts: false,
  canApprovePayroll: false,
};

/** The flag behind one area/action, or null when that pair doesn't exist. */
export function flagFor(area: OwnerAreaKey, action: OwnerAction): OwnerFlag | null {
  const a = OWNER_AREAS.find((x) => x.key === area);
  return (a?.actions.find((x) => x.action === action) as { flag: OwnerFlag } | undefined)?.flag ?? null;
}

/** Cleans a stored/posted permission set: unknown keys dropped, missing ones off. */
export function normalizePermissions(input: unknown): OwnerPermissions {
  const src = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  return Object.fromEntries(OWNER_FLAGS.map((f) => [f, src[f] === true])) as OwnerPermissions;
}

export const OWNER_TITLES = { MEMBER: "Member", PARTNER: "Partner", SHAREHOLDER: "Shareholder", OFFICER: "Officer", OTHER: "Other" } as const;

/** "25%" / "33.33%" from basis points. */
export function pct(bps: number | null | undefined) {
  if (bps === null || bps === undefined) return "—";
  return `${(bps / 100).toFixed(2).replace(/\.?0+$/, "")}%`;
}
