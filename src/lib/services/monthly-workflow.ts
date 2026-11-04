import "server-only";
import { createHash } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { audit } from "@/lib/audit";
import type { Actor } from "@/lib/auth/actor";
import { MONTH_NAMES } from "@/lib/bk-uploads";
import { statementSource } from "@/lib/statement-retrieval";
import { assertLedger, normDesc, officeBookClientIds, todayCentral, toDate, usd, ymdOf } from "./ledger";
import { cardPaymentTarget, cardRefs, monthlyAccountProgress, prepareReconciliation, registryLabel, statementWindow, type Light } from "./bank-accounts";
import { createClientRequest, sendClientRequest, YEAR_END_FORMS, yearEndWindow } from "./client-requests";
import { coethaAutoSendOn } from "./owner-switches";
import { reportsDue, workMonth } from "./bookkeeping-clients";
import { CLASSIFICATION_RULES, classificationForEntity, TAX_CLASSIFICATIONS, taxProfile, type TaxClassification } from "./tax-classification";
import { retentionDate, storeDocumentFile } from "./documents";

/**
 * The monthly bookkeeping workflow, derived AUTOMATICALLY from real data — no manual check-offs
 * for routine prep. Annual tax documents (W-2, 1099, 1098, K-1…) are never part of it: they
 * live in the separate Year-End Tax Documents section, from January.
 *
 * Coetha (rules, no AI call) monitors each month: prepares every account's reconciliation,
 * drafts targeted document requests (exact document, account, period and reason) and
 * recommendations with full rationale for Tabitha. Nothing posts, finalizes or releases
 * without Tabitha.
 */

export type ItemState = "DONE" | "MISSING" | "IN_PROGRESS" | "NOT_DUE" | "NA";
export type WorkflowItem = { key: string; label: string; state: ItemState; detail: string; href?: string };

const pad = (n: number) => String(n).padStart(2, "0");
const monthEnd = (y: number, m: number) => `${y}-${pad(m)}-${pad(new Date(Date.UTC(y, m, 0)).getUTCDate())}`;
const BANK_TYPES = ["CHECKING", "SAVINGS"];
const CARD_TYPES = ["CREDIT_CARD", "LINE_OF_CREDIT", "LOAN"];

type SyncState = { state: ItemState; detail: string };

/** Whether one account's transactions for the month are in: a working bank feed counts, with no "statement missing". */
async function accountSynced(clientId: string, a: { id: string; ledgerAccountId: string | null; accountType: string }, y: number, m: number, today: string): Promise<SyncState> {
  const end = monthEnd(y, m);
  if (today <= end) return { state: "NOT_DUE", detail: "Month in progress" };
  if (!a.ledgerAccountId) return { state: "MISSING", detail: "No GL account assigned" };
  const feeds = await prisma.bankConnectionAccount.findMany({ where: { ledgerAccountId: a.ledgerAccountId, connection: { clientId, status: { not: "DISCONNECTED" } } }, include: { connection: { select: { status: true, lastSuccessAt: true } } } });
  if (feeds.length) {
    const ok = feeds.some((f) => f.connection.status === "ACTIVE" && f.connection.lastSuccessAt && ymdOf(f.connection.lastSuccessAt) > end);
    if (ok) return { state: "DONE", detail: "Bank feed synced through month end" };
    const reauth = feeds.some((f) => f.connection.status === "NEEDS_REAUTH");
    return { state: "MISSING", detail: reauth ? "Client must sign in to the bank again" : "Bank feed hasn't synced past month end" };
  }
  // Not connected: an imported statement or uploaded statement covering the month.
  const imp = await prisma.bankImport.findFirst({ where: { clientId, accountId: a.ledgerAccountId, lastDate: { gte: toDate(ymdOf(new Date(toDate(end).getTime() - 3 * 86_400_000))) } }, select: { id: true } });
  if (imp) return { state: "DONE", detail: "Statement imported" };
  return { state: "MISSING", detail: "No feed or statement for the month" };
}

/**
 * The month's checklist, every line from data:
 * Plaid sync status per account · outstanding receipt requests / unsupported amounts ·
 * payroll reports received · uncategorized count · per-account reconciliations · report
 * review status (prepared → awaiting Tabitha → released).
 */
