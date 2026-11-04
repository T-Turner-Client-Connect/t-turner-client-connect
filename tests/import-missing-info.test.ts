// Completing missing address / contact info in the import preview.
// Fictional people, addresses, phones and emails only.
import { beforeEach, describe, expect, it } from "vitest";
import { makeUser, prisma, resetDb } from "./db";
import { commitImport, saveRowEdits, setRowApprovals, setRowDecision, stageImport, type ImportSummary } from "@/lib/services/imports";
import { clientWhere } from "@/lib/services/clients";
import { applyEdits, missingInfo, validateEdits } from "@/lib/import/edits";
import { cleanRow } from "@/lib/import/rows";
import { mailingAddressOf } from "@/lib/client-address";

beforeEach(resetDb);

const MAPPING = { "Client Name": "fullName", Email: "email", Phone: "phone", "Street Address": "addressLine1", City: "city", State: "state", ZIP: "postalCode" };
const full = { addressLine1: "18 Example Lane", city: "Hoover", state: "AL", postalCode: "35244" };
const rowsOf = async (batchId: string) => prisma.importRow.findMany({ where: { batchId }, orderBy: { rowNumber: "asc" } });
const blankAddress = { street: "", line2: "", city: "", state: "", zip: "" };
const address = (a: Partial<typeof blankAddress> = {}) => {
  const v = { ...blankAddress, ...a };
  return { addressLine1: v.street, addressLine2: v.line2, city: v.city, state: v.state, postalCode: v.zip };
};

describe("missing address in the preview", () => {
  it("flags a row with no address (or a partial one), and holds the import until it's completed, skipped or flagged", async () => {
    const daria = await makeUser("STAFF");
    const batch = await stageImport(daria, {
      fileName: "taxact.csv",
      source: "TaxAct",
      taxReturnDerived: true,
      mapping: MAPPING,
      rows: [
        { fullName: "Quinn Fictional", email: "quinn@example.com", phone: "(205)555-0141 M", ...full },
        { fullName: "Rowan Sample", email: "rowan@example.com", phone: "(205)555-0142" }, // no address at all
        { fullName: "Sage Placeholder", email: "sage@example.com", phone: "(205)555-0143", addressLine1: "5 Demo Ct", city: "Bessemer" }, // no state/ZIP
      ],
    });
    const rows = await rowsOf(batch.id);
    expect(rows.map((r) => r.missingInfo)).toEqual([[], ["Address"], ["Address"]]);
    const summary = batch.summary as unknown as ImportSummary;
    expect(summary.missing["Street address"]).toBe(1);

    await expect(commitImport(daria, batch.id, "fill_blanks", { addressNeeded: "require" })).rejects.toThrow(/2 client\(s\) are missing an address \(rows 3, 4\)/);
    expect(await prisma.client.count()).toBe(0); // nothing created

    // Skipping a row takes it out of the count.
    await setRowDecision(daria, rows[2].id, "skip");
    await expect(commitImport(daria, batch.id, "fill_blanks", { addressNeeded: "require" })).rejects.toThrow(/1 client\(s\) are missing an address \(row 3\)/);
  });

  it("validates what staff type and never invents data", () => {
    expect(validateEdits({ state: "Alabama", postalCode: "352", phone: "555-01", email: "nope" }).errors).toHaveLength(4);
    const { edits, errors } = validateEdits({ addressLine1: "  9 Example Way ", state: "al", postalCode: "35203-1234", phone: "205 555 0150", email: "Ivy@Example.com", addressLine2: "" });
    expect(errors).toEqual([]);
    expect(edits).toEqual({ addressLine1: "9 Example Way", state: "AL", postalCode: "35203-1234", phone: "(205) 555-0150", email: "Ivy@Example.com" });
    // A blank entry never clears a value from the file.
    const { row } = cleanRow({ fullName: "Ivy Example", city: "Hoover" });
    expect(applyEdits(row, { city: "" }).city).toBe("Hoover");
    expect(validateEdits({ returnType: "OTHER" }).errors[0]).toMatch(/Return type/);
    expect(validateEdits({ returnType: "1040_ZZZ" }).errors[0]).toMatch(/Return type/);
  });
});

