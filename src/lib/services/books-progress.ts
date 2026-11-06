import "server-only";
import { prisma } from "@/lib/prisma";
import { CHECKLIST } from "./bookkeeping-clients";
import { reconciles, statementWindow } from "./bank-accounts";
import { clientFacingRequestWhere, officeStatementWhere, STATEMENT_DOC_TYPES } from "./client-request-scope";
import { todayCentral, toDate, ymdOf } from "./ledger";

/**
 * The client's Bookkeeping Progress Tracker: five stages for one period of the engagement — a
 * month for monthly clients, a quarter for quarterly clients (BookkeepingProfile.frequency) — read
 * from the office's own records only: what the client was asked for and sent, the statements our
 * office filed, the checklist, bank and card transactions in the books, completed reconciliations,
 * and the financial-report review and release gate. Nothing here writes to the database.
 *
 * Source never matters: a transaction imported from a statement (CSV) and one brought in by the
 * bank feed (Plaid) are the same row in the same table, read the same way, so the stages, wording
 * and links are identical before and after a bank feed is turned on. Imported or synchronized
 * transactions can only ever move "Transactions Updated". Reconciliation needs the office-filed
 * statement AND a completed reconciliation (or the staff reconcile sign-off) for every account;
 * Financials Under Review needs the owner's approval; Books Completed needs the owner-approved
 * statements released.
 *
 * Bank and card statements are never asked of the client: our office retrieves and files them.
 * Coetha's internal work (draft requests, prepared-but-unapproved reconciliations, proposals,
 * notes) is never read, so it can neither move a stage nor reach the client.
 */

export const STAGE_KEYS = ["DOCUMENTS", "TRANSACTIONS", "RECONCILIATION", "REVIEW", "COMPLETED"] as const;
export type StageKey = (typeof STAGE_KEYS)[number];
export type StageStatus = "NOT_STARTED" | "IN_PROGRESS" | "COMPLETE" | "NOT_APPLICABLE";
export type PeriodKind = "MONTH" | "QUARTER";

export const STAGE_LABELS: Record<StageKey, string> = {
  DOCUMENTS: "Documents Received",
  TRANSACTIONS: "Transactions Updated",
  RECONCILIATION: "Reconciliation",
  REVIEW: "Financials Under Review",
  COMPLETED: "Monthly Books Completed",
};
const label = (key: StageKey, kind: PeriodKind) => (key === "COMPLETED" && kind === "QUARTER" ? "Quarterly Books Completed" : STAGE_LABELS[key]);

export const STATUS_LABELS: Record<Exclude<StageStatus, "NOT_APPLICABLE">, string> = { NOT_STARTED: "Not started", IN_PROGRESS: "In progress", COMPLETE: "Complete" };

/** Where a stage points the client on the dashboard (the same places, whatever the data source). */
export type StageLink = "what-we-need" | "statements" | null;

/** One stage as the client sees it: a status and a plain one-line detail (counts only, never amounts or notes). */
export type BooksStage = { key: StageKey; label: string; status: StageStatus; detail: string; link: StageLink };

export type BooksProgress = {
  /** MONTH (monthly engagement) or QUARTER (quarterly engagement). */
  periodKind: PeriodKind;
  /** "October 2026" or "Q4 2026". */
  periodLabel: string;
  /** YYYY-MM: the month, or the quarter's last month. */
  month: string;
  /** Applicable stages only, in order. A stage that doesn't apply to this engagement is left out (never shown as incomplete). */
  stages: BooksStage[];
  completed: number;
  applicable: number;
  /** completed ÷ applicable stages. */
  percent: number;
  /** The first applicable stage that isn't complete, or null when every stage is complete. */
  current: StageKey | null;
  started: boolean;
  done: boolean;
  /** The Coetha status card's sentence, from the same stages, so the two never disagree. */
  headline: string;
};

// --- Periods ----------------------------------------------------------------------------------------

