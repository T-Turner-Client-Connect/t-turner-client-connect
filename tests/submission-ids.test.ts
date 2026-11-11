import { beforeEach, describe, expect, it } from "vitest";
import { makeUser, prisma, resetDb } from "./db";
import { ForbiddenError } from "@/lib/auth/actor";
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
    const tabitha = await makeUser("ADMIN", "Tabitha");
    await prisma.ownerAccess.create({ data: { userId: tabitha.id, isPrimary: true } });
    const daria = await makeUser("STAFF", "Daria");
    const marlow = await createClient(tabitha, { firstName: "Marlow", lastName: "Fennick", clientType: "INDIVIDUAL", status: "ACTIVE" });
    await prisma.client.update({ where: { id: marlow.id }, data: { spouseFirstName: "Juniper", spouseLastName: "Fennick" } });
    const corin = await createClient(tabitha, { firstName: "Corin", lastName: "Ashby", clientType: "INDIVIDUAL", status: "ACTIVE" });
    await prisma.client.update({ where: { id: corin.id }, data: { state: "AL" } });
    const biz = await createClient(tabitha, { businessName: "Willow Example Agency LLC", clientType: "BUSINESS", status: "ACTIVE" });
    const twinA = await createClient(tabitha, { firstName: "Avery", lastName: "Quill", clientType: "INDIVIDUAL", status: "ACTIVE" });
    const twinB = await createClient(tabitha, { firstName: "Avery", lastName: "Quill", clientType: "INDIVIDUAL", status: "ACTIVE" });
    return { tabitha, daria, marlow, corin, biz, twinA, twinB };
  }

  it("verified client ID first; a name applies on its own only when it fits one client AND another identifier supports it; everything else waits for review", async () => {
    const s = await setup();
    await prisma.client.update({ where: { id: s.twinA.id }, data: { taxSoftwareId: "TA-7001" } });
    const batch = await stageTaxImport(s.daria, {
      fileName: "efile-details.csv",
      source: "TaxAct E-file Details",
      mapping: { "Client ID": "clientRef", ...MAP },
      statusFilter: ["ACCEPTED"],
      rows: [
        // Joint return: both spouses' names match the client, for each year and each return.
        row("FENNICK, MARLOW & JUNIPER", "2023", "Federal", "FED-2023-MF"),
        row("FENNICK, MARLOW & JUNIPER", "2024", "Federal", "FED-2024-MF"),
        row("FENNICK, MARLOW & JUNIPER", "2024", "AL", "AL-2024-MF"),
        // Single name, state return in the client's state on file: supported.
        row("Corin Ashby", "2025", "AL", "AL-2025-CA"),
        // Single name, federal, nothing else on file: review.
        row("Corin Ashby", "2025", "Federal", "FED-2025-CA"),
        // A business name with nothing else on file: review.
        row("Willow Example Agency, LLC", "2025", "Federal", "FED-2025-WE", "1120-S"),
        // A name two clients share, with the verified TaxAct client ID: the ID decides.
        { ...row("Quill, Avery", "2025", "Federal", "FED-2025-AQ"), clientRef: "TA-7001" },
        // The same shared name without an ID: review.
        row("Quill, Avery", "2024", "Federal", "FED-2024-AQ"),
        row("Nobody Example", "2025", "Federal", "FED-2025-NE"),
      ],
    });
    const rows = await prisma.taxImportRow.findMany({ where: { batchId: batch.id }, orderBy: { rowNumber: "asc" } });
    expect(rows.map((r) => [r.match, r.decision])).toEqual([
      ["NEW_FILING", "apply"], ["NEW_FILING", "apply"], ["NEW_FILING", "apply"],
      ["NEW_FILING", "apply"],
      ["AMBIGUOUS", null],
      ["AMBIGUOUS", null],
      ["NEW_FILING", "apply"],
      ["AMBIGUOUS", null],
      ["NO_CLIENT", null],
    ]);
    expect(rows[0].warnings.join()).toMatch(/confirmed: both spouses' names match/);
    expect(rows[3].warnings.join()).toMatch(/confirmed: the client's state on file is AL/);
    expect(rows[4]).toMatchObject({ clientId: s.corin.id });
    expect(rows[4].warnings.join()).toMatch(/nothing else on file confirms it/);
    expect(rows[5].clientId).toBe(s.biz.id);
    expect(rows[6].clientId).toBe(s.twinA.id);
    expect(rows[7]).toMatchObject({ clientId: null });
    expect(rows[7].warnings.join()).toMatch(/fits more than one client/);
    expect(await prisma.filingRecord.count()).toBe(0); // preview only

    // Staff confirm the suggested business, choose the right twin, and skip the rest.
    await decideTaxRow(s.daria, rows[5].id, "apply");
    await decideTaxRow(s.daria, rows[7].id, "apply", s.twinB.id);
    await decideTaxRow(s.daria, rows[4].id, "skip");
    await decideTaxRow(s.daria, rows[8].id, "skip");
    expect(await commitTaxImport(s.daria, batch.id, false)).toEqual({ applied: 7, skipped: 2 });
    // Each federal and state return keeps its own ID.
    const refs = await prisma.filingRecord.findMany({ where: { clientId: s.marlow.id }, orderBy: [{ taxYear: "asc" }, { jurisdiction: "asc" }] });
    expect(refs.map((f) => [f.taxYear, f.jurisdiction, f.filingReference, f.filingStatus, f.statusSource])).toEqual([
      [2023, "FEDERAL", "FED-2023-MF", "ACCEPTED", "TAXACT_IMPORT"],
      [2024, "AL", "AL-2024-MF", "ACCEPTED", "TAXACT_IMPORT"],
      [2024, "FEDERAL", "FED-2024-MF", "ACCEPTED", "TAXACT_IMPORT"],
    ]);
    expect(await prisma.filingRecord.count({ where: { clientId: s.corin.id, jurisdiction: "FEDERAL" } })).toBe(0);
    // The import source is kept with each filing for auditing.
    const ev = await prisma.filingStatusEvent.findFirstOrThrow({ where: { filingId: refs[0].id } });
    expect(ev).toMatchObject({ source: "TAXACT_IMPORT", importBatchId: batch.id });

    // "Finish & Send a Return" fills in the IDs already saved (nobody types them).
    const ctx = await deliveryContext(s.marlow.id, s.daria);
    expect(ctx.refs).toMatchObject({ "2024:FEDERAL:ORIGINAL": "FED-2024-MF", "2024:AL:ORIGINAL": "AL-2024-MF", "2023:FEDERAL:ORIGINAL": "FED-2023-MF" });
  });

  it("a missing ID is filled in; an ID already on file is never replaced without Tabitha's approval", async () => {
    const s = await setup();
    const fed = await prisma.filingRecord.create({ data: { clientId: s.marlow.id, taxYear: 2024, returnType: "1040", jurisdiction: "FEDERAL", filingStatus: "ACCEPTED", statusAsOf: new Date("2025-05-01"), statusSource: "STAFF" } });
    const al = await prisma.filingRecord.create({ data: { clientId: s.marlow.id, taxYear: 2024, returnType: "1040", jurisdiction: "AL", filingStatus: "SUBMITTED", statusAsOf: new Date("2025-01-01"), filingReference: "AL-OLD" } });
    const w = await prisma.filingRecord.create({ data: { clientId: s.biz.id, taxYear: 2024, returnType: "1120-S", jurisdiction: "FEDERAL", filingStatus: "SUBMITTED", statusAsOf: new Date("2024-01-01"), filingReference: "OLD-REF" } });
    const batch = await stageTaxImport(s.daria, {
      fileName: "efile-2024.csv", source: "TaxAct E-file Details", mapping: MAP, statusFilter: ["ACCEPTED"],
      rows: [row("Marlow Fennick", "2024", "Federal", "FED-2024-MF"), row("Marlow Fennick", "2024", "AL", "AL-NEW"), row("Willow Example Agency LLC", "2024", "Federal", "NEW-REF", "1120-S")],
    });
    const rows = await prisma.taxImportRow.findMany({ where: { batchId: batch.id }, orderBy: { rowNumber: "asc" } });
    expect(rows.map((r) => [r.match, r.decision])).toEqual([["MATCH", "apply"], ["MATCH", "apply"], ["MATCH", "apply"]]);
    expect(rows[0].warnings.join()).toMatch(/Only the missing Submission ID will be saved/);
    expect(rows[1].warnings.join()).toMatch(/A different Submission ID is on file \(AL-OLD\). It is kept unless Tabitha approves/);
    // Only Tabitha can approve replacing an ID.
    await expect(decideTaxRow(s.daria, rows[2].id, "replace_id")).rejects.toBeInstanceOf(ForbiddenError);
    await decideTaxRow(s.tabitha, rows[2].id, "replace_id");
    await commitTaxImport(s.daria, batch.id, false);
    const [f1, f2, f3] = await Promise.all([fed, al, w].map((f) => prisma.filingRecord.findUniqueOrThrow({ where: { id: f.id } })));
    expect([f1.filingReference, f1.filingStatus, f1.statusSource]).toEqual(["FED-2024-MF", "ACCEPTED", "STAFF"]); // status untouched
    expect([f2.filingReference, f2.filingStatus]).toEqual(["AL-OLD", "ACCEPTED"]); // status updated, ID kept
    expect(f3.filingReference).toBe("NEW-REF"); // replaced with Tabitha's approval
    expect(await prisma.auditLog.findFirstOrThrow({ where: { action: "filing.submission_id_replaced", entityId: w.id } })).toMatchObject({ details: expect.objectContaining({ from: "OLD-REF", to: "NEW-REF", approvedById: s.tabitha.id, source: "TaxAct E-file Details", fileName: "efile-2024.csv" }) });
    expect(await prisma.auditLog.findFirstOrThrow({ where: { action: "filing.submission_id_imported", entityId: fed.id } })).toMatchObject({ details: expect.objectContaining({ submissionId: "FED-2024-MF", batchId: batch.id, source: "TaxAct E-file Details" }) });
  });
});
