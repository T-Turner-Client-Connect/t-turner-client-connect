import "server-only";
import { prisma } from "@/lib/prisma";
import { audit } from "@/lib/audit";
import type { Actor } from "@/lib/auth/actor";
import { isPrimaryOwner } from "@/lib/auth/permissions";
import { ValidationError } from "./clients";
import { addAccount, assertLedger, bookOf, cleanAccount, closeBooksThrough, reopenBooks, ymdOf } from "./ledger";
import { assertCanApproveCoethaWork } from "@/lib/auth/permissions";
import { approveCoethaProposal, decideCoethaProposals, scrub } from "./coetha";
import { coethaAutoPostOn } from "./owner-switches";

/**
 * "Apply These Decisions": Coetha turns Tabitha's accounting decisions into the entries
 * themselves, so nobody re-enters them by hand.
 *
 * - Nothing new is posted here. Each decision becomes an ordinary Coetha proposal (the same
 *   CATEGORY and ADJUSTING_ENTRY proposals a Coetha run makes) in the existing approval list.
 *   Approving one goes through the existing path (approveCoethaProposal): Tabitha only, the
 *   bank row is posted once (never a new bank transaction), each entry posts once (sourceKey),
 *   and everything is audited. Corrections are reversals. An entry dated in a closed month is
 *   posted in that month: Approve & Post (or Coetha, under Tabitha's standing authorization, for an
 *   ordinary month) reopens it through the ledger's own audited step and closes it again; a month
 *   whose statements were approved/released or whose tax return was filed always goes to Tabitha.
 * - Sources: (1) Ask Coetha, only when Tabitha herself is asking (prepare_entries tool, for
 *   decisions she stated), and (2) the document reader's "Routine" checks that are matched to a
 *   waiting bank row with a proposed account. Uncertain items are never prepared; they stay on
 *   hold until she decides.
 * - Prepared decisions carry model DECISIONS_MODEL, so a later "Run Coetha" never replaces them.
 * - A missing account: Coetha proposes it (NEW_ACCOUNT: code, name, type) on the same card, and
 *   entries that need it point to that proposal. Approve & Post creates the account first through
 *   the Chart of Accounts' own step (addAccount: same checks, audited), then posts the entries. An
 *   entry whose new account isn't approved with it is refused. No account is created otherwise.
 */

export const DECISIONS_MODEL = "decisions";
const MAX_ITEMS = 60;

export type DecisionItem =
  | { type: "new_account"; accountCode: string; name: string; accountType: string; subtype?: string | null; description?: string; reason?: string }
  | { type: "post_bank_row"; ref?: string; bankTransactionId?: string; date?: string; amount?: number; accountCode: string; memo?: string; reason?: string; basis?: Basis; quote?: string }
  | { type: "journal_entry"; date: string; memo: string; reason?: string; basis?: Basis; quote?: string; lines: { accountCode: string; debit?: number | null; credit?: number | null; description?: string | null }[] };

export type PrepareResult = { index: number; ok: boolean; message: string; proposalId?: string; posted?: boolean };
/** Why an entry may post without a click: Tabitha said so (quoted), or it's the business's routine treatment. */
type Basis = "tabitha_said" | "routine" | "senior_accountant";

// --- Posting routine items automatically (Tabitha's switch, on by default) ---------------------------

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9$.#]+/g, " ").trim();
// Bank descriptions that say nothing about the payee: never "routine" by history alone.
const GENERIC = new Set(["CHECK", "CHK", "DEPOSIT", "ATM", "TRANSFER", "XFER", "WITHDRAWAL", "DEBIT", "CREDIT", "ONLINE", "POS", "ACH", "WIRE", "PAYMENT", "PURCHASE", "MOBILE", "EPAY", "BILL", "SERVICE", "FEE"]);
const vendorKey = (d: string) => {
  const words = d.toUpperCase().replace(/[^A-Z ]+/g, " ").split(/\s+/).filter((w) => w.length > 1);
  if (!words.length || GENERIC.has(words[0])) return null;
  return words.slice(0, 2).join(" ");
};

/** Tabitha's own words, quoted by Coetha, must appear in what she wrote to Coetha about this business. */
function saidByTabitha(quote: string | undefined, said: string[]) {
  const q = norm(quote ?? "");
  return q.length >= 6 && said.some((t) => norm(t).includes(q));
}

/** The business's routine treatment: one of its rules, or the account this vendor was already posted to (and never another). */
async function routineFor(clientId: string, t: { id: string; description: string; amountCents: number; accountId: string }, accountId: string) {
  const rules = await prisma.categorizationRule.findMany({ where: { clientId, active: true } });
  const desc = t.description.toUpperCase();
  const dir = t.amountCents > 0 ? "IN" : "OUT";
  if (rules.some((r) => desc.includes(r.matchText.toUpperCase()) && (r.direction === "ANY" || r.direction === dir) && r.accountId === accountId)) return "rule";
  const key = vendorKey(t.description);
  if (!key) return null;
  const posted = await prisma.bankTransaction.findMany({ where: { clientId, status: "POSTED", journalEntryId: { not: null }, id: { not: t.id } }, orderBy: { date: "desc" }, take: 800, select: { description: true, accountId: true, journalEntry: { select: { reversedBy: { select: { id: true } }, lines: { select: { accountId: true } } } } } });
  let same = 0, other = 0;
  for (const r of posted) {
    if (vendorKey(r.description) !== key || !r.journalEntry || r.journalEntry.reversedBy) continue;
    const cat = r.journalEntry.lines.find((l) => l.accountId !== r.accountId)?.accountId;
    if (cat === accountId) same++; else other++;
  }
  return same >= 1 && other === 0 ? "history" : null;
}

