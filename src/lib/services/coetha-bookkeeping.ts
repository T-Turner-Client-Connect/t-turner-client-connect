import "server-only";
import { prisma } from "@/lib/prisma";
import { audit } from "@/lib/audit";
import { ForbiddenError, type Actor } from "@/lib/auth/actor";
import { parseStatementLines, pdfLines } from "@/lib/statement-pdf";
import { ValidationError } from "./clients";
import { excludeBankTransaction, usd, ymdOf } from "./ledger";
import { readDocumentBytes } from "./documents";
import { prepareReconciliation, statementWindow } from "./bank-accounts";
import { STATEMENT_DOC_TYPES } from "./client-request-scope";

/**
 * Coetha's bookkeeping tools for a whole assignment ("complete Parrish's September books"):
 *
 * - remove_verified_duplicates: a bank row is a duplicate ONLY when the bank's own statement on
 *   file (read to the cent) shows that date and amount fewer times than the books have it. Repeated
 *   descriptions, or the same amount on different days, are never duplicates. Verified extras are
 *   excluded (never deleted) with the reason and an audit entry; anything that can't be verified
 *   against a statement is reported as an exception and left alone.
 * - reconcile_accounts: reads the statements already on file for the month (rows already imported
 *   are skipped), fills in the balances and prepares each account's reconciliation. The difference
 *   is reported as it is; nothing is ever forced to balance, and only Tabitha approves.
 *
 * Both run for ONE business, as the person asking (banking edit access is required).
 */

const monthOf = (raw: unknown) => {
  const m = typeof raw === "string" ? /^(\d{4})-(0[1-9]|1[0-2])$/.exec(raw.trim()) : null;
  if (!m) throw new ValidationError("Give the month as YYYY-MM.");
  return { year: Number(m[1]), month: Number(m[2]) };
};

/** The newest statement PDF on file for a registered account and month, read and checked to the cent. */
async function statementRows(clientId: string, registryId: string, year: number, month: number, liability: boolean) {
  const doc = await prisma.document.findFirst({ where: { clientId, deletedAt: null, bookkeepingAccountId: registryId, docType: { in: STATEMENT_DOC_TYPES }, year, month }, orderBy: { createdAt: "desc" }, include: { file: true } });
  if (!doc?.file) return { ok: false as const, why: "no statement on file for this month" };
  const bytes = await readDocumentBytes(doc.file);
  const lines = bytes ? await pdfLines(bytes) : null;
  if (!lines?.length) return { ok: false as const, why: `the statement “${doc.title}” has no readable text` };
  const parsed = parseStatementLines(lines, { liability });
  if (!parsed.check.ok) return { ok: false as const, why: `the statement “${doc.title}” couldn't be read to the cent (${parsed.check.problems[0] ?? "it doesn't reconcile"})` };
  return { ok: true as const, title: doc.title, rows: parsed.transactions, periodStart: parsed.summary.periodStart, periodEnd: parsed.summary.periodEnd };
}

type Dup = { txnId: string; date: string; amount: string; description: string; account: string; statementCount: number; booksCount: number };

/** Finds (and, unless dryRun, excludes) bank rows the statement on file proves are duplicate imports. */
export async function removeVerifiedDuplicates(actor: Actor, clientId: string, input: { month: string; dryRun?: boolean }) {
  const { year, month } = monthOf(input.month);
  const accounts = await prisma.bookkeepingAccount.findMany({ where: { clientId, parentAccountId: null, ledgerAccountId: { not: null }, active: true } });
  const removed: Dup[] = [];
  const unverified: { account: string; why: string }[] = [];
  for (const a of accounts) {
    const label = `${a.institution}${a.nickname ? ` ${a.nickname}` : ""}${a.last4 ? ` ••${a.last4}` : ""}`;
    const liability = ["CREDIT_CARD", "LINE_OF_CREDIT", "LOAN"].includes(a.accountType);
    const st = await statementRows(clientId, a.id, year, month, liability);
    const w = statementWindow(year, month, a.statementDay);
    const from = st.ok && st.periodStart ? st.periodStart : w.start, to = st.ok && st.periodEnd ? st.periodEnd : w.end;
    const rows = await prisma.bankTransaction.findMany({ where: { clientId, accountId: a.ledgerAccountId!, status: { not: "EXCLUDED" }, date: { gte: new Date(`${from}T00:00:00Z`), lte: new Date(`${to}T00:00:00Z`) } }, orderBy: [{ createdAt: "asc" }] });
    if (!rows.length) continue;
    if (!st.ok) {
      // Possible duplicates can't be confirmed without the statement: reported, never excluded.
      const groups = new Map<string, number>();
      for (const r of rows) groups.set(`${ymdOf(r.date)}|${r.amountCents}`, (groups.get(`${ymdOf(r.date)}|${r.amountCents}`) ?? 0) + 1);
      if ([...groups.values()].some((n) => n > 1)) unverified.push({ account: label, why: `${st.why}, so repeated rows can't be confirmed as duplicates` });
      continue;
    }
    const onStatement = new Map<string, number>();
    for (const t of st.rows) onStatement.set(`${t.date}|${t.amountCents}`, (onStatement.get(`${t.date}|${t.amountCents}`) ?? 0) + 1);
    const inBooks = new Map<string, typeof rows>();
    for (const r of rows) {
      const k = `${ymdOf(r.date)}|${r.amountCents}`;
      inBooks.set(k, [...(inBooks.get(k) ?? []), r]);
    }
    for (const [k, list] of inBooks) {
      const allowed = onStatement.get(k) ?? null;
      // A row the statement doesn't show at all isn't a "duplicate": it's an exception for a person.
      if (allowed == null || list.length <= allowed) continue;
      // Keep the posted rows and the earliest imports; the extra unreviewed ones are the duplicates.
      const keep = [...list].sort((x, y) => (x.status === "POSTED" ? -1 : 0) - (y.status === "POSTED" ? -1 : 0));
      const extras = keep.slice(allowed).filter((r) => r.status === "UNREVIEWED");
      for (const r of extras) {
        const d: Dup = { txnId: r.id, date: ymdOf(r.date), amount: usd(r.amountCents), description: r.description.slice(0, 60), account: label, statementCount: allowed, booksCount: list.length };
        if (!input.dryRun) {
          await excludeBankTransaction(actor, clientId, r.id, `Duplicate import: the ${st.title} shows ${d.amount} on ${d.date} ${allowed} time${allowed === 1 ? "" : "s"}; the books had it ${list.length} times`);
          await audit(prisma, { actorId: actor.id, action: "coetha.duplicate_excluded", entityType: "BankTransaction", entityId: r.id, clientId, details: { date: d.date, amountCents: r.amountCents, statement: st.title, statementCount: allowed, booksCount: list.length } });
        }
        removed.push(d);
      }
    }
  }
  return { month: input.month, removed, unverified, dryRun: !!input.dryRun };
}

