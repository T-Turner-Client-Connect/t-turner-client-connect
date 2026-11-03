import { beforeEach, describe, expect, it } from "vitest";
import { makeUser, prisma, resetDb } from "./db";
import { ForbiddenError } from "@/lib/auth/actor";
import { createClient } from "@/lib/services/clients";
import {
  accountBalance, addAccount, balanceSheet, categorizeBankTransaction, closeBooksThrough, excludeBankTransaction, fingerprints, importBankCsv, includeBankTransaction,
  ledgerFlags, parseBankCsv, parseCents, postJournalEntry, postOpeningBalances, profitAndLoss, reconcileAccount, reopenBooks, reverseEntry, setBasis, setupLedger, updateAccount,
} from "@/lib/services/ledger";

// Fictional businesses, accounts and amounts only.
beforeEach(async () => {
  await resetDb();
});

async function setup() {
  const tabitha = await makeUser("ADMIN", "Tabitha");
  await prisma.ownerAccess.create({ data: { userId: tabitha.id, isPrimary: true } });
  const daria = await makeUser("STAFF", "Daria");
  const otherStaff = await makeUser("STAFF", "Other");
  const harbor = await createClient(tabitha, { businessName: "Harbor Example Co (fictional)", clientType: "BUSINESS", status: "ACTIVE", assignedToId: daria.id });
  const maple = await createClient(tabitha, { businessName: "Maple Example LLC (fictional)", clientType: "BUSINESS", status: "ACTIVE" });
  await setupLedger(daria, harbor.id, { basis: "CASH" });
  const acct = async (clientId: string, code: string) => (await prisma.ledgerAccount.findFirstOrThrow({ where: { clientId, code } })).id;
  return { tabitha, daria, otherStaff, harbor, maple, acct };
}

const CSV = (rows: string[]) => ["Date,Description,Amount", ...rows].join("\n");

