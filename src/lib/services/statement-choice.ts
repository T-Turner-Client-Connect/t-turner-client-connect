import "server-only";
import { prisma } from "@/lib/prisma";
import { audit } from "@/lib/audit";
import { parseStatementLines, pdfLines, type StatementParse } from "@/lib/statement-pdf";
import { readDocumentBytes } from "./documents";
import { prepareReconciliation, statementWindow } from "./bank-accounts";
import { STATEMENT_DOC_TYPES } from "./client-request-scope";
import { ymdOf } from "./ledger";

/**
 * Which statement on file is THE statement for one account and month.
 *
 * Every statement this business has around that month is considered, whatever account or bank name
 * it was filed under, newest first:
 *  - a file with no readable text is skipped (a later or earlier readable copy is used instead);
 *  - the account number printed on the statement must end in this account's last 4. A statement
 *    showing a different account number is skipped, whatever bank name it carries or was filed
 *    under; when no account number can be read, only a file already filed under this account counts;
 *  - its period must be this month's statement period;
 *  - one read to the cent (beginning + every transaction = ending) wins over one that isn't.
 * Nothing is deleted. A verified statement filed under the wrong account or month is re-filed under
 * the right one (recorded in the audit log, with the account number that proved it).
 */

export type ChosenStatement = {
  id: string;
  title: string;
  /** Read to the cent by the PDF reader. */
  exact: boolean;
  /** How the account was confirmed. */
  accountProof: "NUMBER" | "FILED_UNDER";
  parsed: StatementParse | null;
};
export type StatementChoice = { chosen: ChosenStatement | null; skipped: { title: string; why: string }[] };

const DAY = 86_400_000;
const shift = (ymd: string, days: number) => ymdOf(new Date(new Date(`${ymd}T00:00:00Z`).getTime() + days * DAY));

