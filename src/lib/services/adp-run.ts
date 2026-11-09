import "server-only";
import { createHash } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { audit } from "@/lib/audit";
import { decryptSecret, encryptSecret } from "@/lib/crypto";
import { ForbiddenError, type Actor } from "@/lib/auth/actor";
import { assertPayrollTaxManage, assertPayrollTaxView, type PayrollTaxAccess } from "@/lib/payroll-taxes/access";
import { officeAccessFor } from "@/lib/auth/permissions";
import type { HoursSubmission } from "@/lib/payroll/queue";
import {
  ADP_FREQUENCY, ADP_FREQUENCY_LABEL, EARNING_KINDS, EARNING_KIND_ORDER, RATE_CODES, adpFileName, branchCompanyCode, buildAdpCsv, checkTemplate, isCompanyCode, nameKey, normalizeCompanyCode, parseEarningsReport,
  parseEmployeeReport, verifyAdpCsv, type EarningKind, type IdentifierType, type ReportEarning,
} from "@/lib/payroll/adp-run-csv";
import { ValidationError } from "./clients";

/**
 * ADP RUN Time Sheet Import: one-time setup per payroll client, then "Download ADP CSV" on each pay
 * cycle. Client Connect never connects to ADP: staff download the file and import it in RUN
 * (Home > Time Sheet Import), review RUN's Pay Data Approval page and submit payroll there.
 *
 * Safety:
 * - Every read is limited to clients the staff member may see in ADP Payroll & Taxes; every change
 *   needs Manage. A file is only ever built from one client's setup, mappings and pay cycle.
 * - Company codes and Accountant Connect identifiers are stored encrypted.
 * - Until a test file (fictional hours) has been imported in RUN without errors and deleted there
 *   unapproved, only test files can be downloaded — live payroll stays as it is today.
 * - One ACTIVE file per pay cycle: the same figures download the same file again; changed figures
 *   need the earlier file replaced, with a reason once it was imported into RUN.
 */

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const hint = (s: string) => `…${s.slice(-3)}`;
const ymd = (d: Date) => d.toISOString().slice(0, 10);
const MAX_REPORT_BYTES = 2_000_000;

/**
 * Client-specific scope for ADP setup and files, enforced here independently of the wider
 * workspace: Payroll Manage alone does NOT open every business. Allowed only for the owner, staff
 * the owner explicitly granted "ADP Payroll & Taxes → All clients", or staff assigned to this
 * client (the payroll schedule's or a pay cycle's assigned staff, or the client's assigned staff).
 */
export async function adpAllClients(actor: Pick<Actor, "id">, access: PayrollTaxAccess) {
  if (access.isOwner) return true;
  return (await officeAccessFor(actor.id)).can("payroll_taxes", "all_clients");
}

const assignedClientWhere = (userId: string): Prisma.ClientWhereInput => ({
  OR: [{ assignedToId: userId }, { payrollSchedule: { assignedStaffId: userId } }, { payrollCycles: { some: { assignedStaffId: userId } } }],
});

export async function adpClientAllowed(actor: Pick<Actor, "id">, access: PayrollTaxAccess, clientId: string) {
  if (access.level === "NONE") return false;
  if (await adpAllClients(actor, access)) return true;
  return (await prisma.client.count({ where: { id: clientId, ...assignedClientWhere(actor.id) } })) > 0;
}

async function scopeClient(actor: Actor, clientId: string, manage: boolean) {
  const access = manage ? await assertPayrollTaxManage(actor) : await assertPayrollTaxView(actor);
  if (!(await adpClientAllowed(actor, access, clientId))) throw new ForbiddenError("Not found.");
  const client = await prisma.client.findUnique({ where: { id: clientId }, select: { id: true, businessName: true, displayName: true, payrollSchedule: { select: { frequency: true, active: true } } } });
  if (!client) throw new ForbiddenError("Not found.");
  return { access, client, name: client.businessName || client.displayName };
}

async function setupOf(clientId: string) {
  return (await prisma.adpRunSetup.findUnique({ where: { clientId } })) ?? prisma.adpRunSetup.create({ data: { clientId } }).catch(() => prisma.adpRunSetup.findUniqueOrThrow({ where: { clientId } }));
}

export function companyCodeOf(setup: { companyCodeEnc: string | null }) {
  return setup.companyCodeEnc ? decryptSecret(setup.companyCodeEnc) : null;
}

type SetupRow = Prisma.AdpRunSetupGetPayload<{ include: { employees: true } }>;
export type EarningsMap = Partial<Record<EarningKind, string>>;
export const earningsMapOf = (s: { earningsMap: Prisma.JsonValue }): EarningsMap => ((s.earningsMap && typeof s.earningsMap === "object" && !Array.isArray(s.earningsMap) ? s.earningsMap : {}) as EarningsMap);

