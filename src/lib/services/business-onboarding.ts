import "server-only";
import { isFutureDay } from "@/lib/dates";
import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { audit } from "@/lib/audit";
import { assertAdmin, ForbiddenError, type Actor } from "@/lib/auth/actor";
import { decryptSecret, encryptSecret, sign } from "@/lib/crypto";
import { isValidEmail, normalizeEmail, normalizePhone } from "@/lib/normalize";
import type { PortalActor } from "@/lib/portal/session";
import { requireClientAccess } from "@/lib/portal/access";
import { squareRequest, squareSettings, SquareError, type SquareCard } from "@/lib/square";
import { assertNotBilledInSquare, squareBillingFor } from "./square-billing";
import { ValidationError } from "./clients";
import { PAYROLL_FREQUENCIES } from "./bookkeeping-clients";
import { ACCOUNT_TYPES, maskEin, normalizeEin } from "./bookkeeping-profile";

/**
 * Client-completed business & bookkeeping onboarding.
 *
 * The client enters their business details once; after submission they see
 * them read-only (masked) and can only send an update, which waits for an
 * Admin. Verified details (BookkeepingProfile, BookkeepingAccount) change only
 * when an Admin approves. Every rule here is enforced on the server.
 *
 * Payment: the card is entered only in Square's hosted fields; this app
 * receives a one-time token and stores Square's ids and masked display
 * details. Charging needs the client's acceptance of the actual monthly
 * amount — a saved card alone authorizes nothing.
 */

export const RELATIONSHIPS = { EXISTING: "Existing client", POTENTIAL: "Potential client" } as const;
export const ACCESS_METHODS = {
  DELEGATED: "I'll add TTurner & Associates as an accountant / authorized user at my bank",
  OFFICIAL_CONNECTION: "Connect through my bank's official secure connection",
  STATEMENT_UPLOAD: "I'll upload monthly statements",
} as const;
export const BUSINESS_DOC_TYPES = {
  FORMATION: "Formation documents (articles, operating agreement)",
  EIN_LETTER: "IRS EIN letter (CP 575 / 147C)",
  BANK_STATEMENT: "Bank statement",
  CARD_STATEMENT: "Credit card statement",
  PAYROLL_REPORT: "Payroll report",
  BUSINESS_OTHER: "Other business document",
} as const;

export type AccountEntry = { id?: string; institution: string; accountType: string; last4: string; accessMethod: string; remove?: boolean };
export type BusinessForm = {
  legalName?: string;
  dba?: string;
  ein?: string; // plain only while in transit; stored encrypted
  address1?: string;
  address2?: string;
  city?: string;
  state?: string;
  postalCode?: string;
  startDate?: string; // YYYY-MM-DD
  contactName?: string;
  contactEmail?: string;
  contactPhone?: string;
  payroll?: "YES" | "NO" | "";
  payrollProvider?: string;
  payrollFrequency?: string;
  accounts?: AccountEntry[];
};
// What's stored (draft or submission): the EIN only encrypted, plus last four and a hash for duplicate checks.
type Stored = Omit<BusinessForm, "ein"> & { einEncrypted?: string; einLast4?: string; einHash?: string };

const PASSWORDISH = /\b(password|passcode|pwd|pin|security (question|answer)|one[- ]time code|otp|username)\b/i;
const t = (v: unknown, max = 200) => (typeof v === "string" ? v.trim().slice(0, max) : "");
const einHash = (ein: string) => sign(`ein:${ein.replace(/\D/g, "")}`);

/** The signed-in account owner for this client. Authorized contacts can view but not change business details or payment. */
async function ownerAccess(user: PortalActor, clientId: string) {
  const access = await requireClientAccess(user.id, clientId);
  if (access.role !== "OWNER") throw new ForbiddenError("Only the account owner can change business or payment details. Ask them, or message our office.");
  return access;
}

