import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PDFDocument } from "pdf-lib";
import { makeUser, managed, prisma, resetDb } from "./db";
import { createClient } from "@/lib/services/clients";
import { saveProfile } from "@/lib/services/bookkeeping-clients";
import { setupLedger } from "@/lib/services/ledger";
import { staffUploadDocument } from "@/lib/services/documents";
import { createClientRequest } from "@/lib/services/client-requests";
import { setOwnerSwitch } from "@/lib/services/owner-switches";
import { monthlyChecklist } from "@/lib/services/monthly-workflow";
import { runChecklistTool } from "@/lib/services/coetha-checklist";
import { answerQuestion } from "@/lib/services/coetha-chat";

// Fictional business and figures only. The AI service is a local stand-in.
const pdf = async (label: string) => {
  const d = await PDFDocument.create();
  d.addPage([300, 300]).drawText(label, { x: 20, y: 150 });
  return d.save();
};

let sentTools: string[][] = [];
beforeEach(async () => {
  await resetDb();
  sentTools = [];
  process.env.ANTHROPIC_API_KEY = "sk-ant-test-fictional-key";
  vi.stubEnv("MALWARE_SCAN_URL", "https://scanner.test/scan");
  vi.stubGlobal("fetch", vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const u = new URL(typeof url === "string" ? url : url instanceof URL ? url.href : url.url);
    if (u.host === "scanner.test") return new Response(JSON.stringify({ clean: true }), { status: 200 });
    if (u.host !== "api.anthropic.com") throw new Error(`Unexpected request: ${u.href}`);
    const req = JSON.parse(String(init?.body ?? ""));
    sentTools.push((req.tools ?? []).map((t: { name: string }) => t.name));
    return new Response(JSON.stringify({ id: "msg_fictional", type: "message", role: "assistant", model: req.model, content: [{ type: "text", text: "Read. Nothing else needs you." }], stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 10, output_tokens: 10 } }), { status: 200, headers: { "content-type": "application/json", "request-id": "req_fictional" } });
  }));
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  delete process.env.ANTHROPIC_API_KEY;
});

async function setup() {
  const tabitha = await makeUser("ADMIN", "Tabitha");
  await prisma.ownerAccess.create({ data: { userId: tabitha.id, isPrimary: true, scope: "FULL" } });
  const biz = await createClient(tabitha, { businessName: "Pretend Harbor Cafe LLC", clientType: "BUSINESS", status: "ACTIVE" });
  await managed(biz.id);
  await saveProfile(tabitha, biz.id, { active: true, frequency: "MONTHLY", payroll: true, payrollFrequency: "BIWEEKLY", payrollProvider: "ADP" });
  await setupLedger(tabitha, biz.id, { basis: "CASH" });
  await setOwnerSwitch(tabitha, "coetha", true);
  return { tabitha, biz };
}

const line = async (clientId: string, key: string) => (await monthlyChecklist(clientId, 2026, 10, { today: "2026-11-11" })).items.find((i) => i.key === key)!;

