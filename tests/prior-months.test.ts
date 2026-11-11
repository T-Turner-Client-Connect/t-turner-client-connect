import { beforeEach, describe, expect, it } from "vitest";
import { makeUser, managed, prisma, resetDb } from "./db";
import { createClient } from "@/lib/services/clients";
import { saveProfile } from "@/lib/services/bookkeeping-clients";
import { postJournalEntry, setupLedger } from "@/lib/services/ledger";
import { markMonthsCompletePrior, monthlyChecklist } from "@/lib/services/monthly-workflow";
import { closeClientRequest, createClientRequest } from "@/lib/services/client-requests";

// Fictional business only.
beforeEach(async () => {
  await resetDb();
});

describe("Months finished before Client Connect, and closing requests", () => {
  it("Tabitha marks prior months complete (only her); staff close a request as received or not needed", async () => {
    const tabitha = await makeUser("ADMIN", "Tabitha");
    await prisma.ownerAccess.create({ data: { userId: tabitha.id, isPrimary: true } });
    const staff = await makeUser("STAFF", "Drew Example");
    const biz = await createClient(tabitha, { businessName: "Pretend Harbor Cafe LLC", clientType: "BUSINESS", status: "ACTIVE", assignedToId: staff.id });
    await managed(biz.id);
    await saveProfile(tabitha, biz.id, { active: true, frequency: "MONTHLY", payroll: true });
    await setupLedger(tabitha, biz.id, { basis: "CASH" });

    expect((await monthlyChecklist(biz.id, 2026, 3, { today: "2026-11-11" })).percent).toBeLessThan(100);
    await expect(markMonthsCompletePrior(staff, biz.id, "2026-01", "2026-09")).rejects.toThrow(/Only Tabitha/);
    expect(await markMonthsCompletePrior(tabitha, biz.id, "2026-01", "2026-09")).toHaveLength(9);
    for (const m of [1, 5, 9]) expect((await monthlyChecklist(biz.id, 2026, m, { today: "2026-11-11" })).percent).toBe(100);
    expect((await monthlyChecklist(biz.id, 2026, 10, { today: "2026-11-11" })).percent).toBeLessThan(100);

    const a = (await createClientRequest(tabitha, biz.id, { kind: "GENERAL", docType: "RECEIPTS", title: "Receipts and bills (fictional)" })).request!;
    const b = (await createClientRequest(tabitha, biz.id, { kind: "GENERAL", docType: "PAYROLL_REPORT", title: "Payroll reports (fictional)" })).request!;
    await closeClientRequest(staff, biz.id, a.id, "received");
    await closeClientRequest(staff, biz.id, b.id, "not_needed");
    expect((await prisma.documentRequest.findUniqueOrThrow({ where: { id: a.id } })).status).toBe("ACCEPTED");
    expect((await prisma.documentRequest.findUniqueOrThrow({ where: { id: b.id } })).status).toBe("CANCELLED");
    await expect(closeClientRequest(staff, biz.id, a.id, "not_needed")).rejects.toThrow(/already closed/);
  });

  it("payroll already entered in the books counts as received for the month", async () => {
    const tabitha = await makeUser("ADMIN", "Tabitha");
    await prisma.ownerAccess.create({ data: { userId: tabitha.id, isPrimary: true } });
    const biz = await createClient(tabitha, { businessName: "Pretend Harbor Cafe LLC", clientType: "BUSINESS", status: "ACTIVE" });
    await managed(biz.id);
    await saveProfile(tabitha, biz.id, { active: true, frequency: "MONTHLY", payroll: true, payrollProvider: "ADP" });
    await setupLedger(tabitha, biz.id, { basis: "CASH" });
    const line = async () => (await monthlyChecklist(biz.id, 2026, 5, { today: "2026-11-11" })).items.find((i) => i.key === "PAYROLL")!;
    expect((await line()).state).toBe("MISSING");
    const bank = await prisma.ledgerAccount.findFirstOrThrow({ where: { clientId: biz.id, subtype: "BANK" } });
    const exp = await prisma.ledgerAccount.findFirstOrThrow({ where: { clientId: biz.id, type: "EXPENSE", OR: [{ subtype: null }, { subtype: { notIn: ["SUSPENSE", "COGS", "OTHER_EXPENSE"] } }] } });
    await prisma.ledgerAccount.update({ where: { id: exp.id }, data: { name: "Payroll — Gross Wages (fictional)" } });
    await postJournalEntry(tabitha, biz.id, { date: "2026-05-15", memo: "Fictional payroll", lines: [{ accountId: exp.id, debit: "1000.00" }, { accountId: bank.id, credit: "1000.00" }] });
    expect(await line()).toMatchObject({ state: "DONE", pill: "Entered" });
  });
});
