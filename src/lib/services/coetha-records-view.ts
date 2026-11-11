import "server-only";
import { prisma } from "@/lib/prisma";
import type { Actor } from "@/lib/auth/actor";
import { assertLedger, ymdOf } from "./ledger";
import { scrub } from "./coetha";

/**
 * Coetha's complete, READ-ONLY view of one business's books for "Ask Coetha".
 *
 * - recordsSnapshot(): everything that is still open, in full: every waiting bank row with the
 *   draft already prepared for it, excluded rows, counts by account / month / status (with how
 *   each screen counts), the cash proof, the judgment groups, the comparison with the completed
 *   statements, the vendor-family postings awaiting review and the documents on file (titles
 *   only). Nothing is capped at 80; a business with more than SNAPSHOT_ROWS waiting rows gets the
 *   rest through the search tool, and the snapshot says so.
 * - searchBankTransactions() / searchJournalEntries(): the whole history, page by page, for the
 *   questions the snapshot doesn't answer (posted rows, earlier months, manual entries).
 *
 * Every function here only reads, and every query is limited to the one business (clientId).
 * Descriptions, memos, names and titles are de-identified with scrub() before they leave.
 */

export const SNAPSHOT_ROWS = 1000;
export const SEARCH_PAGE = 100;
const usd = (c: number) => Math.round(c) / 100;
const STATUS_LABEL: Record<string, string> = { UNREVIEWED: "waiting", POSTED: "posted", EXCLUDED: "excluded" };
const sourceOf = (model: string | null) => (model === "records" ? "completed statements" : model === "rules" ? "categorization rules" : "Coetha run");

export const COUNT_DEFINITIONS = {
  waiting: "A bank row is 'waiting' while it is neither posted to the books nor excluded (status UNREVIEWED).",
  ledgerWarning: "The ledger warning '… not yet reviewed' counts every waiting row on every bank and card account, at any date.",
  cashProof: "The Reconciliation page's cash proof counts waiting rows on ONE bank account dated on or before that account's latest statement closing date (asOf).",
  dashboard: "The business dashboard counts waiting rows on bank accounts dated on or before the end of the period it shows.",
  howToExplainDifferences: "Differences between these counts come from rows on other accounts or dated after a statement's closing date; use counts.waitingByAccountMonth to show which.",
};

