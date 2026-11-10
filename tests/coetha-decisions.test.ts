import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeUser, managed, prisma, resetDb } from "./db";
import { ForbiddenError } from "@/lib/auth/actor";
import { createClient } from "@/lib/services/clients";
import { categorizeBankTransaction, closeBooksThrough, importBankCsv, profitAndLoss, setupLedger } from "@/lib/services/ledger";
import { setOwnerSwitch } from "@/lib/services/owner-switches";
import { askCoetha } from "@/lib/services/coetha-chat";
import { applyDecisionsView, approveDecisions, DECISIONS_MODEL, prepareDecisions, prepareFromDocument, removeDecisions } from "@/lib/services/coetha-decisions";

// Fictional businesses and transactions only. A local stand-in for Anthropic's Messages API: when a
// question starts with "DECIDE:", the stand-in calls prepare_entries (if offered) with the items
// in `toolItems`, then answers in text.
type Req = { system: { type: string; text: string }[]; messages: { role: string; content: unknown }[]; tools?: { name: string }[] };
let sent: Req[] = [];
let toolItems: unknown[] = [];
let toolResults: string[] = [];

beforeEach(async () => {
  await resetDb();
  sent = []; toolItems = []; toolResults = [];
  process.env.ANTHROPIC_API_KEY = "sk-ant-test-fictional-key";
  vi.stubGlobal("fetch", vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const u = new URL(typeof url === "string" ? url : url instanceof URL ? url.href : url.url);
    if (u.host !== "api.anthropic.com") throw new Error(`Unexpected request: ${u.href}`);
    const req = JSON.parse(String(init?.body ?? "")) as Req;
    sent.push(req);
    const headers = { "content-type": "application/json", "request-id": "req_fictional" };
    const reply = (content: unknown[], stop: string) => new Response(JSON.stringify({ id: "msg_f", type: "message", role: "assistant", model: "claude-test", content, stop_reason: stop, stop_sequence: null, usage: { input_tokens: 900, output_tokens: 60 } }), { status: 200, headers });
    const last = req.messages[req.messages.length - 1];
    if (Array.isArray(last.content) && (last.content as { type: string }[])[0]?.type === "tool_result") {
      toolResults.push(String((last.content as { content: string }[])[0].content));
      return reply([{ type: "text", text: "I prepared the entries on your Apply These Decisions card." }], "end_turn");
    }
    const asked = typeof last.content === "string" ? last.content : "";
    if (asked.startsWith("DECIDE:") && req.tools?.some((t) => t.name === "prepare_entries")) {
      return reply([{ type: "tool_use", id: "toolu_1", name: "prepare_entries", input: { items: toolItems } }], "tool_use");
    }
    return reply([{ type: "text", text: "Here is how I'd record it; Tabitha prepares and approves it." }], "end_turn");
  }));
});
afterEach(() => { vi.unstubAllGlobals(); delete process.env.ANTHROPIC_API_KEY; });

const CSV = (rows: string[]) => ["Date,Description,Amount", ...rows].join("\n");

