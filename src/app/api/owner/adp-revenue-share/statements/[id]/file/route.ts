import { getCurrentUser } from "@/lib/auth/session";
import { primaryOwnerAccess } from "@/lib/auth/owner";
import { readStatementFile } from "@/lib/services/adp-revenue-share";

// ADP Revenue Share → the uploaded ADP statement, from the owner-only store. The owner only:
// everyone else (staff, Admins who aren't the owner, portal logins, no session) gets a plain 404.
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const actor = await getCurrentUser();
  if (!actor || !(await primaryOwnerAccess(actor.id))) return new Response("Not found", { status: 404 });
  const r = await readStatementFile(actor, (await ctx.params).id);
  if (!r) return new Response("Not found", { status: 404 });
  const pdf = r.mime === "application/pdf";
  return new Response(r.bytes as unknown as BodyInit, {
    headers: {
      "Content-Type": r.mime,
      // PDFs open in the browser; CSV/XLSX download (never rendered as a page).
      "Content-Disposition": `${pdf ? "inline" : "attachment"}; filename="${r.name.replace(/[^\w.\- ()]/g, "_")}"`,
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
      ...(pdf ? {} : { "Content-Security-Policy": "default-src 'none'; sandbox" }),
    },
  });
}
