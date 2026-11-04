import "server-only";
import { prisma } from "@/lib/prisma";
import type { Actor } from "@/lib/auth/actor";
import { audit } from "@/lib/audit";
import { ValidationError } from "./clients";
import { bookkeepingWorkspace, PAYROLL_FREQUENCIES } from "./bookkeeping-clients";
import { canUseLedger, profitAndLoss } from "./ledger";
import { canManageBilling } from "./bookkeeping-profile";
import { squareBillingFor, todayCentral } from "./square-billing";
import { manualBillingView } from "./manual-billing";

/**
 * The bookkeeping client's landing page ("Client Overview"). Every figure comes from records
 * already in Client Connect — the ledger, the month's close checklist, invoices, billing,
 * licenses and deadlines. Nothing is estimated: a card with no records says so.
 */

export const YEAR_END_STAGES = {
  NOT_STARTED: { label: "Not started", tone: "muted" },
  CONTRACTOR_REVIEW: { label: "Contractor Review in Progress", tone: "gold" },
  FORMS_PREPARED: { label: "Forms prepared", tone: "navy" },
  FILED: { label: "Filed", tone: "green" },
} as const;
export type YearEndStage = keyof typeof YEAR_END_STAGES;

const ymd = (d: Date) => d.toISOString().slice(0, 10);
const addDays = (s: string, n: number) => ymd(new Date(Date.parse(`${s}T00:00:00Z`) + n * 86400000));
const daysBetween = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);
const lastDay = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();
const monthStr = (y: number, m: number) => `${y}-${String(m).padStart(2, "0")}`;
const shiftMonth = (ym: string, n: number) => {
  const [y, m] = ym.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1 + n, 1));
  return monthStr(d.getUTCFullYear(), d.getUTCMonth() + 1);
};

/** The next pay date on or after `today`, from one known pay date and the payroll frequency. */
export function nextPayDate(known: string | null, frequency: string | null, today: string): string | null {
  if (!known || !frequency) return null;
  if (frequency === "WEEKLY" || frequency === "BIWEEKLY") {
    const step = frequency === "WEEKLY" ? 7 : 14;
    const diff = daysBetween(known, today);
    if (diff <= 0) return known;
    return addDays(known, Math.ceil(diff / step) * step);
  }
  const [ty, tm, td] = today.split("-").map(Number);
  if (frequency === "SEMIMONTHLY") {
    // The 15th and the last day of each month.
    if (td <= 15) return `${monthStr(ty, tm)}-15`;
    return `${monthStr(ty, tm)}-${lastDay(ty, tm)}`;
  }
  if (frequency === "MONTHLY") {
    const day = Number(known.slice(8, 10));
    const thisMonth = `${monthStr(ty, tm)}-${String(Math.min(day, lastDay(ty, tm))).padStart(2, "0")}`;
    if (thisMonth >= today) return thisMonth;
    const [ny, nm] = shiftMonth(monthStr(ty, tm), 1).split("-").map(Number);
    return `${monthStr(ny, nm)}-${String(Math.min(day, lastDay(ny, nm))).padStart(2, "0")}`;
  }
  return null;
}

export type CloseStep = { label: string; done: boolean };

export type Deadline = { date: string; title: string; status: "ON_TRACK" | "DUE_SOON" | "UPCOMING" | "PAST_DUE" };

const deadlineStatus = (date: string, today: string, onTrack = false): Deadline["status"] => {
  const d = daysBetween(today, date);
  if (d < 0) return "PAST_DUE";
  if (onTrack) return "ON_TRACK";
  return d <= 14 ? "DUE_SOON" : "UPCOMING";
};