export async function monthlyChecklist(clientId: string, year: number, month: number, opts: { today?: string } = {}) {
  const today = opts.today ?? todayCentral();
  const end = monthEnd(year, month);
  const due = today > end;
  const from = toDate(`${year}-${pad(month)}-01`), to = toDate(end);
  const [profile, accounts, period] = await Promise.all([
    prisma.bookkeepingProfile.findUnique({ where: { clientId } }),
    prisma.bookkeepingAccount.findMany({ where: { clientId, active: true, parentAccountId: null, monitored: true } }),
    prisma.bookkeepingPeriod.findUnique({ where: { clientId_year_month: { clientId, year, month } }, select: { id: true } }),
  ]);
  const items: WorkflowItem[] = [];
  const syncLine = async (key: string, label: string, list: typeof accounts, none: ItemState): Promise<WorkflowItem> => {
    if (!list.length) return { key, label, state: none, detail: none === "MISSING" ? "Register the business's accounts in Banking & Reconciliation" : "No accounts of this kind" };
    const s = await Promise.all(list.map((a) => accountSynced(clientId, a, year, month, today)));
    const missing = s.filter((x) => x.state === "MISSING");
    if (!due) return { key, label, state: "NOT_DUE", detail: `${list.length} account${list.length === 1 ? "" : "s"} · month in progress` };
    if (!missing.length) return { key, label, state: "DONE", detail: `${list.length} of ${list.length} account${list.length === 1 ? "" : "s"} synced` };
    return { key, label, state: "MISSING", detail: `${list.length - missing.length} of ${list.length} synced · ${missing.map((x, i) => `${registryLabel(list[s.indexOf(x)] ?? list[i])}: ${x.detail}`).slice(0, 3).join("; ")}` };
  };
  items.push(await syncLine("BANK_SYNC", "Bank transactions synchronized", accounts.filter((a) => BANK_TYPES.includes(a.accountType)), "MISSING"));
  items.push(await syncLine("CARD_SYNC", "Credit card transactions synchronized", accounts.filter((a) => CARD_TYPES.includes(a.accountType)), "NA"));

  // Receipts / supporting documents: outstanding requests for the month, and amounts parked in Ask My Accountant.
  const receiptReqs = await prisma.documentRequest.count({ where: { clientId, kind: { in: ["SUPPORTING", "MONTHLY", "GENERAL"] }, status: { in: ["DRAFT", "OPEN"] }, OR: [{ periodId: period?.id ?? "-" }, { periodStart: { gte: from, lte: to } }] } });
  const parked = await prisma.journalLine.aggregate({ where: { entry: { clientId, date: { gte: from, lte: to } }, account: { subtype: "SUSPENSE" } }, _sum: { debitCents: true, creditCents: true } });
  const parkedCents = (parked._sum.debitCents ?? 0) - (parked._sum.creditCents ?? 0);
  items.push({
    key: "RECEIPTS", label: "Missing receipts or supporting documents",
    state: receiptReqs || parkedCents ? "MISSING" : due ? "DONE" : "NOT_DUE",
    detail: receiptReqs ? `${receiptReqs} request${receiptReqs === 1 ? "" : "s"} outstanding` : parkedCents ? `${usd(parkedCents)} in Ask My Accountant needs support` : "Nothing outstanding",
  });

  if (profile?.payroll) {
    const pr = await prisma.document.count({ where: { clientId, deletedAt: null, docType: "PAYROLL_REPORT", OR: [{ periodId: period?.id ?? "-" }, { year, month }, { periodStart: { lte: to }, periodEnd: { gte: from } }] } });
    items.push({ key: "PAYROLL", label: `Payroll data received${profile.payrollProvider ? ` (${profile.payrollProvider})` : ""}`, state: pr ? "DONE" : due ? "MISSING" : "NOT_DUE", detail: pr ? `${pr} payroll report${pr === 1 ? "" : "s"} received` : "Payroll reports not received" });
  }

  const [rows, open] = await Promise.all([
    prisma.bankTransaction.count({ where: { clientId, date: { gte: from, lte: to }, status: { not: "EXCLUDED" } } }),
    prisma.bankTransaction.count({ where: { clientId, date: { gte: from, lte: to }, status: "UNREVIEWED" } }),
  ]);
  items.push({ key: "CATEGORIZED", label: "Transactions categorized", state: !rows ? (due ? "MISSING" : "NOT_DUE") : open ? "IN_PROGRESS" : "DONE", detail: !rows ? "No transactions for the month yet" : open ? `${open} of ${rows} still to categorize` : `All ${rows} categorized` });

  const recon = await monthlyAccountProgress({ id: "system:workflow", role: "ADMIN", name: "Coetha", email: "" }, clientId, year, month, { today });
  const reds = recon.rows.filter((r) => r.light === "RED").length;
  items.push({
    key: "RECONCILED", label: "Accounts reconciled",
    state: !recon.total ? (due ? "MISSING" : "NOT_DUE") : !due ? "NOT_DUE" : recon.reconciled === recon.total ? "DONE" : reds ? "MISSING" : "IN_PROGRESS",
    detail: recon.total ? `${recon.reconciled} of ${recon.total} accounts reconciled${reds ? ` · ${reds} with an issue or missing statement` : ""}` : "No accounts to reconcile",
  });

  const reportMonth = reportsDue(profile?.frequency ?? "MONTHLY", month);
  const reports = period ? await prisma.document.findMany({ where: { periodId: period.id, deletedAt: null, supersededAt: null, category: "BOOKKEEPING", reportType: { in: ["FINANCIAL_PACKET", "PROFIT_AND_LOSS", "BALANCE_SHEET"] } }, select: { reviewStatus: true, visibility: true } }) : [];
  if (!reportMonth) {
    items.push({ key: "PREPARED", label: "Financial statements prepared", state: "NA", detail: "Quarterly client: statements at quarter end" });
  } else {
    items.push({ key: "PREPARED", label: "Financial statements prepared", state: reports.length ? "DONE" : due ? "IN_PROGRESS" : "NOT_DUE", detail: reports.length ? `${reports.length} statement${reports.length === 1 ? "" : "s"} prepared` : "Not prepared yet" });
    const waiting = reports.filter((r) => r.reviewStatus === "AWAITING_REVIEW").length;
    const approved = reports.length > 0 && reports.every((r) => r.reviewStatus === "APPROVED" || r.visibility === "PUBLISHED");
    items.push({ key: "APPROVAL", label: "Awaiting Tabitha's approval", state: approved ? "DONE" : waiting ? "IN_PROGRESS" : "NOT_DUE", detail: approved ? "Approved by Tabitha" : waiting ? `${waiting} statement${waiting === 1 ? "" : "s"} waiting for Tabitha` : "After statements are prepared" });
    const released = reports.length > 0 && reports.every((r) => r.visibility === "PUBLISHED");
    items.push({ key: "RELEASED", label: "Financial statements released to client", state: released ? "DONE" : approved ? "IN_PROGRESS" : "NOT_DUE", detail: released ? "Released to the client portal" : approved ? "Approved — ready to release" : "After Tabitha approves" });
  }
  const shown = items.filter((i) => i.state !== "NA");
  const done = shown.filter((i) => i.state === "DONE").length;
  return { year, month, items: shown, done, total: shown.length, percent: shown.length ? Math.round((done / shown.length) * 100) : 0, missing: shown.filter((i) => i.state === "MISSING").length, recon };
}

