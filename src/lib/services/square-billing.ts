import "server-only";
import { randomUUID } from "node:crypto";
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
import { businessFamily } from "./related-businesses";

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
  order_id?: string;
  public_url?: string;
  payment_requests?: { request_type?: string; due_date?: string; card_id?: string; automatic_payment_source?: string; computed_amount_money?: { amount?: number }; total_completed_amount_money?: { amount?: number } }[];
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

const PERIOD_DAYS: Record<string, number> = { WEEKLY: 7, MONTHLY: 31, QUARTERLY: 92, YEARLY: 366 };
// Square makes each recurring invoice before the previous one is due, so a running series normally
// has a scheduled invoice. This much extra time is allowed before the evidence reads "likely ended".
const ENDED_GRACE_DAYS = 21;

export type SeriesStatus = "ACTIVE" | "NEEDS_REVIEW" | "ENDED";
export const SERIES_STATUS_LABELS: Record<SeriesStatus, string> = { ACTIVE: "Active", NEEDS_REVIEW: "Status needs review", ENDED: "Ended — history only" };

/**
 * What Square's own invoices say about a recurring series. Square's API has no series status, so
 * only a scheduled or open invoice proves a series is ACTIVE. Without one, the evidence is described
 * (waiting for the next invoice, likely ended, or all canceled) but never treated as proof it ended.
 */
export function seriesActivity(invoices: { status: string; due: string }[], cadence: string, today: string) {
  const open = invoices.filter((r) => OPEN.has(r.status));
  if (open.length) return { conclusive: true, active: true, evidence: "OPEN" as const, reason: `Square has ${open.length} scheduled or open invoice${open.length === 1 ? "" : "s"} in this series.`, expectedNext: null as string | null };
  const live = invoices.filter((r) => r.status !== "CANCELED" && r.status !== "DRAFT");
  if (!live.length) return { conclusive: false, active: false, evidence: "ALL_CANCELED" as const, reason: "Every invoice in this series was canceled in Square — it has likely ended.", expectedNext: null };
  const lastDue = live.map((r) => r.due).sort().at(-1)!;
  const period = PERIOD_DAYS[cadence] ?? 92;
  const expectedNext = new Date(noon(lastDue).getTime() + period * 86_400_000).toISOString().slice(0, 10);
  const cutoff = new Date(noon(expectedNext).getTime() + ENDED_GRACE_DAYS * 86_400_000).toISOString().slice(0, 10);
  if (today <= cutoff) return { conclusive: false, active: false, evidence: "WAITING" as const, reason: `No scheduled invoice in Square right now. The last was due ${lastDue}; the next would be expected around ${expectedNext}.`, expectedNext };
  return { conclusive: false, active: false, evidence: "LIKELY_ENDED" as const, reason: `No new invoice since the one due ${lastDue}; the next was expected around ${expectedNext}. The series has likely ended in Square.`, expectedNext };
}

/** Square's evidence first (a scheduled/open invoice is always ACTIVE); otherwise the owner's decision; otherwise needs review. */
export function seriesStatus(act: ReturnType<typeof seriesActivity>, decision: { decision: string } | null | undefined): SeriesStatus {
  if (act.conclusive && act.active) return "ACTIVE";
  if (decision?.decision === "ACTIVE" || decision?.decision === "ENDED") return decision.decision;
  return "NEEDS_REVIEW";
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
    lastPaidCents: lastPaid ? lastPaid.req?.total_completed_amount_money?.amount ?? lastPaid.req?.computed_amount_money?.amount ?? null : null,
    autopay: latest?.req?.automatic_payment_source === "CARD_ON_FILE",
    squareCardId: latest?.req?.automatic_payment_source === "CARD_ON_FILE" ? latest.req.card_id ?? null : null,
    invoiceCount: rows.length,
    activity: seriesActivity(rows.map((r) => ({ status: r.status, due: r.due })), cadenceOf(live.map((r) => r.due)), today),
    // Every invoice in this series, newest first, as Square reports it (Payment History).
    seriesInvoices: [...rows].reverse().filter((r) => r.status !== "DRAFT").map((r): SeriesInvoice => ({
      id: r.i.id, number: r.i.invoice_number ?? null, title: r.i.title ?? null, due: r.due, status: r.status,
      amountCents: r.req?.computed_amount_money?.amount ?? null, paidCents: r.req?.total_completed_amount_money?.amount ?? null,
      orderId: r.i.order_id ?? null, invoiceUrl: r.i.public_url ?? null, paidAt: null, receiptUrl: null,
    })),
  };
}
export type SeriesSummary = ReturnType<typeof summarizeSeries>;
export type SeriesInvoice = {
  id: string; number: string | null; title: string | null; due: string; status: string; amountCents: number | null; paidCents: number | null;
  orderId: string | null; invoiceUrl: string | null;
  // From Square's payment record for a PAID invoice (null when Square doesn't provide it).
  paidAt: string | null; receiptUrl: string | null;
};

/**
 * Adds Square's payment date and receipt link to each PAID invoice: invoice → order tenders →
 * payment. Reads only; a paid invoice's details are kept once found, so each is looked up once.
 */
