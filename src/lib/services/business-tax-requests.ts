import "server-only";
import { prisma } from "@/lib/prisma";
import { audit } from "@/lib/audit";
import { BK_UPLOAD_TYPES, type BkUploadType } from "@/lib/bk-uploads";
import { notRoutineStatementRequest } from "./client-request-scope";

/**
 * Business tax-document requests, made only from what we already know about this business:
 * payroll, entity type, its books, bank feed, licenses, deadlines, the year-end 1099 work and
 * last year's documents. Nothing is asked of everyone. Each request is an ordinary
 * DocumentRequest (one per rule per tax year), so the office sees, accepts or sends back
 * every item the same way as any request it writes by hand.
 */

export type Facts = {
  payroll: boolean;
  entityType: string | null;
  priorTypes: Set<string>;
  ledgerNames: string[];
  hasCard: boolean;
  hasSavings: boolean;
  licenses: number;
  salesTaxDeadline: boolean;
  yearEnd: boolean;
};

export type Rule = { key: string; docType: BkUploadType; title: string; why: string; period: "YEAR" | "MONTH" | "QUARTER"; applies: (f: Facts) => boolean };

/**
 * Two kinds of requests. BOOKKEEPING: what the books need through the year (statements,
 * receipts, payroll reports, sales tax returns, licenses), asked for the current year.
 * YEAR_END: annual tax forms (W-2, 1099s, 1098, K-1), asked only from January for the
 * prior tax year — never shown as monthly items or as missing every month.
 */
export type RequestKind = "BOOKKEEPING" | "YEAR_END";
export const YEAR_END_KEYS = ["W2_ISSUED", "NEC_ISSUED", "NEC_RECEIVED", "MISC", "INT", "MORTGAGE_1098", "K1"];
export const kindOfRule = (key: string): RequestKind => (YEAR_END_KEYS.includes(key) ? "YEAR_END" : "BOOKKEEPING");

/** Year-end requests open in January for the prior tax year and stay through the October extension deadline. */
export function yearEndWindow(today: string) {
  const [y, m] = today.split("-").map(Number);
  return m <= 10 ? { taxYear: y - 1, active: true } : { taxYear: y, active: false, startsIn: `January ${y + 1}` };
}

const named = (f: Facts, re: RegExp) => f.ledgerNames.some((n) => re.test(n));

export const BUSINESS_TAX_RULES: Rule[] = [
  // Bank and credit card statements are never asked of the client: our office retrieves them with the
  // access the client authorized and files them itself (see client-request-scope.ts). The retired
  // BANK_STATEMENTS / CARD_STATEMENTS requests stay as history and are hidden from the client.
  { key: "RECEIPTS", docType: "RECEIPTS", period: "MONTH", title: "Receipts and bills", why: "Support for business purchases and vendor bills.", applies: () => true },
  { key: "PAYROLL_REPORTS", docType: "PAYROLL_REPORT", period: "QUARTER", title: "Payroll reports (quarterly)", why: "Your business runs payroll.", applies: (f) => f.payroll },
  { key: "W2_ISSUED", docType: "FORM_W2_ISSUED", period: "YEAR", title: "W-2s issued to employees", why: "Your business runs payroll.", applies: (f) => f.payroll || f.priorTypes.has("FORM_W2_ISSUED") },
  { key: "NEC_ISSUED", docType: "FORM_1099_NEC_ISSUED", period: "YEAR", title: "1099-NEC — contractors you paid", why: "Your business pays contractors.", applies: (f) => f.yearEnd || f.priorTypes.has("FORM_1099_NEC_ISSUED") || f.ledgerNames.some((n) => /contract (labor|labour|work)|contractors?\b|subcontract/i.test(n) && !/payroll/i.test(n)) },
  { key: "NEC_RECEIVED", docType: "FORM_1099_NEC_RECEIVED", period: "YEAR", title: "1099-NEC — forms your business received", why: "You received 1099-NEC forms last year.", applies: (f) => f.priorTypes.has("FORM_1099_NEC_RECEIVED") },
  { key: "MISC", docType: "FORM_1099_MISC", period: "YEAR", title: "1099-MISC forms received", why: "Your business received 1099-MISC forms before, or has rent or royalty income.", applies: (f) => f.priorTypes.has("FORM_1099_MISC") || named(f, /rent(al)? income|royalt/i) },
  { key: "INT", docType: "FORM_1099_INT", period: "YEAR", title: "1099-INT — interest your business earned", why: "Your business has a savings or interest-earning account.", applies: (f) => f.hasSavings || f.priorTypes.has("FORM_1099_INT") || named(f, /interest income/i) },
  { key: "MORTGAGE_1098", docType: "FORM_1098_MORTGAGE", period: "YEAR", title: "1098 — mortgage interest", why: "Your business has a mortgage on file.", applies: (f) => f.priorTypes.has("FORM_1098_MORTGAGE") || named(f, /mortgage/i) },
  { key: "K1", docType: "FORM_K1", period: "YEAR", title: "Schedule K-1s your business received", why: "Your business received K-1s last year.", applies: (f) => f.priorTypes.has("FORM_K1") },
  { key: "SALES_TAX", docType: "SALES_TAX_RETURN", period: "MONTH", title: "Sales tax returns filed", why: "Your business collects sales tax.", applies: (f) => f.salesTaxDeadline || f.priorTypes.has("SALES_TAX_RETURN") || named(f, /sales tax/i) },
  { key: "LICENSES", docType: "BUSINESS_LICENSE", period: "YEAR", title: "Current business licenses", why: "We track your business license renewals.", applies: (f) => f.licenses > 0 },
];

