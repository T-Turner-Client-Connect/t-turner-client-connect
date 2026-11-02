import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeUser, prisma, resetDb } from "./db";
import { createClient } from "@/lib/services/clients";
import { saveProfile } from "@/lib/services/bookkeeping-clients";
import { squareSettings } from "@/lib/square";
import { runSquareHealthCheck, squareHealth } from "@/lib/services/square-health";
import {
  balanceOf, linkSquareBilling, lookupSquareBilling, paymentStatus, squareRevenueSummary, staleness, suggestSquareMatches, syncStaleSquareBilling, type SqInvoice,
} from "@/lib/services/square-billing";

// Fictional customer and recurring series shaped like the real case: the series number (54458-style) is not the customer ID.
const ZOE = { id: "ZOEFICT0000CUSTOMER00001", given_name: "Zoe", family_name: "Example", company_name: "Oasis Example LLC (fictional)", email_address: "zoe@fictional.example", phone_number: "+14195550100" };
const inv = (n: string, due: string, status: string, amount = 79500, paid = 0, customer = ZOE.id): SqInvoice => ({
  id: `inv:${n}`, invoice_number: n, title: "Monthly Bookkeeping", status, location_id: "LOC1", primary_recipient: { customer_id: customer },
  payment_requests: [{ request_type: "BALANCE", due_date: due, automatic_payment_source: "CARD_ON_FILE", card_id: "ccof:FICT", computed_amount_money: { amount }, total_completed_amount_money: { amount: paid } }],
});
const TODAY = new Date().toLocaleDateString("en-CA", { timeZone: "America/Chicago" });
const shift = (days: number) => new Date(new Date(`${TODAY}T12:00:00Z`).getTime() + days * 86_400_000).toISOString().slice(0, 10);
let INVOICES: SqInvoice[] = [];

let calls: { host: string; method: string; path: string; auth: string }[] = [];
type Mode = { tokenEnv?: "production" | "sandbox"; failAll?: number };
function mockSquare(mode: Mode = {}) {
  calls = [];
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    const u = new URL(url);
    const path = decodeURIComponent(u.pathname);
    const method = init.method ?? "GET";
    const auth = String((init.headers as Record<string, string>).Authorization);
    calls.push({ host: u.host, method, path, auth });
    const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });
    if (mode.failAll) return json({ errors: [{ code: "SERVICE_UNAVAILABLE", detail: "Down for a test." }] }, mode.failAll);
    // A token only works on the environment it belongs to.
    const hostEnv = u.host === "connect.squareup.com" ? "production" : u.host === "connect.squareupsandbox.com" ? "sandbox" : "mock";
    if (mode.tokenEnv && hostEnv !== "mock" && hostEnv !== mode.tokenEnv) return json({ errors: [{ category: "AUTHENTICATION_ERROR", code: "UNAUTHORIZED", detail: "This request could not be authorized." }] }, 401);
    if (path === "/v2/locations/LOC1") return json({ location: { id: "LOC1", name: "Main (fictional)", business_name: "Fictional Office", status: "ACTIVE" } });
    if (path === "/v2/locations") return json({ locations: [{ id: "LOC1", name: "Main (fictional)", status: "ACTIVE" }] });
    if (path === "/v2/customers" && method === "GET") return json({ customers: [ZOE] });
    if (path === `/v2/customers/${ZOE.id}`) return json({ customer: ZOE });
    if (path === "/v2/customers/search") return json({ customers: [ZOE] });
    if (path === "/v2/invoices/search") return json({ invoices: INVOICES });
    if (path === "/v2/cards" || path === "/v2/cards/ccof:FICT") return json(path === "/v2/cards" ? { cards: [] } : { card: { id: "ccof:FICT", card_brand: "MASTERCARD", last_4: "0000", exp_month: 1, exp_year: 2030 } });
    return json({ errors: [{ code: "NOT_FOUND", detail: "Not found." }] }, 404);
  });
}
const env = (vars: Record<string, string>) => {
  for (const [k, v] of Object.entries({ SQUARE_ACCESS_TOKEN: "fictional-token", SQUARE_LOCATION_ID: "LOC1", SQUARE_APPLICATION_ID: "sq0idp-fictional", ...vars })) vi.stubEnv(k, v);
};
const writes = () => calls.filter((c) => c.method === "POST" && !c.path.endsWith("/search"));

