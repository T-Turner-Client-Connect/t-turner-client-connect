import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeUser, managed, prisma, resetDb } from "./db";
import { ForbiddenError } from "@/lib/auth/actor";
import { createClient } from "@/lib/services/clients";
import { acceptPortalInvite, invitePortalUser } from "@/lib/services/portal-accounts";
import { importBankCsv, setupLedger } from "@/lib/services/ledger";
import { setOwnerSwitch } from "@/lib/services/owner-switches";
import { runCoetha, runDailyCoetha, scrub } from "@/lib/services/coetha";
import { runWorkflowMonitor } from "@/lib/services/monthly-workflow";
import { saveProfile } from "@/lib/services/bookkeeping-clients";
import { COETHA_CONSENT_TEXT, COETHA_CONSENT_VERSION, coethaConsentState, portalDecideCoetha, portalMayDecideCoetha, staffRecordCoethaConsent } from "@/lib/services/coetha-consent";

// Anthropic's API is never reached: a local stand-in answers, and counts what would have been sent.
let sent = 0;
beforeEach(async () => {
  await resetDb();
  sent = 0;
  vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-test-fictional-key");
  vi.stubGlobal("fetch", vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const u = new URL(typeof url === "string" ? url : url instanceof URL ? url.href : url.url);
    if (u.host !== "api.anthropic.com") throw new Error(`Unexpected request: ${u.href}`);
    sent++;
    const req = JSON.parse(String(init?.body ?? "{}"));
    const text = JSON.stringify({ categories: [], discrepancies: [], adjustingEntries: [], monthSummary: { month: "2026-10", summary: "Quiet month.", highlights: [] } });
    return new Response(JSON.stringify({ id: "msg_fictional", type: "message", role: "assistant", model: req.model, content: [{ type: "text", text }], stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 10, output_tokens: 10 } }), { status: 200, headers: { "content-type": "application/json" } });
  }));
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

const CSV = (rows: string[]) => ["Date,Description,Amount", ...rows].join("\n");
const opts = { month: "2026-10", today: "2026-11-04" };

async function setup() {
  const tabitha = await makeUser("ADMIN", "Tabitha");
  await prisma.ownerAccess.create({ data: { userId: tabitha.id, isPrimary: true } });
  const daria = await makeUser("STAFF", "Daria");
  const vessel = await createClient(tabitha, { businessName: "Vessel Example LLC (fictional)", clientType: "BUSINESS", status: "ACTIVE", assignedToId: daria.id });
  const harbor = await createClient(tabitha, { businessName: "Harbor Example Co (fictional)", clientType: "BUSINESS", status: "ACTIVE", assignedToId: daria.id });
  for (const c of [vessel, harbor]) {
    const { token } = await invitePortalUser(tabitha, c.id, { email: `owner@${c.id}.example`, name: "Pat Pretend", role: "OWNER" });
    await acceptPortalInvite(token!, "Client-Pass-12345");
  }
  const { token: t2 } = await invitePortalUser(tabitha, vessel.id, { email: "bookkeeper@vessel.example", name: "Sam Helper", role: "AUTHORIZED_CONTACT" });
  const helper = await acceptPortalInvite(t2!, "Client-Pass-12345");
  await managed(vessel.id, harbor.id);
  for (const c of [vessel, harbor]) {
    await setupLedger(tabitha, c.id, { basis: "CASH" });
    const checking = (await prisma.ledgerAccount.findFirstOrThrow({ where: { clientId: c.id, code: "1000" } })).id;
    await importBankCsv(tabitha, c.id, checking, { fileName: "oct.csv", text: CSV(["10/02/2026,OFFICE DEPOT #1123,-84.20"]) });
    await saveProfile(tabitha, c.id, { active: true, frequency: "MONTHLY", payroll: false });
  }
  await setOwnerSwitch(tabitha, "coetha", true);
  const ownerOf = async (clientId: string) => {
    const pu = await prisma.portalUser.findFirstOrThrow({ where: { access: { some: { clientId, role: "OWNER" } } } });
    return { id: pu.id, name: pu.name, email: pu.email };
  };
  return { tabitha, daria, vessel, harbor, vesselOwner: await ownerOf(vessel.id), harborOwner: await ownerOf(harbor.id), helper: { id: helper.id, name: helper.name, email: helper.email } };
}

