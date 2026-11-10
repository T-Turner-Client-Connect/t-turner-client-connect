import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeUser, managed, prisma, resetDb } from "./db";
import { ForbiddenError } from "@/lib/auth/actor";
import { createClient } from "@/lib/services/clients";
import { importBankCsv, setupLedger } from "@/lib/services/ledger";
import { setOwnerSwitch } from "@/lib/services/owner-switches";
import { setCoethaOptOut } from "@/lib/services/coetha-opt-out";
import { COETHA_NO_KEY, COETHA_OFF } from "@/lib/services/coetha";
import { askCoetha, chatFileType, cleanQuestion, coethaChatView, MAX_CHAT_FILE, MAX_QUESTION } from "@/lib/services/coetha-chat";

// A local stand-in for Anthropic's Messages API. Nothing leaves this test: any other host fails.
// Fictional businesses, people and transactions only.
type Block = { type: string; text?: string; source?: { type: string; media_type: string; data: string } };
type Req = { model: string; system: { type: string; text: string }[]; messages: { role: string; content: string | Block[] }[]; tools?: unknown; max_tokens: number };
let sent: Req[] = [];
let mode: "ok" | "refusal" | "error" | "long" = "ok";

beforeEach(async () => {
  await resetDb();
  sent = []; mode = "ok";
  process.env.ANTHROPIC_API_KEY = "sk-ant-test-fictional-key";
  delete process.env.COETHA_MODEL;
  vi.stubGlobal("fetch", vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const u = new URL(typeof url === "string" ? url : url instanceof URL ? url.href : url.url);
    if (u.host !== "api.anthropic.com" || u.pathname !== "/v1/messages") throw new Error(`Unexpected request: ${u.href}`);
    const req = JSON.parse(String(init?.body ?? "")) as Req;
    sent.push(req);
    const headers = { "content-type": "application/json", "request-id": "req_fictional_chat" };
    if (mode === "error") return new Response(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "bad" } }), { status: 400, headers });
    const last = req.messages[req.messages.length - 1].content;
    const text = `You asked: ${last}. Office Depot (T1) is $84.20 to 6300 Office Supplies.`;
    const content = mode === "refusal" ? [] : [{ type: "text", text }];
    const stop = mode === "refusal" ? "refusal" : mode === "long" ? "max_tokens" : "end_turn";
    return new Response(JSON.stringify({ id: "msg_fictional_chat", type: "message", role: "assistant", model: req.model, content, stop_reason: stop, stop_sequence: null, usage: { input_tokens: 2100, output_tokens: 90 } }), { status: 200, headers });
  }));
});
afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.ANTHROPIC_API_KEY;
});

const CSV = (rows: string[]) => ["Date,Description,Amount", ...rows].join("\n");

async function setup({ on = true } = {}) {
  const tabitha = await makeUser("ADMIN", "Tabitha");
  await prisma.ownerAccess.create({ data: { userId: tabitha.id, isPrimary: true } });
  const daria = await makeUser("STAFF", "Daria");
  const stranger = await makeUser("STAFF", "Stranger");
  const vessel = await createClient(tabitha, { businessName: "Vessel Example LLC (fictional)", clientType: "BUSINESS", status: "ACTIVE", assignedToId: daria.id, email: "owner@vessel.example" });
  const harbor = await createClient(tabitha, { businessName: "Harbor Example Co (fictional)", clientType: "BUSINESS", status: "ACTIVE" });
  await managed(vessel.id, harbor.id);
  for (const c of [vessel, harbor]) await setupLedger(tabitha, c.id, { basis: "CASH" });
  const acct = async (clientId: string, code: string) => (await prisma.ledgerAccount.findFirstOrThrow({ where: { clientId, code } })).id;
  await importBankCsv(daria, vessel.id, await acct(vessel.id, "1000"), { fileName: "oct.csv", text: CSV(["10/02/2026,OFFICE DEPOT #1123,-84.20", "10/09/2026,ATM WITHDRAWAL 987654321,-300.00"]) });
  await importBankCsv(tabitha, harbor.id, await acct(harbor.id, "1000"), { fileName: "h.csv", text: CSV(["10/03/2026,SECRETHARBORVENDOR PAYMENT,-999.00"]) });
  if (on) await setOwnerSwitch(tabitha, "coetha", true);
  return { tabitha, daria, stranger, vessel, harbor };
}
const today = { today: "2026-11-09" };

