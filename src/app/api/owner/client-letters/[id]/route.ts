import { getCurrentUser } from "@/lib/auth/session";
import { primaryOwnerAccess } from "@/lib/auth/owner";
import { letterPdf } from "@/lib/services/client-letters";

// Client Letters → Preview: the owner only (a plain 404 for anyone else), never cached.
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const actor = await getCurrentUser();
  if (!actor || !(await primaryOwnerAccess(actor.id))) return new Response("Not found", { status: 404 });
  const r = await letterPdf(actor, (await ctx.params).id);
  if (!r) return new Response("Not found", { status: 404 });
  return new Response(r.bytes as unknown as BodyInit, {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `inline; filename="${r.name}"`,
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
