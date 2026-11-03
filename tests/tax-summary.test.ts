import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { makeUser, prisma, resetDb } from "./db";
import { ForbiddenError } from "@/lib/auth/actor";
import { createClient } from "@/lib/services/clients";
import { acceptPortalInvite, invitePortalUser } from "@/lib/services/portal-accounts";
import { staffUploadDocument } from "@/lib/services/documents";
import { createFiling, setFilingStatusByStaff } from "@/lib/services/tax";
import { approveSummary, createSummary, portalSummaries, requestSummaryChanges, reviseSummary, sendSummary, summaryRequirement } from "@/lib/services/tax-summary";
import { attachPreparedReturn, excludeItem, sendBlockers, updateItem, verifyItem, resolveCheck } from "@/lib/services/tax-summary-items";
import { extractFromPages, maskSensitive, parseMoney } from "@/lib/tax/extract";

// All people, employers and amounts are fictional.
async function pdf(pages: string[][]) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (const lines of pages) {
    const page = doc.addPage([612, 792]);
    lines.forEach((l, i) => page.drawText(l, { x: 40, y: 750 - i * 16, size: 9, font }));
  }
  return new Uint8Array(await doc.save());
}
async function scannedPdf() {
  const doc = await PDFDocument.create();
  doc.addPage([612, 792]); // an image-only scan has no text layer
  return new Uint8Array(await doc.save());
}
const w2 = (employer: string, wages: string, fed: string) => [
  "Form W-2 Wage and Tax Statement 2025",
  "a Employee's social security number 123-45-6789",
  "c Employer's name, address, and ZIP code",
  employer,
  `1 Wages, tips, other compensation ${wages}`,
  `2 Federal income tax withheld ${fed}`,
];
const r1099 = (payer: string, gross: string, taxable: string, fed: string) => [
  "Form 1099-R Distributions From Pensions, Annuities, Retirement or Profit-Sharing Plans, IRAs 2025",
  "PAYER'S name, street address, city or town, state, ZIP",
  payer,
  `1 Gross distribution ${gross}`,
  `2a Taxable amount ${taxable}`,
  `4 Federal income tax withheld ${fed}`,
];
const form1040 = [
  "Form 1040 U.S. Individual Income Tax Return 2025",
  "Your social security number 123-45-6789   Spouse 987-65-4321",
  "1a Total amount from Form(s) W-2, box 1 (see instructions) 185,000.",
  "1z Add lines 1a through 1h 185,000.",
  "4a IRA distributions 20,000.  4b Taxable amount 15,000.",
  "5a Pensions and annuities 30,000.  5b Taxable amount 25,000.",
  "9 Add lines 1z, 2b, 3b, 4b, 5b, 6b, 7, and 8. This is your total income 225,000.",
  "11 Subtract line 10 from line 9. This is your adjusted gross income 225,000.",
  "12 Standard deduction or itemized deductions (from Schedule A) 30,000.",
  "15 Subtract line 14 from line 11. This is your taxable income 195,000.",
  "25a Form(s) W-2 21,000.",
  "25b Form(s) 1099 5,000.",
  "35a Amount of line 34 you want refunded to you. If Form 8888 is attached, check here 4,000.",
  "b Routing number 062000019   c Type: Checking   d Account number 000123456789",
];
const preparedReturn = () =>
  pdf([
    form1040,
    w2("Magnolia Health Systems", "72,000.00", "8,100.00"),
    w2("Gulf Coast Logistics", "55,000.00", "6,000.00"),
    w2("Riverbend School District", "58,000.00", "6,900.00"),
    r1099("Fidelity Fictional IRA", "20,000.00", "15,000.00", "2,000.00"),
    r1099("Retirement Systems of Fictionland", "30,000.00", "25,000.00", "3,000.00"),
  ]);

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
  const otherAdmin = await makeUser("ADMIN", "Other Admin");
  const daria = await makeUser("STAFF", "Daria");
  const client = await createClient(tabitha, { firstName: "Marcus", lastName: "Fairbanks", clientType: "INDIVIDUAL", status: "ACTIVE" });
  const { token } = await invitePortalUser(tabitha, client.id, { email: "marcus@fictional.example", name: "Marcus Fairbanks", role: "OWNER" });
  const login = await acceptPortalInvite(token!, "Marcus-Pass-12345");
  const marcus = { id: login.id, name: login.name, email: login.email };
  const upload = async (bytes: Uint8Array, name: string, category: "TAXES" | "CLIENT_UPLOADS" = "TAXES") => staffUploadDocument(daria, { clientId: client.id, category, year: 2025, visibility: "STAFF_ONLY", bytes, originalName: name, notify: false });
  return { tabitha, otherAdmin, daria, client, marcus, upload };
}

