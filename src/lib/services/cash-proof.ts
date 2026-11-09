import "server-only";
import { prisma } from "@/lib/prisma";
import { audit } from "@/lib/audit";
import type { Actor } from "@/lib/auth/actor";
import { ValidationError } from "./clients";
import { assertLedger, postJournalEntryTx, postOpeningBalances, ymdOf } from "./ledger";

const OPENING_TO_BANK = "opening:to-bank";

/**
 * Cash proof: how a bank account's statement balance becomes its balance in the books, line by
 * line, from the business's own records. Nothing is forced or adjusted:
 *
 *   statement ending balance (latest statement on file)
 *   − bank activity on the statements not yet posted (waiting for review)
 *   − bank activity excluded from the books
 *   − the opening balance, when it isn't posted
 *   + entries on the cash account that don't come from a bank row (manual or adjusting entries)
 *   = the books' balance for that account on the statement date
 *
 * Any remaining difference means statements are missing or overlap, and is shown as such.
 * Duplicate postings are checked too: a bank row is posted by at most one live entry.
 */
export async function cashProof(actor: Actor, clientId: string) {
  await assertLedger(actor, clientId);
  const registry = await prisma.bookkeepingAccount.findMany({ where: { clientId, active: true, parentAccountId: null, ledgerAccountId: { not: null } }, include: { ledgerAccount: true } });
  const out = [];
  for (const r of registry) {
    const acct = r.ledgerAccount!;
    if (acct.subtype !== "BANK") continue;
    const recs = await prisma.accountReconciliation.findMany({ where: { bookkeepingAccountId: r.id, endingBalanceCents: { not: null }, statementClosingDate: { not: null } }, orderBy: [{ year: "asc" }, { month: "asc" }] });
    if (!recs.length) continue;
    const last = recs[recs.length - 1];
    const first = await prisma.accountReconciliation.findFirst({ where: { bookkeepingAccountId: r.id, beginningBalanceCents: { not: null } }, orderBy: [{ year: "asc" }, { month: "asc" }] });
    const asOf = last.statementClosingDate!;
    const dateTo = { lte: asOf };

    const sumRows = async (status: string) => (await prisma.bankTransaction.aggregate({ where: { clientId, accountId: acct.id, status, date: dateTo }, _sum: { amountCents: true }, _count: true }));
    const [waiting, excluded, postedRows] = await Promise.all([sumRows("UNREVIEWED"), sumRows("EXCLUDED"), sumRows("POSTED")]);
    const lines = await prisma.journalLine.findMany({ where: { accountId: acct.id, entry: { clientId, date: dateTo } }, select: { debitCents: true, creditCents: true, entry: { select: { id: true, source: true, sourceKey: true } } } });
    const ledger = lines.reduce((t, l) => t + l.debitCents - l.creditCents, 0);
    const openingPosted = lines.filter((l) => l.entry.source === "OPENING" || l.entry.sourceKey === OPENING_TO_BANK).reduce((t, l) => t + l.debitCents - l.creditCents, 0);
    // Entries that post a bank row vs. everything else on the cash account (manual or adjusting
    // entries). A reversed posting and its reversal cancel out, so they need no special handling.
    const rowEntryIds = new Set((await prisma.bankTransaction.findMany({ where: { clientId, accountId: acct.id, journalEntryId: { not: null } }, select: { journalEntryId: true } })).map((t) => t.journalEntryId!));
    const fromRows = lines.filter((l) => rowEntryIds.has(l.entry.id)).reduce((t, l) => t + l.debitCents - l.creditCents, 0);
    const other = ledger - openingPosted - fromRows;
    const openingNeeded = first?.beginningBalanceCents ?? null;
    const statement = last.endingBalanceCents!;
    const allRows = (waiting._sum.amountCents ?? 0) + (excluded._sum.amountCents ?? 0) + (postedRows._sum.amountCents ?? 0);
    // Statements on file should run from the first beginning balance to the last ending balance.
    const coverageGap = openingNeeded == null ? null : statement - (openingNeeded + allRows);
    // A bank row posted by more than one live (not reversed) entry would be a duplicate.
    const live = await prisma.journalEntry.findMany({ where: { clientId, source: "BANK", reversalOfId: null, reversedBy: null, sourceKey: { startsWith: "bank:" } }, select: { sourceKey: true } });
    const perRow = new Map<string, number>();
    for (const e of live) { const id = e.sourceKey!.split(":")[1]; perRow.set(id, (perRow.get(id) ?? 0) + 1); }
    const duplicateRows = [...perRow.values()].filter((n) => n > 1).length;
    // The opening entry on file (if any): which accounts it was recorded on.
    const openingEntry = await prisma.journalEntry.findFirst({ where: { clientId, source: "OPENING" }, orderBy: { createdAt: "desc" }, include: { lines: { include: { account: { select: { code: true, name: true } } } } } });
    const openingOnFile = openingEntry ? { id: openingEntry.id, date: ymdOf(openingEntry.date), lines: openingEntry.lines.map((l) => ({ account: `${l.account.code} ${l.account.name}`, debitCents: l.debitCents, creditCents: l.creditCents })) } : null;
    const expected = statement - (waiting._sum.amountCents ?? 0) - (excluded._sum.amountCents ?? 0) - ((openingNeeded ?? 0) - openingPosted) + other;
    out.push({
      ledgerAccountId: acct.id,
      account: `${acct.code} ${acct.name}`,
      asOf: ymdOf(asOf),
      statementEnding: statement,
      waiting: { cents: waiting._sum.amountCents ?? 0, count: waiting._count },
      excluded: { cents: excluded._sum.amountCents ?? 0, count: excluded._count },
      openingNeeded,
      openingPosted,
      openingMissing: openingNeeded != null && openingPosted === 0 && !openingOnFile,
      openingMonth: first ? `${first.year}-${String(first.month).padStart(2, "0")}` : null,
      other,
      expected,
      ledger,
      difference: ledger - expected,
      coverageGap,
      duplicateRows,
      postedRows: { cents: postedRows._sum.amountCents ?? 0, count: postedRows._count },
      openingOnFile,
      openingElsewhere: !!openingOnFile && openingPosted === 0,
    });
  }
  return out;
}

