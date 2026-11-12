import { beforeEach, describe, expect, it, vi } from "vitest";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { makeUser, prisma, resetDb } from "./db";
import { createClient } from "@/lib/services/clients";
import { staffUploadDocument } from "@/lib/services/documents";
import { deliverAcceptedReturn, PRESET_OVERRIDE_REASON } from "@/lib/services/accepted-returns";
import { bulkUploadReturns, confirmIntake } from "@/lib/services/tax-returns";
import { discardHeldReturn, heldReturns, purgeExpiredHolds, verifyHeldReturn } from "@/lib/services/return-gate";
import { encryptSecret } from "@/lib/crypto";

// Fictional taxpayers, businesses, identifiers and returns only.
async function pdf(lines: string[]) {
  const d = await PDFDocument.create();
  const f = await d.embedFont(StandardFonts.Helvetica);
  const p = d.addPage([612, 792]);
  let y = 760;
  for (const l of lines) {
    p.drawText(l, { x: 40, y, size: 10, font: f });
    y -= 14;
  }
  return d.save();
}
const f1040 = (year: number, first: string, last: string, spouse?: [string, string]) => pdf([
  `Form 1040 ${year} U.S. Individual Income Tax Return`,
  `For the year Jan. 1-Dec. 31, ${year}, or other tax year beginning`,
  "Your first name and middle initial    Last name    Your social security number",
  `${first} Q    ${last}    000-00-0001`,
  "If joint return, spouse's first name and middle initial    Last name    Spouse's social security number",
  spouse ? `${spouse[0]}    ${spouse[1]}    000-00-0002` : "",
  "Filing Status  [X] Married filing jointly",
  "1a Total amount from Form(s) W-2, box 1    52,000",
]);
const f1040x = (year: number, first: string, last: string) => pdf([
  "Form 1040-X (Rev. December 2025) Amended U.S. Individual Income Tax Return",
  `This return is for calendar year ${year}`,
  "Your first name and middle initial    Last name    Your social security number",
  `${first}    ${last}    000-00-0001`,
]);
const al40 = (year: number, first: string, last: string) => pdf([
  `${year} Alabama Form 40 Individual Income Tax Return`,
  "Your first name and initial    Last name    Your social security number",
  `${first}    ${last}    000-00-0001`,
]);
const biz = (form: string, title: string, year: number, name: string, ein: string) => pdf([
  `Form ${form} ${title} ${year}`,
  `For calendar year ${year} or tax year beginning`,
  `Name ${name}`,
  `Employer identification number ${ein}`,
]);
const file = async (bytes: Uint8Array | Promise<Uint8Array>, name = "return.pdf") => ({ bytes: await bytes, originalName: name });
const SCAN = new TextEncoder().encode("%PDF-1.4\n% fictional scanned return, no text layer\n");

async function setup() {
  const tabitha = await makeUser("ADMIN", "Tabitha");
  await prisma.ownerAccess.create({ data: { userId: tabitha.id, isPrimary: true } });
  const daria = await makeUser("STAFF", "Daria");
  const mary = await createClient(tabitha, { firstName: "Mary", lastName: "Johnson", clientType: "INDIVIDUAL", status: "ACTIVE", assignedToId: daria.id, state: "AL" });
  await prisma.client.update({ where: { id: mary.id }, data: { spouseFirstName: "Robert", spouseLastName: "Johnson" } });
  const sarah = await createClient(tabitha, { firstName: "Sarah", lastName: "Williams", clientType: "INDIVIDUAL", status: "ACTIVE" });
  const acme = await createClient(tabitha, { businessName: "Fictional Widgets LLC", clientType: "BUSINESS", status: "ACTIVE" });
  await prisma.bookkeepingProfile.create({ data: { clientId: acme.id, einEncrypted: encryptSecret("12-3456789"), einLast4: "6789" } });
  const estate = await createClient(tabitha, { businessName: "Estate of Pat Example", clientType: "BUSINESS", status: "ACTIVE" });
  await prisma.bookkeepingProfile.create({ data: { clientId: estate.id, einEncrypted: encryptSecret("98-7654321"), einLast4: "4321" } });
  return { tabitha, daria, mary, sarah, acme, estate };
}
const upload = (actor: { id: string; role: string; name: string; email: string }, clientId: string, year: number, docType: string, f: { bytes: Uint8Array; originalName: string }) =>
  staffUploadDocument(actor as never, { clientId, category: "TAXES", docType, year, visibility: "STAFF_ONLY", ...f });
