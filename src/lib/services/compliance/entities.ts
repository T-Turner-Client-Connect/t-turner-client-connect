import "server-only";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { audit } from "@/lib/audit";
import type { Actor } from "@/lib/auth/actor";
import { ForbiddenError } from "@/lib/auth/actor";
import { decryptSecret, encryptSecret, sign } from "@/lib/crypto";
import { ValidationError } from "@/lib/services/clients";
import type { EntityFacts } from "@/lib/compliance/evaluate";
import { assertComplianceManage, assertComplianceView, complianceAccess } from "./access";

export const ENTITY_KINDS = { LLC: "LLC", CORPORATION: "Corporation", PARTNERSHIP: "Partnership", SOLE_PROPRIETORSHIP: "Sole proprietorship", NONPROFIT: "Nonprofit", OTHER: "Other" } as const;
export const TAX_CLASSIFICATIONS = { S_CORP: "S corporation (1120-S)", C_CORP: "C corporation (1120)", PARTNERSHIP: "Partnership (1065)", SCHEDULE_C: "Sole proprietor (Schedule C)", DISREGARDED: "Disregarded entity (owner's return)", EXEMPT_ORG: "Tax-exempt organization (990 series)", OTHER: "Other" } as const;
export const ACCOUNT_TYPES = { SALES_USE: "Sales/use", WITHHOLDING: "Withholding", LOCAL: "Local (occupational/license)", OTHER: "Other" } as const;
export const ACCOUNT_STATUSES = ["ACTIVE", "PENDING", "CLOSED", "SUSPENDED", "UNKNOWN"] as const;
export const YES_NO = ["YES", "NO", "UNKNOWN"] as const;
export const EXEMPTION_STATUSES = { DETERMINATION_LETTER: "IRS determination letter on file", APPLICATION_PENDING: "Application pending", NOT_APPLIED: "Not applied", REVOKED: "Revoked", UNKNOWN: "Unknown" } as const;

export const PORTAL_KINDS = {
  MAT: { label: "My Alabama Taxes (MAT / ONE SPOT)", url: "https://myalabamataxes.alabama.gov/" },
  AVENU: { label: "Avenu local tax portal", url: "https://www.avenuinsights.com/" },
  JEFFCO_SRT: { label: "Jefferson County Revenue (sales/use)", url: "https://www.jccal.org/" },
  CITY_BIRMINGHAM: { label: "City of Birmingham (license / taxes)", url: "https://www.birminghamal.gov/" },
  CITY_HUNTSVILLE: { label: "City of Huntsville (taxes)", url: "https://www.huntsvilleal.gov/" },
  IRS_EFTPS: { label: "IRS EFTPS", url: "https://www.eftps.gov/" },
  IRS_ESERVICES: { label: "IRS e-Services", url: "https://www.irs.gov/e-services" },
  IRS_FIRE: { label: "IRS FIRE", url: "https://fire.irs.gov/" },
  IRS_IRIS: { label: "IRS IRIS (1099s)", url: "https://www.irs.gov/filing/e-file-information-returns-with-iris" },
  AL_SOS: { label: "Alabama Secretary of State", url: "https://www.sos.alabama.gov/" },
  LICENSING: { label: "Licensing agency", url: "" },
  OTHER: { label: "Other", url: "" },
} as const;

export const ACCESS_METHODS = [
  "MAT third-party access via firm agent account",
  "Client-held login (client files or shares screen)",
  "Form 2848A on file (AL power of attorney)",
  "Form 2848 / 8821 on file (IRS)",
  "Firm e-file software (ERO)",
  "Paper filing",
  "Other (see notes)",
];

const cleanStr = (v: string | null | undefined, max = 200) => {
  const t = (v ?? "").trim();
  return t ? t.slice(0, max) : null;
};
const stateCode = (v: string | null | undefined) => {
  const t = (v ?? "").trim().toUpperCase();
  if (!t) return null;
  if (!/^[A-Z]{2}$/.test(t)) throw new ValidationError("Use two-letter state codes (AL, GA…).");
  return t;
};