function cleanAccounts(list: AccountEntry[] | undefined, strict: boolean) {
  const out: AccountEntry[] = [];
  for (const a of list ?? []) {
    const institution = t(a.institution, 120);
    if (!institution && !a.id && !a.last4) continue; // blank row
    if (PASSWORDISH.test(institution)) throw new ValidationError("Don't enter passwords, PINs or sign-in codes. We never ask for bank passwords — choose accountant access or statement uploads instead.");
    if (strict || a.last4) {
      if (!institution) throw new ValidationError("Enter the bank or card company for each account.");
      if (!(a.accountType in ACCOUNT_TYPES)) throw new ValidationError(`Choose the account type for ${institution}.`);
      if (!/^\d{4}$/.test(a.last4 ?? "")) throw new ValidationError(`Enter only the last 4 digits of the ${institution} account number.`);
      if (!(a.accessMethod in ACCESS_METHODS)) throw new ValidationError(`Choose how we'll access ${institution} (accountant access, official connection, or statement uploads).`);
    }
    out.push({ ...(a.id ? { id: a.id } : {}), institution, accountType: a.accountType, last4: a.last4 ?? "", accessMethod: a.accessMethod, ...(a.remove ? { remove: true } : {}) });
  }
  return out;
}

/** Validates the form. strict = submission (everything required); otherwise a partial draft is fine. */
function prepare(form: BusinessForm, opts: { strict: boolean; existingEin?: { last4: string | null; encrypted: string | null; hash: string | null } }): Stored {
  const s: Stored = {
    legalName: t(form.legalName),
    dba: t(form.dba),
    address1: t(form.address1),
    address2: t(form.address2),
    city: t(form.city, 80),
    state: t(form.state, 2).toUpperCase(),
    postalCode: t(form.postalCode, 10),
    startDate: t(form.startDate, 10),
    contactName: t(form.contactName, 120),
    contactEmail: t(form.contactEmail, 200).toLowerCase(),
    contactPhone: t(form.contactPhone, 30),
    payroll: form.payroll === "YES" ? "YES" : form.payroll === "NO" ? "NO" : "",
    payrollProvider: form.payroll === "YES" ? t(form.payrollProvider, 80) : "",
    payrollFrequency: form.payroll === "YES" ? t(form.payrollFrequency, 20) : "",
    accounts: cleanAccounts(form.accounts, opts.strict),
  };
  if (form.ein?.trim()) {
    const ein = normalizeEin(form.ein);
    Object.assign(s, { einEncrypted: encryptSecret(ein), einLast4: ein.slice(-4), einHash: einHash(ein) });
  } else if (opts.existingEin?.encrypted) {
    Object.assign(s, { einEncrypted: opts.existingEin.encrypted, einLast4: opts.existingEin.last4 ?? undefined, einHash: opts.existingEin.hash ?? undefined });
  }
  if (s.contactEmail && !isValidEmail(s.contactEmail)) throw new ValidationError("The contact email doesn't look right.");
  if (s.contactPhone && !normalizePhone(s.contactPhone)) throw new ValidationError("Enter a 10-digit phone number.");
  if (s.state && !/^[A-Z]{2}$/.test(s.state)) throw new ValidationError("Use the 2-letter state abbreviation.");
  if (s.startDate) {
    const d = new Date(`${s.startDate}T12:00:00`);
    if (Number.isNaN(d.getTime()) || isFutureDay(s.startDate)) throw new ValidationError("Enter the business start date (not in the future).");
  }
  if (s.payroll === "YES" && s.payrollFrequency && !(s.payrollFrequency in PAYROLL_FREQUENCIES)) throw new ValidationError("Choose how often payroll runs.");
  if (opts.strict) {
    const missing = missingFields(s);
    if (missing.length) throw new ValidationError(`Please complete: ${missing.join(", ")}.`);
  }
  return s;
}

export function missingFields(s: Stored) {
  const m: string[] = [];
  if (!s.legalName) m.push("legal business name");
  if (!s.einEncrypted) m.push("EIN");
  if (!s.address1 || !s.city || !s.state || !s.postalCode) m.push("full business address");
  if (!s.startDate) m.push("business start date");
  if (!s.contactName) m.push("contact name");
  if (!s.contactEmail) m.push("contact email");
  if (!s.contactPhone) m.push("contact phone");
  if (!s.payroll) m.push("payroll (yes or no)");
  if (s.payroll === "YES" && (!s.payrollProvider || !s.payrollFrequency)) m.push("payroll provider and frequency");
  if (!(s.accounts ?? []).some((a) => !a.remove)) m.push("at least one business bank or credit-card account");
  return m;
}

// --- Eligibility -------------------------------------------------------------------