async function withPaymentDetails(locationId: string, list: SeriesInvoice[], previous: SeriesInvoice[]) {
  const known = new Map(previous.filter((p) => p.paidAt).map((p) => [p.id, p]));
  const out = list.map((i) => (i.status === "PAID" && known.has(i.id) ? { ...i, paidAt: known.get(i.id)!.paidAt, receiptUrl: known.get(i.id)!.receiptUrl } : i));
  const need = out.filter((i) => i.status === "PAID" && !i.paidAt && i.orderId).slice(0, 24);
  if (!need.length) return out;
  try {
    const { orders } = await squareRequest<{ orders?: { id: string; tenders?: { payment_id?: string; created_at?: string }[] }[] }>("POST", "/v2/orders/batch-retrieve", { location_id: locationId, order_ids: need.map((i) => i.orderId) });
    for (const i of need) {
      const tender = orders?.find((o) => o.id === i.orderId)?.tenders?.at(-1);
      if (!tender?.payment_id) continue;
      const pay = await squareRequest<{ payment?: { status?: string; created_at?: string; updated_at?: string; receipt_url?: string } }>("GET", `/v2/payments/${encodeURIComponent(tender.payment_id)}`).catch(() => null);
      // Only a COMPLETED payment counts as proof of the paid date.
      if (pay?.payment?.status === "COMPLETED") Object.assign(i, { paidAt: (pay.payment.updated_at ?? pay.payment.created_at ?? tender.created_at ?? "").slice(0, 10) || null, receiptUrl: pay.payment.receipt_url ?? null });
    }
  } catch {
    // Without permission to read orders/payments the paid date is shown as unavailable; nothing else changes.
  }
  return out;
}

// Invoices Square still expects money on (scheduled-but-not-yet-due invoices aren't owed yet).
const OWED = new Set(["UNPAID", "PARTIALLY_PAID", "FAILED"]);

/** What is owed on a set of invoices (the linked series), from Square's own invoice statuses. */
export function balanceOf(invoices: SqInvoice[], today: string) {
  let outstandingCents = 0, outstandingCount = 0, overdueCents = 0, overdueCount = 0, failedCount = 0, paidMonthCents = 0;
  const month = today.slice(0, 7);
  for (const i of invoices) {
    if (i.status === "FAILED") failedCount++;
    if (i.status === "PAID") {
      const r = i.payment_requests?.find((x) => x.request_type === "BALANCE") ?? i.payment_requests?.[0];
      if (r?.due_date?.startsWith(month)) paidMonthCents += r.total_completed_amount_money?.amount ?? r.computed_amount_money?.amount ?? 0;
    }
    if (!OWED.has(i.status ?? "")) continue;
    const req = i.payment_requests?.find((r) => r.request_type === "BALANCE") ?? i.payment_requests?.[0];
    const owed = Math.max(0, (req?.computed_amount_money?.amount ?? 0) - (req?.total_completed_amount_money?.amount ?? 0));
    outstandingCents += owed;
    outstandingCount++;
    if (req?.due_date && req.due_date < today) {
      overdueCents += owed;
      overdueCount++;
    }
  }
  return { outstandingCents, outstandingCount, overdueCents, overdueCount, failedCount, paidMonth: month, paidMonthCents };
}

/** "Monthly · due on the 27th" */
export function scheduleText(a: { cadence: string | null; dueDay: number | null }) {
  const c = CADENCE_LABELS[(a.cadence ?? "UNKNOWN") as Cadence] ?? "Recurring";
  if (!a.dueDay) return c;
  const sfx = a.dueDay % 10 === 1 && a.dueDay !== 11 ? "st" : a.dueDay % 10 === 2 && a.dueDay !== 12 ? "nd" : a.dueDay % 10 === 3 && a.dueDay !== 13 ? "rd" : "th";
  return `${c} · due on the ${a.dueDay}${sfx}`;
}

