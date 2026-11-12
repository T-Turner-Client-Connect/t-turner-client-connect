import "server-only";
import { prisma } from "@/lib/prisma";
import { audit } from "@/lib/audit";
import type { Actor } from "@/lib/auth/actor";
import { ValidationError } from "./clients";
import { assertLedger, usd } from "./ledger";
import { booksPackagePdf, booksStatements, clientStatementPdf } from "./client-statements";
import { uploadMonthlyReport } from "./bookkeeping-clients";
import { monthlyChecklist } from "./monthly-workflow";

/**
 * Coetha prepares a month's Profit & Loss and Balance Sheet from the books: both are built from the
 * ledger (no typed figures), saved as staff-only drafts on the business's Statements page (a new
 * version when the month already has one), and wait for Tabitha's approval. Nothing is released.
 * The "Financial statements prepared" checklist line then shows them.
 */
export async function prepareStatementsFromBooks(actor: Actor, clientId: string, ym: string) {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(ym)) throw new ValidationError("Give the month as YYYY-MM.");
  await assertLedger(actor, clientId);
  const [y, m] = ym.split("-").map(Number);
  const { pl, bs, basis } = await booksStatements(clientId, y, m);
  const saved = [];
  for (const [s, reportType, file] of [[pl, "PROFIT_AND_LOSS", `profit-and-loss-${ym}.pdf`], [bs, "BALANCE_SHEET", `balance-sheet-${ym}.pdf`]] as const) {
    const { pdf: bytes } = await clientStatementPdf(s);
    try {
      const r = await uploadMonthlyReport(actor, { clientId, year: y, month: m, reportType, periodType: "MONTH", basis, bytes, originalName: file });
      saved.push({ reportType, version: r.version, documentId: r.document.id, unchanged: false });
    } catch (err) {
      // Nothing changed in the books since the last draft: the same statement is already saved.
      if (!(err instanceof ValidationError) || !/already saved/.test(err.message)) throw err;
      const cur = await prisma.document.findFirst({ where: { clientId, reportType, year: y, month: m, deletedAt: null, supersededAt: null }, orderBy: { createdAt: "desc" }, select: { id: true, version: true } });
      saved.push({ reportType, version: cur?.version ?? 1, documentId: cur?.id ?? "", unchanged: true });
    }
  }
  // The Financial Statements Package (cover, monthly P&L with YTD, Balance Sheet) in the firm's layout.
  {
    const { pdf: bytes } = await booksPackagePdf(clientId, y, m, { draft: true });
    try {
      const r = await uploadMonthlyReport(actor, { clientId, year: y, month: m, reportType: "FINANCIAL_PACKET", periodType: "MONTH", basis, bytes, originalName: `financial-statements-${ym}.pdf` });
      saved.push({ reportType: "FINANCIAL_PACKET", version: r.version, documentId: r.document.id, unchanged: false });
    } catch (err) {
      if (!(err instanceof ValidationError) || !/already saved/.test(err.message)) throw err;
      saved.push({ reportType: "FINANCIAL_PACKET", version: 0, documentId: "", unchanged: true });
    }
  }
  const net = pl.totals.find((t) => t.label === "Net Income")?.amountCents ?? 0;
  const sec = (title: string) => bs.sections.find((x) => x.title === title)?.totalCents ?? 0;
  const checklist = await monthlyChecklist(clientId, y, m);
  const open = checklist.items.filter((i) => i.state === "MISSING" || i.state === "IN_PROGRESS").filter((i) => !["PREPARED", "APPROVAL", "RELEASED"].includes(i.key)).map((i) => `${i.label}: ${i.detail}`);
  await audit(prisma, { actorId: actor.id, action: "coetha.statements_prepared", entityType: "Client", entityId: clientId, clientId, details: { month: ym, saved, openItems: open.length } });
  return {
    month: ym,
    saved: saved.filter((s) => s.version > 0 || !s.unchanged).map((s) => `${s.reportType === "PROFIT_AND_LOSS" ? "Profit & Loss" : s.reportType === "BALANCE_SHEET" ? "Balance Sheet" : "Financial Statements Package"} v${s.version} (draft, staff-only${s.unchanged ? "; unchanged since the last draft" : ""})`),
    figures: {
      income: usd(pl.sections.find((x) => x.title === "Income")?.totalCents ?? 0),
      expenses: usd(pl.sections.find((x) => x.title === "Expenses")?.totalCents ?? 0),
      netIncome: usd(net),
      totalAssets: usd(sec("Assets")),
      totalLiabilities: usd(sec("Liabilities")),
      totalEquity: usd(sec("Equity")),
    },
    stillOpenThisMonth: open,
    package: "The Financial Statements Package (cover with the firm's logo, contents, P&L and Balance Sheet) is on the Statements page: \"Financial Statements Package (PDF)\".",
    note: "Saved as drafts on the Statements page for Tabitha's review; nothing was released to the client. If entries change, prepare them again (a new version replaces the draft).",
  };
}

