// Shared (client-safe) wording for "Deliver accepted return".
export const PRESET_OVERRIDE_REASON = "Prepared and e-filed in TaxAct before Client Connect summary approvals";
export const DEFAULT_VERIFICATION = "Accepted per TaxAct E-file Center";
export const DRAFT_SUMMARY_REASON = "Closed — filed before Client Connect approvals";
export const CLOSE_DRAFT_LABEL = "Close the unsent draft summary — filed before Client Connect approvals";
/** Return types that never need a client-approved summary (business, payroll and information returns). */
export const BUSINESS_RETURN = /^(1120|1065|990|1041|706|709|940|941|943|944|945|W-?2|1099)/i;
