import "server-only";

/**
 * Automatic monthly statement retrieval — adapter interface plus the fallback.
 *
 * Plaid offers a separate "Statements" product (statement PDFs from the bank), available only
 * at some institutions and only when enabled for the firm's Plaid account and consented to in
 * Link. Its request/response shapes could NOT be verified from inside this project (no Plaid
 * SDK or docs are vendored here, and plaid.com is not reachable from the build environment),
 * so no Statements endpoint is called. Per the rule "don't invent endpoints you can't verify":
 *
 * - `StatementSource` is the seam a verified implementation plugs into (list the statements for
 *   one connected account and month, then download the PDF).
 * - Until then `statementSource()` returns the fallback, which always says "not available", and
 *   Coetha creates a document request for that exact account and month instead.
 * - Turning it on later needs: PLAID_STATEMENTS_ENABLED=true, the Statements product enabled in
 *   the Plaid Dashboard, the product added to Link for new connections (existing connections
 *   need Link update mode for consent), and an implementation verified against Plaid's docs.
 */

export type StatementQuery = { connectionId: string; providerAccountId: string; year: number; month: number };
export type StatementResult = { available: true; pdf: Uint8Array; statementDate: string; endingBalanceCents: number | null } | { available: false; reason: string };

export interface StatementSource {
  readonly name: string;
  fetchMonthly(q: StatementQuery): Promise<StatementResult>;
}

export const statementsEnabled = (env: Record<string, string | undefined> = process.env) => env.PLAID_STATEMENTS_ENABLED?.trim().toLowerCase() === "true";

/** Fallback: nothing is retrieved; the caller requests the statement from the client. */
export const REQUEST_FROM_CLIENT: StatementSource = {
  name: "request-from-client",
  async fetchMonthly() {
    return { available: false, reason: statementsEnabled() ? "Plaid Statements isn't implemented in Client Connect yet (API shape not verified)." : "Automatic statement retrieval is off (PLAID_STATEMENTS_ENABLED)." };
  },
};

let override: StatementSource | null = null;
/** Tests (and a future verified Plaid implementation) can provide a source. */
export function setStatementSource(s: StatementSource | null) {
  override = s;
}
export function statementSource(): StatementSource {
  return override ?? REQUEST_FROM_CLIENT;
}
