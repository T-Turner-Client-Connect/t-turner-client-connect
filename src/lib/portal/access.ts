import "server-only";
import type { BusinessAccess, DocumentCategory, PortalAccess, Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { ForbiddenError } from "@/lib/auth/actor";

export type Permission = "message" | "upload" | "bookkeeping" | "tax" | "contracts" | "billing" | "documents" | "payroll" | "payrollUpload" | "payrollApprove";

const FLAG: Record<Permission, keyof PortalAccess> = {
  message: "canMessage",
  upload: "canUpload",
  bookkeeping: "canViewBookkeeping",
  tax: "canViewTax",
  contracts: "canViewContracts",
  billing: "canViewBilling",
  documents: "canViewDocuments",
  payroll: "canViewPayroll",
  payrollUpload: "canUploadPayroll",
  payrollApprove: "canApprovePayroll",
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
 * Read fresh from the database on every call, so a change takes effect at once.
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

type CategoryFlags = Pick<PortalAccess, "canViewBookkeeping" | "canViewTax" | "canViewContracts"> & Partial<Pick<PortalAccess, "canViewDocuments" | "canViewPayroll">>;

/**
 * Document categories a login may list. OWNER_K1 is never here: a K-1 opens only
 * through `portalDocumentScope` for its owner (or an owner Tabitha shared it with).
 * Business documents and payroll default to on (ordinary client logins); a
 * business owner's login has them off until granted.
 */
export function allowedCategories(access: CategoryFlags): DocumentCategory[] {
  const docs = access.canViewDocuments !== false;
  return [
    ...(access.canViewBookkeeping ? (["BOOKKEEPING"] as const) : []),
    ...(access.canViewTax ? (["TAXES"] as const) : []),
    ...(access.canViewContracts ? (["CONTRACTS"] as const) : []),
    ...(access.canViewPayroll !== false ? (["PAYROLL"] as const) : []),
    ...(docs ? (["CLIENT_UPLOADS", "OTHER"] as const) : []),
  ];
}

/** Where a K-1 is visible to this login: it's their own, or Tabitha shared that owner's K-1s with them. */
export function k1VisibleWhere(portalUserId: string): Prisma.DocumentWhereInput {
  return {
    category: "OWNER_K1",
    businessOwner: {
      archivedAt: null,
      OR: [{ portalUserId }, { k1SharedWith: { some: { revokedAt: null, viewer: { portalUserId, archivedAt: null } } } }],
    },
  };
}

/**
 * Every document this login may see for one account, as one filter: the allowed
 * categories, plus their own uploads (always), plus K-1s they may open. With no
 * viewer (staff preview) it is just the categories.
 */
export function portalDocumentScope(access: CategoryFlags, portalUserId: string | null): Prisma.DocumentWhereInput {
  const categories = allowedCategories(access);
  if (!portalUserId) return { category: { in: categories } };
  return {
    OR: [
      { category: { in: categories } },
      { category: "CLIENT_UPLOADS", uploadedByPortalId: portalUserId },
      k1VisibleWhere(portalUserId),
    ],
  };
}

/** Message threads a login may see: shared threads, and private threads that are theirs. */
export function conversationScope(portalUserId: string | null): Prisma.ConversationWhereInput {
  return portalUserId ? { OR: [{ privateToPortalUserId: null }, { privateToPortalUserId: portalUserId }] } : { privateToPortalUserId: null };
}
