import "server-only";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { audit } from "@/lib/audit";
import type { Actor } from "@/lib/auth/actor";
import { ValidationError } from "@/lib/services/clients";
import { assertComplianceManage } from "./access";
import { currentRules } from "./rules";
import { complianceSettings } from "./settings";
import { prepopulatedFacts } from "./entities";

/**
 * "Apply proposed compliance profile" — packaged proposals applied to an EXISTING client record.
 * Everything it creates is PROPOSED and Needs Verification until the owner approves each item.
 * It never invents an identifier: legal names, EINs, account numbers, frequencies and filing
 * history stay blank unless the office already has them on file (with their source).
 */

const V = (jur: string, extra: { registration?: string; frequency?: string; due?: string; authority?: string } = {}) => [
  `Jurisdiction: confirm ${jur} applies to this business's location and activity`,
  `Account registration: ${extra.registration ?? "confirm the account exists and record its number"}`,
  `Frequency: ${extra.frequency ?? "confirm the assigned filing frequency"}`,
  `Due date: ${extra.due ?? "confirm against the official source"}`,
  `Filing authority: ${extra.authority ?? "confirm how the firm is authorized to file (third-party access, POA or client-held login)"}`,
];

type Item = { key: string; ruleKey?: string; title?: string; formName?: string; jurisdictionLevel?: string; jurisdictionName?: string; category?: string; frequency?: string; dueRuleCode?: string; weekendRule?: string; verify: string[]; note?: string };

export type ProposalPackage = { key: string; name: string; description: string; business: { kind: string | null; taxClassification: string; sCorpYear: number | null; activityTags: string[]; industry: string; state: string; county: string; city: string }; items: Item[]; nonprofit: { items: Item[] } | null };

