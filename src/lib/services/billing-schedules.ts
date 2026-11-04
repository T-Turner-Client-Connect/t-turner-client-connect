import "server-only";
import type { BillingSchedule, BillingScheduleItem, Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { ForbiddenError, type Actor } from "@/lib/auth/actor";
import { assertCan, can, isPrimaryOwner } from "@/lib/auth/permissions";
import { ownerAudit } from "@/lib/auth/owner";
import { integrationStatus } from "@/lib/integrations";
import { addMonths, cashCollectedCents, creditedCents, money } from "@/lib/billing/pricing";
import { FIRM_SERVICES } from "@/lib/billing/invoice-status";
import { ValidationError } from "./clients";
import { todayYmd, ymd } from "./owner-billing";
import { approveAndSend, insertFirmInvoice, validateFirmInvoice, type FirmInvoiceInput } from "./firm-invoices";

/**
 * Billing schedules for the firm's tax-prep and other individually billed clients:
 *   RECURRING     a recurring invoice schedule (monthly, quarterly or yearly, optional end)
 *   DEPOSIT       a partial invoice against a total, with the balance invoiced later
 *   INSTALLMENTS  a total split into N invoices on dates
 * Deposits and installments are "payment plans": a total, a paid amount and a remaining amount.
 *
 * Every cycle is an ordinary Create Invoice draft (insertFirmInvoice) and is sent — when it is
 * sent — through the existing send path (approveAndSend → issueInvoice → Square only when the
 * Square switch is on). Nothing here creates a Square subscription, and nothing reads or writes
 * the bookkeeping subscriptions in Square (SquareBillingArrangement) or the "Recurring billing (not
 * in Square)" tracker, except to warn about double billing.
 *
 * Authority (Tabitha's rule): only the primary owner creates or authorizes a new schedule or plan,
 * or changes one's amount, cadence, dates or auto-send, or pauses, resumes or ends it. This is an
 * owner-only check (like assertCanApproveCoethaWork), not a grantable permission. Staff with
 * Billing → Create can propose one ("Awaiting Tabitha's approval", which generates nothing) and
 * generate invoices under a schedule she already approved.
 *
 * Generation is idempotent: (scheduleId, periodKey) is unique and the cycle row and its invoice
 * are written in one transaction under a per-schedule lock, so running twice makes one invoice.
 */

export const SCHEDULE_KINDS = { RECURRING: "Recurring invoices", DEPOSIT: "Deposit + balance", INSTALLMENTS: "Installment plan" } as const;
export type ScheduleKind = keyof typeof SCHEDULE_KINDS;
export const CADENCES = { MONTHLY: { label: "Monthly", months: 1 }, QUARTERLY: { label: "Quarterly", months: 3 }, YEARLY: { label: "Yearly", months: 12 } } as const;
export type Cadence = keyof typeof CADENCES;
export const SCHEDULE_STATUS: Record<string, { label: string; tone: "gold" | "green" | "amber" | "gray" | "red" }> = {
  PROPOSED: { label: "Awaiting Tabitha's approval", tone: "gold" },
  ACTIVE: { label: "Active", tone: "green" },
  PAUSED: { label: "Paused", tone: "amber" },
  ENDED: { label: "Ended", tone: "gray" },
  DECLINED: { label: "Declined", tone: "red" },
};

export const OWNER_ONLY_SCHEDULES = "Only Tabitha can create, approve or change a recurring schedule or payment plan. You can propose one for her approval.";

/** Tabitha (the primary owner) only. Never grantable, whatever else a staff member holds. */
export async function assertCanAuthorizeSchedules(actor: Pick<Actor, "id">) {
  if (!(await isPrimaryOwner(actor.id))) throw new ForbiddenError(OWNER_ONLY_SCHEDULES);
}

const YMD = /^\d{4}-\d{2}-\d{2}$/;
const dateOnly = (s: string) => new Date(`${s}T00:00:00.000Z`);
const addDays = (s: string, n: number) => new Date(dateOnly(s).getTime() + n * 86_400_000).toISOString().slice(0, 10);
const monthKey = (s: string) => s.slice(0, 7);

/** The invoice date of recurring period k: the start month plus k cadence steps, on the invoice day. */
export function periodDate(startDate: string, cadence: Cadence, k: number, invoiceDay: number) {
  const first = `${startDate.slice(0, 8)}${String(Math.min(invoiceDay, 28)).padStart(2, "0")}`;
  return addMonths(first, k * CADENCES[cadence].months);
}

export type ScheduleInput = {
  clientId: string;
  kind: string;
  service: string;
  description: string;
  // RECURRING: each invoice. DEPOSIT: the deposit. INSTALLMENTS: ignored (worked out from the total).
  amountCents: number;
  totalCents?: number | null;
  installments?: number | null;
  cadence?: string | null;
  startDate: string;
  endDate?: string | null;
  maxInvoices?: number | null;
  invoiceDay?: number | null;
  dueInDays?: number | null;
  // DEPOSIT: when the balance invoice is made (blank = staff make it when the work is done).
  balanceDate?: string | null;
  autoSend?: boolean;
  offeredMethods: string[];
  privateNote?: string | null;
  requestId?: string | null;
  // The invoice just saved on Create Invoice becomes the first cycle (or the deposit).
  firstInvoiceId?: string | null;
  // The person saw the double-billing warnings and chose to go ahead.
  confirmDuplicate?: boolean;
};

/** Splits a total into n invoices: equal cents, the remainder on the last one. */
export function splitTotal(totalCents: number, n: number) {
  const each = Math.floor(totalCents / n);
  return Array.from({ length: n }, (_, i) => (i === n - 1 ? totalCents - each * (n - 1) : each));
}

type PlannedItem = { seq: number; periodKey: string; label: string; amountCents: number; issueDate: string | null };

function validateInput(i: ScheduleInput): { kind: ScheduleKind; cadence: Cadence | null; items: PlannedItem[] } {
  if (!(i.kind in SCHEDULE_KINDS)) throw new ValidationError("Choose a payment type.");
  const kind = i.kind as ScheduleKind;
  if (!(FIRM_SERVICES as readonly string[]).includes(i.service)) throw new ValidationError("Choose a service.");
  if (!i.description.trim()) throw new ValidationError("Describe the services provided.");
  if (!YMD.test(i.startDate)) throw new ValidationError("Choose the start date.");
  if (i.startDate < addDays(todayYmd(), -31)) throw new ValidationError("The start date can't be more than a month in the past.");
  const due = i.dueInDays ?? 14;
  if (!Number.isInteger(due) || due < 0 || due > 120) throw new ValidationError("Due in: 0 to 120 days.");
  const day = i.invoiceDay ?? Number(i.startDate.slice(8, 10));
  if (!Number.isInteger(day) || day < 1 || day > 28) throw new ValidationError("Invoice day: 1 to 28 (so every month has it).");
  const cents = (v: number | null | undefined, what: string) => {
    if (!Number.isInteger(v) || (v as number) <= 0 || (v as number) > 100_000_000) throw new ValidationError(`Enter the ${what} greater than $0.`);
    return v as number;
  };
  if (kind === "RECURRING") {
    if (!i.cadence || !(i.cadence in CADENCES)) throw new ValidationError("Choose how often: monthly, quarterly or yearly.");
    cents(i.amountCents, "amount of each invoice");
    if (i.endDate && (!YMD.test(i.endDate) || i.endDate < i.startDate)) throw new ValidationError("The end date can't be before the start date.");
    if (i.maxInvoices != null && (!Number.isInteger(i.maxInvoices) || i.maxInvoices < 1 || i.maxInvoices > 360)) throw new ValidationError("Number of invoices: 1 to 360, or leave it blank.");
    return { kind, cadence: i.cadence as Cadence, items: [] };
  }
  const total = cents(i.totalCents, "plan total");
  if (kind === "DEPOSIT") {
    const deposit = cents(i.amountCents, "deposit");
    if (deposit >= total) throw new ValidationError("The deposit must be less than the plan total.");
    if (i.balanceDate && (!YMD.test(i.balanceDate) || i.balanceDate < i.startDate)) throw new ValidationError("The balance invoice date can't be before the deposit.");
    return {
      kind,
      cadence: null,
      items: [
        { seq: 1, periodKey: "1", label: `Deposit toward ${money(total)}`, amountCents: deposit, issueDate: i.startDate },
        { seq: 2, periodKey: "2", label: `Balance of ${money(total)}`, amountCents: total - deposit, issueDate: i.balanceDate || null },
      ],
    };
  }
  const n = i.installments ?? 0;
  if (!Number.isInteger(n) || n < 2 || n > 36) throw new ValidationError("Number of installments: 2 to 36.");
  const cadence = (i.cadence && i.cadence in CADENCES ? i.cadence : "MONTHLY") as Cadence;
  const amounts = splitTotal(total, n);
  if (amounts[0] <= 0) throw new ValidationError("The total is too small to split that many ways.");
  return {
    kind,
    cadence,
    items: amounts.map((a, k) => ({ seq: k + 1, periodKey: String(k + 1), label: `Installment ${k + 1} of ${n} (plan total ${money(total)})`, amountCents: a, issueDate: k === 0 ? i.startDate : addMonths(i.startDate, k * CADENCES[cadence].months) })),
  };
}

/**
 * Double-billing check before a schedule is made: the client's bookkeeping subscription in Square
 * (read from the stored link, never from Square itself), the "not in Square" tracker, and other
 * schedules for the same service.
 */
export async function scheduleWarnings(clientId: string, service: string) {
  const [members, manual, schedules] = await Promise.all([
    prisma.squareBillingMember.findMany({ where: { clientId }, include: { arrangement: { select: { title: true, amountCents: true, cadence: true, active: true, endedAt: true, nextDueDate: true } } } }),
    prisma.bookkeepingBilling.findUnique({ where: { clientId }, select: { monthlyFeeCents: true } }),
    prisma.billingSchedule.findMany({ where: { clientId, service, status: { in: ["PROPOSED", "ACTIVE", "PAUSED"] } }, select: { id: true, kind: true, status: true } }),
  ]);
  const out: { kind: "SQUARE" | "NOT_IN_SQUARE" | "SCHEDULE"; text: string; sameService: boolean }[] = [];
  for (const m of members.filter((x) => x.arrangement.active && !x.arrangement.endedAt)) {
    const a = m.arrangement;
    out.push({
      kind: "SQUARE",
      sameService: service === "Bookkeeping",
      text: `Already billed in Square: ${a.title || "recurring bookkeeping series"}${a.amountCents ? ` (${money(a.amountCents)}${a.cadence ? ` ${a.cadence.toLowerCase()}` : ""})` : ""}${a.nextDueDate ? `, next invoice ${ymd(a.nextDueDate)}` : ""}. That subscription is left exactly as it is.`,
    });
  }
  if (!members.length && manual?.monthlyFeeCents) out.push({ kind: "NOT_IN_SQUARE", sameService: service === "Bookkeeping", text: `On recurring bookkeeping billing outside Square (${money(manual.monthlyFeeCents)} a month).` });
  for (const s of schedules) out.push({ kind: "SCHEDULE", sameService: true, text: `Already has a ${SCHEDULE_KINDS[s.kind as ScheduleKind]?.toLowerCase() ?? "schedule"} for ${service} (${SCHEDULE_STATUS[s.status].label}).` });
  return out;
}

/** Warnings for every client, for the Create Invoice page (service null = applies to any service). */
export async function warningsByClient(): Promise<Record<string, { text: string; service: string | null }[]>> {
  const [members, manual, schedules] = await Promise.all([
    prisma.squareBillingMember.findMany({ where: { arrangement: { active: true, endedAt: null } }, include: { arrangement: { select: { title: true, amountCents: true, cadence: true, nextDueDate: true } } } }),
    prisma.bookkeepingBilling.findMany({ where: { monthlyFeeCents: { gt: 0 } }, select: { clientId: true, monthlyFeeCents: true } }),
    prisma.billingSchedule.findMany({ where: { status: { in: ["PROPOSED", "ACTIVE", "PAUSED"] } }, select: { clientId: true, kind: true, status: true, service: true } }),
  ]);
  const out: Record<string, { text: string; service: string | null }[]> = {};
  const add = (id: string, w: { text: string; service: string | null }) => (out[id] ??= []).push(w);
  for (const m of members) {
    const a = m.arrangement;
    add(m.clientId, { service: "Bookkeeping", text: `Bookkeeping subscription in Square: ${a.title || "recurring series"}${a.amountCents ? ` (${money(a.amountCents)}${a.cadence ? ` ${a.cadence.toLowerCase()}` : ""})` : ""}${a.nextDueDate ? `, next invoice ${ymd(a.nextDueDate)}` : ""}. It stays exactly as it is in Square.` });
  }
  const inSquare = new Set(members.map((m) => m.clientId));
  for (const b of manual) if (!inSquare.has(b.clientId)) add(b.clientId, { service: "Bookkeeping", text: `On recurring bookkeeping billing outside Square (${money(b.monthlyFeeCents!)} a month).` });
  for (const s of schedules) add(s.clientId, { service: s.service, text: `Already has a ${SCHEDULE_KINDS[s.kind as ScheduleKind]?.toLowerCase() ?? "schedule"} for ${s.service} (${SCHEDULE_STATUS[s.status].label}).` });
  return out;
}

/**
 * Staff propose; Tabitha creates. A proposal (staff with Billing → Create) waits for her approval
 * and generates nothing. When she makes it herself it is active right away. Auto-send is off
 * unless she turns it on.
 */
/** Every check proposeSchedule makes, without saving anything (the Create Invoice page runs it first). */
export async function checkSchedule(actor: Actor, input: ScheduleInput) {
  await assertCan(actor, "billing", "create", "Creating invoices needs Billing → Create.");
  const owner = await isPrimaryOwner(actor.id);
  if (input.autoSend && !owner) throw new ForbiddenError("Only Tabitha can turn on Send automatically each cycle.");
  const v = validateInput(input);
  const client = await prisma.client.findUnique({ where: { id: input.clientId }, select: { archivedAt: true } });
  if (!client || client.archivedAt) throw new ValidationError("Choose a client from the client list.");
  // The payment options must be ones the owner approved, as for any invoice.
  await validateFirmInvoice({ clientId: input.clientId, service: input.service, amountCents: v.items[0]?.amountCents ?? input.amountCents, description: input.description, issueDate: input.startDate, dueDate: addDays(input.startDate, input.dueInDays ?? 14), offeredMethods: input.offeredMethods });
  // Same service, already billed another way: confirm first so nothing is billed twice.
  const warnings = (await scheduleWarnings(input.clientId, input.service)).filter((w) => w.sameService);
  if (warnings.length && !input.confirmDuplicate) throw new ValidationError(`Possible double billing — ${warnings.map((w) => w.text).join(" ")} Tick “Create anyway” if this is separate.`);
  return { owner, v, warnings };
}

export async function proposeSchedule(actor: Actor, input: ScheduleInput) {
  const { owner, v, warnings } = await checkSchedule(actor, input);
  let first: { id: string; amountCents: number; issueDate: string } | null = null;
  if (input.firstInvoiceId) {
    const inv = await prisma.invoice.findUnique({ where: { id: input.firstInvoiceId }, include: { lines: true, scheduleItem: true } });
    if (!inv || inv.clientId !== input.clientId || inv.formType !== "INVOICE") throw new ValidationError("Not found.");
    if (inv.scheduleItem) throw new ValidationError("This invoice is already part of a schedule.");
    first = { id: inv.id, amountCents: inv.lines.reduce((s, l) => s + l.quantity * l.unitCents, 0), issueDate: ymd(inv.issueDate) };
    if (v.items.length && first.amountCents !== v.items[0].amountCents) throw new ValidationError(`This invoice should be ${money(v.items[0].amountCents)}, the first ${v.kind === "DEPOSIT" ? "payment (the deposit)" : "installment"}.`);
  }
  const now = new Date();
  const status = owner ? "ACTIVE" : "PROPOSED";
  const s = await prisma.$transaction(async (tx) => {
    const s = await tx.billingSchedule.create({
      data: {
        clientId: input.clientId,
        kind: v.kind,
        status,
        service: input.service,
        description: input.description.trim().slice(0, 2000),
        amountCents: v.kind === "RECURRING" ? input.amountCents : null,
        totalCents: v.kind === "RECURRING" ? null : input.totalCents!,
        cadence: v.cadence,
        startDate: dateOnly(input.startDate),
        endDate: v.kind === "RECURRING" && input.endDate ? dateOnly(input.endDate) : null,
        maxInvoices: v.kind === "RECURRING" ? (input.maxInvoices ?? null) : v.items.length,
        invoiceDay: input.invoiceDay ?? Number(input.startDate.slice(8, 10)),
        dueInDays: input.dueInDays ?? 14,
        autoSend: owner && !!input.autoSend,
        offeredMethods: input.offeredMethods,
        privateNote: input.privateNote?.trim().slice(0, 2000) || null,
        requestId: input.requestId || null,
        proposedById: actor.id,
        ...(owner ? { approvedById: actor.id, approvedAt: now } : {}),
      },
    });
    if (v.items.length) {
      await tx.billingScheduleItem.createMany({ data: v.items.map((it) => ({ scheduleId: s.id, seq: it.seq, periodKey: it.periodKey, label: it.label, amountCents: it.amountCents, issueDate: it.issueDate ? dateOnly(it.issueDate) : null })) });
    }
    if (first) {
      if (v.items.length) await tx.billingScheduleItem.update({ where: { scheduleId_periodKey: { scheduleId: s.id, periodKey: "1" } }, data: { invoiceId: first.id, generatedAt: now } });
      else await tx.billingScheduleItem.create({ data: { scheduleId: s.id, seq: 1, periodKey: monthKey(input.startDate), label: periodLabel(v.cadence!, input.startDate), amountCents: first.amountCents, issueDate: dateOnly(first.issueDate), invoiceId: first.id, generatedAt: now } });
    }
    return s;
  });
  await ownerAudit(actor.id, owner ? "billing.schedule_created" : "billing.schedule_proposed", "BillingSchedule", s.id, { kind: v.kind, service: input.service, amountCents: input.amountCents, totalCents: input.totalCents ?? null, cadence: v.cadence, autoSend: s.autoSend, warnings: warnings.length, firstInvoiceId: first?.id ?? null });
  if (owner) await generateForSchedule(s.id);
  return s;
}

function periodLabel(cadence: Cadence, date: string) {
  const d = dateOnly(date);
  const month = d.toLocaleString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
  if (cadence === "YEARLY") return `${d.getUTCFullYear()}`;
  if (cadence === "QUARTERLY") return `Quarter starting ${month}`;
  return month;
}

/** Tabitha approves a proposal: it becomes active and anything already due is generated. */
export async function approveSchedule(actor: Actor, scheduleId: string) {
  await assertCanAuthorizeSchedules(actor);
  const res = await prisma.billingSchedule.updateMany({ where: { id: scheduleId, status: "PROPOSED" }, data: { status: "ACTIVE", approvedById: actor.id, approvedAt: new Date() } });
  if (res.count !== 1) throw new ValidationError("Only a schedule awaiting approval can be approved.");
  await ownerAudit(actor.id, "billing.schedule_approved", "BillingSchedule", scheduleId);
  return generateForSchedule(scheduleId);
}

export async function declineSchedule(actor: Actor, scheduleId: string, reason?: string | null) {
  await assertCanAuthorizeSchedules(actor);
  const res = await prisma.billingSchedule.updateMany({ where: { id: scheduleId, status: "PROPOSED" }, data: { status: "DECLINED", declinedAt: new Date() } });
  if (res.count !== 1) throw new ValidationError("Only a schedule awaiting approval can be declined.");
  await ownerAudit(actor.id, "billing.schedule_declined", "BillingSchedule", scheduleId, { reason: reason?.trim().slice(0, 300) || null });
}

/** Tabitha only: future cycles use the new amount/dates; invoices already made are not changed. */
export async function updateSchedule(actor: Actor, scheduleId: string, input: { amountCents?: number; cadence?: string; endDate?: string | null; maxInvoices?: number | null; invoiceDay?: number; dueInDays?: number; autoSend?: boolean }) {
  await assertCanAuthorizeSchedules(actor);
  const s = await prisma.billingSchedule.findUnique({ where: { id: scheduleId }, include: { items: true } });
  if (!s || s.status === "ENDED" || s.status === "DECLINED") throw new ValidationError("This schedule has ended.");
  const data: Prisma.BillingScheduleUpdateInput = {};
  if (input.amountCents !== undefined) {
    if (!Number.isInteger(input.amountCents) || input.amountCents <= 0 || input.amountCents > 100_000_000) throw new ValidationError("Enter an amount greater than $0.");
    if (s.kind !== "RECURRING") throw new ValidationError("A payment plan's amounts are set by its total. End it and make a new plan to change them.");
    data.amountCents = input.amountCents;
  }
  if (input.cadence !== undefined) {
    if (s.kind !== "RECURRING" || !(input.cadence in CADENCES)) throw new ValidationError("Choose monthly, quarterly or yearly.");
    data.cadence = input.cadence;
  }
  if (input.endDate !== undefined) {
    if (input.endDate && (!YMD.test(input.endDate) || input.endDate < ymd(s.startDate))) throw new ValidationError("The end date can't be before the start date.");
    data.endDate = input.endDate ? dateOnly(input.endDate) : null;
  }
  if (input.maxInvoices !== undefined) data.maxInvoices = input.maxInvoices;
  if (input.invoiceDay !== undefined) {
    if (!Number.isInteger(input.invoiceDay) || input.invoiceDay < 1 || input.invoiceDay > 28) throw new ValidationError("Invoice day: 1 to 28.");
    data.invoiceDay = input.invoiceDay;
  }
  if (input.dueInDays !== undefined) {
    if (!Number.isInteger(input.dueInDays) || input.dueInDays < 0 || input.dueInDays > 120) throw new ValidationError("Due in: 0 to 120 days.");
    data.dueInDays = input.dueInDays;
  }
  if (input.autoSend !== undefined) data.autoSend = input.autoSend;
  await prisma.billingSchedule.update({ where: { id: scheduleId }, data });
  await ownerAudit(actor.id, "billing.schedule_changed", "BillingSchedule", scheduleId, { changed: Object.keys(data), from: { amountCents: s.amountCents, cadence: s.cadence, autoSend: s.autoSend } });
}

export async function pauseSchedule(actor: Actor, scheduleId: string) {
  await assertCanAuthorizeSchedules(actor);
  const res = await prisma.billingSchedule.updateMany({ where: { id: scheduleId, status: "ACTIVE" }, data: { status: "PAUSED", pausedAt: new Date() } });
  if (res.count !== 1) throw new ValidationError("Only an active schedule can be paused.");
  await ownerAudit(actor.id, "billing.schedule_paused", "BillingSchedule", scheduleId);
}

/** Resuming never back-bills the paused months: periods dated before today are skipped. */
export async function resumeSchedule(actor: Actor, scheduleId: string) {
  await assertCanAuthorizeSchedules(actor);
  const res = await prisma.billingSchedule.updateMany({ where: { id: scheduleId, status: "PAUSED" }, data: { status: "ACTIVE", pausedAt: null, skipBefore: dateOnly(todayYmd()) } });
  if (res.count !== 1) throw new ValidationError("Only a paused schedule can be resumed.");
  await ownerAudit(actor.id, "billing.schedule_resumed", "BillingSchedule", scheduleId);
  return generateForSchedule(scheduleId);
}

export async function endSchedule(actor: Actor, scheduleId: string, reason?: string | null) {
  await assertCanAuthorizeSchedules(actor);
  const res = await prisma.billingSchedule.updateMany({ where: { id: scheduleId, status: { in: ["ACTIVE", "PAUSED", "PROPOSED"] } }, data: { status: "ENDED", endedAt: new Date() } });
  if (res.count !== 1) throw new ValidationError("This schedule has already ended.");
  await ownerAudit(actor.id, "billing.schedule_ended", "BillingSchedule", scheduleId, { reason: reason?.trim().slice(0, 300) || null });
}

// ---------------------------------------------------------------------------------------------
// Generation
// ---------------------------------------------------------------------------------------------

class AlreadyGenerated extends Error {}

type Due = { periodKey: string; seq: number; label: string; amountCents: number; issueDate: string; itemId: string | null };

/** The cycles of an active schedule that are due by `today` and not yet invoiced. */
export function dueCycles(s: BillingSchedule & { items: BillingScheduleItem[] }, today: string): Due[] {
  if (s.status !== "ACTIVE") return [];
  const skip = s.skipBefore ? ymd(s.skipBefore) : null;
  if (s.kind !== "RECURRING") {
    return s.items
      .filter((it) => !it.invoiceId && it.issueDate && ymd(it.issueDate) <= today && (!skip || ymd(it.issueDate) >= skip))
      .sort((a, b) => a.seq - b.seq)
      .map((it) => ({ periodKey: it.periodKey, seq: it.seq, label: it.label, amountCents: it.amountCents, issueDate: ymd(it.issueDate!), itemId: it.id }));
  }
  const start = ymd(s.startDate);
  const have = new Set(s.items.map((it) => it.periodKey));
  let made = s.items.length;
  const out: Due[] = [];
  for (let k = 0; k < 400; k++) {
    const date = periodDate(start, s.cadence as Cadence, k, s.invoiceDay);
    if (date > today) break;
    if (s.endDate && date > ymd(s.endDate)) break;
    if (s.maxInvoices != null && made >= s.maxInvoices) break;
    if (date < start && monthKey(date) !== monthKey(start)) continue;
    const key = monthKey(date);
    if (have.has(key)) continue;
    if (skip && date < skip) continue;
    out.push({ periodKey: key, seq: s.items.length + out.length + 1, label: periodLabel(s.cadence as Cadence, date), amountCents: s.amountCents!, issueDate: date, itemId: null });
    made++;
  }
  return out;
}

/** True when a recurring schedule can't make any more invoices (end date passed or count reached). */
function finished(s: BillingSchedule & { items: BillingScheduleItem[] }, today: string) {
  if (s.kind !== "RECURRING") return false;
  if (s.maxInvoices != null && s.items.length >= s.maxInvoices) return true;
  return !!s.endDate && today > ymd(s.endDate);
}

async function createCycle(s: BillingSchedule, due: Due): Promise<string | null> {
  const input: FirmInvoiceInput = {
    clientId: s.clientId,
    service: s.service,
    amountCents: due.amountCents,
    description: `${s.description} — ${due.label}`.slice(0, 2000),
    issueDate: due.issueDate,
    dueDate: addDays(due.issueDate, s.dueInDays),
    privateNote: s.privateNote,
    offeredMethods: s.offeredMethods,
  };
  try {
    const { invoice } = await insertFirmInvoice(s.approvedById!, input, async (tx, inv) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`billing-schedule:${s.id}`}))`;
      const existing = await tx.billingScheduleItem.findUnique({ where: { scheduleId_periodKey: { scheduleId: s.id, periodKey: due.periodKey } }, select: { invoiceId: true } });
      if (existing?.invoiceId) throw new AlreadyGenerated();
      const fresh = await tx.billingSchedule.findUnique({ where: { id: s.id }, select: { status: true } });
      if (fresh?.status !== "ACTIVE") throw new AlreadyGenerated();
      if (existing) await tx.billingScheduleItem.update({ where: { scheduleId_periodKey: { scheduleId: s.id, periodKey: due.periodKey } }, data: { invoiceId: inv.id, generatedAt: new Date() } });
      else await tx.billingScheduleItem.create({ data: { scheduleId: s.id, seq: due.seq, periodKey: due.periodKey, label: due.label, amountCents: due.amountCents, issueDate: dateOnly(due.issueDate), invoiceId: inv.id, generatedAt: new Date() } });
    });
    await ownerAudit("system:billing-schedule", "billing.schedule_cycle_created", "Invoice", invoice.id, { scheduleId: s.id, period: due.periodKey, number: invoice.number, amountCents: due.amountCents });
    await ownerAudit("system:billing-schedule", "billing.schedule_cycle_created", "BillingSchedule", s.id, { invoiceId: invoice.id, period: due.periodKey, number: invoice.number });
    // Made for a client's invoice request: its first invoice answers it (Invoice created → sent).
    if (s.requestId) {
      const { linkInvoiceToRequest } = await import("./invoice-requests");
      await linkInvoiceToRequest(s.approvedById!, invoice.id, { requestId: s.requestId }).catch(() => {});
    }
    return invoice.id;
  } catch (e) {
    if (e instanceof AlreadyGenerated || (e as { code?: string }).code === "P2002") return null;
    const problem = e instanceof ValidationError ? e.message : "Couldn't create this cycle's invoice.";
    await prisma.billingSchedule.update({ where: { id: s.id }, data: { lastProblem: `${due.label}: ${problem}` } });
    await ownerAudit("system:billing-schedule", "billing.schedule_cycle_failed", "BillingSchedule", s.id, { period: due.periodKey, problem });
    return null;
  }
}

/**
 * "Send automatically each cycle" (Tabitha's choice, off by default). Goes through the existing send
 * path as Tabitha. Held as a draft — nothing sent — while live sending is off, or if the person who
 * approved the schedule is no longer the owner. Square only when its own switch is on.
 */
async function autoSendCycle(s: BillingSchedule, invoiceId: string): Promise<"sent" | "held"> {
  const hold = async (why: string) => {
    await prisma.billingSchedule.update({ where: { id: s.id }, data: { lastProblem: why } });
    await ownerAudit("system:billing-schedule", "billing.schedule_autosend_held", "Invoice", invoiceId, { scheduleId: s.id, why });
    return "held" as const;
  };
  if (!integrationStatus().liveSendingFlag) return hold("Send automatically is on, but live sending is off, so this cycle was saved as a draft for review.");
  if (!s.approvedById || !(await isPrimaryOwner(s.approvedById))) return hold("Send automatically needs Tabitha's approval on file; this cycle was saved as a draft.");
  const owner = await prisma.user.findUniqueOrThrow({ where: { id: s.approvedById }, select: { id: true, role: true, name: true, email: true } });
  const { squareSendingState } = await import("./square-invoicing");
  const viaSquare = s.offeredMethods.includes("SQUARE_INVOICE") && (await squareSendingState()).live;
  try {
    const r = await approveAndSend(owner, invoiceId, { viaSquare });
    await ownerAudit("system:billing-schedule", "billing.schedule_autosent", "Invoice", invoiceId, { scheduleId: s.id, viaSquare, squareProblem: r.squareProblem });
    if (r.squareProblem) await prisma.billingSchedule.update({ where: { id: s.id }, data: { lastProblem: `Sent to the portal; Square: ${r.squareProblem}` } });
    return "sent";
  } catch (e) {
    return hold(e instanceof ValidationError || e instanceof ForbiddenError ? `Couldn't send automatically: ${e.message} The draft is ready for review.` : "Couldn't send automatically; the draft is ready for review.");
  }
}

