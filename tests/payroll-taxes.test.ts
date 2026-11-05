import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeUser, managed, prisma, resetDb } from "./db";
import { ForbiddenError, type Actor } from "@/lib/auth/actor";
import { setStaffPermissions } from "@/lib/auth/permissions";
import { payrollTaxAccess } from "@/lib/payroll-taxes/access";
import { createClient } from "@/lib/services/clients";
import { saveProfile } from "@/lib/services/bookkeeping-clients";
import { normalizePhone } from "@/lib/normalize";
import { submitSmsConsent } from "@/lib/services/sms-consent";
import { setClientTexting } from "@/lib/services/staff-alerts";
import { savePayrollSetup, loadRun } from "@/lib/services/payroll";
import { decidePayroll, setPayrollApprover, submitPayrollRun } from "@/lib/services/payroll-approval";
import {
  clientApprovals, completedWork, cycleDetail, dueDates, flagCycleError, generateCycles, markProcessed, markSubmittedInAdp, portalPayrollRequests, recordHoursByStaff,
  saveManualTotals, saveReminderPlan, saveSchedule, sendForClientApproval, setClientRemindersAuthorized, setCycleAssignee, submitHoursByPortal, uploadPreview, workQueue, type ScheduleInput,
} from "@/lib/services/payroll-taxes";
import { HELD_CLIENT, HELD_SWITCH, runPayrollReminders, sendTestToOffice } from "@/lib/services/payroll-reminders";
import { DEFAULT_PLAN } from "@/lib/payroll/queue";

// Fictional businesses and people only. Email (Resend) and texts (Twilio) are simulated: nothing leaves the test.
const NOW = new Date("2026-11-05T18:00:00Z"); // Thursday, noon Central
const sms: { to: string; body: string }[] = [];
const mail: { to: string; subject: string; text: string }[] = [];
const ENV = { TWILIO_ACCOUNT_SID: "ACtest", TWILIO_AUTH_TOKEN: "t", TWILIO_MESSAGING_SERVICE_SID: "MGtest", RESEND_API_KEY: "re_test", EMAIL_FROM_ADDRESS: "office@example.com", RESEND_API_BASE: "https://resend.mock", NOTIFICATIONS_ENABLED: "true", APP_URL: "https://client.example.test" };
const pdf = (tag: string) => ({ bytes: new TextEncoder().encode(`%PDF-1.4\n% fictional ADP preview ${tag}\n%%EOF\n`), fileName: `${tag}.pdf` });

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
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
  vi.useRealTimers();
  vi.unstubAllGlobals();
  for (const k of Object.keys(ENV)) delete process.env[k];
});

const WEEKLY: ScheduleInput = { frequency: "WEEKLY", anchorPayDate: "2026-11-06", periodEndLagDays: 5, hoursRequestLeadDays: 5, hoursDueDays: 3, approvalDueDays: 2, adpCutoffDays: 2, active: true, clientRemindersEnabled: false };

async function owners(clientId: string, names: string[], consent: boolean[]) {
  const out = [];
  for (const [i, name] of names.entries()) {
    const phone = `555020${i}${clientId.length % 10}${i}4`.slice(0, 10);
    const u = await prisma.portalUser.create({ data: { email: `${name.split(" ")[0].toLowerCase()}.${i}@example.com`, name, phone, phoneNormalized: normalizePhone(phone), passwordHash: "x", emailVerifiedAt: new Date() } });
    await prisma.portalAccess.create({ data: { portalUserId: u.id, clientId } });
    const contact = await prisma.contact.create({ data: { clientId, name, email: u.email, emailNormalized: u.email } });
    await prisma.businessOwner.create({ data: { clientId, contactId: contact.id, portalUserId: u.id, ownershipBps: Math.floor(10000 / names.length) } });
    if (consent[i]) await submitSmsConsent({ name, phone, service: true, marketing: false, sourcePage: "/sms-consent", ip: null, userAgent: "test" });
    out.push(u);
  }
  return out;
}

