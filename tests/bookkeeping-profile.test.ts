import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PDFDocument } from "pdf-lib";
import { makeUser, prisma, resetDb } from "./db";
import { ForbiddenError } from "@/lib/auth/actor";
import { createClient } from "@/lib/services/clients";
import { acceptPortalInvite, invitePortalUser } from "@/lib/services/portal-accounts";
import { staffUploadDocument } from "@/lib/services/documents";
import {
  approveReport, deliverApprovedReports, enrollExistingClient, enrollNewClient, reportHistory, saveProfile, submitReportForReview, uploadMonthlyReport,
} from "@/lib/services/bookkeeping-clients";
import {
  billingView, recordChargeAuthorization, revealEin, saveAccount, saveBilling, saveBusinessInfo, setBillingAccess,
} from "@/lib/services/bookkeeping-profile";
import { reportPeriod } from "@/lib/bookkeeping-periods";
import { buildPacketPdf } from "@/lib/services/financial-packet";

let seq = 0;
async function pdf(pages = 1) {
  const d = await PDFDocument.create();
  for (let i = 0; i < pages; i++) d.addPage([792, 612]).drawText(`fictional statement ${seq++}`);
  return new Uint8Array(await d.save());
}

beforeEach(async () => {
  await resetDb();
  vi.stubEnv("MALWARE_SCAN_URL", "https://scanner.test/scan");
  vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ clean: true }), { status: 200 }));
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

async function setup() {
  const tabitha = await makeUser("ADMIN", "Tabitha");
  await prisma.ownerAccess.create({ data: { userId: tabitha.id, isPrimary: true } });
  const otherAdmin = await makeUser("ADMIN", "Second");
  const daria = await makeUser("STAFF", "Daria");
  const shop = await createClient(tabitha, { businessName: "Fictional Roofing LLC", clientType: "BUSINESS", status: "ACTIVE" });
  await saveProfile(tabitha, shop.id, { active: true, frequency: "MONTHLY", payroll: true, payrollFrequency: "BIWEEKLY", payrollProvider: "ADP" });
  return { tabitha, otherAdmin, daria, shop };
}

