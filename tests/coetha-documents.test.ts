import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { makeUser, managed, prisma, resetDb } from "./db";
import { createClient } from "@/lib/services/clients";
import { setupLedger } from "@/lib/services/ledger";
import { setOwnerSwitch } from "@/lib/services/owner-switches";
import { staffUploadDocument } from "@/lib/services/documents";
import { findFilesOnFile, runReadFilesTool as readTool } from "@/lib/services/coetha-reading";

/** The tool's result when it read (not a refusal). */
const runReadFilesTool = async (...a: Parameters<typeof readTool>) => {
  const r = await readTool(...a);
  return r as Extract<typeof r, { documents: unknown }> & { problem?: string };
};

// Fictional businesses, statements, payroll and identifiers only. Documents are stored the normal
// way (as if uploaded months or years ago); Coetha finds and reads them without any new upload.
async function textPdf(lines: string[]) {
  const d = await PDFDocument.create();
  const f = await d.embedFont(StandardFonts.Helvetica);
  const p = d.addPage([612, 792]);
  let y = 760;
  for (const l of lines) {
    p.drawText(l, { x: 40, y, size: 9, font: f });
    y -= 12;
  }
  return d.save();
}
const PNG = Uint8Array.from(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64"));
async function scanPdf() {
  const d = await PDFDocument.create();
  const img = await d.embedPng(PNG);
  d.addPage([600, 800]).drawImage(img, { x: 20, y: 20, width: 500, height: 200 });
  return d.save();
}
const DEC_2025 = [
  "Fictional Community Bank — Business Checking Statement",
  "Statement period 12/01/2025 through 12/31/2025   Account number 000111222333444",
  "Beginning balance 48,210.55",
  ...Array.from({ length: 12 }, (_, i) => `12/${String(i + 2).padStart(2, "0")}/2025  CARD PURCHASE FICTIONAL SUPPLY CO   -${(120 + i).toFixed(2)}`),
  "12/30/2025  ADP PAYROLL FEES ADP - FEES   -186.40",
  "12/31/2025  ADP WAGE PAY WAGE PAY   -3,109.77",
  "Ending balance 41,903.12",
];

let calls = 0;
beforeEach(async () => {
  await resetDb();
  calls = 0;
  vi.stubEnv("MALWARE_SCAN_URL", "https://scanner.test/scan");
  vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-test-fictional");
  vi.stubGlobal("fetch", vi.fn(async () => {
    calls++;
    return new Response(JSON.stringify({ clean: true }), { status: 200 });
  }));
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

async function setup() {
  const tabitha = await makeUser("ADMIN", "Tabitha");
  await prisma.ownerAccess.create({ data: { userId: tabitha.id, isPrimary: true } });
  const daria = await makeUser("STAFF", "Daria");
  const stranger = await makeUser("STAFF", "Stranger");
  const willow = await createClient(tabitha, { businessName: "Willow Example Bakery (fictional)", clientType: "BUSINESS", status: "ACTIVE", assignedToId: daria.id });
  const harbor = await createClient(tabitha, { businessName: "Harbor Example Co (fictional)", clientType: "BUSINESS", status: "ACTIVE" });
  await managed(willow.id, harbor.id);
  for (const c of [willow, harbor]) await setupLedger(tabitha, c.id, { basis: "CASH" });
  await setOwnerSwitch(tabitha, "coetha", true);
  const put = async (clientId: string, title: string, bytes: Uint8Array, data: { category: "BOOKKEEPING" | "PAYROLL" | "CLIENT_UPLOADS" | "OTHER" | "TAXES"; year?: number; month?: number; docType?: string; name?: string }) => {
    const d = await staffUploadDocument(tabitha, { clientId, title, visibility: "STAFF_ONLY", bytes, originalName: data.name ?? `${title}.pdf`, category: data.category, year: data.year ?? null, month: data.month ?? null, docType: data.docType ?? null, notify: false });
    return prisma.document.update({ where: { id: d.id }, data: { scanStatus: "CLEAN" } });
  };
  const dec = await put(willow.id, "CHECKINGSTATEMENT_12-31-2025 … Fictional Owner December 2025.pdf", await textPdf(DEC_2025), { category: "BOOKKEEPING", year: 2025, month: 12, docType: "BANK_STATEMENT", name: "CHECKINGSTATEMENT_12-31-2025.pdf" });
  const jan24 = await put(willow.id, "Checking statement January 2024", await textPdf(["Fictional Community Bank — Business Checking Statement", "Statement period 01/01/2024 through 01/31/2024", ...Array.from({ length: 14 }, (_, i) => `01/${String(i + 3).padStart(2, "0")}/2024  DEPOSIT FICTIONAL CUSTOMER   ${(500 + i).toFixed(2)}`)]), { category: "BOOKKEEPING", year: 2024, month: 1, docType: "BANK_STATEMENT" });
  const card = await put(willow.id, "Visa card statement November 2025", await textPdf(["Fictional Card Services — Visa Business Statement", "Closing date 11/30/2025  Account ending 4321", ...Array.from({ length: 14 }, (_, i) => `11/${String(i + 2).padStart(2, "0")}/2025  FICTIONAL FUEL STOP   ${(40 + i).toFixed(2)}`)]), { category: "BOOKKEEPING", year: 2025, month: 11 });
  const payroll = await put(willow.id, "ADP Payroll Register January 2026", await textPdf(["ADP Payroll Register — Fictional Bakery", "Pay date 01/09/2026  Net pay 3,109.77  Employer taxes 245.10", ...Array.from({ length: 12 }, (_, i) => `Employee ${i + 1}  Gross ${(800 + i).toFixed(2)}  Net ${(600 + i).toFixed(2)}`)]), { category: "PAYROLL", year: 2026, month: 1 });
  const scan = await put(willow.id, "Scanned receipts December 2025", await scanPdf(), { category: "CLIENT_UPLOADS", year: 2025, month: 12 });
  const ret = await put(willow.id, "2024 business return", await textPdf(["Form 1120-S 2024", ...Array.from({ length: 12 }, () => "U.S. Income Tax Return for an S Corporation line text")]), { category: "OTHER", year: 2024 });
  await prisma.document.update({ where: { id: ret.id }, data: { category: "TAXES" } });
  const other = await put(harbor.id, "Harbor checking statement December 2025", await textPdf(["Harbor bank statement", ...Array.from({ length: 14 }, (_, i) => `12/${String(i + 1).padStart(2, "0")}/2025  SECRET HARBOR ROW ${i}  -10.00`)]), { category: "BOOKKEEPING", year: 2025, month: 12 });
  calls = 0; // the uploads' virus-scan calls above don't count
  return { tabitha, daria, stranger, willow, harbor, dec, jan24, card, payroll, scan, ret, other };
}

describe("Coetha finds and reads accounting documents already stored in Client Connect", () => {
  it("finds the December 2025 checking statement by name, kind and period — and prior-year statements, card statements and payroll reports", async () => {
    const s = await setup();
    const byName = await findFilesOnFile(s.daria, s.willow.id, { text: "CHECKINGSTATEMENT" });
    expect(byName.documents.map((d) => d.id)).toEqual([s.dec.id]);
    expect(byName.documents[0]).toMatchObject({ period: "2025-12", read: "not read yet" });
    expect((await findFilesOnFile(s.daria, s.willow.id, { kind: "bank", year: 2024 })).documents.map((d) => d.id)).toEqual([s.jan24.id]);
    expect((await findFilesOnFile(s.daria, s.willow.id, { kind: "card" })).documents.map((d) => d.id)).toContain(s.card.id);
    expect((await findFilesOnFile(s.daria, s.willow.id, { kind: "payroll", year: 2026, month: 1 })).documents.map((d) => d.id)).toEqual([s.payroll.id]);
    // Tax returns and other businesses' files are never listed.
    const all = (await findFilesOnFile(s.daria, s.willow.id, {})).documents.map((d) => d.id);
    expect(all).not.toContain(s.ret.id);
    expect(all).not.toContain(s.other.id);
  });

  it("reads a stored text statement at once (account numbers cut to the last 4), keeps it so it's read once, and logs each read", async () => {
    const s = await setup();
    const r = await runReadFilesTool(s.daria, s.willow.id, { documentIds: [s.dec.id] });
    const doc = r.documents[0];
    expect(doc).toMatchObject({ id: s.dec.id, status: "read" });
    expect(doc.text).toContain("ADP WAGE PAY WAGE PAY");
    expect(doc.text).toContain("-3,109.77");
    expect(doc.text).toContain("-186.40");
    expect(doc.text).not.toContain("000111222333444");
    expect(calls).toBe(0); // no AI (or any outside) call was needed to read a text PDF
    expect(await prisma.coethaDocJob.findUniqueOrThrow({ where: { documentId: s.dec.id } })).toMatchObject({ kind: "PDF_TEXT", status: "DONE" });
    // Read again (another question): the kept text, same result.
    const again = await runReadFilesTool(s.daria, s.willow.id, { documentIds: [s.dec.id, s.payroll.id, s.jan24.id] });
    expect(again.documents.map((d) => d.status)).toEqual(["read", "read", "read"]);
    expect(again.documents[1].text).toContain("Net pay 3,109.77");
    expect(await prisma.coethaDocJob.count()).toBe(3);
    expect(await prisma.auditLog.count({ where: { action: "coetha.document_read" } })).toBe(4);
  });

  it("a scan is read in the background and answered in the same chat; a file that can't be read says why", async () => {
    const s = await setup();
    const r = await runReadFilesTool(s.daria, s.willow.id, { documentIds: [s.scan.id, s.ret.id, "missing-id"], question: "What do these receipts show?" }, { chat: "c_fictional" });
    expect(r.documents.map((d) => d.status)).toEqual(["reading in the background (a scan or picture)", "not allowed", "not found"]);
    expect(r.note).toMatch(/background/);
    const waiting = await prisma.coethaChatMessage.findFirstOrThrow({ where: { clientId: s.willow.id, status: "WAITING" } });
    expect(waiting).toMatchObject({ chatId: "c_fictional", text: "What do these receipts show?" });
  });

  it("client isolation and staff permissions hold: no other business's file, no reading for staff without this business's books", async () => {
    const s = await setup();
    const r = await runReadFilesTool(s.daria, s.willow.id, { documentIds: [s.other.id] });
    expect(r.documents[0]).toMatchObject({ status: "not found" });
    await expect(findFilesOnFile(s.stranger, s.willow.id, {})).rejects.toThrow();
    const denied = await runReadFilesTool(s.stranger, s.willow.id, { documentIds: [s.dec.id] });
    expect(denied).toMatchObject({ problem: expect.any(String) });
    expect(await prisma.coethaDocJob.count()).toBe(0);
  });
});
