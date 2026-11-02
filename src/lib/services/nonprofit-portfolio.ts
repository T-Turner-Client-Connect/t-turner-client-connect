import "server-only";
import { prisma } from "@/lib/prisma";
import { audit } from "@/lib/audit";
import { ForbiddenError, type Actor } from "@/lib/auth/actor";
import type { PortalActor } from "@/lib/portal/session";
import { requireClientAccess } from "@/lib/portal/access";
import { sendEmail } from "@/lib/email";
import { appUrl } from "@/lib/integrations";
import { STATES } from "@/lib/resources/catalog";
import { officeToday, daysBetween } from "@/lib/tax/deadlines";
import { assertOwner } from "@/lib/auth/owner";
import { ValidationError } from "./clients";
import { createService, prepareAgreement, startGate } from "./service-agreements";
import { staffUploadDocument } from "./documents";
import { latestEndedTaxYear, nonprofitDueDate, NONPROFIT_FORMS } from "./nonprofits";

/**
 * Nonprofit Formation & Compliance Center. Each nonprofit organization record
 * (its own Client of type Nonprofit, linked to its owner as in PR #31) has one
 * portfolio: formation facts, federal classification and IRS application
 * history, Attorney General and SAM.gov status, and a document checklist.
 * Files start staff-only; only a staff release (never a draft) puts one in the
 * client's portal, and the client is emailed a sign-in link — never the file.
 */

export const BUSINESS_NAME = "T. Turner & Associates, LLC";

export const ITEM_STATUS = {
  NOT_STARTED: "Not Started",
  INFORMATION_NEEDED: "Information Needed",
  PREPARING: "Preparing",
  READY_FOR_REVIEW: "Ready for Review",
  SUBMITTED: "Submitted",
  AWAITING_GOVERNMENT: "Awaiting Government Response",
  APPROVED_FILED: "Approved / Filed",
  COMPLETED: "Completed",
  DELIVERED: "Delivered to Client",
  NOT_APPLICABLE: "Not Applicable",
} as const;
export type ItemStatus = keyof typeof ITEM_STATUS;
/** Statuses that count as done on the progress bar. */
export const DONE: ItemStatus[] = ["APPROVED_FILED", "COMPLETED", "DELIVERED"];

export const ORIGINS = {
  GOVERNMENT_ISSUED: "Government-issued",
  FINAL_PREPARED: "Final (prepared by us)",
  CLIENT_PREPARED: "Client-prepared",
  INTERNAL_DRAFT: "Internal draft (never released)",
} as const;
export type Origin = keyof typeof ORIGINS;

export const CATEGORIES = { STATE: "State", FEDERAL: "Federal", GOVERNANCE: "Governance", GRANT: "Grant readiness", OTHER: "Other" } as const;

/** Portfolio sections, in the order clients see them. */
export const SECTIONS = {
  FORMATION: "Formation documents",
  IRS: "IRS exemption",
  STATE: "State filings",
  SAM: "SAM.gov / UEI",
  GRANT: "Grant readiness",
  OTHER: "Other documents",
} as const;
export type Section = keyof typeof SECTIONS;

const FORMATION_KEYS = ["sos_formation", "state_formation", "ein", "incorporator_statement", "org_minutes", "bylaws", "bank_resolution"];
/** Section for a state-template item (templates are grouped by category; formation documents span several). */
export function sectionFor(item: { key: string; category: string; section?: string }): Section {
  if (item.section && item.section in SECTIONS) return item.section as Section;
  if (FORMATION_KEYS.includes(item.key) || item.category === "GOVERNANCE") return "FORMATION";
  if (item.key.startsWith("irs_")) return "IRS";
  if (item.category === "STATE") return "STATE";
  if (item.category === "GRANT") return "GRANT";
  return "OTHER";
}

export const GRANT_DISCLAIMER = {
  title: "GRANT ASSISTANCE & FUNDING DISCLAIMER",
  text: [
    "T. Turner & Associates, LLC provides nonprofit formation, organizational documentation, SAM.gov registration assistance, and grant-readiness preparation services as described in the client's selected service agreement.",
    "Grant research, grant writing, grant application preparation, and grant submissions are not included unless separately agreed to in writing.",
    "T. Turner & Associates, LLC may offer limited additional grant assistance when time and availability permit, at its sole discretion.",
    "T. Turner & Associates, LLC does not guarantee grant eligibility, grant approval, grant awards, funding amounts, or funding timelines.",
    "The organization remains responsible for its grant applications, supporting information, compliance requirements, and funding decisions.",
  ].join("\n\n"),
};

export const IRS_EVENTS = {
  SUBMITTED: "Submitted to the IRS",
  PENDING_REVIEW: "Pending IRS review",
  INFO_REQUESTED: "IRS requested more information",
  INFO_RESPONDED: "Response sent to the IRS",
  APPROVED: "Approved",
  DENIED: "Denied",
  DETERMINATION_LETTER_RECEIVED: "Determination letter received",
  WITHDRAWN: "Withdrawn",
} as const;

