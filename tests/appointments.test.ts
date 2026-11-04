import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeUser, prisma, resetDb } from "./db";
import { ForbiddenError } from "@/lib/auth/actor";
import { createClient, ValidationError } from "@/lib/services/clients";
import { acceptPortalInvite, invitePortalUser } from "@/lib/services/portal-accounts";
import {
  addDateRule,
  bookAppointment,
  bookingProfile,
  clientAnswerProposal,
  clientCancelAppointment,
  clientRescheduleAppointment,
  monthAvailability,
  openMonth,
  ownerApprove,
  ownerDecline,
  ownerPropose,
  portalAppointments,
  saveStaffAvailability,
  setMonthPublished,
  updateAppointmentSettings,
  updateMonth,
  appointmentSettings,
  calendarAppointments,
  pendingRequests,
} from "@/lib/services/appointments";
import { clientSmsText, dispatchAppointmentNotices, queueAppointmentNotices, runAppointmentReminders } from "@/lib/services/appointment-notices";
import { handleInboundSms } from "@/lib/services/inbound-sms";
import { appointmentMinutes, APPOINTMENT_SERVICES, totalTimeLabel } from "@/lib/appointments/services";
import { atOffice, daySlots } from "@/lib/appointments/availability";
import { chicagoLocalToUtc } from "@/lib/tz";
import type { PortalActor } from "@/lib/portal/session";

// Fictional people and numbers only (555-01xx).
const at = (local: string) => chicagoLocalToUtc(local)!;
const NOW = at("2027-02-25T12:00"); // a Thursday, well before the March bookings below
let texts: { to: string; body: string }[] = [];
let emails: { to: string; subject: string; text: string }[] = [];
let twilioFails = false;

beforeEach(async () => {
  await resetDb();
  texts = [];
  emails = [];
  twilioFails = false;
  vi.stubEnv("TWILIO_ACCOUNT_SID", "AC_test");
  vi.stubEnv("TWILIO_AUTH_TOKEN", "test-token");
  vi.stubEnv("TWILIO_MESSAGING_SERVICE_SID", "MG_test");
  vi.stubEnv("RESEND_API_KEY", "re_test");
  vi.stubEnv("EMAIL_FROM_ADDRESS", "office@example.com");
  vi.stubEnv("APP_URL", "https://portal.example.com");
  // Mocked providers: nothing ever leaves the test.
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    if (String(url).includes("api.twilio.com")) {
      if (twilioFails) return new Response(JSON.stringify({ code: 21610 }), { status: 400 });
      const p = new URLSearchParams(String(init.body));
      texts.push({ to: p.get("To")!, body: p.get("Body")! });
      return new Response(JSON.stringify({ sid: `SM${String(texts.length).padStart(32, "0")}` }), { status: 201 });
    }
    if (String(url).includes("resend")) {
      const j = JSON.parse(String(init.body));
      emails.push({ to: j.to[0], subject: j.subject, text: j.text });
      return new Response(JSON.stringify({ id: `em_${emails.length}` }), { status: 200 });
    }
    return new Response(JSON.stringify({ clean: true }), { status: 200 });
  });
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

async function setup() {
  const owner = await makeUser("ADMIN", "Tabitha");
  await prisma.ownerAccess.create({ data: { userId: owner.id, isPrimary: true, scope: "FULL" } });
  const staffer = await makeUser("ADMIN", "Daria");
  const join = async (first: string, last: string, email: string, opts: { status?: "ACTIVE" | "PROSPECT"; business?: string } = {}) => {
    const c = opts.business
      ? await createClient(owner, { businessName: opts.business, clientType: "BUSINESS", status: opts.status ?? "ACTIVE" })
      : await createClient(owner, { firstName: first, middleName: "Q", lastName: last, clientType: "INDIVIDUAL", status: opts.status ?? "ACTIVE" });
    const { token } = await invitePortalUser(owner, c.id, { email, name: `${first} ${last}`, role: "OWNER" });
    const u = await acceptPortalInvite(token!, "Portal-Pass-12345");
    return { client: c, user: { id: u.id, name: u.name, email: u.email } as PortalActor };
  };
  const ava = await join("Ava", "Fictional", "ava@example.com");
  const ben = await join("Ben", "Madeup", "ben@example.com");
  await prisma.portalUser.update({ where: { id: ava.user.id }, data: { phone: "(205) 555-0142", phoneNormalized: "+12055550142" } });
  await prisma.portalUser.update({ where: { id: ben.user.id }, data: { phone: "(205) 555-0177", phoneNormalized: "+12055550177" } });
  await openMonth(owner, 2027, 3);
  await setMonthPublished(owner, 2027, 3, true);
  return { owner, staffer, ava, ben, join };
}

