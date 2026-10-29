// Tax document types staff can tag on upload. Informational only: tagging an
// acceptance notice or extension never changes a filing's status.
export const TAX_DOC_TYPES = {
  TAX_RETURN: "Tax return",
  TAXACT_EXPORT: "TaxAct export",
  ACCEPTANCE_NOTICE: "Acceptance notice (IRS/state)",
  EXTENSION_CONFIRMATION: "Extension confirmation",
  AMENDMENT: "Amendment",
  AGENCY_NOTICE: "IRS/state notice or letter",
  SUPPORTING: "Supporting document",
  OTHER: "Other",
} as const;
export type TaxDocType = keyof typeof TAX_DOC_TYPES;
export const isTaxDocType = (v: string): v is TaxDocType => v in TAX_DOC_TYPES;
