import { createHmac } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma, resetDb } from "./db";
import { SquareMock } from "./square-mock";
import { ForbiddenError, type Actor } from "@/lib/auth/actor";
import { hashPassword } from "@/lib/auth/password";
import { claimOwnerOffice, grantOwnerAccess } from "@/lib/auth/owner";
import { canChangeBillingSettings, canReconcile, canRecordPayments, canSendInvoices } from "@/lib/auth/billing-permissions";
import { createClient } from "@/lib/services/clients";
import { acceptPortalInvite, invitePortalUser } from "@/lib/services/portal-accounts";
import { savePaymentInstruction } from "@/lib/services/installment-plans";
import { invoiceRows, portalBilling, recordPayment, todayYmd, voidInvoice } from "@/lib/services/owner-billing";
import { approveAndSend, createFirmInvoice, firmInvoiceDoc, setSquareLinksEnabled, submitForApproval, type FirmInvoiceInput } from "@/lib/services/firm-invoices";
import {
  applySquarePaymentToInvoice,
  dismissSquarePayment,
  handleSquareWebhook,
  reconcileSquareInvoices,
  runSquareReconcileNow,
  sendInvoiceViaSquare,
  setSquareDeliveryOptions,
  setSquareSending,
  SQUARE_SENDING_OFF,
  squareReconcileView,
  squareSendingState,
} from "@/lib/services/square-invoicing";
import { addMonths } from "@/lib/billing/pricing";
import { POST as squareWebhookRoute } from "@/app/api/webhooks/square/route";

/**
 * Square invoicing through the firm's existing Square connection — against a local mock only
 * (SQUARE_API_BASE → 127.0.0.1). Fictional office, clients and money. Nothing reaches Square.
 */
const PASSWORD = "Owner-Strong-Pass-1";
const SIGNATURE_KEY = "fictional-webhook-signature-key";
const APP = "https://client.example.test";
const WEBHOOK_URL = `${APP}/api/webhooks/square`;
const today = todayYmd();
const nextMonth = addMonths(today, 1);

// Password hashing for four fictional staff accounts takes a few seconds per test.
vi.setConfig({ testTimeout: 30_000 });

const sq = new SquareMock();
beforeAll(async () => {
  await sq.start();
});
afterAll(async () => {
  await sq.stop();
});

beforeEach(async () => {
  await resetDb();
  sq.reset();
  for (const [k, v] of Object.entries({
    SQUARE_API_BASE: sq.base,
    SQUARE_ACCESS_TOKEN: sq.token,
    SQUARE_LOCATION_ID: "LOC1",
    SQUARE_APPLICATION_ID: "sandbox-sq0idb-fictional",
    SQUARE_ENVIRONMENT: "sandbox",
    SQUARE_WEBHOOK_SIGNATURE_KEY: SIGNATURE_KEY,
    APP_URL: APP,
    RESEND_API_KEY: "re_test",
    EMAIL_FROM_ADDRESS: "Office <office@example.com>",
    RESEND_API_BASE: `${sq.base}/resend`,
    NOTIFICATIONS_ENABLED: "true",
    NO_PROXY: "127.0.0.1,localhost",
  })) vi.stubEnv(k, v);
});
afterEach(() => {
  vi.unstubAllEnvs();
});

async function staffAccount(email: string, name: string, role: "ADMIN" | "STAFF"): Promise<Actor> {
  const u = await prisma.user.create({ data: { email, name, role, passwordHash: await hashPassword(PASSWORD), mfaEnabledAt: new Date() } });
  return { id: u.id, role: u.role, name: u.name, email: u.email };
}

/** Tabitha (owner), Daria (delegated billing access), Marcus (no billing access). */
async function office(opts: { sending?: boolean } = { sending: true }) {
  const tab = await staffAccount("tabitha@tturnerassociates.com", "Tabitha", "ADMIN");
  const daria = await staffAccount("daria@tturnerassociates.example", "Daria", "STAFF");
  const marcus = await staffAccount("marcus@tturnerassociates.example", "Marcus", "STAFF");
  await claimOwnerOffice(tab, PASSWORD);
  await grantOwnerAccess(tab, { userId: daria.id, scope: "BILLING", password: PASSWORD });
  await savePaymentInstruction(tab, "ZELLE", { details: "Send to: Tabitha Turner", active: true });
  await savePaymentInstruction(tab, "SQUARE_INVOICE", { details: "Pay by card through Square.", active: true });
  if (opts.sending) await setSquareSending(tab, true);
  return { tab, daria, marcus };
}

