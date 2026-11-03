import "server-only";
import { prisma } from "@/lib/prisma";
import { audit } from "@/lib/audit";
import { ForbiddenError, type Actor } from "@/lib/auth/actor";
import type { PortalActor } from "@/lib/portal/session";
import { requireClientAccess } from "@/lib/portal/access";
import { ValidationError } from "./clients";
import { isReportApprover } from "./bookkeeping-clients";
import { canManageBilling } from "./bookkeeping-profile";
import { squareBillingFor, todayCentral } from "./square-billing";

/**
 * Office-managed monthly billing for clients who are NOT billed through Square. The office records
 * each payment (amount, date, method); status, balances and the next due date are worked out only
 * from those records — never typed in, and never presented as Square-verified. Corrections void a
 * payment with a reason; nothing is deleted.
 */
export const PAY_METHODS = { CASH: "Cash", CHECK: "Check", ZELLE: "Zelle", CASH_APP: "Cash App", ACH: "Bank transfer (ACH)", SQUARE: "Square (entered by our office)", CARD: "Card (outside Square)", OTHER: "Other" } as const;
export type PayMethod = keyof typeof PAY_METHODS;

const ym = (d: string) => d.slice(0, 7);
const addMonths = (month: string, n: number) => {
  const [y, m] = month.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1 + n, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
};
const dueOn = (month: string, day: number) => `${month}-${String(day).padStart(2, "0")}`;
const noonUtc = (ymd: string) => new Date(`${ymd}T12:00:00.000Z`);

export type PeriodState = "PAID" | "PARTIAL" | "OVERDUE" | "UPCOMING";

/** Month-by-month ledger from the billing start (at most 24 months back) through next month. */
export function manualLedger(input: { feeCents: number | null; billingDay: number | null; startDate: Date | null; payments: { amountCents: number; periodMonth: string }[]; today: string }) {
  const { feeCents, billingDay, payments, today } = input;
  if (!feeCents || !billingDay) return null;
  const thisMonth = ym(today);
  const earliestPaid = payments.map((p) => p.periodMonth).sort()[0];
  // Billing is owed from the start date. Payments for earlier months stay in the history
  // but never create "past due" months before billing started.
  let first = input.startDate ? input.startDate.toISOString().slice(0, 7) : earliestPaid ?? thisMonth;
  const floor = addMonths(thisMonth, -23);
  if (first < floor) first = floor;
  const periods: { month: string; due: string; paidCents: number; owedCents: number; state: PeriodState }[] = [];
  for (let m = first; m <= addMonths(thisMonth, 1); m = addMonths(m, 1)) {
    const due = dueOn(m, billingDay);
    const paidCents = payments.filter((p) => p.periodMonth === m).reduce((n, p) => n + p.amountCents, 0);
    const owedCents = Math.max(0, feeCents - paidCents);
    const state: PeriodState = owedCents === 0 ? "PAID" : due < today ? "OVERDUE" : paidCents > 0 ? "PARTIAL" : "UPCOMING";
    periods.push({ month: m, due, paidCents, owedCents, state });
  }
  const overdue = periods.filter((p) => p.state === "OVERDUE");
  const next = periods.find((p) => p.due >= today && p.owedCents > 0) ?? null;
  return {
    periods,
    overdueCount: overdue.length,
    overdueCents: overdue.reduce((n, p) => n + p.owedCents, 0),
    next: next ? { due: next.due, amountCents: next.owedCents, month: next.month } : null,
    // Months a payment can be recorded for: the last two years through two months ahead.
    monthChoices: Array.from({ length: 26 }, (_, i) => addMonths(thisMonth, 2 - i)).map((m) => {
      const p = periods.find((x) => x.month === m);
      return { month: m, state: p?.state ?? ("BEFORE_START" as const), owedCents: p?.owedCents ?? null };
    }),
    // The month a new payment applies to by default: the oldest one still owed.
    defaultPeriod: (overdue[0] ?? next ?? periods.at(-1)!).month,
    status:
      overdue.length > 0
        ? { label: `${overdue.length} month${overdue.length === 1 ? "" : "s"} past due`, tone: "red" as const }
        : periods.some((p) => p.due < today)
          ? { label: "Paid — up to date", tone: "green" as const }
          : { label: next ? "First payment upcoming" : "Paid — up to date", tone: next ? ("navy" as const) : ("green" as const) },
  };
}

