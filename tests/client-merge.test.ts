// Fictional clients only. Duplicate review, merge, joint-name repair and the
// imported-data check.
import { beforeEach, describe, expect, it } from "vitest";
import { makeUser, prisma, resetDb } from "./db";
import { createClient, updateClient } from "@/lib/services/clients";
import { mergeClients, mergePreview, possibleDuplicates } from "@/lib/services/client-merge";
import { incompleteClients, proposedJointRepair, repairJointName } from "@/lib/services/client-repair";
import { ForbiddenError } from "@/lib/auth/actor";
import { stageImport } from "@/lib/services/imports";

beforeEach(resetDb);

async function attachHistory(clientId: string, staffId: string, tag: string) {
  const file = await prisma.storedFile.create({ data: { kind: "CLIENT_DOCUMENT", storageKey: `k-${tag}`, originalName: `${tag}.pdf`, title: tag, mimeType: "application/pdf", sizeBytes: 10 } });
  await prisma.document.create({ data: { clientId, category: "TAXES", title: `${tag} W-2`, fileId: file.id, year: 2025 } });
  await prisma.taxPrepCase.create({ data: { clientId, taxYear: tag === "dup" ? 2024 : 2025, returnType: "1040_MFJ", spouseFirstName: "Jonathan", spouseLastName: "Scoggins" } });
  await prisma.questionnaireSubmission.create({ data: { clientId, taxYear: 2024, jotformFormId: "1", submissionId: `sub-${tag}`, source: "staff_import" } });
  await prisma.clientNote.create({ data: { clientId, authorId: staffId, body: `${tag} note` } });
  await prisma.manualBillingPayment.create({ data: { clientId, amountCents: 35000, paidOn: new Date("2026-10-01"), periodMonth: "2026-10", method: "CHECK", recordedById: staffId } });
}

