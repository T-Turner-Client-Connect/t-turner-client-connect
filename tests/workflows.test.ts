import { beforeEach, describe, expect, it } from "vitest";
import { makeUser, prisma, resetDb } from "./db";
import { commitImport, ImportError, setRowDecision, stageImport } from "@/lib/services/imports";
import { addSuppression, createClient, recordConsent, saveContact, setArchived, ValidationError } from "@/lib/services/clients";
import { campaignRecipients, createCampaign, setAudience, setExclusions } from "@/lib/services/campaigns";
import { ForbiddenError } from "@/lib/auth/actor";
import { acceptInvite, createInvite, createPasswordReset, resetPassword, updateStaff } from "@/lib/services/users";
import { deleteGroup, liftSuppression } from "@/lib/services/clients";
import { saveUpload } from "@/lib/services/files";

beforeEach(resetDb);

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 10, 0, 0, 0, 10, 8, 2, 0, 0, 0]);

describe("TaxAct-style contact import", () => {
  it("detects duplicates on re-import and updates instead of duplicating", async () => {
    const daria = await makeUser("STAFF");
    const rows = [
      { firstName: "Avery", lastName: "Lindqvist", email: "Avery@Example.com", phone: "(555) 010-0101" },
      { firstName: "Theo", lastName: "Brandt", phone: "555.010.0106" },
    ];
    const mapping = { "First Name": "firstName", "Last Name": "lastName", Email: "email", Phone: "phone" };
    const first = await stageImport(daria, { fileName: "taxact.csv", source: "TaxAct", taxReturnDerived: true, mapping, rows });
    await commitImport(daria, first.id, "fill_blanks");
    expect(await prisma.client.count()).toBe(2);

    // Same people again, formatted differently, plus a new city.
    const again = await stageImport(daria, {
      fileName: "taxact-2.csv",
      source: "TaxAct",
      taxReturnDerived: true,
      mapping: { ...mapping, City: "city" },
      rows: [
        { firstName: "Avery", lastName: "Lindqvist", email: "avery@example.com", phone: "+1 555 010 0101", city: "Springfield" },
        { firstName: "Theo", lastName: "Brandt", phone: "1-555-010-0106" },
      ],
    });
    const staged = await prisma.importRow.findMany({ where: { batchId: again.id }, orderBy: { rowNumber: "asc" } });
    expect(staged.map((r) => r.match)).toEqual(["MATCH", "MATCH"]);
    await commitImport(daria, again.id, "fill_blanks");
    expect(await prisma.client.count()).toBe(2);
    const avery = await prisma.client.findFirstOrThrow({ where: { lastName: "Lindqvist" } });
    expect(avery.city).toBe("Springfield");

    const batch = await prisma.importBatch.findUniqueOrThrow({ where: { id: again.id } });
    expect(batch.importedById).toBe(daria.id);
    expect(batch.source).toBe("TaxAct");
    expect(batch.committedAt).not.toBeNull();
    // Staged contact data is cleared after commit.
    expect((await prisma.importRow.findMany({ where: { batchId: again.id } })).every((r) => r.data === null)).toBe(true);
  });

  it("flags conflicting matches for staff review and requires a decision", async () => {
    const daria = await makeUser("STAFF");
    await createClient(daria, { firstName: "Avery", lastName: "Lindqvist", email: "avery@example.com", clientType: "INDIVIDUAL", status: "ACTIVE" });
    await createClient(daria, { firstName: "Marcus", lastName: "Oyelaran", phone: "5550100102", clientType: "INDIVIDUAL", status: "ACTIVE" });
    const batch = await stageImport(daria, {
      fileName: "x.csv",
      source: "TaxAct",
      taxReturnDerived: true,
      mapping: { a: "fullName", b: "email", c: "phone" },
      rows: [
        { fullName: "Avery Lindqvist", email: "avery@example.com", phone: "5550100102" }, // email -> Avery, phone -> Marcus
        { fullName: "Jordan Lindqvist", email: "avery@example.com" }, // same email, different person
        { fullName: "New Person", email: "new@example.com" },
        { fullName: "New Person Twin", email: "new@example.com" }, // duplicate inside the file
      ],
    });
    const rows = await prisma.importRow.findMany({ where: { batchId: batch.id }, orderBy: { rowNumber: "asc" } });
    expect(rows.map((r) => r.match)).toEqual(["AMBIGUOUS", "AMBIGUOUS", "NEW", "AMBIGUOUS"]);
    await expect(commitImport(daria, batch.id, "fill_blanks")).rejects.toThrow(/Needs review/);
    await setRowDecision(daria, rows[0].id, `update:${rows[0].candidateIds[0]}`);
    await setRowDecision(daria, rows[1].id, "create");
    await setRowDecision(daria, rows[3].id, "skip");
    const done = await commitImport(daria, batch.id, "fill_blanks");
    expect(done.createdCount).toBe(2);
    expect(done.updatedCount).toBe(1);
    expect(done.skippedCount).toBe(1);
  });

  it("preserves opt-outs and consent history when updating, and never grants consent", async () => {
    const daria = await makeUser("STAFF");
    const client = await createClient(daria, { firstName: "Avery", lastName: "Lindqvist", email: "avery@example.com", phone: "5550100101", clientType: "INDIVIDUAL", status: "ACTIVE" });
    await recordConsent(daria, client.id, { kind: "EMAIL_MARKETING", status: "REVOKED", source: "Asked by phone" });
    await addSuppression(daria, "SMS", "5550100101", "STOP");
    const before = await prisma.consentRecord.count();

    const batch = await stageImport(daria, {
      fileName: "x.csv",
      source: "TaxAct",
      taxReturnDerived: true,
      mapping: { n: "fullName", e: "email", p: "phone", t: "tags" },
      rows: [
        { fullName: "Avery Lindqvist", email: "avery@example.com", phone: "5550100101", tags: "2025 return" },
        { fullName: "Brand New", email: "brand.new@example.com", phone: "5550100199" },
      ],
    });
    await commitImport(daria, batch.id, "overwrite");

    expect(await prisma.consentRecord.count()).toBe(before);
    expect(await prisma.suppression.count({ where: { liftedAt: null } })).toBe(1);
    const created = await prisma.client.findFirstOrThrow({ where: { displayName: "Brand New" } });
    expect(await prisma.consentRecord.count({ where: { clientId: created.id } })).toBe(0);

    // Both remain ineligible for a promotion: Avery opted out, the new client is "unknown".
    const campaign = await createCampaign(daria, { title: "Spring promo", purpose: "TAX_PREP_PROMO", channel: "BOTH" });
    await setAudience(daria, campaign.id, { groupIds: [], clientIds: [client.id, created.id] });
    const r = await campaignRecipients(campaign.id);
    expect(r.eligible).toHaveLength(0);
    const reasons = r.excluded.map((e) => e.reason).join(" | ");
    expect(reasons).toMatch(/Opted out of promotional email/);
    expect(reasons).toMatch(/Replied STOP/);
    expect(reasons).toMatch(/No promotional email permission/);
  });

  it("refuses sensitive columns and ignores unmapped fields", async () => {
    const daria = await makeUser("STAFF");
    await expect(
      stageImport(daria, { fileName: "x.csv", source: "TaxAct", taxReturnDerived: true, mapping: { SSN: "notes", Name: "fullName" }, rows: [{ fullName: "A B", notes: "x" }] }),
    ).rejects.toBeInstanceOf(ImportError);
    const ok = await stageImport(daria, {
      fileName: "x.csv",
      source: "TaxAct",
      taxReturnDerived: true,
      mapping: { Name: "fullName" },
      // A tampered browser sends extra fields; only the mapped one is kept.
      rows: [{ fullName: "A B", email: "leak@example.com", ssn: "123-45-6789", dob: "1990-01-01" } as Record<string, unknown>],
    });
    const row = await prisma.importRow.findFirstOrThrow({ where: { batchId: ok.id } });
    expect(Object.keys(row.data as object).sort()).not.toContain("ssn");
    expect((row.data as { email: string | null }).email).toBeNull();
    expect(JSON.stringify(row.data)).not.toMatch(/123-45-6789|1990-01-01|leak@/);
  });
});

