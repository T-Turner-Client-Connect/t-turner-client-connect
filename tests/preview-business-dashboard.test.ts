import { beforeEach, describe, expect, it, vi } from "vitest";
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { makeUser, managed, prisma, resetDb } from "./db";
import type { Actor } from "@/lib/auth/actor";
import { ForbiddenError } from "@/lib/auth/actor";
import { createClient } from "@/lib/services/clients";
import { acceptPortalInvite, invitePortalUser } from "@/lib/services/portal-accounts";
import { accessibleClients, businessViewEligible, hasBusinessView, requireClientAccess } from "@/lib/portal/access";
import { businessDashboardFor, homeKind, portalBankFeed, portalBusinessDashboard } from "@/lib/services/portal-business";
import { BusinessDashboardView } from "@/components/portal/business-dashboard";
import { PortalHomeView } from "@/components/portal/home-view";

/**
 * View as Client for a business with a business view, and the Bookkeeping Client list rule
 * (an OWNER login of an active Bookkeeping Client gets the business dashboard). Fictional data only.
 */

let staff: Actor | null = null;
vi.mock("@/lib/auth/session", async (orig) => ({ ...(await orig<object>()), requireUser: async () => staff, getCurrentUser: async () => staff }));
// Imported after the mock is registered (vi.mock is hoisted).
const { default: PortalPreview } = await import("@/app/(app)/clients/[id]/portal-preview/page");

beforeEach(async () => {
  await resetDb();
  staff = null;
});

async function world() {
  const tabitha = await makeUser("ADMIN", "Tabitha");
  await prisma.ownerAccess.create({ data: { userId: tabitha.id, isPrimary: true } });
  staff = tabitha;
  const pat = await createClient(tabitha, { firstName: "Pat", lastName: "Pretend", clientType: "INDIVIDUAL", status: "ACTIVE", email: "pat@fictional.example" });
  const bakery = await createClient(tabitha, { businessName: "Lakeside Pretend Bakery LLC", clientType: "BUSINESS", status: "ACTIVE", assignedToId: tabitha.id });
  const other = await createClient(tabitha, { businessName: "Other Fictional Hauling LLC", clientType: "BUSINESS", status: "ACTIVE", assignedToId: tabitha.id });
  const { token } = await invitePortalUser(tabitha, pat.id, { email: "pat@fictional.example", name: "Pat Pretend", role: "OWNER" });
  const u = await acceptPortalInvite(token!, "Pat-Strong-Pass-12345");
  await invitePortalUser(tabitha, bakery.id, { email: "pat@fictional.example", name: "Pat Pretend", role: "OWNER" });
  const login = { id: u.id, name: u.name, email: u.email };
  // An authorized contact (a fictional office manager) of the bakery.
  const { token: t2 } = await invitePortalUser(tabitha, bakery.id, { email: "casey@fictional.example", name: "Casey Contact", role: "AUTHORIZED_CONTACT" });
  const casey = await acceptPortalInvite(t2!, "Casey-Strong-Pass-12345");
  // Another owner, of the other business.
  const { token: t3 } = await invitePortalUser(tabitha, other.id, { email: "sam@fictional.example", name: "Sam Sample", role: "OWNER" });
  const sam = await acceptPortalInvite(t3!, "Sam-Strong-Pass-12345");
  return { tabitha, pat, bakery, other, login, contact: { id: casey.id, name: casey.name, email: casey.email }, sam: { id: sam.id, name: sam.name, email: sam.email } };
}

/** Puts the client on the Bookkeeping Client list (an active bookkeeping profile), as /bookkeeping/new does. */
const onBookkeepingList = (clientId: string) => prisma.bookkeepingProfile.create({ data: { clientId, accountingBasis: "CASH", einLast4: "4821" } });

/** The first element of a component type anywhere in a rendered server-component tree. */
function find(node: ReactNode, type: unknown): ReactElement<Record<string, unknown>> | null {
  if (Array.isArray(node)) {
    for (const n of node) {
      const hit = find(n, type);
      if (hit) return hit;
    }
    return null;
  }
  if (!isValidElement(node)) return null;
  if (node.type === type) return node as ReactElement<Record<string, unknown>>;
  return find((node.props as { children?: ReactNode }).children, type);
}
const preview = async (id: string, sp: Record<string, string> = {}) => (await PortalPreview({ params: Promise.resolve({ id }), searchParams: Promise.resolve(sp) })) as ReactNode;

