import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeUser, prisma, resetDb } from "./db";
import { ForbiddenError } from "@/lib/auth/actor";
import { createClient } from "@/lib/services/clients";
import { submitSmsConsent } from "@/lib/services/sms-consent";
import { attachInboundToClient, handleInboundSms, handleStatusCallback } from "@/lib/services/inbound-sms";
import { notificationText } from "@/lib/services/notifications";
import { channelAvailability, markClientRead, portalConversations, portalSendMessage, SMS_OPT_OUT_FOOTER, staffSendMessage } from "@/lib/services/messaging";
import { clientTextingOn, setClientTexting } from "@/lib/services/staff-alerts";
import { acceptPortalInvite, invitePortalUser } from "@/lib/services/portal-accounts";
import { twilioSignature, verifyTwilioRequest } from "@/lib/twilio";
import { POST as inboundRoute } from "@/app/api/webhooks/twilio/inbound/route";
import { POST as statusRoute } from "@/app/api/webhooks/twilio/status/route";

// Fictional clients and 555-01xx numbers only. Twilio is simulated: no real text is ever sent.
const sent: { to: string; body: string }[] = [];
let twilioUp = true;
let sidN = 0;

beforeEach(async () => {
  await resetDb();
  sent.length = 0;
  twilioUp = true;
  process.env.TWILIO_ACCOUNT_SID = "ACtest";
  process.env.TWILIO_AUTH_TOKEN = "test-token";
  process.env.TWILIO_MESSAGING_SERVICE_SID = "MGtest";
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
    if (!String(url).startsWith("https://api.twilio.com/")) throw new Error(`Unexpected network call: ${url}`);
    const p = new URLSearchParams(String(init.body));
    if (!twilioUp) return new Response(JSON.stringify({ code: 21610 }), { status: 400 });
    sent.push({ to: p.get("To")!, body: p.get("Body")! });
    return new Response(JSON.stringify({ sid: `SMsim${++sidN}` }), { status: 201 });
  }));
});
afterEach(() => {
  vi.unstubAllGlobals();
  for (const k of ["TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN", "TWILIO_MESSAGING_SERVICE_SID", "SMS_KEYWORD_REPLIES"]) delete process.env[k];
});

const optIn = (phone: string) => submitSmsConsent({ name: "Test Person", phone, service: true, marketing: false, sourcePage: "/sms-consent", ip: null, userAgent: "test" });

async function setup() {
  const tabitha = await makeUser("ADMIN", "Tabitha");
  await prisma.ownerAccess.create({ data: { userId: tabitha.id, isPrimary: true } });
  const daria = await makeUser("STAFF", "Daria");
  const theo = await createClient(tabitha, { firstName: "Theo", lastName: "Brandt (fictional)", phone: "5550100121", clientType: "INDIVIDUAL", status: "ACTIVE" });
  const mira = await createClient(tabitha, { firstName: "Mira", lastName: "Castell (fictional)", phone: "5550100122", clientType: "INDIVIDUAL", status: "ACTIVE" });
  return { tabitha, daria, theo, mira };
}

const text = (actor: Awaited<ReturnType<typeof makeUser>>, clientId: string, body: string, conversationId?: string) =>
  staffSendMessage(actor, { clientId, body, channel: "SMS", conversationId });

describe("client texting switch", () => {
  it("is off by default; only Tabitha can turn it on or off, and it's audited", async () => {
    const { tabitha, daria, theo } = await setup();
    await optIn("5550100121");
    expect(await clientTextingOn()).toBe(false);
    expect(channelAvailability(false).SMS).toMatchObject({ available: false, note: expect.stringMatching(/off/) });
    await expect(text(daria, theo.id, "Hi")).rejects.toThrow(/texting is off/);
    expect(sent).toHaveLength(0);

    await expect(setClientTexting(daria, true)).rejects.toBeInstanceOf(ForbiddenError);
    const otherAdmin = await makeUser("ADMIN", "Other");
    await expect(setClientTexting(otherAdmin, true)).rejects.toBeInstanceOf(ForbiddenError);
    await setClientTexting(tabitha, true);
    expect(await clientTextingOn()).toBe(true);
    expect(await prisma.auditLog.count({ where: { action: "client_texting.on", actorId: tabitha.id } })).toBe(1);
    await setClientTexting(tabitha, false);
    await expect(text(daria, theo.id, "Hi")).rejects.toThrow(/texting is off/);
    expect(sent).toHaveLength(0);
  });

  it("can't be turned on without Twilio configured", async () => {
    const { tabitha } = await setup();
    delete process.env.TWILIO_MESSAGING_SERVICE_SID;
    await expect(setClientTexting(tabitha, true)).rejects.toThrow(/Connect Twilio/);
  });
});

