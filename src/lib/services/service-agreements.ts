import "server-only";
import type { AgreementKind, ClientService, PricingAgreement, ServiceStatus, ServiceType } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { audit } from "@/lib/audit";
import { ForbiddenError, type Actor } from "@/lib/auth/actor";
import { assertOwner, ownerAudit } from "@/lib/auth/owner";
import type { PortalActor } from "@/lib/portal/session";
import { requireClientAccess } from "@/lib/portal/access";
import { OFFICE_TZ } from "@/lib/dates";
import { CARD_SURCHARGE_CAP_BPS, FEE_SETTING_KEYS, PAYMENT_METHODS, quoteAll, type FeeSetting, type FeeSettingKey, type MethodKey } from "@/lib/billing/payment-fees";
import { AGREEMENT_TITLES, CONSENT_TEXT, termsHash, type AgreementSelection, type AgreementTerms } from "@/lib/billing/agreement-terms";
import { renderAgreementPdf } from "@/lib/billing/agreement-pdf";
import { ValidationError } from "./clients";
import { retentionDate, storeDocumentFile } from "./documents";
import { queuePortalNotification } from "./notifications";

/**
 * Billable services and their pricing agreements. Each service (a tax return
 * for one year, bookkeeping for a period, a formation…) has its own status,
 * staff and agreement. Work can't be marked In Progress until the client has
 * signed the current agreement and any required payment authorization is
 * recorded — unless the owner overrides with a logged reason. A signed
 * agreement is never edited: any change is a new version the client signs again.
 */

export const BUSINESS_NAME = "T. Turner & Associates, LLC";

export const SERVICE_TYPES: Record<ServiceType, { label: string; tax: boolean }> = {
  TAX_INDIVIDUAL: { label: "Individual tax return", tax: true },
  TAX_BUSINESS: { label: "Business tax return", tax: true },
  TAX_AMENDED: { label: "Amended tax return", tax: true },
  TAX_NONPROFIT: { label: "Nonprofit tax return", tax: true },
  BOOKKEEPING: { label: "Bookkeeping", tax: false },
  PAYROLL: { label: "Payroll", tax: false },
  NONPROFIT_SERVICES: { label: "Nonprofit services", tax: false },
  BUSINESS_FORMATION: { label: "Business formation", tax: false },
  CONSULTING: { label: "Consulting", tax: false },
  PROPERTY_MANAGEMENT: { label: "Property management", tax: false },
  IRS_CORRESPONDENCE: { label: "IRS correspondence", tax: true },
  OTHER: { label: "Other service", tax: false },
};

export const SERVICE_STATUS: Record<ServiceStatus, string> = {
  AGREEMENT_PENDING: "Agreement Pending",
  AGREEMENT_SENT: "Agreement Sent",
  AGREEMENT_VIEWED: "Agreement Viewed",
  AGREEMENT_SIGNED: "Agreement Signed",
  AWAITING_PAYMENT_AUTHORIZATION: "Awaiting Payment Authorization",
  APPROVED_TO_BEGIN: "Approved to Begin",
  IN_PROGRESS: "In Progress",
  COMPLETED: "Completed",
  CLOSED: "Closed",
};

export const DEFAULT_PAYMENT_TERMS = "Payment is due as stated on your invoice. Any fee for the payment method you choose is shown above and included in your total. Prices and fees can't change without a revised agreement that you sign.";

const thisYear = () => new Date().getFullYear();

async function client(clientId: string) {
  const c = await prisma.client.findUnique({ where: { id: clientId }, select: { id: true, displayName: true, businessName: true, clientType: true, archivedAt: true } });
  if (!c || c.archivedAt) throw new ValidationError("Client not found.");
  return c;
}

// --- Fee settings (owner only) ----------------------------------------------

export async function feeSettings(): Promise<(FeeSetting & { verifiedNote: string | null })[]> {
  return prisma.paymentFeeSetting.findMany();
}

