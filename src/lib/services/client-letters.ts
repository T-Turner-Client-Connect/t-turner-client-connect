import "server-only";
import type { ClientLetter } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { audit } from "@/lib/audit";
import type { Actor } from "@/lib/auth/actor";
import { assertOwner, ownerAudit } from "@/lib/auth/owner";
import { brandedEmailHtml, sendEmail } from "@/lib/email";
import { appUrl } from "@/lib/integrations";
import { normalizeEmail } from "@/lib/normalize";
import { buildLetterPdf } from "@/lib/client-letters/pdf";
import { CURRENT_LETTER, letterDateText, letterTemplate, officeDay, type LetterFields } from "@/lib/client-letters/templates";
import { ValidationError } from "./clients";
import { BOOKKEEPING_LIST_WHERE } from "./bookkeeping-clients";
import { canSend } from "./comm-prefs";
import { readDocumentBytes, staffUploadDocument } from "./documents";
import { staffSendMessage } from "./messaging";
import { ownerAndBusiness } from "./related-businesses";

/**
 * Owner's Office → Client Letters. Tabitha prepares an approved, versioned letter
 * (src/lib/client-letters/templates.ts) for every client on the Bookkeeping list, reviews and
 * excludes, then sends. For each included client, sending:
 *   (a) emails the owner a short essential account notice with a secure sign-in link (account
 *       email never carries documents, so the PDF is not attached);
 *   (b) posts the letter, with the PDF attached, to the client's portal Message Center when the
 *       client has a portal login;
 *   (c) files the PDF in the client's Document Vault (Other, published, malware-scanned like
 *       every stored document);
 *   (d) records the status (SENT, EMAIL_FAILED, NO_EMAIL; later MAILED_MANUALLY), timestamps,
 *       the template version and the filed document id.
 * Every step is audit-logged. Nothing is ever sent twice automatically: a batch sends once, a
 * client who already received this version is left out of a new batch, and a re-send is an
 * explicit owner action that makes a new row and a new filed copy.
 */

export const LETTER_STATUS = {
  DRAFT: "Ready to send",
  SENDING: "Sending…",
  SENT: "Sent",
  EMAIL_FAILED: "Email failed",
  NO_EMAIL: "No email: mail or hand deliver",
  MAILED_MANUALLY: "Mailed / handed",
  FAILED: "Not sent",
} as const;
export type LetterStatus = keyof typeof LETTER_STATUS;
/** Statuses that mean the client has the letter (or it is on its way by hand). */
const DELIVERED: LetterStatus[] = ["SENT", "EMAIL_FAILED", "NO_EMAIL", "MAILED_MANUALLY"];

export const SEND_CONFIRM_WORD = "SEND";

// --- Recipients ---------------------------------------------------------------------------------

export type Recipient = {
  clientId: string;
  businessName: string;
  ownerName: string;
  ownerFirstName: string;
  email: string | null;
  portalUserId: string | null;
  hasPortal: boolean;
  /** No person's name on file: addressed to the business ("Dear Garden Path LLC,"). */
  noOwnerName: boolean;
};

const usable = (e: string | null | undefined) => {
  const n = normalizeEmail(e ?? "");
  return n && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(n) ? n : null;
};
const firstWord = (s: string) => s.trim().split(/\s+/)[0] ?? "";

/**
 * Business name, the owner (the earliest active OWNER portal login, else the primary contact,
 * else the name on the record), the owner's name and first name, and a usable email address.
 */
