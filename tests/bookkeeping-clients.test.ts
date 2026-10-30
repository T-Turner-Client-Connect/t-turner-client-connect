import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeUser, prisma, resetDb } from "./db";
import { ForbiddenError } from "@/lib/auth/actor";
import { createClient } from "@/lib/services/clients";
import { acceptPortalInvite, invitePortalUser } from "@/lib/services/portal-accounts";
import { portalDocuments, portalUploadDocument, setVisibility, staffUploadDocument } from "@/lib/services/documents";
import { staffSendMessage } from "@/lib/services/messaging";
import { setPeriodStatus } from "@/lib/services/bookkeeping";
import { assertOwner } from "@/lib/auth/owner";
import {
  approveReport, bookkeepingClients, bookkeepingWorkspace, deliverReport, enrollExistingClient, enrollNewClient, isReportApprover, openWorkPeriod, PossibleDuplicateError, reportsAwaitingReview, reportVersions, requestReportChanges, saveProfile, setChecklistItem, submitReportForReview, uploadMonthlyReport, workMonth,
} from "@/lib/services/bookkeeping-clients";

let seq = 0;
const pdf = () => new TextEncoder().encode(`%PDF-1.4\n% fictional bk ${seq++}\n`);

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
  const bakery = await createClient(tabitha, { businessName: "Bakery LLC", clientType: "BUSINESS", status: "ACTIVE" });
  await saveProfile(tabitha, bakery.id, { active: true, frequency: "MONTHLY", payroll: true, payrollFrequency: "BIWEEKLY", payrollProvider: "Gusto", assignedToId: daria.id });
  const { token } = await invitePortalUser(tabitha, bakery.id, { email: "owner@bakery.example", name: "Owner", role: "OWNER" });
  const u = await acceptPortalInvite(token!, "Owner-Pass-1234");
  return { tabitha, otherAdmin, daria, bakery, owner: { id: u.id, name: u.name, email: u.email } };
}

