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
