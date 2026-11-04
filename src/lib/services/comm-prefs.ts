import "server-only";
import type { CampaignPurpose, Channel, CommPrefCategory, Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { currentConsent } from "@/lib/consent";
import { SMS_CONSENT_TEXT } from "@/lib/business";
import { normalizeEmail } from "@/lib/normalize";
import { smsBlock } from "@/lib/sms-block";
import { readUnsubscribeToken } from "@/lib/unsubscribe-token";
import { applySmsConsent, currentSmsConsent, peopleWithPhone } from "./sms-consent";
import { ValidationError } from "./clients";

/**
 * Communication Preferences: promotional texts, promotional email, and
 * general business updates, saved on the client's master profile.
 *
 * The consent ledger (ConsentRecord, SmsConsentEvent) and the Suppression
 * table stay the source of truth for whether a channel may be used; every
 * change here writes through to them, so every sender honors it on its very
 * next send. Essential service messages (appointments, billing, security
 * codes, tax document requests) are never blocked by these choices — only by
 * bounces/complaints/do-not-contact for email and the STOP block for texts.
 */

type Tx = Prisma.TransactionClient;
type Db = Tx | typeof prisma;

export type MessageCategory = "ESSENTIAL" | "PROMOTIONAL" | "GENERAL_UPDATE";
export type PrefSource = "PORTAL" | "EMAIL_LINK" | "ONE_CLICK" | "STOP_REPLY" | "START_REPLY" | "STAFF";
export type Person = { clientId: string; contactId: string | null };

export const SOURCE_TEXT: Record<string, string> = {
  PORTAL: "Client portal Communication Preferences",
  EMAIL_LINK: "Email unsubscribe link",
  ONE_CLICK: "One-click unsubscribe (email app)",
  STOP_REPLY: "Replied STOP to a text",
  START_REPLY: "Replied START to a text",
  STAFF: "Staff, at the client's request",
};

export const CATEGORY_TEXT: Record<CommPrefCategory, string> = {
  PROMO_SMS: "Promotional text messages",
  PROMO_EMAIL: "Promotional emails",
  GENERAL_UPDATES: "General business updates",
};

export function categoryForPurpose(purpose: CampaignPurpose): MessageCategory {
  if (purpose === "SERVICE") return "ESSENTIAL";
  if (purpose === "GENERAL_UPDATE") return "GENERAL_UPDATE";
  return "PROMOTIONAL";
}

const personKey = (p: Person) => p.contactId ?? "primary";
const keyOf = (p: Person) => `${p.clientId}:${personKey(p)}`;
function uniquePeople(list: Person[]): Person[] {
  const m = new Map<string, Person>();
  for (const p of list) m.set(keyOf(p), { clientId: p.clientId, contactId: p.contactId });
  return [...m.values()];
}

export async function peopleWithEmail(db: Db, email: string): Promise<Person[]> {
  const [clients, contacts] = await Promise.all([
    db.client.findMany({ where: { emailNormalized: email }, select: { id: true } }),
    db.contact.findMany({ where: { emailNormalized: email }, select: { id: true, clientId: true } }),
  ]);
  return [...clients.map((c) => ({ clientId: c.id, contactId: null })), ...contacts.map((c) => ({ clientId: c.clientId, contactId: c.id }))];
}

const EMAIL_BLOCK_TEXT = { BOUNCE: "Email address bounced", COMPLAINT: "Marked a message as spam", MANUAL: "On the do-not-contact list", STOP: "On the do-not-contact list", UNSUBSCRIBE: "Unsubscribed from promotional email" } as const;

/**
 * The one check every sender makes immediately before sending.
 * - ESSENTIAL: email unless bounced/complained/do-not-contact; text only with
 *   service-text consent and no STOP block.
 * - PROMOTIONAL: promotional permission for that channel, no unsubscribe/STOP.
 * - GENERAL_UPDATE: like ESSENTIAL, and nobody using the address opted out of
 *   general business updates.
 */
export async function canSend(
  input: { channel: Channel; address: string | null | undefined; category: MessageCategory; person?: Person },
  db: Db = prisma,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const { channel, category } = input;
  const address = channel === "EMAIL" ? normalizeEmail(input.address ?? "") : input.address?.trim() || null;
  if (!address) return { ok: false, reason: channel === "EMAIL" ? "No valid email address" : "No mobile number" };

  if (channel === "SMS") {
    const block = await smsBlock(db, address);
    if (block) return { ok: false, reason: block.reason === "MANUAL" ? "On the do-not-contact list" : "Texts blocked: the number replied STOP (reply START to resume)" };
    const sms = category === "PROMOTIONAL" ? "MARKETING" : "SERVICE";
    if ((await currentSmsConsent(db, address, sms)) !== "GRANTED") return { ok: false, reason: sms === "MARKETING" ? "No promotional text permission on file" : "No service text consent on file" };
  } else {
    const sups = await db.suppression.findMany({ where: { channel: "EMAIL", addressNormalized: address, liftedAt: null } });
    const hard = sups.find((s) => s.reason !== "UNSUBSCRIBE");
    if (hard) return { ok: false, reason: EMAIL_BLOCK_TEXT[hard.reason] };
    if (category === "PROMOTIONAL") {
      if (sups.length) return { ok: false, reason: EMAIL_BLOCK_TEXT.UNSUBSCRIBE };
      const people = input.person ? [input.person] : await peopleWithEmail(db, address);
      if (!people.length) return { ok: false, reason: "No promotional email permission on file" };
      const records = await db.consentRecord.findMany({ where: { kind: "EMAIL_MARKETING", OR: people.map((p) => ({ clientId: p.clientId, contactId: p.contactId })) } });
      const states = people.map((p) => currentConsent(records.filter((r) => r.clientId === p.clientId && r.contactId === p.contactId), "EMAIL_MARKETING"));
      if (states.includes("REVOKED")) return { ok: false, reason: "Opted out of promotional email" };
      if (!states.includes("GRANTED")) return { ok: false, reason: "No promotional email permission on file" };
    }
  }

  if (category === "GENERAL_UPDATE") {
    const sharing = channel === "EMAIL" ? await peopleWithEmail(db, address) : await peopleWithPhone(db, address);
    const people = uniquePeople([...(input.person ? [input.person] : []), ...sharing]);
    if (people.length && (await db.communicationPreference.count({ where: { generalUpdates: false, OR: people.map((p) => ({ clientId: p.clientId, personKey: personKey(p) })) } }))) {
      return { ok: false, reason: "Opted out of general business updates" };
    }
  }
  return { ok: true };
}

// --- Reading preferences -------------------------------------------------------

type ResolvedPerson = Person & { name: string; email: string | null; phone: string | null };

async function resolvePeople(db: Db, targets: Person[]): Promise<ResolvedPerson[]> {
  const out: ResolvedPerson[] = [];
  for (const t of uniquePeople(targets)) {
    if (t.contactId) {
      const c = await db.contact.findFirst({ where: { id: t.contactId, clientId: t.clientId }, select: { name: true, emailNormalized: true, phoneNormalized: true } });
      if (c) out.push({ ...t, name: c.name, email: c.emailNormalized, phone: c.phoneNormalized });
    } else {
      const c = await db.client.findUnique({ where: { id: t.clientId }, select: { displayName: true, emailNormalized: true, phoneNormalized: true } });
      if (c) out.push({ ...t, name: c.displayName, email: c.emailNormalized, phone: c.phoneNormalized });
    }
  }
  return out;
}

export type PreferenceState = {
  promoEmail: boolean;
  promoSms: boolean;
  generalUpdates: boolean;
  // Any vs. all, when the choices cover more than one record.
  any: { promoEmail: boolean; promoSms: boolean; generalUpdates: boolean };
  emails: string[];
  phones: string[];
  smsBlocked: boolean;
  emailBlocked: string | null;
};

const uniq = (xs: (string | null | undefined)[]) => Array.from(new Set(xs.filter((x): x is string => !!x)));

/** Current effective choices for a person (or the records a portal login speaks for). */
export async function preferenceState(targets: Person[], extra: { emails?: string[]; phones?: string[] } = {}, db: Db = prisma): Promise<PreferenceState> {
  const people = await resolvePeople(db, targets);
  const emails = uniq([...people.map((p) => p.email), ...(extra.emails ?? []).map((e) => normalizeEmail(e))]);
  const phones = uniq([...people.map((p) => p.phone), ...(extra.phones ?? [])]);

  const sups = emails.length ? await db.suppression.findMany({ where: { channel: "EMAIL", addressNormalized: { in: emails }, liftedAt: null } }) : [];
  const records = people.length ? await db.consentRecord.findMany({ where: { kind: "EMAIL_MARKETING", OR: people.map((p) => ({ clientId: p.clientId, contactId: p.contactId })) } }) : [];
  const emailOn = people.map((p) => currentConsent(records.filter((r) => r.clientId === p.clientId && r.contactId === p.contactId), "EMAIL_MARKETING") === "GRANTED");
  const unsubscribed = sups.length > 0;

  const smsOn: boolean[] = [];
  let smsBlocked = false;
  for (const phone of phones) {
    const block = await smsBlock(db, phone);
    if (block) smsBlocked = true;
    smsOn.push(!block && (await currentSmsConsent(db, phone, "MARKETING")) === "GRANTED");
  }

  const rows = people.length ? await db.communicationPreference.findMany({ where: { OR: people.map((p) => ({ clientId: p.clientId, personKey: personKey(p) })) } }) : [];
  const generalOn = people.map((p) => rows.find((r) => r.clientId === p.clientId && r.personKey === personKey(p))?.generalUpdates ?? true);

  const all = (xs: boolean[]) => xs.length > 0 && xs.every(Boolean);
  const some = (xs: boolean[]) => xs.some(Boolean);
  const hard = sups.find((s) => s.reason !== "UNSUBSCRIBE");
  return {
    promoEmail: !unsubscribed && all(emailOn),
    promoSms: all(smsOn),
    generalUpdates: generalOn.length ? all(generalOn) : true,
    any: { promoEmail: !unsubscribed && some(emailOn), promoSms: some(smsOn), generalUpdates: generalOn.length ? some(generalOn) : true },
    emails,
    phones,
    smsBlocked,
    emailBlocked: hard ? EMAIL_BLOCK_TEXT[hard.reason] : null,
  };
}

/** The records a portal login speaks for: its own contact record, or the primary details of accounts it owns. */
export async function portalPeople(portalUserId: string) {
  const u = await prisma.portalUser.findUniqueOrThrow({
    where: { id: portalUserId },
    select: { email: true, phoneNormalized: true, contactId: true, contact: { select: { clientId: true } }, access: { where: { revokedAt: null, client: { archivedAt: null } }, select: { clientId: true, role: true } } },
  });
  const targets: Person[] = [];
  for (const a of u.access) {
    if (u.contactId && u.contact?.clientId === a.clientId) targets.push({ clientId: a.clientId, contactId: u.contactId });
    else if (a.role === "OWNER") targets.push({ clientId: a.clientId, contactId: null });
  }
  return { targets: uniquePeople(targets), emails: [u.email], phones: u.phoneNormalized ? [u.phoneNormalized] : [] };
}

// --- Changing preferences ------------------------------------------------------

export type PreferenceChanges = { promoEmail?: boolean; promoSms?: boolean; generalUpdates?: boolean };

/**
 * Saves the choices and writes them through to the consent ledger and
 * suppression list in one transaction, with a history row per affected
 * person. Opting out applies to everyone using the same email address or
 * number (it's the same inbox or phone). Only real changes are recorded.
 */
export async function setCommunicationPreferences(input: {
  targets: Person[];
  emails?: string[];
  phones?: string[];
  changes: PreferenceChanges;
  source: PrefSource;
  portalUserId?: string | null;
  actorId?: string | null;
  note?: string | null;
}): Promise<{ changed: CommPrefCategory[] }> {
  const label = SOURCE_TEXT[input.source];
  const note = input.note?.trim().slice(0, 500) || null;
  return prisma.$transaction(async (tx) => {
    const people = await resolvePeople(tx, input.targets);
    const before = await preferenceState(input.targets, { emails: input.emails, phones: input.phones }, tx);
    const { emails, phones } = before;
    const changed: CommPrefCategory[] = [];
    const history: Prisma.CommunicationPreferenceChangeCreateManyInput[] = [];
    const record = (category: CommPrefCategory, subscribed: boolean, affected: Person[], address: string | null) => {
      changed.push(category);
      for (const p of uniquePeople(affected)) {
        history.push({ clientId: p.clientId, contactId: p.contactId, category, subscribed, source: input.source, address, portalUserId: input.portalUserId ?? null, actorId: input.actorId ?? null, note });
      }
    };
    const sharing = async () => {
      const lists = await Promise.all([...emails.map((e) => peopleWithEmail(tx, e)), ...phones.map((p) => peopleWithPhone(tx, p))]);
      return uniquePeople([...people, ...lists.flat()]);
    };

    const c = input.changes;
    if (c.promoEmail === true && !before.promoEmail) {
      if (!emails.length) throw new ValidationError("Add an email address first.");
      if (before.emailBlocked) throw new ValidationError(`We can't send promotional email to this address (${before.emailBlocked.toLowerCase()}). Please call our office.`);
      await tx.suppression.updateMany({ where: { channel: "EMAIL", addressNormalized: { in: emails }, reason: "UNSUBSCRIBE", liftedAt: null }, data: { liftedAt: new Date(), note: `Re-subscribed (${label})` } });
      for (const p of people) {
        await tx.consentRecord.create({ data: { clientId: p.clientId, contactId: p.contactId, kind: "EMAIL_MARKETING", status: "GRANTED", scope: "Promotional email: flyers, newsletters, offers and announcements", source: label, evidenceNote: note, recordedById: input.actorId ?? null } });
      }
      record("PROMO_EMAIL", true, people, emails.join(", "));
    } else if (c.promoEmail === false && (before.any.promoEmail || !(await allUnsubscribed(tx, emails)))) {
      let added = 0;
      for (const e of emails) {
        if (!(await tx.suppression.count({ where: { channel: "EMAIL", addressNormalized: e, reason: "UNSUBSCRIBE", liftedAt: null } }))) {
          await tx.suppression.create({ data: { channel: "EMAIL", addressNormalized: e, reason: "UNSUBSCRIBE", note: label, createdById: input.actorId ?? null } });
          added++;
        }
      }
      const affected = uniquePeople([...people, ...(await Promise.all(emails.map((e) => peopleWithEmail(tx, e)))).flat()]);
      for (const p of affected) {
        await tx.consentRecord.create({ data: { clientId: p.clientId, contactId: p.contactId, kind: "EMAIL_MARKETING", status: "REVOKED", source: label, evidenceNote: note, recordedById: input.actorId ?? null } });
      }
      if (before.any.promoEmail || added) record("PROMO_EMAIL", false, affected, emails.join(", ") || null);
    }

    if (c.promoSms === true && !before.promoSms) {
      if (!phones.length) throw new ValidationError("Add your mobile number first.");
      if (before.smsBlocked) {
        throw new ValidationError(input.source === "STAFF"
          ? "This number replied STOP, so every text to it is blocked. Only the client can lift it, by replying START."
          : "Texts to your number are blocked because you replied STOP. Reply START to any text from us to resume, then turn this on.");
      }
      for (const phone of phones) {
        if ((await currentSmsConsent(tx, phone, "MARKETING")) === "GRANTED") continue;
        await applySmsConsent(tx, phone, "MARKETING", "GRANTED", { source: input.source === "STAFF" ? "STAFF" : "CLIENT_PORTAL", label, sourcePage: input.source === "PORTAL" ? "/client/account" : undefined, consentText: SMS_CONSENT_TEXT.MARKETING, actorId: input.actorId ?? null, note: note ?? undefined });
      }
      record("PROMO_SMS", true, uniquePeople([...people, ...(await Promise.all(phones.map((p) => peopleWithPhone(tx, p)))).flat()]), phones.join(", "));
    } else if (c.promoSms === false && before.any.promoSms) {
      for (const phone of phones) {
        if ((await currentSmsConsent(tx, phone, "MARKETING")) !== "GRANTED") continue;
        await applySmsConsent(tx, phone, "MARKETING", "REVOKED", { source: input.source === "STAFF" ? "STAFF" : "CLIENT_PORTAL", label, actorId: input.actorId ?? null, note: note ?? undefined });
      }
      record("PROMO_SMS", false, uniquePeople([...people, ...(await Promise.all(phones.map((p) => peopleWithPhone(tx, p)))).flat()]), phones.join(", "));
    }

    if (c.generalUpdates !== undefined && (c.generalUpdates ? !before.generalUpdates : before.any.generalUpdates)) {
      const affected = await sharing();
      for (const p of affected) {
        await tx.communicationPreference.upsert({
          where: { clientId_personKey: { clientId: p.clientId, personKey: personKey(p) } },
          create: { clientId: p.clientId, contactId: p.contactId, personKey: personKey(p), generalUpdates: c.generalUpdates, updatedSource: input.source },
          update: { generalUpdates: c.generalUpdates, updatedSource: input.source },
        });
      }
      record("GENERAL_UPDATES", c.generalUpdates, affected, null);
    }

    if (history.length) {
      await tx.communicationPreferenceChange.createMany({ data: history });
      for (const clientId of new Set(history.map((h) => h.clientId))) {
        await tx.auditLog.create({ data: { actorId: input.actorId ?? null, action: "comm_prefs.updated", entityType: "Client", entityId: clientId, clientId, details: { source: input.source, changes: history.filter((h) => h.clientId === clientId).map((h) => `${h.category}:${h.subscribed ? "on" : "off"}`) } } });
      }
    }
    return { changed: Array.from(new Set(changed)) };
  });
}

async function allUnsubscribed(tx: Tx, emails: string[]) {
  for (const e of emails) if (!(await tx.suppression.count({ where: { channel: "EMAIL", addressNormalized: e, reason: "UNSUBSCRIBE", liftedAt: null } }))) return false;
  return true;
}

// --- Email unsubscribe links -----------------------------------------------------

export type UnsubscribeScope = "THIS" | "ALL";

/**
 * Applies an unsubscribe link (no sign-in). "THIS" stops the kind of email the
 * link came in (promotional, or general business updates); "ALL" stops every
 * non-essential email (both). Signature and age are checked first; nothing is
 * changed for an invalid or expired link.
 */
export async function unsubscribeWithToken(token: string, scope: UnsubscribeScope, source: "EMAIL_LINK" | "ONE_CLICK") {
  const check = readUnsubscribeToken(token);
  if (!check.ok) return check;
  const { clientId, contactId, email, kind } = check.payload;
  const exists = contactId
    ? await prisma.contact.count({ where: { id: contactId, clientId } })
    : await prisma.client.count({ where: { id: clientId } });
  const changes: PreferenceChanges = scope === "ALL" ? { promoEmail: false, generalUpdates: false } : kind === "GENERAL" ? { generalUpdates: false } : { promoEmail: false };
  await setCommunicationPreferences({ targets: exists ? [{ clientId, contactId }] : [], emails: [email], changes, source });
  return { ok: true as const, payload: check.payload };
}

/** Resend webhook: a hard bounce or spam complaint blocks the address. */
export async function recordEmailBlock(address: string, reason: "BOUNCE" | "COMPLAINT", note: string) {
  const email = normalizeEmail(address);
  if (!email) return;
  if (await prisma.suppression.count({ where: { channel: "EMAIL", addressNormalized: email, reason, liftedAt: null } })) return;
  await prisma.suppression.create({ data: { channel: "EMAIL", addressNormalized: email, reason, note: note.slice(0, 300) } });
}

// --- Staff view ------------------------------------------------------------------

export async function preferenceHistory(clientId: string, take = 50) {
  const rows = await prisma.communicationPreferenceChange.findMany({ where: { clientId }, orderBy: { createdAt: "desc" }, take });
  const actorIds = uniq(rows.map((r) => r.actorId));
  const contactIds = uniq(rows.map((r) => r.contactId));
  const [actors, contacts] = await Promise.all([
    actorIds.length ? prisma.user.findMany({ where: { id: { in: actorIds } }, select: { id: true, name: true } }) : [],
    contactIds.length ? prisma.contact.findMany({ where: { id: { in: contactIds } }, select: { id: true, name: true } }) : [],
  ]);
  return rows.map((r) => ({ ...r, actorName: actors.find((a) => a.id === r.actorId)?.name ?? null, contactName: contacts.find((c) => c.id === r.contactId)?.name ?? null }));
}
