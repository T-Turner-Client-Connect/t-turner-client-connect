import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { makeUser, managed, prisma, resetDb } from "./db";
import { ForbiddenError } from "@/lib/auth/actor";
import { createClient } from "@/lib/services/clients";
import { importBankCsv, setupLedger } from "@/lib/services/ledger";
import { setOwnerSwitch } from "@/lib/services/owner-switches";
import { setCoethaOptOut } from "@/lib/services/coetha-opt-out";
import { COETHA_NO_KEY, COETHA_OFF } from "@/lib/services/coetha";
import { askCoetha, chatFileType, chatKey, cleanQuestion, coethaChatView, EARLIER_CHAT, MAX_CHAT_FILE, MAX_CHAT_FILES, MAX_QUESTION, newChatKey } from "@/lib/services/coetha-chat";

// A local stand-in for Anthropic's Messages API. Nothing leaves this test: any other host fails.
// Fictional businesses, people and transactions only.
type Block = { type: string; text?: string; source?: { type: string; media_type: string; data: string } };
type Req = { model: string; system: { type: string; text: string }[]; messages: { role: string; content: string | Block[] }[]; tools?: unknown; max_tokens: number };
let sent: Req[] = [];
let mode: "ok" | "refusal" | "error" | "long" | "busy" = "ok";

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
    if (mode === "busy") return new Response(JSON.stringify({ type: "error", error: { type: "rate_limit_error", message: "slow down" } }), { status: 429, headers: { ...headers, "retry-after-ms": "1" } });
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
    // The large, unchanging part (instructions, books, records) is cached, so repeat sends in an
    // answer don't count again against the AI service's per-minute limit.
    const recordsBlock = (sent[0].system as { text: string; cache_control?: { type: string } }[]).find((b) => b.text.startsWith("Records (JSON)"))!;
    expect(recordsBlock.cache_control).toEqual({ type: "ephemeral" });
    // A staff member asking: read-only searches of this business, and the monthly checklist (clearing
    // a line is checked against the person asking).
    expect((sent[0].tools as { name: string }[]).map((t) => t.name)).toEqual(["search_bank_transactions", "search_journal_entries", "monthly_checklist", "update_checklist"]);
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
    await askCoetha(s.daria, s.vessel.id, "", { ...today, files: [{ bytes: png, originalName: "check-1043.png", mimeType: "image/png" }] });
    const content = sent[0].messages[sent[0].messages.length - 1].content as Block[];
    expect(content[0]).toMatchObject({ type: "image", source: { type: "base64", media_type: "image/png" } });
    expect(content[1].text).toMatch(/read the attached file/);
    const q = await prisma.coethaChatMessage.findFirstOrThrow({ where: { role: "USER" } });
    expect(q.attachmentName).toBe("check-1043.png");
    const doc = await prisma.document.findUniqueOrThrow({ where: { id: q.documentId! } });
    expect(doc).toMatchObject({ clientId: s.vessel.id, category: "BOOKKEEPING", visibility: "STAFF_ONLY" });
    expect((await coethaChatView(s.daria, s.vessel.id)).messages[0].attachments).toEqual([{ documentId: doc.id, name: "check-1043.png" }]);
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
    await askCoetha(s.daria, s.vessel.id, "What is this?", { ...today, files: [{ bytes: pdf, originalName: "stmt.pdf", mimeType: "application/pdf" }] });
    expect((sent[0].messages[sent[0].messages.length - 1].content as Block[])[0]).toMatchObject({ type: "document", source: { media_type: "application/pdf" } });
    const docs = await prisma.document.count();
    // A renamed text file is refused by its content, not its name.
    await expect(askCoetha(s.daria, s.vessel.id, "Hi", { ...today, files: [{ bytes: new TextEncoder().encode("not a pdf"), originalName: "x.pdf", mimeType: "application/pdf" }] })).rejects.toThrow(/PDF or a picture/);
    await expect(askCoetha(s.daria, s.vessel.id, "Hi", { ...today, files: [{ bytes: new Uint8Array(MAX_CHAT_FILE + 1), originalName: "big.pdf", mimeType: "application/pdf" }] })).rejects.toThrow(/under 5 MB/);
    mode = "error";
    await expect(askCoetha(s.daria, s.vessel.id, "Hi", { ...today, files: [{ bytes: pdf, originalName: "again.pdf", mimeType: "application/pdf" }] })).rejects.toThrow(/wasn't saved/);
    expect(await prisma.document.count()).toBe(docs);
    expect(await prisma.coethaChatMessage.count({ where: { role: "USER" } })).toBe(1);
    // Someone without access to the books can't send a file either.
    mode = "ok";
    await expect(askCoetha(s.stranger, s.vessel.id, "Hi", { ...today, files: [{ bytes: pdf, originalName: "x.pdf", mimeType: "application/pdf" }] })).rejects.toBeInstanceOf(ForbiddenError);
    expect(await prisma.document.count()).toBe(docs);
  });

  it("up to three files go with one question: a check image and its statement page together", async () => {
    const s = await setup();
    const png = Uint8Array.from(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64"));
    const pdf = new TextEncoder().encode("%PDF-1.4\n%fictional statement\n");
    await askCoetha(s.daria, s.vessel.id, "Does check 1043 clear on this statement?", { ...today, files: [{ bytes: png, originalName: "check-1043.png", mimeType: "image/png" }, { bytes: pdf, originalName: "oct-statement.pdf", mimeType: "application/pdf" }] });
    const content = sent[0].messages[sent[0].messages.length - 1].content as Block[];
    expect(content.map((b) => b.type)).toEqual(["image", "document", "text"]);
    const v = (await coethaChatView(s.daria, s.vessel.id)).messages[0];
    expect(v.attachments.map((a) => a.name)).toEqual(["check-1043.png", "oct-statement.pdf"]);
    const docs = await prisma.document.findMany({ where: { id: { in: v.attachments.map((a) => a.documentId) } } });
    expect(docs.every((d) => d.clientId === s.vessel.id && d.visibility === "STAFF_ONLY")).toBe(true);
    await askCoetha(s.daria, s.vessel.id, "And the payee?", today);
    expect(sent[1].messages[0].content).toContain("[Attached earlier: check-1043.png, oct-statement.pdf]");
    // More than three, or one that isn't a PDF or picture, sends and saves nothing.
    const before = await prisma.document.count();
    const four = Array.from({ length: MAX_CHAT_FILES + 1 }, (_, i) => ({ bytes: pdf, originalName: `p${i}.pdf`, mimeType: "application/pdf" }));
    await expect(askCoetha(s.daria, s.vessel.id, "Hi", { ...today, files: four })).rejects.toThrow(/up to 3 files/);
    await expect(askCoetha(s.daria, s.vessel.id, "Hi", { ...today, files: [{ bytes: pdf, originalName: "ok.pdf", mimeType: "application/pdf" }, { bytes: new TextEncoder().encode("hello"), originalName: "notes.txt", mimeType: "text/plain" }] })).rejects.toThrow(/notes.txt/);
    expect(await prisma.document.count()).toBe(before);
    expect(sent).toHaveLength(2);
  });

  it("a bank statement PDF with text reaches Coetha as its text (long numbers shortened); large pictures are refused before sending", async () => {
    const s = await setup();
    const d = await PDFDocument.create();
    const font = await d.embedFont(StandardFonts.Helvetica);
    const page = d.addPage([612, 792]);
    ["Example Bank (fictional) - Account 0000123456789", "09/25/2026 Check 178 -18,000.00", "10/01/2026 Wire Transfer In 19,000.00", "10/01/2026 Wire Transfer Fee -15.00"].forEach((l, i) => page.drawText(l, { x: 40, y: 740 - i * 16, size: 10, font }));
    const pdf = await d.save();
    await askCoetha(s.daria, s.vessel.id, "What does this statement show for the wire?", { ...today, files: [{ bytes: pdf, originalName: "statement.pdf", mimeType: "application/pdf" }] });
    const blocks = sent[0].messages[sent[0].messages.length - 1].content as Block[];
    expect(blocks.map((b) => b.type)).toEqual(["text", "text"]);
    expect(blocks[0].text).toContain("statement.pdf");
    expect(blocks[0].text).toContain("Check 178");
    expect(blocks[0].text).toContain("Wire Transfer In 19,000.00");
    expect(blocks[0].text).not.toContain("0000123456789");
    expect(blocks[0].text).toContain("…6789");
    // The original PDF is still kept for the business.
    const q = await prisma.coethaChatMessage.findFirstOrThrow({ where: { role: "USER" } });
    expect(q.attachmentName).toBe("statement.pdf");

    // A picture over 3 MB isn't sent (and nothing is saved).
    const big = new Uint8Array(3 * 1024 * 1024 + 10);
    big.set([0x89, 0x50, 0x4e, 0x47]);
    const docs = await prisma.document.count();
    await expect(askCoetha(s.daria, s.vessel.id, "Read this", { ...today, files: [{ bytes: big, originalName: "photo.png", mimeType: "image/png" }] })).rejects.toThrow(/up to 3 MB/);
    expect(sent).toHaveLength(1);
    expect(await prisma.document.count()).toBe(docs);
  });

  it("when the AI service is busy the question is saved, answered in the background a minute later, and never lost", async () => {
    const s = await setup();
    const { workOnce } = await import("@/lib/services/coetha-reading");
    mode = "busy";
    const r = await askCoetha(s.tabitha, s.vessel.id, "Is the Office Depot charge posted?", today);
    expect(r).toMatchObject({ queued: true, answerId: null });
    const q = await prisma.coethaChatMessage.findUniqueOrThrow({ where: { id: r.questionId } });
    expect(q).toMatchObject({ role: "USER", status: "WAITING", text: "Is the Office Depot charge posted?" });
    expect(await prisma.auditLog.count({ where: { action: "coetha.chat_queued", entityId: q.id } })).toBe(1);

    // The background worker tries; still busy: it stays waiting and isn't retried within the minute.
    await workOnce({ clientId: s.vessel.id });
    expect((await prisma.coethaChatMessage.findUniqueOrThrow({ where: { id: q.id } })).status).toBe("WAITING");
    const calls = sent.length;
    await workOnce({ clientId: s.vessel.id });
    expect(sent.length).toBe(calls);

    // A minute later the service answers: the reply is placed right after the question, with her tools.
    await prisma.auditLog.updateMany({ where: { action: "coetha.answer_attempt", entityId: q.id }, data: { createdAt: new Date(Date.now() - 2 * 60_000) } });
    mode = "ok";
    await workOnce({ clientId: s.vessel.id });
    expect((await prisma.coethaChatMessage.findUniqueOrThrow({ where: { id: q.id } })).status).toBe("ANSWERED");
    const v = await coethaChatView(s.tabitha, s.vessel.id);
    expect(v.messages.map((m) => m.role)).toEqual(["USER", "COETHA"]);
    expect((sent.at(-1)!.tools as { name: string }[]).map((t) => t.name)).toContain("search_bank_transactions");
    expect(JSON.stringify(sent.at(-1)!.messages.at(-1))).toContain("Is the Office Depot charge posted?");
    expect(JSON.stringify(sent.at(-1)!.messages.at(-1))).not.toContain("What you read from the attached documents");
  });

  it("a question the AI service keeps refusing stops after several tries and says so", async () => {
    const s = await setup();
    const { workOnce } = await import("@/lib/services/coetha-reading");
    mode = "busy";
    const r = await askCoetha(s.tabitha, s.vessel.id, "Anything waiting?", today);
    for (let i = 0; i < 8; i++) {
      await prisma.auditLog.updateMany({ where: { action: "coetha.answer_attempt", entityId: r.questionId }, data: { createdAt: new Date(Date.now() - 2 * 60_000) } });
      await workOnce({ clientId: s.vessel.id });
    }
    expect((await prisma.coethaChatMessage.findUniqueOrThrow({ where: { id: r.questionId } })).status).toBe("FAILED");
    expect(await prisma.auditLog.count({ where: { action: "coetha.answer_attempt", entityId: r.questionId } })).toBe(6);
  });
});

