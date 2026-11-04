import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { grantPerms, prisma, resetDb } from "./db";
import { SquareMock } from "./square-mock";
import { ForbiddenError, type Actor } from "@/lib/auth/actor";
import { hashPassword } from "@/lib/auth/password";
import { claimOwnerOffice } from "@/lib/auth/owner";
import { applyPermissionPreset } from "@/lib/auth/permissions";
import { DARIA_PRESET, GRANTABLE_KEYS } from "@/lib/permissions";
import { createClient } from "@/lib/services/clients";
import { acceptPortalInvite, invitePortalUser } from "@/lib/services/portal-accounts";
import { savePaymentInstruction } from "@/lib/services/installment-plans";
import { recordPayment, todayYmd } from "@/lib/services/owner-billing";
import { addMonths } from "@/lib/billing/pricing";
import { setSquareSending } from "@/lib/services/square-invoicing";
import { requestInvoice } from "@/lib/services/invoice-requests";
import {
  approveSchedule,
  billingDashboard,
  endSchedule,
  generateScheduleItem,
  OWNER_ONLY_SCHEDULES,
  pauseSchedule,
  proposeSchedule,
  resumeSchedule,
  runBillingSchedules,
  scheduleList,
  splitTotal,
  updateSchedule,
  type ScheduleInput,
} from "@/lib/services/billing-schedules";
import { createFirmInvoice, approveAndSend } from "@/lib/services/firm-invoices";

/** Fictional office, clients and money. Square is a local mock; nothing reaches Square, a phone or an inbox. */
const PASSWORD = "Owner-Strong-Pass-1";
const today = todayYmd();
const next = addMonths(today, 1);
const later = addMonths(today, 2);
vi.setConfig({ testTimeout: 40_000 });

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
    APP_URL: "https://client.example.test",
    RESEND_API_KEY: "re_test",
    EMAIL_FROM_ADDRESS: "Office <office@example.com>",
    RESEND_API_BASE: `${sq.base}/resend`,
    NOTIFICATIONS_ENABLED: "true",
    NO_PROXY: "127.0.0.1,localhost",
    // Live sending is OFF unless a test turns it on.
    LIVE_SENDING_ENABLED: "",
  })) vi.stubEnv(k, v);
});
afterEach(() => {
  vi.unstubAllEnvs();
});

async function staff(email: string, name: string, role: "ADMIN" | "STAFF"): Promise<Actor> {
  const u = await prisma.user.create({ data: { email, name, role, passwordHash: await hashPassword(PASSWORD), mfaEnabledAt: new Date() } });
  return { id: u.id, role: u.role, name: u.name, email: u.email };
}

/** Tabitha (owner), Daria (Billing clerk preset), Marcus (no billing), Alex (a second Admin holding every grantable permission). */
async function office() {
  const tab = await staff("tabitha@tturnerassociates.com", "Tabitha", "ADMIN");
  const daria = await staff("daria@tturnerassociates.example", "Daria", "STAFF");
  const marcus = await staff("marcus@tturnerassociates.example", "Marcus", "STAFF");
  const alex = await staff("alex@tturnerassociates.example", "Alex", "ADMIN");
  await claimOwnerOffice(tab, PASSWORD);
  await applyPermissionPreset(tab, daria.id, DARIA_PRESET.key);
  await grantPerms(alex.id, GRANTABLE_KEYS);
  await savePaymentInstruction(tab, "ZELLE", { details: "Send to: Tabitha Turner", active: true });
  await savePaymentInstruction(tab, "SQUARE_INVOICE", { details: "Pay by card through Square.", active: true });
  const rosa = await createClient(tab, { firstName: "Rosa", lastName: "Fictional", clientType: "INDIVIDUAL", status: "ACTIVE", email: "rosa.fictional@example.com", phone: "205-555-0142" });
  return { tab, daria, marcus, alex, rosa };
}

const recurring = (clientId: string, over: Partial<ScheduleInput> = {}): ScheduleInput => ({
  clientId,
  kind: "RECURRING",
  service: "Consulting",
  description: "Monthly tax planning check-in",
  amountCents: 15000,
  cadence: "MONTHLY",
  startDate: today,
  invoiceDay: Math.min(28, Number(today.slice(8, 10))),
  dueInDays: 14,
  offeredMethods: ["ZELLE"],
  ...over,
});