const deliver = (actor: Parameters<typeof deliverAcceptedReturn>[0], clientId: string, taxYear: number, filings: { jurisdiction: string; returnType: string }[], combined: { bytes: Uint8Array; originalName: string }, filingType: "ORIGINAL" | "AMENDED" = "ORIGINAL") =>
  deliverAcceptedReturn(actor, { clientId, taxYear, filingType, filings: filings.map((x) => ({ ...x, acceptedOn: `${taxYear + 1}-03-01` })), combinedReturn: combined, verificationNote: "IRS e-file acknowledgment checked", owner: { form8879Confirmed: true, overrideReason: PRESET_OVERRIDE_REASON } });
const docs = (clientId: string) => prisma.document.count({ where: { clientId } });

beforeEach(async () => {
  await resetDb();
  vi.restoreAllMocks();
});

describe("Tax return upload verification", () => {
  it("accepts the right client and year; rejects the wrong year or the wrong taxpayer with nothing saved", async () => {
    const s = await setup();
    // Example 3 — correct.
    const ok = await upload(s.tabitha, s.mary.id, 2025, "FEDERAL_RETURN", await file(f1040(2025, "Mary", "Johnson")));
    expect(ok).toMatchObject({ clientId: s.mary.id, year: 2025 });
    // Example 1 — wrong year.
    await expect(upload(s.tabitha, s.mary.id, 2025, "FEDERAL_RETURN", await file(f1040(2024, "Mary", "Johnson")))).rejects.toThrow("Upload Rejected — This document is for tax year 2024, but you selected 2025. Please select the correct year or upload the correct return.");
    // Example 2 — wrong client.
    await expect(upload(s.tabitha, s.mary.id, 2025, "FEDERAL_RETURN", await file(f1040(2025, "Sarah", "Williams")))).rejects.toThrow("Upload Rejected — The taxpayer name on this return does not match the selected client. Please verify the client and upload the correct document.");
    // The file name never decides anything.
    await expect(upload(s.tabitha, s.mary.id, 2025, "FEDERAL_RETURN", await file(f1040(2025, "Sarah", "Williams"), "Mary Johnson 2025 1040.pdf"))).rejects.toThrow(/does not match the selected client/);
    expect(await docs(s.mary.id)).toBe(1);
    expect(await prisma.returnUploadHold.count()).toBe(0);
    expect(await prisma.auditLog.count({ where: { action: "tax.return_upload_rejected" } })).toBe(3);
  });

  it("joint returns: the spouse must be the spouse on file; the client may be listed second", async () => {
    const s = await setup();
    await upload(s.tabitha, s.mary.id, 2025, "FEDERAL_RETURN", await file(f1040(2025, "Mary", "Johnson", ["Robert", "Johnson"])));
    await upload(s.tabitha, s.mary.id, 2025, "FEDERAL_RETURN", await file(f1040(2025, "Robert", "Johnson", ["Mary", "Johnson"]), "b.pdf"));
    await expect(upload(s.tabitha, s.mary.id, 2025, "FEDERAL_RETURN", await file(f1040(2025, "Mary", "Johnson", ["Victor", "Stone"]), "c.pdf"))).rejects.toThrow(/spouse named on this joint return does not match/);
  });

  it("Finish & Send checks each return before anything is recorded; original vs amended and state returns are checked", async () => {
    const s = await setup();
    await expect(deliver(s.tabitha, s.mary.id, 2025, [{ jurisdiction: "FEDERAL", returnType: "1040" }], await file(f1040(2024, "Mary", "Johnson")))).rejects.toThrow(/tax year 2024, but you selected 2025/);
    await expect(deliver(s.tabitha, s.mary.id, 2025, [{ jurisdiction: "FEDERAL", returnType: "1040" }], await file(f1040(2025, "Sarah", "Williams")))).rejects.toThrow(/does not match the selected client/);
    expect([await prisma.filingRecord.count(), await docs(s.mary.id)]).toEqual([0, 0]);
    // An amended return selected as original, and the reverse.
    await expect(deliver(s.tabitha, s.mary.id, 2024, [{ jurisdiction: "FEDERAL", returnType: "1040" }], await file(f1040x(2024, "Mary", "Johnson")))).rejects.toThrow(/Form 1040-X \(amended\), but you selected an original return/);
    await expect(deliver(s.tabitha, s.mary.id, 2024, [{ jurisdiction: "FEDERAL", returnType: "1040-X" }], await file(f1040(2024, "Mary", "Johnson")), "AMENDED")).rejects.toThrow(/Form 1040 \(original\), but you selected an amended return/);
    const amended = await deliver(s.tabitha, s.mary.id, 2024, [{ jurisdiction: "FEDERAL", returnType: "1040-X" }], await file(f1040x(2024, "Mary", "Johnson")), "AMENDED");
    expect(amended.results[0].outcome).toBe("accepted");
    // State: an Alabama return for AL; a federal return can't be filed as the state return.
    await expect(deliver(s.tabitha, s.mary.id, 2025, [{ jurisdiction: "AL", returnType: "40" }], await file(f1040(2025, "Mary", "Johnson")))).rejects.toThrow(/federal Form 1040, but you selected a Alabama state return/);
    const al = await deliver(s.tabitha, s.mary.id, 2025, [{ jurisdiction: "AL", returnType: "40" }], await file(al40(2025, "Mary", "Johnson")));
    expect(al.results[0].outcome).toBe("accepted");
    // A prior year (2020) works the same way.
    await expect(deliver(s.tabitha, s.mary.id, 2020, [{ jurisdiction: "FEDERAL", returnType: "1040" }], await file(f1040(2021, "Mary", "Johnson")))).rejects.toThrow(/tax year 2021, but you selected 2020/);
  });

  it("business, estate and trust returns: the EIN and name are verified; the wrong form is rejected", async () => {
    const s = await setup();
    const s1120 = (ein: string, name = "Fictional Widgets LLC", year = 2025) => file(biz("1120-S", "U.S. Income Tax Return for an S Corporation", year, name, ein));
    await deliver(s.tabitha, s.acme.id, 2025, [{ jurisdiction: "FEDERAL", returnType: "1120-S" }], await s1120("12-3456789"));
    await expect(deliver(s.tabitha, s.acme.id, 2025, [{ jurisdiction: "FEDERAL", returnType: "1120-S" }], await s1120("55-5555555"))).rejects.toThrow(/EIN on this return does not match/);
    await expect(deliver(s.tabitha, s.acme.id, 2025, [{ jurisdiction: "FEDERAL", returnType: "1120-S" }], await s1120("55-5555555", "Other Fictional Co"))).rejects.toThrow(/does not match/);
    await expect(deliver(s.tabitha, s.acme.id, 2025, [{ jurisdiction: "FEDERAL", returnType: "1120-S" }], await file(biz("1065", "U.S. Return of Partnership Income", 2025, "Fictional Widgets LLC", "12-3456789")))).rejects.toThrow(/Form 1065, but you selected Form 1120-S/);
    await expect(deliver(s.tabitha, s.acme.id, 2025, [{ jurisdiction: "FEDERAL", returnType: "1120" }], await file(biz("1120", "U.S. Corporation Income Tax Return", 2024, "Fictional Widgets LLC", "12-3456789")))).rejects.toThrow(/tax year 2024, but you selected 2025/);
    // Form 1041 — estate or trust.
    const r = await deliver(s.tabitha, s.estate.id, 2025, [{ jurisdiction: "FEDERAL", returnType: "1041" }], await file(biz("1041", "U.S. Income Tax Return for Estates and Trusts", 2025, "Estate of Pat Example", "98-7654321")));
    expect(r.results[0].outcome).toBe("accepted");
    await expect(deliver(s.tabitha, s.estate.id, 2025, [{ jurisdiction: "FEDERAL", returnType: "1041" }], await file(f1040(2025, "Pat", "Example")))).rejects.toThrow(/Form 1040, but you selected Form 1041/);
  });

  it("an unreadable scan is held outside the client's records; only Tabitha or an Admin can verify it, and only as this client and year", async () => {
    const s = await setup();
    await expect(upload(s.tabitha, s.mary.id, 2022, "FEDERAL_RETURN", { bytes: SCAN, originalName: "scan.pdf" })).rejects.toThrow(/Upload Not Accepted — We could not verify the taxpayer name and tax year\. Please upload a clearer copy\./);
    expect(await docs(s.mary.id)).toBe(0);
    const [h] = await heldReturns(s.mary.id);
    expect(h).toMatchObject({ taxYear: 2022, status: "PENDING" });
    // Staff without review rights can't verify; a reviewer can't verify a different person or year.
    await expect(verifyHeldReturn(s.daria, h.id, { year: 2022, first: "Mary", last: "Johnson", note: "Looked at the return" })).rejects.toThrow(/Only Tabitha or an Admin/);
    await expect(verifyHeldReturn(s.tabitha, h.id, { year: 2021, first: "Mary", last: "Johnson", note: "Looked at the return" })).rejects.toThrow(/tax year 2021, but you selected 2022/);
    await expect(verifyHeldReturn(s.tabitha, h.id, { year: 2022, first: "Sarah", last: "Williams", nameChange: true, note: "Looked at the return" })).rejects.toThrow(/does not match the selected client/);
    await verifyHeldReturn(s.tabitha, h.id, { year: 2022, first: "Mary", last: "Johnson", note: "Name, SSN last 4 and year checked against the record" });
    // The same file is now accepted for this client and year — and only there.
    await expect(upload(s.tabitha, s.sarah.id, 2022, "FEDERAL_RETURN", { bytes: SCAN, originalName: "scan.pdf" })).rejects.toThrow(/Upload Not Accepted/);
    const doc = await upload(s.tabitha, s.mary.id, 2022, "FEDERAL_RETURN", { bytes: SCAN, originalName: "scan.pdf" });
    expect(doc.clientId).toBe(s.mary.id);
  });

  it("a legitimate name change is held, confirmed by a reviewer, and remembered", async () => {
    const s = await setup();
    await expect(upload(s.tabitha, s.mary.id, 2025, "FEDERAL_RETURN", await file(f1040(2025, "Mary", "Smith")))).rejects.toThrow(/held for verification/);
    const [h] = await heldReturns(s.mary.id);
    await expect(verifyHeldReturn(s.tabitha, h.id, { year: 2025, first: "Mary", last: "Smith", note: "Marriage certificate on file" })).rejects.toThrow(/does not match/);
    await verifyHeldReturn(s.tabitha, h.id, { year: 2025, first: "Mary", last: "Smith", nameChange: true, note: "Legal name change, marriage certificate on file" });
    expect(await prisma.clientNameAlias.count({ where: { clientId: s.mary.id } })).toBe(1);
    // A different return printed under the confirmed name now passes on its own.
    await upload(s.tabitha, s.mary.id, 2024, "FEDERAL_RETURN", await file(f1040(2024, "Mary", "Smith")));
  });

  it("bulk upload: each queued return is checked when it is filed; a mismatch stays out of the client's file", async () => {
    const s = await setup();
    const [a] = await bulkUploadReturns(s.tabitha, [await file(f1040(2025, "Sarah", "Williams"), "mary-johnson-2025.pdf")]);
    await prisma.filingRecord.create({ data: { clientId: s.mary.id, taxYear: 2025, returnType: "1040", jurisdiction: "FEDERAL", filingStatus: "ACCEPTED" } });
    await expect(confirmIntake(s.tabitha, a.intakeId!, { clientId: s.mary.id, taxYear: 2025, returnType: "1040", jurisdiction: "FEDERAL", filingType: "ORIGINAL" })).rejects.toThrow(/does not match the selected client/);
    expect(await docs(s.mary.id)).toBe(0);
    expect((await prisma.returnIntake.findUniqueOrThrow({ where: { id: a.intakeId! } })).status).toBe("PENDING");
  });

  it("held files expire and are removed; a removed hold can't be verified", async () => {
    const s = await setup();
    await expect(upload(s.tabitha, s.mary.id, 2023, "FEDERAL_RETURN", { bytes: SCAN, originalName: "a.pdf" })).rejects.toThrow();
    const [h] = await heldReturns(s.mary.id);
    await discardHeldReturn(s.tabitha, h.id, "Wrong file");
    await expect(verifyHeldReturn(s.tabitha, h.id, { year: 2023, first: "Mary", last: "Johnson", note: "Looked at the return" })).rejects.toThrow(/no longer waiting/);
    await expect(upload(s.tabitha, s.mary.id, 2021, "FEDERAL_RETURN", { bytes: SCAN, originalName: "b.pdf" })).rejects.toThrow();
    expect(await purgeExpiredHolds(new Date(Date.now() + 8 * 86_400_000))).toBe(1);
    expect(await heldReturns(s.mary.id)).toEqual([]);
  });
});

