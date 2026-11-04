import { verifyPlaidWebhook } from "@/lib/plaid";
import { handlePlaidWebhook, type PlaidWebhook } from "@/lib/services/banking";

// Plaid webhook: https://<site>/api/webhooks/plaid (set on each connection's Link token).
// Every request must carry Plaid's signed JWT (Plaid-Verification header), checked against
// Plaid's own verification key, the exact body's SHA-256 and a 5-minute age limit. Anything
// unsigned or altered is refused before it is read. Only the item id and event type are used;
// transactions themselves are always fetched from Plaid with the stored access token.
const NO_STORE = { "Cache-Control": "no-store" };

export async function POST(req: Request) {
  const raw = await req.text();
  if (raw.length > 100_000) return Response.json({ error: "Too large" }, { status: 413, headers: NO_STORE });
  if (!(await verifyPlaidWebhook(raw, req.headers.get("plaid-verification")))) {
    return Response.json({ error: "Unauthorized" }, { status: 401, headers: NO_STORE });
  }
  let body: PlaidWebhook;
  try {
    body = JSON.parse(raw) as PlaidWebhook;
  } catch {
    return Response.json({ error: "Bad request" }, { status: 400, headers: NO_STORE });
  }
  const result = await handlePlaidWebhook(body).catch(() => "error (recorded)");
  return Response.json({ result }, { headers: NO_STORE });
}

export function GET() {
  return Response.json({ error: "Method not allowed" }, { status: 405, headers: { ...NO_STORE, Allow: "POST" } });
}
