import "server-only";
import { createHash, randomBytes } from "node:crypto";
import type { ClientAgreement, ClientAgreementStatus, Prisma, ServiceType } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { audit } from "@/lib/audit";
import { ForbiddenError, type Actor } from "@/lib/auth/actor";
import type { PortalActor } from "@/lib/portal/session";
import { requireClientAccess } from "@/lib/portal/access";
import { OFFICE_TZ, chicagoToday } from "@/lib/dates";
import { normalizeEmail, normalizePhone } from "@/lib/normalize";
import { brandedEmailHtml, sendEmail } from "@/lib/email";
import { appUrl } from "@/lib/integrations";
import { candidateKeys } from "@/lib/import/rows";
import { formatAddressBlock, billingAddressOf } from "@/lib/client-address";
import {
  AGREEMENT_METHODS, BILLING_FREQUENCIES, CLAUSE_SEEDS, defaultOptions, FEE_STRUCTURES, renderAgreement, SERVICE_LABELS, TAX_SERVICES, TEMPLATE_SEEDS, TERMS, displayStatus, termEnd,
  type AgreementMethod, type AgreementOptions, type DisplayStatus, type LibraryClause, type Rendered, type ServiceKey,
} from "@/lib/agreements/catalog";
import { renderSignedAgreementPdf, type FrozenClause } from "@/lib/agreements/pdf";
import { ValidationError, createClient, currentTaxYear } from "./clients";
import { isReportApprover } from "./bookkeeping-clients";
import { retentionDate, storeDocumentFile } from "./documents";
import { queuePortalNotification } from "./notifications";
import { createQuote, todayYmd } from "./owner-billing";

/**
 * Agreements & Contracts center. Staff draft; only Tabitha (the report approver)
 * sends, approves clauses and edits templates. A sent agreement is frozen: its
 * exact text, clause versions and template version are stored with a fingerprint,
 * and later library edits never change it. Nothing is sent automatically — every
 * send, link and email is one of Tabitha's clicks.
 */

export const LINK_TTL_DAYS = 14;
export const SIGN_CONSENT = "By typing my full legal name below and selecting Sign agreement, I am signing this agreement electronically, and I intend my typed name to be my signature.";
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

async function assertTabitha(actor: Actor, what = "do that") {
  if (!(await isReportApprover(actor))) throw new ForbiddenError(`Only Tabitha can ${what}.`);
}

// --- Library (seeded on first use) ------------------------------------------------

/** Seeds any missing clause or template from the catalog. Never overwrites an edited one. */
export async function ensureLibrary() {
  const [nc, nt] = await Promise.all([prisma.agreementClause.count(), prisma.agreementTemplate.count()]);
  if (nc >= CLAUSE_SEEDS.length && nt >= TEMPLATE_SEEDS.length) return;
  const have = new Set((await prisma.agreementClause.findMany({ select: { key: true } })).map((c) => c.key));
  for (const c of CLAUSE_SEEDS.filter((x) => !have.has(x.key))) {
    try {
      await prisma.agreementClause.create({
        data: { key: c.key, title: c.title, kind: c.kind, sortOrder: c.sortOrder, versions: { create: { version: 1, body: c.body, source: c.source, status: c.source === "JOTFORM" ? "APPROVED" : "DRAFT", approvedAt: c.source === "JOTFORM" ? new Date() : null } } },
      });
    } catch (e) {
      if ((e as { code?: string }).code !== "P2002") throw e;
    }
  }
  const haveT = new Set((await prisma.agreementTemplate.findMany({ select: { key: true } })).map((t) => t.key));
  for (const t of TEMPLATE_SEEDS.filter((x) => !haveT.has(x.key))) {
    try {
      await prisma.agreementTemplate.create({
        data: { key: t.key, name: t.name, description: t.description, sortOrder: t.sortOrder, versions: { create: { version: 1, title: t.title, intro: t.intro, clauseKeys: t.clauseKeys, defaults: t.defaults as Prisma.InputJsonValue } } },
      });
    } catch (e) {
      if ((e as { code?: string }).code !== "P2002") throw e;
    }
  }
}

/** Each clause at its latest version. */
export async function library(): Promise<(LibraryClause & { source: string; approvedAt: Date | null; history: { version: number; status: string; createdAt: Date }[] })[]> {
  await ensureLibrary();
  const rows = await prisma.agreementClause.findMany({ include: { versions: { orderBy: { version: "desc" } } }, orderBy: [{ sortOrder: "asc" }, { key: "asc" }] });
  return rows.map((c) => {
    const v = c.versions[0];
    return { key: c.key, title: c.title, kind: c.kind as "ACK" | "TERM", version: v.version, status: v.status, body: v.body, source: v.source, approvedAt: v.approvedAt, history: c.versions.map((x) => ({ version: x.version, status: x.status, createdAt: x.createdAt })) };
  });
}

export async function templates() {
  await ensureLibrary();
  const rows = await prisma.agreementTemplate.findMany({ where: { active: true }, include: { versions: { orderBy: { version: "desc" }, take: 1 } }, orderBy: { sortOrder: "asc" } });
  return rows.map((t) => ({ id: t.id, key: t.key, name: t.name, description: t.description, version: t.versions[0].version, title: t.versions[0].title, intro: t.versions[0].intro, clauseKeys: t.versions[0].clauseKeys, defaults: t.versions[0].defaults as Partial<AgreementOptions> }));
}
export type TemplateView = Awaited<ReturnType<typeof templates>>[number];

async function templateByKey(key: string) {
  const t = (await templates()).find((x) => x.key === key);
  if (!t) throw new ValidationError("Choose an agreement type.");
  return t;
}

async function templateVersion(templateId: string, version: number) {
  return prisma.agreementTemplateVersion.findUniqueOrThrow({ where: { templateId_version: { templateId, version } }, include: { template: true } });
}

/** Tabitha edits a clause: a new version. "Save and approve" approves it; otherwise it waits as a draft. */
export async function saveClause(actor: Actor, key: string, input: { body: string; approve: boolean }) {
  await assertTabitha(actor, "edit agreement clauses");
  await ensureLibrary();
  const c = await prisma.agreementClause.findUnique({ where: { key }, include: { versions: { orderBy: { version: "desc" }, take: 1 } } });
  if (!c) throw new ValidationError("Clause not found.");
  const body = input.body.trim();
  if (body.length < 5) throw new ValidationError("Enter the clause wording.");
  if (body.length > 4000) throw new ValidationError("Keep a clause under 4,000 characters.");
  const version = (c.versions[0]?.version ?? 0) + 1;
  await prisma.agreementClauseVersion.create({ data: { clauseId: c.id, version, body, source: "EDITED", status: input.approve ? "APPROVED" : "DRAFT", approvedAt: input.approve ? new Date() : null, approvedById: input.approve ? actor.id : null, createdById: actor.id } });
  await audit(prisma, { actorId: actor.id, action: input.approve ? "agreement_clause.edited_approved" : "agreement_clause.edited", entityType: "AgreementClause", entityId: c.id, details: { key, version } });
  return version;
}

