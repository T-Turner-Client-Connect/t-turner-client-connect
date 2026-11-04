import { beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { makeUser, managed, prisma, resetDb } from "./db";
import { ForbiddenError } from "@/lib/auth/actor";
import { createClient } from "@/lib/services/clients";
import { saveProfile } from "@/lib/services/bookkeeping-clients";
import { closeBooksThrough, setupLedger } from "@/lib/services/ledger";
import { businessOverview } from "@/lib/services/business-overview";
import { createRunsFromPayDates, editPayrollRun, importPayrollRegister, loadRun, payrollSchedule, postPayrollRun, previewPayrollImport, savePayrollSetup } from "@/lib/services/payroll";
import { submitPayrollRun } from "@/lib/services/payroll-approval";
import { readRegister } from "@/lib/payroll/register";
import { connectionStatus } from "@/lib/payroll/providers";
import { parseCsv } from "@/lib/services/ledger";

// Fictional businesses, people and figures only (tests/fixtures/payroll).
const bytes = (f: string) => new Uint8Array(readFileSync(path.join(import.meta.dirname, "fixtures/payroll", f)));

async function setup() {
  await resetDb();
  const tabitha = await makeUser("ADMIN", "Tabitha");
  await prisma.ownerAccess.create({ data: { userId: tabitha.id, isPrimary: true, scope: "FULL" } });
  const daria = await makeUser("STAFF", "Daria");
  const other = await makeUser("STAFF", "Omar");
  const biz = await createClient(tabitha, { businessName: "Pretend Lakeside Bakery LLC", clientType: "BUSINESS", status: "ACTIVE" });
  const biz2 = await createClient(tabitha, { businessName: "Pretend Hilltop Garage LLC", clientType: "BUSINESS", status: "ACTIVE" });
  await managed(biz.id, biz2.id);
  for (const c of [biz, biz2]) {
    await saveProfile(tabitha, c.id, { active: true, frequency: "MONTHLY", payroll: true, payrollFrequency: "BIWEEKLY", payrollProvider: "ADP" });
    await setupLedger(tabitha, c.id, { basis: "CASH" });
  }
  await prisma.client.update({ where: { id: biz.id }, data: { assignedToId: daria.id } });
  await prisma.client.update({ where: { id: biz2.id }, data: { assignedToId: other.id } });
  return { tabitha, daria, other, biz, biz2 };
}

const importAdp = (actor: Awaited<ReturnType<typeof makeUser>>, clientId: string, alreadyProcessed = true) =>
  importPayrollRegister(actor, clientId, { bytes: bytes("adp-run-register.csv"), fileName: "adp-run-register.csv", preset: "ADP_RUN", alreadyProcessed });

let s: Awaited<ReturnType<typeof setup>>;
beforeEach(async () => {
  s = await setup();
});

describe("payroll provider setup", () => {
  it("extends the existing profile fields (provider, frequency, connection, accountant access) and is audited", async () => {
    await savePayrollSetup(s.daria, s.biz.id, { system: "ADP_RUN", frequency: "BIWEEKLY", connection: "REPORT_IMPORT", accessStatus: "ACCOUNTANT_ACCESS" });
    const p = await prisma.bookkeepingProfile.findUniqueOrThrow({ where: { clientId: s.biz.id } });
    expect(p).toMatchObject({ payrollSystem: "ADP_RUN", payrollProvider: "ADP RUN", payrollFrequency: "BIWEEKLY", payrollConnection: "REPORT_IMPORT", payrollAccessStatus: "ACCOUNTANT_ACCESS" });
    expect(await prisma.auditLog.count({ where: { action: "payroll.setup_saved", clientId: s.biz.id } })).toBe(1);
    await expect(savePayrollSetup(s.daria, s.biz.id, { system: "QUICKPAY" })).rejects.toThrow(/payroll system/);
  });

  it("the API connection stays off until credentials exist, and says what's needed", async () => {
    delete process.env.ADP_CLIENT_ID;
    expect(connectionStatus("ADP_RUN", null).label).toMatch(/Not connected — requires ADP partner approval/);
    expect(connectionStatus("PAYCHEX_FLEX", null).label).toMatch(/requires Paychex partner approval/);
    expect(connectionStatus("GUSTO", null).available).toBe(false);
  });
});

describe("payroll register import", () => {
  it("previews totals per pay date without saving anything", async () => {
    const p = await previewPayrollImport(s.daria, s.biz.id, { bytes: bytes("paychex-flex-journal.csv"), fileName: "paychex-flex-journal.csv", preset: "PAYCHEX_FLEX" });
    expect(p.error).toBeNull();
    expect(p.payDates.map((d) => [d.checkDate, d.grossCents, d.differenceCents, d.duplicate])).toEqual([["2026-10-02", 421250, 0, false], ["2026-10-16", 421250, 0, false]]);
    expect(await prisma.payrollRun.count()).toBe(0);
    expect(await prisma.document.count()).toBe(0);
  });

  it("reads Excel (.xlsx) registers too", async () => {
    const p = await previewPayrollImport(s.daria, s.biz.id, { bytes: bytes("adp-wfn-register.xlsx"), fileName: "adp-wfn-register.xlsx", preset: "ADP_WFN" });
    const csv = readRegister(parseCsv(readFileSync(path.join(import.meta.dirname, "fixtures/payroll/adp-wfn-register.csv"), "utf8")), { preset: "ADP_WFN" });
    expect(p.payDates[0]).toMatchObject({ checkDate: "2026-10-16", grossCents: csv.payDates[0].grossCents, netPayCents: csv.payDates[0].netPayCents, differenceCents: 0 });
  });

  it("creates a pay run per date, keeps the file as a PAYROLL_REPORT document and marks Payroll reports received", async () => {
    const r = await importAdp(s.daria, s.biz.id, false);
    expect(r.created).toHaveLength(2);
    const runs = await prisma.payrollRun.findMany({ where: { clientId: s.biz.id }, orderBy: { checkDate: "asc" } });
    expect(runs.map((x) => [x.status, x.provider, x.origin])).toEqual([["DRAFT", "ADP_RUN", "IMPORT"], ["DRAFT", "ADP_RUN", "IMPORT"]]);
    const doc = await prisma.document.findUniqueOrThrow({ where: { id: r.documentId }, include: { file: true } });
    expect(doc).toMatchObject({ clientId: s.biz.id, docType: "PAYROLL_REPORT", category: "BOOKKEEPING", visibility: "STAFF_ONLY" });
    expect(doc.file.mimeType).toBe("text/csv");
    const item = await prisma.bookkeepingChecklistItem.findFirstOrThrow({ where: { key: "PAYROLL_REPORTS", period: { clientId: s.biz.id, year: 2026, month: 10 } } });
    expect(item.status).toBe("DONE");
    // Nothing is posted automatically: no journal entries from an import.
    expect(await prisma.journalEntry.count({ where: { clientId: s.biz.id, source: "PAYROLL" } })).toBe(0);
  });

  it("re-importing the same register never doubles up (provider + check date + totals)", async () => {
    await importAdp(s.daria, s.biz.id);
    const again = await importAdp(s.daria, s.biz.id);
    expect(again.created).toHaveLength(0);
    expect(again.duplicates).toEqual(["2026-10-09", "2026-10-23"]);
    expect(await prisma.payrollRun.count({ where: { clientId: s.biz.id } })).toBe(2);
    expect(await prisma.document.count({ where: { clientId: s.biz.id, docType: "PAYROLL_REPORT" } })).toBe(1);
    const preview = await previewPayrollImport(s.daria, s.biz.id, { bytes: bytes("adp-run-register.csv"), fileName: "adp-run-register.csv", preset: "ADP_RUN" });
    expect(preview.payDates.every((d) => d.duplicate)).toBe(true);
  });

  it("a pay date that doesn't tie out is reported and not created", async () => {
    const csv = "Check Date,Gross Pay,Federal Income Tax,Net Pay\n10/30/2026,1000.00,100.00,800.00\n";
    const r = await importPayrollRegister(s.daria, s.biz.id, { bytes: new TextEncoder().encode(csv), fileName: "off.csv", preset: "OTHER" });
    expect(r.created).toHaveLength(0);
    expect(r.unbalanced).toEqual([{ checkDate: "2026-10-30", differenceCents: 10000 }]);
  });

  it("client isolation: staff not assigned to a business can't import or post there, and runs never cross clients", async () => {
    await expect(importAdp(s.other, s.biz.id)).rejects.toBeInstanceOf(ForbiddenError);
    const r = await importAdp(s.daria, s.biz.id);
    await expect(postPayrollRun(s.other, s.biz.id, r.created[0])).rejects.toBeInstanceOf(ForbiddenError);
    // The same run id under another client is simply not found.
    await expect(postPayrollRun(s.other, s.biz2.id, r.created[0])).rejects.toThrow(/not found/);
    await expect(loadRun(s.biz2.id, r.created[0])).rejects.toThrow(/not found/);
    // The other business importing the same file gets its own runs.
    const r2 = await importAdp(s.other, s.biz2.id);
    expect(r2.created).toHaveLength(2);
  });
});

describe("posting the draft payroll journal entry", () => {
  it("assigned staff post it (normal bookkeeping work); it balances; Record payroll is done when the month's runs are posted", async () => {
    const r = await importAdp(s.daria, s.biz.id);
    const e1 = await postPayrollRun(s.daria, s.biz.id, r.created[0]);
    const lines = await prisma.journalLine.findMany({ where: { entryId: e1.id }, include: { account: true } });
    const dr = lines.reduce((n, l) => n + l.debitCents, 0);
    const cr = lines.reduce((n, l) => n + l.creditCents, 0);
    expect(dr).toBe(cr);
    const { version } = await loadRun(s.biz.id, r.created[0]);
    expect(lines.find((l) => l.account.code === "7010")!.debitCents).toBe(version.grossCents);
    expect(lines.filter((l) => l.account.code === "1000").reduce((n, l) => n + l.creditCents, 0)).toBe(version.netPayCents);
    expect(lines.filter((l) => l.account.code === "2210").reduce((n, l) => n + l.creditCents, 0)).toBe(version.deductionsCents);
    expect(await prisma.ledgerAccount.count({ where: { clientId: s.biz.id, code: { in: ["7010", "7020", "2200", "2210"] } } })).toBe(4);
    const entries = () => prisma.bookkeepingChecklistItem.findFirstOrThrow({ where: { key: "PAYROLL_ENTRIES", period: { clientId: s.biz.id, year: 2026, month: 10 } } });
    expect((await entries()).status).toBe("OPEN");
    await postPayrollRun(s.daria, s.biz.id, r.created[1]);
    expect((await entries()).status).toBe("DONE");
    await expect(postPayrollRun(s.daria, s.biz.id, r.created[1])).rejects.toThrow(/already posted/);
  });

  it("only processed payroll is booked: a draft waiting for approval/submission can't be posted", async () => {
    const r = await importAdp(s.daria, s.biz.id, false);
    await expect(postPayrollRun(s.daria, s.biz.id, r.created[0])).rejects.toThrow(/after it's submitted/);
    await submitPayrollRun(s.daria, s.biz.id, r.created[0]); // no approvers designated for this business
    await postPayrollRun(s.daria, s.biz.id, r.created[0]);
  });

  it("a closed period blocks posting", async () => {
    const r = await importAdp(s.daria, s.biz.id);
    await closeBooksThrough(s.tabitha, s.biz.id, "2026-10-15");
    await expect(postPayrollRun(s.daria, s.biz.id, r.created[0])).rejects.toThrow(/closed through 2026-10-15/);
    await postPayrollRun(s.daria, s.biz.id, r.created[1]); // Oct 23 is still open
  });

  it("a Coetha-prepared run is finalized only by Tabitha", async () => {
    const pd = readRegister(parseCsv(readFileSync(path.join(import.meta.dirname, "fixtures/payroll/adp-wfn-register.csv"), "utf8"))).payDates;
    const res = await prisma.$transaction((tx) => createRunsFromPayDates(tx, s.daria, s.biz.id, { provider: "ADP_WFN", origin: "COETHA", payDates: pd, alreadyProcessed: true }));
    await expect(postPayrollRun(s.daria, s.biz.id, res.created[0])).rejects.toThrow(/Only Tabitha/);
    await postPayrollRun(s.tabitha, s.biz.id, res.created[0]);
  });

  it("staff edits make a new version; a processed run is locked", async () => {
    const r = await importAdp(s.daria, s.biz.id, false);
    const { version } = await loadRun(s.biz.id, r.created[0]);
    const lines = version.lines.map((l) => ({ ...l }));
    lines[0].hoursHundredths += 100;
    const v2 = await editPayrollRun(s.daria, s.biz.id, r.created[0], { lines, reason: "Ana's hours corrected" });
    expect(v2.number).toBe(2);
    expect(await prisma.payrollRunVersion.count({ where: { runId: r.created[0] } })).toBe(2);
    lines[0].grossCents += 100; // now doesn't tie out
    await expect(editPayrollRun(s.daria, s.biz.id, r.created[0], { lines, reason: "x".repeat(5) })).rejects.toThrow(/must equal net pay/);
    const processed = await importPayrollRegister(s.daria, s.biz.id, { bytes: bytes("paychex-flex-journal.csv"), fileName: "p.csv", preset: "PAYCHEX_FLEX", alreadyProcessed: true });
    const pv = await loadRun(s.biz.id, processed.created[0]);
    await expect(editPayrollRun(s.daria, s.biz.id, processed.created[0], { lines: pv.version.lines, reason: "try" })).rejects.toThrow(/locked/);
  });
});

describe("pay history and next pay date come from imported data", () => {
  it("Payroll page schedule and the Client Overview Payroll card", async () => {
    await importAdp(s.daria, s.biz.id);
    const sch = await payrollSchedule(s.biz.id, "2026-11-04");
    expect(sch).toMatchObject({ last: "2026-10-23", next: "2026-11-06", fromImports: true });
    const o = await businessOverview(s.tabitha, s.biz.id);
    expect(o.payroll?.last?.date).toBe("2026-10-23");
    expect(o.payroll?.last?.grossCents).toBe(741250 + 30000);
  });
});
