import { beforeEach, describe, expect, it } from "vitest";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { makeUser, prisma, resetDb } from "./db";
import { createClient } from "@/lib/services/clients";
import { saveProfile } from "@/lib/services/bookkeeping-clients";
import { categorizeBankTransaction, importBankCsv, setupLedger } from "@/lib/services/ledger";
import { registerAccount } from "@/lib/services/bank-accounts";
import { setOwnerSwitch } from "@/lib/services/owner-switches";
import { importPriorMonths } from "@/lib/services/coetha-bookkeeping";
import { bookkeepingChat, uploadPriorPackage } from "@/lib/services/bookkeeping-queue";

// Fictional business and package only. Database effects are checked, not wording.
beforeEach(resetDb);

async function pkg(name: string) {
  const d = await PDFDocument.create();
  const f = await d.embedFont(StandardFonts.Helvetica);
  const p = d.addPage([792, 612]);
  const rows = [
    "Financial Statements", `Prepared for: ${name}`, "Cash Basis • January 1 – February 28, 2026",
    "Profit & Loss — Jan Feb YTD", "Commission Income $1,000.00 $2,000.00 $3,000.00", "Rent $400.00 $400.00 $800.00",
    "Owner's Draw $300.00 $500.00 $800.00", "Balance Sheet — Business Checking $1,400.00",
  ];
  let y = 580;
  for (const r of rows) { p.drawText(r, { x: 30, y, size: 10, font: f }); y -= 16; }
  return d.save();
}

async function world() {
  const tabitha = await makeUser("ADMIN", "Tabitha");
  await prisma.ownerAccess.create({ data: { userId: tabitha.id, isPrimary: true } });
  const biz = await createClient(tabitha, { businessName: "Juniper Example Agency LLC", clientType: "BUSINESS", status: "ACTIVE" });
  const other = await createClient(tabitha, { businessName: "Laurel Example Bakery LLC", clientType: "BUSINESS", status: "ACTIVE" });
  for (const c of [biz, other]) {
    await saveProfile(tabitha, c.id, { active: true, frequency: "MONTHLY", payroll: false, payrollFrequency: null, payrollProvider: null });
    await setupLedger(tabitha, c.id, { basis: "CASH" });
  }
  const chk = await registerAccount(tabitha, biz.id, { institution: "Example Community Bank", accountType: "CHECKING", last4: "4242", gl: "NEW" });
  const gl = (await prisma.bookkeepingAccount.findUniqueOrThrow({ where: { id: chk.id } })).ledgerAccountId!;
  await setOwnerSwitch(tabitha, "coetha", true);
  await setOwnerSwitch(tabitha, "coethaAutoPost", true);
  const code = async (type: string) => (await prisma.ledgerAccount.findFirstOrThrow({ where: { clientId: biz.id, type }, orderBy: { code: "asc" } })).code;
  return { tabitha, biz, other, gl, inc: await code("INCOME"), exp: await code("EXPENSE"), eq: await code("EQUITY") };
}

type Res = { results: { month: string; ok: boolean; message: string }[]; cashCheck: string | null };
const res = (x: unknown) => x as Res;
const bankBalance = async (gl: string) => {
  const a = await prisma.journalLine.aggregate({ where: { accountId: gl }, _sum: { debitCents: true, creditCents: true } });
  return (a._sum.debitCents ?? 0) - (a._sum.creditCents ?? 0);
};

