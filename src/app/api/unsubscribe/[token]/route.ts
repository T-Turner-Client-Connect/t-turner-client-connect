import { unsubscribeWithToken } from "@/lib/services/comm-prefs";

/**
 * RFC 8058 one-click unsubscribe. Email apps POST "List-Unsubscribe=One-Click"
 * to the URL in the List-Unsubscribe header; no sign-in or cookies (the signed
 * token is the permission). It stops the kind of email the link came in.
 */
export async function POST(req: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const body = await req.text().catch(() => "");
  if (!/List-Unsubscribe=One-Click/i.test(body) && !/List-Unsubscribe=One-Click/i.test(new URL(req.url).search)) {
    return new Response("Expected List-Unsubscribe=One-Click", { status: 400 });
  }
  const r = await unsubscribeWithToken(token, "THIS", "ONE_CLICK");
  if (!r.ok) return new Response(r.reason === "expired" ? "Link expired" : "Invalid link", { status: r.reason === "expired" ? 410 : 404 });
  return new Response("Unsubscribed", { status: 200, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" } });
}
