import "server-only";
import { randomUUID } from "node:crypto";
import type { Invoice, InvoiceLine, Payment, PaymentMethod, Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import type { Actor } from "@/lib/auth/actor";
import { ownerAudit } from "@/lib/auth/owner";
import { assertCanChangeBillingSettings, assertCanReconcile, assertCanSendInvoices } from "@/lib/auth/billing-permissions";
import { squareRequest, squareSettings, SquareError, squareWebhookUrl, verifySquareSignature } from "@/lib/square";
import { normalizeEmail, normalizePhone } from "@/lib/normalize";
import { collectedCents, money } from "@/lib/billing/pricing";
import { brandedEmailHtml, sendEmail } from "@/lib/email";
import { appUrl } from "@/lib/integrations";
import { ValidationError } from "./clients";
import { billingSettings, todayYmd, ymd } from "./owner-billing";
import { noteSquareAuthFailure } from "./square-health";

/**
 * Firm invoices sent through the firm's EXISTING Square connection — the same access token,
 * location and API client (src/lib/square.ts) that already reads the recurring bookkeeping
 * invoices. Nothing here connects, replaces or re-authorizes Square.
 *
 * Send: find (or, only when there's no match, create) the client's Square customer → create an
 * Order with one line per service → create a DRAFT Square invoice (balance due on our due date,
 * card + bank transfer) → publish it. Every create carries an idempotency key built from our
 * invoice id and squareRevision, and every Square id is saved as soon as Square returns it, so a
 * retry resumes where it stopped instead of creating a second order or invoice. Publishing is
 * the only step that makes the invoice payable, and it runs only while the owner's "Send
 * invoices through Square" switch is on.
 *
 * Payments: Square webhooks (signed, deduped by event_id) and an hourly reconcile job record
 * each completed Square payment exactly once as a Payment (source "square", providerRef = the
 * Square payment id). Our status (Partially Paid / Paid) follows from the recorded payments.
 *
 * Client Connect never charges a card itself, never stores card details and adds no surcharge.
 */

export const SQUARE_SENDING_OFF = "Square sending is off — Tabitha turns it on in Billing settings.";
export const SQUARE_SYSTEM_ACTOR = "system:square";
/** Square invoice statuses that can still be paid or published. */
const OPEN_STATUSES = ["DRAFT", "UNPAID", "SCHEDULED", "PARTIALLY_PAID", "PAYMENT_PENDING"];
export const SQUARE_STATUS_LABELS: Record<string, string> = {
  DRAFT: "Draft in Square (not published)",
  UNPAID: "Sent — unpaid",
  SCHEDULED: "Scheduled",
  PARTIALLY_PAID: "Partially paid",
  PAYMENT_PENDING: "Payment pending",
  PAID: "Paid",
  CANCELED: "Canceled in Square",
  DELETED: "Draft deleted in Square",
  REFUNDED: "Refunded",
  PARTIALLY_REFUNDED: "Partially refunded",
  FAILED: "Payment failed",
};

type Money = { amount?: number; currency?: string };
export type SqInvoice = {
  id: string;
  version?: number;
  status?: string;
  public_url?: string;
  order_id?: string;
  location_id?: string;
  invoice_number?: string;
  primary_recipient?: { customer_id?: string };
  payment_requests?: { uid?: string; computed_amount_money?: Money; total_completed_amount_money?: Money }[];
};
export type SqPayment = { id: string; status?: string; amount_money?: Money; source_type?: string; created_at?: string; order_id?: string; customer_id?: string; receipt_url?: string; refunded_money?: Money };
type SqCustomer = { id: string; email_address?: string; phone_number?: string; created_at?: string };

const enc = encodeURIComponent;
const centralDay = (d: Date) => d.toLocaleDateString("en-CA", { timeZone: "America/Chicago" });

// ---------------------------------------------------------------------------
// The switch and delivery settings (owner only)
// ---------------------------------------------------------------------------

export async function squareSendingState() {
  const s = await billingSettings();
  const cfg = squareSettings();
  const enabled = !!s.squareSendingEnabledAt;
  return {
    enabled,
    configured: cfg.configured,
    live: enabled && cfg.configured,
    env: cfg.env,
    delivery: (s.squareDelivery === "EMAIL" ? "EMAIL" : "SHARE_MANUALLY") as "EMAIL" | "SHARE_MANUALLY",
    acceptBank: s.squareAcceptBank,
    enabledAt: s.squareSendingEnabledAt,
    enabledById: s.squareSendingEnabledById,
    webhookKeySet: !!process.env.SQUARE_WEBHOOK_SIGNATURE_KEY?.trim(),
    webhookUrl: squareWebhookUrl(appUrl()),
    message: !enabled
      ? SQUARE_SENDING_OFF
      : !cfg.configured
        ? "Square isn't configured on this site (SQUARE_ACCESS_TOKEN, SQUARE_LOCATION_ID and SQUARE_APPLICATION_ID in Netlify), so nothing can be sent through Square."
        : null,
  };
}

/** "Send invoices through Square": Tabitha's one switch for live Square invoices. Audited. */
export async function setSquareSending(actor: Actor, enabled: boolean) {
  await assertCanChangeBillingSettings(actor);
  await billingSettings();
  const cfg = squareSettings();
  await prisma.billingSettings.update({
    where: { id: "default" },
    data: enabled ? { squareSendingEnabledAt: new Date(), squareSendingEnabledById: actor.id } : { squareSendingEnabledAt: null, squareSendingEnabledById: null },
  });
  await ownerAudit(actor.id, enabled ? "billing.square_sending_enabled" : "billing.square_sending_disabled", "BillingSettings", "default", { environment: cfg.env, configured: cfg.configured });
}

export async function setSquareDeliveryOptions(actor: Actor, input: { delivery: string; acceptBank: boolean }) {
  await assertCanChangeBillingSettings(actor);
  if (input.delivery !== "EMAIL" && input.delivery !== "SHARE_MANUALLY") throw new ValidationError("Choose how the Square invoice reaches the client.");
  await billingSettings();
  await prisma.billingSettings.update({ where: { id: "default" }, data: { squareDelivery: input.delivery, squareAcceptBank: input.acceptBank } });
  await ownerAudit(actor.id, "billing.square_delivery_saved", "BillingSettings", "default", { delivery: input.delivery, acceptBank: input.acceptBank });
}

// ---------------------------------------------------------------------------
// What we send (pure — also shown to staff as a preview while the switch is off)
// ---------------------------------------------------------------------------

type PlanInvoice = Pick<Invoice, "id" | "number" | "title" | "issueDate" | "dueDate" | "acceptedTerms" | "acceptedOption" | "squareRevision"> & { lines: InvoiceLine[]; payments: Pick<Payment, "kind" | "status" | "amountCents">[] };

export function squareKey(inv: { id: string; squareRevision: number }, step: string) {
  return `tcc-${inv.id}-r${inv.squareRevision}-${step}`;
}

/** Amounts as Square will bill them; throws when an invoice can't be expressed as a Square invoice. */
export function squareAmounts(inv: PlanInvoice) {
  const lines = [...inv.lines].sort((a, b) => a.sortOrder - b.sortOrder);
  const linesTotal = lines.reduce((s, l) => s + l.quantity * l.unitCents, 0);
  const total = (inv.acceptedTerms as { totalCents?: number } | null)?.totalCents ?? linesTotal;
  if (inv.acceptedOption === "PLAN") throw new ValidationError("Payment-plan invoices can't be sent through Square. Record plan payments here, or send a separate invoice per installment.");
  if (total !== linesTotal) throw new ValidationError("This quote has a discount or tax that Square wouldn't show the same way, so it can't be sent through Square. Use Create Invoice for a Square invoice.");
  const applied = collectedCents(inv.payments.map((p) => ({ kind: p.kind, status: p.status, amountCents: p.amountCents })));
  const due = total - applied;
  if (due <= 0) throw new ValidationError("Nothing is owed on this invoice, so there's nothing to send through Square.");
  return { lines, total, applied, due };
}

export function squareInvoicePlan(inv: PlanInvoice, ctx: { locationId: string; customerId: string; delivery: "EMAIL" | "SHARE_MANUALLY"; acceptBank: boolean; today: string }) {
  const { lines, applied } = squareAmounts(inv);
  const due = ymd(inv.dueDate) < ctx.today ? ctx.today : ymd(inv.dueDate);
  return {
    order: {
      location_id: ctx.locationId,
      customer_id: ctx.customerId,
      reference_id: inv.number.slice(0, 40),
      line_items: lines.map((l) => ({
        name: l.service.slice(0, 512),
        quantity: String(l.quantity),
        base_price_money: { amount: l.unitCents, currency: "USD" },
        ...(l.description ? { note: l.description.slice(0, 2000) } : {}),
      })),
      // Money already received offline (or credited) is shown as applied, so Square bills only the balance.
      ...(applied > 0 ? { discounts: [{ uid: "applied", name: "Payments and credits already applied", amount_money: { amount: applied, currency: "USD" }, scope: "ORDER" }] } : {}),
    },
    invoice: {
      location_id: ctx.locationId,
      primary_recipient: { customer_id: ctx.customerId },
      payment_requests: [{ request_type: "BALANCE", due_date: due, automatic_payment_source: "NONE" }],
      delivery_method: ctx.delivery,
      invoice_number: inv.number,
      title: inv.title.slice(0, 255),
      description: "Thank you for choosing T. Turner & Associates, LLC. Questions? Call 205-639-1000.",
      sale_or_service_date: ymd(inv.issueDate),
      accepted_payment_methods: { card: true, bank_account: ctx.acceptBank, square_gift_card: false, buy_now_pay_later: false, cash_app_pay: false },
      store_payment_method_enabled: false,
    },
  };
}

// ---------------------------------------------------------------------------
// Customer: reuse before create
// ---------------------------------------------------------------------------

type CustomerSource = { id: string; clientId: string; squareCustomerId: string | null; billingEmail: string | null; billingPhone: string | null; billingName: string | null };

async function customerExists(id: string) {
  try {
    return (await squareRequest<{ customer?: SqCustomer }>("GET", `/v2/customers/${enc(id)}`)).customer?.id === id;
  } catch (e) {
    if (e instanceof SquareError && e.status === 404) return false;
    throw e;
  }
}

async function searchCustomers(filter: Record<string, unknown>) {
  return (await squareRequest<{ customers?: SqCustomer[] }>("POST", "/v2/customers/search", { query: { filter }, limit: 20 })).customers ?? [];
}

/**
 * The client's Square customer. In order: the one this invoice already uses; the customer the
 * client is linked to under Square billing (or verified on the bookkeeping profile); the one an
 * earlier Square invoice used; an exact email match; an exact phone match. Only with no match at
 * all is a customer created — with an idempotency key per client, so it can't be created twice.
 */
export async function findOrCreateSquareCustomer(inv: CustomerSource): Promise<{ id: string; how: string }> {
  if (inv.squareCustomerId) return { id: inv.squareCustomerId, how: "invoice" };
  const [member, profile, previous, client] = await Promise.all([
    prisma.squareBillingMember.findFirst({ where: { clientId: inv.clientId }, include: { arrangement: { select: { squareCustomerId: true } } }, orderBy: { createdAt: "asc" } }),
    prisma.bookkeepingBilling.findUnique({ where: { clientId: inv.clientId }, select: { squareCustomerId: true, squareCustomerIdSource: true } }),
    prisma.invoice.findFirst({ where: { clientId: inv.clientId, squareCustomerId: { not: null }, id: { not: inv.id } }, orderBy: { squareSentAt: "desc" }, select: { squareCustomerId: true } }),
    prisma.client.findUniqueOrThrow({ where: { id: inv.clientId }, select: { firstName: true, lastName: true, businessName: true, displayName: true } }),
  ]);
  const known: [string | null | undefined, string][] = [
    [member?.arrangement.squareCustomerId, "linked"],
    // A hand-typed, never-verified ID is not trusted.
    [profile?.squareCustomerIdSource === "MANUAL" ? null : profile?.squareCustomerId, "profile"],
    [previous?.squareCustomerId, "previous"],
  ];
  for (const [id, how] of known) if (id && (await customerExists(id))) return { id, how };

  const email = normalizeEmail(inv.billingEmail);
  const phone = normalizePhone(inv.billingPhone);
  const oldest = (list: SqCustomer[]) => [...list].sort((a, b) => (a.created_at ?? "").localeCompare(b.created_at ?? ""))[0];
  if (email) {
    const hits = await searchCustomers({ email_address: { exact: email } });
    if (hits.length) return { id: (oldest(hits.filter((c) => phone && normalizePhone(c.phone_number) === phone)) ?? oldest(hits)).id, how: "email" };
  }
  if (phone) {
    const hits = await searchCustomers({ phone_number: { exact: phone } });
    if (hits.length) return { id: oldest(hits).id, how: "phone" };
  }
  const name = client.businessName ? { company_name: client.businessName } : client.firstName || client.lastName ? { given_name: client.firstName ?? undefined, family_name: client.lastName ?? undefined } : { company_name: client.displayName };
  const created = await squareRequest<{ customer: SqCustomer }>("POST", "/v2/customers", {
    idempotency_key: `tcc-cust-${inv.clientId}`,
    reference_id: inv.clientId,
    ...name,
    ...(email ? { email_address: email } : {}),
    ...(phone ? { phone_number: phone } : {}),
  });
  return { id: created.customer.id, how: "created" };
}

// ---------------------------------------------------------------------------
// Send via Square
// ---------------------------------------------------------------------------

async function loadInvoice(id: string) {
  const inv = await prisma.invoice.findUnique({ where: { id }, include: { lines: true, payments: true } });
  if (!inv) throw new ValidationError("Not found.");
  return inv;
}

/** A short named lock (JobLock row) so two clicks can't run the Square steps at the same time. */
async function withLock<T>(name: string, fn: () => Promise<T>, busy: string): Promise<T> {
  const runId = randomUUID();
  const now = new Date();
  const until = new Date(now.getTime() + 2 * 60_000);
  let got = (await prisma.jobLock.updateMany({ where: { name, lockedUntil: { lt: now } }, data: { lockedUntil: until, runId } })).count === 1;
  if (!got) got = await prisma.jobLock.create({ data: { name, lockedUntil: until, runId } }).then(() => true, () => false);
  if (!got) throw new ValidationError(busy);
  try {
    return await fn();
  } finally {
    await prisma.jobLock.updateMany({ where: { name, runId }, data: { lockedUntil: new Date(0), runId: null } }).catch(() => {});
  }
}

export type SquareSendResult = { url: string; already: boolean; emailedTo: string | null; emailProblem: string | null; delivery: "EMAIL" | "SHARE_MANUALLY" };

/**
 * Sends an approved invoice through Square. Owner or staff with billing access
 * (canSendInvoices). Refused — before any call to Square — while "Send invoices through
 * Square" is off. Safe to retry: completed steps are skipped and Square de-duplicates the rest.
 */
export async function sendInvoiceViaSquare(actor: Actor, invoiceId: string): Promise<SquareSendResult> {
  await assertCanSendInvoices(actor);
  const state = await squareSendingState();
  let inv = await loadInvoice(invoiceId);
  if (!(inv.state === "ISSUED" || (inv.state === "ACCEPTED" && inv.acceptedOption === "FULL"))) throw new ValidationError("Approve and send the invoice first; then it can go through Square.");
  if (inv.squarePublicUrl && inv.squareStatus && (OPEN_STATUSES.includes(inv.squareStatus) || inv.squareStatus === "PAID") && inv.squareStatus !== "DRAFT") {
    return { url: inv.squarePublicUrl, already: true, emailedTo: null, emailProblem: null, delivery: state.delivery };
  }
  if (!state.enabled) throw new ValidationError(SQUARE_SENDING_OFF);
  if (!state.configured) throw new ValidationError(state.message ?? "Square isn't configured.");
  squareAmounts(inv);
  const squareApproved = await prisma.paymentInstruction.count({ where: { method: "SQUARE_INVOICE", active: true } });
  if (!squareApproved) throw new ValidationError("Square isn't an approved payment option yet. Tabitha turns it on under Payment instructions in Billing settings.");
  const { locationId } = squareSettings();

  return withLock(`square-send:${invoiceId}`, async () => {
    inv = await loadInvoice(invoiceId);
    // Canceled in Square (for example from the Square Dashboard) but still open here: start a new
    // Square invoice under a new revision, so the old idempotency keys can't return the canceled one.
    if (inv.squareStatus === "CANCELED" || inv.squareStatus === "DELETED") {
      inv = await prisma.invoice.update({ where: { id: inv.id }, data: { squareRevision: { increment: 1 }, squareOrderId: null, squareInvoiceId: null, squareInvoiceVersion: null, squareStatus: null, squarePublicUrl: null, squareEmailSentAt: null }, include: { lines: true, payments: true } });
    }
    const save = (data: Prisma.InvoiceUpdateInput) => prisma.invoice.update({ where: { id: inv.id }, data, include: { lines: true, payments: true } });
    try {
      let how = "invoice";
      if (!inv.squareCustomerId) {
        const c = await findOrCreateSquareCustomer(inv);
        how = c.how;
        inv = await save({ squareCustomerId: c.id });
      }
      const plan = squareInvoicePlan(inv, { locationId, customerId: inv.squareCustomerId!, delivery: state.delivery, acceptBank: state.acceptBank, today: todayYmd() });
      if (!inv.squareOrderId) {
        const { order } = await squareRequest<{ order: { id: string } }>("POST", "/v2/orders", { idempotency_key: squareKey(inv, "order"), order: plan.order });
        inv = await save({ squareOrderId: order.id });
      }
      if (!inv.squareInvoiceId) {
        const { invoice } = await squareRequest<{ invoice: SqInvoice }>("POST", "/v2/invoices", { idempotency_key: squareKey(inv, "invoice"), invoice: { ...plan.invoice, order_id: inv.squareOrderId } });
        inv = await save({ squareInvoiceId: invoice.id, squareInvoiceVersion: invoice.version ?? 0, squareStatus: invoice.status ?? "DRAFT" });
      }
      if (!inv.squareStatus || inv.squareStatus === "DRAFT") {
        const { invoice } = await squareRequest<{ invoice: SqInvoice }>("POST", `/v2/invoices/${enc(inv.squareInvoiceId!)}/publish`, { version: inv.squareInvoiceVersion ?? 0, idempotency_key: squareKey(inv, `publish-v${inv.squareInvoiceVersion ?? 0}`) });
        inv = await save({ squareInvoiceVersion: invoice.version ?? null, squareStatus: invoice.status ?? "UNPAID", squarePublicUrl: invoice.public_url ?? null, squareSentAt: new Date(), squareSentById: actor.id, squareSyncedAt: new Date(), squareError: null, offeredMethods: inv.offeredMethods.includes("SQUARE_INVOICE") ? undefined : { set: ["SQUARE_INVOICE", ...inv.offeredMethods] } });
        await ownerAudit(actor.id, "billing.square_invoice_sent", "Invoice", inv.id, { squareInvoiceId: inv.squareInvoiceId, delivery: state.delivery, customer: how, environment: state.env });
      }
      if (!inv.squarePublicUrl) {
        const { invoice } = await squareRequest<{ invoice: SqInvoice }>("GET", `/v2/invoices/${enc(inv.squareInvoiceId!)}`);
        inv = await save({ squarePublicUrl: invoice.public_url ?? null, squareStatus: invoice.status ?? inv.squareStatus, squareInvoiceVersion: invoice.version ?? inv.squareInvoiceVersion });
      }
      if (!inv.squarePublicUrl) throw new ValidationError("Square published the invoice but didn't return its payment page yet. Use “Refresh from Square” in a minute.");
      let emailedTo: string | null = null;
      let emailProblem: string | null = null;
      if (state.delivery === "SHARE_MANUALLY" && !inv.squareEmailSentAt) ({ emailedTo, emailProblem } = await emailSquareLink(actor.id, inv));
      return { url: inv.squarePublicUrl, already: false, emailedTo, emailProblem, delivery: state.delivery };
    } catch (e) {
      if (e instanceof SquareError) {
        await noteSquareAuthFailure(e.status, e.code).catch(() => {});
        await prisma.invoice.update({ where: { id: inv.id }, data: { squareError: e.message.slice(0, 500) } });
        await ownerAudit(actor.id, "billing.square_send_failed", "Invoice", inv.id, { status: e.status ?? null, code: e.code ?? null });
        throw new ValidationError(`Square didn't accept this invoice: ${e.message} Nothing was charged. Trying again is safe — it won't create a duplicate.`);
      }
      throw e;
    }
  }, "This invoice is being sent through Square right now. Refresh in a moment.");
}

/** Our branded email with the Square payment link (delivery "Share manually"), through sendEmail. */
async function emailSquareLink(actorId: string, inv: Invoice, idempotencyKey = squareKey(inv, "email")): Promise<{ emailedTo: string | null; emailProblem: string | null }> {
  const to = normalizeEmail(inv.billingEmail);
  if (!to) {
    const problem = "The Square payment link is ready, but the client record has no email address, so no email was sent. Copy the link to the client, or add an email and use “Email the Square link”.";
    await prisma.invoice.update({ where: { id: inv.id }, data: { squareError: problem } });
    return { emailedTo: null, emailProblem: problem };
  }
  const url = inv.squarePublicUrl!;
  const due = new Date(`${ymd(inv.dueDate)}T12:00:00Z`).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" });
  const portal = `${appUrl()}/client/billing`;
  const res = await sendEmail({
    to,
    subject: `Invoice ${inv.number} from T. Turner & Associates`,
    text: `Your invoice ${inv.number} from T. Turner & Associates, LLC (${inv.title}) is ready, due ${due}.\n\nPay securely with Square (card or bank transfer): ${url}\n\nYou can also view it in your client portal: ${portal}\n\nWe never see or store your card number. Questions? Call 205-639-1000.`,
    html: brandedEmailHtml({
      heading: `Invoice ${inv.number} is ready`,
      paragraphs: [`Your invoice from T. Turner & Associates, LLC for ${inv.title} is ready, due ${due}.`, "Pay securely through Square by card or bank transfer. We never see or store your card number."],
      button: { label: "Pay securely with Square", url },
      note: `You can also view this invoice in your client portal: ${portal}. Questions? Call 205-639-1000.`,
    }),
    idempotencyKey,
    tags: { kind: "square_invoice" },
  });
  if (!res.ok) {
    const problem = `The Square payment link is ready, but our email wasn't sent: ${res.detail}`;
    await prisma.invoice.update({ where: { id: inv.id }, data: { squareError: problem } });
    return { emailedTo: null, emailProblem: problem };
  }
  await prisma.invoice.update({ where: { id: inv.id }, data: { squareEmailSentAt: new Date(), squareError: null } });
  await ownerAudit(actorId, "billing.square_invoice_emailed", "Invoice", inv.id);
  return { emailedTo: to, emailProblem: null };
}

/** Sends (or re-sends) our branded email with the Square link. */
export async function resendSquareLink(actor: Actor, invoiceId: string) {
  await assertCanSendInvoices(actor);
  const inv = await loadInvoice(invoiceId);
  if (!inv.squarePublicUrl || !inv.squareStatus || !OPEN_STATUSES.includes(inv.squareStatus)) throw new ValidationError("This invoice has no open Square payment link to email.");
  const r = await emailSquareLink(actor.id, inv, squareKey(inv, `email-${randomUUID()}`));
  if (r.emailProblem) throw new ValidationError(r.emailProblem);
  return r.emailedTo!;
}

// ---------------------------------------------------------------------------
// Payments from Square (webhook, reconcile job, staff review)
// ---------------------------------------------------------------------------

function methodOf(sourceType: string | undefined): PaymentMethod {
  if (sourceType === "CARD") return "CARD";
  if (sourceType === "BANK_ACCOUNT") return "ACH";
  return "OTHER";
}

async function noteSeen(tx: Prisma.TransactionClient, p: SqPayment, fields: { state: string; invoiceId?: string | null; paymentId?: string | null; note?: string | null; keepReviewed?: boolean }) {
  const base = { squareOrderId: p.order_id ?? null, squareCustomerId: p.customer_id ?? null, amountCents: p.amount_money?.amount ?? 0, status: p.status ?? "UNKNOWN", paidAt: p.created_at ? new Date(p.created_at) : null, sourceType: p.source_type ?? null };
  const existing = await tx.squarePaymentSeen.findUnique({ where: { squarePaymentId: p.id } });
  if (!existing) return tx.squarePaymentSeen.create({ data: { squarePaymentId: p.id, ...base, state: fields.state, invoiceId: fields.invoiceId ?? null, paymentId: fields.paymentId ?? null, note: fields.note ?? null } });
  // A payment already matched or dismissed by staff keeps that decision.
  const settled = existing.state === "MATCHED" || (fields.keepReviewed && existing.state === "DISMISSED");
  return tx.squarePaymentSeen.update({ where: { id: existing.id }, data: { ...base, ...(settled ? {} : { state: fields.state, invoiceId: fields.invoiceId ?? null, paymentId: fields.paymentId ?? null, note: fields.note ?? existing.note }) } });
}

/**
 * Records one completed Square payment on our invoice, exactly once (the Square payment id is
 * Payment.providerRef, unique). Returns "duplicate" when it's already recorded.
 */
export async function recordSquarePayment(invoiceId: string, p: SqPayment, by = SQUARE_SYSTEM_ACTOR): Promise<"recorded" | "duplicate" | "review" | "skipped"> {
  const amount = p.amount_money?.amount ?? 0;
  if (p.status !== "COMPLETED" || amount <= 0) return "skipped";
  const receivedOn = centralDay(p.created_at ? new Date(p.created_at) : new Date());
  try {
    return await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`invoice-pay:${invoiceId}`}))`;
      if (await tx.payment.findUnique({ where: { providerRef: p.id } })) return "duplicate" as const;
      const inv = await tx.invoice.findUnique({ where: { id: invoiceId }, include: { payments: true } });
      if (!inv || (inv.state !== "ISSUED" && inv.state !== "ACCEPTED")) {
        await noteSeen(tx, p, { state: "UNMATCHED", invoiceId, note: `Paid in Square, but invoice ${inv?.number ?? ""} is ${inv?.state === "VOID" ? "voided" : "not open"} here. Review: refund in Square, or reopen.` });
        return "review" as const;
      }
      const created = await tx.payment.create({
        data: { invoiceId, clientId: inv.clientId, kind: "PAYMENT", status: "SUCCEEDED", amountCents: amount, receivedOn: new Date(`${receivedOn}T00:00:00.000Z`), method: methodOf(p.source_type), source: "square", providerRef: p.id, reference: p.id, note: "Paid through Square", createdById: by },
      });
      await tx.ownerAuditLog.create({ data: { actorId: by, action: "billing.payment_succeeded", entityType: "Payment", entityId: created.id, details: { invoiceId, amountCents: amount, method: created.method, source: "square", squarePaymentId: p.id } } });
      const total = (inv.acceptedTerms as { totalCents?: number } | null)?.totalCents ?? 0;
      const after = collectedCents([...inv.payments, created]);
      await noteSeen(tx, p, { state: "MATCHED", invoiceId, paymentId: created.id, note: after > total ? `Overpaid by ${money(after - total)} — review (refund in Square or apply to another invoice).` : null });
      if (after > total) await tx.invoice.update({ where: { id: invoiceId }, data: { squareError: `Square collected ${money(after - total)} more than the balance. Review on the Reconcile screen.` } });
      return "recorded" as const;
    });
  } catch (e) {
    if ((e as { code?: string }).code === "P2002") return "duplicate";
    throw e;
  }
}

/**
 * Reads our Square invoice (unless given fresh from a search) and records any completed payment
 * not yet recorded. Read-only toward Square. Used by the webhook, the reconcile job and "Refresh".
 */
export async function syncSquareInvoice(invoiceId: string, given?: SqInvoice) {
  const inv = await prisma.invoice.findUnique({ where: { id: invoiceId }, include: { payments: true } });
  if (!inv?.squareInvoiceId) return null;
  const sq = given ?? (await squareRequest<{ invoice: SqInvoice }>("GET", `/v2/invoices/${enc(inv.squareInvoiceId)}`)).invoice;
  const completed = (sq.payment_requests ?? []).reduce((s, r) => s + (r.total_completed_amount_money?.amount ?? 0), 0);
  const recorded = inv.payments.filter((p) => p.source === "square" && p.kind === "PAYMENT" && p.status === "SUCCEEDED").reduce((s, p) => s + p.amountCents, 0);
  let newPayments = 0;
  const orderId = sq.order_id ?? inv.squareOrderId;
  if (completed > recorded && orderId) {
    const { order } = await squareRequest<{ order: { tenders?: { payment_id?: string }[] } }>("GET", `/v2/orders/${enc(orderId)}`);
    for (const t of order.tenders ?? []) {
      if (!t.payment_id || inv.payments.some((p) => p.providerRef === t.payment_id)) continue;
      const { payment } = await squareRequest<{ payment: SqPayment }>("GET", `/v2/payments/${enc(t.payment_id)}`);
      if ((await recordSquarePayment(inv.id, payment)) === "recorded") newPayments++;
    }
  }
  // An older event can't roll the status back.
  const stale = sq.version !== undefined && inv.squareInvoiceVersion !== null && sq.version < inv.squareInvoiceVersion;
  await prisma.invoice.update({
    where: { id: inv.id },
    data: {
      squareSyncedAt: new Date(),
      ...(stale ? {} : { squareStatus: sq.status ?? inv.squareStatus, squareInvoiceVersion: sq.version ?? inv.squareInvoiceVersion, squarePublicUrl: sq.public_url ?? inv.squarePublicUrl }),
      ...(!stale && sq.status === "CANCELED" && inv.state !== "VOID" ? { squareError: "Canceled in Square. The client can't pay it there any more — void it here, or send it through Square again." } : {}),
    },
  });
  return { status: stale ? inv.squareStatus : sq.status ?? null, newPayments };
}

/** Staff button: re-read one invoice from Square now. */
export async function refreshSquareInvoice(actor: Actor, invoiceId: string) {
  await assertCanReconcile(actor);
  try {
    return await syncSquareInvoice(invoiceId);
  } catch (e) {
    if (e instanceof SquareError) throw new ValidationError(e.message);
    throw e;
  }
}

// ---------------------------------------------------------------------------
// Webhook
// ---------------------------------------------------------------------------

type SquareEvent = { event_id?: string; type?: string; data?: { type?: string; id?: string; object?: { invoice?: SqInvoice; payment?: SqPayment } } };

/**
 * Handles one Square webhook delivery. The signature must match SQUARE_WEBHOOK_SIGNATURE_KEY and
 * the notification URL; each event_id is applied once (a failed attempt is retried by Square
 * and re-applied; a processed one is ignored).
 */
export async function handleSquareWebhook(raw: string, signature: string | null): Promise<{ status: number; body: string }> {
  const key = process.env.SQUARE_WEBHOOK_SIGNATURE_KEY?.trim();
  if (!key) return { status: 503, body: "Not configured" };
  if (!verifySquareSignature(key, squareWebhookUrl(appUrl()), raw, signature)) return { status: 403, body: "Invalid signature" };
  let ev: SquareEvent;
  try {
    ev = JSON.parse(raw);
  } catch {
    return { status: 400, body: "Bad payload" };
  }
  if (!ev.event_id || !ev.type) return { status: 400, body: "Bad payload" };
  const objectId = ev.data?.object?.invoice?.id ?? ev.data?.object?.payment?.id ?? ev.data?.id ?? null;
  const existing = await prisma.squareWebhookEvent.findUnique({ where: { eventId: ev.event_id } });
  if (existing?.processedAt) return { status: 200, body: "Already processed" };
  if (!existing) {
    const made = await prisma.squareWebhookEvent.create({ data: { eventId: ev.event_id, type: ev.type, objectId } }).then(() => true, () => false);
    if (!made) return { status: 200, body: "Already received" };
  }
  try {
    const result = await applySquareEvent(ev);
    await prisma.squareWebhookEvent.update({ where: { eventId: ev.event_id }, data: { processedAt: new Date(), result } });
    return { status: 200, body: result };
  } catch (e) {
    const code = e instanceof SquareError ? (e.code ?? `HTTP_${e.status ?? 0}`) : "ERROR";
    await prisma.squareWebhookEvent.update({ where: { eventId: ev.event_id }, data: { result: `failed: ${code}` } }).catch(() => {});
    console.warn(`square webhook ${ev.event_id} (${ev.type}) failed: ${code}`);
    // Square retries non-2xx deliveries; the next attempt re-applies the event.
    return { status: 500, body: "Retry later" };
  }
}

async function applySquareEvent(ev: SquareEvent): Promise<string> {
  const type = ev.type!;
  if (type === "invoice.payment_made" || type === "invoice.updated" || type === "invoice.canceled" || type === "invoice.published" || type === "invoice.refunded") {
    const id = ev.data?.object?.invoice?.id ?? ev.data?.id;
    const ours = id ? await prisma.invoice.findUnique({ where: { squareInvoiceId: id }, select: { id: true } }) : null;
    if (!ours) return "Not a Client Connect invoice";
    const r = await syncSquareInvoice(ours.id);
    return `Synced: ${r?.status ?? "unknown"}, ${r?.newPayments ?? 0} new payment(s)`;
  }
  if (type === "payment.updated" || type === "payment.created") {
    const p = ev.data?.object?.payment;
    if (!p?.id) return "No payment in event";
    if (p.status !== "COMPLETED") return `Payment ${p.status ?? "unknown"}: nothing to record`;
    const ours = p.order_id ? await prisma.invoice.findUnique({ where: { squareOrderId: p.order_id }, select: { id: true } }) : null;
    if (ours) {
      const r = await recordSquarePayment(ours.id, p);
      // Status refresh is best-effort: the payment itself is already recorded.
      await syncSquareInvoice(ours.id).catch(() => null);
      return `Payment ${r}`;
    }
    const recurring = p.customer_id ? await prisma.squareBillingArrangement.count({ where: { squareCustomerId: p.customer_id } }) : 0;
    await prisma.$transaction((tx) => noteSeen(tx, p, { state: recurring ? "RECURRING" : "UNMATCHED", keepReviewed: true, note: recurring ? "Recurring billing in Square (tracked under Square billing)." : null }));
    return recurring ? "Recurring Square billing payment" : "Unmatched payment queued for review";
  }
  return "Ignored";
}

// ---------------------------------------------------------------------------
// Reconcile job (hourly cron) — the backup for a missed webhook
// ---------------------------------------------------------------------------

export async function reconcileSquareInvoices(now = new Date()) {
  if (!squareSettings().configured) return { checked: 0, newPayments: 0, failed: 0, skipped: "not configured" };
  try {
    return await withLock("square-invoice-reconcile", async () => {
      const open = await prisma.invoice.findMany({
        where: { squareInvoiceId: { not: null }, OR: [{ squareStatus: null }, { squareStatus: { in: OPEN_STATUSES } }] },
        select: { id: true, squareInvoiceId: true, squareCustomerId: true },
        take: 500,
      });
      const { locationId } = squareSettings();
      let checked = 0;
      let newPayments = 0;
      const failed: string[] = [];
      const byCustomer = new Map<string, typeof open>();
      for (const i of open) byCustomer.set(i.squareCustomerId ?? "", [...(byCustomer.get(i.squareCustomerId ?? "") ?? []), i]);
      for (const [customerId, list] of byCustomer) {
        // One search per customer finds all of our invoices for them (read-only).
        const found = new Map<string, SqInvoice>();
        try {
          if (customerId) {
            let cursor: string | undefined;
            for (let page = 0; page < 5; page++) {
              const r = await squareRequest<{ invoices?: SqInvoice[]; cursor?: string }>("POST", "/v2/invoices/search", { query: { filter: { location_ids: [locationId], customer_ids: [customerId] }, sort: { field: "INVOICE_SORT_DATE", order: "DESC" } }, limit: 200, ...(cursor ? { cursor } : {}) });
              for (const x of r.invoices ?? []) found.set(x.id, x);
              cursor = r.cursor;
              if (!cursor) break;
            }
          }
        } catch (e) {
          failed.push(e instanceof SquareError ? (e.code ?? "SQUARE") : "ERROR");
        }
        for (const i of list) {
          try {
            const r = await syncSquareInvoice(i.id, found.get(i.squareInvoiceId!));
            checked++;
            newPayments += r?.newPayments ?? 0;
          } catch (e) {
            failed.push(e instanceof SquareError ? (e.code ?? "SQUARE") : "ERROR");
          }
        }
      }
      await prisma.ownerAuditLog.create({ data: { actorId: SQUARE_SYSTEM_ACTOR, action: "billing.square_reconciled", entityType: "Square", entityId: null, details: { checked, newPayments, failed: failed.length, at: now.toISOString() } } });
      return { checked, newPayments, failed: failed.length };
    }, "busy");
  } catch (e) {
    if (e instanceof ValidationError && e.message === "busy") return { checked: 0, newPayments: 0, failed: 0, skipped: "another reconcile is running" };
    throw e;
  }
}

export async function runSquareReconcileNow(actor: Actor) {
  await assertCanReconcile(actor);
  const r = await reconcileSquareInvoices();
  await ownerAudit(actor.id, "billing.square_reconcile_run", "Square", null, r);
  return r;
}

// ---------------------------------------------------------------------------
// Void → cancel in Square
// ---------------------------------------------------------------------------

/**
 * Called by voidInvoice before anything is voided here. Records any Square payment first; a paid
 * (or partly paid) Square invoice is never canceled — the money must be refunded first. An
 * unpaid published invoice is canceled; an unpublished draft is deleted. If Square can't be
 * reached the void is refused, so the client can't keep paying a voided invoice.
 */
export async function cancelSquareInvoiceForVoid(actorId: string, invoiceId: string) {
  const inv = await prisma.invoice.findUnique({ where: { id: invoiceId } });
  if (!inv?.squareInvoiceId || inv.squareStatus === "CANCELED" || inv.squareStatus === "DELETED") return null;
  if (!squareSettings().configured) throw new ValidationError("This invoice was sent through Square, but Square isn't connected on this site, so it can't be canceled there. Cancel it in Square first.");
  try {
    const r = await syncSquareInvoice(invoiceId);
    const fresh = await prisma.invoice.findUniqueOrThrow({ where: { id: invoiceId } });
    if (r?.newPayments || ["PAID", "PARTIALLY_PAID", "PAYMENT_PENDING"].includes(fresh.squareStatus ?? "")) {
      throw new ValidationError("The client has paid (or started paying) this invoice through Square. Refund the payment in Square and record the refund before voiding.");
    }
    if (fresh.squareStatus === "CANCELED") return "CANCELED";
    let status = fresh.squareStatus ?? "";
    if (status === "DRAFT") {
      await squareRequest("DELETE", `/v2/invoices/${enc(fresh.squareInvoiceId!)}?version=${fresh.squareInvoiceVersion ?? 0}`);
      status = "DELETED";
      await prisma.invoice.update({ where: { id: invoiceId }, data: { squareStatus: status, squarePublicUrl: null } });
    } else if (status === "UNPAID" || status === "SCHEDULED") {
      const { invoice } = await squareRequest<{ invoice: SqInvoice }>("POST", `/v2/invoices/${enc(fresh.squareInvoiceId!)}/cancel`, { version: fresh.squareInvoiceVersion ?? 0 });
      status = invoice.status ?? "CANCELED";
      await prisma.invoice.update({ where: { id: invoiceId }, data: { squareStatus: status, squareInvoiceVersion: invoice.version ?? fresh.squareInvoiceVersion } });
    } else {
      throw new ValidationError(`Square shows this invoice as ${SQUARE_STATUS_LABELS[status] ?? status}, so it can't be canceled from here. Check it in Square first.`);
    }
    await ownerAudit(actorId, "billing.square_invoice_canceled", "Invoice", invoiceId, { squareInvoiceId: fresh.squareInvoiceId, result: status });
    return status;
  } catch (e) {
    if (e instanceof SquareError) throw new ValidationError(`Square couldn't cancel this invoice, so nothing was voided: ${e.message}`);
    throw e;
  }
}

