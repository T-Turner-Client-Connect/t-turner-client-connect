import "server-only";
import { Prisma, type Appointment, type AppointmentSettings, type AppointmentStatus } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { audit } from "@/lib/audit";
import { ForbiddenError, type Actor } from "@/lib/auth/actor";
import { assertOwner } from "@/lib/auth/owner";
import { requireClientAccess } from "@/lib/portal/access";
import type { PortalActor } from "@/lib/portal/session";
import { formatPhone, isValidEmail, looksLikeTaxId, normalizeEmail, normalizePhone } from "@/lib/normalize";
import { utcToChicagoLocal } from "@/lib/tz";
import { SMS_CONSENT_TEXT } from "@/lib/business";
import { ValidationError } from "./clients";
import { applySmsConsent, smsSendAllowed } from "./sms-consent";
import { dispatchAppointmentNotices, queueAppointmentNotices } from "./appointment-notices";
import {
  APPOINTMENT_LENGTHS,
  appointmentMinutes,
  cleanServiceKeys,
  hasBusinessService,
  HOLDING_STATUSES,
  MEETING_TYPES,
  serviceNames,
  type MeetingType,
} from "@/lib/appointments/services";
import { atOffice, blocksFor, daySlots, monthDates, type Busy, type DateRule, type MonthConfig, type StaffHours } from "@/lib/appointments/availability";

type Db = Prisma.TransactionClient | typeof prisma;

const HOUR = 3600_000;
const LOCK = "appointments-calendar";
const MAX_UPCOMING_PER_CLIENT = 3;
const TAKEN = "That time is no longer available — someone may have just booked it. Please choose another time.";

export const officeDate = (d: Date) => utcToChicagoLocal(d).slice(0, 10);
export const officeTime = (d: Date) => utcToChicagoLocal(d).slice(11, 16);
const isDate = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`));
const isTime = (s: string) => /^([01]\d|2[0-3]):[0-5]\d$/.test(s);

// ---------------------------------------------------------------------------
// Settings, months, rules, staff
// ---------------------------------------------------------------------------

export async function appointmentSettings(db: Db = prisma): Promise<AppointmentSettings> {
  const found = await db.appointmentSettings.findUnique({ where: { id: "default" } });
  if (found) return found;
  return db.appointmentSettings.upsert({ where: { id: "default" }, update: {}, create: { id: "default" } });
}

/** The staff member who takes bookings when no staff schedule is set up: the owner. */
export async function defaultStaffId(db: Db = prisma): Promise<string> {
  const owner = await db.ownerAccess.findFirst({ where: { isPrimary: true, revokedAt: null, user: { active: true } }, select: { userId: true } });
  if (owner) return owner.userId;
  const admin = await db.user.findFirst({ where: { role: "ADMIN", active: true }, orderBy: { createdAt: "asc" }, select: { id: true } });
  return admin?.id ?? "office";
}

export async function bookableStaff(db: Db = prisma): Promise<StaffHours[]> {
  const rows = await db.appointmentStaff.findMany({ where: { active: true }, orderBy: [{ sortOrder: "asc" }, { updatedAt: "asc" }] });
  const live = rows.length ? new Set((await db.user.findMany({ where: { id: { in: rows.map((r) => r.userId) }, active: true }, select: { id: true } })).map((u) => u.id)) : new Set<string>();
  const staff = rows.filter((r) => live.has(r.userId)).map((r) => ({ userId: r.userId, weekdays: r.weekdays, startTime: r.startTime, endTime: r.endTime }));
  if (staff.length) return staff;
  return [{ userId: await defaultStaffId(db), weekdays: [1, 2, 3, 4, 5, 6, 7], startTime: null, endTime: null }];
}

const ACTIVE = { in: [...HOLDING_STATUSES] as AppointmentStatus[] };

/** Everything that decides availability between two office dates (inclusive). */
async function calendarContext(db: Db, fromDate: string, toDate: string) {
  const from = atOffice(fromDate, "00:00");
  const to = new Date(atOffice(toDate, "00:00").getTime() + 26 * HOUR);
  const [y1, m1] = fromDate.split("-").map(Number);
  const [y2, m2] = toDate.split("-").map(Number);
  const [settings, months, rules, staff, appts] = await Promise.all([
    appointmentSettings(db),
    db.appointmentMonth.findMany({ where: { OR: [{ year: y1, month: m1 }, { year: y2, month: m2 }] } }),
    db.appointmentDateRule.findMany({ where: { date: { gte: fromDate, lte: toDate } } }),
    bookableStaff(db),
    db.appointment.findMany({
      where: { status: ACTIVE, OR: [{ startsAt: { gte: new Date(from.getTime() - 4 * HOUR), lt: to } }, { pendingStartsAt: { gte: new Date(from.getTime() - 4 * HOUR), lt: to } }] },
      select: { id: true, startsAt: true, endsAt: true, staffId: true, pendingStartsAt: true, pendingEndsAt: true, pendingStaffId: true },
    }),
  ]);
  const busy: Busy[] = [];
  const perDay = new Map<string, Set<string>>();
  const countOn = (date: string, id: string) => perDay.set(date, (perDay.get(date) ?? new Set()).add(id));
  for (const a of appts) {
    busy.push({ start: a.startsAt, end: a.endsAt ?? new Date(a.startsAt.getTime() + HOUR), staffId: a.staffId, appointmentId: a.id });
    countOn(officeDate(a.startsAt), a.id);
    if (a.pendingStartsAt && a.pendingEndsAt) {
      busy.push({ start: a.pendingStartsAt, end: a.pendingEndsAt, staffId: a.pendingStaffId ?? a.staffId, appointmentId: a.id });
      countOn(officeDate(a.pendingStartsAt), a.id);
    }
  }
  const monthFor = (date: string): MonthConfig | null => {
    const [y, m] = date.split("-").map(Number);
    return months.find((x) => x.year === y && x.month === m) ?? null;
  };
  return { settings, rules: rules as DateRule[], staff, busy, perDay, monthFor };
}

type Ctx = Awaited<ReturnType<typeof calendarContext>>;

function slotsFrom(ctx: Ctx, date: string, minutes: number, now: Date, ignoreAppointmentId?: string) {
  const day = ctx.perDay.get(date) ?? new Set<string>();
  return daySlots({
    date,
    minutes,
    month: ctx.monthFor(date),
    rules: ctx.rules,
    staff: ctx.staff,
    busy: ctx.busy,
    dayCount: [...day].filter((id) => id !== ignoreAppointmentId).length,
    stepMin: ctx.settings.slotStepMin,
    earliest: new Date(now.getTime() + ctx.settings.minNoticeHours * HOUR),
    ignoreAppointmentId,
  });
}

export type MonthAvailability = {
  year: number;
  month: number;
  published: boolean;
  // date → length (minutes) → open "HH:MM" start times
  days: Record<string, Record<number, string[]>>;
};

/** Open times for every length in one month (clients see only published months). */
export async function monthAvailability(year: number, month: number, now = new Date(), ignoreAppointmentId?: string): Promise<MonthAvailability> {
  if (!Number.isInteger(year) || !Number.isInteger(month) || month < 1 || month > 12 || year < 2020 || year > 2100) throw new ValidationError("Choose a valid month.");
  const dates = monthDates(year, month);
  const ctx = await calendarContext(prisma, dates[0], dates.at(-1)!);
  const m = ctx.monthFor(dates[0]);
  const today = officeDate(now);
  const days: MonthAvailability["days"] = {};
  if (m?.publishedAt) {
    for (const d of dates) {
      if (d < today) continue;
      const byLen: Record<number, string[]> = {};
      for (const len of APPOINTMENT_LENGTHS) byLen[len] = slotsFrom(ctx, d, len, now, ignoreAppointmentId).map((s) => s.time);
      if (Object.values(byLen).some((t) => t.length)) days[d] = byLen;
    }
  }
  return { year, month, published: !!m?.publishedAt, days };
}

/** Re-checks one start time with fresh data (inside the booking transaction). */
async function findSlot(db: Db, date: string, time: string, minutes: number, now: Date, ignoreAppointmentId?: string) {
  const ctx = await calendarContext(db, date, date);
  return slotsFrom(ctx, date, minutes, now, ignoreAppointmentId).find((s) => s.time === time) ?? null;
}

/** Claims every 15-minute block for this staff member; the unique index rejects a double booking. */
async function claimBlocks(tx: Prisma.TransactionClient, appointmentId: string, staffId: string, start: Date, end: Date, kind: "CURRENT" | "PENDING") {
  const own = new Set((await tx.appointmentSlotClaim.findMany({ where: { appointmentId, staffId }, select: { blockStart: true } })).map((c) => c.blockStart.getTime()));
  const data = blocksFor(start, end)
    .filter((b) => !own.has(b.getTime()))
    .map((blockStart) => ({ appointmentId, staffId, blockStart, kind }));
  if (data.length) await tx.appointmentSlotClaim.createMany({ data });
}

async function lock(tx: Prisma.TransactionClient) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${LOCK}))`;
}

