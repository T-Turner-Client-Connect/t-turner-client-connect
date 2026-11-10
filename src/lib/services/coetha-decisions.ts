import "server-only";
import { prisma } from "@/lib/prisma";
import { audit } from "@/lib/audit";
import type { Actor } from "@/lib/auth/actor";
import { isPrimaryOwner } from "@/lib/auth/permissions";
import { ValidationError } from "./clients";
import { assertLedger, bookOf, ymdOf } from "./ledger";
import { decideCoethaProposals, scrub } from "./coetha";

/**
 * "Apply These Decisions": Coetha turns Tabitha's accounting decisions into the entries
 * themselves, so nobody re-enters them by hand.
 *
 * - Nothing new is posted here. Each decision becomes an ordinary Coetha proposal (the same
 *   CATEGORY and ADJUSTING_ENTRY proposals a Coetha run makes) in the existing approval list.
 *   Approving one goes through the existing path (approveCoethaProposal): Tabitha only, the
 *   bank row is posted once (never a new bank transaction), each entry posts once (sourceKey),
 *   closed months are refused, and everything is audited. Corrections are reversals.
 * - Sources: (1) Ask Coetha, only when Tabitha herself is asking (prepare_entries tool, for
 *   decisions she stated), and (2) the document reader's "Routine" checks that are matched to a
 *   waiting bank row with a proposed account. Uncertain items are never prepared; they stay on
 *   hold until she decides.
 * - Prepared decisions carry model DECISIONS_MODEL, so a later "Run Coetha" never replaces them.
 */

export const DECISIONS_MODEL = "decisions";
const MAX_ITEMS = 60;

export type DecisionItem =
  | { type: "post_bank_row"; ref?: string; bankTransactionId?: string; date?: string; amount?: number; accountCode: string; memo?: string; reason?: string }
  | { type: "journal_entry"; date: string; memo: string; reason?: string; lines: { accountCode: string; debit?: number | null; credit?: number | null; description?: string | null }[] };

export type PrepareResult = { index: number; ok: boolean; message: string; proposalId?: string };