export async function businessFacts(clientId: string, taxYear: number): Promise<Facts> {
  const [client, prior, ledger, bankAccts, licenses, deadlines, yearEnd] = await Promise.all([
    prisma.client.findUnique({ where: { id: clientId }, select: { entityType: true, bookkeepingProfile: { select: { payroll: true } } } }),
    prisma.document.findMany({ where: { clientId, deletedAt: null, year: taxYear - 1, docType: { not: null } }, select: { docType: true }, distinct: ["docType"] }),
    // Only accounts actually used count: the default chart has a card and a contract-labor account for everyone.
    prisma.ledgerAccount.findMany({ where: { clientId, active: true, OR: [{ lines: { some: {} } }, { bankTransactions: { some: {} } }] }, select: { name: true, subtype: true } }),
    prisma.bankConnectionAccount.findMany({ where: { connection: { clientId, status: { not: "DISCONNECTED" } } }, select: { type: true, subtype: true } }),
    prisma.businessLicense.count({ where: { clientId, archivedAt: null } }),
    prisma.clientDeadline.count({ where: { clientId, title: { contains: "sales tax", mode: "insensitive" } } }),
    prisma.yearEndFiling.count({ where: { clientId, taxYear } }),
  ]);
  return {
    payroll: !!client?.bookkeepingProfile?.payroll,
    entityType: client?.entityType ?? null,
    priorTypes: new Set(prior.map((d) => d.docType!)),
    ledgerNames: ledger.map((a) => a.name),
    hasCard: ledger.some((a) => a.subtype === "CREDIT_CARD") || bankAccts.some((a) => a.type === "credit"),
    hasSavings: bankAccts.some((a) => a.subtype === "savings"),
    licenses,
    salesTaxDeadline: deadlines > 0,
    yearEnd: yearEnd > 0,
  };
}

/** Who "asked": the firm owner (or an Admin). Requests are never created without a real person behind them. */
async function requester() {
  const owner = await prisma.ownerAccess.findFirst({ where: { isPrimary: true, revokedAt: null }, select: { userId: true } });
  return owner?.userId ?? (await prisma.user.findFirst({ where: { role: "ADMIN", active: true }, select: { id: true } }))?.id ?? null;
}

/**
 * Makes the requests that apply this tax year (once each) and withdraws an automatic request
 * that no longer applies, only while nothing was uploaded for it. Safe to run on every visit.
 */
export async function syncBusinessTaxRequests(clientId: string, taxYear: number, kind: RequestKind) {
  const facts = await businessFacts(clientId, taxYear);
  const ofKind = BUSINESS_TAX_RULES.filter((r) => kindOfRule(r.key) === kind);
  const wanted = ofKind.filter((r) => r.applies(facts));
  const createdById = await requester();
  if (createdById) {
    const made = await prisma.documentRequest.createMany({
      data: wanted.map((r) => ({ clientId, taxYear, ruleKey: r.key, docType: r.docType, title: `${r.title} (${taxYear})`, instructions: r.why, category: "CLIENT_UPLOADS" as const, createdById })),
      skipDuplicates: true,
    });
    if (made.count) await audit(prisma, { actorId: null, action: "request.auto_created", entityType: "Client", entityId: clientId, clientId, details: { taxYear, count: made.count } });
  }
  // (A cancelled request stays cancelled: the office may have decided it doesn't apply.)
  const stale = await prisma.documentRequest.findMany({ where: { clientId, taxYear, ruleKey: { in: ofKind.filter((r) => !wanted.includes(r)).map((r) => r.key) }, status: "OPEN", documents: { none: {} } }, select: { id: true } });
  if (stale.length) await prisma.documentRequest.updateMany({ where: { id: { in: stale.map((s) => s.id) } }, data: { status: "CANCELLED" } });
  return { facts, rules: wanted };
}