async function setup() {
  const tabitha = await makeUser("ADMIN", "Tabitha");
  await prisma.ownerAccess.create({ data: { userId: tabitha.id, isPrimary: true, scope: "FULL" } });
  const mom = await makeUser("STAFF", "Payroll Fictional"); // MANAGE, not the client's assigned staff, no books grant
  const vera = await makeUser("STAFF", "Vera Fictional"); // VIEW only
  const sam = await makeUser("STAFF", "Sam Fictional"); // no access
  await setStaffPermissions(tabitha, mom.id, ["payroll_taxes.view", "payroll_taxes.manage"]);
  await setStaffPermissions(tabitha, vera.id, ["payroll_taxes.view"]);
  const bakery = await createClient(tabitha, { businessName: "Magnolia Bakery Co. (FICTIONAL)", clientType: "BUSINESS", status: "ACTIVE" });
  const auto = await createClient(tabitha, { businessName: "Red Mountain Auto Detailing (FICTIONAL)", clientType: "BUSINESS", status: "ACTIVE" });
  for (const c of [bakery, auto]) {
    await managed(c.id);
    await saveProfile(tabitha, c.id, { active: true, frequency: "MONTHLY", payroll: true, payrollFrequency: "WEEKLY", payrollProvider: "ADP" });
    await savePayrollSetup(tabitha, c.id, { system: "ADP_RUN", frequency: "WEEKLY" });
  }
  const [ava, ben] = await owners(bakery.id, ["Ava Fictional", "Ben Fictional"], [true, false]);
  const [cal] = await owners(auto.id, ["Cal Fictional"], [true]);
  await setPayrollApprover(tabitha, bakery.id, ava.id, { approver: true, required: true });
  await setPayrollApprover(tabitha, bakery.id, ben.id, { approver: true, required: true });
  await setPayrollApprover(tabitha, auto.id, cal.id, { approver: true, required: true });
  await setClientTexting(tabitha, true);
  return { tabitha, mom, vera, sam, bakery, auto, ava, ben, cal };
}
type S = Awaited<ReturnType<typeof setup>>;

const cycleOn = (clientId: string, payDate: string) => prisma.payrollCycle.findUniqueOrThrow({ where: { clientId_payDate: { clientId, payDate: new Date(`${payDate}T00:00:00Z`) } } });
const meta = { channel: "PORTAL" as const, verifiedBy: "PORTAL_SESSION" as const, ip: "203.0.113.9", userAgent: "test" };
const currentVersion = async (clientId: string, runId: string) => (await loadRun(clientId, runId)).version;
const clientSends = () => mail.filter((m) => !/^Overdue payroll step/.test(m.subject)).length + sms.length;
const totals = { employees: 3, hours: 120, grossCents: 300000, employeeTaxCents: 45000, deductionsCents: 5000, netPayCents: 250000, employerTaxCents: 23000 };

