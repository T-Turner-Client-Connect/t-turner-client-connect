import { beforeEach, describe, expect, it } from "vitest";
import { makeUser, prisma, resetDb } from "./db";
import { createClient } from "@/lib/services/clients";
import { commitTaxImport, createFiling, decideTaxRow, setFilingStatusByStaff, setPrepStatus, stageTaxImport } from "@/lib/services/tax";
import { filingStatusLabel, normalizeFilingType, normalizeJurisdiction, normalizeStatus } from "@/lib/tax/normalize";
import { staffSendMessage, portalConversations } from "@/lib/services/messaging";
import { acceptPortalInvite, invitePortalUser } from "@/lib/services/portal-accounts";
import { cancelReminders, runAutomations } from "@/lib/services/automations";
import { createDocumentRequest } from "@/lib/services/bookkeeping";

beforeEach(resetDb);

const MAP = { "Client ID": "clientRef", Name: "displayName", Year: "taxYear", Form: "returnType", Jurisdiction: "jurisdiction", Status: "status", "Status Date": "statusDate", "Submission ID": "submissionId" };

describe("tax normalization", () => {
  it("parses jurisdictions, filing types and statuses", () => {
    expect(normalizeJurisdiction("Federal")).toBe("FEDERAL");
    expect(normalizeJurisdiction("il")).toBe("IL");
    expect(normalizeJurisdiction("Atlantis")).toBeNull();
    expect(normalizeFilingType(null, "4868")).toBe("EXTENSION");
    expect(normalizeFilingType(null, "1040-X")).toBe("AMENDED");
    expect(normalizeFilingType(null, "1040")).toBe("ORIGINAL");
    expect(normalizeStatus("Accepted")).toBe("ACCEPTED");
    expect(normalizeStatus("Rejected")).toBe("REJECTED");
    expect(normalizeStatus("Transmitted")).toBe("PENDING_ACKNOWLEDGMENT");
    expect(filingStatusLabel({ filingType: "EXTENSION", filingStatus: "ACCEPTED", method: "ELECTRONIC" })).toBe("Extension Accepted");
    expect(filingStatusLabel({ filingType: "AMENDED", filingStatus: "ACCEPTED", method: "ELECTRONIC" })).toMatch(/accepted for processing/);
  });
});

describe("tax workspace", () => {
  async function setup() {
    const staff = await makeUser("ADMIN");
    const avery = await createClient(staff, { firstName: "Avery", lastName: "Lindqvist", clientType: "INDIVIDUAL", status: "ACTIVE" });
    await prisma.client.update({ where: { id: avery.id }, data: { taxSoftwareId: "TA-1001" } });
    const twin = await createClient(staff, { firstName: "Avery", lastName: "Lindqvist", clientType: "INDIVIDUAL", status: "ACTIVE" });
    return { staff, avery, twin };
  }

  it("keeps federal and state, prep and filing statuses independent; Accepted needs evidence", async () => {
    const { staff, avery } = await setup();
    const fed = await createFiling(staff, { clientId: avery.id, taxYear: 2025, returnType: "1040", jurisdiction: "Federal", filingType: "ORIGINAL" });
    const il = await createFiling(staff, { clientId: avery.id, taxYear: 2025, returnType: "1040", jurisdiction: "IL", filingType: "ORIGINAL" });
    await setPrepStatus(staff, fed.id, "READY_TO_FILE");
    await expect(setFilingStatusByStaff(staff, fed.id, { status: "ACCEPTED" })).rejects.toThrow(/acknowledgment/);
    await setFilingStatusByStaff(staff, fed.id, { status: "ACCEPTED", verificationNote: "Checked IRS ack in TaxAct E-file Center" });
    const [f, s] = await Promise.all([prisma.filingRecord.findUniqueOrThrow({ where: { id: fed.id } }), prisma.filingRecord.findUniqueOrThrow({ where: { id: il.id } })]);
    expect(f.filingStatus).toBe("ACCEPTED");
    expect(f.prepStatus).toBe("READY_TO_FILE");
    expect(s.filingStatus).toBe("NOT_SUBMITTED");
    expect(s.prepStatus).toBe("AWAITING_INFORMATION");
    await expect(setFilingStatusByStaff(staff, fed.id, { status: "REJECTED", eventAt: new Date("2020-01-01") })).rejects.toThrow(/newer status/);
  });

  it("imports by client ID only, previews before saving, filters queues, and never overwrites newer statuses", async () => {
    const { staff, avery } = await setup();
    const rows = [
      { clientRef: "TA-1001", displayName: "Avery Lindqvist", taxYear: "2025", returnType: "1040", jurisdiction: "Federal", status: "Accepted", statusDate: "03/14/2026", submissionId: "SUB-1" },
      { clientRef: "TA-1001", displayName: "Avery Lindqvist", taxYear: "2025", returnType: "1040", jurisdiction: "IL", status: "Rejected", statusDate: "03/15/2026" },
      { clientRef: "", displayName: "Avery Lindqvist", taxYear: "2025", returnType: "1040", jurisdiction: "Federal", status: "Accepted", statusDate: "03/14/2026" },
      { clientRef: "TA-9999", displayName: "Unknown Person", taxYear: "2025", returnType: "4868", jurisdiction: "Federal", status: "Accepted", statusDate: "04/10/2026" },
    ];
    const batch = await stageTaxImport(staff, { fileName: "efile.csv", source: "TaxAct", mapping: MAP, rows, statusFilter: ["ACCEPTED"] });
    const staged = await prisma.taxImportRow.findMany({ where: { batchId: batch.id }, orderBy: { rowNumber: "asc" } });
    expect(staged.map((r) => r.match)).toEqual(["NEW_FILING", "FILTERED", "ERROR", "NO_CLIENT"]);
    expect(staged[2].errors.join()).toMatch(/never matched by name/);
    expect(await prisma.filingRecord.count()).toBe(0); // preview only

    await expect(commitTaxImport(staff, batch.id, false)).rejects.toThrow(/Decide/);
    await decideTaxRow(staff, staged[3].id, "skip");
    const res = await commitTaxImport(staff, batch.id, false);
    expect(res.applied).toBe(1);
    const fed = await prisma.filingRecord.findFirstOrThrow({ where: { clientId: avery.id, jurisdiction: "FEDERAL" } });
    expect(fed.filingStatus).toBe("ACCEPTED");
    expect(fed.statusSource).toBe("TAXACT_IMPORT");
    expect(fed.filingReference).toBe("SUB-1");
    expect(await prisma.filingRecord.count({ where: { jurisdiction: "IL" } })).toBe(0);

    // An older export arrives later: it must not overwrite.
    const old = await stageTaxImport(staff, {
      fileName: "old.csv",
      source: "TaxAct",
      mapping: MAP,
      rows: [{ clientRef: "TA-1001", taxYear: "2025", returnType: "1040", jurisdiction: "Federal", status: "Pending", statusDate: "03/01/2026" }],
      statusFilter: ["ACCEPTED", "PENDING_ACKNOWLEDGMENT"],
    });
    expect((await prisma.taxImportRow.findFirstOrThrow({ where: { batchId: old.id } })).match).toBe("STALE");
    await commitTaxImport(staff, old.id, false);
    expect((await prisma.filingRecord.findUniqueOrThrow({ where: { id: fed.id } })).filingStatus).toBe("ACCEPTED");
    // Tax updates never touch groups/campaigns.
    expect(await prisma.clientGroup.count()).toBe(0);
  });
});