describe("address entered in the preview is saved to the client master record", () => {
  it("saves street + same mailing, and a separate mailing address; edits persist on the batch until applied", async () => {
    const daria = await makeUser("STAFF");
    const batch = await stageImport(daria, {
      fileName: "taxact.csv",
      source: "TaxAct",
      taxReturnDerived: true,
      mapping: MAPPING,
      rows: [
        { fullName: "Teagan Fictional", email: "teagan@example.com", phone: "(205)555-0161" },
        { fullName: "Uma Sample", email: "uma@example.com", phone: "" },
      ],
    });
    const [a, b] = await rowsOf(batch.id);
    await saveRowEdits(daria, a.id, { values: address({ street: "21 Example Ave", line2: "Apt 2", city: "Hoover", state: "al", zip: "35244" }), mailingSameAsAddress: true });
    const res = await saveRowEdits(daria, b.id, {
      values: { ...address({ street: "77 Sample Rd", city: "Bessemer", state: "AL", zip: "35020" }), mailingAddressLine1: "PO Box 1200", mailingCity: "Bessemer", mailingState: "AL", mailingPostalCode: "35021", phone: "(205) 555-0162" },
      mailingSameAsAddress: false,
    });
    expect(res.missing).toEqual([]);

    // Stored server-side on the row: a refresh or a later visit shows the same thing.
    const again = await rowsOf(batch.id);
    expect(again[0].edits).toMatchObject({ addressLine1: "21 Example Ave", state: "AL", mailingSameAsAddress: true });
    expect(again.map((r) => r.missingInfo)).toEqual([[], []]);
    expect(again[0].editedById).toBe(daria.id);
    const logged = await prisma.auditLog.findFirstOrThrow({ where: { action: "import.row_completed", entityId: a.id } });
    expect(JSON.stringify(logged.details)).not.toMatch(/Example Ave|35244/); // field names only

    await commitImport(daria, batch.id, "fill_blanks", { addressNeeded: "require" });
    const teagan = await prisma.client.findFirstOrThrow({ where: { lastName: "Fictional" } });
    expect([teagan.addressLine1, teagan.addressLine2, teagan.city, teagan.state, teagan.postalCode]).toEqual(["21 Example Ave", "Apt 2", "Hoover", "AL", "35244"]);
    expect(teagan.mailingSameAsAddress).toBe(true);
    expect(teagan.mailingAddressLine1).toBeNull();
    expect(mailingAddressOf(teagan).line1).toBe("21 Example Ave");
    expect(teagan.tags).toEqual([]);

    const uma = await prisma.client.findFirstOrThrow({ where: { lastName: "Sample" } });
    expect([uma.addressLine1, uma.city, uma.postalCode]).toEqual(["77 Sample Rd", "Bessemer", "35020"]);
    expect([uma.mailingSameAsAddress, uma.mailingAddressLine1, uma.mailingCity, uma.mailingState, uma.mailingPostalCode]).toEqual([false, "PO Box 1200", "Bessemer", "AL", "35021"]);
    expect(mailingAddressOf(uma).line1).toBe("PO Box 1200");
    expect([uma.phone, uma.phoneNormalized]).toEqual(["(205) 555-0162", "+12055550162"]); // completed phone

    // History: the importer's audit still records the creation, plus what was entered.
    const created = await prisma.auditLog.findFirstOrThrow({ where: { action: "client.created_by_import", clientId: uma.id } });
    expect((created.details as { enteredInPreview: string[] }).enteredInPreview).toEqual(expect.arrayContaining(["addressLine1", "mailingAddressLine1", "phone"]));
    // Staged data and what staff typed are cleared once applied.
    expect((await rowsOf(batch.id)).every((r) => r.data === null && r.edits === null)).toBe(true);
    await expect(saveRowEdits(daria, a.id, { values: {}, mailingSameAsAddress: true })).rejects.toThrow(/no longer open/);
  });

  it("an incomplete mailing address counts as missing", () => {
    const { row } = cleanRow({ fullName: "Vale Example", ...full, email: "vale@example.com", phone: "2055550170" });
    const eff = applyEdits(row, { mailingSameAsAddress: false, mailingAddressLine1: "PO Box 9" });
    expect(missingInfo(eff, null, { wantsCase: false })).toEqual(["Address"]);
    expect(missingInfo(applyEdits(row, { mailingSameAsAddress: true }), null, { wantsCase: false })).toEqual([]);
  });
});

