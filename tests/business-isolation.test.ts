import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PDFDocument } from "pdf-lib";
import { makeUser, prisma, resetDb } from "./db";
import { ForbiddenError } from "@/lib/auth/actor";
import { createClient } from "@/lib/services/clients";
import { acceptPortalInvite, invitePortalUser } from "@/lib/services/portal-accounts";
import { authorizeDownload, downloadToken, portalDocuments, staffUploadDocument } from "@/lib/services/documents";
import { accessibleClients } from "@/lib/portal/access";
import { businessFamily, grantOwnerPortalAccess, unlinkBusiness, linkableBusinesses, linkBusiness, proposedLinks, relationshipReview } from "@/lib/services/related-businesses";
import { linkableNonprofits, linkExistingNonprofit, nonprofitsForClient } from "@/lib/services/nonprofit-links";
import { portalPortfolio } from "@/lib/services/nonprofit-portfolio";
import { addClientToSquareBilling } from "@/lib/services/square-billing";

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

/**
 * The reported case, with fictional contact details: Felicity Johnson and James
 * Bradley are unrelated clients; Bradley House Foundation belongs to James.
 */
async function setup() {
  const admin = await makeUser("ADMIN", "Owner Admin");
  const staff = await makeUser("STAFF", "Staff Member");
  const ada = await createClient(admin, { firstName: "Felicity", lastName: "Johnson", clientType: "INDIVIDUAL", status: "ACTIVE", email: "ada@fictional.example", phone: "555-010-1111" });
  const ben = await createClient(admin, { firstName: "James", lastName: "Bradley", clientType: "INDIVIDUAL", status: "ACTIVE", email: "ben@fictional.example", phone: "555-010-2222" });
  // The foundation shares a phone number with Felicity's record (a common way unrelated records look alike).
  const foundation = await createClient(admin, { businessName: "Bradley House Foundation", clientType: "NONPROFIT", status: "ACTIVE", phone: "555-010-1111" });
  await linkBusiness(admin, ben.id, foundation.id);
  const login = async (clientId: string, email: string) => {
    const { token } = await invitePortalUser(admin, clientId, { email, name: email, role: "OWNER" });
    const u = await acceptPortalInvite(token!, "Portal-Pass-123456");
    return { id: u.id, name: u.name, email: u.email };
  };
  const adaLogin = await login(ada.id, "ada@fictional.example");
  const benLogin = await login(ben.id, "ben@fictional.example");
  await grantOwnerPortalAccess(admin, ben.id, foundation.id, benLogin.id);
  return { admin, staff, ada, ben, foundation, adaLogin, benLogin };
}

