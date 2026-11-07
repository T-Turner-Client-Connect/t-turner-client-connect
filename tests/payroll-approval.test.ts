import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { makeUser, managed, prisma, resetDb } from "./db";
import { ForbiddenError, type Actor } from "@/lib/auth/actor";
import { setStaffPermissions } from "@/lib/auth/permissions";
import { setOwnerPermissions } from "@/lib/services/business-owners";
import { recordEmailBlock } from "@/lib/services/comm-prefs";
import { createClient } from "@/lib/services/clients";
import { saveProfile } from "@/lib/services/bookkeeping-clients";
import { setupLedger } from "@/lib/services/ledger";
import { normalizePhone } from "@/lib/normalize";
import { submitSmsConsent } from "@/lib/services/sms-consent";
import { setClientTexting } from "@/lib/services/staff-alerts";
import { handleInboundSms } from "@/lib/services/inbound-sms";
import { discardPayrollRun, editPayrollRun, importPayrollRegister, loadRun, postPayrollRun, savePayrollSetup } from "@/lib/services/payroll";
import {
  approvalDelivery, approverDashboard, approverRunView, dispatchHeldPayrollTexts, PAYROLL_SMS_NOTICE, canManagePayrollApprovers, decideByLink, decidePayroll, isPayrollApprover, LINK_TTL_MS, linkView, notifyApprovers, requestPayrollApproval,
  resolveLink, runTimeline, sendLinkCode, setNotifyChannel, setPayrollApprover, submitPayrollRun, verifyLink,
} from "@/lib/services/payroll-approval";

// Fictional business "Pretend Tailored Smoke LLC" with four fictional owners. Email (Resend) and
// texts (Twilio) are simulated: nothing leaves the test.
const NOON = new Date("2026-11-04T18:00:00Z"); // 12:00 Central — inside the texting window
const sms: { to: string; body: string }[] = [];
const mail: { to: string; subject: string; text: string }[] = [];
const failEmailTo = new Set<string>(); // addresses the simulated email provider rejects
const ENV = { TWILIO_ACCOUNT_SID: "ACtest", TWILIO_AUTH_TOKEN: "t", TWILIO_MESSAGING_SERVICE_SID: "MGtest", RESEND_API_KEY: "re_test", EMAIL_FROM_ADDRESS: "office@example.com", RESEND_API_BASE: "https://resend.mock", NOTIFICATIONS_ENABLED: "true", APP_URL: "https://client.example.test" };

beforeEach(async () => {
  await resetDb();
  sms.length = 0;
  mail.length = 0;
  failEmailTo.clear();
  Object.assign(process.env, ENV);
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
    if (String(url).startsWith("https://api.twilio.com/")) {
      const p = new URLSearchParams(String(init.body));
      sms.push({ to: p.get("To")!, body: p.get("Body")! });
      return new Response(JSON.stringify({ sid: `SM${sms.length}` }), { status: 201 });
    }
    if (String(url).startsWith("https://resend.mock/")) {
      const b = JSON.parse(String(init.body));
      if (failEmailTo.has(Array.isArray(b.to) ? b.to[0] : b.to)) return new Response(JSON.stringify({ message: "rejected (simulated)" }), { status: 422 });
      mail.push({ to: Array.isArray(b.to) ? b.to[0] : b.to, subject: b.subject, text: b.text });
      return new Response(JSON.stringify({ id: `em${mail.length}` }), { status: 200 });
    }
    throw new Error(`Unexpected network call: ${url}`);
  }));
});
afterEach(() => {
  vi.unstubAllGlobals();
  for (const k of Object.keys(ENV)) delete process.env[k];
});

const fixture = new Uint8Array(readFileSync(path.join(import.meta.dirname, "fixtures/payroll/adp-wfn-register.csv")));

async function setup(opts: { texting?: boolean } = {}) {
  const tabitha = await makeUser("ADMIN", "Tabitha");
  await prisma.ownerAccess.create({ data: { userId: tabitha.id, isPrimary: true, scope: "FULL" } });
  const daria = await makeUser("STAFF", "Daria"); // payroll operator, assigned to the business
  const sam = await makeUser("STAFF", "Sam"); // staff without billing/payroll permission
  const biz = await createClient(tabitha, { businessName: "Pretend Tailored Smoke LLC", clientType: "BUSINESS", status: "ACTIVE" });
  await prisma.client.update({ where: { id: biz.id }, data: { assignedToId: daria.id } });
  const owners = [];
  for (const [i, name] of ["Avery Pretend", "Blake Pretend", "Casey Pretend", "Devon Pretend"].entries()) {
    const phone = `555010${i}130`;
    const u = await prisma.portalUser.create({ data: { email: `${name.split(" ")[0].toLowerCase()}@example.com`, name, phone, phoneNormalized: normalizePhone(phone), passwordHash: "x", emailVerifiedAt: new Date() } });
    await prisma.portalAccess.create({ data: { portalUserId: u.id, clientId: biz.id } });
    // Each is a business owner (Owners card) with their own login: only owners approve payroll.
    const contact = await prisma.contact.create({ data: { clientId: biz.id, name, email: u.email, emailNormalized: u.email } });
    await prisma.businessOwner.create({ data: { clientId: biz.id, contactId: contact.id, portalUserId: u.id, ownershipBps: 2500 } });
    await submitSmsConsent({ name, phone, service: true, marketing: false, sourcePage: "/sms-consent", ip: null, userAgent: "test" });
    owners.push(u);
  }
  await managed(biz.id);
  await saveProfile(tabitha, biz.id, { active: true, frequency: "MONTHLY", payroll: true, payrollFrequency: "BIWEEKLY", payrollProvider: "ADP" });
  await savePayrollSetup(tabitha, biz.id, { system: "ADP_WFN", frequency: "BIWEEKLY" });
  await setupLedger(tabitha, biz.id, { basis: "CASH" });
  if (opts.texting !== false) await setClientTexting(tabitha, true);
  // The general client portal rollout stays OFF in every test: payroll approvals don't depend on it.
  await prisma.integrationSettings.upsert({ where: { id: "default" }, create: { id: "default", clientRolloutAuthorized: false }, update: { clientRolloutAuthorized: false } });
  const [a, b, c, d] = owners;
  // 4 owners are approvers; only Avery and Blake are required.
  await setPayrollApprover(tabitha, biz.id, a.id, { approver: true, required: true });
  await setPayrollApprover(tabitha, biz.id, b.id, { approver: true, required: true });
  await setPayrollApprover(tabitha, biz.id, c.id, { approver: true, required: false });
  const imp = await importPayrollRegister(daria, biz.id, { bytes: fixture, fileName: "wfn.csv", preset: "ADP_WFN" });
  const runId = imp.created[0];
  return { tabitha, daria, sam, biz, a, b, c, d, runId };
}

