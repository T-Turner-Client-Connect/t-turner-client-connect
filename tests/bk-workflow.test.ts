import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeUser, prisma, resetDb } from "./db";
import { ForbiddenError } from "@/lib/auth/actor";
import { createClient } from "@/lib/services/clients";
import { saveProfile, openWorkPeriod, bookkeepingWorkspace } from "@/lib/services/bookkeeping-clients";
import { categorizeBankTransaction, postJournalEntry, postOpeningBalances, profitAndLoss, setupLedger } from "@/lib/services/ledger";
import { suggestCategories } from "@/lib/services/ledger-review";
import { completeBankLink, syncConnection } from "@/lib/services/banking";
import { approveReconciliation, detectSharedCards, enterStatementBalances, monitorConnectionAccount, monthlyAccountProgress, reconMath, registerAccount, decideSharedCard } from "@/lib/services/bank-accounts";
import { classifyRequest, createClientRequest, DEPOSIT_REVIEW_THRESHOLD_CENTS, requestHistoricalRecords, requestYearEndDocuments, sendClientRequest, staffUploadForRequest, staffUploadStatement, yearEndWindow } from "@/lib/services/client-requests";
import { monthlyChecklist, runWorkflowMonitor } from "@/lib/services/monthly-workflow";
import { setOwnerSwitch } from "@/lib/services/owner-switches";
import { acceptPortalInvite, invitePortalUser } from "@/lib/services/portal-accounts";
import { requireClientAccess } from "@/lib/portal/access";
import { portalUploadDocument } from "@/lib/services/documents";
import { setStatementSource } from "@/lib/statement-retrieval";
import type { PlaidTxn } from "@/lib/plaid";

/**
 * Monthly bookkeeping workflow and Banking & Credit Card Connections. Fictional businesses,
 * banks and transactions only; Plaid is simulated and never called.
 */

type Acct = { account_id: string; name: string; mask: string; type: string; subtype: string; balances?: { current: number; limit: number | null } };
let accounts: Acct[] = [];
let pages: { added?: PlaidTxn[] }[] = [];
const PDF = new TextEncoder().encode("%PDF-1.4\n% fictional statement\n");
const TODAY = "2026-11-04";

beforeEach(async () => {
  await resetDb();
  accounts = [{ account_id: "p-chk", name: "Pretend Operating", mask: "0042", type: "depository", subtype: "checking" }];
  pages = [];
  process.env.PLAID_CLIENT_ID = "fictional-client-id";
  process.env.PLAID_SECRET = "fictional-sandbox-secret";
  process.env.PLAID_ENV = "sandbox";
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
    const u = new URL(url);
    if (u.host !== "sandbox.plaid.com") throw new Error(`Unexpected host: ${url}`);
    const body = JSON.parse(String(init.body));
    const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200 });
    if (u.pathname === "/item/public_token/exchange") return json({ access_token: `access-${body.public_token}`, item_id: `item-${body.public_token}` });
    if (u.pathname === "/accounts/get") return json({ accounts, item: {} });
    if (u.pathname === "/transactions/sync") { const p = pages.shift() ?? {}; return json({ added: p.added ?? [], modified: [], removed: [], next_cursor: "c-next", has_more: false }); }
    return new Response(JSON.stringify({ error_code: "NOT_FOUND" }), { status: 404 });
  }));
});
afterEach(() => {
  vi.unstubAllGlobals();
  setStatementSource(null);
  for (const k of ["PLAID_CLIENT_ID", "PLAID_SECRET", "PLAID_ENV"]) delete process.env[k];
});

const t = (id: string, account: string, dollarsOut: number, date: string, name: string): PlaidTxn => ({ transaction_id: id, account_id: account, amount: dollarsOut, date, name, pending: false });

async function world(opts: { payroll?: boolean } = {}) {
  const tabitha = await makeUser("ADMIN", "Tabitha");
  await prisma.ownerAccess.create({ data: { userId: tabitha.id, isPrimary: true } });
  const daria = await makeUser("STAFF", "Daria");
  const eve = await makeUser("STAFF", "Eve");
  // A Bookkeeping Client whose CLIENT portal access (Managed Business) was never granted.
  const biz = await createClient(tabitha, { businessName: "Lakeside Pretend Bakery LLC", clientType: "BUSINESS", status: "ACTIVE", assignedToId: daria.id });
  const other = await createClient(tabitha, { businessName: "Harbor Pretend Hauling Co", clientType: "BUSINESS", status: "ACTIVE", assignedToId: daria.id });
  for (const c of [biz, other]) await saveProfile(tabitha, c.id, { active: true, frequency: "MONTHLY", payroll: !!opts.payroll, payrollFrequency: opts.payroll ? "BIWEEKLY" : null, payrollProvider: opts.payroll ? "ADP" : null });
  for (const c of [biz, other]) await setupLedger(daria, c.id, { basis: "CASH" });
  const code = async (clientId: string, c: string) => (await prisma.ledgerAccount.findFirstOrThrow({ where: { clientId, code: c } })).id;
  return { tabitha, daria, eve, biz, other, code };
}
type W = Awaited<ReturnType<typeof world>>;

async function connect(w: W, clientId: string, token = "tok-1") {
  return completeBankLink(w.daria, clientId, { publicToken: token, authorizedByName: "Pat Pretend", authorizationMethod: "CLIENT_PRESENT", institutionName: "Pretend National Bank", confirmed: true });
}