export const PROPOSALS: Record<string, ProposalPackage> = {
  RESTAURANT_AL_SCORP_JEFFERSON_BHM: {
    key: "RESTAURANT_AL_SCORP_JEFFERSON_BHM",
    name: "Restaurant + Alabama S corporation (effective 2025) + Jefferson County / Birmingham",
    description: "Restaurant in Birmingham (Jefferson County), Alabama, taxed as an S corporation from 2025, plus the owner's separate nonprofit.",
    business: { kind: null, taxClassification: "S_CORP", sCorpYear: 2025, activityTags: ["restaurant", "food_service", "sells_taxable"], industry: "Restaurant", state: "AL", county: "Jefferson", city: "Birmingham" },
    items: [
      { key: "FED_1120S", ruleKey: "FED_1120S", verify: [...V("the IRS (federal)", { registration: "confirm the IRS accepted the S election (Form 2553) effective 2025 and record the effective date", frequency: "annual (tax year — confirm fiscal year end)", authority: "Form 8879-S signed by an officer; firm ERO e-file" }), "Shareholders and ownership percentages for each K-1"] },
      { key: "AL_20S", ruleKey: "AL_20S", verify: V("the Alabama Department of Revenue", { registration: "confirm the ALDOR business account for income tax", frequency: "annual", authority: "Alabama e-file through the firm's software; MAT access if needed" }) },
      { key: "AL_BPT_PPT", ruleKey: "AL_BPT_PPT", verify: [...V("the Alabama Department of Revenue (Business Privilege Tax)", { registration: "confirm the BPT account in MAT", frequency: "annual", due: "due with Form 20S — confirm" }), "If filing is required: confirm the privilege tax exceeds the no-return threshold for the year"] },
      { key: "AL_SALES_2100", ruleKey: "AL_SALES_2100", verify: V("the Alabama Department of Revenue (state sales tax)", { registration: "record the ALDOR sales tax account number", frequency: "record ALDOR's assigned frequency (monthly / quarterly / annual)", authority: "MAT third-party access via the firm's agent account, or client-held login" }) },
      { key: "JEFF_SALES_USE", ruleKey: "JEFF_SALES_USE", verify: V("Jefferson County sales/use tax", { registration: "record the Jefferson County sales/use account number", frequency: "record the county's assigned frequency", authority: "county portal / ONE SPOT — confirm which administers it" }) },
      { key: "BHM_SALES_USE", ruleKey: "BHM_SALES_USE", verify: V("City of Birmingham sales/use tax", { registration: "record the Birmingham sales/use account number", frequency: "record the city's assigned frequency", authority: "city portal or ONE SPOT — confirm" }) },
      { key: "FED_941", ruleKey: "FED_941", verify: [...V("the IRS (federal payroll)", { registration: "confirm the business has employees and an EFTPS enrollment", frequency: "quarterly", authority: "Form 8655 / payroll provider or firm e-file" }), "If payroll applies: confirm who files it (the payroll provider or the firm)"] },
      { key: "FED_940", ruleKey: "FED_940", verify: [...V("the IRS (FUTA)", { frequency: "annual", authority: "payroll provider or firm e-file" }), "If payroll applies"] },
      { key: "FED_W2_W3", ruleKey: "FED_W2_W3", verify: [...V("the IRS / SSA (W-2s)", { frequency: "annual", authority: "payroll provider or SSA Business Services Online" }), "If payroll applies"] },
      { key: "AL_WH_A6", ruleKey: "AL_WH_A6", verify: [...V("the Alabama Department of Revenue (withholding A-6 / A-1)", { registration: "record the Alabama withholding account number", frequency: "record whether ALDOR assigned A-6 monthly or A-1 quarterly", authority: "MAT third-party access or payroll provider" }), "If payroll applies"] },
      { key: "AL_WH_A3", ruleKey: "AL_WH_A3", verify: [...V("the Alabama Department of Revenue (A-3 reconciliation)", { frequency: "annual" }), "If payroll applies"] },
      { key: "BHM_OCCUPATIONAL", ruleKey: "BHM_OCCUPATIONAL", verify: [...V("City of Birmingham occupational tax", { registration: "record the occupational tax account number", frequency: "record the city's assigned frequency" }), "If payroll applies"] },
      { key: "FED_1099_NEC", ruleKey: "FED_1099_NEC", verify: [...V("the IRS (1099 reporting)", { registration: "confirm which vendors/contractors require a 1099 (W-9s on file)", frequency: "annual", authority: "IRIS / FIRE through the firm" }), "Confirm whether 1099-MISC (rents etc.) also applies"] },
      { key: "AL_SALES_LICENSE_RENEWAL", ruleKey: "AL_SALES_LICENSE_RENEWAL", verify: V("the Alabama Department of Revenue (sales tax license)", { registration: "record the license number", frequency: "annual", due: "confirm the renewal window and date" }) },
      { key: "JEFF_BUSINESS_LICENSE", ruleKey: "JEFF_BUSINESS_LICENSE", verify: V("Jefferson County (state/county business license)", { registration: "record the Jefferson County license number", frequency: "annual", due: "confirm the license year and delinquency date" }) },
      { key: "BHM_BUSINESS_LICENSE", ruleKey: "BHM_BUSINESS_LICENSE", verify: V("City of Birmingham (municipal business license)", { registration: "record the Birmingham license number", frequency: "annual", due: "confirm the renewal date and the gross-receipts basis" }) },
      { key: "JEFF_ENTITY_LICENSE", ruleKey: "JEFF_ENTITY_LICENSE", verify: [...V("Jefferson County (Entity Business License)", { frequency: "annual" }), "If applicable: confirm whether this license applies to the entity"] },
      { key: "JCDH_FOOD_PERMIT", ruleKey: "JCDH_FOOD_PERMIT", verify: V("the Jefferson County Department of Health (food service permit)", { registration: "record the permit number and expiration date", frequency: "annual", due: "confirm the permit's expiration/renewal date" }) },
      { key: "AL_BPP_JEFFERSON", ruleKey: "AL_BPP_JEFFERSON", verify: [...V("the Jefferson County Tax Assessor (business personal property)", { registration: "confirm the business personal property account", frequency: "annual" }), "If applicable: confirm the business has reportable furniture, fixtures and equipment"] },
      {
        key: "OTHER_LOCATION_ACTIVITY", title: "Other location- or activity-specific obligations (checklist)", formName: "Checklist", jurisdictionLevel: "COUNTY", jurisdictionName: "Jefferson County / City of Birmingham", category: "OTHER", frequency: "ONE_TIME", dueRuleCode: "MANUAL", weekendRule: "NO_ADJUSTMENT",
        verify: ["Sells alcohol? If yes: Jefferson County restaurant/alcohol beverage tax, Birmingham beverage tax, ABC Board license", "Catering or a second location (another city or county)?", "Delivery vehicles, outdoor signage or sidewalk seating permits?", "Any other city where the restaurant sells (each city may have its own sales tax and license)"],
      },
    ],
    nonprofit: {
      items: [
        { key: "FED_990", ruleKey: "FED_990", verify: ["990-N / 990-EZ / 990 determination: gross receipts (normally) and total assets needed — uses the Nonprofit Filings tracker's form choice", "Fiscal year end", "IRS exemption status (determination letter)", "Due date: confirm against the official source"] },
        { key: "AL_AG_CHARITABLE", ruleKey: "AL_AG_CHARITABLE", verify: ["Jurisdiction: confirm whether the organization solicits in Alabama and must register (exemptions apply)", "Account registration: record the AG registration number if any", "Frequency: annual renewal", "Due date: confirm the renewal date", "Filing authority: confirm who signs the registration"] },
        { key: "AL_SOS_NONPROFIT", ruleKey: "AL_SOS_NONPROFIT", verify: ["State of formation (if Alabama, confirm whether an annual filing is required)", "Due date: confirm with the Secretary of State", "Filing authority: confirm who files"] },
        { key: "NP_EXEMPTION_DOCS", title: "Exemption documents on file (IRS determination letter, Form 1023/1023-EZ, state exemption)", formName: "Exemption documents", jurisdictionLevel: "FEDERAL", jurisdictionName: "IRS / Alabama", category: "NONPROFIT", frequency: "ONE_TIME", dueRuleCode: "MANUAL", weekendRule: "NO_ADJUSTMENT", verify: ["IRS determination letter", "Alabama sales tax exemption certificate (if any)", "Articles of incorporation and bylaws"] },
        { key: "NP_OWN_PAYROLL_TAX", title: "Nonprofit's own payroll / tax obligations (if any)", formName: "Checklist", jurisdictionLevel: "FEDERAL", jurisdictionName: "IRS / Alabama", category: "OTHER", frequency: "ONE_TIME", dueRuleCode: "MANUAL", weekendRule: "NO_ADJUSTMENT", verify: ["Does the nonprofit have employees? If yes, its own 941/940/W-2 and Alabama withholding — never combined with the restaurant's", "Unrelated business income (Form 990-T)?", "Sales tax on any sales?"] },
      ],
    },
  },
};