/** Tabitha approves the latest version of a clause as written. */
export async function approveClause(actor: Actor, key: string) {
  await assertTabitha(actor, "approve agreement clauses");
  const c = await prisma.agreementClause.findUnique({ where: { key }, include: { versions: { orderBy: { version: "desc" }, take: 1 } } });
  if (!c?.versions[0]) throw new ValidationError("Clause not found.");
  const v = c.versions[0];
  if (v.status === "APPROVED") return v.version;
  await prisma.agreementClauseVersion.update({ where: { id: v.id }, data: { status: "APPROVED", approvedAt: new Date(), approvedById: actor.id } });
  await audit(prisma, { actorId: actor.id, action: "agreement_clause.approved", entityType: "AgreementClause", entityId: c.id, details: { key, version: v.version } });
  return v.version;
}

/** Tabitha edits a template: a new version (title, opening line, built-in clauses). */
export async function saveTemplate(actor: Actor, key: string, input: { title: string; intro: string; clauseKeys: string[] }) {
  await assertTabitha(actor, "edit agreement templates");
  const t = await templateByKey(key);
  const known = new Set((await library()).map((c) => c.key));
  const keys = [...new Set(input.clauseKeys.filter((k) => known.has(k)))];
  if (!input.title.trim()) throw new ValidationError("Give the template a title.");
  const version = t.version + 1;
  await prisma.agreementTemplateVersion.create({ data: { templateId: t.id, version, title: input.title.trim().slice(0, 150), intro: input.intro.trim().slice(0, 1000) || t.intro, clauseKeys: keys, defaults: t.defaults as Prisma.InputJsonValue, createdById: actor.id } });
  await audit(prisma, { actorId: actor.id, action: "agreement_template.edited", entityType: "AgreementTemplate", entityId: t.id, details: { key, version } });
  return version;
}

const NOTE_ACTION = "agreements.attorney_note_dismissed";
export async function attorneyNoteDismissed(actor: Actor) {
  return (await prisma.auditLog.count({ where: { action: NOTE_ACTION, actorId: actor.id } })) > 0;
}
export async function dismissAttorneyNote(actor: Actor) {
  if (!(await attorneyNoteDismissed(actor))) await audit(prisma, { actorId: actor.id, action: NOTE_ACTION, entityType: "AgreementTemplate" });
}

// --- Clients ------------------------------------------------------------------------

const clientName = (c: { clientType: string; displayName: string; businessName: string | null }) => (c.clientType !== "INDIVIDUAL" && c.businessName ? c.businessName : c.displayName);

export async function searchClients(q: string, take = 12) {
  const term = q.trim();
  return prisma.client.findMany({
    where: { archivedAt: null, ...(term ? { OR: [{ displayName: { contains: term, mode: "insensitive" } }, { businessName: { contains: term, mode: "insensitive" } }, { email: { contains: term, mode: "insensitive" } }] } : {}) },
    select: { id: true, displayName: true, businessName: true, clientType: true, email: true, status: true },
    orderBy: { displayName: "asc" },
    take,
  });
}

/** Existing clients that look like the same person or business (email, phone, name). */
export async function findClientMatches(input: { firstName?: string; lastName?: string; businessName?: string; email?: string; phone?: string }) {
  const email = normalizeEmail(input.email ?? "");
  const phone = normalizePhone(input.phone ?? "");
  const or: Prisma.ClientWhereInput[] = [];
  if (email) or.push({ emailNormalized: email }, { contacts: { some: { emailNormalized: email } } });
  if (phone) or.push({ phoneNormalized: phone }, { contacts: { some: { phoneNormalized: phone } } });
  if (input.businessName?.trim()) or.push({ businessName: { equals: input.businessName.trim(), mode: "insensitive" } });
  if (input.lastName?.trim()) or.push({ lastName: { equals: input.lastName.trim(), mode: "insensitive" } });
  if (!or.length) return [];
  const rows = await prisma.client.findMany({ where: { archivedAt: null, OR: or }, select: { id: true, displayName: true, businessName: true, firstName: true, lastName: true, spouseFirstName: true, spouseLastName: true, emailNormalized: true, phoneNormalized: true, clientType: true, contacts: { select: { emailNormalized: true, phoneNormalized: true } } }, take: 25 });
  const asCandidate = (c: { id?: string; displayName?: string | null; firstName?: string | null; lastName?: string | null; spouseFirstName?: string | null; spouseLastName?: string | null }) => ({ id: c.id ?? "", displayName: c.displayName ?? "", firstName: c.firstName ?? null, lastName: c.lastName ?? null, spouseFirstName: c.spouseFirstName ?? null, spouseLastName: c.spouseLastName ?? null, businessName: null, emailNormalized: null, phoneNormalized: null, contactEmails: [], contactPhones: [] });
  const keys = new Set(input.firstName?.trim() && input.lastName?.trim() ? candidateKeys(asCandidate({ firstName: input.firstName.trim(), lastName: input.lastName.trim() })) : []);
  return rows.filter((r) => {
    if (email && (r.emailNormalized === email || r.contacts.some((x) => x.emailNormalized === email))) return true;
    if (phone && (r.phoneNormalized === phone || r.contacts.some((x) => x.phoneNormalized === phone))) return true;
    if (input.businessName?.trim() && r.businessName?.trim().toLowerCase() === input.businessName.trim().toLowerCase()) return true;
    return candidateKeys(asCandidate(r)).some((k) => keys.has(k));
  });
}

/**
 * "New client" from the agreement screen: the existing create-client flow, after the
 * duplicate check. A possible match is never created again — staff pick the existing record.
 */
export async function createClientForAgreement(actor: Actor, input: { clientType: "INDIVIDUAL" | "BUSINESS" | "NONPROFIT"; firstName?: string; lastName?: string; businessName?: string; email?: string; phone?: string }) {
  if (input.clientType === "INDIVIDUAL" ? !input.firstName?.trim() || !input.lastName?.trim() : !input.businessName?.trim()) throw new ValidationError(input.clientType === "INDIVIDUAL" ? "Enter the client's first and last name." : "Enter the business or organization name.");
  const matches = await findClientMatches(input);
  if (matches.length) {
    const err = new ValidationError(`Possible existing client: ${matches.map((m) => clientName(m)).join(", ")}. Choose them from the search instead — a duplicate record wasn't created.`);
    (err as ValidationError & { matches?: unknown }).matches = matches.map((m) => m.id);
    throw err;
  }
  return createClient(actor, { clientType: input.clientType, status: "PROSPECT", firstName: input.firstName || undefined, lastName: input.lastName || undefined, businessName: input.businessName || undefined, email: input.email || undefined, phone: input.phone || undefined });
}

