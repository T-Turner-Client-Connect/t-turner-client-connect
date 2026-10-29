import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeUser, prisma, resetDb } from "./db";
import { createClient, recordConsent } from "@/lib/services/clients";
import { currentSmsConsent, smsSendAllowed, submitSmsConsent } from "@/lib/services/sms-consent";
import { handleInboundSms, handleStatusCallback } from "@/lib/services/inbound-sms";
import { twilioSignature, verifyTwilioRequest } from "@/lib/twilio";
import { campaignRecipients, createCampaign, setAudience } from "@/lib/services/campaigns";
import { commitImport, stageImport } from "@/lib/services/imports";
import { SMS_CONSENT_TEXT, SMS_CONSENT_VERSION } from "@/lib/business";
import { acceptPortalInvite, invitePortalUser } from "@/lib/services/portal-accounts";
import { dispatchPendingNotifications, queuePortalNotification } from "@/lib/services/notifications";

beforeEach(resetDb);
afterEach(() => {
  delete process.env.TWILIO_AUTH_TOKEN;
  delete process.env.NOTIFICATIONS_ENABLED;
});

const PHONE = "+15550100101";
const form = (over: Partial<Parameters<typeof submitSmsConsent>[0]> = {}) =>
  submitSmsConsent({ name: "Avery Lindqvist", phone: "(555) 010-0101", service: false, marketing: false, sourcePage: "/sms-consent", ip: "203.0.113.5", userAgent: "test", ...over });

describe("SMS consent form", () => {
  it("stores exactly what was chosen, with wording, version, time and source", async () => {
    const staff = await makeUser("ADMIN");
    const avery = await createClient(staff, { firstName: "Avery", lastName: "Lindqvist", phone: "5550100101", clientType: "INDIVIDUAL", status: "ACTIVE" });

    const none = await form();
    expect(none.serviceOptIn).toBe(false);
    expect(await prisma.smsConsentEvent.count()).toBe(0);

    const sub = await form({ service: true });
    expect(sub.matchedClientIds).toEqual([avery.id]);
    expect(sub.consentVersion).toBe(SMS_CONSENT_VERSION);
    expect(sub.serviceText).toBe(SMS_CONSENT_TEXT.SERVICE);
    expect(sub.ipHash).not.toContain("203.0.113.5");
    const ev = await prisma.smsConsentEvent.findFirstOrThrow({ where: { phoneNormalized: PHONE, category: "SERVICE" } });
    expect(ev).toMatchObject({ status: "GRANTED", source: "WEB_FORM", sourcePage: "/sms-consent", consentVersion: SMS_CONSENT_VERSION, consentText: SMS_CONSENT_TEXT.SERVICE, submissionId: sub.id });
    expect(await currentSmsConsent(prisma, PHONE, "MARKETING")).toBe("UNKNOWN");
    expect(await prisma.consentRecord.count({ where: { clientId: avery.id, kind: "SMS_SERVICE", status: "GRANTED" } })).toBe(1);

    // Unchecking later withdraws that category.
    await form({ service: false, marketing: true });
    expect(await currentSmsConsent(prisma, PHONE, "SERVICE")).toBe("REVOKED");
    expect(await currentSmsConsent(prisma, PHONE, "MARKETING")).toBe("GRANTED");
  });

  it("saves nothing on invalid input, bots or floods", async () => {
    await expect(form({ phone: "12345" })).rejects.toThrow(/mobile number/);
    await expect(form({ name: " " })).rejects.toThrow(/name/);
    await expect(form({ service: true, honeypot: "spam.example" })).rejects.toThrow();
    expect(await prisma.smsConsentSubmission.count()).toBe(0);
    for (let i = 0; i < 5; i++) await form();
    await expect(form()).rejects.toThrow(/Too many/);
  });

  it("imports never create text consent", async () => {
    const staff = await makeUser("STAFF");
    const b = await stageImport(staff, { fileName: "x.csv", source: "TaxAct", taxReturnDerived: true, mapping: { N: "fullName", P: "phone" }, rows: [{ fullName: "A B", phone: "5550100101" }] });
    await commitImport(staff, b.id, "fill_blanks");
    expect(await prisma.smsConsentEvent.count()).toBe(0);
    expect((await smsSendAllowed(PHONE, "SERVICE")).ok).toBe(false);
  });
});

