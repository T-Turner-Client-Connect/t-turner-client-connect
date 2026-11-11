import "server-only";
import { prisma } from "@/lib/prisma";
import { audit } from "@/lib/audit";
import type { Actor } from "@/lib/auth/actor";
import { ValidationError } from "./clients";
import { assertLedger, usd } from "./ledger";
import { booksStatements, clientStatementPdf } from "./client-statements";
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
  const net = pl.totals.find((t) => t.label === "Net Income")?.amountCents ?? 0;
  const sec = (title: string) => bs.sections.find((x) => x.title === title)?.totalCents ?? 0;
  const checklist = await monthlyChecklist(clientId, y, m);
  const open = checklist.items.filter((i) => i.state === "MISSING" || i.state === "IN_PROGRESS").filter((i) => !["PREPARED", "APPROVAL", "RELEASED"].includes(i.key)).map((i) => `${i.label}: ${i.detail}`);
  await audit(prisma, { actorId: actor.id, action: "coetha.statements_prepared", entityType: "Client", entityId: clientId, clientId, details: { month: ym, saved, openItems: open.length } });
  return {
    month: ym,
    saved: saved.map((s) => `${s.reportType === "PROFIT_AND_LOSS" ? "Profit & Loss" : "Balance Sheet"} v${s.version} (draft, staff-only${s.unchanged ? "; unchanged since the last draft" : ""})`),
    figures: {
      income: usd(pl.sections.find((x) => x.title === "Income")?.totalCents ?? 0),
      expenses: usd(pl.sections.find((x) => x.title === "Expenses")?.totalCents ?? 0),
      netIncome: usd(net),
      totalAssets: usd(sec("Assets")),
      totalLiabilities: usd(sec("Liabilities")),
      totalEquity: usd(sec("Equity")),
    },
    stillOpenThisMonth: open,
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
