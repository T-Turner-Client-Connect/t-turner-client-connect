import "server-only";
import { createHash, createPublicKey, timingSafeEqual, verify as verifySignature, type JsonWebKey } from "node:crypto";
import { liveBankingOn } from "@/lib/services/owner-switches";

/**
 * Plaid, read-only (Transactions product). Credentials come from Netlify environment
 * variables and are never shown.
 *
 * Environments (Plaid offers two today; "development" was retired by Plaid in 2024):
 * - PLAID_ENV=sandbox    → https://sandbox.plaid.com, test banks and test data only.
 * - PLAID_ENV=production → https://production.plaid.com, real banks. Used ONLY when Tabitha's
 *   owner switch "Live bank connections" is also ON. Production keys without the switch, or the
 *   switch without production keys, connect nothing.
 */

export type PlaidEnv = "sandbox" | "production";
/**
 * NOT_CONFIGURED: no keys. SANDBOX: test mode. LIVE: production keys + Tabitha's switch on.
 * LIVE_BLOCKED: production keys present but the switch is off. UNSUPPORTED_ENV: a PLAID_ENV
 * value Plaid no longer offers (e.g. "development") or a typo.
 */
export type PlaidMode = "NOT_CONFIGURED" | "SANDBOX" | "LIVE" | "LIVE_BLOCKED" | "UNSUPPORTED_ENV";

const BASES: Record<PlaidEnv, string> = { sandbox: "https://sandbox.plaid.com", production: "https://production.plaid.com" };

/** Pure: what the environment variables plus the owner switch allow. */
export function plaidMode(env: Record<string, string | undefined> = process.env, liveSwitchOn = false): PlaidMode {
  if (!env.PLAID_CLIENT_ID?.trim() || !env.PLAID_SECRET?.trim()) return "NOT_CONFIGURED";
  const e = (env.PLAID_ENV ?? "sandbox").trim().toLowerCase();
  if (e === "sandbox") return "SANDBOX";
  if (e === "production") return liveSwitchOn ? "LIVE" : "LIVE_BLOCKED";
  return "UNSUPPORTED_ENV";
}

/** The current mode, reading Tabitha's switch from the database. */
export async function currentPlaidMode(): Promise<PlaidMode> {
  const base = plaidMode(process.env, false);
  if (base !== "LIVE_BLOCKED") return base;
  return (await liveBankingOn()) ? "LIVE" : "LIVE_BLOCKED";
}

/** Which Plaid environment a mode talks to (connections are stored with it). */
export const envOfMode = (m: PlaidMode): "SANDBOX" | "PRODUCTION" | null => (m === "SANDBOX" ? "SANDBOX" : m === "LIVE" ? "PRODUCTION" : null);

export const PLAID_MODE_TEXT: Record<PlaidMode, string> = {
  NOT_CONFIGURED: "Plaid isn't set up yet (PLAID_CLIENT_ID and PLAID_SECRET in Netlify).",
  SANDBOX: "Sandbox: Plaid's test banks and test data only.",
  LIVE: "Live: real bank connections are on (production keys and Tabitha's switch).",
  LIVE_BLOCKED: "Production keys are set, but real bank connections stay off until Tabitha turns on “Live bank connections” in the Owner's Office.",
  UNSUPPORTED_ENV: "PLAID_ENV must be “sandbox” or “production” (Plaid no longer offers “development”).",
};

export class PlaidError extends Error {
  constructor(message: string, public code: string, public status = 0, public type = "") {
    super(message);
    this.name = "PlaidError";
  }
}

/**
 * Item errors that only the client can fix by signing in to their bank again through Link
 * (update mode). Retrying them daily would just fail again, so they're flagged for staff.
 */