describe("existing clients keep their address and contact details", () => {
  it("keeps existing values by default, never overwrites with a blank, and applies an approved change", async () => {
    const daria = await makeUser("STAFF");
    const c = await prisma.client.create({
      data: {
        firstName: "Wren",
        lastName: "Fictional",
        displayName: "Wren Fictional",
        email: "wren@example.com",
        emailNormalized: "wren@example.com",
        phone: "(205) 555-0181",
        phoneNormalized: "+12055550181",
        addressLine1: "4 Original St",
        city: "Birmingham",
        state: "AL",
        postalCode: "35203",
        mailingSameAsAddress: false,
        mailingAddressLine1: "PO Box 44",
        mailingCity: "Birmingham",
        mailingState: "AL",
        mailingPostalCode: "35202",
        clientType: "INDIVIDUAL",
      },
    });
    // The file has a different street address, a blank phone and a blank email.
    const batch = await stageImport(daria, {
      fileName: "taxact.csv",
      source: "TaxAct",
      taxReturnDerived: true,
      mapping: MAPPING,
      rows: [{ fullName: "Wren Fictional", email: "wren@example.com", phone: "", addressLine1: "99 Newer Rd", city: "Hoover", state: "AL", postalCode: "35244" }],
    });
    const [row] = await rowsOf(batch.id);
    expect(row.decision).toBe(`update:${c.id}`);
    expect(row.missingInfo).toEqual([]); // the existing record already has what the file lacks

    // Staff blank out a field in the form: still never clears the record.
    await saveRowEdits(daria, row.id, { values: { ...address({ street: "99 Newer Rd", city: "Hoover", state: "AL", zip: "35244" }), phone: "" }, mailingSameAsAddress: false });
    await commitImport(daria, batch.id, "fill_blanks", { addressNeeded: "require" });
    const kept = await prisma.client.findUniqueOrThrow({ where: { id: c.id } });
    expect([kept.addressLine1, kept.city, kept.postalCode]).toEqual(["4 Original St", "Birmingham", "35203"]); // not approved → kept
    expect([kept.phone, kept.email]).toEqual(["(205) 555-0181", "wren@example.com"]); // blanks never overwrite
    expect([kept.mailingSameAsAddress, kept.mailingAddressLine1]).toEqual([false, "PO Box 44"]);

    // Next import: staff approve "Use imported value" for the street and city only.
    const batch2 = await stageImport(daria, {
      fileName: "taxact-2.csv",
      source: "TaxAct",
      taxReturnDerived: true,
      mapping: MAPPING,
      rows: [{ fullName: "Wren Fictional", email: "", phone: "", addressLine1: "99 Newer Rd", city: "Hoover", state: "", postalCode: "35244" }],
    });
    const [row2] = await rowsOf(batch2.id);
    await setRowDecision(daria, row2.id, `update:${c.id}`);
    // An approval from the name/category comparison is kept alongside the editor's.
    await setRowApprovals(daria, row2.id, ["firstName"], ["firstName"]);
    await saveRowEdits(daria, row2.id, { values: address({ street: "99 Newer Rd", city: "Hoover", zip: "35244" }), mailingSameAsAddress: false, useImported: ["addressLine1", "city", "notAField"] });
    expect((await prisma.importRow.findUniqueOrThrow({ where: { id: row2.id } })).approvedFields.sort()).toEqual(["addressLine1", "city", "firstName"]);
    await commitImport(daria, batch2.id, "fill_blanks", { addressNeeded: "require" });
    const after = await prisma.client.findUniqueOrThrow({ where: { id: c.id } });
    expect([after.addressLine1, after.city]).toEqual(["99 Newer Rd", "Hoover"]); // approved
    expect([after.state, after.postalCode]).toEqual(["AL", "35203"]); // blank state never overwrites; ZIP not approved
    expect([after.phone, after.email]).toEqual(["(205) 555-0181", "wren@example.com"]);
    const upd = await prisma.auditLog.findFirstOrThrow({ where: { action: "client.updated_by_import", clientId: c.id }, orderBy: { createdAt: "desc" } });
    expect((upd.details as { fields: string[] }).fields).toEqual(expect.arrayContaining(["addressLine1", "city"]));
  });

  it("fills an existing client's blank address from the preview without approval", async () => {
    const daria = await makeUser("STAFF");
    const c = await prisma.client.create({ data: { firstName: "Xen", lastName: "Sample", displayName: "Xen Sample", email: "xen@example.com", emailNormalized: "xen@example.com", clientType: "INDIVIDUAL" } });
    const batch = await stageImport(daria, { fileName: "t.csv", source: "TaxAct", taxReturnDerived: true, mapping: MAPPING, rows: [{ fullName: "Xen Sample", email: "xen@example.com" }] });
    const [row] = await rowsOf(batch.id);
    expect(row.missingInfo).toEqual(["Address", "Phone"]);
    await saveRowEdits(daria, row.id, { values: address({ street: "3 Demo Pl", city: "Hoover", state: "AL", zip: "35244" }), mailingSameAsAddress: true });
    await commitImport(daria, batch.id, "fill_blanks", { addressNeeded: "require" });
    const x = await prisma.client.findUniqueOrThrow({ where: { id: c.id } });
    expect([x.addressLine1, x.postalCode, x.mailingSameAsAddress]).toEqual(["3 Demo Pl", "35244", true]);
  });
});

