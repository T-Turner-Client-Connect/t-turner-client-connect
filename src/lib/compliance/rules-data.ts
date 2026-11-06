/**
 * Tax & Compliance Center — the reviewed rules library (seed data, version 1).
 *
 * VERIFICATION. A rule is VERIFIED only when someone opened its official source page and read
 * the due date and applicability there. When this library was written (2026-11-05) the build
 * sandbox could not reach any official host (irs.gov, revenue.alabama.gov, sos.alabama.gov,
 * alabamaag.gov, jccal.org, birminghamal.gov, huntsvilleal.gov, jcdh.org,
 * alabamapublichealth.gov, myalabamataxes.alabama.gov: DNS blocked), so EVERY rule ships as
 * NEEDS_VERIFICATION with its candidate source URL(s). The UI labels their dates "Needs
 * verification" and never presents them as certain. The owner verifies each rule on the
 * Rules library page; that creates a new version (editor, reason, source link).
 *
 * Changing this file: bump SEED_VERSION, keep old keys, and describe the change in the rule's
 * `changeReason`. The loader (src/lib/services/compliance-rules.ts) adds a new version for any
 * rule whose content changed and never edits or deletes an existing version.
 */

export const SEED_VERSION = "2026-11-05.1";

export type RuleConditions = {
  /** Entity kinds (LLC, CORPORATION, PARTNERSHIP, SOLE_PROPRIETORSHIP, NONPROFIT, OTHER). */
  entityKinds?: string[];
  /** Federal tax classifications (S_CORP, C_CORP, PARTNERSHIP, SCHEDULE_C, DISREGARDED, EXEMPT_ORG). */
  taxClassifications?: string[];
  /** Requires an S corporation election effective date on file. */
  sCorpElection?: boolean;
  /** The annual period follows the entity's fiscal year end (missing → needs verification). */
  fyeRequired?: boolean;
  /** Calendar-year obligation regardless of the entity's fiscal year (payroll forms, Schedule C). */
  calendarYear?: boolean;
  /** Any of these states among formation, operation and location states. */
  states?: string[];
  /** Only the state of formation counts (e.g. Secretary of State filings). */
  formationStates?: string[];
  counties?: string[];
  cities?: string[];
  /** Any of these activity tags. */
  activityTagsAny?: string[];
  /** A yes/no fact recorded as a tag pair, e.g. alcohol / no-alcohol. Neither recorded → needs verification. */
  tagDecision?: { yes: string; no: string; missing: string };
  payroll?: boolean;
  issues1099?: boolean;
  nonprofit?: boolean;
  /** NonprofitProfile.formType values (990-N, 990-EZ, 990). `fallback` rule carries the "determination pending" case. */
  nonprofitForms?: string[];
  nonprofitFormFallback?: boolean;
  /** A registered tax account this rule reports on. frequencies narrows by its filing frequency. */
  registration?: { type: string; jurisdiction?: string; frequencies?: string[]; fallbackOnUnknownFrequency?: boolean; missing: string };
  /** Reference rule only (extensions): never generated as its own obligation. */
  manualOnly?: boolean;
};

export type RuleSeed = {
  ruleKey: string;
  jurisdictionLevel: "FEDERAL" | "STATE" | "COUNTY" | "CITY";
  jurisdictionName: string;
  formName: string;
  obligationName: string;
  category: "INCOME_TAX" | "SALES_USE" | "WITHHOLDING_PAYROLL" | "INFORMATION_RETURNS" | "LICENSE_PERMIT" | "PROPERTY" | "NONPROFIT" | "ANNUAL_REPORT" | "EXTENSION" | "OTHER";
  conditions: RuleConditions;
  /** MONTHLY | QUARTERLY | SEMIANNUAL | ANNUAL | ONE_TIME, or ACCOUNT:<assumed> (from the registered account). */
  frequency: string;
  dueRuleCode: string;
  dueRuleDescription: string;
  weekendRule: "NEXT_BUSINESS_DAY_FEDERAL" | "NEXT_BUSINESS_DAY_ALABAMA" | "NO_ADJUSTMENT";
  sourceUrls: string[];
  effectiveFrom?: string;
  verificationStatus: "VERIFIED" | "NEEDS_VERIFICATION";
  notes?: string;
  clientApprovalDefault?: boolean;
  portalKind?: string;
  requiredDocs?: string[];
  serviceTypes?: string[];
  extensionMonths?: number;
};

const NV = "NEEDS_VERIFICATION" as const;
const FED = "NEXT_BUSINESS_DAY_FEDERAL" as const;
const AL = "NEXT_BUSINESS_DAY_ALABAMA" as const;
const SELLS = ["restaurant", "food_service", "retail", "sells_taxable"];
const PUB509 = "https://www.irs.gov/publications/p509";
const MAT = "https://myalabamataxes.alabama.gov/";

