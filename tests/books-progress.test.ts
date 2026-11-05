import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { authorizeCoetha, makeUser, managed, managedOnly, prisma, resetDb } from "./db";
import type { Actor } from "@/lib/auth/actor";
import { ForbiddenError } from "@/lib/auth/actor";
import type { PortalActor } from "@/lib/portal/session";
import { createClient } from "@/lib/services/clients";
import { acceptPortalInvite, invitePortalUser } from "@/lib/services/portal-accounts";
import { categorizeBankTransaction, importBankCsv, reconcileAccount, setupLedger } from "@/lib/services/ledger";
import { completeBankLink, mapBankAccount, syncConnection } from "@/lib/services/banking";
import { prepareReconciliation } from "@/lib/services/bank-accounts";
import { approveReport, bookkeepingWorkspace, deliverReport, enrollExistingClient, openWorkPeriod, setChecklistItem, submitReportForReview, uploadMonthlyReport } from "@/lib/services/bookkeeping-clients";
import { createDocumentRequest } from "@/lib/services/bookkeeping";
import { staffUploadStatement } from "@/lib/services/client-requests";
import { portalUploadDocument } from "@/lib/services/documents";
import { businessDashboardFor, portalBusinessDashboard } from "@/lib/services/portal-business";
import { booksProgressFromFacts, computeBooksProgress, engagementPeriod, type BooksFacts, type BooksProgress } from "@/lib/services/books-progress";
import { accessibleClients, allowedCategories, requireClientAccess } from "@/lib/portal/access";
import { homeKind, portalBankFeed } from "@/lib/services/portal-business";
import { portalLicensesPage, portalPayrollPage, portalYearEndPage } from "@/lib/services/portal-business-pages";
import { portalClientInvoicing } from "@/lib/services/portal-client-invoicing";
import { runWorkflowMonitor } from "@/lib/services/monthly-workflow";
import { PortalHomeView } from "@/components/portal/home-view";
import { BooksProgressCard } from "@/components/portal/books-progress";
import { BusinessDashboardView } from "@/components/portal/business-dashboard";
import type { PlaidTxn } from "@/lib/plaid";

/**
 * The client's Monthly Bookkeeping Progress Tracker. Fictional businesses, people, banks and
 * transactions only; the bank feed is a simulated Plaid sandbox (nothing leaves this test) and the
 * malware scanner is a stub.
 */

let staff: Actor | null = null;
vi.mock("@/lib/auth/session", async (orig) => ({ ...(await orig<object>()), requireUser: async () => staff, getCurrentUser: async () => staff }));
// The month picker is a client component that uses the router; rendering outside Next needs a stand-in.
vi.mock("next/navigation", async (orig) => ({ ...(await orig<object>()), useRouter: () => ({ push() {}, replace() {}, refresh() {} }) }));
const { default: PortalPreview } = await import("@/app/(app)/clients/[id]/portal-preview/page");

// --- Simulated services ---------------------------------------------------------------------------

let scanner: "clean" | "down" = "clean";
let plaidPages: PlaidTxn[][] = [];
const ACCESS = "access-sandbox-fictional-books";

beforeEach(async () => {
  await resetDb();
  staff = null;
  scanner = "clean";
  plaidPages = [];
  vi.stubEnv("MALWARE_SCAN_URL", "https://scanner.test/scan");
  vi.stubEnv("PLAID_CLIENT_ID", "fictional-client-id");
  vi.stubEnv("PLAID_SECRET", "fictional-sandbox-secret");
  vi.stubEnv("PLAID_ENV", "sandbox");
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });
    if (String(url).startsWith("https://scanner.test/")) return scanner === "clean" ? json({ clean: true }) : new Response("down", { status: 503 });
    if (!String(url).startsWith("https://sandbox.plaid.com/")) throw new Error(`Unexpected host: ${url}`);
    const path = new URL(url).pathname;
    const body = JSON.parse(String(init?.body ?? "{}"));
    if (path === "/item/public_token/exchange") return json({ access_token: ACCESS, item_id: `item-${body.public_token}` });
    if (path === "/accounts/get") return json({ accounts: [{ account_id: "acc-chk", name: "Fictional Checking", mask: "4094", type: "depository", subtype: "checking" }], item: {} });
    if (path === "/transactions/sync") return json({ added: plaidPages.shift() ?? [], modified: [], removed: [], next_cursor: "cursor-1", has_more: false });
    return json({ error_code: "NOT_FOUND" }, 404);
  }));
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

// --- Fictional world --------------------------------------------------------------------------------

const MONTH = "2026-10";
const pdf = () => new TextEncoder().encode(`%PDF-1.4\n% fictional ${Math.random()}\n`);
const portal = (u: { id: string; name: string; email: string }): PortalActor => ({ id: u.id, name: u.name, email: u.email }) as PortalActor;

async function people() {
  const tabitha = await makeUser("ADMIN", "Tabitha");
  await prisma.ownerAccess.create({ data: { userId: tabitha.id, isPrimary: true } });
  const daria = await makeUser("STAFF", "Daria");
  staff = tabitha;
  return { tabitha, daria };
}

