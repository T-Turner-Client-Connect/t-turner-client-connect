import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeUser, prisma, resetDb } from "./db";
import { createClient } from "@/lib/services/clients";
import { campaignFromAnnouncement, campaignRecipients, createCampaign, setAudience, updateCampaignDraft } from "@/lib/services/campaigns";
import { scheduleCampaign } from "@/lib/services/campaign-dispatch";
import { canSend, portalPeople, preferenceState, setCommunicationPreferences, unsubscribeWithToken } from "@/lib/services/comm-prefs";
import { readUnsubscribeToken, unsubscribeToken } from "@/lib/unsubscribe-token";
import { handleInboundSms, handleStatusCallback } from "@/lib/services/inbound-sms";
import { queuePortalNotification } from "@/lib/services/notifications";
import { dispatchAppointmentNotices } from "@/lib/services/appointment-notices";
import { setClientTexting } from "@/lib/services/staff-alerts";
import { submitSmsConsent } from "@/lib/services/sms-consent";
import { sendSms } from "@/lib/twilio";
import { POST as oneClick } from "@/app/api/unsubscribe/[token]/route";
import type { Actor } from "@/lib/auth/actor";

// Fictional people only. Midday Central, so texts are inside the 8 a.m.–8 p.m. window.
const NOON = new Date("2026-11-04T18:00:00Z");
const ENV = {
  LIVE_SENDING_ENABLED: "true",
  CAMPAIGN_SENDING_ENABLED: "true",
  NOTIFICATIONS_ENABLED: "true",
  RESEND_API_KEY: "re_test",
  EMAIL_FROM_ADDRESS: "office@example.com",
  TWILIO_ACCOUNT_SID: "ACtest",
  TWILIO_AUTH_TOKEN: "test-token",
  TWILIO_FROM_NUMBER: "+15550109999",
  BUSINESS_MAILING_ADDRESS: "100 Example Ave, Sampletown, AL 35000",
  APP_URL: "https://portal.example.com",
};

type Sent = { kind: "email" | "sms"; to: string; body: string; headers?: Record<string, string>; html?: string };
let sent: Sent[] = [];
let twilioError: number | null = null;

beforeEach(async () => {
  await resetDb();
  sent = [];
  twilioError = null;
  Object.assign(process.env, ENV);
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOON);
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    if (String(url).includes("api.resend.com")) {
      const b = JSON.parse(String(init.body));
      sent.push({ kind: "email", to: b.to[0], body: b.text, headers: b.headers, html: b.html });
      return new Response(JSON.stringify({ id: `em_${sent.length}` }), { status: 200 });
    }
    if (String(url).includes("api.twilio.com")) {
      const p = new URLSearchParams(String(init.body));
      if (twilioError) return new Response(JSON.stringify({ code: twilioError, message: "Attempt to send to unsubscribed recipient" }), { status: 400 });
      sent.push({ kind: "sms", to: p.get("To")!, body: p.get("Body")! });
      return new Response(JSON.stringify({ sid: `SM${String(sent.length).padStart(32, "0")}` }), { status: 201 });
    }
    return new Response(JSON.stringify({ clean: true }), { status: 200 });
  });
});

