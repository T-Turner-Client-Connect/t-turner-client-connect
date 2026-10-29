import "server-only";
import { prisma } from "@/lib/prisma";

/**
 * Filings and their published documents for one account, grouped by tax
 * year. Only filings marked visible and documents staff published appear.
 */
export async function loadPortalTaxes(clientId: string) {
  const [filings, requests, signatures] = await Promise.all([
    prisma.filingRecord.findMany({
      where: { clientId, visibleToClient: true },
      include: { documents: { where: { deletedAt: null, visibility: "PUBLISHED", scanStatus: { not: "INFECTED" } }, orderBy: { createdAt: "desc" } } },
      orderBy: [{ taxYear: "desc" }, { filingType: "asc" }, { jurisdiction: "asc" }],
    }),
    prisma.documentRequest.findMany({ where: { clientId, status: "OPEN", category: { in: ["TAXES", "CLIENT_UPLOADS"] } }, orderBy: { dueAt: "asc" } }),
    prisma.signatureRequest.findMany({ where: { clientId, status: { not: "DRAFT" } }, orderBy: { createdAt: "desc" } }),
  ]);
  const years = Array.from(new Set([...filings.map((f) => f.taxYear), ...signatures.map((s) => s.taxYear).filter((y): y is number => !!y)])).sort((a, b) => b - a);
  return { filings, requests, signatures, years };
}
