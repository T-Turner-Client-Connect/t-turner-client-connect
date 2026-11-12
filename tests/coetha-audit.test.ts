import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { makeUser, prisma, resetDb } from "./db";
import { createClient } from "@/lib/services/clients";
import { acceptPortalInvite, invitePortalUser } from "@/lib/services/portal-accounts";
import { staffUploadDocument } from "@/lib/services/documents";
import { auditCaseView, openAuditByClient, portalAuditCase, uploadForAudit } from "@/lib/services/audit-center";
import { workAudit } from "@/lib/services/coetha-audit";
import { redact, setAuditReaders, type AuditDoc, type NoticeReadingT } from "@/lib/coetha-audit-model";

// Fictional taxpayers, agencies, identifiers and figures only.
async function pdfOf(text: string) {
  const d = await PDFDocument.create();
  const f = await d.embedFont(StandardFonts.Helvetica);
  d.addPage([612, 792]).drawText(text, { x: 50, y: 700, size: 11, font: f });
  return { bytes: await d.save(), originalName: `${text.slice(0, 30).replace(/\W+/g, "-").toLowerCase()}.pdf` };
}
const textOf = (d: AuditDoc) => (d.kind === "text" ? d.text : "");

const notice = (over: Partial<NoticeReadingT> = {}): NoticeReadingT => ({
  agency: "IRS", stateCode: null, taxYear: 2024, noticeNumber: "Letter 566", auditType: "Correspondence examination", responseDeadline: "2026-12-15",
  respondTo: "Internal Revenue Service\nExamination Unit\nFictional City, ST 00000", instructions: "Send copies, not originals.",
  items: [{ label: "Gifts to charity", form: "Schedule A", line: "12", amountOnNotice: 5000, documentsRequested: "Receipts for each contribution" }],
  unclear: [], ...over,
});

