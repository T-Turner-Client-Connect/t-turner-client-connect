import { beforeEach, describe, expect, it } from "vitest";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { makeUser, managed, prisma, resetDb } from "./db";
import { createClient } from "@/lib/services/clients";
import { saveProfile } from "@/lib/services/bookkeeping-clients";
import { importBankCsv, setupLedger } from "@/lib/services/ledger";
import { registerAccount } from "@/lib/services/bank-accounts";
import { readPackageTable } from "@/lib/statement-package";
import { compareWithReference, familyPostingsToUndo, judgmentDraftIds, judgmentGroups, matchingDraftIds, matchVendors, prepareFromRecords, routineSummary, saveReferenceStatements, undoFamilyPostings, vendorKey } from "@/lib/services/coetha-records";
import { decideCoethaProposals, runDiagnostic } from "@/lib/services/coetha";
import { ForbiddenError } from "@/lib/auth/actor";

// A fictional business and its fictional completed statements (January–March).
const PACKAGE = [
  "Financial Statements",
  "Willow Example Bakery LLC (fictional) • Cash Basis • January 1 – March 31, 2026",
  "Profit & Loss Statement — Monthly",
  "Willow Example Bakery LLC | Cash Basis | January 1 – March 31, 2026",
  "Jan Feb Mar YTD",
  "REVENUE",
  "Catering Sales — Example Events 5,000.00 4,500.00 6,000.00 15,500.00",
  "Total Revenue 5,000.00 4,500.00 6,000.00 15,500.00",
  "OPERATING EXPENSES",
  "Payroll — Gross Wages 2,000.00 2,000.00 2,100.00 6,100.00",
  "Supplies — Flour & Sugar 300.00 — 450.00 750.00",
  "Owner Draws & Personal Transfers 500.00 500.00 500.00 1,500.00",
  "Bank Service Charges 10.00 10.00 10.00 30.00",
  "Total Operating Expenses 2,810.00 2,510.00 3,060.00 8,380.00",
  "NET OPERATING INCOME",
  "Net Operating Income 2,190.00 1,990.00 2,940.00 6,120.00",
  "Balance Sheet — Month End",
];

async function pdf(lines: string[]) {
  const d = await PDFDocument.create();
  const font = await d.embedFont(StandardFonts.Helvetica);
  const page = d.addPage([792, 900]);
  let y = 880;
  for (const l of lines) { page.drawText(l, { x: 30, y, size: 9, font }); y -= 14; }
  return d.save();
}

const CSV = [
  "Date,Description,Amount",
  // January
  "01/05/2026,EXAMPLE EVENTS DEPOSIT 001,5000.00",
  "01/09/2026,PAYROLLCO WAGES 1001,-1000.00", "01/23/2026,PAYROLLCO WAGES 1002,-1000.00",
  "01/12/2026,MILL SUPPLY ORDER 77,-300.00",
  "01/20/2026,ONLINE TRANSFER TO OWNER SAVINGS,-500.00",
  "01/31/2026,MONTHLY SERVICE FEE,-10.00",
  // February
  "02/05/2026,EXAMPLE EVENTS DEPOSIT 002,4500.00",
  "02/06/2026,PAYROLLCO WAGES 1003,-1000.00", "02/20/2026,PAYROLLCO WAGES 1004,-1000.00",
  "02/20/2026,ONLINE TRANSFER TO OWNER SAVINGS,-500.00",
  "02/28/2026,MONTHLY SERVICE FEE,-10.00",
  // March
  "03/05/2026,EXAMPLE EVENTS DEPOSIT 003,6000.00",
  "03/06/2026,PAYROLLCO WAGES 1005,-1050.00", "03/20/2026,PAYROLLCO WAGES 1006,-1050.00",
  "03/11/2026,MILL SUPPLY ORDER 78,-200.00", "03/25/2026,SUGAR HOUSE INC,-250.00",
  "03/20/2026,ONLINE TRANSFER TO OWNER SAVINGS,-500.00",
  "03/31/2026,MONTHLY SERVICE FEE,-10.00",
  // April (after the statements): the same vendors, plus one new item
  "04/06/2026,PAYROLLCO WAGES 1007,-1050.00",
  "04/10/2026,UNKNOWN WIRE IN,750.00",
].join("\n");

