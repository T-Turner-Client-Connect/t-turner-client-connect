import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeUser, prisma, resetDb } from "./db";
import { createClient, currentTaxYear, jointFilingNeeded, portalSetJointFiling, updateClient } from "@/lib/services/clients";
import { acceptPortalInvite, invitePortalUser, updatePortalAccess } from "@/lib/services/portal-accounts";
import { archiveBusinessOwner, inviteBusinessOwner, listBusinessOwners, parseOwnership, saveBusinessOwner, setK1Share, setOwnerPermissions, setOwnerPermissionsManager } from "@/lib/services/business-owners";
import { authorizeDownload, downloadToken, portalDocuments, staffUploadDocument } from "@/lib/services/documents";
import { portalConversations, portalSendMessage, staffSendMessage } from "@/lib/services/messaging";
import { loadPortalHome } from "@/lib/portal/views";
import { requireClientAccess } from "@/lib/portal/access";
import { ownerHasPermission } from "@/lib/portal/owner-permissions";
import { assertPersonalTaxAccount } from "@/lib/portal/account";
import { serviceProfile } from "@/lib/services/service-profile";
import { questionnaireLink } from "@/lib/services/tax-center";
import { decidePersonalTaxRequest, requestPersonalTax } from "@/lib/services/personal-tax-requests";
import { signupServices } from "@/lib/services/client-signup";
import { ForbiddenError } from "@/lib/auth/actor";
import { OWNER_DEFAULT_PERMISSIONS } from "@/lib/portal/owner-areas";

beforeEach(resetDb);
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

let seq = 0;
const pdf = () => new TextEncoder().encode(`%PDF-1.4\n% fictional K-1 ${seq++}\n`);
const scannerPasses = () => {
  vi.stubEnv("MALWARE_SCAN_URL", "https://scanner.test/scan");
  vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ clean: true }), { status: 200 }));
};

/** Tabitha with the Owner's Office (full), and a fictional four-owner LLC. */
async function smokehouse() {
  const tabitha = await makeUser("ADMIN", "Tabitha");
  await prisma.ownerAccess.create({ data: { userId: tabitha.id, isPrimary: true } });
  const biz = await createClient(tabitha, { businessName: "Tailored Pretend Smokehouse LLC", clientType: "BUSINESS", status: "ACTIVE", services: "Business tax return (1065/1120-S/1120), K-1 preparation for owners, Payroll" });
  const names = ["Avery Pitmaster", "Blake Brisket", "Casey Hickory", "Devon Mesquite"];
  const owners = [];
  for (const [i, name] of names.entries()) {
    const r = await saveBusinessOwner(tabitha, biz.id, null, { name, email: `${name.split(" ")[0].toLowerCase()}@smokehouse.example`, phone: `205555010${i}`, ownership: "25", title: "MEMBER", receivesK1: true });
    owners.push(r);
  }
  return { tabitha, biz, owners: owners.map((o) => o.owner), last: owners[3] };
}

/** Invites an owner and accepts the invitation: their own, separate login. */
async function login(actor: Awaited<ReturnType<typeof smokehouse>>["tabitha"], clientId: string, ownerId: string) {
  const { token } = await inviteBusinessOwner(actor, clientId, ownerId);
  const u = await acceptPortalInvite(token!, "Portal-Pass-123");
  return { id: u.id, name: u.name, email: u.email };
}