describe("View as Client: business dashboard", () => {
  it("an approved Managed Business previews as the business dashboard, read-only, with the portal's data, and is audited", async () => {
    const { bakery, login } = await world();
    await managed(bakery.id);
    const tree = await preview(bakery.id, { month: "2026-10" });
    const dash = find(tree, BusinessDashboardView);
    expect(dash).not.toBeNull();
    expect(find(tree, PortalHomeView)).toBeNull();
    const props = dash!.props as { d: Awaited<ReturnType<typeof businessDashboardFor>>; readOnly: boolean; base: string; q: string; personalQ: string | null; previewHref: (p: string, e?: string) => string | null; tiles: { testId: string; href: string | null }[]; linkFor: (id: string) => string };
    expect(props.readOnly).toBe(true);
    expect(props.d.client.name).toBe("Lakeside Pretend Bakery LLC");
    expect(props.d.selected).toBe("2026-10"); // the same ?month= selection as the portal
    expect(props.base).toBe(`/clients/${bakery.id}/portal-preview?view=home`);
    expect(props.personalQ).toBeNull();
    // Owner-level data, the same the owner's login sees.
    const own = await portalBusinessDashboard(login, bakery.id, "2026-10");
    expect(JSON.stringify(props.d)).toBe(JSON.stringify(own));
    // Links stay in the preview; portal pages with no preview are disabled, never the portal login.
    expect(props.previewHref("/client/messages", "c=conv-1")).toBe(`/clients/${bakery.id}/portal-preview?view=messages&c=conv-1`);
    expect(props.previewHref("/client/documents")).toBe(`/clients/${bakery.id}/portal-preview?view=documents`);
    expect(props.previewHref("/client/billing")).toBeNull();
    expect(props.previewHref("/client/bookkeeping")).toBeNull();
    expect(props.tiles.every((t) => t.href === null || t.href.startsWith(`/clients/${bakery.id}/portal-preview?`))).toBe(true);
    expect(props.tiles.find((t) => t.testId === "biz-billing")?.href ?? null).toBeNull();
    // Documents open with a staff token, never a portal one.
    expect(props.linkFor("doc-1")).toMatch(/^\/api\/documents\//);
    const audits = await prisma.auditLog.findMany({ where: { action: "portal.staff_preview", entityId: bakery.id } });
    expect(audits).toHaveLength(1);
    expect(audits[0].actorId).toBe(staff!.id);
  });

  it("a regular tax client still previews as the regular tax Home", async () => {
    const { pat } = await world();
    const tree = await preview(pat.id);
    expect(find(tree, PortalHomeView)).not.toBeNull();
    expect(find(tree, BusinessDashboardView)).toBeNull();
    expect((find(tree, PortalHomeView)!.props as { readOnly: boolean }).readOnly).toBe(true);
  });

  it("a client on the Bookkeeping Client list previews as the business dashboard; deactivating the profile goes back to the regular Home", async () => {
    const { bakery } = await world();
    await onBookkeepingList(bakery.id);
    expect(find(await preview(bakery.id), BusinessDashboardView)).not.toBeNull();
    await prisma.bookkeepingProfile.update({ where: { clientId: bakery.id }, data: { active: false } });
    const tree = await preview(bakery.id);
    expect(find(tree, BusinessDashboardView)).toBeNull();
    expect(find(tree, PortalHomeView)).not.toBeNull();
  });

  it("staff without billing permission don't see the business's billing in the preview", async () => {
    const { bakery } = await world();
    await managed(bakery.id);
    staff = await makeUser("STAFF", "Daria");
    const d = (find(await preview(bakery.id), BusinessDashboardView)!.props as { d: { account: unknown; perms: { canViewBilling: boolean } } }).d;
    expect(d.account).toBeNull();
    expect(d.perms.canViewBilling).toBe(false);
  });

  it("businessDashboardFor gives the same result as portalBusinessDashboard for an owner", async () => {
    const { bakery, login } = await world();
    await managed(bakery.id);
    const access = await requireClientAccess(login.id, bakery.id, "bookkeeping");
    await prisma.portalUser.update({ where: { id: login.id }, data: { preferredState: "GA" } });
    const viaPortal = await portalBusinessDashboard(login, bakery.id);
    const direct = await businessDashboardFor(bakery.id, undefined, { canUpload: access.canUpload, canMessage: access.canMessage, canViewBilling: access.canViewBilling }, "GA");
    expect(JSON.stringify(direct)).toBe(JSON.stringify(viaPortal));
    expect(direct.state).toBe("GA");
    // The EIN never leaves the server in full.
    expect(JSON.stringify(direct)).not.toMatch(/einEncrypted|einHash/);
  });
});

describe("Bookkeeping Client list = business dashboard for OWNER logins", () => {
  it("the rule itself", () => {
    const owner = { role: "OWNER" as const, canViewBookkeeping: false };
    const contact = { role: "AUTHORIZED_CONTACT" as const, canViewBookkeeping: false };
    const bk = { active: true };
    expect(hasBusinessView(owner, { businessAccess: "OFF", bookkeepingProfile: bk })).toBe(true);
    expect(hasBusinessView(contact, { businessAccess: "OFF", bookkeepingProfile: bk })).toBe(false);
    expect(hasBusinessView({ ...contact, canViewBookkeeping: true }, { businessAccess: "OFF", bookkeepingProfile: bk })).toBe(true);
    expect(hasBusinessView(owner, { businessAccess: "OFF", bookkeepingProfile: { active: false } })).toBe(false);
    expect(hasBusinessView(owner, { businessAccess: "OFF", bookkeepingProfile: null })).toBe(false);
    expect(hasBusinessView(owner, { businessAccess: "REMOVED", bookkeepingProfile: bk })).toBe(false);
    // The Managed Business route is unchanged: ACTIVE plus the per-login switch.
    expect(hasBusinessView(owner, { businessAccess: "ACTIVE", bookkeepingProfile: null })).toBe(false);
    expect(hasBusinessView({ ...owner, canViewBookkeeping: true }, { businessAccess: "ACTIVE", bookkeepingProfile: null })).toBe(true);
    expect(hasBusinessView({ ...owner, canViewBookkeeping: true }, { businessAccess: "OFF", bookkeepingProfile: null })).toBe(false);
    expect(businessViewEligible({ businessAccess: "OFF", bookkeepingProfile: bk })).toBe(true);
  });

  it("an owner login of an active Bookkeeping Client lands on the business dashboard with no approval step", async () => {
    const { bakery, pat, login } = await world();
    await onBookkeepingList(bakery.id);
    const client = await prisma.client.findUniqueOrThrow({ where: { id: bakery.id } });
    expect(client.businessAccess).toBe("OFF"); // never approved by hand
    const accounts = await accessibleClients(login.id);
    expect(homeKind(accounts.find((a) => a.clientId === bakery.id)!)).toBe("BUSINESS");
    expect(homeKind(accounts.find((a) => a.clientId === pat.id)!)).toBe("PERSONAL");
    // The gates the dashboard relies on agree with the Home.
    const d = await portalBusinessDashboard(login, bakery.id);
    expect(d.client).toMatchObject({ name: "Lakeside Pretend Bakery LLC", einLast4: "4821", active: true });
    await expect(requireClientAccess(login.id, bakery.id, "bookkeeping")).resolves.toBeTruthy();
    await expect(portalBankFeed(login, bakery.id)).resolves.toMatchObject({ connected: false });
    // Nothing was switched on for the login itself.
    expect((await prisma.portalAccess.findFirstOrThrow({ where: { portalUserId: login.id, clientId: bakery.id } })).canViewBookkeeping).toBe(false);
  });

  it("an authorized contact of the same client does not, unless the per-login switch is on", async () => {
    const { bakery, contact } = await world();
    await onBookkeepingList(bakery.id);
    const [mine] = await accessibleClients(contact.id);
    expect(homeKind(mine)).toBe("PERSONAL");
    await expect(portalBusinessDashboard(contact, bakery.id)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(portalBankFeed(contact, bakery.id)).rejects.toBeInstanceOf(ForbiddenError);
    await prisma.portalAccess.updateMany({ where: { portalUserId: contact.id, clientId: bakery.id }, data: { canViewBookkeeping: true } });
    expect(homeKind((await accessibleClients(contact.id))[0])).toBe("BUSINESS");
    await expect(portalBusinessDashboard(contact, bakery.id)).resolves.toBeTruthy();
  });

  it("a deactivated bookkeeping profile falls back to the regular Home and the bookkeeping gate refuses; nothing is deleted", async () => {
    const { bakery, login } = await world();
    await onBookkeepingList(bakery.id);
    expect(homeKind((await accessibleClients(login.id)).find((a) => a.clientId === bakery.id)!)).toBe("BUSINESS");
    await prisma.bookkeepingProfile.update({ where: { clientId: bakery.id }, data: { active: false } });
    expect(homeKind((await accessibleClients(login.id)).find((a) => a.clientId === bakery.id)!)).toBe("PERSONAL");
    await expect(requireClientAccess(login.id, bakery.id, "bookkeeping")).rejects.toBeInstanceOf(ForbiddenError);
    await expect(portalBusinessDashboard(login, bakery.id)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(portalBankFeed(login, bakery.id)).rejects.toBeInstanceOf(ForbiddenError);
    // The login and the profile are still there.
    await expect(requireClientAccess(login.id, bakery.id)).resolves.toBeTruthy();
    expect(await prisma.bookkeepingProfile.count({ where: { clientId: bakery.id } })).toBe(1);
  });

  it("removing Managed Business access takes the dashboard away even while the client is on the list", async () => {
    const { bakery, login } = await world();
    await onBookkeepingList(bakery.id);
    await prisma.client.update({ where: { id: bakery.id }, data: { businessAccess: "REMOVED" } });
    expect(homeKind((await accessibleClients(login.id)).find((a) => a.clientId === bakery.id)!)).toBe("PERSONAL");
    await expect(portalBusinessDashboard(login, bakery.id)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("a login never sees another business's dashboard", async () => {
    const { bakery, other, login, sam } = await world();
    await onBookkeepingList(bakery.id);
    await onBookkeepingList(other.id);
    expect((await accessibleClients(login.id)).map((a) => a.clientId)).not.toContain(other.id);
    await expect(portalBusinessDashboard(login, other.id)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(portalBankFeed(login, other.id)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(portalBusinessDashboard(sam, bakery.id)).rejects.toBeInstanceOf(ForbiddenError);
    expect((await portalBusinessDashboard(sam, other.id)).client.name).toBe("Other Fictional Hauling LLC");
  });
});