// --- Drafting -----------------------------------------------------------------------

/** Step (c) prefilled from the template, the client record and, for bookkeeping, the profile's fee and frequency. */
export async function prefillOptions(clientId: string, templateKey: string): Promise<AgreementOptions> {
  const t = await templateByKey(templateKey);
  const [profile, billing] = await Promise.all([
    prisma.bookkeepingProfile.findUnique({ where: { clientId }, select: { active: true, frequency: true, payroll: true } }),
    prisma.bookkeepingBilling.findUnique({ where: { clientId }, select: { monthlyFeeCents: true } }),
  ]);
  const o = defaultOptions(structuredClone(t.defaults));
  const services = new Set(o.services);
  if (TAX_SERVICES.some((s) => services.has(s)) || templateKey === "PAYMENT_PLAN") o.taxYear = currentTaxYear();
  if (o.term !== "ONE_TIME") o.startDate = todayYmd();
  const fee = billing?.monthlyFeeCents ?? null;
  if (templateKey === "BOOKKEEPING") {
    if (profile?.frequency === "QUARTERLY") o.billingFrequency = "QUARTERLY";
    if (fee) o.fees = [{ label: profile?.frequency === "QUARTERLY" ? "Quarterly bookkeeping" : "Monthly bookkeeping", cents: fee }];
  }
  if (templateKey === "PAYMENT_PLAN" && fee) o.bundledMonthlyCents = fee;
  return o;
}

const METHOD_KEYS = Object.keys(AGREEMENT_METHODS) as AgreementMethod[];
const SERVICE_KEYS = Object.keys(SERVICE_LABELS) as ServiceKey[];
const ymdOk = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s);

/** Cleans what the form sent. Amounts in whole cents; nothing outside the listed choices. */
export function cleanOptions(raw: Partial<AgreementOptions>): AgreementOptions {
  const o = defaultOptions(raw);
  const cents = (n: unknown) => (Number.isFinite(Number(n)) ? Math.max(0, Math.min(100_000_000, Math.round(Number(n)))) : 0);
  return {
    services: [...new Set((o.services ?? []).filter((s) => SERVICE_KEYS.includes(s)))],
    serviceNotes: String(o.serviceNotes ?? "").trim().slice(0, 1000),
    taxYear: o.taxYear && Number.isInteger(Number(o.taxYear)) && Number(o.taxYear) >= 2000 && Number(o.taxYear) <= 2100 ? Number(o.taxYear) : null,
    periodLabel: String(o.periodLabel ?? "").trim().slice(0, 80),
    feeStructure: o.feeStructure in FEE_STRUCTURES ? o.feeStructure : "FLAT",
    fees: (o.fees ?? []).map((f) => ({ label: String(f.label ?? "").trim().slice(0, 120), cents: cents(f.cents) })).filter((f) => f.label || f.cents).slice(0, 8),
    billingFrequency: o.billingFrequency in BILLING_FREQUENCIES ? o.billingFrequency : "ONE_TIME",
    invoiceNumber: String(o.invoiceNumber ?? "").trim().slice(0, 40),
    depositCents: cents(o.depositCents),
    installments: (o.installments ?? []).map((i) => ({ cents: cents(i.cents), date: ymdOk(String(i.date)) ? String(i.date) : "" })).filter((i) => i.cents || i.date).slice(0, 12),
    startDate: ymdOk(String(o.startDate ?? "")) ? String(o.startDate) : "",
    term: o.term in TERMS ? o.term : "ONE_TIME",
    autoRenew: !!o.autoRenew,
    renewalIncreasePct: Number.isFinite(Number(o.renewalIncreasePct)) ? Math.max(0, Math.min(25, Math.round(Number(o.renewalIncreasePct) * 100) / 100)) : 3,
    terminationNoticeDays: o.terminationNoticeDays === null || o.terminationNoticeDays === undefined || String(o.terminationNoticeDays) === "" ? null : Math.max(1, Math.min(365, Math.round(Number(o.terminationNoticeDays)) || 1)),
    paymentMethods: [...new Set((o.paymentMethods ?? []).filter((m) => METHOD_KEYS.includes(m)))],
    toggles: { latePayment: !!o.toggles?.latePayment, nonCancellable: !!o.toggles?.nonCancellable, bundledService: !!o.toggles?.bundledService, clientResponsibilities: !!o.toggles?.clientResponsibilities, confidentiality: !!o.toggles?.confidentiality, esign: !!o.toggles?.esign },
    bundledMonthlyCents: o.bundledMonthlyCents ? cents(o.bundledMonthlyCents) : null,
    bundledPeriod: String(o.bundledPeriod ?? "").trim().slice(0, 80),
    askServiceSelection: !!o.askServiceSelection,
    serviceQuestion: String(o.serviceQuestion ?? "").trim().slice(0, 120),
    askPaymentMethod: !!o.askPaymentMethod,
    customClauseKeys: [...new Set((o.customClauseKeys ?? []).map(String))].slice(0, 40),
  };
}

const columnsOf = (o: AgreementOptions) => {
  const end = termEnd(o);
  return { serviceTypes: o.services as ServiceType[], taxYear: o.taxYear, startDate: o.startDate ? new Date(`${o.startDate}T00:00:00Z`) : null, termEndDate: end ? new Date(`${end}T00:00:00Z`) : null };
};

async function activeClient(clientId: string) {
  const c = await prisma.client.findUnique({ where: { id: clientId }, select: { id: true, displayName: true, businessName: true, clientType: true, archivedAt: true } });
  if (!c || c.archivedAt) throw new ValidationError("Choose a client.");
  return c;
}

/** A new draft. Staff may draft; nothing is sent. */
export async function createAgreement(actor: Actor, input: { clientId: string; templateKey: string; options?: Partial<AgreementOptions>; title?: string; bulkBatchId?: string | null; renewsId?: string | null }) {
  const c = await activeClient(input.clientId);
  const t = await templateByKey(input.templateKey);
  const options = cleanOptions(input.options ?? (await prefillOptions(c.id, t.key)));
  const a = await prisma.clientAgreement.create({
    data: { clientId: c.id, templateId: t.id, templateVersion: t.version, title: (input.title?.trim() || t.title).slice(0, 150), options: options as unknown as Prisma.InputJsonValue, ...columnsOf(options), bulkBatchId: input.bulkBatchId ?? null, renewsId: input.renewsId ?? null, createdById: actor.id },
  });
  await audit(prisma, { actorId: actor.id, action: "agreement_center.drafted", entityType: "ClientAgreement", entityId: a.id, clientId: c.id, details: { template: t.key, templateVersion: t.version, bulkBatchId: input.bulkBatchId ?? null, renewsId: input.renewsId ?? null } });
  return a;
}