async function client(staff: Actor, email = "rosa.fictional@example.com", phone = "205-555-0142") {
  const rosa = await createClient(staff, { firstName: "Rosa", lastName: "Fictional", clientType: "INDIVIDUAL", status: "ACTIVE", email, phone });
  const { token } = await invitePortalUser(staff, rosa.id, { email: "rosa.portal@example.com", name: "Rosa", role: "OWNER" });
  const user = await acceptPortalInvite(token!, "Portal-Pass-123");
  return { rosa, rosaUser: { id: user.id, name: user.name, email: user.email } };
}

const input = (clientId: string, over: Partial<FirmInvoiceInput> = {}): FirmInvoiceInput => ({
  clientId,
  service: "Tax Preparation",
  amountCents: 40000,
  description: "2025 federal and Alabama individual returns",
  issueDate: today,
  dueDate: nextMonth,
  offeredMethods: ["SQUARE_INVOICE", "ZELLE"],
  ...over,
});

/** Draft by staff → submitted → approved and sent to the portal by the owner (not yet through Square). */
async function approved(tab: Actor, daria: Actor, clientId: string, over: Partial<FirmInvoiceInput> = {}) {
  const inv = await createFirmInvoice(daria, input(clientId, over));
  await submitForApproval(daria, inv.id);
  await approveAndSend(tab, inv.id);
  return inv;
}

const sign = (body: string, url = WEBHOOK_URL, key = SIGNATURE_KEY) => createHmac("sha256", key).update(url + body).digest("base64");
let evn = 0;
function event(type: string, object: Record<string, unknown>, eventId = `evt-${++evn}`) {
  const body = JSON.stringify({ merchant_id: "MFICT", type, event_id: eventId, created_at: new Date().toISOString(), data: { type: type.split(".")[0], id: (Object.values(object)[0] as { id: string }).id, object } });
  return { body, eventId, signature: sign(body) };
}
const deliver = (e: { body: string; signature: string }) => handleSquareWebhook(e.body, e.signature);
const squarePayments = (invoiceId: string) => prisma.payment.findMany({ where: { invoiceId, source: "square" } });
const statusOf = async (actor: Actor, id: string) => (await invoiceRows(actor)).find((r) => r.id === id)!.status;

