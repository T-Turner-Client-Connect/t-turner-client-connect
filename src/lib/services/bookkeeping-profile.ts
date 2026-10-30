import "server-only";
import { prisma } from "@/lib/prisma";
import { audit } from "@/lib/audit";
import { ForbiddenError, isAdmin, type Actor } from "@/lib/auth/actor";
import { decryptSecret, encryptSecret } from "@/lib/crypto";
import { isValidEmail, normalizeEmail } from "@/lib/normalize";
import { ENTITY_TYPES } from "@/lib/tax/deadlines";
import { ValidationError } from "./clients";
import { isReportApprover } from "./bookkeeping-clients";
import { BASIS } from "@/lib/bookkeeping-periods";
import { squareSettings } from "@/lib/square";

/**
 * Bookkeeping client profiles: business information, payroll, bank and card
 * accounts, monthly billing and reporting periods. Kept apart from the
 * owner's private Owner's Office.
 */

export const PAYROLL_ACCESS = {
  NOT_REQUESTED: "Not requested",
  REQUESTED: "Access requested",
  ACCOUNTANT_ACCESS: "Accountant access granted",
  REPORTS_EMAILED: "Provider emails reports to us",
  CLIENT_UPLOADS: "Client uploads reports",
} as const;
export const PAYROLL_REPORT_TYPES = {
  PAYROLL_REGISTER: "Payroll register / summary",
  TAX_LIABILITY: "Payroll tax liability report",
  EMPLOYEE_DETAIL: "Employee earnings detail",
  CONTRACTOR_PAYMENTS: "Contractor payments",
  DEDUCTIONS: "Benefits & deductions",
  TAX_FILINGS: "Payroll tax filings (e.g. 941, state)",
} as const;

export const ACCOUNT_TYPES = {
  CHECKING: "Checking",
  SAVINGS: "Savings",
  CREDIT_CARD: "Credit card",
  LINE_OF_CREDIT: "Line of credit",
  LOAN: "Loan",
  MERCHANT: "Merchant / payment processor",
  OTHER: "Other",
} as const;
export const ACCESS_STATUSES = {
  NOT_REQUESTED: { label: "Not requested", tone: "gray" },
  REQUESTED: { label: "Access requested", tone: "amber" },
  DELEGATED_ACCESS: { label: "Accountant access granted", tone: "green" },
  OFFICIAL_CONNECTION: { label: "Official connection", tone: "green" },
  STATEMENTS_ONLY: { label: "Statements uploaded", tone: "navy" },
  REVOKED: { label: "Access removed", tone: "red" },
} as const;

export const BILLING_STATUSES = { NOT_SET_UP: "Not set up", CURRENT: "Current", DUE: "Due", PAST_DUE: "Past due", PAUSED: "Paused" } as const;
export const AUTH_METHODS = { SIGNED_FORM: "Signed authorization form", SIGNED_CONTRACT: "Signed service agreement", PORTAL_CONSENT: "Client consent in the portal" } as const;

const pick = <T extends Record<string, unknown>>(map: T, v: string | null | undefined, msg: string) => {
  if (!v) return null;
  if (!(v in map)) throw new ValidationError(msg);
  return v as keyof T & string;
};
const clean = (v: string | null | undefined, max = 200) => v?.trim().slice(0, max) || null;

// --- Business information -------------------------------------------------------

export type BusinessInput = {
  legalName?: string | null;
  dba?: string | null;
  ein?: string | null; // blank keeps the stored EIN
  businessAddress1?: string | null;
  businessAddress2?: string | null;
  businessCity?: string | null;
  businessState?: string | null;
  businessPostalCode?: string | null;
  businessEmail?: string | null;
  contactName?: string | null;
  contactTitle?: string | null;
  contactPhone?: string | null;
  businessStartDate?: Date | null;
  entityType?: string | null;
  fiscalYearEnd?: number | null;
  workingYear?: number | null;
  accountingBasis?: string | null;
  payrollAccessStatus?: string | null;
  payrollReports?: string[];
};