/** Drafts (and ones waiting for Tabitha) can change; a sent agreement is frozen. */
export async function updateAgreement(actor: Actor, id: string, input: { options: Partial<AgreementOptions>; title?: string }) {
  const a = await prisma.clientAgreement.findUnique({ where: { id } });
  if (!a) throw new ValidationError("Agreement not found.");
  if (a.status !== "DRAFT" && a.status !== "WAITING_FOR_OWNER") throw new ValidationError("A sent agreement can't be changed. Void it and prepare a new one.");
  const options = cleanOptions(input.options);
  const res = await prisma.clientAgreement.updateMany({ where: { id, status: { in: ["DRAFT", "WAITING_FOR_OWNER"] } }, data: { options: options as unknown as Prisma.InputJsonValue, ...columnsOf(options), ...(input.title?.trim() ? { title: input.title.trim().slice(0, 150) } : {}) } });
  if (res.count !== 1) throw new ValidationError("A sent agreement can't be changed.");
  await audit(prisma, { actorId: actor.id, action: "agreement_center.updated", entityType: "ClientAgreement", entityId: id, clientId: a.clientId });
}

/** The agreement as it reads now (a draft from the live library; a sent one from its frozen text). */
export async function renderFor(a: ClientAgreement & { client: { displayName: string; businessName: string | null; clientType: string } }): Promise<Rendered & { frozen: boolean }> {
  if (a.frozenClauses) {
    const f = a.frozenClauses as unknown as Frozen;
    return { title: f.title, intro: f.intro, clauses: f.clauses.map((c) => ({ ...c, status: "APPROVED" as const, missing: [] })), questions: f.questions, missing: [], drafts: [], text: a.frozenText ?? "", frozen: true };
  }
  const tv = await templateVersion(a.templateId, a.templateVersion);
  const lib = await library();
  return { ...renderAgreement({ title: a.title, intro: tv.intro, templateKey: tv.template.key, templateClauseKeys: tv.clauseKeys, options: a.options as unknown as AgreementOptions, clientName: clientName(a.client), library: lib }), frozen: false };
}

type Frozen = { title: string; intro: string; clauses: FrozenClause[]; questions: Rendered["questions"]; templateKey: string; templateVersion: number };

/** Why this agreement can't be sent yet (empty = ready). */
export async function sendBlockers(a: ClientAgreement & { client: { displayName: string; businessName: string | null; clientType: string } }) {
  const r = await renderFor(a);
  const o = a.options as unknown as AgreementOptions;
  const out: string[] = [];
  if (r.drafts.length) out.push(`DRAFT clause${r.drafts.length === 1 ? "" : "s"} waiting for Tabitha's approval: ${r.drafts.join(", ")}.`);
  if (r.missing.length) out.push(`Fill in: ${r.missing.map((m) => m.replace(/_/g, " ").toLowerCase()).join(", ")}.`);
  if (!r.clauses.some((c) => c.key === "esign")) out.push("Turn on the e-sign consent so the client can sign electronically.");
  if (!o.fees.length || o.fees.some((f) => !f.label || f.cents <= 0)) out.push("Enter each fee with a description and an amount.");
  if (!r.clauses.length) out.push("Choose at least one clause.");
  return out;
}

// --- Sending (Tabitha only) -----------------------------------------------------------

/** Staff: "Ask Tabitha to send". She sees it on her Owner's Office overview. */
export async function askToSend(actor: Actor, id: string) {
  const res = await prisma.clientAgreement.updateMany({ where: { id, status: "DRAFT" }, data: { status: "WAITING_FOR_OWNER", requestedAt: new Date(), requestedById: actor.id } });
  if (res.count !== 1) throw new ValidationError("Only a draft can be sent to Tabitha.");
  const a = await prisma.clientAgreement.findUniqueOrThrow({ where: { id } });
  await audit(prisma, { actorId: actor.id, action: "agreement_center.send_requested", entityType: "ClientAgreement", entityId: id, clientId: a.clientId });
}

/** Portal logins that may open this client's agreements (Contracts access, signed up). */
export async function portalRecipients(clientId: string) {
  return prisma.portalAccess.findMany({ where: { clientId, revokedAt: null, canViewContracts: true, portalUser: { active: true, passwordHash: { not: null } } }, select: { portalUserId: true } });
}

function newToken() {
  const token = randomBytes(32).toString("base64url");
  return { token, tokenHash: sha(token) };
}
export const signingUrl = (token: string) => `${appUrl()}/agreement-sign/${token}`;

/**
 * Tabitha sends. The text is frozen first. PORTAL queues the existing portal notice
 * (a sign-in link only); LINK makes a secure single-use link she copies. Nothing else is sent.
 */
export async function sendAgreement(actor: Actor, id: string, via: "PORTAL" | "LINK") {
  await assertTabitha(actor, "send agreements");
  const a = await prisma.clientAgreement.findUnique({ where: { id }, include: { client: { select: { displayName: true, businessName: true, clientType: true } }, template: true } });
  if (!a || (a.status !== "DRAFT" && a.status !== "WAITING_FOR_OWNER")) throw new ValidationError("Only a draft can be sent.");
  const blockers = await sendBlockers(a);
  if (blockers.length) throw new ValidationError(`Not sent. ${blockers.join(" ")}`);
  const recipients = await portalRecipients(a.clientId);
  if (via === "PORTAL" && !recipients.length) throw new ValidationError("This client has no portal login with Contracts access. Create a signing link instead.");
  const r = await renderFor(a);
  const frozen: Frozen = { title: r.title, intro: r.intro, clauses: r.clauses.map((c) => ({ key: c.key, title: c.title, kind: c.kind, version: c.version, text: c.text })), questions: r.questions, templateKey: a.template.key, templateVersion: a.templateVersion };
  const textHash = sha(JSON.stringify(frozen));
  const now = new Date();
  const link = via === "LINK" ? newToken() : null;
  const signBy = link ? new Date(now.getTime() + LINK_TTL_DAYS * 86_400_000) : null;
  await prisma.$transaction(async (tx) => {
    const res = await tx.clientAgreement.updateMany({ where: { id, status: { in: ["DRAFT", "WAITING_FOR_OWNER"] } }, data: { status: "SENT", frozenText: r.text, frozenClauses: frozen as unknown as Prisma.InputJsonValue, textHash, sentAt: now, sentById: actor.id, sentVia: via, signBy } });
    if (res.count !== 1) throw new ValidationError("This agreement was already sent.");
    if (link) await tx.agreementSigningLink.create({ data: { agreementId: id, tokenHash: link.tokenHash, expiresAt: signBy!, createdById: actor.id } });
    await audit(tx, { actorId: actor.id, action: "agreement_center.sent", entityType: "ClientAgreement", entityId: id, clientId: a.clientId, details: { via, textHash, templateVersion: a.templateVersion, clauses: frozen.clauses.map((c) => `${c.key}@v${c.version}`) } });
  });
  if (via === "PORTAL") for (const p of recipients) await queuePortalNotification(p.portalUserId, "AGREEMENT_READY", `client-agreement:${id}`);
  return { recipients: via === "PORTAL" ? recipients.length : 0, url: link ? signingUrl(link.token) : null };
}

