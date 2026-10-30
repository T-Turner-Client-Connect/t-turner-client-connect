import { clientIp, getCurrentUser } from "@/lib/auth/session";
import { getPortalUser } from "@/lib/portal/session";
import { requireClientAccess } from "@/lib/portal/access";
import { prisma } from "@/lib/prisma";
import { PERIOD_TYPES, type PeriodType } from "@/lib/bookkeeping-periods";
import { isHistorical, portalVerified } from "@/lib/services/documents";
import { buildPacketPdf, packetReports } from "@/lib/services/financial-packet";

/**
 * The printable financial packet for one client month (and period type).
 * Staff see the current versions, with drafts clearly stamped. Clients see
 * only delivered, scanned-clean reports, with the same access checks as any
 * document download; every included file is logged.
 */
export async function GET(req: Request) {
  const params = new URL(req.url).searchParams;
  const periodId = params.get("period") ?? "";
  const type = (params.get("type") ?? "MONTH") as PeriodType;
  if (!(type in PERIOD_TYPES)) return Response.json({ error: "Unknown period type" }, { status: 400 });
  const [staff, portal] = await Promise.all([getCurrentUser(), getPortalUser()]);
  if (!staff && !portal) return Response.json({ error: "Sign in required" }, { status: 401 });
  const period = await prisma.bookkeepingPeriod.findUnique({ where: { id: periodId }, select: { id: true, clientId: true } });
  if (!period) return Response.json({ error: "Not found" }, { status: 404 });
  let viewer: { staff: true } | { portalUserId: string };
  if (staff) viewer = { staff: true };
  else {
    try {
      await requireClientAccess(portal!.id, period.clientId, "bookkeeping");
    } catch {
      return Response.json({ error: "You don't have access to this account's bookkeeping." }, { status: 403 });
    }
    const docs = await packetReports(period.id, type, { portalUserId: portal!.id });
    if (docs.some((d) => isHistorical(d)) && !(await portalVerified(portal!.id))) {
      return Response.json({ error: "Verify your email address to open earlier years' records." }, { status: 403 });
    }
    viewer = { portalUserId: portal!.id };
  }
  const built = await buildPacketPdf(period.id, type, viewer);
  if (!built) return Response.json({ error: "No reports in this packet yet." }, { status: 404 });
  const download = params.get("download") === "1";
  const ip = await clientIp();
  await prisma.documentAccessLog.createMany({
    data: built.usedFiles.map((documentId) => ({ documentId, action: download ? "DOWNLOAD" : "VIEW", staffUserId: staff?.id ?? null, portalUserId: staff ? null : portal!.id, ip })),
  });
  return new Response(built.pdf as unknown as BodyInit, {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Length": String(built.pdf.byteLength),
      "Content-Disposition": `${download ? "attachment" : "inline"}; filename="${built.filename}"`,
      "Cache-Control": "private, no-store",
      "Referrer-Policy": "no-referrer",
      "X-Robots-Tag": "noindex, nofollow",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
