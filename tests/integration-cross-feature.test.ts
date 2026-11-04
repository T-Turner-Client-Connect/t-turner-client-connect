import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeUser, prisma, resetDb } from "./db";
import { ForbiddenError, type Actor } from "@/lib/auth/actor";
import { applyPermissionPreset, can, setStaffPermissions } from "@/lib/auth/permissions";
import { DARIA_PRESET, GRANTABLE_KEYS } from "@/lib/permissions";
import { createClient } from "@/lib/services/clients";
import { acceptPortalInvite } from "@/lib/services/portal-accounts";
import { inviteBusinessOwner, saveBusinessOwner, setOwnerPermissions, setOwnerPermissionsManager } from "@/lib/services/business-owners";
import { accessibleClients, requireClientAccess } from "@/lib/portal/access";
import { ownerHasPermission } from "@/lib/portal/owner-permissions";
import { homeKind, portalBankFeed, portalBusinessDashboard } from "@/lib/services/portal-business";
import { categorizeBankTransaction, importBankCsv, setupLedger } from "@/lib/services/ledger";
import { setOwnerSwitch } from "@/lib/services/owner-switches";
import { approveCoethaProposal, decideCoethaProposals, rejectCoethaProposal, runCoetha } from "@/lib/services/coetha";
import { approveReport, deliverReport, openWorkPeriod, saveProfile, submitReportForReview } from "@/lib/services/bookkeeping-clients";
import { staffUploadDocument } from "@/lib/services/documents";
import { handleInboundSms } from "@/lib/services/inbound-sms";
import { dispatchPendingNotifications, queuePortalNotification } from "@/lib/services/notifications";
import { normalizePhone } from "@/lib/normalize";
import { submitSmsConsent } from "@/lib/services/sms-consent";

/**
 * Cross-feature checks for the integrated branch (#76 Coetha + Plaid, #77 staff permissions,
 * #78 client business view, #79 communication preferences, #81 business owners). Fictional
 * office, businesses and people only; every outside service is a local stand-in.
 */

let seq = 0;
const pdf = () => new TextEncoder().encode(`%PDF-1.4\n% fictional ${seq++}\n`);
const CSV = (rows: string[]) => ["Date,Description,Amount", ...rows].join("\n");
const mail: { to: string; subject: string }[] = [];
const sms: { to: string; body: string }[] = [];

// Local stand-ins: Anthropic (Coetha), the malware scanner, Resend and Twilio.
function fakeNetwork() {
  vi.stubGlobal("fetch", vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const u = new URL(typeof url === "string" ? url : url instanceof URL ? url.href : url.url);
    if (u.host === "scanner.test") return new Response(JSON.stringify({ clean: true }), { status: 200 });
    if (u.host === "resend.mock") {
      const b = JSON.parse(String(init?.body));
      mail.push({ to: Array.isArray(b.to) ? b.to[0] : b.to, subject: b.subject });
      return new Response(JSON.stringify({ id: `em${mail.length}` }), { status: 200 });
    }
    if (u.host === "api.twilio.com") {
      const p = new URLSearchParams(String(init?.body));
      sms.push({ to: p.get("To")!, body: p.get("Body")! });
      return new Response(JSON.stringify({ sid: `SM${sms.length}` }), { status: 201 });
    }
    if (u.host === "api.anthropic.com") {
      const req = JSON.parse(String(init?.body));
      const input = JSON.parse(req.messages[0].content.replace(/^[^\n]*\n/, "")) as { toCategorize: { ref: string }[]; monthToClose: string };
      const out = {
        categories: input.toCategorize.map((t) => ({ ref: t.ref, accountCode: "6300", confidence: 0.9, reason: "Office supplies" })),
        discrepancies: [],
        adjustingEntries: [],
        monthSummary: { month: input.monthToClose, summary: "Quiet month.", highlights: [] },
      };
      return new Response(JSON.stringify({ id: "msg_f", type: "message", role: "assistant", model: req.model, content: [{ type: "text", text: JSON.stringify(out) }], stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 10, output_tokens: 10 } }), { status: 200, headers: { "content-type": "application/json", "request-id": "req_f" } });
    }
    throw new Error(`Unexpected network call: ${u.href}`);
  }));
}

