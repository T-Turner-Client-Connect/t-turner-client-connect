import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { makeUser, prisma, resetDb } from "./db";
import { ForbiddenError } from "@/lib/auth/actor";
import { createClient } from "@/lib/services/clients";
import { acceptPortalInvite, invitePortalUser } from "@/lib/services/portal-accounts";
import { staffUploadDocument } from "@/lib/services/documents";
import {
  addAuditItem, auditCaseView, auditDeadlineAlerts, buildAuditPackage, checkItem, linkAuditDocument, openAuditByClient, openAuditByStaff, portalAuditCase,
  portalAuditPackage, portalAudits, recordAuditSubmission, releaseAuditPackage, requestAuditDocument, setAuditStatus, splitNoticeToNewAudit, staffAuditCase, updateAuditDetails, updateAuditItem, uploadForAudit,
} from "@/lib/services/audit-center";
import { setReturnGate } from "@/lib/services/return-gate";

// Placeholder PDFs here carry no return text; the return upload gate itself is tested in return-gate.test.ts.
beforeEach(() => setReturnGate(async () => "VERIFIED"));
afterEach(() => setReturnGate(null));

// Fictional taxpayers, agencies and figures only.
async function pdfOf(text: string) {
  const d = await PDFDocument.create();
  const f = await d.embedFont(StandardFonts.Helvetica);
  d.addPage([612, 792]).drawText(text, { x: 50, y: 700, size: 12, font: f });
  return { bytes: await d.save(), originalName: `${text.replace(/\W+/g, "-").toLowerCase()}.pdf` };
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

async function world() {
  const tabitha = await makeUser("ADMIN", "Tabitha");
  await prisma.ownerAccess.create({ data: { userId: tabitha.id, isPrimary: true } });
  const daria = await makeUser("STAFF", "Daria");
  const drew = await makeUser("STAFF", "Drew Example");
  const c = await createClient(tabitha, { firstName: "Pat", lastName: "Fictional", clientType: "INDIVIDUAL", status: "ACTIVE", assignedToId: daria.id });
  const other = await createClient(tabitha, { firstName: "Other", lastName: "Taxpayer", clientType: "INDIVIDUAL", status: "ACTIVE" });
  const login = async (clientId: string, email: string, role: "OWNER" | "AUTHORIZED_CONTACT" = "OWNER", permissions?: Record<string, boolean>) => {
    const { token } = await invitePortalUser(tabitha, clientId, { email, name: "Client", role, permissions });
    const u = await acceptPortalInvite(token!, "Client-Pass-12345");
    return { id: u.id, name: u.name, email: u.email };
  };
  const user = await login(c.id, "pat@fictional.example");
  const otherUser = await login(other.id, "other@fictional.example");
  // The filed 2024 federal return, already stored in Client Connect.
  const filing = await prisma.filingRecord.create({ data: { clientId: c.id, taxYear: 2024, returnType: "1040", jurisdiction: "FEDERAL", filingStatus: "ACCEPTED" } });
  const ret = await staffUploadDocument(tabitha, { clientId: c.id, category: "TAXES", year: 2024, docType: "FEDERAL_RETURN", title: "2024 Form 1040 (filed)", visibility: "STAFF_ONLY", ...(await pdfOf("Form 1040 fictional return")) });
  await prisma.document.update({ where: { id: ret.id }, data: { filingId: filing.id, filingDocType: "RETURN" } });
  return { tabitha, daria, drew, c, other, user, otherUser, filing, login };
}

describe("Tax Audit Preparation Center", () => {
  it("a client opens a federal audit with the notice; it finds the filed return, alerts the office and keeps clients apart", async () => {
    const w = await world();
    await expect(openAuditByClient(w.user, w.other.id, { kind: "FEDERAL", taxYear: "2024" }, [await pdfOf("notice")])).rejects.toBeInstanceOf(ForbiddenError);
    await expect(openAuditByClient(w.user, w.c.id, { kind: "STATE", taxYear: "2024" }, [await pdfOf("notice")])).rejects.toThrow(/state/);
    await expect(openAuditByClient(w.user, w.c.id, { kind: "FEDERAL", taxYear: "2024" }, [])).rejects.toThrow(/audit notice/);
    const due = new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10);
    const k = await openAuditByClient(w.user, w.c.id, { kind: "FEDERAL", taxYear: "2024", responseDueOn: due }, [await pdfOf("IRS Letter 566 fictional")]);
    expect(k).toMatchObject({ auditKind: "FEDERAL", agency: "IRS", taxYear: 2024, auditStatus: "NOTICE_RECEIVED", filingId: w.filing.id });
    expect(await prisma.document.count({ where: { noticeCaseId: k.id, docType: "AGENCY_LETTER", year: 2024 } })).toBe(1);
    const tasks = await prisma.task.findMany({ where: { clientId: w.c.id, details: { contains: `[audit:${k.id}:opened]` } } });
    expect(tasks.map((t) => t.assigneeId).sort()).toEqual([w.daria.id, w.tabitha.id].sort());
    // Another taxpayer never sees it; unassigned staff can't open it.
    expect(await portalAudits(w.otherUser, w.other.id)).toEqual([]);
    await expect(portalAuditCase(w.otherUser, w.other.id, k.id)).rejects.toThrow();
    await expect(portalAuditCase(w.otherUser, w.c.id, k.id)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(staffAuditCase(w.drew, k.id)).rejects.toBeInstanceOf(ForbiddenError);
    expect((await staffAuditCase(w.daria, k.id)).filing).toMatchObject({ returnType: "1040", jurisdiction: "FEDERAL" });
  });

  it("Schedule A: reported vs supported from linked documents, missing documents requested and uploaded, never copied, discrepancies shown", async () => {
    const w = await world();
    const k = await openAuditByClient(w.user, w.c.id, { kind: "FEDERAL", taxYear: "2024" }, [await pdfOf("notice")]);
    const item = await addAuditItem(w.daria, k.id, { label: "Schedule A — gifts to charity", schedule: "Schedule A", returnLine: "11", reported: "5,000.00", requested: "Receipts for all contributions" });
    expect((await auditCaseView(k.id))!.auditStatus).toBe("COETHA_REVIEWING");
    // A receipt already on file supports $3,000: linked, not copied.
    const receipt = await staffUploadDocument(w.daria, { clientId: w.c.id, category: "TAXES", year: 2024, title: "Church receipt 2024", visibility: "STAFF_ONLY", ...(await pdfOf("Fictional church receipt 3000")) });
    const before = await prisma.document.count();
    await linkAuditDocument(w.daria, item.id, receipt.id, { amount: "3000" });
    expect(await prisma.document.count()).toBe(before);
    // The rest is missing: requested from the client, who uploads it in the Audit section.
    const req = await requestAuditDocument(w.daria, item.id, { title: "Receipt for the remaining 2024 gifts" });
    expect((await auditCaseView(k.id))!.auditStatus).toBe("WAITING_ON_DOCUMENTS");
    expect((await portalAuditCase(w.user, w.c.id, k.id)).needed).toEqual([expect.objectContaining({ id: req.id, item: "Schedule A — gifts to charity" })]);
    const [up] = await uploadForAudit(w.user, w.c.id, k.id, req.id, [await pdfOf("Fictional food bank receipt 2000")]);
    expect((await auditCaseView(k.id))!.auditStatus).toBe("DOCUMENTS_UNDER_REVIEW");
    await linkAuditDocument(w.daria, item.id, up.id, { amount: "2000" });
    let v = (await auditCaseView(k.id))!;
    expect(v.items[0].check).toEqual({ state: "SUPPORTED", supportedCents: 500000, differenceCents: 0 });
    expect(v.auditStatus).toBe("READY_FOR_FINAL_REVIEW");
    expect(v.totals).toMatchObject({ received: 2, verified: 2, missing: 0 });
    // The return actually reports more than the documents support: the difference is shown and sent to Tabitha.
    await updateAuditItem(w.daria, item.id, { reported: "5500" });
    v = (await auditCaseView(k.id))!;
    expect(v.items[0].check).toEqual({ state: "DIFFERENCE", supportedCents: 500000, differenceCents: 50000 });
    expect(v.auditStatus).toBe("DISCREPANCY");
    const alert = await prisma.task.findFirst({ where: { title: { startsWith: "Audit discrepancy identified" }, details: { contains: "$5,500.00" } } });
    expect(alert).toMatchObject({ assigneeId: w.tabitha.id, priority: "HIGH" });
    expect(alert!.details).toMatch(/reported \$5,500\.00, supported \$5,000\.00, difference \$500\.00/);
  });

  it("checkItem never forces agreement", () => {
    expect(checkItem(100000, [])).toEqual({ state: "MISSING", supportedCents: null, differenceCents: 100000 });
    expect(checkItem(null, [{ amountCents: 5000 }])).toEqual({ state: "NOT_READ", supportedCents: 5000, differenceCents: null });
    expect(checkItem(100000, [{ amountCents: 120000 }])).toEqual({ state: "DIFFERENCE", supportedCents: 120000, differenceCents: -20000 });
    expect(checkItem(100000, [{ amountCents: null }])).toEqual({ state: "DIFFERENCE", supportedCents: null, differenceCents: 100000 });
  });

  it("federal and state audits, business expenses and different tax years stay separate", async () => {
    const w = await world();
    const fed = await openAuditByStaff(w.daria, w.c.id, { kind: "FEDERAL", taxYear: "2023" }, [await pdfOf("IRS notice 2023")]);
    const state = await openAuditByStaff(w.daria, w.c.id, { kind: "STATE", stateCode: "al", taxYear: "2024" }, [await pdfOf("AL notice 2024")]);
    expect([fed.taxYear, fed.filingId, state.stateCode, state.agency]).toEqual([2023, null, "AL", "STATE"]);
    await addAuditItem(w.daria, fed.id, { label: "Schedule C — car and truck expenses", schedule: "Schedule C", returnLine: "9", reported: "8200" });
    await addAuditItem(w.daria, state.id, { label: "Alabama Schedule A — medical expenses", schedule: "Alabama Schedule A", reported: "1200" });
    const mine = await portalAudits(w.user, w.c.id);
    expect(mine.map((a) => [a.kind, a.taxYear, a.stateCode, a.items])).toEqual([
      ["STATE", 2024, "AL", ["Alabama Schedule A — medical expenses"]],
      ["FEDERAL", 2023, null, ["Schedule C — car and truck expenses"]],
    ]);
  });

  it("the package: one PDF built from the records, staff-only until Tabitha releases it; download isn't submission", async () => {
    const w = await world();
    const k = await openAuditByClient(w.user, w.c.id, { kind: "FEDERAL", taxYear: "2024" }, [await pdfOf("notice")]);
    await updateAuditDetails(w.daria, k.id, { noticeReference: "Letter 566", respondTo: "Internal Revenue Service\nExamination Unit\nFictional City, ST 00000", responseInstructions: "Mail copies, not originals.", responseDueOn: "2026-12-15" });
    const item = await addAuditItem(w.daria, k.id, { label: "Schedule A — gifts to charity", schedule: "Schedule A", reported: "1500" });
    const receipt = await staffUploadDocument(w.daria, { clientId: w.c.id, category: "TAXES", year: 2024, title: "Church receipt 2024", visibility: "STAFF_ONLY", ...(await pdfOf("Fictional church receipt 1500")) });
    await linkAuditDocument(w.daria, item.id, receipt.id, { amount: "1500" });
    await updateAuditItem(w.daria, item.id, { explanation: "All gifts were made by check from the taxpayer's account." });

    const built = await buildAuditPackage(w.daria, k.id);
    expect(built.exhibits).toBe(2); // the filed return and the receipt
    const doc = await prisma.document.findUniqueOrThrow({ where: { id: built.documentId }, include: { file: true } });
    expect([doc.visibility, doc.docType, doc.noticeCaseId, doc.version]).toEqual(["STAFF_ONLY", "AUDIT_PACKAGE", k.id, 1]);
    const { readDocumentBytes } = await import("@/lib/services/documents");
    const { extractText, getDocumentProxy } = await import("unpdf");
    const text = (await extractText(await getDocumentProxy(new Uint8Array((await readDocumentBytes(doc.file))!)), { mergePages: true })).text as string;
    for (const s of ["Letter 566", "Audit Document Index", "Exhibit 1", "Exhibit 2", "Reconciliation Summary", "Reported on the return: $1,500.00", "Supported by documents: $1,500.00", "Additional Explanations", "Mail copies, not originals.", "Respond by"]) expect(text).toContain(s);
    expect((await auditCaseView(k.id))!.auditStatus).toBe("READY_FOR_FINAL_REVIEW");

    // Not visible to the client before release; only Tabitha releases.
    expect((await portalAuditCase(w.user, w.c.id, k.id)).packageReady).toBe(false);
    await expect(portalAuditPackage(w.user, w.c.id, k.id, "view")).rejects.toThrow(/isn't ready/);
    await expect(releaseAuditPackage(w.daria, k.id)).rejects.toBeInstanceOf(ForbiddenError);
    await releaseAuditPackage(w.tabitha, k.id);
    const p = await portalAuditCase(w.user, w.c.id, k.id);
    expect(p).toMatchObject({ packageReady: true, status: "PACKAGE_READY", respondTo: expect.stringContaining("Examination Unit") });
    const dl = await portalAuditPackage(w.user, w.c.id, k.id, "download");
    expect(dl.bytes.length).toBeGreaterThan(1000);
    await expect(portalAuditPackage(w.otherUser, w.other.id, k.id, "download")).rejects.toThrow();
    expect(await prisma.auditLog.count({ where: { action: "audit.package_downloaded", entityId: k.id } })).toBe(1);
    expect(await prisma.task.count({ where: { title: { startsWith: "Client downloaded the audit package" } } })).toBe(1);
    expect((await auditCaseView(k.id))!.auditStatus).toBe("PACKAGE_READY"); // downloading is not submitting

    // The client records the submission with proof.
    await recordAuditSubmission(w.user, w.c.id, k.id, { submittedOn: "2026-11-20", method: "Certified mail" }, [await pdfOf("Fictional certified mail receipt")]);
    const done = (await auditCaseView(k.id))!;
    expect([done.auditStatus, done.submissionMethod]).toEqual(["SUBMITTED", "Certified mail"]);
    expect(done.documents.some((d) => d.title.startsWith("Audit response — proof of submission"))).toBe(true);

    // A rebuilt package replaces the old version and waits for release again.
    await buildAuditPackage(w.daria, k.id);
    expect(await prisma.document.count({ where: { noticeCaseId: k.id, docType: "AUDIT_PACKAGE", supersededAt: null } })).toBe(1);
  });

  it("deadline alerts once at 14 and 7 days, and when passed", async () => {
    const w = await world();
    const k = await openAuditByStaff(w.daria, w.c.id, { kind: "FEDERAL", taxYear: "2024", responseDueOn: "2026-12-01" }, []);
    expect((await auditDeadlineAlerts(new Date("2026-11-10T12:00:00Z"))).alerted).toBe(0);
    await auditDeadlineAlerts(new Date("2026-11-20T12:00:00Z"));
    await auditDeadlineAlerts(new Date("2026-11-21T12:00:00Z"));
    await auditDeadlineAlerts(new Date("2026-11-26T12:00:00Z"));
    await auditDeadlineAlerts(new Date("2026-12-03T12:00:00Z"));
    const titles = (await prisma.task.findMany({ where: { details: { contains: `[audit:${k.id}:deadline` } }, select: { title: true } })).map((t) => t.title);
    expect(titles.filter((t) => t.startsWith("Audit response due in")).length).toBe(4); // 14-day and 7-day, to Tabitha and Daria
    expect(titles.filter((t) => t.startsWith("Audit response deadline passed")).length).toBe(2);
  });

  it("another notice for the same agency and year joins the open audit (no duplicate case or request); a separate examination can be split off", async () => {
    const w = await world();
    const k = await openAuditByClient(w.user, w.c.id, { kind: "FEDERAL", taxYear: "2024" }, [await pdfOf("IRS Letter 566 fictional")]);
    const item = await addAuditItem(w.daria, k.id, { label: "Schedule A — gifts to charity", reported: "100" });
    const r1 = await requestAuditDocument(w.daria, item.id, { title: "Church receipt" });
    const r2 = await requestAuditDocument(w.daria, item.id, { title: "Church receipt" });
    expect(r2.id).toBe(r1.id);
    const again = await openAuditByClient(w.user, w.c.id, { kind: "FEDERAL", taxYear: "2024" }, [await pdfOf("IRS follow-up letter fictional")]);
    expect(again.id).toBe(k.id);
    expect(await prisma.noticeCase.count({ where: { clientId: w.c.id, auditKind: "FEDERAL", taxYear: 2024 } })).toBe(1);
    const extra = await prisma.document.findFirstOrThrow({ where: { noticeCaseId: k.id, title: { startsWith: "Additional notice" } } });
    expect(await prisma.task.count({ where: { title: { startsWith: "Additional audit notice received" } } })).toBe(2);
    // A different agency or year is its own audit: the state audit and the 2023 audit.
    const st = await openAuditByClient(w.user, w.c.id, { kind: "STATE", stateCode: "AL", taxYear: "2024" }, [await pdfOf("AL notice")]);
    const y23 = await openAuditByClient(w.user, w.c.id, { kind: "FEDERAL", taxYear: "2023" }, [await pdfOf("IRS 2023 notice")]);
    expect(new Set([k.id, st.id, y23.id]).size).toBe(3);
    // The follow-up turns out to be a separate examination: moved (not copied) to its own audit.
    const docs = await prisma.document.count();
    const sep = await splitNoticeToNewAudit(w.daria, extra.id, "Different notice number (fictional)");
    expect(await prisma.document.count()).toBe(docs);
    expect((await prisma.document.findUniqueOrThrow({ where: { id: extra.id } })).noticeCaseId).toBe(sep.id);
    expect(await prisma.noticeCase.count({ where: { clientId: w.c.id, auditKind: "FEDERAL", taxYear: 2024 } })).toBe(2);
  });

  it("authorized users of the same account see the audit; a login without tax access doesn't", async () => {
    const w = await world();
    const k = await openAuditByClient(w.user, w.c.id, { kind: "FEDERAL", taxYear: "2024" }, [await pdfOf("notice")]);
    const spouse = await w.login(w.c.id, "spouse@fictional.example", "AUTHORIZED_CONTACT", { canViewTax: true, canUpload: true });
    const helper = await w.login(w.c.id, "helper@fictional.example", "AUTHORIZED_CONTACT", { canViewTax: false });
    expect((await portalAuditCase(spouse, w.c.id, k.id)).id).toBe(k.id);
    await expect(portalAuditCase(helper, w.c.id, k.id)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(portalAudits(helper, w.c.id)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("an incomplete audit is marked Not Fully Ready, can't be released without Tabitha accepting that, and closes only with a resolution", async () => {
    const w = await world();
    const k = await openAuditByClient(w.user, w.c.id, { kind: "FEDERAL", taxYear: "2024" }, [await pdfOf("notice")]);
    const item = await addAuditItem(w.daria, k.id, { label: "Schedule C — supplies", schedule: "Schedule C", reported: "4000" });
    await requestAuditDocument(w.daria, item.id, { title: "Supply receipts" });
    const built = await buildAuditPackage(w.daria, k.id);
    const doc = await prisma.document.findUniqueOrThrow({ where: { id: built.documentId }, include: { file: true } });
    const { readDocumentBytes } = await import("@/lib/services/documents");
    const { extractText, getDocumentProxy } = await import("unpdf");
    const text = (await extractText(await getDocumentProxy(new Uint8Array((await readDocumentBytes(doc.file))!)), { mergePages: true })).text as string;
    expect(text).toContain("Not Fully Ready");
    expect(text).toContain("waiting for the client");
    await expect(releaseAuditPackage(w.tabitha, k.id)).rejects.toThrow(/isn't fully ready/);
    await releaseAuditPackage(w.tabitha, k.id, { acknowledgeOpenItems: true });
    expect((await prisma.auditLog.findFirstOrThrow({ where: { action: "audit.package_released", entityId: k.id } })).details).toMatchObject({ openItems: expect.arrayContaining([expect.stringContaining("Supply receipts")]) });
    // A revised package after release keeps the old version and needs a new release.
    const r2 = await buildAuditPackage(w.daria, (await addAuditItem(w.daria, k.id, { label: "Schedule C — utilities", reported: "900" }), k.id));
    expect(r2.documentId).not.toBe(built.documentId);
    expect((await prisma.document.findUniqueOrThrow({ where: { id: built.documentId } })).supersededAt).not.toBeNull();
    expect((await portalAuditCase(w.user, w.c.id, k.id)).packageReady).toBe(false);
    await expect(setAuditStatus(w.daria, k.id, "CLOSED")).rejects.toThrow(/resolution/);
    await setAuditStatus(w.daria, k.id, "CLOSED", "No change letter received (fictional).");
    const v = (await staffAuditCase(w.daria, k.id));
    expect([v.auditStatus, v.resolution]).toEqual(["CLOSED", "No change letter received (fictional)."]);
    expect(v.versions.map((x) => x.version)).toEqual([2, 1]);
    expect(v.activity.map((e) => e.what)).toEqual(expect.arrayContaining(["Client opened the audit and uploaded the notice", "Audit package built", "Audit package released to the client", "Missing document requested from the client"]));
  });
});