/** The setup checklist shown in the Payroll Work Center (each step says how to do it in RUN). */
export function setupChecklist(s: SetupRow, scheduleFrequency: string | null) {
  const letter = scheduleFrequency ? ADP_FREQUENCY[scheduleFrequency] : null;
  const active = s.employees.filter((e) => e.active);
  return [
    { key: "identifiers", label: "ADP company identifiers entered", done: !!s.companyCodeEnc, how: "From ADP Accountant Connect: Client ID, Branch and Code. The CSV's Company Code is the IID or Branch + Code — the company's own template shows which." },
    { key: "feature", label: "Time Sheet Import turned on in RUN", done: !!s.featureConfirmedAt, how: "In the client's RUN: Company > Features Overview → Time Sheet Import selected. If it isn't offered, the client's ADP Payroll Service team turns it on." },
    { key: "frequency", label: "Pay frequency matches", done: !!letter && s.payFrequency === letter, how: `This client's pay schedule is ${letter ? ADP_FREQUENCY_LABEL[letter] : "not set"}; RUN must use the same pay frequency. One file covers one frequency.` },
    { key: "template", label: "Company's Time Sheet Import template checked", done: !!s.templateCheckedAt, how: "In RUN: Help & Support > Payroll & HR > Time Sheet Import → open the Employee ID template, save it as .csv and upload it here." },
    { key: "employees", label: "Employees matched to RUN employee IDs", done: active.length > 0, how: "In RUN: Reports → Employee Codes Report → Export to Excel, save as .csv and upload. Then check each name matches how hours are entered." },
    { key: "earnings", label: "Earnings codes chosen", done: !!earningsMapOf(s).REGULAR, how: "In RUN: Reports → Earnings Codes Report → Export to Excel, save as .csv and upload. Then choose this company's code for each kind of pay it uses: regular and overtime hours, vacation, sick, holiday, bonus, commission, tips. Leave a kind blank if the company doesn't use it — it will then be reported as “can't transfer” if it's ever entered." },
    { key: "departments", label: "Departments (only if the company uses them)", done: !s.usesDepartments || active.every((e) => !!e.departmentCode), how: "In RUN: Reports → Department Numbers Report. Enter each employee's department number below." },
    { key: "test", label: "Test import verified in RUN", done: !!s.testVerifiedAt, how: "Download the test file (fictional hours), import it in RUN (Home > Time Sheet Import), confirm there are no errors on Pay Data Approval, then click “Delete this Pay Data File” — never Approve — and record it here." },
  ];
}

export async function adpSetupPage(actor: Actor, clientId: string) {
  const { access, client, name } = await scopeClient(actor, clientId, false);
  const base = await setupOf(clientId);
  const setup = await prisma.adpRunSetup.findUniqueOrThrow({ where: { id: base.id }, include: { employees: { orderBy: { name: "asc" } } } });
  const exports = await prisma.adpRunExport.findMany({ where: { clientId }, orderBy: { createdAt: "desc" }, take: 20, select: { id: true, fileName: true, isTest: true, status: true, rows: true, employees: true, hoursHundredths: true, periodStart: true, periodEnd: true, importedAt: true, createdAt: true, cycleId: true, downloads: true } });
  const checklist = setupChecklist(setup, client.payrollSchedule?.frequency ?? null);
  return {
    canManage: access.level === "MANAGE",
    client: { id: client.id, name, frequency: client.payrollSchedule?.frequency ?? null },
    setup: { ...setup, companyCodeEnc: undefined, acClientIdEnc: undefined, acBranchEnc: undefined, acCodeEnc: undefined, earningsCatalog: (setup.earningsCatalog as ReportEarning[]) ?? [], earningsMap: earningsMapOf(setup) },
    checklist,
    ready: checklist.every((c) => c.done),
    setupComplete: checklist.filter((c) => c.key !== "test").every((c) => c.done),
    exports,
  };
}

// --- Identifiers ----------------------------------------------------------------------------------

export type IdentifierInput = { acClientId: string; branch: string; code: string; form: "IID" | "BRANCH_CODE" };

export function companyCodeFrom(input: IdentifierInput) {
  const acClientId = input.acClientId.replace(/\s+/g, "");
  const branch = normalizeCompanyCode(input.branch);
  const code = normalizeCompanyCode(input.code);
  if (acClientId && !/^\d{4,10}$/.test(acClientId)) throw new ValidationError("The ADP Client ID is digits only.");
  if (branch && !/^[A-Z0-9]{1,4}$/.test(branch)) throw new ValidationError("The Branch is 1–4 letters or digits.");
  if (code && !/^[A-Z0-9]{1,6}$/.test(code)) throw new ValidationError("The Code is 1–6 letters or digits.");
  const companyCode = input.form === "IID" ? acClientId : branch && code ? branchCompanyCode(branch, code) : "";
  if (!companyCode || !isCompanyCode(companyCode)) throw new ValidationError(input.form === "IID" ? "Enter the ADP Client ID (IID)." : "Enter both the Branch and the Code.");
  return { acClientId, branch, code, companyCode };
}

