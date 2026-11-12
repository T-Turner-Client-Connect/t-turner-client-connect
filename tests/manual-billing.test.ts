import { beforeEach, describe, expect, it } from "vitest";
import { makeUser, prisma, resetDb } from "./db";
import { ForbiddenError } from "@/lib/auth/actor";
import { createClient } from "@/lib/services/clients";
import { saveProfile } from "@/lib/services/bookkeeping-clients";
import { saveBilling } from "@/lib/services/bookkeeping-profile";
import { acceptPortalInvite, invitePortalUser } from "@/lib/services/portal-accounts";
import { businessDashboardFor } from "@/lib/services/portal-business";
import { manualBillingView, manualLedger, markMonthsPaid, nonSquareRecurring, portalManualBilling, recordManualPayment, voidManualPayment } from "@/lib/services/manual-billing";

// Fictional office-billed client ($350 monthly, due on the 5th).
const TODAY = new Date().toLocaleDateString("en-CA", { timeZone: "America/Chicago" });
const month = (n: number) => {
  const [y, m] = TODAY.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1 + n, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
};

beforeEach(async () => {
  await resetDb();
});

async function setup() {
  const tabitha = await makeUser("ADMIN", "Tabitha");
  await prisma.ownerAccess.create({ data: { userId: tabitha.id, isPrimary: true } });
  const daria = await makeUser("STAFF", "Daria");
  const rich = await createClient(tabitha, { businessName: "Rich Example LLC (fictional)", clientType: "BUSINESS", status: "ACTIVE" });
  await saveProfile(tabitha, rich.id, { active: true, frequency: "MONTHLY", payroll: false });
  await saveBilling(tabitha, rich.id, { monthlyFee: "350", billingDay: 5, billingStartDate: new Date(`${month(-2)}-01T12:00:00Z`) });
  return { tabitha, daria, rich };
}

describe("office-managed billing ledger", () => {
  it("works out status, balance and the next payment only from recorded payments", () => {
    const base = { feeCents: 35000, billingDay: 5, startDate: new Date(`${month(-2)}-01T12:00:00Z`), today: `${month(0)}-20` };
    const none = manualLedger({ ...base, payments: [] })!;
    expect(none.overdueCount).toBe(3); // three due dates passed, nothing recorded
    expect(none.overdueCents).toBe(105000);
    expect(none.status).toEqual({ label: "3 months past due", tone: "red" });
    expect(none.next).toMatchObject({ due: `${month(1)}-05`, amountCents: 35000 });
    expect(none.defaultPeriod).toBe(month(-2)); // a new payment applies to the oldest month owed
    const paid = manualLedger({ ...base, payments: [month(-2), month(-1), month(0)].map((m) => ({ amountCents: 35000, periodMonth: m })) })!;
    expect(paid.status).toEqual({ label: "Paid — up to date", tone: "green" });
    const partial = manualLedger({ ...base, payments: [month(-2), month(-1)].map((m) => ({ amountCents: 35000, periodMonth: m })).concat({ amountCents: 20000, periodMonth: month(0) }) })!;
    expect(partial).toMatchObject({ overdueCount: 1, overdueCents: 15000 });
    expect(manualLedger({ ...base, feeCents: null, payments: [] })).toBeNull(); // no fee set: nothing is guessed
  });

  it("lets the office record any month in the last two years; months before billing start never show as past due", () => {
    const base = { feeCents: 35000, billingDay: 1, startDate: new Date(`${month(0)}-01T12:00:00Z`), today: `${month(0)}-20` };
    // A payment for a month well before billing started (e.g. one first paid through Square).
    const l = manualLedger({ ...base, payments: [{ amountCents: 35000, periodMonth: month(-9) }, { amountCents: 35000, periodMonth: month(0) }] })!;
    expect(l.overdueCount).toBe(0);
    expect(l.status).toEqual({ label: "Paid — up to date", tone: "green" });
    expect(l.monthChoices).toHaveLength(26);
    expect(l.monthChoices[0].month).toBe(month(2));
    expect(l.monthChoices.at(-1)!.month).toBe(month(-23));
    expect(l.monthChoices.find((c) => c.month === month(-9))!.state).toBe("BEFORE_START");
    expect(l.monthChoices.find((c) => c.month === month(0))!.state).toBe("PAID");
  });
});

