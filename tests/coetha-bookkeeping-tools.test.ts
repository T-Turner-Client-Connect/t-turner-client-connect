import { beforeEach, describe, expect, it } from "vitest";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { makeUser, prisma, resetDb } from "./db";
import { createClient } from "@/lib/services/clients";
import { saveProfile } from "@/lib/services/bookkeeping-clients";
import { setupLedger } from "@/lib/services/ledger";
import { registerAccount } from "@/lib/services/bank-accounts";
import { staffUploadStatement } from "@/lib/services/client-requests";
import { readStatementTransactions } from "@/lib/services/statement-import";
import { reconcileAccounts, removeVerifiedDuplicates } from "@/lib/services/coetha-bookkeeping";

// Fictional business, bank and statement. Database effects only (no AI).
beforeEach(resetDb);

const LINES = [
  "Example Community Bank", "MAGNOLIA EXAMPLE LLC", "ACCOUNT # 0000123456", "BUSINESS CHECKING",
  "October 1, 2026 through October 30, 2026", "SUMMARY",
  "Beginning Balance $1,000.00 Minimum Balance $900",
  "Deposits & Credits $2,500.00 + Average Balance $1,800",
  "Withdrawals $1,234.56 -", "Fees $35.00 -", "Automatic Transfers $0.00 +", "Checks $450.00 -",
  "Ending Balance $1,780.44",
  "DEPOSITS & CREDITS", "10/02 Mobile Deposit 2,000.00", "10/15 Square Inc Settlement", "SQ 1234 500.00", "Total Deposits & Credits $2,500.00",
  "WITHDRAWALS", "10/03 Card Purchase Office Depot 84.56", "10/09 Online Transfer To Savings 1,000.00", "10/20 ADP Payroll Fees 150.00", "Total Withdrawals $1,234.56",
  "FEES", "10/30 Monthly Service Fee 35.00", "Total Fees $35.00",
  "CHECKS", "Check No. Date Amount Check No. Date Amount", "1001 10/05 200.00 1002 * 10/12 250.00", "Total Checks $450.00",
];
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
  const biz = await createClient(tabitha, { businessName: "Magnolia Example LLC (fictional)", clientType: "BUSINESS", status: "ACTIVE" });
  await saveProfile(tabitha, biz.id, { active: true, frequency: "MONTHLY", payroll: false, payrollFrequency: null, payrollProvider: null });
  await setupLedger(tabitha, biz.id, { basis: "CASH" });
  const chk = await registerAccount(tabitha, biz.id, { institution: "Example Community Bank", accountType: "CHECKING", nickname: "Operating", last4: "3456", gl: "NEW" });
  const gl = (await prisma.bookkeepingAccount.findUniqueOrThrow({ where: { id: chk.id } })).ledgerAccountId!;
  const doc = await staffUploadStatement(tabitha, biz.id, { accountId: chk.id, month: "2026-10", bytes: await statementPdf(LINES), originalName: "october.pdf" });
  await prisma.document.update({ where: { id: doc.id }, data: { scanStatus: "CLEAN" } });
  expect(await readStatementTransactions(tabitha, biz.id, doc.id)).toMatchObject({ ok: true, added: 8 });
  return { tabitha, biz, chk, gl };
}

describe("Coetha's bookkeeping tools change the books, verified against the statement", () => {
  it("excludes only the rows the statement proves are duplicate imports; repeated descriptions on other days stay", async () => {
    const w = await world();
    // A second import of two of the same transactions (worded differently, as a bank feed would).
    for (const [d, c, desc] of [["2026-10-03", -8456, "POS OFFICEDEPOT 1123"], ["2026-10-20", -15000, "ADP PAYROLL FEES DUP"]] as const) {
      await prisma.bankTransaction.create({ data: { clientId: w.biz.id, accountId: w.gl, date: new Date(`${d}T00:00:00Z`), amountCents: c, description: desc, fingerprint: `dup-${d}`, source: "PLAID" } });
    }
    // The same vendor again on a different day is a real transaction, not a duplicate (not on this statement: left for a person).
    await prisma.bankTransaction.create({ data: { clientId: w.biz.id, accountId: w.gl, date: new Date("2026-10-25T00:00:00Z"), amountCents: -8456, description: "Card Purchase Office Depot", fingerprint: "real-1025", source: "PLAID" } });
    const dry = await removeVerifiedDuplicates(w.tabitha, w.biz.id, { month: "2026-10", dryRun: true });
    expect(dry.removed.map((d) => d.date).sort()).toEqual(["2026-10-03", "2026-10-20"]);
    expect(await prisma.bankTransaction.count({ where: { clientId: w.biz.id, status: "EXCLUDED" } })).toBe(0);
    const r = await removeVerifiedDuplicates(w.tabitha, w.biz.id, { month: "2026-10" });
    expect(r.removed).toHaveLength(2);
    const excluded = await prisma.bankTransaction.findMany({ where: { clientId: w.biz.id, status: "EXCLUDED" } });
    expect(excluded).toHaveLength(2);
    expect(excluded.every((t) => /^Duplicate import: the .+ shows/.test(t.excludedReason ?? ""))).toBe(true);
    expect(await prisma.auditLog.count({ where: { action: "coetha.duplicate_excluded", clientId: w.biz.id } })).toBe(2);
    // The 10/25 row and every statement row are untouched.
    expect(await prisma.bankTransaction.count({ where: { clientId: w.biz.id, status: "UNREVIEWED" } })).toBe(9);
    // Running it again changes nothing.
    expect((await removeVerifiedDuplicates(w.tabitha, w.biz.id, { month: "2026-10" })).removed).toHaveLength(0);
  });

  it("without a readable statement, nothing is excluded; the account is reported instead", async () => {
    const w = await world();
    await prisma.document.updateMany({ where: { clientId: w.biz.id }, data: { deletedAt: new Date() } });
    await prisma.bankTransaction.create({ data: { clientId: w.biz.id, accountId: w.gl, date: new Date("2026-10-03T00:00:00Z"), amountCents: -8456, description: "POS OFFICEDEPOT", fingerprint: "dup-x", source: "PLAID" } });
    const r = await removeVerifiedDuplicates(w.tabitha, w.biz.id, { month: "2026-10" });
    expect(r.removed).toHaveLength(0);
    expect(r.unverified[0].why).toMatch(/no statement on file/);
    expect(await prisma.bankTransaction.count({ where: { clientId: w.biz.id, status: "EXCLUDED" } })).toBe(0);
  });

  it("reconciles from the statement on file and reports the difference as it is (no plug entry, no approval)", async () => {
    const w = await world();
    const before = await prisma.journalEntry.count({ where: { clientId: w.biz.id } });
    const r = await reconcileAccounts(w.tabitha, w.biz.id, { month: "2026-10" });
    expect(r.accounts).toHaveLength(1);
    expect(r.accounts[0]).toMatchObject({ beginning: "$1,000.00", ending: "$1,780.44" });
    const rec = await prisma.accountReconciliation.findFirstOrThrow({ where: { bookkeepingAccountId: w.chk.id, year: 2026, month: 10 } });
    expect(rec.status).not.toBe("APPROVED");
    expect(await prisma.journalEntry.count({ where: { clientId: w.biz.id } })).toBe(before);
  });
});