/** Never store passwords, MFA secrets or recovery codes in Accounts & Portals fields. */
export function assertNoSecret(...values: (string | null | undefined)[]) {
  for (const v of values) {
    if (v && /(?<![a-z0-9])(password|passwd|pwd|passcode|pin|otp|mfa code|secret|recovery code)\s*[:=]/i.test(v)) {
      throw new ValidationError("Don't store passwords, PINs or MFA codes here. Record only how the firm gets access and a reference (e.g. the password-manager item name).");
    }
  }
}

export function normalizeEin(v: string) {
  const d = v.replace(/\D/g, "");
  if (d.length !== 9) throw new ValidationError("An EIN has 9 digits (12-3456789).");
  return `${d.slice(0, 2)}-${d.slice(2)}`;
}
export const maskEin = (last4: string | null | undefined) => (last4 ? `XX-XXX${last4}` : null);

async function entityOr404(entityId: string) {
  const e = await prisma.complianceEntity.findUnique({ where: { id: entityId } });
  if (!e) throw new ValidationError("Entity not found.");
  return e;
}

export type EntityInput = {
  kind: string;
  legalName?: string | null;
  dba?: string | null;
  stateOfFormation?: string | null;
  statesOfOperation?: string[];
  industry?: string | null;
  naicsCode?: string | null;
  activityDescription?: string | null;
  activityTags?: string[];
  legalEntityType?: string | null;
  taxClassification?: string | null;
  sCorpEffectiveDate?: string | null;
  fiscalYearEndMonth?: number | null;
  payrollStatus?: string;
  employeeCount?: number | null;
  payrollProvider?: string | null;
  issues1099?: string;
  ownerHasNonprofit?: string;
  irsExemptionStatus?: string | null;
  services?: string[];
  portalVisible?: boolean;
  clientNotificationsEnabled?: boolean;
  notes?: string | null;
};

function cleanEntity(input: EntityInput) {
  if (!(input.kind in ENTITY_KINDS)) throw new ValidationError("Choose the entity type.");
  if (input.taxClassification && !(input.taxClassification in TAX_CLASSIFICATIONS)) throw new ValidationError("Choose the federal tax classification.");
  const fye = input.fiscalYearEndMonth ?? null;
  if (fye !== null && (!Number.isInteger(fye) || fye < 1 || fye > 12)) throw new ValidationError("Fiscal year-end month is 1–12.");
  for (const k of ["payrollStatus", "issues1099", "ownerHasNonprofit"] as const) {
    if (input[k] && !(YES_NO as readonly string[]).includes(input[k]!)) throw new ValidationError("Choose Yes, No or Unknown.");
  }
  if (input.irsExemptionStatus && !(input.irsExemptionStatus in EXEMPTION_STATUSES)) throw new ValidationError("Choose the IRS exemption status.");
  const naics = cleanStr(input.naicsCode, 10);
  if (naics && !/^\d{2,6}$/.test(naics)) throw new ValidationError("A NAICS code is 2–6 digits.");
  const emp = input.employeeCount ?? null;
  if (emp !== null && (!Number.isInteger(emp) || emp < 0)) throw new ValidationError("Employee count must be a whole number.");
  const scorp = input.sCorpEffectiveDate ? new Date(`${input.sCorpEffectiveDate}T00:00:00Z`) : null;
  if (scorp && Number.isNaN(scorp.getTime())) throw new ValidationError("Enter the S election effective date.");
  return {
    kind: input.kind,
    legalName: cleanStr(input.legalName),
    dba: cleanStr(input.dba),
    stateOfFormation: stateCode(input.stateOfFormation),
    statesOfOperation: [...new Set((input.statesOfOperation ?? []).map(stateCode).filter((s): s is string => !!s))],
    industry: cleanStr(input.industry, 100),
    naicsCode: naics,
    activityDescription: cleanStr(input.activityDescription, 1000),
    activityTags: [...new Set((input.activityTags ?? []).map((t) => t.trim().toLowerCase().replace(/\s+/g, "_")).filter(Boolean))].slice(0, 30),
    legalEntityType: cleanStr(input.legalEntityType, 100),
    taxClassification: input.taxClassification || null,
    sCorpEffectiveDate: scorp,
    fiscalYearEndMonth: fye,
    payrollStatus: input.payrollStatus ?? "UNKNOWN",
    employeeCount: emp,
    payrollProvider: cleanStr(input.payrollProvider, 100),
    issues1099: input.issues1099 ?? "UNKNOWN",
    ownerHasNonprofit: input.ownerHasNonprofit ?? "UNKNOWN",
    irsExemptionStatus: input.irsExemptionStatus || null,
    services: input.services ?? [],
    portalVisible: !!input.portalVisible,
    clientNotificationsEnabled: !!input.clientNotificationsEnabled,
    notes: cleanStr(input.notes, 2000),
  };
}