export async function saveAdpIdentifiers(actor: Actor, clientId: string, input: IdentifierInput) {
  const { client } = await scopeClient(actor, clientId, true);
  const v = companyCodeFrom(input);
  const setup = await setupOf(clientId);
  // The same ADP company can't be set up on two businesses.
  const others = await prisma.adpRunSetup.findMany({ where: { clientId: { not: clientId }, companyCodeEnc: { not: null } }, select: { clientId: true, companyCodeEnc: true } });
  if (others.some((o) => companyCodeOf(o) === v.companyCode)) throw new ValidationError("That ADP company code is already set up for a different business. Check the Client ID, Branch and Code.");
  const letter = client.payrollSchedule ? ADP_FREQUENCY[client.payrollSchedule.frequency] ?? null : null;
  const changed = companyCodeOf(setup) !== v.companyCode;
  await prisma.adpRunSetup.update({
    where: { id: setup.id },
    data: {
      companyCodeEnc: encryptSecret(v.companyCode), companyCodeHint: hint(v.companyCode), companyCodeForm: input.form,
      acClientIdEnc: v.acClientId ? encryptSecret(v.acClientId) : null, acClientIdHint: v.acClientId ? hint(v.acClientId) : null,
      acBranchEnc: v.branch ? encryptSecret(v.branch) : null, acCodeEnc: v.code ? encryptSecret(v.code) : null,
      payFrequency: setup.payFrequency ?? letter,
      // A different company invalidates the checks made against the old one.
      ...(changed && setup.companyCodeEnc ? { templateCheckedAt: null, testVerifiedAt: null, testVerifiedById: null } : {}),
      updatedById: actor.id,
    },
  });
  await audit(prisma, { actorId: actor.id, action: "adp_run.identifiers_saved", entityType: "AdpRunSetup", entityId: setup.id, clientId, details: { form: input.form, companyCodeHint: hint(v.companyCode), changed } });
}

export async function confirmTimeSheetFeature(actor: Actor, clientId: string, on: boolean) {
  await scopeClient(actor, clientId, true);
  const setup = await setupOf(clientId);
  await prisma.adpRunSetup.update({ where: { id: setup.id }, data: on ? { featureConfirmedAt: new Date(), featureConfirmedById: actor.id } : { featureConfirmedAt: null, featureConfirmedById: null } });
  await audit(prisma, { actorId: actor.id, action: on ? "adp_run.feature_confirmed" : "adp_run.feature_unconfirmed", entityType: "AdpRunSetup", entityId: setup.id, clientId });
}

export async function setAdpPayFrequency(actor: Actor, clientId: string, letter: string) {
  await scopeClient(actor, clientId, true);
  if (!ADP_FREQUENCY_LABEL[letter]) throw new ValidationError("Choose the pay frequency used in RUN.");
  const setup = await setupOf(clientId);
  await prisma.adpRunSetup.update({ where: { id: setup.id }, data: { payFrequency: letter, updatedById: actor.id } });
  await audit(prisma, { actorId: actor.id, action: "adp_run.frequency_set", entityType: "AdpRunSetup", entityId: setup.id, clientId, details: { letter } });
}

// --- Template and reports -------------------------------------------------------------------------

const textOf = (bytes: Uint8Array) => {
  if (bytes.length > MAX_REPORT_BYTES) throw new ValidationError("That file is too large for a template or report (2 MB at most).");
  if (bytes.length > 4 && bytes[0] === 0x50 && bytes[1] === 0x4b) throw new ValidationError("That's an Excel file. In Excel choose File > Save As > CSV (Comma delimited), then upload the .csv.");
  return new TextDecoder("utf-8").decode(bytes);
};

