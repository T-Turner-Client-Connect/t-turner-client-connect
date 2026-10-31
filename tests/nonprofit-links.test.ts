import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeUser, prisma, resetDb } from "./db";
import { createClient } from "@/lib/services/clients";
import { acceptPortalInvite, invitePortalUser } from "@/lib/services/portal-accounts";
import { grantOwnerPortalAccess } from "@/lib/services/related-businesses";
import { nonprofitDashboard, runNonprofitReminders, saveNonprofitProfile } from "@/lib/services/nonprofits";
import { createAndLinkNonprofit, linkExistingNonprofit, nonprofitsForClient, setFilingService, setHasNonprofit } from "@/lib/services/nonprofit-links";

beforeEach(async () => {
  await resetDb();
  vi.stubEnv("MALWARE_SCAN_URL", "https://scanner.test/scan");
  vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ clean: true }), { status: 200 }));
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

const names = async (today = "2026-04-15") => (await nonprofitDashboard(today)).map((r) => r.client.displayName);

describe("nonprofits from any client record (bookkeeping not required)", () => {
  it("an owner's business stays a business; the nonprofit is its own linked record; linking grants no access; flags unknowns", async () => {
    const tabitha = await makeUser("ADMIN", "Tabitha");
    const daria = await makeUser("STAFF", "Daria");
    // A business client with no bookkeeping enrollment, and the owner's existing portal login on it.
    const rb = await createClient(tabitha, { businessName: "RB Industrial LLC", firstName: "James", lastName: "Bradley", clientType: "BUSINESS", status: "ACTIVE", email: "james@rb-fictional.example" });
    const { token } = await invitePortalUser(tabitha, rb.id, { email: "james@rb-fictional.example", name: "James Bradley", role: "OWNER" });
    const james = await acceptPortalInvite(token!, "James-Portal-Pass-12");
    expect(await prisma.bookkeepingProfile.count({ where: { clientId: rb.id } })).toBe(0);

    // Not recorded → Yes, but not linked yet: flagged.
    expect((await nonprofitsForClient(rb.id)).has).toBeNull();
    await setHasNonprofit(daria, rb.id, "YES");
    expect((await nonprofitsForClient(rb.id)).flags).toEqual(["Has a nonprofit, but its organization record isn't linked yet"]);
    await expect(setHasNonprofit(daria, rb.id, "MAYBE")).rejects.toThrow(/Not confirmed/);

    // A business record can't be linked as the nonprofit.
    const otherBiz = await createClient(tabitha, { businessName: "Fictional Supply Co", clientType: "BUSINESS", status: "ACTIVE" });
    await expect(linkExistingNonprofit(daria, rb.id, otherBiz.id)).rejects.toThrow(/nonprofit organization record/);

    // Create the nonprofit as its own record, linked under RB Industrial's group.
    const org = await createAndLinkNonprofit(daria, rb.id, { name: "Bradley Community Foundation" });
    const after = await prisma.client.findUniqueOrThrow({ where: { id: rb.id } });
    expect([after.clientType, after.businessName]).toEqual(["BUSINESS", "RB Industrial LLC"]); // unchanged
    expect((await prisma.client.findUniqueOrThrow({ where: { id: org.id } })).clientType).toBe("NONPROFIT");
    let card = await nonprofitsForClient(org.id); // same card from the nonprofit's own record
    expect([card.anchor.id, card.has, card.orgs.map((o) => o.id)]).toEqual([rb.id, "YES", [org.id]]);
    expect(card.flags).toEqual(["Bradley Community Foundation: whether TTurner handles its annual filings isn't recorded"]);
    // Linking never grants access: James's login reaches the nonprofit only after an explicit grant.
    expect(await prisma.portalAccess.count({ where: { portalUserId: james.id, clientId: org.id } })).toBe(0);
    await grantOwnerPortalAccess(tabitha, rb.id, org.id, james.id);
    expect(await prisma.portalAccess.count({ where: { portalUserId: james.id, clientId: org.id, revokedAt: null } })).toBe(1);

    // Not recorded → on the tracker only as "Needs information", with no reminders.
    await prisma.client.update({ where: { id: org.id }, data: { fiscalYearEnd: 12, assignedToId: daria.id } });
    await saveNonprofitProfile(daria, org.id, { formType: "990-EZ", formBasis: "Receipts $150k, assets $80k", reminderDays: "30" });
    let [row] = await nonprofitDashboard("2026-04-15");
    expect([row.service, row.bucket, row.missing]).toEqual([null, "NOT_SET_UP", ["Whether TTurner handles its annual filings isn't recorded"]]);
    expect(await runNonprofitReminders("2026-04-15")).toEqual({ sent: 0 });
    // Pending agreement: still not tracked or reminded.
    await setFilingService(tabitha, org.id, "PENDING_AGREEMENT");
    [row] = await nonprofitDashboard("2026-04-15");
    expect([row.bucket, row.missing]).toEqual(["NOT_SET_UP", ["Filing agreement pending — confirm before tracking its deadline"]]);
    expect(await runNonprofitReminders("2026-04-15")).toEqual({ sent: 0 });
    // Yes: tracked with its deadline and reminded.
    await setFilingService(tabitha, org.id, "YES");
    [row] = await nonprofitDashboard("2026-04-15");
    expect([row.service, row.bucket, row.due, row.missing, row.review]).toEqual(["YES", "DUE", "2026-05-15", [], []]);
    expect(await runNonprofitReminders("2026-04-15")).toEqual({ sent: 1 });
    card = await nonprofitsForClient(rb.id);
    expect(card.flags).toEqual([]);
    // No: off the tracker; records kept.
    await setFilingService(tabitha, org.id, "NO");
    expect(await names()).toEqual([]);
    expect(await prisma.client.count({ where: { id: org.id } })).toBe(1);
    expect(await prisma.auditLog.count({ where: { action: "nonprofit.filing_service_set", entityId: org.id } })).toBe(3);
  });

  it("Nonprofit Interest formation inquiries stay off Nonprofit Filings and are never converted", async () => {
    const tabitha = await makeUser("ADMIN", "Tabitha");
    const interest = await prisma.group.create({ data: { name: "Nonprofit Interest", description: "Interested in nonprofit formation or compliance" } });
    const prospect = await createClient(tabitha, { businessName: "Fictional Harbor Fund", clientType: "NONPROFIT", status: "PROSPECT", groupIds: [interest.id] });
    const existing = await createClient(tabitha, { businessName: "Fictional Food Pantry", clientType: "NONPROFIT", status: "ACTIVE" });
    expect(await names()).toEqual(["Fictional Food Pantry"]); // existing record, flagged until recorded
    expect((await nonprofitDashboard("2026-04-15"))[0].missing).toContain("Whether TTurner handles its annual filings isn't recorded");
    await runNonprofitReminders("2026-04-15");
    const p = await prisma.client.findUniqueOrThrow({ where: { id: prospect.id }, include: { groups: true, nonprofitProfile: true } });
    expect([p.status, p.groups.map((g) => g.groupId), p.nonprofitProfile]).toEqual(["PROSPECT", [interest.id], null]);
    // Only an explicit "Yes" puts a prospect on the tracker.
    await setFilingService(tabitha, prospect.id, "YES");
    expect(await names()).toEqual(["Fictional Food Pantry", "Fictional Harbor Fund"]);
    expect((await prisma.client.findUniqueOrThrow({ where: { id: prospect.id } })).status).toBe("PROSPECT"); // not converted
    await setFilingService(tabitha, existing.id, "NO");
    expect(await names()).toEqual(["Fictional Harbor Fund"]);
  });
});
