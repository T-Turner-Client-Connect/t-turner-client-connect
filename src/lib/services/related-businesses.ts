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

/**
 * A business already linked under a different owner is someone else's record:
 * it can't be linked here by picking it from a list. A genuine co-owner link
 * needs an Admin and a recorded reason.
 */
async function assertPair(personClientId: string, businessClientId: string, opts: { actor?: Actor; coOwnerReason?: string } = {}) {
  if (personClientId === businessClientId) throw new ValidationError("Choose a different business.");
  const p = await assertMainRecord(personClientId);
  const b = await prisma.client.findUnique({ where: { id: businessClientId }, include: { _count: { select: { ownsBusinesses: true } }, ownedBy: { include: { person: { select: { displayName: true, clientType: true } } } } } });
  if (!b || b.archivedAt || b.clientType === "INDIVIDUAL") throw new ValidationError("Choose a business or nonprofit record to link.");
  if (b._count.ownsBusinesses) throw new ValidationError(`${b.displayName} is the main record of its own group. Add businesses from one main record instead.`);
  const otherOwners = b.ownedBy.filter((o) => o.personClientId !== personClientId);
  if (otherOwners.length) {
    const reason = opts.coOwnerReason?.trim() ?? "";
    if (!opts.actor || opts.actor.role !== "ADMIN" || reason.length < 10) {
      throw new ValidationError(`${b.displayName} already belongs to ${otherOwners[0].person.displayName}'s records. It can't be linked to another client. If both people truly co-own it, an Admin must confirm co-ownership with a reason.`);
    }
  }
  return { p, b, otherOwners };
}

