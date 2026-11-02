import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PDFDocument } from "pdf-lib";
import { makeUser, prisma, resetDb } from "./db";
import { ForbiddenError } from "@/lib/auth/actor";
import { createClient } from "@/lib/services/clients";
import { acceptPortalInvite, invitePortalUser } from "@/lib/services/portal-accounts";
import { staffUploadDocument } from "@/lib/services/documents";
import { businessFamily, linkBusiness, linkImpact, unlinkBusiness } from "@/lib/services/related-businesses";
import { nonprofitsForClient } from "@/lib/services/nonprofit-links";
import { ensurePortfolio, savePortfolio } from "@/lib/services/nonprofit-portfolio";

beforeEach(async () => {
  await resetDb();
  vi.stubEnv("MALWARE_SCAN_URL", "https://scanner.test/scan");
  vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ clean: true }), { status: 200 }));
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

const pdf = async () => {
  const d = await PDFDocument.create();
  d.addPage([200, 200]);
  d.setTitle(String(Math.random()));
  return d.save();
};

/** The reported case with fictional contact details: the foundation belongs to James; a wrong link put it under Felicity too. */
async function setup() {
  const admin = await makeUser("ADMIN", "Owner Admin");
  const staff = await makeUser("STAFF", "Staff Member");
  const felicity = await createClient(admin, { firstName: "Felicity", lastName: "Johnson", clientType: "INDIVIDUAL", status: "ACTIVE", email: "felicity@fictional.example" });
  const james = await createClient(admin, { firstName: "James", lastName: "Bradley", clientType: "INDIVIDUAL", status: "ACTIVE", email: "james@fictional.example" });
  const foundation = await createClient(admin, { businessName: "Bradley House Foundation", clientType: "NONPROFIT", status: "ACTIVE" });
  const llc = await createClient(admin, { businessName: "Fictional Other LLC", clientType: "BUSINESS", status: "ACTIVE" });
  await linkBusiness(admin, james.id, foundation.id);
  await ensurePortfolio(admin, foundation.id);
  await savePortfolio(admin, foundation.id, { ein: "12-3456789" });
  const doc = await staffUploadDocument(admin, { clientId: foundation.id, category: "OTHER", visibility: "STAFF_ONLY", bytes: await pdf(), originalName: "articles.pdf" });
  // The wrong links, as they exist in production (created before the PR #36 guard).
  await prisma.clientRelationship.create({ data: { personClientId: felicity.id, businessClientId: foundation.id, role: "OWNER", createdById: staff.id } });
  await prisma.clientRelationship.create({ data: { personClientId: felicity.id, businessClientId: llc.id, role: "OWNER", createdById: staff.id } });
  return { admin, staff, felicity, james, foundation, llc, doc };
}

