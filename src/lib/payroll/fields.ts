// Shared, browser-safe labels for payroll setup and register imports.

/** The payroll system a business uses. payrollProvider (free text) keeps the display name. */
export const PAYROLL_SYSTEMS = {
  ADP_RUN: "ADP RUN",
  ADP_WFN: "ADP Workforce Now",
  PAYCHEX_FLEX: "Paychex Flex",
  GUSTO: "Gusto",
  OTHER: "Other",
} as const;
export type PayrollSystem = keyof typeof PAYROLL_SYSTEMS;
export const isPayrollSystem = (v: string | null | undefined): v is PayrollSystem => !!v && v in PAYROLL_SYSTEMS;

/** How payroll data reaches the firm. */
export const PAYROLL_CONNECTIONS = {
  REPORT_IMPORT: "Payroll register import (works today)",
  API: "Direct API connection (after provider approval)",
} as const;

/** Columns of a payroll register the importer understands. */
export const PAYROLL_FIELDS = {
  checkDate: "Check / pay date",
  periodStart: "Pay period start",
  periodEnd: "Pay period end",
  employee: "Employee name",
  hours: "Hours",
  gross: "Gross wages",
  federalWh: "Federal income tax withheld",
  ssEe: "Social Security (employee)",
  medicareEe: "Medicare (employee)",
  stateWh: "State income tax withheld",
  otherEeTax: "Other employee taxes (local, SDI…)",
  employerTax: "Employer taxes (ER SS, ER Medicare, FUTA, SUTA)",
  deductions: "Deductions (401k, insurance, garnishments…)",
  netPay: "Net pay",
} as const;
export type PayrollField = keyof typeof PAYROLL_FIELDS;
export const isPayrollField = (v: string): v is PayrollField => v in PAYROLL_FIELDS;

/** Presets for the importer (header names commonly seen in each provider's register/journal export). */
export const PAYROLL_PRESETS = {
  ADP_RUN: "ADP RUN — Payroll Register / Payroll Details",
  ADP_WFN: "ADP Workforce Now — Payroll Register",
  PAYCHEX_FLEX: "Paychex Flex — Payroll Journal",
  OTHER: "Other layout (map the columns yourself)",
} as const;
export type PayrollPreset = keyof typeof PAYROLL_PRESETS;

/** Pay run statuses, as the office and owners see them. */
export const RUN_STATUS = {
  DRAFT: "Draft — office review",
  AWAITING_APPROVAL: "Awaiting Client Approval",
  DENIED: "Changes Requested",
  FULLY_APPROVED: "Client Approved",
  SUBMITTED: "Submitted for Processing",
  // Future (provider API): the provider acknowledged the pay data. Not processed yet.
  PROVIDER_ACCEPTED: "Accepted by provider — awaiting processing",
  PROCESSED: "Processed by provider",
  DISCARDED: "Discarded",
} as const;

export const NOTIFY_CHANNELS = { EMAIL: "Email", SMS: "Text", BOTH: "Text and email" } as const;
export type NotifyChannel = keyof typeof NOTIFY_CHANNELS;

/**
 * Each provider's own sign-in page, opened in a new tab from the client's payroll section so staff
 * can download the register without leaving Client Connect. Client Connect never signs in for them.
 */
export const PAYROLL_PROVIDER_LOGIN: Partial<Record<PayrollSystem, { label: string; url: string }>> = {
  ADP_RUN: { label: "Open ADP RUN", url: "https://runpayroll.adp.com/" },
  ADP_WFN: { label: "Open ADP Workforce Now", url: "https://workforcenow.adp.com/" },
  PAYCHEX_FLEX: { label: "Open Paychex Flex", url: "https://myapps.paychex.com/" },
  GUSTO: { label: "Open Gusto", url: "https://app.gusto.com/" },
};