/** A fresh signing link (earlier unused ones stop working). Optionally emailed — only on Tabitha's click. */
export async function newSigningLink(actor: Actor, id: string, opts: { email?: boolean } = {}) {
  await assertTabitha(actor, "create signing links");
  const a = await prisma.clientAgreement.findUnique({ where: { id }, include: { client: { select: { email: true, displayName: true } } } });
  if (!a || (a.status !== "SENT" && a.status !== "EXPIRED")) throw new ValidationError("Send the agreement first.");
  const to = opts.email ? normalizeEmail(a.client.email ?? "") : null;
  if (opts.email && !to) throw new ValidationError("This client has no email address on file. Copy the link instead.");
  const { token, tokenHash } = newToken();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + LINK_TTL_DAYS * 86_400_000);
  const link = await prisma.$transaction(async (tx) => {
    await tx.agreementSigningLink.updateMany({ where: { agreementId: id, usedAt: null, revokedAt: null }, data: { revokedAt: now } });
    await tx.clientAgreement.update({ where: { id }, data: { status: "SENT", signBy: expiresAt } });
    return tx.agreementSigningLink.create({ data: { agreementId: id, tokenHash, expiresAt, createdById: actor.id } });
  });
  const url = signingUrl(token);
  let emailed: string | null = null;
  if (to) {
    const r = await sendEmail({
      to,
      subject: "Your agreement is ready to review and sign — T. Turner & Associates",
      text: `An agreement from T. Turner & Associates is ready for you to review and sign.\n\nOpen it securely: ${url}\n\nThis link works once and expires in ${LINK_TTL_DAYS} days. For your privacy, the agreement itself is not included in this email.`,
      html: brandedEmailHtml({ heading: "Your agreement is ready", paragraphs: ["An agreement from T. Turner & Associates is ready for you to review and sign.", `This link works once and expires in ${LINK_TTL_DAYS} days.`], button: { label: "Review and sign", url }, note: "For your privacy, the agreement itself is not included in this email." }),
      idempotencyKey: `agreement-link:${link.id}`,
      tags: { category: "agreement" },
    });
    if (!r.ok) throw new ValidationError(`The new link was made but the email wasn't sent: ${r.detail} Copy the link instead.`);
    emailed = to;
    await prisma.agreementSigningLink.update({ where: { id: link.id }, data: { emailedAt: new Date(), emailedTo: to } });
  }
  await audit(prisma, { actorId: actor.id, action: emailed ? "agreement_center.link_emailed" : "agreement_center.link_created", entityType: "ClientAgreement", entityId: id, clientId: a.clientId, details: { linkId: link.id, emailed: !!emailed } });
  return { url, emailed };
}

/** Tabitha sends several reviewed drafts, one click. Each is checked on its own; nothing else is sent. */
export async function sendSelected(actor: Actor, ids: string[]) {
  await assertTabitha(actor, "send agreements");
  const results: { id: string; ok: boolean; message: string; url?: string | null }[] = [];
  for (const id of ids) {
    const recipients = await prisma.clientAgreement.findUnique({ where: { id }, select: { clientId: true } }).then((a) => (a ? portalRecipients(a.clientId) : []));
    try {
      const r = await sendAgreement(actor, id, recipients.length ? "PORTAL" : "LINK");
      results.push({ id, ok: true, message: r.url ? "Signing link created" : `Portal notice to ${r.recipients}`, url: r.url });
    } catch (e) {
      if (!(e instanceof ValidationError || e instanceof ForbiddenError)) throw e;
      results.push({ id, ok: false, message: e.message });
    }
  }
  return results;
}

export async function voidAgreement(actor: Actor, id: string, reason: string) {
  const a = await prisma.clientAgreement.findUnique({ where: { id } });
  if (!a || !["DRAFT", "WAITING_FOR_OWNER", "SENT", "EXPIRED"].includes(a.status)) throw new ValidationError("Only an unsigned agreement can be voided.");
  if (a.status !== "DRAFT" && a.status !== "WAITING_FOR_OWNER") await assertTabitha(actor, "void a sent agreement");
  if (!reason.trim()) throw new ValidationError("Give a reason.");
  await prisma.$transaction([
    prisma.clientAgreement.update({ where: { id }, data: { status: "VOID", voidedAt: new Date(), voidReason: reason.trim().slice(0, 300) } }),
    prisma.agreementSigningLink.updateMany({ where: { agreementId: id, usedAt: null, revokedAt: null }, data: { revokedAt: new Date() } }),
  ]);
  await audit(prisma, { actorId: actor.id, action: "agreement_center.voided", entityType: "ClientAgreement", entityId: id, clientId: a.clientId, details: { reason: reason.trim().slice(0, 300) } });
}

// --- Lists ------------------------------------------------------------------------------

const LIST_INCLUDE = {
  client: { select: { id: true, displayName: true, businessName: true, clientType: true } },
  template: { select: { key: true, name: true } },
  invoices: { select: { id: true, number: true, state: true } },
  renewals: { where: { status: { not: "VOID" as const } }, select: { id: true } },
} satisfies Prisma.ClientAgreementInclude;

/** Sent agreements past their signing deadline become Expired. */
async function expireStale() {
  await prisma.clientAgreement.updateMany({ where: { status: "SENT", signBy: { lt: new Date() } }, data: { status: "EXPIRED" } });
}

