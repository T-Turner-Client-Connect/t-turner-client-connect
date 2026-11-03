import "server-only";

/**
 * Plaid, read-only (Transactions product). This phase talks ONLY to Plaid's sandbox: a
 * development or production environment is refused in code until Tabitha approves connecting
 * real banks. Credentials come from Netlify environment variables and are never shown.
 */

export type PlaidMode = "NOT_CONFIGURED" | "SANDBOX" | "LIVE_BLOCKED";

export function plaidMode(env: Record<string, string | undefined> = process.env): PlaidMode {
  if (!env.PLAID_CLIENT_ID?.trim() || !env.PLAID_SECRET?.trim()) return "NOT_CONFIGURED";
  const e = (env.PLAID_ENV ?? "sandbox").trim().toLowerCase();
  return e === "sandbox" ? "SANDBOX" : "LIVE_BLOCKED";
}

export class PlaidError extends Error {
  constructor(message: string, public code: string, public status = 0) {
    super(message);
    this.name = "PlaidError";
  }
}

const BASE = () => process.env.PLAID_API_BASE?.trim() || "https://sandbox.plaid.com";

async function call<T>(path: string, body: Record<string, unknown>): Promise<T> {
  const mode = plaidMode();
  if (mode === "NOT_CONFIGURED") throw new PlaidError("Plaid isn't set up yet (PLAID_CLIENT_ID and PLAID_SECRET in Netlify).", "NOT_CONFIGURED");
  if (mode === "LIVE_BLOCKED") throw new PlaidError("Real bank connections are turned off until Tabitha approves them. Use PLAID_ENV=sandbox.", "LIVE_BLOCKED");
  let res: Response;
  try {
    res = await fetch(`${BASE()}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ client_id: process.env.PLAID_CLIENT_ID, secret: process.env.PLAID_SECRET, ...body }),
      signal: AbortSignal.timeout(20_000),
      cache: "no-store",
    });
  } catch {
    throw new PlaidError("Couldn't reach Plaid.", "NETWORK");
  }
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    // Plaid's error code and a safe message only — never the request or token.
    const code = typeof json.error_code === "string" ? json.error_code : `HTTP_${res.status}`;
    const msg = typeof json.display_message === "string" && json.display_message ? json.display_message : typeof json.error_message === "string" ? json.error_message : "Plaid returned an error.";
    throw new PlaidError(msg, code, res.status);
  }
  return json as T;
}

export type PlaidAccount = { account_id: string; name: string; official_name?: string | null; mask?: string | null; type: string; subtype?: string | null };
export type PlaidTxn = { transaction_id: string; account_id: string; amount: number; date: string; authorized_date?: string | null; name: string; merchant_name?: string | null; pending: boolean; pending_transaction_id?: string | null };

export function createLinkToken(clientUserId: string) {
  return call<{ link_token: string; expiration: string }>("/link/token/create", {
    user: { client_user_id: clientUserId },
    client_name: "TTurner Client Connect",
    products: ["transactions"],
    transactions: { days_requested: 730 },
    country_codes: ["US"],
    language: "en",
  });
}

export function exchangePublicToken(publicToken: string) {
  return call<{ access_token: string; item_id: string }>("/item/public_token/exchange", { public_token: publicToken });
}

export function getAccounts(accessToken: string) {
  return call<{ accounts: PlaidAccount[]; item: { institution_id?: string | null } }>("/accounts/get", { access_token: accessToken });
}

export function syncPage(accessToken: string, cursor: string | null) {
  return call<{ added: PlaidTxn[]; modified: PlaidTxn[]; removed: { transaction_id: string; account_id?: string }[]; next_cursor: string; has_more: boolean }>("/transactions/sync", {
    access_token: accessToken,
    ...(cursor ? { cursor } : {}),
    count: 500,
  });
}

export function removeItem(accessToken: string) {
  return call<{ request_id: string }>("/item/remove", { access_token: accessToken });
}