/** Makes every due cycle of one schedule (idempotent). */
export async function generateForSchedule(scheduleId: string, today = todayYmd()) {
  const s = await prisma.billingSchedule.findUnique({ where: { id: scheduleId }, include: { items: true } });
  const result = { created: [] as string[], sent: 0, held: 0 };
  if (!s || s.status !== "ACTIVE") return result;
  for (const due of dueCycles(s, today)) {
    const id = await createCycle(s, due);
    if (!id) continue;
    result.created.push(id);
    if (s.autoSend) {
      if ((await autoSendCycle(s, id)) === "sent") result.sent++;
      else result.held++;
    }
  }
  const after = await prisma.billingSchedule.findUniqueOrThrow({ where: { id: scheduleId }, include: { items: true } });
  if (finished(after, today) && after.status === "ACTIVE") {
    await prisma.billingSchedule.updateMany({ where: { id: scheduleId, status: "ACTIVE" }, data: { status: "ENDED", endedAt: new Date() } });
    await ownerAudit("system:billing-schedule", "billing.schedule_completed", "BillingSchedule", scheduleId);
  }
  await prisma.billingSchedule.update({ where: { id: scheduleId }, data: { lastRunAt: new Date(), ...(result.created.length && !result.held ? { lastProblem: null } : {}) } });
  return result;
}

