import "server-only";
import { prisma } from "@/lib/prisma";
import { assertAdmin, type Actor } from "@/lib/auth/actor";
import { normalizeEmail, normalizePhone } from "@/lib/normalize";
import { sendSms, twilioConfigured } from "@/lib/twilio";
import { chicagoLocalToUtc, chicagoParts } from "@/lib/tz";
import { ValidationError } from "./clients";
import { emailProviderConfigured } from "@/lib/auth/client-auth";
import { brandedEmailHtml, sendEmail } from "@/lib/email";
import { appUrl } from "@/lib/integrations";
import { fmtChicago } from "@/lib/tz";
import { CATEGORY_LABELS } from "./documents";

/**
 * Staff text alerts: a brief notice to the office phone when a client sends
 * something, only Monday–Friday inside the configured Central-time window.
 * After-hours alerts wait for the next window; several pending alerts become
 * one text; alerts for conversations already read or resolved are skipped.
 * In-site and email notices are unaffected by these hours.
 */
export const STAFF_ALERT_TEXT = "TTurner Client Connect: You have a new client message. Sign in to view and respond.";
export const TEST_TEXT = "TTurner Client Connect test: this confirms texts reach the office phone. Reply YES to confirm two-way texting. Reply STOP to opt out.";

export async function staffAlertSettings() {
  const found = await prisma.staffAlertSettings.findUnique({ where: { id: "default" } });
  if (found) return found;
  return prisma.staffAlertSettings.create({ data: { id: "default" } }).catch(() => prisma.staffAlertSettings.findUniqueOrThrow({ where: { id: "default" } }));
}

export async function updateStaffAlertSettings(actor: Actor, input: { smsEnabled: boolean; phone: string; windowStart: string; windowEnd: string; emailEnabled?: boolean; email?: string }) {
  assertAdmin(actor);
  const phone = normalizePhone(input.phone);
  if (!phone) throw new ValidationError("Enter a valid US phone number for staff alerts.");
  if (!/^\d{2}:\d{2}$/.test(input.windowStart) || !/^\d{2}:\d{2}$/.test(input.windowEnd) || input.windowStart >= input.windowEnd) throw new ValidationError("Choose a start time before the end time.");
  if (input.smsEnabled && !twilioConfigured()) throw new ValidationError("Connect Twilio first (TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_MESSAGING_SERVICE_SID).");
  await staffAlertSettings();
  const email = input.email !== undefined ? normalizeEmail(input.email) : undefined;
  if (input.email !== undefined && !email) throw new ValidationError("Enter a valid email address for staff alerts.");
  await prisma.staffAlertSettings.update({
    where: { id: "default" },
    data: { smsEnabled: input.smsEnabled, phone, windowStart: input.windowStart, windowEnd: input.windowEnd, ...(input.emailEnabled !== undefined ? { emailEnabled: input.emailEnabled } : {}), ...(email ? { email } : {}), updatedById: actor.id },
  });
  await prisma.auditLog.create({ data: { actorId: actor.id, action: input.smsEnabled ? "staff_alerts.sms_on" : "staff_alerts.sms_off", entityType: "StaffAlertSettings", entityId: "default" } });
}

const WEEKDAYS = new Set(["Mon", "Tue", "Wed", "Thu", "Fri"]);
const hhmm = (d: Date) => {
  const p = chicagoParts(d);
  return `${String(p.hour).padStart(2, "0")}:${String(p.minute).padStart(2, "0")}`;
};

export function inWindow(now: Date, start: string, end: string) {
  return WEEKDAYS.has(chicagoParts(now).weekday) && hhmm(now) >= start && hhmm(now) < end;
}

/** Start of the next allowed window (now, if already inside one). Daylight saving handled via America/Chicago. */
export function nextWindowStart(now: Date, start: string, end: string): Date {
  if (inWindow(now, start, end)) return now;
  for (let i = 0; i < 8; i++) {
    const day = new Date(now.getTime() + i * 86400_000);
    const p = chicagoParts(day);
    if (!WEEKDAYS.has(p.weekday)) continue;
    const z = (n: number) => String(n).padStart(2, "0");
    const at = chicagoLocalToUtc(`${p.year}-${z(p.month)}-${z(p.day)}T${start}`)!;
    if (at > now) return at;
  }
  return now;
}

export const STAFF_UPLOAD_TEXT = "TTurner Client Connect: A client uploaded new documents. Sign in to review them.";
export const STAFF_BOTH_TEXT = "TTurner Client Connect: You have new client messages and documents. Sign in to view and respond.";
const EMAIL_GROUPING_MS = 5 * 60 * 1000;
// A short wait gathers a burst of activity into one text, and the office phone
// gets at most one alert text per 15 minutes.
const SMS_GROUPING_MS = 3 * 60 * 1000;
const SMS_MIN_GAP_MS = 15 * 60 * 1000;

