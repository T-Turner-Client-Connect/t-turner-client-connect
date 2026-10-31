import "server-only";
import { prisma } from "@/lib/prisma";
import { audit } from "@/lib/audit";
import { ForbiddenError, type Actor } from "@/lib/auth/actor";
import type { PortalActor } from "@/lib/portal/session";
import { requireClientAccess } from "@/lib/portal/access";
import { normalizeEmail, normalizePhone } from "@/lib/normalize";
import { squareRequest, squareSettings, SquareError, type SquareCard } from "@/lib/square";
import { ValidationError } from "./clients";
import { isReportApprover } from "./bookkeeping-clients";
import { canManageBilling } from "./bookkeeping-profile";

/**
 * Existing Square recurring billing, linked read-only.
 *
 * Our bookkeeping clients already pay through recurring invoices set up in
 * Square (invoice numbers like "54499-R-0005": series 54499, fifth invoice).
 * This module only reads them — customers, invoices and the saved card's
 * display details — and links a series to the client(s) it covers. It never
 * creates, edits, sends, cancels or charges anything in Square, and while a
 * client is linked (or marked as already billed in Square) Client Connect
 * refuses to set up a second authorization, card or recurring charge.
 *
 * One series can cover several businesses (one combined bill); a client can be
 * on only one series, so nobody is billed twice through Client Connect.
 */

/** A business by its business name (an owner's name may be on the record too). */
export const nameOf = (c: { displayName: string; businessName?: string | null }) => c.businessName || c.displayName;

export const NOT_SYNCED = "Existing Square billing—not yet synced";
export type SquareState = "VERIFIED" | "SYNCED" | "LINKED" | "NOT_SYNCED" | "NONE";

export const CADENCE_LABELS = { WEEKLY: "Weekly", MONTHLY: "Monthly", QUARTERLY: "Quarterly", YEARLY: "Yearly", UNKNOWN: "Recurring" } as const;
type Cadence = keyof typeof CADENCE_LABELS;

export const INVOICE_STATUS_LABELS: Record<string, string> = {
  DRAFT: "Draft", SCHEDULED: "Scheduled", UNPAID: "Unpaid", PARTIALLY_PAID: "Partially paid", PAID: "Paid", PAYMENT_PENDING: "Payment pending",
  PARTIALLY_REFUNDED: "Partially refunded", REFUNDED: "Refunded", CANCELED: "Canceled", FAILED: "Payment failed",
};

export type SqInvoice = {
  id: string;
  invoice_number?: string;
  title?: string;
  status?: string;
  location_id?: string;
  primary_recipient?: { customer_id?: string };
  payment_requests?: { request_type?: string; due_date?: string; card_id?: string; automatic_payment_source?: string; computed_amount_money?: { amount?: number } }[];
};
type SqCustomer = { id: string; given_name?: string; family_name?: string; company_name?: string; email_address?: string; phone_number?: string };

/** The series part of a recurring invoice number ("54499-R-0005" → "54499"); null for a one-time invoice. */
export function seriesKeyOf(invoiceNumber: string | null | undefined) {
  const m = /^(.+)-R-\d+$/.exec((invoiceNumber ?? "").trim());
  return m ? m[1] : null;
}

const noon = (ymd: string) => new Date(`${ymd}T12:00:00.000Z`);
const OPEN = new Set(["SCHEDULED", "UNPAID", "PARTIALLY_PAID", "PAYMENT_PENDING"]);

function cadenceOf(dueDates: string[]): Cadence {
  if (dueDates.length < 2) return "UNKNOWN";
  const sorted = [...dueDates].sort();
  const gaps = sorted.slice(1).map((d, i) => (noon(d).getTime() - noon(sorted[i]).getTime()) / 86_400_000).sort((a, b) => a - b);
  const g = gaps[Math.floor(gaps.length / 2)];
  if (g >= 6 && g <= 8) return "WEEKLY";
  if (g >= 27 && g <= 32) return "MONTHLY";
  if (g >= 88 && g <= 93) return "QUARTERLY";
  if (g >= 360 && g <= 370) return "YEARLY";
  return "UNKNOWN";
}

