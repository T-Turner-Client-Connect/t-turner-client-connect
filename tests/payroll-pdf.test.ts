import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { makeUser, managed, prisma, resetDb } from "./db";
import { createClient } from "@/lib/services/clients";
import { saveProfile } from "@/lib/services/bookkeeping-clients";
import { setupLedger } from "@/lib/services/ledger";
import { setOwnerSwitch } from "@/lib/services/owner-switches";
import { setCoethaOptOut } from "@/lib/services/coetha-opt-out";
import { importPayrollRegister, previewPayrollImport } from "@/lib/services/payroll";
import { gridFromReading, payrollText } from "@/lib/payroll/pdf-register";
import { PAYROLL_PROVIDER_LOGIN } from "@/lib/payroll/fields";

// A fictional ADP RUN payroll register PDF. Fictional business, people and figures only. The AI
// service is a local stand-in: any request to another host fails the test.
const REGISTER = [
  "Pretend Lakeside Bakery LLC — Payroll Register",
  "Check Date 10/24/2026   Period 10/11/2026 - 10/24/2026",
  "Avery Example  SSN 123-45-6789  Hours 80.00  Gross 2,000.00  Fed 180.00  SS 124.00  Med 29.00  State 80.00  Ded 50.00  Net 1,537.00",
  "Blake Example  SSN 987-65-4321  Hours 40.00  Gross 800.00  Fed 40.00  SS 49.60  Med 11.60  State 28.00  Ded 0.00  Net 670.80",
  "Totals  Gross 2,800.00  Net 2,207.80  Employer taxes 290.40",
];
const READING = {
  payDates: [{
    checkDate: "2026-10-24", periodStart: "2026-10-11", periodEnd: "2026-10-24",
    employees: [
      { name: "Avery Example", hours: 80, gross: 2000, federalWh: 180, socialSecurity: 124, medicare: 29, stateWh: 80, otherEmployeeTaxes: 0, deductions: 50, netPay: 1537 },
      { name: "Blake Example", hours: 40, gross: 800, federalWh: 40, socialSecurity: 49.6, medicare: 11.6, stateWh: 28, otherEmployeeTaxes: 0, deductions: 0, netPay: 670.8 },
    ],
    employerTaxes: 290.4,
    printedTotals: { gross: 2800, netPay: 2207.8 },
  }],
};

let sent: string[] = [];
let reading: unknown = READING;
beforeEach(async () => {
  await resetDb();
  sent = [];
  reading = READING;
  process.env.ANTHROPIC_API_KEY = "sk-ant-test-fictional-key";
  vi.stubEnv("MALWARE_SCAN_URL", "https://scanner.test/scan");
  vi.stubGlobal("fetch", vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const u = new URL(typeof url === "string" ? url : url instanceof URL ? url.href : url.url);
    if (u.host === "scanner.test") return new Response(JSON.stringify({ clean: true }), { status: 200 });
    if (u.host !== "api.anthropic.com") throw new Error(`Unexpected request: ${u.href}`);
    const req = JSON.parse(String(init?.body ?? ""));
    sent.push(JSON.stringify(req.messages));
    return new Response(JSON.stringify({ id: "msg_fictional", type: "message", role: "assistant", model: req.model, content: [{ type: "text", text: JSON.stringify(reading) }], stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 10, output_tokens: 10 } }), { status: 200, headers: { "content-type": "application/json", "request-id": "req_fictional" } });
  }));
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  delete process.env.ANTHROPIC_API_KEY;
});

async function pdf(lines: string[]) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([792, 612]);
  lines.forEach((l, i) => page.drawText(l, { x: 20, y: 580 - i * 16, size: 8, font }));
  return doc.save();
}

async function setup() {
  const tabitha = await makeUser("ADMIN", "Tabitha");
  await prisma.ownerAccess.create({ data: { userId: tabitha.id, isPrimary: true, scope: "FULL" } });
  const biz = await createClient(tabitha, { businessName: "Pretend Lakeside Bakery LLC", clientType: "BUSINESS", status: "ACTIVE" });
  await managed(biz.id);
  await saveProfile(tabitha, biz.id, { active: true, frequency: "MONTHLY", payroll: true, payrollFrequency: "BIWEEKLY", payrollProvider: "ADP" });
  await setupLedger(tabitha, biz.id, { basis: "CASH" });
  await setOwnerSwitch(tabitha, "coetha", true);
  return { tabitha, biz };
}

