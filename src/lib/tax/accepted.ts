// Shared (client-safe) wording and defaults for "Finish & Send a Return".
export const PRESET_OVERRIDE_REASON = "Prepared and e-filed in TaxAct before Client Connect summary approvals";
export const DEFAULT_VERIFICATION = "TaxAct";
export const DRAFT_SUMMARY_REASON = "Closed — filed before Client Connect approvals";
export const CLOSE_DRAFT_LABEL = "Close the unsent draft summary — filed before Client Connect approvals";
/** Return types that never need a client-approved summary (business, payroll and information returns). */
export const BUSINESS_RETURN = /^(1120|1065|990|1041|706|709|940|941|943|944|945|W-?2|1099)/i;

/** Federal form from what we know about the client. Null = unknown (staff type it). */
export function federalFormFor(clientType: string, entityType: string | null | undefined): string | null {
  if (clientType === "INDIVIDUAL") return "1040";
  const byEntity: Record<string, string> = { SOLE_PROPRIETOR: "1040", PARTNERSHIP: "1065", S_CORP: "1120-S", C_CORP: "1120", NONPROFIT: "990", TRUST_ESTATE: "1041" };
  if (entityType && byEntity[entityType]) return byEntity[entityType];
  if (clientType === "NONPROFIT") return "990";
  return null;
}

/**
 * State form, only where the mapping is known for sure (Alabama). Any other
 * state is left blank for staff to type. Null = unknown.
 */
export function stateFormFor(state: string, clientType: string, entityType: string | null | undefined): string | null {
  if (state !== "AL") return null;
  if (clientType === "INDIVIDUAL" || entityType === "SOLE_PROPRIETOR") return "40";
  const al: Record<string, string> = { S_CORP: "20S", PARTNERSHIP: "65", C_CORP: "20C", TRUST_ESTATE: "41" };
  return entityType ? al[entityType] ?? null : null;
}

/** "Federal + AL" — the returns one combined PDF covers. */
export const coverLabel = (jurisdictions: string[]) => jurisdictions.map((j) => (j === "FEDERAL" ? "Federal" : j)).join(" + ");

/**
 * From a confirmed Tax Preparation case ("1040 – Head of Household", "1120-S"…):
 * the federal form, the Alabama form when the client's state is AL, and the
 * summary's filing status. Only mappings known for sure; anything else is
 * null (staff type it). "990 series" and "Other" never map: the exact form
 * isn't known from the case.
 */
export function formsForPrepCase(code: string | null | undefined, state: string | null | undefined): { federal: string | null; state: string | null; filingStatus: string | null } {
  const individual = !!code && /^1040_(SINGLE|MFJ|MFS|HOH|QSS)$/.test(code);
  const federal: Record<string, string> = { "1065": "1065", "1120S": "1120-S", "1120": "1120", "1041": "1041" };
  const al: Record<string, string> = { "1065": "65", "1120S": "20S", "1120": "20C", "1041": "41" };
  return {
    federal: individual ? "1040" : (code && federal[code]) ?? null,
    state: state === "AL" && code ? (individual ? "40" : al[code] ?? null) : null,
    filingStatus: individual ? code!.slice(5) : null,
  };
}
