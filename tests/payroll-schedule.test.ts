import { describe, expect, it } from "vitest";
import { businessDaysBefore, cycleDates, federalHolidays, isBusinessDay, nominalPayDates, onOrBeforeBusinessDay, planCycles, scheduleProblems, type ScheduleRule } from "@/lib/payroll/schedule";
import { DEFAULT_PLAN, isOverdue, QUEUE_STATUS, normalizePlan, queueStatus, sortQueue, toQueueRow, type CycleFacts } from "@/lib/payroll/queue";

const base = { periodEndLagDays: 5, hoursRequestLeadDays: 5, hoursDueDays: 3, approvalDueDays: 2, adpCutoffDays: 2 };
const rule = (r: Partial<ScheduleRule>): ScheduleRule => ({ frequency: "WEEKLY", anchorPayDate: "2026-11-06", ...base, ...r });

describe("US federal holidays and business days", () => {
  it("knows the eleven federal holidays, as observed", () => {
    expect([...federalHolidays(2026)].sort()).toEqual([
      "2026-01-01", "2026-01-19", "2026-02-16", "2026-05-25", "2026-06-19", "2026-07-03", // July 4 is a Saturday → Friday
      "2026-09-07", "2026-10-12", "2026-11-11", "2026-11-26", "2026-12-25",
    ]);
    // New Year's Day 2028 is a Saturday: observed Friday, December 31, 2027.
    expect(federalHolidays(2027).has("2027-12-31")).toBe(true);
    // DC-only holidays are not federal holidays.
    expect(federalHolidays(2026).has("2026-04-16")).toBe(false);
  });
  it("moves dates earlier, never later", () => {
    expect(onOrBeforeBusinessDay("2026-11-26")).toBe("2026-11-25"); // Thanksgiving → Wednesday
    expect(onOrBeforeBusinessDay("2026-11-28")).toBe("2026-11-27"); // Saturday → Friday
    expect(onOrBeforeBusinessDay("2026-12-27")).toBe("2026-12-24"); // Sunday → (Christmas Fri) → Thursday
    expect(onOrBeforeBusinessDay("2026-11-27")).toBe("2026-11-27");
    expect(isBusinessDay("2026-11-11")).toBe(false);
    // Two business days before Monday Nov 30 skips the weekend and Thanksgiving's Friday is open.
    expect(businessDaysBefore("2026-11-30", 2)).toBe("2026-11-25");
    expect(businessDaysBefore("2026-11-27", 1)).toBe("2026-11-25");
  });
});