/** The hourly automations cron: every active schedule. Safe to run any number of times. */
export async function runBillingSchedules(today = todayYmd()) {
  const active = await prisma.billingSchedule.findMany({ where: { status: "ACTIVE" }, select: { id: true } });
  const total = { schedules: active.length, created: 0, sent: 0, held: 0 };
  for (const { id } of active) {
    const r = await generateForSchedule(id, today);
    total.created += r.created.length;
    total.sent += r.sent;
    total.held += r.held;
  }
  return total;
}

/**
 * Staff with Billing → Create generate an invoice under a schedule Tabitha already approved: a
 * deposit's balance invoice once the work is done, or a planned installment early.
 */
export async function generateScheduleItem(actor: Actor, scheduleId: string, periodKey: string) {
  await assertCan(actor, "billing", "create", "Creating invoices needs Billing → Create.");
  const s = await prisma.billingSchedule.findUnique({ where: { id: scheduleId }, include: { items: true } });
  if (!s || s.status !== "ACTIVE") throw new ValidationError("Invoices can only be made under an active, approved schedule.");
  const today = todayYmd();
  let due: Due | undefined;
  if (s.kind === "RECURRING") due = dueCycles(s, today).find((d) => d.periodKey === periodKey);
  else {
    const it = s.items.find((x) => x.periodKey === periodKey);
    if (it && !it.invoiceId) due = { periodKey: it.periodKey, seq: it.seq, label: it.label, amountCents: it.amountCents, issueDate: it.issueDate && ymd(it.issueDate) > today ? ymd(it.issueDate) : today, itemId: it.id };
  }
  if (!due) throw new ValidationError("That invoice was already made, or isn't due yet.");
  const id = await createCycle(s, due);
  if (!id) throw new ValidationError((await prisma.billingSchedule.findUnique({ where: { id: scheduleId }, select: { lastProblem: true } }))?.lastProblem ?? "That invoice was already made.");
  await ownerAudit(actor.id, "billing.schedule_item_generated", "BillingSchedule", scheduleId, { period: periodKey, invoiceId: id });
  return id;
}

