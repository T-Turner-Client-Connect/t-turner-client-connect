import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeUser, prisma, resetDb } from "./db";
import { ForbiddenError } from "@/lib/auth/actor";
import { createClient } from "@/lib/services/clients";
import { decryptSecret } from "@/lib/crypto";
import { categorizeBankTransaction, clearBankFlag, importBankCsv, ledgerFlags, setupLedger } from "@/lib/services/ledger";
import { suggestCategories } from "@/lib/services/ledger-review";
import { completeBankLink, disconnectBank, mapBankAccount, retrieveNow, runDailyBankRetrieval, startBankLink, syncConnection } from "@/lib/services/banking";
import { plaidMode, type PlaidTxn } from "@/lib/plaid";

// A simulated Plaid sandbox. Fictional institutions, accounts and transactions only — nothing leaves this test.
type Page = { added?: PlaidTxn[]; modified?: PlaidTxn[]; removed?: { transaction_id: string }[] };
let pages: Page[] = [];
let failWith: { status: number; code: string } | null = null;
let failOnPage: number | null = null;
let syncCalls = 0;
const calls: string[] = [];

const ACCESS = "access-sandbox-fictional-0001";
const tx = (id: string, account: string, amount: number, date: string, name: string, pending = false): PlaidTxn => ({ transaction_id: id, account_id: account, amount, date, name, pending });

beforeEach(async () => {
  await resetDb();
  pages = []; failWith = null; failOnPage = null; syncCalls = 0; calls.length = 0;
  process.env.PLAID_CLIENT_ID = "fictional-client-id";
  process.env.PLAID_SECRET = "fictional-sandbox-secret";
  process.env.PLAID_ENV = "sandbox";
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
    const path = new URL(url).pathname;
    calls.push(path);
    if (!String(url).startsWith("https://sandbox.plaid.com/")) throw new Error(`Unexpected host: ${url}`);
    const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });
    const body = JSON.parse(String(init.body));
    if (path === "/link/token/create") return json({ link_token: "link-sandbox-fictional", expiration: "2026-11-04T00:00:00Z" });
    if (path === "/item/public_token/exchange") return json({ access_token: ACCESS, item_id: `item-${body.public_token}` });
    if (path === "/accounts/get") return json({ accounts: [{ account_id: "acc-chk", name: "Fictional Checking", mask: "4094", type: "depository", subtype: "checking" }, { account_id: "acc-card", name: "Fictional Card", mask: "1111", type: "credit", subtype: "credit card" }, { account_id: "acc-sav", name: "Fictional Savings", mask: "2222", type: "depository", subtype: "savings" }], item: {} });
    if (path === "/transactions/sync") {
      if (failWith) return json({ error_code: failWith.code, error_message: "fictional failure" }, failWith.status);
      const i = syncCalls++;
      if (failOnPage === i) return json({ error_code: "INTERNAL_SERVER_ERROR", error_message: "boom" }, 500);
      const p = pages.shift() ?? {};
      return json({ added: p.added ?? [], modified: p.modified ?? [], removed: p.removed ?? [], next_cursor: `cursor-${i + 1}`, has_more: pages.length > 0 && !!pages[0] && failOnPage !== null });
    }
    if (path === "/item/remove") return json({ request_id: "r1" });
    return json({ error_code: "NOT_FOUND" }, 404);
  }));
});
afterEach(() => {
  vi.unstubAllGlobals();
  for (const k of ["PLAID_CLIENT_ID", "PLAID_SECRET", "PLAID_ENV"]) delete process.env[k];
});

