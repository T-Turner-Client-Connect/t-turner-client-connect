import "server-only";
import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Square (payments). Card numbers and CVVs are typed only into Square's own
 * hosted card fields (Web Payments SDK) and never reach this app: the browser
 * sends a one-time token, and the server asks Square to save the card. Only
 * Square's ids and the masked display details Square returns are stored.
 *
 * Netlify variables: SQUARE_ACCESS_TOKEN (secret), SQUARE_LOCATION_ID,
 * SQUARE_APPLICATION_ID (public, used by the card form), SQUARE_ENVIRONMENT
 * ("sandbox" or "production"; default sandbox).
 */
export function squareSettings() {
  const rawEnv = process.env.SQUARE_ENVIRONMENT;
  // "Production", " production " and similar are read as production; anything else falls back to sandbox.
  const env: "production" | "sandbox" = (rawEnv ?? "").trim().toLowerCase() === "production" ? "production" : "sandbox";
  const token = cleanToken(process.env.SQUARE_ACCESS_TOKEN);
  const applicationId = (process.env.SQUARE_APPLICATION_ID ?? "").trim();
  const locationId = (process.env.SQUARE_LOCATION_ID ?? "").trim();
  return {
    // "configured" means only that the three variables are present. It says nothing about whether Square accepts them:
    // use the connection-health check for that.
    configured: !!(token.value && locationId && applicationId),
    env,
    envVariable: rawEnv === undefined ? ("missing" as const) : rawEnv.trim().toLowerCase() === env ? ("ok" as const) : ("unrecognized" as const),
    tokenCleanup: token.fixes,
    applicationId,
    locationId,
    apiBase: localMock() ?? baseFor(env),
    sdkUrl: env === "production" ? "https://web.squarecdn.com/v1/square.js" : "https://sandbox.web.squarecdn.com/v1/square.js",
  };
}

export const baseFor = (env: "production" | "sandbox") => (env === "production" ? "https://connect.squareup.com" : "https://connect.squareupsandbox.com");

/**
 * The token as Square expects it. A token pasted with spaces, quotes or a "Bearer " prefix is
 * a common cause of "This request could not be authorized"; the fixes are reported by name only.
 */
