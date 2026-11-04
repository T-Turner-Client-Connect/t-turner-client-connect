import "server-only";
import type { InvoiceRequest, ServiceType } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { audit } from "@/lib/audit";
import type { Actor } from "@/lib/auth/actor";
import { can } from "@/lib/auth/permissions";
import { ownerAudit } from "@/lib/auth/owner";
import type { PortalActor } from "@/lib/portal/session";
import { conversationScope, requireClientAccess } from "@/lib/portal/access";
import { money } from "@/lib/billing/pricing";
import type { AgreementTerms } from "@/lib/billing/agreement-terms";
import { ValidationError } from "./clients";
import { queueStaffAlert } from "./staff-alerts";
import { invoiceRows } from "./owner-billing";

/**
 * "Pay with an Invoice" — the client says what the invoice is for, and staff see who asked and
 * what for, everywhere the request shows up (Communication History, Conversations, the dashboard,
 * the staff alert). Creating the invoice uses the ordinary Create Invoice page, prefilled; nothing
 * is sent until staff send it the normal way. Statuses: OPEN → INVOICE_CREATED → INVOICE_SENT.
 */

/** The subject every older, generic request used (before requests said who and what). */
export const LEGACY_SUBJECT = "Please send me an invoice";

export type RequestItem = { kind: "SERVICE" | "TAX_YEAR" | "INVOICE" | "OTHER"; ref: string | null; label: string };

export const REQUEST_STATUS: Record<string, { label: string; tone: "gold" | "navy" | "green" | "gray" }> = {
  OPEN: { label: "New request", tone: "gold" },
  INVOICE_CREATED: { label: "Invoice created", tone: "navy" },
  INVOICE_SENT: { label: "Invoice sent", tone: "green" },
  CLOSED: { label: "Closed", tone: "gray" },
};

/** Client services → the Create Invoice service list. */
export const FIRM_SERVICE_OF: Record<ServiceType, string> = {
  TAX_INDIVIDUAL: "Tax Preparation",
  TAX_BUSINESS: "Business Tax Preparation",
  K1_PREPARATION: "Business Tax Preparation",
  TAX_AMENDED: "Amended Return",
  TAX_NONPROFIT: "Business Tax Preparation",
  BOOKKEEPING: "Bookkeeping",
  PAYROLL: "Payroll",
  NONPROFIT_SERVICES: "Nonprofit Services",
  BUSINESS_FORMATION: "Business Formation",
  CONSULTING: "Consulting",
  PROPERTY_MANAGEMENT: "Other",
  IRS_CORRESPONDENCE: "IRS Notice / Correspondence",
  OTHER: "Other",
};

const lastTaxYear = () => new Date().getFullYear() - 1;

/** What the client can choose from: their services, the tax return being prepared, open invoices, or Other. */
export async function invoiceRequestChoices(user: PortalActor, clientId: string) {
  const access = await requireClientAccess(user.id, clientId, "message");
  const [services, client] = await Promise.all([
    prisma.clientService.findMany({ where: { clientId, status: { not: "CLOSED" } }, orderBy: [{ taxYear: "desc" }, { createdAt: "desc" }], select: { id: true, title: true, taxYear: true, type: true } }),
    prisma.client.findUniqueOrThrow({ where: { id: clientId }, select: { clientType: true } }),
  ]);
  const choices: (RequestItem & { taxYear: number | null })[] = services.map((s) => ({ kind: "SERVICE", ref: s.id, label: s.title, taxYear: s.taxYear }));
  const y = lastTaxYear();
  const taxLike = services.some((s) => s.taxYear === y && s.type.startsWith("TAX"));
  if (!taxLike) choices.push({ kind: "TAX_YEAR", ref: String(y), label: `My ${y} ${client.clientType === "INDIVIDUAL" ? "tax return" : "business tax return"}`, taxYear: y });
  if (access.canViewBilling) {
    const open = (await openPublishedInvoices(clientId)).map((i) => ({ kind: "INVOICE" as const, ref: i.id, label: `Invoice ${i.number} · ${i.title} (balance ${money(i.balanceCents)})`, taxYear: null }));
    choices.push(...open);
  }
  return { choices, years: [y, y - 1, y - 2] };
}

