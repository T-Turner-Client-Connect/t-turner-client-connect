import "server-only";
import type { BusinessAccess, DocumentCategory, PortalAccess, PortalRole, Prisma } from "@prisma/client";
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

/** The client facts the business-view rule reads. Select them with `BUSINESS_VIEW_CLIENT`. */
export type BusinessViewClient = { businessAccess: BusinessAccess | null | undefined; bookkeepingProfile?: { active: boolean } | null };
export const BUSINESS_VIEW_CLIENT = { businessAccess: true, bookkeepingProfile: { select: { active: true } } } as const;

/**
 * Can this business have a business view at all? Only a client an administrator enrolled on the
 * bookkeeping service ("+ Add Bookkeeping Client" → enrollExistingClient / enrollNewClient, which
 * make an ACTIVE bookkeeping profile — the staff Bookkeeping Clients list). An owner-approved
 * Managed Business that isn't enrolled, a paused profile, services picked at sign-up, client type,
 * registration answers and tax return type never grant it: those clients stay on the tax client
 * portal. Removing Managed Business access (REMOVED) always takes it away.
 */
export function businessViewEligible(client: BusinessViewClient): boolean {
  if (client.businessAccess === "REMOVED") return false;
  return hasBookkeepingService(client);
}

/**
 * Bookkeeping is part of this client's engagement: an administrator added the client to the
 * bookkeeping service (an ACTIVE bookkeeping profile — the staff Bookkeeping Clients list). A paused
 * profile (as business onboarding approval creates), services picked at sign-up (Client.services),
 * Managed Business access, client type, registration answers and tax return type never count.
 */
export function hasBookkeepingService(client: { bookkeepingProfile?: { active: boolean } | null }): boolean {
  return client.bookkeepingProfile?.active === true;
}

/**
 * The one rule for a login's business view (business dashboard, bookkeeping, ledger, business
 * statements, business invoicing, bank feed). Every portal gate goes through it (effectiveGrant
 * below), and so does View as Client, so the Home page and the gates can never disagree.
 * - The business must be eligible (businessViewEligible), and
 * - the login has the per-login switch on (canViewBookkeeping), or it is an OWNER login of a
 *   client on the Bookkeeping Client list. Authorized contacts need the switch.
 * Client type, registration answers and tax return type never grant it.
 */
export function hasBusinessView(grant: { canViewBookkeeping: boolean; role?: PortalRole | null }, client: BusinessViewClient): boolean {
  if (!businessViewEligible(client)) return false;
  return grant.canViewBookkeeping || (grant.role === "OWNER" && !!client.bookkeepingProfile?.active);
}

/** A grant with the business-view rule applied (canViewBookkeeping = hasBusinessView). */
export function effectiveGrant<T extends { canViewBookkeeping: boolean; role?: PortalRole | null }>(grant: T, client: BusinessViewClient): T {
  return { ...grant, canViewBookkeeping: hasBusinessView(grant, client) };
}

/** Client accounts this portal user may see (active grants, non-archived clients). */
export async function accessibleClients(portalUserId: string) {
  const rows = await prisma.portalAccess.findMany({
    where: { portalUserId, revokedAt: null, client: { archivedAt: null } },
    include: { client: { select: { id: true, displayName: true, businessName: true, clientType: true, ...BUSINESS_VIEW_CLIENT } } },
    orderBy: { client: { displayName: "asc" } },
  });
  return rows.map((r) => effectiveGrant(r, r.client));
}

/** Portal grants for one client with the business gate applied (for notifications). */
export async function effectiveGrantsFor(clientId: string, where: Prisma.PortalAccessWhereInput = {}) {
  const rows = await prisma.portalAccess.findMany({ where: { ...where, clientId, revokedAt: null }, include: { client: { select: BUSINESS_VIEW_CLIENT } } });
  return rows.map((r) => effectiveGrant(r, r.client));
}

