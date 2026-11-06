import { getCurrentUser } from "@/lib/auth/session";
import { complianceAccess } from "@/lib/services/compliance/access";
import { missingInfoCsv, missingInfoReport } from "@/lib/services/compliance/views";

/** CSV export of the Missing Compliance Information report (compliance View or higher). */
export async function GET(req: Request) {
  const actor = await getCurrentUser();
  if (!actor) return Response.json({ error: "Sign in required" }, { status: 401 });
  if ((await complianceAccess(actor)).level === "NONE") return Response.json({ error: "Not found" }, { status: 404 });
  const clientId = new URL(req.url).searchParams.get("clientId") ?? undefined;
  const csv = missingInfoCsv(await missingInfoReport(actor, { clientId }));
  return new Response(csv, { headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="missing-compliance-info.csv"`, "Cache-Control": "private, no-store" } });
}