export const REAUTH_CODES = new Set([
  "ITEM_LOGIN_REQUIRED", "PENDING_EXPIRATION", "PENDING_DISCONNECT", "USER_PERMISSION_REVOKED", "ACCESS_NOT_GRANTED",
  "INVALID_CREDENTIALS", "INSUFFICIENT_CREDENTIALS", "INVALID_MFA", "INVALID_UPDATED_USERNAME", "ITEM_LOCKED",
  "USER_SETUP_REQUIRED", "MFA_NOT_SUPPORTED", "NO_ACCOUNTS", "ITEM_NOT_SUPPORTED", "ITEM_CONCURRENTLY_DELETED", "OAUTH_INVALID_TOKEN",
]);

function baseFor(mode: PlaidMode): string {
  if (mode === "SANDBOX") return process.env.PLAID_API_BASE?.trim() || BASES.sandbox;
  return BASES.production; // never overridable: production always talks to Plaid itself
}

// --- Optional products (off until Tabitha enables them) ------------------------------------------
// Statements (monthly statement PDFs) and Liabilities (card / loan terms) are separate Plaid
// products that need their own approval in the Plaid Dashboard. Each is used only when its flag is
// set AND Plaid is otherwise usable (sandbox, or production with the live switch on).
// Request/response shapes below follow Plaid's published API as we know it but could NOT be checked
// against plaid.com from this project: they are marked UNVERIFIED and must be confirmed (in sandbox)
// before the flags are turned on in production.
export const statementsFlag = (env: Record<string, string | undefined> = process.env) => env.PLAID_STATEMENTS_ENABLED?.trim().toLowerCase() === "true";
export const liabilitiesFlag = (env: Record<string, string | undefined> = process.env) => env.PLAID_LIABILITIES_ENABLED?.trim().toLowerCase() === "true";

