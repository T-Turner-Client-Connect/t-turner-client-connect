import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeUser, prisma, resetDb } from "./db";
import { hashPassword } from "@/lib/auth/password";
import { currentTotp } from "@/lib/auth/totp";
import { ForbiddenError } from "@/lib/auth/actor";
import {
  beginEnrollment,
  confirmEnrollment,
  emailCodeAvailability,
  enrollmentStatus,
  maskEmail,
  ownerRecovery,
  resetMfa,
  sendEmailCode,
  verifyAuthenticator,
  verifyEmailCode,
  verifyRecoveryCode,
} from "@/lib/services/mfa";
import { clientEmailCodesActive, setClientEmailCodes } from "@/lib/auth/client-auth";

let sent: { to: string; text: string }[] = [];
let fail = false;
const lastCode = () => sent.at(-1)!.text.match(/code is (\d{6})/)![1];

beforeEach(async () => {
  await resetDb();
  sent = [];
  fail = false;
  vi.stubEnv("RESEND_API_KEY", "re_test");
  vi.stubEnv("EMAIL_FROM_ADDRESS", "TTurner & Associates Group, LLC <codes@mail.example.com>");
  vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    if (fail) return new Response(JSON.stringify({ message: "domain not verified" }), { status: 403 });
    sent.push({ to: body.to[0], text: body.text });
    return new Response(JSON.stringify({ id: `re_${sent.length}` }), { status: 200 });
  });
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

async function enrolled(kind: "staff" | "portal") {
  const id =
    kind === "staff"
      ? (await prisma.user.create({ data: { email: "tab@example.com", name: "Tab", role: "ADMIN", passwordHash: await hashPassword("Correct-Horse-42") } })).id
      : (await prisma.portalUser.create({ data: { email: "client@example.com", name: "Client", passwordHash: await hashPassword("Client-Pass-123") } })).id;
  const subject = { kind, id } as const;
  const { secret } = await beginEnrollment(subject);
  const codes = await confirmEnrollment(subject, currentTotp(secret, Date.now() - 30_000));
  return { subject, secret, codes };
}

async function proveDelivery() {
  const admin = await makeUser("ADMIN");
  await sendEmailCode({ kind: "staff", id: admin.id }, "VERIFY_EMAIL");
  expect((await verifyEmailCode({ kind: "staff", id: admin.id }, "VERIFY_EMAIL", lastCode())).ok).toBe(true);
  await setClientEmailCodes(admin, true);
  return admin;
}

describe("authenticator and recovery codes", () => {
  it("accepts each authenticator code once and recovery codes once", async () => {
    const { subject, secret, codes } = await enrolled("staff");
    expect(codes).toHaveLength(10);
    const code = currentTotp(secret);
    expect(await verifyAuthenticator(subject, code)).toEqual({ ok: true });
    expect(await verifyAuthenticator(subject, code)).toEqual({ ok: false, reason: "replayed" });
    expect(await verifyAuthenticator(subject, "000000")).toMatchObject({ ok: false });
    expect(await verifyRecoveryCode(subject, codes[0].toLowerCase())).toEqual({ ok: true });
    expect(await verifyRecoveryCode(subject, codes[0])).toEqual({ ok: false, reason: "wrong" });
    expect((await enrollmentStatus(subject))!.recoveryCodesRemaining).toBe(9);
  });

  it("explains an unreadable authenticator secret instead of crashing; recovery codes still work", async () => {
    const { subject, codes } = await enrolled("staff");
    vi.stubEnv("APP_ENCRYPTION_KEY", "a-completely-different-key-0123456789abcdef");
    expect(await verifyAuthenticator(subject, "123456")).toEqual({ ok: false, reason: "secret_unreadable" });
    expect((await enrollmentStatus(subject))!.authenticatorReadable).toBe(false);
    expect(await verifyRecoveryCode(subject, codes[1])).toEqual({ ok: true });
  });

  it("a pending setup with an unreadable secret starts over instead of crashing", async () => {
    const u = await prisma.user.create({ data: { email: "new@example.com", name: "New", passwordHash: "x" } });
    await beginEnrollment({ kind: "staff", id: u.id });
    vi.stubEnv("APP_ENCRYPTION_KEY", "a-completely-different-key-0123456789abcdef");
    const again = await beginEnrollment({ kind: "staff", id: u.id });
    expect(again.secret).toMatch(/^[A-Z2-7]+$/);
  });
});