export async function businessOverview(actor: Actor, clientId: string, month?: string | null) {
  const today = todayCentral();
  const client = await prisma.client.findUnique({
    where: { id: clientId },
    select: { id: true, displayName: true, businessName: true, businessAccess: true, status: true, bookkeepingProfile: true },
  });
  if (!client) throw new ValidationError("Client not found.");
  const profile = client.bookkeepingProfile;

  // The month shown: the one chosen, else the most recent month opened for this client, else last month.
  const periods = await prisma.bookkeepingPeriod.findMany({ where: { clientId }, select: { id: true, year: true, month: true }, orderBy: [{ year: "desc" }, { month: "desc" }] });
  const fallback = periods[0] ? monthStr(periods[0].year, periods[0].month) : shiftMonth(today.slice(0, 7), -1);
  const selected = month && /^\d{4}-(0[1-9]|1[0-2])$/.test(month) ? month : fallback;
  const [sy, sm] = selected.split("-").map(Number);
  const period = periods.find((p) => p.year === sy && p.month === sm) ?? null;
  const monthChoices = Array.from(new Set([selected, ...periods.slice(0, 18).map((p) => monthStr(p.year, p.month))])).sort().reverse();

  // --- Monthly close: the month's checklist and report approval ---------------------------------
  let close: { steps: CloseStep[]; percent: number } | null = null;
  if (period) {
    const ws = await bookkeepingWorkspace(clientId, period.id);
    const items = ws.summary?.items ?? [];
    const item = (key: string) => items.find((i) => i.key === key);
    const ok = (key: string) => {
      const i = item(key);
      return !!i && (i.state === "DONE" || i.state === "NOT_NEEDED" || i.state === "RECEIVED");
    };
    const reports = ws.summary?.reports ?? [];
    const steps: CloseStep[] = [
      { label: "Bank statements received", done: ok("BANK_STATEMENTS") },
      { label: "Transactions categorized", done: ok("CATEGORIZE") },
      { label: "Accounts reconciled", done: ok("RECONCILE") },
      ...(profile?.payroll ? [{ label: `Payroll recorded${profile.payrollProvider ? ` (${profile.payrollProvider})` : ""}`, done: ok("PAYROLL_ENTRIES") }] : []),
      { label: "Financial statements prepared", done: ok("PREPARE_REPORTS") || reports.length > 0 },
      { label: "Owner review & approval", done: reports.some((r) => r.reviewStatus === "APPROVED") },
      { label: "Released to client", done: ws.summary?.stage === "DELIVERED" },
    ];
    close = { steps, percent: Math.round((steps.filter((s) => s.done).length / steps.length) * 100) };
  }

  // --- Ledger figures: the month and the five before it -----------------------------------------
  type Perf = { month: string; income: number; expenses: number };
  let ledger: null | { income: number; expenses: number; net: number; change: { income: number | null; expenses: number | null; net: number | null }; bank: number; bankAccounts: number; perf: Perf[]; basis: string } = null;
  const book = await prisma.ledgerBook.findUnique({ where: { clientId } });
  if (book && (await canUseLedger(actor, clientId))) {
    const from = `${shiftMonth(selected, -5)}-01`;
    const to = `${selected}-${String(lastDay(sy, sm)).padStart(2, "0")}`;
    const pl = await profitAndLoss(actor, clientId, { from, to });
    const exp = (i: number) => pl.totalCogs.months[i] + pl.totalExpenses.months[i] + pl.totalOtherExpense.months[i];
    const inc = (i: number) => pl.totalIncome.months[i] + pl.totalOtherIncome.months[i];
    const perf = pl.months.map((m, i) => ({ month: m, income: inc(i), expenses: exp(i) }));
    const n = perf.length - 1;
    const pct = (now: number, before: number) => (before ? Math.round(((now - before) / Math.abs(before)) * 1000) / 10 : null);
    const banks = await prisma.ledgerAccount.findMany({ where: { clientId, subtype: "BANK", active: true }, select: { id: true } });
    const sums = banks.length
      ? await prisma.journalLine.groupBy({ by: ["accountId"], where: { accountId: { in: banks.map((b) => b.id) }, entry: { clientId, date: { lte: new Date(`${to}T00:00:00Z`) }, basis: { in: ["BOTH", book.basis === "CASH" ? "CASH_ONLY" : "ACCRUAL_ONLY"] } } }, _sum: { debitCents: true, creditCents: true } })
      : [];
    const bank = sums.reduce((t, s) => t + (s._sum.debitCents ?? 0) - (s._sum.creditCents ?? 0), 0);
    ledger = {
      income: perf[n].income,
      expenses: perf[n].expenses,
      net: perf[n].income - perf[n].expenses,
      change: n > 0 ? { income: pct(perf[n].income, perf[n - 1].income), expenses: pct(perf[n].expenses, perf[n - 1].expenses), net: pct(perf[n].income - perf[n].expenses, perf[n - 1].income - perf[n - 1].expenses) } : { income: null, expenses: null, net: null },
      bank,
      bankAccounts: banks.length,
      perf,
      basis: pl.basis,
    };
  }

  // --- Payroll ------------------------------------------------------------------------------
  // Imported / received pay runs come first; the known pay date on the profile is the fallback.
  const lastRun = profile?.payroll ? await prisma.payrollRun.findFirst({ where: { clientId, status: { not: "DISCARDED" } }, orderBy: { checkDate: "desc" } }) : null;
  const lastVersion = lastRun?.currentVersionId ? await prisma.payrollRunVersion.findUnique({ where: { id: lastRun.currentVersionId } }) : null;
  const knownPay = lastRun ? ymd(lastRun.checkDate) : profile?.payrollPayDate ? ymd(profile.payrollPayDate) : null;
  const payroll = profile?.payroll
    ? {
        provider: profile.payrollProvider,
        frequency: profile.payrollFrequency ? PAYROLL_FREQUENCIES[profile.payrollFrequency as keyof typeof PAYROLL_FREQUENCIES] : null,
        next: nextPayDate(knownPay, profile.payrollFrequency, today),
        last: lastRun && lastVersion ? { date: ymd(lastRun.checkDate), grossCents: lastVersion.grossCents, costCents: lastVersion.grossCents + lastVersion.employerTaxCents, status: lastRun.status } : null,
        awaitingApproval: await prisma.payrollRun.count({ where: { clientId, status: "AWAITING_APPROVAL" } }),
        denied: await prisma.payrollRun.count({ where: { clientId, status: "DENIED" } }),
      }
    : null;

  // --- Deadlines, licenses, year-end --------------------------------------------------------
  const [clientDeadlines, licenses, yearEnd] = await Promise.all([
    prisma.clientDeadline.findMany({ where: { clientId, dueAt: { gte: new Date(`${addDays(today, -30)}T00:00:00Z`) } }, orderBy: { dueAt: "asc" }, take: 20 }),
    prisma.businessLicense.findMany({ where: { clientId, archivedAt: null }, orderBy: [{ renewalDate: "asc" }, { name: "asc" }] }),
    prisma.yearEndFiling.findMany({ where: { clientId }, orderBy: { taxYear: "desc" }, take: 1 }),
  ]);
  const filings = clientDeadlines.map((d) => ({ title: d.title, date: ymd(d.dueAt) })).filter((d) => d.date >= today);
  const filingsDueSoon = filings.filter((d) => daysBetween(today, d.date) <= 30).length;
  const licenseRows = licenses.map((l) => ({ ...l, renewal: l.renewalDate ? ymd(l.renewalDate) : null, expired: !!l.renewalDate && ymd(l.renewalDate) < today }));
  const nextLicense = licenseRows.find((l) => l.renewal && !l.expired) ?? null;
  const ye = yearEnd[0] ?? null;

  const deadlines: Deadline[] = [];
  if (payroll?.next) deadlines.push({ date: payroll.next, title: `Payroll${payroll.provider ? ` – ${payroll.provider}` : ""} (Pay Date)`, status: deadlineStatus(payroll.next, today, true) });
  for (const d of filings) deadlines.push({ date: d.date, title: d.title, status: deadlineStatus(d.date, today) });
  for (const l of licenseRows) if (l.renewal && daysBetween(today, l.renewal) <= 120) deadlines.push({ date: l.renewal, title: `${l.name} renewal`, status: deadlineStatus(l.renewal, today) });
  if (ye && ye.stage !== "FILED") {
    const y = ye.taxYear;
    if (`${y}-12-31` >= today) deadlines.push({ date: `${y}-12-31`, title: "Contractor 1099 Review (Internal)", status: deadlineStatus(`${y}-12-31`, today) });
    deadlines.push({ date: `${y + 1}-01-31`, title: "W-2 / 1099 Filing Deadline", status: deadlineStatus(`${y + 1}-01-31`, today) });
  }
  deadlines.sort((a, b) => a.date.localeCompare(b.date));

  // --- The client's own invoicing (their customers) -----------------------------------------
  const [open, collected] = await Promise.all([
    prisma.clientInvoice.findMany({ where: { clientId, status: { in: ["OPEN", "PARTIALLY_PAID"] } }, select: { totalCents: true, paidCents: true } }),
    prisma.clientInvoicePayment.aggregate({ where: { clientId, receivedOn: { gte: new Date(`${selected}-01T00:00:00Z`), lte: new Date(`${selected}-${String(lastDay(sy, sm)).padStart(2, "0")}T00:00:00Z`) } }, _sum: { amountCents: true } }),
  ]);
  const invoicing = { openCents: open.reduce((t, i) => t + i.totalCents - i.paidCents, 0), openCount: open.length, collectedCents: collected._sum.amountCents ?? 0 };

  // --- Our billing to this client (only for Tabitha or staff she allows) ----------------------
  let account: null | { plan: string | null; amountCents: number | null; due: string | null; status: { label: string; tone: "paid" | "overdue" | "open" | "muted" }; source: "SQUARE" | "OFFICE" | "NONE" } = null;
  if (await canManageBilling(actor)) {
    const sq = await squareBillingFor(clientId);
    const billing = await prisma.bookkeepingBilling.findUnique({ where: { clientId } });
    if (sq.arrangement) {
      account = { plan: billing?.tierName ? `Monthly Service (${billing.tierName})` : sq.arrangement.title || "Monthly Service", amountCents: sq.arrangement.amountCents, due: sq.arrangement.nextDueDate ? ymd(sq.arrangement.nextDueDate) : null, status: { label: "Billed in Square", tone: "open" }, source: "SQUARE" };
    } else {
      const mv = await manualBillingView(actor, clientId);
      if (mv.ledger) {
        const l = mv.ledger;
        account = {
          plan: billing?.tierName ? `Monthly Service (${billing.tierName})` : "Monthly Service",
          amountCents: billing?.monthlyFeeCents ?? null,
          due: l.next?.due ?? null,
          status: l.overdueCount > 0 ? { label: l.status.label, tone: "overdue" } : { label: "Paid", tone: "paid" },
          source: "OFFICE",
        };
      } else account = { plan: billing?.tierName ?? null, amountCents: billing?.monthlyFeeCents ?? null, due: null, status: { label: "Not set up", tone: "muted" }, source: "NONE" };
    }
  }

  const services = ["Bookkeeping", ...(profile?.payroll ? ["Payroll"] : []), "Taxes", ...(licenseRows.length ? ["Compliance"] : [])];

  return {
    client: { id: client.id, name: client.businessName || client.displayName, managed: client.businessAccess === "ACTIVE", active: client.status === "ACTIVE" },
    services,
    profile: { einLast4: profile?.einLast4 ?? null, basis: profile?.accountingBasis ?? book?.basis ?? null, coethaUrl: profile?.coethaUrl ?? null },
    selected,
    monthChoices,
    periodId: period?.id ?? null,
    close,
    ledger,
    hasBooks: !!book,
    payroll,
    filings: { next: filings[0] ?? null, dueSoon: filingsDueSoon },
    licenses: { count: licenseRows.length, expired: licenseRows.filter((l) => l.expired).length, next: nextLicense },
    yearEnd: ye ? { taxYear: ye.taxYear, stage: ye.stage as YearEndStage } : null,
    invoicing,
    account,
    deadlines: deadlines.filter((d) => d.status !== "PAST_DUE" || daysBetween(d.date, today) <= 30).slice(0, 6),
  };
}

