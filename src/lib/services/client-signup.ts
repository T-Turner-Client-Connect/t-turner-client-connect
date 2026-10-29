import "server-only";
import { createHash, randomInt, timingSafeEqual } from "node:crypto";
import type { ClientType, OnboardingApplication } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { audit } from "@/lib/audit";
import type { Actor } from "@/lib/auth/actor";
import { hashPassword, passwordProblem } from "@/lib/auth/password";
import { hashToken, newToken } from "@/lib/auth/tokens";
import { authSettings, emailProviderConfigured } from "@/lib/auth/client-auth";
import { sign } from "@/lib/crypto";
import { brandedEmailHtml, sendEmail } from "@/lib/email";
import { MAX_UPLOAD_BYTES, MAX_UPLOAD_LABEL, sniffType } from "@/lib/files";
import { appUrl } from "@/lib/integrations";
import { normalizeEmail, normalizePhone } from "@/lib/normalize";
import { storage } from "@/lib/storage";
import { BUSINESS, SMS_CONSENT_TEXT } from "@/lib/business";
import type { PortalActor } from "@/lib/portal/session";
import { ValidationError } from "./clients";
import { maskEmail } from "./mfa";
import { invitePortalUser } from "./portal-accounts";
import { retentionDate } from "./documents";
import { applySmsConsent } from "./sms-consent";

/**
 * "Create Client Account" (new clients) and "Activate your portal" (existing
 * clients). Public answers are always the same generic message, so nobody can
 * learn whether an email belongs to a client. A login is linked to an existing
 * CRM record only through an invitation emailed to the address on file or a
 * staff-approved connection — never because someone typed a matching email.
 * New client records are created only when nothing on file could be them.
 */

export const SERVICES = [
  "Individual tax preparation",
  "Business tax preparation",
  "Nonprofit tax / compliance",
  "Bookkeeping",
  "Payroll",
  "Business setup",
  "Consultation",
  "Other",
] as const;

const CODE_TTL_MS = 15 * 60 * 1000;
const RESEND_COOLDOWN_MS = 60 * 1000;
const MAX_SENDS = 5;
const MAX_ATTEMPTS = 5;
const hashCode = (c: string) => createHash("sha256").update(c.trim()).digest("hex");
const ipKey = (ip: string | null) => (ip ? sign(`ip:${ip}`).slice(0, 32) : null);

/** Signup and activation emails only start once real delivery has been proven by an Admin. */
export async function selfServiceAvailable() {
  return emailProviderConfigured() && !!(await authSettings()).emailDeliveryVerifiedAt;
}

async function limited(key: string, max: number, windowMs: number) {
  const n = await prisma.loginAttempt.count({ where: { email: key, success: false, createdAt: { gte: new Date(Date.now() - windowMs) } } });
  if (n >= max) throw new ValidationError("Too many attempts. Please wait an hour and try again, or call our office.");
  await prisma.loginAttempt.create({ data: { email: key, success: false } });
}

function mail(heading: string, paragraphs: string[], button: { label: string; url: string }) {
  return {
    text: `${paragraphs.join("\n\n")}\n\n${button.label}: ${button.url}\n\n${BUSINESS.legalName} · ${BUSINESS.officePhoneDisplay}`,
    html: brandedEmailHtml({ heading, paragraphs, button, footer: `${BUSINESS.legalName} · ${BUSINESS.officePhoneDisplay}` }),
  };
}

async function sendSignupCode(email: string, available: boolean, code: string, key: string) {
  const body = available
    ? mail("Your account code", [`Your code to create your ${BUSINESS.platformName} account is ${code}.`, "It expires in 15 minutes and works once. If you didn't start creating an account, you can ignore this email."], { label: "Open the client portal", url: `${appUrl()}/client/signup` })
    : mail("You already have an account", ["Someone (hopefully you) tried to create a client portal account with this email address, but you already have one.", "Sign in instead, or use “Forgot your password?” on the sign-in page. If this wasn't you, you can ignore this email."], { label: "Sign in", url: `${appUrl()}/client/login` });
  const res = await sendEmail({ to: email, subject: available ? `${code} is your ${BUSINESS.platformName} code` : `Your ${BUSINESS.platformName} account`, ...body, idempotencyKey: key, tags: { category: "client_account" } });
  if (!res.ok) throw new ValidationError(`We couldn't send the email right now (${res.detail}) Please try again later or call our office.`);
}

