import "server-only";
import { prisma } from "@/lib/prisma";
import { audit } from "@/lib/audit";
import type { Actor } from "@/lib/auth/actor";
import { ValidationError } from "./clients";
import { accountBalance, assertLedger, bookOf, ledgerFlags, normDesc, toDate, ymdOf } from "./ledger";

/**
 * Groundwork for Coetha (categorizing and the monthly close). Everything here only SUGGESTS or
 * CHECKS: a person posts every transaction and Tabitha approves every close. Nothing is posted,
 * invented or changed automatically.
 */

// --- Categorization rules and suggestions -----------------------------------------------------

export async function addRule(actor: Actor, clientId: string, input: { matchText: string; direction?: "IN" | "OUT" | "ANY"; accountId: string }) {
  await assertLedger(actor, clientId);
  await bookOf(clientId);
  const matchText = normDesc(input.matchText);
  if (matchText.length < 3) throw new ValidationError("Enter at least 3 letters or digits to match.");
  const direction = input.direction ?? "ANY";
  if (!["IN", "OUT", "ANY"].includes(direction)) throw new ValidationError("Choose money in, money out, or either.");
  const account = await prisma.ledgerAccount.findFirst({ where: { id: input.accountId, clientId, active: true } });
  if (!account) throw new ValidationError("Choose one of this client's active accounts.");
  if (account.subtype === "OPENING_BALANCE" || account.subtype === "SUSPENSE") throw new ValidationError("A rule can't point to that account.");
  if (await prisma.categorizationRule.count({ where: { clientId, matchText, direction } })) throw new ValidationError("A rule for that text already exists.");
  const r = await prisma.categorizationRule.create({ data: { clientId, matchText, direction, accountId: account.id, createdById: actor.id } });
  await audit(prisma, { actorId: actor.id, action: "ledger.rule_added", entityType: "CategorizationRule", entityId: r.id, clientId, details: { matchText, direction, account: account.code } });
  return r;
}

export async function setRuleActive(actor: Actor, clientId: string, ruleId: string, active: boolean) {
  await assertLedger(actor, clientId);
  const r = await prisma.categorizationRule.updateMany({ where: { id: ruleId, clientId }, data: { active } });
  if (!r.count) throw new ValidationError("Rule not found.");
  await audit(prisma, { actorId: actor.id, action: active ? "ledger.rule_on" : "ledger.rule_off", entityType: "CategorizationRule", entityId: ruleId, clientId });
}

export type Suggestion = { accountId: string; source: "RULE" | "HISTORY"; why: string };

/**
 * A suggested category for each unreviewed bank row, from (1) staff rules, longest match first,
 * then (2) how the same description was posted before — only when every earlier posting agrees.
 * Rows with no clear answer get no suggestion; they're never guessed.
 */
export async function suggestCategories(actor: Actor, clientId: string): Promise<Map<string, Suggestion>> {
  await assertLedger(actor, clientId);
  const [rows, rules, history] = await Promise.all([
    prisma.bankTransaction.findMany({ where: { clientId, status: "UNREVIEWED" }, select: { id: true, accountId: true, amountCents: true, description: true } }),
    prisma.categorizationRule.findMany({ where: { clientId, active: true } }),
    prisma.bankTransaction.findMany({ where: { clientId, status: "POSTED", journalEntryId: { not: null } }, select: { accountId: true, amountCents: true, description: true, journalEntry: { select: { reversedBy: { select: { id: true } }, lines: { select: { accountId: true } } } } } }),
  ]);
  const active = new Set((await prisma.ledgerAccount.findMany({ where: { clientId, active: true }, select: { id: true } })).map((a) => a.id));
  // Past postings: description + direction → the category account(s) used.
  const past = new Map<string, Set<string>>();
  for (const h of history) {
    if (!h.journalEntry || h.journalEntry.reversedBy) continue;
    const cat = h.journalEntry.lines.find((l) => l.accountId !== h.accountId)?.accountId;
    if (!cat) continue;
    const key = `${normDesc(h.description)}|${h.amountCents > 0 ? "IN" : "OUT"}`;
    past.set(key, (past.get(key) ?? new Set()).add(cat));
  }
  const out = new Map<string, Suggestion>();
  for (const r of rows) {
    const desc = normDesc(r.description);
    const dir = r.amountCents > 0 ? "IN" : "OUT";
    const rule = rules
      .filter((x) => (x.direction === "ANY" || x.direction === dir) && desc.includes(x.matchText) && active.has(x.accountId) && x.accountId !== r.accountId)
      .sort((a, b) => b.matchText.length - a.matchText.length)[0];
    if (rule) {
      out.set(r.id, { accountId: rule.accountId, source: "RULE", why: `Rule: description contains “${rule.matchText}”` });
      continue;
    }
    const seen = past.get(`${desc}|${dir}`);
    if (seen && seen.size === 1) {
      const [acct] = [...seen];
      if (active.has(acct) && acct !== r.accountId) out.set(r.id, { accountId: acct, source: "HISTORY", why: "Same description was posted this way before" });
    }
  }
  return out;
}

