import { beforeEach, describe, expect, it } from "vitest";
import { makeUser, prisma, resetDb } from "./db";
import { createClient } from "@/lib/services/clients";
import { addRegistration, addRequirement, completeFiling, dueDateFor, effectiveStatus, flagFiling, markNotRequired, outstandingFilings, runComplianceReminders, runComplianceTool, setFilingStatus } from "@/lib/services/state-compliance";

// Fictional businesses, IDs and notices only.
beforeEach(async () => { await resetDb(); });

async function world() {
  const tabitha = await makeUser("ADMIN", "Tabitha");
  await prisma.ownerAccess.create({ data: { userId: tabitha.id, isPrimary: true } });
  const staff = await makeUser("STAFF", "Daria");
  const biz = await createClient(tabitha, { businessName: "Oak Example Training LLC (fictional)", clientType: "BUSINESS", status: "ACTIVE" });
  const other = await createClient(tabitha, { businessName: "Pine Example Works (fictional)", clientType: "BUSINESS", status: "ACTIVE" });
  return { tabitha, staff, biz, other };
}

const marylandForm1 = async (w: Awaited<ReturnType<typeof world>>, today = "2026-11-18") => {
  const reg = await addRegistration(w.staff, w.biz.id, { state: "MD", kind: "FORMATION", entityId: "W00000000", agency: "Maryland Department of Assessments and Taxation (SDAT)" });
  const req = await addRequirement(w.staff, w.biz.id, { state: "MD", registrationId: reg.id, category: "ANNUAL_REPORT", name: "Form 1 Annual Report / Personal Property Tax Return", agency: "SDAT", filingUrl: "https://egov.maryland.gov/BusinessExpress", frequency: "ANNUAL", dueMonth: 4, dueDay: 15, startYear: 2025 });
  // ensureFilings ran with the real date; for a fixed "today" in the test, the periods are the same through 2027.
  void today;
  return { reg, req };
};

