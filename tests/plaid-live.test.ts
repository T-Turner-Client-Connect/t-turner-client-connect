import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { makeUser, managed, prisma, resetDb } from "./db";
import { ForbiddenError } from "@/lib/auth/actor";
import { createClient } from "@/lib/services/clients";
import { importBankCsv, ledgerFlags, setupLedger } from "@/lib/services/ledger";
import { setOwnerSwitch } from "@/lib/services/owner-switches";
import { completeBankLink, completeBankReauth, disconnectBank, handlePlaidWebhook, mapBankAccount, runDailyBankRetrieval, startBankLink, startBankReauth, syncConnection } from "@/lib/services/banking";
import { _clearWebhookKeyCache, currentPlaidMode, type PlaidTxn } from "@/lib/plaid";
import { runDailyCoetha } from "@/lib/services/coetha";
import { POST as plaidWebhook } from "@/app/api/webhooks/plaid/route";

// A simulated Plaid (sandbox AND production hosts). Fictional banks, accounts and transactions
// only: nothing leaves this test, and any other host fails the test.
type Page = { added?: PlaidTxn[]; modified?: PlaidTxn[]; removed?: { transaction_id: string }[]; has_more?: boolean };
let pages: Page[] = [];
let failWith: { status: number; code: string } | null = null;
let mutateOnce = false;
const calls: { host: string; path: string; body: Record<string, unknown> }[] = [];
const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
const KID = "fictional-key-1";

const tx = (id: string, account: string, amount: number, date: string, name: string): PlaidTxn => ({ transaction_id: id, account_id: account, amount, date, name, pending: false });

beforeEach(async () => {
  await resetDb();
  _clearWebhookKeyCache();
  pages = []; failWith = null; mutateOnce = false; calls.length = 0;
  process.env.PLAID_CLIENT_ID = "fictional-client-id";
  process.env.PLAID_SECRET = "fictional-production-secret";
  process.env.PLAID_ENV = "production";
  process.env.APP_URL = "https://clientconnect.example";
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
    const u = new URL(url);
    if (u.host !== "production.plaid.com" && u.host !== "sandbox.plaid.com") throw new Error(`Unexpected host: ${url}`);
    const body = JSON.parse(String(init.body));
    calls.push({ host: u.host, path: u.pathname, body });
    const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });
    const p = u.pathname;
    if (p === "/link/token/create") return json({ link_token: `link-${u.host.split(".")[0]}-fictional`, expiration: "2026-11-05T00:00:00Z" });
    if (p === "/item/public_token/exchange") return json({ access_token: `access-${u.host.split(".")[0]}-${body.public_token}`, item_id: `item-${body.public_token}` });
    if (p === "/accounts/get") return json({ accounts: [{ account_id: "acc-chk", name: "Fictional Operating", mask: "0042", type: "depository", subtype: "checking" }], item: {} });
    if (p === "/transactions/sync") {
      if (failWith) return json({ error_type: "ITEM_ERROR", error_code: failWith.code, error_message: "fictional" }, failWith.status);
      if (mutateOnce && body.cursor === "c-1") { mutateOnce = false; return json({ error_type: "TRANSACTIONS_ERROR", error_code: "TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION", error_message: "changed" }, 400); }
      const pg = pages.shift() ?? {};
      return json({ added: pg.added ?? [], modified: pg.modified ?? [], removed: pg.removed ?? [], next_cursor: `c-${String(body.cursor ?? "c-0").split("-")[1] === undefined ? 1 : Number(String(body.cursor ?? "c-0").split("-")[1]) + 1}`, has_more: !!pg.has_more });
    }
    if (p === "/item/remove") return json({ request_id: "r" });
    if (p === "/webhook_verification_key/get") return json({ key: { ...publicKey.export({ format: "jwk" }), kid: KID, alg: "ES256", use: "sig", created_at: 1, expired_at: null } });
    return json({ error_code: "NOT_FOUND" }, 404);
  }));
});
afterEach(() => {
  vi.unstubAllGlobals();
  for (const k of ["PLAID_CLIENT_ID", "PLAID_SECRET", "PLAID_ENV", "APP_URL", "ANTHROPIC_API_KEY"]) delete process.env[k];
});