export async function createEntity(actor: Actor, clientId: string, input: EntityInput & { ein?: string | null }) {
  await assertComplianceManage(actor);
  if (!(await prisma.client.count({ where: { id: clientId } }))) throw new ValidationError("Client not found.");
  const data = cleanEntity(input);
  const ein = input.ein?.trim() ? normalizeEin(input.ein) : null;
  const sources: Record<string, string> = {};
  for (const [k, v] of Object.entries(data)) if (v !== null && v !== "UNKNOWN" && !(Array.isArray(v) && !v.length) && v !== false) sources[k] = "Staff";
  if (ein) sources.ein = "Staff";
  const e = await prisma.complianceEntity.create({
    data: { ...data, clientId, createdById: actor.id, factSources: sources, ...(ein ? einData(ein) : {}) },
  });
  await audit(prisma, { actorId: actor.id, action: "compliance.entity_created", entityType: "ComplianceEntity", entityId: e.id, clientId, details: { kind: e.kind, einSet: !!ein } });
  return e;
}

function einData(ein: string) {
  return { einEncrypted: encryptSecret(ein), einLast4: ein.slice(-4), einHash: sign(`ein:${ein.replace(/\D/g, "")}`) };
}

export async function updateEntity(actor: Actor, entityId: string, input: EntityInput) {
  await assertComplianceManage(actor);
  const before = await entityOr404(entityId);
  const data = cleanEntity(input);
  const sources = { ...((before.factSources as Record<string, string>) ?? {}) };
  const changed: string[] = [];
  for (const [k, v] of Object.entries(data)) {
    const was = (before as Record<string, unknown>)[k];
    if (JSON.stringify(was instanceof Date ? was.toISOString() : was ?? null) !== JSON.stringify(v instanceof Date ? v.toISOString() : v ?? null)) {
      changed.push(k);
      sources[k] = "Staff";
    }
  }
  await prisma.complianceEntity.update({ where: { id: entityId }, data: { ...data, factSources: sources } });
  await audit(prisma, { actorId: actor.id, action: "compliance.entity_updated", entityType: "ComplianceEntity", entityId, clientId: before.clientId, details: { changed } });
  return changed;
}

export async function setEntityEin(actor: Actor, entityId: string, ein: string) {
  await assertComplianceManage(actor);
  const e = await entityOr404(entityId);
  const v = normalizeEin(ein);
  await prisma.complianceEntity.update({ where: { id: entityId }, data: { ...einData(v), factSources: { ...((e.factSources as object) ?? {}), ein: "Staff" } } });
  await audit(prisma, { actorId: actor.id, action: "compliance.ein_set", entityType: "ComplianceEntity", entityId, clientId: e.clientId });
}

/** The full EIN for the owner or a staff member with the explicit grant. A reason is required and logged. */
export async function revealEntityEin(actor: Actor, entityId: string, reason: string) {
  const a = await complianceAccess(actor);
  if (a.level === "NONE") throw new ForbiddenError("Not found.");
  if (!a.canRevealEin) throw new ForbiddenError("Only Tabitha, or staff she allows, can reveal a full EIN.");
  const why = reason.trim();
  if (why.length < 5) throw new ValidationError("Say why you need the full EIN.");
  const e = await entityOr404(entityId);
  if (!e.einEncrypted) throw new ValidationError("No EIN on file.");
  await audit(prisma, { actorId: actor.id, action: "compliance.ein_revealed", entityType: "ComplianceEntity", entityId, clientId: e.clientId, details: { reason: why.slice(0, 300) } });
  return decryptSecret(e.einEncrypted);
}