const info = (over: Record<string, unknown> = {}) => ({ meetingType: "IN_OFFICE", reason: "Review my return", ...over });

async function book(who: { client: { id: string }; user: PortalActor }, services: string[], date: string, time: string, over: Record<string, unknown> = {}, now = NOW) {
  return bookAppointment(who.user, { clientId: who.client.id, services, date, time, info: info(over) }, now);
}

describe("duration rule", () => {
  it("uses the longest selected service and never exceeds two hours", () => {
    expect(appointmentMinutes(["TAX_1040"])).toBe(60);
    expect(appointmentMinutes(["RETURN_1041"])).toBe(45);
    expect(appointmentMinutes(["TAX_1040", "CONSULTATION", "TAX_1040_SCH_C"])).toBe(90);
    expect(appointmentMinutes(["TAX_1040", "RETURN_1065"])).toBe(120);
    expect(appointmentMinutes(APPOINTMENT_SERVICES.map((s) => s.key))).toBe(120);
    expect(appointmentMinutes(["NOT_A_SERVICE"])).toBe(0);
    expect(totalTimeLabel(120)).toBe("2 hours (maximum)");
  });

  it("is decided on the server: three long services book exactly two hours", async () => {
    const { ava } = await setup();
    const a = await book(ava, ["TAX_1040", "AMENDED_1040X", "BUSINESS_FORMATION"], "2027-03-02", "10:00", { businessName: "Ava's Fictional Bakery LLC" });
    expect(a.durationMin).toBe(120);
    expect(a.endsAt!.getTime() - a.startsAt.getTime()).toBe(2 * 3600_000);
    await expect(book(ava, ["TAX_1040", "HACK_10_HOURS"], "2027-03-03", "10:00")).rejects.toBeInstanceOf(ValidationError);
    await expect(book(ava, [], "2027-03-03", "10:00")).rejects.toBeInstanceOf(ValidationError);
    // An appointment can't start where two hours would run past closing (5 p.m.).
    await expect(book(ava, ["RETURN_1065"], "2027-03-03", "15:30")).rejects.toBeInstanceOf(ValidationError);
  });
});

describe("published-only availability", () => {
  it("nothing in an unpublished month is bookable", async () => {
    const { owner, ava } = await setup();
    const april = await monthAvailability(2027, 4, NOW);
    expect(april.published).toBe(false);
    expect(Object.keys(april.days)).toHaveLength(0);
    await expect(book(ava, ["TAX_1040"], "2027-04-06", "10:00")).rejects.toThrow(/no longer available/);
    // Opening the month for editing doesn't publish it.
    await openMonth(owner, 2027, 4);
    expect((await monthAvailability(2027, 4, NOW)).published).toBe(false);
    await setMonthPublished(owner, 2027, 4, true);
    expect(Object.keys((await monthAvailability(2027, 4, NOW)).days).length).toBeGreaterThan(0);
    // Unpublishing takes it away again.
    await setMonthPublished(owner, 2027, 4, false);
    expect(Object.keys((await monthAvailability(2027, 4, NOW)).days)).toHaveLength(0);
  });
});