async function openPublishedInvoices(clientId: string) {
  const rows = await prisma.invoice.findMany({
    where: { clientId, publishedAt: { not: null }, state: { in: ["ISSUED", "ACCEPTED"] } },
    include: { lines: true, payments: { where: { status: "SUCCEEDED" } } },
    orderBy: { issueDate: "desc" },
  });
  return rows
    .map((inv) => {
      const total = (inv.acceptedTerms as { totalCents?: number } | null)?.totalCents ?? inv.lines.reduce((s, l) => s + l.quantity * l.unitCents, 0);
      const applied = inv.payments.reduce((s, p) => (p.kind === "REFUND" ? s - p.amountCents : s + p.amountCents), 0);
      return { id: inv.id, number: inv.number, title: inv.title, balanceCents: total - applied };
    })
    .filter((i) => i.balanceCents > 0);
}

/** "2025 Individual tax return and Bookkeeping" */
function whatOf(items: RequestItem[], note: string | null) {
  const labels = items.filter((i) => i.kind !== "OTHER").map((i) => i.label);
  if (items.some((i) => i.kind === "OTHER")) labels.push(note ? `Other: ${note.length > 80 ? `${note.slice(0, 77)}…` : note}` : "Other");
  return labels.length ? labels.join("; ") : null;
}

/** The line staff see everywhere: "Invoice request from {person} for {client/business}: {what}, {tax year}". */
export function requestTitle(r: Pick<InvoiceRequest, "requesterName" | "businessName" | "items" | "note" | "taxYear">, clientName: string) {
  const what = whatOf(r.items as unknown as RequestItem[], r.note);
  const who = r.businessName && r.businessName !== clientName ? `${r.businessName}` : clientName;
  if (!what) return `Invoice request (details not given) from ${r.requesterName} for ${who}`;
  const year = r.taxYear && !what.includes(String(r.taxYear)) ? `, tax year ${r.taxYear}` : "";
  return `Invoice request from ${r.requesterName} for ${who}: ${what}${year}`;
}

/**
 * The client taps "Pay with an Invoice": a structured request plus the portal message staff see in
 * Communication History. A login can only request for an account it has access to, and every
 * chosen item must belong to that account.
 */