export async function uploadAdpTemplate(actor: Actor, clientId: string, bytes: Uint8Array) {
  await scopeClient(actor, clientId, true);
  const text = textOf(bytes);
  const t = checkTemplate(text);
  if (!t.ok) throw new ValidationError(t.problems.join(" "));
  const setup = await setupOf(clientId);
  const code = companyCodeOf(setup);
  // A filled-in template (or an earlier ADP file) names its company: it must be this one.
  if (t.companyCodes.length && code && t.companyCodes[0] !== normalizeCompanyCode(code)) throw new ValidationError("This template's company code doesn't match this business's ADP company. Make sure it was downloaded from this client's RUN.");
  if (t.identifierType !== "EMPLOYEE_ID") throw new ValidationError("This is the Time Clock ID template. Use the Employee ID template (the IDs RUN assigns), so no extra IDs need to be kept.");
  await prisma.adpRunSetup.update({ where: { id: setup.id }, data: { templateVersion: t.version, templateTitles: t.titles, templateSha256: sha(text), templateCheckedAt: new Date(), identifierType: t.identifierType, updatedById: actor.id } });
  await audit(prisma, { actorId: actor.id, action: "adp_run.template_checked", entityType: "AdpRunSetup", entityId: setup.id, clientId, details: { version: t.version } });
  return t;
}

/** Employee Codes Report → mappings. Existing names (as matched to hours) are kept. */
export async function importEmployeeReport(actor: Actor, clientId: string, bytes: Uint8Array) {
  await scopeClient(actor, clientId, true);
  const { employees, problems } = parseEmployeeReport(textOf(bytes));
  if (!employees.length) throw new ValidationError(problems.join(" "));
  const setup = await setupOf(clientId);
  let added = 0, updated = 0;
  await prisma.$transaction(async (tx) => {
    for (const e of employees) {
      const existing = await tx.adpRunEmployeeMap.findUnique({ where: { clientId_adpEmployeeId: { clientId, adpEmployeeId: e.adpEmployeeId } } });
      const inactive = !!e.status && /term|leave|inactive/i.test(e.status);
      if (existing) {
        await tx.adpRunEmployeeMap.update({ where: { id: existing.id }, data: { payFrequency: e.payFrequency, active: !inactive, updatedById: actor.id } });
        updated++;
        continue;
      }
      let key = nameKey(e.name || e.adpEmployeeId);
      if (await tx.adpRunEmployeeMap.findUnique({ where: { clientId_nameKey: { clientId, nameKey: key } } })) key = `${key} ${e.adpEmployeeId}`;
      await tx.adpRunEmployeeMap.create({ data: { setupId: setup.id, clientId, name: e.name || `Employee ${e.adpEmployeeId}`, nameKey: key, adpEmployeeId: e.adpEmployeeId, payFrequency: e.payFrequency, active: !inactive, source: "REPORT", updatedById: actor.id } });
      added++;
    }
    await tx.adpRunSetup.update({ where: { id: setup.id }, data: { employeeReportAt: new Date(), updatedById: actor.id } });
  });
  await audit(prisma, { actorId: actor.id, action: "adp_run.employee_report_imported", entityType: "AdpRunSetup", entityId: setup.id, clientId, details: { added, updated, skipped: problems.length } });
  return { added, updated, problems };
}

export async function importEarningsReport(actor: Actor, clientId: string, bytes: Uint8Array) {
  await scopeClient(actor, clientId, true);
  const { earnings, problems } = parseEarningsReport(textOf(bytes));
  if (!earnings.length) throw new ValidationError(problems.join(" "));
  const setup = await setupOf(clientId);
  const codes = new Set(earnings.map((e) => e.code));
  await prisma.adpRunSetup.update({
    where: { id: setup.id },
    data: {
      earningsCatalog: earnings as unknown as Prisma.InputJsonValue, earningsReportAt: new Date(),
      // Suggest the usual codes only when the company actually has them; never overwrite a choice.
      earningsMap: { ...(codes.has("REG") ? { REGULAR: "REG" } : {}), ...(codes.has("OT") ? { OVERTIME: "OT" } : {}), ...earningsMapOf(setup) } as Prisma.InputJsonValue,
      updatedById: actor.id,
    },
  });
  await audit(prisma, { actorId: actor.id, action: "adp_run.earnings_report_imported", entityType: "AdpRunSetup", entityId: setup.id, clientId, details: { codes: earnings.length } });
  return earnings.length;
}

export async function setEarningsCodes(actor: Actor, clientId: string, input: { codes: Partial<Record<EarningKind, string>>; usesDepartments: boolean }) {
  await scopeClient(actor, clientId, true);
  const setup = await setupOf(clientId);
  const catalog = new Set(((setup.earningsCatalog as ReportEarning[]) ?? []).map((e) => e.code));
  const map: EarningsMap = {};
  for (const kind of EARNING_KIND_ORDER) {
    const code = (input.codes[kind] ?? "").trim().toUpperCase();
    if (!code) continue;
    if (!/^[A-Z0-9_\-]{1,10}$/.test(code)) throw new ValidationError(`${code} isn't a valid earnings code.`);
    if (catalog.size && !catalog.has(code)) throw new ValidationError(`${code} isn't in this company's Earnings Codes Report.`);
    map[kind] = code;
  }
  if (!map.REGULAR) throw new ValidationError("Choose the earnings code for regular hours.");
  await prisma.adpRunSetup.update({ where: { id: setup.id }, data: { earningsMap: map as Prisma.InputJsonValue, usesDepartments: input.usesDepartments, departmentReportAt: input.usesDepartments ? setup.departmentReportAt ?? new Date() : null, updatedById: actor.id } });
  await audit(prisma, { actorId: actor.id, action: "adp_run.earnings_codes_set", entityType: "AdpRunSetup", entityId: setup.id, clientId, details: { map, usesDepartments: input.usesDepartments } });
}

