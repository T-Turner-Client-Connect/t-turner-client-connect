import { getPortalUser } from "@/lib/portal/session";
import { ForbiddenError } from "@/lib/auth/actor";
import { ValidationError } from "@/lib/services/clients";
import { portalRefreshBank, RateLimitedError } from "@/lib/services/portal-business";

const noStore = { "Cache-Control": "no-store" };

/** "Refresh now" on the business dashboard: one read-only bank retrieval, at most every 5 minutes. */
export async function POST(req: Request) {
  const user = await getPortalUser();
  if (!user) return Response.json({ error: "Please sign in to your client portal again." }, { status: 401, headers: noStore });
  // Same-site requests only.
  const origin = req.headers.get("origin");
  if (origin && origin !== new URL(req.url).origin) return Response.json({ error: "Not allowed." }, { status: 403, headers: noStore });
  let clientId = "";
  try {
    clientId = String(((await req.json()) as { account?: unknown }).account ?? "");
  } catch {
    return Response.json({ error: "Choose the account to refresh." }, { status: 400, headers: noStore });
  }
  try {
    const { feed, failed } = await portalRefreshBank(user, clientId);
    return Response.json({ ok: true, feed, message: failed ? "Your bank didn't answer just now. We'll keep checking on the regular schedule." : "Checked with your bank." }, { headers: noStore });
  } catch (err) {
    if (err instanceof RateLimitedError) return Response.json({ error: err.message, retryAt: err.retryAt.toISOString() }, { status: 429, headers: { ...noStore, "Retry-After": String(Math.max(1, Math.ceil((err.retryAt.getTime() - Date.now()) / 1000))) } });
    if (err instanceof ForbiddenError) return Response.json({ error: err.message }, { status: 403, headers: noStore });
    if (err instanceof ValidationError) return Response.json({ error: err.message }, { status: 400, headers: noStore });
    console.error("Bank refresh failed:", err instanceof Error ? err.name : "unknown");
    return Response.json({ error: "Couldn't refresh just now. Please try again in a few minutes." }, { status: 500, headers: noStore });
  }
}
