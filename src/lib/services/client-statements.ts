import "server-only";
import { PDFDocument, rgb, StandardFonts, type PDFFont, type PDFPage } from "pdf-lib";
import { prisma } from "@/lib/prisma";
import { ForbiddenError } from "@/lib/auth/actor";
import { BUSINESS } from "@/lib/business";
import { MONTH_NAMES } from "@/lib/bk-uploads";
import type { Actor } from "@/lib/auth/actor";
import { canApproveCoethaWork } from "@/lib/auth/permissions";
import { audit } from "@/lib/audit";
import { ValidationError } from "./clients";
import { isYmd, todayCentral } from "./ledger";
import { notifyClientUsers } from "./documents";

/**
 * CLIENT-FACING financial statements. Standard financial presentation only: accounts,
 * descriptions, balances and periods. This module is the only place portal output is built
 * from the ledger, and it is deliberately narrow:
 *
 * - It never reads Coetha tables (CoethaRun / CoethaProposal), audit notes, review notes,
 *   journal-entry reasons, entry sources, staff names or request reasons.
 * - Every text that reaches the client goes through `clientText`, which removes internal
 *   markers ("Coetha", "AI", "recommend", "possible error", "awaiting approval", "draft",
 *   staff notes…). An account used for items still under review is shown as
 *   "Uncategorized", never "Ask My Accountant (needs review)".
 * - A statement exists for the client only after Tabitha approved AND released (delivered) the
 *   month's statements and closed the books through the month end, so the figures can't change.
 *   Before that the client sees only "Financial Statements in Preparation".
 */

const INTERNAL = /\b(coetha|a\.?i\.?|ai[- ]generated|artificial intelligence|claude|recommend\w*|suggest\w*|possible (error|duplicate)|awaiting (approval|review)|approved by|pending approval|draft|staff( note| comment)?|internal|needs? review|review(ed)? by|tabitha|flag(ged)?|reclassif\w*|ask my accountant|suspense|per (our|the) review)\b/i;

/** Text safe for a client: internal markers and anything after them are removed; empty → fallback. */
export function clientText(s: string | null | undefined, fallback = "") {
  if (!s) return fallback;
  let t = s.replace(/\([^)]*\)/g, (m) => (INTERNAL.test(m) ? "" : m)).replace(/\[[^\]]*\]/g, "");
  const hit = INTERNAL.exec(t);
  if (hit) t = t.slice(0, hit.index);
  t = t.replace(/[\s,;:–—-]+$/g, "").replace(/\s+/g, " ").trim();
  return t || fallback;
}

const accountName = (a: { name: string; subtype: string | null }) => (a.subtype === "SUSPENSE" ? "Uncategorized" : clientText(a.name, "Other"));

export type ClientStatementStatus = "IN_PREPARATION" | "AVAILABLE";
export const CLIENT_STATUS_LABEL: Record<ClientStatementStatus, string> = { IN_PREPARATION: "Financial Statements in Preparation", AVAILABLE: "Available for Download" };

const pad = (n: number) => String(n).padStart(2, "0");
const monthEnd = (y: number, m: number) => `${y}-${pad(m)}-${pad(new Date(Date.UTC(y, m, 0)).getUTCDate())}`;
const D = (s: string) => new Date(`${s}T00:00:00.000Z`);

/**
 * The only status a client sees for a month. AVAILABLE = Tabitha approved and released the
 * month's financial statements (published, scanned clean); otherwise IN_PREPARATION.
 */
export async function clientStatementStatus(periodId: string): Promise<ClientStatementStatus> {
  const released = await prisma.document.count({ where: { periodId, deletedAt: null, category: "BOOKKEEPING", reportType: { in: ["PROFIT_AND_LOSS", "BALANCE_SHEET", "FINANCIAL_PACKET"] }, reviewStatus: "APPROVED", visibility: "PUBLISHED", scanStatus: "CLEAN" } });
  return released ? "AVAILABLE" : "IN_PREPARATION";
}

/** Ledger-built statements for the client exist only when released AND the books are closed through the month. */
export async function ledgerStatementsReleased(periodId: string) {
  const p = await prisma.bookkeepingPeriod.findUnique({ where: { id: periodId }, select: { clientId: true, year: true, month: true } });
  if (!p) return null;
  if ((await clientStatementStatus(periodId)) !== "AVAILABLE") return null;
  const book = await prisma.ledgerBook.findUnique({ where: { clientId: p.clientId }, select: { basis: true, lockedThrough: true, fiscalYearStartMonth: true } });
  if (!book?.lockedThrough || book.lockedThrough.toISOString().slice(0, 10) < monthEnd(p.year, p.month)) return null;
  return { ...p, basis: book.basis as "CASH" | "ACCRUAL", fiscalYearStartMonth: book.fiscalYearStartMonth };
}

const basisIn = (b: "CASH" | "ACCRUAL") => ({ in: b === "CASH" ? ["BOTH", "CASH_ONLY"] : ["BOTH", "ACCRUAL_ONLY"] });

export type StatementLine = { label: string; amountCents: number };
export type StatementSection = { title: string; lines: StatementLine[]; totalLabel: string; totalCents: number };

/** Sums by account, selecting only account identity and amounts. */
async function sums(clientId: string, where: { from?: Date; to: Date }, basis: "CASH" | "ACCRUAL") {
  const rows = await prisma.journalLine.groupBy({ by: ["accountId"], where: { entry: { clientId, date: { ...(where.from ? { gte: where.from } : {}), lte: where.to }, basis: basisIn(basis) } }, _sum: { debitCents: true, creditCents: true } });
  return new Map(rows.map((r) => [r.accountId, { dr: r._sum.debitCents ?? 0, cr: r._sum.creditCents ?? 0 }]));
}

