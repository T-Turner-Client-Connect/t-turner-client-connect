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
  approveReport, bookkeepingClients, bookkeepingWorkspace, deliverReport, isReportApprover, openWorkPeriod, requestReportChanges, saveProfile, setChecklistItem, submitReportForReview, workMonth,
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