describe("PDF extraction (text-based PDFs only)", () => {
  it("reads each W-2 and 1099-R separately, keeps gross vs taxable, masks SSNs, and refuses scans", () => {
    const r = extractFromPages([
      { page: 1, text: form1040.join("\n") },
      { page: 2, text: w2("Magnolia Health Systems", "72,000.00", "8,100.00").join("\n") },
      { page: 3, text: w2("Gulf Coast Logistics", "55,000.00", "6,000.00").join("\n") },
      { page: 4, text: r1099("Fidelity Fictional IRA", "20,000.00", "15,000.00", "2,000.00").join("\n") },
    ]);
    expect(r.readable).toBe(true);
    expect(r.isPreparedReturn).toBe(true);
    expect(r.items.map((i) => [i.formType, i.payerName])).toEqual([["W-2", "Magnolia Health Systems"], ["W-2", "Gulf Coast Logistics"], ["1099-R", "Fidelity Fictional IRA"]]);
    expect(r.items[2].amounts.map((a) => [a.key, a.cents])).toEqual([["gross", 2_000_000], ["taxable", 1_500_000], ["fedWithheld", 200_000]]);
    expect(r.returnLines).toMatchObject({ w2Wages: 18_500_000, totalIncome: 22_500_000, agi: 22_500_000, iraTaxable: 1_500_000, pensionsTaxable: 2_500_000, w2Withholding: 2_100_000, form1099Withholding: 500_000, refund: 400_000 });
    expect(r.deposit).toEqual({ routingLast4: "0019", accountLast4: "6789" });
    expect(r.ssnLast4).toEqual(["6789", "4321"]);
    expect(JSON.stringify(r.items)).not.toMatch(/123-45-6789/);
    expect(maskSensitive("SSN 123-45-6789 acct 000123456789")).toBe("SSN XXX-XX-6789 acct ••••6789");
    expect(parseMoney("Form 8888")).toBe(888_800); // why the LAST amount on a line is used
    expect(extractFromPages([{ page: 1, text: "   " }]).readable).toBe(false);
  });
});

