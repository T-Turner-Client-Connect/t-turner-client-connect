import "server-only";
import { z } from "zod";
import type { Channel, ClientStatus, ClientType, ConsentKind, ConsentStatus, Prisma, SuppressionReason } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { audit, changedFields } from "@/lib/audit";
import { assertAdmin, ForbiddenError, type Actor } from "@/lib/auth/actor";
import { buildDisplayName, normalizeEmail, normalizePhone, splitList } from "@/lib/normalize";
import { TAX_INFO_KINDS } from "@/lib/consent";

export class ValidationError extends Error {}

const opt = z
  .string()
  .trim()
  .max(500)
  .transform((s) => (s === "" ? null : s))
  .nullable()
  .optional();

export const clientSchema = z.object({
  firstName: opt,
  lastName: opt,
  businessName: opt,
  email: opt,
  phone: opt,
  addressLine1: opt,
  addressLine2: opt,
  city: opt,
  state: opt,
  postalCode: opt,
  clientType: z.enum(["INDIVIDUAL", "BUSINESS", "NONPROFIT"]),
  status: z.enum(["PROSPECT", "ACTIVE", "INACTIVE"]),
  services: z.string().max(2000).optional(),
  tags: z.string().max(2000).optional(),
  notes: z.string().max(10000).optional(),
  assignedToId: opt,
  groupIds: z.array(z.string()).optional(),
});

export type ClientInput = z.input<typeof clientSchema>;

function toClientData(input: ClientInput) {
  const parsed = clientSchema.safeParse(input);
  if (!parsed.success) throw new ValidationError(parsed.error.issues[0]?.message ?? "Check the form.");
  const v = parsed.data;
  if (!v.firstName && !v.lastName && !v.businessName) throw new ValidationError("Enter a name or a business name.");
  const emailNormalized = normalizeEmail(v.email);
  if (v.email && !emailNormalized) throw new ValidationError("That email address doesn't look right.");
  const phoneNormalized = normalizePhone(v.phone);
  if (v.phone && !phoneNormalized) throw new ValidationError("Enter a 10-digit US phone number, or an international number starting with +.");
  return {
    data: {
      firstName: v.firstName ?? null,
      lastName: v.lastName ?? null,
      businessName: v.businessName ?? null,
      displayName: buildDisplayName(v),
      email: v.email ?? null,
      emailNormalized,
      phone: v.phone ?? null,
      phoneNormalized,
      addressLine1: v.addressLine1 ?? null,
      addressLine2: v.addressLine2 ?? null,
      city: v.city ?? null,
      state: v.state?.toUpperCase() ?? null,
      postalCode: v.postalCode ?? null,
      clientType: v.clientType as ClientType,
      status: v.status as ClientStatus,
      services: splitList(v.services),
      tags: splitList(v.tags),
      notes: v.notes?.trim() || null,
      assignedToId: v.assignedToId ?? null,
    },
    groupIds: v.groupIds,
  };
}

async function assertAssignable(userId: string | null) {
  if (!userId) return;
  const user = await prisma.user.findFirst({ where: { id: userId, active: true } });
  if (!user) throw new ValidationError("Choose an active staff member.");
}

export async function createClient(actor: Actor, input: ClientInput) {
  const { data, groupIds } = toClientData(input);
  await assertAssignable(data.assignedToId);
  return prisma.$transaction(async (tx) => {
    const client = await tx.client.create({ data: { ...data, source: "Added by staff" } });
    if (groupIds?.length) {
      await tx.clientGroup.createMany({ data: groupIds.map((groupId) => ({ clientId: client.id, groupId })), skipDuplicates: true });
    }
    await audit(tx, { actorId: actor.id, action: "client.created", entityType: "Client", entityId: client.id, clientId: client.id });
    return client;
  });
}

export async function updateClient(actor: Actor, clientId: string, input: ClientInput) {
  const { data, groupIds } = toClientData(input);
  await assertAssignable(data.assignedToId);
  const before = await prisma.client.findUnique({ where: { id: clientId }, include: { groups: true } });
  if (!before) throw new ValidationError("Client not found.");
  const fields = changedFields(before as unknown as Record<string, unknown>, data);
  return prisma.$transaction(async (tx) => {
    const client = await tx.client.update({ where: { id: clientId }, data });
    if (groupIds) {
      const prev = new Set(before.groups.map((g) => g.groupId));
      const next = new Set(groupIds);
      await tx.clientGroup.deleteMany({ where: { clientId, groupId: { notIn: groupIds } } });
      await tx.clientGroup.createMany({ data: groupIds.map((groupId) => ({ clientId, groupId })), skipDuplicates: true });
      if (prev.size !== next.size || [...prev].some((g) => !next.has(g))) fields.push("groups");
    }
    if (fields.length) {
      await audit(tx, { actorId: actor.id, action: "client.updated", entityType: "Client", entityId: clientId, clientId, details: { fields } });
    }
    return client;
  });
}