describe("filing status is never assumed", () => {
  it("leaves it unset, requires a choice or the Filing Status Needed flag, and applies what staff pick", async () => {
    const daria = await makeUser("STAFF");
    const batch = await stageImport(daria, {
      fileName: "taxact.csv",
      source: "TaxAct",
      taxReturnDerived: true,
      mapping: { ...MAPPING, "Return Type": "returnType" },
      rows: [
        // Joint names and "1040" alone: still not assumed to be Married Filing Jointly.
        { fullName: "Yara Fictional & Zed Fictional", email: "yara@example.com", phone: "2055550191", ...full, returnType: "1040" },
        { fullName: "Abel Sample", email: "abel@example.com", phone: "2055550192", ...full, returnType: "" },
        { fullName: "Bea Placeholder", email: "bea@example.com", phone: "2055550193", ...full, returnType: "1040" },
      ],
      batchService: "Tax Preparation",
      taxYear: 2025,
    });
    const rows = await rowsOf(batch.id);
    expect(rows.map((r) => (r.data as { returnType: string | null }).returnType)).toEqual([null, null, null]);
    expect(rows.map((r) => r.missingInfo)).toEqual([["Filing status"], ["Filing status"], ["Filing status"]]);
    await expect(commitImport(daria, batch.id, "fill_blanks", { filingStatusNeeded: "require" })).rejects.toThrow(/never assumes/);

    await saveRowEdits(daria, rows[0].id, { values: {}, mailingSameAsAddress: true, returnType: "1040_MFJ" });
    await saveRowEdits(daria, rows[1].id, { values: {}, mailingSameAsAddress: true, returnType: "1040_SINGLE" });
    expect((await prisma.importRow.findUniqueOrThrow({ where: { id: rows[0].id } })).missingInfo).toEqual([]);
    await expect(commitImport(daria, batch.id, "fill_blanks", { filingStatusNeeded: "require" })).rejects.toThrow(/1 client\(s\) have no return type/);

    const done = await commitImport(daria, batch.id, "fill_blanks", { filingStatusNeeded: "flag", addressNeeded: "require" });
    const cases = await prisma.taxPrepCase.findMany({ include: { client: true }, orderBy: { client: { displayName: "asc" } } });
    const by = Object.fromEntries(cases.map((k) => [k.client.lastName, k]));
    expect(by.Sample.returnType).toBe("1040_SINGLE");
    expect(by.Fictional.returnType).toBe("1040_MFJ");
    expect(by.Placeholder.returnType).toBeNull(); // not set, not assumed
    expect(by.Placeholder.client.tags).toEqual(["Filing Status Needed"]);
    expect(by.Sample.client.tags).toEqual([]);
    expect((done.summary as unknown as ImportSummary).result!.filingStatusNeeded).toBe(1);
    expect(await prisma.client.count({ where: clientWhere({ tag: "Filing Status Needed" }) })).toBe(1);
  });
});