describe("campaign audience", () => {
  async function setup() {
    const tabitha = await makeUser("ADMIN");
    const group = await prisma.group.create({ data: { name: "Business Owners" } });
    const mk = async (first: string, email: string, phone?: string) => {
      const c = await createClient(tabitha, { firstName: first, lastName: "Test", email, phone, clientType: "BUSINESS", status: "ACTIVE", groupIds: [group.id] });
      await recordConsent(tabitha, c.id, { kind: "EMAIL_MARKETING", status: "GRANTED", source: "Consent page" });
      return c;
    };
    const a = await mk("Ana", "ana@example.com");
    const b = await mk("Ben", "ben@example.com");
    const shared = await mk("Cara", "office@example.com");
    const shared2 = await mk("Dev", "OFFICE@example.com");
    const campaign = await createCampaign(tabitha, { title: "Payroll promo", purpose: "OTHER_SERVICES_PROMO", channel: "EMAIL" });
    return { tabitha, group, a, b, shared, shared2, campaign };
  }

  it("keeps manual exclusions when the audience selection changes, without touching groups", async () => {
    const { tabitha, group, a, b, campaign } = await setup();
    await setAudience(tabitha, campaign.id, { groupIds: [group.id], clientIds: [] });
    await setExclusions(tabitha, campaign.id, [a.id], true, "Asked for a break");

    // Filters change: switch to individual picks, then back to the group.
    await setAudience(tabitha, campaign.id, { groupIds: [], clientIds: [a.id, b.id] });
    let r = await campaignRecipients(campaign.id);
    expect(r.eligible.map((x) => x.clientId)).toEqual([b.id]);
    expect(r.excluded.find((x) => x.clientId === a.id)?.reason).toMatch(/Removed from this campaign: Asked for a break/);

    await setAudience(tabitha, campaign.id, { groupIds: [group.id], clientIds: [] });
    r = await campaignRecipients(campaign.id);
    expect(r.eligible.some((x) => x.clientId === a.id)).toBe(false);
    // Still in the group, still a client.
    expect(await prisma.clientGroup.count({ where: { clientId: a.id, groupId: group.id } })).toBe(1);
    expect(await prisma.client.count({ where: { id: a.id, archivedAt: null } })).toBe(1);

    await setExclusions(tabitha, campaign.id, [a.id], false);
    r = await campaignRecipients(campaign.id);
    expect(r.eligible.some((x) => x.clientId === a.id)).toBe(true);
  });

  it("sends one message per shared address", async () => {
    const { tabitha, group, campaign } = await setup();
    await setAudience(tabitha, campaign.id, { groupIds: [group.id], clientIds: [] });
    const r = await campaignRecipients(campaign.id);
    const office = r.eligible.filter((x) => x.address === "office@example.com");
    expect(office).toHaveLength(1);
    expect(r.excluded.some((x) => /sent once/.test(x.reason))).toBe(true);
  });

  it("dedupes an additional contact that shares the client's number, and excludes archived clients", async () => {
    const { tabitha, a, campaign } = await setup();
    await prisma.campaign.update({ where: { id: campaign.id }, data: { purpose: "SERVICE", channel: "SMS" } });
    await prisma.client.update({ where: { id: a.id }, data: { phone: "5550100101", phoneNormalized: "+15550100101" } });
    await recordConsent(tabitha, a.id, { kind: "SMS_SERVICE", status: "GRANTED", source: "Intake form" });
    const contact = await saveContact(tabitha, a.id, null, { name: "Ana's assistant", phone: "(555) 010-0101" });
    await recordConsent(tabitha, a.id, { contactId: contact.id, kind: "SMS_SERVICE", status: "GRANTED", source: "Intake form" });
    await setAudience(tabitha, campaign.id, { groupIds: [], clientIds: [a.id] });
    let r = await campaignRecipients(campaign.id);
    expect(r.eligible).toHaveLength(1);

    await setArchived(tabitha, a.id, true);
    r = await campaignRecipients(campaign.id);
    expect(r.eligible).toHaveLength(0);
    expect(r.excluded[0].reason).toBe("Client is archived");
  });

  it("refuses edits to a campaign that is no longer a draft", async () => {
    const { tabitha, a, campaign } = await setup();
    await prisma.campaign.update({ where: { id: campaign.id }, data: { status: "SCHEDULED" } });
    await expect(setExclusions(tabitha, campaign.id, [a.id], true)).rejects.toBeInstanceOf(ValidationError);
  });
});