/** The last 4 digits of every account number printed on a statement (masked or in full). */
export function accountNumbersIn(lines: string[]): Set<string> {
  const out = new Set<string>();
  const text = lines.slice(0, 400).join("\n");
  const patterns = [
    /(?<![A-Za-z])[x*•●X…]{1,16}[\s-]?(\d{4})(?![\d.,])/g, // ****4542, XXXX-4542, x4542, …4542 (not "Box 1234")
    /\bending(?:\s+(?:in|with))?\s*[:#-]?\s*(\d{4})\b/gi, // ending in / ending with 4542
    /\blast\s*(?:4|four)(?:\s*digits)?(?:\s*of\s*(?:the\s*)?account)?\s*[:#-]?\s*(\d{4})\b/gi, // Last 4: 4542
    /\b(?:account|acct)\.?\s*(?:number|no\.?|#)?\s*[:#]?\s*([\d][\d\s-]{2,24}\d)\b/gi, // Account Number: 1234 5678 4542
  ];
  for (const re of patterns) {
    for (const m of text.matchAll(re)) {
      const digits = m[1].replace(/\D/g, "");
      if (digits.length >= 4) out.add(digits.slice(-4));
    }
  }
  return out;
}

/** The bank's name as printed at the top of its statement, when there is one. */
export function bankNameIn(lines: string[]): string | null {
  for (const l of lines.slice(0, 25)) {
    const t = l.trim();
    if (t.length > 3 && t.length < 60 && /\b(bank|credit union|bancorp|bancshares|savings|trust)\b/i.test(t) && !/balance|statement|account|period|page|\d{3}/i.test(t)) return t.slice(0, 80);
  }
  return null;
}

export async function chooseStatement(clientId: string, registryId: string, year: number, month: number): Promise<StatementChoice> {
  const r = await prisma.bookkeepingAccount.findFirst({ where: { id: registryId, clientId } });
  if (!r) return { chosen: null, skipped: [] };
  const liability = ["CREDIT_CARD", "LINE_OF_CREDIT", "LOAN"].includes(r.accountType);
  const w = statementWindow(year, month, r.statementDay);
  const docs = await prisma.document.findMany({
    where: {
      clientId, deletedAt: null,
      // Filed as a statement, or a bookkeeping file sent in without a type (e.g. through Ask Coetha);
      // the latter only counts below if it reads like a statement.
      AND: [{ OR: [{ docType: { in: STATEMENT_DOC_TYPES } }, { docType: null, category: "BOOKKEEPING" }] }],
      OR: [
        { year, month },
        // Filed under the month it arrived in (the statement period is checked below).
        { year: month === 12 ? year + 1 : year, month: month === 12 ? 1 : month + 1 },
        { periodEnd: { gte: new Date(`${shift(w.start, -5)}T00:00:00Z`), lte: new Date(`${shift(w.end, 5)}T00:00:00Z`) } },
        // Uploaded around the month's close without a period recorded.
        { year: null, createdAt: { gte: new Date(`${w.start}T00:00:00Z`), lte: new Date(`${shift(w.end, 75)}T00:00:00Z`) } },
      ],
    },
    orderBy: { createdAt: "desc" },
    take: 30,
    include: { file: true },
  });
  const skipped: StatementChoice["skipped"] = [];
  // Other accounts' numbers, and whether this is the business's only account of its kind.
  const siblings = await prisma.bookkeepingAccount.findMany({ where: { clientId, id: { not: r.id }, parentAccountId: null }, select: { last4: true, accountType: true, active: true } });
  const takenLast4 = new Set(siblings.map((x) => x.last4).filter((x): x is string => !!x));
  const onlyAccount = !siblings.some((x) => x.active && ["CREDIT_CARD", "LINE_OF_CREDIT", "LOAN"].includes(x.accountType) === liability);
  let fallback: (ChosenStatement & { doc: (typeof docs)[number]; filedOk: boolean; learned: string | null; bank: string | null; text: string }) | null = null;
  for (const d of docs) {
    const bytes = d.file ? await readDocumentBytes(d.file).catch(() => null) : null;
    const lines = bytes ? await pdfLines(bytes).catch(() => null) : null;
    if (!lines?.length) { skipped.push({ title: d.title, why: "no readable text (skipped; the original file is kept)" }); continue; }
    const numbers = accountNumbersIn(lines);
    let proof: ChosenStatement["accountProof"];
    let learned: string | null = null;
    if (r.last4 && numbers.has(r.last4)) proof = "NUMBER";
    else if (r.last4 && numbers.size) { if (d.bookkeepingAccountId === r.id) skipped.push({ title: d.title, why: `its account number ends in ${[...numbers].join(" / ")}, not ${r.last4}` }); continue; }
    else if (!r.last4 && numbers.size === 1 && !takenLast4.has([...numbers][0]) && (d.bookkeepingAccountId === r.id || onlyAccount)) {
      // The account was registered without its number: the statement's own account number is used and recorded.
      proof = "NUMBER"; learned = [...numbers][0];
    }
    else if (d.bookkeepingAccountId === r.id) proof = "FILED_UNDER";
    else continue; // filed elsewhere and no account number to prove it is this account's
    const parsed = parseStatementLines(lines, { liability });
    const end = parsed.summary.periodEnd;
    const untyped = !d.docType;
    if (untyped && (proof !== "NUMBER" || !end || parsed.summary.endingCents == null)) continue; // not shown to be a statement
    if (end ? end < shift(w.start, -5) || end > shift(w.end, 5) : !(d.year === year && d.month === month)) {
      if (d.bookkeepingAccountId === r.id || proof === "NUMBER") skipped.push({ title: d.title, why: end ? `it covers the period ending ${end}` : "its statement period couldn't be read" });
      continue;
    }
    const pick = { id: d.id, title: d.title, exact: parsed.check.ok, accountProof: proof, parsed, doc: d, filedOk: !untyped && d.bookkeepingAccountId === r.id && d.year === year && d.month === month, learned, bank: bankNameIn(lines), text: lines.slice(0, 60).join(" ").toLowerCase() };
    if (parsed.check.ok) { fallback = pick; break; }
    if (!fallback) fallback = pick;
  }
  if (!fallback) return { chosen: null, skipped };
  const last4 = r.last4 ?? fallback.learned;
  // Only a statement read to the cent corrects the account's details: its number, and the bank name
  // when the one on file (e.g. "Chase") doesn't appear anywhere on the bank's own statement.
  // (Read to the cent, or already filed under this very account.)
  if (fallback.learned && (fallback.exact || fallback.doc.bookkeepingAccountId === r.id)) {
    const named = r.institution ? new RegExp(`\\b${r.institution.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`) : null;
    const wrongBank = !!fallback.bank && !!named && !named.test(fallback.text);
    const data = { last4: fallback.learned, ...(wrongBank ? { institution: fallback.bank! } : {}) };
    await prisma.bookkeepingAccount.update({ where: { id: r.id }, data });
    await audit(prisma, { actorId: null, action: "bookkeeping.account_details_corrected", entityType: "BookkeepingAccount", entityId: r.id, clientId, details: { before: { last4: r.last4, institution: r.institution }, after: data, documentId: fallback.doc.id, proof: "account number and bank name printed on the statement, read to the cent" } });
  }
  // A statement proven by its account number but filed under another account or month is re-filed.
  if (!fallback.filedOk && fallback.accountProof === "NUMBER" && (!fallback.learned || fallback.exact || fallback.doc.bookkeepingAccountId === r.id)) {
    await prisma.document.update({ where: { id: fallback.doc.id }, data: { bookkeepingAccountId: r.id, manualBankAccountId: null, year, month, ...(fallback.doc.docType ? {} : { docType: liability ? "CARD_STATEMENT" : "BANK_STATEMENT" }) } });
    await audit(prisma, { actorId: null, action: "bookkeeping.statement_refiled", entityType: "Document", entityId: fallback.doc.id, clientId, details: { from: { bookkeepingAccountId: fallback.doc.bookkeepingAccountId, year: fallback.doc.year, month: fallback.doc.month }, to: { bookkeepingAccountId: r.id, year, month }, proof: `account number ending ${last4} printed on the statement` } });
  }
  const { doc: _doc, filedOk: _f, learned: _l, bank: _b, text: _t, ...chosen } = fallback;
  return { chosen, skipped };
}

/**
 * Hourly (with the statement drafts): for every active bookkeeping client's bank and card accounts,
 * the last two closed months get their statement linked when it isn't yet — the account has no
 * number on file, or the month's reconciliation has no statement attached, or the one attached has
 * no readable text. The readable statement proven by its account number is linked (and the account's
 * number and real bank name recorded, the file re-filed). Accounting entries are never changed; an
 * approved reconciliation only gets the right statement attached. Everything is in the audit log.
 */
export async function linkStatementsOnFile(opts: { budgetMs?: number; today?: string } = {}) {
  const started = Date.now();
  const budget = opts.budgetMs ?? 8000;
  const today = opts.today ?? new Date().toISOString().slice(0, 10);
  const [ty, tm] = today.split("-").map(Number);
  const months = [1, 2].map((back) => { const d = new Date(Date.UTC(ty, tm - 1 - back, 1)); return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1 }; });
  const accounts = await prisma.bookkeepingAccount.findMany({ where: { active: true, parentAccountId: null, client: { bookkeepingProfile: { active: true } } }, select: { id: true, clientId: true, last4: true } });
  const linked: { clientId: string; accountId: string; month: string; documentId: string }[] = [];
  // Why accounts were left alone (counts only; no client data in the logs).
  const skipped: Record<string, number> = {};
  const skip = (why: string) => { skipped[why] = (skipped[why] ?? 0) + 1; };
  let more = false;
  for (const a of accounts) {
    for (const { y, m } of months) {
      if (Date.now() - started > budget) { more = true; break; }
      const rec = await prisma.accountReconciliation.findUnique({ where: { bookkeepingAccountId_year_month: { bookkeepingAccountId: a.id, year: y, month: m } } });
      let needs = !a.last4 || !rec?.statementDocumentId;
      if (!needs && rec?.statementDocumentId) {
        const cur = await prisma.document.findFirst({ where: { id: rec.statementDocumentId, deletedAt: null }, include: { file: true } });
        const bytes = cur?.file ? await readDocumentBytes(cur.file).catch(() => null) : null;
        needs = !(bytes && (await pdfLines(bytes).catch(() => null))?.length);
      }
      if (!needs) { skip("alreadyLinked"); continue; }
      const { chosen, skipped: passed } = await chooseStatement(a.clientId, a.id, y, m);
      if (!chosen) { skip(passed.length ? "noUsableStatement" : "noStatementOnFile"); continue; }
      // Proven by the account number printed on it, or (an account with no number on file) a complete,
      // readable statement our office already filed under this account.
      // A readable statement our office filed under this account and month counts for an account with
      // no number on file (there's nothing to check it against); its layout needn't be recognized.
      if (chosen.accountProof !== "NUMBER" && !(chosen.accountProof === "FILED_UNDER" && !a.last4)) {
        // Which case, for the log (no client data): the account has a number the statement doesn't show.
        skip(a.last4 ? "noAccountNumberOnStatement:accountHasNumber" : "noAccountNumberOnStatement");
        continue;
      }
      if (!chosen.exact) skip(chosen.parsed?.summary.periodEnd ? "linkedNotReadToTheCent" : "linkedLayoutNotRecognized");
      if (rec?.statementDocumentId === chosen.id) { skip("alreadyLinked"); continue; }
      // No reconciliation for the month yet: prepared now with this statement (nothing is posted or approved).
      const target = rec ?? (await prepareReconciliation(a.clientId, a.id, y, m, { statementDocumentId: chosen.id }));
      if (!target) { skip("accountDoesNotReconcile"); continue; }
      if (target.statementDocumentId !== chosen.id) await prisma.accountReconciliation.update({ where: { id: target.id }, data: { statementDocumentId: chosen.id, statementStatus: "RECEIVED" } });
      await audit(prisma, { actorId: null, action: "bookkeeping.statement_linked", entityType: "AccountReconciliation", entityId: target.id, clientId: a.clientId, details: { month: `${y}-${String(m).padStart(2, "0")}`, from: rec?.statementDocumentId ?? null, to: chosen.id, readToTheCent: chosen.exact, reconciliationStatus: target.status } });
      linked.push({ clientId: a.clientId, accountId: a.id, month: `${y}-${String(m).padStart(2, "0")}`, documentId: chosen.id });
    }
    if (more) break;
  }
  return { linked, skipped, more };
}