export async function setEntityStatus(actor: Actor, entityId: string, status: "ACTIVE" | "INACTIVE") {
  const { assertComplianceOwner } = await import("./access");
  await assertComplianceOwner(actor);
  const e = await entityOr404(entityId);
  await prisma.complianceEntity.update({ where: { id: entityId }, data: { status } });
  await audit(prisma, { actorId: actor.id, action: `compliance.entity_${status.toLowerCase()}`, entityType: "ComplianceEntity", entityId, clientId: e.clientId });
}

// --- Owners, viewers, locations, accounts ----------------------------------------------------

export async function setEntityOwners(actor: Actor, entityId: string, businessOwnerIds: string[]) {
  await assertComplianceManage(actor);
  const e = await entityOr404(entityId);
  const valid = await prisma.businessOwner.findMany({ where: { id: { in: businessOwnerIds }, clientId: e.clientId, archivedAt: null }, select: { id: true } });
  if (valid.length !== new Set(businessOwnerIds).size) throw new ValidationError("Choose owners of this client.");
  await prisma.$transaction([
    prisma.complianceEntityOwner.deleteMany({ where: { entityId, businessOwnerId: { notIn: businessOwnerIds } } }),
    prisma.complianceEntityOwner.createMany({ data: businessOwnerIds.map((id) => ({ entityId, businessOwnerId: id, createdById: actor.id })), skipDuplicates: true }),
  ]);
  await audit(prisma, { actorId: actor.id, action: "compliance.entity_owners_set", entityType: "ComplianceEntity", entityId, clientId: e.clientId, details: { owners: businessOwnerIds.length } });
}

/** Explicit portal grant for one login (e.g. a co-owner of a different business). */
export async function grantEntityViewer(actor: Actor, entityId: string, portalUserId: string, on: boolean) {
  await assertComplianceManage(actor);
  const e = await entityOr404(entityId);
  if (!(await prisma.portalAccess.count({ where: { portalUserId, clientId: e.clientId, revokedAt: null } }))) throw new ValidationError("That login has no access to this client.");
  if (on) await prisma.complianceEntityViewer.upsert({ where: { entityId_portalUserId: { entityId, portalUserId } }, update: { revokedAt: null, grantedById: actor.id }, create: { entityId, portalUserId, grantedById: actor.id } });
  else await prisma.complianceEntityViewer.updateMany({ where: { entityId, portalUserId, revokedAt: null }, data: { revokedAt: new Date() } });
  await audit(prisma, { actorId: actor.id, action: on ? "compliance.viewer_granted" : "compliance.viewer_revoked", entityType: "ComplianceEntity", entityId, clientId: e.clientId, details: { portalUserId } });
}

export async function addLocation(actor: Actor, entityId: string, input: { label?: string; address1?: string; city?: string; county?: string; state?: string; postalCode?: string; isPrimary?: boolean }) {
  await assertComplianceManage(actor);
  const e = await entityOr404(entityId);
  const county = cleanStr(input.county, 60)?.replace(/\s+county$/i, "") ?? null;
  const loc = await prisma.complianceLocation.create({ data: { entityId, label: cleanStr(input.label, 80), address1: cleanStr(input.address1), city: cleanStr(input.city, 80), county, state: stateCode(input.state), postalCode: cleanStr(input.postalCode, 10), isPrimary: !!input.isPrimary, source: "Staff" } });
  await audit(prisma, { actorId: actor.id, action: "compliance.location_added", entityType: "ComplianceEntity", entityId, clientId: e.clientId });
  return loc;
}

export async function removeLocation(actor: Actor, locationId: string) {
  await assertComplianceManage(actor);
  const l = await prisma.complianceLocation.findUnique({ where: { id: locationId }, include: { entity: true } });
  if (!l) throw new ValidationError("Location not found.");
  await prisma.complianceLocation.delete({ where: { id: locationId } });
  await audit(prisma, { actorId: actor.id, action: "compliance.location_removed", entityType: "ComplianceEntity", entityId: l.entityId, clientId: l.entity.clientId });
}

export type TaxAccountInput = { type: string; agency: string; jurisdictionLevel?: string | null; jurisdictionName?: string | null; accountNumber?: string | null; filingFrequency?: string | null; effectiveDate?: string | null; status?: string; notes?: string | null };

