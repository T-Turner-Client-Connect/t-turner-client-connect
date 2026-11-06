import "server-only";
import { notFound } from "next/navigation";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { ForbiddenError, type Actor } from "@/lib/auth/actor";
import { officeAccessFor } from "@/lib/auth/permissions";
import { requireUser } from "@/lib/auth/session";

/**
 * Who may open the ADP Payroll & Taxes workspace. It is a Staff Access & Permissions area
 * ("payroll_taxes") that only the owner can grant or revoke (OWNER_GRANTS_ONLY):
 *
 * - MANAGE: the owner (always) or "ADP Payroll & Taxes → Manage". Every client; may change things.
 * - VIEW: "→ View". Read-only, and only the clients assigned to them (the schedule's or a cycle's
 *   assigned staff member, or the client's assigned staff member) unless also "→ All clients".
 * - NONE: the page, its actions and its API routes answer "Not found" (404).
 *
 * Read from the database on every call (nothing cached in the session), so a revoke applies on the
 * next click. Employee-level pay detail additionally needs the existing books check (canUseLedger),
 * the same one the existing pay-run screen uses.
 */

export type PayrollTaxLevel = "NONE" | "VIEW" | "MANAGE";
export type PayrollTaxAccess = { userId: string; level: PayrollTaxLevel; allClients: boolean; isOwner: boolean };

export async function payrollTaxAccess(actor: Pick<Actor, "id">): Promise<PayrollTaxAccess> {
  const a = await officeAccessFor(actor.id);
  const level: PayrollTaxLevel = a.isOwner || a.can("payroll_taxes", "manage") ? "MANAGE" : a.can("payroll_taxes", "view") ? "VIEW" : "NONE";
  return { userId: actor.id, level, allClients: level === "MANAGE" || (level === "VIEW" && a.can("payroll_taxes", "all_clients")), isOwner: a.isOwner };
}

/** Page gate: signed-in staff with access, else a plain 404 (the workspace isn't advertised). */
export async function requirePayrollTaxPage(): Promise<{ actor: Actor; access: PayrollTaxAccess }> {
  const actor = await requireUser();
  const access = await payrollTaxAccess(actor);
  if (access.level === "NONE") notFound();
  return { actor, access };
}

export async function assertPayrollTaxView(actor: Pick<Actor, "id">): Promise<PayrollTaxAccess> {
  const access = await payrollTaxAccess(actor);
  if (access.level === "NONE") throw new ForbiddenError("Not found.");
  return access;
}

export async function assertPayrollTaxManage(actor: Pick<Actor, "id">): Promise<PayrollTaxAccess> {
  const access = await payrollTaxAccess(actor);
  if (access.level === "NONE") throw new ForbiddenError("Not found.");
  if (access.level !== "MANAGE") throw new ForbiddenError("You can view payroll here, but only the owner or staff she allows to manage payroll can change it.");
  return access;
}

/** Cycles this staff member may see. */
export function cycleScope(access: PayrollTaxAccess): Prisma.PayrollCycleWhereInput {
  if (access.allClients) return {};
  const me = access.userId;
  return { OR: [{ assignedStaffId: me }, { schedule: { assignedStaffId: me } }, { client: { assignedToId: me } }] };
}

/** Schedules (clients) this staff member may see. */
export function scheduleScope(access: PayrollTaxAccess): Prisma.PayrollScheduleWhereInput {
  if (access.allClients) return {};
  const me = access.userId;
  return { OR: [{ assignedStaffId: me }, { client: { assignedToId: me } }, { cycles: { some: { assignedStaffId: me } } }] };
}

/** A client this staff member may see in the workspace. */
export async function clientVisible(access: PayrollTaxAccess, clientId: string) {
  if (access.allClients) return true;
  return (await prisma.payrollSchedule.count({ where: { clientId, ...scheduleScope(access) } })) > 0;
}

/** True when the owner or a MANAGE holder (used by the existing pay-run services). */
export async function canManagePayrollTaxes(actor: Pick<Actor, "id">) {
  return (await payrollTaxAccess(actor)).level === "MANAGE";
}
