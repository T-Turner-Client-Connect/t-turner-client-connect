import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeUser, prisma, resetDb } from "./db";
import { createClient } from "@/lib/services/clients";
import { createFiling, setFilingStatusByStaff } from "@/lib/services/tax";
import {
  correctNonprofitFiling, latestEndedTaxYear, markNonprofitFiled, nonprofitDashboard, nonprofitDueDate, recordNonprofitOutcome, runNonprofitReminders, saveNonprofitProfile,
} from "@/lib/services/nonprofits";
import { setFilingService } from "@/lib/services/nonprofit-links";

beforeEach(async () => {
  await resetDb();
  vi.stubEnv("MALWARE_SCAN_URL", "https://scanner.test/scan");
  vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ clean: true }), { status: 200 }));
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("nonprofit deadlines (IRS: 15th day of the 5th month; next business day; 8868 for 990/EZ/PF only)", () => {
  it("calculates due dates with weekend rollover and fiscal years", () => {
    expect(nonprofitDueDate(2025, 12)).toBe("2026-05-15"); // Friday
    expect(nonprofitDueDate(2025, 6)).toBe("2026-11-16"); // Nov 15, 2026 is a Sunday
    expect(nonprofitDueDate(2025, 12, true)).toBe("2026-11-16"); // extended 6 months, rolled to Monday
    expect([latestEndedTaxYear(12, "2026-10-31"), latestEndedTaxYear(6, "2026-10-31"), latestEndedTaxYear(11, "2026-10-31")]).toEqual([2025, 2025, 2024]);
  });

  it("flags missing fiscal year-end and form instead of assuming; Submitted and Accepted stay separate; 990-N can't be extended; corrections are logged", async () => {
    const tabitha = await makeUser("ADMIN", "Tabitha");
    await prisma.ownerAccess.create({ data: { userId: tabitha.id, isPrimary: true } });
    const daria = await makeUser("STAFF", "Daria");
    const np = await createClient(tabitha, { businessName: "Fictional Food Pantry", clientType: "NONPROFIT", status: "ACTIVE" });
    await prisma.client.update({ where: { id: np.id }, data: { assignedToId: daria.id } });
    await setFilingService(tabitha, np.id, "YES"); // only organizations we file for are tracked and reminded
    const today = "2026-04-15";

    let [row] = await nonprofitDashboard(today);
    expect(row.bucket).toBe("NOT_SET_UP");
    expect(row.missing).toEqual(["Fiscal year-end not recorded", "Required return not chosen"]);
    expect(row.due).toBeNull(); // no December default

    await prisma.client.update({ where: { id: np.id }, data: { fiscalYearEnd: 12 } });
    await expect(saveNonprofitProfile(daria, np.id, { formType: "990-N", formBasis: "" })).rejects.toThrow(/how you determined/);
    await saveNonprofitProfile(daria, np.id, { formType: "990-N", formBasis: "Gross receipts normally under $50,000 (2023–2025 average)", reminderDays: "30, 7" });
    [row] = await nonprofitDashboard(today);
    expect([row.taxYear, row.due, row.days, row.bucket, row.missing]).toEqual([2025, "2026-05-15", 30, "DUE", []]);

    // An accepted 8868 never extends a 990-N.
    const ext = await createFiling(daria, { clientId: np.id, taxYear: 2025, returnType: "8868", jurisdiction: "FEDERAL", filingType: "EXTENSION" });
    await setFilingStatusByStaff(daria, ext.id, { status: "SUBMITTED", eventAt: new Date("2026-04-10T15:00:00Z") });
    await setFilingStatusByStaff(daria, ext.id, { status: "ACCEPTED", eventAt: new Date("2026-04-11T15:00:00Z"), verificationNote: "IRS acknowledgment in TaxAct" });
    [row] = await nonprofitDashboard(today);
    expect([row.extended, row.due]).toEqual([false, "2026-05-15"]);

    // Reminder: a task for the assigned staff member, once.
    expect(await runNonprofitReminders(today)).toEqual({ sent: 1 });
    expect(await runNonprofitReminders(today)).toEqual({ sent: 0 });
    expect(await prisma.task.count({ where: { clientId: np.id, assigneeId: daria.id } })).toBe(1);

    // Mark Filed → Submitted (needs confirmation or acknowledgment); never Accepted by itself.
    await expect(markNonprofitFiled(daria, np.id, 2025, { filedAt: new Date("2026-04-14T15:00:00Z") })).rejects.toThrow(/confirmation/);
    await expect(recordNonprofitOutcome(daria, np.id, 2025, { outcome: "ACCEPTED", at: new Date(), note: "x" })).rejects.toThrow(/Mark it filed/);
    await markNonprofitFiled(daria, np.id, 2025, { filedAt: new Date("2026-04-14T15:00:00Z"), confirmation: "EP-123" });
    [row] = await nonprofitDashboard(today);
    expect([row.bucket, row.filing?.filingStatus, row.filing?.filingReference]).toEqual(["SUBMITTED", "SUBMITTED", "EP-123"]);
    // Accepted only with the acknowledgment or a described verification.
    await expect(recordNonprofitOutcome(daria, np.id, 2025, { outcome: "ACCEPTED", at: new Date("2026-04-15T15:00:00Z") })).rejects.toThrow(/acknowledgment/);
    await recordNonprofitOutcome(daria, np.id, 2025, { outcome: "ACCEPTED", at: new Date("2026-04-15T15:00:00Z"), note: "IRS e-Postcard acceptance email 4/15" });
    [row] = await nonprofitDashboard(today);
    expect(row.bucket).toBe("COMPLETED");

    // A logged correction keeps the history.
    await correctNonprofitFiling(tabitha, np.id, row.filing!.id, { confirmation: "EP-124", reason: "Typo in the confirmation number" });
    const f = await prisma.filingRecord.findUniqueOrThrow({ where: { id: row.filing!.id }, include: { events: true } });
    expect(f.filingReference).toBe("EP-124");
    expect(f.events.map((e) => e.toValue)).toEqual(expect.arrayContaining(["SUBMITTED", "ACCEPTED"]));
    expect(await prisma.auditLog.count({ where: { action: "nonprofit.filing_corrected", entityId: f.id } })).toBe(1);
  });

  it("a rejected return never shows as accepted", async () => {
    const tabitha = await makeUser("ADMIN", "Tabitha");
    const np = await createClient(tabitha, { businessName: "Fictional Youth League", clientType: "NONPROFIT", status: "ACTIVE" });
    await prisma.client.update({ where: { id: np.id }, data: { fiscalYearEnd: 12 } });
    await saveNonprofitProfile(tabitha, np.id, { formType: "990-EZ", formBasis: "Receipts $140k, assets $90k at year end" });
    await markNonprofitFiled(tabitha, np.id, 2025, { filedAt: new Date("2026-05-01T15:00:00Z"), confirmation: "SUB-1" });
    await recordNonprofitOutcome(tabitha, np.id, 2025, { outcome: "REJECTED", at: new Date("2026-05-02T15:00:00Z"), note: "IRS rejection R0000-504", rejectionCodes: "R0000-504" });
    const [row] = await nonprofitDashboard("2026-05-03");
    expect(row.filing?.filingStatus).toBe("REJECTED");
    expect(row.bucket).not.toBe("COMPLETED");
  });

  it("flags records an earlier version made with an assumed December year-end, and sends no reminders until the year-end is recorded", async () => {
    const tabitha = await makeUser("ADMIN", "Tabitha");
    const np = await createClient(tabitha, { businessName: "Fictional Arts Council", clientType: "NONPROFIT", status: "ACTIVE" });
    await saveNonprofitProfile(tabitha, np.id, { formType: "990-EZ", formBasis: "Receipts $120k, assets $60k" });
    // As the earlier version could have: a filing and a reminder based on December.
    await createFiling(tabitha, { clientId: np.id, taxYear: 2025, returnType: "990-EZ", jurisdiction: "FEDERAL", filingType: "ORIGINAL" });
    await prisma.auditLog.create({ data: { action: "nonprofit.reminder", entityType: "Reminder", entityId: `nonprofit-reminder:${np.id}:2025:30`, clientId: np.id } });
    const [row] = await nonprofitDashboard("2026-04-15");
    expect(row.bucket).toBe("NOT_SET_UP");
    expect(row.due).toBeNull();
    expect(row.missing.join(" | ")).toMatch(/Fiscal year-end not recorded/);
    expect(row.missing.join(" | ")).toMatch(/990-EZ 2025\) may use a tax year based on an assumed December year-end/);
    expect(row.missing.join(" | ")).toMatch(/1 reminder was sent using an assumed December deadline/);
    expect(await runNonprofitReminders("2026-04-15")).toEqual({ sent: 0 });
    // Records are flagged, not changed.
    expect(await prisma.filingRecord.count({ where: { clientId: np.id } })).toBe(1);
  });
});
