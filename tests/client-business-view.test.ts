import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeUser, managed, prisma, resetDb } from "./db";
import { ForbiddenError } from "@/lib/auth/actor";
import { encryptSecret } from "@/lib/crypto";
import { createClient } from "@/lib/services/clients";
import { acceptPortalInvite, invitePortalUser } from "@/lib/services/portal-accounts";
import { accessibleClients, requireClientAccess } from "@/lib/portal/access";
import { loadPortalHome } from "@/lib/portal/views";
import { homeTiles } from "@/components/portal/home-view";
import { portalUploadDocument } from "@/lib/services/documents";
import { postJournalEntry, setupLedger } from "@/lib/services/ledger";
import { createDocumentRequest, openPeriod, setRequestStatus } from "@/lib/services/bookkeeping";
import { checklistStatus } from "@/lib/services/business-tax-requests";
import { balanceDay, recordBalance } from "@/lib/services/banking";
import { bankFeed } from "@/lib/services/bank-feed";
import { uploadFieldsFromForm } from "@/lib/bk-uploads";
import { businessChecklist, checklistTaxYear, homeKind, portalBankFeed, portalBusinessDashboard, portalRefreshBank, RateLimitedError, yearEndChecklist } from "@/lib/services/portal-business";
import { GET as bankRoute } from "@/app/api/client/bank/route";
import { POST as refreshRoute } from "@/app/api/client/bank/refresh/route";

/**
 * Personal / Business under one sign-in. Fictional people, businesses, banks and amounts only;
 * Plaid is simulated (nothing leaves the test).
 */

let portalSession: { id: string; name: string; email: string } | null = null;
vi.mock("@/lib/portal/session", async (orig) => ({ ...(await orig<object>()), getPortalUser: async () => portalSession }));

let plaidCalls: string[] = [];
const PDF = () => new TextEncoder().encode(`%PDF-1.4\n% fictional ${Math.random()}\n`);

beforeEach(async () => {
  await resetDb();
  portalSession = null;
  plaidCalls = [];
  vi.stubEnv("MALWARE_SCAN_URL", "https://scanner.test/scan");
  vi.stubEnv("PLAID_CLIENT_ID", "fictional-client-id");
  vi.stubEnv("PLAID_SECRET", "fictional-sandbox-secret");
  vi.stubEnv("PLAID_ENV", "sandbox");
  vi.stubGlobal("fetch", async (url: string) => {
    if (String(url).includes("scanner.test")) return new Response(JSON.stringify({ clean: true }), { status: 200 });
    const path = new URL(url).pathname;
    plaidCalls.push(path);
    const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200 });
    if (path === "/transactions/sync") return json({ added: [{ transaction_id: "t-flour", account_id: "acc-chk", amount: 84.5, date: "2026-11-03", name: "FICTIONAL FLOUR SUPPLY", pending: false }], modified: [], removed: [], next_cursor: "c1", has_more: false });
    if (path === "/accounts/get") return json({ accounts: [{ account_id: "acc-chk", name: "Pretend Business Checking", mask: "4094", type: "depository", subtype: "checking", balances: { current: 12500.25, available: 12000, iso_currency_code: "USD" } }], item: {} });
    return new Response(JSON.stringify({ error_code: "NOT_FOUND" }), { status: 404 });
  });
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

async function world() {
  const tabitha = await makeUser("ADMIN", "Tabitha");
  await prisma.ownerAccess.create({ data: { userId: tabitha.id, isPrimary: true } });
  const pat = await createClient(tabitha, { firstName: "Pat", lastName: "Pretend", clientType: "INDIVIDUAL", status: "ACTIVE", email: "pat@fictional.example" });
  const bakery = await createClient(tabitha, { businessName: "Lakeside Pretend Bakery LLC", clientType: "BUSINESS", status: "ACTIVE", assignedToId: tabitha.id });
  const other = await createClient(tabitha, { businessName: "Other Fictional Hauling LLC", clientType: "BUSINESS", status: "ACTIVE", assignedToId: tabitha.id });
  const { token } = await invitePortalUser(tabitha, pat.id, { email: "pat@fictional.example", name: "Pat Pretend", role: "OWNER" });
  const u = await acceptPortalInvite(token!, "Pat-Strong-Pass-12345");
  await invitePortalUser(tabitha, bakery.id, { email: "pat@fictional.example", name: "Pat Pretend", role: "OWNER" });
  const login = { id: u.id, name: u.name, email: u.email };
  // Another owner, for the other business.
  const { token: t2 } = await invitePortalUser(tabitha, other.id, { email: "sam@fictional.example", name: "Sam Sample", role: "OWNER" });
  const sam = await acceptPortalInvite(t2!, "Sam-Strong-Pass-12345");
  return { tabitha, pat, bakery, other, login, sam: { id: sam.id, name: sam.name, email: sam.email } };
}

