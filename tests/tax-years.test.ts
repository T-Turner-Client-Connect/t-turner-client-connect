import { describe, expect, it } from "vitest";
import { questionnaireYears } from "@/lib/services/tax-center";

describe("Tax Center years", () => {
  it("shows the current year and the three before it, newest first, rolling over on January 1 (Central time)", () => {
    expect(questionnaireYears(new Date("2026-10-30T15:00:00Z"))).toEqual([2026, 2025, 2024, 2023]);
    expect(questionnaireYears(new Date("2027-01-01T05:59:00Z"))).toEqual([2026, 2025, 2024, 2023]); // Dec 31, 11:59 pm Central
    expect(questionnaireYears(new Date("2027-01-01T06:00:00Z"))).toEqual([2027, 2026, 2025, 2024]);
  });
});