/** Payment status in plain words, from Square's invoice statuses only. */
export function paymentStatus(a: { lastInvoiceStatus: string | null; nextDueDate: Date | null; nextInvoiceStatus: string | null; overdueCount?: number | null }) {
  const s = a.lastInvoiceStatus;
  // Never "up to date" while Square shows any invoice past due.
  if (a.overdueCount) return { label: `${a.overdueCount} invoice${a.overdueCount === 1 ? "" : "s"} overdue in Square`, tone: "red" as const };
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

// A recurring invoice series number as Square shows it: "54458", or an invoice number in it like "54458-R-0014".
const SERIES_QUERY = /^(\d{3,6})(?:-R(?:-\d+)?)?$/i;

/** The customer a recurring series bills, from the series' invoices at this location (newest first). Reads only. */
async function seriesCustomer(seriesKey: string, locationId: string) {
  let cursor: string | undefined;
  for (let page = 0; page < 10; page++) {
    const r = await squareRequest<{ invoices?: SqInvoice[]; cursor?: string }>("POST", "/v2/invoices/search", {
      query: { filter: { location_ids: [locationId] }, sort: { field: "INVOICE_SORT_DATE", order: "DESC" } },
      limit: 200,
      ...(cursor ? { cursor } : {}),
    });
    const hit = (r.invoices ?? []).find((i) => seriesKeyOf(i.invoice_number) === seriesKey && i.primary_recipient?.customer_id);
    if (hit) return hit.primary_recipient!.customer_id!;
    cursor = r.cursor;
    if (!cursor) break;
  }
  return null;
}

// Square customer IDs are long runs of capital letters and digits (with at least one digit), e.g. "VDKXEEKPJN48QDG3BGGFAK05P8".
const SQUARE_ID = /^(?=.*\d)(?=.*[A-Z])[A-Z0-9]{12,40}$/;

export type LookupInput = { email?: string; phone?: string; customerId?: string; query?: string };

/** Customers whose name or company contains every word typed (Square can't search names, so the list is read and filtered here). */
async function customersByName(text: string) {
  const words = text.toLowerCase().split(/\s+/).filter(Boolean);
  const out: SqCustomer[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 20 && out.length < 10; page++) {
    const r = await squareRequest<{ customers?: SqCustomer[]; cursor?: string }>("GET", `/v2/customers?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
    for (const c of r.customers ?? []) {
      const hay = [c.given_name, c.family_name, c.company_name].filter(Boolean).join(" ").toLowerCase();
      if (words.every((w) => hay.includes(w))) out.push(c);
    }
    cursor = r.cursor;
    if (!cursor) break;
  }
  return out;
}

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
  // One search box: an email, a phone number, or a name.
  const q = input.query?.trim() ?? "";
  const seriesQuery = q.match(SERIES_QUERY)?.[1] ?? null;
  if (q) {
    if (seriesQuery) {
      // A recurring invoice series number (e.g. "54458" or "54458-R-0014") is not a customer ID:
      // find the series' invoices at this location and read the customer they're billed to.
      const owner = await seriesCustomer(seriesQuery, s.locationId);
      if (owner) add([(await squareRequest<{ customer: SqCustomer }>("GET", `/v2/customers/${encodeURIComponent(owner)}`)).customer]);
    } else if (SQUARE_ID.test(q)) {
      // Looks like a Square customer ID: read that one customer (a miss falls through to "none found").
      try {
        add([(await squareRequest<{ customer: SqCustomer }>("GET", `/v2/customers/${encodeURIComponent(q)}`)).customer]);
      } catch (err) {
        if (!(err instanceof SquareError) || err.status !== 404) throw err;
      }
    } else if (q.includes("@")) {
      const e = normalizeEmail(q);
      if (!e) throw new ValidationError("Enter a valid email address.");
      add((await squareRequest<{ customers?: SqCustomer[] }>("POST", "/v2/customers/search", { query: { filter: { email_address: { fuzzy: e } } }, limit: 20 })).customers);
    } else if (q.replace(/\D/g, "").length >= 7) {
      const digits = q.replace(/\D/g, "");
      add((await squareRequest<{ customers?: SqCustomer[] }>("POST", "/v2/customers/search", { query: { filter: { phone_number: { fuzzy: digits.slice(-10) } } }, limit: 20 })).customers);
    } else if (q.length >= 2) {
      add(await customersByName(q));
    } else {
      throw new ValidationError("Type at least two letters of the name, or an email or phone number.");
    }
  }
  if (!email && !phone && !input.customerId?.trim() && !q) throw new ValidationError("Enter the client's name, email, phone or Square customer ID.");

  const today = todayCentral();
  const linked = await prisma.squareBillingArrangement.findMany({ where: { squareLocationId: s.locationId, squareCustomerId: { in: customers.map((c) => c.id) } }, include: { members: { include: { client: { select: { id: true, displayName: true, businessName: true } } } } } });
  const results = [];
  const decisions = await prisma.squareSeriesReview.findMany({ where: { squareLocationId: s.locationId, squareCustomerId: { in: customers.map((c) => c.id) } } });
  for (const c of customers.slice(0, 10)) {
    const series = groupSeries(await customerInvoices(c.id, s.locationId), today).map((x) => {
      const decision = decisions.find((d) => d.seriesKey === x.seriesKey && d.squareCustomerId === c.id) ?? null;
      return { ...x, status: seriesStatus(x.activity, decision), decision };
    });
    const info = (x: (typeof series)[number]) => ({ seriesKey: x.seriesKey, title: x.title, amountCents: x.amountCents, cadence: x.cadence, lastDueDate: x.lastDueDate, reason: x.activity.reason, decision: x.decision ? { decision: x.decision.decision, reason: x.decision.reason, decidedAt: x.decision.decidedAt } : null, matched: x.seriesKey === seriesQuery });
    results.push({
      id: c.id,
      name: [c.given_name, c.family_name].filter(Boolean).join(" ") || null,
      company: c.company_name ?? null,
      email: c.email_address ?? null,
      phone: c.phone_number ?? null,
      // Only ACTIVE series are offered for linking. Uncertain ones wait for the owner's review; ended ones are history.
      series: series.filter((x) => x.status === "ACTIVE").map((x) => ({ ...x, linked: linked.find((l) => l.seriesKey === x.seriesKey && l.active && l.members.length) ?? null, matched: x.seriesKey === seriesQuery })),
      review: series.filter((x) => x.status === "NEEDS_REVIEW").map(info),
      ended: series.filter((x) => x.status === "ENDED").map(info),
    });
  }
  await audit(prisma, { actorId: actor.id, action: "square_billing.looked_up", entityType: "Square", entityId: "lookup", details: { by: [input.customerId ? "customerId" : "", email ? "email" : "", phone ? "phone" : "", q ? (seriesQuery ? "series" : "search") : ""].filter(Boolean), customers: results.length } });
  return results;
}

/**
 * Automatic suggestions when a client's billing card opens: searches Square (read only) with the
 * client's saved email, phone, business name and name, and ranks what comes back. Only a single
 * customer matching on email or phone, with no rival, counts as a confident match — and even
 * then it's shown for the owner to confirm, never linked automatically.
 */
export async function suggestSquareMatches(actor: Actor, clientId: string) {
  await assertBilling(actor);
  const c = await prisma.client.findUnique({ where: { id: clientId }, select: { displayName: true, businessName: true, firstName: true, lastName: true, email: true, phone: true, contacts: { select: { email: true, phone: true }, take: 5 } } });
  if (!c) throw new ValidationError("Client not found.");
  const emails = [...new Set([c.email, ...c.contacts.map((x) => x.email)].map((e) => normalizeEmail(e ?? undefined)).filter(Boolean) as string[])];
  const phones = [...new Set([c.phone, ...c.contacts.map((x) => x.phone)].map((p) => (p ?? "").replace(/\D/g, "").slice(-10)).filter((p) => p.length === 10))];
  const person = [c.firstName, c.lastName].filter(Boolean).join(" ").trim();
  const plain = (n: string | null | undefined) => (n ?? "").toLowerCase().replace(/\([^)]*\)|[,.]|\b(llc|inc|corp|co|ltd)\b/g, " ").replace(/\s+/g, " ").trim();
  const names = [...new Set([c.businessName, person || c.displayName].map(plain).filter((n) => n.length >= 2))];
  const queries = [...emails, ...phones, ...names];
  if (!queries.length) return { searched: [], results: [] as Awaited<ReturnType<typeof lookupSquareBilling>>, scores: {} as Record<string, { score: number; reasons: string[] }>, confident: null as string | null };
  const byId = new Map<string, Awaited<ReturnType<typeof lookupSquareBilling>>[number]>();
  for (const q of queries) for (const r of await lookupSquareBilling(actor, { query: q })) if (!byId.has(r.id)) byId.set(r.id, r);
  const low = (v: string | null) => (v ?? "").toLowerCase();
  const digits = (v: string | null) => (v ?? "").replace(/\D/g, "").slice(-10);
  const scores: Record<string, { score: number; reasons: string[] }> = {};
  for (const r of byId.values()) {
    const reasons: string[] = [];
    let score = 0;
    const add = (points: number, why: string) => {
      score += points;
      reasons.push(why);
    };
    if (r.email && emails.includes(low(r.email))) add(3, "email matches");
    if (r.phone && phones.includes(digits(r.phone))) add(3, "phone matches");
    if (r.company && plain(r.company) && names.some((n) => plain(r.company).includes(n) || n.includes(plain(r.company)))) add(2, "business name matches");
    if (r.name && person && low(r.name) === low(person)) add(1, "name matches");
    if (r.email && emails.length && !emails.includes(low(r.email))) reasons.push("different email in Square");
    scores[r.id] = { score, reasons };
  }
  const results = [...byId.values()].sort((a, b) => scores[b.id].score - scores[a.id].score);
  const strong = results.filter((r) => scores[r.id].score >= 3);
  const confident = strong.length === 1 ? strong[0].id : null;
  return { searched: queries, results, scores, confident };
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
    const { activity, seriesInvoices, ...sum } = summarizeSeries(mine, todayCentral());
    const invoicesWithPayments = await withPaymentDetails(a.squareLocationId, seriesInvoices, (a.seriesInvoices as SeriesInvoice[] | null) ?? []);
    const decision = await prisma.squareSeriesReview.findUnique({ where: { squareLocationId_seriesKey: { squareLocationId: a.squareLocationId, seriesKey: a.seriesKey } } });
    const status = seriesStatus(activity, decision);
    const active = status === "ACTIVE";
    const reason = decision && !activity.conclusive ? `Owner decision: ${decision.reason}` : activity.reason;
    // Balances for THIS series only — never another series of the same customer.
    const bal = balanceOf(mine, todayCentral());
    const card = await cardDetails(sum.squareCardId);
    // Only a series that is ACTIVE stays in the current billing view; its history always stays.
    const before: SeriesStatus = a.active ? "ACTIVE" : a.needsReview ? "NEEDS_REVIEW" : "ENDED";
    if (before !== status) {
      const members = await prisma.squareBillingMember.findMany({ where: { arrangementId: a.id }, select: { clientId: true } });
      for (const m of members.length ? members : [{ clientId: null as string | null }]) {
        await audit(prisma, { actorId: null, action: "square_billing.series_status_changed", entityType: "SquareBillingArrangement", entityId: a.id, clientId: m.clientId, details: { seriesKey: a.seriesKey, from: before, to: status, reason } });
      }
    }
    return prisma.squareBillingArrangement.update({
      where: { id: a.id },
      data: {
        ...sum,
        ...bal,
        active,
        needsReview: status === "NEEDS_REVIEW",
        seriesInvoices: invoicesWithPayments,
        endedAt: active ? null : a.active ? new Date() : a.endedAt,
        endedReason: active ? null : reason,
        customerName: customer ? [customer.given_name, customer.family_name].filter(Boolean).join(" ") || null : a.customerName,
        companyName: customer ? customer.company_name ?? null : a.companyName,
        cardBrand: card?.card_brand ?? null, cardLast4: card?.last_4 ?? null, cardExpMonth: card?.exp_month ?? null, cardExpYear: card?.exp_year ?? null,
        syncedAt: new Date(), syncError: null, syncFailedAt: null,
      },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Square couldn't be read.";
    await prisma.squareBillingArrangement.update({ where: { id: a.id }, data: { syncError: msg.slice(0, 300), syncFailedAt: new Date() } });
    throw err;
  }
}

/**
 * One Square bill covers one owner's records only: every client on it must be
 * in the same owner group, and none may also be linked under another owner.
 * Stops a wrongly linked business from being billed with an unrelated client.
 */
async function assertOneOwnerGroup(clientIds: string[]) {
  let anchor: string | null = null;
  for (const id of clientIds) {
    const fam = await businessFamily(id);
    if (!fam) throw new ValidationError("Client not found.");
    if (fam.otherOwners.length) throw new ValidationError(`${nameOf(fam.current)} is linked to more than one owner. Resolve that in Linked records review before billing it.`);
    if (anchor && fam.anchor.id !== anchor) throw new ValidationError("Every business on one Square bill must belong to the same owner.");
    anchor = fam.anchor.id;
  }
}

async function assertClientsFree(clientIds: string[], exceptArrangementId?: string) {
  const ids = [...new Set(clientIds.filter(Boolean))];
  if (!ids.length) throw new ValidationError("Choose the client(s) this Square bill covers.");
  const clients = await prisma.client.findMany({ where: { id: { in: ids } }, select: { id: true, displayName: true, businessName: true, archivedAt: true, squareBilling: { include: { arrangement: { select: { seriesKey: true, active: true } } } } } });
  if (clients.length !== ids.length || clients.some((c) => c.archivedAt)) throw new ValidationError("One of those clients wasn't found.");
  // A link to a series that has ended in Square doesn't block linking the client's current series.
  const taken = clients.find((c) => c.squareBilling && c.squareBilling.arrangement.active && c.squareBilling.arrangementId !== exceptArrangementId);
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
  await assertOneOwnerGroup(clients.map((c) => c.id));
  // The same Square customer's other billing can't already belong to a different owner's records.
  const elsewhere = await prisma.squareBillingMember.findMany({ where: { arrangement: { squareCustomerId: input.customerId, squareLocationId: s.locationId } }, select: { clientId: true } });
  if (elsewhere.length) await assertOneOwnerGroup([...elsewhere.map((m) => m.clientId), ...clients.map((c) => c.id)]).catch(() => {
    throw new ValidationError("This Square customer's billing is already linked to a different client's records. Check the match before linking.");
  });
  // Read the series from Square first: it must belong to this customer and still be running.
  const seriesInvoices = (await customerInvoices(input.customerId, s.locationId)).filter((i) => seriesKeyOf(i.invoice_number) === input.seriesKey);
  if (!seriesInvoices.length) throw new ValidationError(`Square has no invoices in series ${input.seriesKey} for this customer, so it can't be linked to them.`);
  const check = summarizeSeries(seriesInvoices, todayCentral());
  const decision = await prisma.squareSeriesReview.findUnique({ where: { squareLocationId_seriesKey: { squareLocationId: s.locationId, seriesKey: input.seriesKey } } });
  const status = seriesStatus(check.activity, decision);
  if (status !== "ACTIVE") throw new ValidationError(`Series ${input.seriesKey} isn't verified as active (${SERIES_STATUS_LABELS[status]}), so it isn't linked: ${check.activity.reason}${status === "NEEDS_REVIEW" ? " The owner can review it first." : ""} Its invoices stay in Square's history.`);
  // A client still on a series that has since ended moves to the current one; the ended link is kept as history.
  for (const c of clients) {
    const old = await prisma.squareBillingMember.findUnique({ where: { clientId: c.id }, include: { arrangement: { select: { id: true, active: true, seriesKey: true, formerClientIds: true } } } });
    if (!old || old.arrangement.active) continue;
    await prisma.squareBillingMember.delete({ where: { id: old.id } });
    await prisma.squareBillingArrangement.update({ where: { id: old.arrangement.id }, data: { formerClientIds: [...new Set([...old.arrangement.formerClientIds, c.id])] } });
    await audit(prisma, { actorId: actor.id, action: "square_billing.moved_from_ended_series", entityType: "SquareBillingArrangement", entityId: old.arrangement.id, clientId: c.id, details: { endedSeriesKey: old.arrangement.seriesKey, newSeriesKey: input.seriesKey } });
  }
  const a = await prisma.squareBillingArrangement.create({
    data: { squareCustomerId: input.customerId, squareLocationId: s.locationId, seriesKey: input.seriesKey, linkedById: actor.id, members: { create: clients.map((c) => ({ clientId: c.id, addedById: actor.id })) } },
  });
  // The verified Square customer ID is saved on each client's billing record. Any earlier value
  // (for example one typed by hand) is kept in the audit history, never silently dropped.
  const now = new Date();
  for (const c of clients) {
    const before = await prisma.bookkeepingBilling.findUnique({ where: { clientId: c.id }, select: { squareCustomerId: true, squareCustomerIdSource: true } });
    const data = { squareCustomerId: input.customerId, squareCustomerIdSource: "SQUARE_LINK", squareCustomerIdVerifiedAt: now };
    await prisma.bookkeepingBilling.upsert({ where: { clientId: c.id }, create: { clientId: c.id, ...data }, update: data });
    await audit(prisma, { actorId: actor.id, action: "square_billing.customer_id_verified", entityType: "Client", entityId: c.id, clientId: c.id, details: { squareCustomerId: input.customerId, previous: before?.squareCustomerId ? { squareCustomerId: before.squareCustomerId, source: before.squareCustomerIdSource ?? "MANUAL" } : null } });
  }
  await audit(prisma, { actorId: actor.id, action: "square_billing.linked", entityType: "SquareBillingArrangement", entityId: a.id, details: { seriesKey: a.seriesKey, squareCustomerId: a.squareCustomerId, clients: clients.map((c) => c.id) } });
  for (const c of clients) await audit(prisma, { actorId: actor.id, action: "square_billing.client_linked", entityType: "SquareBillingArrangement", entityId: a.id, clientId: c.id, details: { seriesKey: a.seriesKey } });
  try {
    await refresh(a.id);
  } catch {
    // Linked; the read error is shown on the link and Sync can be retried.
  }
  return prisma.squareBillingArrangement.findUniqueOrThrow({ where: { id: a.id } });
}

/**
 * The owner settles a series Square's invoices can't (no scheduled or open invoice): ACTIVE or
 * ENDED, with a reason. Reads Square to confirm the series belongs to the customer; changes nothing
 * in Square. A later scheduled/open invoice in Square always counts as ACTIVE regardless.
 */
export async function reviewSquareSeries(actor: Actor, input: { customerId: string; seriesKey: string; decision: "ACTIVE" | "ENDED"; reason: string }) {
  if (!(await isReportApprover(actor))) throw new ForbiddenError("Only Tabitha can decide a recurring series' status.");
  const s = requireSquare();
  if (input.decision !== "ACTIVE" && input.decision !== "ENDED") throw new ValidationError("Choose Active or Ended.");
  const reason = input.reason.trim();
  if (reason.length < 5) throw new ValidationError("Record why (for example: “Replaced by monthly series 54458 in Sept 2025”).");
  const mine = (await customerInvoices(input.customerId, s.locationId)).filter((i) => seriesKeyOf(i.invoice_number) === input.seriesKey);
  if (!mine.length) throw new ValidationError(`Square has no invoices in series ${input.seriesKey} for this customer.`);
  const before = await prisma.squareSeriesReview.findUnique({ where: { squareLocationId_seriesKey: { squareLocationId: s.locationId, seriesKey: input.seriesKey } } });
  const data = { squareCustomerId: input.customerId, decision: input.decision, reason: reason.slice(0, 300), decidedById: actor.id, decidedAt: new Date() };
  await prisma.squareSeriesReview.upsert({ where: { squareLocationId_seriesKey: { squareLocationId: s.locationId, seriesKey: input.seriesKey } }, create: { squareLocationId: s.locationId, seriesKey: input.seriesKey, ...data }, update: data });
  await audit(prisma, { actorId: actor.id, action: "square_billing.series_reviewed", entityType: "Square", entityId: `${s.locationId}:${input.seriesKey}`, details: { seriesKey: input.seriesKey, squareCustomerId: input.customerId, decision: input.decision, reason: data.reason, previous: before ? { decision: before.decision, reason: before.reason } : null } });
  const linked = await prisma.squareBillingArrangement.findUnique({ where: { squareLocationId_seriesKey: { squareLocationId: s.locationId, seriesKey: input.seriesKey } } });
  if (linked) await refresh(linked.id).catch(() => {});
  return { status: seriesStatus(summarizeSeries(mine, todayCentral()).activity, data) };
}

/** Adds another business to the same Square bill (one combined charge). */
export async function addClientToSquareBilling(actor: Actor, arrangementId: string, clientId: string) {
  await assertBilling(actor);
  const a = await prisma.squareBillingArrangement.findUnique({ where: { id: arrangementId } });
  if (!a) throw new ValidationError("Square billing link not found.");
  if (!a.active) throw new ValidationError("That Square series has ended, so no one can be added to it. Link the client's current series instead.");
  const [c] = await assertClientsFree([clientId], arrangementId);
  const current = await prisma.squareBillingMember.findUnique({ where: { clientId }, include: { arrangement: { select: { active: true } } } });
  if (current?.arrangementId === arrangementId) throw new ValidationError(`${nameOf(c)} is already on this Square bill.`);
  if (current && !current.arrangement.active) {
    // Leaving an ended series for this current one; the ended link is kept as history.
    await prisma.squareBillingMember.delete({ where: { id: current.id } });
    await prisma.squareBillingArrangement.update({ where: { id: current.arrangementId }, data: { formerClientIds: { push: clientId } } });
  }
  const members = await prisma.squareBillingMember.findMany({ where: { arrangementId }, select: { clientId: true } });
  await assertOneOwnerGroup([...members.map((m) => m.clientId), clientId]);
  await prisma.squareBillingMember.create({ data: { arrangementId, clientId, addedById: actor.id } });
  await audit(prisma, { actorId: actor.id, action: "square_billing.client_linked", entityType: "SquareBillingArrangement", entityId: arrangementId, clientId, details: { seriesKey: a.seriesKey } });
}

/** Takes a client off a Square bill in Client Connect only. Square isn't touched; billing there continues unchanged. */
export async function removeClientFromSquareBilling(actor: Actor, arrangementId: string, clientId: string, reason: string) {
  if (!(await isReportApprover(actor))) throw new ForbiddenError("Only Tabitha can remove a Square billing link.");
  if (reason.trim().length < 5) throw new ValidationError("Record why this link is being removed.");
  const m = await prisma.squareBillingMember.findFirst({ where: { arrangementId, clientId }, include: { arrangement: { select: { squareCustomerId: true, seriesKey: true } } } });
  if (!m) throw new ValidationError("That client isn't on this Square bill.");
  await prisma.squareBillingMember.delete({ where: { id: m.id } });
  // A wrong match also takes its verified customer ID off this client; the audit keeps what it was.
  const billing = await prisma.bookkeepingBilling.findUnique({ where: { clientId }, select: { squareCustomerId: true, squareCustomerIdSource: true } });
  const clearId = billing?.squareCustomerIdSource === "SQUARE_LINK" && billing.squareCustomerId === m.arrangement.squareCustomerId;
  if (clearId) await prisma.bookkeepingBilling.update({ where: { clientId }, data: { squareCustomerId: null, squareCustomerIdSource: null, squareCustomerIdVerifiedAt: null } });
  await audit(prisma, { actorId: actor.id, action: "square_billing.client_unlinked", entityType: "SquareBillingArrangement", entityId: arrangementId, clientId, details: { reason: reason.trim().slice(0, 300), squareCustomerId: m.arrangement.squareCustomerId, seriesKey: m.arrangement.seriesKey, customerIdCleared: clearId } });
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
 * Scheduled, read-only refresh (hourly cron): re-reads every linked series not synced in the last
 * `maxAgeHours`. Never writes to Square. No actor — recorded as the system in the audit log.
 */
export async function syncStaleSquareBilling(maxAgeMinutes = 50, now = new Date()) {
  if (!squareSettings().configured) return { ok: 0, failed: 0, skipped: "not configured" };
  const runId = randomUUID();
  if (!(await takeLock("square-sync", runId, now))) return { ok: 0, failed: 0, skipped: "another sync is still running" };
  try {
    const cutoff = new Date(now.getTime() - maxAgeMinutes * 60_000);
    // Only series that were confirmed and linked to a client (an arrangement exists only after a confirmed link).
    const daily = new Date(now.getTime() - 24 * 3600_000);
    // Current series hourly; ended ones once a day, in case Square resumes them.
    const due = await prisma.squareBillingArrangement.findMany({
      where: { members: { some: {} }, OR: [{ active: true, OR: [{ syncedAt: null }, { syncedAt: { lt: cutoff } }] }, { active: false, OR: [{ syncedAt: null }, { syncedAt: { lt: daily } }] }] },
      select: { id: true },
      take: 200,
    });
    let ok = 0;
    const failed: { arrangementId: string; code: string }[] = [];
    for (const a of due) {
      try {
        await refresh(a.id);
        ok++;
      } catch (err) {
        // Logged by record id and error code only — no names, amounts or card details.
        failed.push({ arrangementId: a.id, code: err instanceof SquareError ? err.code ?? `HTTP_${err.status ?? 0}` : "ERROR" });
      }
    }
    if (due.length) await audit(prisma, { actorId: null, action: "square_billing.synced_scheduled", entityType: "Square", entityId: runId, details: { ok, failed: failed.length, failures: failed.slice(0, 50) } });
    if (failed.length) console.warn(`square sync ${runId}: ${ok} ok, ${failed.length} failed (${[...new Set(failed.map((f) => f.code))].join(", ")})`);
    return { ok, failed: failed.length };
  } finally {
    await prisma.jobLock.update({ where: { name: "square-sync" }, data: { lockedUntil: new Date(0), runId: null } }).catch(() => {});
  }
}

/** Takes a named lock for up to 15 minutes; false if another run holds it. */
async function takeLock(name: string, runId: string, now: Date) {
  const until = new Date(now.getTime() + 15 * 60_000);
  const got = await prisma.jobLock.updateMany({ where: { name, lockedUntil: { lt: now } }, data: { lockedUntil: until, runId } });
  if (got.count === 1) return true;
  try {
    await prisma.jobLock.create({ data: { name, lockedUntil: until, runId } });
    return true;
  } catch {
    return false; // the row exists and is held
  }
}

/** True when the last successful read is older than ~50 minutes (the card refreshes itself on open). */
export function syncDue(a: { syncedAt: Date | null }, now = new Date()) {
  return !a.syncedAt || now.getTime() - a.syncedAt.getTime() > 50 * 60_000;
}

/** Last verified figures are "stale" when the latest read failed or none succeeded recently. */
export function staleness(a: { syncedAt: Date | null; syncFailedAt: Date | null }, now = new Date()) {
  if (!a.syncedAt) return { stale: true, reason: "Not read from Square yet." };
  if (a.syncFailedAt && a.syncFailedAt > a.syncedAt) return { stale: true, reason: "Square couldn't be read on the last attempt." };
  if (now.getTime() - a.syncedAt.getTime() > 3 * 3600_000) return { stale: true, reason: "Not refreshed in the last 3 hours." };
  return { stale: false, reason: null };
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
  // Only a series still running in Square is current billing; an ended one is history.
  const a = member?.arrangement.active ? member.arrangement : null;
  const ended = await prisma.squareBillingArrangement.findMany({
    where: { active: false, OR: [{ members: { some: { clientId } } }, { formerClientIds: { has: clientId } }] },
    select: { id: true, seriesKey: true, title: true, amountCents: true, cadence: true, lastDueDate: true, endedAt: true, endedReason: true, squareCustomerId: true, needsReview: true },
    orderBy: { endedAt: "desc" },
  });
  const state = a ? (a.authorizationVerifiedAt ? "VERIFIED" : a.syncedAt ? "SYNCED" : "LINKED") : profile?.squareBillingExpected ? "NOT_SYNCED" : "NONE";
  return { arrangement: a, ended: ended.filter((e) => !e.needsReview), review: ended.filter((e) => e.needsReview), state: state as SquareState, expected: !!profile?.squareBillingExpected };
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
    const a = p.client.squareBilling?.arrangement.active ? p.client.squareBilling.arrangement : null;
    return { clientId: p.clientId, name: nameOf(p.client), expected: p.squareBillingExpected, arrangement: a, state: (a ? (a.authorizationVerifiedAt ? "VERIFIED" : a.syncedAt ? "SYNCED" : "LINKED") : p.squareBillingExpected ? "NOT_SYNCED" : "NONE") as SquareState };
  });
}

const MONTHLY_FACTOR: Record<string, number> = { MONTHLY: 1, QUARTERLY: 1 / 3, YEARLY: 1 / 12, WEEKLY: 52 / 12 };

/**
 * Owner's Office totals across every linked (confirmed) Square series, from the last verified sync
 * only. Each Square bill counts once, however many businesses it covers.
 */
export async function squareRevenueSummary(now = new Date()) {
  // Current billing only: series that have ended in Square are left out of every total.
  const all = await prisma.squareBillingArrangement.findMany({ where: { active: true, members: { some: {} } }, include: { members: { include: { client: { select: { id: true, displayName: true, businessName: true } } } } } });
  const endedCount = await prisma.squareBillingArrangement.count({ where: { active: false, needsReview: false, members: { some: {} } } });
  const reviewCount = await prisma.squareBillingArrangement.count({ where: { needsReview: true, members: { some: {} } } });
  const synced = all.filter((a) => a.syncedAt);
  const month = todayCentral().slice(0, 7);
  const in30 = new Date(now.getTime() + 30 * 86_400_000);
  const sum = (f: (a: (typeof all)[number]) => number) => synced.reduce((n, a) => n + f(a), 0);
  const unknownCadence = synced.filter((a) => a.amountCents != null && !(a.cadence && a.cadence in MONTHLY_FACTOR));
  const oldestSync = synced.reduce<Date | null>((d, a) => (!d || a.syncedAt! < d ? a.syncedAt! : d), null);
  return {
    linked: all.length,
    endedCount,
    reviewCount,
    synced: synced.length,
    stale: all.filter((a) => staleness(a, now).stale).length,
    oldestSync,
    month,
    recurringMonthlyCents: Math.round(sum((a) => (a.amountCents ?? 0) * (MONTHLY_FACTOR[a.cadence ?? ""] ?? 0))),
    unknownCadence: unknownCadence.length,
    paidThisMonthCents: sum((a) => (a.paidMonth === month ? a.paidMonthCents ?? 0 : 0)),
    outstandingCents: sum((a) => a.outstandingCents ?? 0),
    overdueCents: sum((a) => a.overdueCents ?? 0),
    overdueInvoices: sum((a) => a.overdueCount ?? 0),
    failedInvoices: sum((a) => a.failedCount ?? 0),
    upcoming: synced.filter((a) => a.nextDueDate && a.nextDueDate <= in30).sort((x, y) => x.nextDueDate!.getTime() - y.nextDueDate!.getTime()),
    upcomingCents: sum((a) => (a.nextDueDate && a.nextDueDate <= in30 ? a.amountCents ?? 0 : 0)),
    attention: synced.filter((a) => (a.overdueCount ?? 0) > 0 || (a.failedCount ?? 0) > 0),
    rows: all,
  };
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
          // This series only: each invoice's amount, due date, Square-confirmed paid date and receipt.
          invoices: ((a.seriesInvoices as SeriesInvoice[] | null) ?? []).map((i) => ({ number: i.number, due: i.due, status: i.status, amountCents: i.amountCents, paidCents: i.status === "PARTIALLY_PAID" ? i.paidCents : null, paidAt: i.status === "PAID" ? i.paidAt : null, receiptUrl: i.status === "PAID" ? i.receiptUrl : null, invoiceUrl: i.invoiceUrl })),
          outstandingCents: a.outstandingCents ?? 0, overdueCents: a.overdueCents ?? 0, overdueCount: a.overdueCount ?? 0,
          alsoCovers: others.filter((m) => visible.has(m.clientId)).map((m) => nameOf(m.client)),
          otherAccounts: others.filter((m) => !visible.has(m.clientId)).length,
        }
      : null,
  };
}
