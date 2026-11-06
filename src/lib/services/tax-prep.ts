import "server-only";
import type { Prisma, TaxPrepCase } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { audit } from "@/lib/audit";
import { ForbiddenError, type Actor } from "@/lib/auth/actor";
import { ValidationError } from "@/lib/services/clients";
import { buildDisplayName, householdName, normalizePhone } from "@/lib/normalize";
import { isJointReturn, isReturnType, joinName, looksCombined, SPOUSE_RETURN_TYPES, type PersonName, type ReturnTypeCode } from "@/lib/tax/return-types";
import { formsForPrepCase } from "@/lib/tax/accepted";
import { normalizeJurisdiction } from "@/lib/tax/normalize";

type Db = Prisma.TransactionClient | typeof prisma;

/**
 * Who may set or change a tax return type: an Admin, the client's assigned
 * staff member, or the staff member assigned to one of the client's tax
 * services.
 */
export async function canEditTaxPrep(actor: Actor, clientId: string): Promise<boolean> {
  if (actor.role === "ADMIN") return true;
  const client = await prisma.client.findUnique({ where: { id: clientId }, select: { assignedToId: true } });
  if (client?.assignedToId === actor.id) return true;
  const svc = await prisma.clientService.count({ where: { clientId, assignedToId: actor.id, type: { in: ["TAX_INDIVIDUAL", "TAX_BUSINESS", "TAX_AMENDED", "TAX_NONPROFIT"] } } });
  return svc > 0;
}

async function assertCanEdit(actor: Actor, clientId: string) {
  if (!(await canEditTaxPrep(actor, clientId))) {
    throw new ForbiddenError("Only an Admin or the staff member assigned to this client can change the tax return type.");
  }
}

const clean = (v: unknown, max = 100) => {
  const s = typeof v === "string" ? v.trim().replace(/\s+/g, " ").slice(0, max) : "";
  return s === "" ? null : s;
};

function checkYear(taxYear: number) {
  if (!Number.isInteger(taxYear) || taxYear < 2000 || taxYear > new Date().getFullYear() + 1) throw new ValidationError("Choose a valid tax year.");
}

/**
 * Keeps the client's name in step with its latest case: a joint return shows
 * the household ("Allison R Stockton & Jonathan Scoggins") on one record;
 * a name that still holds two people is split into the primary taxpayer.
 */
export async function syncHouseholdName(db: Db, clientId: string) {
  const client = await db.client.findUniqueOrThrow({ where: { id: clientId } });
  const latest = await db.taxPrepCase.findFirst({ where: { clientId }, orderBy: { taxYear: "desc" } });
  const data: Prisma.ClientUpdateInput = {};
  let first = client.firstName;
  let middle = client.middleName;
  let last = client.lastName;
  if (looksCombined(client) && latest && (latest.primaryFirstName || latest.primaryLastName)) {
    first = latest.primaryFirstName;
    middle = latest.primaryMiddleName;
    last = latest.primaryLastName;
    Object.assign(data, { firstName: first, middleName: middle, lastName: last });
  }
  // The spouse profile on the client record; the latest joint case fills it in when blank.
  const spouse = {
    first: client.spouseFirstName ?? latest?.spouseFirstName ?? null,
    middle: client.spouseMiddleName ?? (client.spouseFirstName ? null : latest?.spouseMiddleName ?? null),
    last: client.spouseLastName ?? latest?.spouseLastName ?? null,
  };
  if (!client.spouseFirstName && !client.spouseLastName && (spouse.first || spouse.last) && latest && (!latest.returnType || isJointReturn(latest.returnType))) {
    Object.assign(data, { spouseFirstName: spouse.first, spouseMiddleName: spouse.middle, spouseLastName: spouse.last });
    if (!client.spouseEmail && latest.spouseEmail) data.spouseEmail = latest.spouseEmail;
    if (!client.spousePhone && latest.spousePhone) Object.assign(data, { spousePhone: latest.spousePhone, spousePhoneNormalized: normalizePhone(latest.spousePhone) });
  }
  const joint = (spouse.first || spouse.last) && (!latest || !latest.returnType || isJointReturn(latest.returnType));
  const display =
    client.clientType === "INDIVIDUAL"
      ? joint
        ? householdName({ first: [first, middle].filter(Boolean).join(" ") || null, last }, { first: [spouse.first, spouse.middle].filter(Boolean).join(" ") || null, last: spouse.last })
        : buildDisplayName({ firstName: [first, middle].filter(Boolean).join(" ") || null, lastName: last, businessName: client.businessName })
      : client.displayName;
  if (display && display !== client.displayName) data.displayName = display;
  if (Object.keys(data).length === 0) return null;
  await db.client.update({ where: { id: clientId }, data });
  return data;
}