describe("blocks, closures, capacity and staff", () => {
  it("respects weekdays, whole-day and time-range blocks, special dates and the daily limit", async () => {
    const { owner, ava, ben } = await setup();
    const m = await monthAvailability(2027, 3, NOW);
    expect(m.days["2027-03-06"]).toBeUndefined(); // Saturday: closed by default
    expect(m.days["2027-03-02"][60][0]).toBe("09:00");
    expect(m.days["2027-03-02"][60].at(-1)).toBe("16:00");
    expect(m.days["2027-03-02"][120].at(-1)).toBe("15:00");

    await addDateRule(owner, { dateFrom: "2027-03-03", kind: "BLOCK", reason: "HOLIDAY", label: "Office holiday" });
    await addDateRule(owner, { dateFrom: "2027-03-04", kind: "BLOCK", reason: "PERSONAL", startTime: "10:00", endTime: "12:00" });
    await addDateRule(owner, { dateFrom: "2027-03-06", kind: "SPECIAL", startTime: "10:00", endTime: "12:00" });
    await addDateRule(owner, { dateFrom: "2027-03-15", dateTo: "2027-03-19", kind: "BLOCK", reason: "VACATION" });
    const after = await monthAvailability(2027, 3, NOW);
    expect(after.days["2027-03-03"]).toBeUndefined();
    expect(after.days["2027-03-04"][60]).not.toContain("10:00");
    expect(after.days["2027-03-04"][60]).not.toContain("11:30");
    expect(after.days["2027-03-04"][60]).toContain("09:00");
    expect(after.days["2027-03-04"][60]).toContain("12:00");
    expect(after.days["2027-03-06"][60]).toEqual(["10:00", "10:30", "11:00"]);
    expect(after.days["2027-03-06"][120]).toEqual(["10:00"]);
    for (const d of ["2027-03-15", "2027-03-16", "2027-03-17", "2027-03-18", "2027-03-19"]) expect(after.days[d]).toBeUndefined();
    await expect(book(ava, ["TAX_1040"], "2027-03-03", "10:00")).rejects.toBeInstanceOf(ValidationError);

    // Daily limit of one: the first booking fills the day.
    await updateMonth(owner, 2027, 3, { weekdays: [1, 2, 3, 4, 5], openTime: "09:00", closeTime: "17:00", maxPerDay: 1 });
    await book(ava, ["TAX_1040"], "2027-03-09", "09:00");
    expect((await monthAvailability(2027, 3, NOW)).days["2027-03-09"]).toBeUndefined();
    await expect(book(ben, ["TAX_1040"], "2027-03-09", "14:00")).rejects.toBeInstanceOf(ValidationError);
  });

  it("assigns bookings only to staff who take appointments, within their own hours", async () => {
    const { owner, staffer, ava, ben } = await setup();
    // Daria takes appointments on Tuesday mornings only; Tabitha isn't switched on.
    await saveStaffAvailability(owner, staffer.id, { active: true, weekdays: [2], startTime: "09:00", endTime: "12:00" });
    const m = await monthAvailability(2027, 3, NOW);
    expect(m.days["2027-03-01"]).toBeUndefined(); // Monday: nobody available
    expect(m.days["2027-03-02"][60]).toEqual(["09:00", "09:30", "10:00", "10:30", "11:00"]);
    const a = await book(ava, ["TAX_1040"], "2027-03-02", "09:00");
    expect(a.staffId).toBe(staffer.id);
    // Her only overlapping times are gone; a staff-specific block removes the rest.
    await addDateRule(owner, { dateFrom: "2027-03-02", kind: "BLOCK", reason: "PERSONAL", staffId: staffer.id, startTime: "10:00", endTime: "12:00" });
    expect((await monthAvailability(2027, 3, NOW)).days["2027-03-02"]).toBeUndefined();
    await expect(book(ben, ["TAX_1040"], "2027-03-02", "10:00")).rejects.toBeInstanceOf(ValidationError);
  });
});