async function assertBilling(actor: Actor) {
  if (!(await canManageBilling(actor))) throw new ForbiddenError("Only Tabitha (or staff she allows) can record billing payments.");
}

async function assertOfficeBilled(clientId: string) {
  const { state } = await squareBillingFor(clientId);
  if (state !== "NONE") throw new ValidationError("This client is billed through Square, so payments come from Square and aren't recorded here.");
}

export type RecordPaymentInput = { amount: string; paidOn: string; periodMonth: string; method: string; reference?: string; note?: string };

export async function recordManualPayment(actor: Actor, clientId: string, input: RecordPaymentInput) {
  await assertBilling(actor);
  await assertOfficeBilled(clientId);
  const n = Number(String(input.amount).replace(/[$,\s]/g, ""));
  if (!Number.isFinite(n) || n <= 0 || n > 100000) throw new ValidationError("Enter the amount received, e.g. 350.00.");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.paidOn)) throw new ValidationError("Enter the date the payment was received.");
  if (input.paidOn > todayCentral()) throw new ValidationError("The payment date can't be in the future.");
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(input.periodMonth)) throw new ValidationError("Choose the billing month this payment covers.");
  if (!(input.method in PAY_METHODS)) throw new ValidationError("Choose how the client paid.");
  const reference = input.reference?.trim().slice(0, 80) || null;
  const note = input.note?.trim().slice(0, 300) || null;
  if (input.method === "CHECK" && !reference) throw new ValidationError("Enter the check number.");
  if ([reference, note].some((t) => t && /\b(?:\d[ -]?){13,19}\b/.test(t))) throw new ValidationError("Card numbers can't be saved.");
  const p = await prisma.manualBillingPayment.create({
    data: { clientId, amountCents: Math.round(n * 100), paidOn: noonUtc(input.paidOn), periodMonth: input.periodMonth, method: input.method, reference, note, recordedById: actor.id },
  });
  await audit(prisma, { actorId: actor.id, action: "billing.manual_payment_recorded", entityType: "ManualBillingPayment", entityId: p.id, clientId, details: { amountCents: p.amountCents, paidOn: input.paidOn, periodMonth: p.periodMonth, method: p.method } });
  return p;
}

export type MarkMonthsInput = { months: string[]; amountEach: string; method: string; reference?: string; dateMode: "DUE_DATE" | "ONE_DATE"; paidOn?: string; note?: string };

/**
 * Records one payment per selected month in a single step (for example a whole year paid in cash).
 * Months already fully paid are skipped, so nothing is entered twice. The date received is either a
 * date the office enters or each month's due date (labelled as such in the note).
 */
export async function markMonthsPaid(actor: Actor, clientId: string, input: MarkMonthsInput) {
  await assertBilling(actor);
  await assertOfficeBilled(clientId);
  const months = [...new Set(input.months)].filter((m) => /^\d{4}-(0[1-9]|1[0-2])$/.test(m)).sort();
  if (!months.length) throw new ValidationError("Choose at least one month.");
  if (months.length > 48) throw new ValidationError("Choose at most four years at a time.");
  const billing = await prisma.bookkeepingBilling.findUnique({ where: { clientId }, select: { billingDay: true, monthlyFeeCents: true } });
  const day = billing?.billingDay ?? 1;
  const today = todayCentral();
  const existing = await prisma.manualBillingPayment.groupBy({ by: ["periodMonth"], where: { clientId, voidedAt: null, periodMonth: { in: months } }, _sum: { amountCents: true } });
  const n = Number(String(input.amountEach).replace(/[$,\s]/g, ""));
  const cents = Math.round(n * 100);
  const recorded: string[] = [];
  const skipped: string[] = [];
  for (const m of months) {
    const paid = existing.find((e) => e.periodMonth === m)?._sum.amountCents ?? 0;
    if (paid > 0 && paid >= (billing?.monthlyFeeCents ?? cents)) {
      skipped.push(m);
      continue;
    }
    const due = `${m}-${String(day).padStart(2, "0")}`;
    const paidOn = input.dateMode === "ONE_DATE" ? input.paidOn ?? "" : due <= today ? due : today;
    const note = [input.dateMode === "DUE_DATE" ? "Date shown is the month's due date (entered in bulk)" : "Entered in bulk", input.note?.trim()].filter(Boolean).join(" · ");
    await recordManualPayment(actor, clientId, { amount: input.amountEach, paidOn, periodMonth: m, method: input.method, reference: input.reference, note });
    recorded.push(m);
  }
  return { recorded, skipped };
}