export async function listAgreements(filter: { template?: string; status?: string; clientId?: string } = {}) {
  await ensureLibrary();
  await expireStale();
  const rows = await prisma.clientAgreement.findMany({
    where: { ...(filter.clientId ? { clientId: filter.clientId } : {}), ...(filter.template ? { template: { key: filter.template } } : {}) },
    include: LIST_INCLUDE,
    orderBy: { updatedAt: "desc" },
    take: 500,
  });
  const today = chicagoToday();
  const withStatus = rows.map((a) => ({ ...a, display: displayStatus(a, today) as DisplayStatus, clientLabel: clientName(a.client) }));
  return filter.status ? withStatus.filter((a) => a.display === filter.status) : withStatus;
}
export type AgreementRow = Awaited<ReturnType<typeof listAgreements>>[number];

export async function agreementDetail(id: string) {
  await expireStale();
  const a = await prisma.clientAgreement.findUnique({ where: { id }, include: { ...LIST_INCLUDE, links: { orderBy: { createdAt: "desc" } }, renews: { select: { id: true, title: true } } } });
  if (!a) return null;
  const history = await prisma.auditLog.findMany({ where: { entityType: "ClientAgreement", entityId: id }, orderBy: { createdAt: "desc" }, include: { actor: { select: { name: true } } }, take: 50 });
  return { ...a, display: displayStatus(a, chicagoToday()), clientLabel: clientName(a.client), history };
}

/** Tabitha's queue on her Owner's Office overview. */
export async function ownerQueue() {
  const [waiting, signed] = await Promise.all([
    prisma.clientAgreement.findMany({ where: { status: "WAITING_FOR_OWNER" }, include: LIST_INCLUDE, orderBy: { requestedAt: "asc" }, take: 20 }),
    prisma.clientAgreement.findMany({ where: { status: { in: ["SIGNED", "DECLINED"] }, OR: [{ signedAt: { gte: new Date(Date.now() - 14 * 86_400_000) } }, { declinedAt: { gte: new Date(Date.now() - 14 * 86_400_000) } }] }, include: LIST_INCLUDE, orderBy: { updatedAt: "desc" }, take: 20 }),
  ]);
  return { waiting: waiting.map((a) => ({ ...a, clientLabel: clientName(a.client) })), recent: signed.map((a) => ({ ...a, clientLabel: clientName(a.client) })) };
}

// --- Client side: portal and secure link ----------------------------------------------------

const OPEN: ClientAgreementStatus[] = ["SENT"];

/** Agreements a portal login may see for one account (never drafts). */
export async function portalAgreementList(user: PortalActor, clientId: string) {
  await requireClientAccess(user.id, clientId, "contracts");
  await expireStale();
  return prisma.clientAgreement.findMany({ where: { clientId, status: { in: ["SENT", "SIGNED", "DECLINED", "EXPIRED"] } }, orderBy: { sentAt: "desc" }, select: { id: true, title: true, status: true, sentAt: true, signedAt: true, declinedAt: true, pdfDocumentId: true, signBy: true } });
}

/** One agreement for a portal login. Same answer for "doesn't exist" and "not yours". */
export async function portalAgreement(user: PortalActor, id: string) {
  const a = await prisma.clientAgreement.findUnique({ where: { id }, include: { client: { select: { displayName: true, businessName: true, clientType: true, email: true, phone: true, addressLine1: true, addressLine2: true, city: true, state: true, postalCode: true, mailingSameAsAddress: true, mailingAddressLine1: true, mailingAddressLine2: true, mailingCity: true, mailingState: true, mailingPostalCode: true } } } });
  if (!a || !["SENT", "SIGNED", "DECLINED", "EXPIRED"].includes(a.status)) throw new ForbiddenError("You don't have access to that agreement.");
  await requireClientAccess(user.id, a.clientId, "contracts").catch(() => {
    throw new ForbiddenError("You don't have access to that agreement.");
  });
  return { ...a, prefill: prefillSigner(a.client) };
}

function prefillSigner(c: { displayName: string; email: string | null; phone: string | null } & Parameters<typeof billingAddressOf>[0]) {
  return { name: c.displayName, email: c.email ?? "", phone: c.phone ?? "", address: formatAddressBlock(billingAddressOf(c)).replace(/\n/g, ", ") };
}

export type LinkState = "OK" | "USED" | "EXPIRED" | "REVOKED" | "CLOSED" | "NOT_FOUND";
export const LINK_MESSAGES: Record<Exclude<LinkState, "OK">, string> = {
  USED: "This signing link was already used. Each link works once.",
  EXPIRED: "This signing link has expired. Ask T. Turner & Associates for a new one.",
  REVOKED: "This signing link was replaced by a newer one. Use the most recent link you received.",
  CLOSED: "This agreement is no longer open for signature.",
  NOT_FOUND: "This link isn't valid.",
};

export async function resolveSigningLink(token: string) {
  const link = token && token.length > 20 ? await prisma.agreementSigningLink.findUnique({ where: { tokenHash: sha(token) }, include: { agreement: { include: { client: true } } } }) : null;
  if (!link) return { state: "NOT_FOUND" as LinkState, link: null };
  let state: LinkState = "OK";
  if (link.usedAt) state = "USED";
  else if (link.revokedAt) state = "REVOKED";
  else if (link.expiresAt < new Date()) state = "EXPIRED";
  else if (!OPEN.includes(link.agreement.status)) state = "CLOSED";
  return { state, link, prefill: prefillSigner(link.agreement.client) };
}

export type SignInput = {
  acknowledged: string[];
  consent: boolean;
  fullName: string;
  address: string;
  phone: string;
  email: string;
  signature: string;
  answers: Record<string, string>;
  shownHash: string;
  ip?: string | null;
  userAgent?: string | null;
};

type Signer = { portalUser: PortalActor } | { token: string };

async function openFor(signer: Signer, id: string | null) {
  if ("portalUser" in signer) {
    const a = await portalAgreement(signer.portalUser, id!);
    return { a, linkId: null as string | null };
  }
  const r = await resolveSigningLink(signer.token);
  if (r.state !== "OK" || !r.link) throw new ValidationError(LINK_MESSAGES[r.state as Exclude<LinkState, "OK">]);
  return { a: r.link.agreement, linkId: r.link.id };
}

/**
 * The client signs: every acknowledgment ticked, the e-sign consent, confirmed name,
 * address, phone and email, the template's questions answered, a typed signature that
 * matches the name, and the fingerprint of the text they were shown. Evidence is
 * recorded, the signed PDF is stored once in Documents › Contracts, and Tabitha sees it.
 */
