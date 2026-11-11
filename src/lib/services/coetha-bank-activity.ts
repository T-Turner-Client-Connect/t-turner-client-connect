import "server-only";
import { prisma } from "@/lib/prisma";
import { audit } from "@/lib/audit";
import type { Actor } from "@/lib/auth/actor";
import { checkStatement, type StatementTxn } from "@/lib/statement-pdf";
import { assertLedger, importBankCsv, usd } from "./ledger";
import { ensureGlLink, registryLabel } from "./bank-accounts";

/**
 * Day-to-day bank activity, between statements. Staff send Coetha what the bank shows right now (an
 * activity PDF, a screenshot of the account) and she enters those transactions into the account's
 * bank rows, the same way a CSV import does:
 * - nothing is posted: the rows wait for the usual categorizing and Tabitha's approvals;
 * - rows already in the books (from an earlier screenshot, a CSV, the feed or the month's statement
 *   later) are recognized and skipped, so sending the same days twice adds nothing;
 * - nothing is entered unless the figures prove out to the cent: the balance before the first
 *   transaction + every transaction = the balance the bank shows after the last one, and the
 *   starting balance must match the last statement's ending balance when the activity starts right
 *   after that statement.
 */

const pad = (n: number) => String(n).padStart(2, "0");
const ymdOk = (s: unknown): s is string => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`));
const cents = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? Math.round(v * 100) : typeof v === "string" && /^-?\$?[\d,]+(\.\d{1,2})?$/.test(v.trim()) ? Math.round(Number(v.replace(/[$,]/g, "")) * 100) : null);
const dayBefore = (ymd: string) => new Date(Date.parse(`${ymd}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);

export const BANK_ACTIVITY_TOOL = {
  name: "add_bank_activity",
  description:
    "Enter day-to-day transactions you read from what was sent (a bank activity PDF, a screenshot of the account, a statement) into one registered bank or card account's bank rows, so the books and the daily balance are current between statements. Give every transaction in the period exactly as the bank shows it, the balance just before the first one and the balance after the last one, as shown. Client Connect enters them only if they add up to the cent; rows already in the books are skipped; nothing is posted (they wait to be categorized). Then prepare their postings as usual.",
  input_schema: {
    type: "object" as const,
    properties: {
      account: { type: "string", description: "The account's last 4 digits, or its General Ledger code (e.g. 1000)" },
      document_name: { type: "string", description: "The file the figures come from (its name as attached)" },
      starting_balance: { type: "number", description: "Dollars: the balance before the first transaction (for a card, the amount owed)" },
      ending_balance: { type: "number", description: "Dollars: the balance after the last transaction, as the bank shows it" },
      transactions: {
        type: "array",
        items: {
          type: "object",
          properties: {
            date: { type: "string", description: "YYYY-MM-DD" },
            description: { type: "string" },
            amount: { type: "number", description: "Dollars: positive = money in (deposit, card payment/refund), negative = money out (withdrawal, check, fee, card purchase)" },
          },
          required: ["date", "description", "amount"],
        },
      },
    },
    required: ["account", "starting_balance", "ending_balance", "transactions"],
  },
};

type Input = { account?: unknown; document_name?: unknown; starting_balance?: unknown; ending_balance?: unknown; transactions?: unknown };