/**
 * Records the opening balance on the bank account from the beginning balance already on file for
 * the earliest statement month (what was entered on the reconciliation page or read from the
 * statement) — nothing is typed again. Tabitha or an Admin only, with her confirmation.
 * - No opening entry yet: it is posted, dated the first day of that month.
 * - An opening entry exists but never reached the bank account (recorded on other accounts): an
 *   adjusting entry records the beginning cash on the bank account (the original stays unchanged).
 * - The opening already reached the bank account: nothing is done.
 */
export async function postOpeningFromStatement(actor: Actor, clientId: string, ledgerAccountId: string) {
  if (actor.role !== "ADMIN") {
    const { isReportApprover } = await import("./bookkeeping-clients");
    if (!(await isReportApprover(actor))) throw new ValidationError("Only Tabitha or an Admin posts opening balances.");
  }
  const proof = (await cashProof(actor, clientId)).find((p) => p.ledgerAccountId === ledgerAccountId);
  if (!proof || proof.openingNeeded == null || !proof.openingMonth) throw new ValidationError("No beginning balance is on file for this account's first statement month.");
  const date = `${proof.openingMonth}-01`;
  if (proof.openingMissing) {
    const e = await postOpeningBalances(actor, clientId, { date, balances: [{ accountId: ledgerAccountId, amount: (proof.openingNeeded / 100).toFixed(2) }] });
    await audit(prisma, { actorId: actor.id, action: "ledger.opening_from_statement", entityType: "JournalEntry", entityId: e.id, clientId, details: { ledgerAccountId, month: proof.openingMonth, cents: proof.openingNeeded } });
    return { date, cents: proof.openingNeeded, corrected: false };
  }
  if (proof.openingElsewhere && proof.openingOnFile) {
    // The ledger never reverses an opening entry; it is corrected with an adjusting entry. This one
    // records the beginning cash on the bank account and offsets Opening Balance Equity, which the
    // original entry used for the difference. The original stays as it was, in the history.
    const obe = await prisma.ledgerAccount.findFirst({ where: { clientId, subtype: "OPENING_BALANCE" } });
    if (!obe) throw new ValidationError("Add an Opening Balance Equity account first.");
    const amount = (proof.openingNeeded / 100).toFixed(2);
    const e = await prisma.$transaction((tx) => postJournalEntryTx(tx, actor, clientId, {
      date: proof.openingOnFile!.date, memo: "Opening balance recorded on the bank account (from the beginning balance on file)", adjusting: true, sourceKey: OPENING_TO_BANK,
      reason: "The opening entry did not include the bank account.",
      lines: [{ accountId: ledgerAccountId, debit: amount }, { accountId: obe.id, credit: amount }],
    }));
    await audit(prisma, { actorId: actor.id, action: "ledger.opening_corrected", entityType: "JournalEntry", entityId: e.id, clientId, details: { originalEntryId: proof.openingOnFile.id, ledgerAccountId, month: proof.openingMonth, cents: proof.openingNeeded, originalLines: proof.openingOnFile.lines } });
    return { date: proof.openingOnFile.date, cents: proof.openingNeeded, corrected: true };
  }
  throw new ValidationError("The opening balance is already on the bank account. Correct it with an adjusting entry if needed.");
}
