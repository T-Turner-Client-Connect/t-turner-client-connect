import "server-only";
import { prisma } from "@/lib/prisma";
import { requireClientAccess } from "./access";
import { flagFor, type OwnerAction, type OwnerAreaKey } from "./owner-areas";

/**
 * One question for other features: may this portal login do `action` in `area`
 * on this business? Read fresh from the database (changes apply immediately).
 *
 * - "k1"/"view" is true for any active owner (their OWN K-1s; other owners' K-1s
 *   are filtered per document by k1VisibleWhere).
 * - "payrollApproval"/"approve" is true only for an active business owner of this
 *   client whose login was granted it. It never implies any payroll edit right.
 * - Any other area/action maps to the login's PortalAccess flag.
 *
 * The payroll branch's `isPayrollApprover(portalUserId, clientId)` can simply
 * return `ownerHasPermission(portalUserId, clientId, "payrollApproval", "approve")`.
 */
export async function ownerHasPermission(portalUserId: string, clientId: string, area: OwnerAreaKey, action: OwnerAction): Promise<boolean> {
  let access;
  try {
    access = await requireClientAccess(portalUserId, clientId);
  } catch {
    return false;
  }
  const isOwner = async () => (await prisma.businessOwner.count({ where: { clientId, portalUserId, archivedAt: null } })) > 0;
  if (area === "k1") return action === "view" && (await isOwner());
  const flag = flagFor(area, action);
  if (!flag || !access[flag]) return false;
  if (area === "payrollApproval") return isOwner();
  return true;
}