describe("roles and accounts", () => {
  it("restricts Admin-only actions for Staff", async () => {
    const tabitha = await makeUser("ADMIN");
    const daria = await makeUser("STAFF");
    const client = await createClient(daria, { firstName: "A", lastName: "B", clientType: "INDIVIDUAL", status: "ACTIVE" });
    const evidence = await saveUpload(daria, { kind: "CONSENT_EVIDENCE", bytes: PNG, originalName: "signed.png" });
    const group = await prisma.group.create({ data: { name: "G" } });
    const s = await addSuppression(daria, "EMAIL", "x@example.com", "MANUAL");

    await expect(createInvite(daria, { email: "new@example.com", name: "N", role: "STAFF" })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(updateStaff(daria, tabitha.id, { active: false })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(deleteGroup(daria, group.id)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(liftSuppression(daria, s.id, "client asked")).rejects.toBeInstanceOf(ForbiddenError);
    await expect(
      recordConsent(daria, client.id, { kind: "TAX_INFO_USE", status: "GRANTED", scope: "Bookkeeping promos", source: "Signed form", evidenceFileId: evidence.id }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    await expect(createPasswordReset(tabitha.email, daria)).rejects.toBeInstanceOf(ForbiddenError);

    // Staff may still record a revocation.
    await recordConsent(daria, client.id, { kind: "TAX_INFO_USE", status: "REVOKED", source: "Client called" });
  });

  it("requires evidence and scope for a 7216 grant, even for an Admin", async () => {
    const tabitha = await makeUser("ADMIN");
    const client = await createClient(tabitha, { firstName: "A", lastName: "B", clientType: "INDIVIDUAL", status: "ACTIVE" });
    await expect(recordConsent(tabitha, client.id, { kind: "TAX_INFO_USE", status: "GRANTED", source: "Checkbox", scope: "x" })).rejects.toThrow(/signed consent/);
    const evidence = await saveUpload(tabitha, { kind: "CONSENT_EVIDENCE", bytes: PNG, originalName: "signed.png" });
    const rec = await recordConsent(tabitha, client.id, { kind: "TAX_INFO_USE", status: "GRANTED", source: "Signed form", scope: "Bookkeeping promos", evidenceFileId: evidence.id });
    expect(rec.reviewedById).toBe(tabitha.id);
  });

  it("keeps at least one active Admin", async () => {
    const tabitha = await makeUser("ADMIN");
    await expect(updateStaff(tabitha, tabitha.id, { role: "STAFF" })).rejects.toThrow(/at least one active Admin/);
  });

  it("invite and reset links work once", async () => {
    const tabitha = await makeUser("ADMIN");
    const token = await createInvite(tabitha, { email: "daria@example.com", name: "Daria", role: "STAFF" });
    const user = await acceptInvite(token, "a-strong-passphrase-1");
    expect(user.role).toBe("STAFF");
    await expect(acceptInvite(token, "a-strong-passphrase-1")).rejects.toThrow(/invalid or has expired/);

    const reset = await createPasswordReset("daria@example.com", null);
    await prisma.session.create({ data: { userId: user.id, tokenHash: "abc", expiresAt: new Date(Date.now() + 1e6) } });
    await resetPassword(reset!.token, "another-strong-pass-2");
    expect(await prisma.session.count({ where: { userId: user.id } })).toBe(0);
    await expect(resetPassword(reset!.token, "another-strong-pass-3")).rejects.toThrow(/invalid or has expired/);
    expect(await createPasswordReset("nobody@example.com", null)).toBeNull();
  });

  it("rejects disguised uploads", async () => {
    const daria = await makeUser("STAFF");
    await expect(saveUpload(daria, { kind: "FLYER", bytes: new TextEncoder().encode("<svg onload=alert(1)>"), originalName: "flyer.png" })).rejects.toThrow(/PNG, JPG, PDF/);
  });
});
