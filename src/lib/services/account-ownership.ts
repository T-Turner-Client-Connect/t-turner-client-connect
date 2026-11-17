import "server-only";
import { prisma } from "@/lib/prisma";
import { audit } from "@/lib/audit";
import type { Actor } from "@/lib/auth/actor";
import { pdfLines } from "@/lib/statement-pdf";
import { ValidationError } from "./clients";
import { readDocumentBytes } from "./documents";

/**
 * Whose bank or card account is this? A business's accounts are its actual accounts at its actual
 * banks. Nothing here (or anywhere) infers a bank from a chart-of-accounts number: "1000" and "2100"
 * are only places in the books.
 *
 * VERIFIED     a statement on file prints this bank, this account's last 4 and the business's own name.
 * IN_QUESTION  the statements contradict the registration (another bank, another account number), or
 *              they are in a person's name rather than the business's (it may be a personal account).
 *              Posting, importing and reconciling its activity are refused until it is resolved.
 * NOT_CHECKED  no readable statement on file yet. Nothing is blocked.
 *
 * Tabitha's own decision (Owner's Office → Account verification) is kept and never overwritten by
 * the automatic check.
 */

const STATEMENT_TYPES = ["BANK_STATEMENT", "CARD_STATEMENT"];
const DECIDED = "Decided by Tabitha";
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\b(llc|inc|co|corp|corporation|company|the|pllc|ltd|bank|na|n a|of|and)\b/g, " ").replace(/\s+/g, " ").trim();

export const OWNERSHIP_LABEL: Record<string, string> = { VERIFIED: "Verified from its statement", IN_QUESTION: "Ownership in question", NOT_CHECKED: "Not verified yet" };

const labelOf = (a: { institution: string; nickname: string | null; last4: string | null }) => `${a.nickname || a.institution}${a.last4 ? ` ••${a.last4}` : ""}`;

/** Refuses posting, importing or reconciling the activity of an account whose ownership is in question. */
export async function assertOwnershipResolved(ledgerAccountId: string | null | undefined) {
  if (!ledgerAccountId) return;
  const a = await prisma.bookkeepingAccount.findFirst({ where: { ledgerAccountId }, select: { institution: true, nickname: true, last4: true, ownershipStatus: true, ownershipNote: true } });
  if (a?.ownershipStatus === "IN_QUESTION") throw new ValidationError(`Whose account ${labelOf(a)} is, is in question${a.ownershipNote ? `: ${a.ownershipNote}` : ""}. Its activity isn't posted, imported or reconciled until that is resolved.`);
}

async function namesOf(clientId: string) {
  const c = await prisma.client.findUniqueOrThrow({ where: { id: clientId }, select: { clientType: true, displayName: true, businessName: true, firstName: true, lastName: true, bookkeepingProfile: { select: { legalName: true, dba: true } } } });
  const business = c.clientType === "BUSINESS" || !!c.businessName;
  const own = business
    ? [c.businessName, c.bookkeepingProfile?.legalName, c.bookkeepingProfile?.dba, c.businessName ? null : c.displayName].filter((n): n is string => !!n).map(norm).filter((n) => n.length >= 4)
    : [[c.firstName, c.lastName].filter(Boolean).join(" "), c.displayName].map(norm).filter((n) => n.length >= 4);
  const owners = business ? (await prisma.businessOwner.findMany({ where: { clientId, archivedAt: null }, select: { contact: { select: { name: true } } } })).map((o) => norm(o.contact.name ?? "")).filter((n) => n.length >= 4) : [];
  if (business && c.firstName && c.lastName) owners.push(norm(`${c.firstName} ${c.lastName}`));
  return { business, own: [...new Set(own)], owners: [...new Set(owners)] };
}

