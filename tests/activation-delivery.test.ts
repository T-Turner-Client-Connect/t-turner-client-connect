import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeUser, prisma, resetDb } from "./db";
import { ForbiddenError } from "@/lib/auth/actor";
import { createClient } from "@/lib/services/clients";
import { acceptPortalInvite } from "@/lib/services/portal-accounts";
import { requireClientAccess } from "@/lib/portal/access";
import { portalDocuments, staffUploadDocument } from "@/lib/services/documents";
import { adminPrivateActivationLink, adminSendActivation, applyActivationEmailEvent, requestActivation, resetActivationLimit, senderWarning, staffSendActivation } from "@/lib/services/client-signup";
import { sendEmail } from "@/lib/email";

const sent: { to: string[]; text: string }[] = [];
beforeEach(async () => {
  await resetDb();
  sent.length = 0;
  vi.stubEnv("RESEND_API_KEY", "re_test");
  vi.stubEnv("EMAIL_FROM_ADDRESS", "TTurner & Associates <hello@mail.fictional.example>");
  vi.stubEnv("APP_URL", "https://portal.fictional.example");
  vi.stubEnv("MALWARE_SCAN_URL", "https://scanner.test/scan");
  vi.stubGlobal("fetch", async (u: string, init: RequestInit) => {
    if (String(u).includes("scanner.test")) return new Response(JSON.stringify({ clean: true }), { status: 200 });
    sent.push(JSON.parse(String(init.body)));
    return new Response(JSON.stringify({ id: `re_${sent.length}` }), { status: 200 });
  });
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("client activation (local Resend stub — not live delivery)", () => {
  it("dual role: a staff member who is also a client activates her own portal without changing her staff role or seeing other clients", async () => {
    const tabitha = await makeUser("ADMIN", "Tabitha");
    const employee = await prisma.user.update({ where: { id: (await makeUser("STAFF", "Fictional Employee")).id }, data: { email: "employee@fictional.example" } });
    const own = await createClient(tabitha, { firstName: "Fictional", lastName: "Employee", email: employee.email, clientType: "INDIVIDUAL", status: "ACTIVE" });
    const other = await createClient(tabitha, { businessName: "Other Client LLC", email: "other@client.example", clientType: "BUSINESS", status: "ACTIVE" });
    await staffUploadDocument(tabitha, { clientId: other.id, category: "TAXES", visibility: "PUBLISHED", year: 2025, bytes: new TextEncoder().encode("%PDF-1.4\n% other client\n"), originalName: "other.pdf" });

    // Sending to an address that's also a staff login needs an explicit dual-role confirmation — not a ban.
    await expect(adminSendActivation(tabitha, own.id, employee.email)).rejects.toThrow(/both staff and this client/);
    await expect(adminSendActivation(employee, own.id, employee.email, { confirmDualRole: true })).rejects.toBeInstanceOf(ForbiddenError);
    await adminSendActivation(tabitha, own.id, employee.email, { confirmDualRole: true });
    expect(sent.map((m) => m.to[0])).toEqual([employee.email]);
    const inv = await prisma.portalInvite.findFirstOrThrow({ where: { clientId: own.id, sentByEmail: true } });
    expect([inv.emailTo, inv.emailStatus, inv.emailProviderId]).toEqual([employee.email, "SENT", "re_1"]);
    await applyActivationEmailEvent("email.delivered", "re_1");
    expect((await prisma.portalInvite.findUniqueOrThrow({ where: { id: inv.id } })).emailStatus).toBe("DELIVERED");

    // She activates with the emailed link; the token comes from the link in the email body.
    const token = /\/client\/invite\/([A-Za-z0-9_-]+)/.exec(sent[0].text)![1];
    const portalUser = await acceptPortalInvite(token, "Own-Portal-Pass-2026");
    const staffAfter = await prisma.user.findUniqueOrThrow({ where: { id: employee.id } });
    expect([staffAfter.role, staffAfter.active]).toEqual(["STAFF", true]); // staff role unchanged, no Admin
    await requireClientAccess(portalUser.id, own.id); // her own account
    await expect(requireClientAccess(portalUser.id, other.id)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(portalDocuments({ id: portalUser.id, name: "x", email: employee.email }, other.id)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("the queue's Send only goes to the requester's address when it's on the chosen client's record", async () => {
    const tabitha = await makeUser("ADMIN", "Tabitha");
    const right = await createClient(tabitha, { firstName: "Right", lastName: "Client", email: "right@client.example", clientType: "INDIVIDUAL", status: "ACTIVE" });
    const wrong = await createClient(tabitha, { firstName: "Wrong", lastName: "Client", email: "owner@fictional.example", clientType: "INDIVIDUAL", status: "ACTIVE" });
    const req = await prisma.activationRequest.create({ data: { emailNormalized: "right@client.example", status: "NEEDS_STAFF", matchedClientIds: [] } });
    await expect(staffSendActivation(tabitha, req.id, wrong.id)).rejects.toThrow(/isn't on Wrong Client's record/);
    expect(sent.length).toBe(0);
    await staffSendActivation(tabitha, req.id, right.id);
    expect(sent.map((m) => m.to[0])).toEqual(["right@client.example"]);
  });

  it("private activation link: Admin only, after identity verification, single use, 24-hour expiry, logged", async () => {
    const tabitha = await makeUser("ADMIN", "Tabitha");
    const daria = await makeUser("STAFF", "Daria");
    const c = await createClient(tabitha, { firstName: "Fictional", lastName: "Client", email: "client@fictional.example", clientType: "INDIVIDUAL", status: "ACTIVE" });
    await expect(adminPrivateActivationLink(daria, c.id, "client@fictional.example", { verified: true, how: "In person with photo ID" })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(adminPrivateActivationLink(tabitha, c.id, "client@fictional.example", { verified: false, how: "" })).rejects.toThrow(/verified this person's identity/);
    const r = await adminPrivateActivationLink(tabitha, c.id, "client@fictional.example", { verified: true, how: "In person with photo ID" });
    expect(sent.length).toBe(0); // nothing emailed
    const inv = await prisma.portalInvite.findFirstOrThrow({ where: { clientId: c.id, acceptedAt: null, revokedAt: null } });
    expect(inv.expiresAt.getTime() - Date.now()).toBeLessThanOrEqual(24 * 3600_000);
    expect(await prisma.auditLog.count({ where: { action: "portal.private_activation_link_created" } })).toBe(1);
    const token = r.link!.split("/").pop()!;
    await acceptPortalInvite(token, "Client-Pass-12345");
    await expect(acceptPortalInvite(token, "Client-Pass-12345")).rejects.toThrow();
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

  it("Resend's testing sender gives a clear error instead of implying delivery", async () => {
    vi.stubEnv("EMAIL_FROM_ADDRESS", "Acme <onboarding@resend.dev>");
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ message: "You can only send testing emails to your own email address" }), { status: 403 }));
    expect(senderWarning()).toMatch(/rejects them for anyone else/);
    const r = await sendEmail({ to: "client@fictional.example", subject: "x", text: "x" });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.detail).toMatch(/testing sender .* can only send to the Resend account's own address/);
  });
});
