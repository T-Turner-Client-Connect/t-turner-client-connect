import "server-only";

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
  const env = process.env.SQUARE_ENVIRONMENT === "production" ? "production" : "sandbox";
  return {
    configured: !!(process.env.SQUARE_ACCESS_TOKEN && process.env.SQUARE_LOCATION_ID && process.env.SQUARE_APPLICATION_ID),
    env,
    applicationId: process.env.SQUARE_APPLICATION_ID ?? "",
    locationId: process.env.SQUARE_LOCATION_ID ?? "",
    apiBase: localMock() ?? (env === "production" ? "https://connect.squareup.com" : "https://connect.squareupsandbox.com"),
    sdkUrl: env === "production" ? "https://web.squarecdn.com/v1/square.js" : "https://sandbox.web.squarecdn.com/v1/square.js",
  };
}

/** SQUARE_API_BASE exists only to point automated tests at a local mock; any other host is ignored so the token can't be sent elsewhere. */
function localMock() {
  const base = (process.env.SQUARE_API_BASE ?? "").replace(/\/$/, "");
  return /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(base) ? base : null;
}

export class SquareError extends Error {}

/** Calls the Square API. Errors carry Square's own message (never card data, which this app never has). */
export async function squareRequest<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
  const s = squareSettings();
  if (!s.configured) throw new SquareError("Square isn't connected.");
  let res: Response;
  try {
    res = await fetch(`${s.apiBase}${path}`, {
      method,
      headers: { Authorization: `Bearer ${process.env.SQUARE_ACCESS_TOKEN}`, "Content-Type": "application/json", "Square-Version": "2025-01-23" },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    throw new SquareError("Square couldn't be reached. Nothing was saved — please try again.");
  }
  const json = (await res.json().catch(() => ({}))) as { errors?: { detail?: string; code?: string }[] } & T;
  if (!res.ok) throw new SquareError(json.errors?.[0]?.detail ? `Square: ${json.errors[0].detail}` : `Square answered with an error (HTTP ${res.status}).`);
  return json;
}

export type SquareCard = { id: string; card_brand?: string; last_4?: string; exp_month?: number; exp_year?: number; enabled?: boolean };
