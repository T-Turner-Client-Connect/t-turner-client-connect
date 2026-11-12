import { beforeEach, describe, expect, it } from "vitest";
import { makeUser, managed, prisma, resetDb } from "./db";
import { createClient } from "@/lib/services/clients";
import { saveProfile } from "@/lib/services/bookkeeping-clients";
import { importBankCsv, setupLedger } from "@/lib/services/ledger";
import { registerAccount } from "@/lib/services/bank-accounts";
import { bookkeepingStatus } from "@/lib/services/bookkeeping-status";
import { officeTabs, myOfficeAccess } from "@/lib/auth/owner";

// Fictional businesses, banks and figures only.
beforeEach(async () => {
  await resetDb();
});

async function biz(tabitha: Awaited<ReturnType<typeof makeUser>>, name: string, payroll: boolean) {
  const c = await createClient(tabitha, { businessName: name, clientType: "BUSINESS", status: "ACTIVE" });
  await managed(c.id);
  await saveProfile(tabitha, c.id, { active: true, frequency: "MONTHLY", payroll, ...(payroll ? { payrollFrequency: "BIWEEKLY", payrollProvider: "ADP" } : {}) });
  await setupLedger(tabitha, c.id, { basis: "CASH" });
  const chk = await registerAccount(tabitha, c.id, { institution: "Example Community Bank", accountType: "CHECKING", nickname: "Operating", last4: "1111", gl: "NEW" });
  return { c, chk };
}

async function owner() {
  const tabitha = await makeUser("ADMIN", "Tabitha");
  await prisma.ownerAccess.create({ data: { userId: tabitha.id, isPrimary: true } });
  return tabitha;
}

describe("Bookkeeping Clients Status (Owner's Office → Office Files)", () => {
  it("shows each client's standing from the records: completed month, what's genuinely missing, discrepancies, and an overall status", async () => {
    const tabitha = await owner();
    const a = await biz(tabitha, "Pretend Alpha Bakery LLC", true);
    const b = await biz(tabitha, "Pretend Beta Repair LLC", false);
    const c = await biz(tabitha, "Pretend Gamma Shop LLC", false);
    // Alpha: done outside Client Connect through August; September's statement is imported, October's isn't; no payroll reports.
    for (let m = 1; m <= 8; m++) await prisma.bookkeepingPeriod.create({ data: { clientId: a.c.id, year: 2026, month: m, status: "COMPLETE" } });
    const gl = (await prisma.bookkeepingAccount.findUniqueOrThrow({ where: { id: a.chk.id } })).ledgerAccountId!;
    await importBankCsv(tabitha, a.c.id, gl, { fileName: "sep.csv", text: "Date,Description,Amount\n09/05/2026,FICTIONAL DEPOSIT,100.00\n09/29/2026,FICTIONAL FEE,-5.00" });
    // Beta: completed through October, statements on file, nothing missing.
    for (let m = 1; m <= 10; m++) await prisma.bookkeepingPeriod.create({ data: { clientId: b.c.id, year: 2026, month: m, status: "COMPLETE" } });
    await prisma.coethaReference.create({ data: { clientId: b.c.id, title: "Fictional statements", months: ["2026-01", "2026-10"], lines: [], createdById: tabitha.id } });
    // Gamma: completed through October, but September's reconciliation has an exception.
    for (let m = 1; m <= 10; m++) await prisma.bookkeepingPeriod.create({ data: { clientId: c.c.id, year: 2026, month: m, status: "COMPLETE" } });
    await prisma.coethaReference.create({ data: { clientId: c.c.id, title: "Fictional statements", months: ["2026-01", "2026-10"], lines: [], createdById: tabitha.id } });
    await prisma.accountReconciliation.create({ data: { clientId: c.c.id, bookkeepingAccountId: c.chk.id, year: 2026, month: 9, status: "EXCEPTION", differenceCents: 1250, exceptions: ["Statement ending balance doesn't match the books"] } as never });

    const r = await bookkeepingStatus(tabitha, "2026-11-12");
    expect(r.through).toBe("Oct 2026");
    const alpha = r.clients.find((x) => x.clientId === a.c.id)!;
    expect(alpha).toMatchObject({ completedThrough: "Aug 2026", completedHow: "marked complete", schedule: "Monthly", payroll: "ADP", workingOn: "Sep 2026 – Nov 2026", overall: "Missing Documents" });
    expect(alpha.uploads.map((u) => [u.kind, u.months])).toEqual([
      ["STATEMENTS_PDF", ["Jan 2026 – Aug 2026"]],
      ["BANK", ["Oct 2026"]],
      ["PAYROLL", ["Sep 2026", "Oct 2026"]],
    ]);
    expect(r.clients.find((x) => x.clientId === b.c.id)).toMatchObject({ completedThrough: "Oct 2026", onFile: ["Completed statements Jan 2026 – Oct 2026"], uploads: [], discrepancies: [], overall: "Current" });
    const gamma = r.clients.find((x) => x.clientId === c.c.id)!;
    expect(gamma).toMatchObject({ overall: "Needs Attention", discrepancies: [{ month: "Sep 2026", detail: "Statement ending balance doesn't match the books" }] });
    // Needs Attention first, Current last.
    expect(r.clients.map((x) => x.overall)).toEqual(["Needs Attention", "Missing Documents", "Current"]);
  });

  it("is the owner's alone: staff and other Admins are refused, and the Office Files tab shows only for her", async () => {
    const tabitha = await owner();
    await biz(tabitha, "Pretend Delta Cafe LLC", false);
    const admin = await makeUser("ADMIN", "Other Admin");
    const staff = await makeUser("STAFF", "Drew Example");
    await expect(bookkeepingStatus(admin, "2026-11-12")).rejects.toThrow(/owner's private office/);
    await expect(bookkeepingStatus(staff, "2026-11-12")).rejects.toThrow(/owner's private office/);
    expect(officeTabs(await myOfficeAccess(tabitha.id)).map((t) => t.label)).toContain("Office Files");
    expect(officeTabs(await myOfficeAccess(admin.id)).map((t) => t.label)).not.toContain("Office Files");
  });
});