beforeEach(async () => {
  await resetDb();
  INVOICES = [inv("54458-R-0001", shift(-60), "PAID", 79500, 79500), inv("54458-R-0002", shift(-30), "PAID", 79500, 79500), inv("54458-R-0003", shift(1), "SCHEDULED")];
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

async function owner() {
  const tabitha = await makeUser("ADMIN", "Tabitha");
  await prisma.ownerAccess.create({ data: { userId: tabitha.id, isPrimary: true } });
  return tabitha;
}

describe("Square settings", () => {
  it("reads SQUARE_ENVIRONMENT case-insensitively and falls back to sandbox when it's missing", () => {
    env({ SQUARE_ENVIRONMENT: " Production " });
    expect(squareSettings()).toMatchObject({ env: "production", apiBase: "https://connect.squareup.com", envVariable: "ok" });
    vi.unstubAllEnvs();
    env({});
    vi.stubEnv("SQUARE_ENVIRONMENT", undefined as unknown as string);
    expect(squareSettings()).toMatchObject({ env: "sandbox", apiBase: "https://connect.squareupsandbox.com" });
  });

  it("sends a token pasted with quotes or a Bearer prefix correctly, and says so without showing it", async () => {
    const tabitha = await owner();
    env({ SQUARE_ENVIRONMENT: "production", SQUARE_ACCESS_TOKEN: ' "Bearer fictional-token" ' });
    mockSquare();
    const r = await runSquareHealthCheck(tabitha);
    expect(calls.every((c) => c.auth === "Bearer fictional-token")).toBe(true);
    expect(JSON.stringify(r.steps)).toMatch(/quotation marks/);
    expect(JSON.stringify(r)).not.toContain("fictional-token");
  });
});

describe("connection-health check (read only)", () => {
  it("explains a production token sent to sandbox: the cause of “This request could not be authorized.”", async () => {
    const tabitha = await owner();
    env({}); // SQUARE_ENVIRONMENT missing → sandbox
    mockSquare({ tokenEnv: "production" });
    const r = await runSquareHealthCheck(tabitha);
    expect(r.ok).toBe(false);
    expect(r.summary).toMatch(/it's a production token but Client Connect is calling sandbox/);
    const steps = r.steps as { key: string; detail: string; code?: string; status?: number }[];
    expect(steps[0].detail).toMatch(/SQUARE_ENVIRONMENT isn't set/);
    expect(steps[0].detail).toMatch(/Application ID is a production ID/);
    expect(steps.find((s) => s.key === "token")).toMatchObject({ status: 401, code: "UNAUTHORIZED" });
    expect((await squareHealth()).state).toBe("FAILING");
    expect(writes()).toEqual([]);
  });

  it("an invalid token is reported as such when neither environment accepts it", async () => {
    const tabitha = await owner();
    env({ SQUARE_ENVIRONMENT: "production" });
    mockSquare({ failAll: 401 });
    const r = await runSquareHealthCheck(tabitha);
    expect(r.summary).toMatch(/Square refused the access token/);
    expect(JSON.stringify(r.steps)).toMatch(/doesn't accept it either/);
  });

  it("passes only when Square accepts the token and every read permission works", async () => {
    const tabitha = await owner();
    const daria = await makeUser("STAFF", "Daria");
    env({ SQUARE_ENVIRONMENT: "production" });
    mockSquare({ tokenEnv: "production" });
    expect((await squareHealth()).state).toBe("UNCHECKED"); // configured ≠ working
    await expect(runSquareHealthCheck(daria)).rejects.toThrow(/Only Tabitha/);
    const r = await runSquareHealthCheck(tabitha);
    expect(r.ok).toBe(true);
    expect((r.steps as { key: string }[]).map((s) => s.key)).toEqual(["settings", "token", "location", "customers", "invoices", "cards"]);
    expect((await squareHealth()).state).toBe("WORKING");
    expect(calls.every((c) => c.host === "connect.squareup.com")).toBe(true);
    expect(writes()).toEqual([]);
  });
});

describe("finding the customer from a recurring series number", () => {
  it("“54458” is treated as a series: Square's customer ID comes from the series' invoices, and the series is flagged", async () => {
    const tabitha = await owner();
    env({ SQUARE_ENVIRONMENT: "production" });
    mockSquare({ tokenEnv: "production" });
    for (const q of ["54458", "54458-R-0003"]) {
      const found = await lookupSquareBilling(tabitha, { query: q });
      expect(found.map((c) => c.id)).toEqual([ZOE.id]);
      expect(found[0].series.find((s) => s.seriesKey === "54458")).toMatchObject({ matched: true, amountCents: 79500 });
    }
    expect(await lookupSquareBilling(tabitha, { query: "99999" })).toEqual([]);
    expect(writes()).toEqual([]);
  });

  it("suggests a confident match from the client's saved email and phone, without linking anything", async () => {
    const tabitha = await owner();
    env({ SQUARE_ENVIRONMENT: "production" });
    mockSquare({ tokenEnv: "production" });
    const c = await createClient(tabitha, { businessName: "Oasis Example LLC (fictional)", firstName: "Zoe", lastName: "Example", email: "zoe@fictional.example", phone: "419-555-0100", clientType: "BUSINESS", status: "ACTIVE" });
    const s = await suggestSquareMatches(tabitha, c.id);
    expect(s.confident).toBe(ZOE.id);
    expect(s.scores[ZOE.id].reasons).toEqual(expect.arrayContaining(["email matches", "phone matches", "business name matches"]));
    expect(await prisma.squareBillingArrangement.count()).toBe(0);
  });
});

describe("figures from Square", () => {
  it("separates scheduled invoices from unpaid and overdue ones, and never says up to date while anything is overdue", () => {
    const b = balanceOf([inv("1-R-1", shift(-40), "UNPAID", 79500, 0), inv("1-R-2", shift(-10), "PARTIALLY_PAID", 79500, 20000), inv("1-R-3", shift(5), "UNPAID"), inv("1-R-4", shift(20), "SCHEDULED"), inv("1-R-5", shift(-70), "FAILED", 79500, 0)], TODAY);
    expect(b).toMatchObject({ outstandingCount: 4, overdueCount: 3, failedCount: 1, outstandingCents: 79500 + 59500 + 79500 + 79500, overdueCents: 79500 + 59500 + 79500 });
    expect(paymentStatus({ lastInvoiceStatus: "PAID", nextDueDate: new Date(), nextInvoiceStatus: "SCHEDULED", overdueCount: 2 })).toEqual({ label: "2 invoices overdue in Square", tone: "red" });
    expect(paymentStatus({ lastInvoiceStatus: "PAID", nextDueDate: new Date(), nextInvoiceStatus: "SCHEDULED", overdueCount: 0 }).label).toBe("Paid — up to date");
  });
});

describe("hourly read-only sync", () => {
  async function linked() {
    const tabitha = await owner();
    env({ SQUARE_ENVIRONMENT: "production" });
    mockSquare({ tokenEnv: "production" });
    const c = await createClient(tabitha, { businessName: "Oasis Example LLC (fictional)", clientType: "BUSINESS", status: "ACTIVE" });
    await saveProfile(tabitha, c.id, { active: true, frequency: "MONTHLY", payroll: false });
    const a = await linkSquareBilling(tabitha, { customerId: ZOE.id, seriesKey: "54458", clientIds: [c.id] });
    return { tabitha, c, a };
  }

  it("refreshes only confirmed links, writes nothing to Square, and logs no financial details", async () => {
    const { a } = await linked();
    // A leftover series with no client is never read.
    await prisma.squareBillingArrangement.create({ data: { squareCustomerId: "ORPHAN", squareLocationId: "LOC1", seriesKey: "1", linkedById: "x" } });
    await prisma.squareBillingArrangement.update({ where: { id: a.id }, data: { syncedAt: new Date(Date.now() - 2 * 3600_000) } });
    INVOICES.push(inv("54458-R-0000", shift(-90), "UNPAID", 79500, 0)); // now one overdue invoice
    calls = [];
    const r = await syncStaleSquareBilling();
    expect(r).toEqual({ ok: 1, failed: 0 });
    expect(calls.some((c) => c.path.includes("ORPHAN"))).toBe(false);
    expect(writes()).toEqual([]);
    const after = await prisma.squareBillingArrangement.findUniqueOrThrow({ where: { id: a.id } });
    expect(after).toMatchObject({ amountCents: 79500, cadence: "MONTHLY", lastPaidCents: 79500, overdueCount: 1, overdueCents: 79500, failedCount: 0, syncError: null });
    expect(paymentStatus(after).label).toBe("1 invoice overdue in Square");
    const log = await prisma.auditLog.findFirstOrThrow({ where: { action: "square_billing.synced_scheduled" } });
    expect(JSON.stringify(log.details)).not.toMatch(/795|Oasis|Zoe/);
  });

  it("doesn't overlap: a second run while one holds the lock does nothing", async () => {
    await linked();
    await prisma.jobLock.create({ data: { name: "square-sync", lockedUntil: new Date(Date.now() + 600_000), runId: "other" } });
    expect(await syncStaleSquareBilling(0)).toMatchObject({ skipped: "another sync is still running" });
    await prisma.jobLock.update({ where: { name: "square-sync" }, data: { lockedUntil: new Date(0) } });
    expect(await syncStaleSquareBilling(0)).toEqual({ ok: 1, failed: 0 });
  });

  it("when Square is down, keeps the last verified figures and marks them stale", async () => {
    const { a } = await linked();
    const before = await prisma.squareBillingArrangement.findUniqueOrThrow({ where: { id: a.id } });
    mockSquare({ failAll: 503 });
    expect(await syncStaleSquareBilling(0)).toEqual({ ok: 0, failed: 1 });
    const after = await prisma.squareBillingArrangement.findUniqueOrThrow({ where: { id: a.id } });
    expect(after.amountCents).toBe(before.amountCents);
    expect(after.syncedAt).toEqual(before.syncedAt);
    expect(after.syncFailedAt).not.toBeNull();
    expect(staleness(after)).toEqual({ stale: true, reason: "Square couldn't be read on the last attempt." });
  });

  it("Owner's Office totals come from the synced Square figures, counted once per bill", async () => {
    await linked();
    const sq = await squareRevenueSummary();
    expect(sq).toMatchObject({ linked: 1, synced: 1, stale: 0, recurringMonthlyCents: 79500, outstandingCents: 0, overdueCents: 0, upcomingCents: 79500 });
    expect(sq.upcoming).toHaveLength(1);
    expect(sq.oldestSync).not.toBeNull();
  });
});