export async function signClientAgreement(signer: Signer, id: string | null, input: SignInput) {
  const { a, linkId } = await openFor(signer, id);
  if (a.status !== "SENT") throw new ValidationError(a.status === "SIGNED" ? "This agreement is already signed." : "This agreement is no longer open for signature.");
  if (a.signBy && a.signBy < new Date()) throw new ValidationError("The time to sign this agreement has passed. Ask T. Turner & Associates for a new link.");
  const f = a.frozenClauses as unknown as Frozen;
  if (input.shownHash !== a.textHash) throw new ValidationError("This agreement changed since the page loaded. Reload it and review the current text before signing.");
  const acks = f.clauses.filter((c) => c.kind === "ACK").map((c) => c.key);
  const missingAck = acks.filter((k) => !input.acknowledged.includes(k));
  if (missingAck.length) throw new ValidationError(`Tick each acknowledgment to sign (${missingAck.length} not ticked).`);
  if (input.consent !== true) throw new ValidationError("Tick the electronic-signature consent to sign.");
  const name = input.fullName.trim().replace(/\s+/g, " ");
  if (name.length < 3 || !/\s/.test(name)) throw new ValidationError("Enter your full legal name.");
  if (!input.address.trim() || input.address.trim().length < 8) throw new ValidationError("Enter your address.");
  const phone = normalizePhone(input.phone);
  if (!phone) throw new ValidationError("Enter a valid phone number.");
  const email = normalizeEmail(input.email);
  if (!email) throw new ValidationError("Enter a valid email address.");
  if (input.signature.trim().replace(/\s+/g, " ").toLowerCase() !== name.toLowerCase()) throw new ValidationError("Type your full legal name as your signature, exactly as entered above.");
  const answers = f.questions.map((q) => {
    const ans = input.answers[q.key];
    if (!ans || !q.choices.includes(ans)) throw new ValidationError(`Answer: ${q.text}`);
    return { question: q.text, answer: ans };
  });
  const now = new Date();
  const signedAtChicago = now.toLocaleString("en-US", { timeZone: OFFICE_TZ, dateStyle: "long", timeStyle: "long" });
  const dateSigned = now.toLocaleDateString("en-US", { timeZone: OFFICE_TZ, dateStyle: "long" });
  const via = "portalUser" in signer ? "client portal" : "secure signing link";
  const pdf = await renderSignedAgreementPdf(
    { title: f.title, intro: f.intro, clientName: a.client.displayName, clauses: f.clauses },
    { signerName: name, address: input.address.trim().slice(0, 300), phone: input.phone.trim(), email, answers, acknowledged: acks, signedAtChicago, dateSigned, ip: input.ip ?? null, userAgent: input.userAgent ?? null, textHash: a.textHash!, via, templateVersion: `${f.templateKey} v${f.templateVersion}` },
  );
  const stored = await storeDocumentFile(pdf, `${f.title} - signed.pdf`, { system: "agreement" }, undefined);
  await prisma.$transaction(async (tx) => {
    // Claim the agreement (and the link) first: two submissions can't both sign.
    const claimed = await tx.clientAgreement.updateMany({ where: { id: a.id, status: "SENT" }, data: { status: "SIGNED" } });
    if (claimed.count !== 1) throw new ValidationError("This agreement is already signed.");
    if (linkId) {
      const used = await tx.agreementSigningLink.updateMany({ where: { id: linkId, usedAt: null, revokedAt: null }, data: { usedAt: now } });
      if (used.count !== 1) throw new ValidationError(LINK_MESSAGES.USED);
    }
    const file = await tx.storedFile.create({ data: stored.fileData });
    const doc = await tx.document.create({
      data: { clientId: a.clientId, category: "CONTRACTS", title: `${f.title} (signed ${dateSigned})`, year: a.taxYear, docType: "CLIENT_AGREEMENT", visibility: "PUBLISHED", publishedAt: now, fileId: file.id, scanStatus: stored.scan, ...stored.scanMeta, retainUntil: await retentionDate("CONTRACTS") },
    });
    await tx.clientAgreement.update({
      where: { id: a.id },
      data: { signedAt: now, signerName: name, signerAddress: input.address.trim().slice(0, 300), signerPhone: phone, signerEmail: email, signerAnswers: answers, acknowledgments: acks, signerIp: input.ip?.slice(0, 64) ?? null, signerAgent: input.userAgent?.slice(0, 300) ?? null, signedByPortalId: "portalUser" in signer ? signer.portalUser.id : null, signedViaLinkId: linkId, pdfDocumentId: doc.id },
    });
    await audit(tx, { actorId: null, action: "agreement_center.signed", entityType: "ClientAgreement", entityId: a.id, clientId: a.clientId, details: { via, portalUserId: "portalUser" in signer ? signer.portalUser.id : null, linkId, textHash: a.textHash, documentId: doc.id, ip: input.ip?.slice(0, 64) ?? null } });
  });
  return { ok: true as const };
}

/** The client declines with a reason. Tabitha sees it on her overview. */
export async function declineClientAgreement(signer: Signer, id: string | null, reason: string) {
  const { a, linkId } = await openFor(signer, id);
  if (a.status !== "SENT") throw new ValidationError("This agreement is no longer open.");
  if (reason.trim().length < 3) throw new ValidationError("Tell us briefly why you're declining.");
  const now = new Date();
  await prisma.$transaction(async (tx) => {
    const res = await tx.clientAgreement.updateMany({ where: { id: a.id, status: "SENT" }, data: { status: "DECLINED", declinedAt: now, declineReason: reason.trim().slice(0, 500) } });
    if (res.count !== 1) throw new ValidationError("This agreement is no longer open.");
    if (linkId) await tx.agreementSigningLink.updateMany({ where: { id: linkId, usedAt: null }, data: { usedAt: now } });
    await audit(tx, { actorId: null, action: "agreement_center.declined", entityType: "ClientAgreement", entityId: a.id, clientId: a.clientId, details: { portalUserId: "portalUser" in signer ? signer.portalUser.id : null, linkId } });
  });
}

// --- Add invoice to this agreement -------------------------------------------------------------

/**
 * Drafts invoices in the existing Owner's Office invoice system from the agreement's fees.
 * With a payment schedule, each payment (deposit, then each installment) is its own draft
 * invoice due on its date — the invoice model's plan installments are equal and evenly spaced,
 * so a schedule with its own amounts and dates becomes separate invoices. Without one, one
 * invoice carries every fee as a line. Nothing is sent.
 */
