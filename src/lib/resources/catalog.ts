// Resource Center catalog: jurisdictions, sections and the resource types each
// state is expected to have (used to show honest coverage, never "complete" when it isn't).

export const STATES: { code: string; name: string }[] = [
  ["AL", "Alabama"], ["AK", "Alaska"], ["AZ", "Arizona"], ["AR", "Arkansas"], ["CA", "California"], ["CO", "Colorado"], ["CT", "Connecticut"],
  ["DE", "Delaware"], ["DC", "District of Columbia"], ["FL", "Florida"], ["GA", "Georgia"], ["HI", "Hawaii"], ["ID", "Idaho"], ["IL", "Illinois"],
  ["IN", "Indiana"], ["IA", "Iowa"], ["KS", "Kansas"], ["KY", "Kentucky"], ["LA", "Louisiana"], ["ME", "Maine"], ["MD", "Maryland"],
  ["MA", "Massachusetts"], ["MI", "Michigan"], ["MN", "Minnesota"], ["MS", "Mississippi"], ["MO", "Missouri"], ["MT", "Montana"], ["NE", "Nebraska"],
  ["NV", "Nevada"], ["NH", "New Hampshire"], ["NJ", "New Jersey"], ["NM", "New Mexico"], ["NY", "New York"], ["NC", "North Carolina"],
  ["ND", "North Dakota"], ["OH", "Ohio"], ["OK", "Oklahoma"], ["OR", "Oregon"], ["PA", "Pennsylvania"], ["RI", "Rhode Island"],
  ["SC", "South Carolina"], ["SD", "South Dakota"], ["TN", "Tennessee"], ["TX", "Texas"], ["UT", "Utah"], ["VT", "Vermont"], ["VA", "Virginia"],
  ["WA", "Washington"], ["WV", "West Virginia"], ["WI", "Wisconsin"], ["WY", "Wyoming"],
].map(([code, name]) => ({ code, name }));

export const isStateCode = (v: string | null | undefined): v is string => !!v && STATES.some((s) => s.code === v);
export const stateName = (code: string) => STATES.find((s) => s.code === code)?.name ?? code;

export type SectionKey = "TAXES" | "BUSINESS" | "ALCOHOL" | "NONPROFIT" | "LOCAL" | "FEDERAL";

export const SECTIONS: { key: SectionKey; title: string; blurb: string; helpTopic: string }[] = [
  { key: "TAXES", title: "State Taxes & Payments", blurb: "File, pay and look up state taxes on the official agency websites.", helpTopic: "State taxes" },
  { key: "BUSINESS", title: "Business Registration & Licenses", blurb: "Form a business, file annual reports and find license information.", helpTopic: "Business registration & licenses" },
  { key: "ALCOHOL", title: "Liquor Licenses & Alcohol Taxes", blurb: "Licensing and alcohol tax filing are often handled by different agencies — both are listed separately.", helpTopic: "Liquor licenses & alcohol taxes" },
  { key: "NONPROFIT", title: "Nonprofit Services", blurb: "Form a nonprofit and register for charitable solicitation where required.", helpTopic: "Nonprofit services" },
  { key: "LOCAL", title: "County & City", blurb: "Local tax and licensing offices where we've verified coverage.", helpTopic: "Local taxes & licenses" },
  { key: "FEDERAL", title: "Federal Resources", blurb: "IRS, SBA and SAM.gov — available whatever state you choose.", helpTopic: "Federal (IRS, SBA, SAM.gov)" },
];

export const CATEGORIES: Record<string, { label: string; section: SectionKey; expected: boolean }> = {
  TAX_AGENCY: { label: "Tax agency", section: "TAXES", expected: true },
  TAX_PORTAL: { label: "Online tax account, filing & payments", section: "TAXES", expected: true },
  INDIVIDUAL_INCOME_TAX: { label: "Individual income tax", section: "TAXES", expected: true },
  REFUND_STATUS: { label: "Where's my state refund?", section: "TAXES", expected: true },
  BUSINESS_INCOME_TAX: { label: "Business income / franchise tax", section: "TAXES", expected: true },
  SALES_USE_TAX: { label: "Sales & use tax", section: "TAXES", expected: true },
  WITHHOLDING: { label: "Employer withholding", section: "TAXES", expected: true },
  UNEMPLOYMENT_TAX: { label: "Unemployment insurance tax (employers)", section: "TAXES", expected: true },
  BUSINESS_REGISTRY: { label: "Business registration (Secretary of State)", section: "BUSINESS", expected: true },
  ANNUAL_REPORT: { label: "Annual reports & renewals", section: "BUSINESS", expected: true },
  BUSINESS_LICENSE: { label: "Business licenses", section: "BUSINESS", expected: true },
  ALCOHOL_LICENSING: { label: "Alcohol licensing", section: "ALCOHOL", expected: true },
  ALCOHOL_TAX: { label: "Alcohol tax filing & payment", section: "ALCOHOL", expected: true },
  NONPROFIT_FORMATION: { label: "Nonprofit formation", section: "NONPROFIT", expected: true },
  CHARITABLE_REGISTRATION: { label: "Charitable solicitation registration", section: "NONPROFIT", expected: true },
  LOCAL_TAX_LICENSE: { label: "Local tax & license office", section: "LOCAL", expected: false },
  FEDERAL_TAX: { label: "IRS", section: "FEDERAL", expected: false },
  FEDERAL_SBA: { label: "Small Business Administration", section: "FEDERAL", expected: false },
  FEDERAL_SAM: { label: "SAM.gov", section: "FEDERAL", expected: false },
};

export const EXPECTED_STATE_CATEGORIES = Object.entries(CATEGORIES).filter(([, c]) => c.expected).map(([k]) => k);

// Request buttons: each creates a secure request in the client's file.
export const REQUEST_TOPICS = {
  NONPROFIT_SETUP: "Request Nonprofit Setup",
  BUSINESS_SETUP: "Request Business Setup",
  LICENSING: "Request Licensing Assistance",
  ALCOHOL_TAX: "Request Alcohol Tax Services",
  SAM_ASSISTANCE: "Request SAM.gov Assistance",
  HELP: "Ask TTurner for Help",
} as const;
export type RequestTopic = keyof typeof REQUEST_TOPICS;

export function hostOf(url: string | null) {
  if (!url) return null;
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
}