/** A fictional business on the Bookkeeping Client list, with an owner login, its books and one registered checking account. */
async function business(p: Awaited<ReturnType<typeof people>>, name: string, email: string, opts: { frequency?: string; books?: boolean } = {}) {
  const biz = await createClient(p.tabitha, { businessName: name, clientType: "BUSINESS", status: "ACTIVE", assignedToId: p.daria.id });
  if (opts.books !== false) await prisma.bookkeepingProfile.create({ data: { clientId: biz.id, accountingBasis: "CASH", frequency: opts.frequency ?? "MONTHLY" } });
  const { token } = await invitePortalUser(p.tabitha, biz.id, { email, name: `Owner of ${name}`, role: "OWNER" });
  const login = portal(await acceptPortalInvite(token!, "Fictional-Pass-12345"));
  // Not enrolled: Managed Business access and the login's switch only.
  if (opts.books === false) await managedOnly(biz.id);
  else await managed(biz.id);
  if (opts.books === false) return { biz, login } as unknown as Awaited<ReturnType<typeof enrolled>>;
  return enrolled(p, biz, login);
}
async function enrolled(p: Awaited<ReturnType<typeof people>>, biz: { id: string }, login: PortalActor) {
  await setupLedger(p.daria, biz.id, { basis: "CASH" });
  const code = async (c: string) => (await prisma.ledgerAccount.findFirstOrThrow({ where: { clientId: biz.id, code: c } })).id;
  const checking = await code("1000");
  const registry = await prisma.bookkeepingAccount.create({ data: { clientId: biz.id, institution: "Fictional Community Bank", accountType: "CHECKING", last4: "4094", ledgerAccountId: checking } });
  return { biz, login, checking, registry, income: await code("4000"), software: await code("6600"), bankFees: await code("6100") };
}
type Biz = Awaited<ReturnType<typeof business>>;

// The same October activity, however it reaches the books.
const OCTOBER = [
  { date: "2026-10-02", description: "FICTIONAL CUSTOMER DEPOSIT", amountCents: 150_000 },
  { date: "2026-10-14", description: "PRETEND SOFTWARE CO", amountCents: -4_900 },
  { date: "2026-10-31", description: "SERVICE CHARGE", amountCents: -1_200 },
];
const NET = OCTOBER.reduce((t, r) => t + r.amountCents, 0);

async function bringInTransactions(p: Awaited<ReturnType<typeof people>>, b: Biz, via: "CSV" | "PLAID") {
  if (via === "CSV") {
    const csv = ["Date,Description,Amount", ...OCTOBER.map((r) => `${r.date.slice(5, 7)}/${r.date.slice(8)}/${r.date.slice(0, 4)},${r.description},${(r.amountCents / 100).toFixed(2)}`)].join("\n");
    await importBankCsv(p.daria, b.biz.id, b.checking, { fileName: "october-statement.csv", text: csv });
  } else {
    // Exactly the sync path: a (sandbox) connection, mapped to the ledger account, retrieved with transactions/sync.
    const conn = await completeBankLink(p.daria, b.biz.id, { publicToken: `public-sandbox-${b.biz.id}`, authorizedByName: "Fictional Owner", authorizationMethod: "CLIENT_PRESENT", institutionName: "Fictional Community Bank", confirmed: true });
    await mapBankAccount(p.daria, b.biz.id, conn.accounts[0].id, b.checking);
    plaidPages = [OCTOBER.map((r, i) => ({ transaction_id: `fictional-${i}`, account_id: "acc-chk", amount: -r.amountCents / 100, date: r.date, name: r.description, pending: false }))];
    await syncConnection(conn.id, "MANUAL", p.daria);
  }
}

const stagesOf = (pr: BooksProgress) => Object.fromEntries(pr.stages.map((s) => [s.key, s.status]));
const render = (pr: BooksProgress) => renderToStaticMarkup(createElement(BooksProgressCard, { progress: pr, links: { "what-we-need": "#what-we-need", statements: "#statements" }, everyMonth: "/client/bookkeeping?account=X" }));

/** The client's own dashboard for October (the portal path, with its access check). */
async function dash(b: Biz) {
  return portalBusinessDashboard(b.login, b.biz.id, MONTH);
}

/**
 * Walks one business through October, from opening the month to releasing its statements, using
 * the office's real service functions. Returns what the client saw after each step.
 */
async function walk(p: Awaited<ReturnType<typeof people>>, b: Biz, via: "CSV" | "PLAID") {
  const seen: { step: string; progress: BooksProgress; html: string; coetha: string; services: string[] }[] = [];
  const look = async (step: string) => {
    const d = await dash(b);
    seen.push({ step, progress: d.progress!, html: render(d.progress!), coetha: d.progress!.headline, services: d.services });
    return d.progress!;
  };
  const period = await openWorkPeriod(p.daria, b.biz.id, 2026, 10);
  const loanReq = await createDocumentRequest(p.daria, { clientId: b.biz.id, title: "October equipment invoice (fictional)", periodId: period.id });
  await look("opened");
  // Our office files the bank statement itself (the access the client authorized); a file that
  // hasn't passed the malware scan doesn't count.
  scanner = "down";
  await staffUploadStatement(p.daria, b.biz.id, { accountId: b.registry.id, month: MONTH, bytes: pdf(), originalName: "october.pdf" });
  await look("statement-unscanned");
  scanner = "clean";
  await staffUploadStatement(p.daria, b.biz.id, { accountId: b.registry.id, month: MONTH, bytes: pdf(), originalName: "october.pdf" });
  await look("statement-clean");
  await portalUploadDocument(b.login, { clientId: b.biz.id, requestId: loanReq.id, title: "Equipment invoice", bytes: pdf(), originalName: "invoice.pdf" });
  await look("documents-received");
  await bringInTransactions(p, b, via);
  await look("transactions-in");
  for (const t of await prisma.bankTransaction.findMany({ where: { clientId: b.biz.id }, orderBy: { date: "asc" } })) {
    await categorizeBankTransaction(p.daria, b.biz.id, t.id, { accountId: t.amountCents > 0 ? b.income : t.description.includes("SOFTWARE") ? b.software : b.bankFees });
  }
  await look("categorized");
  const r = await reconcileAccount(p.daria, b.biz.id, b.checking, { statementDate: "2026-10-31", statementBalance: (NET / 100).toFixed(2) });
  expect(r.reconciled).toBe(true);
  await look("reconciled");
  const up = await uploadMonthlyReport(p.daria, { clientId: b.biz.id, year: 2026, month: 10, reportType: "PROFIT_AND_LOSS", basis: "CASH", bytes: pdf(), originalName: "pl.pdf" });
  await look("statements-drafted");
  await submitReportForReview(p.daria, up.document.id);
  await look("awaiting-owner");
  // Staff below the owner can't approve; nothing moves.
  await expect(approveReport(p.daria, up.document.id)).rejects.toThrow(/Only Tabitha/);
  await approveReport(p.tabitha, up.document.id);
  await look("approved");
  await deliverReport(p.tabitha, up.document.id);
  await look("released");
  return seen;
}