describe("monthly checklist (derived automatically)", () => {
  it("is built from real data, has no annual tax documents, and a working bank feed counts as synced (no 'statement missing')", async () => {
    const w = await world();
    const chk = await registerAccount(w.daria, w.biz.id, { institution: "Pretend National Bank", accountType: "CHECKING", nickname: "Operating", last4: "0042", gl: "NEW" });
    const conn = await connect(w, w.biz.id);
    await monitorConnectionAccount(w.daria, w.biz.id, conn.accounts[0].id, chk.id);
    pages = [{ added: [t("x1", "p-chk", -1200, "2026-10-03", "PRETEND CATERING DEPOSIT"), t("x2", "p-chk", 80, "2026-10-12", "PRETEND OFFICE SUPPLY")] }];
    await syncConnection(conn.id, "MANUAL", w.daria);
    const period = await openWorkPeriod(w.tabitha, w.biz.id, 2026, 10);
    // An annual request in the month never counts against it.
    await prisma.documentRequest.create({ data: { clientId: w.biz.id, periodId: period.id, title: "2026 1099-NEC", kind: "YEAR_END", taxYear: 2026, createdById: w.tabitha.id } });

    const c = await monthlyChecklist(w.biz.id, 2026, 10, { today: TODAY });
    expect(c.items.map((i) => i.key)).toEqual(["BANK_SYNC", "RECEIPTS", "CATEGORIZED", "RECONCILED", "PREPARED", "APPROVAL", "RELEASED"]);
    expect(c.items.map((i) => i.label).join(" ")).not.toMatch(/1099|W-2|1098|K-1|year-end/i);
    const bank = c.items.find((i) => i.key === "BANK_SYNC")!;
    expect(bank.state).toBe("DONE");
    // Synchronized means synchronized: no "statement missing" on the sync line while the feed works.
    expect(bank.detail).not.toMatch(/statement/i);
    expect(c.items.find((i) => i.key === "CATEGORIZED")).toMatchObject({ state: "IN_PROGRESS", detail: "2 of 2 still to categorize" });
    // The legacy month list marks "Bank statements" done from the feed, with nothing checked off by hand.
    const ws = await bookkeepingWorkspace(w.biz.id, period.id);
    expect(ws.summary!.items.find((i) => i.key === "BANK_STATEMENTS")!.state).toBe("DONE");
    expect(ws.summary!.missing).toBe(ws.summary!.items.filter((i) => i.state === "WAITING_CLIENT").length); // the 1099 request isn't counted
    // Categorizing everything turns the line green.
    const rows = await prisma.bankTransaction.findMany({ where: { clientId: w.biz.id } });
    for (const r of rows) await categorizeBankTransaction(w.daria, w.biz.id, r.id, { accountId: await w.code(w.biz.id, r.amountCents > 0 ? "4000" : "6300") });
    expect((await monthlyChecklist(w.biz.id, 2026, 10, { today: TODAY })).items.find((i) => i.key === "CATEGORIZED")!.state).toBe("DONE");
  });

  it("payroll appears only for payroll clients and is green once the payroll report arrives", async () => {
    const w = await world({ payroll: true });
    await registerAccount(w.daria, w.biz.id, { institution: "Pretend National Bank", accountType: "CHECKING", last4: "0042" });
    const before = await monthlyChecklist(w.biz.id, 2026, 10, { today: TODAY });
    expect(before.items.find((i) => i.key === "PAYROLL")).toMatchObject({ state: "MISSING", label: "Payroll data received (ADP)" });
    const file = await prisma.storedFile.create({ data: { kind: "CLIENT_DOCUMENT", storageKey: "test/payroll.pdf", originalName: "payroll.pdf", title: "Payroll", mimeType: "application/pdf", sizeBytes: 10 } });
    await prisma.document.create({ data: { clientId: w.biz.id, category: "CLIENT_UPLOADS", title: "October payroll", year: 2026, month: 10, docType: "PAYROLL_REPORT", fileId: file.id } });
    expect((await monthlyChecklist(w.biz.id, 2026, 10, { today: TODAY })).items.find((i) => i.key === "PAYROLL")!.state).toBe("DONE");
    await prisma.bookkeepingProfile.update({ where: { clientId: w.other.id }, data: { payroll: false } });
    const w2 = await monthlyChecklist(w.other.id, 2026, 10, { today: TODAY });
    expect(w2.items.some((i) => i.key === "PAYROLL")).toBe(false);
  });
});

describe("year-end tax documents (separate, from January)", () => {
  it("opens in January for the year just ended and is closed in November", async () => {
    const w = await world();
    expect(yearEndWindow(new Date("2026-11-04T18:00:00Z"))).toMatchObject({ open: false, opensOn: "2027-01-01" });
    expect(yearEndWindow(new Date("2027-01-05T18:00:00Z"))).toMatchObject({ open: true, taxYear: 2026 });
    await expect(requestYearEndDocuments(w.daria, w.biz.id, ["NEC_1099"], { now: new Date("2026-11-04T18:00:00Z") })).rejects.toThrow(/open on January 1, 2027/);
    const made = await requestYearEndDocuments(w.daria, w.biz.id, ["NEC_1099", "W2_W3"], { now: new Date("2027-01-05T18:00:00Z"), send: true });
    expect(made.map((r) => [r.kind, r.taxYear, r.status])).toEqual([["YEAR_END", 2026, "OPEN"], ["YEAR_END", 2026, "OPEN"]]);
    // Never in the monthly checklist.
    expect((await monthlyChecklist(w.biz.id, 2026, 12, { today: "2027-01-05" })).items.map((i) => i.label).join(" ")).not.toMatch(/1099|W-2/);
  });
});