describe("financial report approval", () => {
  it("only Tabitha approves; nothing reaches the client before approval — not by publishing, messages or month status", async () => {
    const { tabitha, otherAdmin, daria, bakery, owner } = await setup();
    expect(await isReportApprover(tabitha)).toBe(true);
    expect(await isReportApprover(otherAdmin)).toBe(false);
    expect(await isReportApprover(daria)).toBe(false);
    const p = await openWorkPeriod(daria, bakery.id, 2026, 9);
    await expect(staffUploadDocument(daria, { clientId: bakery.id, category: "BOOKKEEPING", visibility: "PUBLISHED", reportType: "PROFIT_AND_LOSS", periodId: p.id, bytes: pdf(), originalName: "pl.pdf" })).rejects.toThrow(/need Tabitha's approval/);
    const pl = await staffUploadDocument(daria, { clientId: bakery.id, category: "BOOKKEEPING", visibility: "STAFF_ONLY", reportType: "PROFIT_AND_LOSS", periodId: p.id, bytes: pdf(), originalName: "pl.pdf" });
    expect(pl.reviewStatus).toBe("DRAFT");
    await expect(setVisibility(daria, pl.id, "PUBLISHED")).rejects.toThrow(/approve/);
    await expect(staffSendMessage(daria, { clientId: bakery.id, body: "Here's your P&L", channel: "PORTAL", attachmentIds: [pl.id] })).rejects.toThrow(/approval/);
    await expect(deliverReport(daria, pl.id)).rejects.toThrow(/approve/);
    await expect(setPeriodStatus(daria, p.id, "READY_FOR_REVIEW")).rejects.toThrow(/approved and delivered/);

    await submitReportForReview(daria, pl.id);
    await expect(approveReport(daria, pl.id)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(approveReport(otherAdmin, pl.id)).rejects.toBeInstanceOf(ForbiddenError); // Admin role isn't enough
    await requestReportChanges(tabitha, pl.id, "Reclass the loan payment");
    expect((await prisma.document.findUniqueOrThrow({ where: { id: pl.id } })).reviewStatus).toBe("CHANGES_REQUESTED");
    await submitReportForReview(daria, pl.id);
    await approveReport(tabitha, pl.id);
    expect((await portalDocuments(owner, bakery.id)).some((d) => d.id === pl.id)).toBe(false); // approved, not yet delivered
    await deliverReport(daria, pl.id);
    expect((await portalDocuments(owner, bakery.id)).some((d) => d.id === pl.id)).toBe(true);
    await setPeriodStatus(daria, p.id, "READY_FOR_REVIEW");
    expect(await prisma.auditLog.count({ where: { action: { in: ["bookkeeping.report_submitted", "bookkeeping.report_approved", "bookkeeping.report_delivered"] } } })).toBe(4);
    // Approving reports doesn't open the Owner's Office for anyone else.
    await expect(assertOwner(daria)).rejects.toThrow();
  });
});

describe("Bookkeeping Clients list and checklists", () => {
  it("quarterly clients collect monthly; payroll reports only for payroll clients; filters and overdue work", async () => {
    const { tabitha, daria, bakery, owner } = await setup();
    const shop = await createClient(tabitha, { businessName: "Quarterly Shop", clientType: "BUSINESS", status: "ACTIVE" });
    await saveProfile(tabitha, shop.id, { active: true, frequency: "QUARTERLY", payroll: false });
    // Quarterly: July (not quarter end) has documents but no report step; September (quarter end) has it.
    const jul = await openWorkPeriod(tabitha, shop.id, 2026, 7);
    const sep = await openWorkPeriod(tabitha, shop.id, 2026, 9);
    const keys = async (id: string) => (await prisma.bookkeepingChecklistItem.findMany({ where: { periodId: id } })).map((i) => i.key).sort();
    expect(await keys(jul.id)).toEqual(["BANK_STATEMENTS", "CARD_STATEMENTS", "CATEGORIZE", "RECEIPTS", "RECONCILE"]);
    expect(await keys(sep.id)).toContain("PREPARE_REPORTS");
    expect(await keys(sep.id)).not.toContain("PAYROLL_REPORTS");
    const bk = await openWorkPeriod(tabitha, bakery.id, 2026, 9);
    expect(await keys(bk.id)).toEqual(expect.arrayContaining(["PAYROLL_REPORTS", "PAYROLL_ENTRIES"]));
    expect(workMonth("QUARTERLY", new Date(2026, 9, 15))).toEqual({ year: 2026, month: 9 }); // monthly collection for quarterly too

    // A client upload labeled as a bank statement counts as received.
    await portalUploadDocument(owner, { clientId: bakery.id, periodId: bk.id, docType: "BANK_STATEMENT", bytes: pdf(), originalName: "bank.pdf" });
    let ws = await bookkeepingWorkspace(bakery.id, bk.id);
    expect(ws.summary!.items.find((i) => i.key === "BANK_STATEMENTS")!.state).toBe("RECEIVED");
    expect(ws.summary!.items.find((i) => i.key === "PAYROLL_REPORTS")!.state).toBe("WAITING_CLIENT");
    await setChecklistItem(daria, ws.summary!.items.find((i) => i.key === "CARD_STATEMENTS")!.id, "NOT_NEEDED");

    // Filters (as of Oct 15, 2026: September is the work month).
    const now = new Date(2026, 9, 15);
    expect((await bookkeepingClients({ now })).map((r) => r.client.displayName)).toEqual(["Bakery LLC", "Quarterly Shop"]);
    expect((await bookkeepingClients({ assignedTo: daria.id, now })).map((r) => r.client.displayName)).toEqual(["Bakery LLC"]);
    expect((await bookkeepingClients({ assignedTo: "unassigned", now })).map((r) => r.client.displayName)).toEqual(["Quarterly Shop"]);
    expect((await bookkeepingClients({ frequency: "QUARTERLY", now })).map((r) => r.client.displayName)).toEqual(["Quarterly Shop"]);
    expect((await bookkeepingClients({ missing: true, now })).length).toBe(2);
    // No due days set yet: nothing is overdue (no built-in deadline).
    expect((await bookkeepingClients({ overdue: true, now })).length).toBe(0);
    await saveProfile(tabitha, bakery.id, { active: true, frequency: "MONTHLY", payroll: true, payrollFrequency: "BIWEEKLY", documentsDueDay: 12, reportsDueDay: 25 });
    expect((await bookkeepingClients({ overdue: true, now: new Date(2026, 9, 11) })).length).toBe(0); // Oct 11: before the 12th
    const late = await bookkeepingClients({ overdue: true, now });
    expect(late.map((r) => r.client.displayName)).toEqual(["Bakery LLC"]); // Oct 15: documents past due, reports not yet
    expect(late[0].overdue).toEqual(["Client documents overdue"]);
    expect((await bookkeepingClients({ overdue: true, now: new Date(2026, 9, 26) }))[0].overdue).toContain("Reports overdue");
    await expect(saveProfile(tabitha, bakery.id, { active: true, frequency: "MONTHLY", payroll: true, documentsDueDay: 40 })).rejects.toThrow(/1–31/);
    expect((await bookkeepingClients({ review: true, now })).length).toBe(0);
    const pl = await staffUploadDocument(daria, { clientId: bakery.id, category: "BOOKKEEPING", visibility: "STAFF_ONLY", reportType: "PROFIT_AND_LOSS", periodId: bk.id, bytes: pdf(), originalName: "pl.pdf" });
    await submitReportForReview(daria, pl.id);
    const review = await bookkeepingClients({ review: true, now });
    expect(review.map((r) => r.client.displayName)).toEqual(["Bakery LLC"]);
    expect(review[0].stage).toBe("AWAITING_REVIEW");
    ws = await bookkeepingWorkspace(bakery.id, bk.id);
    expect(ws.summary!.reports.map((r) => r.reviewStatus)).toEqual(["AWAITING_REVIEW"]);
  });
});

describe("Add Bookkeeping Client and Upload Monthly Financials", () => {
  it("adds existing clients without duplicates, creates new ones only after a duplicate check — for Tabitha and Daria", async () => {
    const { tabitha, daria, bakery } = await setup();
    const florist = await createClient(tabitha, { businessName: "Fictional Florist LLC", email: "hello@florist.example", phone: "205-555-0142", clientType: "BUSINESS", status: "ACTIVE" });
    const before = await prisma.client.count();

    // Daria (staff) enrolls an existing CRM client, sets quarterly + payroll + assigns herself.
    await enrollExistingClient(daria, florist.id, { active: true, frequency: "QUARTERLY", payroll: true, payrollFrequency: "WEEKLY", payrollProvider: "ADP", assignedToId: daria.id });
    const prof = await prisma.bookkeepingProfile.findUniqueOrThrow({ where: { clientId: florist.id } });
    expect([prof.frequency, prof.payroll, prof.payrollFrequency]).toEqual(["QUARTERLY", true, "WEEKLY"]);
    expect((await prisma.client.findUniqueOrThrow({ where: { id: florist.id } })).assignedToId).toBe(daria.id);
    await expect(enrollExistingClient(tabitha, florist.id, { active: true, frequency: "MONTHLY", payroll: false })).rejects.toThrow(/already a Bookkeeping Client/);
    // "Keep as is" (assignedToId undefined) never unassigns.
    await saveProfile(tabitha, florist.id, { active: true, frequency: "QUARTERLY", payroll: true });
    expect((await prisma.client.findUniqueOrThrow({ where: { id: florist.id } })).assignedToId).toBe(daria.id);
    // A paused client is reactivated, not duplicated.
    await saveProfile(tabitha, bakery.id, { active: false, frequency: "MONTHLY", payroll: true });
    expect((await enrollExistingClient(daria, bakery.id, { active: true, frequency: "MONTHLY", payroll: true })).reactivated).toBe(true);
    expect(await prisma.client.count()).toBe(before);

    // New client: a matching email or phone (any formatting) refuses and points at the existing record.
    const dupEmail = enrollNewClient(daria, { businessName: "Florist Two", email: "HELLO@florist.example", clientType: "BUSINESS", status: "ACTIVE" }, { active: true, frequency: "MONTHLY", payroll: false });
    await expect(dupEmail).rejects.toBeInstanceOf(PossibleDuplicateError);
    await expect(enrollNewClient(tabitha, { businessName: "Other", phone: "(205) 555-0142", clientType: "BUSINESS", status: "ACTIVE" }, { active: true, frequency: "MONTHLY", payroll: false }, { differentClient: true })).rejects.toThrow(/already belongs to Fictional Florist LLC/);
    // Same name only: needs an explicit "different client".
    await expect(enrollNewClient(daria, { businessName: "fictional florist llc", clientType: "BUSINESS", status: "ACTIVE" }, { active: true, frequency: "MONTHLY", payroll: false })).rejects.toThrow(/different client/);
    expect(await prisma.client.count()).toBe(before);
    const fresh = await enrollNewClient(daria, { businessName: "Fictional Car Wash", firstName: "Sam", lastName: "Example", email: "owner@carwash.example", clientType: "BUSINESS", status: "ACTIVE" }, { active: true, frequency: "MONTHLY", payroll: false, assignedToId: daria.id, documentsDueDay: 15 });
    expect(await prisma.client.count()).toBe(before + 1);
    expect((await prisma.client.findUniqueOrThrow({ where: { id: fresh.id } })).displayName).toBe("Fictional Car Wash");
    expect((await prisma.contact.findFirstOrThrow({ where: { clientId: fresh.id } })).name).toBe("Sam Example");
    expect((await prisma.client.findUniqueOrThrow({ where: { id: fresh.id } })).assignedToId).toBe(daria.id);
    expect((await prisma.bookkeepingProfile.findUniqueOrThrow({ where: { clientId: fresh.id } })).documentsDueDay).toBe(15);
    // Nothing is sent to anyone while adding clients.
    expect(await prisma.portalInvite.count({ where: { clientId: fresh.id } })).toBe(0);
    expect((await bookkeepingClients()).map((r) => r.client.displayName)).toEqual(["Bakery LLC", "Fictional Car Wash", "Fictional Florist LLC"]);
  });

  it("files reports under client → year → month as drafts, keeps version history, and only Tabitha's approval lets staff deliver", async () => {
    const { tabitha, daria, bakery, owner } = await setup();
    // Daria uploads a P&L for a month that isn't open yet: the month is opened.
    const v1 = await uploadMonthlyReport(daria, { clientId: bakery.id, year: 2026, month: 8, reportType: "PROFIT_AND_LOSS", bytes: pdf(), originalName: "pl-aug.pdf" });
    expect(v1.version).toBe(1);
    const doc1 = await prisma.document.findUniqueOrThrow({ where: { id: v1.document.id } });
    expect([doc1.category, doc1.year, doc1.month, doc1.periodId, doc1.visibility, doc1.reviewStatus]).toEqual(["BOOKKEEPING", 2026, 8, v1.period.id, "STAFF_ONLY", "DRAFT"]);
    expect(doc1.title).toBe("Profit & loss — August 2026");
    const bs = await uploadMonthlyReport(tabitha, { clientId: bakery.id, year: 2026, month: 8, reportType: "BALANCE_SHEET", bytes: pdf(), originalName: "bs-aug.pdf" });
    expect(bs.version).toBe(1);
    await expect(uploadMonthlyReport(daria, { clientId: bakery.id, year: 2026, month: 13, reportType: "PROFIT_AND_LOSS", bytes: pdf(), originalName: "x.pdf" })).rejects.toThrow(/month/);
    await expect(uploadMonthlyReport(daria, { clientId: bakery.id, year: 2026, month: 8, reportType: "", bytes: pdf(), originalName: "x.pdf" })).rejects.toThrow(/kind of report/);

    // Approve and deliver v1; the client gets one notification.
    await submitReportForReview(daria, v1.document.id);
    await expect(approveReport(daria, v1.document.id)).rejects.toBeInstanceOf(ForbiddenError);
    await approveReport(tabitha, v1.document.id);
    await deliverReport(daria, v1.document.id);
    expect((await portalDocuments(owner, bakery.id)).map((d) => d.id)).toEqual([v1.document.id]);
    const notices = await prisma.notification.count();

    // Revised P&L: v2 is a draft; the client still has v1 until v2 is approved and delivered.
    const v2 = await uploadMonthlyReport(daria, { clientId: bakery.id, year: 2026, month: 8, reportType: "PROFIT_AND_LOSS", replacesId: v1.document.id, bytes: pdf(), originalName: "pl-aug-rev.pdf" });
    expect(v2.version).toBe(2);
    expect((await portalDocuments(owner, bakery.id)).map((d) => d.id)).toEqual([v1.document.id]);
    await expect(submitReportForReview(daria, v1.document.id)).rejects.toThrow(/newer version/);
    await expect(setVisibility(daria, v2.document.id, "PUBLISHED")).rejects.toThrow(/approve/);
    await expect(uploadMonthlyReport(daria, { clientId: bakery.id, year: 2026, month: 8, reportType: "PROFIT_AND_LOSS", replacesId: v1.document.id, bytes: pdf(), originalName: "again.pdf" })).rejects.toThrow(/already replaced/);
    await expect(uploadMonthlyReport(daria, { clientId: bakery.id, year: 2026, month: 9, reportType: "PROFIT_AND_LOSS", replacesId: v2.document.id, bytes: pdf(), originalName: "wrong-month.pdf" })).rejects.toThrow(/same month/);
    // Uploading another P&L for the month without choosing "replaces" also becomes the next version.
    const v3 = await uploadMonthlyReport(daria, { clientId: bakery.id, year: 2026, month: 8, reportType: "PROFIT_AND_LOSS", bytes: pdf(), originalName: "pl-aug-rev2.pdf" });
    expect(v3.version).toBe(3);
    expect((await reportVersions(v3.document.id)).map((d) => d.version)).toEqual([3, 2, 1]);
    const ws = await bookkeepingWorkspace(bakery.id, v1.period.id);
    expect(ws.summary!.reports.map((r) => [r.reportType, r.version]).sort()).toEqual([["BALANCE_SHEET", 1], ["PROFIT_AND_LOSS", 3]]);

    await submitReportForReview(daria, v3.document.id);
    expect((await reportsAwaitingReview()).map((d) => d.id)).toEqual([v3.document.id]);
    await approveReport(tabitha, v3.document.id);
    await deliverReport(daria, v3.document.id);
    // The client now sees only the newest delivered version; staff keep all three.
    expect((await portalDocuments(owner, bakery.id)).map((d) => d.id)).toEqual([v3.document.id]);
    expect(await prisma.document.count({ where: { clientId: bakery.id, reportType: "PROFIT_AND_LOSS", deletedAt: null } })).toBe(3);
    expect(await prisma.notification.count()).toBeGreaterThan(notices);
    await expect(setVisibility(tabitha, v1.document.id, "PUBLISHED")).rejects.toThrow(/newer version/);
  });
});
