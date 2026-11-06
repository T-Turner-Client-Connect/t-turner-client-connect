import "server-only";
import type { ComplianceObligation, ComplianceRule, Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { audit } from "@/lib/audit";
import type { Actor } from "@/lib/auth/actor";
import { ValidationError } from "@/lib/services/clients";
import { officeToday } from "@/lib/tax/deadlines";
import { evaluateRule, type Evaluation } from "@/lib/compliance/evaluate";
import { dueDatesFor, isFrequency, nextPeriod, periodContaining, periodsToCreate, WEEKEND_RULES, type Frequency, type Period } from "@/lib/compliance/dates";
import { NONPROFIT_FORMS } from "@/lib/services/nonprofits";
import { assertComplianceManage, assertComplianceOwner, assertComplianceView } from "./access";
import { conditionsOf, currentRules } from "./rules";
import { complianceSettings } from "./settings";
import { entityFacts } from "./entities";

export const OBLIGATION_STATUS = {
  PROPOSED: { label: "Proposed — owner review", tone: "gold" },
  ACTIVE: { label: "Active", tone: "green" },
  SUSPENDED: { label: "Suspended", tone: "amber" },
  CLOSED: { label: "Closed account", tone: "gray" },
  INACTIVE: { label: "Deactivated", tone: "gray" },
} as const;

export const COMPLETE_FILING = ["SUBMITTED", "ACCEPTED", "NOT_REQUIRED"];
export const isComplete = (p: { filingStatus: string }) => COMPLETE_FILING.includes(p.filingStatus);
export const effectiveDue = (p: { extendedDue: Date | null; adjustedDue: Date | null }) => p.extendedDue ?? p.adjustedDue;
const d = (s: string | null) => (s ? new Date(`${s}T00:00:00Z`) : null);
const iso = (x: Date | null | undefined) => (x ? x.toISOString().slice(0, 10) : null);

const RULE_UNVERIFIED = (r: Pick<ComplianceRule, "sourceUrls">) => `Rule not yet verified against the official source — confirm the due date and applicability${r.sourceUrls[0] ? ` (${r.sourceUrls[0]})` : ""}`;

/** Which serviceType of this rule the client is contracted for (null = none). */
function serviceFor(rule: Pick<ComplianceRule, "serviceTypes">, services: string[]) {
  return rule.serviceTypes.find((s) => services.includes(s)) ?? null;
}

function titleFor(rule: ComplianceRule, nonprofitForm: string | null) {
  if (rule.ruleKey === "FED_990" && !nonprofitForm) return "Form 990-N / 990-EZ / 990 — determination pending gross receipts";
  if (rule.ruleKey.startsWith("FED_990") && nonprofitForm && nonprofitForm in NONPROFIT_FORMS) return `${NONPROFIT_FORMS[nonprofitForm as keyof typeof NONPROFIT_FORMS].label} — ${rule.obligationName}`;
  return `${rule.formName} — ${rule.obligationName}`;
}

export type GeneratedItem = { ruleKey: string; result: Evaluation["result"]; missing: string[]; obligationId?: string; created: boolean };

/**
 * Evaluates every current rule against the entity's profile. Rules that apply (or apply pending a
 * missing fact) become PROPOSED obligations pinned to the rule version, labeled Needs
 * Verification when a fact is missing or the rule itself isn't verified. Rules the profile rules
 * out create nothing. Existing obligations are refreshed, never duplicated; active ones keep
 * their status (their verify list is updated).
 */
export async function generateObligations(actor: Actor, entityId: string): Promise<GeneratedItem[]> {
  await assertComplianceManage(actor);
  return generateObligationsInternal(entityId, actor.id);
}

export async function generateObligationsInternal(entityId: string, actorId: string | null): Promise<GeneratedItem[]> {
  const entity = await prisma.complianceEntity.findUniqueOrThrow({ where: { id: entityId }, include: { filingAccounts: true } });
  if (entity.archivedAt || entity.status === "INACTIVE") throw new ValidationError("This entity is inactive.");
  const [rules, facts, settings] = await Promise.all([currentRules(), entityFacts(entityId), complianceSettings()]);
  const activeServices = (await prisma.clientService.findMany({ where: { clientId: entity.clientId, status: { not: "CLOSED" } }, select: { type: true } })).map((s) => s.type as string);
  const services = [...new Set([...activeServices, ...entity.services])];
  const out: GeneratedItem[] = [];
  for (const rule of rules) {
    const ev = evaluateRule({ conditions: conditionsOf(rule), frequency: rule.frequency }, facts);
    if (ev.result === "DOES_NOT_APPLY") {
      out.push({ ruleKey: rule.ruleKey, result: ev.result, missing: [], created: false });
      continue;
    }
    const verifyItems = [...ev.missing, ...(rule.verificationStatus !== "VERIFIED" ? [RULE_UNVERIFIED(rule)] : [])];
    const verification = verifyItems.length ? "NEEDS_VERIFICATION" : "VERIFIED";
    const serviceType = serviceFor(rule, services);
    const filingAccount = entity.filingAccounts.find((a) => a.portalKind === rule.portalKind);
    const existing = await prisma.complianceObligation.findUnique({ where: { entityId_dedupeKey: { entityId, dedupeKey: rule.ruleKey } } });
    if (existing) {
      const refresh: Prisma.ComplianceObligationUpdateInput = { verifyItems: existing.status === "PROPOSED" ? verifyItems : [...new Set([...verifyItems])], verification, taxAccount: ev.registration?.id ? { connect: { id: ev.registration.id } } : undefined };
      if (existing.status === "PROPOSED") Object.assign(refresh, { rule: { connect: { id: rule.id } }, frequency: ev.frequency ?? rule.frequency, title: titleFor(rule, facts.nonprofitForm), dueRuleCode: rule.dueRuleCode, dueRuleDescription: rule.dueRuleDescription, weekendRule: rule.weekendRule });
      await prisma.complianceObligation.update({ where: { id: existing.id }, data: refresh });
      out.push({ ruleKey: rule.ruleKey, result: ev.result, missing: ev.missing, obligationId: existing.id, created: false });
      continue;
    }
    const created = await prisma.complianceObligation.create({
      data: {
        entityId,
        clientId: entity.clientId,
        ruleId: rule.id,
        ruleKey: rule.ruleKey,
        dedupeKey: rule.ruleKey,
        title: titleFor(rule, facts.nonprofitForm),
        formName: rule.formName,
        jurisdictionLevel: rule.jurisdictionLevel,
        jurisdictionName: rule.jurisdictionName,
        category: rule.category,
        frequency: ev.frequency ?? rule.frequency,
        dueRuleCode: rule.dueRuleCode,
        dueRuleDescription: rule.dueRuleDescription,
        weekendRule: rule.weekendRule,
        status: "PROPOSED",
        verification,
        verifyItems,
        clientApprovalRequired: rule.clientApprovalDefault,
        clientVisible: !!serviceType,
        serviceType,
        taxAccountId: ev.registration?.id ?? null,
        filingAccountId: filingAccount?.id ?? null,
        requiredDocs: rule.requiredDocs,
        prepLeadDays: settings.defaultPrepLeadDays,
        extensionMonths: conditionsOf(rule).extensionMonths ?? null,
        source: "GENERATOR",
        createdById: actorId,
      },
    });
    await audit(prisma, { actorId, action: "compliance.obligation_proposed", entityType: "ComplianceObligation", entityId: created.id, clientId: entity.clientId, details: { ruleKey: rule.ruleKey, ruleVersion: rule.version, verification } });
    out.push({ ruleKey: rule.ruleKey, result: ev.result, missing: ev.missing, obligationId: created.id, created: true });
  }
  return out;
}

/** The fiscal year end month the obligation's annual periods follow, and whether it was assumed. */
async function fyeFor(o: ComplianceObligation & { rule: ComplianceRule | null }) {
  const c = o.rule ? conditionsOf(o.rule) : {};
  if (c.calendarYear || o.frequency !== "ANNUAL") return { fye: 12, assumed: false };
  const e = await prisma.complianceEntity.findUniqueOrThrow({ where: { id: o.entityId }, select: { fiscalYearEndMonth: true } });
  if (c.fyeRequired && !e.fiscalYearEndMonth) return { fye: 12, assumed: true };
  return { fye: e.fiscalYearEndMonth ?? 12, assumed: false };
}

function periodRow(o: ComplianceObligation, p: Period & { statutory: string | null; adjusted: string | null; prep: string | null }, certain: boolean, note: string | null) {
  return {
    obligationId: o.id,
    entityId: o.entityId,
    clientId: o.clientId,
    periodKey: p.key,
    periodStart: d(p.start)!,
    periodEnd: d(p.end)!,
    statutoryDue: d(p.statutory),
    adjustedDue: d(p.adjusted),
    prepDeadline: d(p.prep),
    dueCertainty: certain && p.adjusted ? "CONFIRMED" : "NEEDS_VERIFICATION",
    dueNote: note,
  };
}

/**
 * Creates the periods an ACTIVE obligation needs today (idempotent; unique per obligation,
 * period and kind): the first period due on/after its start date, everything due within 45
 * days, and always the next one. Suspended/closed/proposed obligations get none.
 */
export async function ensurePeriods(obligationId: string, today = officeToday()) {
  const o = await prisma.complianceObligation.findUniqueOrThrow({ where: { id: obligationId }, include: { rule: true } });
  if (o.status !== "ACTIVE") return 0;
  if (!isFrequency(o.frequency)) return 0;
  const { fye, assumed } = await fyeFor(o);
  const certain = o.verification === "VERIFIED" && !assumed;
  const note = [assumed ? "Fiscal year-end not recorded — December assumed" : null, o.dueRuleCode === "MANUAL" ? "No computed due date — enter it from the agency's notice or license" : null].filter(Boolean).join(". ") || null;
  const list = periodsToCreate({ frequency: o.frequency as Frequency, code: o.dueRuleCode, weekendRule: o.weekendRule, fyeMonth: fye, startDate: iso(o.startDate) ?? today, today, prepLeadDays: o.prepLeadDays });
  const r = await prisma.complianceFilingPeriod.createMany({ data: list.map((p) => periodRow(o, p, certain, note)), skipDuplicates: true });
  return r.count;
}

/** After a period completes: the next recurring period is created right away. */
export async function createNextPeriod(periodId: string) {
  const p = await prisma.complianceFilingPeriod.findUniqueOrThrow({ where: { id: periodId }, include: { obligation: { include: { rule: true } } } });
  const o = p.obligation;
  if (o.status !== "ACTIVE" || p.kind !== "ORIGINAL" || !isFrequency(o.frequency) || o.frequency === "ONE_TIME") return null;
  const { fye, assumed } = await fyeFor(o);
  const cur: Period = { key: p.periodKey, start: iso(p.periodStart)!, end: iso(p.periodEnd)! };
  const nx = o.dueRuleCode === "MANUAL" ? periodContaining(o.frequency as Frequency, iso(new Date(p.periodEnd.getTime() + 86400_000))!, fye) : nextPeriod(o.frequency as Frequency, cur, fye);
  if (!nx) return null;
  const dd = dueDatesFor(o.dueRuleCode, o.weekendRule, nx, o.prepLeadDays);
  await prisma.complianceFilingPeriod.createMany({ data: [periodRow(o, { ...nx, ...dd }, o.verification === "VERIFIED" && !assumed, assumed ? "Fiscal year-end not recorded — December assumed" : null)], skipDuplicates: true });
  await prisma.complianceFilingPeriod.update({ where: { id: periodId }, data: { nextCreatedAt: new Date() } });
  return nx.key;
}

/** Due dates a PROPOSED obligation would have (preview only; nothing is stored or confirmed). */
export async function previewDates(obligationId: string, today = officeToday()) {
  const o = await prisma.complianceObligation.findUniqueOrThrow({ where: { id: obligationId }, include: { rule: true } });
  if (!isFrequency(o.frequency)) return [];
  const { fye } = await fyeFor(o);
  return periodsToCreate({ frequency: o.frequency as Frequency, code: o.dueRuleCode, weekendRule: o.weekendRule, fyeMonth: fye, startDate: today, today, horizonDays: 0, prepLeadDays: o.prepLeadDays }).slice(0, 1);
}

// --- Owner lifecycle actions (audited) --------------------------------------------------------

async function obligationOr404(id: string) {
  const o = await prisma.complianceObligation.findUnique({ where: { id } });
  if (!o) throw new ValidationError("Obligation not found.");
  return o;
}

/** Owner approval: the obligation goes live (periods, prep tasks and reminders start now). */
export async function activateObligation(actor: Actor, obligationId: string, opts: { startDate?: string } = {}) {
  await assertComplianceOwner(actor);
  const o = await obligationOr404(obligationId);
  if (o.status === "ACTIVE") return o;
  if (o.status === "CLOSED") throw new ValidationError("This account is closed. Add a new obligation if it reopened.");
  const entity = await prisma.complianceEntity.findUniqueOrThrow({ where: { id: o.entityId } });
  if (entity.status === "INACTIVE" || entity.archivedAt) throw new ValidationError("Activate the entity first.");
  if (entity.status === "PROPOSED") await prisma.complianceEntity.update({ where: { id: entity.id }, data: { status: "ACTIVE" } });
  const today = officeToday();
  const startDate = opts.startDate && /^\d{4}-\d{2}-\d{2}$/.test(opts.startDate) ? opts.startDate : today;
  const updated = await prisma.complianceObligation.update({ where: { id: obligationId }, data: { status: "ACTIVE", activatedAt: new Date(), activatedById: actor.id, suspendedAt: null, startDate: o.startDate ?? d(startDate) } });
  await audit(prisma, { actorId: actor.id, action: "compliance.obligation_activated", entityType: "ComplianceObligation", entityId: obligationId, clientId: o.clientId, details: { verification: o.verification, startDate } });
  await ensurePeriods(obligationId, today);
  // Deadlines already inside 30 days get their reminder and prep task immediately.
  const { runComplianceReminders } = await import("./reminders");
  await runComplianceReminders(new Date(), { obligationIds: [obligationId] });
  return updated;
}

export async function setObligationStatus(actor: Actor, obligationId: string, status: "SUSPENDED" | "CLOSED" | "INACTIVE" | "ACTIVE", reason: string) {
  if (status === "ACTIVE") return activateObligation(actor, obligationId);
  await assertComplianceOwner(actor);
  const why = reason.trim();
  if (why.length < 3) throw new ValidationError("Give a reason.");
  const o = await obligationOr404(obligationId);
  await prisma.complianceObligation.update({ where: { id: obligationId }, data: { status, ...(status === "SUSPENDED" ? { suspendedAt: new Date() } : {}), ...(status === "CLOSED" ? { closedAt: new Date() } : {}) } });
  if (status === "CLOSED" && o.taxAccountId) await prisma.complianceTaxAccount.update({ where: { id: o.taxAccountId }, data: { status: "CLOSED" } });
  await audit(prisma, { actorId: actor.id, action: `compliance.obligation_${status.toLowerCase()}`, entityType: "ComplianceObligation", entityId: obligationId, clientId: o.clientId, details: { reason: why.slice(0, 500) } });
}

export type ObligationEdit = { assignedStaffId?: string | null; reviewerId?: string | null; clientApprovalRequired?: boolean; clientVisible?: boolean; serviceType?: string | null; filingAccountId?: string | null; accessReference?: string | null; prepLeadDays?: number; notes?: string | null; frequency?: string; verifyItems?: string[] };

/** Staff with MANAGE edit assignment and handling; status changes stay with the owner. */
export async function editObligation(actor: Actor, obligationId: string, edit: ObligationEdit) {
  await assertComplianceManage(actor);
  const o = await obligationOr404(obligationId);
  if (edit.assignedStaffId && !(await prisma.user.count({ where: { id: edit.assignedStaffId, active: true } }))) throw new ValidationError("Choose an active staff member.");
  if (edit.reviewerId && !(await prisma.user.count({ where: { id: edit.reviewerId, active: true } }))) throw new ValidationError("Choose an active reviewer.");
  if (edit.filingAccountId && !(await prisma.complianceFilingAccount.count({ where: { id: edit.filingAccountId, OR: [{ entityId: o.entityId }, { firmLevel: true }] } }))) throw new ValidationError("Choose one of this entity's portals.");
  if (edit.prepLeadDays !== undefined && (!Number.isInteger(edit.prepLeadDays) || edit.prepLeadDays < 0 || edit.prepLeadDays > 60)) throw new ValidationError("Internal prep deadline: 0–60 days before the due date.");
  if (edit.frequency && !isFrequency(edit.frequency)) throw new ValidationError("Choose a frequency.");
  if (edit.frequency && o.status === "ACTIVE" && edit.frequency !== o.frequency) throw new ValidationError("Change the frequency before activating, or close this obligation and add a new one (filed periods keep their history).");
  const { assertNoSecret } = await import("./entities");
  assertNoSecret(edit.accessReference, edit.notes);
  const data: Prisma.ComplianceObligationUncheckedUpdateInput = {};
  for (const k of ["assignedStaffId", "reviewerId", "clientApprovalRequired", "clientVisible", "serviceType", "filingAccountId", "accessReference", "prepLeadDays", "notes", "frequency", "verifyItems"] as const) {
    if (edit[k] !== undefined) (data as Record<string, unknown>)[k] = edit[k] === "" ? null : edit[k];
  }
  await prisma.complianceObligation.update({ where: { id: obligationId }, data });
  await audit(prisma, { actorId: actor.id, action: "compliance.obligation_edited", entityType: "ComplianceObligation", entityId: obligationId, clientId: o.clientId, details: { changed: Object.keys(data) } });
}

export type CustomObligationInput = { title: string; formName: string; jurisdictionLevel: string; jurisdictionName: string; category: string; frequency: string; dueRuleCode: string; weekendRule: string; clientApprovalRequired?: boolean; startDate?: string; verified?: boolean; notes?: string };

/** Owner adds an obligation the library doesn't have. It's active at once (reminders start now). */
export async function addCustomObligation(actor: Actor, entityId: string, input: CustomObligationInput) {
  await assertComplianceOwner(actor);
  const e = await prisma.complianceEntity.findUnique({ where: { id: entityId } });
  if (!e) throw new ValidationError("Entity not found.");
  if (input.title.trim().length < 3 || input.formName.trim().length < 2) throw new ValidationError("Give the obligation a title and form name.");
  if (!isFrequency(input.frequency)) throw new ValidationError("Choose a frequency.");
  if (!(input.weekendRule in WEEKEND_RULES)) throw new ValidationError("Choose a weekend/holiday rule.");
  if (!["FEDERAL", "STATE", "COUNTY", "CITY"].includes(input.jurisdictionLevel)) throw new ValidationError("Choose the jurisdiction level.");
  try {
    dueDatesFor(input.dueRuleCode, input.weekendRule, { key: "x", start: "2026-01-01", end: "2026-01-31" });
  } catch {
    throw new ValidationError("That due-date code isn't valid (e.g. DOM:20:1, EOM:1, FIXED:01-31:1, MANUAL).");
  }
  const { describeDueCode } = await import("@/lib/compliance/dates");
  const o = await prisma.complianceObligation.create({
    data: {
      entityId, clientId: e.clientId, dedupeKey: `custom:${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
      title: input.title.trim().slice(0, 200), formName: input.formName.trim().slice(0, 120), jurisdictionLevel: input.jurisdictionLevel, jurisdictionName: input.jurisdictionName.trim().slice(0, 120), category: input.category || "OTHER",
      frequency: input.frequency, dueRuleCode: input.dueRuleCode, dueRuleDescription: describeDueCode(input.dueRuleCode), weekendRule: input.weekendRule,
      status: "PROPOSED", verification: input.verified ? "VERIFIED" : "NEEDS_VERIFICATION", verifyItems: input.verified ? [] : ["Custom obligation — confirm due date and filing authority"],
      clientApprovalRequired: !!input.clientApprovalRequired, source: "CUSTOM", notes: input.notes?.trim() || null, createdById: actor.id, startDate: input.startDate ? d(input.startDate) : null,
    },
  });
  await audit(prisma, { actorId: actor.id, action: "compliance.obligation_custom_added", entityType: "ComplianceObligation", entityId: o.id, clientId: e.clientId, details: { title: o.title } });
  return activateObligation(actor, o.id, { startDate: input.startDate });
}

/** Clean read API for other workspaces (e.g. ADP Payroll & Taxes): obligations with their next open period. */
export type ObligationFilter = { clientId?: string; entityId?: string; category?: string; categories?: string[]; status?: string[]; ruleKeys?: string[] };
export async function listObligations(actor: Actor, filter: ObligationFilter = {}) {
  await assertComplianceView(actor);
  const rows = await prisma.complianceObligation.findMany({
    where: {
      ...(filter.clientId ? { clientId: filter.clientId } : {}),
      ...(filter.entityId ? { entityId: filter.entityId } : {}),
      ...(filter.category ? { category: filter.category } : {}),
      ...(filter.categories ? { category: { in: filter.categories } } : {}),
      ...(filter.status ? { status: { in: filter.status } } : {}),
      ...(filter.ruleKeys ? { ruleKey: { in: filter.ruleKeys } } : {}),
    },
    include: { entity: { select: { id: true, legalName: true, dba: true, kind: true } }, periods: { where: { filingStatus: { notIn: COMPLETE_FILING } }, orderBy: { adjustedDue: "asc" }, take: 1 } },
    orderBy: [{ clientId: "asc" }, { title: "asc" }],
  });
  return rows.map((o) => ({
    id: o.id, clientId: o.clientId, entity: o.entity, title: o.title, formName: o.formName, category: o.category, jurisdiction: `${o.jurisdictionLevel}: ${o.jurisdictionName}`, frequency: o.frequency, status: o.status, verification: o.verification,
    nextPeriod: o.periods[0] ? { id: o.periods[0].id, periodKey: o.periods[0].periodKey, dueDate: iso(effectiveDue(o.periods[0])), dueCertainty: o.periods[0].dueCertainty, filingStatus: o.periods[0].filingStatus, paymentStatus: o.periods[0].paymentStatus } : null,
    href: `/compliance/entities/${o.entityId}#obligation-${o.id}`,
  }));
}
