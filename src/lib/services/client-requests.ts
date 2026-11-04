import "server-only";
import type { DocumentRequest } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { audit } from "@/lib/audit";
import type { Actor } from "@/lib/auth/actor";
import { BK_UPLOAD_TYPES } from "@/lib/bk-uploads";
import { chicagoToday } from "@/lib/dates";
import { ValidationError } from "./clients";
import { isYmd, toDate, ymdOf } from "./ledger";
import { notifyClientUsers } from "./documents";
import { assertCanSendClientRequests } from "./bk-permissions";
import { registryLabel } from "./bank-accounts";

/**
 * Targeted document requests to a business: monthly statements Coetha could not retrieve,
 * historical records for onboarding, receipts and explanations, and — separately, from
 * January — the year-end tax documents. Each request names the exact document, account,
 * period and reason. An upload against a request is filed with those details automatically.
 *
 * Coetha's requests start as DRAFTS (the client never sees a draft). They go out only when
 * staff press Send, or automatically when Tabitha turned on "Coetha sends document requests
 * automatically". Sending uses the client's portal notification preferences (email / text
 * consent and blocks are respected by the notification service).
 */

export const REQUEST_KIND_LABEL: Record<string, string> = { GENERAL: "Request", MONTHLY: "Monthly", STATEMENT: "Statement", HISTORICAL: "Historical records", YEAR_END: "Year-end tax documents", SUPPORTING: "Supporting documents" };

/** What staff (and Coetha) can ask for in Historical Records & Statements. */
export const HISTORICAL_TYPES = {
  BANK_STATEMENT: "Bank statements",
  CARD_STATEMENT: "Credit card statements",
  PAYROLL_REPORT: "Payroll reports",
  RECEIPTS: "Missing receipts",
  PRIOR_FINANCIALS: "Prior financial statements",
  LOAN_AGREEMENT: "Loan or line-of-credit agreements",
  MERCHANT_STATEMENT: "Merchant processing statements",
  BK_OTHER: "Other records",
} as const;
const NEEDS_ACCOUNT = new Set(["BANK_STATEMENT", "CARD_STATEMENT", "LOAN_AGREEMENT"]);

/** Annual tax documents — never part of the monthly checklist. */
export const YEAR_END_FORMS = {
  W2_W3: "W-2s and W-3 (from the payroll provider)",
  NEC_1099: "1099-NEC forms issued to contractors (and contractor W-9s)",
  K_1099: "1099-K from card processors and marketplaces",
  MISC_1099: "1099-MISC received (rents, other income)",
  INT_1099: "1099-INT / 1099-DIV from banks and brokers",
  FORM_1098: "1098 mortgage interest statements",
  K1: "Schedule K-1s received from other entities",
  OTHER_TAX: "Other year-end tax documents",
} as const;
export type YearEndForm = keyof typeof YEAR_END_FORMS;

/**
 * Year-end tax document requests run in their own season: from January 1 through October 15
 * (the extended due date) for the tax year just ended. Outside it the section says when it opens.
 */
export function yearEndWindow(now = new Date()) {
  const [y, m, d] = chicagoToday(now).split("-").map(Number);
  const open = m < 10 || (m === 10 && d <= 15);
  return { open, taxYear: y - 1, opensOn: open ? null : `${y + 1}-01-01`, nextTaxYear: y };
}

const fmt = (d: Date) => d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
export const rangeText = (r: { periodStart: Date | null; periodEnd: Date | null }) => {
  if (!r.periodStart || !r.periodEnd) return null;
  const s = r.periodStart, e = r.periodEnd;
  const sameMonth = s.getUTCFullYear() === e.getUTCFullYear() && s.getUTCMonth() === e.getUTCMonth();
  if (sameMonth && s.getUTCDate() === 1) return s.toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
  return `${fmt(s)} – ${fmt(e)}`;
};

/** The person Coetha's drafts are recorded under (the request needs a staff author): Tabitha, else the assigned staff member, else an Admin. */
async function coethaAuthor(clientId: string) {
  const owner = await prisma.ownerAccess.findFirst({ where: { isPrimary: true, revokedAt: null }, select: { userId: true } });
  if (owner) return owner.userId;
  const c = await prisma.client.findUnique({ where: { id: clientId }, select: { assignedToId: true } });
  return c?.assignedToId ?? (await prisma.user.findFirst({ where: { role: "ADMIN", active: true }, select: { id: true } }))?.id ?? null;
}

export type RequestInput = {
  kind: "MONTHLY" | "STATEMENT" | "HISTORICAL" | "YEAR_END" | "SUPPORTING" | "GENERAL";
  title: string;
  reason?: string | null;
  instructions?: string | null;
  docType?: string | null;
  bookkeepingAccountId?: string | null;
  start?: string | null;
  end?: string | null;
  taxYear?: number | null;
  dueAt?: Date | null;
  periodId?: string | null;
  draftKey?: string | null;
};