export async function requestInvoice(
  user: PortalActor,
  input: { clientId: string; items: { kind: string; ref: string | null }[]; note?: string | null; taxYear?: number | null; amountCents?: number | null; idempotencyKey?: string | null },
) {
  await requireClientAccess(user.id, input.clientId, "message");
  if (input.idempotencyKey) {
    const dup = await prisma.message.findUnique({ where: { idempotencyKey: input.idempotencyKey }, select: { conversationId: true } });
    if (dup) {
      const r = await prisma.invoiceRequest.findUnique({ where: { conversationId: dup.conversationId } });
      if (r) return r;
    }
  }
  const { choices } = await invoiceRequestChoices(user, input.clientId);
  const note = input.note?.trim().slice(0, 500) || null;
  const items: RequestItem[] = [];
  let year: number | null = null;
  for (const it of input.items) {
    if (it.kind === "OTHER") {
      items.push({ kind: "OTHER", ref: null, label: "Other" });
      continue;
    }
    const c = choices.find((x) => x.kind === it.kind && x.ref === it.ref);
    // Not one of this account's own services, years or invoices: refused, never guessed.
    if (!c) throw new ValidationError("Choose what the invoice is for from the list.");
    if (!items.some((x) => x.kind === c.kind && x.ref === c.ref)) items.push({ kind: c.kind, ref: c.ref, label: c.label });
    year ??= c.taxYear;
  }
  if (!items.length && !note) throw new ValidationError("Tell us what the invoice is for: pick an item or write a short note.");
  if (items.some((i) => i.kind === "OTHER") && !note) throw new ValidationError("Add a short note saying what the invoice is for.");
  if (!items.length) items.push({ kind: "OTHER", ref: null, label: "Other" });
  if (input.taxYear != null) {
    if (!Number.isInteger(input.taxYear) || input.taxYear < 2000 || input.taxYear > new Date().getFullYear()) throw new ValidationError("Choose a tax year from the list.");
    year = input.taxYear;
  }
  const amountCents = input.amountCents ?? null;
  if (amountCents != null && (!Number.isInteger(amountCents) || amountCents <= 0 || amountCents > 100_000_000)) throw new ValidationError("Enter the amount as dollars and cents, e.g. 350.00, or leave it blank.");

  const [client, portalUser, owner] = await Promise.all([
    prisma.client.findUniqueOrThrow({ where: { id: input.clientId }, select: { displayName: true, businessName: true, clientType: true } }),
    prisma.portalUser.findUniqueOrThrow({ where: { id: user.id }, select: { name: true, email: true } }),
    prisma.businessOwner.count({ where: { clientId: input.clientId, portalUserId: user.id, archivedAt: null } }),
  ]);
  const businessName = client.clientType !== "INDIVIDUAL" ? client.businessName || client.displayName : null;
  const draft = { requesterName: portalUser.name, businessName, items: items as unknown as InvoiceRequest["items"], note, taxYear: year };
  const subject = requestTitle(draft, client.displayName).slice(0, 200);
  const body = [
    "I'd like to pay with an invoice. Please send my invoice to my portal.",
    `For: ${items.map((i) => (i.kind === "OTHER" ? "Other" : i.label)).join("; ")}`,
    ...(year ? [`Tax year: ${year}`] : []),
    ...(amountCents ? [`Amount (if known): ${money(amountCents)}`] : []),
    ...(note ? [`Note: ${note}`] : []),
  ].join("\n");

  const request = await prisma.$transaction(async (tx) => {
    // A business owner's request is private to them, like their other threads.
    const convo = await tx.conversation.create({ data: { clientId: input.clientId, subject, awaitingStaff: true, unreadByStaff: true, privateToPortalUserId: owner ? user.id : null } });
    await tx.message.create({
      data: { conversationId: convo.id, channel: "PORTAL", direction: "INBOUND", body, portalAuthorId: user.id, status: "DELIVERED", readByClientAt: new Date(), idempotencyKey: input.idempotencyKey || null },
    });
    const r = await tx.invoiceRequest.create({
      data: { clientId: input.clientId, portalUserId: user.id, requesterName: portalUser.name, requesterEmail: portalUser.email, businessName, items: items as unknown as object, taxYear: year, note, amountCents, conversationId: convo.id },
    });
    await audit(tx, { actorId: null, action: "invoice_request.created", entityType: "InvoiceRequest", entityId: r.id, clientId: input.clientId, details: { portalUserId: user.id, items: items.map((i) => i.kind), taxYear: year } });
    return r;
  });
  await queueStaffAlert({ conversationId: request.conversationId! });
  return request;
}

/** The client's own requests (for the portal), newest first. */
export async function portalInvoiceRequests(user: PortalActor, clientId: string) {
  await requireClientAccess(user.id, clientId, "message");
  return prisma.invoiceRequest.findMany({ where: { clientId, conversation: conversationScope(user.id) }, orderBy: { createdAt: "desc" }, take: 5 });
}

// ---------------------------------------------------------------------------------------------
// Staff side
// ---------------------------------------------------------------------------------------------

export type ConversationLabel = { title: string; requestId: string | null; legacy: boolean; status: string | null };

/**
 * Display titles for conversations that are invoice requests (new or legacy). Others are absent
 * from the map and keep their subject.
 */
export async function conversationLabels(conversationIds: string[]): Promise<Map<string, ConversationLabel>> {
  const out = new Map<string, ConversationLabel>();
  if (!conversationIds.length) return out;
  const rows = await prisma.conversation.findMany({
    where: { id: { in: conversationIds }, OR: [{ invoiceRequest: { isNot: null } }, { subject: LEGACY_SUBJECT }] },
    include: {
      client: { select: { displayName: true } },
      invoiceRequest: true,
      messages: { where: { direction: "INBOUND" }, orderBy: { createdAt: "asc" }, take: 1, include: { portalAuthor: { select: { name: true } } } },
    },
  });
  for (const c of rows) {
    if (c.invoiceRequest) {
      out.set(c.id, { title: requestTitle(c.invoiceRequest, c.client.displayName), requestId: c.invoiceRequest.id, legacy: (c.invoiceRequest.items as unknown as RequestItem[]).length === 0, status: c.invoiceRequest.status });
    } else {
      const who = c.messages[0]?.portalAuthor?.name ?? "the client";
      out.set(c.id, { title: `Invoice request (details not given) from ${who} for ${c.client.displayName}`, requestId: null, legacy: true, status: null });
    }
  }
  return out;
}