// --- Coetha's monitor ---------------------------------------------------------------------------

const monthLabel = (y: number, m: number) => `${MONTH_NAMES[m - 1]} ${y}`;
const PROCESSORS = /\b(STRIPE|SQUARE|SQ |PAYPAL|SHOPIFY|CLOVER|TOAST|VENMO BUSINESS)\b/;
const TRANSFER_WORDS = /\b(TRANSFER|XFER|ZELLE|WIRE|ACH TRANSFER|ONLINE TRANSFER)\b/;
const LOAN_WORDS = /\b(LOAN|SBA|EIDL|LINE OF CREDIT|LOC)\b/;
const DRAW_WORDS = /\b(OWNER DRAW|DRAW|TRANSFER TO .*(SAVINGS|PERSONAL)|ZELLE TO|VENMO|CASH APP|ATM WITHDRAWAL)\b/;

type Rec = {
  key: string; category: string; title: string; found: string; why: string; correction: string; impact: string;
  accounts: { id: string; code: string; name: string }[]; transactions: { id: string; date: string; amountCents: number; description: string }[]; documents: { id: string; title: string }[];
  entry?: { date: string; memo: string; lines: { accountId: string; accountCode: string; accountName: string; debitCents: number; creditCents: number; description: string }[] } | null;
};

