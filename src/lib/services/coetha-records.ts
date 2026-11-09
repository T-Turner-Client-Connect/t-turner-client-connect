import "server-only";
import { prisma } from "@/lib/prisma";
import { audit } from "@/lib/audit";
import type { Actor } from "@/lib/auth/actor";
import { readPackageTable, type PackageLine } from "@/lib/statement-package";
import { pdfLines } from "@/lib/statement-pdf";
import { ValidationError } from "./clients";
import { assertLedger, assertLedgerWrite, bookOf, normDesc, ymdOf } from "./ledger";
import { staffUploadDocument } from "./documents";
import { assertCoethaAllowed } from "./coetha-opt-out";

/**
 * Coetha prepares a business's bookkeeping from its completed financial statements.
 *
 * 1. The completed package (PDF) is kept as a document and its monthly Profit & Loss lines are read
 *    exactly as printed (CoethaReference). Nothing in it is changed.
 * 2. "Prepare from completed statements": each bank transaction is grouped by vendor and statement
 *    month. A vendor whose monthly totals equal a package line in every month (or a few vendors
 *    that together equal it) is matched to that line. Only exact, cent-for-cent matches count.
 * 3. Every waiting transaction from a matched vendor gets a CATEGORY draft for the line's account
 *    (an account named exactly like the package line, added to the chart if missing), including
 *    months after the package (the same vendor's later transactions).
 * 4. Lines whose treatment needs judgment (owner draws and transfers, card payments, unidentified
 *    or unclassified items, disputes, loans) are matched but flagged: their drafts are low
 *    confidence and are never part of "approve everything that matches".
 * 5. Nothing is posted. Tabitha approves the drafts; the books are then compared with the package
 *    month by month.
 *
 * No AI call is needed for this; the matching is arithmetic on the business's own records.
 */

export const JUDGMENT = /owner|draw|personal|distribution|credit card|card payment|not identified|unidentified|unclassified|pending review|suspense|ask my accountant|disputed|loan|transfer/i;
const GENERIC_FIRST = new Set(["CARD", "POS", "ONLINE", "TRANSFER", "DEBIT", "PAYMENT", "DEPOSIT", "ACH", "WIRE", "ATM", "MOBILE", "PURCHASE", "WEB", "EXTERNAL", "INTERNET"]);
export const RECORDS_MODEL = "records";

/** The vendor a bank description belongs to: its first three words, without numbers or codes. */
export function vendorKey(description: string) {
  const words = normDesc(description).split(" ").filter((w) => w && !/\d/.test(w));
  if (words[0] === "CHECK" || /^CHECK\s*\d/i.test(description.trim())) return "CHECK";
  return words.slice(0, 3).join(" ") || "UNKNOWN";
}
const firstWord = (key: string) => key.split(" ")[0];

// --- 1. The completed statements ---------------------------------------------------------------

/** Keeps a completed financial package on file and reads its monthly P&L lines. */
export async function saveReferenceStatements(actor: Actor, clientId: string, file: { bytes: Uint8Array; originalName: string }) {
  await assertLedgerWrite(actor, clientId);
  await bookOf(clientId);
  if (!/\.pdf$/i.test(file.originalName)) throw new ValidationError("Choose the completed financial statements PDF.");
  const lines = await pdfLines(file.bytes);
  if (!lines?.length) throw new ValidationError("No text could be read from this PDF. Use the electronic (not scanned) financial statements.");
  const table = readPackageTable(lines);
  if (!table) throw new ValidationError("The monthly Profit & Loss table couldn't be found in this PDF. It needs a row of month columns (Jan Feb …) and a line for each account.");
  const doc = await staffUploadDocument(actor, { clientId, category: "BOOKKEEPING", title: `Completed financial statements — ${table.months[0]} to ${table.months[table.months.length - 1]}`.slice(0, 200), visibility: "STAFF_ONLY", bytes: file.bytes, originalName: file.originalName });
  const ref = await prisma.coethaReference.create({ data: { clientId, documentId: doc.id, title: file.originalName.slice(0, 200), months: table.months, lines: table.lines, createdById: actor.id } });
  await audit(prisma, { actorId: actor.id, action: "coetha.reference_saved", entityType: "CoethaReference", entityId: ref.id, clientId, details: { documentId: doc.id, months: table.months, lines: table.lines.length, skipped: table.skipped.length } });
  return { id: ref.id, months: table.months, lines: table.lines.length, skipped: table.skipped };
}