export async function saveEligibility(user: PortalActor, clientId: string, relationship: string, wantsBookkeeping: string) {
  await ownerAccess(user, clientId);
  if (!(relationship in RELATIONSHIPS)) throw new ValidationError("Please choose whether you're an existing or potential client.");
  if (wantsBookkeeping !== "yes" && wantsBookkeeping !== "no") throw new ValidationError("Please choose whether you're a bookkeeping client or requesting bookkeeping services.");
  const data = { relationship, wantsBookkeeping: wantsBookkeeping === "yes", updatedByPortalId: user.id };
  await prisma.businessOnboarding.upsert({ where: { clientId }, create: { clientId, ...data }, update: data });
  await prisma.auditLog.create({ data: { action: "onboarding.eligibility_saved", entityType: "Client", entityId: clientId, clientId, details: { relationship, wantsBookkeeping: data.wantsBookkeeping, portalUserId: user.id } } });
}

// --- Draft, submit, update -------------------------------------------------------

async function verifiedEin(clientId: string) {
  const p = await prisma.bookkeepingProfile.findUnique({ where: { clientId }, select: { einEncrypted: true, einLast4: true, einHash: true } });
  return p ? { encrypted: p.einEncrypted, last4: p.einLast4, hash: p.einHash } : undefined;
}

/** Save & Continue Later. Only before the first submission; afterwards changes go through Update Information. */
export async function saveDraft(user: PortalActor, clientId: string, form: BusinessForm) {
  await ownerAccess(user, clientId);
  const ob = await prisma.businessOnboarding.findUnique({ where: { clientId } });
  if (!ob?.wantsBookkeeping) throw new ValidationError("Answer the two questions first.");
  if (ob.status === "SUBMITTED") throw new ValidationError("Your information was already submitted. Use Update Information to send changes.");
  const prevDraft = (ob.draft ?? {}) as Stored;
  const stored = prepare(form, { strict: false, existingEin: prevDraft.einEncrypted ? { encrypted: prevDraft.einEncrypted, last4: prevDraft.einLast4 ?? null, hash: prevDraft.einHash ?? null } : undefined });
  await prisma.businessOnboarding.update({ where: { clientId }, data: { draft: stored as Prisma.InputJsonValue, status: "DRAFT", updatedByPortalId: user.id } });
  await prisma.auditLog.create({ data: { action: "onboarding.draft_saved", entityType: "Client", entityId: clientId, clientId, details: { portalUserId: user.id } } });
  return missingFields(stored);
}

/**
 * Submits the business information (first time) or an update. It waits for an
 * Admin; nothing verified changes until then. A newer update replaces one
 * still waiting. Possible duplicate businesses are flagged for the Admin only.
 */
export async function submitBusinessInfo(user: PortalActor, clientId: string, form: BusinessForm) {
  await ownerAccess(user, clientId);
  const ob = await prisma.businessOnboarding.findUnique({ where: { clientId } });
  if (!ob?.wantsBookkeeping) throw new ValidationError("Answer the two questions first.");
  const pending = await prisma.businessInfoChange.findFirst({ where: { clientId, status: "PENDING" }, orderBy: { submittedAt: "desc" } });
  const draft = (ob.draft ?? {}) as Stored;
  const pendingData = (pending?.data ?? {}) as Stored;
  // A blank EIN keeps the one already given (verified, waiting, or in the draft).
  const keep = await verifiedEin(clientId);
  const existingEin = pendingData.einEncrypted ? { encrypted: pendingData.einEncrypted, last4: pendingData.einLast4 ?? null, hash: pendingData.einHash ?? null } : keep?.encrypted ? keep : draft.einEncrypted ? { encrypted: draft.einEncrypted, last4: draft.einLast4 ?? null, hash: draft.einHash ?? null } : undefined;
  // Updates may refer only to this client's own accounts.
  const ownIds = new Set((await prisma.bookkeepingAccount.findMany({ where: { clientId }, select: { id: true } })).map((a) => a.id));
  for (const a of form.accounts ?? []) if (a.id && !ownIds.has(a.id)) throw new ForbiddenError();
  const stored = prepare(form, { strict: true, existingEin });
  const dupes = await possibleDuplicates(clientId, stored);
  const kind = ob.status === "SUBMITTED" ? "UPDATE" : "INITIAL";
  const change = await prisma.$transaction(async (tx) => {
    await tx.businessInfoChange.updateMany({ where: { clientId, status: "PENDING" }, data: { status: "SUPERSEDED" } });
    const c = await tx.businessInfoChange.create({ data: { clientId, kind, data: stored as Prisma.InputJsonValue, possibleDuplicateIds: dupes, submittedByPortalId: user.id } });
    await tx.businessOnboarding.update({ where: { clientId }, data: { status: "SUBMITTED", submittedAt: ob.submittedAt ?? new Date(), draft: Prisma.DbNull, updatedByPortalId: user.id } });
    await tx.auditLog.create({ data: { action: kind === "INITIAL" ? "onboarding.submitted" : "onboarding.update_submitted", entityType: "BusinessInfoChange", entityId: c.id, clientId, details: { portalUserId: user.id, possibleDuplicates: dupes.length } } });
    return c;
  });
  await notifyAdmins(clientId, change.id, kind, dupes.length > 0);
  return change;
}

