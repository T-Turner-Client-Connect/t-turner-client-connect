import { getCurrentUser, clientIp } from "@/lib/auth/session";
import { getPortalUser } from "@/lib/portal/session";
import { authorizeDownload, readDocumentBytes } from "@/lib/services/documents";
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
  // Social Security card images show the full number: view only (no download),
  // and only after the viewer confirms; staff also give a reason, which is audited.
  const ssCard = doc.category === "IDENTITY" && doc.docType === "SOCIAL_SECURITY_CARD";
  if (ssCard) {
    const purpose = (params.get("purpose") ?? "").trim().slice(0, 120);
    if (params.get("confirm") !== "1" || (staff && !purpose)) {
      return Response.json({ error: "Social Security card images open only from the Identity Documents page after you confirm (staff: with a reason)." }, { status: 400 });
    }
    await prisma.auditLog.create({
      data: { actorId: staff?.id ?? null, action: "identity.ss_card_viewed", entityType: "Document", entityId: doc.id, clientId: doc.clientId, details: { purpose: purpose || "client viewed own record", portalUserId: staff ? null : portal?.id ?? null } },
    });
  }
  const bytes = await readDocumentBytes(doc.file);
  if (!bytes) return Response.json({ error: "File unavailable" }, { status: 404 });
  const download = params.get("download") === "1" && !ssCard;
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
