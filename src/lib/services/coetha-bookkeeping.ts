import "server-only";
import { prisma } from "@/lib/prisma";
import { audit } from "@/lib/audit";
import { ForbiddenError, type Actor } from "@/lib/auth/actor";
import { pdfLines } from "@/lib/statement-pdf";
import { ValidationError } from "./clients";
import { excludeBankTransaction, usd, ymdOf } from "./ledger";
import { readDocumentBytes } from "./documents";
import { approveReconciliation, enterStatementBalances, prepareReconciliation, statementWindow } from "./bank-accounts";

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

/**
 * The statement for a registered account and month (statement-choice.ts: unreadable files and
 * statements for another account number are skipped), read and checked to the cent.
 */
async function statementRows(clientId: string, registryId: string, year: number, month: number, liability: boolean) {
  const { chooseStatement } = await import("./statement-choice");
  const { chosen, skipped } = await chooseStatement(clientId, registryId, year, month);
  const passed = skipped.length ? ` (passed over: ${skipped.slice(0, 3).map((x) => `“${x.title}” — ${x.why}`).join("; ")})` : "";
  if (!chosen) return { ok: false as const, why: `no readable statement for this account and month is on file${passed}` };
  let rows = chosen.parsed?.transactions ?? [];
  let summary = chosen.parsed?.summary ?? null;
  if (!chosen.exact) {
    const doc = await prisma.document.findFirst({ where: { id: chosen.id, clientId }, include: { file: true } });
    const bytes = doc?.file ? await readDocumentBytes(doc.file) : null;
    const lines = bytes ? await pdfLines(bytes) : null;
    const { extractStatement } = await import("./statement-import");
    const x = lines?.length ? await extractStatement(null, clientId, chosen.id, lines, liability) : null;
    if (!x?.check.ok) return { ok: false as const, why: `the statement “${chosen.title}” couldn't be read to the cent (${x?.check.problems[0] ?? "it doesn't reconcile"})${passed}` };
    rows = x.txns; summary = x.summary;
  }
  return { ok: true as const, title: chosen.title, documentId: chosen.id, skipped, rows, periodStart: summary?.periodStart ?? null, periodEnd: summary?.periodEnd ?? null };
}

type Dup = { txnId: string; date: string; amount: string; description: string; account: string; statementCount: number; booksCount: number };

/** Finds (and, unless dryRun, excludes) bank rows the statement on file proves are duplicate imports. */
export async function removeVerifiedDuplicates(actor: Actor, clientId: string, input: { month: string; dryRun?: boolean }) {
  const { year, month } = monthOf(input.month);
  const accounts = await prisma.bookkeepingAccount.findMany({ where: { clientId, parentAccountId: null, ledgerAccountId: { not: null }, active: true } });
  const removed: Dup[] = [];
  const unverified: { account: string; why: string }[] = [];
  const statementsUsed: { account: string; statement: string; passedOver: { title: string; why: string }[] }[] = [];
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
    statementsUsed.push({ account: label, statement: st.title, passedOver: st.skipped });
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
      const extras = keep.slice(allowed);
      for (const r of extras) {
        const d: Dup = { txnId: r.id, date: ymdOf(r.date), amount: usd(r.amountCents), description: r.description.slice(0, 60), account: label, statementCount: allowed, booksCount: list.length };
        const reason = `Duplicate import: the ${st.title} shows ${d.amount} on ${d.date} ${allowed} time${allowed === 1 ? "" : "s"}; the books had it ${list.length} times`.slice(0, 200);
        if (r.status === "POSTED") {
          // A duplicate that was already posted: its entry is reversed (both stay on the books), then the row is excluded.
          const linked = r.journalEntryId ? await prisma.bankTransaction.count({ where: { clientId, journalEntryId: r.journalEntryId } }) : 0;
          if (!r.journalEntryId || linked !== 1) { unverified.push({ account: label, why: `the duplicate ${d.amount} on ${d.date} is posted in an entry shared with other rows, so it was left for review` }); continue; }
          if (!input.dryRun) {
            const rev = await reverseEntries(actor, clientId, [{ entryId: r.journalEntryId, reason }]);
            const res = rev.results[0];
            if (!res?.ok) { unverified.push({ account: label, why: `the posted duplicate ${d.amount} on ${d.date} wasn't reversed: ${res?.message ?? "unknown"}` }); continue; }
          }
        } else if (r.status !== "UNREVIEWED") continue;
        if (!input.dryRun) {
          await excludeBankTransaction(actor, clientId, r.id, reason);
          await audit(prisma, { actorId: actor.id, action: "coetha.duplicate_excluded", entityType: "BankTransaction", entityId: r.id, clientId, details: { date: d.date, amountCents: r.amountCents, statement: st.title, statementDocumentId: st.documentId, statementCount: allowed, booksCount: list.length, wasPosted: r.status === "POSTED" } });
        }
        removed.push(d);
      }
    }
  }
  return { month: input.month, removed, unverified, dryRun: !!input.dryRun, statementsUsed };
}

