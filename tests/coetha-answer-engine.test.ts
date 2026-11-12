import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeUser, managed, prisma, resetDb } from "./db";
import { createClient } from "@/lib/services/clients";
import { importBankCsv, setupLedger } from "@/lib/services/ledger";
import { setOwnerSwitch } from "@/lib/services/owner-switches";
import { askCoetha } from "@/lib/services/coetha-chat";
import { applyResult, MAX_LIVE, nextCall } from "@/lib/services/coetha-answer";
import type { ChatCallOutcome } from "@/lib/coetha-model";

/**
 * Coetha's answer engine with real tool execution (fictional businesses and rows only). A local
 * stand-in for Anthropic's Messages API plays Coetha: asked to complete the books, it posts the
 * supported rows with prepare_entries, leaves the loan payment out, prepares the statements, then
 * reports. Nothing is a text-only "plan".
 */
type Req = { system: { type: string; text: string }[]; messages: { role: string; content: unknown }[]; tools?: { name: string }[]; tool_choice?: { type: string } };
let sent: Req[] = [];
let codes: { expense: string; income: string } = { expense: "", income: "" };

const reply = (content: unknown[], stop: string) => new Response(JSON.stringify({ id: "msg_f", type: "message", role: "assistant", model: "claude-test", content, stop_reason: stop, stop_sequence: null, usage: { input_tokens: 900, output_tokens: 60, cache_read_input_tokens: 800 } }), { status: 200, headers: { "content-type": "application/json", "request-id": "req_fictional" } });

beforeEach(async () => {
  await resetDb();
  sent = [];
  process.env.ANTHROPIC_API_KEY = "sk-ant-test-fictional-key";
  vi.stubGlobal("fetch", vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const u = new URL(typeof url === "string" ? url : url instanceof URL ? url.href : url.url);
    if (u.host !== "api.anthropic.com") throw new Error(`Unexpected request: ${u.href}`);
    const req = JSON.parse(String(init?.body ?? "")) as Req;
    sent.push(req);
    const first = req.messages.find((m) => m.role === "user");
    const asked = typeof first?.content === "string" ? first.content : "";
    const results = req.messages.filter((m) => Array.isArray(m.content) && (m.content as { type: string }[])[0]?.type === "tool_result").length;
    if (asked.startsWith("Complete the September books") && req.tools?.some((t) => t.name === "prepare_entries")) {
      if (results === 0) {
        // Every supported row in ONE call; W4 (the loan payment) is a genuine exception and is left out.
        return reply([{ type: "tool_use", id: "toolu_1", name: "prepare_entries", input: { items: [
          { type: "post_bank_row", ref: "W1", date: "2026-09-02", amount: -120, accountCode: codes.expense, basis: "senior_accountant", reason: "Office supply store; ordinary supplies." },
          { type: "post_bank_row", ref: "W2", date: "2026-09-04", amount: 2500, accountCode: codes.income, basis: "senior_accountant", reason: "Square settlement: sales." },
          { type: "post_bank_row", ref: "W3", date: "2026-09-08", amount: -75.5, accountCode: codes.expense, basis: "senior_accountant", reason: "Same office supply vendor." },
          { type: "post_bank_row", ref: "W5", date: "2026-09-20", amount: -40, accountCode: codes.expense, basis: "senior_accountant", reason: "Bank service fee." },
        ] } }], "tool_use");
      }
      if (results === 1) return reply([{ type: "tool_use", id: "toolu_2", name: "prepare_financial_statements", input: { month: "2026-09" } }], "tool_use");
      return reply([{ type: "text", text: "Done: posted 4 rows (W1, W2, W3, W5) and prepared the September statements. Held: W4 loan payment $1,250.00 — needs the lender's principal/interest split." }], "end_turn");
    }
    return reply([{ type: "text", text: `Answer to: ${asked.slice(0, 40)}` }], "end_turn");
  }));
});
afterEach(() => { vi.unstubAllGlobals(); delete process.env.ANTHROPIC_API_KEY; });

const CSV = (rows: string[]) => ["Date,Description,Amount", ...rows].join("\n");