/** What one recurring series looks like, worked out only from Square's own invoices. */
export function summarizeSeries(invoices: SqInvoice[], today: string) {
  const rows = invoices
    .map((i) => ({ i, req: i.payment_requests?.find((r) => r.request_type === "BALANCE") ?? i.payment_requests?.[0] }))
    .filter((r) => r.req?.due_date)
    .map((r) => ({ ...r, due: r.req!.due_date!, status: r.i.status ?? "UNKNOWN" }))
    .sort((a, b) => a.due.localeCompare(b.due));
  const live = rows.filter((r) => r.status !== "CANCELED" && r.status !== "DRAFT");
  const next = live.find((r) => OPEN.has(r.status) && r.due >= today) ?? null;
  const past = live.filter((r) => r.due < today || !OPEN.has(r.status));
  const last = past.at(-1) ?? null;
  const lastPaid = [...live].reverse().find((r) => r.status === "PAID") ?? null;
  const latest = next ?? live.at(-1) ?? rows.at(-1) ?? null;
  return {
    title: latest?.i.title?.trim() || null,
    amountCents: latest?.req?.computed_amount_money?.amount ?? null,
    cadence: cadenceOf(live.map((r) => r.due)),
    dueDay: latest ? Number(latest.due.slice(8, 10)) : null,
    nextDueDate: next ? noon(next.due) : null,
    nextInvoiceStatus: next?.status ?? null,
    lastDueDate: last ? noon(last.due) : null,
    lastInvoiceStatus: last?.status ?? null,
    lastPaidDueDate: lastPaid ? noon(lastPaid.due) : null,
    autopay: latest?.req?.automatic_payment_source === "CARD_ON_FILE",
    squareCardId: latest?.req?.automatic_payment_source === "CARD_ON_FILE" ? latest.req.card_id ?? null : null,
    invoiceCount: rows.length,
  };
}
export type SeriesSummary = ReturnType<typeof summarizeSeries>;

/** "Monthly · due on the 27th" */
export function scheduleText(a: { cadence: string | null; dueDay: number | null }) {
  const c = CADENCE_LABELS[(a.cadence ?? "UNKNOWN") as Cadence] ?? "Recurring";
  if (!a.dueDay) return c;
  const sfx = a.dueDay % 10 === 1 && a.dueDay !== 11 ? "st" : a.dueDay % 10 === 2 && a.dueDay !== 12 ? "nd" : a.dueDay % 10 === 3 && a.dueDay !== 13 ? "rd" : "th";
  return `${c} · due on the ${a.dueDay}${sfx}`;
}

/** Payment status in plain words, from Square's invoice statuses only. */
export function paymentStatus(a: { lastInvoiceStatus: string | null; nextDueDate: Date | null; nextInvoiceStatus: string | null }) {
  const s = a.lastInvoiceStatus;
  if (s === "FAILED") return { label: "Last automatic payment failed in Square", tone: "red" as const };
  if (s === "UNPAID" || s === "PARTIALLY_PAID") return { label: "Past due in Square", tone: "red" as const };
  if (s === "PAYMENT_PENDING") return { label: "Payment pending in Square", tone: "amber" as const };
  if (s === "PAID") return { label: a.nextDueDate ? "Paid — up to date" : "Paid — no upcoming invoice in Square", tone: a.nextDueDate ? ("green" as const) : ("amber" as const) };
  if (!s && a.nextDueDate) return { label: "First invoice scheduled", tone: "navy" as const };
  return { label: s ? INVOICE_STATUS_LABELS[s] ?? s : "No invoices found in Square", tone: "gray" as const };
}

export const todayCentral = () => new Date().toLocaleDateString("en-CA", { timeZone: "America/Chicago" });

async function assertBilling(actor: Actor) {
  if (!(await canManageBilling(actor))) throw new ForbiddenError("Only Tabitha (or staff she allows) can view or link Square billing.");
}
function requireSquare() {
  const s = squareSettings();
  if (!s.configured) throw new SquareError("Square isn't connected yet (Netlify needs SQUARE_ACCESS_TOKEN, SQUARE_LOCATION_ID and SQUARE_APPLICATION_ID), so nothing can be looked up.");
  return s;
}

// --- Read-only Square calls ---------------------------------------------------------