describe("client form: spouse section", () => {
  it("a collapsed (unticked) spouse box saves no spouse; ticked saves it and flags only that year", async () => {
    const staff = await makeUser("STAFF");
    const year = currentTaxYear();
    const single = await createClient(staff, { firstName: "Robin", lastName: "Pretend", clientType: "INDIVIDUAL", status: "ACTIVE", spouseNeeded: false, spouseYear: year, spouseFirstName: "Typed", spouseLastName: "ButClosed" });
    expect(single.spouseFirstName).toBeNull();
    expect(await jointFilingNeeded(single.id, year)).toBe(false);

    const joint = await createClient(staff, { firstName: "Jamie", lastName: "Sample", clientType: "INDIVIDUAL", status: "ACTIVE", spouseNeeded: true, spouseYear: year, spouseFirstName: "Morgan", spouseLastName: "Sample" });
    expect(joint.spouseFirstName).toBe("Morgan");
    expect(await jointFilingNeeded(joint.id, year)).toBe(true);
    // Per year: the next year isn't assumed to be joint.
    expect(await jointFilingNeeded(joint.id, year + 1)).toBe(false);
    expect(await prisma.auditLog.count({ where: { clientId: joint.id, action: "client.joint_filing_set" } })).toBe(1);
  });

  it("a spouse saved for an earlier year doesn't open the section; unticking keeps it on file", async () => {
    const staff = await makeUser("STAFF");
    const year = currentTaxYear();
    const c = await createClient(staff, { firstName: "Lee", lastName: "Example", clientType: "INDIVIDUAL", status: "ACTIVE", spouseNeeded: true, spouseYear: year - 1, spouseFirstName: "Pat", spouseLastName: "Example" });
    expect(await jointFilingNeeded(c.id, year - 1)).toBe(true);
    expect(await jointFilingNeeded(c.id, year)).toBe(false); // current year stays closed
    const saved = await updateClient(staff, c.id, { firstName: "Lee", lastName: "Example", clientType: "INDIVIDUAL", status: "ACTIVE", spouseNeeded: false, spouseYear: year, spouseFirstName: "Changed" });
    expect(saved.spouseFirstName).toBe("Pat"); // kept, not overwritten
    expect(await jointFilingNeeded(c.id, year)).toBe(false);
  });

  it("a business never saves spouse details", async () => {
    const staff = await makeUser("STAFF");
    const b = await createClient(staff, { businessName: "Pretend Foscue LLC", clientType: "BUSINESS", status: "ACTIVE", spouseNeeded: true, spouseFirstName: "Should", spouseLastName: "NotSave" });
    expect(b.spouseFirstName).toBeNull();
    expect(await prisma.jointFilingYear.count({ where: { clientId: b.id } })).toBe(0);
  });

  it("the client can answer for the year from My Tax Center (owner of a personal account only)", async () => {
    const staff = await makeUser("STAFF");
    const c = await createClient(staff, { firstName: "Quinn", lastName: "Demo", clientType: "INDIVIDUAL", status: "ACTIVE" });
    const { token } = await invitePortalUser(staff, c.id, { email: "quinn@example.com", name: "Quinn Demo", role: "OWNER" });
    const u = await acceptPortalInvite(token!, "Portal-Pass-123");
    await portalSetJointFiling(u, c.id, currentTaxYear(), true);
    expect(await jointFilingNeeded(c.id)).toBe(true);
    const row = await prisma.jointFilingYear.findFirstOrThrow({ where: { clientId: c.id } });
    expect(row.source).toBe("CLIENT");
  });
});