function isUniqueViolation(err: unknown) {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002";
}

async function inCalendarTx<T>(fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  try {
    return await prisma.$transaction(async (tx) => {
      await lock(tx);
      return fn(tx);
    }, { timeout: 20_000, maxWait: 20_000 });
  } catch (err) {
    if (isUniqueViolation(err)) throw new ValidationError(TAKEN);
    throw err;
  }
}

function event(tx: Db, appointmentId: string, action: string, actor: { type: "CLIENT" | "STAFF" | "SYSTEM"; id: string | null }, from: string | null, to: string | null, details?: Record<string, unknown>) {
  return tx.appointmentEvent.create({ data: { appointmentId, action, actorType: actor.type, actorId: actor.id, fromStatus: from, toStatus: to, details: details as Prisma.InputJsonValue | undefined } });
}

// ---------------------------------------------------------------------------
// Booking information (prefilled from the master Client record)
// ---------------------------------------------------------------------------

export type BookingProfile = {
  legalName: string;
  phone: string;
  email: string;
  existingClient: boolean;
  businessName: string | null;
  businessAccount: boolean;
  smsConsentOnFile: boolean;
};

/** What's already on file for this login and account — the booking form shows it with a "change" option. */
export async function bookingProfile(portalUserId: string, clientId: string): Promise<BookingProfile> {
  await requireClientAccess(portalUserId, clientId);
  const [pu, client] = await Promise.all([
    prisma.portalUser.findUniqueOrThrow({ where: { id: portalUserId }, include: { contact: true } }),
    prisma.client.findUniqueOrThrow({ where: { id: clientId } }),
  ]);
  const individual = client.clientType === "INDIVIDUAL";
  const legalName = individual
    ? [client.firstName, client.middleName, client.lastName].filter(Boolean).join(" ") || client.displayName
    : pu.contact?.name || pu.name;
  const phoneE164 = pu.phoneNormalized || pu.contact?.phoneNormalized || client.phoneNormalized || normalizePhone(pu.phone ?? client.phone);
  const sms = phoneE164 ? (await smsSendAllowed(phoneE164, "SERVICE")).ok : false;
  return {
    legalName,
    phone: phoneE164 ? formatPhone(phoneE164) : "",
    email: pu.email,
    existingClient: client.status !== "PROSPECT",
    businessName: client.businessName ?? (individual ? null : client.displayName),
    businessAccount: !individual,
    smsConsentOnFile: sms,
  };
}

export type BookingInfoInput = {
  legalName?: string;
  phone?: string;
  email?: string;
  clientKind?: string; // NEW | EXISTING
  meetingType?: string;
  reason?: string;
  businessName?: string;
  smsConsent?: boolean;
};

