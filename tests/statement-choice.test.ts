import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { makeUser, prisma, resetDb } from "./db";
import { createClient } from "@/lib/services/clients";
import { saveProfile } from "@/lib/services/bookkeeping-clients";
import { categorizeBankTransaction, postOpeningBalances, setupLedger } from "@/lib/services/ledger";
import { setOwnerSwitch } from "@/lib/services/owner-switches";
import { askCoetha } from "@/lib/services/coetha-chat";
import { registerAccount } from "@/lib/services/bank-accounts";
import { staffUploadStatement } from "@/lib/services/client-requests";
import { staffUploadDocument } from "@/lib/services/documents";
import { accountNumbersIn, chooseStatement, linkStatementsOnFile } from "@/lib/services/statement-choice";
import { accountSynced } from "@/lib/services/monthly-workflow";

// Fictional business, bank and statements only. Database effects are checked, not wording.
beforeEach(resetDb);

// An October statement from a different bank than the account's label, ending overdrawn.
const october = (acct: string) => [
  "Prairie Example Farm Bank", "WILLOW EXAMPLE LLC", `ACCOUNT # XXXXXX${acct}`, "BUSINESS CHECKING",
  "October 1, 2026 through October 30, 2026", "SUMMARY",
  "Beginning Balance $500.00 Minimum Balance $-58",
  "Deposits & Credits $2,500.00 + Average Balance $400",
  "Withdrawals $2,573.65 -", "Fees $35.00 -", "Automatic Transfers $0.00 +", "Checks $450.00 -",
  "Ending Balance -$58.65",
  "DEPOSITS & CREDITS", "10/02 Mobile Deposit 2,000.00", "10/15 Square Inc Settlement", "SQ 1234 500.00", "Total Deposits & Credits $2,500.00",
  "WITHDRAWALS", "10/03 Card Purchase Office Depot 84.56", "10/09 Online Transfer To Savings 1,000.00", "10/20 Rent Payment 1,489.09", "Total Withdrawals $2,573.65",
  "FEES", "10/30 Monthly Service Fee 35.00", "Total Fees $35.00",
  "CHECKS", "Check No. Date Amount Check No. Date Amount", "1001 10/05 200.00 1002 * 10/12 250.00", "Total Checks $450.00",
];
async function pdf(rows: string[]) {
  const d = await PDFDocument.create();
  const font = await d.embedFont(StandardFonts.Helvetica);
  const page = d.addPage([612, 1100]);
  let y = 1080;
  for (const l of rows) {
    const m = /^(.*?)\s(-?\$?[\d,]+\.\d{2}.*)$/.exec(l);
    if (m) { page.drawText(m[1], { x: 40, y, size: 9, font }); page.drawText(m[2], { x: 380, y, size: 9, font }); }
    else page.drawText(l, { x: 40, y, size: 9, font });
    y -= 14;
  }
  return d.save();
}
/** A scanned page: no text at all. */
async function unreadable() {
  const d = await PDFDocument.create();
  d.addPage([612, 792]);
  return d.save();
}

async function world(opts: { last4?: string | null; otherAccountStatement?: boolean } = {}) {
  const tabitha = await makeUser("ADMIN", "Tabitha");
  await prisma.ownerAccess.create({ data: { userId: tabitha.id, isPrimary: true } });
  const biz = await createClient(tabitha, { businessName: "Willow Example LLC (fictional)", clientType: "BUSINESS", status: "ACTIVE" });
  await saveProfile(tabitha, biz.id, { active: true, frequency: "MONTHLY", payroll: false, payrollFrequency: null, payrollProvider: null });
  await setupLedger(tabitha, biz.id, { basis: "CASH" });
  // Registered under the wrong bank name (as Parrish's was), with or without its last 4.
  const chk = await registerAccount(tabitha, biz.id, { institution: "Chase", accountType: "CHECKING", ...(opts.last4 ? { last4: opts.last4 } : {}), gl: "NEW" });
  const gl = (await prisma.bookkeepingAccount.findUniqueOrThrow({ where: { id: chk.id } })).ledgerAccountId!;
  const up = async (month: string, bytes: Uint8Array, name: string) => {
    const d = await staffUploadStatement(tabitha, biz.id, { accountId: chk.id, month, bytes, originalName: name });
    await prisma.document.update({ where: { id: d.id }, data: { scanStatus: "CLEAN" } });
    return d;
  };
  // The readable statement was filed under November (the month it arrived)…
  const good = await up("2026-11", await pdf(october("4542")), "farm-bank-oct.pdf");
  // …another account's statement was filed under this one…
  const other = opts.otherAccountStatement ? await up("2026-10", await pdf(october("9911")), "other-account-oct.pdf") : null;
  // …and the newest October file is an unreadable scan.
  const scan = await up("2026-10", await unreadable(), "scan-oct.pdf");
  return { tabitha, biz, chk, gl, good, other, scan };
}

