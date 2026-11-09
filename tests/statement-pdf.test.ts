import { beforeEach, describe, expect, it } from "vitest";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { makeUser, prisma, resetDb } from "./db";
import { createClient } from "@/lib/services/clients";
import { saveProfile } from "@/lib/services/bookkeeping-clients";
import { setupLedger } from "@/lib/services/ledger";
import { registerAccount } from "@/lib/services/bank-accounts";
import { staffUploadStatement } from "@/lib/services/client-requests";
import { readStatementTransactions } from "@/lib/services/statement-import";
import { parseStatementLines, pdfLines } from "@/lib/statement-pdf";

// A fictional statement laid out like a typical bank statement (summary, then sections).
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

describe("Reading a statement PDF", () => {
  it("reads every section and reconciles to the cent", () => {
    const r = parseStatementLines(LINES);
    expect(r.summary).toMatchObject({ beginningCents: 100000, endingCents: 178044, periodStart: "2026-10-01", periodEnd: "2026-10-30" });
    expect(r.transactions).toHaveLength(8);
    expect(r.transactions.find((t) => t.description.startsWith("Square"))).toMatchObject({ date: "2026-10-15", amountCents: 50000, description: "Square Inc Settlement SQ 1234" });
    expect(r.transactions.filter((t) => t.section === "CHECKS").map((t) => [t.description, t.date, t.amountCents])).toEqual([["Check 1001", "2026-10-05", -20000], ["Check 1002", "2026-10-12", -25000]]);
    expect(r.check).toMatchObject({ ok: true, differenceCents: 0, netCents: 78044 });
  });

  it("refuses a statement whose transactions don't add up", () => {
    const r = parseStatementLines(LINES.filter((l) => !l.includes("Office Depot")));
    expect(r.check.ok).toBe(false);
    expect(r.check.problems.join(" ")).toMatch(/unaccounted|Withdrawals read/);
  });

  it("works from a real PDF (text rebuilt line by line)", async () => {
    const lines = await pdfLines(await statementPdf(LINES));
    expect(lines).not.toBeNull();
    expect(parseStatementLines(lines!).check.ok).toBe(true);
  });
});

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

describe("Reading a statement that's on file into the books", () => {
  beforeEach(resetDb);

  async function world() {
    const tabitha = await makeUser("ADMIN", "Tabitha");
    await prisma.ownerAccess.create({ data: { userId: tabitha.id, isPrimary: true } });
    const daria = await makeUser("STAFF", "Daria");
    const eve = await makeUser("STAFF", "Eve");
    const biz = await createClient(tabitha, { businessName: "Magnolia Example LLC (fictional)", clientType: "BUSINESS", status: "ACTIVE", assignedToId: daria.id });
    await saveProfile(tabitha, biz.id, { active: true, frequency: "MONTHLY", payroll: false, payrollFrequency: null, payrollProvider: null });
    await setupLedger(daria, biz.id, { basis: "CASH" });
    const chk = await registerAccount(daria, biz.id, { institution: "Example Community Bank", accountType: "CHECKING", nickname: "Operating", last4: "3456", gl: "NEW" });
    return { tabitha, daria, eve, biz, chk };
  }

  it("imports every transaction, fills in the statement balances and leaves no difference; reading again adds nothing", async () => {
    const w = await world();
    const doc = await staffUploadStatement(w.daria, w.biz.id, { accountId: w.chk.id, month: "2026-10", bytes: await statementPdf(LINES), originalName: "october.pdf" });
    const r = await readStatementTransactions(w.daria, w.biz.id, doc.id);
    expect(r).toMatchObject({ ok: true, read: 8, added: 8, duplicates: 0, beginningCents: 100000, endingCents: 178044, via: "PDF" });
    const rows = await prisma.bankTransaction.findMany({ where: { clientId: w.biz.id }, orderBy: { date: "asc" } });
    expect(rows.every((x) => x.status === "UNREVIEWED" && !x.journalEntryId)).toBe(true);
    expect(rows.reduce((n, x) => n + x.amountCents, 0)).toBe(78044);
    const rec = await prisma.accountReconciliation.findFirstOrThrow({ where: { bookkeepingAccountId: w.chk.id, year: 2026, month: 10 } });
    expect(rec).toMatchObject({ beginningBalanceCents: 100000, endingBalanceCents: 178044, differenceCents: 0, transactionsImported: 8, status: "IN_PROGRESS" });
    expect(await prisma.journalEntry.count({ where: { clientId: w.biz.id } })).toBe(0);
    const again = await readStatementTransactions(w.daria, w.biz.id, doc.id);
    expect(again).toMatchObject({ ok: true, added: 0, duplicates: 8 });
    expect(await prisma.bankTransaction.count({ where: { clientId: w.biz.id } })).toBe(8);
  });

  it("imports nothing when the statement doesn't add up, and only staff on this client's books can read it", async () => {
    const w = await world();
    const doc = await staffUploadStatement(w.daria, w.biz.id, { accountId: w.chk.id, month: "2026-10", bytes: await statementPdf(LINES.filter((l) => !l.includes("Office Depot"))), originalName: "october.pdf" });
    await expect(readStatementTransactions(w.eve, w.biz.id, doc.id)).rejects.toThrow();
    const r = await readStatementTransactions(w.daria, w.biz.id, doc.id);
    expect(r.ok).toBe(false);
    expect(await prisma.bankTransaction.count({ where: { clientId: w.biz.id } })).toBe(0);
  });
});