// ---------------------------------------------------------------------------
// Reconcile screen
// ---------------------------------------------------------------------------

export async function squareReconcileView(actor: Actor) {
  await assertCanReconcile(actor);
  const [matched, review, recurring, dismissed, attention, lastRun, lastEvent, openInvoices] = await Promise.all([
    prisma.payment.findMany({ where: { source: "square" }, include: { invoice: { select: { id: true, number: true, title: true, squareStatus: true, client: { select: { displayName: true } } } } }, orderBy: { createdAt: "desc" }, take: 50 }),
    prisma.squarePaymentSeen.findMany({ where: { state: "UNMATCHED" }, orderBy: [{ paidAt: "desc" }, { createdAt: "desc" }], take: 100 }),
    prisma.squarePaymentSeen.count({ where: { state: "RECURRING" } }),
    prisma.squarePaymentSeen.count({ where: { state: "DISMISSED" } }),
    prisma.invoice.findMany({ where: { squareInvoiceId: { not: null }, squareError: { not: null } }, select: { id: true, number: true, squareStatus: true, squareError: true, client: { select: { displayName: true } } }, orderBy: { updatedAt: "desc" }, take: 50 }),
    prisma.ownerAuditLog.findFirst({ where: { action: "billing.square_reconciled" }, orderBy: { createdAt: "desc" } }),
    prisma.squareWebhookEvent.findFirst({ orderBy: { receivedAt: "desc" } }),
    prisma.invoice.findMany({ where: { state: { in: ["ISSUED", "ACCEPTED"] } }, include: { payments: true, client: { select: { displayName: true } } }, orderBy: { issueDate: "desc" }, take: 200 }),
  ]);
  const customers = [...new Set(review.map((r) => r.squareCustomerId).filter((x): x is string => !!x))];
  const linked = customers.length ? await prisma.invoice.findMany({ where: { squareCustomerId: { in: customers } }, select: { squareCustomerId: true, client: { select: { displayName: true } } }, distinct: ["squareCustomerId"] }) : [];
  return {
    matched,
    review: review.map((r) => ({ ...r, likelyClient: linked.find((l) => l.squareCustomerId === r.squareCustomerId)?.client.displayName ?? null })),
    recurring,
    dismissed,
    attention,
    lastRun: lastRun ? { at: lastRun.createdAt, details: lastRun.details as Record<string, number> | null } : null,
    lastEvent: lastEvent ? { at: lastEvent.receivedAt, type: lastEvent.type, result: lastEvent.result } : null,
    openInvoices: openInvoices
      .map((i) => ({ id: i.id, number: i.number, clientName: i.client.displayName, balanceCents: ((i.acceptedTerms as { totalCents?: number } | null)?.totalCents ?? 0) - collectedCents(i.payments) }))
      .filter((i) => i.balanceCents > 0),
  };
}