describe("The statement Coetha uses for an account and month", () => {
  it("reads the account number in the usual layouts", () => {
    expect([...accountNumbersIn(["ACCOUNT # XXXXXX4542"])]).toEqual(["4542"]);
    expect([...accountNumbersIn(["Account Number: 1234 5678 4542"])]).toEqual(["4542"]);
    expect([...accountNumbersIn(["Checking ending in 4542"])]).toEqual(["4542"]);
    expect([...accountNumbersIn(["****4542 statement"])]).toEqual(["4542"]);
    expect([...accountNumbersIn(["Business Checking ending with 4542"])]).toEqual(["4542"]);
    expect([...accountNumbersIn(["Last 4 digits of account: 4542"])]).toEqual(["4542"]);
    expect([...accountNumbersIn(["Checking x4542"])]).toEqual(["4542"]);
    expect([...accountNumbersIn(["Checking …4542"])]).toEqual(["4542"]);
    // Not account numbers: a box number, an amount after an asterisk.
    expect([...accountNumbersIn(["PO Box 1234", "Fee *1234.56"])]).toEqual([]);
  });

  it("an account registered as Chase with no number: skips the unreadable scan, uses the readable statement, records its account number and real bank name, and re-files it (nothing deleted)", async () => {
    const w = await world();
    const c = await chooseStatement(w.biz.id, w.chk.id, 2026, 10);
    expect(c.chosen).toMatchObject({ id: w.good.id, exact: true, accountProof: "NUMBER" });
    expect(c.skipped.map((s) => s.title)).toEqual([w.scan.title]);
    expect(await prisma.bookkeepingAccount.findUniqueOrThrow({ where: { id: w.chk.id } })).toMatchObject({ last4: "4542", institution: "Prairie Example Farm Bank" });
    expect(await prisma.document.findUniqueOrThrow({ where: { id: w.good.id } })).toMatchObject({ bookkeepingAccountId: w.chk.id, year: 2026, month: 10 });
    expect(await prisma.auditLog.count({ where: { action: "bookkeeping.account_details_corrected", entityId: w.chk.id } })).toBe(1);
    expect(await prisma.auditLog.count({ where: { action: "bookkeeping.statement_refiled", entityId: w.good.id } })).toBe(1);
    expect(await prisma.document.count({ where: { clientId: w.biz.id, deletedAt: null } })).toBe(2);
    // Asked again, the same statement is used and nothing changes twice.
    expect((await chooseStatement(w.biz.id, w.chk.id, 2026, 10)).chosen?.id).toBe(w.good.id);
    expect(await prisma.auditLog.count({ where: { action: "bookkeeping.account_details_corrected" } })).toBe(1);
  });

  it("an account with its number on file: another account's statement filed under it is never used", async () => {
    const w = await world({ last4: "4542", otherAccountStatement: true });
    const c = await chooseStatement(w.biz.id, w.chk.id, 2026, 10);
    expect(c.chosen?.id).toBe(w.good.id);
    expect(c.skipped.map((s) => s.title).sort()).toEqual([w.other!.title, w.scan.title].sort());
    // The bank name is only corrected when an account's number was learned from the statement.
    expect((await prisma.bookkeepingAccount.findUniqueOrThrow({ where: { id: w.chk.id } })).institution).toBe("Chase");
  });

  it("with only an unreadable statement, nothing is chosen and the account is left as it is", async () => {
    const w = await world();
    await prisma.document.update({ where: { id: w.good.id }, data: { deletedAt: new Date() } });
    const c = await chooseStatement(w.biz.id, w.chk.id, 2026, 10);
    expect(c.chosen).toBeNull();
    expect(c.skipped).toHaveLength(1);
    expect((await prisma.bookkeepingAccount.findUniqueOrThrow({ where: { id: w.chk.id } })).last4).toBeNull();
  });
});

