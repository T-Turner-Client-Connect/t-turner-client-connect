import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeUser, managed, prisma, resetDb } from "./db";
import { createClient } from "@/lib/services/clients";
import { saveProfile } from "@/lib/services/bookkeeping-clients";
import { postOpeningBalances, setupLedger } from "@/lib/services/ledger";
import { registerAccount } from "@/lib/services/bank-accounts";
import { setOwnerSwitch } from "@/lib/services/owner-switches";
import { staffUploadDocument } from "@/lib/services/documents";
import { askCoetha } from "@/lib/services/coetha-chat";
import { importStatementTransactions } from "@/lib/services/coetha-bookkeeping";

// Fictional businesses, banks, screenshots and transactions only. A local stand-in for Anthropic's API
// plays Coetha's tool calls in order and records every request, so the test sees exactly what she received.
type Block = { type: string; text?: string; source?: { media_type: string; data: string }; content?: unknown };
type Req = { messages: { role: string; content: string | Block[] }[] };
let plan: { name: string; input: unknown }[] = [];
let requests: Req[] = [];
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");
const screenshot = (label: string) => Uint8Array.from(Buffer.concat([PNG, Buffer.from(label)]));

beforeEach(async () => {
  await resetDb();
  plan = []; requests = [];
  process.env.ANTHROPIC_API_KEY = "sk-ant-test-fictional-key";
  vi.stubGlobal("fetch", vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const u = new URL(typeof url === "string" ? url : url instanceof URL ? url.href : url.url);
    if (u.host !== "api.anthropic.com") throw new Error(`Unexpected request: ${u.href}`);
    const req = JSON.parse(String(init?.body ?? "")) as Req;
    requests.push(req);
    const done = req.messages.filter((m) => Array.isArray(m.content) && (m.content as Block[])[0]?.type === "tool_result").length;
    const step = plan[done];
    const content = step ? [{ type: "tool_use", id: `toolu_${done}`, name: step.name, input: step.input }] : [{ type: "text", text: "Done. October entered from the screenshot." }];
    return new Response(JSON.stringify({ id: "m", type: "message", role: "assistant", model: "claude-test", content, stop_reason: step ? "tool_use" : "end_turn", stop_sequence: null, usage: { input_tokens: 10, output_tokens: 10 } }), { status: 200, headers: { "content-type": "application/json" } });
  }));
});
afterEach(() => { vi.unstubAllGlobals(); delete process.env.ANTHROPIC_API_KEY; });

async function world() {
  const tabitha = await makeUser("ADMIN", "Tabitha");
  await prisma.ownerAccess.create({ data: { userId: tabitha.id, isPrimary: true } });
  const biz = await createClient(tabitha, { businessName: "Birch Example Agency LLC (fictional)", clientType: "BUSINESS", status: "ACTIVE" });
  const other = await createClient(tabitha, { businessName: "Cedar Example Shop LLC (fictional)", clientType: "BUSINESS", status: "ACTIVE" });
  await managed(biz.id, other.id);
  for (const c of [biz, other]) {
    await saveProfile(tabitha, c.id, { active: true, frequency: "MONTHLY", payroll: false, payrollFrequency: null, payrollProvider: null });
    await setupLedger(tabitha, c.id, { basis: "CASH" });
  }
  // Registered wrong, as Parrish's was: "Chase" with no number.
  const chk = await registerAccount(tabitha, biz.id, { institution: "Chase", accountType: "CHECKING", gl: "NEW" });
  const gl = await prisma.ledgerAccount.findUniqueOrThrow({ where: { id: (await prisma.bookkeepingAccount.findUniqueOrThrow({ where: { id: chk.id } })).ledgerAccountId! } });
  await postOpeningBalances(tabitha, biz.id, { date: "2026-10-01", balances: [{ accountId: gl.id, amount: "500.00" }] });
  await setOwnerSwitch(tabitha, "coetha", true);
  await setOwnerSwitch(tabitha, "coethaAutoPost", true);
  return { tabitha, biz, other, chk, gl };
}

const october = [
  { date: "2026-10-02", description: "Mobile deposit", amount: 2000 },
  { date: "2026-10-09", description: "Office supply store", amount: -84.56 },
  { date: "2026-10-20", description: "Rent", amount: -1500 },
];