describe("staff → client texts", () => {
  it("refuses numbers without service-text consent, and after STOP", async () => {
    const { tabitha, daria, theo } = await setup();
    await setClientTexting(tabitha, true);
    await expect(text(daria, theo.id, "Hi")).rejects.toThrow(/consent|permission/i);
    await optIn("5550100121");
    await text(daria, theo.id, "Your documents are ready in the portal.");
    expect(sent).toHaveLength(1);
    await handleInboundSms({ MessageSid: "SMin-stop", From: "+15550100121", Body: "STOP" });
    await expect(text(daria, theo.id, "Another one")).rejects.toThrow(/Can't/);
    // START alone doesn't re-grant consent.
    await handleInboundSms({ MessageSid: "SMin-start", From: "+15550100121", Body: "START" });
    await expect(text(daria, theo.id, "Another one")).rejects.toThrow(/Can't/);
    expect(sent).toHaveLength(1);
  });

  it("sends, records Twilio's ID, then the delivery receipt sets Delivered or Not delivered", async () => {
    const { tabitha, daria, theo } = await setup();
    await setClientTexting(tabitha, true);
    await optIn("5550100121");
    const m1 = await text(daria, theo.id, "Your documents are ready in the portal.");
    expect(m1).toMatchObject({ channel: "SMS", direction: "OUTBOUND", status: "PROVIDER_ACCEPTED", providerId: "SMsim" + sidN, staffAuthorId: daria.id });
    // First text carries the opt-out line, and the saved text is exactly what was sent.
    expect(sent[0]).toEqual({ to: "+15550100121", body: `Your documents are ready in the portal.\n\n${SMS_OPT_OUT_FOOTER}` });
    expect(m1.body).toBe(sent[0].body);
    await handleStatusCallback({ MessageSid: m1.providerId!, MessageStatus: "sent" });
    expect((await prisma.message.findUniqueOrThrow({ where: { id: m1.id } })).status).toBe("PROVIDER_ACCEPTED");
    await handleStatusCallback({ MessageSid: m1.providerId!, MessageStatus: "delivered" });
    expect((await prisma.message.findUniqueOrThrow({ where: { id: m1.id } })).status).toBe("DELIVERED");

    // Later texts in the same thread: no footer, same conversation.
    const m2 = await text(daria, theo.id, "See you Tuesday at 2.");
    expect(sent[1].body).toBe("See you Tuesday at 2.");
    expect(m2.conversationId).toBe(m1.conversationId);
    await handleStatusCallback({ MessageSid: m2.providerId!, MessageStatus: "undelivered", ErrorCode: "30003" });
    expect(await prisma.message.findUniqueOrThrow({ where: { id: m2.id } })).toMatchObject({ status: "FAILED", errorDetail: expect.stringMatching(/30003/) });
    expect(await prisma.auditLog.count({ where: { action: "message.sms_sent", clientId: theo.id } })).toBe(2);
  });

  it("records a Twilio rejection as failed, never as sent", async () => {
    const { tabitha, daria, theo } = await setup();
    await setClientTexting(tabitha, true);
    await optIn("5550100121");
    twilioUp = false;
    const m = await text(daria, theo.id, "Hello");
    expect(m).toMatchObject({ status: "FAILED", errorDetail: expect.stringMatching(/rejected/) });
  });

  it("limits texts to 1,000 characters and never mixes texts into portal conversations", async () => {
    const { tabitha, daria, theo } = await setup();
    await setClientTexting(tabitha, true);
    await optIn("5550100121");
    await expect(text(daria, theo.id, "x".repeat(1001))).rejects.toThrow(/1000/);
    const portal = await staffSendMessage(daria, { clientId: theo.id, subject: "Q3", body: "Portal note", channel: "PORTAL" });
    await expect(text(daria, theo.id, "Hi", portal.conversationId)).rejects.toThrow(/Text Messages/);
    const sms = await text(daria, theo.id, "Hi");
    expect(sms.conversationId).not.toBe(portal.conversationId);
    await expect(staffSendMessage(daria, { clientId: theo.id, conversationId: sms.conversationId, body: "x", channel: "PORTAL" })).rejects.toThrow(/text \(SMS\) conversation/);
    // A note is fine in either.
    await staffSendMessage(daria, { clientId: theo.id, conversationId: sms.conversationId, body: "Called too", channel: "INTERNAL_NOTE" });
  });
});

describe("client → staff texts", () => {
  it("threads replies (and STOP/START/HELP, with a staff note) into the right client's text conversation", async () => {
    const { tabitha, daria, theo, mira } = await setup();
    await setClientTexting(tabitha, true);
    await optIn("5550100121");
    const out = await text(daria, theo.id, "Your documents are ready.");
    await handleInboundSms({ MessageSid: "SMin1", From: "+15550100121", Body: "Thanks, I'll sign in tonight" });
    await handleInboundSms({ MessageSid: "SMin1", From: "+15550100121", Body: "Thanks, I'll sign in tonight" }); // Twilio retry
    const thread = await prisma.message.findMany({ where: { conversationId: out.conversationId }, orderBy: { createdAt: "asc" } });
    expect(thread.map((m) => [m.channel, m.direction])).toEqual([["SMS", "OUTBOUND"], ["SMS", "INBOUND"]]);
    expect((await prisma.conversation.findUniqueOrThrow({ where: { id: out.conversationId } })).awaitingStaff).toBe(true);
    expect(await prisma.message.count({ where: { conversation: { clientId: mira.id } } })).toBe(0);

    await handleInboundSms({ MessageSid: "SMin2", From: "+15550100121", Body: "STOP" });
    const after = await prisma.message.findMany({ where: { conversationId: out.conversationId }, orderBy: { createdAt: "asc" } });
    expect(after.at(-2)).toMatchObject({ channel: "SMS", direction: "INBOUND", body: "STOP" });
    expect(after.at(-1)).toMatchObject({ channel: "INTERNAL_NOTE", body: expect.stringMatching(/blocked/) });
    await handleInboundSms({ MessageSid: "SMin3", From: "+15550100121", Body: "START" });
    expect((await prisma.message.findFirstOrThrow({ where: { conversationId: out.conversationId, channel: "INTERNAL_NOTE" }, orderBy: { createdAt: "desc" } })).body).toMatch(/new opt-in/);
  });

  it("never auto-attaches texts from unknown or shared numbers; an admin attaches them once, audited", async () => {
    const { tabitha, daria, theo, mira } = await setup();
    await handleInboundSms({ MessageSid: "SMu1", From: "+15550100199", Body: "Who is this?" });
    // A number shared by two clients (spouses, a business line).
    await prisma.client.update({ where: { id: mira.id }, data: { phoneNormalized: "+15550100121" } });
    await handleInboundSms({ MessageSid: "SMu2", From: "+15550100121", Body: "Is my return done?" });
    expect(await prisma.message.count({ where: { channel: "SMS" } })).toBe(0);
    const unmatched = await prisma.inboundSms.findMany({ where: { matchedClientId: null } });
    expect(unmatched).toHaveLength(2);

    const shared = unmatched.find((u) => u.providerSid === "SMu2")!;
    await expect(attachInboundToClient(daria, shared.id, theo.id)).rejects.toBeInstanceOf(ForbiddenError);
    await attachInboundToClient(tabitha, shared.id, theo.id);
    await expect(attachInboundToClient(tabitha, shared.id, mira.id)).rejects.toThrow(/already attached/);
    expect(await prisma.message.count({ where: { channel: "SMS", conversation: { clientId: theo.id } } })).toBe(1);
    expect(await prisma.message.count({ where: { conversation: { clientId: mira.id } } })).toBe(0);
    expect(await prisma.auditLog.count({ where: { action: "message.sms_matched_by_staff", actorId: tabitha.id } })).toBe(1);
  });
});

describe("portal messaging stays separate from texting", () => {
  it("works both ways, never sends a text, and other clients can't see it", async () => {
    const { tabitha, daria, theo, mira } = await setup();
    await setClientTexting(tabitha, true);
    await optIn("5550100121");
    const { token } = await invitePortalUser(tabitha, theo.id, { email: "theo@example.com", name: "Theo", role: "OWNER" });
    const theoUser = await acceptPortalInvite(token!, "Portal-Pass-123");
    // Even with text notices chosen, a portal message notice goes by email only.
    await prisma.portalUser.update({ where: { id: theoUser.id }, data: { notifyBySms: true, phone: "5550100121", phoneNormalized: "+15550100121" } });
    const { token: t2 } = await invitePortalUser(tabitha, mira.id, { email: "mira@example.com", name: "Mira", role: "OWNER" });
    const miraUser = await acceptPortalInvite(t2!, "Portal-Pass-123");

    const m = await staffSendMessage(daria, { clientId: theo.id, subject: "Q3 close", body: "Your P&L is ready.", channel: "PORTAL" });
    await portalSendMessage(theoUser, { clientId: theo.id, conversationId: m.conversationId, body: "Thank you!" });
    await text(daria, theo.id, "Reminder: sign in to see your P&L.");

    expect(sent.map((s) => s.body)).toEqual([`Reminder: sign in to see your P&L.\n\n${SMS_OPT_OUT_FOOTER}`]);
    const notices = await prisma.notification.findMany({ where: { portalUserId: theoUser.id } });
    expect(notices.map((n) => n.channel)).toEqual(["EMAIL"]);
    // The email notice only says to sign in; the message itself stays in the portal.
    const notice = notificationText("NEW_MESSAGE");
    expect(`${notice.subject} ${notice.body}`).not.toContain("P&L is ready");
    expect(notice.body).toMatch(/Sign in/);
    // Unread indicators: the client sees 1 unread from staff; staff sees the client's reply as unread / needs reply.
    const before = await portalConversations(theoUser, theo.id);
    expect(before[0]._count.messages).toBe(1);
    await markClientRead(theoUser, m.conversationId);
    expect((await portalConversations(theoUser, theo.id))[0]._count.messages).toBe(0);
    const convo = await prisma.conversation.findUniqueOrThrow({ where: { id: m.conversationId }, include: { messages: { orderBy: { createdAt: "asc" } } } });
    expect(convo).toMatchObject({ clientId: theo.id, unreadByStaff: true, awaitingStaff: true });
    // Full history, in order, with sender and channel.
    expect(convo.messages.map((x) => [x.channel, x.direction, x.body, x.staffAuthorId ?? x.portalAuthorId])).toEqual([
      ["PORTAL", "OUTBOUND", "Your P&L is ready.", daria.id],
      ["PORTAL", "INBOUND", "Thank you!", theoUser.id],
    ]);
    // The portal shows portal messages only; text threads stay in staff's Communication History.
    const convos = await portalConversations(theoUser, theo.id);
    expect(convos).toHaveLength(1);
    expect(convos[0].id).toBe(m.conversationId);
    await expect(portalConversations(miraUser, theo.id)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(portalSendMessage(miraUser, { clientId: theo.id, conversationId: m.conversationId, body: "hi" })).rejects.toBeInstanceOf(ForbiddenError);
    expect(await portalConversations(miraUser, mira.id)).toHaveLength(0);
  });
});

describe("simulated signed Twilio webhooks", () => {
  const BASE = "http://localhost:3000";
  const post = (path: string, params: Record<string, string>, token = "test-token") => {
    const url = `${BASE}${path}`;
    return new Request(url, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", "X-Twilio-Signature": twilioSignature(token, url, params) },
      body: new URLSearchParams(params),
    });
  };

  it("accepts correctly signed inbound/status calls and refuses forged ones", async () => {
    process.env.APP_URL = BASE;
    const { tabitha, daria, theo } = await setup();
    await setClientTexting(tabitha, true);
    await optIn("5550100121");
    const out = await text(daria, theo.id, "Hello from the office");

    const forged = await inboundRoute(post("/api/webhooks/twilio/inbound", { MessageSid: "SMw0", From: "+15550100121", Body: "forged" }, "wrong-token"));
    expect(forged.status).toBe(403);
    const ok = await inboundRoute(post("/api/webhooks/twilio/inbound", { MessageSid: "SMw1", From: "+15550100121", To: "+12058984777", Body: "Got it" }));
    expect(ok.status).toBe(200);
    expect(await prisma.message.count({ where: { conversationId: out.conversationId, direction: "INBOUND" } })).toBe(1);

    const st = await statusRoute(post("/api/webhooks/twilio/status", { MessageSid: out.providerId!, MessageStatus: "delivered" }));
    expect(st.status).toBeLessThan(300);
    expect((await prisma.message.findUniqueOrThrow({ where: { id: out.id } })).status).toBe("DELIVERED");
    expect(verifyTwilioRequest(`${BASE}/x`, {}, null)).toBe(false);
    delete process.env.APP_URL;
  });
});