async function possibleDuplicates(clientId: string, s: Stored) {
  const or: Prisma.BookkeepingProfileWhereInput[] = [];
  if (s.einHash) or.push({ einHash: s.einHash });
  if (s.legalName) or.push({ legalName: { equals: s.legalName, mode: "insensitive" } });
  const profiles = or.length ? await prisma.bookkeepingProfile.findMany({ where: { clientId: { not: clientId }, OR: or }, select: { clientId: true } }) : [];
  const clients = s.legalName ? await prisma.client.findMany({ where: { id: { not: clientId }, businessName: { equals: s.legalName, mode: "insensitive" } }, select: { id: true } }) : [];
  return [...new Set([...profiles.map((p) => p.clientId), ...clients.map((c) => c.id)])];
}

/** A review task for the Admins (assigned to the client's staff member when there is one). */
async function notifyAdmins(clientId: string, changeId: string, kind: string, dupes: boolean) {
  const client = await prisma.client.findUniqueOrThrow({ where: { id: clientId }, select: { displayName: true, assignedToId: true } });
  const admin = await prisma.user.findFirst({ where: { role: "ADMIN", active: true }, orderBy: { createdAt: "asc" }, select: { id: true } });
  if (!admin) return;
  await prisma.task.create({
    data: {
      title: `Review ${kind === "INITIAL" ? "business onboarding" : "business information update"} — ${client.displayName}`,
      details: `Submitted by the client in the portal. Open Bookkeeping Clients → Onboarding review to approve or return it.${dupes ? " Possible duplicate business record — check before approving." : ""} [change:${changeId}]`,
      clientId,
      assigneeId: client.assignedToId,
      createdById: admin.id,
      priority: dupes ? "HIGH" : "NORMAL",
    },
  });
}

// --- Admin review ---------------------------------------------------------------------

/** Approves (applies to the verified profile and accounts) or returns a submission. Admins only. */
export async function reviewBusinessChange(actor: Actor, changeId: string, decision: "approve" | "reject", note?: string) {
  assertAdmin(actor);
  const change = await prisma.businessInfoChange.findUnique({ where: { id: changeId } });
  if (!change || change.status !== "PENDING") throw new ValidationError("This submission isn't waiting for review.");
  if (decision === "reject") {
    if (!note?.trim()) throw new ValidationError("Tell the client what needs to change.");
    await prisma.businessInfoChange.update({ where: { id: changeId }, data: { status: "REJECTED", reviewedById: actor.id, reviewedAt: new Date(), reviewNote: note.trim().slice(0, 500) } });
    await audit(prisma, { actorId: actor.id, action: "onboarding.change_returned", entityType: "BusinessInfoChange", entityId: changeId, clientId: change.clientId });
    return;
  }
  const s = change.data as Stored;
  const clientId = change.clientId;
  const profileData = {
    legalName: s.legalName || null,
    dba: s.dba || null,
    ...(s.einEncrypted ? { einEncrypted: s.einEncrypted, einLast4: s.einLast4 ?? null, einHash: s.einHash ?? null } : {}),
    businessAddress1: s.address1 || null,
    businessAddress2: s.address2 || null,
    businessCity: s.city || null,
    businessState: s.state || null,
    businessPostalCode: s.postalCode || null,
    businessStartDate: s.startDate ? new Date(`${s.startDate}T12:00:00`) : null,
    contactName: s.contactName || null,
    contactEmail: s.contactEmail ? normalizeEmail(s.contactEmail) : null,
    contactPhone: s.contactPhone || null,
    payroll: s.payroll === "YES",
    payrollProvider: s.payroll === "YES" ? s.payrollProvider || null : null,
    payrollFrequency: s.payroll === "YES" ? s.payrollFrequency || null : null,
    verifiedAt: new Date(),
    verifiedById: actor.id,
    updatedById: actor.id,
  };
  await prisma.$transaction(async (tx) => {
    // A client who isn't on the Bookkeeping Clients list yet gets a paused profile; staff enroll them separately.
    await tx.bookkeepingProfile.upsert({ where: { clientId }, create: { clientId, active: false, frequency: "MONTHLY", ...profileData }, update: profileData });
    for (const a of s.accounts ?? []) {
      if (a.id) {
        const own = await tx.bookkeepingAccount.findFirst({ where: { id: a.id, clientId } });
        if (!own) continue;
        await tx.bookkeepingAccount.update({ where: { id: a.id }, data: a.remove ? { active: false, updatedById: actor.id } : { institution: a.institution, accountType: a.accountType, last4: a.last4, accessMethod: a.accessMethod, updatedById: actor.id } });
      } else if (!a.remove) {
        await tx.bookkeepingAccount.create({ data: { clientId, institution: a.institution, accountType: a.accountType, last4: a.last4, accessMethod: a.accessMethod, accessStatus: a.accessMethod === "STATEMENT_UPLOAD" ? "STATEMENTS_ONLY" : "REQUESTED", updatedById: actor.id } });
      }
    }
    await tx.businessInfoChange.update({ where: { id: changeId }, data: { status: "APPROVED", reviewedById: actor.id, reviewedAt: new Date(), reviewNote: note?.trim() || null } });
    await tx.auditLog.create({ data: { actorId: actor.id, action: "onboarding.change_approved", entityType: "BusinessInfoChange", entityId: changeId, clientId } });
  });
}

