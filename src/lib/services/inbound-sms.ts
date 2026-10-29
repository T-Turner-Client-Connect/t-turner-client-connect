import "server-only";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { normalizePhone } from "@/lib/normalize";
import { SMS_HELP_REPLY, SMS_STOP_REPLY } from "@/lib/business";
import { detectKeyword, recordStop } from "./sms-consent";

/**
 * Handles one incoming text from Twilio (signature already verified).
 * Returns the reply text, or null to send no reply. By default Twilio's own
 * Advanced Opt-Out sends the STOP/HELP replies (SMS_KEYWORD_REPLIES=twilio);
 * set SMS_KEYWORD_REPLIES=app to have this app reply instead — never both.
 */
export async function handleInboundSms(params: Record<string, string>): Promise<{ reply: string | null; duplicate?: boolean }> {
  const sid = params.MessageSid || params.SmsSid;
  const from = normalizePhone(params.From);
  if (!sid || !from) return { reply: null };
  const body = (params.Body ?? "").slice(0, 2000);
  const keyword = detectKeyword(body, params.OptOutType);

  let inbound;
  try {
    inbound = await prisma.inboundSms.create({ data: { providerSid: sid, fromNormalized: from, toNumber: params.To ?? null, body, keyword } });
  } catch (err) {
    // Twilio retried a message we already processed.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") return { reply: null, duplicate: true };
    throw err;
  }

  const appReplies = process.env.SMS_KEYWORD_REPLIES === "app";
  if (keyword === "STOP") {
    await recordStop(from, inbound.id);
    return { reply: appReplies ? SMS_STOP_REPLY : null };
  }
  if (keyword === "HELP") return { reply: appReplies ? SMS_HELP_REPLY : null };
  if (keyword === "START") {
    // Twilio lifts its own block on START, but our Terms say texts resume only
    // after a new opt-in on the consent form, so consent is not re-granted here.
    return { reply: null };
  }

  // A normal reply: attach it to the client's conversation when exactly one
  // client uses this number; otherwise staff match it from the inbox log.
  const [clients, contacts] = await Promise.all([
    prisma.client.findMany({ where: { phoneNormalized: from, archivedAt: null }, select: { id: true } }),
    prisma.contact.findMany({ where: { phoneNormalized: from, client: { archivedAt: null } }, select: { clientId: true } }),
  ]);
  const ids = Array.from(new Set([...clients.map((c) => c.id), ...contacts.map((c) => c.clientId)]));
  if (ids.length === 1) {
    const clientId = ids[0];
    await prisma.$transaction(async (tx) => {
      const convo =
        (await tx.conversation.findFirst({ where: { clientId, closedAt: null, messages: { some: { channel: "SMS" } } }, orderBy: { lastMessageAt: "desc" } })) ??
        (await tx.conversation.create({ data: { clientId, subject: "Text messages" } }));
      await tx.message.create({ data: { conversationId: convo.id, channel: "SMS", direction: "INBOUND", body, status: "DELIVERED", providerId: sid, readByClientAt: new Date() } });
      await tx.conversation.update({ where: { id: convo.id }, data: { lastMessageAt: new Date(), awaitingStaff: true, unreadByStaff: true, closedAt: null } });
      await tx.inboundSms.update({ where: { id: inbound.id }, data: { matchedClientId: clientId, conversationId: convo.id } });
      await tx.auditLog.create({ data: { action: "message.received", entityType: "InboundSms", entityId: inbound.id, clientId, details: { channel: "SMS" } } });
    });
  }
  return { reply: null };
}

const FAILED = new Set(["failed", "undelivered"]);

/** Delivery-status callback: updates the notice/message with Twilio's result. */
export async function handleStatusCallback(params: Record<string, string>) {
  const sid = params.MessageSid || params.SmsSid;
  const status = (params.MessageStatus || params.SmsStatus || "").toLowerCase();
  if (!sid || !status) return;
  const detail = params.ErrorCode ? `Twilio ${status} (error ${params.ErrorCode})` : `Twilio ${status}`;
  await prisma.notification.updateMany({
    where: { providerSid: sid },
    data: { deliveryStatus: status, statusDetail: detail, ...(FAILED.has(status) ? { status: "FAILED" } : {}) },
  });
  await prisma.message.updateMany({
    where: { providerId: sid },
    data: status === "delivered" ? { status: "DELIVERED", errorDetail: null } : FAILED.has(status) ? { status: "FAILED", errorDetail: detail } : {},
  });
}
