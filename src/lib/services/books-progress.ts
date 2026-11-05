import "server-only";
import { prisma } from "@/lib/prisma";
import { CHECKLIST, reportsDue } from "./bookkeeping-clients";
import { reconciles, statementWindow } from "./bank-accounts";
import { todayCentral, toDate, ymdOf } from "./ledger";

/**
 * The client's Monthly Bookkeeping Progress Tracker: five stages for one month, read from the
 * office's own records only — document requests and receipts, the month's checklist, bank and
 * card transactions in the books, completed reconciliations, and the financial-report review and
 * release gate. Nothing here writes to the database.
 *
 * Source never matters: a transaction imported from a statement (CSV) and one brought in by the
 * bank feed (Plaid) are the same row in the same table, read the same way, so the stages, wording
 * and links are identical before and after a bank feed is turned on. Imported or synchronized
 * transactions can only ever move "Transactions Updated"; Reconciliation needs a completed
 * reconciliation record (or the staff reconcile step done), Financials Under Review needs the
 * owner's approval, and Monthly Books Completed needs the owner-approved statements released.
 *
 * Coetha's internal work (draft requests, prepared-but-unapproved reconciliations, proposals,
 * notes) is never read, so it can neither move a stage nor reach the client.
 */

export const STAGE_KEYS = ["DOCUMENTS", "TRANSACTIONS", "RECONCILIATION", "REVIEW", "COMPLETED"] as const;
export type StageKey = (typeof STAGE_KEYS)[number];
export type StageStatus = "NOT_STARTED" | "IN_PROGRESS" | "COMPLETE" | "NOT_APPLICABLE";

export const STAGE_LABELS: Record<StageKey, string> = {
  DOCUMENTS: "Documents Received",
  TRANSACTIONS: "Transactions Updated",
  RECONCILIATION: "Reconciliation",
  REVIEW: "Financials Under Review",
  COMPLETED: "Monthly Books Completed",
};

export const STATUS_LABELS: Record<Exclude<StageStatus, "NOT_APPLICABLE">, string> = { NOT_STARTED: "Not started", IN_PROGRESS: "In progress", COMPLETE: "Complete" };

/** Where a stage points the client on the dashboard (the same places, whatever the data source). */
export type StageLink = "what-we-need" | "statements" | null;

/** One stage as the client sees it: a status and a plain one-line detail (counts only, never amounts or notes). */
export type BooksStage = { key: StageKey; label: string; status: StageStatus; detail: string; link: StageLink };

export type BooksProgress = {
  /** YYYY-MM */
  month: string;
  /** Applicable stages only, in order. A stage that doesn't apply to this engagement is left out (never shown as incomplete). */
  stages: BooksStage[];
  completed: number;
  applicable: number;
  /** completed ÷ applicable stages. */
  percent: number;
  /** The first applicable stage that isn't complete (what the month is waiting on), or null when every stage is complete. */
  current: StageKey | null;
  started: boolean;
  done: boolean;
  /** The Coetha status card's sentence, from the same stages, so the two never disagree. */
  headline: string;
};

// --- The facts (read from the database) ----------------------------------------------------------

type StaffStep = "OPEN" | "DONE" | "NOT_NEEDED" | null;

export type BooksFacts = {
  month: string;
  today: string;
  /** MONTHLY | QUARTERLY: quarterly clients get statements at quarter end only. */
  frequency: string;
  periodOpen: boolean;
  /** Required client documents for the month: received (accepted, staff-confirmed, or a scan-clean upload) or not. */
  documents: { received: boolean; pending: boolean }[];
  /** The month's staff checklist steps, when the month has a checklist. */
  categorizeStep: StaffStep;
  reconcileStep: StaffStep;
  /** Bank and card accounts in scope for the month. */
  accounts: { covered: boolean; transactions: number; unreviewed: number; reconciled: boolean }[];
  /** Current versions of the month's financial statements (P&L, Balance Sheet, packet). */
  reports: { reviewStatus: string | null }[];
  /** The owner-approved statements for the month are released to the client (the dashboard's release gate). */
  released: boolean;
};