describe("James Bradley's nonprofit can't be linked to Felicity Johnson's account", () => {
  it("another owner's business is never offered and can't be linked by staff — through any linking path", async () => {
    const { admin, staff, ada, ben, foundation } = await setup();
    expect((await linkableBusinesses(ada.id)).map((b) => b.id)).not.toContain(foundation.id);
    expect((await linkableNonprofits(ada.id)).map((b) => b.id)).not.toContain(foundation.id);
    // The suggested-links list never proposes a business that already belongs to someone (shared phone notwithstanding).
    expect((await proposedLinks()).some((p) => p.business.id === foundation.id)).toBe(false);
    for (const who of [staff, admin]) {
      await expect(linkBusiness(who, ada.id, foundation.id)).rejects.toThrow(/already belongs to James Bradley's records/);
      await expect(linkExistingNonprofit(who, ada.id, foundation.id)).rejects.toThrow(/already belongs/);
    }
    // A genuine co-owner link needs an Admin and a recorded reason.
    await expect(linkBusiness(staff, ada.id, foundation.id, "OFFICER", { coOwnerReason: "Board member per bylaws" })).rejects.toThrow(/Admin must confirm/);
    await expect(linkBusiness(admin, ada.id, foundation.id, "OFFICER", { coOwnerReason: "short" })).rejects.toThrow(/Admin must confirm/);
    expect(await prisma.clientRelationship.count({ where: { personClientId: ada.id } })).toBe(0);
    // Ada's records show no trace of the foundation; Ben's group is intact.
    const fam = await businessFamily(ada.id);
    expect(fam!.businesses.map((b) => b.id)).toEqual([]);
    expect((await nonprofitsForClient(ada.id)).orgs).toEqual([]);
    expect((await businessFamily(foundation.id))!.anchor.id).toBe(ben.id);
  });

  it("even a wrong link that already exists gives the other client's login nothing: no account, documents, downloads or portfolio", async () => {
    const { admin, staff, ada, foundation, adaLogin, benLogin } = await setup();
    const doc = await staffUploadDocument(admin, { clientId: foundation.id, category: "OTHER", visibility: "PUBLISHED", bytes: await pdf(), originalName: "foundation.pdf" });
    // Simulate the reported situation: a mistaken link row created directly.
    await prisma.clientRelationship.create({ data: { personClientId: ada.id, businessClientId: foundation.id, role: "OWNER", createdById: staff.id } });
    expect((await accessibleClients(adaLogin.id)).map((a) => a.clientId)).toEqual([ada.id]);
    await expect(portalDocuments(adaLogin, foundation.id)).rejects.toBeInstanceOf(ForbiddenError);
    expect(await authorizeDownload(downloadToken(doc.id, { portalUserId: adaLogin.id }), { portalUserId: adaLogin.id })).toBeNull();
    await expect(portalPortfolio(adaLogin, foundation.id)).rejects.toBeInstanceOf(ForbiddenError);
    // The owner's login still works.
    expect(await authorizeDownload(downloadToken(doc.id, { portalUserId: benLogin.id }), { portalUserId: benLogin.id })).not.toBeNull();
    // Staff can't turn the mistaken link into portal access; only an Admin could, deliberately.
    await expect(grantOwnerPortalAccess(staff, ada.id, foundation.id, adaLogin.id)).rejects.toThrow(/Only an Admin/);
    expect(await prisma.portalAccess.count({ where: { portalUserId: adaLogin.id, clientId: foundation.id } })).toBe(0);
  });

  it("the review page flags the mistaken link without changing anything", async () => {
    const { admin, staff, ada, foundation } = await setup();
    await prisma.clientRelationship.create({ data: { personClientId: ada.id, businessClientId: foundation.id, role: "OWNER", createdById: staff.id } });
    await expect(relationshipReview(staff)).rejects.toBeInstanceOf(ForbiddenError);
    const before = await prisma.clientRelationship.count();
    const rows = await relationshipReview(admin);
    const wrong = rows.find((r) => r.person.id === ada.id && r.business.id === foundation.id)!;
    expect(wrong.flags).toContain("Business linked to more than one owner");
    expect(wrong.flags.some((f) => f.startsWith("Portal access granted"))).toBe(false); // no access was ever granted through the wrong link
    // The real owner's link shows its legitimate portal grant, and the second-owner warning.
    const ok = rows.find((r) => r.person.id !== ada.id && r.business.id === foundation.id)!;
    expect(ok.flags).toEqual(expect.arrayContaining(["Business linked to more than one owner", "Portal access granted through this link (1)"]));
    expect(await prisma.clientRelationship.count()).toBe(before);
  });

  it("a Square bill can't combine records from different owners — even if a wrong link exists", async () => {
    const { admin, ada, ben, foundation } = await setup();
    await prisma.ownerAccess.create({ data: { userId: admin.id, isPrimary: true } }); // Tabitha manages Square billing
    const bill = await prisma.squareBillingArrangement.create({ data: { squareCustomerId: "CUST_FICTIONAL", squareLocationId: "LOC_FICTIONAL", seriesKey: "series-fictional", linkedById: admin.id, members: { create: [{ clientId: ben.id, addedById: admin.id }] } } });
    await expect(addClientToSquareBilling(admin, bill.id, ada.id)).rejects.toThrow(/same owner/);
    await addClientToSquareBilling(admin, bill.id, foundation.id); // James's own foundation is fine
    // With a wrong link in place, the foundation can't be billed alongside Felicity.
    await prisma.squareBillingMember.deleteMany({ where: { clientId: foundation.id } });
    await prisma.clientRelationship.create({ data: { personClientId: ada.id, businessClientId: foundation.id, role: "OWNER", createdById: admin.id } });
    await expect(addClientToSquareBilling(admin, bill.id, foundation.id)).rejects.toThrow(/more than one owner/);
    expect(await prisma.squareBillingMember.count({ where: { clientId: ada.id } })).toBe(0);
  });

  it("correcting a wrong link: Admin only, with a reason; the evidence is kept and neither client's records change", async () => {
    const { admin, staff, ada, ben, foundation } = await setup();
    const doc = await staffUploadDocument(admin, { clientId: foundation.id, category: "OTHER", visibility: "STAFF_ONLY", bytes: await pdf(), originalName: "f.pdf" });
    const wrong = await prisma.clientRelationship.create({ data: { personClientId: ada.id, businessClientId: foundation.id, role: "OWNER", createdById: staff.id } });
    await expect(unlinkBusiness(staff, ada.id, foundation.id, "Wrong client — verified with the owner")).rejects.toBeInstanceOf(ForbiddenError);
    await expect(unlinkBusiness(admin, ada.id, foundation.id, "oops")).rejects.toThrow(/Record why/);
    await unlinkBusiness(admin, ada.id, foundation.id, "Wrong client — Felicity has no relationship to this foundation");
    const log = await prisma.auditLog.findFirstOrThrow({ where: { action: "client.business_unlinked", entityId: ada.id } });
    expect(log.details).toMatchObject({ businessClientId: foundation.id, removedLink: { id: wrong.id, createdById: staff.id } });
    // Only the wrong link is gone; James's link, the foundation and its documents are untouched.
    expect(await prisma.clientRelationship.count({ where: { personClientId: ben.id, businessClientId: foundation.id } })).toBe(1);
    expect(await prisma.document.count({ where: { id: doc.id, clientId: foundation.id, deletedAt: null } })).toBe(1);
    expect((await businessFamily(ada.id))!.businesses).toEqual([]);
  });
});
