import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeUser, prisma, resetDb } from "./db";
import { ForbiddenError } from "@/lib/auth/actor";
import { createClient } from "@/lib/services/clients";
import { acceptPortalInvite, invitePortalUser } from "@/lib/services/portal-accounts";
import { saveProfile } from "@/lib/services/bookkeeping-clients";
import { billingView, saveBilling } from "@/lib/services/bookkeeping-profile";
import { savePaymentMethod } from "@/lib/services/business-onboarding";
import { createAndLinkBusiness } from "@/lib/services/related-businesses";
import { linkSquareBilling, lookupSquareBilling, removeClientFromSquareBilling, squareBillingFor, type SqInvoice } from "@/lib/services/square-billing";

// Fictional Square customers and recurring invoices.
const COX = { id: "CUSTCOX0000FICT1", given_name: "Steven", family_name: "Cox", company_name: "Energy Solutions (fictional)", email_address: "steven@fictional.example", phone_number: "+12055550101" };
const LEE = { id: "CUSTLEE0000FICT2", given_name: "Dana", family_name: "Lee", email_address: "dana@fictional.example", phone_number: "+12055550202" };
const inv = (n: string, due: string, status: string, customer = COX.id): SqInvoice => ({
  id: `inv:${n}`, invoice_number: n, title: "Monthly Bookkeeping (fictional)", status, location_id: "LOC1", primary_recipient: { customer_id: customer },
  payment_requests: [{ request_type: "BALANCE", due_date: due, automatic_payment_source: "CARD_ON_FILE", card_id: "ccof:FICT", computed_amount_money: { amount: 45000 } }],
});
const INVOICES = [inv("700-R-0001", "2026-09-27", "PAID"), inv("700-R-0002", "2026-10-27", "PAID"), inv("700-R-0003", "2026-11-27", "SCHEDULED"), inv("800-R-0001", "2026-10-05", "PAID"), inv("800-R-0002", "2026-11-05", "SCHEDULED")];

let calls: { method: string; path: string; body?: unknown }[] = [];
function mockSquare() {
  calls = [];
  vi.stubEnv("SQUARE_ACCESS_TOKEN", "test-token");
  vi.stubEnv("SQUARE_LOCATION_ID", "LOC1");
  vi.stubEnv("SQUARE_APPLICATION_ID", "sandbox-app");
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    const u = new URL(url);
    const path = decodeURIComponent(u.pathname);
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method: init.method ?? "GET", path, body });
    const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200 });
    if (path === "/v2/customers" && (init.method ?? "GET") === "GET") {
      // Two pages, so the name search must follow Square's cursor.
      return u.searchParams.get("cursor") ? json({ customers: [COX] }) : json({ customers: [LEE], cursor: "page2" });
    }
    if (path === "/v2/customers/search") {
      const f = body.query.filter;
      if (f.email_address?.fuzzy === "steven@fictional.example" || f.phone_number?.fuzzy === "2055550101") return json({ customers: [COX] });
      return json({});
    }
    if (path === `/v2/customers/${COX.id}`) return json({ customer: COX });
    if (path === "/v2/invoices/search") return json({ invoices: INVOICES });
    if (path === "/v2/cards/ccof:FICT") return json({ card: { id: "ccof:FICT", card_brand: "VISA", last_4: "4242", exp_month: 8, exp_year: 2029 } });
    if (path === "/v2/customers" && init.method === "POST") return json({ customer: { id: "CUSTNEW0000FICT3" } });
    if (path === "/v2/cards" && init.method === "POST") return json({ card: { id: "ccof:NEW", card_brand: "VISA", last_4: "1111", exp_month: 1, exp_year: 2030 } });
    return new Response(JSON.stringify({ errors: [{ detail: "Customer not found." }] }), { status: 404 });
  });
}
// Lookups and links only ever read: the only POSTs allowed are Square's search endpoints.
const writes = () => calls.filter((c) => c.method === "POST" && !c.path.endsWith("/search"));