export type SignupInput = { name: string; email: string; password: string; confirm: string; ip: string | null; honeypot?: string };

/**
 * Starts a signup and emails a code. Returns a browser token (set as a cookie)
 * and the masked address. The response is the same whether or not the email
 * already has a portal login — that person gets a "sign in instead" email.
 */
export async function startSignup(input: SignupInput) {
  if (!(await selfServiceAvailable())) throw new ValidationError("Online sign-up isn't open yet. Please call our office and we'll set up your account.");
  if (input.honeypot) throw new ValidationError("Please try again.");
  const email = normalizeEmail(input.email);
  if (!email) throw new ValidationError("Enter a valid email address.");
  if (!input.name.trim()) throw new ValidationError("Enter your name.");
  if (input.password !== input.confirm) throw new ValidationError("The passwords don't match.");
  const problem = passwordProblem(input.password);
  if (problem) throw new ValidationError(problem);
  const ip = ipKey(input.ip);
  if (ip) await limited(`signup-ip:${ip}`, 10, 3600_000);
  await limited(`signup-email:${email}`, 3, 3600_000);

  const available = !(await prisma.portalUser.findUnique({ where: { email } }));
  const token = newToken();
  const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
  await prisma.portalSignup.updateMany({ where: { emailNormalized: email, consumedAt: null }, data: { consumedAt: new Date() } });
  const row = await prisma.portalSignup.create({
    data: {
      emailNormalized: email,
      name: input.name.trim().slice(0, 120),
      passwordHash: await hashPassword(input.password),
      browserHash: hashToken(token),
      codeHash: hashCode(code),
      codeExpiresAt: new Date(Date.now() + CODE_TTL_MS),
      lastSentAt: new Date(),
      available,
      ipHash: ip,
    },
  });
  try {
    await sendSignupCode(email, available, code, `signup/${row.id}/1`);
  } catch (e) {
    await prisma.portalSignup.update({ where: { id: row.id }, data: { consumedAt: new Date() } });
    throw e;
  }
  return { token, masked: maskEmail(email) };
}

async function pendingSignup(token: string | undefined) {
  if (!token) throw new ValidationError("Your sign-up session ended. Please start again.");
  const row = await prisma.portalSignup.findUnique({ where: { browserHash: hashToken(token) } });
  if (!row || row.consumedAt) throw new ValidationError("Your sign-up session ended. Please start again.");
  return row;
}

export async function signupDestination(token: string | undefined) {
  try {
    return maskEmail((await pendingSignup(token)).emailNormalized);
  } catch {
    return null;
  }
}

export async function resendSignupCode(token: string | undefined) {
  const row = await pendingSignup(token);
  const since = Date.now() - row.lastSentAt.getTime();
  if (since < RESEND_COOLDOWN_MS) throw new ValidationError(`Please wait ${Math.ceil((RESEND_COOLDOWN_MS - since) / 1000)} seconds before requesting another code.`);
  if (row.sendCount >= MAX_SENDS) throw new ValidationError("Too many codes requested. Please start again later or call our office.");
  const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
  await prisma.portalSignup.update({ where: { id: row.id }, data: { codeHash: hashCode(code), codeExpiresAt: new Date(Date.now() + CODE_TTL_MS), attempts: 0, sendCount: { increment: 1 }, lastSentAt: new Date() } });
  await sendSignupCode(row.emailNormalized, row.available, code, `signup/${row.id}/${row.sendCount + 1}`);
  return maskEmail(row.emailNormalized);
}

