import "server-only";
import type { DocumentRequest } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { audit } from "@/lib/audit";
import { ForbiddenError, type Actor } from "@/lib/auth/actor";
import { canApproveCoethaWork } from "@/lib/auth/permissions";
import { BK_UPLOAD_TYPES } from "@/lib/bk-uploads";
import { chicagoToday } from "@/lib/dates";
import { ValidationError } from "./clients";
import { isYmd, todayCentral, toDate, ymdOf } from "./ledger";
import { notifyClientUsers, staffUploadDocument } from "./documents";
import { assertCanSendClientRequests } from "./bk-permissions";
import { registryLabel } from "./bank-accounts";
import { assertCoethaAllowed } from "./coetha-opt-out";

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

// --- Routing: which of Coetha's requests may go out on their own -----------------------------

/** Deposits Coetha asks about: up to this total the request is routine; above it, Tabitha reviews first. */
export const DEPOSIT_REVIEW_THRESHOLD_CENTS = 250_000;
/** Below this confidence Coetha never sends anything on her own. */
export const MIN_AUTO_CONFIDENCE = 0.7;
/** Personal or tax-sensitive wording in the request or the transactions behind it. */
export const SENSITIVE = /\b(ssn|social security|tax return|irs|1040|personal|medical|health|divorce|alimony|child support|gift|inheritance|related[- ]party|owner|shareholder|partner|officer|family|loan (from|to) (the )?(owner|shareholder|officer|member)|bankruptcy|lawsuit|legal|garnish\w*|levy|lien)\b/i;

export type RoutingInput = {
  kind: string;
  docType?: string | null;
  bookkeepingAccountId?: string | null;
  /** The registered account's type, when the request is for one. */
  accountType?: string | null;
  /** DEPOSITS / TRANSFERS for "explain these" requests. */
  topic?: "DEPOSITS" | "TRANSFERS" | null;
  /** Total amount the request is about (deposits). */
  amountCents?: number | null;
  /** Coetha's confidence that the request is right (0–1); omitted = certain (data-driven). */
  confidence?: number | null;
  /** Client data behind the request (transaction descriptions) and any staff wording. */
  evidence?: string | null;
};
export type Routing = { routing: "ROUTINE" | "REVIEW"; reason: string };

/**
 * Tabitha's rule (PR #82 review): ROUTINE requests — a missing bank or card statement for a
 * registered account, receipts, payroll records, merchant statements, prior financial statements,
 * small deposit explanations, loan documents for a known loan account — may go out automatically.
 * Everything UNUSUAL, SENSITIVE or UNCLEAR waits for her: low confidence, personal or
 * tax-sensitive wording, owner / related-party items, transfers to unknown accounts, deposits
 * above the threshold, loan documents not tied to a known loan account, statements without an
 * account, year-end tax documents, and anything not on the routine list.
 */
