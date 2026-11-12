import "server-only";
import { createHash } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { audit } from "@/lib/audit";
import { ForbiddenError, type Actor } from "@/lib/auth/actor";
import { ValidationError } from "./clients";
import { assertLedger, assertLedgerWrite, bookOf, canUseLedger, parseCsv, postEntryTx, todayCentral, usd, ymdOf } from "./ledger";
import { canManagePayrollTaxes } from "@/lib/payroll-taxes/access";
import { openWorkPeriod, PAYROLL_FREQUENCIES } from "./bookkeeping-clients";
import { canApproveCoethaWork } from "@/lib/auth/permissions";
import { PAYROLL_ACCESS } from "./bookkeeping-profile";
import { staffUploadDocument } from "./documents";
import { nextPayDate } from "./business-overview";
import { isPayrollSystem, PAYROLL_CONNECTIONS, PAYROLL_PRESETS, PAYROLL_SYSTEMS, type PayrollPreset } from "@/lib/payroll/fields";
import { AMOUNT_KEYS, differenceOf, headersOf, payrollEntryLines, readRegister, RegisterError, versionHash, type Amounts, type EmployeeLine, type Mapping, type PayDateTotals, type PayrollAccounts } from "@/lib/payroll/register";

/**
 * Payroll for bookkeeping clients: provider setup, payroll register imports (ADP RUN, ADP
 * Workforce Now, Paychex Flex, or a hand-mapped layout), pay runs with immutable versions, and
 * the DRAFT payroll journal entry for each pay date.
 *
 * Rules:
 * - Everything is scoped to one client; runs, versions and accounts from another client are refused.
 * - Imports and (later) API syncs create DRAFT runs. Nothing is posted, approved or submitted
 *   automatically. Staff with ledger access post to the books; the period-close lock still applies.
 * - A run whose origin is COETHA is finalized (posted or submitted) only by Tabitha.
 * - The same provider + check date + totals is imported once (dedupe key), so re-imports never double-post.
 */

type Tx = Prisma.TransactionClient;

export const LOCKED = new Set(["SUBMITTED", "PROVIDER_ACCEPTED", "PROCESSED", "DISCARDED"]);

/** Staff functions are called only by real, active staff accounts — never a portal login. */
export async function assertStaff(actor: Actor) {
  const u = await prisma.user.findUnique({ where: { id: actor.id }, select: { active: true } });
  if (!u?.active) throw new ForbiddenError("Only office staff can do that.");
}

/**
 * Pay-run work (import, versions, sending for approval, recording the ADP submission): the books
 * rule (Admins, the assigned staff member, ledger grants) as before, or the owner's
 * "ADP Payroll & Taxes → Manage" grant. The ledger write rule for posting is unchanged.
 */
export async function assertPayrollWork(actor: Actor, clientId: string) {
  if (await canUseLedger(actor, clientId)) return;
  if (await canManagePayrollTaxes(actor)) return;
  await assertLedger(actor, clientId);
}

/** A version's content hash: the figures (versionHash) plus, when present, the attached document. */
export function contentHashOf(base: string, documentSha256: string | null | undefined) {
  return documentSha256 ? createHash("sha256").update(`${base}|document:${documentSha256}`).digest("hex") : base;
}

// --- Setup --------------------------------------------------------------------------------

export type PayrollSetupInput = { system: string; providerName?: string | null; frequency?: string | null; connection?: string | null; accessStatus?: string | null };

export async function savePayrollSetup(actor: Actor, clientId: string, input: PayrollSetupInput) {
  await assertStaff(actor);
  const p = await prisma.bookkeepingProfile.findUnique({ where: { clientId } });
  if (!p) throw new ValidationError("Add this client to Bookkeeping Clients first.");
  if (!p.payroll) throw new ValidationError("Turn on payroll for this client in Bookkeeping settings first.");
  if (!isPayrollSystem(input.system)) throw new ValidationError("Choose the payroll system.");
  if (input.frequency && !(input.frequency in PAYROLL_FREQUENCIES)) throw new ValidationError("Choose how often payroll runs.");
  if (input.connection && !(input.connection in PAYROLL_CONNECTIONS)) throw new ValidationError("Choose how payroll data reaches us.");
  if (input.accessStatus && !(input.accessStatus in PAYROLL_ACCESS)) throw new ValidationError("Choose the accountant-access status.");
  const name = input.system === "OTHER" ? input.providerName?.trim().slice(0, 80) || "Other" : PAYROLL_SYSTEMS[input.system];
  const data = { payrollSystem: input.system, payrollProvider: name, payrollFrequency: input.frequency || null, payrollConnection: input.connection || "REPORT_IMPORT", payrollAccessStatus: input.accessStatus || null, updatedById: actor.id };
  await prisma.bookkeepingProfile.update({ where: { clientId }, data });
  await audit(prisma, { actorId: actor.id, action: "payroll.setup_saved", entityType: "Client", entityId: clientId, clientId, details: { before: { system: p.payrollSystem, provider: p.payrollProvider, frequency: p.payrollFrequency, connection: p.payrollConnection, access: p.payrollAccessStatus }, after: { system: data.payrollSystem, provider: name, frequency: data.payrollFrequency, connection: data.payrollConnection, access: data.payrollAccessStatus } } });
}