/** Checks the emailed code; creates the portal login (email verified) and an onboarding application. */
export async function completeSignup(token: string | undefined, code: string) {
  const row = await pendingSignup(token);
  if (row.attempts >= MAX_ATTEMPTS) throw new ValidationError("Too many wrong codes. Request a new code.");
  if (row.codeExpiresAt < new Date()) throw new ValidationError("That code has expired. Request a new one.");
  const ok = row.available && timingSafeEqual(Buffer.from(row.codeHash), Buffer.from(hashCode(code)));
  if (!ok) {
    await prisma.portalSignup.update({ where: { id: row.id }, data: { attempts: { increment: 1 } } });
    throw new ValidationError("That code didn't work. Check the newest email from us and try again.");
  }
  return prisma.$transaction(async (tx) => {
    const claimed = await tx.portalSignup.updateMany({ where: { id: row.id, consumedAt: null }, data: { consumedAt: new Date() } });
    if (claimed.count !== 1) throw new ValidationError("This sign-up was already completed. Sign in instead.");
    if (await tx.portalUser.findUnique({ where: { email: row.emailNormalized } })) throw new ValidationError("This sign-up was already completed. Sign in instead.");
    const user = await tx.portalUser.create({
      data: { email: row.emailNormalized, name: row.name, passwordHash: row.passwordHash, emailVerifiedAt: new Date(), origin: "SELF_SIGNUP" },
    });
    await tx.onboardingApplication.create({ data: { portalUserId: user.id } });
    await audit(tx, { actorId: null, action: "portal.self_signup", entityType: "PortalUser", entityId: user.id });
    return user;
  });
}

// ---------------------------------------------------------------------------
// Onboarding (signed-in, not yet linked to a client record)
// ---------------------------------------------------------------------------

export async function myApplication(user: PortalActor) {
  return prisma.onboardingApplication.findUnique({ where: { portalUserId: user.id }, include: { files: { orderBy: { createdAt: "asc" } } } });
}

async function openApplication(user: PortalActor) {
  const app = await prisma.onboardingApplication.findUnique({ where: { portalUserId: user.id } });
  if (!app) throw new ValidationError("There's no account setup in progress.");
  if (app.status !== "IN_PROGRESS") throw new ValidationError("Your details were already submitted.");
  return app;
}

export type OnboardingDetails = {
  clientType: ClientType;
  firstName: string;
  lastName: string;
  businessName: string;
  phone: string;
  addressLine1: string;
  city: string;
  state: string;
  postalCode: string;
  services: string[];
  notes: string;
  smsService: boolean;
  smsMarketing: boolean;
  emailMarketing: boolean;
};

export async function saveOnboardingDetails(user: PortalActor, d: OnboardingDetails) {
  const app = await openApplication(user);
  if (d.clientType === "INDIVIDUAL" ? !d.firstName.trim() || !d.lastName.trim() : !d.businessName.trim()) {
    throw new ValidationError(d.clientType === "INDIVIDUAL" ? "Enter your first and last name." : "Enter the business or organization name.");
  }
  const phoneNormalized = d.phone.trim() ? normalizePhone(d.phone) : null;
  if (d.phone.trim() && !phoneNormalized) throw new ValidationError("Enter a valid US mobile or phone number.");
  if ((d.smsService || d.smsMarketing) && !phoneNormalized) throw new ValidationError("Add a mobile number to choose text messages.");
  const services = d.services.filter((s) => (SERVICES as readonly string[]).includes(s));
  if (!services.length) throw new ValidationError("Choose at least one service you're interested in.");
  await prisma.onboardingApplication.update({
    where: { id: app.id },
    data: {
      clientType: d.clientType,
      firstName: d.firstName.trim() || null,
      lastName: d.lastName.trim() || null,
      businessName: d.businessName.trim() || null,
      phone: d.phone.trim() || null,
      phoneNormalized,
      addressLine1: d.addressLine1.trim() || null,
      city: d.city.trim() || null,
      state: d.state.trim().toUpperCase().slice(0, 2) || null,
      postalCode: d.postalCode.trim() || null,
      servicesRequested: services,
      notes: d.notes.trim().slice(0, 2000) || null,
      smsService: d.smsService,
      smsMarketing: d.smsMarketing,
      emailMarketing: d.emailMarketing,
    },
  });
}