const invoicesOf = (scheduleId: string) => prisma.billingScheduleItem.findMany({ where: { scheduleId, invoiceId: { not: null } }, include: { invoice: true }, orderBy: { seq: "asc" } });

describe("Recurring invoice schedules", () => {
  it("makes one invoice per period, however many times the cron runs", async () => {
    const { tab, rosa } = await office();
    const s = await proposeSchedule(tab, recurring(rosa.id));
    expect(s.status).toBe("ACTIVE");
    expect(await invoicesOf(s.id)).toHaveLength(1);
    await runBillingSchedules();
    await runBillingSchedules();
    expect(await invoicesOf(s.id)).toHaveLength(1);
    // The next month: one more, again only once.
    await runBillingSchedules(next);
    await runBillingSchedules(next);
    await Promise.all([runBillingSchedules(next), runBillingSchedules(next)]);
    const made = await invoicesOf(s.id);
    expect(made).toHaveLength(2);
    expect(made.map((m) => m.periodKey)).toEqual([today.slice(0, 7), next.slice(0, 7)]);
    expect(made.every((m) => m.invoice!.state === "DRAFT" && m.invoice!.formType === "INVOICE")).toBe(true);
    expect(await prisma.invoice.count()).toBe(2);
    // Audited.
    expect(await prisma.ownerAuditLog.count({ where: { action: "billing.schedule_cycle_created", entityType: "Invoice" } })).toBe(2);
    expect(await prisma.ownerAuditLog.count({ where: { action: "billing.schedule_created", entityId: s.id } })).toBe(1);
  });

  it("stops at the number of invoices or the end date", async () => {
    const { tab, rosa } = await office();
    const s = await proposeSchedule(tab, recurring(rosa.id, { maxInvoices: 2 }));
    await runBillingSchedules(next);
    await runBillingSchedules(later);
    expect(await invoicesOf(s.id)).toHaveLength(2);
    expect((await prisma.billingSchedule.findUniqueOrThrow({ where: { id: s.id } })).status).toBe("ENDED");
    const q = await proposeSchedule(tab, recurring(rosa.id, { cadence: "QUARTERLY", service: "Payroll", endDate: next }));
    await runBillingSchedules(addMonths(today, 6));
    expect(await invoicesOf(q.id)).toHaveLength(1);
  });

  it("pause and end stop generation; resume doesn't back-bill the paused months", async () => {
    const { tab, rosa } = await office();
    const s = await proposeSchedule(tab, recurring(rosa.id));
    await pauseSchedule(tab, s.id);
    await runBillingSchedules(next);
    expect(await invoicesOf(s.id)).toHaveLength(1);
    await resumeSchedule(tab, s.id);
    expect((await prisma.billingSchedule.findUniqueOrThrow({ where: { id: s.id } })).skipBefore?.toISOString().slice(0, 10)).toBe(today);
    await runBillingSchedules(later);
    expect((await invoicesOf(s.id)).map((m) => m.periodKey)).toEqual([today, next, later].map((d) => d.slice(0, 7)));
    await endSchedule(tab, s.id, "Client finished planning");
    const count = (await invoicesOf(s.id)).length;
    await runBillingSchedules(addMonths(today, 5));
    expect(await invoicesOf(s.id)).toHaveLength(count);
  });

  it("auto-send off → drafts only; nothing reaches the client or Square", async () => {
    const { tab, rosa } = await office();
    await setSquareSending(tab, true);
    vi.stubEnv("LIVE_SENDING_ENABLED", "true");
    const s = await proposeSchedule(tab, recurring(rosa.id, { offeredMethods: ["ZELLE", "SQUARE_INVOICE"] }));
    await runBillingSchedules(next);
    const made = await invoicesOf(s.id);
    expect(made.map((m) => m.invoice!.state)).toEqual(["DRAFT", "DRAFT"]);
    expect(await prisma.notification.count({ where: { kind: "NEW_INVOICE" } })).toBe(0);
    expect(sq.calls).toHaveLength(0);
  });

  it("auto-send on with live sending disabled → nothing sent (held as a draft); with it on, sent through the normal path", async () => {
    const { tab, rosa } = await office();
    const s = await proposeSchedule(tab, recurring(rosa.id, { autoSend: true }));
    const [first] = await invoicesOf(s.id);
    expect(first.invoice!.state).toBe("DRAFT");
    expect((await prisma.billingSchedule.findUniqueOrThrow({ where: { id: s.id } })).lastProblem).toMatch(/live sending is off/);
    expect(await prisma.notification.count()).toBe(0);
    expect(sq.calls).toHaveLength(0);
    expect(await prisma.ownerAuditLog.count({ where: { action: "billing.schedule_autosend_held" } })).toBe(1);
    // Live sending on (Square sending still off): next month's invoice goes to the portal the normal way, not Square.
    vi.stubEnv("LIVE_SENDING_ENABLED", "true");
    await runBillingSchedules(next);
    const made = await invoicesOf(s.id);
    expect(made[1].invoice!.state).toBe("ISSUED");
    expect(made[1].invoice!.approvedById).toBe(tab.id);
    expect(made[1].invoice!.squareInvoiceId).toBeNull();
    expect(sq.calls).toHaveLength(0);
  });
});

