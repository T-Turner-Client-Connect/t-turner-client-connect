import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { authorizeCoetha, makeUser, managed, prisma, resetDb } from "./db";
import { ForbiddenError } from "@/lib/auth/actor";
import { createClient } from "@/lib/services/clients";
import { openWorkPeriod, saveProfile } from "@/lib/services/bookkeeping-clients";
import { closeBooksThrough, importBankCsv, postJournalEntry, postOpeningBalances, setupLedger, categorizeBankTransaction } from "@/lib/services/ledger";
import { registerAccount } from "@/lib/services/bank-accounts";
import { runWorkflowMonitor } from "@/lib/services/monthly-workflow";
import { approveCoethaProposal, rejectCoethaProposal } from "@/lib/services/coetha";
import { setTaxClassification, taxProfile } from "@/lib/services/tax-classification";
import { clientBalanceSheet, clientGeneralLedger, clientInterimStatements, clientProfitAndLoss, clientStatementPdf, clientStatementStatus, clientText, interimBalanceSheet, interimProfitAndLoss, releaseInterimStatement, revokeInterimStatement } from "@/lib/services/client-statements";
import { acceptPortalInvite, invitePortalUser } from "@/lib/services/portal-accounts";
import { portalDocuments } from "@/lib/services/documents";
import { GET as statementsRoute } from "@/app/api/client/statements/route";
import { GET as packetRoute } from "@/app/api/bookkeeping/packet/route";

/** Coetha as senior accountant: tax classification, recommendations with rationale, and clean client output. Fictional data only. */

let portalSession: { id: string } | null = null;
vi.mock("@/lib/portal/session", async (orig) => ({ ...(await orig<object>()), getPortalUser: async () => portalSession }));
vi.mock("@/lib/auth/session", async (orig) => ({ ...(await orig<object>()), getCurrentUser: async () => null }));

beforeEach(async () => {
  await resetDb();
  portalSession = null;
});
afterEach(() => vi.unstubAllGlobals());

const TODAY = "2026-11-04";
const INTERNAL = /coetha|recommend|possible error|ai-generated|\bAI\b|awaiting (approval|review)|staff note|tabitha|ask my accountant|needs review|draft|reclassif/i;

async function world() {
  const tabitha = await makeUser("ADMIN", "Tabitha");
  await prisma.ownerAccess.create({ data: { userId: tabitha.id, isPrimary: true } });
  const daria = await makeUser("STAFF", "Daria");
  const admin = await makeUser("ADMIN", "Second Admin");
  const biz = await createClient(tabitha, { businessName: "Lakeside Pretend Bakery LLC", clientType: "BUSINESS", status: "ACTIVE", assignedToId: daria.id });
  await saveProfile(tabitha, biz.id, { active: true, frequency: "MONTHLY", payroll: false });
  await setupLedger(daria, biz.id, { basis: "CASH" });
  const code = async (c: string) => (await prisma.ledgerAccount.findFirstOrThrow({ where: { clientId: biz.id, code: c } })).id;
  await authorizeCoetha(biz.id);
  return { tabitha, daria, admin, biz, code };
}

