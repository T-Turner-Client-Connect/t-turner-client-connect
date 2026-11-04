import "server-only";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";

type Db = Prisma.TransactionClient | typeof prisma;

/**
 * Number-level text block. A STOP reply (or Twilio error 21610, "unsubscribed
 * recipient") puts the number here, and Twilio/the carriers then refuse every
 * text to it — service, appointment, billing, security and marketing alike —
 * until the person replies START. Every SMS sender checks this before sending
 * (sendSms itself refuses blocked numbers as a backstop). Email and the portal
 * stay available for essential notices.
 */
export async function smsBlock(db: Db, phone: string) {
  return db.suppression.findFirst({ where: { channel: "SMS", addressNormalized: phone, liftedAt: null }, orderBy: { createdAt: "desc" } });
}

export const SMS_BLOCKED_TEXT = "Texts to this number are blocked because the person replied STOP. They can reply START to resume; email and the portal still work.";

export async function blockNumber(db: Db, phone: string, note: string) {
  if (await smsBlock(db, phone)) return null;
  return db.suppression.create({ data: { channel: "SMS", addressNormalized: phone, reason: "STOP", note: note.slice(0, 300) } });
}

/** Twilio error 21610: the recipient has opted out (replied STOP) at Twilio/carrier level. */
export const TWILIO_UNSUBSCRIBED = 21610;
