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
import { ensureGlLink, enterStatementBalances, prepareReconciliation } from "./bank-accounts";
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
  | { ok: true; read: number; added: number; duplicates: number; beginningCents: number; endingCents: number; via: "PDF" | "COETHA"; periodStart: string | null }
  | { ok: false; read: number; problems: string[] };

export async function readStatementTransactions(actor: Actor, clientId: string, documentId: string): Promise<StatementReadResult> {
  await assertLedger(actor, clientId, "banking", "edit");
  const doc = await prisma.document.findFirst({
    where: { id: documentId, clientId, deletedAt: null, docType: { in: STATEMENT_DOC_TYPES } },
    include: { file: true, bookkeepingAccount: true, manualBankAccount: true },
  });
  if (!doc?.file) throw new ValidationError("Statement not found.");
  if (doc.scanStatus === "INFECTED") throw new ValidationError("This file failed the malware scan and can't be read.");
  let ledgerAccountId = doc.bookkeepingAccount?.ledgerAccountId ?? doc.manualBankAccount?.ledgerAccountId ?? null;
  // A registered account without a GL account (e.g. registered before the books were set up) is linked now.
  if (!ledgerAccountId && doc.bookkeepingAccount) ledgerAccountId = await ensureGlLink(clientId, doc.bookkeepingAccount.id, actor.id);
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
  return { ok: true, read: txns.length, added: imp.added, duplicates: imp.duplicates, beginningCents: parsed.summary.beginningCents!, endingCents: parsed.summary.endingCents!, via, periodStart: parsed.summary.periodStart };
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

/**
 * Reads every statement already on file for one registered account, oldest month first (nothing
 * is uploaded again; rows already imported are skipped). Optionally posts the books' opening cash
 * from the earliest statement's beginning balance, when the books have no opening entry yet.
 */
export async function readStatementsOnFile(actor: Actor, clientId: string, registryId: string, opts: { postOpening?: boolean } = {}) {
  await assertLedger(actor, clientId, "banking", "edit");
  const docs = await prisma.document.findMany({
    where: { clientId, deletedAt: null, bookkeepingAccountId: registryId, docType: { in: STATEMENT_DOC_TYPES } },
    orderBy: [{ year: "asc" }, { month: "asc" }, { createdAt: "desc" }],
    select: { id: true, year: true, month: true, title: true },
  });
  // The newest file for each month.
  const seen = new Set<string>();
  const months = docs.filter((d) => { const k = `${d.year}-${d.month}`; if (seen.has(k)) return false; seen.add(k); return true; });
  const results: { month: string; title: string; ok: boolean; message: string; added: number; beginningCents?: number; endingCents?: number; periodStart?: string | null }[] = [];
  for (const d of months) {
    const month = d.year && d.month ? `${d.year}-${String(d.month).padStart(2, "0")}` : "no month";
    try {
      const r = await readStatementTransactions(actor, clientId, d.id);
      results.push({ month, title: d.title, ok: r.ok, message: statementReadMessage(r), added: r.ok ? r.added : 0, ...(r.ok ? { beginningCents: r.beginningCents, endingCents: r.endingCents, periodStart: r.periodStart } : {}) });
    } catch (err) {
      if (!(err instanceof ValidationError)) throw err;
      results.push({ month, title: d.title, ok: false, message: err.message, added: 0 });
    }
  }
  let opening: string | null = null;
  const first = results.find((r) => r.ok && r.periodStart && r.beginningCents != null);
  if (opts.postOpening && first) {
    const book = await prisma.ledgerBook.findUnique({ where: { clientId } });
    const lid = (await prisma.bookkeepingAccount.findUnique({ where: { id: registryId }, select: { ledgerAccountId: true } }))?.ledgerAccountId;
    if (book && !book.openingDate && lid) {
      const { postOpeningBalances } = await import("./ledger");
      await postOpeningBalances(actor, clientId, { date: first.periodStart!, balances: [{ accountId: lid, amount: (first.beginningCents! / 100).toFixed(2) }] });
      opening = `Opening cash ${usd(first.beginningCents!)} posted on ${first.periodStart} (the ${first.month} statement's beginning balance).`;
    } else if (book?.openingDate) opening = "Opening balances were already posted, so none was added.";
  }
  await audit(prisma, { actorId: actor.id, action: "bookkeeping.statements_reread", entityType: "BookkeepingAccount", entityId: registryId, clientId, details: { months: results.map((r) => ({ month: r.month, ok: r.ok, added: r.added })), opening: !!opening } });
  return { results, opening };
}

/** The account's last 4 digits as printed on a statement ("ACCOUNT # 0361359432" → "9432"). */
export function statementLast4(lines: string[]): string | null {
  for (const l of lines) {
    const m = /\b(?:account|acct)\b[^0-9]{0,25}([0-9][0-9 -]{3,24}[0-9])/i.exec(l);
    if (m) { const d = m[1].replace(/\D/g, ""); if (d.length >= 4) return d.slice(-4); }
  }
  return null;
}

/**
 * "Upload bank statements": one or more statement PDFs, no account or month to choose. For each file
 * the account is found from the last 4 digits printed on it (or the business's only registered
 * account) and the month from the statement period; it's filed there and its transactions are
 * imported when they reconcile to the cent. A statement for an account that isn't registered to this
 * business is refused, never filed. Optionally the books' opening cash is taken from the earliest
 * statement when no opening balance is posted yet.
 */
export async function uploadStatementsAuto(actor: Actor, clientId: string, files: { bytes: Uint8Array; originalName: string }[], opts: { postOpening?: boolean } = {}) {
  await assertLedger(actor, clientId, "banking", "edit");
  if (!files.length) throw new ValidationError("Choose the statement files.");
  if (files.length > 24) throw new ValidationError("Upload up to 24 statements at a time.");
  const accounts = await prisma.bookkeepingAccount.findMany({ where: { clientId, active: true, parentAccountId: null } });
  const { staffUploadStatement } = await import("./client-requests");
  const results: { file: string; ok: boolean; month?: string; account?: string; message: string; periodStart?: string | null; beginningCents?: number; registryId?: string }[] = [];
  for (const f of files) {
    if (!/\.pdf$/i.test(f.originalName)) { results.push({ file: f.originalName, ok: false, message: "Only statement PDFs can be read here. Use Import CSV in Books & Ledger for a CSV file." }); continue; }
    const lines = await pdfLines(f.bytes).catch(() => null);
    if (!lines?.length) { results.push({ file: f.originalName, ok: false, message: "This looks like a scanned image, so it can't be read yet. Nothing was filed." }); continue; }
    const parsed = parseStatementLines(lines);
    const end = parsed.summary.periodEnd;
    if (!end) { results.push({ file: f.originalName, ok: false, message: "The statement period couldn't be found on it. Use “Choose the account and month myself.” Nothing was filed." }); continue; }
    const last4 = statementLast4(lines);
    const byLast4 = last4 ? accounts.filter((a) => a.last4 === last4) : [];
    const acct = byLast4.length === 1 ? byLast4[0] : !last4 && accounts.length === 1 ? accounts[0] : null;
    if (!acct) {
      results.push({ file: f.originalName, ok: false, message: last4 ? `It's for an account ending ${last4}, which isn't registered for this business. Nothing was filed.` : "Which account it belongs to couldn't be told. Use “Choose the account and month myself.” Nothing was filed." });
      continue;
    }
    const month = end.slice(0, 7);
    const doc = await staffUploadStatement(actor, clientId, { accountId: acct.id, month, bytes: f.bytes, originalName: f.originalName });
    try {
      const r = await readStatementTransactions(actor, clientId, doc.id);
      results.push({ file: f.originalName, ok: r.ok, month, account: acct.last4 ? `••${acct.last4}` : acct.institution, message: r.ok ? `${r.added} transaction${r.added === 1 ? "" : "s"} added${r.duplicates ? ` (${r.duplicates} already in)` : ""}, matches the statement to the cent` : `filed, but not imported: ${r.problems.slice(0, 1).join(" ")}`, ...(r.ok ? { periodStart: r.periodStart, beginningCents: r.beginningCents, registryId: acct.id } : {}) });
    } catch (err) {
      if (!(err instanceof ValidationError)) throw err;
      results.push({ file: f.originalName, ok: false, month, account: acct.last4 ? `••${acct.last4}` : acct.institution, message: `filed, but not imported: ${err.message}` });
    }
  }
  let opening: string | null = null;
  if (opts.postOpening) {
    const first = results.filter((r) => r.ok && r.periodStart && r.beginningCents != null).sort((a, b) => a.periodStart!.localeCompare(b.periodStart!))[0];
    const book = await prisma.ledgerBook.findUnique({ where: { clientId } });
    if (first && book && !book.openingDate) {
      const lid = (await prisma.bookkeepingAccount.findUnique({ where: { id: first.registryId! }, select: { ledgerAccountId: true } }))?.ledgerAccountId;
      if (lid) {
        const { postOpeningBalances } = await import("./ledger");
        await postOpeningBalances(actor, clientId, { date: first.periodStart!, balances: [{ accountId: lid, amount: (first.beginningCents! / 100).toFixed(2) }] });
        opening = `Opening cash ${usd(first.beginningCents!)} posted on ${first.periodStart} from the ${first.month} statement.`;
      }
    } else if (book?.openingDate) opening = "Opening balances were already posted, so none was added.";
  }
  await audit(prisma, { actorId: actor.id, action: "bookkeeping.statements_uploaded_auto", entityType: "LedgerBook", entityId: clientId, clientId, details: { files: results.map((r) => ({ month: r.month ?? null, ok: r.ok })), opening: !!opening } });
  return { results: results.map(({ periodStart: _p, beginningCents: _b, registryId: _r, ...r }) => r), opening };
}