export const RULES: RuleSeed[] = [
  // --- Federal: income tax -------------------------------------------------------------------
  {
    ruleKey: "FED_1120S", jurisdictionLevel: "FEDERAL", jurisdictionName: "IRS", formName: "Form 1120-S + Schedules K-1", obligationName: "S corporation income tax return and shareholder K-1s", category: "INCOME_TAX",
    conditions: { taxClassifications: ["S_CORP"], sCorpElection: true, fyeRequired: true }, frequency: "ANNUAL", dueRuleCode: "DOM:15:3", dueRuleDescription: "15th day of the 3rd month after the tax year ends (March 15 for calendar-year). K-1s are furnished to shareholders by the same date.", weekendRule: FED,
    sourceUrls: ["https://www.irs.gov/forms-pubs/about-form-1120-s", "https://www.irs.gov/instructions/i1120s", PUB509], verificationStatus: NV, clientApprovalDefault: true, portalKind: "IRS_ESERVICES",
    requiredDocs: ["Prepared Form 1120-S (PDF)", "Schedules K-1", "Signed Form 8879-S", "IRS e-file acknowledgement"], serviceTypes: ["TAX_BUSINESS", "K1_PREPARATION"], extensionMonths: 6,
  },
  {
    ruleKey: "FED_1120", jurisdictionLevel: "FEDERAL", jurisdictionName: "IRS", formName: "Form 1120", obligationName: "C corporation income tax return", category: "INCOME_TAX",
    conditions: { taxClassifications: ["C_CORP"], fyeRequired: true }, frequency: "ANNUAL", dueRuleCode: "DOM:15:4", dueRuleDescription: "15th day of the 4th month after the tax year ends (April 15 for calendar-year). June 30 year-ends have a special rule — verify.", weekendRule: FED,
    sourceUrls: ["https://www.irs.gov/forms-pubs/about-form-1120", "https://www.irs.gov/instructions/i1120", PUB509], verificationStatus: NV, clientApprovalDefault: true, portalKind: "IRS_ESERVICES",
    requiredDocs: ["Prepared Form 1120 (PDF)", "Signed Form 8879-C", "IRS e-file acknowledgement"], serviceTypes: ["TAX_BUSINESS"], extensionMonths: 6,
  },
  {
    ruleKey: "FED_1065", jurisdictionLevel: "FEDERAL", jurisdictionName: "IRS", formName: "Form 1065 + Schedules K-1", obligationName: "Partnership return and partner K-1s", category: "INCOME_TAX",
    conditions: { taxClassifications: ["PARTNERSHIP"], fyeRequired: true }, frequency: "ANNUAL", dueRuleCode: "DOM:15:3", dueRuleDescription: "15th day of the 3rd month after the tax year ends (March 15 for calendar-year).", weekendRule: FED,
    sourceUrls: ["https://www.irs.gov/forms-pubs/about-form-1065", "https://www.irs.gov/instructions/i1065", PUB509], verificationStatus: NV, clientApprovalDefault: true, portalKind: "IRS_ESERVICES",
    requiredDocs: ["Prepared Form 1065 (PDF)", "Schedules K-1", "Signed Form 8879-PE", "IRS e-file acknowledgement"], serviceTypes: ["TAX_BUSINESS", "K1_PREPARATION"], extensionMonths: 6,
  },
  {
    ruleKey: "FED_SCHEDULE_C", jurisdictionLevel: "FEDERAL", jurisdictionName: "IRS", formName: "Schedule C (owner's Form 1040)", obligationName: "Sole proprietor business income on the owner's individual return", category: "INCOME_TAX",
    conditions: { taxClassifications: ["SCHEDULE_C", "DISREGARDED"], calendarYear: true }, frequency: "ANNUAL", dueRuleCode: "DOM:15:4", dueRuleDescription: "With the owner's Form 1040: April 15 after the calendar year.", weekendRule: FED,
    sourceUrls: ["https://www.irs.gov/forms-pubs/about-schedule-c-form-1040", PUB509], verificationStatus: NV, clientApprovalDefault: true, portalKind: "IRS_ESERVICES",
    requiredDocs: ["Prepared Form 1040 with Schedule C (PDF)", "Signed Form 8879", "IRS e-file acknowledgement"], serviceTypes: ["TAX_INDIVIDUAL"], extensionMonths: 6,
  },
  // --- Federal: payroll and information returns ---------------------------------------------
  {
    ruleKey: "FED_941", jurisdictionLevel: "FEDERAL", jurisdictionName: "IRS", formName: "Form 941", obligationName: "Employer's quarterly federal tax return", category: "WITHHOLDING_PAYROLL",
    conditions: { payroll: true }, frequency: "QUARTERLY", dueRuleCode: "EOM:1", dueRuleDescription: "Last day of the month after the quarter ends (Apr 30, Jul 31, Oct 31, Jan 31). Deposits follow the EFTPS schedule separately.", weekendRule: FED,
    sourceUrls: ["https://www.irs.gov/forms-pubs/about-form-941", "https://www.irs.gov/publications/p15", PUB509], verificationStatus: NV, portalKind: "IRS_EFTPS",
    requiredDocs: ["Payroll register for the quarter", "Form 941 (PDF)", "Filing confirmation", "EFTPS deposit confirmations"], serviceTypes: ["PAYROLL", "BOOKKEEPING"],
  },
  {
    ruleKey: "FED_940", jurisdictionLevel: "FEDERAL", jurisdictionName: "IRS", formName: "Form 940", obligationName: "Employer's annual federal unemployment (FUTA) return", category: "WITHHOLDING_PAYROLL",
    conditions: { payroll: true, calendarYear: true }, frequency: "ANNUAL", dueRuleCode: "FIXED:01-31:1", dueRuleDescription: "January 31 after the calendar year.", weekendRule: FED,
    sourceUrls: ["https://www.irs.gov/forms-pubs/about-form-940", PUB509], verificationStatus: NV, portalKind: "IRS_EFTPS",
    requiredDocs: ["Form 940 (PDF)", "Filing confirmation"], serviceTypes: ["PAYROLL", "BOOKKEEPING"],
  },
  {
    ruleKey: "FED_W2_W3", jurisdictionLevel: "FEDERAL", jurisdictionName: "IRS / SSA", formName: "Forms W-2 and W-3", obligationName: "Wage statements to employees and the Social Security Administration", category: "INFORMATION_RETURNS",
    conditions: { payroll: true, calendarYear: true }, frequency: "ANNUAL", dueRuleCode: "FIXED:01-31:1", dueRuleDescription: "January 31 after the calendar year (to employees and to SSA).", weekendRule: FED,
    sourceUrls: ["https://www.irs.gov/forms-pubs/about-form-w-2", "https://www.irs.gov/forms-pubs/about-form-w-3", PUB509], verificationStatus: NV, portalKind: "OTHER",
    requiredDocs: ["W-2s and W-3 (PDF)", "SSA submission confirmation"], serviceTypes: ["PAYROLL", "BOOKKEEPING"],
  },
  {
    ruleKey: "FED_1099_NEC", jurisdictionLevel: "FEDERAL", jurisdictionName: "IRS", formName: "Form 1099-NEC", obligationName: "Nonemployee compensation information returns", category: "INFORMATION_RETURNS",
    conditions: { issues1099: true, calendarYear: true }, frequency: "ANNUAL", dueRuleCode: "FIXED:01-31:1", dueRuleDescription: "January 31 after the calendar year (to recipients and the IRS, paper or electronic).", weekendRule: FED,
    sourceUrls: ["https://www.irs.gov/forms-pubs/about-form-1099-nec", "https://www.irs.gov/filing/e-file-information-returns-with-iris"], verificationStatus: NV, portalKind: "IRS_IRIS",
    requiredDocs: ["1099-NEC forms (PDF)", "IRIS/FIRE acknowledgement or 1096 transmittal copy"], serviceTypes: ["BOOKKEEPING", "PAYROLL"],
  },
  {
    ruleKey: "FED_1099_MISC_1096", jurisdictionLevel: "FEDERAL", jurisdictionName: "IRS", formName: "Form 1099-MISC (+ Form 1096 if filed on paper)", obligationName: "Miscellaneous information returns", category: "INFORMATION_RETURNS",
    conditions: { issues1099: true, calendarYear: true }, frequency: "ANNUAL", dueRuleCode: "FIXED:02-28:1", dueRuleDescription: "To the IRS: end of February if on paper (with Form 1096), March 31 if electronic. Recipient copies generally January 31.", weekendRule: FED,
    sourceUrls: ["https://www.irs.gov/forms-pubs/about-form-1099-misc", "https://www.irs.gov/forms-pubs/about-form-1096"], verificationStatus: NV, portalKind: "IRS_IRIS",
    requiredDocs: ["1099-MISC forms (PDF)", "Form 1096 (paper) or IRIS/FIRE acknowledgement"], serviceTypes: ["BOOKKEEPING", "PAYROLL"],
    notes: "Electronic filing is required at the IRS threshold (10+ information returns in aggregate). Verify which date applies.",
  },
  // --- Federal: nonprofit (reuses the Nonprofit Filings tracker's form choice and due-date math) -
  {
    ruleKey: "FED_990N", jurisdictionLevel: "FEDERAL", jurisdictionName: "IRS", formName: "Form 990-N (e-Postcard)", obligationName: "Annual exempt organization e-Postcard", category: "NONPROFIT",
    conditions: { nonprofit: true, nonprofitForms: ["990-N"], fyeRequired: true }, frequency: "ANNUAL", dueRuleCode: "DOM:15:5", dueRuleDescription: "15th day of the 5th month after the tax year ends. No extension.", weekendRule: FED,
    sourceUrls: ["https://www.irs.gov/charities-non-profits/annual-exempt-organization-return-who-must-file", "https://www.irs.gov/charities-non-profits/annual-exempt-organization-return-due-date"], verificationStatus: NV, portalKind: "IRS_ESERVICES",
    requiredDocs: ["990-N submission confirmation"], serviceTypes: ["TAX_NONPROFIT", "NONPROFIT_SERVICES"],
  },
  {
    ruleKey: "FED_990EZ", jurisdictionLevel: "FEDERAL", jurisdictionName: "IRS", formName: "Form 990-EZ", obligationName: "Short-form exempt organization return", category: "NONPROFIT",
    conditions: { nonprofit: true, nonprofitForms: ["990-EZ"], fyeRequired: true }, frequency: "ANNUAL", dueRuleCode: "DOM:15:5", dueRuleDescription: "15th day of the 5th month after the tax year ends (Form 8868 gives 6 months).", weekendRule: FED,
    sourceUrls: ["https://www.irs.gov/charities-non-profits/annual-exempt-organization-return-who-must-file", "https://www.irs.gov/charities-non-profits/annual-exempt-organization-return-due-date"], verificationStatus: NV, clientApprovalDefault: true, portalKind: "OTHER",
    requiredDocs: ["Prepared Form 990-EZ (PDF)", "Signed Form 8879-EO", "IRS acknowledgement"], serviceTypes: ["TAX_NONPROFIT", "NONPROFIT_SERVICES"], extensionMonths: 6,
  },
  {
    ruleKey: "FED_990", jurisdictionLevel: "FEDERAL", jurisdictionName: "IRS", formName: "Form 990", obligationName: "Exempt organization return", category: "NONPROFIT",
    conditions: { nonprofit: true, nonprofitForms: ["990"], nonprofitFormFallback: true, fyeRequired: true }, frequency: "ANNUAL", dueRuleCode: "DOM:15:5", dueRuleDescription: "15th day of the 5th month after the tax year ends (Form 8868 gives 6 months). When the form isn't determined yet, this tracks the 990-N / 990-EZ / 990 determination.", weekendRule: FED,
    sourceUrls: ["https://www.irs.gov/charities-non-profits/annual-exempt-organization-return-who-must-file", "https://www.irs.gov/charities-non-profits/annual-exempt-organization-return-due-date", "https://www.irs.gov/charities-non-profits/extension-of-time-to-file-exempt-organization-returns"], verificationStatus: NV, clientApprovalDefault: true, portalKind: "OTHER",
    requiredDocs: ["Prepared Form 990 (PDF)", "Signed Form 8879-EO", "IRS acknowledgement"], serviceTypes: ["TAX_NONPROFIT", "NONPROFIT_SERVICES"], extensionMonths: 6,
  },
  {
    ruleKey: "FED_7004", jurisdictionLevel: "FEDERAL", jurisdictionName: "IRS", formName: "Form 7004", obligationName: "Automatic extension for business returns (1120-S, 1120, 1065)", category: "EXTENSION",
    conditions: { manualOnly: true }, frequency: "ANNUAL", dueRuleCode: "MANUAL", dueRuleDescription: "By the return's original due date. Extends time to file, not to pay.", weekendRule: FED,
    sourceUrls: ["https://www.irs.gov/forms-pubs/about-form-7004"], verificationStatus: NV, portalKind: "OTHER", requiredDocs: ["Form 7004 acknowledgement"], serviceTypes: ["TAX_BUSINESS"],
    notes: "Recorded on the return's period (Record extension) — not generated as its own obligation.", extensionMonths: 6,
  },
  {
    ruleKey: "FED_8868", jurisdictionLevel: "FEDERAL", jurisdictionName: "IRS", formName: "Form 8868", obligationName: "Extension for exempt organization returns (990, 990-EZ, 990-PF)", category: "EXTENSION",
    conditions: { manualOnly: true }, frequency: "ANNUAL", dueRuleCode: "MANUAL", dueRuleDescription: "By the return's original due date. Not available for Form 990-N.", weekendRule: FED,
    sourceUrls: ["https://www.irs.gov/forms-pubs/about-form-8868", "https://www.irs.gov/charities-non-profits/extension-of-time-to-file-exempt-organization-returns"], verificationStatus: NV, portalKind: "OTHER", requiredDocs: ["Form 8868 acknowledgement"], serviceTypes: ["TAX_NONPROFIT"],
    notes: "Recorded on the return's period (Record extension) — not generated as its own obligation.", extensionMonths: 6,
  },
  // --- Alabama: income and privilege tax -------------------------------------------------------
  {
    ruleKey: "AL_20S", jurisdictionLevel: "STATE", jurisdictionName: "Alabama Department of Revenue", formName: "Alabama Form 20S", obligationName: "Alabama S corporation information/tax return", category: "INCOME_TAX",
    conditions: { taxClassifications: ["S_CORP"], states: ["AL"], fyeRequired: true }, frequency: "ANNUAL", dueRuleCode: "DOM:15:3", dueRuleDescription: "15th day of the 3rd month after the tax year ends (candidate — verify).", weekendRule: AL,
    sourceUrls: ["https://www.revenue.alabama.gov/forms/", MAT], verificationStatus: NV, clientApprovalDefault: true, portalKind: "MAT",
    requiredDocs: ["Prepared Form 20S (PDF)", "Schedules K-1 (AL)", "ALDOR acknowledgement"], serviceTypes: ["TAX_BUSINESS"], extensionMonths: 6,
  },
  {
    ruleKey: "AL_20C", jurisdictionLevel: "STATE", jurisdictionName: "Alabama Department of Revenue", formName: "Alabama Form 20C", obligationName: "Alabama corporation income tax return", category: "INCOME_TAX",
    conditions: { taxClassifications: ["C_CORP"], states: ["AL"], fyeRequired: true }, frequency: "ANNUAL", dueRuleCode: "DOM:15:4", dueRuleDescription: "15th day of the 4th month after the tax year ends (candidate — verify).", weekendRule: AL,
    sourceUrls: ["https://www.revenue.alabama.gov/forms/", MAT], verificationStatus: NV, clientApprovalDefault: true, portalKind: "MAT",
    requiredDocs: ["Prepared Form 20C (PDF)", "ALDOR acknowledgement"], serviceTypes: ["TAX_BUSINESS"], extensionMonths: 6,
  },
  {
    ruleKey: "AL_65", jurisdictionLevel: "STATE", jurisdictionName: "Alabama Department of Revenue", formName: "Alabama Form 65", obligationName: "Alabama partnership/LLC return", category: "INCOME_TAX",
    conditions: { taxClassifications: ["PARTNERSHIP"], states: ["AL"], fyeRequired: true }, frequency: "ANNUAL", dueRuleCode: "DOM:15:3", dueRuleDescription: "15th day of the 3rd month after the tax year ends (candidate — verify).", weekendRule: AL,
    sourceUrls: ["https://www.revenue.alabama.gov/forms/", MAT], verificationStatus: NV, clientApprovalDefault: true, portalKind: "MAT",
    requiredDocs: ["Prepared Form 65 (PDF)", "ALDOR acknowledgement"], serviceTypes: ["TAX_BUSINESS"], extensionMonths: 6,
  },
  {
    ruleKey: "AL_BPT_PPT", jurisdictionLevel: "STATE", jurisdictionName: "Alabama Department of Revenue", formName: "Alabama Business Privilege Tax Return (Form PPT)", obligationName: "Business privilege tax — pass-through entities (if filing is required)", category: "INCOME_TAX",
    conditions: { taxClassifications: ["S_CORP", "PARTNERSHIP", "DISREGARDED"], states: ["AL"], fyeRequired: true }, frequency: "ANNUAL", dueRuleCode: "DOM:15:3", dueRuleDescription: "With the entity's Alabama income tax return — 15th day of the 3rd month after year end for pass-through entities (candidate — verify).", weekendRule: AL,
    sourceUrls: ["https://www.revenue.alabama.gov/business-privilege-tax/", "https://www.revenue.alabama.gov/forms/", MAT], verificationStatus: NV, clientApprovalDefault: true, portalKind: "MAT",
    requiredDocs: ["Form PPT (PDF) or determination that no return is required", "ALDOR acknowledgement"], serviceTypes: ["TAX_BUSINESS"],
    notes: "For recent tax years Alabama no longer requires a return when the privilege tax is $100 or less — verify the threshold and whether this entity must file.",
  },
  {
    ruleKey: "AL_BPT_CPT", jurisdictionLevel: "STATE", jurisdictionName: "Alabama Department of Revenue", formName: "Alabama Business Privilege Tax Return (Form CPT)", obligationName: "Business privilege tax — corporations (if filing is required)", category: "INCOME_TAX",
    conditions: { taxClassifications: ["C_CORP"], states: ["AL"], fyeRequired: true }, frequency: "ANNUAL", dueRuleCode: "DOM:15:4", dueRuleDescription: "With the corporation's Alabama income tax return (candidate — verify).", weekendRule: AL,
    sourceUrls: ["https://www.revenue.alabama.gov/business-privilege-tax/", MAT], verificationStatus: NV, clientApprovalDefault: true, portalKind: "MAT",
    requiredDocs: ["Form CPT (PDF) or determination that no return is required", "ALDOR acknowledgement"], serviceTypes: ["TAX_BUSINESS"],
    notes: "Verify the no-return threshold for the tax year.",
  },
  // --- Alabama: sales/use and withholding ------------------------------------------------------
  {
    ruleKey: "AL_SALES_2100", jurisdictionLevel: "STATE", jurisdictionName: "Alabama Department of Revenue", formName: "Alabama sales tax return (Form 2100) via My Alabama Taxes / ONE SPOT", obligationName: "State sales tax", category: "SALES_USE",
    conditions: { states: ["AL"], activityTagsAny: SELLS, registration: { type: "SALES_USE", jurisdiction: "Alabama", missing: "Alabama sales tax account (ALDOR) not recorded" } }, frequency: "ACCOUNT:MONTHLY", dueRuleCode: "DOM:20:1", dueRuleDescription: "20th day of the month after the reporting period (candidate — verify; filing frequency comes from the ALDOR account).", weekendRule: AL,
    sourceUrls: ["https://www.revenue.alabama.gov/sales-use/", "https://www.revenue.alabama.gov/sales-use/one-spot/", MAT], verificationStatus: NV, portalKind: "MAT",
    requiredDocs: ["Sales summary for the period", "Return confirmation", "Payment confirmation"], serviceTypes: ["BOOKKEEPING", "TAX_BUSINESS"],
  },
  {
    ruleKey: "AL_WH_A6", jurisdictionLevel: "STATE", jurisdictionName: "Alabama Department of Revenue", formName: "Alabama Form A-6 (monthly withholding)", obligationName: "State income tax withholding — monthly filers", category: "WITHHOLDING_PAYROLL",
    conditions: { payroll: true, states: ["AL"], registration: { type: "WITHHOLDING", jurisdiction: "Alabama", frequencies: ["MONTHLY"], fallbackOnUnknownFrequency: true, missing: "Alabama withholding account (ALDOR) not recorded" } }, frequency: "ACCOUNT:MONTHLY", dueRuleCode: "DOM:15:1", dueRuleDescription: "15th day of the month after the month withheld (candidate — verify).", weekendRule: AL,
    sourceUrls: ["https://www.revenue.alabama.gov/individual-corporate/withholding-tax/", MAT], verificationStatus: NV, portalKind: "MAT",
    requiredDocs: ["Payroll register for the month", "A-6 confirmation", "Payment confirmation"], serviceTypes: ["PAYROLL", "BOOKKEEPING"],
  },
  {
    ruleKey: "AL_WH_A1", jurisdictionLevel: "STATE", jurisdictionName: "Alabama Department of Revenue", formName: "Alabama Form A-1 (quarterly withholding)", obligationName: "State income tax withholding — quarterly filers", category: "WITHHOLDING_PAYROLL",
    conditions: { payroll: true, states: ["AL"], registration: { type: "WITHHOLDING", jurisdiction: "Alabama", frequencies: ["QUARTERLY"], missing: "Alabama withholding account (ALDOR) not recorded" } }, frequency: "ACCOUNT:QUARTERLY", dueRuleCode: "EOM:1", dueRuleDescription: "Last day of the month after the quarter (candidate — verify).", weekendRule: AL,
    sourceUrls: ["https://www.revenue.alabama.gov/individual-corporate/withholding-tax/", MAT], verificationStatus: NV, portalKind: "MAT",
    requiredDocs: ["Payroll register for the quarter", "A-1 confirmation", "Payment confirmation"], serviceTypes: ["PAYROLL", "BOOKKEEPING"],
  },
  {
    ruleKey: "AL_WH_A3", jurisdictionLevel: "STATE", jurisdictionName: "Alabama Department of Revenue", formName: "Alabama Form A-3 (annual reconciliation)", obligationName: "Annual withholding reconciliation with W-2s", category: "WITHHOLDING_PAYROLL",
    conditions: { payroll: true, states: ["AL"], calendarYear: true }, frequency: "ANNUAL", dueRuleCode: "FIXED:01-31:1", dueRuleDescription: "January 31 after the calendar year (candidate — verify).", weekendRule: AL,
    sourceUrls: ["https://www.revenue.alabama.gov/individual-corporate/withholding-tax/", MAT], verificationStatus: NV, portalKind: "MAT",
    requiredDocs: ["A-3 confirmation", "W-2 upload confirmation"], serviceTypes: ["PAYROLL", "BOOKKEEPING"],
  },
  {
    ruleKey: "AL_SALES_LICENSE_RENEWAL", jurisdictionLevel: "STATE", jurisdictionName: "Alabama Department of Revenue", formName: "Alabama sales tax license renewal", obligationName: "State sales tax license renewal", category: "LICENSE_PERMIT",
    conditions: { states: ["AL"], activityTagsAny: SELLS }, frequency: "ANNUAL", dueRuleCode: "FIXED:12-31:0", dueRuleDescription: "Annual renewal (candidate: by December 31 — verify the renewal window and date).", weekendRule: "NO_ADJUSTMENT",
    sourceUrls: ["https://www.revenue.alabama.gov/sales-use/", MAT], verificationStatus: NV, portalKind: "MAT", requiredDocs: ["Renewed license copy"], serviceTypes: ["BOOKKEEPING", "TAX_BUSINESS"],
  },
  {
    ruleKey: "AL_SOS_NONPROFIT", jurisdictionLevel: "STATE", jurisdictionName: "Alabama Secretary of State", formName: "Secretary of State annual filing (if applicable)", obligationName: "Nonprofit state annual filing", category: "ANNUAL_REPORT",
    conditions: { nonprofit: true, formationStates: ["AL"] }, frequency: "ANNUAL", dueRuleCode: "MANUAL", dueRuleDescription: "Whether an annual filing is required and when — verify with the Secretary of State.", weekendRule: AL,
    sourceUrls: ["https://www.sos.alabama.gov/business-entities"], verificationStatus: NV, portalKind: "AL_SOS", requiredDocs: ["Filing confirmation or note that none is required"], serviceTypes: ["NONPROFIT_SERVICES", "BUSINESS_FORMATION"],
  },
  {
    ruleKey: "AL_AG_CHARITABLE", jurisdictionLevel: "STATE", jurisdictionName: "Alabama Attorney General — Consumer Interest (Charities)", formName: "Charitable organization registration / renewal (if applicable)", obligationName: "Charitable solicitation registration", category: "NONPROFIT",
    conditions: { nonprofit: true, states: ["AL"] }, frequency: "ANNUAL", dueRuleCode: "MANUAL", dueRuleDescription: "Annual renewal tied to the registration — verify whether the organization must register (exemptions apply) and its renewal date.", weekendRule: AL,
    sourceUrls: ["https://www.alabamaag.gov/charities/"], verificationStatus: NV, portalKind: "OTHER", requiredDocs: ["Registration or exemption confirmation"], serviceTypes: ["NONPROFIT_SERVICES"],
  },
  {
    ruleKey: "AL_BPP_JEFFERSON", jurisdictionLevel: "COUNTY", jurisdictionName: "Jefferson County Tax Assessor", formName: "Business personal property return", obligationName: "Business personal property reporting (if applicable)", category: "PROPERTY",
    conditions: { counties: ["Jefferson"] }, frequency: "ANNUAL", dueRuleCode: "FIXED:12-31:0", dueRuleDescription: "Annual return of business personal property (candidate: due by December 31 — verify).", weekendRule: "NO_ADJUSTMENT",
    sourceUrls: ["https://www.jccal.org/"], verificationStatus: NV, portalKind: "OTHER", requiredDocs: ["Fixed-asset listing", "Return confirmation"], serviceTypes: ["BOOKKEEPING", "TAX_BUSINESS"],
  },
  // --- Jefferson County ------------------------------------------------------------------------
  {
    ruleKey: "JEFF_SALES_USE", jurisdictionLevel: "COUNTY", jurisdictionName: "Jefferson County Revenue Department", formName: "Jefferson County sales/use tax return", obligationName: "County sales/use tax", category: "SALES_USE",
    conditions: { counties: ["Jefferson"], activityTagsAny: SELLS, registration: { type: "SALES_USE", jurisdiction: "Jefferson County", missing: "Jefferson County sales/use tax account not recorded" } }, frequency: "ACCOUNT:MONTHLY", dueRuleCode: "DOM:20:1", dueRuleDescription: "20th day of the month after the reporting period (candidate — verify; confirm who administers it: county direct or ONE SPOT).", weekendRule: AL,
    sourceUrls: ["https://www.jccal.org/"], verificationStatus: NV, portalKind: "JEFFCO_SRT", requiredDocs: ["Sales summary for the period", "Return confirmation", "Payment confirmation"], serviceTypes: ["BOOKKEEPING", "TAX_BUSINESS"],
  },
  {
    ruleKey: "JEFF_BUSINESS_LICENSE", jurisdictionLevel: "COUNTY", jurisdictionName: "Jefferson County License Department", formName: "Jefferson County business license renewal", obligationName: "County/state business license renewal", category: "LICENSE_PERMIT",
    conditions: { counties: ["Jefferson"] }, frequency: "ANNUAL", dueRuleCode: "FIXED:10-31:0", dueRuleDescription: "Annual renewal (candidate: license year Oct 1 – Sep 30, delinquent after Oct 31 — verify).", weekendRule: AL,
    sourceUrls: ["https://www.jccal.org/"], verificationStatus: NV, portalKind: "LICENSING", requiredDocs: ["Renewed license copy"], serviceTypes: ["BOOKKEEPING", "BUSINESS_FORMATION"],
  },
  {
    ruleKey: "JEFF_ENTITY_LICENSE", jurisdictionLevel: "COUNTY", jurisdictionName: "Jefferson County License Department", formName: "Jefferson County Entity Business License (if applicable)", obligationName: "Entity business license", category: "LICENSE_PERMIT",
    conditions: { counties: ["Jefferson"], entityKinds: ["LLC", "CORPORATION", "PARTNERSHIP"] }, frequency: "ANNUAL", dueRuleCode: "FIXED:10-31:0", dueRuleDescription: "Annual (candidate — verify whether it applies to this entity and its due date).", weekendRule: AL,
    sourceUrls: ["https://www.jccal.org/"], verificationStatus: NV, portalKind: "LICENSING", requiredDocs: ["License copy or note that it doesn't apply"], serviceTypes: ["BOOKKEEPING", "BUSINESS_FORMATION"],
  },
  {
    ruleKey: "JEFF_RESTAURANT_ALCOHOL", jurisdictionLevel: "COUNTY", jurisdictionName: "Jefferson County Revenue Department", formName: "Jefferson County restaurant/alcohol beverage tax (if applicable)", obligationName: "County beverage/alcohol tax", category: "SALES_USE",
    conditions: { counties: ["Jefferson"], tagDecision: { yes: "alcohol", no: "no-alcohol", missing: "Whether the business sells alcohol is not recorded" } }, frequency: "ACCOUNT:MONTHLY", dueRuleCode: "DOM:20:1", dueRuleDescription: "Monthly (candidate — verify the tax, its rate base and due date).", weekendRule: AL,
    sourceUrls: ["https://www.jccal.org/"], verificationStatus: NV, portalKind: "JEFFCO_SRT", requiredDocs: ["Beverage sales summary", "Return confirmation"], serviceTypes: ["BOOKKEEPING"],
  },
  // --- City of Birmingham ------------------------------------------------------------------------
  {
    ruleKey: "BHM_BUSINESS_LICENSE", jurisdictionLevel: "CITY", jurisdictionName: "City of Birmingham", formName: "Birmingham business license renewal", obligationName: "Municipal business license", category: "LICENSE_PERMIT",
    conditions: { cities: ["Birmingham"] }, frequency: "ANNUAL", dueRuleCode: "FIXED:01-31:0", dueRuleDescription: "Annual renewal (candidate: by January 31 of the license year — verify).", weekendRule: AL,
    sourceUrls: ["https://www.birminghamal.gov/"], verificationStatus: NV, portalKind: "CITY_BIRMINGHAM", requiredDocs: ["Gross receipts for the prior year", "Renewed license copy"], serviceTypes: ["BOOKKEEPING", "BUSINESS_FORMATION"],
  },
  {
    ruleKey: "BHM_OCCUPATIONAL", jurisdictionLevel: "CITY", jurisdictionName: "City of Birmingham", formName: "Birmingham occupational tax return", obligationName: "Occupational (license) tax withheld from wages", category: "WITHHOLDING_PAYROLL",
    conditions: { cities: ["Birmingham"], payroll: true, registration: { type: "LOCAL", jurisdiction: "Birmingham", missing: "Birmingham occupational tax account not recorded" } }, frequency: "ACCOUNT:MONTHLY", dueRuleCode: "EOM:1", dueRuleDescription: "Candidate: by the last day of the month after the period — verify frequency and due date.", weekendRule: AL,
    sourceUrls: ["https://www.birminghamal.gov/"], verificationStatus: NV, portalKind: "CITY_BIRMINGHAM", requiredDocs: ["Payroll register", "Return confirmation"], serviceTypes: ["PAYROLL", "BOOKKEEPING"],
  },
  {
    ruleKey: "BHM_SALES_USE", jurisdictionLevel: "CITY", jurisdictionName: "City of Birmingham", formName: "Birmingham sales/use tax return", obligationName: "Municipal sales/use tax", category: "SALES_USE",
    conditions: { cities: ["Birmingham"], activityTagsAny: SELLS, registration: { type: "SALES_USE", jurisdiction: "Birmingham", missing: "Birmingham sales/use tax account not recorded" } }, frequency: "ACCOUNT:MONTHLY", dueRuleCode: "DOM:20:1", dueRuleDescription: "20th day of the month after the reporting period (candidate — verify; confirm whether filed with the city or through ONE SPOT).", weekendRule: AL,
    sourceUrls: ["https://www.birminghamal.gov/", "https://www.revenue.alabama.gov/sales-use/one-spot/"], verificationStatus: NV, portalKind: "CITY_BIRMINGHAM", requiredDocs: ["Sales summary", "Return confirmation", "Payment confirmation"], serviceTypes: ["BOOKKEEPING", "TAX_BUSINESS"],
  },
  {
    ruleKey: "BHM_BEVERAGE", jurisdictionLevel: "CITY", jurisdictionName: "City of Birmingham", formName: "Birmingham beverage tax (if applicable)", obligationName: "Municipal beverage tax", category: "SALES_USE",
    conditions: { cities: ["Birmingham"], tagDecision: { yes: "alcohol", no: "no-alcohol", missing: "Whether the business sells alcohol is not recorded" } }, frequency: "ACCOUNT:MONTHLY", dueRuleCode: "DOM:20:1", dueRuleDescription: "Monthly (candidate — verify).", weekendRule: AL,
    sourceUrls: ["https://www.birminghamal.gov/"], verificationStatus: NV, portalKind: "CITY_BIRMINGHAM", requiredDocs: ["Beverage sales summary", "Return confirmation"], serviceTypes: ["BOOKKEEPING"],
  },
  // --- City of Huntsville -------------------------------------------------------------------------
  {
    ruleKey: "HSV_SALES_USE", jurisdictionLevel: "CITY", jurisdictionName: "City of Huntsville", formName: "Huntsville sales/use tax return", obligationName: "Municipal sales/use tax", category: "SALES_USE",
    conditions: { cities: ["Huntsville"], activityTagsAny: SELLS, registration: { type: "SALES_USE", jurisdiction: "Huntsville", missing: "Huntsville sales/use tax account not recorded" } }, frequency: "ACCOUNT:MONTHLY", dueRuleCode: "DOM:20:1", dueRuleDescription: "20th day of the month after the reporting period (candidate — verify).", weekendRule: AL,
    sourceUrls: ["https://www.huntsvilleal.gov/"], verificationStatus: NV, portalKind: "CITY_HUNTSVILLE", requiredDocs: ["Sales summary", "Return confirmation", "Payment confirmation"], serviceTypes: ["BOOKKEEPING", "TAX_BUSINESS"],
  },
  {
    ruleKey: "HSV_LIQUOR", jurisdictionLevel: "CITY", jurisdictionName: "City of Huntsville", formName: "Huntsville liquor tax return (paper)", obligationName: "Municipal liquor tax", category: "SALES_USE",
    conditions: { cities: ["Huntsville"], tagDecision: { yes: "alcohol", no: "no-alcohol", missing: "Whether the business sells alcohol is not recorded" } }, frequency: "ACCOUNT:MONTHLY", dueRuleCode: "DOM:20:1", dueRuleDescription: "Monthly, filed on paper (candidate — verify).", weekendRule: AL,
    sourceUrls: ["https://www.huntsvilleal.gov/"], verificationStatus: NV, portalKind: "OTHER", requiredDocs: ["Paper return copy", "Mailing/hand-delivery proof"], serviceTypes: ["BOOKKEEPING"],
  },
  // --- Health / food service ------------------------------------------------------------------------
  {
    ruleKey: "JCDH_FOOD_PERMIT", jurisdictionLevel: "COUNTY", jurisdictionName: "Jefferson County Department of Health", formName: "Food service establishment permit renewal", obligationName: "Restaurant health / food-service permit", category: "LICENSE_PERMIT",
    conditions: { counties: ["Jefferson"], activityTagsAny: ["restaurant", "food_service"] }, frequency: "ANNUAL", dueRuleCode: "FIXED:12-31:0", dueRuleDescription: "Annual permit (candidate: calendar-year permit renewed by December 31 — verify).", weekendRule: "NO_ADJUSTMENT",
    sourceUrls: ["https://www.jcdh.org/", "https://www.alabamapublichealth.gov/foodsafety/"], verificationStatus: NV, portalKind: "LICENSING", requiredDocs: ["Permit copy", "Inspection report"], serviceTypes: ["BOOKKEEPING", "BUSINESS_FORMATION"],
  },
];

