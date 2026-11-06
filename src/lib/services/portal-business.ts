import "server-only";
import type { PortalAccess } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { audit } from "@/lib/audit";
import { ForbiddenError } from "@/lib/auth/actor";
import { hasBookkeepingService, requireClientAccess } from "@/lib/portal/access";
import type { PortalActor } from "@/lib/portal/session";
import { currentPlaidMode, envOfMode } from "@/lib/plaid";
import { isStateCode } from "@/lib/resources/catalog";
import { businessRequestChecklist, syncBusinessTaxRequests, yearEndWindow, type RequestKind } from "./business-tax-requests";
import { ValidationError } from "./clients";
import { bankFeed, CLIENT_REFRESH_MINUTES } from "./bank-feed";
import { syncConnection } from "./banking";
import { deadlineStatus, nextPayDate, YEAR_END_STAGES, type Deadline, type YearEndStage } from "./business-overview";
import { PAYROLL_FREQUENCIES } from "./bookkeeping-clients";
import { computeBooksProgress, engagementPeriod } from "./books-progress";
import { clientFacingRequestWhere } from "./client-request-scope";
import { clientReceivableWhere, REPORT_LABELS } from "./documents";
import { profitAndLossFor } from "./ledger";
import { publishedBillingFor } from "./owner-billing";
import { paymentStatus, scheduleText, squareBillingFor, todayCentral } from "./square-billing";

/**
 * The client portal's Business dashboard for a business with a business view: an owner-approved
 * Managed Business, or a client on the Bookkeeping Client list (see hasBusinessView in
 * src/lib/portal/access.ts). Only what the client may see: released statements, status steps
 * (never staff notes), client-visible deadlines, their own invoices and their own bank feed.
 * Every portal entry point checks requireClientAccess(…, "bookkeeping"), which applies that rule.
 */

/**
 * Which Home a signed-in person sees for the account in view. `access` is an effective grant
 * (accessibleClients / requireClientAccess), whose canViewBookkeeping is hasBusinessView — the
 * same rule the bookkeeping gate uses, so the Home and the gate always agree.
 */
export function homeKind(access: Pick<PortalAccess, "canViewBookkeeping">): "BUSINESS" | "PERSONAL" {
  return access.canViewBookkeeping ? "BUSINESS" : "PERSONAL";
}

// --- Live bank feed (JSON route) ---------------------------------------------------------------

/** Banking information reaches a client only when the office keeps their books (hasBookkeepingService). */
async function assertBankingVisible(clientId: string) {
  const c = await prisma.client.findUnique({ where: { id: clientId }, select: { bookkeepingProfile: { select: { active: true } } } });
  if (!c || !hasBookkeepingService(c)) throw new ForbiddenError("Bank balances are shown once our office keeps your books.");
}

export async function portalBankFeed(user: PortalActor, clientId: string) {
  await requireClientAccess(user.id, clientId, "bookkeeping");
  await assertBankingVisible(clientId);
  return bankFeed(clientId);
}

export class RateLimitedError extends Error {
  constructor(public retryAt: Date) {
    super(`You can refresh again at ${retryAt.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: "America/Chicago" })}.`);
    this.name = "RateLimitedError";
  }
}

/**
 * "Refresh now": asks the bank (through Plaid, read-only) for this business's newest balances and
 * transactions. Once per 5 minutes per business, only while bank retrieval is turned on.
 */