async function setup() {
  const tabitha = await makeUser("ADMIN", "Tabitha");
  await prisma.ownerAccess.create({ data: { userId: tabitha.id, isPrimary: true } });
  const admin = await makeUser("ADMIN", "Second Admin");
  const daria = await makeUser("STAFF", "Daria");
  const vessel = await createClient(tabitha, { businessName: "Vessel Example LLC (fictional)", clientType: "BUSINESS", status: "ACTIVE", assignedToId: daria.id });
  const harbor = await createClient(tabitha, { businessName: "Harbor Example Co (fictional)", clientType: "BUSINESS", status: "ACTIVE", assignedToId: daria.id });
  await managed(vessel.id, harbor.id);
  for (const c of [vessel, harbor]) await setupLedger(daria, c.id, { basis: "CASH" });
  const acct = async (clientId: string, code: string) => (await prisma.ledgerAccount.findFirstOrThrow({ where: { clientId, code } })).id;
  return { tabitha, admin, daria, vessel, harbor, acct };
}
async function connect(s: Awaited<ReturnType<typeof setup>>, clientId: string, publicToken: string) {
  const conn = await completeBankLink(s.daria, clientId, { publicToken, authorizedByName: "Mario Example", authorizationMethod: "CLIENT_PRESENT", institutionName: "Fictional Bank", confirmed: true });
  await mapBankAccount(s.daria, clientId, conn.accounts[0].id, await s.acct(clientId, "1000"));
  return conn;
}

describe("the live (production) gate", () => {
  it("production is blocked without Tabitha's switch or without the keys, and allowed with both", async () => {
    const s = await setup();
    // Keys present, switch off.
    expect(await currentPlaidMode()).toBe("LIVE_BLOCKED");
    await expect(startBankLink(s.daria, s.vessel.id)).rejects.toThrow(/stay off until Tabitha turns on/);
    expect(await runDailyBankRetrieval()).toMatchObject({ skipped: "LIVE_BLOCKED" });
    // Only Tabitha flips it; staff Admins can't.
    await expect(setOwnerSwitch(s.admin, "liveBanking", true)).rejects.toBeInstanceOf(ForbiddenError);
    await setOwnerSwitch(s.tabitha, "liveBanking", true);
    expect(await prisma.auditLog.count({ where: { action: "banking.live_connections_on", actorId: s.tabitha.id } })).toBe(1);
    // Switch on, but a key missing.
    delete process.env.PLAID_SECRET;
    expect(await currentPlaidMode()).toBe("NOT_CONFIGURED");
    await expect(startBankLink(s.daria, s.vessel.id)).rejects.toThrow(/PLAID_SECRET/);
    // "development" is not a Plaid environment any more.
    process.env.PLAID_SECRET = "fictional-production-secret";
    process.env.PLAID_ENV = "development";
    await expect(startBankLink(s.daria, s.vessel.id)).rejects.toThrow(/sandbox.*production/);
    expect(calls).toHaveLength(0);
    // Both: real Link, on Plaid's production host, with this site's webhook.
    process.env.PLAID_ENV = "production";
    expect(await currentPlaidMode()).toBe("LIVE");
    expect((await startBankLink(s.daria, s.vessel.id)).link_token).toBe("link-production-fictional");
    expect(calls[0]).toMatchObject({ host: "production.plaid.com", path: "/link/token/create" });
    expect(calls[0].body).toMatchObject({ products: ["transactions"], webhook: "https://clientconnect.example/api/webhooks/plaid", user: { client_user_id: `client:${s.vessel.id}` } });
    const conn = await connect(s, s.vessel.id, "pub-1");
    expect(conn.environment).toBe("PRODUCTION");
    expect(calls.every((c) => c.host === "production.plaid.com")).toBe(true);
  });

  it("turning the switch off stops retrieval from real banks; disconnecting still revokes at the bank", async () => {
    const s = await setup();
    await setOwnerSwitch(s.tabitha, "liveBanking", true);
    const conn = await connect(s, s.vessel.id, "pub-1");
    await setOwnerSwitch(s.tabitha, "liveBanking", false);
    calls.length = 0;
    await expect(syncConnection(conn.id, "MANUAL", s.daria)).rejects.toThrow(/stay off until Tabitha/);
    expect(await runDailyBankRetrieval()).toMatchObject({ skipped: "LIVE_BLOCKED" });
    expect(calls).toHaveLength(0);
    await disconnectBank(s.tabitha, s.vessel.id, conn.id, "Client closed the account");
    expect(calls.map((c) => `${c.host}${c.path}`)).toEqual(["production.plaid.com/item/remove"]);
  });

  it("sandbox connections are never pulled with production keys (or the reverse)", async () => {
    const s = await setup();
    process.env.PLAID_ENV = "sandbox";
    const sandboxConn = await connect(s, s.harbor.id, "pub-sbx");
    expect(sandboxConn.environment).toBe("SANDBOX");
    process.env.PLAID_ENV = "production";
    await setOwnerSwitch(s.tabitha, "liveBanking", true);
    const live = await connect(s, s.vessel.id, "pub-live");
    calls.length = 0;
    expect(await runDailyBankRetrieval()).toMatchObject({ ok: 1, failed: 0, environment: "PRODUCTION" });
    const synced = calls.filter((c) => c.path === "/transactions/sync");
    expect(synced).toHaveLength(1);
    expect(synced[0].body.access_token).toBe("access-production-pub-live");
    await expect(syncConnection(sandboxConn.id, "MANUAL", s.daria)).rejects.toThrow(/sandbox mode/);
    expect(live.id).toBeTruthy();
  });
});

