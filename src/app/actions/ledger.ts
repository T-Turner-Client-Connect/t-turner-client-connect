"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth/session";
import { run, str, type ActionState } from "@/lib/action";
import { ValidationError } from "@/lib/services/clients";
import {
  addAccount, categorizeBankTransaction, closeBooksThrough, excludeBankTransaction, importBankCsv, includeBankTransaction, postJournalEntry, postOpeningBalances,
  reconcileAccount, reopenBooks, reverseEntry, setupLedger, updateAccount, usd, type Basis,
} from "@/lib/services/ledger";
import { addRule } from "@/lib/services/ledger-review";
import type { FileBalanceResult } from "@/lib/services/manual-bank";
import { RepeatedSubmission } from "@/lib/services/office-actions";
import { fmtDateTime } from "@/lib/format";
import { clearBankFlag } from "@/lib/services/ledger";
import { completeBankLink, completeBankReauth, disconnectBank, mapBankAccount, retrieveNow, startBankLink, startBankReauth } from "@/lib/services/banking";
import { addCustomer, addRecurringInvoice, createInvoice, generateRecurringDrafts, issueInvoice, recordInvoicePayment, voidInvoice } from "@/lib/services/client-invoicing";

const refresh = (clientId: string) => revalidatePath(`/bookkeeping/${clientId}/books`);

export async function setupLedgerAction(clientId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    await setupLedger(actor, clientId, { basis: (str(fd, "basis") || "CASH") as Basis, fiscalYearStartMonth: Number(str(fd, "fy") || 1) });
    refresh(clientId);
    return "Books set up with the standard chart of accounts.";
  });
}

export async function addAccountAction(clientId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    const a = await addAccount(actor, clientId, { code: str(fd, "code"), name: str(fd, "name"), type: str(fd, "type"), subtype: str(fd, "subtype") || null, institution: str(fd, "institution"), last4: str(fd, "last4") });
    refresh(clientId);
    return `Account ${a.code} added.`;
  });
}

export async function toggleAccountAction(clientId: string, accountId: string, active: boolean, _prev: ActionState): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    await updateAccount(actor, clientId, accountId, { active });
    refresh(clientId);
    return active ? "Account reactivated." : "Account deactivated. Its history stays.";
  });
}

export async function openingBalancesAction(clientId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    const balances = fd.getAll("accountId").map((id, i) => ({ accountId: String(id), amount: String(fd.getAll("amount")[i] ?? "") }));
    await postOpeningBalances(actor, clientId, { date: str(fd, "date"), balances });
    refresh(clientId);
    return "Opening balances posted.";
  });
}

export async function journalEntryAction(clientId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    const ids = fd.getAll("lineAccount").map(String);
    const lines = ids.map((accountId, i) => ({ accountId, debit: String(fd.getAll("lineDebit")[i] ?? ""), credit: String(fd.getAll("lineCredit")[i] ?? ""), description: String(fd.getAll("lineDesc")[i] ?? "") }));
    const basis = (str(fd, "basis") || "BOTH") as "BOTH" | "CASH_ONLY" | "ACCRUAL_ONLY";
    const e = await postJournalEntry(actor, clientId, { date: str(fd, "date"), memo: str(fd, "memo"), lines, adjusting: fd.get("adjusting") === "on", basis });
    refresh(clientId);
    return `Entry posted (${usd(e.lines.reduce((n, l) => n + l.debitCents, 0))}).`;
  });
}

export async function reverseEntryAction(clientId: string, entryId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    await reverseEntry(actor, clientId, entryId, { date: str(fd, "date"), reason: str(fd, "reason") });
    refresh(clientId);
    return "Reversal posted. Both entries stay in the history.";
  });
}

/** What happened to the file's running balance (if it had one), for the import message. */
function fileBalanceText(b: FileBalanceResult | null) {
  if (!b) return "";
  if (b.status === "RECORDED") return ` Balance ${usd(b.balanceCents)} as of ${fmtDateTime(b.asOf)} recorded for the client's dashboard.`;
  if (b.status === "DUPLICATE") return " The file's balance was already recorded.";
  return "reason" in b ? ` ${b.reason}` : "";
}