describe("bulk: ~300 rows, some fixed inline, some imported as Address Needed", () => {
  it("handles the batch, filters rows missing info, and makes Address Needed clients findable", async () => {
    const daria = await makeUser("STAFF");
    const rows = Array.from({ length: 300 }, (_, i) => {
      const n = String(i).padStart(3, "0");
      const base = { fullName: `Client${n} Fictional${n}`, email: `client${n}@example.com`, phone: `(205) 555-${1000 + i}` };
      // Every third row has no address in the file.
      return i % 3 === 0 ? base : { ...base, addressLine1: `${100 + i} Example St`, city: "Hoover", state: "AL", postalCode: "35244" };
    });
    const batch = await stageImport(daria, { fileName: "taxact-300.csv", source: "TaxAct", taxReturnDerived: true, mapping: MAPPING, rows });
    const missingWhere = { batchId: batch.id, missingInfo: { has: "Address" } };
    expect(await prisma.importRow.count({ where: { batchId: batch.id } })).toBe(300);
    expect(await prisma.importRow.count({ where: missingWhere })).toBe(100);

    // Fix 40 inline (with no profile opened); the other 60 go in flagged.
    const toFix = await prisma.importRow.findMany({ where: missingWhere, orderBy: { rowNumber: "asc" }, take: 40 });
    for (const [i, r] of toFix.entries()) {
      await saveRowEdits(daria, r.id, { values: address({ street: `${i + 1} Filled Ln`, city: "Bessemer", state: "AL", zip: "35020" }), mailingSameAsAddress: true });
    }
    // Half of the fixed rows have a separate mailing address: entered after the fact.
    for (const r of toFix.filter((_, i) => i % 2 === 1)) {
      await saveRowEdits(daria, r.id, { values: { ...address({ street: "1 Filled Ln", city: "Bessemer", state: "AL", zip: "35020" }), mailingAddressLine1: "PO Box 77", mailingCity: "Bessemer", mailingState: "AL", mailingPostalCode: "35021" }, mailingSameAsAddress: false });
    }
    expect(await prisma.importRow.count({ where: missingWhere })).toBe(60);
    await expect(commitImport(daria, batch.id, "fill_blanks", { addressNeeded: "require" })).rejects.toThrow(/60 client\(s\) are missing an address/);

    const t0 = Date.now();
    const done = await commitImport(daria, batch.id, "fill_blanks", { addressNeeded: "flag" });
    expect(Date.now() - t0).toBeLessThan(60_000);
    expect(done.createdCount).toBe(300);
    const result = (done.summary as unknown as ImportSummary).result!;
    expect([result.addressNeeded, result.completedInPreview]).toEqual([60, 40]);

    const flagged = clientWhere({ tag: "Address Needed" });
    expect(await prisma.client.count({ where: flagged })).toBe(60);
    expect(await prisma.client.count({ where: { ...flagged, addressLine1: { not: null } } })).toBe(0);
    expect(await prisma.client.count({ where: { addressLine1: { endsWith: "Filled Ln" } } })).toBe(40);
    expect(await prisma.client.count({ where: { mailingSameAsAddress: false, mailingAddressLine1: "PO Box 77" } })).toBe(20);
    expect(await prisma.client.count({ where: { tags: { isEmpty: true } } })).toBe(240);

    // Completing an Address Needed client on a later import clears the flag.
    const one = await prisma.client.findFirstOrThrow({ where: flagged, orderBy: { displayName: "asc" } });
    const fix = await stageImport(daria, { fileName: "fix.csv", source: "TaxAct", taxReturnDerived: true, mapping: MAPPING, rows: [{ fullName: one.displayName, email: one.email!, ...full }] });
    const [fr] = await rowsOf(fix.id);
    expect(fr.decision).toBe(`update:${one.id}`);
    await commitImport(daria, fix.id, "fill_blanks", { addressNeeded: "require" });
    const fixed = await prisma.client.findUniqueOrThrow({ where: { id: one.id } });
    expect(fixed.addressLine1).toBe(full.addressLine1);
    expect(fixed.tags).toEqual([]);
  }, 120_000);
});
