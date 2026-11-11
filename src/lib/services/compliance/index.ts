/**
 * Tax & Compliance Center — public service API. Other workspaces (e.g. ADP Payroll & Taxes)
 * should read through these functions (they enforce compliance access) and link to the board:
 *   /compliance                       Tax Due Board (filters as query params, e.g. ?clientId=…&segment=payroll)
 *   /compliance/entities/<entityId>   entity profile, accounts & portals, obligations, calendar
 *   /compliance/periods/<periodId>    one filing period (approval, evidence, Open portal)
 */
export { listObligations, type ObligationFilter } from "./obligations";
export { taxDueBoard, missingInfoReport, type BoardFilter } from "./views";
export { complianceAccess } from "./access";
export const COMPLIANCE_BOARD_PATH = "/compliance";
