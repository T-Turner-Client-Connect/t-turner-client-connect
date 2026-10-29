import type { FilingStatus, FilingType } from "@prisma/client";

// Pure parsing for tax e-file status exports (e.g. TaxAct Professional's
// E-file Details report saved as CSV). Column names vary by product/year,
// so staff map columns; these helpers normalize the values.

export const TAX_IMPORT_FIELDS = {
  clientRef: "Client ID (TaxAct client ID or CRM ID) — required",
  displayName: "Client name (shown for review only, never used to match)",
  taxYear: "Tax year",
  returnType: "Return / form type (1040, 1120-S, 4868, 1040-X…)",
  jurisdiction: "Jurisdiction (Federal or state)",
  filingType: "Filing type (original / extension / amended)",
  status: "E-file status",
  submittedAt: "Submit date",
  statusDate: "Status / acknowledgment date",
  submissionId: "Submission ID / reference",
  rejectionCodes: "Rejection codes",
} as const;

export type TaxImportField = keyof typeof TAX_IMPORT_FIELDS;

const STATES = new Set(
  "AL AK AZ AR CA CO CT DE DC FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY PR".split(" "),
);
const STATE_NAMES: Record<string, string> = { ILLINOIS: "IL", CALIFORNIA: "CA", TEXAS: "TX", "NEW YORK": "NY", FLORIDA: "FL", GEORGIA: "GA", INDIANA: "IN", MISSOURI: "MO", WISCONSIN: "WI", OHIO: "OH", MICHIGAN: "MI" };

export function normalizeJurisdiction(v: string | undefined | null): string | null {
  const s = v?.trim().toUpperCase();
  if (!s) return null;
  if (/^(FED|FEDERAL|US|IRS|FEDERAL RETURN)$/.test(s)) return "FEDERAL";
  if (STATES.has(s)) return s;
  return STATE_NAMES[s] ?? null;
}

export function normalizeFilingType(explicit: string | undefined | null, returnType: string | undefined | null): FilingType {
  const e = explicit?.trim().toLowerCase() ?? "";
  const r = returnType?.trim().toUpperCase() ?? "";
  if (/ext/.test(e) || /^(4868|7004|8868|EXT)/.test(r)) return "EXTENSION";
  if (/amend/.test(e) || /-?X$/.test(r) || /AMEND/.test(r)) return "AMENDED";
  return "ORIGINAL";
}

export function normalizeReturnType(v: string | undefined | null): string | null {
  const s = v?.trim().toUpperCase().replace(/^FORM\s+/, "").replace(/\s+/g, "");
  if (!s) return null;
  return s.slice(0, 20);
}

export function normalizeStatus(v: string | undefined | null): FilingStatus | null {
  const s = v?.trim().toLowerCase();
  if (!s) return null;
  if (/accept/.test(s)) return "ACCEPTED";
  if (/reject|denied|error/.test(s)) return "REJECTED";
  if (/pending|transmit|sent|acknowledg|awaiting/.test(s)) return "PENDING_ACKNOWLEDGMENT";
  if (/submit/.test(s)) return "SUBMITTED";
  if (/created|ready|not\s*(sent|submitted)|hold/.test(s)) return "NOT_SUBMITTED";
  return null;
}

export function parseDate(v: string | undefined | null): Date | null {
  const s = v?.trim();
  if (!s) return null;
  const us = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)?)?$/i.exec(s);
  if (us) {
    const year = us[3].length === 2 ? 2000 + Number(us[3]) : Number(us[3]);
    let hour = Number(us[4] ?? 12);
    if (us[7]) hour = (hour % 12) + (us[7].toUpperCase() === "PM" ? 12 : 0);
    const d = new Date(Date.UTC(year, Number(us[1]) - 1, Number(us[2]), hour, Number(us[5] ?? 0), Number(us[6] ?? 0)));
    return Number.isNaN(d.getTime()) ? null : d;
  }
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

export const PREP_LABELS = {
  AWAITING_INFORMATION: "Awaiting information",
  IN_PROGRESS: "In progress",
  UNDER_REVIEW: "Under review",
  AWAITING_SIGNATURE: "Awaiting signature",
  READY_TO_FILE: "Ready to file",
} as const;

export const FILING_LABELS = {
  NOT_SUBMITTED: "Not submitted",
  SUBMITTED: "Submitted",
  PENDING_ACKNOWLEDGMENT: "Pending acknowledgment",
  ACCEPTED: "Accepted",
  REJECTED: "Rejected",
} as const;

export const AMENDMENT_LABELS = {
  NONE: "—",
  PROCESSING: "Accepted for processing — in progress at the agency",
  PROCESSING_COMPLETE: "Processing complete",
  CHANGES_APPROVED: "Changes approved",
  CHANGES_ADJUSTED: "Processed with adjustments (see notice)",
  REFUND_ISSUED: "Refund issued",
  BALANCE_DUE_NOTICE: "Balance-due notice issued",
} as const;

export function jurisdictionLabel(j: string) {
  return j === "FEDERAL" ? "Federal (IRS)" : `State — ${j}`;
}

/** Client-facing name for a filing so it's always clear which status is which. */
export function filingTitle(f: { taxYear: number; returnType: string; jurisdiction: string; filingType: FilingType }) {
  const kind = f.filingType === "EXTENSION" ? "Extension" : f.filingType === "AMENDED" ? "Amended return" : "Return";
  return `${f.taxYear} ${jurisdictionLabel(f.jurisdiction)} ${kind} (${f.returnType})`;
}

/** The plain-language filing status, labelled for extensions so it can't be confused with the return. */
export function filingStatusLabel(f: { filingType: FilingType; filingStatus: FilingStatus; method: "ELECTRONIC" | "PAPER" }) {
  if (f.filingType === "EXTENSION" && f.filingStatus === "ACCEPTED") return "Extension Accepted";
  if (f.method === "PAPER" && f.filingStatus === "SUBMITTED") return "Mailed (paper filed)";
  if (f.filingType === "AMENDED" && f.filingStatus === "ACCEPTED") return "Amended return accepted for processing";
  return FILING_LABELS[f.filingStatus];
}
