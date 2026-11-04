import "server-only";
import type { BusinessAccess, PortalAccess, Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { ForbiddenError } from "@/lib/auth/actor";

export type Permission = "message" | "upload" | "bookkeeping" | "tax" | "contracts" | "billing";

const FLAG: Record<Permission, keyof PortalAccess> = {
  message: "canMessage",
  upload: "canUpload",
  bookkeeping: "canViewBookkeeping",
  tax: "canViewTax",
  contracts: "canViewContracts",
  billing: "canViewBilling",
};

/**
 * Managed Business gate. A login's business view (bookkeeping, ledger, business
 * statements, business invoicing) counts ONLY when the business itself is an
 * owner-approved Managed Business. Client type, registration answers, tax return
 * type and the per-login flag alone never grant it. Applied here, at the source,
 * so every portal page, action, API route and notification gets the same answer.
 */
export function effectiveGrant<T extends { canViewBookkeeping: boolean }>(grant: T, businessAccess: BusinessAccess | null | undefined): T {
  return { ...grant, canViewBookkeeping: grant.canViewBookkeeping && businessAccess === "ACTIVE" };
}

/** Client accounts this portal user may see (active grants, non-archived clients). */
export async function accessibleClients(portalUserId: string) {
  const rows = await prisma.portalAccess.findMany({
    where: { portalUserId, revokedAt: null, client: { archivedAt: null } },
    include: { client: { select: { id: true, displayName: true, businessName: true, clientType: true, businessAccess: true } } },
    orderBy: { client: { displayName: "asc" } },
  });
  return rows.map((r) => effectiveGrant(r, r.client.businessAccess));
}

/** Portal grants for one client with the business gate applied (for notifications). */
export async function effectiveGrantsFor(clientId: string, where: Prisma.PortalAccessWhereInput = {}) {
  const rows = await prisma.portalAccess.findMany({ where: { ...where, clientId, revokedAt: null }, include: { client: { select: { businessAccess: true } } } });
  return rows.map((r) => effectiveGrant(r, r.client.businessAccess));
}

/**
 * The single gate for every portal read and write. Throws unless this portal
 * user has an active grant for the client (and the permission, if given).
 */
export async function requireClientAccess(portalUserId: string, clientId: string, permission?: Permission) {
  const row = await prisma.portalAccess.findFirst({
    where: { portalUserId, clientId, revokedAt: null, client: { archivedAt: null } },
    include: { client: { select: { businessAccess: true } } },
  });
  if (!row) throw new ForbiddenError("You don't have access to that account.");
  const { client, ...grant } = row;
  const access = effectiveGrant(grant, client.businessAccess);
  if (permission && !access[FLAG[permission]]) throw new ForbiddenError("Your access to this account doesn't include that.");
  return access;
}

export function allowedCategories(access: PortalAccess) {
  return [
    ...(access.canViewBookkeeping ? (["BOOKKEEPING"] as const) : []),
    ...(access.canViewTax ? (["TAXES"] as const) : []),
    ...(access.canViewContracts ? (["CONTRACTS"] as const) : []),
    "CLIENT_UPLOADS" as const,
    "OTHER" as const,
  ];
}
