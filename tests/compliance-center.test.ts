import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { grantPerms, prisma, resetDb } from "./db";
import { ForbiddenError, type Actor } from "@/lib/auth/actor";
import { ValidationError } from "@/lib/services/clients";
import type { PortalActor } from "@/lib/portal/session";
import { hashPassword } from "@/lib/auth/password";
import { claimOwnerOffice } from "@/lib/auth/owner";
import { setTaskDone } from "@/lib/services/tasks";
import { evaluateRule, type EntityFacts } from "@/lib/compliance/evaluate";
import { RULES } from "@/lib/compliance/rules-data";
import { adjustDue, alabamaHolidays, dueDatesFor, periodContaining, periodsToCreate } from "@/lib/compliance/dates";
import { complianceAccess } from "@/lib/services/compliance/access";
import { addLocation, createEntity, revealEntityEin, saveFilingAccount, saveTaxAccount, setEntityEin, updateEntity, entityFacts, createEntityFromClient } from "@/lib/services/compliance/entities";
import { activateObligation, addCustomObligation, editObligation, generateObligations, listObligations, setObligationStatus } from "@/lib/services/compliance/obligations";
import { clientDecide, createReturnVersion, currentApproval, recordAccepted, recordNotRequired, recordPayment, recordSubmitted, sendForApproval, setAmountDue, setFilingChannel, uploadComplianceDocument } from "@/lib/services/compliance/periods";
import { runComplianceReminders } from "@/lib/services/compliance/reminders";
import { setComplianceSwitch } from "@/lib/services/compliance/settings";
import { editRule, ensureRulesLoaded, rulesLibrary } from "@/lib/services/compliance/rules";
import { missingInfoCsv, missingInfoReport, portalCompliance, portalComplianceDocument, taxDueBoard } from "@/lib/services/compliance/views";
import { applyProposedProfile, PROPOSALS } from "@/lib/services/compliance/proposal";

/** Fictional office and clients only. No network. */
const PASSWORD = "Owner-Strong-Pass-1";
const PDF = (tag: string) => new TextEncoder().encode(`%PDF-1.4\n% ${tag}\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF`);