describe("historical records", () => {
  it("asks for one account and one range; the client's upload is filed with them automatically", async () => {
    const w = await world();
    const card = await registerAccount(w.daria, w.biz.id, { institution: "Pretend Card Co", accountType: "CREDIT_CARD", nickname: "Visa", last4: "7001" });
    await expect(requestHistoricalRecords(w.daria, w.biz.id, { docType: "CARD_STATEMENT", start: "2026-01-01", end: "2026-06-30" })).rejects.toThrow(/Choose the account/);
    const { request } = await requestHistoricalRecords(w.daria, w.biz.id, { docType: "CARD_STATEMENT", bookkeepingAccountId: card.id, start: "2026-01-01", end: "2026-06-30" });
    expect(request).toMatchObject({ kind: "HISTORICAL", status: "OPEN", bookkeepingAccountId: card.id, docType: "CARD_STATEMENT" });
    expect(request!.title).toMatch(/Credit card statements — Visa ••7001 — Jan 1, 2026 – Jun 30, 2026/);
    const { token } = await invitePortalUser(w.tabitha, w.biz.id, { email: "pat@pretend.example", name: "Pat Pretend", role: "OWNER" });
    const u = await acceptPortalInvite(token!, "Pretend-Strong-Pass-1");
    const doc = await portalUploadDocument({ id: u.id, name: u.name, email: u.email }, { clientId: w.biz.id, requestId: request!.id, bytes: PDF, originalName: "visa-h1.pdf" });
    expect(doc).toMatchObject({ bookkeepingAccountId: card.id, docType: "CARD_STATEMENT", requestId: request!.id });
    expect(doc.periodStart!.toISOString().slice(0, 10)).toBe("2026-01-01");
    expect(doc.periodEnd!.toISOString().slice(0, 10)).toBe("2026-06-30");
    expect((await prisma.documentRequest.findUniqueOrThrow({ where: { id: request!.id } })).status).toBe("SUBMITTED");
    // Already received: the same records are never asked for again.
    const again = await requestHistoricalRecords(w.daria, w.biz.id, { docType: "CARD_STATEMENT", bookkeepingAccountId: card.id, start: "2026-03-01", end: "2026-03-31" });
    expect(again).toMatchObject({ created: false, received: true });
  });
});

describe("onboarding gaps", () => {
  it("Coetha raises an internal office task (never a client request) for the prior statements between the books' opening date and the start of the bank feed", async () => {
    const w = await world();
    const chk = await registerAccount(w.daria, w.biz.id, { institution: "Pretend National Bank", accountType: "CHECKING", nickname: "Operating", last4: "0042", gl: "NEW" });
    await postOpeningBalances(w.daria, w.biz.id, { date: "2026-06-30", balances: [{ accountId: chk.ledgerAccountId!, amount: "100.00" }] });
    const conn = await connect(w, w.biz.id);
    await monitorConnectionAccount(w.daria, w.biz.id, conn.accounts[0].id, chk.id);
    pages = [{ added: [t("g1", "p-chk", 10, "2026-10-02", "PRETEND FEE")] }];
    await syncConnection(conn.id, "MANUAL", w.daria);
    await runWorkflowMonitor(null, w.biz.id, 2026, 10, { today: TODAY });
    // Our office retrieves statements itself: no client request, an internal task instead.
    expect(await prisma.documentRequest.count({ where: { clientId: w.biz.id, kind: "HISTORICAL" } })).toBe(0);
    const h = await prisma.task.findFirstOrThrow({ where: { clientId: w.biz.id, title: { startsWith: "Retrieve prior bank statements" } } });
    expect(h.title).toMatch(/^Retrieve prior bank statements — .+ — /);
    expect(chk.id).toBeTruthy();
    expect(h.details).toMatch(/books open on 2026-07-01/);
  });
});