/** Reads the month's statements on file into the books and prepares each account's reconciliation. Never forces a balance. */
export async function reconcileAccounts(actor: Actor, clientId: string, input: { month: string }) {
  const { year, month } = monthOf(input.month);
  const accounts = await prisma.bookkeepingAccount.findMany({ where: { clientId, parentAccountId: null, active: true } });
  const { readStatementTransactions, statementReadMessage } = await import("./statement-import");
  const { chooseStatement } = await import("./statement-choice");
  const out = [];
  for (const a of accounts) {
    const label = `${a.institution}${a.nickname ? ` ${a.nickname}` : ""}${a.last4 ? ` ••${a.last4}` : ""}`;
    const { chosen: doc, skipped } = await chooseStatement(clientId, a.id, year, month);
    let statement = "No readable statement for this account is on file for this month: this account stays pending; everything else continues.";
    let verified = false;
    if (doc) {
      try {
        const read = await readStatementTransactions(actor, clientId, doc.id);
        statement = `${doc.title}: ${statementReadMessage(read)}`;
        // Verified: the statement on file was read to the cent (beginning + every transaction = ending).
        verified = read.ok;
        // The bank's own statement is the authority for the month's balances.
        if (read.ok) {
          const ex = await prisma.accountReconciliation.findUnique({ where: { bookkeepingAccountId_year_month: { bookkeepingAccountId: a.id, year, month } } });
          if (ex?.status !== "APPROVED" && (ex?.beginningBalanceCents !== read.beginningCents || ex?.endingBalanceCents !== read.endingCents)) {
            await enterStatementBalances(actor, clientId, a.id, year, month, { beginning: (read.beginningCents / 100).toFixed(2), ending: (read.endingCents / 100).toFixed(2) });
          }
        }
      } catch (err) { statement = err instanceof Error ? err.message : "The statement couldn't be read."; }
    }
    let rec = await prepareReconciliation(clientId, a.id, year, month, { preparedById: actor.id, statementDocumentId: doc?.id ?? null });
    if (!rec) continue;
    let completed: string | null = null;
    // Under Tabitha's standing authorization Coetha completes a reconciliation ONLY when the balances
    // come from the bank's own statement on file, read to the cent, AND the books agree with it
    // (every row reviewed, difference zero, nothing flagged). A cash proof alone never counts.
    if (rec.status === "READY" && verified && rec.statementDocumentId === doc?.id) {
      const { coethaAutoPostOn } = await import("./owner-switches");
      const { ownerActor } = await import("./coetha-decisions");
      const owner = (await coethaAutoPostOn()) ? await ownerActor() : null;
      if (owner) {
        try {
          rec = await approveReconciliation(owner, clientId, rec.id);
          completed = "Reconciled: the statement on file and the books agree to the cent.";
          await audit(prisma, { actorId: owner.id, action: "coetha.reconciliation_completed", entityType: "AccountReconciliation", entityId: rec.id, clientId, details: { account: label, month: input.month, statementDocumentId: doc?.id ?? null, endingCents: rec.endingBalanceCents, requestedById: actor.id } });
        } catch (err) { completed = `Not marked reconciled: ${err instanceof Error ? err.message : "the books don't agree with the statement yet"}`; }
      } else completed = "Balanced against the statement, but the standing authorization is off (Owner's Office → Automation), so it waits for Tabitha's approval.";
    }
    out.push({ account: label, statement, statementPassedOver: skipped, statementVerified: verified, completed, status: rec.status, beginning: rec.beginningBalanceCents != null ? usd(rec.beginningBalanceCents) : null, ending: rec.endingBalanceCents != null ? usd(rec.endingBalanceCents) : null, difference: rec.differenceCents != null ? usd(rec.differenceCents) : null, unmatched: rec.unmatchedCount, exceptions: rec.exceptions });
  }
  return { month: input.month, accounts: out, note: "Differences are reported as they are; nothing was forced to balance. An account is marked reconciled only when its statement on file, read to the cent, agrees with the books." };
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
    if (name === "import_prior_months") return await importPriorMonths(actor, clientId, (input ?? {}) as { documentId?: string; months?: PriorMonth[]; packageEndingCash?: number | null });
    if (name === "import_statement_transactions") return await importStatementTransactions(actor, clientId, (input ?? {}) as Parameters<typeof importStatementTransactions>[2]);
    if (name === "correct_accounts") return await correctAccounts(actor, clientId, Array.isArray((input as { items?: unknown })?.items) ? ((input as { items: AccountFix[] }).items) : []);
    if (name === "reverse_entries") return await reverseEntries(actor, clientId, Array.isArray((input as { items?: unknown })?.items) ? ((input as { items: { entryId?: string; reason?: string }[] }).items) : []);
    return await reconcileAccounts(actor, clientId, { month: String(i.month ?? "") });
  } catch (err) {
    return { error: err instanceof ForbiddenError || err instanceof ValidationError ? err.message : "That couldn't be completed." };
  }
}


/**
 * Reverses journal entries Coetha has found to be wrong (posted twice, to the wrong account, …),
 * under Tabitha's standing authorization: each with its reason and evidence, dated in the entry's
 * own month (a closed operational month is reopened and closed again; a month whose statements were
 * approved or released, or whose tax return was filed, is left for Tabitha). The original entry and
 * its reversal both stay on the books; the bank rows behind it go back to review.
 */