describe("automatic retrieval", () => {
  async function liveSetup() {
    const s = await setup();
    await setOwnerSwitch(s.tabitha, "liveBanking", true);
    return s;
  }

  it("covers every active connection of every business, isolated per client, each at least daily", async () => {
    const s = await liveSetup();
    const a = await connect(s, s.vessel.id, "pub-a");
    const b = await connect(s, s.harbor.id, "pub-b");
    pages = [{ added: [tx("va1", "acc-chk", 12.5, "2026-11-01", "VESSEL COFFEE")] }, { added: [tx("hb1", "acc-chk", 99, "2026-11-01", "HARBOR ROPE SUPPLY")] }];
    expect(await runDailyBankRetrieval()).toMatchObject({ ok: 2, failed: 0 });
    // Each business's rows land only in its own books, in the account its connection maps to.
    const rows = await prisma.bankTransaction.findMany({ select: { clientId: true, description: true, accountId: true } });
    for (const r of rows) {
      const expected = r.clientId === s.vessel.id ? await s.acct(s.vessel.id, "1000") : await s.acct(s.harbor.id, "1000");
      expect(r.accountId).toBe(expected);
    }
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((r) => r.clientId))).toEqual(new Set([s.vessel.id, s.harbor.id]));
    const conns = await prisma.bankConnection.findMany({ where: { id: { in: [a.id, b.id] } } });
    expect(conns.every((c) => c.lastSuccessAt && c.status === "ACTIVE")).toBe(true);
    expect(await prisma.bankSyncRun.count({ where: { trigger: "DAILY", status: "OK" } })).toBe(2);
    expect(await runDailyBankRetrieval()).toMatchObject({ ok: 0 }); // already pulled today
  });

  it("dedupes by Plaid transaction_id and against statement (CSV) rows; restarts when Plaid's data changes mid-way", async () => {
    const s = await liveSetup();
    const conn = await connect(s, s.vessel.id, "pub-a");
    const checking = await s.acct(s.vessel.id, "1000");
    // A statement was imported first (CSV backup).
    await importBankCsv(s.daria, s.vessel.id, checking, { fileName: "oct.csv", text: "Date,Description,Amount\n10/30/2026,POS SHIPWRIGHT SUPPLY,-420.00" });
    pages = [{ added: [tx("t1", "acc-chk", 420, "2026-10-30", "SHIPWRIGHT SUPPLY"), tx("t2", "acc-chk", 15, "2026-10-31", "HARBOR PARKING")] }];
    expect(await syncConnection(conn.id, "DAILY")).toMatchObject({ added: 1, matched: 1 });
    // The same transaction ids again (a retry or an overlapping page): nothing new.
    pages = [{ added: [tx("t1", "acc-chk", 420, "2026-10-30", "SHIPWRIGHT SUPPLY"), tx("t2", "acc-chk", 15, "2026-10-31", "HARBOR PARKING")] }];
    expect(await syncConnection(conn.id, "DAILY")).toMatchObject({ added: 0, skipped: 2 });
    expect(await prisma.bankTransaction.count({ where: { accountId: checking } })).toBe(2);
    expect(await prisma.bankTransaction.count({ where: { accountId: checking, providerId: "t1" } })).toBe(1);
    // Mutation during pagination: the batch restarts from the saved cursor, nothing is doubled.
    await prisma.bankConnection.update({ where: { id: conn.id }, data: { cursor: "c-0" } });
    // Page 1 (from c-0), then Plaid reports a change on page 2 (from c-1): the whole batch is fetched again from c-0.
    pages = [{ added: [tx("t3", "acc-chk", 5, "2026-11-01", "TOLL")], has_more: true }, { added: [tx("t3", "acc-chk", 5, "2026-11-01", "TOLL")], has_more: true }, { added: [tx("t4", "acc-chk", 6, "2026-11-02", "TOLL 2")] }];
    mutateOnce = true;
    const r = await syncConnection(conn.id, "DAILY");
    expect(r.added).toBe(2);
    expect(mutateOnce).toBe(false);
    expect((await prisma.bankConnection.findUniqueOrThrow({ where: { id: conn.id } })).cursor).toBe("c-2");
    expect(await prisma.bankTransaction.count({ where: { accountId: checking, providerId: { in: ["t3", "t4"] } } })).toBe(2);
  });

  it("flags item errors for re-authentication with a clear staff alert, and recovers after the client signs in", async () => {
    const s = await liveSetup();
    const conn = await connect(s, s.vessel.id, "pub-a");
    failWith = { status: 400, code: "ITEM_LOGIN_REQUIRED" };
    expect(await runDailyBankRetrieval()).toMatchObject({ ok: 0, failed: 1 });
    const c = await prisma.bankConnection.findUniqueOrThrow({ where: { id: conn.id } });
    expect(c).toMatchObject({ status: "NEEDS_REAUTH", errorCode: "ITEM_LOGIN_REQUIRED" });
    expect(c.reauthRequiredAt).not.toBeNull();
    const task = await prisma.task.findFirstOrThrow({ where: { clientId: s.vessel.id, title: "Bank connection needs the client to sign in again" } });
    expect(task).toMatchObject({ priority: "HIGH", assigneeId: s.daria.id, status: "OPEN" });
    expect(task.details).toMatch(/sign in to the bank again \(ITEM_LOGIN_REQUIRED\)/);
    expect((await ledgerFlags(s.daria, s.vessel.id)).some((f) => f.kind === "BANK_CONNECTION" && /sign in to the bank again/.test(f.message))).toBe(true);
    expect(await prisma.auditLog.count({ where: { action: "banking.needs_reauth", entityId: conn.id } })).toBe(1);
    // The daily run skips it (it would only fail again) but keeps it flagged.
    calls.length = 0;
    expect(await runDailyBankRetrieval(new Date(Date.now() + 25 * 3600_000))).toMatchObject({ ok: 0, failed: 0 });
    expect(calls.filter((x) => x.path === "/transactions/sync")).toHaveLength(0);
    // A non-item error is retried next time, not sent to re-authentication.
    // Re-authentication: Link opens in update mode with the existing item.
    failWith = null;
    await startBankReauth(s.daria, s.vessel.id, conn.id);
    const link = calls.find((x) => x.path === "/link/token/create")!;
    expect(link.body.access_token).toBe("access-production-pub-a");
    expect(link.body.products).toBeUndefined();
    await completeBankReauth(s.daria, s.vessel.id, conn.id);
    expect(await prisma.bankConnection.findUniqueOrThrow({ where: { id: conn.id } })).toMatchObject({ status: "ACTIVE", errorCode: null, reauthRequiredAt: null });
    expect((await prisma.task.findUniqueOrThrow({ where: { id: task.id } })).status).toBe("DONE");
    expect(await runDailyBankRetrieval(new Date(Date.now() + 25 * 3600_000))).toMatchObject({ ok: 1 });
  });

  it("other failures are marked and retried on the next run", async () => {
    const s = await liveSetup();
    const conn = await connect(s, s.vessel.id, "pub-a");
    failWith = { status: 500, code: "INTERNAL_SERVER_ERROR" };
    await expect(syncConnection(conn.id, "DAILY")).rejects.toThrow(/Bank retrieval failed/);
    expect(await prisma.bankConnection.findUniqueOrThrow({ where: { id: conn.id } })).toMatchObject({ status: "ERROR", errorCode: "INTERNAL_SERVER_ERROR" });
    failWith = null;
    expect(await runDailyBankRetrieval()).toMatchObject({ ok: 1 });
    expect(await prisma.bankConnection.findUniqueOrThrow({ where: { id: conn.id } })).toMatchObject({ status: "ACTIVE", errorCode: null });
  });
});