export type BookingInfo = {
  legalName: string;
  phone: string; // E.164
  email: string;
  clientKind: "NEW" | "EXISTING";
  meetingType: MeetingType;
  reason: string;
  businessName: string | null;
  smsConsent: boolean;
  // Fields that differ from what's on file (staff review them; the master record is not changed).
  changed: string[];
};

export function resolveBookingInfo(profile: BookingProfile, raw: BookingInfoInput, settings: Pick<AppointmentSettings, "meetingTypes">, services: string[]): BookingInfo {
  const legalName = (raw.legalName?.trim() || profile.legalName).replace(/\s+/g, " ").slice(0, 120);
  if (!legalName) throw new ValidationError("Enter your full legal name.");
  const phone = normalizePhone(raw.phone?.trim() || profile.phone);
  if (!phone) throw new ValidationError("Enter a valid 10-digit US mobile phone number.");
  const email = normalizeEmail(raw.email?.trim() || profile.email);
  if (!email || !isValidEmail(email)) throw new ValidationError("Enter a valid email address.");
  const clientKind = raw.clientKind === "NEW" || raw.clientKind === "EXISTING" ? raw.clientKind : profile.existingClient ? "EXISTING" : "NEW";
  const meetingType = raw.meetingType as MeetingType;
  if (!meetingType || !(meetingType in MEETING_TYPES) || !settings.meetingTypes.includes(meetingType)) throw new ValidationError("Choose how you'd like to meet.");
  const reason = (raw.reason ?? "").trim().slice(0, 500);
  if (reason.length < 3) throw new ValidationError("Add a brief reason for the appointment.");
  if (looksLikeTaxId(reason) || /\b\d{3}[- ]?\d{2}[- ]?\d{4}\b/.test(reason)) throw new ValidationError("For your security, please don't include Social Security or tax ID numbers. You can share them securely at your appointment.");
  const businessName = (raw.businessName?.trim() || profile.businessName || "").slice(0, 160) || null;
  if (hasBusinessService(services) && !businessName) throw new ValidationError("Enter the business name for this appointment.");
  const smsConsent = !!raw.smsConsent;
  const changed = [
    legalName !== profile.legalName && "legalName",
    phone !== normalizePhone(profile.phone) && "phone",
    email !== normalizeEmail(profile.email) && "email",
    (clientKind === "EXISTING") !== profile.existingClient && "clientKind",
    businessName !== (profile.businessName ?? null) && !!profile.businessName && "businessName",
  ].filter((x): x is string => !!x);
  return { legalName, phone, email, clientKind, meetingType, reason, businessName, smsConsent, changed };
}

// ---------------------------------------------------------------------------
// Client actions (portal)
// ---------------------------------------------------------------------------

const clientActor = (u: PortalActor) => ({ type: "CLIENT" as const, id: u.id });

export async function bookAppointment(user: PortalActor, input: { clientId: string; services: string[]; date: string; time: string; info: BookingInfoInput }, now = new Date()) {
  await requireClientAccess(user.id, input.clientId);
  const keys = cleanServiceKeys(input.services);
  if (!keys.length) throw new ValidationError("Choose at least one service.");
  if (keys.length !== new Set(input.services).size) throw new ValidationError("One of the selected services isn't offered online.");
  // Longest selected service, never more than two hours — decided here, not by the browser.
  const minutes = appointmentMinutes(keys);
  if (!isDate(input.date) || !isTime(input.time)) throw new ValidationError("Choose a date and time.");
  const settings = await appointmentSettings();
  const profile = await bookingProfile(user.id, input.clientId);
  const info = resolveBookingInfo(profile, input.info, settings, keys);
  const upcoming = await prisma.appointment.count({ where: { clientId: input.clientId, status: ACTIVE, startsAt: { gt: now } } });
  if (upcoming >= MAX_UPCOMING_PER_CLIENT) throw new ValidationError(`This account already has ${upcoming} upcoming appointments. Please reschedule or cancel one first, or call the office.`);

  const appt = await inCalendarTx(async (tx) => {
    const slot = await findSlot(tx, input.date, input.time, minutes, now);
    if (!slot) throw new ValidationError(TAKEN);
    const status: AppointmentStatus = settings.requireApproval ? "REQUESTED" : "CONFIRMED";
    const a = await tx.appointment.create({
      data: {
        clientId: input.clientId,
        title: serviceNames(keys).join(" + "),
        startsAt: slot.start,
        endsAt: slot.end,
        durationMin: minutes,
        staffId: slot.staffId,
        status,
        source: "PORTAL",
        services: keys,
        meetingType: info.meetingType,
        location: MEETING_TYPES[info.meetingType],
        clientNotes: info.reason,
        bookedByPortalUserId: user.id,
        bookingInfo: info as unknown as Prisma.InputJsonValue,
        smsOptIn: info.smsConsent,
        createdById: user.id,
        confirmedAt: status === "CONFIRMED" ? now : null,
      },
    });
    await claimBlocks(tx, a.id, slot.staffId, slot.start, slot.end, "CURRENT");
    await event(tx, a.id, "booked", clientActor(user), null, status, { services: keys, minutes, date: input.date, time: input.time, meetingType: info.meetingType });
    if (info.changed.length) await event(tx, a.id, "booking_info_differs", clientActor(user), null, null, { fields: info.changed });
    await audit(tx, { actorId: null, action: "appointment.booked_by_client", entityType: "Appointment", entityId: a.id, clientId: input.clientId, details: { portalUserId: user.id, status } });
    await queueAppointmentNotices(tx, a, status === "CONFIRMED" ? "CONFIRMATION" : "REQUEST_RECEIVED");
    await queueAppointmentNotices(tx, a, status === "CONFIRMED" ? "OWNER_NEW_BOOKING" : "OWNER_NEW_REQUEST");
    return a;
  });

  // Appointment texts need service-text consent on the phone ledger (never marketing consent).
  if (info.smsConsent) {
    const allowed = await smsSendAllowed(info.phone, "SERVICE");
    if (!allowed.ok) {
      await prisma.$transaction((tx) =>
        applySmsConsent(tx, info.phone, "SERVICE", "GRANTED", { source: "APPOINTMENT_BOOKING", sourcePage: "/client/appointments", consentText: SMS_CONSENT_TEXT.SERVICE, note: `Appointment ${appt.id}` }),
      );
    }
  }
  await dispatchAppointmentNotices(now);
  return appt;
}