/**
 * Turn a method's fee on or off. Turning one on requires a note on how it was
 * verified as permitted (card-network rules, state law, processor terms). The
 * card surcharge is stored as entered but never applied above the 3% cap.
 */
export async function saveFeeSetting(actor: Actor, input: { method: string; enabled: boolean; percentBps: number; flatCents: number; verifiedNote?: string; providerName?: string }) {
  await assertOwner(actor, "full");
  if (!(FEE_SETTING_KEYS as readonly string[]).includes(input.method)) throw new ValidationError("Choose a payment method that can carry a fee.");
  const key = input.method as FeeSettingKey;
  if (!Number.isInteger(input.percentBps) || input.percentBps < 0 || input.percentBps > 1000) throw new ValidationError("Enter a percentage from 0 to 10.");
  if (!Number.isInteger(input.flatCents) || input.flatCents < 0 || input.flatCents > 10_000) throw new ValidationError("Enter a flat fee from $0 to $100.");
  if (key === "CARD_CREDIT" && input.flatCents) throw new ValidationError("A card surcharge is a percentage only.");
  if (key === "REFUND_TRANSFER" && input.enabled && !input.providerName?.trim()) throw new ValidationError("Name the refund-transfer provider (the bank product offered through your tax software).");
  if (input.enabled && (!input.verifiedNote || input.verifiedNote.trim().length < 10)) throw new ValidationError("Record how you verified this fee is permitted (card-network rules, state law, processor terms) before turning it on.");
  const before = await prisma.paymentFeeSetting.findUnique({ where: { method: key } });
  const data = {
    enabled: input.enabled,
    percentBps: key === "REFUND_TRANSFER" ? 0 : input.percentBps,
    flatCents: key === "REFUND_TRANSFER" ? 0 : input.flatCents,
    verifiedNote: input.enabled ? input.verifiedNote!.trim().slice(0, 500) : before?.verifiedNote ?? null,
    verifiedAt: input.enabled ? new Date() : null,
    verifiedById: input.enabled ? actor.id : null,
    providerName: input.providerName?.trim().slice(0, 80) || null,
  };
  await prisma.paymentFeeSetting.upsert({ where: { method: key }, create: { method: key, ...data }, update: data });
  // Owner's Office activity goes to the owner's private log, not the shared staff log.
  await ownerAudit(actor.id, "billing.fee_setting_saved", "PaymentFeeSetting", key, { before: before && { enabled: before.enabled, percentBps: before.percentBps, flatCents: before.flatCents }, after: { enabled: data.enabled, percentBps: data.percentBps, flatCents: data.flatCents }, appliedCardCapBps: key === "CARD_CREDIT" ? Math.min(data.percentBps, CARD_SURCHARGE_CAP_BPS) : undefined });
}

// --- Services -----------------------------------------------------------------

export async function createService(actor: Actor, input: { clientId: string; type: string; taxYear?: number | null; periodLabel?: string; title?: string; description?: string; assignedToId?: string | null; requiresPaymentAuth?: boolean }) {
  const c = await client(input.clientId);
  if (!(input.type in SERVICE_TYPES)) throw new ValidationError("Choose the service.");
  const type = input.type as ServiceType;
  const def = SERVICE_TYPES[type];
  const taxYear = input.taxYear ?? null;
  if (def.tax && (!taxYear || taxYear < 2000 || taxYear > thisYear() + 1)) throw new ValidationError("Choose the tax year for this service.");
  if (!def.tax && !taxYear && !input.periodLabel?.trim()) throw new ValidationError("Enter the service period (for example, “January–December 2026”) or a tax year.");
  if (input.assignedToId && !(await prisma.user.count({ where: { id: input.assignedToId, active: true } }))) throw new ValidationError("Choose an active staff member.");
  const title = input.title?.trim() || `${taxYear ?? input.periodLabel?.trim()} ${def.label}`;
  const s = await prisma.clientService.create({
    data: { clientId: c.id, type, taxYear, periodLabel: input.periodLabel?.trim().slice(0, 80) || null, title: title.slice(0, 120), description: input.description?.trim().slice(0, 1000) || null, assignedToId: input.assignedToId || null, requiresPaymentAuth: !!input.requiresPaymentAuth, createdById: actor.id },
  });
  await audit(prisma, { actorId: actor.id, action: "service.created", entityType: "ClientService", entityId: s.id, clientId: c.id, details: { type, taxYear, title: s.title } });
  return s;
}