/** The registered account the activity is for: by last 4 digits or by its GL code. */
async function findAccount(clientId: string, ref: string) {
  const r = ref.trim().replace(/^x+|^\*+|^#/i, "");
  const all = await prisma.bookkeepingAccount.findMany({ where: { clientId, active: true, parentAccountId: null }, include: { ledgerAccount: { select: { id: true, code: true, name: true, subtype: true } } } });
  const hits = all.filter((a) => (a.last4 && r.length >= 4 && r.endsWith(a.last4)) || a.ledgerAccount?.code === r);
  return { hits, all };
}

export async function addBankActivity(actor: Actor, clientId: string, input: Input) {
  await assertLedger(actor, clientId, "banking", "edit");
  const ref = typeof input.account === "string" ? input.account.slice(0, 40) : typeof input.account === "number" ? String(input.account) : "";
  const { hits, all } = await findAccount(clientId, ref);
  if (hits.length !== 1) {
    return { entered: false, problem: hits.length ? `More than one account matches “${ref}”. Use the GL code.` : `No registered account matches “${ref}”.`, accounts: all.map((a) => ({ account: registryLabel(a), last4: a.last4, glCode: a.ledgerAccount?.code ?? null })) };
  }
  const acct = hits[0];
  const ledgerAccountId = acct.ledgerAccountId ?? (await ensureGlLink(clientId, acct.id, actor.id));
  if (!ledgerAccountId) return { entered: false, problem: "This account isn't linked to a General Ledger account yet (Banking → Manage Accounts)." };
  const ledger = await prisma.ledgerAccount.findFirstOrThrow({ where: { id: ledgerAccountId, clientId } });
  const liability = ledger.subtype === "CREDIT_CARD";

  const raw = Array.isArray(input.transactions) ? (input.transactions as Record<string, unknown>[]).slice(0, 1000) : [];
  const bad: string[] = [];
  const txns: StatementTxn[] = [];
  raw.forEach((t, i) => {
    const amt = cents(t?.amount);
    const desc = typeof t?.description === "string" ? t.description.trim().slice(0, 200) : "";
    if (!ymdOk(t?.date) || amt == null || amt === 0 || !desc) bad.push(`#${i + 1}`);
    else txns.push({ date: t.date as string, description: desc, amountCents: amt, section: amt > 0 ? "DEPOSITS" : "WITHDRAWALS" });
  });
  if (bad.length) return { entered: false, problem: `These transactions are missing a date (YYYY-MM-DD), description or amount: ${bad.slice(0, 10).join(", ")}. Nothing was entered.` };
  if (!txns.length) return { entered: false, problem: "No transactions were given." };
  const start = cents(input.starting_balance), end = cents(input.ending_balance);
  if (start == null || end == null) return { entered: false, problem: "Give the balance before the first transaction and after the last one, as the bank shows them." };
  const today = new Date().toISOString().slice(0, 10);
  if (txns.some((t) => t.date > today)) return { entered: false, problem: "A transaction is dated in the future. Nothing was entered." };

  txns.sort((a, b) => a.date.localeCompare(b.date));
  const first = txns[0].date, last = txns[txns.length - 1].date;
  const check = checkStatement({ beginningCents: start, endingCents: end, periodStart: first, periodEnd: last, totals: {} }, txns, {}, { liability });
  if (!check.ok) return { entered: false, problem: `${check.problems.join(" ")} Nothing was entered. Re-read the figures (a missed or doubled transaction, or a pending item the bank hasn't added to the balance yet).` };

  // The starting balance must continue the last statement when the activity begins right after it.
  const prevMonth = Number(first.slice(5, 7)) === 1 ? { y: Number(first.slice(0, 4)) - 1, m: 12 } : { y: Number(first.slice(0, 4)), m: Number(first.slice(5, 7)) - 1 };
  const prior = await prisma.accountReconciliation.findUnique({ where: { bookkeepingAccountId_year_month: { bookkeepingAccountId: acct.id, year: prevMonth.y, month: prevMonth.m } }, select: { endingBalanceCents: true } });
  const priorEnd = `${prevMonth.y}-${pad(prevMonth.m)}-${pad(new Date(Date.UTC(prevMonth.y, prevMonth.m, 0)).getUTCDate())}`;
  const sameMonthBefore = await prisma.bankTransaction.count({ where: { clientId, accountId: ledger.id, date: { gt: new Date(`${priorEnd}T00:00:00Z`), lt: new Date(`${first}T00:00:00Z`) }, status: { not: "EXCLUDED" } } });
  if (prior?.endingBalanceCents != null && !sameMonthBefore && prior.endingBalanceCents !== start) {
    return { entered: false, problem: `The starting balance ${usd(start)} doesn't continue the last statement (${usd(prior.endingBalanceCents)} on ${priorEnd}), and there are no transactions in the books between ${priorEnd} and ${dayBefore(first)}. Some activity is missing, or the starting balance was misread. Nothing was entered.` };
  }

  const q = (v: string) => `"${v.replace(/"/g, '""')}"`;
  const csv = ["Date,Description,Amount", ...txns.map((t) => `${t.date.slice(5, 7)}/${t.date.slice(8, 10)}/${t.date.slice(0, 4)},${q(t.description)},${(t.amountCents / 100).toFixed(2)}`)].join("\n");
  const docName = typeof input.document_name === "string" && input.document_name.trim() ? input.document_name.trim().slice(0, 120) : "bank activity";
  const imp = await importBankCsv(actor, clientId, ledger.id, { fileName: `${docName} (entered by Coetha, ${first} to ${last})`.slice(0, 200), text: csv });
  await audit(prisma, { actorId: actor.id, action: "coetha.bank_activity_entered", entityType: "LedgerAccount", entityId: ledger.id, clientId, details: { from: first, to: last, read: txns.length, added: imp.added, duplicates: imp.duplicates, startingCents: start, endingCents: end, importId: imp.id, source: docName } });
  const rows = await prisma.bankTransaction.findMany({ where: { clientId, importId: imp.id }, orderBy: [{ date: "asc" }, { id: "asc" }], take: 300, select: { id: true, date: true, amountCents: true, description: true, status: true } });
  return {
    entered: true,
    account: registryLabel(acct),
    period: `${first} to ${last}`,
    transactionsGiven: txns.length,
    added: imp.added,
    alreadyInBooks: imp.duplicates,
    balanceAfter: usd(end),
    newRows: rows.map((r) => ({ bankTransactionId: r.id, date: r.date.toISOString().slice(0, 10), amount: r.amountCents / 100, description: r.description, status: r.status === "UNREVIEWED" ? "waiting" : r.status.toLowerCase() })),
    note: "Entered as waiting bank rows (nothing posted). Prepare their postings now with prepare_entries (post_bank_row with each row's bankTransactionId) when Tabitha is asking, or tell staff they're ready to categorize.",
  };
}