// --- Tests --------------------------------------------------------------------------------------------

describe("Monthly Bookkeeping Progress Tracker: stages from real records", () => {
  it("moves through all five stages only as the office's records do, with the owner's approval gate before release", async () => {
    const p = await people();
    const b = await business(p, "Csv Pretend Cafe LLC", "cafe-owner@fictional.example");
    // Before the month is opened: not started, and the Coetha card says so.
    const before = await dash(b);
    expect(before.progress!.started).toBe(false);
    expect(before.progress!.headline).toBe("We haven't started October 2026 yet. Your bookkeeping progress will show here once we do.");

    const seen = await walk(p, b, "CSV");
    const at = (step: string) => seen.find((s) => s.step === step)!;
    expect(stagesOf(at("opened").progress)).toEqual({ DOCUMENTS: "IN_PROGRESS", TRANSACTIONS: "NOT_STARTED", RECONCILIATION: "NOT_STARTED", REVIEW: "NOT_STARTED", COMPLETED: "NOT_STARTED" });
    // The client is asked only for what they provide (receipts, the office's one-off request); never a bank statement.
    expect(at("opened").progress.stages[0].detail).toBe("Our office is retrieving your statements · 0 of 2 documents from you received · 2 still needed from you.");
    expect(at("opened").progress.percent).toBe(0);
    // Not yet scanned clean: not on file.
    expect(at("statement-unscanned").progress.stages[0].detail).toBe("Our office is retrieving your statements · 0 of 2 documents from you received · 2 still needed from you.");
    expect(at("statement-clean").progress.stages[0].detail).toBe("Statements retrieved by our office · 0 of 2 documents from you received · 2 still needed from you.");
    expect(at("documents-received").progress.stages[0]).toMatchObject({ status: "COMPLETE", detail: "Statements retrieved by our office · All documents received. Thank you!" });
    for (const s of seen) expect(s.html).not.toMatch(/upload your (bank|card|credit card) statement|statements? (still )?needed from you/i);
    // Transactions in the books: Transactions Updated in progress (to categorize) — and nothing later moves.
    expect(stagesOf(at("transactions-in").progress)).toEqual({ DOCUMENTS: "COMPLETE", TRANSACTIONS: "IN_PROGRESS", RECONCILIATION: "NOT_STARTED", REVIEW: "NOT_STARTED", COMPLETED: "NOT_STARTED" });
    expect(at("transactions-in").progress.stages[1].detail).toBe("0 of 1 account up to date · 3 transactions being categorized by our office.");
    // Every row reviewed and the month covered: complete; reconciliation is now the current stage, but not complete.
    expect(stagesOf(at("categorized").progress)).toMatchObject({ TRANSACTIONS: "COMPLETE", RECONCILIATION: "IN_PROGRESS", REVIEW: "NOT_STARTED" });
    expect(at("categorized").progress.current).toBe("RECONCILIATION");
    expect(at("categorized").coetha).toBe("October's books are 40% complete. Current stage: Reconciliation. 0 of 1 account reconciled.");
    expect(stagesOf(at("reconciled").progress)).toMatchObject({ RECONCILIATION: "COMPLETE", REVIEW: "NOT_STARTED" });
    expect(stagesOf(at("statements-drafted").progress)).toMatchObject({ REVIEW: "IN_PROGRESS", COMPLETED: "NOT_STARTED" });
    expect(at("statements-drafted").progress.stages[3].detail).toBe("Your financial statements are being prepared.");
    expect(at("awaiting-owner").progress.stages[3]).toMatchObject({ status: "IN_PROGRESS", detail: "Your financial statements are in final review." });
    // Owner approval completes stage 4; stage 5 waits for the release.
    expect(stagesOf(at("approved").progress)).toMatchObject({ REVIEW: "COMPLETE", COMPLETED: "IN_PROGRESS" });
    expect(at("approved").progress.done).toBe(false);
    const done = at("released").progress;
    expect(stagesOf(done)).toEqual({ DOCUMENTS: "COMPLETE", TRANSACTIONS: "COMPLETE", RECONCILIATION: "COMPLETE", REVIEW: "COMPLETE", COMPLETED: "COMPLETE" });
    expect([done.percent, done.done, done.current]).toEqual([100, true, null]);
    expect(done.headline).toBe("October's books are complete. Your financial statements are approved and ready for you below.");
    // The percent rises one stage at a time.
    expect(seen.map((s) => s.progress.percent)).toEqual([0, 0, 0, 20, 20, 40, 60, 60, 60, 80, 100]);
  });

  it("staff sign-off counts (categorize / reconcile steps), but reconciliation also needs the statement on file", async () => {
    const p = await people();
    const b = await business(p, "Checklist Pretend Studio LLC", "studio-owner@fictional.example");
    const period = await openWorkPeriod(p.daria, b.biz.id, 2026, 10);
    const items = await prisma.bookkeepingChecklistItem.findMany({ where: { periodId: period.id } });
    await setChecklistItem(p.daria, items.find((i) => i.key === "CATEGORIZE")!.id, "DONE");
    expect(stagesOf(await computeBooksProgress(b.biz.id, MONTH))).toMatchObject({ TRANSACTIONS: "COMPLETE", RECONCILIATION: "IN_PROGRESS" });
    // Staff signed off the reconciliation, but no statement is on file for the account: not complete.
    await setChecklistItem(p.daria, items.find((i) => i.key === "RECONCILE")!.id, "DONE");
    expect(stagesOf(await computeBooksProgress(b.biz.id, MONTH))).toMatchObject({ RECONCILIATION: "IN_PROGRESS" });
    // A statement the CLIENT uploaded isn't office-filed evidence either.
    await portalUploadDocument(b.login, { clientId: b.biz.id, periodId: period.id, docType: "BANK_STATEMENT", title: "My own copy", bytes: pdf(), originalName: "mine.pdf" });
    expect(stagesOf(await computeBooksProgress(b.biz.id, MONTH))).toMatchObject({ RECONCILIATION: "IN_PROGRESS" });
    // Our office files it: complete. Stages 4–5 still wait for the owner.
    await staffUploadStatement(p.daria, b.biz.id, { accountId: b.registry.id, month: MONTH, bytes: pdf(), originalName: "october.pdf" });
    expect(stagesOf(await computeBooksProgress(b.biz.id, MONTH))).toMatchObject({ RECONCILIATION: "COMPLETE", REVIEW: "NOT_STARTED", COMPLETED: "NOT_STARTED" });
  });

  it("a completed reconciliation without the statement on file doesn't complete stage 3", async () => {
    const p = await people();
    const b = await business(p, "Evidence Pretend Shop LLC", "evidence-owner@fictional.example");
    await openWorkPeriod(p.daria, b.biz.id, 2026, 10);
    await bringInTransactions(p, b, "CSV");
    for (const t of await prisma.bankTransaction.findMany({ where: { clientId: b.biz.id } })) await categorizeBankTransaction(p.daria, b.biz.id, t.id, { accountId: t.amountCents > 0 ? b.income : b.bankFees });
    expect((await reconcileAccount(p.daria, b.biz.id, b.checking, { statementDate: "2026-10-31", statementBalance: (NET / 100).toFixed(2) })).reconciled).toBe(true);
    expect(stagesOf(await computeBooksProgress(b.biz.id, MONTH))).toMatchObject({ RECONCILIATION: "IN_PROGRESS" });
    await staffUploadStatement(p.daria, b.biz.id, { accountId: b.registry.id, month: MONTH, bytes: pdf(), originalName: "october.pdf" });
    expect(stagesOf(await computeBooksProgress(b.biz.id, MONTH))).toMatchObject({ RECONCILIATION: "COMPLETE" });
  });
});