const pad = (n: number) => String(n).padStart(2, "0");
const lastDayOf = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();
const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;
const FINANCIALS = ["FINANCIAL_PACKET", "PROFIT_AND_LOSS", "BALANCE_SHEET"] as const;
const CLIENT_DOC_ITEMS = CHECKLIST.filter((c) => c.kind === "CLIENT_DOCUMENT");
const CARD_TYPES = ["CREDIT_CARD", "LINE_OF_CREDIT", "LOAN"];

/** Reads every record the tracker uses for one business and month. Every query is scoped to `clientId`. */
export async function loadBooksFacts(clientId: string, month: string, opts: { today?: string } = {}): Promise<BooksFacts> {
  const today = opts.today ?? todayCentral();
  const [y, m] = month.split("-").map(Number);
  const start = `${month}-01`, end = `${month}-${pad(lastDayOf(y, m))}`;
  const from = toDate(start), to = toDate(end);
  const monthEnded = today > end;

  const [profile, period, registry] = await Promise.all([
    prisma.bookkeepingProfile.findUnique({ where: { clientId }, select: { frequency: true, payroll: true } }),
    prisma.bookkeepingPeriod.findUnique({ where: { clientId_year_month: { clientId, year: y, month: m } }, select: { id: true, checklist: { select: { key: true, kind: true, status: true } } } }),
    prisma.bookkeepingAccount.findMany({ where: { clientId, active: true, parentAccountId: null, monitored: true }, select: { id: true, accountType: true, ledgerAccountId: true, statementDay: true } }),
  ]);
  const frequency = profile?.frequency ?? "MONTHLY";

  // Accounts in scope: the business's registered bank/card accounts (Banking & Reconciliation).
  // Without a registry, the ledger's bank and card accounts that are actually used.
  type Scoped = { registryId: string | null; ledgerAccountId: string | null; statementDay: number | null; card: boolean };
  let scoped: Scoped[] = registry.filter((a) => reconciles(a.accountType)).map((a) => ({ registryId: a.id, ledgerAccountId: a.ledgerAccountId, statementDay: a.statementDay, card: CARD_TYPES.includes(a.accountType) }));
  if (!scoped.length) {
    const ledger = await prisma.ledgerAccount.findMany({ where: { clientId, active: true, subtype: { in: ["BANK", "CREDIT_CARD"] }, OR: [{ bankTransactions: { some: {} } }, { reconciliations: { some: {} } }] }, select: { id: true, subtype: true } });
    scoped = ledger.map((a) => ({ registryId: null, ledgerAccountId: a.id, statementDay: null, card: a.subtype === "CREDIT_CARD" }));
  }

  // 1. Documents: the month's checklist documents, plus requests sent for the month (never drafts).
  const step = (key: string): StaffStep => (period?.checklist.find((i) => i.key === key)?.status as StaffStep) ?? null;
  const monthDocs = { clientId, deletedAt: null, scanStatus: "CLEAN" as const, OR: [...(period ? [{ periodId: period.id }] : []), { year: y, month: m }, { periodStart: { lte: to }, periodEnd: { gte: from } }] };
  const [requests, cleanTypes] = await Promise.all([
    prisma.documentRequest.findMany({
      where: { clientId, kind: { not: "YEAR_END" }, status: { in: ["OPEN", "SUBMITTED", "ACCEPTED"] }, OR: [...(period ? [{ periodId: period.id }] : []), { periodStart: { gte: from, lte: to } }] },
      select: { status: true, documents: { where: { deletedAt: null }, select: { scanStatus: true } } },
    }),
    prisma.document.findMany({ where: { ...monthDocs, docType: { in: CLIENT_DOC_ITEMS.map((c) => c.docType!) } }, select: { docType: true }, distinct: ["docType"] }),
  ]);
  const have = new Set(cleanTypes.map((d) => d.docType));
  const openRequests = requests.filter((r) => r.status === "OPEN").length;
  const documents: BooksFacts["documents"] = [];
  for (const item of period?.checklist.filter((i) => i.kind === "CLIENT_DOCUMENT" && i.status !== "NOT_NEEDED") ?? []) {
    const def = CLIENT_DOC_ITEMS.find((c) => c.key === item.key);
    // Card statements apply only when the business has a card account in scope.
    if (item.key === "CARD_STATEMENTS" && !scoped.some((a) => a.card)) continue;
    // Receipts are asked for one by one (requests, counted below); once the month has ended with none outstanding, nothing more is needed.
    const receiptsSettled = item.key === "RECEIPTS" && monthEnded && !openRequests;
    documents.push({ received: item.status === "DONE" || receiptsSettled || (!!def?.docType && have.has(def.docType)), pending: false });
  }
  for (const r of requests) {
    const clean = r.documents.some((d) => d.scanStatus === "CLEAN");
    documents.push({ received: r.status === "ACCEPTED" || (r.status === "SUBMITTED" && clean), pending: r.status === "SUBMITTED" && !clean });
  }

  // 2–3. Transactions and reconciliations, per account in scope (CSV and bank-feed rows alike).
  const accounts: BooksFacts["accounts"] = [];
  for (const a of scoped) {
    if (!a.ledgerAccountId) {
      accounts.push({ covered: false, transactions: 0, unreviewed: 0, reconciled: false });
      continue;
    }
    const lid = a.ledgerAccountId;
    const w = a.registryId ? statementWindow(y, m, a.statementDay) : { start, end };
    const [rows, unreviewed, imported, feed, approvedRec, bankRec] = await Promise.all([
      prisma.bankTransaction.count({ where: { clientId, accountId: lid, date: { gte: from, lte: to }, status: { not: "EXCLUDED" } } }),
      prisma.bankTransaction.count({ where: { clientId, accountId: lid, date: { gte: from, lte: to }, status: "UNREVIEWED" } }),
      // The month is in the books for this account once a statement import reaches month end, or the account's bank feed has synced past it.
      prisma.bankImport.count({ where: { clientId, accountId: lid, lastDate: { gte: toDate(ymdOf(new Date(to.getTime() - 3 * 86_400_000))) } } }),
      prisma.bankConnectionAccount.count({ where: { ledgerAccountId: lid, connection: { clientId, status: "ACTIVE", lastSuccessAt: { gte: new Date(to.getTime() + 86_400_000) } } } }),
      a.registryId ? prisma.accountReconciliation.count({ where: { clientId, bookkeepingAccountId: a.registryId, year: y, month: m, status: "APPROVED" } }) : Promise.resolve(0),
      prisma.bankReconciliation.count({ where: { clientId, accountId: lid, statementDate: { gte: toDate(w.start), lte: toDate(w.end) } } }),
    ]);
    accounts.push({ covered: monthEnded && (imported > 0 || feed > 0), transactions: rows, unreviewed, reconciled: approvedRec > 0 || bankRec > 0 });
  }

  // 4–5. Financial statements: current versions, the owner's approval, and the release gate.
  const [reports, released] = period
    ? await Promise.all([
        prisma.document.findMany({ where: { clientId, periodId: period.id, deletedAt: null, supersededAt: null, category: "BOOKKEEPING", reportType: { in: [...FINANCIALS] } }, select: { reviewStatus: true } }),
        prisma.document.count({
          where: {
            clientId, periodId: period.id, category: "BOOKKEEPING", deletedAt: null, supersededAt: null, reviewStatus: "APPROVED", visibility: "PUBLISHED", scanStatus: "CLEAN",
            reportType: { in: ["PROFIT_AND_LOSS", "FINANCIAL_PACKET"] },
            OR: [{ reportPeriodType: null }, { reportPeriodType: { in: frequency === "QUARTERLY" ? ["MONTH", "QUARTER"] : ["MONTH"] } }],
          },
        }),
      ])
    : [[], 0];

  return { month, today, frequency, periodOpen: !!period, documents, categorizeStep: step("CATEGORIZE"), reconcileStep: step("RECONCILE"), accounts, reports, released: released > 0 };
}

