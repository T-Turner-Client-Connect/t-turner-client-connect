import { beforeEach, describe, expect, it } from "vitest";
import { makeUser, prisma, resetDb } from "./db";
import { createClient } from "@/lib/services/clients";
import { saveProfile } from "@/lib/services/bookkeeping-clients";
import { postOpeningBalances, setupLedger } from "@/lib/services/ledger";
import { registerAccount } from "@/lib/services/bank-accounts";
import { correctAccounts } from "@/lib/services/coetha-bookkeeping";

// Fictional business and banks only.
beforeEach(resetDb);

async function world() {
  const tabitha = await makeUser("ADMIN", "Tabitha");
  await prisma.ownerAccess.create({ data: { userId: tabitha.id, isPrimary: true } });
  const daria = await makeUser("STAFF", "Daria");
  const biz = await createClient(tabitha, { businessName: "Aspen Example Agency LLC (fictional)", clientType: "BUSINESS", status: "ACTIVE", assignedToId: daria.id });
  await saveProfile(tabitha, biz.id, { active: true, frequency: "MONTHLY", payroll: false, payrollFrequency: null, payrollProvider: null });
  await setupLedger(tabitha, biz.id, { basis: "CASH" });
  // Set up wrong: both accounts registered as "Chase".
  const chk = await registerAccount(tabitha, biz.id, { institution: "Chase", accountType: "CHECKING", gl: "NEW" });
  const card = await registerAccount(tabitha, biz.id, { institution: "Chase", accountType: "CREDIT_CARD", gl: "NEW" });
  const glOf = async (id: string) => prisma.ledgerAccount.findUniqueOrThrow({ where: { id: (await prisma.bookkeepingAccount.findUniqueOrThrow({ where: { id } })).ledgerAccountId! } });
  return { tabitha, daria, biz, chk, card, chkGl: await glOf(chk.id), cardGl: await glOf(card.id) };
}

describe("Coetha corrects accounts that were set up wrong", () => {
  it("renames the checking account to the real bank with its last 4, deactivates a card the business doesn't have, changes no entries, and records why", async () => {
    const w = await world();
    await postOpeningBalances(w.tabitha, w.biz.id, { date: "2026-10-01", balances: [{ accountId: w.chkGl.id, amount: "500.00" }] });
    const entries = await prisma.journalEntry.count({ where: { clientId: w.biz.id } });
    const r = await correctAccounts(w.tabitha, w.biz.id, [
      { code: w.chkGl.code, institution: "Prairie Example Farm Bank", last4: "4542", reason: "The October statements on file are from Prairie Example Farm Bank, account ending 4542." },
      { code: w.cardGl.code, active: false, reason: "The business has no Chase card; no statements or activity exist for it." },
    ]);
    expect(r.results.every((x) => x.ok)).toBe(true);
    expect(await prisma.bookkeepingAccount.findUniqueOrThrow({ where: { id: w.chk.id } })).toMatchObject({ institution: "Prairie Example Farm Bank", last4: "4542" });
    const chk = await prisma.ledgerAccount.findUniqueOrThrow({ where: { id: w.chkGl.id } });
    expect(chk.name).not.toMatch(/Chase/i);
    expect(chk).toMatchObject({ institution: "Prairie Example Farm Bank", last4: "4542" });
    expect(await prisma.bookkeepingAccount.findUniqueOrThrow({ where: { id: w.card.id } })).toMatchObject({ active: false });
    expect(await prisma.ledgerAccount.findUniqueOrThrow({ where: { id: w.cardGl.id } })).toMatchObject({ active: false });
    expect(await prisma.journalEntry.count({ where: { clientId: w.biz.id } })).toBe(entries);
    expect(await prisma.auditLog.count({ where: { action: "coetha.account_corrected", clientId: w.biz.id } })).toBe(2);
  });

  it("adds the business's real bank account when the books don't have it", async () => {
    const w = await world();
    const r = await correctAccounts(w.tabitha, w.biz.id, [{ add: { accountType: "SAVINGS", institution: "Prairie Example Farm Bank", last4: "7781" }, reason: "The client's savings statements on file are from Prairie Example Farm Bank ••7781." }]);
    expect(r.results[0]).toMatchObject({ ok: true });
    const a = await prisma.bookkeepingAccount.findFirstOrThrow({ where: { clientId: w.biz.id, last4: "7781" } });
    expect(a).toMatchObject({ institution: "Prairie Example Farm Bank", accountType: "SAVINGS" });
    expect(a.ledgerAccountId).toBeTruthy();
  });

  it("an account with a balance isn't deactivated until the balance is moved; staff can't use the tool; a reason is required", async () => {
    const w = await world();
    await postOpeningBalances(w.tabitha, w.biz.id, { date: "2026-10-01", balances: [{ accountId: w.chkGl.id, amount: "500.00" }] });
    const r = await correctAccounts(w.tabitha, w.biz.id, [{ code: w.chkGl.code, active: false, reason: "Testing a deactivation of an account with money in it." }, { code: w.cardGl.code, name: "x", reason: "short" }]);
    expect(r.results[0]).toMatchObject({ ok: false, message: expect.stringMatching(/balance of \$500\.00/) });
    expect(r.results[1]).toMatchObject({ ok: false, message: expect.stringMatching(/reason/) });
    await expect(correctAccounts(w.daria, w.biz.id, [{ code: w.chkGl.code, name: "x", reason: "staff attempt at a rename" }])).rejects.toThrow(/Only Tabitha/);
  });
});
