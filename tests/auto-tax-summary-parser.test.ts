import { describe, expect, it } from "vitest";
import { form8879Pages, jointCouple, jordan, owes, returnPages, returnPdf, toPdf } from "./fixtures/tax-return-fixture";
import { parseReturnPages, pdfToPages } from "@/lib/tax/return-parser/parse";
import { checkReturn, samePerson, type Expected } from "@/lib/tax/return-parser/checks";
import { buildClientSummary } from "@/lib/tax/return-parser/summary";
import { amountCents, readForm } from "@/lib/tax/return-parser/read-lines";
import { ALABAMA_MEDICAL_FLOOR_BP, FEDERAL_MEDICAL_FLOOR_BP, medicalFloorCents } from "@/lib/tax/return-parser/thresholds";
import { phrase } from "@/lib/tax/return-parser/line-map";

// Every person and number here is fictional (the mockup's Jordan Sample example).
const JORDAN: Expected = { taxYear: 2025, taxpayer: { first: "Jordan", last: "Sample" }, spouse: null };
const pages = (p: string[][]) => p.map((lines, i) => ({ page: i + 1, text: lines.join("\n") }));
const parse = (cfg: Parameters<typeof returnPages>[0]) => parseReturnPages(pages(returnPages(cfg)));
const summaryOf = (cfg: Parameters<typeof returnPages>[0], expected = JORDAN) => {
  const r = checkReturn(parse(cfg), expected);
  expect(r.issues).toEqual([]);
  const f = r.facts!;
  return {
    r,
    m: buildClientSummary({
      taxYear: f.taxYear, filingStatus: f.filingStatus, taxpayerName: f.taxpayerName, spouseName: f.spouseName, dependents: f.dependents,
      values: r.values, lines: r.lines, deposit: f.deposit ? { accountLast4: f.deposit.accountLast4, type: f.deposit.type } : null,
    }),
  };
};
const codes = (cfg: Parameters<typeof returnPages>[0], expected = JORDAN) => checkReturn(parse(cfg), expected).issues.map((i) => i.code);

describe("reading amounts", () => {
  it("is comma, dollar-sign, period and parenthesis tolerant", () => {
    expect(amountCents("4,935.")).toBe(493500);
    expect(amountCents("4935")).toBe(493500);
    expect(amountCents("$4,935.00")).toBe(493500);
    expect(amountCents("(1,200.)")).toBe(-120000);
    expect(amountCents("-0-")).toBe(0);
  });
  it("labels ignore spacing, commas and periods", () => {
    expect(phrase("Form(s) W-2, box 1").test("Form(s)W-2 box1")).toBe(true);
    const r = readForm("11 Subtract line 10 from line 9.   This  is your adjusted gross   income . . . . 11 62000", "F1040");
    expect(r["1040.11"]).toMatchObject({ status: "found", value: 6200000, printedLine: "11" });
  });
  it("a printed line number with no amount is blank, not a value", () => {
    expect(readForm("17 Amount from Schedule 2, line 3 . . . 17", "F1040")["1040.17"]).toMatchObject({ status: "blank" });
  });
  it("one label printed twice with different amounts is ambiguous", () => {
    const r = readForm("This is your total tax 24 100.\nThis is your total tax 24 200.", "F1040");
    expect(r["1040.24"].status).toBe("ambiguous");
  });
  it("reads a real PDF made with pdf-lib through unpdf", async () => {
    const p = await pdfToPages(await returnPdf(jordan()));
    const r = checkReturn(parseReturnPages(p!), JORDAN);
    expect(r.issues).toEqual([]);
    expect(r.values["1040.35a"]).toBe(493500);
  });
});