/** What a client statement covers: one month (released + closed) or an interim release. */
type Scope = { clientId: string; basis: "CASH" | "ACCRUAL"; fiscalYearStartMonth: number; from: string; to: string; plPeriod: string; bsPeriod: string; glPeriod: string; interim: string | null; fileTag: string };

const longDay = (ymd: string) => `${MONTH_NAMES[Number(ymd.slice(5, 7)) - 1]} ${Number(ymd.slice(8, 10))}, ${ymd.slice(0, 4)}`;
/** The label every interim statement carries, in the portal and on the PDF header. */
export const interimLabel = (asOf: string) => `Interim — unaudited, prepared as of ${longDay(asOf)}`;

async function monthScope(periodId: string): Promise<Scope> {
  const r = await ledgerStatementsReleased(periodId);
  if (!r) throw new ForbiddenError("These statements aren't available yet.");
  const end = monthEnd(r.year, r.month);
  const last = new Date(Date.UTC(r.year, r.month, 0)).getUTCDate();
  return {
    clientId: r.clientId, basis: r.basis, fiscalYearStartMonth: r.fiscalYearStartMonth, from: `${r.year}-${pad(r.month)}-01`, to: end,
    plPeriod: `For the Month Ended ${MONTH_NAMES[r.month - 1]} ${last}, ${r.year}`, bsPeriod: `As of ${MONTH_NAMES[r.month - 1]} ${last}, ${r.year}`, glPeriod: `${MONTH_NAMES[r.month - 1]} 1 – ${last}, ${r.year}`,
    interim: null, fileTag: `${MONTH_NAMES[r.month - 1]} ${r.year}`,
  };
}

/** An interim release Tabitha approved (not revoked). Never requires the period to be closed. */
async function interimScope(interimId: string): Promise<Scope> {
  const s = await prisma.interimStatement.findUnique({ where: { id: interimId } });
  if (!s || s.revokedAt) throw new ForbiddenError("This statement isn't available.");
  const book = await prisma.ledgerBook.findUnique({ where: { clientId: s.clientId }, select: { basis: true, fiscalYearStartMonth: true } });
  if (!book) throw new ForbiddenError("This statement isn't available.");
  const from = s.fromDate.toISOString().slice(0, 10), to = s.asOf.toISOString().slice(0, 10);
  return {
    clientId: s.clientId, basis: book.basis as "CASH" | "ACCRUAL", fiscalYearStartMonth: book.fiscalYearStartMonth, from, to,
    plPeriod: `For the Period ${longDay(from)} – ${longDay(to)}`, bsPeriod: `As of ${longDay(to)}`, glPeriod: `${longDay(from)} – ${longDay(to)}`,
    interim: interimLabel(to), fileTag: `Interim ${to}`,
  };
}

async function buildPL(sc: Scope) {
  const accounts = await prisma.ledgerAccount.findMany({ where: { clientId: sc.clientId, type: { in: ["INCOME", "EXPENSE"] } }, orderBy: { code: "asc" }, select: { id: true, name: true, type: true, subtype: true } });
  const m = await sums(sc.clientId, { from: D(sc.from), to: D(sc.to) }, sc.basis);
  const amt = (a: (typeof accounts)[number]) => { const s = m.get(a.id); return s ? (a.type === "INCOME" ? s.cr - s.dr : s.dr - s.cr) : 0; };
  const section = (title: string, totalLabel: string, pick: (a: (typeof accounts)[number]) => boolean): StatementSection => {
    const lines = accounts.filter(pick).map((a) => ({ label: accountName(a), amountCents: amt(a) })).filter((l) => l.amountCents !== 0);
    return { title, lines, totalLabel, totalCents: lines.reduce((n, l) => n + l.amountCents, 0) };
  };
  const income = section("Income", "Total Income", (a) => a.type === "INCOME" && a.subtype !== "OTHER_INCOME");
  const cogs = section("Cost of Goods Sold", "Total Cost of Goods Sold", (a) => a.subtype === "COGS");
  const expenses = section("Expenses", "Total Expenses", (a) => a.type === "EXPENSE" && a.subtype !== "COGS" && a.subtype !== "OTHER_EXPENSE");
  const otherIncome = section("Other Income", "Total Other Income", (a) => a.subtype === "OTHER_INCOME");
  const otherExpense = section("Other Expenses", "Total Other Expenses", (a) => a.subtype === "OTHER_EXPENSE");
  const gross = income.totalCents - cogs.totalCents;
  const net = gross - expenses.totalCents + otherIncome.totalCents - otherExpense.totalCents;
  return { kind: "PL" as const, title: "Profit and Loss", period: sc.plPeriod, basis: sc.basis === "CASH" ? "Cash Basis" : "Accrual Basis", interim: sc.interim, sections: [income, cogs, expenses, otherIncome, otherExpense].filter((s) => s.lines.length), totals: [{ label: "Gross Profit", amountCents: gross }, { label: "Net Income", amountCents: net }], clientId: sc.clientId, fileTag: sc.fileTag };
}

