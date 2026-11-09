import "server-only";
import { createHash, randomUUID } from "node:crypto";
import type { CoethaProposal, Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { audit } from "@/lib/audit";
import { ForbiddenError, type Actor } from "@/lib/auth/actor";
import { callCoethaModel, CoethaModelError, coethaKeyPresent, coethaModel, DISCREPANCY_TYPES, type CoethaOutputT } from "@/lib/coetha-model";
import { ValidationError } from "./clients";
import { assertLedger, assertLedgerWrite, assertManagedBusiness, bookOf, categorizeBankTransactionTx, isFeedSubtype, isYmd, ledgerFlags, normDesc, officeBookClientIds, postJournalEntryTx, todayCentral, usd, ymdOf } from "./ledger";
import { closeChecklist } from "./ledger-review";
import { coethaOn } from "./owner-switches";
import { assertCoethaAllowed, optedOutClientIds } from "./coetha-opt-out";
import { CLASSIFICATION_RULES, setTaxClassification, taxProfile } from "./tax-classification";
import { assertCanApproveCoethaWork, canApproveCoethaWork } from "@/lib/auth/permissions";

/**
 * Coetha, the firm's AI Senior Accountant, working inside Client Connect.
 *
 * - A run reads ONE client's books (nothing from any other client), sends Claude only what the
 *   work needs (dates, amounts, de-identified descriptions, account names; no SSNs, EINs or
 *   contact details) and stores what comes back as PROPOSALS.
 * - Coetha never posts, reconciles, closes or approves. A proposal changes nothing.
 * - Only the primary owner (Tabitha) approves or rejects a proposal. Approving is the only path
 *   from a proposal to the books, and it goes through the ledger's own posting rules (balanced,
 *   this client's accounts, open period, posted once). Every decision is audited.
 * - Staff with access to the client's books can see proposals and run Coetha, and keep doing
 *   their normal manual bookkeeping, but can never approve or reject Coetha's work.
 */

export const COETHA_OFF = "Coetha AI is turned off. Tabitha can turn it on in the Owner's Office → Coetha & bank feeds.";
export const COETHA_NO_KEY = "Coetha needs an Anthropic API key — add ANTHROPIC_API_KEY in Netlify.";
export const COETHA_PRIVACY =
  "When Coetha runs, this business's bank transaction dates, amounts and descriptions and its account names are sent to Anthropic's API (Claude) under the firm's own API key. Long numbers in descriptions are shortened to the last 4 digits, and no SSNs, EINs, names, addresses or contact details are sent.";

export const KIND_LABEL = { RECOMMENDATION: "Findings & recommendations", CLASSIFICATION: "Tax classification recommendations", CATEGORY: "Category recommendations", DISCREPANCY: "Discrepancies", ADJUSTING_ENTRY: "Draft adjusting entries", MONTH_SUMMARY: "Draft month summary" } as const;
export type ProposalKind = keyof typeof KIND_LABEL;

const MAX_TO_CATEGORIZE = 80;
const MAX_RECENT = 150;

/**
 * The Tabitha-only approval rule has ONE definition: lib/auth/permissions.ts (primary owner only;
 * no grant — not even Staff management — lets anyone else approve or reject Coetha's work).
 */
export { assertCanApproveCoethaWork };

export async function coethaStatus() {
  const enabled = await coethaOn();
  const keyPresent = coethaKeyPresent();
  return { enabled, keyPresent, model: coethaModel(), ready: enabled && keyPresent };
}

// --- What Coetha sees ---------------------------------------------------------------------------

/** Removes anything that could identify a person or an account: long numbers, SSN/EIN shapes, emails, phone numbers. */
export function scrub(s: string, max = 200): string {
  return s
    .replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, "[email]")
    .replace(/\b\d{3}-\d{2}-\d{4}\b/g, "[id]")
    .replace(/\b\d{2}-\d{7}\b/g, "[id]")
    .replace(/(\+?1[-. ]?)?\(?\b\d{3}\)?[-. ]\d{3}[-. ]\d{4}\b/g, "[phone]")
    .replace(/\d{5,}/g, (m) => `…${m.slice(-4)}`)
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

const dollars = (c: number) => Math.round(c) / 100;
const prevMonth = (today: string) => {
  const [y, m] = today.slice(0, 7).split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 2, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
};

// Daily runs read with Admin-level ledger access (read only); nothing is written as this actor.
const DAILY_READER: Actor = { id: "system:coetha-daily", role: "ADMIN", name: "Coetha (daily)", email: "" };

/**
 * Builds exactly what is sent to the model, for ONE client, plus the id maps used to turn the
 * model's references back into this client's own rows. Every query is filtered by clientId.
 */
export async function buildCoethaInput(reader: Actor, clientId: string, opts: { month?: string; today?: string } = {}) {
  const today = opts.today ?? todayCentral();
  const month = opts.month ?? prevMonth(today);
  const book = await bookOf(clientId);
  const [accounts, rules, toCat, recent, history, recons] = await Promise.all([
    prisma.ledgerAccount.findMany({ where: { clientId, active: true }, orderBy: { code: "asc" } }),
    prisma.categorizationRule.findMany({ where: { clientId, active: true } }),
    prisma.bankTransaction.findMany({ where: { clientId, status: "UNREVIEWED" }, orderBy: [{ date: "asc" }, { id: "asc" }], take: MAX_TO_CATEGORIZE, include: { account: { select: { code: true, name: true } } } }),
    prisma.bankTransaction.findMany({ where: { clientId, status: "POSTED" }, orderBy: [{ date: "desc" }, { id: "asc" }], take: MAX_RECENT, include: { account: { select: { code: true, name: true } }, journalEntry: { select: { lines: { select: { accountId: true } } } } } }),
    prisma.bankTransaction.findMany({ where: { clientId, status: "POSTED", journalEntryId: { not: null } }, select: { accountId: true, amountCents: true, description: true, journalEntry: { select: { reversedBy: { select: { id: true } }, lines: { select: { accountId: true } } } } }, take: 2000, orderBy: { date: "desc" } }),
    prisma.bankReconciliation.findMany({ where: { clientId }, orderBy: { statementDate: "desc" } }),
  ]);
  const byId = new Map(accounts.map((a) => [a.id, a]));
  const code = (id: string | undefined) => (id ? byId.get(id)?.code ?? null : null);
  const tRef = new Map<string, string>(); // ref -> bank transaction id
  const pRef = new Map<string, string>();
  const toCategorize = toCat.map((t, i) => {
    tRef.set(`T${i + 1}`, t.id);
    return { ref: `T${i + 1}`, date: ymdOf(t.date), amount: dollars(t.amountCents), description: scrub(t.description), bankAccount: t.account.code, ...(t.flag ? { bankFlag: t.flag } : {}) };
  });
  const recentPosted = recent.map((t, i) => {
    pRef.set(`P${i + 1}`, t.id);
    const cat = t.journalEntry?.lines.find((l) => l.accountId !== t.accountId)?.accountId;
    return { ref: `P${i + 1}`, date: ymdOf(t.date), amount: dollars(t.amountCents), description: scrub(t.description), bankAccount: t.account.code, category: code(cat) };
  });
  // How each description was categorized before (by staff), most used first.
  const past = new Map<string, { description: string; direction: "IN" | "OUT"; account: string; times: number }>();
  for (const h of history) {
    if (!h.journalEntry || h.journalEntry.reversedBy) continue;
    const cat = code(h.journalEntry.lines.find((l) => l.accountId !== h.accountId)?.accountId);
    if (!cat) continue;
    const direction = h.amountCents > 0 ? "IN" : "OUT";
    const key = `${normDesc(h.description)}|${direction}|${cat}`;
    const e = past.get(key) ?? { description: scrub(normDesc(h.description)), direction, account: cat, times: 0 };
    e.times++;
    past.set(key, e);
  }
  const banks = accounts.filter((a) => isFeedSubtype(a.subtype));
  const [checklist, flags, tp] = await Promise.all([closeChecklist(reader, clientId, month, today), ledgerFlags(reader, clientId, today), taxProfile(clientId)]);
  const input = {
    today,
    monthToClose: month,
    taxProfile: { classification: tp.classification ?? "NOT_SET", accountingMethod: tp.basis, fiscalYearEndMonth: tp.fiscalYearEnd, taxYear: tp.taxYear, rules: tp.classification ? CLASSIFICATION_RULES[tp.classification] : CLASSIFICATION_RULES.OTHER_REVIEW },
    books: { basis: book.basis, openingBalancesDate: book.openingDate ? ymdOf(book.openingDate) : null, closedThrough: book.lockedThrough ? ymdOf(book.lockedThrough) : null },
    chartOfAccounts: accounts.map((a) => ({ code: a.code, name: scrub(a.name), type: a.type, ...(a.subtype ? { subtype: a.subtype } : {}) })),
    bankAccounts: banks.map((b) => {
      const r = recons.find((x) => x.accountId === b.id);
      return { code: b.code, name: scrub(b.name), kind: b.subtype, lastReconciled: r ? { statementDate: ymdOf(r.statementDate), statementBalance: dollars(r.statementBalanceCents), ledgerBalance: dollars(r.ledgerBalanceCents) } : null };
    }),
    rules: rules.map((r) => ({ descriptionContains: scrub(r.matchText), direction: r.direction, account: code(r.accountId) })).filter((r) => r.account),
    priorCategorizations: [...past.values()].sort((a, b) => b.times - a.times).slice(0, 150),
    toCategorize,
    recentPosted,
    closeChecklist: checklist.items.map((i) => ({ item: scrub(i.label), ok: i.ok, detail: scrub(i.detail) })),
    ledgerWarnings: flags.map((f) => ({ severity: f.severity, message: scrub(f.message) })),
  };
  const text = JSON.stringify(input);
  return { input, inputHash: createHash("sha256").update(text).digest("hex"), tRef, pRef, accounts, toCat };
}

// --- Running Coetha -----------------------------------------------------------------------------

type Built = Awaited<ReturnType<typeof buildCoethaInput>>;
type NewProposal = { kind: ProposalKind; payload: Prisma.InputJsonValue; bankTransactionId?: string | null; confidence?: number | null; reason: string };

const clamp01 = (n: number) => (Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0);
const clip = (s: string, n: number) => s.replace(/\s+/g, " ").trim().slice(0, n);

/** Turns the model's answer into proposals, keeping only what refers to this client's own rows and accounts. */
export function toProposals(out: CoethaOutputT, b: Built): { proposals: NewProposal[]; dropped: number } {
  const acct = new Map(b.accounts.map((a) => [a.code, a]));
  const txn = new Map(b.toCat.map((t) => [t.id, t]));
  const proposals: NewProposal[] = [];
  let dropped = 0;
  const seen = new Set<string>();
  for (const c of out.categories) {
    const id = b.tRef.get(c.ref);
    const t = id ? txn.get(id) : undefined;
    const a = acct.get(c.accountCode);
    if (!t || !a || seen.has(t.id) || a.id === t.accountId || a.subtype === "OPENING_BALANCE") { dropped++; continue; }
    seen.add(t.id);
    proposals.push({
      kind: "CATEGORY", bankTransactionId: t.id, confidence: clamp01(c.confidence), reason: clip(c.reason, 300) || "No reason given",
      payload: { bankTransactionId: t.id, date: ymdOf(t.date), amountCents: t.amountCents, description: t.description, bankAccountName: t.account.name, accountId: a.id, accountCode: a.code, accountName: a.name },
    });
  }
  const refIds = (refs: string[]) => [...new Set(refs.map((r) => b.tRef.get(r) ?? b.pRef.get(r)).filter((x): x is string => !!x))];
  for (const d of out.discrepancies.slice(0, 40)) {
    if (!DISCREPANCY_TYPES.includes(d.type)) { dropped++; continue; }
    proposals.push({ kind: "DISCREPANCY", reason: clip(d.detail, 600) || clip(d.title, 200), payload: { type: d.type, severity: d.severity, title: clip(d.title, 200), detail: clip(d.detail, 1000), bankTransactionIds: refIds(d.refs) } });
  }
  for (const e of out.adjustingEntries.slice(0, 20)) {
    const lines = e.lines.map((l) => ({ a: acct.get(l.accountCode), debitCents: Math.round((l.debit || 0) * 100), creditCents: Math.round((l.credit || 0) * 100), description: clip(l.description ?? "", 200) }));
    const dr = lines.reduce((n, l) => n + l.debitCents, 0);
    const cr = lines.reduce((n, l) => n + l.creditCents, 0);
    const ok = isYmd(e.date) && lines.length >= 2 && lines.every((l) => l.a && l.a.subtype !== "OPENING_BALANCE" && l.debitCents >= 0 && l.creditCents >= 0 && (l.debitCents > 0) !== (l.creditCents > 0)) && dr === cr && dr > 0;
    if (!ok) { dropped++; continue; }
    proposals.push({
      kind: "ADJUSTING_ENTRY", confidence: clamp01(e.confidence), reason: clip(e.reason, 600) || "No reason given",
      payload: { date: e.date, memo: clip(e.memo, 250) || "Adjusting entry", totalCents: dr, lines: lines.map((l) => ({ accountId: l.a!.id, accountCode: l.a!.code, accountName: l.a!.name, debitCents: l.debitCents, creditCents: l.creditCents, description: l.description })) },
    });
  }
  for (const r of (out.recommendations ?? []).slice(0, 30)) {
    const accts = r.accountCodes.map((c) => acct.get(c)).filter((a): a is NonNullable<typeof a> => !!a);
    const ids = refIds(r.refs);
    const rows = b.toCat.filter((t) => ids.includes(t.id));
    proposals.push({
      kind: "RECOMMENDATION", reason: clip(r.why, 600) || clip(r.title, 200),
      payload: { key: `ai:${createHash("sha256").update(`${r.category}|${r.title}|${ids.join(",")}`).digest("hex").slice(0, 16)}`, category: r.category, title: clip(r.title, 200), found: clip(r.found, 1000), why: clip(r.why, 1000), correction: clip(r.correction, 1000), impact: clip(r.impact, 600), accounts: accts.map((a) => ({ id: a.id, code: a.code, name: a.name })), transactions: ids.map((id) => { const t = rows.find((x) => x.id === id); return t ? { id, date: ymdOf(t.date), amountCents: t.amountCents, description: t.description } : { id, date: "", amountCents: 0, description: "" }; }), documents: [], entry: null },
    });
  }
  const cr = (out.classificationRecommendation ?? [])[0];
  if (cr) proposals.push({ kind: "CLASSIFICATION", reason: clip(cr.why, 600) || "Classification review", payload: { key: `ai-classification:${cr.recommended}`, recommended: cr.recommended, current: null, found: clip(cr.why, 1000), why: clip(cr.why, 1000), correction: `Change the tax classification to ${cr.recommended} if that is how the business files.`, impact: "No change to the numbers; equity and compensation are reviewed under the right rules." } });
  const s = out.monthSummary;
  if (s && clip(s.summary, 10)) {
    proposals.push({ kind: "MONTH_SUMMARY", reason: "Draft summary for Tabitha's review", payload: { month: /^\d{4}-\d{2}$/.test(s.month) ? s.month : b.input.monthToClose, summary: clip(s.summary, 4000), highlights: s.highlights.slice(0, 12).map((h) => clip(h, 300)) } });
  }
  return { proposals, dropped };
}

async function takeLock(name: string, minutes: number) {
  const now = new Date();
  const until = new Date(now.getTime() + minutes * 60_000);
  const got = await prisma.jobLock.updateMany({ where: { name, lockedUntil: { lt: now } }, data: { lockedUntil: until, runId: randomUUID() } });
  if (got.count) return true;
  try {
    await prisma.jobLock.create({ data: { name, lockedUntil: until } });
    return true;
  } catch {
    return false;
  }
}
const releaseLock = (name: string) => prisma.jobLock.update({ where: { name }, data: { lockedUntil: new Date(0), runId: null } }).catch(() => {});

/**
 * Runs Coetha for one client. `actor` is the staff member who pressed "Run Coetha" (they must be
 * able to open this client's books); null is the daily run. Creates proposals only.
 */
export async function runCoetha(actor: Actor | null, clientId: string, opts: { trigger?: "MANUAL" | "DAILY"; month?: string; today?: string } = {}) {
  if (actor) await assertLedger(actor, clientId);
  await assertManagedBusiness(clientId);
  await bookOf(clientId);
  // "Client prefers no Coetha": refused before anything is read or sent.
  await assertCoethaAllowed(clientId);
  if (!(await coethaOn())) throw new ValidationError(COETHA_OFF);
  if (!coethaKeyPresent()) throw new ValidationError(COETHA_NO_KEY);
  if (opts.month && !/^\d{4}-(0[1-9]|1[0-2])$/.test(opts.month)) throw new ValidationError("Choose a month.");
  const lock = `coetha:${clientId}`;
  if (!(await takeLock(lock, 10))) throw new ValidationError("Coetha is already working on this business. Try again in a few minutes.");
  const model = coethaModel();
  const run = await prisma.coethaRun.create({ data: { clientId, trigger: opts.trigger ?? "MANUAL", startedById: actor?.id ?? null, model } });
  try {
    const built = await buildCoethaInput(actor ?? DAILY_READER, clientId, opts);
    await prisma.coethaRun.update({ where: { id: run.id }, data: { inputHash: built.inputHash, transactions: built.toCat.length } });
    let res;
    try {
      res = await callCoethaModel(built.input);
    } catch (err) {
      const msg = err instanceof CoethaModelError ? err.message : "Coetha couldn't finish.";
      await prisma.coethaRun.update({ where: { id: run.id }, data: { status: "FAILED", finishedAt: new Date(), error: `${err instanceof CoethaModelError ? err.code : "ERROR"}: ${msg}`.slice(0, 300) } });
      throw new ValidationError(`Coetha couldn't finish: ${msg}`);
    }
    const { proposals, dropped } = toProposals(res.output, built);
    const covered = built.toCat.map((t) => t.id);
    await prisma.$transaction(async (tx) => {
      // Earlier open drafts this run replaces: categories for the same transactions, and every other kind.
      await tx.coethaProposal.updateMany({ where: { clientId, status: "PROPOSED", model: { not: "rules" }, OR: [{ kind: { not: "CATEGORY" } }, { bankTransactionId: { in: covered } }] }, data: { status: "SUPERSEDED" } });
      if (proposals.length) {
        await tx.coethaProposal.createMany({ data: proposals.map((p) => ({ clientId, runId: run.id, kind: p.kind, payload: p.payload, bankTransactionId: p.bankTransactionId ?? null, confidence: p.confidence ?? null, reason: p.reason, model: res.model, inputHash: built.inputHash })) });
      }
      await tx.coethaRun.update({
        where: { id: run.id },
        data: { status: "OK", finishedAt: new Date(), model: res.model, proposals: proposals.length, inputTokens: res.inputTokens, outputTokens: res.outputTokens, requestId: res.requestId, error: dropped ? `${dropped} suggestion${dropped === 1 ? "" : "s"} referred to unknown transactions or accounts and were dropped.` : null },
      });
    });
    await audit(prisma, { actorId: actor?.id ?? null, action: "coetha.run", entityType: "CoethaRun", entityId: run.id, clientId, details: { trigger: opts.trigger ?? "MANUAL", model: res.model, transactions: built.toCat.length, proposals: proposals.length, dropped, inputHash: built.inputHash } });
    return { runId: run.id, proposals: proposals.length, dropped };
  } catch (err) {
    await prisma.coethaRun.updateMany({ where: { id: run.id, status: "RUNNING" }, data: { status: "FAILED", finishedAt: new Date(), error: err instanceof ValidationError ? err.message.slice(0, 300) : "Unexpected error" } });
    throw err;
  } finally {
    await releaseLock(lock);
  }
}

/**
 * Optional daily run (same switch and key): each Managed Business with bank transactions waiting
 * for review that arrived since its last Coetha run, from ANY source (the office's daily CSV
 * statement imports, or a bank connection if one is ever turned on), at most once a day and 2
 * businesses an hour (each run must finish within the hosting time limit). Plaid is not needed.
 */
export async function runDailyCoetha(now = new Date()) {
  const s = await coethaStatus();
  if (!s.ready) return { ran: 0, failed: 0, skipped: s.enabled ? "no API key" : "switched off" };
  // Clients who prefer no Coetha are never picked.
  const optedOut = await optedOutClientIds();
  const books = await prisma.ledgerBook.findMany({ where: { clientId: { in: (await officeBookClientIds()).filter((id) => !optedOut.has(id)) } }, select: { clientId: true, coethaRuns: { orderBy: { startedAt: "desc" }, take: 1, select: { startedAt: true } } } });
  const due: string[] = [];
  for (const b of books) {
    const last = b.coethaRuns[0]?.startedAt ?? null;
    if (last && now.getTime() - last.getTime() < 20 * 3600_000) continue;
    const fresh = await prisma.bankTransaction.count({ where: { clientId: b.clientId, status: "UNREVIEWED", ...(last ? { createdAt: { gt: last } } : {}) } });
    if (fresh) due.push(b.clientId);
    if (due.length >= 2) break;
  }
  let ran = 0, failed = 0;
  for (const clientId of due) {
    try { await runCoetha(null, clientId, { trigger: "DAILY" }); ran++; } catch { failed++; }
  }
  return { ran, failed };
}

// --- Tabitha's decisions ------------------------------------------------------------------------

type Payload = Record<string, unknown>;
const pl = (p: CoethaProposal) => p.payload as Payload;

export type Decision = { id: string; result: "APPROVED" | "ALREADY_APPROVED" | "REJECTED" | "SKIPPED"; journalEntryId?: string | null; message?: string };

/**
 * Approves one proposal. Only Tabitha. The proposal is claimed and posted in ONE transaction:
 * if posting fails (closed period, already posted, inactive account) nothing is approved. A
 * second approval of the same proposal posts nothing and reports the first one's entry.
 * Discrepancies and month summaries are acknowledged; they never post.
 */
export async function approveCoethaProposal(actor: Actor, clientId: string, proposalId: string, opts: { accountId?: string | null; note?: string } = {}): Promise<Decision> {
  await assertCanApproveCoethaWork(actor);
  await assertLedgerWrite(actor, clientId);
  // Earlier drafts can still be rejected, but none of Coetha's work reaches the books of a client who prefers no Coetha.
  await assertCoethaAllowed(clientId);
  const p = await prisma.coethaProposal.findFirst({ where: { id: proposalId, clientId } });
  if (!p) throw new ValidationError("Proposal not found.");
  if (p.status === "APPROVED") return { id: p.id, result: "ALREADY_APPROVED", journalEntryId: p.journalEntryId };
  if (p.status !== "PROPOSED") throw new ValidationError(`This proposal was already ${p.status === "REJECTED" ? "rejected" : "replaced by a newer Coetha run"}.`);
  if (p.kind === "CATEGORY") {
    const t = await prisma.bankTransaction.findFirst({ where: { id: p.bankTransactionId ?? "", clientId }, select: { status: true } });
    if (!t || t.status !== "UNREVIEWED") {
      await prisma.coethaProposal.updateMany({ where: { id: p.id, status: "PROPOSED" }, data: { status: "SUPERSEDED", decisionNote: "The transaction was already posted or excluded by staff." } });
      throw new ValidationError("That transaction was already posted or excluded by staff, so Coetha's recommendation no longer applies.");
    }
  }
  const note = opts.note?.trim().slice(0, 300) || null;
  // A classification recommendation changes the business profile only through Tabitha's own
  // classification rule (validated, kept consistent with the books, audited).
  if (p.kind === "CLASSIFICATION") {
    const claimed = await prisma.coethaProposal.updateMany({ where: { id: p.id, clientId, status: "PROPOSED" }, data: { status: "APPROVED", decidedById: actor.id, decidedAt: new Date(), decisionNote: note } });
    if (!claimed.count) return { id: p.id, result: "ALREADY_APPROVED", journalEntryId: null };
    try {
      await setTaxClassification(actor, clientId, { classification: String(pl(p).recommended) }, { via: "COETHA_PROPOSAL", proposalId: p.id });
    } catch (err) {
      await prisma.coethaProposal.update({ where: { id: p.id }, data: { status: "PROPOSED", decidedById: null, decidedAt: null, decisionNote: null } });
      throw err;
    }
    await audit(prisma, { actorId: actor.id, action: "coetha.proposal_approved", entityType: "CoethaProposal", entityId: p.id, clientId, details: { kind: p.kind, runId: p.runId, model: p.model, recommended: String(pl(p).recommended), note } });
    return { id: p.id, result: "APPROVED", journalEntryId: null };
  }
  const recommended = p.kind === "CATEGORY" ? String(pl(p).accountId) : null;
  const chosen = p.kind === "CATEGORY" ? opts.accountId || recommended : null;
  const out = await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${"coetha-proposal:" + p.id}))`;
    const claimed = await tx.coethaProposal.updateMany({ where: { id: p.id, clientId, status: "PROPOSED" }, data: { status: "APPROVED", decidedById: actor.id, decidedAt: new Date(), decisionNote: note, approvedAccountId: chosen } });
    if (!claimed.count) {
      const now = await tx.coethaProposal.findUniqueOrThrow({ where: { id: p.id } });
      if (now.status === "APPROVED") return { id: p.id, result: "ALREADY_APPROVED" as const, journalEntryId: now.journalEntryId };
      throw new ValidationError("This proposal was already decided.");
    }
    let entryId: string | null = null;
    if (p.kind === "CATEGORY") {
      const r = await categorizeBankTransactionTx(tx, actor, clientId, p.bankTransactionId!, { accountId: chosen! });
      entryId = r.entry.id;
    } else if (p.kind === "ADJUSTING_ENTRY" || (p.kind === "RECOMMENDATION" && pl(p).entry)) {
      const d = (p.kind === "RECOMMENDATION" ? pl(p).entry : pl(p)) as { date: string; memo: string; lines: { accountId: string; debitCents: number; creditCents: number; description: string }[] };
      const e = await postJournalEntryTx(tx, actor, clientId, {
        date: d.date,
        memo: d.memo,
        adjusting: true,
        sourceKey: `coetha:${p.id}`,
        reason: p.reason.slice(0, 300),
        lines: d.lines.map((l) => ({ accountId: l.accountId, debit: l.debitCents ? (l.debitCents / 100).toFixed(2) : undefined, credit: l.creditCents ? (l.creditCents / 100).toFixed(2) : undefined, description: l.description })),
      });
      entryId = e.id;
    }
    if (entryId) await tx.coethaProposal.update({ where: { id: p.id }, data: { journalEntryId: entryId } });
    await audit(tx, {
      actorId: actor.id, action: "coetha.proposal_approved", entityType: "CoethaProposal", entityId: p.id, clientId,
      details: { kind: p.kind, runId: p.runId, model: p.model, journalEntryId: entryId, ...(p.kind === "CATEGORY" ? { recommendedAccountId: recommended, approvedAccountId: chosen, edited: chosen !== recommended } : {}), note },
    });
    return { id: p.id, result: "APPROVED" as const, journalEntryId: entryId };
  });
  return out;
}

/** Rejects one proposal (nothing is posted). Only Tabitha. */
export async function rejectCoethaProposal(actor: Actor, clientId: string, proposalId: string, note?: string): Promise<Decision> {
  await assertCanApproveCoethaWork(actor);
  await assertLedger(actor, clientId);
  const n = note?.trim().slice(0, 300) || null;
  const r = await prisma.coethaProposal.updateMany({ where: { id: proposalId, clientId, status: "PROPOSED" }, data: { status: "REJECTED", decidedById: actor.id, decidedAt: new Date(), decisionNote: n } });
  if (!r.count) throw new ValidationError("Only an open proposal can be rejected.");
  const p = await prisma.coethaProposal.findUniqueOrThrow({ where: { id: proposalId } });
  await audit(prisma, { actorId: actor.id, action: "coetha.proposal_rejected", entityType: "CoethaProposal", entityId: proposalId, clientId, details: { kind: p.kind, runId: p.runId, model: p.model, note: n } });
  return { id: proposalId, result: "REJECTED" };
}

/** Bulk decisions: each proposal on its own (one failure doesn't stop or undo the others). */
export async function decideCoethaProposals(actor: Actor, clientId: string, decision: "APPROVE" | "REJECT", items: { id: string; accountId?: string | null }[], note?: string) {
  await assertCanApproveCoethaWork(actor);
  if (!items.length) throw new ValidationError("Choose at least one proposal.");
  if (items.length > 200) throw new ValidationError("Choose at most 200 at a time.");
  const results: Decision[] = [];
  for (const it of items) {
    try {
      results.push(decision === "APPROVE" ? await approveCoethaProposal(actor, clientId, it.id, { accountId: it.accountId, note }) : await rejectCoethaProposal(actor, clientId, it.id, note));
    } catch (err) {
      if (err instanceof ForbiddenError) throw err;
      results.push({ id: it.id, result: "SKIPPED", message: err instanceof Error ? err.message : "Failed" });
    }
  }
  return results;
}

// --- The Coetha page ----------------------------------------------------------------------------

export async function coethaView(actor: Actor, clientId: string) {
  await assertLedger(actor, clientId);
  const [status, canApprove, book] = await Promise.all([coethaStatus(), canApproveCoethaWork(actor), prisma.ledgerBook.findUnique({ where: { clientId } })]);
  if (!book) return { status, canApprove, book: null as null, open: [], decided: [], runs: [], accounts: [], unreviewed: 0 };
  const [open, decided, runs, accounts, unreviewed] = await Promise.all([
    prisma.coethaProposal.findMany({ where: { clientId, status: "PROPOSED" }, orderBy: [{ kind: "asc" }, { confidence: "desc" }, { createdAt: "asc" }] }),
    prisma.coethaProposal.findMany({ where: { clientId, status: { in: ["APPROVED", "REJECTED"] } }, orderBy: { decidedAt: "desc" }, take: 30 }),
    prisma.coethaRun.findMany({ where: { clientId }, orderBy: { startedAt: "desc" }, take: 15 }),
    prisma.ledgerAccount.findMany({ where: { clientId, active: true, OR: [{ subtype: null }, { subtype: { not: "OPENING_BALANCE" } }] }, orderBy: { code: "asc" }, select: { id: true, code: true, name: true, type: true } }),
    prisma.bankTransaction.count({ where: { clientId, status: "UNREVIEWED" } }),
  ]);
  const people = await prisma.user.findMany({ where: { id: { in: [...new Set([...decided.map((d) => d.decidedById), ...runs.map((r) => r.startedById)].filter((x): x is string => !!x))] } }, select: { id: true, name: true } });
  const nameOf = new Map(people.map((u) => [u.id, u.name]));
  return {
    status, canApprove, book, accounts, unreviewed,
    open: open.map((p) => ({ ...p, payload: pl(p) })),
    decided: decided.map((p) => ({ ...p, payload: pl(p), decidedByName: p.decidedById ? nameOf.get(p.decidedById) ?? "Staff" : null })),
    runs: runs.map((r) => ({ ...r, startedByName: r.startedById ? nameOf.get(r.startedById) ?? "Staff" : "Daily run" })),
  };
}

export const money = usd;
