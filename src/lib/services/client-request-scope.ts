import type { Prisma } from "@prisma/client";

/**
 * Which document requests a client may be shown.
 *
 * 1. Routine bank and credit-card statements are never asked of the client. The firm has
 *    authorized access and retrieves statements itself, then files them for the account and
 *    period. That filing is a Document with category BOOKKEEPING, docType BANK_STATEMENT or
 *    CARD_STATEMENT, bookkeepingAccountId set to the registered account, the period in
 *    year/month and/or periodStart–periodEnd, uploadedByPortalId null, and a clean scan — see
 *    `staffUploadStatement` and `officeStatementWhere`. The statement rules that once asked
 *    clients (BANK_STATEMENTS, CARD_STATEMENTS) are retired, and Coetha no longer drafts
 *    statement requests: a missing statement becomes an internal office task. Old routine
 *    requests are kept as history and hidden here, never deleted or changed. A statement request
 *    a staff member writes by hand (a one-off, not routine) is still shown.
 * 2. Bookkeeping requests (a bookkeeping month's requests, or the "What we need — bookkeeping"
 *    rules) are shown only to a client on the bookkeeping service (hasBookkeepingService).
 */

export const STATEMENT_DOC_TYPES = ["BANK_STATEMENT", "CARD_STATEMENT"];
/** The retired "What we need" rules that asked the client for bank and card statements. */
export const OFFICE_RETRIEVED_RULE_KEYS = ["BANK_STATEMENTS", "CARD_STATEMENTS"];
/** Rule keys of the "What we need — bookkeeping" requests (kind BOOKKEEPING), retired ones included. */
export const BOOKKEEPING_RULE_KEYS = ["BANK_STATEMENTS", "CARD_STATEMENTS", "RECEIPTS", "PAYROLL_REPORTS", "SALES_TAX", "LICENSES"];

/** Not a routine statement request (null-safe: SQL NOT over a nullable column would also drop NULL rows). */
export const notRoutineStatementRequest: Prisma.DocumentRequestWhereInput = {
  AND: [
    { OR: [{ ruleKey: null }, { ruleKey: { notIn: OFFICE_RETRIEVED_RULE_KEYS } }] },
    { OR: [{ source: { not: "COETHA" } }, { docType: null }, { docType: { notIn: STATEMENT_DOC_TYPES } }] },
  ],
};

/** Requests a client-facing list may show, for a client with (or without) the bookkeeping service. */
export function clientFacingRequestWhere(bookkeepingService: boolean): Prisma.DocumentRequestWhereInput {
  if (bookkeepingService) return notRoutineStatementRequest;
  return { AND: [notRoutineStatementRequest, { periodId: null }, { OR: [{ ruleKey: null }, { ruleKey: { notIn: BOOKKEEPING_RULE_KEYS } }] }] };
}

/**
 * A statement the office filed for one registered account and statement window (the same match
 * prepareReconciliation uses to mark a statement RECEIVED), never a client upload.
 */
export function officeStatementWhere(clientId: string, bookkeepingAccountId: string, window: { start: Date; end: Date }): Prisma.DocumentWhereInput {
  const late = new Date(window.end.getTime() + 5 * 86_400_000);
  return {
    clientId, bookkeepingAccountId, deletedAt: null, scanStatus: "CLEAN", uploadedByPortalId: null, docType: { in: STATEMENT_DOC_TYPES },
    OR: [{ periodEnd: { gte: window.start, lte: late } }, { year: window.end.getUTCFullYear(), month: window.end.getUTCMonth() + 1 }],
  };
}