export async function uploadOnboardingFile(user: PortalActor, file: { bytes: Uint8Array; originalName: string }) {
  const app = await openApplication(user);
  if (file.bytes.length === 0) throw new ValidationError("The file is empty.");
  if (file.bytes.length > MAX_UPLOAD_BYTES) throw new ValidationError(`Files can be up to ${MAX_UPLOAD_LABEL}.`);
  const type = sniffType(file.bytes);
  if (!type) throw new ValidationError("Upload a PDF, JPG or PNG file.");
  if ((await prisma.onboardingFile.count({ where: { applicationId: app.id } })) >= 20) throw new ValidationError("You can upload up to 20 files now; send more after your account is set up.");
  // Client-document store, held privately until the account is connected.
  const storageKey = `client_document/onboarding/${newToken().slice(0, 32)}`;
  await storage.put(storageKey, file.bytes);
  await prisma.onboardingFile.create({ data: { applicationId: app.id, storageKey, originalName: file.originalName.replace(/[^\w.\- ()]/g, "_").slice(0, 150), mimeType: type.mime, sizeBytes: file.bytes.length } });
}

/** Possible existing records for an application — exact email/phone, same business or same full name. Staff-only. */
export async function possibleMatches(app: Pick<OnboardingApplication, "firstName" | "lastName" | "businessName" | "phoneNormalized">, email: string) {
  const or: object[] = [{ emailNormalized: email }];
  if (app.phoneNormalized) or.push({ phoneNormalized: app.phoneNormalized });
  if (app.businessName) or.push({ businessName: { equals: app.businessName, mode: "insensitive" } });
  if (app.firstName && app.lastName) or.push({ AND: [{ firstName: { equals: app.firstName, mode: "insensitive" } }, { lastName: { equals: app.lastName, mode: "insensitive" } }] });
  const [clients, contacts] = await Promise.all([
    prisma.client.findMany({ where: { archivedAt: null, OR: or }, select: { id: true } }),
    prisma.contact.findMany({ where: { OR: [{ emailNormalized: email }, ...(app.phoneNormalized ? [{ phoneNormalized: app.phoneNormalized }] : [])], client: { archivedAt: null } }, select: { clientId: true } }),
  ]);
  return [...new Set([...clients.map((c) => c.id), ...contacts.map((c) => c.clientId)])];
}

/** Moves held files into the client's documents and records the client's own choices. */
async function finishLink(applicationId: string, clientId: string, portalUserId: string, grantedById: string | null) {
  const app = await prisma.onboardingApplication.findUniqueOrThrow({ where: { id: applicationId }, include: { files: true, portalUser: true } });
  await prisma.portalAccess.upsert({
    where: { portalUserId_clientId: { portalUserId, clientId } },
    update: { revokedAt: null },
    create: { portalUserId, clientId, role: "OWNER", canViewTax: true, grantedById },
  });
  for (const f of app.files.filter((f) => !f.movedDocumentId)) {
    const doc = await prisma.$transaction(async (tx) => {
      const file = await tx.storedFile.create({
        data: { kind: "CLIENT_DOCUMENT", storageKey: f.storageKey, originalName: f.originalName, title: f.originalName.replace(/\.[^.]+$/, ""), mimeType: f.mimeType, sizeBytes: f.sizeBytes, uploadedByPortalUserId: portalUserId },
      });
      return tx.document.create({
        data: { clientId, category: "CLIENT_UPLOADS", title: file.title, year: new Date().getFullYear(), visibility: "PUBLISHED", publishedAt: new Date(), fileId: file.id, uploadedByPortalId: portalUserId, retainUntil: await retentionDate("CLIENT_UPLOADS") },
      });
    });
    await prisma.onboardingFile.update({ where: { id: f.id }, data: { movedDocumentId: doc.id } });
  }
  if (app.phoneNormalized) {
    const meta = (text: string) => ({ source: "CLIENT_PORTAL", sourcePage: "/client/start", consentText: text, note: `Portal onboarding ${portalUserId}` });
    if (app.smsService) await prisma.$transaction((tx) => applySmsConsent(tx, app.phoneNormalized!, "SERVICE", "GRANTED", meta(SMS_CONSENT_TEXT.SERVICE)));
    if (app.smsMarketing) await prisma.$transaction((tx) => applySmsConsent(tx, app.phoneNormalized!, "MARKETING", "GRANTED", meta(SMS_CONSENT_TEXT.MARKETING)));
    if (app.smsService) await prisma.portalUser.update({ where: { id: portalUserId }, data: { phone: app.phone, phoneNormalized: app.phoneNormalized, notifyBySms: true } });
  }
  if (app.emailMarketing) {
    await prisma.consentRecord.create({ data: { clientId, kind: "EMAIL_MARKETING", status: "GRANTED", source: "Client portal onboarding (client checked the box)", scope: "Newsletters and offers by email" } });
  }
  // Lands in the shared staff inbox like any client message.
  await prisma.$transaction(async (tx) => {
    const convo = await tx.conversation.create({ data: { clientId, subject: "New client account set up", awaitingStaff: true, unreadByStaff: true } });
    await tx.message.create({
      data: {
        conversationId: convo.id,
        channel: "PORTAL",
        direction: "INBOUND",
        portalAuthorId: portalUserId,
        status: "DELIVERED",
        body: `I set up my portal account.\nServices I'm interested in: ${app.servicesRequested.join(", ")}${app.notes ? `\nNotes: ${app.notes}` : ""}${app.files.length ? `\nI uploaded ${app.files.length} document(s).` : ""}`,
      },
    });
  });
}

