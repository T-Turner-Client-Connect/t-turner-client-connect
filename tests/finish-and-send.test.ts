import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeUser, prisma, resetDb } from "./db";
import { createClient } from "@/lib/services/clients";
import { acceptPortalInvite, invitePortalUser } from "@/lib/services/portal-accounts";
import { confirmPortalIdentity, retrieveFilings, taxYearStatuses } from "@/lib/services/tax-center";
import { attachFilingDocument, createFiling, publishFilingUpdate, setFilingStatusByStaff } from "@/lib/services/tax";
import { staffUploadDocument } from "@/lib/services/documents";
import { loadPortalTaxes } from "@/lib/portal/tax-view";
import { confirmAcceptances, convertToReturnCopy, deliverAcceptedReturn, pendingAcceptances, PRESET_OVERRIDE_REASON } from "@/lib/services/accepted-returns";
import { deliveryFrom, fileIn, summarize } from "@/lib/tax/delivery-form";
import { federalFormFor, stateFormFor } from "@/lib/tax/accepted";
import { federalFirst, portalJurisdictionLabel } from "@/lib/tax/normalize";

/**
 * End to end through the "Finish & Send a Return" form, the way the browser
 * submits it (FormData with files), for a FICTIONAL client: Juniper Ashcombe,
 * an Alabama individual.
 */
const pdf = (tag: string) => new File([new TextEncoder().encode(`%PDF-1.4\n% fictional ${tag}\n`)], `${tag}.pdf`, { type: "application/pdf" });
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
  const daria = await makeUser("STAFF", "Daria");
  const juniper = await createClient(tabitha, { firstName: "Juniper", lastName: "Ashcombe", clientType: "INDIVIDUAL", status: "ACTIVE" });
  await prisma.client.update({ where: { id: juniper.id }, data: { state: "AL" } });
  const { token } = await invitePortalUser(tabitha, juniper.id, { email: "juniper@fictional.example", name: "Juniper Ashcombe", role: "OWNER" });
  const login = await acceptPortalInvite(token!, "Juniper-Pass-12345");
  await confirmPortalIdentity(tabitha, juniper.id, login.id, "In person with photo ID");
  return { tabitha, daria, juniper, login: { id: login.id, name: login.name, email: login.email } };
}

/** The card as submitted: Federal 1040 + AL 40 (the prefilled forms), accepted today, notify by email (default on). */
function cardForm(o: { combined?: File; fedFile?: File; alFile?: File; owner?: boolean; date?: string } = {}) {
  const fd = new FormData();
  const day = o.date ?? "2026-04-15";
  fd.set("taxYear", "2025");
  fd.set("filingType", "ORIGINAL");
  fd.set("fed.on", "on");
  fd.set("fed.returnType", federalFormFor("INDIVIDUAL", null)!);
  fd.set("fed.acceptedOn", day);
  fd.set("fed.submissionId", "FICT-FED-0415");
  fd.set("st.0.on", "on");
  fd.set("st.0.code", "AL");
  fd.set("st.0.returnType", stateFormFor("AL", "INDIVIDUAL", null)!);
  fd.set("st.0.acceptedOn", day);
  fd.set("st.0.submissionId", "FICT-AL-0415");
  if (o.combined) fd.set("file", o.combined);
  if (o.fedFile) fd.set("fed.file", o.fedFile);
  if (o.alFile) fd.set("st.0.file", o.alFile);
  fd.set("verificationNote", "TaxAct");
  fd.set("notifyClient", "on");
  if (o.owner) {
    fd.set("form8879", "on");
    fd.set("overrideReason", PRESET_OVERRIDE_REASON);
  }
  return fd;
}
const submit = async (actor: Parameters<typeof deliverAcceptedReturn>[0], clientId: string, fd: FormData) => {
  const r = await deliverAcceptedReturn(actor, { ...(await deliveryFrom(fd, clientId, await fileIn(fd, "file"))), sendToClient: true });
  return { r, message: summarize(r, 2025) };
};