// --- Files --------------------------------------------------------------------------------

export const MAX_PAYROLL_FILE = 5 * 1024 * 1024;

const cell = (v: unknown) => (v === null || v === undefined ? "" : v instanceof Date ? v.toISOString().slice(0, 10) : String(v).trim());

/** CSV (any provider) or XLSX (read with the read-excel-file dependency already in the app). */
export async function readGrid(bytes: Uint8Array, fileName: string): Promise<string[][]> {
  if (!bytes.length) throw new ValidationError("The file is empty.");
  if (bytes.length > MAX_PAYROLL_FILE) throw new ValidationError("That file is larger than 5 MB. Export one pay period or quarter at a time.");
  if (/\.xlsx$/i.test(fileName)) {
    const { readSheet } = await import("read-excel-file/node");
    try {
      const rows = await readSheet(Buffer.from(bytes));
      return rows.map((r) => r.map(cell));
    } catch {
      throw new ValidationError("That Excel file couldn't be read. Save it again as .xlsx (or export CSV) and retry.");
    }
  }
  if (/\.csv$/i.test(fileName)) return parseCsv(new TextDecoder("utf-8").decode(bytes));
  throw new ValidationError("Upload the payroll register as PDF, CSV or Excel (.xlsx). Older .xls files: open in Excel and save as .xlsx.");
}

/**
 * The register's rows: CSV/Excel as exported, or a PDF register (ADP RUN's usual export) read by
 * Coetha into the same rows with a fixed column mapping. Everything after this is the same importer.
 */
async function registerRows(actor: Actor, clientId: string, input: { bytes: Uint8Array; fileName: string; preset: PayrollPreset; mapping?: Mapping | null; headerRow?: number | null }) {
  const { isPdfFile, PDF_MAPPING, PayrollPdfError, readPayrollPdf } = await import("@/lib/payroll/pdf-register");
  if (!isPdfFile(input.bytes, input.fileName)) return { grid: await readGrid(input.bytes, input.fileName), preset: input.preset, mapping: input.mapping ?? null, headerRow: input.headerRow ?? null };
  if (!input.bytes.length) throw new ValidationError("The file is empty.");
  if (input.bytes.length > MAX_PAYROLL_FILE) throw new ValidationError("That file is larger than 5 MB. Export one pay period or quarter at a time.");
  try {
    return { grid: await readPayrollPdf(actor, clientId, input.bytes), preset: "OTHER" as PayrollPreset, mapping: PDF_MAPPING, headerRow: 0 };
  } catch (e) {
    if (e instanceof PayrollPdfError) throw new ValidationError(e.message);
    throw e;
  }
}

const presetOf = (p: string | null | undefined): PayrollPreset => (p && p in PAYROLL_PRESETS ? (p as PayrollPreset) : "OTHER");
const providerOf = (preset: PayrollPreset, system: string | null | undefined) => (preset !== "OTHER" ? preset : isPayrollSystem(system) ? system : "OTHER");
export const dedupeKeyOf = (provider: string, t: { checkDate: string; totalsHash: string }) => `${provider}:${t.checkDate}:${t.totalsHash}`;

function parse(grid: string[][], input: { preset: PayrollPreset; mapping?: Mapping | null; defaultCheckDate?: string | null; headerRow?: number | null }) {
  try {
    return readRegister(grid, { preset: input.preset, mapping: input.mapping ?? undefined, defaultCheckDate: input.defaultCheckDate, headerRow: input.headerRow });
  } catch (e) {
    if (e instanceof RegisterError) throw new ValidationError(e.message);
    throw e;
  }
}

export type PreviewInput = { bytes: Uint8Array; fileName: string; preset: string; mapping?: Mapping | null; defaultCheckDate?: string | null; headerRow?: number | null };