export async function reverseEntries(actor: Actor, clientId: string, items: { entryId?: string; reason?: string }[]) {
  const { coethaAutoPostOn } = await import("./owner-switches");
  const { ownerActor, closedMonthEscalation, withMonthsOpened } = await import("./coetha-decisions");
  const { reverseEntry } = await import("./ledger");
  const { assertLedgerWrite } = await import("./ledger");
  await assertLedgerWrite(actor, clientId);
  const owner = (await coethaAutoPostOn()) ? await ownerActor() : null;
  const results: { entryId: string; ok: boolean; message: string; reversalId?: string }[] = [];
  for (const it of items.slice(0, 50)) {
    const entryId = String(it.entryId ?? "");
    const reason = String(it.reason ?? "").trim();
    const e = entryId ? await prisma.journalEntry.findFirst({ where: { id: entryId, clientId }, include: { reversedBy: { select: { id: true } }, lines: true } }) : null;
    if (!e) { results.push({ entryId, ok: false, message: "That entry isn't one of this business's entries." }); continue; }
    if (reason.length < 15) { results.push({ entryId, ok: false, message: "Give the reason and the evidence (for example the duplicate entry or the statement line)." }); continue; }
    if (e.reversedBy) { results.push({ entryId, ok: false, message: "Already reversed." }); continue; }
    if (!owner) { results.push({ entryId, ok: false, message: "The standing authorization is off (Owner's Office → Automation), so this reversal waits for Tabitha." }); continue; }
    const date = ymdOf(e.date);
    const why = await closedMonthEscalation(clientId, date);
    if (why) { results.push({ entryId, ok: false, message: `Left for Tabitha: ${why}.` }); continue; }
    try {
      const r = await withMonthsOpened(owner, clientId, date, `Coetha's standing authorization: reversal of a supported incorrect entry dated ${date}`, () => reverseEntry(owner, clientId, e.id, { date, reason: `Coetha (standing authorization): ${reason}`.slice(0, 300) }));
      await audit(prisma, { actorId: owner.id, action: "coetha.entry_reversed", entityType: "JournalEntry", entityId: e.id, clientId, details: { reversalId: r.id, reason: reason.slice(0, 300), amountCents: e.lines.reduce((n, l) => n + l.debitCents, 0), requestedById: actor.id } });
      results.push({ entryId, ok: true, message: `Reversed (${usd(e.lines.reduce((n, l) => n + l.debitCents, 0))}, ${date}); its bank rows are back in review.`, reversalId: r.id });
    } catch (err) {
      results.push({ entryId, ok: false, message: err instanceof Error ? err.message : "The reversal couldn't be posted." });
    }
  }
  return { results };
}

export const REVERSE_TOOL = {
  name: "reverse_entries",
  description: "Reverse journal entries you have verified are wrong (posted twice, posted to the wrong account, posted from a duplicate bank row), under Tabitha's standing authorization. Give each entry's entryId (from search_journal_entries) and the reason with its evidence. Each reversal is dated in the entry's own month; both entries stay on the books with an audit trail, and the bank rows go back to review so they can be posted correctly. Months whose statements were approved or released, or whose tax return was filed, are left for Tabitha. Verify against the ledger and the original transactions first.",
  input_schema: { type: "object" as const, properties: { items: { type: "array", items: { type: "object", properties: { entryId: { type: "string" }, reason: { type: "string" } }, required: ["entryId", "reason"] } } }, required: ["items"] },
};

// --- Months that are only in a financial package the office already prepared ------------------

type PriorLine = { accountCode?: string; amount?: number; label?: string; kind?: "draw" | "contribution" };
type PriorMonth = { month?: string; lines?: PriorLine[] };

