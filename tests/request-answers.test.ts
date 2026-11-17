import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeUser, managed, prisma, resetDb } from "./db";
import { createClient } from "@/lib/services/clients";
import { setupLedger } from "@/lib/services/ledger";
import { acceptPortalInvite, invitePortalUser } from "@/lib/services/portal-accounts";
import { answerRequestYourself, createClientRequest } from "@/lib/services/client-requests";
import { askLetterTemplate, clientResponsesForCoetha, portalExplainRequest } from "@/lib/services/ask-client";

// Fictional businesses and people only. Coetha is off here: answers are saved and nothing is sent.
beforeEach(async () => { await resetDb(); });
afterEach(() => { vi.unstubAllGlobals(); });

async function setup() {
  const tabitha = await makeUser("ADMIN", "Tabitha");
  await prisma.ownerAccess.create({ data: { userId: tabitha.id, isPrimary: true } });
  const staff = await makeUser("STAFF", "Morgan");
  const biz = await createClient(tabitha, { businessName: "Juniper Example Studio (fictional)", clientType: "BUSINESS", status: "ACTIVE" });
  const other = await createClient(tabitha, { businessName: "Cedar Example Works (fictional)", clientType: "BUSINESS", status: "ACTIVE" });
  await managed(biz.id, other.id);
  for (const c of [biz, other]) await setupLedger(tabitha, c.id, { basis: "CASH" });
  const { token } = await invitePortalUser(tabitha, biz.id, { email: "owner@juniper.example", name: "Robin Example", role: "OWNER" });
  const login = await acceptPortalInvite(token!, "Owner-Pass-12345");
  const { token: t2 } = await invitePortalUser(tabitha, other.id, { email: "owner@cedar.example", name: "Sky Example", role: "OWNER" });
  const otherLogin = await acceptPortalInvite(t2!, "Owner-Pass-67890");
  return { tabitha, staff, biz, other, portal: { id: login.id, name: login.name, email: login.email }, otherPortal: { id: otherLogin.id, name: otherLogin.name, email: otherLogin.email } };
}

describe("answering a question without leaving the page", () => {
  it("Tabitha answers a held question on its card: saved as her decision, closed, nothing sent to the client", async () => {
    const s = await setup();
    const { request } = await createClientRequest(s.tabitha, s.biz.id, { kind: "SUPPORTING", title: "Check #163, $450.00, cleared April 29, 2026: who was it paid to and why?", reason: "No payee or purpose." }, { send: false });
    await expect(answerRequestYourself(s.staff, s.biz.id, request!.id, "Owner draw")).rejects.toThrow();
    const r = await answerRequestYourself(s.tabitha, s.biz.id, request!.id, "Owner draw, paid personally");
    const after = await prisma.documentRequest.findUniqueOrThrow({ where: { id: request!.id } });
    expect(after).toMatchObject({ officeAnswer: "Owner draw, paid personally", officeAnsweredById: s.tabitha.id, status: "CANCELLED" });
    expect(after.sentAt).toBeNull();
    expect(await prisma.notification.count({ where: { portalUserId: s.portal.id } })).toBe(0);
    expect(await prisma.auditLog.count({ where: { action: "request.answered_by_office", entityId: request!.id } })).toBe(1);
    expect(r.handed).toBe(false); // Coetha is off in this test: the answer waits for her.
    expect((await clientResponsesForCoetha(s.biz.id)).find((x) => x.request.startsWith("Check #163"))).toMatchObject({ tabithasAnswer: "Owner draw, paid personally" });
  });

  it("a client answers any sent question in the portal by typing; another business's login can't", async () => {
    const s = await setup();
    const { request } = await createClientRequest(s.tabitha, s.biz.id, { kind: "GENERAL", title: "What was the $911.53 deposit on March 9, 2026?" }, { send: true });
    expect(request!.status).toBe("OPEN");
    await expect(portalExplainRequest(s.otherPortal, s.biz.id, request!.id, "Not mine")).rejects.toThrow();
    await portalExplainRequest(s.portal, s.biz.id, request!.id, "A refund from the supply company");
    expect(await prisma.documentRequest.findUniqueOrThrow({ where: { id: request!.id } })).toMatchObject({ status: "SUBMITTED", clientExplanation: "A refund from the supply company", explainedByPortalId: s.portal.id });
  });

  it("the request letter gives the portal address to answer at", () => {
    const t = askLetterTemplate([{ title: "Receipt for check #1043", reason: null, instructions: null, dueAt: null, account: null, period: null }]);
    expect(JSON.stringify(t.blocks)).toMatch(/\/client\)/);
  });
});