export function classifyRequest(r: RoutingInput): Routing {
  const review = (reason: string): Routing => ({ routing: "REVIEW", reason });
  const routine = (reason: string): Routing => ({ routing: "ROUTINE", reason });
  if (r.confidence != null && r.confidence < MIN_AUTO_CONFIDENCE) return review("Coetha isn't confident this request is right.");
  if (r.evidence && SENSITIVE.test(r.evidence)) return review("Involves personal, owner / related-party or tax-sensitive matters.");
  if (r.kind === "YEAR_END") return review("Annual tax documents are reviewed by Tabitha.");
  switch (r.docType) {
    case "BANK_STATEMENT":
    case "CARD_STATEMENT":
      return r.bookkeepingAccountId ? routine("Statement for a registered account and period.") : review("Statement request without a specific account.");
    case "PAYROLL_REPORT":
      return routine("Payroll records for the period.");
    case "RECEIPTS":
      return routine("Receipts for specific purchases.");
    case "MERCHANT_STATEMENT":
      return routine("Merchant processing statement for the period.");
    case "PRIOR_FINANCIALS":
      return routine("Prior financial statements for onboarding.");
    case "LOAN_AGREEMENT":
      return r.bookkeepingAccountId && (r.accountType === "LOAN" || r.accountType === "LINE_OF_CREDIT") ? routine("Loan documents for a registered loan account.") : review("Loan documents not tied to a known loan account.");
    case "BK_OTHER":
      if (r.topic === "DEPOSITS") return (r.amountCents ?? Infinity) <= DEPOSIT_REVIEW_THRESHOLD_CENTS ? routine("Explanation of small deposits.") : review("Unexplained deposits above the review threshold.");
      if (r.topic === "TRANSFERS") return review("Transfers to an account we don't know — may be owner or related-party.");
      return review("Not a routine request.");
    default:
      return review("Not a routine request.");
  }
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
  /** Coetha's routing signals (see classifyRequest). */
  routingHints?: Omit<RoutingInput, "kind" | "docType" | "bookkeepingAccountId" | "accountType">;
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
  const acct = input.bookkeepingAccountId ? await prisma.bookkeepingAccount.findFirst({ where: { id: input.bookkeepingAccountId, clientId }, select: { accountType: true } }) : null;
  if (input.bookkeepingAccountId && !acct) throw new ValidationError("That account isn't registered for this business.");
  if (input.draftKey) {
    const existing = await prisma.documentRequest.findUnique({ where: { clientId_draftKey: { clientId, draftKey: input.draftKey } } });
    if (existing) return { request: existing, created: false };
  }
  if (await alreadyReceived(clientId, input)) return { request: null, created: false, received: true };
  const source = opts.source ?? (actor ? "STAFF" : "COETHA");
  // Coetha never drafts a request for a client who prefers no Coetha (staff requests are unaffected).
  if (source === "COETHA") await assertCoethaAllowed(clientId);
  const createdById = actor?.id ?? (await coethaAuthor(clientId));
  if (!createdById) throw new ValidationError("No staff account to record the request under.");
  // Coetha's requests carry an explicit routing; staff requests are the staff member's own decision.
  const routing = source === "COETHA" ? classifyRequest({ kind: input.kind, docType: input.docType, bookkeepingAccountId: input.bookkeepingAccountId, accountType: acct?.accountType ?? null, ...input.routingHints, evidence: [input.routingHints?.evidence, input.instructions].filter(Boolean).join(" ") || null }) : null;
  const send = (opts.send ?? !!actor) && routing?.routing !== "REVIEW";
  const req = await prisma.documentRequest.create({
    data: {
      clientId, title, reason: input.reason?.trim().slice(0, 500) || null, instructions: input.instructions?.trim().slice(0, 1000) || null,
      kind: input.kind, docType: input.docType ?? null, bookkeepingAccountId: input.bookkeepingAccountId ?? null,
      periodStart: input.start ? toDate(input.start) : null, periodEnd: input.end ? toDate(input.end) : null, taxYear: input.taxYear ?? null,
      dueAt: input.dueAt ?? null, periodId: input.periodId ?? null, category: "CLIENT_UPLOADS", source, draftKey: input.draftKey ?? null,
      status: send ? "OPEN" : "DRAFT", sentAt: send ? new Date() : null, sentById: send ? actor?.id ?? null : null, createdById,
      routing: routing?.routing ?? null, routingReason: routing?.reason ?? null,
    },
  });
  await audit(prisma, { actorId: actor?.id ?? null, action: source === "COETHA" ? "coetha.request_drafted" : "request.created", entityType: "DocumentRequest", entityId: req.id, clientId, details: { kind: req.kind, docType: req.docType, account: req.bookkeepingAccountId, start: input.start ?? null, end: input.end ?? null, sent: send, routing: routing?.routing ?? null, routingReason: routing?.reason ?? null } });
  if (send) await notifyClientUsers(clientId, "DOCUMENT_REQUEST", `request:${req.id}`);
  return { request: req, created: true };
}

/** One-click send of a draft (staff), or Coetha's automatic send when Tabitha allowed it (actor null). */
export async function sendClientRequest(actor: Actor | null, clientId: string, requestId: string, opts: { today?: string } = {}) {
  if (actor) await assertCanSendClientRequests(actor, clientId);
  const draft = await prisma.documentRequest.findFirst({ where: { id: requestId, clientId, status: "DRAFT" } });
  if (!draft) throw new ValidationError("Only a draft request can be sent.");
  // Unusual, sensitive or unclear requests: only Tabitha sends them, never Coetha on her own.
  if (draft.routing === "REVIEW" && !(actor && (await canApproveCoethaWork(actor)))) throw new ForbiddenError("Tabitha reviews this request before it goes to the client.");
  if (!actor) {
    // Coetha never sends anything on her own for a client who prefers no Coetha.
    await assertCoethaAllowed(clientId);
    // Coetha never sends what was already received or what isn't due yet.
    if (draft.periodEnd && ymdOf(draft.periodEnd) >= (opts.today ?? todayCentral())) throw new ValidationError("That period hasn't ended yet.");
    if (await alreadyReceived(clientId, { kind: draft.kind as RequestInput["kind"], docType: draft.docType, bookkeepingAccountId: draft.bookkeepingAccountId, start: draft.periodStart ? ymdOf(draft.periodStart) : null, end: draft.periodEnd ? ymdOf(draft.periodEnd) : null, taxYear: draft.taxYear })) throw new ValidationError("Already received.");
  }
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

export const REQUEST_STATUS_LABEL: Record<string, string> = { REVIEW: "Waiting for Tabitha's review", DRAFT: "Draft — not sent", OPEN: "Waiting on client", SUBMITTED: "Received — Coetha reviewing", ACCEPTED: "Accepted", CANCELLED: "Cancelled" };
export const docTypeLabel = (t: string | null) => (t ? (BK_UPLOAD_TYPES as Record<string, string>)[t] ?? (YEAR_END_FORMS as Record<string, string>)[t] ?? t : null);

// --- Staff uploads Coetha asked for (new clients without a feed) --------------------------------

const monthRange = (ym: string) => {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(ym)) throw new ValidationError("Choose the statement month.");
  const [y, m] = ym.split("-").map(Number);
  return { y, m, start: `${ym}-01`, end: ymdOf(new Date(Date.UTC(y, m, 0))) };
};