/** Recommendations with full rationale, from the books and the tax classification (rules; nothing is posted). */
async function buildRecommendations(clientId: string, y: number, m: number): Promise<Rec[]> {
  const out: Rec[] = [];
  const book = await prisma.ledgerBook.findUnique({ where: { clientId } });
  if (!book) return out;
  const tp = await taxProfile(clientId);
  const accounts = await prisma.ledgerAccount.findMany({ where: { clientId, active: true } });
  const acct = (id: string) => accounts.find((a) => a.id === id);
  const ref = (a: { id: string; code: string; name: string } | undefined) => (a ? [{ id: a.id, code: a.code, name: a.name }] : []);
  const from = toDate(`${y}-${pad(m)}-01`), to = toDate(monthEnd(y, m));
  const posted = await prisma.bankTransaction.findMany({
    where: { clientId, status: "POSTED", date: { gte: from, lte: to } },
    include: { journalEntry: { include: { lines: true, reversedBy: { select: { id: true } } } }, account: true },
  });
  const cards = await cardRefs(clientId);
  const expenseLine = (t: (typeof posted)[number]) => (t.journalEntry && !t.journalEntry.reversedBy ? t.journalEntry.lines.find((l) => l.accountId !== t.accountId && acct(l.accountId)?.type === "EXPENSE" && acct(l.accountId)?.subtype !== "SUSPENSE") : undefined);

  // Card / loan payments booked as an expense (double counts the card's charges, or books loan principal as expense).
  for (const t of posted) {
    if (t.account.subtype !== "BANK" || t.amountCents >= 0) continue;
    const line = expenseLine(t);
    if (!line) continue;
    const card = cardPaymentTarget(t.description, t.amountCents, cards);
    const loanish = !card && LOAN_WORDS.test(normDesc(t.description));
    if (!card && !loanish) continue;
    const exp = acct(line.accountId)!;
    const liab = card ? acct(card.ledgerAccountId) : accounts.find((a) => a.subtype === "LOAN") ?? accounts.find((a) => a.type === "LIABILITY" && /loan/i.test(a.name));
    const amt = -t.amountCents;
    out.push({
      key: `pay-as-expense:${t.id}`, category: card?.accountType === "CREDIT_CARD" ? "CARD_PAYMENT_DOUBLE_COUNTED" : "LOAN_PAYMENT_AS_EXPENSE",
      title: card?.accountType === "CREDIT_CARD" ? "Credit card payment booked as an expense" : "Loan payment booked as an expense",
      found: `${ymdOf(t.date)} “${t.description}” (${usd(amt)}) from ${t.account.name} was posted to ${exp.code} ${exp.name}.`,
      why: card?.accountType === "CREDIT_CARD" ? "The purchases on the card were already expensed when the card charges were categorized. Expensing the payment counts them twice." : "Loan principal is a reduction of the loan liability, not an expense. Only the interest portion is an expense.",
      correction: liab ? `Reclassify ${usd(amt)} from ${exp.code} ${exp.name} to ${liab.code} ${liab.name}${loanish ? " (then move the interest portion back to interest expense from the loan statement)" : ""}.` : "Reclassify the payment to the liability account it paid (add the account in Banking & Reconciliation first).",
      impact: `Expenses and net income are ${card ? "overstated" : "overstated"} by ${usd(amt)} for ${monthLabel(y, m)}; the ${card ? "card" : "loan"} liability is overstated by ${usd(amt)} on the Balance Sheet.`,
      accounts: [...ref(exp), ...ref(liab)], transactions: [{ id: t.id, date: ymdOf(t.date), amountCents: t.amountCents, description: t.description }], documents: [],
      entry: liab ? { date: ymdOf(t.date), memo: `Reclassify ${card ? "card" : "loan"} payment ${ymdOf(t.date)} from expense to liability`, lines: [{ accountId: liab.id, accountCode: liab.code, accountName: liab.name, debitCents: amt, creditCents: 0, description: t.description.slice(0, 120) }, { accountId: exp.id, accountCode: exp.code, accountName: exp.name, debitCents: 0, creditCents: amt, description: "Reclassification" }] } : null,
    });
  }

  // Owner withdrawals posted as expenses, judged by the tax classification.
  const cls = tp.classification as TaxClassification | null;
  const equityFor = cls === "FORM_1120S" ? accounts.find((a) => a.type === "EQUITY" && /distribution/i.test(a.name)) : cls === "FORM_1065" ? accounts.find((a) => a.type === "EQUITY" && /partner/i.test(a.name)) : accounts.find((a) => a.subtype === "OWNER_DRAW");
  const word = cls === "FORM_1120S" ? "shareholder distribution" : cls === "FORM_1065" ? "partner draw" : "owner draw";
  for (const t of posted) {
    if (t.amountCents >= 0 || !DRAW_WORDS.test(normDesc(t.description))) continue;
    const line = expenseLine(t);
    if (!line) continue;
    const exp = acct(line.accountId)!;
    const amt = -t.amountCents;
    out.push({
      key: `draw-as-expense:${t.id}`, category: cls === "FORM_1120S" ? "SHAREHOLDER_DISTRIBUTION" : cls === "FORM_1065" ? "PARTNER_DRAW" : "OWNER_DRAW",
      title: `Possible ${word} recorded as an expense`,
      found: `${ymdOf(t.date)} “${t.description}” (${usd(amt)}) was posted to ${exp.code} ${exp.name}.`,
      why: cls ? CLASSIFICATION_RULES[cls] : "Money the owner takes out of the business is equity, not an expense.",
      correction: equityFor ? `If it was a personal withdrawal, reclassify ${usd(amt)} to ${equityFor.code} ${equityFor.name}.` : `If it was a personal withdrawal, reclassify ${usd(amt)} to a ${word}s equity account (add one to the chart of accounts first).`,
      impact: `Expenses overstated and net income understated by ${usd(amt)}; equity ${word}s understated by the same amount.`,
      accounts: [...ref(exp), ...ref(equityFor)], transactions: [{ id: t.id, date: ymdOf(t.date), amountCents: t.amountCents, description: t.description }], documents: [],
      entry: equityFor ? { date: ymdOf(t.date), memo: `Reclassify ${word} ${ymdOf(t.date)}`, lines: [{ accountId: equityFor.id, accountCode: equityFor.code, accountName: equityFor.name, debitCents: amt, creditCents: 0, description: t.description.slice(0, 120) }, { accountId: exp.id, accountCode: exp.code, accountName: exp.name, debitCents: 0, creditCents: amt, description: "Reclassification" }] } : null,
    });
  }

  // S corporation reasonable compensation; partner capital accounts.
  const profile = await prisma.bookkeepingProfile.findUnique({ where: { clientId }, select: { payroll: true } });
  if (cls === "FORM_1120S" && !profile?.payroll) {
    const dist = await prisma.journalLine.aggregate({ where: { entry: { clientId, date: { gte: toDate(`${y}-01-01`), lte: to } }, account: { type: "EQUITY", OR: [{ subtype: "OWNER_DRAW" }, { name: { contains: "istribution", mode: "insensitive" } }] } }, _sum: { debitCents: true } });
    const total = dist._sum.debitCents ?? 0;
    if (total > 0) out.push({ key: `scorp-comp:${y}`, category: "SCORP_REASONABLE_COMP", title: "S corporation distributions with no officer payroll", found: `${usd(total)} in owner withdrawals / distributions so far in ${y}, and this business doesn't run payroll.`, why: CLASSIFICATION_RULES.FORM_1120S, correction: "Review officer compensation with the owner; set up payroll for reasonable compensation if the owner works in the business.", impact: "No change to the statements until payroll is set up; a tax-compliance risk for the S corporation.", accounts: [], transactions: [], documents: [], entry: null });
  }
  if (cls === "FORM_1065" && !accounts.some((a) => a.type === "EQUITY" && /partner/i.test(a.name))) {
    out.push({ key: "partner-capital", category: "PARTNER_CAPITAL", title: "Partner capital accounts not set up", found: "The chart of accounts has no partner capital or partner draw accounts.", why: CLASSIFICATION_RULES.FORM_1065, correction: "Add a capital account and a draws account for each partner, and move owner equity balances to them.", impact: "Equity is presented as one owner balance instead of by partner.", accounts: accounts.filter((a) => a.type === "EQUITY" && a.subtype !== "RETAINED_EARNINGS").map((a) => ({ id: a.id, code: a.code, name: a.name })), transactions: [], documents: [], entry: null });
  }
  if (cls === "SCHEDULE_C" && accounts.some((a) => a.type === "EQUITY" && /distribution|partner/i.test(a.name))) {
    out.push({ key: "schc-equity", category: "CLASSIFICATION_INCONSISTENCY", title: "Equity accounts don't match a Schedule C business", found: "The chart has distribution or partner equity accounts, but the business is classified as Schedule C.", why: CLASSIFICATION_RULES.SCHEDULE_C, correction: "Use Owner's Capital / Contributions and Owner's Draws; move balances from the other equity accounts.", impact: "Equity presentation only.", accounts: accounts.filter((a) => a.type === "EQUITY" && /distribution|partner/i.test(a.name)).map((a) => ({ id: a.id, code: a.code, name: a.name })), transactions: [], documents: [], entry: null });
  }

  // Unreconciled accounts and possible duplicates.
  const recs = await prisma.accountReconciliation.findMany({ where: { clientId, year: y, month: m, status: "EXCEPTION" }, include: { bookkeepingAccount: { include: { ledgerAccount: true } } } });
  for (const r of recs) {
    out.push({ key: `unreconciled:${r.bookkeepingAccountId}:${y}-${pad(m)}`, category: "UNRECONCILED", title: `${registryLabel(r.bookkeepingAccount)} doesn't reconcile for ${monthLabel(y, m)}`, found: r.exceptions.join(" ") || "The statement and the imported activity don't agree.", why: "An account that doesn't reconcile means a transaction is missing, duplicated or recorded in the wrong period, so the Balance Sheet cash or card balance may be wrong.", correction: "Compare the statement line by line with the imported transactions; import or add what's missing and exclude duplicates.", impact: r.differenceCents ? `${usd(Math.abs(r.differenceCents))} unexplained difference in the account balance.` : "Account balance unverified.", accounts: ref(r.bookkeepingAccount.ledgerAccount ?? undefined), transactions: [], documents: r.statementDocumentId ? [{ id: r.statementDocumentId, title: "Statement" }] : [], entry: null });
  }
  const dupes = await prisma.bankTransaction.findMany({ where: { clientId, flag: "POSSIBLE_DUPLICATE", status: { not: "EXCLUDED" }, date: { gte: from, lte: to } }, take: 20 });
  if (dupes.length) out.push({ key: `dupes:${y}-${pad(m)}:${dupes.length}`, category: "DUPLICATE", title: `${dupes.length} possible duplicate transaction${dupes.length === 1 ? "" : "s"}`, found: dupes.slice(0, 5).map((d) => `${ymdOf(d.date)} ${usd(d.amountCents)} “${d.description}”`).join("; "), why: "The same transaction may have come in from both the bank feed and a statement import.", correction: "Exclude the duplicate row (keep one) before posting.", impact: `Up to ${usd(dupes.reduce((n, d) => n + Math.abs(d.amountCents), 0))} could be counted twice.`, accounts: [], transactions: dupes.map((d) => ({ id: d.id, date: ymdOf(d.date), amountCents: d.amountCents, description: d.description })), documents: [], entry: null });
  return out;
}

