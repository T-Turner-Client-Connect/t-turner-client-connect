import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { makeUser, managed, prisma, resetDb } from "./db";
import { ForbiddenError } from "@/lib/auth/actor";
import { createClient } from "@/lib/services/clients";
import { importBankCsv, setupLedger } from "@/lib/services/ledger";
import { setOwnerSwitch } from "@/lib/services/owner-switches";
import { coethaChatView } from "@/lib/services/coetha-chat";
import { askAboutDocuments, finishUpload, MAX_ATTEMPTS, putChunk, readingView, retryJob, startUpload, workOnce, workReading } from "@/lib/services/coetha-reading";

// Fictional businesses, checks and scans only. A local stand-in for Anthropic's Messages API:
// the document reader reports one check per page, numbered from the page's own width (each
// fictional page is 600 + its page number points wide), so the test knows which pages were sent.
type Req = { system: unknown; messages: { role: string; content: unknown }[] };
let readerCalls: number[][] = [];
let chatCalls: Req[] = [];
let failReads = 0;
const PNG = Uint8Array.from(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64"));
const reply = (body: unknown) => new Response(JSON.stringify({ id: "msg_f", type: "message", role: "assistant", model: "claude-test", stop_sequence: null, usage: { input_tokens: 500, output_tokens: 80 }, ...(body as object) }), { status: 200, headers: { "content-type": "application/json", "request-id": "req_f" } });

beforeEach(async () => {
  await resetDb();
  readerCalls = []; chatCalls = []; failReads = 0;
  process.env.ANTHROPIC_API_KEY = "sk-ant-test-fictional-key";
  process.env.COETHA_TEST_CHUNK = "512";
  vi.stubGlobal("fetch", vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const u = new URL(typeof url === "string" ? url : url instanceof URL ? url.href : url.url);
    if (u.host !== "api.anthropic.com") throw new Error(`Unexpected request: ${u.href}`);
    const req = JSON.parse(String(init?.body ?? "")) as Req;
    if (String(JSON.stringify(req.system)).includes("You read scanned pages")) {
      if (failReads > 0) { failReads--; return new Response(JSON.stringify({ type: "error", error: { type: "api_error", message: "overloaded" } }), { status: 529, headers: { "content-type": "application/json" } }); }
      const doc = (req.messages[0].content as { type: string; source?: { data: string } }[]).find((b) => b.type === "document");
      const pdf = await PDFDocument.load(Buffer.from(doc!.source!.data, "base64"));
      const pages = pdf.getPages().map((p) => Math.round(p.getWidth()) - 600);
      readerCalls.push(pages);
      const items = pages.map((n, i) => ({ page: i + 1, kind: "CHECK", checkNumber: String(1040 + n), date: "2026-10-05", payee: `Fictional Payee ${n}`, amount: n === 3 ? 580.85 : 100 + n, memo: n === 1 ? "pay back" : null, details: n === 2 ? "account 0000123456789, routing 062000019, deposited 10/23/26" : null }));
      return reply({ content: [{ type: "text", text: JSON.stringify({ items }) }], stop_reason: "end_turn" });
    }
    chatCalls.push(req);
    return reply({ content: [{ type: "text", text: "I read the checks and matched them to the bank rows." }], stop_reason: "end_turn" });
  }));
});
afterEach(() => { vi.unstubAllGlobals(); delete process.env.ANTHROPIC_API_KEY; delete process.env.COETHA_TEST_CHUNK; });

/** A fictional scanned PDF: pictures only (no text), one per page. */
async function scannedPdf(pages: number) {
  const d = await PDFDocument.create();
  const img = await d.embedPng(PNG);
  for (let i = 1; i <= pages; i++) d.addPage([600 + i, 800]).drawImage(img, { x: 20, y: 20, width: 500, height: 200 });
  return d.save();
}