function cleanAccount(input: TaxAccountInput) {
  if (!(input.type in ACCOUNT_TYPES)) throw new ValidationError("Choose the account type.");
  const agency = cleanStr(input.agency, 120);
  if (!agency) throw new ValidationError("Enter the agency.");
  if (input.filingFrequency && !["MONTHLY", "QUARTERLY", "SEMIANNUAL", "ANNUAL"].includes(input.filingFrequency)) throw new ValidationError("Choose the filing frequency.");
  if (input.status && !(ACCOUNT_STATUSES as readonly string[]).includes(input.status)) throw new ValidationError("Choose the account status.");
  assertNoSecret(input.notes);
  const num = (input.accountNumber ?? "").trim();
  return {
    type: input.type,
    agency,
    jurisdictionLevel: input.jurisdictionLevel || null,
    jurisdictionName: cleanStr(input.jurisdictionName, 120),
    ...(num ? { accountNumberEnc: encryptSecret(num), accountLast4: num.replace(/\s/g, "").slice(-4) } : {}),
    filingFrequency: input.filingFrequency || null,
    effectiveDate: input.effectiveDate ? new Date(`${input.effectiveDate}T00:00:00Z`) : null,
    status: input.status ?? "UNKNOWN",
    notes: cleanStr(input.notes, 1000),
  };
}

export async function saveTaxAccount(actor: Actor, entityId: string, input: TaxAccountInput, accountId?: string) {
  await assertComplianceManage(actor);
  const e = await entityOr404(entityId);
  const data = cleanAccount(input);
  if (accountId) {
    const a = await prisma.complianceTaxAccount.findFirst({ where: { id: accountId, entityId } });
    if (!a) throw new ValidationError("Account not found.");
    await prisma.complianceTaxAccount.update({ where: { id: accountId }, data: { ...data, source: "Staff" } });
  } else {
    await prisma.complianceTaxAccount.create({ data: { ...data, entityId, source: "Staff" } });
  }
  await audit(prisma, { actorId: actor.id, action: accountId ? "compliance.tax_account_updated" : "compliance.tax_account_added", entityType: "ComplianceEntity", entityId, clientId: e.clientId, details: { type: data.type, status: data.status, numberChanged: "accountNumberEnc" in data } });
}

export async function linkLicense(actor: Actor, entityId: string, businessLicenseId: string) {
  await assertComplianceManage(actor);
  const e = await entityOr404(entityId);
  const lic = await prisma.businessLicense.findFirst({ where: { id: businessLicenseId, clientId: e.clientId, archivedAt: null } });
  if (!lic) throw new ValidationError("Choose one of this client's business licenses.");
  await prisma.complianceEntityLicense.upsert({ where: { businessLicenseId }, update: { entityId }, create: { entityId, businessLicenseId } });
  await audit(prisma, { actorId: actor.id, action: "compliance.license_linked", entityType: "ComplianceEntity", entityId, clientId: e.clientId, details: { businessLicenseId } });
}

// --- Filing accounts & portals ---------------------------------------------------------------

export type FilingAccountInput = { portalKind: string; name: string; portalUrl: string; accessMethod?: string | null; accessReference?: string | null; firmAccountId?: string | null; status?: string; notes?: string | null };

function cleanFilingAccount(input: FilingAccountInput) {
  if (!(input.portalKind in PORTAL_KINDS)) throw new ValidationError("Choose the portal.");
  const url = (input.portalUrl || PORTAL_KINDS[input.portalKind as keyof typeof PORTAL_KINDS].url).trim();
  if (!/^https:\/\/[^\s]+$/i.test(url)) throw new ValidationError("Enter the portal's https:// address.");
  const name = cleanStr(input.name, 120);
  if (!name) throw new ValidationError("Name this account (e.g. “MAT — sales tax”).");
  assertNoSecret(input.accessMethod, input.accessReference, input.notes);
  return { portalKind: input.portalKind, name, portalUrl: url, accessMethod: cleanStr(input.accessMethod, 200), accessReference: cleanStr(input.accessReference, 200), status: input.status && ["ACTIVE", "PENDING", "INACTIVE"].includes(input.status) ? input.status : "ACTIVE", notes: cleanStr(input.notes, 1000) };
}