export const AG_STATUS = { REVIEW_NEEDED: "Review needed", REQUIRED: "Registration required", REGISTERED: "Registered", EXEMPT: "Exempt (reason recorded)", NOT_APPLICABLE: "Not applicable" } as const;
export const SAM_STATUS = { NOT_STARTED: "Not started", IN_PROGRESS: "In progress", ACTIVE: "Active", EXPIRED: "Expired", NOT_APPLICABLE: "Not applicable" } as const;

export type TemplateItem = { key: string; label: string; category: keyof typeof CATEGORIES; required: boolean; note?: string; sourceUrl?: string | null };

/** For states without a verified template: general items to check, worded so nothing is claimed about that state. */
export function baselineTemplate(stateName: string): TemplateItem[] {
  return [
    { key: "state_formation", label: `Formation filing with the ${stateName} business filing office`, category: "STATE", required: true, note: "Confirm the filing, form and fee on the state's official site." },
    { key: "ein", label: "EIN confirmation (IRS)", category: "FEDERAL", required: true },
    { key: "incorporator_statement", label: "Statement of Incorporation / Incorporator Statement", category: "GOVERNANCE", required: true },
    { key: "org_minutes", label: "Organizational meeting minutes", category: "GOVERNANCE", required: true },
    { key: "bylaws", label: "Corporate bylaws", category: "GOVERNANCE", required: true },
    { key: "bank_resolution", label: "Banking resolution", category: "GOVERNANCE", required: true },
    { key: "irs_application", label: "Federal tax-exemption application (form depends on the classification)", category: "FEDERAL", required: true },
    { key: "irs_submission", label: "IRS application submission confirmation", category: "FEDERAL", required: true },
    { key: "irs_determination", label: "IRS determination letter (when issued)", category: "FEDERAL", required: true },
    { key: "charitable_registration", label: `Charitable solicitation registration — requirement or exemption review (${stateName})`, category: "STATE", required: false, note: "Some states require registration before soliciting; exemptions may apply. Record the review result." },
    { key: "state_annual", label: `Annual state filings and renewals review (${stateName})`, category: "STATE", required: true, note: "Confirm which annual reports, renewals and state tax filings apply." },
  ];
}

const stateName = (code: string) => STATES.find((s) => s.code === code)?.name ?? null;

/** The template for a state: its saved (owner-editable) template, or the general baseline, marked as such. */
export async function stateTemplate(code: string) {
  const name = stateName(code);
  if (!name) throw new ValidationError("Choose a state.");
  const t = await prisma.nonprofitStateTemplate.findUnique({ where: { state: code } });
  if (t) return { state: code, name, items: t.items as unknown as TemplateItem[], saved: true, verifiedAt: t.verifiedAt, verifiedNote: t.verifiedNote };
  return { state: code, name, items: baselineTemplate(name), saved: false, verifiedAt: null, verifiedNote: null };
}

/** Owner or staff confirm a state's template against the official source (or edit it). */
export async function saveStateTemplate(actor: Actor, code: string, input: { items: TemplateItem[]; verifiedNote?: string; markVerified: boolean }) {
  if (!stateName(code)) throw new ValidationError("Choose a state.");
  if (!input.items.length || input.items.some((i) => !i.key || !i.label)) throw new ValidationError("Each requirement needs a key and a description.");
  if (input.markVerified && (!input.verifiedNote || input.verifiedNote.trim().length < 10)) throw new ValidationError("Record which official sources you checked and when.");
  const data = { items: input.items, verifiedAt: input.markVerified ? new Date() : null, verifiedNote: input.verifiedNote?.trim().slice(0, 1000) || null, updatedById: actor.id };
  await prisma.nonprofitStateTemplate.upsert({ where: { state: code }, create: { state: code, ...data }, update: data });
  await audit(prisma, { actorId: actor.id, action: "nonprofit.state_template_saved", entityType: "NonprofitStateTemplate", entityId: code, details: { items: input.items.length, verified: input.markVerified } });
}

export async function classifications(includeInactive = false) {
  return prisma.nonprofitClassification.findMany({ where: includeInactive ? {} : { active: true }, orderBy: { sortOrder: "asc" } });
}

export async function saveClassification(actor: Actor, key: string, input: { label: string; process: string; form?: string; sourceUrl?: string; active: boolean; verifiedNote?: string; markVerified: boolean }) {
  if (!/^[A-Z0-9_]{2,20}$/.test(key)) throw new ValidationError("Use a short key like 501C3.");
  if (!input.label.trim() || !input.process.trim()) throw new ValidationError("Enter the classification and its IRS process.");
  if (input.markVerified && (!input.verifiedNote || input.verifiedNote.trim().length < 10)) throw new ValidationError("Record which IRS page you checked and when.");
  const data = { label: input.label.trim().slice(0, 120), process: input.process.trim().slice(0, 1000), form: input.form?.trim() || null, sourceUrl: input.sourceUrl?.trim() || null, active: input.active, verifiedAt: input.markVerified ? new Date() : null, verifiedNote: input.verifiedNote?.trim() || null };
  const max = await prisma.nonprofitClassification.aggregate({ _max: { sortOrder: true } });
  await prisma.nonprofitClassification.upsert({ where: { key }, create: { key, ...data, sortOrder: (max._max.sortOrder ?? 0) + 1 }, update: data });
  await audit(prisma, { actorId: actor.id, action: "nonprofit.classification_saved", entityType: "NonprofitClassification", entityId: key, details: { active: input.active, verified: input.markVerified } });
}

