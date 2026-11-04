import "server-only";
import { Prisma } from "@prisma/client";
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

async function assertBilling(actor: Actor, action: "view" | "edit" = "edit") {
  if (!(await canManageBilling(actor, action))) throw new ForbiddenError("Only Tabitha (or staff she allows) can record billing payments.");
}

async function assertOfficeBilled(clientId: string) {
  const { state } = await squareBillingFor(clientId);
  if (state !== "NONE") throw new ValidationError("This client is billed through Square, so payments come from Square and aren't recorded here.");
}

export type RecordPaymentInput = { amount: string; paidOn: string; periodMonth: string; method: string; reference?: string; note?: string };

type CleanPayment = { amountCents: number; paidOn: string; periodMonth: string; method: string; reference: string | null; note: string | null };

function cleanPayment(input: RecordPaymentInput): CleanPayment {
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
  return { amountCents: Math.round(n * 100), paidOn: input.paidOn, periodMonth: input.periodMonth, method: input.method, reference, note };
}

/** One writer per client at a time: concurrent saves for the same client wait, then re-check. */
async function lockClient(tx: Prisma.TransactionClient, clientId: string) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${"manual-billing:" + clientId}))`;
}

async function insertPayment(tx: Prisma.TransactionClient, actor: Actor, clientId: string, c: CleanPayment, via: "single" | "bulk") {
  const p = await tx.manualBillingPayment.create({
    data: { clientId, amountCents: c.amountCents, paidOn: noonUtc(c.paidOn), periodMonth: c.periodMonth, method: c.method, reference: c.reference, note: c.note, recordedById: actor.id },
  });
  await audit(tx, { actorId: actor.id, action: "billing.manual_payment_recorded", entityType: "ManualBillingPayment", entityId: p.id, clientId, details: { amountCents: p.amountCents, paidOn: c.paidOn, periodMonth: p.periodMonth, method: p.method, via } });
  return p;
}

export async function recordManualPayment(actor: Actor, clientId: string, input: RecordPaymentInput) {
  await assertBilling(actor);
  await assertOfficeBilled(clientId);
  const c = cleanPayment(input);
  return prisma.$transaction(async (tx) => {
    await lockClient(tx, clientId);
    // A double-click or a second person saving the same payment isn't recorded twice.
    const same = await tx.manualBillingPayment.findFirst({
      where: { clientId, voidedAt: null, periodMonth: c.periodMonth, amountCents: c.amountCents, method: c.method, paidOn: noonUtc(c.paidOn), reference: c.reference, createdAt: { gte: new Date(Date.now() - 10 * 60_000) } },
    });
    if (same) throw new ValidationError("This exact payment was just recorded. If it really is a second payment, change the note or date, or wait a few minutes.");
    return insertPayment(tx, actor, clientId, c, "single");
  });
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
  const note = [input.dateMode === "DUE_DATE" ? "Date shown is the month's due date (entered in bulk)" : "Entered in bulk", input.note?.trim()].filter(Boolean).join(" · ");
  // Validate every month before writing anything: all months are recorded, or none.
  const rows = months.map((m) => {
    const due = `${m}-${String(day).padStart(2, "0")}`;
    return cleanPayment({ amount: input.amountEach, paidOn: input.dateMode === "ONE_DATE" ? input.paidOn ?? "" : due <= today ? due : today, periodMonth: m, method: input.method, reference: input.reference, note });
  });
  return prisma.$transaction(async (tx) => {
    await lockClient(tx, clientId);
    // Re-read inside the lock, so a second click or a second person can't add the same months again.
    const existing = await tx.manualBillingPayment.groupBy({ by: ["periodMonth"], where: { clientId, voidedAt: null, periodMonth: { in: months } }, _sum: { amountCents: true } });
    const fee = billing?.monthlyFeeCents ?? 0;
    const recorded: string[] = [];
    const skipped: string[] = [];
    const partial: string[] = [];
    for (const row of rows) {
      const paid = existing.find((e) => e.periodMonth === row.periodMonth)?._sum.amountCents ?? 0;
      // Already paid: never entered twice. Partly paid: never topped up with a full payment —
      // the exact remainder is recorded with Record a Payment instead.
      if (paid > 0 && (!fee || paid >= fee)) {
        skipped.push(row.periodMonth);
        continue;
      }
      if (paid > 0) {
        partial.push(row.periodMonth);
        continue;
      }
      await insertPayment(tx, actor, clientId, row, "bulk");
      recorded.push(row.periodMonth);
    }
    return { recorded, skipped, partial };
  });
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
  const partialMonths = [...byMonth.entries()].filter(([, c]) => c > 0 && c < (billing?.monthlyFeeCents ?? 1)).map(([m]) => m);
  return { billing, payments, live, ledger, lastPayment: live[0] ?? null, paidMonths, partialMonths };
}

/** Staff view of office-managed billing (billing access required). */
export async function manualBillingView(actor: Actor, clientId: string) {
  await assertBilling(actor, "view");
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

// --- Recurring billing outside Square (Owner's Office overview) ----------------------------------

/**
 * Every client on monthly billing that is NOT in a Square recurring series, with this month's
 * standing from the same manual ledger used on the client's billing page.
 */
export async function nonSquareRecurring(actor: Actor, today = todayCentral()) {
  await assertBilling(actor, "view");
  const inSquare = new Set((await prisma.squareBillingMember.findMany({ select: { clientId: true } })).map((m) => m.clientId));
  const billing = await prisma.bookkeepingBilling.findMany({
    where: { monthlyFeeCents: { gt: 0 }, client: { archivedAt: null } },
    include: { client: { select: { id: true, displayName: true, businessName: true } } },
  });
  const rows = await Promise.all(
    billing
      .filter((b) => !inSquare.has(b.clientId))
      .map(async (b) => {
        const payments = await prisma.manualBillingPayment.findMany({ where: { clientId: b.clientId, voidedAt: null }, select: { amountCents: true, periodMonth: true } });
        const ledger = manualLedger({ feeCents: b.monthlyFeeCents, billingDay: b.billingDay, startDate: b.billingStartDate, payments, today });
        const month = today.slice(0, 7);
        const thisMonth = ledger?.periods.find((p) => p.month === month) ?? null;
        return { clientId: b.clientId, name: b.client.businessName || b.client.displayName, feeCents: b.monthlyFeeCents!, billingDay: b.billingDay, paidThisMonthCents: thisMonth?.paidCents ?? 0, owedThisMonthCents: thisMonth?.owedCents ?? 0, overdueCents: ledger?.overdueCents ?? 0, status: ledger?.status ?? null, notes: b.notes };
      }),
  );
  rows.sort((a, b) => a.name.localeCompare(b.name));
  return {
    rows,
    totals: {
      monthlyCents: rows.reduce((n, r) => n + r.feeCents, 0),
      paidThisMonthCents: rows.reduce((n, r) => n + r.paidThisMonthCents, 0),
      overdueCents: rows.reduce((n, r) => n + r.overdueCents, 0),
    },
  };
}

/** Owner (or staff with billing access): put a client on monthly billing that is paid outside Square. */
export async function addNonSquareRecurring(actor: Actor, input: { clientId: string; monthlyFee: string; billingDay: number; startMonth: string; method: string; notes?: string }) {
  await assertBilling(actor);
  const fee = Math.round(Number(String(input.monthlyFee).replace(/[$,\s]/g, "")) * 100);
  if (!Number.isFinite(fee) || fee <= 0 || fee > 10_000_000) throw new ValidationError("Enter the monthly amount, like 595 or 595.00.");
  if (!Number.isInteger(input.billingDay) || input.billingDay < 1 || input.billingDay > 28) throw new ValidationError("Choose a due day from 1 to 28.");
  if (!/^\d{4}-\d{2}$/.test(input.startMonth)) throw new ValidationError("Choose the first month billed.");
  if (!(input.method in PAY_METHODS)) throw new ValidationError("Choose how they usually pay.");
  const client = await prisma.client.findUnique({ where: { id: input.clientId }, select: { archivedAt: true } });
  if (!client || client.archivedAt) throw new ValidationError("Choose a client.");
  if (await prisma.squareBillingMember.count({ where: { clientId: input.clientId } })) throw new ValidationError("This client is billed through Square. Change it on the Square billing page instead.");
  const notes = [`Billed outside Square — usually ${PAY_METHODS[input.method as PayMethod]}.`, input.notes?.trim().slice(0, 300)].filter(Boolean).join(" ");
  const data = { monthlyFeeCents: fee, billingDay: input.billingDay, billingStartDate: new Date(`${input.startMonth}-01T00:00:00Z`), notes, updatedById: actor.id };
  await prisma.$transaction(async (tx) => {
    await tx.bookkeepingBilling.upsert({ where: { clientId: input.clientId }, create: { clientId: input.clientId, ...data }, update: data });
    await audit(tx, { actorId: actor.id, action: "billing.non_square_recurring_set", entityType: "BookkeepingBilling", entityId: input.clientId, clientId: input.clientId, details: { monthlyFeeCents: fee, billingDay: input.billingDay, startMonth: input.startMonth, method: input.method } });
  });
}
