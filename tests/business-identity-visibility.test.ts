import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeUser, prisma, resetDb } from "./db";
import { ForbiddenError } from "@/lib/auth/actor";
import type { PortalActor } from "@/lib/portal/session";
import { createClient, ValidationError } from "@/lib/services/clients";
import { acceptPortalInvite, invitePortalUser } from "@/lib/services/portal-accounts";
import { inviteBusinessOwner, saveBusinessOwner } from "@/lib/services/business-owners";
import { authorizeDownload, downloadToken } from "@/lib/services/documents";
import { loadPortalHome } from "@/lib/portal/views";
import { requireClientAccess } from "@/lib/portal/access";
import { serviceProfile } from "@/lib/services/service-profile";
import {
  addPerson, assignIdentityToOwner, ensureClientPerson, identityChecklistFor, identityOverviewForViewer, ownerIdentityOverview, portalIdentityOverview,
  runIdentityReminders, staffIdentityOverview, unassignedBusinessIdentity, uploadIdentityDocument, verifyIdentityDocument,
} from "@/lib/services/identity";
import { addDays, officeToday } from "@/lib/tax/deadlines";

/**
 * Identity documents on business accounts are per owner. Documents filed on the business's own
 * client record (before owner records existed) are hidden from every portal login until a staff
 * member assigns each to an owner; then only that owner sees it. Fictional people only.
 */

beforeEach(async () => {
  await resetDb();
  vi.stubEnv("MALWARE_SCAN_URL", "https://scanner.test/scan");
  vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ clean: true }), { status: 200 }));
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

let seq = 0;
const pdf = () => new TextEncoder().encode(`%PDF-1.4\n% fictional id ${seq++}\n`);
const inDays = (n: number) => addDays(officeToday(), n);
const canOpen = async (docId: string, who: { portalUserId?: string; staffId?: string }) => !!(await authorizeDownload(downloadToken(docId, who), who));

/**
 * A fictional four-partner LLC. Every partner login is given identity AND upload access to the
 * business — the widest grant — to prove the legacy documents stay hidden regardless.
 */
async function partners(services = "Business tax return (1065/1120-S/1120), K-1 preparation for owners") {
  const tabitha = await makeUser("ADMIN", "Tabitha");
  await prisma.ownerAccess.create({ data: { userId: tabitha.id, isPrimary: true } });
  const daria = await makeUser("STAFF", "Daria");
  const stranger = await makeUser("STAFF", "Stranger");
  const biz = await createClient(tabitha, { businessName: "Pretend Four Partners LLC", clientType: "BUSINESS", status: "ACTIVE", services, assignedToId: daria.id });
  const owners: { owner: { id: string }; login: PortalActor }[] = [];
  for (const [i, name] of ["Avery Partner", "Blake Partner", "Casey Partner", "Devon Partner"].entries()) {
    const { owner } = await saveBusinessOwner(tabitha, biz.id, null, { name, email: `${name.split(" ")[0].toLowerCase()}@partners.example`, phone: `205555030${i}`, ownership: "25", title: "PARTNER", receivesK1: true });
    const { token } = await inviteBusinessOwner(tabitha, biz.id, owner.id);
    const u = await acceptPortalInvite(token!, "Partner-Pass-12345");
    owners.push({ owner, login: { id: u.id, name: u.name, email: u.email } as PortalActor });
  }
  await prisma.portalAccess.updateMany({ where: { clientId: biz.id }, data: { canViewIdentity: true, canUpload: true, canViewTax: true } });
  // Legacy: identity documents filed on the business's own record (not tied to any owner).
  const record = await ensureClientPerson(biz.id);
  const license = await uploadIdentityDocument({ staff: daria }, { clientId: biz.id, personId: record.id, type: "DRIVERS_LICENSE", expiresOn: inDays(20), bytes: pdf(), originalName: "dl.pdf" });
  const ssCard = await uploadIdentityDocument({ staff: tabitha }, { clientId: biz.id, personId: record.id, type: "SOCIAL_SECURITY_CARD", bytes: pdf(), originalName: "ss.pdf" });
  // One that a partner's login sent to the business record before this change.
  const birth = await uploadIdentityDocument({ staff: tabitha }, { clientId: biz.id, personId: record.id, type: "BIRTH_CERTIFICATE", bytes: pdf(), originalName: "bc.pdf" });
  await prisma.identityDocument.update({ where: { id: birth.id }, data: { uploadedByStaffId: null, uploadedByPortalId: owners[2].login.id } });
  return { tabitha, daria, stranger, biz, owners, record, license, ssCard, birth };
}

