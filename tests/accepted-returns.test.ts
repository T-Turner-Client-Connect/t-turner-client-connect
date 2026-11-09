import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeUser, prisma, resetDb } from "./db";
import { ForbiddenError, type Actor } from "@/lib/auth/actor";
import { createClient } from "@/lib/services/clients";
import { acceptPortalInvite, invitePortalUser } from "@/lib/services/portal-accounts";
import { scanQuarantined, setVisibility, staffUploadDocument } from "@/lib/services/documents";
import { confirmPortalIdentity, retrieveFilings, taxYearStatuses } from "@/lib/services/tax-center";
import { attachFilingDocument, commitTaxImport, createFiling, decideTaxRow, nextFilingStatus, publishFilingUpdate, setFilingStatusByStaff, stageTaxImport } from "@/lib/services/tax";
import { createSummary } from "@/lib/services/tax-summary";
import { bulkUploadReturns, fileReturn, releaseReturn, returnsQueue, submitReturnForRelease } from "@/lib/services/tax-returns";
import { loadPortalTaxes } from "@/lib/portal/tax-view";
import { chicagoLocalToUtc } from "@/lib/tz";
import { federalFirst, portalJurisdictionLabel } from "@/lib/tax/normalize";
import {
  confirmAcceptance,
  confirmAcceptances,
  deliverAcceptedReturn,
  deliverIntake,
  deliveryContext,
  DRAFT_SUMMARY_REASON,
  pendingAcceptances,
  PRESET_OVERRIDE_REASON,
  relabelFilingDocument,
  removeFilingDocument,
  resolveAcceptedAt,
  convertToReturnCopy,
  fileReturnForFiling,
  editFilingDetails,
  moveFilingDocument,
  removeFiling,
  unsentDraftSummaries,
  withdrawAcceptanceRequest,
  type DeliverInput,
} from "@/lib/services/accepted-returns";

