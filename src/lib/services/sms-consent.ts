import "server-only";
import type { Prisma, SmsConsentCategory } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { normalizePhone } from "@/lib/normalize";
import { sign } from "@/lib/crypto";
import { SMS_CONSENT_TEXT, SMS_CONSENT_VERSION } from "@/lib/business";
import { ValidationError } from "./clients";

type Tx = Prisma.TransactionClient;
type Db = Tx | typeof prisma;

const KIND = { SERVICE: "SMS_SERVICE", MARKETING: "SMS_MARKETING" } as const;

/** Latest ledger state for one phone + category. */
export async function currentSmsConsent(db: Db, phone: string, category: SmsConsentCategory) {
  const last = await db.smsConsentEvent.findFirst({ where: { phoneNormalized: phone, category }, orderBy: { createdAt: "desc" } });
  return last?.status ?? "UNKNOWN";
}

export async function activeStop(db: Db, phone: string) {
  return db.suppression.findFirst({ where: { channel: "SMS", addressNormalized: phone, liftedAt: null } });
}

/**
 * The server-side gate for every text: the number must have a current
 * opt-in for this category and no active opt-out.
 */
export async function smsSendAllowed(phone: string, category: SmsConsentCategory): Promise<{ ok: boolean; reason?: string }> {
  if (await activeStop(prisma, phone)) return { ok: false, reason: "Number has opted out (STOP)" };
  const status = await currentSmsConsent(prisma, phone, category);
  if (status !== "GRANTED") return { ok: false, reason: `No ${category === "SERVICE" ? "service" : "marketing"} text consent on file` };
  return { ok: true };
}

/** People (client primary phone or additional contacts) using this number. */
async function peopleWithPhone(db: Db, phone: string) {
  const [clients, contacts] = await Promise.all([
    db.client.findMany({ where: { phoneNormalized: phone }, select: { id: true } }),
    db.contact.findMany({ where: { phoneNormalized: phone }, select: { id: true, clientId: true } }),
  ]);
  return [...clients.map((c) => ({ clientId: c.id, contactId: null as string | null })), ...contacts.map((c) => ({ clientId: c.clientId, contactId: c.id as string | null }))];
}

type ChangeMeta = { source: string; sourcePage?: string; consentText?: string; submissionId?: string; inboundSmsId?: string; actorId?: string | null; note?: string };

/**
 * Records a consent change in the phone ledger and mirrors it onto any
 * matching client/contact records so it shows in the CRM. A new opt-in lifts
 * an earlier STOP for that number (the person has opted in again).
 */
export async function applySmsConsent(tx: Tx, phone: string, category: SmsConsentCategory, status: "GRANTED" | "REVOKED", meta: ChangeMeta) {
  await tx.smsConsentEvent.create({
    data: {
      phoneNormalized: phone,
      category,
      status,
      source: meta.source,
      sourcePage: meta.sourcePage ?? null,
      consentVersion: status === "GRANTED" ? SMS_CONSENT_VERSION : null,
      consentText: meta.consentText ?? null,
      submissionId: meta.submissionId ?? null,
      inboundSmsId: meta.inboundSmsId ?? null,
      actorId: meta.actorId ?? null,
    },
  });
  if (status === "GRANTED") {
    const stop = await activeStop(tx, phone);
    if (stop) {
      await tx.suppression.update({ where: { id: stop.id }, data: { liftedAt: new Date(), note: `Lifted by new opt-in (${meta.source}${meta.submissionId ? ` ${meta.submissionId}` : ""})` } });
      await tx.auditLog.create({ data: { actorId: meta.actorId ?? null, action: "suppression.lifted_by_opt_in", entityType: "Suppression", entityId: stop.id, details: { source: meta.source } } });
    }
  }
  for (const p of await peopleWithPhone(tx, phone)) {
    await tx.consentRecord.create({
      data: {
        clientId: p.clientId,
        contactId: p.contactId,
        kind: KIND[category],
        status,
        scope: meta.consentText ?? null,
        source: meta.source === "WEB_FORM" ? "Website SMS consent form" : meta.source === "STOP_KEYWORD" ? "Replied STOP" : meta.source === "CLIENT_PORTAL" ? "Client portal account settings" : "Staff",
        evidenceNote: [meta.submissionId && `Submission ${meta.submissionId}`, status === "GRANTED" && `Wording ${SMS_CONSENT_VERSION}`, meta.note].filter(Boolean).join(" · ") || null,
        recordedById: meta.actorId ?? null,
      },
    });
    await tx.auditLog.create({
      data: { actorId: meta.actorId ?? null, action: "consent.sms_ledger", entityType: "Client", entityId: p.clientId, clientId: p.clientId, details: { category, status, source: meta.source } },
    });
  }
}

const WINDOW_MS = 15 * 60 * 1000;

export type ConsentFormInput = {
  name: string;
  phone: string;
  service: boolean;
  marketing: boolean;
  sourcePage: string;
  ip: string | null;
  userAgent: string | null;
  honeypot?: string;
};