/** The firm's own records (e.g. the MAT third-party agent account): one per portal kind, reused by every client. */
export async function saveFirmAccount(actor: Actor, input: FilingAccountInput) {
  const { assertComplianceOwner } = await import("./access");
  await assertComplianceOwner(actor);
  const data = cleanFilingAccount(input);
  const existing = await prisma.complianceFilingAccount.findFirst({ where: { firmLevel: true, portalKind: data.portalKind } });
  const row = existing
    ? await prisma.complianceFilingAccount.update({ where: { id: existing.id }, data })
    : await prisma.complianceFilingAccount.create({ data: { ...data, firmLevel: true, entityId: null, createdById: actor.id } });
  await audit(prisma, { actorId: actor.id, action: existing ? "compliance.firm_account_updated" : "compliance.firm_account_added", entityType: "ComplianceFilingAccount", entityId: row.id, details: { portalKind: data.portalKind } });
  return row;
}

export async function saveFilingAccount(actor: Actor, entityId: string, input: FilingAccountInput, accountId?: string) {
  await assertComplianceManage(actor);
  const e = await entityOr404(entityId);
  const data = cleanFilingAccount(input);
  let firmAccountId: string | null = null;
  if (input.firmAccountId) {
    const f = await prisma.complianceFilingAccount.findFirst({ where: { id: input.firmAccountId, firmLevel: true } });
    if (!f) throw new ValidationError("Choose a firm-level account.");
    firmAccountId = f.id;
  }
  const row = accountId
    ? await prisma.complianceFilingAccount.update({ where: { id: (await prisma.complianceFilingAccount.findFirstOrThrow({ where: { id: accountId, entityId } })).id }, data: { ...data, firmAccountId } })
    : await prisma.complianceFilingAccount.create({ data: { ...data, firmAccountId, entityId, createdById: actor.id } });
  await audit(prisma, { actorId: actor.id, action: accountId ? "compliance.filing_account_updated" : "compliance.filing_account_added", entityType: "ComplianceFilingAccount", entityId: row.id, clientId: e.clientId, details: { portalKind: data.portalKind, viaFirmAccount: !!firmAccountId } });
  // Obligations whose rule names this portal get the "Open portal" link.
  await prisma.complianceObligation.updateMany({ where: { entityId, filingAccountId: null, rule: { portalKind: data.portalKind } }, data: { filingAccountId: row.id } });
  return row;
}

export async function addAuthorization(actor: Actor, entityId: string, input: { formType: string; filingAccountId?: string | null; documentId?: string | null; effectiveDate?: string | null; expiresAt?: string | null; status?: string; notes?: string | null }) {
  await assertComplianceManage(actor);
  const e = await entityOr404(entityId);
  const formType = cleanStr(input.formType, 40);
  if (!formType) throw new ValidationError("Name the form (2848, 2848A, 8821…).");
  if (input.documentId && !(await prisma.complianceDocument.count({ where: { documentId: input.documentId, entityId } }))) throw new ValidationError("That document isn't in this entity's folder.");
  if (input.filingAccountId && !(await prisma.complianceFilingAccount.count({ where: { id: input.filingAccountId, entityId } }))) throw new ValidationError("Choose one of this entity's portals.");
  assertNoSecret(input.notes);
  const row = await prisma.complianceAuthorization.create({
    data: { entityId, formType, filingAccountId: input.filingAccountId || null, documentId: input.documentId || null, effectiveDate: input.effectiveDate ? new Date(`${input.effectiveDate}T00:00:00Z`) : null, expiresAt: input.expiresAt ? new Date(`${input.expiresAt}T00:00:00Z`) : null, status: input.status ?? "ON_FILE", notes: cleanStr(input.notes, 500), createdById: actor.id },
  });
  await audit(prisma, { actorId: actor.id, action: "compliance.authorization_added", entityType: "ComplianceEntity", entityId, clientId: e.clientId, details: { formType } });
  return row;
}

// --- Facts for the rule engine -------------------------------------------------------------