// --- Portfolio -----------------------------------------------------------------

async function org(orgId: string) {
  const c = await prisma.client.findUnique({ where: { id: orgId }, select: { id: true, displayName: true, businessName: true, clientType: true, archivedAt: true } });
  if (!c || c.archivedAt || c.clientType !== "NONPROFIT") throw new ValidationError("Choose a nonprofit organization record.");
  return c;
}

/** Opens (creating if needed) the organization's portfolio. */
export async function ensurePortfolio(actor: Actor, orgId: string) {
  const c = await org(orgId);
  const existing = await prisma.nonprofitPortfolio.findUnique({ where: { clientId: c.id } });
  if (existing) return existing;
  const p = await prisma.nonprofitPortfolio.create({ data: { clientId: c.id, legalName: c.businessName || c.displayName, agStatus: "REVIEW_NEEDED", updatedById: actor.id } });
  await audit(prisma, { actorId: actor.id, action: "nonprofit.portfolio_opened", entityType: "NonprofitPortfolio", entityId: c.id, clientId: c.id });
  return p;
}

export async function portfolio(orgId: string) {
  return prisma.nonprofitPortfolio.findUnique({
    where: { clientId: orgId },
    include: {
      client: { select: { id: true, displayName: true, businessName: true, fiscalYearEnd: true, nonprofitProfile: true } },
      officers: { where: { removedAt: null }, orderBy: { createdAt: "asc" } },
      irsEvents: { orderBy: { at: "desc" } },
      items: { orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }], include: { files: { orderBy: { createdAt: "desc" } } } },
    },
  });
}

const d = (v: string | undefined) => (v ? new Date(`${v}T12:00:00Z`) : null);

export async function savePortfolio(actor: Actor, orgId: string, f: Record<string, string | undefined>) {
  await ensurePortfolio(actor, orgId);
  const state = f.formationState?.trim().toUpperCase() || null;
  if (state && !stateName(state)) throw new ValidationError("Choose the state of formation.");
  const ein = f.ein?.trim() || null;
  if (ein && !/^\d{2}-?\d{7}$/.test(ein)) throw new ValidationError("Enter the EIN as 12-3456789.");
  const uei = f.uei?.trim().toUpperCase() || null;
  if (uei && !/^[A-Z0-9]{12}$/.test(uei)) throw new ValidationError("A Unique Entity ID is 12 letters and numbers.");
  if (f.classification && !(await prisma.nonprofitClassification.count({ where: { key: f.classification } }))) throw new ValidationError("Choose a classification from the list.");
  if (f.agStatus && !(f.agStatus in AG_STATUS)) throw new ValidationError("Choose the Attorney General status.");
  if (f.agStatus === "EXEMPT" && !f.agNote?.trim()) throw new ValidationError("Record the exemption that applies and how it was confirmed.");
  if (f.samStatus && !(f.samStatus in SAM_STATUS)) throw new ValidationError("Choose the SAM.gov status.");
  const data = {
    legalName: f.legalName?.trim() || null,
    formationState: state,
    formationDate: d(f.formationDate),
    ein: ein ? `${ein.replace("-", "").slice(0, 2)}-${ein.replace("-", "").slice(2)}` : null,
    sosEntityNumber: f.sosEntityNumber?.trim() || null,
    sosFilingDate: d(f.sosFilingDate),
    registeredAgent: f.registeredAgent?.trim() || null,
    registeredAgentAddress: f.registeredAgentAddress?.trim() || null,
    classification: f.classification || null,
    agStatus: f.agStatus || null,
    agNote: f.agNote?.trim() || null,
    agRenewalDate: d(f.agRenewalDate),
    samStatus: f.samStatus || null,
    uei,
    samExpiresOn: d(f.samExpiresOn),
    mission: f.mission?.trim().slice(0, 2000) || null,
    programs: f.programs?.trim().slice(0, 2000) || null,
    updatedById: actor.id,
  };
  await prisma.nonprofitPortfolio.update({ where: { clientId: orgId }, data });
  await audit(prisma, { actorId: actor.id, action: "nonprofit.portfolio_saved", entityType: "NonprofitPortfolio", entityId: orgId, clientId: orgId, details: { fields: Object.keys(data).filter((k) => data[k as keyof typeof data] !== null) } });
}