export type CaseInput = {
  taxYear: number;
  returnType: string;
  otherReturnForm?: string | null;
  primaryFirstName?: string | null;
  primaryMiddleName?: string | null;
  primaryLastName?: string | null;
  spouseFirstName?: string | null;
  spouseMiddleName?: string | null;
  spouseLastName?: string | null;
  spouseEmail?: string | null;
  spousePhone?: string | null;
};

const CASE_FIELDS = [
  "returnType",
  "otherReturnForm",
  "primaryFirstName",
  "primaryMiddleName",
  "primaryLastName",
  "spouseFirstName",
  "spouseMiddleName",
  "spouseLastName",
  "spouseEmail",
  "spousePhone",
] as const;

/**
 * Staff selects (or changes) the return type for one tax year, and records
 * the primary taxpayer and spouse. Saving confirms the selection. One case per
 * client per year: a joint return never becomes a second client or return.
 */
export async function saveTaxPrepCase(actor: Actor, clientId: string, input: CaseInput) {
  await assertCanEdit(actor, clientId);
  const taxYear = Number(input.taxYear);
  checkYear(taxYear);
  const returnType = clean(input.returnType, 20);
  if (!isReturnType(returnType)) throw new ValidationError("Select the Tax Return Type for this tax year.");
  const v = {
    returnType: returnType as ReturnTypeCode,
    otherReturnForm: returnType === "OTHER" ? clean(input.otherReturnForm, 40) : null,
    primaryFirstName: clean(input.primaryFirstName),
    primaryMiddleName: clean(input.primaryMiddleName),
    primaryLastName: clean(input.primaryLastName),
    spouseFirstName: SPOUSE_RETURN_TYPES.includes(returnType) ? clean(input.spouseFirstName) : null,
    spouseMiddleName: SPOUSE_RETURN_TYPES.includes(returnType) ? clean(input.spouseMiddleName) : null,
    spouseLastName: SPOUSE_RETURN_TYPES.includes(returnType) ? clean(input.spouseLastName) : null,
    spouseEmail: SPOUSE_RETURN_TYPES.includes(returnType) ? clean(input.spouseEmail, 200) : null,
    spousePhone: SPOUSE_RETURN_TYPES.includes(returnType) ? clean(input.spousePhone, 40) : null,
  };
  if (returnType === "OTHER" && !v.otherReturnForm) throw new ValidationError("Enter the return form (e.g. 1040-NR, 706).");
  if (isJointReturn(returnType) && (!v.spouseFirstName || !v.spouseLastName)) {
    throw new ValidationError("Married Filing Jointly needs the spouse's first and last name.");
  }
  if (v.spousePhone && !normalizePhone(v.spousePhone)) throw new ValidationError("The spouse's phone number doesn't look right.");
  if (v.spouseEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.spouseEmail)) throw new ValidationError("The spouse's email doesn't look right.");

  return prisma.$transaction(async (tx) => {
    const before = await tx.taxPrepCase.findUnique({ where: { clientId_taxYear: { clientId, taxYear } } });
    const changed = CASE_FIELDS.filter((f) => (before?.[f] ?? null) !== v[f]);
    const now = new Date();
    const row = await tx.taxPrepCase.upsert({
      where: { clientId_taxYear: { clientId, taxYear } },
      create: { clientId, taxYear, ...v, returnTypeSource: "STAFF", returnTypeConfirmedAt: now, returnTypeConfirmedById: actor.id, createdById: actor.id },
      update: {
        ...v,
        ...(before?.returnType !== v.returnType ? { returnTypeSource: "STAFF" } : {}),
        returnTypeConfirmedAt: now,
        returnTypeConfirmedById: actor.id,
      },
    });
    const renamed = await syncHouseholdName(tx, clientId);
    await audit(tx, {
      actorId: actor.id,
      action: before ? "tax_prep.updated" : "tax_prep.created",
      entityType: "TaxPrepCase",
      entityId: row.id,
      clientId,
      details: { taxYear, returnType: v.returnType, from: before?.returnType ?? null, fields: changed, clientNameUpdated: !!renamed },
    });
    await filingsFromCase(tx, actor.id, row);
    return row;
  });
}