/** Kinds of pay this company can't send yet (no ADP earnings code chosen). */
export function unmappedKinds(map: EarningsMap) {
  return EARNING_KIND_ORDER.filter((k) => !map[k]).map((k) => EARNING_KINDS[k].label);
}

export type EmployeeEdit = { name: string; adpEmployeeId: string; departmentCode: string; rateCode: string; active: boolean };

export async function saveEmployeeMap(actor: Actor, clientId: string, id: string | null, input: EmployeeEdit) {
  await scopeClient(actor, clientId, true);
  const setup = await setupOf(clientId);
  const name = input.name.trim().slice(0, 120);
  const adpEmployeeId = input.adpEmployeeId.trim();
  if (!name) throw new ValidationError("Enter the name exactly as it's written in the hours.");
  if (!/^[A-Za-z0-9]{1,15}$/.test(adpEmployeeId)) throw new ValidationError("Enter the RUN employee ID (letters and digits, up to 15).");
  if (input.departmentCode && !/^\d{1,6}$/.test(input.departmentCode.trim())) throw new ValidationError("A department number is digits only.");
  if (!(RATE_CODES as readonly string[]).includes(input.rateCode)) throw new ValidationError("Choose a rate code.");
  const data = { name, nameKey: nameKey(name), adpEmployeeId, departmentCode: input.departmentCode.trim() || null, rateCode: input.rateCode, active: input.active, updatedById: actor.id };
  try {
    if (id) {
      // Only this client's mapping can be edited from this client's page.
      const row = await prisma.adpRunEmployeeMap.findFirst({ where: { id, clientId } });
      if (!row) throw new ForbiddenError("Not found.");
      await prisma.adpRunEmployeeMap.update({ where: { id }, data });
    } else {
      await prisma.adpRunEmployeeMap.create({ data: { ...data, setupId: setup.id, clientId, source: "MANUAL" } });
    }
  } catch (e) {
    if ((e as { code?: string }).code === "P2002") throw new ValidationError("Another employee of this business already has that name or RUN employee ID.");
    throw e;
  }
  await audit(prisma, { actorId: actor.id, action: id ? "adp_run.employee_updated" : "adp_run.employee_added", entityType: "AdpRunSetup", entityId: setup.id, clientId, details: { adpEmployeeId, active: input.active } });
}

// --- Building files -------------------------------------------------------------------------------

async function buildFor(clientId: string, period: { start: string; end: string }, hours: HoursSubmission["employees"], scheduleFrequency: string) {
  const setup = await prisma.adpRunSetup.findUnique({ where: { clientId }, include: { employees: true } });
  if (!setup || !setup.companyCodeEnc) return { setup, result: { ok: false as const, problems: ["Finish the ADP setup for this business first (Payroll schedule → ADP RUN import setup)."], cannotTransfer: [] as string[] } };
  const result = buildAdpCsv({
    clientId,
    setupClientId: setup.clientId,
    companyCode: companyCodeOf(setup)!,
    identifierType: setup.identifierType as IdentifierType,
    templateTitles: setup.templateTitles,
    templateVersion: setup.templateVersion ?? "",
    frequency: scheduleFrequency,
    setupFrequency: setup.payFrequency,
    periodStart: period.start,
    periodEnd: period.end,
    hours,
    employees: setup.employees.map((e) => ({ name: e.name, adpEmployeeId: e.adpEmployeeId, active: e.active, departmentCode: e.departmentCode, rateCode: e.rateCode })),
    employeeClientIds: setup.employees.map((e) => e.clientId),
    earnings: earningsMapOf(setup),
  });
  if (result.ok) {
    if (setup.usesDepartments) {
      const used = new Set(result.lines.map((l) => l.adpEmployeeId));
      const missing = setup.employees.filter((e) => used.has(e.adpEmployeeId) && !e.departmentCode);
      if (missing.length) return { setup, result: { ok: false as const, problems: missing.map((e) => `“${e.name}” needs a department number (this company uses departments).`), cannotTransfer: [] as string[] } };
    }
    const again = verifyAdpCsv(result.csv, { companyCode: companyCodeOf(setup)!, frequency: ADP_FREQUENCY[scheduleFrequency], periodStart: period.start, periodEnd: period.end, employeeIds: setup.employees.filter((e) => e.active).map((e) => e.adpEmployeeId) });
    if (again.length) return { setup, result: { ok: false as const, problems: again, cannotTransfer: [] as string[] } };
  }
  return { setup, result };
}

