import "server-only";
import type { MessageChannel, Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { audit } from "@/lib/audit";
import type { Actor } from "@/lib/auth/actor";
import type { PortalActor } from "@/lib/portal/session";
import { requireClientAccess } from "@/lib/portal/access";
import { ineligibilityReason } from "@/lib/consent";
import { sendTransactionalEmail } from "@/lib/email";
import { queueStaffAlert } from "./staff-alerts";
import { integrationStatus } from "@/lib/integrations";
import { activeSuppressionsFor, ValidationError } from "./clients";
import { queuePortalNotification } from "./notifications";

const MAX_BODY = 10_000;

export function channelAvailability() {
  const i = integrationStatus();
  return {
    PORTAL: { available: true, note: "Private and secure. The client gets a sign-in notice." },
    EMAIL: { available: i.email && i.liveSendingFlag, note: i.email ? (i.liveSendingFlag ? "Sends a plain email. Don't include tax or account details." : "Live sending is turned off.") : "Setup required: email provider." },
    // Two-way texting (inbound webhooks, delivery receipts) arrives with the messaging stage.
    SMS: { available: false, note: i.twilio ? "Direct texting is enabled in the next stage." : "Setup required: Twilio." },
    INTERNAL_NOTE: { available: true, note: "Visible to staff only. Never shown to the client." },
  } satisfies Record<MessageChannel, { available: boolean; note: string }>;
}

async function existingByKey(key?: string | null) {
  return key ? prisma.message.findUnique({ where: { idempotencyKey: key } }) : null;
}

async function notifyMessage(clientId: string, messageId: string) {
  const grants = await prisma.portalAccess.findMany({ where: { clientId, revokedAt: null, canMessage: true } });
  for (const g of grants) await queuePortalNotification(g.portalUserId, "NEW_MESSAGE", `NEW_MESSAGE:${messageId}`);
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
  const body = input.body.trim();
  if (!body) throw new ValidationError("Write a message first.");
  if (body.length > MAX_BODY) throw new ValidationError("That message is too long.");
  const dup = await existingByKey(input.idempotencyKey);
  if (dup) return dup;
  const client = await prisma.client.findUnique({ where: { id: input.clientId }, include: { consentRecords: true } });
  if (!client) throw new ValidationError("Client not found.");
  if (client.archivedAt) throw new ValidationError("Restore this client before messaging them.");

  let conversationId = input.conversationId ?? null;
  if (conversationId) {
    const convo = await prisma.conversation.findFirst({ where: { id: conversationId, clientId: input.clientId } });
    if (!convo) throw new ValidationError("Conversation not found.");
  }
  const attachmentIds = input.attachmentIds ?? [];
  if (attachmentIds.length) {
    const ok = await prisma.document.count({ where: { id: { in: attachmentIds }, clientId: input.clientId, deletedAt: null } });
    if (ok !== attachmentIds.length) throw new ValidationError("Attachments must be documents belonging to this client.");
    if (input.channel !== "PORTAL") throw new ValidationError("Attachments can only be sent through the secure portal.");
  }
  const isNote = input.channel === "INTERNAL_NOTE";

  if (input.channel === "EMAIL" || input.channel === "SMS") {
    const availability = channelAvailability()[input.channel];
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
  }

  const message = await prisma.$transaction(async (tx) => {
    if (!conversationId) {
      const convo = await tx.conversation.create({
        data: { clientId: input.clientId, subject: input.subject?.trim().slice(0, 200) || "Message from TTurner & Associates Group", assignedToId: actor.id, periodId: input.periodId ?? null },
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
    await notifyMessage(input.clientId, message.id);
  } else if (input.channel === "EMAIL") {
    const ok = await sendTransactionalEmail(client.emailNormalized!, input.subject?.trim() || "A message from TTurner & Associates Group", body);
    await prisma.message.update({ where: { id: message.id }, data: ok ? { status: "PROVIDER_ACCEPTED" } : { status: "FAILED", errorDetail: "Email provider rejected the message" } });
  } else {
    // Text replies go through the campaign/messaging queue in the next stage;
    // until then they are not attempted.
    await prisma.message.update({ where: { id: message.id }, data: { status: "FAILED", errorDetail: "Direct texting is enabled in the next stage" } });
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
  if (input.conversationId && !(await prisma.conversation.count({ where: { id: input.conversationId, clientId: input.clientId } }))) {
    throw new ValidationError("Conversation not found.");
  }
  const attachmentIds = input.attachmentIds ?? [];
  if (attachmentIds.length) {
    // Only the client's own uploads for this account can be attached.
    const ok = await prisma.document.count({ where: { id: { in: attachmentIds }, clientId: input.clientId, uploadedByPortalId: user.id, category: { not: "IDENTITY" } } });
    if (ok !== attachmentIds.length) throw new ValidationError("Attachment not found.");
  }
  const message = await prisma.$transaction(async (tx) => {
    const conversationId =
      input.conversationId ?? (await tx.conversation.create({ data: { clientId: input.clientId, subject: input.subject?.trim().slice(0, 200) || "Question from client" } })).id;
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
  return message;
}

export async function markStaffRead(conversationId: string) {
  await prisma.conversation.update({ where: { id: conversationId }, data: { unreadByStaff: false } });
}

export async function markClientRead(user: PortalActor, conversationId: string) {
  const convo = await prisma.conversation.findUnique({ where: { id: conversationId } });
  if (!convo) return;
  await requireClientAccess(user.id, convo.clientId, "message");
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
    where: { clientId, messages: { some: { channel: "PORTAL" } } },
    include: { messages: { where: { channel: "PORTAL" }, orderBy: { createdAt: "desc" }, take: 1 }, _count: { select: { messages: { where: { channel: "PORTAL", direction: "OUTBOUND", readByClientAt: null } } } } },
    orderBy: { lastMessageAt: "desc" },
  });
}
