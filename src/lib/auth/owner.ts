import "server-only";
import { cache } from "react";
import { notFound } from "next/navigation";
import type { OwnerAccess } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { OWNER_EMAIL } from "@/lib/business";
import { normalizeEmail } from "@/lib/normalize";
import { verifyPassword } from "./password";
import { ForbiddenError, type Actor } from "./actor";
import { getCurrentUser, requireUser } from "./session";

/**
 * Owner's Office access. Bound to a staff account ID through an OwnerAccess
 * row; a role ("Admin") or a typed email never grants it. Every page, action,
 * export and download re-checks the row in the database.
 */
export type OwnerCapability = "billing" | "full" | "grant";

export async function ownerAccessFor(userId: string): Promise<OwnerAccess | null> {
  return prisma.ownerAccess.findFirst({ where: { userId, revokedAt: null, user: { active: true } } });
}

function allows(access: OwnerAccess, need: OwnerCapability) {
  if (need === "grant") return access.isPrimary;
  if (need === "full") return access.scope === "FULL";
  return true;
}

/** Throws unless this staff member holds owner access with the capability. */
export async function assertOwner(actor: Actor, need: OwnerCapability = "full"): Promise<OwnerAccess> {
  const access = await ownerAccessFor(actor.id);
  if (!access || !allows(access, need)) throw new ForbiddenError("Not found.");
  return access;
}

/** Page gate: anyone without access gets a plain 404 — the section isn't advertised. */
export async function requireOwner(need: OwnerCapability = "full"): Promise<{ actor: Actor; access: OwnerAccess }> {
  const actor = await requireUser();
  const access = await ownerAccessFor(actor.id);
  if (!access || !allows(access, need)) notFound();
  return { actor, access };
}

/** For API routes: the signed-in owner (with capability) or null. */
export async function ownerFromSession(need: OwnerCapability = "full"): Promise<Actor | null> {
  const actor = await getCurrentUser();
  if (!actor) return null;
  const access = await ownerAccessFor(actor.id);
  return access && allows(access, need) ? actor : null;
}

/** What the sidebar may show this staff member. */
export const ownerNavState = cache(async (actor: Actor): Promise<"none" | "claim" | "billing" | "full"> => {
  const access = await ownerAccessFor(actor.id);
  if (access) return access.scope === "FULL" ? "full" : "billing";
  return (await canClaim(actor)) ? "claim" : "none";
});

async function canClaim(actor: Actor) {
  if (actor.role !== "ADMIN" || normalizeEmail(actor.email) !== OWNER_EMAIL) return false;
  return (await prisma.ownerAccess.count({ where: { isPrimary: true } })) === 0;
}

/**
 * One-time binding of the Owner's Office to the owner's own account: the
 * account must be the Admin whose sign-in is OWNER_EMAIL, fully signed in with
 * two-step verification, and confirm its password. After this, the email no
 * longer matters — access follows the account ID.
 */
export async function claimOwnerOffice(actor: Actor, password: string) {
  if (!(await canClaim(actor))) throw new ForbiddenError("Not found.");
  const user = await prisma.user.findUniqueOrThrow({ where: { id: actor.id } });
  if (!user.mfaEnabledAt || !user.passwordHash || !(await verifyPassword(password, user.passwordHash))) {
    throw new ForbiddenError("That password isn't right.");
  }
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('owner-office-claim'))`;
    if ((await tx.ownerAccess.count({ where: { isPrimary: true } })) > 0) throw new ForbiddenError("Not found.");
    const access = await tx.ownerAccess.create({ data: { userId: actor.id, isPrimary: true, scope: "FULL" } });
    await tx.ownerAuditLog.create({ data: { actorId: actor.id, action: "owner.claimed", entityType: "OwnerAccess", entityId: access.id } });
    return access;
  });
}

/** Only the primary owner can share access, and must confirm with their password. */
export async function grantOwnerAccess(actor: Actor, input: { userId: string; scope: "FULL" | "BILLING"; password: string }) {
  await assertOwner(actor, "grant");
  const me = await prisma.user.findUniqueOrThrow({ where: { id: actor.id } });
  if (!me.passwordHash || !(await verifyPassword(input.password, me.passwordHash))) throw new ForbiddenError("That password isn't right.");
  if (input.userId === actor.id) throw new ForbiddenError("You already have full access.");
  const target = await prisma.user.findUnique({ where: { id: input.userId } });
  if (!target || !target.active || !target.mfaEnabledAt) throw new ForbiddenError("Choose an active staff member who has set up two-step verification.");
  const access = await prisma.ownerAccess.upsert({
    where: { userId: target.id },
    create: { userId: target.id, scope: input.scope, grantedById: actor.id },
    update: { scope: input.scope, grantedById: actor.id, grantedAt: new Date(), revokedAt: null, isPrimary: false },
  });
  await prisma.ownerAuditLog.create({ data: { actorId: actor.id, action: "owner.granted", entityType: "OwnerAccess", entityId: access.id, details: { userId: target.id, scope: input.scope } } });
}

export async function revokeOwnerAccess(actor: Actor, userId: string) {
  await assertOwner(actor, "grant");
  if (userId === actor.id) throw new ForbiddenError("You can't remove your own access.");
  const res = await prisma.ownerAccess.updateMany({ where: { userId, isPrimary: false, revokedAt: null }, data: { revokedAt: new Date() } });
  if (res.count) await prisma.ownerAuditLog.create({ data: { actorId: actor.id, action: "owner.revoked", entityType: "OwnerAccess", details: { userId } } });
}

export function ownerAudit(actorId: string, action: string, entityType: string, entityId?: string | null, details?: Record<string, unknown>) {
  return prisma.ownerAuditLog.create({ data: { actorId, action, entityType, entityId: entityId ?? null, details: details as object | undefined } });
}
