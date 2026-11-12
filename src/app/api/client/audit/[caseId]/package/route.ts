import { requirePortalUser } from "@/lib/portal/session";
import { portalAuditPackage } from "@/lib/services/audit-center";

/** The released audit package for the signed-in client: ?account=<clientId>, &download=1 to save it. */
export async function GET(req: Request, { params }: { params: Promise<{ caseId: string }> }) {
  const user = await requirePortalUser();
  const { caseId } = await params;
  const url = new URL(req.url);
  const clientId = url.searchParams.get("account") ?? "";
  const download = url.searchParams.get("download") === "1";
  try {
    const { bytes, name } = await portalAuditPackage(user, clientId, caseId, download ? "download" : "view");
    return new Response(Buffer.from(bytes), { headers: { "Content-Type": "application/pdf", "Content-Disposition": `${download ? "attachment" : "inline"}; filename="${name}"`, "Cache-Control": "private, no-store" } });
  } catch {
    return new Response("Not found", { status: 404 });
  }
}