describe("Duplicate review and merge", () => {
  it("moves tax cases, questionnaires, documents, notes, payments and the portal login to the kept record; archives (never deletes) the duplicate", async () => {
    const tab = await makeUser("ADMIN");
    const keep = await createClient(tab, { firstName: "Allison", middleName: "R", lastName: "Stockton", clientType: "INDIVIDUAL", status: "ACTIVE", email: "allison.s@example.com" });
    const dup = await prisma.client.create({ data: { firstName: "Allison R Stockton & Jonathan", lastName: "Scoggins", displayName: "Allison R Stockton & Jonathan Scoggins", clientType: "INDIVIDUAL", phone: "(205) 705-0028", phoneNormalized: "+12057050028", addressLine1: "12 Fictional Ridge Rd", city: "Hoover", state: "AL", postalCode: "35244", services: ["Tax Preparation"], spouseFirstName: "Jonathan", spouseLastName: "Scoggins", spouseEmail: "jonathan.s@example.com" } });
    await attachHistory(dup.id, tab.id, "dup");
    await prisma.auditLog.create({ data: { actorId: tab.id, action: "client.created", entityType: "Client", entityId: dup.id, clientId: dup.id } });
    const login = await prisma.portalUser.create({ data: { email: "allison.portal@example.com", name: "Allison" } });
    await prisma.portalAccess.create({ data: { portalUserId: login.id, clientId: dup.id, role: "OWNER" } });

    const preview = await mergePreview(keep.id, dup.id);
    expect(preview.conflicts).toEqual([]);
    expect(Object.fromEntries(preview.moves.map((m) => [m.label, m.count]))).toMatchObject({ Documents: 1, "Tax-preparation cases": 1, Questionnaires: 1, Notes: 1, "Manual billing payments": 1, "Portal access": 1 });
    expect(preview.fields.find((f) => f.field === "addressLine1")).toMatchObject({ outcome: "fill" });

    const staff = await makeUser("STAFF");
    await expect(mergeClients(staff, keep.id, dup.id, [], dup.displayName)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(mergeClients(tab, keep.id, dup.id, [], "wrong name")).rejects.toThrow(/Type the duplicate's name/);
    await mergeClients(tab, keep.id, dup.id, [], "Allison R Stockton & Jonathan Scoggins");

    const kept = await prisma.client.findUniqueOrThrow({ where: { id: keep.id } });
    expect([kept.firstName, kept.middleName, kept.lastName]).toEqual(["Allison", "R", "Stockton"]); // kept record's own values stay
    expect([kept.addressLine1, kept.city, kept.phone, kept.spouseFirstName, kept.spouseEmail]).toEqual(["12 Fictional Ridge Rd", "Hoover", "(205) 705-0028", "Jonathan", "jonathan.s@example.com"]);
    expect(kept.email).toBe("allison.s@example.com");
    expect(kept.displayName).toBe("Allison R Stockton & Jonathan Scoggins");
    expect(kept.services).toEqual(["Tax Preparation"]);
    for (const [model, n] of [["document", 1], ["taxPrepCase", 1], ["questionnaireSubmission", 1], ["clientNote", 1], ["manualBillingPayment", 1], ["portalAccess", 1]] as const) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect(await (prisma as any)[model].count({ where: { clientId: keep.id } }), model).toBe(n);
    }
    // The portal login now opens the kept record.
    expect((await prisma.portalAccess.findFirstOrThrow({ where: { portalUserId: login.id } })).clientId).toBe(keep.id);
    const gone = await prisma.client.findUniqueOrThrow({ where: { id: dup.id } });
    expect(gone).toMatchObject({ mergedIntoId: keep.id, status: "INACTIVE" });
    expect(gone.archivedAt).not.toBeNull();
    // Audit history stays with the archived record, and both sides log the merge.
    expect(await prisma.auditLog.count({ where: { clientId: dup.id, action: "client.created" } })).toBe(1);
    expect(await prisma.auditLog.count({ where: { action: { in: ["client.merged_in", "client.merged_away"] } } })).toBe(2);
  });

  it("refuses to merge while both records hold the same tax year, the same portal login, or different TaxAct IDs", async () => {
    const tab = await makeUser("ADMIN");
    const a = await createClient(tab, { firstName: "Marisol", lastName: "Vance", clientType: "INDIVIDUAL", status: "ACTIVE" });
    const b = await createClient(tab, { firstName: "Marisol", lastName: "Vance", clientType: "INDIVIDUAL", status: "ACTIVE" });
    await prisma.taxPrepCase.createMany({ data: [{ clientId: a.id, taxYear: 2025 }, { clientId: b.id, taxYear: 2025 }] });
    const login = await prisma.portalUser.create({ data: { email: "m.vance@example.com", name: "Marisol" } });
    await prisma.portalAccess.createMany({ data: [{ portalUserId: login.id, clientId: a.id }, { portalUserId: login.id, clientId: b.id }] });
    await prisma.client.update({ where: { id: a.id }, data: { taxSoftwareId: "TA-1" } });
    await prisma.client.update({ where: { id: b.id }, data: { taxSoftwareId: "TA-2" } });
    const p = await mergePreview(a.id, b.id);
    expect(p.conflicts.join(" ")).toMatch(/tax-preparation case for the same tax year/);
    expect(p.conflicts.join(" ")).toMatch(/same portal login/);
    expect(p.conflicts.join(" ")).toMatch(/different TaxAct client IDs/);
    await expect(mergeClients(tab, a.id, b.id, [], "Marisol Vance")).rejects.toThrow(/Resolve these first/);
    expect(await prisma.client.count({ where: { archivedAt: null } })).toBe(2);
  });

  it("lists possible duplicates for review (email, phone, spouse, name) and never merges them on its own", async () => {
    const tab = await makeUser("ADMIN");
    await createClient(tab, { firstName: "Allison", lastName: "Stockton", clientType: "INDIVIDUAL", status: "ACTIVE" });
    await createClient(tab, { firstName: "Allison", middleName: "R", lastName: "Stockton", clientType: "INDIVIDUAL", status: "ACTIVE", spouseFirstName: "Jonathan", spouseLastName: "Scoggins", spouseEmail: "jon@example.com" });
    await createClient(tab, { firstName: "Jonathan", lastName: "Scoggins", clientType: "INDIVIDUAL", status: "ACTIVE", email: "jon@example.com" });
    const pairs = await possibleDuplicates();
    expect(pairs.length).toBe(2);
    expect(pairs.some((p) => p.why.includes("Same email"))).toBe(true); // spouse email = the separate Jonathan record
    expect(pairs.some((p) => p.why.includes("Same name"))).toBe(true); // "Allison Stockton" vs "Allison R Stockton"
    expect(await prisma.client.count({ where: { archivedAt: null } })).toBe(3);
  });
});

describe("Import matching never creates a duplicate on its own", () => {
  it("a name that matches an existing person or spouse needs a staff decision instead of an automatic create", async () => {
    const tab = await makeUser("ADMIN");
    const a = await createClient(tab, { firstName: "Allison", lastName: "Stockton", clientType: "INDIVIDUAL", status: "ACTIVE" }); // no middle initial, no contact info
    const j = await createClient(tab, { firstName: "Jonathan", lastName: "Scoggins", clientType: "INDIVIDUAL", status: "ACTIVE" });
    const batch = await stageImport(tab, {
      fileName: "t.csv",
      source: "TaxAct",
      taxReturnDerived: true,
      mapping: { "Client Name": "fullName", City: "city" },
      rows: [{ fullName: "Allison R Stockton & Jonathan Scoggins", city: "Hoover" }, { fullName: "Brand New Person" }, { fullName: "Brand New Person" }],
    });
    const rows = await prisma.importRow.findMany({ where: { batchId: batch.id }, orderBy: { rowNumber: "asc" } });
    expect(rows[0].match).toBe("AMBIGUOUS");
    expect(rows[0].decision).toBeNull(); // never defaults to create
    expect(new Set(rows[0].candidateIds)).toEqual(new Set([a.id, j.id]));
    expect(rows[1].match).toBe("NEW");
    expect(rows[2].match).toBe("AMBIGUOUS"); // same name twice in the file
    expect(rows[2].warnings.join()).toMatch(/Same name as row 3/);
  });
});

describe("Joint-name repair, Edit Client spouse section and the data check", () => {
  it("splits a two-person name into taxpayer and spouse on the same record, only after staff confirm", async () => {
    const tab = await makeUser("ADMIN");
    const c = await prisma.client.create({ data: { firstName: "Allison R Stockton & Jonathan", lastName: "Scoggins", displayName: "Allison R Stockton & Jonathan Scoggins", clientType: "INDIVIDUAL", taxReturnDerived: true } });
    expect(proposedJointRepair(c)).toEqual({ firstName: "Allison", middleName: "R", lastName: "Stockton", spouseFirstName: "Jonathan", spouseMiddleName: null, spouseLastName: "Scoggins" });
    const before = await incompleteClients();
    expect(before[0].missing).toEqual(expect.arrayContaining(["Mailing address", "Phone", "Assigned staff", "Name holds two people", "Tax-preparation case"]));
    await repairJointName(tab, c.id, { firstName: "Allison", middleName: "R", lastName: "Stockton", spouseFirstName: "Jonathan", spouseMiddleName: "", spouseLastName: "Scoggins" });
    const after = await prisma.client.findUniqueOrThrow({ where: { id: c.id } });
    expect([after.firstName, after.middleName, after.lastName, after.spouseFirstName, after.spouseLastName, after.displayName]).toEqual(["Allison", "R", "Stockton", "Jonathan", "Scoggins", "Allison R Stockton & Jonathan Scoggins"]);
    expect(await prisma.client.count()).toBe(1);
    expect(await prisma.auditLog.count({ where: { action: "client.joint_name_repaired" } })).toBe(1);
  });

  it("Edit Client saves middle name and spouse details, cleans phones, and keeps the household name", async () => {
    const tab = await makeUser("ADMIN");
    const daria = await makeUser("STAFF", "Daria");
    const c = await createClient(tab, { firstName: "Allison", lastName: "Stockton", clientType: "INDIVIDUAL", status: "ACTIVE" });
    await updateClient(tab, c.id, { firstName: "Allison", middleName: "R", lastName: "Stockton", phone: "(205)705-0028 M", spouseFirstName: "Jonathan", spouseLastName: "Scoggins", spousePhone: "205-555-0123 C", spouseEmail: "jonathan.s@example.com", clientType: "INDIVIDUAL", status: "ACTIVE", assignedToId: daria.id });
    const u = await prisma.client.findUniqueOrThrow({ where: { id: c.id } });
    expect([u.phone, u.phoneNormalized, u.spousePhone, u.spousePhoneNormalized]).toEqual(["(205) 705-0028", "+12057050028", "(205) 555-0123", "+12055550123"]);
    expect(u.displayName).toBe("Allison R Stockton & Jonathan Scoggins");
    expect(u.assignedToId).toBe(daria.id);
    await expect(updateClient(tab, c.id, { firstName: "Allison", lastName: "Stockton", spouseEmail: "not-an-email", clientType: "INDIVIDUAL", status: "ACTIVE" })).rejects.toThrow(/spouse's email/);
  });
});