export async function addOfficer(actor: Actor, orgId: string, input: { name: string; role: string; termStart?: string; termEnd?: string }) {
  await ensurePortfolio(actor, orgId);
  if (!input.name.trim() || !input.role.trim()) throw new ValidationError("Enter the name and role.");
  await prisma.nonprofitOfficer.create({ data: { portfolioId: orgId, name: input.name.trim().slice(0, 120), role: input.role.trim().slice(0, 60), termStart: d(input.termStart), termEnd: d(input.termEnd) } });
  await audit(prisma, { actorId: actor.id, action: "nonprofit.officer_added", entityType: "NonprofitPortfolio", entityId: orgId, clientId: orgId, details: { role: input.role.trim() } });
}

export async function removeOfficer(actor: Actor, officerId: string) {
  const o = await prisma.nonprofitOfficer.findUnique({ where: { id: officerId } });
  if (!o) throw new ValidationError("Not found.");
  await prisma.nonprofitOfficer.update({ where: { id: o.id }, data: { removedAt: new Date() } });
  await audit(prisma, { actorId: actor.id, action: "nonprofit.officer_removed", entityType: "NonprofitPortfolio", entityId: o.portfolioId, clientId: o.portfolioId, details: { role: o.role } });
}

/** Each IRS step is its own dated entry; submitted, pending, info requested, approved, denied and the letter stay separate. */
export async function recordIrsEvent(actor: Actor, orgId: string, input: { kind: string; at: Date | null; note?: string; reference?: string }) {
  await ensurePortfolio(actor, orgId);
  if (!(input.kind in IRS_EVENTS)) throw new ValidationError("Choose the IRS step.");
  if (!input.at) throw new ValidationError("Enter the date.");
  const e = await prisma.nonprofitIrsEvent.create({ data: { portfolioId: orgId, kind: input.kind, at: input.at, note: input.note?.trim() || null, reference: input.reference?.trim() || null, byId: actor.id } });
  await audit(prisma, { actorId: actor.id, action: "nonprofit.irs_event", entityType: "NonprofitPortfolio", entityId: orgId, clientId: orgId, details: { kind: input.kind } });
  return e;
}

export const irsStatus = (events: { kind: string; at: Date }[]) => (events.length ? [...events].sort((a, b) => b.at.getTime() - a.at.getTime())[0].kind : null);

// --- Checklist -----------------------------------------------------------------

/** Adds the state's requirements to the checklist (items already there are left alone). */
export async function applyStateTemplate(actor: Actor, orgId: string, state: string) {
  await ensurePortfolio(actor, orgId);
  const t = await stateTemplate(state);
  const have = await prisma.nonprofitChecklistItem.findMany({ where: { portfolioId: orgId }, select: { templateKey: true } });
  const keys = new Set(have.map((h) => h.templateKey));
  const fresh = t.items.filter((item) => !keys.has(item.key));
  if (fresh.length) {
    await prisma.nonprofitChecklistItem.createMany({
      data: fresh.map((item, i) => ({ portfolioId: orgId, templateKey: item.key, label: item.label, category: item.category, section: sectionFor(item), requirement: true, sortOrder: have.length + i })),
      skipDuplicates: true,
    });
  }
  // Package documents that are also government requirements are flagged as both (one item, not two).
  await prisma.nonprofitChecklistItem.updateMany({ where: { portfolioId: orgId, templateKey: { in: t.items.map((i) => i.key) } }, data: { requirement: true } });
  const added = fresh.length;
  await prisma.nonprofitPortfolio.update({ where: { clientId: orgId }, data: { formationState: state } });
  await audit(prisma, { actorId: actor.id, action: "nonprofit.template_applied", entityType: "NonprofitPortfolio", entityId: orgId, clientId: orgId, details: { state, added, verified: !!t.verifiedAt } });
  return { added, verified: !!t.verifiedAt, baseline: !t.saved };
}

export async function addChecklistItem(actor: Actor, orgId: string, input: { label: string; category: string; section?: string }) {
  await ensurePortfolio(actor, orgId);
  if (!input.label.trim()) throw new ValidationError("Describe the document.");
  const category = input.category in CATEGORIES ? input.category : "OTHER";
  const n = await prisma.nonprofitChecklistItem.count({ where: { portfolioId: orgId } });
  const section = input.section && input.section in SECTIONS ? input.section : sectionFor({ key: "", category });
  const item = await prisma.nonprofitChecklistItem.create({ data: { portfolioId: orgId, label: input.label.trim().slice(0, 200), category, section, sortOrder: n } });
  await audit(prisma, { actorId: actor.id, action: "nonprofit.item_added", entityType: "NonprofitChecklistItem", entityId: item.id, clientId: orgId, details: { label: item.label } });
  return item;
}

