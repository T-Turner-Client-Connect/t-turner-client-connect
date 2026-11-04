import "server-only";
import { prisma } from "@/lib/prisma";
import { audit } from "@/lib/audit";
import { decryptSecret } from "@/lib/crypto";
import { currentPlaidMode, envOfMode, liabilitiesFlag, liabilitiesGet, PlaidError, statementsDownload, statementsFlag, statementsList } from "@/lib/plaid";
import { REQUEST_FROM_CLIENT, statementSource, type StatementQuery, type StatementResult, type StatementSource } from "@/lib/statement-retrieval";

/**
 * Plaid Statements and Liabilities for connected accounts. Both stay off until Tabitha enables
 * them: the env flag (PLAID_STATEMENTS_ENABLED / PLAID_LIABILITIES_ENABLED) AND Plaid being usable
 * for the connection's environment (production needs the "Live bank connections" switch).
 * Nothing here posts or changes the books; it only supplies statements and statement balances
 * that Coetha uses to prepare reconciliations.
 */

async function usableToken(connectionId: string) {
  const c = await prisma.bankConnection.findUnique({ where: { id: connectionId } });
  if (!c || c.status === "DISCONNECTED" || !c.accessTokenEnc) return null;
  const env = envOfMode(await currentPlaidMode());
  if (!env || env !== c.environment) return null;
  return { conn: c, token: decryptSecret(c.accessTokenEnc) };
}

/** Plaid Statements as a StatementSource: the statement PDF for one account and month, when the bank provides it. */
export const PLAID_STATEMENTS: StatementSource = {
  name: "plaid-statements",
  async fetchMonthly(q: StatementQuery): Promise<StatementResult> {
    if (!statementsFlag()) return { available: false, reason: "Plaid Statements is off (PLAID_STATEMENTS_ENABLED)." };
    const u = await usableToken(q.connectionId);
    if (!u) return { available: false, reason: "Plaid isn't available for this connection right now." };
    try {
      const list = await statementsList(u.token);
      const acct = list.accounts?.find((a) => a.account_id === q.providerAccountId);
      const st = acct?.statements?.find((s) => s.year === q.year && s.month === q.month);
      if (!st) return { available: false, reason: "The bank hasn't provided this statement through Plaid." };
      const pdf = await statementsDownload(u.token, st.statement_id);
      // Plaid returns the PDF; the ending balance isn't in the list, so staff (or Liabilities) supply it.
      return { available: true, pdf, statementDate: st.date_posted ?? `${q.year}-${String(q.month).padStart(2, "0")}-28`, endingBalanceCents: null };
    } catch (err) {
      return { available: false, reason: err instanceof PlaidError ? `Plaid: ${err.code}` : "Statement retrieval failed." };
    }
  },
};

/** The statement source Coetha uses: a test/explicit override, else Plaid Statements when enabled, else request from the client. */
export function activeStatementSource(): StatementSource {
  const o = statementSource();
  if (o !== REQUEST_FROM_CLIENT) return o;
  return statementsFlag() ? PLAID_STATEMENTS : REQUEST_FROM_CLIENT;
}

const cents = (n: number | null | undefined) => (n == null ? null : Math.round(n * 100));
const day = (s: string | null | undefined) => (s && /^\d{4}-\d{2}-\d{2}$/.test(s) ? new Date(`${s}T00:00:00Z`) : null);

/**
 * Plaid Liabilities: for credit cards and eligible loans, the last statement balance and date, APR,
 * minimum payment, next due date and overdue flag, stored on the connected account. Coetha uses
 * the last statement balance as the reconciliation's ending balance and flags overdue payments.
 */
export async function refreshLiabilities(connectionId: string) {
  if (!liabilitiesFlag()) return { updated: 0, skipped: "off" as const };
  const u = await usableToken(connectionId);
  if (!u) return { updated: 0, skipped: "unavailable" as const };
  const res = await liabilitiesGet(u.token);
  const accts = await prisma.bankConnectionAccount.findMany({ where: { connectionId } });
  const byProvider = new Map(accts.map((a) => [a.providerAccountId, a]));
  let updated = 0;
  const put = async (accountId: string | null, data: Parameters<typeof prisma.bankConnectionAccount.update>[0]["data"]) => {
    const a = accountId ? byProvider.get(accountId) : undefined;
    if (!a) return;
    await prisma.bankConnectionAccount.update({ where: { id: a.id }, data: { ...data, liabilitiesAt: new Date() } });
    updated++;
  };
  for (const c of res.liabilities?.credit ?? []) {
    const apr = c.aprs?.find((x) => x.apr_type === "purchase_apr") ?? c.aprs?.[0];
    await put(c.account_id, { aprPercent: apr?.apr_percentage ?? null, minimumPaymentCents: cents(c.minimum_payment_amount), nextPaymentDueDate: day(c.next_payment_due_date), lastStatementBalanceCents: cents(c.last_statement_balance), lastStatementDate: day(c.last_statement_issue_date), liabilityOverdue: c.is_overdue ?? null });
  }
  for (const m of res.liabilities?.mortgage ?? []) {
    await put(m.account_id, { aprPercent: m.interest_rate?.percentage ?? null, minimumPaymentCents: cents(m.next_monthly_payment), nextPaymentDueDate: day(m.next_payment_due_date), liabilityOverdue: m.past_due_amount ? m.past_due_amount > 0 : null });
  }
  for (const s of res.liabilities?.student ?? []) {
    await put(s.account_id, { aprPercent: s.interest_rate_percentage ?? null, minimumPaymentCents: cents(s.minimum_payment_amount), nextPaymentDueDate: day(s.next_payment_due_date), lastStatementBalanceCents: cents(s.last_statement_balance), lastStatementDate: day(s.last_statement_issue_date), liabilityOverdue: s.is_overdue ?? null });
  }
  await audit(prisma, { actorId: null, action: "banking.liabilities_refreshed", entityType: "BankConnection", entityId: connectionId, clientId: u.conn.clientId, details: { updated } });
  return { updated };
}