async function setup() {
  const tabitha = await makeUser("ADMIN", "Tabitha");
  await prisma.ownerAccess.create({ data: { userId: tabitha.id, isPrimary: true } });
  const daria = await makeUser("STAFF", "Daria");
  const stranger = await makeUser("STAFF", "Stranger");
  const willow = await createClient(tabitha, { businessName: "Willow Example Bakery (fictional)", clientType: "BUSINESS", status: "ACTIVE", assignedToId: daria.id });
  const harbor = await createClient(tabitha, { businessName: "Harbor Example Co (fictional)", clientType: "BUSINESS", status: "ACTIVE" });
  await managed(willow.id, harbor.id);
  for (const c of [willow, harbor]) await setupLedger(tabitha, c.id, { basis: "CASH" });
  const gl = (await prisma.ledgerAccount.findFirstOrThrow({ where: { clientId: willow.id, code: "1000" } })).id;
  await importBankCsv(tabitha, willow.id, gl, { fileName: "oct.csv", text: "Date,Description,Amount\n10/23/2026,CHECK 1043,-580.85\n10/26/2026,CHECK 1041,-101.00\n10/09/2026,FLOUR MILL,-90.00" });
  await setOwnerSwitch(tabitha, "coetha", true);
  return { tabitha, daria, stranger, willow, harbor };
}

/** Uploads a file the way the page does: start, every piece, finish. */
async function upload(actor: Awaited<ReturnType<typeof setup>>["daria"], clientId: string, bytes: Uint8Array, name: string) {
  const { uploadId, chunks, chunkSize } = await startUpload(actor, clientId, { name, size: bytes.length });
  for (let i = 0; i < chunks; i++) await putChunk(actor, uploadId, i, bytes.slice(i * chunkSize, (i + 1) * chunkSize));
  return finishUpload(actor, uploadId);
}
const books = () => Promise.all([prisma.journalEntry.count(), prisma.coethaProposal.count(), prisma.bankTransaction.count({ where: { status: "UNREVIEWED" } })]);

