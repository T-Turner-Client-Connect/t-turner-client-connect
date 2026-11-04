import "server-only";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { normalizePhone } from "@/lib/normalize";
import { SMS_HELP_REPLY, SMS_START_REPLY, SMS_STOP_REPLY } from "@/lib/business";
import { detectKeyword, recordStart, recordStop } from "./sms-consent";
import { blockNumber, TWILIO_UNSUBSCRIBED } from "@/lib/sms-block";
import { queueStaffAlert } from "./staff-alerts";
import { assertAdmin, type Actor } from "@/lib/auth/actor";
import { ValidationError } from "./clients";
import { payrollTextReply } from "./payroll-approval";

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
  // STOP blocks the number for every sender; START lifts the block and restores the
  // text permissions the person had before that STOP (Twilio lifts its block too).
  if (keyword === "STOP") await recordStop(from, inbound.id);
  if (keyword === "START") await recordStart(from, inbound.id);

  // Thread the text (keywords included, so the history is complete) into the client's
  // conversation when exactly one client uses this number; otherwise staff match it
  // from the unmatched list in Settings.
  const [clients, contacts] = await Promise.all([
    prisma.client.findMany({ where: { phoneNormalized: from, archivedAt: null }, select: { id: true } }),
    prisma.contact.findMany({ where: { phoneNormalized: from, client: { archivedAt: null } }, select: { clientId: true } }),
  ]);
  const ids = Array.from(new Set([...clients.map((c) => c.id), ...contacts.map((c) => c.clientId)]));
  if (ids.length === 1) {
    const convoId = await threadInbound(inbound, ids[0], null);
    if (keyword !== "STOP" && keyword !== "START") await queueStaffAlert({ conversationId: convoId });
  }
  if (keyword === "STOP") return { reply: appReplies ? SMS_STOP_REPLY : null };
  if (keyword === "START") return { reply: appReplies ? SMS_START_REPLY : null };
  if (keyword === "HELP") return { reply: appReplies ? SMS_HELP_REPLY : null };
  // "APPROVE"/"DENY" replies never approve payroll: an approver gets a fresh secure link instead.
  if (!keyword) {
    const payroll = await payrollTextReply(from, body);
    if (payroll) return { reply: payroll };
  }
  return { reply: null };
}

const KEYWORD_NOTE = {
  STOP: "The client replied STOP. Every text to this number is now blocked (appointment, billing, security and promotional), and promotional texts are turned off in their Communication Preferences. Use email or the portal for essential notices. Texts resume only if they reply START.",
  START: "The client replied START. The text block is lifted and the text permissions they had before replying STOP are restored.",
  HELP: "The client replied HELP and received the help message. They may need a call back.",
} as const;

type InboundRow = { id: string; providerSid: string; body: string; keyword: string | null; receivedAt: Date };

/** Saves one incoming text into the client's text conversation (plus a staff-only note for STOP/START/HELP). */
async function threadInbound(inbound: InboundRow, clientId: string, actorId: string | null) {
  return prisma.$transaction(async (tx) => {
    // Claim the text first, so two staff members can't attach it twice.
    const claimed = await tx.inboundSms.updateMany({ where: { id: inbound.id, matchedClientId: null }, data: { matchedClientId: clientId } });
    if (!claimed.count) throw new ValidationError("That text is already attached to a client.");
    const convo =
      (await tx.conversation.findFirst({ where: { clientId, closedAt: null, messages: { some: { channel: "SMS" } } }, orderBy: { lastMessageAt: "desc" } })) ??
      (await tx.conversation.create({ data: { clientId, subject: "Text messages" } }));
    const needsReply = inbound.keyword !== "STOP" && inbound.keyword !== "START";
    await tx.message.create({ data: { conversationId: convo.id, channel: "SMS", direction: "INBOUND", body: inbound.body, status: "DELIVERED", providerId: inbound.providerSid, readByClientAt: new Date(), createdAt: inbound.receivedAt } });
    const note = inbound.keyword ? KEYWORD_NOTE[inbound.keyword as keyof typeof KEYWORD_NOTE] : undefined;
    if (note) await tx.message.create({ data: { conversationId: convo.id, channel: "INTERNAL_NOTE", direction: "OUTBOUND", body: note, status: "DELIVERED" } });
    await tx.conversation.update({ where: { id: convo.id }, data: { lastMessageAt: new Date(), unreadByStaff: true, closedAt: null, ...(needsReply ? { awaitingStaff: true } : {}) } });
    await tx.inboundSms.update({ where: { id: inbound.id }, data: { conversationId: convo.id } });
    await tx.auditLog.create({ data: { actorId, action: actorId ? "message.sms_matched_by_staff" : "message.received", entityType: "InboundSms", entityId: inbound.id, clientId, details: { channel: "SMS", keyword: inbound.keyword } } });
    return convo.id;
  });
}

/**
 * Admin: attach an unmatched incoming text to a client's conversation. The text stays
 * exactly as received; the client's phone number on file is not changed.
 */
export async function attachInboundToClient(actor: Actor, inboundId: string, clientId: string) {
  assertAdmin(actor);
  const inbound = await prisma.inboundSms.findUnique({ where: { id: inboundId } });
  if (!inbound) throw new ValidationError("Text not found.");
  if (inbound.matchedClientId) throw new ValidationError("That text is already attached to a client.");
  const client = await prisma.client.findUnique({ where: { id: clientId }, select: { archivedAt: true } });
  if (!client || client.archivedAt) throw new ValidationError("Choose an active client.");
  return threadInbound(inbound, clientId, actor.id);
}

const FAILED = new Set(["failed", "undelivered"]);
// Twilio's callbacks can arrive out of order; a final status is never replaced by an earlier one.
const FINAL = ["delivered", "undelivered", "failed", "read"];
const notFinal = { OR: [{ deliveryStatus: null }, { deliveryStatus: { notIn: FINAL } }] };

/** Delivery-status callback: updates the notice/message with Twilio's result. */
export async function handleStatusCallback(params: Record<string, string>) {
  const sid = params.MessageSid || params.SmsSid;
  const status = (params.MessageStatus || params.SmsStatus || "").toLowerCase();
  if (!sid || !status) return;
  const detail = params.ErrorCode ? `Twilio ${status} (error ${params.ErrorCode})` : `Twilio ${status}`;
  // 21610 can also arrive here (Messaging Service sends): the recipient opted out — block the number.
  const to = normalizePhone(params.To);
  if (Number(params.ErrorCode) === TWILIO_UNSUBSCRIBED && to) await blockNumber(prisma, to, `Twilio error 21610 on ${sid}`);
  const early = !FINAL.includes(status);
  await prisma.notification.updateMany({
    where: { providerSid: sid, ...(early ? notFinal : {}) },
    data: { deliveryStatus: status, statusDetail: detail, ...(FAILED.has(status) ? { status: "FAILED" } : {}) },
  });
  await prisma.staffAlert.updateMany({
    where: { providerSid: sid, ...(early ? notFinal : {}) },
    data: { deliveryStatus: status, statusDetail: detail, ...(FAILED.has(status) ? { status: "FAILED" } : {}) },
  });
  await prisma.appointmentNotice.updateMany({
    where: { providerSid: sid, ...(early ? notFinal : {}) },
    data: { deliveryStatus: status, statusDetail: detail, ...(FAILED.has(status) ? { status: "FAILED" } : {}) },
  });
  await prisma.message.updateMany({
    where: { providerId: sid },
    data: status === "delivered" ? { status: "DELIVERED", errorDetail: null } : FAILED.has(status) ? { status: "FAILED", errorDetail: detail } : {},
  });
}
