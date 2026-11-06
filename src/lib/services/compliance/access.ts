import "server-only";
import { prisma } from "@/lib/prisma";
import { ForbiddenError, type Actor } from "@/lib/auth/actor";
import { officeAccessFor } from "@/lib/auth/permissions";

/**
 * Tax & Compliance Center access. Granted per staff member in Owner's Office → Settings → Staff
 * Access & Permissions (area "Tax & Compliance Center"):
 *   NONE   no grant — every page is a 404 and every action "Not found."
 *   VIEW   compliance.view — read-only
 *   MANAGE compliance.manage — profile edits, period work, evidence, approvals sent to clients
 * The owner (primary OwnerAccess) always has MANAGE plus the owner-only actions (activate /
 * suspend / close obligations, rules library edits, switches). EIN reveal needs the owner or an
 * explicit compliance.reveal_ein grant. Read fresh from the database on every call.
 */
export type ComplianceLevel = "NONE" | "VIEW" | "MANAGE";
export type ComplianceAccess = { level: ComplianceLevel; isOwner: boolean; canRevealEin: boolean };

export async function complianceAccess(actor: Pick<Actor, "id">): Promise<ComplianceAccess> {
  const a = await officeAccessFor(actor.id);
  const level: ComplianceLevel = a.isOwner || a.can("compliance", "manage") ? "MANAGE" : a.can("compliance", "view") ? "VIEW" : "NONE";
  return { level, isOwner: a.isOwner, canRevealEin: a.isOwner || a.can("compliance", "reveal_ein") };
}

export async function assertComplianceView(actor: Pick<Actor, "id">) {
  const a = await complianceAccess(actor);
  if (a.level === "NONE") throw new ForbiddenError("Not found.");
  return a;
}

export async function assertComplianceManage(actor: Pick<Actor, "id">) {
  const a = await complianceAccess(actor);
  if (a.level === "NONE") throw new ForbiddenError("Not found.");
  if (a.level !== "MANAGE") throw new ForbiddenError("Your Tax & Compliance access is view-only.");
  return a;
}

export async function assertComplianceOwner(actor: Pick<Actor, "id">) {
  const a = await complianceAccess(actor);
  if (a.level === "NONE") throw new ForbiddenError("Not found.");
  if (!a.isOwner) throw new ForbiddenError("Only Tabitha can do that.");
  return a;
}

export async function primaryOwnerId(): Promise<string | null> {
  const o = await prisma.ownerAccess.findFirst({ where: { isPrimary: true, revokedAt: null, user: { active: true } }, select: { userId: true } });
  return o?.userId ?? null;
}