describe("Jordan Sample — happy path (federal standard, Alabama itemized)", () => {
  it("reads every form and passes every check", () => {
    const p = parse(jordan());
    expect(Object.keys(p.forms).sort()).toEqual(["AL40", "ALSA", "F1040", "F8879", "S8812", "SA"]);
    expect(p.filingStatus.code).toBe("HOH");
    expect(p.dependents?.map((d) => d.name)).toEqual(["Ava Sample", "Mason Sample"]);
    expect(p.deposit).toEqual({ routingLast4: "0019", accountLast4: "4821", type: "CHECKING" });
    const { r } = summaryOf(jordan());
    expect(r.facts).toMatchObject({ filingStatus: "HOH", federalResultCents: 493500, federalDeduction: "STANDARD", alabama: { resultCents: 57800, deduction: "ITEMIZED" } });
    expect(r.facts!.dependents.map((d) => d.age)).toEqual([9, 6]);
  });

  it("builds the plain-language summary in the mockup's order, from the return's numbers only", () => {
    const { m } = summaryOf(jordan());
    expect(m.answer.headline).toBe("Good news, Jordan. You're getting money back.");
    expect(m.answer.federal).toMatchObject({ cents: 493500, kind: "refund" });
    expect(m.answer.state).toMatchObject({ label: "Alabama refund", cents: 57800 });
    expect(m.answer.total).toEqual({ label: "Total coming back to you", cents: 551300 }); // 4,935 + 578
    expect(m.answer.deposit).toBe("Your federal refund goes by direct deposit to your checking account ending in 4821.");
    expect(m.who.status).toBe("Filing status: Head of Household");
    expect(m.who.dependentsTitle).toBe("Children you claimed: 2");
    expect(m.who.dependentsText).toBe("Ava (9) and Mason (6)");
    expect(m.federal.rows.map((r) => [r.title, r.cents, r.source])).toEqual([
      ["Money you earned", 6200000, "Form 1040, line 9"],
      ["Tax-free amount (standard deduction)", 2362500, "Line 12"],
      ["Income that's actually taxed", 3837500, "Line 15"],
      ["Tax on that income", 426500, "Line 16"],
      ["Child tax credit", 426500, "Line 19"],
      ["Your federal tax for the year", 0, "Line 24"],
      ["Tax already taken from your paychecks", 480000, "Line 25a (W-2, box 2)"],
      ["Leftover child credit, paid to you", 13500, "Line 28"],
    ]);
    expect(m.federal.rows[4].detail).toBe("For your 2 qualifying children (Schedule 8812). It wiped out your whole tax bill.");
    expect(m.federal.rows[7].detail).toBe("Your credit was $4,400. $4,265 erased your tax; the other $135 is added to your refund.");
    expect(m.federal.result).toEqual({ label: "Your federal refund", cents: 493500 });
    expect(m.deductions.items.map((i) => [i.title, i.cents])).toEqual([
      ["Mortgage interest", 840000], ["Property tax on your home", 95000], ["Car tag (the value-based part)", 21000], ["Donations to charity", 120000], ["Medical bills", 0],
    ]);
    expect(m.deductions.items[4].detail).toBe("You paid $1,800, but none of it counted this year (see below).");
    expect(m.deductions.total).toEqual({ label: "Your itemized total", cents: 1076000 });
    // Thresholds: 7.5% × 62,000 = 4,650 → 4,650 − 1,800 = 2,850 more; 4% × 62,000 = 2,480 → 680 more.
    expect(m.deductions.medical!.lines[0]).toContain("7.5% of your income, which is $4,650 for you. You paid $1,800, so you'd need $2,850 more");
    expect(m.deductions.medical!.lines[1]).toBe("Alabama's bar is lower, 4% of your income ($2,480). You'd need $680 more for Alabama.");
    expect(m.deductions.federalChoice).toEqual({ heading: "We used the standard deduction", text: "$23,625 is bigger than your $10,760 itemized total." });
    expect(m.deductions.alabamaChoice!.heading).toBe("We itemized");
    expect(m.deductions.alabamaChoice!.text).toContain("your $10,760 itemized total (Form 40, line 11), so your mortgage, property tax, car tag and donations still lower your Alabama tax.");
    expect(m.alabama!.rows.map((r) => [r.title, r.cents])).toEqual([
      ["Money you earned", 6200000], ["Alabama tax-free amounts", 1476000], ["Alabama tax on $47,240", 232200], ["Alabama tax taken from your paychecks", 290000],
    ]);
    expect(m.alabama!.result).toEqual({ label: "You paid $578 more than you owed, so it comes back", cents: 57800 });
    expect(m.next[0]).toBe("Read this over. If it looks right, tap Approve.");
    expect(m.approveNote).toContain("doesn't replace your IRS Form 8879");
  });

  it("states no tax-law dollar figures that aren't on the return", () => {
    const { m } = summaryOf(jordan());
    const text = JSON.stringify(m);
    for (const notOnReturn of ["$2,200", "$500 for each", "$2,500", "21 days", "$40,000"]) expect(text).not.toContain(notOnReturn);
  });

  it("the medical floors come from the one constants file", () => {
    expect(FEDERAL_MEDICAL_FLOOR_BP).toBe(750);
    expect(ALABAMA_MEDICAL_FLOOR_BP).toBe(400);
    expect(medicalFloorCents(6200000, FEDERAL_MEDICAL_FLOOR_BP)).toBe(465000);
    expect(medicalFloorCents(6200000, ALABAMA_MEDICAL_FLOOR_BP)).toBe(248000);
  });

  it("car tag is only labeled from the personal property tax line", () => {
    const { m } = summaryOf(jordan({ v: { "SA.5c": undefined, "SA.5d": 950, "SA.5e": 950, "SA.7": 950, "SA.17": 10550, "ALSA.6": undefined, "ALSA.8": 950, "ALSA.19": 10550, "AL40.11": 10550, "AL40.15": 14550, "AL40.16": 47450 } }));
    expect(m.deductions.items.map((i) => i.title)).not.toContain("Car tag (the value-based part)");
  });
});