describe("internal notes", () => {
  it("are never visible in the client portal", async () => {
    const staff = await makeUser("ADMIN");
    const c = await createClient(staff, { businessName: "Note Test LLC", clientType: "BUSINESS", status: "ACTIVE" });
    const { token } = await invitePortalUser(staff, c.id, { email: "n@example.com", name: "N", role: "OWNER" });
    const u = await acceptPortalInvite(token!, "Portal-Pass-123");
    const portal = { id: u.id, name: u.name, email: u.email };
    const note = await staffSendMessage(staff, { clientId: c.id, subject: "Internal", body: "Client seemed unsure about payroll.", channel: "INTERNAL_NOTE" });
    expect(await portalConversations(portal, c.id)).toHaveLength(0);
    await staffSendMessage(staff, { clientId: c.id, conversationId: note.conversationId, body: "Hello from the portal", channel: "PORTAL" });
    const convos = await portalConversations(portal, c.id);
    expect(convos).toHaveLength(1);
    expect(convos[0].messages[0].channel).toBe("PORTAL");
    expect(await prisma.notification.count({ where: { kind: "NEW_MESSAGE" } })).toBe(1);
  });
});

describe("automations", () => {
  it("send nothing while paused, never duplicate, and honour cancellation", async () => {
    const staff = await makeUser("ADMIN");
    const c = await createClient(staff, { businessName: "Reminder LLC", clientType: "BUSINESS", status: "ACTIVE" });
    const { token } = await invitePortalUser(staff, c.id, { email: "r@example.com", name: "R", role: "OWNER" });
    await acceptPortalInvite(token!, "Portal-Pass-123");
    const req = await createDocumentRequest(staff, { clientId: c.id, title: "Bank statement", dueAt: new Date(Date.now() + 24 * 3600 * 1000) });
    await prisma.notification.deleteMany();

    await runAutomations();
    expect(await prisma.automationRun.count()).toBe(0); // paused by default

    await prisma.automationRule.update({ where: { kind: "MISSING_DOCUMENT_REMINDER" }, data: { enabled: true } });
    await Promise.all([runAutomations(), runAutomations()]); // overlapping runs
    await runAutomations();
    expect(await prisma.automationRun.count()).toBe(1);
    expect(await prisma.notification.count()).toBe(1);

    // Later, the next reminder is due; cancel stops it.
    const rule = await prisma.automationRule.findUniqueOrThrow({ where: { kind: "MISSING_DOCUMENT_REMINDER" } });
    await cancelReminders(staff, rule.id, `request:${req.id}`, c.id);
    await runAutomations(new Date(Date.now() + 30 * 24 * 3600 * 1000));
    expect(await prisma.automationRun.count({ where: { outcome: "QUEUED" } })).toBe(1);
  });
});
