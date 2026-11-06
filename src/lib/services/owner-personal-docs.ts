import "server-only";
import { prisma } from "@/lib/prisma";
import { audit } from "@/lib/audit";
import type { Actor } from "@/lib/auth/actor";
import type { PortalActor } from "@/lib/portal/session";
import { requireClientAccess } from "@/lib/portal/access";
import { CLIENT_DOC_TYPES, isClientDocType } from "@/lib/document-types";
import { assertCanSendClientRequests } from "./bk-permissions";
import { ValidationError } from "./clients";
import { ID_TYPES } from "./identity";
import { queuePortalNotification } from "./notifications";

/**
 * A business owner's own personal documents on a business-only account (no personal tax
 * preparation): personal supporting documents (W-2s, 1099s, 1098, charitable contributions,
 * property taxes, car tags…) and, when the office asks, identity documents. Everything is filed to
 * ONE owner (Document.businessOwnerId / DocumentRequest.businessOwnerId; with no owner record, the
 * uploading login) and a tax year, and opens only for that owner's login, Tabitha and authorized
 * staff — never the business's other owners or contacts. Asking for or sending these documents
 * never adds personal tax preparation to the account (Client.services / ClientService unchanged),
 * and Tax Summary & Approval and refund options stay closed to business-only accounts.
 */

export const OWNER_REQUEST_KIND = "OWNER_PERSONAL";
const isIdType = (t: string): t is keyof typeof ID_TYPES => t in ID_TYPES;

/** The business owner record for this login on this business, if any. */
export function ownerForLogin(clientId: string, portalUserId: string) {
  return prisma.businessOwner.findFirst({ where: { clientId, portalUserId, archivedAt: null }, include: { contact: { select: { name: true } } } });
}

/**
 * Staff ask one owner for a personal document for a tax year, or for an identity document
 * (driver's license, Social Security card, birth certificate). Only Admins, the assigned staff
 * member and staff Tabitha allows may ask. Only that owner's login is notified and may answer.
 */
export async function requestOwnerDocument(actor: Actor, clientId: string, input: { businessOwnerId: string; docType: string; taxYear?: number | null; title?: string; instructions?: string | null; dueAt?: Date | null }) {
  await assertCanSendClientRequests(actor, clientId);
  const owner = await prisma.businessOwner.findFirst({ where: { id: input.businessOwnerId, clientId, archivedAt: null }, include: { contact: { select: { name: true } } } });
  if (!owner) throw new ValidationError("Choose one of this business's owners.");
  const identity = isIdType(input.docType);
  if (!identity && !isClientDocType(input.docType)) throw new ValidationError("Choose the kind of document.");
  const thisYear = new Date().getFullYear();
  if (!identity && (!input.taxYear || input.taxYear < thisYear - 15 || input.taxYear > thisYear + 1)) throw new ValidationError("Choose the tax year the document is for.");
  const label = identity ? ID_TYPES[input.docType as keyof typeof ID_TYPES].label : CLIENT_DOC_TYPES[input.docType as keyof typeof CLIENT_DOC_TYPES];
  const title = (input.title?.trim() || `${label}${identity ? "" : ` (${input.taxYear})`}`).slice(0, 200);
  const req = await prisma.documentRequest.create({
    data: {
      clientId, businessOwnerId: owner.id, kind: OWNER_REQUEST_KIND, docType: input.docType, taxYear: identity ? null : input.taxYear!, title,
      instructions: input.instructions?.trim() || null, dueAt: input.dueAt ?? null, category: identity ? "CLIENT_UPLOADS" : "TAXES", createdById: actor.id, sentAt: new Date(), sentById: actor.id,
    },
  });
  await audit(prisma, { actorId: actor.id, action: "request.owner_document", entityType: "DocumentRequest", entityId: req.id, clientId, details: { businessOwnerId: owner.id, docType: input.docType, taxYear: req.taxYear, identity } });
  // The notice goes to that owner's own login only.
  if (owner.portalUserId) await queuePortalNotification(owner.portalUserId, "DOCUMENT_REQUEST", `DOCUMENT_REQUEST:request:${req.id}`);
  return req;
}

/** Open requests addressed to this login's own owner record (personal documents, or identity documents). */
export async function myOwnerRequests(user: PortalActor, clientId: string) {
  await requireClientAccess(user.id, clientId);
  return prisma.documentRequest.findMany({
    where: { clientId, kind: OWNER_REQUEST_KIND, status: { in: ["OPEN", "SUBMITTED"] }, businessOwner: { portalUserId: user.id, archivedAt: null } },
    orderBy: [{ taxYear: "desc" }, { createdAt: "asc" }],
    select: { id: true, title: true, instructions: true, docType: true, taxYear: true, status: true, dueAt: true },
  });
}

/** Whether this login has an open identity-document request (the only way the Identity page opens on a business-only account). */
export async function openIdentityRequest(portalUserId: string, clientId: string) {
  return prisma.documentRequest.findFirst({
    where: { clientId, kind: OWNER_REQUEST_KIND, status: "OPEN", docType: { in: Object.keys(ID_TYPES) }, businessOwner: { portalUserId, archivedAt: null } },
    select: { id: true, docType: true, businessOwnerId: true },
  });
}

/**
 * The identity person for one owner (role OWNER, linked by businessOwnerId), created on first use.
 * Their identity documents open only for that owner's login, plus staff under the usual rules.
 */
export async function ensureOwnerPerson(clientId: string, businessOwnerId: string) {
  const existing = await prisma.identityPerson.findUnique({ where: { businessOwnerId } });
  if (existing) return existing;
  const owner = await prisma.businessOwner.findFirstOrThrow({ where: { id: businessOwnerId, clientId }, include: { contact: { select: { name: true } } } });
  return prisma.identityPerson.create({ data: { clientId, role: "OWNER", name: owner.contact.name, businessOwnerId } });
}
