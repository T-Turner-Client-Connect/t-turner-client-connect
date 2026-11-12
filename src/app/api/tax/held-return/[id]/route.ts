import { getCurrentUser } from "@/lib/auth/session";
import { heldReturnBytes } from "@/lib/services/return-gate";

// The held file, for Tabitha or an Admin reviewing it (each opening is logged). Never cached.
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const actor = await getCurrentUser();
  if (!actor) return new Response("Sign in again.", { status: 401 });
  const { id } = await ctx.params;
  try {
    const f = await heldReturnBytes(actor, id);
    return new Response(Buffer.from(f.bytes), { headers: { "content-type": "application/pdf", "content-disposition": `inline; filename="held-return.pdf"`, "cache-control": "no-store", "x-content-type-options": "nosniff" } });
  } catch (err) {
    return new Response(err instanceof Error ? err.message : "Not available.", { status: 403 });
  }
}