async function setup() {
  const tabitha = await makeUser("ADMIN", "Tabitha");
  await prisma.ownerAccess.create({ data: { userId: tabitha.id, isPrimary: true } });
  const daria = await makeUser("STAFF", "Daria");
  const biz = await createClient(tabitha, { businessName: "Willow Example Agency (fictional)", clientType: "BUSINESS", status: "ACTIVE", assignedToId: daria.id });
  const other = await createClient(tabitha, { businessName: "Harbor Example Co (fictional)", clientType: "BUSINESS", status: "ACTIVE" });
  await managed(biz.id, other.id);
  for (const c of [biz, other]) await setupLedger(tabitha, c.id, { basis: "CASH" });
  const acct = async (code: string, clientId = biz.id) => prisma.ledgerAccount.findFirstOrThrow({ where: { clientId, code } });
  // Waiting rows (W1..W4 by date): a car check to the owner's family, a license, an office supply check, a card payment.
  await importBankCsv(daria, biz.id, (await acct("1000")).id, { fileName: "sep.csv", text: CSV(["09/02/2026,CHECK 178,-18000.00", "09/05/2026,CHECK 184,-580.85", "09/08/2026,CHECK 190,-102.00", "09/12/2026,CHASE EPAY,-2049.10"]) });
  // Already posted earlier to the wrong account (6600), to be reclassified.
  await importBankCsv(daria, biz.id, (await acct("1000")).id, { fileName: "aug.csv", text: CSV(["08/26/2026,CHECK 180,-1000.00"]) });
  const c180 = await prisma.bankTransaction.findFirstOrThrow({ where: { clientId: biz.id, description: "CHECK 180" } });
  await categorizeBankTransaction(daria, biz.id, c180.id, { accountId: (await acct("6600")).id });
  await setOwnerSwitch(tabitha, "coetha", true);
  const row = (d: string) => prisma.bankTransaction.findFirstOrThrow({ where: { clientId: biz.id, description: d } });
  return { tabitha, daria, biz, other, acct, row };
}
const counts = () => Promise.all([prisma.bankTransaction.count(), prisma.journalEntry.count()]);