// --- The stages (pure) ---------------------------------------------------------------------------

const monthLong = (ym: string, opts: Intl.DateTimeFormatOptions) => {
  const [y, m] = ym.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString("en-US", { ...opts, timeZone: "UTC" });
};

/**
 * The five stages from the facts. Each stage's status comes only from its own records — a later
 * stage is never marked complete because of an earlier one, and an earlier stage is never marked
 * complete because a later one is. If records show a later stage complete while an earlier one is
 * still open (say a late receipt after release), both are shown as they are; the overall percent
 * counts only complete stages, "current" is the earliest open stage, and the month reads as
 * complete only when every applicable stage is complete.
 */
export function booksProgressFromFacts(f: BooksFacts): BooksProgress {
  const [y, m] = f.month.split("-").map(Number);
  const end = `${f.month}-${pad(lastDayOf(y, m))}`;
  const monthEnded = f.today > end;
  const short = monthLong(f.month, { month: "long" });
  const reportMonth = reportsDue(f.frequency, m);

  // 1. Documents Received
  const need = f.documents.length, got = f.documents.filter((d) => d.received).length, checking = f.documents.filter((d) => !d.received && d.pending).length;
  const documents: BooksStage = { key: "DOCUMENTS", label: STAGE_LABELS.DOCUMENTS, link: "what-we-need", status: "NOT_STARTED", detail: "" };
  if (!need) {
    documents.status = f.periodOpen ? "COMPLETE" : "NOT_STARTED";
    documents.detail = f.periodOpen ? `Nothing is needed from you for ${short}.` : `We'll list anything we need for ${short} here.`;
  } else if (got === need) {
    documents.status = "COMPLETE";
    documents.detail = need === 1 ? "Your document is received. Thank you!" : `All ${need} documents received. Thank you!`;
  } else {
    documents.status = "IN_PROGRESS";
    const still = need - got - checking;
    documents.detail = [`${got} of ${plural(need, "document")} received`, checking ? `${checking} being checked` : null, still ? `${still} still needed from you` : null].filter(Boolean).join(" · ") + ".";
  }

  // 2. Transactions Updated
  const accts = f.accounts;
  const rows = accts.reduce((t, a) => t + a.transactions, 0), open = accts.reduce((t, a) => t + a.unreviewed, 0);
  const current = accts.filter((a) => a.covered && a.unreviewed === 0).length;
  const transactions: BooksStage = { key: "TRANSACTIONS", label: STAGE_LABELS.TRANSACTIONS, link: null, status: "NOT_STARTED", detail: "" };
  if (!accts.length && (f.categorizeStep === null || f.categorizeStep === "NOT_NEEDED")) transactions.status = "NOT_APPLICABLE";
  else if (f.categorizeStep === "DONE" || (accts.length > 0 && monthEnded && current === accts.length)) {
    transactions.status = "COMPLETE";
    transactions.detail = `Your transactions are up to date in your books through ${short} ${lastDayOf(y, m)}.`;
  } else if (rows > 0 || accts.some((a) => a.covered)) {
    transactions.status = "IN_PROGRESS";
    transactions.detail = [accts.length ? `${current} of ${plural(accts.length, "account")} up to date` : null, open ? `${plural(open, "transaction")} being categorized by our office` : null].filter(Boolean).join(" · ") + ".";
    if (!monthEnded) transactions.detail = `${short} is still in progress. ${transactions.detail}`;
  } else {
    transactions.detail = monthEnded ? `We'll add ${short}'s transactions to your books.` : `${short}'s transactions are added after the month ends.`;
  }

  // 3. Reconciliation — a completed reconciliation record (or the staff step) for every account; never from imports alone.
  const reconciled = accts.filter((a) => a.reconciled).length;
  const reconciliation: BooksStage = { key: "RECONCILIATION", label: STAGE_LABELS.RECONCILIATION, link: null, status: "NOT_STARTED", detail: "" };
  if (!accts.length && (f.reconcileStep === null || f.reconcileStep === "NOT_NEEDED")) reconciliation.status = "NOT_APPLICABLE";
  else if (f.reconcileStep === "DONE" || (accts.length > 0 && reconciled === accts.length)) {
    reconciliation.status = "COMPLETE";
    reconciliation.detail = accts.length > 1 ? `All ${accts.length} accounts reconciled to your statements.` : "Your accounts are reconciled to your statements.";
  } else if (reconciled > 0 || transactions.status === "COMPLETE") {
    reconciliation.status = "IN_PROGRESS";
    reconciliation.detail = accts.length ? `${reconciled} of ${plural(accts.length, "account")} reconciled.` : "Our office is reconciling your accounts.";
  } else {
    reconciliation.detail = "Starts once your transactions are up to date.";
  }

  // 4. Financials Under Review — complete only with the owner's approval.
  const review: BooksStage = { key: "REVIEW", label: STAGE_LABELS.REVIEW, link: null, status: "NOT_STARTED", detail: "" };
  const approved = f.reports.length > 0 && f.reports.every((r) => r.reviewStatus === "APPROVED");
  if (!reportMonth) review.status = "NOT_APPLICABLE";
  else if (approved || f.released) {
    review.status = "COMPLETE";
    review.detail = "Your financial statements are approved.";
  } else if (f.reports.length) {
    review.status = "IN_PROGRESS";
    review.detail = f.reports.some((r) => r.reviewStatus === "AWAITING_REVIEW") ? "Your financial statements are in final review." : "Your financial statements are being prepared.";
  } else {
    review.detail = "Your statements are prepared after reconciliation.";
  }

  // 5. Monthly Books Completed — only once the owner-approved statements are released to you.
  const completed: BooksStage = { key: "COMPLETED", label: STAGE_LABELS.COMPLETED, link: "statements", status: "NOT_STARTED", detail: "" };
  if (!reportMonth) completed.status = "NOT_APPLICABLE";
  else if (f.released) {
    completed.status = "COMPLETE";
    completed.detail = `${short}'s financial statements are ready for you.`;
  } else if (review.status === "COMPLETE") {
    completed.status = "IN_PROGRESS";
    completed.detail = "Approved — your statements will be released to you shortly.";
  } else {
    completed.detail = "Your statements appear here once they're approved and released.";
  }

  const stages = [documents, transactions, reconciliation, review, completed].filter((s) => s.status !== "NOT_APPLICABLE");
  const done = stages.filter((s) => s.status === "COMPLETE").length;
  const percent = stages.length ? Math.round((done / stages.length) * 100) : 0;
  const first = stages.find((s) => s.status !== "COMPLETE") ?? null;
  const started = f.periodOpen || stages.some((s) => s.status !== "NOT_STARTED");
  const all = !first && stages.length > 0;
  const headline = !started
    ? `We haven't started ${monthLong(f.month, { month: "long", year: "numeric" })} yet. Your bookkeeping progress will show here once we do.`
    : all
      ? `${short}'s books are complete.${reportMonth ? " Your financial statements are approved and ready for you below." : ""}`
      : `${short}'s books are ${percent}% complete. Current stage: ${first!.label}. ${first!.detail}`;
  return { month: f.month, stages, completed: done, applicable: stages.length, percent, current: first?.key ?? null, started, done: all, headline };
}

/** The tracker for one business and month (YYYY-MM). Callers check access first (requireClientAccess / View as Client). */
export async function computeBooksProgress(clientId: string, month: string, opts: { today?: string } = {}): Promise<BooksProgress> {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new Error("Choose a month (YYYY-MM).");
  return booksProgressFromFacts(await loadBooksFacts(clientId, month, opts));
}
