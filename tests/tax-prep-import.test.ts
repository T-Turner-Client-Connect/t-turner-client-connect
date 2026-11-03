// Fictional people and addresses only.
import { beforeEach, describe, expect, it } from "vitest";
import { makeUser, prisma, resetDb } from "./db";
import { formatPhone, normalizePhone } from "@/lib/normalize";
import { guessField, isSensitiveHeader } from "@/lib/import/fields";
import { cleanRow } from "@/lib/import/rows";
import { parseReturnType, parseTaxpayerName } from "@/lib/tax/return-types";
import { commitImport, setRowDecision, stageImport, type ImportSummary } from "@/lib/services/imports";
import { canEditTaxPrep, confirmReturnType, saveTaxPrepCase } from "@/lib/services/tax-prep";
import { createClient, updateClient } from "@/lib/services/clients";
import { ForbiddenError } from "@/lib/auth/actor";

beforeEach(resetDb);

describe("TaxAct phone, names and headers", () => {
  it("cleans TaxAct phone formats with a trailing line-type letter", () => {
    expect(normalizePhone("(205)705-0028 M")).toBe("+12057050028");
    expect(normalizePhone("(205)555-0199 H")).toBe("+12055550199");
    expect(normalizePhone("205-555-0142 (cell)")).toBe("+12055550142");
    expect(normalizePhone("W: 205.555.0110")).toBe("+12055550110");
    expect(normalizePhone("555-0101 M")).toBeNull();
    expect(formatPhone(normalizePhone("(205)705-0028 M"))).toBe("(205) 705-0028");
  });

  it("keeps two joint taxpayers as a primary and a spouse", () => {
    expect(parseTaxpayerName("Allison R Stockton & Jonathan Scoggins")).toEqual({
      primary: { first: "Allison", middle: "R", last: "Stockton" },
      spouse: { first: "Jonathan", middle: null, last: "Scoggins" },
    });
    expect(parseTaxpayerName("John & Jane Doe")).toEqual({ primary: { first: "John", middle: null, last: "Doe" }, spouse: { first: "Jane", middle: null, last: "Doe" } });
    expect(parseTaxpayerName("Doe, John & Jane")?.spouse).toEqual({ first: "Jane", middle: null, last: "Doe" });
    expect(parseTaxpayerName("Allison R & Jonathan Stockton")?.primary).toEqual({ first: "Allison", middle: "R", last: "Stockton" });
    expect(parseTaxpayerName("Lindqvist, Avery")).toEqual({ primary: { first: "Avery", middle: null, last: "Lindqvist" }, spouse: null });
  });

  it("reads return type and filing status into one code", () => {
    expect(parseReturnType("1040", "Married Filing Jointly").code).toBe("1040_MFJ");
    expect(parseReturnType("1040", "MFS").code).toBe("1040_MFS");
    expect(parseReturnType(null, "Head of Household").code).toBe("1040_HOH");
    expect(parseReturnType("Form 1040", "Qualifying Surviving Spouse").code).toBe("1040_QSS");
    expect(parseReturnType("1040", "Single").code).toBe("1040_SINGLE");
    expect(parseReturnType("1120S", null).code).toBe("1120S");
    expect(parseReturnType("1120", null).code).toBe("1120");
    expect(parseReturnType("1065", null).code).toBe("1065");
    expect(parseReturnType("990-EZ", null).code).toBe("990");
    expect(parseReturnType("1040-NR", null)).toEqual({ code: "OTHER", other: "1040-NR" });
    expect(parseReturnType("1040", null).code).toBeNull(); // filing status unknown → staff select
  });

  it("recognizes TaxAct Client Manager headers and still blocks sensitive ones", () => {
    const expected: Record<string, string> = {
      "Taxpayer First Name": "firstName",
      "Taxpayer MI": "middleName",
      "Taxpayer Last Name": "lastName",
      "Spouse First Name": "spouseFirstName",
      "Spouse Last Name": "spouseLastName",
      "Spouse Name": "spouseFullName",
      "Spouse Email": "spouseEmail",
      "Spouse Cell Phone": "spousePhone",
      "Client Name": "fullName",
      "Mailing Address": "addressLine1",
      "Street Address": "addressLine1",
      "Home City": "city",
      "Taxpayer State": "state",
      "Zip Code": "postalCode",
      "Daytime Phone": "phone",
      "Return Type": "returnType",
      "Filing Status": "filingStatus",
      "Tax Year": "taxYear",
      "City, State ZIP": "cityStateZip",
    };
    for (const [h, f] of Object.entries(expected)) expect(guessField(h), h).toBe(f);
    for (const h of ["Taxpayer SSN", "Spouse SSN", "Spouse DOB", "Dependent 1 Name", "Refund Amount", "Bank Routing Number", "Return Status", "AGI", "Taxpayer ID"]) {
      expect(isSensitiveHeader(h), h).toBe(true);
    }
  });

  it("cleans a TaxAct row into one joint household", () => {
    const { row, warnings } = cleanRow({ fullName: "Allison R Stockton & Jonathan Scoggins", phone: "(205)705-0028 M", cityStateZip: "Hoover, AL 35244" });
    expect(row.firstName).toBe("Allison R");
    expect(row.lastName).toBe("Stockton");
    expect(row.displayName).toBe("Allison R Stockton & Jonathan Scoggins");
    expect(row.spouse).toEqual({ first: "Jonathan", middle: null, last: "Scoggins" });
    expect(row.phone).toBe("(205) 705-0028");
    expect(row.phoneNormalized).toBe("+12057050028");
    expect([row.city, row.state, row.postalCode]).toEqual(["Hoover", "AL", "35244"]);
    expect(warnings.join()).toMatch(/Joint taxpayers/);
  });
});

