import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeUser, managed, prisma, resetDb } from "./db";
import { createClient } from "@/lib/services/clients";
import { saveProfile } from "@/lib/services/bookkeeping-clients";
import { postJournalEntry, setupLedger } from "@/lib/services/ledger";
import { monthsReadyForStatements, runAutomaticStatements } from "@/lib/services/coetha-statements";

// Fictional business and figures only.
beforeEach(async () => {
  await resetDb();
  vi.stubEnv("MALWARE_SCAN_URL", "https://scanner.test/scan");
  vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ clean: true }), { status: 200 }));
});

async function cafe() {
  const tabitha = await makeUser("ADMIN", "Tabitha");
  await prisma.ownerAccess.create({ data: { userId: tabitha.id, isPrimary: true } });
  const biz = await createClient(tabitha, { businessName: "Pretend Harbor Cafe LLC", clientType: "BUSINESS", status: "ACTIVE" });
  await managed(biz.id);
  await saveProfile(tabitha, biz.id, { active: true, frequency: "MONTHLY", payroll: false });
  await setupLedger(tabitha, biz.id, { basis: "CASH" });
  const bank = (await prisma.ledgerAccount.findFirstOrThrow({ where: { clientId: biz.id, type: "ASSET", subtype: "BANK" } })).id;
  const income = (await prisma.ledgerAccount.findFirstOrThrow({ where: { clientId: biz.id, type: "INCOME", OR: [{ subtype: null }, { subtype: { notIn: ["OTHER_INCOME"] } }] } })).id;
  const sale = (date: string, amt: string) => postJournalEntry(tabitha, biz.id, { date, memo: "Fictional sales", lines: [{ accountId: bank, debit: amt }, { accountId: income, credit: amt }] });
  return { tabitha, biz, bank, sale };
}

const packets = (clientId: string) => prisma.document.findMany({ where: { clientId, reportType: "FINANCIAL_PACKET" }, orderBy: { createdAt: "asc" }, select: { month: true, version: true, supersededAt: true, visibility: true } });

describe("statements build themselves each month", () => {
  it("builds the month's drafts once it has ended with entries and nothing left to categorize; again only when the books change", async () => {
    const { tabitha, biz, bank, sale } = await cafe();
    await sale("2026-09-10", "500.00");
    await sale("2026-10-15", "1500.00");
    await sale("2026-11-03", "50.00");
    // October has a bank row still waiting to be categorized: not ready yet. November isn't over.
    await prisma.bankTransaction.create({ data: { clientId: biz.id, accountId: bank, date: new Date("2026-10-28T00:00:00Z"), description: "FICTIONAL DEPOSIT", amountCents: 1000, status: "UNREVIEWED", fingerprint: "fictional-t1" } });
    expect(await monthsReadyForStatements(biz.id, "2026-11-12")).toEqual(["2026-09"]);

    const r1 = await runAutomaticStatements({ today: "2026-11-12" });
    expect(r1.built).toEqual([{ clientId: biz.id, month: "2026-09" }]);
    expect((await packets(biz.id)).map((p) => [p.month, p.version, p.visibility])).toEqual([[9, 1, "STAFF_ONLY"]]);
    expect(await prisma.document.count({ where: { clientId: biz.id, reportType: { in: ["PROFIT_AND_LOSS", "BALANCE_SHEET"] }, month: 9 } })).toBe(2);

    // Nothing changed: nothing is built again.
    expect((await runAutomaticStatements({ today: "2026-11-12" })).built).toEqual([]);

    // The October row is categorized: October builds. A later correction dated in September rebuilds
    // September and October (the October Balance Sheet carries it).
    await prisma.bankTransaction.updateMany({ where: { clientId: biz.id }, data: { status: "EXCLUDED" } });
    expect((await runAutomaticStatements({ today: "2026-11-12" })).built.map((b) => b.month)).toEqual(["2026-10"]);
    await new Promise((res) => setTimeout(res, 20));
    await sale("2026-09-30", "25.00");
    expect((await runAutomaticStatements({ today: "2026-11-12" })).built.map((b) => b.month)).toEqual(["2026-09", "2026-10"]);
    expect((await packets(biz.id)).filter((p) => !p.supersededAt).map((p) => [p.month, p.version])).toEqual([[9, 2], [10, 2]]);
    expect(await prisma.auditLog.count({ where: { action: "statements.auto_prepared", clientId: biz.id } })).toBe(4);
    void tabitha;
  });

  it("leaves alone months Tabitha marked complete and packets she approved or released", async () => {
    const { biz, sale } = await cafe();
    await sale("2026-08-10", "500.00");
    await sale("2026-09-10", "500.00");
    await prisma.bookkeepingPeriod.upsert({ where: { clientId_year_month: { clientId: biz.id, year: 2026, month: 8 } }, create: { clientId: biz.id, year: 2026, month: 8, status: "COMPLETE" }, update: { status: "COMPLETE" } });
    expect((await runAutomaticStatements({ today: "2026-10-05" })).built.map((b) => b.month)).toEqual(["2026-09"]);
    await prisma.document.updateMany({ where: { clientId: biz.id, reportType: "FINANCIAL_PACKET", month: 9 }, data: { reviewStatus: "APPROVED" } });
    await new Promise((res) => setTimeout(res, 20));
    await sale("2026-09-20", "10.00");
    expect(await monthsReadyForStatements(biz.id, "2026-10-05")).toEqual([]);
  });

  it("does nothing without an owner, for inactive clients, or for quarterly clients' non-quarter months", async () => {
    const { tabitha, biz, sale } = await cafe();
    await sale("2026-08-10", "500.00");
    await sale("2026-09-10", "500.00");
    expect((await runAutomaticStatements({ today: "2026-10-05", owner: null })).built).toEqual([]);
    await saveProfile(tabitha, biz.id, { active: true, frequency: "QUARTERLY", payroll: false });
    expect(await monthsReadyForStatements(biz.id, "2026-10-05")).toEqual(["2026-09"]);
    await prisma.bookkeepingProfile.update({ where: { clientId: biz.id }, data: { active: false } });
    expect(await monthsReadyForStatements(biz.id, "2026-10-05")).toEqual([]);
  });
});