async function world() {
  const tabitha = await makeUser("ADMIN", "Tabitha");
  await prisma.ownerAccess.create({ data: { userId: tabitha.id, isPrimary: true } });
  const daria = await makeUser("STAFF", "Daria");
  const tangelia = await makeUser("STAFF", "Tangelia");
  const mk = (name: string, assignedToId?: string) => createClient(tabitha, { businessName: name, clientType: "BUSINESS", status: "ACTIVE", ...(assignedToId ? { assignedToId } : {}) });
  const parrish = await mk("Pinecrest Example Agency (fictional)");
  const willow = await mk("Willow Example Bakery (fictional)", daria.id);
  const harbor = await mk("Harbor Example Co (fictional)", tangelia.id);
  await managed(parrish.id, willow.id, harbor.id);
  for (const c of [parrish, willow, harbor]) await setupLedger(tabitha, c.id, { basis: "CASH" });
  const bank = await prisma.ledgerAccount.findFirstOrThrow({ where: { clientId: parrish.id, code: "1000" } });
  await importBankCsv(tabitha, parrish.id, bank.id, { fileName: "sep.csv", text: CSV(["09/02/2026,OFFICE DEPOT 1123,-120.00", "09/04/2026,SQUARE INC SETTLEMENT,2500.00", "09/08/2026,OFFICE DEPOT 1188,-75.50", "09/15/2026,LOAN PMT FICTIONAL BANK,-1250.00", "09/20/2026,MONTHLY SERVICE FEE,-40.00"]) });
  const exp = await prisma.ledgerAccount.findFirstOrThrow({ where: { clientId: parrish.id, type: "EXPENSE" }, orderBy: { code: "asc" } });
  const inc = await prisma.ledgerAccount.findFirstOrThrow({ where: { clientId: parrish.id, type: "INCOME" }, orderBy: { code: "asc" } });
  codes = { expense: exp.code, income: inc.code };
  await setOwnerSwitch(tabitha, "coetha", true);
  await setOwnerSwitch(tabitha, "coethaAutoPost", true);
  return { tabitha, daria, tangelia, parrish, willow, harbor };
}

const ok = (text: string): ChatCallOutcome => ({ ok: true, ms: 1200, message: { id: "msg_x", type: "message", role: "assistant", model: "claude-test", content: [{ type: "text", text, citations: null }], stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 500, output_tokens: 40 } } as never });

describe("Coetha does the work first, then reports", () => {
  it("“complete the books”: supported rows are posted, the loan payment is isolated, statements are prepared, and the answer reports it", async () => {
    const w = await world();
    const before = await prisma.journalEntry.count({ where: { clientId: w.parrish.id } });
    const r = await askCoetha(w.tabitha, w.parrish.id, "Complete the September books for this client.");
    expect(r.queued).toBe(false);
    // Three AI calls: post (one call for every supported row), statements, report.
    expect(sent).toHaveLength(3);
    expect(sent[0].tools?.map((t) => t.name)).toEqual(expect.arrayContaining(["prepare_entries", "prepare_financial_statements"]));
    // Posted under her standing authorization: 4 entries; the loan payment still waits.
    expect(await prisma.journalEntry.count({ where: { clientId: w.parrish.id } })).toBe(before + 4);
    const left = await prisma.bankTransaction.findMany({ where: { clientId: w.parrish.id, status: "UNREVIEWED" }, select: { description: true } });
    expect(left.map((t) => t.description)).toEqual(["LOAN PMT FICTIONAL BANK"]);
    // The month's statements are saved as drafts.
    expect(await prisma.document.count({ where: { clientId: w.parrish.id, reportType: { in: ["PROFIT_AND_LOSS", "BALANCE_SHEET"] }, year: 2026, month: 9 } })).toBe(2);
    expect(r.text).toMatch(/posted 4 rows[\s\S]*Held: W4 loan payment/);
    const run = await prisma.coethaAnswerRun.findUniqueOrThrow({ where: { questionId: r.questionId } });
    expect(run).toMatchObject({ status: "DONE", round: 2 });
    expect((run.timings as { step: string }[]).map((t) => t.step)).toEqual(["gather", "ai", "tools", "ai", "tools", "ai"]);
    // Nothing from another client was sent.
    expect(JSON.stringify(sent)).not.toMatch(/Willow Example|Harbor Example/);
  });

  it("Tabitha's instructions tell her to act, not to plan", async () => {
    const w = await world();
    await askCoetha(w.tabitha, w.willow.id, "What is my cash balance?");
    const system = sent[0].system.map((b) => b.text).join("\n");
    expect(system).toMatch(/DO THE WORK, THEN REPORT/);
    expect(system).toMatch(/never answer with a plan/);
    expect(system).toMatch(/one exception never stops the rest/);
  });
});

