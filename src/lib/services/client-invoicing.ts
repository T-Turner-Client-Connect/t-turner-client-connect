import "server-only";
import { prisma } from "@/lib/prisma";
import { audit } from "@/lib/audit";
import type { Actor } from "@/lib/auth/actor";
import { normalizeEmail } from "@/lib/normalize";
import { ValidationError } from "./clients";
import { assertLedger, assertLedgerWrite, bookOf, isYmd, parseCents, postEntryTx, reverseEntry, toDate, todayCentral, ymdOf, type LineInput } from "./ledger";

/**
 * Client Invoicing (foundation): a bookkeeping client's own invoices to THEIR customers, kept
 * entirely separate from the office's Square billing.
 *
 * How it reaches the books without double counting:
 * - Issuing an invoice records the receivable (accrual statements only).
 * - A payment goes to "Payments in Transit": accrual books clear the receivable, cash books
 *   record the income on the day it's paid. A processor fee is an expense.
 * - When the bank deposit (for example a Stripe payout) is imported, it is posted to Payments in
 *   Transit — moving money already counted — so the income is never counted a second time.
 *
 * Stripe: test mode only. Any live key is refused until Tabitha approves live payments.
 */

// --- Stripe mode guard -------------------------------------------------------------------------

export type StripeMode = "NOT_CONFIGURED" | "TEST" | "LIVE_BLOCKED";

export function stripeMode(env: Record<string, string | undefined> = process.env): StripeMode {
  const key = env.STRIPE_SECRET_KEY?.trim();
  if (!key) return "NOT_CONFIGURED";
  if (key.startsWith("sk_test_") || key.startsWith("rk_test_")) return "TEST";
  return "LIVE_BLOCKED";
}

/** Called before any Stripe action: only test mode is allowed. */
export function assertStripeTestMode() {
  const mode = stripeMode();
  if (mode === "LIVE_BLOCKED") throw new ValidationError("A live Stripe key is configured. Live payments are turned off until Tabitha approves them — use a test key (sk_test_…).");
  if (mode === "NOT_CONFIGURED") throw new ValidationError("Stripe isn't set up yet. Add a Stripe TEST secret key (sk_test_…) in Netlify.");
}

/** Records the client's own connected Stripe account (test mode). Payments go to that account, never the office's. */
export async function linkStripeTestAccount(actor: Actor, clientId: string, stripeAccountId: string) {
  await assertLedgerWrite(actor, clientId);
  assertStripeTestMode();
  if (!/^acct_[A-Za-z0-9]{8,}$/.test(stripeAccountId)) throw new ValidationError("Enter the connected account ID (acct_…).");
  if (await prisma.stripeConnectAccount.findFirst({ where: { stripeAccountId, NOT: { clientId } } })) throw new ValidationError("That Stripe account is already linked to a different client.");
  const a = await prisma.stripeConnectAccount.upsert({ where: { clientId }, create: { clientId, stripeAccountId, livemode: false, createdById: actor.id }, update: { stripeAccountId, livemode: false } });
  await audit(prisma, { actorId: actor.id, action: "invoicing.stripe_test_account_linked", entityType: "StripeConnectAccount", entityId: clientId, clientId, details: { stripeAccountId } });
  return a;
}

// --- Customers -----------------------------------------------------------------------------------

export async function addCustomer(actor: Actor, clientId: string, input: { name: string; email?: string; phone?: string; address?: string }) {
  await assertLedgerWrite(actor, clientId);
  await bookOf(clientId);
  const name = input.name.trim().slice(0, 120);
  if (!name) throw new ValidationError("Enter the customer's name.");
  const email = input.email?.trim() ? normalizeEmail(input.email) : null;
  if (input.email?.trim() && !email) throw new ValidationError("Enter a valid email address.");
  const c = await prisma.invoiceCustomer.create({ data: { clientId, name, email, phone: input.phone?.trim().slice(0, 40) || null, address: input.address?.trim().slice(0, 300) || null } });
  await audit(prisma, { actorId: actor.id, action: "invoicing.customer_added", entityType: "InvoiceCustomer", entityId: c.id, clientId });
  return c;
}

// --- Invoices ------------------------------------------------------------------------------------

