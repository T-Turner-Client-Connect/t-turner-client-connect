import "server-only";
import type { BusinessAccess, Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { ForbiddenError, type Actor } from "@/lib/auth/actor";
import { assertOffice } from "@/lib/auth/owner";
import { can } from "@/lib/auth/permissions";
import { ValidationError } from "./clients";

/**
 * Managed Business Client access — the foundation every business feature (Banking, Coetha,
 * Financial Statements, Client Invoicing, the Business dashboard) sits on.
 *
 * - Every client is a Regular Tax Client (businessAccess = OFF) until the owner approves.
 * - Registration answers, client type (LLC, corporation, nonprofit…), tax return type and
 *   listed services NEVER change it. Nothing here runs automatically.
 * - The owner, or staff she authorized, may REQUEST a conversion; only the owner decides.
 * - Each business is its own client record, so its ledger, bank records, invoices and
 *   statements are already separate; a login sees a business only through its own grant.
 * - Removing access blocks it at once (the portal gate reads this column on every request)
 *   and deletes nothing.
 * - Every change is written to BusinessAccessEvent (append-only) and the general AuditLog.
 */

type Tx = Prisma.TransactionClient;

export const MANAGED_SERVICES = ["Bookkeeping", "Accounting", "Payroll", "Financial reporting", "Business tax planning", "Other business management"] as const;

async function log(tx: Tx, e: { clientId?: string | null; actorId: string; action: string; fromStatus?: BusinessAccess | null; toStatus?: BusinessAccess | null; requestId?: string | null; targetUserId?: string | null; note?: string | null }) {
  await tx.businessAccessEvent.create({ data: { ...e, note: e.note?.slice(0, 1000) ?? null } });
  await tx.auditLog.create({
    data: { actorId: e.actorId, action: `business_access.${e.action.toLowerCase()}`, entityType: "BusinessAccess", entityId: e.requestId ?? e.clientId ?? e.targetUserId ?? null, clientId: e.clientId ?? null, details: { from: e.fromStatus ?? null, to: e.toStatus ?? null, targetUserId: e.targetUserId ?? null } },
  });
}

// Anyone who can approve conversions may also request one (the owner always can).
const isOwner = (actor: Actor) => can(actor, "business_access", "approve");

/** The owner, or a staff member the owner authorized to request conversions. */
export async function canRequestConversion(actor: Actor) {
  if (await isOwner(actor)) return true;
  const u = await prisma.user.findUnique({ where: { id: actor.id }, select: { active: true, businessConversionAccess: true } });
  return !!u?.active && u.businessConversionAccess;
}

export async function requestBusinessAccess(actor: Actor, clientId: string, input: { services: string[]; reason: string }) {
  if (!(await canRequestConversion(actor))) throw new ForbiddenError("Only Tabitha or staff she authorized can request Managed Business access.");
  const services = [...new Set(input.services)].filter((s) => (MANAGED_SERVICES as readonly string[]).includes(s));
  if (!services.length) throw new ValidationError("Choose the business services our firm actively provides.");
  const reason = input.reason.trim().slice(0, 1000);
  if (reason.length < 10) throw new ValidationError("Explain which services we manage for this business.");
  return prisma.$transaction(async (tx) => {
    const client = await tx.client.findUnique({ where: { id: clientId }, select: { archivedAt: true, businessAccess: true } });
    if (!client || client.archivedAt) throw new ValidationError("Client not found.");
    if (client.businessAccess === "ACTIVE") throw new ValidationError("This business already has Managed Business access.");
    if (await tx.businessAccessRequest.count({ where: { clientId, status: "PENDING" } })) throw new ValidationError("A request for this business is already waiting for Tabitha.");
    const req = await tx.businessAccessRequest.create({ data: { clientId, requestedById: actor.id, services, reason } });
    await log(tx, { clientId, actorId: actor.id, action: "REQUESTED", fromStatus: client.businessAccess, requestId: req.id, note: reason });
    return req;
  });
}

/** Owner only. Turns this one business ACTIVE; the person's other accounts are untouched. */
export async function approveBusinessAccess(actor: Actor, requestId: string, note?: string) {
  await assertOffice(actor, "business_access", "approve");
  return prisma.$transaction(async (tx) => {
    const req = await tx.businessAccessRequest.findUnique({ where: { id: requestId }, include: { client: { select: { businessAccess: true, archivedAt: true } } } });
    if (!req) throw new ValidationError("Request not found.");
    if (req.client.archivedAt) throw new ValidationError("This client is archived.");
    // Conditional update: two clicks or two owners can never approve twice.
    const done = await tx.businessAccessRequest.updateMany({ where: { id: requestId, status: "PENDING" }, data: { status: "APPROVED", decidedById: actor.id, decidedAt: new Date(), decisionNote: note?.trim().slice(0, 1000) || null } });
    if (!done.count) throw new ValidationError("This request was already decided.");
    await tx.client.update({ where: { id: req.clientId }, data: { businessAccess: "ACTIVE", businessAccessChangedAt: new Date(), businessAccessChangedBy: actor.id } });
    await log(tx, { clientId: req.clientId, actorId: actor.id, action: "APPROVED", fromStatus: req.client.businessAccess, toStatus: "ACTIVE", requestId, note });
  });
}

export async function declineBusinessAccess(actor: Actor, requestId: string, note: string) {
  await assertOffice(actor, "business_access", "approve");
  const why = note.trim().slice(0, 1000);
  if (!why) throw new ValidationError("Add a short reason.");
  return prisma.$transaction(async (tx) => {
    const done = await tx.businessAccessRequest.updateMany({ where: { id: requestId, status: "PENDING" }, data: { status: "DECLINED", decidedById: actor.id, decidedAt: new Date(), decisionNote: why } });
    if (!done.count) throw new ValidationError("This request was already decided.");
    const req = await tx.businessAccessRequest.findUniqueOrThrow({ where: { id: requestId } });
    await log(tx, { clientId: req.clientId, actorId: actor.id, action: "DECLINED", requestId, note: why });
  });
}

/** The person who asked, or the owner, can withdraw a pending request. */
export async function cancelBusinessAccessRequest(actor: Actor, requestId: string) {
  const req = await prisma.businessAccessRequest.findUnique({ where: { id: requestId } });
  if (!req) throw new ValidationError("Request not found.");
  if (req.requestedById !== actor.id && !(await isOwner(actor))) throw new ForbiddenError("Only the person who asked, or Tabitha, can withdraw this request.");
  return prisma.$transaction(async (tx) => {
    const done = await tx.businessAccessRequest.updateMany({ where: { id: requestId, status: "PENDING" }, data: { status: "CANCELLED", decidedById: actor.id, decidedAt: new Date() } });
    if (!done.count) throw new ValidationError("This request was already decided.");
    await log(tx, { clientId: req.clientId, actorId: actor.id, action: "CANCELLED", requestId });
  });
}

/**
 * Owner only. Blocks the Business side for this business immediately. Ledger, bank
 * records, invoices, statements, tax history, documents, messages and logins all stay.
 */
export async function removeBusinessAccess(actor: Actor, clientId: string, reason: string) {
  await assertOffice(actor, "business_access", "manage");
  const why = reason.trim().slice(0, 1000);
  if (!why) throw new ValidationError("Add a short reason.");
  return prisma.$transaction(async (tx) => {
    const c = await tx.client.findUnique({ where: { id: clientId }, select: { businessAccess: true } });
    if (!c) throw new ValidationError("Client not found.");
    if (c.businessAccess !== "ACTIVE") throw new ValidationError("This business doesn't have Managed Business access.");
    await tx.client.update({ where: { id: clientId }, data: { businessAccess: "REMOVED", businessAccessChangedAt: new Date(), businessAccessChangedBy: actor.id } });
    await log(tx, { clientId, actorId: actor.id, action: "REMOVED", fromStatus: "ACTIVE", toStatus: "REMOVED", note: why });
  });
}

/** Owner only: lets a staff member REQUEST conversions (never approve). */
export async function setConversionRequester(actor: Actor, userId: string, on: boolean) {
  await assertOffice(actor, "business_access", "manage");
  return prisma.$transaction(async (tx) => {
    const u = await tx.user.findUnique({ where: { id: userId }, select: { businessConversionAccess: true } });
    if (!u) throw new ValidationError("Staff member not found.");
    if (u.businessConversionAccess === on) return;
    await tx.user.update({ where: { id: userId }, data: { businessConversionAccess: on, businessConversionGrantedBy: on ? actor.id : null, businessConversionGrantedAt: on ? new Date() : null } });
    await log(tx, { actorId: actor.id, action: on ? "REQUESTER_GRANTED" : "REQUESTER_REVOKED", targetUserId: userId });
  });
}

/**
 * Per-login business view for a Managed Business. Turning it ON is owner-only and only for
 * an ACTIVE business; anyone who manages portal access may turn it OFF. Logged either way.
 */
export async function assertLoginBusinessViewChange(tx: Tx, actor: Actor, accessId: string, next: boolean) {
  const a = await tx.portalAccess.findUniqueOrThrow({ where: { id: accessId }, include: { client: { select: { businessAccess: true } } } });
  if (a.canViewBookkeeping === next) return;
  if (next) {
    if (!(await can(actor, "business_access", "manage"))) throw new ForbiddenError("Only Tabitha (or staff she allows to manage business access) can give a login access to a Managed Business.");
    if (a.client.businessAccess !== "ACTIVE") throw new ValidationError("This client is a Regular Tax Client. Approve Managed Business access first.");
  }
  await log(tx, { clientId: a.clientId, actorId: actor.id, action: next ? "LOGIN_VIEW_ON" : "LOGIN_VIEW_OFF", targetUserId: a.portalUserId });
}

/** A client's status, open request and full history (staff view). */
export async function businessAccessFor(clientId: string) {
  const [client, pending, events] = await Promise.all([
    prisma.client.findUnique({ where: { id: clientId }, select: { businessAccess: true, businessAccessChangedAt: true, clientType: true } }),
    prisma.businessAccessRequest.findFirst({ where: { clientId, status: "PENDING" }, include: { requestedBy: { select: { name: true } } } }),
    prisma.businessAccessEvent.findMany({ where: { clientId }, orderBy: { createdAt: "desc" }, take: 50, include: { actor: { select: { name: true } } } }),
  ]);
  return { client, pending, events };
}

/**
 * Clients worth REVIEWING for conversion — they already have bookkeeping, ledger, bank or
 * business-invoicing records with our firm. A signal is only a reason to look: nobody is
 * converted, and client type or a "Business" answer at sign-up is never a signal.
 */
export async function conversionCandidates(actor: Actor) {
  if (!(await canRequestConversion(actor))) throw new ForbiddenError("Not available.");
  const notManaged = { businessAccess: { not: "ACTIVE" as const }, archivedAt: null };
  const [profiles, periods, books, banks, invoices, billing] = await Promise.all([
    prisma.bookkeepingProfile.findMany({ where: { client: notManaged }, select: { clientId: true } }),
    prisma.bookkeepingPeriod.groupBy({ by: ["clientId"], where: { client: notManaged }, _count: true }),
    prisma.ledgerBook.findMany({ where: { client: notManaged }, select: { clientId: true } }),
    prisma.bankConnection.findMany({ where: { status: { not: "DISCONNECTED" } }, select: { clientId: true } }),
    prisma.clientInvoice.groupBy({ by: ["clientId"], _count: true }),
    prisma.bookkeepingBilling.findMany({ where: { client: notManaged }, select: { clientId: true } }),
  ]);
  const signals = new Map<string, Set<string>>();
  const add = (id: string, s: string) => signals.set(id, (signals.get(id) ?? new Set()).add(s));
  profiles.forEach((p) => add(p.clientId, "Bookkeeping profile"));
  periods.forEach((p) => add(p.clientId, `${p._count} bookkeeping month${p._count === 1 ? "" : "s"}`));
  books.forEach((b) => add(b.clientId, "Ledger set up"));
  banks.forEach((b) => add(b.clientId, "Bank feed connected"));
  invoices.forEach((i) => add(i.clientId, "Business invoices"));
  billing.forEach((b) => add(b.clientId, "Monthly bookkeeping billing"));
  const ids = [...signals.keys()];
  const [clients, pending] = await Promise.all([
    prisma.client.findMany({ where: { id: { in: ids }, ...notManaged }, select: { id: true, displayName: true, businessName: true, clientType: true, businessAccess: true } }),
    prisma.businessAccessRequest.findMany({ where: { clientId: { in: ids }, status: "PENDING" }, select: { clientId: true } }),
  ]);
  const waiting = new Set(pending.map((p) => p.clientId));
  return clients
    .map((c) => ({ ...c, signals: [...(signals.get(c.id) ?? [])], pending: waiting.has(c.id) }))
    .sort((a, b) => (a.businessName || a.displayName).localeCompare(b.businessName || b.displayName));
}

/** Owner queue: pending requests, oldest first. */
export async function pendingBusinessRequests(actor: Actor) {
  await assertOffice(actor, "business_access", "view");
  return prisma.businessAccessRequest.findMany({
    where: { status: "PENDING" },
    orderBy: { createdAt: "asc" },
    include: { client: { select: { id: true, displayName: true, businessName: true, clientType: true } }, requestedBy: { select: { name: true } } },
  });
}