/** Submissions waiting for an Admin, newest first. */
export function pendingBusinessChanges() {
  return prisma.businessInfoChange.findMany({ where: { status: "PENDING" }, include: { client: { select: { id: true, displayName: true } } }, orderBy: { submittedAt: "asc" } });
}

/** For the Admin review screen: proposed values next to the verified ones (EIN masked; Admins can reveal it on the profile). */
export async function changeForReview(actor: Actor, changeId: string) {
  assertAdmin(actor);
  const change = await prisma.businessInfoChange.findUniqueOrThrow({ where: { id: changeId }, include: { client: { select: { id: true, displayName: true } } } });
  const [profile, accounts, dupes] = await Promise.all([
    prisma.bookkeepingProfile.findUnique({ where: { clientId: change.clientId } }),
    prisma.bookkeepingAccount.findMany({ where: { clientId: change.clientId } }),
    prisma.client.findMany({ where: { id: { in: change.possibleDuplicateIds } }, select: { id: true, displayName: true } }),
  ]);
  const s = change.data as Stored;
  return { change, proposed: { ...s, einEncrypted: undefined, einHash: undefined, ein: maskEin(s.einLast4) }, profile, accounts, dupes, einFull: s.einEncrypted ? decryptSecret(s.einEncrypted) : null };
}

// --- Client view ------------------------------------------------------------------------

