import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeUser, managed, prisma, resetDb } from "./db";
import { ForbiddenError } from "@/lib/auth/actor";
import { createClient } from "@/lib/services/clients";
import { categorizeBankTransaction, excludeBankTransaction, importBankCsv, setupLedger } from "@/lib/services/ledger";
import { setOwnerSwitch } from "@/lib/services/owner-switches";
import { askCoetha } from "@/lib/services/coetha-chat";
import { recordsSnapshot, runRecordsTool, searchBankTransactions, searchJournalEntries, SEARCH_PAGE } from "@/lib/services/coetha-records-view";
import { CHAT_MAX_SEARCH_ROUNDS } from "@/lib/coetha-model";

// Fictional businesses and transactions only. A local stand-in for Anthropic's Messages API that
// can ask for read-only searches; nothing leaves the test.
type Msg = { role: string; content: unknown };
type Req = { system: { text: string }[]; messages: Msg[]; tools?: { name: string }[]; tool_choice?: { type: string } };
let sent: Req[] = [];
let script: ((req: Req) => unknown)[] = [];
const text = (t: string) => ({ content: [{ type: "text", text: t }], stop_reason: "end_turn" });
const search = (name: string, input: object, id = "tu_1") => ({ content: [{ type: "tool_use", id, name, input }], stop_reason: "tool_use" });

beforeEach(async () => {
  await resetDb();
  sent = []; script = [];
  process.env.ANTHROPIC_API_KEY = "sk-ant-test-fictional-key";
  vi.stubGlobal("fetch", vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const u = new URL(typeof url === "string" ? url : url instanceof URL ? url.href : url.url);
    if (u.host !== "api.anthropic.com") throw new Error(`Unexpected request: ${u.href}`);
    const req = JSON.parse(String(init?.body ?? "")) as Req;
    sent.push(req);
    const step = script.shift() ?? (() => text("Done."));
    const out = step(req) as { content: unknown[]; stop_reason: string };
    return new Response(JSON.stringify({ id: `msg_${sent.length}`, type: "message", role: "assistant", model: "claude-test", ...out, stop_sequence: null, usage: { input_tokens: 1000, output_tokens: 50 } }), { status: 200, headers: { "content-type": "application/json", "request-id": "req_fictional" } });
  }));
});
afterEach(() => { vi.unstubAllGlobals(); delete process.env.ANTHROPIC_API_KEY; });

const CSV = (rows: string[]) => ["Date,Description,Amount", ...rows].join("\n");

async function setup() {
  const tabitha = await makeUser("ADMIN", "Tabitha");
  await prisma.ownerAccess.create({ data: { userId: tabitha.id, isPrimary: true } });
  const daria = await makeUser("STAFF", "Daria");
  const stranger = await makeUser("STAFF", "Stranger");
  const willow = await createClient(tabitha, { businessName: "Willow Example Bakery (fictional)", clientType: "BUSINESS", status: "ACTIVE", assignedToId: daria.id });
  const harbor = await createClient(tabitha, { businessName: "Harbor Example Co (fictional)", clientType: "BUSINESS", status: "ACTIVE" });
  await managed(willow.id, harbor.id);
  for (const c of [willow, harbor]) await setupLedger(tabitha, c.id, { basis: "CASH" });
  const acct = async (clientId: string, code: string) => (await prisma.ledgerAccount.findFirstOrThrow({ where: { clientId, code } })).id;
  const checking = await acct(willow.id, "1000");
  // 120 waiting rows over Oct and Nov: more than the old limit of 80.
  const rows: string[] = [];
  for (let i = 1; i <= 100; i++) rows.push(`10/${String((i % 28) + 1).padStart(2, "0")}/2026,FLOUR MILL ORDER ${1000 + i},-${(10 + i).toFixed(2)}`);
  for (let i = 1; i <= 20; i++) rows.push(`11/${String((i % 9) + 1).padStart(2, "0")}/2026,CHECK ${2000 + i},-${(100 + i).toFixed(2)}`);
  rows.push("10/15/2026,WIRE IN FROM EXAMPLE PARTNER,19000.00");
  await importBankCsv(tabitha, willow.id, checking, { fileName: "oct-nov.csv", text: CSV(rows) });
  await importBankCsv(tabitha, harbor.id, await acct(harbor.id, "1000"), { fileName: "h.csv", text: CSV(["10/03/2026,SECRETHARBORVENDOR PAYMENT,-999.00"]) });
  await setOwnerSwitch(tabitha, "coetha", true);
  return { tabitha, daria, stranger, willow, harbor, acct, checking };
}

