import { beforeEach, describe, expect, it, vi } from "vitest";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { makeUser, prisma, resetDb } from "./db";
import { createClient } from "@/lib/services/clients";
import { saveProfile } from "@/lib/services/bookkeeping-clients";
import { setupLedger } from "@/lib/services/ledger";
import { registerAccount } from "@/lib/services/bank-accounts";
import { applyBankingReference, importBankingList, sameBank, sameEnding } from "@/lib/services/bank-reference";
import { verifyAccount } from "@/lib/services/account-ownership";
import { staffUploadDocument } from "@/lib/services/documents";

// The list reader stands in for Coetha reading the PDF; everything after it is the real code.
vi.mock("@/lib/coetha-model", async (orig) => ({
  ...(await orig<typeof import("@/lib/coetha-model")>()),
  callBankingListReader: vi.fn(async () => ({ model: "test", output: { rows: [
    { owner: "Pat Example", business: "Maple Example Studio LLC (fictional)", accounts: [{ institution: "Riverbend Example Bank - Business Checking", kind: "CHECKING", ending: "9432", note: "" }] },
    { owner: "Lee Example", business: "Birch Example Courier LLC (fictional)", accounts: [{ institution: "Example FCU", kind: "CHECKING", ending: "181", note: "" }, { institution: "Example FCU", kind: "SAVINGS", ending: "170-00", note: "" }] },
    { owner: "Nobody Example", business: "Not A Client LLC", accounts: [{ institution: "Some Bank", kind: "CHECKING", ending: "1111", note: "" }] },
  ] } })),
}));

// Fictional businesses, banks and account endings only.
beforeEach(async () => { await resetDb(); });

async function world() {
  const tabitha = await makeUser("ADMIN", "Tabitha");
  await prisma.ownerAccess.create({ data: { userId: tabitha.id, isPrimary: true } });
  const maple = await createClient(tabitha, { businessName: "Maple Example Studio LLC (fictional)", clientType: "BUSINESS", status: "ACTIVE" });
  const birch = await createClient(tabitha, { businessName: "Birch Example Courier LLC (fictional)", clientType: "BUSINESS", status: "ACTIVE" });
  for (const c of [maple, birch]) {
    await saveProfile(tabitha, c.id, { active: true, frequency: "MONTHLY", payroll: false, payrollFrequency: null, payrollProvider: null });
    await setupLedger(tabitha, c.id, { basis: "CASH" });
  }
  return { tabitha, maple, birch };
}

const statementPdf = async (lines: string[]) => {
  const d = await PDFDocument.create(); const f = await d.embedFont(StandardFonts.Helvetica); const p = d.addPage([612, 300]);
  lines.forEach((t, i) => p.drawText(t, { x: 30, y: 260 - i * 16, size: 10, font: f }));
  return d.save();
};

const listPdf = async () => {
  const d = await PDFDocument.create(); const f = await d.embedFont(StandardFonts.Helvetica);
  d.addPage([612, 200]).drawText("Client banking list (fictional)", { x: 30, y: 150, size: 10, font: f });
  return d.save();
};