/** What an import would create, per pay date, without saving anything. */
export async function previewPayrollImport(actor: Actor, clientId: string, input: PreviewInput) {
  await assertStaff(actor);
  await assertPayrollWork(actor, clientId);
  const profile = await prisma.bookkeepingProfile.findUnique({ where: { clientId } });
  const chosen = presetOf(input.preset);
  const provider = providerOf(chosen, profile?.payrollSystem);
  const file = await registerRows(actor, clientId, { bytes: input.bytes, fileName: input.fileName, preset: chosen, mapping: input.mapping, headerRow: input.headerRow });
  const { grid, preset } = file;
  input = { ...input, mapping: file.mapping, headerRow: file.headerRow };
  let head;
  try {
    head = headersOf(grid, preset, input.headerRow);
  } catch (e) {
    if (e instanceof RegisterError) throw new ValidationError(e.message);
    throw e;
  }
  let r;
  try {
    r = readRegister(grid, { preset, mapping: input.mapping ?? undefined, defaultCheckDate: input.defaultCheckDate, headerRow: head.headerRow });
  } catch (e) {
    if (!(e instanceof RegisterError)) throw e;
    // Show the columns so staff can map them by hand.
    return { provider, error: e.message, headerRow: head.headerRow, headers: head.headers, mapping: input.mapping ?? head.mapping, rows: 0, skipped: [] as string[], sample: head.sample, payDates: [] as (PayDateTotals & { duplicate: boolean; otherRunSameDate: boolean })[] };
  }
  const keys = r.payDates.map((d) => dedupeKeyOf(provider, d));
  const existing = await prisma.payrollRun.findMany({ where: { clientId, OR: [{ dedupeKey: { in: keys } }, { checkDate: { in: r.payDates.map((d) => new Date(`${d.checkDate}T00:00:00Z`)) }, status: { not: "DISCARDED" } }] }, select: { dedupeKey: true, checkDate: true } });
  return {
    provider,
    error: null as string | null,
    headerRow: r.headerRow,
    headers: r.headers,
    mapping: r.mapping,
    rows: r.rows,
    skipped: r.skipped,
    sample: head.sample,
    payDates: r.payDates.map((d, i) => ({
      ...d,
      duplicate: existing.some((e) => e.dedupeKey === keys[i]),
      otherRunSameDate: existing.some((e) => e.dedupeKey !== keys[i] && ymdOf(e.checkDate) === d.checkDate),
    })),
  };
}

// --- Accounts -----------------------------------------------------------------------------

/** The standard payroll accounts, added to a client's chart when missing. */
export const PAYROLL_CHART = [
  { key: "wages", code: "7010", name: "Wages & Salaries", type: "EXPENSE" },
  { key: "employerTax", code: "7020", name: "Payroll Tax Expense (employer)", type: "EXPENSE" },
  { key: "taxLiability", code: "2200", name: "Payroll Taxes Payable", type: "LIABILITY" },
  { key: "deductionsLiability", code: "2210", name: "Payroll Deductions Payable", type: "LIABILITY" },
] as const;

export async function ensurePayrollAccounts(tx: Tx, actor: Actor, clientId: string, cashAccountId?: string | null): Promise<PayrollAccounts> {
  await bookOf(clientId, tx);
  const out: Partial<PayrollAccounts> = {};
  for (const a of PAYROLL_CHART) {
    let acct = await tx.ledgerAccount.findFirst({ where: { clientId, code: a.code } });
    if (acct && acct.type !== a.type) throw new ValidationError(`Account ${a.code} (${acct.name}) isn't a ${a.type.toLowerCase()} account. Rename it or free up ${a.code} for ${a.name}.`);
    if (!acct) {
      acct = await tx.ledgerAccount.create({ data: { clientId, code: a.code, name: a.name, type: a.type } });
      await audit(tx, { actorId: actor.id, action: "ledger.account_added", entityType: "LedgerAccount", entityId: acct.id, clientId, details: { code: a.code, name: a.name, type: a.type, reason: "standard payroll accounts" } });
    }
    out[a.key] = acct.id;
  }
  const cash = cashAccountId
    ? await tx.ledgerAccount.findFirst({ where: { id: cashAccountId, clientId, subtype: "BANK", active: true } })
    : await tx.ledgerAccount.findFirst({ where: { clientId, subtype: "BANK", active: true }, orderBy: { code: "asc" } });
  if (!cash) throw new ValidationError("Choose the bank account payroll is paid from (one of this client's bank accounts).");
  out.cash = cash.id;
  return out as PayrollAccounts;
}

// --- Runs ---------------------------------------------------------------------------------

const d = (s: string | null | undefined) => (s ? new Date(`${s}T00:00:00Z`) : null);
const amountsOf = (x: Amounts): Amounts => Object.fromEntries(AMOUNT_KEYS.map((k) => [k, x[k]])) as Amounts;

export async function event(tx: Tx, runId: string, kind: string, by: { userId?: string | null; portalUserId?: string | null; name?: string | null }, extra: { versionNumber?: number | null; note?: string | null } = {}) {
  await tx.payrollRunEvent.create({ data: { runId, kind, actorUserId: by.userId ?? null, portalUserId: by.portalUserId ?? null, actorName: by.name ?? null, versionNumber: extra.versionNumber ?? null, note: extra.note?.slice(0, 500) ?? null } });
}

export type VersionDocument = { id: string; sha256: string };
type VersionInput = Amounts & { checkDate: string; periodStart: string | null; periodEnd: string | null; lines: EmployeeLine[]; reason?: string | null; document?: VersionDocument | null; employeesOverride?: number };

async function createVersion(tx: Tx, runId: string, number: number, v: VersionInput, createdById: string | null) {
  const employees = v.employeesOverride ?? v.lines.length;
  const contentHash = contentHashOf(versionHash({ ...v, employees }), v.document?.sha256);
  return tx.payrollRunVersion.create({
    data: {
      runId, number, contentHash, checkDate: d(v.checkDate)!, periodStart: d(v.periodStart), periodEnd: d(v.periodEnd), employees, ...amountsOf(v), reason: v.reason?.slice(0, 300) ?? null, createdById,
      documentId: v.document?.id ?? null, documentSha256: v.document?.sha256 ?? null,
      lines: { create: v.lines.map((l, i) => ({ sortOrder: i, employeeName: l.employeeName.slice(0, 120), ...amountsOf(l) })) },
    },
  });
}