export async function clientServices(clientId: string) {
  return prisma.clientService.findMany({
    where: { clientId },
    include: { assignedTo: { select: { id: true, name: true } }, agreements: { orderBy: { version: "desc" } } },
    orderBy: [{ taxYear: "desc" }, { createdAt: "desc" }],
  });
}

const latest = (agreements: PricingAgreement[]) => [...agreements].sort((a, b) => b.version - a.version)[0] ?? null;
const signedCurrent = (agreements: PricingAgreement[]) => agreements.find((a) => a.status === "SIGNED") ?? null;

/** Whether work may begin, and why not. */
export function startGate(s: ClientService & { agreements: PricingAgreement[] }) {
  if (s.overrideAt) return { ok: true as const, reason: `Owner override: ${s.overrideReason}` };
  const pending = latest(s.agreements);
  if (!signedCurrent(s.agreements)) return { ok: false as const, reason: "The client hasn't signed the pricing agreement." };
  if (pending && pending.status !== "SIGNED" && pending.status !== "SUPERSEDED" && pending.status !== "VOID") return { ok: false as const, reason: `A revised agreement (version ${pending.version}) is waiting for the client's signature.` };
  if (s.requiresPaymentAuth && !s.paymentAuthAt) return { ok: false as const, reason: "The required payment authorization hasn't been recorded." };
  return { ok: true as const, reason: "Agreement signed." };
}

/** Status changes staff may make. In Progress is gated; agreement statuses are set by the agreement itself. */
export async function setServiceStatus(actor: Actor, serviceId: string, status: string) {
  const s = await prisma.clientService.findUnique({ where: { id: serviceId }, include: { agreements: true } });
  if (!s) throw new ValidationError("Service not found.");
  const allowed: Partial<Record<ServiceStatus, ServiceStatus[]>> = {
    IN_PROGRESS: ["APPROVED_TO_BEGIN", "AGREEMENT_SIGNED", "COMPLETED"],
    COMPLETED: ["IN_PROGRESS"],
    CLOSED: ["COMPLETED", "AGREEMENT_PENDING", "AGREEMENT_SENT", "AGREEMENT_VIEWED", "APPROVED_TO_BEGIN", "AWAITING_PAYMENT_AUTHORIZATION"],
  };
  if (!(status in allowed)) throw new ValidationError("Choose In Progress, Completed or Closed.");
  const to = status as ServiceStatus;
  if (to === "IN_PROGRESS") {
    const gate = startGate(s);
    if (!gate.ok) throw new ValidationError(`Work can't begin yet: ${gate.reason} The owner can override with a documented reason.`);
  } else if (!allowed[to]!.includes(s.status)) {
    throw new ValidationError(`A service that's ${SERVICE_STATUS[s.status]} can't be marked ${SERVICE_STATUS[to]}.`);
  }
  await prisma.clientService.update({ where: { id: s.id }, data: { status: to, ...(to === "COMPLETED" ? { completedAt: new Date() } : {}), ...(to === "CLOSED" ? { closedAt: new Date() } : {}) } });
  await audit(prisma, { actorId: actor.id, action: "service.status_changed", entityType: "ClientService", entityId: s.id, clientId: s.clientId, details: { from: s.status, to } });
}