export type InvoiceLineInput = { description: string; quantity?: number; unitPrice: string; incomeAccountId: string };

async function cleanLines(clientId: string, lines: InvoiceLineInput[]) {
  const out = lines
    .filter((l) => l.description.trim() || l.unitPrice.trim())
    .map((l) => {
      const quantity = l.quantity ?? 1;
      if (!Number.isInteger(quantity) || quantity < 1 || quantity > 10000) throw new ValidationError("Quantity must be a whole number.");
      const unitCents = parseCents(l.unitPrice, "price");
      if (unitCents <= 0) throw new ValidationError("Prices must be more than zero.");
      return { description: l.description.trim().slice(0, 200) || "Service", quantity, unitCents, amountCents: unitCents * quantity, incomeAccountId: l.incomeAccountId };
    });
  if (!out.length) throw new ValidationError("Add at least one line.");
  const ids = [...new Set(out.map((l) => l.incomeAccountId))];
  const accounts = await prisma.ledgerAccount.findMany({ where: { id: { in: ids }, clientId, type: "INCOME", active: true } });
  if (accounts.length !== ids.length) throw new ValidationError("Each line needs one of this client's income accounts.");
  return out;
}

export async function createInvoice(actor: Actor, clientId: string, input: { customerId: string; issueDate: string; dueDate: string; lines: InvoiceLineInput[]; memo?: string; recurringId?: string | null }) {
  await assertLedgerWrite(actor, clientId);
  await bookOf(clientId);
  const customer = await prisma.invoiceCustomer.findFirst({ where: { id: input.customerId, clientId, active: true } });
  if (!customer) throw new ValidationError("Choose one of this client's customers.");
  if (!isYmd(input.issueDate) || !isYmd(input.dueDate) || input.dueDate < input.issueDate) throw new ValidationError("Enter the invoice date and a due date on or after it.");
  const lines = await cleanLines(clientId, input.lines);
  const total = lines.reduce((n, l) => n + l.amountCents, 0);
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${"invoice-number:" + clientId}))`;
    const number = `INV-${1001 + (await tx.clientInvoice.count({ where: { clientId } }))}`;
    const inv = await tx.clientInvoice.create({ data: { clientId, customerId: customer.id, number, issueDate: toDate(input.issueDate), dueDate: toDate(input.dueDate), totalCents: total, memo: input.memo?.trim().slice(0, 500) || null, recurringId: input.recurringId ?? null, createdById: actor.id, lines: { create: lines } }, include: { lines: true } });
    await audit(tx, { actorId: actor.id, action: "invoicing.invoice_drafted", entityType: "ClientInvoice", entityId: inv.id, clientId, details: { number, totalCents: total } });
    return inv;
  });
}

/** Issuing records the receivable for accrual statements. Sending the invoice by email is a later step. */
export async function issueInvoice(actor: Actor, clientId: string, invoiceId: string) {
  await assertLedgerWrite(actor, clientId);
  return prisma.$transaction(async (tx) => {
    const inv = await tx.clientInvoice.findFirst({ where: { id: invoiceId, clientId }, include: { lines: true } });
    if (!inv) throw new ValidationError("Invoice not found.");
    if (inv.status !== "DRAFT") throw new ValidationError("Only a draft can be issued.");
    const ar = await tx.ledgerAccount.findFirst({ where: { clientId, subtype: "AR", active: true } });
    if (!ar) throw new ValidationError("Add an Accounts Receivable account first.");
    const lines: LineInput[] = [{ accountId: ar.id, debit: (inv.totalCents / 100).toFixed(2) }, ...inv.lines.map((l) => ({ accountId: l.incomeAccountId, credit: (l.amountCents / 100).toFixed(2), description: l.description }))];
    await postEntryTx(tx, actor, clientId, { date: ymdOf(inv.issueDate), memo: `Invoice ${inv.number}`, lines, source: "INVOICE", sourceKey: `invoice:${inv.id}`, basis: "ACCRUAL_ONLY" });
    const updated = await tx.clientInvoice.update({ where: { id: inv.id }, data: { status: "OPEN", issuedAt: new Date() } });
    await audit(tx, { actorId: actor.id, action: "invoicing.invoice_issued", entityType: "ClientInvoice", entityId: inv.id, clientId, details: { number: inv.number, totalCents: inv.totalCents } });
    return updated;
  });
}

const PAYMENT_METHODS = ["STRIPE_TEST", "CHECK", "CASH", "ACH", "ZELLE", "OTHER"] as const;

/**
 * Records a payment once: to Payments in Transit; the receivable is cleared (accrual), the income
 * is recognized (cash), and any processor fee is an expense. A Stripe payment ID can only be
 * recorded once, so a repeated webhook or a double click never doubles it.
 */
export async function recordInvoicePayment(actor: Actor, clientId: string, invoiceId: string, input: { amount: string; fee?: string; receivedOn: string; method: string; reference?: string; stripePaymentIntentId?: string }) {
  await assertLedgerWrite(actor, clientId);
  if (!PAYMENT_METHODS.includes(input.method as (typeof PAYMENT_METHODS)[number])) throw new ValidationError("Choose how the customer paid.");
  if (input.method === "STRIPE_TEST") assertStripeTestMode();
  if (!isYmd(input.receivedOn) || input.receivedOn > todayCentral()) throw new ValidationError("Enter the date the payment was received (not in the future).");
  const amount = parseCents(input.amount, "payment amount");
  const fee = input.fee?.trim() ? parseCents(input.fee, "processing fee") : 0;
  if (amount <= 0 || fee < 0 || fee >= amount) throw new ValidationError("Enter the payment amount, and a fee smaller than it.");
  const piId = input.stripePaymentIntentId?.trim() || null;
  if (piId && !/^pi_[A-Za-z0-9_]{8,}$/.test(piId)) throw new ValidationError("That isn't a Stripe payment ID (pi_…).");
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${"invoice-pay:" + clientId}))`;
    if (piId && (await tx.clientInvoicePayment.count({ where: { stripePaymentIntentId: piId } }))) throw new ValidationError("That Stripe payment was already recorded.");
    const inv = await tx.clientInvoice.findFirst({ where: { id: invoiceId, clientId }, include: { lines: true } });
    if (!inv) throw new ValidationError("Invoice not found.");
    if (inv.status !== "OPEN" && inv.status !== "PARTIALLY_PAID") throw new ValidationError(inv.status === "DRAFT" ? "Issue the invoice before recording a payment." : `This invoice is ${inv.status === "PAID" ? "already paid" : "void"}.`);
    if (amount > inv.totalCents - inv.paidCents) throw new ValidationError(`That's more than the $${((inv.totalCents - inv.paidCents) / 100).toFixed(2)} still owed.`);
    if (input.receivedOn < ymdOf(inv.issueDate)) throw new ValidationError("A payment can't be dated before the invoice.");
    const [ar, clearing, feeAcct] = await Promise.all([
      tx.ledgerAccount.findFirst({ where: { clientId, subtype: "AR", active: true } }),
      tx.ledgerAccount.findFirst({ where: { clientId, subtype: "CLEARING", active: true } }),
      tx.ledgerAccount.findFirst({ where: { clientId, code: "6150", type: "EXPENSE", active: true } }),
    ]);
    if (!ar || !clearing) throw new ValidationError("Add Accounts Receivable and Payments in Transit accounts first.");
    if (fee && !feeAcct) throw new ValidationError("Add a Merchant Processing Fees expense account (6150) first.");
    const receiptNumber = `R-${String((await tx.clientInvoicePayment.count({ where: { clientId } })) + 1).padStart(4, "0")}`;
    const p = await tx.clientInvoicePayment.create({ data: { clientId, invoiceId: inv.id, amountCents: amount, feeCents: fee, receivedOn: toDate(input.receivedOn), method: input.method, reference: input.reference?.trim().slice(0, 80) || null, stripePaymentIntentId: piId, receiptNumber, createdById: actor.id } });
    const amt = (amount / 100).toFixed(2);
    const memo = `Payment ${receiptNumber} — invoice ${inv.number}`;
    // Accrual: the receivable is collected.
    await postEntryTx(tx, actor, clientId, { date: input.receivedOn, memo, lines: [{ accountId: clearing.id, debit: amt }, { accountId: ar.id, credit: amt }], source: "PAYMENT", sourceKey: `payment:${p.id}:accrual`, basis: "ACCRUAL_ONLY" });
    // Cash: the income is earned when paid, split across the invoice's income accounts.
    const byAccount = new Map<string, number>();
    for (const l of inv.lines) byAccount.set(l.incomeAccountId, (byAccount.get(l.incomeAccountId) ?? 0) + l.amountCents);
    const shares = [...byAccount.entries()].map(([accountId, c]) => ({ accountId, cents: Math.floor((amount * c) / inv.totalCents) }));
    shares[0].cents += amount - shares.reduce((n, s) => n + s.cents, 0); // pennies from rounding go to the first line
    await postEntryTx(tx, actor, clientId, { date: input.receivedOn, memo, lines: [{ accountId: clearing.id, debit: amt }, ...shares.filter((s) => s.cents).map((s) => ({ accountId: s.accountId, credit: (s.cents / 100).toFixed(2) }))], source: "PAYMENT", sourceKey: `payment:${p.id}:cash`, basis: "CASH_ONLY" });
    if (fee) await postEntryTx(tx, actor, clientId, { date: input.receivedOn, memo: `Processing fee — ${memo}`, lines: [{ accountId: feeAcct!.id, debit: (fee / 100).toFixed(2) }, { accountId: clearing.id, credit: (fee / 100).toFixed(2) }], source: "PAYMENT", sourceKey: `payment:${p.id}:fee` });
    const paid = inv.paidCents + amount;
    await tx.clientInvoice.update({ where: { id: inv.id }, data: { paidCents: paid, status: paid >= inv.totalCents ? "PAID" : "PARTIALLY_PAID" } });
    await audit(tx, { actorId: actor.id, action: "invoicing.payment_recorded", entityType: "ClientInvoicePayment", entityId: p.id, clientId, details: { invoice: inv.number, amountCents: amount, feeCents: fee, method: input.method, receipt: receiptNumber } });
    return p;
  });
}