export async function portalRefreshBank(user: PortalActor, clientId: string, now = new Date()) {
  await requireClientAccess(user.id, clientId, "bookkeeping");
  await assertBankingVisible(clientId);
  // Honors Tabitha's "Live bank connections" switch: production keys alone never reach a bank.
  const environment = envOfMode(await currentPlaidMode());
  if (!environment) throw new ValidationError("Refreshing from your bank isn't turned on yet. Balances update automatically as your bank reports them.");
  // Only connections made in the active environment (a sandbox connection is never retrieved with live keys).
  const conns = await prisma.bankConnection.findMany({ where: { clientId, environment, status: { in: ["ACTIVE", "ERROR"] } }, select: { id: true, lastClientRefreshAt: true } });
  if (!conns.length) throw new ValidationError("Our office is setting up your bank feed — balances will appear here automatically.");
  const since = new Date(now.getTime() - CLIENT_REFRESH_MINUTES * 60_000);
  // Claimed atomically, so two clicks (or two tabs) can't both reach the bank.
  const claimed = await prisma.bankConnection.updateMany({
    where: { id: { in: conns.map((c) => c.id) }, OR: [{ lastClientRefreshAt: null }, { lastClientRefreshAt: { lt: since } }] },
    data: { lastClientRefreshAt: now },
  });
  if (!claimed.count) {
    const last = Math.max(...conns.map((c) => c.lastClientRefreshAt?.getTime() ?? 0));
    throw new RateLimitedError(new Date(last + CLIENT_REFRESH_MINUTES * 60_000));
  }
  const mine = await prisma.bankConnection.findMany({ where: { id: { in: conns.map((c) => c.id) }, lastClientRefreshAt: now }, select: { id: true } });
  let failed = 0;
  for (const c of mine) {
    try {
      await syncConnection(c.id, "CLIENT");
    } catch {
      failed++;
    }
  }
  await audit(prisma, { actorId: null, action: "banking.client_refresh", entityType: "Client", entityId: clientId, clientId, details: { portalUserId: user.id, connections: mine.length, failed } });
  return { feed: await bankFeed(clientId, { now }), failed };
}

// --- What we need from you -----------------------------------------------------------------------

/** The year the bookkeeping requests are for: the calendar year in progress. */
export function checklistTaxYear(today = todayCentral()) {
  return Number(today.slice(0, 4));
}

/** This business's requests of one kind for a year, made from its own facts, with the client-facing status of each. */
export async function businessChecklist(clientId: string, taxYear: number, kind: RequestKind = "BOOKKEEPING") {
  await syncBusinessTaxRequests(clientId, taxYear, kind);
  return businessRequestChecklist(clientId, taxYear, kind);
}

/** Year-End Tax Documents: active from January for the prior tax year; before then, nothing is asked. */
export async function yearEndChecklist(clientId: string, today = todayCentral()) {
  const w = yearEndWindow(today);
  if (!w.active) return { taxYear: w.taxYear, active: false as const, startsIn: w.startsIn ?? null, items: [] as Awaited<ReturnType<typeof businessChecklist>> };
  return { taxYear: w.taxYear, active: true as const, startsIn: null, items: await businessChecklist(clientId, w.taxYear, "YEAR_END") };
}

// --- Books status: reconciliation and what's outstanding ------------------------------------------

export async function booksStatus(clientId: string) {
  const [accounts, recs, openRequests, questions, toCategorize] = await Promise.all([
    prisma.ledgerAccount.findMany({ where: { clientId, active: true, subtype: { in: ["BANK", "CREDIT_CARD"] } }, orderBy: { code: "asc" }, select: { id: true, name: true, last4: true } }),
    prisma.bankReconciliation.groupBy({ by: ["accountId"], where: { clientId }, _max: { statementDate: true } }),
    prisma.documentRequest.count({ where: { clientId, status: "OPEN", AND: [clientFacingRequestWhere(true)] } }),
    prisma.conversation.findMany({ where: { clientId, questionStatus: "OPEN" }, orderBy: { createdAt: "asc" }, take: 5, select: { id: true, subject: true, responseDueAt: true } }),
    prisma.bankTransaction.count({ where: { clientId, status: "UNREVIEWED" } }),
  ]);
  return {
    reconciliation: accounts.map((a) => ({ name: `${a.name}${a.last4 ? ` ••${a.last4}` : ""}`, through: recs.find((r) => r.accountId === a.id)?._max.statementDate?.toISOString().slice(0, 10) ?? null })),
    openRequests,
    questions,
    toCategorize,
  };
}

// --- The dashboard -------------------------------------------------------------------------------

const ym = (y: number, m: number) => `${y}-${String(m).padStart(2, "0")}`;
const lastDay = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();
const shiftMonth = (s: string, n: number) => {
  const [y, m] = s.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1 + n, 1));
  return ym(d.getUTCFullYear(), d.getUTCMonth() + 1);
};
const ymd = (d: Date) => d.toISOString().slice(0, 10);
const days = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);