describe("The hourly step links the readable statement to an already-approved month (Parrish's case)", () => {
  it("replaces the unreadable scan on the approved reconciliation, records the number and bank name, never touches entries, and the month reads as synchronized", async () => {
    const w = await world();
    const t = await prisma.bankTransaction.create({ data: { clientId: w.biz.id, accountId: w.gl, date: new Date("2026-10-02T00:00:00Z"), amountCents: 200000, description: "Mobile Deposit", fingerprint: "p-1", source: "CSV" } });
    const inc = await prisma.ledgerAccount.findFirstOrThrow({ where: { clientId: w.biz.id, type: "INCOME" }, orderBy: { code: "asc" } });
    await categorizeBankTransaction(w.tabitha, w.biz.id, t.id, { accountId: inc.id });
    const rec = await prisma.accountReconciliation.create({ data: { clientId: w.biz.id, bookkeepingAccountId: w.chk.id, year: 2026, month: 10, status: "APPROVED", approvedAt: new Date(), approvedById: w.tabitha.id, beginningBalanceCents: 50000, endingBalanceCents: -5865, differenceCents: 0, statementDocumentId: w.scan.id, statementStatus: "RECEIVED" } });
    const entries = await prisma.journalEntry.count({ where: { clientId: w.biz.id } });
    const chk = await prisma.bookkeepingAccount.findUniqueOrThrow({ where: { id: w.chk.id } });
    // Before: no import file, no feed: not synchronized.
    await prisma.accountReconciliation.update({ where: { id: rec.id }, data: { status: "READY", approvedAt: null, approvedById: null } });
    expect((await accountSynced(w.biz.id, chk, 2026, 10, "2026-11-13")).state).toBe("MISSING");
    await prisma.accountReconciliation.update({ where: { id: rec.id }, data: { status: "APPROVED", approvedAt: new Date(), approvedById: w.tabitha.id } });

    const r = await linkStatementsOnFile({ today: "2026-11-13" });
    expect(r.linked).toEqual([expect.objectContaining({ accountId: w.chk.id, month: "2026-10", documentId: w.good.id })]);
    expect(await prisma.accountReconciliation.findUniqueOrThrow({ where: { id: rec.id } })).toMatchObject({ status: "APPROVED", statementDocumentId: w.good.id, endingBalanceCents: -5865 });
    expect(await prisma.bookkeepingAccount.findUniqueOrThrow({ where: { id: w.chk.id } })).toMatchObject({ last4: "4542", institution: "Prairie Example Farm Bank" });
    expect(await prisma.journalEntry.count({ where: { clientId: w.biz.id } })).toBe(entries);
    expect(await prisma.auditLog.count({ where: { action: "bookkeeping.statement_linked", entityId: rec.id } })).toBe(1);
    expect((await accountSynced(w.biz.id, chk, 2026, 10, "2026-11-13")).state).toBe("DONE");
    // The next hour finds nothing left to do.
    expect((await linkStatementsOnFile({ today: "2026-11-13" })).linked).toHaveLength(0);
  });
});

describe("The hourly step in the cases that left Parrish unlinked", () => {
  it("a readable statement whose layout can't be read to the cent is still linked by its account number, with the number and bank name recorded", async () => {
    const w = await world();
    // Same statement, but its printed totals don't add up for our reader.
    const odd = october("4542").map((l) => (l.startsWith("Ending Balance") ? "Ending Balance -$60.00" : l));
    await prisma.document.update({ where: { id: w.good.id }, data: { deletedAt: new Date() } });
    const d = await staffUploadStatement(w.tabitha, w.biz.id, { accountId: w.chk.id, month: "2026-10", bytes: await pdf(odd), originalName: "odd.pdf" });
    const r = await linkStatementsOnFile({ today: "2026-11-13" });
    expect(r.linked.map((x) => x.documentId)).toContain(d.id);
    expect(await prisma.accountReconciliation.findFirstOrThrow({ where: { bookkeepingAccountId: w.chk.id, year: 2026, month: 10 } })).toMatchObject({ statementDocumentId: d.id });
    expect(await prisma.bookkeepingAccount.findUniqueOrThrow({ where: { id: w.chk.id } })).toMatchObject({ last4: "4542", institution: "Prairie Example Farm Bank" });
  });

  it("a statement sent in through Ask Coetha (no document type) is recognized, re-filed as a bank statement and linked; a month with no reconciliation gets one prepared, never approved", async () => {
    const w = await world();
    await prisma.document.update({ where: { id: w.good.id }, data: { deletedAt: new Date() } });
    const sent = await staffUploadDocument(w.tabitha, { clientId: w.biz.id, category: "BOOKKEEPING", title: "Sent to Coetha — farm-bank-oct.pdf", visibility: "STAFF_ONLY", bytes: await pdf(october("4542")), originalName: "farm-bank-oct.pdf", notify: false });
    // A non-statement Coetha upload (a tax form) is never taken for a statement.
    await staffUploadDocument(w.tabitha, { clientId: w.biz.id, category: "BOOKKEEPING", title: "Sent to Coetha — form.pdf", visibility: "STAFF_ONLY", bytes: await pdf(["Form W-8BEN-E", "Certificate of Status", "Account number 4542"]), originalName: "form.pdf", notify: false });
    expect(await prisma.accountReconciliation.count({ where: { bookkeepingAccountId: w.chk.id } })).toBe(0);
    const r = await linkStatementsOnFile({ today: "2026-11-13" });
    expect(r.linked.map((x) => x.documentId)).toEqual([sent.id]);
    expect(await prisma.document.findUniqueOrThrow({ where: { id: sent.id } })).toMatchObject({ docType: "BANK_STATEMENT", bookkeepingAccountId: w.chk.id, year: 2026, month: 10 });
    const rec = await prisma.accountReconciliation.findFirstOrThrow({ where: { bookkeepingAccountId: w.chk.id, year: 2026, month: 10 } });
    expect(rec.statementDocumentId).toBe(sent.id);
    expect(rec.status).not.toBe("APPROVED");
    expect(await prisma.journalEntry.count({ where: { clientId: w.biz.id } })).toBe(0);
  });

  it("reports why an account was left alone, without client data", async () => {
    const w = await world();
    await prisma.document.update({ where: { id: w.good.id }, data: { deletedAt: new Date() } });
    const r = await linkStatementsOnFile({ today: "2026-11-13" });
    expect(r.linked).toHaveLength(0);
    expect(r.skipped.noUsableStatement).toBeGreaterThanOrEqual(1);
    expect(JSON.stringify(r.skipped)).not.toMatch(/Willow|cm[a-z0-9]{10}/);
  });
});

