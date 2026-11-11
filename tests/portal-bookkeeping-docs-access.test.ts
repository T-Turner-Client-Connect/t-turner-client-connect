import { beforeEach, describe, expect, it } from "vitest";
import { makeUser, managed, prisma, resetDb } from "./db";
import { createClient } from "@/lib/services/clients";
import { openPeriod } from "@/lib/services/bookkeeping";
import { acceptPortalInvite, invitePortalUser } from "@/lib/services/portal-accounts";
import { authorizeDownload, downloadToken, portalPeriodDocumentsWhere, portalUploadDocument, staffUploadDocument } from "@/lib/services/documents";
import { requireClientAccess } from "@/lib/portal/access";

// Fictional business and people only. Each login of a business sees only what its own access
// allows on the portal's Bookkeeping page, and the server refuses anything else.
beforeEach(resetDb);

const pdf = (label: string) => new TextEncoder().encode(`%PDF-1.4\n% ${label} ${Math.random()}\n`);

async function setup() {
  const staff = await makeUser("ADMIN", "Tabitha");
  const biz = await createClient(staff, { businessName: "Linden Example Bakery (fictional)", clientType: "BUSINESS", status: "ACTIVE" });
  const login = async (email: string, name: string) => {
    const { token } = await invitePortalUser(staff, biz.id, { email, name, role: "OWNER" });
    const u = await acceptPortalInvite(token!, "Client-Pass-12345");
    return { id: u.id, name: u.name, email: u.email };
  };
  const owner = await login("owner@linden.example", "Avery Owner");
  const clerk = await login("clerk@linden.example", "Casey Clerk"); // documents yes, payroll no
  const helper = await login("helper@linden.example", "Drew Helper"); // neither documents nor payroll
  await managed(biz.id);
  await prisma.portalAccess.updateMany({ where: { clientId: biz.id, portalUserId: clerk.id }, data: { canViewPayroll: false } });
  await prisma.portalAccess.updateMany({ where: { clientId: biz.id, portalUserId: helper.id }, data: { canViewPayroll: false, canViewDocuments: false } });
  const period = await openPeriod(staff, biz.id, 2026, 3);
  // The owner's uploads for March: a payroll report and a receipt.
  const payroll = await portalUploadDocument(owner, { clientId: biz.id, periodId: period.id, docType: "PAYROLL_REPORT", title: "March payroll report", bytes: pdf("payroll"), originalName: "payroll.pdf" });
  const receipt = await portalUploadDocument(owner, { clientId: biz.id, periodId: period.id, docType: "RECEIPTS", title: "March receipts", bytes: pdf("receipts"), originalName: "receipts.pdf" });
  // A report that was published without Tabitha's approval (a bad state the page must not show).
  const draft = await staffUploadDocument(staff, { clientId: biz.id, category: "BOOKKEEPING", title: "March P&L (draft)", visibility: "STAFF_ONLY", periodId: period.id, reportType: "PROFIT_AND_LOSS", bytes: pdf("pnl"), originalName: "pnl.pdf", notify: false });
  await prisma.document.updateMany({ where: { id: { in: [payroll.id, receipt.id, draft.id] } }, data: { scanStatus: "CLEAN" } });
  await prisma.document.update({ where: { id: draft.id }, data: { visibility: "PUBLISHED", reviewStatus: "DRAFT" } });
  return { biz, owner, clerk, helper, period, payroll, receipt, draft };
}

const titlesFor = async (s: Awaited<ReturnType<typeof setup>>, login: { id: string }) => {
  const access = await requireClientAccess(login.id, s.biz.id);
  const rows = await prisma.document.findMany({ where: { periodId: s.period.id, ...portalPeriodDocumentsWhere(access, login.id) }, select: { title: true } });
  return rows.map((r) => r.title).sort();
};

describe("Bookkeeping uploads and payroll documents in the portal", () => {
  it("the old Bookkeeping-page filter showed every login every upload and a draft report (the original problem)", async () => {
    const s = await setup();
    const old = await prisma.document.findMany({ where: { periodId: s.period.id, deletedAt: null, OR: [{ visibility: "PUBLISHED", scanStatus: "CLEAN" }, { uploadedByPortalId: { not: null } }] }, select: { title: true } });
    expect(old.map((r) => r.title).sort()).toEqual(["March P&L (draft)", "March payroll report", "March receipts"]);
  });

  it("each login now sees only what its access allows: payroll only with payroll access, uploads only with document access, never a draft report", async () => {
    const s = await setup();
    expect(await titlesFor(s, s.owner)).toEqual(["March payroll report", "March receipts"]);
    expect(await titlesFor(s, s.clerk)).toEqual(["March receipts"]);
    expect(await titlesFor(s, s.helper)).toEqual([]);
  });

  it("the server refuses a download the login's access doesn't allow, even with a valid link", async () => {
    const s = await setup();
    const open = async (login: { id: string }, docId: string) => authorizeDownload(downloadToken(docId, { portalUserId: login.id }), { portalUserId: login.id });
    expect(await open(s.owner, s.payroll.id)).not.toBeNull();
    expect(await open(s.clerk, s.payroll.id)).toBeNull(); // no payroll access
    expect(await open(s.clerk, s.receipt.id)).not.toBeNull();
    expect(await open(s.helper, s.receipt.id)).toBeNull(); // no document access
    expect(await open(s.owner, s.draft.id)).toBeNull(); // never an unapproved report
  });
});