describe("business owners", () => {
  it("lists four owners at 25% each for Tailored Pretend Smokehouse LLC, with an audit row each", async () => {
    const { biz, last } = await smokehouse();
    const { owners, total, warning } = await listBusinessOwners(biz.id);
    expect(owners.map((o) => o.contact.name)).toEqual(["Avery Pitmaster", "Blake Brisket", "Casey Hickory", "Devon Mesquite"]);
    expect(owners.every((o) => o.ownershipBps === 2500 && o.receivesK1 && o.status === "NOT_INVITED")).toBe(true);
    expect(total).toBe(10_000);
    expect(warning).toBeNull();
    expect(last.warning).toBeNull();
    expect(await prisma.auditLog.count({ where: { clientId: biz.id, action: "business_owner.added" } })).toBe(4);
  });

  it("refuses more than 100% and warns when the total isn't 100%", async () => {
    const { tabitha, biz, owners } = await smokehouse();
    await expect(saveBusinessOwner(tabitha, biz.id, null, { name: "Extra Partner", ownership: "1" })).rejects.toThrow(/more than 100%/);
    const r = await saveBusinessOwner(tabitha, biz.id, owners[0].id, { name: "Avery Pitmaster", email: "avery@smokehouse.example", phone: "2055550100", ownership: "20", title: "MEMBER" });
    expect(r.total).toBe(9_500);
    expect(r.warning).toMatch(/95%, not 100%/);
    expect(parseOwnership("33.33")).toBe(3333);
    expect(() => parseOwnership("abc")).toThrow();
    expect(() => parseOwnership("0")).toThrow();
    const log = await prisma.auditLog.findFirstOrThrow({ where: { clientId: biz.id, action: "business_owner.updated" } });
    expect(log.details).toMatchObject({ fields: ["ownershipBps"], ownershipFrom: 2500, ownershipTo: 2000 });
  });

  it("removing an owner archives them (not deleted), revokes their login at once and is audited", async () => {
    const { tabitha, biz, owners } = await smokehouse();
    const a = await login(tabitha, biz.id, owners[0].id);
    await requireClientAccess(a.id, biz.id);
    await archiveBusinessOwner(tabitha, biz.id, owners[0].id, "Sold their share");
    await expect(requireClientAccess(a.id, biz.id)).rejects.toBeInstanceOf(ForbiddenError);
    expect(await prisma.businessOwner.count({ where: { id: owners[0].id } })).toBe(1);
    expect((await listBusinessOwners(biz.id)).owners).toHaveLength(3);
    expect(await prisma.auditLog.count({ where: { clientId: biz.id, action: "business_owner.archived" } })).toBe(1);
  });

  it("each owner's invitation creates a separate login, starting with own K-1s + Messages only", async () => {
    const { tabitha, biz, owners } = await smokehouse();
    const logins = [];
    for (const o of owners) logins.push(await login(tabitha, biz.id, o.id));
    expect(new Set(logins.map((l) => l.id)).size).toBe(4);
    expect(await prisma.portalUser.count()).toBe(4);
    const listed = await listBusinessOwners(biz.id);
    expect(listed.owners.every((o) => o.status === "ACTIVE" && o.portalUserId)).toBe(true);
    const access = await requireClientAccess(logins[0].id, biz.id);
    expect(access.role).toBe("OWNER");
    expect(access).toMatchObject({ ...OWNER_DEFAULT_PERMISSIONS, canViewIdentity: false });
    expect(await ownerHasPermission(logins[0].id, biz.id, "messages", "send")).toBe(true);
    expect(await ownerHasPermission(logins[0].id, biz.id, "k1", "view")).toBe(true);
    for (const area of ["documents", "billing", "taxReturns", "payroll", "banking"] as const) expect(await ownerHasPermission(logins[0].id, biz.id, area, "view")).toBe(false);
    expect(await ownerHasPermission(logins[0].id, biz.id, "payrollApproval", "approve")).toBe(false);
    expect(await prisma.auditLog.count({ where: { clientId: biz.id, action: "business_owner.invited" } })).toBe(4);
  });

  it("invite status: not invited → invited → active", async () => {
    const { tabitha, biz, owners } = await smokehouse();
    const { token } = await inviteBusinessOwner(tabitha, biz.id, owners[1].id);
    let st = (await listBusinessOwners(biz.id)).owners.find((o) => o.id === owners[1].id)!;
    expect(st.status).toBe("INVITED");
    expect(st.permissions).toEqual(OWNER_DEFAULT_PERMISSIONS);
    await acceptPortalInvite(token!, "Portal-Pass-123");
    st = (await listBusinessOwners(biz.id)).owners.find((o) => o.id === owners[1].id)!;
    expect(st.status).toBe("ACTIVE");
    expect((await listBusinessOwners(biz.id)).owners.find((o) => o.id === owners[2].id)!.status).toBe("NOT_INVITED");
  });

  it("an owner who already has a login (e.g. a personal client) gets this business on it, still K-1 + Messages only", async () => {
    const { tabitha, biz, owners } = await smokehouse();
    const personal = await createClient(tabitha, { firstName: "Avery", lastName: "Pitmaster", clientType: "INDIVIDUAL", status: "ACTIVE" });
    const { token } = await invitePortalUser(tabitha, personal.id, { email: "avery@smokehouse.example", name: "Avery Pitmaster", role: "OWNER" });
    const u = await acceptPortalInvite(token!, "Portal-Pass-123");
    const res = await inviteBusinessOwner(tabitha, biz.id, owners[0].id);
    expect(res.grantedExisting).toBe(true);
    const access = await requireClientAccess(u.id, biz.id);
    expect(access.canViewTax).toBe(false);
    expect(access.canViewDocuments).toBe(false);
    expect((await prisma.businessOwner.findUniqueOrThrow({ where: { id: owners[0].id } })).portalUserId).toBe(u.id);
  });
});