export async function resolveRecipient(clientId: string): Promise<Recipient> {
  const c = await prisma.client.findUniqueOrThrow({
    where: { id: clientId },
    select: {
      id: true, displayName: true, businessName: true, firstName: true, lastName: true, preferredName: true, email: true, clientType: true,
      contacts: { orderBy: { createdAt: "asc" }, take: 1, select: { name: true, preferredName: true, email: true } },
    },
  });
  const login = await prisma.portalAccess.findFirst({
    where: { clientId, revokedAt: null, role: "OWNER", portalUser: { active: true } },
    orderBy: { createdAt: "asc" },
    select: { portalUser: { select: { id: true, name: true, email: true, contact: { select: { name: true, preferredName: true } } } } },
  });
  const anyLogin = login ?? (await prisma.portalAccess.findFirst({ where: { clientId, revokedAt: null, portalUser: { active: true } }, select: { portalUser: { select: { id: true } } } }));
  const contact = c.contacts[0] ?? null;
  const onRecord = [c.firstName, c.lastName].filter(Boolean).join(" ").trim();
  const names = c.clientType === "INDIVIDUAL" ? null : await ownerAndBusiness(clientId);
  const businessName = (c.businessName || c.displayName).trim();
  const person = (login?.portalUser.contact?.name || login?.portalUser.name || contact?.name || names?.owner || onRecord || "").trim();
  const preferred = login?.portalUser.contact?.preferredName || (login ? null : contact?.preferredName) || (c.clientType === "INDIVIDUAL" ? c.preferredName : null);
  // No person's name on file: the letter is addressed to the business itself (flagged on the page).
  const noPerson = !person || (c.clientType !== "INDIVIDUAL" && person.toLowerCase() === businessName.toLowerCase());
  const ownerName = noPerson ? businessName : person;
  return {
    clientId,
    businessName,
    ownerName,
    ownerFirstName: noPerson ? businessName : (preferred?.trim() || firstWord(ownerName) || ownerName).trim(),
    noOwnerName: noPerson,
    email: usable(login?.portalUser.email) ?? usable(contact?.email) ?? usable(c.email),
    portalUserId: login?.portalUser.id ?? null,
    hasPortal: !!anyLogin,
  };
}

/** Every active client on the Bookkeeping list (the same rule as the staff /bookkeeping page). */
export async function letterRecipients(): Promise<Recipient[]> {
  const profiles = await prisma.bookkeepingProfile.findMany({ where: BOOKKEEPING_LIST_WHERE, select: { clientId: true }, orderBy: { client: { displayName: "asc" } } });
  const out: Recipient[] = [];
  for (const p of profiles) out.push(await resolveRecipient(p.clientId));
  return out.sort((a, b) => a.businessName.localeCompare(b.businessName));
}

// --- Prepare and review -------------------------------------------------------------------------

/** "Prepare letters for all bookkeeping clients": a DRAFT batch, one row per client. */
export async function prepareLetterBatch(actor: Actor, opts: { version?: string } = {}) {
  await assertOwner(actor);
  const t = opts.version ? letterTemplate(opts.version) : CURRENT_LETTER;
  if (await prisma.clientLetterBatch.count({ where: { status: { in: ["DRAFT", "SENDING"] } } })) throw new ValidationError("A batch is already prepared. Send it or discard it before preparing another.");
  const recipients = await letterRecipients();
  if (!recipients.length) throw new ValidationError("There are no active clients on the Bookkeeping list.");
  // Clients who already have this version are left out (never a duplicate by accident); Tabitha can include them.
  const already = await prisma.clientLetter.findMany({ where: { templateVersion: t.version, status: { in: DELIVERED }, clientId: { in: recipients.map((r) => r.clientId) } }, select: { clientId: true, sentAt: true }, orderBy: { sentAt: "desc" } });
  const sentTo = new Map<string, Date | null>();
  for (const a of already) if (!sentTo.has(a.clientId)) sentTo.set(a.clientId, a.sentAt);
  const now = new Date();
  const batch = await prisma.$transaction(async (tx) => {
    const b = await tx.clientLetterBatch.create({ data: { templateVersion: t.version, preparedById: actor.id } });
    await tx.clientLetter.createMany({
      data: recipients.map((r) => {
        const prior = sentTo.has(r.clientId);
        return {
          batchId: b.id, clientId: r.clientId, templateVersion: t.version, businessName: r.businessName, ownerName: r.ownerName, ownerFirstName: r.ownerFirstName,
          email: r.email, portalUserId: r.portalUserId,
          excluded: prior, excludedReason: prior ? `Already sent${sentTo.get(r.clientId) ? ` ${letterDateText(officeDay(sentTo.get(r.clientId)!))}` : ""}` : null, excludedAt: prior ? now : null, excludedById: prior ? actor.id : null,
        };
      }),
    });
    return b;
  });
  await ownerAudit(actor.id, "client_letters.prepared", "ClientLetterBatch", batch.id, { version: t.version, letters: recipients.length, noEmail: recipients.filter((r) => !r.email).length, alreadySent: sentTo.size });
  return batch;
}

async function draftLetter(letterId: string) {
  const l = await prisma.clientLetter.findUnique({ where: { id: letterId }, include: { batch: { select: { status: true } } } });
  if (!l) throw new ValidationError("Letter not found.");
  if (l.batch.status !== "DRAFT" || l.status !== "DRAFT") throw new ValidationError("This letter has already been sent; it can't be changed.");
  return l;
}