/**
 * Submits onboarding. With no possible match on file, a new client record is
 * created and linked. Otherwise staff review it — the client is never shown
 * or linked to an existing record automatically.
 */
export async function submitOnboarding(user: PortalActor) {
  const app = await openApplication(user);
  if (!app.servicesRequested.length) throw new ValidationError("Save your details first.");
  const portalUser = await prisma.portalUser.findUniqueOrThrow({ where: { id: user.id } });
  const matches = await possibleMatches(app, portalUser.email);
  if (matches.length) {
    await prisma.onboardingApplication.update({ where: { id: app.id }, data: { status: "NEEDS_REVIEW", possibleMatchIds: matches, submittedAt: new Date() } });
    await audit(prisma, { actorId: null, action: "portal.onboarding_needs_review", entityType: "OnboardingApplication", entityId: app.id });
    return "NEEDS_REVIEW" as const;
  }
  const client = await prisma.$transaction(async (tx) => {
    const claimed = await tx.onboardingApplication.updateMany({ where: { id: app.id, status: "IN_PROGRESS" }, data: { status: "APPROVED_NEW", submittedAt: new Date() } });
    if (claimed.count !== 1) throw new ValidationError("Your details were already submitted.");
    const displayName = app.clientType === "INDIVIDUAL" ? `${app.firstName} ${app.lastName}` : app.businessName!;
    const c = await tx.client.create({
      data: {
        clientType: app.clientType,
        firstName: app.firstName,
        lastName: app.lastName,
        businessName: app.businessName,
        displayName,
        email: portalUser.email,
        emailNormalized: portalUser.email,
        phone: app.phone,
        phoneNormalized: app.phoneNormalized,
        addressLine1: app.addressLine1,
        city: app.city,
        state: app.state,
        postalCode: app.postalCode,
        status: "PROSPECT",
        source: "Client portal sign-up",
        notes: `Requested through the portal: ${app.servicesRequested.join(", ")}`,
      },
    });
    await tx.onboardingApplication.update({ where: { id: app.id }, data: { clientId: c.id } });
    await audit(tx, { actorId: null, action: "client.created_from_signup", entityType: "Client", entityId: c.id, clientId: c.id });
    return c;
  });
  await finishLink(app.id, client.id, user.id, null);
  return "APPROVED_NEW" as const;
}

// ---------------------------------------------------------------------------
// Staff review
// ---------------------------------------------------------------------------

export async function reviewQueue() {
  const [applications, activations] = await Promise.all([
    prisma.onboardingApplication.findMany({ where: { status: "NEEDS_REVIEW" }, include: { portalUser: { select: { email: true, name: true } }, files: true }, orderBy: { submittedAt: "asc" } }),
    prisma.activationRequest.findMany({ where: { status: { in: ["NEEDS_STAFF", "EMAIL_FAILED"] } }, orderBy: { createdAt: "asc" } }),
  ]);
  const ids = [...new Set([...applications.flatMap((a) => a.possibleMatchIds), ...activations.flatMap((a) => a.matchedClientIds)])];
  const clients = new Map((await prisma.client.findMany({ where: { id: { in: ids } }, select: { id: true, displayName: true, email: true, phone: true } })).map((c) => [c.id, c]));
  return { applications, activations, clients };
}