/** Price on the client's agreement for a service: the signed version, else the latest sent one. */
async function agreedPrice(serviceId: string) {
  const a = await prisma.pricingAgreement.findFirst({ where: { serviceId, status: { in: ["SIGNED", "SENT", "VIEWED"] } }, orderBy: [{ status: "desc" }, { version: "desc" }] });
  const signed = await prisma.pricingAgreement.findFirst({ where: { serviceId, status: "SIGNED" }, orderBy: { version: "desc" } });
  const use = signed ?? a;
  return use ? { cents: (use.terms as unknown as AgreementTerms).baseCents, signed: use.status === "SIGNED", version: use.version } : null;
}

export type RequestLine = RequestItem & { service: string; priceCents: number | null; priceNote: string | null };

async function linesOf(clientId: string, items: RequestItem[], clientType: string): Promise<RequestLine[]> {
  const out: RequestLine[] = [];
  for (const it of items) {
    if (it.kind === "SERVICE" && it.ref) {
      const s = await prisma.clientService.findFirst({ where: { id: it.ref, clientId }, select: { id: true, type: true, title: true } });
      const p = s ? await agreedPrice(s.id) : null;
      out.push({ ...it, service: s ? FIRM_SERVICE_OF[s.type] : "Other", priceCents: p?.cents ?? null, priceNote: p ? `${p.signed ? "Signed" : "Sent, not yet signed"} agreement v${p.version}` : "No price on an agreement" });
    } else if (it.kind === "TAX_YEAR" && it.ref) {
      const s = await prisma.clientService.findFirst({ where: { clientId, taxYear: Number(it.ref), type: { in: ["TAX_INDIVIDUAL", "TAX_BUSINESS", "TAX_NONPROFIT"] } }, select: { id: true, type: true } });
      const p = s ? await agreedPrice(s.id) : null;
      out.push({ ...it, service: s ? FIRM_SERVICE_OF[s.type] : clientType === "INDIVIDUAL" ? "Tax Preparation" : "Business Tax Preparation", priceCents: p?.cents ?? null, priceNote: p ? `${p.signed ? "Signed" : "Sent, not yet signed"} agreement v${p.version}` : "No price on an agreement" });
    } else if (it.kind === "INVOICE") {
      out.push({ ...it, service: "", priceCents: null, priceNote: "Already invoiced — open that invoice instead of creating a second one" });
    } else {
      out.push({ ...it, service: "Other", priceCents: null, priceNote: null });
    }
  }
  return out;
}

/**
 * The request card on the conversation. Everyone who can see the conversation sees who asked and
 * what for; prices and the client's invoices only show to staff with Billing → View, and the
 * Create button only to staff with Billing → Create.
 */
