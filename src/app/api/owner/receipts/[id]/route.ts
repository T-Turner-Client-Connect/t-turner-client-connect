import { ownerFromSession } from "@/lib/auth/owner";
import { readReceipt } from "@/lib/services/owner-expenses";

// Expense receipts: owner-only, from the owner's private store.
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const actor = await ownerFromSession("full");
  if (!actor) return new Response("Not found", { status: 404 });
  const r = await readReceipt(actor, (await ctx.params).id);
  if (!r) return new Response("Not found", { status: 404 });
  return new Response(r.bytes as unknown as BodyInit, {
    headers: {
      "Content-Type": r.mime,
      "Content-Disposition": `inline; filename="${r.name.replace(/[^\w.\- ()]/g, "_")}"`,
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
      ...(r.mime.startsWith("image/") ? { "Content-Security-Policy": "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox" } : {}),
    },
  });
}
