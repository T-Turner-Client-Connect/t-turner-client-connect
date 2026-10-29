import "server-only";
import type { Invite, Role } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { audit } from "@/lib/audit";
import { assertAdmin, type Actor } from "@/lib/auth/actor";
import { hashToken, newToken } from "@/lib/auth/tokens";
import { normalizeEmail } from "@/lib/normalize";
import { brandedEmailHtml, sendEmail } from "@/lib/email";
import { appUrl } from "@/lib/integrations";
import { BUSINESS } from "@/lib/business";
import { ValidationError } from "./clients";

/**
 * Staff invitations. These are transactional account emails: they go only to
 * the address an Admin typed, never through campaigns, client messaging,
 * client portal invitations or marketing suppression lists.
 *
 * Each invitation row holds one single-use link (only its hash is stored).
 * Resending or taking a new private link replaces the row, so the old link
 * stops working at once.
 */
export const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
// A send still "in flight" after this long is treated as failed (crashed request).
const STALE_SEND_MS = 5 * 60 * 1000;
// Blocks accidental back-to-back resends to the same person.
const RESEND_COOLDOWN_MS = 60 * 1000;

export const inviteLink = (token: string) => `${appUrl()}/staff/invite/${token}`;

export type InviteOutcome = {
  inviteId: string;
  email: string;
  status: "sent" | "not_sent";
  message: string;
  // Only returned to the Admin's own screen when email didn't go out.
  privateLink?: string;
};

export type InviteState = "ACTIVATED" | "REVOKED" | "REPLACED" | "EXPIRED" | "DELIVERED" | "ACCEPTED" | "SENDING" | "FAILED" | "CREATED";

/** One status per invitation, with email delivery shown only as far as the provider confirmed it. */
export function inviteState(i: Pick<Invite, "acceptedAt" | "revokedAt" | "replacedById" | "expiresAt" | "emailStatus" | "emailAttemptAt">, now = new Date()): InviteState {
  if (i.acceptedAt) return "ACTIVATED";
  if (i.replacedById) return "REPLACED";
  if (i.revokedAt) return "REVOKED";
  if (i.expiresAt < now) return "EXPIRED";
  if (i.emailStatus === "SENDING" && i.emailAttemptAt && now.getTime() - i.emailAttemptAt.getTime() > STALE_SEND_MS) return "FAILED";
  if (i.emailStatus === "NOT_SENT") return "CREATED";
  return i.emailStatus;
}

export function staffInvitationEmail(input: { name: string; role: Role; invitedBy: string; link: string; expiresAt: Date }) {
  const roleLabel = input.role === "ADMIN" ? "an Admin" : "a staff member";
  const expires = input.expiresAt.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "America/Chicago" });
  const subject = `Your staff invitation to ${BUSINESS.platformName}`;
  const paragraphs = [
    `Hello ${input.name},`,
    `${input.invitedBy} has invited you to join ${BUSINESS.legalName} on ${BUSINESS.platformName} as ${roleLabel}.`,
    `Use the button below to create your password and set up two-step verification. The link works once and expires on ${expires}.`,
  ];
  const note = `If you weren't expecting this invitation, you can ignore this email — no account is created unless the link is used. Please don't forward it; the link is meant only for you.`;
  const html = brandedEmailHtml({
    heading: "You're invited to the team",
    paragraphs,
    button: { label: "Create Your Staff Account", url: input.link },
    note,
    footer: `${BUSINESS.legalName} · ${BUSINESS.platformName} · ${BUSINESS.officePhoneDisplay}`,
  });
  const text = `${paragraphs.join("\n\n")}\n\nCreate Your Staff Account:\n${input.link}\n\n${note}\n\n${BUSINESS.legalName}\n${BUSINESS.officePhoneDisplay}`;
  return { subject, text, html };
}

/**
 * Emails the invitation. Only one request can claim the send (status moves
 * NOT_SENT/FAILED → SENDING atomically), and Resend gets an idempotency key
 * per invitation, so a double-click or retry can't send the same link twice.
 */