async function createItems(tx: Prisma.TransactionClient, entityId: string, clientId: string, items: Item[], actorId: string, prepLeadDays: number) {
  const rules = await tx.complianceRule.findMany({ where: { isCurrent: true } });
  let created = 0;
  for (const it of items) {
    const rule = it.ruleKey ? rules.find((r) => r.ruleKey === it.ruleKey) : undefined;
    if (it.ruleKey && !rule) throw new ValidationError(`Rule ${it.ruleKey} is missing from the library.`);
    const dedupeKey = it.ruleKey ?? `proposal:${it.key}`;
    if (await tx.complianceObligation.findUnique({ where: { entityId_dedupeKey: { entityId, dedupeKey } } })) continue;
    const verify = [...it.verify, ...(rule && rule.verificationStatus !== "VERIFIED" ? [`Rule not yet verified against the official source${rule.sourceUrls[0] ? ` (${rule.sourceUrls[0]})` : ""}`] : [])];
    await tx.complianceObligation.create({
      data: {
        entityId, clientId, ruleId: rule?.id ?? null, ruleKey: rule?.ruleKey ?? null, dedupeKey,
        title: it.title ?? (rule ? `${rule.formName} — ${rule.obligationName}` : it.key),
        formName: it.formName ?? rule!.formName,
        jurisdictionLevel: it.jurisdictionLevel ?? rule!.jurisdictionLevel,
        jurisdictionName: it.jurisdictionName ?? rule!.jurisdictionName,
        category: it.category ?? rule!.category,
        frequency: it.frequency ?? (rule!.frequency.startsWith("ACCOUNT:") ? rule!.frequency.slice(8) : rule!.frequency),
        dueRuleCode: it.dueRuleCode ?? rule!.dueRuleCode,
        dueRuleDescription: rule?.dueRuleDescription ?? "Entered by staff once confirmed",
        weekendRule: it.weekendRule ?? rule!.weekendRule,
        status: "PROPOSED", verification: "NEEDS_VERIFICATION", verifyItems: verify,
        clientApprovalRequired: rule?.clientApprovalDefault ?? false,
        requiredDocs: rule?.requiredDocs ?? [],
        extensionMonths: rule ? ((rule.conditions as { extensionMonths?: number })?.extensionMonths ?? null) : null,
        prepLeadDays, source: "PROPOSAL", createdById: actorId, notes: it.note ?? null,
      },
    });
    created++;
  }
  return created;
}

/**
 * Applies a packaged proposal to an existing client (idempotent: re-applying adds only what's
 * missing). Creates the business entity and, when the package has one, the owner's nonprofit as
 * a separate linked entity — its filings never mix with the business's.
 */