const HEADERS = ["Client Name", "Email", "Phone", "Mailing Address", "City", "State", "ZIP", "Taxpayer SSN", "Preparer"];
const MAPPING = { "Client Name": "fullName", Email: "email", Phone: "phone", "Mailing Address": "addressLine1", City: "city", State: "state", ZIP: "postalCode" };
const FILE = [
  { fullName: "Allison R Stockton & Jonathan Scoggins", email: "", phone: "(205)705-0028 M", addressLine1: "12 Fictional Ridge Rd", city: "Hoover", state: "AL", postalCode: "35244" },
  { fullName: "Marisol Vance", email: "marisol.vance@example.com", phone: "(205)555-0101 H", addressLine1: "40 Sample St", city: "Bessemer", state: "AL", postalCode: "35020" },
];

describe("TaxAct client import with Tax Preparation", () => {
  it("imports one joint record, adds only Tax Preparation, opens cases needing a return type, and summarizes", async () => {
    const daria = await makeUser("STAFF");
    const bk = await createClient(daria, { firstName: "Existing", lastName: "Bookkeeping", clientType: "BUSINESS", status: "ACTIVE", businessName: "Existing Books LLC", services: "Bookkeeping" });
    const batch = await stageImport(daria, { fileName: "taxact.csv", source: "TaxAct", taxReturnDerived: true, mapping: MAPPING, rows: FILE, headers: HEADERS, batchService: "Tax Preparation", taxYear: 2025 });
    const done = await commitImport(daria, batch.id, "fill_blanks");
    expect(done.createdCount).toBe(2);

    const joint = await prisma.client.findFirstOrThrow({ where: { lastName: "Stockton" } });
    expect(joint.displayName).toBe("Allison R Stockton & Jonathan Scoggins");
    expect(joint.firstName).toBe("Allison R");
    expect(joint.phone).toBe("(205) 705-0028");
    expect(joint.services).toEqual(["Tax Preparation"]);
    expect(await prisma.client.count({ where: { OR: [{ firstName: "Jonathan" }, { lastName: "Scoggins" }] } })).toBe(0); // no separate spouse record

    const kase = await prisma.taxPrepCase.findUniqueOrThrow({ where: { clientId_taxYear: { clientId: joint.id, taxYear: 2025 } } });
    expect(kase.returnType).toBeNull(); // not in the file → staff must select
    expect([kase.spouseFirstName, kase.spouseLastName]).toEqual(["Jonathan", "Scoggins"]);
    expect(await prisma.taxPrepCase.count()).toBe(2);

    // Existing bookkeeping client untouched.
    const still = await prisma.client.findUniqueOrThrow({ where: { id: bk.id } });
    expect(still.services).toEqual(["Bookkeeping"]);

    const summary = done.summary as unknown as ImportSummary;
    expect(summary.unmappedColumns).toEqual(["Preparer"]);
    expect(summary.blockedColumns).toEqual(["Taxpayer SSN"]);
    expect(summary.missing.Email).toBe(1);
    expect(summary.attention.joint).toEqual([2]);
    expect(summary.result!.needsReturnType).toHaveLength(2);
    expect(JSON.stringify(summary)).not.toMatch(/705-0028|Fictional Ridge/); // no cell data stored
  });

  it("prefills the return type from TaxAct, then staff confirm it", async () => {
    const daria = await makeUser("STAFF");
    const tab = await makeUser("ADMIN");
    const batch = await stageImport(daria, {
      fileName: "taxact.csv",
      source: "TaxAct",
      taxReturnDerived: true,
      mapping: { ...MAPPING, "Return Type": "returnType", "Filing Status": "filingStatus" },
      rows: [{ ...FILE[0], returnType: "1040", filingStatus: "Married Filing Jointly" }],
      batchService: "Tax Preparation",
      taxYear: 2025,
    });
    await commitImport(daria, batch.id, "fill_blanks");
    const kase = await prisma.taxPrepCase.findFirstOrThrow();
    expect(kase.returnType).toBe("1040_MFJ");
    expect(kase.returnTypeSource).toBe("TAXACT_IMPORT");
    expect(kase.returnTypeConfirmedAt).toBeNull();
    await confirmReturnType(tab, kase.id);
    expect((await prisma.taxPrepCase.findFirstOrThrow()).returnTypeConfirmedAt).not.toBeNull();
  });

  it("requires a tax year when Tax Preparation or a return-type column is used", async () => {
    const daria = await makeUser("STAFF");
    await expect(stageImport(daria, { fileName: "t.csv", source: "TaxAct", taxReturnDerived: true, mapping: MAPPING, rows: FILE, batchService: "Tax Preparation" })).rejects.toThrow(/tax year/);
  });

  it("backfills the existing imported records from the original CSV — matched, previewed, blanks only, no duplicates", async () => {
    const daria = await makeUser("STAFF");
    // How the first import left them: combined name, no phone, no address.
    const old = await prisma.client.create({
      data: { firstName: "Allison R Stockton & Jonathan", lastName: "Scoggins", displayName: "Allison R Stockton & Jonathan Scoggins", clientType: "INDIVIDUAL", services: ["Tax Preparation"], taxReturnDerived: true },
    });
    const verified = await prisma.client.create({
      data: { firstName: "Marisol", lastName: "Vance", displayName: "Marisol Vance", email: "marisol.vance@example.com", emailNormalized: "marisol.vance@example.com", city: "Birmingham", clientType: "INDIVIDUAL", services: ["Tax preparation"] },
    });
    const batch = await stageImport(daria, { fileName: "taxact.csv", source: "TaxAct", taxReturnDerived: true, mapping: MAPPING, rows: FILE, headers: HEADERS, batchService: "Tax Preparation", taxYear: 2025 });
    const rows = await prisma.importRow.findMany({ where: { batchId: batch.id }, orderBy: { rowNumber: "asc" } });
    // The joint record has no address or phone on file, so a name-only match
    // waits for a person to confirm it; the second row matches by email.
    expect([rows[0].match, rows[0].candidateIds, rows[0].decision]).toEqual(["AMBIGUOUS", [old.id], null]);
    expect([rows[1].match, rows[1].decision]).toEqual(["MATCH", `update:${verified.id}`]);
    await setRowDecision(daria, rows[0].id, `update:${old.id}`);
    await commitImport(daria, batch.id, "fill_blanks");

    expect(await prisma.client.count()).toBe(2); // no duplicates
    const fixed = await prisma.client.findUniqueOrThrow({ where: { id: old.id } });
    expect([fixed.firstName, fixed.lastName, fixed.displayName]).toEqual(["Allison R", "Stockton", "Allison R Stockton & Jonathan Scoggins"]);
    expect([fixed.phone, fixed.addressLine1, fixed.postalCode]).toEqual(["(205) 705-0028", "12 Fictional Ridge Rd", "35244"]);
    expect(fixed.services).toEqual(["Tax Preparation"]);

    const m = await prisma.client.findUniqueOrThrow({ where: { id: verified.id } });
    expect(m.city).toBe("Birmingham"); // existing value never overwritten
    expect(m.phone).toBe("(205) 555-0101"); // blank filled
    expect(m.services).toEqual(["Tax preparation"]); // no case-variant duplicate service

    const kase = await prisma.taxPrepCase.findUniqueOrThrow({ where: { clientId_taxYear: { clientId: old.id, taxYear: 2025 } } });
    expect([kase.primaryFirstName, kase.primaryLastName, kase.spouseFirstName, kase.spouseLastName]).toEqual(["Allison", "Stockton", "Jonathan", "Scoggins"]);
  });

  it("matches by name and address when there's no email or phone match", async () => {
    const daria = await makeUser("STAFF");
    const c = await prisma.client.create({ data: { firstName: "Marisol", lastName: "Vance", displayName: "Marisol Vance", addressLine1: "40 Sample St", postalCode: "35020", clientType: "INDIVIDUAL" } });
    const batch = await stageImport(daria, { fileName: "t.csv", source: "TaxAct", taxReturnDerived: true, mapping: MAPPING, rows: [{ ...FILE[1], email: "", phone: "" }] });
    const row = await prisma.importRow.findFirstOrThrow({ where: { batchId: batch.id } });
    expect(row.match).toBe("MATCH");
    expect(row.decision).toBe(`update:${c.id}`);
  });
});

