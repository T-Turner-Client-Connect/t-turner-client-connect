import "server-only";
import { prisma } from "@/lib/prisma";
import { audit } from "@/lib/audit";
import { assertAdmin, type Actor } from "@/lib/auth/actor";
import { normalizeEmail, normalizePhone } from "@/lib/normalize";
import { createClient, ValidationError } from "./clients";
import { findClientMatches } from "./bookkeeping-clients";

/**
 * Owners with several businesses (e.g. one person who owns two companies):
 * the owner's main record — their Personal client record, or the Business
 * record they were first set up under (with their contact, login and billing
 * already on it) — linked to each other business's own client record. The
 * main record is never changed, retyped or copied when a business is added. Every business keeps its own EIN, accounts, billing,
 * documents, staff and Coetha link. A link never grants portal access by
 * itself — staff grant each business explicitly.
 */

export const REL_ROLES = { OWNER: "Owner", PARTNER: "Partner", OFFICER: "Officer", OTHER: "Other" } as const;

const pick = { id: true, displayName: true, businessName: true, clientType: true, archivedAt: true } as const;

/**
 * The owner's group, for the tabs on any record in it: the main record (their
 * Personal record, or the Business record they were set up under) and every
 * business linked to it. `person` is set only when the main record is Personal.
 */
export async function businessFamily(clientId: string) {
  const c = await prisma.client.findUnique({ where: { id: clientId }, select: pick });
  if (!c) return null;
  let anchor = c;
  let otherOwners: (typeof c)[] = [];
  if (c.clientType !== "INDIVIDUAL") {
    const owners = (await prisma.clientRelationship.findMany({ where: { businessClientId: clientId }, include: { person: { select: pick } }, orderBy: { createdAt: "asc" } })).map((r) => r.person).filter((p) => !p.archivedAt);
    if (owners.length) [anchor, ...otherOwners] = owners;
  }
  const linked = (await prisma.clientRelationship.findMany({ where: { personClientId: anchor.id }, include: { business: { select: pick } }, orderBy: { createdAt: "asc" } }))
    .map((r) => ({ ...r.business, role: r.role }))
    .filter((b) => !b.archivedAt);
  const person = anchor.clientType === "INDIVIDUAL" ? anchor : null;
  // A Business main record is itself one of the owner's businesses (first tab).
  const businesses = person ? linked : [{ ...anchor, role: "OWNER" }, ...linked];
  return { current: c, anchor, person, otherOwners, businesses, ownerName: person?.displayName ?? (await ownerOfRecord(anchor.id)) };
}

/** The owner's name already on a Business main record: its first contact, else the name fields on the record. Never asked for again. */
async function ownerOfRecord(clientId: string) {
  const r = await prisma.client.findUnique({ where: { id: clientId }, select: { firstName: true, lastName: true, contacts: { select: { name: true }, orderBy: { createdAt: "asc" }, take: 1 } } });
  return r?.contacts[0]?.name?.trim() || [r?.firstName, r?.lastName].filter(Boolean).join(" ").trim() || null;
}

/** Heading for a record: a business shows its business name, with "Owner: …" when it's part of an owner's group. */
export async function recordHeading(clientId: string) {
  const fam = await businessFamily(clientId);
  if (!fam) return null;
  const c = fam.current;
  const title = c.clientType === "INDIVIDUAL" ? c.displayName : c.businessName || c.displayName;
  const grouped = !!fam.person || fam.businesses.length > 1;
  return { title, owner: c.clientType !== "INDIVIDUAL" && grouped ? fam.ownerName : null };
}

/** The record more businesses are added from: a Personal record, or a Business record that isn't itself linked under another owner. */
async function assertMainRecord(anchorId: string) {
  const a = await prisma.client.findUnique({ where: { id: anchorId }, include: { ownedBy: { include: { person: { select: { displayName: true } } }, take: 1 } } });
  if (!a || a.archivedAt) throw new ValidationError("Client not found.");
  if (a.clientType !== "INDIVIDUAL" && a.ownedBy.length) throw new ValidationError(`Add businesses from ${a.ownedBy[0].person.displayName}'s main record, so they stay in one group.`);
  return a;
}

