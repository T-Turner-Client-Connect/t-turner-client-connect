import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeUser, prisma, resetDb } from "./db";
import { createClient } from "@/lib/services/clients";
import { saveProfile } from "@/lib/services/bookkeeping-clients";
import { acceptPortalInvite, invitePortalUser } from "@/lib/services/portal-accounts";
import {
  addClientToSquareBilling, linkSquareBilling, lookupSquareBilling, portalSquareBilling, syncClientSquareBilling, reviewSquareSeries, seriesActivity, seriesStatus, squareBillingFor, squareBillingOverview, squareRevenueSummary, syncStaleSquareBilling,
  type SeriesInvoice, type SqInvoice,
} from "@/lib/services/square-billing";

// Fictional data shaped like the real case: one customer with a current monthly series ("800", like 54458)
// and an older quarterly series ("900", like 54430) whose last invoice was paid more than a year ago.
const CUST = "CUSTFICTIONAL0000000000001";
const OTHER = "CUSTFICTIONAL0000000000002";
const TODAY = new Date().toLocaleDateString("en-CA", { timeZone: "America/Chicago" });
const day = (n: number) => new Date(new Date(`${TODAY}T12:00:00Z`).getTime() + n * 86_400_000).toISOString().slice(0, 10);
const inv = (n: string, due: string, status: string, amount: number, customer = CUST): SqInvoice => ({
  id: `inv:${n}`, invoice_number: n, title: n.startsWith("900") ? "Quarterly Payments" : "Monthly membership", status, location_id: "LOC1", primary_recipient: { customer_id: customer },
  order_id: `ord:${n}`, public_url: `https://squareup.example/invoice/${n}`,
  payment_requests: [{ request_type: "BALANCE", due_date: due, automatic_payment_source: "CARD_ON_FILE", computed_amount_money: { amount }, total_completed_amount_money: { amount: status === "PAID" ? amount : 0 } }],
});
const MONTHLY = () => [inv("800-R-0001", day(-61), "PAID", 79500), inv("800-R-0002", day(-30), "PAID", 79500), inv("800-R-0003", day(1), "SCHEDULED", 79500)];
const QUARTERLY = () => [inv("900-R-0001", day(-520), "PAID", 100000), inv("900-R-0002", day(-430), "PAID", 100000)];
let invoices: SqInvoice[] = [];

let calls: { method: string; path: string }[] = [];
beforeEach(async () => {
  await resetDb();
  invoices = [...MONTHLY(), ...QUARTERLY(), inv("777", day(-400), "PAID", 50000)];
  calls = [];
  vi.stubEnv("SQUARE_ACCESS_TOKEN", "test-token");
  vi.stubEnv("SQUARE_LOCATION_ID", "LOC1");
  vi.stubEnv("SQUARE_APPLICATION_ID", "sq0idp-test");
  vi.stubEnv("SQUARE_ENVIRONMENT", "production");
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    const path = decodeURIComponent(new URL(url).pathname);
    const body = init.body ? JSON.parse(String(init.body)) : {};
    calls.push({ method: init.method ?? "GET", path });
    const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200 });
    const who = (id: string) => ({ id, given_name: id === CUST ? "Zoe" : "Other", family_name: "Fictional", email_address: id === CUST ? "zoe@fictional.example" : "other@fictional.example" });
    if (path === "/v2/customers/search") return json({ customers: [who(CUST)] });
    if (path.startsWith("/v2/customers/")) return json({ customer: who(path.split("/").pop()!) });
    if (path === "/v2/invoices/search") {
      const c = body.query?.filter?.customer_ids?.[0];
      return json({ invoices: invoices.filter((i) => !c || i.primary_recipient?.customer_id === c) });
    }
    // Paid date and receipt come from the order's payment.
    if (path === "/v2/orders/batch-retrieve") return json({ orders: (body.order_ids as string[]).map((id) => ({ id, tenders: [{ payment_id: `pay:${id.slice(4)}`, created_at: "2020-01-01T00:00:00Z" }] })) });
    if (path.startsWith("/v2/payments/")) {
      const n = path.split("pay:")[1];
      const due = invoices.find((i) => i.invoice_number === n)?.payment_requests?.[0]?.due_date;
      return json({ payment: { status: "COMPLETED", updated_at: `${due}T15:00:05Z`, receipt_url: `https://squareup.example/receipt/${n}` } });
    }
    return new Response(JSON.stringify({ errors: [{ code: "NOT_FOUND" }] }), { status: 404 });
  });
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});
const writes = () => calls.filter((c) => c.method === "POST" && !c.path.endsWith("/search") && !c.path.endsWith("/batch-retrieve"));