describe("STOP / HELP / START and Twilio webhooks", () => {
  it("verifies Twilio signatures", () => {
    process.env.TWILIO_AUTH_TOKEN = "test-token";
    const url = "https://example.com/api/webhooks/twilio/inbound";
    const params = { From: "+15550100101", Body: "STOP", MessageSid: "SM1" };
    const sig = twilioSignature("test-token", url, params);
    expect(verifyTwilioRequest(url, params, sig)).toBe(true);
    expect(verifyTwilioRequest(url, { ...params, Body: "START" }, sig)).toBe(false);
    expect(verifyTwilioRequest(url, params, null)).toBe(false);
  });

  it("STOP opts the number out of everything; only a new opt-in restores it", async () => {
    const staff = await makeUser("ADMIN");
    const avery = await createClient(staff, { firstName: "Avery", lastName: "Lindqvist", phone: "5550100101", clientType: "INDIVIDUAL", status: "ACTIVE" });
    await form({ service: true, marketing: true });
    expect((await smsSendAllowed(PHONE, "MARKETING")).ok).toBe(true);

    await handleInboundSms({ MessageSid: "SM100", From: "+15550100101", Body: "Stop" });
    await handleInboundSms({ MessageSid: "SM100", From: "+15550100101", Body: "Stop" }); // Twilio retry
    expect(await prisma.inboundSms.count()).toBe(1);
    expect(await prisma.suppression.count({ where: { addressNormalized: PHONE, liftedAt: null } })).toBe(1);
    expect((await smsSendAllowed(PHONE, "SERVICE")).ok).toBe(false);

    const campaign = await createCampaign(staff, { title: "Reminder", purpose: "SERVICE", channel: "SMS" });
    await setAudience(staff, campaign.id, { groupIds: [], clientIds: [avery.id] });
    expect((await campaignRecipients(campaign.id)).excluded[0].reason).toMatch(/STOP/);

    // START alone does not re-subscribe (Terms: opt in again on the form).
    await handleInboundSms({ MessageSid: "SM101", From: "+15550100101", Body: "START" });
    expect((await smsSendAllowed(PHONE, "SERVICE")).ok).toBe(false);
    // Staff can't override a STOP.
    await expect(recordConsent(staff, avery.id, { kind: "SMS_SERVICE", status: "GRANTED", source: "Phone call" })).rejects.toThrow(/STOP/);
    // A new form opt-in does.
    await form({ service: true });
    expect((await smsSendAllowed(PHONE, "SERVICE")).ok).toBe(true);
    expect((await smsSendAllowed(PHONE, "MARKETING")).ok).toBe(false);
  });

  it("HELP/STOP replies come from Twilio unless the app is set to answer", async () => {
    expect((await handleInboundSms({ MessageSid: "SM200", From: "+15550100102", Body: "HELP" })).reply).toBeNull();
    process.env.SMS_KEYWORD_REPLIES = "app";
    const r = await handleInboundSms({ MessageSid: "SM201", From: "+15550100102", Body: "help" });
    expect(r.reply).toMatch(/205-659-5448/);
    delete process.env.SMS_KEYWORD_REPLIES;
  });

  it("files a normal reply under the matching client's conversation", async () => {
    const staff = await makeUser("ADMIN");
    const c = await createClient(staff, { firstName: "Theo", lastName: "Brandt", phone: "5550100106", clientType: "INDIVIDUAL", status: "ACTIVE" });
    await handleInboundSms({ MessageSid: "SM300", From: "+15550100106", Body: "Running late, see you at 3" });
    const convo = await prisma.conversation.findFirstOrThrow({ where: { clientId: c.id }, include: { messages: true } });
    expect(convo.awaitingStaff).toBe(true);
    expect(convo.messages[0]).toMatchObject({ channel: "SMS", direction: "INBOUND" });
  });

  it("delivery callbacks update status; failures are recorded as failed", async () => {
    const staff = await makeUser("ADMIN");
    const c = await createClient(staff, { businessName: "Cb LLC", clientType: "BUSINESS", status: "ACTIVE" });
    const { token } = await invitePortalUser(staff, c.id, { email: "cb@example.com", name: "Cb", role: "OWNER" });
    const u = await acceptPortalInvite(token!, "Portal-Pass-123");
    await prisma.notification.create({ data: { portalUserId: u.id, channel: "SMS", kind: "NEW_MESSAGE", idempotencyKey: "k1", status: "SENT", providerSid: "SM400" } });
    await handleStatusCallback({ MessageSid: "SM400", MessageStatus: "undelivered", ErrorCode: "30003" });
    expect(await prisma.notification.findUniqueOrThrow({ where: { idempotencyKey: "k1" } })).toMatchObject({ status: "FAILED", deliveryStatus: "undelivered" });
  });
});

describe("text notifications require service consent", () => {
  it("skips SMS without consent and never reports a send without a provider", async () => {
    process.env.NOTIFICATIONS_ENABLED = "true";
    const staff = await makeUser("ADMIN");
    const c = await createClient(staff, { businessName: "Notify LLC", clientType: "BUSINESS", status: "ACTIVE" });
    const { token } = await invitePortalUser(staff, c.id, { email: "n2@example.com", name: "N", role: "OWNER" });
    const u = await acceptPortalInvite(token!, "Portal-Pass-123");
    await prisma.portalUser.update({ where: { id: u.id }, data: { notifyByEmail: false, notifyBySms: true, phone: "5550100107", phoneNormalized: "+15550100107" } });
    await queuePortalNotification(u.id, "NEW_MESSAGE", "ref-1");
    expect(await prisma.notification.findFirstOrThrow({ where: { portalUserId: u.id } })).toMatchObject({ status: "SKIPPED" });

    await form({ phone: "5550100107", service: true });
    await queuePortalNotification(u.id, "NEW_MESSAGE", "ref-2");
    await dispatchPendingNotifications(u.id);
    const n = await prisma.notification.findFirstOrThrow({ where: { portalUserId: u.id, idempotencyKey: { contains: "ref-2" } } });
    expect(n.status).toBe("FAILED");
    expect(n.statusDetail).toMatch(/not set up/);
  });
});