export const STATEMENTS_TOOL = {
  name: "prepare_financial_statements",
  description: "Build this business's Profit & Loss and Balance Sheet for one month from the books (the ledger as posted) and save them as drafts on its Statements page for Tabitha's approval. Returns the key figures and what is still open for the month. Never releases anything. Run it again after corrections are posted to replace the drafts.",
  input_schema: { type: "object" as const, properties: { month: { type: "string", description: "YYYY-MM" } }, required: ["month"] },
};

export async function runStatementsTool(actor: Actor, clientId: string, input: unknown) {
  const month = input && typeof input === "object" ? String((input as { month?: unknown }).month ?? "") : "";
  try {
    return await prepareStatementsFromBooks(actor, clientId, month);
  } catch (err) {
    return { error: err instanceof Error && (err.name === "ForbiddenError" || err instanceof ValidationError) ? err.message : "The statements couldn't be prepared." };
  }
}

// --- Automatic monthly statements ------------------------------------------------------------------

const ymOf = (y: number, m: number) => `${y}-${String(m).padStart(2, "0")}`;
const lastOfMonth = (y: number, m: number) => new Date(Date.UTC(y, m, 0));

/**
 * The month's statements, built without anyone asking: once a month has ended, has posted entries
 * and every bank row dated in it is reviewed (nothing left to categorize), Client Connect builds the
 * P&L, Balance Sheet and Financial Statements Package from the books as drafts for Tabitha's
 * approval — the same drafts as prepare_financial_statements. When entries for the month (or
 * earlier) are posted or reversed later, it builds a new version. Never for a month Tabitha marked
 * complete, never over a packet she already approved or released, and nothing is released.
 */
export async function monthsReadyForStatements(clientId: string, today: string, lookbackMonths = 12) {
  const profile = await prisma.bookkeepingProfile.findUnique({ where: { clientId }, select: { active: true, frequency: true } });
  const book = await prisma.ledgerBook.findUnique({ where: { clientId }, select: { clientId: true } });
  if (!profile?.active || !book) return [];
  const [ty, tm] = today.split("-").map(Number);
  const out: string[] = [];
  for (let i = lookbackMonths; i >= 1; i--) {
    const d = new Date(Date.UTC(ty, tm - 1 - i, 1));
    const y = d.getUTCFullYear(), m = d.getUTCMonth() + 1;
    if (profile.frequency === "QUARTERLY" && m % 3 !== 0) continue;
    const start = new Date(Date.UTC(y, m - 1, 1)), end = lastOfMonth(y, m);
    const period = await prisma.bookkeepingPeriod.findFirst({ where: { clientId, year: y, month: m }, select: { status: true } });
    if (period?.status === "COMPLETE") continue;
    const [entries, waiting, lastChange] = await Promise.all([
      prisma.journalEntry.count({ where: { clientId, date: { gte: start, lte: end } } }),
      prisma.bankTransaction.count({ where: { clientId, date: { gte: start, lte: end }, status: "UNREVIEWED" } }),
      prisma.journalEntry.findFirst({ where: { clientId, date: { lte: end } }, orderBy: { createdAt: "desc" }, select: { createdAt: true } }),
    ]);
    if (!entries || waiting) continue;
    const packet = await prisma.document.findFirst({ where: { clientId, reportType: "FINANCIAL_PACKET", year: y, month: m, deletedAt: null, supersededAt: null }, orderBy: { createdAt: "desc" }, select: { createdAt: true, reviewStatus: true, visibility: true } });
    if (packet && (packet.reviewStatus === "APPROVED" || packet.visibility === "PUBLISHED")) continue;
    if (packet && lastChange && lastChange.createdAt <= packet.createdAt) continue;
    out.push(ymOf(y, m));
  }
  return out;
}

/** The scheduled run: every bookkeeping client, oldest months first, within a time budget. */
export async function runAutomaticStatements(opts: { today?: string; budgetMs?: number; owner?: Actor | null } = {}) {
  const today = opts.today ?? new Date().toLocaleDateString("en-CA", { timeZone: "America/Chicago" });
  const owner = opts.owner !== undefined ? opts.owner : (await prisma.ownerAccess.findFirst({ where: { isPrimary: true, revokedAt: null, user: { active: true } }, select: { user: { select: { id: true, role: true, name: true, email: true } } } }))?.user ?? null;
  if (!owner) return { built: [], skipped: "no owner" };
  const started = Date.now(), budget = opts.budgetMs ?? 20_000;
  const clients = await prisma.bookkeepingProfile.findMany({ where: { active: true, client: { archivedAt: null, ledgerBook: { isNot: null } } }, select: { clientId: true }, orderBy: { clientId: "asc" } });
  const built: { clientId: string; month: string }[] = [];
  const failed: { clientId: string; month: string; error: string }[] = [];
  for (const { clientId } of clients) {
    for (const month of await monthsReadyForStatements(clientId, today)) {
      if (Date.now() - started > budget) return { built, failed, more: true };
      try {
        await prepareStatementsFromBooks(owner as Actor, clientId, month);
        await audit(prisma, { actorId: owner.id, action: "statements.auto_prepared", entityType: "Client", entityId: clientId, clientId, details: { month } });
        built.push({ clientId, month });
      } catch (e) {
        failed.push({ clientId, month, error: e instanceof Error ? e.message.slice(0, 200) : "failed" });
      }
    }
  }
  return { built, failed, more: false };
}