/** Exclude (or include again) one client before sending. */
export async function setLetterExcluded(actor: Actor, letterId: string, excluded: boolean, reason?: string) {
  await assertOwner(actor);
  const l = await draftLetter(letterId);
  await prisma.clientLetter.update({
    where: { id: l.id },
    data: excluded ? { excluded: true, excludedReason: reason?.trim().slice(0, 200) || "Excluded by the owner", excludedAt: new Date(), excludedById: actor.id } : { excluded: false, excludedReason: null, excludedAt: null, excludedById: null },
  });
  await ownerAudit(actor.id, excluded ? "client_letters.excluded" : "client_letters.included", "ClientLetter", l.id, { batchId: l.batchId, clientId: l.clientId });
}

/** Throws away a prepared batch that hasn't been sent (nothing was sent from it). */
export async function discardLetterBatch(actor: Actor, batchId: string) {
  await assertOwner(actor);
  await prisma.$transaction(async (tx) => {
    const b = await tx.clientLetterBatch.findUnique({ where: { id: batchId } });
    if (!b || b.status !== "DRAFT") throw new ValidationError("Only a prepared batch that hasn't been sent can be discarded.");
    await tx.clientLetter.deleteMany({ where: { batchId, status: "DRAFT" } });
    await tx.clientLetterBatch.delete({ where: { id: batchId } });
  });
  await ownerAudit(actor.id, "client_letters.discarded", "ClientLetterBatch", batchId);
}

// --- The letter itself --------------------------------------------------------------------------

const fieldsOf = (l: Pick<ClientLetter, "businessName" | "ownerName" | "ownerFirstName" | "letterDate">, day = officeDay()): LetterFields => ({
  date: letterDateText(l.letterDate ?? day),
  businessName: l.businessName,
  ownerName: l.ownerName,
  ownerFirstName: l.ownerFirstName,
});

export function letterFileName(l: Pick<ClientLetter, "businessName">) {
  return `Client letter - Bookkeeping portal and Coetha - ${l.businessName}`.replace(/[^\w.\- ()]/g, "_").slice(0, 140) + ".pdf";
}

/** The PDF for the owner's Preview: the filed copy once sent, else the letter as it will go out today. */
export async function letterPdf(actor: Actor, letterId: string): Promise<{ bytes: Uint8Array; name: string } | null> {
  await assertOwner(actor);
  const l = await prisma.clientLetter.findUnique({ where: { id: letterId } });
  if (!l) return null;
  if (l.documentId) {
    const doc = await prisma.document.findFirst({ where: { id: l.documentId, deletedAt: null }, include: { file: true } });
    const bytes = doc ? await readDocumentBytes(doc.file) : null;
    if (bytes) return { bytes, name: letterFileName(l) };
  }
  return { bytes: await buildLetterPdf(letterTemplate(l.templateVersion), fieldsOf(l), { letterId: l.id }), name: letterFileName(l) };
}

// --- Sending ------------------------------------------------------------------------------------

function emailBody(l: Pick<ClientLetter, "ownerFirstName" | "templateVersion">, hasPortal: boolean) {
  const t = letterTemplate(l.templateVersion);
  const where = hasPortal ? "It's in your client portal, in your Message Center and your Documents." : "It's saved in your client portal's Documents. If you haven't set up your portal account yet, use “Already a client? Activate your portal” on the sign-in page, or call us and we'll help.";
  const paragraphs = [
    `Dear ${l.ownerFirstName},`,
    "We've sent you a letter about your bookkeeping and TTurner Client Connect, your secure client portal.",
    where,
    "If you have any questions, please call us at 205-639-1000 or email info@tturnerassociates.com.",
  ];
  const url = `${appUrl()}/client`;
  return {
    subject: t.email.subject,
    text: `${paragraphs.join("\n\n")}\n\nSign in securely to read it: ${url}\n\nThe T. Turner & Associates Team`,
    html: brandedEmailHtml({ heading: t.email.heading, paragraphs, button: { label: "Sign in to read the letter", url }, note: "For your privacy we never attach documents to email. Sign in to read the letter securely." }),
  };
}

/**
 * Delivers one letter: file → portal message → email → status. The row is claimed first, so a
 * double click or a retried request never sends it twice.
 */