async function assertPair(personClientId: string, businessClientId: string) {
  if (personClientId === businessClientId) throw new ValidationError("Choose a different business.");
  const p = await assertMainRecord(personClientId);
  const b = await prisma.client.findUnique({ where: { id: businessClientId }, include: { _count: { select: { ownsBusinesses: true } }, ownedBy: { include: { person: { select: { displayName: true, clientType: true } } } } } });
  if (!b || b.archivedAt || b.clientType === "INDIVIDUAL") throw new ValidationError("Choose a business or nonprofit record to link.");
  if (b._count.ownsBusinesses) throw new ValidationError(`${b.displayName} is the main record of its own group. Add businesses from one main record instead.`);
  if (p.clientType !== "INDIVIDUAL" && b.ownedBy.some((o) => o.personClientId !== personClientId)) throw new ValidationError(`${b.displayName} is already linked to ${b.ownedBy[0].person.displayName}.`);
  return { p, b };
}

/** Links an existing business to the owner's Personal record. Nothing is merged or copied. */
export async function linkBusiness(actor: Actor, personClientId: string, businessClientId: string, role = "OWNER") {
  if (!(role in REL_ROLES)) throw new ValidationError("Choose the person's role.");
  const { b } = await assertPair(personClientId, businessClientId);
  const existing = await prisma.clientRelationship.findUnique({ where: { personClientId_businessClientId: { personClientId, businessClientId } } });
  if (existing) throw new ValidationError(`${b.displayName} is already linked.`);
  const rel = await prisma.clientRelationship.create({ data: { personClientId, businessClientId, role, createdById: actor.id } });
  await audit(prisma, { actorId: actor.id, action: "client.business_linked", entityType: "Client", entityId: personClientId, clientId: personClientId, details: { businessClientId, role } });
  return rel;
}

/** Creates a new business record (after a duplicate check) and links it to the owner. */
export async function createAndLinkBusiness(actor: Actor, personClientId: string, input: { businessName: string; clientType: "BUSINESS" | "NONPROFIT"; email?: string; phone?: string; role?: string }) {
  await assertMainRecord(personClientId);
  if (!input.businessName.trim()) throw new ValidationError("Enter the business name.");
  const matches = (await findClientMatches({ businessName: input.businessName, email: input.email, phone: input.phone })).filter((m) => m.id !== personClientId);
  if (matches.length) throw new ValidationError(`Already in the CRM: ${matches.map((m) => m.displayName).join(", ")}. Use “Link an existing business” instead of creating a duplicate.`);
  const business = await createClient(actor, { businessName: input.businessName, clientType: input.clientType, status: "ACTIVE", email: input.email, phone: input.phone });
  await linkBusiness(actor, personClientId, business.id, input.role ?? "OWNER");
  return business;
}

export async function unlinkBusiness(actor: Actor, personClientId: string, businessClientId: string) {
  assertAdmin(actor);
  await prisma.clientRelationship.delete({ where: { personClientId_businessClientId: { personClientId, businessClientId } } });
  await audit(prisma, { actorId: actor.id, action: "client.business_unlinked", entityType: "Client", entityId: personClientId, clientId: personClientId, details: { businessClientId } });
}

/**
 * Gives the owner's existing portal login access to one linked business —
 * an explicit staff action per business (owning one never opens another).
 */
export async function grantOwnerPortalAccess(actor: Actor, personClientId: string, businessClientId: string, portalUserId: string) {
  await assertPair(personClientId, businessClientId);
  if (!(await prisma.clientRelationship.count({ where: { personClientId, businessClientId } }))) throw new ValidationError("Link the business to this person first.");
  const own = await prisma.portalAccess.findFirst({ where: { clientId: personClientId, portalUserId, revokedAt: null } });
  if (!own) throw new ValidationError("That login isn't this person's portal login.");
  await prisma.portalAccess.upsert({
    where: { portalUserId_clientId: { portalUserId, clientId: businessClientId } },
    update: { revokedAt: null, role: "OWNER", grantedById: actor.id },
    create: { portalUserId, clientId: businessClientId, role: "OWNER", canMessage: true, canUpload: true, canViewBookkeeping: true, canViewTax: true, canViewContracts: true, canViewIdentity: false, grantedById: actor.id },
  });
  await audit(prisma, { actorId: actor.id, action: "portal.access_granted", entityType: "PortalUser", entityId: portalUserId, clientId: businessClientId, details: { via: "linked_owner", personClientId } });
}