describe("assignment, business profile and EIN", () => {
  it("keeps staff assignment Admin-only while Daria can still add clients", async () => {
    const { tabitha, daria, shop } = await setup();
    await expect(saveProfile(daria, shop.id, { active: true, frequency: "MONTHLY", payroll: true, assignedToId: daria.id })).rejects.toBeInstanceOf(ForbiddenError);
    expect((await prisma.client.findUniqueOrThrow({ where: { id: shop.id } })).assignedToId).toBeNull();
    await expect(enrollNewClient(daria, { businessName: "Fictional Bakery", clientType: "BUSINESS", status: "ACTIVE" }, { active: true, frequency: "MONTHLY", payroll: false, assignedToId: daria.id })).rejects.toBeInstanceOf(ForbiddenError);
    const c = await enrollNewClient(daria, { businessName: "Fictional Bakery", clientType: "BUSINESS", status: "ACTIVE" }, { active: true, frequency: "QUARTERLY", payroll: false });
    const other = await createClient(tabitha, { businessName: "Fictional Florist", clientType: "BUSINESS", status: "ACTIVE" });
    await enrollExistingClient(daria, other.id, { active: true, frequency: "MONTHLY", payroll: false });
    await saveProfile(tabitha, c.id, { active: true, frequency: "QUARTERLY", payroll: false, assignedToId: daria.id });
    expect((await prisma.client.findUniqueOrThrow({ where: { id: c.id } })).assignedToId).toBe(daria.id);
  });

  it("stores the EIN encrypted, shows it masked, and opens it in full only for Admins (logged)", async () => {
    const { tabitha, otherAdmin, daria, shop } = await setup();
    await expect(saveBusinessInfo(daria, shop.id, { ein: "12-345" })).rejects.toThrow(/9 digits/);
    await saveBusinessInfo(daria, shop.id, {
      legalName: "Fictional Roofing LLC", dba: "Top Roofs", ein: "12 3456789", businessAddress1: "PO Box 1", businessCity: "Helena", businessState: "al", businessPostalCode: "35080",
      businessEmail: "Office@Roofing.example", contactName: "Sam Example", contactTitle: "Member", businessStartDate: new Date(2019, 4, 1), entityType: "S_CORP", fiscalYearEnd: 12,
      workingYear: 2026, accountingBasis: "CASH", payrollAccessStatus: "ACCOUNTANT_ACCESS", payrollReports: ["PAYROLL_REGISTER", "TAX_LIABILITY", "BOGUS"],
    });
    const p = await prisma.bookkeepingProfile.findUniqueOrThrow({ where: { clientId: shop.id } });
    expect(p.einLast4).toBe("6789");
    expect(p.einEncrypted).not.toContain("3456789");
    expect([p.businessState, p.businessEmail, p.accountingBasis]).toEqual(["AL", "office@roofing.example", "CASH"]);
    expect(p.payrollReports).toEqual(["PAYROLL_REGISTER", "TAX_LIABILITY"]);
    expect((await prisma.client.findUniqueOrThrow({ where: { id: shop.id } })).entityType).toBe("S_CORP");
    await expect(revealEin(daria, shop.id)).rejects.toBeInstanceOf(ForbiddenError);
    expect(await revealEin(otherAdmin, shop.id)).toBe("12-3456789");
    expect(await revealEin(tabitha, shop.id)).toBe("12-3456789");
    expect(await prisma.auditLog.count({ where: { action: "bookkeeping.ein_viewed" } })).toBe(2);
    // A blank EIN on a later save keeps the stored one.
    await saveBusinessInfo(daria, shop.id, { legalName: "Fictional Roofing LLC", accountingBasis: "ACCRUAL" });
    expect((await prisma.bookkeepingProfile.findUniqueOrThrow({ where: { clientId: shop.id } })).einLast4).toBe("6789");
  });

  it("bank and card accounts never take credentials", async () => {
    const { daria, shop } = await setup();
    await expect(saveAccount(daria, shop.id, null, { institution: "Fictional Bank", accountType: "CHECKING", last4: "12345" })).rejects.toThrow(/last 4/);
    await expect(saveAccount(daria, shop.id, null, { institution: "Fictional Bank", accountType: "CHECKING", loginUrl: "http://bank.example/login" })).rejects.toThrow(/https/);
    await expect(saveAccount(daria, shop.id, null, { institution: "Fictional Bank", accountType: "CHECKING", loginUrl: "https://user:pw@bank.example/login" })).rejects.toThrow(/without usernames/);
    await expect(saveAccount(daria, shop.id, null, { institution: "Fictional Bank", accountType: "CHECKING", accessNote: "password is Summer2026" })).rejects.toThrow(/Don't save passwords/);
    await expect(saveAccount(daria, shop.id, null, { institution: "Fictional Bank", accountType: "CHECKING", accessNote: "security answer: blue" })).rejects.toThrow(/Don't save passwords/);
    const id = await saveAccount(daria, shop.id, null, { institution: "Fictional State Bank", accountType: "CHECKING", last4: "4884", loginUrl: "https://bank.example/business/login", accessStatus: "DELEGATED_ACCESS", accessNote: "Client added us as accountant user" });
    await saveAccount(daria, shop.id, null, { institution: "Fictional Card Co", accountType: "CREDIT_CARD", last4: "1005", accessStatus: "STATEMENTS_ONLY" });
    expect(await prisma.bookkeepingAccount.count({ where: { clientId: shop.id } })).toBe(2);
    const cols = Object.keys((await prisma.bookkeepingAccount.findUniqueOrThrow({ where: { id } })) as object);
    expect(cols.some((c) => /pass|secret|answer|code/i.test(c))).toBe(false);
  });
});

describe("monthly bookkeeping billing", () => {
  it("is Tabitha-only unless she grants it; Square shows not connected; a card alone authorizes nothing", async () => {
    const { tabitha, otherAdmin, daria, shop } = await setup();
    expect((await billingView(daria, shop.id)).allowed).toBe(false);
    expect((await billingView(otherAdmin, shop.id)).allowed).toBe(false);
    await expect(saveBilling(daria, shop.id, { monthlyFee: "350" })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(saveBilling(tabitha, shop.id, { monthlyFee: "350", notes: "card 4111 1111 1111 1111" })).rejects.toThrow(/Card numbers/);
    await expect(saveBilling(tabitha, shop.id, { monthlyFee: "350", squareCustomerId: "4111111111111111" })).rejects.toThrow(/never a card number/);
    await saveBilling(tabitha, shop.id, { monthlyFee: "$350.00", billingStartDate: new Date(2026, 10, 1), billingDay: 5, paymentStatus: "CURRENT", squareCustomerId: "SQ_CUST_FICTIONAL_1" });
    let v = await billingView(tabitha, shop.id);
    if (!v.allowed) throw new Error("expected access");
    expect(v.billing?.monthlyFeeCents).toBe(35000);
    expect(v.square).toEqual({ connected: false, card: null, cardId: null });
    expect(v.chargeAuthorized).toBe(false);
    await expect(recordChargeAuthorization(tabitha, shop.id, { amount: "350", startDate: new Date(2026, 10, 5), method: "SIGNED_FORM", authorizedByName: "Sam Example", authorizedAt: new Date(2026, 9, 20) })).rejects.toThrow(/Attach the signed/);
    const form = await staffUploadDocument(tabitha, { clientId: shop.id, category: "CONTRACTS", visibility: "STAFF_ONLY", bytes: await pdf(), originalName: "authorization.pdf" });
    await recordChargeAuthorization(tabitha, shop.id, { amount: "350", startDate: new Date(2026, 10, 5), method: "SIGNED_FORM", authorizedByName: "Sam Example", authorizedAt: new Date(2026, 9, 20), evidenceDocumentId: form.id });
    v = await billingView(tabitha, shop.id);
    expect(v.allowed && v.chargeAuthorized).toBe(true);
    // Only Tabitha grants billing access — not another Admin.
    await expect(setBillingAccess(otherAdmin, daria.id, true)).rejects.toBeInstanceOf(ForbiddenError);
    await setBillingAccess(tabitha, daria.id, true);
    expect((await billingView(daria, shop.id)).allowed).toBe(true);
    await setBillingAccess(tabitha, daria.id, false);
    await expect(saveBilling(daria, shop.id, { monthlyFee: "1" })).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe("reporting periods and financial packets", () => {
  it("describes month, quarter and year-to-date periods (fiscal years too)", () => {
    expect(reportPeriod(2026, 9, "YEAR_TO_DATE").cover).toBe("For the Nine Months January 1, 2026 – September 30, 2026");
    expect(reportPeriod(2026, 9, "YEAR_TO_DATE").ended).toBe("Nine Months Ended September 30, 2026");
    expect(reportPeriod(2026, 9, "MONTH").cover).toBe("For the Month Ended September 30, 2026");
    expect(reportPeriod(2026, 9, "QUARTER").range).toBe("July 1, 2026 – September 30, 2026");
    expect(() => reportPeriod(2026, 8, "QUARTER")).toThrow(/quarter ends/);
    const fy = reportPeriod(2026, 9, "YEAR_TO_DATE", 6); // fiscal year ends June
    expect([fy.start.getFullYear(), fy.start.getMonth() + 1, fy.months]).toEqual([2026, 7, 3]);
    expect(reportPeriod(2026, 3, "YEAR_TO_DATE", 6).start.getFullYear()).toBe(2025);
  });

  it("builds draft-stamped packets for staff; clients get only delivered reports after Tabitha approves", async () => {
    const { tabitha, daria, shop } = await setup();
    const { token } = await invitePortalUser(tabitha, shop.id, { email: "owner@roofing.example", name: "Owner", role: "OWNER" });
    const owner = await acceptPortalInvite(token!, "Owner-Pass-1234");
    await saveBusinessInfo(tabitha, shop.id, { legalName: "Fictional Roofing LLC", accountingBasis: "CASH", contactName: "Sam Example", contactTitle: "Member" });
    const acct = await saveAccount(daria, shop.id, null, { institution: "Fictional State Bank", accountType: "CHECKING", last4: "4884" });
    const up = (reportType: string, extra: object = {}) => pdf(2).then((bytes) => uploadMonthlyReport(daria, { clientId: shop.id, year: 2026, month: 9, periodType: "YEAR_TO_DATE", reportType, bytes, originalName: `${reportType}.pdf`, ...extra }));
    const pl = await up("PROFIT_AND_LOSS", { includesYtd: true });
    const gr = await up("GROSS_RECEIPTS");
    const bs = await up("BALANCE_SHEET");
    const rec = await up("BANK_RECONCILIATION", { accountId: acct });
    await expect(up("BALANCE_SHEET", { asOf: new Date(2027, 0, 1) })).rejects.toThrow(/as of/);
    // Basis comes from the profile; Balance Sheet "as of" defaults to the period end.
    const bsDoc = await prisma.document.findUniqueOrThrow({ where: { id: bs.document.id } });
    expect([bsDoc.reportBasis, bsDoc.reportPeriodType, bsDoc.reportAsOf?.getDate(), bsDoc.year, bsDoc.month, bsDoc.visibility]).toEqual(["CASH", "YEAR_TO_DATE", 30, 2026, 9, "STAFF_ONLY"]);
    expect((await prisma.document.findUniqueOrThrow({ where: { id: rec.document.id } })).bookkeepingAccountId).toBe(acct);
    // A monthly September P&L is a separate report from the year-to-date one, not a revision of it.
    const monthly = await uploadMonthlyReport(daria, { clientId: shop.id, year: 2026, month: 9, reportType: "PROFIT_AND_LOSS", bytes: await pdf(), originalName: "pl-sep.pdf" });
    expect(monthly.version).toBe(1);
    await expect(uploadMonthlyReport(daria, { clientId: shop.id, year: 2026, month: 9, periodType: "MONTH", reportType: "PROFIT_AND_LOSS", replacesId: pl.document.id, bytes: await pdf(), originalName: "x.pdf" })).rejects.toThrow(/same reporting period/);

    // Staff preview: cover + 4 reports x 2 pages, stamped as drafts.
    const staffPacket = await buildPacketPdf(pl.period.id, "YEAR_TO_DATE", { staff: true });
    expect(staffPacket!.draft).toBe(true);
    expect((await PDFDocument.load(staffPacket!.pdf)).getPageCount()).toBe(9);
    expect(staffPacket!.filename).toContain("DRAFT");
    // The client gets nothing before approval and delivery.
    expect(await buildPacketPdf(pl.period.id, "YEAR_TO_DATE", { portalUserId: owner.id })).toBeNull();

    for (const r of [pl, gr, bs, rec]) await submitReportForReview(daria, r.document.id);
    await expect(approveReport(daria, pl.document.id)).rejects.toBeInstanceOf(ForbiddenError);
    for (const r of [pl, gr, bs]) await approveReport(tabitha, r.document.id);
    const before = await prisma.notification.count();
    expect(await deliverApprovedReports(daria, pl.period.id, "YEAR_TO_DATE")).toBe(3); // reconciliation not approved yet
    expect(await prisma.notification.count()).toBeGreaterThan(before);
    const clientPacket = await buildPacketPdf(pl.period.id, "YEAR_TO_DATE", { portalUserId: owner.id });
    expect(clientPacket!.draft).toBe(false);
    expect(clientPacket!.usedFiles.sort()).toEqual([pl, gr, bs].map((r) => r.document.id).sort());
    expect((await PDFDocument.load(clientPacket!.pdf)).getPageCount()).toBe(7);
    // The monthly packet is separate and still a draft.
    expect(await buildPacketPdf(pl.period.id, "MONTH", { portalUserId: owner.id })).toBeNull();

    // Revision keeps history; the client keeps the delivered version until the revision is delivered.
    const v2 = await uploadMonthlyReport(daria, { clientId: shop.id, year: 2026, month: 9, periodType: "YEAR_TO_DATE", reportType: "BALANCE_SHEET", bytes: await pdf(2), originalName: "bs-rev.pdf" });
    expect(v2.version).toBe(2);
    expect((await buildPacketPdf(pl.period.id, "YEAR_TO_DATE", { portalUserId: owner.id }))!.usedFiles).toContain(bs.document.id);
    const hist = await reportHistory(v2.document.id);
    expect(hist.map((h) => `${h.version}:${h.action}`)).toEqual(["1:uploaded", "1:submitted", "1:approved", "1:delivered", "2:uploaded"]);
  });

  it("a complete packet uploaded as one file is delivered as is", async () => {
    const { tabitha, daria, shop } = await setup();
    await saveBusinessInfo(tabitha, shop.id, { accountingBasis: "ACCRUAL" });
    const full = await uploadMonthlyReport(daria, { clientId: shop.id, year: 2026, month: 6, periodType: "QUARTER", reportType: "FINANCIAL_PACKET", bytes: await pdf(5), originalName: "q2-packet.pdf" });
    const built = await buildPacketPdf(full.period.id, "QUARTER", { staff: true });
    expect((await PDFDocument.load(built!.pdf)).getPageCount()).toBe(5); // no generated cover on top of the client's own
    expect((await prisma.document.findUniqueOrThrow({ where: { id: full.document.id } })).reportBasis).toBe("ACCRUAL");
  });
});