export async function updateChecklistItem(actor: Actor, itemId: string, input: { status: string; responsibleId?: string | null; filingReference?: string; staffNote?: string }) {
  const item = await prisma.nonprofitChecklistItem.findUnique({ where: { id: itemId } });
  if (!item) throw new ValidationError("Not found.");
  if (!(input.status in ITEM_STATUS)) throw new ValidationError("Choose a status.");
  if (input.status === "DELIVERED" && !(await prisma.nonprofitItemFile.count({ where: { itemId, releasedAt: { not: null } } }))) throw new ValidationError("Release a document to the client before marking it delivered.");
  if (!["NOT_STARTED", "INFORMATION_NEEDED", "NOT_APPLICABLE"].includes(input.status)) await assertWorkMayBegin(item.portfolioId);
  if (input.responsibleId && !(await prisma.user.count({ where: { id: input.responsibleId, active: true } }))) throw new ValidationError("Choose an active staff member.");
  const done = DONE.includes(input.status as ItemStatus);
  await prisma.nonprofitChecklistItem.update({
    where: { id: itemId },
    data: { status: input.status, responsibleId: input.responsibleId ?? item.responsibleId, filingReference: input.filingReference?.trim() || item.filingReference, staffNote: input.staffNote?.trim() || item.staffNote, completedAt: done ? item.completedAt ?? new Date() : null },
  });
  await audit(prisma, { actorId: actor.id, action: "nonprofit.item_status", entityType: "NonprofitChecklistItem", entityId: itemId, clientId: item.portfolioId, details: { from: item.status, to: input.status } });
}

/** Saves the original file on its checklist item, staff-only. Releasing it is a separate step. */
export async function uploadItemFile(actor: Actor, itemId: string, input: { origin: string; bytes: Uint8Array; originalName: string }) {
  const item = await prisma.nonprofitChecklistItem.findUnique({ where: { id: itemId } });
  if (!item) throw new ValidationError("Not found.");
  if (!(input.origin in ORIGINS)) throw new ValidationError("Say whether this is government-issued, a final document we prepared, client-prepared or an internal draft.");
  const doc = await staffUploadDocument(actor, { clientId: item.portfolioId, category: "OTHER", title: item.label, visibility: "STAFF_ONLY", docType: "NONPROFIT_ITEM", bytes: input.bytes, originalName: input.originalName, allowOffice: true });
  const f = await prisma.nonprofitItemFile.create({ data: { itemId, documentId: doc.id, origin: input.origin, uploadedById: actor.id } });
  await audit(prisma, { actorId: actor.id, action: "nonprofit.item_file_uploaded", entityType: "NonprofitChecklistItem", entityId: itemId, clientId: item.portfolioId, details: { documentId: doc.id, origin: input.origin } });
  return f;
}

type ReleaseResult = { sent: number; failed: number; skipped: number };

/**
 * Releases a finished document to the client: it appears in their portfolio,
 * the item is marked Delivered to Client, and each portal user with access who
 * accepts email is sent a sign-in link (never the document). Drafts can't be released.
 */
export async function releaseItemFile(actor: Actor, fileId: string): Promise<ReleaseResult> {
  const f = await prisma.nonprofitItemFile.findUnique({ where: { id: fileId }, include: { item: true } });
  if (!f) throw new ValidationError("Not found.");
  if (f.origin === "INTERNAL_DRAFT") throw new ValidationError("Internal drafts are never released to the client. Upload the final version.");
  if (f.releasedAt) throw new ValidationError("Already released. Use Resend notice to email the client again.");
  await assertWorkMayBegin(f.item.portfolioId);
  const doc = await prisma.document.findUniqueOrThrow({ where: { id: f.documentId } });
  if (doc.deletedAt) throw new ValidationError("This file was deleted.");
  if (doc.scanStatus !== "CLEAN") throw new ValidationError("This file hasn't passed the malware scan yet, so it can't be released.");
  const now = new Date();
  const claimed = await prisma.nonprofitItemFile.updateMany({ where: { id: f.id, releasedAt: null }, data: { releasedAt: now, releasedById: actor.id } });
  if (claimed.count !== 1) throw new ValidationError("Already released.");
  await prisma.document.update({ where: { id: doc.id }, data: { visibility: "PUBLISHED", publishedAt: now } });
  await prisma.nonprofitChecklistItem.update({ where: { id: f.itemId }, data: { status: "DELIVERED", completedAt: f.item.completedAt ?? now } });
  await audit(prisma, { actorId: actor.id, action: "nonprofit.item_released", entityType: "NonprofitChecklistItem", entityId: f.itemId, clientId: f.item.portfolioId, details: { documentId: doc.id, origin: f.origin } });
  return notifyRelease(f.id, false);
}

/** Emails the client again about a released document (logged; no duplicates unless resent on purpose). */
export async function resendReleaseNotice(actor: Actor, fileId: string) {
  const f = await prisma.nonprofitItemFile.findUnique({ where: { id: fileId }, include: { item: true } });
  if (!f?.releasedAt) throw new ValidationError("Release the document first.");
  await audit(prisma, { actorId: actor.id, action: "nonprofit.release_notice_resent", entityType: "NonprofitChecklistItem", entityId: f.itemId, clientId: f.item.portfolioId });
  return notifyRelease(f.id, true);
}