/**
 * Possible person ↔ business links for an Admin to confirm: a business whose
 * email or phone (or a contact's) matches an individual client's. Nothing is
 * linked, merged or deleted automatically.
 */
export async function proposedLinks() {
  const [people, businesses, linked] = await Promise.all([
    prisma.client.findMany({ where: { archivedAt: null, clientType: "INDIVIDUAL" }, select: { id: true, displayName: true, emailNormalized: true, phoneNormalized: true } }),
    prisma.client.findMany({ where: { archivedAt: null, clientType: { not: "INDIVIDUAL" } }, select: { id: true, displayName: true, emailNormalized: true, phoneNormalized: true, contacts: { select: { emailNormalized: true, phoneNormalized: true, name: true } } } }),
    prisma.clientRelationship.findMany({ select: { personClientId: true, businessClientId: true } }),
  ]);
  const done = new Set(linked.map((l) => `${l.personClientId}:${l.businessClientId}`));
  const out: { person: { id: string; displayName: string }; business: { id: string; displayName: string }; reason: string }[] = [];
  for (const b of businesses) {
    const emails = new Set([b.emailNormalized, ...b.contacts.map((c) => c.emailNormalized)].filter(Boolean));
    const phones = new Set([b.phoneNormalized, ...b.contacts.map((c) => c.phoneNormalized)].filter(Boolean));
    const names = new Set(b.contacts.map((c) => c.name.trim().toLowerCase()));
    for (const p of people) {
      if (done.has(`${p.id}:${b.id}`)) continue;
      const reason = p.emailNormalized && emails.has(p.emailNormalized) ? "same email" : p.phoneNormalized && phones.has(p.phoneNormalized) ? "same phone" : names.has(p.displayName.trim().toLowerCase()) ? "contact has the same name" : null;
      if (reason) out.push({ person: { id: p.id, displayName: p.displayName }, business: { id: b.id, displayName: b.displayName }, reason });
    }
  }
  return out;
}

/** Individuals that may be the same person (same email or phone) — listed for review only, never merged. */
export async function possibleDuplicatePeople() {
  const people = await prisma.client.findMany({ where: { archivedAt: null, clientType: "INDIVIDUAL" }, select: { id: true, displayName: true, emailNormalized: true, phoneNormalized: true } });
  const groups = new Map<string, { id: string; displayName: string }[]>();
  for (const p of people) {
    for (const key of [p.emailNormalized && `e:${normalizeEmail(p.emailNormalized)}`, p.phoneNormalized && `p:${normalizePhone(p.phoneNormalized)}`].filter(Boolean) as string[]) {
      groups.set(key, [...(groups.get(key) ?? []), { id: p.id, displayName: p.displayName }]);
    }
  }
  return [...groups.entries()].filter(([, v]) => v.length > 1).map(([k, v]) => ({ reason: k.startsWith("e:") ? "same email" : "same phone", clients: v }));
}

/** Admin confirms a proposed link. */
export async function confirmProposedLink(actor: Actor, personClientId: string, businessClientId: string) {
  assertAdmin(actor);
  return linkBusiness(actor, personClientId, businessClientId, "OWNER");
}

/** For lists: the owner's name over the business name (an individual shows just their name). */
export async function ownerAndBusiness(clientId: string) {
  const fam = await businessFamily(clientId);
  if (!fam) return null;
  const c = fam.current;
  if (c.clientType === "INDIVIDUAL") return { owner: c.displayName, business: null, order: 0 };
  // order: the owner's main record first, then businesses in the order they were added.
  return { owner: fam.ownerName, business: c.businessName || c.displayName, order: Math.max(0, fam.businesses.findIndex((b) => b.id === c.id)) };
}