const shown = (cents: number) => (Math.abs(cents) / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/**
 * Enters the months a financial package on file covers (the office's own Jan–Sep package, for
 * example) as one summary entry per month, so the books hold the whole year without asking for
 * every bank statement again. Coetha reads the package (any layout) and maps each line to the
 * chart; Client Connect checks her work before anything is posted:
 *  - every amount must be printed in the package itself (nothing invented);
 *  - a month that already has bank postings or an earlier package import is never entered again;
 *  - each month is posted once (its key), dated at month end, against the client's bank account;
 *  - the package's ending cash, when given, is compared with the books and any difference reported
 *    as it is — never plugged.
 */
export async function importPriorMonths(actor: Actor, clientId: string, input: { documentId?: string; months?: PriorMonth[]; packageEndingCash?: number | null }) {
  const { coethaAutoPostOn } = await import("./owner-switches");
  const { ownerActor, withMonthsOpened } = await import("./coetha-decisions");
  const { assertLedgerWrite, postJournalEntryTx } = await import("./ledger");
  await assertLedgerWrite(actor, clientId);
  const owner = (await coethaAutoPostOn()) ? await ownerActor() : null;
  if (!owner) return { error: "The standing authorization is off (Owner's Office → Automation), so the package months weren't entered." };
  const doc = input.documentId ? await prisma.document.findFirst({ where: { id: input.documentId, clientId, deletedAt: null }, include: { file: true } }) : null;
  if (!doc?.file) return { error: "That package isn't on file for this business." };
  const bytes = await readDocumentBytes(doc.file);
  const text = ((bytes ? await pdfLines(bytes) : null) ?? []).join("\n");
  if (!text.trim()) return { error: "The package has no readable text, so its amounts can't be checked." };
  const inText = (cents: number) => cents === 0 || text.includes(shown(cents));
  const bankReg = await prisma.bookkeepingAccount.findFirst({ where: { clientId, parentAccountId: null, active: true, accountType: { in: ["CHECKING", "SAVINGS"] }, ledgerAccountId: { not: null } }, orderBy: { createdAt: "asc" } });
  const bank = bankReg?.ledgerAccountId ? await prisma.ledgerAccount.findUnique({ where: { id: bankReg.ledgerAccountId } }) : await prisma.ledgerAccount.findFirst({ where: { clientId, subtype: "BANK" }, orderBy: { code: "asc" } });
  if (!bank) return { error: "This business has no bank account in its chart to enter the months against." };
  const chart = await prisma.ledgerAccount.findMany({ where: { clientId } });
  const byCode = new Map(chart.map((a) => [a.code, a]));
  // Months before the books' opening balances (a mid-year start): the opening balances already state the
  // cash, from the bank. Those months' income, expenses and owner draws/contributions are recorded against
  // Opening Balance Equity, so the P&L shows the whole year while cash stays tied to the bank — the
  // standard way to bring in a conversion's prior months. Nothing is plugged to cash.
  const book = await prisma.ledgerBook.findUnique({ where: { clientId } });
  const openingYmd = book?.openingDate ? book.openingDate.toISOString().slice(0, 10) : null;
  const obe = chart.find((a) => a.subtype === "OPENING_BALANCE") ?? null;
  const results: { month: string; ok: boolean; message: string }[] = [];
  let beforeOpeningNet = 0;
  for (const pm of (input.months ?? []).slice(0, 12)) {
    const month = String(pm.month ?? "");
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) { results.push({ month, ok: false, message: "Month must be YYYY-MM." }); continue; }
    const [y, m] = month.split("-").map(Number);
    const start = new Date(Date.UTC(y, m - 1, 1)), end = new Date(Date.UTC(y, m, 0));
    const endYmd = end.toISOString().slice(0, 10);
    // Never enter a month the books already hold (bank rows posted, or an earlier package import).
    const already = await prisma.journalEntry.count({ where: { clientId, date: { gte: start, lte: end }, OR: [{ source: "BANK" }, { sourceKey: { startsWith: "prior-package:" } }], reversedBy: null } });
    if (already) { results.push({ month, ok: false, message: "Already in the books (bank postings or an earlier import); not entered again." }); continue; }
    const lines: { accountId: string; debit?: string; credit?: string; description?: string }[] = [];
    let net = 0;
    const problems: string[] = [];
    for (const l of pm.lines ?? []) {
      const a = byCode.get(String(l.accountCode ?? ""));
      const c = Math.round(Number(l.amount ?? NaN) * 100);
      if (!a) { problems.push(`account ${l.accountCode} isn't in the chart`); continue; }
      if (!Number.isFinite(c) || c === 0) continue;
      if (!inText(c)) { problems.push(`${shown(c)} (${l.label ?? a.name}) isn't printed in the package`); continue; }
      const v = (Math.abs(c) / 100).toFixed(2);
      const desc = (l.label ?? a.name).slice(0, 120);
      const isIn = a.type === "INCOME" || (a.type === "EQUITY" && l.kind === "contribution") || (a.type === "LIABILITY");
      // Cash basis: money in credits income/equity and debits the bank; money out the reverse.
      const signed = c < 0 ? !isIn : isIn;
      if (signed) { lines.push({ accountId: a.id, credit: v, description: desc }); net += Math.abs(c); }
      else { lines.push({ accountId: a.id, debit: v, description: desc }); net -= Math.abs(c); }
    }
    if (problems.length) { results.push({ month, ok: false, message: `Not entered: ${problems.slice(0, 4).join("; ")}.` }); continue; }
    if (!lines.length) { results.push({ month, ok: false, message: "No amounts for this month." }); continue; }
    const beforeOpening = !!openingYmd && endYmd < openingYmd;
    if (beforeOpening && !obe) { results.push({ month, ok: false, message: "This month is before the opening balances and the chart has no Opening Balance Equity account; add one first." }); continue; }
    if (beforeOpening) {
      // Cash accounts are already stated by the opening balances; a non-cash item already in the opening
      // balances (e.g. equipment entered there) isn't entered twice. Everything else is entered.
      const { FEED_SUBTYPES } = await import("./ledger");
      const opening = await prisma.journalLine.findMany({ where: { entry: { clientId, sourceKey: "opening" } }, select: { accountId: true } });
      const inOpening = new Set(opening.map((o) => o.accountId));
      const skippedLines: string[] = [];
      for (let i = lines.length - 1; i >= 0; i--) {
        const a = chart.find((x) => x.id === lines[i].accountId);
        if (!a) continue;
        const cashAcct = FEED_SUBTYPES.includes(a.subtype ?? "");
        const already = (a.type === "ASSET" || a.type === "LIABILITY") && inOpening.has(a.id);
        if (cashAcct || already) {
          skippedLines.push(`${lines[i].description ?? a.name} (${cashAcct ? "a bank or card balance, already in the opening balances" : "already in the opening balances"})`);
          const d = Math.round(Number(lines[i].debit ?? 0) * 100), c = Math.round(Number(lines[i].credit ?? 0) * 100);
          net += d - c; // removing a debit raises what the offset must carry, and vice versa
          lines.splice(i, 1);
        }
      }
      if (skippedLines.length) results.push({ month, ok: true, message: `Not entered again: ${skippedLines.join("; ")}.` });
      if (!lines.length) continue;
    }
    if (net !== 0) {
      const offset = beforeOpening ? obe! : bank;
      lines.push({ accountId: offset.id, ...(net > 0 ? { debit: (net / 100).toFixed(2) } : { credit: (-net / 100).toFixed(2) }), description: beforeOpening ? "Before the opening balances: the cash is already in the opening balance (Opening Balance Equity)" : "Net cash for the month, per the package" });
    }
    try {
      await withMonthsOpened(owner, clientId, endYmd, `Coetha's standing authorization: ${month} entered from the financial package on file`, () =>
        prisma.$transaction((tx) => postJournalEntryTx(tx, owner, clientId, { date: endYmd, memo: `${month} summary from the financial package on file (${doc.title})`.slice(0, 300), lines, sourceKey: `prior-package:${month}`, reason: `Entered from ${doc.title} (document ${doc.id}) under standing authorization${beforeOpening ? "; before the opening balances, against Opening Balance Equity" : ""}`, beforeOpening })));
      await audit(prisma, { actorId: owner.id, action: "coetha.prior_month_imported", entityType: "Document", entityId: doc.id, clientId, details: { month, lines: lines.length, netCashCents: net, beforeOpening, requestedById: actor.id } });
      if (beforeOpening) beforeOpeningNet += net;
      results.push({ month, ok: true, message: beforeOpening ? `Entered: ${lines.length} lines (income/expenses ${usd(net)} net, against Opening Balance Equity — cash stays as the opening balance states).` : `Entered: ${lines.length} lines, net cash ${usd(net)}.` });
    } catch (err) {
      results.push({ month, ok: false, message: err instanceof Error ? err.message : "Couldn't be entered." });
    }
  }
  // Compare with the package's own ending cash: report any difference, never plug it.
  let cashCheck: string | null = null;
  if (input.packageEndingCash != null && Number.isFinite(Number(input.packageEndingCash))) {
    const last = (input.months ?? []).map((x) => String(x.month ?? "")).filter((x) => /^\d{4}-\d{2}$/.test(x)).sort().pop();
    if (last) {
      const [y, m] = last.split("-").map(Number);
      const asOf = new Date(Date.UTC(y, m, 0));
      // Before the opening balances, the books' cash for that date is the opening balance itself.
      const cashAsOf = openingYmd && asOf.toISOString().slice(0, 10) < openingYmd ? new Date(`${openingYmd}T00:00:00Z`) : asOf;
      const agg = await prisma.journalLine.aggregate({ where: { accountId: bank.id, entry: { clientId, date: { lte: cashAsOf } } }, _sum: { debitCents: true, creditCents: true } });
      const books = (agg._sum.debitCents ?? 0) - (agg._sum.creditCents ?? 0);
      const pkg = Math.round(Number(input.packageEndingCash) * 100);
      cashCheck = books === pkg ? `Cash agrees with the package at ${usd(pkg)} as of ${last}.` : `Cash in the books ${usd(books)} vs the package's ${usd(pkg)} as of ${last}: a difference of ${usd(books - pkg)} — reported as an exception, not adjusted.`;
    }
  }
  const note = beforeOpeningNet || results.some((r) => r.ok && /Opening Balance Equity/.test(r.message)) ? "Months before the opening balances were recorded against Opening Balance Equity: the P&L now shows them, and cash is unchanged (it comes from the bank's opening balance)." : null;
  return { results, cashCheck, note };
}