describe("Plaid parity: the client experience is identical however transactions arrive", () => {
  it("a CSV-imported month and a bank-feed month show the same stages, wording, indicators, links and document locations", async () => {
    const p = await people();
    const csv = await business(p, "Csv Pretend Cafe LLC", "cafe-owner@fictional.example");
    const feed = await business(p, "Feed Pretend Florist LLC", "florist-owner@fictional.example");
    const a = await walk(p, csv, "CSV");
    const b = await walk(p, feed, "PLAID");
    // The rows really did come in two different ways.
    expect(new Set((await prisma.bankTransaction.findMany({ where: { clientId: csv.biz.id } })).map((t) => t.source))).toEqual(new Set(["CSV"]));
    expect(new Set((await prisma.bankTransaction.findMany({ where: { clientId: feed.biz.id } })).map((t) => t.source))).toEqual(new Set(["PLAID"]));
    expect(await prisma.bankConnection.count({ where: { clientId: feed.biz.id, environment: "SANDBOX" } })).toBe(1);
    expect(await prisma.bankConnection.count({ where: { clientId: csv.biz.id } })).toBe(0);
    // Step by step: identical (the business name isn't part of the tracker at all).
    expect(b.map((s) => s.step)).toEqual(a.map((s) => s.step));
    for (let i = 0; i < a.length; i++) {
      expect(b[i].progress, a[i].step).toEqual(a[i].progress);
      expect(b[i].html, a[i].step).toBe(a[i].html);
      expect(b[i].coetha, a[i].step).toBe(a[i].coetha);
      expect(b[i].services).toEqual(a[i].services);
    }
    // No source wording anywhere on the tracker.
    for (const s of [...a, ...b]) expect(s.html).not.toMatch(/plaid|csv|bank feed|sync|import/i);
    // The full dashboard section: same links and document locations for both.
    const sectionOf = async (x: Biz) => {
      const d = await dash(x);
      const html = renderToStaticMarkup(createElement(BusinessDashboardView, { d, tiles: [], q: `?account=${x.biz.id}`, base: `/client?account=${x.biz.id}`, linkFor: (id: string) => `/api/documents/t-${id}`, personalQ: null }));
      const start = html.indexOf('data-testid="books-progress"');
      const end = html.indexOf('data-testid="payroll-card"');
      expect(start).toBeGreaterThan(0);
      expect(end).toBeGreaterThan(start);
      expect(html.slice(start, end)).toContain('data-testid="coetha-message"');
      return html.slice(start, end).replaceAll(x.biz.id, "ACCOUNT").replaceAll(d.client.name, "BUSINESS");
    };
    expect(await sectionOf(feed)).toBe(await sectionOf(csv));
  });

  it("imported or synchronized transactions alone never complete Reconciliation, Financials Under Review or Monthly Books Completed", async () => {
    const p = await people();
    for (const [name, via] of [["Csv Only Pretend Shop LLC", "CSV"], ["Feed Only Pretend Shop LLC", "PLAID"]] as const) {
      const b = await business(p, name, `${via.toLowerCase()}-only@fictional.example`);
      await openWorkPeriod(p.daria, b.biz.id, 2026, 10);
      await bringInTransactions(p, b, via);
      // Even with every row reviewed and the month fully covered.
      for (const t of await prisma.bankTransaction.findMany({ where: { clientId: b.biz.id } })) await categorizeBankTransaction(p.daria, b.biz.id, t.id, { accountId: t.amountCents > 0 ? b.income : b.bankFees });
      const pr = await computeBooksProgress(b.biz.id, MONTH);
      expect(stagesOf(pr)).toMatchObject({ TRANSACTIONS: "COMPLETE", RECONCILIATION: "IN_PROGRESS", REVIEW: "NOT_STARTED", COMPLETED: "NOT_STARTED" });
      expect(pr.done).toBe(false);
    }
  });
});