describe("Apply These Decisions: Coetha prepares the entries from Tabitha's decisions", () => {
  it("in Ask Coetha, Tabitha's decisions become drafts (no posting); a staff member's question can't prepare anything", async () => {
    const s = await setup();
    const before = await counts();
    toolItems = [
      { type: "post_bank_row", ref: "W1", date: "2026-09-02", amount: -18000, accountCode: "3100", reason: "Car purchase for a family member: owner draw (Tabitha's decision)" },
      { type: "post_bank_row", ref: "W2", date: "2026-09-05", amount: -580.85, accountCode: "6400", reason: "License renewal" },
      { type: "journal_entry", date: "2026-09-30", memo: "Reclassify check 180 from 6600 to owner draws", reason: "Tabitha: #180 is personal", lines: [{ accountCode: "3100", debit: 1000 }, { accountCode: "6600", credit: 1000 }] },
      // Wrong amount for the row: refused, nothing prepared for it.
      { type: "post_bank_row", ref: "W3", date: "2026-09-08", amount: -999, accountCode: "6300" },
    ];
    await askCoetha(s.tabitha, s.biz.id, "DECIDE: #178 and the wire are owner draws; #184 is a license; #180 is personal.");
    expect(sent[0].tools!.map((t) => t.name)).toContain("prepare_entries");
    expect(JSON.parse(toolResults[0])).toMatchObject({ prepared: expect.any(Array), notPrepared: [expect.stringContaining("not $999.00")] });
    const drafts = await prisma.coethaProposal.findMany({ where: { clientId: s.biz.id, model: DECISIONS_MODEL, status: "PROPOSED" }, orderBy: { createdAt: "asc" } });
    expect(drafts.map((d) => d.kind)).toEqual(["CATEGORY", "CATEGORY", "ADJUSTING_ENTRY"]);
    // Nothing posted, no bank transaction added.
    expect(await counts()).toEqual(before);

    // The card: exact lines and the effect on the statements.
    const card = await applyDecisionsView(s.tabitha, s.biz.id);
    expect(card.canApprove).toBe(true);
    expect(card.entries).toHaveLength(3);
    expect(card.entries[0]).toMatchObject({ date: "2026-09-02", amountCents: 1800000, bankRow: true, lines: [expect.objectContaining({ account: expect.stringMatching(/^3100 /), debitCents: 1800000 }), expect.objectContaining({ account: expect.stringMatching(/^1000 /), creditCents: 1800000 })] });
    expect(card.impact).toEqual(expect.arrayContaining([
      { type: "EXPENSE", label: "Expenses", cents: 58085 - 100000 },
      { type: "ASSET", label: "Assets (bank and other)", cents: -(1800000 + 58085) },
      { type: "EQUITY", label: "Owner's equity", cents: -(1800000 + 100000) },
    ]));

    // A staff member asking: no prepare tool is offered, and she can't approve.
    sent = [];
    await askCoetha(s.daria, s.biz.id, "DECIDE: post the office check.");
    expect(sent[0].tools!.map((t) => t.name)).not.toContain("prepare_entries");
    expect((await applyDecisionsView(s.daria, s.biz.id)).canApprove).toBe(false);
    await expect(approveDecisions(s.daria, s.biz.id, drafts.map((d) => d.id))).rejects.toBeInstanceOf(ForbiddenError);
    expect(await counts()).toEqual(before);
  });

  it("Approve & Post posts only the ticked entries through the ledger: no new bank rows, no double posting; the rest stay on hold", async () => {
    const s = await setup();
    const res = await prepareDecisions(s.tabitha, s.biz.id, [
      { type: "post_bank_row", ref: "W1", date: "2026-09-02", amount: -18000, accountCode: "3100" },
      { type: "post_bank_row", ref: "W2", date: "2026-09-05", amount: -580.85, accountCode: "6400" },
      { type: "journal_entry", date: "2026-09-30", memo: "Reclassify check 180", lines: [{ accountCode: "3100", debit: 1000 }, { accountCode: "6600", credit: 1000 }] },
    ], "chat");
    expect(res.every((r) => r.ok)).toBe(true);
    const [bankBefore, entriesBefore] = await counts();
    const [car, license, reclass] = res.map((r) => r.proposalId!);

    const out = await approveDecisions(s.tabitha, s.biz.id, [car, reclass]);
    expect(out.map((r) => r.result)).toEqual(["APPROVED", "APPROVED"]);
    const [bankAfter, entriesAfter] = await counts();
    expect(bankAfter).toBe(bankBefore);
    expect(entriesAfter).toBe(entriesBefore + 2);
    const carRow = await s.row("CHECK 178");
    expect(carRow.status).toBe("POSTED");
    expect(carRow.journalEntryId).toBeTruthy();
    expect((await s.row("CHECK 184")).status).toBe("UNREVIEWED");
    expect((await prisma.coethaProposal.findUniqueOrThrow({ where: { id: license } })).status).toBe("PROPOSED");
    const adj = await prisma.journalEntry.findFirstOrThrow({ where: { clientId: s.biz.id, sourceKey: `coetha:${reclass}` }, include: { lines: true } });
    expect(adj.source).toBe("ADJUSTMENT");
    // The statements read the posted entries: 6600 is down $1,000 for September.
    const pl = await profitAndLoss(s.tabitha, s.biz.id, { from: "2026-08-01", to: "2026-09-30" });
    // The statements read the posted entries: check 180's $1,000 moved out of 6600 (August +1,000, September −1,000).
    expect((pl as { expenses: { code: string; total: number }[] }).expenses.find((e) => e.code === "6600")?.total ?? 0).toBe(0);

    // Approving again never posts twice; preparing the same decision again doesn't duplicate it.
    const again = await approveDecisions(s.tabitha, s.biz.id, [car, reclass]);
    expect(again.map((r) => r.result)).toEqual(["ALREADY_APPROVED", "ALREADY_APPROVED"]);
    expect((await counts())[1]).toBe(entriesAfter);
    const redo = await prepareDecisions(s.tabitha, s.biz.id, [
      // The car check is posted now, so "W1" is a different row: its date and amount don't match and nothing is prepared.
      { type: "post_bank_row", ref: "W1", date: "2026-09-02", amount: -18000, accountCode: "3100" },
      { type: "journal_entry", date: "2026-09-30", memo: "Reclassify check 180", lines: [{ accountCode: "3100", debit: 1000 }, { accountCode: "6600", credit: 1000 }] },
    ], "chat");
    expect(redo[0]).toMatchObject({ ok: false, message: expect.stringMatching(/dated 2026-09-05, not 2026-09-02/) });
    expect(redo[1]).toMatchObject({ ok: false, message: expect.stringContaining("already approved and posted") });
    expect(await prisma.coethaProposal.count({ where: { clientId: s.biz.id, model: DECISIONS_MODEL, status: "PROPOSED" } })).toBe(1);

    // Remove (don't post) keeps it in history as rejected.
    await removeDecisions(s.tabitha, s.biz.id, [license]);
    expect((await prisma.coethaProposal.findUniqueOrThrow({ where: { id: license } })).status).toBe("REJECTED");
    expect((await s.row("CHECK 184")).status).toBe("UNREVIEWED");
    const log = await prisma.auditLog.findMany({ where: { clientId: s.biz.id, action: { in: ["coetha.decisions_prepared", "coetha.decisions_approved", "coetha.proposal_approved", "ledger.bank_posted"] } } });
    expect(log.length).toBeGreaterThanOrEqual(5);
  });

  it("closed months, posted rows, unbalanced entries and other businesses' accounts are refused before anything is prepared", async () => {
    const s = await setup();
    const prepared = await prepareDecisions(s.tabitha, s.biz.id, [{ type: "post_bank_row", ref: "W3", date: "2026-09-08", amount: -102, accountCode: "6300" }], "chat");
    expect(prepared[0].ok).toBe(true);
    await closeBooksThrough(s.tabitha, s.biz.id, "2026-09-30");
    const r = await prepareDecisions(s.tabitha, s.biz.id, [
      { type: "post_bank_row", ref: "W1", date: "2026-09-02", amount: -18000, accountCode: "3100" },
      { type: "journal_entry", date: "2026-09-15", memo: "Too late", lines: [{ accountCode: "3100", debit: 10 }, { accountCode: "6600", credit: 10 }] },
      { type: "journal_entry", date: "2026-10-15", memo: "Unbalanced", lines: [{ accountCode: "3100", debit: 10 }, { accountCode: "6600", credit: 9 }] },
      { type: "journal_entry", date: "2026-10-15", memo: "Unknown account", lines: [{ accountCode: "8888", debit: 10 }, { accountCode: "6600", credit: 10 }] },
      { type: "post_bank_row", ref: "W99", date: "2026-09-02", amount: -1, accountCode: "6300" },
      { type: "post_bank_row", ref: "W2", accountCode: "6400" },
    ], "chat");
    expect(r.map((x) => x.ok)).toEqual([false, false, false, false, false, false]);
    expect(r[5].message).toMatch(/give the row's date and amount/);
    expect(r[0].message).toMatch(/closed through 2026-09-30/);
    expect(r[2].message).toMatch(/must be equal/);
    expect(r[3].message).toMatch(/isn't in this business's chart/);
    // A draft prepared before the month was closed is refused at Approve & Post and stays on the card.
    const before = await counts();
    const out = await approveDecisions(s.tabitha, s.biz.id, [prepared[0].proposalId!]);
    expect(out[0]).toMatchObject({ result: "SKIPPED", message: expect.stringMatching(/closed through/) });
    expect(await counts()).toEqual(before);
    // Another business's decisions can't be approved from this one.
    await expect(approveDecisions(s.tabitha, s.other.id, [prepared[0].proposalId!])).rejects.toThrow(/isn't a prepared decision for this business/);
  });

  it("a later Run Coetha never replaces Tabitha's decisions; her decision replaces other open drafts for the same row", async () => {
    const s = await setup();
    const w4 = await s.row("CHASE EPAY");
    const run = await prisma.coethaRun.create({ data: { clientId: s.biz.id, trigger: "MANUAL", model: "claude-test", status: "OK" } });
    const acct6600 = await s.acct("6600");
    const old = await prisma.coethaProposal.create({ data: { clientId: s.biz.id, runId: run.id, kind: "CATEGORY", bankTransactionId: w4.id, reason: "run draft", model: "claude-test", inputHash: "x", payload: { bankTransactionId: w4.id, date: "2026-09-12", amountCents: w4.amountCents, description: w4.description, bankAccountName: "Checking", accountId: acct6600.id, accountCode: "6600", accountName: "x" } } });
    const r = await prepareDecisions(s.tabitha, s.biz.id, [{ type: "post_bank_row", ref: "W4", date: "2026-09-12", amount: -2049.1, accountCode: "2100" }], "chat");
    expect(r[0].ok).toBe(true);
    expect((await prisma.coethaProposal.findUniqueOrThrow({ where: { id: old.id } })).status).toBe("SUPERSEDED");
    // The same rule Run Coetha uses to replace its earlier drafts leaves decisions alone.
    await prisma.coethaProposal.updateMany({ where: { clientId: s.biz.id, status: "PROPOSED", model: { notIn: ["rules", "records", "decisions"] } }, data: { status: "SUPERSEDED" } });
    expect((await prisma.coethaProposal.findUniqueOrThrow({ where: { id: r[0].proposalId! } })).status).toBe("PROPOSED");
  });

  it("from a document: only Routine checks matched to a waiting row are prepared; the rest stay on hold", async () => {
    const s = await setup();
    const { PDFDocument } = await import("pdf-lib");
    const pdf = await PDFDocument.create(); pdf.addPage([600, 800]);
    const { staffUploadDocument } = await import("@/lib/services/documents");
    const doc = await staffUploadDocument(s.tabitha, { clientId: s.biz.id, category: "BOOKKEEPING", title: "Checks (fictional)", visibility: "STAFF_ONLY", bytes: await pdf.save(), originalName: "checks.pdf", notify: false });
    const job = await prisma.coethaDocJob.create({ data: { clientId: s.biz.id, documentId: doc.id, name: "checks.pdf", status: "DONE", kind: "PDF_SCAN", pages: 3, pagesDone: 3, createdById: s.daria.id } });
    const [c190, c184, c178] = await Promise.all([s.row("CHECK 190"), s.row("CHECK 184"), s.row("CHECK 178")]);
    await prisma.coethaDocFinding.createMany({ data: [
      { jobId: job.id, clientId: s.biz.id, page: 1, seq: 0, kind: "CHECK", checkNumber: "190", amountCents: 10200, payee: "Fictional Supply", bankTransactionId: c190.id, reviewGroup: "ROUTINE", proposedAccount: "6300 Office Supplies", reason: "Regular supplier", reviewedAt: new Date() },
      { jobId: job.id, clientId: s.biz.id, page: 2, seq: 0, kind: "CHECK", checkNumber: "184", amountCents: 58085, bankTransactionId: c184.id, reviewGroup: "NEEDS_DOCS", proposedAccount: "6400 Professional Fees", reviewedAt: new Date() },
      { jobId: job.id, clientId: s.biz.id, page: 3, seq: 0, kind: "CHECK", checkNumber: "178", amountCents: 1800000, bankTransactionId: c178.id, reviewGroup: "OWNER_PERSONAL", proposedAccount: "3100 Owner's Draws", reviewedAt: new Date() },
    ] });
    const before = await counts();
    const r = await prepareFromDocument(s.daria, s.biz.id, job.id);
    expect(r.prepared).toBe(1);
    const drafts = await prisma.coethaProposal.findMany({ where: { clientId: s.biz.id, model: DECISIONS_MODEL, status: "PROPOSED" } });
    expect(drafts.map((d) => d.bankTransactionId)).toEqual([c190.id]);
    expect(await counts()).toEqual(before);
    // In a later question Coetha sees what she already read (no re-upload), tied to the waiting rows.
    const { recordsSnapshot } = await import("@/lib/services/coetha-records-view");
    const snap = await recordsSnapshot(s.tabitha, s.biz.id);
    const read = snap.readFromDocuments.find((x) => x.checkNumber === "184")!;
    expect(read).toMatchObject({ group: "Checks requiring additional documentation", proposedAccount: "6400 Professional Fees" });
    expect(read.bankRow).toBe(snap.waitingRows.find((w) => w.amount === -580.85)!.ref);
    expect(snap.readFromDocuments.find((x) => x.checkNumber === "178")!.group).toBe("Owner and personal transactions");
    await expect(prepareFromDocument(s.tabitha, s.other.id, job.id)).rejects.toThrow(/isn't on file for this business/);
  });
});
