import { beforeEach, describe, expect, it } from "vitest";
import { makeUser, managed, prisma, resetDb } from "./db";
import { createClient } from "@/lib/services/clients";
import { addAccount, setupLedger } from "@/lib/services/ledger";
import { businessOverview } from "@/lib/services/business-overview";
import { addBusinessTax, addSuggestedTaxes, businessTaxesView, nextPeriod, periodsDue, recordTaxFiling, removeBusinessTax, undoTaxFiling, updateBusinessTax } from "@/lib/services/business-taxes";

// Fictional businesses, cities and figures only.
beforeEach(async () => {
  await resetDb();
});

async function pub() {
  const tabitha = await makeUser("ADMIN", "Tabitha");
  const c = await createClient(tabitha, { businessName: "Pretend Riverside Pub LLC", clientType: "BUSINESS", status: "ACTIVE" });
  await managed(c.id);
  await prisma.client.update({ where: { id: c.id }, data: { entityType: "S_CORP" } });
  await prisma.bookkeepingProfile.update({ where: { clientId: c.id }, data: { payroll: true, businessCity: "Birmingham", businessState: "AL" } });
  await setupLedger(tabitha, c.id, { basis: "CASH" });
  await addAccount(tabitha, c.id, { code: "2200", name: "Sales Tax Payable", type: "LIABILITY" });
  await addAccount(tabitha, c.id, { code: "4100", name: "Beer & Wine Sales", type: "INCOME" });
  return { tabitha, c };
}

describe("due dates", () => {
  it("follows each schedule: monthly the 20th, quarterly the last day after the quarter, yearly returns for the year before", () => {
    const monthly = { frequency: "MONTHLY", dueDay: 20, dueMonth: null, coversPriorYear: true };
    expect(nextPeriod(monthly, "2026-11-12")).toEqual({ period: "2026-10", label: "Oct 2026", dueDate: "2026-11-20" });
    expect(nextPeriod(monthly, "2026-11-21")).toMatchObject({ period: "2026-11", dueDate: "2026-12-20" });
    expect(nextPeriod(monthly, "2026-12-21")).toMatchObject({ period: "2026-12", dueDate: "2027-01-20" });
    const q = { frequency: "QUARTERLY", dueDay: 31, dueMonth: null, coversPriorYear: true };
    expect(nextPeriod(q, "2026-11-12")).toMatchObject({ period: "2026-Q4", dueDate: "2027-01-31" });
    expect(periodsDue(q, "2026-01-01", "2026-12-31").map((p) => `${p.period} ${p.dueDate}`)).toEqual(["2025-Q4 2026-01-31", "2026-Q1 2026-04-30", "2026-Q2 2026-07-31", "2026-Q3 2026-10-31"]);
    const bpt = { frequency: "ANNUAL", dueDay: 15, dueMonth: 3, coversPriorYear: true };
    expect(nextPeriod(bpt, "2026-11-12")).toEqual({ period: "2026", label: "2026 tax year", dueDate: "2027-03-15" });
    const renewal = { frequency: "ANNUAL", dueDay: 30, dueMonth: 9, coversPriorYear: false };
    expect(nextPeriod(renewal, "2026-11-12")).toMatchObject({ period: "2027", dueDate: "2027-09-30" });
    const feb = { frequency: "MONTHLY", dueDay: 31, dueMonth: null, coversPriorYear: true };
    expect(nextPeriod(feb, "2027-02-01")).toMatchObject({ period: "2027-01", dueDate: "2027-02-28" });
  });
});

