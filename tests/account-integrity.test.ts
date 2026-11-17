import { beforeEach, describe, expect, it } from "vitest";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { makeUser, managed, prisma, resetDb } from "./db";
import { createClient } from "@/lib/services/clients";
import { saveProfile } from "@/lib/services/bookkeeping-clients";
import { categorizeBankTransaction, importBankCsv, ledgerFlags, postJournalEntry, postOpeningBalances, setupLedger } from "@/lib/services/ledger";
import { registerAccount } from "@/lib/services/bank-accounts";
import { staffUploadDocument } from "@/lib/services/documents";
import { checkAllAccounts, decideAccountOwnership, runVerifyAccountsTool, verifyAccount } from "@/lib/services/account-ownership";
import { correctAccounts } from "@/lib/services/coetha-bookkeeping";

// Fictional businesses, banks, statements and amounts only.
beforeEach(async () => { await resetDb(); });

async function pdf(lines: string[]) {
  const d = await PDFDocument.create(); const f = await d.embedFont(StandardFonts.Helvetica); const p = d.addPage([612, 400]);
  lines.forEach((t, i) => p.drawText(t, { x: 30, y: 370 - i * 16, size: 10, font: f }));
  return d.save();
}

async function world() {
  const tabitha = await makeUser("ADMIN", "Tabitha");
  await prisma.ownerAccess.create({ data: { userId: tabitha.id, isPrimary: true } });
  const biz = await createClient(tabitha, { businessName: "Willow Example Interiors LLC (fictional)", firstName: "Dana", lastName: "Willowby", clientType: "BUSINESS", status: "ACTIVE" });
  const other = await createClient(tabitha, { businessName: "Aspen Example Works (fictional)", clientType: "BUSINESS", status: "ACTIVE" });
  await managed(biz.id, other.id);
  await saveProfile(tabitha, biz.id, { active: true, frequency: "MONTHLY", payroll: false, payrollFrequency: null, payrollProvider: null });
  await setupLedger(tabitha, biz.id, { basis: "CASH" });
  const gl = (code: string) => prisma.ledgerAccount.findFirstOrThrow({ where: { clientId: biz.id, code } });
  const checking = await gl("1000");
  await postOpeningBalances(tabitha, biz.id, { date: "2026-01-01", balances: [{ accountId: checking.id, amount: "5000.00" }] });
  return { tabitha, biz, other, gl, checking };
}

const statement = async (w: Awaited<ReturnType<typeof world>>, accountId: string, lines: string[]) => {
  const d = await staffUploadDocument(w.tabitha, { clientId: w.biz.id, category: "BOOKKEEPING", title: `Statement ${lines[0]}`, visibility: "STAFF_ONLY", bytes: await pdf(lines), originalName: "s.pdf", notify: false, docType: "BANK_STATEMENT" });
  await prisma.document.update({ where: { id: d.id }, data: { bookkeepingAccountId: accountId } });
  return d;
};