/** A test file with fictional hours (1.00 regular hour for each active employee). */
export async function createTestFile(actor: Actor, clientId: string) {
  const { client, name } = await scopeClient(actor, clientId, true);
  if (!client.payrollSchedule) throw new ValidationError("Set up this client's payroll schedule first.");
  const cycle = await prisma.payrollCycle.findFirst({ where: { clientId, processedAt: null }, orderBy: { payDate: "asc" } });
  if (!cycle) throw new ValidationError("There's no open pay cycle to test with. Save the payroll schedule to create cycles.");
  const setup = await prisma.adpRunSetup.findUnique({ where: { clientId }, include: { employees: { where: { active: true } } } });
  const fictional = (setup?.employees ?? []).map((e) => ({ name: e.name, regularHours: 1, overtimeHours: 0, notes: "" }));
  if (!fictional.length) throw new ValidationError("Match at least one employee first.");
  const period = { start: ymd(cycle.periodStart), end: ymd(cycle.periodEnd) };
  const { setup: s, result } = await buildFor(clientId, period, fictional, client.payrollSchedule.frequency);
  if (!result.ok) throw new ValidationError(result.problems.join(" "));
  const letter = ADP_FREQUENCY[client.payrollSchedule.frequency];
  const exp = await prisma.adpRunExport.create({
    data: { setupId: s!.id, clientId, cycleId: null, isTest: true, fileName: adpFileName(name, letter, period.start, period.end, true), contentEnc: encryptSecret(result.csv), contentSha256: sha(result.csv), rows: result.rows, employees: result.employees, hoursHundredths: result.hoursHundredths, dollarsCents: result.dollarsCents, payFrequency: letter, periodStart: cycle.periodStart, periodEnd: cycle.periodEnd, createdById: actor.id },
  });
  await audit(prisma, { actorId: actor.id, action: "adp_run.test_file_created", entityType: "AdpRunExport", entityId: exp.id, clientId, details: { rows: result.rows } });
  return exp;
}

export async function recordTestVerified(actor: Actor, clientId: string, note: string) {
  await scopeClient(actor, clientId, true);
  const setup = await setupOf(clientId);
  const test = await prisma.adpRunExport.findFirst({ where: { clientId, isTest: true, downloads: { gt: 0 } } });
  if (!test) throw new ValidationError("Download the test file and import it in RUN first.");
  if (!note.trim()) throw new ValidationError("Note what RUN showed (for example: “No errors on Pay Data Approval; file deleted, not approved”).");
  await prisma.adpRunSetup.update({ where: { id: setup.id }, data: { testVerifiedAt: new Date(), testVerifiedById: actor.id, testVerifiedNote: note.trim().slice(0, 500) } });
  await audit(prisma, { actorId: actor.id, action: "adp_run.test_verified", entityType: "AdpRunSetup", entityId: setup.id, clientId, details: { testExportId: test.id } });
}

/** What the cycle page shows: whether a file can be built, and any active file. */
export async function cycleAdpStatus(actor: Actor, cycleId: string) {
  const access = await assertPayrollTaxView(actor);
  const cycle = await prisma.payrollCycle.findFirst({ where: { id: cycleId }, include: { schedule: true } });
  if (!cycle) throw new ForbiddenError("Not found.");
  if (!(await adpClientAllowed(actor, access, cycle.clientId))) return { allowed: false as const, clientId: cycle.clientId };
  const setup = await prisma.adpRunSetup.findUnique({ where: { clientId: cycle.clientId }, include: { employees: true } });
  const active = await prisma.adpRunExport.findFirst({ where: { clientId: cycle.clientId, cycleId, status: "ACTIVE", isTest: false }, orderBy: { createdAt: "desc" } });
  const checklist = setup ? setupChecklist(setup, cycle.schedule.frequency) : null;
  const hours = cycle.hoursSubmission as HoursSubmission | null;
  const setupReady = !!checklist && checklist.every((c) => c.done);
  // The transfer check: what would go into the file now, and anything that can't transfer.
  let check: { ok: boolean; problems: string[]; cannotTransfer: string[]; lines: { name: string; label: string; code: string; amount: string }[] } | null = null;
  if (setupReady && cycle.hoursSubmittedAt && hours && !hours.noChanges && !cycle.processedAt) {
    const { result } = await buildFor(cycle.clientId, { start: ymd(cycle.periodStart), end: ymd(cycle.periodEnd) }, hours.employees, cycle.schedule.frequency);
    check = result.ok
      ? { ok: true, problems: [], cannotTransfer: [], lines: result.lines.map((l) => ({ name: l.name, label: EARNING_KINDS[l.kind].label, code: l.code, amount: l.hours ? `${l.hours} hrs` : `$${l.dollars}` })) }
      : { ok: false, problems: result.problems.filter((p) => !p.startsWith("Can't transfer")), cannotTransfer: result.cannotTransfer, lines: [] };
  }
  return { allowed: true as const, clientId: cycle.clientId, setupReady, missing: checklist ? checklist.filter((c) => !c.done).map((c) => c.label) : ["ADP setup not started"], hoursIn: !!cycle.hoursSubmittedAt, noChanges: !!hours?.noChanges, active, processed: !!cycle.processedAt, check, unmapped: setup ? unmappedKinds(earningsMapOf(setup)) : [] };
}

