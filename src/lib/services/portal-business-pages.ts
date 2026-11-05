import "server-only";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { portalDocumentScope, requireClientAccess } from "@/lib/portal/access";
import type { PortalActor } from "@/lib/portal/session";
import { BK_UPLOAD_TYPES, type BkUploadType } from "@/lib/bk-uploads";
import { nextPayDate, YEAR_END_STAGES, type YearEndStage } from "./business-overview";
import { BUSINESS_TAX_RULES, checklistStatus, YEAR_END_KEYS, type ChecklistStatus } from "./business-tax-requests";
import { PAYROLL_FREQUENCIES } from "./bookkeeping-clients";
import { PAYROLL_ACCESS } from "./bookkeeping-profile";
import { clientReceivableWhere } from "./documents";
import { RUN_STATUS } from "@/lib/payroll/fields";
import { yearEndChecklist } from "./portal-business";
import { todayCentral } from "./square-billing";

/**
 * The client portal's business pages behind the dashboard cards: Payroll, Business Licenses and
 * 1099 / W-2. Each reads only what already exists for that one business and only what the client
 * may see (published, scanned-clean documents; client-facing statuses; never staff notes).
 *
 * Every portal entry point (`portal…Page`) checks requireClientAccess(…, "bookkeeping"), the same
 * business-view rule as the dashboard (hasBusinessView). The `…For(clientId, …)` readers take no
 * login: the caller has already checked access (the portal entry point, or staff View as Client).
 */

/** The document flags a viewer has (a portal login's effective grant, or owner-level in View as Client). */
export type DocViewer = { canViewBookkeeping: boolean; canViewTax: boolean; canViewContracts: boolean; canViewDocuments?: boolean; canViewPayroll?: boolean };

const ymd = (d: Date) => d.toISOString().slice(0, 10);
const days = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);

/** What any client-facing list may show: published, scanned clean, current version, released (clientReceivableWhere), and in this viewer's scope. */
function visibleDocs(clientId: string, viewer: DocViewer, portalUserId: string | null, extra: Prisma.DocumentWhereInput): Prisma.DocumentWhereInput {
  return { clientId, deletedAt: null, supersededAt: null, visibility: "PUBLISHED", scanStatus: "CLEAN", AND: [clientReceivableWhere, portalDocumentScope(viewer, portalUserId), extra] };
}

const DOC_SELECT = { id: true, title: true, year: true, month: true, docType: true, category: true, publishedAt: true, createdAt: true, file: { select: { originalName: true, mimeType: true } } } as const;
const docRow = (d: { id: string; title: string; year: number | null; month: number | null; docType: string | null; publishedAt: Date | null; createdAt: Date; file: { originalName: string; mimeType: string } }) => ({
  id: d.id,
  title: d.title,
  year: d.year,
  month: d.month,
  type: d.docType && d.docType in BK_UPLOAD_TYPES ? BK_UPLOAD_TYPES[d.docType as BkUploadType] : null,
  date: ymd(d.publishedAt ?? d.createdAt),
  spreadsheet: /csv|spreadsheet|excel/.test(d.file.mimeType),
});

// --- Payroll ---------------------------------------------------------------------------------------

/** Payroll documents: the PAYROLL category (941s, W-2/W-3, registers) and payroll reports filed elsewhere. */
export const PAYROLL_DOC_WHERE: Prisma.DocumentWhereInput = { OR: [{ category: "PAYROLL" }, { docType: { in: ["PAYROLL_REPORT", "FORM_W2_ISSUED"] } }] };

/** Run statuses a client sees in the pay history. Office drafts and discarded runs never show. */
const CLIENT_RUN_STATUSES = ["AWAITING_APPROVAL", "DENIED", "FULLY_APPROVED", "SUBMITTED", "PROCESSED"] as const;

/** The next few pay dates, from the same known pay date and frequency the dashboard card reads. */
export function upcomingPayDates(known: string | null, frequency: string | null, today: string, count = 4): string[] {
  const out: string[] = [];
  let from = today;
  for (let i = 0; i < count; i++) {
    const next = nextPayDate(known, frequency, from);
    if (!next || out.includes(next)) break;
    out.push(next);
    from = ymd(new Date(Date.parse(`${next}T00:00:00Z`) + 86400000));
  }
  return out;
}