export async function latestReference(clientId: string) {
  const r = await prisma.coethaReference.findFirst({ where: { clientId }, orderBy: { createdAt: "desc" } });
  return r ? { ...r, months: r.months as string[], lines: r.lines as PackageLine[], mapping: (r.mapping ?? null) as Mapping | null } : null;
}

type Mapping = Record<string, { accountId: string; vendors: string[]; flag: string | null }>;

// --- 2. Statement months -----------------------------------------------------------------------

/** Each statement month's date range: from the day after last month's statement closing date to this month's (calendar months when unknown). */
async function statementMonths(clientId: string, ledgerAccountIds: string[], months: string[]) {
  const recs = await prisma.accountReconciliation.findMany({ where: { clientId, bookkeepingAccount: { ledgerAccountId: { in: ledgerAccountIds } } }, select: { year: true, month: true, statementClosingDate: true } });
  const closing = new Map<string, string>();
  for (const r of recs) if (r.statementClosingDate) closing.set(`${r.year}-${String(r.month).padStart(2, "0")}`, ymdOf(r.statementClosingDate));
  const calEnd = (m: string) => { const [y, mo] = m.split("-").map(Number); return ymdOf(new Date(Date.UTC(y, mo, 0))); };
  const prev = (m: string) => { const [y, mo] = m.split("-").map(Number); const d = new Date(Date.UTC(y, mo - 2, 1)); return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`; };
  const next = (d: string) => ymdOf(new Date(Date.parse(`${d}T00:00:00Z`) + 86_400_000));
  return months.map((m) => {
    const end = closing.get(m) ?? calEnd(m);
    const before = closing.get(prev(m)) ?? calEnd(prev(m));
    return { month: m, from: next(before), to: end };
  });
}

// --- 3. Matching --------------------------------------------------------------------------------

type Group = { key: string; dir: "IN" | "OUT"; vec: number[] };

/** Finds the vendors (one, or up to four together) whose monthly totals equal each package line in every month. */
export function matchVendors(lines: PackageLine[], groups: Group[], active?: boolean[]) {
  const n = lines[0]?.amounts.length ?? 0;
  // Only months that have bank activity on file are compared (a package can cover more months than the statements imported so far).
  const on = active ?? new Array(n).fill(true);
  if (!on.some(Boolean)) return new Map<number, string[]>();
  lines = lines.map((l) => ({ ...l, amounts: l.amounts.map((v, i) => (on[i] ? v : 0)) }));
  const used = new Set<string>();
  const result = new Map<number, string[]>();
  const eq = (a: number[], b: number[]) => a.every((v, i) => v === b[i]);
  const order = lines.map((l, i) => i).sort((a, b) => lines[b].amounts.filter((v) => v).length - lines[a].amounts.filter((v) => v).length);
  // Single vendors first.
  for (const i of order) {
    const l = lines[i];
    if (l.amounts.every((v) => !v)) continue;
    const dir = l.section === "INCOME" ? "IN" : "OUT";
    const g = groups.find((x) => !used.has(x.key + x.dir) && x.dir === dir && eq(x.vec, l.amounts));
    if (g) { result.set(i, [g.key]); used.add(g.key + g.dir); }
  }
  // Then up to four vendors together.
  for (const i of order) {
    if (result.has(i)) continue;
    const l = lines[i];
    if (l.amounts.every((v) => !v)) continue;
    const dir = l.section === "INCOME" ? "IN" : "OUT";
    const cand = groups.filter((x) => !used.has(x.key + x.dir) && x.dir === dir && x.vec.every((v, k) => v <= l.amounts[k]) && x.vec.some((v) => v > 0)).slice(0, 40);
    let found: Group[] | null = null;
    const search = (start: number, pick: Group[], sum: number[]) => {
      if (found) return;
      if (pick.length && eq(sum, l.amounts)) { found = [...pick]; return; }
      if (pick.length === 4) return;
      for (let k = start; k < cand.length; k++) {
        const s = sum.map((v, j) => v + cand[k].vec[j]);
        if (s.some((v, j) => v > l.amounts[j])) continue;
        search(k + 1, [...pick, cand[k]], s);
      }
    };
    search(0, [], new Array(n).fill(0));
    if (found) { result.set(i, (found as Group[]).map((g) => g.key)); for (const g of found as Group[]) used.add(g.key + g.dir); }
  }
  // Last, lines made of many small purchases (meals, supplies): up to eight of the vendors still unmatched.
  for (const i of order) {
    if (result.has(i)) continue;
    const l = lines[i];
    if (l.amounts.every((v) => !v)) continue;
    const dir = l.section === "INCOME" ? "IN" : "OUT";
    const cand = groups.filter((x) => !used.has(x.key + x.dir) && x.dir === dir && x.vec.every((v, k) => v <= l.amounts[k]) && x.vec.some((v) => v > 0)).slice(0, 24);
    let found: Group[] | null = null;
    let steps = 0;
    const search = (start: number, pick: Group[], sum: number[]) => {
      if (found || ++steps > 400_000) return;
      if (pick.length && eq(sum, l.amounts)) { found = [...pick]; return; }
      if (pick.length === 8) return;
      for (let k = start; k < cand.length; k++) {
        const s = sum.map((v, j) => v + cand[k].vec[j]);
        if (s.some((v, j) => v > l.amounts[j])) continue;
        search(k + 1, [...pick, cand[k]], s);
      }
    };
    search(0, [], new Array(n).fill(0));
    if (found) { result.set(i, (found as Group[]).map((g) => g.key)); for (const g of found as Group[]) used.add(g.key + g.dir); }
  }
  return result;
}

async function accountForLine(clientId: string, line: PackageLine) {
  const type = line.section === "INCOME" ? "INCOME" : "EXPENSE";
  const existing = await prisma.ledgerAccount.findFirst({ where: { clientId, type, name: { equals: line.label, mode: "insensitive" } } });
  if (existing) {
    if (!existing.active) await prisma.ledgerAccount.update({ where: { id: existing.id }, data: { active: true } });
    return { id: existing.id, created: false };
  }
  const used = new Set((await prisma.ledgerAccount.findMany({ where: { clientId }, select: { code: true } })).map((a) => a.code));
  const [from, to] = type === "INCOME" ? [4010, 4899] : [6010, 7899];
  let code: string | null = null;
  for (let c = from; c <= to; c += 10) if (!used.has(String(c))) { code = String(c); break; }
  if (!code) for (let c = from; c <= to; c++) if (!used.has(String(c))) { code = String(c); break; }
  if (!code) throw new ValidationError("No free account numbers left for the statement lines.");
  const a = await prisma.ledgerAccount.create({ data: { clientId, code, name: line.label.slice(0, 120), type, description: "Named exactly like the line in the completed financial statements." } });
  return { id: a.id, created: true };
}

/**
 * "Prepare from completed statements": drafts a category for every waiting transaction Coetha can
 * match to the completed package. Nothing is posted. Returns what was matched and what wasn't.
 */
export async function prepareFromRecords(actor: Actor, clientId: string) {
  await assertLedgerWrite(actor, clientId);
  await assertCoethaAllowed(clientId);
  const ref = await latestReference(clientId);
  if (!ref) throw new ValidationError("Add the business's completed financial statements first.");
  const banks = await prisma.ledgerAccount.findMany({ where: { clientId, subtype: { in: ["BANK", "CREDIT_CARD"] }, active: true }, select: { id: true } });
  const bankIds = banks.map((b) => b.id);
  if (!bankIds.length) throw new ValidationError("This business has no bank account in its books yet.");
  const periods = await statementMonths(clientId, bankIds, ref.months);
  const n = ref.months.length;
  const monthOf = (d: string) => periods.findIndex((p) => d >= p.from && d <= p.to);

  // Every bank transaction in the package's months (posted or not), by vendor and month.
  const all = await prisma.bankTransaction.findMany({ where: { clientId, accountId: { in: bankIds }, status: { not: "EXCLUDED" } }, select: { id: true, date: true, amountCents: true, description: true, status: true } });
  const groupsMap = new Map<string, Group>();
  for (const t of all) {
    const i = monthOf(ymdOf(t.date));
    if (i < 0) continue;
    const dir = t.amountCents > 0 ? "IN" : "OUT";
    const key = vendorKey(t.description);
    const g = groupsMap.get(key + dir) ?? { key, dir, vec: new Array(n).fill(0) };
    g.vec[i] += Math.abs(t.amountCents);
    groupsMap.set(key + dir, g);
  }
  const groups = [...groupsMap.values()];
  const active = ref.months.map((_, i) => groups.some((g) => g.vec[i] !== 0));
  const matched = matchVendors(ref.lines, groups, active);

  // Vendor (and, where unambiguous, its first word) → line.
  const lineOfVendor = new Map<string, number>();
  for (const [i, keys] of matched) for (const k of keys) lineOfVendor.set(`${ref.lines[i].section === "INCOME" ? "IN" : "OUT"}|${k}`, i);
  const byFirst = new Map<string, Set<number>>();
  for (const [vk, i] of lineOfVendor) { const [dir, k] = vk.split("|"); const f = `${dir}|${firstWord(k)}`; if (!GENERIC_FIRST.has(firstWord(k))) byFirst.set(f, (byFirst.get(f) ?? new Set()).add(i)); }

  const mapping: Mapping = {};
  const accountOf = new Map<number, string>();
  const created: string[] = [];
  for (const i of matched.keys()) {
    const a = await accountForLine(clientId, ref.lines[i]);
    accountOf.set(i, a.id);
    if (a.created) created.push(ref.lines[i].label);
    const flagged = JUDGMENT.test(ref.lines[i].label);
    mapping[String(i)] = { accountId: a.id, vendors: matched.get(i)!, flag: flagged ? "Needs your judgment: its accounting treatment should be confirmed (for example draw vs. expense, card payment vs. purchases, payee unknown)." : null };
  }

  // Drafts for waiting transactions.
  const waiting = all.filter((t) => t.status === "UNREVIEWED");
  const refMonths = `${ref.months[0]} to ${ref.months[n - 1]}`;
  const run = await prisma.coethaRun.create({ data: { clientId, trigger: "RECORDS", startedById: actor.id, model: RECORDS_MODEL, status: "RUNNING", transactions: waiting.length } });
  const drafts: { bankTransactionId: string; accountId: string; confidence: number; reason: string; flag: string | null; line: number }[] = [];
  const left: string[] = [];
  for (const t of waiting) {
    const dir = t.amountCents > 0 ? "IN" : "OUT";
    const key = vendorKey(t.description);
    const inRef = monthOf(ymdOf(t.date)) >= 0;
    let i = lineOfVendor.get(`${dir}|${key}`);
    let how = inRef ? `matches your completed statements (${refMonths}) to the cent` : `same vendor as in your completed statements (${refMonths})`;
    // The "same vendor family" shortcut only applies after the statement months; inside them every vendor was checked to the cent.
    if (i === undefined && !inRef) {
      const f = byFirst.get(`${dir}|${firstWord(key)}`);
      if (f && f.size === 1) { i = [...f][0]; how = `same vendor family as in your completed statements (${refMonths})`; }
    }
    if (i === undefined) { left.push(t.id); continue; }
    const flag = mapping[String(i)].flag;
    drafts.push({ bankTransactionId: t.id, accountId: accountOf.get(i)!, line: i, flag, confidence: flag ? 0.4 : inRef ? 0.99 : 0.9, reason: `“${ref.lines[i].label}” — ${how}.${flag ? ` ${flag}` : ""}` });
  }
  const accounts = new Map((await prisma.ledgerAccount.findMany({ where: { id: { in: [...new Set(drafts.map((d) => d.accountId))] } }, select: { id: true, code: true, name: true } })).map((a) => [a.id, a]));
  const txById = new Map(waiting.map((t) => [t.id, t]));
  const bankName = new Map((await prisma.ledgerAccount.findMany({ where: { id: { in: bankIds } }, select: { id: true, name: true } })).map((a) => [a.id, a.name]));
  const txAcct = new Map((await prisma.bankTransaction.findMany({ where: { id: { in: drafts.map((d) => d.bankTransactionId) } }, select: { id: true, accountId: true } })).map((t) => [t.id, t.accountId]));

  await prisma.$transaction(async (tx) => {
    // Earlier open category drafts for these transactions are replaced.
    await tx.coethaProposal.updateMany({ where: { clientId, status: "PROPOSED", kind: "CATEGORY", bankTransactionId: { in: drafts.map((d) => d.bankTransactionId) } }, data: { status: "SUPERSEDED" } });
    if (drafts.length) {
      await tx.coethaProposal.createMany({
        data: drafts.map((d) => {
          const t = txById.get(d.bankTransactionId)!;
          const a = accounts.get(d.accountId)!;
          return { clientId, runId: run.id, kind: "CATEGORY", bankTransactionId: d.bankTransactionId, confidence: d.confidence, reason: d.reason.slice(0, 300), model: RECORDS_MODEL, inputHash: ref.id,
            payload: { bankTransactionId: t.id, date: ymdOf(t.date), amountCents: t.amountCents, description: t.description, bankAccountName: bankName.get(txAcct.get(t.id) ?? "") ?? "Bank", accountId: a.id, accountCode: a.code, accountName: a.name, fromRecords: true, needsJudgment: !!d.flag, referenceLine: ref.lines[d.line].label } };
        }),
      });
    }
    await tx.coethaReference.update({ where: { id: ref.id }, data: { mapping } });
    const unmatchedLines = ref.lines.map((l, i) => (matched.has(i) || l.amounts.every((v, k) => !v || !active[k]) ? null : l.label)).filter((x): x is string => !!x);
    await tx.coethaRun.update({ where: { id: run.id }, data: { status: "OK", finishedAt: new Date(), proposals: drafts.length, error: diagnostic(waiting.length, drafts.length, drafts.filter((d) => d.flag).length, left.length, unmatchedLines.length) } });
  });
  const unmatchedLines = ref.lines.map((l, i) => (matched.has(i) || l.amounts.every((v, k) => !v || !active[k]) ? null : l.label)).filter((x): x is string => !!x);
  await audit(prisma, { actorId: actor.id, action: "coetha.prepared_from_records", entityType: "CoethaRun", entityId: run.id, clientId, details: { referenceId: ref.id, waiting: waiting.length, drafts: drafts.length, needsJudgment: drafts.filter((d) => d.flag).length, notMatched: left.length, accountsAdded: created.length, linesNotMatched: unmatchedLines.length } });
  return { runId: run.id, waiting: waiting.length, drafts: drafts.length, needsJudgment: drafts.filter((d) => d.flag).length, notMatched: left.length, accountsAdded: created, linesMatched: matched.size, linesNotMatched: unmatchedLines };
}

/** Counts only: safe to keep and show (no descriptions, names or amounts). */
function diagnostic(waiting: number, drafts: number, judgment: number, left: number, linesLeft: number) {
  return `Prepared from completed statements: ${drafts} of ${waiting} waiting transactions drafted (${judgment} need your judgment); ${left} not matched to the statements${linesLeft ? `; ${linesLeft} statement line${linesLeft === 1 ? "" : "s"} not explained by the bank activity` : ""}.`.slice(0, 300);
}

// --- 4. Approve everything that matches ----------------------------------------------------------

/** The open drafts Coetha prepared from the completed statements that need no judgment. */
export async function matchingDraftIds(clientId: string) {
  const rows = await prisma.coethaProposal.findMany({ where: { clientId, status: "PROPOSED", kind: "CATEGORY", model: RECORDS_MODEL }, select: { id: true, payload: true } });
  return rows.filter((r) => !(r.payload as { needsJudgment?: boolean }).needsJudgment).map((r) => r.id);
}

// --- 5. Compare with the completed statements ------------------------------------------------------

export async function compareWithReference(actor: Actor, clientId: string) {
  await assertLedger(actor, clientId);
  const ref = await latestReference(clientId);
  if (!ref) return null;
  const banks = await prisma.ledgerAccount.findMany({ where: { clientId, subtype: { in: ["BANK", "CREDIT_CARD"] } }, select: { id: true } });
  const periods = await statementMonths(clientId, banks.map((b) => b.id), ref.months);
  const mapping = ref.mapping ?? {};
  const rows = await Promise.all(ref.lines.map(async (l, i) => {
    const m = mapping[String(i)];
    const books = m ? await Promise.all(periods.map(async (p) => {
      const s = await prisma.journalLine.aggregate({ where: { accountId: m.accountId, entry: { clientId, date: { gte: new Date(`${p.from}T00:00:00Z`), lte: new Date(`${p.to}T00:00:00Z`) } } }, _sum: { debitCents: true, creditCents: true } });
      const dr = s._sum.debitCents ?? 0, cr = s._sum.creditCents ?? 0;
      return l.section === "INCOME" ? cr - dr : dr - cr;
    })) : null;
    return { label: l.label, section: l.section, statements: l.amounts, books, mapped: !!m, needsJudgment: !!m?.flag };
  }));
  const months = ref.months.map((month, k) => {
    const st = rows.reduce((t, r) => t + (r.section === "INCOME" ? 1 : -1) * r.statements[k], 0);
    const bk = rows.reduce((t, r) => t + (r.books ? (r.section === "INCOME" ? 1 : -1) * r.books[k] : 0), 0);
    return { month, statementsNet: st, booksNet: bk, agrees: st === bk && rows.every((r) => !r.books || r.books[k] === r.statements[k]) };
  });
  return { title: ref.title, createdAt: ref.createdAt, months, rows };
}

// --- 6. One-step decisions for Tabitha -------------------------------------------------------------

/** The open drafts flagged "Needs your judgment" (each drafted the way the completed statements treated it). */
export async function judgmentDraftIds(clientId: string) {
  const rows = await prisma.coethaProposal.findMany({ where: { clientId, status: "PROPOSED", kind: "CATEGORY", model: RECORDS_MODEL }, select: { id: true, payload: true } });
  return rows.filter((r) => (r.payload as { needsJudgment?: boolean }).needsJudgment).map((r) => r.id);
}

/**
 * Transactions an earlier version posted inside the statement months by the "same vendor family"
 * shortcut (which now only applies after those months). Their entries can be reversed so the rows
 * go back to waiting and are prepared again correctly.
 */
export async function familyPostingsToUndo(clientId: string) {
  const ref = await latestReference(clientId);
  if (!ref) return [];
  const banks = await prisma.ledgerAccount.findMany({ where: { clientId, subtype: { in: ["BANK", "CREDIT_CARD"] } }, select: { id: true } });
  const periods = await statementMonths(clientId, banks.map((b) => b.id), ref.months);
  const first = periods[0]?.from, last = periods[periods.length - 1]?.to;
  const rows = await prisma.coethaProposal.findMany({ where: { clientId, status: "APPROVED", kind: "CATEGORY", model: RECORDS_MODEL, reason: { contains: "same vendor family" }, journalEntryId: { not: null } }, select: { id: true, journalEntryId: true, payload: true } });
  const ids = rows.filter((r) => { const d = (r.payload as { date?: string }).date ?? ""; return first && d >= first && d <= last; }).map((r) => r.journalEntryId!);
  if (!ids.length) return [];
  const live = await prisma.journalEntry.findMany({ where: { clientId, id: { in: ids }, reversedBy: null }, select: { id: true, date: true } });
  return live.map((e) => ({ entryId: e.id, date: ymdOf(e.date) }));
}

export async function undoFamilyPostings(actor: Actor, clientId: string) {
  const { assertCanApproveCoethaWork } = await import("@/lib/auth/permissions");
  await assertCanApproveCoethaWork(actor);
  await assertLedgerWrite(actor, clientId);
  const { reverseEntry } = await import("./ledger");
  const list = await familyPostingsToUndo(clientId);
  let done = 0;
  for (const e of list) {
    await reverseEntry(actor, clientId, e.entryId, { date: e.date, reason: "Coetha matched this by vendor family inside the statement months; reversed so it is prepared again correctly." });
    done++;
  }
  await audit(prisma, { actorId: actor.id, action: "coetha.family_postings_undone", entityType: "LedgerBook", entityId: clientId, clientId, details: { reversed: done } });
  return done;
}