describe("Coetha and private information never reach the tracker", () => {
  it("Coetha's prepared reconciliations, draft requests and proposals never move stages, and the payload carries no notes or proposals", async () => {
    const p = await people();
    const b = await business(p, "Private Pretend Bistro LLC", "bistro-owner@fictional.example");
    const period = await openWorkPeriod(p.daria, b.biz.id, 2026, 10);
    await bringInTransactions(p, b, "CSV");
    for (const t of await prisma.bankTransaction.findMany({ where: { clientId: b.biz.id } })) await categorizeBankTransaction(p.daria, b.biz.id, t.id, { accountId: t.amountCents > 0 ? b.income : b.bankFees });
    const before = await computeBooksProgress(b.biz.id, MONTH);
    // Coetha's internal work: a prepared (balanced, unapproved) reconciliation, a draft request, a proposal, staff notes.
    await prisma.accountReconciliation.create({ data: { clientId: b.biz.id, bookkeepingAccountId: b.registry.id, year: 2026, month: 10, status: "READY", statementStatus: "RECEIVED", endingBalanceCents: NET, beginningBalanceCents: 0, differenceCents: 0, exceptions: ["COETHA-INTERNAL-EXCEPTION"] } });
    await prepareReconciliation(b.biz.id, b.registry.id, 2026, 10);
    await prisma.documentRequest.create({ data: { clientId: b.biz.id, periodId: period.id, title: "COETHA-DRAFT-REQUEST", status: "DRAFT", source: "COETHA", reason: "COETHA-PRIVATE-REASON", createdById: p.tabitha.id } });
    const run = await prisma.coethaRun.create({ data: { clientId: b.biz.id, trigger: "MANUAL", model: "rules", status: "OK" } });
    await prisma.coethaProposal.create({ data: { clientId: b.biz.id, runId: run.id, kind: "ADJUSTING_ENTRY", payload: { memo: "COETHA-PROPOSED-ADJUSTMENT" }, reason: "COETHA-INTERNAL-ANALYSIS", model: "rules", inputHash: "x" } });
    await prisma.bookkeepingPeriod.update({ where: { id: period.id }, data: { staffNote: "PRIVATE-STAFF-NOTE" } });
    await prisma.bookkeepingProfile.update({ where: { clientId: b.biz.id }, data: { notes: "PRIVATE-PROFILE-NOTE" } });
    // A draft report (never submitted) doesn't approve anything either.
    const after = await computeBooksProgress(b.biz.id, MONTH);
    expect(after).toEqual(before);
    expect(stagesOf(after)).toMatchObject({ RECONCILIATION: "IN_PROGRESS", REVIEW: "NOT_STARTED", COMPLETED: "NOT_STARTED" });
    // The client payload: stage keys, labels, statuses and plain details only.
    const d = await dash(b);
    const json = JSON.stringify(d.progress);
    expect(json).not.toMatch(/COETHA-|PRIVATE-|proposal|adjust|note|reason|analysis|\$/i);
    for (const s of d.progress!.stages) expect(Object.keys(s).sort()).toEqual(["detail", "key", "label", "link", "status"]);
    expect(Object.keys(d.progress!).sort()).toEqual(["applicable", "completed", "current", "done", "headline", "month", "percent", "periodKind", "periodLabel", "stages", "started"]);
  });
});