describe("business tax classification", () => {
  it("only Tabitha sets it; it keeps the profile, client and books consistent and is audited", async () => {
    const w = await world();
    await expect(setTaxClassification(w.daria, w.biz.id, { classification: "FORM_1120S" })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(setTaxClassification(w.admin, w.biz.id, { classification: "FORM_1120S" })).rejects.toBeInstanceOf(ForbiddenError);
    await setTaxClassification(w.tabitha, w.biz.id, { classification: "FORM_1120S", basis: "ACCRUAL", fiscalYearEnd: 6, taxYear: 2026 });
    const tp = await taxProfile(w.biz.id);
    expect(tp).toMatchObject({ classification: "FORM_1120S", basis: "ACCRUAL", fiscalYearEnd: 6, taxYear: 2026, entityType: "S_CORP" });
    const book = await prisma.ledgerBook.findUniqueOrThrow({ where: { clientId: w.biz.id } });
    expect(book).toMatchObject({ basis: "ACCRUAL", fiscalYearStartMonth: 7 });
    expect(await prisma.auditLog.count({ where: { action: "business.tax_classification_set", actorId: w.tabitha.id } })).toBe(1);
  });

  it("Coetha may only recommend a change; staff can't approve it; Tabitha's approval updates it (audited); a rejection changes nothing", async () => {
    const w = await world();
    await setTaxClassification(w.tabitha, w.biz.id, { classification: "SCHEDULE_C" });
    await prisma.client.update({ where: { id: w.biz.id }, data: { entityType: "S_CORP" } }); // recorded elsewhere as an S corporation
    await runWorkflowMonitor(null, w.biz.id, 2026, 10, { today: TODAY });
    const p = await prisma.coethaProposal.findFirstOrThrow({ where: { clientId: w.biz.id, kind: "CLASSIFICATION" } });
    expect(p.payload).toMatchObject({ current: "SCHEDULE_C", recommended: "FORM_1120S" });
    expect((await taxProfile(w.biz.id)).classification).toBe("SCHEDULE_C"); // a recommendation changes nothing
    await expect(approveCoethaProposal(w.daria, w.biz.id, p.id)).rejects.toBeInstanceOf(ForbiddenError);
    await approveCoethaProposal(w.tabitha, w.biz.id, p.id);
    expect((await taxProfile(w.biz.id)).classification).toBe("FORM_1120S");
    const a = await prisma.auditLog.findFirstOrThrow({ where: { action: "business.tax_classification_set", details: { path: ["via"], equals: "COETHA_PROPOSAL" } } });
    expect(a.actorId).toBe(w.tabitha.id);
    // Not raised again once decided.
    await runWorkflowMonitor(null, w.biz.id, 2026, 10, { today: TODAY });
    expect(await prisma.coethaProposal.count({ where: { clientId: w.biz.id, kind: "CLASSIFICATION", status: "PROPOSED" } })).toBe(0);
  });
});

describe("recommendations with full rationale", () => {
  it("a card payment booked as an expense: what, why, correction, accounts, transactions and impact; only Tabitha's approval posts the fix", async () => {
    const w = await world();
    const chk = await registerAccount(w.daria, w.biz.id, { institution: "Pretend National Bank", accountType: "CHECKING", last4: "0042", gl: (await w.code("1000")) });
    const card = await registerAccount(w.daria, w.biz.id, { institution: "Pretend Card Co", accountType: "CREDIT_CARD", nickname: "Visa", last4: "7001" });
    await importBankCsv(w.daria, w.biz.id, chk.ledgerAccountId!, { fileName: "oct.csv", text: "Date,Description,Amount\n2026-10-20,ONLINE PAYMENT CARD 7001,-800.00\n2026-10-22,ZELLE TO OWNER PERSONAL,-300.00\n" });
    const rows = await prisma.bankTransaction.findMany({ where: { clientId: w.biz.id }, orderBy: { date: "asc" } });
    for (const r of rows) await categorizeBankTransaction(w.daria, w.biz.id, r.id, { accountId: await w.code("6300") }); // both wrongly expensed
    await runWorkflowMonitor(w.daria, w.biz.id, 2026, 10, { today: TODAY });
    const recs = await prisma.coethaProposal.findMany({ where: { clientId: w.biz.id, kind: "RECOMMENDATION", status: "PROPOSED" } });
    const payRec = recs.find((r) => (r.payload as { category: string }).category === "CARD_PAYMENT_DOUBLE_COUNTED")!;
    expect(payRec.payload).toMatchObject({
      found: expect.stringMatching(/ONLINE PAYMENT CARD 7001.*\$800\.00.*6300/),
      why: expect.stringMatching(/counts them twice/),
      correction: expect.stringMatching(/Reclassify \$800\.00 from 6300 Office Supplies to/),
      impact: expect.stringMatching(/overstated by \$800\.00/),
      accounts: expect.arrayContaining([expect.objectContaining({ code: "6300" }), expect.objectContaining({ id: card.ledgerAccountId })]),
      transactions: [expect.objectContaining({ id: rows[0].id, amountCents: -80_000 })],
    });
    expect(recs.some((r) => (r.payload as { category: string }).category === "OWNER_DRAW")).toBe(true);
    const entriesBefore = await prisma.journalEntry.count({ where: { clientId: w.biz.id } });
    await expect(approveCoethaProposal(w.daria, w.biz.id, payRec.id)).rejects.toBeInstanceOf(ForbiddenError);
    expect(await prisma.journalEntry.count({ where: { clientId: w.biz.id } })).toBe(entriesBefore);
    const d = await approveCoethaProposal(w.tabitha, w.biz.id, payRec.id);
    const je = await prisma.journalEntry.findUniqueOrThrow({ where: { id: d.journalEntryId! }, include: { lines: true } });
    expect(je.lines.find((l) => l.accountId === card.ledgerAccountId)!.debitCents).toBe(80_000);
    expect(je.memo).not.toMatch(/coetha/i);
    const draw = recs.find((r) => (r.payload as { category: string }).category === "OWNER_DRAW")!;
    await rejectCoethaProposal(w.tabitha, w.biz.id, draw.id, "Business expense, confirmed with owner");
    await runWorkflowMonitor(w.daria, w.biz.id, 2026, 10, { today: TODAY });
    expect(await prisma.coethaProposal.count({ where: { clientId: w.biz.id, payload: { path: ["key"], equals: (draw.payload as { key: string }).key } } })).toBe(1); // never re-raised
  });
});

describe("client-facing statements carry no internal commentary", () => {
  async function released(w: Awaited<ReturnType<typeof world>>) {
    // Books with internal wording in memos and line notes, Coetha proposals, staff notes and review notes.
    await postOpeningBalances(w.daria, w.biz.id, { date: "2026-09-30", balances: [{ accountId: await w.code("1000"), amount: "5000" }] });
    await postJournalEntry(w.daria, w.biz.id, { date: "2026-10-10", memo: "Catering sale — Coetha recommends checking, possible error (staff note: ask Tabitha)", lines: [{ accountId: await w.code("1000"), debit: "1200", description: "AI-generated: awaiting approval" }, { accountId: await w.code("4000"), credit: "1200" }] });
    await postJournalEntry(w.daria, w.biz.id, { date: "2026-10-12", memo: "Unknown charge", lines: [{ accountId: await w.code("9999"), debit: "40" }, { accountId: await w.code("1000"), credit: "40", description: "Needs review by Tabitha" }] });
    const run = await prisma.coethaRun.create({ data: { clientId: w.biz.id, trigger: "MANUAL", model: "rules", status: "OK" } });
    await prisma.coethaProposal.create({ data: { clientId: w.biz.id, runId: run.id, kind: "RECOMMENDATION", payload: { key: "x", title: "Coetha recommends a reclassification" }, reason: "Coetha recommends: possible error", model: "rules", inputHash: "h" } });
    const period = await openWorkPeriod(w.tabitha, w.biz.id, 2026, 10);
    await prisma.bookkeepingPeriod.update({ where: { id: period.id }, data: { staffNote: "Staff note: Coetha flagged a possible error" } });
    const file = await prisma.storedFile.create({ data: { kind: "CLIENT_DOCUMENT", storageKey: "test/pl.pdf", originalName: "pl.pdf", title: "PL", mimeType: "application/pdf", sizeBytes: 10 } });
    const doc = await prisma.document.create({ data: { clientId: w.biz.id, category: "BOOKKEEPING", title: "Profit & Loss — October 2026", year: 2026, month: 10, periodId: period.id, reportType: "PROFIT_AND_LOSS", reviewStatus: "AWAITING_REVIEW", reviewNote: "Coetha: possible error in rent", visibility: "STAFF_ONLY", scanStatus: "CLEAN", fileId: file.id } });
    return { period, doc };
  }

  it("nothing is available until Tabitha approves, releases and closes the month", async () => {
    const w = await world();
    const { period, doc } = await released(w);
    expect(await clientStatementStatus(period.id)).toBe("IN_PREPARATION");
    await expect(clientProfitAndLoss(period.id)).rejects.toBeInstanceOf(ForbiddenError);
    // A login with bookkeeping access asks the APIs directly.
    await managed(w.biz.id);
    const { token } = await invitePortalUser(w.tabitha, w.biz.id, { email: "pat@pretend.example", name: "Pat Pretend", role: "OWNER" });
    const u = await acceptPortalInvite(token!, "Pretend-Strong-Pass-1");
    await prisma.portalAccess.updateMany({ where: { clientId: w.biz.id }, data: { canViewBookkeeping: true } });
    portalSession = { id: u.id };
    expect((await statementsRoute(new Request(`https://portal.example/api/client/statements?period=${period.id}&kind=pl`))).status).toBe(404);
    expect((await packetRoute(new Request(`https://portal.example/api/bookkeeping/packet?period=${period.id}&type=MONTH`))).status).toBe(404);
    // Approved and delivered, but the books not yet closed: the ledger statements still aren't offered.
    await prisma.document.update({ where: { id: doc.id }, data: { reviewStatus: "APPROVED", visibility: "PUBLISHED", publishedAt: new Date() } });
    expect(await clientStatementStatus(period.id)).toBe("AVAILABLE");
    expect((await statementsRoute(new Request(`https://portal.example/api/client/statements?period=${period.id}&kind=pl`))).status).toBe(404);
    await closeBooksThrough(w.tabitha, w.biz.id, "2026-10-31");
    const ok = await statementsRoute(new Request(`https://portal.example/api/client/statements?period=${period.id}&kind=pl&download=1`));
    expect(ok.status).toBe(200);
    expect(ok.headers.get("Content-Disposition")).toMatch(/attachment/);
    // Portal document lists never include Coetha data or review notes.
    const docs = JSON.stringify(await portalDocuments({ id: u.id, name: u.name, email: u.email }, w.biz.id));
    expect(docs).not.toMatch(/coetha|possible error/i);
  });

  it("P&L, Balance Sheet, General Ledger and their PDFs contain only financial presentation", async () => {
    const w = await world();
    const { period, doc } = await released(w);
    await prisma.document.update({ where: { id: doc.id }, data: { reviewStatus: "APPROVED", visibility: "PUBLISHED", publishedAt: new Date() } });
    await closeBooksThrough(w.tabitha, w.biz.id, "2026-10-31");
    const pl = await clientProfitAndLoss(period.id);
    const bs = await clientBalanceSheet(period.id);
    const gl = await clientGeneralLedger(period.id);
    expect(pl.totals.find((t) => t.label === "Net Income")!.amountCents).toBe(116_000);
    expect(bs.sections[0].totalCents).toBe(616_000);
    for (const s of [pl, bs, gl]) expect(JSON.stringify(s)).not.toMatch(INTERNAL);
    expect(JSON.stringify(pl)).toMatch(/Uncategorized/);
    expect(gl.rows.find((r) => r.creditCents === 120_000)!.description).toBe("Catering sale");
    const { extractText, getDocumentProxy } = await import("unpdf");
    for (const s of [pl, bs, gl]) {
      const { pdf } = await clientStatementPdf(s);
      const { text } = await extractText(await getDocumentProxy(new Uint8Array(pdf)), { mergePages: true });
      expect(String(text)).toMatch(/Lakeside Pretend Bakery LLC/);
      expect(String(text)).not.toMatch(INTERNAL);
    }
  });

  it("an interim statement: only Tabitha releases it, without closing the period; labeled interim and unaudited; clean; audited", async () => {
    const w = await world();
    await released(w); // books with internal wording, Coetha proposals and notes; October NOT closed
    await expect(releaseInterimStatement(w.daria, w.biz.id, { from: "2026-10-01", asOf: "2026-10-20" })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(releaseInterimStatement(w.admin, w.biz.id, { from: "2026-10-01", asOf: "2026-10-20" })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(releaseInterimStatement(w.tabitha, w.biz.id, { from: "2026-10-01", asOf: "2026-12-31" }, TODAY)).rejects.toThrow(/future/);
    const s = await releaseInterimStatement(w.tabitha, w.biz.id, { from: "2026-10-01", asOf: "2026-10-20", purpose: "For Pretend Community Bank" }, TODAY);
    expect((await prisma.ledgerBook.findUniqueOrThrow({ where: { clientId: w.biz.id } })).lockedThrough).toBeNull(); // period not closed
    expect(await prisma.auditLog.count({ where: { action: "statements.interim_released", actorId: w.tabitha.id, entityId: s.id } })).toBe(1);
    const pl = await interimProfitAndLoss(s.id);
    const bs = await interimBalanceSheet(s.id);
    expect(pl.interim).toBe("Interim — unaudited, prepared as of October 20, 2026");
    expect(pl.period).toBe("For the Period October 1, 2026 – October 20, 2026");
    expect(pl.totals.find((x) => x.label === "Net Income")!.amountCents).toBe(116_000);
    for (const x of [pl, bs]) expect(JSON.stringify(x)).not.toMatch(INTERNAL);
    const { extractText, getDocumentProxy } = await import("unpdf");
    const { pdf, filename } = await clientStatementPdf(pl);
    const { text } = await extractText(await getDocumentProxy(new Uint8Array(pdf)), { mergePages: true });
    expect(String(text)).toMatch(/Interim — unaudited, prepared as of October 20, 2026/);
    expect(String(text)).not.toMatch(INTERNAL);
    expect(filename).toMatch(/Interim 2026-10-20/);
    // The client downloads it through the portal (bookkeeping access), labeled the same way.
    await managed(w.biz.id);
    const { token } = await invitePortalUser(w.tabitha, w.biz.id, { email: "pat@pretend.example", name: "Pat Pretend", role: "OWNER" });
    const u = await acceptPortalInvite(token!, "Pretend-Strong-Pass-1");
    await prisma.portalAccess.updateMany({ where: { clientId: w.biz.id }, data: { canViewBookkeeping: true } });
    portalSession = { id: u.id };
    expect((await clientInterimStatements(w.biz.id))[0]).toMatchObject({ label: "Interim — unaudited, prepared as of October 20, 2026", purpose: "For Pretend Community Bank" });
    expect((await statementsRoute(new Request(`https://portal.example/api/client/statements?interim=${s.id}&kind=bs`))).status).toBe(200);
    // The monthly statements for the same month still aren't available (not released and closed).
    const period = await prisma.bookkeepingPeriod.findFirstOrThrow({ where: { clientId: w.biz.id, month: 10 } });
    expect((await statementsRoute(new Request(`https://portal.example/api/client/statements?period=${period.id}&kind=pl`))).status).toBe(404);
    // Withdrawn: gone from the portal, audited.
    await expect(revokeInterimStatement(w.daria, w.biz.id, s.id)).rejects.toBeInstanceOf(ForbiddenError);
    await revokeInterimStatement(w.tabitha, w.biz.id, s.id);
    expect((await statementsRoute(new Request(`https://portal.example/api/client/statements?interim=${s.id}&kind=pl`))).status).toBe(404);
    expect(await prisma.auditLog.count({ where: { action: "statements.interim_withdrawn", entityId: s.id } })).toBe(1);
  });

  it("the sanitizer removes internal markers", () => {
    expect(clientText("Rent — Coetha recommends review")).toBe("Rent");
    expect(clientText("Office supplies (possible error)")).toBe("Office supplies");
    expect(clientText("Ask My Accountant", "Uncategorized")).toBe("Uncategorized");
    expect(clientText("Monthly software subscription")).toBe("Monthly software subscription");
  });
});