describe("Square customer: reuse before create", () => {
  it("reuses a Square customer with the same email instead of creating a duplicate", async () => {
    const { tab, daria } = await office();
    const { rosa } = await client(tab);
    sq.customers.push({ id: "CUSTEXISTINGROSA1", email_address: "Rosa.Fictional@example.com", phone_number: "+12055550142", created_at: "2024-01-01T00:00:00Z" });
    const inv = await approved(tab, daria, rosa.id);
    await sendInvoiceViaSquare(daria, inv.id);
    expect(sq.count("POST", "/v2/customers")).toBe(0);
    expect(sq.customers).toHaveLength(1);
    expect((await prisma.invoice.findUniqueOrThrow({ where: { id: inv.id } })).squareCustomerId).toBe("CUSTEXISTINGROSA1");
    expect([...sq.orders.values()][0].customer_id).toBe("CUSTEXISTINGROSA1");
  });

  it("uses the customer the client is linked to under Square billing, then the one an earlier invoice used — never searching or creating again", async () => {
    const { tab, daria } = await office();
    const { rosa } = await client(tab);
    sq.customers.push({ id: "CUSTLINKEDSERIES1", email_address: "someone-else@example.com", created_at: "2023-01-01T00:00:00Z" });
    const arr = await prisma.squareBillingArrangement.create({ data: { squareCustomerId: "CUSTLINKEDSERIES1", squareLocationId: "LOC1", seriesKey: "54458", linkedById: tab.id } });
    await prisma.squareBillingMember.create({ data: { arrangementId: arr.id, clientId: rosa.id, addedById: tab.id } });
    const a = await approved(tab, daria, rosa.id);
    await sendInvoiceViaSquare(tab, a.id);
    expect((await prisma.invoice.findUniqueOrThrow({ where: { id: a.id } })).squareCustomerId).toBe("CUSTLINKEDSERIES1");
    expect(sq.count("POST", "/v2/customers/search")).toBe(0);
    expect(sq.count("POST", "/v2/customers")).toBe(0);
  });

  it("creates a customer only when there's no match, once per client", async () => {
    const { tab, daria } = await office();
    const { rosa } = await client(tab);
    const a = await approved(tab, daria, rosa.id);
    const b = await approved(tab, daria, rosa.id, { amountCents: 12500, service: "Amended Return" });
    await sendInvoiceViaSquare(tab, a.id);
    await sendInvoiceViaSquare(tab, b.id);
    expect(sq.customers).toHaveLength(1);
    expect(sq.count("POST", "/v2/customers")).toBe(1);
    expect(sq.calls.find((c) => c.path === "/v2/customers")!.body).toMatchObject({ idempotency_key: `tcc-cust-${rosa.id}`, reference_id: rosa.id, given_name: "Rosa", family_name: "Fictional", email_address: "rosa.fictional@example.com", phone_number: "+12055550142" });
    const [ia, ib] = await Promise.all([a, b].map((x) => prisma.invoice.findUniqueOrThrow({ where: { id: x.id } })));
    expect(ia.squareCustomerId).toBe(ib.squareCustomerId);
  });
});