describe("pay dates for all four frequencies", () => {
  it("weekly: every 7 days from the anchor, with the Thanksgiving-week deadlines earlier", () => {
    const c = planCycles(rule({ frequency: "WEEKLY", anchorPayDate: "2026-10-02" }), "2026-11-05", 29);
    expect(c.map((x) => x.payDate)).toEqual(["2026-11-06", "2026-11-13", "2026-11-20", "2026-11-27", "2026-12-04"]);
    const thanks = c.find((x) => x.payDate === "2026-11-27")!;
    expect(thanks).toMatchObject({ hoursRequestDate: "2026-11-19", hoursDueDate: "2026-11-23", approvalDueDate: "2026-11-24", adpCutoffDate: "2026-11-24", periodEnd: "2026-11-22", periodStart: "2026-11-16" });
  });
  it("biweekly: every 14 days, holiday pay date moved earlier", () => {
    const c = planCycles(rule({ frequency: "BIWEEKLY", anchorPayDate: "2026-10-30" }), "2026-11-05", 42);
    expect(c.map((x) => x.nominalPayDate)).toEqual(["2026-11-13", "2026-11-27", "2026-12-11"]);
    // Dec 25 2026 is Christmas (a Friday) → paid Thursday Dec 24.
    const xmas = planCycles(rule({ frequency: "BIWEEKLY", anchorPayDate: "2026-12-11" }), "2026-12-20", 10);
    expect(xmas[0]).toMatchObject({ nominalPayDate: "2026-12-25", payDate: "2026-12-24" });
  });
  it("semimonthly: the 15th and the last day, weekends moved earlier", () => {
    const c = planCycles(rule({ frequency: "SEMIMONTHLY", anchorPayDate: "2026-10-15", semiMonthlyDays: [15, 31] }), "2026-11-01", 62);
    expect(c.map((x) => [x.nominalPayDate, x.payDate])).toEqual([
      ["2026-11-15", "2026-11-13"], // Sunday → Friday
      ["2026-11-30", "2026-11-30"], // 31 = last day of November
      ["2026-12-15", "2026-12-15"],
      ["2026-12-31", "2026-12-31"],
    ]);
    // Period: the day after the previous period ends.
    expect(c[1].periodStart).toBe("2026-11-11");
    expect(c[1].periodEnd).toBe("2026-11-25");
    // February's last day.
    expect(nominalPayDates({ frequency: "SEMIMONTHLY", anchorPayDate: "2027-01-15", semiMonthlyDays: [1, 31] }, "2027-02-01", "2027-03-01")).toContain("2027-02-28");
  });
  it("monthly: the anchor's day each month (last day stays last day)", () => {
    const c = planCycles(rule({ frequency: "MONTHLY", anchorPayDate: "2026-08-31" }), "2026-11-01", 92);
    expect(c.map((x) => x.nominalPayDate)).toEqual(["2026-11-30", "2026-12-31", "2027-01-31"]);
    expect(c[2].payDate).toBe("2027-01-29"); // Sunday → Friday
    const mid = planCycles(rule({ frequency: "MONTHLY", anchorPayDate: "2026-10-01" }), "2026-12-15", 20);
    expect(mid[0]).toMatchObject({ nominalPayDate: "2027-01-01", payDate: "2026-12-31" }); // New Year's Day → Dec 31
  });
  it("cycle deadlines are business days before the pay date", () => {
    const c = cycleDates(rule({}), "2026-11-13", "2026-11-06");
    expect(c).toMatchObject({ payDate: "2026-11-13", hoursRequestDate: "2026-11-05", hoursDueDate: "2026-11-09", approvalDueDate: "2026-11-10", adpCutoffDate: "2026-11-10" });
  });
  it("validates the schedule", () => {
    expect(scheduleProblems(rule({}))).toEqual([]);
    expect(scheduleProblems(rule({ hoursRequestLeadDays: 2, hoursDueDays: 3 })).join(" ")).toMatch(/before hours are due/);
    expect(scheduleProblems(rule({ approvalDueDays: 1, adpCutoffDays: 2 })).join(" ")).toMatch(/cutoff/);
    expect(scheduleProblems(rule({ frequency: "SEMIMONTHLY", semiMonthlyDays: [15] })).join(" ")).toMatch(/two pay days/);
    expect(scheduleProblems({ ...rule({}), frequency: "DAILY" as never }).join(" ")).toMatch(/how often/);
  });
});

