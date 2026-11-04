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

/** General ledger detail: date, account, description, debit, credit. No memos' internal notes, no reasons, no sources. */
async function buildGL(sc: Scope) {
  const lines = await prisma.journalLine.findMany({
    where: { entry: { clientId: sc.clientId, date: { gte: D(sc.from), lte: D(sc.to) }, basis: basisIn(sc.basis) } },
    select: { debitCents: true, creditCents: true, description: true, account: { select: { code: true, name: true, subtype: true } }, entry: { select: { date: true, memo: true } } },
    orderBy: [{ account: { code: "asc" } }, { entry: { date: "asc" } }],
  });
  const rows = lines.map((l) => ({ date: l.entry.date.toISOString().slice(0, 10), account: `${l.account.code} ${accountName(l.account)}`, description: clientText(l.description, clientText(l.entry.memo, "Journal entry")), debitCents: l.debitCents, creditCents: l.creditCents }));
  return { kind: "GL" as const, title: "General Ledger", period: sc.glPeriod, basis: sc.basis === "CASH" ? "Cash Basis" : "Accrual Basis", interim: sc.interim, rows, clientId: sc.clientId, fileTag: sc.fileTag };
}

export const clientProfitAndLoss = async (periodId: string) => buildPL(await monthScope(periodId));
export const clientBalanceSheet = async (periodId: string) => buildBS(await monthScope(periodId));
export const clientGeneralLedger = async (periodId: string) => buildGL(await monthScope(periodId));
export const interimProfitAndLoss = async (interimId: string) => buildPL(await interimScope(interimId));
export const interimBalanceSheet = async (interimId: string) => buildBS(await interimScope(interimId));

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
  let page: PDFPage = pdf.addPage([612, 792]);
  let y = 740;
  const center = (t: string, size: number, f: PDFFont, color = NAVY) => { const x = (612 - f.widthOfTextAtSize(safe(t), size)) / 2; page.drawText(safe(t), { x, y, size, font: f, color }); y -= size + 6; };
  const header = () => { y = 740; center(name, 16, bold); center(s.title, 13, bold); center(s.period, 10, font, GRAY); center(s.basis, 10, font, GRAY); if (s.interim) center(s.interim, 10.5, bold, rgb(0.55, 0.35, 0.05)); y -= 10; };
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