/** Checks one registered account against the statements on file. Returns the new status and why. */
export async function verifyAccount(actor: Actor | null, accountId: string) {
  const a = await prisma.bookkeepingAccount.findUniqueOrThrow({ where: { id: accountId } });
  if (a.ownershipNote?.startsWith(DECIDED)) return { status: a.ownershipStatus, note: a.ownershipNote, changed: false };
  const docs = await prisma.document.findMany({
    where: { clientId: a.clientId, deletedAt: null, bookkeepingAccountId: a.id, OR: [{ docType: { in: STATEMENT_TYPES } }, { category: "BOOKKEEPING" }] },
    orderBy: { createdAt: "desc" }, take: 6, include: { file: true },
  });
  const { accountNumbersIn, bankNameIn } = await import("./statement-choice");
  const names = await namesOf(a.clientId);
  const inst = norm(a.institution);
  let status = "NOT_CHECKED";
  let note = "No readable statement for this account is on file yet.";
  const problems: string[] = [];
  for (const d of docs) {
    const bytes = d.file ? await readDocumentBytes(d.file).catch(() => null) : null;
    const lines = bytes && /pdf/i.test(d.file?.mimeType ?? "") ? await pdfLines(bytes).then((l) => l?.slice(0, 200) ?? null).catch(() => null) : null;
    if (!lines?.length) continue;
    const flat = ` ${norm(lines.join(" "))} `;
    const numbers = accountNumbersIn(lines);
    const printedBank = bankNameIn(lines);
    const bankOk = inst.length >= 3 && flat.includes(` ${inst} `);
    const numberOk = !a.last4 || numbers.has(a.last4);
    const ownOk = names.own.some((n) => flat.includes(` ${n} `));
    const personOnly = !ownOk && names.business && names.owners.some((n) => flat.includes(` ${n} `));
    if (bankOk && numberOk && ownOk && a.last4) { status = "VERIFIED"; note = `“${d.title}” prints ${a.institution}, ••${a.last4} and the business's name.`; break; }
    if (!bankOk && printedBank) problems.push(`Registered as ${a.institution}, but “${d.title}” is from ${printedBank}.`);
    else if (!numberOk) problems.push(`“${d.title}” doesn't show ••${a.last4}${numbers.size ? ` (it shows ${[...numbers].slice(0, 3).map((n) => `••${n}`).join(", ")})` : ""}.`);
    else if (personOnly) problems.push(`“${d.title}” is in a person's name, not the business's: it may be a personal account.`);
    else if (!ownOk) problems.push(`“${d.title}” doesn't show this client's name.`);
  }
  if (status !== "VERIFIED" && problems.length) { status = "IN_QUESTION"; note = problems.slice(0, 3).join(" "); }
  const changed = status !== a.ownershipStatus || note !== a.ownershipNote;
  await prisma.bookkeepingAccount.update({ where: { id: a.id }, data: { ownershipStatus: status, ownershipNote: note.slice(0, 500), ownershipCheckedAt: new Date() } });
  if (changed) await audit(prisma, { actorId: actor?.id ?? null, action: "banking.account_ownership_checked", entityType: "BookkeepingAccount", entityId: a.id, clientId: a.clientId, details: { account: labelOf(a), from: a.ownershipStatus, to: status, note: note.slice(0, 300) } });
  return { status, note, changed };
}

/** Coetha (or a person) puts an account in question with the reason: its activity waits until it is resolved. */
export async function holdAccount(actor: Actor, clientId: string, accountId: string, reason: string) {
  const a = await prisma.bookkeepingAccount.findFirst({ where: { id: accountId, clientId } });
  if (!a) throw new ValidationError("That account isn't registered for this client.");
  const why = reason.trim();
  if (why.length < 10) throw new ValidationError("Give the reason.");
  await prisma.bookkeepingAccount.update({ where: { id: a.id }, data: { ownershipStatus: "IN_QUESTION", ownershipNote: why.slice(0, 500), ownershipCheckedAt: new Date() } });
  await audit(prisma, { actorId: actor.id, action: "banking.account_ownership_held", entityType: "BookkeepingAccount", entityId: a.id, clientId, details: { account: labelOf(a), reason: why.slice(0, 300) } });
}

/** Tabitha's decision on an account (kept; the automatic check never overrides it). */
export async function decideAccountOwnership(actor: Actor, accountId: string, decision: "VERIFIED" | "IN_QUESTION" | "RECHECK", note?: string) {
  const { isPrimaryOwner } = await import("@/lib/auth/permissions");
  if (!(await isPrimaryOwner(actor.id))) throw new ValidationError("Only Tabitha decides whose account this is.");
  const a = await prisma.bookkeepingAccount.findUniqueOrThrow({ where: { id: accountId } });
  if (decision === "RECHECK") {
    await prisma.bookkeepingAccount.update({ where: { id: a.id }, data: { ownershipNote: null } });
    return verifyAccount(actor, a.id);
  }
  const text = `${DECIDED}: ${decision === "VERIFIED" ? "the business's own account" : "in question"}${note?.trim() ? ` — ${note.trim()}` : ""}`;
  await prisma.bookkeepingAccount.update({ where: { id: a.id }, data: { ownershipStatus: decision, ownershipNote: text.slice(0, 500), ownershipCheckedAt: new Date() } });
  await audit(prisma, { actorId: actor.id, action: "banking.account_ownership_decided", entityType: "BookkeepingAccount", entityId: a.id, clientId: a.clientId, details: { account: labelOf(a), decision, note: note?.slice(0, 300) ?? null } });
  return { status: decision, note: text, changed: true };
}