/**
 * The one path that turns pay dates (from a register import or, later, a provider API) into
 * DRAFT pay runs. Duplicates (same provider + check date + totals) are skipped. Pay dates that
 * don't tie out are reported and not created.
 */
export async function createRunsFromPayDates(tx: Tx, actor: Actor, clientId: string, input: { provider: string; origin: "IMPORT" | "API" | "COETHA" | "MANUAL"; payDates: PayDateTotals[]; importId?: string | null; cashAccountId?: string | null; alreadyProcessed?: boolean; document?: VersionDocument | null; employeesOverride?: number; reason?: string | null }) {
  const created: string[] = [];
  const duplicates: string[] = [];
  const unbalanced: { checkDate: string; differenceCents: number }[] = [];
  for (const p of input.payDates) {
    if (p.differenceCents !== 0) {
      unbalanced.push({ checkDate: p.checkDate, differenceCents: p.differenceCents });
      continue;
    }
    const dedupeKey = dedupeKeyOf(input.provider, p);
    if (await tx.payrollRun.count({ where: { clientId, dedupeKey } })) {
      duplicates.push(p.checkDate);
      continue;
    }
    const run = await tx.payrollRun.create({
      data: { clientId, provider: input.provider, origin: input.origin, importId: input.importId ?? null, dedupeKey, checkDate: d(p.checkDate)!, cashAccountId: input.cashAccountId ?? null, createdById: actor.id, ...(input.alreadyProcessed ? { status: "PROCESSED", submittedAt: new Date(), submittedById: actor.id, submissionMethod: "PROCESSED_AT_PROVIDER" } : {}) },
    });
    const v = await createVersion(tx, run.id, 1, { ...p, document: input.document ?? null, employeesOverride: input.employeesOverride, reason: input.reason ?? (input.origin === "IMPORT" ? "Imported from the payroll register" : input.origin === "API" ? "Received from the payroll provider" : null) }, actor.id);
    await tx.payrollRun.update({ where: { id: run.id }, data: { currentVersionId: v.id } });
    await event(tx, run.id, "CREATED", { userId: actor.id, name: actor.name }, { versionNumber: 1, note: input.origin === "IMPORT" ? "Imported from the payroll register" : `Created (${input.origin.toLowerCase()})` });
    if (input.alreadyProcessed) await event(tx, run.id, "PROCESSED", { userId: actor.id, name: actor.name }, { versionNumber: 1, note: "Already processed and paid by the payroll provider (imported after the fact)" });
    created.push(run.id);
  }
  return { created, duplicates, unbalanced };
}

export type ImportInput = PreviewInput & { cashAccountId?: string | null; alreadyProcessed?: boolean };

/**
 * Imports a payroll register: keeps the file in the client's documents (PAYROLL_REPORT), creates
 * one DRAFT pay run (with its draft journal entry) per new pay date, and marks "Payroll reports"
 * received on each month's checklist.
 */