describe("Plaid webhooks", () => {
  const b64 = (b: Buffer | string) => Buffer.from(b).toString("base64url");
  function signed(body: string, opts: { iat?: number; kid?: string; sha?: string } = {}) {
    const head = b64(JSON.stringify({ alg: "ES256", kid: opts.kid ?? KID, typ: "JWT" }));
    const claims = b64(JSON.stringify({ iat: opts.iat ?? Math.floor(Date.now() / 1000), request_body_sha256: opts.sha ?? createHash("sha256").update(body).digest("hex") }));
    const sig = sign("sha256", Buffer.from(`${head}.${claims}`), { key: privateKey, dsaEncoding: "ieee-p1363" });
    return `${head}.${claims}.${b64(sig)}`;
  }
  const post = (body: string, jwt?: string) => plaidWebhook(new Request("https://clientconnect.example/api/webhooks/plaid", { method: "POST", body, headers: { "content-type": "application/json", ...(jwt ? { "plaid-verification": jwt } : {}) } }));

  it("verifies Plaid's signature; SYNC_UPDATES_AVAILABLE retrieves now; anything unsigned or altered is refused", async () => {
    const s = await setup();
    await setOwnerSwitch(s.tabitha, "liveBanking", true);
    const conn = await connect(s, s.vessel.id, "pub-a");
    const body = JSON.stringify({ webhook_type: "TRANSACTIONS", webhook_code: "SYNC_UPDATES_AVAILABLE", item_id: conn.itemId });
    pages = [{ added: [tx("w1", "acc-chk", 30, "2026-11-03", "WEBHOOK FUEL")] }];
    expect((await post(body)).status).toBe(401);
    expect((await post(body, signed(body.replace("SYNC", "SINK")))).status).toBe(401); // signature for a different body
    expect((await post(body.replace("}", ' }'), signed(body))).status).toBe(401); // body altered after signing
    expect((await post(body, signed(body, { iat: Math.floor(Date.now() / 1000) - 600 }))).status).toBe(401); // too old
    expect(await prisma.bankTransaction.count()).toBe(0);
    const ok = await post(body, signed(body));
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ result: "synced" });
    expect(await prisma.bankTransaction.count({ where: { providerId: "w1" } })).toBe(1);
    expect(await prisma.bankSyncRun.count({ where: { trigger: "WEBHOOK", status: "OK" } })).toBe(1);
    // The same webhook delivered twice adds nothing.
    pages = [{ added: [tx("w1", "acc-chk", 30, "2026-11-03", "WEBHOOK FUEL")] }];
    await post(body, signed(body));
    expect(await prisma.bankTransaction.count({ where: { providerId: "w1" } })).toBe(1);
  });

  it("ITEM errors flag the connection at once; LOGIN_REPAIRED clears it; unknown items are ignored", async () => {
    const s = await setup();
    await setOwnerSwitch(s.tabitha, "liveBanking", true);
    const conn = await connect(s, s.vessel.id, "pub-a");
    expect(await handlePlaidWebhook({ webhook_type: "ITEM", webhook_code: "ERROR", item_id: conn.itemId, error: { error_code: "ITEM_LOGIN_REQUIRED", error_message: "fictional" } })).toBe("flagged: ITEM_LOGIN_REQUIRED");
    expect((await prisma.bankConnection.findUniqueOrThrow({ where: { id: conn.id } })).status).toBe("NEEDS_REAUTH");
    expect(await handlePlaidWebhook({ webhook_type: "TRANSACTIONS", webhook_code: "SYNC_UPDATES_AVAILABLE", item_id: conn.itemId })).toBe("skipped: needs sign-in");
    expect(await handlePlaidWebhook({ webhook_type: "ITEM", webhook_code: "LOGIN_REPAIRED", item_id: conn.itemId })).toBe("repaired");
    expect(await prisma.bankConnection.findUniqueOrThrow({ where: { id: conn.id } })).toMatchObject({ status: "ACTIVE", errorCode: null });
    expect(await handlePlaidWebhook({ webhook_type: "ITEM", webhook_code: "PENDING_EXPIRATION", item_id: conn.itemId })).toBe("flagged: PENDING_EXPIRATION");
    expect(await handlePlaidWebhook({ webhook_type: "ITEM", webhook_code: "ERROR", item_id: "item-someone-else" })).toBe("ignored: unknown item");
  });
});

describe("Coetha after retrieval (optional daily run)", () => {
  it("runs only when Coetha is on and a key is set, for businesses with newly retrieved rows", async () => {
    const s = await setup();
    await setOwnerSwitch(s.tabitha, "liveBanking", true);
    const conn = await connect(s, s.vessel.id, "pub-a");
    pages = [{ added: [tx("n1", "acc-chk", 30, "2026-11-03", "FUEL DOCK")] }];
    await syncConnection(conn.id, "DAILY");
    expect(await runDailyCoetha()).toMatchObject({ ran: 0, skipped: "switched off" });
    await setOwnerSwitch(s.tabitha, "coetha", true);
    expect(await runDailyCoetha()).toMatchObject({ ran: 0, skipped: "no API key" });
  });
});