afterEach(() => {
  for (const k of [...Object.keys(ENV), "SMS_KEYWORD_REPLIES"]) delete process.env[k];
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const AVERY_PHONE = "+15550100141";

async function setup() {
  const admin = await makeUser("ADMIN", "Tabitha");
  await prisma.ownerAccess.create({ data: { userId: admin.id, isPrimary: true } });
  const avery = await createClient(admin, { firstName: "Avery", lastName: "Fictional", email: "avery@example.com", phone: "5550100141", clientType: "INDIVIDUAL", status: "ACTIVE" });
  const blake = await createClient(admin, { firstName: "Blake", lastName: "Pretend", email: "blake@example.com", phone: "5550100142", clientType: "INDIVIDUAL", status: "ACTIVE" });
  const pu = await prisma.portalUser.create({ data: { email: "avery@example.com", name: "Avery Fictional", phone: "(555) 010-0141", phoneNormalized: AVERY_PHONE, passwordHash: "x", notifyByEmail: true, notifyBySms: true } });
  await prisma.portalAccess.create({ data: { portalUserId: pu.id, clientId: avery.id, role: "OWNER" } });
  return { admin, avery, blake, pu };
}

/** What the portal "Save Preferences" button does. */
async function portalSave(portalUserId: string, changes: { promoSms: boolean; promoEmail: boolean; generalUpdates: boolean }) {
  const { targets, emails, phones } = await portalPeople(portalUserId);
  return setCommunicationPreferences({ targets, emails, phones, changes, source: "PORTAL", portalUserId });
}

async function campaign(admin: Actor, purpose: "TAX_PREP_PROMO" | "SERVICE" | "GENERAL_UPDATE", channel: "EMAIL" | "SMS", clientIds: string[]) {
  const c = await createCampaign(admin, { title: `T ${purpose}`, purpose, channel });
  await updateCampaignDraft(admin, c.id, { title: c.title, purpose, channel, emailSubject: "News from our office", body: "Hello from the office.", smsBody: "Hello from the office." });
  await setAudience(admin, c.id, { groupIds: [], clientIds });
  return c;
}
const send = (admin: Actor, id: string) => scheduleCampaign(admin, id, null, NOON);

describe("Communication Preferences: saving and immediate enforcement", () => {
  it("each toggle saves to the profile, writes through to the ledger, and the campaign sender honors it on the next send", async () => {
    const { admin, avery, pu } = await setup();
    const before = await preferenceState((await portalPeople(pu.id)).targets);
    expect(before).toMatchObject({ promoEmail: false, promoSms: false, generalUpdates: true });

    await portalSave(pu.id, { promoSms: true, promoEmail: true, generalUpdates: true });
    let state = await preferenceState((await portalPeople(pu.id)).targets);
    expect(state).toMatchObject({ promoEmail: true, promoSms: true, generalUpdates: true });
    expect(await prisma.consentRecord.count({ where: { clientId: avery.id, kind: "EMAIL_MARKETING", status: "GRANTED" } })).toBe(1);
    expect((await prisma.smsConsentEvent.findFirstOrThrow({ where: { phoneNormalized: AVERY_PHONE, category: "MARKETING" } })).consentText).toMatch(/promotional SMS/);

    const promoEmail = await campaign(admin, "TAX_PREP_PROMO", "EMAIL", [avery.id]);
    const promoSms = await campaign(admin, "TAX_PREP_PROMO", "SMS", [avery.id]);
    // Tax-prep promotions need 7216 consent only for tax-return-derived contacts; Avery was added by staff.
    expect((await send(admin, promoEmail.id))!.sent).toBe(1);
    expect((await send(admin, promoSms.id))!.sent).toBe(1);
    expect(sent.map((s) => s.kind)).toEqual(["email", "sms"]);

    // Turn promotional email off only: email campaigns stop, texts continue.
    await portalSave(pu.id, { promoSms: true, promoEmail: false, generalUpdates: true });
    expect(await prisma.suppression.count({ where: { channel: "EMAIL", addressNormalized: "avery@example.com", reason: "UNSUBSCRIBE", liftedAt: null } })).toBe(1);
    expect((await canSend({ channel: "EMAIL", address: "avery@example.com", category: "PROMOTIONAL" })).ok).toBe(false);
    expect((await canSend({ channel: "SMS", address: AVERY_PHONE, category: "PROMOTIONAL" })).ok).toBe(true);
    const e2 = await campaign(admin, "TAX_PREP_PROMO", "EMAIL", [avery.id]);
    expect((await campaignRecipients(e2.id)).excluded[0].reason).toMatch(/Unsubscribed/);
    expect((await send(admin, e2.id))!.sent).toBe(0);

    // Turn promotional texts off.
    await portalSave(pu.id, { promoSms: false, promoEmail: false, generalUpdates: true });
    const s2 = await campaign(admin, "TAX_PREP_PROMO", "SMS", [avery.id]);
    expect((await send(admin, s2.id))!.sent).toBe(0);
    expect(sent).toHaveLength(2);

    // Opting back in to promotional email lifts only the unsubscribe.
    await portalSave(pu.id, { promoSms: false, promoEmail: true, generalUpdates: true });
    state = await preferenceState((await portalPeople(pu.id)).targets);
    expect(state).toMatchObject({ promoEmail: true, promoSms: false });

    // History: who/what/when/source, one row per real change.
    const history = await prisma.communicationPreferenceChange.findMany({ where: { clientId: avery.id }, orderBy: { createdAt: "asc" } });
    expect(history.map((h) => `${h.category}:${h.subscribed}:${h.source}`)).toEqual([
      "PROMO_EMAIL:true:PORTAL",
      "PROMO_SMS:true:PORTAL",
      "PROMO_EMAIL:false:PORTAL",
      "PROMO_SMS:false:PORTAL",
      "PROMO_EMAIL:true:PORTAL",
    ]);
    expect(history.every((h) => h.portalUserId === pu.id)).toBe(true);
  });

  it("general business updates: the announcement sender skips people who turned them off", async () => {
    const { admin, avery, blake, pu } = await setup();
    const ann = await prisma.announcement.create({ data: { title: "Office closed Thanksgiving", body: "We're closed Nov 26–27.", audience: "ALL", topic: "HOLIDAY", publishedAt: NOON, createdById: admin.id } });
    const c1 = await campaignFromAnnouncement(admin, ann.id);
    expect(c1.purpose).toBe("GENERAL_UPDATE");
    await setAudience(admin, c1.id, { groupIds: [], clientIds: [avery.id, blake.id] });
    expect((await send(admin, c1.id))!.sent).toBe(2);
    // General updates are not promotional, but they carry an unsubscribe link and one-click headers.
    const mail = sent.find((s) => s.to === "avery@example.com")!;
    expect(mail.headers?.["List-Unsubscribe-Post"]).toBe("List-Unsubscribe=One-Click");
    expect(mail.html).toMatch(/Unsubscribe from general updates/);
    const token = /\/api\/unsubscribe\/([^>]+)>/.exec(mail.headers!["List-Unsubscribe"])![1];
    expect(readUnsubscribeToken(token)).toMatchObject({ ok: true, payload: { clientId: avery.id, kind: "GENERAL" } });

    await portalSave(pu.id, { promoSms: false, promoEmail: false, generalUpdates: false });
    expect(await prisma.communicationPreference.count({ where: { clientId: avery.id, personKey: "primary", generalUpdates: false } })).toBe(1);
    const c2 = await campaignFromAnnouncement(admin, ann.id);
    await setAudience(admin, c2.id, { groupIds: [], clientIds: [avery.id, blake.id] });
    const r = await send(admin, c2.id);
    expect(r!.sent).toBe(1);
    expect(sent.slice(2).map((s) => s.to)).toEqual(["blake@example.com"]);
    expect((await campaignRecipients(c2.id)).excluded.find((x) => x.clientId === avery.id)?.reason).toMatch(/general business updates/);
  });

  it("essential notices still send after opting out of everything nonessential", async () => {
    const { admin, avery, pu } = await setup();
    await submitSmsConsent({ name: "Avery Fictional", phone: "5550100141", service: true, marketing: true, sourcePage: "/sms-consent", ip: null, userAgent: null });
    await portalSave(pu.id, { promoSms: false, promoEmail: false, generalUpdates: false });
    expect((await canSend({ channel: "EMAIL", address: "avery@example.com", category: "ESSENTIAL" })).ok).toBe(true);
    expect((await canSend({ channel: "SMS", address: AVERY_PHONE, category: "ESSENTIAL" })).ok).toBe(true);

    await queuePortalNotification(pu.id, "NEW_INVOICE", "inv-1");
    const notes = await prisma.notification.findMany({ where: { portalUserId: pu.id }, orderBy: { channel: "asc" } });
    expect(notes.map((n) => `${n.channel}:${n.status}`)).toEqual(["EMAIL:SENT", "SMS:SENT"]);

    // A service campaign (appointments, documents, deadlines) reaches them, with no marketing unsubscribe.
    const svc = await campaign(admin, "SERVICE", "EMAIL", [avery.id]);
    expect((await send(admin, svc.id))!.sent).toBe(1);
    const mail = sent.filter((s) => s.kind === "email").at(-1)!;
    expect(mail.headers).toBeUndefined();
    expect(mail.html).toMatch(/Email preferences/);
    expect(mail.html).not.toMatch(/>Unsubscribe</);
  });

  it("promotional email carries a footer link and RFC 8058 one-click headers", async () => {
    const { admin, avery, pu } = await setup();
    await portalSave(pu.id, { promoSms: false, promoEmail: true, generalUpdates: true });
    const c = await campaign(admin, "TAX_PREP_PROMO", "EMAIL", [avery.id]);
    await send(admin, c.id);
    const mail = sent[0];
    expect(mail.headers?.["List-Unsubscribe"]).toMatch(/^<https:\/\/portal\.example\.com\/api\/unsubscribe\/[^>]+>$/);
    expect(mail.headers?.["List-Unsubscribe-Post"]).toBe("List-Unsubscribe=One-Click");
    expect(mail.html).toMatch(/https:\/\/portal\.example\.com\/unsubscribe\/[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/);
    expect(mail.body).toMatch(/Unsubscribe: https:\/\/portal\.example\.com\/unsubscribe\//);
    expect(mail.html).toContain("100 Example Ave");
  });
});

describe("Unsubscribe links", () => {
  it("valid token unsubscribes; tampered and expired tokens change nothing", async () => {
    const { avery } = await setup();
    await prisma.consentRecord.create({ data: { clientId: avery.id, kind: "EMAIL_MARKETING", status: "GRANTED", effectiveAt: NOON, source: "Signed form" } });
    const token = unsubscribeToken({ clientId: avery.id, contactId: null, email: "avery@example.com", kind: "PROMO" });

    const [body, sig] = token.split(".");
    const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(body, "base64url").toString()), e: "someone@example.com" })).toString("base64url");
    expect(await unsubscribeWithToken(`${forged}.${sig}`, "THIS", "EMAIL_LINK")).toEqual({ ok: false, reason: "invalid" });
    expect(await unsubscribeWithToken(`${body}.${sig.slice(0, -2)}xx`, "THIS", "EMAIL_LINK")).toEqual({ ok: false, reason: "invalid" });
    expect(await unsubscribeWithToken("not-a-token", "THIS", "EMAIL_LINK")).toEqual({ ok: false, reason: "invalid" });
    const old = unsubscribeToken({ clientId: avery.id, contactId: null, email: "avery@example.com", kind: "PROMO" }, NOON.getTime() - 400 * 24 * 3600_000);
    expect(await unsubscribeWithToken(old, "THIS", "EMAIL_LINK")).toEqual({ ok: false, reason: "expired" });
    expect(await prisma.suppression.count()).toBe(0);
    expect(await prisma.communicationPreferenceChange.count()).toBe(0);

    expect((await unsubscribeWithToken(token, "THIS", "EMAIL_LINK")).ok).toBe(true);
    expect((await canSend({ channel: "EMAIL", address: "avery@example.com", category: "PROMOTIONAL" })).ok).toBe(false);
    // Promotional only: general updates continue.
    expect((await canSend({ channel: "EMAIL", address: "avery@example.com", category: "GENERAL_UPDATE" })).ok).toBe(true);
    expect(await prisma.communicationPreferenceChange.findFirstOrThrow({ where: { clientId: avery.id } })).toMatchObject({ category: "PROMO_EMAIL", subscribed: false, source: "EMAIL_LINK" });

    // "All non-essential" also stops general updates.
    expect((await unsubscribeWithToken(token, "ALL", "EMAIL_LINK")).ok).toBe(true);
    expect((await canSend({ channel: "EMAIL", address: "avery@example.com", category: "GENERAL_UPDATE" })).ok).toBe(false);
    expect((await canSend({ channel: "EMAIL", address: "avery@example.com", category: "ESSENTIAL" })).ok).toBe(true);
  });

  it("one-click POST unsubscribes (and only with the RFC 8058 body)", async () => {
    const { avery } = await setup();
    const token = unsubscribeToken({ clientId: avery.id, contactId: null, email: "avery@example.com", kind: "PROMO" });
    const req = (t: string, body = "List-Unsubscribe=One-Click") => new Request(`https://portal.example.com/api/unsubscribe/${t}`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body });
    expect((await oneClick(req(token, ""), { params: Promise.resolve({ token }) })).status).toBe(400);
    expect((await oneClick(req("bad.token"), { params: Promise.resolve({ token: "bad.token" }) })).status).toBe(404);
    expect(await prisma.suppression.count()).toBe(0);
    const res = await oneClick(req(token), { params: Promise.resolve({ token }) });
    expect(res.status).toBe(200);
    expect(await prisma.suppression.count({ where: { addressNormalized: "avery@example.com", reason: "UNSUBSCRIBE", liftedAt: null } })).toBe(1);
    expect((await prisma.communicationPreferenceChange.findFirstOrThrow({ where: { clientId: avery.id } })).source).toBe("ONE_CLICK");
  });

  it("isolation: one client's token can't change another client's preferences", async () => {
    const { avery, blake } = await setup();
    for (const c of [avery, blake]) await prisma.consentRecord.create({ data: { clientId: c.id, kind: "EMAIL_MARKETING", status: "GRANTED", effectiveAt: NOON, source: "Signed form" } });
    const averyToken = unsubscribeToken({ clientId: avery.id, contactId: null, email: "avery@example.com", kind: "PROMO" });
    // Re-pointing Avery's signed token at Blake breaks the signature.
    const [body, sig] = averyToken.split(".");
    const atBlake = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(body, "base64url").toString()), c: blake.id, e: "blake@example.com" })).toString("base64url");
    expect((await unsubscribeWithToken(`${atBlake}.${sig}`, "ALL", "EMAIL_LINK")).ok).toBe(false);
    // Avery's own token changes only Avery.
    await unsubscribeWithToken(averyToken, "ALL", "EMAIL_LINK");
    expect((await canSend({ channel: "EMAIL", address: "blake@example.com", category: "PROMOTIONAL" })).ok).toBe(true);
    expect((await canSend({ channel: "EMAIL", address: "blake@example.com", category: "GENERAL_UPDATE" })).ok).toBe(true);
    expect(await prisma.communicationPreferenceChange.count({ where: { clientId: blake.id } })).toBe(0);
    expect(await prisma.communicationPreferenceChange.count({ where: { clientId: avery.id } })).toBe(2);
  });
});