/** Staff confirmed this person is NOT an existing client: create a new record. */
export async function approveAsNewClient(actor: Actor, applicationId: string) {
  const app = await prisma.onboardingApplication.findUniqueOrThrow({ where: { id: applicationId }, include: { portalUser: true } });
  if (app.status !== "NEEDS_REVIEW") throw new ValidationError("This request was already handled.");
  const client = await prisma.client.create({
    data: {
      clientType: app.clientType,
      firstName: app.firstName,
      lastName: app.lastName,
      businessName: app.businessName,
      displayName: app.clientType === "INDIVIDUAL" ? `${app.firstName} ${app.lastName}` : app.businessName!,
      email: app.portalUser.email,
      emailNormalized: app.portalUser.email,
      phone: app.phone,
      phoneNormalized: app.phoneNormalized,
      addressLine1: app.addressLine1,
      city: app.city,
      state: app.state,
      postalCode: app.postalCode,
      status: "PROSPECT",
      source: "Client portal sign-up (staff reviewed)",
      notes: `Requested through the portal: ${app.servicesRequested.join(", ")}`,
    },
  });
  await prisma.onboardingApplication.update({ where: { id: app.id }, data: { status: "APPROVED_NEW", clientId: client.id, decidedById: actor.id, decidedAt: new Date() } });
  await audit(prisma, { actorId: actor.id, action: "portal.onboarding_new_client", entityType: "Client", entityId: client.id, clientId: client.id });
  await finishLink(app.id, client.id, app.portalUserId, actor.id);
}

/** Staff verified the person's identity and connect the login to an existing record. */
export async function linkToExistingClient(actor: Actor, applicationId: string, clientId: string, identityVerified: boolean) {
  if (!identityVerified) throw new ValidationError("Confirm you verified this person's identity (for example by phone) before connecting their login.");
  const app = await prisma.onboardingApplication.findUniqueOrThrow({ where: { id: applicationId } });
  if (app.status !== "NEEDS_REVIEW") throw new ValidationError("This request was already handled.");
  if (!(await prisma.client.count({ where: { id: clientId, archivedAt: null } }))) throw new ValidationError("Choose an active client record.");
  await prisma.onboardingApplication.update({ where: { id: app.id }, data: { status: "LINKED_EXISTING", clientId, decidedById: actor.id, decidedAt: new Date() } });
  await audit(prisma, { actorId: actor.id, action: "portal.onboarding_linked_existing", entityType: "Client", entityId: clientId, clientId, details: { identityVerified: true } });
  await finishLink(app.id, clientId, app.portalUserId, actor.id);
}

export async function declineApplication(actor: Actor, applicationId: string, note: string) {
  const res = await prisma.onboardingApplication.updateMany({ where: { id: applicationId, status: "NEEDS_REVIEW" }, data: { status: "DECLINED", decidedById: actor.id, decidedAt: new Date(), decisionNote: note.trim() || null } });
  if (res.count !== 1) throw new ValidationError("This request was already handled.");
  await audit(prisma, { actorId: actor.id, action: "portal.onboarding_declined", entityType: "OnboardingApplication", entityId: applicationId });
}

// ---------------------------------------------------------------------------
// Activate your portal (existing clients)
// ---------------------------------------------------------------------------

async function emailActivationInvite(clientId: string, email: string, name: string, invitedBy: Actor | null) {
  const { token, grantedExisting } = await invitePortalUser(invitedBy ?? ({ id: null } as unknown as Actor), clientId, { email, name, role: "OWNER" });
  if (grantedExisting || !token) return { ok: true as const, grantedExisting: true };
  const invite = await prisma.portalInvite.findFirstOrThrow({ where: { email, clientId, acceptedAt: null, revokedAt: null }, orderBy: { createdAt: "desc" } });
  await prisma.portalInvite.update({ where: { id: invite.id }, data: { sentByEmail: true } });
  const link = `${appUrl()}/client/invite/${token}`;
  const body = mail("Activate your client portal", [`Hello ${name},`, `Here's your secure link to activate your ${BUSINESS.platformName} portal with ${BUSINESS.legalName}. It works once and expires in 7 days.`, "If you didn't ask for this, you can ignore this email."], { label: "Activate my portal", url: link });
  const res = await sendEmail({ to: email, subject: `Activate your ${BUSINESS.platformName} portal`, ...body, idempotencyKey: `activation/${invite.id}`, tags: { category: "client_account" } });
  return res.ok ? { ok: true as const, grantedExisting: false } : { ok: false as const, detail: res.detail };
}

