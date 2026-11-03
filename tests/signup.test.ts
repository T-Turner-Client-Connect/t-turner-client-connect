import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeUser, prisma, resetDb } from "./db";
import { ForbiddenError } from "@/lib/auth/actor";
import { requireClientAccess } from "@/lib/portal/access";
import { createClient } from "@/lib/services/clients";
import { acceptPortalInvite } from "@/lib/services/portal-accounts";
import {
  activationWaitingReason,
  completeSignup,
  linkToExistingClient,
  requestActivation,
  resendSignupCode,
  saveOnboardingDetails,
  selfServiceAvailable,
  startSignup,
  submitOnboarding,
  uploadOnboardingFile,
  type OnboardingDetails,
} from "@/lib/services/client-signup";

let sent: { to: string; subject: string; text: string }[] = [];
const codeIn = (to: string) => sent.filter((m) => m.to === to).at(-1)!.text.match(/is (\d{6})/)![1];
const PDF = new TextEncoder().encode("%PDF-1.4\n% fictional\n");

beforeEach(async () => {
  await resetDb();
  sent = [];
  vi.stubEnv("RESEND_API_KEY", "re_test");
  vi.stubEnv("EMAIL_FROM_ADDRESS", "TTurner & Associates <portal@mail.example.com>");
  vi.stubEnv("APP_URL", "https://portal.example.com");
  vi.stubGlobal("fetch", async (_u: string, init: RequestInit) => {
    const b = JSON.parse(String(init.body));
    sent.push({ to: b.to[0], subject: b.subject, text: b.text });
    return new Response(JSON.stringify({ id: `re_${sent.length}` }), { status: 200 });
  });
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

async function deliveryProven() {
  await prisma.authSettings.upsert({ where: { id: "default" }, create: { id: "default", emailDeliveryVerifiedAt: new Date() }, update: { emailDeliveryVerifiedAt: new Date() } });
}
const signup = (email: string, ip = "203.0.113.9") => startSignup({ name: "Nina New", email, password: "Nina-Strong-Pass-1", confirm: "Nina-Strong-Pass-1", ip });
const details = (over: Partial<OnboardingDetails> = {}): OnboardingDetails => ({
  clientType: "INDIVIDUAL",
  firstName: "Nina",
  lastName: "New",
  businessName: "",
  phone: "(205) 555-0142",
  addressLine1: "1 Fictional Way",
  city: "Birmingham",
  state: "AL",
  postalCode: "35203",
  services: ["Individual tax preparation"],
  notes: "",
  smsService: true,
  smsMarketing: false,
  emailMarketing: false,
  ...over,
});

describe("Create Client Account", () => {
  it("stays closed until an Admin has proven real email delivery", async () => {
    expect(await selfServiceAvailable()).toBe(false);
    await expect(signup("nina@example.com")).rejects.toThrow(/isn't open yet/);
    expect(sent).toHaveLength(0);
    await deliveryProven();
    expect(await selfServiceAvailable()).toBe(true);
  });

  it("verifies the email with a code bound to this browser, then creates a login with no client access", async () => {
    await deliveryProven();
    const { token, masked } = await signup("Nina@Example.com");
    expect(masked).toBe("n••a@example.com");
    expect(sent[0].to).toBe("nina@example.com");
    await expect(completeSignup("someone-elses-browser", codeIn("nina@example.com"))).rejects.toThrow(/session ended/);
    await expect(completeSignup(token, "000000")).rejects.toThrow(/didn't work/);
    await expect(resendSignupCode(token)).rejects.toThrow(/wait \d+ seconds/);
    const user = await completeSignup(token, codeIn("nina@example.com"));
    expect(user.emailVerifiedAt).not.toBeNull();
    expect(user.origin).toBe("SELF_SIGNUP");
    expect(await prisma.portalAccess.count({ where: { portalUserId: user.id } })).toBe(0);
    expect(await prisma.user.count()).toBe(0); // never a staff account
    await expect(completeSignup(token, codeIn("nina@example.com"))).rejects.toThrow(/session ended/);
  });

  it("gives the same answer for an existing account, emails a sign-in reminder, and the code never works", async () => {
    await deliveryProven();
    await prisma.portalUser.create({ data: { email: "existing@example.com", name: "Ex", passwordHash: "x" } });
    const { token, masked } = await signup("existing@example.com");
    expect(masked).toBe("e••••••g@example.com");
    expect(sent[0].subject).toMatch(/Your TTurner Client Connect account/);
    expect(sent[0].text).not.toMatch(/\d{6}/);
    await expect(completeSignup(token, "123456")).rejects.toThrow(/didn't work/);
    expect(await prisma.portalUser.count()).toBe(1);
  });

  it("rate-limits repeated sign-ups and code guesses, and codes expire", async () => {
    await deliveryProven();
    for (let i = 0; i < 3; i++) await signup("limit@example.com", `198.51.100.${i}`);
    await expect(signup("limit@example.com", "198.51.100.99")).rejects.toThrow(/Too many attempts/);
    const { token } = await signup("guess@example.com");
    for (let i = 0; i < 5; i++) await expect(completeSignup(token, "000000")).rejects.toThrow();
    await expect(completeSignup(token, codeIn("guess@example.com"))).rejects.toThrow(/Too many wrong codes/);
    const t2 = (await signup("late@example.com")).token;
    await prisma.portalSignup.updateMany({ where: { emailNormalized: "late@example.com" }, data: { codeExpiresAt: new Date(Date.now() - 1000) } });
    await expect(completeSignup(t2, codeIn("late@example.com"))).rejects.toThrow(/expired/);
  });
});

describe("onboarding and duplicate checks", () => {
  async function newPortalUser(email: string) {
    await deliveryProven();
    const { token } = await signup(email);
    const u = await completeSignup(token, codeIn(email));
    return { id: u.id, name: u.name, email: u.email };
  }

  it("creates a new client only when nothing on file could be them, moves uploads, and records only chosen consents", async () => {
    const user = await newPortalUser("nina@example.com");
    await expect(submitOnboarding(user)).rejects.toThrow(/Save your details/);
    await saveOnboardingDetails(user, details());
    await uploadOnboardingFile(user, { bytes: PDF, originalName: "2025 return.pdf" });
    expect(await submitOnboarding(user)).toBe("APPROVED_NEW");
    const access = await prisma.portalAccess.findFirstOrThrow({ where: { portalUserId: user.id } });
    const client = await prisma.client.findUniqueOrThrow({ where: { id: access.clientId } });
    expect(client).toMatchObject({ displayName: "Nina New", status: "PROSPECT", emailNormalized: "nina@example.com" });
    expect(await prisma.document.count({ where: { clientId: client.id, uploadedByPortalId: user.id } })).toBe(1);
    expect(await prisma.smsConsentEvent.count({ where: { phoneNormalized: "+12055550142", category: "SERVICE", status: "GRANTED" } })).toBe(1);
    expect(await prisma.smsConsentEvent.count({ where: { category: "MARKETING" } })).toBe(0);
    expect(await prisma.consentRecord.count({ where: { kind: "EMAIL_MARKETING" } })).toBe(0);
    expect(await prisma.conversation.count({ where: { clientId: client.id, awaitingStaff: true } })).toBe(1);
  });

  it("self-service: a look-alike gets their own account immediately (never another person's record); a verified email on file connects to that record", async () => {
    const tab = await makeUser("ADMIN");
    const existing = await createClient(tab, { firstName: "Nina", lastName: "New", clientType: "INDIVIDUAL", status: "ACTIVE" });
    const other = await createClient(tab, { firstName: "Other", lastName: "Person", clientType: "INDIVIDUAL", status: "ACTIVE" });
    // Same full name, different email: no staff approval, no access to the existing record.
    const user = await newPortalUser("nina.personal@example.com");
    await saveOnboardingDetails(user, details({ phone: "", smsService: false }));
    expect(await submitOnboarding(user)).toBe("APPROVED_NEW");
    const app = await prisma.onboardingApplication.findFirstOrThrow({ where: { portalUserId: user.id } });
    await requireClientAccess(user.id, app.clientId!); // in their own portal right away
    await expect(requireClientAccess(user.id, existing.id)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(requireClientAccess(user.id, other.id)).rejects.toBeInstanceOf(ForbiddenError);
    expect(app.possibleMatchIds).toEqual([existing.id]);
    // Staff get a staff-only "possible duplicate" note to check and merge if it's the same person.
    const note = await prisma.message.findFirstOrThrow({ where: { conversation: { clientId: app.clientId!, subject: { startsWith: "Possible duplicate" } } } });
    expect(note.channel).toBe("INTERNAL_NOTE");

    // An existing client whose email is on file signs up instead of activating: the code they
    // entered proves the address, so they're connected to their record — no duplicate created.
    const ali = await createClient(tab, { firstName: "Ali", lastName: "OnFile", email: "ali.onfile@example.com", clientType: "INDIVIDUAL", status: "ACTIVE" });
    const before = await prisma.client.count();
    const aliUser = await newPortalUser("ali.onfile@example.com");
    await saveOnboardingDetails(aliUser, details({ firstName: "Ali", lastName: "OnFile", phone: "", smsService: false }));
    await submitOnboarding(aliUser);
    await requireClientAccess(aliUser.id, ali.id);
    expect(await prisma.client.count()).toBe(before);
  });
});

describe("Activate your portal", () => {
  it("emails a one-time link to the single record with that email on file; unknown emails get a sign-up link; no staff step", async () => {
    await deliveryProven();
    const tab = await makeUser("ADMIN");
    const c = await createClient(tab, { firstName: "Alma", lastName: "Fictional", email: "alma@example.com", clientType: "INDIVIDUAL", status: "ACTIVE" });
    await requestActivation({ email: "ALMA@example.com", name: "Alma", phone: "", ip: "203.0.113.1" });
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toBe("alma@example.com");
    const link = sent[0].text.match(/\/client\/invite\/(\S+)/)![1];
    const invite = await prisma.portalInvite.findFirstOrThrow({ where: { clientId: c.id } });
    expect(invite.sentByEmail).toBe(true);
    const user = await acceptPortalInvite(link, "Alma-Portal-Pass-1");
    expect(user.emailVerifiedAt).not.toBeNull();
    await requireClientAccess(user.id, c.id);

    // A repeat request soon after doesn't cancel the link just sent (double click, impatient retry).
    const before = sent.length;
    const c2 = await createClient(tab, { firstName: "Bo", lastName: "Fictional", email: "bo@example.com", clientType: "INDIVIDUAL", status: "ACTIVE" });
    await requestActivation({ email: "bo@example.com", name: "Bo", phone: "", ip: "203.0.113.9" });
    const boLink = sent.at(-1)!.text.match(/\/client\/invite\/(\S+)/)![1];
    await requestActivation({ email: "bo@example.com", name: "Bo", phone: "", ip: "203.0.113.9" });
    expect(sent.length).toBe(before + 1);
    const { findOpenPortalInvite } = await import("@/lib/services/portal-accounts");
    expect(await findOpenPortalInvite(boLink)).not.toBeNull();
    expect(await prisma.portalInvite.count({ where: { clientId: c2.id } })).toBe(1);
    expect(await prisma.client.count({ where: { email: "bo@example.com" } })).toBe(1); // never a duplicate record

    // Not on file: they're emailed how to create an account (the page answer stays the same); no staff queue.
    await requestActivation({ email: "stranger@example.com", name: "", phone: "", ip: "203.0.113.2" });
    expect(sent.at(-1)!.to).toBe("stranger@example.com");
    expect(sent.at(-1)!.text).toMatch(/\/client\/signup/);
    expect(await prisma.activationRequest.count({ where: { status: { in: ["NEEDS_STAFF", "EMAIL_FAILED"] } } })).toBe(0);
    // Already active: sign-in reminder, no new invite.
    await requestActivation({ email: "alma@example.com", name: "", phone: "", ip: "203.0.113.3" });
    expect(sent.at(-1)!.subject).toMatch(/portal/);
    expect(await prisma.portalInvite.count({ where: { clientId: c.id } })).toBe(1);
  });

  it("only exceptions reach staff: paused delivery (dashboard only) and an email shared by several records (one alert, assigned staff emailed); the count drops when resolved", async () => {
    const tab = await makeUser("ADMIN");
    await createClient(tab, { firstName: "A", lastName: "One", email: "shared@example.com", clientType: "INDIVIDUAL", status: "ACTIVE" });
    await prisma.client.updateMany({ data: { assignedToId: tab.id } });
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    // Before the one-time delivery check: held, no email to anyone, no per-request alerts.
    await requestActivation({ email: "shared@example.com", name: "", phone: "", ip: null });
    expect(sent).toHaveLength(0);
    expect(await prisma.conversation.count()).toBe(0);
    expect(info.mock.calls.map((c) => c[0])).toContain("Activation request: held, no email (email delivery not yet confirmed in Settings → Client sign-in); matching records: 1");
    expect(JSON.stringify(info.mock.calls)).not.toMatch(/shared@example\.com/);
    const held = await prisma.activationRequest.findFirstOrThrow({ where: { status: "NEEDS_STAFF" } });
    expect(activationWaitingReason(held, await selfServiceAvailable())).toMatch(/paused until email delivery is confirmed/);
    info.mockRestore();

    await deliveryProven();
    await createClient(tab, { firstName: "B", lastName: "Two", email: "shared@example.com", clientType: "INDIVIDUAL", status: "ACTIVE" });
    // Two records share the email: an identity question — staff decide which person it is.
    await requestActivation({ email: "shared@example.com", name: "", phone: "", ip: null });
    await requestActivation({ email: "shared@example.com", name: "", phone: "", ip: null }); // retry: no duplicate alerts
    expect(sent.filter((m) => m.to === "shared@example.com")).toHaveLength(0);
    expect(sent.filter((m) => m.to === tab.email)).toHaveLength(1); // only record A is assigned; one alert despite the retry
    expect(sent.find((m) => m.to === tab.email)!.text).not.toMatch(/shared@example\.com/);
    expect(await prisma.conversation.count({ where: { subject: "Portal activation request needs review" } })).toBe(2); // one staff-only note per record
    expect((await prisma.message.findFirstOrThrow({ where: { conversation: { subject: "Portal activation request needs review" } } })).channel).toBe("INTERNAL_NOTE");
    // Dashboard count = waiting requests; it drops as staff resolve or dismiss them.
    const waiting = () => prisma.activationRequest.count({ where: { status: { in: ["NEEDS_STAFF", "EMAIL_FAILED"] } } });
    expect(await waiting()).toBe(3);
    const { dismissActivation } = await import("@/lib/services/client-signup");
    for (const r of await prisma.activationRequest.findMany({ where: { status: "NEEDS_STAFF" } })) await dismissActivation(tab, r.id);
    expect(await waiting()).toBe(0);
  });

  it("staff-created invitation links shown on screen don't count as email verification", async () => {
    const tab = await makeUser("ADMIN");
    const c = await createClient(tab, { firstName: "Sam", lastName: "Screen", clientType: "INDIVIDUAL", status: "ACTIVE" });
    const { invitePortalUser } = await import("@/lib/services/portal-accounts");
    const { token } = await invitePortalUser(tab, c.id, { email: "sam@example.com", name: "Sam", role: "OWNER" });
    const u = await acceptPortalInvite(token!, "Sam-Portal-Pass-1");
    expect(u.emailVerifiedAt).toBeNull();
  });
});
