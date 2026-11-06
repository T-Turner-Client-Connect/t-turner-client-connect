import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { makeUser, prisma, resetDb } from "./db";
import { createClient } from "@/lib/services/clients";
import { createFiling, setFilingStatusByStaff } from "@/lib/services/tax";
import { confirmReturnType, prepDefaults, saveTaxPrepCase } from "@/lib/services/tax-prep";
import { deliveryContext } from "@/lib/services/accepted-returns";
import { formsForPrepCase } from "@/lib/tax/accepted";
import { AcceptedReturnFields } from "@/components/accepted-return-fields";

/** Enter once: the confirmed Tax Preparation case drives Finish & Send, the filings and the names. Fictional clients only. */
beforeEach(async () => {
  await resetDb();
  vi.stubEnv("MALWARE_SCAN_URL", "https://scanner.test/scan");
  vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ clean: true }), { status: 200 }));
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

async function office(state: string | null = "AL", clientType: "INDIVIDUAL" | "BUSINESS" = "INDIVIDUAL") {
  const tabitha = await makeUser("ADMIN", "Tabitha");
  await prisma.ownerAccess.create({ data: { userId: tabitha.id, isPrimary: true } });
  const client = await createClient(tabitha, { firstName: "Juniper", lastName: "Ashcombe", clientType, status: "ACTIVE" });
  await prisma.client.update({ where: { id: client.id }, data: { state } });
  return { tabitha, client };
}
const hoh = { taxYear: 2025, returnType: "1040_HOH", primaryFirstName: "Juniper", primaryMiddleName: "Rae", primaryLastName: "Ashcombe" };
const filingsOf = (clientId: string) => prisma.filingRecord.findMany({ where: { clientId }, orderBy: { jurisdiction: "asc" }, select: { taxYear: true, jurisdiction: true, returnType: true, filingType: true, filingStatus: true } });

describe("Form mappings (only the sure ones)", () => {
  it("any 1040 filing status → 1040 and AL 40; business forms; 990 series and Other stay blank", () => {
    for (const c of ["1040_SINGLE", "1040_MFJ", "1040_MFS", "1040_HOH", "1040_QSS"]) expect(formsForPrepCase(c, "AL")).toMatchObject({ federal: "1040", state: "40" });
    expect(formsForPrepCase("1040_HOH", "AL").filingStatus).toBe("HOH");
    expect(formsForPrepCase("1120S", "AL")).toMatchObject({ federal: "1120-S", state: "20S" });
    expect(formsForPrepCase("1065", "AL")).toMatchObject({ federal: "1065", state: "65" });
    expect(formsForPrepCase("1040_SINGLE", "GA")).toMatchObject({ federal: "1040", state: null });
    expect(formsForPrepCase("990", "AL")).toMatchObject({ federal: null, state: null });
    expect(formsForPrepCase("OTHER", "AL")).toMatchObject({ federal: null, state: null });
  });
});

describe("(b) confirming the case creates the year's filings", () => {
  it("2025 1040 – Head of Household, client in AL → Federal 1040 and AL 40 filings, audited", async () => {
    const { tabitha, client } = await office();
    const c = await saveTaxPrepCase(tabitha, client.id, hoh);
    expect(await filingsOf(client.id)).toEqual([
      { taxYear: 2025, jurisdiction: "AL", returnType: "40", filingType: "ORIGINAL", filingStatus: "NOT_SUBMITTED" },
      { taxYear: 2025, jurisdiction: "FEDERAL", returnType: "1040", filingType: "ORIGINAL", filingStatus: "NOT_SUBMITTED" },
    ]);
    const log = await prisma.auditLog.findFirstOrThrow({ where: { action: "tax_prep.filings_created", entityId: c.id } });
    expect((log.details as { filings: { jurisdiction: string }[] }).filings.map((f) => f.jurisdiction)).toEqual(["FEDERAL", "AL"]);
    expect(await prisma.auditLog.count({ where: { action: "filing.created", clientId: client.id } })).toBe(2);
  });

  it("no duplicates, and an existing filing keeps its form and status (match on year + jurisdiction + original)", async () => {
    const { tabitha, client } = await office();
    const al = await createFiling(tabitha, { clientId: client.id, taxYear: 2025, returnType: "1040", jurisdiction: "AL", filingType: "ORIGINAL" });
    await setFilingStatusByStaff(tabitha, al.id, { status: "ACCEPTED", verificationNote: "Accepted per TaxAct (fictional)", submission: { form8879Confirmed: true, overrideReason: "Fictional" } });
    await saveTaxPrepCase(tabitha, client.id, hoh);
    await saveTaxPrepCase(tabitha, client.id, hoh); // saving again changes nothing
    const fs = await filingsOf(client.id);
    expect(fs).toHaveLength(2);
    expect(fs.find((f) => f.jurisdiction === "AL")).toMatchObject({ returnType: "1040", filingStatus: "ACCEPTED" });
    expect(fs.find((f) => f.jurisdiction === "FEDERAL")).toMatchObject({ returnType: "1040", filingStatus: "NOT_SUBMITTED" });
    // An amended filing for the year is a different filing and doesn't block the original.
    expect(await prisma.auditLog.count({ where: { action: "tax_prep.filings_created" } })).toBe(1);
  });

  it("no state on file → Federal only; a state without a sure form → Federal only; 990 series → nothing", async () => {
    const a = await office(null);
    await saveTaxPrepCase(a.tabitha, a.client.id, hoh);
    expect((await filingsOf(a.client.id)).map((f) => f.jurisdiction)).toEqual(["FEDERAL"]);
    await resetDb();
    const b = await office("GA");
    await saveTaxPrepCase(b.tabitha, b.client.id, hoh);
    expect((await filingsOf(b.client.id)).map((f) => f.jurisdiction)).toEqual(["FEDERAL"]);
    await resetDb();
    const n = await office("AL", "BUSINESS");
    await saveTaxPrepCase(n.tabitha, n.client.id, { taxYear: 2025, returnType: "990" });
    expect(await filingsOf(n.client.id)).toEqual([]);
  });

  it("a TaxAct-prefilled case creates filings only when staff confirm it", async () => {
    const { tabitha, client } = await office();
    const c = await prisma.taxPrepCase.create({ data: { clientId: client.id, taxYear: 2025, returnType: "1120S", returnTypeSource: "TAXACT_IMPORT" } });
    expect(await filingsOf(client.id)).toEqual([]);
    await confirmReturnType(tabitha, c.id);
    expect((await filingsOf(client.id)).map((f) => [f.jurisdiction, f.returnType])).toEqual([["AL", "20S"], ["FEDERAL", "1120-S"]]);
  });
});