describe("Send via Square: order, invoice and publish", () => {
  it("creates one order and one invoice, publishes it, stores Square's ids and link, and emails our branded link", async () => {
    const { tab, daria } = await office();
    const { rosa } = await client(tab);
    const inv = await approved(tab, daria, rosa.id);
    sq.emails = [];
    const r = await sendInvoiceViaSquare(daria, inv.id);
    const saved = await prisma.invoice.findUniqueOrThrow({ where: { id: inv.id } });
    expect(saved).toMatchObject({ squareStatus: "UNPAID", squareInvoiceVersion: 1, squareSentById: daria.id, squareError: null });
    expect(saved.squarePublicUrl).toBe(r.url);
    expect(r.url).toMatch(/^https:\/\/squareupsandbox\.com\/pay-invoice\//);
    const order = sq.calls.find((c) => c.path === "/v2/orders")!.body as { idempotency_key: string; order: Record<string, unknown> };
    expect(order.idempotency_key).toBe(`tcc-${inv.id}-r1-order`);
    expect(order.order).toMatchObject({ location_id: "LOC1", reference_id: inv.number, line_items: [{ name: "Tax Preparation", quantity: "1", base_price_money: { amount: 40000, currency: "USD" }, note: "2025 federal and Alabama individual returns" }] });
    expect(order.order).not.toHaveProperty("service_charges"); // no surcharge
    const created = sq.calls.find((c) => c.path === "/v2/invoices")!.body as { idempotency_key: string; invoice: Record<string, unknown> };
    expect(created.idempotency_key).toBe(`tcc-${inv.id}-r1-invoice`);
    expect(created.invoice).toMatchObject({
      order_id: saved.squareOrderId,
      primary_recipient: { customer_id: saved.squareCustomerId },
      payment_requests: [{ request_type: "BALANCE", due_date: nextMonth, automatic_payment_source: "NONE" }],
      delivery_method: "SHARE_MANUALLY",
      invoice_number: inv.number,
      accepted_payment_methods: { card: true, bank_account: true, square_gift_card: false, buy_now_pay_later: false, cash_app_pay: false },
    });
    expect(sq.calls.find((c) => c.path.endsWith("/publish"))!.body).toEqual({ version: 0, idempotency_key: `tcc-${inv.id}-r1-publish-v0` });
    // Our own branded email carries Square's link (delivery: share manually), through sendEmail.
    expect(sq.emails).toHaveLength(1);
    expect(sq.emails[0]).toMatchObject({ to: ["rosa.fictional@example.com"], subject: `Invoice ${inv.number} from T. Turner & Associates` });
    expect(sq.emails[0].html).toContain(r.url);
    expect(sq.emails[0].idempotencyKey).toBe(`tcc-${inv.id}-r1-email`);
    // Square's own email instead, when the owner chooses it.
    await setSquareDeliveryOptions(tab, { delivery: "EMAIL", acceptBank: false });
    const b = await approved(tab, daria, rosa.id, { amountCents: 9900 });
    sq.emails = [];
    await sendInvoiceViaSquare(tab, b.id);
    expect((sq.calls.filter((c) => c.path === "/v2/invoices").at(-1)!.body as { invoice: Record<string, unknown> }).invoice).toMatchObject({ delivery_method: "EMAIL", accepted_payment_methods: { card: true, bank_account: false } });
    expect(sq.emails).toHaveLength(0);
  });

  it("a retry after a lost reply never creates a second order or invoice, and sending again is a no-op", async () => {
    const { tab, daria } = await office();
    const { rosa } = await client(tab);
    const inv = await approved(tab, daria, rosa.id);
    // Square creates the order and the invoice, but each reply is lost on the way back.
    sq.dropOnce.add("POST /v2/orders");
    await expect(sendInvoiceViaSquare(tab, inv.id)).rejects.toThrow(/couldn't be reached.*won't create a duplicate/);
    expect((await prisma.invoice.findUniqueOrThrow({ where: { id: inv.id } })).squareError).toMatch(/couldn't be reached/);
    sq.dropOnce.add("POST /v2/invoices");
    await expect(sendInvoiceViaSquare(tab, inv.id)).rejects.toThrow(/couldn't be reached/);
    const r = await sendInvoiceViaSquare(tab, inv.id);
    // Each lost create is re-sent once with the same idempotency key; Square returns the same object.
    expect(sq.count("POST", "/v2/orders")).toBe(2);
    expect(sq.count("POST", "/v2/invoices")).toBe(2);
    expect(sq.orders.size).toBe(1);
    expect(sq.invoices.size).toBe(1);
    expect([...sq.invoices.values()][0]).toMatchObject({ status: "UNPAID", public_url: r.url });
    // Already sent: no Square writes at all.
    const before = sq.squareCalls().length;
    expect(await sendInvoiceViaSquare(daria, inv.id)).toMatchObject({ already: true, url: r.url });
    expect(sq.squareCalls().length).toBe(before);
  });

  it("bills only the balance when money was already received offline", async () => {
    const { tab, daria } = await office();
    const { rosa } = await client(tab);
    const inv = await approved(tab, daria, rosa.id);
    await recordPayment(daria, { invoiceId: inv.id, kind: "PAYMENT", status: "SUCCEEDED", amountCents: 10000, receivedOn: today, method: "ZELLE", reference: "ZL-1" });
    await sendInvoiceViaSquare(tab, inv.id);
    const o = [...sq.orders.values()][0];
    expect(o.total).toBe(30000);
    expect(o.discounts).toEqual([{ uid: "applied", name: "Payments and credits already applied", amount_money: { amount: 10000, currency: "USD" }, scope: "ORDER" }]);
  });

  it("approval can send through Square in one step: one email to the client, not two", async () => {
    const { tab, daria } = await office();
    const { rosa } = await client(tab, "rosa.portal@example.com");
    const inv = await createFirmInvoice(daria, input(rosa.id));
    await submitForApproval(daria, inv.id);
    sq.emails = [];
    const r = await approveAndSend(tab, inv.id, { viaSquare: true });
    expect(r.squareUrl).toMatch(/pay-invoice/);
    // The portal login uses the same address as the billing email, so only our Square email goes out.
    expect(sq.emails.map((e) => e.subject)).toEqual([`Invoice ${inv.number} from T. Turner & Associates`]);
    expect((await prisma.invoice.findUniqueOrThrow({ where: { id: inv.id } })).state).toBe("ISSUED");
  });
});

describe("The owner's switch: Send invoices through Square", () => {
  it("while off, everything works except the Square step — no call reaches Square", async () => {
    const { tab, daria } = await office({ sending: false });
    const { rosa, rosaUser } = await client(tab);
    expect(await squareSendingState()).toMatchObject({ enabled: false, live: false, message: SQUARE_SENDING_OFF });
    expect(SQUARE_SENDING_OFF).toBe("Square sending is off — Tabitha turns it on in Billing settings.");
    const inv = await approved(tab, daria, rosa.id);
    await expect(sendInvoiceViaSquare(daria, inv.id)).rejects.toThrow(SQUARE_SENDING_OFF);
    // Approving "via Square" still sends the invoice to the portal and reports the switch.
    const b = await createFirmInvoice(daria, input(rosa.id, { amountCents: 5000 }));
    await submitForApproval(daria, b.id);
    expect(await approveAndSend(tab, b.id, { viaSquare: true })).toMatchObject({ squareUrl: null, squareProblem: SQUARE_SENDING_OFF });
    await recordPayment(daria, { invoiceId: inv.id, kind: "PAYMENT", status: "SUCCEEDED", amountCents: 40000, receivedOn: today, method: "ZELLE", reference: "ZL-9" });
    expect(await statusOf(tab, inv.id)).toBe("PAID");
    expect((await portalBilling(rosaUser, rosa.id)).length).toBe(2);
    expect(sq.squareCalls()).toEqual([]);
    // Only Tabitha flips it, and each change is audited.
    await expect(setSquareSending(daria, true)).rejects.toBeInstanceOf(ForbiddenError);
    await setSquareSending(tab, true);
    await setSquareSending(tab, false);
    expect((await prisma.ownerAuditLog.findMany({ where: { action: { startsWith: "billing.square_sending_" } }, orderBy: { createdAt: "asc" } })).map((l) => [l.action, l.actorId])).toEqual([
      ["billing.square_sending_enabled", tab.id],
      ["billing.square_sending_disabled", tab.id],
    ]);
  });
});

describe("Square webhook", () => {
  it("accepts only Square's signature for our notification URL", async () => {
    await office();
    const e = event("payment.updated", { payment: { id: "PAYX", status: "COMPLETED", amount_money: { amount: 100, currency: "USD" } } });
    expect((await handleSquareWebhook(e.body, "bad-signature")).status).toBe(403);
    expect((await handleSquareWebhook(e.body, sign(e.body, "https://evil.example/api/webhooks/square"))).status).toBe(403);
    expect((await handleSquareWebhook(e.body, sign(e.body, WEBHOOK_URL, "another-key"))).status).toBe(403);
    expect((await handleSquareWebhook(e.body.replace("100", "999"), e.signature)).status).toBe(403); // body changed
    expect(await prisma.squareWebhookEvent.count()).toBe(0);
    // Through the route, with Square's header.
    const res = await squareWebhookRoute(new Request(WEBHOOK_URL, { method: "POST", body: e.body, headers: { "x-square-hmacsha256-signature": e.signature } }));
    expect(res.status).toBe(200);
    expect(await prisma.squareWebhookEvent.count()).toBe(1);
    vi.stubEnv("SQUARE_WEBHOOK_SIGNATURE_KEY", "");
    expect((await deliver(e)).status).toBe(503);
  });

  it("records a Square payment exactly once: replays and overlapping events are ignored; partial → paid", async () => {
    const { tab, daria } = await office();
    const { rosa } = await client(tab);
    const inv = await approved(tab, daria, rosa.id);
    await sendInvoiceViaSquare(tab, inv.id);
    const s = await prisma.invoice.findUniqueOrThrow({ where: { id: inv.id } });
    const p1 = sq.pay(s.squareInvoiceId!, 15000);
    const e1 = event("payment.updated", { payment: p1 });
    expect(await deliver(e1)).toMatchObject({ status: 200, body: "Payment recorded" });
    expect(await deliver(e1)).toMatchObject({ status: 200, body: "Already processed" });
    // Square also sends invoice.payment_made for the same payment.
    expect((await deliver(event("invoice.payment_made", { invoice: sq.invoices.get(s.squareInvoiceId!)! }))).status).toBe(200);
    let pays = await squarePayments(inv.id);
    expect(pays).toHaveLength(1);
    expect(pays[0]).toMatchObject({ kind: "PAYMENT", status: "SUCCEEDED", amountCents: 15000, method: "CARD", source: "square", providerRef: p1.id, reference: p1.id, createdById: "system:square" });
    expect(await statusOf(tab, inv.id)).toBe("PARTIALLY_PAID");
    expect((await prisma.invoice.findUniqueOrThrow({ where: { id: inv.id } })).squareStatus).toBe("PARTIALLY_PAID");
    // The rest, by bank transfer.
    const p2 = sq.pay(s.squareInvoiceId!, 25000, "BANK_ACCOUNT");
    await deliver(event("invoice.payment_made", { invoice: sq.invoices.get(s.squareInvoiceId!)! }));
    await deliver(event("payment.updated", { payment: p2 }));
    pays = await squarePayments(inv.id);
    expect(pays.map((p) => [p.amountCents, p.method]).sort()).toEqual([[15000, "CARD"], [25000, "ACH"]]);
    expect(await statusOf(tab, inv.id)).toBe("PAID");
    expect((await prisma.invoice.findUniqueOrThrow({ where: { id: inv.id } })).squareStatus).toBe("PAID");
    const view = await squareReconcileView(daria);
    expect(view.matched.map((m) => m.providerRef).sort()).toEqual([p1.id, p2.id].sort());
    expect(view.review).toHaveLength(0);
    // The client's history shows the Square payments.
    expect((await prisma.ownerAuditLog.count({ where: { action: "billing.payment_succeeded", actorId: "system:square" } }))).toBe(2);
  });

  it("queues a Square payment that isn't for one of our invoices for review; recurring-billing customers are set aside", async () => {
    const { tab, daria } = await office();
    const { rosa } = await client(tab);
    const inv = await approved(tab, daria, rosa.id);
    await prisma.squareBillingArrangement.create({ data: { squareCustomerId: "CUSTRECURRING01", squareLocationId: "LOC1", seriesKey: "54499", linkedById: tab.id } });
    const stray = sq.outsidePayment(40000);
    const recurring = sq.outsidePayment(79500, "CUSTRECURRING01");
    expect((await deliver(event("payment.updated", { payment: stray }))).body).toMatch(/queued for review/);
    expect((await deliver(event("payment.updated", { payment: recurring }))).body).toMatch(/Recurring/);
    let view = await squareReconcileView(daria);
    expect(view.review.map((r) => r.squarePaymentId)).toEqual([stray.id]);
    expect(view.recurring).toBe(1);
    // Staff apply it to the right invoice (re-read from Square first) — once.
    await applySquarePaymentToInvoice(daria, view.review[0].id, inv.id);
    await expect(applySquarePaymentToInvoice(daria, view.review[0].id, inv.id)).rejects.toThrow(/isn't waiting for review/);
    expect((await squarePayments(inv.id)).map((p) => p.amountCents)).toEqual([40000]);
    expect(await statusOf(tab, inv.id)).toBe("PAID");
    // Or mark one reviewed.
    const other = sq.outsidePayment(2500);
    await deliver(event("payment.updated", { payment: other }));
    view = await squareReconcileView(daria);
    await expect(dismissSquarePayment(daria, view.review[0].id, "")).rejects.toThrow(/Say why/);
    await dismissSquarePayment(daria, view.review[0].id, "In-person sale at the office");
    expect((await squareReconcileView(daria)).review).toHaveLength(0);
  });

  it("a Square event that fails part-way is retried by Square and applied then", async () => {
    const { tab, daria } = await office();
    const { rosa } = await client(tab);
    const inv = await approved(tab, daria, rosa.id);
    await sendInvoiceViaSquare(tab, inv.id);
    const s = await prisma.invoice.findUniqueOrThrow({ where: { id: inv.id } });
    sq.pay(s.squareInvoiceId!, 40000);
    const e = event("invoice.payment_made", { invoice: sq.invoices.get(s.squareInvoiceId!)! });
    sq.failAll = 503;
    expect((await deliver(e)).status).toBe(500);
    sq.failAll = null;
    expect((await deliver(e)).status).toBe(200);
    expect(await squarePayments(inv.id)).toHaveLength(1);
  });
});

describe("Reconcile job (backup for a missed webhook)", () => {
  it("finds a payment Square never told us about, records it once, and is read-only toward Square", async () => {
    const { tab, daria, marcus } = await office();
    const { rosa } = await client(tab);
    const inv = await approved(tab, daria, rosa.id);
    await sendInvoiceViaSquare(tab, inv.id);
    const s = await prisma.invoice.findUniqueOrThrow({ where: { id: inv.id } });
    sq.pay(s.squareInvoiceId!, 40000); // no webhook delivered
    sq.calls = [];
    expect(await reconcileSquareInvoices()).toMatchObject({ checked: 1, newPayments: 1, failed: 0 });
    expect(sq.calls.filter((c) => c.method !== "GET" && c.path !== "/v2/invoices/search")).toEqual([]);
    expect(await squarePayments(inv.id)).toHaveLength(1);
    expect(await statusOf(tab, inv.id)).toBe("PAID");
    // Paid in Square: no longer checked, and a second run records nothing new.
    expect(await reconcileSquareInvoices()).toMatchObject({ checked: 0, newPayments: 0 });
    expect(await squarePayments(inv.id)).toHaveLength(1);
    expect((await squareReconcileView(daria)).lastRun?.details).toMatchObject({ checked: 0 });
    await expect(runSquareReconcileNow(marcus)).rejects.toBeInstanceOf(ForbiddenError);
    expect(await runSquareReconcileNow(daria)).toMatchObject({ checked: 0 });
  });
});

describe("Void cancels the Square invoice", () => {
  it("cancels an unpaid Square invoice, and refuses to void one the client has paid in Square", async () => {
    const { tab, daria } = await office();
    const { rosa, rosaUser } = await client(tab);
    const inv = await approved(tab, daria, rosa.id);
    await sendInvoiceViaSquare(tab, inv.id);
    const s = await prisma.invoice.findUniqueOrThrow({ where: { id: inv.id } });
    await expect(voidInvoice(daria, inv.id, "Billed in error")).rejects.toBeInstanceOf(ForbiddenError);
    await voidInvoice(tab, inv.id, "Billed in error");
    expect(sq.invoices.get(s.squareInvoiceId!)!.status).toBe("CANCELED");
    expect(sq.calls.find((c) => c.path.endsWith("/cancel"))!.body).toEqual({ version: 1 });
    expect(await prisma.invoice.findUniqueOrThrow({ where: { id: inv.id } })).toMatchObject({ state: "VOID", squareStatus: "CANCELED" });
    expect((await prisma.ownerAuditLog.findFirstOrThrow({ where: { action: "billing.square_invoice_canceled" } })).entityId).toBe(inv.id);
    // The client sees it voided, with no Square button.
    const row = (await portalBilling(rosaUser, rosa.id)).find((r) => r.id === inv.id)!;
    expect(row.status).toBe("VOIDED");
    // Paid in Square (webhook not yet received): the void records the payment and stops.
    const paid = await approved(tab, daria, rosa.id, { amountCents: 20000 });
    await sendInvoiceViaSquare(tab, paid.id);
    const ps = await prisma.invoice.findUniqueOrThrow({ where: { id: paid.id } });
    sq.pay(ps.squareInvoiceId!, 5000);
    await expect(voidInvoice(tab, paid.id, "Changed my mind")).rejects.toThrow(/paid \(or started paying\) this invoice through Square/);
    expect(await squarePayments(paid.id)).toHaveLength(1);
    expect(sq.invoices.get(ps.squareInvoiceId!)!.status).toBe("PARTIALLY_PAID");
    expect((await prisma.invoice.findUniqueOrThrow({ where: { id: paid.id } })).state).toBe("ISSUED");
    // If Square can't be reached, nothing is voided.
    const third = await approved(tab, daria, rosa.id, { amountCents: 3000 });
    await sendInvoiceViaSquare(tab, third.id);
    sq.failAll = 503;
    await expect(voidInvoice(tab, third.id, "x")).rejects.toThrow(/nothing was voided/);
    sq.failAll = null;
    expect((await prisma.invoice.findUniqueOrThrow({ where: { id: third.id } })).state).toBe("ISSUED");
  });
});

describe("Permissions (server-side)", () => {
  it("owner or billing staff send, record payments and reconcile; only Tabitha changes billing settings; refunds stay owner-only", async () => {
    const { tab, daria, marcus } = await office();
    const { rosa } = await client(tab);
    expect([await canSendInvoices(tab), await canRecordPayments(tab), await canReconcile(tab), await canChangeBillingSettings(tab)]).toEqual([true, true, true, true]);
    expect([await canSendInvoices(daria), await canRecordPayments(daria), await canReconcile(daria), await canChangeBillingSettings(daria)]).toEqual([true, true, true, false]);
    expect([await canSendInvoices(marcus), await canRecordPayments(marcus), await canReconcile(marcus), await canChangeBillingSettings(marcus)]).toEqual([false, false, false, false]);
    const inv = await approved(tab, daria, rosa.id);
    await expect(sendInvoiceViaSquare(marcus, inv.id)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(recordPayment(marcus, { invoiceId: inv.id, kind: "PAYMENT", status: "SUCCEEDED", amountCents: 100, receivedOn: today, method: "CASH" })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(squareReconcileView(marcus)).rejects.toBeInstanceOf(ForbiddenError);
    expect(sq.squareCalls()).toEqual([]);
    await recordPayment(daria, { invoiceId: inv.id, kind: "PAYMENT", status: "SUCCEEDED", amountCents: 100, receivedOn: today, method: "CASH" });
    await expect(recordPayment(daria, { invoiceId: inv.id, kind: "REFUND", status: "SUCCEEDED", amountCents: 100, receivedOn: today, method: "CASH" })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(setSquareDeliveryOptions(daria, { delivery: "EMAIL", acceptBank: true })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(setSquareLinksEnabled(daria, true)).rejects.toBeInstanceOf(ForbiddenError);
    // A second full-access owner (not the primary) can't flip the Square switch either.
    const partner = await staffAccount("partner@tturnerassociates.example", "Pat", "STAFF");
    await grantOwnerAccess(tab, { userId: partner.id, scope: "FULL", password: PASSWORD });
    expect(await canChangeBillingSettings(partner)).toBe(false);
    await expect(setSquareSending(partner, false)).rejects.toBeInstanceOf(ForbiddenError);
    expect(await sendInvoiceViaSquare(daria, inv.id)).toMatchObject({ already: false });
  });
});

describe("Client portal: Pay securely with Square", () => {
  it("shows the Square button only when Square's public_url exists and the invoice is payable there", async () => {
    const { tab, daria } = await office();
    const { rosa, rosaUser } = await client(tab);
    const inv = await approved(tab, daria, rosa.id);
    const doc = async () => {
      const row = (await portalBilling(rosaUser, rosa.id)).find((r) => r.id === inv.id)!;
      return firmInvoiceDoc({ number: row.number, status: row.status, issueDate: row.issueDate, dueDate: row.dueDate, billTo: row.billTo, lines: row.breakdown.lines, totalCents: row.totalCents, payments: row.payments, offeredMethods: row.offeredMethods, squarePaymentUrl: row.squarePaymentUrl, squarePublicUrl: row.squarePublicUrl, squareStatus: row.squareStatus });
    };
    const before = (await doc()).options.find((o) => o.method === "SQUARE_INVOICE")!;
    expect(before).toMatchObject({ url: null, notEnabled: true });
    const r = await sendInvoiceViaSquare(tab, inv.id);
    expect((await doc()).options.find((o) => o.method === "SQUARE_INVOICE")).toMatchObject({ url: r.url, notEnabled: false });
    // Paid in Square: no button (and no "Ways to pay").
    const s = await prisma.invoice.findUniqueOrThrow({ where: { id: inv.id } });
    sq.pay(s.squareInvoiceId!, 40000);
    await reconcileSquareInvoices();
    const after = await doc();
    expect(after.status).toBe("PAID");
    expect(after.options.find((o) => o.method === "SQUARE_INVOICE")?.url ?? null).toBeNull();
  });
});