/** True when what this request would ask for is already on file (never re-request what was received). */
export async function alreadyReceived(clientId: string, input: Pick<RequestInput, "docType" | "bookkeepingAccountId" | "start" | "end" | "taxYear" | "kind">) {
  if (input.kind === "YEAR_END") {
    return !!(await prisma.documentRequest.findFirst({ where: { clientId, kind: "YEAR_END", taxYear: input.taxYear ?? undefined, docType: input.docType ?? undefined, status: { in: ["SUBMITTED", "ACCEPTED"] } } }));
  }
  if (!input.docType || !input.start || !input.end) return false;
  const start = toDate(input.start), end = toDate(input.end);
  const doc = await prisma.document.findFirst({
    where: { clientId, deletedAt: null, docType: input.docType, ...(input.bookkeepingAccountId ? { bookkeepingAccountId: input.bookkeepingAccountId } : {}), periodStart: { lte: end }, periodEnd: { gte: start } },
    select: { id: true },
  });
  if (doc) return true;
  const answered = await prisma.documentRequest.findFirst({ where: { clientId, docType: input.docType, bookkeepingAccountId: input.bookkeepingAccountId ?? null, status: { in: ["SUBMITTED", "ACCEPTED"] }, periodStart: { lte: end }, periodEnd: { gte: start } } });
  return !!answered;
}

/**
 * Creates a request. Staff requests go out at once; Coetha's (actor null) are drafts unless
 * `send` says otherwise. A draftKey makes Coetha's drafting idempotent.
 */
export async function createClientRequest(actor: Actor | null, clientId: string, input: RequestInput, opts: { send?: boolean; source?: "STAFF" | "COETHA" } = {}) {
  if (actor) await assertCanSendClientRequests(actor, clientId);
  const title = input.title.trim().slice(0, 200);
  if (!title) throw new ValidationError("Say what you need.");
  if (input.docType && NEEDS_ACCOUNT.has(input.docType) && !input.bookkeepingAccountId) throw new ValidationError("Choose the account the statements are for.");
  if ((input.start && !isYmd(input.start)) || (input.end && !isYmd(input.end))) throw new ValidationError("Enter valid dates.");
  if (input.start && input.end && input.end < input.start) throw new ValidationError("The end date is before the start date.");
  if ((input.kind === "HISTORICAL" || input.kind === "STATEMENT") && (!input.start || !input.end)) throw new ValidationError("Enter the date range the records should cover.");
  if (input.bookkeepingAccountId && !(await prisma.bookkeepingAccount.count({ where: { id: input.bookkeepingAccountId, clientId } }))) throw new ValidationError("That account isn't registered for this business.");
  if (input.draftKey) {
    const existing = await prisma.documentRequest.findUnique({ where: { clientId_draftKey: { clientId, draftKey: input.draftKey } } });
    if (existing) return { request: existing, created: false };
  }
  if (await alreadyReceived(clientId, input)) return { request: null, created: false, received: true };
  const source = opts.source ?? (actor ? "STAFF" : "COETHA");
  const createdById = actor?.id ?? (await coethaAuthor(clientId));
  if (!createdById) throw new ValidationError("No staff account to record the request under.");
  const send = opts.send ?? !!actor;
  const req = await prisma.documentRequest.create({
    data: {
      clientId, title, reason: input.reason?.trim().slice(0, 500) || null, instructions: input.instructions?.trim().slice(0, 1000) || null,
      kind: input.kind, docType: input.docType ?? null, bookkeepingAccountId: input.bookkeepingAccountId ?? null,
      periodStart: input.start ? toDate(input.start) : null, periodEnd: input.end ? toDate(input.end) : null, taxYear: input.taxYear ?? null,
      dueAt: input.dueAt ?? null, periodId: input.periodId ?? null, category: "CLIENT_UPLOADS", source, draftKey: input.draftKey ?? null,
      status: send ? "OPEN" : "DRAFT", sentAt: send ? new Date() : null, sentById: send ? actor?.id ?? null : null, createdById,
    },
  });
  await audit(prisma, { actorId: actor?.id ?? null, action: source === "COETHA" ? "coetha.request_drafted" : "request.created", entityType: "DocumentRequest", entityId: req.id, clientId, details: { kind: req.kind, docType: req.docType, account: req.bookkeepingAccountId, start: input.start ?? null, end: input.end ?? null, sent: send } });
  if (send) await notifyClientUsers(clientId, "DOCUMENT_REQUEST", `request:${req.id}`);
  return { request: req, created: true };
}