export async function applyProposedProfile(actor: Actor, clientId: string, packageKey: string) {
  await assertComplianceManage(actor);
  const pkg = PROPOSALS[packageKey];
  if (!pkg) throw new ValidationError("Choose a proposal package.");
  const client = await prisma.client.findUnique({ where: { id: clientId } });
  if (!client) throw new ValidationError("Client not found.");
  await currentRules();
  const settings = await complianceSettings();
  const pre = await prepopulatedFacts(clientId);
  const result = await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`cc-proposal:${clientId}:${packageKey}`}))`;
    let business = await tx.complianceEntity.findFirst({ where: { clientId, proposalKey: packageKey, proposalRole: "BUSINESS" } });
    if (!business) {
      const b = pkg.business;
      const sources: Record<string, string> = { ...pre.sources, taxClassification: "Proposal (verify)", activityTags: "Proposal (verify)", industry: "Proposal (verify)", statesOfOperation: "Proposal (verify)", stateOfFormation: "Proposal (verify)", ownerHasNonprofit: pkg.nonprofit ? "Proposal (verify)" : "" };
      const { kind: _k, nonprofitClientId: _n, ...facts } = pre.facts as Record<string, unknown>;
      void _k; void _n;
      business = await tx.complianceEntity.create({
        data: {
          ...(facts as object),
          clientId,
          kind: b.kind ?? "OTHER",
          status: "PROPOSED",
          taxClassification: b.taxClassification,
          // The S election year is known (2025); its exact effective date is not, so it stays blank and on the verify list.
          sCorpEffectiveDate: null,
          stateOfFormation: b.state,
          statesOfOperation: [b.state],
          industry: b.industry,
          activityTags: b.activityTags,
          ownerHasNonprofit: pkg.nonprofit ? "YES" : "UNKNOWN",
          factSources: sources,
          proposalKey: packageKey,
          proposalRole: "BUSINESS",
          notes: `Proposed profile: ${pkg.name}. Legal entity type (LLC or corporation), S election effective date (${b.sCorpYear}), fiscal year end and every account number must be verified.`,
          createdById: actor.id,
        } as Prisma.ComplianceEntityUncheckedCreateInput,
      });
      await tx.complianceLocation.create({ data: { entityId: business.id, label: "Restaurant", address1: pre.location?.address1 ?? null, city: b.city, county: b.county, state: b.state, postalCode: pre.location?.postalCode ?? null, isPrimary: true, source: pre.location ? `${pre.location.source} (address) + Proposal (city/county)` : "Proposal (verify)" } });
      for (const l of pre.licenses) await tx.complianceEntityLicense.upsert({ where: { businessLicenseId: l.id }, update: {}, create: { entityId: business.id, businessLicenseId: l.id } });
    }
    const businessItems = await createItems(tx, business.id, clientId, pkg.items, actor.id, settings.defaultPrepLeadDays);
    let nonprofit = null;
    let nonprofitItems = 0;
    if (pkg.nonprofit) {
      nonprofit = await tx.complianceEntity.findFirst({ where: { clientId, proposalKey: packageKey, proposalRole: "NONPROFIT" } });
      if (!nonprofit) {
        nonprofit = await tx.complianceEntity.create({
          data: {
            clientId, kind: "NONPROFIT", status: "PROPOSED", taxClassification: "EXEMPT_ORG", linkedEntityId: business.id,
            // Never guessed: legal name, EIN, state of formation, exemption status and FYE stay blank.
            legalName: null, stateOfFormation: null, fiscalYearEndMonth: null, irsExemptionStatus: null,
            statesOfOperation: [pkg.business.state],
            activityTags: ["nonprofit"],
            factSources: { kind: "Proposal (verify)", linkedEntityId: "Proposal", statesOfOperation: "Proposal (verify)" },
            proposalKey: packageKey, proposalRole: "NONPROFIT",
            notes: "The owner's nonprofit — a separate entity. Its filings, approvals and documents never mix with the business's.",
            createdById: actor.id,
          },
        });
      }
      nonprofitItems = await createItems(tx, nonprofit.id, clientId, pkg.nonprofit.items, actor.id, settings.defaultPrepLeadDays);
    }
    await audit(tx, { actorId: actor.id, action: "compliance.proposal_applied", entityType: "Client", entityId: clientId, clientId, details: { packageKey, businessEntityId: business.id, nonprofitEntityId: nonprofit?.id ?? null, businessItems, nonprofitItems } });
    return { business, nonprofit, businessItems, nonprofitItems };
  });
  return result;
}