/** Staff confirms a return type that was prefilled from TaxAct. */
export async function confirmReturnType(actor: Actor, caseId: string) {
  const c = await prisma.taxPrepCase.findUnique({ where: { id: caseId } });
  if (!c) throw new ValidationError("Case not found.");
  await assertCanEdit(actor, c.clientId);
  if (!c.returnType) throw new ValidationError("Select the Tax Return Type first.");
  if (isJointReturn(c.returnType) && (!c.spouseFirstName || !c.spouseLastName)) {
    throw new ValidationError("Add the spouse's name before confirming Married Filing Jointly.");
  }
  await prisma.$transaction(async (tx) => {
    const row = await tx.taxPrepCase.update({ where: { id: caseId }, data: { returnTypeConfirmedAt: new Date(), returnTypeConfirmedById: actor.id } });
    await audit(tx, { actorId: actor.id, action: "tax_prep.confirmed", entityType: "TaxPrepCase", entityId: caseId, clientId: c.clientId, details: { taxYear: c.taxYear, returnType: c.returnType } });
    await filingsFromCase(tx, actor.id, row);
  });
}

/**
 * Enter once: a confirmed case creates the year's filing records that don't
 * exist yet — the Federal return with the case's form and, when the client's
 * address state has a known form (AL 40), the state return. A filing that
 * already exists for the year + jurisdiction + original is left exactly as it
 * is (form and status untouched). No state on file → no state filing. Audited.
 */
export async function filingsFromCase(tx: Prisma.TransactionClient, actorId: string, c: TaxPrepCase) {
  if (!c.returnTypeConfirmedAt) return [];
  const client = await tx.client.findUniqueOrThrow({ where: { id: c.clientId }, select: { state: true } });
  const st = normalizeJurisdiction(client.state ?? "");
  const state = st && st !== "FEDERAL" ? st : null;
  const forms = formsForPrepCase(c.returnType, state);
  if (!forms.federal) return [];
  const wanted = [{ jurisdiction: "FEDERAL", returnType: forms.federal }, ...(state && forms.state ? [{ jurisdiction: state, returnType: forms.state }] : [])];
  const created: { id: string; jurisdiction: string; returnType: string }[] = [];
  for (const w of wanted) {
    if (await tx.filingRecord.findFirst({ where: { clientId: c.clientId, taxYear: c.taxYear, jurisdiction: w.jurisdiction, filingType: "ORIGINAL" }, select: { id: true } })) continue;
    const f = await tx.filingRecord.create({ data: { clientId: c.clientId, taxYear: c.taxYear, returnType: w.returnType, jurisdiction: w.jurisdiction, filingType: "ORIGINAL", method: "ELECTRONIC" } });
    await audit(tx, { actorId, action: "filing.created", entityType: "FilingRecord", entityId: f.id, clientId: c.clientId, details: { taxYear: c.taxYear, returnType: w.returnType, jurisdiction: w.jurisdiction, filingType: "ORIGINAL", fromTaxPrepCase: c.id } });
    created.push({ id: f.id, jurisdiction: w.jurisdiction, returnType: w.returnType });
  }
  if (created.length) await audit(tx, { actorId, action: "tax_prep.filings_created", entityType: "TaxPrepCase", entityId: c.id, clientId: c.clientId, details: { taxYear: c.taxYear, returnType: c.returnType, filings: created } });
  return created;
}

export type PrepDefaults = { taxYear: number; returnType: string; federalForm: string | null; stateForm: string | null; filingStatus: string | null; taxpayerName: string; spouseName: string };

/**
 * What a confirmed case fills in elsewhere (Finish & Send, the summary form):
 * forms, filing status and the taxpayer and spouse names (from the case, else
 * the client record). Confirmed cases only, newest year first.
 */