async function setup() {
  const tabitha = await makeUser("ADMIN", "Tabitha");
  await prisma.ownerAccess.create({ data: { userId: tabitha.id, isPrimary: true } });
  const oasis = await createClient(tabitha, { businessName: "Oasis Example LLC (fictional)", email: "zoe@fictional.example", clientType: "BUSINESS", status: "ACTIVE" });
  await saveProfile(tabitha, oasis.id, { active: true, frequency: "MONTHLY", payroll: false });
  return { tabitha, oasis };
}

describe("is a recurring series active? (Square's API has no series status)", () => {
  it("only a scheduled or open invoice proves ACTIVE; anything else is “needs review” until the owner decides", () => {
    const r = (status: string, due: string) => ({ status, due });
    const st = (rows: { status: string; due: string }[], cadence: string, decision?: { decision: string }) => seriesStatus(seriesActivity(rows, cadence, TODAY), decision);
    expect(st([r("PAID", day(-30)), r("SCHEDULED", day(1))], "MONTHLY")).toBe("ACTIVE");
    expect(st([r("PAID", day(-60)), r("UNPAID", day(-5))], "MONTHLY")).toBe("ACTIVE");
    // No upcoming invoice is never enough to call it ended.
    const waiting = seriesActivity([r("PAID", day(-62)), r("PAID", day(-31))], "MONTHLY", TODAY);
    expect(waiting.evidence).toBe("WAITING");
    expect(seriesStatus(waiting, null)).toBe("NEEDS_REVIEW");
    const old = seriesActivity([r("PAID", day(-520)), r("PAID", day(-430))], "QUARTERLY", TODAY);
    expect(old.evidence).toBe("LIKELY_ENDED");
    expect(old.reason).toMatch(/likely ended in Square/);
    expect(seriesStatus(old, null)).toBe("NEEDS_REVIEW");
    expect(seriesStatus(old, { decision: "ENDED" })).toBe("ENDED");
    // A new scheduled invoice in Square always wins over an earlier "ended" decision.
    expect(st([r("PAID", day(-430)), r("SCHEDULED", day(5))], "QUARTERLY", { decision: "ENDED" })).toBe("ACTIVE");
    expect(seriesActivity([r("CANCELED", day(10))], "MONTHLY", TODAY).evidence).toBe("ALL_CANCELED");
  });
});