async function call<T>(path: string, body: Record<string, unknown>, opts: { allowWhenOff?: "SANDBOX" | "PRODUCTION"; raw?: boolean } = {}): Promise<T> {
  let mode = await currentPlaidMode();
  // Revoking access at the bank (disconnect) is always allowed for the environment the
  // connection was made in, even after the switch is turned off.
  if (opts.allowWhenOff === "PRODUCTION" && mode === "LIVE_BLOCKED") mode = "LIVE";
  if (mode === "NOT_CONFIGURED") throw new PlaidError(PLAID_MODE_TEXT.NOT_CONFIGURED, "NOT_CONFIGURED");
  if (mode === "UNSUPPORTED_ENV") throw new PlaidError(PLAID_MODE_TEXT.UNSUPPORTED_ENV, "UNSUPPORTED_ENV");
  if (mode === "LIVE_BLOCKED") throw new PlaidError("Real bank connections are turned off until Tabitha turns on “Live bank connections”.", "LIVE_BLOCKED");
  let res: Response;
  try {
    res = await fetch(`${baseFor(mode)}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Plaid-Version": "2020-09-14" },
      body: JSON.stringify({ client_id: process.env.PLAID_CLIENT_ID, secret: process.env.PLAID_SECRET, ...body }),
      signal: AbortSignal.timeout(30_000),
      cache: "no-store",
    });
  } catch {
    throw new PlaidError("Couldn't reach Plaid.", "NETWORK");
  }
  if (opts.raw && res.ok) return new Uint8Array(await res.arrayBuffer()) as T;
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    // Plaid's error code and a safe message only, never the request or token.
    const code = typeof json.error_code === "string" ? json.error_code : `HTTP_${res.status}`;
    const msg = typeof json.display_message === "string" && json.display_message ? json.display_message : typeof json.error_message === "string" ? json.error_message : "Plaid returned an error.";
    throw new PlaidError(msg, code, res.status, typeof json.error_type === "string" ? json.error_type : "");
  }
  return json as T;
}

/** Plaid's account object (balances are Plaid's cached values; for credit accounts `current` is the amount owed). */
export type PlaidAccount = { account_id: string; name: string; official_name?: string | null; mask?: string | null; type: string; subtype?: string | null; balances?: { current?: number | null; available?: number | null; limit?: number | null; iso_currency_code?: string | null } | null };
export type PlaidTxn = { transaction_id: string; account_id: string; amount: number; date: string; authorized_date?: string | null; name: string; merchant_name?: string | null; pending: boolean; pending_transaction_id?: string | null };

/** Where Plaid sends webhooks for new transactions and item errors (https sites only). */
export function plaidWebhookUrl(appBase: string): string | null {
  return /^https:\/\//.test(appBase) ? `${appBase.replace(/\/$/, "")}/api/webhooks/plaid` : null;
}

/**
 * A Link session for one client business. `accessToken` opens Link in update mode: the
 * client signs in to the bank again to repair an existing connection (no new item).
 */
export function createLinkToken(clientUserId: string, opts: { webhook?: string | null; accessToken?: string } = {}) {
  const redirect = process.env.PLAID_REDIRECT_URI?.trim();
  return call<{ link_token: string; expiration: string }>("/link/token/create", {
    user: { client_user_id: clientUserId },
    client_name: "T. Turner & Associates",
    country_codes: ["US"],
    language: "en",
    ...(opts.accessToken ? { access_token: opts.accessToken } : { products: ["transactions"], transactions: { days_requested: 730 }, ...optionalProducts() }),
    ...(opts.webhook ? { webhook: opts.webhook } : {}),
    ...(redirect ? { redirect_uri: redirect } : {}),
  });
}

/**
 * Consent for the optional products, only when their flags are on. Asked as additional consented
 * products so a bank that doesn't support them can still connect for transactions.
 * UNVERIFIED: the `additional_consented_products` field and the `statements` date options.
 */
export function optionalProducts(env: Record<string, string | undefined> = process.env, today = new Date()) {
  const extra = [...(statementsFlag(env) ? ["statements"] : []), ...(liabilitiesFlag(env) ? ["liabilities"] : [])];
  if (!extra.length) return {};
  const end = today.toISOString().slice(0, 10);
  const start = new Date(today.getTime() - 365 * 86_400_000).toISOString().slice(0, 10);
  return { additional_consented_products: extra, ...(statementsFlag(env) ? { statements: { start_date: start, end_date: end } } : {}) };
}

/** UNVERIFIED shape. One item's statements, per account (month/year of each statement). */
export type PlaidStatementsList = { accounts: { account_id: string; account_mask?: string | null; statements: { statement_id: string; month: number; year: number; date_posted?: string | null }[] }[] };
export function statementsList(accessToken: string) {
  return call<PlaidStatementsList>("/statements/list", { access_token: accessToken });
}
/** UNVERIFIED shape. The statement PDF (binary). */
export function statementsDownload(accessToken: string, statementId: string) {
  return call<Uint8Array>("/statements/download", { access_token: accessToken, statement_id: statementId }, { raw: true });
}
/** UNVERIFIED shape. Asks Plaid to fetch statements for a date range (asynchronous; a webhook says when done). */
export function statementsRefresh(accessToken: string, startDate: string, endDate: string) {
  return call<{ request_id: string }>("/statements/refresh", { access_token: accessToken, start_date: startDate, end_date: endDate });
}

/** UNVERIFIED shape (subset used). Credit-card and loan terms per account. */
export type PlaidLiabilities = {
  accounts?: PlaidAccount[];
  liabilities: {
    credit?: { account_id: string | null; aprs?: { apr_percentage: number; apr_type: string }[]; is_overdue?: boolean | null; last_statement_balance?: number | null; last_statement_issue_date?: string | null; minimum_payment_amount?: number | null; next_payment_due_date?: string | null }[] | null;
    mortgage?: { account_id: string; interest_rate?: { percentage?: number | null } | null; next_payment_due_date?: string | null; next_monthly_payment?: number | null; past_due_amount?: number | null }[] | null;
    student?: { account_id: string | null; interest_rate_percentage?: number | null; minimum_payment_amount?: number | null; next_payment_due_date?: string | null; is_overdue?: boolean | null; last_statement_balance?: number | null; last_statement_issue_date?: string | null }[] | null;
  };
};
export function liabilitiesGet(accessToken: string) {
  return call<PlaidLiabilities>("/liabilities/get", { access_token: accessToken });
}

export function exchangePublicToken(publicToken: string) {
  return call<{ access_token: string; item_id: string }>("/item/public_token/exchange", { public_token: publicToken });
}

export function getAccounts(accessToken: string) {
  return call<{ accounts: PlaidAccount[]; item: { institution_id?: string | null } }>("/accounts/get", { access_token: accessToken });
}

export function syncPage(accessToken: string, cursor: string | null) {
  return call<{ added: PlaidTxn[]; modified: PlaidTxn[]; removed: { transaction_id: string; account_id?: string }[]; next_cursor: string; has_more: boolean; accounts?: PlaidAccount[] }>("/transactions/sync", {
    access_token: accessToken,
    ...(cursor ? { cursor } : {}),
    count: 500,
  });
}

/** Points an existing item's webhooks at this site (after a domain change, or for items made before webhooks). */
export function updateItemWebhook(accessToken: string, webhook: string) {
  return call<{ request_id: string }>("/item/webhook/update", { access_token: accessToken, webhook });
}

export function removeItem(accessToken: string, environment: "SANDBOX" | "PRODUCTION") {
  return call<{ request_id: string }>("/item/remove", { access_token: accessToken }, { allowWhenOff: environment });
}

// --- Webhook verification ----------------------------------------------------------------------
// Plaid signs each webhook with a JWT (ES256) in the Plaid-Verification header. The public key
// comes from Plaid's /webhook_verification_key/get endpoint (cached by key id). The JWT's
// request_body_sha256 must match the exact body, and it must be under 5 minutes old.

const keyCache = new Map<string, { jwk: JsonWebKey; expiredAt: number | null }>();

const b64url = (s: string) => Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64");

export async function verifyPlaidWebhook(rawBody: string, jwt: string | null, now = Date.now()): Promise<boolean> {
  if (!jwt) return false;
  const parts = jwt.split(".");
  if (parts.length !== 3) return false;
  let header: { alg?: string; kid?: string }, claims: { iat?: number; request_body_sha256?: string };
  try {
    header = JSON.parse(b64url(parts[0]).toString("utf8"));
    claims = JSON.parse(b64url(parts[1]).toString("utf8"));
  } catch {
    return false;
  }
  if (header.alg !== "ES256" || !header.kid) return false;
  let cached = keyCache.get(header.kid);
  if (!cached) {
    try {
      const r = await call<{ key: JsonWebKey & { expired_at?: number | null } }>("/webhook_verification_key/get", { key_id: header.kid });
      cached = { jwk: r.key, expiredAt: r.key.expired_at ?? null };
      keyCache.set(header.kid, cached);
    } catch {
      return false;
    }
  }
  if (cached.expiredAt && cached.expiredAt * 1000 < now) return false;
  try {
    const key = createPublicKey({ key: { kty: cached.jwk.kty, crv: cached.jwk.crv, x: cached.jwk.x, y: cached.jwk.y }, format: "jwk" });
    const ok = verifySignature("sha256", Buffer.from(`${parts[0]}.${parts[1]}`), { key, dsaEncoding: "ieee-p1363" }, b64url(parts[2]));
    if (!ok) return false;
  } catch {
    return false;
  }
  if (typeof claims.iat !== "number" || now / 1000 - claims.iat > 5 * 60 || claims.iat - now / 1000 > 60) return false;
  const want = Buffer.from(createHash("sha256").update(rawBody, "utf8").digest("hex"));
  const got = Buffer.from(String(claims.request_body_sha256 ?? ""));
  return want.length === got.length && timingSafeEqual(want, got);
}

/** Tests only. */
export function _clearWebhookKeyCache() {
  keyCache.clear();
}