describe("Months that exist only in a financial package already prepared", () => {
  it("the package is matched to its client by the name printed in it, saved once, and queued for Coetha", async () => {
    const w = await world();
    const bytes = await pkg("Juniper Example Agency LLC");
    const r = await uploadPriorPackage(w.tabitha, { bytes, originalName: "juniper-jan-feb.pdf" });
    expect(r).toMatchObject({ matched: true, client: "Juniper Example Agency LLC" });
    expect(await prisma.document.count({ where: { clientId: w.biz.id } })).toBe(1);
    expect(await prisma.coethaAnswerRun.count({ where: { clientId: w.biz.id, chatId: bookkeepingChat(w.biz.id) } })).toBe(1);
    // The same file again: nothing saved or queued twice.
    await uploadPriorPackage(w.tabitha, { bytes, originalName: "juniper copy.pdf" });
    expect(await prisma.document.count({ where: { clientId: w.biz.id } })).toBe(1);
    expect(await prisma.coethaAnswerRun.count({ where: { clientId: w.biz.id } })).toBe(1);
    // A package whose name matches no client is reported, never guessed.
    expect(await uploadPriorPackage(w.tabitha, { bytes: await pkg("Unknown Example Corp"), originalName: "x.pdf" })).toMatchObject({ matched: false });
  });

  it("enters each month once from the package, checks every amount against it, never re-enters a month already in the books, and reports the cash comparison", async () => {
    const w = await world();
    const up = await uploadPriorPackage(w.tabitha, { bytes: await pkg("Juniper Example Agency LLC"), originalName: "juniper.pdf" });
    const docId = (up as { documentId: string }).documentId;
    const months = [
      { month: "2026-01", lines: [{ accountCode: w.inc, amount: 1000 }, { accountCode: w.exp, amount: 400 }, { accountCode: w.eq, amount: 300, kind: "draw" as const }] },
      { month: "2026-02", lines: [{ accountCode: w.inc, amount: 2000 }, { accountCode: w.exp, amount: 400 }, { accountCode: w.eq, amount: 500, kind: "draw" as const }] },
    ];
    const r = await importPriorMonths(w.tabitha, w.biz.id, { documentId: docId, months, packageEndingCash: 1400 });
    expect(res(r).results.every((x) => x.ok)).toBe(true);
    expect(await prisma.journalEntry.count({ where: { clientId: w.biz.id, sourceKey: { startsWith: "prior-package:" } } })).toBe(2);
    expect(await bankBalance(w.gl)).toBe(140000);
    expect(res(r).cashCheck).toMatch(/agrees with the package at \$1,400\.00/);
    // Again: nothing doubled.
    const again = await importPriorMonths(w.tabitha, w.biz.id, { documentId: docId, months });
    expect(res(again).results.every((x) => !x.ok && /Already in the books/.test(x.message))).toBe(true);
    expect(await prisma.journalEntry.count({ where: { clientId: w.biz.id, sourceKey: { startsWith: "prior-package:" } } })).toBe(2);
    // An amount that isn't printed in the package is refused.
    const bad = await importPriorMonths(w.tabitha, w.biz.id, { documentId: docId, months: [{ month: "2026-03", lines: [{ accountCode: w.exp, amount: 999.99 }] }] });
    expect(res(bad).results[0].message).toMatch(/isn't printed in the package/);
    // A different ending cash is reported as a difference, never plugged.
    const diff = await importPriorMonths(w.tabitha, w.biz.id, { documentId: docId, months: [{ month: "2026-02", lines: [] }], packageEndingCash: 1960.11 });
    expect(res(diff).cashCheck).toMatch(/difference of -\$560\.11 — reported as an exception, not adjusted/);
    expect(await bankBalance(w.gl)).toBe(140000);
  });

  it("a month that already has bank postings is never entered from the package", async () => {
    const w = await world();
    const up = await uploadPriorPackage(w.tabitha, { bytes: await pkg("Juniper Example Agency LLC"), originalName: "juniper.pdf" });
    const docId = (up as { documentId: string }).documentId;
    await importBankCsv(w.tabitha, w.biz.id, w.gl, { fileName: "jan.csv", text: "Date,Description,Amount\n01/15/2026,DEPOSIT,1000.00" });
    const row = await prisma.bankTransaction.findFirstOrThrow({ where: { clientId: w.biz.id } });
    const inc = await prisma.ledgerAccount.findFirstOrThrow({ where: { clientId: w.biz.id, code: w.inc } });
    await categorizeBankTransaction(w.tabitha, w.biz.id, row.id, { accountId: inc.id });
    const r = await importPriorMonths(w.tabitha, w.biz.id, { documentId: docId, months: [{ month: "2026-01", lines: [{ accountCode: w.inc, amount: 1000 }] }] });
    expect(res(r).results[0]).toMatchObject({ ok: false });
    expect(await prisma.journalEntry.count({ where: { clientId: w.biz.id, sourceKey: { startsWith: "prior-package:" } } })).toBe(0);
  });

  it("without the standing authorization nothing is entered", async () => {
    const w = await world();
    await setOwnerSwitch(w.tabitha, "coethaAutoPost", false);
    const up = await uploadPriorPackage(w.tabitha, { bytes: await pkg("Juniper Example Agency LLC"), originalName: "juniper.pdf" });
    const r = await importPriorMonths(w.tabitha, w.biz.id, { documentId: (up as { documentId: string }).documentId, months: [{ month: "2026-01", lines: [{ accountCode: w.inc, amount: 1000 }] }] });
    expect(r).toMatchObject({ error: expect.stringMatching(/standing authorization is off/) });
  });
});