export async function invoiceRequestCard(actor: Actor, conversationId: string) {
  const convo = await prisma.conversation.findUnique({
    where: { id: conversationId },
    include: {
      invoiceRequest: true,
      client: { select: { id: true, displayName: true, businessName: true, clientType: true, email: true, phone: true } },
      messages: { where: { direction: "INBOUND" }, orderBy: { createdAt: "asc" }, take: 1, include: { portalAuthor: { select: { id: true, name: true, email: true, phone: true } } } },
    },
  });
  if (!convo || (!convo.invoiceRequest && convo.subject !== LEGACY_SUBJECT)) return null;
  const r = convo.invoiceRequest;
  const first = convo.messages[0];
  const portalUser = r?.portalUserId ? await prisma.portalUser.findUnique({ where: { id: r.portalUserId }, select: { name: true, email: true, phone: true } }) : (first?.portalAuthor ?? null);
  const [mayView, mayCreate] = await Promise.all([can(actor, "billing", "view"), can(actor, "billing", "create")]);
  const items = (r?.items as unknown as RequestItem[] | undefined) ?? [];
  const lines = mayView ? await linesOf(convo.clientId, items, convo.client.clientType) : items.map((i) => ({ ...i, service: "", priceCents: null, priceNote: null }));
  const invoices = mayView ? await invoiceRows(actor, { clientId: convo.clientId }) : null;
  const invoice = r?.invoiceId ? await prisma.invoice.findUnique({ where: { id: r.invoiceId }, select: { id: true, number: true, state: true } }) : null;
  return {
    conversationId,
    requestId: r?.id ?? null,
    legacy: !r || items.length === 0,
    title: r ? requestTitle(r, convo.client.displayName) : `Invoice request (details not given) from ${first?.portalAuthor?.name ?? "the client"} for ${convo.client.displayName}`,
    status: r?.status ?? (convo.awaitingStaff ? "OPEN" : "CLOSED"),
    client: convo.client,
    requester: { name: r?.requesterName ?? first?.portalAuthor?.name ?? "Client (portal)", email: r?.requesterEmail ?? portalUser?.email ?? null, phone: portalUser?.phone ?? null },
    businessName: r?.businessName ?? null,
    lines,
    taxYear: r?.taxYear ?? null,
    note: r?.note ?? null,
    message: first?.body ?? null,
    amountCents: r?.amountCents ?? null,
    requestedAt: r?.createdAt ?? first?.createdAt ?? convo.createdAt,
    invoice,
    invoices: invoices ? { open: invoices.filter((i) => i.balanceCents > 0), paid: invoices.filter((i) => i.status === "PAID"), drafts: invoices.filter((i) => i.state === "DRAFT" || i.state === "PENDING_APPROVAL") } : null,
    mayView,
    mayCreate,
    createHref: r ? `/owner/invoices/create?request=${r.id}` : `/owner/invoices/create?client=${convo.clientId}&conversation=${conversationId}`,
  };
}
export type InvoiceRequestCard = NonNullable<Awaited<ReturnType<typeof invoiceRequestCard>>>;

/**
 * Create Invoice prefilled from a request: the client, the service, the agreed price (or the
 * amount the client gave) and a description listing what they asked for. Nothing is saved here.
 */
export async function invoicePrefill(actor: Actor, ref: { requestId?: string | null; conversationId?: string | null }) {
  if (!(await can(actor, "billing", "create"))) return null;
  const convoId = ref.requestId ? (await prisma.invoiceRequest.findUnique({ where: { id: ref.requestId }, select: { conversationId: true } }))?.conversationId : ref.conversationId;
  const card = convoId ? await invoiceRequestCard(actor, convoId) : null;
  if (!card) return null;
  const billable = card.lines.filter((l) => l.kind !== "INVOICE");
  const priced = billable.filter((l) => l.priceCents != null);
  const amountCents = priced.length ? priced.reduce((s, l) => s + l.priceCents!, 0) : card.amountCents;
  const service = billable.find((l) => l.service)?.service ?? (card.client.clientType === "INDIVIDUAL" ? "Tax Preparation" : "Business Tax Preparation");
  const description = [
    ...billable.map((l) => (l.kind === "OTHER" ? card.note || "Services requested" : l.label)),
    ...(card.taxYear && !billable.some((l) => l.label.includes(String(card.taxYear))) ? [`Tax year ${card.taxYear}`] : []),
  ].join("; ") || card.note || "";
  return {
    card,
    clientId: card.client.id,
    service,
    amount: amountCents ? (amountCents / 100).toFixed(2) : "",
    description: description.slice(0, 2000),
    alreadyInvoiced: card.lines.filter((l) => l.kind === "INVOICE").map((l) => l.label),
  };
}

/**
 * Called when an invoice is created from a request (Create invoice for this request). A legacy
 * generic request gets its row now, so it also moves to Invoice created / sent automatically.
 */
