import "server-only";
import { isFutureDay } from "@/lib/dates";
import { z } from "zod";
import type { Channel, Client, ClientStatus, ClientType, ConsentKind, ConsentStatus, Prisma, SuppressionReason } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import { audit, changedFields } from "@/lib/audit";
import { assertAdmin, ForbiddenError, type Actor } from "@/lib/auth/actor";
import { buildDisplayName, formatPhone, householdName, normalizeEmail, normalizePhone, splitList } from "@/lib/normalize";
import { TAX_INFO_KINDS } from "@/lib/consent";
import { addressComplete, isCompleteAddress, type AddressFields } from "@/lib/client-address";
import { ADDRESS_NEEDED_TAG } from "@/lib/import/edits";

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
  middleName: opt,
  spouseFirstName: opt,
  spouseMiddleName: opt,
  spouseLastName: opt,
  spouseEmail: opt,
  spousePhone: opt,
  lastName: opt,
  preferredName: opt,
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
  // The client form's "Filing jointly / spouse needed for {year}" box. Undefined
  // (imports, other callers) keeps the old behavior: spouse fields saved as given.
  spouseNeeded: z.boolean().optional(),
  spouseYear: z.number().int().min(2000).max(2100).optional(),
  // The Create/Edit client screens' Physical + Mailing address blocks. Undefined
  // (imports, sign-ups, other callers) leaves the mailing columns and the
  // Address Needed flag as they are.
  mailingSection: z.boolean().optional(),
  mailingSameAsAddress: z.boolean().optional(),
  mailingAddressLine1: opt,
  mailingAddressLine2: opt,
  mailingCity: opt,
  mailingState: opt,
  mailingPostalCode: opt,
});

export type ClientInput = z.input<typeof clientSchema>;

/**
 * "Allison R Stockton", or for a joint household "Allison R Stockton &
 * Jonathan Scoggins" — one client record for the couple.
 */
export function clientDisplayName(v: { firstName?: string | null; middleName?: string | null; lastName?: string | null; businessName?: string | null; spouseFirstName?: string | null; spouseMiddleName?: string | null; spouseLastName?: string | null; clientType?: string }) {
  const first = [v.firstName, v.middleName].map((x) => x?.trim()).filter(Boolean).join(" ") || null;
  if ((v.clientType ?? "INDIVIDUAL") === "INDIVIDUAL" && (v.spouseFirstName || v.spouseLastName) && (first || v.lastName)) {
    return householdName({ first, last: v.lastName ?? null }, { first: [v.spouseFirstName, v.spouseMiddleName].map((x) => x?.trim()).filter(Boolean).join(" ") || null, last: v.spouseLastName ?? null });
  }
  return buildDisplayName({ firstName: first, lastName: v.lastName ?? null, businessName: v.businessName ?? null });
}

type SpouseFields = Pick<Client, "spouseFirstName" | "spouseMiddleName" | "spouseLastName" | "spouseEmail" | "spousePhone">;