export async function recordPaymentAuthorization(actor: Actor, serviceId: string, note: string) {
  const s = await prisma.clientService.findUnique({ where: { id: serviceId }, include: { agreements: true } });
  if (!s) throw new ValidationError("Service not found.");
  if (!signedCurrent(s.agreements)) throw new ValidationError("The client must sign the pricing agreement first.");
  if (!note.trim() || note.trim().length < 5) throw new ValidationError("Describe the authorization (for example, “Deposit received by Zelle 11/2” or “Refund-transfer application signed in TaxAct”).");
  await prisma.clientService.update({ where: { id: s.id }, data: { paymentAuthAt: new Date(), paymentAuthNote: note.trim().slice(0, 300), paymentAuthById: actor.id, ...(s.status === "AWAITING_PAYMENT_AUTHORIZATION" || s.status === "AGREEMENT_SIGNED" ? { status: "APPROVED_TO_BEGIN" } : {}) } });
  await audit(prisma, { actorId: actor.id, action: "service.payment_authorized", entityType: "ClientService", entityId: s.id, clientId: s.clientId, details: { note: note.trim().slice(0, 300) } });
}

/** The owner's documented exception: work may begin without the signed agreement. */
export async function ownerOverride(actor: Actor, serviceId: string, reason: string) {
  await assertOwner(actor, "full");
  if (!reason.trim() || reason.trim().length < 10) throw new ValidationError("Document why work may begin without the signed agreement.");
  const s = await prisma.clientService.findUnique({ where: { id: serviceId } });
  if (!s) throw new ValidationError("Service not found.");
  await prisma.clientService.update({ where: { id: s.id }, data: { overrideAt: new Date(), overrideReason: reason.trim().slice(0, 500), overrideById: actor.id } });
  await audit(prisma, { actorId: actor.id, action: "service.owner_override", entityType: "ClientService", entityId: s.id, clientId: s.clientId, details: { reason: reason.trim().slice(0, 500), statusAtOverride: s.status } });
}

// --- Agreements ---------------------------------------------------------------

type PrepareInput = { lines: { label: string; cents: number }[]; paymentTerms?: string; refundTransfer?: { eligible: boolean; feeCents: number } | null };

/**
 * Prepares the next agreement version (or updates the unsent draft). Signed and
 * sent versions are never changed. Tax services get the Tax Preparation Payment
 * Selection & Fee Agreement; everything else the Service Pricing & Payment Agreement.
 */
export async function prepareAgreement(actor: Actor, serviceId: string, input: PrepareInput) {
  const s = await prisma.clientService.findUnique({ where: { id: serviceId }, include: { agreements: true, client: { select: { displayName: true, businessName: true, clientType: true } } } });
  if (!s) throw new ValidationError("Service not found.");
  if (s.status === "CLOSED") throw new ValidationError("This service is closed.");
  const lines = input.lines.map((l) => ({ label: l.label.trim().slice(0, 120), cents: Math.round(l.cents) })).filter((l) => l.label);
  if (!lines.length) throw new ValidationError("Enter the agreed service price.");
  if (lines.some((l) => !Number.isInteger(l.cents) || l.cents < 0 || l.cents > 10_000_000)) throw new ValidationError("Enter each amount in dollars and cents.");
  const baseCents = lines.reduce((a, l) => a + l.cents, 0);
  if (baseCents <= 0) throw new ValidationError("The agreed price must be more than $0.");
  const kind: AgreementKind = SERVICE_TYPES[s.type].tax && s.type !== "IRS_CORRESPONDENCE" ? "TAX_PAYMENT_SELECTION" : "SERVICE";
  const settings = await feeSettings();
  const rtSetting = settings.find((x) => x.method === "REFUND_TRANSFER");
  const rt = kind === "TAX_PAYMENT_SELECTION" && input.refundTransfer ? { eligible: !!input.refundTransfer.eligible, feeCents: Math.max(0, Math.round(input.refundTransfer.feeCents)) } : null;
  const prev = latest(s.agreements);
  const draft = prev?.status === "DRAFT" ? prev : null;
  const version = draft ? draft.version : (prev?.version ?? 0) + 1;
  const terms: AgreementTerms = {
    business: BUSINESS_NAME,
    agreementTitle: AGREEMENT_TITLES[kind],
    kind,
    version,
    clientName: s.client.displayName,
    businessName: s.client.clientType === "INDIVIDUAL" ? null : s.client.businessName,
    serviceTitle: s.title,
    serviceTypeLabel: SERVICE_TYPES[s.type].label,
    taxYear: s.taxYear,
    periodLabel: s.periodLabel,
    description: s.description,
    lines,
    baseCents,
    options: quoteAll(baseCents, settings, { kind, refundTransfer: rt }),
    paymentTerms: input.paymentTerms?.trim().slice(0, 1500) || DEFAULT_PAYMENT_TERMS,
    refundTransfer: rt ? { ...rt, provider: rtSetting?.providerName ?? null } : null,
  };
  const a = draft
    ? await prisma.pricingAgreement.update({ where: { id: draft.id }, data: { terms, kind } })
    : await prisma.pricingAgreement.create({ data: { serviceId: s.id, clientId: s.clientId, kind, version, terms, createdById: actor.id } });
  await audit(prisma, { actorId: actor.id, action: draft ? "agreement.draft_updated" : "agreement.drafted", entityType: "PricingAgreement", entityId: a.id, clientId: s.clientId, details: { serviceId: s.id, version, baseCents, kind } });
  return a;
}