describe("Tax Return Type on the case", () => {
  it("requires a return type; MFJ requires the spouse; one case per year; household name kept on edit", async () => {
    const tab = await makeUser("ADMIN");
    const c = await createClient(tab, { firstName: "Allison R", lastName: "Stockton", clientType: "INDIVIDUAL", status: "ACTIVE" });
    await expect(saveTaxPrepCase(tab, c.id, { taxYear: 2025, returnType: "" })).rejects.toThrow(/Select the Tax Return Type/);
    await expect(saveTaxPrepCase(tab, c.id, { taxYear: 2025, returnType: "1040_MFJ" })).rejects.toThrow(/spouse/);
    await saveTaxPrepCase(tab, c.id, { taxYear: 2025, returnType: "1040_MFJ", primaryFirstName: "Allison", primaryMiddleName: "R", primaryLastName: "Stockton", spouseFirstName: "Jonathan", spouseLastName: "Scoggins" });
    expect((await prisma.client.findUniqueOrThrow({ where: { id: c.id } })).displayName).toBe("Allison R Stockton & Jonathan Scoggins");

    // Editable, linked to the year, still one case.
    await saveTaxPrepCase(tab, c.id, { taxYear: 2025, returnType: "1040_MFS", spouseFirstName: "Jonathan", spouseLastName: "Scoggins" });
    expect(await prisma.taxPrepCase.count({ where: { clientId: c.id } })).toBe(1);
    expect((await prisma.client.findUniqueOrThrow({ where: { id: c.id } })).displayName).toBe("Allison R Stockton");
    await saveTaxPrepCase(tab, c.id, { taxYear: 2025, returnType: "1040_MFJ", spouseFirstName: "Jonathan", spouseLastName: "Scoggins" });
    await saveTaxPrepCase(tab, c.id, { taxYear: 2024, returnType: "1040_SINGLE" });
    expect(await prisma.taxPrepCase.count({ where: { clientId: c.id } })).toBe(2);
    // Latest year (2025) is joint, so editing the client keeps the household name.
    await updateClient(tab, c.id, { firstName: "Allison R", lastName: "Stockton", clientType: "INDIVIDUAL", status: "ACTIVE", email: "allison.s@example.com" });
    expect((await prisma.client.findUniqueOrThrow({ where: { id: c.id } })).displayName).toBe("Allison R Stockton & Jonathan Scoggins");
    await expect(saveTaxPrepCase(tab, c.id, { taxYear: 2025, returnType: "OTHER" })).rejects.toThrow(/return form/);
    const audits = await prisma.auditLog.count({ where: { entityType: "TaxPrepCase" } });
    expect(audits).toBeGreaterThanOrEqual(4);
  });

  it("only an Admin or the assigned staff member may change it", async () => {
    const tab = await makeUser("ADMIN");
    const daria = await makeUser("STAFF");
    const other = await makeUser("STAFF", "Other");
    const c = await createClient(tab, { firstName: "Marisol", lastName: "Vance", clientType: "INDIVIDUAL", status: "ACTIVE", assignedToId: daria.id });
    expect(await canEditTaxPrep(daria, c.id)).toBe(true);
    await saveTaxPrepCase(daria, c.id, { taxYear: 2025, returnType: "1040_HOH" });
    await expect(saveTaxPrepCase(other, c.id, { taxYear: 2025, returnType: "1040_SINGLE" })).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe("Importer review improvements", () => {
  it("compares TaxAct with Client Connect, keeps existing values unless staff approve each correction", async () => {
    const daria = await makeUser("STAFF", "Daria");
    const c = await prisma.client.create({ data: { firstName: "Marisol", lastName: "Vance", displayName: "Marisol Vance", email: "marisol.vance@example.com", emailNormalized: "marisol.vance@example.com", city: "Birmingham", postalCode: "35203", clientType: "INDIVIDUAL" } });
    const { compareFields } = await import("@/lib/import/plan");
    const { setRowApprovals } = await import("@/lib/services/imports");
    const batch = await stageImport(daria, { fileName: "t.csv", source: "TaxAct", taxReturnDerived: true, mapping: MAPPING, rows: [FILE[1]], batchService: "Tax Preparation", taxYear: 2025 });
    const row = await prisma.importRow.findFirstOrThrow({ where: { batchId: batch.id } });
    expect(row.decision).toBe(`update:${c.id}`);
    const cmp = compareFields(c, row.data as never);
    const by = Object.fromEntries(cmp.map((x) => [x.field, x.outcome]));
    expect(by).toMatchObject({ firstName: "same", city: "differs", postalCode: "differs", phone: "fill", addressLine1: "fill", email: "same" });

    await setRowApprovals(daria, row.id, ["city", "notARealField"]);
    expect((await prisma.importRow.findUniqueOrThrow({ where: { id: row.id } })).approvedFields).toEqual(["city"]);
    await commitImport(daria, batch.id, "fill_blanks");
    const after = await prisma.client.findUniqueOrThrow({ where: { id: c.id } });
    expect(after.city).toBe("Bessemer"); // approved correction
    expect(after.postalCode).toBe("35203"); // different but not approved → kept
    expect(after.phone).toBe("(205) 555-0101"); // blank filled
    expect(await prisma.auditLog.count({ where: { action: "import.fields_approved" } })).toBe(1);
  });

  it("assigns every client to Daria and adds groups; an existing different assignee is kept unless approved", async () => {
    const tab = await makeUser("ADMIN");
    const daria = await makeUser("STAFF", "Daria");
    const other = await makeUser("STAFF", "Other");
    const g = await prisma.group.create({ data: { name: "Individual Tax Clients" } });
    const kept = await prisma.client.create({ data: { firstName: "Marisol", lastName: "Vance", displayName: "Marisol Vance", email: "marisol.vance@example.com", emailNormalized: "marisol.vance@example.com", clientType: "INDIVIDUAL", assignedToId: other.id, services: ["Bookkeeping"] } });
    const batch = await stageImport(tab, { fileName: "t.csv", source: "TaxAct", taxReturnDerived: true, mapping: MAPPING, rows: FILE, batchService: "Tax Preparation", taxYear: 2025, batchAssignedToId: daria.id, batchGroupIds: [g.id] });
    await commitImport(tab, batch.id, "fill_blanks");
    const created = await prisma.client.findFirstOrThrow({ where: { lastName: "Stockton" }, include: { groups: true } });
    expect(created.assignedToId).toBe(daria.id);
    expect(created.groups.map((x) => x.groupId)).toEqual([g.id]);
    expect(created.services).toEqual(["Tax Preparation"]); // never Bookkeeping
    const k = await prisma.client.findUniqueOrThrow({ where: { id: kept.id }, include: { groups: true } });
    expect(k.assignedToId).toBe(other.id); // kept — not approved
    expect(k.services).toEqual(["Bookkeeping", "Tax Preparation"]); // existing service kept, tax added
    expect(k.groups).toHaveLength(1);
    await expect(stageImport(tab, { fileName: "t.csv", source: "TaxAct", taxReturnDerived: true, mapping: MAPPING, rows: FILE, batchAssignedToId: "nope" })).rejects.toThrow(/active staff/);
  });

  it("stores spouse email and phone on the joint tax case, not on the client record", async () => {
    const tab = await makeUser("ADMIN");
    const batch = await stageImport(tab, {
      fileName: "t.csv",
      source: "TaxAct",
      taxReturnDerived: true,
      mapping: { ...MAPPING, "Spouse Email": "spouseEmail", "Spouse Phone": "spousePhone" },
      rows: [{ ...FILE[0], email: "allison.s@example.com", spouseEmail: "jonathan.s@example.com", spousePhone: "(205)555-0123 M" }],
      batchService: "Tax Preparation",
      taxYear: 2025,
    });
    await commitImport(tab, batch.id, "fill_blanks");
    const c = await prisma.client.findFirstOrThrow();
    expect(c.email).toBe("allison.s@example.com");
    const kase = await prisma.taxPrepCase.findFirstOrThrow({ where: { clientId: c.id } });
    expect([kase.spouseEmail, kase.spousePhone]).toEqual(["jonathan.s@example.com", "(205) 555-0123"]);
  });

  it("classifies business, nonprofit, individual and joint-return clients from the return type", async () => {
    const { classification } = await import("@/lib/import/rows");
    const biz = cleanRow({ fullName: "Harbor Example Co LLC", returnType: "1120S" }).row;
    expect([biz.clientType, biz.businessName, biz.firstName, biz.displayName]).toEqual(["BUSINESS", "Harbor Example Co LLC", null, "Harbor Example Co LLC"]);
    expect(classification(biz)).toBe("Business");
    const np = cleanRow({ fullName: "Fictional Hope Foundation", returnType: "990-EZ" }).row;
    expect([np.clientType, classification(np)]).toEqual(["NONPROFIT", "Nonprofit"]);
    const joint = cleanRow({ fullName: "John & Jane Doe", returnType: "1040", filingStatus: "MFJ" }).row;
    expect([joint.clientType, classification(joint)]).toEqual(["INDIVIDUAL", "Joint return (individual)"]);
    const single = cleanRow({ fullName: "Marisol Vance", returnType: "1040", filingStatus: "Single" }).row;
    expect(classification(single)).toBe("Individual");
  });
});