/** Classification consistency: the recorded entity type implies a different (or missing) classification. */
async function classificationRecommendation(clientId: string) {
  const tp = await taxProfile(clientId);
  const implied = classificationForEntity(tp.entityType);
  if (!implied || implied === tp.classification) return null;
  return {
    key: `classification:${tp.classification ?? "none"}->${implied}`,
    current: tp.classification, recommended: implied,
    found: tp.classification ? `The business is classified as ${TAX_CLASSIFICATIONS[tp.classification].label}, but its recorded entity type is ${tp.entityType}.` : `No tax classification is set; the recorded entity type is ${tp.entityType}.`,
    why: "Coetha applies different equity and compensation rules for each classification (owner draws, shareholder distributions, partner draws, guaranteed payments, payroll).",
    correction: `Set the classification to ${TAX_CLASSIFICATIONS[implied].label} if that is how the business files.`,
    impact: "No change to the numbers; equity and compensation are reviewed under the right rules.",
  };
}

/**
 * Coetha's monthly monitor for ONE business. Safe to run repeatedly (everything is keyed):
 * 1. prepares every account's reconciliation;
 * 2. retrieves statements where an adapter can, otherwise drafts a targeted request;
 * 3. drafts targeted requests for missing payroll reports, unsupported large expenses,
 *    unexplained deposits, unidentified transfers, merchant statements, loan agreements and
 *    prior records; sends them only if Tabitha's auto-send setting is on;
 * 4. records recommendations (with full rationale) and classification suggestions for Tabitha.
 */