async function setup() {
  const tabitha = await makeUser("ADMIN", "Tabitha");
  await prisma.ownerAccess.create({ data: { userId: tabitha.id, isPrimary: true } });
  const daria = await makeUser("STAFF", "Daria");
  const stranger = await makeUser("STAFF", "Stranger");
  const vessel = await createClient(tabitha, { businessName: "Vessel Example LLC (fictional)", clientType: "BUSINESS", status: "ACTIVE", assignedToId: daria.id });
  await setupLedger(daria, vessel.id, { basis: "CASH" });
  const acct = async (code: string) => (await prisma.ledgerAccount.findFirstOrThrow({ where: { clientId: vessel.id, code } })).id;
  const [checking, card] = [await acct("1000"), await acct("2100")];
  return { tabitha, daria, stranger, vessel, acct, checking, card };
}
async function connect(s: Awaited<ReturnType<typeof setup>>, publicToken = "public-sandbox-1") {
  const conn = await completeBankLink(s.daria, s.vessel.id, { publicToken, authorizedByName: "Mario Example", authorizationMethod: "CLIENT_PRESENT", institutionName: "Fictional Bank", confirmed: true });
  const ca = (pid: string) => conn.accounts.find((a) => a.providerAccountId === pid)!.id;
  await mapBankAccount(s.daria, s.vessel.id, ca("acc-chk"), s.checking);
  await mapBankAccount(s.daria, s.vessel.id, ca("acc-card"), s.card);
  return conn;
}
const CSV = (rows: string[]) => ["Date,Description,Amount", ...rows].join("\n");

