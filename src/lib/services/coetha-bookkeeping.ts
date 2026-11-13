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
  const results: { month: string; ok: boolean; message: string }[] = [];
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
    if (net !== 0) lines.push({ accountId: bank.id, ...(net > 0 ? { debit: (net / 100).toFixed(2) } : { credit: (-net / 100).toFixed(2) }), description: "Net cash for the month, per the package" });
    try {
      await withMonthsOpened(owner, clientId, endYmd, `Coetha's standing authorization: ${month} entered from the financial package on file`, () =>
        prisma.$transaction((tx) => postJournalEntryTx(tx, owner, clientId, { date: endYmd, memo: `${month} summary from the financial package on file (${doc.title})`.slice(0, 300), lines, sourceKey: `prior-package:${month}`, reason: `Entered from ${doc.title} (document ${doc.id}) under standing authorization` })));
      await audit(prisma, { actorId: owner.id, action: "coetha.prior_month_imported", entityType: "Document", entityId: doc.id, clientId, details: { month, lines: lines.length, netCashCents: net, requestedById: actor.id } });
      results.push({ month, ok: true, message: `Entered: ${lines.length} lines, net cash ${usd(net)}.` });
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
      const agg = await prisma.journalLine.aggregate({ where: { accountId: bank.id, entry: { clientId, date: { lte: asOf } } }, _sum: { debitCents: true, creditCents: true } });
      const books = (agg._sum.debitCents ?? 0) - (agg._sum.creditCents ?? 0);
      const pkg = Math.round(Number(input.packageEndingCash) * 100);
      cashCheck = books === pkg ? `Cash agrees with the package at ${usd(pkg)} as of ${last}.` : `Cash in the books ${usd(books)} vs the package's ${usd(pkg)} as of ${last}: a difference of ${usd(books - pkg)} — reported as an exception, not adjusted.`;
    }
  }
  return { results, cashCheck };
}

export const PRIOR_MONTHS_TOOL = {
  name: "import_prior_months",
  description: "Enter months that exist only in a financial package already on file (the office's prepared Jan–Sep statements, for example) — one summary entry per month, by account, against the bank account, under Tabitha's standing authorization. Read the package first (read_files_on_file), map each P&L line to the chart (use prepare_entries with new_account items first if an account is missing), then send every month with its lines (amount = the figure printed for that month; owner draws kind \"draw\", owner contributions kind \"contribution\"). Every amount must be printed in the package; months already in the books are skipped automatically; the package's ending cash is compared and any difference reported, never plugged.",
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