export async function sendInviteEmail(inviteId: string, token: string, invitedBy: string): Promise<InviteOutcome> {
  const now = new Date();
  const claimed = await prisma.invite.updateMany({
    where: {
      id: inviteId,
      tokenHash: hashToken(token),
      acceptedAt: null,
      revokedAt: null,
      expiresAt: { gt: now },
      OR: [{ emailStatus: { in: ["NOT_SENT", "FAILED"] } }, { emailStatus: "SENDING", emailAttemptAt: { lt: new Date(now.getTime() - STALE_SEND_MS) } }],
    },
    data: { emailStatus: "SENDING", emailAttemptAt: now, emailError: null },
  });
  const invite = await prisma.invite.findUniqueOrThrow({ where: { id: inviteId } });
  if (claimed.count !== 1) {
    return { inviteId, email: invite.email, status: invite.emailStatus === "ACCEPTED" || invite.emailStatus === "DELIVERED" ? "sent" : "not_sent", message: "This invitation is already being sent or isn't open any more." };
  }
  const link = inviteLink(token);
  const email = staffInvitationEmail({ name: invite.name, role: invite.role, invitedBy, link, expiresAt: invite.expiresAt });
  const result = await sendEmail({ to: invite.email, ...email, idempotencyKey: `staff-invite/${invite.id}`, tags: { category: "staff_invitation" } });
  if (result.ok) {
    await prisma.invite.update({ where: { id: invite.id }, data: { emailStatus: "ACCEPTED", emailAcceptedAt: new Date(), emailProviderId: result.providerId } });
    await prisma.auditLog.create({ data: { action: "user.invite_email_accepted", entityType: "Invite", entityId: invite.id } });
    return { inviteId, email: invite.email, status: "sent", message: `Invitation emailed to ${invite.email}. Resend accepted it; it will show Delivered once the provider confirms delivery.` };
  }
  const notConfigured = result.reason === "not_configured";
  await prisma.invite.update({
    where: { id: invite.id },
    data: { emailStatus: notConfigured ? "NOT_SENT" : "FAILED", emailFailedAt: notConfigured ? null : new Date(), emailError: result.detail },
  });
  await prisma.auditLog.create({ data: { action: notConfigured ? "user.invite_email_not_configured" : "user.invite_email_failed", entityType: "Invite", entityId: invite.id } });
  return {
    inviteId,
    email: invite.email,
    status: "not_sent",
    message: `${result.detail} The invitation is saved — copy the private link below and share it with ${invite.name} yourself (not by public post or group text).`,
    privateLink: link,
  };
}

async function newInviteRow(tx: Pick<typeof prisma, "invite">, input: { email: string; name: string; role: Role; invitedById: string; createKey?: string }) {
  const token = newToken();
  const invite = await tx.invite.create({
    data: {
      email: input.email,
      name: input.name,
      role: input.role,
      tokenHash: hashToken(token),
      expiresAt: new Date(Date.now() + INVITE_TTL_MS),
      invitedById: input.invitedById,
      createKey: input.createKey || null,
    },
  });
  return { invite, token };
}

/** Creates an invitation and emails it. Refuses a second open invitation for the same address. */
export async function inviteStaff(actor: Actor, input: { email: string; name: string; role: Role; idempotencyKey?: string }): Promise<InviteOutcome> {
  assertAdmin(actor);
  if (input.idempotencyKey) {
    const repeat = await prisma.invite.findUnique({ where: { createKey: input.idempotencyKey } });
    if (repeat) return { inviteId: repeat.id, email: repeat.email, status: "not_sent", message: "That invitation was already created — see its status in the list below." };
  }
  const email = normalizeEmail(input.email);
  if (!email) throw new ValidationError("Enter a valid email address.");
  const name = input.name.trim();
  if (!name) throw new ValidationError("Enter their name.");
  if (await prisma.user.findUnique({ where: { email } })) throw new ValidationError("That person already has an account.");
  const alreadyCreated: InviteOutcome = { inviteId: "", email, status: "not_sent", message: "That invitation was already created — see its status in the list below." };
  let created;
  try {
    created = await prisma.$transaction(async (tx) => {
      // One invitation at a time per address, even across tabs or Admins.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`staff-invite:${email}`}))`;
      if (input.idempotencyKey && (await tx.invite.findUnique({ where: { createKey: input.idempotencyKey } }))) return null;
      const open = await tx.invite.findFirst({ where: { email, acceptedAt: null, revokedAt: null, expiresAt: { gt: new Date() } } });
      if (open) throw new ValidationError(`${email} already has a pending invitation. Use Resend or Revoke on it below.`);
      const row = await newInviteRow(tx, { email, name, role: input.role, invitedById: actor.id, createKey: input.idempotencyKey });
      // Any older expired invitation for this address is now superseded.
      await tx.invite.updateMany({ where: { email, acceptedAt: null, revokedAt: null, id: { not: row.invite.id } }, data: { revokedAt: new Date(), replacedById: row.invite.id } });
      await audit(tx, { actorId: actor.id, action: "user.invited", entityType: "Invite", entityId: row.invite.id, details: { email, role: input.role } });
      return row;
    });
  } catch (err) {
    // Two submits with the same key raced; the other one is doing the send.
    if ((err as { code?: string }).code === "P2002") return alreadyCreated;
    throw err;
  }
  if (!created) return alreadyCreated;
  return sendInviteEmail(created.invite.id, created.token, actor.name);
}