/** What the client sees: verified details (masked), anything waiting for review, pricing, card and checklist. */
export async function clientOnboardingView(user: PortalActor, clientId: string) {
  const access = await requireClientAccess(user.id, clientId);
  const [ob, profile, accounts, pending, lastReturned, billing, auth, existingSquare] = await Promise.all([
    prisma.businessOnboarding.findUnique({ where: { clientId } }),
    prisma.bookkeepingProfile.findUnique({ where: { clientId } }),
    prisma.bookkeepingAccount.findMany({ where: { clientId, active: true }, orderBy: { institution: "asc" } }),
    prisma.businessInfoChange.findFirst({ where: { clientId, status: "PENDING" }, orderBy: { submittedAt: "desc" } }),
    prisma.businessInfoChange.findFirst({ where: { clientId, status: "REJECTED" }, orderBy: { reviewedAt: "desc" } }),
    prisma.bookkeepingBilling.findUnique({ where: { clientId } }),
    prisma.recurringChargeAuthorization.findFirst({ where: { clientId, revokedAt: null }, orderBy: { createdAt: "desc" } }),
    squareBillingFor(clientId),
  ]);
  // Already billed through recurring invoices in Square: nothing to set up or authorize again.
  const billedInSquare = existingSquare.state !== "NONE";
  const verified = profile?.verifiedAt
    ? {
        legalName: profile.legalName, dba: profile.dba, ein: maskEin(profile.einLast4), address1: profile.businessAddress1, address2: profile.businessAddress2, city: profile.businessCity, state: profile.businessState, postalCode: profile.businessPostalCode,
        startDate: profile.businessStartDate, contactName: profile.contactName, contactEmail: profile.contactEmail, contactPhone: profile.contactPhone, payroll: profile.payroll, payrollProvider: profile.payrollProvider, payrollFrequency: profile.payrollFrequency,
        accounts: accounts.map((a) => ({ id: a.id, institution: a.institution, accountType: a.accountType, last4: a.last4, accessMethod: a.accessMethod })),
      }
    : null;
  const mask = (s: Stored | null) => (s ? { ...s, einEncrypted: undefined, einHash: undefined, ein: maskEin(s.einLast4) } : null);
  const pendingData = mask((pending?.data as Stored) ?? null);
  const draft = mask((ob?.draft as Stored) ?? null);
  const pricing = billing?.monthlyFeeCents && billing.billingStartDate && billing.billingDay ? { tier: billing.tierName, amountCents: billing.monthlyFeeCents, startDate: billing.billingStartDate, billingDay: billing.billingDay } : null;
  const square = squareSettings();
  const card = square.configured && billing?.squareCardId && billing.cardLast4 ? { brand: billing.cardBrand, last4: billing.cardLast4, expMonth: billing.cardExpMonth, expYear: billing.cardExpYear } : null;
  const authorized = !!(auth && pricing && auth.amountCents === pricing.amountCents && card);
  const checklist = [
    { key: "eligibility", label: "Answer the two questions", done: ob?.wantsBookkeeping != null && !!ob.relationship },
    { key: "submitted", label: "Submit your business information", done: ob?.status === "SUBMITTED" },
    { key: "verified", label: "Business information verified by our office", done: !!verified, pending: !!pending },
    ...(billedInSquare
      ? [{ key: "square", label: "Billing already set up with our office in Square — nothing to authorize again", done: true }]
      : [
          { key: "pricing", label: "Monthly price set by our office", done: !!pricing },
          { key: "card", label: "Payment method saved with Square", done: !!card },
          { key: "authorized", label: "Accept the monthly amount and recurring-payment terms", done: authorized },
        ]),
  ];
  return {
    isOwner: access.role === "OWNER",
    onboarding: ob,
    verified,
    pending: pending ? { id: pending.id, kind: pending.kind, submittedAt: pending.submittedAt, data: pendingData } : null,
    returned: lastReturned && (!pending || lastReturned.reviewedAt! > pending.submittedAt) ? { note: lastReturned.reviewNote, at: lastReturned.reviewedAt } : null,
    draft,
    pricing,
    square: { configured: square.configured, applicationId: square.applicationId, locationId: square.locationId, sdkUrl: square.sdkUrl },
    card,
    authorization: authorized ? { at: auth!.authorizedAt, name: auth!.authorizedByName, amountCents: auth!.amountCents } : null,
    checklist,
    billedInSquare,
    complete: ob?.wantsBookkeeping === true && checklist.every((c) => c.done),
  };
}

// --- Payment method & recurring authorization ---------------------------------------

/**
 * Saves the card the client entered in Square's hosted fields. Receives only
 * Square's one-time token; stores Square's card id and the masked details
 * Square returns. Replacing a card disables the old one at Square.
 */