export function releaseEmail(orgName: string, itemLabel: string) {
  const subject = `Your Nonprofit Formation Update — ${itemLabel} Completed`;
  const text = `Your ${itemLabel} documentation for ${orgName} has been completed and added to your nonprofit portfolio.\n\nSign in to TTurner Client Connect to view, download, or print your document: ${appUrl()}/client/nonprofit\n\nFor your security, documents are never attached to email.\n\n${BUSINESS_NAME}`;
  return { subject, text };
}

async function notifyRelease(fileId: string, resend: boolean): Promise<ReleaseResult> {
  const f = await prisma.nonprofitItemFile.findUniqueOrThrow({ where: { id: fileId }, include: { item: { include: { portfolio: { include: { client: { select: { displayName: true, businessName: true } } } } } } } });
  const orgId = f.item.portfolioId;
  const name = f.item.portfolio.legalName || f.item.portfolio.client.businessName || f.item.portfolio.client.displayName;
  const access = await prisma.portalAccess.findMany({ where: { clientId: orgId, revokedAt: null }, include: { portalUser: true } });
  const { subject, text } = releaseEmail(name, f.item.label);
  const r: ReleaseResult = { sent: 0, failed: 0, skipped: 0 };
  for (const a of access) {
    const u = a.portalUser;
    if (!u.active || !u.passwordHash || !u.notifyByEmail) {
      r.skipped++;
      continue;
    }
    const attempt = resend ? await prisma.notification.count({ where: { portalUserId: u.id, idempotencyKey: { startsWith: `np-release:${fileId}:${u.id}:` } } }) : 0;
    const key = `np-release:${fileId}:${u.id}:${attempt}`;
    const n = await prisma.notification.create({ data: { portalUserId: u.id, channel: "EMAIL", kind: "NONPROFIT_DOCUMENT", idempotencyKey: key, status: "PENDING" } }).catch(() => null);
    if (!n) continue; // already notified for this release
    const res = await sendEmail({ to: u.email, subject, text, idempotencyKey: key, tags: { category: "nonprofit_update" } });
    await prisma.notification.update({ where: { id: n.id }, data: res.ok ? { status: "SENT", sentAt: new Date(), statusDetail: subject } : { status: "FAILED", statusDetail: `${subject} — ${res.detail}` } });
    if (res.ok) r.sent++;
    else r.failed++;
  }
  return r;
}

/** Delivery history for released documents (communication history on the staff page). */
export async function releaseNotices(orgId: string) {
  const files = await prisma.nonprofitItemFile.findMany({ where: { item: { portfolioId: orgId }, releasedAt: { not: null } }, select: { id: true } });
  if (!files.length) return [];
  return prisma.notification.findMany({
    where: { kind: "NONPROFIT_DOCUMENT", OR: files.map((f) => ({ idempotencyKey: { startsWith: `np-release:${f.id}:` } })) },
    include: { portalUser: { select: { email: true } } },
    orderBy: { createdAt: "desc" },
    take: 50,
  });
}

// --- Formation packages -------------------------------------------------------------

export type PackageDeliverable = { key: string; label: string; section: Section };

export async function packages(includeInactive = false) {
  return prisma.nonprofitPackage.findMany({ where: includeInactive ? {} : { active: true }, orderBy: { sortOrder: "asc" } });
}

/** Owner: edit a package — name, price, price note, state prices, government-fee handling, deliverables, grant disclaimer. */
export async function savePackage(actor: Actor, key: string, input: { name: string; priceCents: number; priceNote?: string; statePrices?: Record<string, number>; govFeesMode: string; deliverables: PackageDeliverable[]; grantDisclaimer: boolean; active: boolean }) {
  await assertOwner(actor, "full");
  if (!/^[A-Z0-9_]{2,30}$/.test(key)) throw new ValidationError("Use a short key like AL_BASIC.");
  if (!input.name.trim()) throw new ValidationError("Name the package.");
  if (!Number.isInteger(input.priceCents) || input.priceCents <= 0) throw new ValidationError("Enter the package price.");
  if (!["INCLUDED", "ADDED"].includes(input.govFeesMode)) throw new ValidationError("Say whether government filing fees are included in the price or added to it.");
  if (!input.deliverables.length || input.deliverables.some((d) => !d.key || !d.label || !(d.section in SECTIONS))) throw new ValidationError("Each deliverable needs a key, a description and a section.");
  for (const [st, cents] of Object.entries(input.statePrices ?? {})) {
    if (!stateName(st) || !Number.isInteger(cents) || cents <= 0) throw new ValidationError(`Check the price for ${st}.`);
  }
  const data = { name: input.name.trim().slice(0, 120), priceCents: input.priceCents, priceNote: input.priceNote?.trim() || null, statePrices: input.statePrices && Object.keys(input.statePrices).length ? input.statePrices : undefined, govFeesMode: input.govFeesMode, deliverables: input.deliverables, grantDisclaimer: input.grantDisclaimer, active: input.active, updatedById: actor.id };
  const max = await prisma.nonprofitPackage.aggregate({ _max: { sortOrder: true } });
  await prisma.nonprofitPackage.upsert({ where: { key }, create: { key, ...data, sortOrder: (max._max.sortOrder ?? 0) + 1 }, update: data });
  await audit(prisma, { actorId: actor.id, action: "nonprofit.package_saved", entityType: "NonprofitPackage", entityId: key, details: { priceCents: input.priceCents, deliverables: input.deliverables.length, govFeesMode: input.govFeesMode } });
}