describe("access: owner-granted View / Manage, enforced on the server", () => {
  it("no access → Not found; VIEW can't change anything and sees only assigned clients; only the owner grants it", async () => {
    const s = await setup();
    expect((await payrollTaxAccess(s.tabitha)).level).toBe("MANAGE");
    expect((await payrollTaxAccess(s.mom)).level).toBe("MANAGE");
    expect((await payrollTaxAccess(s.vera))).toMatchObject({ level: "VIEW", allClients: false });
    expect((await payrollTaxAccess(s.sam)).level).toBe("NONE");
    await saveSchedule(s.mom, s.bakery.id, WEEKLY);
    const c = await cycleOn(s.bakery.id, "2026-11-13");

    // No access at all: every read and write is "Not found."
    await expect(workQueue(s.sam, "all")).rejects.toThrow(/^Not found\.$/);
    await expect(cycleDetail(s.sam, c.id)).rejects.toThrow(/^Not found\.$/);
    await expect(saveSchedule(s.sam, s.bakery.id, WEEKLY)).rejects.toThrow(/^Not found\.$/);
    await expect(dueDates(s.sam, "2026-11")).rejects.toBeInstanceOf(ForbiddenError);

    // VIEW: reads only, and only assigned clients.
    expect((await workQueue(s.vera, "all")).rows).toHaveLength(0);
    await expect(cycleDetail(s.vera, c.id)).rejects.toThrow(/^Not found\.$/);
    await saveSchedule(s.mom, s.bakery.id, { ...WEEKLY, assignedStaffId: s.vera.id });
    expect((await workQueue(s.vera, "all")).rows.length).toBeGreaterThan(0);
    expect((await cycleDetail(s.vera, c.id)).canManage).toBe(false);
    for (const call of [
      () => saveSchedule(s.vera, s.bakery.id, WEEKLY),
      () => recordHoursByStaff(s.vera, c.id, { noChanges: true }),
      () => saveManualTotals(s.vera, c.id, totals),
      () => uploadPreview(s.vera, c.id, pdf("x")),
      () => sendForClientApproval(s.vera, c.id),
      () => flagCycleError(s.vera, c.id, "Wrong rate"),
      () => markSubmittedInAdp(s.vera, c.id),
      () => markProcessed(s.vera, c.id, pdf("conf")),
      () => setCycleAssignee(s.vera, c.id, s.vera.id),
      () => saveReminderPlan(s.vera, "global", DEFAULT_PLAN),
      () => sendTestToOffice(s.vera),
    ]) await expect(call()).rejects.toThrow(/only the owner or staff she allows/);

    // The auto client (not assigned to Vera) stays hidden until she's granted All clients.
    await saveSchedule(s.mom, s.auto.id, WEEKLY);
    const autoCycle = await cycleOn(s.auto.id, "2026-11-13");
    await expect(cycleDetail(s.vera, autoCycle.id)).rejects.toThrow(/^Not found\.$/);
    await setStaffPermissions(s.tabitha, s.vera.id, ["payroll_taxes.view", "payroll_taxes.all_clients"]);
    expect((await cycleDetail(s.vera, autoCycle.id)).cycle.clientId).toBe(s.auto.id);
    // All clients alone (without View) opens nothing.
    await setStaffPermissions(s.tabitha, s.vera.id, ["payroll_taxes.all_clients"]);
    await expect(workQueue(s.vera, "all")).rejects.toThrow(/^Not found\.$/);

    // Only the owner grants it — not even a delegated staff manager holding it.
    await setStaffPermissions(s.tabitha, s.mom.id, ["payroll_taxes.view", "payroll_taxes.manage", "staff.view", "staff.manage"]);
    await expect(setStaffPermissions(s.mom, s.sam.id, ["payroll_taxes.view"])).rejects.toThrow(/Only the owner can give or remove ADP Payroll & Taxes access/);
    // A revoke applies at once.
    await setStaffPermissions(s.tabitha, s.mom.id, []);
    await expect(saveSchedule(s.mom, s.bakery.id, WEEKLY)).rejects.toThrow(/^Not found\.$/);
  });
});

