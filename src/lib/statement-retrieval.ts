import "server-only";

/**
 * Automatic monthly statement retrieval — the adapter interface and the fallback.
 *
 * The Plaid Statements implementation lives in services/plaid-products.ts (PLAID_STATEMENTS) and is
 * used only when PLAID_STATEMENTS_ENABLED=true and Plaid is usable for the connection. Its API
 * shapes are marked UNVERIFIED (they couldn't be checked against plaid.com from this project).
 * Otherwise the fallback says "not available" and Coetha requests that exact account and month
 * from the client.
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