export async function setArchived(actor: Actor, clientId: string, archived: boolean) {
  await prisma.$transaction([
    prisma.client.update({ where: { id: clientId }, data: { archivedAt: archived ? new Date() : null } }),
    prisma.auditLog.create({
      data: { actorId: actor.id, action: archived ? "client.archived" : "client.restored", entityType: "Client", entityId: clientId, clientId },
    }),
  ]);
}

export type ClientFilters = {
  q?: string;
  status?: string;
  type?: string;
  groupId?: string;
  tag?: string;
  assignedToId?: string;
  archived?: boolean;
};

export function clientWhere(f: ClientFilters): Prisma.ClientWhereInput {
  const where: Prisma.ClientWhereInput = { archivedAt: f.archived ? { not: null } : null };
  const q = f.q?.trim();
  if (q) {
    const digits = q.replace(/\D/g, "");
    where.OR = [
      { displayName: { contains: q, mode: "insensitive" } },
      { businessName: { contains: q, mode: "insensitive" } },
      { email: { contains: q, mode: "insensitive" } },
      { contacts: { some: { OR: [{ name: { contains: q, mode: "insensitive" } }, { email: { contains: q, mode: "insensitive" } }] } } },
      ...(digits.length >= 4 ? [{ phoneNormalized: { contains: digits } }, { contacts: { some: { phoneNormalized: { contains: digits } } } }] : []),
    ];
  }
  if (f.status && ["PROSPECT", "ACTIVE", "INACTIVE"].includes(f.status)) where.status = f.status as ClientStatus;
  if (f.type && ["INDIVIDUAL", "BUSINESS", "NONPROFIT"].includes(f.type)) where.clientType = f.type as ClientType;
  if (f.groupId) where.groups = { some: { groupId: f.groupId } };
  if (f.tag) where.tags = { has: f.tag };
  if (f.assignedToId) where.assignedToId = f.assignedToId === "none" ? null : f.assignedToId;
  return where;
}

// --- Contacts --------------------------------------------------------------

const contactSchema = z.object({
  name: z.string().trim().min(1, "Enter the contact's name.").max(200),
  title: opt,
  email: opt,
  phone: opt,
});

export async function saveContact(actor: Actor, clientId: string, contactId: string | null, input: z.input<typeof contactSchema>) {
  const parsed = contactSchema.safeParse(input);
  if (!parsed.success) throw new ValidationError(parsed.error.issues[0]?.message ?? "Check the form.");
  const v = parsed.data;
  const emailNormalized = normalizeEmail(v.email);
  if (v.email && !emailNormalized) throw new ValidationError("That email address doesn't look right.");
  const phoneNormalized = normalizePhone(v.phone);
  if (v.phone && !phoneNormalized) throw new ValidationError("That phone number doesn't look right.");
  const data = { name: v.name, title: v.title ?? null, email: v.email ?? null, emailNormalized, phone: v.phone ?? null, phoneNormalized };
  return prisma.$transaction(async (tx) => {
    const contact = contactId
      ? await tx.contact.update({ where: { id: contactId, clientId }, data })
      : await tx.contact.create({ data: { ...data, clientId } });
    await audit(tx, {
      actorId: actor.id,
      action: contactId ? "contact.updated" : "contact.added",
      entityType: "Contact",
      entityId: contact.id,
      clientId,
    });
    return contact;
  });
}

export async function removeContact(actor: Actor, clientId: string, contactId: string) {
  await prisma.$transaction(async (tx) => {
    const contact = await tx.contact.delete({ where: { id: contactId, clientId } });
    await audit(tx, { actorId: actor.id, action: "contact.removed", entityType: "Contact", entityId: contactId, clientId, details: { name: contact.name } });
  });
}

// --- Notes -----------------------------------------------------------------

