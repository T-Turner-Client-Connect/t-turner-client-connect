import { getPortalUser } from "@/lib/portal/session";
import { ForbiddenError } from "@/lib/auth/actor";
import { portalBankFeed } from "@/lib/services/portal-business";

/**
 * The live bank feed for one Managed Business the signed-in client may see: balances as the
 * bank last reported them, today's change and the latest transactions. Polled by the business
 * dashboard while it's open. Never another client's data: access is checked for the account asked.
 */
export async function GET(req: Request) {
  const user = await getPortalUser();
  if (!user) return Response.json({ error: "Please sign in to your client portal again." }, { status: 401, headers: { "Cache-Control": "no-store" } });
  const clientId = new URL(req.url).searchParams.get("account") ?? "";
  try {
    const feed = await portalBankFeed(user, clientId);
    return Response.json(feed, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    if (err instanceof ForbiddenError) return Response.json({ error: err.message }, { status: 403, headers: { "Cache-Control": "no-store" } });
    console.error("Bank feed failed:", err instanceof Error ? err.name : "unknown");
    return Response.json({ error: "Couldn't load your bank balances just now." }, { status: 500, headers: { "Cache-Control": "no-store" } });
  }
}
