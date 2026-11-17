import { beforeEach, describe, expect, it } from "vitest";
import { makeUser, prisma, resetDb } from "./db";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { createClient } from "@/lib/services/clients";
import { saveProfile } from "@/lib/services/bookkeeping-clients";
import { setupLedger } from "@/lib/services/ledger";
import { registerAccount } from "@/lib/services/bank-accounts";
import { staffUploadDocument } from "@/lib/services/documents";
import { checkAndCorrect, decideHeldDocument, heldDocuments, sweepDocumentOwnership } from "@/lib/services/document-ownership";

// Fictional people, businesses, returns and statements only.
beforeEach(async () => { await resetDb(); });

async function pdf(lines: string[]) {
  const d = await PDFDocument.create(); const f = await d.embedFont(StandardFonts.Helvetica); const p = d.addPage([612, 400]);
  lines.forEach((t, i) => p.drawText(t, { x: 30, y: 370 - i * 16, size: 10, font: f }));
  return d.save();
}

async function world() {
  const tabitha = await makeUser("ADMIN", "Tabitha");
  await prisma.ownerAccess.create({ data: { userId: tabitha.id, isPrimary: true } });
  const staff = await makeUser("STAFF", "Daria");
  const ann = await createClient(tabitha, { firstName: "Annika", lastName: "Gorvale", clientType: "INDIVIDUAL", status: "ACTIVE" });
  const ali = await createClient(tabitha, { firstName: "Alexa", lastName: "Stonebrook", clientType: "INDIVIDUAL", status: "ACTIVE" });
  const cedar = await createClient(tabitha, { businessName: "Cedar Example Shop LLC (fictional)", clientType: "BUSINESS", status: "ACTIVE" });
  const birch = await createClient(tabitha, { businessName: "Birch Example Agency LLC (fictional)", clientType: "BUSINESS", status: "ACTIVE" });
  for (const c of [cedar, birch]) { await saveProfile(tabitha, c.id, { active: true, frequency: "MONTHLY", payroll: false, payrollFrequency: null, payrollProvider: null }); await setupLedger(tabitha, c.id, { basis: "CASH" }); }
  const cedarAcct = await registerAccount(tabitha, cedar.id, { institution: "Prairie Example Farm Bank", accountType: "CHECKING", last4: "4542", gl: "NEW" });
  return { tabitha, staff, ann, ali, cedar, birch, cedarAcct };
}

const ssnOnFile = (tabitha: { id: string }, clientId: string, name: string, last4: string) =>
  prisma.taxReturnSummary.create({ data: { clientId, taxYear: 2025, filingStatus: "SINGLE", taxpayerName: name, taxpayerSsnLast4: last4, figuresHash: "fictional", preparedById: tabitha.id } });

const upload = async (actor: { id: string; role: string }, clientId: string, title: string, lines: string[], visibility: "STAFF_ONLY" | "PUBLISHED" = "STAFF_ONLY", category: "TAXES" | "BOOKKEEPING" | "OTHER" = "TAXES") =>
  staffUploadDocument(actor as never, { clientId, category, title, year: 2025, visibility, bytes: await pdf(lines), originalName: `${title}.pdf`, notify: false });