describe("owner permissions", () => {
  it("grants take effect immediately, revocation too, and every change is audited", async () => {
    scannerPasses();
    const { tabitha, biz, owners } = await smokehouse();
    const a = await login(tabitha, biz.id, owners[0].id);
    const doc = await staffUploadDocument(tabitha, { clientId: biz.id, category: "OTHER", visibility: "PUBLISHED", bytes: pdf(), originalName: "operating-agreement.pdf", title: "Operating agreement" });
    expect((await portalDocuments(a, biz.id)).map((d) => d.id)).not.toContain(doc.id);
    expect(await authorizeDownload(downloadToken(doc.id, { portalUserId: a.id }), { portalUserId: a.id })).toBeNull();

    await setOwnerPermissions(tabitha, biz.id, owners[0].id, { canViewDocuments: true, canApprovePayroll: true });
    expect((await portalDocuments(a, biz.id)).map((d) => d.id)).toContain(doc.id);
    expect(await authorizeDownload(downloadToken(doc.id, { portalUserId: a.id }), { portalUserId: a.id })).not.toBeNull();
    expect(await ownerHasPermission(a.id, biz.id, "payrollApproval", "approve")).toBe(true);
    // Payroll approval never brings payroll viewing or upload with it.
    expect(await ownerHasPermission(a.id, biz.id, "payroll", "upload")).toBe(false);

    await setOwnerPermissions(tabitha, biz.id, owners[0].id, { canViewDocuments: false, canApprovePayroll: false });
    expect((await portalDocuments(a, biz.id)).map((d) => d.id)).not.toContain(doc.id);
    expect(await authorizeDownload(downloadToken(doc.id, { portalUserId: a.id }), { portalUserId: a.id })).toBeNull();
    expect(await ownerHasPermission(a.id, biz.id, "payrollApproval", "approve")).toBe(false);

    const logs = await prisma.auditLog.findMany({ where: { clientId: biz.id, action: "business_owner.permissions_changed" }, orderBy: { createdAt: "asc" } });
    expect(logs).toHaveLength(2);
    expect(logs[0].actorId).toBe(tabitha.id);
    expect(logs[0].details).toMatchObject({ changes: { canViewDocuments: { from: false, to: true }, canApprovePayroll: { from: false, to: true } }, appliedTo: "login" });
  });

  it("only Tabitha or staff she authorized may set them; ownership % never implies access", async () => {
    const { tabitha, biz, owners } = await smokehouse();
    const a = await login(tabitha, biz.id, owners[0].id);
    const daria = await makeUser("ADMIN", "Daria");
    await expect(setOwnerPermissions(daria, biz.id, owners[0].id, { canViewBilling: true })).rejects.toBeInstanceOf(ForbiddenError);
    // The generic Portal tab path can't get around it either.
    const access = await requireClientAccess(a.id, biz.id);
    await expect(updatePortalAccess(daria, access.id, { canMessage: true, canUpload: true, canViewBookkeeping: false, canViewTax: true, canViewContracts: false, canViewIdentity: false })).rejects.toBeInstanceOf(ForbiddenError);
    await setOwnerPermissionsManager(tabitha, daria.id, true);
    await setOwnerPermissions(daria, biz.id, owners[0].id, { canViewBilling: true });
    expect((await requireClientAccess(a.id, biz.id)).canViewBilling).toBe(true);
    // Raising ownership to 100% of the remaining share changes nothing about access.
    await saveBusinessOwner(tabitha, biz.id, owners[1].id, { name: "Blake Brisket", email: "blake@smokehouse.example", ownership: "25" });
    expect((await requireClientAccess(a.id, biz.id)).canViewTax).toBe(false);
    expect(await prisma.auditLog.count({ where: { action: "owner_permissions.manager_granted" } })).toBe(1);
  });

  it("permissions can be set before acceptance and carry into the new login", async () => {
    const { tabitha, biz, owners } = await smokehouse();
    const { token } = await inviteBusinessOwner(tabitha, biz.id, owners[2].id);
    await setOwnerPermissions(tabitha, biz.id, owners[2].id, { canViewPayroll: true, canUploadPayroll: true });
    const u = await acceptPortalInvite(token!, "Portal-Pass-123");
    const access = await requireClientAccess(u.id, biz.id);
    expect(access.canViewPayroll && access.canUploadPayroll).toBe(true);
    expect(access.canViewDocuments).toBe(false);
  });
});

