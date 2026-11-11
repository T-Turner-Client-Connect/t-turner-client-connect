import { beforeEach, describe, expect, it } from "vitest";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { makeUser, prisma, resetDb } from "./db";
import { createClient } from "@/lib/services/clients";
import { saveProfile } from "@/lib/services/bookkeeping-clients";
import { importBankCsv, setupLedger } from "@/lib/services/ledger";
import { approveReconciliation, enterStatementBalances, prepareReconciliation, registerAccount } from "@/lib/services/bank-accounts";
import { staffUploadStatement } from "@/lib/services/client-requests";
import { readStatementsOnFile, readStatementTransactions } from "@/lib/services/statement-import";

// Fictional business, bank and transactions only. Three safeguards Tabitha asked to verify:
// no doubled transactions, balances that carry month to month, and no automatic approval.
beforeEach(resetDb);

const LINES = [
  "Example Community Bank", "MAGNOLIA EXAMPLE LLC", "ACCOUNT # 0000123456", "BUSINESS CHECKING",
  "October 1, 2026 through October 30, 2026",
  "SUMMARY",
  "Beginning Balance $1,000.00 Minimum Balance $900",
  "Deposits & Credits $2,500.00 + Average Balance $1,800",
  "Withdrawals $1,234.56 -", "Fees $35.00 -", "Automatic Transfers $0.00 +", "Checks $450.00 -",
  "Ending Balance $1,780.44",
  "DEPOSITS & CREDITS", "10/02 Mobile Deposit 2,000.00", "10/15 Square Inc Settlement", "SQ 1234 500.00", "Total Deposits & Credits $2,500.00",
  "WITHDRAWALS", "10/03 Card Purchase Office Depot 84.56", "10/09 Online Transfer To Savings 1,000.00", "10/20 ADP Payroll Fees 150.00", "Total Withdrawals $1,234.56",
  "FEES", "10/30 Monthly Service Fee 35.00", "Total Fees $35.00",
  "CHECKS", "Check No. Date Amount Check No. Date Amount", "1001 10/05 200.00 1002 * 10/12 250.00", "Total Checks $450.00",
];
// The same October activity as the bank's own CSV export words it.
const CSV = [
  "Date,Description,Amount",
  "10/02/2026,DEPOSIT REMOTE CAPTURE,2000.00", "10/03/2026,POS PURCHASE OFFICEDEPOT 1123,-84.56", "10/05/2026,CHECK #1001,-200.00",
  "10/09/2026,XFER TO SAV ...7788,-1000.00", "10/12/2026,CHECK #1002,-250.00", "10/15/2026,SQUARE INC SQ 1234,500.00",
  "10/20/2026,ADP PAYROLL FEES,-150.00", "10/30/2026,SERVICE CHARGE,-35.00",
].join("\n");

async function statementPdf(rows: string[]) {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const page = pdf.addPage([612, 1100]);
  let y = 1080;
  for (const l of rows) {
    const m = /^(.*?)\s(\$?[\d,]+\.\d{2}.*)$/.exec(l);
    if (m) { page.drawText(m[1], { x: 40, y, size: 9, font }); page.drawText(m[2], { x: 380, y, size: 9, font }); }
    else page.drawText(l, { x: 40, y, size: 9, font });
    y -= 14;
  }
  return pdf.save();
}

async function world() {
  const tabitha = await makeUser("ADMIN", "Tabitha");
  await prisma.ownerAccess.create({ data: { userId: tabitha.id, isPrimary: true } });
  const daria = await makeUser("STAFF", "Daria");
  const biz = await createClient(tabitha, { businessName: "Magnolia Example LLC (fictional)", clientType: "BUSINESS", status: "ACTIVE", assignedToId: daria.id });
  await saveProfile(tabitha, biz.id, { active: true, frequency: "MONTHLY", payroll: false, payrollFrequency: null, payrollProvider: null });
  await setupLedger(daria, biz.id, { basis: "CASH" });
  const chk = await registerAccount(daria, biz.id, { institution: "Example Community Bank", accountType: "CHECKING", nickname: "Operating", last4: "3456", gl: "NEW" });
  const gl = (await prisma.bookkeepingAccount.findUniqueOrThrow({ where: { id: chk.id } })).ledgerAccountId!;
  const upload = async (name: string, extra: string[] = []) => staffUploadStatement(daria, biz.id, { accountId: chk.id, month: "2026-10", bytes: await statementPdf([...LINES, ...extra]), originalName: name });
  const rows = () => prisma.bankTransaction.count({ where: { clientId: biz.id } });
  const rec = (month: number) => prisma.accountReconciliation.findFirstOrThrow({ where: { bookkeepingAccountId: chk.id, year: 2026, month } });
  return { tabitha, daria, biz, chk, gl, upload, rows, rec };
}