/** Owner only: a mistaken entry is voided with a reason and kept in the history. */
export async function voidManualPayment(actor: Actor, paymentId: string, reason: string) {
  if (!(await isReportApprover(actor))) throw new ForbiddenError("Only Tabitha can void a recorded payment.");
  if (reason.trim().length < 5) throw new ValidationError("Record why this payment is being voided.");
  const p = await prisma.manualBillingPayment.findUnique({ where: { id: paymentId } });
  if (!p) throw new ValidationError("Payment not found.");
  if (p.voidedAt) throw new ValidationError("That payment was already voided.");
  await prisma.manualBillingPayment.update({ where: { id: paymentId }, data: { voidedAt: new Date(), voidedById: actor.id, voidReason: reason.trim().slice(0, 300) } });
  await audit(prisma, { actorId: actor.id, action: "billing.manual_payment_voided", entityType: "ManualBillingPayment", entityId: paymentId, clientId: p.clientId, details: { reason: reason.trim().slice(0, 300), amountCents: p.amountCents, periodMonth: p.periodMonth } });
}

async function viewFor(clientId: string) {
  const [billing, payments] = await Promise.all([
    prisma.bookkeepingBilling.findUnique({ where: { clientId }, select: { monthlyFeeCents: true, billingDay: true, billingStartDate: true, notes: true } }),
    prisma.manualBillingPayment.findMany({ where: { clientId }, orderBy: [{ paidOn: "desc" }, { createdAt: "desc" }] }),
  ]);
  const live = payments.filter((p) => !p.voidedAt);
  const ledger = manualLedger({ feeCents: billing?.monthlyFeeCents ?? null, billingDay: billing?.billingDay ?? null, startDate: billing?.billingStartDate ?? null, payments: live, today: todayCentral() });
  // Months already fully paid (any month, including before the billing start).
  const byMonth = new Map<string, number>();
  for (const p of live) byMonth.set(p.periodMonth, (byMonth.get(p.periodMonth) ?? 0) + p.amountCents);
  const paidMonths = [...byMonth.entries()].filter(([, c]) => c >= (billing?.monthlyFeeCents ?? 1)).map(([m]) => m);
  return { billing, payments, live, ledger, lastPayment: live[0] ?? null, paidMonths };
}

/** Staff view of office-managed billing (billing access required). */
export async function manualBillingView(actor: Actor, clientId: string) {
  await assertBilling(actor);
  return viewFor(clientId);
}

/** What the client sees: their own recorded payments only. */
export async function portalManualBilling(user: PortalActor, clientId: string) {
  await requireClientAccess(user.id, clientId, "billing");
  const { state } = await squareBillingFor(clientId);
  if (state !== "NONE") return null;
  const v = await viewFor(clientId);
  if (!v.ledger && !v.live.length) return null;
  return {
    feeCents: v.billing?.monthlyFeeCents ?? null,
    billingDay: v.billing?.billingDay ?? null,
    next: v.ledger?.next ?? null,
    status: v.ledger?.status ?? null,
    overdueCents: v.ledger?.overdueCents ?? 0,
    payments: v.live.map((p) => ({ id: p.id, paidOn: p.paidOn, amountCents: p.amountCents, method: PAY_METHODS[p.method as PayMethod] ?? p.method, periodMonth: p.periodMonth })),
  };
}