describe("Real-world return layouts and the one-step confirmation", () => {
  // A fillable return whose name is typed into form fields (not in the page text).
  async function fillable(year: number, first: string, last: string) {
    const d = await PDFDocument.create();
    const f = await d.embedFont(StandardFonts.Helvetica);
    const p = d.addPage([612, 792]);
    let y = 760;
    for (const l of [`Form 1040 U.S. Individual Income Tax Return ${year}`, `For the year Jan. 1-Dec. 31, ${year}, or other tax year beginning`, "Your first name and middle initial    Last name    Your social security number", "Filing Status"]) {
      p.drawText(l, { x: 40, y, size: 10, font: f });
      y -= 14;
    }
    const form = d.getForm();
    const fn = form.createTextField("topmostSubform[0].Page1[0].f1_04[0]");
    fn.setText(first);
    fn.addToPage(p, { x: 40, y: 600, width: 150, height: 14 });
    const ln = form.createTextField("topmostSubform[0].Page1[0].f1_05[0]");
    ln.setText(last);
    ln.addToPage(p, { x: 200, y: 600, width: 150, height: 14 });
    return d.save();
  }

  it("reads a name typed into the return's form fields", async () => {
    const s = await setup();
    await upload(s.tabitha, s.mary.id, 2023, "FEDERAL_RETURN", await file(fillable(2023, "Mary", "Johnson")));
    expect(await docs(s.mary.id)).toBe(1);
  });

  it("finds the form title and year further down the page (boilerplate printed first)", async () => {
    const s = await setup();
    const boiler = Array.from({ length: 30 }, (_, i) => `Department of the Treasury Internal Revenue Service OMB No. 1545-0074 IRS Use Only line ${i}`);
    await upload(s.tabitha, s.mary.id, 2022, "FEDERAL_RETURN", await file(pdf([...boiler, "Form 1040 U.S. Individual Income Tax Return", "For the year Jan. 1-Dec. 31, 2022, or other tax year beginning", "Your first name and middle initial    Last name", "Mary    Johnson"])));
    expect(await docs(s.mary.id)).toBe(1);
  });

  it("a return whose name can't be read is held (uncertain), never rejected as another taxpayer", async () => {
    const s = await setup();
    await expect(upload(s.daria, s.mary.id, 2024, "FEDERAL_RETURN", await file(pdf(["Form 1040 2024 U.S. Individual Income Tax Return", "For the year Jan. 1-Dec. 31, 2024", "Your first name and middle initial    Last name"])))).rejects.toThrow(/name couldn't be read.*Tabitha or an Admin can confirm/);
    expect(await prisma.returnUploadHold.count({ where: { clientId: s.mary.id } })).toBe(1);
  });

  it("Tabitha or an Admin confirms an unreadable scan in the same upload; staff can't; a mismatch is still refused", async () => {
    const s = await setup();
    // Staff: the note is ignored and the scan is held.
    await expect(staffUploadDocument(s.daria, { clientId: s.mary.id, category: "TAXES", docType: "FEDERAL_RETURN", year: 2023, visibility: "STAFF_ONLY", returnConfirmation: "Opened the PDF: Mary Johnson, 2023 Form 1040", ...(await file(SCAN, "scan.pdf")) })).rejects.toThrow(/Tabitha or an Admin can confirm/);
    expect(await docs(s.mary.id)).toBe(0);
    // Too short a note.
    await expect(staffUploadDocument(s.tabitha, { clientId: s.mary.id, category: "TAXES", docType: "FEDERAL_RETURN", year: 2023, visibility: "STAFF_ONLY", returnConfirmation: "ok", ...(await file(SCAN, "scan.pdf")) })).rejects.toThrow(/Say how you confirmed/);
    // Tabitha: saved at once, with a recorded verification and audit entry.
    await staffUploadDocument(s.tabitha, { clientId: s.mary.id, category: "TAXES", docType: "FEDERAL_RETURN", year: 2023, visibility: "STAFF_ONLY", returnConfirmation: "Opened the PDF: Mary Johnson, 2023 Form 1040", ...(await file(SCAN, "scan.pdf")) });
    expect(await docs(s.mary.id)).toBe(1);
    expect(await prisma.returnVerification.count({ where: { clientId: s.mary.id, taxYear: 2023 } })).toBe(1);
    expect(await prisma.auditLog.count({ where: { action: "tax.return_upload_confirmed", clientId: s.mary.id } })).toBe(1);
    // Finish & Send takes the same note.
    await deliverAcceptedReturn(s.tabitha, { clientId: s.mary.id, taxYear: 2022, filingType: "ORIGINAL", filings: [{ jurisdiction: "FEDERAL", returnType: "1040", acceptedOn: "2023-03-01" }], combinedReturn: await file(new TextEncoder().encode("%PDF-1.4\n% another fictional scan 2022\n"), "2022.pdf"), verificationNote: "IRS e-file acknowledgment checked", owner: { form8879Confirmed: true, overrideReason: PRESET_OVERRIDE_REASON }, returnConfirmation: "Opened the PDF: Mary Johnson, 2022 Form 1040" });
    expect(await prisma.returnVerification.count({ where: { clientId: s.mary.id, taxYear: 2022 } })).toBe(1);
    // A positive mismatch can't be confirmed past.
    await expect(staffUploadDocument(s.tabitha, { clientId: s.mary.id, category: "TAXES", docType: "FEDERAL_RETURN", year: 2024, visibility: "STAFF_ONLY", returnConfirmation: "Opened the PDF and checked it carefully", ...(await file(f1040(2024, "Sarah", "Williams"))) })).rejects.toThrow(/does not match the selected client/);
    await expect(staffUploadDocument(s.tabitha, { clientId: s.mary.id, category: "TAXES", docType: "FEDERAL_RETURN", year: 2024, visibility: "STAFF_ONLY", returnConfirmation: "Opened the PDF and checked it carefully", ...(await file(f1040(2021, "Mary", "Johnson"))) })).rejects.toThrow(/tax year 2021, but you selected 2024/);
  });
});

describe("Name layouts as TaxAct prints them (fictional people)", () => {
  const head = (y: number) => [`Form 1040 U.S. Individual Income Tax Return ${y}`, `For the year Jan. 1-Dec. 31, ${y}, or other tax year beginning`];

  it("a single filer whose name line is empty in the text: the spouse label below is never read as a name", async () => {
    const s = await setup();
    const blank = pdf([...head(2023), "Your first name and middle initial    Last name    Your social security number", "If joint return, spouse's first name and middle initial    Last name    Spouse's social security number", "Home address (number and street)", "Filing Status  [X] Single"]);
    // Held for verification — not "does not match".
    await expect(upload(s.daria, s.sarah.id, 2023, "FEDERAL_RETURN", await file(blank))).rejects.toThrow(/name couldn't be read/);
    expect(await prisma.returnUploadHold.count({ where: { clientId: s.sarah.id } })).toBe(1);
  });

  it("names on the label's own line, in capitals, with a middle name, an initial or a suffix", async () => {
    const s = await setup();
    await upload(s.tabitha, s.sarah.id, 2022, "FEDERAL_RETURN", await file(pdf([...head(2022), "Your first name and middle initial SARAH Last name WILLIAMS Your social security number 000-00-0003", "Filing Status [X] Single"])));
    await upload(s.tabitha, s.sarah.id, 2023, "FEDERAL_RETURN", await file(pdf([...head(2023), "Your first name and middle initial    Last name    Your social security number", "SARAH ANNE    WILLIAMS    000-00-0003"])));
    await upload(s.tabitha, s.sarah.id, 2024, "FEDERAL_RETURN", await file(pdf([...head(2024), "Your first name and middle initial    Last name    Your social security number", "SARAH J    WILLIAMS JR    000-00-0003"])));
    expect(await docs(s.sarah.id)).toBe(3);
    // A clearly different taxpayer is still refused.
    await expect(upload(s.tabitha, s.sarah.id, 2025, "FEDERAL_RETURN", await file(pdf([...head(2025), "Your first name and middle initial    Last name    Your social security number", "ROBERT T    MILLER    000-00-0009"])))).rejects.toThrow(/does not match the selected client/);
    expect(await docs(s.sarah.id)).toBe(3);
  });

  it("joint return in capitals with the spouse on file; a different spouse is refused", async () => {
    const s = await setup();
    const joint = (spouse: string) => pdf([...head(2024), "Your first name and middle initial    Last name    Your social security number", "MARY E    JOHNSON    000-00-0001", "If joint return, spouse's first name and middle initial    Last name    Spouse's social security number", `${spouse}    JOHNSON    000-00-0002`, "Filing Status [X] Married filing jointly"]);
    await upload(s.tabitha, s.mary.id, 2024, "FEDERAL_RETURN", await file(joint("ROBERT")));
    expect(await docs(s.mary.id)).toBe(1);
    // Same last name, different first name: held for a person to check, not saved.
    await expect(upload(s.tabitha, s.mary.id, 2024, "FEDERAL_RETURN", await file(joint("DAVID")))).rejects.toThrow(/spouse's name on the return is close to/);
    expect(await docs(s.mary.id)).toBe(1);
  });

  it("business: an unreadable name is held; a different EIN is refused", async () => {
    const s = await setup();
    await expect(upload(s.daria, s.acme.id, 2024, "FEDERAL_RETURN", await file(pdf(["Form 1065 U.S. Return of Partnership Income 2024", "For calendar year 2024 or tax year beginning"])))).rejects.toThrow(/business name couldn't be read/);
    await expect(upload(s.tabitha, s.acme.id, 2024, "FEDERAL_RETURN", await file(biz("1065", "U.S. Return of Partnership Income", 2024, "Fictional Widgets LLC", "11-1111111")))).rejects.toThrow(/EIN on this return does not match/);
    await upload(s.tabitha, s.acme.id, 2024, "FEDERAL_RETURN", await file(biz("1065", "U.S. Return of Partnership Income", 2024, "Fictional Widgets LLC", "12-3456789")));
    expect(await docs(s.acme.id)).toBe(1);
  });

  it("every upload location accepts a correctly matched return: Documents, Finish & Send, bulk upload", async () => {
    const s = await setup();
    const ret = (y: number) => pdf([...head(y), "Your first name and middle initial    Last name    Your social security number", "SARAH    WILLIAMS    000-00-0003"]);
    await upload(s.tabitha, s.sarah.id, 2022, "FEDERAL_RETURN", await file(ret(2022)));
    const r = await deliver(s.tabitha, s.sarah.id, 2023, [{ jurisdiction: "FEDERAL", returnType: "1040" }], await file(ret(2023)));
    expect(r.results[0].outcome).toBe("accepted");
    const [a] = await bulkUploadReturns(s.tabitha, [await file(ret(2024), "williams-2024.pdf")]);
    await prisma.filingRecord.create({ data: { clientId: s.sarah.id, taxYear: 2024, returnType: "1040", jurisdiction: "FEDERAL", filingStatus: "ACCEPTED" } });
    await confirmIntake(s.tabitha, a.intakeId!, { clientId: s.sarah.id, taxYear: 2024, returnType: "1040", jurisdiction: "FEDERAL", filingType: "ORIGINAL" });
    expect(await prisma.document.count({ where: { clientId: s.sarah.id, year: { in: [2022, 2023, 2024] }, category: "TAXES" } })).toBeGreaterThanOrEqual(3);
  });
});
