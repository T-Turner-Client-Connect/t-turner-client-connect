import "server-only";
import { prisma } from "@/lib/prisma";
import { audit } from "@/lib/audit";
import type { Actor } from "@/lib/auth/actor";
import { ValidationError } from "./clients";
import { assertLedger, assertManagedBusiness } from "./ledger";
import { sha256Of, staffUploadDocument } from "./documents";
import { manualForLedger } from "./manual-bank";
import { once } from "./office-actions";

/**
 * Statements our office retrieved from the bank (Morning bank pull → "File statement"). Each is
 * filed automatically in the client's Document Vault under the right client, account and period,
 * with the same fields the bookkeeping checklist and reconciliation read:
 * category BOOKKEEPING, docType BANK_STATEMENT / CARD_STATEMENT, year + month (the period's last
 * month), periodStart / periodEnd / reportPeriodType (MONTH or QUARTER), the account
 * (manualBankAccountId, and bookkeepingAccountId when the registry has that GL account).
 * Always STAFF_ONLY: never published to the client portal. The upload goes through the usual
 * malware scan; until it's clean it doesn't count as "on file". Clients never upload here.
 */

export type StatementInput = {
  manualAccountId?: string | null;
  /** An unlinked bank/card GL account row: its office account is linked or created first. */
  ledgerAccountId?: string | null;
  /** MONTH, or QUARTER with `month` = the quarter's last month (3, 6, 9 or 12). */
  periodKind: string;
  /** "YYYY-MM" */
  month: string;
  bytes: Uint8Array;
  originalName: string;
};

export function statementPeriod(kind: string, ym: string, now = new Date()) {
  const m = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(ym);
  if (!m) throw new ValidationError("Choose the statement's month.");
  const year = Number(m[1]), month = Number(m[2]);
  if (year < now.getUTCFullYear() - 15) throw new ValidationError("Check the statement's year.");
  const end = new Date(Date.UTC(year, month, 0, 12));
  if (end.getTime() > now.getTime() + 31 * 86_400_000) throw new ValidationError("That statement period hasn't ended yet.");
  if (kind === "MONTH") return { kind: "MONTH" as const, year, month, start: new Date(Date.UTC(year, month - 1, 1, 12)), end };
  if (kind === "QUARTER") {
    if (month % 3 !== 0) throw new ValidationError("For a quarterly statement, choose the quarter's last month (March, June, September or December).");
    return { kind: "QUARTER" as const, year, month, start: new Date(Date.UTC(year, month - 3, 1, 12)), end };
  }
  throw new ValidationError("Choose whether the statement is monthly or quarterly.");
}

const periodText = (p: ReturnType<typeof statementPeriod>) =>
  p.kind === "QUARTER" ? `Q${p.month / 3} ${p.year}` : new Date(Date.UTC(p.year, p.month - 1, 15)).toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });

/** Files one statement. The same file for the same account and period is never filed twice. */
export async function fileStatement(actor: Actor, clientId: string, input: StatementInput, opts: { idempotencyKey?: string | null; now?: Date } = {}) {
  // Same permission as imports: Banking → Edit (or Admin / assigned) on a business whose books we keep.
  await assertLedger(actor, clientId, "banking", "edit");
  await assertManagedBusiness(clientId);
  const period = statementPeriod(input.periodKind, input.month, opts.now ?? new Date());
  if (!input.bytes.length) throw new ValidationError("Choose the statement PDF.");
  if (new TextDecoder().decode(input.bytes.slice(0, 5)) !== "%PDF-") throw new ValidationError("Upload the statement as a PDF.");

  return once(opts.idempotencyKey, actor, "statement_file", async () => {
    let account = input.manualAccountId ? await prisma.manualBankAccount.findFirst({ where: { id: input.manualAccountId, clientId } }) : null;
    if (input.manualAccountId && !account) throw new ValidationError("That account isn't one of this business's.");
    if (!account) {
      const ledger = input.ledgerAccountId ? await prisma.ledgerAccount.findFirst({ where: { id: input.ledgerAccountId, clientId, subtype: { in: ["BANK", "CREDIT_CARD"] } } }) : null;
      if (!ledger) throw new ValidationError("Choose one of this business's bank or card accounts.");
      account = await manualForLedger(prisma, actor, clientId, ledger);
    }
    if (account.archivedAt) throw new ValidationError(`${account.name} is archived.`);

    // The same file already filed for this account and period: nothing new to do.
    const sha256 = sha256Of(input.bytes);
    const existing = await prisma.document.findFirst({ where: { clientId, manualBankAccountId: account.id, deletedAt: null, periodStart: period.start, periodEnd: period.end, file: { sha256 } } });
    if (existing) return { id: existing.id, status: "ALREADY_ON_FILE" as const, document: existing, account };

    const card = account.kind === "CREDIT_CARD";
    const label = `${account.name}${account.last4 ? ` ••${account.last4}` : ""}`;
    const doc = await staffUploadDocument(actor, {
      clientId, category: "BOOKKEEPING", visibility: "STAFF_ONLY", notify: false,
      title: `${card ? "Card" : "Bank"} statement — ${label} — ${periodText(period)}`,
      docType: card ? "CARD_STATEMENT" : "BANK_STATEMENT", year: period.year, month: period.month,
      coverage: { kind: period.kind, year: period.year, month: period.kind === "MONTH" ? period.month : null, start: period.start, end: period.end },
      bytes: input.bytes, originalName: input.originalName,
    });
    // The account it belongs to: our office account, and the registry account on the same GL account (reconciliation reads that).
    const registry = account.ledgerAccountId ? await prisma.bookkeepingAccount.findFirst({ where: { clientId, ledgerAccountId: account.ledgerAccountId }, select: { id: true } }) : null;
    const filed = await prisma.document.update({ where: { id: doc.id }, data: { manualBankAccountId: account.id, bookkeepingAccountId: registry?.id ?? null, month: period.month } });
    await audit(prisma, { actorId: actor.id, action: "bookkeeping.statement_filed", entityType: "Document", entityId: doc.id, clientId, details: { manualBankAccountId: account.id, period: `${period.kind}:${input.month}`, scan: doc.scanStatus } });
    return { id: filed.id, status: "FILED" as const, document: filed, account };
  });
}
