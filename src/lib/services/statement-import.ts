import "server-only";
import { prisma } from "@/lib/prisma";
import { audit } from "@/lib/audit";
import { ForbiddenError, type Actor } from "@/lib/auth/actor";
import { checkStatement, parseStatementLines, pdfLines, type StatementTxn } from "@/lib/statement-pdf";
import { callStatementReader, CoethaModelError, coethaKeyPresent } from "@/lib/coetha-model";
import { ValidationError } from "./clients";
import { assertLedger, importBankCsv, usd } from "./ledger";
import { readDocumentBytes } from "./documents";
import { coethaOn } from "./owner-switches";
import { coethaOptOutView } from "./coetha-opt-out";
import { scrub } from "./coetha";
import { enterStatementBalances, prepareReconciliation } from "./bank-accounts";
import { STATEMENT_DOC_TYPES } from "./client-request-scope";

/**
 * Reads the transactions printed on a bank or card statement PDF that's on file, and imports them
 * into that account's bank transactions, exactly as a CSV import would (rows already imported are
 * skipped; nothing is posted until staff review it).
 *
 * Nothing is imported unless the statement reconciles to the cent: beginning balance + every
 * transaction read = ending balance, and each section matches the total the statement prints.
 *
 * The statement is read inside Client Connect. Only when its layout isn't recognized, and Coetha is
 * on for this client, the transaction lines (names, addresses and account numbers removed) are
 * sent to Claude to list, and the same to-the-cent check applies to what comes back.
 */

export type StatementReadResult =
  | { ok: true; read: number; added: number; duplicates: number; beginningCents: number; endingCents: number; via: "PDF" | "COETHA" }
  | { ok: false; read: number; problems: string[] };

export async function readStatementTransactions(actor: Actor, clientId: string, documentId: string): Promise<StatementReadResult> {
  await assertLedger(actor, clientId, "banking", "edit");
  const doc = await prisma.document.findFirst({
    where: { id: documentId, clientId, deletedAt: null, docType: { in: STATEMENT_DOC_TYPES } },
    include: { file: true, bookkeepingAccount: true, manualBankAccount: true },
  });
  if (!doc?.file) throw new ValidationError("Statement not found.");
  if (doc.scanStatus === "INFECTED") throw new ValidationError("This file failed the malware scan and can't be read.");
  const ledgerAccountId = doc.bookkeepingAccount?.ledgerAccountId ?? doc.manualBankAccount?.ledgerAccountId ?? null;
  if (!ledgerAccountId) throw new ValidationError("Link this account to its General Ledger account first (Banking → Manage Accounts).");
  const ledger = await prisma.ledgerAccount.findFirst({ where: { id: ledgerAccountId, clientId } });
  if (!ledger) throw new ValidationError("This account's General Ledger account wasn't found.");
  const liability = ledger.subtype === "CREDIT_CARD";

  const bytes = await readDocumentBytes(doc.file);
  if (!bytes) throw new ValidationError("The statement file couldn't be opened.");
  const lines = await pdfLines(bytes);
  if (!lines?.length) throw new ValidationError("No text could be read from this PDF. If it's a scanned image, ask the bank for the electronic statement or import a CSV.");

  const parsed = parseStatementLines(lines, { liability });
  let txns: StatementTxn[] = parsed.transactions;
  let check = parsed.check;
  let via: "PDF" | "COETHA" = "PDF";

  // Layout not recognized: Coetha lists the transactions (only if she's allowed to work on this client).
  if (!check.ok && (await coethaOn()) && coethaKeyPresent() && !(await coethaOptOutView(clientId))) {
    const first = lines.findIndex((l) => /deposit|withdrawal|debit|credit|check|purchase|payment|fee/i.test(l) && !/balance/i.test(l));
    const body = lines.slice(Math.max(0, first)).map((l) => scrub(l, 300)).filter(Boolean).slice(0, 1500);
    const period = parsed.summary.periodStart && parsed.summary.periodEnd ? `${parsed.summary.periodStart} to ${parsed.summary.periodEnd}` : null;
    try {
      const res = await callStatementReader(body, period);
      const fromModel = res.output.transactions
        .filter((t) => /^\d{4}-\d{2}-\d{2}$/.test(t.date) && Number.isFinite(t.amount) && t.amount !== 0)
        .map((t) => ({ date: t.date, description: t.description.slice(0, 200) || "Transaction", amountCents: Math.round(t.amount * 100), section: t.section }));
      const summary = { ...parsed.summary };
      // Balances read from the PDF itself win; the model's are used only when the PDF's weren't found.
      if (summary.beginningCents == null && res.output.beginningBalance != null) summary.beginningCents = Math.round(res.output.beginningBalance * 100);
      if (summary.endingCents == null && res.output.endingBalance != null) summary.endingCents = Math.round(res.output.endingBalance * 100);
      const c = checkStatement({ ...summary, totals: {} }, fromModel, {}, { liability });
      await audit(prisma, { actorId: actor.id, action: "bookkeeping.statement_read_coetha", entityType: "Document", entityId: doc.id, clientId, details: { model: res.model, read: fromModel.length, ok: c.ok, inputTokens: res.inputTokens, outputTokens: res.outputTokens } });
      if (c.ok) { txns = fromModel; check = c; via = "COETHA"; parsed.summary.beginningCents = summary.beginningCents; parsed.summary.endingCents = summary.endingCents; }
    } catch (err) {
      if (!(err instanceof CoethaModelError)) throw err;
    }
  }

  if (!check.ok) {
    await audit(prisma, { actorId: actor.id, action: "bookkeeping.statement_read_failed", entityType: "Document", entityId: doc.id, clientId, details: { read: txns.length, problems: check.problems.slice(0, 5) } });
    return { ok: false, read: txns.length, problems: check.problems };
  }

  // Plain CSV for the importer (negative amounts stay as numbers; descriptions quoted).
  const q = (v: string) => `"${v.replace(/"/g, '""')}"`;
  const csv = ["Date,Description,Amount", ...txns.map((t) => `${t.date.slice(5, 7)}/${t.date.slice(8, 10)}/${t.date.slice(0, 4)},${q(t.description)},${(t.amountCents / 100).toFixed(2)}`)].join("\n");
  const imp = await importBankCsv(actor, clientId, ledger.id, { fileName: `${doc.title} (read from PDF)`.slice(0, 200), text: csv });

  // The statement's balances fill in this month's reconciliation (unless staff already entered them).
  const registry = doc.bookkeepingAccount ?? (await prisma.bookkeepingAccount.findFirst({ where: { clientId, ledgerAccountId: ledger.id, parentAccountId: null } }));
  if (registry && doc.year && doc.month) {
    const rec = await prisma.accountReconciliation.findUnique({ where: { bookkeepingAccountId_year_month: { bookkeepingAccountId: registry.id, year: doc.year, month: doc.month } } });
    if (rec?.status !== "APPROVED") {
      if (rec?.endingBalanceCents == null || rec.beginningBalanceCents == null) {
        await enterStatementBalances(actor, clientId, registry.id, doc.year, doc.month, { beginning: (parsed.summary.beginningCents! / 100).toFixed(2), ending: (parsed.summary.endingCents! / 100).toFixed(2) }).catch(() => prepareReconciliation(clientId, registry.id, doc.year!, doc.month!, { preparedById: actor.id }));
      } else {
        await prepareReconciliation(clientId, registry.id, doc.year, doc.month, { preparedById: actor.id });
      }
    }
  }
  await audit(prisma, { actorId: actor.id, action: "bookkeeping.statement_read", entityType: "Document", entityId: doc.id, clientId, details: { via, read: txns.length, added: imp.added, duplicates: imp.duplicates, importId: imp.id } });
  return { ok: true, read: txns.length, added: imp.added, duplicates: imp.duplicates, beginningCents: parsed.summary.beginningCents!, endingCents: parsed.summary.endingCents!, via };
}