/** The price for a package in a state: its state price if set, otherwise the base price. */
export function packagePrice(pkg: { priceCents: number; statePrices: unknown }, state: string | null) {
  const sp = (pkg.statePrices ?? {}) as Record<string, number>;
  return state && sp[state] ? sp[state] : pkg.priceCents;
}

/**
 * Assigns a package to the organization: its deliverables join the checklist
 * (flagged as included in the package, kept apart from government
 * requirements), and a service with a draft pricing agreement is prepared —
 * work on package documents can't begin until the client signs it. The $5,000
 * portfolio's agreement carries the grant disclaimer, so signing it is the
 * client's electronic acknowledgment.
 */
export async function assignPackage(actor: Actor, orgId: string, input: { packageKey: string; govFeeCents?: number; priceCents?: number }) {
  const p = await ensurePortfolio(actor, orgId);
  const pkg = await prisma.nonprofitPackage.findUnique({ where: { key: input.packageKey } });
  if (!pkg || !pkg.active) throw new ValidationError("Choose a package.");
  const deliverables = pkg.deliverables as unknown as PackageDeliverable[];
  const price = input.priceCents && input.priceCents > 0 ? input.priceCents : packagePrice(pkg, p.formationState);
  if (pkg.govFeesMode === "ADDED" && input.govFeeCents !== undefined && (!Number.isInteger(input.govFeeCents) || input.govFeeCents < 0)) throw new ValidationError("Enter the government filing fees in dollars and cents.");

  // Checklist: one item per deliverable; an existing item with the same key (e.g. a state requirement) is reused.
  const existing = await prisma.nonprofitChecklistItem.findMany({ where: { portfolioId: orgId }, select: { templateKey: true } });
  const have = new Set(existing.map((e) => e.templateKey));
  const fresh = deliverables.filter((d) => !have.has(d.key));
  if (fresh.length) await prisma.nonprofitChecklistItem.createMany({ data: fresh.map((d, i) => ({ portfolioId: orgId, templateKey: d.key, label: d.label, section: d.section, category: d.section === "GRANT" ? "GRANT" : d.section === "STATE" ? "STATE" : d.section === "FORMATION" ? "GOVERNANCE" : "FEDERAL", deliverable: true, sortOrder: existing.length + i })), skipDuplicates: true });
  for (const d of deliverables.filter((x) => have.has(x.key))) {
    await prisma.nonprofitChecklistItem.update({ where: { portfolioId_templateKey: { portfolioId: orgId, templateKey: d.key } }, data: { deliverable: true, label: d.label, section: d.section } });
  }
  // Documents from a previously assigned package that this one doesn't include stay, but aren't package deliverables any more.
  await prisma.nonprofitChecklistItem.updateMany({ where: { portfolioId: orgId, deliverable: true, templateKey: { notIn: deliverables.map((d) => d.key) } }, data: { deliverable: false } });

  // Billing: a service on the organization's record with its draft agreement.
  const serviceId = p.serviceId ?? (await createService(actor, { clientId: orgId, type: "NONPROFIT_SERVICES", periodLabel: pkg.name, title: pkg.name, description: `Deliverables: ${deliverables.map((d) => d.label).join("; ")}.`, requiresPaymentAuth: false })).id;
  const lines = [{ label: `${pkg.name}${pkg.govFeesMode === "INCLUDED" ? " (government filing fees included)" : ""}`, cents: price }];
  if (pkg.govFeesMode === "ADDED" && input.govFeeCents) lines.push({ label: "Government filing fees (paid to the state and IRS; added to the package price)", cents: input.govFeeCents });
  const agreement = await prepareAgreement(actor, serviceId, { lines, disclaimers: pkg.grantDisclaimer ? [GRANT_DISCLAIMER] : [] });
  await prisma.nonprofitPortfolio.update({ where: { clientId: orgId }, data: { packageKey: pkg.key, serviceId, govFeesMode: pkg.govFeesMode } });
  await audit(prisma, { actorId: actor.id, action: "nonprofit.package_assigned", entityType: "NonprofitPortfolio", entityId: orgId, clientId: orgId, details: { packageKey: pkg.key, priceCents: price, govFeeCents: input.govFeeCents ?? null, agreementId: agreement.id } });
  return { serviceId, agreementId: agreement.id, added: fresh.length };
}

