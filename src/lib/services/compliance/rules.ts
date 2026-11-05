import "server-only";
import { createHash } from "node:crypto";
import type { ComplianceRule, Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { audit } from "@/lib/audit";
import type { Actor } from "@/lib/auth/actor";
import { ValidationError } from "@/lib/services/clients";
import { INDUSTRY_TEMPLATES, RULES, SEED_VERSION, type RuleConditions, type RuleSeed } from "@/lib/compliance/rules-data";
import { describeDueCode, isFrequency, statutoryDue, WEEKEND_RULES } from "@/lib/compliance/dates";
import { assertComplianceOwner, assertComplianceView, primaryOwnerId } from "./access";

const contentOf = (r: RuleSeed) => JSON.stringify([r.jurisdictionLevel, r.jurisdictionName, r.formName, r.obligationName, r.category, r.conditions, r.frequency, r.dueRuleCode, r.dueRuleDescription, r.weekendRule, r.sourceUrls, r.effectiveFrom ?? null, r.verificationStatus, r.notes ?? null, !!r.clientApprovalDefault, r.portalKind ?? null, r.requiredDocs ?? [], r.serviceTypes ?? [], r.extensionMonths ?? null]);
export const seedHashOf = (r: RuleSeed) => createHash("sha256").update(contentOf(r)).digest("hex");

function dataOf(r: RuleSeed) {
  return {
    ruleKey: r.ruleKey,
    jurisdictionLevel: r.jurisdictionLevel,
    jurisdictionName: r.jurisdictionName,
    formName: r.formName,
    obligationName: r.obligationName,
    category: r.category,
    conditions: { ...r.conditions, ...(r.extensionMonths ? { extensionMonths: r.extensionMonths } : {}) } as Prisma.InputJsonValue,
    frequency: r.frequency,
    dueRuleCode: r.dueRuleCode,
    dueRuleDescription: r.dueRuleDescription,
    weekendRule: r.weekendRule,
    sourceUrls: r.sourceUrls,
    effectiveFrom: r.effectiveFrom ? new Date(`${r.effectiveFrom}T00:00:00Z`) : null,
    verificationStatus: r.verificationStatus,
    notes: r.notes ?? null,
    clientApprovalDefault: !!r.clientApprovalDefault,
    portalKind: r.portalKind ?? null,
    requiredDocs: r.requiredDocs ?? [],
    serviceTypes: r.serviceTypes ?? [],
  };
}

/**
 * Loads the seed library (idempotent, safe under concurrency). A rule key that's new gets
 * version 1; a seed whose content changed adds a new version (never edits one). Rules the owner
 * edited are left alone: her version stays current until she edits again.
 */
export async function ensureRulesLoaded() {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('compliance-rules-seed'))`;
    const current = await tx.complianceRule.findMany({ where: { isCurrent: true } });
    let added = 0;
    for (const r of RULES) {
      const cur = current.find((c) => c.ruleKey === r.ruleKey);
      const hash = seedHashOf(r);
      if (cur && (cur.seedHash === hash || cur.origin !== "SEED")) continue;
      if (cur) await tx.complianceRule.update({ where: { id: cur.id }, data: { isCurrent: false } });
      await tx.complianceRule.create({ data: { ...dataOf(r), version: (cur?.version ?? 0) + 1, isCurrent: true, origin: "SEED", seedHash: hash, changeReason: cur ? `Seed library ${SEED_VERSION} changed this rule` : `Seed library ${SEED_VERSION}` } });
      added++;
    }
    for (const t of INDUSTRY_TEMPLATES) {
      await tx.complianceIndustryTemplate.upsert({ where: { key: t.key }, update: {}, create: { ...t, builtIn: true } });
    }
    return added;
  });
}

export const conditionsOf = (r: Pick<ComplianceRule, "conditions">) => (r.conditions ?? {}) as RuleConditions & { extensionMonths?: number };

export async function currentRules() {
  await ensureRulesLoaded();
  return prisma.complianceRule.findMany({ where: { isCurrent: true }, orderBy: [{ jurisdictionLevel: "asc" }, { ruleKey: "asc" }] });
}

const YEAR = 365 * 24 * 60 * 60 * 1000;
export function reviewOverdue(r: Pick<ComplianceRule, "verificationStatus" | "lastReviewedAt">, now = new Date()) {
  return r.verificationStatus !== "VERIFIED" || !r.lastReviewedAt || now.getTime() - r.lastReviewedAt.getTime() > YEAR;
}

export async function rulesLibrary(actor: Actor, now = new Date()) {
  await assertComplianceView(actor);
  const rules = await currentRules();
  const history = await prisma.complianceRule.findMany({ where: { isCurrent: false }, orderBy: [{ ruleKey: "asc" }, { version: "desc" }], select: { id: true, ruleKey: true, version: true, changeReason: true, editedById: true, createdAt: true, verificationStatus: true } });
  const templates = await prisma.complianceIndustryTemplate.findMany({ where: { archivedAt: null }, orderBy: { name: "asc" } });
  return {
    rules,
    reviewQueue: rules.filter((r) => reviewOverdue(r, now)),
    counts: { total: rules.length, verified: rules.filter((r) => r.verificationStatus === "VERIFIED").length, needsVerification: rules.filter((r) => r.verificationStatus !== "VERIFIED").length },
    history,
    templates,
  };
}

export type RuleEdit = {
  formName?: string;
  obligationName?: string;
  dueRuleCode?: string;
  dueRuleDescription?: string;
  weekendRule?: string;
  frequency?: string;
  sourceUrl: string;
  verificationStatus: "VERIFIED" | "NEEDS_VERIFICATION";
  notes?: string;
  reason: string;
};

/**
 * Owner edit: a new version (editor, reason, source link) becomes current; the old version is
 * kept and existing obligations keep pointing at the version they were generated from.
 * Marking VERIFIED requires an official source link (the owner confirms she read it).
 */
export async function editRule(actor: Actor, ruleKey: string, edit: RuleEdit) {
  await assertComplianceOwner(actor);
  const reason = edit.reason.trim();
  if (reason.length < 5) throw new ValidationError("Say why the rule changed (at least a few words).");
  const url = edit.sourceUrl.trim();
  if (!/^https:\/\/[^\s]+\.[a-z]{2,}/i.test(url)) throw new ValidationError("Enter the official source link (https://…) you checked.");
  if (edit.weekendRule && !(edit.weekendRule in WEEKEND_RULES)) throw new ValidationError("Choose a weekend/holiday rule.");
  if (edit.frequency && !isFrequency(edit.frequency) && !/^ACCOUNT:(MONTHLY|QUARTERLY|SEMIANNUAL|ANNUAL)$/.test(edit.frequency)) throw new ValidationError("Choose a frequency.");
  if (edit.dueRuleCode) {
    try {
      statutoryDue(edit.dueRuleCode, { key: "x", start: "2026-01-01", end: "2026-01-31" });
    } catch {
      throw new ValidationError("That due-date code isn't valid (e.g. DOM:20:1, EOM:1, FIXED:01-31:1, MANUAL).");
    }
  }
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`compliance-rule:${ruleKey}`}))`;
    const cur = await tx.complianceRule.findFirst({ where: { ruleKey, isCurrent: true } });
    if (!cur) throw new ValidationError("Rule not found.");
    await tx.complianceRule.update({ where: { id: cur.id }, data: { isCurrent: false } });
    const { id: _id, createdAt: _c, ...rest } = cur;
    void _id; void _c;
    const next = await tx.complianceRule.create({
      data: {
        ...rest,
        conditions: cur.conditions as Prisma.InputJsonValue,
        version: cur.version + 1,
        isCurrent: true,
        formName: edit.formName?.trim() || cur.formName,
        obligationName: edit.obligationName?.trim() || cur.obligationName,
        dueRuleCode: edit.dueRuleCode?.trim() || cur.dueRuleCode,
        dueRuleDescription: edit.dueRuleDescription?.trim() || (edit.dueRuleCode ? describeDueCode(edit.dueRuleCode) : cur.dueRuleDescription),
        weekendRule: edit.weekendRule || cur.weekendRule,
        frequency: edit.frequency || cur.frequency,
        sourceUrls: [...new Set([url, ...cur.sourceUrls])],
        verificationStatus: edit.verificationStatus,
        lastReviewedAt: new Date(),
        lastReviewedBy: actor.id,
        notes: edit.notes?.trim() || cur.notes,
        origin: "OWNER_EDIT",
        changeReason: reason.slice(0, 1000),
        editedById: actor.id,
        seedHash: null,
      },
    });
    await audit(tx, { actorId: actor.id, action: "compliance.rule_edited", entityType: "ComplianceRule", entityId: next.id, details: { ruleKey, fromVersion: cur.version, toVersion: next.version, verificationStatus: edit.verificationStatus, sourceUrl: url, reason } });
    return next;
  });
}

