import { beforeEach, describe, expect, it } from "vitest";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { makeUser, prisma, resetDb } from "./db";
import { createClient } from "@/lib/services/clients";
import { saveProfile } from "@/lib/services/bookkeeping-clients";
import { categorizeBankTransaction, postJournalEntry, setupLedger } from "@/lib/services/ledger";
import { registerAccount } from "@/lib/services/bank-accounts";
import { staffUploadStatement } from "@/lib/services/client-requests";
import { readStatementTransactions } from "@/lib/services/statement-import";
import { cashProof, postOpeningFromStatement } from "@/lib/services/cash-proof";

// A fictional statement (October 2026): begins $1,000.00, ends $1,780.44, 8 transactions.
const LINES = [
  "Example Community Bank",
  "MAGNOLIA EXAMPLE LLC",
  "123 FICTIONAL ST",
  "ACCOUNT # 0000123456",
  "BUSINESS CHECKING",
  "October 1, 2026 through October 30, 2026",
  "SUMMARY",
  "Beginning Balance $1,000.00 Minimum Balance $900",
  "Deposits & Credits $2,500.00 + Average Balance $1,800",
  "Withdrawals $1,234.56 -",
  "Fees $35.00 -",
  "Automatic Transfers $0.00 +",
  "Checks $450.00 -",
  "Ending Balance $1,780.44",
  "DEPOSITS & CREDITS",
  "10/02 Mobile Deposit 2,000.00",
  "10/15 Square Inc Settlement",
  "SQ 1234 500.00",
  "Total Deposits & Credits $2,500.00",
  "WITHDRAWALS",
  "10/03 Card Purchase Office Depot 84.56",
  "10/09 Online Transfer To Savings 1,000.00",
  "10/20 ADP Payroll Fees 150.00",
  "Total Withdrawals $1,234.56",
  "FEES",
  "10/30 Monthly Service Fee 35.00",
  "Total Fees $35.00",
  "CHECKS",
  "Check No. Date Amount Check No. Date Amount",
  "1001 10/05 200.00 1002 * 10/12 250.00",
  "Total Checks $450.00",
  "DAILY BALANCE SUMMARY",
  "10/02 3,000.00 10/03 2,915.44",
];

async function statementPdf(rows: string[]) {
    const pdf = await PDFDocument.create();
    const font = await pdf.embedFont(StandardFonts.Helvetica);
    const page = pdf.addPage([612, 1100]);
    let y = 1080;
    for (const l of rows) {
      // Draw some lines as separate pieces (like real statements' columns).
      const m = /^(.*?)\s(\$?[\d,]+\.\d{2}.*)$/.exec(l);
      if (m) { page.drawText(m[1], { x: 40, y, size: 9, font }); page.drawText(m[2], { x: 380, y, size: 9, font }); }
      else page.drawText(l, { x: 40, y, size: 9, font });
      y -= 14;
    }
    return pdf.save();
}