async function buildBS(sc: Scope) {
  const y = Number(sc.to.slice(0, 4)), mo = Number(sc.to.slice(5, 7));
  const fyStart = `${mo >= sc.fiscalYearStartMonth ? y : y - 1}-${pad(sc.fiscalYearStartMonth)}-01`;
  const accounts = await prisma.ledgerAccount.findMany({ where: { clientId: sc.clientId }, orderBy: { code: "asc" }, select: { id: true, name: true, type: true, subtype: true } });
  const [all, prior] = await Promise.all([sums(sc.clientId, { to: D(sc.to) }, sc.basis), sums(sc.clientId, { to: new Date(D(fyStart).getTime() - 86_400_000) }, sc.basis)]);
  const nat = (a: (typeof accounts)[number], m: typeof all) => { const s = m.get(a.id); return s ? (a.type === "ASSET" || a.type === "EXPENSE" ? s.dr - s.cr : s.cr - s.dr) : 0; };
  const ni = (m: typeof all) => accounts.reduce((n, a) => n + (a.type === "INCOME" ? nat(a, m) : a.type === "EXPENSE" ? -nat(a, m) : 0), 0);
  const pick = (type: string) => accounts.filter((a) => a.type === type).map((a) => ({ label: accountName(a), amountCents: nat(a, all) })).filter((l) => l.amountCents !== 0);
  const assets = pick("ASSET"), liabilities = pick("LIABILITY"), equity = pick("EQUITY");
  const retained = ni(prior), current = ni(all) - retained;
  const eqLines = [...equity, ...(retained ? [{ label: "Retained Earnings", amountCents: retained }] : []), ...(current ? [{ label: "Net Income", amountCents: current }] : [])];
  const total = (l: StatementLine[]) => l.reduce((n, x) => n + x.amountCents, 0);
  const sections: StatementSection[] = [
    { title: "Assets", lines: assets, totalLabel: "Total Assets", totalCents: total(assets) },
    { title: "Liabilities", lines: liabilities, totalLabel: "Total Liabilities", totalCents: total(liabilities) },
    { title: "Equity", lines: eqLines, totalLabel: "Total Equity", totalCents: total(eqLines) },
  ];
  return { kind: "BS" as const, title: "Balance Sheet", period: sc.bsPeriod, basis: sc.basis === "CASH" ? "Cash Basis" : "Accrual Basis", interim: sc.interim, sections, totals: [{ label: "Total Liabilities and Equity", amountCents: total(liabilities) + total(eqLines) }], clientId: sc.clientId, fileTag: sc.fileTag };
}

/**
 * What a General Ledger line may say to the client: an explicit allowlist, never free text written
 * in the office. A line from a bank or card transaction shows that transaction's own description
 * (the words on the client's statement); every other line shows a fixed label for its kind of
 * entry. Memos, line descriptions, reasons and anything Coetha wrote are never read here.
 */
export const GL_ENTRY_LABEL: Record<string, string> = {
  OPENING: "Opening balance",
  BANK: "Bank transaction",
  ADJUSTMENT: "Adjusting entry",
  REVERSAL: "Reversing entry",
  INVOICE: "Invoice",
  PAYMENT: "Payment",
  PAYOUT: "Payout",
  MANUAL: "Journal entry",
};
export function glLineDescription(entry: { source: string; bankTransactions: { description: string }[] }): string {
  const bank = entry.bankTransactions[0]?.description?.replace(/\s+/g, " ").trim().slice(0, 120);
  if (bank) return bank;
  return GL_ENTRY_LABEL[entry.source] ?? "Journal entry";
}

/** General ledger detail: date, account, description (allowlisted, above), debit, credit. */
async function buildGL(sc: Scope) {
  const lines = await prisma.journalLine.findMany({
    where: { entry: { clientId: sc.clientId, date: { gte: D(sc.from), lte: D(sc.to) }, basis: basisIn(sc.basis) } },
    select: { debitCents: true, creditCents: true, account: { select: { code: true, name: true, subtype: true } }, entry: { select: { date: true, source: true, bankTransactions: { select: { description: true }, take: 1 } } } },
    orderBy: [{ account: { code: "asc" } }, { entry: { date: "asc" } }],
  });
  const rows = lines.map((l) => ({ date: l.entry.date.toISOString().slice(0, 10), account: `${l.account.code} ${accountName(l.account)}`, description: glLineDescription(l.entry), debitCents: l.debitCents, creditCents: l.creditCents }));
  return { kind: "GL" as const, title: "General Ledger", period: sc.glPeriod, basis: sc.basis === "CASH" ? "Cash Basis" : "Accrual Basis", interim: sc.interim, rows, clientId: sc.clientId, fileTag: sc.fileTag };
}

export const clientProfitAndLoss = async (periodId: string) => buildPL(await monthScope(periodId));
export const clientBalanceSheet = async (periodId: string) => buildBS(await monthScope(periodId));
export const clientGeneralLedger = async (periodId: string) => buildGL(await monthScope(periodId));
export const interimProfitAndLoss = async (interimId: string) => buildPL(await interimScope(interimId));
export const interimBalanceSheet = async (interimId: string) => buildBS(await interimScope(interimId));

/**
 * The month's Profit & Loss and Balance Sheet built straight from the books, for the office (Coetha
 * prepares them as drafts for Tabitha's approval). Not gated on release: nothing here reaches the
 * client until Tabitha approves and releases the saved statements.
 */
export async function booksStatements(clientId: string, year: number, month: number) {
  const book = await prisma.ledgerBook.findUnique({ where: { clientId }, select: { basis: true, fiscalYearStartMonth: true } });
  if (!book) throw new ValidationError("This business's books aren't set up yet.");
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const sc: Scope = {
    clientId, basis: book.basis as "CASH" | "ACCRUAL", fiscalYearStartMonth: book.fiscalYearStartMonth, from: `${year}-${pad(month)}-01`, to: monthEnd(year, month),
    plPeriod: `For the Month Ended ${MONTH_NAMES[month - 1]} ${last}, ${year}`, bsPeriod: `As of ${MONTH_NAMES[month - 1]} ${last}, ${year}`, glPeriod: `${MONTH_NAMES[month - 1]} 1 – ${last}, ${year}`,
    interim: "Draft — prepared from the books, for review", fileTag: `${MONTH_NAMES[month - 1]} ${year}`,
  };
  return { pl: await buildPL(sc), bs: await buildBS(sc), basis: sc.basis };
}

