import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeUser, prisma, resetDb } from "./db";
import { ForbiddenError } from "@/lib/auth/actor";
import { createClient, saveContact } from "@/lib/services/clients";
import { acceptPortalInvite, invitePortalUser } from "@/lib/services/portal-accounts";
import { requireClientAccess, accessibleClients } from "@/lib/portal/access";
import { portalDocuments, staffUploadDocument } from "@/lib/services/documents";
import { saveProfile } from "@/lib/services/bookkeeping-clients";
import { setCoethaLink, saveBilling } from "@/lib/services/bookkeeping-profile";
import { staffSendMessage, portalConversations } from "@/lib/services/messaging";
import { portalBilling } from "@/lib/services/owner-billing";
import { assignContract } from "@/lib/services/contracts";
import { businessFamily, confirmProposedLink, createAndLinkBusiness, grantOwnerPortalAccess, linkBusiness, proposedLinks } from "@/lib/services/related-businesses";

let n = 0;
const pdf = () => new TextEncoder().encode(`%PDF-1.4\n% fictional ${n++}\n`);
beforeEach(async () => {
  await resetDb();
  vi.stubEnv("MALWARE_SCAN_URL", "https://scanner.test/scan");
  vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ clean: true }), { status: 200 }));
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("one owner, several businesses (fictional Steven Cox example)", () => {
  it("one Personal record and one login, two separate businesses; access per business; nothing carries over between them", async () => {
    const tabitha = await makeUser("ADMIN", "Tabitha");
    await prisma.ownerAccess.create({ data: { userId: tabitha.id, isPrimary: true } });
    const daria = await makeUser("STAFF", "Daria");
    const steven = await createClient(tabitha, { firstName: "Steven", lastName: "Cox", email: "steven@fictional.example", clientType: "INDIVIDUAL", status: "ACTIVE" });
    const energy = await createAndLinkBusiness(tabitha, steven.id, { businessName: "Energy Solutions (fictional)", clientType: "BUSINESS" });
    const drive = await createAndLinkBusiness(daria, steven.id, { businessName: "Drive Time (fictional)", clientType: "BUSINESS" });
    await expect(createAndLinkBusiness(tabitha, steven.id, { businessName: "Energy Solutions (fictional)", clientType: "BUSINESS" })).rejects.toThrow(/Already in the CRM/);
    await expect(linkBusiness(tabitha, steven.id, energy.id)).rejects.toThrow(/already linked/);
    expect(await prisma.client.count({ where: { displayName: "Steven Cox" } })).toBe(1);
    const fam = await businessFamily(drive.id);
    expect([fam!.person!.displayName, ...fam!.businesses.map((b) => b.displayName)]).toEqual(["Steven Cox", "Energy Solutions (fictional)", "Drive Time (fictional)"]);

    // One login, granted per business. Owning Drive Time doesn't open it until staff grant it.
    const { token } = await invitePortalUser(tabitha, steven.id, { email: "steven@fictional.example", name: "Steven Cox", role: "OWNER" });
    const login = await acceptPortalInvite(token!, "Steven-Pass-12345");
    const actor = { id: login.id, name: login.name, email: login.email };
    await grantOwnerPortalAccess(tabitha, steven.id, energy.id, login.id);
    await expect(requireClientAccess(login.id, drive.id)).rejects.toBeInstanceOf(ForbiddenError);
    await grantOwnerPortalAccess(tabitha, steven.id, drive.id, login.id);
    expect((await accessibleClients(login.id)).map((a) => a.clientId).sort()).toEqual([steven.id, energy.id, drive.id].sort());
    expect(await prisma.portalUser.count({ where: { email: "steven@fictional.example" } })).toBe(1);

    // Each business keeps its own records: documents, bookkeeping, billing and Coetha link.
    const eDoc = await staffUploadDocument(tabitha, { clientId: energy.id, category: "BOOKKEEPING", visibility: "PUBLISHED", year: 2026, bytes: pdf(), originalName: "energy-bank.pdf" });
    const dDoc = await staffUploadDocument(tabitha, { clientId: drive.id, category: "BOOKKEEPING", visibility: "PUBLISHED", year: 2026, bytes: pdf(), originalName: "drive-bank.pdf" });
    expect((await portalDocuments(actor, energy.id)).map((d) => d.id)).toEqual([eDoc.id]);
    expect((await portalDocuments(actor, drive.id)).map((d) => d.id)).toEqual([dDoc.id]);
    expect((await portalDocuments(actor, steven.id)).map((d) => d.id)).toEqual([]); // Personal is separate
    for (const b of [energy, drive]) await saveProfile(tabitha, b.id, { active: true, frequency: "MONTHLY", payroll: b === energy });
    await setCoethaLink(tabitha, energy.id, "https://claude.ai/project/energy-1");
    await setCoethaLink(tabitha, drive.id, "https://claude.ai/project/drive-2");
    await saveBilling(tabitha, energy.id, { monthlyFee: "300" });
    await saveBilling(tabitha, drive.id, { monthlyFee: "450" });
    const profiles = await prisma.bookkeepingProfile.findMany({ where: { clientId: { in: [energy.id, drive.id] } }, orderBy: { coethaUrl: "asc" } });
    expect(profiles.map((p) => [p.coethaUrl, p.payroll])).toEqual([["https://claude.ai/project/drive-2", false], ["https://claude.ai/project/energy-1", true]]);
    // Messages, invoices and contracts stay with their own business too.
    await staffSendMessage(tabitha, { clientId: energy.id, body: "Energy question (fictional)", channel: "PORTAL" });
    await staffSendMessage(tabitha, { clientId: drive.id, body: "Drive question (fictional)", channel: "PORTAL" });
    const conv = async (id: string) => (await portalConversations(actor, id)).map((c) => c.clientId);
    expect([await conv(energy.id), await conv(drive.id), await conv(steven.id)]).toEqual([[energy.id], [drive.id], []]);
    for (const [b, num] of [[energy, "E-1"], [drive, "D-1"]] as const) {
      await prisma.invoice.create({ data: { number: num, clientId: b.id, title: `${num} fictional`, issueDate: new Date(), dueDate: new Date(), state: "ISSUED", publishedAt: new Date(), createdById: tabitha.id } as never });
    }
    const invNums = async (id: string) => JSON.stringify(await portalBilling(actor, id));
    expect(await invNums(energy.id)).toContain("E-1");
    expect(await invNums(energy.id)).not.toContain("D-1");
    expect(await invNums(drive.id)).toContain("D-1");
    expect(await invNums(drive.id)).not.toContain("E-1");
    await assignContract(tabitha, { clientId: energy.id, title: "Energy engagement (fictional)", jotformFormId: "123456789012" });
    expect(await prisma.contractAssignment.count({ where: { clientId: drive.id } })).toBe(0);
    const bills = await prisma.bookkeepingBilling.findMany({ where: { clientId: { in: [energy.id, drive.id] } } });
    expect(Object.fromEntries(bills.map((b) => [b.clientId, b.monthlyFeeCents]))).toEqual({ [energy.id]: 30000, [drive.id]: 45000 });
  });

  it("adds Drive Time from Steven's existing BUSINESS record without re-entering or retyping him; files stay separate", async () => {
    const tabitha = await makeUser("ADMIN", "Tabitha");
    await prisma.ownerAccess.create({ data: { userId: tabitha.id, isPrimary: true } });
    // Starting point: one Business record (as in the office's CRM) with Steven as its contact and login.
    const energy = await createClient(tabitha, { firstName: "Steven", lastName: "Cox", businessName: "Energy Solutions Insulation, LLC", email: "steven@fictional.example", clientType: "BUSINESS", status: "ACTIVE" });
    await saveContact(tabitha, energy.id, null, { name: "Steven Cox", email: "steven@fictional.example", phone: "205-555-0100" });
    const { token } = await invitePortalUser(tabitha, energy.id, { email: "steven@fictional.example", name: "Steven Cox", role: "OWNER" });
    const login = await acceptPortalInvite(token!, "Steven-Pass-12345");
    const actor = { id: login.id, name: login.name, email: login.email };
    const eDoc = await staffUploadDocument(tabitha, { clientId: energy.id, category: "BOOKKEEPING", visibility: "PUBLISHED", year: 2026, bytes: pdf(), originalName: "energy-history.pdf" });
    await saveProfile(tabitha, energy.id, { active: true, frequency: "MONTHLY", payroll: true });
    await setCoethaLink(tabitha, energy.id, "https://claude.ai/project/energy-1");
    const before = await prisma.client.findUniqueOrThrow({ where: { id: energy.id }, include: { contacts: true } });

    // + Add / Link Another Business, from his current page.
    const drive = await createAndLinkBusiness(tabitha, energy.id, { businessName: "Drive Time (fictional)", clientType: "BUSINESS" });
    const after = await prisma.client.findUniqueOrThrow({ where: { id: energy.id }, include: { contacts: true } });
    expect([after.clientType, after.displayName, after.businessName, after.contacts.length]).toEqual([before.clientType, before.displayName, before.businessName, before.contacts.length]);
    expect(await prisma.client.count({ where: { clientType: "INDIVIDUAL" } })).toBe(0); // Steven isn't entered again
    expect(await prisma.contact.count({ where: { clientId: drive.id } })).toBe(0); // nothing copied over
    const fam = await businessFamily(drive.id);
    expect([fam!.anchor.id, fam!.person, fam!.businesses.map((b) => b.id)]).toEqual([energy.id, null, [energy.id, drive.id]]);

    // His existing login gets Drive Time only when granted; still one login.
    await expect(requireClientAccess(login.id, drive.id)).rejects.toBeInstanceOf(ForbiddenError);
    await grantOwnerPortalAccess(tabitha, energy.id, drive.id, login.id);
    expect((await accessibleClients(login.id)).map((a) => a.clientId).sort()).toEqual([energy.id, drive.id].sort());
    expect(await prisma.portalUser.count()).toBe(1);

    // Separate files, bookkeeping and Coetha links; Energy's history stays on Energy.
    expect((await portalDocuments(actor, energy.id)).map((d) => d.id)).toEqual([eDoc.id]);
    expect(await portalDocuments(actor, drive.id)).toEqual([]);
    await saveProfile(tabitha, drive.id, { active: true, frequency: "MONTHLY", payroll: false });
    await setCoethaLink(tabitha, drive.id, "https://claude.ai/project/drive-2");
    const profiles = await prisma.bookkeepingProfile.findMany({ where: { clientId: { in: [energy.id, drive.id] } } });
    expect(Object.fromEntries(profiles.map((p) => [p.clientId, [p.coethaUrl, p.payroll]]))).toEqual({ [energy.id]: ["https://claude.ai/project/energy-1", true], [drive.id]: ["https://claude.ai/project/drive-2", false] });

    // One group: no adding from Drive Time, no duplicate, no nesting.
    await expect(createAndLinkBusiness(tabitha, drive.id, { businessName: "Third Co (fictional)", clientType: "BUSINESS" })).rejects.toThrow(/main record/);
    await expect(createAndLinkBusiness(tabitha, energy.id, { businessName: "Drive Time (fictional)", clientType: "BUSINESS" })).rejects.toThrow(/Already in the CRM/);
    const other = await createClient(tabitha, { businessName: "Other Owner Co (fictional)", clientType: "BUSINESS", status: "ACTIVE" });
    await expect(linkBusiness(tabitha, other.id, energy.id)).rejects.toThrow(/main record of its own group/);
    await expect(linkBusiness(tabitha, other.id, drive.id)).rejects.toThrow(/already linked to/);
  });

  it("proposes links for an Admin to confirm; nothing is linked or merged automatically", async () => {
    const tabitha = await makeUser("ADMIN", "Tabitha");
    const daria = await makeUser("STAFF", "Daria");
    const person = await createClient(tabitha, { firstName: "Sam", lastName: "Owner", email: "sam@fictional.example", clientType: "INDIVIDUAL", status: "ACTIVE" });
    const biz = await createClient(tabitha, { businessName: "Sam's Shop (fictional)", clientType: "BUSINESS", status: "ACTIVE" });
    await saveContact(tabitha, biz.id, null, { name: "Sam Owner", email: "sam@fictional.example" });
    const p = await proposedLinks();
    expect(p.map((x) => [x.person.id, x.business.id, x.reason])).toEqual([[person.id, biz.id, "same email"]]);
    expect(await prisma.clientRelationship.count()).toBe(0);
    await expect(confirmProposedLink(daria, person.id, biz.id)).rejects.toBeInstanceOf(ForbiddenError);
    await confirmProposedLink(tabitha, person.id, biz.id);
    expect(await proposedLinks()).toEqual([]);
    expect(await prisma.client.count()).toBe(2); // nothing merged or deleted
  });
});