describe("request routing: routine requests go out on their own, the rest wait for Tabitha", () => {
  it("classifies requests explicitly", () => {
    const cases: [Parameters<typeof classifyRequest>[0], "ROUTINE" | "REVIEW"][] = [
      [{ kind: "STATEMENT", docType: "BANK_STATEMENT", bookkeepingAccountId: "a1", accountType: "CHECKING" }, "ROUTINE"],
      [{ kind: "STATEMENT", docType: "CARD_STATEMENT", bookkeepingAccountId: "a2", accountType: "CREDIT_CARD" }, "ROUTINE"],
      [{ kind: "STATEMENT", docType: "BANK_STATEMENT", bookkeepingAccountId: null }, "REVIEW"], // no specific account
      [{ kind: "MONTHLY", docType: "PAYROLL_REPORT" }, "ROUTINE"],
      [{ kind: "SUPPORTING", docType: "RECEIPTS", evidence: "PRETEND FLOUR SUPPLY" }, "ROUTINE"],
      [{ kind: "SUPPORTING", docType: "MERCHANT_STATEMENT" }, "ROUTINE"],
      [{ kind: "SUPPORTING", docType: "LOAN_AGREEMENT", bookkeepingAccountId: "l1", accountType: "LOAN" }, "ROUTINE"],
      [{ kind: "SUPPORTING", docType: "LOAN_AGREEMENT", bookkeepingAccountId: "c1", accountType: "CREDIT_CARD" }, "REVIEW"], // not a known loan account
      [{ kind: "SUPPORTING", docType: "LOAN_AGREEMENT" }, "REVIEW"],
      [{ kind: "SUPPORTING", docType: "BK_OTHER", topic: "DEPOSITS", amountCents: DEPOSIT_REVIEW_THRESHOLD_CENTS }, "ROUTINE"],
      [{ kind: "SUPPORTING", docType: "BK_OTHER", topic: "DEPOSITS", amountCents: DEPOSIT_REVIEW_THRESHOLD_CENTS + 1 }, "REVIEW"], // above the threshold
      [{ kind: "SUPPORTING", docType: "BK_OTHER", topic: "TRANSFERS" }, "REVIEW"], // owner / related party possible
      [{ kind: "SUPPORTING", docType: "RECEIPTS", evidence: "TRANSFER TO OWNER PERSONAL" }, "REVIEW"], // sensitive wording
      [{ kind: "SUPPORTING", docType: "RECEIPTS", evidence: "IRS PAYMENT 1040" }, "REVIEW"], // tax-sensitive
      [{ kind: "STATEMENT", docType: "BANK_STATEMENT", bookkeepingAccountId: "a1", confidence: 0.5 }, "REVIEW"], // low confidence
      [{ kind: "YEAR_END", docType: "NEC_1099" }, "REVIEW"],
      [{ kind: "SUPPORTING", docType: "BK_OTHER" }, "REVIEW"], // unclear
    ];
    for (const [input, want] of cases) expect(classifyRequest(input).routing, JSON.stringify(input)).toBe(want);
  });

  it("a missing statement becomes an internal office task, never a client request; it's never repeated", async () => {
    const w = await world();
    const chk = await registerAccount(w.daria, w.biz.id, { institution: "Pretend National Bank", accountType: "CHECKING", nickname: "Operating", last4: "0042" });
    const { token } = await invitePortalUser(w.tabitha, w.biz.id, { email: "pat@pretend.example", name: "Pat Pretend", role: "OWNER" });
    await acceptPortalInvite(token!, "Pretend-Strong-Pass-1");
    const before = await prisma.notification.count();
    const r1 = await runWorkflowMonitor(null, w.biz.id, 2026, 10, { today: TODAY });
    expect([r1.sent, r1.officeTasks]).toEqual([0, 1]);
    expect(await prisma.documentRequest.count({ where: { clientId: w.biz.id, kind: "STATEMENT" } })).toBe(0);
    const task = await prisma.task.findFirstOrThrow({ where: { clientId: w.biz.id } });
    expect(task).toMatchObject({ title: "Retrieve bank statement — Operating ••0042 — October 2026", assigneeId: w.daria.id, status: "OPEN" });
    expect(task.details).toMatch(/reconcile Operating ••0042 for October 2026/);
    expect(await prisma.notification.count()).toBe(before); // the client is never told to send it
    expect(chk.id).toBeTruthy();
    // Running again never repeats it.
    expect((await runWorkflowMonitor(null, w.biz.id, 2026, 10, { today: TODAY })).officeTasks).toBe(0);
    expect(await prisma.task.count({ where: { clientId: w.biz.id } })).toBe(1);
    // The current month isn't due: nothing for it.
    await runWorkflowMonitor(null, w.biz.id, 2026, 11, { today: TODAY });
    expect(await prisma.task.count({ where: { clientId: w.biz.id } })).toBe(1);
  });

  it("unusual or sensitive requests wait for Tabitha; staff can't send them; with the switch off routine ones wait for staff", async () => {
    const w = await world();
    // Supporting requests reach a client only after Tabitha authorizes client communications (tested in ask-client.test.ts).
    await setOwnerSwitch(w.tabitha, "clientRollout", true);
    const chk = await registerAccount(w.daria, w.biz.id, { institution: "Pretend National Bank", accountType: "CHECKING", last4: "0042", gl: "NEW" });
    const conn = await connect(w, w.biz.id);
    await monitorConnectionAccount(w.daria, w.biz.id, conn.accounts[0].id, chk.id);
    pages = [{ added: [
      t("d1", "p-chk", -4800, "2026-10-06", "MOBILE DEPOSIT"), // $4,800 unexplained deposit: above the threshold
      t("d2", "p-chk", 900, "2026-10-09", "ZELLE TO J PRETEND"), // transfer to an unknown account
    ] }];
    await syncConnection(conn.id, "MANUAL", w.daria);
    await runWorkflowMonitor(null, w.biz.id, 2026, 10, { today: TODAY });
    const held = await prisma.documentRequest.findMany({ where: { clientId: w.biz.id, routing: "REVIEW" }, orderBy: { draftKey: "asc" } });
    expect(held.map((r) => [r.draftKey?.split(":")[0], r.status])).toEqual([["deposits", "DRAFT"], ["transfers", "DRAFT"]]);
    expect(held[0].routingReason).toMatch(/above the review threshold/);
    await expect(sendClientRequest(w.daria, w.biz.id, held[0].id)).rejects.toThrow(/Tabitha reviews this request/);
    await expect(sendClientRequest(null, w.biz.id, held[0].id)).rejects.toBeInstanceOf(ForbiddenError);
    await sendClientRequest(w.tabitha, w.biz.id, held[0].id);
    expect((await prisma.documentRequest.findUniqueOrThrow({ where: { id: held[0].id } })).status).toBe("OPEN");
    // Tabitha can turn automatic sending off; then routine requests wait for staff.
    await expect(setOwnerSwitch(w.daria, "coethaAutoSend", false)).rejects.toBeInstanceOf(ForbiddenError);
    await setOwnerSwitch(w.tabitha, "coethaAutoSend", false);
    pages = [{ added: [t("n1", "p-chk", -1200, "2026-11-10", "STRIPE PAYOUT")] }];
    await syncConnection(conn.id, "MANUAL", w.daria);
    await runWorkflowMonitor(null, w.biz.id, 2026, 11, { today: "2026-12-03" });
    // (Statements are never requested: our office retrieves them.) A routine request — the processor's statement — waits for staff.
    expect(await prisma.documentRequest.count({ where: { clientId: w.biz.id, kind: "STATEMENT" } })).toBe(0);
    const nov = await prisma.documentRequest.findFirstOrThrow({ where: { clientId: w.biz.id, docType: "MERCHANT_STATEMENT", periodEnd: new Date("2026-11-30T00:00:00Z") } });
    expect(nov).toMatchObject({ status: "DRAFT", routing: "ROUTINE" });
    await sendClientRequest(w.daria, w.biz.id, nov.id); // one-click send by staff
    expect((await prisma.documentRequest.findUniqueOrThrow({ where: { id: nov.id } })).status).toBe("OPEN");
  });

  it("a statement the adapter can retrieve is filed instead of requested", async () => {
    const w = await world();
    const chk = await registerAccount(w.daria, w.biz.id, { institution: "Pretend National Bank", accountType: "CHECKING", last4: "0042", gl: "NEW" });
    const conn = await connect(w, w.biz.id);
    await monitorConnectionAccount(w.daria, w.biz.id, conn.accounts[0].id, chk.id);
    setStatementSource({ name: "fictional", fetchMonthly: async () => ({ available: true, pdf: PDF, statementDate: "2026-10-31", endingBalanceCents: 0 }) });
    await runWorkflowMonitor(null, w.biz.id, 2026, 10, { today: TODAY });
    expect(await prisma.documentRequest.count({ where: { clientId: w.biz.id, kind: "STATEMENT" } })).toBe(0);
    expect(await prisma.document.count({ where: { clientId: w.biz.id, bookkeepingAccountId: chk.id, docType: "BANK_STATEMENT", visibility: "STAFF_ONLY" } })).toBe(1);
  });
});

