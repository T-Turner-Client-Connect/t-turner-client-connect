import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeUser, prisma, resetDb } from "./db";
import { ForbiddenError } from "@/lib/auth/actor";
import { createClient } from "@/lib/services/clients";
import { acceptPortalInvite, invitePortalUser } from "@/lib/services/portal-accounts";
import { authorizeDownload, downloadToken, financialStatementAudit, portalDocuments, portalUploadDocument, scanQuarantined, setVisibility, staffUploadDocument } from "@/lib/services/documents";
import { ensureClientPerson, uploadIdentityDocument } from "@/lib/services/identity";
import { approveReport, deliverReport, submitReportForReview, uploadMonthlyReport } from "@/lib/services/bookkeeping-clients";
import { openPeriod } from "@/lib/services/bookkeeping";
import { packetReports } from "@/lib/services/financial-packet";
import { staffSendMessage } from "@/lib/services/messaging";
import { loadPortalDocuments } from "@/lib/portal/views";

const pdf = () => new TextEncoder().encode(`%PDF-1.4\n% fictional ${Math.random()}\n`);
let scanner: "clean" | "down" = "clean";
beforeEach(async () => {
  await resetDb();
  scanner = "clean";
  vi.stubEnv("MALWARE_SCAN_URL", "https://scanner.test/scan");
  vi.stubGlobal("fetch", async () => (scanner === "clean" ? new Response(JSON.stringify({ clean: true }), { status: 200 }) : new Response("down", { status: 503 })));
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

async function setup() {
  const tabitha = await makeUser("ADMIN", "Tabitha");
  await prisma.ownerAccess.create({ data: { userId: tabitha.id, isPrimary: true } });
  const otherAdmin = await makeUser("ADMIN", "Other Admin");
  const daria = await makeUser("STAFF", "Daria");
  const biz = await createClient(tabitha, { businessName: "Fictional Insulation LLC", clientType: "BUSINESS", status: "ACTIVE" });
  await prisma.client.update({ where: { id: biz.id }, data: { assignedToId: daria.id } });
  const period = await openPeriod(tabitha, biz.id, 2026, 9);
  const { token } = await invitePortalUser(tabitha, biz.id, { email: "owner@fictional.example", name: "Pat Owner", role: "OWNER" });
  const login = await acceptPortalInvite(token!, "Owner-Pass-12345");
  const client = { id: login.id, name: login.name, email: login.email };
  const canOpen = async (id: string) => !!(await authorizeDownload(downloadToken(id, { portalUserId: login.id }), { portalUserId: login.id }));
  return { tabitha, otherAdmin, daria, biz, period, client, canOpen };
}

describe("financial statements reach clients only through Tabitha's approval", () => {
  it("refuses direct publishing of bookkeeping files — blank report type, Daria, another Admin, and Tabitha alike", async () => {
    const { tabitha, otherAdmin, daria, biz } = await setup();
    for (const who of [daria, otherAdmin, tabitha]) {
      // Generic upload with the report type left blank.
      await expect(staffUploadDocument(who, { clientId: biz.id, category: "BOOKKEEPING", visibility: "PUBLISHED", year: 2026, month: 9, bytes: pdf(), originalName: "pl.pdf" })).rejects.toThrow(/Upload Monthly Financials/);
      // Saved staff-only first, then published with the generic Publish action.
      const d = await staffUploadDocument(who, { clientId: biz.id, category: "BOOKKEEPING", visibility: "STAFF_ONLY", year: 2026, month: 9, bytes: pdf(), originalName: "pl.pdf" });
      await expect(setVisibility(who, d.id, "PUBLISHED")).rejects.toThrow(/Upload Monthly Financials/);
      // Labeled as a P&L but filed under another category.
      const o = await staffUploadDocument(who, { clientId: biz.id, category: "OTHER", visibility: "STAFF_ONLY", docType: "PNL", bytes: pdf(), originalName: "statement.pdf" });
      await expect(setVisibility(who, o.id, "PUBLISHED")).rejects.toThrow(/Upload Monthly Financials/);
    }
    expect(await prisma.document.count({ where: { clientId: biz.id, visibility: "PUBLISHED" } })).toBe(0);
  });

  it("only Tabitha approves; delivery needs approval and a passed scan; a clean scan never approves anything", async () => {
    const { tabitha, otherAdmin, daria, biz, canOpen } = await setup();
    const { document: r } = await uploadMonthlyReport(daria, { clientId: biz.id, year: 2026, month: 9, reportType: "PROFIT_AND_LOSS", basis: "CASH", bytes: pdf(), originalName: "sept-pl.pdf" });
    expect((await prisma.document.findUniqueOrThrow({ where: { id: r.id } })).scanStatus).toBe("CLEAN");
    expect((await prisma.document.findUniqueOrThrow({ where: { id: r.id } })).reviewStatus).toBe("DRAFT"); // clean ≠ approved
    await expect(setVisibility(tabitha, r.id, "PUBLISHED")).rejects.toThrow(/approve/);
    await expect(deliverReport(tabitha, r.id)).rejects.toThrow(/approve/);
    await submitReportForReview(daria, r.id);
    await expect(approveReport(daria, r.id)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(approveReport(otherAdmin, r.id)).rejects.toBeInstanceOf(ForbiddenError);
    expect(await canOpen(r.id)).toBe(false);
    await approveReport(tabitha, r.id);
    expect(await canOpen(r.id)).toBe(false); // approved but not delivered
    await deliverReport(daria, r.id);
    expect(await canOpen(r.id)).toBe(true);

    // A report whose scan hasn't passed can't be submitted or delivered.
    scanner = "down";
    const { document: u } = await uploadMonthlyReport(daria, { clientId: biz.id, year: 2026, month: 9, reportType: "PROFIT_AND_LOSS", basis: "CASH", bytes: pdf(), originalName: "sept-pl-v2.pdf" });
    await expect(submitReportForReview(daria, u.id)).rejects.toThrow(/malware scan/);
  });

  it("an unapproved statement can't reach the client by any other path — even if it was published before this rule", async () => {
    const { tabitha, daria, biz, period, client, canOpen } = await setup();
    // Simulate a file published the old way (blank report type) before this fix.
    const legacy = await staffUploadDocument(tabitha, { clientId: biz.id, category: "BOOKKEEPING", visibility: "STAFF_ONLY", year: 2026, month: 9, periodId: period.id, bytes: pdf(), originalName: "Energy Solutions P&L Sept.pdf" });
    await prisma.document.update({ where: { id: legacy.id }, data: { visibility: "PUBLISHED", publishedAt: new Date() } });
    // An unapproved report forced into PUBLISHED.
    const { document: draft } = await uploadMonthlyReport(daria, { clientId: biz.id, year: 2026, month: 9, reportType: "PROFIT_AND_LOSS", basis: "CASH", bytes: pdf(), originalName: "draft.pdf" });
    await prisma.document.update({ where: { id: draft.id }, data: { visibility: "PUBLISHED", publishedAt: new Date() } });

    // Downloads and previews (same check), vault lists, home lists, packets.
    expect(await canOpen(legacy.id)).toBe(false);
    expect(await canOpen(draft.id)).toBe(false);
    expect((await portalDocuments(client, biz.id)).map((d) => d.id)).toEqual([]);
    const access = await prisma.portalAccess.findFirstOrThrow({ where: { portalUserId: client.id, clientId: biz.id } });
    expect((await loadPortalDocuments(biz.id, access)).map((d) => d.id)).toEqual([]);
    expect((await packetReports(period.id, "MONTH", { portalUserId: client.id })).map((d) => d.id)).not.toContain(draft.id);
    // Message attachments.
    await expect(staffSendMessage(daria, { clientId: biz.id, body: "Here's your P&L", channel: "PORTAL", attachmentIds: [legacy.id] })).rejects.toThrow(/Upload Monthly Financials/);
    await expect(staffSendMessage(daria, { clientId: biz.id, body: "Draft", channel: "PORTAL", attachmentIds: [draft.id] })).rejects.toThrow(/Upload Monthly Financials/);

    // The audit flags both without changing or deleting them; a name alone only hints.
    const hinted = await staffUploadDocument(tabitha, { clientId: biz.id, category: "OTHER", visibility: "STAFF_ONLY", title: "Balance Sheet 9-30", bytes: pdf(), originalName: "bs.pdf" });
    const audit = await financialStatementAudit();
    const level = (id: string) => audit.find((a) => a.doc.id === id)?.level;
    expect(level(legacy.id)).toBe("PUBLISHED_OUTSIDE_FLOW");
    expect(level(draft.id)).toBe("PUBLISHED_OUTSIDE_FLOW");
    expect(level(hinted.id)).toBe("NAME_SUGGESTS_STATEMENT");
    const after = await prisma.document.findUniqueOrThrow({ where: { id: legacy.id } });
    expect([after.deletedAt, after.category, after.reportType, after.visibility]).toEqual([null, "BOOKKEEPING", null, "PUBLISHED"]);

    // Non-financial client documents are unaffected; the client's own uploads stay theirs.
    const w9 = await staffUploadDocument(tabitha, { clientId: biz.id, category: "TAXES", visibility: "PUBLISHED", year: 2025, docType: "FEDERAL_RETURN", bytes: pdf(), originalName: "1120s.pdf" });
    expect(await canOpen(w9.id)).toBe(true);
  });

  it("client uploads: receipt only while quarantined, theirs after a clean scan, never a statement or an identity bypass; tokens are bound to one viewer", async () => {
    const { tabitha, daria, biz, client, canOpen } = await setup();
    // Quarantined (scanner down): not openable by anyone.
    scanner = "down";
    const mine = await portalUploadDocument(client, { clientId: biz.id, year: 2026, docType: "W2", bytes: pdf(), originalName: "w2.pdf" });
    expect(await canOpen(mine.id)).toBe(false);
    // Clean: the client's own ordinary document opens for them.
    scanner = "clean";
    await scanQuarantined();
    expect(await canOpen(mine.id)).toBe(true);
    // Even labeled P&L by the client, it is their upload — it can't enter the report workflow or be approved.
    const theirPl = await portalUploadDocument(client, { clientId: biz.id, year: 2026, docType: "PNL", bytes: pdf(), originalName: "my-pl.pdf" });
    await expect(submitReportForReview(daria, theirPl.id)).rejects.toThrow();
    await expect(approveReport(tabitha, theirPl.id)).rejects.toThrow();
    // If a client upload were ever given a report type, the exemption no longer applies.
    await prisma.document.update({ where: { id: theirPl.id }, data: { reportType: "PROFIT_AND_LOSS" } });
    expect(await canOpen(theirPl.id)).toBe(false);
    // A download link minted for one viewer doesn't work for another.
    const staffToken = downloadToken(mine.id, { staffId: daria.id });
    expect(await authorizeDownload(staffToken, { portalUserId: client.id })).toBeNull();
    // Identity: a client-uploaded SS card stays Admin-only after a clean scan.
    const person = await ensureClientPerson(biz.id);
    await uploadIdentityDocument({ portal: client }, { clientId: biz.id, personId: person.id, type: "SOCIAL_SECURITY_CARD", bytes: pdf(), originalName: "ss.pdf" });
    const ss = await prisma.document.findFirstOrThrow({ where: { clientId: biz.id, category: "IDENTITY" } });
    expect(ss.scanStatus).toBe("CLEAN");
    expect(await canOpen(ss.id)).toBe(false);
  });
});