export async function prepDefaults(clientId: string): Promise<PrepDefaults[]> {
  const [client, cases] = await Promise.all([
    prisma.client.findUniqueOrThrow({ where: { id: clientId }, select: { state: true, firstName: true, middleName: true, lastName: true, displayName: true, spouseFirstName: true, spouseMiddleName: true, spouseLastName: true } }),
    prisma.taxPrepCase.findMany({ where: { clientId, returnTypeConfirmedAt: { not: null }, returnType: { not: null } }, orderBy: { taxYear: "desc" } }),
  ]);
  const st = normalizeJurisdiction(client.state ?? "");
  const clientName = joinName({ first: client.firstName, middle: client.middleName, last: client.lastName }) || client.displayName;
  const clientSpouse = joinName({ first: client.spouseFirstName, middle: client.spouseMiddleName, last: client.spouseLastName });
  return cases.map((c) => {
    const forms = formsForPrepCase(c.returnType, st && st !== "FEDERAL" ? st : null);
    const primary = joinName({ first: c.primaryFirstName, middle: c.primaryMiddleName, last: c.primaryLastName });
    const spouse = joinName({ first: c.spouseFirstName, middle: c.spouseMiddleName, last: c.spouseLastName });
    return { taxYear: c.taxYear, returnType: c.returnType!, federalForm: forms.federal, stateForm: forms.state, filingStatus: forms.filingStatus, taxpayerName: primary || clientName, spouseName: SPOUSE_RETURN_TYPES.includes(c.returnType as ReturnTypeCode) ? spouse || clientSpouse : "" };
  });
}

/** Status shown on the case: what staff still need to do. */
export function caseState(c: Pick<TaxPrepCase, "returnType" | "returnTypeConfirmedAt" | "returnTypeSource" | "spouseFirstName" | "spouseLastName">) {
  if (!c.returnType) return { key: "REQUIRED", label: "Return type required", tone: "red" as const };
  if (isJointReturn(c.returnType) && (!c.spouseFirstName || !c.spouseLastName)) return { key: "SPOUSE", label: "Spouse details needed", tone: "amber" as const };
  if (!c.returnTypeConfirmedAt) return { key: "CONFIRM", label: "Prefilled from TaxAct — confirm", tone: "gold" as const };
  return { key: "OK", label: "Confirmed", tone: "green" as const };
}

export type ImportCaseInput = {
  taxYear: number;
  returnType: ReturnTypeCode | null;
  otherReturnForm: string | null;
  primary: PersonName | null;
  spouse: PersonName | null;
  spouseEmail?: string | null;
  spousePhone?: string | null;
};

/**
 * Called by the client import. Opens (or fills in) the client's case for the
 * batch's tax year. Only blank case fields are filled, a confirmed return type
 * is never replaced, and an imported return type stays unconfirmed until staff
 * confirm it.
 */
export async function caseFromImport(tx: Prisma.TransactionClient, actorId: string, clientId: string, input: ImportCaseInput, batchId: string) {
  checkYear(input.taxYear);
  const incoming: Partial<Record<(typeof CASE_FIELDS)[number], string | null>> = {
    returnType: input.returnType,
    otherReturnForm: input.returnType === "OTHER" ? input.otherReturnForm : null,
    primaryFirstName: input.primary?.first ?? null,
    primaryMiddleName: input.primary?.middle ?? null,
    primaryLastName: input.primary?.last ?? null,
    spouseFirstName: input.spouse?.first ?? null,
    spouseMiddleName: input.spouse?.middle ?? null,
    spouseLastName: input.spouse?.last ?? null,
    // The spouse's own contact details stay on the joint tax case — they are
    // not copied onto the client record, so the primary's email/phone (and
    // their messaging permissions) are never mixed up with the spouse's.
    spouseEmail: input.spouse ? input.spouseEmail ?? null : null,
    spousePhone: input.spouse ? input.spousePhone ?? null : null,
  };
  const before = await tx.taxPrepCase.findUnique({ where: { clientId_taxYear: { clientId, taxYear: input.taxYear } } });
  const data: Record<string, unknown> = {};
  for (const [k, val] of Object.entries(incoming)) {
    if (!val) continue;
    const cur = before?.[k as keyof TaxPrepCase];
    if (cur !== null && cur !== undefined && cur !== "") continue;
    data[k] = val;
  }
  if (data.returnType) data.returnTypeSource = "TAXACT_IMPORT";
  if (before && Object.keys(data).length === 0) return { case: before, filled: [] as string[], created: false };
  const row = before
    ? await tx.taxPrepCase.update({ where: { id: before.id }, data })
    : await tx.taxPrepCase.create({ data: { clientId, taxYear: input.taxYear, createdById: actorId, ...data } });
  const filled = Object.keys(data).filter((k) => k !== "returnTypeSource");
  await syncHouseholdName(tx, clientId);
  await audit(tx, {
    actorId,
    action: before ? "tax_prep.filled_by_import" : "tax_prep.created_by_import",
    entityType: "TaxPrepCase",
    entityId: row.id,
    clientId,
    details: { batchId, taxYear: input.taxYear, fields: filled, returnType: row.returnType },
  });
  return { case: row, filled, created: !before };
}