export async function importPayrollRegister(actor: Actor, clientId: string, input: ImportInput) {
  await assertStaff(actor);
  await assertPayrollWork(actor, clientId);
  const profile = await prisma.bookkeepingProfile.findUnique({ where: { clientId } });
  if (!profile?.payroll) throw new ValidationError("Turn on payroll for this client first.");
  const chosen = presetOf(input.preset);
  const provider = providerOf(chosen, profile.payrollSystem);
  const file = await registerRows(actor, clientId, { bytes: input.bytes, fileName: input.fileName, preset: chosen, mapping: input.mapping, headerRow: input.headerRow });
  const r = parse(file.grid, { preset: file.preset, mapping: file.mapping, defaultCheckDate: input.defaultCheckDate, headerRow: file.headerRow });
  if (input.cashAccountId && !(await prisma.ledgerAccount.count({ where: { id: input.cashAccountId, clientId, subtype: "BANK" } }))) throw new ValidationError("Choose one of this client's bank accounts.");
  const sha = createHash("sha256").update(input.bytes).digest("hex");
  const last = r.payDates.at(-1)!.checkDate;
  const [y, m] = [Number(last.slice(0, 4)), Number(last.slice(5, 7))];
  // The same file again: keep the copy already saved (the vault stores each file once).
  let doc = await prisma.document.findFirst({ where: { clientId, deletedAt: null, file: { sha256: sha } }, select: { id: true } });
  if (!doc) {
    const period = await openWorkPeriod(actor, clientId, y, m);
    // Payroll files live in the PAYROLL category: the office can release them to the client's Payroll page.
    doc = await staffUploadDocument(actor, { clientId, category: "PAYROLL", title: `Payroll register — ${PAYROLL_SYSTEMS[provider as keyof typeof PAYROLL_SYSTEMS] ?? provider} — ${r.payDates[0].checkDate} to ${last}`, year: y, month: m, visibility: "STAFF_ONLY", periodId: period.id, docType: "PAYROLL_REPORT", bytes: input.bytes, originalName: input.fileName, allowSpreadsheet: true, notify: false });
  }
  const result = await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${"payroll:" + clientId}))`;
    const imp = await tx.payrollImport.create({ data: { clientId, provider, fileName: input.fileName.slice(0, 200), fileSha256: sha, documentId: doc.id, rows: r.rows, payDates: r.payDates.length, created: 0, duplicates: 0, mapping: r.mapping as Prisma.InputJsonValue, createdById: actor.id } });
    const res = await createRunsFromPayDates(tx, actor, clientId, { provider, origin: "IMPORT", payDates: r.payDates, importId: imp.id, cashAccountId: input.cashAccountId, alreadyProcessed: input.alreadyProcessed });
    await tx.payrollImport.update({ where: { id: imp.id }, data: { created: res.created.length, duplicates: res.duplicates.length } });
    await audit(tx, { actorId: actor.id, action: "payroll.register_imported", entityType: "PayrollImport", entityId: imp.id, clientId, details: { provider, rows: r.rows, payDates: r.payDates.length, created: res.created.length, duplicates: res.duplicates.length, unbalanced: res.unbalanced.length, documentId: doc.id } });
    return { importId: imp.id, ...res };
  });
  // "Payroll reports" received for every month the file covers.
  for (const month of new Set(r.payDates.map((p) => p.checkDate.slice(0, 7)))) await markChecklist(actor, clientId, month, "PAYROLL_REPORTS");
  return { ...result, skipped: r.skipped, documentId: doc.id };
}

async function markChecklist(actor: Actor, clientId: string, month: string, key: "PAYROLL_REPORTS" | "PAYROLL_ENTRIES") {
  const period = await openWorkPeriod(actor, clientId, Number(month.slice(0, 4)), Number(month.slice(5, 7)));
  const item = await prisma.bookkeepingChecklistItem.findUnique({ where: { periodId_key: { periodId: period.id, key } } });
  if (!item || item.status === "DONE") return;
  await prisma.bookkeepingChecklistItem.update({ where: { id: item.id }, data: { status: "DONE", doneById: actor.id, doneAt: new Date() } });
  await audit(prisma, { actorId: actor.id, action: "bookkeeping.checklist_updated", entityType: "BookkeepingChecklistItem", entityId: item.id, clientId, details: { key, status: "DONE", by: "payroll" } });
}

export async function loadRun(clientId: string, runId: string, db: Tx | typeof prisma = prisma) {
  const run = await db.payrollRun.findFirst({ where: { id: runId, clientId } });
  if (!run || !run.currentVersionId) throw new ValidationError("Pay run not found.");
  const version = await db.payrollRunVersion.findUniqueOrThrow({ where: { id: run.currentVersionId }, include: { lines: { orderBy: { sortOrder: "asc" } } } });
  return { run, version };
}

/**
 * `document` (ADP Payroll & Taxes workspace): the preview document shown with the new version.
 * Left out, the current version's document carries over; null removes it.
 */
export type EditInput = { checkDate?: string; periodStart?: string | null; periodEnd?: string | null; lines: (Partial<Amounts> & { employeeName: string })[]; reason: string; document?: VersionDocument | null; employeesOverride?: number };

const documentOf = (v: { documentId: string | null; documentSha256: string | null }): VersionDocument | null => (v.documentId && v.documentSha256 ? { id: v.documentId, sha256: v.documentSha256 } : null);

/**
 * Staff change a run's figures: a NEW version is created (the old one stays). Approvals given
 * on an earlier version no longer count, so the run goes back to Draft and must be sent for
 * approval again.
 */
export async function editPayrollRun(actor: Actor, clientId: string, runId: string, input: EditInput) {
  await assertStaff(actor);
  await assertPayrollWork(actor, clientId);
  const reason = input.reason?.trim() ?? "";
  if (reason.length < 3) throw new ValidationError("Say what changed and why.");
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${"payroll-run:" + runId}))`;
    const { run, version } = await loadRun(clientId, runId, tx);
    if (LOCKED.has(run.status)) throw new ValidationError(run.status === "DISCARDED" ? "This pay run was discarded." : "This pay run was submitted for processing, so it's locked. Corrections are made in the payroll provider and imported as a new run.");
    if (!input.lines.length) throw new ValidationError("A pay run needs at least one employee line.");
    const lines: EmployeeLine[] = input.lines.map((l) => {
      const name = l.employeeName?.trim();
      if (!name) throw new ValidationError("Every line needs an employee name.");
      const a = Object.fromEntries(AMOUNT_KEYS.map((k) => [k, Math.round(Number(l[k] ?? 0))])) as Amounts;
      if (AMOUNT_KEYS.some((k) => !Number.isFinite(a[k]) || a[k] < 0)) throw new ValidationError(`Amounts for ${name} must be zero or more.`);
      return { ...a, employeeName: name };
    });
    const totals = lines.reduce((t, l) => { for (const k of AMOUNT_KEYS) t[k] += l[k]; return t; }, Object.fromEntries(AMOUNT_KEYS.map((k) => [k, 0])) as Amounts);
    const diff = differenceOf(totals);
    if (diff !== 0) throw new ValidationError(`Gross − employee taxes − deductions must equal net pay. It's off by ${usd(diff)}.`);
    const checkDate = input.checkDate || ymdOf(version.checkDate);
    const v = await createVersion(tx, run.id, version.number + 1, { ...totals, lines, checkDate, periodStart: input.periodStart !== undefined ? input.periodStart : version.periodStart ? ymdOf(version.periodStart) : null, periodEnd: input.periodEnd !== undefined ? input.periodEnd : version.periodEnd ? ymdOf(version.periodEnd) : null, reason, document: input.document !== undefined ? input.document : documentOf(version), employeesOverride: input.employeesOverride }, actor.id);
    if (v.contentHash === version.contentHash) throw new ValidationError("Nothing changed.");
    const hadApprovals = await tx.payrollApproval.count({ where: { runId, round: run.approvalRound } });
    const backToDraft = run.status !== "DRAFT";
    await tx.payrollRun.update({ where: { id: run.id }, data: { currentVersionId: v.id, checkDate: d(checkDate)!, ...(backToDraft ? { status: "DRAFT", fullyApprovedAt: null } : {}) } });
    await event(tx, run.id, "VERSIONED", { userId: actor.id, name: actor.name }, { versionNumber: v.number, note: reason });
    if (backToDraft || hadApprovals) await event(tx, run.id, "APPROVALS_INVALIDATED", { userId: actor.id, name: actor.name }, { versionNumber: v.number, note: "Changed after it was sent for approval: earlier approvals no longer count. Send it for approval again." });
    await audit(tx, { actorId: actor.id, action: "payroll.run_versioned", entityType: "PayrollRun", entityId: run.id, clientId, details: { from: version.number, to: v.number, reason, previousStatus: run.status, approvalsInvalidated: hadApprovals } });
    return v;
  });
}