beforeEach(async () => {
  await resetDb();
  mail.length = 0;
  sms.length = 0;
  for (const [k, v] of Object.entries({
    MALWARE_SCAN_URL: "https://scanner.test/scan",
    ANTHROPIC_API_KEY: "sk-ant-test-fictional",
    RESEND_API_KEY: "re_test",
    RESEND_API_BASE: "https://resend.mock",
    EMAIL_FROM_ADDRESS: "office@example.com",
    TWILIO_ACCOUNT_SID: "ACtest",
    TWILIO_AUTH_TOKEN: "t",
    TWILIO_MESSAGING_SERVICE_SID: "MGtest",
    NOTIFICATIONS_ENABLED: "true",
    APP_URL: "https://client.example.test",
  })) vi.stubEnv(k, v);
  fakeNetwork();
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

async function office() {
  const tabitha = await makeUser("ADMIN", "Tabitha");
  await prisma.ownerAccess.create({ data: { userId: tabitha.id, isPrimary: true, scope: "FULL" } });
  const admin = await makeUser("ADMIN", "Second Admin");
  const daria = await makeUser("STAFF", "Daria");
  const marcus = await makeUser("STAFF", "Marcus");
  return { tabitha, admin, daria, marcus };
}

/** A fictional two-owner LLC; each owner accepts their own invitation. */
async function llc(tabitha: Actor) {
  const biz = await createClient(tabitha, { businessName: "Pretend Pinewood Supply LLC", clientType: "BUSINESS", status: "ACTIVE", services: "Business tax return (1065/1120-S/1120), Bookkeeping" });
  const logins = [];
  for (const name of ["Rowan Pretend", "Sage Pretend"]) {
    const { owner } = await saveBusinessOwner(tabitha, biz.id, null, { name, email: `${name.split(" ")[0].toLowerCase()}@pinewood.example`, ownership: "50", title: "MEMBER", receivesK1: true });
    const { token } = await inviteBusinessOwner(tabitha, biz.id, owner.id);
    const u = await acceptPortalInvite(token!, "Portal-Pass-123");
    logins.push({ owner, user: { id: u.id, name: u.name, email: u.email } });
  }
  return { biz, rowan: logins[0], sage: logins[1] };
}

describe("business owners x client business dashboard: financial data needs the banking/financial permission", () => {
  it("an owner sees the dashboard, balances and ledger figures only when Tabitha granted banking on a Managed Business", async () => {
    const { tabitha, daria } = await office();
    const { biz, rowan, sage } = await llc(tabitha);

    // Ownership alone grants nothing financial.
    await expect(portalBusinessDashboard(rowan.user, biz.id)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(portalBankFeed(rowan.user, biz.id)).rejects.toBeInstanceOf(ForbiddenError);
    expect(await ownerHasPermission(rowan.user.id, biz.id, "banking", "view")).toBe(false);
    expect(homeKind((await accessibleClients(rowan.user.id)).find((a) => a.clientId === biz.id)!)).toBe("PERSONAL");

    // Not a Managed Business yet: banking can't be turned on, not even by Tabitha.
    await expect(setOwnerPermissions(tabitha, biz.id, rowan.owner.id, { canViewBookkeeping: true })).rejects.toThrow(/Regular Tax Client/);

    // Managed Business: staff allowed to set owner permissions still can't turn banking on; Tabitha can.
    await prisma.client.update({ where: { id: biz.id }, data: { businessAccess: "ACTIVE" } });
    await setupLedger(tabitha, biz.id, { basis: "CASH" });
    await setOwnerPermissionsManager(tabitha, daria.id, true);
    await expect(setOwnerPermissions(daria, biz.id, rowan.owner.id, { canViewBookkeeping: true })).rejects.toBeInstanceOf(ForbiddenError);
    await setOwnerPermissions(daria, biz.id, rowan.owner.id, { canViewDocuments: true }); // other areas are fine for her
    await setOwnerPermissions(tabitha, biz.id, rowan.owner.id, { canViewBookkeeping: true });

    expect(homeKind((await accessibleClients(rowan.user.id)).find((a) => a.clientId === biz.id)!)).toBe("BUSINESS");
    const d = await portalBusinessDashboard(rowan.user, biz.id);
    expect(d).toBeTruthy();
    await expect(portalBankFeed(rowan.user, biz.id)).resolves.toBeTruthy();
    // The other owner still sees none of it.
    await expect(portalBusinessDashboard(sage.user, biz.id)).rejects.toBeInstanceOf(ForbiddenError);

    // If the business stops being Managed, the grant stops working at once.
    await prisma.client.update({ where: { id: biz.id }, data: { businessAccess: "REMOVED" } });
    await expect(requireClientAccess(rowan.user.id, biz.id, "bookkeeping")).rejects.toBeInstanceOf(ForbiddenError);
    await expect(portalBusinessDashboard(rowan.user, biz.id)).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe("staff permissions x Coetha x bank feed", () => {
  async function books() {
    const o = await office();
    const biz = await createClient(o.tabitha, { businessName: "Pretend Lantern Works LLC", clientType: "BUSINESS", status: "ACTIVE", assignedToId: o.daria.id });
    await prisma.client.update({ where: { id: biz.id }, data: { businessAccess: "ACTIVE" } });
    await setupLedger(o.tabitha, biz.id, { basis: "CASH" });
    const checking = (await prisma.ledgerAccount.findFirstOrThrow({ where: { clientId: biz.id, code: "1000" } })).id;
    await importBankCsv(o.tabitha, biz.id, checking, { fileName: "oct.csv", text: CSV(["10/02/2026,OFFICE DEPOT #1123,-84.20", "10/06/2026,PAPER PRETEND CO,-12.00"]) });
    await setOwnerSwitch(o.tabitha, "coetha", true);
    await runCoetha(o.tabitha, biz.id, { month: "2026-10", today: "2026-11-04" });
    const proposals = await prisma.coethaProposal.findMany({ where: { clientId: biz.id, kind: "CATEGORY", status: "PROPOSED" } });
    return { ...o, biz, proposals };
  }

  it("staff without Banking -> Edit can't categorize or post; nobody but Tabitha posts a Coetha draft, whatever their grants", async () => {
    const s = await books();
    expect(s.proposals.length).toBe(2);
    const office5300 = (await prisma.ledgerAccount.findFirstOrThrow({ where: { clientId: s.biz.id, code: "6300" } })).id;
    const row = await prisma.bankTransaction.findFirstOrThrow({ where: { clientId: s.biz.id, description: { contains: "PAPER" } } });

    // Marcus isn't assigned: Banking -> View lets him look, not change anything.
    await setStaffPermissions(s.tabitha, s.marcus.id, ["banking.view", "ledger.view", "coetha.view"]);
    await expect(categorizeBankTransaction(s.marcus, s.biz.id, row.id, { accountId: office5300 })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(approveCoethaProposal(s.marcus, s.biz.id, s.proposals[0].id)).rejects.toBeInstanceOf(ForbiddenError);

    // Daria with every grantable permission, and a forged coetha.approve row: still no.
    await setStaffPermissions(s.tabitha, s.daria.id, [...GRANTABLE_KEYS]);
    await prisma.staffPermission.create({ data: { userId: s.daria.id, area: "coetha", action: "approve" } });
    await expect(approveCoethaProposal(s.daria, s.biz.id, s.proposals[0].id)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(rejectCoethaProposal(s.daria, s.biz.id, s.proposals[0].id, "no")).rejects.toBeInstanceOf(ForbiddenError);
    await expect(decideCoethaProposals(s.daria, s.biz.id, "APPROVE", s.proposals.map((p) => ({ id: p.id })))).rejects.toBeInstanceOf(ForbiddenError);
    // A second Admin, even with every grant: no.
    await setStaffPermissions(s.tabitha, s.admin.id, [...GRANTABLE_KEYS]);
    await expect(approveCoethaProposal(s.admin, s.biz.id, s.proposals[0].id)).rejects.toBeInstanceOf(ForbiddenError);
    expect(await prisma.journalEntry.count({ where: { clientId: s.biz.id } })).toBe(0);

    // Daria still does her own (non-Coetha) bookkeeping, and Tabitha's approval is what posts Coetha's draft.
    await categorizeBankTransaction(s.daria, s.biz.id, row.id, { accountId: office5300 });
    const coethaDraft = s.proposals.find((p) => p.bankTransactionId !== row.id)!;
    await approveCoethaProposal(s.tabitha, s.biz.id, coethaDraft.id);
    expect((await prisma.coethaProposal.findUniqueOrThrow({ where: { id: coethaDraft.id } })).status).toBe("APPROVED");
    expect(await prisma.journalEntry.count({ where: { clientId: s.biz.id } })).toBe(2);
  });
});

describe("financial statements: only the primary owner releases them", () => {
  it("staff and Admins can't approve a statement for release, even with every grant and a forged row", async () => {
    const { tabitha, admin, daria } = await office();
    const biz = await createClient(tabitha, { businessName: "Pretend Orchard Bakery LLC", clientType: "BUSINESS", status: "ACTIVE" });
    await saveProfile(tabitha, biz.id, { active: true, frequency: "MONTHLY", payroll: false, assignedToId: daria.id });
    await prisma.client.update({ where: { id: biz.id }, data: { businessAccess: "ACTIVE" } });
    const p = await openWorkPeriod(daria, biz.id, 2026, 10);
    const pl = await staffUploadDocument(daria, { clientId: biz.id, category: "BOOKKEEPING", visibility: "STAFF_ONLY", reportType: "PROFIT_AND_LOSS", periodId: p.id, bytes: pdf(), originalName: "pl.pdf" });
    await submitReportForReview(daria, pl.id);
    for (const who of [daria, admin]) {
      await setStaffPermissions(tabitha, who.id, [...GRANTABLE_KEYS]);
      await prisma.staffPermission.create({ data: { userId: who.id, area: "statements", action: "approve" } });
      expect(await can(who, "statements", "approve")).toBe(false);
      await expect(approveReport(who, pl.id)).rejects.toBeInstanceOf(ForbiddenError);
    }
    await expect(deliverReport(daria, pl.id)).rejects.toThrow(/approve/);
    await approveReport(tabitha, pl.id);
    await deliverReport(daria, pl.id);
    expect((await prisma.document.findUniqueOrThrow({ where: { id: pl.id } })).visibility).toBe("PUBLISHED");
  });
});

describe("communication preferences x portal notices (document requests, K-1s, statements)", () => {
  it("a STOP-blocked owner still gets the essential notice by email; texts are skipped with the reason", async () => {
    const { tabitha } = await office();
    const { biz, rowan } = await llc(tabitha);
    const phone = "205-555-0187";
    await prisma.portalUser.update({ where: { id: rowan.user.id }, data: { phone, phoneNormalized: normalizePhone(phone), notifyBySms: true, notifyByEmail: true } });
    await submitSmsConsent({ name: rowan.user.name, phone, service: true, marketing: false, sourcePage: "/sms-consent", ip: null, userAgent: "test" });
    await handleInboundSms({ MessageSid: "SMstopx", From: phone, Body: "STOP" });
    // Daytime in Central so texts aren't held for quiet hours.
    vi.useFakeTimers({ now: new Date("2026-11-04T18:00:00Z"), toFake: ["Date"] });
    try {
      await queuePortalNotification(rowan.user.id, "DOCUMENT_REQUEST", `request:fictional-1`);
      await dispatchPendingNotifications(rowan.user.id);
    } finally {
      vi.useRealTimers();
    }
    const rows = await prisma.notification.findMany({ where: { portalUserId: rowan.user.id } });
    expect(rows.find((r) => r.channel === "EMAIL")).toMatchObject({ status: "SENT" });
    expect(rows.find((r) => r.channel === "SMS")).toMatchObject({ status: "SKIPPED", statusDetail: expect.stringMatching(/STOP/) });
    expect(mail.filter((m) => m.to === rowan.user.email)).toHaveLength(1);
    expect(sms).toHaveLength(0);
    void biz;
  });
});

describe("Daria's Billing clerk preset reaches Square reconciliation, not owner-only actions", () => {
  it("holds view/create/edit/send/record/reconcile and Square view; never refund, void, credits, settings, integrations or Coetha approval", async () => {
    const { tabitha, daria } = await office();
    await applyPermissionPreset(tabitha, daria.id, DARIA_PRESET.key);
    const yes = ["billing.view", "billing.create", "billing.edit", "billing.send", "billing.record_payment", "receivables.view", "receivables.reconcile", "square.view"] as const;
    const no = ["billing.refund", "billing.void", "billing.adjust", "billing.settings", "billing.delete_history", "square.integrations", "square.edit", "coetha.approve", "statements.approve", "payroll.edit", "staff.manage"] as const;
    for (const k of yes) expect(await can(daria, ...(k.split(".") as [never, never]))).toBe(true);
    for (const k of no) expect(await can(daria, ...(k.split(".") as [never, never]))).toBe(false);
  });
});
