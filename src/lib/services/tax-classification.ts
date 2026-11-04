import "server-only";
import { prisma } from "@/lib/prisma";
import { audit } from "@/lib/audit";
import type { Actor } from "@/lib/auth/actor";
import { ValidationError } from "./clients";
import { assertTabithaApproves } from "./bk-permissions";

/**
 * Business Tax Classification (internal profile). Tabitha sets it at setup and can edit it;
 * Coetha reads it to apply the right equity and compensation rules and may only RECOMMEND a
 * change (a CLASSIFICATION proposal that Tabitha approves or rejects).
 *
 * Nothing is duplicated: the accounting method is BookkeepingProfile.accountingBasis (kept in
 * step with LedgerBook.basis), the fiscal year end is Client.fiscalYearEnd (kept in step with
 * LedgerBook.fiscalYearStartMonth), the tax year is BookkeepingProfile.workingYear, and
 * Client.entityType is kept consistent with the classification.
 */

export const TAX_CLASSIFICATIONS = {
  FORM_1065: { label: "Form 1065 — Partnership / Multi-Member LLC", entityType: "PARTNERSHIP" },
  FORM_1120S: { label: "Form 1120-S — S Corporation", entityType: "S_CORP" },
  SCHEDULE_C: { label: "Form 1040 Schedule C — Sole Proprietor / Disregarded Single-Member LLC", entityType: "SOLE_PROPRIETOR" },
  OTHER_REVIEW: { label: "Other / Requires Review", entityType: null },
} as const;
export type TaxClassification = keyof typeof TAX_CLASSIFICATIONS;
export const isTaxClassification = (s: string | null | undefined): s is TaxClassification => !!s && s in TAX_CLASSIFICATIONS;

/** What each classification means for Coetha's equity and compensation rules (also sent in her prompt). */
export const CLASSIFICATION_RULES: Record<TaxClassification, string> = {
  FORM_1065: "Partnership (Form 1065): money the partners take out is a partner draw against each partner's capital account (equity), never an expense. Fixed payments to a partner for services are guaranteed payments (deductible, reported to that partner), not wages; partners are not on payroll. Each partner needs a separate capital account.",
  FORM_1120S: "S corporation (Form 1120-S): owners who work in the business must be paid reasonable compensation through payroll (W-2). Other money taken out is a shareholder distribution (equity), never an expense and never 'owner draws'. Distributions with no officer payroll are a reasonable-compensation risk to flag.",
  SCHEDULE_C: "Sole proprietor / disregarded single-member LLC (Schedule C): money the owner takes out is an owner draw (equity) and money put in is an owner contribution. The owner is not on payroll and owner draws are never an expense.",
  OTHER_REVIEW: "Classification needs review: don't assume an entity type; flag owner withdrawals and compensation for Tabitha.",
};

export type ClassificationInput = { classification: string; basis?: string | null; fiscalYearEnd?: number | null; taxYear?: number | null };

/** Tabitha only. Keeps the profile, client and books consistent and audits the change. */
export async function setTaxClassification(actor: Actor, clientId: string, input: ClassificationInput, opts: { via?: "OWNER" | "COETHA_PROPOSAL"; proposalId?: string } = {}) {
  await assertTabithaApproves(actor, "or change a business's tax classification");
  if (!isTaxClassification(input.classification)) throw new ValidationError("Choose the tax classification.");
  if (input.basis && !["CASH", "ACCRUAL"].includes(input.basis)) throw new ValidationError("Choose cash or accrual.");
  if (input.fiscalYearEnd != null && (!Number.isInteger(input.fiscalYearEnd) || input.fiscalYearEnd < 1 || input.fiscalYearEnd > 12)) throw new ValidationError("Choose the fiscal year-end month.");
  if (input.taxYear != null && (!Number.isInteger(input.taxYear) || input.taxYear < 2000 || input.taxYear > 2100)) throw new ValidationError("Choose the tax year.");
  const profile = await prisma.bookkeepingProfile.findUnique({ where: { clientId } });
  if (!profile) throw new ValidationError("Add this business as a Bookkeeping Client first.");
  const client = await prisma.client.findUniqueOrThrow({ where: { id: clientId }, select: { entityType: true, fiscalYearEnd: true } });
  const before = { classification: profile.taxClassification, basis: profile.accountingBasis, fiscalYearEnd: client.fiscalYearEnd, taxYear: profile.workingYear, entityType: client.entityType };
  const entityType = TAX_CLASSIFICATIONS[input.classification].entityType ?? client.entityType;
  await prisma.$transaction(async (tx) => {
    await tx.bookkeepingProfile.update({
      where: { clientId },
      data: { taxClassification: input.classification, taxClassificationById: actor.id, taxClassificationAt: new Date(), ...(input.basis ? { accountingBasis: input.basis } : {}), ...(input.taxYear != null ? { workingYear: input.taxYear } : {}), updatedById: actor.id },
    });
    await tx.client.update({ where: { id: clientId }, data: { entityType, ...(input.fiscalYearEnd != null ? { fiscalYearEnd: input.fiscalYearEnd } : {}) } });
    const book = await tx.ledgerBook.findUnique({ where: { clientId } });
    if (book) await tx.ledgerBook.update({ where: { clientId }, data: { ...(input.basis ? { basis: input.basis } : {}), ...(input.fiscalYearEnd != null ? { fiscalYearStartMonth: (input.fiscalYearEnd % 12) + 1 } : {}) } });
    await audit(tx, { actorId: actor.id, action: "business.tax_classification_set", entityType: "Client", entityId: clientId, clientId, details: { before, after: { classification: input.classification, basis: input.basis ?? before.basis, fiscalYearEnd: input.fiscalYearEnd ?? before.fiscalYearEnd, taxYear: input.taxYear ?? before.taxYear, entityType }, via: opts.via ?? "OWNER", proposalId: opts.proposalId ?? null } });
  });
}

export async function taxProfile(clientId: string) {
  const [p, c, book] = await Promise.all([
    prisma.bookkeepingProfile.findUnique({ where: { clientId }, select: { taxClassification: true, taxClassificationAt: true, accountingBasis: true, workingYear: true } }),
    prisma.client.findUnique({ where: { id: clientId }, select: { fiscalYearEnd: true, entityType: true } }),
    prisma.ledgerBook.findUnique({ where: { clientId }, select: { basis: true } }),
  ]);
  const classification = isTaxClassification(p?.taxClassification) ? p!.taxClassification as TaxClassification : null;
  return { classification, label: classification ? TAX_CLASSIFICATIONS[classification].label : null, setAt: p?.taxClassificationAt ?? null, basis: p?.accountingBasis ?? book?.basis ?? null, fiscalYearEnd: c?.fiscalYearEnd ?? 12, taxYear: p?.workingYear ?? null, entityType: c?.entityType ?? null };
}

/** The classification the recorded entity type implies (used by Coetha's consistency check). */
export function classificationForEntity(entityType: string | null): TaxClassification | null {
  for (const [k, v] of Object.entries(TAX_CLASSIFICATIONS)) if (v.entityType && v.entityType === entityType) return k as TaxClassification;
  return null;
}
