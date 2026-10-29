import { getCurrentUser } from "@/lib/auth/session";
import { readStoredFile } from "@/lib/services/files";

// Files are private: every request is checked against the staff session.
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return Response.json({ error: "Sign in required" }, { status: 401 });
  const { id } = await ctx.params;
  const found = await readStoredFile(id);
  if (!found) return Response.json({ error: "Not found" }, { status: 404 });
  const { file, bytes } = found;
  const safeName = file.originalName.replace(/[^\w.\- ()]/g, "_");
  return new Response(bytes as unknown as BodyInit, {
    headers: {
      "Content-Type": file.mimeType,
      "Content-Length": String(bytes.byteLength),
      "Content-Disposition": `inline; filename="${safeName}"`,
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
      // Uploads are signature-checked PNG/JPEG/PDF. Browsers' PDF viewers don't
      // run inside a sandboxed document, so the sandbox applies to images only.
      ...(file.mimeType.startsWith("image/") ? { "Content-Security-Policy": "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox" } : {}),
    },
  });
}
