import "server-only";
import { prisma } from "@/lib/prisma";
import { audit } from "@/lib/audit";
import { ForbiddenError } from "@/lib/auth/actor";
import { clientVisibleConversationWhere, requireClientAccess } from "@/lib/portal/access";
import type { PortalActor } from "@/lib/portal/session";
import { money } from "@/lib/billing/pricing";
import { ValidationError } from "./clients";
import { isYmd, parseCents } from "./ledger";
import { queueStaffAlert } from "./staff-alerts";
import { todayCentral } from "./square-billing";

/**
 * Client Invoicing — Your Customers, for the client portal: a read-only view of the invoices the
 * office keeps for this business's own customers (src/lib/services/client-invoicing.ts) and the
 * payments recorded against them, for that one business only.
 *
 * The client never creates or sends an invoice here. "Request an invoice" sends the office a portal
 * message (the same kind of thread as "Pay with an Invoice"); staff create the invoice themselves.
 *
 * Gate: requireClientAccess(…, "bookkeeping") — the business-view rule (hasBusinessView).
 */

const ymd = (d: Date) => d.toISOString().slice(0, 10);

/** Statuses as the client sees them. Office drafts are never listed. */
export const CLIENT_INVOICE_STATUS: Record<string, { label: string; tone: "gold" | "navy" | "green" | "red" | "gray" }> = {
  OPEN: { label: "Open", tone: "navy" },
  PARTIALLY_PAID: { label: "Partially paid", tone: "gold" },
  PAID: { label: "Paid", tone: "green" },
  VOID: { label: "Void", tone: "gray" },
  OVERDUE: { label: "Overdue", tone: "red" },
};
export const PAYMENT_METHOD: Record<string, string> = { STRIPE_TEST: "Card (online)", CHECK: "Check", CASH: "Cash", ACH: "Bank transfer (ACH)", ZELLE: "Zelle", OTHER: "Other" };

/** The subject every customer-invoice request starts with (how the office and this page find them). */
export const CUSTOMER_INVOICE_SUBJECT = "Customer invoice request";

export async function clientInvoicingFor(clientId: string, today = todayCentral()) {
  const client = await prisma.client.findUniqueOrThrow({ where: { id: clientId }, select: { id: true, displayName: true, businessName: true } });
  const [invoices, payments, customers] = await Promise.all([
    prisma.clientInvoice.findMany({
      where: { clientId, status: { not: "DRAFT" } },
      orderBy: [{ issueDate: "desc" }, { number: "desc" }],
      take: 200,
      select: { id: true, number: true, issueDate: true, dueDate: true, status: true, totalCents: true, paidCents: true, customer: { select: { name: true } } },
    }),
    prisma.clientInvoicePayment.findMany({
      where: { clientId, invoice: { clientId, status: { not: "DRAFT" } } },
      orderBy: [{ receivedOn: "desc" }, { createdAt: "desc" }],
      take: 200,
      select: { id: true, receivedOn: true, amountCents: true, method: true, receiptNumber: true, invoice: { select: { number: true, customer: { select: { name: true } } } } },
    }),
    prisma.invoiceCustomer.findMany({ where: { clientId, active: true }, orderBy: { name: "asc" }, select: { id: true, name: true } }),
  ]);
  const rows = invoices.map((i) => {
    const due = ymd(i.dueDate);
    const open = i.status === "OPEN" || i.status === "PARTIALLY_PAID";
    return {
      id: i.id,
      number: i.number,
      customer: i.customer.name,
      issued: ymd(i.issueDate),
      due,
      totalCents: i.totalCents,
      paidCents: i.paidCents,
      balanceCents: open ? i.totalCents - i.paidCents : 0,
      status: i.status,
      // Open past its due date: shown as Overdue (from the invoice's own dates).
      display: open && due < today ? "OVERDUE" : i.status,
    };
  });
  const open = rows.filter((r) => r.balanceCents > 0);
  const year = today.slice(0, 4);
  return {
    client: { id: client.id, name: client.businessName || client.displayName },
    invoices: rows,
    payments: payments.map((p) => ({ id: p.id, receivedOn: ymd(p.receivedOn), amountCents: p.amountCents, method: PAYMENT_METHOD[p.method] ?? "Other", receipt: p.receiptNumber, invoice: p.invoice.number, customer: p.invoice.customer.name })),
    customers,
    totals: {
      openCents: open.reduce((t, r) => t + r.balanceCents, 0),
      openCount: open.length,
      overdueCount: open.filter((r) => r.display === "OVERDUE").length,
      collectedYtdCents: payments.filter((p) => ymd(p.receivedOn).startsWith(year)).reduce((t, p) => t + p.amountCents, 0),
      year: Number(year),
    },
  };
}

/** The client's own recent customer-invoice requests (threads this login may see), newest first. */
async function recentRequests(clientId: string, portalUserId: string | null) {
  const rows = await prisma.conversation.findMany({
    where: { clientId, subject: { startsWith: CUSTOMER_INVOICE_SUBJECT }, ...clientVisibleConversationWhere(portalUserId) },
    orderBy: { createdAt: "desc" },
    take: 5,
    select: { id: true, subject: true, createdAt: true, awaitingStaff: true, closedAt: true },
  });
  return rows.map((r) => ({ id: r.id, subject: r.subject, sent: ymd(r.createdAt), status: r.closedAt ? "Closed" : r.awaitingStaff ? "Sent to our office" : "Our office replied" }));
}