// --- Interim releases (Tabitha only) -------------------------------------------------------------

/**
 * Tabitha approves and releases an interim financial statement (e.g. for a lender) without closing
 * the period. Labeled "Interim — unaudited, prepared as of <date>" everywhere it appears. Audited.
 */
export async function releaseInterimStatement(actor: Actor, clientId: string, input: { from: string; asOf: string; purpose?: string | null }, today = todayCentral()) {
  if (!(await canApproveCoethaWork(actor))) throw new ForbiddenError("Only Tabitha can release an interim financial statement.");
  if (!isYmd(input.from) || !isYmd(input.asOf) || input.from > input.asOf) throw new ValidationError("Choose the period the interim statement covers.");
  if (input.asOf > today) throw new ValidationError("The as-of date can't be in the future.");
  if (!(await prisma.ledgerBook.count({ where: { clientId } }))) throw new ValidationError("Set up this business's books first.");
  const purpose = clientText(input.purpose?.trim().slice(0, 120), "") || null;
  const s = await prisma.interimStatement.create({ data: { clientId, fromDate: D(input.from), asOf: D(input.asOf), purpose, releasedById: actor.id } });
  await audit(prisma, { actorId: actor.id, action: "statements.interim_released", entityType: "InterimStatement", entityId: s.id, clientId, details: { from: input.from, asOf: input.asOf, purpose } });
  await notifyClientUsers(clientId, "NEW_DOCUMENT", `interim:${s.id}`, "BOOKKEEPING");
  return s;
}

export async function revokeInterimStatement(actor: Actor, clientId: string, id: string) {
  if (!(await canApproveCoethaWork(actor))) throw new ForbiddenError("Only Tabitha can withdraw an interim financial statement.");
  const r = await prisma.interimStatement.updateMany({ where: { id, clientId, revokedAt: null }, data: { revokedAt: new Date(), revokedById: actor.id } });
  if (!r.count) throw new ValidationError("That interim statement isn't available.");
  await audit(prisma, { actorId: actor.id, action: "statements.interim_withdrawn", entityType: "InterimStatement", entityId: id, clientId });
}

/** Interim statements a client may see: released and not withdrawn. Only financial fields. */
export async function clientInterimStatements(clientId: string) {
  const rows = await prisma.interimStatement.findMany({ where: { clientId, revokedAt: null }, orderBy: { releasedAt: "desc" }, select: { id: true, fromDate: true, asOf: true, purpose: true } });
  return rows.map((r) => ({ id: r.id, from: r.fromDate.toISOString().slice(0, 10), asOf: r.asOf.toISOString().slice(0, 10), purpose: r.purpose, label: interimLabel(r.asOf.toISOString().slice(0, 10)) }));
}

// --- PDF ---------------------------------------------------------------------------------------

const NAVY = rgb(10 / 255, 26 / 255, 68 / 255);
const GRAY = rgb(0.4, 0.42, 0.47);
const RULE = rgb(0.82, 0.83, 0.86);
const safe = (t: string) => t.replace(/[^\x20-\x7E -ÿ–—•‘’“”…]/g, "?");
const money = (c: number) => `${c < 0 ? "(" : ""}$${(Math.abs(c) / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}${c < 0 ? ")" : ""}`;

type Built = Awaited<ReturnType<typeof buildPL>> | Awaited<ReturnType<typeof buildBS>> | Awaited<ReturnType<typeof buildGL>>;