export async function recordsSnapshot(actor: Actor, clientId: string) {
  await assertLedger(actor, clientId);
  const accounts = await prisma.ledgerAccount.findMany({ where: { clientId }, select: { id: true, code: true, name: true, subtype: true } });
  const code = new Map(accounts.map((a) => [a.id, a.code]));
  const label = (id: string | null | undefined) => (id ? code.get(id) ?? "?" : null);

  const [waitingTotal, waiting, excluded, byStatus, drafts] = await Promise.all([
    prisma.bankTransaction.count({ where: { clientId, status: "UNREVIEWED" } }),
    prisma.bankTransaction.findMany({ where: { clientId, status: "UNREVIEWED" }, orderBy: [{ date: "asc" }, { id: "asc" }], take: SNAPSHOT_ROWS, select: { id: true, date: true, amountCents: true, description: true, accountId: true, flag: true, flagNote: true } }),
    prisma.bankTransaction.findMany({ where: { clientId, status: "EXCLUDED" }, orderBy: [{ date: "asc" }, { id: "asc" }], take: 300, select: { date: true, amountCents: true, description: true, accountId: true, excludedReason: true } }),
    prisma.bankTransaction.groupBy({ by: ["accountId", "status"], where: { clientId }, _count: true, _sum: { amountCents: true } }),
    prisma.coethaProposal.findMany({ where: { clientId, status: "PROPOSED", kind: "CATEGORY", bankTransactionId: { not: null } }, orderBy: { createdAt: "desc" }, select: { bankTransactionId: true, model: true, confidence: true, reason: true, payload: true } }),
  ]);

  // The newest open draft for each row.
  const draftOf = new Map<string, (typeof drafts)[number]>();
  for (const d of drafts) if (!draftOf.has(d.bankTransactionId!)) draftOf.set(d.bankTransactionId!, d);

  const rows = waiting.map((t, i) => {
    const d = draftOf.get(t.id);
    const p = (d?.payload ?? {}) as { accountCode?: string; accountName?: string; needsJudgment?: boolean; referenceLine?: string };
    return {
      ref: `W${i + 1}`, date: ymdOf(t.date), amount: usd(t.amountCents), account: label(t.accountId), description: scrub(t.description),
      ...(t.flag ? { bankFlag: t.flag, ...(t.flagNote ? { flagNote: scrub(t.flagNote) } : {}) } : {}),
      draft: d ? {
        account: p.accountCode ? `${p.accountCode} ${scrub(p.accountName ?? "")}`.trim() : null,
        from: sourceOf(d.model),
        needsJudgment: !!p.needsJudgment || (d.reason ?? "").includes("same vendor family"),
        ...(p.referenceLine ? { statementLine: scrub(p.referenceLine) } : {}),
        confidence: d.confidence,
      } : null,
    };
  });

  // Waiting rows by account and month (all of them, not just the ones listed).
  const monthly = await prisma.$queryRaw<{ accountId: string; month: string; n: bigint; inc: bigint | null; outc: bigint | null }[]>`
    SELECT "accountId", to_char("date", 'YYYY-MM') AS month, COUNT(*) AS n,
      SUM(CASE WHEN "amountCents" > 0 THEN "amountCents" ELSE 0 END) AS inc,
      SUM(CASE WHEN "amountCents" < 0 THEN -"amountCents" ELSE 0 END) AS outc
    FROM "BankTransaction" WHERE "clientId" = ${clientId} AND status = 'UNREVIEWED'
    GROUP BY 1, 2 ORDER BY 1, 2`;

  const [proof, groups, compare, family, docs, routine] = await Promise.all([
    import("./cash-proof").then((m) => m.cashProof(actor, clientId)),
    import("./coetha-records").then((m) => m.judgmentGroups(clientId)),
    import("./coetha-records").then((m) => m.compareWithReference(actor, clientId)),
    import("./coetha-records").then((m) => m.familyPostingsToUndo(clientId)),
    prisma.document.findMany({ where: { clientId, category: "BOOKKEEPING", deletedAt: null }, orderBy: [{ year: "asc" }, { month: "asc" }, { createdAt: "asc" }], take: 400, select: { title: true, docType: true, year: true, month: true, createdAt: true, bookkeepingAccount: { select: { ledgerAccountId: true, nickname: true } } } }),
    import("./coetha-records").then((m) => m.routineSummary(clientId)),
  ]);

  // What the document reader already read (saved, so nothing has to be uploaded again), tied to
  // the waiting rows by W-reference so Coetha can prepare entries from it.
  const wRef = new Map(waiting.map((t, i) => [t.id, `W${i + 1}`]));
  // Checks still open (matched to a waiting row, or not matched) carry the detail; posted ones are counted.
  const findings = await prisma.coethaDocFinding.findMany({ where: { clientId }, orderBy: [{ createdAt: "asc" }, { page: "asc" }, { seq: "asc" }], take: 600, include: { job: { select: { name: true } } } });
  const fRows = await prisma.bankTransaction.findMany({ where: { clientId, id: { in: findings.map((f) => f.bankTransactionId).filter((x): x is string => !!x) } }, select: { id: true, status: true } });
  const fStatus = new Map(fRows.map((r) => [r.id, r.status]));
  const { groupOf, GROUP_LABEL } = await import("./coetha-reading");

  const { activeMemory } = await import("./coetha-memory");
  const memory = await activeMemory(clientId);
  return {
    rememberedForThisBusiness: memory.map((m) => ({ id: m.id, kind: m.kind, note: m.text, since: ymdOf(m.createdAt) })),
    definitions: COUNT_DEFINITIONS,
    counts: {
      waitingTotal,
      waitingListed: rows.length,
      ...(waitingTotal > rows.length ? { note: `Only the first ${rows.length} waiting rows are listed; use search_bank_transactions for the rest.` } : {}),
      byAccountAndStatus: byStatus.map((s) => ({ account: label(s.accountId), status: STATUS_LABEL[s.status] ?? s.status, count: s._count, net: usd(s._sum.amountCents ?? 0) })),
      waitingByAccountMonth: monthly.map((m) => ({ account: label(m.accountId), month: m.month, count: Number(m.n), in: usd(Number(m.inc ?? 0)), out: usd(Number(m.outc ?? 0)) })),
    },
    waitingRows: rows,
    excludedRows: excluded.map((t) => ({ date: ymdOf(t.date), amount: usd(t.amountCents), account: label(t.accountId), description: scrub(t.description), reason: t.excludedReason ? scrub(t.excludedReason) : null })),
    cashProof: proof.map((p) => ({
      account: scrub(p.account), statementDate: p.asOf, statementEnding: usd(p.statementEnding),
      waitingThroughStatementDate: { count: p.waiting.count, net: usd(p.waiting.cents) }, excluded: { count: p.excluded.count, net: usd(p.excluded.cents) },
      openingBalanceOnFile: p.openingNeeded == null ? null : usd(p.openingNeeded), openingPostedOnThisAccount: usd(p.openingPosted),
      otherEntriesOnThisAccount: usd(p.other), expectedBooks: usd(p.expected), books: usd(p.ledger), unexplainedDifference: usd(p.difference),
      statementCoverageGap: p.coverageGap == null ? null : usd(p.coverageGap), bankRowsPostedMoreThanOnce: p.duplicateRows,
    })),
    draftsReadyToApprove: routine.map((r) => ({ account: scrub(r.account), count: r.count, in: usd(r.inCents), out: usd(r.outCents) })),
    judgmentGroups: groups.map((g) => ({ statementLine: scrub(g.line), similarVendorOnly: g.family, count: g.ids.length, in: usd(g.inCents), out: usd(g.outCents) })),
    comparisonWithCompletedStatements: compare ? {
      months: compare.months.map((m) => ({ month: m.month, statementsNet: usd(m.statementsNet), booksNet: usd(m.booksNet), agrees: m.agrees })),
      linesThatDiffer: compare.rows.filter((r) => r.books && r.books.some((b, k) => b !== r.statements[k])).map((r) => ({
        line: scrub(r.label), needsJudgment: r.needsJudgment, booksMinusStatements: r.books!.map((b, k) => usd(b - r.statements[k])),
      })),
      linesNotYetInBooks: compare.rows.filter((r) => !r.books).map((r) => scrub(r.label)),
    } : null,
    vendorFamilyPostingsToReview: family.map((f) => ({ date: f.date, amount: usd(f.amountCents), description: scrub(f.description), accountNow: scrub(f.currentAccount), proposed: f.proposedAccount ? scrub(f.proposedAccount) : null, needsJudgment: f.needsJudgment })),
    readFromDocuments: findings
      .filter((f) => !f.bankTransactionId || wRef.has(f.bankTransactionId))
      .slice(0, 300)
      .map((f) => ({
        document: scrub(f.job.name, 60), page: f.page, kind: f.kind.toLowerCase(), checkNumber: f.checkNumber, date: f.date, payee: f.payee, amount: f.amountCents == null ? null : usd(f.amountCents),
        memo: f.memo,
        group: GROUP_LABEL[groupOf(f, f.bankTransactionId ? fStatus.get(f.bankTransactionId) : undefined)],
        bankRow: f.bankTransactionId ? wRef.get(f.bankTransactionId)! : "not matched",
        proposedAccount: f.proposedAccount, why: f.reason, evidenceNeeded: f.evidenceNeeded,
      })),
    readFromDocumentsAlreadyPosted: findings.filter((f) => f.bankTransactionId && !wRef.has(f.bankTransactionId)).length,
    documentsOnFile: docs.map((d) => ({
      title: scrub(d.title, 120), type: d.docType, period: d.year ? `${d.year}${d.month ? `-${String(d.month).padStart(2, "0")}` : ""}` : null,
      account: d.bookkeepingAccount?.ledgerAccountId ? label(d.bookkeepingAccount.ledgerAccountId) : d.bookkeepingAccount?.nickname ? scrub(d.bookkeepingAccount.nickname) : null,
      added: ymdOf(d.createdAt),
    })),
  };
}

