import { addMonths } from "./pricing";
import { quoteMethod, type FeeSetting } from "./payment-fees";

/**
 * In-house payment plans. Everything is computed on the server in whole cents;
 * the client chooses only the number of months from the options their price
 * qualifies for.
 *
 * - The permitted card fee is calculated first and shown separately. It comes
 *   from the shared fee rules: never on debit cards, never above the 3%
 *   credit-card cap, and only after the owner turned it on with a verification
 *   note. A 3.5% target is reduced to the permitted rate, not applied.
 * - Total = service price + permitted card fee.
 * - Deposit = 30% of the total (rounded to the cent).
 * - The remaining 70% is split into equal monthly installments; any rounding
 *   difference goes on the final installment.
 * - The term limit is set by the service price (before the card fee).
 */

export const DEPOSIT_BPS = 3000;
export const MIN_MONTHS = 2;
export const MAX_MONTHS = 6;

export const PLAN_TIERS = [
  { fromCents: 0, maxMonths: 2, label: "Under $1,500" },
  { fromCents: 150_000, maxMonths: 2, label: "$1,500–$2,499.99" },
  { fromCents: 250_000, maxMonths: 3, label: "$2,500–$5,499.99" },
  { fromCents: 550_000, maxMonths: 4, label: "$5,500–$7,499.99" },
  { fromCents: 750_000, maxMonths: 5, label: "$7,500–$9,999.99" },
  { fromCents: 1_000_000, maxMonths: 6, label: "$10,000 and above" },
] as const;

export function tierFor(serviceCents: number) {
  if (!Number.isInteger(serviceCents) || serviceCents <= 0) throw new PlanError("The service price must be more than $0.");
  return [...PLAN_TIERS].reverse().find((t) => serviceCents >= t.fromCents)!;
}

/** Month options the client may choose from: 2 up to the tier's maximum. */
export function qualifyingMonths(serviceCents: number) {
  const max = tierFor(serviceCents).maxMonths;
  return Array.from({ length: max - MIN_MONTHS + 1 }, (_, i) => MIN_MONTHS + i);
}

/** Card-on-file plans: the card type decides whether any fee is permitted. */
export type PlanCard = "CARD_CREDIT" | "CARD_DEBIT";

export type PlanSchedule = {
  serviceCents: number;
  card: PlanCard;
  feeCents: number;
  feeNote: string;
  totalCents: number;
  depositCents: number;
  months: number;
  installments: { seq: number; dueDate: string; amountCents: number }[];
};

export class PlanError extends Error {}

export function computePlan(input: { serviceCents: number; months: number; card: PlanCard; firstDueDate: string; feeSettings: FeeSetting[] }): PlanSchedule {
  const { serviceCents, months, card } = input;
  if (!qualifyingMonths(serviceCents).includes(months)) throw new PlanError(`A ${months}-month plan isn't available at this price.`);
  if (card !== "CARD_CREDIT" && card !== "CARD_DEBIT") throw new PlanError("Choose a credit or debit card.");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.firstDueDate)) throw new PlanError("Choose the first installment date.");
  const fee = quoteMethod(card, serviceCents, input.feeSettings, { kind: "SERVICE" });
  const totalCents = serviceCents + fee.feeCents;
  // Half-up rounding to the cent for the deposit.
  const depositCents = Math.floor((totalCents * DEPOSIT_BPS + 5_000) / 10_000);
  const remaining = totalCents - depositCents;
  const each = Math.floor(remaining / months);
  const installments = Array.from({ length: months }, (_, i) => ({
    seq: i + 1,
    dueDate: addMonths(input.firstDueDate, i),
    amountCents: i === months - 1 ? remaining - each * (months - 1) : each,
  }));
  return { serviceCents, card, feeCents: fee.feeCents, feeNote: fee.note, totalCents, depositCents, months, installments };
}

// --- Late fees (proposed policy; off until reviewed and enabled) ----------------------

export type LateFeePolicy = { enabled: boolean; graceDays: number; periodDays: number; rateBps: number; capBps: number | null };

/** The owner's proposed policy: 5-day grace, then 10% of unpaid principal per further 5-day period, not compounded. Disabled. */
export const PROPOSED_LATE_FEE: LateFeePolicy = { enabled: false, graceDays: 5, periodDays: 5, rateBps: 1_000, capBps: null };

const dayNum = (ymd: string) => Date.UTC(+ymd.slice(0, 4), +ymd.slice(5, 7) - 1, +ymd.slice(8, 10)) / 86_400_000;

/**
 * Late fee for one installment: after the grace period, rateBps of the unpaid
 * principal for each started period, never on earlier fees (no compounding),
 * optionally capped. Returns 0 whenever the policy is off.
 */
export function lateFeeFor(unpaidPrincipalCents: number, dueDate: string, today: string, policy: LateFeePolicy) {
  if (!policy.enabled || unpaidPrincipalCents <= 0) return 0;
  const late = dayNum(today) - dayNum(dueDate) - policy.graceDays;
  if (late <= 0) return 0;
  const periods = Math.ceil(late / policy.periodDays);
  const fee = Math.floor((unpaidPrincipalCents * policy.rateBps * periods) / 10_000);
  return policy.capBps === null ? fee : Math.min(fee, Math.floor((unpaidPrincipalCents * policy.capBps) / 10_000));
}