/** The client's own view: never staff notes. */
export type ClientAppointment = {
  id: string;
  title: string;
  services: string[];
  startsAt: Date;
  endsAt: Date;
  durationMin: number;
  status: AppointmentStatus;
  meetingType: string | null;
  pendingStartsAt: Date | null;
  pendingBy: string | null;
  canChange: boolean;
  changeNote: string | null;
};

export function changePolicy(a: Pick<Appointment, "status" | "startsAt">, settings: Pick<AppointmentSettings, "cancelCutoffHours">, now = new Date()): { ok: boolean; reason: string | null } {
  if (!["REQUESTED", "CONFIRMED", "PROPOSED", "RESCHEDULE_REQUESTED"].includes(a.status)) return { ok: false, reason: "This appointment can no longer be changed online." };
  if (a.startsAt.getTime() - now.getTime() < settings.cancelCutoffHours * HOUR) {
    return { ok: false, reason: `Changes within ${settings.cancelCutoffHours} hours of the appointment must be made by calling the office.` };
  }
  return { ok: true, reason: null };
}

export async function portalAppointments(portalUserId: string, clientId: string, now = new Date()) {
  await requireClientAccess(portalUserId, clientId);
  const settings = await appointmentSettings();
  const rows = await prisma.appointment.findMany({ where: { clientId }, orderBy: { startsAt: "asc" } });
  const map = (a: Appointment): ClientAppointment => {
    const p = changePolicy(a, settings, now);
    return {
      id: a.id,
      title: a.title,
      services: a.services,
      startsAt: a.startsAt,
      endsAt: a.endsAt ?? new Date(a.startsAt.getTime() + HOUR),
      durationMin: a.durationMin ?? 60,
      status: a.status,
      meetingType: a.meetingType,
      pendingStartsAt: a.pendingStartsAt,
      pendingBy: a.pendingBy,
      canChange: p.ok,
      changeNote: p.reason,
    };
  };
  const upcoming = rows.filter((a) => (a.endsAt ?? a.startsAt) > now && (HOLDING_STATUSES as readonly string[]).includes(a.status)).map(map);
  const past = rows.filter((a) => !upcoming.some((u) => u.id === a.id)).reverse().slice(0, 10).map(map);
  return { upcoming, past, settings: { cancelCutoffHours: settings.cancelCutoffHours, rescheduleNeedsApproval: settings.rescheduleNeedsApproval, requireApproval: settings.requireApproval, meetingTypes: settings.meetingTypes } };
}

/** Loads an appointment the portal user may act on (their own account only). */
async function ownAppointment(user: PortalActor, appointmentId: string) {
  const a = await prisma.appointment.findUnique({ where: { id: appointmentId } });
  // Same answer for "doesn't exist" and "not yours".
  if (!a) throw new ForbiddenError("You don't have access to that appointment.");
  await requireClientAccess(user.id, a.clientId).catch(() => {
    throw new ForbiddenError("You don't have access to that appointment.");
  });
  return a;
}

export async function clientCancelAppointment(user: PortalActor, appointmentId: string, now = new Date()) {
  const a = await ownAppointment(user, appointmentId);
  const settings = await appointmentSettings();
  const p = changePolicy(a, settings, now);
  if (!p.ok) throw new ValidationError(p.reason!);
  await inCalendarTx(async (tx) => {
    const updated = await tx.appointment.update({ where: { id: a.id }, data: { status: "CANCELLED", cancelledAt: now, pendingStartsAt: null, pendingEndsAt: null, pendingStaffId: null, pendingBy: null } });
    await tx.appointmentSlotClaim.deleteMany({ where: { appointmentId: a.id } });
    await event(tx, a.id, "cancelled", clientActor(user), a.status, "CANCELLED");
    await audit(tx, { actorId: null, action: "appointment.cancelled_by_client", entityType: "Appointment", entityId: a.id, clientId: a.clientId, details: { portalUserId: user.id } });
    await queueAppointmentNotices(tx, updated, "CANCELLED");
    await queueAppointmentNotices(tx, updated, "OWNER_CANCELLED");
  });
  await dispatchAppointmentNotices(now);
}

