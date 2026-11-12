import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeUser, managed, prisma, resetDb } from "./db";
import { createClient } from "@/lib/services/clients";
import { saveProfile } from "@/lib/services/bookkeeping-clients";
import { setupLedger } from "@/lib/services/ledger";
import { setOwnerSwitch } from "@/lib/services/owner-switches";
import { applyResult, nextCall } from "@/lib/services/coetha-answer";
import { assignBookkeeping, bookkeepingChat, bookkeepingQueueStatus } from "@/lib/services/bookkeeping-queue";
import type { ChatCallOutcome } from "@/lib/coetha-model";

// Fictional clients only. The AI call is played by the test (the queue and the database are real).
beforeEach(async () => { await resetDb(); process.env.ANTHROPIC_API_KEY = "sk-ant-test-fictional-key"; });
afterEach(() => { delete process.env.ANTHROPIC_API_KEY; });

const ok = (text: string): ChatCallOutcome => ({ ok: true, ms: 900, message: { id: "m", type: "message", role: "assistant", model: "claude-test", content: [{ type: "text", text, citations: null }], stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 10, output_tokens: 10 } } as never });

async function world() {
  const tabitha = await makeUser("ADMIN", "Tabitha");
  await prisma.ownerAccess.create({ data: { userId: tabitha.id, isPrimary: true } });
  const mk = async (name: string, books: boolean) => {
    const c = await createClient(tabitha, { businessName: name, clientType: "BUSINESS", status: "ACTIVE" });
    await saveProfile(tabitha, c.id, { active: true, frequency: "MONTHLY", payroll: false, payrollFrequency: null, payrollProvider: null });
    if (books) await setupLedger(tabitha, c.id, { basis: "CASH" });
    return c;
  };
  const a = await mk("Alder Example Agency (fictional)", true);
  const b = await mk("Birch Example Bakery (fictional)", true);
  const c = await mk("Cedar Example Co (fictional)", false);
  await managed(a.id, b.id, c.id);
  await setOwnerSwitch(tabitha, "coetha", true);
  await setOwnerSwitch(tabitha, "coethaAutoPost", true);
  return { tabitha, a, b, c };
}
const monthOf = async (runId: string) => {
  const r = await prisma.coethaAnswerRun.findUniqueOrThrow({ where: { id: runId } });
  const q = await prisma.coethaChatMessage.findUniqueOrThrow({ where: { id: r.questionId } });
  return [r.clientId, /\((\d{4}-\d{2})\)/.exec(q.text)![1]] as const;
};

describe("Coetha's bookkeeping work queue across clients", () => {
  it("queues every client's months, works clients side by side and months in order, skips a blocked client, resumes after a stop", async () => {
    const w = await world();
    const r = await assignBookkeeping(w.tabitha, { from: "2026-09", to: "2026-10" });
    expect(r.queued.map((q) => q.months)).toEqual([["2026-09", "2026-10"], ["2026-09", "2026-10"]]);
    expect(r.blocked.map((b) => b.client)).toEqual(["Cedar Example Co (fictional)"]);
    // Assigning again queues nothing twice.
    expect((await assignBookkeeping(w.tabitha, { from: "2026-09", to: "2026-10" })).queued).toEqual([]);
    expect(await prisma.coethaAnswerRun.count()).toBe(4);
    // Each client's work is in its own bookkeeping chat.
    expect(await prisma.coethaAnswerRun.count({ where: { chatId: bookkeepingChat(w.a.id) } })).toBe(2);

    // Both clients' September goes at once; October waits for September in each client's chat.
    const first = [await nextCall(), await nextCall()];
    expect(await nextCall()).toBeNull();
    const got = await Promise.all(first.map((c) => monthOf(c!.runId)));
    expect(got.map(([, m]) => m)).toEqual(["2026-09", "2026-09"]);
    expect(new Set(got.map(([id]) => id))).toEqual(new Set([w.a.id, w.b.id]));

    // The background worker stops mid-call for one client: after its lease runs out the same month resumes.
    const [aCall, bCall] = got[0][0] === w.a.id ? first : [first[1], first[0]];
    await applyResult(bCall!.runId, bCall!.callId, ok("Birch September done. Exceptions: none."));
    await prisma.coethaAnswerRun.update({ where: { id: aCall!.runId }, data: { leaseUntil: new Date(Date.now() - 1000) } });
    const resumed: string[] = [];
    for (let i = 0; i < 2; i++) { const n = await nextCall(); if (n) resumed.push(n.runId); }
    expect(resumed).toContain(aCall!.runId);
    // The stale call's late result is ignored; the resumed call completes it once.
    expect(await applyResult(aCall!.runId, aCall!.callId, ok("late"))).toMatchObject({ ignored: true });
    for (const id of resumed) {
      const run = await prisma.coethaAnswerRun.findUniqueOrThrow({ where: { id } });
      await applyResult(id, run.callId!, ok("Month done. Exceptions: none."));
    }
    // Then the rest.
    for (let i = 0; i < 4; i++) { const n = await nextCall(); if (n) await applyResult(n.runId, n.callId, ok("Month done.")); }
    expect(await prisma.coethaAnswerRun.count({ where: { status: "DONE" } })).toBe(4);
    expect(await prisma.coethaChatMessage.count({ where: { role: "COETHA", clientId: w.a.id } })).toBe(2);
    const status = await bookkeepingQueueStatus([w.a.id, w.b.id, w.c.id]);
    expect(status.get(w.a.id)!.done).toEqual(["2026-09", "2026-10"]);
    expect(status.get(w.b.id)!.done).toEqual(["2026-09", "2026-10"]);
    expect(status.get(w.c.id)!.done).toEqual([]);
  });

  it("only Tabitha assigns bookkeeping to Coetha", async () => {
    await world();
    const daria = await makeUser("STAFF", "Daria");
    await expect(assignBookkeeping(daria, { from: "2026-09", to: "2026-09" })).rejects.toThrow(/Only Tabitha/);
  });
});