function toClientData(input: ClientInput, before?: SpouseFields | null) {
  const parsed = clientSchema.safeParse(input);
  if (!parsed.success) throw new ValidationError(parsed.error.issues[0]?.message ?? "Check the form.");
  const raw = parsed.data;
  // Spouse details are saved only for an individual whose spouse box is ticked.
  // A business is never asked for (and never saves) personal spouse information.
  // With the box unticked, a spouse already on file is kept as it was (it may be a
  // past year's), and nothing new is saved.
  const individual = raw.clientType === "INDIVIDUAL";
  const saveSpouse = individual && raw.spouseNeeded !== false;
  const kept = individual && raw.spouseNeeded === false && before ? before : null;
  const v = saveSpouse
    ? raw
    : { ...raw, spouseFirstName: kept?.spouseFirstName ?? null, spouseMiddleName: kept?.spouseMiddleName ?? null, spouseLastName: kept?.spouseLastName ?? null, spouseEmail: kept?.spouseEmail ?? null, spousePhone: kept?.spousePhone ?? null };
  if (!v.firstName && !v.lastName && !v.businessName) throw new ValidationError("Enter a name or a business name.");
  const emailNormalized = normalizeEmail(v.email);
  if (v.email && !emailNormalized) throw new ValidationError("That email address doesn't look right.");
  const phoneNormalized = normalizePhone(v.phone);
  if (v.phone && !phoneNormalized) throw new ValidationError("Enter a 10-digit US phone number, or an international number starting with +.");
  const spousePhoneNormalized = normalizePhone(v.spousePhone);
  if (v.spousePhone && !spousePhoneNormalized) throw new ValidationError("The spouse's phone number doesn't look right.");
  if (v.spouseEmail && !normalizeEmail(v.spouseEmail)) throw new ValidationError("The spouse's email address doesn't look right.");
  const spouseData = saveSpouse
    ? {
        spouseFirstName: v.spouseFirstName ?? null,
        spouseMiddleName: v.spouseMiddleName ?? null,
        spouseLastName: v.spouseLastName ?? null,
        spouseEmail: v.spouseEmail ?? null,
        // Stored formatted, e.g. "(205) 555-0123"; typed markers like a trailing "M" are dropped.
        spousePhone: spousePhoneNormalized ? formatPhone(spousePhoneNormalized) : null,
        spousePhoneNormalized,
      }
    : kept
      ? {}
      : { spouseFirstName: null, spouseMiddleName: null, spouseLastName: null, spouseEmail: null, spousePhone: null, spousePhoneNormalized: null };
  // Mailing address: "same as physical" clears the mailing columns; a separate
  // one must be complete (street, city, 2-letter state, 5- or 9-digit ZIP).
  let mailingData: Partial<Pick<Client, "mailingSameAsAddress" | "mailingAddressLine1" | "mailingAddressLine2" | "mailingCity" | "mailingState" | "mailingPostalCode">> = {};
  if (raw.mailingSection) {
    if (raw.mailingSameAsAddress !== false) {
      mailingData = { mailingSameAsAddress: true, mailingAddressLine1: null, mailingAddressLine2: null, mailingCity: null, mailingState: null, mailingPostalCode: null };
    } else {
      const m = { line1: raw.mailingAddressLine1 ?? null, line2: raw.mailingAddressLine2 ?? null, city: raw.mailingCity ?? null, state: raw.mailingState ?? null, postalCode: raw.mailingPostalCode ?? null };
      if (!isCompleteAddress(m)) {
        throw new ValidationError("Enter the complete mailing address (street, city, 2-letter state and 5- or 9-digit ZIP), or tick “Mailing address is the same as physical address”.");
      }
      mailingData = { mailingSameAsAddress: false, mailingAddressLine1: m.line1, mailingAddressLine2: m.line2, mailingCity: m.city, mailingState: m.state!.toUpperCase(), mailingPostalCode: m.postalCode };
    }
  }
  return {
    joint: individual && raw.spouseNeeded !== undefined ? { needed: raw.spouseNeeded, year: raw.spouseYear ?? currentTaxYear() } : null,
    data: {
      firstName: v.firstName ?? null,
      middleName: v.middleName ?? null,
      lastName: v.lastName ?? null,
      ...spouseData,
      preferredName: v.preferredName ?? null,
      businessName: v.businessName ?? null,
      displayName: clientDisplayName(v),
      email: v.email ?? null,
      emailNormalized,
      phone: phoneNormalized ? formatPhone(phoneNormalized) : null,
      phoneNormalized,
      addressLine1: v.addressLine1 ?? null,
      addressLine2: v.addressLine2 ?? null,
      city: v.city ?? null,
      state: v.state?.toUpperCase() ?? null,
      postalCode: v.postalCode ?? null,
      ...mailingData,
      clientType: v.clientType as ClientType,
      status: v.status as ClientStatus,
      services: splitList(v.services),
      tags: splitList(v.tags),
      notes: v.notes?.trim() || null,
      assignedToId: v.assignedToId ?? null,
    },
    groupIds: v.groupIds,
    // Only the Create/Edit client screens manage the Address Needed flag.
    trackAddressNeeded: !!raw.mailingSection,
  };
}

async function assertAssignable(userId: string | null) {
  if (!userId) return;
  const user = await prisma.user.findFirst({ where: { id: userId, active: true } });
  if (!user) throw new ValidationError("Choose an active staff member.");
}

/**
 * Saving the client screen with a complete, valid address (and mailing address,
 * if separate) clears the "Address Needed" flag; saving it still incomplete
 * keeps or sets it (even if it was deleted from the Tags box). Returns the
 * change for the audit, if any.
 */
