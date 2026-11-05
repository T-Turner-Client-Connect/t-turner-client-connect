import { getPortalUser } from "@/lib/portal/session";
import { clientIp } from "@/lib/auth/session";
import { prisma } from "@/lib/prisma";
import { readDocumentBytes } from "@/lib/services/documents";
import { isPayrollApprover } from "@/lib/services/payroll-approval";

/**
 * The ADP preview attached to one pay-run version, for that business's payroll approvers only.
 * The document stays STAFF_ONLY in the client file; this route opens it for an approver of the
 * same business, for the version they are deciding on. Anyone else gets a plain 404.
 */
export async function GET(_req: Request, ctx: { params: Promise<{ versionId: string }> }) {
  const { versionId } = await ctx.params;
  const portal = await getPortalUser();
  if (!portal) return Response.json({ error: "Sign in required" }, { status: 401 });
  const notFound = () => Response.json({ error: "Not found" }, { status: 404 });
  const version = await prisma.payrollRunVersion.findUnique({ where: { id: versionId }, select: { id: true, documentId: true, run: { select: { clientId: true, status: true } } } });
  if (!version?.documentId || version.run.status === "DISCARDED") return notFound();
  if (!(await isPayrollApprover(portal.id, version.run.clientId))) return notFound();
  // ADP's preview lists employees, so it follows the approver's per-employee detail setting.
  const approver = await prisma.payrollApprover.findUnique({ where: { clientId_portalUserId: { clientId: version.run.clientId, portalUserId: portal.id } }, select: { showEmployeeDetail: true } });
  if (!approver?.showEmployeeDetail) return notFound();
  const doc = await prisma.document.findFirst({ where: { id: version.documentId, clientId: version.run.clientId, deletedAt: null, docType: "PAYROLL_PREVIEW" }, include: { file: true } });
  if (!doc || doc.scanStatus === "INFECTED") return notFound();
  const bytes = await readDocumentBytes(doc.file);
  if (!bytes) return notFound();
  await prisma.documentAccessLog.create({ data: { documentId: doc.id, action: "VIEW", portalUserId: portal.id, ip: await clientIp() } });
  return new Response(bytes as unknown as BodyInit, {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Length": String(bytes.byteLength),
      "Content-Disposition": `inline; filename="adp-preview.pdf"`,
      "Cache-Control": "private, no-store",
      "Referrer-Policy": "no-referrer",
      "X-Robots-Tag": "noindex, nofollow",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
