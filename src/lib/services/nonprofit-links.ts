import "server-only";
import { prisma } from "@/lib/prisma";
import { audit } from "@/lib/audit";
import type { Actor } from "@/lib/auth/actor";
import { ValidationError } from "./clients";
import { businessFamily, createAndLinkBusiness, linkBusiness } from "./related-businesses";
import { FILING_SERVICE, type FilingService } from "./nonprofits";

/**
 * Nonprofits from any client record, bookkeeping or not. A nonprofit is its own
 * organization record (client type Nonprofit) linked to the owner's main record,
 * like any other business they own — the owner's business (e.g. an LLC) is never
 * retyped as the nonprofit. Linking never grants portal access; staff give the
 * owner's login access to the organization explicitly, as for any linked business.
 * "Nonprofit Interest" (formation inquiries) is a separate group and never puts an
 * organization on Nonprofit Filings; only "TTurner handles its filings: Yes" does.
 */
export const HAS_NONPROFIT = { YES: "Yes", NO: "No", NOT_CONFIRMED: "Not confirmed" } as const;
export type HasNonprofit = keyof typeof HAS_NONPROFIT;

const orgPick = { id: true, displayName: true, businessName: true, status: true, fiscalYearEnd: true, assignedTo: { select: { name: true } }, nonprofitProfile: { select: { filingService: true, formType: true } } } as const;

/** The owner's main record — where "Has a nonprofit?" is kept and organizations are linked. */
async function ownerRecord(clientId: string) {
  const fam = await businessFamily(clientId);
  if (!fam) throw new ValidationError("Client not found.");
  return fam;
}

/** What the client record's Nonprofit card shows, from any record in the owner's group. */
export async function nonprofitsForClient(clientId: string) {
  const fam = await ownerRecord(clientId);
  const anchor = await prisma.client.findUniqueOrThrow({ where: { id: fam.anchor.id }, select: { id: true, displayName: true, clientType: true, hasNonprofit: true } });
  const orgIds = fam.businesses.filter((b) => b.clientType === "NONPROFIT").map((b) => b.id);
  // A nonprofit record that isn't in an owner's group still shows itself.
  if (fam.current.clientType === "NONPROFIT" && !orgIds.includes(fam.current.id)) orgIds.push(fam.current.id);
  const orgs = await prisma.client.findMany({ where: { id: { in: orgIds } }, select: orgPick, orderBy: { displayName: "asc" } });
  const has = (anchor.hasNonprofit ?? null) as HasNonprofit | null;
  const flags: string[] = [];
  if (has === "YES" && orgs.length === 0) flags.push("Has a nonprofit, but its organization record isn't linked yet");
  if (has !== "YES" && orgs.length > 0) flags.push(`A nonprofit is linked but “Has a nonprofit?” says ${has ? HAS_NONPROFIT[has] : "not recorded"}`);
  for (const o of orgs) if (!o.nonprofitProfile?.filingService) flags.push(`${o.businessName || o.displayName}: whether TTurner handles its annual filings isn't recorded`);
  return { anchor, has, orgs, flags, ownerIsNonprofit: anchor.clientType === "NONPROFIT" };
}

export async function setHasNonprofit(actor: Actor, clientId: string, value: string) {
  if (!(value in HAS_NONPROFIT)) throw new ValidationError("Choose Yes, No or Not confirmed.");
  const fam = await ownerRecord(clientId);
  const before = await prisma.client.findUniqueOrThrow({ where: { id: fam.anchor.id }, select: { hasNonprofit: true } });
  await prisma.client.update({ where: { id: fam.anchor.id }, data: { hasNonprofit: value } });
  await audit(prisma, { actorId: actor.id, action: "client.has_nonprofit_set", entityType: "Client", entityId: fam.anchor.id, clientId: fam.anchor.id, details: { before: before.hasNonprofit, after: value } });
}

/** Creates the nonprofit's own organization record (after the duplicate check) and links it to the owner's main record. */
export async function createAndLinkNonprofit(actor: Actor, clientId: string, input: { name: string; email?: string; phone?: string; role?: string }) {
  const fam = await ownerRecord(clientId);
  if (fam.anchor.clientType === "NONPROFIT") throw new ValidationError("This record is itself a nonprofit. Add the nonprofit from its owner's record.");
  const org = await createAndLinkBusiness(actor, fam.anchor.id, { businessName: input.name, clientType: "NONPROFIT", email: input.email, phone: input.phone, role: input.role });
  await markHasNonprofit(actor, fam.anchor.id);
  return org;
}

/** Links an existing nonprofit organization record to the owner's main record. Nothing is merged or copied. */
export async function linkExistingNonprofit(actor: Actor, clientId: string, orgId: string, role = "OWNER") {
  const org = await prisma.client.findUnique({ where: { id: orgId }, select: { clientType: true, displayName: true } });
  if (!org || org.clientType !== "NONPROFIT") throw new ValidationError("Choose a nonprofit organization record. A business stays a business — create the nonprofit as its own record.");
  const fam = await ownerRecord(clientId);
  await linkBusiness(actor, fam.anchor.id, orgId, role);
  await markHasNonprofit(actor, fam.anchor.id);
}

async function markHasNonprofit(actor: Actor, anchorId: string) {
  const a = await prisma.client.findUniqueOrThrow({ where: { id: anchorId }, select: { hasNonprofit: true } });
  if (a.hasNonprofit === "YES") return;
  await prisma.client.update({ where: { id: anchorId }, data: { hasNonprofit: "YES" } });
  await audit(prisma, { actorId: actor.id, action: "client.has_nonprofit_set", entityType: "Client", entityId: anchorId, clientId: anchorId, details: { before: a.hasNonprofit, after: "YES", via: "nonprofit_linked" } });
}

/** Does TTurner handle this organization's annual filings? Only Yes puts it on the Nonprofit Filings tracker and its reminders. */
export async function setFilingService(actor: Actor, orgId: string, value: string) {
  if (!(value in FILING_SERVICE)) throw new ValidationError("Choose Yes, No or Pending agreement.");
  const org = await prisma.client.findUnique({ where: { id: orgId }, select: { clientType: true } });
  if (!org || org.clientType !== "NONPROFIT") throw new ValidationError("Choose a nonprofit organization record.");
  const before = await prisma.nonprofitProfile.findUnique({ where: { clientId: orgId }, select: { filingService: true } });
  await prisma.nonprofitProfile.upsert({ where: { clientId: orgId }, create: { clientId: orgId, filingService: value, updatedById: actor.id }, update: { filingService: value as FilingService, updatedById: actor.id } });
  await audit(prisma, { actorId: actor.id, action: "nonprofit.filing_service_set", entityType: "Client", entityId: orgId, clientId: orgId, details: { before: before?.filingService ?? null, after: value } });
}

/** Nonprofit organization records an owner could be linked to (not already in another owner's group). */
export async function linkableNonprofits(clientId: string) {
  const fam = await ownerRecord(clientId);
  const linked = new Set(fam.businesses.map((b) => b.id));
  const all = await prisma.client.findMany({ where: { clientType: "NONPROFIT", archivedAt: null, ownsBusinesses: { none: {} } }, select: { id: true, displayName: true, ownedBy: { select: { personClientId: true } } }, orderBy: { displayName: "asc" }, take: 300 });
  return all.filter((o) => !linked.has(o.id) && o.id !== fam.anchor.id && (fam.anchor.clientType === "INDIVIDUAL" || o.ownedBy.every((x) => x.personClientId === fam.anchor.id)));
}