describe("Coetha prepares the books from a business's completed financial statements", () => {
  beforeEach(resetDb);

  async function world() {
    const tabitha = await makeUser("ADMIN", "Tabitha");
    await prisma.ownerAccess.create({ data: { userId: tabitha.id, isPrimary: true } });
    const staff = await makeUser("STAFF", "Daria");
    const biz = await createClient(tabitha, { businessName: "Willow Example Bakery LLC (fictional)", clientType: "BUSINESS", status: "ACTIVE", assignedToId: staff.id });
    await managed(biz.id);
    await saveProfile(tabitha, biz.id, { active: true, frequency: "MONTHLY", payroll: false, payrollFrequency: null, payrollProvider: null });
    await setupLedger(tabitha, biz.id, { basis: "CASH" });
    const reg = await registerAccount(tabitha, biz.id, { institution: "Example Bank", accountType: "CHECKING", last4: "1111" });
    const gl = (await prisma.bookkeepingAccount.findUniqueOrThrow({ where: { id: reg.id } })).ledgerAccountId!;
    await importBankCsv(tabitha, biz.id, gl, { fileName: "q1.csv", text: CSV });
    return { tabitha, staff, biz };
  }

  it("reads the monthly P&L lines exactly as printed (totals and net skipped)", () => {
    const t = readPackageTable(PACKAGE)!;
    expect(t.months).toEqual(["2026-01", "2026-02", "2026-03"]);
    expect(t.lines.map((l) => [l.section, l.label, l.amounts])).toEqual([
      ["INCOME", "Catering Sales — Example Events", [500000, 450000, 600000]],
      ["EXPENSE", "Payroll — Gross Wages", [200000, 200000, 210000]],
      ["EXPENSE", "Supplies — Flour & Sugar", [30000, 0, 45000]],
      ["EXPENSE", "Owner Draws & Personal Transfers", [50000, 50000, 50000]],
      ["EXPENSE", "Bank Service Charges", [1000, 1000, 1000]],
    ]);
  });

  it("matches one vendor, or several together, to the cent in every month", () => {
    expect(vendorKey("PAYROLLCO WAGES 1001")).toBe("PAYROLLCO WAGES");
    expect(vendorKey("Check 180")).toBe("CHECK");
    const m = matchVendors(
      [{ section: "EXPENSE", label: "Supplies", amounts: [300, 0, 450] }, { section: "EXPENSE", label: "Wages", amounts: [100, 100, 100] }],
      [{ key: "MILL", dir: "OUT", vec: [300, 0, 200] }, { key: "SUGAR", dir: "OUT", vec: [0, 0, 250] }, { key: "WAGES", dir: "OUT", vec: [100, 100, 100] }, { key: "OTHER", dir: "OUT", vec: [100, 100, 99] }],
    );
    expect(m.get(1)).toEqual(["WAGES"]);
    expect(m.get(0)?.sort()).toEqual(["MILL", "SUGAR"]);
  });

  it("drafts every matching transaction (later months too), flags judgment items, approves the matches in one step and compares month by month", async () => {
    const w = await world();
    const r = await saveReferenceStatements(w.tabitha, w.biz.id, { bytes: await pdf(PACKAGE), originalName: "willow-q1.pdf" });
    expect(r).toMatchObject({ months: ["2026-01", "2026-02", "2026-03"], lines: 5 });
    const p = await prepareFromRecords(w.tabitha, w.biz.id);
    // 20 waiting: 19 matched (incl. April's wages), 3 owner transfers flagged, the unknown April wire left for review.
    expect(p).toMatchObject({ waiting: 20, drafts: 19, needsJudgment: 3, notMatched: 1, linesMatched: 5, linesNotMatched: [] });
    expect(p.accountsAdded).toContain("Supplies — Flour & Sugar");
    const drafts = await prisma.coethaProposal.findMany({ where: { clientId: w.biz.id, status: "PROPOSED", kind: "CATEGORY" } });
    const april = drafts.find((d) => (d.payload as { date: string }).date === "2026-04-06")!;
    expect(april.reason).toMatch(/same vendor as in your completed statements/);
    expect(drafts.filter((d) => (d.payload as { needsJudgment: boolean }).needsJudgment).every((d) => d.confidence! < 0.5 && /judgment/.test(d.reason))).toBe(true);
    // Nothing is posted by preparing.
    expect(await prisma.journalEntry.count({ where: { clientId: w.biz.id } })).toBe(0);
    // The run explains itself with counts only.
    const run = await prisma.coethaRun.findFirstOrThrow({ where: { clientId: w.biz.id, model: "records" } });
    expect(run.error).toMatch(/19 of 20 waiting transactions drafted \(3 need your judgment\); 1 not matched/);
    expect(run.error).not.toMatch(/PAYROLLCO|EXAMPLE|\d+\.\d\d/);

    // Approving "everything that matches" leaves the judgment items alone.
    const ids = await matchingDraftIds(w.biz.id);
    expect(ids).toHaveLength(16);
    await expect(decideCoethaProposals(w.staff, w.biz.id, "APPROVE", ids.map((id) => ({ id })))).rejects.toBeInstanceOf(ForbiddenError);
    const res = await decideCoethaProposals(w.tabitha, w.biz.id, "APPROVE", ids.map((id) => ({ id })));
    expect(res.filter((x) => x.result === "APPROVED")).toHaveLength(16);
    expect(await prisma.bankTransaction.count({ where: { clientId: w.biz.id, status: "UNREVIEWED" } })).toBe(4);

    // Compared with the statements: every matched line agrees; only the owner-transfer line waits.
    const cmp = (await compareWithReference(w.tabitha, w.biz.id))!;
    const row = (label: string) => cmp.rows.find((x) => x.label === label)!;
    expect(row("Catering Sales — Example Events").books).toEqual([500000, 450000, 600000]);
    expect(row("Supplies — Flour & Sugar").books).toEqual([30000, 0, 45000]);
    expect(row("Owner Draws & Personal Transfers")).toMatchObject({ needsJudgment: true, books: [0, 0, 0] });
    expect(cmp.months.map((m) => m.agrees)).toEqual([false, false, false]);

    // Preparing again doesn't duplicate anything.
    const again = await prepareFromRecords(w.tabitha, w.biz.id);
    expect(again).toMatchObject({ waiting: 4, drafts: 3, needsJudgment: 3 });
    expect(await prisma.coethaProposal.count({ where: { clientId: w.biz.id, status: "PROPOSED", kind: "CATEGORY" } })).toBe(3);
  });

  it("keeps each business separate and refuses a PDF without a monthly P&L", async () => {
    const w = await world();
    const other = await createClient(w.tabitha, { businessName: "Harbor Example Co (fictional)", clientType: "BUSINESS", status: "ACTIVE" });
    await managed(other.id);
    await setupLedger(w.tabitha, other.id, { basis: "CASH" });
    await saveReferenceStatements(w.tabitha, w.biz.id, { bytes: await pdf(PACKAGE), originalName: "willow-q1.pdf" });
    await expect(prepareFromRecords(w.tabitha, other.id)).rejects.toThrow(/completed financial statements first/);
    await expect(saveReferenceStatements(w.tabitha, w.biz.id, { bytes: await pdf(["Just a letter", "Nothing to see"]), originalName: "letter.pdf" })).rejects.toThrow(/monthly Profit & Loss table couldn't be found/);
  });

  it("a Coetha run that leaves transactions undecided says so, in counts only", () => {
    expect(runDiagnostic(80, 1, 0, 1, 412)).toMatch(/Sent 80 waiting transactions; Coetha answered with categories for 1; 0 became drafts\. 1 suggestion was dropped .* She left most transactions undecided/);
    expect(runDiagnostic(10, 10, 10, 0, 900)).toBeNull();
  });

  it("matches a line made of many small purchases (up to eight vendors together)", () => {
    const vecs = [[100, 0], [200, 50], [0, 75], [30, 20], [40, 0], [10, 5], [5, 0]];
    const groups = vecs.map((vec, i) => ({ key: `SHOP ${i}`, dir: "OUT" as const, vec }));
    const m = matchVendors([{ section: "EXPENSE", label: "Meals", amounts: vecs.reduce((a, v) => a.map((x, k) => x + v[k]), [0, 0]) }], groups);
    expect(m.get(0)).toHaveLength(7);
  });

  it("the same-vendor-family shortcut applies only after the statement months; earlier family postings can be reversed and prepared again", async () => {
    const w = await world();
    // A new vendor sharing a first word with a matched one, inside the statement months.
    const gl = (await prisma.ledgerAccount.findFirstOrThrow({ where: { clientId: w.biz.id, subtype: "BANK" } })).id;
    await importBankCsv(w.tabitha, w.biz.id, gl, { fileName: "extra.csv", text: "Date,Description,Amount\n02/14/2026,MILL OUTLET STORE,-18.53" });
    await saveReferenceStatements(w.tabitha, w.biz.id, { bytes: await pdf(PACKAGE), originalName: "willow-q1.pdf" });
    const p = await prepareFromRecords(w.tabitha, w.biz.id);
    const outlet = await prisma.bankTransaction.findFirstOrThrow({ where: { clientId: w.biz.id, description: "MILL OUTLET STORE" } });
    expect(await prisma.coethaProposal.count({ where: { bankTransactionId: outlet.id, status: "PROPOSED" } })).toBe(0);
    expect(p.notMatched).toBe(2);

    // An earlier version's family posting inside the statement months is offered for reversal.
    const supplies = await prisma.ledgerAccount.findFirstOrThrow({ where: { clientId: w.biz.id, name: "Supplies — Flour & Sugar" } });
    const run = await prisma.coethaRun.findFirstOrThrow({ where: { clientId: w.biz.id, model: "records" } });
    const draft = await prisma.coethaProposal.create({ data: { clientId: w.biz.id, runId: run.id, kind: "CATEGORY", bankTransactionId: outlet.id, confidence: 0.9, reason: "“Supplies — Flour & Sugar” — same vendor family as in your completed statements (2026-01 to 2026-03).", model: "records", inputHash: "x", payload: { bankTransactionId: outlet.id, date: "2026-02-14", amountCents: -1853, description: outlet.description, bankAccountName: "Bank", accountId: supplies.id, accountCode: supplies.code, accountName: supplies.name, fromRecords: true, needsJudgment: false, referenceLine: supplies.name } } });
    await decideCoethaProposals(w.tabitha, w.biz.id, "APPROVE", [{ id: draft.id }]);
    expect(await familyPostingsToUndo(w.biz.id)).toHaveLength(1);
    await expect(undoFamilyPostings(w.staff, w.biz.id)).rejects.toBeInstanceOf(ForbiddenError);
    expect(await undoFamilyPostings(w.tabitha, w.biz.id)).toBe(1);
    expect((await prisma.bankTransaction.findUniqueOrThrow({ where: { id: outlet.id } })).status).toBe("UNREVIEWED");
    expect(await familyPostingsToUndo(w.biz.id)).toHaveLength(0);
    // History is kept: the original entry and its reversal both remain, with the reason and who did it.
    const original = await prisma.journalEntry.findUniqueOrThrow({ where: { id: (await prisma.coethaProposal.findUniqueOrThrow({ where: { id: draft.id } })).journalEntryId! }, include: { reversedBy: true } });
    expect(original.reversedBy).not.toBeNull();
    expect(await prisma.auditLog.count({ where: { clientId: w.biz.id, action: "ledger.entry_reversed", actorId: w.tabitha.id } })).toBe(1);
    expect(await prisma.auditLog.count({ where: { clientId: w.biz.id, action: "coetha.family_postings_undone" } })).toBe(1);
    expect((await prisma.coethaProposal.findUniqueOrThrow({ where: { id: draft.id } })).status).toBe("APPROVED");
    // Undoing again does nothing (no double reversal).
    expect(await undoFamilyPostings(w.tabitha, w.biz.id)).toBe(0);
    // Posting the row again leaves exactly one live posting for it: original + reversal + new = net one.
    const other = await prisma.ledgerAccount.findFirstOrThrow({ where: { clientId: w.biz.id, code: "6300" } });
    const { categorizeBankTransaction } = await import("@/lib/services/ledger");
    await categorizeBankTransaction(w.tabitha, w.biz.id, outlet.id, { accountId: other.id });
    const net = (await prisma.journalLine.findMany({ where: { accountId: { in: [supplies.id, other.id] }, entry: { clientId: w.biz.id, date: new Date("2026-02-14T00:00:00Z") } } })).reduce((t, l) => t + l.debitCents - l.creditCents, 0);
    expect(net).toBe(1853);
    expect(await prisma.journalEntry.count({ where: { clientId: w.biz.id, date: new Date("2026-02-14T00:00:00Z"), reversalOfId: null, reversedBy: null } })).toBe(1);
  });

  it("judgment items can be approved together, exactly as the statements treated them", async () => {
    const w = await world();
    await saveReferenceStatements(w.tabitha, w.biz.id, { bytes: await pdf(PACKAGE), originalName: "willow-q1.pdf" });
    await prepareFromRecords(w.tabitha, w.biz.id);
    const ids = await judgmentDraftIds(w.biz.id);
    expect(ids).toHaveLength(3);
    // Never part of "Approve all"; grouped by statement line; "Approve all" shows exactly what it posts.
    const routine = await matchingDraftIds(w.biz.id);
    expect(routine.some((id) => ids.includes(id))).toBe(false);
    expect((await judgmentGroups(w.biz.id)).map((g) => [g.line, g.ids.length, g.outCents])).toEqual([["Owner Draws & Personal Transfers", 3, 150000]]);
    const sum = await routineSummary(w.biz.id);
    expect(sum.reduce((n, r) => n + r.count, 0)).toBe(routine.length);
    expect(sum.find((r) => r.account === "Catering Sales — Example Events")).toMatchObject({ count: 3, inCents: 1550000, outCents: 0 });
    const res = await decideCoethaProposals(w.tabitha, w.biz.id, "APPROVE", ids.map((id) => ({ id })));
    expect(res.every((r) => r.result === "APPROVED")).toBe(true);
    await decideCoethaProposals(w.tabitha, w.biz.id, "APPROVE", (await matchingDraftIds(w.biz.id)).map((id) => ({ id })));
    const cmp = (await compareWithReference(w.tabitha, w.biz.id))!;
    expect(cmp.months.map((m) => m.agrees)).toEqual([true, true, true]);
  });
});
