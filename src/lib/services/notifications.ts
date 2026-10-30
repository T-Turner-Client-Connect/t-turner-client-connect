import "server-only";
import { prisma } from "@/lib/prisma";
import { brandedNoticeHtml, sendTransactionalEmail } from "@/lib/email";
import { appUrl } from "@/lib/integrations";
import { sendSms } from "@/lib/twilio";
import { smsSendAllowed } from "./sms-consent";
import { chicagoParts } from "@/lib/tz";

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
  QUOTE_READY: "A quote is ready for your review",
  NEW_INVOICE: "A new invoice is available",
  // Identity documents: deliberately generic (no document type or details).
  ID_EXPIRING: "A document on file needs to be updated soon",
  ID_EXPIRED: "A document on file needs to be updated",
  ID_NEEDS_ATTENTION: "A document you sent needs your attention",
};

// Client texts are held outside 8 a.m.–8 p.m. Central and sent when the window opens.
export const CLIENT_SMS_QUIET = { start: "08:00", end: "20:00" };
function clientSmsAllowedNow(now = new Date()) {
  const p = chicagoParts(now);
  const t = `${String(p.hour).padStart(2, "0")}:${String(p.minute).padStart(2, "0")}`;
  return t >= CLIENT_SMS_QUIET.start && t < CLIENT_SMS_QUIET.end;
}

export function notificationText(kind: string) {
  const line = TEXT[kind] ?? "There's something new in your client portal";
  if (kind === "NEW_MESSAGE") {
    return {
      heading: "Your team has replied",
      line: "Your team has replied to your portal message. Sign in to view it.",
      subject: "Your team has replied — TTurner & Associates",
      body: `Your team has replied to your portal message in your TTurner & Associates Group client portal.\n\nSign in securely to view it: ${appUrl()}/client\n\nFor your privacy, we never include messages, account details or tax documents in emails or texts.`,
      sms: `TTurner & Associates: Your team has replied to your portal message. Sign in to view it: ${appUrl()}/client Reply STOP to unsubscribe.`,
    };
  }
  return {
    heading: line,
    line: `${line} in your TTurner & Associates Group client portal.`,
    subject: `${line} — TTurner & Associates Group`,
    body: `${line} in your TTurner & Associates Group client portal.\n\nSign in securely to view it: ${appUrl()}/client\n\nFor your privacy, we never include account details or tax documents in emails or texts.`,
    sms: `TTurner & Associates Group: ${line} in your client portal. Sign in: ${appUrl()}/client Reply STOP to opt out, HELP for help.`,
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
    if (n.channel === "SMS" && !clientSmsAllowedNow()) {
      await prisma.notification.update({ where: { id: n.id }, data: { statusDetail: "Held for quiet hours — sends after 8 a.m. Central" } });
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