export const PRIOR_MONTHS_TOOL = {
  name: "import_prior_months",
  description: "Enter months that exist only in a financial package already on file (the office's prepared Jan–Sep statements, for example) — one summary entry per month, by account, against the bank account, under Tabitha's standing authorization. Read the package first (read_files_on_file), map each P&L line to the chart (use prepare_entries with new_account items first if an account is missing), then send every month with its lines (amount = the figure printed for that month; owner draws kind \"draw\", owner contributions kind \"contribution\"). Every amount must be printed in the package; months already in the books are skipped automatically; months before the books' opening balances are recorded against Opening Balance Equity (the opening balance already holds the cash), so you never need the opening date moved; the package's ending cash is compared and any difference reported, never plugged.",
  input_schema: {
    type: "object" as const,
    properties: {
      documentId: { type: "string", description: "The package's document id (find_files_on_file)" },
      months: { type: "array", items: { type: "object", properties: { month: { type: "string", description: "YYYY-MM" }, lines: { type: "array", items: { type: "object", properties: { accountCode: { type: "string" }, amount: { type: "number" }, label: { type: "string" }, kind: { type: "string", enum: ["draw", "contribution"] } }, required: ["accountCode", "amount"] } } }, required: ["month", "lines"] } },
      packageEndingCash: { type: "number", description: "The package Balance Sheet's ending cash, to compare (optional)" },
    },
    required: ["documentId", "months"],
  },
};