describe("state compliance (internal to the office)", () => {
  it("each state's own due date; every period from the first tracked year through the next one due", async () => {
    const w = await world();
    const { req } = await marylandForm1(w);
    const filings = await prisma.complianceFiling.findMany({ where: { requirementId: req.id }, orderBy: { period: "asc" } });
    expect(filings.map((f) => [f.period, f.dueDate.toISOString().slice(0, 10)])).toEqual([[2025, "2025-04-15"], [2026, "2026-04-15"], [2027, "2027-04-15"]]);
    expect(effectiveStatus(filings[0], "2026-11-18")).toBe("OVERDUE");
    expect(effectiveStatus(filings[2], "2026-11-18")).toBe("NOT_STARTED");
    expect(dueDateFor(2027, 2, 31).toISOString().slice(0, 10)).toBe("2027-02-28");
    // The same registration or filing isn't added twice.
    await expect(addRegistration(w.staff, w.biz.id, { state: "MD", entityId: "W00000000" })).rejects.toThrow(/already has/);
    await expect(addRequirement(w.staff, w.biz.id, { state: "MD", category: "ANNUAL_REPORT", name: "form 1 annual report / personal property tax return", dueMonth: 4, dueDay: 15, startYear: 2025 })).rejects.toThrow(/already tracked/);
  });

  it("the 2025 filing flagged urgent with the forfeiture deadline stays urgent and on the dashboard until completed with evidence", async () => {
    const w = await world();
    const { req } = await marylandForm1(w);
    const f2025 = await prisma.complianceFiling.findFirstOrThrow({ where: { requirementId: req.id, period: 2025 } });
    await flagFiling(w.staff, w.biz.id, f2025.id, { finalDeadline: "2026-12-22", urgent: true, reason: "Forfeiture notice dated 10/23/2026" });
    const dash = await outstandingFilings({ today: "2026-11-18" });
    expect(dash[0]).toMatchObject({ id: f2025.id, urgent: true, effective: "OVERDUE" });
    // Working statuses don't clear it; Filed can't be set as a working status.
    await setFilingStatus(w.staff, w.biz.id, f2025.id, "IN_PROGRESS");
    await expect(setFilingStatus(w.staff, w.biz.id, f2025.id, "FILED")).rejects.toThrow(/confirmation/);
    expect((await prisma.complianceFiling.findUniqueOrThrow({ where: { id: f2025.id } })).urgent).toBe(true);
    // Never completed without evidence.
    await expect(completeFiling(w.staff, w.biz.id, f2025.id, { filedOn: "2026-11-17" })).rejects.toThrow(/never marked completed without evidence/);
    await completeFiling(w.staff, w.biz.id, f2025.id, { filedOn: "2026-11-17", confirmationNumber: "MD-CONF-0001" });
    const done = await prisma.complianceFiling.findUniqueOrThrow({ where: { id: f2025.id } });
    expect(done).toMatchObject({ status: "FILED", urgent: false, confirmationNumber: "MD-CONF-0001", completedById: w.staff.id });
    expect((await outstandingFilings({ today: "2026-11-18" })).some((f) => f.id === f2025.id)).toBe(false);
  });

  it("office reminders: one task per filing at 90/60/30/15/7 days and the due date, against the final deadline once overdue; nothing to the client", async () => {
    const w = await world();
    const { req } = await marylandForm1(w);
    const f2027 = await prisma.complianceFiling.findFirstOrThrow({ where: { requirementId: req.id, period: 2027 } });
    // 2027 is due 2027-04-15: nothing until 90 days before.
    await runComplianceReminders({ today: "2026-12-01" });
    expect(await prisma.task.count({ where: { reminderKey: `compliance:${f2027.id}` } })).toBe(0);
    await runComplianceReminders({ today: "2027-01-15" }); // 90 days before
    let task = await prisma.task.findUniqueOrThrow({ where: { reminderKey: `compliance:${f2027.id}` } });
    expect(task).toMatchObject({ status: "OPEN", priority: "NORMAL", assigneeId: w.tabitha.id, clientId: w.biz.id });
    expect(task.details).toMatch(/nothing is sent to the client/);
    await runComplianceReminders({ today: "2027-01-16" }); // nothing new the next day
    expect((await prisma.complianceFiling.findUniqueOrThrow({ where: { id: f2027.id } })).remindersSent).toEqual([90]);
    await runComplianceReminders({ today: "2027-04-01" }); // 14 days: the 60, 30 and 15 thresholds
    task = await prisma.task.findUniqueOrThrow({ where: { reminderKey: `compliance:${f2027.id}` } });
    expect(task.priority).toBe("HIGH");
    expect((await prisma.complianceFiling.findUniqueOrThrow({ where: { id: f2027.id } })).remindersSent.sort((a, b) => a - b)).toEqual([15, 30, 60, 90]);
    expect(await prisma.task.count({ where: { reminderKey: `compliance:${f2027.id}` } })).toBe(1);
    expect(await prisma.notification.count()).toBe(0); // no client notices
    // Completing it closes the task and adds 2028.
    await completeFiling(w.staff, w.biz.id, f2027.id, { filedOn: new Date().toISOString().slice(0, 10), confirmationNumber: "X1" });
    expect((await prisma.task.findUniqueOrThrow({ where: { reminderKey: `compliance:${f2027.id}` } })).status).toBe("DONE");
    expect(await prisma.complianceFiling.findFirst({ where: { requirementId: req.id, period: 2028 } })).not.toBeNull();
  });

  it("an overdue filing is reminded against its final deadline, and the reminder says URGENT", async () => {
    const w = await world();
    const { req } = await marylandForm1(w);
    const f2025 = await prisma.complianceFiling.findFirstOrThrow({ where: { requirementId: req.id, period: 2025 } });
    await flagFiling(w.staff, w.biz.id, f2025.id, { finalDeadline: "2026-12-22", urgent: true, reason: "Forfeiture notice" });
    await runComplianceReminders({ today: "2026-11-25" }); // 27 days before the forfeiture date
    const task = await prisma.task.findUniqueOrThrow({ where: { reminderKey: `compliance:${f2025.id}` } });
    expect(task.title).toMatch(/^URGENT: .*OVERDUE since 2025-04-15/);
    expect(task.dueAt?.toISOString().slice(0, 10)).toBe("2026-12-22");
    expect((await prisma.complianceFiling.findUniqueOrThrow({ where: { id: f2025.id } })).remindersSent).toEqual(expect.arrayContaining([1030]));
  });

  it("Coetha sees the filings and moves them along, but can never mark one filed; only an Admin marks one not required", async () => {
    const w = await world();
    const { req } = await marylandForm1(w);
    const f2026 = await prisma.complianceFiling.findFirstOrThrow({ where: { requirementId: req.id, period: 2026 } });
    const r = await runComplianceTool(w.tabitha, w.biz.id, { updates: [{ filingId: f2026.id, status: "WAITING_ON_CLIENT" }, { filingId: f2026.id, status: "FILED" }] });
    expect(r.updated![1]).toMatch(/not changed/);
    expect(r.filings.find((f) => f.filingId === f2026.id)).toMatchObject({ period: 2026, status: "Overdue", workingStatus: "Waiting on Client" });
    expect(r.registrations[0]).toMatchObject({ state: "MD", entityId: "W00000000" });
    // Another business's filing can't be touched through this client.
    await expect(setFilingStatus(w.staff, w.other.id, f2026.id, "IN_PROGRESS")).rejects.toThrow(/isn't on file/);
    await expect(markNotRequired(w.staff, w.biz.id, f2026.id, "Dissolved")).rejects.toThrow(/Admin/);
    await markNotRequired(w.tabitha, w.biz.id, f2026.id, "Business dissolved (fictional)");
    expect((await prisma.complianceFiling.findUniqueOrThrow({ where: { id: f2026.id } })).status).toBe("NOT_REQUIRED");
  });
});
