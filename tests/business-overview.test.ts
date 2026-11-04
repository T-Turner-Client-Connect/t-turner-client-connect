import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeUser, managed, prisma, resetDb } from "./db";
import { createClient } from "@/lib/services/clients";
import { postJournalEntry, setupLedger } from "@/lib/services/ledger";
import { openWorkPeriod, saveProfile, setChecklistItem } from "@/lib/services/bookkeeping-clients";
import { addBusinessLicense, archiveBusinessLicense, businessOverview, nextPayDate, setPayrollPayDate, setYearEndStage } from "@/lib/services/business-overview";

beforeEach(async () => {
  await resetDb();
  vi.useRealTimers();
});

async function bakery() {
  const tabitha = await makeUser("ADMIN", "Tabitha");
  const c = await createClient(tabitha, { businessName: "Lakeside Pretend Bakery LLC", clientType: "BUSINESS", status: "ACTIVE" });
  await managed(c.id);
  await saveProfile(tabitha, c.id, { active: true, frequency: "MONTHLY", payroll: true, payrollFrequency: "BIWEEKLY", payrollProvider: "ADP" });
  return { tabitha, c };
}

describe("next pay date", () => {
  it("follows the payroll frequency from one known pay date", () => {
    expect(nextPayDate("2026-10-23", "BIWEEKLY", "2026-11-04")).toBe("2026-11-06");
    expect(nextPayDate("2026-11-06", "BIWEEKLY", "2026-11-06")).toBe("2026-11-06");
    expect(nextPayDate("2026-10-30", "WEEKLY", "2026-11-04")).toBe("2026-11-06");
    expect(nextPayDate("2026-01-01", "SEMIMONTHLY", "2026-11-04")).toBe("2026-11-15");
    expect(nextPayDate("2026-01-01", "SEMIMONTHLY", "2026-11-16")).toBe("2026-11-30");
    expect(nextPayDate("2026-01-31", "MONTHLY", "2026-11-04")).toBe("2026-11-30");
    expect(nextPayDate("2026-01-03", "MONTHLY", "2026-11-04")).toBe("2026-12-03");
    expect(nextPayDate(null, "WEEKLY", "2026-11-04")).toBeNull();
  });
});