/**
 * The single gate for every portal read and write. Throws unless this portal
 * user has an active grant for the client (and the permission, if given).
 * Read fresh from the database on every call, so a change takes effect at once.
 */
export async function requireClientAccess(portalUserId: string, clientId: string, permission?: Permission) {
  const row = await prisma.portalAccess.findFirst({
    where: { portalUserId, clientId, revokedAt: null, client: { archivedAt: null } },
    include: { client: { select: BUSINESS_VIEW_CLIENT } },
  });
  if (!row) throw new ForbiddenError("You don't have access to that account.");
  const { client, ...grant } = row;
  const access = effectiveGrant(grant, client);
  if (permission && !access[FLAG[permission]]) throw new ForbiddenError("Your access to this account doesn't include that.");
  return access;
}

type CategoryFlags = Pick<PortalAccess, "canViewBookkeeping" | "canViewTax" | "canViewContracts"> & Partial<Pick<PortalAccess, "canViewDocuments" | "canViewPayroll">>;

/**
 * Document categories a login may list. OWNER_K1 and OWNER_PERSONAL are never here: they open
 * only through `portalDocumentScope` for their owner (a K-1 also for owners Tabitha shared it with).
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
/** Payroll files by type, wherever they were filed (a payroll register is kept under Bookkeeping). */
export const PAYROLL_DOC_TYPES = ["PAYROLL_REPORT", "FORM_W2_ISSUED"];
/** Not a payroll file by type (null-safe: SQL NOT over a nullable column would also drop NULL rows). */
const notPayrollByType: Prisma.DocumentWhereInput = {
  OR: [{ docType: null }, { AND: [{ docType: { notIn: PAYROLL_DOC_TYPES } }, { NOT: { docType: { startsWith: "PAYROLL" } } }] }],
};

export function portalDocumentScope(access: CategoryFlags, portalUserId: string | null): Prisma.DocumentWhereInput {
  const categories = allowedCategories(access);
  // A login without payroll access sees no payroll file, whatever category it was filed under.
  const byCategory: Prisma.DocumentWhereInput = access.canViewPayroll === false ? { AND: [{ category: { in: categories } }, notPayrollByType] } : { category: { in: categories } };
  if (!portalUserId) return byCategory;
  return {
    OR: [
      byCategory,
      { category: "CLIENT_UPLOADS", uploadedByPortalId: portalUserId },
      k1VisibleWhere(portalUserId),
      ownerPersonalVisibleWhere(portalUserId),
    ],
  };
}

/**
 * A business owner's own personal tax documents (OWNER_PERSONAL) on a business account: only that
 * owner's login (Document.businessOwnerId → BusinessOwner.portalUserId), or — when the uploader
 * isn't linked to an owner record — the uploading login. Never other owners, authorized contacts,
 * or anyone a K-1 was shared with; never in View as Client (no viewer). Staff see them as usual.
 */
export function ownerPersonalVisibleWhere(portalUserId: string): Prisma.DocumentWhereInput {
  return {
    category: "OWNER_PERSONAL",
    OR: [{ businessOwner: { portalUserId, archivedAt: null } }, { businessOwnerId: null, uploadedByPortalId: portalUserId }],
  };
}

/**
 * Document requests a login may see and answer: the account's ordinary requests, plus requests for
 * this login's own owner record (personal or identity documents). A request for one owner is never
 * shown to another owner or contact, nor in View as Client (no viewer).
 */
export function requestVisibleWhere(portalUserId: string | null): Prisma.DocumentRequestWhereInput {
  return { OR: [{ businessOwnerId: null }, ...(portalUserId ? [{ businessOwner: { portalUserId, archivedAt: null } }] : [])] };
}

/** Message threads a login may see: shared threads, and private threads that are theirs. */
export function conversationScope(portalUserId: string | null): Prisma.ConversationWhereInput {
  return portalUserId ? { OR: [{ privateToPortalUserId: null }, { privateToPortalUserId: portalUserId }] } : { privateToPortalUserId: null };
}
