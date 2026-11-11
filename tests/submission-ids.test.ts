import { beforeEach, describe, expect, it } from "vitest";
import { makeUser, prisma, resetDb } from "./db";
import { createClient } from "@/lib/services/clients";
import { commitTaxImport, decideTaxRow, stageTaxImport } from "@/lib/services/tax";
import { deliveryContext } from "@/lib/services/accepted-returns";
import { matchByName, nameIndex, rowNameKeys } from "@/lib/tax/name-match";

// Fictional people and businesses only.
beforeEach(resetDb);

// A TaxAct E-file Details export with no client ID column: matched by name.
const MAP = { "Taxpayer Name": "displayName", Year: "taxYear", Form: "returnType", Jurisdiction: "jurisdiction", Status: "status", "Status Date": "statusDate", "Submission ID": "submissionId" };
const row = (name: string, year: string, juris: string, sub: string, form = "1040") => ({ displayName: name, taxYear: year, returnType: form, jurisdiction: juris, status: "Accepted", statusDate: `03/14/${Number(year) + 1}`, submissionId: sub });

describe("matching TaxAct names to clients", () => {
  it("reads the ways TaxAct writes names: last-first, joint, initials, suffixes and business endings", () => {
    const idx = nameIndex([
      { id: "c1", displayName: "Marlow Fennick", firstName: "Marlow", lastName: "Fennick", spouseFirstName: "Juniper", spouseLastName: "Fennick" },
      { id: "c2", displayName: "Willow Example Agency LLC", businessName: "Willow Example Agency LLC" },
      { id: "c3", displayName: "Corin Ashby Jr", firstName: "Corin", lastName: "Ashby" },
    ]);
    expect(matchByName(idx, "FENNICK, MARLOW Q & JUNIPER R")).toEqual(["c1"]);
    expect(matchByName(idx, "Marlow Q. & Juniper R. Fennick")).toEqual(["c1"]);
    expect(matchByName(idx, "Juniper Fennick")).toEqual(["c1"]); // the spouse on a joint return
    expect(matchByName(idx, "Willow Example Agency, L.L.C.")).toEqual(["c2"]);
    expect(matchByName(idx, "ASHBY, CORIN JR")).toEqual(["c3"]);
    expect(matchByName(idx, "Someone Else")).toEqual([]);
    expect(rowNameKeys("")).toEqual([]);
  });
});