// --- Searching the full history (read-only) -----------------------------------------------------

const dateOk = (s: unknown) => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

type Page = { total: number; offset?: number; returned?: number; next?: string; note?: string };
export type BankSearch = { status?: string; account?: string; from?: string; to?: string; text?: string; minAmount?: number; maxAmount?: number; offset?: number };

/** One page (SEARCH_PAGE) of this business's bank rows matching the filters, with the total. */
export async function searchBankTransactions(clientId: string, q: BankSearch): Promise<Page & { rows: { date: string; amount: number; account: string; description: string; status: string; postedTo?: string; reversed?: boolean; excludedReason?: string }[] }> {
  const status = q.status === "waiting" ? "UNREVIEWED" : q.status === "posted" ? "POSTED" : q.status === "excluded" ? "EXCLUDED" : undefined;
  const acct = q.account ? await prisma.ledgerAccount.findFirst({ where: { clientId, code: String(q.account).slice(0, 20) }, select: { id: true } }) : null;
  if (q.account && !acct) return { total: 0, rows: [], note: `No account with code ${String(q.account).slice(0, 20)}.` };
  const min = num(q.minAmount), max = num(q.maxAmount);
  const where = {
    clientId,
    ...(status ? { status } : {}),
    ...(acct ? { accountId: acct.id } : {}),
    ...(dateOk(q.from) || dateOk(q.to) ? { date: { ...(dateOk(q.from) ? { gte: new Date(`${q.from}T00:00:00Z`) } : {}), ...(dateOk(q.to) ? { lte: new Date(`${q.to}T00:00:00Z`) } : {}) } } : {}),
    ...(q.text ? { description: { contains: String(q.text).slice(0, 60), mode: "insensitive" as const } } : {}),
    // Amounts are matched by size (money in or out).
    ...(min !== undefined || max !== undefined ? { OR: [
      { amountCents: { ...(min !== undefined ? { gte: Math.round(min * 100) } : {}), ...(max !== undefined ? { lte: Math.round(max * 100) } : {}) } },
      { amountCents: { ...(min !== undefined ? { lte: -Math.round(min * 100) } : {}), ...(max !== undefined ? { gte: -Math.round(max * 100) } : {}) } },
    ] } : {}),
  };
  const offset = Math.max(0, Math.min(100_000, Math.floor(num(q.offset) ?? 0)));
  const [total, rows] = await Promise.all([
    prisma.bankTransaction.count({ where }),
    prisma.bankTransaction.findMany({ where, orderBy: [{ date: "asc" }, { id: "asc" }], skip: offset, take: SEARCH_PAGE, select: { date: true, amountCents: true, description: true, status: true, excludedReason: true, account: { select: { code: true } }, journalEntry: { select: { date: true, reversedBy: { select: { id: true } }, lines: { select: { accountId: true, account: { select: { code: true, name: true } } } } } }, accountId: true } }),
  ]);
  return {
    total, offset, returned: rows.length, ...(offset + rows.length < total ? { next: `Call again with offset ${offset + rows.length} for more.` } : {}),
    rows: rows.map((t) => ({
      date: ymdOf(t.date), amount: usd(t.amountCents), account: t.account.code, description: scrub(t.description), status: STATUS_LABEL[t.status] ?? t.status,
      ...(t.status === "POSTED" && t.journalEntry ? { postedTo: t.journalEntry.lines.filter((l) => l.accountId !== t.accountId).map((l) => `${l.account.code} ${scrub(l.account.name)}`).join(", "), reversed: !!t.journalEntry.reversedBy } : {}),
      ...(t.status === "EXCLUDED" && t.excludedReason ? { excludedReason: scrub(t.excludedReason) } : {}),
    })),
  };
}