async function customerInvoices(customerId: string, locationId: string) {
  const out: SqInvoice[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 5; page++) {
    const r = await squareRequest<{ invoices?: SqInvoice[]; cursor?: string }>("POST", "/v2/invoices/search", {
      query: { filter: { location_ids: [locationId], customer_ids: [customerId] }, sort: { field: "INVOICE_SORT_DATE", order: "DESC" } },
      limit: 200,
      ...(cursor ? { cursor } : {}),
    });
    out.push(...(r.invoices ?? []));
    cursor = r.cursor;
    if (!cursor) break;
  }
  return out;
}

async function cardDetails(cardId: string | null) {
  if (!cardId) return null;
  try {
    const { card } = await squareRequest<{ card: SquareCard }>("GET", `/v2/cards/${encodeURIComponent(cardId)}`);
    return card;
  } catch {
    return null;
  }
}

function groupSeries(invoices: SqInvoice[], today: string) {
  const bySeries = new Map<string, SqInvoice[]>();
  for (const i of invoices) {
    const k = seriesKeyOf(i.invoice_number);
    if (!k) continue;
    bySeries.set(k, [...(bySeries.get(k) ?? []), i]);
  }
  return [...bySeries.entries()].map(([seriesKey, list]) => ({ seriesKey, ...summarizeSeries(list, today) }));
}

export type LookupInput = { email?: string; phone?: string; customerId?: string };

/** Finds Square customers by email, phone or customer ID and lists their recurring series. Reads only. */
export async function lookupSquareBilling(actor: Actor, input: LookupInput) {
  await assertBilling(actor);
  const s = requireSquare();
  const customers: SqCustomer[] = [];
  const add = (cs: SqCustomer[] | undefined) => cs?.forEach((c) => customers.some((x) => x.id === c.id) || customers.push(c));
  if (input.customerId?.trim()) {
    const id = input.customerId.trim();
    if (!/^[A-Za-z0-9_-]{6,64}$/.test(id)) throw new ValidationError("That doesn't look like a Square customer ID.");
    add([(await squareRequest<{ customer: SqCustomer }>("GET", `/v2/customers/${encodeURIComponent(id)}`)).customer]);
  }
  const email = normalizeEmail(input.email);
  if (input.email?.trim() && !email) throw new ValidationError("Enter a valid email address.");
  if (email) add((await squareRequest<{ customers?: SqCustomer[] }>("POST", "/v2/customers/search", { query: { filter: { email_address: { exact: email } } }, limit: 20 })).customers);
  const phone = normalizePhone(input.phone);
  if (input.phone?.trim() && !phone) throw new ValidationError("Enter a valid phone number.");
  if (phone) add((await squareRequest<{ customers?: SqCustomer[] }>("POST", "/v2/customers/search", { query: { filter: { phone_number: { exact: phone } } }, limit: 20 })).customers);
  if (!email && !phone && !input.customerId?.trim()) throw new ValidationError("Enter the client's email, phone or Square customer ID.");

  const today = todayCentral();
  const linked = await prisma.squareBillingArrangement.findMany({ where: { squareLocationId: s.locationId, squareCustomerId: { in: customers.map((c) => c.id) } }, include: { members: { include: { client: { select: { id: true, displayName: true, businessName: true } } } } } });
  const results = [];
  for (const c of customers.slice(0, 10)) {
    const series = groupSeries(await customerInvoices(c.id, s.locationId), today);
    results.push({
      id: c.id,
      name: [c.given_name, c.family_name].filter(Boolean).join(" ") || null,
      company: c.company_name ?? null,
      email: c.email_address ?? null,
      phone: c.phone_number ?? null,
      series: series.map((x) => ({ ...x, linked: linked.find((l) => l.seriesKey === x.seriesKey) ?? null })),
    });
  }
  await audit(prisma, { actorId: actor.id, action: "square_billing.looked_up", entityType: "Square", entityId: "lookup", details: { by: [input.customerId ? "customerId" : "", email ? "email" : "", phone ? "phone" : ""].filter(Boolean), customers: results.length } });
  return results;
}