describe("Coetha and the Monthly Progress checklist", () => {
  it("reads the month's checklist with its open requests and unfiled uploads, and clears the paperwork lines", async () => {
    const s = await setup();
    const req = (title: string) => createClientRequest(s.tabitha, s.biz.id, { kind: "SUPPORTING", docType: "RECEIPTS", title, reason: "To categorize it (fictional).", start: "2026-10-01", end: "2026-10-31" });
    const a = (await req("Receipt for the $412.00 supply purchase on Oct 4")).request!;
    const b = (await req("Receipt for the $95.00 purchase on Oct 9")).request!;
    const receipt = await staffUploadDocument(s.tabitha, { clientId: s.biz.id, category: "BOOKKEEPING", title: "Sent to Coetha — receipt-oct4.pdf", visibility: "STAFF_ONLY", bytes: await pdf("Receipt $412.00"), originalName: "receipt-oct4.pdf", notify: false });
    const register = await staffUploadDocument(s.tabitha, { clientId: s.biz.id, category: "BOOKKEEPING", title: "Sent to Coetha — payroll-register.pdf", visibility: "STAFF_ONLY", bytes: await pdf("Payroll register"), originalName: "payroll-register.pdf", notify: false });
    expect((await line(s.biz.id, "RECEIPTS")).pill).toBe("2 outstanding");
    expect((await line(s.biz.id, "PAYROLL")).state).toBe("MISSING");

    const view = (await runChecklistTool(s.tabitha, s.biz.id, "monthly_checklist", { month: "2026-10" })) as { lines: { key: string; howItClears: string }[]; outstandingRequests: { requestId: string }[]; unfiledUploads: { documentId: string }[] };
    expect(view.outstandingRequests.map((r) => r.requestId).sort()).toEqual([a.id, b.id].sort());
    expect(view.unfiledUploads.map((d) => d.documentId).sort()).toEqual([receipt.id, register.id].sort());
    expect(view.lines.find((l) => l.key === "APPROVAL")?.howItClears).toMatch(/Only Tabitha/);

    const res = (await runChecklistTool(s.tabitha, s.biz.id, "update_checklist", { updates: [
      { action: "request_received", requestId: a.id, documentId: receipt.id },
      { action: "request_not_needed", requestId: b.id },
      { action: "request_not_needed", requestId: b.id, note: "Client confirmed it was a personal purchase, already reimbursed (fictional)." },
      { action: "payroll_received", documentId: register.id, month: "2026-10" },
    ] })) as { results: { result: string }[] };
    expect(res.results.map((r) => r.result)).toEqual([
      "Marked received: Receipt for the $412.00 supply purchase on Oct 4",
      "Say in the note why the request isn't needed.",
      "Closed as not needed: Receipt for the $95.00 purchase on Oct 9",
      "Filed as the 2026-10 payroll report and shared on the client's Payroll page: Sent to Coetha — payroll-register.pdf",
    ]);
    expect((await line(s.biz.id, "RECEIPTS")).state).toBe("DONE");
    expect((await line(s.biz.id, "PAYROLL")).state).toBe("DONE");
    expect(await prisma.document.findUniqueOrThrow({ where: { id: register.id } })).toMatchObject({ docType: "PAYROLL_REPORT", visibility: "PUBLISHED", year: 2026, month: 10 });
    expect(await prisma.document.findUniqueOrThrow({ where: { id: receipt.id } })).toMatchObject({ requestId: a.id });
    expect(await prisma.auditLog.count({ where: { action: { startsWith: "coetha.checklist_" } } })).toBe(3);

    // Already answered: nothing changes twice.
    const again = (await runChecklistTool(s.tabitha, s.biz.id, "update_checklist", { updates: [{ action: "request_received", requestId: a.id, documentId: receipt.id }] })) as { results: { result: string }[] };
    expect(again.results[0].result).toMatch(/No outstanding request/);
  });

  it("only people who handle the business's requests can clear lines, and nothing reaches another business", async () => {
    const s = await setup();
    const other = await createClient(s.tabitha, { businessName: "Pretend Other Shop LLC", clientType: "BUSINESS", status: "ACTIVE" });
    await managed(other.id);
    const r = (await createClientRequest(s.tabitha, other.id, { kind: "SUPPORTING", docType: "RECEIPTS", title: "Other shop receipt", start: "2026-10-01", end: "2026-10-31" })).request!;
    // A request of another business can't be closed from this business's chat.
    const cross = (await runChecklistTool(s.tabitha, s.biz.id, "update_checklist", { updates: [{ action: "request_not_needed", requestId: r.id, note: "fictional" }] })) as { results: { result: string }[] };
    expect(cross.results[0].result).toMatch(/No outstanding request/);
    expect((await prisma.documentRequest.findUniqueOrThrow({ where: { id: r.id } })).status).toBe("OPEN");
    // A staff member who isn't assigned can read the checklist but not clear anything.
    const staff = await makeUser("STAFF", "Drew Example");
    expect(await runChecklistTool(staff, s.biz.id, "monthly_checklist", { month: "2026-10" })).toHaveProperty("lines");
    expect(await runChecklistTool(staff, s.biz.id, "update_checklist", { updates: [{ action: "payroll_received", documentId: "x", month: "2026-10" }] })).toHaveProperty("error");
    expect(await runChecklistTool(s.tabitha, s.biz.id, "monthly_checklist", { month: "October" })).toEqual({ error: "Give the month as YYYY-MM." });
  });

  it("a question answered in the background (files attached) still has Coetha's tools: preparing entries, memory and the checklist", async () => {
    const s = await setup();
    const q = await prisma.coethaChatMessage.create({ data: { clientId: s.biz.id, role: "USER", text: "Book Cari's payroll to 3100 (fictional).", authorId: s.tabitha.id, status: "WAITING", jobIds: [] } });
    await answerQuestion(s.tabitha, s.biz.id, q.id, "Fictional register: gross $1,000.00.");
    expect(sentTools[0]).toEqual(expect.arrayContaining(["prepare_entries", "monthly_checklist", "update_checklist", "search_bank_transactions"]));
  });
});
