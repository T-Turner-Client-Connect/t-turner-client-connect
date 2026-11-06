import "server-only";
import type { MessageChannel, Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { audit } from "@/lib/audit";
import type { Actor } from "@/lib/auth/actor";
import type { PortalActor } from "@/lib/portal/session";
import { conversationScope, requireClientAccess } from "@/lib/portal/access";
import { ineligibilityReason } from "@/lib/consent";
import { sendTransactionalEmail } from "@/lib/email";
import { clientTextingOn, queueStaffAlert } from "./staff-alerts";
import { smsSendAllowed } from "./sms-consent";
import { sendSms } from "@/lib/twilio";
import { integrationStatus } from "@/lib/integrations";
import { activeSuppressionsFor, ValidationError } from "./clients";
import { queuePortalNotification } from "./notifications";
import { clientMayReceive } from "./documents";

const MAX_BODY = 10_000;

export const SMS_MAX = 1000;
export const SMS_OPT_OUT_FOOTER = "Reply STOP to opt out, HELP for help.";

/** `textingOn` is Tabitha's Client texting switch (see clientTextingOn). */
export function channelAvailability(textingOn: boolean) {
  const i = integrationStatus();
  return {
    PORTAL: { available: true, note: "Private and secure. The client gets a sign-in notice." },
    EMAIL: { available: i.email && i.liveSendingFlag, note: i.email ? (i.liveSendingFlag ? "Sends a plain email. Don't include tax or account details." : "Live sending is turned off.") : "Setup required: email provider." },
    SMS: {
      available: i.twilio && textingOn,
      note: !i.twilio ? "Setup required: Twilio." : textingOn ? "Sends a text to the client's mobile. Only to numbers with text consent. Don't include tax or account details." : "Client texting is off. Tabitha can turn it on in Settings.",
    },
    INTERNAL_NOTE: { available: true, note: "Visible to staff only. Never shown to the client." },
  } satisfies Record<MessageChannel, { available: boolean; note: string }>;
}

/** "SMS" when the conversation holds texts, "PORTAL" when it holds portal or email messages, null when only notes. */
export async function conversationKind(conversationId: string): Promise<"SMS" | "PORTAL" | null> {
  const [sms, other] = await Promise.all([
    prisma.message.count({ where: { conversationId, channel: "SMS" } }),
    prisma.message.count({ where: { conversationId, channel: { in: ["PORTAL", "EMAIL"] } } }),
  ]);
  return sms ? "SMS" : other ? "PORTAL" : null;
}

async function existingByKey(key?: string | null) {
  return key ? prisma.message.findUnique({ where: { idempotencyKey: key } }) : null;
}

async function notifyMessage(clientId: string, messageId: string, privateTo: string | null = null) {
  // A reply in a business owner's private thread notifies that owner only.
  const grants = await prisma.portalAccess.findMany({ where: { clientId, revokedAt: null, canMessage: true, ...(privateTo ? { portalUserId: privateTo } : {}) } });
  // A portal message is never sent as a text: the client gets an email notice (no contents) only.
  for (const g of grants) await queuePortalNotification(g.portalUserId, "NEW_MESSAGE", `NEW_MESSAGE:${messageId}`, ["EMAIL"]);
}

/**
 * Staff → client. Portal messages are stored and the client is notified.
 * Email/SMS go through the provider only when configured and live sending
 * is on; status reflects what the provider actually said.
 */
export async function staffSendMessage(
  actor: Actor,
  input: { clientId: string; conversationId?: string | null; subject?: string; body: string; channel: MessageChannel; attachmentIds?: string[]; periodId?: string | null; idempotencyKey?: string },
) {
  let body = input.body.trim();
  if (!body) throw new ValidationError("Write a message first.");
  if (body.length > MAX_BODY) throw new ValidationError("That message is too long.");
  if (input.channel === "SMS" && body.length > SMS_MAX) throw new ValidationError(`Texts are limited to ${SMS_MAX} characters. Use the portal for longer messages.`);
  const dup = await existingByKey(input.idempotencyKey);
  if (dup) return dup;
  const client = await prisma.client.findUnique({ where: { id: input.clientId }, include: { consentRecords: true } });
  if (!client) throw new ValidationError("Client not found.");
  if (client.archivedAt) throw new ValidationError("Restore this client before messaging them.");

  let conversationId = input.conversationId ?? null;
  if (conversationId) {
    const convo = await prisma.conversation.findFirst({ where: { id: conversationId, clientId: input.clientId } });
    if (!convo) throw new ValidationError("Conversation not found.");
    // Portal conversations and text conversations stay separate.
    const kind = await conversationKind(conversationId);
    if (input.channel === "SMS" && kind === "PORTAL") throw new ValidationError("Texts go in the client's Text Messages (SMS) conversation, not a portal conversation.");
    if ((input.channel === "PORTAL" || input.channel === "EMAIL") && kind === "SMS") throw new ValidationError("This is a text (SMS) conversation. Start a new portal conversation for portal messages.");
  } else if (input.channel === "SMS") {
    // One running text thread per client, so replies always land in the same place.
    conversationId = (await prisma.conversation.findFirst({ where: { clientId: input.clientId, closedAt: null, messages: { some: { channel: "SMS" } } }, orderBy: { lastMessageAt: "desc" }, select: { id: true } }))?.id ?? null;
  }
  const attachmentIds = input.attachmentIds ?? [];
  if (attachmentIds.length) {
    const docs = await prisma.document.findMany({ where: { id: { in: attachmentIds }, clientId: input.clientId, deletedAt: null } });
    if (docs.length !== attachmentIds.length) throw new ValidationError("Attachments must be documents belonging to this client.");
    // An owner's K-1 opens only from their own K-1 section, never from a (possibly shared) message thread.
    if (docs.some((d) => d.category === "OWNER_K1")) throw new ValidationError("K-1s reach owners through their own K-1 section (Owners card → Upload K-1), not as message attachments.");
    // An owner's personal documents are private to that owner: never attached to a shared thread.
    if (docs.some((d) => d.category === "OWNER_PERSONAL")) throw new ValidationError("An owner's personal tax documents stay private to that owner and aren't sent as message attachments.");
    // A message can't carry a financial statement Tabitha hasn't approved (or an unscanned file) to the client.
    if (docs.some((d) => !clientMayReceive(d))) throw new ValidationError("Financial statements are sent only through Upload Monthly Financials → Tabitha's approval → Deliver, not as message attachments.");
    // Identity documents never go out in messages; financial reports only after Tabitha approves them.
    const blocked = await prisma.document.count({
      where: { id: { in: attachmentIds }, OR: [{ category: "IDENTITY" }, { category: "BOOKKEEPING", reportType: { not: null }, NOT: { reviewStatus: "APPROVED" } }] },
    });
    if (blocked) throw new ValidationError("That attachment can't be sent: identity documents never go in messages, and financial reports need Tabitha's approval first.");
    if (input.channel !== "PORTAL") throw new ValidationError("Attachments can only be sent through the secure portal.");
  }
  const isNote = input.channel === "INTERNAL_NOTE";

  if (input.channel === "EMAIL" || input.channel === "SMS") {
    const availability = channelAvailability(input.channel === "SMS" ? await clientTextingOn() : false)[input.channel];
    if (!availability.available) throw new ValidationError(availability.note);
    const address = input.channel === "EMAIL" ? client.emailNormalized : client.phoneNormalized;
    const suppressions = address ? (await activeSuppressionsFor([{ channel: input.channel, address }])).get(`${input.channel}:${address}`) ?? [] : [];
    const reason = ineligibilityReason({
      channel: input.channel,
      purpose: "SERVICE",
      address,
      archived: false,
      taxReturnDerived: client.taxReturnDerived,
      personConsents: client.consentRecords.filter((r) => r.contactId === null),
      clientConsents: client.consentRecords.filter((r) => r.contactId === null),
      suppressions,
    });
    if (reason) throw new ValidationError(`Can't send: ${reason}.`);
    if (input.channel === "SMS") {
      // The phone consent ledger (web form / portal opt-in, STOP) is the final word for texts.
      const gate = await smsSendAllowed(address!, "SERVICE");
      if (!gate.ok) throw new ValidationError(`Can't text this client: ${gate.reason}.`);
      // The first text to a number carries the opt-out instructions; the message is saved exactly as sent.
      const earlier = await prisma.message.count({ where: { channel: "SMS", direction: "OUTBOUND", status: { in: ["PROVIDER_ACCEPTED", "DELIVERED"] }, conversation: { clientId: input.clientId } } });
      if (!earlier && !/reply stop/i.test(body)) body = `${body}\n\n${SMS_OPT_OUT_FOOTER}`;
    }
  }

  const message = await prisma.$transaction(async (tx) => {
    if (!conversationId) {
      const convo = await tx.conversation.create({
        data: { clientId: input.clientId, subject: input.channel === "SMS" ? "Text messages" : input.subject?.trim().slice(0, 200) || "Message from T. Turner & Associates", assignedToId: actor.id, periodId: input.periodId ?? null },
      });
      conversationId = convo.id;
    }
    // Publish any attached documents so the client can open them.
    if (attachmentIds.length) {
      await tx.document.updateMany({ where: { id: { in: attachmentIds }, visibility: "STAFF_ONLY" }, data: { visibility: "PUBLISHED", publishedAt: new Date() } });
    }
    const m = await tx.message.create({
      data: {
        conversationId,
        channel: input.channel,
        direction: "OUTBOUND",
        body,
        subject: input.subject?.trim() || null,
        staffAuthorId: actor.id,
        status: input.channel === "PORTAL" || isNote ? "DELIVERED" : "QUEUED",
        idempotencyKey: input.idempotencyKey || null,
        attachments: attachmentIds.length ? { connect: attachmentIds.map((id) => ({ id })) } : undefined,
      },
    });
    // An internal note isn't a reply: it leaves "needs reply" as it was.
    await tx.conversation.update({
      where: { id: conversationId },
      data: isNote ? { unreadByStaff: false } : { lastMessageAt: new Date(), awaitingStaff: false, unreadByStaff: false, assignedToId: actor.id },
    });
    await audit(tx, { actorId: actor.id, action: "message.sent", entityType: "Message", entityId: m.id, clientId: input.clientId, details: { channel: input.channel, attachments: attachmentIds.length } });
    return m;
  });

  if (isNote) {
    // Staff-only: no notification, no provider.
  } else if (input.channel === "PORTAL") {
    const convo = await prisma.conversation.findUnique({ where: { id: message.conversationId }, select: { privateToPortalUserId: true } });
    await notifyMessage(input.clientId, message.id, convo?.privateToPortalUserId ?? null);
  } else if (input.channel === "EMAIL") {
    const ok = await sendTransactionalEmail(client.emailNormalized!, input.subject?.trim() || "A message from T. Turner & Associates", body);
    await prisma.message.update({ where: { id: message.id }, data: ok ? { status: "PROVIDER_ACCEPTED" } : { status: "FAILED", errorDetail: "Email provider rejected the message" } });
  } else {
    // Text: Twilio accepts it now; the delivery receipt (status webhook) later marks it Delivered or Failed.
    const r = await sendSms(client.phoneNormalized!, body).catch(() => ({ ok: false, sid: undefined, detail: "Couldn't reach Twilio" }));
    const updated = await prisma.message.update({
      where: { id: message.id },
      data: r.ok ? { status: "PROVIDER_ACCEPTED", providerId: r.sid ?? null, errorDetail: null } : { status: "FAILED", errorDetail: r.detail },
    });
    await audit(prisma, { actorId: actor.id, action: r.ok ? "message.sms_sent" : "message.sms_failed", entityType: "Message", entityId: message.id, clientId: input.clientId, details: { detail: r.detail } });
    return updated;
  }
  return message;
}

/** Client → staff, through the portal only. */
export async function portalSendMessage(
  user: PortalActor,
  input: { clientId: string; conversationId?: string | null; subject?: string; body: string; attachmentIds?: string[]; idempotencyKey?: string },
) {
  await requireClientAccess(user.id, input.clientId, "message");
  const body = input.body.trim();
  if (!body) throw new ValidationError("Write a message first.");
  if (body.length > MAX_BODY) throw new ValidationError("That message is too long.");
  const dup = await existingByKey(input.idempotencyKey);
  if (dup) return dup;
  if (input.conversationId && !(await prisma.conversation.count({ where: { id: input.conversationId, clientId: input.clientId, ...conversationScope(user.id) } }))) {
    throw new ValidationError("Conversation not found.");
  }
  // A business owner's new threads are private to them: other owners on the business don't see them.
  const isBusinessOwner = (await prisma.businessOwner.count({ where: { clientId: input.clientId, portalUserId: user.id, archivedAt: null } })) > 0;
  const attachmentIds = input.attachmentIds ?? [];
  if (attachmentIds.length) {
    // Only the client's own uploads for this account can be attached.
    const ok = await prisma.document.count({ where: { id: { in: attachmentIds }, clientId: input.clientId, uploadedByPortalId: user.id, category: { not: "IDENTITY" } } });
    if (ok !== attachmentIds.length) throw new ValidationError("Attachment not found.");
  }
  const message = await prisma.$transaction(async (tx) => {
    const conversationId =
      input.conversationId ??
      (await tx.conversation.create({ data: { clientId: input.clientId, subject: input.subject?.trim().slice(0, 200) || "Question from client", privateToPortalUserId: isBusinessOwner ? user.id : null } })).id;
    const m = await tx.message.create({
      data: {
        conversationId,
        channel: "PORTAL",
        direction: "INBOUND",
        body,
        portalAuthorId: user.id,
        status: "DELIVERED",
        readByClientAt: new Date(),
        idempotencyKey: input.idempotencyKey || null,
        attachments: attachmentIds.length ? { connect: attachmentIds.map((id) => ({ id })) } : undefined,
      },
    });
    await tx.conversation.update({ where: { id: conversationId }, data: { lastMessageAt: new Date(), awaitingStaff: true, unreadByStaff: true, closedAt: null } });
    await audit(tx, { actorId: null, action: "message.received", entityType: "Message", entityId: m.id, clientId: input.clientId, details: { channel: "PORTAL", portalUserId: user.id } });
    return m;
  });
  // Brief text to the office phone (no message contents), within staff alert hours.
  await queueStaffAlert({ conversationId: message.conversationId });
  // A reply to a bookkeeping question marks it answered and tasks the assigned staff member.
  const { onClientReply } = await import("./bookkeeping-questions");
  await onClientReply(message.conversationId);
  return message;
}

export async function markStaffRead(conversationId: string) {
  await prisma.conversation.update({ where: { id: conversationId }, data: { unreadByStaff: false } });
}

export async function markClientRead(user: PortalActor, conversationId: string) {
  const convo = await prisma.conversation.findUnique({ where: { id: conversationId } });
  if (!convo) return;
  await requireClientAccess(user.id, convo.clientId, "message");
  if (convo.privateToPortalUserId && convo.privateToPortalUserId !== user.id) return;
  await prisma.message.updateMany({ where: { conversationId, direction: "OUTBOUND", channel: "PORTAL", readByClientAt: null }, data: { readByClientAt: new Date() } });
}

export async function setConversationState(actor: Actor, conversationId: string, input: { assignedToId?: string | null; closed?: boolean }) {
  const data: Prisma.ConversationUpdateInput = {};
  if (input.assignedToId !== undefined) data.assignedTo = input.assignedToId ? { connect: { id: input.assignedToId } } : { disconnect: true };
  if (input.closed !== undefined) Object.assign(data, { closedAt: input.closed ? new Date() : null, awaitingStaff: input.closed ? false : undefined });
  const c = await prisma.conversation.update({ where: { id: conversationId }, data });
  await audit(prisma, { actorId: actor.id, action: "conversation.updated", entityType: "Conversation", entityId: conversationId, clientId: c.clientId, details: input });
}

/** Conversations visible to a portal user for one account. */
export async function portalConversations(user: PortalActor, clientId: string) {
  await requireClientAccess(user.id, clientId, "message");
  return prisma.conversation.findMany({
    // Only portal messages are shown in the portal; email/text threads stay staff-side.
    where: { clientId, messages: { some: { channel: "PORTAL" } }, ...conversationScope(user.id) },
    include: { messages: { where: { channel: "PORTAL" }, orderBy: { createdAt: "desc" }, take: 1 }, _count
: { select: { messages: { where: { channel: "PORTAL", direction: "OUTBOUND", readByClientAt: null } } } } },
    orderBy: { lastMessageAt: "desc" },
  });
}