/** Staff match an unmatched Square payment to one of our open invoices (re-read from Square first). */
export async function applySquarePaymentToInvoice(actor: Actor, seenId: string, invoiceId: string) {
  await assertCanReconcile(actor);
  const seen = await prisma.squarePaymentSeen.findUnique({ where: { id: seenId } });
  if (!seen || seen.state !== "UNMATCHED") throw new ValidationError("That Square payment isn't waiting for review.");
  const inv = await prisma.invoice.findUnique({ where: { id: invoiceId }, include: { payments: true } });
  if (!inv || (inv.state !== "ISSUED" && inv.state !== "ACCEPTED")) throw new ValidationError("Choose an open invoice.");
  let payment: SqPayment;
  try {
    payment = (await squareRequest<{ payment: SqPayment }>("GET", `/v2/payments/${enc(seen.squarePaymentId)}`)).payment;
  } catch (e) {
    if (e instanceof SquareError) throw new ValidationError(e.message);
    throw e;
  }
  if (payment.status !== "COMPLETED") throw new ValidationError(`Square shows this payment as ${payment.status ?? "unknown"}, so it can't be applied.`);
  const balance = ((inv.acceptedTerms as { totalCents?: number } | null)?.totalCents ?? 0) - collectedCents(inv.payments);
  if ((payment.amount_money?.amount ?? 0) > balance) throw new ValidationError(`That's more than the invoice's balance of ${money(balance)}.`);
  const r = await recordSquarePayment(invoiceId, payment, actor.id);
  if (r === "duplicate") throw new ValidationError("This Square payment is already recorded.");
  if (r !== "recorded") throw new ValidationError("This Square payment couldn't be applied to that invoice.");
  await prisma.squarePaymentSeen.update({ where: { id: seenId }, data: { reviewedById: actor.id, reviewedAt: new Date() } });
  await ownerAudit(actor.id, "billing.square_payment_matched", "Invoice", invoiceId, { squarePaymentId: seen.squarePaymentId, amountCents: payment.amount_money?.amount ?? 0 });
}

export async function dismissSquarePayment(actor: Actor, seenId: string, note: string) {
  await assertCanReconcile(actor);
  if (note.trim().length < 3) throw new ValidationError("Say why (for example: in-person sale, recurring billing).");
  const res = await prisma.squarePaymentSeen.updateMany({ where: { id: seenId, state: "UNMATCHED" }, data: { state: "DISMISSED", note: note.trim().slice(0, 300), reviewedById: actor.id, reviewedAt: new Date() } });
  if (res.count !== 1) throw new ValidationError("That Square payment isn't waiting for review.");
  await ownerAudit(actor.id, "billing.square_payment_dismissed", "SquarePaymentSeen", seenId, { note: note.trim().slice(0, 300) });
}