describe("Coetha client notice and authorization", () => {
  it("the screening before the AI service matches the notice: client identifiers removed, long numbers cut to four digits, merchant names kept", () => {
    expect(scrub("HOME DEPOT #4410 card for jane@example.com 205-555-1234 ACCT 000123456789 SSN 123-45-6789 EIN 12-3456789")).toBe(
      "HOME DEPOT #4410 card for [email] [phone] ACCT …6789 SSN [id] EIN [id]",
    );
  });

  it("the notice says who provides the assistant, exactly what is and isn't removed, that Tabitha approves, and that the client can decline or withdraw", () => {
    const text = COETHA_CONSENT_TEXT.join(" ");
    expect(COETHA_CONSENT_VERSION).toBe("2026-11-v2");
    expect(text).toMatch(/AI assistant, provided by Anthropic/);
    expect(text).toMatch(/categories/);
    expect(text).toMatch(/reconcile/);
    // The notice must describe what the scrubber really does, not promise more.
    expect(text).not.toMatch(/remove names, account numbers and other identifiers/);
    expect(text).toMatch(/leave out your name and remove email addresses, phone numbers and Social Security or EIN-format numbers/);
    expect(text).toMatch(/Long numbers, such as account numbers, are shortened to their last four digits/);
    expect(text).toMatch(/Transaction amounts, dates and descriptions are sent, and descriptions may include merchant or payee names/);
    expect(text).toMatch(/Tabitha reviews every draft and approves it/);
    expect(text).toMatch(/decline, or withdraw .* at any time/);
    expect(text).toMatch(/without the assistant/);
  });

  it("no consent → every Coetha run, draft and request generation is refused with a clear message; nothing is sent", async () => {
    const s = await setup();
    await expect(runCoetha(s.daria, s.vessel.id, opts)).rejects.toThrow(/hasn't authorized the AI assistant notice/);
    await expect(runWorkflowMonitor(null, s.vessel.id, 2026, 10, { today: "2026-11-04" })).rejects.toThrow(/hasn't authorized/);
    expect(sent).toBe(0);
    expect(await prisma.coethaProposal.count()).toBe(0);
    expect(await prisma.documentRequest.count({ where: { source: "COETHA" } })).toBe(0);
    expect((await runDailyCoetha()).ran).toBe(0);
  });

  it("authorized (portal, by the business owner) → allowed; withdrawn → refused again; every change is audited", async () => {
    const s = await setup();
    // Only the business owner with banking access answers — not an authorized contact.
    expect(await portalMayDecideCoetha(s.vesselOwner.id, s.vessel.id)).toBe(true);
    expect(await portalMayDecideCoetha(s.helper.id, s.vessel.id)).toBe(false);
    await expect(portalDecideCoetha(s.helper, s.vessel.id, "AUTHORIZED")).rejects.toBeInstanceOf(ForbiddenError);
    await portalDecideCoetha(s.vesselOwner, s.vessel.id, "AUTHORIZED");
    const st = await coethaConsentState(s.vessel.id);
    expect(st).toMatchObject({ ok: true, state: "AUTHORIZED" });
    expect(st.consent).toMatchObject({ method: "PORTAL", version: COETHA_CONSENT_VERSION, portalUserId: s.vesselOwner.id, decidedByName: "Pat Pretend" });
    await runCoetha(s.daria, s.vessel.id, opts);
    expect(sent).toBe(1);
    await portalDecideCoetha(s.vesselOwner, s.vessel.id, "WITHDRAWN");
    await expect(runCoetha(s.daria, s.vessel.id, opts)).rejects.toThrow(/declined or withdrew/);
    expect(sent).toBe(1);
    const audits = await prisma.auditLog.findMany({ where: { clientId: s.vessel.id, action: { startsWith: "coetha.consent_" } }, orderBy: { createdAt: "asc" } });
    expect(audits.map((a) => a.action)).toEqual(["coetha.consent_authorized", "coetha.consent_withdrawn"]);
    // Declining is also recorded, and refused.
    await portalDecideCoetha(s.harborOwner, s.harbor.id, "DECLINED");
    await expect(runCoetha(s.daria, s.harbor.id, opts)).rejects.toThrow(/declined/);
  });

  it("an authorization of an older notice version must be renewed", async () => {
    const s = await setup();
    await prisma.coethaConsent.create({ data: { clientId: s.vessel.id, status: "AUTHORIZED", version: "2026-11-v1", method: "PORTAL", portalUserId: s.vesselOwner.id } });
    expect(await coethaConsentState(s.vessel.id)).toMatchObject({ ok: false, state: "OLD_VERSION" });
    await expect(runCoetha(s.daria, s.vessel.id, opts)).rejects.toThrow(/earlier version of the AI assistant notice/);
    await portalDecideCoetha(s.vesselOwner, s.vessel.id, "AUTHORIZED");
    await runCoetha(s.daria, s.vessel.id, opts);
    expect(sent).toBe(1);
  });

  it("staff record an in-office or written answer only with a method and a note", async () => {
    const s = await setup();
    await expect(staffRecordCoethaConsent(s.daria, s.vessel.id, { status: "AUTHORIZED", method: "", note: "Signed form in the client file" })).rejects.toThrow(/in the office, or in writing/);
    await expect(staffRecordCoethaConsent(s.daria, s.vessel.id, { status: "AUTHORIZED", method: "PORTAL", note: "Signed form in the client file" })).rejects.toThrow(/in the office, or in writing/);
    await expect(staffRecordCoethaConsent(s.daria, s.vessel.id, { status: "AUTHORIZED", method: "WRITTEN", note: "" })).rejects.toThrow(/Add a note/);
    const stranger = await makeUser("STAFF", "Stranger");
    await expect(staffRecordCoethaConsent(stranger, s.vessel.id, { status: "AUTHORIZED", method: "WRITTEN", note: "Signed form in the client file" })).rejects.toBeInstanceOf(ForbiddenError);
    await staffRecordCoethaConsent(s.daria, s.vessel.id, { status: "AUTHORIZED", method: "IN_OFFICE", note: "Pat signed the notice at the 11/3 meeting; copy in the file", clientName: "Pat Pretend" });
    expect(await coethaConsentState(s.vessel.id)).toMatchObject({ ok: true });
    const row = await prisma.coethaConsent.findFirstOrThrow({ where: { clientId: s.vessel.id } });
    expect(row).toMatchObject({ method: "IN_OFFICE", recordedById: s.daria.id, version: COETHA_CONSENT_VERSION });
    expect(await prisma.auditLog.count({ where: { action: "coetha.consent_authorized", actorId: s.daria.id } })).toBe(1);
  });

  it("one client's consent doesn't cover another", async () => {
    const s = await setup();
    await portalDecideCoetha(s.vesselOwner, s.vessel.id, "AUTHORIZED");
    // Vessel's owner can't answer for Harbor.
    await expect(portalDecideCoetha(s.vesselOwner, s.harbor.id, "AUTHORIZED")).rejects.toBeInstanceOf(ForbiddenError);
    await runCoetha(s.daria, s.vessel.id, opts);
    await expect(runCoetha(s.daria, s.harbor.id, opts)).rejects.toThrow(/hasn't authorized/);
    await expect(runWorkflowMonitor(null, s.harbor.id, 2026, 10, { today: "2026-11-04" })).rejects.toThrow(/hasn't authorized/);
    expect(sent).toBe(1);
  });
});