/** The owner, who turned automatic posting on; postings made for her are audited as automatic. */
async function ownerActor(): Promise<Actor | null> {
  const o = await prisma.ownerAccess.findFirst({ where: { isPrimary: true, revokedAt: null, user: { active: true } }, select: { user: { select: { id: true, role: true, name: true, email: true } } } });
  return o?.user ?? null;
}

/**
 * Why a closed month must go to Tabitha instead of being reopened under Coetha's standing
 * authorization: its statements were approved or released, or that year's tax return was filed.
 * Null for an ordinary (operational) closed month.
 */
export async function closedMonthEscalation(clientId: string, date: string): Promise<string | null> {
  const y = Number(date.slice(0, 4)), m = Number(date.slice(5, 7));
  const finalized = await prisma.document.findFirst({ where: { clientId, year: y, month: m, deletedAt: null, supersededAt: null, reportType: { in: ["PROFIT_AND_LOSS", "BALANCE_SHEET", "FINANCIAL_PACKET"] }, OR: [{ visibility: "PUBLISHED" }, { reviewStatus: "APPROVED" }] }, select: { visibility: true } });
  if (finalized) return `that month's statements were ${finalized.visibility === "PUBLISHED" ? "released to the client" : "approved"}`;
  const filed = await prisma.filingRecord.findFirst({ where: { clientId, taxYear: y, filingStatus: { in: ["SUBMITTED", "PENDING_ACKNOWLEDGMENT", "ACCEPTED"] } }, select: { returnType: true } });
  if (filed) return `the ${y} ${filed.returnType} return was filed`;
  return null;
}

/**
 * Runs `fn` with the books opened from `earliest` on, then closes them again through the same date
 * as before. Reopening and re-closing go through the ledger's own steps (owner only, audited with
 * the reason), so the close history shows exactly what was opened, why, and for how long.
 */
export async function withMonthsOpened<T>(owner: Actor, clientId: string, earliest: string, reason: string, fn: () => Promise<T>): Promise<T> {
  const book = await bookOf(clientId);
  const locked = book.lockedThrough ? ymdOf(book.lockedThrough) : null;
  if (!locked || earliest > locked) return fn();
  const before = prevDay(earliest);
  const opening = book.openingDate ? ymdOf(book.openingDate) : null;
  await reopenBooks(owner, clientId, { through: opening && before < opening ? null : before, reason });
  try {
    return await fn();
  } finally {
    await closeBooksThrough(owner, clientId, locked).catch(() => {});
  }
}

type AutoPost = { posted: boolean; held?: string };

async function autoPost(clientId: string, proposalId: string, basis: string): Promise<AutoPost> {
  if (!(await coethaAutoPostOn())) return { posted: false, held: "standing authorization is off in Owner's Office → Automation, so it waits for your Approve & Post" };
  const owner = await ownerActor();
  if (!owner) return { posted: false };
  const date = ((await prisma.coethaProposal.findUnique({ where: { id: proposalId }, select: { payload: true } }))?.payload as { date?: string } | null)?.date ?? "";
  const book = await bookOf(clientId);
  const locked = book.lockedThrough ? ymdOf(book.lockedThrough) : null;
  if (locked && date && date <= locked) {
    // Tabitha's standing authorization covers ordinary closed months; finalized ones come to her.
    const why = await closedMonthEscalation(clientId, date);
    if (why) return { posted: false, held: `the books are closed through ${locked} and ${why}, so it waits for you` };
  }
  try {
    const r = await withMonthsOpened(owner, clientId, date || "9999-12-31", `Coetha's standing authorization: supported correction dated ${date}`, () => approveCoethaProposal(owner, clientId, proposalId, { note: `Posted automatically (${basis})` }));
    if (r.result !== "APPROVED") return { posted: false };
    const p = await prisma.coethaProposal.findUniqueOrThrow({ where: { id: proposalId } });
    await prisma.coethaProposal.update({ where: { id: proposalId }, data: { payload: { ...(p.payload as object), autoPosted: { basis, at: new Date().toISOString(), reopenedClosedMonth: !!locked && !!date && date <= locked } } } });
    await audit(prisma, { actorId: owner.id, action: "coetha.auto_posted", entityType: "CoethaProposal", entityId: proposalId, clientId, details: { basis, journalEntryId: r.journalEntryId, date, reopenedClosedMonth: !!locked && !!date && date <= locked } });
    return { posted: true };
  } catch {
    // Anything the ledger refuses (already posted, ...) stays on the card for Tabitha.
    return { posted: false };
  }
}