describe("Coetha does the whole job from a screenshot already on file — no new upload", () => {
  it("re-reads the screenshot as the image itself, fixes the wrong bank, enters the statement once (to the cent), files it under the account and month, and saves it all for this client only", async () => {
    const w = await world();
    const shot = screenshot("fictional October bank statement screenshot");
    const doc = await staffUploadDocument(w.tabitha, { clientId: w.biz.id, category: "BOOKKEEPING", title: "Sent to Coetha — oct-statement.png", visibility: "STAFF_ONLY", bytes: shot, originalName: "oct-statement.png", notify: false });
    await prisma.document.update({ where: { id: doc.id }, data: { scanStatus: "CLEAN" } });
    plan = [
      { name: "read_documents_on_file", input: { documentIds: [doc.id] } },
      { name: "correct_accounts", input: { items: [{ code: w.gl.code, institution: "Prairie Example Farm Bank", last4: "4542", reason: "The October statement screenshot is from Prairie Example Farm Bank, account ending 4542." }] } },
      { name: "import_statement_transactions", input: { documentId: doc.id, accountCode: w.gl.code, month: "2026-10", beginningBalance: 500, endingBalance: 915.44, transactions: october } },
    ];
    await askCoetha(w.tabitha, w.biz.id, "Read the October screenshot I sent earlier and enter it.");

    // 1. She received the picture itself in the read tool's result (not only scanner counts).
    const toolResults = requests.at(-1)!.messages.flatMap((m) => (Array.isArray(m.content) ? (m.content as Block[]) : [])).filter((b) => b.type === "tool_result");
    const imageBlocks = toolResults.flatMap((t) => (Array.isArray(t.content) ? (t.content as Block[]) : [])).filter((b) => b.type === "image");
    expect(imageBlocks.map((b) => b.source!.data)).toEqual([Buffer.from(shot).toString("base64")]);
    // 2. The bank is corrected.
    expect(await prisma.bookkeepingAccount.findUniqueOrThrow({ where: { id: w.chk.id } })).toMatchObject({ institution: "Prairie Example Farm Bank", last4: "4542" });
    // 3. The three transactions are saved once, for this client and account only.
    expect(await prisma.bankTransaction.count({ where: { clientId: w.biz.id, accountId: w.gl.id } })).toBe(3);
    expect(await prisma.bankTransaction.count({ where: { clientId: w.other.id } })).toBe(0);
    // 4. The screenshot is filed as the account's October statement and the reconciliation carries its balances.
    expect(await prisma.document.findUniqueOrThrow({ where: { id: doc.id } })).toMatchObject({ docType: "BANK_STATEMENT", bookkeepingAccountId: w.chk.id, year: 2026, month: 10 });
    expect(await prisma.accountReconciliation.findFirstOrThrow({ where: { bookkeepingAccountId: w.chk.id, year: 2026, month: 10 } })).toMatchObject({ beginningBalanceCents: 50000, endingBalanceCents: 91544, statementDocumentId: doc.id });
    // 5. Her answer is saved in the chat.
    expect(await prisma.coethaChatMessage.count({ where: { clientId: w.biz.id, role: "COETHA" } })).toBe(1);
  });

  it("a misread that doesn't add up enters nothing; entering the same statement twice never duplicates rows; another client's document can't be used", async () => {
    const w = await world();
    const doc = await staffUploadDocument(w.tabitha, { clientId: w.biz.id, category: "BOOKKEEPING", title: "oct.png", visibility: "STAFF_ONLY", bytes: screenshot("oct"), originalName: "oct.png", notify: false });
    const bad = await importStatementTransactions(w.tabitha, w.biz.id, { documentId: doc.id, accountCode: w.gl.code, month: "2026-10", beginningBalance: 500, endingBalance: 999, transactions: october });
    expect(bad).toMatchObject({ error: expect.stringMatching(/doesn't add up/) });
    expect(await prisma.bankTransaction.count({ where: { clientId: w.biz.id } })).toBe(0);
    const ok1 = await importStatementTransactions(w.tabitha, w.biz.id, { documentId: doc.id, accountCode: w.gl.code, month: "2026-10", beginningBalance: 500, endingBalance: 915.44, transactions: october });
    const ok2 = await importStatementTransactions(w.tabitha, w.biz.id, { documentId: doc.id, accountCode: w.gl.code, month: "2026-10", beginningBalance: 500, endingBalance: 915.44, transactions: october });
    expect(ok1).toMatchObject({ added: 3 });
    expect(ok2).toMatchObject({ added: 0 });
    expect(await prisma.bankTransaction.count({ where: { clientId: w.biz.id } })).toBe(3);
    const otherDoc = await staffUploadDocument(w.tabitha, { clientId: w.other.id, category: "BOOKKEEPING", title: "x.png", visibility: "STAFF_ONLY", bytes: screenshot("other"), originalName: "x.png", notify: false });
    expect(await importStatementTransactions(w.tabitha, w.biz.id, { documentId: otherDoc.id, accountCode: w.gl.code, month: "2026-10", beginningBalance: 500, endingBalance: 915.44, transactions: october })).toMatchObject({ error: expect.stringMatching(/isn't on file for this business/) });
  });

  it("a picture attached directly to a question reaches her as the image itself", async () => {
    const w = await world();
    const shot = screenshot("fictional credit card statement screenshot");
    await askCoetha(w.tabitha, w.biz.id, "What's on this card statement?", { files: [{ bytes: shot, originalName: "card.png" }] });
    const blocks = requests[0].messages.flatMap((m) => (Array.isArray(m.content) ? (m.content as Block[]) : [])).filter((b) => b.type === "image");
    expect(blocks.map((b) => b.source!.data)).toContain(Buffer.from(shot).toString("base64"));
  });
});