/**
 * Saves a submission from the public consent page. Throws (and saves
 * nothing) on any problem so the page never shows success without a save.
 * Unchecked boxes withdraw an earlier opt-in for that category.
 */
export async function submitSmsConsent(input: ConsentFormInput) {
  if (input.honeypot) throw new ValidationError("We couldn't save your preferences. Please try again.");
  const name = input.name.trim().slice(0, 120);
  if (!name) throw new ValidationError("Enter your name.");
  const phone = normalizePhone(input.phone);
  if (!phone) throw new ValidationError("Enter a valid 10-digit US mobile number.");
  const ipHash = input.ip ? sign(`ip:${input.ip}`).slice(0, 32) : null;
  const since = new Date(Date.now() - WINDOW_MS);
  const [byIp, byPhone] = await Promise.all([
    ipHash ? prisma.smsConsentSubmission.count({ where: { ipHash, createdAt: { gte: since } } }) : 0,
    prisma.smsConsentSubmission.count({ where: { phoneNormalized: phone, createdAt: { gte: since } } }),
  ]);
  if (byIp >= 10 || byPhone >= 5) throw new ValidationError("Too many submissions. Please wait a few minutes and try again.");

  return prisma.$transaction(async (tx) => {
    const people = await peopleWithPhone(tx, phone);
    const submission = await tx.smsConsentSubmission.create({
      data: {
        name,
        phoneNormalized: phone,
        serviceOptIn: input.service,
        marketingOptIn: input.marketing,
        consentVersion: SMS_CONSENT_VERSION,
        serviceText: SMS_CONSENT_TEXT.SERVICE,
        marketingText: SMS_CONSENT_TEXT.MARKETING,
        sourcePage: input.sourcePage.slice(0, 200),
        ipHash,
        userAgent: input.userAgent?.slice(0, 300) ?? null,
        matchedClientIds: Array.from(new Set(people.map((p) => p.clientId))),
      },
    });
    for (const category of ["SERVICE", "MARKETING"] as const) {
      const chosen = category === "SERVICE" ? input.service : input.marketing;
      const current = await currentSmsConsent(tx, phone, category);
      const meta = { source: "WEB_FORM", sourcePage: input.sourcePage, consentText: SMS_CONSENT_TEXT[category], submissionId: submission.id };
      if (chosen) await applySmsConsent(tx, phone, category, "GRANTED", meta);
      else if (current === "GRANTED") await applySmsConsent(tx, phone, category, "REVOKED", { ...meta, consentText: undefined, note: "Unchecked on consent form" });
    }
    return submission;
  });
}

/** Opt-in/out from the client portal Account page (service messages only). */
export async function setPortalSmsConsent(portalUserId: string, phone: string | null, enabled: boolean) {
  if (!phone) return;
  const current = await currentSmsConsent(prisma, phone, "SERVICE");
  if (enabled && current === "GRANTED" && !(await activeStop(prisma, phone))) return;
  if (!enabled && current !== "GRANTED") return;
  await prisma.$transaction((tx) =>
    applySmsConsent(tx, phone, "SERVICE", enabled ? "GRANTED" : "REVOKED", {
      source: "CLIENT_PORTAL",
      sourcePage: "/client/account",
      consentText: enabled ? SMS_CONSENT_TEXT.SERVICE : undefined,
      note: `Portal user ${portalUserId}`,
    }),
  );
}

const STOP_WORDS = new Set(["STOP", "STOPALL", "UNSUBSCRIBE", "CANCEL", "END", "QUIT", "REVOKE", "OPTOUT"]);
const START_WORDS = new Set(["START", "UNSTOP"]);
const HELP_WORDS = new Set(["HELP", "INFO"]);

export function detectKeyword(body: string, optOutType?: string | null): "STOP" | "START" | "HELP" | null {
  const t = optOutType?.toUpperCase();
  if (t === "STOP" || t === "START" || t === "HELP") return t;
  const word = body.trim().toUpperCase().replace(/[^A-Z]/g, "");
  if (STOP_WORDS.has(word)) return "STOP";
  if (START_WORDS.has(word)) return "START";
  if (HELP_WORDS.has(word)) return "HELP";
  return null;
}

/** STOP: opt the number out of every text category and suppress it. */
export async function recordStop(phone: string, inboundSmsId: string) {
  await prisma.$transaction(async (tx) => {
    for (const category of ["SERVICE", "MARKETING"] as const) {
      if ((await currentSmsConsent(tx, phone, category)) === "GRANTED") {
        await applySmsConsent(tx, phone, category, "REVOKED", { source: "STOP_KEYWORD", inboundSmsId });
      } else {
        await tx.smsConsentEvent.create({ data: { phoneNormalized: phone, category, status: "REVOKED", source: "STOP_KEYWORD", inboundSmsId } });
      }
    }
    if (!(await activeStop(tx, phone))) {
      await tx.suppression.create({ data: { channel: "SMS", addressNormalized: phone, reason: "STOP", note: `Inbound ${inboundSmsId}` } });
    }
  });
}