describe("staff upload the statements Coetha asks for (new clients without a feed)", () => {
  it("an upload against a request is filed to its account and period and answers it; a plain statement upload answers the matching request", async () => {
    const w = await world();
    const chk = await registerAccount(w.daria, w.biz.id, { institution: "Pretend National Bank", accountType: "CHECKING", nickname: "Operating", last4: "0042" });
    const sav = await registerAccount(w.daria, w.biz.id, { institution: "Pretend National Bank", accountType: "SAVINGS", nickname: "Reserve", last4: "0043" });
    await runWorkflowMonitor(null, w.biz.id, 2026, 10, { today: TODAY });
    // Coetha no longer asks the client for statements: the office files them. A statement request a
    // staff member writes by hand (a one-off) is answered the same way as before.
    expect(await prisma.documentRequest.count({ where: { clientId: w.biz.id, kind: "STATEMENT" } })).toBe(0);
    const mk = (acct: typeof chk) => createClientRequest(w.daria, w.biz.id, { kind: "STATEMENT", docType: "BANK_STATEMENT", bookkeepingAccountId: acct.id, start: "2026-10-01", end: "2026-10-31", title: `Bank statement — ${acct.id} — October 2026` }, { send: false });
    await mk(chk);
    await mk(sav);
    const [r1, r2] = await prisma.documentRequest.findMany({ where: { clientId: w.biz.id, kind: "STATEMENT" }, orderBy: { title: "asc" } });
    await expect(staffUploadForRequest(w.eve, w.biz.id, r1.id, { bytes: PDF, originalName: "oct.pdf" })).rejects.toBeInstanceOf(ForbiddenError);
    const doc = await staffUploadForRequest(w.daria, w.biz.id, r1.id, { bytes: PDF, originalName: "oct.pdf" });
    expect(doc).toMatchObject({ category: "BOOKKEEPING", visibility: "STAFF_ONLY", docType: "BANK_STATEMENT" });
    const filed = await prisma.document.findUniqueOrThrow({ where: { id: doc.id } });
    expect(filed).toMatchObject({ requestId: r1.id, bookkeepingAccountId: r1.bookkeepingAccountId });
    expect((await prisma.documentRequest.findUniqueOrThrow({ where: { id: r1.id } })).status).toBe("SUBMITTED");
    const other = r2.bookkeepingAccountId === chk.id ? chk : sav;
    await staffUploadStatement(w.daria, w.biz.id, { accountId: other.id, month: "2026-10", bytes: new TextEncoder().encode("%PDF-1.4\n% another statement\n"), originalName: "oct-2.pdf" });
    expect((await prisma.documentRequest.findUniqueOrThrow({ where: { id: r2.id } })).status).toBe("SUBMITTED");
    // Statements on file: the reconciliations now show them as received.
    const p = await monthlyAccountProgress(w.daria, w.biz.id, 2026, 10, { today: TODAY });
    expect(p.rows.map((r) => r.rec?.statementStatus)).toEqual(["RECEIVED", "RECEIVED"]);
  });
});

describe("office work vs client portal access", () => {
  it("the office keeps the books with client access OFF; only an OWNER login of the Bookkeeping Client gets the business view", async () => {
    const w = await world();
    expect((await prisma.client.findUniqueOrThrow({ where: { id: w.biz.id } })).businessAccess).toBe("OFF");
    // Office: books, accounts, entries.
    const e = await postJournalEntry(w.daria, w.biz.id, { date: "2026-10-05", memo: "Pretend owner contribution", lines: [{ accountId: await w.code(w.biz.id, "1000"), debit: "500" }, { accountId: await w.code(w.biz.id, "3000"), credit: "500" }] });
    expect(e.id).toBeTruthy();
    await expect(registerAccount(w.daria, w.biz.id, { institution: "Pretend National Bank", accountType: "SAVINGS", last4: "0043" })).resolves.toBeTruthy();
    // Client: the business is on the Bookkeeping Client list, so its OWNER login has the business
    // view with no approval step (Tabitha's rule). Nothing is switched on per login, Managed Business
    // access stays OFF, and an authorized contact still needs the per-login switch.
    const { token } = await invitePortalUser(w.tabitha, w.biz.id, { email: "pat@pretend.example", name: "Pat Pretend", role: "OWNER" });
    const u = await acceptPortalInvite(token!, "Pretend-Strong-Pass-1");
    await expect(requireClientAccess(u.id, w.biz.id, "bookkeeping")).resolves.toMatchObject({ canViewBookkeeping: true });
    expect((await prisma.portalAccess.findFirstOrThrow({ where: { portalUserId: u.id, clientId: w.biz.id } })).canViewBookkeeping).toBe(false);
    const { token: t2 } = await invitePortalUser(w.tabitha, w.biz.id, { email: "casey@pretend.example", name: "Casey Contact", role: "AUTHORIZED_CONTACT" });
    const contact = await acceptPortalInvite(t2!, "Pretend-Strong-Pass-2");
    await expect(requireClientAccess(contact.id, w.biz.id, "bookkeeping")).rejects.toBeInstanceOf(ForbiddenError);
    expect((await prisma.client.findUniqueOrThrow({ where: { id: w.biz.id } })).businessAccess).toBe("OFF");
    // A client that is neither a Bookkeeping Client nor a Managed Business is still refused.
    const plain = await createClient(w.tabitha, { businessName: "Pretend Tax-Only Shop", clientType: "BUSINESS", status: "ACTIVE" });
    await expect(setupLedger(w.tabitha, plain.id, { basis: "CASH" })).rejects.toThrow(/Regular Tax Client/);
  });
});