function cleanToken(raw: string | undefined) {
  const fixes: string[] = [];
  let v = raw ?? "";
  if (v !== v.trim()) fixes.push("extra spaces or line breaks around the token");
  v = v.trim();
  if (/^["'].*["']$/.test(v)) {
    fixes.push("quotation marks around the token");
    v = v.slice(1, -1).trim();
  }
  if (/^bearer\s+/i.test(v)) {
    fixes.push('a "Bearer " prefix');
    v = v.replace(/^bearer\s+/i, "");
  }
  return { value: v, fixes };
}

/** SQUARE_API_BASE exists only to point automated tests at a local mock; any other host is ignored so the token can't be sent elsewhere. */
function localMock() {
  const base = (process.env.SQUARE_API_BASE ?? "").replace(/\/$/, "");
  return /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(base) ? base : null;
}

export class SquareError extends Error {
  constructor(message: string, readonly status?: number, readonly code?: string) {
    super(message);
  }
}

/** Plain-language next steps for Square's error codes. Never includes the token. */
export function explainSquareError(status: number, code: string | undefined, detail: string | undefined) {
  switch (code) {
    case "UNAUTHORIZED":
      return "Square didn't accept the access token (401 UNAUTHORIZED). Usually the token is for the other Square environment (production vs. sandbox), was pasted incorrectly, or was replaced in the Square Developer Dashboard. Run “Check Square connection” on the Square billing page to see which.";
    case "ACCESS_TOKEN_EXPIRED":
      return "The Square access token has expired (401 ACCESS_TOKEN_EXPIRED). A new token is needed from the Square Developer Dashboard.";
    case "ACCESS_TOKEN_REVOKED":
      return "The Square access token was revoked (401 ACCESS_TOKEN_REVOKED). A new token is needed from the Square Developer Dashboard.";
    case "INSUFFICIENT_SCOPES":
      return `The Square token doesn't have permission for this (403 INSUFFICIENT_SCOPES)${detail ? `: ${detail}` : ""}. Run “Check Square connection” to see which permission is missing.`;
    case "FORBIDDEN":
      return `Square refused this request (403 FORBIDDEN)${detail ? `: ${detail}` : ""}.`;
    case "NOT_FOUND":
      return `Square couldn't find that (404 NOT_FOUND)${detail ? `: ${detail}` : ""}.`;
    case "RATE_LIMITED":
      return "Square asked us to slow down (429 RATE_LIMITED). Nothing was changed — try again in a minute.";
  }
  if (status >= 500) return `Square is having a problem right now (HTTP ${status}${code ? ` ${code}` : ""}). Nothing was changed — try again shortly.`;
  return detail ? `Square: ${detail} (HTTP ${status}${code ? ` ${code}` : ""})` : `Square answered with an error (HTTP ${status}${code ? ` ${code}` : ""}).`;
}

/** Raw read for the health check: never throws on an HTTP error, never returns the token. */
export async function squareProbe(method: "GET" | "POST", path: string, body?: unknown, base?: string) {
  const s = squareSettings();
  try {
    const res = await fetch(`${base ?? s.apiBase}${path}`, {
      method,
      headers: { Authorization: `Bearer ${cleanToken(process.env.SQUARE_ACCESS_TOKEN).value}`, "Content-Type": "application/json", "Square-Version": SQUARE_VERSION },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(15_000),
    });
    const json = (await res.json().catch(() => ({}))) as { errors?: { detail?: string; code?: string; category?: string }[] } & Record<string, unknown>;
    return { status: res.status, ok: res.ok, code: json.errors?.[0]?.code, detail: json.errors?.[0]?.detail, json };
  } catch {
    return { status: 0, ok: false, code: "NETWORK", detail: "Square couldn't be reached.", json: {} as Record<string, unknown> };
  }
}

const SQUARE_VERSION = "2025-01-23";

/** Calls the Square API. Errors carry Square's own message (never card data, which this app never has). */
export async function squareRequest<T>(method: "GET" | "POST" | "DELETE", path: string, body?: unknown): Promise<T> {
  const s = squareSettings();
  if (!s.configured) throw new SquareError("Square isn't connected.");
  let res: Response;
  try {
    res = await fetch(`${s.apiBase}${path}`, {
      method,
      headers: { Authorization: `Bearer ${cleanToken(process.env.SQUARE_ACCESS_TOKEN).value}`, "Content-Type": "application/json", "Square-Version": SQUARE_VERSION },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    throw new SquareError("Square couldn't be reached. Nothing was saved — please try again.");
  }
  const json = (await res.json().catch(() => ({}))) as { errors?: { detail?: string; code?: string }[] } & T;
  if (!res.ok) {
    const e = json.errors?.[0];
    throw new SquareError(explainSquareError(res.status, e?.code, e?.detail), res.status, e?.code);
  }
  return json;
}

/**
 * Square webhooks. Square signs each notification with the subscription's signature key:
 * base64(HMAC-SHA256(key, notificationUrl + rawBody)) in x-square-hmacsha256-signature.
 * SQUARE_WEBHOOK_SIGNATURE_KEY is that key (Square Developer Dashboard → Webhooks). The
 * notification URL must be exactly the one saved there; SQUARE_WEBHOOK_URL overrides the
 * default <site>/api/webhooks/square.
 */
export function squareWebhookUrl(appUrl: string) {
  return (process.env.SQUARE_WEBHOOK_URL ?? "").trim() || `${appUrl.replace(/\/$/, "")}/api/webhooks/square`;
}

export function verifySquareSignature(signatureKey: string, notificationUrl: string, rawBody: string, signature: string | null) {
  if (!signatureKey || !signature) return false;
  const expected = Buffer.from(createHmac("sha256", signatureKey).update(notificationUrl + rawBody).digest("base64"));
  const given = Buffer.from(signature.trim());
  return expected.length === given.length && timingSafeEqual(expected, given);
}

export type SquareCard ={ id: string; card_brand?: string; last_4?: string; exp_month?: number; exp_year?: number; enabled?: boolean };
