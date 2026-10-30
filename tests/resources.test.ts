import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeUser, prisma, resetDb } from "./db";
import { ForbiddenError } from "@/lib/auth/actor";
import { createClient } from "@/lib/services/clients";
import { acceptPortalInvite, invitePortalUser } from "@/lib/services/portal-accounts";
import { checkResourceLinks, coverage, moveResource, requestResourceHelp, resourcesFor, saveResource, setPreferredState, setResourceHidden } from "@/lib/services/resources";
import { EXPECTED_STATE_CATEGORIES, STATES } from "@/lib/resources/catalog";

const PDF = new TextEncoder().encode("%PDF-1.4\n% fictional\n");
beforeEach(resetDb);
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

async function portal(email: string, name: string) {
  const tab = await makeUser("ADMIN");
  const c = await createClient(tab, { firstName: name, lastName: "Client", clientType: "INDIVIDUAL", status: "ACTIVE" });
  const { token } = await invitePortalUser(tab, c.id, { email, name, role: "OWNER" });
  const u = await acceptPortalInvite(token!, "Client-Pass-1234");
  return { tab, client: c, user: { id: u.id, name: u.name, email: u.email } };
}

const base = { category: "TAX_PORTAL", title: "My Alabama Taxes", purpose: "File and pay Alabama taxes.", agency: "Alabama Department of Revenue", url: "https://myalabamataxes.alabama.gov/", status: "VERIFIED" };

describe("catalog", () => {
  it("covers all 50 states plus DC", () => {
    expect(STATES).toHaveLength(51);
    expect(STATES.some((s) => s.code === "DC")).toBe(true);
  });
});

describe("resources", () => {
  it("shows the chosen state plus federal, hides hidden rows, and reports honest coverage", async () => {
    const tab = await makeUser("ADMIN");
    await saveResource(tab, { ...base, jurisdiction: "AL" });
    await saveResource(tab, { ...base, jurisdiction: "TX", title: "Texas portal", url: "https://comptroller.texas.gov/" });
    const irs = await saveResource(tab, { ...base, jurisdiction: "US", category: "FEDERAL_TAX", title: "IRS", agency: "IRS", url: "https://www.irs.gov/" });
    const al = await resourcesFor("AL");
    expect(al.map((r) => r.jurisdiction).sort()).toEqual(["AL", "US"]);
    expect((await resourcesFor("TX")).some((r) => r.id === irs.id)).toBe(true); // federal always available
    await setResourceHidden(tab, irs.id, true);
    expect((await resourcesFor("AL")).some((r) => r.id === irs.id)).toBe(false);
    const c = coverage("AL", al);
    expect(c.complete).toBe(false);
    expect(c.missing).toHaveLength(EXPECTED_STATE_CATEGORIES.length - 1);
    await expect(resourcesFor("ZZ")).rejects.toThrow(/Choose a state/);
  });

  it("only Admins edit; verified needs an https link; not-applicable needs a reason", async () => {
    const daria = await makeUser("STAFF");
    const tab = await makeUser("ADMIN");
    await expect(saveResource(daria, { ...base, jurisdiction: "AL" })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(saveResource(tab, { ...base, jurisdiction: "AL", url: "" })).rejects.toThrow(/needs its official link/);
    await expect(saveResource(tab, { ...base, jurisdiction: "AL", url: "http://example.com" })).rejects.toThrow(/https/);
    await expect(saveResource(tab, { ...base, jurisdiction: "TX", category: "INDIVIDUAL_INCOME_TAX", status: "NOT_APPLICABLE", url: "" })).rejects.toThrow(/Explain why/);
    const na = await saveResource(tab, { ...base, jurisdiction: "TX", category: "INDIVIDUAL_INCOME_TAX", status: "NOT_APPLICABLE", url: "", notes: "Texas doesn't tax individual wage income." });
    expect(na.status).toBe("NOT_APPLICABLE");
    const r = await saveResource(tab, { ...base, jurisdiction: "AL" });
    expect(r.verificationMethod).toBe("staff");
    expect(r.lastVerifiedAt).not.toBeNull();
  });

  it("reorders within a state and category", async () => {
    const tab = await makeUser("ADMIN");
    const a = await saveResource(tab, { ...base, jurisdiction: "AL", title: "A" });
    const b = await saveResource(tab, { ...base, jurisdiction: "AL", title: "B", url: "https://revenue.alabama.gov/" });
    await moveResource(tab, b.id, "up");
    const order = (await resourcesFor("AL")).map((r) => r.id);
    expect(order.indexOf(b.id)).toBeLessThan(order.indexOf(a.id));
  });

  it("link check records real HTTP results without deleting anything", async () => {
    const tab = await makeUser("ADMIN");
    await saveResource(tab, { ...base, jurisdiction: "AL" });
    await saveResource(tab, { ...base, jurisdiction: "AL", title: "Broken", url: "https://broken.alabama.gov/" });
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => new Response("", { status: String(url).includes("broken") ? 404 : init.method === "HEAD" ? 405 : 200 }));
    expect(await checkResourceLinks(10, 0)).toEqual({ checked: 2, ok: 1, failed: 1 });
    const rows = await prisma.resource.findMany({ orderBy: { title: "asc" } });
    expect(rows.map((r) => [r.title, r.linkCheckOk, r.linkCheckStatus])).toEqual([["Broken", false, 404], ["My Alabama Taxes", true, 200]]);
  });
});

describe("client requests", () => {
  it("file into the client's own record with state and topic, save a supporting document by year, and alert the office", async () => {
    const { client, user } = await portal("ana@example.com", "Ana");
    await setPreferredState(user, "AL");
    expect((await prisma.portalUser.findUniqueOrThrow({ where: { id: user.id } })).preferredState).toBe("AL");
    await expect(setPreferredState(user, "XX")).rejects.toThrow();
    const convo = await requestResourceHelp(user, { clientId: client.id, topic: "NONPROFIT_SETUP", state: "AL", area: "NONPROFIT_FORMATION", message: "We want to start a nonprofit.", file: { bytes: PDF, originalName: "bylaws.pdf" }, year: 2026 });
    expect(convo.clientId).toBe(client.id);
    expect(convo.subject).toBe("Request Nonprofit Setup — Alabama · Nonprofit formation");
    const msg = await prisma.message.findFirstOrThrow({ where: { conversationId: convo.id }, include: { attachments: true } });
    expect(msg.body).toMatch(/State: Alabama/);
    expect(msg.attachments[0]).toMatchObject({ clientId: client.id, year: 2026, needsReview: true });
    expect((await prisma.conversation.findUniqueOrThrow({ where: { id: convo.id } })).awaitingStaff).toBe(true);
    const sam = await requestResourceHelp(user, { clientId: client.id, topic: "SAM_ASSISTANCE", state: "US", message: "Help renewing SAM.gov" });
    expect(sam.subject).toMatch(/Request SAM.gov Assistance — Federal/);
  });

  it("can't file into another client's record", async () => {
    const a = await portal("a@example.com", "A");
    const b = await portal("b@example.com", "B");
    await expect(requestResourceHelp(a.user, { clientId: b.client.id, topic: "HELP", state: "AL", message: "hi" })).rejects.toBeInstanceOf(ForbiddenError);
    expect(await prisma.conversation.count({ where: { clientId: b.client.id } })).toBe(0);
  });
});
