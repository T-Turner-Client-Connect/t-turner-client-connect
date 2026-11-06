import { clientIp } from "@/lib/auth/session";
import { getPortalUser } from "@/lib/portal/session";
import { prisma } from "@/lib/prisma";
import { readDocumentBytes } from "@/lib/services/documents";
import { portalComplianceDocument } from "@/lib/services/compliance/views";

/** A client's compliance document: re-checks entity, obligation and portal access on every request. */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await getPortalUser();
  if (!user) return Response.json({ error: "Sign in required" }, { status: 401 });
  const { id } = await ctx.params;
  const doc = await portalComplianceDocument(user.id, id);
  if (!doc) return Response.json({ error: "Not found" }, { status: 404 });
  const bytes = await readDocumentBytes(doc.file);
  if (!bytes) return Response.json({ error: "File unavailable" }, { status: 404 });
  await prisma.documentAccessLog.create({ data: { documentId: doc.id, action: "VIEW", portalUserId: user.id, ip: await clientIp() } });
  return new Response(bytes as unknown as BodyInit, {
    headers: { "Content-Type": doc.file.mimeType, "Content-Disposition": `inline; filename="${doc.file.originalName.replace(/[^\w.\- ()]/g, "_")}"`, "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer" },
  });
}