describe("suggestions and linking: active series only", () => {
  it("offers the active monthly series; the old quarterly one waits for review, then becomes history", async () => {
    const { tabitha } = await setup();
    const [c] = await lookupSquareBilling(tabitha, { query: "zoe@fictional.example" });
    expect(c.series.map((s) => s.seriesKey)).toEqual(["800"]);
    expect(c.review).toEqual([expect.objectContaining({ seriesKey: "900", amountCents: 100000, cadence: "QUARTERLY", decision: null })]);
    expect(c.ended).toEqual([]);
    // Only Tabitha decides, with a reason.
    const daria = await makeUser("STAFF", "Daria");
    await expect(reviewSquareSeries(daria, { customerId: CUST, seriesKey: "900", decision: "ENDED", reason: "Replaced by 800" })).rejects.toThrow(/Only Tabitha/);
    await expect(reviewSquareSeries(tabitha, { customerId: CUST, seriesKey: "900", decision: "ENDED", reason: "no" })).rejects.toThrow(/Record why/);
    await expect(reviewSquareSeries(tabitha, { customerId: OTHER, seriesKey: "900", decision: "ENDED", reason: "Wrong customer test" })).rejects.toThrow(/no invoices in series 900/);
    expect((await reviewSquareSeries(tabitha, { customerId: CUST, seriesKey: "900", decision: "ENDED", reason: "Replaced by the monthly series in Sept 2025" })).status).toBe("ENDED");
    const [after] = await lookupSquareBilling(tabitha, { query: "900" });
    expect(after.series.map((s) => s.seriesKey)).toEqual(["800"]);
    expect(after.review).toEqual([]);
    expect(after.ended[0]).toMatchObject({ seriesKey: "900", matched: true, decision: { decision: "ENDED", reason: "Replaced by the monthly series in Sept 2025" } });
    expect(await prisma.auditLog.count({ where: { action: "square_billing.series_reviewed" } })).toBe(1);
    expect(writes()).toEqual([]);
  });

  it("an uncertain or ended series, or another customer's series, can't be linked", async () => {
    const { tabitha, oasis } = await setup();
    await expect(linkSquareBilling(tabitha, { customerId: CUST, seriesKey: "900", clientIds: [oasis.id] })).rejects.toThrow(/Status needs review/);
    await reviewSquareSeries(tabitha, { customerId: CUST, seriesKey: "900", decision: "ENDED", reason: "Replaced by the monthly series" });
    await expect(linkSquareBilling(tabitha, { customerId: CUST, seriesKey: "900", clientIds: [oasis.id] })).rejects.toThrow(/Ended — history only/);
    invoices.push(inv("555-R-0001", day(1), "SCHEDULED", 25000, OTHER));
    await expect(linkSquareBilling(tabitha, { customerId: CUST, seriesKey: "555", clientIds: [oasis.id] })).rejects.toThrow(/no invoices in series 555 for this customer/);
    expect(await prisma.squareBillingArrangement.count()).toBe(0);
  });
});

describe("the linked series only", () => {
  it("history, balances and totals come from the linked series alone, with Square's paid dates and receipts", async () => {
    const { tabitha, oasis } = await setup();
    invoices.push(inv("900-R-0003", day(-5), "UNPAID", 100000)); // something owed on the OTHER series
    const a = await linkSquareBilling(tabitha, { customerId: CUST, seriesKey: "800", clientIds: [oasis.id] });
    expect(a).toMatchObject({ amountCents: 79500, cadence: "MONTHLY", outstandingCents: 0, overdueCents: 0, lastPaidCents: 79500 });
    const list = a.seriesInvoices as SeriesInvoice[];
    expect(list.map((i) => i.number)).toEqual(["800-R-0003", "800-R-0002", "800-R-0001"]); // newest first, this series only
    expect(list[1]).toMatchObject({ status: "PAID", paidAt: day(-30), receiptUrl: "https://squareup.example/receipt/800-R-0002" });
    expect(list[0]).toMatchObject({ status: "SCHEDULED", paidAt: null, receiptUrl: null });
    expect((await squareRevenueSummary()).overdueCents).toBe(0);
    expect(writes()).toEqual([]);

    // The client sees their own series, newest first; another client's login sees nothing of it.
    const { token } = await invitePortalUser(tabitha, oasis.id, { email: "zoe@fictional.example", name: "Zoe", role: "OWNER" });
    const zoe = await acceptPortalInvite(token!, "Portal-Pass-123456");
    const view = (await portalSquareBilling({ id: zoe.id, name: zoe.name, email: zoe.email }, oasis.id)).view!;
    expect(view.invoices.map((i) => i.number)).toEqual(["800-R-0003", "800-R-0002", "800-R-0001"]);
    expect(view.invoices[1]).toMatchObject({ status: "PAID", paidAt: day(-30), receiptUrl: "https://squareup.example/receipt/800-R-0002" });
    const stranger = await createClient(tabitha, { businessName: "Unrelated (fictional)", clientType: "BUSINESS", status: "ACTIVE" });
    const { token: t2 } = await invitePortalUser(tabitha, stranger.id, { email: "x@fictional.example", name: "X", role: "OWNER" });
    const x = await acceptPortalInvite(t2!, "Portal-Pass-123456");
    await expect(portalSquareBilling({ id: x.id, name: x.name, email: x.email }, oasis.id)).rejects.toThrow();
  });
});