export async function addNote(actor: Actor, clientId: string, body: string) {
  const text = body.trim();
  if (!text) throw new ValidationError("Write a note first.");
  if (text.length > 10000) throw new ValidationError("That note is too long.");
  return prisma.clientNote.create({ data: { clientId, authorId: actor.id, body: text } });
}

// --- Groups ----------------------------------------------------------------

export async function createGroup(actor: Actor, name: string, description?: string) {
  const n = name.trim();
  if (!n) throw new ValidationError("Enter a group name.");
  const exists = await prisma.group.findFirst({ where: { name: { equals: n, mode: "insensitive" } } });
  if (exists) throw new ValidationError("A group with that name already exists.");
  return prisma.$transaction(async (tx) => {
    const group = await tx.group.create({ data: { name: n.slice(0, 100), description: description?.trim() || null } });
    await audit(tx, { actorId: actor.id, action: "group.created", entityType: "Group", entityId: group.id, details: { name: group.name } });
    return group;
  });
}

export async function deleteGroup(actor: Actor, groupId: string) {
  assertAdmin(actor);
  await prisma.$transaction(async (tx) => {
    const group = await tx.group.delete({ where: { id: groupId } });
    await audit(tx, { actorId: actor.id, action: "group.deleted", entityType: "Group", entityId: groupId, details: { name: group.name } });
  });
}

// --- Consent ---------------------------------------------------------------

export type ConsentInput = {
  contactId?: string | null;
  kind: ConsentKind;
  status: ConsentStatus;
  scope?: string | null;
  source: string;
  evidenceNote?: string | null;
  evidenceFileId?: string | null;
  effectiveAt?: Date | null;
  expiresAt?: Date | null;
};

/**
 * Records a consent change as a new history entry. Section 7216 grants need
 * an Admin, a signed document on file, and a written scope — a marketing
 * checkbox is never enough.
 */
export async function recordConsent(actor: Actor, clientId: string, input: ConsentInput) {
  const isTaxInfo = TAX_INFO_KINDS.includes(input.kind);
  if (!input.source?.trim()) throw new ValidationError("Say where this permission came from.");
  if (isTaxInfo && input.contactId) throw new ValidationError("Section 7216 consents belong to the taxpayer (the client), not an additional contact.");
  if (isTaxInfo && input.status === "GRANTED") {
    if (actor.role !== "ADMIN") throw new ForbiddenError("Only an Admin can record a Section 7216 consent after reviewing the signed document.");
    if (!input.scope?.trim()) throw new ValidationError("Describe exactly what the taxpayer agreed to (scope).");
    if (!input.evidenceFileId) throw new ValidationError("Attach the signed consent document.");
    const file = await prisma.storedFile.findFirst({ where: { id: input.evidenceFileId, kind: "CONSENT_EVIDENCE" } });
    if (!file) throw new ValidationError("Attach the signed consent document.");
  }
  if (input.contactId) {
    const contact = await prisma.contact.findFirst({ where: { id: input.contactId, clientId } });
    if (!contact) throw new ValidationError("Contact not found.");
  }
  const now = new Date();
  if (input.effectiveAt && input.effectiveAt > now) throw new ValidationError("The date can't be in the future.");
  return prisma.$transaction(async (tx) => {
    const record = await tx.consentRecord.create({
      data: {
        clientId,
        contactId: input.contactId ?? null,
        kind: input.kind,
        status: input.status,
        scope: input.scope?.trim() || null,
        source: input.source.trim().slice(0, 200),
        evidenceNote: input.evidenceNote?.trim() || null,
        evidenceFileId: input.evidenceFileId || null,
        effectiveAt: input.effectiveAt ?? now,
        expiresAt: input.expiresAt ?? null,
        recordedById: actor.id,
        ...(isTaxInfo && input.status === "GRANTED" ? { reviewedById: actor.id, reviewedAt: now } : {}),
      },
    });
    await audit(tx, {
      actorId: actor.id,
      action: "consent.recorded",
      entityType: "ConsentRecord",
      entityId: record.id,
      clientId,
      details: { kind: input.kind, status: input.status, contactId: input.contactId ?? null, source: record.source },
    });
    return record;
  });
}

// --- Suppression (do-not-contact) -----------------------------------------