describe("Ask Coetha: a back-and-forth conversation about one client's books", () => {
  it("answers from this client's books only, keeps the thread, and sends earlier turns as context", async () => {
    const s = await setup();
    const r1 = await askCoetha(s.daria, s.vessel.id, "What is the Office Depot charge?", today);
    expect(r1.text).toContain("6300");
    expect(sent).toHaveLength(1);
    const body = JSON.stringify(sent[0]);
    // This client's books are sent; the other client's never are, and neither are contact details.
    expect(body).toContain("OFFICE DEPOT");
    expect(body).not.toContain("SECRETHARBORVENDOR");
    expect(body).not.toContain("owner@vessel.example");
    expect(body).not.toContain("987654321");
    // No tools: Coetha can't act from a chat.
    expect(sent[0].tools).toBeUndefined();
    expect(sent[0].messages).toEqual([{ role: "user", content: "What is the Office Depot charge?" }]);

    await askCoetha(s.tabitha, s.vessel.id, "And the ATM withdrawal?", today);
    expect(sent[1].messages.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
    expect(sent[1].messages[2].content).toBe("And the ATM withdrawal?");

    const v = await coethaChatView(s.daria, s.vessel.id);
    expect(v.messages.map((m) => [m.role, m.author])).toEqual([["USER", "Daria"], ["COETHA", "Coetha"], ["USER", "Tabitha"], ["COETHA", "Coetha"]]);
    expect(v.canAsk).toBe(true);
    // Each business has its own thread.
    expect((await coethaChatView(s.tabitha, s.harbor.id)).messages).toHaveLength(0);
    // Audited without the text.
    const logs = await prisma.auditLog.findMany({ where: { action: "coetha.chat", clientId: s.vessel.id } });
    expect(logs).toHaveLength(2);
    expect(JSON.stringify(logs)).not.toContain("Office Depot charge");
  });

  it("never changes the books", async () => {
    const s = await setup();
    const before = await Promise.all([prisma.journalEntry.count(), prisma.bankTransaction.count({ where: { status: "UNREVIEWED" } }), prisma.coethaProposal.count()]);
    await askCoetha(s.daria, s.vessel.id, "Please post the Office Depot charge to 6300.", today);
    const after = await Promise.all([prisma.journalEntry.count(), prisma.bankTransaction.count({ where: { status: "UNREVIEWED" } }), prisma.coethaProposal.count()]);
    expect(after).toEqual(before);
  });

  it("only staff who can open this client's books can read or ask", async () => {
    const s = await setup();
    await askCoetha(s.daria, s.vessel.id, "Hello", today);
    await expect(askCoetha(s.stranger, s.vessel.id, "Show me the books", today)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(coethaChatView(s.stranger, s.vessel.id)).rejects.toBeInstanceOf(ForbiddenError);
    // Daria is assigned to Vessel, not Harbor.
    await expect(askCoetha(s.daria, s.harbor.id, "Hello", today)).rejects.toBeInstanceOf(ForbiddenError);
    expect(sent).toHaveLength(1);
  });

  it("respects the Coetha switch, the API key and 'Client prefers no Coetha'; nothing is sent", async () => {
    const s = await setup({ on: false });
    await expect(askCoetha(s.daria, s.vessel.id, "Hello", today)).rejects.toThrow(COETHA_OFF);
    await setOwnerSwitch(s.tabitha, "coetha", true);
    delete process.env.ANTHROPIC_API_KEY;
    await expect(askCoetha(s.daria, s.vessel.id, "Hello", today)).rejects.toThrow(COETHA_NO_KEY);
    process.env.ANTHROPIC_API_KEY = "sk-ant-test-fictional-key";
    await setCoethaOptOut(s.tabitha, s.vessel.id, { toldOn: "2026-11-01", via: "PHONE", note: "" });
    await expect(askCoetha(s.daria, s.vessel.id, "Hello", today)).rejects.toThrow(/prefers no Coetha/);
    expect((await coethaChatView(s.daria, s.vessel.id)).canAsk).toBe(false);
    expect(sent).toHaveLength(0);
    expect(await prisma.coethaChatMessage.count()).toBe(0);
  });

  it("de-identifies the question before it is sent or saved", async () => {
    const s = await setup();
    await askCoetha(s.daria, s.vessel.id, "Owner SSN 123-45-6789, EIN 12-3456789, card 4111111111111111, email a@b.example, phone (205) 555-0100: is the draw OK?", today);
    const q = sent[0].messages[0].content;
    for (const secret of ["123-45-6789", "12-3456789", "4111111111111111", "a@b.example", "555-0100"]) expect(q).not.toContain(secret);
    expect(q).toContain("…1111");
    const saved = await prisma.coethaChatMessage.findFirstOrThrow({ where: { role: "USER" } });
    expect(saved.text).toBe(q);
    expect(() => cleanQuestion("   ")).toThrow(/Type a question/);
    expect(() => cleanQuestion("x".repeat(MAX_QUESTION + 1))).toThrow(/under/);
  });

  it("a failed or refused answer saves nothing and says so; a cut-off answer is marked", async () => {
    const s = await setup();
    mode = "error";
    await expect(askCoetha(s.daria, s.vessel.id, "Hello", today)).rejects.toThrow(/couldn't answer.*wasn't saved/);
    mode = "refusal";
    await expect(askCoetha(s.daria, s.vessel.id, "Hello", today)).rejects.toThrow(/declined/);
    expect(await prisma.coethaChatMessage.count()).toBe(0);
    expect(await prisma.auditLog.count({ where: { action: "coetha.chat_failed" } })).toBe(2);
    mode = "long";
    const r = await askCoetha(s.daria, s.vessel.id, "Hello", today);
    expect(r.text).toMatch(/cut off/);
  });

  it("a file (check image or PDF) goes with the question, is kept as a staff-only document for that business only, and nothing is posted", async () => {
    const s = await setup();
    // A tiny fictional PNG (1x1) standing in for a check image.
    const png = Uint8Array.from(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64"));
    expect(chatFileType(png)).toBe("image/png");
    const before = await prisma.journalEntry.count();
    await askCoetha(s.daria, s.vessel.id, "", { ...today, file: { bytes: png, originalName: "check-1043.png", mimeType: "image/png" } });
    const content = sent[0].messages[sent[0].messages.length - 1].content as Block[];
    expect(content[0]).toMatchObject({ type: "image", source: { type: "base64", media_type: "image/png" } });
    expect(content[1].text).toMatch(/read the attached file/);
    const q = await prisma.coethaChatMessage.findFirstOrThrow({ where: { role: "USER" } });
    expect(q.attachmentName).toBe("check-1043.png");
    const doc = await prisma.document.findUniqueOrThrow({ where: { id: q.documentId! } });
    expect(doc).toMatchObject({ clientId: s.vessel.id, category: "BOOKKEEPING", visibility: "STAFF_ONLY" });
    expect((await coethaChatView(s.daria, s.vessel.id)).messages[0]).toMatchObject({ attachmentName: "check-1043.png", documentId: doc.id });
    // The next question doesn't resend the file; Coetha is told one was attached.
    await askCoetha(s.daria, s.vessel.id, "Which account should it go to?", today);
    expect(JSON.stringify(sent[1].messages)).not.toContain("iVBORw0KGgo");
    expect(sent[1].messages[0].content).toContain("[Attached earlier: check-1043.png]");
    // The other business sees none of it.
    expect((await coethaChatView(s.tabitha, s.harbor.id)).messages).toHaveLength(0);
    expect(await prisma.document.count({ where: { clientId: s.harbor.id } })).toBe(0);
    expect(await prisma.journalEntry.count()).toBe(before);
  });

  it("a PDF goes as a document; other files, oversized files and failed answers save nothing", async () => {
    const s = await setup();
    const pdf = new TextEncoder().encode("%PDF-1.4\n%fictional\n");
    await askCoetha(s.daria, s.vessel.id, "What is this?", { ...today, file: { bytes: pdf, originalName: "stmt.pdf", mimeType: "application/pdf" } });
    expect((sent[0].messages[sent[0].messages.length - 1].content as Block[])[0]).toMatchObject({ type: "document", source: { media_type: "application/pdf" } });
    const docs = await prisma.document.count();
    // A renamed text file is refused by its content, not its name.
    await expect(askCoetha(s.daria, s.vessel.id, "Hi", { ...today, file: { bytes: new TextEncoder().encode("not a pdf"), originalName: "x.pdf", mimeType: "application/pdf" } })).rejects.toThrow(/PDF or a picture/);
    await expect(askCoetha(s.daria, s.vessel.id, "Hi", { ...today, file: { bytes: new Uint8Array(MAX_CHAT_FILE + 1), originalName: "big.pdf", mimeType: "application/pdf" } })).rejects.toThrow(/under 5 MB/);
    mode = "error";
    await expect(askCoetha(s.daria, s.vessel.id, "Hi", { ...today, file: { bytes: pdf, originalName: "again.pdf", mimeType: "application/pdf" } })).rejects.toThrow(/wasn't saved/);
    expect(await prisma.document.count()).toBe(docs);
    expect(await prisma.coethaChatMessage.count({ where: { role: "USER" } })).toBe(1);
    // Someone without access to the books can't send a file either.
    mode = "ok";
    await expect(askCoetha(s.stranger, s.vessel.id, "Hi", { ...today, file: { bytes: pdf, originalName: "x.pdf", mimeType: "application/pdf" } })).rejects.toBeInstanceOf(ForbiddenError);
    expect(await prisma.document.count()).toBe(docs);
  });
});
