import { beforeEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { makeUser, managed, prisma, resetDb } from "./db";
import { createClient } from "@/lib/services/clients";
import { acceptPortalInvite, invitePortalUser } from "@/lib/services/portal-accounts";
import { resolveAccount } from "@/lib/portal/account";
import { loadPortalHome } from "@/lib/portal/views";
import { hasPayrollService } from "@/lib/services/service-profile";
import { homeKind, portalBusinessDashboard } from "@/lib/services/portal-business";
import { PortalHomeView } from "@/components/portal/home-view";
import { BusinessDashboardView } from "@/components/portal/business-dashboard";
import { businessHomeTiles } from "@/components/portal/business-home-view";

/**
 * The business-tax-only Home (a BUSINESS client with no personal tax service, not on the
 * bookkeeping side): no "Personal taxes" card, and the Payroll tile only when Payroll is an
 * assigned service. The individual tax Home and the bookkeeping dashboard are unchanged.
 * Fictional people and businesses only.
 */

vi.mock("next/navigation", async (orig) => ({ ...(await orig<object>()), useRouter: () => ({ push() {}, replace() {}, refresh() {} }) }));

beforeEach(async () => {
  await resetDb();
});

async function world() {
  const tabitha = await makeUser("ADMIN", "Tabitha");
  await prisma.ownerAccess.create({ data: { userId: tabitha.id, isPrimary: true } });
  // One person: a personal (individual tax) account and a business-tax-only business, one login.
  const pat = await createClient(tabitha, { firstName: "Pat", lastName: "Pretend", clientType: "INDIVIDUAL", status: "ACTIVE", email: "pat@fictional.example" });
  const shop = await createClient(tabitha, { businessName: "Pretend Corner Shop LLC", clientType: "BUSINESS", status: "ACTIVE", services: "Business tax return (1065/1120-S/1120)" });
  const { token } = await invitePortalUser(tabitha, pat.id, { email: "pat@fictional.example", name: "Pat Pretend", role: "OWNER" });
  const u = await acceptPortalInvite(token!, "Pat-Strong-Pass-12345");
  await invitePortalUser(tabitha, shop.id, { email: "pat@fictional.example", name: "Pat Pretend", role: "OWNER" });
  return { tabitha, pat, shop, login: { id: u.id, name: u.name, email: u.email } };
}

async function home(loginId: string, clientId: string) {
  const { current } = await resolveAccount(loginId, clientId);
  const data = await loadPortalHome(clientId, current!, loginId);
  return { data, current: current!, html: renderToStaticMarkup(createElement(PortalHomeView, { data, q: `?account=${clientId}`, clientId, accountName: current!.client.businessName || current!.client.displayName, linkFor: (id: string) => `/api/documents/t-${id}` })) };
}

describe("business-tax-only Home", () => {
  it("has no Personal taxes card, and no Payroll tile unless Payroll is an assigned service", async () => {
    const { shop, login } = await world();
    const h = await home(login.id, shop.id);
    expect(h.data.businessOnly).toBe(true);
    expect(homeKind(h.current)).toBe("PERSONAL"); // not on the bookkeeping side: the business-tax Home
    expect(h.html).toContain('data-testid="k1-panel"'); // My K-1s, as before
    expect(h.html).not.toContain('data-testid="personal-tax-panel"');
    expect(h.html).not.toMatch(/Request personal tax preparation|Personal taxes/);
    expect(h.html).not.toContain('data-testid="biz-payroll"');
    expect(h.html).toContain('data-testid="biz-documents"');
  });

  it("shows the Payroll tile when Payroll is assigned — by the Services list, an open Payroll service, or the payroll switch", async () => {
    const { tabitha, shop, login } = await world();
    // 1. The client record's Services list (any case).
    await prisma.client.update({ where: { id: shop.id }, data: { services: ["Business tax return (1065/1120-S/1120)", "payroll"] } });
    expect((await home(login.id, shop.id)).html).toContain('data-testid="biz-payroll"');
    // 2. An open Payroll service on Services & Agreements.
    await prisma.client.update({ where: { id: shop.id }, data: { services: ["Business tax return (1065/1120-S/1120)"] } });
    expect((await home(login.id, shop.id)).html).not.toContain('data-testid="biz-payroll"');
    const svc = await prisma.clientService.create({ data: { clientId: shop.id, type: "PAYROLL", title: "Payroll (fictional)", createdById: tabitha.id } });
    expect((await home(login.id, shop.id)).html).toContain('data-testid="biz-payroll"');
    await prisma.clientService.update({ where: { id: svc.id }, data: { status: "CLOSED" } });
    expect((await home(login.id, shop.id)).html).not.toContain('data-testid="biz-payroll"');
    // 3. The rule itself.
    expect(hasPayrollService({ services: [" Payroll "] })).toBe(true);
    expect(hasPayrollService({ services: [], bookkeepingProfile: { payroll: true } })).toBe(true);
    expect(hasPayrollService({ services: [] }, ["PAYROLL"])).toBe(true);
    expect(hasPayrollService({ services: ["Payroll reports"] })).toBe(false);
  });

  it("the individual tax Home is unchanged, and one login sees each account's own Home through the account switcher", async () => {
    const { pat, shop, login } = await world();
    const before = await prisma.client.count();
    const { accounts } = await resolveAccount(login.id);
    expect(accounts.map((a) => a.clientId).sort()).toEqual([pat.id, shop.id].sort());
    const personal = await home(login.id, pat.id);
    expect(personal.data.businessOnly).toBe(false);
    for (const id of ["hero", "action-questionnaire", "upload-button", "retrieve-button", "appointments-button", "news-button", "tax-center", "countdowns-panel"]) expect(personal.html, id).toContain(`data-testid="${id}"`);
    expect(personal.html).not.toContain('data-testid="k1-panel"');
    const business = await home(login.id, shop.id);
    expect(business.html).toContain('data-testid="business-home"');
    expect(business.html).not.toContain('data-testid="action-questionnaire"');
    // No duplicate client records.
    expect(await prisma.client.count()).toBe(before);
  });

  it("the bookkeeping dashboard's tiles and tracker are unchanged (Payroll tile by the login's payroll permission, as before)", async () => {
    const { shop, login } = await world();
    await managed(shop.id); // enrolled on the bookkeeping service
    const { current } = await resolveAccount(login.id, shop.id);
    expect(homeKind(current!)).toBe("BUSINESS");
    const data = await loadPortalHome(shop.id, current!, login.id);
    const tiles = businessHomeTiles(data, (p) => `${p}?account=${shop.id}`, `/client/documents?account=${shop.id}`, `/client/payroll?account=${shop.id}`);
    expect(tiles.map((t) => t.testId)).toContain("biz-payroll");
    const d = await portalBusinessDashboard(login, shop.id, "2026-10");
    const html = renderToStaticMarkup(createElement(BusinessDashboardView, { d, tiles, q: `?account=${shop.id}`, base: `/client?account=${shop.id}`, linkFor: (id: string) => id, personalQ: null }));
    expect(html).toContain('data-testid="biz-payroll"');
    expect(html).toContain('data-testid="books-progress"');
    expect(html).toContain('data-testid="coetha-card"');
  });
});