const pad = (n: number) => String(n).padStart(2, "0");
const lastDayOf = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** The engagement's period containing a month: the month itself, or its calendar quarter (Q1 = Jan–Mar …). */
export function engagementPeriod(frequency: string | null | undefined, month: string) {
  const [y, m] = month.split("-").map(Number);
  if (frequency === "QUARTERLY") {
    const q = Math.ceil(m / 3);
    const months = [q * 3 - 2, q * 3 - 1, q * 3].map((x) => `${y}-${pad(x)}`);
    return { kind: "QUARTER" as const, key: `${y}-Q${q}`, label: `Q${q} ${y}`, short: `Q${q} ${y}`, months, end: months[2] };
  }
  return { kind: "MONTH" as const, key: month, label: `${MONTHS[m - 1]} ${y}`, short: MONTHS[m - 1], months: [month], end: month };
}

// --- The facts (read from the database) ----------------------------------------------------------

type StaffStep = "OPEN" | "DONE" | "NOT_NEEDED" | null;

export type BooksFacts = {
  period: ReturnType<typeof engagementPeriod>;
  today: string;
  periodOpen: boolean;
  /** What the client was asked to provide for the period: received (accepted, staff-confirmed, or a scan-clean upload) or not. */
  documents: { received: boolean; pending: boolean }[];
  /** Statements our office retrieves and files (one per account in scope): filed for every month of the period, or not. */
  officeStatements: { filed: boolean }[];
  /** The staff checklist steps: DONE only when done for every month of the period. */
  categorizeStep: StaffStep;
  reconcileStep: StaffStep;
  /** Bank and card accounts in scope, over the whole period. */
  accounts: { covered: boolean; transactions: number; unreviewed: number; reconciled: boolean; statementFiled: boolean }[];
  /** Current versions of the period's financial statements (P&L, Balance Sheet, packet). */
  reports: { reviewStatus: string | null }[];
  /** The owner-approved statements for the period are released to the client (the dashboard's release gate). */
  released: boolean;
};

const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;
const FINANCIALS = ["FINANCIAL_PACKET", "PROFIT_AND_LOSS", "BALANCE_SHEET"] as const;
/** What the client provides (receipts, payroll reports). Bank and card statements are OFFICE_DOCUMENT items. */
const CLIENT_DOC_ITEMS = CHECKLIST.filter((c) => c.kind === "CLIENT_DOCUMENT");
const OFFICE_DOC_ITEMS = CHECKLIST.filter((c) => c.kind === "OFFICE_DOCUMENT");
const CARD_TYPES = ["CREDIT_CARD", "LINE_OF_CREDIT", "LOAN"];