export async function runWorkflowMonitor(actor: Actor | null, clientId: string, year: number, month: number, opts: { today?: string } = {}) {
  if (actor) await assertLedger(actor, clientId);
  const today = opts.today ?? todayCentral();
  const ended = today > monthEnd(year, month);
  const ml = monthLabel(year, month);
  const ym = `${year}-${pad(month)}`;
  const drafted: string[] = [];
  const draft = async (input: Parameters<typeof createClientRequest>[2]) => {
    const r = await createClientRequest(null, clientId, input, { send: false, source: "COETHA" });
    if (r.created && r.request) drafted.push(r.request.id);
  };
  const accounts = await prisma.bookkeepingAccount.findMany({ where: { clientId, active: true, parentAccountId: null, monitored: true } });
  // 1–2. Reconciliations and statements.
  for (const a of accounts) {
    const rec = await prepareReconciliation(clientId, a.id, year, month, { today });
    if (!rec || !ended || rec.statementStatus !== "MISSING" || rec.endingBalanceCents != null) continue;
    const w = statementWindow(year, month, a.statementDay);
    const feed = a.ledgerAccountId ? await prisma.bankConnectionAccount.findFirst({ where: { ledgerAccountId: a.ledgerAccountId, connection: { clientId, status: "ACTIVE" } }, select: { connectionId: true, providerAccountId: true } }) : null;
    const got = feed ? await statementSource().fetchMonthly({ connectionId: feed.connectionId, providerAccountId: feed.providerAccountId, year, month }) : { available: false as const, reason: "Not connected" };
    if (got.available) {
      const stored = await storeDocumentFile(got.pdf, `statement-${ym}.pdf`, { system: "statement-retrieval" }, clientId).catch(() => null);
      if (stored) {
        const isCard = a.accountType !== "CHECKING" && a.accountType !== "SAVINGS";
        await prisma.$transaction(async (tx) => {
          const file = await tx.storedFile.create({ data: stored.fileData });
          await tx.document.create({ data: { clientId, category: "BOOKKEEPING", title: `${registryLabel(a)} statement — ${ml}`, year, month, visibility: "STAFF_ONLY", fileId: file.id, scanStatus: stored.scan, ...stored.scanMeta, docType: isCard ? "CARD_STATEMENT" : "BANK_STATEMENT", bookkeepingAccountId: a.id, periodStart: toDate(w.start), periodEnd: toDate(w.end), reportPeriodType: "MONTH", retainUntil: await retentionDate("BOOKKEEPING") } });
        });
        if (got.endingBalanceCents != null) await prisma.accountReconciliation.update({ where: { id: rec.id }, data: { endingBalanceCents: got.endingBalanceCents, balanceSource: "PLAID_STATEMENT" } });
        await audit(prisma, { actorId: null, action: "coetha.statement_retrieved", entityType: "BookkeepingAccount", entityId: a.id, clientId, details: { month: ym, source: statementSource().name } });
        await prepareReconciliation(clientId, a.id, year, month, { today });
        continue;
      }
    }
    const isCard = a.accountType !== "CHECKING" && a.accountType !== "SAVINGS";
    await draft({
      kind: "STATEMENT", docType: isCard ? "CARD_STATEMENT" : "BANK_STATEMENT", bookkeepingAccountId: a.id, start: w.start, end: w.end, draftKey: `stmt:${a.id}:${ym}`,
      title: `${isCard ? "Credit card" : "Bank"} statement — ${registryLabel(a)} — ${ml}`,
      reason: `Needed to reconcile ${registryLabel(a)} for ${ml}: ${feed ? "the bank feed has the transactions, but not the statement's ending balance" : "this account isn't connected, so the statement is the only record"}.`,
    });
  }
  if (ended) {
    const from = toDate(`${ym}-01`), to = toDate(monthEnd(year, month));
    const profile = await prisma.bookkeepingProfile.findUnique({ where: { clientId } });
    // Payroll reports.
    if (profile?.payroll) {
      const pr = await prisma.document.count({ where: { clientId, deletedAt: null, docType: "PAYROLL_REPORT", OR: [{ year, month }, { periodStart: { lte: to }, periodEnd: { gte: from } }] } });
      if (!pr) await draft({ kind: "MONTHLY", docType: "PAYROLL_REPORT", start: `${ym}-01`, end: monthEnd(year, month), draftKey: `payroll:${ym}`, title: `Payroll reports${profile.payrollProvider ? ` (${profile.payrollProvider})` : ""} — ${ml}`, reason: `Needed to record ${ml} payroll: the payroll register and tax liability reports for each pay date.` });
    }
    const rows = await prisma.bankTransaction.findMany({ where: { clientId, status: "UNREVIEWED", date: { gte: from, lte: to } }, include: { account: true } });
    const own = new Set(rows.map((r) => r.accountId));
    const isPair = (r: (typeof rows)[number]) => rows.some((o) => o.id !== r.id && o.accountId !== r.accountId && own.has(o.accountId) && o.amountCents === -r.amountCents && Math.abs(o.date.getTime() - r.date.getTime()) <= 5 * 86_400_000);
    const cards = await cardRefs(clientId);
    const list = (xs: typeof rows) => xs.slice(0, 10).map((x) => `${ymdOf(x.date)} ${usd(x.amountCents)} “${x.description}” (${x.account.name})`).join("; ");
    const big = rows.filter((r) => r.amountCents <= -50_000 && !isPair(r) && !cardPaymentTarget(r.description, r.amountCents, cards) && !TRANSFER_WORDS.test(normDesc(r.description)));
    if (big.length) await draft({ kind: "SUPPORTING", docType: "RECEIPTS", start: `${ym}-01`, end: monthEnd(year, month), draftKey: `receipts:${ym}`, title: `Receipts for ${big.length} purchase${big.length === 1 ? "" : "s"} — ${ml}`, reason: `We need a receipt or invoice for these to categorize them correctly: ${list(big)}.` });
    const deposits = rows.filter((r) => r.amountCents >= 50_000 && r.account.subtype === "BANK" && !isPair(r) && !PROCESSORS.test(normDesc(r.description)));
    if (deposits.length) await draft({ kind: "SUPPORTING", docType: "BK_OTHER", start: `${ym}-01`, end: monthEnd(year, month), draftKey: `deposits:${ym}`, title: `Explain ${deposits.length} deposit${deposits.length === 1 ? "" : "s"} — ${ml}`, reason: `Please tell us what these deposits were (sale, loan, owner money, refund…) and send any supporting document: ${list(deposits)}.` });
    const transfers = rows.filter((r) => r.amountCents < 0 && TRANSFER_WORDS.test(normDesc(r.description)) && !isPair(r));
    if (transfers.length) await draft({ kind: "SUPPORTING", docType: "BK_OTHER", start: `${ym}-01`, end: monthEnd(year, month), draftKey: `transfers:${ym}`, title: `Identify ${transfers.length} transfer${transfers.length === 1 ? "" : "s"} — ${ml}`, reason: `These went to an account we don't have on file. Tell us where they went (another business account, a loan, the owner…): ${list(transfers)}.` });
    const proc = await prisma.bankTransaction.count({ where: { clientId, date: { gte: from, lte: to }, amountCents: { gt: 0 }, OR: ["STRIPE", "SQUARE", "PAYPAL", "SHOPIFY", "CLOVER", "TOAST"].map((w) => ({ description: { contains: w, mode: "insensitive" as const } })) } });
    if (proc) await draft({ kind: "SUPPORTING", docType: "MERCHANT_STATEMENT", start: `${ym}-01`, end: monthEnd(year, month), draftKey: `merchant:${ym}`, title: `Merchant processing statement — ${ml}`, reason: `${proc} card-processor payout${proc === 1 ? "" : "s"} arrived in ${ml}. The processor's monthly statement shows gross sales, fees and refunds, so sales are recorded at the full amount.` });
    for (const a of accounts.filter((x) => x.accountType === "LOAN" || x.accountType === "LINE_OF_CREDIT")) {
      const has = await prisma.document.count({ where: { clientId, deletedAt: null, bookkeepingAccountId: a.id, docType: "LOAN_AGREEMENT" } });
      if (!has) await draft({ kind: "SUPPORTING", docType: "LOAN_AGREEMENT", bookkeepingAccountId: a.id, draftKey: `loan:${a.id}`, title: `Loan agreement — ${registryLabel(a)}`, reason: "Needed to record the loan correctly: the original amount, interest rate and payment schedule (to split each payment into principal and interest)." });
    }
    // Prior records: months between the books' opening date and the first transaction of each account.
    const book = await prisma.ledgerBook.findUnique({ where: { clientId } });
    if (book?.openingDate) {
      for (const a of accounts.filter((x) => x.ledgerAccountId)) {
        const first = await prisma.bankTransaction.findFirst({ where: { accountId: a.ledgerAccountId! }, orderBy: { date: "asc" }, select: { date: true } });
        if (!first) continue;
        const firstMonth = ymdOf(first.date).slice(0, 7), openMonth = ymdOf(book.openingDate).slice(0, 7);
        if (firstMonth <= openMonth) continue;
        const endPrev = ymdOf(new Date(toDate(`${firstMonth}-01`).getTime() - 86_400_000));
        const isCard = a.accountType !== "CHECKING" && a.accountType !== "SAVINGS";
        await draft({ kind: "HISTORICAL", docType: isCard ? "CARD_STATEMENT" : "BANK_STATEMENT", bookkeepingAccountId: a.id, start: `${openMonth}-01`, end: endPrev, draftKey: `hist:${a.id}:${openMonth}`, title: `Prior statements — ${registryLabel(a)} — ${openMonth} to ${endPrev.slice(0, 7)}`, reason: `The bank feed starts in ${firstMonth}, but the books open in ${openMonth}. These statements fill the gap.` });
      }
    }
    // Year-end tax documents: drafted in January only, in their own section.
    const w = yearEndWindow(new Date(`${today}T18:00:00Z`));
    if (w.open && today.slice(5, 7) === "01") {
      const forms = ["NEC_1099", "K_1099", ...(profile?.payroll ? ["W2_W3"] : [])];
      for (const f of forms) {
        await draft({ kind: "YEAR_END", docType: f, taxYear: w.taxYear, draftKey: `ye:${w.taxYear}:${f}`, title: `${w.taxYear} ${YEAR_END_FORMS[f as keyof typeof YEAR_END_FORMS]}`, reason: `Needed for the ${w.taxYear} year-end tax filings.` });
      }
    }
  }
  // Auto-send only when Tabitha turned it on.
  let sent = 0;
  if (drafted.length && (await coethaAutoSendOn())) {
    for (const id of drafted) { await sendClientRequest(null, clientId, id); sent++; }
  }
  // Requests answered since last time: Coetha notes the arrival and resumes the review.
  const arrived = await prisma.documentRequest.findMany({ where: { clientId, source: "COETHA", status: "SUBMITTED" }, select: { id: true } });
  for (const r of arrived) {
    const seen = await prisma.auditLog.count({ where: { entityType: "DocumentRequest", entityId: r.id, action: "coetha.request_received" } });
    if (!seen) await audit(prisma, { actorId: null, action: "coetha.request_received", entityType: "DocumentRequest", entityId: r.id, clientId });
  }
  // 4. Recommendations for Tabitha.
  const recs = await recordRecommendations(clientId, year, month);
  await audit(prisma, { actorId: actor?.id ?? null, action: "coetha.workflow_checked", entityType: "Client", entityId: clientId, clientId, details: { month: ym, drafted: drafted.length, sent, recommendations: recs } });
  return { drafted: drafted.length, sent, recommendations: recs };
}