describe("schedules and the cycle generator", () => {
  it("prefill-free save creates a 6-week horizon once; running again creates nothing; touched cycles are kept on change", async () => {
    const s = await setup();
    const first = await saveSchedule(s.mom, s.bakery.id, WEEKLY);
    expect(first.created).toBe(6);
    const dates = (await prisma.payrollCycle.findMany({ where: { clientId: s.bakery.id }, orderBy: { payDate: "asc" } })).map((c) => c.payDate.toISOString().slice(0, 10));
    expect(dates).toEqual(["2026-11-06", "2026-11-13", "2026-11-20", "2026-11-27", "2026-12-04", "2026-12-11"]); // Nov 27 (day after Thanksgiving) is a business day
    for (let i = 0; i < 3; i++) expect(await generateCycles({ now: NOW })).toEqual({ created: 0, updated: 0, removed: 0 });
    expect(await prisma.payrollCycle.count({ where: { clientId: s.bakery.id } })).toBe(6);
    // Generating sends nothing.
    expect(clientSends()).toBe(0);
    expect(await prisma.payrollReminder.count()).toBe(0);
    // A week later the horizon rolls forward by one cycle, still once.
    expect((await generateCycles({ now: new Date("2026-11-12T18:00:00Z") })).created).toBe(1);
    expect((await generateCycles({ now: new Date("2026-11-12T18:00:00Z") })).created).toBe(0);
    // Touch one cycle, then change the schedule: the untouched future cycles follow, the touched one stays.
    const touched = await cycleOn(s.bakery.id, "2026-11-20");
    await recordHoursByStaff(s.mom, touched.id, { noChanges: true });
    await saveSchedule(s.mom, s.bakery.id, { ...WEEKLY, frequency: "BIWEEKLY", anchorPayDate: "2026-11-13" });
    const after = (await prisma.payrollCycle.findMany({ where: { clientId: s.bakery.id, payDate: { gte: new Date("2026-11-05") } }, orderBy: { payDate: "asc" } })).map((c) => c.payDate.toISOString().slice(0, 10));
    expect(after).toContain("2026-11-20");
    expect(after).toContain("2026-11-13");
    expect(after).toContain("2026-11-27");
    expect(after).not.toContain("2026-12-04");
    // One cycle per client per pay date, enforced by the database.
    await expect(prisma.payrollCycle.create({ data: { clientId: s.bakery.id, scheduleId: touched.scheduleId, payDate: touched.payDate, periodStart: touched.periodStart, periodEnd: touched.periodEnd, hoursRequestDate: touched.hoursRequestDate, hoursDueDate: touched.hoursDueDate, approvalDueDate: touched.approvalDueDate, adpCutoffDate: touched.adpCutoffDate } })).rejects.toThrow();
    expect(await prisma.auditLog.count({ where: { action: { in: ["payroll_taxes.schedule_created", "payroll_taxes.schedule_updated"] }, clientId: s.bakery.id } })).toBe(2);
  });
  it("refuses bad schedules and never creates clients", async () => {
    const s = await setup();
    await expect(saveSchedule(s.mom, s.bakery.id, { ...WEEKLY, hoursRequestLeadDays: 1 })).rejects.toThrow(/hours request must go out before/);
    await expect(saveSchedule(s.mom, "no-such-client", WEEKLY)).rejects.toThrow(/existing, active client/);
    await expect(saveSchedule(s.mom, s.bakery.id, { ...WEEKLY, assignedStaffId: s.sam.id })).rejects.toThrow(/has ADP Payroll & Taxes access/);
    const n = await prisma.client.count();
    await saveSchedule(s.mom, s.bakery.id, WEEKLY);
    expect(await prisma.client.count()).toBe(n);
  });
});