export type EntrySearch = { from?: string; to?: string; account?: string; kind?: string; offset?: number };

/** One page of this business's journal entries (opening, manual, adjusting, reversals, bank postings). */
export async function searchJournalEntries(clientId: string, q: EntrySearch) {
  const acct = q.account ? await prisma.ledgerAccount.findFirst({ where: { clientId, code: String(q.account).slice(0, 20) }, select: { id: true } }) : null;
  if (q.account && !acct) return { total: 0, entries: [], note: `No account with code ${String(q.account).slice(0, 20)}.` };
  const kind = String(q.kind ?? "any");
  const where = {
    clientId,
    ...(acct ? { lines: { some: { accountId: acct.id } } } : {}),
    ...(dateOk(q.from) || dateOk(q.to) ? { date: { ...(dateOk(q.from) ? { gte: new Date(`${q.from}T00:00:00Z`) } : {}), ...(dateOk(q.to) ? { lte: new Date(`${q.to}T00:00:00Z`) } : {}) } } : {}),
    ...(kind === "opening" ? { source: "OPENING" } : kind === "bank" ? { source: "BANK" } : kind === "adjusting" ? { source: "ADJUSTMENT" } : kind === "manual" ? { source: "MANUAL" } : kind === "reversal" ? { reversalOfId: { not: null } } : {}),
  };
  const offset = Math.max(0, Math.min(100_000, Math.floor(num(q.offset) ?? 0)));
  const [total, entries] = await Promise.all([
    prisma.journalEntry.count({ where }),
    prisma.journalEntry.findMany({ where, orderBy: [{ date: "asc" }, { id: "asc" }], skip: offset, take: SEARCH_PAGE, select: { date: true, memo: true, source: true, reversalOfId: true, reversedBy: { select: { id: true } }, lines: { select: { debitCents: true, creditCents: true, account: { select: { code: true, name: true } } } } } }),
  ]);
  return {
    total, offset, returned: entries.length, ...(offset + entries.length < total ? { next: `Call again with offset ${offset + entries.length} for more.` } : {}),
    entries: entries.map((e) => ({
      date: ymdOf(e.date), memo: scrub(e.memo), source: e.source, adjusting: e.source === "ADJUSTMENT", isReversal: !!e.reversalOfId, reversed: !!e.reversedBy,
      lines: e.lines.map((l) => ({ account: `${l.account.code} ${scrub(l.account.name)}`, debit: usd(l.debitCents), credit: usd(l.creditCents) })),
    })),
  };
}