export async function clientRescheduleAppointment(user: PortalActor, appointmentId: string, input: { date: string; time: string }, now = new Date()) {
  const a = await ownAppointment(user, appointmentId);
  if (a.status === "RESCHEDULE_REQUESTED" || a.status === "PROPOSED") throw new ValidationError("A new time is already waiting for an answer. Please wait for the office, or cancel and book again.");
  const settings = await appointmentSettings();
  const p = changePolicy(a, settings, now);
  if (!p.ok) throw new ValidationError(p.reason!);
  if (!isDate(input.date) || !isTime(input.time)) throw new ValidationError("Choose a new date and time.");
  const minutes = Math.min(a.durationMin ?? appointmentMinutes(a.services), 120);
  const result = await inCalendarTx(async (tx) => {
    const slot = await findSlot(tx, input.date, input.time, minutes, now, a.id);
    if (!slot) throw new ValidationError(TAKEN);
    const needsApproval = settings.rescheduleNeedsApproval && a.status === "CONFIRMED";
    if (needsApproval) {
      // Both times stay held until the owner answers.
      const updated = await tx.appointment.update({ where: { id: a.id }, data: { status: "RESCHEDULE_REQUESTED", pendingStartsAt: slot.start, pendingEndsAt: slot.end, pendingStaffId: slot.staffId, pendingBy: "CLIENT" } });
      await claimBlocks(tx, a.id, slot.staffId, slot.start, slot.end, "PENDING");
      await event(tx, a.id, "reschedule_requested", clientActor(user), a.status, "RESCHEDULE_REQUESTED", { from: a.startsAt.toISOString(), to: slot.start.toISOString() });
      await queueAppointmentNotices(tx, updated, "RESCHEDULE_REQUEST_RECEIVED");
      await queueAppointmentNotices(tx, updated, "OWNER_RESCHEDULE_REQUEST");
      return { pending: true };
    }
    await tx.appointmentSlotClaim.deleteMany({ where: { appointmentId: a.id } });
    const confirmed = a.status === "CONFIRMED";
    const updated = await tx.appointment.update({
      where: { id: a.id },
      data: { startsAt: slot.start, endsAt: slot.end, staffId: slot.staffId, version: { increment: 1 }, ...(confirmed ? { confirmedAt: now } : {}) },
    });
    await claimBlocks(tx, a.id, slot.staffId, slot.start, slot.end, "CURRENT");
    await event(tx, a.id, "rescheduled", clientActor(user), a.status, a.status, { from: a.startsAt.toISOString(), to: slot.start.toISOString() });
    await queueAppointmentNotices(tx, updated, confirmed ? "RESCHEDULED" : "REQUEST_RECEIVED");
    await queueAppointmentNotices(tx, updated, "OWNER_RESCHEDULE_REQUEST");
    return { pending: false };
  });
  await dispatchAppointmentNotices(now);
  return result;
}

/** The client answers a time the owner proposed. */
export async function clientAnswerProposal(user: PortalActor, appointmentId: string, accept: boolean, now = new Date()) {
  const a = await ownAppointment(user, appointmentId);
  if (a.status !== "PROPOSED" || !a.pendingStartsAt || !a.pendingEndsAt) throw new ValidationError("There's no proposed time to answer.");
  await inCalendarTx(async (tx) => {
    let updated: Appointment;
    if (accept) {
      // Release everything and claim the new time afresh (blocks shared with the old time included).
      await tx.appointmentSlotClaim.deleteMany({ where: { appointmentId: a.id } });
      await claimBlocks(tx, a.id, a.pendingStaffId ?? a.staffId ?? "office", a.pendingStartsAt!, a.pendingEndsAt!, "CURRENT");
      updated = await tx.appointment.update({
        where: { id: a.id },
        data: { status: "CONFIRMED", startsAt: a.pendingStartsAt!, endsAt: a.pendingEndsAt!, staffId: a.pendingStaffId ?? a.staffId, pendingStartsAt: null, pendingEndsAt: null, pendingStaffId: null, pendingBy: null, version: { increment: 1 }, confirmedAt: now },
      });
      await event(tx, a.id, "proposal_accepted", clientActor(user), "PROPOSED", "CONFIRMED");
      await queueAppointmentNotices(tx, updated, a.confirmedAt ? "RESCHEDULED" : "CONFIRMATION");
      await queueAppointmentNotices(tx, updated, "OWNER_PROPOSAL_ACCEPTED");
    } else {
      // A confirmed appointment keeps its original time; a new request that wasn't accepted ends.
      const back: AppointmentStatus = a.confirmedAt ? "CONFIRMED" : "CANCELLED";
      await tx.appointmentSlotClaim.deleteMany({ where: back === "CANCELLED" ? { appointmentId: a.id } : { appointmentId: a.id, kind: "PENDING" } });
      updated = await tx.appointment.update({
        where: { id: a.id },
        data: { status: back, pendingStartsAt: null, pendingEndsAt: null, pendingStaffId: null, pendingBy: null, ...(back === "CANCELLED" ? { cancelledAt: now } : {}) },
      });
      await event(tx, a.id, "proposal_declined", clientActor(user), "PROPOSED", back);
      await queueAppointmentNotices(tx, updated, "OWNER_PROPOSAL_DECLINED");
      if (back === "CANCELLED") await queueAppointmentNotices(tx, updated, "CANCELLED");
    }
  });
  await dispatchAppointmentNotices(now);
}

// ---------------------------------------------------------------------------
// Owner management (Owner's Office)
// ---------------------------------------------------------------------------

const staffActor = (a: Actor) => ({ type: "STAFF" as const, id: a.id });

async function loadForOwner(actor: Actor, appointmentId: string) {
  await assertOwner(actor);
  const a = await prisma.appointment.findUnique({ where: { id: appointmentId } });
  if (!a) throw new ValidationError("Appointment not found.");
  return a;
}

export async function ownerApprove(actor: Actor, appointmentId: string, now = new Date()) {
  const a = await loadForOwner(actor, appointmentId);
  await inCalendarTx(async (tx) => {
    if (a.status === "REQUESTED") {
      const updated = await tx.appointment.update({ where: { id: a.id }, data: { status: "CONFIRMED", confirmedAt: now } });
      await event(tx, a.id, "approved", staffActor(actor), "REQUESTED", "CONFIRMED");
      await queueAppointmentNotices(tx, updated, "CONFIRMATION");
    } else if (a.status === "RESCHEDULE_REQUESTED" && a.pendingStartsAt && a.pendingEndsAt) {
      // Release everything and claim the new time afresh (blocks shared with the old time included).
      await tx.appointmentSlotClaim.deleteMany({ where: { appointmentId: a.id } });
      await claimBlocks(tx, a.id, a.pendingStaffId ?? a.staffId ?? "office", a.pendingStartsAt!, a.pendingEndsAt!, "CURRENT");
      const updated = await tx.appointment.update({
        where: { id: a.id },
        data: { status: "CONFIRMED", startsAt: a.pendingStartsAt, endsAt: a.pendingEndsAt, staffId: a.pendingStaffId ?? a.staffId, pendingStartsAt: null, pendingEndsAt: null, pendingStaffId: null, pendingBy: null, version: { increment: 1 }, confirmedAt: now },
      });
      await event(tx, a.id, "reschedule_approved", staffActor(actor), "RESCHEDULE_REQUESTED", "CONFIRMED", { from: a.startsAt.toISOString(), to: a.pendingStartsAt.toISOString() });
      await queueAppointmentNotices(tx, updated, "RESCHEDULED");
    } else throw new ValidationError("Only requests waiting for approval can be approved.");
    await audit(tx, { actorId: actor.id, action: "appointment.approved", entityType: "Appointment", entityId: a.id, clientId: a.clientId });
  });
  await dispatchAppointmentNotices(now);
}