/** A void keeps the invoice with its reason; its receivable is reversed. Paid invoices are refunded, not voided. */
export async function voidInvoice(actor: Actor, clientId: string, invoiceId: string, input: { date: string; reason: string }) {
  await assertLedgerWrite(actor, clientId);
  if (input.reason.trim().length < 5) throw new ValidationError("Record why the invoice is being voided.");
  const inv = await prisma.clientInvoice.findFirst({ where: { id: invoiceId, clientId } });
  if (!inv) throw new ValidationError("Invoice not found.");
  if (inv.status === "VOID") throw new ValidationError("Already void.");
  if (inv.paidCents > 0) throw new ValidationError("This invoice has payments. Record a refund or credit instead of voiding it.");
  if (inv.status !== "DRAFT") {
    const e = await prisma.journalEntry.findFirst({ where: { clientId, sourceKey: `invoice:${inv.id}` } });
    if (e) await reverseEntry(actor, clientId, e.id, { date: input.date, reason: `Invoice ${inv.number} voided: ${input.reason.trim()}`.slice(0, 300) });
  }
  await prisma.clientInvoice.update({ where: { id: inv.id }, data: { status: "VOID", voidedAt: new Date(), voidReason: input.reason.trim().slice(0, 300) } });
  await audit(prisma, { actorId: actor.id, action: "invoicing.invoice_voided", entityType: "ClientInvoice", entityId: inv.id, clientId, details: { number: inv.number, reason: input.reason.trim().slice(0, 300) } });
}