describe("twelve credit cards", () => {
  it("12 cards → 12 accounts with their own liability GL → 12 reconciliation records", async () => {
    const w = await world();
    await registerAccount(w.daria, w.biz.id, { institution: "Pretend National Bank", accountType: "CHECKING", last4: "0042" });
    await registerAccount(w.daria, w.biz.id, { institution: "Pretend National Bank", accountType: "SAVINGS", last4: "0043" });
    for (let i = 1; i <= 12; i++) await registerAccount(w.daria, w.biz.id, { institution: i <= 6 ? "Pretend Card Co" : "Fictional Rewards Bank", accountType: "CREDIT_CARD", nickname: `Card ${i}`, last4: String(7000 + i) });
    const cards = await prisma.bookkeepingAccount.findMany({ where: { clientId: w.biz.id, accountType: "CREDIT_CARD" }, include: { ledgerAccount: true } });
    expect(cards).toHaveLength(12);
    expect(new Set(cards.map((c) => c.ledgerAccountId)).size).toBe(12);
    expect(cards.every((c) => c.ledgerAccount?.type === "LIABILITY" && c.ledgerAccount.subtype === "CREDIT_CARD")).toBe(true);
    const prog = await monthlyAccountProgress(w.daria, w.biz.id, 2026, 10, { today: TODAY });
    expect(prog.total).toBe(14);
    expect(await prisma.accountReconciliation.count({ where: { clientId: w.biz.id, year: 2026, month: 10, bookkeepingAccount: { accountType: "CREDIT_CARD" } } })).toBe(12);
    // Never a full number or a credential.
    await expect(registerAccount(w.daria, w.biz.id, { institution: "Pretend Card Co", accountType: "CREDIT_CARD", nickname: "4111 1111 1111 1111" })).rejects.toThrow(/full account or card numbers/);
    await expect(registerAccount(w.daria, w.biz.id, { institution: "Pretend Card Co", accountType: "CREDIT_CARD", nickname: "password is hunter2" })).rejects.toThrow(/passwords/);
    await expect(registerAccount(w.daria, w.biz.id, { institution: "Pretend Card Co", accountType: "CREDIT_CARD", last4: "41111" })).rejects.toThrow(/last 4/);
  });
});

describe("employee cards on one shared credit account", () => {
  it("detects them (same limit and balance), feeds one liability account, and never doubles a charge", async () => {
    const pure = detectSharedCards([
      { id: "a", type: "credit", subtype: "credit card", mask: "1001", name: "Pretend Business Card", currentBalanceCents: 152_000, creditLimitCents: 2_500_000 },
      { id: "b", type: "credit", subtype: "credit card", mask: "1002", name: "Pretend Business Card", currentBalanceCents: 152_000, creditLimitCents: 2_500_000 },
      { id: "c", type: "credit", subtype: "credit card", mask: "2001", name: "Other Pretend Card", currentBalanceCents: 9_000, creditLimitCents: 500_000 },
    ]);
    expect(pure).toEqual([{ id: "b", sharedWithId: "a", reason: expect.stringMatching(/Same credit limit .* ••1001/) }]);

    const w = await world();
    accounts = [
      { account_id: "p-c1", name: "Pretend Business Card", mask: "1001", type: "credit", subtype: "credit card", balances: { current: 1520, limit: 25000 } },
      { account_id: "p-c2", name: "Pretend Business Card", mask: "1002", type: "credit", subtype: "credit card", balances: { current: 1520, limit: 25000 } },
    ];
    const conn = await connect(w, w.biz.id);
    const [c1, c2] = conn.accounts.sort((a, b) => a.mask!.localeCompare(b.mask!));
    expect((await prisma.bankConnectionAccount.findUniqueOrThrow({ where: { id: c2.id } })).sharedStatus).toBe("SUGGESTED");
    await monitorConnectionAccount(w.daria, w.biz.id, c1.id, "NEW");
    const lid = (await prisma.bankConnectionAccount.findUniqueOrThrow({ where: { id: c1.id } })).ledgerAccountId;
    expect((await prisma.bankConnectionAccount.findUniqueOrThrow({ where: { id: c2.id } })).ledgerAccountId).toBe(lid);
    await decideSharedCard(w.daria, w.biz.id, c2.id, "CONFIRM");
    pages = [{ added: [
      t("s1", "p-c1", 45.5, "2026-10-08", "PRETEND COFFEE"),
      t("s2", "p-c2", 45.5, "2026-10-08", "PRETEND COFFEE"), // the same charge, reported under the employee card
      t("s3", "p-c2", 120, "2026-10-09", "PRETEND FUEL"), // the employee's own charge
    ] }];
    const r = await syncConnection(conn.id, "MANUAL", w.daria);
    expect(r).toMatchObject({ added: 2, matched: 1 });
    const rows = await prisma.bankTransaction.findMany({ where: { clientId: w.biz.id } });
    expect(rows.every((x) => x.accountId === lid)).toBe(true);
    expect(await prisma.bookkeepingAccount.count({ where: { clientId: w.biz.id } })).toBe(1); // one liability account
    // Staff can override: a card that is really separate gets its own account.
    await decideSharedCard(w.daria, w.biz.id, c2.id, "SEPARATE");
    expect((await prisma.bankConnectionAccount.findUniqueOrThrow({ where: { id: c2.id } })).ledgerAccountId).toBeNull();
    expect(await prisma.auditLog.count({ where: { action: { in: ["banking.shared_card_confirmed", "banking.shared_card_separated"] } } })).toBe(2);
  });

  it("an employee card registered by hand is a sub-card without its own GL account", async () => {
    const w = await world();
    const main = await registerAccount(w.daria, w.biz.id, { institution: "Pretend Card Co", accountType: "CREDIT_CARD", nickname: "Company card", last4: "1001" });
    const sub = await registerAccount(w.daria, w.biz.id, { institution: "Pretend Card Co", accountType: "CREDIT_CARD", last4: "1002", parentAccountId: main.id, cardholderLabel: "Delivery driver" });
    expect(sub).toMatchObject({ parentAccountId: main.id, ledgerAccountId: null });
    const prog = await monthlyAccountProgress(w.daria, w.biz.id, 2026, 10, { today: TODAY });
    expect(prog.total).toBe(1);
    expect(prog.rows[0].account.subCards.map((s) => s.last4)).toEqual(["1002"]);
  });
});