const portalMeta = { channel: "PORTAL" as const, verifiedBy: "PORTAL_SESSION" as const, ip: "203.0.113.5", userAgent: "test-browser" };
const current = async (clientId: string, runId: string) => (await loadRun(clientId, runId)).version;
const decide = async (s: Awaited<ReturnType<typeof setup>>, who: { id: string }, decision: "APPROVED" | "DENIED", comment?: string) =>
  decidePayroll(who.id, s.biz.id, s.runId, { decision, comment, versionId: (await current(s.biz.id, s.runId)).id }, portalMeta);
const tokenFrom = (body: string) => body.match(/payroll-approval\/([\w-]+)/)![1];
const status = async (runId: string) => (await prisma.payrollRun.findUniqueOrThrow({ where: { id: runId } })).status;

describe("approver designation", () => {
  it("only Tabitha (or staff she authorizes) chooses approvers; owners and other staff can't; every change audited", async () => {
    const s = await setup();
    await expect(setPayrollApprover(s.sam, s.biz.id, s.d.id, { approver: true, required: true })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(setPayrollApprover(s.daria, s.biz.id, s.d.id, { approver: true, required: true })).rejects.toBeInstanceOf(ForbiddenError);
    const ownerAsActor: Actor = { id: s.a.id, role: "ADMIN", name: s.a.name, email: s.a.email };
    await expect(setPayrollApprover(ownerAsActor, s.biz.id, s.d.id, { approver: true, required: true })).rejects.toBeInstanceOf(ForbiddenError);
    // Billing/Square grants alone don't open it: choosing approvers is "Payroll → Edit" in Staff Access & Permissions.
    await setStaffPermissions(s.tabitha, s.daria.id, ["square.view", "square.edit", "billing.view", "billing.edit"]);
    await expect(setPayrollApprover(s.daria, s.biz.id, s.d.id, { approver: true, required: true })).rejects.toBeInstanceOf(ForbiddenError);
    await setStaffPermissions(s.tabitha, s.daria.id, ["payroll.edit"]);
    await setPayrollApprover(s.daria, s.biz.id, s.d.id, { approver: true, required: false });
    expect(await isPayrollApprover(s.d.id, s.biz.id)).toBe(true);
    expect(await prisma.auditLog.count({ where: { action: "payroll.approver_set", clientId: s.biz.id } })).toBe(4);
    // Revoking portal access ends approver rights too.
    await prisma.portalAccess.updateMany({ where: { portalUserId: s.d.id }, data: { revokedAt: new Date() } });
    expect(await isPayrollApprover(s.d.id, s.biz.id)).toBe(false);
  });
});

describe("approval flow", () => {
  it("2 of 4 owners required: both must approve the same version; Fully Approved never auto-releases", async () => {
    const s = await setup();
    await requestPayrollApproval(s.daria, s.biz.id, s.runId, NOON);
    expect(await status(s.runId)).toBe("AWAITING_APPROVAL");
    await decide(s, s.c, "APPROVED"); // optional approver: doesn't complete it
    await decide(s, s.a, "APPROVED");
    expect(await status(s.runId)).toBe("AWAITING_APPROVAL");
    await decide(s, s.b, "APPROVED");
    const run = await prisma.payrollRun.findUniqueOrThrow({ where: { id: s.runId } });
    expect(run.status).toBe("FULLY_APPROVED");
    // No auto-release: not submitted, nothing sent to a provider.
    expect(run.submittedAt).toBeNull();
    await expect(decide(s, s.c, "DENIED", "late")).rejects.toThrow(/already fully approved/);
    await submitPayrollRun(s.daria, s.biz.id, s.runId, { note: "Entered in ADP WFN" });
    expect(await status(s.runId)).toBe("SUBMITTED");
  });

  it("a staff edit after one approval invalidates it; the run must be re-sent and re-approved on the new version", async () => {
    const s = await setup();
    await requestPayrollApproval(s.daria, s.biz.id, s.runId, NOON);
    await decide(s, s.a, "APPROVED");
    const v1 = await current(s.biz.id, s.runId);
    const lines = v1.lines.map((l) => ({ ...l }));
    lines[1].hoursHundredths += 50;
    await editPayrollRun(s.daria, s.biz.id, s.runId, { lines, reason: "Ben's overtime corrected" });
    expect(await status(s.runId)).toBe("DRAFT");
    await expect(decide(s, s.b, "APPROVED")).rejects.toThrow(/isn't waiting/);
    await requestPayrollApproval(s.daria, s.biz.id, s.runId, NOON);
    await decide(s, s.b, "APPROVED");
    // Avery's approval was on version 1: it doesn't count for version 2.
    expect(await status(s.runId)).toBe("AWAITING_APPROVAL");
    await expect(submitPayrollRun(s.daria, s.biz.id, s.runId)).rejects.toThrow(/must approve this version/);
    await decide(s, s.a, "APPROVED");
    expect(await status(s.runId)).toBe("FULLY_APPROVED");
    const approvals = await prisma.payrollApproval.findMany({ where: { runId: s.runId }, orderBy: { createdAt: "asc" } });
    expect(approvals.map((x) => [x.approverName, x.round])).toEqual([["Avery Pretend", 1], ["Blake Pretend", 2], ["Avery Pretend", 2]]);
    expect(approvals[0].versionId).toBe(v1.id);
  });

  it("a denial returns the run to the office with a staff task", async () => {
    const s = await setup();
    await requestPayrollApproval(s.daria, s.biz.id, s.runId, NOON);
    await expect(decide(s, s.a, "DENIED")).rejects.toThrow(/what needs to change/);
    await decide(s, s.a, "DENIED", "Cara's hours look high");
    expect(await status(s.runId)).toBe("DENIED");
    const task = await prisma.task.findFirstOrThrow({ where: { clientId: s.biz.id } });
    expect(task).toMatchObject({ assigneeId: s.daria.id, priority: "HIGH" });
    expect(task.title).toMatch(/Payroll changes requested by Avery Pretend/);
    await expect(submitPayrollRun(s.daria, s.biz.id, s.runId)).rejects.toThrow(/must approve/);
    // The office can re-send after review.
    await requestPayrollApproval(s.daria, s.biz.id, s.runId, NOON);
    expect(await status(s.runId)).toBe("AWAITING_APPROVAL");
  });

  it("a non-approver owner is blocked from viewing or deciding", async () => {
    const s = await setup();
    await requestPayrollApproval(s.daria, s.biz.id, s.runId, NOON);
    await expect(decide(s, s.d, "APPROVED")).rejects.toBeInstanceOf(ForbiddenError);
    await expect(approverRunView(s.d.id, s.biz.id, s.runId)).rejects.toBeInstanceOf(ForbiddenError);
    expect((await approverDashboard(s.d.id)).pending).toHaveLength(0);
  });

  it("an approver can't change anything through the backend: every office mutation rejects a portal login", async () => {
    const s = await setup();
    await requestPayrollApproval(s.daria, s.biz.id, s.runId, NOON);
    const asStaff: Actor = { id: s.a.id, role: "ADMIN", name: s.a.name, email: s.a.email }; // a portal id posing as staff
    const v = await current(s.biz.id, s.runId);
    const attempts = [
      editPayrollRun(asStaff, s.biz.id, s.runId, { lines: v.lines.map((l) => ({ ...l, grossCents: l.grossCents + 1, netPayCents: l.netPayCents + 1 })), reason: "raise" }),
      editPayrollRun(asStaff, s.biz.id, s.runId, { lines: v.lines.slice(1), reason: "remove an employee" }),
      submitPayrollRun(asStaff, s.biz.id, s.runId),
      requestPayrollApproval(asStaff, s.biz.id, s.runId, NOON),
      discardPayrollRun(asStaff, s.biz.id, s.runId, "nope"),
      postPayrollRun(asStaff, s.biz.id, s.runId),
      setPayrollApprover(asStaff, s.biz.id, s.b.id, { approver: true, required: false }),
      savePayrollSetup(asStaff, s.biz.id, { system: "PAYCHEX_FLEX" }),
      importPayrollRegister(asStaff, s.biz.id, { bytes: fixture, fileName: "x.csv", preset: "ADP_WFN" }),
    ];
    for (const p of attempts) await expect(p).rejects.toBeInstanceOf(ForbiddenError);
    // Nor can one owner decide for another or change another owner's notifications.
    await expect(setNotifyChannel({ portalUserId: s.a.id }, s.biz.id, s.b.id, "EMAIL")).rejects.toBeInstanceOf(ForbiddenError);
    expect((await current(s.biz.id, s.runId)).id).toBe(v.id);
    expect(await prisma.payrollApproval.count()).toBe(0);
  });

  it("no approvals or changes after submission", async () => {
    const s = await setup();
    await requestPayrollApproval(s.daria, s.biz.id, s.runId, NOON);
    await decide(s, s.a, "APPROVED");
    await decide(s, s.b, "APPROVED");
    await submitPayrollRun(s.daria, s.biz.id, s.runId);
    await expect(decide(s, s.c, "APPROVED")).rejects.toThrow(/already processed/);
    const v = await current(s.biz.id, s.runId);
    await expect(editPayrollRun(s.daria, s.biz.id, s.runId, { lines: v.lines, reason: "late change" })).rejects.toThrow(/locked/);
    await expect(requestPayrollApproval(s.daria, s.biz.id, s.runId, NOON)).rejects.toThrow(/locked/);
    await expect(submitPayrollRun(s.daria, s.biz.id, s.runId)).rejects.toThrow(/already submitted/);
  });

  it("the audit trail and timeline are complete", async () => {
    const s = await setup();
    await requestPayrollApproval(s.daria, s.biz.id, s.runId, NOON);
    await decide(s, s.a, "APPROVED");
    const v = await current(s.biz.id, s.runId);
    const lines = v.lines.map((l) => ({ ...l }));
    lines[0].hoursHundredths += 25;
    await editPayrollRun(s.daria, s.biz.id, s.runId, { lines, reason: "Hours fix" });
    await requestPayrollApproval(s.daria, s.biz.id, s.runId, NOON);
    await decide(s, s.a, "APPROVED");
    await decide(s, s.b, "APPROVED", "Looks right");
    await submitPayrollRun(s.daria, s.biz.id, s.runId);
    const t = await runTimeline(s.daria, s.biz.id, s.runId);
    expect(t.events.map((e) => e.kind)).toEqual(["CREATED", "APPROVAL_REQUESTED", "APPROVED", "VERSIONED", "APPROVALS_INVALIDATED", "APPROVAL_REQUESTED", "APPROVED", "APPROVED", "FULLY_APPROVED", "SUBMITTED"]);
    const actions = (await prisma.auditLog.findMany({ where: { entityId: s.runId }, orderBy: { createdAt: "asc" } })).map((x) => x.action);
    expect(actions).toEqual(["payroll.approval_requested", "payroll.approved_by_owner", "payroll.run_versioned", "payroll.approval_requested", "payroll.approved_by_owner", "payroll.approved_by_owner", "payroll.run_submitted"]);
    const b = await prisma.payrollApproval.findFirstOrThrow({ where: { portalUserId: s.b.id } });
    expect(b).toMatchObject({ decision: "APPROVED", comment: "Looks right", channel: "PORTAL", ip: "203.0.113.5", userAgent: "test-browser", approverEmail: "blake@example.com", contentHash: (await current(s.biz.id, s.runId)).contentHash });
  });
});

describe("approval requests by text and email", () => {
  it("default: the email carries the secure link; the text only says an approval is waiting in their email", async () => {
    const s = await setup();
    await requestPayrollApproval(s.daria, s.biz.id, s.runId, NOON);
    expect(mail).toHaveLength(3);
    expect(sms).toHaveLength(3);
    expect(mail[0].text).toMatch(/payroll-approval\//);
    for (const m of sms) {
      expect(m.body).toBe(PAYROLL_SMS_NOTICE);
      expect(m.body).not.toMatch(/https?:|payroll-approval|\$|\d{2,}|Rivera|Okafor|Lindqvist/);
    }
    // No text link exists: every link was created for the email.
    expect(await prisma.payrollApprovalLink.count({ where: { channel: "SMS" } })).toBe(0);
  });

  it("each choice sends only to the chosen channel(s); staff can change it at the client's request (audited)", async () => {
    const s = await setup();
    await setNotifyChannel({ portalUserId: s.a.id }, s.biz.id, s.a.id, "EMAIL");
    await setNotifyChannel({ portalUserId: s.b.id }, s.biz.id, s.b.id, "SMS");
    await setNotifyChannel({ staff: s.daria }, s.biz.id, s.c.id, "BOTH");
    await requestPayrollApproval(s.daria, s.biz.id, s.runId, NOON);
    const to = (u: { phoneNormalized: string | null; email: string }) => ({ sms: sms.filter((m) => m.to === u.phoneNormalized).length, mail: mail.filter((m) => m.to === u.email).length });
    expect(to(s.a)).toEqual({ sms: 0, mail: 1 });
    // The email is always the approval request; a "text" choice adds the text notice after it.
    expect(to(s.b)).toEqual({ sms: 1, mail: 1 });
    expect(to(s.c)).toEqual({ sms: 1, mail: 1 });
    expect(await prisma.auditLog.count({ where: { action: "payroll.notify_channel_set" } })).toBe(3);
  });

  it("a STOP-blocked number gets email only, and the approver is shown why", async () => {
    const s = await setup();
    await setNotifyChannel({ portalUserId: s.b.id }, s.biz.id, s.b.id, "SMS");
    await handleInboundSms({ MessageSid: "SMin1", From: s.b.phone!, Body: "STOP" });
    await requestPayrollApproval(s.daria, s.biz.id, s.runId, NOON);
    expect(sms.filter((m) => m.to === s.b.phoneNormalized)).toHaveLength(0);
    expect(mail.filter((m) => m.to === s.b.email)).toHaveLength(1);
    const dash = await approverDashboard(s.b.id);
    expect(dash.channels[0].fallback).toMatch(/opted out/);
    expect(dash.lastFallback?.detail).toMatch(/opted out/);
  });

  it("the texting switch is honored: off means email only", async () => {
    const s = await setup({ texting: false });
    await requestPayrollApproval(s.daria, s.biz.id, s.runId, NOON);
    expect(sms).toHaveLength(0);
    expect(mail).toHaveLength(3);
    expect(await prisma.payrollNotice.count({ where: { channel: "SMS", status: "SKIPPED", detail: { contains: "switched off" } } })).toBe(3);
  });

  it("texts are held for quiet hours", async () => {
    const s = await setup();
    await requestPayrollApproval(s.daria, s.biz.id, s.runId, new Date("2026-11-05T04:00:00Z")); // 10 p.m. Central
    expect(sms).toHaveLength(0);
    expect(await prisma.payrollNotice.count({ where: { channel: "SMS", status: "HELD" } })).toBe(3);
  });

  it("a text reply never approves; the approver is pointed to the email link, with no link in the text", async () => {
    const s = await setup();
    await requestPayrollApproval(s.daria, s.biz.id, s.runId, NOON);
    const r = await handleInboundSms({ MessageSid: "SMin2", From: s.a.phone!, Body: "APPROVE" });
    expect(r.reply).toMatch(/can't be approved by text\. Please use the secure link in your payroll approval email/);
    expect(r.reply).not.toMatch(/https?:|payroll-approval\//);
    expect(await prisma.payrollApproval.count()).toBe(0);
    expect(await status(s.runId)).toBe("AWAITING_APPROVAL");
  });
});

describe("secure single-use links", () => {
  async function linkFor(s: Awaited<ReturnType<typeof setup>>, u: { phoneNormalized: string | null }) {
    void u;
    const user = await prisma.portalUser.findFirstOrThrow({ where: { phoneNormalized: u.phoneNormalized } });
    return tokenFrom(mail.filter((m) => m.to === user.email && /approval needed/.test(m.subject)).at(-1)!.text);
  }
  async function verifyByEmail(token: string, email: string) {
    await sendLinkCode(token);
    const code = mail.filter((m) => m.to === email).at(-1)!.subject.match(/^(\d{6})/)![1];
    return verifyLink(token, { code });
  }

  it("verification is required without a session; after the emailed code the decision is recorded with channel EMAIL", async () => {
    const s = await setup();
    await requestPayrollApproval(s.daria, s.biz.id, s.runId, NOON);
    const token = await linkFor(s, s.a);
    expect((await linkView(token)).state).toBe("OK");
    await expect(decideByLink(token, { decision: "APPROVED" })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(decideByLink(token, { decision: "APPROVED", nonce: "made-up" })).rejects.toBeInstanceOf(ForbiddenError);
    const { nonce } = await verifyByEmail(token, s.a.email);
    await decideByLink(token, { decision: "APPROVED", comment: "OK from my phone", nonce, ip: "198.51.100.7", userAgent: "iPhone test" });
    const a = await prisma.payrollApproval.findFirstOrThrow({ where: { portalUserId: s.a.id } });
    expect(a).toMatchObject({ channel: "EMAIL_LINK", verifiedBy: "EMAIL_CODE", ip: "198.51.100.7", userAgent: "iPhone test", comment: "OK from my phone", decision: "APPROVED" });
  });

  it("a valid portal session for the same approver skips the code; another approver's session doesn't", async () => {
    const s = await setup();
    await requestPayrollApproval(s.daria, s.biz.id, s.runId, NOON);
    const token = await linkFor(s, s.a);
    await expect(decideByLink(token, { decision: "APPROVED", sessionPortalUserId: s.b.id })).rejects.toBeInstanceOf(ForbiddenError);
    await decideByLink(token, { decision: "APPROVED", sessionPortalUserId: s.a.id });
    expect((await prisma.payrollApproval.findFirstOrThrow({ where: { portalUserId: s.a.id } })).verifiedBy).toBe("PORTAL_SESSION");
  });

  it("a link works only for its approver and version, once", async () => {
    const s = await setup();
    await requestPayrollApproval(s.daria, s.biz.id, s.runId, NOON);
    const token = await linkFor(s, s.a);
    await decideByLink(token, { decision: "APPROVED", sessionPortalUserId: s.a.id });
    // Reuse is blocked.
    expect((await resolveLink(token)).state).toBe("USED");
    await expect(decideByLink(token, { decision: "DENIED", comment: "again", sessionPortalUserId: s.a.id })).rejects.toThrow(/already used/);
    expect(await prisma.payrollApproval.count({ where: { portalUserId: s.a.id } })).toBe(1);
  });

  it("a changed run invalidates old links; a new link goes out for the new version; expired links are rejected", async () => {
    const s = await setup();
    await requestPayrollApproval(s.daria, s.biz.id, s.runId, NOON);
    const oldToken = await linkFor(s, s.b);
    const v = await current(s.biz.id, s.runId);
    const lines = v.lines.map((l) => ({ ...l }));
    lines[2].hoursHundredths += 10;
    await editPayrollRun(s.daria, s.biz.id, s.runId, { lines, reason: "Hours fix" });
    expect((await resolveLink(oldToken)).state).toBe("CHANGED");
    await expect(decideByLink(oldToken, { decision: "APPROVED", sessionPortalUserId: s.b.id })).rejects.toThrow(/has changed/);
    await requestPayrollApproval(s.daria, s.biz.id, s.runId, NOON);
    const newToken = await linkFor(s, s.b);
    expect(newToken).not.toBe(oldToken);
    expect((await resolveLink(newToken)).state).toBe("OK");
    await prisma.payrollApprovalLink.updateMany({ where: { runId: s.runId }, data: { expiresAt: new Date(Date.now() - 1000) } });
    expect((await resolveLink(newToken)).state).toBe("EXPIRED");
    await expect(decideByLink(newToken, { decision: "APPROVED", sessionPortalUserId: s.b.id })).rejects.toThrow(/expired/);
    expect(LINK_TTL_MS).toBe(72 * 3600_000);
  });

  it("links are dead once the run is submitted", async () => {
    const s = await setup();
    await requestPayrollApproval(s.daria, s.biz.id, s.runId, NOON);
    const cToken = await linkFor(s, s.c);
    await decide(s, s.a, "APPROVED");
    await decide(s, s.b, "APPROVED");
    expect((await resolveLink(cToken)).state).toBe("COMPLETE");
    await submitPayrollRun(s.daria, s.biz.id, s.runId);
    expect((await resolveLink(cToken)).state).toBe("LOCKED");
    await expect(sendLinkCode(cToken)).rejects.toThrow(/already processed/);
  });

  it("held quiet-hours texts are not resent once the run has changed", async () => {
    const s = await setup();
    await requestPayrollApproval(s.daria, s.biz.id, s.runId, new Date("2026-11-05T04:00:00Z"));
    const v = await current(s.biz.id, s.runId);
    await editPayrollRun(s.daria, s.biz.id, s.runId, { lines: v.lines.map((l, i) => (i ? l : { ...l, hoursHundredths: l.hoursHundredths + 5 })), reason: "fix" });
    const { dispatchHeldPayrollTexts } = await import("@/lib/services/payroll-approval");
    await dispatchHeldPayrollTexts(NOON);
    expect(sms).toHaveLength(0);
    expect(await notifyApprovers(s.runId, NOON)).toBeTruthy();
  });
});

// --- Integration with Business Owners (#81), Communication Preferences (#79) and Staff Access (#77) ---
describe("payroll approval with owner permissions, communication preferences and staff permissions", () => {
  const ownerOf = (clientId: string, portalUserId: string) => prisma.businessOwner.findFirstOrThrow({ where: { clientId, portalUserId } });
  const emailToken = (email: string) => tokenFrom(mail.filter((m) => m.to === email && /approval needed/.test(m.subject)).at(-1)!.text);

  it("the owner's portal permission is the one switch: granting it on the Owners card makes an approver who can approve by link; removing it ends that at once", async () => {
    const s = await setup();
    // Devon is an owner but not an approver yet.
    expect(await isPayrollApprover(s.d.id, s.biz.id)).toBe(false);
    const devon = await ownerOf(s.biz.id, s.d.id);
    await setOwnerPermissions(s.tabitha, s.biz.id, devon.id, { canApprovePayroll: true });
    expect(await isPayrollApprover(s.d.id, s.biz.id)).toBe(true);
    // ...and is now on the approver list (optional: Avery and Blake stay the required ones).
    const row = await prisma.payrollApprover.findUniqueOrThrow({ where: { clientId_portalUserId: { clientId: s.biz.id, portalUserId: s.d.id } } });
    expect(row).toMatchObject({ active: true, required: false });
    await requestPayrollApproval(s.daria, s.biz.id, s.runId, NOON);
    // Devon approves through the emailed link, verified by the code sent to the same address.
    const token = emailToken(s.d.email);
    await sendLinkCode(token);
    const code = mail.filter((m) => m.to === s.d.email).at(-1)!.subject.match(/^(\d{6})/)![1];
    const { nonce } = await verifyLink(token, { code });
    await decideByLink(token, { decision: "APPROVED", nonce });
    expect(await prisma.payrollApproval.count({ where: { portalUserId: s.d.id, decision: "APPROVED", channel: "EMAIL_LINK" } })).toBe(1);

    // Removing the permission (Owners card) removes the approver role and every way to decide.
    await setOwnerPermissions(s.tabitha, s.biz.id, (await ownerOf(s.biz.id, s.c.id)).id, { canApprovePayroll: false });
    expect(await isPayrollApprover(s.c.id, s.biz.id)).toBe(false);
    expect((await prisma.payrollApprover.findUniqueOrThrow({ where: { clientId_portalUserId: { clientId: s.biz.id, portalUserId: s.c.id } } })).active).toBe(false);
    await expect(decide(s, s.c, "APPROVED")).rejects.toBeInstanceOf(ForbiddenError);

    // And the reverse: Payroll approvers (Owner's Office) flips the same permission on the owner's login.
    await setPayrollApprover(s.tabitha, s.biz.id, s.a.id, { approver: false, required: false });
    expect((await prisma.portalAccess.findFirstOrThrow({ where: { clientId: s.biz.id, portalUserId: s.a.id } })).canApprovePayroll).toBe(false);
    expect(await isPayrollApprover(s.a.id, s.biz.id)).toBe(false);
  });

  it("an archived owner, or a login that isn't an owner, never approves even with the flag set", async () => {
    const s = await setup();
    await prisma.businessOwner.updateMany({ where: { clientId: s.biz.id, portalUserId: s.a.id }, data: { archivedAt: new Date() } });
    expect(await isPayrollApprover(s.a.id, s.biz.id)).toBe(false);
    // A bookkeeper's login on the business with the flag forced on: not an owner, so no.
    const helper = await prisma.portalUser.create({ data: { email: "helper@example.com", name: "Helper Pretend", passwordHash: "x" } });
    await prisma.portalAccess.create({ data: { portalUserId: helper.id, clientId: s.biz.id, canApprovePayroll: true } });
    expect(await isPayrollApprover(helper.id, s.biz.id)).toBe(false);
    await expect(setPayrollApprover(s.tabitha, s.biz.id, helper.id, { approver: true, required: false })).rejects.toThrow(/Only a business owner/);
  });

  it("requests go through Communication Preferences: STOP keeps texts off (email still goes) and a bounced address gets no email", async () => {
    const s = await setup();
    await handleInboundSms({ MessageSid: "SMstop1", From: s.a.phone!, Body: "STOP" });
    await recordEmailBlock(s.b.email, "BOUNCE", "Fictional hard bounce");
    await requestPayrollApproval(s.daria, s.biz.id, s.runId, NOON);
    // Avery: STOP-blocked, so email only.
    expect(sms.filter((m) => m.to === s.a.phoneNormalized)).toHaveLength(0);
    expect(mail.filter((m) => m.to === s.a.email)).toHaveLength(1);
    // Blake: email bounced, so no approval email, and no misleading text either; the preparer is told.
    expect(mail.filter((m) => m.to === s.b.email)).toHaveLength(0);
    expect(sms.filter((m) => m.to === s.b.phoneNormalized)).toHaveLength(0);
    expect(await prisma.payrollNotice.findFirstOrThrow({ where: { portalUserId: s.b.id, channel: "EMAIL" } })).toMatchObject({ status: "SKIPPED", detail: expect.stringMatching(/bounce/i) });
    expect(await prisma.payrollNotice.findFirstOrThrow({ where: { portalUserId: s.b.id, channel: "SMS" } })).toMatchObject({ status: "SKIPPED", detail: expect.stringMatching(/email wasn't accepted/) });
    expect(await prisma.task.count({ where: { clientId: s.biz.id, assigneeId: s.daria.id, title: { contains: "email not delivered to Blake" } } })).toBe(1);
    // A marketing opt-out never stops this essential notice.
    await prisma.suppression.create({ data: { channel: "EMAIL", addressNormalized: s.c.email, reason: "UNSUBSCRIBE", note: "promo opt-out" } });
    mail.length = 0;
    await notifyApprovers(s.runId, NOON);
    expect(mail.filter((m) => m.to === s.c.email)).toHaveLength(1);
  });

  it("choosing approvers is Staff Access & Permissions -> Payroll -> Edit, re-read on every call", async () => {
    const s = await setup();
    expect(await canManagePayrollApprovers(s.daria)).toBe(false);
    await setStaffPermissions(s.tabitha, s.daria.id, ["payroll.edit"]);
    expect(await canManagePayrollApprovers(s.daria)).toBe(true);
    await setStaffPermissions(s.tabitha, s.daria.id, []);
    expect(await canManagePayrollApprovers(s.daria)).toBe(false);
    await expect(setPayrollApprover(s.daria, s.biz.id, s.d.id, { approver: true, required: false })).rejects.toBeInstanceOf(ForbiddenError);
  });
});

// --- PAY-1: the complete payroll approval notification workflow ----------------------------------
describe("PAY-1: Send for Approval → email with secure link → text notice → decision → preparer alerted", () => {
  const NIGHT = new Date("2026-11-05T04:00:00Z"); // 10 p.m. Central, outside the texting window
  const runOf = (s: Awaited<ReturnType<typeof setup>>) => prisma.payrollRun.findUniqueOrThrow({ where: { id: s.runId } });

  it("the whole workflow, with the general portal rollout OFF: email (link) → text (notice only) → Approve / Request Changes → preparer alerted → submit", async () => {
    const s = await setup();
    expect((await prisma.integrationSettings.findUniqueOrThrow({ where: { id: "default" } })).clientRolloutAuthorized).toBe(false);
    const { notices } = await requestPayrollApproval(s.daria, s.biz.id, s.runId, NOON);
    // 1. Email first, to each approver, with their own secure single-use link.
    expect(mail.filter((m) => /approval needed/.test(m.subject))).toHaveLength(3);
    expect(notices.filter((n) => n.channel === "EMAIL").every((n) => n.status === "SENT")).toBe(true);
    // 2. Then the text: notice only, after the email was accepted.
    expect(sms).toHaveLength(3);
    expect(sms.every((m) => m.body === PAYROLL_SMS_NOTICE)).toBe(true);
    expect(await approvalDelivery(await runOf(s))).toBe("SENT");
    // 3. The approver opens the emailed link (no portal session needed) and approves.
    const token = tokenFrom(mail.find((m) => m.to === s.a.email)!.text);
    await sendLinkCode(token);
    const code = mail.filter((m) => m.to === s.a.email).at(-1)!.subject.match(/^(\d{6})/)![1];
    const { nonce } = await verifyLink(token, { code });
    await decideByLink(token, { decision: "APPROVED", nonce });
    // 4. The preparer is alerted at once; Blake approves in the portal; the run is Client Approved.
    expect(await prisma.task.count({ where: { assigneeId: s.daria.id, title: { contains: "Payroll approved by Avery" } } })).toBe(1);
    await decide(s, s.b, "APPROVED");
    expect(await status(s.runId)).toBe("FULLY_APPROVED");
    // 5. The preparer submits in ADP and records it here (never automatic).
    await submitPayrollRun(s.daria, s.biz.id, s.runId, { note: "Submitted in ADP" });
    expect(await status(s.runId)).toBe("SUBMITTED");
  });

  it("Request Changes alerts the preparer with the client's note, and the run reads Changes Requested", async () => {
    const s = await setup();
    await requestPayrollApproval(s.daria, s.biz.id, s.runId, NOON);
    await decide(s, s.b, "DENIED", "Please fix Monday's hours");
    const t = await prisma.task.findFirstOrThrow({ where: { title: { contains: "Payroll changes requested by Blake" } } });
    expect(t).toMatchObject({ assigneeId: s.daria.id, priority: "HIGH" });
    expect(t.details).toMatch(/Monday's hours/);
    expect(await status(s.runId)).toBe("DENIED"); // shown as "Changes Requested"
  });

  it("a failed approval email: no text for that approver, the preparer is alerted, it reads Delivery Failed; staff can send it again", async () => {
    const s = await setup();
    failEmailTo.add(s.a.email);
    await requestPayrollApproval(s.daria, s.biz.id, s.runId, NOON);
    expect(sms.filter((m) => m.to === s.a.phoneNormalized)).toHaveLength(0);
    expect(await prisma.payrollNotice.findFirstOrThrow({ where: { portalUserId: s.a.id, channel: "EMAIL" } })).toMatchObject({ status: "FAILED" });
    expect(await prisma.payrollNotice.findFirstOrThrow({ where: { portalUserId: s.a.id, channel: "SMS" } })).toMatchObject({ status: "SKIPPED", detail: expect.stringMatching(/email wasn't accepted/) });
    expect(await prisma.task.findFirstOrThrow({ where: { title: { contains: "email not delivered to Avery" } } })).toMatchObject({ assigneeId: s.daria.id, priority: "HIGH" });
    expect(await approvalDelivery(await runOf(s))).toBe("FAILED");
    failEmailTo.clear();
    await requestPayrollApproval(s.daria, s.biz.id, s.runId, NOON);
    expect(await approvalDelivery(await runOf(s))).toBe("SENT");
  });

  it("when email is switched off on the server, nothing goes out and it reads Approval Prepared — Not Sent (never as sent); sending again later is a staff action", async () => {
    const s = await setup();
    delete process.env.NOTIFICATIONS_ENABLED;
    const { notices } = await requestPayrollApproval(s.daria, s.biz.id, s.runId, NOON);
    expect(mail.length + sms.length).toBe(0);
    expect(notices.some((n) => n.status === "SENT")).toBe(false);
    expect(await approvalDelivery(await runOf(s))).toBe("NOT_SENT");
    process.env.NOTIFICATIONS_ENABLED = "true";
    await dispatchHeldPayrollTexts(NOON); // the scheduled job releases nothing on its own
    expect(mail.length + sms.length).toBe(0);
    await requestPayrollApproval(s.daria, s.biz.id, s.runId, NOON);
    expect(mail.filter((m) => /approval needed/.test(m.subject))).toHaveLength(3);
  });

  it("no duplicates: once the email went out it can't be sent again while it's with the approvers; held texts go once", async () => {
    const s = await setup();
    await requestPayrollApproval(s.daria, s.biz.id, s.runId, NIGHT);
    expect(mail).toHaveLength(3); // emails go any time
    expect(sms).toHaveLength(0); // texts wait for 8 a.m.
    await expect(requestPayrollApproval(s.daria, s.biz.id, s.runId, NOON)).rejects.toThrow(/already with the approvers/);
    expect(await dispatchHeldPayrollTexts(NOON)).toBe(3);
    expect(await dispatchHeldPayrollTexts(NOON)).toBe(0);
    expect(sms).toHaveLength(3);
    expect(sms.every((m) => m.body === PAYROLL_SMS_NOTICE)).toBe(true);
    expect(mail).toHaveLength(3);
  });

  it("an approver decides once per round; a repeat is refused and recorded only once", async () => {
    const s = await setup();
    await requestPayrollApproval(s.daria, s.biz.id, s.runId, NOON);
    await decide(s, s.a, "APPROVED");
    await expect(decide(s, s.a, "APPROVED")).rejects.toThrow();
    expect(await prisma.payrollApproval.count({ where: { portalUserId: s.a.id } })).toBe(1);
  });

  it("the secure link shows only this payroll; it opens nothing else in the portal", async () => {
    const s = await setup();
    await requestPayrollApproval(s.daria, s.biz.id, s.runId, NOON);
    const view = await linkView(tokenFrom(mail.find((m) => m.to === s.a.email)!.text));
    expect(view.state).toBe("OK");
    const json = JSON.stringify(view);
    expect(json).not.toMatch(/"documents"|"invoices"|"messages"|"identity"/);
  });

  it("only authorized staff can send, and every request, notice and decision is in the audit trail", async () => {
    const s = await setup();
    await expect(requestPayrollApproval(s.sam, s.biz.id, s.runId, NOON)).rejects.toBeInstanceOf(ForbiddenError);
    expect(mail.length + sms.length).toBe(0);
    await requestPayrollApproval(s.daria, s.biz.id, s.runId, NOON);
    await decide(s, s.a, "APPROVED");
    expect(await prisma.auditLog.count({ where: { action: "payroll.approval_requested", entityId: s.runId } })).toBe(1);
    expect(await prisma.auditLog.count({ where: { action: "payroll.approved_by_owner" } })).toBe(1);
    expect(await prisma.payrollNotice.count({ where: { runId: s.runId } })).toBe(6);
  });
});
