import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { makeUser, managed, prisma, resetDb } from "./db";
import { createClient } from "@/lib/services/clients";
import { setupLedger } from "@/lib/services/ledger";
import { acceptPortalInvite, invitePortalUser } from "@/lib/services/portal-accounts";
import { importPayrollRegister, payrollReports, previewPayrollImport, sharePayrollReport } from "@/lib/services/payroll";
import { authorizeDownload, downloadToken, staffUploadDocument } from "@/lib/services/documents";
import { portalPayrollPage } from "@/lib/services/portal-business-pages";
import { readAdpSummary } from "@/lib/payroll/adp-summary";

/**
 * Payroll end to end, both sides: the office uploads an ADP payroll summary PDF → it's read (no AI),
 * saved to the right business as pay runs and a payroll file → staff share it → the client's Payroll
 * page shows the pay history and the file, and the client can open it → another client can't.
 * Fictional businesses, people and amounts only (same layout as an ADP RUN summary).
 */
const SUMMARY = [
  "1 of 1Month, Quarter, Year-to-Date Summary",
  "Hours and Earnings Taxes Deductions Employer",
  "Description Hours Amount Tax Amount Deduction Amount Net Pay Liability Amount",
  "Pay Frequency: Biweekly",
  "Check Date: 10/09/2026 - Regular Payroll",
  "Regular 80.00 2,000.00", "Commission 0.00 100.00", "80.00 2,100.00",
  "FED FIT 150.00", "FED SOCSEC 130.20", "FED", "MEDCARE", "30.45", "AL SIT 90.00", "400.65",
  "1,699.35 FED SOCSEC-ER 130.20", "FED MEDCARE-ER 30.45", "FED FUTA 6.00", "AL SUI-ER 20.00", "186.65",
  "Check Date: 10/23/2026 - Regular Payroll",
  "Regular 80.00 2,000.00", "80.00 2,000.00",
  "FED FIT 140.00", "FED SOCSEC 124.00", "FED", "MEDCARE", "29.00", "AL SIT 85.00", "378.00",
  "1,622.00 FED SOCSEC-ER 124.00", "FED MEDCARE-ER 29.00", "153.00",
  "Pay Frequency Month To Date (October): Biweekly",
  "Regular 160.00 $4,000.00", "Commission 0.00 $100.00", "160.00 $4,100.00",
  "Company: FICTIONAL BAKERY LLC Date Printed: 11/12/2026 14:46",
];
async function pdf(lines: string[]) {
  const d = await PDFDocument.create();
  const f = await d.embedFont(StandardFonts.Helvetica);
  const p = d.addPage([612, 792]);
  let y = 770;
  for (const l of lines) {
    p.drawText(l, { x: 30, y, size: 8, font: f });
    y -= 11;
  }
  return d.save();
}