describe("An account with no number on file and a statement whose number can't be read", () => {
  it("links the complete, readable statement our office filed under the account (no number learned), and still skips an unreadable scan", async () => {
    const w = await world();
    // The statement prints no recognizable account number.
    // …and a layout our reader doesn't recognize (no period line).
    const noNumber = october("4542").map((l) => (l.startsWith("ACCOUNT #") ? "BUSINESS ACCOUNT" : l)).filter((l) => !l.startsWith("October 1, 2026 through"));
    await prisma.document.update({ where: { id: w.good.id }, data: { deletedAt: new Date() } });
    const d = await staffUploadStatement(w.tabitha, w.biz.id, { accountId: w.chk.id, month: "2026-10", bytes: await pdf(noNumber), originalName: "no-number.pdf" });
    const r = await linkStatementsOnFile({ today: "2026-11-13" });
    expect(r.linked.map((x) => x.documentId)).toEqual([d.id]);
    expect(await prisma.accountReconciliation.findFirstOrThrow({ where: { bookkeepingAccountId: w.chk.id, year: 2026, month: 10 } })).toMatchObject({ statementDocumentId: d.id });
    expect((await prisma.bookkeepingAccount.findUniqueOrThrow({ where: { id: w.chk.id } })).last4).toBeNull();
    expect(r.skipped.linkedLayoutNotRecognized).toBe(1);
  });
});

