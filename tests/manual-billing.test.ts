import { beforeEach, describe, expect, it } from "vitest";
import { makeUser, prisma, resetDb } from "./db";
import { ForbiddenError } from "@/lib/auth/actor";
import { createClient } from "@/lib/services/clients";
import { saveProfile } from "@/lib/services/bookkeeping-clients";
import { saveBilling } from "@/lib/services/bookkeeping-profile";
import { acceptPortalInvite, invitePortalUser } from "@/lib/services/portal-accounts";
import { manualBillingView, manualLedger, portalManualBilling, recordManualPayment, voidManualPayment } from "@/lib/services/manual-billing";

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
    await expect(recordManualPayment(tabitha, rich.id, { amount: "350", paidOn: TODAY, periodMonth: month(0), method: "CHECK", note: "card 4111 1111 1111 1111" })).rejects.toThrow(/Card numbers/);
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