describe("queue status mapping", () => {
  const f = (over: Partial<CycleFacts> = {}): CycleFacts => ({ payDate: "2026-11-13", hoursRequestDate: "2026-11-05", hoursDueDate: "2026-11-09", approvalDueDate: "2026-11-10", adpCutoffDate: "2026-11-10", hoursRequestedAt: null, hoursSubmittedAt: null, errorFlaggedAt: null, processedAt: null, run: null, ...over });
  const run = (status: string) => ({ status, currentVersionId: "v" });
  it("maps every stage", () => {
    expect(queueStatus(f(), "2026-11-01")).toBe("UPCOMING");
    expect(queueStatus(f(), "2026-11-05")).toBe("WAITING_ON_HOURS");
    expect(queueStatus(f({ hoursRequestedAt: new Date() }), "2026-11-01")).toBe("WAITING_ON_HOURS");
    expect(queueStatus(f({ hoursSubmittedAt: new Date() }), "2026-11-06")).toBe("PREVIEW_TO_PREPARE");
    expect(queueStatus(f({ run: run("DRAFT") }), "2026-11-06")).toBe("PREVIEW_TO_PREPARE");
    expect(queueStatus(f({ run: run("AWAITING_APPROVAL") }), "2026-11-06")).toBe("AWAITING_CLIENT_APPROVAL");
    expect(queueStatus(f({ run: run("DENIED") }), "2026-11-06")).toBe("CHANGES_REQUESTED");
    // PAY-1: a waiting run reads by what happened to its approval email.
    expect(queueStatus(f({ run: { ...run("AWAITING_APPROVAL"), approvalDelivery: "NOT_SENT" } }), "2026-11-06")).toBe("APPROVAL_NOT_SENT");
    expect(queueStatus(f({ run: { ...run("AWAITING_APPROVAL"), approvalDelivery: "FAILED" } }), "2026-11-06")).toBe("DELIVERY_FAILED");
    expect(queueStatus(f({ run: { ...run("AWAITING_APPROVAL"), approvalDelivery: "SENT" } }), "2026-11-06")).toBe("AWAITING_CLIENT_APPROVAL");
    expect(QUEUE_STATUS.APPROVAL_NOT_SENT.label).toBe("Approval Prepared — Not Sent");
    expect(QUEUE_STATUS.DELIVERY_FAILED.label).toBe("Delivery Failed — Needs Attention");
    expect(QUEUE_STATUS.AWAITING_CLIENT_APPROVAL.label).toBe("Awaiting Client Approval");
    expect(QUEUE_STATUS.CHANGES_REQUESTED.label).toBe("Changes Requested");
    expect(QUEUE_STATUS.READY_TO_PROCESS.label).toBe("Client Approved");
    expect(queueStatus(f({ run: run("DRAFT"), errorFlaggedAt: new Date() }), "2026-11-06")).toBe("NEEDS_CORRECTION");
    expect(queueStatus(f({ run: run("FULLY_APPROVED") }), "2026-11-06")).toBe("READY_TO_PROCESS");
    expect(queueStatus(f({ run: run("SUBMITTED") }), "2026-11-06")).toBe("SUBMITTED_IN_ADP");
    expect(queueStatus(f({ run: run("PROCESSED") }), "2026-11-06")).toBe("PROCESSED");
    expect(queueStatus(f({ run: run("SUBMITTED"), processedAt: new Date() }), "2026-11-06")).toBe("PROCESSED");
    expect(queueStatus(f({ run: run("DISCARDED") }), "2026-11-01")).toBe("UPCOMING");
  });
  it("flags overdue against the stage's deadline and pins it to the top", () => {
    expect(isOverdue(f(), "WAITING_ON_HOURS", "2026-11-09")).toBe(false);
    expect(isOverdue(f(), "WAITING_ON_HOURS", "2026-11-10")).toBe(true);
    expect(isOverdue(f(), "READY_TO_PROCESS", "2026-11-11")).toBe(true);
    expect(isOverdue(f(), "SUBMITTED_IN_ADP", "2026-12-01")).toBe(false);
    const rows = sortQueue([toQueueRow(f({ payDate: "2026-11-20", hoursDueDate: "2026-11-16" }), "2026-11-10", "later"), toQueueRow(f(), "2026-11-10", "late")]);
    expect(rows[0]).toMatchObject({ data: "late", overdue: true, status: "WAITING_ON_HOURS" });
  });
  it("reminder plans are cleaned against the known steps", () => {
    expect(normalizePlan(null)).toEqual(DEFAULT_PLAN);
    const p = normalizePlan([{ key: "HOURS_FOLLOWUP", enabled: false, hoursBefore: 9999, channels: ["EMAIL", "FAX"] }, { key: "NOPE" }]);
    expect(p.find((s) => s.key === "HOURS_FOLLOWUP")).toEqual({ key: "HOURS_FOLLOWUP", enabled: false, hoursBefore: 24, channels: ["EMAIL"] });
    expect(p).toHaveLength(DEFAULT_PLAN.length);
  });
});
