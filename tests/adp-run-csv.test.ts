import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Papa from "papaparse";
import { makeUser, managed, prisma, resetDb } from "./db";
import { ForbiddenError } from "@/lib/auth/actor";
import { setStaffPermissions } from "@/lib/auth/permissions";
import { createClient } from "@/lib/services/clients";
import { saveProfile } from "@/lib/services/bookkeeping-clients";
import { savePayrollSetup } from "@/lib/services/payroll";
import { recordHoursByStaff, saveSchedule, type ScheduleInput } from "@/lib/services/payroll-taxes";
import {
  adpSetupPage, applyIdentifierList, confirmTimeSheetFeature, createTestFile, cycleAdpStatus, generateCycleFile, importEarningsReport, importEmployeeReport, markFileImported, previewIdentifierList,
  readAdpFile, recordTestVerified, saveAdpIdentifiers, saveEmployeeMap, setEarningsCodes, uploadAdpTemplate,
} from "@/lib/services/adp-run";
import { EMPLOYEE_ID_TITLES, FILE_IDENTIFIER, buildAdpCsv, checkTemplate, parseEarningsReport, parseEmployeeReport, verifyAdpCsv, type BuildInput } from "@/lib/payroll/adp-run-csv";

// Fictional businesses, people, company codes and employee IDs only. No network: nothing reaches ADP.
const NOW = new Date("2026-11-05T18:00:00Z");
const enc = (s: string) => new TextEncoder().encode(s);
const TEMPLATE = `${FILE_IDENTIFIER}\r\n${EMPLOYEE_ID_TITLES.join(",")}\r\n`;
const EMPLOYEE_REPORT = [
  "Employee Codes Report,,,",
  "Company: FICTIONAL,,,",
  "Employee ID,Name,Pay Frequency,Status",
  "101,\"Fictional, Ava\",Weekly,Active",
  "102,Ben Fictional,Weekly,Active",
  "103,Cal Fictional,Weekly,Terminated",
].join("\r\n");
const EARNINGS_REPORT = "Earnings Codes Report\r\nCode,Description\r\nREG,Regular\r\nOT,Overtime\r\nBONUS,Bonus\r\n";
const rows = (csv: string) => Papa.parse<string[]>(csv, { skipEmptyLines: true }).data as string[][];

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  await resetDb();
  vi.stubGlobal("fetch", vi.fn(async (url: string) => { throw new Error(`Unexpected network call: ${url}`); }));
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const WEEKLY: ScheduleInput = { frequency: "WEEKLY", anchorPayDate: "2026-11-06", periodEndLagDays: 5, hoursRequestLeadDays: 5, hoursDueDays: 3, approvalDueDays: 2, adpCutoffDays: 2, active: true, clientRemindersEnabled: false };

async function setup() {
  const tabitha = await makeUser("ADMIN", "Tabitha");
  await prisma.ownerAccess.create({ data: { userId: tabitha.id, isPrimary: true, scope: "FULL" } });
  const mom = await makeUser("STAFF", "Payroll Fictional");
  const vera = await makeUser("STAFF", "Vera Fictional");
  await setStaffPermissions(tabitha, mom.id, ["payroll_taxes.view", "payroll_taxes.manage"]);
  await setStaffPermissions(tabitha, vera.id, ["payroll_taxes.view"]);
  const bakery = await createClient(tabitha, { businessName: "Magnolia Bakery Co. (FICTIONAL)", clientType: "BUSINESS", status: "ACTIVE" });
  const auto = await createClient(tabitha, { businessName: "Red Mountain Auto Detailing (FICTIONAL)", clientType: "BUSINESS", status: "ACTIVE" });
  for (const c of [bakery, auto]) {
    await managed(c.id);
    await saveProfile(tabitha, c.id, { active: true, frequency: "MONTHLY", payroll: true, payrollFrequency: "WEEKLY", payrollProvider: "ADP" });
    await savePayrollSetup(tabitha, c.id, { system: "ADP_RUN", frequency: "WEEKLY" });
    await saveSchedule(tabitha, c.id, WEEKLY);
    // The payroll preparer is assigned to these two fictional businesses.
    await prisma.payrollSchedule.update({ where: { clientId: c.id }, data: { assignedStaffId: mom.id } });
  }
  return { tabitha, mom, vera, bakery, auto };
}