/** Statements Tabitha approved and the office delivered: published, scanned clean, current version. */
const releasedWhere = (clientId: string) => ({
  clientId, category: "BOOKKEEPING" as const, deletedAt: null, supersededAt: null, reportType: { not: null }, reviewStatus: "APPROVED", visibility: "PUBLISHED" as const, scanStatus: "CLEAN" as const, periodId: { not: null }, AND: [clientReceivableWhere],
});

/** What the viewer may do from the dashboard (a portal login's grant, or owner-level in View as Client). */
export type BusinessDashboardPerms = { canUpload: boolean; canMessage: boolean; canViewBilling: boolean };

export async function portalBusinessDashboard(user: PortalActor, clientId: string, month?: string | null) {
  const access = await requireClientAccess(user.id, clientId, "bookkeeping");
  const viewer = await prisma.portalUser.findUnique({ where: { id: user.id }, select: { preferredState: true } });
  return businessDashboardFor(clientId, month, { canUpload: access.canUpload, canMessage: access.canMessage, canViewBilling: access.canViewBilling }, viewer?.preferredState ?? null);
}

/**
 * The dashboard's data for one business, without a portal login. Callers check access first:
 * portalBusinessDashboard for a portal user; the staff View as Client page for staff.
 * `preferredState` is the viewer's own state (for Business Resources) when the client has none.
 */
