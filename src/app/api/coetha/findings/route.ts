import { getCurrentUser } from "@/lib/auth/session";
import { ForbiddenError } from "@/lib/auth/actor";
import { ValidationError } from "@/lib/services/clients";
import { findingsSheet } from "@/lib/services/coetha-reading";

// "Download as Spreadsheet": every check and item Coetha read for one business (or one of its
// documents), with its group, bank match, proposed account, why, and evidence needed. Staff with
// access to that business's books only. Read-only.
export async function GET(req: Request) {
  const actor = await getCurrentUser();
  if (!actor) return Response.json({ error: "Sign in again to download." }, { status: 401 });
  const q = new URL(req.url).searchParams;
  try {
    const csv = await findingsSheet(actor, q.get("clientId") ?? "", q.get("jobId") || undefined);
    return new Response(csv, { headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="coetha-findings-${new Date().toISOString().slice(0, 10)}.csv"`, "Cache-Control": "no-store" } });
  } catch (err) {
    if (err instanceof ForbiddenError) return Response.json({ error: err.message }, { status: 403 });
    if (err instanceof ValidationError) return Response.json({ error: err.message }, { status: 400 });
    console.error("coetha findings download failed", err instanceof Error ? err.message : "error");
    return Response.json({ error: "The spreadsheet couldn't be made. Try again." }, { status: 500 });
  }
}