/**
 * Public "Activate your portal" request. If exactly one client record has this
 * email on file, an activation link is emailed to that address (opening it is
 * the verification). Anything else goes to staff. Same answer every time.
 */
export async function requestActivation(input: { email: string; name: string; phone: string; ip: string | null; honeypot?: string }) {
  if (input.honeypot) return;
  const email = normalizeEmail(input.email);
  if (!email) throw new ValidationError("Enter a valid email address.");
  const ip = ipKey(input.ip);
  if (ip) await limited(`activate-ip:${ip}`, 10, 3600_000);
  await limited(`activate-email:${email}`, 3, 3600_000);
  const [clients, contacts] = await Promise.all([
    prisma.client.findMany({ where: { emailNormalized: email, archivedAt: null }, select: { id: true, displayName: true } }),
    prisma.contact.findMany({ where: { emailNormalized: email, client: { archivedAt: null } }, select: { clientId: true } }),
  ]);
  const matched = [...new Set([...clients.map((c) => c.id), ...contacts.map((c) => c.clientId)])];
  const record = (status: "INVITE_SENT" | "ALREADY_ACTIVE" | "NEEDS_STAFF" | "EMAIL_FAILED") =>
    prisma.activationRequest.create({ data: { emailNormalized: email, name: input.name.trim().slice(0, 120) || null, phone: input.phone.trim().slice(0, 30) || null, ipHash: ip, status, matchedClientIds: matched } });

  if (matched.length !== 1 || !(await selfServiceAvailable())) return void (await record("NEEDS_STAFF"));
  const existing = await prisma.portalUser.findUnique({ where: { email }, include: { access: { where: { revokedAt: null } } } });
  if (existing) {
    if (!existing.access.some((a) => a.clientId === matched[0])) return void (await record("NEEDS_STAFF"));
    const body = mail("Your portal is already active", ["Your client portal is already active. Sign in with your email and password, or use “Forgot your password?” to choose a new one."], { label: "Sign in", url: `${appUrl()}/client/login` });
    await sendEmail({ to: email, subject: `Your ${BUSINESS.platformName} portal`, ...body, tags: { category: "client_account" } });
    return void (await record("ALREADY_ACTIVE"));
  }
  const name = input.name.trim() || clients[0]?.displayName || "there";
  const sent = await emailActivationInvite(matched[0], email, name, null);
  await record(sent.ok ? "INVITE_SENT" : "EMAIL_FAILED");
}

/** Staff verified the person and send an activation link to the email on file for the chosen client. */
export async function staffSendActivation(actor: Actor, requestId: string, clientId: string) {
  const req = await prisma.activationRequest.findUniqueOrThrow({ where: { id: requestId } });
  if (req.status !== "NEEDS_STAFF" && req.status !== "EMAIL_FAILED") throw new ValidationError("This request was already handled.");
  const client = await prisma.client.findUnique({ where: { id: clientId } });
  if (!client?.emailNormalized) throw new ValidationError("That client has no email on file. Add it to the client record first.");
  const sent = await emailActivationInvite(clientId, client.emailNormalized, client.displayName, actor);
  if (!sent.ok) throw new ValidationError(`The email couldn't be sent (${sent.detail}). Create a portal invitation from the client's Portal tab instead.`);
  await prisma.activationRequest.update({ where: { id: requestId }, data: { status: "RESOLVED", resolvedById: actor.id, resolvedAt: new Date() } });
  await audit(prisma, { actorId: actor.id, action: "portal.activation_sent", entityType: "Client", entityId: clientId, clientId });
}

export async function dismissActivation(actor: Actor, requestId: string) {
  await prisma.activationRequest.updateMany({ where: { id: requestId, status: { in: ["NEEDS_STAFF", "EMAIL_FAILED"] } }, data: { status: "DISMISSED", resolvedById: actor.id, resolvedAt: new Date() } });
}