describe("misfiled documents are corrected automatically, across every section", () => {
  it("a tax return filed under the wrong person moves to its owner, staff-only, with the wrong client's access removed and an audit under both", async () => {
    const w = await world();
    await ssnOnFile(w.tabitha, w.ann.id, "Annika Gorvale", "6789");
    // Staff marked it "publish" under the wrong client: it is corrected during the upload itself, before anyone sees it.
    const doc = await upload(w.staff, w.ali.id, "2025 Form 1040", ["Form 1040 U.S. Individual Income Tax Return 2025", "ANNIKA GORVALE", "Your social security number XXX-XX-6789", "Filing status: Single"], "PUBLISHED");
    expect(doc).toMatchObject({ clientId: w.ann.id, visibility: "STAFF_ONLY" });
    const after = await prisma.document.findUniqueOrThrow({ where: { id: doc.id } });
    expect(after).toMatchObject({ clientId: w.ann.id, visibility: "STAFF_ONLY", needsReview: true, fileId: doc.fileId });
    expect(await prisma.document.count({ where: { clientId: w.ali.id, deletedAt: null } })).toBe(0);
    const logs = await prisma.auditLog.findMany({ where: { action: "document.moved_to_owner", entityId: doc.id } });
    expect(logs.map((l) => l.clientId).sort()).toEqual([w.ali.id, w.ann.id].sort());
    expect(JSON.stringify(logs[0].details)).not.toMatch(/6789/);
  });

  it("when the owner can't be proven (no SSN on file), the tax document is held staff-only and the wrong client loses access; Tabitha's decision moves it", async () => {
    const w = await world();
    const doc = await upload(w.staff, w.ali.id, "2025 return", ["Form 1040 2025", "Annika Gorvale", "SSN XXX-XX-1111"], "PUBLISHED");
    expect(await prisma.document.findUniqueOrThrow({ where: { id: doc.id } })).toMatchObject({ clientId: w.ali.id, visibility: "STAFF_ONLY" });
    const held = await heldDocuments();
    expect(held.map((h) => h.id)).toEqual([doc.id]);
    expect(held[0].hold.candidates.map((c) => c.id)).toEqual([w.ann.id]);
    await decideHeldDocument(w.tabitha as never, doc.id, { moveTo: w.ann.id });
    expect(await prisma.document.findUniqueOrThrow({ where: { id: doc.id } })).toMatchObject({ clientId: w.ann.id, visibility: "STAFF_ONLY" });
    expect(await heldDocuments()).toHaveLength(0);
  });

  it("Keep with this client clears the hold and puts its earlier access back", async () => {
    const w = await world();
    const doc = await upload(w.staff, w.ali.id, "2025 return", ["Form 1040 2025", "Annika Gorvale", "SSN XXX-XX-1111"], "PUBLISHED");
    expect((await prisma.document.findUniqueOrThrow({ where: { id: doc.id } })).visibility).toBe("STAFF_ONLY");
    await decideHeldDocument(w.tabitha as never, doc.id, { moveTo: null });
    expect(await prisma.document.findUniqueOrThrow({ where: { id: doc.id } })).toMatchObject({ clientId: w.ali.id, visibility: "PUBLISHED", ownershipHold: null });
  });

  it("a bank statement with another business's name and account number moves to it and links to that account", async () => {
    const w = await world();
    const doc = await upload(w.staff, w.birch.id, "Bank statement September", ["Prairie Example Farm Bank", "CEDAR EXAMPLE SHOP LLC (FICTIONAL)", "ACCOUNT # XXXXXX4542", "September 1, 2026 through September 30, 2026"], "STAFF_ONLY", "BOOKKEEPING");
    expect(await prisma.document.findUniqueOrThrow({ where: { id: doc.id } })).toMatchObject({ clientId: w.cedar.id, bookkeepingAccountId: w.cedarAcct.id });
  });

  it("no duplicate: when the correct client already has the same file, the misfiled copy goes to Recently deleted", async () => {
    const w = await world();
    const lines = ["Prairie Example Farm Bank", "Cedar Example Shop LLC (fictional)", "Account ending 4542", "October 2026"];
    const bytes = await pdf(lines);
    const keep = await staffUploadDocument(w.staff as never, { clientId: w.cedar.id, category: "BOOKKEEPING", title: "Oct", year: 2026, visibility: "STAFF_ONLY", bytes, originalName: "oct.pdf", notify: false });
    const copy = await staffUploadDocument(w.staff as never, { clientId: w.birch.id, category: "BOOKKEEPING", title: "Oct copy", year: 2026, visibility: "STAFF_ONLY", bytes, originalName: "oct.pdf", notify: false });
    expect(await prisma.document.count({ where: { clientId: w.cedar.id, deletedAt: null } })).toBe(1);
    expect((await prisma.document.findUniqueOrThrow({ where: { id: copy.id } })).deletedAt).not.toBeNull();
    expect((await prisma.document.findUniqueOrThrow({ where: { id: keep.id } })).deletedAt).toBeNull();
  });

  it("documents that name the client they're filed under, or name nobody, are left alone", async () => {
    const w = await world();
    await ssnOnFile(w.tabitha, w.ann.id, "Annika Gorvale", "6789");
    // Alexa's own W-2 from an employer; Annika (another client) is named only as a contact on it.
    const own = await upload(w.staff, w.ali.id, "W-2", ["Form W-2 2025", "Employee: Alexa Stonebrook", "XXX-XX-2222", "Payroll contact: Annika Gorvale"], "PUBLISHED");
    expect(own).toMatchObject({ clientId: w.ali.id, visibility: "PUBLISHED", publishAfterCheck: false });
    const receipt = await upload(w.staff, w.birch.id, "Receipt", ["Office supply store", "Total $84.56"], "STAFF_ONLY", "OTHER");
    expect((await checkAndCorrect(w.tabitha as never, own.id, "test")).verdict).toBe("OWNS");
    expect((await checkAndCorrect(w.tabitha as never, receipt.id, "test")).verdict).toBe("UNKNOWN");
    expect(await prisma.document.count({ where: { clientId: w.ali.id, deletedAt: null } })).toBe(1);
  });

  it("the scheduled sweep checks existing records once and corrects the misfiled ones", async () => {
    const w = await world();
    await ssnOnFile(w.tabitha, w.ann.id, "Annika Gorvale", "6789");
    const misfiled = await upload(w.staff, w.ali.id, "2024 Form 1040", ["Form 1040 2024", "Annika Gorvale", "XXX-XX-6789"]);
    const fine = await upload(w.staff, w.ali.id, "2024 Form 1040 (own)", ["Form 1040 2024", "Alexa Stonebrook", "XXX-XX-2222"]);
    // As if both were filed before this check existed: under Alexa, never checked.
    await prisma.document.updateMany({ where: { id: { in: [misfiled.id, fine.id] } }, data: { clientId: w.ali.id, ownershipCheckedAt: null } });
    const r = await sweepDocumentOwnership({ budgetMs: 20_000 });
    expect(r).toMatchObject({ moved: 1, held: 0 });
    expect((await prisma.document.findUniqueOrThrow({ where: { id: misfiled.id } })).clientId).toBe(w.ann.id);
    expect((await prisma.document.findUniqueOrThrow({ where: { id: fine.id } })).clientId).toBe(w.ali.id);
    expect((await sweepDocumentOwnership({ budgetMs: 20_000 })).checked).toBe(0);
  });
});