describe("a linked series whose status becomes uncertain, then ended", () => {
  it("leaves current billing and totals, keeps history, and an old series never displaces the current one", async () => {
    const { tabitha, oasis } = await setup();
    invoices = [...MONTHLY(), inv("900-R-0001", day(-100), "PAID", 100000), inv("900-R-0002", day(-9), "PAID", 100000), inv("900-R-0003", day(83), "SCHEDULED", 100000)];
    const q = await linkSquareBilling(tabitha, { customerId: CUST, seriesKey: "900", clientIds: [oasis.id] });
    expect((await squareRevenueSummary()).recurringMonthlyCents).toBe(Math.round(100000 / 3));
    // The next quarterly invoice was canceled in Square and nothing new came: uncertain, not auto-ended.
    invoices = [...MONTHLY(), inv("900-R-0001", day(-220), "PAID", 100000), inv("900-R-0002", day(-129), "PAID", 100000), inv("900-R-0003", day(-37), "CANCELED", 100000)];
    await syncStaleSquareBilling(0);
    expect(await prisma.squareBillingArrangement.findUniqueOrThrow({ where: { id: q.id } })).toMatchObject({ active: false, needsReview: true, amountCents: 100000 });
    let sb = await squareBillingFor(oasis.id);
    expect(sb.arrangement).toBeNull();
    expect(sb.review.map((e) => e.seriesKey)).toEqual(["900"]);
    expect((await squareRevenueSummary())).toMatchObject({ linked: 0, reviewCount: 1, recurringMonthlyCents: 0 });
    expect(await prisma.auditLog.count({ where: { action: "square_billing.series_status_changed", clientId: oasis.id } })).toBe(1);

    // Tabitha marks it ended: it becomes history; the current monthly series can then be linked.
    await reviewSquareSeries(tabitha, { customerId: CUST, seriesKey: "900", decision: "ENDED", reason: "Client moved to the monthly plan" });
    sb = await squareBillingFor(oasis.id);
    expect(sb.ended.map((e) => e.seriesKey)).toEqual(["900"]);
    expect(sb.review).toEqual([]);
    await linkSquareBilling(tabitha, { customerId: CUST, seriesKey: "800", clientIds: [oasis.id] });
    sb = await squareBillingFor(oasis.id);
    expect(sb.arrangement!.seriesKey).toBe("800");
    expect(sb.ended.map((e) => e.seriesKey)).toEqual(["900"]);
    expect((await squareBillingOverview(tabitha)).find((r) => r.clientId === oasis.id)!.arrangement!.seriesKey).toBe("800");
    // The ended series stays on the client as history (counted as ended, never in current totals).
    expect((await squareRevenueSummary())).toMatchObject({ linked: 1, endedCount: 1, recurringMonthlyCents: 79500 });
    // The old series can't be re-linked over the current one.
    await expect(linkSquareBilling(tabitha, { customerId: CUST, seriesKey: "900", clientIds: [oasis.id] })).rejects.toThrow(/already linked|isn't verified as active/);
    expect(writes()).toEqual([]);
  });
});

describe("staff and client see the same records for the linked series", () => {
  it("partial payment, refund, balances, paid dates and receipts match; Paid only when Square says so", async () => {
    const { tabitha, oasis } = await setup();
    const partial = inv("800-R-0099", day(-92), "PARTIALLY_PAID", 79500);
    partial.payment_requests![0].total_completed_amount_money = { amount: 40000 };
    invoices.push(partial, inv("800-R-0098", day(-120), "REFUNDED", 79500));
    const a = await linkSquareBilling(tabitha, { customerId: CUST, seriesKey: "800", clientIds: [oasis.id] });
    const staff = a.seriesInvoices as SeriesInvoice[];
    expect(a).toMatchObject({ outstandingCents: 39500, overdueCents: 39500, overdueCount: 1 });
    expect(staff.find((i) => i.number === "800-R-0099")).toMatchObject({ status: "PARTIALLY_PAID", paidCents: 40000, paidAt: null, receiptUrl: null });
    expect(staff.find((i) => i.number === "800-R-0098")).toMatchObject({ status: "REFUNDED", paidAt: null, receiptUrl: null });
    const { token } = await invitePortalUser(tabitha, oasis.id, { email: "zoe@fictional.example", name: "Zoe", role: "OWNER" });
    const zoe = await acceptPortalInvite(token!, "Portal-Pass-123456");
    const view = (await portalSquareBilling({ id: zoe.id, name: zoe.name, email: zoe.email }, oasis.id)).view!;
    expect(view.invoices.map((i) => [i.number, i.status, i.paidAt, i.receiptUrl])).toEqual(staff.map((i) => [i.number, i.status, i.status === "PAID" ? i.paidAt : null, i.status === "PAID" ? i.receiptUrl : null]));
    expect(view.invoices.find((i) => i.number === "800-R-0099")).toMatchObject({ paidCents: 40000 });
    expect(view).toMatchObject({ outstandingCents: 39500, overdueCents: 39500, overdueCount: 1 });
    expect(view.status.label).toBe("1 invoice overdue in Square");
  });
});

describe("a client with more than one active Square series (like Carlos)", () => {
  it("links each series separately; staff and client see every series with its own payments; totals count each once", async () => {
    const { tabitha, oasis } = await setup();
    // A second, separate customer account in Square with its own active monthly series ("610").
    invoices = [...MONTHLY(), inv("610-R-0001", day(-40), "PAID", 25000, OTHER), inv("610-R-0002", day(-10), "PAID", 25000, OTHER), inv("610-R-0003", day(20), "SCHEDULED", 25000, OTHER)];
    const first = await linkSquareBilling(tabitha, { customerId: CUST, seriesKey: "800", clientIds: [oasis.id] });
    const second = await linkSquareBilling(tabitha, { customerId: OTHER, seriesKey: "610", clientIds: [oasis.id] });
    const sb = await squareBillingFor(oasis.id);
    expect(sb.arrangements.map((a) => a.seriesKey)).toEqual(["800", "610"]);
    expect(sb.arrangement!.id).toBe(first.id);
    expect(sb.state).toBe("SYNCED");
    expect((await squareBillingOverview(tabitha)).find((r) => r.clientId === oasis.id)!.arrangements).toHaveLength(2);
    // Each Square bill counted once; nothing summed twice.
    expect(await squareRevenueSummary()).toMatchObject({ linked: 2, recurringMonthlyCents: 79500 + 25000 });
    // Never twice on the same series; the same series can't be linked again.
    await expect(addClientToSquareBilling(tabitha, second.id, oasis.id)).rejects.toThrow(/already on this Square bill/);
    await expect(linkSquareBilling(tabitha, { customerId: OTHER, seriesKey: "610", clientIds: [oasis.id] })).rejects.toThrow(/already linked/);

    // The client sees both bills, each with only its own invoices.
    const { token } = await invitePortalUser(tabitha, oasis.id, { email: "carlos@fictional.example", name: "Carlos", role: "OWNER" });
    const carlos = await acceptPortalInvite(token!, "Portal-Pass-123456");
    const p = await portalSquareBilling({ id: carlos.id, name: carlos.name, email: carlos.email }, oasis.id);
    expect(p.views.map((v) => v.seriesKey)).toEqual(["800", "610"]);
    expect(p.views[0].invoices.every((i) => i.number!.startsWith("800-"))).toBe(true);
    expect(p.views[1].invoices.map((i) => i.number)).toEqual(["610-R-0003", "610-R-0002", "610-R-0001"]);
    expect(p.unsynced).toBe(0);
    // Another client's login sees none of it.
    const stranger = await createClient(tabitha, { businessName: "Unrelated (fictional)", clientType: "BUSINESS", status: "ACTIVE" });
    const { token: t2 } = await invitePortalUser(tabitha, stranger.id, { email: "x@fictional.example", name: "X", role: "OWNER" });
    const x = await acceptPortalInvite(t2!, "Portal-Pass-123456");
    await expect(portalSquareBilling({ id: x.id, name: x.name, email: x.email }, oasis.id)).rejects.toThrow();

    // Sync Now re-reads both series, read only.
    expect(await syncClientSquareBilling(tabitha, oasis.id)).toBe(2);
    expect(writes()).toEqual([]);
  });
});