describe("Ask Coetha's complete read-only view of the records", () => {
  it("lists every waiting row (not just 80) with its draft, and counts by account, month and status", async () => {
    const s = await setup();
    // One posted, one excluded, one with an open draft that needs judgment.
    const [first, second, third] = await prisma.bankTransaction.findMany({ where: { clientId: s.willow.id }, orderBy: [{ date: "asc" }, { id: "asc" }], take: 3 });
    await categorizeBankTransaction(s.tabitha, s.willow.id, first.id, { accountId: await s.acct(s.willow.id, "6300") });
    await excludeBankTransaction(s.tabitha, s.willow.id, second.id, "Duplicate of a row in the earlier file");
    const run = await prisma.coethaRun.create({ data: { clientId: s.willow.id, trigger: "RECORDS", model: "records", status: "OK" } });
    await prisma.coethaProposal.create({ data: { clientId: s.willow.id, runId: run.id, kind: "CATEGORY", bankTransactionId: third.id, confidence: 0.4, reason: "“Owner Draws” — matches your completed statements to the cent. Needs your judgment.", model: "records", inputHash: "x", payload: { accountCode: "3100", accountName: "Owner Draws", needsJudgment: true, referenceLine: "Owner Draws & Personal Transfers", amountCents: third.amountCents } } });

    const snap = await recordsSnapshot(s.daria, s.willow.id);
    expect(snap.counts.waitingTotal).toBe(119);
    expect(snap.waitingRows).toHaveLength(119);
    expect(snap.counts.note).toBeUndefined();
    const drafted = snap.waitingRows.find((r) => r.draft);
    expect(drafted?.draft).toMatchObject({ account: "3100 Owner Draws", from: "completed statements", needsJudgment: true, statementLine: "Owner Draws & Personal Transfers" });
    expect(snap.counts.byAccountAndStatus).toEqual(expect.arrayContaining([
      expect.objectContaining({ account: "1000", status: "waiting", count: 119 }),
      expect.objectContaining({ account: "1000", status: "posted", count: 1 }),
      expect.objectContaining({ account: "1000", status: "excluded", count: 1 }),
    ]));
    expect(snap.counts.waitingByAccountMonth).toEqual([
      expect.objectContaining({ account: "1000", month: "2026-10", count: 99, in: 19000 }),
      expect.objectContaining({ account: "1000", month: "2026-11", count: 20 }),
    ]);
    expect(snap.excludedRows[0]).toMatchObject({ reason: "Duplicate of a row in the earlier file" });
    expect(snap.definitions.cashProof).toMatch(/on or before/);
    // Nothing from the other business.
    expect(JSON.stringify(snap)).not.toContain("SECRETHARBORVENDOR");
  });

  it("searches the whole history page by page, only within the business, with filters", async () => {
    const s = await setup();
    const p1 = await searchBankTransactions(s.willow.id, { status: "waiting" });
    expect(p1.total).toBe(121);
    expect(p1.rows).toHaveLength(SEARCH_PAGE);
    expect(p1.next).toMatch(/offset 100/);
    const p2 = await searchBankTransactions(s.willow.id, { status: "waiting", offset: 100 });
    expect(p2.rows).toHaveLength(21);
    expect((await searchBankTransactions(s.willow.id, { text: "check", from: "2026-11-01", to: "2026-11-30" })).total).toBe(20);
    expect((await searchBankTransactions(s.willow.id, { minAmount: 18000 })).rows.map((r) => r.amount)).toEqual([19000]);
    expect((await searchBankTransactions(s.willow.id, { account: "0001" })).note).toMatch(/No account/);
    // Bound to the business: a search for the other business's vendor finds nothing.
    expect((await runRecordsTool(s.willow.id, "search_bank_transactions", { text: "SECRETHARBORVENDOR" }) as { total: number }).total).toBe(0);
    expect(await runRecordsTool(s.willow.id, "post_entry", {})).toEqual({ error: "Unknown tool post_entry." });
    const j = await searchJournalEntries(s.willow.id, { kind: "any" });
    expect(j.total).toBe(0);
  });

  it("in a chat, Coetha gets the complete records and may search, but nothing changes and searches are capped", async () => {
    const s = await setup();
    const before = await Promise.all([prisma.journalEntry.count(), prisma.coethaProposal.count(), prisma.bankTransaction.count({ where: { status: "UNREVIEWED" } }), prisma.ledgerBook.findUniqueOrThrow({ where: { clientId: s.willow.id } })]);
    // She searches once, then answers.
    script = [() => search("search_bank_transactions", { text: "wire" }), () => text("The $19,000 wire on 2026-10-15 (W…) needs your decision.")];
    const r = await askCoetha(s.daria, s.willow.id, "What is unresolved?", { today: "2026-11-10" });
    expect(r.text).toMatch(/19,000/);
    expect(sent).toHaveLength(2);
    // The complete records went with the question: all 121 waiting rows, not 80.
    const records = sent[0].system.find((b) => b.text.startsWith("Records (JSON)"))!.text;
    expect(JSON.parse(records.slice(records.indexOf("\n") + 1)).waitingRows).toHaveLength(121);
    expect(sent[0].tools!.map((t) => t.name)).toEqual(["search_bank_transactions", "search_journal_entries"]);
    // The search result came back to her, for this business only.
    const toolResult = JSON.stringify(sent[1].messages[sent[1].messages.length - 1]);
    expect(toolResult).toContain("WIRE IN FROM EXAMPLE PARTNER");
    expect(toolResult).not.toContain("SECRETHARBOR");
    expect((await prisma.auditLog.findFirstOrThrow({ where: { action: "coetha.chat" } })).details).toMatchObject({ searches: 1, waitingRows: 121 });

    // A model that keeps asking to search is stopped: the last round can't search.
    sent = [];
    script = Array.from({ length: 10 }, (_, i) => (req: Req) => (req.tool_choice?.type === "none" ? text("Answer from what I have.") : search("search_journal_entries", {}, `tu_${i}`)));
    await askCoetha(s.daria, s.willow.id, "Search everything", { today: "2026-11-10" });
    expect(sent).toHaveLength(CHAT_MAX_SEARCH_ROUNDS + 1);
    expect(sent[sent.length - 1].tool_choice).toEqual({ type: "none" });

    const after = await Promise.all([prisma.journalEntry.count(), prisma.coethaProposal.count(), prisma.bankTransaction.count({ where: { status: "UNREVIEWED" } }), prisma.ledgerBook.findUniqueOrThrow({ where: { clientId: s.willow.id } })]);
    expect(after).toEqual(before);
  });

  it("only staff who can open the business's books get its records", async () => {
    const s = await setup();
    await expect(recordsSnapshot(s.stranger, s.willow.id)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(recordsSnapshot(s.daria, s.harbor.id)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(askCoetha(s.stranger, s.willow.id, "Show me", { today: "2026-11-10" })).rejects.toBeInstanceOf(ForbiddenError);
    expect(sent).toHaveLength(0);
  });
});