/** Sends the draft to the client's portal. Any earlier unsigned version is superseded. */
export async function sendAgreement(actor: Actor, agreementId: string) {
  const a = await prisma.pricingAgreement.findUnique({ where: { id: agreementId }, include: { service: { include: { agreements: true } } } });
  if (!a || a.status !== "DRAFT") throw new ValidationError("Only a draft agreement can be sent.");
  const now = new Date();
  await prisma.$transaction(async (tx) => {
    await tx.pricingAgreement.updateMany({ where: { serviceId: a.serviceId, id: { not: a.id }, status: { in: ["SENT", "VIEWED"] } }, data: { status: "SUPERSEDED", supersededAt: now } });
    await tx.pricingAgreement.update({ where: { id: a.id }, data: { status: "SENT", sentAt: now } });
    // A revision of a signed agreement leaves work already under way as it is; otherwise the service waits for the signature.
    if (!["IN_PROGRESS", "COMPLETED"].includes(a.service.status)) await tx.clientService.update({ where: { id: a.serviceId }, data: { status: "AGREEMENT_SENT" } });
  });
  await audit(prisma, { actorId: actor.id, action: "agreement.sent", entityType: "PricingAgreement", entityId: a.id, clientId: a.clientId, details: { version: a.version } });
  const owners = await prisma.portalAccess.findMany({ where: { clientId: a.clientId, revokedAt: null, canViewBilling: true }, select: { portalUserId: true } });
  for (const o of owners) await queuePortalNotification(o.portalUserId, "AGREEMENT_READY", `agreement:${a.id}`);
  return { recipients: owners.length };
}

export async function voidAgreement(actor: Actor, agreementId: string, reason: string) {
  const a = await prisma.pricingAgreement.findUnique({ where: { id: agreementId } });
  if (!a || !["DRAFT", "SENT", "VIEWED"].includes(a.status)) throw new ValidationError("Only an unsigned agreement can be voided. A signed one is replaced by a revised version.");
  if (!reason.trim()) throw new ValidationError("Give a reason.");
  await prisma.pricingAgreement.update({ where: { id: a.id }, data: { status: "VOID", voidedAt: new Date(), voidReason: reason.trim().slice(0, 300) } });
  await audit(prisma, { actorId: actor.id, action: "agreement.voided", entityType: "PricingAgreement", entityId: a.id, clientId: a.clientId, details: { reason: reason.trim().slice(0, 300) } });
}

// --- Client side ---------------------------------------------------------------

async function portalAgreement(user: PortalActor, agreementId: string) {
  const a = await prisma.pricingAgreement.findUnique({ where: { id: agreementId }, include: { service: true } });
  // Same answer for "doesn't exist" and "not yours".
  if (!a || a.status === "DRAFT") throw new ForbiddenError("You don't have access to that agreement.");
  await requireClientAccess(user.id, a.clientId, "billing");
  return a;
}