export async function importBankAction(clientId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    const f = fd.get("file");
    if (!(f instanceof File) || f.size === 0) throw new ValidationError("Choose the statement CSV file.");
    if (f.size > 5_000_000) throw new ValidationError("That file is too large. Import one statement at a time.");
    let r;
    try {
      r = await importBankCsv(actor, clientId, str(fd, "accountId"), { fileName: f.name, text: await f.text() }, { idempotencyKey: str(fd, "idempotencyKey") || null });
    } catch (err) {
      // The same form sent twice (double-click): already imported once.
      if (err instanceof RepeatedSubmission) return err.message;
      throw err;
    }
    refresh(clientId);
    if (r.balance) revalidatePath(`/bookkeeping/${clientId}/banking`);
    return `Imported ${r.added} new transaction${r.added === 1 ? "" : "s"}${r.duplicates ? `; ${r.duplicates} already imported (skipped)` : ""}${r.problems.length ? `; ${r.problems.length} row(s) couldn't be read` : ""}.${fileBalanceText(r.balance)}`;
  });
}

export async function categorizeAction(clientId: string, txnId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    const r = await categorizeBankTransaction(actor, clientId, txnId, { accountId: str(fd, "accountId"), memo: str(fd, "memo") });
    refresh(clientId);
    return r.matchedTransferId ? "Posted. The matching row on the other account was linked, so the transfer is counted once." : "Posted.";
  });
}

export async function excludeAction(clientId: string, txnId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    await excludeBankTransaction(actor, clientId, txnId, str(fd, "reason"));
    refresh(clientId);
    return "Excluded, with your reason.";
  });
}

export async function includeAction(clientId: string, txnId: string, _prev: ActionState): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    await includeBankTransaction(actor, clientId, txnId);
    refresh(clientId);
    return "Back in review.";
  });
}

export async function reconcileAction(clientId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    const r = await reconcileAccount(actor, clientId, str(fd, "accountId"), { statementDate: str(fd, "statementDate"), statementBalance: str(fd, "statementBalance") });
    refresh(clientId);
    if (!r.reconciled) throw new ValidationError(`Not reconciled: books show ${usd(r.ledgerCents)}, the statement shows ${usd(r.statementCents)} (difference ${usd(r.difference)})${r.unreviewed ? `, and ${r.unreviewed} transaction(s) still need review` : ""}.`);
    return `Reconciled: ${usd(r.statementCents)} matches the statement to the cent.`;
  });
}

export async function addRuleAction(clientId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    await addRule(actor, clientId, { matchText: str(fd, "matchText"), direction: (str(fd, "direction") || "ANY") as "IN" | "OUT" | "ANY", accountId: str(fd, "accountId") });
    refresh(clientId);
    return "Rule saved. It suggests a category; staff still post each transaction.";
  });
}

export async function closeBooksAction(clientId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    await closeBooksThrough(actor, clientId, str(fd, "through"));
    refresh(clientId);
    return "Books closed. Nothing on or before that date can change; corrections go in an open period.";
  });
}

export async function reopenBooksAction(clientId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    await reopenBooks(actor, clientId, { through: str(fd, "through") || null, reason: str(fd, "reason") });
    refresh(clientId);
    return "Reopened. The reason is in the history.";
  });
}

// --- Client Invoicing (foundation) ---

export async function addCustomerAction(clientId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    await addCustomer(actor, clientId, { name: str(fd, "name"), email: str(fd, "email"), phone: str(fd, "phone") });
    refresh(clientId);
    return "Customer added.";
  });
}

export async function createInvoiceAction(clientId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    const descs = fd.getAll("lineDesc").map(String);
    const lines = descs.map((description, i) => ({ description, quantity: Number(fd.getAll("lineQty")[i] || 1), unitPrice: String(fd.getAll("linePrice")[i] ?? ""), incomeAccountId: String(fd.getAll("lineIncome")[i] ?? "") })).filter((l) => l.unitPrice.trim());
    const inv = await createInvoice(actor, clientId, { customerId: str(fd, "customerId"), issueDate: str(fd, "issueDate"), dueDate: str(fd, "dueDate"), lines, memo: str(fd, "memo") });
    refresh(clientId);
    return `Draft ${inv.number} created (${usd(inv.totalCents)}). Review it, then issue it.`;
  });
}

export async function issueInvoiceAction(clientId: string, invoiceId: string, _prev: ActionState): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    const i = await issueInvoice(actor, clientId, invoiceId);
    refresh(clientId);
    return `${i.number} issued. Emailing invoices to customers comes in a later phase.`;
  });
}