/** The one-time setup for the fictional bakery (ZZ + FIC → company code ZZFIC). */
async function fullSetup(mom: Awaited<ReturnType<typeof setup>>["mom"], clientId: string) {
  await saveAdpIdentifiers(mom, clientId, { acClientId: "90000001", branch: "ZZ", code: "FIC", form: "BRANCH_CODE" });
  await confirmTimeSheetFeature(mom, clientId, true);
  await uploadAdpTemplate(mom, clientId, enc(TEMPLATE));
  await importEmployeeReport(mom, clientId, enc(EMPLOYEE_REPORT));
  await importEarningsReport(mom, clientId, enc(EARNINGS_REPORT));
  await setEarningsCodes(mom, clientId, { codes: { REGULAR: "REG", OVERTIME: "OT" }, usesDepartments: false });
}

const firstCycle = (clientId: string) => prisma.payrollCycle.findFirstOrThrow({ where: { clientId }, orderBy: { payDate: "asc" } });

describe("ADP's Time Sheet Import layout (pure)", () => {
  const input = (over: Partial<BuildInput> = {}): BuildInput => ({
    clientId: "c1", setupClientId: "c1", companyCode: "ZZFIC", identifierType: "EMPLOYEE_ID", templateTitles: [...EMPLOYEE_ID_TITLES], templateVersion: FILE_IDENTIFIER, frequency: "BIWEEKLY", setupFrequency: "B",
    periodStart: "2026-11-02", periodEnd: "2026-11-15",
    hours: [{ name: "Ava Fictional", regularHours: 80, overtimeHours: 4.5 }, { name: "ben  fictional", regularHours: 72.25, overtimeHours: 0 }],
    employees: [{ name: "Ava Fictional", adpEmployeeId: "101", active: true, departmentCode: null, rateCode: "BASE" }, { name: "Ben Fictional", adpEmployeeId: "102", active: true, departmentCode: "100", rateCode: "RATE_2" }],
    employeeClientIds: ["c1", "c1"],
    earnings: { REGULAR: "REG", OVERTIME: "OT" },
    ...over,
  });

  it("writes the version row, ADP's 11 titles and one row per employee per earnings code", () => {
    const r = buildAdpCsv(input());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const t = rows(r.csv);
    expect(t[0]).toEqual(["##GENERIC## V1.0"]);
    expect(t[1]).toEqual([...EMPLOYEE_ID_TITLES]);
    expect(t.slice(2)).toEqual([
      ["ZZFIC", "B", "11/02/2026", "11/15/2026", "101", "REG", "80.00", "", "0", "", "BASE"],
      ["ZZFIC", "B", "11/02/2026", "11/15/2026", "101", "OT", "4.50", "", "0", "", "BASE"],
      ["ZZFIC", "B", "11/02/2026", "11/15/2026", "102", "REG", "72.25", "", "0", "100", "RATE_2"],
    ]);
    expect(r.csv.endsWith("\r\n")).toBe(true);
    expect(r).toMatchObject({ rows: 3, employees: 2, hoursHundredths: 15675 });
    expect(verifyAdpCsv(r.csv, { companyCode: "ZZFIC", frequency: "B", periodStart: "2026-11-02", periodEnd: "2026-11-15", employeeIds: ["101", "102"] })).toEqual([]);
    expect(checkTemplate(r.csv)).toMatchObject({ ok: true, identifierType: "EMPLOYEE_ID", companyCodes: ["ZZFIC"] });
  });

  it("refuses anything RUN would reject or that could mix up clients", () => {
    const fail = (over: Partial<BuildInput>) => { const r = buildAdpCsv(input(over)); return r.ok ? "" : r.problems.join(" "); };
    expect(fail({ hours: [{ name: "Dee Unknown", regularHours: 8, overtimeHours: 0 }] })).toMatch(/isn't matched to an ADP employee ID/);
    expect(fail({ employeeClientIds: ["c1", "c2"] })).toMatch(/different business/);
    expect(fail({ setupClientId: "c2" })).toMatch(/different business/);
    expect(fail({ companyCode: "" })).toMatch(/company code/);
    expect(fail({ setupFrequency: "W" })).toMatch(/Biweekly but the ADP setup says Weekly/);
    expect(fail({ templateTitles: ["Company Code"] })).toMatch(/template/);
    expect(fail({ earnings: { REGULAR: "REG" } })).toMatch(/overtime/);
    expect(fail({ employees: [{ name: "Ava Fictional", adpEmployeeId: "101", active: false, departmentCode: null, rateCode: "BASE" }], employeeClientIds: ["c1"], hours: [{ name: "Ava Fictional", regularHours: 8, overtimeHours: 0 }] })).toMatch(/inactive/);
    expect(fail({ employees: [{ name: "Ava Fictional", adpEmployeeId: "101", active: true, departmentCode: null, rateCode: "BASE" }, { name: "Ava F", adpEmployeeId: "101", active: true, departmentCode: null, rateCode: "BASE" }], hours: [{ name: "Ava Fictional", regularHours: 8, overtimeHours: 0 }, { name: "Ava F", regularHours: 8, overtimeHours: 0 }] })).toMatch(/both point to ADP employee 101/);
    expect(fail({ hours: [{ name: "Ava Fictional", regularHours: 0, overtimeHours: 0 }] })).toMatch(/no hours/);
  });

  it("checks a company template and reads RUN's reports by column title", () => {
    expect(checkTemplate("hello\r\nA,B\r\n")).toMatchObject({ ok: false });
    expect(checkTemplate(`${FILE_IDENTIFIER}\r\n${EMPLOYEE_ID_TITLES.join(",")}\r\nAAA,B,,,1,REG,1.00,,0,,BASE\r\nBBB,B,,,2,REG,1.00,,0,,BASE\r\n`)).toMatchObject({ ok: false });
    const e = parseEmployeeReport(EMPLOYEE_REPORT);
    expect(e.employees).toEqual([
      { adpEmployeeId: "101", name: "Ava Fictional", payFrequency: "Weekly", status: "Active" },
      { adpEmployeeId: "102", name: "Ben Fictional", payFrequency: "Weekly", status: "Active" },
      { adpEmployeeId: "103", name: "Cal Fictional", payFrequency: "Weekly", status: "Terminated" },
    ]);
    expect(parseEarningsReport(EARNINGS_REPORT).earnings.map((x) => x.code)).toEqual(["REG", "OT", "BONUS"]);
    expect(parseEmployeeReport("nothing,here\r\n").problems.join(" ")).toMatch(/Employee ID/);
  });
});

describe("one-time setup, Download ADP CSV and safeguards (fictional company)", () => {
  it("full flow: setup checklist → test file → verified → hours entered once → the file RUN imports", async () => {
    const { mom, bakery } = await setup();
    let page = await adpSetupPage(mom, bakery.id);
    expect(page.ready).toBe(false);
    expect(page.checklist.every((c) => !c.done || c.key === "frequency" || c.key === "departments")).toBe(true);

    await fullSetup(mom, bakery.id);
    page = await adpSetupPage(mom, bakery.id);
    expect(page.setupComplete).toBe(true);
    expect(page.ready).toBe(false); // the test import isn't verified yet
    expect(page.setup.employees.map((e) => [e.name, e.adpEmployeeId, e.active])).toEqual([["Ava Fictional", "101", true], ["Ben Fictional", "102", true], ["Cal Fictional", "103", false]]);
    // Identifiers are stored encrypted, never in the clear.
    const raw = await prisma.adpRunSetup.findUniqueOrThrow({ where: { clientId: bakery.id } });
    expect(raw.companyCodeEnc).not.toContain("ZZFIC");
    expect(raw.acClientIdEnc).not.toContain("90000001");
    expect(raw.companyCodeHint).toBe("…FIC");

    // Before the test is verified, live files are refused.
    const cycle = await firstCycle(bakery.id);
    await recordHoursByStaff(mom, cycle.id, { employees: [{ name: "Ava Fictional", regularHours: 40, overtimeHours: 2 }, { name: "Ben Fictional", regularHours: 38.5, overtimeHours: 0 }] });
    await expect(generateCycleFile(mom, cycle.id)).rejects.toThrow(/test import/);

    // Test file: fictional 1.00 hour for each active employee, labelled TEST.
    const test = await createTestFile(mom, bakery.id);
    expect(test.fileName).toMatch(/^TEST-Magnolia-Bakery-Co-FICTIONAL-ADP-Weekly-/);
    await expect(recordTestVerified(mom, bakery.id, "ok")).rejects.toThrow(/Download the test file/);
    const tf = await readAdpFile(mom, test.id);
    expect(rows(tf.csv).slice(2).map((r) => [r[0], r[1], r[4], r[5], r[6]])).toEqual([["ZZFIC", "W", "101", "REG", "1.00"], ["ZZFIC", "W", "102", "REG", "1.00"]]);
    await recordTestVerified(mom, bakery.id, "No errors on Pay Data Approval; file deleted, not approved");
    expect((await adpSetupPage(mom, bakery.id)).ready).toBe(true);

    // Live file: exactly the hours entered once, with this company's code and RUN IDs.
    const status = await cycleAdpStatus(mom, cycle.id);
    expect(status).toMatchObject({ setupReady: true, hoursIn: true, active: null });
    const first = await generateCycleFile(mom, cycle.id);
    expect(first.reused).toBe(false);
    const file = await readAdpFile(mom, first.export.id);
    const body = rows(file.csv);
    expect(body[0]).toEqual(["##GENERIC## V1.0"]);
    const ymd = (d: Date) => d.toISOString().slice(0, 10).replace(/(\d{4})-(\d{2})-(\d{2})/, "$2/$3/$1");
    expect(body.slice(2)).toEqual([
      ["ZZFIC", "W", ymd(cycle.periodStart), ymd(cycle.periodEnd), "101", "REG", "40.00", "", "0", "", "BASE"],
      ["ZZFIC", "W", ymd(cycle.periodStart), ymd(cycle.periodEnd), "101", "OT", "2.00", "", "0", "", "BASE"],
      ["ZZFIC", "W", ymd(cycle.periodStart), ymd(cycle.periodEnd), "102", "REG", "38.50", "", "0", "", "BASE"],
    ]);
    expect(file.fileName).toMatch(/^Magnolia-Bakery-Co-FICTIONAL-ADP-Weekly-\d{8}-\d{8}\.csv$/);

    // Duplicate protection: same hours → the same file; recorded import; changed hours after
    // import need the old RUN file deleted and a reason.
    const again = await generateCycleFile(mom, cycle.id);
    expect(again).toMatchObject({ reused: true });
    expect(again.export.id).toBe(first.export.id);
    await markFileImported(mom, first.export.id);
    await prisma.payrollCycle.update({ where: { id: cycle.id }, data: { hoursSubmission: { noChanges: false, employees: [{ name: "Ava Fictional", regularHours: 40, overtimeHours: 3, notes: "" }, { name: "Ben Fictional", regularHours: 38.5, overtimeHours: 0, notes: "" }], flags: [], notes: "" } } });
    await expect(generateCycleFile(mom, cycle.id)).rejects.toThrow(/delete that pay data file first/);
    const fixed = await generateCycleFile(mom, cycle.id, "Overtime corrected by the client");
    expect(fixed.export.id).not.toBe(first.export.id);
    expect((await prisma.adpRunExport.findUniqueOrThrow({ where: { id: first.export.id } })).status).toBe("REPLACED");
    await expect(readAdpFile(mom, first.export.id)).rejects.toThrow(/replaced/);
    expect(await prisma.adpRunExport.count({ where: { cycleId: cycle.id, status: "ACTIVE" } })).toBe(1);
    // Every step is audited.
    const actions = (await prisma.auditLog.findMany({ where: { clientId: bakery.id, action: { startsWith: "adp_run." } } })).map((a) => a.action);
    expect(actions).toEqual(expect.arrayContaining(["adp_run.identifiers_saved", "adp_run.template_checked", "adp_run.employee_report_imported", "adp_run.test_verified", "adp_run.file_created", "adp_run.file_downloaded", "adp_run.file_imported"]));
  });

  it("an unmatched name blocks the file and says who; adding the mapping once fixes it for good", async () => {
    const { mom, bakery } = await setup();
    await fullSetup(mom, bakery.id);
    await prisma.adpRunSetup.update({ where: { clientId: bakery.id }, data: { testVerifiedAt: new Date(), testVerifiedNote: "fictional" } });
    const cycle = await firstCycle(bakery.id);
    await recordHoursByStaff(mom, cycle.id, { employees: [{ name: "Dee Fictional", regularHours: 10, overtimeHours: 0 }] });
    await expect(generateCycleFile(mom, cycle.id)).rejects.toThrow(/“Dee Fictional” isn't matched/);
    await saveEmployeeMap(mom, bakery.id, null, { name: "Dee Fictional", adpEmployeeId: "104", departmentCode: "", rateCode: "BASE", active: true });
    await expect(saveEmployeeMap(mom, bakery.id, null, { name: "Someone Else", adpEmployeeId: "104", departmentCode: "", rateCode: "BASE", active: true })).rejects.toThrow(/already has that name or RUN employee ID/);
    const r = await generateCycleFile(mom, cycle.id);
    expect(rows((await readAdpFile(mom, r.export.id)).csv).slice(2).map((x) => x[4])).toEqual(["104"]);
  });

  it("keeps businesses apart: no shared company codes, mappings or files across clients; View can't download", async () => {
    const { mom, vera, bakery, auto } = await setup();
    await fullSetup(mom, bakery.id);
    // The same ADP company can't be set up on a second business.
    await expect(saveAdpIdentifiers(mom, auto.id, { acClientId: "90000002", branch: "ZZ", code: "FIC", form: "BRANCH_CODE" })).rejects.toThrow(/already set up for a different business/);
    // The auto shop's hours name one of the bakery's employees: the bakery's mapping is never used.
    await saveAdpIdentifiers(mom, auto.id, { acClientId: "90000002", branch: "ZZ", code: "AUT", form: "BRANCH_CODE" });
    await confirmTimeSheetFeature(mom, auto.id, true);
    await uploadAdpTemplate(mom, auto.id, enc(TEMPLATE));
    await importEarningsReport(mom, auto.id, enc(EARNINGS_REPORT));
    await setEarningsCodes(mom, auto.id, { codes: { REGULAR: "REG", OVERTIME: "OT" }, usesDepartments: false });
    await saveEmployeeMap(mom, auto.id, null, { name: "Eli Fictional", adpEmployeeId: "7", departmentCode: "", rateCode: "BASE", active: true });
    await prisma.adpRunSetup.update({ where: { clientId: auto.id }, data: { testVerifiedAt: new Date(), testVerifiedNote: "fictional" } });
    const autoCycle = await firstCycle(auto.id);
    await recordHoursByStaff(mom, autoCycle.id, { employees: [{ name: "Ava Fictional", regularHours: 5, overtimeHours: 0 }] });
    await expect(generateCycleFile(mom, autoCycle.id)).rejects.toThrow(/“Ava Fictional” isn't matched/);
    // A template from another company is refused.
    await expect(uploadAdpTemplate(mom, auto.id, enc(`${TEMPLATE}ZZFIC,W,11/02/2026,11/08/2026,101,REG,1.00,,0,,BASE\r\n`))).rejects.toThrow(/doesn't match this business's ADP company/);
    // Editing another client's mapping from this client's page is refused.
    const avaMap = await prisma.adpRunEmployeeMap.findFirstOrThrow({ where: { clientId: bakery.id, adpEmployeeId: "101" } });
    await expect(saveEmployeeMap(mom, auto.id, avaMap.id, { name: "Ava Fictional", adpEmployeeId: "101", departmentCode: "", rateCode: "BASE", active: true })).rejects.toThrow(ForbiddenError);
    // View-only staff can see the setup but can't change it or download files.
    await expect(adpSetupPage(vera, bakery.id)).rejects.toThrow(ForbiddenError); // not assigned to Vera
    await prisma.client.update({ where: { id: bakery.id }, data: { assignedToId: vera.id } });
    expect((await adpSetupPage(vera, bakery.id)).canManage).toBe(false);
    await expect(confirmTimeSheetFeature(vera, bakery.id, false)).rejects.toThrow(/only the owner or staff she allows/);
    const test = await createTestFile(mom, bakery.id);
    await expect(readAdpFile(vera, test.id)).rejects.toThrow();
  });

  it("“No changes” needs no file, and Excel files get clear instructions", async () => {
    const { mom, bakery } = await setup();
    await fullSetup(mom, bakery.id);
    await prisma.adpRunSetup.update({ where: { clientId: bakery.id }, data: { testVerifiedAt: new Date(), testVerifiedNote: "fictional" } });
    const cycle = await firstCycle(bakery.id);
    await recordHoursByStaff(mom, cycle.id, { noChanges: true });
    expect(await cycleAdpStatus(mom, cycle.id)).toMatchObject({ noChanges: true });
    await expect(generateCycleFile(mom, cycle.id)).rejects.toThrow(/no file is needed/);
    await expect(importEmployeeReport(mom, bakery.id, new Uint8Array([0x50, 0x4b, 3, 4, 0, 0]))).rejects.toThrow(/Save As > CSV/);
  });

  it("one-time identifier list: preview first, exact-name matching only, then saved encrypted", async () => {
    const { mom, bakery, auto } = await setup();
    const list = "Business, ADP Client ID, Branch, Code\nMagnolia Bakery Co. (FICTIONAL), 90000001, ZZ, FIC\nRed Mountain Auto Detailing (FICTIONAL)\t90000002\tZZ\tAUT\nUnknown Shop (FICTIONAL), 90000003, ZZ, UNK\nMagnolia Bakery Co. (FICTIONAL), 9000, ZZ,";
    const preview = await previewIdentifierList(mom, list);
    expect(preview.map((r) => [r.business, r.clientId, !!r.problem])).toEqual([
      ["Magnolia Bakery Co. (FICTIONAL)", bakery.id, false],
      ["Red Mountain Auto Detailing (FICTIONAL)", auto.id, false],
      ["Unknown Shop (FICTIONAL)", null, true],
      ["Magnolia Bakery Co. (FICTIONAL)", bakery.id, true],
    ]);
    expect(await prisma.adpRunSetup.count({ where: { companyCodeEnc: { not: null } } })).toBe(0); // preview saved nothing
    const r = await applyIdentifierList(mom, list);
    expect(r.saved).toBe(2);
    expect((await adpSetupPage(mom, auto.id)).setup.companyCodeHint).toBe("…AUT");
  });
});

describe("other pay: vacation, sick, holiday, bonus, commission, tips (fictional)", () => {
  it("pure: hours kinds go in Pay Hours, amounts in Dollars, each with the company's own code; unmapped kinds can't transfer", () => {
    const base: BuildInput = {
      clientId: "c1", setupClientId: "c1", companyCode: "ZZFIC", identifierType: "EMPLOYEE_ID", templateTitles: [...EMPLOYEE_ID_TITLES], templateVersion: FILE_IDENTIFIER, frequency: "WEEKLY", setupFrequency: "W",
      periodStart: "2026-11-02", periodEnd: "2026-11-08",
      hours: [{ name: "Ava Fictional", regularHours: 32, overtimeHours: 0, pay: { VACATION: 8, BONUS: 250, CHARGED_TIPS: 112.4, COMMISSION: 75.5 } }],
      employees: [{ name: "Ava Fictional", adpEmployeeId: "101", active: true, departmentCode: null, rateCode: "BASE" }],
      employeeClientIds: ["c1"],
      earnings: { REGULAR: "REG", VACATION: "VAC", BONUS: "BON", CHARGED_TIPS: "CTIPS", COMMISSION: "COM" },
    };
    const r = buildAdpCsv(base);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(rows(r.csv).slice(2).map((x) => [x[4], x[5], x[6], x[7]])).toEqual([
      ["101", "REG", "32.00", ""],
      ["101", "VAC", "8.00", ""],
      ["101", "BON", "", "250.00"],
      ["101", "COM", "", "75.50"],
      ["101", "CTIPS", "", "112.40"],
    ]);
    expect(r).toMatchObject({ hoursHundredths: 4000, dollarsCents: 43790 });
    expect(verifyAdpCsv(r.csv, { companyCode: "ZZFIC", frequency: "W", periodStart: "2026-11-02", periodEnd: "2026-11-08", employeeIds: ["101"] })).toEqual([]);
    // Cash tips with no code for this company: reported, and nothing is built.
    const bad = buildAdpCsv({ ...base, hours: [{ ...base.hours[0], pay: { ...base.hours[0].pay, CASH_TIPS: 40 } }] });
    expect(bad.ok).toBe(false);
    if (bad.ok) return;
    expect(bad.cannotTransfer).toHaveLength(1);
    expect(bad.cannotTransfer[0]).toMatch(/Cash tips for “Ava Fictional” \(\$40\.00\): this company has no ADP earnings code/);
  });

  it("entered once with the hours, mapped once per company, checked before download", async () => {
    const { mom, bakery } = await setup();
    await fullSetup(mom, bakery.id);
    await prisma.adpRunSetup.update({ where: { clientId: bakery.id }, data: { testVerifiedAt: new Date(), testVerifiedNote: "fictional" } });
    // Out-of-range pay is refused at entry.
    const cycle = await firstCycle(bakery.id);
    await expect(recordHoursByStaff(mom, cycle.id, { employees: [{ name: "Ava Fictional", regularHours: 10, pay: { VACATION: 500 } }] })).rejects.toThrow(/Vacation must be a number of hours/);
    await expect(recordHoursByStaff(mom, cycle.id, { employees: [{ name: "Ava Fictional", regularHours: 10, pay: { BONUS: -5 } }] })).rejects.toThrow(/Bonus must be an amount/);
    await recordHoursByStaff(mom, cycle.id, { employees: [{ name: "Ava Fictional", regularHours: 30, overtimeHours: 0, pay: { HOLIDAY: "8", BONUS: "$1,000.00", CASH_TIPS: "55" } }, { name: "Ben Fictional", regularHours: 40, overtimeHours: 1 }] });
    // Holiday and cash tips have no code yet: the check lists them, and download is refused.
    let st = await cycleAdpStatus(mom, cycle.id);
    expect(st.check?.ok).toBe(false);
    expect(st.check?.cannotTransfer.join(" ")).toMatch(/Holiday hours for “Ava Fictional”.*Cash tips for “Ava Fictional”/);
    expect(st.unmapped).toEqual(expect.arrayContaining(["Holiday hours", "Cash tips", "Bonus"]));
    await expect(generateCycleFile(mom, cycle.id)).rejects.toThrow(/Can't transfer/);
    // The codes must exist in this company's Earnings Codes Report.
    await expect(setEarningsCodes(mom, bakery.id, { codes: { REGULAR: "REG", HOLIDAY: "HOL" }, usesDepartments: false })).rejects.toThrow(/HOL isn't in this company's Earnings Codes Report/);
    await importEarningsReport(mom, bakery.id, enc("Code,Description\r\nREG,Regular\r\nOT,Overtime\r\nHOL,Holiday\r\nBONUS,Bonus\r\nCTIP,Cash Tips\r\n"));
    expect((await adpSetupPage(mom, bakery.id)).setup.earningsMap).toMatchObject({ REGULAR: "REG", OVERTIME: "OT" }); // kept
    await setEarningsCodes(mom, bakery.id, { codes: { REGULAR: "REG", OVERTIME: "OT", HOLIDAY: "HOL", BONUS: "BONUS", CASH_TIPS: "CTIP" }, usesDepartments: false });
    st = await cycleAdpStatus(mom, cycle.id);
    expect(st.check?.ok).toBe(true);
    expect(st.check?.lines.map((l) => [l.name, l.label, l.code, l.amount])).toEqual([
      ["Ava Fictional", "Regular hours", "REG", "30.00 hrs"],
      ["Ava Fictional", "Holiday hours", "HOL", "8.00 hrs"],
      ["Ava Fictional", "Bonus", "BONUS", "$1000.00"],
      ["Ava Fictional", "Cash tips", "CTIP", "$55.00"],
      ["Ben Fictional", "Regular hours", "REG", "40.00 hrs"],
      ["Ben Fictional", "Overtime hours", "OT", "1.00 hrs"],
    ]);
    const r = await generateCycleFile(mom, cycle.id);
    expect(r.export).toMatchObject({ rows: 6, employees: 2, hoursHundredths: 7900, dollarsCents: 105500 });
    const body = rows((await readAdpFile(mom, r.export.id)).csv).slice(2);
    expect(body.map((x) => [x[4], x[5], x[6], x[7]])).toEqual([
      ["101", "REG", "30.00", ""], ["101", "HOL", "8.00", ""], ["101", "BONUS", "", "1000.00"], ["101", "CTIP", "", "55.00"], ["102", "REG", "40.00", ""], ["102", "OT", "1.00", ""],
    ]);
  });
});

describe("client-specific payroll permissions (ADP setup and files)", () => {
  it("Payroll Manage alone doesn't open every business: only assigned clients, the owner, or an owner-granted All clients", async () => {
    const { tabitha, mom, bakery } = await setup();
    await fullSetup(mom, bakery.id);
    await prisma.adpRunSetup.update({ where: { clientId: bakery.id }, data: { testVerifiedAt: new Date(), testVerifiedNote: "fictional" } });
    const cycle = await firstCycle(bakery.id);
    await recordHoursByStaff(mom, cycle.id, { employees: [{ name: "Ava Fictional", regularHours: 8, overtimeHours: 0 }] });
    const file = await generateCycleFile(mom, cycle.id);

    // A second preparer with Payroll View + Manage, assigned to nothing.
    const other = await makeUser("STAFF", "Other Preparer Fictional");
    await setStaffPermissions(tabitha, other.id, ["payroll_taxes.view", "payroll_taxes.manage"]);
    const denied = [
      () => adpSetupPage(other, bakery.id),
      () => confirmTimeSheetFeature(other, bakery.id, false),
      () => saveEmployeeMap(other, bakery.id, null, { name: "X Fictional", adpEmployeeId: "999", departmentCode: "", rateCode: "BASE", active: true }),
      () => createTestFile(other, bakery.id),
      () => generateCycleFile(other, cycle.id),
      () => readAdpFile(other, file.export.id),
      () => markFileImported(other, file.export.id),
    ];
    for (const call of denied) await expect(call()).rejects.toThrow(ForbiddenError);
    expect(await cycleAdpStatus(other, cycle.id)).toEqual({ allowed: false, clientId: bakery.id });
    expect((await previewIdentifierList(other, "Magnolia Bakery Co. (FICTIONAL), 90000009, ZZ, NEW"))[0].clientId).toBeNull();
    // Nothing was changed by the refused calls.
    expect(await prisma.adpRunEmployeeMap.count({ where: { adpEmployeeId: "999" } })).toBe(0);

    // Assigned to one pay cycle → that business opens (and only it).
    await prisma.payrollCycle.update({ where: { id: cycle.id }, data: { assignedStaffId: other.id } });
    expect((await adpSetupPage(other, bakery.id)).canManage).toBe(true);
    expect((await readAdpFile(other, file.export.id)).csv).toContain("ZZFIC");

    // The owner sees every business; "All clients" is an explicit owner grant.
    const third = await makeUser("STAFF", "Third Preparer Fictional");
    await setStaffPermissions(tabitha, third.id, ["payroll_taxes.view", "payroll_taxes.manage"]);
    await expect(adpSetupPage(third, bakery.id)).rejects.toThrow(ForbiddenError);
    await setStaffPermissions(tabitha, third.id, ["payroll_taxes.view", "payroll_taxes.manage", "payroll_taxes.all_clients"]);
    expect((await adpSetupPage(third, bakery.id)).canManage).toBe(true);
    expect((await adpSetupPage(tabitha, bakery.id)).canManage).toBe(true);
    // No bookkeeping access is granted along the way.
    const { canUseLedger } = await import("@/lib/services/ledger");
    expect(await canUseLedger(other, bakery.id)).toBe(false);
  });
});