const cents = (n: unknown) => (typeof n === "number" && Number.isFinite(n) ? Math.round(n * 100) : 0);
const isYmd = (s: unknown): s is string => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`));
const usd = (c: number) => `$${(Math.abs(c) / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const prevDay = (ymd: string) => new Date(Date.parse(`${ymd}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
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
export async function prepareDecisions(actor: Actor, clientId: string, items: DecisionItem[], source: "chat" | "documents", note?: string, said: string[] = []): Promise<PrepareResult[]> {
  await assertLedger(actor, clientId);
  const book = await bookOf(clientId);
  if (!Array.isArray(items) || !items.length) throw new ValidationError("There are no entries to prepare.");
  if (items.length > MAX_ITEMS) throw new ValidationError(`Prepare at most ${MAX_ITEMS} entries at a time.`);
  const accounts = await prisma.ledgerAccount.findMany({ where: { clientId }, select: { id: true, code: true, name: true, type: true, subtype: true, active: true } });
  const byCode = new Map(accounts.map((a) => [a.code, a]));
  const refs = items.some((i) => i.type === "post_bank_row" && i.ref) ? await waitingRefs(clientId) : new Map<string, string>();
  const locked = book.lockedThrough ? ymdOf(book.lockedThrough) : null;
  const opening = book.openingDate ? ymdOf(book.openingDate) : null;
  // New accounts Coetha has proposed and Tabitha hasn't decided yet (this call's and earlier ones).
  type Acct = { id: string | null; code: string; name: string; type: string; pendingId?: string };
  const pending = new Map<string, Acct>();
  for (const p of await prisma.coethaProposal.findMany({ where: { clientId, kind: "NEW_ACCOUNT", status: "PROPOSED" }, select: { id: true, payload: true } })) {
    const d = p.payload as { code: string; name: string; type: string };
    pending.set(d.code, { id: null, code: d.code, name: d.name, type: d.type, pendingId: p.id });
  }
  const account = (code: unknown): { a: Acct } | { error: string } => {
    const c = String(code ?? "").trim().split(/\s+/)[0];
    const a = byCode.get(c);
    if (!a) {
      const p = pending.get(c);
      if (p) return { a: p };
      return { error: `account ${String(code ?? "").slice(0, 20)} isn't in this business's chart of accounts (propose it as a new account first)` };
    }
    if (!a.active) return { error: `account ${a.code} is inactive` };
    if (a.subtype === "OPENING_BALANCE") return { error: "nothing is posted to Opening Balance Equity this way" };
    return { a };
  };

  const run = await prisma.coethaRun.create({ data: { clientId, trigger: source === "chat" ? "DECISIONS" : "DOCUMENTS", startedById: actor.id, model: DECISIONS_MODEL, status: "OK", finishedAt: new Date() } });
  const results: PrepareResult[] = [];
  let made = 0;
  const ordered = [...items.entries()].sort(([, x], [, y]) => (x.type === "new_account" ? 0 : 1) - (y.type === "new_account" ? 0 : 1));
  for (const [index, it] of ordered) {
    const fail = (message: string) => results.push({ index, ok: false, message });
    const reason = clip(it.reason, 600) || (source === "chat" ? "Tabitha's decision in Ask Coetha" : "Routine check matched by the document reader");
    if (it.type === "new_account") {
      let data: ReturnType<typeof cleanAccount>;
      try {
        data = cleanAccount({ code: String(it.accountCode ?? ""), name: String(it.name ?? ""), type: String(it.accountType ?? ""), subtype: it.subtype || null, description: it.description });
      } catch (err) { fail(`New account ${clip(it.accountCode, 20)}: ${err instanceof ValidationError ? err.message : "not valid"}`); continue; }
      if (data.subtype && ["BANK", "CREDIT_CARD", "OPENING_BALANCE"].includes(data.subtype)) { fail(`New account ${data.code}: bank, card and opening-balance accounts are set up in the Chart of Accounts.`); continue; }
      if (byCode.has(data.code)) { fail(`Account ${data.code} already exists (${byCode.get(data.code)!.name}); use it instead of a new one.`); continue; }
      const sameName = accounts.find((a) => a.name.trim().toLowerCase() === data.name.toLowerCase());
      if (sameName) { fail(`An account named "${sameName.name}" already exists (${sameName.code}); use it instead of a new one.`); continue; }
      const already = pending.get(data.code);
      if (already) { results.push({ index, ok: true, message: `New account ${data.code} ${already.name} was already proposed.`, proposalId: already.pendingId }); continue; }
      const p = await prisma.coethaProposal.create({ data: { clientId, runId: run.id, kind: "NEW_ACCOUNT", confidence: 1, reason, model: DECISIONS_MODEL, inputHash: `${source}:${run.id}`, payload: { code: data.code, name: data.name, type: data.type, subtype: data.subtype, description: data.description, source } } });
      pending.set(data.code, { id: null, code: data.code, name: data.name, type: data.type, pendingId: p.id });
      made++;
      results.push({ index, ok: true, message: `New account ${data.code} ${data.name} (${data.type.toLowerCase()}), for your approval`, proposalId: p.id });
      continue;
    }
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
      if (got.a.id && got.a.id === t.accountId) { fail(`${it.ref ?? "That row"}: choose an account other than the bank account itself.`); continue; }
      const date = ymdOf(t.date);
      if (opening && date < opening) { fail(`${it.ref ?? "That row"} (${date}) can't be posted: it's before the opening balances (${opening}).`); continue; }
      const same = await prisma.coethaProposal.findFirst({ where: { clientId, kind: "CATEGORY", bankTransactionId: t.id, status: "PROPOSED", model: DECISIONS_MODEL, approvedAccountId: null, payload: got.a.id ? { path: ["accountId"], equals: got.a.id } : { path: ["pendingAccountProposalId"], equals: got.a.pendingId! } } });
      if (same) { results.push({ index, ok: true, message: `${it.ref ?? ymdOf(t.date)} ${usd(t.amountCents)} → ${got.a.code} ${got.a.name} was already prepared.`, proposalId: same.id }); continue; }
      const p = await prisma.$transaction(async (tx) => {
        // Tabitha's decision replaces any other open draft for this row (a run's, the rules', the statements').
        await tx.coethaProposal.updateMany({ where: { clientId, kind: "CATEGORY", bankTransactionId: t.id, status: "PROPOSED" }, data: { status: "SUPERSEDED", decisionNote: "Replaced by Tabitha's decision (Apply These Decisions)." } });
        return tx.coethaProposal.create({
          data: {
            clientId, runId: run.id, kind: "CATEGORY", bankTransactionId: t.id, confidence: 1, reason, model: DECISIONS_MODEL, inputHash: `${source}:${run.id}`,
            payload: { bankTransactionId: t.id, date, amountCents: t.amountCents, description: t.description, bankAccountName: t.account.name, accountId: got.a.id, pendingAccountProposalId: got.a.pendingId ?? null, accountCode: got.a.code, accountName: got.a.name, memo: clip(it.memo, 250) || null, source, ref: it.ref ?? null, note: note ?? null },
          },
        });
      });
      made++;
      const label = `${it.ref ?? date} ${date} ${usd(t.amountCents)} → ${got.a.code} ${got.a.name}`;
      // Coetha's own professional judgment (Tabitha's instruction: she decides like a senior
      // accountant); it needs a written reason, and auto-posted entries stay listed and reversible.
      const basis = !got.a.id ? null : it.basis === "tabitha_said" && saidByTabitha(it.quote, said) ? "your decision" : it.basis === "routine" ? await routineFor(clientId, t, got.a.id) : it.basis === "senior_accountant" && clip(it.reason, 300) ? "Coetha's judgment" : null;
      const ap = basis ? await autoPost(clientId, p.id, basis) : { posted: false };
      const posted = ap.posted;
      results.push({ index, ok: true, message: posted ? `Posted automatically (${basis}): ${label}` : `On your Apply These Decisions card${ap.held ? ` (${ap.held})` : locked && date <= locked ? ` (closed month: the books are closed through ${locked})` : ""}: ${label}`, proposalId: p.id, posted });
      continue;
    }
    if (it.type === "journal_entry") {
      if (!isYmd(it.date)) { fail("An entry needs a valid date (YYYY-MM-DD)."); continue; }
      // A correction belongs in the month it corrects. In a closed month it is still prepared, marked,
      // and waits for Tabitha to reopen that month (General Ledger) before she approves it.
      if (opening && it.date < opening) { fail(`The entry dated ${it.date} can't be posted: it's before the opening balances (${opening}).`); continue; }
      const inClosedMonth = !!locked && it.date <= locked;
      const lines: { accountId: string | null; pendingAccountProposalId: string | null; accountCode: string; accountName: string; debitCents: number; creditCents: number; description: string }[] = [];
      let bad: string | null = null;
      for (const l of it.lines ?? []) {
        const got = account(l.accountCode);
        if ("error" in got) { bad = got.error; break; }
        const debitCents = cents(l.debit), creditCents = cents(l.credit);
        if (debitCents < 0 || creditCents < 0 || (debitCents > 0) === (creditCents > 0)) { bad = "each line is either a debit or a credit, with a positive amount"; break; }
        lines.push({ accountId: got.a.id, pendingAccountProposalId: got.a.pendingId ?? null, accountCode: got.a.code, accountName: got.a.name, debitCents, creditCents, description: clip(l.description, 200) });
      }
      const dr = lines.reduce((n, l) => n + l.debitCents, 0);
      const cr = lines.reduce((n, l) => n + l.creditCents, 0);
      if (!bad && lines.length < 2) bad = "an entry needs at least two lines";
      if (!bad && dr !== cr) bad = `debits (${usd(dr)}) and credits (${usd(cr)}) must be equal`;
      if (bad) { fail(`Entry "${clip(it.memo, 80)}": ${bad}; nothing was prepared.`); continue; }
      const memo = clip(it.memo, 250) || "Adjusting entry";
      const key = JSON.stringify([it.date, lines.map((l) => [l.accountId ?? l.pendingAccountProposalId, l.debitCents, l.creditCents])]);
      const existing = await prisma.coethaProposal.findMany({ where: { clientId, kind: "ADJUSTING_ENTRY", model: DECISIONS_MODEL, status: { in: ["PROPOSED", "APPROVED"] } }, select: { id: true, status: true, payload: true } });
      const dup = existing.find((e) => (e.payload as { key?: string }).key === key);
      if (dup) { results.push({ index, ok: dup.status === "PROPOSED", message: dup.status === "APPROVED" ? `"${memo}" was already approved and posted, so it wasn't prepared again.` : `"${memo}" was already prepared.`, proposalId: dup.id }); continue; }
      const p = await prisma.coethaProposal.create({
        data: { clientId, runId: run.id, kind: "ADJUSTING_ENTRY", confidence: 1, reason, model: DECISIONS_MODEL, inputHash: `${source}:${run.id}`, payload: { date: it.date, memo, totalCents: dr, lines, key, source, note: note ?? null } },
      });
      made++;
      const label = `${it.date} "${memo}" ${usd(dr)}: ${lines.map((l) => `${l.debitCents ? "Dr" : "Cr"} ${l.accountCode}`).join(", ")}`;
      // A correction posts by itself only when Tabitha said so in her own words.
      const jBasis = it.basis === "tabitha_said" && saidByTabitha(it.quote, said) ? "your decision" : it.basis === "senior_accountant" && clip(it.reason, 300) ? "Coetha's judgment" : null;
      const ap = lines.every((l) => l.accountId) && jBasis ? await autoPost(clientId, p.id, jBasis) : { posted: false };
      const posted = ap.posted;
      results.push({ index, ok: true, message: posted ? `Posted automatically (${jBasis})${inClosedMonth ? ` in its own month, reopened and closed again under your standing authorization` : ""}: ${label}` : `On your Apply These Decisions card${ap.held ? ` (${ap.held})` : inClosedMonth ? ` (closed month: the books are closed through ${locked}; Approve & Post reopens and re-closes it)` : ""}: ${label}`, proposalId: p.id, posted });
      continue;
    }
    fail("Unknown kind of entry.");
  }
  await prisma.coethaRun.update({ where: { id: run.id }, data: { proposals: made, transactions: items.length } });
  await audit(prisma, { actorId: actor.id, action: "coetha.decisions_prepared", entityType: "CoethaRun", entityId: run.id, clientId, details: { source, items: items.length, prepared: made, skipped: results.filter((r) => !r.ok).length } });
  // In the order the items were given (new accounts were handled first).
  return results.sort((x, y) => x.index - y.index);
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
    .map((f) => ({ type: "post_bank_row", basis: "routine" as const, bankTransactionId: f.bankTransactionId!, accountCode: f.proposedAccount!, memo: [f.checkNumber ? `Check #${f.checkNumber}` : "", f.payee ?? ""].filter(Boolean).join(" ") || undefined, reason: f.reason ?? undefined }));
  if (!items.length) throw new ValidationError("No routine checks from this document are waiting to be posted. Checks needing documents or your judgment stay on hold until you decide them.");
  const results = await prepareDecisions(actor, clientId, items, "documents", job.name);
  return { prepared: results.filter((r) => r.ok).length, skipped: results.filter((r) => !r.ok) };
}

// --- The Apply These Decisions card ----------------------------------------------------------------

const NATURAL_DEBIT = new Set(["ASSET", "EXPENSE"]);
const IMPACT_ORDER = ["INCOME", "EXPENSE", "ASSET", "LIABILITY", "EQUITY"] as const;
export const IMPACT_LABEL: Record<(typeof IMPACT_ORDER)[number], string> = { INCOME: "Income", EXPENSE: "Expenses", ASSET: "Assets (bank and other)", LIABILITY: "Liabilities", EQUITY: "Owner's equity" };
const TYPE_WORD: Record<string, string> = { ASSET: "Asset", LIABILITY: "Liability", EQUITY: "Equity", INCOME: "Income", EXPENSE: "Expense" };

type Line = { accountId: string | null; pendingAccountProposalId?: string | null; debitCents: number; creditCents: number };
type NewAccountPayload = { code: string; name: string; type: string; subtype: string | null; description: string | null; accountId?: string };

/** Every prepared decision waiting for Approve & Post, with its lines and the effect on the statements. */
export async function applyDecisionsView(actor: Actor, clientId: string) {
  await assertLedger(actor, clientId);
  const lockedThrough = (await prisma.ledgerBook.findUnique({ where: { clientId }, select: { lockedThrough: true } }))?.lockedThrough;
  const closedThrough = lockedThrough ? ymdOf(lockedThrough) : null;
  const open = await prisma.coethaProposal.findMany({ where: { clientId, model: DECISIONS_MODEL, status: "PROPOSED", kind: { in: ["NEW_ACCOUNT", "CATEGORY", "ADJUSTING_ENTRY"] } }, orderBy: { createdAt: "asc" }, take: 300 });
  const accounts = await prisma.ledgerAccount.findMany({ where: { clientId }, select: { id: true, code: true, name: true, type: true } });
  const acct = new Map(accounts.map((a) => [a.id, a]));
  const newAccts = new Map(open.filter((p) => p.kind === "NEW_ACCOUNT").map((p) => [p.id, p.payload as NewAccountPayload]));
  const bankIds = open.map((p) => p.bankTransactionId).filter((x): x is string => !!x);
  const bank = new Map((await prisma.bankTransaction.findMany({ where: { clientId, id: { in: bankIds } }, select: { id: true, accountId: true, status: true } })).map((b) => [b.id, b]));
  const info = (l: Line) => {
    if (l.accountId) { const a = acct.get(l.accountId); return a ? { label: `${a.code} ${a.name}`, type: a.type, pending: null } : null; }
    const n = l.pendingAccountProposalId ? newAccts.get(l.pendingAccountProposalId) : undefined;
    return n ? { label: `${n.code} ${n.name} (new)`, type: n.type, pending: l.pendingAccountProposalId! } : { label: "a new account that was removed", type: "", pending: l.pendingAccountProposalId ?? "missing" };
  };
  const impact = new Map<string, number>();
  const entries = open.map((p) => {
    if (p.kind === "NEW_ACCOUNT") {
      const d = p.payload as NewAccountPayload;
      return { id: p.id, kind: "NEW_ACCOUNT" as const, date: "", title: `New account ${d.code} ${d.name} (${TYPE_WORD[d.type] ?? d.type})`, amountCents: 0, reason: p.reason, source: (p.payload as { source?: string }).source === "documents" ? "From a document" : "From your decision in Ask Coetha", stale: false, closedMonth: null as string | null, bankRow: false, newAccount: { code: d.code, name: d.name, type: TYPE_WORD[d.type] ?? d.type }, needs: [] as string[], lines: [] as { account: string; debitCents: number; creditCents: number }[] };
    }
    let lines: Line[] = [];
    let date = "", title = "", amountCents = 0, stale = false;
    if (p.kind === "CATEGORY") {
      const d = p.payload as { date: string; amountCents: number; description: string; accountId: string | null; pendingAccountProposalId?: string | null; memo?: string | null };
      const b = bank.get(p.bankTransactionId ?? "");
      stale = !b || b.status !== "UNREVIEWED";
      const amt = Math.abs(d.amountCents);
      const cat: Line = { accountId: d.accountId, pendingAccountProposalId: d.pendingAccountProposalId ?? null, debitCents: 0, creditCents: 0 };
      lines = b ? (d.amountCents > 0 ? [{ accountId: b.accountId, debitCents: amt, creditCents: 0 }, { ...cat, creditCents: amt }] : [{ ...cat, debitCents: amt }, { accountId: b.accountId, debitCents: 0, creditCents: amt }]) : [];
      date = d.date; amountCents = amt; title = scrub(d.memo || d.description, 120);
    } else {
      const d = p.payload as { date: string; memo: string; totalCents: number; lines: Line[] };
      lines = d.lines; date = d.date; amountCents = d.totalCents; title = scrub(d.memo, 120);
    }
    const shown = lines.map((l) => ({ l, i: info(l) }));
    if (!stale) for (const { l, i } of shown) {
      if (!i?.type) continue;
      const signed = NATURAL_DEBIT.has(i.type) ? l.debitCents - l.creditCents : l.creditCents - l.debitCents;
      impact.set(i.type, (impact.get(i.type) ?? 0) + signed);
    }
    const source = (p.payload as { source?: string }).source === "documents" ? "From a document" : "From your decision in Ask Coetha";
    return {
      id: p.id, kind: p.kind as "CATEGORY" | "ADJUSTING_ENTRY", date, title, amountCents, reason: p.reason, source, stale,
      // Dated in a month the books are closed through: reopen it before approving.
      closedMonth: !!closedThrough && !!date && date <= closedThrough ? closedThrough : null,
      bankRow: p.kind === "CATEGORY", newAccount: null,
      // The new accounts this entry needs approved with it.
      needs: [...new Set(shown.map(({ i }) => i?.pending).filter((x): x is string => !!x))],
      lines: shown.map(({ l, i }) => ({ account: i?.label ?? "?", debitCents: l.debitCents, creditCents: l.creditCents })),
    };
  });
  const since = new Date(Date.now() - 14 * 86_400_000);
  const auto = (await prisma.coethaProposal.findMany({ where: { clientId, model: DECISIONS_MODEL, status: "APPROVED", decidedAt: { gte: since }, journalEntryId: { not: null } }, orderBy: { decidedAt: "desc" }, take: 100 })).filter((p) => (p.payload as { autoPosted?: unknown }).autoPosted);
  const je = new Map((await prisma.journalEntry.findMany({ where: { clientId, id: { in: auto.map((p) => p.journalEntryId!) } }, select: { id: true, date: true, memo: true, reversedBy: { select: { id: true } }, lines: { select: { debitCents: true } } } })).map((e) => [e.id, e]));
  const autoPosted = auto.filter((p) => je.has(p.journalEntryId!)).map((p) => {
    const e = je.get(p.journalEntryId!)!;
    return { id: p.id, entryId: e.id, date: ymdOf(e.date), memo: scrub(e.memo, 120), amountCents: e.lines.reduce((n, l) => n + l.debitCents, 0), basis: (p.payload as { autoPosted: { basis: string } }).autoPosted.basis, reversed: !!e.reversedBy, postedAt: p.decidedAt };
  });
  return {
    entries,
    autoPosted,
    impact: IMPACT_ORDER.filter((t) => (impact.get(t) ?? 0) !== 0).map((t) => ({ type: t, label: IMPACT_LABEL[t], cents: impact.get(t)! })),
    canApprove: await isPrimaryOwner(actor.id),
  };
}

/** Points every open entry that was waiting for this new account at the account just created. */
async function resolvePending(clientId: string, proposalId: string, a: { id: string; code: string; name: string }) {
  const waiting = await prisma.coethaProposal.findMany({ where: { clientId, model: DECISIONS_MODEL, status: "PROPOSED", kind: { in: ["CATEGORY", "ADJUSTING_ENTRY"] } } });
  for (const p of waiting) {
    const d = p.payload as Record<string, unknown> & { pendingAccountProposalId?: string | null; lines?: Line[] };
    let changed = false;
    if (p.kind === "CATEGORY" && d.pendingAccountProposalId === proposalId) {
      Object.assign(d, { accountId: a.id, accountCode: a.code, accountName: a.name, pendingAccountProposalId: null });
      changed = true;
    }
    if (p.kind === "ADJUSTING_ENTRY" && Array.isArray(d.lines)) {
      d.lines = d.lines.map((l) => (l.pendingAccountProposalId === proposalId ? (changed = true, { ...l, accountId: a.id, accountCode: a.code, accountName: a.name, pendingAccountProposalId: null }) : l));
    }
    if (changed) await prisma.coethaProposal.update({ where: { id: p.id }, data: { payload: d as object } });
  }
}

const needsNewAccount = (p: { kind: string; payload: unknown }) => {
  const d = p.payload as { pendingAccountProposalId?: string | null; lines?: Line[] };
  return p.kind === "CATEGORY" ? !!d.pendingAccountProposalId : (d.lines ?? []).some((l) => !l.accountId);
};

/**
 * Approve & Post the chosen decisions (Tabitha only). New accounts first, through the Chart of
 * Accounts' own step (addAccount: same checks, audited), with any code or name she changed; then
 * the entries, through the existing approval path. An entry whose new account isn't approved is
 * left on the card. Unchosen ones stay on hold.
 */
export async function approveDecisions(actor: Actor, clientId: string, ids: string[], edits: Record<string, { code?: string; name?: string }> = {}) {
  await assertCanApproveCoethaWork(actor);
  const chosen = [...new Set(ids)].filter(Boolean);
  if (!chosen.length) throw new ValidationError("Tick the entries you approve first.");
  // Only prepared decisions of this business go through this button.
  const mine = await prisma.coethaProposal.findMany({ where: { id: { in: chosen }, clientId, model: DECISIONS_MODEL } });
  if (mine.length !== chosen.length) throw new ValidationError("One of those entries isn't a prepared decision for this business.");
  const results: { id: string; result: "APPROVED" | "ALREADY_APPROVED" | "REJECTED" | "SKIPPED"; message?: string; journalEntryId?: string | null }[] = [];
  for (const p of mine.filter((x) => x.kind === "NEW_ACCOUNT")) {
    if (p.status === "APPROVED") { results.push({ id: p.id, result: "ALREADY_APPROVED" }); continue; }
    if (p.status !== "PROPOSED") { results.push({ id: p.id, result: "SKIPPED", message: "That new account was already decided." }); continue; }
    const d = p.payload as NewAccountPayload;
    const e = edits[p.id] ?? {};
    const code = e.code?.trim() || d.code, name = e.name?.trim() || d.name;
    const claimed = await prisma.coethaProposal.updateMany({ where: { id: p.id, status: "PROPOSED" }, data: { status: "APPROVED", decidedById: actor.id, decidedAt: new Date() } });
    if (!claimed.count) { results.push({ id: p.id, result: "ALREADY_APPROVED" }); continue; }
    try {
      const a = await addAccount(actor, clientId, { code, name, type: d.type, subtype: d.subtype, description: d.description ?? undefined });
      await prisma.coethaProposal.update({ where: { id: p.id }, data: { payload: { ...d, code: a.code, name: a.name, accountId: a.id } } });
      await audit(prisma, { actorId: actor.id, action: "coetha.proposal_approved", entityType: "CoethaProposal", entityId: p.id, clientId, details: { kind: "NEW_ACCOUNT", code: a.code, name: a.name, type: a.type, edited: code !== d.code || name !== d.name } });
      await resolvePending(clientId, p.id, a);
      results.push({ id: p.id, result: "APPROVED" });
    } catch (err) {
      await prisma.coethaProposal.update({ where: { id: p.id }, data: { status: "PROPOSED", decidedById: null, decidedAt: null } });
      results.push({ id: p.id, result: "SKIPPED", message: `New account ${code}: ${err instanceof ValidationError ? err.message : "couldn't be created."}` });
    }
  }
  const rest = await prisma.coethaProposal.findMany({ where: { id: { in: mine.filter((x) => x.kind !== "NEW_ACCOUNT").map((x) => x.id) } } });
  const ready = rest.filter((p) => !needsNewAccount(p));
  for (const p of rest.filter((x) => needsNewAccount(x))) results.push({ id: p.id, result: "SKIPPED", message: "It uses a new account that isn't approved yet: tick the new account with it." });
  if (ready.length) {
    // Entries dated in closed months: Approve & Post opens those months and closes them again itself.
    const earliest = ready.map((p) => (p.payload as { date?: string }).date ?? "").filter(Boolean).sort()[0] ?? "9999-12-31";
    results.push(...(await withMonthsOpened(actor, clientId, earliest, "Tabitha approved corrections dated in closed months (Approve & Post)", () => decideCoethaProposals(actor, clientId, "APPROVE", ready.map((p) => ({ id: p.id }))))));
  }
  await audit(prisma, { actorId: actor.id, action: "coetha.decisions_approved", entityType: "LedgerBook", entityId: clientId, clientId, details: { chosen: chosen.length, posted: results.filter((r) => r.result === "APPROVED").length, skipped: results.filter((r) => r.result === "SKIPPED").length } });
  return results;
}

/** Take decisions off the card without posting them (Tabitha only; kept in history as rejected). Entries needing a removed new account go with it. */
export async function removeDecisions(actor: Actor, clientId: string, ids: string[], note?: string) {
  const chosen = [...new Set(ids)].filter(Boolean);
  if (!chosen.length) throw new ValidationError("Tick the entries to remove first.");
  const mine = await prisma.coethaProposal.findMany({ where: { id: { in: chosen }, clientId, model: DECISIONS_MODEL }, select: { id: true, kind: true } });
  if (mine.length !== chosen.length) throw new ValidationError("One of those entries isn't a prepared decision for this business.");
  const accountIds = mine.filter((p) => p.kind === "NEW_ACCOUNT").map((p) => p.id);
  const dependents = accountIds.length
    ? (await prisma.coethaProposal.findMany({ where: { clientId, model: DECISIONS_MODEL, status: "PROPOSED", kind: { in: ["CATEGORY", "ADJUSTING_ENTRY"] } } })).filter((p) => {
        const d = p.payload as { pendingAccountProposalId?: string | null; lines?: Line[] };
        return accountIds.includes(d.pendingAccountProposalId ?? "") || (d.lines ?? []).some((l) => accountIds.includes(l.pendingAccountProposalId ?? ""));
      }).map((p) => p.id)
    : [];
  return decideCoethaProposals(actor, clientId, "REJECT", [...new Set([...chosen, ...dependents])].map((id) => ({ id })), note || "Removed from Apply These Decisions");
}

/** Reverse something Coetha posted automatically (Tabitha only). The bank row goes back to review. */
export async function reverseAutoPosted(actor: Actor, clientId: string, proposalId: string) {
  await assertCanApproveCoethaWork(actor);
  const p = await prisma.coethaProposal.findFirst({ where: { id: proposalId, clientId, model: DECISIONS_MODEL, status: "APPROVED" } });
  if (!p?.journalEntryId || !(p.payload as { autoPosted?: unknown }).autoPosted) throw new ValidationError("That isn't one of Coetha's automatic postings for this business.");
  const { reverseEntry } = await import("./ledger");
  const today = new Date().toLocaleDateString("en-CA", { timeZone: "America/Chicago" });
  return reverseEntry(actor, clientId, p.journalEntryId, { date: today, reason: "Reversed by Tabitha from Coetha's automatic postings" });
}

// --- The tool Coetha uses in Ask Coetha (only when Tabitha is asking) -------------------------------

export const PREPARE_TOOL = {
  name: "prepare_entries",
  description:
    "Post or prepare entries for ONE business (offered only when Tabitha is asking). Under her standing authorization, items with basis routine (a rule or how this vendor was posted before), senior_accountant (your professional judgment, with the reason) or tabitha_said (her exact words in quote) are POSTED immediately; anything else waits on her Apply These Decisions card. The result says, item by item, what was posted and what is waiting. Use post_bank_row for a waiting bank row (its W-reference, with its date and amount exactly as in the records; many rows in one call) and journal_entry for reclassifications or corrections of entries already posted (balanced debits and credits by account code). When the right account doesn't exist in the chart, add a new_account item (a code that fits the chart's numbering, a plain name and the correct type) in the same call and use its code in the entries. Leave out only genuine exceptions (no evidence for any treatment); they stay waiting for her.",
  input_schema: {
    type: "object" as const,
    properties: {
      items: {
        type: "array",
        items: {
          type: "object",
          properties: {
            type: { type: "string", enum: ["new_account", "post_bank_row", "journal_entry"] },
            name: { type: "string", description: "new_account: the account's name, e.g. Business Licenses & Permits" },
            accountType: { type: "string", enum: ["ASSET", "LIABILITY", "EQUITY", "INCOME", "EXPENSE"], description: "new_account: the account type" },
            ref: { type: "string", description: "post_bank_row: the waiting row's W-reference, e.g. W28 (date and amount are required with it)" },
            bankTransactionId: { type: "string", description: "post_bank_row: instead of ref, the row id add_bank_activity returned for a row it just entered" },
            date: { type: "string", description: "YYYY-MM-DD. post_bank_row: the row's date; journal_entry: the date of the month it belongs to (a correction of March payroll is dated in March, even if March is closed)" },
            amount: { type: "number", description: "post_bank_row: the row's amount in dollars as shown in the records" },
            accountCode: { type: "string", description: "post_bank_row: the account it is posted to; new_account: the new account's code" },
            memo: { type: "string" },
            reason: { type: "string", description: "Short: which decision of Tabitha's this carries out" },
            basis: { type: "string", enum: ["tabitha_said", "routine", "senior_accountant"], description: "tabitha_said: Tabitha stated this treatment (give her exact words in quote); routine: the business's usual treatment (a rule or how this vendor was posted before); senior_accountant: your own professional judgment as the firm's senior accountant (give the reason). Leave out only when you truly can't decide; it then waits for her approval." },
            quote: { type: "string", description: "With basis tabitha_said: Tabitha's own words that decide it, copied exactly from her message" },
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
export async function runPrepareTool(actor: Actor, clientId: string, input: unknown, currentQuestion?: string) {
  const items = (input && typeof input === "object" ? (input as { items?: unknown }).items : null) as DecisionItem[] | null;
  if (!Array.isArray(items)) return { error: "Send items." };
  try {
    // What Tabitha wrote to Coetha about this business (to check quoted decisions).
    const mine = await prisma.coethaChatMessage.findMany({ where: { clientId, role: "USER", authorId: actor.id }, orderBy: { createdAt: "desc" }, take: 60, select: { text: true } });
    const said = [...(currentQuestion ? [currentQuestion] : []), ...mine.map((m) => m.text)];
    const results = await prepareDecisions(actor, clientId, items, "chat", undefined, said);
    return {
      postedAutomatically: results.filter((r) => r.ok && r.posted).map((r) => r.message),
      onHerCard: results.filter((r) => r.ok && !r.posted).map((r) => r.message),
      notPrepared: results.filter((r) => !r.ok).map((r) => r.message),
      note: "Posted items are in the books (listed under Posted automatically, reversible). Card items wait for Tabitha's Approve & Post.",
    };
  } catch (err) {
    return { error: err instanceof ValidationError ? err.message : "The entries couldn't be prepared." };
  }
}

/**
 * Tabitha approves in Ask Coetha (her instruction: approving in the chat is the same as her tick and
 * Approve & Post). Offered only when Tabitha herself is asking; her own words in this message must
 * say to approve or post, quoted exactly. Approves the items named, or every item on her Apply These
 * Decisions card when none are named, through the same path as the card (audited, reversible).
 */
export const APPROVE_TOOL = {
  name: "approve_and_post",
  description: "Approve and post entries on Tabitha's Apply These Decisions card when Tabitha, in her current message, tells you to approve or post them (for example \"yes, post them\", \"approve all\"). Quote her words exactly. Give the proposal ids to approve (from prepare_entries results), or leave ids out to approve everything on her card. Never use it on a staff member's words or your own judgment alone.",
  input_schema: {
    type: "object" as const,
    properties: {
      quote: { type: "string", description: "Tabitha's own words from her current message that approve it, copied exactly" },
      ids: { type: "array", items: { type: "string" }, description: "Proposal ids to approve; leave out for everything on her card" },
    },
    required: ["quote"],
  },
};

const APPROVAL_WORDS = /\b(approve[sd]?|approval|post(ed)?|yes|go ahead|do it|ok(ay)?|confirm(ed)?)\b/i;

export async function runApproveTool(actor: Actor, clientId: string, input: unknown, currentQuestion?: string) {
  const q = (input && typeof input === "object" ? input : {}) as { quote?: unknown; ids?: unknown };
  const quote = typeof q.quote === "string" ? q.quote : "";
  if (!currentQuestion || !saidByTabitha(quote, [currentQuestion]) || !APPROVAL_WORDS.test(quote)) {
    return { error: "Nothing was posted: Tabitha's message doesn't say to approve or post. Ask her to say so (for example \"approve all\")." };
  }
  const named = Array.isArray(q.ids) ? (q.ids as unknown[]).filter((x): x is string => typeof x === "string").slice(0, 300) : [];
  const ids = named.length ? named : (await prisma.coethaProposal.findMany({ where: { clientId, model: DECISIONS_MODEL, status: "PROPOSED", kind: { in: ["NEW_ACCOUNT", "CATEGORY", "ADJUSTING_ENTRY"] } }, select: { id: true }, take: 300 })).map((p) => p.id);
  if (!ids.length) return { posted: 0, note: "Her Apply These Decisions card is empty; nothing to post." };
  try {
    const results = await approveDecisions(actor, clientId, ids);
    await audit(prisma, { actorId: actor.id, action: "coetha.approved_in_chat", entityType: "LedgerBook", entityId: clientId, clientId, details: { quote: quote.slice(0, 200), count: ids.length } });
    return {
      posted: results.filter((r) => r.result === "APPROVED").length,
      alreadyPosted: results.filter((r) => r.result === "ALREADY_APPROVED").length,
      notPosted: results.filter((r) => r.result === "SKIPPED" || r.result === "REJECTED").map((r) => r.message ?? r.id),
      note: "Posted the same way as her Approve & Post button; each entry can be reversed from the books.",
    };
  } catch (err) {
    return { error: err instanceof ValidationError || (err instanceof Error && err.name === "ForbiddenError") ? (err as Error).message : "The entries couldn't be posted." };
  }
}

