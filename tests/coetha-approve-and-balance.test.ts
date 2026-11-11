import { beforeEach, describe, expect, it } from "vitest";
import { makeUser, managed, prisma, resetDb } from "./db";
import { createClient } from "@/lib/services/clients";
import { postJournalEntry, setupLedger } from "@/lib/services/ledger";
import { registerAccount } from "@/lib/services/bank-accounts";
import { prepareDecisions, runApproveTool } from "@/lib/services/coetha-decisions";
import { bankFeed } from "@/lib/services/bank-feed";

// Fictional business and figures only.
beforeEach(async () => {
  await resetDb();
});

async function setup() {
  const tabitha = await makeUser("ADMIN", "Tabitha");
  await prisma.ownerAccess.create({ data: { userId: tabitha.id, isPrimary: true } });
  const biz = await createClient(tabitha, { businessName: "Pretend Harbor Cafe LLC", clientType: "BUSINESS", status: "ACTIVE" });
  await managed(biz.id);
  await setupLedger(tabitha, biz.id, { basis: "CASH" });
  const chk = await registerAccount(tabitha, biz.id, { institution: "Example Community Bank", accountType: "CHECKING", nickname: "Operating", last4: "4321", gl: "NEW" });
  const ledger = await prisma.bookkeepingAccount.findUniqueOrThrow({ where: { id: chk.id } });
  const pick = async (type: string) => (await prisma.ledgerAccount.findFirstOrThrow({ where: { clientId: biz.id, type, OR: [{ subtype: null }, { subtype: { notIn: ["SUSPENSE", "COGS", "OTHER_INCOME", "OTHER_EXPENSE", "OPENING_BALANCE"] } }] } }));
  return { tabitha, biz, bankId: ledger.ledgerAccountId!, income: await pick("INCOME"), expense: await pick("EXPENSE") };
}

describe("Tabitha approves in Ask Coetha; clients see the balance per the books", () => {
  it("posts what's on her card only when her own message says to approve or post", async () => {
    const s = await setup();
    const bank = await prisma.ledgerAccount.findUniqueOrThrow({ where: { id: s.bankId } });
    await prepareDecisions(s.tabitha, s.biz.id, [{ type: "journal_entry", date: "2026-10-15", memo: "Fictional reclass", lines: [{ accountCode: s.expense.code, debit: 100 }, { accountCode: bank.code, credit: 100 }] }], "chat");
    expect(await prisma.coethaProposal.count({ where: { clientId: s.biz.id, status: "PROPOSED" } })).toBe(1);
    // Her message doesn't approve: nothing posts.
    expect(await runApproveTool(s.tabitha, s.biz.id, { quote: "yes, post them" }, "What is this entry for?")).toHaveProperty("error");
    expect(await prisma.coethaProposal.count({ where: { clientId: s.biz.id, status: "PROPOSED" } })).toBe(1);
    // She says to post: everything on her card posts.
    const r = await runApproveTool(s.tabitha, s.biz.id, { quote: "Yes, post them" }, "Yes, post them please.");
    expect(r).toMatchObject({ posted: 1 });
    expect(await prisma.coethaProposal.count({ where: { clientId: s.biz.id, status: "APPROVED" } })).toBe(1);
    expect(await prisma.auditLog.count({ where: { action: "coetha.approved_in_chat" } })).toBe(1);
  });

  it("with balances shown to clients, a business with no bank feed shows its balance per the books", async () => {
    const s = await setup();
    await postJournalEntry(s.tabitha, s.biz.id, { date: "2026-10-15", memo: "Fictional sales", lines: [{ accountId: s.bankId, debit: "1500.00" }, { accountId: s.income.id, credit: "1500.00" }] });
    expect((await bankFeed(s.biz.id)).accounts).toHaveLength(0); // switch off: nothing shown
    await prisma.integrationSettings.upsert({ where: { id: "default" }, create: { id: "default", clientBankBalancesVisible: true }, update: { clientBankBalancesVisible: true } });
    const feed = await bankFeed(s.biz.id);
    expect(feed.accounts).toEqual([expect.objectContaining({ kind: "CASH", currentCents: 150000, source: "OFFICE", mask: "4321" })]);
    expect(feed.cashCents).toBe(150000);
  });
});
