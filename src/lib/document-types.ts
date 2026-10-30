// Tax document types staff can tag on upload. Informational only: tagging an
// acceptance notice or extension never changes a filing's status.
export const TAX_DOC_TYPES = {
  FEDERAL_RETURN: "Federal return",
  STATE_RETURN: "State return",
  AMENDED_RETURN: "Amended return",
  TAX_RETURN: "Tax return (other)",
  TAXACT_EXPORT: "TaxAct export",
  ACCEPTANCE_NOTICE: "Acceptance notice (IRS/state)",
  EXTENSION_CONFIRMATION: "Extension confirmation",
  AMENDMENT: "Amendment",
  AGENCY_NOTICE: "IRS/state notice or letter",
  QUESTIONNAIRE_UPLOAD: "Tax questionnaire upload",
  SUPPORTING: "Supporting document",
  OTHER: "Other",
} as const;
export type TaxDocType = keyof typeof TAX_DOC_TYPES;
export const isTaxDocType = (v: string): v is TaxDocType => v in TAX_DOC_TYPES;

// What clients choose when they upload (stored in Document.docType).
export const CLIENT_DOC_TYPES = {
  W2: "W-2 (wages)",
  FORM_1099: "1099 (contract, bank, investment, retirement income)",
  FORM_1098: "1098 (mortgage interest, tuition, student loan)",
  FORM_1095: "1095 (health coverage)",
  BUSINESS_RECORDS: "Business income & expenses",
  PRIOR_RETURN: "Prior-year tax return",
  AGENCY_LETTER: "IRS or state letter",
  ID_DOCUMENT: "ID (driver's license, Social Security card)",
  CHILDCARE_DEPENDENT: "Childcare or dependent records",
  CLIENT_OTHER: "Other tax document",
} as const;
export const isClientDocType = (v: string): v is keyof typeof CLIENT_DOC_TYPES => v in CLIENT_DOC_TYPES;

export const ALL_DOC_TYPES: Record<string, string> = { ...TAX_DOC_TYPES, ...CLIENT_DOC_TYPES };

/** Where a published tax record belongs in Retrieve Tax Filings. */
export function filingGroup(d: { docType: string | null; filing?: { jurisdiction: string; filingType: string } | null }): "FEDERAL" | "STATE" | "AMENDED" | "RELATED" {
  if (d.filing?.filingType === "AMENDED" || d.docType === "AMENDED_RETURN" || d.docType === "AMENDMENT") return "AMENDED";
  if (d.docType === "FEDERAL_RETURN") return "FEDERAL";
  if (d.docType === "STATE_RETURN") return "STATE";
  if ((d.docType === "TAX_RETURN" || !d.docType) && d.filing && d.filing.filingType === "ORIGINAL") return d.filing.jurisdiction === "FEDERAL" ? "FEDERAL" : "STATE";
  return "RELATED";
}