describe("client overview", () => {
  it("builds the figures, close checklist and cards from this client's own records only", async () => {
    const { tabitha, c } = await bakery();
    const other = await createClient(tabitha, { businessName: "Other Pretend Co", clientType: "BUSINESS", status: "ACTIVE" });
    await managed(other.id);
    await setupLedger(tabitha, c.id, { basis: "CASH" });
    await setupLedger(tabitha, other.id, { basis: "CASH" });
    const acct = async (clientId: string, code: string) => (await prisma.ledgerAccount.findFirstOrThrow({ where: { clientId, code } })).id;
    const [cash, income, ads] = [await acct(c.id, "1000"), await acct(c.id, "4000"), await acct(c.id, "6000")];
    await postJournalEntry(tabitha, c.id, { date: "2026-09-10", memo: "Fictional sales", lines: [{ accountId: cash, debit: "800" }, { accountId: income, credit: "800" }] });
    await postJournalEntry(tabitha, c.id, { date: "2026-10-10", memo: "Fictional sales", lines: [{ accountId: cash, debit: "1000" }, { accountId: income, credit: "1000" }] });
    await postJournalEntry(tabitha, c.id, { date: "2026-10-12", memo: "Fictional ads", lines: [{ accountId: ads, debit: "250" }, { accountId: cash, credit: "250" }] });
    // Another business's entries never show here.
    await postJournalEntry(tabitha, other.id, { date: "2026-10-10", memo: "Other", lines: [{ accountId: await acct(other.id, "1000"), debit: "99999" }, { accountId: await acct(other.id, "4000"), credit: "99999" }] });

    const p = await openWorkPeriod(tabitha, c.id, 2026, 10);
    const items = await prisma.bookkeepingChecklistItem.findMany({ where: { periodId: p.id } });
    for (const key of ["CATEGORIZE", "RECONCILE"]) await setChecklistItem(tabitha, items.find((i) => i.key === key)!.id, "DONE");

    await setPayrollPayDate(tabitha, c.id, "2026-10-23");
    await addBusinessLicense(tabitha, c.id, { name: "Birmingham Business License", renewalDate: "2027-03-31" });
    await setYearEndStage(tabitha, c.id, 2026, "CONTRACTOR_REVIEW");
    await prisma.clientDeadline.create({ data: { clientId: c.id, title: "Birmingham Liquor Tax", dueAt: new Date("2099-11-15T00:00:00Z"), createdById: tabitha.id } });

    const o = await businessOverview(tabitha, c.id, "2026-10");
    expect(o.client).toMatchObject({ name: "Lakeside Pretend Bakery LLC", managed: true });
    expect(o.services).toEqual(["Bookkeeping", "Payroll", "Taxes", "Compliance"]);
    expect(o.ledger).toMatchObject({ income: 100000, expenses: 25000, net: 75000, bank: 155000, bankAccounts: 1 });
    expect(o.ledger!.change.income).toBe(25);
    expect(o.ledger!.perf.map((x) => x.month)).toEqual(["2026-05", "2026-06", "2026-07", "2026-08", "2026-09", "2026-10"]);
    // The close is derived from real data: manual check-offs no longer count, and nothing is
    // green without the records behind it (no bank accounts registered, no bank rows, no payroll report).
    const steps = Object.fromEntries(o.close.steps.map((s) => [s.label, s.state]));
    expect(steps).toMatchObject({ "Bank transactions synchronized": "MISSING", "Missing receipts or supporting documents": "DONE", "Payroll data received (ADP)": "MISSING", "Transactions categorized": "MISSING", "Accounts reconciled": "MISSING", "Financial statements released to client": "NOT_DUE" });
    expect(o.close.steps.map((s) => s.label).join(" ")).not.toMatch(/1099|W-2/);
    expect(o.close.percent).toBe(Math.round((1 / 8) * 100));
    expect(o.licenses).toMatchObject({ count: 1, expired: 0 });
    expect(o.yearEnd).toEqual({ taxYear: 2026, stage: "CONTRACTOR_REVIEW" });
    expect(o.filings.next?.title).toBe("Birmingham Liquor Tax");
    expect(o.payroll?.next).not.toBeNull();
  });

  it("shows no figures to staff who aren't assigned, and no billing to staff without billing access", async () => {
    const { tabitha, c } = await bakery();
    await setupLedger(tabitha, c.id, { basis: "CASH" });
    const daria = await makeUser("STAFF", "Daria");
    const o = await businessOverview(daria, c.id, "2026-10");
    expect(o.ledger).toBeNull();
    expect(o.hasBooks).toBe(true);
    expect(o.account).toBeNull();
  });

  it("a removed license is archived, not deleted", async () => {
    const { tabitha, c } = await bakery();
    const l = await addBusinessLicense(tabitha, c.id, { name: "Pretend Permit", renewalDate: "2025-01-01" });
    expect((await businessOverview(tabitha, c.id)).licenses).toMatchObject({ count: 1, expired: 1 });
    await archiveBusinessLicense(tabitha, l.id);
    expect((await businessOverview(tabitha, c.id)).licenses.count).toBe(0);
    expect(await prisma.businessLicense.count({ where: { id: l.id } })).toBe(1);
    expect(await prisma.auditLog.count({ where: { action: "business_license.removed", entityId: l.id } })).toBe(1);
  });

  it("rejects bad input", async () => {
    const { tabitha, c } = await bakery();
    await expect(addBusinessLicense(tabitha, c.id, { name: " " })).rejects.toThrow(/license name/);
    await expect(setYearEndStage(tabitha, c.id, 2026, "BOGUS")).rejects.toThrow(/status/);
    await expect(setPayrollPayDate(tabitha, c.id, "2026-13-40")).rejects.toThrow(/pay date/);
  });
});