/** Agreements for the client's portal (never drafts). */
export async function portalAgreements(user: PortalActor, clientId: string) {
  await requireClientAccess(user.id, clientId, "billing");
  return prisma.pricingAgreement.findMany({ where: { clientId, status: { not: "DRAFT" } }, include: { service: { select: { title: true, taxYear: true, periodLabel: true } } }, orderBy: [{ createdAt: "desc" }] });
}

/** Opening the agreement marks it viewed (once). */
export async function viewAgreement(user: PortalActor, agreementId: string) {
  const a = await portalAgreement(user, agreementId);
  if (a.status === "SENT") {
    await prisma.pricingAgreement.update({ where: { id: a.id }, data: { status: "VIEWED", viewedAt: new Date() } });
    if (a.service.status === "AGREEMENT_SENT") await prisma.clientService.update({ where: { id: a.serviceId }, data: { status: "AGREEMENT_VIEWED" } });
    await audit(prisma, { actorId: null, action: "agreement.viewed", entityType: "PricingAgreement", entityId: a.id, clientId: a.clientId, details: { portalUserId: user.id } });
    return { ...a, status: "VIEWED" as const };
  }
  return a;
}

/** The totals for one payment method on this agreement, recalculated from its frozen terms. */
export function selectionFor(terms: AgreementTerms, method: string): AgreementSelection {
  const q = terms.options.find((o) => o.method === method);
  if (!q || !q.available) throw new ValidationError("Choose one of the payment methods offered.");
  return { method: q.method, label: q.label, feeCents: q.feeCents, totalCents: q.totalCents, note: q.note };
}

/** The fingerprint the client confirms when signing with a given payment method. */
export function signingHash(terms: AgreementTerms, method: string) {
  return termsHash(terms, selectionFor(terms, method));
}

/**
 * The client signs: chooses a payment method (totals recalculated and shown),
 * ticks the unticked agreement box, types their name and signs. The fingerprint
 * must match what they were shown. The signed PDF is stored in their account
 * (tax-year folder for tax services).
 */
