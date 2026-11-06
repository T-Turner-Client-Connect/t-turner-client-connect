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

/**
 * Payroll is one of the client's assigned services, from the same records staff use to assign it:
 * the client record's Services list ("Payroll", any case), an open Payroll service on Services &
 * Agreements (ServiceType PAYROLL), or the bookkeeping profile's payroll switch.
 */
export function hasPayrollService(client: { services: string[]; bookkeepingProfile?: { payroll: boolean } | null }, serviceTypes: ServiceType[] = []) {
  return client.services.some((s) => s.trim().toLowerCase() === "payroll") || serviceTypes.includes("PAYROLL") || !!client.bookkeepingProfile?.payroll;
}

export async function serviceProfile(clientId: string) {
  const c = await prisma.client.findUniqueOrThrow({
    where: { id: clientId },
    select: { clientType: true, services: true, clientServices: { where: { status: { not: "CLOSED" } }, select: { type: true } }, bookkeepingProfile: { select: { payroll: true } } },
  });
  const types = c.clientServices.map((s) => s.type);
  const businessOnly = isBusinessOnly(c, types);
  return { businessOnly, personalTax: !businessOnly, business: c.clientType === "BUSINESS", services: c.services, types, payroll: hasPayrollService(c, types) };
}
