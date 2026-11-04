import "server-only";
import type { Invoice, Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import type { Actor } from "@/lib/auth/actor";
import { ForbiddenError } from "@/lib/auth/actor";
import { assertOffice, ownerAudit } from "@/lib/auth/owner";
import { can } from "@/lib/auth/permissions";
import type { PortalActor } from "@/lib/portal/session";
import { requireClientAccess } from "@/lib/portal/access";
import { squareSettings } from "@/lib/square";
import { changedFields } from "@/lib/audit";
import { clientPaymentOptions, FIRM_METHOD_DEFAULTS, FIRM_METHODS, FIRM_SERVICES, isSquarePaymentUrl, squarePayUrl, TAX_RETURN_SERVICES, type FirmMethod, type InvoiceStatusKey } from "@/lib/billing/invoice-status";
import { assertCanChangePaymentIntegrations } from "@/lib/auth/billing-permissions";
import { cashCollectedCents, creditedCents } from "@/lib/billing/pricing";
import { METHOD_LABELS } from "@/lib/billing/labels";
import type { FirmInvoiceDoc } from "@/components/billing/firm-invoice-document";
import { billingContactOf, billingSettings, issueInvoice, nextNumber, notifyBilling, withNumberRetry } from "./owner-billing";
import { ValidationError } from "./clients";

/**
 * Create Invoice — T. Turner & Associates invoicing its own clients. Built on the Owner's Office
 * Invoice record (one record for Admin Billing, the client's Billing page, the master profile and
 * receivables). Managed bookkeeping clients' invoicing of their own customers (ClientInvoice) is
 * separate and untouched.
 *
 * Permissions (Staff Access & Permissions, via lib/auth/billing-permissions.ts): Billing → Create /
 * Edit for drafts and submitting, Billing → Send to approve and send. Sending through Square
 * (square-invoicing.ts) happens on approval when the "Send invoices through Square" switch is on,
 * or later from the invoice page. Nothing here charges a card or stores card data.
 */

export type FirmInvoiceInput = {
  clientId: string;
  service: string;
  amountCents: number;
  description: string;
  issueDate: string;
  dueDate: string;
  privateNote?: string | null;
  offeredMethods: string[];
  squarePaymentUrl?: string | null;
};

const YMD = /^\d{4}-\d{2}-\d{2}$/;
const dateOnly = (s: string) => new Date(`${s}T00:00:00.000Z`);
const MAX_CENTS = 100_000_000; // $1,000,000.00

/** Methods the owner has approved for business use (an active payment instruction), in display order. */
export async function approvedFirmMethods() {
  const rows = await prisma.paymentInstruction.findMany({ where: { active: true, method: { in: [...FIRM_METHODS] } } });
  return FIRM_METHODS.flatMap((m) => {
    const r = rows.find((x) => x.method === m);
    return r ? [{ method: m, details: r.details || FIRM_METHOD_DEFAULTS[m] || "" }] : [];
  });
}

/** Square links show to clients only after the owner turns them on and Square is configured. */
export async function squareLinksLive() {
  const s = await billingSettings();
  return !!s.squareLinksEnabledAt && squareSettings().configured;
}

export async function validateFirmInvoice(input: FirmInvoiceInput) {
  const client = await prisma.client.findUnique({ where: { id: input.clientId }, select: { archivedAt: true } });
  if (!client || client.archivedAt) throw new ValidationError("Choose a client from the client list.");
  if (!(FIRM_SERVICES as readonly string[]).includes(input.service)) throw new ValidationError("Choose a service.");
  if (!Number.isInteger(input.amountCents) || input.amountCents <= 0) throw new ValidationError("Enter an invoice amount greater than $0.");
  if (input.amountCents > MAX_CENTS) throw new ValidationError("That amount is too large for one invoice.");
  if (!input.description.trim()) throw new ValidationError("Describe the services provided.");
  if (!YMD.test(input.issueDate)) throw new ValidationError("Enter the invoice date.");
  if (!YMD.test(input.dueDate)) throw new ValidationError("Choose a due date.");
  if (input.dueDate < input.issueDate) throw new ValidationError("The due date can't be before the invoice date.");
  const offered = [...new Set(input.offeredMethods)];
  const approved = new Set((await approvedFirmMethods()).map((m) => m.method));
  for (const m of offered) {
    if (!(FIRM_METHODS as readonly string[]).includes(m)) throw new ValidationError("Choose payment options from the list.");
    if (!approved.has(m as FirmMethod)) throw new ValidationError("That payment option hasn't been approved for business use. The owner can turn it on in Billing settings.");
  }
  if (offered.includes("REFUND_TRANSFER") && !TAX_RETURN_SERVICES.includes(input.service)) throw new ValidationError("Refund Transfer is for eligible tax returns only.");
  const url = input.squarePaymentUrl?.trim() || null;
  if (url && !isSquarePaymentUrl(url)) throw new ValidationError("Paste the secure Square payment link (https://square.link/… or squareup.com).");
  return {
    offeredMethods: FIRM_METHODS.filter((m) => offered.includes(m)) as string[],
    squarePaymentUrl: offered.includes("SQUARE_INVOICE") ? url : null,
  };
}

function invoiceFields(input: FirmInvoiceInput, checked: Awaited<ReturnType<typeof validateFirmInvoice>>) {
  return {
    title: input.service,
    issueDate: dateOnly(input.issueDate),
    dueDate: dateOnly(input.dueDate),
    privateNote: input.privateNote?.trim().slice(0, 2000) || null,
    allowFull: true,
    allowPlan: false,
    depositType: "NONE" as const,
    depositValue: 0,
    discountType: "NONE" as const,
    discountValue: 0,
    discountCoversPlanFee: false,
    taxRateBps: 0,
    planFeeType: "NONE" as const,
    planFeeValue: 0,
    planFirstDueDate: null,
    ...checked,
  };
}

const lineOf = (input: FirmInvoiceInput) => ({ service: input.service, description: input.description.trim().slice(0, 2000), quantity: 1, unitCents: input.amountCents, sortOrder: 0 });

/** Where a new invoice came from: a client's "Pay with an Invoice" request (new or legacy thread). */
export type InvoiceOrigin = { requestId?: string | null; conversationId?: string | null };

/** Draft from the Create Invoice screen. Owner or staff with billing access. */
export async function createFirmInvoice(actor: Actor, input: FirmInvoiceInput, origin: InvoiceOrigin = {}) {
  await assertOffice(actor, "billing", "create");
  if (origin.requestId) {
    const r = await prisma.invoiceRequest.findUnique({ where: { id: origin.requestId }, select: { clientId: true, invoiceId: true } });
    if (!r || r.clientId !== input.clientId) throw new ValidationError("That invoice request is for a different client.");
    if (r.invoiceId) throw new ValidationError("An invoice was already created for this request.");
  }
  const { invoice: inv, offeredMethods } = await insertFirmInvoice(actor.id, input);
  await ownerAudit(actor.id, "billing.invoice_created", "Invoice", inv.id, { number: inv.number, service: input.service, amountCents: input.amountCents, offeredMethods, ...(origin.requestId ? { requestId: origin.requestId } : {}) });
  if (origin.requestId || origin.conversationId) await (await import("./invoice-requests")).linkInvoiceToRequest(actor.id, inv.id, origin);
  return inv;
}

/**
 * The Create Invoice record itself (a draft), with no permission check: callers check first.
 * Billing schedules use it for each cycle; `inTx` runs in the same transaction, so a cycle and its
 * invoice are saved together or not at all.
 */
export async function insertFirmInvoice(createdById: string, input: FirmInvoiceInput, inTx?: (tx: Prisma.TransactionClient, inv: Invoice) => Promise<void>) {
  const checked = await validateFirmInvoice(input);
  const contact = await billingContactOf(input.clientId);
  const invoice = await withNumberRetry(() =>
    prisma.$transaction(async (tx) => {
      const number = await nextNumber(tx, Number(input.issueDate.slice(0, 4)));
      const inv = await tx.invoice.create({
        data: { number, clientId: input.clientId, createdById, formType: "INVOICE", ...contact, ...invoiceFields(input, checked), lines: { create: [lineOf(input)] } },
      });
      if (inTx) await inTx(tx, inv);
      return inv;
    }),
  );
  return { invoice, offeredMethods: checked.offeredMethods };
}

/** Drafts only; the client's billing contact is refreshed from the master record. */
export async function updateFirmInvoice(actor: Actor, invoiceId: string, input: FirmInvoiceInput) {
  await assertOffice(actor, "billing", "edit");
  const before = await prisma.invoice.findUnique({ where: { id: invoiceId }, include: { lines: true } });
  if (!before || before.formType !== "INVOICE") throw new ValidationError("Not found.");
  if (before.state !== "DRAFT") throw new ValidationError("Only drafts can be edited. Ask the owner to return it to draft first.");
  const checked = await validateFirmInvoice(input);
  const contact = await billingContactOf(input.clientId);
  const data = { ...invoiceFields(input, checked), ...contact, clientId: input.clientId };
  await prisma.$transaction(async (tx) => {
    const res = await tx.invoice.updateMany({ where: { id: invoiceId, state: "DRAFT" }, data });
    if (res.count !== 1) throw new ValidationError("Only drafts can be edited.");
    await tx.invoiceLine.deleteMany({ where: { invoiceId } });
    await tx.invoiceLine.create({ data: { invoiceId, ...lineOf(input) } });
  });
  const line = before.lines[0];
  const changed = [
    ...changedFields(before as unknown as Record<string, unknown>, data as unknown as Record<string, unknown>).filter((f) => f !== "issueDate" && f !== "dueDate"),
    ...(before.issueDate.toISOString().slice(0, 10) !== input.issueDate ? ["issueDate"] : []),
    ...(before.dueDate.toISOString().slice(0, 10) !== input.dueDate ? ["dueDate"] : []),
    ...(line?.unitCents !== input.amountCents ? ["amount"] : []),
    ...(line?.description !== input.description.trim() ? ["description"] : []),
  ];
  await ownerAudit(actor.id, "billing.invoice_edited", "Invoice", invoiceId, { changed });
}

/** Staff (or the owner) hand a draft to the owner for approval. */
export async function submitForApproval(actor: Actor, invoiceId: string) {
  await assertOffice(actor, "billing", "edit");
  const res = await prisma.invoice.updateMany({ where: { id: invoiceId, state: "DRAFT" }, data: { state: "PENDING_APPROVAL", submittedAt: new Date(), submittedById: actor.id } });
  if (res.count !== 1) throw new ValidationError("Only drafts can be submitted for approval.");
  await ownerAudit(actor.id, "billing.invoice_submitted", "Invoice", invoiceId);
}

/** The owner sends a submitted invoice back for changes; the submitter may also take it back. */
export async function returnToDraft(actor: Actor, invoiceId: string, note?: string | null) {
  await assertOffice(actor, "billing", "edit");
  const inv = await prisma.invoice.findUnique({ where: { id: invoiceId } });
  if (!inv || inv.state !== "PENDING_APPROVAL") throw new ValidationError("Only an invoice waiting for approval can be returned to draft.");
  if (inv.submittedById !== actor.id && !(await can(actor, "billing", "send"))) throw new ForbiddenError("Only someone who can send invoices can return someone else's invoice.");
  const res = await prisma.invoice.updateMany({ where: { id: invoiceId, state: "PENDING_APPROVAL" }, data: { state: "DRAFT", submittedAt: null, submittedById: null } });
  if (res.count !== 1) throw new ValidationError("Only an invoice waiting for approval can be returned to draft.");
  await ownerAudit(actor.id, "billing.invoice_returned", "Invoice", invoiceId, { note: note?.trim().slice(0, 300) || null });
}

/**
 * Owner approval: re-checks the payment options are still approved, then sends (see issueInvoice).
 * With `viaSquare` (the invoice offers Square and the owner's Square switch is on), it then goes
 * through Square too. The client's portal notice is sent either way — except a second email to
 * the address that just got our Square-link email. If Square fails, the invoice is still sent to
 * the portal and the Square problem is returned for staff to retry.
 */
export async function approveAndSend(actor: Actor, invoiceId: string, opts: { viaSquare?: boolean } = {}): Promise<{ squareUrl: string | null; squareProblem: string | null }> {
  await issueInvoice(actor, invoiceId, {
    notify: !opts.viaSquare,
    checkOptions: async (inv: Invoice) => {
      if (inv.formType !== "INVOICE") return;
      const approved = new Set((await approvedFirmMethods()).map((m) => m.method as string));
      const gone = inv.offeredMethods.filter((m) => !approved.has(m));
      if (gone.length) throw new ValidationError("A payment option on this invoice is no longer approved. Edit the draft and choose again.");
    },
  });
  if (!opts.viaSquare) return { squareUrl: null, squareProblem: null };
  const inv = await prisma.invoice.findUniqueOrThrow({ where: { id: invoiceId }, select: { clientId: true } });
  const { sendInvoiceViaSquare } = await import("./square-invoicing");
  try {
    const r = await sendInvoiceViaSquare(actor, invoiceId);
    await notifyBilling(inv.clientId, "NEW_INVOICE", invoiceId, r.emailedTo);
    return { squareUrl: r.url, squareProblem: r.emailProblem };
  } catch (e) {
    await notifyBilling(inv.clientId, "NEW_INVOICE", invoiceId);
    if (e instanceof ValidationError || e instanceof ForbiddenError) return { squareUrl: null, squareProblem: e.message };
    throw e;
  }
}

/** Marks the invoice Viewed the first time the client opens it in the portal. */
export async function markInvoiceViewed(user: PortalActor, invoiceId: string) {
  const inv = await prisma.invoice.findUnique({ where: { id: invoiceId }, select: { clientId: true, publishedAt: true, state: true, viewedAt: true } });
  if (!inv) return;
  await requireClientAccess(user.id, inv.clientId, "billing");
  if (!inv.publishedAt || inv.viewedAt || (inv.state !== "ISSUED" && inv.state !== "ACCEPTED")) return;
  const res = await prisma.invoice.updateMany({ where: { id: invoiceId, viewedAt: null }, data: { viewedAt: new Date() } });
  if (res.count === 1) await ownerAudit(`portal:${user.id}`, "billing.invoice_viewed", "Invoice", invoiceId);
}

// Payments recorded automatically from Square (square-invoicing.ts SQUARE_SYSTEM_ACTOR).
const SQUARE_ACTOR = "system:square";
const ACTIONS: Record<string, string> = {
  "billing.invoice_created": "Created as a draft",
  "billing.quote_created": "Created as a draft",
  "billing.invoice_edited": "Edited",
  "billing.quote_updated": "Edited",
  "billing.invoice_submitted": "Submitted for owner approval",
  "billing.invoice_returned": "Returned to draft",
  "billing.invoice_approved": "Approved by the owner",
  "billing.invoice_issued": "Sent to the client's portal",
  "billing.quote_offered": "Sent as a quote",
  "billing.quote_withdrawn": "Quote withdrawn",
  "billing.quote_accepted": "Accepted by the client",
  "billing.quote_declined": "Declined by the client",
  "billing.invoice_viewed": "Viewed by the client",
  "billing.invoice_voided": "Voided",
  "billing.payment_succeeded": "Payment recorded",
  "billing.payment_failed": "Failed payment recorded",
  "billing.refund_succeeded": "Refund recorded",
  "billing.refund_failed": "Failed refund recorded",
  "billing.adjustment_applied": "Adjustment (credit) applied",
  "billing.method_selected": "Payment method selected",
  "billing.square_invoice_sent": "Sent through Square",
  "billing.square_send_failed": "Square didn't accept it (nothing charged)",
  "billing.square_invoice_emailed": "Square payment link emailed to the client",
  "billing.square_invoice_canceled": "Canceled in Square",
  "billing.square_payment_matched": "Square payment matched by staff",
  "billing.schedule_cycle_created": "Created as a draft by its billing schedule",
  "billing.schedule_autosent": "Sent automatically by its billing schedule",
  "billing.schedule_autosend_held": "Kept as a draft (automatic sending held)",
};

/** Every change to this invoice and its payments, oldest first (owner audit log). */
export async function invoiceHistory(actor: Actor, invoiceId: string) {
  await assertOffice(actor, "billing", "view");
  const payments = await prisma.payment.findMany({ where: { invoiceId }, select: { id: true } });
  const rows = await prisma.ownerAuditLog.findMany({
    where: { OR: [{ entityType: "Invoice", entityId: invoiceId }, { entityType: "Payment", entityId: { in: payments.map((p) => p.id) } }] },
    orderBy: { createdAt: "asc" },
  });
  const staffIds = rows.map((r) => r.actorId).filter((a) => !a.startsWith("portal:") && !a.startsWith("system:"));
  const users = await prisma.user.findMany({ where: { id: { in: staffIds } }, select: { id: true, name: true } });
  return rows.map((r) => ({
    id: r.id,
    at: r.createdAt,
    action: ACTIONS[r.action] ?? r.action,
    who: r.actorId.startsWith("portal:") ? "Client (portal)" : r.actorId === SQUARE_ACTOR ? "Square (automatic)" : r.actorId === "system:billing-schedule" ? "Billing schedule (automatic)" : (users.find((u) => u.id === r.actorId)?.name ?? "Staff"),
    details: r.details as Record<string, unknown> | null,
  }));
}

/**
 * Owner only: manually pasted Square links on invoices (the fallback; off until turned on). Square
 * invoices sent through the Square connection carry their own link and don't need this.
 */
export async function setSquareLinksEnabled(actor: Actor, enabled: boolean) {
  await assertCanChangePaymentIntegrations(actor);
  await billingSettings();
  await prisma.billingSettings.update({ where: { id: "default" }, data: enabled ? { squareLinksEnabledAt: new Date(), squareLinksEnabledById: actor.id } : { squareLinksEnabledAt: null, squareLinksEnabledById: null } });
  await ownerAudit(actor.id, enabled ? "billing.square_links_enabled" : "billing.square_links_disabled", "BillingSettings", "default");
}

/** Owner only: the Republic Bank fees she has confirmed, shown to clients exactly as written. */
export async function setRefundTransferFeeNote(actor: Actor, note: string) {
  await assertOffice(actor, "billing", "settings");
  await billingSettings();
  await prisma.billingSettings.update({ where: { id: "default" }, data: { refundTransferFeeNote: note.trim().slice(0, 1000) || null } });
  await ownerAudit(actor.id, "billing.refund_transfer_fees_saved", "BillingSettings", "default");
}

/** Clients for the Create Invoice search: what staff would otherwise re-type. */
export async function invoiceClientChoices(actor: Actor) {
  await assertOffice(actor, "billing", "view");
  const rows = await prisma.client.findMany({
    where: { archivedAt: null },
    select: { id: true, displayName: true, businessName: true, email: true, phone: true, addressLine1: true, addressLine2: true, city: true, state: true, postalCode: true, clientType: true, contacts: { select: { email: true, phone: true }, orderBy: { createdAt: "asc" }, take: 3 } },
    orderBy: { displayName: "asc" },
  });
  // The client's existing Square customer, read from the stored links only (no call to Square):
  // the same order the send path uses, so a Square invoice reuses it instead of a new customer.
  const [members, profiles, previous] = await Promise.all([
    prisma.squareBillingMember.findMany({ select: { clientId: true, arrangement: { select: { squareCustomerId: true } } }, orderBy: { createdAt: "asc" } }),
    prisma.bookkeepingBilling.findMany({ where: { squareCustomerId: { not: null }, NOT: { squareCustomerIdSource: "MANUAL" } }, select: { clientId: true, squareCustomerId: true } }),
    prisma.invoice.findMany({ where: { squareCustomerId: { not: null } }, select: { clientId: true, squareCustomerId: true }, orderBy: { squareSentAt: "desc" } }),
  ]);
  const squareOf = (id: string) => members.find((m) => m.clientId === id)?.arrangement.squareCustomerId ?? profiles.find((p) => p.clientId === id)?.squareCustomerId ?? previous.find((p) => p.clientId === id)?.squareCustomerId ?? null;
  return rows.map((c) => {
    const contact = c.contacts.find((x) => x.email || x.phone);
    const cityLine = [c.city, [c.state, c.postalCode].filter(Boolean).join(" ")].filter(Boolean).join(", ");
    return {
      id: c.id,
      name: c.businessName || c.displayName,
      person: c.businessName && c.businessName !== c.displayName ? c.displayName : null,
      email: c.email || contact?.email || null,
      phone: c.phone || contact?.phone || null,
      address: [c.addressLine1, c.addressLine2, cityLine].filter(Boolean).join("\n") || null,
      type: c.clientType,
      squareCustomerId: squareOf(c.id),
    };
  });
}
export type InvoiceClientChoice = Awaited<ReturnType<typeof invoiceClientChoices>>[number];

/**
 * The client-facing view of one invoice (portal, and the owner's client preview). Built only from
 * client-safe fields: never the internal note, who created or approved it, or failed attempts.
 */
export async function firmInvoiceDoc(inv: {
  number: string;
  status: InvoiceStatusKey;
  issueDate: string;
  dueDate: string;
  billTo: FirmInvoiceDoc["billTo"];
  lines: { service: string; description: string | null; quantity: number; unitCents: number }[];
  totalCents: number | null;
  // Successful money movements only (portal rows are already filtered); failed attempts are dropped.
  payments: { id: string; kind: "PAYMENT" | "REFUND" | "CREDIT"; status?: string; amountCents: number; receivedOn: string; method: string }[];
  offeredMethods: string[];
  squarePaymentUrl: string | null;
  // Set when the invoice was sent through Square: the page Square created, and Square's status.
  squarePublicUrl?: string | null;
  squareStatus?: string | null;
}): Promise<FirmInvoiceDoc> {
  const [approved, live, settings] = await Promise.all([approvedFirmMethods(), squareLinksLive(), billingSettings()]);
  const ok = inv.payments.filter((p) => !p.status || p.status === "SUCCEEDED");
  const rows = ok.map((p) => ({ kind: p.kind, status: "SUCCEEDED" as const, amountCents: p.amountCents }));
  const amount = inv.totalCents ?? inv.lines.reduce((s, l) => s + l.quantity * l.unitCents, 0);
  const paid = cashCollectedCents(rows);
  const credited = creditedCents(rows);
  return {
    number: inv.number,
    status: inv.status,
    issueDate: inv.issueDate,
    dueDate: inv.dueDate,
    billTo: inv.billTo,
    service: inv.lines[0]?.service ?? "",
    description: inv.lines[0]?.description ?? "",
    amountCents: amount,
    paidCents: paid,
    creditedCents: credited,
    balanceCents: inv.status === "VOIDED" ? 0 : Math.max(0, amount - paid - credited),
    payments: ok.map((p) => ({
      key: p.id,
      date: p.receivedOn,
      label: p.kind === "CREDIT" ? "Adjustment (credit)" : p.kind === "REFUND" ? `Refund · ${METHOD_LABELS[p.method] ?? p.method}` : `Payment · ${METHOD_LABELS[p.method] ?? p.method}`,
      amountCents: p.amountCents,
      negative: p.kind === "REFUND",
    })),
    options: clientPaymentOptions(inv.offeredMethods, approved, { squareUrl: squarePayUrl(inv, live), refundFeeNote: settings.refundTransferFeeNote }),
  };
}

