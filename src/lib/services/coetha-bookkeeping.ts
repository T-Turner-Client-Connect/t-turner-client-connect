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