describe("Coetha reads documents in the background", () => {
  it("a 10-page scan uploads in pieces, is read two pages per step, matched to the bank rows, and answered — nothing posted", async () => {
    const s = await setup();
    const before = await books();
    const pdf = await scannedPdf(10);
    const up = await upload(s.daria, s.willow.id, pdf, "checks-2026.pdf");
    expect(Math.ceil(pdf.length / 512)).toBeGreaterThan(2);
    // Saved once, staff-only, under this business only.
    const doc = await prisma.document.findUniqueOrThrow({ where: { id: up.documentId } });
    expect(doc).toMatchObject({ clientId: s.willow.id, category: "BOOKKEEPING", visibility: "STAFF_ONLY" });
    const q = await askAboutDocuments(s.daria, s.willow.id, "Here are all the checks for the year", [up.jobId]);
    expect(q.status).toBe("WAITING");

    const r = await workReading(60_000);
    expect(r.more).toBe(false);
    // Two pages per step, in order, each page read once.
    expect(readerCalls).toEqual([[1, 2], [3, 4], [5, 6], [7, 8], [9, 10]]);
    const job = await prisma.coethaDocJob.findUniqueOrThrow({ where: { id: up.jobId } });
    expect(job).toMatchObject({ status: "DONE", kind: "PDF_SCAN", pages: 10, pagesDone: 10 });
    const findings = await prisma.coethaDocFinding.findMany({ where: { jobId: up.jobId }, orderBy: { page: "asc" } });
    expect(findings).toHaveLength(10);
    expect(findings.map((f) => f.page)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    // Matched by check number and amount; de-identified (account and routing numbers to the last 4).
    expect(findings[2]).toMatchObject({ checkNumber: "1043", amountCents: 58085 });
    expect(findings[2].matchNote).toMatch(/check number and amount: 2026-10-23 CHECK 1043 \(waiting\)/);
    expect(findings[0].matchNote).toMatch(/check number and amount/);
    expect(findings[4].matchNote).toBe("no bank row with this amount");
    expect(findings[1].details).toContain("…6789");
    expect(findings[1].details).not.toContain("0000123456789");
    expect(findings[1].details).not.toContain("062000019");

    // The answer is placed right after the question, with what Coetha read.
    const v = await coethaChatView(s.daria, s.willow.id);
    expect(v.messages.map((m) => m.role)).toEqual(["USER", "COETHA"]);
    expect(v.messages[0].status).toBe("ANSWERED");
    expect(JSON.stringify(chatCalls[0].messages)).toContain("p3 CHECK #1043 2026-10-05 payee: Fictional Payee 3 $580.85");
    expect(JSON.stringify(chatCalls[0].messages)).not.toContain("0000123456789");
    expect(await books()).toEqual(before);
  });

  it("an interrupted worker's pages are read again from the saved place, never twice", async () => {
    const s = await setup();
    const up = await upload(s.daria, s.willow.id, await scannedPdf(6), "scan.pdf");
    await workOnce(); // works out the kind (scanned, 6 pages)
    await workOnce(); // pages 1-2
    // A worker takes the next step and is cut off: its lease is still held.
    const now = Date.now();
    await prisma.coethaDocJob.update({ where: { id: up.jobId }, data: { leaseUntil: new Date(now + 3 * 60_000), attempts: { increment: 1 } } });
    expect((await workOnce()).did).toBeNull(); // nobody else reads it while held
    // After the lease runs out, the next worker continues from page 3.
    await workReading(60_000, { now: () => new Date(now + 4 * 60_000) });
    expect(readerCalls.flat()).toEqual([1, 2, 3, 4, 5, 6]);
    // A step re-run over pages already saved replaces them (no duplicates).
    await prisma.coethaDocJob.update({ where: { id: up.jobId }, data: { status: "READING", pagesDone: 2 } });
    await workReading(60_000);
    expect(await prisma.coethaDocFinding.count({ where: { jobId: up.jobId } })).toBe(6);
    expect((await prisma.coethaDocJob.findUniqueOrThrow({ where: { id: up.jobId } })).status).toBe("DONE");
  });

  it("failed steps are retried after a delay; after repeated failures the file shows Try again, which continues", async () => {
    const s = await setup();
    const up = await upload(s.daria, s.willow.id, await scannedPdf(2), "scan.pdf");
    const q = await askAboutDocuments(s.daria, s.willow.id, "", [up.jobId]);
    await workOnce();
    failReads = 1;
    await workOnce();
    let job = await prisma.coethaDocJob.findUniqueOrThrow({ where: { id: up.jobId } });
    expect(job.status).toBe("READING");
    expect(job.notBefore!.getTime()).toBeGreaterThan(Date.now());
    expect((await workOnce()).did).toBeNull(); // waiting for its retry time
    // It keeps failing: after MAX_ATTEMPTS it stops.
    failReads = 99;
    for (let i = 0; i < MAX_ATTEMPTS + 1; i++) await workOnce({ now: new Date(Date.now() + (i + 1) * 60 * 60_000) });
    job = await prisma.coethaDocJob.findUniqueOrThrow({ where: { id: up.jobId } });
    expect(job.status).toBe("FAILED");
    expect(job.error).toBeTruthy();
    // The question can't be answered without the file yet; it gives up visibly.
    await workReading(5_000);
    expect((await prisma.coethaChatMessage.findUniqueOrThrow({ where: { id: q.id } })).status).toBe("ANSWERED");
    // "Try again": continues and is read.
    failReads = 0;
    await retryJob(s.daria, up.jobId);
    await workReading(60_000);
    expect((await prisma.coethaDocJob.findUniqueOrThrow({ where: { id: up.jobId } })).status).toBe("DONE");
    expect(await prisma.coethaDocFinding.count({ where: { jobId: up.jobId } })).toBe(2);
  });

  it("a step that keeps being cut off stops with a clear message instead of looping", async () => {
    const s = await setup();
    const up = await upload(s.daria, s.willow.id, await scannedPdf(2), "scan.pdf");
    await workOnce();
    await prisma.coethaDocJob.update({ where: { id: up.jobId }, data: { attempts: MAX_ATTEMPTS, leaseUntil: new Date(Date.now() - 1000) } });
    await workOnce();
    const job = await prisma.coethaDocJob.findUniqueOrThrow({ where: { id: up.jobId } });
    expect(job.status).toBe("FAILED");
    expect(job.error).toMatch(/kept being interrupted/);
  });

  it("the same file sent again reuses the saved copy and its reading (no duplicate document or job)", async () => {
    const s = await setup();
    const pdf = await scannedPdf(2);
    const a = await upload(s.daria, s.willow.id, pdf, "scan.pdf");
    await workReading(60_000);
    const calls = readerCalls.length;
    const b = await upload(s.tabitha, s.willow.id, pdf, "scan-again.pdf");
    expect(b).toMatchObject({ documentId: a.documentId, jobId: a.jobId, reused: true });
    expect(await prisma.document.count({ where: { clientId: s.willow.id, title: { startsWith: "Sent to Coetha" } } })).toBe(1);
    await workReading(60_000);
    expect(readerCalls.length).toBe(calls);
  });

  it("a PDF with text is kept as its de-identified text without a reading call", async () => {
    const s = await setup();
    const d = await PDFDocument.create();
    const font = await d.embedFont(StandardFonts.Helvetica);
    const page = d.addPage([612, 792]);
    for (let i = 0; i < 12; i++) page.drawText(`10/${String(i + 1).padStart(2, "0")}/2026 Fictional statement line ${i + 1} account 0000123456789 -${(i + 10).toFixed(2)}`, { x: 30, y: 740 - i * 16, size: 9, font });
    const up = await upload(s.daria, s.willow.id, await d.save(), "statement.pdf");
    await workReading(60_000);
    const job = await prisma.coethaDocJob.findUniqueOrThrow({ where: { id: up.jobId } });
    expect(job).toMatchObject({ status: "DONE", kind: "PDF_TEXT" });
    expect(job.text).toContain("Fictional statement line 1");
    expect(job.text).not.toContain("0000123456789");
    expect(readerCalls).toHaveLength(0);
  });

  it("only staff who can open the business's books can upload, read or ask; files never cross businesses", async () => {
    const s = await setup();
    const pdf = await scannedPdf(1);
    await expect(startUpload(s.stranger, s.willow.id, { name: "x.pdf", size: pdf.length })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(startUpload(s.daria, s.harbor.id, { name: "x.pdf", size: pdf.length })).rejects.toBeInstanceOf(ForbiddenError);
    const { uploadId } = await startUpload(s.daria, s.willow.id, { name: "x.pdf", size: pdf.length });
    // Someone else can't add to or finish another person's upload.
    await expect(putChunk(s.tabitha, uploadId, 0, pdf.slice(0, 512))).rejects.toThrow(/wasn't found/);
    await expect(readingView(s.stranger, s.willow.id)).rejects.toBeInstanceOf(ForbiddenError);
    const up = await upload(s.daria, s.willow.id, pdf, "x.pdf");
    // A Willow file can't be attached to a Harbor question.
    await expect(askAboutDocuments(s.tabitha, s.harbor.id, "Hi", [up.jobId])).rejects.toThrow(/isn't on file for this business/);
    // Not a PDF or picture: refused when put together, nothing saved.
    const txt = new TextEncoder().encode("hello, not a pdf");
    await expect(upload(s.daria, s.willow.id, txt, "notes.pdf")).rejects.toThrow(/isn't a PDF or a picture/);
    expect(await prisma.document.count({ where: { clientId: s.willow.id } })).toBe(1);
  });
});