export async function addInvoiceToAgreement(actor: Actor, id: string) {
  const a = await prisma.clientAgreement.findUnique({ where: { id }, include: { invoices: { select: { id: true } } } });
  if (!a || a.status === "VOID") throw new ValidationError("Agreement not found.");
  if (a.invoices.length) throw new ValidationError("This agreement already has its invoice. Open it from the agreement.");
  const o = a.options as unknown as AgreementOptions;
  const fees = o.fees.filter((f) => f.label && f.cents > 0);
  if (!fees.length) throw new ValidationError("Enter the agreement's fees first.");
  const today = todayYmd();
  const base = { clientId: a.clientId, memo: `From agreement: ${a.title}`, paymentTerms: null, privateNote: null, allowFull: true, allowPlan: false, depositType: "NONE" as const, depositValue: 0, discountType: "NONE" as const, discountValue: 0, discountCoversPlanFee: false, taxRateBps: 0, planInstallments: 2, planFirstDueDate: null, planIntervalMonths: 1 };
  const plan: { title: string; due: string; lines: { service: string; description: string | null; quantity: number; unitCents: number }[] }[] = [];
  const scheduled = [...(o.depositCents > 0 ? [{ cents: o.depositCents, date: today, label: "Deposit due at signing" }] : []), ...o.installments.filter((i) => i.cents > 0 && i.date).map((i, n) => ({ cents: i.cents, date: i.date, label: `Installment ${n + 1} of ${o.installments.length}` }))];
  if (scheduled.length > 1) {
    for (const s of scheduled) plan.push({ title: `${a.title} — ${s.label}`, due: s.date, lines: [{ service: s.label, description: a.title, quantity: 1, unitCents: s.cents }] });
  } else {
    const due = o.startDate && o.startDate > today ? o.startDate : today;
    plan.push({ title: a.title, due, lines: fees.map((f) => ({ service: f.label, description: o.feeStructure === "MONTHLY" ? "Monthly fee (first month)" : o.feeStructure === "HOURLY" ? "Hourly rate (1 hour; update the quantity)" : null, quantity: 1, unitCents: f.cents })) });
  }
  const made: { id: string; number: string }[] = [];
  for (const p of plan) {
    const issue = p.due < today ? p.due : today;
    const inv = await createQuote(actor, { ...base, title: p.title, issueDate: issue, dueDate: p.due, lines: p.lines });
    await prisma.invoice.update({ where: { id: inv.id }, data: { agreementId: a.id, formType: "INVOICE" } });
    made.push({ id: inv.id, number: inv.number });
  }
  await audit(prisma, { actorId: actor.id, action: "agreement_center.invoice_added", entityType: "ClientAgreement", entityId: a.id, clientId: a.clientId, details: { invoices: made.map((m) => m.number) } });
  return made;
}

// --- Bulk ------------------------------------------------------------------------------------------

export const BULK_FILTERS = { ACTIVE_BOOKKEEPING: "Active bookkeeping clients", ACTIVE_PAYROLL: "Active payroll clients", ACTIVE_CLIENTS: "All active clients" } as const;

export async function bulkCandidates(filter: string) {
  const where: Prisma.ClientWhereInput =
    filter === "ACTIVE_BOOKKEEPING" ? { bookkeepingProfile: { active: true } } : filter === "ACTIVE_PAYROLL" ? { bookkeepingProfile: { active: true, payroll: true } } : { status: "ACTIVE" };
  const rows = await prisma.client.findMany({ where: { archivedAt: null, ...where }, select: { id: true, displayName: true, businessName: true, clientType: true, bookkeepingBilling: { select: { monthlyFeeCents: true } } }, orderBy: { displayName: "asc" }, take: 300 });
  return rows.map((r) => ({ id: r.id, label: clientName(r), monthlyFeeCents: r.bookkeepingBilling?.monthlyFeeCents ?? null }));
}

/** One draft per client, each with its own fees prefilled. Nothing is sent. */
export async function bulkCreate(actor: Actor, templateKey: string, clientIds: string[]) {
  const ids = [...new Set(clientIds)].slice(0, 200);
  if (!ids.length) throw new ValidationError("Select at least one client.");
  await templateByKey(templateKey);
  const batch = `bulk_${randomBytes(8).toString("hex")}`;
  for (const clientId of ids) await createAgreement(actor, { clientId, templateKey, bulkBatchId: batch });
  return batch;
}

export async function bulkBatch(batchId: string) {
  const rows = await prisma.clientAgreement.findMany({ where: { bulkBatchId: batchId }, include: LIST_INCLUDE, orderBy: { createdAt: "asc" } });
  const out = [];
  for (const a of rows) {
    const c = await prisma.clientAgreement.findUniqueOrThrow({ where: { id: a.id }, include: { client: { select: { displayName: true, businessName: true, clientType: true } } } });
    const blockers = a.status === "DRAFT" || a.status === "WAITING_FOR_OWNER" ? await sendBlockers(c) : [];
    const o = a.options as unknown as AgreementOptions;
    out.push({ ...a, clientLabel: clientName(a.client), feeCents: o.fees.reduce((s, f) => s + f.cents, 0), blockers, hasPortal: (await portalRecipients(a.clientId)).length > 0 });
  }
  return out;
}

// --- Renewals -------------------------------------------------------------------------------------

/** "Prepare renewal (+X%)": a new draft starting the day after the term ends, fees increased. Never sent automatically. */
export async function prepareRenewal(actor: Actor, id: string) {
  const a = await prisma.clientAgreement.findUnique({ where: { id }, include: { template: true, renewals: { where: { status: { not: "VOID" } }, select: { id: true } } } });
  if (!a || a.status !== "SIGNED" || !a.termEndDate) throw new ValidationError("Only a signed agreement with a term can be renewed.");
  if (a.renewals.length) throw new ValidationError("A renewal is already prepared for this agreement.");
  const o = a.options as unknown as AgreementOptions;
  const pct = o.renewalIncreasePct ?? 3;
  const bump = (c: number) => Math.round(c * (1 + pct / 100));
  const start = new Date(a.termEndDate);
  start.setUTCDate(start.getUTCDate() + 1);
  const next: AgreementOptions = { ...o, fees: o.fees.map((f) => ({ ...f, cents: bump(f.cents) })), startDate: start.toISOString().slice(0, 10), depositCents: 0, installments: [], invoiceNumber: "" };
  return createAgreement(actor, { clientId: a.clientId, templateKey: a.template.key, options: next, title: a.title, renewsId: a.id });
}

// --- Gate: tax work and services -----------------------------------------------------------------

/** A signed agreement covering this service (and, for tax services, this tax year), or null. */
export async function coveringAgreement(clientId: string, type: ServiceType, taxYear: number | null) {
  const tax = (TAX_SERVICES as string[]).includes(type);
  return prisma.clientAgreement.findFirst({
    where: { clientId, status: "SIGNED", serviceTypes: { has: type }, ...(tax && taxYear ? { taxYear } : {}) },
    select: { id: true, title: true, signedAt: true },
    orderBy: { signedAt: "desc" },
  });
}