const cents = (n: unknown) => (typeof n === "number" && Number.isFinite(n) ? Math.round(n * 100) : 0);
const isYmd = (s: unknown): s is string => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`));
const usd = (c: number) => `$${(Math.abs(c) / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const clip = (s: unknown, n: number) => (typeof s === "string" ? s.trim().slice(0, n) : "");

/** The waiting rows in the same order Ask Coetha numbers them (W1, W2, ...). */
async function waitingRefs(clientId: string) {
  const rows = await prisma.bankTransaction.findMany({ where: { clientId, status: "UNREVIEWED" }, orderBy: [{ date: "asc" }, { id: "asc" }], take: 1000, select: { id: true } });
  return new Map(rows.map((r, i) => [`W${i + 1}`, r.id]));
}

/**
 * Saves decisions as proposals awaiting Tabitha's Approve & Post. Each item is checked on its
 * own; a bad item is reported and skipped, the others are kept. Changes no books.
 */
export async function prepareDecisions(actor: Actor, clientId: string, items: DecisionItem[], source: "chat" | "documents", note?: string): Promise<PrepareResult[]> {
  await assertLedger(actor, clientId);
  const book = await bookOf(clientId);
  if (!Array.isArray(items) || !items.length) throw new ValidationError("There are no entries to prepare.");
  if (items.length > MAX_ITEMS) throw new ValidationError(`Prepare at most ${MAX_ITEMS} entries at a time.`);
  const accounts = await prisma.ledgerAccount.findMany({ where: { clientId }, select: { id: true, code: true, name: true, type: true, subtype: true, active: true } });
  const byCode = new Map(accounts.map((a) => [a.code, a]));
  const refs = items.some((i) => i.type === "post_bank_row" && i.ref) ? await waitingRefs(clientId) : new Map<string, string>();
  const locked = book.lockedThrough ? ymdOf(book.lockedThrough) : null;
  const opening = book.openingDate ? ymdOf(book.openingDate) : null;
  const openDateProblem = (d: string) => (locked && d <= locked ? `the books are closed through ${locked}` : opening && d < opening ? `it's before the opening balances (${opening})` : null);
  const account = (code: unknown) => {
    const a = byCode.get(String(code ?? "").trim().split(/\s+/)[0]);
    if (!a) return { error: `account ${String(code ?? "").slice(0, 20)} isn't in this business's chart of accounts` };
    if (!a.active) return { error: `account ${a.code} is inactive` };
    if (a.subtype === "OPENING_BALANCE") return { error: "nothing is posted to Opening Balance Equity this way" };
    return { a };
  };

  const run = await prisma.coethaRun.create({ data: { clientId, trigger: source === "chat" ? "DECISIONS" : "DOCUMENTS", startedById: actor.id, model: DECISIONS_MODEL, status: "OK", finishedAt: new Date() } });
  const results: PrepareResult[] = [];
  let made = 0;
  for (const [index, it] of items.entries()) {
    const fail = (message: string) => results.push({ index, ok: false, message });
    const reason = clip(it.reason, 600) || (source === "chat" ? "Tabitha's decision in Ask Coetha" : "Routine check matched by the document reader");
    if (it.type === "post_bank_row") {
      // W-numbers move as rows are posted, so a row named by its W-number must also give its date and amount.
      if (!it.bankTransactionId && (it.date === undefined || it.amount === undefined)) { fail(`${it.ref ?? "That row"}: give the row's date and amount with its W-number, so the right row is posted.`); continue; }
      const id = it.bankTransactionId ?? (it.ref ? refs.get(it.ref.trim().toUpperCase()) : undefined);
      if (!id) { fail(`${it.ref ?? "That row"} isn't one of the waiting bank rows (it may already be posted).`); continue; }
      const t = await prisma.bankTransaction.findFirst({ where: { id, clientId }, include: { account: { select: { name: true } } } });
      if (!t || t.status !== "UNREVIEWED") { fail(`${it.ref ?? "That row"} is already posted or excluded, so it wasn't prepared again.`); continue; }
      // The row Coetha meant must be the row found: same date and amount, or nothing is prepared.
      if (it.date !== undefined && it.date !== ymdOf(t.date)) { fail(`${it.ref ?? "That row"} is dated ${ymdOf(t.date)}, not ${it.date}; nothing was prepared for it.`); continue; }
      if (it.amount !== undefined && Math.abs(cents(it.amount)) !== Math.abs(t.amountCents)) { fail(`${it.ref ?? "That row"} is ${usd(t.amountCents)}, not ${usd(cents(it.amount))}; nothing was prepared for it.`); continue; }
      const got = account(it.accountCode);
      if ("error" in got) { fail(`${it.ref ?? "That row"}: ${got.error}.`); continue; }
      if (got.a.id === t.accountId) { fail(`${it.ref ?? "That row"}: choose an account other than the bank account itself.`); continue; }
      const date = ymdOf(t.date);
      const closed = openDateProblem(date);
      if (closed) { fail(`${it.ref ?? "That row"} (${date}) can't be posted: ${closed}. Use an adjusting entry in an open month instead.`); continue; }
      const same = await prisma.coethaProposal.findFirst({ where: { clientId, kind: "CATEGORY", bankTransactionId: t.id, status: "PROPOSED", model: DECISIONS_MODEL, approvedAccountId: null, payload: { path: ["accountId"], equals: got.a.id } } });
      if (same) { results.push({ index, ok: true, message: `${it.ref ?? ymdOf(t.date)} ${usd(t.amountCents)} → ${got.a.code} ${got.a.name} was already prepared.`, proposalId: same.id }); continue; }
      const p = await prisma.$transaction(async (tx) => {
        // Tabitha's decision replaces any other open draft for this row (a run's, the rules', the statements').
        await tx.coethaProposal.updateMany({ where: { clientId, kind: "CATEGORY", bankTransactionId: t.id, status: "PROPOSED" }, data: { status: "SUPERSEDED", decisionNote: "Replaced by Tabitha's decision (Apply These Decisions)." } });
        return tx.coethaProposal.create({
          data: {
            clientId, runId: run.id, kind: "CATEGORY", bankTransactionId: t.id, confidence: 1, reason, model: DECISIONS_MODEL, inputHash: `${source}:${run.id}`,
            payload: { bankTransactionId: t.id, date, amountCents: t.amountCents, description: t.description, bankAccountName: t.account.name, accountId: got.a.id, accountCode: got.a.code, accountName: got.a.name, memo: clip(it.memo, 250) || null, source, ref: it.ref ?? null, note: note ?? null },
          },
        });
      });
      made++;
      results.push({ index, ok: true, message: `${it.ref ?? date} ${date} ${usd(t.amountCents)} → ${got.a.code} ${got.a.name}`, proposalId: p.id });
      continue;
    }
    if (it.type === "journal_entry") {
      if (!isYmd(it.date)) { fail("An entry needs a valid date (YYYY-MM-DD)."); continue; }
      const closed = openDateProblem(it.date);
      if (closed) { fail(`The entry dated ${it.date} can't be posted: ${closed}. Date it in an open month.`); continue; }
      const lines: { accountId: string; accountCode: string; accountName: string; debitCents: number; creditCents: number; description: string }[] = [];
      let bad: string | null = null;
      for (const l of it.lines ?? []) {
        const got = account(l.accountCode);
        if ("error" in got) { bad = got.error ?? "that account can't be used"; break; }
        const debitCents = cents(l.debit), creditCents = cents(l.credit);
        if (debitCents < 0 || creditCents < 0 || (debitCents > 0) === (creditCents > 0)) { bad = "each line is either a debit or a credit, with a positive amount"; break; }
        lines.push({ accountId: got.a.id, accountCode: got.a.code, accountName: got.a.name, debitCents, creditCents, description: clip(l.description, 200) });
      }
      const dr = lines.reduce((n, l) => n + l.debitCents, 0);
      const cr = lines.reduce((n, l) => n + l.creditCents, 0);
      if (!bad && lines.length < 2) bad = "an entry needs at least two lines";
      if (!bad && dr !== cr) bad = `debits (${usd(dr)}) and credits (${usd(cr)}) must be equal`;
      if (bad) { fail(`Entry "${clip(it.memo, 80)}": ${bad}; nothing was prepared.`); continue; }
      const memo = clip(it.memo, 250) || "Adjusting entry";
      const key = JSON.stringify([it.date, lines.map((l) => [l.accountId, l.debitCents, l.creditCents])]);
      const existing = await prisma.coethaProposal.findMany({ where: { clientId, kind: "ADJUSTING_ENTRY", model: DECISIONS_MODEL, status: { in: ["PROPOSED", "APPROVED"] } }, select: { id: true, status: true, payload: true } });
      const dup = existing.find((e) => (e.payload as { key?: string }).key === key);
      if (dup) { results.push({ index, ok: dup.status === "PROPOSED", message: dup.status === "APPROVED" ? `"${memo}" was already approved and posted, so it wasn't prepared again.` : `"${memo}" was already prepared.`, proposalId: dup.id }); continue; }
      const p = await prisma.coethaProposal.create({
        data: { clientId, runId: run.id, kind: "ADJUSTING_ENTRY", confidence: 1, reason, model: DECISIONS_MODEL, inputHash: `${source}:${run.id}`, payload: { date: it.date, memo, totalCents: dr, lines, key, source, note: note ?? null } },
      });
      made++;
      results.push({ index, ok: true, message: `${it.date} "${memo}" ${usd(dr)}: ${lines.map((l) => `${l.debitCents ? "Dr" : "Cr"} ${l.accountCode}`).join(", ")}`, proposalId: p.id });
      continue;
    }
    fail("Unknown kind of entry.");
  }
  await prisma.coethaRun.update({ where: { id: run.id }, data: { proposals: made, transactions: items.length } });
  await audit(prisma, { actorId: actor.id, action: "coetha.decisions_prepared", entityType: "CoethaRun", entityId: run.id, clientId, details: { source, items: items.length, prepared: made, skipped: results.filter((r) => !r.ok).length } });
  return results;
}

/** The checks the document reader marked "Routine", matched to a waiting bank row, with a proposed account. */
export async function prepareFromDocument(actor: Actor, clientId: string, jobId: string) {
  await assertLedger(actor, clientId);
  const job = await prisma.coethaDocJob.findFirst({ where: { id: jobId, clientId }, select: { id: true, name: true } });
  if (!job) throw new ValidationError("That document isn't on file for this business.");
  const findings = await prisma.coethaDocFinding.findMany({ where: { jobId, clientId, kind: "CHECK", reviewGroup: "ROUTINE", bankTransactionId: { not: null }, proposedAccount: { not: null } }, orderBy: [{ page: "asc" }, { seq: "asc" }] });
  const rows = await prisma.bankTransaction.findMany({ where: { clientId, id: { in: findings.map((f) => f.bankTransactionId!) }, status: "UNREVIEWED" }, select: { id: true } });
  const waiting = new Set(rows.map((r) => r.id));
  const items: DecisionItem[] = findings
    .filter((f) => waiting.has(f.bankTransactionId!))
    .map((f) => ({ type: "post_bank_row", bankTransactionId: f.bankTransactionId!, accountCode: f.proposedAccount!, memo: [f.checkNumber ? `Check #${f.checkNumber}` : "", f.payee ?? ""].filter(Boolean).join(" ") || undefined, reason: f.reason ?? undefined }));
  if (!items.length) throw new ValidationError("No routine checks from this document are waiting to be posted. Checks needing documents or your judgment stay on hold until you decide them.");
  const results = await prepareDecisions(actor, clientId, items, "documents", job.name);
  return { prepared: results.filter((r) => r.ok).length, skipped: results.filter((r) => !r.ok) };
}

// --- The Apply These Decisions card ----------------------------------------------------------------

const NATURAL_DEBIT = new Set(["ASSET", "EXPENSE"]);
const IMPACT_ORDER = ["INCOME", "EXPENSE", "ASSET", "LIABILITY", "EQUITY"] as const;
export const IMPACT_LABEL: Record<(typeof IMPACT_ORDER)[number], string> = { INCOME: "Income", EXPENSE: "Expenses", ASSET: "Assets (bank and other)", LIABILITY: "Liabilities", EQUITY: "Owner's equity" };

/** Every prepared decision waiting for Approve & Post, with its lines and the effect on the statements. */
export async function applyDecisionsView(actor: Actor, clientId: string) {
  await assertLedger(actor, clientId);
  const open = await prisma.coethaProposal.findMany({ where: { clientId, model: DECISIONS_MODEL, status: "PROPOSED", kind: { in: ["CATEGORY", "ADJUSTING_ENTRY"] } }, orderBy: { createdAt: "asc" }, take: 300 });
  const accounts = await prisma.ledgerAccount.findMany({ where: { clientId }, select: { id: true, code: true, name: true, type: true } });
  const acct = new Map(accounts.map((a) => [a.id, a]));
  const bankIds = open.map((p) => p.bankTransactionId).filter((x): x is string => !!x);
  const bank = new Map((await prisma.bankTransaction.findMany({ where: { clientId, id: { in: bankIds } }, select: { id: true, accountId: true, status: true } })).map((b) => [b.id, b]));
  const impact = new Map<string, number>();
  const entries = open.map((p) => {
    let lines: { accountId: string; debitCents: number; creditCents: number }[] = [];
    let date = "", title = "", amountCents = 0, stale = false;
    if (p.kind === "CATEGORY") {
      const d = p.payload as { date: string; amountCents: number; description: string; accountId: string; memo?: string | null };
      const b = bank.get(p.bankTransactionId ?? "");
      stale = !b || b.status !== "UNREVIEWED";
      const amt = Math.abs(d.amountCents);
      lines = b ? (d.amountCents > 0 ? [{ accountId: b.accountId, debitCents: amt, creditCents: 0 }, { accountId: d.accountId, debitCents: 0, creditCents: amt }] : [{ accountId: d.accountId, debitCents: amt, creditCents: 0 }, { accountId: b.accountId, debitCents: 0, creditCents: amt }]) : [];
      date = d.date; amountCents = amt; title = scrub(d.memo || d.description, 120);
    } else {
      const d = p.payload as { date: string; memo: string; totalCents: number; lines: { accountId: string; debitCents: number; creditCents: number }[] };
      lines = d.lines; date = d.date; amountCents = d.totalCents; title = scrub(d.memo, 120);
    }
    if (!stale) for (const l of lines) {
      const a = acct.get(l.accountId);
      if (!a) continue;
      const signed = NATURAL_DEBIT.has(a.type) ? l.debitCents - l.creditCents : l.creditCents - l.debitCents;
      impact.set(a.type, (impact.get(a.type) ?? 0) + signed);
    }
    const source = (p.payload as { source?: string }).source === "documents" ? "From a document" : "From your decision in Ask Coetha";
    return {
      id: p.id, kind: p.kind as "CATEGORY" | "ADJUSTING_ENTRY", date, title, amountCents, reason: p.reason, source, stale,
      bankRow: p.kind === "CATEGORY",
      lines: lines.map((l) => { const a = acct.get(l.accountId); return { account: a ? `${a.code} ${a.name}` : "?", debitCents: l.debitCents, creditCents: l.creditCents }; }),
    };
  });
  return {
    entries,
    impact: IMPACT_ORDER.filter((t) => (impact.get(t) ?? 0) !== 0).map((t) => ({ type: t, label: IMPACT_LABEL[t], cents: impact.get(t)! })),
    canApprove: await isPrimaryOwner(actor.id),
  };
}

/** Approve & Post the chosen decisions (Tabitha only, through the existing approval path). Unchosen ones stay on hold. */
export async function approveDecisions(actor: Actor, clientId: string, ids: string[]) {
  const chosen = [...new Set(ids)].filter(Boolean);
  if (!chosen.length) throw new ValidationError("Tick the entries you approve first.");
  // Only prepared decisions of this business go through this button.
  const mine = await prisma.coethaProposal.findMany({ where: { id: { in: chosen }, clientId, model: DECISIONS_MODEL }, select: { id: true } });
  if (mine.length !== chosen.length) throw new ValidationError("One of those entries isn't a prepared decision for this business.");
  const results = await decideCoethaProposals(actor, clientId, "APPROVE", chosen.map((id) => ({ id })));
  await audit(prisma, { actorId: actor.id, action: "coetha.decisions_approved", entityType: "LedgerBook", entityId: clientId, clientId, details: { chosen: chosen.length, posted: results.filter((r) => r.result === "APPROVED").length, skipped: results.filter((r) => r.result === "SKIPPED").length } });
  return results;
}

/** Take decisions off the card without posting them (Tabitha only; kept in history as rejected). */
export async function removeDecisions(actor: Actor, clientId: string, ids: string[], note?: string) {
  const chosen = [...new Set(ids)].filter(Boolean);
  if (!chosen.length) throw new ValidationError("Tick the entries to remove first.");
  const mine = await prisma.coethaProposal.findMany({ where: { id: { in: chosen }, clientId, model: DECISIONS_MODEL }, select: { id: true } });
  if (mine.length !== chosen.length) throw new ValidationError("One of those entries isn't a prepared decision for this business.");
  return decideCoethaProposals(actor, clientId, "REJECT", chosen.map((id) => ({ id })), note || "Removed from Apply These Decisions");
}

// --- The tool Coetha uses in Ask Coetha (only when Tabitha is asking) -------------------------------

export const PREPARE_TOOL = {
  name: "prepare_entries",
  description:
    "Prepare entries for Tabitha's approval from accounting decisions SHE stated in this conversation. Each item becomes a draft on her Apply These Decisions card; nothing is posted until she ticks it and clicks Approve & Post. Use post_bank_row for a waiting bank row (by its W-reference, with its date and amount exactly as in the records) and journal_entry for reclassifications or corrections of entries already posted (balanced debits and credits by account code). Never prepare anything she hasn't decided; leave uncertain items for her.",
  input_schema: {
    type: "object" as const,
    properties: {
      items: {
        type: "array",
        items: {
          type: "object",
          properties: {
            type: { type: "string", enum: ["post_bank_row", "journal_entry"] },
            ref: { type: "string", description: "post_bank_row: the waiting row's W-reference, e.g. W28 (date and amount are required with it)" },
            date: { type: "string", description: "YYYY-MM-DD. post_bank_row: the row's date; journal_entry: the entry date (in an open month)" },
            amount: { type: "number", description: "post_bank_row: the row's amount in dollars as shown in the records" },
            accountCode: { type: "string", description: "post_bank_row: the account it is posted to" },
            memo: { type: "string" },
            reason: { type: "string", description: "Short: which decision of Tabitha's this carries out" },
            lines: {
              type: "array",
              description: "journal_entry: at least two lines; each has a debit or a credit in dollars",
              items: { type: "object", properties: { accountCode: { type: "string" }, debit: { type: "number" }, credit: { type: "number" }, description: { type: "string" } }, required: ["accountCode"] },
            },
          },
          required: ["type"],
        },
      },
    },
    required: ["items"],
  },
};

/** Runs prepare_entries for ONE business; only offered when the person asking is Tabitha. */
export async function runPrepareTool(actor: Actor, clientId: string, input: unknown) {
  const items = (input && typeof input === "object" ? (input as { items?: unknown }).items : null) as DecisionItem[] | null;
  if (!Array.isArray(items)) return { error: "Send items." };
  try {
    const results = await prepareDecisions(actor, clientId, items, "chat");
    return { prepared: results.filter((r) => r.ok).map((r) => r.message), notPrepared: results.filter((r) => !r.ok).map((r) => r.message), note: "These are drafts on Tabitha's Apply These Decisions card. Nothing is posted until she approves." };
  } catch (err) {
    return { error: err instanceof ValidationError ? err.message : "The entries couldn't be prepared." };
  }
}