describe("Business Taxes & Licenses", () => {
  it("suggests what this business owes from its entity, payroll, city and books, and adds them (licenses to the license list)", async () => {
    const { tabitha, c } = await pub();
    const v = await businessTaxesView(tabitha, c.id, "2026-11-12");
    const keys = v.suggestions.map((s) => s.key);
    expect(keys).toEqual(expect.arrayContaining(["STATE_SALES", "LOCAL_SALES", "LIQUOR_TAX", "ABC_LICENSE", "CITY_LICENSE", "COUNTY_LICENSE", "BPT", "INCOME_TAX", "FED_941", "FED_940", "W2_W3", "AL_WITHHOLDING", "AL_UNEMPLOYMENT", "OCCUPATIONAL_TAX", "PROPERTY_TAX"]));
    expect(keys).not.toContain("LODGING_TAX");
    expect(keys).not.toContain("TOBACCO_TAX");

    await addSuggestedTaxes(tabitha, c.id, ["STATE_SALES", "BPT", "FED_941", "ABC_LICENSE"], "2026-11-12");
    const items = await prisma.businessTaxObligation.findMany({ where: { clientId: c.id }, orderBy: { kind: "asc" } });
    expect(items.map((o) => [o.kind, o.frequency, o.dueDay, o.dueMonth])).toEqual([["BPT", "ANNUAL", 15, 3], ["FED_941", "QUARTERLY", 31, null], ["STATE_SALES", "MONTHLY", 20, null]]);
    const lic = await prisma.businessLicense.findMany({ where: { clientId: c.id } });
    expect(lic.map((l) => [l.name, l.renewalDate?.toISOString().slice(0, 10)])).toEqual([["ABC Board alcohol license", "2027-09-30"]]);

    const after = await businessTaxesView(tabitha, c.id, "2026-11-12");
    expect(after.suggestions.map((s) => s.key)).not.toEqual(expect.arrayContaining(["STATE_SALES"]));
    expect(after.suggestions.map((s) => s.key)).not.toContain("ABC_LICENSE");
    expect(after.rows.find((r) => r.kind === "STATE_SALES")).toMatchObject({ next: { period: "2026-10", dueDate: "2026-11-20" }, overdue: [] });
    expect(after.totals).toMatchObject({ items: 4, overdue: 0, dueIn30: 1 });
  });

  it("a C corporation's Business Privilege Tax is due April 15; written-in items use the schedule given", async () => {
    const { tabitha, c } = await pub();
    await prisma.client.update({ where: { id: c.id }, data: { entityType: "C_CORP" } });
    await addBusinessTax(tabitha, c.id, { kind: "BPT" }, "2026-11-12");
    expect(await prisma.businessTaxObligation.findFirst({ where: { clientId: c.id, kind: "BPT" } })).toMatchObject({ dueMonth: 4, dueDay: 15 });
    await addBusinessTax(tabitha, c.id, { name: "Pretend County seasonal fee", agency: "Pretend County", frequency: "SEMIANNUAL", dueDay: "10" }, "2026-11-12");
    const v = await businessTaxesView(tabitha, c.id, "2026-11-12");
    expect(v.rows.find((r) => r.kind === "OTHER")).toMatchObject({ name: "Pretend County seasonal fee", next: { period: "2026-H2", dueDate: "2027-01-10" } });
    await expect(addBusinessTax(tabitha, c.id, { name: "Bad", frequency: "ANNUAL", dueDay: "15" })).rejects.toThrow(/month/);
    await expect(addBusinessTax(tabitha, c.id, { name: "Bad", frequency: "WEEKLY", dueDay: "15" })).rejects.toThrow(/how often/);
  });

  it("shows periods past due since tracking began, clears them when marked filed with what was paid, and undo brings them back", async () => {
    const { tabitha, c } = await pub();
    const r = await addBusinessTax(tabitha, c.id, { kind: "STATE_SALES", accountNumber: "S-0000-TEST", trackFrom: "2026-09-01" }, "2026-11-12");
    let v = await businessTaxesView(tabitha, c.id, "2026-11-12");
    let row = v.rows[0];
    expect(row.overdue.map((p) => p.period)).toEqual(["2026-08", "2026-09"]);
    expect(row.next).toMatchObject({ period: "2026-10", dueDate: "2026-11-20" });
    expect(v.totals.overdue).toBe(2);

    await recordTaxFiling(tabitha, r.id, { period: "2026-08", amount: "1,234.56", confirmation: "CONF-1", filedOn: "2026-09-18" }, "2026-11-12");
    await recordTaxFiling(tabitha, r.id, { period: "2026-09", status: "NOT_REQUIRED" }, "2026-11-12");
    await recordTaxFiling(tabitha, r.id, { period: "2026-10", amount: "100" }, "2026-11-12");
    v = await businessTaxesView(tabitha, c.id, "2026-11-12");
    row = v.rows[0];
    expect(row.overdue).toEqual([]);
    expect(row.next).toMatchObject({ period: "2026-11", dueDate: "2026-12-20" });
    expect(row.paidThisYear).toBe(123456 + 10000);
    expect(row.history.map((h) => [h.period, h.status, h.amountCents])).toEqual([["2026-10", "FILED", 10000], ["2026-09", "NOT_REQUIRED", null], ["2026-08", "FILED", 123456]]);
    await expect(recordTaxFiling(tabitha, r.id, { period: "2026-13" })).rejects.toThrow(/period/);
    await expect(recordTaxFiling(tabitha, r.id, { period: "2026-07", amount: "12.345" })).rejects.toThrow(/amount/);

    await undoTaxFiling(tabitha, row.history[2].id);
    v = await businessTaxesView(tabitha, c.id, "2026-11-12");
    expect(v.rows[0].overdue.map((p) => p.period)).toEqual(["2026-08"]);

    await updateBusinessTax(tabitha, r.id, { frequency: "QUARTERLY", dueDay: "20" });
    v = await businessTaxesView(tabitha, c.id, "2026-11-12");
    expect(v.rows[0]).toMatchObject({ frequency: "QUARTERLY", next: { period: "2026-Q4", dueDate: "2027-01-20" } });
    expect(await prisma.auditLog.count({ where: { clientId: c.id, action: { startsWith: "business_tax." } } })).toBe(6);
  });

  it("puts upcoming and past-due items on the client overview; removing keeps the history", async () => {
    const { tabitha, c } = await pub();
    const today = new Date().toLocaleDateString("en-CA", { timeZone: "America/Chicago" });
    const r = await addBusinessTax(tabitha, c.id, { kind: "STATE_SALES" }, today);
    const o = await businessOverview(tabitha, c.id);
    expect(o.deadlines.some((d: { title: string }) => d.title.startsWith("State sales tax — "))).toBe(true);
    await removeBusinessTax(tabitha, r.id);
    expect((await businessOverview(tabitha, c.id)).deadlines.some((d: { title: string }) => d.title.startsWith("State sales tax"))).toBe(false);
    expect(await prisma.businessTaxObligation.count({ where: { clientId: c.id } })).toBe(1);
    expect((await businessTaxesView(tabitha, c.id)).rows).toEqual([]);
  });

  it("only staff who may work in this client's books see or change its taxes", async () => {
    const { tabitha, c } = await pub();
    const r = await addBusinessTax(tabitha, c.id, { kind: "STATE_SALES" }, "2026-11-12");
    const staff = await makeUser("STAFF", "Drew Example");
    await expect(businessTaxesView(staff, c.id)).rejects.toThrow();
    await expect(addBusinessTax(staff, c.id, { kind: "BPT" })).rejects.toThrow();
    await expect(recordTaxFiling(staff, r.id, { period: "2026-10" })).rejects.toThrow();
    await expect(removeBusinessTax(staff, r.id)).rejects.toThrow();
    await prisma.client.update({ where: { id: c.id }, data: { assignedToId: staff.id } });
    expect((await businessTaxesView(staff, c.id, "2026-11-12")).rows).toHaveLength(1);
  });
});