/** Writes new recommendations as proposals (kind RECOMMENDATION / CLASSIFICATION). Never repeats one already decided. */
async function recordRecommendations(clientId: string, y: number, m: number) {
  if (!(await prisma.ledgerBook.count({ where: { clientId } }))) return 0;
  const recs = await buildRecommendations(clientId, y, m);
  const cls = await classificationRecommendation(clientId);
  const items: { kind: string; key: string; payload: Prisma.InputJsonValue; reason: string; bankTransactionId?: string | null }[] = [
    ...recs.map((r) => ({ kind: "RECOMMENDATION", key: r.key, payload: r as unknown as Prisma.InputJsonValue, reason: r.why.slice(0, 600), bankTransactionId: r.transactions.length === 1 ? r.transactions[0].id : null })),
    ...(cls ? [{ kind: "CLASSIFICATION", key: cls.key, payload: cls as unknown as Prisma.InputJsonValue, reason: cls.why }] : []),
  ];
  const fresh = [];
  for (const it of items) {
    const exists = await prisma.coethaProposal.count({ where: { clientId, kind: it.kind, status: { in: ["PROPOSED", "APPROVED", "REJECTED"] }, payload: { path: ["key"], equals: it.key } } });
    if (!exists) fresh.push(it);
  }
  if (!fresh.length) return 0;
  const hash = createHash("sha256").update(JSON.stringify(fresh.map((f) => f.key))).digest("hex");
  const run = await prisma.coethaRun.create({ data: { clientId, trigger: "MONITOR", model: "rules", status: "OK", finishedAt: new Date(), inputHash: hash, proposals: fresh.length } });
  await prisma.coethaProposal.createMany({ data: fresh.map((f) => ({ clientId, runId: run.id, kind: f.kind, payload: f.payload, reason: f.reason, model: "rules", inputHash: hash, bankTransactionId: f.bankTransactionId ?? null })) });
  return fresh.length;
}

