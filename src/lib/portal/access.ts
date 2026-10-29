import "server-only";
import type { PortalAccess } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { ForbiddenError } from "@/lib/auth/actor";

export type Permission = "message" | "upload" | "bookkeeping" | "tax" | "contracts";

const FLAG: Record<Permission, keyof PortalAccess> = {
  message: "canMessage",
  upload: "canUpload",
  bookkeeping: "canViewBookkeeping",
  tax: "canViewTax",
  contracts: "canViewContracts",
};

/** Client accounts this portal user may see (active grants, non-archived clients). */
export function accessibleClients(portalUserId: string) {
  return prisma.portalAccess.findMany({
    where: { portalUserId, revokedAt: null, client: { archivedAt: null } },
    include: { client: { select: { id: true, displayName: true, businessName: true, clientType: true } } },
    orderBy: { client: { displayName: "asc" } },
  });
}

/**
 * The single gate for every portal read and write. Throws unless this portal
 * user has an active grant for the client (and the permission, if given).
 */
export async function requireClientAccess(portalUserId: string, clientId: string, permission?: Permission) {
  const access = await prisma.portalAccess.findFirst({
    where: { portalUserId, clientId, revokedAt: null, client: { archivedAt: null } },
  });
  if (!access) throw new ForbiddenError("You don't have access to that account.");
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
