import "server-only";
import { prisma } from "@/lib/prisma";

type GreetClient = { clientType: string; preferredName: string | null; firstName: string | null; businessName: string | null; displayName: string };

/**
 * The name in "Welcome back, …". Individuals: their preferred name, else
 * first name. Businesses: the authorized contact's preferred name, else the
 * business name. Null when there's no name — the page then says "Welcome back".
 */
export function greetingName(client: GreetClient, contact?: { preferredName: string | null } | null): string | null {
  const clean = (v: string | null | undefined) => v?.trim() || null;
  if (client.clientType === "INDIVIDUAL") return clean(client.preferredName) ?? clean(client.firstName);
  return clean(contact?.preferredName) ?? clean(client.businessName) ?? clean(client.displayName);
}

/**
 * Greeting for one client account. The authorized contact is the signed-in
 * login's own contact record; in staff preview (no login), the contact linked
 * to the account's earliest active owner-level portal login.
 */
export async function loadGreetingName(clientId: string, portalUserId: string | null) {
  const client = await prisma.client.findUnique({ where: { id: clientId }, select: { clientType: true, preferredName: true, firstName: true, businessName: true, displayName: true } });
  if (!client) return null;
  if (client.clientType === "INDIVIDUAL") return greetingName(client);
  const own = portalUserId ? await prisma.portalUser.findUnique({ where: { id: portalUserId }, select: { contact: { select: { clientId: true, preferredName: true } } } }) : null;
  let contact = own?.contact?.clientId === clientId ? own.contact : null;
  if (!contact && !portalUserId) {
    const owner = await prisma.portalAccess.findFirst({
      where: { clientId, revokedAt: null, role: "OWNER", portalUser: { active: true, contact: { clientId } } },
      orderBy: { createdAt: "asc" },
      select: { portalUser: { select: { contact: { select: { clientId: true, preferredName: true } } } } },
    });
    contact = owner?.portalUser.contact ?? null;
  }
  if (!contact?.preferredName && portalUserId && client.firstName?.trim() && (await prisma.clientRelationship.count({ where: { personClientId: clientId } }))) {
    // The owner's main record is this Business record: greet them by the first name on it.
    return client.firstName.trim();
  }
  if (!contact?.preferredName && portalUserId) {
    // An owner of several businesses: greet them by their own name, from the Personal record
    // this same login can open and that's linked to this business.
    const owner = await prisma.clientRelationship.findFirst({
      where: { businessClientId: clientId, person: { archivedAt: null, portalAccess: { some: { portalUserId, revokedAt: null } } } },
      select: { person: { select: { preferredName: true, firstName: true } } },
    });
    const name = owner?.person.preferredName?.trim() || owner?.person.firstName?.trim();
    if (name) return name;
  }
  return greetingName(client, contact);
}
