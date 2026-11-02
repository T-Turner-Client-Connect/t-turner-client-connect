import { clientIp } from "@/lib/auth/session";
import { getPortalUser } from "@/lib/portal/session";
import { readDocumentBytes } from "@/lib/services/documents";
import { bundleFiles } from "@/lib/services/nonprofit-portfolio";
import { combinePrintable, zipFiles } from "@/lib/file-bundle";
import { prisma } from "@/lib/prisma";

/**
 * Download All (ZIP) or Print All (one PDF) for a nonprofit portfolio: only the
 * signed-in client's released documents for that organization. ?ids= limits it
 * to selected documents; every file included is written to the access log.
 */
export async function GET(req: Request, ctx: { params: Promise<{ orgId: string }> }) {
  const portal = await getPortalUser();
  if (!portal) return Response.json({ error: "Sign in required" }, { status: 401 });
  const { orgId } = await ctx.params;
  const params = new URL(req.url).searchParams;
  const format = params.get("format") === "pdf" ? "pdf" : "zip";
  const ids = params.get("ids")?.split(",").filter(Boolean) ?? null;
  let files;
  try {
    files = await bundleFiles(portal, orgId, ids);
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: (e as Error).name === "ValidationError" ? 400 : 403 });
  }
  const loaded = [];
  for (const f of files) {
    const bytes = await readDocumentBytes(f.doc.file);
    if (bytes) loaded.push({ name: f.doc.file.originalName, mime: f.doc.file.mimeType, bytes, documentId: f.doc.id });
  }
  const ip = await clientIp();
  await prisma.documentAccessLog.createMany({ data: loaded.map((l) => ({ documentId: l.documentId, action: format === "pdf" ? "VIEW" : "DOWNLOAD", portalUserId: portal.id, ip })) });
  if (format === "zip") {
    return new Response(Buffer.from(zipFiles(loaded)), { headers: { "Content-Type": "application/zip", "Content-Disposition": 'attachment; filename="nonprofit-portfolio.zip"', "Cache-Control": "private, no-store" } });
  }
  const { bytes, skipped } = await combinePrintable(loaded);
  if (!bytes) return Response.json({ error: "None of these documents can be printed." }, { status: 400 });
  return new Response(Buffer.from(bytes), { headers: { "Content-Type": "application/pdf", "Content-Disposition": 'inline; filename="nonprofit-portfolio-print.pdf"', "Cache-Control": "private, no-store", ...(skipped.length ? { "X-Skipped": String(skipped.length) } : {}) } });
}