describe("connecting (sandbox only, read-only, authorization recorded)", () => {
  it("refuses anything but the sandbox, and needs credentials", async () => {
    const s = await setup();
    expect(plaidMode({ PLAID_CLIENT_ID: "x", PLAID_SECRET: "y", PLAID_ENV: "production" })).toBe("LIVE_BLOCKED");
    expect(plaidMode({ PLAID_CLIENT_ID: "x", PLAID_SECRET: "y", PLAID_ENV: "development" })).toBe("LIVE_BLOCKED");
    expect(plaidMode({})).toBe("NOT_CONFIGURED");
    process.env.PLAID_ENV = "production";
    await expect(startBankLink(s.daria, s.vessel.id)).rejects.toThrow(/turned off until Tabitha approves/);
    expect(calls).toEqual([]);
    process.env.PLAID_ENV = "sandbox";
    expect((await startBankLink(s.daria, s.vessel.id)).link_token).toBe("link-sandbox-fictional");
    await expect(startBankLink(s.stranger, s.vessel.id)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("records who authorized and how, stores the token encrypted, and never connects the same login twice", async () => {
    const s = await setup();
    await expect(completeBankLink(s.daria, s.vessel.id, { publicToken: "p", authorizedByName: "Mario Example", authorizationMethod: "CLIENT_PRESENT", confirmed: false })).rejects.toThrow(/Confirm/);
    const conn = await connect(s);
    expect(conn).toMatchObject({ environment: "SANDBOX", authorizedByName: "Mario Example", authorizationMethod: "CLIENT_PRESENT", consentVersion: expect.stringMatching(/read-only/) });
    expect(conn.accessTokenEnc).not.toContain(ACCESS);
    expect(decryptSecret(conn.accessTokenEnc)).toBe(ACCESS);
    expect(conn.accounts).toHaveLength(3);
    await expect(completeBankLink(s.daria, s.vessel.id, { publicToken: "public-sandbox-1", authorizedByName: "Mario Example", authorizationMethod: "CLIENT_PRESENT", confirmed: true })).rejects.toThrow(/already connected/);
    // The database refuses anything but a sandbox connection.
    await expect(prisma.bankConnection.update({ where: { id: conn.id }, data: { environment: "PRODUCTION" } })).rejects.toThrow();
    // One bank account feeds one ledger account; only this client's bank/card accounts.
    const sav = conn.accounts.find((a) => a.providerAccountId === "acc-sav")!.id;
    await expect(mapBankAccount(s.daria, s.vessel.id, sav, s.checking)).rejects.toThrow(/already receives/);
    await expect(mapBankAccount(s.daria, s.vessel.id, sav, await s.acct("4000"))).rejects.toThrow(/bank or credit card/);
  });
});

describe("daily retrieval", () => {
  it("adds posted transactions once, skips pending and unmapped ones, saves the cursor, and never posts anything", async () => {
    const s = await setup();
    const conn = await connect(s);
    pages = [{ added: [tx("t1", "acc-chk", 38.5, "2026-10-02", "CLOVER SOFTWARE"), tx("t2", "acc-chk", -7887.57, "2026-10-15", "MERCHANT DEPOSIT"), tx("t3", "acc-chk", 12, "2026-10-20", "PENDING COFFEE", true), tx("t4", "acc-sav", -5, "2026-10-21", "INTEREST")] }];
    const r = await syncConnection(conn.id, "MANUAL", s.daria);
    expect(r).toMatchObject({ added: 2, skipped: 2 });
    const rows = await prisma.bankTransaction.findMany({ where: { accountId: s.checking }, orderBy: { date: "asc" } });
    expect(rows.map((x) => [x.description, x.amountCents, x.source, x.status])).toEqual([["CLOVER SOFTWARE", -3850, "PLAID", "UNREVIEWED"], ["MERCHANT DEPOSIT", 788757, "PLAID", "UNREVIEWED"]]);
    const after = await prisma.bankConnection.findUniqueOrThrow({ where: { id: conn.id } });
    expect(after.cursor).toBe("cursor-1");
    expect(after.lastSuccessAt).not.toBeNull();
    expect(await prisma.journalEntry.count()).toBe(0);
    // The same transaction sent again is never added twice.
    pages = [{ added: [tx("t1", "acc-chk", 38.5, "2026-10-02", "CLOVER SOFTWARE")] }];
    expect((await syncConnection(conn.id, "DAILY")).added).toBe(0);
    expect(await prisma.bankTransaction.count({ where: { accountId: s.checking } })).toBe(2);
    expect(await prisma.bankSyncRun.count({ where: { connectionId: conn.id, status: "OK" } })).toBe(2);
  });

  it("no duplicates across sources: statement first, then daily — and daily first, then statement", async () => {
    const s = await setup();
    const conn = await connect(s);
    // Statement imported first; the bank's description and date differ slightly.
    await importBankCsv(s.daria, s.vessel.id, s.checking, { fileName: "oct.csv", text: CSV(["10/02/2026,POS CLOVER SOFTWARE 123,-38.50"]) });
    pages = [{ added: [tx("t1", "acc-chk", 38.5, "2026-10-03", "CLOVER SOFTWARE")] }];
    expect(await syncConnection(conn.id, "DAILY")).toMatchObject({ added: 0, matched: 1 });
    expect(await prisma.bankTransaction.count({ where: { accountId: s.checking } })).toBe(1);
    expect((await prisma.bankTransaction.findFirstOrThrow({ where: { accountId: s.checking } })).providerId).toBe("t1");
    // Daily first; then the statement arrives (twice).
    pages = [{ added: [tx("t2", "acc-chk", 8.1, "2026-10-31", "SERVICE CHARGE")] }];
    await syncConnection(conn.id, "DAILY");
    const imp = await importBankCsv(s.daria, s.vessel.id, s.checking, { fileName: "oct-end.csv", text: CSV(["10/31/2026,PNC SERVICE CHARGE,-8.10"]) });
    expect([imp.added, imp.matched]).toEqual([0, 1]);
    const again = await importBankCsv(s.daria, s.vessel.id, s.checking, { fileName: "oct-end.csv", text: CSV(["10/31/2026,PNC SERVICE CHARGE,-8.10"]) });
    expect([again.added, again.duplicates]).toEqual([0, 1]);
    expect(await prisma.bankTransaction.count({ where: { accountId: s.checking } })).toBe(2);
  });

  it("identical same-day rows link one for one; a genuinely unclear match is flagged, never merged", async () => {
    const s = await setup();
    const conn = await connect(s);
    await importBankCsv(s.daria, s.vessel.id, s.checking, { fileName: "a.csv", text: CSV(["10/03/2026,Monthly fee,-38.50", "10/03/2026,Monthly fee,-38.50", "10/05/2026,Deposit A,100", "10/07/2026,Deposit B,100"]) });
    pages = [{ added: [tx("f1", "acc-chk", 38.5, "2026-10-03", "MONTHLY FEE"), tx("f2", "acc-chk", 38.5, "2026-10-03", "MONTHLY FEE"), tx("d1", "acc-chk", -100, "2026-10-06", "MOBILE DEPOSIT")] }];
    const r = await syncConnection(conn.id, "DAILY");
    expect(r).toMatchObject({ matched: 2, added: 1, flagged: 1 });
    const flagged = await prisma.bankTransaction.findFirstOrThrow({ where: { providerId: "d1" } });
    expect(flagged).toMatchObject({ flag: "POSSIBLE_DUPLICATE", status: "UNREVIEWED" });
    expect((await ledgerFlags(s.daria, s.vessel.id)).map((f) => f.kind)).toContain("BANK_ROW_FLAGGED");
    // A person decides: excluding it as a duplicate clears the flag.
    const { excludeBankTransaction } = await import("@/lib/services/ledger");
    await excludeBankTransaction(s.daria, s.vessel.id, flagged.id, "Duplicate of the statement row for Deposit A");
    expect((await prisma.bankTransaction.findUniqueOrThrow({ where: { id: flagged.id } })).flag).toBeNull();
  });

  it("bank changes after posting are flagged for staff — the books are never changed automatically", async () => {
    const s = await setup();
    const conn = await connect(s);
    pages = [{ added: [tx("t1", "acc-chk", 50, "2026-10-02", "OFFICE DEPOT"), tx("t2", "acc-chk", 20, "2026-10-03", "UNKNOWN VENDOR")] }];
    await syncConnection(conn.id, "DAILY");
    const t1 = await prisma.bankTransaction.findFirstOrThrow({ where: { providerId: "t1" } });
    await categorizeBankTransaction(s.daria, s.vessel.id, t1.id, { accountId: await s.acct("6300") });
    pages = [{ modified: [tx("t1", "acc-chk", 55, "2026-10-02", "OFFICE DEPOT"), tx("t2", "acc-chk", 25, "2026-10-03", "UNKNOWN VENDOR")], removed: [] }];
    await syncConnection(conn.id, "DAILY");
    expect(await prisma.bankTransaction.findFirstOrThrow({ where: { providerId: "t1" } })).toMatchObject({ amountCents: -5000, flag: "CHANGED_AFTER_POSTING" });
    expect((await prisma.bankTransaction.findFirstOrThrow({ where: { providerId: "t2" } })).amountCents).toBe(-2500); // not yet reviewed: updated
    pages = [{ removed: [{ transaction_id: "t1" }, { transaction_id: "t2" }] }];
    await syncConnection(conn.id, "DAILY");
    expect(await prisma.bankTransaction.findFirstOrThrow({ where: { providerId: "t1" } })).toMatchObject({ status: "POSTED", flag: "REMOVED_AFTER_POSTING" });
    expect(await prisma.bankTransaction.findFirstOrThrow({ where: { providerId: "t2" } })).toMatchObject({ status: "EXCLUDED", excludedReason: "Removed by the bank" });
    expect(await prisma.journalEntry.count()).toBe(1); // only the one a person posted
    await expect(clearBankFlag(s.daria, s.vessel.id, t1.id, "ok")).rejects.toThrow(/Note what you checked/);
    await clearBankFlag(s.daria, s.vessel.id, t1.id, "Confirmed with client: receipt shows $50.00");
    expect((await prisma.auditLog.findFirstOrThrow({ where: { action: "ledger.bank_flag_cleared" } })).actorId).toBe(s.daria.id);
  });

  it("suggests transfers between the client's own accounts and known categories; leaves unknowns for staff", async () => {
    const s = await setup();
    const conn = await connect(s);
    pages = [{ added: [tx("x1", "acc-chk", 300, "2026-10-10", "PAYMENT TO CARD"), tx("x2", "acc-card", -300, "2026-10-11", "PAYMENT THANK YOU"), tx("x3", "acc-chk", 45, "2026-10-12", "MYSTERY LLC")] }];
    await syncConnection(conn.id, "DAILY");
    const sg = await suggestCategories(s.daria, s.vessel.id);
    const id = async (p: string) => (await prisma.bankTransaction.findFirstOrThrow({ where: { providerId: p } })).id;
    expect(sg.get(await id("x1"))).toMatchObject({ accountId: s.card, source: "TRANSFER" });
    expect(sg.get(await id("x2"))).toMatchObject({ accountId: s.checking, source: "TRANSFER" });
    expect(sg.has(await id("x3"))).toBe(false);
    // Posting the transfer once settles both rows.
    await categorizeBankTransaction(s.daria, s.vessel.id, await id("x1"), { accountId: s.card });
    expect((await prisma.bankTransaction.findUniqueOrThrow({ where: { id: await id("x2") } })).status).toBe("POSTED");
  });

  it("tells the assigned staff member with one task (updated, not repeated)", async () => {
    const s = await setup();
    const conn = await connect(s);
    pages = [{ added: [tx("a1", "acc-chk", 10, "2026-10-02", "A")] }];
    await syncConnection(conn.id, "DAILY");
    pages = [{ added: [tx("a2", "acc-chk", 11, "2026-10-03", "B")] }];
    await syncConnection(conn.id, "DAILY");
    const tasks = await prisma.task.findMany({ where: { clientId: s.vessel.id } });
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({ assigneeId: s.daria.id, title: "Bank transactions need review", details: expect.stringMatching(/2 transactions to review/) });
  });

  it("a failure stores nothing, keeps the cursor, marks the connection and alerts staff; sign-in problems ask for re-authorization", async () => {
    const s = await setup();
    const conn = await connect(s);
    pages = [{ added: [tx("ok1", "acc-chk", 10, "2026-10-02", "A")] }];
    await syncConnection(conn.id, "DAILY");
    failWith = { status: 400, code: "ITEM_LOGIN_REQUIRED" };
    await expect(syncConnection(conn.id, "DAILY")).rejects.toThrow(/Bank retrieval failed/);
    const c = await prisma.bankConnection.findUniqueOrThrow({ where: { id: conn.id } });
    expect(c).toMatchObject({ status: "NEEDS_REAUTH", cursor: "cursor-1" });
    expect((await prisma.task.findFirstOrThrow({ where: { clientId: s.vessel.id } })).priority).toBe("HIGH");
    expect((await ledgerFlags(s.daria, s.vessel.id)).find((f) => f.kind === "BANK_CONNECTION")!.message).toMatch(/sign in to the bank again/);
    expect(await prisma.bankSyncRun.count({ where: { status: "FAILED", errorCode: "ITEM_LOGIN_REQUIRED" } })).toBe(1);
  });

  it("the daily run retrieves only connections that are due, never overlaps, and stays off outside the sandbox", async () => {
    const s = await setup();
    const conn = await connect(s);
    expect(await runDailyBankRetrieval()).toMatchObject({ ok: 1, failed: 0 });
    expect(await runDailyBankRetrieval()).toMatchObject({ ok: 0 }); // just retrieved: not due again yet
    expect(await runDailyBankRetrieval(new Date(Date.now() + 21 * 3600_000))).toMatchObject({ ok: 1 });
    await prisma.jobLock.update({ where: { name: "bank-retrieval" }, data: { lockedUntil: new Date(Date.now() + 10 * 60_000 + 30 * 3600_000) } });
    expect(await runDailyBankRetrieval(new Date(Date.now() + 30 * 3600_000))).toMatchObject({ skipped: "another run is in progress" });
    process.env.PLAID_ENV = "production";
    expect(await runDailyBankRetrieval()).toMatchObject({ skipped: "LIVE_BLOCKED" });
    expect(conn.id).toBeTruthy();
  });

  it("Retrieve now is limited to people who can open the client's books; only an Admin disconnects (token wiped)", async () => {
    const s = await setup();
    const conn = await connect(s);
    await expect(retrieveNow(s.stranger, s.vessel.id)).rejects.toBeInstanceOf(ForbiddenError);
    pages = [{ added: [tx("m1", "acc-chk", 10, "2026-10-02", "A")] }];
    expect((await retrieveNow(s.daria, s.vessel.id)).added).toBe(1);
    await expect(disconnectBank(s.daria, s.vessel.id, conn.id, "Client closed the account")).rejects.toBeInstanceOf(ForbiddenError);
    await disconnectBank(s.tabitha, s.vessel.id, conn.id, "Client closed the account");
    expect(await prisma.bankConnection.findUniqueOrThrow({ where: { id: conn.id } })).toMatchObject({ status: "DISCONNECTED", accessTokenEnc: "", cursor: null });
    expect(calls).toContain("/item/remove");
    expect(await prisma.bankTransaction.count({ where: { providerId: "m1" } })).toBe(1); // history stays
    await expect(retrieveNow(s.daria, s.vessel.id)).rejects.toThrow(/No bank connection/);
  });
});