export async function addSuppression(actor: Actor, channel: Channel, address: string, reason: SuppressionReason, note?: string) {
  const normalized = channel === "EMAIL" ? normalizeEmail(address) : normalizePhone(address);
  if (!normalized) throw new ValidationError("Enter a valid address.");
  return prisma.$transaction(async (tx) => {
    const s = await tx.suppression.create({ data: { channel, addressNormalized: normalized, reason, note: note?.trim() || null, createdById: actor.id } });
    await audit(tx, { actorId: actor.id, action: "suppression.added", entityType: "Suppression", entityId: s.id, details: { channel, reason } });
    return s;
  });
}

/** Lifting an opt-out is an Admin decision and needs a documented reason. */
export async function liftSuppression(actor: Actor, suppressionId: string, note: string) {
  assertAdmin(actor);
  if (!note.trim()) throw new ValidationError("Record why the opt-out is being lifted (e.g. client texted START).");
  await prisma.$transaction(async (tx) => {
    await tx.suppression.update({ where: { id: suppressionId }, data: { liftedAt: new Date() } });
    await audit(tx, { actorId: actor.id, action: "suppression.lifted", entityType: "Suppression", entityId: suppressionId, details: { note: note.trim().slice(0, 500) } });
  });
}

export async function activeSuppressionsFor(pairs: { channel: Channel; address: string }[]) {
  if (pairs.length === 0) return new Map<string, { reason: SuppressionReason }[]>();
  const rows = await prisma.suppression.findMany({
    where: { liftedAt: null, OR: pairs.map((p) => ({ channel: p.channel, addressNormalized: p.address })) },
    select: { channel: true, addressNormalized: true, reason: true },
  });
  const map = new Map<string, { reason: SuppressionReason }[]>();
  for (const r of rows) {
    const key = `${r.channel}:${r.addressNormalized}`;
    map.set(key, [...(map.get(key) ?? []), { reason: r.reason }]);
  }
  return map;
}

// --- Timeline --------------------------------------------------------------

export type TimelineItem = { id: string; at: Date; kind: "note" | "task" | "audit"; title: string; body?: string | null; by?: string | null };

const AUDIT_TEXT: Record<string, string> = {
  "client.created": "Client added",
  "client.created_by_import": "Created by import",
  "client.updated": "Details updated",
  "client.updated_by_import": "Updated by import",
  "client.archived": "Archived",
  "client.restored": "Restored from archive",
  "contact.added": "Contact added",
  "contact.updated": "Contact updated",
  "contact.removed": "Contact removed",
  "consent.recorded": "Permission recorded",
  "campaign.excluded": "Removed from a campaign",
  "campaign.included": "Added to a campaign",
};

export async function clientTimeline(clientId: string): Promise<TimelineItem[]> {
  const [notes, tasks, logs] = await Promise.all([
    prisma.clientNote.findMany({ where: { clientId }, include: { author: { select: { name: true } } }, orderBy: { createdAt: "desc" }, take: 200 }),
    prisma.task.findMany({ where: { clientId }, include: { assignee: { select: { name: true } } }, orderBy: { createdAt: "desc" }, take: 200 }),
    prisma.auditLog.findMany({ where: { clientId }, include: { actor: { select: { name: true } } }, orderBy: { createdAt: "desc" }, take: 200 }),
  ]);
  const items: TimelineItem[] = [
    ...notes.map((n) => ({ id: `n-${n.id}`, at: n.createdAt, kind: "note" as const, title: "Note", body: n.body, by: n.author.name })),
    ...tasks.map((t) => ({
      id: `t-${t.id}`,
      at: t.completedAt ?? t.createdAt,
      kind: "task" as const,
      title: t.status === "DONE" ? `Task completed: ${t.title}` : `Task: ${t.title}`,
      body: t.assignee ? `Assigned to ${t.assignee.name}` : null,
    })),
    ...logs.map((l) => {
      const details = (l.details ?? {}) as Record<string, unknown>;
      let body: string | null = null;
      if (Array.isArray(details.fields)) body = `Changed: ${(details.fields as string[]).join(", ")}`;
      if (l.action === "consent.recorded") body = `${String(details.kind)} → ${String(details.status)} (${String(details.source)})`;
      if (typeof details.campaignTitle === "string") body = String(details.campaignTitle);
      return { id: `a-${l.id}`, at: l.createdAt, kind: "audit" as const, title: AUDIT_TEXT[l.action] ?? l.action, body, by: l.actor?.name ?? null };
    }),
  ];
  return items.sort((a, b) => b.at.getTime() - a.at.getTime());
}