let seen: string[] = [];
beforeEach(async () => {
  await resetDb();
  seen = [];
  vi.stubEnv("MALWARE_SCAN_URL", "https://scanner.test/scan");
  vi.stubEnv("ANTHROPIC_API_KEY", "test-key");
  vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ clean: true }), { status: 200 }));
  await prisma.integrationSettings.upsert({ where: { id: "default" }, create: { id: "default", coethaEnabled: true }, update: { coethaEnabled: true } });
  // Readers that act only on what each document's own text says (the test's stand-in for Claude).
  setAuditReaders({
    notice: async (d) => { seen.push(textOf(d)); return textOf(d).includes("Letter 777") ? notice({ noticeNumber: "Letter 777", items: [{ label: "Home office expenses", form: "Form 8829", line: "36", amountOnNotice: 900, documentsRequested: null }] }) : textOf(d).includes("UNCLEAR") ? notice({ unclear: ["The response date is cut off at the bottom of page 2."], responseDeadline: null }) : notice(); },
    returnAmounts: async (text, items) => { seen.push(text); return { items: items.map((i) => ({ ref: i.ref, amount: /charity/i.test(i.label) ? 5000 : null, where: "Schedule A line 12, page 3", note: null })) }; },
    support: async (d, _y, items) => {
      const t = textOf(d);
      seen.push(t);
      const m = /receipt (\d+) for (\d{4})/i.exec(t);
      if (!m) return { kind: "other", matches: [], taxYearShown: null };
      return { kind: "receipt", taxYearShown: Number(m[2]), matches: [{ ref: items.find((i) => /charity/i.test(i.label))!.ref, amount: Number(m[1]), why: `Receipt shows a $${m[1]} gift.` }] };
    },
  });
});
afterEach(() => {
  setAuditReaders(null);
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

async function world(withReturn = true) {
  const tabitha = await makeUser("ADMIN", "Tabitha");
  await prisma.ownerAccess.create({ data: { userId: tabitha.id, isPrimary: true } });
  const daria = await makeUser("STAFF", "Daria");
  const c = await createClient(tabitha, { firstName: "Pat", lastName: "Fictional", clientType: "INDIVIDUAL", status: "ACTIVE", assignedToId: daria.id });
  const { token } = await invitePortalUser(tabitha, c.id, { email: "pat@fictional.example", name: "Pat", role: "OWNER" });
  const u = await acceptPortalInvite(token!, "Client-Pass-12345");
  const user = { id: u.id, name: u.name, email: u.email };
  if (withReturn) {
    const filing = await prisma.filingRecord.create({ data: { clientId: c.id, taxYear: 2024, returnType: "1040", jurisdiction: "FEDERAL", filingStatus: "ACCEPTED" } });
    const ret = await staffUploadDocument(tabitha, { clientId: c.id, category: "TAXES", year: 2024, docType: "FEDERAL_RETURN", title: "2024 Form 1040 (filed)", visibility: "STAFF_ONLY", ...(await pdfOf("Form 1040 for Pat Fictional SSN 123-45-6789 Schedule A line 12 gifts 5,000")) });
    await prisma.document.update({ where: { id: ret.id }, data: { filingId: filing.id, filingDocType: "RETURN" } });
  }
  const doc = async (text: string, year = 2024) => staffUploadDocument(tabitha, { clientId: c.id, category: "TAXES", year, title: text.slice(0, 40), visibility: "STAFF_ONLY", ...(await pdfOf(text)) });
  return { tabitha, daria, c, user, doc };
}

describe("Coetha prepares the audit", () => {
  it("Schedule A: reads the notice and the filed return, matches documents on file, requests what's missing, then builds the package — identifiers never sent", async () => {
    const w = await world();
    await w.doc("Church receipt 3000 for 2024 from Pat, SSN 123-45-6789");
    await w.doc("Grocery list, nothing to do with taxes");
    await w.doc("Church receipt 800 for 2023 (prior year)", 2023);
    const k = await openAuditByClient(w.user, w.c.id, { kind: "FEDERAL", taxYear: "2024" }, [await pdfOf("IRS Letter 566 fictional notice for SSN 123-45-6789")]);
    await workAudit(k.id);

    let v = (await auditCaseView(k.id))!;
    expect(v).toMatchObject({ noticeReference: "Letter 566", auditType: "Correspondence examination", respondTo: expect.stringContaining("Examination Unit"), responseInstructions: "Send copies, not originals." });
    expect(v.responseDueOn?.toISOString().slice(0, 10)).toBe("2026-12-15");
    expect(v.items.map((i) => [i.label, i.schedule, i.returnLine, i.reportedCents, i.requested])).toEqual([["Gifts to charity", "Schedule A", "12", 500000, "Receipts for each contribution"]]);
    // Only the 2024 receipt counts; the grocery list and the 2023 receipt don't.
    expect(v.items[0].documents.map((d) => [d.amountCents, d.addedBy])).toEqual([[300000, "COETHA"]]);
    expect(v.items[0].check).toEqual({ state: "DIFFERENCE", supportedCents: 300000, differenceCents: 200000 });
    // The rest is requested from the client (once), and the audit waits on documents.
    expect(v.auditStatus).toBe("WAITING_ON_DOCUMENTS");
    const needed = (await portalAuditCase(w.user, w.c.id, k.id)).needed;
    expect(needed).toEqual([expect.objectContaining({ title: "Documents for the remaining $2,000.00 of Gifts to charity" })]);
    // No Social Security number ever left Client Connect.
    expect(seen.length).toBeGreaterThan(3);
    expect(seen.every((t) => !t.includes("123-45-6789"))).toBe(true);
    expect(seen.some((t) => t.includes("[SSN removed]"))).toBe(true);

    // Running again changes nothing (no duplicate requests or links).
    await workAudit(k.id);
    expect(await prisma.documentRequest.count({ where: { auditItem: { caseId: k.id } } })).toBe(1);

    // The client uploads the missing receipt; Coetha matches it, the item is supported, and she builds the package.
    await uploadForAudit(w.user, w.c.id, k.id, needed[0].id, [await pdfOf("Food bank receipt 2000 for 2024")]);
    await workAudit(k.id);
    v = (await auditCaseView(k.id))!;
    expect(v.items[0].check).toEqual({ state: "SUPPORTED", supportedCents: 500000, differenceCents: 0 });
    expect(v.auditStatus).toBe("READY_FOR_FINAL_REVIEW");
    expect(v.package).toMatchObject({ visibility: "STAFF_ONLY" });
    expect(await prisma.documentRequest.findFirstOrThrow({ where: { auditItem: { caseId: k.id } } })).toMatchObject({ status: "ACCEPTED" });
    expect(await prisma.task.count({ where: { title: { startsWith: "Audit package prepared" } } })).toBe(1);
    // Release stays Tabitha's.
    expect((await portalAuditCase(w.user, w.c.id, k.id)).packageReady).toBe(false);
  });

  it("flags an unclear notice and a missing filed return for Tabitha instead of guessing", async () => {
    const w = await world(false);
    const k = await openAuditByClient(w.user, w.c.id, { kind: "FEDERAL", taxYear: "2024" }, [await pdfOf("UNCLEAR fictional notice")]);
    await workAudit(k.id);
    const titles = (await prisma.task.findMany({ where: { assigneeId: w.tabitha.id }, select: { title: true } })).map((t) => t.title);
    expect(titles).toEqual(expect.arrayContaining([expect.stringMatching(/^Coetha flagged the audit notice/), expect.stringMatching(/^Filed return not in Client Connect/)]));
    const v = (await auditCaseView(k.id))!;
    expect(v.responseDueOn).toBeNull();
    expect(v.items[0].reportedCents).toBeNull();
    expect(v.auditStatus).not.toBe("READY_FOR_FINAL_REVIEW");
  });

  it("a later notice about different items is split into its own audit; Coetha off means she does nothing and says so", async () => {
    const w = await world();
    const k = await openAuditByClient(w.user, w.c.id, { kind: "FEDERAL", taxYear: "2024" }, [await pdfOf("IRS Letter 566 fictional")]);
    await workAudit(k.id);
    const again = await openAuditByClient(w.user, w.c.id, { kind: "FEDERAL", taxYear: "2024" }, [await pdfOf("IRS Letter 777 fictional follow-up")]);
    expect(again.id).toBe(k.id);
    await workAudit(k.id);
    const cases = await prisma.noticeCase.findMany({ where: { clientId: w.c.id, auditKind: "FEDERAL", taxYear: 2024 }, include: { items: true }, orderBy: { createdAt: "asc" } });
    expect(cases.length).toBe(2);
    await workAudit(cases[1].id);
    const second = (await auditCaseView(cases[1].id))!;
    expect([second.noticeReference, second.items.map((i) => i.label)]).toEqual(["Letter 777", ["Home office expenses"]]);
    expect(cases[0].items.map((i) => i.label)).toEqual(["Gifts to charity"]);

    await prisma.integrationSettings.update({ where: { id: "default" }, data: { coethaEnabled: false } });
    const before = seen.length;
    const k3 = await openAuditByClient(w.user, w.c.id, { kind: "STATE", stateCode: "AL", taxYear: "2024" }, [await pdfOf("Alabama notice fictional")]);
    expect(await workAudit(k3.id)).toEqual([]);
    expect(seen.length).toBe(before);
    expect(await prisma.task.count({ where: { title: { startsWith: "Coetha isn't preparing this audit" } } })).toBe(1);
  });

  it("redact removes identifiers", () => {
    expect(redact("SSN 123-45-6789, EIN 12-3456789, acct 000123456789012, ITIN 912345678")).toBe("SSN [SSN removed], EIN [EIN removed], acct [account ending 9012], ITIN [ID removed]");
  });
});