/** Reads every record the tracker uses for one business and period. Every query is scoped to `clientId`. */
export async function loadBooksFacts(clientId: string, month: string, opts: { today?: string } = {}): Promise<BooksFacts> {
  const today = opts.today ?? todayCentral();
  const profile = await prisma.bookkeepingProfile.findUnique({ where: { clientId }, select: { frequency: true } });
  const period = engagementPeriod(profile?.frequency, month);
  const ranges = period.months.map((ym) => {
    const [y, m] = ym.split("-").map(Number);
    return { ym, y, m, from: toDate(`${ym}-01`), to: toDate(`${ym}-${pad(lastDayOf(y, m))}`) };
  });
  const [periods, registry] = await Promise.all([
    prisma.bookkeepingPeriod.findMany({ where: { clientId, OR: ranges.map((r) => ({ year: r.y, month: r.m })) }, select: { id: true, year: true, month: true, checklist: { select: { key: true, status: true } } } }),
    prisma.bookkeepingAccount.findMany({ where: { clientId, active: true, parentAccountId: null, monitored: true }, select: { id: true, accountType: true, ledgerAccountId: true, statementDay: true } }),
  ]);
  const periodOf = (r: (typeof ranges)[number]) => periods.find((p) => p.year === r.y && p.month === r.m) ?? null;
  const periodIds = periods.map((p) => p.id);
  const from = ranges[0].from, to = ranges[ranges.length - 1].to;

  // Accounts in scope: the business's registered bank/card accounts (Banking & Reconciliation).
  // Without a registry, the ledger's bank and card accounts that are actually used.
  type Scoped = { registryId: string | null; ledgerAccountId: string | null; statementDay: number | null; card: boolean };
  let scoped: Scoped[] = registry.filter((a) => reconciles(a.accountType)).map((a) => ({ registryId: a.id, ledgerAccountId: a.ledgerAccountId, statementDay: a.statementDay, card: CARD_TYPES.includes(a.accountType) }));
  if (!scoped.length) {
    const ledger = await prisma.ledgerAccount.findMany({ where: { clientId, active: true, subtype: { in: ["BANK", "CREDIT_CARD"] }, OR: [{ bankTransactions: { some: {} } }, { reconciliations: { some: {} } }] }, select: { id: true, subtype: true } });
    scoped = ledger.map((a) => ({ registryId: null, ledgerAccountId: a.id, statementDay: null, card: a.subtype === "CREDIT_CARD" }));
  }

  // A staff step counts as DONE only when done in every month of the period; null when no month has it.
  const step = (key: string): StaffStep => {
    const all = ranges.map((r) => periodOf(r)?.checklist.find((i) => i.key === key)?.status ?? null);
    if (all.every((s) => s === null)) return null;
    if (all.every((s) => s === "NOT_NEEDED")) return "NOT_NEEDED";
    return all.every((s) => s === "DONE" || s === "NOT_NEEDED") ? "DONE" : "OPEN";
  };

  // 1. Documents the client provides: the checklist's client items, and requests the client can see
  //    for the period (never drafts, never routine statement requests — the office retrieves those).
  const requests = await prisma.documentRequest.findMany({
    where: { clientId, kind: { not: "YEAR_END" }, status: { in: ["OPEN", "SUBMITTED", "ACCEPTED"] }, AND: [clientFacingRequestWhere(true)], OR: [...(periodIds.length ? [{ periodId: { in: periodIds } }] : []), { periodStart: { gte: from, lte: to } }] },
    select: { status: true, documents: { where: { deletedAt: null }, select: { scanStatus: true } } },
  });
  const openRequests = requests.filter((r) => r.status === "OPEN").length;
  const documents: BooksFacts["documents"] = [];
  for (const r of ranges) {
    const p = periodOf(r);
    if (!p) continue;
    const monthDocs = { clientId, deletedAt: null, scanStatus: "CLEAN" as const, OR: [{ periodId: p.id }, { year: r.y, month: r.m }, { periodStart: { lte: r.to }, periodEnd: { gte: r.from } }] };
    const have = new Set((await prisma.document.findMany({ where: { ...monthDocs, docType: { in: CLIENT_DOC_ITEMS.map((c) => c.docType!) } }, select: { docType: true }, distinct: ["docType"] })).map((d) => d.docType));
    for (const item of p.checklist.filter((i) => i.status !== "NOT_NEEDED")) {
      const def = CLIENT_DOC_ITEMS.find((c) => c.key === item.key);
      if (!def) continue;
      // Receipts are asked for one by one (requests, counted below); once the month has ended with none outstanding, nothing more is needed.
      const receiptsSettled = item.key === "RECEIPTS" && today > ymdOf(r.to) && !openRequests;
      documents.push({ received: item.status === "DONE" || receiptsSettled || have.has(def.docType!), pending: false });
    }
  }
  for (const r of requests) {
    const clean = r.documents.some((d) => d.scanStatus === "CLEAN");
    documents.push({ received: r.status === "ACCEPTED" || (r.status === "SUBMITTED" && clean), pending: r.status === "SUBMITTED" && !clean });
  }

  // 2–3. Transactions, office-filed statements and reconciliations, per account in scope (CSV and bank-feed rows alike).
  const accounts: BooksFacts["accounts"] = [];
  for (const a of scoped) {
    if (!a.ledgerAccountId) {
      accounts.push({ covered: false, transactions: 0, unreviewed: 0, reconciled: false, statementFiled: false });
      continue;
    }
    const lid = a.ledgerAccountId;
    const [rows, unreviewed] = await Promise.all([
      prisma.bankTransaction.count({ where: { clientId, accountId: lid, date: { gte: from, lte: to }, status: { not: "EXCLUDED" } } }),
      prisma.bankTransaction.count({ where: { clientId, accountId: lid, date: { gte: from, lte: to }, status: "UNREVIEWED" } }),
    ]);
    let covered = true, reconciled = true, statementFiled = true;
    for (const r of ranges) {
      const w = a.registryId ? statementWindow(r.y, r.m, a.statementDay) : { start: `${r.ym}-01`, end: ymdOf(r.to) };
      const [imported, feed, approvedRec, bankRec, statement] = await Promise.all([
        // The month is in the books for this account once a statement import reaches month end, or the account's bank feed has synced past it.
        prisma.bankImport.count({ where: { clientId, accountId: lid, lastDate: { gte: toDate(ymdOf(new Date(r.to.getTime() - 3 * 86_400_000))) } } }),
        prisma.bankConnectionAccount.count({ where: { ledgerAccountId: lid, connection: { clientId, status: "ACTIVE", lastSuccessAt: { gte: new Date(r.to.getTime() + 86_400_000) } } } }),
        a.registryId ? prisma.accountReconciliation.count({ where: { clientId, bookkeepingAccountId: a.registryId, year: r.y, month: r.m, status: "APPROVED" } }) : Promise.resolve(0),
        prisma.bankReconciliation.count({ where: { clientId, accountId: lid, statementDate: { gte: toDate(w.start), lte: toDate(w.end) } } }),
        a.registryId ? prisma.document.count({ where: officeStatementWhere(clientId, a.registryId, { start: toDate(w.start), end: toDate(w.end) }) }) : Promise.resolve(0),
      ]);
      covered &&= today > ymdOf(r.to) && (imported > 0 || feed > 0);
      reconciled &&= approvedRec > 0 || bankRec > 0;
      statementFiled &&= statement > 0;
    }
    accounts.push({ covered, transactions: rows, unreviewed, reconciled, statementFiled });
  }
  // Office statements: one per account in scope. With no registered account, the checklist's statement items.
  let officeStatements: BooksFacts["officeStatements"] = accounts.map((a) => ({ filed: a.statementFiled }));
  if (!scoped.length) {
    officeStatements = [];
    for (const def of OFFICE_DOC_ITEMS) {
      const s = step(def.key);
      if (s === null || s === "NOT_NEEDED") continue;
      const filed = s === "DONE" || (await prisma.document.count({ where: { clientId, deletedAt: null, scanStatus: "CLEAN", uploadedByPortalId: null, docType: def.docType, OR: [{ periodId: { in: periodIds } }, { periodStart: { lte: to }, periodEnd: { gte: from } }] } })) > 0;
      officeStatements.push({ filed });
    }
  }

  // 4–5. Financial statements for the period (its last month): current versions, the owner's approval, and the release gate.
  const last = periodOf(ranges[ranges.length - 1]);
  const [reports, released] = last
    ? await Promise.all([
        prisma.document.findMany({ where: { clientId, periodId: last.id, deletedAt: null, supersededAt: null, category: "BOOKKEEPING", reportType: { in: [...FINANCIALS] } }, select: { reviewStatus: true } }),
        prisma.document.count({
          where: {
            clientId, periodId: last.id, category: "BOOKKEEPING", deletedAt: null, supersededAt: null, reviewStatus: "APPROVED", visibility: "PUBLISHED", scanStatus: "CLEAN",
            reportType: { in: ["PROFIT_AND_LOSS", "FINANCIAL_PACKET"] },
            OR: [{ reportPeriodType: null }, { reportPeriodType: { in: period.kind === "QUARTER" ? ["MONTH", "QUARTER"] : ["MONTH"] } }],
          },
        }),
      ])
    : [[], 0];

  return { period, today, periodOpen: periods.length > 0, documents, officeStatements, categorizeStep: step("CATEGORIZE"), reconcileStep: step("RECONCILE"), accounts, reports, released: released > 0 };
}

