import "server-only";
import { prisma } from "@/lib/prisma";
import { brandedNoticeHtml, sendTransactionalEmail } from "@/lib/email";
import { appUrl } from "@/lib/integrations";

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
    sms: `T. Turner & Associates: ${line} in your client portal. Sign in: ${appUrl()}/client Reply STOP to opt out of texts.`,
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

async function sendSms(to: string, body: string): Promise<{ ok: boolean; detail: string }> {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  const from: Record<string, string> | null = process.env.TWILIO_MESSAGING_SERVICE_SID
    ? { MessagingServiceSid: process.env.TWILIO_MESSAGING_SERVICE_SID }
    : process.env.TWILIO_FROM_NUMBER
      ? { From: process.env.TWILIO_FROM_NUMBER }
      : null;
  if (!sid || !token || !from) return { ok: false, detail: "Text provider (Twilio) not set up" };
  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
    method: "POST",
    headers: { Authorization: `Basic ${Buffer.from(`${sid}:${token}`).toString("base64")}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ To: to, Body: body, ...from }),
  });
  return res.ok ? { ok: true, detail: "Accepted by Twilio" } : { ok: false, detail: `Twilio HTTP ${res.status}` };
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
    let result: { ok: boolean; detail: string };
    if (n.channel === "EMAIL") {
      const ok = await sendTransactionalEmail(n.portalUser.email, text.subject, text.body, brandedNoticeHtml(text.heading, text.line, "Sign in to your portal", `${appUrl()}/client`));
      result = ok ? { ok, detail: "Accepted by email provider" } : { ok, detail: "Email provider not set up or rejected the message" };
    } else {
      result = await sendSms(n.portalUser.phoneNormalized!, text.sms);
    }
    await prisma.notification.update({
      where: { id: n.id },
      data: result.ok ? { status: "SENT", statusDetail: result.detail } : { status: "FAILED", statusDetail: result.detail, sentAt: null },
    });
  }
}