/** Links an existing business to the owner's Personal record. Nothing is merged or copied. */
export async function linkBusiness(actor: Actor, personClientId: string, businessClientId: string, role = "OWNER", opts: { coOwnerReason?: string } = {}) {
  if (!(role in REL_ROLES)) throw new ValidationError("Choose the person's role.");
  const { b, otherOwners } = await assertPair(personClientId, businessClientId, { actor, coOwnerReason: opts.coOwnerReason });
  const existing = await prisma.clientRelationship.findUnique({ where: { personClientId_businessClientId: { personClientId, businessClientId } } });
  if (existing) throw new ValidationError(`${b.displayName} is already linked.`);
  const rel = await prisma.clientRelationship.create({ data: { personClientId, businessClientId, role, createdById: actor.id } });
  await audit(prisma, { actorId: actor.id, action: "client.business_linked", entityType: "Client", entityId: personClientId, clientId: personClientId, details: { businessClientId, role, ...(otherOwners.length ? { coOwnerOf: otherOwners.map((o) => o.personClientId), coOwnerReason: opts.coOwnerReason?.trim().slice(0, 300) } : {}) } });
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

/**
 * What else connects a person's records to a business, shown before a link is
 * removed. Nothing here is changed by removing the link — each item is for
 * separate review: portal logins of this person that can open the business,
 * and a Square bill that includes the business together with this person's records.
 */
export async function linkImpact(personClientId: string, businessClientId: string) {
  const rel = await prisma.clientRelationship.findUnique({ where: { personClientId_businessClientId: { personClientId, businessClientId } } });
  if (!rel) return null;
  const owners = await prisma.clientRelationship.findMany({ where: { businessClientId }, orderBy: { createdAt: "asc" }, select: { id: true, personClientId: true } });
  const personLogins = await prisma.portalAccess.findMany({ where: { clientId: personClientId, revokedAt: null }, select: { portalUserId: true } });
  const sharedAccess = personLogins.length
    ? await prisma.portalAccess.findMany({ where: { clientId: businessClientId, revokedAt: null, portalUserId: { in: personLogins.map((l) => l.portalUserId) } }, include: { portalUser: { select: { email: true } } } })
    : [];
  const member = await prisma.squareBillingMember.findUnique({ where: { clientId: businessClientId }, include: { arrangement: { include: { members: { select: { clientId: true } } } } } });
  const personGroup = new Set([personClientId, ...(await prisma.clientRelationship.findMany({ where: { personClientId }, select: { businessClientId: true } })).map((r) => r.businessClientId)]);
  const sharedBill = !!member && member.arrangement.members.some((m) => m.clientId !== businessClientId && personGroup.has(m.clientId));
  // The original (first) owner link, or the only one, is the organization's own ownership record.
  const isPrimary = owners[0]?.id === rel.id;
  const flags = [
    ...(sharedAccess.length ? [`${sharedAccess.length} of this client's portal logins can open this organization — review its Portal tab (not changed here).`] : []),
    ...(sharedBill ? ["This organization is on a Square bill with this client's records — review billing (not changed here)."] : []),
  ];
  return { isPrimary, onlyOwner: owners.length === 1, otherOwners: owners.length - 1, flags };
}

/**
 * Admin-only correction of a wrong link, with a recorded reason. The link's
 * details (who created it, when, role) and anything else connecting the two
 * records are saved in the audit log first, so the evidence is preserved.
 * Removing a link never deletes either client's records, documents, filings or
 * billing; portal access and Square bills are flagged for separate review, not
 * changed. The organization's original or only owner link also needs its name
 * typed, so its legitimate ownership can't be removed by accident.
 */
export async function unlinkBusiness(actor: Actor, personClientId: string, businessClientId: string, reason = "", opts: { confirmName?: string } = {}) {
  assertAdmin(actor);
  if (reason.trim().length < 10) throw new ValidationError("Record why this link is wrong (what you checked) before removing it.");
  const rel = await prisma.clientRelationship.findUnique({ where: { personClientId_businessClientId: { personClientId, businessClientId } }, include: { business: { select: { displayName: true } } } });
  if (!rel) throw new ValidationError("That link doesn't exist.");
  const impact = (await linkImpact(personClientId, businessClientId))!;
  if (impact.isPrimary || impact.onlyOwner) {
    const typed = (opts.confirmName ?? "").trim().toLowerCase();
    if (typed !== rel.business.displayName.trim().toLowerCase()) {
      throw new ValidationError(`This is ${rel.business.displayName}'s ${impact.onlyOwner ? "only" : "original"} owner link. To remove it anyway, type the organization's name exactly.`);
    }
  }
  await audit(prisma, {
    actorId: actor.id,
    action: "client.business_unlinked",
    entityType: "Client",
    entityId: personClientId,
    clientId: personClientId,
    details: { businessClientId, reason: reason.trim().slice(0, 500), removedLink: { id: rel.id, role: rel.role, createdAt: rel.createdAt.toISOString(), createdById: rel.createdById }, wasPrimary: impact.isPrimary, flaggedForReview: impact.flags },
  });
  // The organization's own record also notes it, so its history shows the removal.
  await audit(prisma, { actorId: actor.id, action: "client.owner_link_removed", entityType: "Client", entityId: businessClientId, clientId: businessClientId, details: { personClientId, reason: reason.trim().slice(0, 500) } });
  await prisma.clientRelationship.delete({ where: { id: rel.id } });
  return impact;
}

/**
 * Gives the owner's existing portal login access to one linked business —
 * an explicit staff action per business (owning one never opens another).
 */
export async function grantOwnerPortalAccess(actor: Actor, personClientId: string, businessClientId: string, portalUserId: string) {
  if (!(await prisma.clientRelationship.count({ where: { personClientId, businessClientId } }))) throw new ValidationError("Link the business to this person first.");
  // Opening another owner's business to this login is never a one-click staff action.
  const others = await prisma.clientRelationship.count({ where: { businessClientId, personClientId: { not: personClientId } } });
  if (others && actor.role !== "ADMIN") throw new ValidationError("This business is also linked to another owner's records. Only an Admin can give this login access to it.");
  await assertMainRecord(personClientId);
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
    // A business already linked to an owner is never suggested for anyone else.
    prisma.client.findMany({ where: { archivedAt: null, clientType: { not: "INDIVIDUAL" }, ownedBy: { none: {} }, ownsBusinesses: { none: {} } }, select: { id: true, displayName: true, emailNormalized: true, phoneNormalized: true, contacts: { select: { emailNormalized: true, phoneNormalized: true, name: true } } } }),
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

/**
 * Businesses that may be offered in "Link an existing business": not in any
 * owner's group yet (not linked under an owner, not a group's main record).
 */
export async function linkableBusinesses(anchorId: string) {
  return prisma.client.findMany({
    where: { archivedAt: null, clientType: { not: "INDIVIDUAL" }, id: { not: anchorId }, ownedBy: { none: {} }, ownsBusinesses: { none: {} } },
    select: { id: true, displayName: true },
    orderBy: { displayName: "asc" },
    take: 300,
  });
}

/**
 * Admin review of every owner ↔ business link (read-only): who created it and
 * when, how, and flags that need a look — a business linked to more than one
 * owner, no shared email/phone/contact between the two records, and portal
 * access granted through the link (with whether that login opened any of the
 * business's documents). Nothing is changed.
 */
export async function relationshipReview(actor: Actor) {
  assertAdmin(actor);
  const rels = await prisma.clientRelationship.findMany({
    include: {
      person: { select: { id: true, displayName: true, emailNormalized: true, phoneNormalized: true, contacts: { select: { name: true, emailNormalized: true, phoneNormalized: true } } } },
      business: { select: { id: true, displayName: true, clientType: true, emailNormalized: true, phoneNormalized: true, contacts: { select: { name: true, emailNormalized: true, phoneNormalized: true } }, ownedBy: { select: { personClientId: true } } } },
    },
    orderBy: { createdAt: "desc" },
  });
  const users = new Map((await prisma.user.findMany({ select: { id: true, name: true } })).map((u) => [u.id, u.name]));
  const out = [];
  for (const r of rels) {
    const keys = (c: { displayName?: string; emailNormalized: string | null; phoneNormalized: string | null; contacts: { name: string; emailNormalized: string | null; phoneNormalized: string | null }[] }) =>
      new Set([c.emailNormalized, c.phoneNormalized, ...c.contacts.flatMap((x) => [x.emailNormalized, x.phoneNormalized, x.name.trim().toLowerCase()])].filter(Boolean) as string[]);
    const pk = keys(r.person);
    pk.add(r.person.displayName.trim().toLowerCase());
    const shared = [...keys(r.business)].some((k) => pk.has(k));
    const logs = await prisma.auditLog.findMany({ where: { action: "client.business_linked", entityId: r.personClientId }, orderBy: { createdAt: "asc" }, select: { createdAt: true, actorId: true, details: true } });
    const how = logs.find((l) => (l.details as { businessClientId?: string } | null)?.businessClientId === r.businessClientId);
    const grants = await prisma.auditLog.findMany({ where: { action: "portal.access_granted", clientId: r.businessClientId }, select: { entityId: true, createdAt: true, actorId: true, details: true } });
    const viaLink = grants.filter((g) => (g.details as { personClientId?: string } | null)?.personClientId === r.personClientId);
    const opened = viaLink.length
      ? await prisma.documentAccessLog.count({ where: { portalUserId: { in: viaLink.map((g) => g.entityId!).filter(Boolean) }, document: { clientId: r.businessClientId }, action: { in: ["VIEW", "DOWNLOAD"] } } })
      : 0;
    const flags = [
      ...(r.business.ownedBy.length > 1 ? ["Business linked to more than one owner"] : []),
      ...(!shared ? ["No shared email, phone or contact name between the two records"] : []),
      ...(viaLink.length ? [`Portal access granted through this link (${viaLink.length})`] : []),
      ...(opened ? [`That login opened ${opened} of the business's documents`] : []),
    ];
    out.push({
      id: r.id,
      person: { id: r.person.id, name: r.person.displayName },
      business: { id: r.business.id, name: r.business.displayName, type: r.business.clientType },
      role: r.role,
      createdAt: r.createdAt,
      createdBy: r.createdById ? users.get(r.createdById) ?? "Unknown" : "Unknown",
      loggedAt: how?.createdAt ?? null,
      flags,
    });
  }
  return out;
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
