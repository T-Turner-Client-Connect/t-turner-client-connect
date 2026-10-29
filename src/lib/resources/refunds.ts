import "server-only";
import { prisma } from "@/lib/prisma";
import type { RefundLink } from "@/components/resources/check-refund";

/** Federal and state refund links from the verified Resource Center library. */
export async function refundLinks() {
  const [rows, irs] = await Promise.all([
    prisma.resource.findMany({ where: { category: "REFUND_STATUS", hidden: false, jurisdiction: { not: "US" } }, orderBy: { sortOrder: "asc" } }),
    prisma.resource.findMany({ where: { jurisdiction: "US", category: "FEDERAL_TAX", hidden: false } }),
  ]);
  const find = (re: RegExp) => irs.find((r) => r.url && re.test(r.url))?.url ?? null;
  const states: RefundLink[] = rows.map((r) => ({ state: r.jurisdiction, url: r.url, agency: r.agency, status: r.status, note: r.notes }));
  return { irs: { home: find(/^https:\/\/www\.irs\.gov\/?$/), wmr: find(/refund/i) }, states };
}
