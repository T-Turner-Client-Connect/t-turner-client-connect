import { getPortalUser } from "@/lib/portal/session";
import { requireClientAccess } from "@/lib/portal/access";
import { prisma } from "@/lib/prisma";
import { clientBalanceSheet, clientGeneralLedger, clientProfitAndLoss, clientStatementPdf } from "@/lib/services/client-statements";

/**
 * A client downloads a RELEASED financial statement built from the books (Profit and Loss,
 * Balance Sheet or General Ledger) as a plain PDF. Portal users only, with Managed Business
 * (bookkeeping) access to that business. Anything not approved and released by Tabitha — and
 * any month whose books aren't closed — returns 404. The output contains standard financial
 * presentation only (see services/client-statements.ts).
 */
export async function GET(req: Request) {
  const params = new URL(req.url).searchParams;
  const portal = await getPortalUser();
  if (!portal) return Response.json({ error: "Sign in required" }, { status: 401 });
  const period = await prisma.bookkeepingPeriod.findUnique({ where: { id: params.get("period") ?? "" }, select: { id: true, clientId: true } });
  if (!period) return Response.json({ error: "Not found" }, { status: 404 });
  try {
    await requireClientAccess(portal.id, period.clientId, "bookkeeping");
  } catch {
    return Response.json({ error: "You don't have access to this account's bookkeeping." }, { status: 403 });
  }
  const kind = params.get("kind");
  const build = kind === "bs" ? clientBalanceSheet : kind === "gl" ? clientGeneralLedger : kind === "pl" ? clientProfitAndLoss : null;
  if (!build) return Response.json({ error: "Unknown statement" }, { status: 400 });
  let s;
  try {
    s = await build(period.id);
  } catch {
    return Response.json({ error: "Not available" }, { status: 404 });
  }
  const { pdf, filename } = await clientStatementPdf(s);
  const download = params.get("download") === "1";
  return new Response(pdf as unknown as BodyInit, {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Length": String(pdf.byteLength),
      "Content-Disposition": `${download ? "attachment" : "inline"}; filename="${filename}"`,
      "Cache-Control": "private, no-store",
      "Referrer-Policy": "no-referrer",
      "X-Robots-Tag": "noindex, nofollow",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