/** Replaces an open (or expired / failed) invitation with a fresh link. The old link stops working. */
async function replaceInvite(actor: Actor, inviteId: string, action: "resend" | "copy_link") {
  assertAdmin(actor);
  const old = await prisma.invite.findUnique({ where: { id: inviteId } });
  if (!old) throw new ValidationError("Invitation not found.");
  if (old.acceptedAt) throw new ValidationError("This invitation was already used — the account is active.");
  if (old.replacedById) throw new ValidationError("This invitation was already replaced by a newer one.");
  if (old.revokedAt) throw new ValidationError("This invitation was revoked. Create a new invitation instead.");
  if (await prisma.user.findUnique({ where: { email: old.email } })) throw new ValidationError("That person already has an account.");
  if (action === "resend" && old.emailAttemptAt && Date.now() - old.emailAttemptAt.getTime() < RESEND_COOLDOWN_MS && old.emailStatus !== "FAILED") {
    throw new ValidationError("An invitation email went to this person less than a minute ago. Give it a moment before resending.");
  }
  return prisma.$transaction(async (tx) => {
    // Claim the old row first so two simultaneous resends can't both create a link.
    const claimed = await tx.invite.updateMany({ where: { id: old.id, acceptedAt: null, revokedAt: null, replacedById: null }, data: { revokedAt: new Date() } });
    if (claimed.count !== 1) throw new ValidationError("This invitation was just changed by someone else. Refresh to see its status.");
    const row = await newInviteRow(tx, { email: old.email, name: old.name, role: old.role, invitedById: actor.id });
    await tx.invite.update({ where: { id: old.id }, data: { replacedById: row.invite.id } });
    if (action === "copy_link") await tx.invite.update({ where: { id: row.invite.id }, data: { linkCopiedAt: new Date() } });
    await audit(tx, { actorId: actor.id, action: action === "resend" ? "user.invite_resent" : "user.invite_link_created", entityType: "Invite", entityId: row.invite.id, details: { replaces: old.id } });
    return row;
  });
}

export async function resendInvite(actor: Actor, inviteId: string): Promise<InviteOutcome> {
  const { invite, token } = await replaceInvite(actor, inviteId, "resend");
  return sendInviteEmail(invite.id, token, actor.name);
}

/** Private fallback: a fresh one-time link shown only to the Admin. Any earlier emailed link stops working. */
export async function createPrivateInviteLink(actor: Actor, inviteId: string): Promise<InviteOutcome> {
  const { invite, token } = await replaceInvite(actor, inviteId, "copy_link");
  return {
    inviteId: invite.id,
    email: invite.email,
    status: "not_sent",
    message: `New one-time link for ${invite.name} (valid 7 days). Any earlier link no longer works. Share it privately.`,
    privateLink: inviteLink(token),
  };
}

export async function revokeInvite(actor: Actor, inviteId: string) {
  assertAdmin(actor);
  const revoked = await prisma.invite.updateMany({ where: { id: inviteId, acceptedAt: null, revokedAt: null }, data: { revokedAt: new Date() } });
  if (revoked.count !== 1) throw new ValidationError("That invitation isn't open any more.");
  await prisma.auditLog.create({ data: { actorId: actor.id, action: "user.invite_revoked", entityType: "Invite", entityId: inviteId } });
}

/** Invitations for the Settings list: the latest one per address from the last 30 days. */
export async function recentInvites() {
  const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  return prisma.invite.findMany({ where: { createdAt: { gte: since }, replacedById: null }, orderBy: { createdAt: "desc" }, take: 30, include: { invitedBy: { select: { name: true } } } });
}

/**
 * Applies a verified Resend webhook event to a staff invitation. "Delivered"
 * only ever comes from here; a bounce or failure never downgrades a delivery.
 * Returns true when the event matched an invitation.
 */
export async function applyInviteEmailEvent(type: string, providerId: string, reason?: string): Promise<boolean> {
  const invite = await prisma.invite.findUnique({ where: { emailProviderId: providerId } });
  if (!invite) return false;
  if (type === "email.delivered") {
    await prisma.invite.updateMany({ where: { id: invite.id, emailStatus: { in: ["ACCEPTED", "SENDING"] } }, data: { emailStatus: "DELIVERED", emailDeliveredAt: new Date() } });
  } else if (type === "email.bounced" || type === "email.failed" || type === "email.complained") {
    const detail = type === "email.bounced" ? "The email bounced" : type === "email.complained" ? "The recipient marked the email as spam" : "The provider couldn't deliver the email";
    await prisma.invite.updateMany({
      where: { id: invite.id, emailStatus: { not: "DELIVERED" } },
      data: { emailStatus: "FAILED", emailFailedAt: new Date(), emailError: `${detail}${reason ? ` (${reason.slice(0, 160)})` : ""}. Check the address, then Resend or copy a private link.` },
    });
  } else {
    return true;
  }
  await prisma.auditLog.create({ data: { action: `user.invite_${type.replace("email.", "email_")}`, entityType: "Invite", entityId: invite.id } });
  return true;
}