export async function signAgreement(user: PortalActor, input: { agreementId: string; method: string; signerName: string; agreed: boolean; shownHash: string; ip?: string | null; userAgent?: string | null }) {
  const a = await portalAgreement(user, input.agreementId);
  if (a.status !== "SENT" && a.status !== "VIEWED") throw new ValidationError(a.status === "SIGNED" ? "This agreement is already signed." : "This agreement is no longer open for signature.");
  if (input.agreed !== true) throw new ValidationError("Check the box to confirm you agree to the pricing and payment terms.");
  const name = input.signerName.trim().replace(/\s+/g, " ");
  if (name.length < 3 || !/\s/.test(name)) throw new ValidationError("Type your full name to sign.");
  const terms = a.terms as unknown as AgreementTerms;
  const selection = selectionFor(terms, input.method);
  const hash = termsHash(terms, selection);
  if (input.shownHash !== hash) throw new ValidationError("The total changed since this page loaded. Review the updated amount and sign again.");
  const now = new Date();
  const signedAtChicago = now.toLocaleString("en-US", { timeZone: OFFICE_TZ, dateStyle: "long", timeStyle: "long" });
  const pdf = await renderAgreementPdf(terms, selection, { signerName: name, signedAtChicago, ip: input.ip ?? null, termsHash: hash, consentText: CONSENT_TEXT });
  const stored = await storeDocumentFile(pdf, `${terms.agreementTitle} v${terms.version} - signed.pdf`, { system: "agreement" }, undefined);
  const prior = await prisma.pricingAgreement.findFirst({ where: { serviceId: a.serviceId, status: "SIGNED" } });
  await prisma.$transaction(async (tx) => {
    // Claim the agreement first so two submissions can't both sign it.
    const claimed = await tx.pricingAgreement.updateMany({ where: { id: a.id, status: { in: ["SENT", "VIEWED"] } }, data: { status: "SIGNED" } });
    if (claimed.count !== 1) throw new ValidationError("This agreement is already signed.");
    const file = await tx.storedFile.create({ data: stored.fileData });
    const doc = await tx.document.create({
      data: {
        clientId: a.clientId,
        category: "CONTRACTS",
        title: `${terms.agreementTitle} — ${a.service.title} (v${terms.version}, signed)`,
        year: a.service.taxYear,
        docType: "PRICING_AGREEMENT",
        visibility: "PUBLISHED",
        publishedAt: now,
        fileId: file.id,
        scanStatus: stored.scan,
        ...stored.scanMeta,
        retainUntil: await retentionDate("CONTRACTS"),
      },
    });
    await tx.pricingAgreement.update({ where: { id: a.id }, data: { selectedMethod: selection.method, selection, termsHash: hash, signedAt: now, signerName: name, signedByPortalId: user.id, signerIp: input.ip?.slice(0, 64) ?? null, signerAgent: input.userAgent?.slice(0, 300) ?? null, consentText: CONSENT_TEXT, pdfDocumentId: doc.id } });
    if (prior) await tx.pricingAgreement.update({ where: { id: prior.id }, data: { status: "SUPERSEDED", supersededAt: now } });
    const next: ServiceStatus = ["IN_PROGRESS", "COMPLETED"].includes(a.service.status) ? a.service.status : a.service.requiresPaymentAuth && !a.service.paymentAuthAt ? "AWAITING_PAYMENT_AUTHORIZATION" : "APPROVED_TO_BEGIN";
    await tx.clientService.update({ where: { id: a.serviceId }, data: { status: next } });
    await audit(tx, { actorId: null, action: "agreement.signed", entityType: "PricingAgreement", entityId: a.id, clientId: a.clientId, details: { portalUserId: user.id, version: terms.version, method: selection.method, totalCents: selection.totalCents, termsHash: hash, documentId: doc.id, supersedes: prior?.id ?? null } });
  });
  return { selection, termsHash: hash };
}

/**
 * After signing, a different payment method is a revised agreement: same
 * prices, new version, signed again. Nothing changes until it's signed.
 */
export async function requestMethodChange(user: PortalActor, agreementId: string) {
  const a = await portalAgreement(user, agreementId);
  if (a.status !== "SIGNED") throw new ValidationError("Choose a different method on the agreement before signing it.");
  const open = await prisma.pricingAgreement.findFirst({ where: { serviceId: a.serviceId, status: { in: ["DRAFT", "SENT", "VIEWED"] } } });
  if (open) return open;
  const terms = a.terms as unknown as AgreementTerms;
  const version = ((await prisma.pricingAgreement.aggregate({ where: { serviceId: a.serviceId }, _max: { version: true } }))._max.version ?? 0) + 1;
  // Fees recalculated from today's settings; prices unchanged.
  const settings = await feeSettings();
  const rt = terms.refundTransfer ? { eligible: terms.refundTransfer.eligible, feeCents: terms.refundTransfer.feeCents } : null;
  const nextTerms: AgreementTerms = { ...terms, version, options: quoteAll(terms.baseCents, settings, { kind: terms.kind, refundTransfer: rt }) };
  const created = await prisma.pricingAgreement.create({ data: { serviceId: a.serviceId, clientId: a.clientId, kind: a.kind, version, terms: nextTerms, status: "SENT", sentAt: new Date(), createdById: a.createdById } });
  await audit(prisma, { actorId: null, action: "agreement.method_change_requested", entityType: "PricingAgreement", entityId: created.id, clientId: a.clientId, details: { portalUserId: user.id, from: a.selectedMethod, previousVersion: a.version, version } });
  return created;
}

export const methodLabel = (m: string | null | undefined) => (m && m in PAYMENT_METHODS ? PAYMENT_METHODS[m as MethodKey].label : m ?? "—");