describe("ADP payroll register as a PDF", () => {
  it("is read once, checked against its own totals, previewed and imported as a draft pay run; the same PDF never imports twice", async () => {
    const s = await setup();
    const bytes = await pdf(REGISTER);
    const preview = await previewPayrollImport(s.tabitha, s.biz.id, { bytes, fileName: "adp-register.pdf", preset: "ADP_RUN" });
    expect(preview.error).toBeNull();
    expect(preview.payDates).toHaveLength(1);
    expect(preview.payDates[0]).toMatchObject({ checkDate: "2026-10-24", grossCents: 280000, netPayCents: 220780, employerTaxCents: 29040, differenceCents: 0, employees: 2 });
    // Nothing identifying went out: SSNs were removed before the text was sent.
    expect(sent.join(" ")).not.toContain("123-45-6789");
    expect(sent.join(" ")).toContain("[ssn]");

    // Import: the same figures (read once — no second request), one draft pay run, staff-only file.
    const imp = await importPayrollRegister(s.tabitha, s.biz.id, { bytes, fileName: "register.pdf", preset: "ADP_RUN" });
    expect(sent).toHaveLength(1);
    expect(imp.created).toHaveLength(1);
    const run = await prisma.payrollRun.findFirstOrThrow({ where: { clientId: s.biz.id } });
    expect(run.status).toBe("DRAFT");
    // Nothing is posted to the books until staff post it (and Tabitha approves where required).
    expect(await prisma.journalEntry.count({ where: { clientId: s.biz.id } })).toBe(0);
    const doc = await prisma.document.findUniqueOrThrow({ where: { id: imp.documentId } });
    expect(doc).toMatchObject({ visibility: "STAFF_ONLY", docType: "PAYROLL_REPORT" });

    // The same PDF again: nothing new.
    const again = await importPayrollRegister(s.tabitha, s.biz.id, { bytes, fileName: "register (1).pdf", preset: "ADP_RUN" });
    expect(again.created).toHaveLength(0);
    expect(await prisma.payrollRun.count({ where: { clientId: s.biz.id } })).toBe(1);
  });

  it("refuses a reading that doesn't match the register's own totals, and needs Coetha allowed for the client", async () => {
    const s = await setup();
    reading = { payDates: [{ ...READING.payDates[0], printedTotals: { gross: 2900, netPay: 2207.8 } }] };
    await expect(previewPayrollImport(s.tabitha, s.biz.id, { bytes: await pdf(REGISTER), fileName: "r.pdf", preset: "ADP_RUN" })).rejects.toThrow(/register's total is \$2900.00/);
    await setCoethaOptOut(s.tabitha, s.biz.id, { toldOn: "2026-11-01", via: "PHONE", note: "Prefers no AI (fictional)" });
    await expect(previewPayrollImport(s.tabitha, s.biz.id, { bytes: await pdf([...REGISTER, "page 2"]), fileName: "r2.pdf", preset: "ADP_RUN" })).rejects.toThrow(/prefers no Coetha/);
    expect(await prisma.payrollRun.count()).toBe(0);
  });

  it("helpers: SSNs and long numbers are removed; employer taxes land once per pay date; provider sign-in links", () => {
    expect(payrollText(["Avery 123-45-6789 acct 000123456789 EIN 12-3456789"])[0]).toBe("Avery [ssn] acct [number] EIN [ein]");
    const grid = gridFromReading(READING);
    expect(grid).toHaveLength(3);
    expect(grid.slice(1).map((r) => r[11])).toEqual(["290.40", "0.00"]);
    expect(PAYROLL_PROVIDER_LOGIN.ADP_RUN?.url).toBe("https://runpayroll.adp.com/");
  });
});