beforeEach(async () => {
  await resetDb();
  mockSquare();
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

async function setup() {
  const tabitha = await makeUser("ADMIN", "Tabitha");
  await prisma.ownerAccess.create({ data: { userId: tabitha.id, isPrimary: true } });
  const daria = await makeUser("STAFF", "Daria");
  const energy = await createClient(tabitha, { firstName: "Steven", lastName: "Cox", businessName: "Energy Solutions (fictional)", email: "steven@fictional.example", phone: "205-555-0101", clientType: "BUSINESS", status: "ACTIVE" });
  const drive = await createAndLinkBusiness(tabitha, energy.id, { businessName: "Drive Time (fictional)", clientType: "BUSINESS" });
  const other = await createClient(tabitha, { businessName: "Unrelated Co (fictional)", clientType: "BUSINESS", status: "ACTIVE" });
  for (const b of [energy, drive, other]) await saveProfile(tabitha, b.id, { active: true, frequency: "MONTHLY", payroll: false });
  return { tabitha, daria, energy, drive, other };
}

describe("Find and link in Square — one search box", () => {
  it("finds a customer by name, email, phone or Square customer ID, reading only", async () => {
    const { tabitha } = await setup();
    const ids = async (query: string) => (await lookupSquareBilling(tabitha, { query })).map((c) => c.id);
    expect(await ids("steven cox")).toEqual([COX.id]); // on Square's second page
    expect(await ids("Energy Solutions")).toEqual([COX.id]);
    expect(await ids("steven@fictional.example")).toEqual([COX.id]);
    expect(await ids("(205) 555-0101")).toEqual([COX.id]);
    expect(await ids(COX.id)).toEqual([COX.id]);
    expect(await ids("CUSTUNKNOWN000FICT9")).toEqual([]); // an unknown ID is "no match", not an error
    expect(await ids("nobody here")).toEqual([]);
    await expect(lookupSquareBilling(tabitha, { query: "s" })).rejects.toThrow(/at least two letters/);
    await expect(lookupSquareBilling(tabitha, {})).rejects.toThrow(/name, email, phone or Square customer ID/);
    const found = await lookupSquareBilling(tabitha, { query: "steven cox" });
    expect(found[0].series.map((s) => s.seriesKey).sort()).toEqual(["700", "800"]);
    expect(writes()).toEqual([]);
  });

  it("staff without billing access can't search Square", async () => {
    const { daria } = await setup();
    await expect(lookupSquareBilling(daria, { query: "steven" })).rejects.toBeInstanceOf(ForbiddenError);
    expect(calls).toEqual([]);
  });
});

describe("the verified Square customer ID replaces the hand-typed field", () => {
  it("the billing form can't set a Square customer ID", async () => {
    const { tabitha, energy } = await setup();
    await saveBilling(tabitha, energy.id, { monthlyFee: "450", ...({ squareCustomerId: "54458" } as object) });
    expect((await prisma.bookkeepingBilling.findUniqueOrThrow({ where: { clientId: energy.id } })).squareCustomerId).toBeNull();
  });

  it("an existing hand-typed ID is shown as not verified, kept in history when the verified one replaces it, and never used for a card", async () => {
    const { tabitha, energy, drive } = await setup();
    // What the migration leaves for an ID typed by hand before this change.
    await prisma.bookkeepingBilling.create({ data: { clientId: energy.id, squareCustomerId: "54458", squareCustomerIdSource: "MANUAL", paymentStatus: "CURRENT" } });
    let v = await billingView(tabitha, energy.id);
    expect(v.allowed && v.square.customerId).toMatchObject({ id: "54458", status: "UNVERIFIED" });

    await linkSquareBilling(tabitha, { customerId: COX.id, seriesKey: "700", clientIds: [energy.id, drive.id] });
    expect(writes()).toEqual([]); // nothing created, charged or invoiced in Square
    const b = await prisma.bookkeepingBilling.findUniqueOrThrow({ where: { clientId: energy.id } });
    expect(b).toMatchObject({ squareCustomerId: COX.id, squareCustomerIdSource: "SQUARE_LINK", paymentStatus: "CURRENT" });
    expect(b.squareCustomerIdVerifiedAt).not.toBeNull();
    const log = await prisma.auditLog.findFirstOrThrow({ where: { action: "square_billing.customer_id_verified", clientId: energy.id } });
    expect(log.details).toMatchObject({ squareCustomerId: COX.id, previous: { squareCustomerId: "54458", source: "MANUAL" } });
    // Drive Time had no billing record; it gets the verified ID too.
    expect((await prisma.bookkeepingBilling.findUniqueOrThrow({ where: { clientId: drive.id } })).squareCustomerId).toBe(COX.id);
    v = await billingView(tabitha, energy.id);
    expect(v.allowed && v.square.customerId).toMatchObject({ id: COX.id, status: "VERIFIED" });
  });

  it("a card saved in the portal never goes onto an unverified, hand-typed Square customer", async () => {
    const { tabitha, other } = await setup();
    await prisma.bookkeepingProfile.update({ where: { clientId: other.id }, data: { squareBillingExpected: false } });
    await prisma.bookkeepingBilling.create({ data: { clientId: other.id, squareCustomerId: "54458", squareCustomerIdSource: "MANUAL" } });
    const { token } = await invitePortalUser(tabitha, other.id, { email: "owner@fictional.example", name: "Owner", role: "OWNER" });
    const u = await acceptPortalInvite(token!, "Portal-Pass-123456");
    await savePaymentMethod({ id: u.id, name: u.name, email: u.email }, other.id, { sourceId: "cnon:fictional", cardholderName: "Pat Owner" });
    const card = calls.find((c) => c.path === "/v2/cards" && c.method === "POST")!;
    expect((card.body as { card: { customer_id: string } }).card.customer_id).toBe("CUSTNEW0000FICT3");
    expect(await prisma.bookkeepingBilling.findUniqueOrThrow({ where: { clientId: other.id } })).toMatchObject({ squareCustomerId: "CUSTNEW0000FICT3", squareCustomerIdSource: "CLIENT_CONNECT" });
    const log = await prisma.auditLog.findFirstOrThrow({ where: { action: "billing.payment_method_saved", clientId: other.id } });
    expect(log.details).toMatchObject({ replacedUnverifiedSquareCustomerId: "54458" });
  });
});

describe("preventing and correcting a wrong match", () => {
  it("one Square customer's billing can't be split across different owners", async () => {
    const { tabitha, energy, other } = await setup();
    await linkSquareBilling(tabitha, { customerId: COX.id, seriesKey: "700", clientIds: [energy.id] });
    await expect(linkSquareBilling(tabitha, { customerId: COX.id, seriesKey: "800", clientIds: [other.id] })).rejects.toThrow(/already linked to a different client's records/);
    expect(await prisma.squareBillingMember.count({ where: { clientId: other.id } })).toBe(0);
  });

  it("only Tabitha corrects a wrong match, with a reason; the verified ID comes off and the history stays", async () => {
    const { tabitha, daria, other } = await setup();
    const a = await linkSquareBilling(tabitha, { customerId: COX.id, seriesKey: "700", clientIds: [other.id] });
    await expect(removeClientFromSquareBilling(daria, a.id, other.id, "Wrong customer")).rejects.toBeInstanceOf(ForbiddenError);
    await expect(removeClientFromSquareBilling(tabitha, a.id, other.id, "oops")).rejects.toThrow(/Record why/);
    await removeClientFromSquareBilling(tabitha, a.id, other.id, "Wrong Square customer — verified with the client");
    expect((await squareBillingFor(other.id)).arrangement).toBeNull();
    expect((await prisma.bookkeepingBilling.findUniqueOrThrow({ where: { clientId: other.id } })).squareCustomerId).toBeNull();
    const log = await prisma.auditLog.findFirstOrThrow({ where: { action: "square_billing.client_unlinked", clientId: other.id } });
    expect(log.details).toMatchObject({ reason: "Wrong Square customer — verified with the client", squareCustomerId: COX.id, seriesKey: "700", customerIdCleared: true });
    expect(await prisma.auditLog.count({ where: { action: "square_billing.customer_id_verified", clientId: other.id } })).toBe(1);
    expect(writes()).toEqual([]);
  });
});
