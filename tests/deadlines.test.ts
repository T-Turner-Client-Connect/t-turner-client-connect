import { describe, expect, it } from "vitest";
import { buildCountdowns, countdownText, dcHolidays, nextBusinessDay, officeToday, ruleDueDate, suggestedDates, type DeadlineRow } from "@/lib/tax/deadlines";

const reviewed = new Date("2026-10-29T12:00:00Z");
let n = 0;
const row = (kind: string, taxYear: number, dueDate: string, extra: Partial<DeadlineRow> = {}): DeadlineRow => ({
  id: `r${n++}`, kind, taxYear, jurisdiction: "US", reliefState: "", dueDate, timeNote: null, notes: null, sourceUrl: "https://www.irs.gov/publications/p509", lastReviewedAt: reviewed, hidden: false, ...extra,
});
const ty2026 = [
  row("INDIVIDUAL", 2026, "2027-04-15"), row("INDIVIDUAL_EXTENDED", 2026, "2027-10-15"),
  row("PARTNERSHIP", 2026, "2027-03-15"), row("PARTNERSHIP_EXTENDED", 2026, "2027-09-15"),
  row("S_CORP", 2026, "2027-03-15"), row("S_CORP_EXTENDED", 2026, "2027-09-15"),
  row("C_CORP", 2026, "2027-04-15"), row("C_CORP_EXTENDED", 2026, "2027-10-15"),
];
const card = (cards: ReturnType<typeof buildCountdowns>, key: string) => cards.find((c) => c.key === key)!;

describe("IRS date rules", () => {
  it("moves weekend and DC-holiday due dates to the next business day", () => {
    expect(ruleDueDate("INDIVIDUAL", 2026)).toBe("2027-04-15"); // Thursday
    expect(ruleDueDate("PARTNERSHIP", 2026)).toBe("2027-03-15"); // Monday
    expect(ruleDueDate("S_CORP", 2026, 12, true)).toBe("2027-09-15");
    expect(ruleDueDate("C_CORP", 2026, 12, true)).toBe("2027-10-15");
    // 2028: April 15 is a Saturday → Monday April 17 (Emancipation Day is Sunday, observed Monday → Tuesday 18)
    expect(ruleDueDate("INDIVIDUAL", 2027)).toBe("2028-04-18");
    // 2022 (Emancipation Day observed Friday April 15) → Monday April 18, as the IRS announced.
    expect(nextBusinessDay("2022-04-15")).toBe("2022-04-18");
    expect(dcHolidays(2027).has("2027-04-16")).toBe(true);
    // Fiscal year ending June 30, 2027: partnership due Sept 15, 2027; C corp Oct 15 (new rule).
    expect(ruleDueDate("PARTNERSHIP", 2027, 6)).toBe("2027-09-15");
    expect(ruleDueDate("C_CORP", 2027, 6)).toBe("2027-10-15");
    expect(ruleDueDate("C_CORP", 2026, 6)).toBe("2026-09-15"); // June FYE that began before 2026 keeps the old rule
  });

  it("uses the office date and never counts below zero", () => {
    expect(officeToday(new Date("2027-04-16T03:00:00Z"))).toBe("2027-04-15"); // 10 p.m. in Chicago
    expect(countdownText(0)).toBe("Due today");
    expect(countdownText(1)).toBe("1 day left");
    expect(suggestedDates(2027).find((s) => s.kind === "INDIVIDUAL")!.dueDate).toBe("2028-04-18");
  });
});