/** A fictional connected bank, inserted directly (as the office's Plaid connection would leave it). */
async function connectBank(tabitha: { id: string }, clientId: string, label: string, balanceCents: number) {
  await setupLedger({ id: tabitha.id, role: "ADMIN", name: "Tabitha", email: "t@example.com" }, clientId, { basis: "CASH" });
  const checking = await prisma.ledgerAccount.findFirstOrThrow({ where: { clientId, code: "1000" } });
  const conn = await prisma.bankConnection.create({
    data: {
      clientId, itemId: `item-${clientId}`, accessTokenEnc: encryptSecret("access-sandbox-fictional"), institutionName: `${label} Bank (fictional)`,
      authorizedByName: "Fictional Owner", authorizationMethod: "CLIENT_PRESENT", consentVersion: "test", connectedById: tabitha.id,
      accounts: { create: [{ providerAccountId: "acc-chk", name: `${label} Checking`, mask: "4094", type: "depository", subtype: "checking", ledgerAccountId: checking.id }] },
    },
    include: { accounts: true },
  });
  await recordBalance(conn.accounts[0].id, clientId, { currentBalanceCents: balanceCents, availableBalanceCents: balanceCents, balanceAsOf: new Date() });
  await prisma.bankTransaction.create({ data: { clientId, accountId: checking.id, date: new Date("2026-11-02T00:00:00Z"), amountCents: -4200, description: `${label} fictional supplies`, fingerprint: `fp-${clientId}`, source: "PLAID", providerId: `p-${clientId}` } });
  return conn;
}