export async function payrollPageFor(clientId: string, viewer: DocViewer, portalUserId: string | null, today = todayCentral()) {
  const client = await prisma.client.findUniqueOrThrow({ where: { id: clientId }, select: { id: true, displayName: true, businessName: true, bookkeepingProfile: { select: { payroll: true, payrollProvider: true, payrollFrequency: true, payrollPayDate: true, payrollAccessStatus: true } } } });
  const p = client.bookkeepingProfile;
  const known = p?.payrollPayDate ? ymd(p.payrollPayDate) : null;
  const profile = p?.payroll
    ? {
        provider: p.payrollProvider,
        frequency: p.payrollFrequency ? (PAYROLL_FREQUENCIES[p.payrollFrequency as keyof typeof PAYROLL_FREQUENCIES] ?? null) : null,
        next: nextPayDate(known, p.payrollFrequency, today),
        // The same "On Schedule" the dashboard card shows for a business with payroll set up.
        status: "On Schedule",
        reports: p.payrollAccessStatus && p.payrollAccessStatus !== "NOT_REQUESTED" ? (PAYROLL_ACCESS[p.payrollAccessStatus as keyof typeof PAYROLL_ACCESS] ?? null) : null,
      }
    : null;
  const canSeePayroll = viewer.canViewPayroll !== false;
  const [runs, docs] = canSeePayroll
    ? await Promise.all([
        prisma.payrollRun.findMany({ where: { clientId, status: { in: [...CLIENT_RUN_STATUSES] } }, orderBy: [{ checkDate: "desc" }, { createdAt: "desc" }], take: 24, select: { id: true, checkDate: true, status: true, provider: true } }),
        prisma.document.findMany({ where: visibleDocs(clientId, viewer, portalUserId, PAYROLL_DOC_WHERE), orderBy: [{ year: "desc" }, { month: "desc" }, { createdAt: "desc" }], take: 100, select: DOC_SELECT }),
      ])
    : [[], []];
  return {
    client: { id: client.id, name: client.businessName || client.displayName },
    profile,
    schedule: profile ? upcomingPayDates(known, p!.payrollFrequency, today) : [],
    canSeePayroll,
    history: runs.map((r) => ({ id: r.id, payDate: ymd(r.checkDate), status: RUN_STATUS[r.status as keyof typeof RUN_STATUS] ?? r.status, past: ymd(r.checkDate) <= today })),
    documents: docs.map(docRow),
  };
}

export async function portalPayrollPage(user: PortalActor, clientId: string) {
  const access = await requireClientAccess(user.id, clientId, "bookkeeping");
  return payrollPageFor(clientId, access, user.id);
}

// --- Business licenses -----------------------------------------------------------------------------

export type LicenseStatus = "CURRENT" | "RENEWS_SOON" | "EXPIRED" | "NO_DATE";
export const LICENSE_STATUS: Record<LicenseStatus, { label: string; tone: "green" | "gold" | "red" | "gray" }> = {
  CURRENT: { label: "Current", tone: "green" },
  RENEWS_SOON: { label: "Renewal due soon", tone: "gold" },
  EXPIRED: { label: "Expired", tone: "red" },
  NO_DATE: { label: "No renewal date on file", tone: "gray" },
};
/** Days before the renewal date a license shows "Renewal due soon". */
export const RENEWS_SOON_DAYS = 60;

export function licenseStatus(renewal: string | null, today: string): LicenseStatus {
  if (!renewal) return "NO_DATE";
  if (renewal < today) return "EXPIRED";
  return days(today, renewal) <= RENEWS_SOON_DAYS ? "RENEWS_SOON" : "CURRENT";
}

export async function licensesPageFor(clientId: string, viewer: DocViewer, portalUserId: string | null, today = todayCentral()) {
  const client = await prisma.client.findUniqueOrThrow({ where: { id: clientId }, select: { id: true, displayName: true, businessName: true } });
  // The office's own license list (staff Business Licenses page), never its notes.
  const [rows, docs] = await Promise.all([
    prisma.businessLicense.findMany({ where: { clientId, archivedAt: null }, orderBy: [{ renewalDate: "asc" }, { name: "asc" }], select: { id: true, name: true, jurisdiction: true, licenseNumber: true, renewalDate: true } }),
    prisma.document.findMany({ where: visibleDocs(clientId, viewer, portalUserId, { docType: "BUSINESS_LICENSE" }), orderBy: [{ year: "desc" }, { createdAt: "desc" }], take: 50, select: DOC_SELECT }),
  ]);
  const licenses = rows.map((l) => {
    const renewal = l.renewalDate ? ymd(l.renewalDate) : null;
    return { id: l.id, name: l.name, jurisdiction: l.jurisdiction, number: l.licenseNumber, renewal, status: licenseStatus(renewal, today) };
  });
  return {
    client: { id: client.id, name: client.businessName || client.displayName },
    licenses,
    expired: licenses.filter((l) => l.status === "EXPIRED").length,
    documents: docs.map(docRow),
  };
}

export async function portalLicensesPage(user: PortalActor, clientId: string) {
  const access = await requireClientAccess(user.id, clientId, "bookkeeping");
  return licensesPageFor(clientId, access, user.id);
}