/** One line for the person who uploaded or pressed "Read transactions". */
export function statementReadMessage(r: StatementReadResult): string {
  if (!r.ok) return `The statement was filed, but its transactions couldn't be read reliably, so none were imported: ${r.problems.slice(0, 2).join(" ")} Import the month's CSV from the bank instead.`;
  const dup = r.duplicates ? ` ${r.duplicates} were already in the books and were skipped.` : "";
  return `Read ${r.read} transaction${r.read === 1 ? "" : "s"} from the statement (they match its ${usd(r.beginningCents)} beginning and ${usd(r.endingCents)} ending balance to the cent) and added ${r.added} for review.${dup} Nothing was posted.`;
}

/** The newest statement PDF on file for a registered account and month (for the "Read transactions" button). */
export async function statementOnFile(clientId: string, bookkeepingAccountId: string, year: number, month: number) {
  return prisma.document.findFirst({ where: { clientId, deletedAt: null, bookkeepingAccountId, docType: { in: STATEMENT_DOC_TYPES }, year, month }, orderBy: { createdAt: "desc" }, select: { id: true, title: true } });
}

/**
 * Runs right after a statement PDF is uploaded or filed: reads its transactions when it can.
 * Never fails the upload itself; returns a sentence to add to the upload's confirmation.
 */
export async function readAfterUpload(actor: Actor, clientId: string, documentId: string): Promise<string> {
  try {
    return statementReadMessage(await readStatementTransactions(actor, clientId, documentId));
  } catch (err) {
    if (err instanceof ValidationError) return `Its transactions weren't read: ${err.message}`;
    if (err instanceof ForbiddenError) return "";
    console.error("Statement read failed:", err instanceof Error ? err.name : "unknown error");
    return "Its transactions couldn't be read automatically; use “Read transactions from statement” on the reconciliation page to try again.";
  }
}