describe("countdown cards", () => {
  it("waits for the IRS season announcement, shows due today, and moves forward when a date passes", () => {
    let cards = buildCountdowns({ rows: ty2026, today: "2026-10-29", profile: null, extensions: [] });
    expect(card(cards, "season").intro).toBe("Opening date awaiting IRS announcement.");
    expect(card(cards, "individual").lines[0]).toMatchObject({ dueDate: "2027-04-15", days: 168, basis: "VERIFIED" });

    cards = buildCountdowns({ rows: ty2026, today: "2027-04-15", profile: null, extensions: [] });
    expect(card(cards, "individual").lines[0].days).toBe(0);
    expect(countdownText(card(cards, "individual").lines[0].days!)).toBe("Due today");

    // The day after: the 2026 date is gone. Without a reviewed 2027 date, nothing negative and no guess.
    cards = buildCountdowns({ rows: ty2026, today: "2027-04-16", profile: null, extensions: [] });
    expect(card(cards, "individual").lines[0]).toMatchObject({ dueDate: null, basis: "AWAITING" });
    // Once Tabitha reviews next year's date, it appears.
    cards = buildCountdowns({ rows: [...ty2026, row("INDIVIDUAL", 2027, "2028-04-18")], today: "2027-04-16", profile: null, extensions: [] });
    expect(card(cards, "individual").lines[0]).toMatchObject({ dueDate: "2028-04-18", taxYear: 2027 });
  });

  it("shows only reviewed, sourced dates; season opening once announced", () => {
    const rows = [...ty2026, row("TAX_SEASON_OPENS", 2026, "2027-01-25", { lastReviewedAt: null })];
    expect(card(buildCountdowns({ rows, today: "2026-12-01", profile: null, extensions: [] }), "season").intro).toMatch(/awaiting IRS/);
    rows[rows.length - 1] = row("TAX_SEASON_OPENS", 2026, "2027-01-25", { timeNote: "IRS starts accepting returns" });
    expect(card(buildCountdowns({ rows, today: "2026-12-01", profile: null, extensions: [] }), "season").lines[0]).toMatchObject({ dueDate: "2027-01-25", days: 55 });
    expect(card(buildCountdowns({ rows, today: "2027-02-01", profile: null, extensions: [] }), "season").intro).toMatch(/Tax season is open/);
  });

  it("personalizes by entity, fiscal year, state and confirmed extension without implying one was filed", () => {
    const rows = [...ty2026, row("INDIVIDUAL", 2026, "2027-04-15", { jurisdiction: "AL" })];
    const indiv = buildCountdowns({ rows, today: "2026-10-29", profile: { clientType: "INDIVIDUAL", entityType: null, fiscalYearEnd: null, state: "AL" }, extensions: [], stateName: () => "Alabama" });
    expect(card(indiv, "individual").lines.map((l) => l.label)).toEqual(["Federal — Form 1040", "Alabama individual return"]);
    expect(card(indiv, "individual").lines[0].appliesToYou).toBe(true);
    const ext = card(indiv, "extended").lines.find((l) => l.key === "INDIVIDUAL-extended")!;
    expect(ext.personal).toMatch(/doesn't mean an extension was filed/);
    expect(card(indiv, "extension-request").footnote).toBe("An extension to file generally does not extend the time to pay.");

    const confirmed = buildCountdowns({ rows, today: "2026-10-29", profile: { clientType: "INDIVIDUAL", entityType: null, fiscalYearEnd: null, state: "AL" }, extensions: [{ taxYear: 2026, jurisdiction: "FEDERAL" }] });
    expect(card(confirmed, "extended").lines.find((l) => l.key === "INDIVIDUAL-extended")!.personal).toMatch(/confirmed your 2026 federal extension/);

    const scorp = buildCountdowns({ rows, today: "2026-10-29", profile: { clientType: "BUSINESS", entityType: "S_CORP", fiscalYearEnd: 6, state: "TX" }, extensions: [] });
    const biz = card(scorp, "business").lines;
    expect(biz.find((l) => l.key === "S_CORP")!.appliesToYou).toBe(false); // general calendar-year date
    expect(biz.find((l) => l.key === "S_CORP-fiscal")).toMatchObject({ dueDate: "2027-09-15", basis: "CALCULATED", appliesToYou: true });
    expect(card(scorp, "individual").lines[0].appliesToYou).toBe(false);
  });

  it("applies state disaster relief only to clients in that state", () => {
    const rows = [...ty2026, row("INDIVIDUAL", 2026, "2027-05-17", { reliefState: "LA", notes: "IRS disaster relief" })];
    const la = buildCountdowns({ rows, today: "2026-10-29", profile: { clientType: "INDIVIDUAL", entityType: null, fiscalYearEnd: null, state: "LA" }, extensions: [] });
    const al = buildCountdowns({ rows, today: "2026-10-29", profile: { clientType: "INDIVIDUAL", entityType: null, fiscalYearEnd: null, state: "AL" }, extensions: [] });
    expect(card(la, "individual").lines[0].dueDate).toBe("2027-05-17");
    expect(card(al, "individual").lines[0].dueDate).toBe("2027-04-15");
  });
});