describe("An account registered before the books were set up (the statements still import)", () => {
  beforeEach(resetDb);

  async function world(linkFirst: boolean) {
    const tabitha = await makeUser("ADMIN", "Tabitha");
    await prisma.ownerAccess.create({ data: { userId: tabitha.id, isPrimary: true } });
    const biz = await createClient(tabitha, { businessName: "Willow Example LLC (fictional)", clientType: "BUSINESS", status: "ACTIVE" });
    await saveProfile(tabitha, biz.id, { active: true, frequency: "MONTHLY", payroll: false, payrollFrequency: null, payrollProvider: null });
    return { tabitha, biz, linkFirst };
  }

  it("setting up the books links the already-registered account to the unused 1000 Business Checking", async () => {
    const w = await world(true);
    const chk = await registerAccount(w.tabitha, w.biz.id, { institution: "Example Community Bank", accountType: "CHECKING", last4: "3456" });
    expect((await prisma.bookkeepingAccount.findUniqueOrThrow({ where: { id: chk.id } })).ledgerAccountId).toBeNull();
    await setupLedger(w.tabitha, w.biz.id, { basis: "CASH" });
    const linked = await prisma.bookkeepingAccount.findUniqueOrThrow({ where: { id: chk.id }, include: { ledgerAccount: true } });
    expect(linked.ledgerAccount?.code).toBe("1000");
    expect(await prisma.ledgerAccount.count({ where: { clientId: w.biz.id, subtype: "BANK" } })).toBe(1);
  });

  it("a statement already on file for an unlinked account is read: the account is linked, nothing is uploaded again, and the opening cash can be posted", async () => {
    const w = await world(false);
    // The state found in production: books set up after the account, account left without a GL account.
    const chk = await registerAccount(w.tabitha, w.biz.id, { institution: "Example Community Bank", accountType: "CHECKING", last4: "3456" });
    await prisma.ledgerBook.create({ data: { clientId: w.biz.id, basis: "CASH", fiscalYearStartMonth: 1, createdById: w.tabitha.id } });
    const { DEFAULT_CHART } = await import("@/lib/services/ledger");
    await prisma.ledgerAccount.createMany({ data: DEFAULT_CHART.map((a) => ({ clientId: w.biz.id, code: a.code, name: a.name, type: a.type, subtype: a.subtype ?? null })) });
    await staffUploadStatement(w.tabitha, w.biz.id, { accountId: chk.id, month: "2026-10", bytes: await statementPdf(LINES), originalName: "october.pdf" });
    expect(await prisma.bankTransaction.count({ where: { clientId: w.biz.id } })).toBe(0);

    const { readStatementsOnFile } = await import("@/lib/services/statement-import");
    const r = await readStatementsOnFile(w.tabitha, w.biz.id, chk.id, { postOpening: true });
    expect(r.results).toMatchObject([{ month: "2026-10", ok: true, added: 8 }]);
    expect(r.opening).toMatch(/\$1,000\.00 posted on 2026-10-01/);
    expect((await prisma.bookkeepingAccount.findUniqueOrThrow({ where: { id: chk.id }, include: { ledgerAccount: true } })).ledgerAccount?.code).toBe("1000");
    // Transactions wait for review; nothing is posted except the opening entry, which balances on its own.
    expect(await prisma.bankTransaction.count({ where: { clientId: w.biz.id, status: "UNREVIEWED" } })).toBe(8);
    const entries = await prisma.journalEntry.findMany({ where: { clientId: w.biz.id }, include: { lines: true } });
    expect(entries).toHaveLength(1);
    expect(entries[0].lines.reduce((n, l) => n + l.debitCents - l.creditCents, 0)).toBe(0);

    // Reading again adds nothing and posts no second opening.
    const again = await readStatementsOnFile(w.tabitha, w.biz.id, chk.id, { postOpening: true });
    expect(again.results[0]).toMatchObject({ ok: true, added: 0 });
    expect(await prisma.journalEntry.count({ where: { clientId: w.biz.id } })).toBe(1);
  });
});