describe("SMS STOP / START", () => {
  it("STOP via the webhook turns off promotional texts and blocks the number; START restores it", async () => {
    const { avery, pu } = await setup();
    await submitSmsConsent({ name: "Avery Fictional", phone: "5550100141", service: true, marketing: false, sourcePage: "/sms-consent", ip: null, userAgent: null });
    await portalSave(pu.id, { promoSms: true, promoEmail: false, generalUpdates: true });
    process.env.SMS_KEYWORD_REPLIES = "app";

    const stop = await handleInboundSms({ MessageSid: "SMstop1", From: AVERY_PHONE, Body: "STOP" });
    expect(stop.reply).toMatch(/unsubscribed.*Reply START/);
    let state = await preferenceState((await portalPeople(pu.id)).targets);
    expect(state).toMatchObject({ promoSms: false, smsBlocked: true });
    for (const category of ["PROMOTIONAL", "ESSENTIAL", "GENERAL_UPDATE"] as const) {
      expect((await canSend({ channel: "SMS", address: AVERY_PHONE, category })).ok).toBe(false);
    }
    // Nobody but the client can lift it — not the portal toggle either.
    await expect(portalSave(pu.id, { promoSms: true, promoEmail: false, generalUpdates: true })).rejects.toThrow(/replied STOP/);

    const start = await handleInboundSms({ MessageSid: "SMstart1", From: AVERY_PHONE, Body: "START" });
    expect(start.reply).toMatch(/resubscribed/);
    state = await preferenceState((await portalPeople(pu.id)).targets);
    expect(state).toMatchObject({ promoSms: true, smsBlocked: false });
    expect((await canSend({ channel: "SMS", address: AVERY_PHONE, category: "ESSENTIAL" })).ok).toBe(true);

    const history = await prisma.communicationPreferenceChange.findMany({ where: { clientId: avery.id, category: "PROMO_SMS" }, orderBy: { createdAt: "asc" } });
    expect(history.map((h) => `${h.subscribed}:${h.source}`)).toEqual(["true:PORTAL", "false:STOP_REPLY", "true:START_REPLY"]);
  });

  it("START restores only what was agreed before STOP", async () => {
    await setup();
    await submitSmsConsent({ name: "Avery Fictional", phone: "5550100141", service: true, marketing: false, sourcePage: "/sms-consent", ip: null, userAgent: null });
    await handleInboundSms({ MessageSid: "SMs", From: AVERY_PHONE, Body: "stop" });
    await handleInboundSms({ MessageSid: "SMt", From: AVERY_PHONE, Body: "unstop" });
    expect((await canSend({ channel: "SMS", address: AVERY_PHONE, category: "ESSENTIAL" })).ok).toBe(true);
    expect((await canSend({ channel: "SMS", address: AVERY_PHONE, category: "PROMOTIONAL" })).ok).toBe(false);
  });

  it("after STOP, appointment and billing texts are skipped (status recorded) while the essential email still sends", async () => {
    const { admin, avery, pu } = await setup();
    await submitSmsConsent({ name: "Avery Fictional", phone: "5550100141", service: true, marketing: true, sourcePage: "/sms-consent", ip: null, userAgent: null });
    await setClientTexting(admin, true);
    await handleInboundSms({ MessageSid: "SMstop2", From: AVERY_PHONE, Body: "Stop" });

    // Appointment reminder (text + email).
    const starts = new Date(NOON.getTime() + 20 * 3600_000);
    const appt = await prisma.appointment.create({
      data: { clientId: avery.id, title: "Consultation", startsAt: starts, endsAt: new Date(starts.getTime() + 3600_000), durationMin: 60, staffId: admin.id, status: "CONFIRMED", source: "PORTAL", services: ["CONSULTATION"], meetingType: "IN_OFFICE", location: "In office", createdById: admin.id, smsOptIn: true, bookingInfo: {} },
    });
    for (const channel of ["SMS", "EMAIL"]) {
      await prisma.appointmentNotice.create({ data: { appointmentId: appt.id, audience: "CLIENT", channel, kind: "REMINDER_24H", version: appt.version, to: channel === "SMS" ? AVERY_PHONE : "avery@example.com", subject: "Reminder", body: "See you tomorrow.", notBefore: NOON, idempotencyKey: `r24:${appt.id}:${channel}` } });
    }
    await dispatchAppointmentNotices(NOON);
    const notices = await prisma.appointmentNotice.findMany({ where: { appointmentId: appt.id }, orderBy: { channel: "asc" } });
    expect(notices.map((n) => `${n.channel}:${n.status}`)).toEqual(["EMAIL:SENT", "SMS:SKIPPED"]);
    expect(notices.find((n) => n.channel === "SMS")!.statusDetail).toMatch(/STOP/);

    // Billing notice (new invoice): text skipped, email sent.
    await queuePortalNotification(pu.id, "NEW_INVOICE", "inv-9");
    const billing = await prisma.notification.findMany({ where: { portalUserId: pu.id, kind: "NEW_INVOICE" }, orderBy: { channel: "asc" } });
    expect(billing.map((n) => `${n.channel}:${n.status}`)).toEqual(["EMAIL:SENT", "SMS:SKIPPED"]);
    expect(billing.find((n) => n.channel === "SMS")!.statusDetail).toMatch(/STOP/);

    expect(sent.filter((s) => s.kind === "sms")).toHaveLength(0);
    expect(sent.filter((s) => s.kind === "email").map((s) => s.to)).toEqual(["avery@example.com", "avery@example.com"]);
    // Shown on the profile / portal.
    expect((await preferenceState([{ clientId: avery.id, contactId: null }])).smsBlocked).toBe(true);
  });

  it("Twilio error 21610 blocks the number for every sender; START lifts it", async () => {
    await setup();
    await submitSmsConsent({ name: "Avery Fictional", phone: "5550100141", service: true, marketing: false, sourcePage: "/sms-consent", ip: null, userAgent: null });
    twilioError = 21610;
    const r = await sendSms(AVERY_PHONE, "Your appointment is confirmed.");
    expect(r).toMatchObject({ ok: false, blocked: true });
    expect(await prisma.suppression.count({ where: { channel: "SMS", addressNormalized: AVERY_PHONE, liftedAt: null } })).toBe(1);
    twilioError = null;
    // Blocked before Twilio is even called.
    expect((await sendSms(AVERY_PHONE, "Second try")).blocked).toBe(true);
    expect(sent).toHaveLength(0);
    expect((await canSend({ channel: "SMS", address: AVERY_PHONE, category: "ESSENTIAL" })).ok).toBe(false);

    await handleInboundSms({ MessageSid: "SMstart9", From: AVERY_PHONE, Body: "START" });
    expect((await sendSms(AVERY_PHONE, "Welcome back")).ok).toBe(true);
    expect(sent).toHaveLength(1);
  });

  it("a 21610 in a delivery-status callback also blocks the number", async () => {
    await handleStatusCallback({ MessageSid: "SM00000000000000000000000000000001", MessageStatus: "failed", ErrorCode: "21610", To: AVERY_PHONE });
    expect((await sendSms(AVERY_PHONE, "x")).blocked).toBe(true);
  });
});

describe("Staff changes on the client's request", () => {
  it("are logged with who and how the client asked, and can't lift a STOP", async () => {
    const { admin, avery } = await setup();
    await setCommunicationPreferences({ targets: [{ clientId: avery.id, contactId: null }], changes: { generalUpdates: false }, source: "STAFF", actorId: admin.id, note: "Phone call with Avery, 11/4" });
    expect(await prisma.communicationPreferenceChange.findFirstOrThrow({ where: { clientId: avery.id } })).toMatchObject({ category: "GENERAL_UPDATES", subscribed: false, source: "STAFF", actorId: admin.id, note: "Phone call with Avery, 11/4" });
    await handleInboundSms({ MessageSid: "SMx", From: AVERY_PHONE, Body: "STOP" });
    await expect(setCommunicationPreferences({ targets: [{ clientId: avery.id, contactId: null }], changes: { promoSms: true }, source: "STAFF", actorId: admin.id, note: "x" })).rejects.toThrow(/Only the client can lift it/);
  });
});
