import "server-only";
import type { ClientType, ServiceType } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { PERSONAL_TAX_LABELS } from "@/lib/service-options";

/**
 * What a client's portal shows, driven by the services selected for them: the
 * client record's Services list and the billable services on Services &
 * Agreements. Individuals (and nonprofits) are unchanged. A BUSINESS client is
 * "business-only" unless personal tax preparation is one of its services; its
 * portal then shows business items only — no 1040 questionnaire, spouse,
 * dependents, identity documents or refund options.
 */
export function isBusinessOnly(client: { clientType: ClientType; services: string[] }, serviceTypes: ServiceType[] = []) {
  if (client.clientType !== "BUSINESS") return false;
  const personal = client.services.some((s) => PERSONAL_TAX_LABELS.has(s.trim().toLowerCase())) || serviceTypes.includes("TAX_INDIVIDUAL");
  return !personal;
}

export async function serviceProfile(clientId: string) {
  const c = await prisma.client.findUniqueOrThrow({
    where: { id: clientId },
    select: { clientType: true, services: true, clientServices: { where: { status: { not: "CLOSED" } }, select: { type: true } } },
  });
  const types = c.clientServices.map((s) => s.type);
  const businessOnly = isBusinessOnly(c, types);
  return { businessOnly, personalTax: !businessOnly, services: c.services, types };
}