// --- Business licenses and year-end status (staff) -----------------------------------------

const clean = (v: string | null | undefined, n: number) => v?.trim().slice(0, n) || null;
const isYmd = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`));

export async function addBusinessLicense(actor: Actor, clientId: string, input: { name: string; jurisdiction?: string; licenseNumber?: string; renewalDate?: string; note?: string }) {
  const name = clean(input.name, 120);
  if (!name) throw new ValidationError("Enter the license name.");
  if (input.renewalDate && !isYmd(input.renewalDate)) throw new ValidationError("Enter a valid renewal date.");
  if (!(await prisma.client.count({ where: { id: clientId } }))) throw new ValidationError("Client not found.");
  const l = await prisma.businessLicense.create({
    data: { clientId, name, jurisdiction: clean(input.jurisdiction, 120), licenseNumber: clean(input.licenseNumber, 60), renewalDate: input.renewalDate ? new Date(`${input.renewalDate}T00:00:00Z`) : null, note: clean(input.note, 300), createdById: actor.id },
  });
  await audit(prisma, { actorId: actor.id, action: "business_license.added", entityType: "BusinessLicense", entityId: l.id, clientId, details: { name } });
  return l;
}

export async function updateLicenseRenewal(actor: Actor, licenseId: string, renewalDate: string) {
  if (!isYmd(renewalDate)) throw new ValidationError("Enter a valid renewal date.");
  const l = await prisma.businessLicense.findUnique({ where: { id: licenseId } });
  if (!l || l.archivedAt) throw new ValidationError("License not found.");
  await prisma.businessLicense.update({ where: { id: l.id }, data: { renewalDate: new Date(`${renewalDate}T00:00:00Z`) } });
  await audit(prisma, { actorId: actor.id, action: "business_license.renewed", entityType: "BusinessLicense", entityId: l.id, clientId: l.clientId, details: { from: l.renewalDate ? ymd(l.renewalDate) : null, to: renewalDate } });
}

/** Removing a license keeps its record (archived) for the history. */
export async function archiveBusinessLicense(actor: Actor, licenseId: string) {
  const l = await prisma.businessLicense.findUnique({ where: { id: licenseId } });
  if (!l || l.archivedAt) throw new ValidationError("License not found.");
  await prisma.businessLicense.update({ where: { id: l.id }, data: { archivedAt: new Date() } });
  await audit(prisma, { actorId: actor.id, action: "business_license.removed", entityType: "BusinessLicense", entityId: l.id, clientId: l.clientId, details: { name: l.name } });
}

export async function setYearEndStage(actor: Actor, clientId: string, taxYear: number, stage: string, note?: string) {
  if (!Number.isInteger(taxYear) || taxYear < 2020 || taxYear > 2100) throw new ValidationError("Choose the tax year.");
  if (!(stage in YEAR_END_STAGES)) throw new ValidationError("Choose a status.");
  if (!(await prisma.client.count({ where: { id: clientId } }))) throw new ValidationError("Client not found.");
  const data = { stage, note: clean(note, 500), updatedById: actor.id };
  const r = await prisma.yearEndFiling.upsert({ where: { clientId_taxYear: { clientId, taxYear } }, create: { clientId, taxYear, ...data }, update: data });
  await audit(prisma, { actorId: actor.id, action: "year_end.stage_set", entityType: "YearEndFiling", entityId: r.id, clientId, details: { taxYear, stage } });
  return r;
}

export async function setPayrollPayDate(actor: Actor, clientId: string, date: string | null) {
  if (date && !isYmd(date)) throw new ValidationError("Enter a valid pay date.");
  const p = await prisma.bookkeepingProfile.findUnique({ where: { clientId } });
  if (!p) throw new ValidationError("This client isn't a bookkeeping client.");
  await prisma.bookkeepingProfile.update({ where: { clientId }, data: { payrollPayDate: date ? new Date(`${date}T00:00:00Z`) : null, updatedById: actor.id } });
  await audit(prisma, { actorId: actor.id, action: "bookkeeping.pay_date_set", entityType: "Client", entityId: clientId, clientId, details: { date } });
}