beforeEach(async () => {
  await resetDb();
  vi.stubEnv("NOTIFICATIONS_ENABLED", "false");
  vi.stubGlobal("fetch", async (url: string | URL) => {
    throw new Error(`Unexpected network call in a test: ${String(url)}`);
  });
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

async function staff(email: string, name: string, role: "ADMIN" | "STAFF"): Promise<Actor> {
  const u = await prisma.user.create({ data: { email, name, role, passwordHash: await hashPassword(PASSWORD), mfaEnabledAt: new Date() } });
  return { id: u.id, role: u.role, name: u.name, email: u.email };
}
async function office() {
  const tab = await staff("tabitha@tturnerassociates.com", "Tabitha Turner", "ADMIN");
  const daria = await staff("daria.fictional@example.com", "Daria Fictional", "STAFF");
  const viewer = await staff("vic.fictional@example.com", "Vic Viewer", "STAFF");
  const none = await staff("nora.fictional@example.com", "Nora None", "ADMIN");
  await claimOwnerOffice(tab, PASSWORD);
  await grantPerms(daria.id, ["compliance.view", "compliance.manage"]);
  await grantPerms(viewer.id, ["compliance.view"]);
  return { tab, daria, viewer, none };
}
async function portalLogin(clientId: string, email: string, name = "Pat Client"): Promise<PortalActor> {
  const u = await prisma.portalUser.create({ data: { email, name, passwordHash: "x" } });
  await prisma.portalAccess.create({ data: { portalUserId: u.id, clientId } });
  return { id: u.id, name: u.name, email: u.email };
}
async function client(name: string) {
  const c = await prisma.client.create({ data: { displayName: name, businessName: name, clientType: "BUSINESS" } });
  return c;
}

const baseFacts = (o: Partial<EntityFacts> = {}): EntityFacts => ({ kind: "LLC", taxClassification: "S_CORP", sCorpEffectiveDate: "2025-01-01", fiscalYearEndMonth: 12, stateOfFormation: "AL", states: ["AL"], counties: ["Jefferson"], cities: ["Birmingham"], hasLocation: true, activityTags: ["restaurant"], payrollStatus: "YES", issues1099: "YES", irsExemptionStatus: null, nonprofitForm: null, registrations: [], ...o });
const rule = (k: string) => RULES.find((r) => r.ruleKey === k)!;

describe("rule evaluation", () => {
  it("applies, doesn't apply, or needs verification", () => {
    expect(evaluateRule(rule("FED_1120S"), baseFacts()).result).toBe("APPLIES");
    expect(evaluateRule(rule("FED_1120S"), baseFacts({ taxClassification: "C_CORP" })).result).toBe("DOES_NOT_APPLY");
    const nv = evaluateRule(rule("FED_1120S"), baseFacts({ fiscalYearEndMonth: null, sCorpEffectiveDate: null }));
    expect(nv.result).toBe("NEEDS_VERIFICATION");
    expect(nv.missing).toEqual(expect.arrayContaining(["Fiscal year-end not recorded", "S corporation election effective date not recorded"]));
    expect(evaluateRule(rule("FED_941"), baseFacts({ payrollStatus: "NO" })).result).toBe("DOES_NOT_APPLY");
    expect(evaluateRule(rule("FED_941"), baseFacts({ payrollStatus: "UNKNOWN" })).result).toBe("NEEDS_VERIFICATION");
    expect(evaluateRule(rule("HSV_SALES_USE"), baseFacts()).result).toBe("DOES_NOT_APPLY");
    // Alcohol: unknown → verify; recorded "no-alcohol" → none.
    expect(evaluateRule(rule("BHM_BEVERAGE"), baseFacts()).missing).toContain("Whether the business sells alcohol is not recorded");
    expect(evaluateRule(rule("BHM_BEVERAGE"), baseFacts({ activityTags: ["restaurant", "no-alcohol"] })).result).toBe("DOES_NOT_APPLY");
    // Sales tax: frequency from the account; missing account → verify with assumed frequency.
    const noAcct = evaluateRule(rule("AL_SALES_2100"), baseFacts());
    expect(noAcct.result).toBe("NEEDS_VERIFICATION");
    expect(noAcct.missing).toEqual(expect.arrayContaining(["Alabama sales tax account (ALDOR) not recorded", "Alabama filing frequency not recorded (assumed monthly)"]));
    const withAcct = evaluateRule(rule("AL_SALES_2100"), baseFacts({ registrations: [{ type: "SALES_USE", jurisdictionName: "Alabama", agency: "ALDOR", status: "ACTIVE", filingFrequency: "QUARTERLY", accountLast4: "1234" }] }));
    expect(withAcct).toMatchObject({ result: "APPLIES", frequency: "QUARTERLY" });
    expect(evaluateRule(rule("AL_SALES_2100"), baseFacts({ registrations: [{ type: "SALES_USE", jurisdictionName: "Alabama", agency: "ALDOR", status: "CLOSED", filingFrequency: "MONTHLY", accountLast4: "1" }] })).result).toBe("DOES_NOT_APPLY");
    // A-6 vs A-1 by the account's frequency.
    const q = baseFacts({ registrations: [{ type: "WITHHOLDING", jurisdictionName: "Alabama", agency: "ALDOR", status: "ACTIVE", filingFrequency: "QUARTERLY", accountLast4: "9" }] });
    expect(evaluateRule(rule("AL_WH_A6"), q).result).toBe("DOES_NOT_APPLY");
    expect(evaluateRule(rule("AL_WH_A1"), q).result).toBe("APPLIES");
    // Nonprofits never get business income tax rules; 990 determination pending gross receipts.
    const np = baseFacts({ kind: "NONPROFIT", taxClassification: "EXEMPT_ORG" });
    expect(evaluateRule(rule("FED_1120S"), np).result).toBe("DOES_NOT_APPLY");
    expect(evaluateRule(rule("FED_990"), np).missing[0]).toMatch(/not determined/);
    expect(evaluateRule(rule("FED_990N"), np).result).toBe("DOES_NOT_APPLY");
    expect(evaluateRule(rule("FED_990N"), { ...np, nonprofitForm: "990-N" }).result).toBe("APPLIES");
    expect(evaluateRule(rule("FED_7004"), baseFacts()).result).toBe("DOES_NOT_APPLY");
  });

  it("ships every rule with a candidate source, and none VERIFIED without an opened source", () => {
    expect(RULES.length).toBeGreaterThanOrEqual(35);
    for (const r of RULES) {
      expect(r.sourceUrls.length).toBeGreaterThan(0);
      expect(r.verificationStatus).toBe("NEEDS_VERIFICATION");
      expect(() => dueDatesFor(r.dueRuleCode, r.weekendRule, periodContaining("MONTHLY", "2026-03-10"))).not.toThrow();
    }
  });
});

describe("due-date computation", () => {
  it("monthly: computed from each actual period, with weekend and Alabama holiday adjustment", () => {
    // Sales tax, 20th of the following month.
    const feb = dueDatesFor("DOM:20:1", "NEXT_BUSINESS_DAY_ALABAMA", periodContaining("MONTHLY", "2026-02-11"));
    expect(feb.statutory).toBe("2026-03-20"); // Friday
    expect(feb.adjusted).toBe("2026-03-20");
    const may = dueDatesFor("DOM:20:1", "NEXT_BUSINESS_DAY_ALABAMA", periodContaining("MONTHLY", "2026-05-02"));
    expect(may.statutory).toBe("2026-06-20"); // Saturday
    expect(may.adjusted).toBe("2026-06-22");
    // A-6: 15th of the following month — not the same day as sales tax.
    expect(dueDatesFor("DOM:15:1", "NEXT_BUSINESS_DAY_ALABAMA", periodContaining("MONTHLY", "2026-05-02")).adjusted).toBe("2026-06-15");
    // Jefferson Davis's birthday (1st Monday of June 2026 = June 1) is an Alabama holiday.
    expect(alabamaHolidays(2026).has("2026-06-01")).toBe(true);
    expect(adjustDue("2026-06-01", "NEXT_BUSINESS_DAY_ALABAMA")).toBe("2026-06-02");
    expect(adjustDue("2026-06-01", "NEXT_BUSINESS_DAY_FEDERAL")).toBe("2026-06-01");
    // Prep deadline defaults to 10 days before the adjusted date.
    expect(may.prep).toBe("2026-06-12");
  });

  it("quarterly and annual, including fiscal-year variants and federal holidays", () => {
    const q3 = dueDatesFor("EOM:1", "NEXT_BUSINESS_DAY_FEDERAL", periodContaining("QUARTERLY", "2026-08-01"));
    expect(q3).toMatchObject({ statutory: "2026-10-31", adjusted: "2026-11-02" }); // Saturday → Monday
    const q4 = dueDatesFor("EOM:1", "NEXT_BUSINESS_DAY_FEDERAL", periodContaining("QUARTERLY", "2026-12-01"));
    expect(q4.adjusted).toBe("2027-02-01"); // Jan 31, 2027 is a Sunday
    // 1120-S calendar year 2026 → March 15, 2027 (Monday).
    const ty = periodContaining("ANNUAL", "2026-06-30", 12);
    expect(ty).toMatchObject({ key: "TY2026", start: "2026-01-01", end: "2026-12-31" });
    expect(dueDatesFor("DOM:15:3", "NEXT_BUSINESS_DAY_FEDERAL", ty).adjusted).toBe("2027-03-15");
    // Fiscal year ending June 30, 2026 → 15th of the 3rd month after = Sep 15, 2026.
    const fy = periodContaining("ANNUAL", "2026-02-01", 6);
    expect(fy).toMatchObject({ key: "FY2026-06", start: "2025-07-01", end: "2026-06-30" });
    expect(dueDatesFor("DOM:15:3", "NEXT_BUSINESS_DAY_FEDERAL", fy).adjusted).toBe("2026-09-15");
    // 990: 15th of the 5th month; a March FYE → Aug 15, 2026 (Saturday) → Aug 17.
    expect(dueDatesFor("DOM:15:5", "NEXT_BUSINESS_DAY_FEDERAL", periodContaining("ANNUAL", "2026-01-10", 3)).adjusted).toBe("2026-08-17");
    // W-2 / 940: January 31 after the year; 2027-01-31 is a Sunday.
    expect(dueDatesFor("FIXED:01-31:1", "NEXT_BUSINESS_DAY_FEDERAL", periodContaining("ANNUAL", "2026-05-01", 12)).adjusted).toBe("2027-02-01");
    // Emancipation Day (Apr 16) moves an IRS date; Alabama's rule does not.
    expect(adjustDue("2026-04-16", "NEXT_BUSINESS_DAY_FEDERAL")).toBe("2026-04-17");
    expect(adjustDue("2026-04-16", "NEXT_BUSINESS_DAY_ALABAMA")).toBe("2026-04-16");
  });

  it("starts with the first period due on/after the start date (no invented history) and keeps the next one", () => {
    const list = periodsToCreate({ frequency: "MONTHLY", code: "DOM:20:1", weekendRule: "NEXT_BUSINESS_DAY_ALABAMA", startDate: "2026-11-05", today: "2026-11-05" });
    // October (due Nov 20); November (due Dec 21) is created within 45 days of its due date or when October completes.
    expect(list.map((p) => p.key)).toEqual(["2026-10"]);
    expect(periodsToCreate({ frequency: "MONTHLY", code: "DOM:20:1", weekendRule: "NEXT_BUSINESS_DAY_ALABAMA", startDate: "2026-11-05", today: "2026-11-10" }).map((p) => p.key)).toEqual(["2026-10", "2026-11"]);
    const annual = periodsToCreate({ frequency: "ANNUAL", code: "DOM:15:3", weekendRule: "NEXT_BUSINESS_DAY_FEDERAL", startDate: "2026-11-05", today: "2026-11-05" });
    expect(annual.map((p) => p.key)).toEqual(["TY2026"]);
  });
});

async function restaurant(tab: Actor, name = "Fictional Falafel LLC") {
  const c = await client(name);
  const e = await createEntity(tab, c.id, { kind: "LLC", legalName: name, taxClassification: "S_CORP", sCorpEffectiveDate: "2025-01-01", fiscalYearEndMonth: 12, stateOfFormation: "AL", statesOfOperation: ["AL"], activityTags: ["restaurant", "no-alcohol"], payrollStatus: "NO", issues1099: "NO", ein: "12-3456789" });
  await addLocation(tab, e.id, { city: "Birmingham", county: "Jefferson", state: "AL", isPrimary: true });
  await saveTaxAccount(tab, e.id, { type: "SALES_USE", agency: "ALDOR", jurisdictionName: "Alabama", accountNumber: "SUT-000111", filingFrequency: "MONTHLY", status: "ACTIVE" });
  return { c, e };
}

/** An ACTIVE sales tax obligation and its October 2026 period, as of 2026-11-05. */
async function salesTaxPeriod(tab: Actor) {
  const { c, e } = await restaurant(tab);
  await generateObligations(tab, e.id);
  const o = await prisma.complianceObligation.findFirstOrThrow({ where: { entityId: e.id, ruleKey: "AL_SALES_2100" } });
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-05T15:00:00Z"));
  await activateObligation(tab, o.id);
  vi.useRealTimers();
  const p = await prisma.complianceFilingPeriod.findFirstOrThrow({ where: { obligationId: o.id, periodKey: "2026-10" } });
  return { c, e, o, p };
}

describe("obligation generation", () => {
  it("creates proposals only for what the profile supports, pinned to the rule version", async () => {
    const { tab } = await office();
    const { e } = await restaurant(tab);
    const items = await generateObligations(tab, e.id);
    const keys = (await prisma.complianceObligation.findMany({ where: { entityId: e.id } })).map((o) => o.ruleKey);
    expect(keys).toEqual(expect.arrayContaining(["FED_1120S", "AL_20S", "AL_BPT_PPT", "AL_SALES_2100", "JEFF_SALES_USE", "BHM_SALES_USE", "JCDH_FOOD_PERMIT", "BHM_BUSINESS_LICENSE"]));
    for (const k of ["FED_941", "FED_940", "FED_W2_W3", "FED_1099_NEC", "FED_1120", "FED_1065", "HSV_SALES_USE", "BHM_BEVERAGE", "FED_990", "FED_7004"]) expect(keys).not.toContain(k);
    expect(items.find((i) => i.ruleKey === "FED_941")?.result).toBe("DOES_NOT_APPLY");
    const all = await prisma.complianceObligation.findMany({ where: { entityId: e.id }, include: { rule: true } });
    expect(all.every((o) => o.status === "PROPOSED" && o.rule?.version === 1)).toBe(true);
    // Every rule is unverified, so every obligation is Needs Verification and no period exists yet.
    expect(all.every((o) => o.verification === "NEEDS_VERIFICATION")).toBe(true);
    expect(await prisma.complianceFilingPeriod.count()).toBe(0);
    // Re-running never duplicates.
    await generateObligations(tab, e.id);
    expect(await prisma.complianceObligation.count({ where: { entityId: e.id } })).toBe(all.length);
  });

  it("activation creates periods (Needs Verification), and completing one creates the next", async () => {
    const { tab } = await office();
    const { o, p } = await salesTaxPeriod(tab);
    expect(p).toMatchObject({ dueCertainty: "NEEDS_VERIFICATION", filingStatus: "NOT_STARTED", paymentStatus: "UNKNOWN" });
    expect(p.adjustedDue?.toISOString().slice(0, 10)).toBe("2026-11-20");
    expect(p.prepDeadline?.toISOString().slice(0, 10)).toBe("2026-11-10");
    const periods = await prisma.complianceFilingPeriod.findMany({ where: { obligationId: o.id }, orderBy: { periodStart: "asc" } });
    expect(periods.map((x) => x.periodKey)).toEqual(["2026-10"]);
    await recordSubmitted(tab, p.id, { confirmationNumber: "MAT-CONF-1" });
    const nov = await prisma.complianceFilingPeriod.findFirstOrThrow({ where: { obligationId: o.id, periodKey: "2026-11" } });
    expect(nov.adjustedDue?.toISOString().slice(0, 10)).toBe("2026-12-21"); // Dec 20, 2026 is a Sunday
    // Completing November creates December.
    await recordSubmitted(tab, nov.id, { confirmationNumber: "MAT-CONF-2", zeroReturn: true });
    expect(await prisma.complianceFilingPeriod.count({ where: { obligationId: o.id, periodKey: "2026-12" } })).toBe(1);
    expect((await prisma.complianceFilingPeriod.findUniqueOrThrow({ where: { id: nov.id } })).zeroReturn).toBe(true);
  });

  it("owner-only lifecycle: suspend and close stop reminders; staff can't activate", async () => {
    const { tab, daria } = await office();
    const { e } = await restaurant(tab);
    await generateObligations(daria, e.id);
    const o = await prisma.complianceObligation.findFirstOrThrow({ where: { entityId: e.id, ruleKey: "BHM_SALES_USE" } });
    await expect(activateObligation(daria, o.id)).rejects.toBeInstanceOf(ForbiddenError);
    await activateObligation(tab, o.id);
    await setObligationStatus(tab, o.id, "SUSPENDED", "Seasonal closure");
    const before = await prisma.complianceReminder.count();
    await runComplianceReminders(new Date());
    expect(await prisma.complianceReminder.count()).toBe(before);
    await expect(setObligationStatus(daria, o.id, "CLOSED", "x")).rejects.toBeInstanceOf(ForbiddenError);
    await setObligationStatus(tab, o.id, "CLOSED", "Account closed with the city");
    expect((await prisma.complianceObligation.findUniqueOrThrow({ where: { id: o.id } })).status).toBe("CLOSED");
    expect(await prisma.auditLog.count({ where: { entityId: o.id, action: { startsWith: "compliance.obligation_" } } })).toBeGreaterThanOrEqual(3);
  });
});

describe("reminders and safeguards", () => {
  it("creates the prep task and the right reminder immediately when the deadline is under 30 days away", async () => {
    const { tab } = await office();
    const { p } = await salesTaxPeriod(tab);
    const fresh = await prisma.complianceFilingPeriod.findUniqueOrThrow({ where: { id: p.id } });
    expect(fresh.prepTaskId).toBeTruthy();
    const task = await prisma.task.findUniqueOrThrow({ where: { id: fresh.prepTaskId! } });
    expect(task).toMatchObject({ status: "OPEN", assigneeId: tab.id, priority: "HIGH" });
    // 15 days before Nov 20 → the 15-day step (not five separate reminders at once).
    const r = await prisma.complianceReminder.findMany({ where: { periodId: p.id, channel: "IN_APP" } });
    expect(r.map((x) => x.step).sort()).toEqual(["D15", "PREP_TASK"]);
  });

  it("sends 30/15/7/3/1 once each, then escalates daily to staff and owner, deduped under concurrency", async () => {
    const { tab, daria } = await office();
    const c = await client("Fictional Shop");
    const e = await createEntity(tab, c.id, { kind: "LLC", legalName: "Fictional Shop", activityTags: ["retail"] });
    const o = await addCustomObligation(tab, e.id, { title: "Fictional annual report", formName: "Report", jurisdictionLevel: "STATE", jurisdictionName: "Alabama", category: "ANNUAL_REPORT", frequency: "ANNUAL", dueRuleCode: "FIXED:12-31:0", weekendRule: "NO_ADJUSTMENT", startDate: "2027-12-01", verified: true });
    await editObligation(tab, o.id, { assignedStaffId: daria.id });
    const p = await prisma.complianceFilingPeriod.findFirstOrThrow({ where: { obligationId: o.id } });
    expect(p.adjustedDue?.toISOString().slice(0, 10)).toBe("2027-12-31");
    const at = (iso: string) => new Date(`${iso}T15:00:00Z`);
    for (const day of ["2027-11-15", "2027-12-01", "2027-12-01", "2027-12-16", "2027-12-24", "2027-12-28", "2027-12-30", "2027-12-31"]) await runComplianceReminders(at(day));
    const steps = (await prisma.complianceReminder.findMany({ where: { periodId: p.id, channel: "IN_APP", recipient: `staff:${daria.id}` }, orderBy: { createdAt: "asc" } })).map((r) => r.step);
    expect(steps).toEqual(["PREP_TASK", "D30", "D15", "D7", "D3", "D1"]);
    // Overdue: daily to the assigned staff AND the owner; concurrent runs never duplicate.
    await Promise.all([runComplianceReminders(at("2028-01-02")), runComplianceReminders(at("2028-01-02")), runComplianceReminders(at("2028-01-02"))]);
    await runComplianceReminders(at("2028-01-03"));
    const overdue = await prisma.complianceReminder.findMany({ where: { periodId: p.id, channel: "IN_APP", step: { startsWith: "OVERDUE" } } });
    expect(overdue.map((r) => `${r.step}|${r.recipient}`).sort()).toEqual([`OVERDUE:2028-01-02|staff:${daria.id}`, `OVERDUE:2028-01-02|staff:${tab.id}`, `OVERDUE:2028-01-03|staff:${daria.id}`, `OVERDUE:2028-01-03|staff:${tab.id}`].sort());
    expect(await prisma.task.count({ where: { title: { startsWith: "Prepare Report" } } })).toBe(1);
  });

  it("keeps the prep task open until the period is completed with evidence", async () => {
    const { tab } = await office();
    const { p } = await salesTaxPeriod(tab);
    const taskId = (await prisma.complianceFilingPeriod.findUniqueOrThrow({ where: { id: p.id } })).prepTaskId!;
    await expect(setTaskDone(tab, taskId, true)).rejects.toBeInstanceOf(ValidationError);
    // Closed another way (e.g. directly) → the next run reopens it.
    await prisma.task.update({ where: { id: taskId }, data: { status: "DONE" } });
    await runComplianceReminders(new Date("2026-11-06T15:00:00Z"));
    expect((await prisma.task.findUniqueOrThrow({ where: { id: taskId } })).status).toBe("OPEN");
    await expect(recordNotRequired(tab, p.id, { reason: "No sales in October" })).rejects.toThrow(/evidence/);
    await recordNotRequired(tab, p.id, { reason: "No sales in October — agency confirmed", confirmationNumber: "ALDOR-NOACT-7" });
    expect((await prisma.task.findUniqueOrThrow({ where: { id: taskId } })).status).toBe("DONE");
  });

  it("switches OFF (default): client and staff email sends are HELD and nothing is sent", async () => {
    const { tab } = await office();
    const { c, e, o, p } = await salesTaxPeriod(tab);
    const pu = await portalLogin(c.id, "pat.fictional@example.com");
    await prisma.complianceEntity.update({ where: { id: e.id }, data: { portalVisible: true, clientNotificationsEnabled: true } });
    await prisma.clientService.create({ data: { clientId: c.id, type: "BOOKKEEPING", title: "Bookkeeping", status: "IN_PROGRESS", createdById: tab.id } });
    await editObligation(tab, o.id, { clientApprovalRequired: true, clientVisible: true, serviceType: "BOOKKEEPING" });
    const emails = await prisma.complianceReminder.findMany({ where: { periodId: p.id, channel: "EMAIL" } });
    expect(emails.length).toBeGreaterThan(0);
    expect(emails.every((r) => r.status === "HELD")).toBe(true);
    await uploadComplianceDocument(tab, { entityId: e.id, periodId: p.id, kind: "RETURN", bytes: PDF("ret"), originalName: "return.pdf" });
    const v = await createReturnVersion(tab, p.id);
    const sent = await sendForApproval(tab, v.id);
    expect(sent).toEqual([{ portalUserId: pu.id, status: "HELD" }]);
    expect(await prisma.notification.count()).toBe(0);
    // Owner turns the office switch on: now the entity switch lets it through (to the existing notification queue).
    await expect(setComplianceSwitch(tab as Actor, "clientNotificationsAuthorized", true)).resolves.toBeUndefined();
    await runComplianceReminders(new Date(Date.now() + 4 * 86400_000));
    expect(await prisma.notification.count({ where: { portalUserId: pu.id, kind: "COMPLIANCE_APPROVAL_REMINDER" } })).toBe(1);
  });
});

async function approvalSetup() {
  const o = await office();
  const s = await salesTaxPeriod(o.tab);
  const pu = await portalLogin(s.c.id, "owner.fictional@example.com", "Omar Fictional");
  await prisma.complianceEntity.update({ where: { id: s.e.id }, data: { portalVisible: true } });
  await prisma.clientService.create({ data: { clientId: s.c.id, type: "BOOKKEEPING", title: "Bookkeeping", status: "IN_PROGRESS", createdById: o.tab.id } });
  await editObligation(o.tab, s.o.id, { clientApprovalRequired: true, clientVisible: true, serviceType: "BOOKKEEPING" });
  await uploadComplianceDocument(o.tab, { entityId: s.e.id, periodId: s.p.id, kind: "RETURN", bytes: PDF("return-v1"), originalName: "return.pdf" });
  await setAmountDue(o.tab, s.p.id, 123456);
  return { ...o, ...s, pu };
}

describe("client approval gate", () => {
  it("refuses Submitted without approval; approval records identity, hash and comments; a new version invalidates it", async () => {
    const { tab, daria, e, p, pu } = await approvalSetup();
    const v1 = await createReturnVersion(daria, p.id);
    await sendForApproval(daria, v1.id);
    await expect(recordSubmitted(daria, p.id, { confirmationNumber: "C-1" })).rejects.toThrow(/approval is required/i);
    await clientDecide(pu, v1.id, { decision: "APPROVED", signerName: "Omar Fictional", contentHash: v1.contentHash, comments: "Looks right" }, { ip: "203.0.113.7", userAgent: "TestAgent" });
    const a = await prisma.complianceApproval.findFirstOrThrow({ where: { returnVersionId: v1.id } });
    expect(a).toMatchObject({ portalUserId: pu.id, ipAddress: "203.0.113.7", userAgent: "TestAgent", contentHash: v1.contentHash, comments: "Looks right", decision: "APPROVED" });
    // Approvals are append-only.
    await expect(prisma.complianceApproval.update({ where: { id: a.id }, data: { comments: "edited" } })).rejects.toThrow();
    // Staff + owner told immediately (in-app).
    expect(await prisma.complianceReminder.count({ where: { periodId: p.id, step: { startsWith: "APPROVAL_DECISION" }, channel: "IN_APP" } })).toBe(1);
    expect(await currentApproval(p.id)).not.toBeNull();
    // Material change: a new supporting document invalidates the approval.
    await uploadComplianceDocument(daria, { entityId: e.id, periodId: p.id, kind: "SUPPORTING", bytes: PDF("workup"), originalName: "workup.pdf" });
    expect(await currentApproval(p.id)).toBeNull();
    expect((await prisma.complianceReturnVersion.findUniqueOrThrow({ where: { id: v1.id } })).status).toBe("SUPERSEDED");
    await expect(recordSubmitted(daria, p.id, { confirmationNumber: "C-1" })).rejects.toThrow(/approval is required/i);
    const v2 = await createReturnVersion(daria, p.id);
    expect(v2.version).toBe(2);
    expect(v2.contentHash).not.toBe(v1.contentHash);
    await sendForApproval(daria, v2.id);
    // The stale hash can't approve the new version.
    await expect(clientDecide(pu, v2.id, { decision: "APPROVED", signerName: "Omar Fictional", contentHash: v1.contentHash }, {})).rejects.toThrow(/changed/);
    await clientDecide(pu, v2.id, { decision: "APPROVED", signerName: "Omar Fictional", contentHash: v2.contentHash }, {});
    // Amount change also invalidates.
    await setAmountDue(daria, p.id, 999);
    expect(await currentApproval(p.id)).toBeNull();
    const v3 = await createReturnVersion(daria, p.id);
    await sendForApproval(daria, v3.id);
    await clientDecide(pu, v3.id, { decision: "APPROVED", signerName: "Omar Fictional", contentHash: v3.contentHash }, {});
    await recordSubmitted(daria, p.id, { confirmationNumber: "MAT-77" });
    expect((await prisma.complianceFilingPeriod.findUniqueOrThrow({ where: { id: p.id } })).filingStatus).toBe("SUBMITTED");
    void tab;
  });

  it("change requests put the period back to Preparing and need a comment", async () => {
    const { daria, p, pu } = await approvalSetup();
    const v1 = await createReturnVersion(daria, p.id);
    await sendForApproval(daria, v1.id);
    await expect(clientDecide(pu, v1.id, { decision: "CHANGES_REQUESTED", signerName: "Omar Fictional", contentHash: v1.contentHash }, {})).rejects.toThrow(/what should change/);
    await clientDecide(pu, v1.id, { decision: "CHANGES_REQUESTED", signerName: "Omar Fictional", contentHash: v1.contentHash, comments: "Add the catering sales" }, {});
    expect((await prisma.complianceFilingPeriod.findUniqueOrThrow({ where: { id: p.id } })).filingStatus).toBe("PREPARING");
  });
});

describe("evidence rules", () => {
  it("Submitted, Accepted and Paid each need their own evidence and record the verifier", async () => {
    const { tab, daria } = await office();
    const { e, p } = await salesTaxPeriod(tab);
    await expect(recordSubmitted(daria, p.id, {})).rejects.toThrow(/confirmation number or the uploaded filing confirmation/);
    // A document from another entity is refused (entity separation).
    const other = await restaurant(tab, "Other Fictional LLC");
    const foreign = await uploadComplianceDocument(tab, { entityId: other.e.id, kind: "FILING_CONFIRMATION", bytes: PDF("foreign"), originalName: "c.pdf" });
    await expect(recordSubmitted(daria, p.id, { documentId: foreign.document.id })).rejects.toThrow(/folder/);
    const conf = await uploadComplianceDocument(daria, { entityId: e.id, periodId: p.id, kind: "FILING_CONFIRMATION", bytes: PDF("conf"), originalName: "conf.pdf" });
    await expect(recordAccepted(daria, p.id, { confirmationNumber: "ACK" })).rejects.toThrow(/before acceptance/);
    await recordSubmitted(daria, p.id, { documentId: conf.document.id });
    let row = await prisma.complianceFilingPeriod.findUniqueOrThrow({ where: { id: p.id } });
    expect(row).toMatchObject({ filingStatus: "SUBMITTED", verifiedById: daria.id, paymentStatus: "UNKNOWN" });
    expect(row.verifiedAt).toBeInstanceOf(Date);
    await expect(recordAccepted(daria, p.id, {})).rejects.toThrow(/acknowledgement or acceptance notice/);
    await expect(recordAccepted(daria, p.id, { documentId: conf.document.id })).rejects.toThrow(/right kind/);
    await recordAccepted(daria, p.id, { confirmationNumber: "ALDOR-ACK-55" });
    row = await prisma.complianceFilingPeriod.findUniqueOrThrow({ where: { id: p.id } });
    // Filing and payment are separate: accepted, payment still not recorded.
    expect(row).toMatchObject({ filingStatus: "ACCEPTED", acceptedById: daria.id, paymentStatus: "UNKNOWN" });
    await expect(recordPayment(daria, p.id, {})).rejects.toThrow(/payment confirmation/);
    await recordPayment(daria, p.id, { confirmationNumber: "PAY-1" });
    row = await prisma.complianceFilingPeriod.findUniqueOrThrow({ where: { id: p.id } });
    expect(row).toMatchObject({ filingStatus: "ACCEPTED", paymentStatus: "PAID", paidById: daria.id });
    expect((await prisma.complianceEvidence.findMany({ where: { periodId: p.id } })).map((x) => x.kind).sort()).toEqual(["ACCEPTANCE", "FILING_CONFIRMATION", "PAYMENT"]);
    await expect(prisma.complianceEvidence.deleteMany({ where: { periodId: p.id } })).rejects.toThrow();
    // Only manual filing exists.
    await expect(setFilingChannel(daria, p.id, "MAT_BULK")).rejects.toThrow(/disabled/);
  });

  it("payment can be recorded before filing without changing the filing status", async () => {
    const { tab } = await office();
    const { p } = await salesTaxPeriod(tab);
    await recordPayment(tab, p.id, { confirmationNumber: "EFT-1" });
    expect(await prisma.complianceFilingPeriod.findUniqueOrThrow({ where: { id: p.id } })).toMatchObject({ filingStatus: "NOT_STARTED", paymentStatus: "PAID" });
  });
});

describe("entity separation and portal isolation", () => {
  it("restaurant and nonprofit calendars, approvals and documents never mix; other clients and owners can't see them", async () => {
    const { tab } = await office();
    const c = await client("Fictional Shawarma Co");
    await prisma.clientService.create({ data: { clientId: c.id, type: "BOOKKEEPING", title: "Bookkeeping", status: "IN_PROGRESS", createdById: tab.id } });
    const { business, nonprofit } = await applyProposedProfile(tab, c.id, "RESTAURANT_AL_SCORP_JEFFERSON_BHM");
    const bizObl = await prisma.complianceObligation.findMany({ where: { entityId: business.id } });
    const npObl = await prisma.complianceObligation.findMany({ where: { entityId: nonprofit!.id } });
    expect(bizObl.some((o) => o.ruleKey === "FED_990")).toBe(false);
    expect(npObl.some((o) => o.ruleKey === "FED_1120S" || o.ruleKey === "AL_SALES_2100")).toBe(false);
    // Owner activates the restaurant's sales tax and the nonprofit's custom checklist.
    const sales = bizObl.find((o) => o.ruleKey === "AL_SALES_2100")!;
    await activateObligation(tab, sales.id);
    const salesPeriod = await prisma.complianceFilingPeriod.findFirstOrThrow({ where: { obligationId: sales.id } });
    expect(salesPeriod.entityId).toBe(business.id);
    // A nonprofit document can't be used as the restaurant's evidence.
    const npDoc = await uploadComplianceDocument(tab, { entityId: nonprofit!.id, kind: "FILING_CONFIRMATION", bytes: PDF("np"), originalName: "np.pdf" });
    await expect(recordSubmitted(tab, salesPeriod.id, { documentId: npDoc.document.id })).rejects.toThrow(/folder/);
    await expect(uploadComplianceDocument(tab, { entityId: nonprofit!.id, periodId: salesPeriod.id, kind: "RETURN", bytes: PDF("x"), originalName: "x.pdf" })).rejects.toThrow(/different entity/);

    // Portal: the business's client login sees the restaurant once visible; another client's login never.
    await prisma.complianceEntity.updateMany({ where: { id: { in: [business.id, nonprofit!.id] } }, data: { portalVisible: true } });
    await editObligation(tab, sales.id, { clientVisible: true, serviceType: "BOOKKEEPING" });
    const me = await portalLogin(c.id, "omar.fictional@example.com", "Omar Fictional");
    const mine = await portalCompliance(me, c.id);
    expect(mine.entities.map((x) => x.id)).toContain(business.id);
    expect(mine.entities.find((x) => x.id === business.id)!.periods.map((x) => x.id)).toContain(salesPeriod.id);
    const stranger = await portalLogin((await client("Unrelated Fictional Bakery")).id, "stranger.fictional@example.com");
    await expect(portalCompliance(stranger, c.id)).rejects.toBeInstanceOf(ForbiddenError);
    await uploadComplianceDocument(tab, { entityId: business.id, periodId: salesPeriod.id, kind: "RETURN", bytes: PDF("r"), originalName: "r.pdf" });
    const docId = (await prisma.complianceDocument.findFirstOrThrow({ where: { periodId: salesPeriod.id, kind: "RETURN" } })).documentId;
    await prisma.document.update({ where: { id: docId }, data: { scanStatus: "CLEAN" } });
    await prisma.complianceDocument.update({ where: { documentId: docId }, data: { publishedAt: new Date() } });
    expect(await portalComplianceDocument(me.id, docId)).not.toBeNull();
    expect(await portalComplianceDocument(stranger.id, docId)).toBeNull();

    // A co-owner (business owner login) linked only to the nonprofit doesn't see the restaurant unless granted.
    const coUser = await portalLogin(c.id, "co.fictional@example.com", "Cora Fictional");
    const contact = await prisma.contact.create({ data: { clientId: c.id, name: "Cora Fictional" } });
    const bo = await prisma.businessOwner.create({ data: { clientId: c.id, contactId: contact.id, portalUserId: coUser.id } });
    await prisma.complianceEntityOwner.create({ data: { entityId: nonprofit!.id, businessOwnerId: bo.id } });
    const coView = await portalCompliance(coUser, c.id);
    expect(coView.entities.map((x) => x.id)).not.toContain(business.id);
    expect(await portalComplianceDocument(coUser.id, docId)).toBeNull();
    await prisma.complianceEntityViewer.create({ data: { entityId: business.id, portalUserId: coUser.id, grantedById: tab.id } });
    expect((await portalCompliance(coUser, c.id)).entities.map((x) => x.id)).toContain(business.id);
  });
});

describe("permissions", () => {
  it("NONE is refused everywhere, VIEW can read but not change, MANAGE works, owner-only stays owner-only", async () => {
    const { tab, daria, viewer, none } = await office();
    expect((await complianceAccess(none)).level).toBe("NONE");
    expect((await complianceAccess(viewer)).level).toBe("VIEW");
    expect((await complianceAccess(daria)).level).toBe("MANAGE");
    expect(await complianceAccess(tab)).toMatchObject({ level: "MANAGE", isOwner: true, canRevealEin: true });
    const c = await client("Fictional Perm Co");
    // NONE — every read and write says Not found.
    await expect(taxDueBoard(none)).rejects.toThrow("Not found.");
    await expect(missingInfoReport(none)).rejects.toThrow("Not found.");
    await expect(listObligations(none)).rejects.toThrow("Not found.");
    await expect(rulesLibrary(none)).rejects.toThrow("Not found.");
    await expect(createEntity(none, c.id, { kind: "LLC" })).rejects.toThrow("Not found.");
    // VIEW — reads work, mutations refused.
    await expect(taxDueBoard(viewer)).resolves.toBeTruthy();
    await expect(createEntity(viewer, c.id, { kind: "LLC" })).rejects.toThrow(/view-only/);
    const e = await createEntity(daria, c.id, { kind: "LLC", legalName: "Fictional Perm Co" });
    await expect(updateEntity(viewer, e.id, { kind: "LLC" })).rejects.toThrow(/view-only/);
    await expect(generateObligations(viewer, e.id)).rejects.toThrow(/view-only/);
    await expect(saveFilingAccount(viewer, e.id, { portalKind: "MAT", name: "MAT", portalUrl: "https://myalabamataxes.alabama.gov/" })).rejects.toThrow(/view-only/);
    await expect(applyProposedProfile(viewer, c.id, "RESTAURANT_AL_SCORP_JEFFERSON_BHM")).rejects.toThrow(/view-only/);
    // Owner-only: switches and rule edits.
    await expect(setComplianceSwitch(daria, "staffEmailReminders", true)).rejects.toBeInstanceOf(ForbiddenError);
    await ensureRulesLoaded();
    await expect(editRule(daria, "FED_941", { sourceUrl: "https://www.irs.gov/forms-pubs/about-form-941", verificationStatus: "VERIFIED", reason: "Checked" })).rejects.toBeInstanceOf(ForbiddenError);
    // An Admin role alone never grants compliance access.
    expect(none.role).toBe("ADMIN");
  });

  it("filing accounts never store passwords", async () => {
    const { tab } = await office();
    const c = await client("Fictional Portal Co");
    const e = await createEntity(tab, c.id, { kind: "LLC" });
    await expect(saveFilingAccount(tab, e.id, { portalKind: "MAT", name: "MAT", portalUrl: "https://myalabamataxes.alabama.gov/", accessReference: "password: hunter2" })).rejects.toThrow(/passwords/);
    const ok = await saveFilingAccount(tab, e.id, { portalKind: "MAT", name: "MAT — sales tax", portalUrl: "https://myalabamataxes.alabama.gov/", accessMethod: "MAT third-party access via firm agent account", accessReference: "1Password: MAT agent (firm)" });
    expect(Object.keys(ok).some((k) => /password|secret|mfa/i.test(k))).toBe(false);
  });
});

describe("EIN", () => {
  it("is encrypted at rest, shown masked, and revealed only with a logged reason to the owner or a grant", async () => {
    const { tab, daria } = await office();
    const c = await client("Fictional EIN Co");
    const e = await createEntity(daria, c.id, { kind: "LLC", ein: "98-7654321" });
    const row = await prisma.complianceEntity.findUniqueOrThrow({ where: { id: e.id } });
    expect(row.einLast4).toBe("4321");
    expect(row.einEncrypted).toBeTruthy();
    expect(row.einEncrypted).not.toContain("7654321");
    await expect(revealEntityEin(daria, e.id, "Filing the 941")).rejects.toBeInstanceOf(ForbiddenError);
    await expect(revealEntityEin(tab, e.id, "")).rejects.toThrow(/why/);
    expect(await revealEntityEin(tab, e.id, "Entering it in MAT")).toBe("98-7654321");
    await grantPerms(daria.id, ["compliance.reveal_ein"]);
    await setEntityEin(daria, e.id, "11-2223333");
    expect(await revealEntityEin(daria, e.id, "IRS e-Services lookup")).toBe("11-2223333");
    const logs = await prisma.auditLog.findMany({ where: { entityId: e.id, action: "compliance.ein_revealed" } });
    expect(logs.map((l) => (l.details as { reason: string }).reason)).toEqual(expect.arrayContaining(["Entering it in MAT", "IRS e-Services lookup"]));
  });
});

describe("Missing Compliance Information", () => {
  it("lists every gap that blocks a confirmed obligation, exportable to CSV", async () => {
    const { tab } = await office();
    const c = await client("Fictional Gaps LLC");
    const e = await createEntity(tab, c.id, { kind: "LLC", activityTags: ["retail"] });
    await addLocation(tab, e.id, { city: "Birmingham", state: "AL" });
    await saveTaxAccount(tab, e.id, { type: "SALES_USE", agency: "Jefferson County Revenue", jurisdictionName: "Jefferson County", status: "ACTIVE" });
    await generateObligations(tab, e.id);
    const rows = await missingInfoReport(tab, { clientId: c.id });
    const items = rows.map((r) => r.item);
    expect(items).toEqual(expect.arrayContaining(["Legal name not recorded", "EIN not recorded", "Fiscal year-end not recorded", "County not recorded for Birmingham", "Jefferson County sales/use tax account: account number missing", "Jefferson County sales/use tax account: filing frequency not recorded"]));
    const csv = missingInfoCsv(rows);
    expect(csv.split("\n")[0]).toBe("Client,Entity,Missing information,Blocks,Source");
    expect(csv).toContain("EIN not recorded");
    expect(missingInfoCsv([{ clientId: "x", clientName: "=HYPERLINK()", entityId: "y", entityName: "E", item: "i", blocks: "b", source: "s" }])).toContain("'=HYPERLINK()");
  });
});

describe("Mr. Shawarma proposal", () => {
  it("creates the expected PROPOSED / Needs Verification items, a separate nonprofit, and invents no identifiers", async () => {
    const { tab } = await office();
    const c = await prisma.client.create({ data: { displayName: "Mr. Shawarma (DEMO, not real data)", businessName: "Mr. Shawarma (DEMO, not real data)", clientType: "BUSINESS", city: "Birmingham", state: "AL" } });
    const r = await applyProposedProfile(tab, c.id, "RESTAURANT_AL_SCORP_JEFFERSON_BHM");
    const again = await applyProposedProfile(tab, c.id, "RESTAURANT_AL_SCORP_JEFFERSON_BHM");
    expect(again.businessItems + again.nonprofitItems).toBe(0);
    const biz = await prisma.complianceEntity.findUniqueOrThrow({ where: { id: r.business.id }, include: { obligations: true, locations: true, taxAccounts: true } });
    expect(biz).toMatchObject({ status: "PROPOSED", taxClassification: "S_CORP", einEncrypted: null, einLast4: null, sCorpEffectiveDate: null, fiscalYearEndMonth: null });
    expect(biz.taxAccounts).toHaveLength(0);
    expect(biz.locations[0]).toMatchObject({ city: "Birmingham", county: "Jefferson", state: "AL" });
    const keys = biz.obligations.map((o) => o.dedupeKey);
    expect(keys).toEqual(expect.arrayContaining(["FED_1120S", "AL_20S", "AL_BPT_PPT", "AL_SALES_2100", "JEFF_SALES_USE", "BHM_SALES_USE", "FED_941", "FED_940", "FED_W2_W3", "AL_WH_A6", "AL_WH_A3", "FED_1099_NEC", "AL_SALES_LICENSE_RENEWAL", "BHM_BUSINESS_LICENSE", "JEFF_BUSINESS_LICENSE", "JEFF_ENTITY_LICENSE", "JCDH_FOOD_PERMIT", "AL_BPP_JEFFERSON", "proposal:OTHER_LOCATION_ACTIVITY"]));
    expect(keys).toHaveLength(PROPOSALS.RESTAURANT_AL_SCORP_JEFFERSON_BHM.items.length);
    for (const o of biz.obligations) {
      expect(o.status).toBe("PROPOSED");
      expect(o.verification).toBe("NEEDS_VERIFICATION");
      if (o.ruleKey) for (const word of ["Jurisdiction:", "Account registration:", "Frequency:", "Due date:", "Filing authority:"]) expect(o.verifyItems.some((v) => v.startsWith(word))).toBe(true);
    }
    expect(biz.obligations.find((o) => o.dedupeKey === "proposal:OTHER_LOCATION_ACTIVITY")!.verifyItems.join(" ")).toMatch(/alcohol/i);
    const np = await prisma.complianceEntity.findUniqueOrThrow({ where: { id: r.nonprofit!.id }, include: { obligations: true } });
    expect(np).toMatchObject({ kind: "NONPROFIT", legalName: null, einEncrypted: null, linkedEntityId: biz.id, stateOfFormation: null, irsExemptionStatus: null, fiscalYearEndMonth: null });
    expect(np.obligations.map((o) => o.dedupeKey).sort()).toEqual(["AL_AG_CHARITABLE", "AL_SOS_NONPROFIT", "FED_990", "proposal:NP_EXEMPTION_DOCS", "proposal:NP_OWN_PAYROLL_TAX"].sort());
    expect(np.obligations.find((o) => o.ruleKey === "FED_990")!.verifyItems[0]).toMatch(/gross receipts/);
    // No periods, reminders or tasks until the owner approves.
    expect(await prisma.complianceFilingPeriod.count()).toBe(0);
    expect(await prisma.task.count({ where: { title: { startsWith: "Prepare" } } })).toBe(0);
    const missing = (await missingInfoReport(tab, { clientId: c.id })).filter((m) => m.entityId === np.id).map((m) => m.item);
    expect(missing).toEqual(expect.arrayContaining(["Legal name not recorded", "EIN not recorded", "IRS exemption status not recorded", "Fiscal year-end not recorded", "State of formation not recorded"]));
  });
});

describe("rules library", () => {
  it("loads versioned seed rules once; owner edits add a version with editor, reason and source", async () => {
    const { tab } = await office();
    expect(await ensureRulesLoaded()).toBe(RULES.length);
    expect(await ensureRulesLoaded()).toBe(0);
    const lib = await rulesLibrary(tab);
    expect(lib.counts).toEqual({ total: RULES.length, verified: 0, needsVerification: RULES.length });
    expect(lib.reviewQueue).toHaveLength(RULES.length);
    await expect(editRule(tab, "FED_941", { sourceUrl: "not a link", verificationStatus: "VERIFIED", reason: "Checked the page" })).rejects.toThrow(/source link/);
    const v2 = await editRule(tab, "FED_941", { sourceUrl: "https://www.irs.gov/forms-pubs/about-form-941", verificationStatus: "VERIFIED", reason: "Opened the IRS page and read the due dates" });
    expect(v2).toMatchObject({ version: 2, isCurrent: true, editedById: tab.id, verificationStatus: "VERIFIED", origin: "OWNER_EDIT" });
    expect(await prisma.complianceRule.count({ where: { ruleKey: "FED_941" } })).toBe(2);
    // The seed loader leaves the owner's version alone.
    expect(await ensureRulesLoaded()).toBe(0);
    expect((await rulesLibrary(tab)).reviewQueue.some((r) => r.ruleKey === "FED_941")).toBe(false);
  });
});

describe("prepopulation", () => {
  it("uses only existing records and shows each fact's source", async () => {
    const { tab } = await office();
    const c = await prisma.client.create({ data: { displayName: "Fictional Prepop", businessName: "Fictional Prepop Inc", clientType: "BUSINESS", entityType: "S_CORP", fiscalYearEnd: 12, city: "Huntsville", state: "AL" } });
    const e = await createEntityFromClient(tab, c.id, { kind: "CORPORATION" });
    expect(e).toMatchObject({ legalName: "Fictional Prepop Inc", taxClassification: "S_CORP", fiscalYearEndMonth: 12, einEncrypted: null });
    expect(e.factSources).toMatchObject({ legalName: "Client", taxClassification: "Client", fiscalYearEndMonth: "Client" });
    const f = await entityFacts(e.id);
    expect(f.cities).toEqual(["Huntsville"]);
    expect(f.registrations).toEqual([]);
  });
});