export const RULE_KEYS = RULES.map((r) => r.ruleKey);

export type TemplateSeed = { key: string; name: string; description: string; ruleKeys: string[]; activityTags: string[] };

export const INDUSTRY_TEMPLATES: TemplateSeed[] = [
  { key: "restaurant", name: "Restaurant", description: "Food service: sales taxes, health permit, beverage taxes if alcohol is sold, licenses, payroll.", activityTags: ["restaurant", "food_service", "sells_taxable"], ruleKeys: ["AL_SALES_2100", "JEFF_SALES_USE", "BHM_SALES_USE", "HSV_SALES_USE", "AL_SALES_LICENSE_RENEWAL", "JCDH_FOOD_PERMIT", "JEFF_RESTAURANT_ALCOHOL", "BHM_BEVERAGE", "HSV_LIQUOR", "BHM_BUSINESS_LICENSE", "JEFF_BUSINESS_LICENSE", "AL_BPP_JEFFERSON"] },
  { key: "retail", name: "Retail", description: "Taxable sales of goods: state, county and city sales tax, license renewals, property.", activityTags: ["retail", "sells_taxable"], ruleKeys: ["AL_SALES_2100", "JEFF_SALES_USE", "BHM_SALES_USE", "HSV_SALES_USE", "AL_SALES_LICENSE_RENEWAL", "BHM_BUSINESS_LICENSE", "JEFF_BUSINESS_LICENSE", "AL_BPP_JEFFERSON"] },
  { key: "construction", name: "Construction", description: "Contractors: 1099 reporting, payroll, licenses; contractor-specific licensing to verify.", activityTags: ["construction"], ruleKeys: ["FED_1099_NEC", "FED_941", "AL_WH_A6", "JEFF_BUSINESS_LICENSE", "BHM_BUSINESS_LICENSE", "AL_BPP_JEFFERSON"] },
  { key: "transportation", name: "Transportation", description: "Trucking/transport: payroll, 1099s, licenses; IFTA/UCR/HVUT to verify (not in the library yet).", activityTags: ["transportation"], ruleKeys: ["FED_941", "FED_1099_NEC", "JEFF_BUSINESS_LICENSE", "AL_BPP_JEFFERSON"] },
  { key: "real_estate", name: "Real estate", description: "Rental/real estate: 1099s, licenses, property.", activityTags: ["real_estate"], ruleKeys: ["FED_1099_NEC", "FED_1099_MISC_1096", "BHM_BUSINESS_LICENSE", "JEFF_BUSINESS_LICENSE"] },
  { key: "professional_services", name: "Professional services", description: "Service businesses: income tax, 1099s, business licenses.", activityTags: ["professional_services"], ruleKeys: ["FED_SCHEDULE_C", "FED_1099_NEC", "BHM_BUSINESS_LICENSE", "JEFF_BUSINESS_LICENSE"] },
  { key: "nonprofit", name: "Nonprofit", description: "990-series determination, charitable registration, state filings, exemption documents.", activityTags: ["nonprofit"], ruleKeys: ["FED_990N", "FED_990EZ", "FED_990", "AL_AG_CHARITABLE", "AL_SOS_NONPROFIT"] },
];

export const CATEGORY_LABELS: Record<string, string> = {
  INCOME_TAX: "Income tax",
  SALES_USE: "Sales/use",
  WITHHOLDING_PAYROLL: "Withholding/payroll",
  INFORMATION_RETURNS: "Information returns",
  LICENSE_PERMIT: "License/permit",
  PROPERTY: "Property",
  NONPROFIT: "Nonprofit",
  ANNUAL_REPORT: "Annual report",
  EXTENSION: "Extension",
  OTHER: "Other",
};
