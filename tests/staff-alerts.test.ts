import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeUser, prisma, resetDb } from "./db";
import { ForbiddenError } from "@/lib/auth/actor";
import { createClient } from "@/lib/services/clients";
import { acceptPortalInvite, invitePortalUser } from "@/lib/services/portal-accounts";
import { portalSendMessage } from "@/lib/services/messaging";
import { handleInboundSms, handleStatusCallback } from "@/lib/services/inbound-sms";
import { dispatchStaffAlerts, inWindow, nextWindowStart, sendTestText, STAFF_ALERT_TEXT, testResults, updateStaffAlertSettings } from "@/lib/services/staff-alerts";
import { dispatchPendingNotifications, notificationText, queuePortalNotification } from "@/lib/services/notifications";
import { chicagoLocalToUtc, utcToChicagoLocal } from "@/lib/tz";

let texts: { to: string; body: string }[] = [];
const at = (local: string) => chicagoLocalToUtc(local)!;

beforeEach(async () => {
  await resetDb();
  texts = [];
  vi.stubEnv("TWILIO_ACCOUNT_SID", "AC_test");
  vi.stubEnv("TWILIO_AUTH_TOKEN", "test-token");
  vi.stubEnv("TWILIO_MESSAGING_SERVICE_SID", "MG_test");
  vi.stubEnv("APP_URL", "https://portal.example.com");
  vi.stubGlobal("fetch", async (_u: string, init: RequestInit) => {
    const p = new URLSearchParams(String(init.body));
    texts.push({ to: p.get("To")!, body: p.get("Body")! });
    return new Response(JSON.stringify({ sid: `SM${texts.length}` }), { status: 201 });
  });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

async function clientWithPortal() {
  const tab = await makeUser("ADMIN");
  const c = await createClient(tab, { firstName: "Cara", lastName: "Client", clientType: "INDIVIDUAL", status: "ACTIVE" });
  const { token } = await invitePortalUser(tab, c.id, { email: "cara@example.com", name: "Cara", role: "OWNER" });
  const u = await acceptPortalInvite(token!, "Cara-Portal-Pass-1");
  return { tab, client: c, user: { id: u.id, name: u.name, email: u.email } };
}

describe("alert window (America/Chicago, Mon–Fri 8–5)", () => {
  it("handles weekdays, weekends and daylight saving", () => {
    expect(inWindow(at("2026-11-02T08:00"), "08:00", "17:00")).toBe(true); // Monday 8:00 CST
    expect(inWindow(at("2026-11-02T17:00"), "08:00", "17:00")).toBe(false);
    expect(inWindow(at("2026-10-30T16:59"), "08:00", "17:00")).toBe(true); // Friday CDT
    expect(inWindow(at("2026-10-31T10:00"), "08:00", "17:00")).toBe(false); // Saturday
    // Friday evening → Monday 8:00 across the Nov 1 DST change.
    expect(utcToChicagoLocal(nextWindowStart(at("2026-10-30T18:00"), "08:00", "17:00"))).toBe("2026-11-02T08:00");
    expect(nextWindowStart(at("2026-11-02T08:00"), "08:00", "17:00").toISOString()).toBe("2026-11-02T14:00:00.000Z"); // CST −6
    expect(utcToChicagoLocal(nextWindowStart(at("2026-11-03T06:30"), "08:00", "17:00"))).toBe("2026-11-03T08:00");
  });
});

describe("staff text alerts", () => {
  it("stay off until an Admin turns them on", async () => {
    const { user, client } = await clientWithPortal();
    await portalSendMessage(user, { clientId: client.id, body: "Hello" });
    expect(await prisma.staffAlert.count()).toBe(0);
    const daria = await makeUser("STAFF");
    await expect(updateStaffAlertSettings(daria, { smsEnabled: true, phone: "205-659-5448", windowStart: "08:00", windowEnd: "17:00" })).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("queue after hours, combine, send once in the window with no message contents, and skip read conversations", async () => {
    const { tab, user, client } = await clientWithPortal();
    await updateStaffAlertSettings(tab, { smsEnabled: true, phone: "205-659-5448", windowStart: "08:00", windowEnd: "17:00" });
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(at("2026-10-30T19:00")); // Friday evening
    await portalSendMessage(user, { clientId: client.id, body: "My SSN question is private" });
    await portalSendMessage(user, { clientId: client.id, subject: "Second", body: "Another one" });
    expect(texts).toHaveLength(0);
    const pending = await prisma.staffAlert.findMany({ where: { status: "PENDING" } });
    expect(pending).toHaveLength(1);
    expect(pending[0].conversationIds).toHaveLength(2);
    expect(utcToChicagoLocal(pending[0].notBefore)).toBe("2026-11-02T08:00");
    expect(await dispatchStaffAlerts(at("2026-10-31T10:00"))).toBe(0); // Saturday
    expect(await dispatchStaffAlerts(at("2026-11-02T08:05"))).toBe(1);
    expect(await dispatchStaffAlerts(at("2026-11-02T08:15"))).toBe(0); // never twice
    expect(texts).toEqual([{ to: "+12056595448", body: STAFF_ALERT_TEXT }]);
    expect(texts[0].body).not.toMatch(/SSN|private|Cara/);

    // Read before the next window → skipped.
    vi.setSystemTime(at("2026-11-02T18:00"));
    const m = await portalSendMessage(user, { clientId: client.id, body: "After hours" });
    await prisma.conversation.update({ where: { id: m.conversationId }, data: { unreadByStaff: false } });
    expect(await dispatchStaffAlerts(at("2026-11-03T08:00"))).toBe(0);
    expect((await prisma.staffAlert.findFirstOrThrow({ where: { status: "SKIPPED" } })).statusDetail).toMatch(/Already read/);
    expect(texts).toHaveLength(1);
  });

  it("records Twilio's delivery status for alerts and the controlled test, and shows office replies", async () => {
    const { tab } = await clientWithPortal();
    const daria = await makeUser("STAFF");
    await expect(sendTestText(daria)).rejects.toBeInstanceOf(ForbiddenError);
    await sendTestText(tab);
    expect(texts[0]).toMatchObject({ to: "+12056595448" });
    expect(texts[0].body).toMatch(/Reply YES/);
    let r = await testResults();
    expect(r.tests[0]).toMatchObject({ status: "SENT", deliveryStatus: "accepted", providerSid: "SM1" });
    await handleStatusCallback({ MessageSid: "SM1", MessageStatus: "delivered" });
    await handleInboundSms({ MessageSid: "SMin1", From: "+12056595448", To: "+12058984777", Body: "YES" });
    r = await testResults();
    expect(r.tests[0].deliveryStatus).toBe("delivered");
    expect(r.replies.map((x) => x.body)).toEqual(["YES"]);
    await sendTestText(tab);
    await sendTestText(tab);
    await expect(sendTestText(tab)).rejects.toThrow(/Three test texts/);
  });

  it("refuses the test without Twilio settings", async () => {
    vi.stubEnv("TWILIO_AUTH_TOKEN", "");
    const tab = await makeUser("ADMIN");
    await expect(sendTestText(tab)).rejects.toThrow(/isn't connected/);
  });
});

describe("client reply texts", () => {
  it("use the approved wording with a sign-in link, need service consent, and wait for quiet hours", async () => {
    vi.stubEnv("NOTIFICATIONS_ENABLED", "true");
    expect(notificationText("NEW_MESSAGE").sms).toBe("TTurner & Associates: Your team has replied to your portal message. Sign in to view it: https://portal.example.com/client Reply STOP to unsubscribe.");
    const { user } = await clientWithPortal();
    await prisma.portalUser.update({ where: { id: user.id }, data: { notifyByEmail: false, notifyBySms: true, phone: "205-555-0199", phoneNormalized: "+12055550199" } });
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(at("2026-11-03T21:30"));
    await queuePortalNotification(user.id, "NEW_MESSAGE", "msg:1");
    let n = await prisma.notification.findFirstOrThrow();
    // No consent yet → skipped (checked before quiet hours only when inside the window).
    expect(n.status).toBe("PENDING");
    expect(n.statusDetail).toMatch(/quiet hours/);
    vi.setSystemTime(at("2026-11-04T08:10"));
    await dispatchPendingNotifications();
    n = await prisma.notification.findFirstOrThrow();
    expect(n.status).toBe("SKIPPED"); // no service-text consent on file
    expect(texts).toHaveLength(0);

    await prisma.smsConsentEvent.create({ data: { phoneNormalized: "+12055550199", category: "SERVICE", status: "GRANTED", source: "TEST" } });
    await queuePortalNotification(user.id, "NEW_MESSAGE", "msg:2");
    expect(texts.at(-1)!.to).toBe("+12055550199");
    // STOP from the client blocks later texts.
    await handleInboundSms({ MessageSid: "SMstop", From: "+12055550199", Body: "STOP", OptOutType: "STOP" });
    await queuePortalNotification(user.id, "NEW_MESSAGE", "msg:3");
    expect(texts).toHaveLength(1);
    expect((await prisma.notification.findFirstOrThrow({ where: { idempotencyKey: { startsWith: "msg:3" } } })).status).toBe("SKIPPED");
  });
});