describe("Tabitha's banking list, applied by Coetha", () => {
  it("matches banks and endings the way banks print them", () => {
    expect(sameBank("Regions", "Regions Bank - LifeGreen Business Checking")).toBe(true);
    expect(sameBank("Chase", "Regions")).toBe(false);
    expect(sameEnding("181", "0181")).toBe(true);
    expect(sameEnding("170-02", "17002")).toBe(true);
    expect(sameEnding("10", "9010")).toBe(false);
  });

  it("an unnamed 'Chase' checking account takes the list's bank and ending; only a statement verifies it; a card not on the list is flagged, not blocked; nothing in the books changes", async () => {
    const w = await world();
    const wrong = await registerAccount(w.tabitha, w.maple.id, { institution: "Chase", accountType: "CHECKING", gl: "NEW" });
    const card = await registerAccount(w.tabitha, w.maple.id, { institution: "Chase", accountType: "CREDIT_CARD", last4: "2110", gl: "NEW" });
    await prisma.bookkeepingProfile.update({ where: { clientId: w.maple.id }, data: { bankingReference: [{ institution: "Riverbend Example Bank", kind: "CHECKING", ending: "9432", note: "" }] } });
    const entries = await prisma.journalEntry.count({ where: { clientId: w.maple.id } });
    const r = await applyBankingReference(w.tabitha, w.maple.id);
    expect(r.corrected[0]).toMatch(/Chase → Riverbend Example Bank ••9432/);
    // Corrected from the list, but not verified by it: that takes a statement showing the business.
    expect(await prisma.bookkeepingAccount.findUniqueOrThrow({ where: { id: wrong.id } })).toMatchObject({ institution: "Riverbend Example Bank", last4: "9432", ownershipStatus: "NOT_CHECKED" });
    // Not on the list: flagged in its note, nothing blocked.
    const c = await prisma.bookkeepingAccount.findUniqueOrThrow({ where: { id: card.id } });
    expect(c.ownershipStatus).toBe("NOT_CHECKED");
    expect(c.ownershipNote).toMatch(/Not on the banking list/);
    // A statement showing the business, the bank and the ending verifies it.
    const doc = await staffUploadDocument(w.tabitha, { clientId: w.maple.id, category: "BOOKKEEPING", title: "Nov statement", visibility: "STAFF_ONLY", bytes: await statementPdf(["Riverbend Example Bank", "MAPLE EXAMPLE STUDIO LLC (FICTIONAL)", "Account ending 9432"]), originalName: "n.pdf", notify: false, docType: "BANK_STATEMENT" });
    await prisma.document.update({ where: { id: doc.id }, data: { bookkeepingAccountId: wrong.id } });
    expect(await verifyAccount(w.tabitha, wrong.id)).toMatchObject({ status: "VERIFIED" });
    expect(await prisma.journalEntry.count({ where: { clientId: w.maple.id } })).toBe(entries);
    expect(await prisma.auditLog.count({ where: { action: "banking.account_corrected_from_list", entityId: wrong.id } })).toBe(1);
  });

  it("the right ending under the wrong bank is corrected to the list's bank", async () => {
    const w = await world();
    const a = await registerAccount(w.tabitha, w.maple.id, { institution: "Chase", accountType: "CHECKING", last4: "9432", gl: "NEW" });
    await prisma.bookkeepingProfile.update({ where: { clientId: w.maple.id }, data: { bankingReference: [{ institution: "Riverbend Example Bank - Business Checking", kind: "CHECKING", ending: "9432", note: "" }] } });
    await applyBankingReference(w.tabitha, w.maple.id);
    const after = await prisma.bookkeepingAccount.findUniqueOrThrow({ where: { id: a.id }, include: { ledgerAccount: true } });
    expect(after).toMatchObject({ institution: "Riverbend Example Bank", ownershipStatus: "NOT_CHECKED" });
    expect(after.ledgerAccount?.name).not.toMatch(/chase/i);
  });

  it("loading the list: rows matched to bookkeeping clients, accounts on it added (short endings too), an unknown row reported", async () => {
    const w = await world();
    const r = await importBankingList(w.tabitha, await listPdf());
    expect(r.matched).toBe(2);
    expect(r.unmatched).toEqual(["Nobody Example - Not A Client LLC"]);
    const birch = await prisma.bookkeepingAccount.findMany({ where: { clientId: w.birch.id }, orderBy: { createdAt: "asc" } });
    expect(birch.map((b) => [b.institution, b.last4, b.accountType, b.ownershipStatus])).toEqual([["Example FCU", "181", "CHECKING", "NOT_CHECKED"], ["Example FCU", "17000", "SAVINGS", "NOT_CHECKED"]]);
    expect(await prisma.bookkeepingAccount.count({ where: { clientId: w.maple.id, last4: "9432" } })).toBe(1);
    // Loading the list again adds nothing twice.
    await importBankingList(w.tabitha, await listPdf());
    expect(await prisma.bookkeepingAccount.count({ where: { clientId: w.birch.id } })).toBe(2);
    expect(await prisma.bookkeepingAccount.count({ where: { clientId: w.maple.id } })).toBe(1);
  });

  it("an account that may already be registered isn't added again: it is flagged", async () => {
    const w = await world();
    await registerAccount(w.tabitha, w.maple.id, { institution: "Riverbend Example Bank", accountType: "CHECKING", last4: "1234", gl: "NEW" });
    await prisma.bookkeepingProfile.update({ where: { clientId: w.maple.id }, data: { bankingReference: [{ institution: "Riverbend Example Bank", kind: "CHECKING", ending: "9432", note: "" }] } });
    const r = await applyBankingReference(w.tabitha, w.maple.id);
    expect(r.flagged[0]).toMatch(/may already be registered/);
    expect(await prisma.bookkeepingAccount.count({ where: { clientId: w.maple.id } })).toBe(1);
  });
});
