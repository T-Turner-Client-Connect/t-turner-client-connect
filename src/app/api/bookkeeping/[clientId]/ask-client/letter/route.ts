import { getCurrentUser } from "@/lib/auth/session";
import { ForbiddenError } from "@/lib/auth/actor";
import { ValidationError } from "@/lib/services/clients";
import { askLetterPdf } from "@/lib/services/ask-client";

// Ask Client → request letter on the firm's letterhead (staff who may send this business requests).
export async function GET(_req: Request, ctx: { params: Promise<{ clientId: string }> }) {
  const actor = await getCurrentUser();
  if (!actor) return new Response("Sign in required", { status: 401 });
  try {
    const r = await askLetterPdf(actor, (await ctx.params).clientId);
    return new Response(r.bytes as unknown as BodyInit, {
      headers: { "Content-Type": "application/pdf", "Content-Disposition": `inline; filename="${r.fileName}"`, "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" },
    });
  } catch (err) {
    if (err instanceof ForbiddenError) return new Response("Not found", { status: 404 });
    if (err instanceof ValidationError) return new Response(err.message, { status: 400 });
    throw err;
  }
}
