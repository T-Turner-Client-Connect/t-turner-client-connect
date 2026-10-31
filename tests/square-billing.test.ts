import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeUser, prisma, resetDb } from "./db";
import { ForbiddenError } from "@/lib/auth/actor";
import { createClient } from "@/lib/services/clients";
import { acceptPortalInvite, invitePortalUser } from "@/lib/services/portal-accounts";
import { saveProfile } from "@/lib/services/bookkeeping-clients";
import { billingView, recordChargeAuthorization, saveBilling } from "@/lib/services/bookkeeping-profile";
import { acceptRecurringTerms } from "@/lib/services/business-onboarding";
import { createAndLinkBusiness, grantOwnerPortalAccess } from "@/lib/services/related-businesses";
import {
  addClientToSquareBilling, linkSquareBilling, lookupSquareBilling, NOT_SYNCED, paymentStatus, portalSquareBilling, removeClientFromSquareBilling,
  scheduleText, seriesKeyOf, squareBillingFor, summarizeSeries, syncSquareBilling, verifyExistingAuthorization, type SqInvoice,
} from "@/lib/services/square-billing";

// Fictional Square data shaped like Square's recurring invoices ("<series>-R-<n>").
const inv = (n: string, due: string, status: string, amount = 99500, extra: Partial<SqInvoice> = {}): SqInvoice => ({
  id: `inv:${n}`, invoice_number: n, title: "Monthly Bookkeeping (fictional)", status, location_id: "LOC1", primary_recipient: { customer_id: "CUST_COX" },
  payment_requests: [{ request_type: "BALANCE", due_date: due, card_id: "ccof:FICTIONAL", automatic_payment_source: "CARD_ON_FILE", computed_amount_money: { amount } }],
  ...extra,
});
const COX_INVOICES = [
  inv("700-R-0001", "2026-07-27", "PAID"), inv("700-R-0002", "2026-08-27", "PAID"), inv("700-R-0003", "2026-09-27", "PAID"),
  inv("700-R-0004", "2026-10-27", "PAID"), inv("700-R-0005", "2026-11-27", "SCHEDULED"),
  inv("701", "2026-04-15", "PAID", 25000), // a one-time invoice, not part of the series
];

let calls: { method: string; path: string }[] = [];
function mockSquare() {
  calls = [];
  vi.stubEnv("SQUARE_ACCESS_TOKEN", "test-token");
  vi.stubEnv("SQUARE_LOCATION_ID", "LOC1");
  vi.stubEnv("SQUARE_APPLICATION_ID", "sandbox-app");
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    const path = decodeURIComponent(new URL(url).pathname);
    calls.push({ method: init.method ?? "GET", path });
    const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200 });
    if (path === "/v2/customers/search") return json({ customers: [{ id: "CUST_COX", given_name: "Steven", family_name: "Cox", company_name: "Drive Time/ Energy Solutions (fictional)", email_address: "steven@fictional.example" }] });
    if (path === "/v2/customers/CUST_COX") return json({ customer: { id: "CUST_COX", given_name: "Steven", family_name: "Cox", company_name: "Drive Time/ Energy Solutions (fictional)" } });
    if (path === "/v2/invoices/search") return json({ invoices: COX_INVOICES });
    if (path === "/v2/cards/ccof:FICTIONAL") return json({ card: { id: "ccof:FICTIONAL", card_brand: "VISA", last_4: "4242", exp_month: 8, exp_year: 2029 } });
    return new Response(JSON.stringify({ errors: [{ detail: `unexpected ${path}` }] }), { status: 404 });
  });
}