export async function businessDashboardFor(clientId: string, month: string | null | undefined, perms: BusinessDashboardPerms, preferredState: string | null) {
  const today = todayCentral();
  const client = await prisma.client.findUniqueOrThrow({ where: { id: clientId }, select: { id: true, displayName: true, businessName: true, state: true, status: true, bookkeepingProfile: true } });
  const profile = client.bookkeepingProfile;

  const [periods, released] = await Promise.all([
    prisma.bookkeepingPeriod.findMany({ where: { clientId }, select: { id: true, year: true, month: true }, orderBy: [{ year: "desc" }, { month: "desc" }] }),
    prisma.document.findMany({ where: releasedWhere(clientId), select: { id: true, reportType: true, reportPeriodType: true, title: true, publishedAt: true, period: { select: { id: true, year: true, month: true } } }, orderBy: { publishedAt: "desc" } }),
  ]);
  // A month counts as released once its monthly P&L (or full packet) is delivered.
  // Quarterly engagements (BookkeepingProfile.frequency = QUARTERLY) are shown by quarter: the
  // selection is the quarter's last month, and a released quarter covers its three months.
  const quarterly = profile?.frequency === "QUARTERLY";
  const qEnd = (s: string) => (quarterly ? engagementPeriod("QUARTERLY", s).end : s);
  const releasedMonths = [...new Set(released.flatMap((d) => {
    if (!d.period || (d.reportType !== "PROFIT_AND_LOSS" && d.reportType !== "FINANCIAL_PACKET")) return [];
    const type = d.reportPeriodType ?? "MONTH";
    const m = ym(d.period.year, d.period.month);
    if (type === "MONTH") return [m];
    return quarterly && type === "QUARTER" ? engagementPeriod("QUARTERLY", m).months : [];
  }))].sort().reverse();
  const valid = month && /^\d{4}-(0[1-9]|1[0-2])$/.test(month) ? month : null;
  // Default: the latest released period, else the latest month opened, else the last finished month (or quarter).
  const lastDone = quarterly ? shiftMonth(engagementPeriod("QUARTERLY", today.slice(0, 7)).months[0], -1) : shiftMonth(today.slice(0, 7), -1);
  const selected = qEnd(valid ?? releasedMonths[0] ?? (periods[0] ? ym(periods[0].year, periods[0].month) : lastDone));
  const [sy, sm] = selected.split("-").map(Number);
  const monthChoices = [...new Set([selected, ...releasedMonths, ...periods.slice(0, 18).map((p) => ym(p.year, p.month))].map(qEnd))].sort().reverse();
  const choiceLabels = Object.fromEntries(monthChoices.map((c) => [c, engagementPeriod(profile?.frequency, c).label]));
  const isReleased = releasedMonths.includes(selected);

  // Figures: released months only, from the books (which are closed once Tabitha approves).
  type Perf = { month: string; income: number; expenses: number };
  type Change = { income: number | null; expenses: number | null; net: number | null };
  // Year to date: the released months of the selected year through the selected month. The change
  // is against the same months a year earlier, only when every one of those months was released too.
  type Ytd = { year: number; months: number; income: number; expenses: number; net: number; change: Change };
  let figures: null | { income: number; expenses: number; net: number; change: Change; perf: Perf[]; ytd: Ytd } = null;
  const book = await prisma.ledgerBook.findUnique({ where: { clientId }, select: { clientId: true } });
  if (book && isReleased) {
    // One read covers the chart (six months back) and year to date (from January a year earlier).
    const from = [`${sy - 1}-01`, shiftMonth(selected, -5)].sort()[0];
    const pl = await profitAndLossFor(clientId, { from: `${from}-01`, to: `${selected}-${String(lastDay(sy, sm)).padStart(2, "0")}` });
    const all = pl.months
      .map((m, i) => ({ month: m, income: pl.totalIncome.months[i] + pl.totalOtherIncome.months[i], expenses: pl.totalCogs.months[i] + pl.totalExpenses.months[i] + pl.totalOtherExpense.months[i] }))
      .filter((p) => releasedMonths.includes(p.month));
    const perf = all.filter((p) => p.month >= shiftMonth(selected, -5));
    const cur = perf.find((p) => p.month === selected)!;
    const prev = perf.find((p) => p.month === shiftMonth(selected, -1));
    const pct = (now: number, before: number) => (before ? Math.round(((now - before) / Math.abs(before)) * 1000) / 10 : null);
    const sum = (ps: Perf[]) => ps.reduce((t, p) => ({ income: t.income + p.income, expenses: t.expenses + p.expenses }), { income: 0, expenses: 0 });
    const ytdRows = all.filter((p) => p.month >= `${sy}-01` && p.month <= selected);
    const lastYearRows = ytdRows.map((p) => all.find((x) => x.month === `${sy - 1}${p.month.slice(4)}`));
    const ytd = sum(ytdRows);
    const before = lastYearRows.every(Boolean) ? sum(lastYearRows as Perf[]) : null;
    figures = {
      income: cur.income,
      expenses: cur.expenses,
      net: cur.income - cur.expenses,
      change: prev ? { income: pct(cur.income, prev.income), expenses: pct(cur.expenses, prev.expenses), net: pct(cur.income - cur.expenses, prev.income - prev.expenses) } : { income: null, expenses: null, net: null },
      perf,
      ytd: {
        year: sy,
        months: ytdRows.length,
        income: ytd.income,
        expenses: ytd.expenses,
        net: ytd.income - ytd.expenses,
        change: before ? { income: pct(ytd.income, before.income), expenses: pct(ytd.expenses, before.expenses), net: pct(ytd.income - ytd.expenses, before.income - before.expenses) } : { income: null, expenses: null, net: null },
      },
    };
  }

  // The Monthly Bookkeeping Progress Tracker: only for a business we keep the books for (an active
  // bookkeeping profile). Without one, the dashboard shows only the services that apply.
  const bookkeeping = !!profile?.active;
  const progress = bookkeeping ? await computeBooksProgress(clientId, selected, { today }) : null;

  // Payroll, filings, licenses, year-end — client-visible facts only (no staff notes).
  const knownPay = profile?.payrollPayDate ? ymd(profile.payrollPayDate) : null;
  const payroll = profile?.payroll ? { provider: profile.payrollProvider, frequency: profile.payrollFrequency ? PAYROLL_FREQUENCIES[profile.payrollFrequency as keyof typeof PAYROLL_FREQUENCIES] : null, next: nextPayDate(knownPay, profile.payrollFrequency, today) } : null;
  const [clientDeadlines, licenses, yearEnd] = await Promise.all([
    prisma.clientDeadline.findMany({ where: { clientId, visibleToClient: true, dueAt: { gte: new Date(`${today}T00:00:00Z`) } }, orderBy: { dueAt: "asc" }, take: 20, select: { title: true, dueAt: true } }),
    prisma.businessLicense.findMany({ where: { clientId, archivedAt: null }, orderBy: [{ renewalDate: "asc" }, { name: "asc" }], select: { name: true, renewalDate: true } }),
    prisma.yearEndFiling.findFirst({ where: { clientId }, orderBy: { taxYear: "desc" }, select: { taxYear: true, stage: true } }),
  ]);
  const filings = clientDeadlines.map((d) => ({ title: d.title, date: ymd(d.dueAt) }));
  const lic = licenses.map((l) => ({ name: l.name, renewal: l.renewalDate ? ymd(l.renewalDate) : null, expired: !!l.renewalDate && ymd(l.renewalDate) < today }));
  const deadlines: Deadline[] = [];
  if (payroll?.next) deadlines.push({ date: payroll.next, title: `Payroll${payroll.provider ? ` – ${payroll.provider}` : ""} (Pay Date)`, status: deadlineStatus(payroll.next, today, true) });
  for (const d of filings) deadlines.push({ date: d.date, title: d.title, status: deadlineStatus(d.date, today) });
  for (const l of lic) if (l.renewal && !l.expired && days(today, l.renewal) <= 120) deadlines.push({ date: l.renewal, title: `${l.name} renewal`, status: deadlineStatus(l.renewal, today) });
  if (yearEnd && yearEnd.stage !== "FILED" && `${yearEnd.taxYear + 1}-01-31` >= today) deadlines.push({ date: `${yearEnd.taxYear + 1}-01-31`, title: "W-2 / 1099 Filing Deadline", status: deadlineStatus(`${yearEnd.taxYear + 1}-01-31`, today) });
  deadlines.sort((a, b) => a.date.localeCompare(b.date));

  // Their own invoicing (their customers).
  const monthStart = new Date(`${selected}-01T00:00:00Z`), monthEnd = new Date(`${selected}-${String(lastDay(sy, sm)).padStart(2, "0")}T00:00:00Z`);
  const [open, collected] = await Promise.all([
    prisma.clientInvoice.findMany({ where: { clientId, status: { in: ["OPEN", "PARTIALLY_PAID"] } }, select: { totalCents: true, paidCents: true } }),
    prisma.clientInvoicePayment.aggregate({ where: { clientId, receivedOn: { gte: monthStart, lte: monthEnd } }, _sum: { amountCents: true } }),
  ]);
  const invoicing = { openCents: open.reduce((t, i) => t + i.totalCents - i.paidCents, 0), openCount: open.length, collectedCents: collected._sum.amountCents ?? 0 };

  // Our invoices to this business (only what the owner published to the portal).
  // Plus the recurring service plan billed through Square, as the client's Billing page shows it
  // (title, amount, schedule, next due date and payment status for this account only).
  type Plan = { title: string | null; amountCents: number | null; schedule: string; nextDue: string | null; status: { label: string; tone: string }; autopay: boolean };
  let account: null | { openCount: number; balanceCents: number; nextDue: string | null; latest: { number: string; title: string | null; status: string } | null; plan: Plan | null } = null;
  if (perms.canViewBilling) {
    const [bills, square] = await Promise.all([publishedBillingFor(clientId), squareBillingFor(clientId)]);
    const outstanding = bills.filter((b) => b.state !== "OFFERED" && b.state !== "DECLINED" && b.state !== "VOID" && (b.balanceCents ?? 0) > 0);
    const dues = outstanding.map((b) => b.dueDate).filter((d): d is string => !!d).sort();
    const latest = bills[0];
    const a = square.arrangements.find((x) => x.syncedAt) ?? null;
    const plan: Plan | null = a ? { title: a.title, amountCents: a.amountCents, schedule: scheduleText(a), nextDue: a.nextDueDate ? ymd(a.nextDueDate) : null, status: paymentStatus(a), autopay: a.autopay } : null;
    account = { openCount: outstanding.length, balanceCents: outstanding.reduce((t, b) => t + (b.balanceCents ?? 0), 0), nextDue: dues[0] ?? null, latest: latest ? { number: latest.number, title: latest.title, status: latest.status } : null, plan };
  }

  // Latest released statements (newest month with any delivered report).
  const latestPeriod = released.find((d) => d.period)?.period ?? null;
  const statements = latestPeriod
    ? {
        periodId: latestPeriod.id,
        month: ym(latestPeriod.year, latestPeriod.month),
        types: [...new Set(released.filter((d) => d.period?.id === latestPeriod.id).map((d) => d.reportPeriodType ?? "MONTH"))],
        docs: released.filter((d) => d.period?.id === latestPeriod.id).map((d) => ({ id: d.id, label: REPORT_LABELS[d.reportType!], periodType: d.reportPeriodType ?? "MONTH" })),
      }
    : null;

  // Business resources: verified official links already in the Resource Center.
  const state = (client.state && isStateCode(client.state.toUpperCase()) ? client.state.toUpperCase() : null) ?? preferredState ?? "AL";
  const resourceRows = await prisma.resource.findMany({
    where: {
      hidden: false, status: "VERIFIED", url: { not: null }, county: null, city: null,
      OR: [
        { jurisdiction: state, category: { in: ["SALES_USE_TAX", "BUSINESS_LICENSE", "BUSINESS_REGISTRY", "BUSINESS_INCOME_TAX", "WITHHOLDING"] } },
        { jurisdiction: "US", category: "FEDERAL_TAX", OR: [{ title: { contains: "Business", mode: "insensitive" } }, { title: { contains: "EIN", mode: "insensitive" } }, { title: { contains: "EFTPS" } }] },
        { jurisdiction: "US", category: "FEDERAL_SBA", title: "SBA home" },
      ],
    },
    orderBy: [{ jurisdiction: "desc" }, { sortOrder: "asc" }, { title: "asc" }],
    take: 8,
    select: { id: true, title: true, purpose: true, agency: true, url: true, category: true },
  });

  const taxYear = checklistTaxYear(today);
  // The checklist first: it may create this year's requests, which "outstanding items" counts.
  const checklist = await businessChecklist(clientId, taxYear, "BOOKKEEPING");
  const yearEndDocs = await yearEndChecklist(clientId, today);
  const [books, feed] = await Promise.all([
    booksStatus(clientId),
    // Banking information only for a client on the Bookkeeping Clients list (never a Managed
    // Business alone, a paused profile or a sign-up service choice). View as Client uses this too.
    hasBookkeepingService(client) ? bankFeed(clientId) : Promise.resolve(null),
  ]);

  return {
    // Only the last four digits of the EIN ever leave the server.
    client: { id: client.id, name: client.businessName || client.displayName, active: client.status === "ACTIVE", einLast4: profile?.einLast4 ?? null },
    services: [...(bookkeeping ? ["Bookkeeping"] : []), ...(profile?.payroll ? ["Payroll"] : []), "Taxes", ...(lic.length ? ["Compliance"] : [])],
    basis: profile?.accountingBasis ?? null,
    selected,
    monthChoices,
    // "October 2026", or "Q4 2026" for a quarterly engagement: how the selector and headings name the period.
    periodLabel: engagementPeriod(profile?.frequency, selected).label,
    choiceLabels,
    isReleased,
    figures,
    hasBooks: !!book,
    progress,
    payroll,
    filings: { next: filings[0] ?? null, dueSoon: filings.filter((d) => days(today, d.date) <= 30).length },
    licenses: { count: lic.length, expired: lic.filter((l) => l.expired).length, next: lic.find((l) => l.renewal && !l.expired) ?? null },
    yearEnd: yearEnd ? { taxYear: yearEnd.taxYear, label: YEAR_END_STAGES[yearEnd.stage as YearEndStage]?.label ?? "In progress" } : null,
    deadlines: deadlines.slice(0, 6),
    invoicing,
    account,
    statements,
    resources: resourceRows,
    state,
    taxYear,
    checklist,
    yearEndDocs,
    books,
    feed,
    perms: { canUpload: perms.canUpload, canMessage: perms.canMessage, canViewBilling: perms.canViewBilling },
  };
}
