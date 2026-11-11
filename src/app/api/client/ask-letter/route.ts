import { getPortalUser } from "@/lib/portal/session";
import { portalAskLetterPdf } from "@/lib/services/ask-client";

// The client's copy of the supporting-documents request letter (sent requests only, never drafts).
export async function GET(req: Request) {
  const portal = await getPortalUser();
  if (!portal) return Response.json({ error: "Sign in required" }, { status: 401 });
  const clientId = new URL(req.url).searchParams.get("account") ?? "";
  try {
    const r = await portalAskLetterPdf(portal, clientId);
    return new Response(r.bytes as unknown as BodyInit, {
      headers: { "Content-Type": "application/pdf", "Content-Disposition": `inline; filename="${r.fileName}"`, "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" },
    });
  } catch {
    return Response.json({ error: "Not found" }, { status: 404 });
  }
}