const visibleDocIds = (ov: Awaited<ReturnType<typeof identityOverviewForViewer>>) => ov.flatMap((e) => e.slots.flatMap((s) => s.history.map((h) => h.documentId))).sort();

describe("business accounts: identity documents are per owner", () => {
  it("old untagged identity documents are hidden from all four partners; after staff assign one to partner A, only A sees it; staff and Tabitha see everything", async () => {
    vi.stubEnv("NOTIFICATIONS_ENABLED", "false");
    const { tabitha, daria, stranger, biz, owners, record, license, ssCard, birth } = await partners();
    const [a, b, c, d] = owners;
    const legacy = [license, ssCard, birth];
    expect((await serviceProfile(biz.id)).businessOnly).toBe(true);
    expect(await prisma.document.count({ where: { id: { in: legacy.map((l) => l.documentId) }, businessOwnerId: null } })).toBe(3);

    // Hidden from every partner: lists, Identity page, Home alerts, the checklist and every file link.
    for (const o of owners) {
      expect(await identityOverviewForViewer(biz.id, o.login.id)).toEqual([]);
      expect(await portalIdentityOverview(o.login, biz.id)).toEqual([]);
      expect(await ownerIdentityOverview(o.login, biz.id)).toBeNull();
      expect(identityChecklistFor(await identityOverviewForViewer(biz.id, o.login.id))).toEqual([]);
      expect((await loadPortalHome(biz.id, await requireClientAccess(o.login.id, biz.id), o.login.id)).identityAlerts).toEqual([]);
      for (const l of legacy) expect(await canOpen(l.documentId, { portalUserId: o.login.id }), `${o.login.name} → ${l.type}`).toBe(false);
    }
    // Including partner C, whose login uploaded the birth certificate long ago.
    expect(await canOpen(birth.documentId, { portalUserId: c.login.id })).toBe(false);
    // View as Client (no viewer) shows nothing either.
    expect(await identityOverviewForViewer(biz.id, null)).toEqual([]);

    // The business record itself no longer accepts portal uploads, or new people, from any partner.
    for (const o of owners) {
      await expect(uploadIdentityDocument({ portal: o.login }, { clientId: biz.id, personId: record.id, type: "DRIVERS_LICENSE", expiresOn: inDays(900), replacementReason: "Renewed license", bytes: pdf(), originalName: "dl.pdf" })).rejects.toBeInstanceOf(ForbiddenError);
      await expect(addPerson({ portal: o.login }, biz.id, { role: "DEPENDENT", name: "Pretend Kid" })).rejects.toBeInstanceOf(ForbiddenError);
    }
    expect(await prisma.identityDocument.count({ where: { clientId: biz.id } })).toBe(3);

    // Staff and Tabitha see everything, as before. SS cards and birth certificates stay Admin-only.
    expect((await staffIdentityOverview(daria, biz.id)).flatMap((e) => e.slots.flatMap((s) => s.history.map((h) => h.id))).sort()).toEqual(legacy.map((l) => l.id).sort());
    expect(await canOpen(license.documentId, { staffId: tabitha.id })).toBe(true);
    expect(await canOpen(license.documentId, { staffId: daria.id })).toBe(true);
    expect(await canOpen(ssCard.documentId, { staffId: tabitha.id })).toBe(true);
    expect(await canOpen(ssCard.documentId, { staffId: daria.id })).toBe(false);
    expect(await canOpen(birth.documentId, { staffId: daria.id })).toBe(false);
    const listed = (await unassignedBusinessIdentity(daria, biz.id))!;
    expect(listed.records.map((r) => r.id).sort()).toEqual(legacy.map((l) => l.id).sort());
    expect(listed.owners.map((o) => o.id).sort()).toEqual(owners.map((o) => o.owner.id).sort());

    // Who may assign: staff with identity access only; Admin-only types need an Admin.
    await expect(unassignedBusinessIdentity(stranger, biz.id)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(assignIdentityToOwner(stranger, license.id, a.owner.id)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(assignIdentityToOwner(daria, ssCard.id, a.owner.id)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(assignIdentityToOwner(daria, license.id, "not-an-owner")).rejects.toBeInstanceOf(ValidationError);

    // Daria assigns the license to partner A. The file is never deleted or moved.
    const fileBefore = await prisma.document.findUniqueOrThrow({ where: { id: license.documentId }, include: { file: true } });
    const storedBefore = await prisma.storedFile.count();
    await assignIdentityToOwner(daria, license.id, a.owner.id);
    const fileAfter = await prisma.document.findUniqueOrThrow({ where: { id: license.documentId }, include: { file: true } });
    expect(fileAfter).toMatchObject({ businessOwnerId: a.owner.id, deletedAt: null, fileId: fileBefore.fileId, category: "IDENTITY" });
    expect(fileAfter.file.storageKey).toBe(fileBefore.file.storageKey);
    expect(await prisma.storedFile.count()).toBe(storedBefore);
    const moved = await prisma.identityDocument.findUniqueOrThrow({ where: { id: license.id }, include: { person: true } });
    expect(moved.person).toMatchObject({ role: "OWNER", businessOwnerId: a.owner.id });
    expect(moved.status).toBe("PENDING_VERIFICATION");
    const auditRow = await prisma.auditLog.findFirstOrThrow({ where: { action: "identity.assigned_to_owner", entityId: license.id } });
    expect(auditRow).toMatchObject({ actorId: daria.id, clientId: biz.id });
    expect(auditRow.details).toMatchObject({ businessOwnerId: a.owner.id, fromPersonId: record.id, fromRole: "CLIENT", type: "DRIVERS_LICENSE" });
    // Never assigned twice.
    await expect(assignIdentityToOwner(tabitha, license.id, b.owner.id)).rejects.toBeInstanceOf(ValidationError);

    // Only A sees and opens it now.
    expect(await canOpen(license.documentId, { portalUserId: a.login.id })).toBe(false); // identity files are office-only
    for (const o of [b, c, d]) expect(await canOpen(license.documentId, { portalUserId: o.login.id })).toBe(false);
    expect(visibleDocIds(await identityOverviewForViewer(biz.id, a.login.id))).toEqual([license.documentId]);
    expect((await ownerIdentityOverview(a.login, biz.id))!.map((e) => e.person.businessOwnerId)).toEqual([a.owner.id]);
    for (const o of [b, c, d]) {
      expect(await identityOverviewForViewer(biz.id, o.login.id)).toEqual([]);
      expect(await ownerIdentityOverview(o.login, biz.id)).toBeNull();
    }
    // The other two remain hidden from everyone, A included.
    for (const l of [ssCard, birth]) for (const o of owners) expect(await canOpen(l.documentId, { portalUserId: o.login.id })).toBe(false);
    expect((await unassignedBusinessIdentity(tabitha, biz.id))!.records.map((r) => r.id).sort()).toEqual([ssCard.id, birth.id].sort());
    // Staff and Tabitha still see everything.
    expect(await canOpen(license.documentId, { staffId: tabitha.id })).toBe(true);
    expect(await canOpen(license.documentId, { staffId: daria.id })).toBe(true);
    expect((await staffIdentityOverview(tabitha, biz.id)).flatMap((e) => e.slots.flatMap((s) => s.history.map((h) => h.id))).sort()).toEqual(legacy.map((l) => l.id).sort());

    // Tabitha assigns the Social Security card to B: B sees its status only — it never opens in the portal.
    await assignIdentityToOwner(tabitha, ssCard.id, b.owner.id);
    expect(visibleDocIds(await identityOverviewForViewer(biz.id, b.login.id))).toEqual([ssCard.documentId]);
    expect(await canOpen(ssCard.documentId, { portalUserId: b.login.id })).toBe(false);
    expect(await canOpen(ssCard.documentId, { staffId: daria.id })).toBe(false);
    expect(await canOpen(ssCard.documentId, { staffId: tabitha.id })).toBe(true);
    expect(visibleDocIds(await identityOverviewForViewer(biz.id, a.login.id))).toEqual([license.documentId]);

    // License reminders go to the owner it belongs to only.
    await verifyIdentityDocument(daria, license.id, {});
    await runIdentityReminders();
    const notes = await prisma.notification.findMany({ where: { idempotencyKey: { contains: license.id } } });
    expect(notes.length).toBeGreaterThan(0);
    expect(new Set(notes.map((n) => n.portalUserId))).toEqual(new Set([a.login.id]));
  });

  it("a business that also has personal tax preparation: the same per-owner rule on the Identity page, documents list and checklist", async () => {
    const { daria, biz, owners, license } = await partners("Business tax return (1065/1120-S/1120), Individual tax preparation");
    const [a, b] = owners;
    expect((await serviceProfile(biz.id)).businessOnly).toBe(false);
    for (const o of owners) {
      expect(await portalIdentityOverview(o.login, biz.id)).toEqual([]);
      expect(await canOpen(license.documentId, { portalUserId: o.login.id })).toBe(false);
    }
    await assignIdentityToOwner(daria, license.id, a.owner.id);
    expect(visibleDocIds(await portalIdentityOverview(a.login, biz.id))).toEqual([license.documentId]);
    expect(identityChecklistFor(await identityOverviewForViewer(biz.id, a.login.id)).flatMap((p) => p.items.map((i) => i.documentId)).filter(Boolean)).toEqual([license.documentId]);
    expect(await portalIdentityOverview(b.login, biz.id)).toEqual([]);
    expect(await canOpen(license.documentId, { portalUserId: a.login.id })).toBe(false); // identity files are office-only
    expect(await canOpen(license.documentId, { portalUserId: b.login.id })).toBe(false);
  });

  it("individual accounts are unchanged: the account holder with identity access sees and uploads their own", async () => {
    const tab = await makeUser("ADMIN");
    const c = await createClient(tab, { firstName: "Pat", lastName: "Pretend", clientType: "INDIVIDUAL", status: "ACTIVE" });
    const { token } = await invitePortalUser(tab, c.id, { email: "pat@fictional.example", name: "Pat", role: "OWNER" });
    const u = await acceptPortalInvite(token!, "Client-Pass-1234");
    const user = { id: u.id, name: u.name, email: u.email } as PortalActor;
    const me = await ensureClientPerson(c.id);
    const rec = await uploadIdentityDocument({ portal: user }, { clientId: c.id, personId: me.id, type: "DRIVERS_LICENSE", expiresOn: inDays(400), bytes: pdf(), originalName: "dl.pdf" });
    expect(visibleDocIds(await portalIdentityOverview(user, c.id))).toEqual([rec.documentId]);
    expect(await canOpen(rec.documentId, { portalUserId: user.id })).toBe(false); // identity files are office-only
    expect(await unassignedBusinessIdentity(tab, c.id)).toBeNull();
    await expect(assignIdentityToOwner(tab, rec.id, "anything")).rejects.toBeInstanceOf(ValidationError);
  });
});