/** A plain statement PDF: business name, statement title, period, basis, lines, totals and the firm's name. Nothing else. */
export async function clientStatementPdf(s: Built) {
  const client = await prisma.client.findUniqueOrThrow({ where: { id: s.clientId }, select: { displayName: true, businessName: true, bookkeepingProfile: { select: { legalName: true } } } });
  const name = client.bookkeepingProfile?.legalName || client.businessName || client.displayName;
  const pdf = await PDFDocument.create();
  pdf.setTitle(safe(`${name} — ${s.title} — ${s.period}${s.interim ? ` — ${s.interim}` : ""}`));
  pdf.setAuthor(safe(BUSINESS.legalName));
  pdf.setSubject("Financial statement");
  pdf.setKeywords([]);
  pdf.setProducer(safe(BUSINESS.displayName));
  pdf.setCreator(safe(BUSINESS.displayName));
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const serif = await pdf.embedFont(StandardFonts.TimesRomanBold);
  // The firm's letterhead on every page: logo mark, firm name, a gold rule.
  const { LOGO_MARK_PNG_BASE64 } = await import("@/lib/brand-logo");
  const logo = await pdf.embedPng(Buffer.from(LOGO_MARK_PNG_BASE64, "base64"));
  const GOLD = rgb(200 / 255, 157 / 255, 41 / 255);
  let page: PDFPage = pdf.addPage([612, 792]);
  let y = 740;
  const center = (t: string, size: number, f: PDFFont, color = NAVY) => { const x = (612 - f.widthOfTextAtSize(safe(t), size)) / 2; page.drawText(safe(t), { x, y, size, font: f, color }); y -= size + 6; };
  const letterhead = () => {
    const lw = 34;
    const lh = (logo.height / logo.width) * lw;
    page.drawImage(logo, { x: 60, y: 752 - lh, width: lw, height: lh });
    const [firm1, ...firmRest] = BUSINESS.displayName.split(" & ");
    page.drawText(safe(firm1.toUpperCase()), { x: 60 + lw + 10, y: 740, size: 14, font: serif, color: NAVY });
    if (firmRest.length) page.drawText(safe(`& ${firmRest.join(" & ")}`.toUpperCase()), { x: 60 + lw + 10, y: 728, size: 7.5, font: serif, color: NAVY });
    page.drawText("Bookkeeping & Accounting Services", { x: 552 - font.widthOfTextAtSize("Bookkeeping & Accounting Services", 8.5), y: 734, size: 8.5, font, color: GRAY });
    page.drawLine({ start: { x: 60, y: 716 }, end: { x: 552, y: 716 }, thickness: 1.2, color: GOLD });
  };
  const header = () => { letterhead(); y = 690; center(name, 16, bold); center(s.title, 13, bold); center(s.period, 10, font, GRAY); center(s.basis, 10, font, GRAY); if (s.interim) center(s.interim, 10.5, bold, rgb(0.55, 0.35, 0.05)); y -= 10; };
  const need = (h: number) => { if (y - h < 60) { page = pdf.addPage([612, 792]); header(); } };
  const row = (label: string, amount: string | null, f = font, indent = 0, amount2?: string) => {
    need(16);
    page.drawText(safe(label).slice(0, 70), { x: 60 + indent, y, size: 10, font: f, color: rgb(0.1, 0.1, 0.12) });
    if (amount2 !== undefined) {
      page.drawText(safe(amount2), { x: 552 - f.widthOfTextAtSize(safe(amount2), 10), y, size: 10, font: f });
      if (amount) page.drawText(safe(amount), { x: 472 - f.widthOfTextAtSize(safe(amount), 10), y, size: 10, font: f });
    } else if (amount) page.drawText(safe(amount), { x: 552 - f.widthOfTextAtSize(safe(amount), 10), y, size: 10, font: f });
    y -= 15;
  };
  header();
  if (s.kind === "GL") {
    row("Date   Account / Description", "Debit", bold, 0, "Credit");
    for (const l of s.rows) row(`${l.date}  ${l.account} — ${l.description}`.slice(0, 80), l.debitCents ? money(l.debitCents) : "", font, 0, l.creditCents ? money(l.creditCents) : "");
  } else {
    for (const sec of s.sections) {
      row(sec.title, null, bold);
      for (const l of sec.lines) row(l.label, money(l.amountCents), font, 14);
      row(sec.totalLabel, money(sec.totalCents), bold);
      page.drawLine({ start: { x: 60, y: y + 10 }, end: { x: 552, y: y + 10 }, thickness: 0.5, color: RULE });
      y -= 6;
    }
    for (const t of s.totals) row(t.label, money(t.amountCents), bold);
  }
  for (const p of pdf.getPages()) p.drawText(safe(`Prepared by ${BUSINESS.displayName}`), { x: 60, y: 36, size: 8, font, color: GRAY });
  return { pdf: await pdf.save(), filename: safe(`${name} ${s.title} ${s.fileTag}.pdf`).replace(/[^\w.\- ()]/g, "_") };
}

// --- Financial Statements Package (the firm's layout) ---------------------------------------------

/**
 * The firm's Financial Statements Package for one business, built from the books, in the layout of
 * the office's own packages: a cover (logo, "Financial Statements", the business, basis and
 * period, prepared for / by / date / contents); a landscape Profit & Loss with each month of the
 * fiscal year to date and a YTD column; and a Balance Sheet as of the month end. Every page carries
 * the basis-of-presentation note and "TTurner & Associates, LLC • Confidential • Page x of y".
 */
