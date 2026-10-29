import "server-only";
import { prisma } from "@/lib/prisma";
import { brandedNoticeHtml, sendTransactionalEmail } from "@/lib/email";
import { appUrl } from "@/lib/integrations";
import { sendSms } from "@/lib/twilio";
import { smsSendAllowed } from "./sms-consent";

/**
 * "Something new in your portal" notices. Account-service messages, kept
 * separate from marketing permissions: they go to portal users according to
 * their own notification preferences, contain only a sign-in link, and never
 * include document contents, amounts, or tax information.
 */
const TEXT: Record<string, string> = {
  NEW_MESSAGE: "You have a new secure message",
  APPOINTMENT_REMINDER: "You have an upcoming appointment",
  NEW_DOCUMENT: "A new document is available",
  DOCUMENT_REQUEST: "We've requested a document from you",
  SIGNATURE_REQUEST: "A document is ready for your signature",
  CONTRACT_ASSIGNED: "A form is ready for you to complete",
  ACCOUNT_UPDATE: "There's a new update on your account",
  FILING_UPDATE: "A tax filing update is available",
};

export function notificationText(kind: string) {
  const line = TEXT[kind] ?? "There's something new in your client portal";
  return {
    heading: line,
    line: `${line} in your T. Turner & Associates client portal.`,
    subject: `${line} — T. Turner & Associates`,
    body: `${line} in your T. Turner & Associates client portal.\n\nSign in securely to view it: ${appUrl()}/client\n\nFor your privacy, we never include account details or tax documents in emails or texts.`,
    sms: `T. Turner & Associates: ${line} in your client portal. Sign in: ${appUrl()}/client Reply STOP to opt out, HELP for help.`,
  };
}

export async function queuePortalNotification(portalUserId: string, kind: string, refKey: string, onlyChannels?: ("EMAIL" | "SMS")[]) {
  const user = await prisma.portalUser.findUnique({ where: { id: portalUserId } });
  if (!user?.active || !user.passwordHash) return;
  const rows = [
    ...(user.notifyByEmail ? [{ channel: "EMAIL" as const }] : []),
    ...(user.notifyBySms && user.phoneNormalized ? [{ channel: "SMS" as const }] : []),
  ]
    .filter((r) => !onlyChannels || onlyChannels.includes(r.channel))
    .map((r) => ({ portalUserId, kind, channel: r.channel, idempotencyKey: `${refKey}:${portalUserId}:${r.channel}` }));
  if (!rows.length) return;
  // The idempotency key makes retries and double-clicks harmless.
  await prisma.notification.createMany({ data: rows, skipDuplicates: true });
  await dispatchPendingNotifications(portalUserId);
}

function notificationsEnabled() {
  return process.env.NOTIFICATIONS_ENABLED === "true";
}

/** Sends pending notices when providers are configured; otherwise records why not. */
export async function dispatchPendingNotifications(portalUserId?: string) {
  const pending = await prisma.notification.findMany({
    where: { status: "PENDING", ...(portalUserId ? { portalUserId } : {}) },
    include: { portalUser: true },
    take: 50,
  });
  for (const n of pending) {
    if (!notificationsEnabled()) {
      await prisma.notification.update({ where: { id: n.id }, data: { statusDetail: "Notifications are turned off (NOTIFICATIONS_ENABLED is not true)" } });
      continue;
    }
    // Claim the row first so concurrent dispatchers can't double-send.
    const claimed = await prisma.notification.updateMany({ where: { id: n.id, status: "PENDING", sentAt: null }, data: { sentAt: new Date() } });
    if (claimed.count !== 1) continue;
    const text = notificationText(n.kind);
    let result: { ok: boolean; detail: string; sid?: string };
    if (n.channel === "EMAIL") {
      const ok = await sendTransactionalEmail(n.portalUser.email, text.subject, text.body, brandedNoticeHtml(text.heading, text.line, "Sign in to your portal", `${appUrl()}/client`));
      result = ok ? { ok, detail: "Accepted by email provider" } : { ok, detail: "Email provider not set up or rejected the message" };
    } else {
      // Re-checked at send time: service-text consent on file and no STOP.
      const phone = n.portalUser.phoneNormalized;
      const allowed = phone ? await smsSendAllowed(phone, "SERVICE") : { ok: false, reason: "No mobile number" };
      if (!allowed.ok) {
        await prisma.notification.update({ where: { id: n.id }, data: { status: "SKIPPED", statusDetail: allowed.reason, sentAt: null } });
        continue;
      }
      result = await sendSms(phone!, text.sms);
    }
    await prisma.notification.update({
      where: { id: n.id },
      data: result.ok
        ? { status: "SENT", statusDetail: result.detail, providerSid: result.sid ?? null, deliveryStatus: n.channel === "SMS" ? "accepted" : null }
        : { status: "FAILED", statusDetail: result.detail, sentAt: null },
    });
  }
}
