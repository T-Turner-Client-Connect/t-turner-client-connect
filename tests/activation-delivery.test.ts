import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeUser, prisma, resetDb } from "./db";
import { ForbiddenError } from "@/lib/auth/actor";
import { createClient, saveContact } from "@/lib/services/clients";
import { adminSendActivation, applyActivationEmailEvent, requestActivation, resetActivationLimit, senderWarning, staffSendActivation } from "@/lib/services/client-signup";

const sent: { to: string[] }[] = [];
beforeEach(async () => {
  await resetDb();
  sent.length = 0;
  vi.stubEnv("RESEND_API_KEY", "re_test");
  vi.stubEnv("EMAIL_FROM_ADDRESS", "TTurner & Associates <hello@mail.fictional.example>");
  vi.stubEnv("APP_URL", "https://portal.fictional.example");
  vi.stubGlobal("fetch", async (_u: string, init: RequestInit) => {
    sent.push(JSON.parse(String(init.body)));
    return new Response(JSON.stringify({ id: `re_${sent.length}` }), { status: 200 });
  });
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("client activation email delivery (local Resend stub — not live delivery)", () => {
  it("never sends a client's link to a staff address; Admin can resend to an address on file; delivery is tracked", async () => {
    const tabitha = await makeUser("ADMIN", "Tabitha");
    const daria = await makeUser("STAFF", "Daria");
    // The client record mistakenly carries the owner's own address.
    const c = await createClient(tabitha, { firstName: "Fictional", lastName: "Client", email: tabitha.email, clientType: "INDIVIDUAL", status: "ACTIVE" });
    const req = await prisma.activationRequest.create({ data: { emailNormalized: "someone@fictional.example", status: "NEEDS_STAFF", matchedClientIds: [] } });
    await expect(staffSendActivation(tabitha, req.id, c.id)).rejects.toThrow(/staff account/);
    await expect(adminSendActivation(tabitha, c.id, tabitha.email)).rejects.toThrow(/staff account/);
    expect(sent.length).toBe(0);

    // The client's own address (on a contact) works; only Admins can do this.
    await saveContact(tabitha, c.id, null, { name: "Fictional Client", email: "client@fictional.example" });
    await expect(adminSendActivation(daria, c.id, "client@fictional.example")).rejects.toBeInstanceOf(ForbiddenError);
    await expect(adminSendActivation(tabitha, c.id, "stranger@fictional.example")).rejects.toThrow(/on this client's record/);
    await adminSendActivation(tabitha, c.id, "client@fictional.example");
    expect(sent.map((m) => m.to[0])).toEqual(["client@fictional.example"]);
    const inv = await prisma.portalInvite.findFirstOrThrow({ where: { clientId: c.id, sentByEmail: true } });
    expect([inv.emailTo, inv.emailStatus, inv.emailProviderId]).toEqual(["client@fictional.example", "SENT", "re_1"]);
    await expect(adminSendActivation(tabitha, c.id, "client@fictional.example")).rejects.toThrow(/two minutes/);
    await applyActivationEmailEvent("email.delivered", "re_1");
    expect((await prisma.portalInvite.findUniqueOrThrow({ where: { id: inv.id } })).emailStatus).toBe("DELIVERED");
  });

  it("the one-hour limit can be cleared for one address only", async () => {
    const tabitha = await makeUser("ADMIN", "Tabitha");
    for (let i = 0; i < 3; i++) await requestActivation({ email: "client@fictional.example", name: "", phone: "", ip: null });
    await expect(requestActivation({ email: "client@fictional.example", name: "", phone: "", ip: null })).rejects.toThrow(/Too many attempts/);
    for (let i = 0; i < 3; i++) await requestActivation({ email: "other@fictional.example", name: "", phone: "", ip: null });
    expect(await resetActivationLimit(tabitha, "client@fictional.example")).toBe(3);
    await requestActivation({ email: "client@fictional.example", name: "", phone: "", ip: null });
    await expect(requestActivation({ email: "other@fictional.example", name: "", phone: "", ip: null })).rejects.toThrow(/Too many attempts/);
  });

  it("warns when the sender is Resend's testing address", () => {
    vi.stubEnv("EMAIL_FROM_ADDRESS", "Acme <onboarding@resend.dev>");
    expect(senderWarning()).toMatch(/only to the Resend account owner/);
  });
});