describe("fail-safe holds", () => {
  it("a missing required line", () => {
    expect(codes(jordan({ drop: ["1040.24"] }))).toContain("MISSING_LINE");
  });
  it("total payments − total tax ≠ refund", () => {
    expect(codes(jordan({ v: { "1040.35a": 4936 } }))).toContain("MATH_REFUND");
    expect(codes(jordan({ v: { "1040.33": 4936 } }))).toEqual(expect.arrayContaining(["MATH_TOTAL_PAYMENTS", "MATH_OVERPAID"]));
  });
  it("the taxable-income arithmetic", () => {
    expect(codes(jordan({ v: { "1040.15": 38000 } }))).toContain("MATH_TAXABLE_INCOME");
    expect(codes(jordan({ v: { "1040.11": 61000 } }))).toContain("MATH_AGI");
  });
  it("Schedule A total ≠ the sum of its parts", () => {
    expect(codes(jordan({ v: { "SA.17": 10860 } }))).toContain("MATH_SCHED_A_TOTAL");
    expect(codes(jordan({ v: { "ALSA.19": 10860, "AL40.11": 10860 } }))).toEqual(expect.arrayContaining(["MATH_AL_SCHED_A_TOTAL"]));
    expect(codes(jordan({ v: { "SA.3": 4000 } }))).toContain("MATH_SCHED_A_MEDICAL_FLOOR");
  });
  it("tax year ≠ the case year", () => {
    expect(codes(jordan({ year: 2024 }))).toContain("YEAR_MISMATCH");
    expect(codes(jordan({ alYear: 2024 }))).toContain("YEAR_MISMATCH");
  });
  it("names don't match the client record", () => {
    expect(codes(jordan(), { taxYear: 2025, taxpayer: { first: "Marcus", last: "Fairbanks" }, spouse: null })).toContain("NAME_MISMATCH");
    expect(samePerson({ first: "Jordan A", last: "Sample" }, { first: "jordan", last: "SAMPLE" })).toBe(true);
  });
  it("a joint return needs the spouse on file, matching", () => {
    expect(codes(jointCouple(), { taxYear: 2025, taxpayer: { first: "Riley", last: "Example" }, spouse: null })).toContain("SPOUSE_NO_RECORD");
    expect(codes(jointCouple(), { taxYear: 2025, taxpayer: { first: "Riley", last: "Example" }, spouse: { first: "Jamie", last: "Example" } })).toContain("SPOUSE_MISMATCH");
  });
  it("business returns are held for phase 2", () => {
    const p = parseReturnPages(pages([["Form 1120-S U.S. Income Tax Return for an S Corporation 2025", "1a Gross receipts 100,000."]]));
    expect(checkReturn(p, JORDAN).issues).toEqual([{ code: "BUSINESS_RETURN", message: "Business return summaries aren't supported yet (Form 1120-S found). Phase 2." }]);
    expect(checkReturn(parseReturnPages(pages([["Form 1065 U.S. Return of Partnership Income 2025"]])), JORDAN).issues[0].code).toBe("BUSINESS_RETURN");
  });
  it("an unreadable (scanned) PDF", async () => {
    expect(checkReturn(parseReturnPages([{ page: 1, text: "" }]), JORDAN).issues[0].code).toBe("UNREADABLE");
  });
  it("two returns in one file", () => {
    const one = returnPages(jordan());
    expect(checkReturn(parseReturnPages(pages([...one, one[0]])), JORDAN).issues.map((i) => i.code)).toContain("MULTIPLE_RETURNS");
  });
  it("no checked filing status box", () => {
    expect(codes(jordan({ replace: [["[X] Head of household", "[ ] Head of household"]] }))).toContain("FILING_STATUS");
  });
  it("Schedule 8812 counts more children than were read", () => {
    expect(codes(jordan({ dependents: [{ name: "Ava Sample", ssn: "400-00-0001", rel: "Daughter" }] }))).toContain("DEPENDENTS_COUNT");
  });
  it("an estimated tax penalty isn't explained yet", () => {
    expect(codes(owes({ v: { "1040.38": 20, "1040.37": 1250 } }))).toContain("PENALTY");
  });
  it("messages are plain language with the formula", () => {
    const i = checkReturn(parse(jordan({ v: { "1040.15": 38000 } })), JORDAN).issues.find((x) => x.code === "MATH_TAXABLE_INCOME")!;
    expect(i.message).toBe("Form 1040: line 15 shows $38,000, but line 11 − line 14 (not less than $0) = $38,375.");
  });
});