function applyAddressNeeded(data: { tags: string[] } & AddressFields, before?: (AddressFields & { tags: string[] }) | null): "cleared" | "set" | null {
  const hadBefore = !!before?.tags.includes(ADDRESS_NEEDED_TAG);
  const has = data.tags.includes(ADDRESS_NEEDED_TAG);
  // An edit that doesn't touch the mailing block keeps the record's mailing values.
  if (addressComplete({ ...(before ?? {}), ...data })) {
    if (has) data.tags = data.tags.filter((t) => t !== ADDRESS_NEEDED_TAG);
    return has || hadBefore ? "cleared" : null;
  }
  if (!has) data.tags = [...data.tags, ADDRESS_NEEDED_TAG];
  return hadBefore ? null : "set";
}

export async function createClient(actor: Actor, input: ClientInput) {
  const { data, groupIds, joint, trackAddressNeeded } = toClientData(input);
  const flag = trackAddressNeeded ? applyAddressNeeded(data) : null;
  await assertAssignable(data.assignedToId);
  return prisma.$transaction(async (tx) => {
    const client = await tx.client.create({ data: { ...data, source: "Added by staff" } });
    if (groupIds?.length) {
      await tx.clientGroup.createMany({ data: groupIds.map((groupId) => ({ clientId: client.id, groupId })), skipDuplicates: true });
    }
    if (joint?.needed) await setJointFiling(tx, client.id, joint.year, true, { staffId: actor.id });
    await audit(tx, { actorId: actor.id, action: "client.created", entityType: "Client", entityId: client.id, clientId: client.id });
    if (flag) await audit(tx, { actorId: actor.id, action: `client.address_needed_${flag}`, entityType: "Client", entityId: client.id, clientId: client.id, details: { tag: ADDRESS_NEEDED_TAG } });
    return client;
  });
}

export async function updateClient(actor: Actor, clientId: string, input: ClientInput) {
  const before = await prisma.client.findUnique({ where: { id: clientId }, include: { groups: true } });
  if (!before) throw new ValidationError("Client not found.");
  const { data, groupIds, joint, trackAddressNeeded } = toClientData(input, before);
  const flag = trackAddressNeeded ? applyAddressNeeded(data, before) : null;
  await assertAssignable(data.assignedToId);
  const fields = changedFields(before as unknown as Record<string, unknown>, data);
  return prisma.$transaction(async (tx) => {
    let client = await tx.client.update({ where: { id: clientId }, data });
    // A joint return keeps its household name ("John & Jane Doe") on edit.
    const { syncHouseholdName } = await import("@/lib/services/tax-prep");
    if (await syncHouseholdName(tx, clientId)) client = await tx.client.findUniqueOrThrow({ where: { id: clientId } });
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
    if (flag) await audit(tx, { actorId: actor.id, action: `client.address_needed_${flag}`, entityType: "Client", entityId: clientId, clientId, details: { tag: ADDRESS_NEEDED_TAG } });
    if (joint) await setJointFiling(tx, clientId, joint.year, joint.needed, { staffId: actor.id });
    return client;
  });
}

// --- Joint filing, per tax year ------------------------------------------------

/** The tax year being prepared now: last calendar year (Central time). */
export function currentTaxYear(now = new Date()) {
  return Number(now.toLocaleString("en-US", { timeZone: "America/Chicago", year: "numeric" })) - 1;
}

/**
 * "Filing jointly / spouse needed for {year}": the answer recorded for that year,
 * or a joint return type on that year's tax-prep case. A spouse saved for an
 * earlier year never makes this true by itself.
 */
export async function jointFilingNeeded(clientId: string, year = currentTaxYear()) {
  const [flag, kase] = await Promise.all([
    prisma.jointFilingYear.findUnique({ where: { clientId_taxYear: { clientId, taxYear: year } } }),
    prisma.taxPrepCase.findUnique({ where: { clientId_taxYear: { clientId, taxYear: year } }, select: { returnType: true } }),
  ]);
  if (flag) return flag.needed;
  return kase?.returnType === "1040_MFJ" || kase?.returnType === "1040_MFS";
}

/**
 * The client's own answer from My Tax Center ("I'm filing jointly for {year}").
 * Only the account owner of a Personal (individual) account; never for a business.
 */