describe("1. No duplicated transactions", () => {
  it("the same statement uploaded twice imports its transactions once", async () => {
    const w = await world();
    const bytes = await statementPdf(LINES);
    const first = await staffUploadStatement(w.daria, w.biz.id, { accountId: w.chk.id, month: "2026-10", bytes, originalName: "october.pdf" });
    expect(await readStatementTransactions(w.daria, w.biz.id, first.id)).toMatchObject({ ok: true, added: 8 });
    // The identical file is refused at upload ...
    await expect(staffUploadStatement(w.daria, w.biz.id, { accountId: w.chk.id, month: "2026-10", bytes, originalName: "october (1).pdf" })).rejects.toThrow(/already saved/);
    // ... and a re-downloaded copy of the same statement (different file, same content) adds nothing.
    expect(await readStatementTransactions(w.daria, w.biz.id, (await w.upload("october-copy.pdf", ["Page 1 of 1"])).id)).toMatchObject({ ok: true, added: 0, duplicates: 8 });
    expect(await w.rows()).toBe(8);
  });

  it("a bank CSV already imported and the PDF statement of the same month (worded differently) count once, in either order", async () => {
    const w = await world();
    const csv = await importBankCsv(w.daria, w.biz.id, w.gl, { fileName: "october.csv", text: CSV });
    expect(csv.added).toBe(8);
    const r = await readStatementTransactions(w.daria, w.biz.id, (await w.upload("october.pdf")).id);
    expect(r).toMatchObject({ ok: true, added: 0, duplicates: 8 });
    expect(await w.rows()).toBe(8);
    // The statement still fills in the month's balances, and the month proves out to the cent.
    expect(await w.rec(10)).toMatchObject({ beginningBalanceCents: 100000, endingBalanceCents: 178044, differenceCents: 0 });

    await resetDb();
    const v = await world();
    expect(await readStatementTransactions(v.daria, v.biz.id, (await v.upload("october.pdf")).id)).toMatchObject({ ok: true, added: 8 });
    const again = await importBankCsv(v.daria, v.biz.id, v.gl, { fileName: "october.csv", text: CSV });
    expect(again.added).toBe(0);
    expect(await v.rows()).toBe(8);
  });

  it("a transaction just outside a file's period is never merged with a different one", async () => {
    const w = await world();
    // September's CSV ends with a $2,000.00 deposit on 9/30; October's statement has its own on 10/2.
    await importBankCsv(w.daria, w.biz.id, w.gl, { fileName: "september.csv", text: "Date,Description,Amount\n09/28/2026,ADP PAYROLL FEES,-150.00\n09/30/2026,DEPOSIT REMOTE CAPTURE,2000.00" });
    expect(await readStatementTransactions(w.daria, w.biz.id, (await w.upload("october.pdf")).id)).toMatchObject({ ok: true, added: 8 });
    expect(await w.rows()).toBe(10);
  });
});

describe("2. Accurate monthly balances", () => {
  it("each month must start where the last one ended; a mismatch is flagged, never forced to zero", async () => {
    const w = await world();
    await enterStatementBalances(w.daria, w.biz.id, w.chk.id, 2026, 9, { beginning: "900.00", ending: "950.00" });
    await readStatementTransactions(w.daria, w.biz.id, (await w.upload("october.pdf")).id);
    const oct = await w.rec(10);
    expect(oct.status).toBe("EXCEPTION");
    expect(oct.exceptions).toContainEqual(expect.stringContaining("doesn't match last month's ending balance ($950.00)"));
    expect(oct.differenceCents).toBe(0); // the October activity itself proves out; the gap is between months

    // Corrected September ending: the flag clears and October goes back to normal review.
    await enterStatementBalances(w.daria, w.biz.id, w.chk.id, 2026, 9, { ending: "1000.00" });
    const fixed = await prepareReconciliation(w.biz.id, w.chk.id, 2026, 10);
    expect(fixed!.exceptions.some((e) => e.includes("last month's ending"))).toBe(false);
    expect(fixed!.status).toBe("IN_PROGRESS");
  });

  it("a deposit in twice is pointed out by name; a difference is never posted away", async () => {
    const w = await world();
    await readStatementTransactions(w.daria, w.biz.id, (await w.upload("october.pdf")).id);
    await prisma.bankTransaction.create({ data: { clientId: w.biz.id, accountId: w.gl, date: new Date("2026-10-02T00:00:00Z"), amountCents: 200000, description: "Mobile Deposit (entered again)", fingerprint: "fictional-duplicate", source: "CSV" } });
    const rec = await prepareReconciliation(w.biz.id, w.chk.id, 2026, 10);
    expect(rec!.status).toBe("EXCEPTION");
    expect(Math.abs(rec!.differenceCents!)).toBe(200000);
    expect(rec!.exceptions).toContainEqual(expect.stringContaining("$2,000.00 deposit on 2026-10-02 that appears twice"));
    expect(await prisma.journalEntry.count({ where: { clientId: w.biz.id } })).toBe(0);
  });
});

describe("3. No accidental approval", () => {
  it("reading statements never approves a reconciliation or posts the opening cash; only Tabitha approves, and the opening posts once", async () => {
    const w = await world();
    const doc = await w.upload("october.pdf");
    await readStatementTransactions(w.daria, w.biz.id, doc.id);
    await readStatementTransactions(w.daria, w.biz.id, doc.id);
    const rec = await w.rec(10);
    expect(rec.status).not.toBe("APPROVED");
    expect(rec.approvedAt).toBeNull();
    expect(await prisma.bankReconciliation.count()).toBe(0);
    expect(await prisma.journalEntry.count({ where: { clientId: w.biz.id } })).toBe(0);
    await expect(approveReconciliation(w.daria, w.biz.id, rec.id)).rejects.toThrow();

    // "Also post opening cash", pressed twice: one opening entry.
    await readStatementsOnFile(w.daria, w.biz.id, w.chk.id, { postOpening: true });
    await readStatementsOnFile(w.daria, w.biz.id, w.chk.id, { postOpening: true });
    expect(await prisma.journalEntry.count({ where: { clientId: w.biz.id, sourceKey: "opening" } })).toBe(1);
    expect((await w.rec(10)).status).not.toBe("APPROVED");
  });
});