export function normalizeEin(v: string) {
  const digits = v.replace(/\D/g, "");
  if (digits.length !== 9) throw new ValidationError("An EIN has 9 digits (12-3456789).");
  return `${digits.slice(0, 2)}-${digits.slice(2)}`;
}
export const maskEin = (last4: string | null | undefined) => (last4 ? `XX-XXX${last4}` : null);

/** Saves business details. Staff can enter or replace an EIN; only Admins can read it back. */
export async function saveBusinessInfo(actor: Actor, clientId: string, input: BusinessInput) {
  const profile = await prisma.bookkeepingProfile.findUnique({ where: { clientId } });
  if (!profile) throw new ValidationError("Add this client to Bookkeeping Clients first.");
  if (input.businessEmail && !isValidEmail(input.businessEmail)) throw new ValidationError("The business email doesn't look right.");
  const thisYear = new Date().getFullYear();
  if (input.workingYear != null && (input.workingYear < 2000 || input.workingYear > thisYear + 1)) throw new ValidationError("Choose a working year.");
  if (input.fiscalYearEnd != null && (input.fiscalYearEnd < 1 || input.fiscalYearEnd > 12)) throw new ValidationError("Choose the month the fiscal year ends.");
  if (input.businessStartDate && input.businessStartDate > new Date()) throw new ValidationError("The business start date can't be in the future.");
  const entityType = pick(ENTITY_TYPES, input.entityType, "Choose an entity type.");
  const basis = pick(BASIS, input.accountingBasis, "Choose cash, accrual or modified cash basis.");
  const payrollAccess = pick(PAYROLL_ACCESS, input.payrollAccessStatus, "Choose the payroll access status.");
  const reports = (input.payrollReports ?? []).filter((r) => r in PAYROLL_REPORT_TYPES);
  const ein = input.ein?.trim() ? normalizeEin(input.ein) : null;
  await prisma.$transaction([
    prisma.bookkeepingProfile.update({
      where: { clientId },
      data: {
        legalName: clean(input.legalName),
        dba: clean(input.dba),
        businessAddress1: clean(input.businessAddress1),
        businessAddress2: clean(input.businessAddress2),
        businessCity: clean(input.businessCity, 80),
        businessState: clean(input.businessState, 2)?.toUpperCase() ?? null,
        businessPostalCode: clean(input.businessPostalCode, 10),
        businessEmail: input.businessEmail ? normalizeEmail(input.businessEmail) : null,
        contactName: clean(input.contactName, 120),
        contactTitle: clean(input.contactTitle, 80),
        contactPhone: clean(input.contactPhone, 30),
        businessStartDate: input.businessStartDate ?? null,
        workingYear: input.workingYear ?? null,
        accountingBasis: basis,
        payrollAccessStatus: profile.payroll ? payrollAccess : null,
        payrollReports: profile.payroll ? reports : [],
        ...(ein ? { einEncrypted: encryptSecret(ein), einLast4: ein.slice(-4) } : {}),
        updatedById: actor.id,
      },
    }),
    prisma.client.update({ where: { id: clientId }, data: { entityType, fiscalYearEnd: input.fiscalYearEnd ?? null } }),
  ]);
  await audit(prisma, { actorId: actor.id, action: "bookkeeping.business_info_saved", entityType: "Client", entityId: clientId, clientId, details: { einChanged: !!ein } });
}

/** The full EIN, for Admins only. Every view is written to the audit log. */
export async function revealEin(actor: Actor, clientId: string) {
  if (!isAdmin(actor)) throw new ForbiddenError("Only an Admin can view the full EIN.");
  const p = await prisma.bookkeepingProfile.findUnique({ where: { clientId }, select: { einEncrypted: true } });
  if (!p?.einEncrypted) throw new ValidationError("No EIN on file.");
  await audit(prisma, { actorId: actor.id, action: "bookkeeping.ein_viewed", entityType: "Client", entityId: clientId, clientId });
  return decryptSecret(p.einEncrypted);
}