describe("card payments are transfers, never expenses", () => {
  it("only the bank side connected: the payment is suggested as a transfer to the card liability, and expenses stay 0", async () => {
    const w = await world();
    const chk = await registerAccount(w.daria, w.biz.id, { institution: "Pretend National Bank", accountType: "CHECKING", last4: "0042" });
    const card = await registerAccount(w.daria, w.biz.id, { institution: "Pretend Card Co", accountType: "CREDIT_CARD", nickname: "Visa", last4: "7001" });
    const conn = await connect(w, w.biz.id);
    await monitorConnectionAccount(w.daria, w.biz.id, conn.accounts[0].id, chk.id);
    pages = [{ added: [t("p1", "p-chk", 800, "2026-10-20", "ONLINE PAYMENT TO CARD 7001")] }];
    await syncConnection(conn.id, "MANUAL", w.daria);
    const row = await prisma.bankTransaction.findFirstOrThrow({ where: { clientId: w.biz.id } });
    const s = (await suggestCategories(w.daria, w.biz.id)).get(row.id)!;
    expect(s).toMatchObject({ accountId: card.ledgerAccountId, source: "TRANSFER" });
    await categorizeBankTransaction(w.daria, w.biz.id, row.id, { accountId: s.accountId });
    const pl = await profitAndLoss(w.daria, w.biz.id, { from: "2026-10-01", to: "2026-10-31" });
    expect(pl.totalExpenses.total).toBe(0);
  });

  it("both sides connected: posting the bank side links the card's payment row (recorded once)", async () => {
    const w = await world();
    const chk = await registerAccount(w.daria, w.biz.id, { institution: "Pretend National Bank", accountType: "CHECKING", last4: "0042" });
    const card = await registerAccount(w.daria, w.biz.id, { institution: "Pretend Card Co", accountType: "CREDIT_CARD", last4: "7001" });
    accounts = [...accounts, { account_id: "p-card", name: "Pretend Card", mask: "7001", type: "credit", subtype: "credit card" }];
    const conn = await connect(w, w.biz.id);
    await monitorConnectionAccount(w.daria, w.biz.id, conn.accounts.find((a) => a.mask === "0042")!.id, chk.id);
    await monitorConnectionAccount(w.daria, w.biz.id, conn.accounts.find((a) => a.mask === "7001")!.id, card.id);
    pages = [{ added: [t("b1", "p-chk", 800, "2026-10-20", "AUTOPAY PRETEND CARD CO"), t("c1", "p-card", -800, "2026-10-21", "PAYMENT THANK YOU")] }];
    await syncConnection(conn.id, "MANUAL", w.daria);
    const bankRow = await prisma.bankTransaction.findFirstOrThrow({ where: { accountId: chk.ledgerAccountId! } });
    const r = await categorizeBankTransaction(w.daria, w.biz.id, bankRow.id, { accountId: card.ledgerAccountId! });
    expect(r.matchedTransferId).toBeTruthy();
    expect(await prisma.journalEntry.count({ where: { clientId: w.biz.id, source: "BANK" } })).toBe(1);
    expect(await prisma.bankTransaction.count({ where: { clientId: w.biz.id, status: "UNREVIEWED" } })).toBe(0);
  });
});