describe("Finish & Send a Return (end to end, fictional client)", () => {
  it("prefills only verified forms", () => {
    expect([federalFormFor("INDIVIDUAL", null), stateFormFor("AL", "INDIVIDUAL", null), federalFormFor("BUSINESS", "S_CORP"), stateFormFor("AL", "BUSINESS", "S_CORP"), stateFormFor("GA", "INDIVIDUAL", null), federalFormFor("BUSINESS", null)]).toEqual(["1040", "40", "1120-S", "20S", null, null]);
  });

  it("owner, federal + state with ONE combined PDF: one click marks both Accepted, sends to the client and queues the email", async () => {
    const { tabitha, juniper, login } = await setup();
    const { r, message } = await submit(tabitha, juniper.id, cardForm({ combined: pdf("juniper-2025-1040-al40"), owner: true }));
    expect(message).toBe("Sent to client: 2025 1040 Federal + 2025 40 AL.");
    const filings = await prisma.filingRecord.findMany({ where: { clientId: juniper.id }, orderBy: { jurisdiction: "asc" } });
    expect(filings.map((f) => [f.jurisdiction, f.returnType, f.filingStatus, f.visibleToClient, f.filingReference])).toEqual([["AL", "40", "ACCEPTED", true, "FICT-AL-0415"], ["FEDERAL", "1040", "ACCEPTED", true, "FICT-FED-0415"]]);
    const docs = await prisma.document.findMany({ where: { id: { in: r.results.map((x) => x.documentId) } } });
    expect(docs.map((d) => [d.title, d.visibility, d.reviewStatus])).toEqual([["2025 Federal + AL Returns", "PUBLISHED", "APPROVED"], ["2025 Federal + AL Returns", "PUBLISHED", "APPROVED"]]);
    // The client portal: both returns Accepted, the return under each.
    const view = await loadPortalTaxes(juniper.id);
    expect([...view.filings].sort(federalFirst).map((f) => `${portalJurisdictionLabel(f.jurisdiction)} — Form ${f.returnType}: ${f.filingStatus}: ${f.documents.map((d) => d.title).join()}`)).toEqual([
      "Federal (IRS) — Form 1040: ACCEPTED: 2025 Federal + AL Returns",
      "Alabama — Form 40: ACCEPTED: 2025 Federal + AL Returns",
    ]);
    expect((await retrieveFilings(login, juniper.id, 2025)).total).toBe(2);
    const n = await prisma.notification.findMany({ where: { portalUserId: login.id } });
    expect(n.length).toBeGreaterThan(0);
    expect(n.every((x) => x.channel === "EMAIL" && x.kind === "FILING_UPDATE")).toBe(true);
    const [progress] = await taxYearStatuses(juniper.id, [2025]);
    expect(progress.steps.every((s) => s.done)).toBe(true);
    // Running it again changes nothing.
    const again = await submit(tabitha, juniper.id, cardForm({ combined: pdf("juniper-2025-1040-al40"), owner: true }));
    expect(again.r.results.map((x) => x.documentId)).toEqual(r.results.map((x) => x.documentId));
  });

  it("owner, federal + state with SEPARATE PDFs", async () => {
    const { tabitha, juniper } = await setup();
    const { message } = await submit(tabitha, juniper.id, cardForm({ fedFile: pdf("fed-only"), alFile: pdf("al-only"), owner: true }));
    expect(message).toBe("Sent to client: 2025 1040 Federal + 2025 40 AL.");
    const docs = await prisma.document.findMany({ where: { clientId: juniper.id, filingDocType: "RETURN" }, include: { filing: true }, orderBy: { title: "asc" } });
    expect(docs.map((d) => [d.title, d.filing!.jurisdiction, d.visibility])).toEqual([["2025 1040 — Federal", "FEDERAL", "PUBLISHED"], ["2025 40 — AL", "AL", "PUBLISHED"]]);
  });

  it("an already-Accepted filing (earlier date) keeps its status and just gets the return", async () => {
    const { tabitha, juniper } = await setup();
    const f = await createFiling(tabitha, { clientId: juniper.id, taxYear: 2025, returnType: "1040", jurisdiction: "FEDERAL", filingType: "ORIGINAL" });
    await setFilingStatusByStaff(tabitha, f.id, { status: "ACCEPTED", eventAt: new Date("2026-03-01T18:00:00Z"), verificationNote: "TaxAct", submission: { form8879Confirmed: true, overrideReason: PRESET_OVERRIDE_REASON } });
    const { message } = await submit(tabitha, juniper.id, cardForm({ combined: pdf("later"), owner: true, date: "2026-02-01" }));
    expect(message).toBe("Sent to client: 2025 1040 Federal + 2025 40 AL.");
    expect((await prisma.filingRecord.findUniqueOrThrow({ where: { id: f.id } })).acknowledgedAt?.toISOString()).toBe("2026-03-01T18:00:00.000Z");
  });

  it("staff (not the owner): “Mark Accepted & Send to Tabitha for release” — nothing reaches the client until she confirms", async () => {
    const { tabitha, daria, juniper, login } = await setup();
    const { message } = await submit(daria, juniper.id, cardForm({ combined: pdf("staff-combined") }));
    expect(message).toBe("Sent to Tabitha for release: 2025 1040 Federal + 2025 40 AL. Nothing reaches the client until she confirms.");
    expect((await prisma.filingRecord.findMany({ where: { clientId: juniper.id } })).map((f) => f.filingStatus)).toEqual(["NOT_SUBMITTED", "NOT_SUBMITTED"]);
    expect((await retrieveFilings(login, juniper.id, 2025)).total).toBe(0);
    expect(await prisma.notification.count()).toBe(0);
    const queue = await pendingAcceptances(juniper.id);
    await confirmAcceptances(tabitha, queue.map((q) => q.filing.id), { form8879Confirmed: true, overrideReason: PRESET_OVERRIDE_REASON });
    expect((await retrieveFilings(login, juniper.id, 2025)).total).toBe(2);
    // Daria left "Email" ticked: the notice goes out on release.
    expect((await prisma.notification.findMany()).every((x) => x.channel === "EMAIL")).toBe(true);
    expect(await prisma.notification.count()).toBeGreaterThan(0);
  });

  it("the duplicate-acknowledgment trap: the return saved as the acknowledgment and published is converted in place", async () => {
    const { tabitha, juniper, login } = await setup();
    const returnFile = pdf("return-misfiled-as-ack");
    const f = await createFiling(tabitha, { clientId: juniper.id, taxYear: 2025, returnType: "1040", jurisdiction: "FEDERAL", filingType: "ORIGINAL" });
    const ack = await staffUploadDocument(tabitha, { clientId: juniper.id, category: "TAXES", title: "2025 Federal return — acknowledgment", year: 2025, visibility: "STAFF_ONLY", bytes: new Uint8Array(await returnFile.arrayBuffer()), originalName: "r.pdf", notify: false });
    await attachFilingDocument(tabitha, f.id, ack.id, "OFFICIAL_ACK");
    await setFilingStatusByStaff(tabitha, f.id, { status: "ACCEPTED", evidenceDocumentId: ack.id, submission: { form8879Confirmed: true, overrideReason: PRESET_OVERRIDE_REASON } });
    await publishFilingUpdate(tabitha, f.id, "portal_only");
    const fd = cardForm({ owner: true });
    fd.delete("st.0.on");
    fd.set("file", returnFile);
    await expect(submit(tabitha, juniper.id, fd)).rejects.toThrow(/Use this file as the return copy/);
    const converted = await convertToReturnCopy(tabitha, ack.id);
    expect([converted.title, converted.filingDocType, converted.visibility]).toEqual(["2025 Federal return", "RETURN", "PUBLISHED"]);
    expect((await retrieveFilings(login, juniper.id, 2025)).total).toBe(1);
    const { r } = await submit(tabitha, juniper.id, fd);
    expect(r.results[0].documentId).toBe(ack.id);
  });
});