export async function booksPackagePdf(clientId: string, year: number, month: number, opts: { draft?: boolean; preparedOn?: Date } = {}) {
  const [book, client] = await Promise.all([
    prisma.ledgerBook.findUnique({ where: { clientId }, select: { basis: true, fiscalYearStartMonth: true } }),
    prisma.client.findUniqueOrThrow({ where: { id: clientId }, select: { displayName: true, businessName: true, bookkeepingProfile: { select: { legalName: true } } } }),
  ]);
  if (!book) throw new ValidationError("This business's books aren't set up yet.");
  const basis = book.basis as "CASH" | "ACCRUAL";
  const basisLabel = basis === "CASH" ? "Cash Basis" : "Accrual Basis";
  const name = client.bookkeepingProfile?.legalName || client.businessName || client.displayName;
  const fyStartMonth = book.fiscalYearStartMonth;
  const fyYear = month >= fyStartMonth ? year : year - 1;
  // The months of the fiscal year through the month asked for.
  const months: { y: number; m: number }[] = [];
  for (let y = fyYear, m = fyStartMonth; ; ) { months.push({ y, m }); if (y === year && m === month) break; m++; if (m > 12) { m = 1; y++; } if (months.length > 12) break; }
  const from = `${months[0].y}-${pad(months[0].m)}-01`, to = monthEnd(year, month);
  const long = (ymd: string) => longDay(ymd);
  const periodText = `${long(from).replace(/, \d{4}$/, "")} – ${long(to)}`;

  // Profit & Loss by month.
  const accounts = await prisma.ledgerAccount.findMany({ where: { clientId }, orderBy: { code: "asc" }, select: { id: true, name: true, type: true, subtype: true } });
  const plAccts = accounts.filter((a) => a.type === "INCOME" || a.type === "EXPENSE");
  const perMonth = await Promise.all(months.map((mm) => sums(clientId, { from: D(`${mm.y}-${pad(mm.m)}-01`), to: D(monthEnd(mm.y, mm.m)) }, basis)));
  const amt = (a: (typeof plAccts)[number], s: Map<string, { dr: number; cr: number }>) => { const v = s.get(a.id); return v ? (a.type === "INCOME" ? v.cr - v.dr : v.dr - v.cr) : 0; };
  type Line = { label: string; values: number[] };
  const group = (pick: (a: (typeof plAccts)[number]) => boolean): Line[] => plAccts.filter(pick).map((a) => ({ label: accountName(a), values: perMonth.map((s) => amt(a, s)) })).filter((l) => l.values.some((v) => v !== 0));
  const sum = (ls: Line[]) => months.map((_, i) => ls.reduce((n, l) => n + l.values[i], 0));
  const income = group((a) => a.type === "INCOME" && a.subtype !== "OTHER_INCOME");
  const cogs = group((a) => a.subtype === "COGS");
  const opex = group((a) => a.type === "EXPENSE" && a.subtype !== "COGS" && a.subtype !== "OTHER_EXPENSE");
  const otherInc = group((a) => a.subtype === "OTHER_INCOME");
  const otherExp = group((a) => a.subtype === "OTHER_EXPENSE");
  const tIncome = sum(income), tCogs = sum(cogs), tOpex = sum(opex), tOI = sum(otherInc), tOE = sum(otherExp);
  const operating = months.map((_, i) => tIncome[i] - tCogs[i] - tOpex[i]);
  const net = months.map((_, i) => operating[i] + tOI[i] - tOE[i]);

  // Balance Sheet as of the month end (same rules as the single statement).
  const bs = await buildBS({ clientId, basis, fiscalYearStartMonth: fyStartMonth, from, to, plPeriod: "", bsPeriod: "", glPeriod: "", interim: null, fileTag: "" });

  const { LOGO_MARK_PNG_BASE64 } = await import("@/lib/brand-logo");
  const pdf = await PDFDocument.create();
  pdf.setTitle(safe(`${name} — Financial Statements — ${periodText}`));
  const stamp = new Date(`${(opts.preparedOn ?? new Date()).toISOString().slice(0, 10)}T12:00:00Z`);
  pdf.setCreationDate(stamp);
  pdf.setModificationDate(stamp);
  pdf.setAuthor(safe(BUSINESS.legalName));
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const italic = await pdf.embedFont(StandardFonts.HelveticaOblique);
  const logo = await pdf.embedPng(Buffer.from(LOGO_MARK_PNG_BASE64, "base64"));
  const TITLE = rgb(0.13, 0.25, 0.47);
  const RED = rgb(0.75, 0.1, 0.1);
  const BAND = rgb(0.93, 0.95, 0.98);
  const firm = BUSINESS.legalName.replace(/^T\. Turner/, "TTurner");
  const basisNote = `Basis of presentation. Prepared on the ${basis === "CASH" ? "cash" : "accrual"} basis from the business's books kept in ${BUSINESS.displayName}'s Client Connect for ${periodText}${basis === "CASH" ? "; income and expenses are recorded when cash is received or paid" : ""}. The Balance Sheet reflects the accounts kept in the books. Management-use summary; not audited or reviewed under AICPA standards.${opts.draft ? " DRAFT — for review; not final until approved." : ""}`;
  const wrap = (text: string, f: PDFFont, size: number, width: number) => {
    const words = safe(text).split(/\s+/); const lines: string[] = []; let cur = "";
    for (const w of words) { const t = cur ? `${cur} ${w}` : w; if (f.widthOfTextAtSize(t, size) > width && cur) { lines.push(cur); cur = w; } else cur = t; }
    if (cur) lines.push(cur); return lines;
  };
  const centerAt = (page: PDFPage, W: number, t: string, y: number, f: PDFFont, size: number, color = NAVY) => page.drawText(safe(t), { x: (W - f.widthOfTextAtSize(safe(t), size)) / 2, y, size, font: f, color });
  const drawLogo = (page: PDFPage, W: number, top: number, width: number) => { const h = (logo.height / logo.width) * width; page.drawImage(logo, { x: (W - width) / 2, y: top - h, width, height: h }); return top - h; };

  // 1. Cover (portrait).
  {
    const W = 612, H = 792;
    const page = pdf.addPage([W, H]);
    let y = drawLogo(page, W, H - 160, 90) - 26;
    const serif = await pdf.embedFont(StandardFonts.TimesRomanBold);
    const [firm1, ...firmRest] = BUSINESS.displayName.split(" & ");
    centerAt(page, W, firm1.toUpperCase(), y, serif, 22); y -= 14;
    centerAt(page, W, `& ${firmRest.join(" & ")}, LLC`.toUpperCase(), y, serif, 9); y -= 56;
    centerAt(page, W, "Financial Statements", y, bold, 26, TITLE); y -= 24;
    centerAt(page, W, name, y, bold, 14, rgb(0.25, 0.25, 0.28)); y -= 18;
    centerAt(page, W, `${basisLabel} • ${periodText}`, y, font, 11, TITLE); y -= 18;
    if (opts.draft) { centerAt(page, W, "DRAFT — prepared from the books, for review", y, bold, 10, rgb(0.55, 0.35, 0.05)); y -= 16; }
    y -= 24;
    const rows: [string, string][] = [["Prepared for:", name], ["Prepared by:", firm], ["Date prepared:", long((opts.preparedOn ?? new Date()).toISOString().slice(0, 10))], ["Contents:", "Profit & Loss • Profit & Loss by Month • Balance Sheet"]];
    for (const [k, v] of rows) { page.drawText(k, { x: 236 - bold.widthOfTextAtSize(k, 9.5), y, size: 9.5, font: bold, color: NAVY }); page.drawText(safe(v), { x: 246, y, size: 9.5, font, color: rgb(0.15, 0.15, 0.18) }); y -= 18; }
  }

  const plain = (c: number) => `${c < 0 ? "(" : ""}${(Math.abs(c) / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}${c < 0 ? ")" : ""}`;
  const compiled = `${basisLabel} – Compiled from the books${opts.draft ? " – DRAFT" : ""}`;
  // The statement header of the firm's layout: the business in large blue, the title lines, a navy
  // band with the column headings.
  const stmtHead = (page: PDFPage, W: number, title: string, when: string, heads: { label: string; x: number }[], left: number, right: number) => {
    let y = 792 - 60;
    centerAt(page, W, name, y, bold, 20, TITLE); y -= 20;
    centerAt(page, W, title, y, font, 11, rgb(0.1, 0.1, 0.12)); y -= 14;
    centerAt(page, W, when, y, font, 11, rgb(0.1, 0.1, 0.12)); y -= 14;
    centerAt(page, W, compiled, y, italic, 11, rgb(0.1, 0.1, 0.12)); y -= 26;
    page.drawRectangle({ x: left, y: y - 5, width: right - left, height: 18, color: NAVY });
    for (const h of heads) page.drawText(h.label, { x: h.x - bold.widthOfTextAtSize(h.label, 9), y, size: 9, font: bold, color: rgb(1, 1, 1) });
    return y - 22;
  };

  // 2. Profit & Loss — the month, year to date and % of revenue (portrait).
  {
    const W = 612;
    let page = pdf.addPage([W, 792]);
    const L = 72, R = W - 60, cMonth = 380, cYtd = 470, cPct = R - 8;
    const ytd = (v: number[]) => v.reduce((n, x) => n + x, 0);
    const last = months.length - 1;
    const revenueYtd = ytd(tIncome);
    const heads = [{ label: MONTH_NAMES[month - 1].slice(0, 3) + " " + year, x: cMonth }, { label: "Year to Date", x: cYtd }, { label: "% of Revenue", x: cPct }];
    const when = `For the Month Ended ${long(to)} and Year to Date`;
    let y = stmtHead(page, W, "Profit & Loss Statement", when, heads, L, R);
    const need = () => { if (y < 70) { page = pdf.addPage([W, 792]); y = stmtHead(page, W, "Profit & Loss Statement (continued)", when, heads, L, R); } };
    const line = (label: string, v: number[] | null, f = font, o: { indent?: number; rule?: boolean } = {}) => {
      need();
      page.drawText(safe(label).slice(0, 52), { x: L + (o.indent ?? 0), y, size: 9, font: f, color: rgb(0.1, 0.1, 0.12) });
      if (v) {
        const cells = [plain(v[last]), plain(ytd(v)), revenueYtd ? `${((ytd(v) / revenueYtd) * 100).toFixed(1)}%` : ""];
        [cMonth, cYtd, cPct].forEach((x, k) => cells[k] && page.drawText(cells[k], { x: x - f.widthOfTextAtSize(cells[k], 9), y, size: 9, font: f, color: rgb(0.1, 0.1, 0.12) }));
        if (o.rule) page.drawLine({ start: { x: cMonth - 70, y: y + 11 }, end: { x: cPct, y: y + 11 }, thickness: 0.7, color: rgb(0.1, 0.1, 0.12) });
      }
      y -= 16;
    };
    const block = (title: string, lines: Line[], total: number[], totalLabel: string) => {
      if (!lines.length) return;
      line(title, null, bold);
      for (const l of lines) line(l.label, l.values, font, { indent: 12 });
      line(totalLabel, total, bold, { rule: true });
    };
    block("REVENUE", income, tIncome, "Total Revenue");
    block("COST OF GOODS SOLD", cogs, tCogs, "Total Cost of Goods Sold");
    block("OPERATING EXPENSES", opex, tOpex, "Total Operating Expenses");
    line("NET OPERATING INCOME", operating, bold, { rule: true });
    if (otherInc.length || otherExp.length) {
      block("OTHER INCOME", otherInc, tOI, "Total Other Income");
      block("OTHER EXPENSES", otherExp, tOE, "Total Other Expenses");
    }
    line("NET INCOME", net, bold, { rule: true });
    y -= 6;
    for (const l of wrap(basisNote, font, 7.5, R - L)) { need(); page.drawText(l, { x: L, y, size: 7.5, font, color: GRAY }); y -= 10; }
  }

  // 3. Profit & Loss by month (landscape; each month of the year to date and YTD).
  {
    const W = 792, H = 612;
    let page = pdf.addPage([W, H]);
    const labelW = 190, x0 = 36, cols = months.length + 1;
    const colW = (W - 72 - labelW) / cols;
    const size = cols > 10 ? 7 : 8;
    const colX = (i: number) => x0 + labelW + colW * (i + 1);
    const head = () => {
      let y = H - 44;
      centerAt(page, W, name, y, bold, 16, TITLE); y -= 16;
      centerAt(page, W, `Profit & Loss — Monthly Detail • ${periodText}`, y, font, 10, rgb(0.1, 0.1, 0.12)); y -= 13;
      centerAt(page, W, compiled, y, italic, 10, rgb(0.1, 0.1, 0.12)); y -= 22;
      page.drawRectangle({ x: x0 - 2, y: y - 5, width: W - 72 + 4, height: 16, color: NAVY });
      page.drawText("Account", { x: x0 + 2, y, size, font: bold, color: rgb(1, 1, 1) });
      months.forEach((mm, i) => { const t = MONTH_NAMES[mm.m - 1].slice(0, 3); page.drawText(t, { x: colX(i) - bold.widthOfTextAtSize(t, size), y, size, font: bold, color: rgb(1, 1, 1) }); });
      page.drawText("YTD", { x: colX(months.length) - bold.widthOfTextAtSize("YTD", size), y, size, font: bold, color: rgb(1, 1, 1) });
      return y - 18;
    };
    let y = head();
    const row = (label: string, values: number[] | null, f = font, o: { band?: boolean; indent?: number } = {}) => {
      if (y < 50) { page = pdf.addPage([W, H]); y = head(); }
      if (o.band) page.drawRectangle({ x: x0 - 2, y: y - 4, width: W - 72 + 4, height: size + 7, color: BAND });
      page.drawText(safe(label).slice(0, 48), { x: x0 + (o.indent ?? 0), y, size, font: f, color: rgb(0.12, 0.12, 0.15) });
      if (values) [...values, values.reduce((n, v) => n + v, 0)].forEach((v, i) => { const t = plain(v); page.drawText(t, { x: colX(i) - f.widthOfTextAtSize(t, size), y, size, font: f, color: v < 0 ? RED : rgb(0.12, 0.12, 0.15) }); });
      y -= size + 8;
    };
    const section = (title: string, lines: Line[], total: number[], totalLabel: string) => {
      if (!lines.length) return;
      row(title, null, bold);
      for (const l of lines) row(l.label, l.values, font, { indent: 10 });
      row(totalLabel, total, bold);
    };
    section("REVENUE", income, tIncome, "Total Revenue");
    section("COST OF GOODS SOLD", cogs, tCogs, "Total Cost of Goods Sold");
    section("OPERATING EXPENSES", opex, tOpex, "Total Operating Expenses");
    row("NET OPERATING INCOME", operating, bold, { band: true });
    if (otherInc.length || otherExp.length) {
      section("OTHER INCOME", otherInc, tOI, "Total Other Income");
      section("OTHER EXPENSES", otherExp, tOE, "Total Other Expenses");
    }
    row("NET INCOME", net, bold, { band: true });
  }

  // 4. Balance Sheet — Amount and Source / Note (portrait).
  {
    const W = 612;
    let page = pdf.addPage([W, 792]);
    const L = 72, R = W - 60, cAmt = 330, cNote = 346;
    const heads = [{ label: "Amount", x: cAmt }, { label: "Source / Note", x: cNote + bold.widthOfTextAtSize("Source / Note", 9) }];
    let y = stmtHead(page, W, "Balance Sheet", `As of ${long(to)}`, heads, L, R);
    // Where each bank or card balance comes from: the month's approved reconciliation, else the books.
    const regs = await prisma.bookkeepingAccount.findMany({ where: { clientId, ledgerAccountId: { not: null } }, select: { ledgerAccountId: true, reconciliations: { where: { year, month }, select: { status: true, endingBalanceCents: true } } } });
    const noteFor = new Map<string, string>();
    for (const r of regs) { const rec = r.reconciliations[0]; noteFor.set(r.ledgerAccountId!, rec?.status === "APPROVED" ? `Reconciled to the statement ending ${long(to)}` : rec?.endingBalanceCents != null ? "Statement balance on file; reconciliation in progress" : "Books balance; statement not reconciled yet"); }
    const byLabel = new Map(accounts.map((a) => [accountName(a), a.id]));
    const line = (label: string, cents: number | null, f = font, o: { indent?: number; note?: string; rule?: boolean; double?: boolean } = {}) => {
      const noteLines = o.note ? wrap(o.note, font, 8, R - cNote) : [];
      if (y < 70) { page = pdf.addPage([W, 792]); y = stmtHead(page, W, "Balance Sheet (continued)", `As of ${long(to)}`, heads, L, R); }
      page.drawText(safe(label).slice(0, 44), { x: L + (o.indent ?? 0), y, size: 9, font: f, color: rgb(0.1, 0.1, 0.12) });
      if (cents !== null) {
        const t = plain(cents);
        if (o.rule) page.drawLine({ start: { x: cAmt - 90, y: y + 11 }, end: { x: cAmt, y: y + 11 }, thickness: 0.7, color: rgb(0.1, 0.1, 0.12) });
        page.drawText(t, { x: cAmt - f.widthOfTextAtSize(t, 9), y, size: 9, font: f, color: rgb(0.1, 0.1, 0.12) });
        if (o.double) { page.drawLine({ start: { x: cAmt - 90, y: y - 4 }, end: { x: cAmt, y: y - 4 }, thickness: 0.7, color: rgb(0.1, 0.1, 0.12) }); page.drawLine({ start: { x: cAmt - 90, y: y - 6 }, end: { x: cAmt, y: y - 6 }, thickness: 0.7, color: rgb(0.1, 0.1, 0.12) }); }
      }
      noteLines.forEach((n, k) => page.drawText(n, { x: cNote, y: y - k * 10, size: 8, font, color: rgb(0.1, 0.1, 0.12) }));
      y -= Math.max(16, noteLines.length * 10 + 6);
    };
    for (const sec of bs.sections) {
      line(sec.title.toUpperCase(), null, bold);
      for (const l of sec.lines) {
        const id = byLabel.get(l.label);
        const n = id && noteFor.get(id) ? noteFor.get(id) : l.label === "Net Income" ? "From the Profit & Loss (year to date)" : l.label === "Retained Earnings" ? "Prior years' results" : undefined;
        line(l.label, l.amountCents, font, { indent: 12, note: n });
      }
      line(`TOTAL ${sec.title.toUpperCase()}`, sec.totalCents, bold, { rule: true, double: sec.title === "Assets" });
    }
    for (const t of bs.totals) line(t.label.toUpperCase(), t.amountCents, bold, { rule: true, double: true });
  }

  const pages = pdf.getPages();
  pages.forEach((p, i) => p.drawText(safe(`${firm} • Confidential • Page ${i + 1} of ${pages.length}`), { x: 36, y: 22, size: 7.5, font: italic, color: GRAY }));
  return { pdf: await pdf.save(), filename: safe(`${name} Financial Statements ${MONTH_NAMES[months[0].m - 1].slice(0, 3)}-${MONTH_NAMES[month - 1].slice(0, 3)} ${year}.pdf`).replace(/[^\w.\- ()]/g, "_"), periodText };
}