beforeEach(async () => {
  await resetDb();
  vi.stubEnv("MALWARE_SCAN_URL", "https://scanner.test/scan");
  // No AI here: an outside call other than the virus scanner fails the test.
  vi.stubGlobal("fetch", vi.fn(async (url: string | URL | Request) => {
    const u = String(typeof url === "string" ? url : url instanceof URL ? url.href : url.url);
    if (!u.startsWith("https://scanner.test")) throw new Error(`Unexpected request: ${u}`);
    return new Response(JSON.stringify({ clean: true }), { status: 200 });
  }));
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

async function world() {
  const tabitha = await makeUser("ADMIN", "Tabitha");
  await prisma.ownerAccess.create({ data: { userId: tabitha.id, isPrimary: true } });
  const outsider = await makeUser("STAFF", "Unassigned Staff");
  const bakery = await createClient(tabitha, { businessName: "Fictional Bakery LLC", clientType: "BUSINESS", status: "ACTIVE", assignedToId: tabitha.id });
  const hauling = await createClient(tabitha, { businessName: "Other Fictional Hauling LLC", clientType: "BUSINESS", status: "ACTIVE", assignedToId: tabitha.id });
  await managed(bakery.id, hauling.id);
  for (const c of [bakery, hauling]) {
    await setupLedger(tabitha, c.id, { basis: "CASH" });
    const payroll = { payroll: true, payrollSystem: "ADP_RUN", payrollProvider: "ADP", payrollFrequency: "BIWEEKLY" };
    await prisma.bookkeepingProfile.upsert({ where: { clientId: c.id }, create: { clientId: c.id, ...payroll }, update: payroll });
  }
  const owner = async (clientId: string, email: string, name: string) => {
    const { token } = await invitePortalUser(tabitha, clientId, { email, name, role: "OWNER" });
    const u = await acceptPortalInvite(token!, "Fictional-Pass-12345");
    return { id: u.id, name: u.name, email: u.email };
  };
  return { tabitha, outsider, bakery, hauling, pat: await owner(bakery.id, "pat@fictional.example", "Pat Owner"), sam: await owner(hauling.id, "sam@fictional.example", "Sam Owner") };
}

describe("Payroll from upload to the client's portal", () => {
  it("reads an ADP payroll summary to the cent (no AI) and refuses one that doesn't tie out", async () => {
    const dates = readAdpSummary([SUMMARY]);
    expect(dates.map((d) => [d.checkDate, d.grossCents, d.netPayCents, d.employerTaxCents, d.medicareCents])).toEqual([
      ["2026-10-09", 210000, 169935, 18665, 3045],
      ["2026-10-23", 200000, 162200, 15300, 2900],
    ]);
    const broken = SUMMARY.map((l) => (l === "1,622.00 FED SOCSEC-ER 124.00" ? "1,632.00 FED SOCSEC-ER 124.00" : l));
    expect(() => readAdpSummary([broken])).toThrow(/2026-10-23 check date couldn't be verified/);
  });

  it("staff upload → saved to the right business → shared → the client sees pay history and opens the file; nobody else can", async () => {
    const w = await world();
    const bytes = await pdf(SUMMARY);
    // Preview (what the page shows before importing): two pay dates, instantly.
    const pv = await previewPayrollImport(w.tabitha, w.bakery.id, { bytes, fileName: "FICTIONAL_BAKERY_Reports.pdf", preset: "ADP_RUN" });
    expect(pv.payDates.map((p) => p.checkDate)).toEqual(["2026-10-09", "2026-10-23"]);
    const r = await importPayrollRegister(w.tabitha, w.bakery.id, { bytes, fileName: "FICTIONAL_BAKERY_Reports.pdf", preset: "ADP_RUN", alreadyProcessed: true });
    expect(r.created.length).toBe(2);
    expect(await prisma.payrollRun.count({ where: { clientId: w.hauling.id } })).toBe(0);

    // Staff side: the file is under this business's payroll reports, not yet shared.
    let reports = await payrollReports(w.bakery.id);
    expect(reports.map((x) => [x.id, x.category, x.shared])).toEqual([[r.documentId, "PAYROLL", false]]);
    await prisma.document.update({ where: { id: r.documentId }, data: { scanStatus: "CLEAN" } });

    // Client side before sharing: the pay history (processed runs) shows; the file doesn't yet.
    let page = await portalPayrollPage(w.pat, w.bakery.id);
    expect(page.history.map((h) => [h.payDate, h.status])).toEqual([["2026-10-23", expect.any(String)], ["2026-10-09", expect.any(String)]]);
    expect(page.documents).toEqual([]);

    // Only staff who may do this business's payroll can share it.
    await expect(sharePayrollReport(w.outsider, w.bakery.id, r.documentId, { share: true })).rejects.toThrow();
    await sharePayrollReport(w.tabitha, w.bakery.id, r.documentId, { share: true });
    reports = await payrollReports(w.bakery.id);
    expect(reports[0]).toMatchObject({ shared: true, clientOpenedAt: null });
    // Silent release: no client notification unless asked for.
    expect(await prisma.notification.count({ where: { portalUserId: w.pat.id } })).toBe(0);

    page = await portalPayrollPage(w.pat, w.bakery.id);
    expect(page.documents.map((d) => d.id)).toEqual([r.documentId]);
    // The client's own link opens it; another client's login can't, even with a link.
    expect(await authorizeDownload(downloadToken(r.documentId, { portalUserId: w.pat.id }), { portalUserId: w.pat.id })).toMatchObject({ id: r.documentId });
    expect(await authorizeDownload(downloadToken(r.documentId, { portalUserId: w.sam.id }), { portalUserId: w.sam.id })).toBeNull();
    await expect(portalPayrollPage(w.sam, w.bakery.id)).rejects.toThrow();
    expect((await portalPayrollPage(w.sam, w.hauling.id)).documents).toEqual([]);

    // Staff can confirm the client opened it.
    await prisma.documentAccessLog.create({ data: { documentId: r.documentId, action: "VIEW", portalUserId: w.pat.id } });
    expect((await payrollReports(w.bakery.id))[0].clientOpenedAt).toBeInstanceOf(Date);

    // Stop sharing: gone from the client's page.
    await sharePayrollReport(w.tabitha, w.bakery.id, r.documentId, { share: false });
    expect((await portalPayrollPage(w.pat, w.bakery.id)).documents).toEqual([]);
    // Uploading the same report again doesn't double anything.
    const again = await importPayrollRegister(w.tabitha, w.bakery.id, { bytes, fileName: "FICTIONAL_BAKERY_Reports.pdf", preset: "ADP_RUN", alreadyProcessed: true });
    expect([again.created.length, again.duplicates.length]).toEqual([0, 2]);
  });

  it("a payroll register saved under Bookkeeping by an earlier import can now be shared (moved to Payroll)", async () => {
    const w = await world();
    const old = await staffUploadDocument(w.tabitha, { clientId: w.bakery.id, category: "BOOKKEEPING", docType: "PAYROLL_REPORT", title: "Payroll register — ADP RUN — 2026-09-11", visibility: "STAFF_ONLY", bytes: await pdf(["Fictional payroll register", "September"]), originalName: "old.pdf", year: 2026, month: 9, notify: false });
    await prisma.document.update({ where: { id: old.id }, data: { scanStatus: "CLEAN" } });
    await sharePayrollReport(w.tabitha, w.bakery.id, old.id, { share: true, notify: true });
    expect(await prisma.document.findUniqueOrThrow({ where: { id: old.id } })).toMatchObject({ category: "PAYROLL", visibility: "PUBLISHED" });
    expect((await portalPayrollPage(w.pat, w.bakery.id)).documents.map((d) => d.id)).toEqual([old.id]);
    // Another business's file can't be shared from this business.
    await expect(sharePayrollReport(w.tabitha, w.hauling.id, old.id, { share: true })).rejects.toThrow(/isn't on file/);
  });
});