export async function entityFacts(entityId: string): Promise<EntityFacts> {
  const e = await prisma.complianceEntity.findUniqueOrThrow({ where: { id: entityId }, include: { locations: true, taxAccounts: true } });
  const np = e.nonprofitClientId ? await prisma.nonprofitProfile.findUnique({ where: { clientId: e.nonprofitClientId } }) : null;
  const locStates = e.locations.map((l) => l.state).filter((s): s is string => !!s);
  return {
    kind: e.kind,
    taxClassification: e.taxClassification,
    sCorpEffectiveDate: e.sCorpEffectiveDate ? e.sCorpEffectiveDate.toISOString().slice(0, 10) : null,
    fiscalYearEndMonth: e.fiscalYearEndMonth,
    stateOfFormation: e.stateOfFormation,
    states: [...new Set([...(e.stateOfFormation ? [e.stateOfFormation] : []), ...e.statesOfOperation, ...locStates])],
    counties: e.locations.map((l) => l.county).filter((s): s is string => !!s),
    cities: e.locations.map((l) => l.city).filter((s): s is string => !!s),
    hasLocation: e.locations.length > 0,
    activityTags: e.activityTags,
    payrollStatus: e.payrollStatus,
    issues1099: e.issues1099,
    irsExemptionStatus: e.irsExemptionStatus,
    nonprofitForm: np?.formType ?? null,
    registrations: e.taxAccounts.map((a) => ({ id: a.id, type: a.type, jurisdictionName: a.jurisdictionName, agency: a.agency, status: a.status, filingFrequency: a.filingFrequency, accountLast4: a.accountLast4 })),
  };
}

// --- Prepopulation from reliable existing data -------------------------------------------

const CLIENT_ENTITY_TO_CLASS: Record<string, string> = { S_CORP: "S_CORP", C_CORP: "C_CORP", PARTNERSHIP: "PARTNERSHIP", SOLE_PROPRIETOR: "SCHEDULE_C", NONPROFIT: "EXEMPT_ORG" };
const BK_CLASS: Record<string, string> = { FORM_1120S: "S_CORP", FORM_1065: "PARTNERSHIP", SCHEDULE_C: "SCHEDULE_C" };
const TAXACT_CLASS: Record<string, string> = { "1120S": "S_CORP", "1120": "C_CORP", "1065": "PARTNERSHIP", "990": "EXEMPT_ORG" };

/**
 * Facts we can read from records the office already keeps — Client, BookkeepingProfile,
 * NonprofitProfile, BusinessLicense, ClientService and TaxAct return types. Each fact carries its
 * source. Nothing is invented: a fact we don't have stays blank.
 */
