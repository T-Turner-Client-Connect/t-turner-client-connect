/**
 * Services staff pick on a client record (the "Services" list). Shared by the
 * client form and the portal gating. Safe for client components.
 */
export const CLIENT_SERVICE_OPTIONS = [
  "Individual tax preparation",
  "Business tax return (1065/1120-S/1120)",
  "K-1 preparation for owners",
  "Payroll",
  "Bookkeeping",
  "Nonprofit services",
  "Business setup",
  "Consulting",
] as const;

/** The options a business-only client usually has (no personal tax work). */
export const BUSINESS_SERVICE_OPTIONS = ["Business tax return (1065/1120-S/1120)", "K-1 preparation for owners", "Payroll", "Bookkeeping"] as const;

/** Labels (lowercased) that mean personal (1040) tax preparation. "Tax preparation" alone on a business record means the business's return. */
export const PERSONAL_TAX_LABELS = new Set(["individual tax preparation", "personal tax preparation", "individual tax return", "personal tax return", "1040"]);