describe("Coetha completes the month from the right statement (database checked, not her wording)", () => {
  let plan: { name: string; input: unknown }[] = [];
  beforeEach(() => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-test-fictional-key";
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const u = new URL(typeof url === "string" ? url : url instanceof URL ? url.href : url.url);
      if (u.host !== "api.anthropic.com") throw new Error(`Unexpected request: ${u.href}`);
      const req = JSON.parse(String(init?.body ?? "")) as { messages: { content: unknown }[] };
      const done = req.messages.filter((m) => Array.isArray(m.content) && (m.content as { type: string }[])[0]?.type === "tool_result").length;
      const step = plan[done];
      const content = step ? [{ type: "tool_use", id: `toolu_${done}`, name: step.name, input: step.input }] : [{ type: "text", text: "October done." }];
      return new Response(JSON.stringify({ id: "m", type: "message", role: "assistant", model: "claude-test", content, stop_reason: step ? "tool_use" : "end_turn", stop_sequence: null, usage: { input_tokens: 10, output_tokens: 10 } }), { status: 200, headers: { "content-type": "application/json" } });
    }));
  });
  afterEach(() => { vi.unstubAllGlobals(); delete process.env.ANTHROPIC_API_KEY; });

  it("excludes verified duplicates (reversing one already posted), reconciles to the overdrawn ending balance and prepares the statements", async () => {
    const w = await world();
    await setOwnerSwitch(w.tabitha, "coetha", true);
    await setOwnerSwitch(w.tabitha, "coethaAutoPost", true);
    const acct = (type: string) => prisma.ledgerAccount.findFirstOrThrow({ where: { clientId: w.biz.id, type }, orderBy: { code: "asc" } });
    const [exp, inc] = [await acct("EXPENSE"), await acct("INCOME")];
    await postOpeningBalances(w.tabitha, w.biz.id, { date: "2026-10-01", balances: [{ accountId: w.gl, amount: "500.00" }] });
    // The 8 statement rows from an earlier import, then 3 duplicate imports (one already posted).
    const real = [["2026-10-02", 200000, "Mobile Deposit", inc], ["2026-10-03", -8456, "Card Purchase Office Depot", exp], ["2026-10-05", -20000, "Check 1001", exp], ["2026-10-09", -100000, "Online Transfer To Savings", exp], ["2026-10-12", -25000, "Check 1002", exp], ["2026-10-15", 50000, "Square Inc Settlement", inc], ["2026-10-20", -148909, "Rent Payment", exp], ["2026-10-30", -3500, "Monthly Service Fee", exp]] as const;
    for (const [d, c, desc, a] of real) {
      const t = await prisma.bankTransaction.create({ data: { clientId: w.biz.id, accountId: w.gl, date: new Date(`${d}T00:00:00Z`), amountCents: c, description: desc, fingerprint: `real-${d}`, source: "CSV" } });
      await categorizeBankTransaction(w.tabitha, w.biz.id, t.id, { accountId: a.id });
    }
    for (const [d, c] of [["2026-10-03", -8456], ["2026-10-20", -148909], ["2026-10-15", 50000]] as const) {
      await prisma.bankTransaction.create({ data: { clientId: w.biz.id, accountId: w.gl, date: new Date(`${d}T00:00:00Z`), amountCents: c, description: `FEED DUP ${d}`, fingerprint: `dup-${d}`, source: "PLAID" } });
    }
    const postedDup = await prisma.bankTransaction.findFirstOrThrow({ where: { fingerprint: "dup-2026-10-15" } });
    await categorizeBankTransaction(w.tabitha, w.biz.id, postedDup.id, { accountId: inc.id });
    const dupEntry = (await prisma.bankTransaction.findUniqueOrThrow({ where: { id: postedDup.id } })).journalEntryId!;

    plan = [
      { name: "remove_verified_duplicates", input: { month: "2026-10" } },
      { name: "reconcile_accounts", input: { month: "2026-10" } },
      { name: "prepare_financial_statements", input: { month: "2026-10" } },
    ];
    await askCoetha(w.tabitha, w.biz.id, "Complete October for this client.");

    // 3 duplicates excluded, kept with the reason; the posted one's entry reversed (both entries stay).
    const excluded = await prisma.bankTransaction.findMany({ where: { clientId: w.biz.id, status: "EXCLUDED" } });
    expect(excluded.map((t) => t.fingerprint).sort()).toEqual(["dup-2026-10-03", "dup-2026-10-15", "dup-2026-10-20"]);
    expect(excluded.every((t) => /^Duplicate import: the .+ shows/.test(t.excludedReason ?? ""))).toBe(true);
    expect(await prisma.journalEntry.count({ where: { clientId: w.biz.id, reversalOfId: dupEntry } })).toBe(1);
    expect(await prisma.journalEntry.count({ where: { id: dupEntry } })).toBe(1);
    expect(await prisma.auditLog.count({ where: { action: "coetha.entry_reversed", clientId: w.biz.id } })).toBe(1);
    // Reconciled from the readable statement, to the overdrawn ending balance.
    const rec = await prisma.accountReconciliation.findFirstOrThrow({ where: { bookkeepingAccountId: w.chk.id, year: 2026, month: 10 } });
    expect(rec).toMatchObject({ status: "APPROVED", differenceCents: 0, beginningBalanceCents: 50000, endingBalanceCents: -5865, statementDocumentId: w.good.id });
    // Draft statements saved, not released; no file deleted.
    const docs = await prisma.document.findMany({ where: { clientId: w.biz.id, reportType: { in: ["PROFIT_AND_LOSS", "BALANCE_SHEET"] }, year: 2026, month: 10 } });
    expect(docs).toHaveLength(2);
    expect(docs.every((d) => d.visibility === "STAFF_ONLY")).toBe(true);
    expect(await prisma.document.count({ where: { clientId: w.biz.id, docType: "BANK_STATEMENT", deletedAt: null } })).toBe(2);
  });
});