/**
 * Called whenever a client sends a message or uploads a document. Joins any
 * alert still waiting, so a burst of activity becomes one text and one email.
 */
export async function queueStaffAlert(ref: { conversationId?: string; documentId?: string }) {
  const s = await staffAlertSettings();
  const now = new Date();
  const lastText = await prisma.staffAlert.findFirst({ where: { reason: "CLIENT_MESSAGE", channel: "SMS", status: "SENT" }, orderBy: { sentAt: "desc" }, select: { sentAt: true } });
  const earliestText = new Date(Math.max(now.getTime() + SMS_GROUPING_MS, (lastText?.sentAt?.getTime() ?? 0) + SMS_MIN_GAP_MS));
  const channels = [
    ...(s.smsEnabled && twilioConfigured() ? [{ channel: "SMS", to: s.phone, notBefore: nextWindowStart(earliestText, s.windowStart, s.windowEnd) }] : []),
    ...(s.emailEnabled && emailProviderConfigured() ? [{ channel: "EMAIL", to: s.email, notBefore: new Date(now.getTime() + EMAIL_GROUPING_MS) }] : []),
  ];
  if (!channels.length) return;
  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('staff-alert-queue'))`;
    for (const c of channels) {
      const pending = await tx.staffAlert.findFirst({ where: { reason: "CLIENT_MESSAGE", channel: c.channel, status: "PENDING" } });
      if (pending) {
        await tx.staffAlert.update({
          where: { id: pending.id },
          data: {
            ...(ref.conversationId && !pending.conversationIds.includes(ref.conversationId) ? { conversationIds: { push: ref.conversationId } } : {}),
            ...(ref.documentId && !pending.documentIds.includes(ref.documentId) ? { documentIds: { push: ref.documentId } } : {}),
          },
        });
      } else {
        await tx.staffAlert.create({
          data: { reason: "CLIENT_MESSAGE", channel: c.channel, to: c.to, body: "", conversationIds: ref.conversationId ? [ref.conversationId] : [], documentIds: ref.documentId ? [ref.documentId] : [], notBefore: c.notBefore },
        });
      }
    }
  });
  await dispatchStaffAlerts(now);
}

async function openItems(conversationIds: string[], documentIds: string[]) {
  const [convos, docs] = await Promise.all([
    prisma.conversation.findMany({ where: { id: { in: conversationIds }, unreadByStaff: true, closedAt: null }, include: { client: { select: { id: true, displayName: true } } } }),
    prisma.document.findMany({ where: { id: { in: documentIds }, needsReview: true, deletedAt: null }, include: { client: { select: { id: true, displayName: true } } } }),
  ]);
  return { convos, docs };
}

function emailSummary(items: Awaited<ReturnType<typeof openItems>>) {
  const lines: string[] = [];
  for (const c of items.convos) lines.push(`• New message from ${c.client.displayName} (${fmtChicago(c.lastMessageAt)} CT) — ${appUrl()}/clients/${c.client.id}?tab=messages`);
  for (const d of items.docs) {
    if (d.category === "IDENTITY") {
      lines.push(`• ${d.client.displayName} uploaded an identity document for verification, ${fmtChicago(d.createdAt)} CT — ${appUrl()}/clients/${d.client.id}?tab=documents#identity`);
      continue;
    }
    lines.push(`• ${d.client.displayName} uploaded a document: ${CATEGORY_LABELS[d.category]}, ${d.year ? `tax year ${d.year}` : "tax year not given"}, ${fmtChicago(d.createdAt)} CT — ${appUrl()}/clients/${d.client.id}?tab=documents`);
  }
  return lines;
}