export async function portalClientInvoicing(user: PortalActor, clientId: string) {
  const access = await requireClientAccess(user.id, clientId, "bookkeeping");
  const [data, requests] = await Promise.all([clientInvoicingFor(clientId), access.canMessage ? recentRequests(clientId, user.id) : []]);
  return { ...data, requests, canRequest: access.canMessage };
}

/** For staff View as Client: shared threads only, never a login's private ones. */
export async function previewClientInvoicing(clientId: string) {
  const [data, requests] = await Promise.all([clientInvoicingFor(clientId), recentRequests(clientId, null)]);
  return { ...data, requests, canRequest: true };
}

export type CustomerInvoiceRequestInput = {
  clientId: string;
  customerId?: string | null;
  customerName?: string | null;
  amount: string;
  description: string;
  dueDate: string;
  idempotencyKey?: string | null;
};

/**
 * "Request an invoice": the client says who the invoice is for, how much, what for and when it's
 * due. It reaches the office as a portal message (with a staff alert); staff create and send the
 * invoice in Client Invoicing. Nothing here creates, issues or sends an invoice.
 */
export async function requestCustomerInvoice(user: PortalActor, input: CustomerInvoiceRequestInput, today = todayCentral()) {
  const access = await requireClientAccess(user.id, input.clientId, "bookkeeping");
  if (!access.canMessage) throw new ForbiddenError("Your access to this account doesn't include sending requests to our office.");
  if (input.idempotencyKey) {
    const dup = await prisma.message.findUnique({ where: { idempotencyKey: input.idempotencyKey }, select: { conversationId: true, conversation: { select: { clientId: true } } } });
    if (dup && dup.conversation.clientId === input.clientId) return { conversationId: dup.conversationId };
  }
  // The customer: one of this business's own customers, or a new name for the office to add.
  let customer: string;
  if (input.customerId) {
    const c = await prisma.invoiceCustomer.findFirst({ where: { id: input.customerId, clientId: input.clientId, active: true }, select: { name: true } });
    if (!c) throw new ValidationError("Choose one of your customers from the list, or type a new customer's name.");
    customer = c.name;
  } else {
    customer = (input.customerName ?? "").trim().replace(/\s+/g, " ").slice(0, 120);
    if (!customer) throw new ValidationError("Tell us who the invoice is for.");
  }
  const amountCents = parseCents(input.amount ?? "", "amount");
  if (amountCents <= 0) throw new ValidationError("Enter the amount to invoice, e.g. 1,250.00.");
  if (amountCents > 100_000_000) throw new ValidationError("That amount is too large for a request. Send us a message instead.");
  const description = (input.description ?? "").trim().slice(0, 1000);
  if (!description) throw new ValidationError("Describe what the invoice is for.");
  const dueDate = (input.dueDate ?? "").trim();
  if (!isYmd(dueDate)) throw new ValidationError("Choose the date the invoice is due.");
  if (dueDate < today) throw new ValidationError("The due date can't be in the past.");

  const [client, portalUser, owner] = await Promise.all([
    prisma.client.findUniqueOrThrow({ where: { id: input.clientId }, select: { displayName: true, businessName: true } }),
    prisma.portalUser.findUniqueOrThrow({ where: { id: user.id }, select: { name: true } }),
    prisma.businessOwner.count({ where: { clientId: input.clientId, portalUserId: user.id, archivedAt: null } }),
  ]);
  const business = client.businessName || client.displayName;
  const dueLabel = new Date(`${dueDate}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
  const subject = `${CUSTOMER_INVOICE_SUBJECT} from ${portalUser.name} for ${business}: ${customer}, ${money(amountCents)}`.slice(0, 200);
  const body = [
    "Please create an invoice to my customer. (Requested from the portal's Client Invoicing page.)",
    `Customer: ${customer}${input.customerId ? "" : " (new customer)"}`,
    `Amount: ${money(amountCents)}`,
    `Due date: ${dueLabel}`,
    `For: ${description}`,
  ].join("\n");

  const conversationId = await prisma.$transaction(async (tx) => {
    // A business owner's request is private to them, like their other threads.
    const convo = await tx.conversation.create({ data: { clientId: input.clientId, subject, awaitingStaff: true, unreadByStaff: true, privateToPortalUserId: owner ? user.id : null } });
    await tx.message.create({
      data: { conversationId: convo.id, channel: "PORTAL", direction: "INBOUND", body, portalAuthorId: user.id, status: "DELIVERED", readByClientAt: new Date(), idempotencyKey: input.idempotencyKey || null },
    });
    await audit(tx, { actorId: null, action: "client_invoice_request.created", entityType: "Conversation", entityId: convo.id, clientId: input.clientId, details: { portalUserId: user.id, amountCents, newCustomer: !input.customerId, dueDate } });
    return convo.id;
  });
  await queueStaffAlert({ conversationId });
  return { conversationId };
}
