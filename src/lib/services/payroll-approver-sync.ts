import "server-only";
import type { Prisma } from "@prisma/client";

/**
 * Keeps a business's PayrollApprover row in step with the owner's portal permission
 * "Payroll approval → Approve/Deny" (PortalAccess.canApprovePayroll).
 *
 * The permission is the source of truth for WHETHER a login approves payroll (isPayrollApprover
 * reads it through ownerHasPermission). The PayrollApprover row holds HOW they take part: required
 * or optional, per-employee detail and notification channel. Every place that writes the permission
 * calls this in the same transaction, so a permitted owner always has an active row and a row is
 * never active without the permission. Earlier required/detail/notification choices are kept.
 */
export async function syncPayrollApproverRow(tx: Prisma.TransactionClient, input: { clientId: string; portalUserId: string; on: boolean; actorId: string | null }) {
  const { clientId, portalUserId, on } = input;
  const before = await tx.payrollApprover.findUnique({ where: { clientId_portalUserId: { clientId, portalUserId } } });
  // Whoever granted it (an accepted invitation may not name its sender: then the owner's account).
  const actorId = input.actorId ?? (await tx.ownerAccess.findFirst({ where: { isPrimary: true, revokedAt: null }, select: { userId: true } }))?.userId ?? null;
  if (on) {
    if (before?.active) return;
    if (before) await tx.payrollApprover.update({ where: { id: before.id }, data: { active: true, removedAt: null, removedById: null } });
    else if (actorId) await tx.payrollApprover.create({ data: { clientId, portalUserId, designatedById: actorId, active: true, required: false } });
  } else if (before?.active) {
    await tx.payrollApprover.update({ where: { id: before.id }, data: { active: false, required: false, removedAt: new Date(), removedById: actorId } });
  }
}