async function deliver(actor: Actor, letterId: string, now = new Date()): Promise<LetterStatus> {
  const claimed = await prisma.clientLetter.updateMany({ where: { id: letterId, status: "DRAFT", excluded: false }, data: { status: "SENDING" } });
  if (!claimed.count) throw new ValidationError("This letter isn't waiting to be sent.");
  const l = await prisma.clientLetter.findUniqueOrThrow({ where: { id: letterId } });
  const t = letterTemplate(l.templateVersion);
  const day = officeDay(now);
  // Recipient details as of today (an email added since the batch was prepared is used).
  const r = await resolveRecipient(l.clientId);
  let documentId: string | null = null;
  let messageId: string | null = null;
  try {
    const bytes = await buildLetterPdf(t, fieldsOf({ ...l, letterDate: day }, day), { letterId: l.id });
    const doc = await staffUploadDocument(actor, {
      clientId: l.clientId, category: "OTHER", title: t.documentTitle, year: day.getUTCFullYear(), month: day.getUTCMonth() + 1,
      visibility: "PUBLISHED", bytes, originalName: letterFileName(l), notify: false,
    });
    documentId = doc.id;
    await audit(prisma, { actorId: actor.id, action: "client_letter.filed", entityType: "ClientLetter", entityId: l.id, clientId: l.clientId, details: { documentId, version: t.version } });
    if (r.hasPortal) {
      const m = await staffSendMessage(actor, {
        clientId: l.clientId, channel: "PORTAL", subject: t.reLine.replace(/^Re:\s*/, ""), attachmentIds: [doc.id], idempotencyKey: `client-letter:${l.id}:portal`,
        body: `Dear ${l.ownerFirstName},\n\nPlease see the attached letter about your bookkeeping and your client portal. A copy is also saved in your Documents.\n\nThe T. Turner & Associates Team`,
      });
      messageId = m.id;
      await audit(prisma, { actorId: actor.id, action: "client_letter.portal_posted", entityType: "ClientLetter", entityId: l.id, clientId: l.clientId, details: { messageId } });
    }
  } catch (err) {
    const detail = err instanceof ValidationError ? err.message : "Unexpected error";
    await prisma.clientLetter.update({ where: { id: l.id }, data: { status: "FAILED", letterDate: day, sentAt: now, sentById: actor.id, documentId, messageId, emailError: `Not sent: ${detail}`.slice(0, 300) } });
    await audit(prisma, { actorId: actor.id, action: "client_letter.failed", entityType: "ClientLetter", entityId: l.id, clientId: l.clientId, details: { detail: detail.slice(0, 200), documentId } });
    return "FAILED";
  }

  let status: LetterStatus;
  let emailError: string | null = null;
  let emailProviderId: string | null = null;
  let emailedAt: Date | null = null;
  const email = r.email ?? l.email;
  if (!email) {
    status = "NO_EMAIL";
  } else {
    // An essential account notice: honors bounces, complaints and do-not-contact, never marketing opt-outs.
    const allowed = await canSend({ channel: "EMAIL", address: email, category: "ESSENTIAL" });
    if (!allowed.ok) {
      status = "EMAIL_FAILED";
      emailError = `Not emailed: ${allowed.reason}`;
    } else {
      const e = emailBody(l, r.hasPortal);
      const res = await sendEmail({ to: email, subject: e.subject, text: e.text, html: e.html, idempotencyKey: `client-letter:${l.id}`, tags: { category: "client_letter", version: t.version.replace(/[^\w-]/g, "_") } });
      if (res.ok) {
        status = "SENT";
        emailProviderId = res.providerId;
        emailedAt = new Date();
      } else {
        status = "EMAIL_FAILED";
        emailError = res.detail.slice(0, 300);
      }
    }
  }
  await prisma.clientLetter.update({ where: { id: l.id }, data: { status, letterDate: day, sentAt: now, sentById: actor.id, email, emailedAt, emailProviderId, emailError, documentId, messageId } });
  await audit(prisma, { actorId: actor.id, action: "client_letter.sent", entityType: "ClientLetter", entityId: l.id, clientId: l.clientId, details: { status, version: t.version, documentId, messageId, emailed: !!emailedAt, emailError } });
  return status;
}

/** Owner only, with the typed confirmation: sends every included letter in a prepared batch once. */
export async function sendLetterBatch(actor: Actor, batchId: string, confirm: string, now = new Date()) {
  await assertOwner(actor);
  if (confirm.trim().toUpperCase() !== SEND_CONFIRM_WORD) throw new ValidationError(`Type ${SEND_CONFIRM_WORD} to confirm.`);
  const claimed = await prisma.clientLetterBatch.updateMany({ where: { id: batchId, status: "DRAFT" }, data: { status: "SENDING" } });
  if (!claimed.count) throw new ValidationError("This batch was already sent.");
  const letters = await prisma.clientLetter.findMany({ where: { batchId, status: "DRAFT", excluded: false }, orderBy: { businessName: "asc" }, select: { id: true } });
  await ownerAudit(actor.id, "client_letters.send_started", "ClientLetterBatch", batchId, { letters: letters.length });
  const counts: Record<string, number> = {};
  for (const l of letters) {
    const s = await deliver(actor, l.id, now);
    counts[s] = (counts[s] ?? 0) + 1;
  }
  await prisma.clientLetterBatch.update({ where: { id: batchId }, data: { status: "SENT", sentAt: now, sentById: actor.id } });
  await ownerAudit(actor.id, "client_letters.sent", "ClientLetterBatch", batchId, counts);
  return counts;
}