export async function linkInvoiceToRequest(actorId: string, invoiceId: string, ref: { requestId?: string | null; conversationId?: string | null }) {
  const inv = await prisma.invoice.findUniqueOrThrow({ where: { id: invoiceId }, select: { clientId: true, number: true } });
  let requestId = ref.requestId ?? null;
  if (!requestId && ref.conversationId) {
    const convo = await prisma.conversation.findFirst({
      where: { id: ref.conversationId, clientId: inv.clientId, subject: LEGACY_SUBJECT },
      include: { invoiceRequest: true, messages: { where: { direction: "INBOUND" }, orderBy: { createdAt: "asc" }, take: 1, include: { portalAuthor: { select: { id: true, name: true, email: true } } } } },
    });
    if (!convo) throw new ValidationError("That request isn't for this client.");
    const author = convo.messages[0]?.portalAuthor;
    requestId =
      convo.invoiceRequest?.id ??
      (await prisma.invoiceRequest.create({ data: { clientId: inv.clientId, portalUserId: author?.id ?? null, requesterName: author?.name ?? "Client (portal)", requesterEmail: author?.email ?? null, items: [], conversationId: convo.id, createdAt: convo.createdAt } })).id;
  }
  if (!requestId) return;
  const res = await prisma.invoiceRequest.updateMany({ where: { id: requestId, clientId: inv.clientId, invoiceId: null, status: "OPEN" }, data: { status: "INVOICE_CREATED", invoiceId, invoiceCreatedAt: new Date() } });
  if (res.count !== 1) {
    const r = await prisma.invoiceRequest.findUnique({ where: { id: requestId }, select: { clientId: true, invoiceId: true } });
    if (!r || r.clientId !== inv.clientId) throw new ValidationError("That request isn't for this client.");
    if (r.invoiceId && r.invoiceId !== invoiceId) throw new ValidationError("An invoice was already created for this request.");
    return;
  }
  const r = await prisma.invoiceRequest.findUniqueOrThrow({ where: { id: requestId } });
  await ownerAudit(actorId, "billing.invoice_request_invoiced", "InvoiceRequest", requestId, { invoiceId, number: inv.number });
  if (r.conversationId) await systemNote(r.conversationId, `Invoice ${inv.number} was created for this request (draft). It's sent to the client the normal way from the invoice page.`);
}

/** After an invoice is sent (the normal send path): its request moves to Invoice sent and stops needing a reply. */
export async function onInvoiceSent(actorId: string, invoiceId: string) {
  const r = await prisma.invoiceRequest.findUnique({ where: { invoiceId }, include: { invoice: { select: { number: true } } } });
  if (!r || r.status === "INVOICE_SENT") return;
  const res = await prisma.invoiceRequest.updateMany({ where: { id: r.id, status: { not: "INVOICE_SENT" } }, data: { status: "INVOICE_SENT", invoiceSentAt: new Date() } });
  if (res.count !== 1) return;
  if (r.conversationId) {
    await prisma.conversation.update({ where: { id: r.conversationId }, data: { awaitingStaff: false } });
    await systemNote(r.conversationId, `Invoice ${r.invoice?.number ?? ""} was sent to the client's portal. This request no longer needs a reply.`);
  }
  await ownerAudit(actorId, "billing.invoice_request_sent", "InvoiceRequest", r.id, { invoiceId });
}

async function systemNote(conversationId: string, body: string) {
  // Staff-only, automatic (no author): never shown to the client and doesn't change "Needs reply".
  await prisma.message.create({ data: { conversationId, channel: "INTERNAL_NOTE", direction: "OUTBOUND", body, status: "DELIVERED" } });
}

/** Open requests for the Owner's Office lists. */
export async function openInvoiceRequests(clientId?: string) {
  const rows = await prisma.invoiceRequest.findMany({ where: { status: { in: ["OPEN", "INVOICE_CREATED"] }, ...(clientId ? { clientId } : {}) }, include: { client: { select: { displayName: true } } }, orderBy: { createdAt: "asc" }, take: 50 });
  return rows.map((r) => ({ ...r, title: requestTitle(r, r.client.displayName) }));
}