/**
 * Attaches (or replaces) the preview document a run is approved on. The figures stay the same,
 * but the document's sha256 is part of the content hash, so this is a NEW version: earlier
 * approvals stop counting and the run goes back to Draft, exactly like an edit.
 */
export async function attachRunDocument(actor: Actor, clientId: string, runId: string, document: VersionDocument, reason = "ADP preview attached") {
  await assertStaff(actor);
  await assertPayrollWork(actor, clientId);
  if (!(await prisma.document.count({ where: { id: document.id, clientId, deletedAt: null } }))) throw new ValidationError("That document isn't in this client's file.");
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${"payroll-run:" + runId}))`;
    const { run, version } = await loadRun(clientId, runId, tx);
    if (LOCKED.has(run.status)) throw new ValidationError(run.status === "DISCARDED" ? "This pay run was discarded." : "This pay run was submitted for processing, so it's locked.");
    if (version.documentSha256 === document.sha256) throw new ValidationError("That document is already attached to the current version.");
    const lines: EmployeeLine[] = version.lines.map((l) => ({ ...amountsOf(l), employeeName: l.employeeName }));
    const v = await createVersion(tx, run.id, version.number + 1, { ...amountsOf(version), lines, employeesOverride: version.employees, checkDate: ymdOf(version.checkDate), periodStart: version.periodStart ? ymdOf(version.periodStart) : null, periodEnd: version.periodEnd ? ymdOf(version.periodEnd) : null, reason, document }, actor.id);
    const hadApprovals = await tx.payrollApproval.count({ where: { runId, round: run.approvalRound } });
    const backToDraft = run.status !== "DRAFT";
    await tx.payrollRun.update({ where: { id: run.id }, data: { currentVersionId: v.id, ...(backToDraft ? { status: "DRAFT", fullyApprovedAt: null } : {}) } });
    await event(tx, run.id, "VERSIONED", { userId: actor.id, name: actor.name }, { versionNumber: v.number, note: reason });
    if (backToDraft || hadApprovals) await event(tx, run.id, "APPROVALS_INVALIDATED", { userId: actor.id, name: actor.name }, { versionNumber: v.number, note: "The preview document changed after it was sent for approval: earlier approvals no longer count. Send it for approval again." });
    await audit(tx, { actorId: actor.id, action: "payroll.run_document_attached", entityType: "PayrollRun", entityId: run.id, clientId, details: { from: version.number, to: v.number, documentId: document.id, previousDocumentId: version.documentId, previousStatus: run.status, approvalsInvalidated: hadApprovals } });
    return v;
  });
}

export async function discardPayrollRun(actor: Actor, clientId: string, runId: string, reason: string) {
  await assertStaff(actor);
  await assertLedger(actor, clientId);
  if ((reason?.trim().length ?? 0) < 3) throw new ValidationError("Record why this pay run is being discarded.");
  const { run } = await loadRun(clientId, runId);
  if (LOCKED.has(run.status)) throw new ValidationError("Submitted, processed or discarded pay runs can't be discarded.");
  await prisma.$transaction(async (tx) => {
    await tx.payrollRun.update({ where: { id: run.id }, data: { status: "DISCARDED", discardedAt: new Date(), discardedById: actor.id, discardReason: reason.trim().slice(0, 300) } });
    await event(tx, run.id, "DISCARDED", { userId: actor.id, name: actor.name }, { note: reason });
    await audit(tx, { actorId: actor.id, action: "payroll.run_discarded", entityType: "PayrollRun", entityId: run.id, clientId, details: { reason: reason.trim().slice(0, 300) } });
  });
}

/** The draft journal entry for a run (shown before posting). Accounts are named as they'll be used. */
export async function draftEntry(clientId: string, runId: string) {
  const { run, version } = await loadRun(clientId, runId);
  const accounts = await prisma.ledgerAccount.findMany({ where: { clientId, OR: [{ code: { in: PAYROLL_CHART.map((a) => a.code) } }, { subtype: "BANK" }] }, orderBy: { code: "asc" } });
  const byCode = (c: string) => accounts.find((a) => a.code === c);
  const cash = run.cashAccountId ? accounts.find((a) => a.id === run.cashAccountId) : accounts.find((a) => a.subtype === "BANK");
  const names: PayrollAccounts = {
    wages: byCode("7010") ? `${byCode("7010")!.code} ${byCode("7010")!.name}` : "7010 Wages & Salaries (added when posted)",
    employerTax: byCode("7020") ? `${byCode("7020")!.code} ${byCode("7020")!.name}` : "7020 Payroll Tax Expense (added when posted)",
    taxLiability: byCode("2200") ? `${byCode("2200")!.code} ${byCode("2200")!.name}` : "2200 Payroll Taxes Payable (added when posted)",
    deductionsLiability: byCode("2210") ? `${byCode("2210")!.code} ${byCode("2210")!.name}` : "2210 Payroll Deductions Payable (added when posted)",
    cash: cash ? `${cash.code} ${cash.name}` : "Bank account (choose when posting)",
  };
  const lines = payrollEntryLines(version, names).map((l) => ({ account: l.accountId, debitCents: l.debitCents, creditCents: l.creditCents, description: l.description }));
  return { lines, debits: lines.reduce((n, l) => n + l.debitCents, 0), credits: lines.reduce((n, l) => n + l.creditCents, 0) };
}

/**
 * Posts a run's payroll journal entry. Normal staff bookkeeping work: Admins or the assigned
 * staff member (ledger write access). Only processed payroll is booked, the closed-period lock
 * applies, and a COETHA-originated run is posted only by Tabitha.
 */
export async function postPayrollRun(actor: Actor, clientId: string, runId: string, input: { cashAccountId?: string | null } = {}) {
  await assertStaff(actor);
  await assertLedgerWrite(actor, clientId);
  const { run, version } = await loadRun(clientId, runId);
  if (run.origin === "COETHA" && !(await canApproveCoethaWork(actor))) throw new ForbiddenError("This pay run was prepared by Coetha. Only Tabitha can approve and post Coetha's work.");
  if (run.journalEntryId) throw new ValidationError("This pay run is already posted.");
  if (run.status !== "SUBMITTED" && run.status !== "PROVIDER_ACCEPTED" && run.status !== "PROCESSED") throw new ValidationError("Post payroll to the books after it's submitted for processing (or imported as already processed).");
  const checkDate = ymdOf(version.checkDate);
  const entry = await prisma.$transaction(async (tx) => {
    const accounts = await ensurePayrollAccounts(tx, actor, clientId, input.cashAccountId ?? run.cashAccountId);
    const lines = payrollEntryLines(version, accounts);
    const e = await postEntryTx(tx, actor, clientId, {
      date: checkDate,
      memo: `Payroll — ${PAYROLL_SYSTEMS[run.provider as keyof typeof PAYROLL_SYSTEMS] ?? run.provider} — check date ${checkDate} (${version.employees} employee${version.employees === 1 ? "" : "s"})`,
      source: "PAYROLL",
      sourceKey: `payroll:${run.dedupeKey}`,
      lines: lines.map((l) => ({ accountId: l.accountId, debit: l.debitCents ? (l.debitCents / 100).toFixed(2) : undefined, credit: l.creditCents ? (l.creditCents / 100).toFixed(2) : undefined, description: l.description })),
    });
    const claimed = await tx.payrollRun.updateMany({ where: { id: run.id, journalEntryId: null }, data: { journalEntryId: e.id, postedAt: new Date(), postedById: actor.id, cashAccountId: accounts.cash } });
    if (claimed.count !== 1) throw new ValidationError("This pay run is already posted.");
    await event(tx, run.id, "POSTED", { userId: actor.id, name: actor.name }, { versionNumber: version.number, note: `Journal entry posted to the books (${usd(version.grossCents)} gross)` });
    await audit(tx, { actorId: actor.id, action: "payroll.run_posted", entityType: "PayrollRun", entityId: run.id, clientId, details: { journalEntryId: e.id, version: version.number, checkDate } });
    return e;
  });
  // "Record payroll" is done once every run for that month is posted.
  const month = checkDate.slice(0, 7);
  const open = await prisma.payrollRun.count({ where: { clientId, status: { not: "DISCARDED" }, journalEntryId: null, checkDate: { gte: d(`${month}-01`)!, lt: new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 1)) } } });
  if (!open) await markChecklist(actor, clientId, month, "PAYROLL_ENTRIES");
  return entry;
}

// --- Sharing payroll reports with the client -----------------------------------------------

/** This client's payroll files (registers, summaries, 941s, W-2s) and whether each is released to the client. */
export async function payrollReports(clientId: string) {
  const docs = await prisma.document.findMany({
    where: { clientId, deletedAt: null, OR: [{ category: "PAYROLL" }, { docType: { in: ["PAYROLL_REPORT", "FORM_W2_ISSUED"] } }] },
    orderBy: [{ year: "desc" }, { month: "desc" }, { createdAt: "desc" }],
    take: 60,
    select: { id: true, title: true, year: true, month: true, visibility: true, publishedAt: true, scanStatus: true, uploadedByPortalId: true, createdAt: true, category: true },
  });
  const opened = await prisma.documentAccessLog.groupBy({ by: ["documentId"], where: { documentId: { in: docs.map((d) => d.id) }, portalUserId: { not: null } }, _max: { createdAt: true } });
  const openedAt = new Map(opened.map((o) => [o.documentId, o._max.createdAt]));
  return docs.map((d) => ({ ...d, shared: d.visibility === "PUBLISHED", fromClient: !!d.uploadedByPortalId, clientOpenedAt: openedAt.get(d.id) ?? null }));
}

/**
 * Releases a payroll file to the client's Payroll page (the existing document release: scan checks,
 * access log, audit). A payroll register saved under Bookkeeping by an earlier import is moved to the
 * Payroll category first. Notifying the client is opt-in.
 */
export async function sharePayrollReport(actor: Actor, clientId: string, documentId: string, opts: { share: boolean; notify?: boolean }) {
  await assertStaff(actor);
  await assertPayrollWork(actor, clientId);
  const doc = await prisma.document.findFirst({ where: { id: documentId, clientId, deletedAt: null } });
  if (!doc || !(doc.category === "PAYROLL" || doc.docType === "PAYROLL_REPORT" || doc.docType === "FORM_W2_ISSUED")) throw new ValidationError("That payroll file isn't on file for this client.");
  const { setVisibility } = await import("./documents");
  if (!opts.share) {
    await setVisibility(actor, doc.id, "STAFF_ONLY");
    return;
  }
  if (doc.scanStatus === "INFECTED") throw new ValidationError("The virus scanner flagged this file; it can't be shared.");
  if (doc.category !== "PAYROLL") {
    await prisma.document.update({ where: { id: doc.id }, data: { category: "PAYROLL" } });
    await audit(prisma, { actorId: actor.id, action: "payroll.report_recategorized", entityType: "Document", entityId: doc.id, clientId, details: { from: doc.category } });
  }
  // setVisibility notifies the client on a first release; without "notify", the release is silent.
  if (!opts.notify) await prisma.document.update({ where: { id: doc.id }, data: { publishedAt: doc.publishedAt ?? new Date() } });
  await setVisibility(actor, doc.id, "PUBLISHED");
  await audit(prisma, { actorId: actor.id, action: "payroll.report_shared", entityType: "Document", entityId: doc.id, clientId, details: { notify: !!opts.notify } });
}

// --- Reads --------------------------------------------------------------------------------

/** Pay history from imported/received runs, newest first (discarded runs left out). */
export async function payHistory(clientId: string, take = 12) {
  const runs = await prisma.payrollRun.findMany({ where: { clientId, status: { not: "DISCARDED" } }, orderBy: [{ checkDate: "desc" }, { createdAt: "desc" }], take });
  const versions = await prisma.payrollRunVersion.findMany({ where: { id: { in: runs.map((r) => r.currentVersionId!).filter(Boolean) } } });
  return runs.map((r) => ({ run: r, version: versions.find((v) => v.id === r.currentVersionId)! }));
}

/** Last pay date and the next one, from imported data first, then the known pay date on the profile. */
export async function payrollSchedule(clientId: string, today = todayCentral()) {
  const profile = await prisma.bookkeepingProfile.findUnique({ where: { clientId } });
  const lastRun = await prisma.payrollRun.findFirst({ where: { clientId, status: { not: "DISCARDED" } }, orderBy: { checkDate: "desc" } });
  const last = lastRun ? ymdOf(lastRun.checkDate) : null;
  const known = last ?? (profile?.payrollPayDate ? ymdOf(profile.payrollPayDate) : null);
  return { last, next: nextPayDate(known, profile?.payrollFrequency ?? null, today), fromImports: !!last };
}