export async function ownerDecline(actor: Actor, appointmentId: string, note: string, now = new Date()) {
  const a = await loadForOwner(actor, appointmentId);
  await inCalendarTx(async (tx) => {
    if (a.status === "REQUESTED" || (a.status === "PROPOSED" && !a.confirmedAt)) {
      const updated = await tx.appointment.update({ where: { id: a.id }, data: { status: "DECLINED", pendingStartsAt: null, pendingEndsAt: null, pendingStaffId: null, pendingBy: null } });
      await tx.appointmentSlotClaim.deleteMany({ where: { appointmentId: a.id } });
      await event(tx, a.id, "declined", staffActor(actor), a.status, "DECLINED", note ? { note: note.slice(0, 500) } : undefined);
      await queueAppointmentNotices(tx, updated, "DECLINED");
    } else if (a.status === "RESCHEDULE_REQUESTED" || a.status === "PROPOSED") {
      const updated = await tx.appointment.update({ where: { id: a.id }, data: { status: "CONFIRMED", pendingStartsAt: null, pendingEndsAt: null, pendingStaffId: null, pendingBy: null } });
      await tx.appointmentSlotClaim.deleteMany({ where: { appointmentId: a.id, kind: "PENDING" } });
      await event(tx, a.id, "reschedule_declined", staffActor(actor), a.status, "CONFIRMED", note ? { note: note.slice(0, 500) } : undefined);
      await queueAppointmentNotices(tx, updated, "RESCHEDULE_DECLINED", a.pendingStartsAt?.toISOString());
    } else throw new ValidationError("Only requests waiting for an answer can be declined.");
    await audit(tx, { actorId: actor.id, action: "appointment.declined", entityType: "Appointment", entityId: a.id, clientId: a.clientId });
  });
  await dispatchAppointmentNotices(now);
}

/** Proposes a different time (the owner may choose any free time, even outside published hours). */
export async function ownerPropose(actor: Actor, appointmentId: string, input: { date: string; time: string }, now = new Date()) {
  const a = await loadForOwner(actor, appointmentId);
  if (!["REQUESTED", "RESCHEDULE_REQUESTED", "CONFIRMED", "PROPOSED"].includes(a.status)) throw new ValidationError("This appointment can't be moved.");
  if (!isDate(input.date) || !isTime(input.time)) throw new ValidationError("Choose a date and time to propose.");
  const minutes = a.durationMin ?? 60;
  const start = atOffice(input.date, input.time);
  const end = new Date(start.getTime() + minutes * 60_000);
  if (start <= now) throw new ValidationError("Propose a time in the future.");
  const staffId = a.staffId ?? (await defaultStaffId());
  await inCalendarTx(async (tx) => {
    const clash = await tx.appointment.findFirst({
      where: { id: { not: a.id }, status: ACTIVE, OR: [{ staffId }, { staffId: null }], startsAt: { lt: end }, endsAt: { gt: start } },
      select: { id: true },
    });
    if (clash) throw new ValidationError("That time overlaps another appointment.");
    await tx.appointmentSlotClaim.deleteMany({ where: { appointmentId: a.id, kind: "PENDING" } });
    await claimBlocks(tx, a.id, staffId, start, end, "PENDING");
    const updated = await tx.appointment.update({ where: { id: a.id }, data: { status: "PROPOSED", pendingStartsAt: start, pendingEndsAt: end, pendingStaffId: staffId, pendingBy: "OWNER" } });
    await event(tx, a.id, "new_time_proposed", staffActor(actor), a.status, "PROPOSED", { to: start.toISOString() });
    await audit(tx, { actorId: actor.id, action: "appointment.proposed", entityType: "Appointment", entityId: a.id, clientId: a.clientId });
    await queueAppointmentNotices(tx, updated, "PROPOSED", start.toISOString());
  });
  await dispatchAppointmentNotices(now);
}

export async function ownerSetStatus(actor: Actor, appointmentId: string, status: "CANCELLED" | "COMPLETED" | "NO_SHOW", now = new Date()) {
  const a = await loadForOwner(actor, appointmentId);
  if (!["REQUESTED", "CONFIRMED", "RESCHEDULE_REQUESTED", "PROPOSED"].includes(a.status) && !(status !== "CANCELLED" && ["COMPLETED", "NO_SHOW"].includes(a.status))) {
    throw new ValidationError("This appointment is already closed.");
  }
  await inCalendarTx(async (tx) => {
    const updated = await tx.appointment.update({
      where: { id: a.id },
      data: { status, ...(status === "CANCELLED" ? { cancelledAt: now } : {}), pendingStartsAt: null, pendingEndsAt: null, pendingStaffId: null, pendingBy: null },
    });
    await tx.appointmentSlotClaim.deleteMany({ where: { appointmentId: a.id } });
    await event(tx, a.id, status.toLowerCase(), staffActor(actor), a.status, status);
    await audit(tx, { actorId: actor.id, action: `appointment.${status.toLowerCase()}`, entityType: "Appointment", entityId: a.id, clientId: a.clientId });
    if (status === "CANCELLED" && a.source === "PORTAL") await queueAppointmentNotices(tx, updated, "CANCELLED");
  });
  await dispatchAppointmentNotices(now);
}