describe("Several staff at once", () => {
  it("three staff on three clients are worked in parallel (capped office-wide); questions in one chat go in order", async () => {
    const w = await world();
    const a = await askCoetha(w.tabitha, w.parrish.id, "Question A", { inline: false, chat: "c_aaaaaaaa1" });
    const b = await askCoetha(w.daria, w.willow.id, "Question B", { inline: false, chat: "c_bbbbbbbb1" });
    const c = await askCoetha(w.tangelia, w.harbor.id, "Question C", { inline: false, chat: "c_cccccccc1" });
    const a2 = await askCoetha(w.tabitha, w.parrish.id, "Question A2 (same chat)", { inline: false, chat: "c_aaaaaaaa1" });
    for (const q of [a, b, c, a2]) expect(q.queued).toBe(true);
    const calls = [await nextCall(), await nextCall(), await nextCall()];
    expect(MAX_LIVE).toBe(3);
    const runIds = calls.map((x) => x!.runId);
    expect(new Set(runIds).size).toBe(3);
    // The 4th call waits: three are out already (and A2 waits for A in its chat anyway).
    expect(await nextCall()).toBeNull();
    // Each is answered independently; every request carries only its own client's records.
    for (const call of calls) {
      const run = await prisma.coethaAnswerRun.findUniqueOrThrow({ where: { id: call!.runId } });
      const sys = JSON.stringify(call!.request.system);
      if (run.clientId !== w.parrish.id) expect(sys).not.toMatch(/OFFICE DEPOT/);
      expect((await applyResult(call!.runId, call!.callId, ok(`Answer for ${run.clientId}`))).done).toBe(true);
    }
    // Now A2 goes (A is answered).
    const next = await nextCall();
    expect(next).not.toBeNull();
    expect((await prisma.coethaAnswerRun.findUniqueOrThrow({ where: { id: next!.runId } })).questionId).toBe(a2.questionId);
    await applyResult(next!.runId, next!.callId, ok("Answer A2"));
    expect(await prisma.coethaChatMessage.count({ where: { role: "USER", status: "ANSWERED" } })).toBe(4);
    expect(await prisma.coethaChatMessage.count({ where: { role: "COETHA" } })).toBe(4);
  });

  it("a busy AI service delays only that question (retried with backoff); a late or duplicate result is ignored", async () => {
    const w = await world();
    const q = await askCoetha(w.daria, w.willow.id, "Busy test", { inline: false });
    const call = (await nextCall())!;
    await applyResult(call.runId, call.callId, { ok: false, code: "RATE_LIMIT", message: "Anthropic's rate limit was reached.", retryAfterMs: 30_000, ms: 300 });
    const run = await prisma.coethaAnswerRun.findUniqueOrThrow({ where: { id: call.runId } });
    expect(run).toMatchObject({ status: "QUEUED", phase: "RETRYING", attempts: 1 });
    expect(await nextCall()).toBeNull();
    // The old call's result arriving late does nothing.
    expect(await applyResult(call.runId, call.callId, ok("late"))).toMatchObject({ ignored: true });
    const later = (await nextCall({ now: new Date(Date.now() + 31_000) }))!;
    expect(later.runId).toBe(call.runId);
    await applyResult(later.runId, later.callId, ok("Answered after the retry"));
    expect(await prisma.coethaChatMessage.findUniqueOrThrow({ where: { id: q.questionId } })).toMatchObject({ status: "ANSWERED" });
    expect(await prisma.coethaChatMessage.count({ where: { role: "COETHA", clientId: w.willow.id } })).toBe(1);
  });

  it("access is checked again when the answer starts: someone who lost access gets nothing sent", async () => {
    const w = await world();
    const q = await askCoetha(w.daria, w.willow.id, "Access test", { inline: false });
    await prisma.client.update({ where: { id: w.willow.id }, data: { assignedToId: null } });
    expect(await nextCall()).toBeNull();
    expect(sent).toHaveLength(0);
    expect(await prisma.coethaChatMessage.findUniqueOrThrow({ where: { id: q.questionId } })).toMatchObject({ status: "FAILED" });
  });
});