/**
 * Staff attach a file to one of Coetha's requests (e.g. the client emailed the statement): it is
 * filed with the request's account, document type and period, staff-only, and the request is marked
 * received so Coetha resumes her review.
 */
export async function staffUploadForRequest(actor: Actor, clientId: string, requestId: string, file: { bytes: Uint8Array; originalName: string }) {
  await assertCanSendClientRequests(actor, clientId);
  const req = await prisma.documentRequest.findFirst({ where: { id: requestId, clientId, status: { in: ["DRAFT", "OPEN"] } } });
  if (!req) throw new ValidationError("That request is closed.");
  const doc = await staffUploadDocument(actor, {
    clientId, category: "BOOKKEEPING", visibility: "STAFF_ONLY", title: req.title, docType: req.docType ?? "BK_OTHER", bytes: file.bytes, originalName: file.originalName,
    year: req.periodEnd?.getUTCFullYear() ?? null, month: req.periodStart && req.periodEnd && req.periodStart.getUTCMonth() === req.periodEnd.getUTCMonth() ? req.periodEnd.getUTCMonth() + 1 : null,
    coverage: req.periodStart && req.periodEnd ? { kind: "RANGE", year: req.periodEnd.getUTCFullYear(), month: null, start: req.periodStart, end: req.periodEnd } : null,
  });
  await prisma.document.update({ where: { id: doc.id }, data: { requestId: req.id, bookkeepingAccountId: req.bookkeepingAccountId } });
  await prisma.documentRequest.update({ where: { id: req.id }, data: { status: "SUBMITTED" } });
  await audit(prisma, { actorId: actor.id, action: "request.staff_uploaded", entityType: "DocumentRequest", entityId: req.id, clientId, details: { documentId: doc.id } });
  return doc;
}

/** Onboarding without a bank feed: a statement for one registered account and month. */
export async function staffUploadStatement(actor: Actor, clientId: string, input: { accountId: string; month: string; bytes: Uint8Array; originalName: string }) {
  await assertCanSendClientRequests(actor, clientId);
  const acct = await prisma.bookkeepingAccount.findFirst({ where: { id: input.accountId, clientId, active: true } });
  if (!acct) throw new ValidationError("Choose one of this business's registered accounts.");
  const r = monthRange(input.month);
  const isBank = acct.accountType === "CHECKING" || acct.accountType === "SAVINGS";
  const doc = await staffUploadDocument(actor, {
    clientId, category: "BOOKKEEPING", visibility: "STAFF_ONLY", title: `${isBank ? "Bank" : "Card"} statement — ${registryLabel(acct)} — ${rangeText({ periodStart: toDate(r.start), periodEnd: toDate(r.end) })}`,
    docType: isBank ? "BANK_STATEMENT" : "CARD_STATEMENT", year: r.y, month: r.m, coverage: { kind: "MONTH", year: r.y, month: r.m, start: toDate(r.start), end: toDate(r.end) }, bytes: input.bytes, originalName: input.originalName,
  });
  await prisma.document.update({ where: { id: doc.id }, data: { bookkeepingAccountId: acct.id } });
  // Answers any open statement request for that account and month.
  await prisma.documentRequest.updateMany({ where: { clientId, bookkeepingAccountId: acct.id, status: { in: ["DRAFT", "OPEN"] }, periodStart: { lte: toDate(r.end) }, periodEnd: { gte: toDate(r.start) }, kind: "STATEMENT" }, data: { status: "SUBMITTED" } });
  await audit(prisma, { actorId: actor.id, action: "bookkeeping.statement_uploaded", entityType: "Document", entityId: doc.id, clientId, details: { account: registryLabel(acct), month: input.month } });
  return doc;
}