// --- 1099 / W-2 (year-end) -------------------------------------------------------------------------

/** The year-end steps in order, as the client sees them (YEAR_END_STAGES). */
export const YEAR_END_STEPS = (Object.keys(YEAR_END_STAGES) as YearEndStage[]).filter((s) => s !== "NOT_STARTED");

export type YearEndItem = {
  id: string; key: string | null; title: string; why: string | null; dueAt: Date | null; fromOffice: boolean; periodId: string | null;
  docType: BkUploadType | null; period: "YEAR" | "MONTH" | "QUARTER" | null; taxYear: number | null; status: ChecklistStatus; files: number; months: number;
};

/**
 * Year-end W-2 / 1099 work for this business, by tax year: the office's stage (contractor review →
 * forms prepared → filed) and every year-end form requested, with what was received. Requests are
 * the same DocumentRequests the dashboard lists (rule-made and the office's own YEAR_END requests);
 * drafts and cancelled requests never show.
 */
export async function yearEndPageFor(clientId: string, today = todayCentral()) {
  const client = await prisma.client.findUniqueOrThrow({ where: { id: clientId }, select: { id: true, displayName: true, businessName: true } });
  // The same season check (and the same once-a-year request sync) the dashboard's section runs.
  const season = await yearEndChecklist(clientId, today);
  const [filings, requests] = await Promise.all([
    prisma.yearEndFiling.findMany({ where: { clientId }, orderBy: { taxYear: "desc" }, select: { taxYear: true, stage: true, updatedAt: true } }),
    prisma.documentRequest.findMany({
      where: { clientId, status: { notIn: ["CANCELLED", "DRAFT"] }, taxYear: { not: null }, OR: [{ ruleKey: { in: YEAR_END_KEYS } }, { kind: "YEAR_END" }] },
      orderBy: [{ createdAt: "asc" }],
      select: { id: true, title: true, instructions: true, reason: true, dueAt: true, status: true, ruleKey: true, docType: true, taxYear: true, periodId: true, documents: { where: { deletedAt: null }, select: { reviewedAt: true, needsReview: true, month: true } } },
    }),
  ]);
  const years = [...new Set([...filings.map((f) => f.taxYear), ...requests.map((r) => r.taxYear!)])].sort((a, b) => b - a);
  const order = (k: string | null) => (k ? BUSINESS_TAX_RULES.findIndex((r) => r.key === k) : 999);
  const byYear = years.map((taxYear) => {
    const f = filings.find((x) => x.taxYear === taxYear) ?? null;
    const stage = (f && f.stage in YEAR_END_STAGES ? f.stage : "NOT_STARTED") as YearEndStage;
    const items: YearEndItem[] = requests
      .filter((r) => r.taxYear === taxYear)
      .sort((a, b) => order(a.ruleKey) - order(b.ruleKey))
      .map((r) => {
        const rule = BUSINESS_TAX_RULES.find((x) => x.key === r.ruleKey) ?? null;
        return {
          id: r.id, key: r.ruleKey, title: r.title, why: r.instructions ?? r.reason, dueAt: r.dueAt, fromOffice: !rule, periodId: r.periodId,
          docType: r.docType && r.docType in BK_UPLOAD_TYPES ? (r.docType as BkUploadType) : null,
          period: rule?.period ?? null, taxYear: r.taxYear, status: checklistStatus(r), files: r.documents.length,
          months: new Set(r.documents.map((d) => d.month).filter((m): m is number => !!m)).size,
        };
      });
    const deadline = `${taxYear + 1}-01-31`;
    return {
      taxYear,
      stage,
      stageLabel: YEAR_END_STAGES[stage].label,
      // Contractor review progress: how far along the office's steps this year is (0 = not started).
      step: stage === "NOT_STARTED" ? 0 : YEAR_END_STEPS.indexOf(stage) + 1,
      updated: f ? ymd(f.updatedAt) : null,
      deadline: stage !== "FILED" && deadline >= today ? deadline : null,
      items,
      requested: items.length,
      received: items.filter((i) => i.status !== "NEEDED" && i.status !== "MORE_INFO").length,
      accepted: items.filter((i) => i.status === "ACCEPTED").length,
    };
  });
  return {
    client: { id: client.id, name: client.businessName || client.displayName },
    season: { taxYear: season.taxYear, active: season.active, startsIn: season.startsIn },
    years: byYear,
  };
}

export async function portalYearEndPage(user: PortalActor, clientId: string) {
  const access = await requireClientAccess(user.id, clientId, "bookkeeping");
  return { ...(await yearEndPageFor(clientId)), canUpload: access.canUpload };
}
