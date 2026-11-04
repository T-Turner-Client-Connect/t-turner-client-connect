import "server-only";
import type { Appointment, Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { appUrl } from "@/lib/integrations";
import { brandedEmailHtml, sendEmail } from "@/lib/email";
import { sendSms, twilioConfigured } from "@/lib/twilio";
import { chicagoLocalToUtc, chicagoParts, fmtChicago, utcToChicagoLocal } from "@/lib/tz";
import { formatPhone, normalizePhone } from "@/lib/normalize";
import { MEETING_TYPES, serviceNames, smsServiceText } from "@/lib/appointments/services";
import { CLIENT_SMS_QUIET } from "./notifications";
import { smsSendAllowed } from "./sms-consent";
import { clientTextingOn, inWindow, nextWindowStart, staffAlertSettings } from "./staff-alerts";

/**
 * Appointment confirmations, reminders, changes and owner alerts. Each message
 * is a row in AppointmentNotice, keyed by appointment + kind + version +
 * audience + channel, so a confirmation is never sent twice. Texts to clients
 * go only through the existing Twilio integration, and only when the client
 * agreed to appointment texts, has service-text consent with no STOP, and the
 * owner's Client texting switch is on. Otherwise the text is recorded as
 * SKIPPED and the email still goes out.
 */

type Db = Prisma.TransactionClient | typeof prisma;

export const CLIENT_KINDS = ["REQUEST_RECEIVED", "CONFIRMATION", "RESCHEDULED", "RESCHEDULE_REQUEST_RECEIVED", "PROPOSED", "DECLINED", "RESCHEDULE_DECLINED", "CANCELLED", "REMINDER_24H", "REMINDER_2H"] as const;
export const OWNER_KINDS = ["OWNER_NEW_REQUEST", "OWNER_NEW_BOOKING", "OWNER_RESCHEDULE_REQUEST", "OWNER_CANCELLED", "OWNER_PROPOSAL_ACCEPTED", "OWNER_PROPOSAL_DECLINED", "OWNER_PENDING_REMINDER"] as const;
export type NoticeKind = (typeof CLIENT_KINDS)[number] | (typeof OWNER_KINDS)[number];

export const NOTICE_LABELS: Record<string, string> = {
  REQUEST_RECEIVED: "Request received",
  CONFIRMATION: "Confirmation",
  RESCHEDULED: "Updated confirmation (rescheduled)",
  RESCHEDULE_REQUEST_RECEIVED: "Reschedule request received",
  PROPOSED: "New time proposed",
  DECLINED: "Request declined",
  RESCHEDULE_DECLINED: "Reschedule declined",
  CANCELLED: "Cancellation notice",
  REMINDER_24H: "24-hour reminder",
  REMINDER_2H: "2-hour reminder",
  OWNER_NEW_REQUEST: "Owner alert: new request",
  OWNER_NEW_BOOKING: "Owner alert: new booking",
  OWNER_RESCHEDULE_REQUEST: "Owner alert: reschedule",
  OWNER_CANCELLED: "Owner alert: cancelled",
  OWNER_PROPOSAL_ACCEPTED: "Owner alert: proposal accepted",
  OWNER_PROPOSAL_DECLINED: "Owner alert: proposal declined",
  OWNER_PENDING_REMINDER: "Owner reminder: request waiting",
};

const S = "T. Turner & Associates";

export const manageLink = () => `${appUrl()}/client/appointments`;

/** "Tue, Nov 17, 2026" and "10:00 AM", office time. */
export function whenParts(d: Date) {
  return {
    day: fmtChicago(d, { weekday: "short", month: "short", day: "numeric", year: "numeric" }),
    time: fmtChicago(d, { hour: "numeric", minute: "2-digit" }),
  };
}

/**
 * The text for one client notice. Only the date, time (Central), service names
 * and a sign-in link: never notes, amounts, tax details or ID numbers.
 */
export function clientSmsText(kind: string, a: Pick<Appointment, "startsAt" | "services" | "pendingStartsAt">) {
  const at = (kind === "PROPOSED" || kind === "RESCHEDULE_REQUEST_RECEIVED") && a.pendingStartsAt ? a.pendingStartsAt : a.startsAt;
  const { day, time } = whenParts(at);
  const svc = smsServiceText(a.services);
  const manage = `Manage your appointment securely in Client Connect: ${manageLink()}.`;
  const stop = "Reply STOP to opt out.";
  switch (kind) {
    case "CONFIRMATION":
      return `${S}: Your appointment is confirmed for ${day} at ${time} CT for ${svc}. ${manage} ${stop}`;
    case "RESCHEDULED":
      return `${S}: Your appointment has been rescheduled and is confirmed for ${day} at ${time} CT for ${svc}. ${manage} ${stop}`;
    case "REQUEST_RECEIVED":
      return `${S}: We received your appointment request for ${day} at ${time} CT for ${svc}. We will confirm it soon. ${manage} ${stop}`;
    case "RESCHEDULE_REQUEST_RECEIVED":
      return `${S}: We received your request to move your appointment to ${day} at ${time} CT. Your current time stays reserved until we confirm. ${manage} ${stop}`;
    case "PROPOSED":
      return `${S}: We proposed a new time for your appointment: ${day} at ${time} CT. Please accept or decline it in Client Connect: ${manageLink()}. ${stop}`;
    case "DECLINED":
      return `${S}: We could not confirm your appointment request for ${day} at ${time} CT. Please choose another time in Client Connect: ${manageLink()}. ${stop}`;
    case "RESCHEDULE_DECLINED":
      return `${S}: Your appointment stays on ${day} at ${time} CT for ${svc}. ${manage} ${stop}`;
    case "CANCELLED":
      return `${S}: Your appointment for ${day} at ${time} CT has been cancelled. To book a new time, sign in to Client Connect: ${manageLink()}. ${stop}`;
    case "REMINDER_24H":
      return `${S}: Reminder: your appointment is coming up on ${day} at ${time} CT for ${svc}. ${manage} ${stop}`;
    case "REMINDER_2H":
      return `${S}: Reminder: your appointment is today at ${time} CT for ${svc}. ${manage} ${stop}`;
    default:
      return `${S}: There is an update to your appointment. ${manage} ${stop}`;
  }
}

const CLIENT_EMAIL_HEADINGS: Record<string, string> = {
  CONFIRMATION: "Your appointment is confirmed",
  RESCHEDULED: "Your appointment has been rescheduled",
  REQUEST_RECEIVED: "We received your appointment request",
  RESCHEDULE_REQUEST_RECEIVED: "We received your reschedule request",
  PROPOSED: "We proposed a new appointment time",
  DECLINED: "We couldn't confirm your appointment request",
  RESCHEDULE_DECLINED: "Your appointment time is unchanged",
  CANCELLED: "Your appointment has been cancelled",
  REMINDER_24H: "Reminder: your appointment is coming up",
  REMINDER_2H: "Reminder: your appointment is today",
};

function clientEmail(kind: string, a: Appointment) {
  const at = (kind === "PROPOSED" || kind === "RESCHEDULE_REQUEST_RECEIVED") && a.pendingStartsAt ? a.pendingStartsAt : a.startsAt;
  const { day, time } = whenParts(at);
  const heading = CLIENT_EMAIL_HEADINGS[kind] ?? "An update to your appointment";
  const how = a.meetingType && a.meetingType in MEETING_TYPES ? MEETING_TYPES[a.meetingType as keyof typeof MEETING_TYPES] : null;
  const paragraphs = [
    `${heading}.`,
    `Date and time: ${day} at ${time} Central Time (CT).`,
    `Service${a.services.length === 1 ? "" : "s"}: ${serviceNames(a.services).join(", ") || a.title}.${a.durationMin ? ` Scheduled for ${a.durationMin} minutes.` : ""}`,
    ...(how ? [`Meeting type: ${how}.`] : []),
    kind === "PROPOSED" ? "Sign in to Client Connect to accept or decline the new time." : "Sign in to Client Connect to view, reschedule or cancel your appointment.",
  ];
  return { subject: `${heading} — ${S}`, text: [...paragraphs, `Manage your appointment: ${manageLink()}`].join("\n\n"), html: brandedEmailHtml({ heading, paragraphs, button: { label: "Manage your appointment", url: manageLink() }, note: "For your privacy we never include tax details or account numbers in email. The link asks you to sign in." }) };
}

const OWNER_LINES: Record<string, string> = {
  OWNER_NEW_REQUEST: "New appointment request",
  OWNER_NEW_BOOKING: "New appointment booked",
  OWNER_RESCHEDULE_REQUEST: "Appointment reschedule",
  OWNER_CANCELLED: "Appointment cancelled by the client",
  OWNER_PROPOSAL_ACCEPTED: "Proposed time accepted",
  OWNER_PROPOSAL_DECLINED: "Proposed time declined",
  OWNER_PENDING_REMINDER: "Appointment request still waiting for you",
};

function ownerMessages(kind: string, a: Appointment, clientName: string) {
  const at = kind === "OWNER_RESCHEDULE_REQUEST" && a.pendingStartsAt ? a.pendingStartsAt : a.startsAt;
  const { day, time } = whenParts(at);
  const line = OWNER_LINES[kind] ?? "Appointment update";
  const link = `${appUrl()}/owner/appointments?appt=${a.id}`;
  // Texts to the office phone carry no client name or details.
  const sms = `TTurner Client Connect: ${line} for ${day} at ${time} CT. Sign in to review: ${appUrl()}/owner/appointments`;
  const paragraphs = [`${line}: ${clientName}.`, `${day} at ${time} CT · ${serviceNames(a.services).join(", ") || a.title}${a.durationMin ? ` · ${a.durationMin} min` : ""}.`, "Sign in to approve, decline or propose a new time."];
  return { sms, subject: `${line} — ${day} ${time} CT`, text: [...paragraphs, link].join("\n\n"), html: brandedEmailHtml({ heading: line, paragraphs, button: { label: "Open the appointment calendar", url: link } }) };
}

async function clientAddresses(db: Db, a: Appointment) {
  const info = (a.bookingInfo ?? {}) as { email?: string; phone?: string };
  const pu = a.bookedByPortalUserId ? await db.portalUser.findUnique({ where: { id: a.bookedByPortalUserId } }) : null;
  const client = await db.client.findUnique({ where: { id: a.clientId }, select: { email: true, phoneNormalized: true, displayName: true } });
  return {
    email: info.email ?? pu?.email ?? client?.email ?? null,
    phone: normalizePhone(info.phone ?? pu?.phoneNormalized ?? client?.phoneNormalized ?? null),
    clientName: client?.displayName ?? "Client",
  };
}

/** Records the messages for one change. Duplicate keys are ignored, so retries never double-send. */
export async function queueAppointmentNotices(db: Db, a: Appointment, kind: NoticeKind, ref?: string) {
  const owner = kind.startsWith("OWNER_");
  // Staff-added appointments only notify clients when they were booked in the portal.
  if (!owner && a.source !== "PORTAL") return;
  const addr = await clientAddresses(db, a);
  const base = `appt:${a.id}:${kind}:v${a.version}${ref ? `:${ref}` : ""}`;
  const rows: Prisma.AppointmentNoticeCreateManyInput[] = [];
  if (owner) {
    const s = await db.appointmentSettings.findUnique({ where: { id: "default" } });
    const m = ownerMessages(kind, a, addr.clientName);
    rows.push({ appointmentId: a.id, audience: "OWNER", channel: "EMAIL", kind, version: a.version, to: s?.alertEmail ?? "info@tturnerassociates.com", subject: m.subject, body: m.text, idempotencyKey: `${base}:OWNER:EMAIL` });
    rows.push({ appointmentId: a.id, audience: "OWNER", channel: "SMS", kind, version: a.version, to: s?.alertPhone ?? "+12054201825", body: m.sms, idempotencyKey: `${base}:OWNER:SMS` });
  } else {
    const e = clientEmail(kind, a);
    rows.push({ appointmentId: a.id, audience: "CLIENT", channel: "EMAIL", kind, version: a.version, to: addr.email, subject: e.subject, body: e.text, idempotencyKey: `${base}:CLIENT:EMAIL` });
    rows.push({ appointmentId: a.id, audience: "CLIENT", channel: "SMS", kind, version: a.version, to: addr.phone, body: clientSmsText(kind, a), idempotencyKey: `${base}:CLIENT:SMS` });
  }
  await db.appointmentNotice.createMany({ data: rows, skipDuplicates: true });
}

function nextClientTextWindow(now: Date) {
  const p = chicagoParts(now);
  const hhmm = `${String(p.hour).padStart(2, "0")}:${String(p.minute).padStart(2, "0")}`;
  if (hhmm >= CLIENT_SMS_QUIET.start && hhmm < CLIENT_SMS_QUIET.end) return null;
  const base = hhmm >= CLIENT_SMS_QUIET.end ? new Date(now.getTime() + 12 * 3600_000) : now;
  return chicagoLocalToUtc(`${utcToChicagoLocal(base).slice(0, 10)}T${CLIENT_SMS_QUIET.start}`)!;
}

type Gate = { skip: string } | { defer: Date } | { ok: true };

async function gate(n: { audience: string; channel: string; kind: string; to: string | null; version: number }, a: Appointment, now: Date): Promise<Gate> {
  if (n.audience === "CLIENT" && n.kind.startsWith("REMINDER") && (a.status !== "CONFIRMED" || a.version !== n.version)) return { skip: "The appointment changed before the reminder was due" };
  if (!n.to) return { skip: n.channel === "SMS" ? "No mobile number on the booking" : "No email address on the booking" };
  if (n.channel === "EMAIL") {
    const stop = await prisma.suppression.findFirst({ where: { channel: "EMAIL", addressNormalized: n.to.toLowerCase(), liftedAt: null } });
    if (stop) return { skip: "This email address is suppressed (unsubscribed or bounced)" };
    if (n.audience === "CLIENT" && n.kind.startsWith("REMINDER") && a.bookedByPortalUserId) {
      const pu = await prisma.portalUser.findUnique({ where: { id: a.bookedByPortalUserId }, select: { notifyByEmail: true } });
      if (pu && !pu.notifyByEmail) return { skip: "The client turned off email notices" };
    }
    return { ok: true };
  }
  if (n.audience === "OWNER") {
    const s = await staffAlertSettings();
    if (!s.smsEnabled) return { skip: `Staff text alerts are off in Settings — text to ${formatPhone(n.to)} is pending until they are turned on` };
    if (!twilioConfigured()) return { skip: "Text provider (Twilio) not set up" };
    if (!inWindow(now, s.windowStart, s.windowEnd)) return { defer: nextWindowStart(now, s.windowStart, s.windowEnd) };
    return { ok: true };
  }
  if (!a.smsOptIn) return { skip: "The client didn't agree to appointment texts for this booking" };
  if (!(await clientTextingOn())) return { skip: "Client texting is off (Settings); the email notice is unaffected" };
  const allowed = await smsSendAllowed(n.to, "SERVICE");
  if (!allowed.ok) return { skip: allowed.reason ?? "No service text consent on file" };
  if (!twilioConfigured()) return { skip: "Text provider (Twilio) not set up" };
  const later = nextClientTextWindow(now);
  if (later) return { defer: later };
  return { ok: true };
}

/** A client message that didn't go through: the appointment stays; staff get a follow-up task. */
async function staffFollowUp(a: Appointment, n: { id: string; channel: string; kind: string }, detail: string) {
  const { defaultStaffId } = await import("./appointments");
  const candidates = [a.staffId, await defaultStaffId()].filter((x): x is string => !!x);
  const user = await prisma.user.findFirst({ where: { id: { in: candidates }, active: true }, select: { id: true } });
  const { day, time } = whenParts(a.startsAt);
  if (user) {
    await prisma.task.create({
      data: {
        title: `Appointment ${n.channel === "SMS" ? "text" : "email"} didn't go through — contact the client`,
        details: `The ${NOTICE_LABELS[n.kind] ?? n.kind} for the appointment on ${day} at ${time} CT failed (${detail}). The appointment is still on the calendar. Please confirm with the client another way.`,
        priority: "HIGH",
        dueAt: new Date(),
        clientId: a.clientId,
        assigneeId: user.id,
        createdById: user.id,
      },
    });
  }
  await prisma.appointmentEvent.create({ data: { appointmentId: a.id, action: "notice_failed", actorType: "SYSTEM", details: { noticeId: n.id, channel: n.channel, kind: n.kind, taskCreated: !!user } } });
  await prisma.auditLog.create({ data: { actorId: null, action: "appointment.notice_failed", entityType: "Appointment", entityId: a.id, clientId: a.clientId, details: { channel: n.channel, kind: n.kind } } });
}

/** Sends every due notice once. Safe to run often: each row is claimed before it is sent. */
export async function dispatchAppointmentNotices(now = new Date()) {
  const due = await prisma.appointmentNotice.findMany({ where: { status: "PENDING", notBefore: { lte: now } }, include: { appointment: true }, orderBy: { createdAt: "asc" }, take: 100 });
  let sent = 0;
  for (const n of due) {
    const g = await gate(n, n.appointment, now);
    if ("skip" in g) {
      await prisma.appointmentNotice.updateMany({ where: { id: n.id, status: "PENDING" }, data: { status: "SKIPPED", statusDetail: g.skip } });
      continue;
    }
    if ("defer" in g) {
      await prisma.appointmentNotice.updateMany({ where: { id: n.id, status: "PENDING" }, data: { notBefore: g.defer, statusDetail: n.audience === "CLIENT" ? "Held for quiet hours — sends after 8 a.m. Central" : "Held until the staff text window opens" } });
      continue;
    }
    const claimed = await prisma.appointmentNotice.updateMany({ where: { id: n.id, status: "PENDING", sentAt: null }, data: { sentAt: now } });
    if (claimed.count !== 1) continue;
    let result: { ok: boolean; detail: string; sid?: string | null; skipped?: boolean };
    if (n.channel === "SMS") {
      const r = await sendSms(n.to!, n.body);
      result = { ok: r.ok, detail: r.detail, sid: r.sid ?? null };
    } else {
      const html = n.audience === "CLIENT" ? clientEmail(n.kind, n.appointment).html : ownerMessages(n.kind, n.appointment, "").html;
      const r = await sendEmail({ to: n.to!, subject: n.subject ?? "Appointment update", text: n.body, html, idempotencyKey: n.idempotencyKey, tags: { category: "appointment" } });
      result = r.ok ? { ok: true, detail: "Accepted by email provider", sid: r.providerId ? `email:${r.providerId}` : null } : { ok: false, detail: r.detail, skipped: r.reason === "not_configured" };
    }
    await prisma.appointmentNotice.update({
      where: { id: n.id },
      data: result.ok
        ? { status: "SENT", statusDetail: result.detail, providerSid: result.sid ?? null, deliveryStatus: "accepted" }
        : { status: result.skipped ? "SKIPPED" : "FAILED", statusDetail: result.detail, sentAt: null },
    });
    if (result.ok) sent++;
    else if (!result.skipped && n.audience === "CLIENT") await staffFollowUp(n.appointment, n, result.detail);
  }
  return sent;
}

const HOUR = 3600_000;

/**
 * Hourly (with the automations cron): 24-hour and 2-hour reminders for
 * confirmed portal bookings, once per appointment version, and a daily nudge
 * to the owner for requests still waiting.
 */
export async function runAppointmentReminders(now = new Date()) {
  const s = await prisma.appointmentSettings.findUnique({ where: { id: "default" } });
  const remind24h = s?.remind24h ?? true;
  const remind2h = s?.remind2h ?? true;
  const soon = await prisma.appointment.findMany({ where: { status: "CONFIRMED", source: "PORTAL", startsAt: { gt: now, lte: new Date(now.getTime() + 24 * HOUR) } } });
  let queued = 0;
  for (const a of soon) {
    const left = a.startsAt.getTime() - now.getTime();
    const kinds: NoticeKind[] = [];
    // A confirmation sent inside the window already serves as that reminder.
    const confirmedBefore = (h: number) => !a.confirmedAt || a.confirmedAt.getTime() <= a.startsAt.getTime() - h * HOUR;
    if (remind24h && left <= 24 * HOUR && left > 2 * HOUR && confirmedBefore(24)) kinds.push("REMINDER_24H");
    if (remind2h && left <= 2 * HOUR && confirmedBefore(2)) kinds.push("REMINDER_2H");
    for (const k of kinds) {
      const before = await prisma.appointmentNotice.count({ where: { appointmentId: a.id, kind: k, version: a.version } });
      if (before) continue;
      await queueAppointmentNotices(prisma, a, k);
      queued++;
    }
  }
  const waiting = await prisma.appointment.findMany({ where: { status: { in: ["REQUESTED", "RESCHEDULE_REQUESTED"] }, updatedAt: { lte: new Date(now.getTime() - 24 * HOUR) }, startsAt: { gt: now } } });
  for (const a of waiting) await queueAppointmentNotices(prisma, a, "OWNER_PENDING_REMINDER", utcToChicagoLocal(now).slice(0, 10));
  await dispatchAppointmentNotices(now);
  return { reminders: queued, ownerNudges: waiting.length };
}