// --- Correcting account details (wrong bank names, numbers, accounts the business doesn't have) ---

type AccountFix = { code?: string; name?: string; institution?: string; nickname?: string; last4?: string; active?: boolean; reason?: string; add?: { accountType?: string; institution?: string; last4?: string; nickname?: string } };

/**
 * Corrects how an account is described when it was set up wrong (e.g. registered as "Chase" when the
 * business banks with Farm Bureau Bank): the chart account's name, and for a bank or card account its
 * bank name, nickname and last 4 digits. An account the business doesn't have can be deactivated when
 * its balance is zero. No entries or balances change; every correction is in the audit log.
 * Asked for by Tabitha (the owner) only.
 */
export async function correctAccounts(actor: Actor, clientId: string, items: AccountFix[]) {
  const { isPrimaryOwner } = await import("@/lib/auth/permissions");
  if (!(await isPrimaryOwner(actor.id))) throw new ForbiddenError("Only Tabitha can have Coetha correct account details.");
  const { updateAccount, assertLedgerWrite } = await import("./ledger");
  await assertLedgerWrite(actor, clientId);
  const results: { code: string; ok: boolean; message: string }[] = [];
  for (const it of items.slice(0, 40)) {
    const code = String(it.code ?? "").trim();
    const reason = String(it.reason ?? "").trim();
    // A real account the books don't have yet (e.g. the business's actual bank): registered with its own GL account.
    if (it.add) {
      if (reason.length < 10) { results.push({ code: "new", ok: false, message: "Give the reason and evidence for adding it." }); continue; }
      try {
        const { registerAccount } = await import("./bank-accounts");
        const type = String(it.add.accountType ?? "").toUpperCase();
        const a = await registerAccount(actor, clientId, { institution: String(it.add.institution ?? ""), accountType: type, last4: it.add.last4 ? String(it.add.last4) : undefined, nickname: it.add.nickname ? String(it.add.nickname) : undefined, gl: "NEW" });
        const gl = a.ledgerAccountId ? await prisma.ledgerAccount.findUnique({ where: { id: a.ledgerAccountId } }) : null;
        await audit(prisma, { actorId: actor.id, action: "coetha.account_added", entityType: "BookkeepingAccount", entityId: a.id, clientId, details: { reason: reason.slice(0, 300), institution: a.institution, last4: a.last4, type } });
        results.push({ code: gl?.code ?? "new", ok: true, message: `Added: ${a.institution}${a.last4 ? ` ••${a.last4}` : ""} (${type.toLowerCase().replace("_", " ")})${gl ? `, chart account ${gl.code} ${gl.name}` : ""}.` });
      } catch (err) {
        results.push({ code: "new", ok: false, message: err instanceof Error ? err.message : "Couldn't be added." });
      }
      continue;
    }
    const acct = code ? await prisma.ledgerAccount.findFirst({ where: { clientId, code } }) : null;
    if (!acct) { results.push({ code, ok: false, message: "No account with that code in this business's chart." }); continue; }
    if (reason.length < 10) { results.push({ code, ok: false, message: "Give the reason and evidence (for example: the statements on file are from Farm Bureau Bank, account ending 4542)." }); continue; }
    try {
      const reg = await prisma.bookkeepingAccount.findFirst({ where: { clientId, ledgerAccountId: acct.id, parentAccountId: null } });
      const last4 = it.last4 !== undefined ? (String(it.last4).trim() || null) : undefined;
      if (last4 && !/^\d{4}$/.test(last4)) throw new ValidationError("Last 4 must be exactly four digits.");
      const institution = it.institution !== undefined ? String(it.institution).trim().slice(0, 120) : undefined;
      if (institution !== undefined && !institution) throw new ValidationError("The bank name can't be blank.");
      const nickname = it.nickname !== undefined ? String(it.nickname).trim().slice(0, 80) || null : undefined;
      // Deactivating: only an account with a zero balance (nothing is hidden that the statements need).
      if (it.active === false) {
        const agg = await prisma.journalLine.aggregate({ where: { accountId: acct.id }, _sum: { debitCents: true, creditCents: true } });
        const bal = (agg._sum.debitCents ?? 0) - (agg._sum.creditCents ?? 0);
        if (bal !== 0) throw new ValidationError(`It has a balance of ${usd(Math.abs(bal))}; move that to the right account first (prepare_entries), then deactivate it.`);
        if (reg) {
          const open = await prisma.bankTransaction.count({ where: { clientId, accountId: acct.id, status: "UNREVIEWED" } });
          if (open) throw new ValidationError(`${open} bank row(s) on it still wait for review; post or move them first.`);
        }
      }
      const before = { name: acct.name, institution: acct.institution, last4: acct.last4, active: acct.active, registry: reg ? { institution: reg.institution, nickname: reg.nickname, last4: reg.last4, active: reg.active } : null };
      if (reg && (institution !== undefined || nickname !== undefined || last4 !== undefined || it.active !== undefined)) {
        await prisma.bookkeepingAccount.update({ where: { id: reg.id }, data: { ...(institution !== undefined ? { institution } : {}), ...(nickname !== undefined ? { nickname } : {}), ...(last4 !== undefined ? { last4 } : {}), ...(it.active !== undefined ? { active: it.active } : {}), updatedById: actor.id } });
      }
      // The chart name: as given, or — when only the bank name changed — the old bank name replaced in it.
      let name = it.name !== undefined ? String(it.name).trim().slice(0, 120) : undefined;
      if (name === undefined && institution && reg?.institution && acct.name.toLowerCase().includes(reg.institution.toLowerCase())) {
        name = acct.name.replace(new RegExp(reg.institution.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"), institution);
      }
      await updateAccount(actor, clientId, acct.id, { ...(name ? { name } : {}), ...(institution !== undefined ? { institution } : {}), ...(last4 !== undefined ? { last4: last4 ?? "" } : {}), ...(it.active !== undefined ? { active: it.active } : {}) });
      const after = await prisma.ledgerAccount.findUniqueOrThrow({ where: { id: acct.id } });
      await audit(prisma, { actorId: actor.id, action: "coetha.account_corrected", entityType: "LedgerAccount", entityId: acct.id, clientId, details: { code, reason: reason.slice(0, 300), before, after: { name: after.name, institution: after.institution, last4: after.last4, active: after.active } } });
      results.push({ code, ok: true, message: `Corrected: ${after.name}${after.institution ? ` (${after.institution}${after.last4 ? ` ••${after.last4}` : ""})` : ""}${after.active ? "" : " — deactivated"}. No entries changed.` });
    } catch (err) {
      results.push({ code, ok: false, message: err instanceof Error ? err.message : "Couldn't be corrected." });
    }
  }
  return { results };
}

export const CORRECT_ACCOUNTS_TOOL = {
  name: "correct_accounts",
  description: "Correct how this business's accounts are described when they were set up wrong — for example a checking or card account registered as \"Chase\" when the statements show Farm Bureau Bank. By chart code: set the account's name, and for bank or card accounts the bank name (institution), nickname and last 4 digits; deactivate (active false) an account the business doesn't have, once its balance is zero (move any balance first with prepare_entries); or add the business's real bank or card account when the books don't have it (an item with 'add': accountType CHECKING, SAVINGS, CREDIT_CARD, LINE_OF_CREDIT or LOAN, institution, last4 — no code needed). Give each item a reason naming the evidence (the statements, the bank's name and account number on them). No entries or balances change. Use it whenever the books' account names or banks don't match the client's real accounts; don't ask Tabitha to fix them by hand.",
  input_schema: { type: "object" as const, properties: { items: { type: "array", items: { type: "object", properties: { code: { type: "string" }, name: { type: "string" }, institution: { type: "string" }, nickname: { type: "string" }, last4: { type: "string" }, active: { type: "boolean" }, reason: { type: "string" }, add: { type: "object", properties: { accountType: { type: "string" }, institution: { type: "string" }, last4: { type: "string" }, nickname: { type: "string" } } } }, required: ["reason"] } } }, required: ["items"] },
};

// --- Entering a statement Coetha read herself (a screenshot, photo or scan) ---------------------

type ReadTxn = { date?: string; description?: string; amount?: number };

/**
 * Enters the transactions Coetha read from a statement on file (any format — a screenshot, photo or
 * scan as well as a PDF) into that account's bank rows, and files the document under the account and
 * month. Accepted only when the statement adds up to the cent (beginning + every transaction = ending),
 * so a misread is caught instead of entered. A line already in the books (same date and amount, as
 * often as the statement shows it) isn't added again. Nothing is posted: the rows wait to be
 * categorized and posted like any import.
 */
export async function importStatementTransactions(actor: Actor, clientId: string, input: { documentId?: string; accountCode?: string; month?: string; beginningBalance?: number; endingBalance?: number; transactions?: ReadTxn[] }) {
  const { assertLedgerWrite, importBankCsv } = await import("./ledger");
  await assertLedgerWrite(actor, clientId, "banking");
  const { year, month } = monthOf(input.month);
  const doc = input.documentId ? await prisma.document.findFirst({ where: { id: input.documentId, clientId, deletedAt: null } }) : null;
  if (!doc) return { error: "That document isn't on file for this business." };
  const acct = await prisma.ledgerAccount.findFirst({ where: { clientId, code: String(input.accountCode ?? "") } });
  if (!acct) return { error: "No account with that code in this business's chart." };
  const reg = await prisma.bookkeepingAccount.findFirst({ where: { clientId, ledgerAccountId: acct.id, parentAccountId: null } });
  if (!reg) return { error: "That chart account isn't one of this business's registered bank or card accounts; add it with correct_accounts first." };
  const begin = Math.round(Number(input.beginningBalance) * 100), end = Math.round(Number(input.endingBalance) * 100);
  if (!Number.isFinite(begin) || !Number.isFinite(end)) return { error: "Give the statement's beginning and ending balances as printed." };
  const rows = (input.transactions ?? []).map((t) => ({ date: String(t.date ?? ""), description: String(t.description ?? "").slice(0, 200) || "Transaction", cents: Math.round(Number(t.amount) * 100) }));
  if (!rows.length || rows.some((r) => !/^\d{4}-\d{2}-\d{2}$/.test(r.date) || !Number.isFinite(r.cents) || r.cents === 0)) return { error: "Each transaction needs a date (YYYY-MM-DD) and a non-zero amount (money in positive, money out negative)." };
  // Card statements: purchases raise the balance owed.
  const liability = ["CREDIT_CARD", "LINE_OF_CREDIT", "LOAN"].includes(reg.accountType);
  const net = rows.reduce((n, r) => n + r.cents, 0);
  const expected = liability ? begin - net : begin + net;
  if (expected !== end) return { error: `It doesn't add up: beginning ${usd(begin)} ${liability ? "minus" : "plus"} the transactions read (${usd(net)} net) is ${usd(expected)}, not the ending ${usd(end)} — a line is missing or misread. Read the statement again; nothing was entered.` };
  // Only what the books don't already have (by date and amount, as often as the statement shows it).
  const dates = rows.map((r) => r.date).sort();
  const existing = await prisma.bankTransaction.findMany({ where: { clientId, accountId: acct.id, status: { not: "EXCLUDED" }, date: { gte: new Date(`${dates[0]}T00:00:00Z`), lte: new Date(`${dates[dates.length - 1]}T00:00:00Z`) } }, select: { date: true, amountCents: true } });
  const have = new Map<string, number>();
  for (const e of existing) { const k = `${ymdOf(e.date)}|${e.amountCents}`; have.set(k, (have.get(k) ?? 0) + 1); }
  const missing = rows.filter((r) => { const k = `${r.date}|${r.cents}`; const n = have.get(k) ?? 0; if (n > 0) { have.set(k, n - 1); return false; } return true; });
  const q = (v: string) => `"${v.replace(/"/g, '""')}"`;
  const csv = ["Date,Description,Amount", ...missing.map((r) => `${r.date.slice(5, 7)}/${r.date.slice(8, 10)}/${r.date.slice(0, 4)},${q(r.description)},${(r.cents / 100).toFixed(2)}`)].join("\n");
  const imp = missing.length ? await importBankCsv(actor, clientId, acct.id, { fileName: `${doc.title} (read by Coetha)`.slice(0, 200), text: csv }) : { added: 0, duplicates: 0 };
  // The document is filed as this account's statement for the month; its balances fill the month's reconciliation.
  await prisma.document.update({ where: { id: doc.id }, data: { docType: liability ? "CARD_STATEMENT" : "BANK_STATEMENT", bookkeepingAccountId: reg.id, manualBankAccountId: null, year, month } });
  const rec = await prisma.accountReconciliation.findUnique({ where: { bookkeepingAccountId_year_month: { bookkeepingAccountId: reg.id, year, month } } });
  if (rec?.status !== "APPROVED") {
    const { enterStatementBalances: enter, prepareReconciliation: prep } = await import("./bank-accounts");
    await enter(actor, clientId, reg.id, year, month, { beginning: (begin / 100).toFixed(2), ending: (end / 100).toFixed(2) }).catch(() => null);
    await prep(clientId, reg.id, year, month, { preparedById: actor.id, statementDocumentId: doc.id });
  }
  await audit(prisma, { actorId: actor.id, action: "coetha.statement_entered", entityType: "Document", entityId: doc.id, clientId, details: { account: acct.code, month: input.month, read: rows.length, added: imp.added, alreadyInBooks: rows.length - missing.length, beginningCents: begin, endingCents: end } });
  return { ok: true, read: rows.length, added: imp.added, alreadyInBooks: rows.length - missing.length + (imp.duplicates ?? 0), message: `Entered ${imp.added} of ${rows.length} transactions (the rest were already in the books); the statement adds up from ${usd(begin)} to ${usd(end)}. The document is filed as ${acct.code}'s statement for ${input.month}. Nothing posted yet — post the rows next.` };
}

export const IMPORT_STATEMENT_TOOL = {
  name: "import_statement_transactions",
  description: "Enter the transactions you read from a bank or credit card statement on file — including a screenshot, photo or scan you looked at with read_documents_on_file — into that account's bank rows, and file the document as that account's statement for the month. Give the document id, the account's chart code, the month (YYYY-MM), the beginning and ending balances as printed, and every transaction (date YYYY-MM-DD, description, amount: money in positive, money out negative; for a card, purchases negative and payments positive). It is accepted only if beginning + transactions = ending to the cent (otherwise read it again); lines already in the books aren't added twice. Then post the rows with prepare_entries and reconcile.",
  input_schema: { type: "object" as const, properties: { documentId: { type: "string" }, accountCode: { type: "string" }, month: { type: "string" }, beginningBalance: { type: "number" }, endingBalance: { type: "number" }, transactions: { type: "array", items: { type: "object", properties: { date: { type: "string" }, description: { type: "string" }, amount: { type: "number" } }, required: ["date", "amount"] } } }, required: ["documentId", "accountCode", "month", "beginningBalance", "endingBalance", "transactions"] },
};