/** Reads the month's statements on file into the books and prepares each account's reconciliation. Never forces a balance. */
export async function reconcileAccounts(actor: Actor, clientId: string, input: { month: string }) {
  const { year, month } = monthOf(input.month);
  const accounts = await prisma.bookkeepingAccount.findMany({ where: { clientId, parentAccountId: null, active: true } });
  const { readStatementTransactions, statementReadMessage, statementOnFile } = await import("./statement-import");
  const out = [];
  for (const a of accounts) {
    const label = `${a.institution}${a.nickname ? ` ${a.nickname}` : ""}${a.last4 ? ` ••${a.last4}` : ""}`;
    const doc = await statementOnFile(clientId, a.id, year, month);
    let statement = "No statement on file for this month.";
    if (doc) {
      try { statement = statementReadMessage(await readStatementTransactions(actor, clientId, doc.id)); } catch (err) { statement = err instanceof Error ? err.message : "The statement couldn't be read."; }
    }
    const rec = await prepareReconciliation(clientId, a.id, year, month, { preparedById: actor.id });
    if (!rec) continue;
    out.push({ account: label, statement, status: rec.status, beginning: rec.beginningBalanceCents != null ? usd(rec.beginningBalanceCents) : null, ending: rec.endingBalanceCents != null ? usd(rec.endingBalanceCents) : null, difference: rec.differenceCents != null ? usd(rec.differenceCents) : null, unmatched: rec.unmatchedCount, exceptions: rec.exceptions });
  }
  return { month: input.month, accounts: out, note: "Differences are reported as they are; nothing was forced to balance. Approval is Tabitha's." };
}

export const DUPLICATES_TOOL = {
  name: "remove_verified_duplicates",
  description: "Remove duplicate bank-row imports for one month, verified against the bank's own statement on file: a row is excluded only when the statement (read to the cent) shows that date and amount fewer times than the books have it. Repeated descriptions or amounts on different days are never treated as duplicates. Excluded rows stay visible with the reason (never deleted). Returns what was excluded and any account where duplicates couldn't be verified (no readable statement). Run it before posting a month.",
  input_schema: { type: "object" as const, properties: { month: { type: "string", description: "YYYY-MM" }, dryRun: { type: "boolean", description: "true: only list what would be excluded" } }, required: ["month"] },
};

export const RECONCILE_TOOL = {
  name: "reconcile_accounts",
  description: "For one month: read every bank and card statement already on file into the books (rows already imported are skipped), fill in the statement balances and prepare each account's reconciliation. Returns each account's status, balances, difference and exceptions. Never forces a difference to zero and never approves; report any difference as an exception.",
  input_schema: { type: "object" as const, properties: { month: { type: "string", description: "YYYY-MM" } }, required: ["month"] },
};

export async function runBookkeepingTool(actor: Actor, clientId: string, name: string, input: unknown) {
  const i = (input && typeof input === "object" ? input : {}) as { month?: string; dryRun?: boolean };
  try {
    if (name === DUPLICATES_TOOL.name) return await removeVerifiedDuplicates(actor, clientId, { month: String(i.month ?? ""), dryRun: !!i.dryRun });
    return await reconcileAccounts(actor, clientId, { month: String(i.month ?? "") });
  } catch (err) {
    return { error: err instanceof ForbiddenError || err instanceof ValidationError ? err.message : "That couldn't be completed." };
  }
}