/** "Download ADP CSV": builds (or reuses) this pay cycle's file. */
export async function generateCycleFile(actor: Actor, cycleId: string, replaceReason = "") {
  const access = await assertPayrollTaxManage(actor);
  const cycle = await prisma.payrollCycle.findFirst({ where: { id: cycleId }, include: { schedule: true, client: { select: { businessName: true, displayName: true } } } });
  if (!cycle || !(await adpClientAllowed(actor, access, cycle.clientId))) throw new ForbiddenError("Not found.");
  if (cycle.processedAt) throw new ValidationError("This payroll is already processed.");
  const setup = await prisma.adpRunSetup.findUnique({ where: { clientId: cycle.clientId }, include: { employees: true } });
  if (!setup || !setupChecklist(setup, cycle.schedule.frequency).every((c) => c.done)) throw new ValidationError("Finish the ADP setup checklist for this business, including the test import, before downloading live payroll files.");
  const hours = cycle.hoursSubmission as HoursSubmission | null;
  if (!cycle.hoursSubmittedAt || !hours) throw new ValidationError("Enter or receive this period's hours first.");
  if (hours.noChanges) throw new ValidationError("The hours say “No changes — same as last period”, so RUN's standard hours apply and no file is needed.");
  const period = { start: ymd(cycle.periodStart), end: ymd(cycle.periodEnd) };
  const { result } = await buildFor(cycle.clientId, period, hours.employees, cycle.schedule.frequency);
  if (!result.ok) throw new ValidationError(result.problems.join(" "));
  const digest = sha(result.csv);
  const active = await prisma.adpRunExport.findFirst({ where: { clientId: cycle.clientId, cycleId, status: "ACTIVE", isTest: false } });
  if (active && active.contentSha256 === digest) return { export: active, reused: true };
  if (active?.importedAt && !replaceReason.trim()) throw new ValidationError("The hours changed after the earlier file was imported into RUN. In RUN, delete that pay data file first (Pay Data Approval → “Delete this Pay Data File”), then give a reason here to make the corrected file.");
  const letter = ADP_FREQUENCY[cycle.schedule.frequency];
  const name = cycle.client.businessName || cycle.client.displayName;
  const exp = await prisma.$transaction(async (tx) => {
    if (active) await tx.adpRunExport.update({ where: { id: active.id }, data: { status: "REPLACED", replacedAt: new Date(), replacedById: actor.id, replaceReason: replaceReason.trim().slice(0, 300) || "Hours changed before import" } });
    return tx.adpRunExport.create({ data: { setupId: setup.id, clientId: cycle.clientId, cycleId, fileName: adpFileName(name, letter, period.start, period.end), contentEnc: encryptSecret(result.csv), contentSha256: digest, rows: result.rows, employees: result.employees, hoursHundredths: result.hoursHundredths, dollarsCents: result.dollarsCents, payFrequency: letter, periodStart: cycle.periodStart, periodEnd: cycle.periodEnd, createdById: actor.id } });
  });
  await audit(prisma, { actorId: actor.id, action: "adp_run.file_created", entityType: "AdpRunExport", entityId: exp.id, clientId: cycle.clientId, details: { cycleId, rows: result.rows, replaced: active?.id ?? null } });
  return { export: exp, reused: false };
}

export async function markFileImported(actor: Actor, exportId: string) {
  const access = await assertPayrollTaxManage(actor);
  const exp = await prisma.adpRunExport.findUnique({ where: { id: exportId } });
  if (!exp || !(await adpClientAllowed(actor, access, exp.clientId))) throw new ForbiddenError("Not found.");
  if (exp.isTest) throw new ValidationError("A test file is never imported for payroll. Record the test on the setup page.");
  if (exp.status !== "ACTIVE") throw new ValidationError("This file was replaced. Use the current file.");
  if (!exp.downloads) throw new ValidationError("Download the file first.");
  if (exp.importedAt) return;
  await prisma.adpRunExport.update({ where: { id: exp.id }, data: { importedAt: new Date(), importedById: actor.id } });
  await audit(prisma, { actorId: actor.id, action: "adp_run.file_imported", entityType: "AdpRunExport", entityId: exp.id, clientId: exp.clientId });
}

