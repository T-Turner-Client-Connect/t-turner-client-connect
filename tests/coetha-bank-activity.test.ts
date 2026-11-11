import { beforeEach, describe, expect, it } from "vitest";
import { makeUser, managed, prisma, resetDb } from "./db";
import { createClient } from "@/lib/services/clients";
import { setupLedger } from "@/lib/services/ledger";
import { enterStatementBalances, registerAccount } from "@/lib/services/bank-accounts";
import { addBankActivity } from "@/lib/services/coetha-bank-activity";

// Fictional business, bank and figures only.
beforeEach(async () => {
  await resetDb();
});

async function setup() {
  const tabitha = await makeUser("ADMIN", "Tabitha");
  await prisma.ownerAccess.create({ data: { userId: tabitha.id, isPrimary: true } });
  const biz = await createClient(tabitha, { businessName: "Pretend Lakeside Supply LLC", clientType: "BUSINESS", status: "ACTIVE" });
  await managed(biz.id);
  await setupLedger(tabitha, biz.id, { basis: "CASH" });
  const chk = await registerAccount(tabitha, biz.id, { institution: "Example Community Bank", accountType: "CHECKING", nickname: "Operating", last4: "4321", gl: "NEW" });
  // Last statement (October) ended at $1,000.00.
  await enterStatementBalances(tabitha, biz.id, chk.id, 2026, 10, { beginning: "900.00", ending: "1000.00" });
  return { tabitha, biz, chk };
}

const WEEK = [
  { date: "2026-11-02", description: "DEPOSIT MOBILE", amount: 500 },
  { date: "2026-11-03", description: "OFFICE SUPPLY STORE", amount: -42.15 },
  { date: "2026-11-05", description: "UTILITY CO AUTOPAY", amount: -120 },
];

describe("Coetha enters day-to-day bank activity", () => {
  it("enters the days the bank shows when they prove out to the cent; nothing is posted; sending them again adds nothing", async () => {
    const s = await setup();
    const r = await addBankActivity(s.tabitha, s.biz.id, { account: "4321", document_name: "activity-nov-5.pdf", starting_balance: 1000, ending_balance: 1337.85, transactions: WEEK });
    expect(r).toMatchObject({ entered: true, added: 3, alreadyInBooks: 0, period: "2026-11-02 to 2026-11-05" });
    const rows = await prisma.bankTransaction.findMany({ where: { clientId: s.biz.id }, orderBy: { date: "asc" } });
    expect(rows.map((t) => [t.amountCents, t.status])).toEqual([[50000, "UNREVIEWED"], [-4215, "UNREVIEWED"], [-12000, "UNREVIEWED"]]);
    expect((r as { newRows: { bankTransactionId: string }[] }).newRows.map((x) => x.bankTransactionId).sort()).toEqual(rows.map((t) => t.id).sort());
    expect(await prisma.journalEntry.count({ where: { clientId: s.biz.id, source: "BANK" } })).toBe(0);

    // A later screenshot that overlaps: only the new day is added.
    const r2 = await addBankActivity(s.tabitha, s.biz.id, { account: "4321", starting_balance: 1457.85, ending_balance: 1407.85, transactions: [{ date: "2026-11-06", description: "FUEL STATION", amount: -50 }] });
    expect(r2).toMatchObject({ entered: true, added: 1 });
    const again = await addBankActivity(s.tabitha, s.biz.id, { account: "4321", starting_balance: 1000, ending_balance: 1337.85, transactions: WEEK });
    expect(again).toMatchObject({ entered: true, added: 0, alreadyInBooks: 3 });
    expect(await prisma.bankTransaction.count({ where: { clientId: s.biz.id } })).toBe(4);
    expect(await prisma.auditLog.count({ where: { action: "coetha.bank_activity_entered" } })).toBe(3);
  });

  it("refuses figures that don't add up, a start that doesn't continue the last statement, and unknown accounts", async () => {
    const s = await setup();
    const off = await addBankActivity(s.tabitha, s.biz.id, { account: "4321", starting_balance: 1000, ending_balance: 1340, transactions: WEEK });
    expect(off).toMatchObject({ entered: false });
    expect((off as { problem: string }).problem).toMatch(/unaccounted for/);
    const gap = await addBankActivity(s.tabitha, s.biz.id, { account: "4321", starting_balance: 1100, ending_balance: 1437.85, transactions: WEEK });
    expect((gap as { problem: string }).problem).toMatch(/doesn't continue the last statement/);
    const none = await addBankActivity(s.tabitha, s.biz.id, { account: "9999", starting_balance: 1000, ending_balance: 1337.85, transactions: WEEK });
    expect(none).toMatchObject({ entered: false, accounts: [expect.objectContaining({ last4: "4321" })] });
    const missing = await addBankActivity(s.tabitha, s.biz.id, { account: "4321", starting_balance: 1000, ending_balance: 1500, transactions: [{ date: "11/02/2026", description: "DEPOSIT", amount: 500 }] });
    expect((missing as { problem: string }).problem).toMatch(/missing a date/);
    expect(await prisma.bankTransaction.count({ where: { clientId: s.biz.id } })).toBe(0);
  });

  it("only people who may import bank transactions for the business can enter activity", async () => {
    const s = await setup();
    const staff = await makeUser("STAFF", "Drew Example");
    await expect(addBankActivity(staff, s.biz.id, { account: "4321", starting_balance: 1000, ending_balance: 1337.85, transactions: WEEK })).rejects.toThrow();
    expect(await prisma.bankTransaction.count({ where: { clientId: s.biz.id } })).toBe(0);
  });
});
