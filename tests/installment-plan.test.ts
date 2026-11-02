import { describe, expect, it } from "vitest";
import { computePlan, lateFeeFor, PlanError, PROPOSED_LATE_FEE, qualifyingMonths, tierFor } from "@/lib/billing/installment-plan";
import type { FeeSetting } from "@/lib/billing/payment-fees";

const card = (percentBps: number, verified = true): FeeSetting[] => [{ method: "CARD_CREDIT", enabled: true, percentBps, flatCents: 0, verifiedAt: verified ? new Date() : null }];
const plan = (serviceCents: number, months: number, c: "CARD_CREDIT" | "CARD_DEBIT", s: FeeSetting[]) => computePlan({ serviceCents, months, card: c, firstDueDate: "2026-12-15", feeSettings: s });

describe("in-house plan terms by price", () => {
  it.each([
    [149_999, [2]],
    [150_000, [2]],
    [249_999, [2]],
    [250_000, [2, 3]],
    [549_999, [2, 3]],
    [550_000, [2, 3, 4]],
    [749_999, [2, 3, 4]],
    [750_000, [2, 3, 4, 5]],
    [999_999, [2, 3, 4, 5]],
    [1_000_000, [2, 3, 4, 5, 6]],
    [5_000_000, [2, 3, 4, 5, 6]],
  ])("%i cents → %j months", (cents, months) => {
    expect(qualifyingMonths(cents)).toEqual(months);
  });

  it("$1,500–$2,499.99 allows 2 months (confirmed); refuses a term the price doesn't qualify for; refuses $0", () => {
    expect(tierFor(200_000)).toMatchObject({ maxMonths: 2 });
    expect(() => plan(249_999, 3, "CARD_CREDIT", [])).toThrow(PlanError);
    expect(() => plan(250_000, 4, "CARD_CREDIT", [])).toThrow(/isn't available/);
    expect(() => plan(0, 2, "CARD_CREDIT", [])).toThrow(/more than \$0/);
  });
});

describe("card fee, deposit and installments (integer cents)", () => {
  it("3.5% target → the permitted 3% on a credit card: $2,500 + $75.00 = $2,575.00; deposit $772.50; 3 × $600.83/$600.83/$600.84", () => {
    const p = plan(250_000, 3, "CARD_CREDIT", card(350));
    expect([p.feeCents, p.totalCents, p.depositCents]).toEqual([7_500, 257_500, 77_250]);
    expect(p.installments.map((i) => i.amountCents)).toEqual([60_083, 60_083, 60_084]);
    expect(p.depositCents + p.installments.reduce((a, i) => a + i.amountCents, 0)).toBe(p.totalCents);
    expect(p.installments.map((i) => i.dueDate)).toEqual(["2026-12-15", "2027-01-15", "2027-02-15"]);
    expect(p.feeNote).toMatch(/reduced to the 3% card-network maximum/);
  });

  it("debit cards are never surcharged; an unverified or disabled fee isn't applied", () => {
    expect(plan(250_000, 3, "CARD_DEBIT", card(350)).feeCents).toBe(0);
    expect(plan(250_000, 3, "CARD_CREDIT", card(350, false)).feeCents).toBe(0);
    expect(plan(250_000, 3, "CARD_CREDIT", []).feeCents).toBe(0);
    const p = plan(250_000, 3, "CARD_DEBIT", card(350));
    expect([p.totalCents, p.depositCents, ...p.installments.map((i) => i.amountCents)]).toEqual([250_000, 75_000, 58_333, 58_333, 58_334]);
  });

  it("rounding always reconciles to the total, for every qualifying term", () => {
    for (const cents of [99_999, 150_001, 333_333, 777_777, 1_234_567]) {
      for (const m of qualifyingMonths(cents)) {
        const p = plan(cents, m, "CARD_CREDIT", card(300));
        const parts = [p.depositCents, ...p.installments.map((i) => i.amountCents)];
        expect(parts.every(Number.isInteger)).toBe(true);
        expect(parts.reduce((a, b) => a + b, 0)).toBe(p.totalCents);
        const [first, ...rest] = p.installments.map((i) => i.amountCents);
        expect(rest.every((x) => x - first >= 0 && x - first < m)).toBe(true); // only the last absorbs rounding
      }
    }
  });
});

describe("late fees (proposed policy)", () => {
  it("is off by default and charges nothing", () => {
    expect(PROPOSED_LATE_FEE.enabled).toBe(false);
    expect(lateFeeFor(60_000, "2026-12-01", "2027-03-01", PROPOSED_LATE_FEE)).toBe(0);
  });

  it("when enabled: 5-day grace, then 10% of unpaid principal per started 5-day period, never compounded; optional cap", () => {
    const on = { ...PROPOSED_LATE_FEE, enabled: true };
    expect(lateFeeFor(60_000, "2026-12-01", "2026-12-06", on)).toBe(0); // day 5: still in grace
    expect(lateFeeFor(60_000, "2026-12-01", "2026-12-07", on)).toBe(6_000); // first period
    expect(lateFeeFor(60_000, "2026-12-01", "2026-12-11", on)).toBe(6_000);
    expect(lateFeeFor(60_000, "2026-12-01", "2026-12-12", on)).toBe(12_000); // second period: 2 × 10% of principal, not of principal + fee
    expect(lateFeeFor(60_000, "2026-12-01", "2026-12-12", { ...on, capBps: 1_500 })).toBe(9_000);
    expect(lateFeeFor(0, "2026-12-01", "2027-01-01", on)).toBe(0);
  });
});