describe("no double-booking", () => {
  it("only one of two simultaneous bookings for the same time succeeds", async () => {
    const { ava, ben } = await setup();
    const results = await Promise.allSettled([book(ava, ["TAX_1040"], "2027-03-02", "10:00"), book(ben, ["CONSULTATION"], "2027-03-02", "10:00")]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const failed = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect(failed.reason).toBeInstanceOf(ValidationError);
    expect(await prisma.appointment.count()).toBe(1);
    // Overlapping (not identical) times are refused too.
    await expect(book(ben, ["TAX_1040_SCH_C"], "2027-03-02", "09:30")).rejects.toBeInstanceOf(ValidationError);
    await book(ben, ["TAX_1040"], "2027-03-02", "11:00");
  });

  it("the database refuses a second claim on the same block", async () => {
    const { ava, ben } = await setup();
    const a = await book(ava, ["TAX_1040"], "2027-03-02", "10:00");
    const b = await book(ben, ["TAX_1040"], "2027-03-02", "13:00");
    await expect(prisma.appointmentSlotClaim.create({ data: { appointmentId: b.id, staffId: a.staffId!, blockStart: a.startsAt } })).rejects.toMatchObject({ code: "P2002" });
  });
});

describe("client isolation", () => {
  it("a client can't see, cancel or reschedule another client's appointment, and never sees staff notes", async () => {
    const { ava, ben } = await setup();
    const a = await book(ava, ["TAX_1040"], "2027-03-02", "10:00");
    await prisma.appointment.update({ where: { id: a.id }, data: { staffNotes: "Internal: bring prior-year file" } });
    await expect(portalAppointments(ben.user.id, ava.client.id, NOW)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(clientCancelAppointment(ben.user, a.id, NOW)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(clientRescheduleAppointment(ben.user, a.id, { date: "2027-03-03", time: "10:00" }, NOW)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(bookAppointment(ben.user, { clientId: ava.client.id, services: ["TAX_1040"], date: "2027-03-04", time: "10:00", info: info() }, NOW)).rejects.toBeInstanceOf(ForbiddenError);
    expect((await portalAppointments(ben.user.id, ben.client.id, NOW)).upcoming).toHaveLength(0);
    const mine = await portalAppointments(ava.user.id, ava.client.id, NOW);
    expect(mine.upcoming.map((x) => x.id)).toEqual([a.id]);
    expect(JSON.stringify(mine)).not.toContain("Internal");
    expect(await prisma.appointment.findUnique({ where: { id: a.id }, select: { status: true } })).toEqual({ status: "REQUESTED" });
  });
});

describe("owner-only management", () => {
  it("staff without the Owner's Office can't publish, block, change settings or approve", async () => {
    const { staffer, ava } = await setup();
    const a = await book(ava, ["TAX_1040"], "2027-03-02", "10:00");
    await expect(setMonthPublished(staffer, 2027, 5, true)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(openMonth(staffer, 2027, 5)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(addDateRule(staffer, { dateFrom: "2027-03-02", kind: "BLOCK" })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(ownerApprove(staffer, a.id, NOW)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(ownerDecline(staffer, a.id, "", NOW)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(ownerPropose(staffer, a.id, { date: "2027-03-03", time: "10:00" }, NOW)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(saveStaffAvailability(staffer, staffer.id, { active: true, weekdays: [1] })).rejects.toBeInstanceOf(ForbiddenError);
    const s = await appointmentSettings();
    await expect(updateAppointmentSettings(staffer, { ...s, alertPhone: s.alertPhone })).rejects.toBeInstanceOf(ForbiddenError);
    expect(await prisma.appointmentMonth.count({ where: { month: 5 } })).toBe(0);
  });
});

describe("reschedule and cancel policy", () => {
  it("cancels online only before the configurable cutoff", async () => {
    const { owner, ava } = await setup();
    const a = await book(ava, ["TAX_1040"], "2027-03-02", "10:00");
    await expect(clientCancelAppointment(ava.user, a.id, at("2027-03-01T12:00"))).rejects.toThrow(/within 24 hours/i);
    const s = await appointmentSettings();
    await updateAppointmentSettings(owner, { ...s, cancelCutoffHours: 48 });
    await expect(clientCancelAppointment(ava.user, a.id, at("2027-02-28T12:00"))).rejects.toThrow(/within 48 hours/i);
    await clientCancelAppointment(ava.user, a.id, at("2027-02-27T12:00"));
    const after = await prisma.appointment.findUniqueOrThrow({ where: { id: a.id } });
    expect(after.status).toBe("CANCELLED");
    expect(after.cancelledAt).not.toBeNull();
    expect(await prisma.appointmentSlotClaim.count({ where: { appointmentId: a.id } })).toBe(0);
    expect((await monthAvailability(2027, 3, NOW)).days["2027-03-02"][60]).toContain("10:00");
  });

  it("reschedules of confirmed appointments wait for approval while both times stay held", async () => {
    const { owner, ava, ben } = await setup();
    const a = await book(ava, ["TAX_1040"], "2027-03-02", "10:00");
    await ownerApprove(owner, a.id, NOW);
    const r = await clientRescheduleAppointment(ava.user, a.id, { date: "2027-03-04", time: "14:00" }, NOW);
    expect(r.pending).toBe(true);
    const mid = await prisma.appointment.findUniqueOrThrow({ where: { id: a.id } });
    expect(mid.status).toBe("RESCHEDULE_REQUESTED");
    expect(mid.startsAt).toEqual(at("2027-03-02T10:00"));
    await expect(book(ben, ["TAX_1040"], "2027-03-02", "10:00")).rejects.toBeInstanceOf(ValidationError);
    await expect(book(ben, ["TAX_1040"], "2027-03-04", "14:00")).rejects.toBeInstanceOf(ValidationError);
    await ownerApprove(owner, a.id, NOW);
    const done = await prisma.appointment.findUniqueOrThrow({ where: { id: a.id } });
    expect(done).toMatchObject({ status: "CONFIRMED", version: 2, pendingStartsAt: null });
    expect(done.startsAt).toEqual(at("2027-03-04T14:00"));
    // The old time is free again.
    await book(ben, ["TAX_1040"], "2027-03-02", "10:00");
  });

  it("moves directly when approval for reschedules is off; owner proposals can be accepted or declined", async () => {
    const { owner, ava } = await setup();
    const s = await appointmentSettings();
    await updateAppointmentSettings(owner, { ...s, rescheduleNeedsApproval: false });
    const a = await book(ava, ["TAX_1040"], "2027-03-02", "10:00");
    await ownerApprove(owner, a.id, NOW);
    expect((await clientRescheduleAppointment(ava.user, a.id, { date: "2027-03-02", time: "10:30" }, NOW)).pending).toBe(false);
    expect((await prisma.appointment.findUniqueOrThrow({ where: { id: a.id } })).startsAt).toEqual(at("2027-03-02T10:30"));
    await ownerPropose(owner, a.id, { date: "2027-03-05", time: "13:00" }, NOW);
    await clientAnswerProposal(ava.user, a.id, false, NOW);
    expect(await prisma.appointment.findUniqueOrThrow({ where: { id: a.id } })).toMatchObject({ status: "CONFIRMED", startsAt: at("2027-03-02T10:30") });
    await ownerPropose(owner, a.id, { date: "2027-03-05", time: "13:00" }, NOW);
    await clientAnswerProposal(ava.user, a.id, true, NOW);
    expect(await prisma.appointment.findUniqueOrThrow({ where: { id: a.id } })).toMatchObject({ status: "CONFIRMED", startsAt: at("2027-03-05T13:00") });
  });
});

describe("history and notification records", () => {
  it("records events and request / confirmation / owner alert notices", async () => {
    const { owner, ava } = await setup();
    const a = await book(ava, ["TAX_1040"], "2027-03-02", "10:00");
    await ownerApprove(owner, a.id, NOW);
    const events = await prisma.appointmentEvent.findMany({ where: { appointmentId: a.id }, orderBy: { createdAt: "asc" } });
    expect(events.map((e) => e.action)).toEqual(["booked", "approved"]);
    const notices = await prisma.appointmentNotice.findMany({ where: { appointmentId: a.id } });
    const kinds = notices.map((n) => `${n.kind}:${n.audience}:${n.channel}`).sort();
    expect(kinds).toEqual(["CONFIRMATION:CLIENT:EMAIL", "CONFIRMATION:CLIENT:SMS", "OWNER_NEW_REQUEST:OWNER:EMAIL", "OWNER_NEW_REQUEST:OWNER:SMS", "REQUEST_RECEIVED:CLIENT:EMAIL", "REQUEST_RECEIVED:CLIENT:SMS"]);
    const ownerEmail = notices.find((n) => n.kind === "OWNER_NEW_REQUEST" && n.channel === "EMAIL")!;
    expect(ownerEmail).toMatchObject({ to: "info@tturnerassociates.com", status: "SENT" });
    // The office phone is texted only through staff text alerts, which are off here.
    const ownerSms = notices.find((n) => n.kind === "OWNER_NEW_REQUEST" && n.channel === "SMS")!;
    expect(ownerSms).toMatchObject({ to: "+12054201825", status: "SKIPPED" });
    expect(ownerSms.statusDetail).toMatch(/Staff text alerts are off/);
    expect(emails.some((e) => e.to === "ava@example.com" && /confirmed/i.test(e.subject))).toBe(true);
  });
});

describe("business services grant no business access", () => {
  it("booking 1065, 1120-S, bookkeeping, payroll and formation changes no access or services", async () => {
    const { ava } = await setup();
    const before = {
      access: await prisma.portalAccess.findMany({ orderBy: { id: "asc" } }),
      clients: await prisma.client.findMany({ orderBy: { id: "asc" }, select: { id: true, services: true, clientType: true } }),
      clientServices: await prisma.clientService.count(),
      bookkeeping: await prisma.bookkeepingProfile.count(),
      relationships: await prisma.clientRelationship.count(),
    };
    await book(ava, ["RETURN_1065", "RETURN_1120S", "BOOKKEEPING_SETUP"], "2027-03-02", "10:00", { businessName: "Ava's Fictional Bakery LLC" });
    await book(ava, ["PAYROLL_SETUP", "BUSINESS_FORMATION"], "2027-03-03", "10:00", { businessName: "Ava's Second Pretend Co" });
    expect(await prisma.portalAccess.findMany({ orderBy: { id: "asc" } })).toEqual(before.access);
    expect(await prisma.client.findMany({ orderBy: { id: "asc" }, select: { id: true, services: true, clientType: true } })).toEqual(before.clients);
    expect(await prisma.clientService.count()).toBe(before.clientServices);
    expect(await prisma.bookkeepingProfile.count()).toBe(before.bookkeeping);
    expect(await prisma.clientRelationship.count()).toBe(before.relationships);
  });

  it("asks for a business name when a business service is booked", async () => {
    const { ava } = await setup();
    await expect(book(ava, ["PAYROLL_SETUP"], "2027-03-02", "10:00")).rejects.toThrow(/business name/i);
  });
});

describe("booking information", () => {
  it("prefills from the master Client record and the portal login", async () => {
    const { ava, join } = await setup();
    expect(await bookingProfile(ava.user.id, ava.client.id)).toMatchObject({ legalName: "Ava Q Fictional", phone: "(205) 555-0142", email: "ava@example.com", existingClient: true, businessName: null, smsConsentOnFile: false });
    const cara = await join("Cara", "Prospect", "cara@example.com", { status: "PROSPECT" });
    expect((await bookingProfile(cara.user.id, cara.client.id)).existingClient).toBe(false);
    const biz = await join("Dev", "Owner", "dev@example.com", { business: "Pretend Plumbing LLC" });
    expect(await bookingProfile(biz.user.id, biz.client.id)).toMatchObject({ businessName: "Pretend Plumbing LLC", businessAccount: true, legalName: "Dev Owner" });
  });

  it("keeps the on-file details when nothing is changed and records changes without touching the client record", async () => {
    const { ava } = await setup();
    const a = await book(ava, ["TAX_1040"], "2027-03-02", "10:00");
    expect(a.bookingInfo).toMatchObject({ legalName: "Ava Q Fictional", phone: "+12055550142", email: "ava@example.com", clientKind: "EXISTING", changed: [] });
    const b = await book(ava, ["TAX_1040"], "2027-03-03", "10:00", { phone: "205-555-0199" });
    expect((b.bookingInfo as { changed: string[] }).changed).toEqual(["phone"]);
    expect((await prisma.client.findUniqueOrThrow({ where: { id: ava.client.id } })).phone).toBeNull();
    await expect(book(ava, ["TAX_1040"], "2027-03-04", "10:00", { reason: "My SSN is 123-45-6789" })).rejects.toThrow(/Social Security/);
    await expect(book(ava, ["TAX_1040"], "2027-03-04", "10:00", { meetingType: "" })).rejects.toThrow(/how you'd like to meet/);
  });
});

describe("confirmation texts", () => {
  async function confirmed(over: Record<string, unknown> = { smsConsent: true }, texting = true) {
    const ctx = await setup();
    if (texting) await prisma.staffAlertSettings.upsert({ where: { id: "default" }, update: { clientTextingEnabled: true }, create: { id: "default", clientTextingEnabled: true } });
    const a = await book(ctx.ava, ["TAX_1040", "CONSULTATION"], "2027-03-02", "10:00", { reason: "Bring my W-2s and last year's refund letter", ...over });
    await ownerApprove(ctx.owner, a.id, NOW);
    return { ...ctx, a: await prisma.appointment.findUniqueOrThrow({ where: { id: a.id } }) };
  }
  const smsNotice = (appointmentId: string, kind: string) => prisma.appointmentNotice.findFirstOrThrow({ where: { appointmentId, kind, audience: "CLIENT", channel: "SMS" } });

  it("has the exact wording with the date, time and CT, and no sensitive data", async () => {
    const { a } = await confirmed();
    const expected = "T. Turner & Associates: Your appointment is confirmed for Tue, Mar 2, 2027 at 10:00 AM CT for Individual Tax Return and Consultation. Manage your appointment securely in Client Connect: https://portal.example.com/client/appointments. Reply STOP to opt out.";
    expect(clientSmsText("CONFIRMATION", a)).toBe(expected);
    expect(texts.find((t) => t.body.includes("is confirmed"))).toEqual({ to: "+12055550142", body: expected });
    for (const t of texts) {
      expect(t.body).not.toMatch(/W-2|refund|Review my return|\d{3}-\d{2}-\d{4}/);
      expect(t.body).not.toMatch(/token=|\?t=/);
    }
    // Daylight saving: the same wall time after the March 14 change still reads 10:00 AM CT.
    expect(clientSmsText("CONFIRMATION", { ...a, startsAt: at("2027-03-16T10:00") })).toContain("Tue, Mar 16, 2027 at 10:00 AM CT");
  });

  it("is skipped (email still sent) when Client texting is off", async () => {
    const { a } = await confirmed({ smsConsent: true }, false);
    expect(await smsNotice(a.id, "CONFIRMATION")).toMatchObject({ status: "SKIPPED", statusDetail: expect.stringMatching(/Client texting is off/) });
    expect(texts).toHaveLength(0);
    expect(await prisma.appointmentNotice.findFirstOrThrow({ where: { appointmentId: a.id, kind: "CONFIRMATION", channel: "EMAIL" } })).toMatchObject({ status: "SENT", to: "ava@example.com" });
    expect((await prisma.staffAlertSettings.findUniqueOrThrow({ where: { id: "default" } })).clientTextingEnabled).toBe(false);
  });

  it("is skipped without appointment-text consent, and consent is recorded as service (not marketing)", async () => {
    const { a } = await confirmed({ smsConsent: false });
    expect(await smsNotice(a.id, "CONFIRMATION")).toMatchObject({ status: "SKIPPED", statusDetail: expect.stringMatching(/didn't agree/) });
    expect(texts).toHaveLength(0);
    expect(await prisma.smsConsentEvent.count()).toBe(0);
  });

  it("records SERVICE consent from the booking, never MARKETING", async () => {
    await confirmed({ smsConsent: true });
    const events = await prisma.smsConsentEvent.findMany();
    expect(events.map((e) => [e.category, e.status, e.source])).toEqual([["SERVICE", "GRANTED", "APPOINTMENT_BOOKING"]]);
  });

  it("STOP blocks later appointment texts", async () => {
    const { a } = await confirmed();
    await handleInboundSms({ MessageSid: "SM_fake_stop_1", From: "+12055550142", To: "+12055550100", Body: "STOP" });
    await runAppointmentReminders(at("2027-03-01T12:00"));
    expect(await smsNotice(a.id, "REMINDER_24H")).toMatchObject({ status: "SKIPPED", statusDetail: expect.stringMatching(/STOP/) });
    expect(texts.filter((t) => t.body.includes("Reminder"))).toHaveLength(0);
  });

  it("is never sent twice for the same appointment version", async () => {
    const { a } = await confirmed();
    const before = texts.length;
    await prisma.$transaction((tx) => queueAppointmentNotices(tx, a, "CONFIRMATION"));
    await dispatchAppointmentNotices(NOW);
    await dispatchAppointmentNotices(NOW);
    expect(texts.length).toBe(before);
    expect(await prisma.appointmentNotice.count({ where: { appointmentId: a.id, kind: "CONFIRMATION" } })).toBe(2);
    expect(texts.filter((t) => t.body.includes("is confirmed"))).toHaveLength(1);
  });

  it("sends an updated confirmation on reschedule and a cancellation notice on cancel", async () => {
    const { owner, ava, a } = await confirmed();
    await clientRescheduleAppointment(ava.user, a.id, { date: "2027-03-04", time: "14:00" }, NOW);
    await ownerApprove(owner, a.id, NOW);
    const moved = texts.find((t) => t.body.includes("rescheduled"))!;
    expect(moved.body).toContain("Thu, Mar 4, 2027 at 2:00 PM CT");
    await clientCancelAppointment(ava.user, a.id, NOW);
    const cancel = texts.find((t) => t.body.includes("cancelled"))!;
    expect(cancel.body).toContain("Thu, Mar 4, 2027 at 2:00 PM CT has been cancelled");
    expect(await prisma.appointmentNotice.findFirstOrThrow({ where: { appointmentId: a.id, kind: "RESCHEDULED", channel: "EMAIL" } })).toMatchObject({ version: 2, status: "SENT" });
    expect(await prisma.appointmentNotice.findFirstOrThrow({ where: { appointmentId: a.id, kind: "CANCELLED", channel: "EMAIL" } })).toMatchObject({ status: "SENT" });
  });

  it("a failed text keeps the appointment, is recorded FAILED and gives staff a follow-up task", async () => {
    const ctx = await setup();
    await prisma.staffAlertSettings.upsert({ where: { id: "default" }, update: { clientTextingEnabled: true }, create: { id: "default", clientTextingEnabled: true } });
    const a = await book(ctx.ava, ["TAX_1040"], "2027-03-02", "10:00", { smsConsent: true });
    twilioFails = true;
    await ownerApprove(ctx.owner, a.id, NOW);
    expect(await smsNotice(a.id, "CONFIRMATION")).toMatchObject({ status: "FAILED" });
    expect((await prisma.appointment.findUniqueOrThrow({ where: { id: a.id } })).status).toBe("CONFIRMED");
    const task = await prisma.task.findFirstOrThrow({ where: { clientId: ctx.ava.client.id } });
    expect(task).toMatchObject({ assigneeId: ctx.owner.id, priority: "HIGH", status: "OPEN" });
    expect(task.title).toMatch(/text didn't go through/);
    expect(await prisma.appointmentEvent.count({ where: { appointmentId: a.id, action: "notice_failed" } })).toBe(1);
  });
});

describe("reminders", () => {
  it("sends the 24-hour and 2-hour reminders once each", async () => {
    const ctx = await setup();
    await prisma.staffAlertSettings.upsert({ where: { id: "default" }, update: { clientTextingEnabled: true }, create: { id: "default", clientTextingEnabled: true } });
    const a = await book(ctx.ava, ["TAX_1040"], "2027-03-02", "15:00", { smsConsent: true });
    await ownerApprove(ctx.owner, a.id, NOW);
    await runAppointmentReminders(at("2027-02-28T15:00")); // too early
    expect(await prisma.appointmentNotice.count({ where: { appointmentId: a.id, kind: { startsWith: "REMINDER" } } })).toBe(0);
    await runAppointmentReminders(at("2027-03-01T15:30"));
    await runAppointmentReminders(at("2027-03-01T16:30"));
    expect(texts.filter((t) => t.body.includes("coming up on Tue, Mar 2, 2027 at 3:00 PM CT"))).toHaveLength(1);
    await runAppointmentReminders(at("2027-03-02T13:15"));
    await runAppointmentReminders(at("2027-03-02T14:15"));
    expect(texts.filter((t) => t.body.includes("today at 3:00 PM CT"))).toHaveLength(1);
    expect(await prisma.appointmentNotice.count({ where: { appointmentId: a.id, kind: "REMINDER_24H" } })).toBe(2); // one email + one text
    expect(await prisma.appointmentNotice.count({ where: { appointmentId: a.id, kind: "REMINDER_2H" } })).toBe(2);
  });

  it("aren't sent for a cancelled appointment", async () => {
    const ctx = await setup();
    const a = await book(ctx.ava, ["TAX_1040"], "2027-03-02", "15:00");
    await ownerApprove(ctx.owner, a.id, NOW);
    await clientCancelAppointment(ctx.ava.user, a.id, NOW);
    await runAppointmentReminders(at("2027-03-01T15:30"));
    expect(await prisma.appointmentNotice.count({ where: { appointmentId: a.id, kind: { startsWith: "REMINDER" } } })).toBe(0);
  });
});

describe("pure slot rules", () => {
  it("never offers a start whose appointment would pass closing or overlap a hold", () => {
    const month = { year: 2027, month: 3, weekdays: [1, 2, 3, 4, 5], openTime: "09:00", closeTime: "12:00", maxPerDay: 5, publishedAt: new Date() };
    const slots = daySlots({
      date: "2027-03-02",
      minutes: 90,
      month,
      rules: [],
      staff: [{ userId: "s1", weekdays: [2], startTime: null, endTime: null }],
      busy: [{ start: atOffice("2027-03-02", "10:30"), end: atOffice("2027-03-02", "11:00"), staffId: "s1", appointmentId: "x" }],
      dayCount: 0,
      stepMin: 30,
      earliest: new Date(0),
    });
    expect(slots.map((s) => s.time)).toEqual(["09:00"]);
  });
});

describe("one record everywhere", () => {
  it("the same appointment row feeds the client list, the calendars and the client profile", async () => {
    const { owner, ava } = await setup();
    const a = await book(ava, ["TAX_1040"], "2027-03-02", "10:00");
    await clientRescheduleAppointment(ava.user, a.id, { date: "2027-03-02", time: "13:00" }, NOW); // still a request: moves in place
    await ownerApprove(owner, a.id, NOW);
    const cal = await calendarAppointments(at("2027-03-01T00:00"), at("2027-04-01T00:00"));
    expect(cal.map((x) => x.id)).toEqual([a.id]);
    expect((await portalAppointments(ava.user.id, ava.client.id, NOW)).upcoming.map((x) => x.id)).toEqual([a.id]);
    expect((await prisma.appointment.findMany({ where: { clientId: ava.client.id } })).map((x) => x.id)).toEqual([a.id]);
    expect(await pendingRequests()).toHaveLength(0);
    const notices = await prisma.appointmentNotice.findMany({ where: { appointmentId: a.id } });
    expect(new Set(notices.map((n) => n.idempotencyKey)).size).toBe(notices.length);
  });
});