describe("Isolation, engagement and View as Client", () => {
  it("each business's tracker reads only its own records, and another business's owner is refused", async () => {
    const p = await people();
    const quiet = await business(p, "Quiet Pretend Bakery LLC", "bakery-owner@fictional.example");
    const busy = await business(p, "Busy Pretend Hauling LLC", "hauling-owner@fictional.example");
    await openWorkPeriod(p.daria, quiet.biz.id, 2026, 10);
    await walk(p, busy, "PLAID");
    const q = await dash(quiet);
    expect(stagesOf(q.progress!)).toEqual({ DOCUMENTS: "IN_PROGRESS", TRANSACTIONS: "NOT_STARTED", RECONCILIATION: "NOT_STARTED", REVIEW: "NOT_STARTED", COMPLETED: "NOT_STARTED" });
    expect((await dash(busy)).progress!.done).toBe(true);
    expect(JSON.stringify(q)).not.toContain("Busy Pretend Hauling");
    // Cross-account access (another business's ?account=) is refused.
    await expect(portalBusinessDashboard(busy.login, quiet.biz.id, MONTH)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(portalBusinessDashboard(quiet.login, busy.biz.id, MONTH)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("stages the engagement doesn't include are hidden, never shown as incomplete", async () => {
    const p = await people();
    // No accounts in scope and staff marked categorizing / reconciling not needed: those stages don't apply.
    const b = await business(p, "Cash Only Pretend Kiosk LLC", "kiosk-owner@fictional.example");
    await prisma.bookkeepingAccount.deleteMany({ where: { clientId: b.biz.id } });
    const period = await openWorkPeriod(p.daria, b.biz.id, 2026, 10);
    for (const i of await prisma.bookkeepingChecklistItem.findMany({ where: { periodId: period.id, key: { in: ["CATEGORIZE", "RECONCILE"] } } })) await setChecklistItem(p.daria, i.id, "NOT_NEEDED");
    const pr = (await dash(b)).progress!;
    expect(pr.stages.map((s) => s.key)).toEqual(["DOCUMENTS", "REVIEW", "COMPLETED"]);
    expect(pr.applicable).toBe(3);
    const card = render(pr);
    expect(card).not.toContain("Transactions Updated");
    expect(card).not.toContain("Reconciliation");
    expect(card).not.toMatch(/not applicable/i);
  });

  it("View as Client shows exactly the tracker and Coetha status the client sees", async () => {
    const p = await people();
    const b = await business(p, "Preview Pretend Deli LLC", "deli-owner@fictional.example");
    await openWorkPeriod(p.daria, b.biz.id, 2026, 10);
    await staffUploadStatement(p.daria, b.biz.id, { accountId: b.registry.id, month: MONTH, bytes: pdf(), originalName: "october.pdf" });
    await bringInTransactions(p, b, "PLAID");
    const mine = await dash(b);
    const tree = (await PortalPreview({ params: Promise.resolve({ id: b.biz.id }), searchParams: Promise.resolve({ month: MONTH }) })) as ReactNode;
    const view = find(tree, BusinessDashboardView);
    expect(view).not.toBeNull();
    const d = (view!.props as { d: Awaited<ReturnType<typeof businessDashboardFor>> }).d;
    expect(d.progress).toEqual(mine.progress);
    expect(render(d.progress!)).toBe(render(mine.progress!));
  });
});

describe("Quarterly engagements are shown by quarter", () => {
  it("a quarterly client sees one quarter (Q3 2026), a quarter selector, and never monthly statements", async () => {
    const p = await people();
    const q = await business(p, "Quarterly Pretend Salon LLC", "salon-owner@fictional.example", { frequency: "QUARTERLY" });
    for (const m of [7, 8, 9]) await openWorkPeriod(p.daria, q.biz.id, 2026, m);
    // Any month of the quarter shows the quarter.
    const pr = await computeBooksProgress(q.biz.id, "2026-08");
    expect([pr.periodKind, pr.periodLabel, pr.month]).toEqual(["QUARTER", "Q3 2026", "2026-09"]);
    expect(pr.stages.map((s) => s.label)).toEqual(["Documents Received", "Transactions Updated", "Reconciliation", "Financials Under Review", "Quarterly Books Completed"]);
    expect(pr.headline).toMatch(/^Q3 2026 books are \d+% complete\./);
    const d = await portalBusinessDashboard(q.login, q.biz.id, "2026-08");
    expect([d.selected, d.periodLabel]).toEqual(["2026-09", "Q3 2026"]);
    expect(d.monthChoices).toEqual(["2026-09"]);
    expect(d.choiceLabels).toEqual({ "2026-09": "Q3 2026" });
    const html = render(d.progress!);
    expect(html).toContain("Q3 2026 – Bookkeeping Progress");
    expect(html).not.toMatch(/monthly|October|August|this month/i);
    expect(html).toContain("quarterly financial statements");
    // Transactions must cover the whole quarter: July alone isn't enough.
    await importBankCsv(p.daria, q.biz.id, q.checking, { fileName: "jul.csv", text: "Date,Description,Amount\n07/31/2026,SERVICE CHARGE,-12.00" });
    for (const t of await prisma.bankTransaction.findMany({ where: { clientId: q.biz.id } })) await categorizeBankTransaction(p.daria, q.biz.id, t.id, { accountId: q.bankFees });
    expect(stagesOf(await computeBooksProgress(q.biz.id, "2026-09"))).toMatchObject({ TRANSACTIONS: "IN_PROGRESS" });
    for (const m of ["08/31/2026", "09/30/2026"]) await importBankCsv(p.daria, q.biz.id, q.checking, { fileName: `${m.slice(0, 2)}.csv`, text: `Date,Description,Amount\n${m},SERVICE CHARGE,-12.00` });
    for (const t of await prisma.bankTransaction.findMany({ where: { clientId: q.biz.id, status: "UNREVIEWED" } })) await categorizeBankTransaction(p.daria, q.biz.id, t.id, { accountId: q.bankFees });
    expect(stagesOf(await computeBooksProgress(q.biz.id, "2026-09"))).toMatchObject({ TRANSACTIONS: "COMPLETE", RECONCILIATION: "IN_PROGRESS" });
    // Monthly clients are unchanged.
    const m = await business(p, "Monthly Pretend Diner LLC", "diner-owner@fictional.example");
    await openWorkPeriod(p.daria, m.biz.id, 2026, 10);
    const dm = await dash(m);
    expect([dm.progress!.periodKind, dm.periodLabel, dm.progress!.stages.at(-1)!.label]).toEqual(["MONTH", "October 2026", "Monthly Books Completed"]);
  });
});

describe("Statements are retrieved by our office, never asked of the client", () => {
  it("no routine bank or card statement request reaches the client; Coetha makes an internal office task instead", async () => {
    const p = await people();
    const b = await business(p, "Statement Pretend Bistro LLC", "stmt-owner@fictional.example");
    // #90's client authorization gate applies to Coetha's monitor; authorize so this tests only the statement rule.
    await authorizeCoetha(b.biz.id);
    await prisma.bookkeepingAccount.create({ data: { clientId: b.biz.id, institution: "Fictional Card Co", accountType: "CREDIT_CARD", last4: "1111", ledgerAccountId: (await prisma.ledgerAccount.findFirstOrThrow({ where: { clientId: b.biz.id, code: "2100" } })).id } });
    const period = await openWorkPeriod(p.daria, b.biz.id, 2026, 10);
    // An old routine statement request (from before this change) stays in the records but is never shown.
    const old = await prisma.documentRequest.create({ data: { clientId: b.biz.id, taxYear: 2026, ruleKey: "BANK_STATEMENTS", docType: "BANK_STATEMENT", title: "Bank statements — every business account (2026)", createdById: p.tabitha.id } });
    const coethaOld = await prisma.documentRequest.create({ data: { clientId: b.biz.id, periodId: period.id, kind: "STATEMENT", source: "COETHA", docType: "CARD_STATEMENT", status: "OPEN", title: "Credit card statement — October 2026", createdById: p.tabitha.id } });
    // The dashboard syncs "What we need — bookkeeping": no statement rule exists any more.
    const d = await dash(b);
    expect(d.checklist.map((c) => c.key)).not.toContain("BANK_STATEMENTS");
    expect(d.checklist.map((c) => c.key)).not.toContain("CARD_STATEMENTS");
    expect(d.checklist.map((c) => c.id)).not.toContain(old.id);
    expect(d.checklist.map((c) => c.id)).not.toContain(coethaOld.id);
    expect(await prisma.documentRequest.count({ where: { clientId: b.biz.id, ruleKey: { in: ["BANK_STATEMENTS", "CARD_STATEMENTS"] }, NOT: { id: old.id } } })).toBe(0);
    // "Outstanding items" counts only what the client can see (no statement requests).
    expect(d.books.openRequests).toBe(d.checklist.filter((c) => c.status === "NEEDED" || c.status === "MORE_INFO").length);
    // History is kept, unchanged.
    expect((await prisma.documentRequest.findUniqueOrThrow({ where: { id: old.id } })).status).toBe("OPEN");
    // Coetha's monitor: the statements are missing, so it raises office tasks — no client request.
    const r = await runWorkflowMonitor(null, b.biz.id, 2026, 10);
    expect(r.officeTasks).toBe(2);
    expect(await prisma.documentRequest.count({ where: { clientId: b.biz.id, kind: { in: ["STATEMENT", "HISTORICAL"] }, NOT: { id: coethaOld.id } } })).toBe(0);
    const tasks = await prisma.task.findMany({ where: { clientId: b.biz.id }, orderBy: { title: "asc" } });
    expect(tasks.map((t) => t.title)).toEqual(["Retrieve bank statement — Fictional Community Bank ••4094 — October 2026", "Retrieve credit card statement — Fictional Card Co ••1111 — October 2026"].sort());
    expect((await runWorkflowMonitor(null, b.biz.id, 2026, 10)).officeTasks).toBe(0); // never repeated
    // The month's checklist lists statements as office items, never waiting on the client.
    const items = await prisma.bookkeepingChecklistItem.findMany({ where: { periodId: period.id, key: { in: ["BANK_STATEMENTS", "CARD_STATEMENTS"] } } });
    const { checklistView, CHECKLIST } = await import("@/lib/services/bookkeeping-clients");
    expect(CHECKLIST.filter((c) => c.docType === "BANK_STATEMENT" || c.docType === "CARD_STATEMENT").map((c) => c.kind)).toEqual(["OFFICE_DOCUMENT", "OFFICE_DOCUMENT"]);
    const view = checklistView({ ...(await prisma.bookkeepingPeriod.findUniqueOrThrow({ where: { id: period.id } })), checklist: items, documents: [] } as never);
    expect(view.map((i) => i.state)).toEqual(["STAFF_TODO", "STAFF_TODO"]);
    // Stage 1 never asks the client for statements; once our office files both, it says so.
    const before = await computeBooksProgress(b.biz.id, MONTH);
    expect(before.stages[0].detail).toMatch(/^Our office is retrieving your statements/);
    for (const a of await prisma.bookkeepingAccount.findMany({ where: { clientId: b.biz.id } })) await staffUploadStatement(p.daria, b.biz.id, { accountId: a.id, month: MONTH, bytes: pdf(), originalName: `${a.id}.pdf` });
    const after = await computeBooksProgress(b.biz.id, MONTH);
    expect(after.stages[0]).toMatchObject({ status: "COMPLETE", detail: "Statements retrieved by our office · All documents received. Thank you!" });
    // Office-filed statements never show in the client's portal (staff-only bookkeeping files).
    expect(JSON.stringify(await dash(b))).not.toMatch(/Retrieve (bank|credit card) statement/);
  });
});

describe("How access is decided: only clients enrolled on the bookkeeping service get the business side", () => {
  it("an owner-approved Managed Business that isn't enrolled stays on the tax portal; the server refuses every business page", async () => {
    const p = await people();
    const garage = await business(p, "Tax Only Pretend Garage LLC", "garage-owner@fictional.example", { books: false });
    // businessAccess ACTIVE and the per-login switch on (managed()), but no bookkeeping profile.
    expect((await prisma.client.findUniqueOrThrow({ where: { id: garage.biz.id } })).businessAccess).toBe("ACTIVE");
    const g = await requireClientAccess(garage.login.id, garage.biz.id);
    expect(g.canViewBookkeeping).toBe(false);
    expect(homeKind(g)).toBe("PERSONAL");
    expect(allowedCategories(g)).not.toContain("BOOKKEEPING");
    for (const call of [
      () => portalBusinessDashboard(garage.login, garage.biz.id, MONTH),
      () => portalBankFeed(garage.login, garage.biz.id),
      () => portalPayrollPage(garage.login, garage.biz.id),
      () => portalLicensesPage(garage.login, garage.biz.id),
      () => portalYearEndPage(garage.login, garage.biz.id),
      () => portalClientInvoicing(garage.login, garage.biz.id),
    ]) await expect(call()).rejects.toBeInstanceOf(ForbiddenError);
    // View as Client shows the tax client Home, never the business dashboard.
    const tree = (await PortalPreview({ params: Promise.resolve({ id: garage.biz.id }), searchParams: Promise.resolve({}) })) as ReactNode;
    expect(find(tree, BusinessDashboardView)).toBeNull();
    expect(find(tree, PortalHomeView)).not.toBeNull();
    for (const v of ["payroll", "licenses", "year-end", "invoicing"]) {
      const t = (await PortalPreview({ params: Promise.resolve({ id: garage.biz.id }), searchParams: Promise.resolve({ view: v }) })) as ReactNode;
      expect(find(t, BusinessDashboardView)).toBeNull();
      expect(renderToStaticMarkup(t as ReactElement)).not.toMatch(/data-testid="(payroll-page|licenses-page|year-end-page|invoicing-page)"/);
    }

    // A paused profile (as business onboarding approval creates) grants nothing either.
    await prisma.bookkeepingProfile.create({ data: { clientId: garage.biz.id, active: false } });
    expect((await requireClientAccess(garage.login.id, garage.biz.id)).canViewBookkeeping).toBe(false);
    await expect(portalBusinessDashboard(garage.login, garage.biz.id, MONTH)).rejects.toBeInstanceOf(ForbiddenError);

    // "+ Add Bookkeeping Client" (enrollExistingClient) is what moves it to the business side.
    await enrollExistingClient(p.tabitha, garage.biz.id, { active: true, frequency: "MONTHLY", payroll: false });
    expect((await requireClientAccess(garage.login.id, garage.biz.id)).canViewBookkeeping).toBe(true);
    const d = await portalBusinessDashboard(garage.login, garage.biz.id, MONTH);
    expect(d.progress).not.toBeNull();
    expect(d.services).toContain("Bookkeeping");
    await expect(portalPayrollPage(garage.login, garage.biz.id)).resolves.toBeTruthy();
  });

  it("services picked at sign-up never grant the business side, and the staff workspace doesn't depend on portal logins", async () => {
    const p = await people();
    // A business whose owner asked for "Bookkeeping" when signing up (Client.services) — not enrolled.
    const asked = await createClient(p.tabitha, { businessName: "Asked Pretend Florist LLC", clientType: "BUSINESS", status: "ACTIVE", services: "Bookkeeping" } as never);
    expect((await prisma.client.findUniqueOrThrow({ where: { id: asked.id } })).services).toContain("Bookkeeping");
    const { token } = await invitePortalUser(p.tabitha, asked.id, { email: "asked@fictional.example", name: "Asked Owner", role: "OWNER" });
    const login = portal(await acceptPortalInvite(token!, "Fictional-Pass-12345"));
    expect((await accessibleClients(login.id))[0].canViewBookkeeping).toBe(false);
    await expect(portalBusinessDashboard(login, asked.id, MONTH)).rejects.toBeInstanceOf(ForbiddenError);
    // Staff keep their internal bookkeeping workspace for an enrolled client with no portal login at all.
    const books = await createClient(p.tabitha, { businessName: "No Login Pretend Cafe LLC", clientType: "BUSINESS", status: "ACTIVE" });
    await enrollExistingClient(p.tabitha, books.id, { active: true, frequency: "MONTHLY", payroll: false });
    const period = await openWorkPeriod(p.daria, books.id, 2026, 10);
    const ws = await bookkeepingWorkspace(books.id, period.id);
    expect(ws.period?.id).toBe(period.id);
    expect(ws.summary?.items.length).toBeGreaterThan(0);
  });
});

describe("booksProgressFromFacts (pure)", () => {
  const facts = (over: Partial<BooksFacts> = {}): BooksFacts => ({
    period: engagementPeriod("MONTHLY", MONTH), today: "2026-11-05", periodOpen: true, documents: [{ received: true, pending: false }], officeStatements: [{ filed: true }], categorizeStep: "OPEN", reconcileStep: "OPEN",
    accounts: [{ covered: true, transactions: 4, unreviewed: 0, reconciled: true, statementFiled: true }], reports: [{ reviewStatus: "APPROVED" }], released: true, ...over,
  });

  it("shows a later stage complete as recorded while an earlier one is open, but keeps the overall status honest", () => {
    const pr = booksProgressFromFacts(facts({ documents: [{ received: true, pending: false }, { received: false, pending: false }] }));
    expect(stagesOf(pr)).toEqual({ DOCUMENTS: "IN_PROGRESS", TRANSACTIONS: "COMPLETE", RECONCILIATION: "COMPLETE", REVIEW: "COMPLETE", COMPLETED: "COMPLETE" });
    expect([pr.percent, pr.done, pr.current]).toEqual([80, false, "DOCUMENTS"]);
    expect(pr.headline).toBe("October's books are 80% complete. Current stage: Documents Received. Statements retrieved by our office · 1 of 2 documents from you received · 1 still needed from you.");
  });

  it("a month still in progress is never complete for transactions, and an upload being checked is said so", () => {
    const pr = booksProgressFromFacts(facts({ today: "2026-10-20", officeStatements: [], accounts: [{ covered: false, transactions: 3, unreviewed: 0, reconciled: false, statementFiled: false }], reports: [], released: false, documents: [{ received: false, pending: true }] }));
    expect(stagesOf(pr)).toMatchObject({ DOCUMENTS: "IN_PROGRESS", TRANSACTIONS: "IN_PROGRESS", RECONCILIATION: "NOT_STARTED" });
    expect(pr.stages[0].detail).toBe("0 of 1 document from you received · 1 being checked.");
    expect(pr.stages[1].detail).toMatch(/^October is still in progress\./);
  });

  it("reconciliation needs the statement on file even when reconciled or signed off", () => {
    expect(stagesOf(booksProgressFromFacts(facts({ accounts: [{ covered: true, transactions: 4, unreviewed: 0, reconciled: true, statementFiled: false }] })))).toMatchObject({ RECONCILIATION: "IN_PROGRESS" });
    expect(stagesOf(booksProgressFromFacts(facts({ reconcileStep: "DONE", accounts: [{ covered: true, transactions: 4, unreviewed: 0, reconciled: false, statementFiled: false }] })))).toMatchObject({ RECONCILIATION: "IN_PROGRESS" });
    expect(stagesOf(booksProgressFromFacts(facts({ reconcileStep: "DONE", accounts: [{ covered: true, transactions: 4, unreviewed: 0, reconciled: false, statementFiled: true }] })))).toMatchObject({ RECONCILIATION: "COMPLETE" });
  });

  it("approval without release completes stage 4 only; release requires the gate", () => {
    expect(stagesOf(booksProgressFromFacts(facts({ released: false })))).toMatchObject({ REVIEW: "COMPLETE", COMPLETED: "IN_PROGRESS" });
    expect(stagesOf(booksProgressFromFacts(facts({ released: false, reports: [{ reviewStatus: "APPROVED" }, { reviewStatus: "CHANGES_REQUESTED" }] })))).toMatchObject({ REVIEW: "IN_PROGRESS", COMPLETED: "NOT_STARTED" });
  });
});

/** The first element of a component type anywhere in a rendered server-component tree. */
function find(node: ReactNode, type: unknown): ReactElement<Record<string, unknown>> | null {
  if (Array.isArray(node)) {
    for (const n of node) {
      const hit = find(n, type);
      if (hit) return hit;
    }
    return null;
  }
  if (!isValidElement(node)) return null;
  if (node.type === type) return node as ReactElement<Record<string, unknown>>;
  return find((node.props as { children?: ReactNode }).children, type);
}
