import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeUser, prisma, resetDb } from "./db";
import { fetchTwilioMessage } from "@/lib/twilio";
import { testResults } from "@/lib/services/staff-alerts";
import { handleStatusCallback } from "@/lib/services/inbound-sms";

// Fictional numbers and IDs only. Twilio is simulated; nothing is ever sent.
const SID = "SM" + "a".repeat(32);
const calls: { method: string; url: string }[] = [];

beforeEach(async () => {
  await resetDb();
  calls.length = 0;
  process.env.TWILIO_ACCOUNT_SID = "ACtest";
  process.env.TWILIO_AUTH_TOKEN = "test-token";
  process.env.TWILIO_MESSAGING_SERVICE_SID = "MGtest";
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ method: init.method ?? "GET", url: String(url) });
    if (String(url).endsWith(`/Messages/${SID}.json`)) {
      return new Response(JSON.stringify({
        sid: SID, to: "+15550100150", from: "+15550100199", messaging_service_sid: "MGtest", status: "delivered",
        error_code: null, error_message: null, date_created: "Tue, 03 Nov 2026 03:38:43 +0000", date_sent: "Tue, 03 Nov 2026 03:38:44 +0000", date_updated: "Tue, 03 Nov 2026 03:38:46 +0000", num_segments: "1", direction: "outbound-api",
      }), { status: 200 });
    }
    return new Response("{}", { status: 404 });
  }));
});
afterEach(() => {
  vi.unstubAllGlobals();
  for (const k of ["TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN", "TWILIO_MESSAGING_SERVICE_SID"]) delete process.env[k];
});

describe("controlled test diagnostics", () => {
  it("reads Twilio's own record (GET only) and shows destination, sender, status, error code and times", async () => {
    const r = await fetchTwilioMessage(SID);
    expect(r).toMatchObject({ ok: true, record: { to: "+15550100150", from: "+15550100199", messagingServiceSid: "MGtest", status: "delivered", errorCode: null, numSegments: "1" } });
    expect(calls.every((c) => c.method === "GET")).toBe(true);
    // Anything that isn't a Twilio message ID is never looked up.
    expect(await fetchTwilioMessage("../Calls")).toEqual({ ok: false, detail: "Not a Twilio message ID" });
    expect(calls).toHaveLength(1);

    const admin = await makeUser("ADMIN");
    await prisma.staffAlert.create({ data: { reason: "TEST", to: "+15550100150", body: "test", conversationIds: [], notBefore: new Date(), sentAt: new Date(), status: "SENT", providerSid: SID, deliveryStatus: "delivered", createdById: admin.id } });
    const t = await testResults();
    expect(t.tests[0]).toMatchObject({ to: "+15550100150", providerSid: SID });
    const rec = t.twilio[t.tests[0].id];
    expect(rec.ok && rec.record.status).toBe("delivered");
    expect(calls.every((c) => c.method === "GET")).toBe(true);
  });

  it("a late or out-of-order callback never replaces a final status", async () => {
    const admin = await makeUser("ADMIN");
    const a = await prisma.staffAlert.create({ data: { reason: "TEST", to: "+15550100150", body: "test", conversationIds: [], notBefore: new Date(), status: "SENT", providerSid: SID, createdById: admin.id } });
    await handleStatusCallback({ MessageSid: SID, MessageStatus: "queued" });
    expect((await prisma.staffAlert.findUniqueOrThrow({ where: { id: a.id } })).deliveryStatus).toBe("queued");
    await handleStatusCallback({ MessageSid: SID, MessageStatus: "delivered" });
    await handleStatusCallback({ MessageSid: SID, MessageStatus: "sent" }); // arrives late
    expect((await prisma.staffAlert.findUniqueOrThrow({ where: { id: a.id } })).deliveryStatus).toBe("delivered");
    // A final failure report still lands on a non-final status.
    const b = await prisma.staffAlert.create({ data: { reason: "TEST", to: "+15550100150", body: "test", conversationIds: [], notBefore: new Date(), status: "SENT", providerSid: "SM" + "b".repeat(32), createdById: admin.id } });
    await handleStatusCallback({ MessageSid: "SM" + "b".repeat(32), MessageStatus: "sent" });
    await handleStatusCallback({ MessageSid: "SM" + "b".repeat(32), MessageStatus: "undelivered", ErrorCode: "30007" });
    expect(await prisma.staffAlert.findUniqueOrThrow({ where: { id: b.id } })).toMatchObject({ deliveryStatus: "undelivered", status: "FAILED", statusDetail: "Twilio undelivered (error 30007)" });
  });
});
