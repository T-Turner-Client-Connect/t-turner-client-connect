import "server-only";
import { cache } from "react";
import { notFound } from "next/navigation";
import type { OwnerAccess } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { OWNER_EMAIL } from "@/lib/business";
import { normalizeEmail } from "@/lib/normalize";
import type { Area, PermAction } from "@/lib/permissions";
import { verifyPassword } from "./password";
import { ForbiddenError, type Actor } from "./actor";
import { getCurrentUser, requireUser } from "./session";
import { assertCan, can, officeAccessFor, type OfficeAccess } from "./permissions";

/**
 * Owner's Office access. The owner is bound to her staff account ID through the primary
 * OwnerAccess row; a role ("Admin") or a typed email never grants it. Everyone else holds only
 * the Staff Access & Permissions grants the owner gave them (src/lib/auth/permissions.ts). Every
 * page, action, export and download re-checks the database — nothing is cached in the session.
 */

/** The owner's own binding (primary, not revoked, active account), or null. */
export async function primaryOwnerAccess(userId: string): Promise<OwnerAccess | null> {
  return prisma.ownerAccess.findFirst({ where: { userId, isPrimary: true, revokedAt: null, user: { active: true } } });
}

/** Throws unless this is the owner herself. For the few things only she does. */
export async function assertOwner(actor: Actor): Promise<OwnerAccess> {
  const access = await primaryOwnerAccess(actor.id);
  if (!access) throw new ForbiddenError("Not found.");
  return access;
}

/** Throws unless this staff member holds the permission (the owner holds them all). */
export async function assertOffice(actor: Pick<Actor, "id">, area: Area, action: PermAction = "view"): Promise<void> {
  await assertCan(actor, area, action);
}

/** Per-request read of the signed-in account's grants (the layout and the page share one lookup). */
export const myOfficeAccess = cache((userId: string) => officeAccessFor(userId));

/**
 * Page gate: anyone without the permission gets a plain 404 — the section isn't advertised.
 * With no area, any Owner's Office permission opens the door (the layout).
 */
export async function requireOffice(area?: Area, action: PermAction = "view"): Promise<{ actor: Actor; access: OfficeAccess }> {
  const actor = await requireUser();
  const access = await myOfficeAccess(actor.id);
  if (area ? !access.can(area, action) : officeTabs(access).length === 0) notFound();
  return { actor, access };
}

/** For API routes: the signed-in staff member holding the permission, or null. */
export async function officeFromSession(area: Area, action: PermAction = "view"): Promise<Actor | null> {
  const actor = await getCurrentUser();
  if (!actor) return null;
  return (await can(actor, area, action)) ? actor : null;
}

export const billingSettingsVisible = (a: OfficeAccess) => a.can("billing", "settings") || a.can("square", "integrations");
export const staffAccessVisible = (a: OfficeAccess) => a.isOwner || a.can("staff", "view") || a.can("staff", "manage");
export const settingsVisible = (a: OfficeAccess) => billingSettingsVisible(a) || staffAccessVisible(a);

export type OfficeHref = `/owner${string}`;

/** The Owner's Office tabs this staff member may open, in order. */
export function officeTabs(access: OfficeAccess): { href: OfficeHref; label: string }[] {
  const c = access.can;
  const tabs: { href: OfficeHref; label: string; show: boolean }[] = [
    { href: "/owner", label: "Overview", show: c("revenue", "view") },
    { href: "/owner/appointments", label: "Appointments", show: c("appointments", "view") },
    { href: "/owner/invoices", label: "Quotes & invoices", show: c("billing", "view") },
    { href: "/owner/billing", label: "Billing dashboard", show: c("billing", "view") },
    { href: "/owner/reconcile", label: "Reconcile Square", show: c("receivables", "reconcile") },
    { href: "/owner/plans", label: "Payment plans", show: c("billing", "view") },
    { href: "/owner/refund-payments", label: "Pay by Refund", show: c("billing", "view") },
    { href: "/owner/payroll-approvers", label: "Payroll approvers", show: c("payroll", "edit") },
    { href: "/owner/expenses", label: "Expenses", show: c("revenue", "view") },
    { href: "/owner/business-access", label: "Business access", show: c("business_access", "view") },
    // Coetha & bank feeds: Tabitha's own on/off switches (owner only, not grantable).
    // Coetha Accounting Review: internal findings, requests and approvals across bookkeeping clients.
    { href: "/owner/coetha-review", label: "Coetha Accounting Review", show: access.isOwner || c("coetha", "view") },
    { href: "/owner/automation", label: "Coetha & bank feeds", show: access.isOwner },
    // Quarterly access reviews and staff offboarding: Tabitha's alone (not grantable).
    { href: "/owner/access-review", label: "Access review", show: access.isOwner },
    // Client Letters: Tabitha prepares, reviews and sends approved letters (owner only, not grantable).
    { href: "/owner/client-letters", label: "Client Letters", show: access.isOwner },
    { href: billingSettingsVisible(access) ? "/owner/settings" : "/owner/settings/staff-access", label: "Settings", show: settingsVisible(access) },
  ];
  return tabs.filter((t) => t.show).map(({ href, label }) => ({ href, label }));
}

/** What the sidebar may show this staff member: nothing, the claim page, or their first tab. */
export const ownerNavState = cache(async (actor: Actor): Promise<"none" | "claim" | OfficeHref> => {
  const first = officeTabs(await officeAccessFor(actor.id))[0];
  if (first) return first.href;
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
    // A staff member's grants never sit on the owner's row: hers is full by definition.
    await tx.staffPermission.deleteMany({ where: { userId: actor.id } });
    const access = await tx.ownerAccess.upsert({
      where: { userId: actor.id },
      create: { userId: actor.id, isPrimary: true, scope: "FULL" },
      update: { isPrimary: true, scope: "FULL", revokedAt: null },
    });
    await tx.ownerAuditLog.create({ data: { actorId: actor.id, action: "owner.claimed", entityType: "OwnerAccess", entityId: access.id } });
    return access;
  });
}

// Sharing access happens in Owner's Office → Settings → Staff Access & Permissions
// (src/lib/auth/permissions.ts). The old "Full / Billing only" grants were migrated to permission
// grants; nobody can create a second owner.

export function ownerAudit(actorId: string, action: string, entityType: string, entityId?: string | null, details?: Record<string, unknown>) {
  return prisma.ownerAuditLog.create({ data: { actorId, action, entityType, entityId: entityId ?? null, details: details as object | undefined } });
}