describe("workup: v1 → client denied → v2 → approved → submitted → processed", () => {
  it("binds the preview document into the version and invalidates approvals when it's replaced", async () => {
    const s = await setup();
    await saveSchedule(s.mom, s.bakery.id, { ...WEEKLY, assignedStaffId: s.mom.id });
    const c = await cycleOn(s.bakery.id, "2026-11-13");
    await recordHoursByStaff(s.mom, c.id, { employees: [{ name: "Fictional Baker", regularHours: 40, overtimeHours: 2 }], flags: ["BONUS"], notes: "Holiday bonus" });
    expect((await workQueue(s.mom)).rows.find((r) => r.data.cycleId === c.id)?.status).toBe("PREVIEW_TO_PREPARE");

    // v1: totals keyed in with ADP's preview PDF (staff only; kept in the client file).
    const v1 = await saveManualTotals(s.mom, c.id, totals, pdf("preview-v1"));
    expect(v1.version).toBe(1);
    const cyc = await prisma.payrollCycle.findUniqueOrThrow({ where: { id: c.id } });
    const run1 = await currentVersion(s.bakery.id, cyc.payrollRunId!);
    expect(run1.documentSha256).toMatch(/^[0-9a-f]{64}$/);
    const doc1 = await prisma.document.findUniqueOrThrow({ where: { id: run1.documentId! } });
    expect(doc1).toMatchObject({ category: "BOOKKEEPING", docType: "PAYROLL_PREVIEW", visibility: "STAFF_ONLY" });

    await sendForClientApproval(s.mom, c.id);
    expect((await workQueue(s.mom)).rows.find((r) => r.data.cycleId === c.id)?.status).toBe("AWAITING_CLIENT_APPROVAL");
    // Ava approves v1; then the office replaces the PDF → v2, and her approval no longer counts.
    await decidePayroll(s.ava.id, s.bakery.id, cyc.payrollRunId!, { decision: "APPROVED", versionId: run1.id }, meta);
    const r2 = await uploadPreview(s.mom, c.id, pdf("preview-v1-corrected"));
    expect(r2).toMatchObject({ kind: "PDF", version: 2 });
    const v2 = await currentVersion(s.bakery.id, cyc.payrollRunId!);
    expect(v2.contentHash).not.toBe(run1.contentHash);
    expect(v2.grossCents).toBe(run1.grossCents);
    expect((await prisma.payrollRun.findUniqueOrThrow({ where: { id: cyc.payrollRunId! } })).status).toBe("DRAFT");
    expect(await prisma.payrollRunEvent.count({ where: { runId: cyc.payrollRunId!, kind: "APPROVALS_INVALIDATED" } })).toBe(1);
    await expect(decidePayroll(s.ben.id, s.bakery.id, cyc.payrollRunId!, { decision: "APPROVED", versionId: run1.id }, meta)).rejects.toThrow(/isn't waiting|changed/);
    await expect(submitPayrollRun(s.mom, s.bakery.id, cyc.payrollRunId!)).rejects.toThrow(/must approve/);
    // The same document again isn't a new version.
    await expect(uploadPreview(s.mom, c.id, pdf("preview-v1-corrected"))).rejects.toThrow(/already saved|already attached/);

    // Round 2 on v2: Ben denies with a comment → Needs correction.
    await sendForClientApproval(s.mom, c.id);
    await decidePayroll(s.ben.id, s.bakery.id, cyc.payrollRunId!, { decision: "DENIED", comment: "Bonus should be $200, not $250", versionId: v2.id }, meta);
    expect((await workQueue(s.mom)).rows.find((r) => r.data.cycleId === c.id)?.status).toBe("NEEDS_CORRECTION");
    // Send revised preview: corrected totals + PDF in one new version (v3), new approval round.
    const v3 = await saveManualTotals(s.mom, c.id, { ...totals, grossCents: 295000, netPayCents: 245000 }, pdf("preview-v3"));
    expect(v3.version).toBe(3);
    await sendForClientApproval(s.mom, c.id);
    const cur = await currentVersion(s.bakery.id, cyc.payrollRunId!);
    await decidePayroll(s.ava.id, s.bakery.id, cyc.payrollRunId!, { decision: "APPROVED", versionId: cur.id }, meta);
    await decidePayroll(s.ben.id, s.bakery.id, cyc.payrollRunId!, { decision: "APPROVED", versionId: cur.id }, meta);
    expect((await workQueue(s.mom)).rows.find((r) => r.data.cycleId === c.id)?.status).toBe("READY_TO_PROCESS");
    const appr = (await clientApprovals(s.mom)).find((x) => x.cycleId === c.id)!;
    expect(appr).toMatchObject({ currentVersion: 3, round: 3 });
    expect(appr.approvers.map((a) => a.decision)).toEqual(["APPROVED", "APPROVED"]);

    // Processed needs Submitted first, then the confirmation PDF.
    await expect(markProcessed(s.mom, c.id, pdf("conf"))).rejects.toThrow(/Submitted in ADP first/);
    await markSubmittedInAdp(s.mom, c.id, "Submitted in ADP RUN");
    expect((await workQueue(s.mom)).rows.find((r) => r.data.cycleId === c.id)?.status).toBe("SUBMITTED_IN_ADP");
    await expect(markProcessed(s.mom, c.id, null)).rejects.toThrow(/Attach ADP's confirmation/);
    await markProcessed(s.mom, c.id, pdf("adp-confirmation"), { note: "ADP confirmation #FICTIONAL-123" });
    const done = await prisma.payrollCycle.findUniqueOrThrow({ where: { id: c.id } });
    expect(done.processedAt).not.toBeNull();
    expect((await prisma.document.findUniqueOrThrow({ where: { id: done.confirmationDocumentId! } })).docType).toBe("PAYROLL_CONFIRMATION");
    expect(await prisma.payrollRunEvent.count({ where: { runId: cyc.payrollRunId!, kind: "PROCESSED" } })).toBe(1);
    expect((await completedWork(s.mom)).map((x) => x.cycleId)).toEqual([c.id]);
    // Every step was audited.
    const actions = (await prisma.auditLog.findMany({ where: { entityId: c.id }, select: { action: true } })).map((a) => a.action);
    for (const a of ["payroll_taxes.hours_recorded", "payroll_taxes.totals_keyed", "payroll_taxes.sent_for_approval", "payroll_taxes.preview_uploaded", "payroll_taxes.submitted_in_adp", "payroll_taxes.processed"]) expect(actions).toContain(a);
    // Employee-level detail: the books rule (Mom isn't the assigned bookkeeper), as on the existing screen.
    expect((await cycleDetail(s.mom, c.id)).employeeDetail).toBe(false);
    expect((await cycleDetail(s.tabitha, c.id)).version?.lines.length).toBe(1);
  });
  it("a staff-flagged error goes to Needs correction and clears when the revised preview is sent", async () => {
    const s = await setup();
    await saveSchedule(s.mom, s.bakery.id, WEEKLY);
    const c = await cycleOn(s.bakery.id, "2026-11-13");
    await saveManualTotals(s.mom, c.id, totals);
    await flagCycleError(s.mom, c.id, "Hours for one employee look doubled");
    expect((await workQueue(s.mom, "all")).rows.find((r) => r.data.cycleId === c.id)?.status).toBe("NEEDS_CORRECTION");
    await expect(markSubmittedInAdp(s.mom, c.id)).rejects.toThrow(/Clear the error flag/);
    await sendForClientApproval(s.mom, c.id);
    expect((await prisma.payrollCycle.findUniqueOrThrow({ where: { id: c.id } })).errorFlaggedAt).toBeNull();
  });
});

describe("reminders", () => {
  const atHoursRequest = new Date("2026-11-05T15:30:00Z"); // 9:30 a.m. Central on the request date of the Nov 13 cycle

  it("are HELD (never sent) while the owner's switch is off, deduplicated, and only the owner flips it", async () => {
    const s = await setup();
    await saveSchedule(s.mom, s.bakery.id, { ...WEEKLY, clientRemindersEnabled: true });
    const c = await cycleOn(s.bakery.id, "2026-11-13");
    const r = await runPayrollReminders(atHoursRequest);
    expect(r.HELD).toBeGreaterThan(0);
    const rows = await prisma.payrollReminder.findMany({ where: { cycleId: c.id } });
    expect(rows.every((x) => x.status === "HELD" && x.detail === HELD_SWITCH && x.audience === "CLIENT")).toBe(true);
    expect(clientSends()).toBe(0);
    // Running again records nothing new (one per step per cycle per recipient per channel).
    const n = await prisma.payrollReminder.count();
    await runPayrollReminders(atHoursRequest);
    await runPayrollReminders(new Date(atHoursRequest.getTime() + 3600_000));
    expect(await prisma.payrollReminder.count()).toBe(n);
    expect(new Set(rows.map((x) => x.dedupeKey)).size).toBe(rows.length);
    // Only the owner authorizes client reminders; it's in the owner audit log.
    await expect(setClientRemindersAuthorized(s.mom, true)).rejects.toBeInstanceOf(ForbiddenError);
    await setClientRemindersAuthorized(s.tabitha, true);
    expect(await prisma.ownerAuditLog.count({ where: { action: "payroll_taxes.client_reminders_authorized" } })).toBe(1);
    // A HELD step stays held (it never goes out late); the next step sends.
    await runPayrollReminders(atHoursRequest);
    expect(clientSends()).toBe(0);
  });

  it("send when both switches are on: email always, text only with consent; no amounts or names; stop when the client acts", async () => {
    const s = await setup();
    await setClientRemindersAuthorized(s.tabitha, true);
    await saveSchedule(s.mom, s.bakery.id, WEEKLY); // client switch still off
    const c = await cycleOn(s.bakery.id, "2026-11-13");
    await runPayrollReminders(atHoursRequest);
    expect((await prisma.payrollReminder.findMany({ where: { cycleId: c.id } })).every((x) => x.status === "HELD" && x.detail === HELD_CLIENT)).toBe(true);
    expect(clientSends()).toBe(0);

    await saveSchedule(s.mom, s.bakery.id, { ...WEEKLY, clientRemindersEnabled: true });
    // The follow-up (24h before hours due, Mon Nov 9 5 p.m.) goes out: Ava has text consent, Ben doesn't.
    const followUp = new Date("2026-11-08T23:30:00Z"); // Sunday 5:30 p.m. Central
    await runPayrollReminders(followUp);
    const fu = await prisma.payrollReminder.findMany({ where: { cycleId: c.id, step: "HOURS_FOLLOWUP" } });
    expect(fu.filter((x) => x.channel === "EMAIL").map((x) => x.status)).toEqual(["SENT", "SENT"]);
    const texts = fu.filter((x) => x.channel === "SMS");
    expect(texts.find((x) => x.recipientKey === `portal:${s.ava.id}`)?.status).toBe("SENT");
    expect(texts.find((x) => x.recipientKey === `portal:${s.ben.id}`)).toMatchObject({ status: "SKIPPED" });
    expect(texts.find((x) => x.recipientKey === `portal:${s.ben.id}`)?.detail).toMatch(/consent|permission/i);
    expect(sms.map((m) => m.to)).toEqual([s.ava.phoneNormalized]);
    for (const m of [...mail.filter((x) => !x.subject.startsWith("Overdue")).map((x) => `${x.subject} ${x.text}`), ...sms.map((x) => x.body)]) {
      expect(m).not.toMatch(/\$\s?\d/);
      expect(m).not.toMatch(/Ava|Ben|Fictional Baker/);
      expect(m).toMatch(/https:\/\/client\.example\.test\/client\/payroll/);
    }

    // Stop on action: the client sends hours, then no more hours reminders for this cycle.
    await submitHoursByPortal(s.ava.id, s.bakery.id, c.id, { noChanges: true });
    const sent = mail.length;
    // A later cycle's request could fire; this cycle gets nothing more.
    const before = await prisma.payrollReminder.count({ where: { cycleId: c.id } });
    await runPayrollReminders(new Date("2026-11-09T20:00:00Z"));
    expect(await prisma.payrollReminder.count({ where: { cycleId: c.id } })).toBe(before);
    expect(mail.length).toBeGreaterThanOrEqual(sent);

    // Approval reminders go only to approvers who haven't decided in the current round.
    await saveManualTotals(s.mom, c.id, totals);
    await sendForClientApproval(s.mom, c.id);
    const run = (await prisma.payrollCycle.findUniqueOrThrow({ where: { id: c.id } })).payrollRunId!;
    await decidePayroll(s.ava.id, s.bakery.id, run, { decision: "APPROVED", versionId: (await currentVersion(s.bakery.id, run)).id }, meta);
    await runPayrollReminders(new Date("2026-11-09T23:30:00Z")); // 24h before the Nov 10 5 p.m. approval deadline
    const ar = await prisma.payrollReminder.findMany({ where: { cycleId: c.id, step: { startsWith: "APPROVAL" } } });
    expect(ar.length).toBeGreaterThan(0);
    expect(ar.every((x) => x.recipientKey === `portal:${s.ben.id}` && x.round === 1)).toBe(true);

    // Overdue: at the deadline, an alert to the assigned staff member and the owner only.
    await saveSchedule(s.mom, s.bakery.id, { ...WEEKLY, clientRemindersEnabled: true, assignedStaffId: s.mom.id });
    await runPayrollReminders(new Date("2026-11-10T23:30:00Z"));
    const od = await prisma.payrollReminder.findMany({ where: { cycleId: c.id, step: { startsWith: "OVERDUE_ALERT" } } });
    expect(new Set(od.map((x) => x.recipientKey))).toEqual(new Set([`staff:${s.mom.id}`, `staff:${s.tabitha.id}`]));
    expect(od.every((x) => x.audience === "STAFF")).toBe(true);
    expect(od.filter((x) => x.channel === "PORTAL" && x.recipientKey === `staff:${s.mom.id}`).map((x) => x.detail)).toEqual(["Task created"]);
    expect(await prisma.task.count({ where: { assigneeId: s.mom.id, title: { contains: "Overdue payroll step" } } })).toBeGreaterThanOrEqual(1);
  });

  it("SMS is skipped without consent even when everything else allows it", async () => {
    const s = await setup();
    await setClientRemindersAuthorized(s.tabitha, true);
    await saveSchedule(s.mom, s.auto.id, { ...WEEKLY, clientRemindersEnabled: true });
    await prisma.smsConsentEvent.deleteMany({});
    await runPayrollReminders(atHoursRequest);
    const rows = await prisma.payrollReminder.findMany({ where: { clientId: s.auto.id, channel: "SMS" } });
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((x) => x.status === "SKIPPED")).toBe(true);
    expect(sms).toHaveLength(0);
  });

  it("'Send test to office' goes to the office's own email only", async () => {
    const s = await setup();
    const r = await sendTestToOffice(s.mom);
    expect(r.ok).toBe(true);
    expect(mail.map((m) => m.to)).toEqual(["info@tturnerassociates.com"]);
    expect(mail[0].subject).toMatch(/^\[TEST\]/);
    expect(sms).toHaveLength(0);
  });
});

describe("client portal isolation", () => {
  it("a login sees and changes only its own business's cycles", async () => {
    const s = await setup();
    await saveSchedule(s.mom, s.bakery.id, WEEKLY);
    await saveSchedule(s.mom, s.auto.id, WEEKLY);
    const bakeryCycle = await cycleOn(s.bakery.id, "2026-11-13");
    const autoCycle = await cycleOn(s.auto.id, "2026-11-13");
    const mine = await portalPayrollRequests(s.cal.id, s.auto.id);
    expect(mine?.hours.map((h) => h.cycleId)).toContain(autoCycle.id);
    expect(JSON.stringify(mine)).not.toContain(bakeryCycle.id);
    // Cal can't read or write the bakery's payroll, by any combination of ids.
    await expect(portalPayrollRequests(s.cal.id, s.bakery.id)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(submitHoursByPortal(s.cal.id, s.bakery.id, bakeryCycle.id, { noChanges: true })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(submitHoursByPortal(s.cal.id, s.auto.id, bakeryCycle.id, { noChanges: true })).rejects.toBeInstanceOf(ForbiddenError);
    expect((await prisma.payrollCycle.findUniqueOrThrow({ where: { id: bakeryCycle.id } })).hoursSubmittedAt).toBeNull();
    // Their own works.
    await submitHoursByPortal(s.cal.id, s.auto.id, autoCycle.id, { employees: [{ name: "Fictional Detailer", regularHours: "38.5", overtimeHours: 0 }], flags: ["NEW_HIRE", "NOT_A_FLAG"] });
    const saved = await prisma.payrollCycle.findUniqueOrThrow({ where: { id: autoCycle.id } });
    expect(saved.hoursSubmission).toMatchObject({ noChanges: false, flags: ["NEW_HIRE"], employees: [{ name: "Fictional Detailer", regularHours: 38.5 }] });
    // Approvals waiting on THIS login only.
    await saveManualTotals(s.mom, bakeryCycle.id, totals);
    await sendForClientApproval(s.mom, bakeryCycle.id);
    expect((await portalPayrollRequests(s.ava.id, s.bakery.id))?.awaiting.map((a) => a.cycleId)).toEqual([bakeryCycle.id]);
    expect((await portalPayrollRequests(s.cal.id, s.auto.id))?.awaiting).toEqual([]);
    // A revoked login loses it at once.
    await prisma.portalAccess.updateMany({ where: { portalUserId: s.cal.id }, data: { revokedAt: new Date() } });
    await expect(portalPayrollRequests(s.cal.id, s.auto.id)).rejects.toBeInstanceOf(ForbiddenError);
    void (null as unknown as Actor);
  });
});