describe("Payment plans (deposits & installments)", () => {
  it("deposit: a partial invoice now, the balance later — total, paid and remaining", async () => {
    const { tab, daria, rosa } = await office();
    const s = await proposeSchedule(tab, { clientId: rosa.id, kind: "DEPOSIT", service: "Tax Preparation", description: "2025 returns", amountCents: 30000, totalCents: 100000, startDate: today, offeredMethods: ["ZELLE"] });
    const [dep] = await invoicesOf(s.id);
    expect(dep).toMatchObject({ amountCents: 30000, label: "Deposit toward $1,000.00" });
    await approveAndSend(tab, dep.invoiceId!);
    await recordPayment(tab, { invoiceId: dep.invoiceId!, kind: "PAYMENT", status: "SUCCEEDED", amountCents: 30000, receivedOn: today, method: "ZELLE" });
    let [row] = await scheduleList(tab, { clientId: rosa.id });
    expect(row).toMatchObject({ totalCents: 100000, paidCents: 30000, remainingCents: 70000, nextDate: "When the work is done" });
    // Daria (Billing clerk) makes the balance invoice under the plan Tabitha approved.
    const balId = await generateScheduleItem(daria, s.id, "2");
    expect((await prisma.invoice.findUniqueOrThrow({ where: { id: balId }, include: { lines: true } })).lines[0].unitCents).toBe(70000);
    await expect(generateScheduleItem(daria, s.id, "2")).rejects.toThrow(/already made/);
    [row] = await scheduleList(tab, { clientId: rosa.id });
    expect(row.remainingCents).toBe(70000);
  });

  it("installments: a total split into N invoices on dates", async () => {
    const { tab, rosa } = await office();
    expect(splitTotal(100000, 3)).toEqual([33333, 33333, 33334]);
    const s = await proposeSchedule(tab, { clientId: rosa.id, kind: "INSTALLMENTS", service: "Business Formation", description: "LLC formation", amountCents: 0, totalCents: 100000, installments: 3, cadence: "MONTHLY", startDate: today, offeredMethods: ["ZELLE"] });
    expect(await invoicesOf(s.id)).toHaveLength(1);
    await runBillingSchedules(later);
    await runBillingSchedules(later);
    const made = await invoicesOf(s.id);
    expect(made.map((m) => m.amountCents)).toEqual([33333, 33333, 33334]);
    expect(made.map((m) => m.invoice!.issueDate.toISOString().slice(0, 10))).toEqual([today, next, later]);
  });
});