/** One-click send of a draft (staff), or Coetha's automatic send when Tabitha allowed it (actor null). */
export async function sendClientRequest(actor: Actor | null, clientId: string, requestId: string) {
  if (actor) await assertCanSendClientRequests(actor, clientId);
  const r = await prisma.documentRequest.updateMany({ where: { id: requestId, clientId, status: "DRAFT" }, data: { status: "OPEN", sentAt: new Date(), sentById: actor?.id ?? null } });
  if (!r.count) throw new ValidationError("Only a draft request can be sent.");
  await audit(prisma, { actorId: actor?.id ?? null, action: actor ? "request.sent" : "coetha.request_auto_sent", entityType: "DocumentRequest", entityId: requestId, clientId });
  await notifyClientUsers(clientId, "DOCUMENT_REQUEST", `request:${requestId}`);
}

export async function discardDraftRequest(actor: Actor, clientId: string, requestId: string) {
  await assertCanSendClientRequests(actor, clientId);
  const r = await prisma.documentRequest.updateMany({ where: { id: requestId, clientId, status: "DRAFT" }, data: { status: "CANCELLED" } });
  if (!r.count) throw new ValidationError("Only a draft request can be discarded.");
  await audit(prisma, { actorId: actor.id, action: "request.draft_discarded", entityType: "DocumentRequest", entityId: requestId, clientId });
}

/** Historical Records & Statements: one request for one account (when it's a statement) and one date range. */
export async function requestHistoricalRecords(actor: Actor, clientId: string, input: { docType: string; bookkeepingAccountId?: string | null; start: string; end: string; dueAt?: Date | null; note?: string | null }) {
  if (!(input.docType in HISTORICAL_TYPES)) throw new ValidationError("Choose what you need.");
  const acct = input.bookkeepingAccountId ? await prisma.bookkeepingAccount.findFirst({ where: { id: input.bookkeepingAccountId, clientId } }) : null;
  const what = HISTORICAL_TYPES[input.docType as keyof typeof HISTORICAL_TYPES];
  const range = rangeText({ periodStart: isYmd(input.start) ? toDate(input.start) : null, periodEnd: isYmd(input.end) ? toDate(input.end) : null });
  return createClientRequest(actor, clientId, {
    kind: "HISTORICAL", docType: input.docType, bookkeepingAccountId: acct?.id ?? null, start: input.start, end: input.end, dueAt: input.dueAt ?? null,
    title: `${what}${acct ? ` — ${registryLabel(acct)}` : ""}${range ? ` — ${range}` : ""}`,
    reason: input.note?.trim() || "Needed to set up your books for the months before we started.",
  });
}

/** Year-end tax documents for one tax year (only in the year-end season). */
export async function requestYearEndDocuments(actor: Actor | null, clientId: string, forms: string[], opts: { now?: Date; send?: boolean } = {}) {
  const w = yearEndWindow(opts.now);
  if (!w.open) throw new ValidationError(`Year-end tax document requests for ${w.nextTaxYear} open on January 1, ${w.nextTaxYear + 1}.`);
  const out: DocumentRequest[] = [];
  for (const f of forms) {
    if (!(f in YEAR_END_FORMS)) throw new ValidationError("Choose the documents to request.");
    const r = await createClientRequest(actor, clientId, { kind: "YEAR_END", docType: f, taxYear: w.taxYear, title: `${w.taxYear} ${YEAR_END_FORMS[f as YearEndForm]}`, reason: `Needed for the ${w.taxYear} year-end tax filings.`, draftKey: `ye:${w.taxYear}:${f}` }, { send: opts.send });
    if (r.request) out.push(r.request);
  }
  return out;
}

/** Requests for the management screens (staff only). */
export async function requestsFor(clientId: string) {
  const rows = await prisma.documentRequest.findMany({ where: { clientId, status: { not: "CANCELLED" } }, orderBy: [{ status: "asc" }, { createdAt: "desc" }], take: 200, include: { bookkeepingAccount: true, _count: { select: { documents: true } } } });
  const open = rows.filter((r) => r.status === "DRAFT" || r.status === "OPEN" || r.status === "SUBMITTED");
  return {
    all: rows,
    drafts: rows.filter((r) => r.status === "DRAFT"),
    outstanding: open.filter((r) => r.kind !== "YEAR_END" && r.kind !== "HISTORICAL"),
    historical: rows.filter((r) => r.kind === "HISTORICAL"),
    yearEnd: rows.filter((r) => r.kind === "YEAR_END"),
  };
}

export const REQUEST_STATUS_LABEL: Record<string, string> = { DRAFT: "Draft — not sent", OPEN: "Waiting on client", SUBMITTED: "Received — Coetha reviewing", ACCEPTED: "Accepted", CANCELLED: "Cancelled" };
export const docTypeLabel = (t: string | null) => (t ? (BK_UPLOAD_TYPES as Record<string, string>)[t] ?? (YEAR_END_FORMS as Record<string, string>)[t] ?? t : null);
export { ymdOf };