// --- Monthly close checklist -------------------------------------------------------------------

export type CloseItem = { key: string; label: string; ok: boolean; detail: string };

const lastDay = (month: string) => ymdOf(new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)));

/**
 * What must be true before a month's statements go to Tabitha for approval. Read only — it
 * reports; it never posts or closes anything.
 */
export async function closeChecklist(actor: Actor, clientId: string, month: string, today?: string) {
  await assertLedger(actor, clientId);
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new ValidationError("Choose a month.");
  const book = await bookOf(clientId);
  const from = toDate(`${month}-01`);
  const end = lastDay(month);
  const to = toDate(end);
  const items: CloseItem[] = [];
  items.push({ key: "opening", label: "Opening balances entered", ok: !!book.openingDate && ymdOf(book.openingDate) <= end, detail: book.openingDate ? `As of ${ymdOf(book.openingDate)}` : "Not entered yet" });
  const banks = await prisma.ledgerAccount.findMany({ where: { clientId, active: true, subtype: { in: ["BANK", "CREDIT_CARD"] } }, orderBy: { code: "asc" } });
  for (const b of banks) {
    const [rows, unreviewed, recon] = await Promise.all([
      prisma.bankTransaction.count({ where: { accountId: b.id, date: { gte: from, lte: to } } }),
      prisma.bankTransaction.count({ where: { accountId: b.id, status: "UNREVIEWED", date: { lte: to } } }),
      prisma.bankReconciliation.findFirst({ where: { accountId: b.id, statementDate: { gte: to } }, orderBy: { statementDate: "asc" } }),
    ]);
    items.push({ key: `import:${b.id}`, label: `${b.name}: statement imported`, ok: rows > 0, detail: rows ? `${rows} transactions in ${month}` : `No transactions imported for ${month}` });
    items.push({ key: `review:${b.id}`, label: `${b.name}: every transaction reviewed`, ok: unreviewed === 0, detail: unreviewed ? `${unreviewed} still to review through ${end}` : "All reviewed" });
    items.push({ key: `recon:${b.id}`, label: `${b.name}: reconciled to the statement`, ok: !!recon, detail: recon ? `Reconciled at ${ymdOf(recon.statementDate)}` : `Not reconciled through ${end}` });
  }
  const suspense = await prisma.ledgerAccount.findFirst({ where: { clientId, subtype: "SUSPENSE" } });
  const parked = suspense ? await accountBalance(clientId, suspense.id, end) : 0;
  items.push({ key: "suspense", label: "Ask My Accountant is empty", ok: parked === 0, detail: parked ? `$${(parked / 100).toFixed(2)} still needs a category` : "Nothing waiting" });
  const flags = (await ledgerFlags(actor, clientId, today ?? `${month}-28`)).filter((f) => f.kind === "POSSIBLE_DRAW" || f.kind === "POSSIBLE_DUPLICATE_INCOME" || f.kind === "CLOSED_PERIOD");
  items.push({ key: "flags", label: "No classification warnings", ok: flags.length === 0, detail: flags.length ? flags.map((f) => f.message).join(" ") : "None" });
  return { month, through: end, items, readyForReview: items.every((i) => i.ok) };
}