describe("Cash proof: from the bank statement balance to the balance in the books", () => {
  beforeEach(resetDb);

  async function world() {
    const tabitha = await makeUser("ADMIN", "Tabitha");
    await prisma.ownerAccess.create({ data: { userId: tabitha.id, isPrimary: true } });
    const daria = await makeUser("STAFF", "Daria");
    const biz = await createClient(tabitha, { businessName: "Magnolia Example LLC (fictional)", clientType: "BUSINESS", status: "ACTIVE", assignedToId: daria.id });
    await saveProfile(tabitha, biz.id, { active: true, frequency: "MONTHLY", payroll: false, payrollFrequency: null, payrollProvider: null });
    await setupLedger(tabitha, biz.id, { basis: "CASH" });
    const chk = await registerAccount(tabitha, biz.id, { institution: "Example Community Bank", accountType: "CHECKING", last4: "3456" });
    const doc = await staffUploadStatement(tabitha, biz.id, { accountId: chk.id, month: "2026-10", bytes: await statementPdf(LINES), originalName: "october.pdf" });
    await readStatementTransactions(tabitha, biz.id, doc.id);
    const gl = (await prisma.bookkeepingAccount.findUniqueOrThrow({ where: { id: chk.id } })).ledgerAccountId!;
    return { tabitha, daria, biz, gl };
  }

  it("explains the books' balance to the cent, finds the missing opening balance and posts it once", async () => {
    const w = await world();
    let [p] = await cashProof(w.tabitha, w.biz.id);
    expect(p).toMatchObject({ asOf: "2026-10-31", statementEnding: 178044, waiting: { cents: 78044, count: 8 }, openingNeeded: 100000, openingPosted: 0, openingMissing: true, ledger: 0, expected: 0, difference: 0, coverageGap: 0, duplicateRows: 0 });

    // Only Tabitha or an Admin posts the opening balance, from the statement's own beginning balance.
    await expect(postOpeningFromStatement(w.daria, w.biz.id, w.gl)).rejects.toThrow(/Only Tabitha or an Admin/);
    expect(await postOpeningFromStatement(w.tabitha, w.biz.id, w.gl)).toEqual({ date: "2026-10-01", cents: 100000, corrected: false });
    await expect(postOpeningFromStatement(w.tabitha, w.biz.id, w.gl)).rejects.toThrow(/already on the bank account/);
    expect(await prisma.journalEntry.count({ where: { clientId: w.biz.id, source: "OPENING" } })).toBe(1);
    [p] = await cashProof(w.tabitha, w.biz.id);
    expect(p).toMatchObject({ openingPosted: 100000, openingMissing: false, ledger: 100000, expected: 100000, difference: 0 });

    // As rows are posted, the books move toward the statement and the proof stays exact.
    const rows = await prisma.bankTransaction.findMany({ where: { clientId: w.biz.id } });
    const expense = (await prisma.ledgerAccount.findFirstOrThrow({ where: { clientId: w.biz.id, code: "6300" } })).id;
    for (const r of rows.slice(0, 3)) await categorizeBankTransaction(w.tabitha, w.biz.id, r.id, { accountId: expense });
    [p] = await cashProof(w.tabitha, w.biz.id);
    expect(p.difference).toBe(0);
    expect(p.waiting.count).toBe(5);
    for (const r of rows.slice(3)) await categorizeBankTransaction(w.tabitha, w.biz.id, r.id, { accountId: expense });
    [p] = await cashProof(w.tabitha, w.biz.id);
    // Everything posted: the books equal the statement.
    expect(p).toMatchObject({ waiting: { count: 0 }, ledger: 178044, expected: 178044, difference: 0 });

    // A manual entry on the cash account is shown as such (not hidden in the balance).
    await postJournalEntry(w.tabitha, w.biz.id, { date: "2026-10-15", memo: "Manual entry (fictional)", lines: [{ accountId: w.gl, debit: "5.00" }, { accountId: expense, credit: "5.00" }] });
    [p] = await cashProof(w.tabitha, w.biz.id);
    expect(p).toMatchObject({ other: 500, ledger: 178544, expected: 178544, difference: 0 });
  });

  it("flags a bank row posted more than once", async () => {
    const w = await world();
    const r = await prisma.bankTransaction.findFirstOrThrow({ where: { clientId: w.biz.id } });
    const expense = (await prisma.ledgerAccount.findFirstOrThrow({ where: { clientId: w.biz.id, code: "6300" } })).id;
    await categorizeBankTransaction(w.tabitha, w.biz.id, r.id, { accountId: expense });
    // Simulate a second live posting of the same row (the ledger's own guards normally prevent it).
    const first = await prisma.journalEntry.findFirstOrThrow({ where: { clientId: w.biz.id, source: "BANK" }, include: { lines: true } });
    await prisma.journalEntry.create({ data: { clientId: w.biz.id, date: first.date, memo: "duplicate (test)", source: "BANK", sourceKey: `bank:${r.id}:99`, basis: "BOTH", createdById: w.tabitha.id, lines: { create: first.lines.map((l) => ({ accountId: l.accountId, debitCents: l.debitCents, creditCents: l.creditCents })) } } });
    const [p] = await cashProof(w.tabitha, w.biz.id);
    expect(p.duplicateRows).toBe(1);
    expect(p.difference).toBe(0); // the extra posting shows as an entry that isn't a bank row
    expect(p.other).not.toBe(0);
  });

  it("an opening balance recorded on the wrong accounts is shown and corrected from the amount on file, keeping the history", async () => {
    const w = await world();
    const { postOpeningBalances } = await import("@/lib/services/ledger");
    const capital = (await prisma.ledgerAccount.findFirstOrThrow({ where: { clientId: w.biz.id, code: "3000" } })).id;
    // The amount was typed on the owner's capital line of the Opening balances form, not on the bank account.
    await postOpeningBalances(w.tabitha, w.biz.id, { date: "2026-10-01", balances: [{ accountId: capital, amount: "1000.00" }] });
    let [p] = await cashProof(w.tabitha, w.biz.id);
    expect(p).toMatchObject({ openingMissing: false, openingElsewhere: true, openingPosted: 0, difference: 0 });
    expect(p.openingOnFile!.lines.map((l) => l.account)).toEqual(expect.arrayContaining(["3000 Owner's Capital / Contributions"]));
    const r = await postOpeningFromStatement(w.tabitha, w.biz.id, w.gl);
    expect(r).toEqual({ date: "2026-10-01", cents: 100000, corrected: true });
    [p] = await cashProof(w.tabitha, w.biz.id);
    expect(p).toMatchObject({ openingPosted: 100000, openingElsewhere: false, ledger: 100000, difference: 0 });
    // History kept: the original opening is unchanged and the correction is a separate, audited adjusting entry.
    expect(await prisma.journalEntry.count({ where: { clientId: w.biz.id, source: "OPENING" } })).toBe(1);
    expect(await prisma.journalEntry.count({ where: { clientId: w.biz.id, sourceKey: "opening:to-bank" } })).toBe(1);
    // Equity: the owner's capital keeps the amount entered; Opening Balance Equity nets to zero.
    const obe = (await prisma.ledgerAccount.findFirstOrThrow({ where: { clientId: w.biz.id, subtype: "OPENING_BALANCE" } })).id;
    const obeSum = await prisma.journalLine.aggregate({ where: { accountId: obe }, _sum: { debitCents: true, creditCents: true } });
    expect((obeSum._sum.debitCents ?? 0) - (obeSum._sum.creditCents ?? 0)).toBe(0);
    expect(await prisma.auditLog.count({ where: { clientId: w.biz.id, action: "ledger.opening_corrected" } })).toBe(1);
    // Not twice.
    await expect(postOpeningFromStatement(w.tabitha, w.biz.id, w.gl)).rejects.toThrow(/already on the bank account/);
  });
});