describe("other returns", () => {
  it("a joint return (spouse named, savings deposit, no state)", () => {
    const { r, m } = summaryOf(jointCouple(), { taxYear: 2025, taxpayer: { first: "Riley", last: "Example" }, spouse: { first: "Casey", last: "Example" } });
    expect(r.facts).toMatchObject({ filingStatus: "MFJ", spouseName: "Casey Example", alabama: null });
    expect(m.answer.deposit).toBe("Your federal refund goes by direct deposit to your savings account ending in 1111.");
    expect(m.next[0]).toContain("each of you taps Approve");
    expect(m.federal.rows[0].detail).toBe("Wages $98,000 and taxable interest $400.");
    expect(m.alabama).toBeNull();
  });
  it("an amount owed instead of a refund (federal and Alabama)", () => {
    const { r, m } = summaryOf(owes(), { taxYear: 2025, taxpayer: { first: "Morgan", last: "Owes" }, spouse: null });
    expect(r.facts!.federalResultCents).toBe(-125000);
    expect(r.facts!.alabama!.resultCents).toBe(-12000);
    expect(m.answer.headline).toBe("Morgan, here's what you owe.");
    expect(m.answer.total).toEqual({ label: "Total you owe", cents: 137000 });
    expect(m.federal.title).toBe("How we got the amount you owe the IRS");
    expect(m.federal.result).toEqual({ label: "Amount you owe the IRS", cents: 125000 });
    expect(m.alabama!.result).toEqual({ label: "Amount you owe Alabama", cents: 12000 });
    expect(m.deductions.alabamaChoice!.heading).toBe("We used Alabama's standard deduction");
    expect(m.next.join(" ")).toContain("Any amount you owe is due by the filing deadline");
  });
});

describe("Form 8879", () => {
  it("is detected with its year, names and Part I amounts", async () => {
    const p = parseReturnPages((await pdfToPages(await toPdf(form8879Pages({ taxpayer: { first: "Jordan", last: "Sample" }, agi: 62000, totalTax: 0, withheld: 4800, refund: 4935 }))))!);
    expect(p.forms.F8879).toEqual([1]);
    expect(p.forms.F1040).toBeUndefined();
    expect(p.years.F8879).toEqual([2025]);
    expect(p.form8879?.taxpayer).toEqual({ first: "Jordan", last: "Sample" });
    expect(p.readings["8879.1"]).toMatchObject({ status: "found", value: 6200000 });
    expect(p.readings["8879.4"]).toMatchObject({ status: "found", value: 493500 });
    expect(p.readings["8879.5"]).toMatchObject({ status: "blank" });
  });
});