// Every person, business, ID and amount here is fictional.
const pdf = (tag: string | number = Math.random()) => new TextEncoder().encode(`%PDF-1.4\n% fictional ${tag}\n`);
let scanner: "clean" | "down" = "clean";
beforeEach(async () => {
  await resetDb();
  scanner = "clean";
  vi.stubEnv("MALWARE_SCAN_URL", "https://scanner.test/scan");
  vi.stubGlobal("fetch", async () => (scanner === "clean" ? new Response(JSON.stringify({ clean: true }), { status: 200 }) : new Response("unavailable", { status: 503 })));
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

async function setup() {
  const tabitha = await makeUser("ADMIN", "Tabitha");
  await prisma.ownerAccess.create({ data: { userId: tabitha.id, isPrimary: true } });
  const daria = await makeUser("STAFF", "Daria");
  const otherAdmin = await makeUser("ADMIN", "Other Admin");
  const rosalind = await createClient(tabitha, { firstName: "Rosalind", lastName: "Pembrook", clientType: "INDIVIDUAL", status: "ACTIVE" });
  const other = await createClient(tabitha, { firstName: "Theo", lastName: "Quillfeather", clientType: "INDIVIDUAL", status: "ACTIVE" });
  const portal = async (clientId: string, email: string, name: string) => {
    const { token } = await invitePortalUser(tabitha, clientId, { email, name, role: "OWNER" });
    const login = await acceptPortalInvite(token!, "Fictional-Pass-12345");
    await confirmPortalIdentity(tabitha, clientId, login.id, "In person with photo ID");
    return { id: login.id, name: login.name, email: login.email };
  };
  const rosalindLogin = await portal(rosalind.id, "rosalind@fictional.example", "Rosalind Pembrook");
  const theoLogin = await portal(other.id, "theo@fictional.example", "Theo Quillfeather");
  return { tabitha, daria, otherAdmin, rosalind, other, rosalindLogin, theoLogin };
}

/** Fixture: a client-approved 2025 summary on file (approval itself is tested in tax-summary.test.ts). */
async function approvedSummary(actor: Actor, clientId: string, taxYear = 2025) {
  const s = await createSummary(actor, { clientId, taxYear, filingStatus: "SINGLE", taxpayerName: "Rosalind Pembrook", dependents: [], wagesCents: 4_000_000, otherIncomeCents: 0, totalIncomeCents: 4_000_000, agiCents: 4_000_000, deductionType: "STANDARD", deductionCents: 1_500_000, taxableIncomeCents: 2_500_000, federalResultCents: 80_000, stateResults: [{ state: "AL", resultCents: 12_000 }] });
  await prisma.taxReturnSummary.update({ where: { id: s.id }, data: { status: "CLIENT_APPROVED", sentAt: new Date(), approvedAt: new Date() } });
  await prisma.taxSummarySignature.create({ data: { summaryId: s.id, role: "TAXPAYER", signerName: "Rosalind Pembrook", consentText: "fictional", figuresHash: s.figuresHash } });
  return s;
}

const fedAndAl = (over: Partial<DeliverInput> = {}): DeliverInput => ({
  clientId: "",
  taxYear: 2025,
  filingType: "ORIGINAL",
  filings: [
    { jurisdiction: "FEDERAL", returnType: "1040", acceptedOn: "2026-04-08", submissionId: "SUB-FED-0001" },
    { jurisdiction: "AL", returnType: "40", acceptedOn: "2026-04-09", submissionId: "SUB-AL-0001" },
  ],
  combinedReturn: { bytes: pdf("combined-1040-al40"), originalName: "Pembrook 2025 1040 + AL 40.pdf" },
  verificationNote: "Accepted per TaxAct E-file Center",
  ...over,
});
const filingEvents = (filingId: string) => prisma.filingStatusEvent.findMany({ where: { filingId, field: "FILING" }, orderBy: { createdAt: "asc" } });

describe("Deliver an already-accepted return in one step", () => {
  it("owner with a client-approved summary: federal + Alabama from one combined PDF, both accepted and shown under each return", async () => {
    const { tabitha, rosalind, rosalindLogin } = await setup();
    await approvedSummary(tabitha, rosalind.id);
    // Form 8879 must be confirmed; nothing is saved when it isn't (atomic).
    await expect(deliverAcceptedReturn(tabitha, fedAndAl({ clientId: rosalind.id, owner: { form8879Confirmed: false } }))).rejects.toThrow(/Form 8879/);
    expect(await prisma.filingRecord.count()).toBe(0);
    expect(await prisma.document.count()).toBe(0);

    const ack = { bytes: pdf("irs-ack"), originalName: "IRS ack.pdf" };
    const input = fedAndAl({ clientId: rosalind.id, owner: { form8879Confirmed: true }, sendToClient: true });
    input.filings[0].ackFile = ack;
    const r = await deliverAcceptedReturn(tabitha, input);
    expect(r.results.map((x) => [x.jurisdiction, x.outcome, x.sent])).toEqual([["FEDERAL", "accepted", true], ["AL", "accepted", true]]);

    const filings = await prisma.filingRecord.findMany({ where: { clientId: rosalind.id }, orderBy: { jurisdiction: "asc" } });
    expect(filings.map((f) => [f.jurisdiction, f.returnType, f.filingStatus, f.filingReference])).toEqual([["AL", "40", "ACCEPTED", "SUB-AL-0001"], ["FEDERAL", "1040", "ACCEPTED", "SUB-FED-0001"]]);
    const al = filings[0];
    expect(al.acknowledgedAt?.toISOString()).toBe(chicagoLocalToUtc("2026-04-09T12:00")!.toISOString());
    for (const f of filings) {
      // Both events are in the status history: Not submitted → Submitted → Accepted.
      expect((await filingEvents(f.id)).map((e) => `${e.fromValue}>${e.toValue}`)).toEqual(["NOT_SUBMITTED>SUBMITTED", "SUBMITTED>ACCEPTED"]);
    }
    const fedEvents = await filingEvents(filings[1].id);
    expect(fedEvents[0].verificationNote).toMatch(/client-approved summary on file/);
    expect(fedEvents[1].evidenceDocumentId).toBeTruthy();

    // One combined PDF is the return for each filing — no "already saved" refusal.
    const returns = await prisma.document.findMany({ where: { clientId: rosalind.id, filingDocType: "RETURN" }, include: { file: true } });
    expect(returns).toHaveLength(2);
    expect(new Set(returns.map((d) => d.file.sha256)).size).toBe(1);
    expect(new Set(returns.map((d) => d.filingId))).toEqual(new Set(filings.map((f) => f.id)));
    expect(returns.every((d) => d.reviewStatus === "APPROVED" && d.visibility === "PUBLISHED")).toBe(true);

    // Client portal "Your return": Federal (IRS) — Form 1040: Accepted; Alabama — Form 40: Accepted, each with the return.
    const view = await loadPortalTaxes(rosalind.id);
    const yours = view.filings.filter((f) => f.taxYear === 2025 && f.filingType === "ORIGINAL");
    expect(yours.map((f) => [f.jurisdiction, f.returnType, f.filingStatus, f.documents.filter((d) => d.filingDocType === "RETURN").length])).toEqual([["AL", "40", "ACCEPTED", 1], ["FEDERAL", "1040", "ACCEPTED", 1]]);
    expect((await retrieveFilings(rosalindLogin, rosalind.id, 2025)).total).toBe(2);
    // As the portal lists them: federal first, the state by name.
    expect([...yours].sort(federalFirst).map((f) => `${portalJurisdictionLabel(f.jurisdiction)} — Form ${f.returnType}: ${f.filingStatus === "ACCEPTED" ? "Accepted" : f.filingStatus}`)).toEqual(["Federal (IRS) — Form 1040: Accepted", "Alabama — Form 40: Accepted"]);
    // "Notify the client" was not ticked: no message of any kind.
    expect(await prisma.notification.count()).toBe(0);
  });

  it("owner without an approved summary: the preset reason is stored as the override reason, exactly as today", async () => {
    const { tabitha, rosalind } = await setup();
    await expect(deliverAcceptedReturn(tabitha, fedAndAl({ clientId: rosalind.id, owner: { form8879Confirmed: true } }))).rejects.toThrow(/no client-approved 2025 tax summary/);
    await deliverAcceptedReturn(tabitha, fedAndAl({ clientId: rosalind.id, owner: { form8879Confirmed: true, overrideReason: PRESET_OVERRIDE_REASON } }));
    const fed = await prisma.filingRecord.findFirstOrThrow({ where: { clientId: rosalind.id, jurisdiction: "FEDERAL" } });
    const [submitted] = await filingEvents(fed.id);
    expect(submitted.verificationNote).toContain(`Owner filing WITHOUT an approved summary: ${PRESET_OVERRIDE_REASON}`);
    const log = await prisma.auditLog.findFirstOrThrow({ where: { action: "filing.status_staff_update", entityId: fed.id, details: { path: ["to"], equals: "SUBMITTED" } } });
    expect(log.details).toMatchObject({ overrideReason: PRESET_OVERRIDE_REASON, form8879Confirmed: true, approvedSummaryId: null });
    // Not sent unless she ticks it.
    expect(await prisma.document.count({ where: { filingDocType: "RETURN", visibility: "PUBLISHED" } })).toBe(0);
  });

  it("separate PDFs per jurisdiction also work", async () => {
    const { tabitha, rosalind } = await setup();
    const input = fedAndAl({ clientId: rosalind.id, combinedReturn: null, owner: { form8879Confirmed: true, overrideReason: PRESET_OVERRIDE_REASON } });
    await expect(deliverAcceptedReturn(tabitha, input)).rejects.toThrow(/Choose the return PDF for the 2025 federal 1040/);
    input.filings[0].returnFile = { bytes: pdf("fed-only"), originalName: "1040.pdf" };
    input.filings[1].returnFile = { bytes: pdf("al-only"), originalName: "al40.pdf" };
    await deliverAcceptedReturn(tabitha, input);
    const returns = await prisma.document.findMany({ where: { clientId: rosalind.id, filingDocType: "RETURN" }, include: { file: true, filing: true } });
    expect(returns.map((d) => [d.filing!.jurisdiction, d.file.originalName, d.docType]).sort()).toEqual([["AL", "al40.pdf", "STATE_RETURN"], ["FEDERAL", "1040.pdf", "FEDERAL_RETURN"]]);
  });

  it("staff path: everything saved as “Ready for Tabitha to confirm acceptance”, never marked submitted; Tabitha confirms in one click", async () => {
    const { tabitha, daria, otherAdmin, rosalind, rosalindLogin } = await setup();
    const r = await deliverAcceptedReturn(daria, fedAndAl({ clientId: rosalind.id, owner: { form8879Confirmed: true, overrideReason: "trying to skip the owner" } }));
    expect(r.owner).toBe(false);
    expect(r.results.every((x) => x.outcome === "awaiting_owner")).toBe(true);
    const filings = await prisma.filingRecord.findMany({ where: { clientId: rosalind.id } });
    expect(filings.map((f) => f.filingStatus)).toEqual(["NOT_SUBMITTED", "NOT_SUBMITTED"]);
    for (const f of filings) expect(await filingEvents(f.id)).toEqual([]);
    const docs = await prisma.document.findMany({ where: { filingDocType: "RETURN" } });
    expect(docs.every((d) => d.visibility === "STAFF_ONLY" && d.reviewStatus === "DRAFT")).toBe(true);

    const queue = await pendingAcceptances();
    expect(queue.map((q) => [q.filing.jurisdiction, q.submissionId, q.needsReason, q.requestedBy])).toEqual([["FEDERAL", "SUB-FED-0001", true, "Daria"], ["AL", "SUB-AL-0001", true, "Daria"]]);
    // Not in the "send to client" lists, and can't be sent before acceptance is recorded.
    expect((await returnsQueue()).drafts).toHaveLength(0);
    await expect(submitReturnForRelease(daria, docs[0].id)).rejects.toThrow(/isn't recorded as accepted/);
    await expect(releaseReturn(tabitha, docs[0].id)).rejects.toThrow(/isn't recorded as accepted/);
    expect((await retrieveFilings(rosalindLogin, rosalind.id, 2025)).total).toBe(0);

    // Staff not assigned to this client can't confirm; Tabitha (or an Admin, or the assigned preparer) does, with the 8879 checkbox.
    void otherAdmin;
    const fed = filings.find((f) => f.jurisdiction === "FEDERAL")!;
    await expect(confirmAcceptance(daria, fed.id, { form8879Confirmed: true, overrideReason: PRESET_OVERRIDE_REASON })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(confirmAcceptance(tabitha, fed.id, { form8879Confirmed: false })).rejects.toThrow(/Form 8879/);
    const res = await confirmAcceptances(tabitha, filings.map((f) => f.id), { form8879Confirmed: true, overrideReason: PRESET_OVERRIDE_REASON });
    expect(res.done).toHaveLength(2);
    const after = await prisma.filingRecord.findUniqueOrThrow({ where: { id: fed.id } });
    expect([after.filingStatus, after.filingReference, after.acknowledgedAt?.toISOString()]).toEqual(["ACCEPTED", "SUB-FED-0001", chicagoLocalToUtc("2026-04-08T12:00")!.toISOString()]);
    expect((await filingEvents(fed.id)).map((e) => [e.toValue, e.actorId])).toEqual([["SUBMITTED", tabitha.id], ["ACCEPTED", tabitha.id]]);
    expect(await pendingAcceptances()).toHaveLength(0);
    // Her confirmation is also the release: both return copies reach the client (Daria didn't ask for a notice).
    expect((await retrieveFilings(rosalindLogin, rosalind.id, 2025)).total).toBe(2);
    expect(await prisma.notification.count()).toBe(0);
  });

  it("staff can withdraw a waiting item; the return stays a staff-only draft", async () => {
    const { daria, rosalind } = await setup();
    await deliverAcceptedReturn(daria, fedAndAl({ clientId: rosalind.id, filings: [fedAndAl().filings[0]] }));
    const f = await prisma.filingRecord.findFirstOrThrow({ where: { clientId: rosalind.id } });
    await expect(withdrawAcceptanceRequest(daria, f.id, "")).rejects.toThrow(/Say why/);
    await withdrawAcceptanceRequest(daria, f.id, "Wrong year");
    expect(await pendingAcceptances()).toHaveLength(0);
    expect((await prisma.filingRecord.findUniqueOrThrow({ where: { id: f.id } })).filingStatus).toBe("NOT_SUBMITTED");
  });

  it("re-running is safe (owner and staff)", async () => {
    const { tabitha, daria, rosalind, other } = await setup();
    const ack = { bytes: pdf("ack-rerun"), originalName: "ack.pdf" };
    const make = () => {
      const i = fedAndAl({ clientId: rosalind.id, owner: { form8879Confirmed: true, overrideReason: PRESET_OVERRIDE_REASON } });
      i.filings[0].ackFile = ack;
      return i;
    };
    const first = await deliverAcceptedReturn(tabitha, make());
    const counts = async () => [await prisma.filingRecord.count(), await prisma.document.count(), await prisma.filingStatusEvent.count(), await prisma.storedFile.count()];
    const before = await counts();
    const second = await deliverAcceptedReturn(tabitha, make());
    expect(second.results.map((x) => [x.documentId, x.outcome])).toEqual(first.results.map((x) => [x.documentId, "already_accepted"]));
    expect(await counts()).toEqual(before);

    // Staff re-run of the same submission keeps one waiting item.
    const s = fedAndAl({ clientId: other.id, filings: [fedAndAl().filings[0]], combinedReturn: { bytes: pdf("theo"), originalName: "theo.pdf" } });
    await deliverAcceptedReturn(daria, s);
    await deliverAcceptedReturn(daria, s);
    expect(await prisma.filingStatusEvent.count({ where: { field: "OWNER_CONFIRM", filing: { clientId: other.id } } })).toBe(1);
    expect(await prisma.document.count({ where: { clientId: other.id } })).toBe(1);
  });

  it("date rules: future refused; earlier than the last status refused with a clear message; same day is fine", async () => {
    const { tabitha, rosalind } = await setup();
    const owner = { form8879Confirmed: true, overrideReason: PRESET_OVERRIDE_REASON };
    const tomorrow = new Date(Date.now() + 2 * 86_400_000).toLocaleDateString("en-CA", { timeZone: "America/Chicago" });
    await expect(deliverAcceptedReturn(tabitha, fedAndAl({ clientId: rosalind.id, owner, filings: [{ jurisdiction: "FEDERAL", returnType: "1040", acceptedOn: tomorrow }] }))).rejects.toThrow(/can't be in the future/);
    await expect(deliverAcceptedReturn(tabitha, fedAndAl({ clientId: rosalind.id, owner, filings: [{ jurisdiction: "FEDERAL", returnType: "1040", acceptedOn: "" }] }))).rejects.toThrow(/Enter the date the IRS or state accepted/);

    // Submitted on Apr 6, 2026 3:09 PM (office time).
    const f = await createFiling(tabitha, { clientId: rosalind.id, taxYear: 2025, returnType: "1040", jurisdiction: "FEDERAL", filingType: "ORIGINAL" });
    const submittedAt = chicagoLocalToUtc("2026-04-06T15:09")!;
    await setFilingStatusByStaff(tabitha, f.id, { status: "SUBMITTED", eventAt: submittedAt, submission: owner });
    await expect(setFilingStatusByStaff(tabitha, f.id, { status: "ACCEPTED", eventAt: chicagoLocalToUtc("2026-04-05T10:00"), verificationNote: "x" })).rejects.toThrow(/Submitted, Apr 6, 2026, 3:09 PM\)\. The status date must be after Apr 6, 2026, 3:09 PM/);
    await expect(deliverAcceptedReturn(tabitha, fedAndAl({ clientId: rosalind.id, owner, filings: [{ jurisdiction: "FEDERAL", returnType: "1040", acceptedOn: "2026-04-01" }] }))).rejects.toThrow(/earlier than its last recorded status \(Submitted, Apr 6, 2026, 3:09 PM\)\. It must be after Apr 6, 2026, 3:09 PM/);
    // Accepted the same day it was submitted: placed just after the submission.
    await deliverAcceptedReturn(tabitha, fedAndAl({ clientId: rosalind.id, owner, filings: [{ jurisdiction: "FEDERAL", returnType: "1040", acceptedOn: "2026-04-06" }] }));
    const after = await prisma.filingRecord.findUniqueOrThrow({ where: { id: f.id } });
    expect(after.filingStatus).toBe("ACCEPTED");
    expect(after.acknowledgedAt!.getTime()).toBeGreaterThan(submittedAt.getTime());
    // Already submitted → only the Accepted event is added.
    expect((await filingEvents(f.id)).map((e) => e.toValue)).toEqual(["SUBMITTED", "ACCEPTED"]);
    expect(() => resolveAcceptedAt("not a date", null, "x")).toThrow(/Enter the date/);
  });

  it("status select defaults to the next logical status", () => {
    expect([nextFilingStatus("NOT_SUBMITTED"), nextFilingStatus("SUBMITTED"), nextFilingStatus("PENDING_ACKNOWLEDGMENT"), nextFilingStatus("REJECTED")]).toEqual(["SUBMITTED", "ACCEPTED", "ACCEPTED", "SUBMITTED"]);
  });

  it("duplicate trap: a return PDF saved earlier as the acknowledgment is offered for re-labeling, not refused", async () => {
    const { tabitha, daria, rosalind } = await setup();
    const f = await createFiling(daria, { clientId: rosalind.id, taxYear: 2025, returnType: "1040", jurisdiction: "FEDERAL", filingType: "ORIGINAL" });
    const bytes = pdf("the-return-misfiled");
    const misfiled = await staffUploadDocument(daria, { clientId: rosalind.id, category: "TAXES", year: 2025, visibility: "STAFF_ONLY", bytes, originalName: "return.pdf", notify: false });
    await attachFilingDocument(daria, f.id, misfiled.id, "OFFICIAL_ACK");
    const input = fedAndAl({ clientId: rosalind.id, filings: [fedAndAl().filings[0]], combinedReturn: { bytes, originalName: "return.pdf" }, owner: { form8879Confirmed: true, overrideReason: PRESET_OVERRIDE_REASON } });
    await expect(deliverAcceptedReturn(tabitha, input)).rejects.toThrow(/already saved on the 2025 federal 1040 filing as its acknowledgment.*Use this file as the return copy/);
    const r = await deliverAcceptedReturn(tabitha, { ...input, relabelAck: true });
    expect(r.results[0].documentId).toBe(misfiled.id);
    const doc = await prisma.document.findUniqueOrThrow({ where: { id: misfiled.id } });
    expect([doc.filingDocType, doc.docType, doc.reviewStatus, doc.visibility]).toEqual(["RETURN", "FEDERAL_RETURN", "DRAFT", "STAFF_ONLY"]);
    expect(await prisma.document.count()).toBe(1);
    expect(await prisma.auditLog.count({ where: { action: "filing.document_relabeled", entityId: misfiled.id } })).toBe(1);
  });

  it("misfiled filing documents: staff re-label or remove staff-only ones (audited soft delete); published ones only with the owner", async () => {
    const { tabitha, daria, rosalind } = await setup();
    const f = await createFiling(daria, { clientId: rosalind.id, taxYear: 2025, returnType: "1120-S", jurisdiction: "FEDERAL", filingType: "ORIGINAL" });
    const notice = await staffUploadDocument(daria, { clientId: rosalind.id, category: "TAXES", year: 2025, visibility: "STAFF_ONLY", bytes: pdf("notice"), originalName: "n.pdf", notify: false });
    await attachFilingDocument(daria, f.id, notice.id, "CORRESPONDENCE");
    expect((await relabelFilingDocument(daria, notice.id, "AGENCY_NOTICE")).filingDocType).toBe("AGENCY_NOTICE");
    await setVisibility(daria, notice.id, "PUBLISHED");
    await expect(relabelFilingDocument(daria, notice.id, "CORRESPONDENCE")).rejects.toBeInstanceOf(ForbiddenError);
    await expect(removeFilingDocument(daria, notice.id, "wrong file")).rejects.toBeInstanceOf(ForbiddenError);

    const stray = await staffUploadDocument(daria, { clientId: rosalind.id, category: "TAXES", year: 2025, visibility: "STAFF_ONLY", bytes: pdf("stray"), originalName: "stray.pdf", notify: false });
    await attachFilingDocument(daria, f.id, stray.id, "OFFICIAL_ACK");
    await expect(removeFilingDocument(daria, stray.id, "")).rejects.toThrow(/Say why/);
    await removeFilingDocument(daria, stray.id, "Wrong client's acknowledgment");
    const gone = await prisma.document.findUniqueOrThrow({ where: { id: stray.id }, include: { file: true } });
    expect([!!gone.deletedAt, gone.deletionReason]).toEqual([true, "Wrong client's acknowledgment"]);
    expect(gone.file.storageKey).toBeTruthy(); // soft delete: the file is kept for the audit trail
    expect(await prisma.auditLog.count({ where: { action: "filing.document_removed", entityId: stray.id } })).toBe(1);
    // The owner may change a published one.
    await removeFilingDocument(tabitha, notice.id, "Duplicate notice");
    expect((await prisma.document.findUniqueOrThrow({ where: { id: notice.id } })).visibility).toBe("STAFF_ONLY");
  });

  it("bulk rows with accepted dates (federal + state on one PDF) go through the same path and owner rules", async () => {
    const { tabitha, daria, rosalind, other } = await setup();
    const up = await bulkUploadReturns(daria, [
      { bytes: pdf("bulk-rosalind"), originalName: "Pembrook 2025.pdf" },
      { bytes: pdf("bulk-theo"), originalName: "Quillfeather 2025.pdf" },
    ]);
    const [a, b] = up.map((u) => u.intakeId!);
    // Owner: federal + Alabama, accepted dates per row.
    const ra = await deliverIntake(tabitha, a, {
      clientId: rosalind.id,
      taxYear: 2025,
      filingType: "ORIGINAL",
      filings: [{ jurisdiction: "FEDERAL", returnType: "1040", acceptedOn: "2026-03-02", submissionId: "BULK-1" }, { jurisdiction: "AL", returnType: "40", acceptedOn: "2026-03-03" }],
      verificationNote: "Accepted per TaxAct E-file Center",
      owner: { form8879Confirmed: true, overrideReason: PRESET_OVERRIDE_REASON },
    });
    expect(ra.results.map((x) => [x.jurisdiction, x.outcome])).toEqual([["FEDERAL", "accepted"], ["AL", "accepted"]]);
    expect((await prisma.returnIntake.findUniqueOrThrow({ where: { id: a } })).status).toBe("FILED");
    // Staff row: queued for Tabitha, not submitted.
    const rb = await deliverIntake(daria, b, { clientId: other.id, taxYear: 2025, filingType: "ORIGINAL", filings: [{ jurisdiction: "FEDERAL", returnType: "1040", acceptedOn: "2026-03-04" }], verificationNote: "Accepted per TaxAct E-file Center" });
    expect(rb.results[0].outcome).toBe("awaiting_owner");
    expect((await prisma.filingRecord.findFirstOrThrow({ where: { clientId: other.id } })).filingStatus).toBe("NOT_SUBMITTED");
    expect((await pendingAcceptances()).map((p) => p.client.id)).toEqual([other.id]);
  });

  it("TaxAct import sets Accepted only by TaxAct client ID (never by name); a later return upload then works directly", async () => {
    const { tabitha, daria, rosalind, other } = await setup();
    await prisma.client.update({ where: { id: rosalind.id }, data: { taxSoftwareId: "TA-55501" } });
    const mapping = { "Client ID": "clientRef", Name: "displayName", Year: "taxYear", Form: "returnType", Juris: "jurisdiction", Status: "status", "Status Date": "statusDate", "Submission ID": "submissionId" };
    const batch = await stageTaxImport(daria, {
      fileName: "efile.csv",
      source: "TaxAct e-file export",
      mapping,
      statusFilter: [],
      rows: [
        { clientRef: "TA-55501", displayName: "Rosalind Pembrook", taxYear: "2025", returnType: "1040", jurisdiction: "Federal", status: "Accepted", statusDate: "04/10/2026 9:30 AM", submissionId: "7777772026100abcde" },
        // Theo's name, no TaxAct ID: never matched by name.
        { clientRef: "", displayName: "Theo Quillfeather", taxYear: "2025", returnType: "1040", jurisdiction: "Federal", status: "Accepted", statusDate: "04/10/2026", submissionId: "X" },
      ],
    });
    const rows = await prisma.taxImportRow.findMany({ where: { batchId: batch.id }, orderBy: { rowNumber: "asc" } });
    expect(rows.map((r) => [r.match, r.clientId])).toEqual([["NEW_FILING", rosalind.id], ["ERROR", null]]);
    await decideTaxRow(daria, rows[1].id, "skip");
    expect(await commitTaxImport(daria, batch.id, false)).toEqual({ applied: 1, skipped: 1 });
    const f = await prisma.filingRecord.findFirstOrThrow({ where: { clientId: rosalind.id } });
    expect([f.filingStatus, f.filingReference, f.statusSource, f.acknowledgedAt?.toISOString()]).toEqual(["ACCEPTED", "7777772026100abcde", "TAXACT_IMPORT", "2026-04-10T09:30:00.000Z"]);
    expect(await prisma.filingRecord.count({ where: { clientId: other.id } })).toBe(0);

    // Staff upload the return straight away (no date needed; nothing waits for confirmation).
    const r = await deliverAcceptedReturn(daria, { clientId: rosalind.id, taxYear: 2025, filingType: "ORIGINAL", filings: [{ jurisdiction: "FEDERAL", returnType: "1040" }], combinedReturn: { bytes: pdf("after-import"), originalName: "1040.pdf" } });
    expect(r.results[0].outcome).toBe("already_accepted");
    expect(await pendingAcceptances()).toHaveLength(0);
    // The classic single upload works too.
    await expect(fileReturn(daria, { clientId: rosalind.id, taxYear: 2025, returnType: "1040", jurisdiction: "FEDERAL", filingType: "ORIGINAL", bytes: pdf("v2"), originalName: "v2.pdf" })).resolves.toMatchObject({ version: 2 });
    void tabitha;
  });

  it("client isolation: one client's delivery never reaches another client's portal or queue", async () => {
    const { tabitha, daria, rosalind, other, theoLogin } = await setup();
    await deliverAcceptedReturn(tabitha, fedAndAl({ clientId: rosalind.id, owner: { form8879Confirmed: true, overrideReason: PRESET_OVERRIDE_REASON }, sendToClient: true }));
    await deliverAcceptedReturn(daria, fedAndAl({ clientId: rosalind.id, taxYear: 2024, filings: [{ jurisdiction: "FEDERAL", returnType: "1040", acceptedOn: "2025-04-01" }], combinedReturn: { bytes: pdf("2024"), originalName: "2024.pdf" } }));
    expect((await loadPortalTaxes(other.id)).filings).toHaveLength(0);
    expect((await retrieveFilings(theoLogin, other.id, 2025)).total).toBe(0);
    await expect(retrieveFilings(theoLogin, rosalind.id, 2025)).rejects.toThrow();
    expect(await pendingAcceptances(other.id)).toHaveLength(0);
    expect(await pendingAcceptances(rosalind.id)).toHaveLength(1);
    // The same PDF for a different client is that client's own file (dedupe is per client).
    await deliverAcceptedReturn(tabitha, fedAndAl({ clientId: other.id, owner: { form8879Confirmed: true, overrideReason: PRESET_OVERRIDE_REASON } }));
    expect(await prisma.document.count({ where: { clientId: other.id, filingDocType: "RETURN", visibility: "PUBLISHED" } })).toBe(0);
  });

  it("client sees nothing until published; publishing a filing never publishes an unreleased return", async () => {
    const { tabitha, rosalind, rosalindLogin } = await setup();
    const r = await deliverAcceptedReturn(tabitha, fedAndAl({ clientId: rosalind.id, owner: { form8879Confirmed: true, overrideReason: PRESET_OVERRIDE_REASON } }));
    expect((await retrieveFilings(rosalindLogin, rosalind.id, 2025)).total).toBe(0);
    expect((await loadPortalTaxes(rosalind.id)).filings.flatMap((f) => f.documents)).toHaveLength(0);
    await publishFilingUpdate(tabitha, r.results[0].filingId, "portal_only");
    expect((await prisma.document.findUniqueOrThrow({ where: { id: r.results[0].documentId } })).visibility).toBe("STAFF_ONLY");
    expect((await loadPortalTaxes(rosalind.id)).filings.flatMap((f) => f.documents)).toHaveLength(0);
  });

  it("owner-direct: one action records acceptance and delivers; the client sees it only after the malware scan passes, with no automatic message", async () => {
    const { tabitha, rosalind, rosalindLogin } = await setup();
    scanner = "down";
    const r = await deliverAcceptedReturn(tabitha, fedAndAl({ clientId: rosalind.id, owner: { form8879Confirmed: true, overrideReason: PRESET_OVERRIDE_REASON }, sendToClient: true, notifyClient: true }));
    expect(r.results.every((x) => x.outcome === "accepted" && x.sent)).toBe(true);
    const docs = await prisma.document.findMany({ where: { filingDocType: "RETURN" } });
    expect(docs.every((d) => d.reviewStatus === "APPROVED" && d.visibility === "PUBLISHED" && d.scanStatus === "PENDING")).toBe(true);
    expect((await retrieveFilings(rosalindLogin, rosalind.id, 2025)).total).toBe(0);
    expect((await loadPortalTaxes(rosalind.id)).filings.flatMap((f) => f.documents)).toHaveLength(0);
    expect(await prisma.notification.count()).toBe(0); // not clean yet → no email
    scanner = "clean";
    await scanQuarantined(25, "scheduled");
    expect((await retrieveFilings(rosalindLogin, rosalind.id, 2025)).total).toBe(2);
    expect((await loadPortalTaxes(rosalind.id)).filings.flatMap((f) => f.documents.map((d) => d.filingDocType))).toEqual(["RETURN", "RETURN"]);
    expect(await prisma.notification.count()).toBe(0); // the scan passing sends nothing by itself
  });

  it("owner-direct notify is opt-in and email only", async () => {
    const { tabitha, rosalind } = await setup();
    await deliverAcceptedReturn(tabitha, fedAndAl({ clientId: rosalind.id, owner: { form8879Confirmed: true, overrideReason: PRESET_OVERRIDE_REASON }, sendToClient: true, notifyClient: true }));
    const n = await prisma.notification.findMany();
    expect(n.length).toBeGreaterThan(0);
    expect(n.every((x) => x.channel === "EMAIL")).toBe(true);
  });

  it("Documents tab: the owner is pointed at Finish & Send a Return; staff keep the review wording", async () => {
    const { tabitha, daria, rosalind } = await setup();
    const err = await staffUploadDocument(tabitha, { clientId: rosalind.id, category: "TAXES", visibility: "PUBLISHED", year: 2025, docType: "FEDERAL_RETURN", bytes: pdf(), originalName: "x.pdf" }).catch((e) => e);
    expect(err.message).toMatch(/Taxes tab → Finish & Send a Return \(federal and state together\)/);
    expect(err.message).not.toMatch(/send it for review|Tabitha releases/);
    expect(err.next.href).toBe(`/clients/${rosalind.id}?tab=taxes&deliver=1&year=2025#finish-send`);
    await expect(staffUploadDocument(daria, { clientId: rosalind.id, category: "TAXES", visibility: "PUBLISHED", year: 2025, docType: "STATE_RETURN", bytes: pdf(), originalName: "y.pdf" })).rejects.toThrow(/Only Tabitha, an Admin or the staff member assigned/);
    const ctx = await deliveryContext(rosalind.id, tabitha);
    expect([ctx.owner, ctx.clientType]).toEqual([true, "INDIVIDUAL"]);
    expect((await deliveryContext(rosalind.id, daria)).owner).toBe(false);
  });

  it("closes an unsent draft summary (filed before Client Connect approvals); never a sent or approved one", async () => {
    const { tabitha, daria, rosalind, other } = await setup();
    const draft = await createSummary(daria, { clientId: rosalind.id, taxYear: 2025, filingStatus: "SINGLE", taxpayerName: "Rosalind Pembrook", dependents: [], wagesCents: 0, otherIncomeCents: 0, totalIncomeCents: 0, agiCents: 0, deductionType: "STANDARD", deductionCents: 0, taxableIncomeCents: 0, federalResultCents: 0, stateResults: [] });
    expect((await deliveryContext(rosalind.id, tabitha)).draftKeys).toEqual(["2025:ORIGINAL"]);
    await deliverAcceptedReturn(tabitha, fedAndAl({ clientId: rosalind.id, owner: { form8879Confirmed: true, overrideReason: PRESET_OVERRIDE_REASON }, closeDraftSummary: true }));
    const closed = await prisma.taxReturnSummary.findUniqueOrThrow({ where: { id: draft.id } });
    expect([closed.status, closed.invalidatedReason]).toEqual(["WITHDRAWN", DRAFT_SUMMARY_REASON]);
    expect(await prisma.auditLog.count({ where: { action: "tax.summary_withdrawn", entityId: draft.id } })).toBe(1);

    // A year whose summary was sent is never touched.
    const sent = await createSummary(daria, { clientId: other.id, taxYear: 2025, filingStatus: "SINGLE", taxpayerName: "Theo Quillfeather", dependents: [], wagesCents: 0, otherIncomeCents: 0, totalIncomeCents: 0, agiCents: 0, deductionType: "STANDARD", deductionCents: 0, taxableIncomeCents: 0, federalResultCents: 0, stateResults: [] });
    await prisma.taxReturnSummary.update({ where: { id: sent.id }, data: { status: "SENT", sentAt: new Date() } });
    expect(await unsentDraftSummaries(other.id, 2025, "ORIGINAL")).toEqual([]);
    await deliverAcceptedReturn(tabitha, fedAndAl({ clientId: other.id, filings: [fedAndAl().filings[0]], owner: { form8879Confirmed: true, overrideReason: PRESET_OVERRIDE_REASON }, closeDraftSummary: true }));
    expect((await prisma.taxReturnSummary.findUniqueOrThrow({ where: { id: sent.id } })).status).toBe("SENT");
    // An approved one is never touched either.
    const approved = await approvedSummary(tabitha, rosalind.id, 2024);
    expect(await unsentDraftSummaries(rosalind.id, 2024, "ORIGINAL")).toEqual([]);
    expect((await prisma.taxReturnSummary.findUniqueOrThrow({ where: { id: approved.id } })).status).toBe("CLIENT_APPROVED");
  });

  it("portal tax progress: once the return is accepted, the questionnaire and documents steps show as done", async () => {
    const { tabitha, daria, rosalind } = await setup();
    // Staff delivery alone (not yet confirmed) changes nothing for the client.
    await deliverAcceptedReturn(daria, fedAndAl({ clientId: rosalind.id }));
    let [y] = await taxYearStatuses(rosalind.id, [2025]);
    expect(y.steps.filter((s) => !s.done).map((s) => s.key)).toEqual(["questionnaire", "documents", "filing", "acceptance"]);
    await confirmAcceptances(tabitha, (await prisma.filingRecord.findMany({ where: { clientId: rosalind.id } })).map((f) => f.id), { form8879Confirmed: true, overrideReason: PRESET_OVERRIDE_REASON });
    [y] = await taxYearStatuses(rosalind.id, [2025]);
    expect(y.steps.map((s) => [s.key, s.done])).toEqual([["questionnaire", true], ["documents", true], ["preparation", true], ["filing", true], ["acceptance", true]]);
    expect(y.steps.find((s) => s.key === "questionnaire")!.value).toBe("Completed");
    // The home pill shows the first unfinished step: none left.
    expect(y.steps.find((s) => !s.done)?.value ?? "Complete").toBe("Complete");
  });
});

describe("The return PDF put in the acknowledgment box (root cause)", () => {
  const owner = { form8879Confirmed: true, overrideReason: PRESET_OVERRIDE_REASON };
  /** What Tabitha did: Accepted with the RETURN PDF uploaded as the acknowledgment, then "Publish status & documents". */
  async function misfiled(actor: Actor, clientId: string, jurisdiction: string, returnType: string, bytes: Uint8Array) {
    const f = await createFiling(actor, { clientId, taxYear: 2025, returnType, jurisdiction, filingType: "ORIGINAL" });
    const ack = await staffUploadDocument(actor, { clientId, category: "TAXES", title: `2025 ${jurisdiction === "FEDERAL" ? "Federal" : jurisdiction} return — acknowledgment`, year: 2025, visibility: "STAFF_ONLY", bytes, originalName: "return.pdf", notify: false });
    await attachFilingDocument(actor, f.id, ack.id, "OFFICIAL_ACK");
    await setFilingStatusByStaff(actor, f.id, { status: "ACCEPTED", evidenceDocumentId: ack.id, verificationNote: "Accepted per TaxAct E-file Center", submission: owner });
    await publishFilingUpdate(actor, f.id, "portal_only");
    return { f, ack: await prisma.document.findUniqueOrThrow({ where: { id: ack.id } }) };
  }

  it("1. the Accepted status form's “Accepted return PDF (client copy)” does what fileReturn does, and goes straight to the client for Tabitha", async () => {
    const { tabitha, daria, rosalind, other, rosalindLogin } = await setup();
    const f = await createFiling(tabitha, { clientId: rosalind.id, taxYear: 2025, returnType: "1040", jurisdiction: "FEDERAL", filingType: "ORIGINAL" });
    await expect(fileReturnForFiling(tabitha, f.id, { bytes: pdf("too-early"), originalName: "r.pdf" })).rejects.toThrow(/when you record the filing as Accepted/);
    await setFilingStatusByStaff(tabitha, f.id, { status: "ACCEPTED", verificationNote: "Accepted per TaxAct E-file Center", submission: owner });
    const doc = await fileReturnForFiling(tabitha, f.id, { bytes: pdf("client-copy"), originalName: "1040.pdf" });
    expect([doc.filingId, doc.filingDocType, doc.docType, doc.reviewStatus, doc.visibility]).toEqual([f.id, "RETURN", "FEDERAL_RETURN", "APPROVED", "PUBLISHED"]);
    expect((await retrieveFilings(rosalindLogin, rosalind.id, 2025)).total).toBe(1);
    expect(await prisma.notification.count()).toBe(0);
    // Staff: the same field files the return copy, and Tabitha releases it.
    const g = await createFiling(daria, { clientId: other.id, taxYear: 2025, returnType: "1120-S", jurisdiction: "FEDERAL", filingType: "ORIGINAL" });
    await setFilingStatusByStaff(daria, g.id, { status: "ACCEPTED", verificationNote: "Accepted per TaxAct E-file Center" });
    const sd = await fileReturnForFiling(daria, g.id, { bytes: pdf("staff-copy"), originalName: "1120s.pdf" });
    expect([sd.filingDocType, sd.reviewStatus, sd.visibility]).toEqual(["RETURN", "DRAFT", "STAFF_ONLY"]);
  });

  it("2. Step 2 hitting a published acknowledgment offers “Use this file as the return copy”, which converts it in place and keeps it published", async () => {
    const { tabitha, rosalind, rosalindLogin } = await setup();
    const fedBytes = pdf("fed-return-as-ack");
    const alBytes = pdf("al-return-as-ack");
    const fed = await misfiled(tabitha, rosalind.id, "FEDERAL", "1040", fedBytes);
    const al = await misfiled(tabitha, rosalind.id, "AL", "40", alBytes);
    expect([fed.ack.visibility, fed.ack.title]).toEqual(["PUBLISHED", "2025 Federal return — acknowledgment"]);
    // Step 2 no longer stops at "already saved"; it points at the one-click conversion.
    const input = fedAndAl({ clientId: rosalind.id, combinedReturn: null, owner });
    input.filings[0].returnFile = { bytes: fedBytes, originalName: "return.pdf" };
    input.filings[1].returnFile = { bytes: alBytes, originalName: "return.pdf" };
    const err = await deliverAcceptedReturn(tabitha, input).catch((e) => e);
    expect(err.message).toMatch(/Use this file as the return copy/);
    expect(err.message).not.toMatch(/so it wasn't added again/);

    const fileCount = await prisma.storedFile.count();
    const a = await convertToReturnCopy(tabitha, fed.ack.id);
    const b = await convertToReturnCopy(tabitha, al.ack.id);
    expect([a.id, a.title, a.filingDocType, a.docType, a.filingId, a.visibility, a.reviewStatus]).toEqual([fed.ack.id, "2025 Federal return", "RETURN", "FEDERAL_RETURN", fed.f.id, "PUBLISHED", "APPROVED"]);
    expect([b.title, b.docType, b.visibility]).toEqual(["2025 AL return", "STATE_RETURN", "PUBLISHED"]);
    expect(await prisma.storedFile.count()).toBe(fileCount); // no delete and re-upload
    expect(await prisma.auditLog.count({ where: { action: "filing.document_converted_to_return", entityId: { in: [a.id, b.id] } } })).toBe(2);
    const view = await loadPortalTaxes(rosalind.id);
    expect(view.filings.flatMap((f) => f.documents.map((d) => [d.title, d.filingDocType])).sort()).toEqual([["2025 AL return", "RETURN"], ["2025 Federal return", "RETURN"]]);
    expect((await retrieveFilings(rosalindLogin, rosalind.id, 2025)).total).toBe(2);
    // Step 2 now recognizes them: re-running is a no-op.
    const r = await deliverAcceptedReturn(tabitha, input);
    expect(r.results.map((x) => x.documentId)).toEqual([a.id, b.id]);

    // The "Re-label it as the return" tick in Step 2 does the same conversion, published kept.
    const { other } = { other: await createClient(tabitha, { firstName: "Ora", lastName: "Lindqvist", clientType: "INDIVIDUAL", status: "ACTIVE" }) };
    const ob = pdf("ora-return");
    const o = await misfiled(tabitha, other.id, "FEDERAL", "1040", ob);
    const r2 = await deliverAcceptedReturn(tabitha, { clientId: other.id, taxYear: 2025, filingType: "ORIGINAL", filings: [{ jurisdiction: "FEDERAL", returnType: "1040" }], combinedReturn: { bytes: ob, originalName: "r.pdf" }, relabelAck: true, owner });
    const od = await prisma.document.findUniqueOrThrow({ where: { id: r2.results[0].documentId } });
    expect([od.id, od.title, od.filingDocType, od.visibility]).toEqual([o.ack.id, "2025 Federal return", "RETURN", "PUBLISHED"]);
  });

  it("3. “This is the return, not the acknowledgment”: works on published documents for Tabitha; staff only on staff-only ones, which then wait for her release", async () => {
    const { tabitha, daria, rosalind, other } = await setup();
    const { ack } = await misfiled(tabitha, rosalind.id, "FEDERAL", "1040", pdf("pub"));
    await expect(convertToReturnCopy(daria, ack.id)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(relabelFilingDocument(tabitha, ack.id, "RETURN")).resolves.toMatchObject({ filingDocType: "RETURN", visibility: "PUBLISHED", title: "2025 Federal return" });
    // Staff, staff-only acknowledgment on an accepted filing: converted, staff-only draft until Tabitha releases.
    const g = await createFiling(daria, { clientId: other.id, taxYear: 2025, returnType: "1120-S", jurisdiction: "FEDERAL", filingType: "ORIGINAL" });
    const sAck = await staffUploadDocument(daria, { clientId: other.id, category: "TAXES", year: 2025, visibility: "STAFF_ONLY", bytes: pdf("staff-ack"), originalName: "a.pdf", notify: false });
    await attachFilingDocument(daria, g.id, sAck.id, "OFFICIAL_ACK");
    await setFilingStatusByStaff(daria, g.id, { status: "ACCEPTED", evidenceDocumentId: sAck.id });
    const c = await convertToReturnCopy(daria, sAck.id);
    expect([c.filingDocType, c.reviewStatus, c.visibility]).toEqual(["RETURN", "DRAFT", "STAFF_ONLY"]);
    // A filing not yet accepted never shows a return to the client.
    const h = await createFiling(daria, { clientId: other.id, taxYear: 2024, returnType: "1120-S", jurisdiction: "FEDERAL", filingType: "ORIGINAL" });
    const hAck = await staffUploadDocument(daria, { clientId: other.id, category: "TAXES", year: 2024, visibility: "STAFF_ONLY", bytes: pdf("h"), originalName: "h.pdf", notify: false });
    await attachFilingDocument(daria, h.id, hAck.id, "OFFICIAL_ACK");
    await setVisibility(tabitha, hAck.id, "PUBLISHED");
    const hc = await convertToReturnCopy(tabitha, hAck.id);
    expect([hc.filingDocType, hc.visibility, hc.reviewStatus]).toEqual(["RETURN", "STAFF_ONLY", "DRAFT"]);
  });

  it("4. a state filing entered as “1040” doesn't block delivery; it is shown as entered", async () => {
    const { tabitha, rosalind } = await setup();
    const al = await createFiling(tabitha, { clientId: rosalind.id, taxYear: 2025, returnType: "1040", jurisdiction: "AL", filingType: "ORIGINAL" });
    const r = await deliverAcceptedReturn(tabitha, fedAndAl({ clientId: rosalind.id, owner }));
    expect(r.results.find((x) => x.jurisdiction === "AL")).toMatchObject({ filingId: al.id, returnType: "1040", outcome: "accepted" });
    expect(await prisma.filingRecord.count({ where: { clientId: rosalind.id, jurisdiction: "AL" } })).toBe(1);
    expect((await prisma.filingRecord.findUniqueOrThrow({ where: { id: al.id } })).filingStatus).toBe("ACCEPTED");
  });
});

describe("Fixing a filing (Tabitha only)", () => {
  const owner = { form8879Confirmed: true, overrideReason: PRESET_OVERRIDE_REASON };

  it("(a) Edit filing details: AL entered as 1040 → 40 goes through #124's audited form correction; history kept, linked documents re-titled", async () => {
    const { tabitha, daria, otherAdmin, rosalind } = await setup();
    const al = await createFiling(tabitha, { clientId: rosalind.id, taxYear: 2025, returnType: "1040", jurisdiction: "AL", filingType: "ORIGINAL" });
    await setFilingStatusByStaff(tabitha, al.id, { status: "ACCEPTED", verificationNote: "Accepted per TaxAct E-file Center", submission: owner });
    const doc = await fileReturnForFiling(tabitha, al.id, { bytes: pdf("al-return"), originalName: "al.pdf" });
    expect(doc.title).toBe("2025 1040 — AL");
    const input = { taxYear: 2025, returnType: "40", jurisdiction: "AL", filingType: "ORIGINAL" as const };
    await expect(editFilingDetails(daria, al.id, input, "wrong form")).rejects.toBeInstanceOf(ForbiddenError);
    // Other Admins can't either (Tabitha only, as in #124).
    await expect(editFilingDetails(otherAdmin, al.id, input, "wrong form")).rejects.toBeInstanceOf(ForbiddenError);
    await expect(editFilingDetails(tabitha, al.id, input, "")).rejects.toThrow(/Say why/);
    const eventsBefore = await prisma.filingStatusEvent.count({ where: { filingId: al.id } });
    const fixed = await editFilingDetails(tabitha, al.id, input, "Alabama return is Form 40, not 1040");
    expect([fixed.returnType, fixed.filingStatus]).toEqual(["40", "ACCEPTED"]);
    expect(fixed.formCorrection).toEqual({ from: "1040", to: "40", renamed: 1 });
    const events = await prisma.filingStatusEvent.findMany({ where: { filingId: al.id }, orderBy: { createdAt: "asc" } });
    expect(events).toHaveLength(eventsBefore + 1);
    expect(events.at(-1)).toMatchObject({ field: "FORM", fromValue: "1040", toValue: "40", verificationNote: "Alabama return is Form 40, not 1040" });
    expect((await prisma.document.findUniqueOrThrow({ where: { id: doc.id } })).title).toBe("2025 40 — AL");
    expect(await prisma.auditLog.count({ where: { action: "filing.form_corrected", entityId: al.id } })).toBe(1);
    expect(await prisma.auditLog.count({ where: { action: "filing.details_corrected", entityId: al.id } })).toBe(0);
    // Can't collide with another filing.
    const other = await createFiling(tabitha, { clientId: rosalind.id, taxYear: 2025, returnType: "1040", jurisdiction: "FEDERAL", filingType: "ORIGINAL" });
    await expect(editFilingDetails(tabitha, other.id, input, "test")).rejects.toThrow(/already has a 2025 AL 40 original filing/);
  });

  it("(b) Remove filing (created by mistake): reason required, full history kept in the audit log; blocked while a sent return copy is on it until moved", async () => {
    const { tabitha, daria, otherAdmin, rosalind } = await setup();
    const wrong = await createFiling(tabitha, { clientId: rosalind.id, taxYear: 2025, returnType: "1040", jurisdiction: "AL", filingType: "AMENDED" });
    const right = await createFiling(tabitha, { clientId: rosalind.id, taxYear: 2025, returnType: "40", jurisdiction: "AL", filingType: "ORIGINAL" });
    for (const f of [wrong, right]) await setFilingStatusByStaff(tabitha, f.id, { status: "ACCEPTED", verificationNote: "Accepted per TaxAct E-file Center", submission: owner });
    const sent = await fileReturnForFiling(tabitha, wrong.id, { bytes: pdf("sent-on-wrong"), originalName: "al.pdf" });
    expect(sent.visibility).toBe("PUBLISHED");
    await expect(removeFiling(daria, wrong.id, "mistake")).rejects.toBeInstanceOf(ForbiddenError);
    await expect(removeFiling(otherAdmin, wrong.id, "mistake")).rejects.toBeInstanceOf(ForbiddenError);
    await expect(moveFilingDocument(otherAdmin, sent.id, right.id)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(moveFilingDocument(daria, sent.id, right.id)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(removeFiling(tabitha, wrong.id, "")).rejects.toThrow(/Say why/);
    await expect(removeFiling(tabitha, wrong.id, "Created by mistake")).rejects.toThrow(/already sent to the client\. Move it to the right filing first/);
    const moved = await moveFilingDocument(tabitha, sent.id, right.id);
    expect([moved.filingId, moved.visibility]).toEqual([right.id, "PUBLISHED"]);
    await removeFiling(tabitha, wrong.id, "Created by mistake — AL is an original return");
    expect(await prisma.filingRecord.count({ where: { id: wrong.id } })).toBe(0);
    const log = await prisma.auditLog.findFirstOrThrow({ where: { action: "filing.removed", entityId: wrong.id } });
    const details = log.details as { reason: string; filing: { returnType: string; filingStatus: string }; statusHistory: { toValue: string }[] };
    expect(details.reason).toBe("Created by mistake — AL is an original return");
    expect([details.filing.returnType, details.filing.filingStatus]).toEqual(["1040", "ACCEPTED"]);
    expect(details.statusHistory.map((e) => e.toValue)).toEqual(["ACCEPTED"]);
    // The moved return is still the client's, under the right filing.
    expect((await loadPortalTaxes(rosalind.id)).filings.flatMap((f) => f.documents.map((d) => d.id))).toEqual([sent.id]);
    // A staff-only draft on a removed filing stays in the client's file (unlinked).
    const g = await createFiling(tabitha, { clientId: rosalind.id, taxYear: 2024, returnType: "1040", jurisdiction: "FEDERAL", filingType: "ORIGINAL" });
    const ack = await staffUploadDocument(daria, { clientId: rosalind.id, category: "TAXES", year: 2024, visibility: "STAFF_ONLY", bytes: pdf("g-ack"), originalName: "g.pdf", notify: false });
    await attachFilingDocument(daria, g.id, ack.id, "OFFICIAL_ACK");
    await expect(removeFiling(otherAdmin, g.id, "Duplicate")).rejects.toBeInstanceOf(ForbiddenError);
    await removeFiling(tabitha, g.id, "Duplicate");
    const kept = await prisma.document.findUniqueOrThrow({ where: { id: ack.id } });
    expect([kept.deletedAt, kept.filingId]).toEqual([null, null]);
  });

  it("(c) Step 2 and fileReturn use the one filing for year + jurisdiction + original/amended when the type differs or is left empty", async () => {
    const { tabitha, daria, rosalind } = await setup();
    const al = await createFiling(tabitha, { clientId: rosalind.id, taxYear: 2025, returnType: "1040", jurisdiction: "AL", filingType: "ORIGINAL" });
    await setFilingStatusByStaff(tabitha, al.id, { status: "ACCEPTED", verificationNote: "Accepted per TaxAct E-file Center", submission: owner });
    // fileReturn: typed 40, the filing says 1040 → that filing.
    const d1 = await fileReturn(daria, { clientId: rosalind.id, taxYear: 2025, returnType: "40", jurisdiction: "AL", filingType: "ORIGINAL", bytes: pdf("typed-40"), originalName: "al.pdf" });
    expect(d1.filingId).toBe(al.id);
    // Step 2 with the state form left empty.
    const r = await deliverAcceptedReturn(daria, { clientId: rosalind.id, taxYear: 2025, filingType: "ORIGINAL", filings: [{ jurisdiction: "AL", returnType: "" }], combinedReturn: { bytes: pdf("empty-type"), originalName: "al2.pdf" } });
    expect(r.results[0]).toMatchObject({ filingId: al.id, returnType: "1040", outcome: "already_accepted" });
    // Two filings for the same state and year: never a guess.
    await createFiling(tabitha, { clientId: rosalind.id, taxYear: 2025, returnType: "40NR", jurisdiction: "AL", filingType: "ORIGINAL" });
    await expect(fileReturn(daria, { clientId: rosalind.id, taxYear: 2025, returnType: "", jurisdiction: "AL", filingType: "ORIGINAL", bytes: pdf("ambiguous"), originalName: "x.pdf" })).rejects.toThrow(/Enter the return type/);
  });
});

