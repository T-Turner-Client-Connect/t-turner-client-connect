import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeUser, prisma, resetDb } from "./db";
import { ForbiddenError } from "@/lib/auth/actor";
import { createClient } from "@/lib/services/clients";
import { acceptPortalInvite, invitePortalUser, resetPortalPassword } from "@/lib/services/portal-accounts";
import { requireClientAccess } from "@/lib/portal/access";
import {
  accountAccessView, privateRecoveryLink, resendVerificationCode, resetAttemptLimit, resetClientTwoStep, revokeSessions, sendPasswordResetEmail,
} from "@/lib/services/account-recovery";

const mail: { to: string[]; text: string }[] = [];
beforeEach(async () => {
  await resetDb();
  mail.length = 0;
  vi.stubEnv("RESEND_API_KEY", "re_test");
  vi.stubEnv("EMAIL_FROM_ADDRESS", "TTurner & Associates <hello@mail.fictional.example>");
  vi.stubEnv("APP_URL", "https://portal.fictional.example");
  vi.stubGlobal("fetch", async (_u: string, init: RequestInit) => {
    mail.push(JSON.parse(String(init.body)));
    return new Response(JSON.stringify({ id: `re_${mail.length}` }), { status: 200 });
  });
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

async function setup() {
  const tabitha = await makeUser("ADMIN", "Tabitha");
  const daria = await makeUser("STAFF", "Daria");
  // Dual role: an employee who is also a client, same email on both.
  const employee = await prisma.user.update({ where: { id: (await makeUser("STAFF", "Fictional Employee")).id }, data: { email: "employee@fictional.example" } });
  const own = await createClient(tabitha, { firstName: "Fictional", lastName: "Employee", email: employee.email, phone: "205-555-0199", clientType: "INDIVIDUAL", status: "ACTIVE" });
  const other = await createClient(tabitha, { businessName: "Other LLC", clientType: "BUSINESS", status: "ACTIVE" });
  const { token } = await invitePortalUser(tabitha, own.id, { email: employee.email, name: "Fictional Employee", role: "OWNER" });
  const login = await acceptPortalInvite(token!, "Original-Pass-2026");
  await prisma.portalUser.update({ where: { id: login.id }, data: { phone: "205-555-0199" } });
  return { tabitha, daria, employee, own, other, login };
}

describe("Account Access & Recovery (local Resend stub — not live delivery)", () => {
  it("is Admin-only, shows status without secrets, and recovery never touches the person's staff account", async () => {
    const { tabitha, daria, employee, own, other, login } = await setup();
    await expect(accountAccessView(daria, own.id)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(sendPasswordResetEmail(daria, own.id, login.id)).rejects.toBeInstanceOf(ForbiddenError);
    const v = await accountAccessView(tabitha, own.id);
    expect(v.logins[0]).toMatchObject({ email: employee.email, phone: "(•••) •••-0199", alsoStaff: true, status: "AWAITING_VERIFICATION" });
    expect(JSON.stringify(v)).not.toMatch(/passwordHash|mfaSecret|Original-Pass/);
    // A login can't be acted on through a client it has no access to.
    await expect(sendPasswordResetEmail(tabitha, other.id, login.id)).rejects.toThrow(/doesn't have access/);

    // Password recovery by email: link to her own address; she sets a new password; it works once; staff account untouched.
    await sendPasswordResetEmail(tabitha, own.id, login.id);
    expect(mail.map((m) => m.to[0])).toEqual([employee.email]);
    const token = /reset-password\/([A-Za-z0-9_-]+)/.exec(mail[0].text)![1];
    await resetPortalPassword(token, "New-Client-Pass-2026");
    await expect(resetPortalPassword(token, "Another-Pass-2026x")).rejects.toThrow(/invalid or has expired|already been used/);
    const staffAfter = await prisma.user.findUniqueOrThrow({ where: { id: employee.id } });
    expect([staffAfter.role, staffAfter.passwordHash]).toEqual(["STAFF", employee.passwordHash]);
    await expect(requireClientAccess(login.id, other.id)).rejects.toBeInstanceOf(ForbiddenError);
    expect(await prisma.auditLog.count({ where: { action: "portal.recovery.password_reset_emailed", actorId: tabitha.id, clientId: own.id } })).toBe(1);
  });

  it("lockout recovery clears only this client's address and needs identity verification", async () => {
    const { tabitha, own, login } = await setup();
    for (let i = 0; i < 5; i++) await prisma.loginAttempt.create({ data: { email: `portal:${login.email}`, success: false } });
    for (let i = 0; i < 5; i++) await prisma.loginAttempt.create({ data: { email: "portal:someone-else@fictional.example", success: false } });
    expect((await accountAccessView(tabitha, own.id)).logins[0].status).toBe("LOCKED");
    await expect(resetAttemptLimit(tabitha, own.id, login.email, { verified: false, note: "" })).rejects.toThrow(/verified this person's identity/);
    await expect(resetAttemptLimit(tabitha, own.id, "someone-else@fictional.example", { verified: true, note: "In person with photo ID" })).rejects.toThrow(/isn't on this client's record/);
    await resetAttemptLimit(tabitha, own.id, login.email, { verified: true, note: "In person with photo ID" });
    expect((await accountAccessView(tabitha, own.id)).logins[0].status).toBe("AWAITING_VERIFICATION");
    expect(await prisma.loginAttempt.count({ where: { email: "portal:someone-else@fictional.example" } })).toBe(5); // never global
  });

  it("two-step reset, sessions, verification code and the private recovery link (single use, expires)", async () => {
    const { tabitha, own, login } = await setup();
    await prisma.portalUser.update({ where: { id: login.id }, data: { mfaEnabledAt: new Date(), mfaSecretEnc: "x" } });
    await prisma.portalSession.create({ data: { portalUserId: login.id, tokenHash: "h1", expiresAt: new Date(Date.now() + 3600_000) } });
    await expect(resetClientTwoStep(tabitha, own.id, login.id, { verified: true, note: "" })).rejects.toThrow(/verified/);
    await resetClientTwoStep(tabitha, own.id, login.id, { verified: true, note: "Called the number on file" });
    const u = await prisma.portalUser.findUniqueOrThrow({ where: { id: login.id } });
    expect([u.mfaEnabledAt, u.mfaSecretEnc, await prisma.portalSession.count({ where: { portalUserId: login.id } })]).toEqual([null, null, 0]);
    expect(await revokeSessions(tabitha, own.id, login.id)).toMatch(/Signed out 0 sessions/);
    // Verification code goes to the client only; the Admin sees a masked address.
    vi.stubEnv("RESEND_API_KEY", "re_test");
    const msg = await resendVerificationCode(tabitha, own.id, login.id).catch((e) => String(e.message));
    expect(msg).not.toMatch(/\b\d{6}\b/);
    // Private link: needs verification; single use; expired links are refused.
    await expect(privateRecoveryLink(tabitha, own.id, login.id, { verified: false, note: "x" })).rejects.toThrow(/verified/);
    const r = await privateRecoveryLink(tabitha, own.id, login.id, { verified: true, note: "In person with photo ID" });
    const token = r.link.split("/").pop()!;
    await prisma.portalResetToken.updateMany({ where: { portalUserId: login.id, usedAt: null }, data: { expiresAt: new Date(Date.now() - 1000) } });
    await expect(resetPortalPassword(token, "Expired-Link-Pass-1")).rejects.toThrow(/expired/);
    const r2 = await privateRecoveryLink(tabitha, own.id, login.id, { verified: true, note: "In person with photo ID" });
    await resetPortalPassword(r2.link.split("/").pop()!, "Fresh-Client-Pass-2026");
    expect(mail.every((m) => !m.text.includes(token))).toBe(true); // private links are never emailed
  });
});