describe("Tax Return Summary — reconciliation, approval and owner filing", () => {
  it("multiple W-2s and 1099-Rs, a missing W-2, a mismatch and a scan: only staff-verified items reach the client", async () => {
    const { tabitha, daria, client, marcus, upload } = await setup();
    // Client documents: one matches, one conflicts, one isn't on the return, one is a scan.
    await upload(await pdf([w2("Magnolia Health Systems", "72,000.00", "8,100.00")]), "w2-magnolia.pdf");
    await upload(await pdf([w2("Gulf Coast Logistics", "56,000.00", "6,000.00")]), "w2-gulf.pdf");
    await upload(await pdf([w2("Sunrise Fictional Bakery", "4,500.00", "300.00")]), "w2-sunrise.pdf", "CLIENT_UPLOADS"); // portal uploads are filed as Client Uploads
    await upload(await pdf([r1099("Fidelity Fictional IRA", "20,000.00", "15,000.00", "2,000.00")]), "1099r-fidelity.pdf");
    await upload(await scannedPdf(), "phone-scan.pdf");

    const s = await createSummary(daria, { clientId: client.id, taxYear: 2025, filingStatus: "MFJ", taxpayerName: "Marcus Fairbanks", spouseName: "Delia Fairbanks", dependents: [], wagesCents: 0, otherIncomeCents: 0, totalIncomeCents: 0, agiCents: 0, deductionType: "STANDARD", deductionCents: 0, taxableIncomeCents: 0, federalResultCents: 0, stateResults: [] });
    await expect(sendSummary(daria, s.id)).rejects.toThrow(/prepared return PDF/);
    await attachPreparedReturn(daria, s.id, await preparedReturn(), "taxact-return.pdf");

    const items = await prisma.taxSummaryItem.findMany({ where: { summaryId: s.id }, orderBy: { sortOrder: "asc" } });
    const find = (form: string, payer: RegExp) => items.find((i) => i.formType === form && payer.test(i.payerName))!;
    expect(items.filter((i) => i.formType === "W-2")).toHaveLength(4);
    expect(items.filter((i) => i.formType === "1099-R")).toHaveLength(2);
    expect([find("W-2", /Magnolia/).source, find("W-2", /Magnolia/).status]).toEqual(["BOTH", "NEEDS_REVIEW"]); // matches, still needs a person
    expect(find("W-2", /Gulf/).status).toBe("MISMATCH");
    expect(find("W-2", /Riverbend/).status).toBe("NEEDS_REVIEW"); // on the return, no document uploaded
    expect([find("W-2", /Sunrise/).status, find("W-2", /Sunrise/).returnAmounts]).toEqual(["MISSING", null]); // never assumed to be on the return
    expect(items.find((i) => i.formType === "UNREADABLE")!.note).toMatch(/scanned or photographed/);
    // 1099-R: gross and taxable kept apart, on both sides.
    const fid = find("1099-R", /Fidelity/);
    expect((fid.returnAmounts as { key: string; cents: number }[]).map((a) => a.key)).toEqual(["gross", "taxable", "fedWithheld"]);
    // Totals read from Form 1040 fill the blanks but must be confirmed.
    const filled = await prisma.taxReturnSummary.findUniqueOrThrow({ where: { id: s.id } });
    expect([filled.totalIncomeCents, filled.agiCents, filled.federalResultCents, filled.depositAccountLast4]).toEqual([22_500_000, 22_500_000, 400_000, "6789"]);

    // Blocked until every item is decided and every check resolved.
    expect((await sendBlockers(s.id)).join(" ")).toMatch(/still need staff verification/);
    await expect(verifyItem(daria, find("W-2", /Gulf/).id)).rejects.toThrow(/differs from the return/);
    await verifyItem(daria, find("W-2", /Gulf/).id, "Client sent a W-2c; TaxAct has the corrected 55,000 (fictional)");
    await expect(verifyItem(daria, find("W-2", /Sunrise/).id)).rejects.toThrow(/Enter the amounts as reported/);
    await expect(verifyItem(daria, items.find((i) => i.formType === "UNREADABLE")!.id)).rejects.toThrow(/Enter this document/);
    // Staff record that the 4th W-2 is on the return → the W-2 total no longer matches line 1a: still on hold.
    await updateItem(daria, find("W-2", /Sunrise/).id, { section: "INCOME", formType: "W-2", payerName: "Sunrise Fictional Bakery", recipient: "SPOUSE", returnAmounts: [{ key: "wages", label: "Wages (box 1)", cents: 450_000 }, { key: "fedWithheld", label: "Federal income tax withheld (box 2)", cents: 30_000 }] }, "Checked TaxAct (fictional)");
    expect((await sendBlockers(s.id)).join(" ")).toMatch(/W-2 wages vs Form 1040 line 1a: items total \$189,500\.00, the return shows \$185,000\.00/);
    // It really was left off the return → exclude it with a reason (or correct the return in TaxAct).
    await excludeItem(daria, find("W-2", /Sunrise/).id, "Belongs to the 2024 return (fictional)");
    await excludeItem(daria, items.find((i) => i.formType === "UNREADABLE")!.id, "Duplicate photo of the Magnolia W-2 (fictional)");
    for (const i of items.filter((x) => ["NEEDS_REVIEW"].includes(x.status) && x.formType !== "UNREADABLE")) await verifyItem(daria, i.id);
    for (const c of await prisma.taxSummaryCheck.findMany({ where: { summaryId: s.id, resolvedAt: null } })) await resolveCheck(daria, c.id, "Compared with TaxAct (fictional)");
    expect(await sendBlockers(s.id)).toEqual([]);
    await sendSummary(daria, s.id);

    // The client sees only verified items: 3 W-2s + 2 1099-Rs; not the excluded W-2 or the scan.
    const [seen] = await portalSummaries(marcus, client.id);
    expect(seen.items!.map((i) => i.payerName).sort()).toEqual(["Fidelity Fictional IRA", "Gulf Coast Logistics", "Magnolia Health Systems", "Retirement Systems of Fictionland", "Riverbend School District"]);
    expect(seen.items!.find((i) => /Gulf/.test(i.payerName))!.returnAmounts).toEqual(expect.arrayContaining([expect.objectContaining({ key: "wages", cents: 5_500_000 })])); // the return figure, not the document's
    expect(JSON.stringify(seen)).not.toMatch(/062000019|000123456789|123-45-6789/);
    void tabitha;
  });

  it("joint approval needs both spouses; a correction request holds filing; changes after approval need a new approval; only the owner can file", async () => {
    const { tabitha, otherAdmin, daria, client, marcus } = await setup();
    const s = await createSummary(daria, { clientId: client.id, taxYear: 2025, filingStatus: "MFJ", taxpayerName: "Marcus Fairbanks", spouseName: "Delia Fairbanks", dependents: [{ name: "Avery Fairbanks", relationship: "Daughter" }], wagesCents: 5_000_000, otherIncomeCents: 0, totalIncomeCents: 5_000_000, agiCents: 5_000_000, deductionType: "STANDARD", deductionCents: 3_000_000, taxableIncomeCents: 2_000_000, federalResultCents: 120_000, stateResults: [{ state: "AL", resultCents: -15_000 }] });
    // No prepared return attached → can't send.
    await expect(sendSummary(daria, s.id)).rejects.toThrow(/prepared return PDF/);
    await attachPreparedReturn(daria, s.id, await pdf([w2("Magnolia Health Systems", "50,000.00", "5,000.00")]), "return.pdf");
    for (const i of await prisma.taxSummaryItem.findMany({ where: { summaryId: s.id } })) await verifyItem(daria, i.id);
    for (const c of await prisma.taxSummaryCheck.findMany({ where: { summaryId: s.id, resolvedAt: null } })) await resolveCheck(daria, c.id, "Checked (fictional)");
    await sendSummary(daria, s.id);

    const federal = await createFiling(daria, { clientId: client.id, taxYear: 2025, returnType: "1040", jurisdiction: "FEDERAL", filingType: "ORIGINAL" });
    const submit = (actor: typeof tabitha, extra: Record<string, unknown> = { form8879Confirmed: true }) => setFilingStatusByStaff(actor, federal.id, { status: "SUBMITTED", submission: extra as never });

    // Correction request → on hold; filing is refused without an approved summary.
    await requestSummaryChanges(marcus, client.id, s.id, "", [{ itemId: (await prisma.taxSummaryItem.findFirstOrThrow({ where: { summaryId: s.id } })).id, note: "Wages should be 51,000" }]);
    expect((await prisma.taxReturnSummary.findUniqueOrThrow({ where: { id: s.id } })).status).toBe("CHANGES_REQUESTED");
    await expect(submit(tabitha)).rejects.toThrow(/no client-approved/);
    await expect(approveSummary(marcus, client.id, s.id, { role: "TAXPAYER", signerName: "Marcus Fairbanks", agreed: true })).rejects.toThrow(/isn't waiting/);

    // The office revises → new version (v2) to send and approve.
    const v2 = await reviseSummary(daria, s.id, "Client correction reviewed (fictional)");
    expect(v2.version).toBe(2);
    await sendSummary(daria, v2.id);
    await expect(approveSummary(marcus, client.id, v2.id, { role: "TAXPAYER", signerName: "Someone Else", agreed: true })).rejects.toThrow(/exactly as shown/);
    expect((await approveSummary(marcus, client.id, v2.id, { role: "TAXPAYER", signerName: "marcus fairbanks", agreed: true, ipAddress: "203.0.113.5" })).complete).toBe(false);
    expect((await summaryRequirement(federal)).approved).toBeNull(); // one spouse isn't enough
    await expect(submit(tabitha)).rejects.toThrow(/no client-approved/);
    expect((await approveSummary(marcus, client.id, v2.id, { role: "SPOUSE", signerName: "Delia Fairbanks", agreed: true })).complete).toBe(true);
    expect((await summaryRequirement(federal)).approved?.id).toBe(v2.id);

    // A material change after approval invalidates it.
    const v3 = await reviseSummary(daria, v2.id, "Late 1099-INT (fictional)");
    expect((await prisma.taxReturnSummary.findUniqueOrThrow({ where: { id: v2.id } })).status).toBe("SUPERSEDED");
    expect(await prisma.taxSummarySignature.count({ where: { summaryId: v2.id, invalidatedAt: null } })).toBe(0);
    expect((await summaryRequirement(federal)).approved).toBeNull();
    await expect(submit(tabitha)).rejects.toThrow(/no client-approved/);
    // Tampering with a figure after sending is caught at signing.
    await sendSummary(daria, v3.id);
    await prisma.taxSummaryItem.updateMany({ where: { summaryId: v3.id }, data: { returnAmounts: [{ key: "wages", label: "Wages (box 1)", cents: 1 }] } });
    await expect(approveSummary(marcus, client.id, v3.id, { role: "TAXPAYER", signerName: "Marcus Fairbanks", agreed: true })).rejects.toThrow(/figures changed/);
    await prisma.taxSummaryItem.updateMany({ where: { summaryId: v3.id }, data: { returnAmounts: [{ key: "wages", label: "Wages (box 1)", cents: 5_000_000 }, { key: "fedWithheld", label: "Federal income tax withheld (box 2)", cents: 500_000 }] } });
    await approveSummary(marcus, client.id, v3.id, { role: "TAXPAYER", signerName: "Marcus Fairbanks", agreed: true });
    await approveSummary(marcus, client.id, v3.id, { role: "SPOUSE", signerName: "Delia Fairbanks", agreed: true });

    // Owner-only filing, even with an approved summary.
    await expect(submit(daria)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(submit(otherAdmin)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(submit(tabitha, { form8879Confirmed: false })).rejects.toThrow(/8879/);
    await submit(tabitha);
    const ev = await prisma.filingStatusEvent.findFirstOrThrow({ where: { filingId: federal.id, field: "FILING" } });
    expect(ev.verificationNote).toMatch(/client-approved summary on file/);
    // After filing, figures can't be revised (amended return instead).
    await expect(reviseSummary(daria, v3.id, "x change")).rejects.toThrow(/already been submitted/);
  });

  it("REGRESSION: four W-2s from four intake sources, three on the return — the fourth is flagged and approval is blocked", async () => {
    const { daria, client, marcus } = await setup();
    // Each source files tax documents differently; all must be reconciled.
    const add = async (bytes: Uint8Array, name: string, category: "TAXES" | "CLIENT_UPLOADS" | "OTHER", source: string, year: number | null = 2025) => {
      const d = await staffUploadDocument(daria, { clientId: client.id, category, year, visibility: "STAFF_ONLY", bytes, originalName: name, notify: false, docType: "W2" });
      if (source === "portal") await prisma.document.update({ where: { id: d.id }, data: { uploadedByPortalId: marcus.id, uploadedByStaffId: null } });
      return d;
    };
    await add(await pdf([w2("Magnolia Health Systems", "72,000.00", "8,100.00")]), "portal-w2.pdf", "CLIENT_UPLOADS", "portal");
    await add(await pdf([w2("Gulf Coast Logistics", "55,000.00", "6,000.00")]), "jotform-w2.pdf", "TAXES", "jotform");
    await add(await pdf([w2("Riverbend School District", "58,000.00", "6,900.00")]), "staff-w2.pdf", "TAXES", "staff");
    await add(await pdf([w2("Sunrise Fictional Bakery", "4,500.00", "300.00")]), "misc-w2.pdf", "OTHER", "staff");
    const s = await createSummary(daria, { clientId: client.id, taxYear: 2025, filingStatus: "SINGLE", taxpayerName: "Marcus Fairbanks", dependents: [], wagesCents: 0, otherIncomeCents: 0, totalIncomeCents: 0, agiCents: 0, deductionType: "STANDARD", deductionCents: 0, taxableIncomeCents: 0, federalResultCents: 0, stateResults: [] });
    // The prepared return has only three W-2s.
    await attachPreparedReturn(daria, s.id, await pdf([form1040, w2("Magnolia Health Systems", "72,000.00", "8,100.00"), w2("Gulf Coast Logistics", "55,000.00", "6,000.00"), w2("Riverbend School District", "58,000.00", "6,900.00")]), "return.pdf");
    const w2s = await prisma.taxSummaryItem.findMany({ where: { summaryId: s.id, formType: "W-2" } });
    expect(w2s).toHaveLength(4);
    expect(w2s.filter((i) => i.source === "BOTH")).toHaveLength(3); // portal, Jotform and staff copies each matched to the return
    const fourth = w2s.find((i) => /Sunrise/.test(i.payerName))!;
    expect([fourth.status, fourth.returnAmounts]).toEqual(["MISSING", null]);
    // Verify the three; the fourth still blocks sending (and therefore approval).
    for (const i of w2s.filter((x) => x.id !== fourth.id)) await verifyItem(daria, i.id);
    for (const c of await prisma.taxSummaryCheck.findMany({ where: { summaryId: s.id, resolvedAt: null } })) await resolveCheck(daria, c.id, "Checked (fictional)");
    expect((await sendBlockers(s.id)).join(" ")).toMatch(/1 item\(s\) still need staff verification: W-2 Sunrise Fictional Bakery \(Missing from return\)/);
    await expect(sendSummary(daria, s.id)).rejects.toThrow(/Sunrise Fictional Bakery/);
    expect((await portalSummaries(marcus, client.id))).toHaveLength(0); // nothing reaches the client to approve

    // A W-2 uploaded without a tax year is also caught.
    await add(await pdf([w2("Undated Fictional Employer", "1,000.00", "50.00")]), "undated-w2.pdf", "CLIENT_UPLOADS", "portal", null);
    const { runExtraction } = await import("@/lib/services/tax-summary-items");
    await runExtraction(daria, s.id);
    expect((await sendBlockers(s.id)).join(" ")).toMatch(/1 tax document\(s\) have no tax year/);
  });
});
