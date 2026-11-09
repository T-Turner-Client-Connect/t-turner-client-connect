import { getCurrentUser } from "@/lib/auth/session";
import { ForbiddenError } from "@/lib/auth/actor";
import { ValidationError } from "@/lib/services/clients";
import { readAdpFile } from "@/lib/services/adp-run";

/**
 * One ADP RUN Time Sheet Import file. Staff with ADP Payroll & Taxes → Manage only, for clients
 * they may see; every download is audited. The bytes are exactly what was built and checked.
 */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const staff = await getCurrentUser();
  if (!staff) return Response.json({ error: "Sign in required" }, { status: 401 });
  const { id } = await params;
  try {
    const f = await readAdpFile(staff, id);
    const body = new TextEncoder().encode(f.csv);
    return new Response(body, {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Length": String(body.byteLength),
        "Content-Disposition": `attachment; filename="${f.fileName.replace(/[^A-Za-z0-9._-]/g, "_")}"`,
        "Cache-Control": "private, no-store",
        "Referrer-Policy": "no-referrer",
        "X-Robots-Tag": "noindex, nofollow",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (e) {
    if (e instanceof ForbiddenError) return Response.json({ error: "Not found" }, { status: 404 });
    if (e instanceof ValidationError) return Response.json({ error: e.message }, { status: 409 });
    throw e;
  }
}