describe("owner recovery (staff)", () => {
  it("needs the password and the one-time Netlify code, resets only that account, and can't be reused", async () => {
    const { subject } = await enrolled("staff");
    const other = await prisma.user.create({ data: { email: "d@example.com", name: "D", passwordHash: "x", mfaEnabledAt: new Date(), mfaSecretEnc: "keep" } });
    const session = await prisma.session.create({ data: { userId: subject.id, tokenHash: "h1", expiresAt: new Date(Date.now() + 1e6) } });
    await prisma.session.create({ data: { userId: subject.id, tokenHash: "h2", expiresAt: new Date(Date.now() + 1e6) } });
    await expect(ownerRecovery(subject.id, session.id, { password: "Correct-Horse-42", recoveryCode: "x" })).rejects.toThrow(/isn't set up/);
    vi.stubEnv("STAFF_RECOVERY_CODE", "netlify-only-recovery-code-123456");
    await expect(ownerRecovery(subject.id, session.id, { password: "wrong", recoveryCode: "netlify-only-recovery-code-123456" })).rejects.toThrow(/isn't right/);
    await expect(ownerRecovery(subject.id, session.id, { password: "Correct-Horse-42", recoveryCode: "netlify-only-recovery-code-12345X" })).rejects.toThrow(/isn't right/);
    await ownerRecovery(subject.id, session.id, { password: "Correct-Horse-42", recoveryCode: "netlify-only-recovery-code-123456" });
    const u = await prisma.user.findUniqueOrThrow({ where: { id: subject.id } });
    expect(u.mfaEnabledAt).toBeNull();
    expect(await prisma.session.count({ where: { userId: subject.id } })).toBe(1); // other sessions signed out
    expect((await prisma.user.findUniqueOrThrow({ where: { id: other.id } })).mfaSecretEnc).toBe("keep");
    await expect(ownerRecovery(subject.id, session.id, { password: "Correct-Horse-42", recoveryCode: "netlify-only-recovery-code-123456" })).rejects.toThrow(/already used/);
  });
});

describe("emailed codes", () => {
  it("are never offered to staff", async () => {
    const { subject } = await enrolled("staff");
    expect((await emailCodeAvailability(subject)).available).toBe(false);
    await expect(sendEmailCode(subject, "SIGN_IN")).rejects.toThrow(/aren't available/);
  });

  it("stay off for clients until delivery is proven and an Admin turns them on", async () => {
    const { subject } = await enrolled("portal");
    expect((await emailCodeAvailability(subject)).available).toBe(false);
    await expect(sendEmailCode(subject, "SIGN_IN")).rejects.toThrow();
    const staff = await makeUser("STAFF");
    await expect(setClientEmailCodes(staff, true)).rejects.toBeInstanceOf(ForbiddenError);
    const admin = await makeUser("ADMIN");
    await expect(setClientEmailCodes(admin, true)).rejects.toThrow(/confirm email delivery/);
    // A failed test send proves nothing.
    fail = true;
    await expect(sendEmailCode({ kind: "staff", id: admin.id }, "VERIFY_EMAIL")).rejects.toThrow(/couldn't send/);
    expect(await clientEmailCodesActive()).toBe(false);
    fail = false;
    await new Promise((r) => setTimeout(r, 5));
    await prisma.mfaChallenge.deleteMany({});
    await sendEmailCode({ kind: "staff", id: admin.id }, "VERIFY_EMAIL");
    await verifyEmailCode({ kind: "staff", id: admin.id }, "VERIFY_EMAIL", lastCode());
    await setClientEmailCodes(admin, true);
    expect(await clientEmailCodesActive()).toBe(true);
    expect(await emailCodeAvailability(subject)).toMatchObject({ available: true, masked: "c••••t@example.com" });
  });

  it("are single use, expire, limit attempts and resends, and only say 'sent' when accepted", async () => {
    await proveDelivery();
    const client = await prisma.portalUser.create({ data: { email: "pat.client@example.com", name: "Pat", passwordHash: "x" } });
    const subject = { kind: "portal" as const, id: client.id };
    const { destination } = await sendEmailCode(subject, "SIGN_IN");
    expect(destination).toBe("p••••••t@example.com");
    expect(sent.at(-1)!.to).toBe("pat.client@example.com");
    await expect(sendEmailCode(subject, "SIGN_IN")).rejects.toThrow(/wait \d+ seconds/);
    const code = lastCode();
    expect(await verifyEmailCode(subject, "SIGN_IN", "000000")).toEqual({ ok: false, reason: "wrong" });
    expect(await verifyEmailCode(subject, "SIGN_IN", code)).toEqual({ ok: true });
    expect(await verifyEmailCode(subject, "SIGN_IN", code)).toEqual({ ok: false, reason: "no_code" });
    expect((await prisma.portalUser.findUniqueOrThrow({ where: { id: client.id } })).emailVerifiedAt).not.toBeNull();

    // Expiry.
    await prisma.mfaChallenge.updateMany({ data: { createdAt: new Date(Date.now() - 120_000) } });
    await sendEmailCode(subject, "SIGN_IN");
    await prisma.mfaChallenge.updateMany({ where: { consumedAt: null }, data: { expiresAt: new Date(Date.now() - 1000) } });
    expect(await verifyEmailCode(subject, "SIGN_IN", lastCode())).toEqual({ ok: false, reason: "expired" });

    // Attempt limit.
    await prisma.mfaChallenge.updateMany({ data: { createdAt: new Date(Date.now() - 120_000) } });
    await sendEmailCode(subject, "SIGN_IN");
    const good = lastCode();
    for (let i = 0; i < 4; i++) expect((await verifyEmailCode(subject, "SIGN_IN", "111111")).ok).toBe(false);
    expect(await verifyEmailCode(subject, "SIGN_IN", "111111")).toEqual({ ok: false, reason: "too_many_attempts" });
    expect(await verifyEmailCode(subject, "SIGN_IN", good)).toEqual({ ok: false, reason: "too_many_attempts" });

    // Provider refusal: no "sent", clear error, unusable challenge.
    await prisma.mfaChallenge.updateMany({ data: { createdAt: new Date(Date.now() - 120_000) } });
    fail = true;
    await expect(sendEmailCode(subject, "SIGN_IN")).rejects.toThrow(/couldn't send the email/);
    const last = await prisma.mfaChallenge.findFirstOrThrow({ orderBy: { createdAt: "desc" } });
    expect(last.sentAt).toBeNull();
    expect(last.consumedAt).not.toBeNull();

    // Hourly limit (5 sends per hour, failed attempts included).
    fail = false;
    await prisma.mfaChallenge.updateMany({ data: { createdAt: new Date(Date.now() - 120_000) } });
    await sendEmailCode(subject, "SIGN_IN");
    await prisma.mfaChallenge.updateMany({ data: { createdAt: new Date(Date.now() - 120_000) } });
    await expect(sendEmailCode(subject, "SIGN_IN")).rejects.toThrow(/Too many codes/);
  });

  it("a staff reset of a client's verification forgets remembered devices", async () => {
    const { subject } = await enrolled("portal");
    await prisma.trustedDevice.create({ data: { portalUserId: subject.id, tokenHash: "t1", label: "Safari on iPhone", expiresAt: new Date(Date.now() + 1e9) } });
    const daria = await makeUser("STAFF");
    await resetMfa(daria, subject);
    expect(await prisma.trustedDevice.count({ where: { portalUserId: subject.id, revokedAt: null } })).toBe(0);
    await expect(resetMfa(daria, { kind: "staff", id: (await makeUser("ADMIN")).id })).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("masks addresses", () => {
    expect(maskEmail("tabitha@tturnerassociates.com")).toBe("t•••••a@tturnerassociates.com");
    expect(maskEmail("ab@x.com")).toBe("a@x.com");
  });
});
