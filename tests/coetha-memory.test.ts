import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeUser, managed, prisma, resetDb } from "./db";
import { ForbiddenError } from "@/lib/auth/actor";
import { createClient } from "@/lib/services/clients";
import { importBankCsv, setupLedger } from "@/lib/services/ledger";
import { setOwnerSwitch } from "@/lib/services/owner-switches";
import { askCoetha } from "@/lib/services/coetha-chat";
import { forgetNotes, memoryView, rememberNotes } from "@/lib/services/coetha-memory";

// Fictional businesses only. A local stand-in for Anthropic's Messages API: a question starting
// with "TOOL:" makes the stand-in call the named tool (if offered) with `toolInput`, then answer.
type Req = { system: { type: string; text: string }[]; messages: { role: string; content: unknown }[]; tools?: { name: string }[] };
let sent: Req[] = [];
let toolName = "";
let toolInput: unknown = {};
let toolResults: string[] = [];

beforeEach(async () => {
  await resetDb();
  sent = []; toolResults = [];
  process.env.ANTHROPIC_API_KEY = "sk-ant-test-fictional-key";
  vi.stubGlobal("fetch", vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const u = new URL(typeof url === "string" ? url : url instanceof URL ? url.href : url.url);
    if (u.host !== "api.anthropic.com") throw new Error(`Unexpected request: ${u.href}`);
    const req = JSON.parse(String(init?.body ?? "")) as Req;
    sent.push(req);
    const reply = (content: unknown[], stop: string) => new Response(JSON.stringify({ id: "msg_f", type: "message", role: "assistant", model: "claude-test", content, stop_reason: stop, stop_sequence: null, usage: { input_tokens: 900, output_tokens: 60 } }), { status: 200, headers: { "content-type": "application/json", "request-id": "req_f" } });
    const last = req.messages[req.messages.length - 1];
    if (Array.isArray(last.content) && (last.content as { type: string }[])[0]?.type === "tool_result") {
      toolResults.push(String((last.content as { content: string }[])[0].content));
      return reply([{ type: "text", text: "Saved; I'll apply it from now on." }], "end_turn");
    }
    const asked = typeof last.content === "string" ? last.content : "";
    if (asked.startsWith("TOOL:") && req.tools?.some((t) => t.name === toolName)) return reply([{ type: "tool_use", id: "toolu_1", name: toolName, input: toolInput }], "tool_use");
    return reply([{ type: "text", text: "Here is what I found." }], "end_turn");
  }));
});
afterEach(() => { vi.unstubAllGlobals(); delete process.env.ANTHROPIC_API_KEY; });

async function setup() {
  const tabitha = await makeUser("ADMIN", "Tabitha");
  await prisma.ownerAccess.create({ data: { userId: tabitha.id, isPrimary: true } });
  const daria = await makeUser("STAFF", "Daria");
  const biz = await createClient(tabitha, { businessName: "Willow Example Agency (fictional)", clientType: "BUSINESS", status: "ACTIVE", assignedToId: daria.id });
  const other = await createClient(tabitha, { businessName: "Harbor Example Co (fictional)", clientType: "BUSINESS", status: "ACTIVE" });
  await managed(biz.id, other.id);
  for (const c of [biz, other]) await setupLedger(tabitha, c.id, { basis: "CASH" });
  const gl = (await prisma.ledgerAccount.findFirstOrThrow({ where: { clientId: biz.id, code: "1000" } })).id;
  await importBankCsv(daria, biz.id, gl, { fileName: "sep.csv", text: "Date,Description,Amount\n09/05/2026,CHECK 184,-580.85" });
  await setOwnerSwitch(tabitha, "coetha", true);
  return { tabitha, daria, biz, other };
}
const recordsOf = (r: Req) => r.system.find((b) => b.text.startsWith("Records (JSON)"))!.text;

describe("What Coetha remembers for a business", () => {
  it("Tabitha's decisions are saved once and sent with every later question for that business only", async () => {
    const s = await setup();
    toolName = "remember";
    toolInput = { notes: [
      { kind: "DECISION", text: "Check #184 ($580.85, W1) is a business license renewal; post it to 6195 Business Licenses & Permits." },
      { kind: "HOLD", text: "Hold the Alfa ticket check until Tabitha confirms the recipients and purpose." },
    ] };
    await askCoetha(s.tabitha, s.biz.id, "TOOL: remember that #184 is a business license and hold the Alfa tickets");
    expect(sent[0].tools!.map((t) => t.name)).toEqual(expect.arrayContaining(["remember", "forget"]));
    expect(JSON.parse(toolResults[0]).remembered).toHaveLength(2);

    // The next question carries the notes; another business's questions never do.
    sent = [];
    await askCoetha(s.daria, s.biz.id, "What's still open?");
    expect(recordsOf(sent[0])).toContain("business license renewal");
    expect(recordsOf(sent[0])).toContain("Hold the Alfa ticket check");
    // A staff member can't add or remove notes.
    expect(sent[0].tools!.map((t) => t.name)).not.toContain("remember");
    await expect(rememberNotes(s.daria, s.biz.id, [{ kind: "DECISION", text: "Something" }])).rejects.toBeInstanceOf(ForbiddenError);
    sent = [];
    await askCoetha(s.tabitha, s.other.id, "What's still open?");
    expect(recordsOf(sent[0])).not.toContain("business license renewal");

    // Saying it again doesn't save it twice.
    const again = await rememberNotes(s.tabitha, s.biz.id, [{ kind: "DECISION", text: "Check #184 ($580.85, W1) is a business license renewal; post it to 6195 Business Licenses & Permits." }]);
    expect(again).toMatchObject({ saved: [], skipped: 1 });
    expect((await memoryView(s.daria, s.biz.id)).map((m) => m.kind).sort()).toEqual(["DECISION", "HOLD"]);
  });

  it("a released hold is forgotten (kept in history), and only Tabitha can remove notes", async () => {
    const s = await setup();
    const { saved } = await rememberNotes(s.tabitha, s.biz.id, [{ kind: "HOLD", text: "Hold Group 3 until the entity documents arrive." }]);
    await expect(forgetNotes(s.daria, s.biz.id, [saved[0].id])).rejects.toBeInstanceOf(ForbiddenError);
    toolName = "forget";
    toolInput = { ids: [saved[0].id] };
    await askCoetha(s.tabitha, s.biz.id, "TOOL: the entity documents came in, release the Group 3 hold");
    expect(JSON.parse(toolResults[0])).toEqual({ removed: 1 });
    expect(await memoryView(s.tabitha, s.biz.id)).toHaveLength(0);
    expect(await prisma.coethaMemory.findUniqueOrThrow({ where: { id: saved[0].id } })).toMatchObject({ removedById: s.tabitha.id });
    expect(await prisma.auditLog.count({ where: { clientId: s.biz.id, action: { in: ["coetha.memory_added", "coetha.memory_removed"] } } })).toBe(2);
    // Another business's notes can't be removed from this one.
    const { saved: h } = await rememberNotes(s.tabitha, s.other.id, [{ kind: "INSTRUCTION", text: "Use 6300 for office supplies." }]);
    expect(await forgetNotes(s.tabitha, s.biz.id, [h[0].id])).toBe(0);
  });
});