describe("each client's actual accounts, never a default bank", () => {
  it("the standard chart names no bank: 1000 and 2100 are only places in the books", async () => {
    const w = await world();
    for (const code of ["1000", "2100"]) {
      const a = await w.gl(code);
      expect(a.name).not.toMatch(/chase/i);
      expect(a.institution ?? "").toBe("");
    }
  });

  it("verified only when a statement prints the bank, the last 4 and the business's own name", async () => {
    const w = await world();
    const reg = await registerAccount(w.tabitha, w.biz.id, { institution: "Regions", accountType: "CHECKING", last4: "9432", gl: w.checking.id });
    await statement(w, reg.id, ["Regions Bank", "WILLOW EXAMPLE INTERIORS LLC (FICTIONAL)", "Account ending 9432", "November 2026"]);
    expect(await verifyAccount(w.tabitha, reg.id)).toMatchObject({ status: "VERIFIED" });
  });

  it("registered as Chase but the statements are from Regions: in question, and its activity can't be posted, imported or reconciled", async () => {
    const w = await world();
    const reg = await registerAccount(w.tabitha, w.biz.id, { institution: "Chase", accountType: "CHECKING", last4: "9432", gl: w.checking.id });
    await importBankCsv(w.tabitha, w.biz.id, w.checking.id, { fileName: "nov.csv", text: "Date,Description,Amount\n11/03/2026,Office supply store,-84.56\n" });
    await statement(w, reg.id, ["Regions Bank", "Willow Example Interiors LLC (fictional)", "Account ending 9432"]);
    const v = await verifyAccount(w.tabitha, reg.id);
    expect(v).toMatchObject({ status: "IN_QUESTION" });
    expect(v.note).toMatch(/Registered as Chase, but .* is from Regions Bank/);
    const row = await prisma.bankTransaction.findFirstOrThrow({ where: { clientId: w.biz.id } });
    const supplies = await prisma.ledgerAccount.findFirstOrThrow({ where: { clientId: w.biz.id, type: "EXPENSE" } });
    await expect(categorizeBankTransaction(w.tabitha, w.biz.id, row.id, { accountId: supplies.id })).rejects.toThrow(/in question/);
    await expect(importBankCsv(w.tabitha, w.biz.id, w.checking.id, { fileName: "dec.csv", text: "Date,Description,Amount\n12/03/2026,Fee,-5.00\n" })).rejects.toThrow(/in question/);
    // Coetha corrects the bank from the statement: re-checked and verified; nothing in the books changed.
    const entriesBefore = await prisma.journalEntry.count({ where: { clientId: w.biz.id } });
    const r = await correctAccounts(w.tabitha, w.biz.id, [{ code: "1000", institution: "Regions", reason: "The statements on file are from Regions Bank, account ending 9432." }]);
    expect(r.results[0].message).toMatch(/verified from its statement/);
    expect(await prisma.journalEntry.count({ where: { clientId: w.biz.id } })).toBe(entriesBefore);
    await categorizeBankTransaction(w.tabitha, w.biz.id, row.id, { accountId: supplies.id });
  });

  it("a card statement in the owner's personal name is not proof it's the business's: Coetha's new account stays in question", async () => {
    const w = await world();
    const doc = await staffUploadDocument(w.tabitha, { clientId: w.biz.id, category: "BOOKKEEPING", title: "Card statement", visibility: "STAFF_ONLY", bytes: await pdf(["Chase", "DANA WILLOWBY", "Account ending 2110", "October 2026"]), originalName: "c.pdf", notify: false, docType: "CARD_STATEMENT" });
    const r = await correctAccounts(w.tabitha, w.biz.id, [{ reason: "A card statement was filed under this business.", add: { accountType: "CREDIT_CARD", institution: "Chase", last4: "2110", documentId: doc.id } }]);
    expect(r.results[0].message).toMatch(/Ownership in question/);
    const reg = await prisma.bookkeepingAccount.findFirstOrThrow({ where: { clientId: w.biz.id, last4: "2110" } });
    expect(reg).toMatchObject({ ownershipStatus: "IN_QUESTION" });
    expect(reg.ownershipNote).toMatch(/person's name/);
    // Tabitha's decision is kept; the automatic check never overrides it.
    await decideAccountOwnership(w.tabitha, reg.id, "VERIFIED", "Business card in the owner's name");
    await checkAllAccounts({ budgetMs: 10_000, staleHours: 0 });
    expect((await prisma.bookkeepingAccount.findUniqueOrThrow({ where: { id: reg.id } })).ownershipStatus).toBe("VERIFIED");
  });

  it("Coetha can put an account in question herself with the reason; the month's reconciliation then waits", async () => {
    const w = await world();
    const reg = await registerAccount(w.tabitha, w.biz.id, { institution: "Regions", accountType: "CHECKING", last4: "9432", gl: w.checking.id });
    const out = await runVerifyAccountsTool(w.tabitha, w.biz.id, { hold: [{ accountId: reg.id, reason: "Seven statements were attributed to this business without its name on them." }] });
    expect(out.accounts!.find((a) => a.accountId === reg.id)).toMatchObject({ status: "IN_QUESTION" });
    expect(await prisma.auditLog.count({ where: { action: "banking.account_ownership_held", entityId: reg.id } })).toBe(1);
  });
});

describe("warnings judged on the current, corrected ledger", () => {
  it("card payments posted as an expense: corrected ones clear, an uncorrected one still warns; zero balance alone hides nothing", async () => {
    const w = await world();
    const card = await w.gl("2100");
    await importBankCsv(w.tabitha, w.biz.id, w.checking.id, { fileName: "oct.csv", text: "Date,Description,Amount\n10/05/2026,CREDIT CARD PAYMENT AUTOPAY,-400.00\n10/20/2026,CREDIT CARD PAYMENT AUTOPAY,-250.00\n" });
    const expense = await prisma.ledgerAccount.findFirstOrThrow({ where: { clientId: w.biz.id, type: "EXPENSE", subtype: { not: "SUSPENSE" } } });
    for (const t of await prisma.bankTransaction.findMany({ where: { clientId: w.biz.id } })) await categorizeBankTransaction(w.tabitha, w.biz.id, t.id, { accountId: expense.id });
    const warn = async () => (await ledgerFlags(w.tabitha, w.biz.id, "2026-11-17")).find((f) => f.kind === "CARD_PAYMENT_AS_EXPENSE")?.message ?? null;
    expect(await warn()).toMatch(/^2 card or loan payments/);
    // Coetha moves the $400 payment to the card liability with a correcting entry: one warning left.
    await postJournalEntry(w.tabitha, w.biz.id, { date: "2026-10-05", memo: "Card payment is a transfer to the card", lines: [{ accountId: card.id, debit: "400.00" }, { accountId: expense.id, credit: "400.00" }] });
    expect(await warn()).toMatch(/^1 card or loan payment was/);
    // An unrelated $250 expense-to-expense move doesn't resolve it, even though the account then nets lower.
    const other = await prisma.ledgerAccount.findFirstOrThrow({ where: { clientId: w.biz.id, type: "EXPENSE", subtype: { not: "SUSPENSE" }, id: { not: expense.id } } });
    await postJournalEntry(w.tabitha, w.biz.id, { date: "2026-10-20", memo: "Reclass", lines: [{ accountId: other.id, debit: "250.00" }, { accountId: expense.id, credit: "250.00" }] });
    expect(await warn()).toMatch(/^1 card or loan payment was/);
    // The real correction (out of the account the payment was posted to, into the card) clears it.
    await postJournalEntry(w.tabitha, w.biz.id, { date: "2026-10-20", memo: "Card payment is a transfer", lines: [{ accountId: card.id, debit: "250.00" }, { accountId: expense.id, credit: "250.00" }] });
    expect(await warn()).toBeNull();
    // A reversed posting is corrected too, not an open error.
    expect((await ledgerFlags(w.tabitha, w.biz.id, "2026-11-17")).some((f) => f.kind === "CARD_PAYMENT_AS_EXPENSE")).toBe(false);
  });
});