beforeEach(async () => {
  await resetDb();
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("reading Square's recurring invoices", () => {
  it("recognizes recurring series and works out amount, schedule, next charge and status from Square's invoices only", () => {
    expect(seriesKeyOf("54499-R-0005")).toBe("54499");
    expect(seriesKeyOf("701")).toBeNull();
    const s = summarizeSeries(COX_INVOICES.filter((i) => seriesKeyOf(i.invoice_number) === "700"), "2026-10-30");
    expect(s).toMatchObject({ amountCents: 99500, cadence: "MONTHLY", dueDay: 27, nextInvoiceStatus: "SCHEDULED", lastInvoiceStatus: "PAID", autopay: true, squareCardId: "ccof:FICTIONAL", invoiceCount: 5 });
    expect(s.nextDueDate?.toISOString().slice(0, 10)).toBe("2026-11-27");
    expect(scheduleText(s)).toBe("Monthly · due on the 27th");
    expect(paymentStatus(s)).toEqual({ label: "Paid — up to date", tone: "green" });

    // A first invoice on another day (as when a series starts mid-month) still reads as monthly on the 27th.
    const started = summarizeSeries([inv("8-R-1", "2026-07-21", "PAID"), inv("8-R-2", "2026-08-27", "PAID"), inv("8-R-3", "2026-09-27", "PAID"), inv("8-R-4", "2026-10-27", "PAID"), inv("8-R-5", "2026-11-27", "SCHEDULED")], "2026-10-30");
    expect(started).toMatchObject({ amountCents: 99500, cadence: "MONTHLY", dueDay: 27, lastInvoiceStatus: "PAID", nextInvoiceStatus: "SCHEDULED", autopay: true });

    const q = summarizeSeries([inv("9-R-1", "2026-03-01", "PAID", 50000, { payment_requests: [{ request_type: "BALANCE", due_date: "2026-03-01", automatic_payment_source: "NONE", computed_amount_money: { amount: 50000 } }] }), inv("9-R-2", "2026-06-01", "PAID"), inv("9-R-3", "2026-09-01", "UNPAID", 50000, { payment_requests: [{ request_type: "BALANCE", due_date: "2026-09-01", automatic_payment_source: "NONE", computed_amount_money: { amount: 50000 } }] })], "2026-10-30");
    expect(q.cadence).toBe("QUARTERLY");
    expect(q.autopay).toBe(false);
    expect(paymentStatus(q).label).toBe("Past due in Square");
    expect(paymentStatus({ lastInvoiceStatus: "FAILED", nextDueDate: null, nextInvoiceStatus: null }).tone).toBe("red");
  });
});

describe("existing Square billing (fictional Steven Cox: one bill for two businesses)", () => {
  async function setup() {
    const tabitha = await makeUser("ADMIN", "Tabitha");
    await prisma.ownerAccess.create({ data: { userId: tabitha.id, isPrimary: true } });
    const daria = await makeUser("STAFF", "Daria");
    // As in the office CRM: Steven exists as one Business record; Drive Time was added from it.
    const energy = await createClient(tabitha, { firstName: "Steven", lastName: "Cox", businessName: "Energy Solutions Insulation, LLC (fictional)", email: "steven@fictional.example", clientType: "BUSINESS", status: "ACTIVE" });
    const drive = await createAndLinkBusiness(tabitha, energy.id, { businessName: "Drive Time (fictional)", clientType: "BUSINESS" });
    const other = await createClient(tabitha, { businessName: "Unrelated Co (fictional)", clientType: "BUSINESS", status: "ACTIVE" });
    for (const b of [energy, drive]) await saveProfile(tabitha, b.id, { active: true, frequency: "MONTHLY", payroll: false });
    // What the migration does for every client already on the bookkeeping list.
    await prisma.bookkeepingProfile.updateMany({ data: { squareBillingExpected: true } });
    return { tabitha, daria, energy, drive, other };
  }

  it("shows “not yet synced” (never “Not authorized”) and refuses any second authorization until linked", async () => {
    const { tabitha, energy } = await setup();
    const sb = await squareBillingFor(energy.id);
    expect(sb.state).toBe("NOT_SYNCED");
    expect(NOT_SYNCED).toBe("Existing Square billing—not yet synced");
    await saveBilling(tabitha, energy.id, { monthlyFee: "995" });
    await expect(recordChargeAuthorization(tabitha, energy.id, { amount: "995", startDate: new Date(), method: "PORTAL_CONSENT", authorizedByName: "Steven Cox", authorizedAt: new Date() })).rejects.toThrow(/already pays through recurring billing in Square/);
    expect(await prisma.recurringChargeAuthorization.count()).toBe(0);
    // Without Square connected, lookups explain why and nothing is linked.
    await expect(lookupSquareBilling(tabitha, { email: "steven@fictional.example" })).rejects.toThrow(/Square isn't connected yet/);
  });

  it("links one Square series to both businesses, reads it only, and verifies the existing authorization", async () => {
    const { tabitha, daria, energy, drive, other } = await setup();
    mockSquare();
    const found = await lookupSquareBilling(tabitha, { email: "steven@fictional.example" });
    expect(found).toHaveLength(1);
    expect(found[0].series.map((s) => s.seriesKey)).toEqual(["700"]); // the one-time invoice isn't a series
    expect(found[0].series[0]).toMatchObject({ amountCents: 99500, cadence: "MONTHLY", autopay: true, linked: null });

    const a = await linkSquareBilling(tabitha, { customerId: "CUST_COX", seriesKey: "700", clientIds: [energy.id, drive.id] });
    expect(a).toMatchObject({ amountCents: 99500, cadence: "MONTHLY", dueDay: 27, cardBrand: "VISA", cardLast4: "4242", lastInvoiceStatus: "PAID", syncError: null });
    const [e, d] = await Promise.all([squareBillingFor(energy.id), squareBillingFor(drive.id)]);
    expect(e.arrangement!.id).toBe(d.arrangement!.id); // the SAME billing arrangement
    expect(e.state).toBe("SYNCED");
    expect(await prisma.squareBillingArrangement.count()).toBe(1);

    // No duplicates: the series can't be linked twice and a business can't be on two bills.
    await expect(linkSquareBilling(tabitha, { customerId: "CUST_COX", seriesKey: "700", clientIds: [other.id] })).rejects.toThrow(/already linked/);
    await expect(linkSquareBilling(tabitha, { customerId: "CUST_COX", seriesKey: "999", clientIds: [drive.id] })).rejects.toThrow(/only one Square bill/);
    await expect(addClientToSquareBilling(tabitha, a.id, energy.id)).rejects.toThrow(/already on this Square bill/);

    // Still no new authorization or recurring charge from Client Connect.
    await expect(recordChargeAuthorization(tabitha, drive.id, { amount: "995", startDate: new Date(), method: "PORTAL_CONSENT", authorizedByName: "Steven Cox", authorizedAt: new Date() })).rejects.toThrow(/already pays/);

    // Only Tabitha verifies the authorization already on file in Square.
    await expect(verifyExistingAuthorization(daria, a.id, "Checked Square")).rejects.toBeInstanceOf(ForbiddenError);
    await verifyExistingAuthorization(tabitha, a.id, "Card-on-file authorization in Square Dashboard");
    expect((await squareBillingFor(drive.id)).state).toBe("VERIFIED");
    const view = await billingView(tabitha, energy.id);
    expect(view.allowed && view.squareBilling.state).toBe("VERIFIED");

    // Re-sync reads again; every call was a read (GET, or a POST search).
    await syncSquareBilling(tabitha, a.id);
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every((c) => c.method === "GET" || c.path.endsWith("/search"))).toBe(true);

    // The client: one login sees the bill from either business, charged once, and can't authorize again.
    const { token } = await invitePortalUser(tabitha, energy.id, { email: "steven@fictional.example", name: "Steven Cox", role: "OWNER" });
    const login = await acceptPortalInvite(token!, "Steven-Pass-12345");
    const actor = { id: login.id, name: login.name, email: login.email };
    const p1 = await portalSquareBilling(actor, energy.id);
    expect(p1.view).toMatchObject({ amountCents: 99500, schedule: "Monthly · due on the 27th", authorizationVerified: true, card: { brand: "VISA", last4: "4242" }, alsoCovers: [], otherAccounts: 1 });
    await grantOwnerPortalAccess(tabitha, energy.id, drive.id, login.id);
    expect((await portalSquareBilling(actor, energy.id)).view!.alsoCovers).toEqual(["Drive Time (fictional)"]);
    await expect(acceptRecurringTerms(actor, energy.id, { agree: true, typedName: "Steven Cox" })).rejects.toThrow(/already set up in Square/);

    // Removing a link is Tabitha-only, recorded with a reason, and never touches Square.
    const before = calls.length;
    await expect(removeClientFromSquareBilling(daria, a.id, drive.id, "Wrong business")).rejects.toBeInstanceOf(ForbiddenError);
    await removeClientFromSquareBilling(tabitha, a.id, drive.id, "Linked by mistake");
    expect(calls.length).toBe(before);
    expect((await squareBillingFor(drive.id)).state).toBe("NOT_SYNCED");
    expect(await prisma.auditLog.count({ where: { action: "square_billing.client_unlinked" } })).toBe(1);
  });

  it("staff without billing access can't look up or link Square billing", async () => {
    const { daria, energy } = await setup();
    mockSquare();
    await expect(lookupSquareBilling(daria, { email: "steven@fictional.example" })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(linkSquareBilling(daria, { customerId: "CUST_COX", seriesKey: "700", clientIds: [energy.id] })).rejects.toBeInstanceOf(ForbiddenError);
    expect(calls).toHaveLength(0);
  });
});
