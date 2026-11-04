import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { makeUser, managed, prisma, resetDb } from "./db";
import { ForbiddenError, type Actor } from "@/lib/auth/actor";
import { setStaffPermissions } from "@/lib/auth/permissions";
import { createClient } from "@/lib/services/clients";
import { saveProfile } from "@/lib/services/bookkeeping-clients";
import { setupLedger } from "@/lib/services/ledger";
import { normalizePhone } from "@/lib/normalize";
import { submitSmsConsent } from "@/lib/services/sms-consent";
import { setClientTexting } from "@/lib/services/staff-alerts";
import { handleInboundSms } from "@/lib/services/inbound-sms";
import { discardPayrollRun, editPayrollRun, importPayrollRegister, loadRun, postPayrollRun, savePayrollSetup } from "@/lib/services/payroll";
import {
  approverDashboard, approverRunView, decideByLink, decidePayroll, isPayrollApprover, LINK_TTL_MS, linkView, notifyApprovers, requestPayrollApproval,
  resolveLink, runTimeline, sendLinkCode, setNotifyChannel, setPayrollApprover, submitPayrollRun, verifyLink,
} from "@/lib/services/payroll-approval";

// Fictional business "Pretend Tailored Smoke LLC" with four fictional owners. Email (Resend) and
// texts (Twilio) are simulated: nothing leaves the test.
const NOON = new Date("2026-11-04T18:00:00Z"); // 12:00 Central — inside the texting window
const sms: { to: string; body: string }[] = [];
const mail: { to: string; subject: string; text: string }[] = [];
const ENV = { TWILIO_ACCOUNT_SID: "ACtest", TWILIO_AUTH_TOKEN: "t", TWILIO_MESSAGING_SERVICE_SID: "MGtest", RESEND_API_KEY: "re_test", EMAIL_FROM_ADDRESS: "office@example.com", RESEND_API_BASE: "https://resend.mock", NOTIFICATIONS_ENABLED: "true", APP_URL: "https://client.example.test" };

beforeEach(async () => {
  await resetDb();
  sms.length = 0;
  mail.length = 0;
  Object.assign(process.env, ENV);
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
    if (String(url).startsWith("https://api.twilio.com/")) {
      const p = new URLSearchParams(String(init.body));
      sms.push({ to: p.get("To")!, body: p.get("Body")! });
      return new Response(JSON.stringify({ sid: `SM${sms.length}` }), { status: 201 });
    }
    if (String(url).startsWith("https://resend.mock/")) {
      const b = JSON.parse(String(init.body));
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
    expect(task.title).toMatch(/Payroll denied by Avery Pretend/);
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
  it("default: email plus text (consent on file, texting on); text has no employee details", async () => {
    const s = await setup();
    await requestPayrollApproval(s.daria, s.biz.id, s.runId, NOON);
    expect(sms).toHaveLength(3);
    expect(mail).toHaveLength(3);
    expect(sms[0].body).toMatch(/^TTurner Client Connect: Payroll for Pretend Tailored Smoke LLC \(pay date Oct 16, total \$[\d,]+\.\d\d\) needs your approval\. Review and approve or deny: https:\/\/client\.example\.test\/payroll-approval\//);
    expect(sms[0].body).not.toMatch(/Rivera|Okafor|Lindqvist/);
  });

  it("each choice sends only to the chosen channel(s); staff can change it at the client's request (audited)", async () => {
    const s = await setup();
    await setNotifyChannel({ portalUserId: s.a.id }, s.biz.id, s.a.id, "EMAIL");
    await setNotifyChannel({ portalUserId: s.b.id }, s.biz.id, s.b.id, "SMS");
    await setNotifyChannel({ staff: s.daria }, s.biz.id, s.c.id, "BOTH");
    await requestPayrollApproval(s.daria, s.biz.id, s.runId, NOON);
    const to = (u: { phoneNormalized: string | null; email: string }) => ({ sms: sms.filter((m) => m.to === u.phoneNormalized).length, mail: mail.filter((m) => m.to === u.email).length });
    expect(to(s.a)).toEqual({ sms: 0, mail: 1 });
    expect(to(s.b)).toEqual({ sms: 1, mail: 0 });
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

  it("a text reply never approves; the approver gets a fresh secure link", async () => {
    const s = await setup();
    await requestPayrollApproval(s.daria, s.biz.id, s.runId, NOON);
    const r = await handleInboundSms({ MessageSid: "SMin2", From: s.a.phone!, Body: "APPROVE" });
    expect(r.reply).toMatch(/can't be approved by text reply.*payroll-approval\//);
    expect(await prisma.payrollApproval.count()).toBe(0);
    expect(await status(s.runId)).toBe("AWAITING_APPROVAL");
  });
});

describe("secure single-use links", () => {
  async function linkFor(s: Awaited<ReturnType<typeof setup>>, u: { phoneNormalized: string | null }) {
    return tokenFrom(sms.filter((m) => m.to === u.phoneNormalized).at(-1)!.body);
  }
  async function verifyByEmail(token: string, email: string) {
    await sendLinkCode(token);
    const code = mail.filter((m) => m.to === email).at(-1)!.subject.match(/^(\d{6})/)![1];
    return verifyLink(token, { code });
  }

  it("verification is required without a session; after the emailed code the decision is recorded with channel SMS", async () => {
    const s = await setup();
    await requestPayrollApproval(s.daria, s.biz.id, s.runId, NOON);
    const token = await linkFor(s, s.a);
    expect((await linkView(token)).state).toBe("OK");
    await expect(decideByLink(token, { decision: "APPROVED" })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(decideByLink(token, { decision: "APPROVED", nonce: "made-up" })).rejects.toBeInstanceOf(ForbiddenError);
    const { nonce } = await verifyByEmail(token, s.a.email);
    await decideByLink(token, { decision: "APPROVED", comment: "OK from my phone", nonce, ip: "198.51.100.7", userAgent: "iPhone test" });
    const a = await prisma.payrollApproval.findFirstOrThrow({ where: { portalUserId: s.a.id } });
    expect(a).toMatchObject({ channel: "SMS_LINK", verifiedBy: "EMAIL_CODE", ip: "198.51.100.7", userAgent: "iPhone test", comment: "OK from my phone", decision: "APPROVED" });
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