// --- The stages (pure) ---------------------------------------------------------------------------

/**
 * The five stages from the facts. Each stage's status comes only from its own records — a later
 * stage is never marked complete because of an earlier one, and an earlier stage is never marked
 * complete because a later one is. If records show a later stage complete while an earlier one is
 * still open (say a late receipt after release), both are shown as they are; the overall percent
 * counts only complete stages, "current" is the earliest open stage, and the period reads as
 * complete only when every applicable stage is complete.
 */
export function booksProgressFromFacts(f: BooksFacts): BooksProgress {
  const p = f.period;
  const [ey, em] = p.end.split("-").map(Number);
  const ended = f.today > `${p.end}-${pad(lastDayOf(ey, em))}`;
  const short = p.short;
  const quarterly = p.kind === "QUARTER";
  const stage = (key: StageKey, link: StageLink = null): BooksStage => ({ key, label: label(key, p.kind), status: "NOT_STARTED", detail: "", link });

  // 1. Documents Received — what the client provides, plus the statements our office files itself.
  const need = f.documents.length, got = f.documents.filter((d) => d.received).length, checking = f.documents.filter((d) => !d.received && d.pending).length;
  const stmts = f.officeStatements.length, filed = f.officeStatements.filter((s) => s.filed).length;
  const documents = stage("DOCUMENTS", "what-we-need");
  if (!f.periodOpen) {
    documents.detail = `We'll list anything we need for ${short} here.`;
  } else if (!need && !stmts) {
    documents.status = "COMPLETE";
    documents.detail = `Nothing is needed from you for ${short}.`;
  } else if (got === need && filed === stmts) {
    documents.status = "COMPLETE";
    documents.detail = !need ? "Statements retrieved by our office. Nothing is needed from you." : stmts ? "Statements retrieved by our office · All documents received. Thank you!" : need === 1 ? "Your document is received. Thank you!" : `All ${need} documents received. Thank you!`;
  } else {
    documents.status = "IN_PROGRESS";
    const still = need - got - checking;
    documents.detail = [
      stmts ? (filed === stmts ? "Statements retrieved by our office" : "Our office is retrieving your statements") : null,
      need ? (still || checking ? `${got} of ${plural(need, "document")} from you received` : "All documents from you received") : null,
      checking ? `${checking} being checked` : null,
      still ? `${still} still needed from you` : null,
    ].filter(Boolean).join(" · ") + ".";
  }

  // 2. Transactions Updated
  const accts = f.accounts;
  const rows = accts.reduce((t, a) => t + a.transactions, 0), open = accts.reduce((t, a) => t + a.unreviewed, 0);
  const current = accts.filter((a) => a.covered && a.unreviewed === 0).length;
  const transactions = stage("TRANSACTIONS");
  if (!accts.length && (f.categorizeStep === null || f.categorizeStep === "NOT_NEEDED")) transactions.status = "NOT_APPLICABLE";
  else if (f.categorizeStep === "DONE" || (accts.length > 0 && ended && current === accts.length)) {
    transactions.status = "COMPLETE";
    transactions.detail = `Your transactions are up to date in your books through ${MONTHS[em - 1]} ${lastDayOf(ey, em)}.`;
  } else if (rows > 0 || accts.some((a) => a.covered)) {
    transactions.status = "IN_PROGRESS";
    transactions.detail = [accts.length ? `${current} of ${plural(accts.length, "account")} up to date` : null, open ? `${plural(open, "transaction")} being categorized by our office` : null].filter(Boolean).join(" · ") + ".";
    if (!ended) transactions.detail = `${short} is still in progress. ${transactions.detail}`;
  } else {
    transactions.detail = ended ? `We'll add ${short}'s transactions to your books.` : `${short}'s transactions are added after ${quarterly ? "the quarter" : "the month"} ends.`;
  }

  // 3. Reconciliation — for every account: the statement on file AND a completed reconciliation (or the
  //    staff reconcile sign-off). Never from imports or syncs alone.
  const done3 = accts.filter((a) => a.statementFiled && (a.reconciled || f.reconcileStep === "DONE")).length;
  const reconciliation = stage("RECONCILIATION");
  if (!accts.length && (f.reconcileStep === null || f.reconcileStep === "NOT_NEEDED")) reconciliation.status = "NOT_APPLICABLE";
  else if (accts.length ? done3 === accts.length : f.reconcileStep === "DONE") {
    reconciliation.status = "COMPLETE";
    reconciliation.detail = accts.length > 1 ? `All ${accts.length} accounts reconciled to your statements.` : "Your accounts are reconciled to your statements.";
  } else if (done3 > 0 || transactions.status === "COMPLETE") {
    reconciliation.status = "IN_PROGRESS";
    reconciliation.detail = accts.length ? `${done3} of ${plural(accts.length, "account")} reconciled.` : "Our office is reconciling your accounts.";
  } else {
    reconciliation.detail = "Starts once your transactions are up to date.";
  }

  // 4. Financials Under Review — complete only with the owner's approval.
  const what = quarterly ? "quarterly financial statements" : "financial statements";
  const review = stage("REVIEW");
  const approved = f.reports.length > 0 && f.reports.every((r) => r.reviewStatus === "APPROVED");
  if (approved || f.released) {
    review.status = "COMPLETE";
    review.detail = `Your ${what} are approved.`;
  } else if (f.reports.length) {
    review.status = "IN_PROGRESS";
    review.detail = f.reports.some((r) => r.reviewStatus === "AWAITING_REVIEW") ? `Your ${what} are in final review.` : `Your ${what} are being prepared.`;
  } else {
    review.detail = `Your ${what} are prepared after reconciliation.`;
  }

  // 5. Books Completed — only once the owner-approved statements are released to you.
  const completed = stage("COMPLETED", "statements");
  if (f.released) {
    completed.status = "COMPLETE";
    completed.detail = `${short}'s ${what} are ready for you.`;
  } else if (review.status === "COMPLETE") {
    completed.status = "IN_PROGRESS";
    completed.detail = "Approved — your statements will be released to you shortly.";
  } else {
    completed.detail = "Your statements appear here once they're approved and released.";
  }

  const stages = [documents, transactions, reconciliation, review, completed].filter((s) => s.status !== "NOT_APPLICABLE");
  const doneCount = stages.filter((s) => s.status === "COMPLETE").length;
  const percent = stages.length ? Math.round((doneCount / stages.length) * 100) : 0;
  const first = stages.find((s) => s.status !== "COMPLETE") ?? null;
  const started = f.periodOpen || stages.some((s) => s.status !== "NOT_STARTED");
  const all = !first && stages.length > 0;
  const whose = quarterly ? `${p.label}` : `${short}'s`;
  const headline = !started
    ? `We haven't started ${p.label} yet. Your bookkeeping progress will show here once we do.`
    : all
      ? `${whose} books are complete. Your ${what} are approved and ready for you below.`
      : `${whose} books are ${percent}% complete. Current stage: ${first!.label}. ${first!.detail}`;
  return { periodKind: p.kind, periodLabel: p.label, month: p.end, stages, completed: doneCount, applicable: stages.length, percent, current: first?.key ?? null, started, done: all, headline };
}

/** The tracker for one business and the engagement period containing `month` (YYYY-MM). Callers check access first. */
export async function computeBooksProgress(clientId: string, month: string, opts: { today?: string } = {}): Promise<BooksProgress> {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new Error("Choose a month (YYYY-MM).");
  return booksProgressFromFacts(await loadBooksFacts(clientId, month, opts));
}

export { STATEMENT_DOC_TYPES };