describe("K-1s per owner", () => {
  it("owner A cannot see owner B's K-1 (lists, home, download, messages), unless Tabitha shares it", async () => {
    scannerPasses();
    const { tabitha, biz, owners } = await smokehouse();
    const a = await login(tabitha, biz.id, owners[0].id);
    const b = await login(tabitha, biz.id, owners[1].id);
    const k1A = await staffUploadDocument(tabitha, { clientId: biz.id, category: "OWNER_K1", businessOwnerId: owners[0].id, year: 2025, visibility: "PUBLISHED", bytes: pdf(), originalName: "k1-avery.pdf", title: "Schedule K-1 2025" });
    const k1B = await staffUploadDocument(tabitha, { clientId: biz.id, category: "OWNER_K1", businessOwnerId: owners[1].id, year: 2025, visibility: "PUBLISHED", bytes: pdf(), originalName: "k1-blake.pdf", title: "Schedule K-1 2025" });

    // Even with every area granted, B's K-1 stays B's.
    await setOwnerPermissions(tabitha, biz.id, owners[0].id, { canViewDocuments: true, canViewTax: true, canViewPayroll: true, canViewBilling: true, canViewContracts: true });
    const aDocs = (await portalDocuments(a, biz.id)).map((d) => d.id);
    expect(aDocs).toContain(k1A.id);
    expect(aDocs).not.toContain(k1B.id);
    expect(await authorizeDownload(downloadToken(k1B.id, { portalUserId: a.id }), { portalUserId: a.id })).toBeNull();
    expect(await authorizeDownload(downloadToken(k1A.id, { portalUserId: a.id }), { portalUserId: a.id })).not.toBeNull();
    const home = await loadPortalHome(biz.id, await requireClientAccess(a.id, biz.id), a.id);
    expect(home.k1s.map((k) => k.id)).toEqual([k1A.id]);
    expect(home.newDocs.map((d) => d.id)).not.toContain(k1B.id);
    // Staff can't send a K-1 in a message thread.
    await expect(staffSendMessage(tabitha, { clientId: biz.id, body: "Here you go", channel: "PORTAL", attachmentIds: [k1B.id] })).rejects.toThrow(/K-1s reach owners/);
    // Staff always can open it.
    expect(await authorizeDownload(downloadToken(k1B.id, { staffId: tabitha.id }), { staffId: tabitha.id })).not.toBeNull();

    // A specific, per-pair grant; then revoked again.
    await setK1Share(tabitha, biz.id, owners[0].id, owners[1].id, true);
    expect((await portalDocuments(a, biz.id)).map((d) => d.id)).toContain(k1B.id);
    expect((await portalDocuments(b, biz.id)).map((d) => d.id)).not.toContain(k1A.id); // one direction only
    await setK1Share(tabitha, biz.id, owners[0].id, owners[1].id, false);
    expect(await authorizeDownload(downloadToken(k1B.id, { portalUserId: a.id }), { portalUserId: a.id })).toBeNull();
    expect(await prisma.auditLog.count({ where: { clientId: biz.id, action: { in: ["business_owner.k1_shared", "business_owner.k1_unshared"] } } })).toBe(2);
  });

  it("a K-1 must name an owner of this business, and its notice goes only to that owner", async () => {
    scannerPasses();
    const { tabitha, biz, owners } = await smokehouse();
    const a = await login(tabitha, biz.id, owners[0].id);
    const b = await login(tabitha, biz.id, owners[1].id);
    await expect(staffUploadDocument(tabitha, { clientId: biz.id, category: "OWNER_K1", visibility: "PUBLISHED", bytes: pdf(), originalName: "k1.pdf" })).rejects.toThrow(/owner this K-1 belongs to/);
    await staffUploadDocument(tabitha, { clientId: biz.id, category: "OWNER_K1", businessOwnerId: owners[0].id, visibility: "PUBLISHED", bytes: pdf(), originalName: "k1.pdf" });
    expect(await prisma.notification.count({ where: { portalUserId: a.id, kind: "NEW_DOCUMENT" } })).toBeGreaterThan(0);
    expect(await prisma.notification.count({ where: { portalUserId: b.id } })).toBe(0);
  });

  it("an owner's own message threads are private to them", async () => {
    const { tabitha, biz, owners } = await smokehouse();
    const a = await login(tabitha, biz.id, owners[0].id);
    const b = await login(tabitha, biz.id, owners[1].id);
    const m = await portalSendMessage(a, { clientId: biz.id, subject: "My distribution", body: "Question about my share" });
    expect((await portalConversations(a, biz.id)).map((c) => c.id)).toContain(m.conversationId);
    expect(await portalConversations(b, biz.id)).toHaveLength(0);
    await expect(portalSendMessage(b, { clientId: biz.id, conversationId: m.conversationId, body: "peek" })).rejects.toThrow(/not found/);
  });
});