describe("Who may create, approve and change schedules (Tabitha only)", () => {
  it("a no-billing staff member can't even propose; Daria's preset can propose but it awaits Tabitha and makes nothing", async () => {
    const { tab, daria, marcus, rosa } = await office();
    await expect(proposeSchedule(marcus, recurring(rosa.id))).rejects.toBeInstanceOf(ForbiddenError);
    const s = await proposeSchedule(daria, recurring(rosa.id));
    expect(s).toMatchObject({ status: "PROPOSED", approvedById: null, autoSend: false });
    await runBillingSchedules(next);
    expect(await prisma.invoice.count()).toBe(0);
    // Daria can't approve, change, pause, end, or turn on auto-send.
    await expect(approveSchedule(daria, s.id)).rejects.toThrow(OWNER_ONLY_SCHEDULES);
    await expect(updateSchedule(daria, s.id, { amountCents: 1 })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(endSchedule(daria, s.id)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(proposeSchedule(daria, recurring(rosa.id, { service: "Payroll", autoSend: true }))).rejects.toBeInstanceOf(ForbiddenError);
    // Tabitha approves: now it's active and the due invoice is made.
    await approveSchedule(tab, s.id);
    expect(await invoicesOf(s.id)).toHaveLength(1);
    await expect(pauseSchedule(daria, s.id)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(updateSchedule(daria, s.id, { autoSend: true })).rejects.toBeInstanceOf(ForbiddenError);
    // Daria can still create and send one-time invoices.
    const one = await createFirmInvoice(daria, { clientId: rosa.id, service: "Tax Preparation", amountCents: 20000, description: "2025 return", issueDate: today, dueDate: next, offeredMethods: ["ZELLE"] });
    await approveAndSend(daria, one.id);
    expect((await prisma.invoice.findUniqueOrThrow({ where: { id: one.id } })).state).toBe("ISSUED");
  });

  it("a second Admin holding every grantable permission is refused too; Tabitha is allowed", async () => {
    const { tab, alex, rosa } = await office();
    const s = await proposeSchedule(alex, recurring(rosa.id));
    expect(s.status).toBe("PROPOSED");
    await expect(approveSchedule(alex, s.id)).rejects.toThrow(OWNER_ONLY_SCHEDULES);
    await expect(updateSchedule(alex, s.id, { amountCents: 20000 })).rejects.toBeInstanceOf(ForbiddenError);
    await approveSchedule(tab, s.id);
    await expect(pauseSchedule(alex, s.id)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(resumeSchedule(alex, s.id)).rejects.toBeInstanceOf(ForbiddenError);
    await updateSchedule(tab, s.id, { amountCents: 20000, autoSend: false });
    await runBillingSchedules(next);
    const made = await invoicesOf(s.id);
    // Future amounts only: the first invoice keeps its amount.
    expect(made.map((m) => m.amountCents)).toEqual([15000, 20000]);
    expect(await prisma.ownerAuditLog.count({ where: { entityId: s.id, action: "billing.schedule_changed", actorId: tab.id } })).toBe(1);
  });

  it("a schedule made for a client's invoice request answers it with its first invoice", async () => {
    const { tab, rosa } = await office();
    const { token } = await invitePortalUser(tab, rosa.id, { email: "rosa.portal@example.com", name: "Rosa Fictional", role: "OWNER" });
    const u = await acceptPortalInvite(token!, "Portal-Pass-123");
    const r = await requestInvoice({ id: u.id, name: u.name, email: u.email }, { clientId: rosa.id, items: [{ kind: "OTHER", ref: null }], note: "Monthly planning" });
    const s = await proposeSchedule(tab, recurring(rosa.id, { requestId: r.id }));
    const [first] = await invoicesOf(s.id);
    expect(await prisma.invoiceRequest.findUniqueOrThrow({ where: { id: r.id } })).toMatchObject({ status: "INVOICE_CREATED", invoiceId: first.invoiceId });
  });
});

describe("Bookkeeping subscriptions in Square stay untouched", () => {
  it("warns before double billing, allows tax invoices, and generating + sending never touches the Square series or its links", async () => {
    const { tab, rosa } = await office();
    sq.customers.push({ id: "CUSTBOOKS0001", email_address: "rosa.fictional@example.com", created_at: "2023-01-01T00:00:00Z" });
    const arr = await prisma.squareBillingArrangement.create({ data: { squareCustomerId: "CUSTBOOKS0001", squareLocationId: "LOC1", seriesKey: "54499", title: "Monthly bookkeeping", amountCents: 59500, cadence: "MONTHLY", nextDueDate: new Date(`${next}T00:00:00Z`), linkedById: tab.id, syncedAt: new Date() } });
    await prisma.squareBillingMember.create({ data: { arrangementId: arr.id, clientId: rosa.id, addedById: tab.id } });
    await prisma.bookkeepingBilling.create({ data: { clientId: rosa.id, monthlyFeeCents: 59500, squareCustomerId: "CUSTBOOKS0001" } });
    const before = {
      arr: await prisma.squareBillingArrangement.findUniqueOrThrow({ where: { id: arr.id } }),
      members: await prisma.squareBillingMember.findMany(),
      billing: await prisma.bookkeepingBilling.findMany(),
      manual: await prisma.manualBillingPayment.count(),
      reviews: await prisma.squareSeriesReview.count(),
    };
    // Same service as the subscription: warned, and refused until confirmed.
    await expect(proposeSchedule(tab, recurring(rosa.id, { service: "Bookkeeping" }))).rejects.toThrow(/Possible double billing/);
    // Tax/other billing is allowed alongside it — and here sent live through Square, automatically.
    await setSquareSending(tab, true);
    vi.stubEnv("LIVE_SENDING_ENABLED", "true");
    sq.calls = [];
    const s = await proposeSchedule(tab, recurring(rosa.id, { service: "Tax Preparation", autoSend: true, offeredMethods: ["SQUARE_INVOICE"] }));
    await runBillingSchedules(next);
    await runBillingSchedules(next);
    const made = await invoicesOf(s.id);
    expect(made).toHaveLength(2);
    expect(made.every((m) => m.invoice!.state === "ISSUED" && !!m.invoice!.squareInvoiceId)).toBe(true);
    // Reused the existing customer (no new or duplicate customer), one Square invoice per cycle, no subscriptions.
    expect(made.every((m) => m.invoice!.squareCustomerId === "CUSTBOOKS0001")).toBe(true);
    expect(sq.count("POST", "/v2/customers")).toBe(0);
    expect(sq.count("POST", "/v2/invoices")).toBe(2);
    expect(sq.calls.some((c) => /subscription/i.test(c.path))).toBe(false);
    expect(sq.calls.filter((c) => c.method !== "GET" && !/^\/v2\/(orders|invoices)(\/[^/]+\/publish)?$/.test(c.path) && !c.path.startsWith("/resend"))).toEqual([]);
    // The series, its links and the not-in-Square tracker are exactly as they were.
    expect(await prisma.squareBillingArrangement.findUniqueOrThrow({ where: { id: arr.id } })).toEqual(before.arr);
    expect(await prisma.squareBillingMember.findMany()).toEqual(before.members);
    expect(await prisma.bookkeepingBilling.findMany()).toEqual(before.billing);
    expect(await prisma.manualBillingPayment.count()).toBe(before.manual);
    expect(await prisma.squareSeriesReview.count()).toBe(before.reviews);
  });

  it("the billing dashboard counts each invoice in exactly one section", async () => {
    const { tab, rosa } = await office();
    const one = await createFirmInvoice(tab, { clientId: rosa.id, service: "Tax Preparation", amountCents: 40000, description: "2025 return", issueDate: today, dueDate: next, offeredMethods: ["ZELLE"] });
    await approveAndSend(tab, one.id);
    const rec = await proposeSchedule(tab, recurring(rosa.id));
    const [cycle] = await invoicesOf(rec.id);
    await approveAndSend(tab, cycle.invoiceId!);
    await proposeSchedule(tab, { clientId: rosa.id, kind: "INSTALLMENTS", service: "Business Formation", description: "LLC", amountCents: 0, totalCents: 90000, installments: 3, startDate: today, offeredMethods: ["ZELLE"] });
    const d = await billingDashboard(tab);
    expect(d.tax).toMatchObject({ count: 1, invoicedCents: 40000, outstandingCents: 40000 });
    expect(d.recurring.totals).toMatchObject({ count: 1, invoicedCents: 15000, outstandingCents: 15000, monthlyCents: 15000 });
    expect(d.plans.totals).toMatchObject({ count: 1, totalCents: 90000, paidCents: 0, remainingCents: 90000 });
    expect(d.scheduledInvoices).toBe(2);
  });
});