export async function recordInvoicePaymentAction(clientId: string, invoiceId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    const p = await recordInvoicePayment(actor, clientId, invoiceId, { amount: str(fd, "amount"), fee: str(fd, "fee"), receivedOn: str(fd, "receivedOn"), method: str(fd, "method"), reference: str(fd, "reference") });
    refresh(clientId);
    return `Payment recorded — receipt ${p.receiptNumber}.`;
  });
}

export async function voidInvoiceAction(clientId: string, invoiceId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    await voidInvoice(actor, clientId, invoiceId, { date: str(fd, "date"), reason: str(fd, "reason") });
    refresh(clientId);
    return "Invoice voided; it stays in the list with your reason.";
  });
}

export async function addRecurringAction(clientId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    await addRecurringInvoice(actor, clientId, {
      customerId: str(fd, "customerId"), cadence: str(fd, "cadence") as "MONTHLY" | "QUARTERLY" | "YEARLY", startDate: str(fd, "startDate"), dueDays: Number(str(fd, "dueDays") || 15),
      lines: [{ description: str(fd, "description"), unitPrice: str(fd, "price"), incomeAccountId: str(fd, "incomeAccountId") }],
    });
    refresh(clientId);
    return "Recurring invoice saved. It creates drafts for review; nothing is sent automatically.";
  });
}

export async function generateDraftsAction(clientId: string, _prev: ActionState): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    const made = await generateRecurringDrafts(actor, clientId);
    refresh(clientId);
    return made.length ? `Created draft${made.length === 1 ? "" : "s"} ${made.join(", ")}.` : "No recurring invoices are due.";
  });
}

// --- Automatic bank retrieval (sandbox, or live with Tabitha's switch) ---

/** A Link token for a new connection, or (with reauthConnectionId) for the client to sign in again. */
export async function bankLinkTokenAction(clientId: string, reauthConnectionId?: string): Promise<{ token?: string; error?: string }> {
  const actor = await requireUser();
  try {
    return { token: (reauthConnectionId ? await startBankReauth(actor, clientId, reauthConnectionId) : await startBankLink(actor, clientId)).link_token };
  } catch (e) {
    return { error: e instanceof Error && (e.name === "PlaidError" || e.name === "ValidationError" || e.name === "ForbiddenError") ? e.message : "Couldn't start the bank connection." };
  }
}

export async function completeBankReauthAction(clientId: string, connectionId: string, _prev: ActionState): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    await completeBankReauth(actor, clientId, connectionId);
    refresh(clientId);
    return "Reconnected. Automatic retrieval resumes with the next run (or press Retrieve now).";
  });
}

export async function completeBankLinkAction(clientId: string, publicToken: string, institutionName: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    const c = await completeBankLink(actor, clientId, { publicToken, institutionName, authorizedByName: str(fd, "authorizedByName"), authorizationMethod: str(fd, "method") as "CLIENT_PRESENT" | "CLIENT_PORTAL" | "WRITTEN_AUTHORIZATION", confirmed: fd.get("confirm") === "on" });
    refresh(clientId);
    return `Connected (${c.environment === "PRODUCTION" ? "live" : "sandbox"}): ${c.accounts.length} account${c.accounts.length === 1 ? "" : "s"}. Choose which ledger account each one feeds.`;
  });
}

export async function mapBankAccountAction(clientId: string, connectionAccountId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    await mapBankAccount(actor, clientId, connectionAccountId, str(fd, "ledgerAccountId") || null);
    refresh(clientId);
    return "Saved.";
  });
}

export async function retrieveNowAction(clientId: string, _prev: ActionState): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    const r = await retrieveNow(actor, clientId);
    refresh(clientId);
    return `Retrieved: ${r.added} new, ${r.matched} already imported from statements (linked, not added), ${r.skipped} skipped (pending or unmapped)${r.flagged ? `, ${r.flagged} flagged for review` : ""}. Nothing was posted.`;
  });
}

export async function disconnectBankAction(clientId: string, connectionId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    await disconnectBank(actor, clientId, connectionId, str(fd, "reason"));
    refresh(clientId);
    return "Disconnected. Retrieved transactions stay in the books' history.";
  });
}

export async function clearBankFlagAction(clientId: string, txnId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    await clearBankFlag(actor, clientId, txnId, str(fd, "note"));
    refresh(clientId);
    return "Flag cleared with your note.";
  });
}