// --- Bank & card accounts -----------------------------------------------------------

// Words that suggest someone is trying to save a credential in an ordinary field.
const SECRET_HINT = /\b(password|passcode|pass\s*word|pwd|pin|security (question|answer)|verification code|one[- ]time code|otp|username\s*[:=])\b/i;

export type AccountInput = { institution: string; accountType: string; last4?: string | null; nickname?: string | null; loginUrl?: string | null; accessStatus?: string | null; accessNote?: string | null; active?: boolean };

function checkAccount(input: AccountInput) {
  if (!input.institution?.trim()) throw new ValidationError("Enter the bank or card company.");
  if (!(input.accountType in ACCOUNT_TYPES)) throw new ValidationError("Choose the account type.");
  const last4 = input.last4?.trim() || null;
  if (last4 && !/^\d{4}$/.test(last4)) throw new ValidationError("Enter only the last 4 digits of the account number.");
  let loginUrl: string | null = null;
  if (input.loginUrl?.trim()) {
    let u: URL;
    try {
      u = new URL(input.loginUrl.trim());
    } catch {
      throw new ValidationError("Enter the bank's sign-in page address, starting with https://");
    }
    if (u.protocol !== "https:") throw new ValidationError("Only secure (https://) sign-in pages can be saved.");
    if (u.username || u.password || u.search || u.hash) throw new ValidationError("Save only the sign-in page address, without usernames, codes or other details.");
    loginUrl = u.toString();
  }
  for (const v of [input.nickname, input.accessNote, input.institution]) {
    if (v && SECRET_HINT.test(v)) throw new ValidationError("Don't save passwords, PINs, security answers or codes here. Use the bank's accountant access or statement uploads instead.");
  }
  const status = input.accessStatus || "NOT_REQUESTED";
  if (!(status in ACCESS_STATUSES)) throw new ValidationError("Choose the access status.");
  return { institution: input.institution.trim().slice(0, 120), accountType: input.accountType, last4, nickname: clean(input.nickname, 80), loginUrl, accessStatus: status, accessNote: clean(input.accessNote, 300), active: input.active ?? true };
}

export async function saveAccount(actor: Actor, clientId: string, accountId: string | null, input: AccountInput) {
  const data = checkAccount(input);
  if (accountId) {
    const existing = await prisma.bookkeepingAccount.findFirst({ where: { id: accountId, clientId } });
    if (!existing) throw new ValidationError("Account not found.");
    await prisma.bookkeepingAccount.update({ where: { id: accountId }, data: { ...data, updatedById: actor.id } });
  } else {
    const created = await prisma.bookkeepingAccount.create({ data: { clientId, ...data, updatedById: actor.id } });
    accountId = created.id;
  }
  await audit(prisma, { actorId: actor.id, action: "bookkeeping.account_saved", entityType: "BookkeepingAccount", entityId: accountId, clientId, details: { institution: data.institution, last4: data.last4, accessStatus: data.accessStatus } });
  return accountId;
}

export const accountLabel = (a: { institution: string; accountType: string; last4: string | null; nickname?: string | null }) =>
  `${a.nickname || a.institution} ${ACCOUNT_TYPES[a.accountType as keyof typeof ACCOUNT_TYPES]?.toLowerCase() ?? ""}${a.last4 ? ` ****${a.last4}` : ""}`.replace(/\s+/g, " ").trim();

// --- Billing (Tabitha, or staff she allows) --------------------------------------------

/** Square is "connected" only once the integration is configured; until then card details are never shown. */
export const squareConnected = () => squareSettings().configured;