/** Sends due alerts (texts only inside the weekday window). Safe to run often: each alert is claimed once. */
export async function dispatchStaffAlerts(now = new Date()) {
  const s = await staffAlertSettings();
  const smsWindow = inWindow(now, s.windowStart, s.windowEnd);
  const due = await prisma.staffAlert.findMany({ where: { reason: "CLIENT_MESSAGE", status: "PENDING", notBefore: { lte: now }, ...(smsWindow ? {} : { channel: "EMAIL" }) } });
  let sent = 0;
  for (const a of due) {
    const items = await openItems(a.conversationIds, a.documentIds);
    if (!items.convos.length && !items.docs.length) {
      await prisma.staffAlert.updateMany({ where: { id: a.id, status: "PENDING" }, data: { status: "SKIPPED", statusDetail: "Already read, reviewed or resolved before the alert went out" } });
      continue;
    }
    const enabled = a.channel === "SMS" ? s.smsEnabled && twilioConfigured() : s.emailEnabled && emailProviderConfigured();
    if (!enabled) {
      await prisma.staffAlert.updateMany({ where: { id: a.id, status: "PENDING" }, data: { status: "SKIPPED", statusDetail: `Staff ${a.channel === "SMS" ? "text" : "email"} alerts are turned off` } });
      continue;
    }
    const claimed = await prisma.staffAlert.updateMany({ where: { id: a.id, status: "PENDING", sentAt: null }, data: { sentAt: now } });
    if (claimed.count !== 1) continue;
    if (a.channel === "SMS") {
      const body = items.convos.length && items.docs.length ? STAFF_BOTH_TEXT : items.docs.length ? STAFF_UPLOAD_TEXT : STAFF_ALERT_TEXT;
      const res = await sendSms(s.phone, body);
      await prisma.staffAlert.update({
        where: { id: a.id },
        data: res.ok ? { status: "SENT", body, providerSid: res.sid ?? null, deliveryStatus: "accepted", statusDetail: res.detail, to: s.phone } : { status: "FAILED", body, statusDetail: res.detail },
      });
      if (res.ok) sent++;
    } else {
      const lines = emailSummary(items);
      const paragraphs = ["New client activity in TTurner Client Connect:", ...lines, "Documents and messages stay in the secure system — sign in to view them. Nothing is attached to this email."];
      const res = await sendEmail({
        to: s.email,
        subject: `New client activity (${lines.length}) — TTurner Client Connect`,
        text: paragraphs.join("\n"),
        html: brandedEmailHtml({ heading: "New client activity", paragraphs, button: { label: "Sign in to Client Connect", url: `${appUrl()}/staff/login` } }),
        idempotencyKey: `staff-alert/${a.id}`,
        tags: { category: "staff_alert" },
      });
      await prisma.staffAlert.update({
        where: { id: a.id },
        data: res.ok ? { status: "SENT", body: paragraphs.join("\n"), providerSid: res.providerId ? `email:${res.providerId}` : null, deliveryStatus: "accepted", statusDetail: "Accepted by email provider", to: s.email } : { status: "FAILED", statusDetail: res.detail },
      });
      if (res.ok) sent++;
    }
  }
  return sent;
}

/**
 * Controlled test: one text to the office phone, sent now by an Admin. Its
 * delivery result comes from Twilio's status callback and the reply arrives
 * through the inbound webhook — both shown in Settings.
 */
export async function sendTestText(actor: Actor) {
  assertAdmin(actor);
  if (!twilioConfigured()) throw new ValidationError("Twilio isn't connected yet. Add TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN and TWILIO_MESSAGING_SERVICE_SID in Netlify and redeploy.");
  const s = await staffAlertSettings();
  const recent = await prisma.staffAlert.count({ where: { reason: "TEST", createdAt: { gte: new Date(Date.now() - 3600_000) } } });
  if (recent >= 3) throw new ValidationError("Three test texts were sent in the last hour. Wait before sending another.");
  const alert = await prisma.staffAlert.create({ data: { reason: "TEST", to: s.phone, body: TEST_TEXT, conversationIds: [], notBefore: new Date(), sentAt: new Date(), createdById: actor.id } });
  const res = await sendSms(s.phone, TEST_TEXT);
  await prisma.staffAlert.update({ where: { id: alert.id }, data: res.ok ? { status: "SENT", providerSid: res.sid ?? null, deliveryStatus: "accepted", statusDetail: res.detail } : { status: "FAILED", statusDetail: res.detail } });
  await prisma.auditLog.create({ data: { actorId: actor.id, action: "twilio.test_sent", entityType: "StaffAlert", entityId: alert.id, details: { ok: res.ok } } });
  if (!res.ok) throw new ValidationError(`Twilio didn't accept the test text: ${res.detail}.`);
  return alert.id;
}

/** Test results for Settings: Twilio's delivery status and replies from the office phone since each test. */
export async function testResults() {
  const s = await staffAlertSettings();
  const tests = await prisma.staffAlert.findMany({ where: { reason: "TEST" }, orderBy: { createdAt: "desc" }, take: 5 });
  const since = tests.at(-1)?.createdAt ?? new Date();
  const replies = await prisma.inboundSms.findMany({ where: { fromNormalized: s.phone, receivedAt: { gte: since } }, orderBy: { receivedAt: "desc" }, take: 10 });
  const recentAlerts = await prisma.staffAlert.findMany({ where: { reason: "CLIENT_MESSAGE" }, orderBy: { createdAt: "desc" }, take: 10 });
  return { settings: s, tests, replies, recentAlerts };
}