describe("Ask Coetha chats: start fresh, keep the older ones to re-read", () => {
  it("a new chat starts without the earlier messages as context, older chats stay listed and open, and the page shows a short chat with the total for See all", async () => {
    const s = await setup();
    // Messages from before chats existed (no chat id) form one "Earlier conversation".
    await askCoetha(s.tabitha, s.vessel.id, "What is the Office Depot charge?", today);
    await askCoetha(s.tabitha, s.vessel.id, "And the ATM withdrawal?", today);
    expect(sent[1].messages).toHaveLength(3);

    // A new chat: only its own messages go with the question.
    const fresh = newChatKey();
    expect(chatKey(fresh)).toBe(fresh);
    await askCoetha(s.tabitha, s.vessel.id, "Start over: what is left to close October?", { ...today, chat: fresh });
    expect(sent[2].messages).toEqual([{ role: "user", content: "Start over: what is left to close October?" }]);
    await askCoetha(s.tabitha, s.vessel.id, "Thanks. Anything else?", { ...today, chat: fresh });
    expect(sent[3].messages.map((m) => m.content)).toEqual(["Start over: what is left to close October?", expect.stringContaining("You asked"), "Thanks. Anything else?"]);

    // The list: newest chat first, titled by its first question; the earlier one is still there.
    const v = await coethaChatView(s.daria, s.vessel.id, { limit: 2 });
    expect(v.chats.map((c) => [c.key, c.title, c.count])).toEqual([[fresh, "Start over: what is left to close October?", 4], [EARLIER_CHAT, "Earlier conversation", 4]]);
    // By default the most recent chat is open, shortened to the newest messages, with its total.
    expect(v.chat).toMatchObject({ key: fresh, total: 4, isNew: false });
    expect(v.messages.map((m) => m.text)).toEqual(["Thanks. Anything else?", expect.stringContaining("Anything else?")]);
    // Clicking the older chat opens it in full to re-read.
    const old = await coethaChatView(s.daria, s.vessel.id, { chat: EARLIER_CHAT });
    expect(old.messages.map((m) => m.text)[0]).toBe("What is the Office Depot charge?");
    expect(old.messages).toHaveLength(4);
    // Continuing the older chat sends that chat's messages, not the new one's.
    await askCoetha(s.tabitha, s.vessel.id, "Back to the ATM one: owner draw?", { ...today, chat: EARLIER_CHAT });
    expect(sent[4].messages[0].content).toBe("What is the Office Depot charge?");
    expect(JSON.stringify(sent[4].messages)).not.toContain("close October");

    // A not-yet-used chat id shows an empty new chat; a malformed one falls back to the latest chat.
    const blank = await coethaChatView(s.daria, s.vessel.id, { chat: newChatKey() });
    expect(blank.chat.isNew).toBe(true);
    expect(blank.messages).toHaveLength(0);
    expect(chatKey("../../etc")).toBeNull();
    // Each business has its own chats.
    expect((await coethaChatView(s.tabitha, s.harbor.id)).chats).toHaveLength(0);
  });
});