/** The read-only tools Coetha may call during one answer, bound to ONE business. */
export const RECORDS_TOOLS = [
  {
    name: "search_bank_transactions",
    description: "Search this business's bank and card rows across its whole history (waiting, posted or excluded). Returns up to 100 rows per call with the total; use offset for more. Read-only.",
    input_schema: {
      type: "object" as const,
      properties: {
        status: { type: "string", enum: ["waiting", "posted", "excluded", "any"] },
        account: { type: "string", description: "Bank or card account code, e.g. 1000" },
        from: { type: "string", description: "YYYY-MM-DD" },
        to: { type: "string", description: "YYYY-MM-DD" },
        text: { type: "string", description: "Words in the bank description" },
        minAmount: { type: "number", description: "Smallest amount in dollars (money in or out)" },
        maxAmount: { type: "number", description: "Largest amount in dollars (money in or out)" },
        offset: { type: "integer" },
      },
    },
  },
  {
    name: "search_journal_entries",
    description: "Search this business's journal entries (opening, bank postings, manual, adjusting, reversals) with their lines. Up to 100 per call; use offset for more. Read-only.",
    input_schema: {
      type: "object" as const,
      properties: {
        from: { type: "string", description: "YYYY-MM-DD" },
        to: { type: "string", description: "YYYY-MM-DD" },
        account: { type: "string", description: "Account code" },
        kind: { type: "string", enum: ["any", "opening", "bank", "manual", "adjusting", "reversal"] },
        offset: { type: "integer" },
      },
    },
  },
];

/** Runs one tool call for ONE business. Unknown tools are refused; nothing here writes. */
export async function runRecordsTool(clientId: string, name: string, input: unknown) {
  const q = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  if (name === "search_bank_transactions") return searchBankTransactions(clientId, q as BankSearch);
  if (name === "search_journal_entries") return searchJournalEntries(clientId, q as EntrySearch);
  return { error: `Unknown tool ${name}.` };
}