/** Staff-only notes (any staff member; never shown to the client). */
export async function saveStaffNotes(actor: Actor, appointmentId: string, notes: string) {
  const a = await prisma.appointment.findUnique({ where: { id: appointmentId } });
  if (!a) throw new ValidationError("Appointment not found.");
  await prisma.appointment.update({ where: { id: a.id }, data: { staffNotes: notes.trim().slice(0, 4000) || null } });
  await event(prisma, a.id, "staff_notes_updated", staffActor(actor), null, null);
}

export async function ownerAssignStaff(actor: Actor, appointmentId: string, staffId: string) {
  const a = await loadForOwner(actor, appointmentId);
  if (!(await prisma.user.count({ where: { id: staffId, active: true } }))) throw new ValidationError("Choose an active staff member.");
  await inCalendarTx(async (tx) => {
    await tx.appointmentSlotClaim.deleteMany({ where: { appointmentId: a.id, kind: "CURRENT" } });
    if ((HOLDING_STATUSES as readonly string[]).includes(a.status)) await claimBlocks(tx, a.id, staffId, a.startsAt, a.endsAt ?? new Date(a.startsAt.getTime() + HOUR), "CURRENT");
    await tx.appointment.update({ where: { id: a.id }, data: { staffId } });
    await event(tx, a.id, "staff_assigned", staffActor(actor), null, null, { staffId });
  });
}

// --- Availability set-up --------------------------------------------------

function checkHours(open: string, close: string) {
  if (!isTime(open) || !isTime(close) || open >= close) throw new ValidationError("Choose an opening time before the closing time.");
}
function checkWeekdays(days: number[]) {
  const clean = Array.from(new Set(days)).filter((d) => Number.isInteger(d) && d >= 1 && d <= 7).sort();
  return clean;
}

export async function updateAppointmentSettings(
  actor: Actor,
  input: { weekdays: number[]; openTime: string; closeTime: string; slotStepMin: number; maxPerDay: number; minNoticeHours: number; cancelCutoffHours: number; rescheduleNeedsApproval: boolean; requireApproval: boolean; meetingTypes: string[]; alertEmail: string; alertPhone: string; remind24h: boolean; remind2h: boolean },
) {
  await assertOwner(actor);
  checkHours(input.openTime, input.closeTime);
  const weekdays = checkWeekdays(input.weekdays);
  if (![15, 30, 60].includes(input.slotStepMin)) throw new ValidationError("Start times can be every 15, 30 or 60 minutes.");
  if (!Number.isInteger(input.maxPerDay) || input.maxPerDay < 1 || input.maxPerDay > 50) throw new ValidationError("Allow 1–50 appointments per day.");
  if (!Number.isInteger(input.cancelCutoffHours) || input.cancelCutoffHours < 0 || input.cancelCutoffHours > 168) throw new ValidationError("The change deadline must be 0–168 hours.");
  if (!Number.isInteger(input.minNoticeHours) || input.minNoticeHours < 0 || input.minNoticeHours > 336) throw new ValidationError("Minimum notice must be 0–336 hours.");
  const meetingTypes = input.meetingTypes.filter((m) => m in MEETING_TYPES);
  if (!meetingTypes.length) throw new ValidationError("Offer at least one way to meet.");
  const alertEmail = normalizeEmail(input.alertEmail);
  if (!alertEmail || !isValidEmail(alertEmail)) throw new ValidationError("Enter a valid email for booking alerts.");
  const alertPhone = normalizePhone(input.alertPhone);
  if (!alertPhone) throw new ValidationError("Enter a valid phone number for booking alerts.");
  await appointmentSettings();
  await prisma.appointmentSettings.update({ where: { id: "default" }, data: { ...input, weekdays, meetingTypes, alertEmail, alertPhone, updatedById: actor.id } });
  await audit(prisma, { actorId: actor.id, action: "appointments.settings_updated", entityType: "AppointmentSettings", entityId: "default" });
}

/** Opens a month for editing (copying the office defaults). Opening never publishes it. */
export async function openMonth(actor: Actor, year: number, month: number) {
  await assertOwner(actor);
  if (!Number.isInteger(year) || !Number.isInteger(month) || month < 1 || month > 12) throw new ValidationError("Choose a valid month.");
  const s = await appointmentSettings();
  return prisma.appointmentMonth.upsert({
    where: { year_month: { year, month } },
    update: {},
    create: { year, month, weekdays: s.weekdays, openTime: s.openTime, closeTime: s.closeTime, maxPerDay: s.maxPerDay },
  });
}

export async function updateMonth(actor: Actor, year: number, month: number, input: { weekdays: number[]; openTime: string; closeTime: string; maxPerDay: number }) {
  await openMonth(actor, year, month);
  checkHours(input.openTime, input.closeTime);
  if (!Number.isInteger(input.maxPerDay) || input.maxPerDay < 1 || input.maxPerDay > 50) throw new ValidationError("Allow 1–50 appointments per day.");
  await prisma.appointmentMonth.update({ where: { year_month: { year, month } }, data: { weekdays: checkWeekdays(input.weekdays), openTime: input.openTime, closeTime: input.closeTime, maxPerDay: input.maxPerDay } });
  await audit(prisma, { actorId: actor.id, action: "appointments.month_updated", entityType: "AppointmentMonth", details: { year, month } });
}

export async function setMonthPublished(actor: Actor, year: number, month: number, published: boolean) {
  await openMonth(actor, year, month);
  await prisma.appointmentMonth.update({ where: { year_month: { year, month } }, data: published ? { publishedAt: new Date(), publishedById: actor.id } : { publishedAt: null } });
  await audit(prisma, { actorId: actor.id, action: published ? "appointments.month_published" : "appointments.month_unpublished", entityType: "AppointmentMonth", details: { year, month } });
}

const BLOCK_REASONS = ["HOLIDAY", "VACATION", "PERSONAL", "CLOSURE", "OTHER"];