export async function addIndustryTemplate(actor: Actor, input: { key: string; name: string; description?: string; ruleKeys: string[]; activityTags: string[] }) {
  await assertComplianceOwner(actor);
  const key = input.key.trim().toLowerCase().replace(/[^a-z0-9_]+/g, "_");
  if (key.length < 3 || input.name.trim().length < 3) throw new ValidationError("Give the template a key and a name.");
  const known = new Set((await currentRules()).map((r) => r.ruleKey));
  const ruleKeys = [...new Set(input.ruleKeys.map((k) => k.trim()).filter(Boolean))];
  const unknown = ruleKeys.filter((k) => !known.has(k));
  if (unknown.length) throw new ValidationError(`Unknown rule(s): ${unknown.join(", ")}.`);
  const tags = [...new Set(input.activityTags.map((t) => t.trim().toLowerCase().replace(/\s+/g, "_")).filter(Boolean))];
  const t = await prisma.complianceIndustryTemplate.create({ data: { key, name: input.name.trim(), description: input.description?.trim() || null, ruleKeys, activityTags: tags, builtIn: false, createdById: actor.id } });
  await audit(prisma, { actorId: actor.id, action: "compliance.template_added", entityType: "ComplianceIndustryTemplate", entityId: t.id, details: { key, ruleKeys, tags } });
  return t;
}

export const RULE_REVIEW_TASK = (year: number) => `Annual compliance rules review (${year})`;

/** One open task per year for the owner to review the rules library (never two). */
export async function ensureRuleReviewTask(now = new Date()) {
  const owner = await primaryOwnerId();
  if (!owner) return "no_owner" as const;
  const year = now.getUTCFullYear();
  const title = RULE_REVIEW_TASK(year);
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('compliance-rule-review-task'))`;
    if (await tx.task.count({ where: { title } })) return "exists" as const;
    const due = new Date(Date.UTC(year, 0, 31));
    await tx.task.create({
      data: {
        title,
        details: "Open Tax & Compliance → Rules library. Re-check every rule older than 12 months or marked Needs verification against its official source, and save each change as a new version with the source link.",
        priority: "HIGH",
        dueAt: due < now ? now : due,
        assigneeId: owner,
        createdById: owner,
      },
    });
    return "created" as const;
  });
}