export async function portalSetJointFiling(user: { id: string }, clientId: string, taxYear: number, needed: boolean) {
  const { requireClientAccess } = await import("@/lib/portal/access");
  const access = await requireClientAccess(user.id, clientId, "tax");
  if (access.role !== "OWNER") throw new ForbiddenError("Only the account owner can answer this.");
  const c = await prisma.client.findUniqueOrThrow({ where: { id: clientId }, select: { clientType: true } });
  if (c.clientType !== "INDIVIDUAL") throw new ValidationError("Business accounts aren't asked for spouse information.");
  const y = currentTaxYear();
  if (taxYear < y - 3 || taxYear > y + 1) throw new ValidationError("Choose a tax year from the list.");
  await prisma.$transaction((tx) => setJointFiling(tx, clientId, taxYear, needed, { portalUserId: user.id }));
}

/** Records the year's answer (staff or the client). Audited only when it changes. */

export async function setJointFiling(db: Prisma.TransactionClient, clientId: string, taxYear: number, needed: boolean, by: { staffId?: string; portalUserId?: string }) {
  const prev = await db.jointFilingYear.findUnique({ where: { clientId_taxYear: { clientId, taxYear } } });
  if (prev?.needed === needed) return;
  if (!prev && !needed) return;
  const source = by.portalUserId ? "CLIENT" : "STAFF";
  await db.jointFilingYear.upsert({
    where: { clientId_taxYear: { clientId, taxYear } },
    update: { needed, source, setById: by.staffId ?? null, setByPortalId: by.portalUserId ?? null },
    create: { clientId, taxYear, needed, source, setById: by.staffId ?? null, setByPortalId: by.portalUserId ?? null },
  });
  await audit(db, { actorId: by.staffId ?? null, action: "client.joint_filing_set", entityType: "Client", entityId: clientId, clientId, details: { taxYear, needed, source, ...(by.portalUserId ? { portalUserId: by.portalUserId } : {}) } });
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
  preferredName: opt,
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
  const data = { name: v.name, preferredName: v.preferredName ?? null, title: v.title ?? null, email: v.email ?? null, emailNormalized, phone: v.phone ?? null, phoneNormalized };
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
  // Owners are removed (archived) from the Owners card, which keeps their K-1s and history.
  if (await prisma.businessOwner.count({ where: { contactId } })) throw new ValidationError("This person is a business owner. Remove them from the Owners card instead.");
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
  if (input.effectiveAt && isFutureDay(input.effectiveAt)) throw new ValidationError("The date can't be in the future.");
  const smsCategory = input.kind === "SMS_SERVICE" ? "SERVICE" : input.kind === "SMS_MARKETING" ? "MARKETING" : null;
  let smsPhone: string | null = null;
  if (smsCategory) {
    const person = input.contactId
      ? await prisma.contact.findUnique({ where: { id: input.contactId }, select: { phoneNormalized: true } })
      : await prisma.client.findUnique({ where: { id: clientId }, select: { phoneNormalized: true } });
    smsPhone = person?.phoneNormalized ?? null;
  }
  return prisma.$transaction(async (tx) => {
    // Text permissions are tracked per phone number so every send checks one ledger.
    if (smsCategory && smsPhone && (input.status === "GRANTED" || input.status === "REVOKED")) {
      await tx.smsConsentEvent.create({
        data: { phoneNormalized: smsPhone, category: smsCategory, status: input.status, source: "STAFF", consentText: input.scope?.trim() || null, actorId: actor.id },
      });
      if (input.status === "GRANTED") {
        const stop = await tx.suppression.findFirst({ where: { channel: "SMS", addressNormalized: smsPhone, liftedAt: null } });
        if (stop) throw new ValidationError("This number replied STOP. It can only be opted back in by the person themselves (consent page or a new written opt-in reviewed by an Admin).");
      }
    }
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
  "business_owner.added": "Owner added",
  "business_owner.updated": "Owner updated",
  "business_owner.archived": "Owner removed (archived)",
  "business_owner.invited": "Owner invited to the portal",
  "business_owner.permissions_changed": "Owner portal permissions changed",
  "business_owner.k1_shared": "K-1 shared with another owner",
  "business_owner.k1_unshared": "K-1 sharing removed",
  "client.joint_filing_set": "Joint filing (spouse) answer recorded",
  "personal_tax.requested": "Personal tax preparation requested",
  "personal_tax.accepted": "Personal tax request accepted",
  "personal_tax.declined": "Personal tax request declined",
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