/** A block (whole day or time range) or special availability, for one date or a range of dates. */
export async function addDateRule(
  actor: Actor,
  input: { dateFrom: string; dateTo?: string; kind: "BLOCK" | "SPECIAL"; reason?: string; label?: string; startTime?: string; endTime?: string; staffId?: string | null; maxPerDay?: number | null },
) {
  await assertOwner(actor);
  if (!isDate(input.dateFrom) || (input.dateTo && !isDate(input.dateTo))) throw new ValidationError("Choose the date(s).");
  if (input.kind !== "BLOCK" && input.kind !== "SPECIAL") throw new ValidationError("Choose a block or special availability.");
  const to = input.dateTo || input.dateFrom;
  if (to < input.dateFrom) throw new ValidationError("The last date must be on or after the first.");
  const timed = !!(input.startTime || input.endTime);
  if (timed) checkHours(input.startTime ?? "", input.endTime ?? "");
  if (input.kind === "SPECIAL" && !timed) throw new ValidationError("Special availability needs its hours.");
  if (input.staffId && !(await prisma.user.count({ where: { id: input.staffId, active: true } }))) throw new ValidationError("Choose an active staff member.");
  const reason = input.kind === "BLOCK" ? (BLOCK_REASONS.includes(input.reason ?? "") ? input.reason! : "OTHER") : null;
  const dates: string[] = [];
  for (let t = Date.parse(`${input.dateFrom}T00:00:00Z`); t <= Date.parse(`${to}T00:00:00Z`); t += 86400_000) dates.push(new Date(t).toISOString().slice(0, 10));
  if (dates.length > 62) throw new ValidationError("Add at most 62 days at a time.");
  await prisma.appointmentDateRule.createMany({
    data: dates.map((date) => ({
      date,
      kind: input.kind,
      reason,
      label: input.label?.trim().slice(0, 120) || null,
      startTime: timed ? input.startTime! : null,
      endTime: timed ? input.endTime! : null,
      staffId: input.staffId || null,
      maxPerDay: input.kind === "SPECIAL" && input.maxPerDay ? Math.max(1, Math.min(50, Math.floor(input.maxPerDay))) : null,
      createdById: actor.id,
    })),
  });
  await audit(prisma, { actorId: actor.id, action: input.kind === "BLOCK" ? "appointments.blocked" : "appointments.special_added", entityType: "AppointmentDateRule", details: { from: input.dateFrom, to, reason } });
  return dates.length;
}

export async function removeDateRule(actor: Actor, ruleId: string) {
  await assertOwner(actor);
  await prisma.appointmentDateRule.delete({ where: { id: ruleId } });
  await audit(prisma, { actorId: actor.id, action: "appointments.rule_removed", entityType: "AppointmentDateRule", entityId: ruleId });
}

export async function saveStaffAvailability(actor: Actor, userId: string, input: { active: boolean; weekdays: number[]; startTime?: string; endTime?: string }) {
  await assertOwner(actor);
  if (!(await prisma.user.count({ where: { id: userId, active: true } }))) throw new ValidationError("Choose an active staff member.");
  const timed = !!(input.startTime || input.endTime);
  if (timed) checkHours(input.startTime ?? "", input.endTime ?? "");
  const data = { active: input.active, weekdays: checkWeekdays(input.weekdays), startTime: timed ? input.startTime! : null, endTime: timed ? input.endTime! : null };
  await prisma.appointmentStaff.upsert({ where: { userId }, update: data, create: { userId, ...data } });
  await audit(prisma, { actorId: actor.id, action: "appointments.staff_availability", entityType: "AppointmentStaff", details: { userId, active: input.active } });
}

// ---------------------------------------------------------------------------
// Calendar reads (staff and owner)
// ---------------------------------------------------------------------------

export async function calendarAppointments(from: Date, to: Date) {
  return prisma.appointment.findMany({
    where: { OR: [{ startsAt: { gte: from, lt: to } }, { pendingStartsAt: { gte: from, lt: to } }] },
    include: { client: { select: { id: true, displayName: true } } },
    orderBy: { startsAt: "asc" },
  });
}

export async function pendingRequests() {
  return prisma.appointment.findMany({
    where: { status: { in: ["REQUESTED", "RESCHEDULE_REQUESTED", "PROPOSED"] } },
    include: { client: { select: { id: true, displayName: true } } },
    orderBy: { startsAt: "asc" },
  });
}

export async function appointmentDetail(appointmentId: string) {
  return prisma.appointment.findUnique({
    where: { id: appointmentId },
    include: { client: { select: { id: true, displayName: true } }, events: { orderBy: { createdAt: "asc" } }, notices: { orderBy: { createdAt: "asc" } } },
  });
}

// ---------------------------------------------------------------------------
// Staff-created appointments (Tasks & Calendar), kept on the same table
// ---------------------------------------------------------------------------

export async function recordStaffAppointmentCreated(appointmentId: string, actor: Actor) {
  await event(prisma, appointmentId, "created_by_staff", staffActor(actor), null, "CONFIRMED");
}

export async function staffCancelAppointment(actor: Actor, appointmentId: string, now = new Date()) {
  const a = await prisma.appointment.findUnique({ where: { id: appointmentId } });
  if (!a) throw new ValidationError("Appointment not found.");
  const updated = await prisma.$transaction(async (tx) => {
    const u = await tx.appointment.update({ where: { id: appointmentId }, data: { cancelledAt: now, status: "CANCELLED", pendingStartsAt: null, pendingEndsAt: null, pendingStaffId: null, pendingBy: null } });
    await tx.appointmentSlotClaim.deleteMany({ where: { appointmentId } });
    await event(tx, appointmentId, "cancelled", staffActor(actor), a.status, "CANCELLED");
    if (a.source === "PORTAL" && (HOLDING_STATUSES as readonly string[]).includes(a.status)) await queueAppointmentNotices(tx, u, "CANCELLED");
    return u;
  });
  await dispatchAppointmentNotices(now);
  return updated;
}
