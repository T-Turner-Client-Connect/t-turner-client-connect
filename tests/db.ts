import { prisma } from "@/lib/prisma";
import type { Actor } from "@/lib/auth/actor";

export async function resetDb() {
  const tables = await prisma.$queryRaw<{ tablename: string }[]>`
    SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename NOT IN ('_prisma_migrations', '_local_migrations')`;
  await prisma.$executeRawUnsafe(`TRUNCATE ${tables.map((t) => `"${t.tablename}"`).join(", ")} CASCADE`);
}

let n = 0;
export async function makeUser(role: "ADMIN" | "STAFF", name = role === "ADMIN" ? "Tabitha" : "Daria"): Promise<Actor> {
  n++;
  const u = await prisma.user.create({ data: { email: `${name.toLowerCase()}${n}@example.com`, name, role, passwordHash: "x" } });
  return { id: u.id, role: u.role, name: u.name, email: u.email };
}

export { prisma };

/**
 * Test fixture: the client authorized the Coetha AI notice (current version) in the portal.
 * The notice, its versions and the refusals are tested in coetha-consent.test.ts.
 */
export async function authorizeCoetha(...clientIds: string[]) {
  const { COETHA_CONSENT_VERSION } = await import("@/lib/services/coetha-consent");
  await prisma.coethaConsent.createMany({ data: clientIds.map((clientId) => ({ clientId, status: "AUTHORIZED", version: COETHA_CONSENT_VERSION, method: "PORTAL", decidedByName: "Fixture owner" })) });
}

/**
 * Test fixture: these fictional businesses are ones the firm manages, as if Tabitha had
 * approved Managed Business access and turned on the business view for their logins.
 * Call it after the logins exist. (Real approval is tested in business-access.test.ts.)
 */
export async function managed(...clientIds: string[]) {
  await prisma.client.updateMany({ where: { id: { in: clientIds } }, data: { businessAccess: "ACTIVE" } });
  await prisma.portalAccess.updateMany({ where: { clientId: { in: clientIds } }, data: { canViewBookkeeping: true } });
}

/**
 * Test fixture: Staff Access & Permissions grants written directly (as if Tabitha had saved them
 * on the screen). Granting through the screen itself is tested in staff-permissions.test.ts.
 */
export async function grantPerms(userId: string, keys: string[]) {
  await prisma.staffPermission.createMany({ data: keys.map((k) => ({ userId, area: k.split(".")[0], action: k.split(".")[1] })), skipDuplicates: true });
}

/** What "Billing only" Owner's Office access became (see the 20261106205000 migration). */
export const OLD_BILLING_ONLY = ["billing.view", "billing.create", "billing.edit", "billing.record_payment", "receivables.reconcile"];
