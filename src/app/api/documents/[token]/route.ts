import { getCurrentUser, clientIp } from "@/lib/auth/session";
import { getPortalUser } from "@/lib/portal/session";
import { authorizeDownload, readDocumentBytes } from "@/lib/services/documents";
import { isAdminOnlyType } from "@/lib/services/identity";
import { prisma } from "@/lib/prisma";

/**
 * Expiring, viewer-bound document links. The token alone is not enough: the
 * request must also carry the matching signed-in staff or portal session,
 * and access is re-checked against the database on every download.
 */
export async function GET(req: Request, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params;
  const [staff, portal] = await Promise.all([getCurrentUser(), getPortalUser()]);
  if (!staff && !portal) return Response.json({ error: "Sign in required" }, { status: 401 });
  const doc =
    (staff && (await authorizeDownload(token, { staffId: staff.id }))) ||
    (portal && (await authorizeDownload(token, { portalUserId: portal.id }))) ||
    null;
  if (!doc) return Response.json({ error: "This link has expired or you don't have access." }, { status: 403 });
  const params = new URL(req.url).searchParams;
  // Admin-only identity documents (Social Security cards — whose images show the
  // full number — and birth certificates): authorizeDownload already refused
  // everyone but Admins. Each opening needs a confirmation and a reason, and
  // is written to the audit log.
  const adminOnly = doc.category === "IDENTITY" && isAdminOnlyType(doc.docType);
  if (adminOnly) {
    const purpose = (params.get("purpose") ?? "").trim().slice(0, 120);
    if (!staff || params.get("confirm") !== "1" || !purpose) {
      return Response.json({ error: "This document opens only for an Admin, from the Identity Documents page, with a reason." }, { status: 400 });
    }
    await prisma.auditLog.create({
      data: { actorId: staff.id, action: "identity.admin_only_opened", entityType: "Document", entityId: doc.id, clientId: doc.clientId, details: { type: doc.docType, purpose, download: params.get("download") === "1" } },
    });
  }
  const bytes = await readDocumentBytes(doc.file);
  if (!bytes) return Response.json({ error: "File unavailable" }, { status: 404 });
  const download = params.get("download") === "1";
  await prisma.documentAccessLog.create({
    data: { documentId: doc.id, action: download ? "DOWNLOAD" : "VIEW", staffUserId: staff?.id ?? null, portalUserId: staff ? null : portal?.id ?? null, ip: await clientIp() },
  });
  const safeName = doc.file.originalName.replace(/[^\w.\- ()]/g, "_");
  return new Response(bytes as unknown as BodyInit, {
    headers: {
      "Content-Type": doc.file.mimeType,
      "Content-Length": String(bytes.byteLength),
      "Content-Disposition": `${download ? "attachment" : "inline"}; filename="${safeName}"`,
      "Cache-Control": "private, no-store",
      "Referrer-Policy": "no-referrer",
      "X-Robots-Tag": "noindex, nofollow",
      "X-Content-Type-Options": "nosniff",
      ...(doc.file.mimeType.startsWith("image/") ? { "Content-Security-Policy": "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox" } : {}),
    },
  });
}