describe("Personal / Business Home", () => {
  it("a regular tax client's Home is unchanged: personal view, the same five tiles, no business dashboard", async () => {
    const { pat, login } = await world();
    const accounts = await accessibleClients(login.id);
    expect(accounts.every((a) => homeKind(a) === "PERSONAL")).toBe(true);
    const access = await requireClientAccess(login.id, pat.id);
    const data = await loadPortalHome(pat.id, access, login.id);
    expect(homeTiles({ data, q: `?account=${pat.id}` }).tiles.map((t) => t.title)).toEqual(["Tax Questionnaire", "Upload Documents", "Retrieve Tax Filings", "Appointments", "News & Updates"]);
    await expect(portalBusinessDashboard(login, pat.id)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("an approved Managed Business shows the business dashboard for that business only", async () => {
    const { bakery, pat, login } = await world();
    await managed(bakery.id);
    const accounts = await accessibleClients(login.id);
    expect(homeKind(accounts.find((a) => a.clientId === bakery.id)!)).toBe("BUSINESS");
    expect(homeKind(accounts.find((a) => a.clientId === pat.id)!)).toBe("PERSONAL");
    const d = await portalBusinessDashboard(login, bakery.id);
    expect(d.client.name).toBe("Lakeside Pretend Bakery LLC");
    expect(d.figures).toBeNull(); // nothing released yet
    expect(d.isReleased).toBe(false);
    expect(d.feed?.connected).toBe(false); // managed() enrolls it on the Bookkeeping Clients list, so banking is shown
    // A plain business with no payroll, cards, mortgage or contractors: only the basics are asked for
    // (never bank statements: our office retrieves those itself).
    expect(d.checklist.map((c) => c.key)).toEqual(["RECEIPTS"]);
    expect(d.checklist.every((c) => c.status === "NEEDED")).toBe(true);
    expect(d.books).toMatchObject({ openRequests: 1, questions: [], toCategorize: 0 });
  });

  it("a business not yet approved does NOT get the dashboard, even with the per-login flag on", async () => {
    const { bakery, login } = await world();
    await prisma.portalAccess.updateMany({ where: { clientId: bakery.id }, data: { canViewBookkeeping: true } });
    // Not approved yet (OFF), or approval later removed: no business Home either way.
    for (const state of ["OFF", "REMOVED"] as const) {
      await prisma.client.update({ where: { id: bakery.id }, data: { businessAccess: state } });
      const access = (await accessibleClients(login.id)).find((a) => a.clientId === bakery.id)!;
      expect(homeKind(access)).toBe("PERSONAL");
      await expect(portalBusinessDashboard(login, bakery.id)).rejects.toBeInstanceOf(ForbiddenError);
      await expect(portalBankFeed(login, bakery.id)).rejects.toBeInstanceOf(ForbiddenError);
    }
  });
});

describe("This month at a glance", () => {
  it("shows income, expenses and net only for a month whose statements were released", async () => {
    const { bakery, tabitha, login } = await world();
    await managed(bakery.id);
    const t = { id: tabitha.id, role: "ADMIN" as const, name: "Tabitha", email: "t@example.com" };
    await setupLedger(t, bakery.id, { basis: "CASH" });
    const acct = async (type: "ASSET" | "INCOME" | "EXPENSE") => (await prisma.ledgerAccount.findFirstOrThrow({ where: { clientId: bakery.id, type }, orderBy: { code: "asc" } })).id;
    const [bank, income, expense] = [await acct("ASSET"), await acct("INCOME"), await acct("EXPENSE")];
    await postJournalEntry(t, bakery.id, { date: "2026-09-10", memo: "Fictional cake sales", lines: [{ accountId: bank, debit: "5000" }, { accountId: income, credit: "5000" }] });
    await postJournalEntry(t, bakery.id, { date: "2026-09-12", memo: "Fictional flour", lines: [{ accountId: expense, debit: "1200" }, { accountId: bank, credit: "1200" }] });
    const period = await openPeriod(tabitha, bakery.id, 2026, 9);
    expect((await portalBusinessDashboard(login, bakery.id, "2026-09")).figures).toBeNull();
    const file = await prisma.storedFile.create({ data: { kind: "CLIENT_DOCUMENT", storageKey: "test/pl.pdf", originalName: "pl.pdf", title: "Fictional P&L", mimeType: "application/pdf", sizeBytes: 10 } });
    // A draft (not approved) is not a release.
    const doc = await prisma.document.create({ data: { clientId: bakery.id, category: "BOOKKEEPING", title: "Fictional P&L", visibility: "STAFF_ONLY", scanStatus: "CLEAN", reportType: "PROFIT_AND_LOSS", reviewStatus: "DRAFT", fileId: file.id, periodId: period.id } });
    expect((await portalBusinessDashboard(login, bakery.id, "2026-09")).figures).toBeNull();
    await prisma.document.update({ where: { id: doc.id }, data: { reviewStatus: "APPROVED", visibility: "PUBLISHED", publishedAt: new Date() } });
    const d = await portalBusinessDashboard(login, bakery.id, "2026-09");
    expect(d.figures).toMatchObject({ income: 500_000, expenses: 120_000, net: 380_000 });
    expect(d.statements?.docs.map((x) => x.label)).toEqual(["Profit & Loss Statement"]);
  });
});

describe("live bank feed (JSON route)", () => {
  const get = (account: string) => bankRoute(new Request(`https://portal.example.com/api/client/bank?account=${account}`));

  it("requires a portal session and access to that business", async () => {
    const { bakery, pat, tabitha, login } = await world();
    await managed(bakery.id);
    await connectBank(tabitha, bakery.id, "Lakeside", 1_250_025);
    expect((await get(bakery.id)).status).toBe(401);
    portalSession = login;
    expect((await get(pat.id)).status).toBe(403); // personal account: no business view
    expect((await get("not-a-real-client")).status).toBe(403);
    const ok = await get(bakery.id);
    expect(ok.status).toBe(200);
    expect(ok.headers.get("cache-control")).toBe("no-store");
  });

  it("never returns another client's bank data", async () => {
    const { bakery, other, tabitha, login, sam } = await world();
    await managed(bakery.id, other.id);
    await connectBank(tabitha, bakery.id, "Lakeside", 1_250_025);
    await connectBank(tabitha, other.id, "Hauling", 999_999);
    portalSession = login;
    const mine = await (await get(bakery.id)).json();
    expect(mine.accounts.map((a: { name: string }) => a.name)).toEqual(["Lakeside Checking"]);
    expect(mine.accounts[0].currentCents).toBe(1_250_025);
    expect(JSON.stringify(mine)).not.toContain("Hauling");
    expect((await get(other.id)).status).toBe(403);
    // And the other owner can't see the bakery's.
    portalSession = sam;
    expect((await get(bakery.id)).status).toBe(403);
    expect(JSON.stringify(await (await get(other.id)).json())).not.toContain("Lakeside");
  });

  it("shows today's change against the latest earlier day (one snapshot per account per day)", async () => {
    const { bakery, tabitha } = await world();
    await managed(bakery.id);
    const conn = await connectBank(tabitha, bakery.id, "Lakeside", 1_000_000);
    const acct = conn.accounts[0].id;
    const yesterday = new Date(balanceDay().getTime() - 86400000);
    await prisma.bankBalanceDaily.create({ data: { accountId: acct, clientId: bakery.id, day: yesterday, currentBalanceCents: 950_000 } });
    await recordBalance(acct, bakery.id, { currentBalanceCents: 1_010_000, availableBalanceCents: null, balanceAsOf: new Date() });
    expect(await prisma.bankBalanceDaily.count({ where: { accountId: acct } })).toBe(2);
    const feed = await bankFeed(bakery.id);
    expect(feed.accounts[0].changeCents).toBe(60_000);
    expect(feed.netCents).toBe(1_010_000);
    expect(feed.transactions[0].description).toBe("Lakeside fictional supplies");
  });
});

describe("Refresh now", () => {
  it("fetches from the bank once, then is rate-limited for 5 minutes", async () => {
    const { bakery, tabitha, login } = await world();
    await managed(bakery.id);
    await connectBank(tabitha, bakery.id, "Lakeside", 100);
    const now = new Date();
    const r = await portalRefreshBank(login, bakery.id, now);
    expect(r.failed).toBe(0);
    expect(plaidCalls).toEqual(["/transactions/sync", "/accounts/get"]);
    expect(r.feed.accounts[0].currentCents).toBe(1_250_025);
    await expect(portalRefreshBank(login, bakery.id, new Date(now.getTime() + 60_000))).rejects.toBeInstanceOf(RateLimitedError);
    expect(plaidCalls).toHaveLength(2); // no second call to the bank
    portalSession = login;
    const res = await refreshRoute(new Request("https://portal.example.com/api/client/bank/refresh", { method: "POST", headers: { "Content-Type": "application/json", origin: "https://portal.example.com" }, body: JSON.stringify({ account: bakery.id }) }));
    expect(res.status).toBe(429);
    // After five minutes it may run again.
    await portalRefreshBank(login, bakery.id, new Date(now.getTime() + 5 * 60_000 + 1000));
    expect(plaidCalls).toHaveLength(4);
  });

  it("stays behind the Plaid gate, needs access, and refuses other sites", async () => {
    const { bakery, other, tabitha, login } = await world();
    await managed(bakery.id, other.id);
    await connectBank(tabitha, bakery.id, "Lakeside", 100);
    await expect(portalRefreshBank(login, other.id)).rejects.toBeInstanceOf(ForbiddenError);
    vi.stubEnv("PLAID_ENV", "production");
    await expect(portalRefreshBank(login, bakery.id)).rejects.toThrow(/isn't turned on yet/);
    expect(plaidCalls).toHaveLength(0);
    portalSession = login;
    const res = await refreshRoute(new Request("https://portal.example.com/api/client/bank/refresh", { method: "POST", headers: { "Content-Type": "application/json", origin: "https://evil.example" }, body: JSON.stringify({ account: bakery.id }) }));
    expect(res.status).toBe(403);
    portalSession = null;
    expect((await refreshRoute(new Request("https://portal.example.com/api/client/bank/refresh", { method: "POST", body: "{}" }))).status).toBe(401);
  });
});

describe("What we need from you (conditional requests)", () => {
  const form = (o: Record<string, string>) => {
    const fd = new FormData();
    for (const [k, v] of Object.entries(o)) fd.set(k, v);
    return fd;
  };
  const yearCoverage = (docType: string, year: number) => uploadFieldsFromForm(form({ docType, periodKind: "YEAR", periodYear: String(year) })).coverage;

  it("asks only for what applies to this business, once per year, and withdraws what no longer applies", async () => {
    const { tabitha, bakery, pat, login } = await world();
    await managed(bakery.id);
    const year = checklistTaxYear();
    const keys = async (kind: "BOOKKEEPING" | "YEAR_END" = "BOOKKEEPING", y = year) => (await businessChecklist(bakery.id, y, kind)).map((c) => c.key);
    expect(await keys()).toEqual(["RECEIPTS"]);
    expect(await keys("YEAR_END", year - 1)).toEqual([]);

    // A 1098 on the owner's PERSONAL account never makes the business ask for one.
    await portalUploadDocument(login, { clientId: pat.id, docType: "FORM_1098_MORTGAGE", coverage: yearCoverage("FORM_1098_MORTGAGE", year - 2), asOf: null, bytes: PDF(), originalName: "home-1098.pdf" });
    expect(await keys("YEAR_END", year - 1)).toEqual([]);

    // Facts about the business turn on the matching requests.
    await prisma.bookkeepingProfile.update({ where: { clientId: bakery.id }, data: { payroll: true } });
    await setupLedger({ id: tabitha.id, role: "ADMIN", name: "Tabitha", email: "t@example.com" }, bakery.id, { basis: "CASH" });
    await prisma.businessLicense.create({ data: { clientId: bakery.id, name: "City license (fictional)", createdById: tabitha.id } });
    await prisma.yearEndFiling.create({ data: { clientId: bakery.id, taxYear: year - 1, stage: "CONTRACTOR_REVIEW" } });
    await portalUploadDocument(login, { clientId: bakery.id, docType: "FORM_1098_MORTGAGE", coverage: yearCoverage("FORM_1098_MORTGAGE", year - 2), asOf: null, bytes: PDF(), originalName: "biz-1098.pdf" });
    const bk = await keys();
    expect(bk).toEqual(["RECEIPTS", "PAYROLL_REPORTS", "LICENSES"]);
    // Annual forms are never bookkeeping items.
    const ye = await keys("YEAR_END", year - 1);
    expect(ye).toEqual(["W2_ISSUED", "NEC_ISSUED", "MORTGAGE_1098"]);
    expect(ye).not.toContain("K1");
    // Card statements are never asked of the client, even for a card in use (our office retrieves them).
    expect(bk).not.toContain("CARD_STATEMENTS");
    const card = await prisma.ledgerAccount.findFirstOrThrow({ where: { clientId: bakery.id, subtype: "CREDIT_CARD" } });
    await prisma.bankTransaction.create({ data: { clientId: bakery.id, accountId: card.id, date: new Date(`${year}-03-02T00:00:00Z`), amountCents: -1299, description: "Fictional supplies", fingerprint: "fp-card" } });
    expect(await keys()).not.toContain("CARD_STATEMENTS");
    // Running again never duplicates.
    const count = await prisma.documentRequest.count({ where: { clientId: bakery.id } });
    await businessChecklist(bakery.id, year, "BOOKKEEPING");
    await businessChecklist(bakery.id, year - 1, "YEAR_END");
    expect(await prisma.documentRequest.count({ where: { clientId: bakery.id } })).toBe(count);
    // Payroll ends: its untouched requests are withdrawn (the year-end W-2 request too).
    await prisma.bookkeepingProfile.update({ where: { clientId: bakery.id }, data: { payroll: false } });
    expect(await keys()).not.toContain("PAYROLL_REPORTS");
    expect(await keys("YEAR_END", year - 1)).not.toContain("W2_ISSUED");
    expect((await prisma.documentRequest.findFirstOrThrow({ where: { clientId: bakery.id, ruleKey: "PAYROLL_REPORTS" } })).status).toBe("CANCELLED");
    // Nothing on the personal account was asked for.
    expect(await prisma.documentRequest.count({ where: { clientId: pat.id } })).toBe(0);
  });

  it("Year-End Tax Documents open in January for the prior tax year, never before", async () => {
    const { bakery } = await world();
    await managed(bakery.id);
    await prisma.bookkeepingProfile.update({ where: { clientId: bakery.id }, data: { payroll: true } });
    const nov = await yearEndChecklist(bakery.id, "2026-11-04");
    expect(nov).toMatchObject({ active: false, taxYear: 2026, startsIn: "January 2027", items: [] });
    expect(await prisma.documentRequest.count({ where: { clientId: bakery.id, ruleKey: "W2_ISSUED" } })).toBe(0);
    const jan = await yearEndChecklist(bakery.id, "2027-01-05");
    expect(jan.active).toBe(true);
    expect(jan.taxYear).toBe(2026);
    expect(jan.items.map((i) => i.key)).toEqual(["W2_ISSUED"]);
    expect(jan.items[0].period).toBe("YEAR");
  });


  it("uploads from a request link to the business, tax year and request, with Needed → Uploaded → Under Review → Additional Information Required → Accepted", async () => {
    const { tabitha, bakery, login } = await world();
    await managed(bakery.id);
    const year = checklistTaxYear();
    const status = async () => (await businessChecklist(bakery.id, year)).find((c) => c.key === "RECEIPTS")!;
    const item = await status();
    expect(item.status).toBe("NEEDED");

    const f = uploadFieldsFromForm(form({ docType: item.docType!, periodKind: "MONTH", periodYear: String(year), periodMonth: "3" }));
    const doc = await portalUploadDocument(login, { clientId: bakery.id, requestId: item.id, docType: f.type, coverage: f.coverage, asOf: null, bytes: PDF(), originalName: "march.pdf" });
    expect(doc).toMatchObject({ clientId: bakery.id, requestId: item.id, year, month: 3, docType: "RECEIPTS" });
    expect(await status()).toMatchObject({ status: "UPLOADED", files: 1, months: 1 });

    await prisma.document.update({ where: { id: doc.id }, data: { needsReview: false, reviewedAt: new Date(), reviewedById: tabitha.id } });
    expect((await status()).status).toBe("UNDER_REVIEW");

    await setRequestStatus(tabitha, item.id, "OPEN"); // the office's "Need more"
    expect((await status()).status).toBe("MORE_INFO");

    await setRequestStatus(tabitha, item.id, "ACCEPTED");
    expect((await status()).status).toBe("ACCEPTED");
    // A different year is a different checklist.
    expect((await businessChecklist(bakery.id, year - 1)).every((c) => c.status === "NEEDED")).toBe(true);
  });

  it("maps request states without a new state", () => {
    expect(checklistStatus({ status: "OPEN", documents: [] })).toBe("NEEDED");
    expect(checklistStatus({ status: "OPEN", documents: [{ reviewedAt: null, needsReview: true }] })).toBe("MORE_INFO");
    expect(checklistStatus({ status: "SUBMITTED", documents: [{ reviewedAt: null, needsReview: true }] })).toBe("UPLOADED");
    expect(checklistStatus({ status: "SUBMITTED", documents: [{ reviewedAt: new Date(), needsReview: false }] })).toBe("UNDER_REVIEW");
    expect(checklistStatus({ status: "ACCEPTED", documents: [] })).toBe("ACCEPTED");
  });

  it("shows the office's own requests too, and outstanding questions", async () => {
    const { tabitha, bakery, login } = await world();
    await managed(bakery.id);
    await createDocumentRequest(tabitha, { clientId: bakery.id, title: "Loan statement for the fictional oven" });
    await prisma.conversation.create({ data: { clientId: bakery.id, subject: "What was the fictional $84.50 charge?", questionStatus: "OPEN" } });
    const d = await portalBusinessDashboard(login, bakery.id);
    const office = d.checklist.find((c) => c.fromOffice)!;
    expect(office).toMatchObject({ title: "Loan statement for the fictional oven", status: "NEEDED", docType: null });
    expect(d.books.questions.map((q) => q.subject)).toEqual(["What was the fictional $84.50 charge?"]);
    expect(d.books.openRequests).toBe(2);
  });
});