describe("Submission IDs from the TaxAct E-file Details report", () => {
  async function setup() {
    const staff = await makeUser("ADMIN", "Tabitha");
    const marlow = await createClient(staff, { firstName: "Marlow", lastName: "Fennick", clientType: "INDIVIDUAL", status: "ACTIVE" });
    await prisma.client.update({ where: { id: marlow.id }, data: { spouseFirstName: "Juniper", spouseLastName: "Fennick" } });
    const biz = await createClient(staff, { businessName: "Willow Example Agency LLC", clientType: "BUSINESS", status: "ACTIVE" });
    const twinA = await createClient(staff, { firstName: "Avery", lastName: "Quill", clientType: "INDIVIDUAL", status: "ACTIVE" });
    const twinB = await createClient(staff, { firstName: "Avery", lastName: "Quill", clientType: "INDIVIDUAL", status: "ACTIVE" });
    return { staff, marlow, biz, twinA, twinB };
  }

  it("fills federal and state Submission IDs for several years by name, sends look-alike names to review, and the return upload screen shows them", async () => {
    const s = await setup();
    const batch = await stageTaxImport(s.staff, {
      fileName: "efile-details.csv",
      source: "TaxAct E-file Details",
      mapping: MAP,
      statusFilter: ["ACCEPTED"],
      rows: [
        row("FENNICK, MARLOW & JUNIPER", "2023", "Federal", "FED-2023-MF"),
        row("FENNICK, MARLOW & JUNIPER", "2024", "Federal", "FED-2024-MF"),
        row("FENNICK, MARLOW & JUNIPER", "2024", "AL", "AL-2024-MF"),
        row("FENNICK, MARLOW & JUNIPER", "2025", "Federal", "FED-2025-MF"),
        row("Willow Example Agency, LLC", "2025", "Federal", "FED-2025-WE", "1120-S"),
        row("Quill, Avery", "2025", "Federal", "FED-2025-AQ"),
        row("Nobody Example", "2025", "Federal", "FED-2025-NE"),
      ],
    });
    const rows = await prisma.taxImportRow.findMany({ where: { batchId: batch.id }, orderBy: { rowNumber: "asc" } });
    expect(rows.map((r) => r.match)).toEqual(["NEW_FILING", "NEW_FILING", "NEW_FILING", "NEW_FILING", "NEW_FILING", "AMBIGUOUS", "NO_CLIENT"]);
    expect(rows.slice(0, 4).every((r) => r.clientId === s.marlow.id && r.decision === "apply")).toBe(true);
    expect(rows[0].warnings.join()).toMatch(/Matched by name: Marlow Fennick/);
    expect(rows[4].clientId).toBe(s.biz.id);
    // Two clients share a name: nothing is applied until a person chooses.
    expect(rows[5]).toMatchObject({ clientId: null, decision: null });
    expect(rows[5].warnings.join()).toMatch(/fits more than one client/);
    expect(await prisma.filingRecord.count()).toBe(0); // preview only

    await decideTaxRow(s.staff, rows[5].id, "apply", s.twinB.id);
    await decideTaxRow(s.staff, rows[6].id, "skip");
    expect(await commitTaxImport(s.staff, batch.id, false)).toEqual({ applied: 6, skipped: 1 });
    const refs = await prisma.filingRecord.findMany({ where: { clientId: s.marlow.id }, orderBy: [{ taxYear: "asc" }, { jurisdiction: "asc" }], select: { taxYear: true, jurisdiction: true, filingReference: true, filingStatus: true } });
    expect(refs.map((f) => [f.taxYear, f.jurisdiction, f.filingReference, f.filingStatus])).toEqual([
      [2023, "FEDERAL", "FED-2023-MF", "ACCEPTED"],
      [2024, "AL", "AL-2024-MF", "ACCEPTED"],
      [2024, "FEDERAL", "FED-2024-MF", "ACCEPTED"],
      [2025, "FEDERAL", "FED-2025-MF", "ACCEPTED"],
    ]);
    expect(await prisma.filingRecord.count({ where: { clientId: s.twinA.id } })).toBe(0);

    // "Finish & Send a Return" fills each Submission ID in for the year (nobody types it).
    const ctx = await deliveryContext(s.marlow.id, s.staff);
    expect(ctx.refs).toMatchObject({ "2024:FEDERAL:ORIGINAL": "FED-2024-MF", "2024:AL:ORIGINAL": "AL-2024-MF", "2023:FEDERAL:ORIGINAL": "FED-2023-MF" });
  });

  it("an up-to-date filing missing its Submission ID gets it; one already on file is replaced only when a person leaves the row in", async () => {
    const s = await setup();
    // A filing already accepted (entered by hand), with no Submission ID.
    await prisma.filingRecord.create({ data: { clientId: s.marlow.id, taxYear: 2024, returnType: "1040", jurisdiction: "FEDERAL", filingStatus: "ACCEPTED", statusAsOf: new Date("2025-05-01"), statusSource: "STAFF" } });
    await prisma.filingRecord.create({ data: { clientId: s.biz.id, taxYear: 2024, returnType: "1120-S", jurisdiction: "FEDERAL", filingStatus: "ACCEPTED", statusAsOf: new Date("2024-01-01"), filingReference: "OLD-REF" } });
    const batch = await stageTaxImport(s.staff, {
      fileName: "efile-2024.csv", source: "TaxAct", mapping: MAP, statusFilter: ["ACCEPTED"],
      rows: [row("Marlow Fennick", "2024", "Federal", "FED-2024-MF"), row("Willow Example Agency LLC", "2024", "Federal", "NEW-REF", "1120-S")],
    });
    const rows = await prisma.taxImportRow.findMany({ where: { batchId: batch.id }, orderBy: { rowNumber: "asc" } });
    expect(rows[0]).toMatchObject({ match: "MATCH", decision: "apply" });
    expect(rows[0].warnings.join()).toMatch(/Only the missing Submission ID will be saved/);
    expect(rows[1].warnings.join()).toMatch(/Replaces the Submission ID on file \(OLD-REF\)/);
    await decideTaxRow(s.staff, rows[1].id, "skip"); // keep the ID on file
    await commitTaxImport(s.staff, batch.id, false);
    const [m, w] = await Promise.all([
      prisma.filingRecord.findFirstOrThrow({ where: { clientId: s.marlow.id } }),
      prisma.filingRecord.findFirstOrThrow({ where: { clientId: s.biz.id } }),
    ]);
    expect([m.filingReference, m.filingStatus, m.statusSource]).toEqual(["FED-2024-MF", "ACCEPTED", "STAFF"]);
    expect(w.filingReference).toBe("OLD-REF");
    expect(await prisma.auditLog.count({ where: { action: "filing.submission_id_imported", entityId: m.id } })).toBe(1);
  });
});
