import "server-only";
import { createHash, randomBytes } from "node:crypto";
import type { AdpStatement, AdpStatementLine, Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import type { Actor } from "@/lib/auth/actor";
import { assertOwner } from "@/lib/auth/owner";
import { storage } from "@/lib/storage";
import { MAX_UPLOAD_BYTES, MAX_UPLOAD_LABEL, sniffType } from "@/lib/files";
import {
  ADP_PRODUCTS,
  AdpInputError,
  DEFAULT_FISCAL_NOTE,
  LINE_TYPES,
  PAYMENT_METHODS,
  REFERRAL_STATUSES,
  STATEMENT_FILE_TYPES,
  adpFiscalQuarter,
  buildReport,
  csvHeaders,
  isYmd,
  mapCsvRows,
  productLabel,
  statementTotalCheck,
  ymdOf,
  type CsvMapping,
  type LineType,
  type ReportBasis,
  type ReportLine,
} from "@/lib/adp-revenue-share";
import { ValidationError } from "./clients";
import { parseCsv } from "./ledger";

/**
 * Owner's Office → ADP Revenue Share. Tabitha's own tracker for her ADP Revenue Share
 * relationship: referrals, ADP statements (uploaded from ADP's partner portal) with their lines,
 * payments received from ADP, a manual payment-to-statement match, and reports.
 *
 * Owner only, not grantable: every function starts with assertOwner, so staff — including Admins
 * who aren't the owner — get "Not found." exactly like the other owner-bound pages. Statement files
 * go to the owner-only store ("owner_private/…", see src/lib/storage.ts) and are only served by
 * the owner-only route; nothing here is ever shown in a client's portal. Clients are only linked,
 * never created. Every create/update/finalize/match/delete writes an OwnerAuditLog entry; deletes
 * are soft (archivedAt + reason). Reconciliation is manual in this stage.
 */

type Tx = Prisma.TransactionClient;

const dateOnly = (s: string) => new Date(`${s}T00:00:00.000Z`);
const clean = (s: string | null | undefined, max: number) => (s ?? "").trim().slice(0, max) || null;

function need(cond: unknown, message: string): asserts cond {
  if (!cond) throw new ValidationError(message);
}

const ymdField = (s: string | null | undefined, label: string) => {
  need(s && isYmd(s), `Enter ${label}.`);
  return dateOnly(s);
};

const reasonOf = (r: string | null | undefined, what = "a reason") => {
  const v = (r ?? "").trim();
  need(v.length >= 3, `Enter ${what} (at least 3 characters).`);
  return v.slice(0, 2000);
};

function audit(tx: Tx, actorId: string, action: string, entityType: string, entityId: string, details?: Record<string, unknown>) {
  return tx.ownerAuditLog.create({ data: { actorId, action, entityType, entityId, details: details as object | undefined } });
}

async function ownerTx<T>(actor: Actor, fn: (tx: Tx) => Promise<T>): Promise<T> {
  await assertOwner(actor);
  return prisma.$transaction(fn);
}

async function activeClient(tx: Tx | typeof prisma, clientId: string | null | undefined) {
  if (!clientId) return null;
  const c = await tx.client.findUnique({ where: { id: clientId }, select: { id: true, archivedAt: true } });
  need(c && !c.archivedAt, "That client isn't in the client list. Choose an existing client (clients are never created here).");
  return c.id;
}

async function activeReferral(tx: Tx | typeof prisma, referralId: string | null | undefined) {
  if (!referralId) return null;
  const r = await tx.adpReferral.findUnique({ where: { id: referralId }, select: { id: true, archivedAt: true } });
  need(r && !r.archivedAt, "That referral wasn't found.");
  return r.id;
}

// --- Clients (for the search box) ---------------------------------------------------------------

/** Existing, non-archived clients for the referral / line client search. Clients are never created here. */
export async function adpClientChoices(actor: Actor) {
  await assertOwner(actor);
  const rows = await prisma.client.findMany({
    where: { archivedAt: null },
    select: { id: true, displayName: true, businessName: true, email: true, phone: true },
    orderBy: { displayName: "asc" },
  });
  return rows.map((c) => ({
    id: c.id,
    name: c.businessName || c.displayName,
    person: c.businessName && c.businessName !== c.displayName ? c.displayName : null,
    email: c.email,
    phone: c.phone,
  }));
}
export type AdpClientChoice = Awaited<ReturnType<typeof adpClientChoices>>[number];

const clientName = (c: { displayName: string; businessName: string | null } | null | undefined) => (c ? c.businessName || c.displayName : null);

// --- Referrals ----------------------------------------------------------------------------------

export type ReferralInput = {
  clientId?: string | null;
  prospectName?: string | null;
  referredOn: string;
  product: string;
  productOther?: string | null;
  adpReference?: string | null;
  notes?: string | null;
};

function referralData(input: ReferralInput) {
  need((ADP_PRODUCTS as readonly string[]).includes(input.product), "Choose the ADP product.");
  const productOther = input.product === "OTHER" ? clean(input.productOther, 120) : null;
  need(input.product !== "OTHER" || productOther, "Say which ADP product (for “Other”).");
  const prospectName = clean(input.prospectName, 200);
  need(input.clientId || prospectName, "Choose the client, or enter the prospect's name if they aren't a client yet.");
  return {
    prospectName,
    referredOn: ymdField(input.referredOn, "the date referred"),
    product: input.product,
    productOther,
    adpReference: clean(input.adpReference, 120),
    notes: clean(input.notes, 5000),
  };
}

export async function createReferral(actor: Actor, input: ReferralInput & { status?: string }) {
  await assertOwner(actor);
  const status = input.status || "REFERRED";
  need((REFERRAL_STATUSES as readonly string[]).includes(status), "Choose a status.");
  const data = referralData(input);
  return ownerTx(actor, async (tx) => {
    const clientId = await activeClient(tx, input.clientId);
    const r = await tx.adpReferral.create({ data: { ...data, clientId, status, createdById: actor.id } });
    await tx.adpReferralStatusChange.create({ data: { referralId: r.id, fromStatus: null, toStatus: status, effectiveOn: data.referredOn, note: "Referral recorded", changedById: actor.id } });
    await audit(tx, actor.id, "adp.referral.created", "AdpReferral", r.id, { status, product: r.product, linkedClient: !!clientId });
    return r;
  });
}

export async function updateReferral(actor: Actor, id: string, input: ReferralInput) {
  await assertOwner(actor);
  const data = referralData(input);
  return ownerTx(actor, async (tx) => {
    const before = await tx.adpReferral.findUnique({ where: { id } });
    need(before && !before.archivedAt, "Not found.");
    const clientId = await activeClient(tx, input.clientId);
    const r = await tx.adpReferral.update({ where: { id }, data: { ...data, clientId } });
    const changed = (["clientId", "prospectName", "product", "productOther", "adpReference", "notes"] as const).filter((k) => (before[k] ?? null) !== (r[k] ?? null));
    if (ymdOf(before.referredOn) !== ymdOf(r.referredOn)) changed.push("referredOn" as never);
    await audit(tx, actor.id, "adp.referral.updated", "AdpReferral", id, { changed, clientLinked: !before.clientId && !!clientId });
    return r;
  });
}

export async function changeReferralStatus(actor: Actor, id: string, input: { status: string; effectiveOn?: string | null; note?: string | null }) {
  await assertOwner(actor);
  need((REFERRAL_STATUSES as readonly string[]).includes(input.status), "Choose a status.");
  const effectiveOn = input.effectiveOn ? ymdField(input.effectiveOn, "the date of the change") : null;
  return ownerTx(actor, async (tx) => {
    const before = await tx.adpReferral.findUnique({ where: { id } });
    need(before && !before.archivedAt, "Not found.");
    need(before.status !== input.status, "That is already the referral's status.");
    await tx.adpReferral.update({ where: { id }, data: { status: input.status } });
    await tx.adpReferralStatusChange.create({ data: { referralId: id, fromStatus: before.status, toStatus: input.status, effectiveOn, note: clean(input.note, 2000), changedById: actor.id } });
    await audit(tx, actor.id, "adp.referral.status_changed", "AdpReferral", id, { from: before.status, to: input.status });
  });
}

export async function archiveReferral(actor: Actor, id: string, reason: string) {
  await assertOwner(actor);
  const why = reasonOf(reason, "why you're deleting this referral");
  return ownerTx(actor, async (tx) => {
    const res = await tx.adpReferral.updateMany({ where: { id, archivedAt: null }, data: { archivedAt: new Date(), archivedById: actor.id, archivedReason: why } });
    need(res.count === 1, "Not found.");
    await audit(tx, actor.id, "adp.referral.deleted", "AdpReferral", id, { reason: why, soft: true });
  });
}

export async function listReferrals(actor: Actor, opts: { archived?: boolean } = {}) {
  await assertOwner(actor);
  return prisma.adpReferral.findMany({
    where: { archivedAt: opts.archived ? { not: null } : null },
    include: { client: { select: { id: true, displayName: true, businessName: true } }, _count: { select: { lines: { where: { archivedAt: null } } } } },
    orderBy: [{ referredOn: "desc" }, { createdAt: "desc" }],
  });
}

export async function getReferral(actor: Actor, id: string) {
  await assertOwner(actor);
  const r = await prisma.adpReferral.findUnique({
    where: { id },
    include: {
      client: { select: { id: true, displayName: true, businessName: true } },
      statusHistory: { orderBy: { changedAt: "asc" } },
      lines: { where: { archivedAt: null, statement: { archivedAt: null } }, include: { statement: { select: { id: true, periodLabel: true, statementDate: true } } }, orderBy: { createdAt: "asc" } },
    },
  });
  if (!r) return null;
  const names = await staffNames([...r.statusHistory.map((h) => h.changedById), r.archivedById ?? ""]);
  return { ...r, names };
}

/** Referral name as shown everywhere: the client's name, or the prospect's. */
export const referralName = (r: { client?: { displayName: string; businessName: string | null } | null; prospectName: string | null }) =>
  clientName(r.client) ?? (r.prospectName ? `${r.prospectName} (prospect)` : "Unnamed referral");

/** Referral options for statement lines and the CSV name mapping. */
export async function referralChoices(actor: Actor) {
  await assertOwner(actor);
  const rows = await prisma.adpReferral.findMany({ where: { archivedAt: null }, include: { client: { select: { displayName: true, businessName: true } } }, orderBy: { referredOn: "desc" } });
  return rows.map((r) => ({ id: r.id, label: `${referralName(r)} — ${productLabel(r.product, r.productOther)}${r.adpReference ? ` · ${r.adpReference}` : ""}` }));
}

async function staffNames(ids: string[]) {
  const list = [...new Set(ids.filter(Boolean))];
  const users = list.length ? await prisma.user.findMany({ where: { id: { in: list } }, select: { id: true, name: true } }) : [];
  return Object.fromEntries(users.map((u) => [u.id, u.name])) as Record<string, string>;
}

// --- Statements ---------------------------------------------------------------------------------

export type StatementHeaderInput = {
  periodLabel: string;
  periodStart: string;
  periodEnd: string;
  statementDate: string;
  reportedTotalCents: number;
  notes?: string | null;
};

export type UploadInput = { bytes: Uint8Array; originalName: string };

function headerData(input: StatementHeaderInput) {
  const periodLabel = clean(input.periodLabel, 120);
  need(periodLabel, "Enter the period label, e.g. “ADP FY2027 Q1”.");
  const periodStart = ymdField(input.periodStart, "the period start date");
  const periodEnd = ymdField(input.periodEnd, "the period end date");
  need(periodEnd >= periodStart, "The period ends before it starts.");
  need(Number.isSafeInteger(input.reportedTotalCents), "Enter the statement total.");
  return { periodLabel, periodStart, periodEnd, statementDate: ymdField(input.statementDate, "the statement date"), reportedTotalCents: input.reportedTotalCents, notes: clean(input.notes, 5000) };
}

const sha256 = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

/** Validates the file and puts it in the owner-only store. The caller records it (or removes it). */
async function storeStatementFile(file: UploadInput) {
  need(file.bytes.byteLength > 0, "The file is empty.");
  need(file.bytes.byteLength <= MAX_UPLOAD_BYTES, `Statements can be up to ${MAX_UPLOAD_LABEL}.`);
  const type = sniffType(file.bytes, { allowSpreadsheet: true, name: file.originalName });
  need(type && ["pdf", "csv", "xlsx"].includes(type.ext), `Upload the ADP statement as ${STATEMENT_FILE_TYPES}.`);
  const key = `owner_private/adp/statements/${randomBytes(16).toString("hex")}`;
  await storage.put(key, file.bytes);
  return { fileKey: key, fileName: file.originalName.replace(/[\r\n"]/g, "").slice(0, 200) || `statement.${type.ext}`, fileMime: type.mime, fileSize: file.bytes.byteLength, fileSha256: sha256(file.bytes), fileUploadedAt: new Date() };
}

/** sha256 dedupe: the same file can't be on two (non-deleted) statements. Serialized by a lock. */
async function assertNotDuplicate(tx: Tx, hash: string, exceptId?: string) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('adp-statement-file'))`;
  const dup = await tx.adpStatement.findFirst({ where: { fileSha256: hash, archivedAt: null, ...(exceptId ? { NOT: { id: exceptId } } : {}) }, select: { id: true, periodLabel: true } });
  if (dup) throw new DuplicateStatementFile(dup.id, dup.periodLabel);
}

export class DuplicateStatementFile extends ValidationError {
  constructor(public statementId: string, periodLabel: string) {
    super(`This file was already uploaded with the statement “${periodLabel}”. Nothing was saved.`);
  }
  get next() {
    return { href: `/owner/adp-revenue-share/statements/${this.statementId}`, label: "Open that statement" };
  }
}

async function withStoredFile<T>(file: UploadInput | null | undefined, fn: (stored: Awaited<ReturnType<typeof storeStatementFile>> | null) => Promise<T>): Promise<T> {
  const stored = file ? await storeStatementFile(file) : null;
  try {
    return await fn(stored);
  } catch (err) {
    if (stored) await storage.remove(stored.fileKey).catch(() => {});
    throw err;
  }
}

export async function createStatement(actor: Actor, input: StatementHeaderInput & { file?: UploadInput | null }) {
  await assertOwner(actor);
  const data = headerData(input);
  return withStoredFile(input.file, (stored) =>
    ownerTx(actor, async (tx) => {
      if (stored) await assertNotDuplicate(tx, stored.fileSha256);
      const s = await tx.adpStatement.create({ data: { ...data, ...(stored ?? {}), createdById: actor.id } });
      await audit(tx, actor.id, "adp.statement.created", "AdpStatement", s.id, { periodLabel: s.periodLabel, reportedTotalCents: s.reportedTotalCents, file: stored ? { name: stored.fileName, sha256: stored.fileSha256 } : null });
      return s;
    }),
  );
}

type LockedStatement = AdpStatement & { lines: AdpStatementLine[] };

/**
 * Loads and locks a statement for a change. A Final statement needs a revision note, and the
 * change is written to the append-only revision history (numbered under the row lock).
 */
async function lockStatement(tx: Tx, id: string): Promise<LockedStatement> {
  await tx.$executeRaw`SELECT 1 FROM "AdpStatement" WHERE "id" = ${id} FOR UPDATE`;
  const s = await tx.adpStatement.findUnique({ where: { id }, include: { lines: true } });
  need(s && !s.archivedAt, "Not found.");
  return s;
}

async function revise(tx: Tx, actor: Actor, s: AdpStatement, kind: string, reason: string | null, previous: unknown, updated: unknown) {
  const n = (await tx.adpStatementRevision.count({ where: { statementId: s.id } })) + 1;
  return tx.adpStatementRevision.create({
    data: { statementId: s.id, revisionNumber: n, kind, reason, previous: (previous ?? undefined) as object | undefined, updated: (updated ?? undefined) as object | undefined, editedById: actor.id, editedByName: actor.name },
  });
}

/** After Final, a change needs its revision note; before, the note is optional and isn't kept as a revision. */
function finalReason(s: AdpStatement, reason: string | null | undefined) {
  return s.status === "FINAL" ? reasonOf(reason, "a revision note (this statement is Final)") : null;
}

const headerSnap = (s: AdpStatement) => ({ periodLabel: s.periodLabel, periodStart: ymdOf(s.periodStart), periodEnd: ymdOf(s.periodEnd), statementDate: ymdOf(s.statementDate), reportedTotalCents: s.reportedTotalCents, notes: s.notes });
const lineSnap = (l: AdpStatementLine) => ({ id: l.id, type: l.type, amountCents: l.amountCents, referralId: l.referralId, clientId: l.clientId, adpName: l.adpName, note: l.note });

export async function updateStatement(actor: Actor, id: string, input: StatementHeaderInput & { reason?: string | null }) {
  await assertOwner(actor);
  const data = headerData(input);
  return ownerTx(actor, async (tx) => {
    const s = await lockStatement(tx, id);
    const reason = finalReason(s, input.reason);
    const updated = await tx.adpStatement.update({ where: { id }, data });
    const before = headerSnap(s);
    const after = headerSnap(updated);
    const changed = (Object.keys(before) as (keyof typeof before)[]).filter((k) => before[k] !== after[k]);
    need(changed.length > 0, "Nothing changed.");
    if (reason) await revise(tx, actor, s, "HEADER_EDITED", reason, Object.fromEntries(changed.map((k) => [k, before[k]])), Object.fromEntries(changed.map((k) => [k, after[k]])));
    await audit(tx, actor.id, "adp.statement.updated", "AdpStatement", id, { changed, final: s.status === "FINAL", reason });
    return updated;
  });
}

export async function attachStatementFile(actor: Actor, id: string, file: UploadInput, reason?: string | null) {
  await assertOwner(actor);
  return withStoredFile(file, (stored) =>
    ownerTx(actor, async (tx) => {
      const s = await lockStatement(tx, id);
      const why = finalReason(s, reason);
      await assertNotDuplicate(tx, stored!.fileSha256, id);
      const updated = await tx.adpStatement.update({ where: { id }, data: stored! });
      // The replaced file stays in the owner-only store (history), only the pointer moves.
      if (why) await revise(tx, actor, s, "FILE_ATTACHED", why, s.fileName ? { fileName: s.fileName, sha256: s.fileSha256 } : null, { fileName: stored!.fileName, sha256: stored!.fileSha256 });
      await audit(tx, actor.id, "adp.statement.file_attached", "AdpStatement", id, { fileName: stored!.fileName, sha256: stored!.fileSha256, replaced: s.fileName ?? null });
      return updated;
    }),
  );
}

export type LineInput = { type: string; amountCents: number; referralId?: string | null; clientId?: string | null; adpName?: string | null; note?: string | null };

function lineData(input: LineInput) {
  need((LINE_TYPES as readonly string[]).includes(input.type), "Choose the line type.");
  need(Number.isSafeInteger(input.amountCents) && input.amountCents !== 0, "Enter the line amount.");
  need(input.amountCents > 0 || input.type === "ADJUSTMENT", "Only an adjustment can be negative.");
  return { type: input.type as LineType, amountCents: input.amountCents, adpName: clean(input.adpName, 200), note: clean(input.note, 1000) };
}

export async function addLine(actor: Actor, statementId: string, input: LineInput & { reason?: string | null }) {
  await assertOwner(actor);
  const data = lineData(input);
  return ownerTx(actor, async (tx) => {
    const s = await lockStatement(tx, statementId);
    const reason = finalReason(s, input.reason);
    const [referralId, clientId] = [await activeReferral(tx, input.referralId), await activeClient(tx, input.clientId)];
    const sortOrder = Math.max(0, ...s.lines.map((l) => l.sortOrder)) + 1;
    const line = await tx.adpStatementLine.create({ data: { ...data, referralId, clientId, statementId, sortOrder, createdById: actor.id } });
    if (reason) await revise(tx, actor, s, "LINE_ADDED", reason, null, lineSnap(line));
    await audit(tx, actor.id, "adp.statement.line_added", "AdpStatement", statementId, { lineId: line.id, type: line.type, amountCents: line.amountCents, reason });
    return line;
  });
}

export async function updateLine(actor: Actor, lineId: string, input: LineInput & { reason?: string | null }) {
  await assertOwner(actor);
  const data = lineData(input);
  const found = await prisma.adpStatementLine.findUnique({ where: { id: lineId }, select: { statementId: true } });
  need(found, "Not found.");
  return ownerTx(actor, async (tx) => {
    const s = await lockStatement(tx, found.statementId);
    const before = s.lines.find((l) => l.id === lineId);
    need(before && !before.archivedAt, "Not found.");
    const reason = finalReason(s, input.reason);
    const [referralId, clientId] = [await activeReferral(tx, input.referralId), await activeClient(tx, input.clientId)];
    const after = await tx.adpStatementLine.update({ where: { id: lineId }, data: { ...data, referralId, clientId } });
    if (reason) await revise(tx, actor, s, "LINE_EDITED", reason, lineSnap(before), lineSnap(after));
    await audit(tx, actor.id, "adp.statement.line_updated", "AdpStatement", s.id, { lineId, before: lineSnap(before), after: lineSnap(after), reason });
    return after;
  });
}

/** Soft delete with a reason (the line stays, marked removed, and no longer counts). */
export async function removeLine(actor: Actor, lineId: string, reason: string) {
  await assertOwner(actor);
  const why = reasonOf(reason, "why you're removing this line");
  const found = await prisma.adpStatementLine.findUnique({ where: { id: lineId }, select: { statementId: true } });
  need(found, "Not found.");
  return ownerTx(actor, async (tx) => {
    const s = await lockStatement(tx, found.statementId);
    const line = s.lines.find((l) => l.id === lineId);
    need(line && !line.archivedAt, "Not found.");
    await tx.adpStatementLine.update({ where: { id: lineId }, data: { archivedAt: new Date(), archivedById: actor.id, archivedReason: why } });
    if (s.status === "FINAL") await revise(tx, actor, s, "LINE_REMOVED", why, lineSnap(line), null);
    await audit(tx, actor.id, "adp.statement.line_deleted", "AdpStatement", s.id, { lineId, reason: why, soft: true, amountCents: line.amountCents });
  });
}

export async function finalizeStatement(actor: Actor, id: string, opts: { acknowledgeMismatch?: boolean; note?: string | null } = {}) {
  return ownerTx(actor, async (tx) => {
    const s = await lockStatement(tx, id);
    need(s.status !== "FINAL", "This statement is already Final.");
    const check = statementTotalCheck(s.reportedTotalCents, s.lines);
    need(s.lines.some((l) => !l.archivedAt), "Add the statement's lines before marking it Final.");
    need(check.matches || opts.acknowledgeMismatch, "The statement total doesn't match its lines. Fix the lines, or tick the box to mark it Final anyway.");
    const updated = await tx.adpStatement.update({ where: { id }, data: { status: "FINAL", finalizedAt: new Date(), finalizedById: actor.id } });
    await revise(tx, actor, s, "FINALIZED", clean(opts.note, 2000), null, { ...headerSnap(s), linesCents: check.linesCents, lines: s.lines.filter((l) => !l.archivedAt).map(lineSnap), totalMatches: check.matches });
    await audit(tx, actor.id, "adp.statement.finalized", "AdpStatement", id, { linesCents: check.linesCents, reportedTotalCents: s.reportedTotalCents, totalMatches: check.matches });
    return updated;
  });
}

export async function archiveStatement(actor: Actor, id: string, reason: string) {
  await assertOwner(actor);
  const why = reasonOf(reason, "why you're deleting this statement");
  return ownerTx(actor, async (tx) => {
    const s = await lockStatement(tx, id);
    const matched = await tx.adpPayment.count({ where: { statementId: id, archivedAt: null } });
    need(matched === 0, "A payment is matched to this statement. Unmatch it on the payment first.");
    await tx.adpStatement.update({ where: { id }, data: { archivedAt: new Date(), archivedById: actor.id, archivedReason: why } });
    if (s.status === "FINAL") await revise(tx, actor, s, "ARCHIVED", why, null, null);
    await audit(tx, actor.id, "adp.statement.deleted", "AdpStatement", id, { reason: why, soft: true, status: s.status });
  });
}

const statementInclude = {
  lines: { include: { referral: { include: { client: { select: { id: true, displayName: true, businessName: true } } } }, client: { select: { id: true, displayName: true, businessName: true } } }, orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }] },
} satisfies Prisma.AdpStatementInclude;

export async function listStatements(actor: Actor, opts: { archived?: boolean } = {}) {
  await assertOwner(actor);
  const rows = await prisma.adpStatement.findMany({
    where: { archivedAt: opts.archived ? { not: null } : null },
    include: { lines: { where: { archivedAt: null }, select: { amountCents: true } }, payments: { where: { archivedAt: null }, select: { amountCents: true } } },
    orderBy: [{ statementDate: "desc" }, { createdAt: "desc" }],
  });
  return rows.map((s) => ({ ...s, check: statementTotalCheck(s.reportedTotalCents, s.lines), lineCount: s.lines.length, matchedCents: s.payments.reduce((t, p) => t + p.amountCents, 0) }));
}

export async function getStatement(actor: Actor, id: string) {
  await assertOwner(actor);
  const s = await prisma.adpStatement.findUnique({
    where: { id },
    include: {
      ...statementInclude,
      revisions: { orderBy: { revisionNumber: "asc" } },
      payments: { where: { archivedAt: null }, orderBy: { receivedOn: "asc" } },
      matchEvents: { orderBy: { at: "asc" }, include: { payment: { select: { id: true, receivedOn: true, amountCents: true, reference: true } } } },
    },
  });
  if (!s) return null;
  const names = await staffNames([s.createdById, s.finalizedById ?? "", s.archivedById ?? "", ...s.lines.map((l) => l.archivedById ?? "")]);
  return { ...s, check: statementTotalCheck(s.reportedTotalCents, s.lines), names };
}

export async function statementChoices(actor: Actor) {
  await assertOwner(actor);
  const rows = await prisma.adpStatement.findMany({ where: { archivedAt: null }, select: { id: true, periodLabel: true, statementDate: true, reportedTotalCents: true, status: true }, orderBy: { statementDate: "desc" } });
  return rows;
}

/** The uploaded statement, from the owner-only store. */
export async function readStatementFile(actor: Actor, id: string) {
  await assertOwner(actor);
  const s = await prisma.adpStatement.findUnique({ where: { id }, select: { fileKey: true, fileName: true, fileMime: true } });
  if (!s?.fileKey) return null;
  const bytes = await storage.get(s.fileKey);
  return bytes ? { bytes, name: s.fileName ?? "adp-statement", mime: s.fileMime ?? "application/octet-stream" } : null;
}

// --- CSV import of statement lines --------------------------------------------------------------

export const MAX_IMPORT_CSV_CHARS = 1_000_000;

function gridOf(csvText: string) {
  need(csvText.length > 0, "Choose a CSV file.");
  need(csvText.length <= MAX_IMPORT_CSV_CHARS, "That CSV is too large. Export one statement at a time.");
  const grid = parseCsv(csvText);
  need(grid.length > 0, "The CSV has no rows.");
  need(grid.length <= 2000, "That CSV has more than 2,000 rows. Export one statement at a time.");
  return grid;
}

const mapped = (grid: string[][], mapping: CsvMapping, excluded: number[]) => {
  try {
    return mapCsvRows(grid, mapping, excluded);
  } catch (e) {
    if (e instanceof AdpInputError) throw new ValidationError(e.message);
    throw e;
  }
};

/** What the CSV holds (headers and the first rows) and, once columns are chosen, what would be imported. Saves nothing. */
export async function previewLineImport(actor: Actor, input: { csvText: string; mapping?: CsvMapping | null; excluded?: number[] }) {
  await assertOwner(actor);
  const grid = gridOf(input.csvText);
  const headerRow = input.mapping?.headerRow ?? true;
  const headers = csvHeaders(grid, headerRow);
  const sample = grid.slice(headerRow ? 1 : 0, headerRow ? 6 : 5);
  const rows = input.mapping ? mapped(grid, input.mapping, input.excluded ?? []) : null;
  return { headers, sample, rows };
}

/**
 * Adds the confirmed rows as lines. The server re-reads the CSV with the owner's mapping (never
 * trusting amounts sent from the browser); `links` are the referrals the owner chose for each
 * name — nothing is matched automatically.
 */
export async function importLines(actor: Actor, statementId: string, input: { csvText: string; mapping: CsvMapping; excluded?: number[]; links?: Record<string, string>; reason?: string | null; fileName?: string | null }) {
  await assertOwner(actor);
  const grid = gridOf(input.csvText);
  const rows = mapped(grid, input.mapping, input.excluded ?? []).filter((r) => r.include);
  need(rows.length > 0, "No rows are ticked to import.");
  return ownerTx(actor, async (tx) => {
    const s = await lockStatement(tx, statementId);
    const reason = finalReason(s, input.reason);
    const links = new Map<string, string | null>();
    for (const [name, id] of Object.entries(input.links ?? {})) if (id) links.set(name.trim().toLowerCase(), await activeReferral(tx, id));
    let order = Math.max(0, ...s.lines.map((l) => l.sortOrder));
    const created = [];
    for (const r of rows) {
      created.push(
        await tx.adpStatementLine.create({
          data: { statementId, type: r.type!, amountCents: r.amountCents!, adpName: r.name || null, note: r.note || null, referralId: links.get(r.name.toLowerCase()) ?? null, sortOrder: ++order, createdById: actor.id },
        }),
      );
    }
    const totalCents = created.reduce((t, l) => t + l.amountCents, 0);
    if (reason) await revise(tx, actor, s, "LINES_IMPORTED", reason, null, { count: created.length, totalCents, lines: created.map(lineSnap) });
    await audit(tx, actor.id, "adp.statement.lines_imported", "AdpStatement", statementId, { count: created.length, totalCents, mapping: input.mapping, excludedRows: input.excluded ?? [], fileName: clean(input.fileName, 200), linked: created.filter((l) => l.referralId).length });
    return { count: created.length, totalCents };
  });
}

// --- Payments -----------------------------------------------------------------------------------

export type PaymentInput = { receivedOn: string; amountCents: number; method: string; methodOther?: string | null; periodsCovered?: string | null; reference?: string | null; note?: string | null };

function paymentData(input: PaymentInput) {
  need(Number.isSafeInteger(input.amountCents) && input.amountCents > 0, "Enter an amount greater than $0.");
  need((PAYMENT_METHODS as readonly string[]).includes(input.method), "Choose how ADP paid (ACH, check or other).");
  return {
    receivedOn: ymdField(input.receivedOn, "the date received"),
    amountCents: input.amountCents,
    method: input.method,
    methodOther: input.method === "OTHER" ? clean(input.methodOther, 120) : null,
    periodsCovered: clean(input.periodsCovered, 200),
    reference: clean(input.reference, 120),
    note: clean(input.note, 2000),
  };
}

async function matchTx(tx: Tx, actor: Actor, paymentId: string, statementId: string, note: string | null) {
  const s = await tx.adpStatement.findUnique({ where: { id: statementId }, select: { id: true, archivedAt: true, periodLabel: true } });
  need(s && !s.archivedAt, "That statement wasn't found.");
  await tx.adpPayment.update({ where: { id: paymentId }, data: { statementId, matchedAt: new Date(), matchedById: actor.id } });
  await tx.adpPaymentMatchEvent.create({ data: { paymentId, statementId, action: "MATCHED", note, actorId: actor.id, actorName: actor.name } });
  await audit(tx, actor.id, "adp.payment.matched", "AdpPayment", paymentId, { statementId, periodLabel: s.periodLabel, note });
}

export async function createPayment(actor: Actor, input: PaymentInput & { statementId?: string | null }) {
  await assertOwner(actor);
  const data = paymentData(input);
  return ownerTx(actor, async (tx) => {
    const p = await tx.adpPayment.create({ data: { ...data, createdById: actor.id } });
    await audit(tx, actor.id, "adp.payment.created", "AdpPayment", p.id, { amountCents: p.amountCents, method: p.method });
    if (input.statementId) await matchTx(tx, actor, p.id, input.statementId, "Linked when the payment was recorded");
    return p;
  });
}

export async function updatePayment(actor: Actor, id: string, input: PaymentInput) {
  await assertOwner(actor);
  const data = paymentData(input);
  return ownerTx(actor, async (tx) => {
    const before = await tx.adpPayment.findUnique({ where: { id } });
    need(before && !before.archivedAt, "Not found.");
    const p = await tx.adpPayment.update({ where: { id }, data });
    const changed = (["amountCents", "method", "methodOther", "periodsCovered", "reference", "note"] as const).filter((k) => before[k] !== p[k]);
    if (ymdOf(before.receivedOn) !== ymdOf(p.receivedOn)) changed.push("receivedOn" as never);
    await audit(tx, actor.id, "adp.payment.updated", "AdpPayment", id, { changed, before: { amountCents: before.amountCents, receivedOn: ymdOf(before.receivedOn) } });
    return p;
  });
}

/** "Match payment to statement": the owner's own decision, recorded in the payment's match history. */
export async function matchPayment(actor: Actor, paymentId: string, statementId: string, note?: string | null) {
  return ownerTx(actor, async (tx) => {
    await tx.$executeRaw`SELECT 1 FROM "AdpPayment" WHERE "id" = ${paymentId} FOR UPDATE`;
    const p = await tx.adpPayment.findUnique({ where: { id: paymentId } });
    need(p && !p.archivedAt, "Not found.");
    need(statementId, "Choose the statement this payment is for.");
    need(p.statementId !== statementId, "The payment is already matched to that statement.");
    if (p.statementId) {
      await tx.adpPaymentMatchEvent.create({ data: { paymentId, statementId: p.statementId, action: "UNMATCHED", note: "Moved to another statement", actorId: actor.id, actorName: actor.name } });
      await audit(tx, actor.id, "adp.payment.unmatched", "AdpPayment", paymentId, { statementId: p.statementId, reason: "Moved to another statement" });
    }
    await matchTx(tx, actor, paymentId, statementId, clean(note, 2000));
  });
}

export async function unmatchPayment(actor: Actor, paymentId: string, reason: string) {
  await assertOwner(actor);
  const why = reasonOf(reason, "why you're unmatching this payment");
  return ownerTx(actor, async (tx) => {
    await tx.$executeRaw`SELECT 1 FROM "AdpPayment" WHERE "id" = ${paymentId} FOR UPDATE`;
    const p = await tx.adpPayment.findUnique({ where: { id: paymentId } });
    need(p && !p.archivedAt, "Not found.");
    need(p.statementId, "This payment isn't matched to a statement.");
    await tx.adpPayment.update({ where: { id: paymentId }, data: { statementId: null, matchedAt: null, matchedById: null } });
    await tx.adpPaymentMatchEvent.create({ data: { paymentId, statementId: p.statementId, action: "UNMATCHED", note: why, actorId: actor.id, actorName: actor.name } });
    await audit(tx, actor.id, "adp.payment.unmatched", "AdpPayment", paymentId, { statementId: p.statementId, reason: why });
  });
}

export async function archivePayment(actor: Actor, id: string, reason: string) {
  await assertOwner(actor);
  const why = reasonOf(reason, "why you're deleting this payment");
  return ownerTx(actor, async (tx) => {
    const res = await tx.adpPayment.updateMany({ where: { id, archivedAt: null }, data: { archivedAt: new Date(), archivedById: actor.id, archivedReason: why } });
    need(res.count === 1, "Not found.");
    await audit(tx, actor.id, "adp.payment.deleted", "AdpPayment", id, { reason: why, soft: true });
  });
}

export async function listPayments(actor: Actor, opts: { archived?: boolean } = {}) {
  await assertOwner(actor);
  return prisma.adpPayment.findMany({
    where: { archivedAt: opts.archived ? { not: null } : null },
    include: { statement: { select: { id: true, periodLabel: true, archivedAt: true } } },
    orderBy: [{ receivedOn: "desc" }, { createdAt: "desc" }],
  });
}

export async function getPayment(actor: Actor, id: string) {
  await assertOwner(actor);
  const p = await prisma.adpPayment.findUnique({
    where: { id },
    include: { statement: { select: { id: true, periodLabel: true, reportedTotalCents: true, statementDate: true } }, matchEvents: { orderBy: { at: "asc" }, include: { statement: { select: { id: true, periodLabel: true } } } } },
  });
  if (!p) return null;
  const names = await staffNames([p.createdById, p.archivedById ?? ""]);
  return { ...p, names };
}

// --- Settings -----------------------------------------------------------------------------------

export async function fiscalNote(actor: Actor) {
  await assertOwner(actor);
  const s = await prisma.adpRevenueShareSettings.findUnique({ where: { id: "default" } });
  return { text: s?.fiscalNote ?? DEFAULT_FISCAL_NOTE, updatedAt: s?.updatedAt ?? null, isDefault: !s };
}

export async function saveFiscalNote(actor: Actor, text: string) {
  await assertOwner(actor);
  const v = text.trim().slice(0, 4000);
  need(v.length >= 3, "Enter the fiscal-quarter note.");
  return ownerTx(actor, async (tx) => {
    await tx.adpRevenueShareSettings.upsert({ where: { id: "default" }, create: { id: "default", fiscalNote: v, updatedById: actor.id }, update: { fiscalNote: v, updatedById: actor.id } });
    await audit(tx, actor.id, "adp.settings.fiscal_note_updated", "AdpRevenueShareSettings", "default", { length: v.length });
  });
}

// --- Reports & overview -------------------------------------------------------------------------

/** Every counted line (not removed, on a statement that isn't deleted) with its client and product. */
async function reportLines(): Promise<ReportLine[]> {
  const lines = await prisma.adpStatementLine.findMany({
    where: { archivedAt: null, statement: { archivedAt: null } },
    include: {
      statement: { select: { id: true, statementDate: true, periodEnd: true } },
      client: { select: { id: true, displayName: true, businessName: true } },
      referral: { include: { client: { select: { id: true, displayName: true, businessName: true } } } },
    },
  });
  return lines.map((l) => {
    const c = l.client ?? l.referral?.client ?? null;
    const [clientKey, clientLabel] = c
      ? [`client:${c.id}`, clientName(c)!]
      : l.referral?.prospectName
        ? [`prospect:${l.referral.id}`, `${l.referral.prospectName} (prospect)`]
        : l.adpName
          ? [`adp:${l.adpName.toLowerCase()}`, `${l.adpName} (not linked)`]
          : ["__none", "Not linked to a client or referral"];
    const [productKey, productLbl] = l.referral ? [`product:${l.referral.product}:${(l.referral.productOther ?? "").toLowerCase()}`, productLabel(l.referral.product, l.referral.productOther)] : ["__none", "Not linked to a referral"];
    return { amountCents: l.amountCents, type: l.type, statementId: l.statementId, statementDate: ymdOf(l.statement.statementDate), periodEnd: ymdOf(l.statement.periodEnd), clientKey, clientLabel, productKey, productLabel: productLbl };
  });
}

async function reportPayments() {
  const payments = await prisma.adpPayment.findMany({ where: { archivedAt: null }, select: { id: true, amountCents: true, receivedOn: true, statementId: true, statement: { select: { archivedAt: true } } } });
  return payments.map((p) => ({ id: p.id, amountCents: p.amountCents, receivedOn: ymdOf(p.receivedOn), statementId: p.statement?.archivedAt ? null : p.statementId }));
}

export async function adpReport(actor: Actor, opts: { year: number; month?: number | null; basis?: ReportBasis }) {
  await assertOwner(actor);
  const [lines, payments] = await Promise.all([reportLines(), reportPayments()]);
  const drafts = await prisma.adpStatement.count({ where: { archivedAt: null, status: "DRAFT" } });
  return { ...buildReport({ lines, payments, year: opts.year, month: opts.month ?? null, basis: opts.basis }), draftStatements: drafts };
}

export async function adpOverview(actor: Actor, today: string) {
  await assertOwner(actor);
  const year = Number(today.slice(0, 4));
  const [lines, payments, referrals, statements, unmatched] = await Promise.all([
    reportLines(),
    reportPayments(),
    prisma.adpReferral.groupBy({ by: ["status"], where: { archivedAt: null }, _count: true }),
    listStatements(actor),
    prisma.adpPayment.count({ where: { archivedAt: null, statementId: null } }),
  ]);
  const report = buildReport({ lines, payments, year });
  const quarter = adpFiscalQuarter(today);
  const previous = adpFiscalQuarter(ymdOf(new Date(dateOnly(quarter.start).getTime() - 86_400_000)));
  return {
    year,
    yearTotal: report.yearTotal,
    allTime: report.allTime,
    referralsByStatus: Object.fromEntries(referrals.map((r) => [r.status, r._count])) as Record<string, number>,
    referralCount: referrals.reduce((t, r) => t + r._count, 0),
    drafts: statements.filter((s) => s.status === "DRAFT"),
    mismatched: statements.filter((s) => !s.check.matches),
    statementCount: statements.length,
    unmatchedPayments: unmatched,
    quarter,
    previous,
  };
}