// --- Recurring invoices --------------------------------------------------------------------------

const addMonthsYmd = (ymd: string, n: number) => {
  const [y, m, d] = ymd.split("-").map(Number);
  const last = new Date(Date.UTC(y, m - 1 + n + 1, 0)).getUTCDate();
  const t = new Date(Date.UTC(y, m - 1 + n, Math.min(d, last)));
  return ymdOf(t);
};
const STEP = { MONTHLY: 1, QUARTERLY: 3, YEARLY: 12 } as const;

export async function addRecurringInvoice(actor: Actor, clientId: string, input: { customerId: string; cadence: keyof typeof STEP; startDate: string; dueDays?: number; lines: InvoiceLineInput[]; memo?: string }) {
  await assertLedgerWrite(actor, clientId);
  if (!(input.cadence in STEP)) throw new ValidationError("Choose monthly, quarterly or yearly.");
  if (!isYmd(input.startDate)) throw new ValidationError("Choose the first invoice date.");
  const customer = await prisma.invoiceCustomer.findFirst({ where: { id: input.customerId, clientId, active: true } });
  if (!customer) throw new ValidationError("Choose one of this client's customers.");
  const lines = await cleanLines(clientId, input.lines);
  const dueDays = input.dueDays ?? 15;
  if (!Number.isInteger(dueDays) || dueDays < 0 || dueDays > 120) throw new ValidationError("Due days must be 0–120.");
  const r = await prisma.recurringInvoice.create({ data: { clientId, customerId: customer.id, cadence: input.cadence, startDate: toDate(input.startDate), nextDate: toDate(input.startDate), dueDays, lines: lines.map(({ description, quantity, unitCents, incomeAccountId }) => ({ description, quantity, unitCents, incomeAccountId })), memo: input.memo?.trim().slice(0, 500) || null, createdById: actor.id } });
  await audit(prisma, { actorId: actor.id, action: "invoicing.recurring_added", entityType: "RecurringInvoice", entityId: r.id, clientId, details: { cadence: input.cadence, startDate: input.startDate } });
  return r;
}