/** Hourly cron: every business the office keeps books for, its current work month, once a day. */
export async function runDailyWorkflowMonitor(now = new Date()) {
  const ids = await officeBookClientIds();
  let ran = 0, failed = 0;
  for (const clientId of ids) {
    const last = await prisma.auditLog.findFirst({ where: { clientId, action: "coetha.workflow_checked" }, orderBy: { createdAt: "desc" }, select: { createdAt: true } });
    if (last && now.getTime() - last.createdAt.getTime() < 20 * 3600_000) continue;
    const p = await prisma.bookkeepingProfile.findUnique({ where: { clientId }, select: { frequency: true } });
    const { year, month } = workMonth(p?.frequency ?? "MONTHLY", now);
    try { await runWorkflowMonitor(null, clientId, year, month); ran++; } catch { failed++; }
    if (ran + failed >= 25) break;
  }
  return { ran, failed };
}

/** What Coetha is working on right now, for the Overview and the management screen. */
export async function coethaCurrentWork(clientId: string) {
  const [proposals, drafts, outstanding, recsWaiting, lastCheck, lastRun] = await Promise.all([
    prisma.coethaProposal.groupBy({ by: ["kind"], where: { clientId, status: "PROPOSED" }, _count: true }),
    prisma.documentRequest.count({ where: { clientId, status: "DRAFT" } }),
    prisma.documentRequest.count({ where: { clientId, status: "OPEN", kind: { not: "YEAR_END" } } }),
    prisma.accountReconciliation.count({ where: { clientId, status: "READY" } }),
    prisma.auditLog.findFirst({ where: { clientId, action: "coetha.workflow_checked" }, orderBy: { createdAt: "desc" }, select: { createdAt: true } }),
    prisma.coethaRun.findFirst({ where: { clientId }, orderBy: { startedAt: "desc" }, select: { startedAt: true, trigger: true, status: true } }),
  ]);
  const by = Object.fromEntries(proposals.map((p) => [p.kind, p._count])) as Record<string, number>;
  return { proposals: by, proposalTotal: proposals.reduce((n, p) => n + p._count, 0), drafts, outstanding, recsWaiting, lastCheck: lastCheck?.createdAt ?? null, lastRun };
}

export const LIGHT_CLASS: Record<Light, string> = { GREEN: "bg-emerald-600", RED: "bg-red-600", YELLOW: "bg-amber-400", GRAY: "bg-slate-300" };