/** Re-send to one client: owner only, explicit. A new row and a new filed copy; the old row stays. */
export async function resendLetter(actor: Actor, letterId: string, confirm: string, now = new Date()) {
  await assertOwner(actor);
  if (confirm.trim().toUpperCase() !== SEND_CONFIRM_WORD) throw new ValidationError(`Type ${SEND_CONFIRM_WORD} to confirm.`);
  const prior = await prisma.clientLetter.findUnique({ where: { id: letterId }, include: { batch: { select: { status: true } } } });
  if (!prior) throw new ValidationError("Letter not found.");
  if (prior.batch.status !== "SENT" || prior.status === "DRAFT" || prior.status === "SENDING") throw new ValidationError("Only a letter from a sent batch can be sent again.");
  const r = await resolveRecipient(prior.clientId);
  const row = await prisma.clientLetter.create({
    data: { batchId: prior.batchId, clientId: prior.clientId, templateVersion: prior.templateVersion, businessName: r.businessName, ownerName: r.ownerName, ownerFirstName: r.ownerFirstName, email: r.email, portalUserId: r.portalUserId, resendOfId: prior.id },
  });
  await ownerAudit(actor.id, "client_letters.resend", "ClientLetter", row.id, { resendOf: prior.id, clientId: prior.clientId });
  const status = await deliver(actor, row.id, now);
  return { letterId: row.id, status };
}

/** A NO_EMAIL (or failed-email) letter Tabitha mailed or handed over herself. */
export async function markLetterMailed(actor: Actor, letterId: string, on: string) {
  await assertOwner(actor);
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(on ?? "");
  const day = m ? new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))) : null;
  if (!day || Number.isNaN(day.getTime())) throw new ValidationError("Enter the date it was mailed or handed over.");
  const r = await prisma.clientLetter.updateMany({ where: { id: letterId, status: { in: ["NO_EMAIL", "EMAIL_FAILED"] } }, data: { status: "MAILED_MANUALLY", mailedOn: day, mailedById: actor.id, mailedRecordedAt: new Date() } });
  if (!r.count) throw new ValidationError("Only a letter that wasn't emailed can be marked as mailed or handed over.");
  const l = await prisma.clientLetter.findUniqueOrThrow({ where: { id: letterId }, select: { clientId: true } });
  await audit(prisma, { actorId: actor.id, action: "client_letter.mailed", entityType: "ClientLetter", entityId: letterId, clientId: l.clientId, details: { on } });
}

// --- Page data ----------------------------------------------------------------------------------

export async function clientLettersView(actor: Actor, opts: { clientId?: string | null } = {}) {
  await assertOwner(actor);
  const batches = await prisma.clientLetterBatch.findMany({
    orderBy: { createdAt: "desc" },
    take: 20,
    include: { letters: { orderBy: [{ businessName: "asc" }, { createdAt: "asc" }], include: { client: { select: { id: true, displayName: true } } } } },
  });
  const hasPortal = new Set(
    (await prisma.portalAccess.findMany({ where: { revokedAt: null, portalUser: { active: true }, clientId: { in: [...new Set(batches.flatMap((b) => b.letters.map((l) => l.clientId)))] } }, select: { clientId: true } })).map((a) => a.clientId),
  );
  const people = await prisma.user.findMany({ where: { id: { in: [...new Set(batches.flatMap((b) => [b.preparedById, b.sentById]).filter((x): x is string => !!x))] } }, select: { id: true, name: true } });
  const nameOf = new Map(people.map((p) => [p.id, p.name]));
  const clientRecord = opts.clientId
    ? await prisma.clientLetter.findMany({ where: { clientId: opts.clientId }, orderBy: { createdAt: "desc" }, include: { client: { select: { displayName: true } } } })
    : null;
  return {
    current: CURRENT_LETTER,
    draft: batches.find((b) => b.status === "DRAFT" || b.status === "SENDING") ?? null,
    history: batches.filter((b) => b.status === "SENT"),
    hasPortal,
    nameOf,
    clientRecord,
  };
}