// ---------------------------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------------------------

async function withMoney(rows: (BillingSchedule & { items: (BillingScheduleItem & { invoice: { id: string; number: string; state: string; payments: { kind: "PAYMENT" | "REFUND" | "CREDIT"; status: "SUCCEEDED" | "FAILED" | "PENDING"; amountCents: number }[] } | null })[]; client: { id: string; displayName: string; businessName: string | null } })[]) {
  const today = todayYmd();
  const users = await prisma.user.findMany({ where: { id: { in: [...new Set(rows.flatMap((r) => [r.proposedById, r.approvedById ?? ""]))] } }, select: { id: true, name: true } });
  const name = (id: string | null) => users.find((u) => u.id === id)?.name ?? null;
  return rows.map((s) => {
    const live = s.items.filter((i) => i.invoice && i.invoice.state !== "VOID");
    const invoicedCents = live.filter((i) => i.invoice!.state !== "DRAFT" && i.invoice!.state !== "PENDING_APPROVAL").reduce((n, i) => n + i.amountCents, 0);
    const paidCents = live.reduce((n, i) => n + cashCollectedCents(i.invoice!.payments) + creditedCents(i.invoice!.payments), 0);
    const planTotal = s.totalCents ?? null;
    const next = s.status === "ACTIVE" ? (s.kind === "RECURRING" ? dueCycles(s, "9999-12-31").find((d) => d.issueDate > today) ?? null : null) : null;
    const nextPlanned = s.kind !== "RECURRING" ? (s.items.filter((i) => !i.invoiceId).sort((a, b) => a.seq - b.seq)[0] ?? null) : null;
    return {
      ...s,
      clientName: s.client.businessName || s.client.displayName,
      proposedByName: name(s.proposedById),
      approvedByName: name(s.approvedById),
      invoicedCents,
      paidCents,
      outstandingCents: Math.max(0, invoicedCents - paidCents),
      remainingCents: planTotal != null ? Math.max(0, planTotal - paidCents) : null,
      nextDate: next?.issueDate ?? (nextPlanned ? (nextPlanned.issueDate ? ymd(nextPlanned.issueDate) : "When the work is done") : null),
      nextAmountCents: next?.amountCents ?? nextPlanned?.amountCents ?? null,
      drafts: live.filter((i) => i.invoice!.state === "DRAFT" || i.invoice!.state === "PENDING_APPROVAL").length,
      monthlyCents: s.kind === "RECURRING" && s.status === "ACTIVE" && s.amountCents ? Math.round(s.amountCents / CADENCES[s.cadence as Cadence].months) : 0,
    };
  });
}

