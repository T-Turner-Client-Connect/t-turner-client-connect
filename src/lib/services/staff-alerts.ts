import "server-only";
import { prisma } from "@/lib/prisma";
import { assertAdmin, type Actor } from "@/lib/auth/actor";
import { normalizePhone } from "@/lib/normalize";
import { sendSms, twilioConfigured } from "@/lib/twilio";
import { chicagoLocalToUtc, chicagoParts } from "@/lib/tz";
import { ValidationError } from "./clients";

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

export async function updateStaffAlertSettings(actor: Actor, input: { smsEnabled: boolean; phone: string; windowStart: string; windowEnd: string }) {
  assertAdmin(actor);
  const phone = normalizePhone(input.phone);
  if (!phone) throw new ValidationError("Enter a valid US phone number for staff alerts.");
  if (!/^\d{2}:\d{2}$/.test(input.windowStart) || !/^\d{2}:\d{2}$/.test(input.windowEnd) || input.windowStart >= input.windowEnd) throw new ValidationError("Choose a start time before the end time.");
  if (input.smsEnabled && !twilioConfigured()) throw new ValidationError("Connect Twilio first (TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_MESSAGING_SERVICE_SID).");
  await staffAlertSettings();
  await prisma.staffAlertSettings.update({ where: { id: "default" }, data: { smsEnabled: input.smsEnabled, phone, windowStart: input.windowStart, windowEnd: input.windowEnd, updatedById: actor.id } });
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

/** Called whenever a client sends something. Combines with any alert still waiting. */
export async function queueStaffAlert(conversationId: string) {
  const s = await staffAlertSettings();
  if (!s.smsEnabled || !twilioConfigured()) return;
  const now = new Date();
  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('staff-alert-queue'))`;
    const pending = await tx.staffAlert.findFirst({ where: { reason: "CLIENT_MESSAGE", status: "PENDING" } });
    if (pending) {
      if (!pending.conversationIds.includes(conversationId)) await tx.staffAlert.update({ where: { id: pending.id }, data: { conversationIds: { push: conversationId } } });
      return;
    }
    await tx.staffAlert.create({ data: { reason: "CLIENT_MESSAGE", to: s.phone, body: STAFF_ALERT_TEXT, conversationIds: [conversationId], notBefore: nextWindowStart(now, s.windowStart, s.windowEnd) } });
  });
  await dispatchStaffAlerts(now);
}

/** Sends due alerts inside the window. Safe to run often: each alert is claimed once. */
export async function dispatchStaffAlerts(now = new Date()) {
  const s = await staffAlertSettings();
  if (!inWindow(now, s.windowStart, s.windowEnd)) return 0;
  const due = await prisma.staffAlert.findMany({ where: { reason: "CLIENT_MESSAGE", status: "PENDING", notBefore: { lte: now } } });
  let sent = 0;
  for (const a of due) {
    const stillOpen = await prisma.conversation.count({ where: { id: { in: a.conversationIds }, unreadByStaff: true, closedAt: null } });
    if (!stillOpen) {
      await prisma.staffAlert.updateMany({ where: { id: a.id, status: "PENDING" }, data: { status: "SKIPPED", statusDetail: "Already read or resolved before the alert window" } });
      continue;
    }
    if (!s.smsEnabled || !twilioConfigured()) {
      await prisma.staffAlert.updateMany({ where: { id: a.id, status: "PENDING" }, data: { status: "SKIPPED", statusDetail: "Staff text alerts are turned off" } });
      continue;
    }
    const claimed = await prisma.staffAlert.updateMany({ where: { id: a.id, status: "PENDING", sentAt: null }, data: { sentAt: now } });
    if (claimed.count !== 1) continue;
    const res = await sendSms(s.phone, a.body);
    await prisma.staffAlert.update({
      where: { id: a.id },
      data: res.ok ? { status: "SENT", providerSid: res.sid ?? null, deliveryStatus: "accepted", statusDetail: res.detail, to: s.phone } : { status: "FAILED", statusDetail: res.detail },
    });
    if (res.ok) sent++;
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