export async function prepopulatedFacts(clientId: string) {
  const c = await prisma.client.findUniqueOrThrow({
    where: { id: clientId },
    include: { bookkeepingProfile: true, nonprofitProfile: true, clientServices: { where: { status: { not: "CLOSED" } } }, taxPrepCases: { orderBy: { taxYear: "desc" }, take: 1 }, businessLicenses: { where: { archivedAt: null } } },
  });
  const bk = c.bookkeepingProfile;
  const src: Record<string, string> = {};
  const facts: Partial<Prisma.ComplianceEntityUncheckedCreateInput> = {};
  const set = <K extends keyof Prisma.ComplianceEntityUncheckedCreateInput>(k: K, v: Prisma.ComplianceEntityUncheckedCreateInput[K] | null | undefined, source: string) => {
    if (v === null || v === undefined || v === "") return;
    facts[k] = v;
    src[k as string] = source;
  };
  set("legalName", bk?.legalName || c.businessName, bk?.legalName ? "BookkeepingProfile" : "Client");
  set("dba", bk?.dba, "BookkeepingProfile");
  if (bk?.einEncrypted) {
    facts.einEncrypted = bk.einEncrypted;
    facts.einLast4 = bk.einLast4;
    facts.einHash = bk.einHash;
    src.ein = "BookkeepingProfile";
  }
  const taxact = c.taxPrepCases[0]?.returnType ? TAXACT_CLASS[c.taxPrepCases[0].returnType] : undefined;
  const cls = (bk?.taxClassification && BK_CLASS[bk.taxClassification]) || (c.entityType && CLIENT_ENTITY_TO_CLASS[c.entityType]) || taxact;
  set("taxClassification", cls, bk?.taxClassification && BK_CLASS[bk.taxClassification] ? "BookkeepingProfile" : c.entityType && CLIENT_ENTITY_TO_CLASS[c.entityType] ? "Client" : `TaxAct import (${c.taxPrepCases[0]?.taxYear} return type)`);
  set("fiscalYearEndMonth", c.fiscalYearEnd, "Client");
  if (bk) {
    set("payrollStatus", bk.payroll ? "YES" : null, "BookkeepingProfile");
    set("payrollProvider", bk.payrollProvider, "BookkeepingProfile");
  }
  const state = bk?.businessState || c.state;
  if (state && /^[A-Z]{2}$/i.test(state)) {
    facts.statesOfOperation = [state.toUpperCase()];
    src.statesOfOperation = bk?.businessState ? "BookkeepingProfile" : "Client";
  }
  const services = [...new Set(c.clientServices.map((s) => s.type))];
  if (services.length) {
    facts.services = services;
    src.services = "ClientService";
  }
  if (c.clientType === "NONPROFIT") {
    facts.kind = "NONPROFIT";
    src.kind = "Client";
    if (c.nonprofitProfile) {
      facts.nonprofitClientId = c.id;
      src.nonprofitClientId = "NonprofitProfile";
    }
  }
  const location = bk?.businessCity || c.city ? { address1: bk?.businessAddress1 || c.addressLine1 || null, city: bk?.businessCity || c.city || null, state: (bk?.businessState || c.state || null)?.toUpperCase() ?? null, postalCode: bk?.businessPostalCode || c.postalCode || null, source: bk?.businessCity ? "BookkeepingProfile" : "Client" } : null;
  return { facts, sources: src, location, licenses: c.businessLicenses, services };
}

/** Creates an entity from what the office already knows about the client (staff then complete it). */
export async function createEntityFromClient(actor: Actor, clientId: string, extra: { kind?: string } = {}) {
  await assertComplianceManage(actor);
  const p = await prepopulatedFacts(clientId);
  const kind = (p.facts.kind as string) ?? extra.kind ?? "OTHER";
  if (!(kind in ENTITY_KINDS)) throw new ValidationError("Choose the entity type.");
  const e = await prisma.complianceEntity.create({ data: { ...(p.facts as object), kind, clientId, factSources: p.sources, createdById: actor.id } as Prisma.ComplianceEntityUncheckedCreateInput });
  if (p.location) await prisma.complianceLocation.create({ data: { entityId: e.id, ...p.location, isPrimary: true } });
  for (const l of p.licenses) await prisma.complianceEntityLicense.upsert({ where: { businessLicenseId: l.id }, update: {}, create: { entityId: e.id, businessLicenseId: l.id } });
  await audit(prisma, { actorId: actor.id, action: "compliance.entity_prepopulated", entityType: "ComplianceEntity", entityId: e.id, clientId, details: { sources: p.sources } });
  return e;
}

export async function entitiesForClient(actor: Actor, clientId: string) {
  await assertComplianceView(actor);
  return prisma.complianceEntity.findMany({ where: { clientId }, orderBy: [{ archivedAt: "asc" }, { createdAt: "asc" }], include: { _count: { select: { obligations: true } }, linkedEntity: { select: { id: true, legalName: true } } } });
}

/** Applies an industry template: adds its suggested activity tags (rules then evaluate as usual). */
export async function applyIndustryTemplate(actor: Actor, entityId: string, templateKey: string) {
  await assertComplianceManage(actor);
  const e = await entityOr404(entityId);
  const t = await prisma.complianceIndustryTemplate.findFirst({ where: { key: templateKey, archivedAt: null } });
  if (!t) throw new ValidationError("Choose an industry template.");
  const tags = [...new Set([...e.activityTags, ...t.activityTags])];
  await prisma.complianceEntity.update({ where: { id: entityId }, data: { activityTags: tags, industry: e.industry ?? t.name, factSources: { ...((e.factSources as object) ?? {}), activityTags: `Template: ${t.name}` } } });
  await audit(prisma, { actorId: actor.id, action: "compliance.template_applied", entityType: "ComplianceEntity", entityId, clientId: e.clientId, details: { template: t.key } });
  return t;
}