const INCLUDE = {
  items: { orderBy: { seq: "asc" }, include: { invoice: { select: { id: true, number: true, state: true, payments: { select: { kind: true, status: true, amountCents: true } } } } } },
  client: { select: { id: true, displayName: true, businessName: true } },
} satisfies Prisma.BillingScheduleInclude;

export async function scheduleList(actor: Actor, filter: { clientId?: string } = {}) {
  await assertCan(actor, "billing", "view");
  const rows = await prisma.billingSchedule.findMany({ where: filter.clientId ? { clientId: filter.clientId } : {}, include: INCLUDE, orderBy: [{ status: "asc" }, { createdAt: "desc" }] });
  return withMoney(rows);
}
export type ScheduleRow = Awaited<ReturnType<typeof scheduleList>>[number];

export async function scheduleDetail(actor: Actor, scheduleId: string) {
  await assertCan(actor, "billing", "view");
  const s = await prisma.billingSchedule.findUnique({ where: { id: scheduleId }, include: INCLUDE });
  if (!s) return null;
  const [row] = await withMoney([s]);
  const [warnings, history] = await Promise.all([
    scheduleWarnings(s.clientId, s.service),
    prisma.ownerAuditLog.findMany({ where: { entityType: "BillingSchedule", entityId: scheduleId }, orderBy: { createdAt: "asc" } }),
  ]);
  const users = await prisma.user.findMany({ where: { id: { in: history.map((h) => h.actorId) } }, select: { id: true, name: true } });
  return {
    ...row,
    warnings: warnings.filter((w) => w.kind !== "SCHEDULE"),
    history: history.map((h) => ({ id: h.id, at: h.createdAt, action: h.action, who: h.actorId.startsWith("system:") ? "Automatic" : (users.find((u) => u.id === h.actorId)?.name ?? "Staff"), details: h.details as Record<string, unknown> | null })),
    mayAuthorize: await isPrimaryOwner(actor.id),
    mayGenerate: await can(actor, "billing", "create"),
  };
}