describe("recording payments", () => {
  it("billing staff record payments; mistakes are voided by Tabitha with a reason and kept", async () => {
    const { tabitha, daria, rich } = await setup();
    await expect(recordManualPayment(daria, rich.id, { amount: "350", paidOn: TODAY, periodMonth: month(0), method: "CHECK" })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(recordManualPayment(tabitha, rich.id, { amount: "350", paidOn: "2999-01-01", periodMonth: month(0), method: "CHECK" })).rejects.toThrow(/future/);
    await expect(recordManualPayment(tabitha, rich.id, { amount: "0", paidOn: TODAY, periodMonth: month(0), method: "CHECK" })).rejects.toThrow(/amount/);
    await expect(recordManualPayment(tabitha, rich.id, { amount: "350", paidOn: TODAY, periodMonth: month(0), method: "CHECK", reference: "1", note: "card 4111 1111 1111 1111" })).rejects.toThrow(/Card numbers/);
    await expect(recordManualPayment(tabitha, rich.id, { amount: "350", paidOn: TODAY, periodMonth: month(-2), method: "CHECK" })).rejects.toThrow(/check number/);
    const p = await recordManualPayment(tabitha, rich.id, { amount: "$350.00", paidOn: TODAY, periodMonth: month(-2), method: "CHECK", reference: "1042" });
    // A payment first made through Square can be entered by the office too.
    const sq = await recordManualPayment(tabitha, rich.id, { amount: "350", paidOn: TODAY, periodMonth: month(-12), method: "SQUARE", reference: "Square invoice 000123" });
    expect(sq).toMatchObject({ method: "SQUARE", periodMonth: month(-12) });
    await voidManualPayment(tabitha, sq.id, "Test entry for this check only");
    expect(p).toMatchObject({ amountCents: 35000, periodMonth: month(-2), method: "CHECK", reference: "1042" });
    let v = await manualBillingView(tabitha, rich.id);
    expect(v.ledger!.overdueCount).toBe(TODAY.slice(8) > "05" ? 2 : 1);
    await expect(voidManualPayment(daria, p.id, "Entered twice by mistake")).rejects.toBeInstanceOf(ForbiddenError);
    await expect(voidManualPayment(tabitha, p.id, "no")).rejects.toThrow(/Record why/);
    await voidManualPayment(tabitha, p.id, "Entered on the wrong client");
    v = await manualBillingView(tabitha, rich.id);
    expect(v.payments).toHaveLength(2); // kept, marked voided
    expect(v.payments.find((x) => x.id === p.id)).toMatchObject({ voidReason: "Entered on the wrong client" });
    expect(v.live).toHaveLength(0);
    expect(await prisma.auditLog.count({ where: { clientId: rich.id, action: { in: ["billing.manual_payment_recorded", "billing.manual_payment_voided"] } } })).toBe(4);
  });

  it("isn't used for clients billed through Square", async () => {
    const { tabitha, rich } = await setup();
    await prisma.bookkeepingProfile.update({ where: { clientId: rich.id }, data: { squareBillingExpected: true } });
    await expect(recordManualPayment(tabitha, rich.id, { amount: "350", paidOn: TODAY, periodMonth: month(0), method: "CASH" })).rejects.toThrow(/billed through Square/);
  });
});

describe("the client's view", () => {
  it("shows their own recorded payments only; another client's login is refused", async () => {
    const { tabitha, rich } = await setup();
    await recordManualPayment(tabitha, rich.id, { amount: "350", paidOn: TODAY, periodMonth: month(-2), method: "ZELLE" });
    const { token } = await invitePortalUser(tabitha, rich.id, { email: "christy@fictional.example", name: "Christy", role: "OWNER" });
    const owner = await acceptPortalInvite(token!, "Portal-Pass-123456");
    const v = (await portalManualBilling({ id: owner.id, name: owner.name, email: owner.email }, rich.id))!;
    expect(v).toMatchObject({ feeCents: 35000, billingDay: 5 });
    expect(v.payments).toEqual([expect.objectContaining({ amountCents: 35000, method: "Zelle", periodMonth: month(-2) })]);
    const other = await createClient(tabitha, { businessName: "Unrelated (fictional)", clientType: "BUSINESS", status: "ACTIVE" });
    const { token: t2 } = await invitePortalUser(tabitha, other.id, { email: "x@fictional.example", name: "X", role: "OWNER" });
    const x = await acceptPortalInvite(t2!, "Portal-Pass-123456");
    await expect(portalManualBilling({ id: x.id, name: x.name, email: x.email }, rich.id)).rejects.toThrow();
  });
});

describe("marking several months paid at once", () => {
  it("records one payment per month, skips months already paid, and makes the client current", async () => {
    const { tabitha, daria, rich } = await setup();
    const months = [month(-2), month(-1), month(0)];
    await recordManualPayment(tabitha, rich.id, { amount: "350", paidOn: TODAY, periodMonth: month(-1), method: "ZELLE" });
    await expect(markMonthsPaid(daria, rich.id, { months, amountEach: "350", method: "CASH_APP", dateMode: "DUE_DATE" })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(markMonthsPaid(tabitha, rich.id, { months, amountEach: "350", method: "CHECK", dateMode: "DUE_DATE" })).rejects.toThrow(/check number/);
    const r = await markMonthsPaid(tabitha, rich.id, { months, amountEach: "350", method: "CASH_APP", dateMode: "DUE_DATE" });
    expect(r).toEqual({ recorded: [month(-2), month(0)], skipped: [month(-1)], partial: [] });
    const v = await manualBillingView(tabitha, rich.id);
    expect(v.live.filter((p) => p.method === "CASH_APP")).toHaveLength(2);
    expect(v.live.find((p) => p.periodMonth === month(-2))!.note).toMatch(/due date/);
    expect(v.ledger!.overdueCount).toBe(0);
    expect(v.ledger!.status.tone).toBe("green");
    expect(v.paidMonths.sort()).toEqual(months);
    // Earlier years can be marked too (e.g. "paid in full for 2025").
    const lastYear = Array.from({ length: 12 }, (_, i) => `${Number(TODAY.slice(0, 4)) - 1}-${String(i + 1).padStart(2, "0")}`);
    const y = await markMonthsPaid(tabitha, rich.id, { months: lastYear, amountEach: "350", method: "CASH", dateMode: "DUE_DATE" });
    expect(y.recorded.length + y.skipped.length).toBe(12);
    expect((await manualBillingView(tabitha, rich.id)).ledger!.overdueCount).toBe(0);
  });
});

describe("Mark Months Paid safety", () => {
  it("never tops up a partly paid month, never enters a month twice — even when two saves run at once", async () => {
    const { tabitha, rich } = await setup();
    // Partly paid: $200 of $350 received for one month.
    await recordManualPayment(tabitha, rich.id, { amount: "200", paidOn: TODAY, periodMonth: month(-2), method: "CASH" });
    const months = [month(-2), month(-1), month(0)];
    const r = await markMonthsPaid(tabitha, rich.id, { months, amountEach: "350", method: "CASH_APP", dateMode: "DUE_DATE" });
    expect(r).toEqual({ recorded: [month(-1), month(0)], skipped: [], partial: [month(-2)] });
    let v = await manualBillingView(tabitha, rich.id);
    expect(v.live.filter((p) => p.periodMonth === month(-2)).map((p) => p.amountCents)).toEqual([20000]); // untouched
    expect(v.partialMonths).toEqual([month(-2)]);
    expect(v.ledger!.periods.find((p) => p.month === month(-2))!.owedCents).toBe(15000);

    // Two people (or a double click) marking the same new months at the same moment.
    const later = [month(1), month(2)];
    const [a, b] = await Promise.all([
      markMonthsPaid(tabitha, rich.id, { months: later, amountEach: "350", method: "CASH_APP", dateMode: "ONE_DATE", paidOn: TODAY }),
      markMonthsPaid(tabitha, rich.id, { months: later, amountEach: "350", method: "CASH_APP", dateMode: "ONE_DATE", paidOn: TODAY }),
    ]);
    expect([...a.recorded, ...b.recorded].sort()).toEqual(later);
    expect([...a.skipped, ...b.skipped].sort()).toEqual(later);
    v = await manualBillingView(tabitha, rich.id);
    for (const m of later) expect(v.live.filter((p) => p.periodMonth === m)).toHaveLength(1);

    // Every payment written is in the audit log (bulk entries marked as such).
    const logs = await prisma.auditLog.findMany({ where: { clientId: rich.id, action: "billing.manual_payment_recorded" } });
    expect(logs).toHaveLength(v.live.length);
    expect(logs.filter((l) => (l.details as { via?: string }).via === "bulk")).toHaveLength(4);
  });

  it("all or nothing: one invalid month means nothing is recorded", async () => {
    const { tabitha, rich } = await setup();
    await expect(markMonthsPaid(tabitha, rich.id, { months: [month(-1), month(0)], amountEach: "350", method: "CASH", dateMode: "ONE_DATE", paidOn: "2999-01-01" })).rejects.toThrow(/future/);
    expect(await prisma.manualBillingPayment.count({ where: { clientId: rich.id } })).toBe(0);
  });

  it("the same single payment saved twice in a row is refused", async () => {
    const { tabitha, rich } = await setup();
    const input = { amount: "350", paidOn: TODAY, periodMonth: month(0), method: "CHECK", reference: "2001" };
    await recordManualPayment(tabitha, rich.id, input);
    await expect(recordManualPayment(tabitha, rich.id, input)).rejects.toThrow(/just recorded/);
    expect(await prisma.manualBillingPayment.count({ where: { clientId: rich.id } })).toBe(1);
  });
});

describe("Owner's Office shows the same balance as the client's billing page and portal", () => {
  it("shows the whole balance past due (every unpaid month, not only this month) and updates when a payment is recorded", async () => {
    const { tabitha } = await setup();
    // Fictional: $795 a month due on the 1st since ten months ago, nothing paid yet.
    const realty = await createClient(tabitha, { businessName: "Maple Example Realty (fictional)", clientType: "BUSINESS", status: "ACTIVE" });
    await saveProfile(tabitha, realty.id, { active: true, frequency: "MONTHLY", payroll: false });
    await saveBilling(tabitha, realty.id, { monthlyFee: "795", billingDay: 1, billingStartDate: new Date(`${month(-10)}-01T12:00:00Z`) });
    const { token } = await invitePortalUser(tabitha, realty.id, { email: "owner@maple.fictional.example", name: "Owner", role: "OWNER" });
    const owner = await acceptPortalInvite(token!, "Portal-Pass-123456");
    const portal = () => portalManualBilling({ id: owner.id, name: owner.name, email: owner.email }, realty.id);
    const row = async () => (await nonSquareRecurring(tabitha)).rows.find((r) => r.clientId === realty.id)!;

    const staff = await manualBillingView(tabitha, realty.id);
    const owed = staff.ledger!.overdueCents;
    expect(owed).toBeGreaterThanOrEqual(10 * 79500);
    expect((await row()).overdueCents).toBe(owed);
    expect((await portal())!.overdueCents).toBe(owed);
    expect((await row()).next).toEqual(staff.ledger!.next);

    // A payment recorded on the client's billing page lowers all three by the same amount.
    await recordManualPayment(tabitha, realty.id, { amount: "795", paidOn: TODAY, periodMonth: month(-10), method: "CHECK", reference: "1042" });
    expect((await row()).overdueCents).toBe(owed - 79500);
    expect((await portal())!.overdueCents).toBe(owed - 79500);
    const totals = (await nonSquareRecurring(tabitha)).totals;
    expect(totals.overdueCents).toBe((await nonSquareRecurring(tabitha)).rows.reduce((n, r) => n + r.overdueCents, 0));
  });
});

describe("the client's home page My Account card", () => {
  it("shows the monthly billing kept outside Square: past due, never 'all set'", async () => {
    const { tabitha, rich } = await setup();
    await prisma.client.update({ where: { id: rich.id }, data: { businessAccess: "ACTIVE" } });
    const perms = { canViewBilling: true, canUpload: true, canMessage: true };
    const behind = (await businessDashboardFor(rich.id, null, perms, null)).account!;
    // Three months owed at $350 (billing started two months ago; this month's due date passed or not, at least two are past due).
    expect(behind.balanceCents).toBeGreaterThanOrEqual(70000);
    expect(behind.plan).toMatchObject({ title: "Monthly bookkeeping", amountCents: 35000, status: { tone: "red", label: expect.stringMatching(/past due/) } });
    expect(behind.openCount).toBeGreaterThanOrEqual(1);
    // Paid up: the card says so.
    await markMonthsPaid(tabitha, rich.id, { months: [month(-2), month(-1), month(0), month(1)], amountEach: "350", method: "CASH", dateMode: "DUE_DATE" });
    const upToDate = (await businessDashboardFor(rich.id, null, perms, null)).account!;
    expect(upToDate.balanceCents).toBe(0);
    expect(upToDate.plan?.status.tone).not.toBe("red");
  });
});