export async function canManageBilling(actor: Actor) {
  if (await isReportApprover(actor)) return true;
  const u = await prisma.user.findUnique({ where: { id: actor.id }, select: { bookkeepingBillingAccess: true, active: true } });
  return !!(u?.active && u.bookkeepingBillingAccess);
}
async function assertBilling(actor: Actor) {
  if (!(await canManageBilling(actor))) throw new ForbiddenError("Only Tabitha (or staff she allows) can view or change bookkeeping billing.");
}

/** Tabitha alone grants or removes billing access. It doesn't open the Owner's Office. */
export async function setBillingAccess(actor: Actor, userId: string, allowed: boolean) {
  if (!(await isReportApprover(actor))) throw new ForbiddenError("Only Tabitha can change who manages bookkeeping billing.");
  const target = await prisma.user.findUnique({ where: { id: userId } });
  if (!target || target.id === actor.id) throw new ValidationError("Choose a staff member.");
  await prisma.user.update({ where: { id: userId }, data: { bookkeepingBillingAccess: allowed, bookkeepingBillingGrantedBy: allowed ? actor.id : null, bookkeepingBillingGrantedAt: allowed ? new Date() : null } });
  await audit(prisma, { actorId: actor.id, action: allowed ? "bookkeeping.billing_access_granted" : "bookkeeping.billing_access_removed", entityType: "User", entityId: userId });
}

export type BillingInput = { tierName?: string | null; monthlyFee?: string | null; billingStartDate?: Date | null; billingDay?: number | null; paymentStatus?: string | null; squareCustomerId?: string | null; notes?: string | null };

export async function saveBilling(actor: Actor, clientId: string, input: BillingInput) {
  await assertBilling(actor);
  let cents: number | null = null;
  if (input.monthlyFee?.trim()) {
    const n = Number(input.monthlyFee.replace(/[$,\s]/g, ""));
    if (!Number.isFinite(n) || n < 0 || n > 100000) throw new ValidationError("Enter the monthly charge in dollars, e.g. 350.00.");
    cents = Math.round(n * 100);
  }
  if (input.billingDay != null && (!Number.isInteger(input.billingDay) || input.billingDay < 1 || input.billingDay > 28)) throw new ValidationError("Choose a billing day from 1 to 28.");
  const status = input.paymentStatus || "NOT_SET_UP";
  if (!(status in BILLING_STATUSES)) throw new ValidationError("Choose the payment status.");
  const squareCustomerId = clean(input.squareCustomerId, 64);
  // Square ids are letters, digits, hyphens and underscores. Anything that looks like a card number is refused.
  if (squareCustomerId && (!/^[A-Za-z0-9_-]+$/.test(squareCustomerId) || /\d{12,}/.test(squareCustomerId))) throw new ValidationError("Enter the Square customer ID (letters and numbers from Square), never a card number.");
  if (input.notes && /\b(?:\d[ -]?){13,19}\b/.test(input.notes)) throw new ValidationError("Card numbers can't be saved. Payment methods are kept only in Square.");
  const data = { tierName: clean(input.tierName, 60), monthlyFeeCents: cents, billingStartDate: input.billingStartDate ?? null, billingDay: input.billingDay ?? null, paymentStatus: status, squareCustomerId, notes: clean(input.notes, 500), updatedById: actor.id };
  await prisma.bookkeepingBilling.upsert({ where: { clientId }, create: { clientId, ...data }, update: data });
  await audit(prisma, { actorId: actor.id, action: "bookkeeping.billing_saved", entityType: "Client", entityId: clientId, clientId, details: { monthlyFeeCents: cents, paymentStatus: status } });
}

export type AuthorizationInput = { amount: string; startDate: Date | null; method: string; authorizedByName: string; authorizedAt: Date | null; evidenceDocumentId?: string | null };