/**
 * The Owner's Office billing dashboard, in four separate sections. Each invoice is counted in
 * exactly one section: invoices made by a schedule count under it (plans or recurring); every other
 * firm invoice counts under Tax & individual invoices. Square bookkeeping subscriptions are read-only
 * figures from the last sync and are never mixed into the firm's invoice totals.
 */
export async function billingDashboard(actor: Actor) {
  await assertCan(actor, "billing", "view");
  const [schedules, invoices, scheduled] = await Promise.all([
    scheduleList(actor),
    prisma.invoice.findMany({ where: { scheduleItem: null, state: { notIn: ["DECLINED"] } }, include: { payments: { select: { kind: true, status: true, amountCents: true } }, lines: true, client: { select: { displayName: true, businessName: true } } }, orderBy: { issueDate: "desc" } }),
    prisma.billingScheduleItem.count({ where: { invoiceId: { not: null } } }),
  ]);
  const sent = (st: string) => st === "ISSUED" || st === "ACCEPTED";
  const total = (inv: (typeof invoices)[number]) => (inv.acceptedTerms as { totalCents?: number } | null)?.totalCents ?? inv.lines.reduce((s, l) => s + l.quantity * l.unitCents, 0);
  const oneTime = invoices.filter((i) => i.state !== "VOID" && i.state !== "OFFERED");
  const tax = {
    count: oneTime.length,
    drafts: oneTime.filter((i) => i.state === "DRAFT" || i.state === "PENDING_APPROVAL").length,
    invoicedCents: oneTime.filter((i) => sent(i.state)).reduce((n, i) => n + total(i), 0),
    collectedCents: oneTime.reduce((n, i) => n + cashCollectedCents(i.payments), 0),
    outstandingCents: oneTime.filter((i) => sent(i.state)).reduce((n, i) => n + Math.max(0, total(i) - cashCollectedCents(i.payments) - creditedCents(i.payments)), 0),
    recent: oneTime.slice(0, 8).map((i) => ({ id: i.id, number: i.number, clientName: i.client.businessName || i.client.displayName, title: i.title, state: i.state, totalCents: total(i) })),
  };
  const plans = schedules.filter((s) => s.kind !== "RECURRING");
  const recurring = schedules.filter((s) => s.kind === "RECURRING");
  const sum = (rows: ScheduleRow[], k: "invoicedCents" | "paidCents" | "outstandingCents" | "monthlyCents") => rows.reduce((n, r) => n + r[k], 0);
  const current = (rows: ScheduleRow[]) => rows.filter((r) => r.status !== "DECLINED");
  return {
    tax,
    plans: {
      rows: plans,
      totals: { count: current(plans).length, totalCents: current(plans).reduce((n, r) => n + (r.totalCents ?? 0), 0), paidCents: sum(current(plans), "paidCents"), remainingCents: current(plans).reduce((n, r) => n + (r.remainingCents ?? 0), 0), awaiting: plans.filter((p) => p.status === "PROPOSED").length },
    },
    recurring: {
      rows: recurring,
      totals: { count: recurring.filter((r) => r.status === "ACTIVE").length, monthlyCents: sum(recurring, "monthlyCents"), invoicedCents: sum(current(recurring), "invoicedCents"), outstandingCents: sum(current(recurring), "outstandingCents"), awaiting: recurring.filter((p) => p.status === "PROPOSED").length },
    },
    scheduledInvoices: scheduled,
  };
}