/** Re-reads a linked series from Square and stores what it says. Never writes to Square. */
async function refresh(arrangementId: string) {
  const a = await prisma.squareBillingArrangement.findUniqueOrThrow({ where: { id: arrangementId } });
  try {
    const [customer, invoices] = await Promise.all([
      squareRequest<{ customer: SqCustomer }>("GET", `/v2/customers/${encodeURIComponent(a.squareCustomerId)}`).then((r) => r.customer).catch(() => null),
      customerInvoices(a.squareCustomerId, a.squareLocationId),
    ]);
    const mine = invoices.filter((i) => seriesKeyOf(i.invoice_number) === a.seriesKey);
    if (!mine.length) throw new SquareError(`Square returned no invoices for series ${a.seriesKey}. Nothing was changed in Square; check the series in the Square Dashboard.`);
    const sum = summarizeSeries(mine, todayCentral());
    const card = await cardDetails(sum.squareCardId);
    return prisma.squareBillingArrangement.update({
      where: { id: a.id },
      data: {
        ...sum,
        customerName: customer ? [customer.given_name, customer.family_name].filter(Boolean).join(" ") || null : a.customerName,
        companyName: customer ? customer.company_name ?? null : a.companyName,
        cardBrand: card?.card_brand ?? null, cardLast4: card?.last_4 ?? null, cardExpMonth: card?.exp_month ?? null, cardExpYear: card?.exp_year ?? null,
        syncedAt: new Date(), syncError: null,
      },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Square couldn't be read.";
    await prisma.squareBillingArrangement.update({ where: { id: a.id }, data: { syncError: msg.slice(0, 300) } });
    throw err;
  }
}

async function assertClientsFree(clientIds: string[], exceptArrangementId?: string) {
  const ids = [...new Set(clientIds.filter(Boolean))];
  if (!ids.length) throw new ValidationError("Choose the client(s) this Square bill covers.");
  const clients = await prisma.client.findMany({ where: { id: { in: ids } }, select: { id: true, displayName: true, businessName: true, archivedAt: true, squareBilling: { include: { arrangement: { select: { seriesKey: true } } } } } });
  if (clients.length !== ids.length || clients.some((c) => c.archivedAt)) throw new ValidationError("One of those clients wasn't found.");
  const taken = clients.find((c) => c.squareBilling && c.squareBilling.arrangementId !== exceptArrangementId);
  if (taken) throw new ValidationError(`${nameOf(taken)} is already linked to Square billing series ${taken.squareBilling!.arrangement.seriesKey}. A client can be on only one Square bill, so it's never billed twice. Remove that link first if it's wrong.`);
  return clients;
}

/** Links an existing Square recurring series to the client(s) it covers, then reads it from Square. */
export async function linkSquareBilling(actor: Actor, input: { customerId: string; seriesKey: string; clientIds: string[] }) {
  await assertBilling(actor);
  const s = requireSquare();
  if (!input.customerId || !input.seriesKey) throw new ValidationError("Choose the Square billing series to link.");
  const existing = await prisma.squareBillingArrangement.findUnique({ where: { squareLocationId_seriesKey: { squareLocationId: s.locationId, seriesKey: input.seriesKey } } });
  if (existing) throw new ValidationError("That Square series is already linked. Add the business to the existing link instead, so the bill stays one arrangement.");
  const clients = await assertClientsFree(input.clientIds);
  const a = await prisma.squareBillingArrangement.create({
    data: { squareCustomerId: input.customerId, squareLocationId: s.locationId, seriesKey: input.seriesKey, linkedById: actor.id, members: { create: clients.map((c) => ({ clientId: c.id, addedById: actor.id })) } },
  });
  await audit(prisma, { actorId: actor.id, action: "square_billing.linked", entityType: "SquareBillingArrangement", entityId: a.id, details: { seriesKey: a.seriesKey, squareCustomerId: a.squareCustomerId, clients: clients.map((c) => c.id) } });
  for (const c of clients) await audit(prisma, { actorId: actor.id, action: "square_billing.client_linked", entityType: "SquareBillingArrangement", entityId: a.id, clientId: c.id, details: { seriesKey: a.seriesKey } });
  try {
    await refresh(a.id);
  } catch {
    // Linked; the read error is shown on the link and Sync can be retried.
  }
  return prisma.squareBillingArrangement.findUniqueOrThrow({ where: { id: a.id } });
}

/** Adds another business to the same Square bill (one combined charge). */
export async function addClientToSquareBilling(actor: Actor, arrangementId: string, clientId: string) {
  await assertBilling(actor);
  const a = await prisma.squareBillingArrangement.findUnique({ where: { id: arrangementId } });
  if (!a) throw new ValidationError("Square billing link not found.");
  const [c] = await assertClientsFree([clientId], arrangementId);
  if (await prisma.squareBillingMember.findUnique({ where: { clientId } })) throw new ValidationError(`${nameOf(c)} is already on this Square bill.`);
  await prisma.squareBillingMember.create({ data: { arrangementId, clientId, addedById: actor.id } });
  await audit(prisma, { actorId: actor.id, action: "square_billing.client_linked", entityType: "SquareBillingArrangement", entityId: arrangementId, clientId, details: { seriesKey: a.seriesKey } });
}

/** Takes a client off a Square bill in Client Connect only. Square isn't touched; billing there continues unchanged. */
export async function removeClientFromSquareBilling(actor: Actor, arrangementId: string, clientId: string, reason: string) {
  if (!(await isReportApprover(actor))) throw new ForbiddenError("Only Tabitha can remove a Square billing link.");
  if (reason.trim().length < 5) throw new ValidationError("Record why this link is being removed.");
  const m = await prisma.squareBillingMember.findFirst({ where: { arrangementId, clientId } });
  if (!m) throw new ValidationError("That client isn't on this Square bill.");
  await prisma.squareBillingMember.delete({ where: { id: m.id } });
  await audit(prisma, { actorId: actor.id, action: "square_billing.client_unlinked", entityType: "SquareBillingArrangement", entityId: arrangementId, clientId, details: { reason: reason.trim().slice(0, 300) } });
  if (!(await prisma.squareBillingMember.count({ where: { arrangementId } }))) await prisma.squareBillingArrangement.delete({ where: { id: arrangementId } });
}

export async function syncSquareBilling(actor: Actor, arrangementId: string) {
  await assertBilling(actor);
  requireSquare();
  const a = await refresh(arrangementId);
  await audit(prisma, { actorId: actor.id, action: "square_billing.synced", entityType: "SquareBillingArrangement", entityId: a.id, details: { seriesKey: a.seriesKey } });
  return a;
}

export async function syncAllSquareBilling(actor: Actor) {
  await assertBilling(actor);
  requireSquare();
  const all = await prisma.squareBillingArrangement.findMany({ select: { id: true } });
  let ok = 0;
  const failed: string[] = [];
  for (const a of all) {
    try {
      await refresh(a.id);
      ok++;
    } catch (err) {
      failed.push(err instanceof Error ? err.message : a.id);
    }
  }
  await audit(prisma, { actorId: actor.id, action: "square_billing.synced_all", entityType: "Square", entityId: "all", details: { ok, failed: failed.length } });
  return { ok, failed };
}

/**
 * Tabitha confirms the client's authorization already on file in Square (for
 * example the card-on-file agreement they accepted in Square, or the signed
 * agreement in their file). Nothing new is asked of the client or created.
 */
export async function verifyExistingAuthorization(actor: Actor, arrangementId: string, note: string) {
  if (!(await isReportApprover(actor))) throw new ForbiddenError("Only Tabitha can verify an existing Square authorization.");
  if (note.trim().length < 5) throw new ValidationError("Note how you verified it (for example: card-on-file authorization in Square Dashboard, signed agreement in file).");
  const a = await prisma.squareBillingArrangement.findUnique({ where: { id: arrangementId } });
  if (!a) throw new ValidationError("Square billing link not found.");
  if (!a.syncedAt) throw new ValidationError("Sync this link from Square first, so you're verifying what Square shows.");
  await prisma.squareBillingArrangement.update({ where: { id: arrangementId }, data: { authorizationVerifiedAt: new Date(), authorizationVerifiedById: actor.id, authorizationNote: note.trim().slice(0, 300) } });
  await audit(prisma, { actorId: actor.id, action: "square_billing.authorization_verified", entityType: "SquareBillingArrangement", entityId: arrangementId, details: { note: note.trim().slice(0, 300) } });
}

/** Tabitha marks whether a client already pays through recurring billing in Square. */
export async function setSquareBillingExpected(actor: Actor, clientId: string, expected: boolean) {
  await assertBilling(actor);
  const p = await prisma.bookkeepingProfile.findUnique({ where: { clientId } });
  if (!p) throw new ValidationError("Add this client to Bookkeeping Clients first.");
  await prisma.bookkeepingProfile.update({ where: { clientId }, data: { squareBillingExpected: expected } });
  await audit(prisma, { actorId: actor.id, action: "square_billing.expected_set", entityType: "Client", entityId: clientId, clientId, details: { expected } });
}

// --- Reading what's linked -----------------------------------------------------------

export async function squareBillingFor(clientId: string) {
  const [member, profile] = await Promise.all([
    prisma.squareBillingMember.findUnique({ where: { clientId }, include: { arrangement: { include: { members: { include: { client: { select: { id: true, displayName: true, businessName: true } } }, orderBy: { createdAt: "asc" } } } } } }),
    prisma.bookkeepingProfile.findUnique({ where: { clientId }, select: { squareBillingExpected: true } }),
  ]);
  const a = member?.arrangement ?? null;
  const state = a ? (a.authorizationVerifiedAt ? "VERIFIED" : a.syncedAt ? "SYNCED" : "LINKED") : profile?.squareBillingExpected ? "NOT_SYNCED" : "NONE";
  return { arrangement: a, state: state as SquareState, expected: !!profile?.squareBillingExpected };
}

/**
 * Guard used wherever Client Connect could start a new authorization, card or
 * recurring charge: refuses when the client already pays through Square.
 */
export async function assertNotBilledInSquare(clientId: string, audience: "staff" | "client") {
  const { state } = await squareBillingFor(clientId);
  if (state === "NONE") return;
  throw new ValidationError(
    audience === "client"
      ? "Your billing with our office is already set up in Square, so there's nothing to authorize or add here and nothing new will be charged. Questions? Send us a message."
      : "This client already pays through recurring billing in Square. Client Connect won't record a second authorization or recurring charge — link and verify the existing Square billing instead.",
  );
}

/** The staff overview: every bookkeeping client and its Square billing link. */
export async function squareBillingOverview(actor: Actor) {
  await assertBilling(actor);
  const profiles = await prisma.bookkeepingProfile.findMany({
    where: { active: true, client: { archivedAt: null } },
    select: { clientId: true, squareBillingExpected: true, client: { select: { displayName: true, businessName: true, squareBilling: { include: { arrangement: { include: { members: { include: { client: { select: { id: true, displayName: true, businessName: true } } } } } } } } } } },
    orderBy: { client: { displayName: "asc" } },
  });
  return profiles.map((p) => {
    const a = p.client.squareBilling?.arrangement ?? null;
    return { clientId: p.clientId, name: nameOf(p.client), expected: p.squareBillingExpected, arrangement: a, state: (a ? (a.authorizationVerifiedAt ? "VERIFIED" : a.syncedAt ? "SYNCED" : "LINKED") : p.squareBillingExpected ? "NOT_SYNCED" : "NONE") as SquareState };
  });
}

/** What the client sees. Authorization is mentioned only once Tabitha has verified it. */
export async function portalSquareBilling(user: PortalActor, clientId: string) {
  await requireClientAccess(user.id, clientId, "billing");
  const { arrangement: a, state } = await squareBillingFor(clientId);
  if (!a) return { state, view: null };
  const mine = await prisma.portalAccess.findMany({ where: { portalUserId: user.id, revokedAt: null }, select: { clientId: true } });
  const visible = new Set(mine.map((m) => m.clientId));
  const others = a.members.filter((m) => m.clientId !== clientId);
  return {
    state,
    view: a.syncedAt
      ? {
          title: a.title, amountCents: a.amountCents, schedule: scheduleText(a), nextDueDate: a.nextDueDate, status: paymentStatus(a),
          card: a.autopay && a.cardLast4 ? { brand: a.cardBrand ?? "Card", last4: a.cardLast4, expMonth: a.cardExpMonth, expYear: a.cardExpYear } : null,
          autopay: a.autopay, authorizationVerified: !!a.authorizationVerifiedAt, syncedAt: a.syncedAt,
          alsoCovers: others.filter((m) => visible.has(m.clientId)).map((m) => nameOf(m.client)),
          otherAccounts: others.filter((m) => !visible.has(m.clientId)).length,
        }
      : null,
  };
}