/** Records the client's authorization for recurring charges (evidence required). */
export async function recordChargeAuthorization(actor: Actor, clientId: string, input: AuthorizationInput) {
  await assertBilling(actor);
  const n = Number(input.amount.replace(/[$,\s]/g, ""));
  if (!Number.isFinite(n) || n <= 0) throw new ValidationError("Enter the authorized monthly amount.");
  if (!(input.method in AUTH_METHODS)) throw new ValidationError("Choose how the client authorized recurring charges.");
  if (!input.authorizedByName.trim()) throw new ValidationError("Enter who authorized the charges.");
  if (!input.authorizedAt || !input.startDate) throw new ValidationError("Enter the authorization date and the first charge date.");
  if (input.authorizedAt > new Date()) throw new ValidationError("The authorization date can't be in the future.");
  if (input.method !== "PORTAL_CONSENT") {
    if (!input.evidenceDocumentId) throw new ValidationError("Attach the signed authorization or agreement (choose it from this client's documents).");
    const doc = await prisma.document.findFirst({ where: { id: input.evidenceDocumentId, clientId, deletedAt: null } });
    if (!doc) throw new ValidationError("That document isn't in this client's file.");
  }
  // One active authorization at a time: a new one replaces the old.
  const now = new Date();
  const [, created] = await prisma.$transaction([
    prisma.recurringChargeAuthorization.updateMany({ where: { clientId, revokedAt: null }, data: { revokedAt: now, revokedById: actor.id, revokeReason: "Replaced by a new authorization" } }),
    prisma.recurringChargeAuthorization.create({
      data: { clientId, amountCents: Math.round(n * 100), startDate: input.startDate, method: input.method, authorizedByName: input.authorizedByName.trim().slice(0, 120), authorizedAt: input.authorizedAt, evidenceDocumentId: input.evidenceDocumentId || null, recordedById: actor.id },
    }),
  ]);
  await audit(prisma, { actorId: actor.id, action: "bookkeeping.charge_authorization_recorded", entityType: "RecurringChargeAuthorization", entityId: created.id, clientId, details: { amountCents: created.amountCents, method: created.method } });
  return created;
}

export async function revokeChargeAuthorization(actor: Actor, clientId: string, id: string, reason: string) {
  await assertBilling(actor);
  if (!reason.trim()) throw new ValidationError("Record why the authorization ended.");
  const a = await prisma.recurringChargeAuthorization.findFirst({ where: { id, clientId, revokedAt: null } });
  if (!a) throw new ValidationError("Active authorization not found.");
  await prisma.recurringChargeAuthorization.update({ where: { id }, data: { revokedAt: new Date(), revokedById: actor.id, revokeReason: reason.trim().slice(0, 300) } });
  await audit(prisma, { actorId: actor.id, action: "bookkeeping.charge_authorization_revoked", entityType: "RecurringChargeAuthorization", entityId: id, clientId });
}

/** What the billing card may show. Card brand/last four/expiration come only from Square — never stored here. */
export async function billingView(actor: Actor, clientId: string) {
  if (!(await canManageBilling(actor))) return { allowed: false as const };
  const [billing, authorizations] = await Promise.all([
    prisma.bookkeepingBilling.findUnique({ where: { clientId } }),
    prisma.recurringChargeAuthorization.findMany({ where: { clientId }, orderBy: { createdAt: "desc" } }),
  ]);
  const active = authorizations.find((a) => !a.revokedAt) ?? null;
  const connected = squareConnected();
  // Card details only as Square returned them, and only while Square is connected.
  const card = connected && billing?.squareCardId && billing.cardLast4 ? { brand: billing.cardBrand ?? "Card", last4: billing.cardLast4, expMonth: billing.cardExpMonth ?? 0, expYear: billing.cardExpYear ?? 0 } : null;
  return {
    allowed: true as const,
    billing,
    authorizations,
    active,
    square: { connected, card, cardId: connected ? billing?.squareCardId ?? null : null },
    // A charge may run only with an active authorization for the current amount; a card on file alone is not enough.
    chargeAuthorized: !!active && active.amountCents === billing?.monthlyFeeCents,
  };
}