/** Creates the DRAFT invoices that are due (each date once). Drafts are reviewed and issued by staff. */
export async function generateRecurringDrafts(actor: Actor, clientId: string, today = todayCentral()) {
  await assertLedgerWrite(actor, clientId);
  const due = await prisma.recurringInvoice.findMany({ where: { clientId, active: true, nextDate: { lte: toDate(today) } } });
  const made: string[] = [];
  for (const r of due) {
    const step = STEP[r.cadence as keyof typeof STEP];
    let periods = r.periods;
    let next = ymdOf(r.nextDate);
    for (let i = 0; i < 24 && next <= today; i++) {
      const lines = (r.lines as { description: string; quantity: number; unitCents: number; incomeAccountId: string }[]).map((l) => ({ description: l.description, quantity: l.quantity, unitPrice: (l.unitCents / 100).toFixed(2), incomeAccountId: l.incomeAccountId }));
      const inv = await createInvoice(actor, clientId, { customerId: r.customerId, issueDate: next, dueDate: ymdOf(new Date(toDate(next).getTime() + r.dueDays * 86_400_000)), lines, memo: r.memo ?? undefined, recurringId: r.id });
      made.push(inv.number);
      periods += 1;
      next = addMonthsYmd(ymdOf(r.startDate), periods * step);
      // Advance after each draft, so a retry never makes the same period twice.
      await prisma.recurringInvoice.update({ where: { id: r.id }, data: { periods, nextDate: toDate(next) } });
    }
  }
  return made;
}

// --- Receivables ---------------------------------------------------------------------------------

/** Open invoices by how overdue they are, as of a date. */
export async function receivablesAging(actor: Actor, clientId: string, asOf = todayCentral()) {
  await assertLedger(actor, clientId);
  const open = await prisma.clientInvoice.findMany({ where: { clientId, status: { in: ["OPEN", "PARTIALLY_PAID"] }, issueDate: { lte: toDate(asOf) } }, include: { customer: { select: { name: true } } }, orderBy: { dueDate: "asc" } });
  const buckets = { current: 0, d1_30: 0, d31_60: 0, d61_90: 0, d90plus: 0 };
  const rows = open.map((i) => {
    const owed = i.totalCents - i.paidCents;
    const late = Math.floor((toDate(asOf).getTime() - i.dueDate.getTime()) / 86_400_000);
    const bucket = late <= 0 ? "current" : late <= 30 ? "d1_30" : late <= 60 ? "d31_60" : late <= 90 ? "d61_90" : "d90plus";
    buckets[bucket] += owed;
    return { id: i.id, number: i.number, customer: i.customer.name, dueDate: ymdOf(i.dueDate), owedCents: owed, daysLate: Math.max(0, late), bucket };
  });
  return { asOf, rows, buckets, totalCents: rows.reduce((n, r) => n + r.owedCents, 0) };
}