describe("Upload bank statements (no account or month to choose)", () => {
  beforeEach(resetDb);

  it("finds the account and month on each statement, imports it, refuses another business's statement, and can start the books", async () => {
    const tabitha = await makeUser("ADMIN", "Tabitha");
    await prisma.ownerAccess.create({ data: { userId: tabitha.id, isPrimary: true } });
    const biz = await createClient(tabitha, { businessName: "Aspen Example LLC (fictional)", clientType: "BUSINESS", status: "ACTIVE" });
    await saveProfile(tabitha, biz.id, { active: true, frequency: "MONTHLY", payroll: false, payrollFrequency: null, payrollProvider: null });
    await setupLedger(tabitha, biz.id, { basis: "CASH" });
    const chk = await registerAccount(tabitha, biz.id, { institution: "Example Community Bank", accountType: "CHECKING", last4: "3456" });
    await registerAccount(tabitha, biz.id, { institution: "Example Savings Bank", accountType: "SAVINGS", last4: "7777" });

    const { uploadStatementsAuto } = await import("@/lib/services/statement-import");
    const otherBusiness = LINES.map((l) => l.replace("0000123456", "0000555511"));
    const r = await uploadStatementsAuto(tabitha, biz.id, [
      { bytes: await statementPdf(LINES), originalName: "october.pdf" },
      { bytes: await statementPdf(otherBusiness), originalName: "someone-else.pdf" },
      { bytes: new TextEncoder().encode("Date,Description,Amount\n"), originalName: "export.csv" },
    ], { postOpening: true });

    expect(r.results[0]).toMatchObject({ ok: true, month: "2026-10", account: "••3456" });
    expect(r.results[0].message).toMatch(/8 transactions added/);
    expect(r.results[1]).toMatchObject({ ok: false });
    expect(r.results[1].message).toMatch(/ending 5511, which isn't registered/);
    expect(r.results[2].message).toMatch(/Only statement PDFs/);
    expect(r.opening).toMatch(/\$1,000\.00 posted on 2026-10-01/);

    // Filed to the right account and month; the other business's statement was never filed.
    const docs = await prisma.document.findMany({ where: { clientId: biz.id, bookkeepingAccountId: { not: null } } });
    expect(docs.map((d) => [d.bookkeepingAccountId, d.year, d.month])).toEqual([[chk.id, 2026, 10]]);
    expect(await prisma.bankTransaction.count({ where: { clientId: biz.id, status: "UNREVIEWED" } })).toBe(8);
  });
});