// --- Statuses the client sees ---------------------------------------------------------------------

export const CHECKLIST_STATUS = {
  NEEDED: { label: "Needed", tone: "gold" },
  UPLOADED: { label: "Uploaded", tone: "navy" },
  UNDER_REVIEW: { label: "Under Review", tone: "navy" },
  ACCEPTED: { label: "Accepted", tone: "green" },
  MORE_INFO: { label: "Additional Information Required", tone: "red" },
} as const;
export type ChecklistStatus = keyof typeof CHECKLIST_STATUS;

/**
 * Mapped onto the existing request states: OPEN with nothing uploaded = Needed; OPEN after files
 * came in (staff chose "Need more") = Additional Information Required; SUBMITTED and not yet opened
 * by staff = Uploaded; SUBMITTED and opened by staff = Under Review; ACCEPTED = Accepted.
 */
export function checklistStatus(r: { status: string; documents: { reviewedAt: Date | null; needsReview: boolean }[] }): ChecklistStatus {
  if (r.status === "ACCEPTED") return "ACCEPTED";
  if (r.status === "OPEN") return r.documents.length ? "MORE_INFO" : "NEEDED";
  return r.documents.some((d) => d.reviewedAt || !d.needsReview) ? "UNDER_REVIEW" : "UPLOADED";
}

/**
 * The requests the client should see, by kind: BOOKKEEPING lists the year's bookkeeping requests
 * plus the office's own; YEAR_END lists only the annual tax forms for that tax year.
 */
export async function businessRequestChecklist(clientId: string, taxYear: number, kind: RequestKind) {
  const since = new Date(Date.now() - 60 * 86400000);
  const keys = BUSINESS_TAX_RULES.filter((r) => kindOfRule(r.key) === kind).map((r) => r.key);
  const rows = await prisma.documentRequest.findMany({
    where: {
      clientId,
      // Never a cancelled request, and never a draft: Coetha's drafts (#82) wait for Tabitha and the client never sees them.
      status: { notIn: ["CANCELLED", "DRAFT"] },
      AND: [notRoutineStatementRequest],
      // One owner's own personal / identity requests never appear in the business's list.
      kind: { not: "OWNER_PERSONAL" },
      OR: [
        { taxYear, ruleKey: { in: keys } },
        ...(kind === "BOOKKEEPING" ? [{ ruleKey: null, OR: [{ status: { in: ["OPEN" as const, "SUBMITTED" as const] } }, { updatedAt: { gte: since } }] }] : []),
      ],
    },
    orderBy: [{ createdAt: "asc" }],
    select: { id: true, title: true, instructions: true, dueAt: true, status: true, ruleKey: true, docType: true, taxYear: true, periodId: true, documents: { where: { deletedAt: null }, select: { reviewedAt: true, needsReview: true, month: true, createdAt: true } } },
  });
  const order = (k: string | null) => (k ? BUSINESS_TAX_RULES.findIndex((r) => r.key === k) : -1);
  return rows
    .sort((a, b) => order(a.ruleKey) - order(b.ruleKey))
    .map((r) => {
      const rule = BUSINESS_TAX_RULES.find((x) => x.key === r.ruleKey) ?? null;
      return {
        id: r.id,
        key: r.ruleKey,
        title: r.title,
        why: r.instructions,
        dueAt: r.dueAt,
        fromOffice: !rule,
        periodId: r.periodId,
        docType: r.docType && r.docType in BK_UPLOAD_TYPES ? (r.docType as BkUploadType) : null,
        period: rule?.period ?? null,
        taxYear: r.taxYear,
        status: checklistStatus(r),
        files: r.documents.length,
        months: new Set(r.documents.map((d) => d.month).filter((m): m is number => !!m)).size,
      };
    });
}