export async function savePaymentMethod(user: PortalActor, clientId: string, input: { sourceId: string; cardholderName: string; verificationToken?: string }) {
  await ownerAccess(user, clientId);
  // Clients already billed through recurring invoices in Square are never asked to authorize or add a card again.
  await assertNotBilledInSquare(clientId, "client");
  const square = squareSettings();
  if (!square.configured) throw new ValidationError("Secure card setup isn't available yet because Square isn't connected.");
  if (!input.sourceId || input.sourceId.length > 500) throw new ValidationError("The card form didn't finish. Please try again.");
  const name = t(input.cardholderName, 120);
  if (!name) throw new ValidationError("Enter the cardholder name.");
  const client = await prisma.client.findUniqueOrThrow({ where: { id: clientId }, select: { displayName: true, email: true } });
  const billing = await prisma.bookkeepingBilling.findUnique({ where: { clientId } });
  try {
    let customerId = billing?.squareCustomerId ?? null;
    if (!customerId) {
      const created = await squareRequest<{ customer: { id: string } }>("POST", "/v2/customers", { idempotency_key: randomUUID(), reference_id: clientId, company_name: client.displayName, ...(client.email ? { email_address: client.email } : {}) });
      customerId = created.customer.id;
    }
    const saved = await squareRequest<{ card: SquareCard }>("POST", "/v2/cards", {
      idempotency_key: randomUUID(),
      source_id: input.sourceId,
      ...(input.verificationToken ? { verification_token: input.verificationToken } : {}),
      card: { customer_id: customerId, cardholder_name: name },
    });
    const old = billing?.squareCardId;
    await prisma.bookkeepingBilling.upsert({
      where: { clientId },
      create: { clientId, squareCustomerId: customerId, squareCardId: saved.card.id, cardBrand: saved.card.card_brand ?? null, cardLast4: saved.card.last_4 ?? null, cardExpMonth: saved.card.exp_month ?? null, cardExpYear: saved.card.exp_year ?? null, cardSavedAt: new Date() },
      update: { squareCustomerId: customerId, squareCardId: saved.card.id, cardBrand: saved.card.card_brand ?? null, cardLast4: saved.card.last_4 ?? null, cardExpMonth: saved.card.exp_month ?? null, cardExpYear: saved.card.exp_year ?? null, cardSavedAt: new Date() },
    });
    if (old && old !== saved.card.id) await squareRequest("POST", `/v2/cards/${encodeURIComponent(old)}/disable`).catch(() => {});
    // Logged without any card data or token.
    await prisma.auditLog.create({ data: { action: old ? "billing.payment_method_replaced" : "billing.payment_method_saved", entityType: "Client", entityId: clientId, clientId, details: { portalUserId: user.id, brand: saved.card.card_brand ?? null, last4: saved.card.last_4 ?? null } } });
    return saved.card;
  } catch (err) {
    if (err instanceof SquareError) throw new ValidationError(err.message);
    throw err;
  }
}

export const termsText = (p: { amountCents: number; billingDay: number; startDate: Date }, last4: string) =>
  `I authorize TTurner & Associates to charge $${(p.amountCents / 100).toFixed(2)} each month for bookkeeping services, on day ${p.billingDay} of each month beginning ${p.startDate.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "America/Chicago" })}, to my card ending in ${last4}, until I cancel in writing or through the portal. If the monthly amount changes, I'll be asked to accept the new amount first.`;

/** The client accepts the actual monthly amount and terms. Requires the Admin-set price and a card saved with Square. */
export async function acceptRecurringTerms(user: PortalActor, clientId: string, input: { agree: boolean; typedName: string }) {
  await ownerAccess(user, clientId);
  // Clients already billed through recurring invoices in Square are never asked to authorize or add a card again.
  await assertNotBilledInSquare(clientId, "client");
  const billing = await prisma.bookkeepingBilling.findUnique({ where: { clientId } });
  if (!billing?.monthlyFeeCents || !billing.billingStartDate || !billing.billingDay) throw new ValidationError("Your monthly price hasn't been set yet. You can accept it once our office posts it.");
  if (!squareSettings().configured || !billing.squareCardId || !billing.cardLast4) throw new ValidationError("Save a payment method first.");
  if (!input.agree) throw new ValidationError("Check the box to accept the recurring-payment terms.");
  const name = t(input.typedName, 120);
  if (name.length < 3) throw new ValidationError("Type your full name to sign.");
  const text = termsText({ amountCents: billing.monthlyFeeCents, billingDay: billing.billingDay, startDate: billing.billingStartDate }, billing.cardLast4);
  const now = new Date();
  await prisma.$transaction([
    prisma.recurringChargeAuthorization.updateMany({ where: { clientId, revokedAt: null }, data: { revokedAt: now, revokeReason: "Replaced by the client's new acceptance" } }),
    prisma.recurringChargeAuthorization.create({
      data: { clientId, amountCents: billing.monthlyFeeCents, startDate: billing.billingStartDate, method: "PORTAL_CONSENT", authorizedByName: name, authorizedAt: now, recordedById: "portal", authorizedByPortalUserId: user.id, termsText: text, cardLast4: billing.cardLast4 },
    }),
    prisma.auditLog.create({ data: { action: "billing.recurring_terms_accepted", entityType: "Client", entityId: clientId, clientId, details: { portalUserId: user.id, amountCents: billing.monthlyFeeCents } } }),
  ]);
}