describe("setup, access and chart of accounts", () => {
  it("each client gets its own books with a standard chart; only Admins and the assigned staff member can use them", async () => {
    const { tabitha, daria, otherStaff, harbor, maple } = await setup();
    expect(await prisma.ledgerAccount.count({ where: { clientId: harbor.id } })).toBeGreaterThan(20);
    expect(await prisma.ledgerAccount.count({ where: { clientId: maple.id } })).toBe(0);
    await expect(setupLedger(daria, harbor.id, { basis: "CASH" })).rejects.toThrow(/already set up/);
    await expect(setupLedger(otherStaff, maple.id, { basis: "ACCRUAL" })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(profitAndLoss(otherStaff, harbor.id, { from: "2026-01-01", to: "2026-01-31" })).rejects.toBeInstanceOf(ForbiddenError);
    await setupLedger(tabitha, maple.id, { basis: "ACCRUAL", fiscalYearStartMonth: 7 });
    expect(await prisma.auditLog.count({ where: { action: "ledger.setup" } })).toBe(2);
  });

  it("adds accounts, refuses duplicates and mismatched kinds, and locks an account's type once it has entries", async () => {
    const { daria, harbor, acct } = await setup();
    const savings = await addAccount(daria, harbor.id, { code: "1010", name: "Business Savings", type: "ASSET", subtype: "BANK", institution: "Example Bank", last4: "0042" });
    await expect(addAccount(daria, harbor.id, { code: "1010", name: "Dup", type: "ASSET" })).rejects.toThrow(/already exists/);
    await expect(addAccount(daria, harbor.id, { code: "1020", name: "Bad", type: "INCOME", subtype: "BANK" })).rejects.toThrow(/doesn't match/);
    await expect(addAccount(daria, harbor.id, { code: "1030", name: "Bad", type: "ASSET", last4: "123456789" })).rejects.toThrow(/last four/);
    await postJournalEntry(daria, harbor.id, { date: "2026-01-05", memo: "Move to savings", lines: [{ accountId: savings.id, debit: "100" }, { accountId: await acct(harbor.id, "1000"), credit: "100" }] });
    await expect(updateAccount(daria, harbor.id, savings.id, { type: "EXPENSE", subtype: null })).rejects.toThrow(/type can't change/);
    await updateAccount(daria, harbor.id, savings.id, { name: "Reserve Savings" });
    expect((await prisma.ledgerAccount.findUniqueOrThrow({ where: { id: savings.id } })).name).toBe("Reserve Savings");
  });
});

describe("journal entries", () => {
  it("posts only balanced, one-sided entries on this client's own accounts", async () => {
    const { tabitha, daria, harbor, maple, acct } = await setup();
    await setupLedger(tabitha, maple.id, { basis: "CASH" });
    const [bank, sales] = [await acct(harbor.id, "1000"), await acct(harbor.id, "4000")];
    await expect(postJournalEntry(daria, harbor.id, { date: "2026-01-10", memo: "x", lines: [{ accountId: bank, debit: "100" }, { accountId: sales, credit: "90" }] })).rejects.toThrow(/must be equal/);
    await expect(postJournalEntry(daria, harbor.id, { date: "2026-01-10", memo: "x", lines: [{ accountId: bank, debit: "100", credit: "100" }, { accountId: sales, credit: "100" }] })).rejects.toThrow(/either a debit or a credit/);
    await expect(postJournalEntry(daria, harbor.id, { date: "2026-01-10", memo: "x", lines: [{ accountId: bank, debit: "100" }] })).rejects.toThrow(/at least two lines/);
    await expect(postJournalEntry(daria, harbor.id, { date: "2026-02-30", memo: "x", lines: [{ accountId: bank, debit: "1" }, { accountId: sales, credit: "1" }] })).rejects.toThrow(/valid date/);
    // Another client's account can never be used here.
    const mapleBank = await acct(maple.id, "1000");
    await expect(postJournalEntry(tabitha, harbor.id, { date: "2026-01-10", memo: "x", lines: [{ accountId: mapleBank, debit: "5" }, { accountId: sales, credit: "5" }] })).rejects.toThrow(/own accounts/);
    const e = await postJournalEntry(daria, harbor.id, { date: "2026-01-10", memo: "Cash sale", lines: [{ accountId: bank, debit: "1,250.50" }, { accountId: sales, credit: "1250.50" }] });
    expect(e.lines.map((l) => [l.debitCents, l.creditCents])).toEqual([[125050, 0], [0, 125050]]);
    expect(await prisma.auditLog.count({ where: { action: "ledger.entry_posted", clientId: harbor.id } })).toBe(1);
    expect(await prisma.journalEntry.count({ where: { clientId: maple.id } })).toBe(0);
  });

  it("the database itself refuses a two-sided or negative line", async () => {
    const { daria, harbor, acct } = await setup();
    const e = await postJournalEntry(daria, harbor.id, { date: "2026-01-10", memo: "Sale", lines: [{ accountId: await acct(harbor.id, "1000"), debit: "10" }, { accountId: await acct(harbor.id, "4000"), credit: "10" }] });
    await expect(prisma.journalLine.create({ data: { entryId: e.id, accountId: await acct(harbor.id, "1000"), debitCents: 5, creditCents: 5 } })).rejects.toThrow();
    await expect(prisma.journalLine.create({ data: { entryId: e.id, accountId: await acct(harbor.id, "1000"), debitCents: -5 } })).rejects.toThrow();
  });

  it("corrections are reversals, never edits; a reversed entry can't be reversed twice", async () => {
    const { daria, harbor, acct } = await setup();
    const e = await postJournalEntry(daria, harbor.id, { date: "2026-01-10", memo: "Wrong category", lines: [{ accountId: await acct(harbor.id, "6300"), debit: "80" }, { accountId: await acct(harbor.id, "1000"), credit: "80" }] });
    await expect(reverseEntry(daria, harbor.id, e.id, { date: "2026-01-20", reason: "x" })).rejects.toThrow(/why/);
    const r = await reverseEntry(daria, harbor.id, e.id, { date: "2026-01-20", reason: "Posted to supplies; it was software" });
    expect(r.lines.map((l) => [l.debitCents, l.creditCents])).toEqual([[0, 8000], [8000, 0]]);
    await expect(reverseEntry(daria, harbor.id, e.id, { date: "2026-01-21", reason: "again please" })).rejects.toThrow(/already reversed/);
    await expect(reverseEntry(daria, harbor.id, r.id, { date: "2026-01-21", reason: "undo undo" })).rejects.toThrow(/can't itself be reversed/);
    expect(await prisma.journalEntry.count({ where: { clientId: harbor.id } })).toBe(2);
    expect(await accountBalance(harbor.id, await acct(harbor.id, "6300"), "2026-01-31")).toBe(0);
  });
});

describe("opening balances", () => {
  it("posts once, balances to Opening Balance Equity, and blocks entries dated before it", async () => {
    const { daria, harbor, acct } = await setup();
    const [bank, card, loan, equip] = [await acct(harbor.id, "1000"), await acct(harbor.id, "2100"), await acct(harbor.id, "2500"), await acct(harbor.id, "1500")];
    await expect(postOpeningBalances(daria, harbor.id, { date: "2026-01-01", balances: [{ accountId: await acct(harbor.id, "4000"), amount: "10" }] })).rejects.toThrow(/asset, liability and equity/);
    await postOpeningBalances(daria, harbor.id, { date: "2026-01-01", balances: [{ accountId: bank, amount: "50,524.47" }, { accountId: card, amount: "1,200.00" }, { accountId: loan, amount: "10000" }, { accountId: equip, amount: "8000" }] });
    await expect(postOpeningBalances(daria, harbor.id, { date: "2026-01-01", balances: [{ accountId: bank, amount: "1" }] })).rejects.toThrow(/already posted/);
    expect(await accountBalance(harbor.id, bank, "2026-01-01")).toBe(5052447);
    expect(await accountBalance(harbor.id, card, "2026-01-01")).toBe(120000);
    expect(await accountBalance(harbor.id, await acct(harbor.id, "3900"), "2026-01-01")).toBe(5052447 + 800000 - 120000 - 1000000);
    await expect(postJournalEntry(daria, harbor.id, { date: "2025-12-31", memo: "Too early", lines: [{ accountId: bank, debit: "1" }, { accountId: await acct(harbor.id, "4000"), credit: "1" }] })).rejects.toThrow(/before the opening balances/);
    const bs = await balanceSheet(daria, harbor.id, { asOf: "2026-01-01" });
    expect(bs.balanced).toBe(true);
    expect(bs.totalAssets).toBe(5852447);
  });
});

describe("bank statement import", () => {
  it("reads signed-amount and debit/credit CSVs, US and ISO dates, quoted commas; skips unreadable rows with a reason", () => {
    const a = parseBankCsv(CSV(["01/05/2026,\"Coffee, Inc\",-4.50", "2026-01-06,Deposit,\"1,000.00\"", "bad,Row,1", "01/07/26,Zero,0"]));
    expect(a.rows).toEqual([{ date: "2026-01-05", amountCents: -450, description: "Coffee, Inc" }, { date: "2026-01-06", amountCents: 100000, description: "Deposit" }, { date: "2026-01-07", amountCents: 0, description: "Zero" }].slice(0, 2));
    expect(a.problems).toHaveLength(2);
    const b = parseBankCsv("Posting Date,Payee,Debit,Credit\n01/08/2026,Rent,950.00,\n01/09/2026,Client payment,,2500.00\n");
    expect(b.rows.map((r) => r.amountCents)).toEqual([-95000, 250000]);
    expect(() => parseBankCsv("Foo,Bar\n1,2")).toThrow(/columns/);
    expect(parseCents("(12.00)")).toBe(-1200);
    expect(() => parseCents("12.345")).toThrow();
  });

  it("never imports the same row twice — even from an overlapping statement — but keeps genuine same-day repeats", async () => {
    const { daria, harbor, acct } = await setup();
    const bank = await acct(harbor.id, "1000");
    const jan = CSV(["01/03/2026,Monthly service fee,-38.50", "01/03/2026,Monthly service fee,-38.50", "01/15/2026,Customer card deposits,4327.23"]);
    const r1 = await importBankCsv(daria, harbor.id, bank, { fileName: "jan.csv", text: jan });
    expect([r1.added, r1.duplicates]).toEqual([3, 0]);
    // The same file again, then an overlapping export that adds one new row.
    expect((await importBankCsv(daria, harbor.id, bank, { fileName: "jan-again.csv", text: jan })).added).toBe(0);
    const overlap = await importBankCsv(daria, harbor.id, bank, { fileName: "jan-feb.csv", text: CSV(["01/15/2026,Customer card deposits,4327.23", "02/02/2026,Customer card deposits,5955.84"]) });
    expect([overlap.added, overlap.duplicates]).toEqual([1, 1]);
    expect(await prisma.bankTransaction.count({ where: { accountId: bank } })).toBe(4);
    expect(new Set(fingerprints([{ date: "2026-01-03", amountCents: -3850, description: "fee" }, { date: "2026-01-03", amountCents: -3850, description: "FEE" }])).size).toBe(2);
    // Only this client's bank or card accounts can receive an import.
    await expect(importBankCsv(daria, harbor.id, await acct(harbor.id, "4000"), { fileName: "x.csv", text: jan })).rejects.toThrow(/bank or credit card/);
  });

  it("rows before the opening date are kept but excluded, so they aren't counted twice", async () => {
    const { daria, harbor, acct } = await setup();
    const bank = await acct(harbor.id, "1000");
    await postOpeningBalances(daria, harbor.id, { date: "2026-01-01", balances: [{ accountId: bank, amount: "1000" }] });
    await importBankCsv(daria, harbor.id, bank, { fileName: "s.csv", text: CSV(["12/30/2025,Old deposit,500", "01/02/2026,New deposit,200"]) });
    const rows = await prisma.bankTransaction.findMany({ where: { accountId: bank }, orderBy: { date: "asc" } });
    expect(rows.map((r) => r.status)).toEqual(["EXCLUDED", "UNREVIEWED"]);
    expect(rows[0].excludedReason).toMatch(/opening balance/);
  });

  it("posts reviewed rows once; a transfer between the client's own accounts is recorded once, not twice", async () => {
    const { daria, harbor, acct } = await setup();
    const [bank, card, fees, sales] = [await acct(harbor.id, "1000"), await acct(harbor.id, "2100"), await acct(harbor.id, "6100"), await acct(harbor.id, "4000")];
    await importBankCsv(daria, harbor.id, bank, { fileName: "b.csv", text: CSV(["01/03/2026,Service fee,-12.60", "01/10/2026,Deposit,900", "01/20/2026,Payment to card,-300"]) });
    await importBankCsv(daria, harbor.id, card, { fileName: "c.csv", text: CSV(["01/21/2026,Payment received - thank you,300", "01/05/2026,Office chair,-300"]) });
    const row = (desc: string) => prisma.bankTransaction.findFirstOrThrow({ where: { clientId: harbor.id, description: desc } });
    await categorizeBankTransaction(daria, harbor.id, (await row("Service fee")).id, { accountId: fees });
    await expect(categorizeBankTransaction(daria, harbor.id, (await row("Service fee")).id, { accountId: fees })).rejects.toThrow(/already posted/);
    await categorizeBankTransaction(daria, harbor.id, (await row("Deposit")).id, { accountId: sales });
    // Paying the card from checking: the card statement's "payment received" row is matched, not posted again.
    const t = await categorizeBankTransaction(daria, harbor.id, (await row("Payment to card")).id, { accountId: card });
    expect(t.matchedTransferId).toBe((await row("Payment received - thank you")).id);
    expect((await row("Payment received - thank you")).status).toBe("POSTED");
    await expect(categorizeBankTransaction(daria, harbor.id, (await row("Payment to card")).id, { accountId: bank })).rejects.toThrow();
    expect(await accountBalance(harbor.id, bank, "2026-01-31")).toBe(-1260 + 90000 - 30000);
    expect(await accountBalance(harbor.id, card, "2026-01-31")).toBe(-30000); // paid before the charge was posted
    expect(await prisma.journalEntry.count({ where: { clientId: harbor.id, source: "BANK" } })).toBe(3);
  });

  it("reversing a bank posting sends the row back to review, and it can be posted again correctly", async () => {
    const { daria, harbor, acct } = await setup();
    const [bank, supplies, software] = [await acct(harbor.id, "1000"), await acct(harbor.id, "6300"), await acct(harbor.id, "6600")];
    await importBankCsv(daria, harbor.id, bank, { fileName: "b.csv", text: CSV(["01/04/2026,Software subscription,-38.50"]) });
    const row = await prisma.bankTransaction.findFirstOrThrow({ where: { accountId: bank } });
    const { entry } = await categorizeBankTransaction(daria, harbor.id, row.id, { accountId: supplies });
    await reverseEntry(daria, harbor.id, entry.id, { date: "2026-01-04", reason: "It's software, not supplies" });
    expect((await prisma.bankTransaction.findUniqueOrThrow({ where: { id: row.id } })).status).toBe("UNREVIEWED");
    await categorizeBankTransaction(daria, harbor.id, row.id, { accountId: software });
    expect(await accountBalance(harbor.id, supplies, "2026-01-31")).toBe(0);
    expect(await accountBalance(harbor.id, software, "2026-01-31")).toBe(3850);
    expect(await accountBalance(harbor.id, bank, "2026-01-31")).toBe(-3850);
  });

  it("excluded rows keep their reason and can be included again", async () => {
    const { daria, harbor, acct } = await setup();
    const bank = await acct(harbor.id, "1000");
    await importBankCsv(daria, harbor.id, bank, { fileName: "b.csv", text: CSV(["01/04/2026,Personal item,-20"]) });
    const row = await prisma.bankTransaction.findFirstOrThrow({ where: { accountId: bank } });
    await expect(excludeBankTransaction(daria, harbor.id, row.id, "")).rejects.toThrow(/why/);
    await excludeBankTransaction(daria, harbor.id, row.id, "Owner's personal purchase — moved to draws later");
    await expect(categorizeBankTransaction(daria, harbor.id, row.id, { accountId: await acct(harbor.id, "6300") })).rejects.toThrow(/excluded/);
    await includeBankTransaction(daria, harbor.id, row.id);
    expect((await prisma.bankTransaction.findUniqueOrThrow({ where: { id: row.id } })).status).toBe("UNREVIEWED");
  });
});

describe("reconciliation", () => {
  it("saves only when the ledger matches the statement to the cent and every row is reviewed", async () => {
    const { daria, harbor, acct } = await setup();
    const [bank, sales, fees] = [await acct(harbor.id, "1000"), await acct(harbor.id, "4000"), await acct(harbor.id, "6100")];
    await postOpeningBalances(daria, harbor.id, { date: "2026-01-01", balances: [{ accountId: bank, amount: "1000" }] });
    await importBankCsv(daria, harbor.id, bank, { fileName: "b.csv", text: CSV(["01/05/2026,Deposit,500", "01/31/2026,Service fee,-8.10"]) });
    let r = await reconcileAccount(daria, harbor.id, bank, { statementDate: "2026-01-31", statementBalance: "1491.90" });
    expect(r).toMatchObject({ reconciled: false, unreviewed: 2, difference: 49190 });
    const rows = await prisma.bankTransaction.findMany({ where: { accountId: bank }, orderBy: { date: "asc" } });
    await categorizeBankTransaction(daria, harbor.id, rows[0].id, { accountId: sales });
    await categorizeBankTransaction(daria, harbor.id, rows[1].id, { accountId: fees });
    r = await reconcileAccount(daria, harbor.id, bank, { statementDate: "2026-01-31", statementBalance: "1491.00" });
    expect(r).toMatchObject({ reconciled: false, difference: -90, unreviewed: 0 });
    r = await reconcileAccount(daria, harbor.id, bank, { statementDate: "2026-01-31", statementBalance: "1,491.90" });
    expect(r.reconciled).toBe(true);
    expect(await prisma.bankReconciliation.count()).toBe(1);
  });
});

describe("statements", () => {
  async function january() {
    const s = await setup();
    const { daria, harbor, acct } = s;
    const [bank, sales, fees, draws, capital, software] = [await acct(harbor.id, "1000"), await acct(harbor.id, "4000"), await acct(harbor.id, "6150"), await acct(harbor.id, "3100"), await acct(harbor.id, "3000"), await acct(harbor.id, "6600")];
    await postOpeningBalances(daria, harbor.id, { date: "2026-01-01", balances: [{ accountId: bank, amount: "10000" }, { accountId: capital, amount: "10000" }] });
    const je = (date: string, memo: string, dr: string, cr: string, amt: string) => postJournalEntry(daria, harbor.id, { date, memo, lines: [{ accountId: dr, debit: amt }, { accountId: cr, credit: amt }] });
    await je("2026-01-15", "Card deposits", bank, sales, "4327.23");
    await je("2026-02-15", "Card deposits", bank, sales, "5955.84");
    await je("2026-01-31", "Processing fees", fees, bank, "147.35");
    await je("2026-01-02", "Software", software, bank, "38.50");
    await je("2026-01-20", "Owner draw", draws, bank, "1890.00");
    return { ...s, bank, sales, draws };
  }

  it("Profit & Loss: monthly columns and a total; owner draws stay in equity, never in expenses", async () => {
    const { daria, harbor } = await january();
    const pl = await profitAndLoss(daria, harbor.id, { from: "2026-01-01", to: "2026-02-28" });
    expect(pl.months).toEqual(["2026-01", "2026-02"]);
    expect(pl.income.map((r) => [r.code, r.months, r.total])).toEqual([["4000", [432723, 595584], 1028307]]);
    expect(pl.expenses.map((r) => r.code)).toEqual(["6150", "6600"]);
    expect(pl.expenses.some((r) => r.code === "3100")).toBe(false);
    expect(pl.netIncome.months).toEqual([432723 - 14735 - 3850, 595584]);
    expect(pl.netIncome.total).toBe(1028307 - 14735 - 3850);
  });

  it("Balance Sheet balances; draws reduce equity; prior years roll into retained earnings", async () => {
    const { daria, harbor, bank, sales } = await january();
    let bs = await balanceSheet(daria, harbor.id, { asOf: "2026-02-28" });
    expect(bs.balanced).toBe(true);
    expect(bs.equity.find((r) => r.code === "3100")!.amount).toBe(-189000);
    expect(bs.netIncomeThisYear).toBe(1028307 - 14735 - 3850);
    expect(bs.retainedEarningsFromPriorYears).toBe(0);
    // Next year: this year's income moves to retained earnings.
    await postJournalEntry(daria, harbor.id, { date: "2027-01-10", memo: "Sale", lines: [{ accountId: bank, debit: "100" }, { accountId: sales, credit: "100" }] });
    bs = await balanceSheet(daria, harbor.id, { asOf: "2027-01-31" });
    expect(bs.retainedEarningsFromPriorYears).toBe(1028307 - 14735 - 3850);
    expect(bs.netIncomeThisYear).toBe(10000);
    expect(bs.balanced).toBe(true);
  });

  it("cash and accrual statements include only entries for that basis", async () => {
    const { tabitha, daria, harbor, acct } = await setup();
    const [ar, sales, bank] = [await acct(harbor.id, "1100"), await acct(harbor.id, "4000"), await acct(harbor.id, "1000")];
    await postJournalEntry(daria, harbor.id, { date: "2026-03-01", memo: "Invoice 1001 issued", basis: "ACCRUAL_ONLY", lines: [{ accountId: ar, debit: "500" }, { accountId: sales, credit: "500" }] });
    await postJournalEntry(daria, harbor.id, { date: "2026-04-02", memo: "Invoice 1001 paid", basis: "ACCRUAL_ONLY", lines: [{ accountId: bank, debit: "500" }, { accountId: ar, credit: "500" }] });
    await postJournalEntry(daria, harbor.id, { date: "2026-04-02", memo: "Invoice 1001 paid", basis: "CASH_ONLY", lines: [{ accountId: bank, debit: "500" }, { accountId: sales, credit: "500" }] });
    const cash = await profitAndLoss(daria, harbor.id, { from: "2026-03-01", to: "2026-04-30", basis: "CASH" });
    const accrual = await profitAndLoss(daria, harbor.id, { from: "2026-03-01", to: "2026-04-30", basis: "ACCRUAL" });
    expect(cash.income[0].months).toEqual([0, 50000]);
    expect(accrual.income[0].months).toEqual([50000, 0]);
    // The bank balance is the same either way: the payment is counted once.
    expect(await accountBalance(harbor.id, bank, "2026-04-30", "CASH")).toBe(50000);
    expect(await accountBalance(harbor.id, bank, "2026-04-30", "ACCRUAL")).toBe(50000);
    await expect(setBasis(daria, harbor.id, "ACCRUAL")).rejects.toBeInstanceOf(ForbiddenError);
    await setBasis(tabitha, harbor.id, "ACCRUAL");
  });
});

describe("closing approved periods", () => {
  it("only Tabitha closes or reopens; nothing on or before the closed date can be posted or reversed", async () => {
    const { tabitha, daria, harbor, acct } = await setup();
    const [bank, sales] = [await acct(harbor.id, "1000"), await acct(harbor.id, "4000")];
    const e = await postJournalEntry(daria, harbor.id, { date: "2026-01-15", memo: "Sale", lines: [{ accountId: bank, debit: "100" }, { accountId: sales, credit: "100" }] });
    await expect(closeBooksThrough(daria, harbor.id, "2026-01-31")).rejects.toBeInstanceOf(ForbiddenError);
    await closeBooksThrough(tabitha, harbor.id, "2026-01-31");
    await expect(postJournalEntry(daria, harbor.id, { date: "2026-01-31", memo: "Late", lines: [{ accountId: bank, debit: "1" }, { accountId: sales, credit: "1" }] })).rejects.toThrow(/closed through 2026-01-31/);
    await expect(reverseEntry(daria, harbor.id, e.id, { date: "2026-01-20", reason: "Wrong amount entered" })).rejects.toThrow(/closed/);
    // The correction goes in the open period; January's approved figures don't change.
    await reverseEntry(daria, harbor.id, e.id, { date: "2026-02-01", reason: "Wrong amount entered" });
    expect((await profitAndLoss(daria, harbor.id, { from: "2026-01-01", to: "2026-01-31" })).netIncome.total).toBe(10000);
    await expect(reopenBooks(daria, harbor.id, { through: null, reason: "Need to fix January" })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(reopenBooks(tabitha, harbor.id, { through: null, reason: "" })).rejects.toThrow(/why/);
    await reopenBooks(tabitha, harbor.id, { through: null, reason: "Client sent a missing January statement" });
    expect(await prisma.auditLog.findFirstOrThrow({ where: { action: "ledger.reopened" } })).toMatchObject({ actorId: tabitha.id });
  });
});

describe("review flags (nothing is guessed or filled in)", () => {
  it("flags missing opening balances, unreviewed rows, missing months, unreconciled accounts, suspense and draws posted as expenses", async () => {
    const { tabitha, daria, harbor, acct } = await setup();
    const [bank, suspense, supplies] = [await acct(harbor.id, "1000"), await acct(harbor.id, "9999"), await acct(harbor.id, "6300")];
    await importBankCsv(daria, harbor.id, bank, { fileName: "b.csv", text: CSV(["01/05/2026,Deposit,500", "01/10/2026,Owner draw to personal,-200", "03/03/2026,Mystery charge,-45", "03/04/2026,Unknown,-10"]) });
    const rows = await prisma.bankTransaction.findMany({ where: { accountId: bank }, orderBy: { date: "asc" } });
    await categorizeBankTransaction(daria, harbor.id, rows[1].id, { accountId: supplies });
    await categorizeBankTransaction(daria, harbor.id, rows[2].id, { accountId: suspense });
    await closeBooksThrough(tabitha, harbor.id, "2026-01-31");
    const kinds = (await ledgerFlags(daria, harbor.id, "2026-04-15")).map((f) => f.kind);
    expect(kinds).toEqual(expect.arrayContaining(["NO_OPENING", "UNREVIEWED", "CLOSED_PERIOD", "MISSING_STATEMENT", "UNRECONCILED", "SUSPENSE", "POSSIBLE_DRAW"]));
    const missing = (await ledgerFlags(daria, harbor.id, "2026-04-15")).find((f) => f.kind === "MISSING_STATEMENT")!;
    expect(missing.message).toMatch(/2026-02/);
  });
});