/** Package work waits for the signed agreement (or the owner's documented override). */
async function assertWorkMayBegin(orgId: string) {
  const p = await prisma.nonprofitPortfolio.findUnique({ where: { clientId: orgId }, select: { serviceId: true } });
  if (!p?.serviceId) return;
  const s = await prisma.clientService.findUnique({ where: { id: p.serviceId }, include: { agreements: true } });
  if (!s) return;
  const gate = startGate(s);
  if (!gate.ok) throw new ValidationError(`Package work can't begin yet: ${gate.reason}`);
}

// --- Client side -----------------------------------------------------------------

/** Released, clean files the client may open, for one organization they have access to. */
async function releasedFiles(orgId: string) {
  return prisma.nonprofitItemFile.findMany({
    where: { item: { portfolioId: orgId }, releasedAt: { not: null }, origin: { not: "INTERNAL_DRAFT" } },
    include: { item: { select: { label: true, category: true } } },
    orderBy: { releasedAt: "desc" },
  }).then(async (files) => {
    const docs = await prisma.document.findMany({ where: { id: { in: files.map((f) => f.documentId) }, deletedAt: null, visibility: "PUBLISHED", scanStatus: "CLEAN" }, include: { file: true } });
    return files.flatMap((f) => {
      const doc = docs.find((x) => x.id === f.documentId);
      return doc ? [{ ...f, doc }] : [];
    });
  });
}

/** The client's portfolio view: progress, checklist (client-facing labels), released documents and deadlines. */
export async function portalPortfolio(user: PortalActor, orgId: string) {
  await requireClientAccess(user.id, orgId);
  const p = await portfolio(orgId);
  if (!p) return null;
  const applicable = p.items.filter((i) => i.status !== "NOT_APPLICABLE");
  const done = applicable.filter((i) => DONE.includes(i.status as ItemStatus)).length;
  const files = await releasedFiles(orgId);
  const cls = p.classification ? await prisma.nonprofitClassification.findUnique({ where: { key: p.classification } }) : null;
  const pkg = p.packageKey ? await prisma.nonprofitPackage.findUnique({ where: { key: p.packageKey } }) : null;
  return {
    org: { name: p.legalName || p.client.businessName || p.client.displayName, state: p.formationState ? stateName(p.formationState) : null, formationDate: p.formationDate, ein: p.ein, sosEntityNumber: p.sosEntityNumber, classification: cls?.label ?? null, uei: p.uei, samStatus: p.samStatus, agStatus: p.agStatus },
    irs: irsStatus(p.irsEvents),
    progress: { done, total: applicable.length },
    items: applicable.map((i) => ({
      id: i.id,
      label: i.label,
      status: i.status as ItemStatus,
      section: (i.section in SECTIONS ? i.section : "OTHER") as Section,
      deliverable: i.deliverable,
      requirement: i.requirement,
      // Every released format of this document (e.g. PDF and Word).
      files: files.filter((f) => f.itemId === i.id).map((f) => ({ id: f.id, documentId: f.doc.id, mime: f.doc.file.mimeType, name: f.doc.file.originalName, origin: f.origin as Origin, releasedAt: f.releasedAt! })),
    })),
    files: files.map((f) => ({ id: f.id, documentId: f.doc.id, label: f.item.label, title: f.doc.title, origin: f.origin as Origin, releasedAt: f.releasedAt!, mime: f.doc.file.mimeType })),
    package: pkg ? { name: pkg.name, grantDisclaimer: pkg.grantDisclaimer } : null,
    deadlines: annualDeadline(p.client),
  };
}

/**
 * The organization's annual federal return deadline, shown to the client with
 * who prepares it: only "TTurner prepares this filing" when there's an active
 * filing service agreement (PR #31's filing-service answer is Yes).
 */
export function annualDeadline(c: { fiscalYearEnd: number | null; nonprofitProfile: { formType: string | null; otherForm: string | null; filingService: string | null } | null }, today = officeToday()) {
  if (!c.fiscalYearEnd || !c.nonprofitProfile?.formType) return null;
  const taxYear = latestEndedTaxYear(c.fiscalYearEnd, today);
  const due = nonprofitDueDate(taxYear, c.fiscalYearEnd);
  const form = c.nonprofitProfile.formType === "OTHER" ? c.nonprofitProfile.otherForm : NONPROFIT_FORMS[c.nonprofitProfile.formType as keyof typeof NONPROFIT_FORMS]?.label;
  return { taxYear, due, days: daysBetween(today, due), form, preparedByUs: c.nonprofitProfile.filingService === "YES" };
}

/** Files for Download All / Print All, limited to the client's released documents for this organization. */
export async function bundleFiles(user: PortalActor, orgId: string, ids: string[] | null) {
  await requireClientAccess(user.id, orgId);
  const files = await releasedFiles(orgId);
  const picked = ids ? files.filter((f) => ids.includes(f.id)) : files;
  if (ids && picked.length !== ids.length) throw new ForbiddenError("You don't have access to one of those documents.");
  if (!picked.length) throw new ValidationError("There are no released documents to include.");
  return picked;
}
