import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { autoMap, cents, differenceOf, guessPayrollField, parseDate, payrollEntryLines, readRegister, versionHash } from "@/lib/payroll/register";
import { parseCsv } from "@/lib/services/ledger";

// Fictional sample exports shaped like each provider's register / journal (tests/fixtures/payroll).
const fixture = (f: string) => parseCsv(readFileSync(path.join(import.meta.dirname, "fixtures/payroll", f), "utf8"));
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

describe("payroll register presets", () => {
  it("ADP RUN: finds the header under a title row, groups by check date, skips the totals row", () => {
    const r = readRegister(fixture("adp-run-register.csv"), { preset: "ADP_RUN" });
    expect(r.headerRow).toBe(1);
    expect(r.payDates.map((p) => p.checkDate)).toEqual(["2026-10-09", "2026-10-23"]);
    expect(r.skipped.some((s) => /totals row/.test(s))).toBe(true);
    const [first, second] = r.payDates;
    expect(first.employees).toBe(3);
    expect(first.grossCents).toBe(240000 + 181250 + 320000);
    expect(second.grossCents).toBe(first.grossCents + 30000);
    expect(first.federalWhCents).toBe(19200 + 14500 + 25600);
    expect(first.ssEeCents).toBe(14880 + 11238 + 19840);
    expect(first.medicareEeCents).toBe(3480 + 2628 + 4640);
    expect(first.stateWhCents).toBe(9600 + 7250 + 12800);
    expect(first.deductionsCents).toBe(40100 + 16000);
    expect(first.employerTaxCents).toBe(14880 + 3480 + 1440 + 6480 + 11238 + 2628 + 1088 + 4894 + 19840 + 4640 + 1920 + 8640);
    expect(first.hoursHundredths).toBe(8000 + 7250 + 8000);
    for (const p of r.payDates) expect(p.differenceCents).toBe(0);
  });

  it("ADP Workforce Now: sums regular + overtime hours and itemized deductions, local tax as other employee tax", () => {
    const r = readRegister(fixture("adp-wfn-register.csv"), { preset: "ADP_WFN" });
    expect(r.payDates).toHaveLength(1);
    const p = r.payDates[0];
    expect(p.checkDate).toBe("2026-10-16");
    expect(p.hoursHundredths).toBe(8000 + 7250 + 8000);
    expect(p.otherEeTaxCents).toBe(3000);
    expect(p.deductionsCents).toBe(40100 + 16000);
    expect(p.differenceCents).toBe(0);
    expect(r.mapping[1]).toBe(""); // Associate ID ignored
  });

  it("Paychex Flex: withholding exported as negatives is normalized; per-date Totals rows are skipped", () => {
    const r = readRegister(fixture("paychex-flex-journal.csv"), { preset: "PAYCHEX_FLEX" });
    expect(r.payDates.map((p) => p.checkDate)).toEqual(["2026-10-02", "2026-10-16"]);
    const p = r.payDates[0];
    expect(p.employees).toBe(2);
    expect(p.grossCents).toBe(240000 + 181250);
    expect(p.federalWhCents).toBe(19200 + 14500);
    expect(p.deductionsCents).toBe(40100);
    expect(p.netPayCents).toBe(152740 + 145634);
    expect(p.differenceCents).toBe(0);
    expect(r.skipped.filter((s) => /totals row/.test(s))).toHaveLength(2);
  });

  it("manual mapping overrides the preset; an unmapped date column can use the file's check date", () => {
    const grid = [["Who", "Wages", "Withheld", "Take home"], ["Pat (fictional)", "1,000.00", "150.00", "850.00"], ["Lee (fictional)", "500.00", "50.00", "450.00"]];
    expect(() => readRegister(grid)).toThrow(/Gross wages and Net pay/);
    expect(() => readRegister(grid, { mapping: { 0: "employee", 1: "gross", 2: "federalWh", 3: "netPay" } })).toThrow(/check date/i);
    const r = readRegister(grid, { mapping: { 0: "employee", 1: "gross", 2: "federalWh", 3: "netPay" }, defaultCheckDate: "2026-10-30" });
    expect(r.payDates[0]).toMatchObject({ checkDate: "2026-10-30", grossCents: 150000, federalWhCents: 20000, netPayCents: 130000, employees: 2, differenceCents: 0 });
  });

  it("reports a pay date that doesn't tie out instead of fixing it", () => {
    const grid = [["Check Date", "Gross Pay", "Federal Income Tax", "Net Pay"], ["10/30/2026", "1000", "100", "800"]];
    expect(readRegister(grid).payDates[0].differenceCents).toBe(10000);
  });

  it("header guesses: employer vs employee taxes, totals preferred over itemized, rates/YTD ignored", () => {
    expect(guessPayrollField("Social Security - ER")).toBe("employerTax");
    expect(guessPayrollField("Social Security - EE")).toBe("ssEe");
    expect(guessPayrollField("Medicare")).toBe("medicareEe");
    expect(guessPayrollField("Medical")).toBe("deductions");
    expect(guessPayrollField("Pay Rate")).toBe("");
    expect(guessPayrollField("YTD Gross")).toBe("");
    const m = autoMap(["Check Date", "Gross Pay", "401(k)", "Medical", "Total Deductions", "Net Pay"]);
    expect([m[2], m[3], m[4]]).toEqual(["", "", "deductions"]);
  });

  it("cells: money and dates", () => {
    expect(cents("$1,234.56")).toBe(123456);
    expect(cents("(12.00)")).toBe(-1200);
    expect(cents("")).toBe(0);
    expect(cents("abc")).toBeNull();
    expect(parseDate("10/23/26")).toBe("2026-10-23");
    expect(parseDate("2026-02-30")).toBeNull();
    expect(parseDate("46318")).toBe("2026-10-23");
  });
});

describe("draft payroll journal entry", () => {
  it("balances for every sample pay date: Dr wages + employer tax = Cr cash + tax liabilities + deductions", () => {
    const accts = { wages: "W", employerTax: "ET", taxLiability: "TL", deductionsLiability: "DL", cash: "C" };
    for (const f of ["adp-run-register.csv", "adp-wfn-register.csv", "paychex-flex-journal.csv"]) {
      for (const p of readRegister(fixture(f)).payDates) {
        const lines = payrollEntryLines(p, accts);
        expect(sum(lines.map((l) => l.debitCents))).toBe(sum(lines.map((l) => l.creditCents)));
        expect(sum(lines.filter((l) => l.accountId === "C").map((l) => l.creditCents))).toBe(p.netPayCents);
        expect(sum(lines.filter((l) => l.accountId === "W").map((l) => l.debitCents))).toBe(p.grossCents);
        expect(sum(lines.filter((l) => l.accountId === "TL").map((l) => l.creditCents))).toBe(p.federalWhCents + p.ssEeCents + p.medicareEeCents + p.stateWhCents + p.otherEeTaxCents + p.employerTaxCents);
        expect(differenceOf(p)).toBe(0);
      }
    }
  });

  it("the version hash changes with any figure", () => {
    const p = readRegister(fixture("adp-wfn-register.csv")).payDates[0];
    const h = versionHash(p);
    expect(versionHash({ ...p, lines: p.lines.map((l, i) => (i ? l : { ...l, hoursHundredths: l.hoursHundredths + 1 })) })).not.toBe(h);
    expect(versionHash(p)).toBe(h);
  });
});
