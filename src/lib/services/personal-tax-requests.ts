import "server-only";
import { prisma } from "@/lib/prisma";
import { audit } from "@/lib/audit";
import type { Actor } from "@/lib/auth/actor";
import type { PortalActor } from "@/lib/portal/session";
import { requireClientAccess } from "@/lib/portal/access";
import { ValidationError } from "./clients";
import { serviceProfile } from "./service-profile";
import { queueStaffAlert } from "./staff-alerts";

/**
 * "Request personal tax preparation" from a business-only account. The request
 * waits for staff; accepting it sets up (or links) that person's own Personal
 * record with Individual tax preparation and gives their login access to it, so
 * the personal tax features (questionnaire, spouse, dependents, refund options)
 * turn on there. The business account itself stays business-only, and other
 * owners never see the person's personal information.
 */
export async function requestPersonalTax(user: PortalActor, clientId: string, note = "") {
  await requireClientAccess(user.id, clientId);
  if (!(await serviceProfile(clientId)).businessOnly) throw new ValidationError("Personal tax preparation is already part of this account.");
  if (await prisma.personalTaxRequest.count({ where: { clientId, portalUserId: user.id, status: "PENDING" } })) throw new ValidationError("Your request is already with our office. We'll be in touch.");
  const owner = await prisma.businessOwner.findFirst({ where: { clientId, portalUserId: user.id, archivedAt: null }, select: { id: true } });
  const { request, convoId } = await prisma.$transaction(async (tx) => {
    const request = await tx.personalTaxRequest.create({ data: { clientId, portalUserId: user.id, businessOwnerId: owner?.id ?? null, note: note.trim().slice(0, 1000) || null } });
    // Lands in the office inbox, private to this login (other owners don't see it).
    const convo = await tx.conversation.create({ data: { clientId, subject: "Request: personal tax preparation", awaitingStaff: true, unreadByStaff: true, privateToPortalUserId: user.id } });
    await tx.message.create({
      data: { conversationId: convo.id, channel: "PORTAL", direction: "INBOUND", portalAuthorId: user.id, status: "DELIVERED", readByClientAt: new Date(), body: `I'd like to add personal tax preparation.${request.note ? `\n${request.note}` : ""}` },
    });
    await audit(tx, { actorId: null, action: "personal_tax.requested", entityType: "PersonalTaxRequest", entityId: request.id, clientId, details: { portalUserId: user.id, businessOwnerId: owner?.id ?? null } });
    return { request, convoId: convo.id };
  });
  await queueStaffAlert({ conversationId: convoId });
  return request;
}

export async function pendingPersonalTaxRequests(clientId?: string) {
  return prisma.personalTaxRequest.findMany({ where: { status: "PENDING", ...(clientId ? { clientId } : {}) }, include: { portalUser: { select: { name: true, email: true } } }, orderBy: { createdAt: "asc" } });
}

/**
 * Staff decide. Accepting either links an existing Personal record (staff
 * confirmed it's this person) or creates a new one, adds Individual tax
 * preparation to it, and gives the requester's login owner access to it.
 */
export async function decidePersonalTaxRequest(actor: Actor, requestId: string, input: { accept: boolean; existingClientId?: string | null }) {
  const req = await prisma.personalTaxRequest.findUnique({ where: { id: requestId }, include: { portalUser: true } });
  if (!req || req.status !== "PENDING") throw new ValidationError("This request was already handled.");
  if (!input.accept) {
    await prisma.$transaction(async (tx) => {
      await tx.personalTaxRequest.update({ where: { id: req.id }, data: { status: "DECLINED", decidedById: actor.id, decidedAt: new Date() } });
      await audit(tx, { actorId: actor.id, action: "personal_tax.declined", entityType: "PersonalTaxRequest", entityId: req.id, clientId: req.clientId });
    });
    return null;
  }
  return prisma.$transaction(async (tx) => {
    let personalId = input.existingClientId || null;
    if (personalId) {
      const p = await tx.client.findUnique({ where: { id: personalId }, select: { clientType: true, archivedAt: true, services: true } });
      if (!p || p.archivedAt || p.clientType !== "INDIVIDUAL") throw new ValidationError("Choose an active Personal (individual) record.");
      if (!p.services.some((s) => s.toLowerCase() === "individual tax preparation")) await tx.client.update({ where: { id: personalId }, data: { services: [...p.services, "Individual tax preparation"] } });
    } else {
      const parts = req.portalUser.name.trim().split(/\s+/);
      const lastName = parts.length > 1 ? parts.pop()! : null;
      const firstName = parts.join(" ") || null;
      const created = await tx.client.create({
        data: {
          clientType: "INDIVIDUAL",
          firstName,
          lastName,
          displayName: req.portalUser.name.trim(),
          email: req.portalUser.email,
          emailNormalized: req.portalUser.email,
          status: "ACTIVE",
          services: ["Individual tax preparation"],
          source: "Requested personal tax preparation in the portal",
        },
      });
      personalId = created.id;
      await audit(tx, { actorId: actor.id, action: "client.created", entityType: "Client", entityId: created.id, clientId: created.id, details: { from: "personal_tax_request" } });
    }
    await tx.portalAccess.upsert({
      where: { portalUserId_clientId: { portalUserId: req.portalUserId, clientId: personalId } },
      update: { revokedAt: null },
      create: { portalUserId: req.portalUserId, clientId: personalId, role: "OWNER", canViewTax: true, canViewIdentity: true, grantedById: actor.id },
    });
    await tx.personalTaxRequest.update({ where: { id: req.id }, data: { status: "ACCEPTED", personalClientId: personalId, decidedById: actor.id, decidedAt: new Date() } });
    await audit(tx, { actorId: actor.id, action: "personal_tax.accepted", entityType: "PersonalTaxRequest", entityId: req.id, clientId: req.clientId, details: { personalClientId: personalId, linkedExisting: !!input.existingClientId } });
    return personalId;
  });
}