describe("monthly reconciliation", () => {
  it("difference math for a bank account and for a card (liability)", () => {
    // Bank: 1,000 + 500 in − 200 out = 1,300.
    expect(reconMath("ASSET", 100_000, 130_000, [50_000, -20_000])).toMatchObject({ paymentsCreditsCents: 50_000, chargesDebitsCents: 20_000, expectedEnding: 130_000, differenceCents: 0 });
    // Card owed 300; charges 120 and 45.50; payment 300 → owed 165.50. Statement says 175.50 → 10.00 unexplained.
    expect(reconMath("LIABILITY", 30_000, 17_550, [-12_000, -4_550, 30_000])).toMatchObject({ paymentsCreditsCents: 30_000, chargesDebitsCents: 16_550, expectedEnding: 16_550, differenceCents: 1_000 });
    expect(reconMath("ASSET", null, 1, [])).toMatchObject({ differenceCents: null });
  });

  it("Coetha prepares it, flags exceptions, and only Tabitha approves (the ledger must agree)", async () => {
    const w = await world();
    const chk = await registerAccount(w.daria, w.biz.id, { institution: "Pretend National Bank", accountType: "CHECKING", last4: "0042", openingBalance: "1000.00", openingBalanceDate: "2026-09-30" });
    await postOpeningBalances(w.daria, w.biz.id, { date: "2026-09-30", balances: [{ accountId: chk.ledgerAccountId!, amount: "1000.00" }] });
    const conn = await connect(w, w.biz.id);
    await monitorConnectionAccount(w.daria, w.biz.id, conn.accounts[0].id, chk.id);
    pages = [{ added: [t("d1", "p-chk", -500, "2026-10-05", "PRETEND CATERING DEPOSIT"), t("d2", "p-chk", 200, "2026-10-15", "PRETEND RENT")] }];
    await syncConnection(conn.id, "MANUAL", w.daria);
    let rec = await enterStatementBalances(w.daria, w.biz.id, chk.id, 2026, 10, { ending: "1290.00" });
    expect(rec).toMatchObject({ beginningBalanceCents: 100_000, transactionsImported: 2, differenceCents: -1_000, status: "EXCEPTION", unmatchedCount: 2 });
    expect(rec!.exceptions[0]).toMatch(/Difference of -\$10.00/);
    rec = await enterStatementBalances(w.daria, w.biz.id, chk.id, 2026, 10, { ending: "1300.00" });
    expect(rec).toMatchObject({ differenceCents: 0, status: "IN_PROGRESS" });
    for (const r of await prisma.bankTransaction.findMany({ where: { clientId: w.biz.id } })) await categorizeBankTransaction(w.daria, w.biz.id, r.id, { accountId: await w.code(w.biz.id, r.amountCents > 0 ? "4000" : "6500") });
    rec = await enterStatementBalances(w.daria, w.biz.id, chk.id, 2026, 10, { ending: "1300.00" });
    expect(rec!.status).toBe("READY");
    await expect(approveReconciliation(w.daria, w.biz.id, rec!.id)).rejects.toBeInstanceOf(ForbiddenError);
    const ok = await approveReconciliation(w.tabitha, w.biz.id, rec!.id);
    expect(ok.status).toBe("APPROVED");
    expect(await prisma.bankReconciliation.count({ where: { accountId: chk.ledgerAccountId! } })).toBe(1);
    expect(await prisma.auditLog.count({ where: { action: "banking.reconciliation_approved", actorId: w.tabitha.id } })).toBe(1);
  });

  it("the progress view counts green, red, yellow and gray", async () => {
    const w = await world();
    const a = await registerAccount(w.daria, w.biz.id, { institution: "Pretend National Bank", accountType: "CHECKING", last4: "0042", openingBalance: "0", openingBalanceDate: "2026-09-30" });
    const b = await registerAccount(w.daria, w.biz.id, { institution: "Pretend National Bank", accountType: "SAVINGS", last4: "0043" });
    await registerAccount(w.daria, w.biz.id, { institution: "Pretend Card Co", accountType: "CREDIT_CARD", last4: "7001", openingBalance: "0", openingBalanceDate: "2026-09-30" });
    const balanced = await enterStatementBalances(w.daria, w.biz.id, a.id, 2026, 10, { ending: "0" }); // balanced, nothing to review
    await createClientRequest(w.daria, w.biz.id, { kind: "STATEMENT", title: "Savings statement", docType: "BANK_STATEMENT", bookkeepingAccountId: b.id, start: "2026-10-01", end: "2026-10-31" });
    let p = await monthlyAccountProgress(w.daria, w.biz.id, 2026, 10, { today: TODAY });
    // Balanced is NOT green until Tabitha approves: checking and savings (requested) yellow, card (no statement) red.
    expect(p.counts).toEqual({ GREEN: 0, RED: 1, YELLOW: 2, GRAY: 0 });
    expect(p).toMatchObject({ reconciled: 0, awaitingApproval: 1 });
    expect((await monthlyChecklist(w.biz.id, 2026, 10, { today: TODAY })).items.find((i) => i.key === "RECONCILED")).toMatchObject({ state: "MISSING", detail: expect.stringMatching(/0 of 3 accounts reconciled and approved · 1 balanced, awaiting Tabitha/) });
    await approveReconciliation(w.tabitha, w.biz.id, balanced!.id);
    p = await monthlyAccountProgress(w.daria, w.biz.id, 2026, 10, { today: TODAY });
    expect(p.counts).toEqual({ GREEN: 1, RED: 1, YELLOW: 1, GRAY: 0 });
    expect(p.reconciled).toBe(1);
    const nov = await monthlyAccountProgress(w.daria, w.biz.id, 2026, 11, { today: TODAY });
    expect(nov.counts.GRAY).toBe(3);
  });
});

describe("isolation and permissions", () => {
  it("one business's accounts can't be used for another; unassigned staff can't manage either", async () => {
    const w = await world();
    const mine = await registerAccount(w.daria, w.biz.id, { institution: "Pretend Card Co", accountType: "CREDIT_CARD", last4: "1001" });
    await expect(registerAccount(w.daria, w.other.id, { institution: "Pretend Card Co", accountType: "CREDIT_CARD", last4: "1002", parentAccountId: mine.id })).rejects.toThrow(/this business's own credit card/);
    const conn = await connect(w, w.other.id);
    await expect(monitorConnectionAccount(w.daria, w.other.id, conn.accounts[0].id, mine.id)).rejects.toThrow(/this business's registered accounts/);
    await expect(monitorConnectionAccount(w.daria, w.biz.id, conn.accounts[0].id, mine.id)).rejects.toThrow(/Bank account not found/);
    await expect(registerAccount(w.eve, w.biz.id, { institution: "Pretend", accountType: "CHECKING" })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(monthlyAccountProgress(w.eve, w.biz.id, 2026, 10)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(createClientRequest(w.daria, w.other.id, { kind: "STATEMENT", title: "x", docType: "CARD_STATEMENT", bookkeepingAccountId: mine.id, start: "2026-10-01", end: "2026-10-31" })).rejects.toThrow(/isn't registered for this business/);
    // A bank connection never grants client portal access.
    expect((await prisma.client.findUniqueOrThrow({ where: { id: w.other.id } })).businessAccess).toBe("OFF");
  });

  it("audit trail: account changes, connections, imports, reconciliations and requests are recorded", async () => {
    const w = await world();
    const chk = await registerAccount(w.daria, w.biz.id, { institution: "Pretend National Bank", accountType: "CHECKING", last4: "0042" });
    const conn = await connect(w, w.biz.id);
    await monitorConnectionAccount(w.daria, w.biz.id, conn.accounts[0].id, chk.id);
    pages = [{ added: [t("a1", "p-chk", 10, "2026-10-02", "PRETEND FEE")] }];
    await syncConnection(conn.id, "MANUAL", w.daria);
    await runWorkflowMonitor(w.daria, w.biz.id, 2026, 10, { today: TODAY });
    const actions = new Set((await prisma.auditLog.findMany({ where: { clientId: w.biz.id } })).map((a) => a.action));
    for (const a of ["banking.account_registered", "banking.connected", "banking.account_monitored", "banking.synced", "banking.reconciliation_prepared", "coetha.office_statement_task", "coetha.workflow_checked"]) expect(actions.has(a), a).toBe(true);
  });
});
