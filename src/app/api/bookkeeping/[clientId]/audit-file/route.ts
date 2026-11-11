import { getCurrentUser } from "@/lib/auth/session";
import { ForbiddenError } from "@/lib/auth/actor";
import { ValidationError } from "@/lib/services/clients";
import { buildAuditFilePdf, parseAuditFilter } from "@/lib/services/audit-file";

// Audit File → one PDF (letterhead cover, index, documents). Every export is logged.
export async function GET(req: Request, ctx: { params: Promise<{ clientId: string }> }) {
  const actor = await getCurrentUser();
  if (!actor) return new Response("Sign in required", { status: 401 });
  try {
    const filter = parseAuditFilter(Object.fromEntries(new URL(req.url).searchParams));
    const r = await buildAuditFilePdf(actor, (await ctx.params).clientId, filter);
    return new Response(r.bytes as unknown as BodyInit, {
      headers: { "Content-Type": "application/pdf", "Content-Disposition": `attachment; filename="${r.fileName}"`, "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff", "X-Robots-Tag": "noindex, nofollow" },
    });
  } catch (err) {
    if (err instanceof ForbiddenError) return new Response("Not found", { status: 404 });
    if (err instanceof ValidationError) return new Response(err.message, { status: 400 });
    throw err;
  }
}