describe("business-only clients", () => {
  it("the portal hides personal tax items and routes; owners see business items", async () => {
    const { tabitha, biz, owners } = await smokehouse();
    const a = await login(tabitha, biz.id, owners[0].id);
    expect((await serviceProfile(biz.id)).businessOnly).toBe(true);
    await setOwnerPermissions(tabitha, biz.id, owners[0].id, { canViewTax: true });
    const home = await loadPortalHome(biz.id, await requireClientAccess(a.id, biz.id), a.id);
    expect(home.businessOnly).toBe(true);
    expect(home.questionnaires).toEqual([]);
    expect(home.statuses).toEqual([]);
    expect(home.identityAlerts).toEqual([]);
    expect(home.summariesWaiting).toEqual([]);
    expect(home.perms.canViewIdentity).toBe(false);
    await expect(assertPersonalTaxAccount(biz.id)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(questionnaireLink(a, biz.id, 2025)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(portalSetJointFiling(a, biz.id, currentTaxYear(), true)).rejects.toThrow(/Business accounts/);
  });

  it("an individual client is unchanged", async () => {
    const staff = await makeUser("STAFF");
    const c = await createClient(staff, { firstName: "Indy", lastName: "Vidual", clientType: "INDIVIDUAL", status: "ACTIVE" });
    const { token } = await invitePortalUser(staff, c.id, { email: "indy@example.com", name: "Indy Vidual", role: "OWNER" });
    const u = await acceptPortalInvite(token!, "Portal-Pass-123");
    const access = await requireClientAccess(u.id, c.id);
    expect(access).toMatchObject({ canMessage: true, canUpload: true, canViewTax: true, canViewIdentity: true, canViewDocuments: true, canViewBilling: true });
    const home = await loadPortalHome(c.id, access, u.id);
    expect(home.businessOnly).toBe(false);
    expect(home.questionnaires.length).toBeGreaterThan(0);
    await assertPersonalTaxAccount(c.id);
  });

  it("a business with Individual tax preparation keeps the personal features", async () => {
    const staff = await makeUser("STAFF");
    const b = await createClient(staff, { businessName: "Pretend Sole Shop", clientType: "BUSINESS", status: "ACTIVE", services: "Individual tax preparation, Bookkeeping" });
    expect((await serviceProfile(b.id)).businessOnly).toBe(false);
  });

  it("“Request personal tax preparation” → staff accept → the person's own Personal account has it", async () => {
    const { tabitha, biz, owners } = await smokehouse();
    const a = await login(tabitha, biz.id, owners[0].id);
    const b = await login(tabitha, biz.id, owners[1].id);
    const req = await requestPersonalTax(a, biz.id, "I'd like my 1040 done too");
    await expect(requestPersonalTax(a, biz.id)).rejects.toThrow(/already/);
    // The request thread is private to the requester.
    expect(await portalConversations(b, biz.id)).toHaveLength(0);
    const personalId = await decidePersonalTaxRequest(tabitha, req.id, { accept: true });
    const personal = await prisma.client.findUniqueOrThrow({ where: { id: personalId! } });
    expect(personal.clientType).toBe("INDIVIDUAL");
    expect(personal.services).toContain("Individual tax preparation");
    const access = await requireClientAccess(a.id, personal.id);
    expect(access.canViewTax).toBe(true);
    await expect(requireClientAccess(b.id, personal.id)).rejects.toBeInstanceOf(ForbiddenError);
    // The business account itself stays business-only.
    expect((await serviceProfile(biz.id)).businessOnly).toBe(true);
    expect(await prisma.auditLog.count({ where: { action: { in: ["personal_tax.requested", "personal_tax.accepted"] } } })).toBe(2);
  });

  it("sign-up: business services only map to a business-only record", () => {
    expect(signupServices(["Business tax preparation", "K-1 preparation for owners", "Payroll", "Other"])).toEqual(["Business tax return (1065/1120-S/1120)", "K-1 preparation for owners", "Payroll"]);
    expect(signupServices(["Individual tax preparation"])).toEqual(["Individual tax preparation"]);
  });
});