describe("Remove From This Client", () => {
  it("Admins only, with a reason; removes only Felicity's wrong link — the foundation, James's ownership, EIN, documents and portfolio stay", async () => {
    const { admin, staff, felicity, james, foundation, doc } = await setup();
    await expect(unlinkBusiness(staff, felicity.id, foundation.id, "Wrong client — verified with James")).rejects.toBeInstanceOf(ForbiddenError);
    await expect(unlinkBusiness(admin, felicity.id, foundation.id, "wrong")).rejects.toThrow(/Record why/);
    expect((await nonprofitsForClient(felicity.id)).orgs.map((o) => o.id)).toEqual([foundation.id]);
    await unlinkBusiness(admin, felicity.id, foundation.id, "Felicity has no relationship to this foundation (checked with the owner)");
    // Felicity's nonprofit list and business selector no longer show it.
    expect((await nonprofitsForClient(felicity.id)).orgs).toEqual([]);
    expect((await businessFamily(felicity.id))!.businesses.map((b) => b.id)).not.toContain(foundation.id);
    // Nothing else changed.
    expect((await businessFamily(foundation.id))!.anchor.id).toBe(james.id);
    expect(await prisma.client.count({ where: { id: foundation.id, archivedAt: null } })).toBe(1);
    expect((await prisma.nonprofitPortfolio.findUniqueOrThrow({ where: { clientId: foundation.id } })).ein).toBe("12-3456789");
    expect(await prisma.document.count({ where: { id: doc.id, deletedAt: null } })).toBe(1);
    // Audit on both records: who, when, why, and the removed link's details.
    const onClient = await prisma.auditLog.findFirstOrThrow({ where: { action: "client.business_unlinked", entityId: felicity.id } });
    expect([onClient.actorId, (onClient.details as { reason: string }).reason]).toEqual([admin.id, "Felicity has no relationship to this foundation (checked with the owner)"]);
    expect(await prisma.auditLog.count({ where: { action: "client.owner_link_removed", entityId: foundation.id } })).toBe(1);
  });

  it("the organization's original or only owner link needs its name typed — staff and Admins can't remove James's legitimate ownership by accident", async () => {
    const { admin, felicity, james, foundation, llc } = await setup();
    expect((await linkImpact(james.id, foundation.id))!.isPrimary).toBe(true);
    expect((await linkImpact(felicity.id, foundation.id))!.isPrimary).toBe(false);
    await expect(unlinkBusiness(admin, james.id, foundation.id, "Testing the guard on the real owner")).rejects.toThrow(/original owner link/);
    await expect(unlinkBusiness(admin, james.id, foundation.id, "Testing the guard on the real owner", { confirmName: "Bradley House" })).rejects.toThrow(/type the organization's name/);
    expect(await prisma.clientRelationship.count({ where: { personClientId: james.id, businessClientId: foundation.id } })).toBe(1);
    // Works the same for an incorrectly linked LLC: it's Felicity's only link to it, so it also needs the name.
    await expect(unlinkBusiness(admin, felicity.id, llc.id, "This LLC isn't Felicity's")).rejects.toThrow(/only owner link/);
    await unlinkBusiness(admin, felicity.id, llc.id, "This LLC isn't Felicity's", { confirmName: "fictional other llc" });
    expect(await prisma.client.count({ where: { id: llc.id, archivedAt: null } })).toBe(1);
  });

  it("portal access and Square bills are flagged for review, not changed", async () => {
    const { admin, felicity, foundation } = await setup();
    const { token } = await invitePortalUser(admin, felicity.id, { email: "felicity@fictional.example", name: "Felicity", role: "OWNER" });
    const login = await acceptPortalInvite(token!, "Portal-Pass-123456");
    await prisma.portalAccess.create({ data: { portalUserId: login.id, clientId: foundation.id, role: "OWNER", grantedById: admin.id } });
    await prisma.squareBillingArrangement.create({ data: { squareCustomerId: "CUST_F", squareLocationId: "LOC_F", seriesKey: "s-f", linkedById: admin.id, members: { create: [{ clientId: felicity.id, addedById: admin.id }, { clientId: foundation.id, addedById: admin.id }] } } });
    const impact = await unlinkBusiness(admin, felicity.id, foundation.id, "Felicity has no relationship to this foundation");
    expect(impact.flags).toHaveLength(2);
    expect(impact.flags.join(" ")).toMatch(/portal logins can open this organization/);
    expect(impact.flags.join(" ")).toMatch(/Square bill/);
    // Flagged, not silently changed.
    expect(await prisma.portalAccess.count({ where: { portalUserId: login.id, clientId: foundation.id, revokedAt: null } })).toBe(1);
    expect(await prisma.squareBillingMember.count({ where: { clientId: foundation.id } })).toBe(1);
    const log = await prisma.auditLog.findFirstOrThrow({ where: { action: "client.business_unlinked", entityId: felicity.id } });
    expect((log.details as { flaggedForReview: string[] }).flaggedForReview).toHaveLength(2);
  });
});