/** The file bytes for the download route (Manage only; every download is audited). */
export async function readAdpFile(actor: Actor, exportId: string) {
  const access = await assertPayrollTaxManage(actor);
  const exp = await prisma.adpRunExport.findUnique({ where: { id: exportId } });
  if (!exp || !(await adpClientAllowed(actor, access, exp.clientId))) throw new ForbiddenError("Not found.");
  if (exp.status !== "ACTIVE") throw new ValidationError("This file was replaced by a newer one.");
  const csv = decryptSecret(exp.contentEnc);
  if (sha(csv) !== exp.contentSha256) throw new Error("ADP file integrity check failed");
  await prisma.adpRunExport.update({ where: { id: exp.id }, data: { downloads: { increment: 1 }, lastDownloadedAt: new Date() } });
  await audit(prisma, { actorId: actor.id, action: "adp_run.file_downloaded", entityType: "AdpRunExport", entityId: exp.id, clientId: exp.clientId, details: { isTest: exp.isTest, previousDownloads: exp.downloads } });
  return { fileName: exp.fileName, csv };
}

// --- One-time identifier list (ADP Accountant Connect) ----------------------------------------------

export type IdentifierRow = { line: number; business: string; acClientId: string; branch: string; code: string; clientId: string | null; clientName: string | null; problem: string | null };

/**
 * Reads a pasted list "Business, ADP Client ID, Branch, Code" (comma or tab separated) and matches
 * each business by its exact name to a client with a payroll schedule. Nothing is saved here.
 */
export async function previewIdentifierList(actor: Actor, text: string): Promise<IdentifierRow[]> {
  const access = await assertPayrollTaxManage(actor);
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).slice(0, 200);
  const clients = await prisma.client.findMany({ where: { payrollSchedule: { isNot: null } }, select: { id: true, businessName: true, displayName: true } });
  const byName = new Map<string, { id: string; name: string }[]>();
  for (const c of clients) {
    for (const n of [c.businessName, c.displayName].filter(Boolean) as string[]) {
      const k = nameKey(n);
      const list = byName.get(k) ?? [];
      if (!list.some((x) => x.id === c.id)) list.push({ id: c.id, name: c.businessName || c.displayName });
      byName.set(k, list);
    }
  }
  const rows: IdentifierRow[] = [];
  for (const [i, l] of lines.entries()) {
    const cells = (l.includes("\t") ? l.split("\t") : l.split(",")).map((c) => c.trim());
    if (i === 0 && /business/i.test(cells[0] ?? "") && /client/i.test(cells[1] ?? "")) continue; // header
    const [business = "", acClientId = "", branch = "", code = ""] = cells;
    let problem: string | null = null;
    try { companyCodeFrom({ acClientId, branch, code, form: "BRANCH_CODE" }); if (!/^\d{4,10}$/.test(acClientId)) throw new ValidationError("The ADP Client ID is missing or incomplete."); } catch (e) { problem = e instanceof Error ? e.message : "Not valid."; }
    const matches = byName.get(nameKey(business)) ?? [];
    const visible = [];
    for (const m of matches) if (await adpClientAllowed(actor, access, m.id)) visible.push(m);
    if (!problem && visible.length !== 1) problem = visible.length ? "More than one client has this name — set this one up on its own page." : "No client with a payroll schedule has exactly this name — set it up on the client's own page.";
    rows.push({ line: i + 1, business, acClientId, branch, code, clientId: visible.length === 1 ? visible[0].id : null, clientName: visible.length === 1 ? visible[0].name : null, problem });
  }
  return rows;
}

/** Saves the matched rows (only those without a problem). Returns how many were saved. */
export async function applyIdentifierList(actor: Actor, text: string) {
  const rows = await previewIdentifierList(actor, text);
  let saved = 0;
  const failed: string[] = [];
  for (const r of rows.filter((x) => !x.problem && x.clientId)) {
    try {
      await saveAdpIdentifiers(actor, r.clientId!, { acClientId: r.acClientId, branch: r.branch, code: r.code, form: "BRANCH_CODE" });
      saved++;
    } catch (e) {
      failed.push(`${r.business}: ${e instanceof Error ? e.message : "not saved"}`);
    }
  }
  return { saved, skipped: rows.length - saved, failed, rows };
}