describe("(a) Finish & Send is prefilled from the case", () => {
  it("tax year, Federal 1040 and AL 40 come from the confirmed case; still editable fields", async () => {
    const { tabitha, client } = await office();
    // Filings deleted so only the case can supply the forms.
    await saveTaxPrepCase(tabitha, client.id, hoh);
    await prisma.filingRecord.deleteMany({ where: { clientId: client.id } });
    const ctx = await deliveryContext(client.id, tabitha);
    expect(ctx.prepForms).toEqual({ "2025": { federal: "1040", state: "40" } });
    const html = renderToStaticMarkup(createElement(AcceptedReturnFields, { ctx, defaultYear: 2025 }));
    expect(html).toMatch(/<option value="2025" selected="">2025<\/option>/);
    expect(html).toMatch(/name="fed\.returnType" value="1040"/);
    expect(html).toMatch(/name="st\.0\.code"[^>]*>[\s\S]*?<option value="AL" selected="">/);
    expect(html).toMatch(/name="st\.0\.returnType" value="40"/);
  });

  it("a business case prefills its business form (1120-S, AL 20S)", async () => {
    const { tabitha, client } = await office("AL", "BUSINESS");
    await saveTaxPrepCase(tabitha, client.id, { taxYear: 2025, returnType: "1120S" });
    await prisma.filingRecord.deleteMany({ where: { clientId: client.id } });
    const html = renderToStaticMarkup(createElement(AcceptedReturnFields, { ctx: await deliveryContext(client.id, tabitha), defaultYear: 2025 }));
    expect(html).toMatch(/name="fed\.returnType" value="1120-S"/);
    expect(html).toMatch(/name="st\.0\.returnType" value="20S"/);
  });
});

describe("(c) the taxpayer name is entered once", () => {
  // The summary's manual-entry form is left as it is (a separate PR replaces it with the automatic summary);
  // the names are served from the case for it and anything else that needs them.
  it("names, spouse and filing status come from the confirmed case", async () => {
    const { tabitha, client } = await office();
    await saveTaxPrepCase(tabitha, client.id, { taxYear: 2025, returnType: "1040_MFJ", primaryFirstName: "Juniper", primaryLastName: "Ashcombe", spouseFirstName: "Rowan", spouseLastName: "Ashcombe" });
    expect((await prepDefaults(client.id))[0]).toMatchObject({ taxYear: 2025, returnType: "1040_MFJ", taxpayerName: "Juniper Ashcombe", spouseName: "Rowan Ashcombe", filingStatus: "MFJ", federalForm: "1040", stateForm: "40" });
  });

  it("an empty name on the case falls back to the client record; no spouse unless the return has one", async () => {
    const { tabitha, client } = await office();
    await saveTaxPrepCase(tabitha, client.id, { taxYear: 2025, returnType: "1040_SINGLE" });
    expect((await prepDefaults(client.id))[0]).toMatchObject({ taxpayerName: "Juniper Ashcombe", spouseName: "" });
  });

  it("unconfirmed (TaxAct-prefilled) cases fill nothing until confirmed", async () => {
    const { client } = await office();
    await prisma.taxPrepCase.create({ data: { clientId: client.id, taxYear: 2025, returnType: "1040_HOH", returnTypeSource: "TAXACT_IMPORT" } });
    expect(await prepDefaults(client.id)).toEqual([]);
  });
});