/** Checks every registered bank and card account (all bookkeeping clients), oldest check first, within a time budget. */
export async function checkAllAccounts(opts: { budgetMs: number; actor?: Actor | null; staleHours?: number }) {
  const started = Date.now();
  const stale = new Date(Date.now() - (opts.staleHours ?? 24) * 3_600_000);
  const accts = await prisma.bookkeepingAccount.findMany({
    where: { active: true, parentAccountId: null, accountType: { in: ["CHECKING", "SAVINGS", "CREDIT_CARD", "LINE_OF_CREDIT", "LOAN"] }, OR: [{ ownershipCheckedAt: null }, { ownershipCheckedAt: { lt: stale } }] },
    orderBy: [{ ownershipCheckedAt: { sort: "asc", nulls: "first" } }], take: 300, select: { id: true },
  });
  let checked = 0, inQuestion = 0;
  for (const a of accts) {
    if (Date.now() - started > opts.budgetMs) break;
    const r = await verifyAccount(opts.actor ?? null, a.id).catch(() => null);
    checked++;
    if (r?.status === "IN_QUESTION") inQuestion++;
  }
  return { checked, inQuestion, more: checked < accts.length };
}

/** Every bookkeeping client's registered accounts, for Owner's Office → Account verification. */
export async function accountVerificationReport() {
  const clients = await prisma.client.findMany({
    where: { archivedAt: null, bookkeepingAccounts: { some: { active: true } } },
    orderBy: { displayName: "asc" },
    select: {
      id: true, displayName: true, businessName: true,
      bookkeepingAccounts: {
        where: { active: true, parentAccountId: null },
        orderBy: { createdAt: "asc" },
        select: { id: true, institution: true, nickname: true, last4: true, accountType: true, ownershipStatus: true, ownershipNote: true, ownershipCheckedAt: true, ledgerAccount: { select: { code: true, name: true } }, _count: { select: { documents: { where: { deletedAt: null } } } } },
      },
    },
  });
  return clients.map((c) => ({ id: c.id, name: c.businessName || c.displayName, accounts: c.bookkeepingAccounts }));
}

export const VERIFY_ACCOUNTS_TOOL = {
  name: "verify_accounts",
  description: "Check whose each of this client's bank and card accounts is, from the statements on file: VERIFIED when a statement prints the bank, the last 4 and the business's own name; IN_QUESTION when statements show another bank or account number, or are in a person's name rather than the business's (posting, importing and reconciling that account's activity are then refused). Use it before posting or reconciling a month, and after correct_accounts. To put an account in question yourself (for example statements attributed to this business that may be the owner's personal card), pass hold with the account id and the reason. Never decide ownership from a chart-of-accounts number or from a person's name alone.",
  input_schema: { type: "object" as const, properties: { hold: { type: "array", items: { type: "object", properties: { accountId: { type: "string" }, reason: { type: "string" } }, required: ["accountId", "reason"] } } } },
};

export async function runVerifyAccountsTool(actor: Actor, clientId: string, input: { hold?: { accountId: string; reason: string }[] }) {
  const held: string[] = [];
  for (const h of input.hold ?? []) {
    try { await holdAccount(actor, clientId, h.accountId, h.reason); held.push(h.accountId); } catch (e) { return { error: e instanceof Error ? e.message : "Couldn't hold that account." }; }
  }
  const accts = await prisma.bookkeepingAccount.findMany({ where: { clientId, active: true, parentAccountId: null }, select: { id: true, institution: true, nickname: true, last4: true, accountType: true, ownershipStatus: true, ledgerAccount: { select: { code: true } } } });
  const out = [];
  for (const a of accts) {
    const r = held.includes(a.id) ? { status: "IN_QUESTION", note: "Held by Coetha with the reason given." } : await verifyAccount(actor, a.id);
    out.push({ accountId: a.id, account: labelOf(a), type: a.accountType, glCode: a.ledgerAccount?.code ?? null, status: r.status, why: r.note });
  }
  return { accounts: out, note: "IN_QUESTION accounts: their activity isn't posted or reconciled until resolved. Fix a wrong bank or number with correct_accounts, then run this again; Tabitha decides an account whose statements are in a person's name." };
}
