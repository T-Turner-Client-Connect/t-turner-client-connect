import "server-only";
import { prisma } from "@/lib/prisma";
import { audit } from "@/lib/audit";
import type { Actor } from "@/lib/auth/actor";
import { pdfLines } from "@/lib/statement-pdf";
import { ValidationError } from "./clients";

/**
 * Tabitha's client banking list: each client's banks and account endings. Coetha checks every
 * registered account against it together with the statements on file, and, under the standing
 * authorization, corrects what the list proves wrong:
 *  - an account whose ending is on the list but under another bank: the bank is corrected;
 *  - an account registered with no ending (e.g. "Chase"), when the list has exactly one account of
 *    that kind for the client: it takes the list's bank and ending;
 *  - an account on the list that isn't registered (and isn't closed): it is added.
 * Nothing in the books changes; every correction is audited. The list never verifies an account by
 * itself: only a statement showing the business, the bank and the ending does (verifyAccount). An
 * account is never added twice: when a registered account might already be it, it is flagged instead.
 * Clients the list gives no bank for are left untouched.
 */

export type RefEntry = { institution: string; kind: string; ending: string; note: string };

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\b(bank|banks|na|n a|the|of|credit union|fcu|federal credit union|llc|inc|co|corp|business|checking|savings|account|acct)\b/g, " ").replace(/\s+/g, " ").trim();
const digits = (s: string | null | undefined) => (s ?? "").replace(/\D/g, "");

/** Same bank? Compared on the bank's own words ("Regions" ~ "Regions Bank - LifeGreen Business Checking"). */
export function sameBank(a: string | null | undefined, b: string | null | undefined) {
  const x = norm(a ?? ""), y = norm(b ?? "");
  if (!x || !y) return false;
  const fx = x.split(" ")[0], fy = y.split(" ")[0];
  return fx === fy || ` ${y} `.includes(` ${x} `) || ` ${x} `.includes(` ${y} `);
}

/** Same account ending? ("181" ~ "0181"; "170-02" ~ "17002"). */
export function sameEnding(a: string | null | undefined, b: string | null | undefined) {
  const x = digits(a), y = digits(b);
  if (x.length < 2 || y.length < 2) return false;
  return x === y || (Math.min(x.length, y.length) >= 3 && (x.endsWith(y) || y.endsWith(x)));
}

const KIND_OF_TYPE: Record<string, string> = { CHECKING: "DEPOSIT", SAVINGS: "DEPOSIT", CREDIT_CARD: "CREDIT_CARD", LINE_OF_CREDIT: "LINE_OF_CREDIT", LOAN: "LOAN" };
const kindFits = (kind: string, type: string) => kind === "UNKNOWN" || KIND_OF_TYPE[kind] === KIND_OF_TYPE[type];

export async function bankingReference(clientId: string): Promise<RefEntry[]> {
  const p = await prisma.bookkeepingProfile.findUnique({ where: { clientId }, select: { bankingReference: true } });
  return Array.isArray(p?.bankingReference) ? (p!.bankingReference as RefEntry[]) : [];
}

/** Does Tabitha's banking list name this account (its ending, and its bank when the list gives one)? */
export function onList(ref: RefEntry[], a: { institution: string; last4: string | null }) {
  return ref.some((e) => e.ending && sameEnding(e.ending, a.last4) && (!e.institution || sameBank(e.institution, a.institution)));
}

/** Reads Tabitha's banking list (PDF), matches each row to a bookkeeping client, saves it and applies it. */
export async function importBankingList(actor: Actor, bytes: Uint8Array) {
  const { isPrimaryOwner } = await import("@/lib/auth/permissions");
  if (!(await isPrimaryOwner(actor.id))) throw new ValidationError("Only Tabitha loads the banking list.");
  const lines = await pdfLines(bytes).catch(() => null);
  if (!lines?.length) throw new ValidationError("That file's text can't be read. Upload the list as a PDF with text (not a scan).");
  const { callBankingListReader } = await import("@/lib/coetha-model");
  const { output } = await callBankingListReader(lines);
  const clients = await prisma.client.findMany({
    where: { archivedAt: null, bookkeepingProfile: { isNot: null } },
    select: { id: true, displayName: true, businessName: true, firstName: true, lastName: true, bookkeepingProfile: { select: { legalName: true, dba: true } } },
  });
  const n = (s: string | null | undefined) => (s ?? "").toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\b(llc|inc|co|corp|the|pllc|ltd)\b/g, " ").replace(/\s+/g, " ").trim();
  const matched: { clientId: string; name: string; accounts: RefEntry[] }[] = [];
  const unmatched: string[] = [];
  for (const row of output.rows) {
    const biz = n(row.business), person = n(row.owner);
    const hits = clients.filter((c) => {
      const names = [c.businessName, c.bookkeepingProfile?.legalName, c.bookkeepingProfile?.dba].map(n).filter((x) => x.length >= 4);
      if (biz.length >= 4 && names.some((x) => x === biz || (x.length >= 6 && biz.length >= 6 && (x.includes(biz) || biz.includes(x))))) return true;
      const own = [n(c.displayName), n([c.firstName, c.lastName].filter(Boolean).join(" "))].filter((x) => x.length >= 5);
      return !biz && person.length >= 5 && own.includes(person);
    });
    // A business name shared by two clients (or an owner with two businesses and no business name) isn't guessed.
    const pick = hits.length === 1 ? hits[0] : null;
    const label = [row.owner, row.business].filter(Boolean).join(" - ") || "(no name)";
    if (!pick) { unmatched.push(label); continue; }
    const accounts = row.accounts.map((a) => ({ institution: a.institution.trim().slice(0, 80), kind: a.kind, ending: a.ending.replace(/[^\d-]/g, "").slice(0, 12), note: a.note.trim().slice(0, 120) })).filter((a) => a.institution || a.ending);
    // A client the list gives no bank or ending for is left untouched until Tabitha provides them.
    if (!accounts.length) continue;
    const prior = matched.find((m) => m.clientId === pick.id);
    if (prior) prior.accounts.push(...accounts); else matched.push({ clientId: pick.id, name: pick.businessName || pick.displayName, accounts });
  }
  for (const m of matched) {
    await prisma.bookkeepingProfile.update({ where: { clientId: m.clientId }, data: { bankingReference: m.accounts, bankingReferenceAt: new Date() } });
    await audit(prisma, { actorId: actor.id, action: "banking.reference_loaded", entityType: "Client", entityId: m.clientId, clientId: m.clientId, details: { accounts: m.accounts.map((a) => `${a.institution || "bank not given"} ${a.ending ? `ending ${a.ending}` : ""}`.trim()) } });
  }
  const applied = [];
  for (const m of matched) applied.push({ name: m.name, ...(await applyBankingReference(actor, m.clientId)) });
  return { matched: matched.length, unmatched, applied };
}

/** Applies the client's banking list to its registered accounts (see the header), then verifies each account. */
export async function applyBankingReference(actor: Actor, clientId: string) {
  const ref = await bankingReference(clientId);
  const done: string[] = [];
  if (ref.length) {
    const regs = await prisma.bookkeepingAccount.findMany({ where: { clientId, active: true, parentAccountId: null, accountType: { in: Object.keys(KIND_OF_TYPE) } }, include: { ledgerAccount: true } });
    const used = new Set<string>();
    const fix = async (r: (typeof regs)[number], data: { institution?: string; last4?: string }, why: string) => {
      const before = { institution: r.institution, last4: r.last4 };
      await prisma.bookkeepingAccount.update({ where: { id: r.id }, data: { ...data, updatedById: actor.id } });
      if (r.ledgerAccount) {
        const oldName = r.ledgerAccount.name;
        const name = data.institution && r.institution && oldName.toLowerCase().includes(r.institution.toLowerCase())
          ? oldName.replace(new RegExp(r.institution.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"), data.institution)
          : oldName;
        await prisma.ledgerAccount.update({ where: { id: r.ledgerAccount.id }, data: { name: name.slice(0, 120), ...(data.institution ? { institution: data.institution.slice(0, 80) } : {}), ...(data.last4 ? { last4: data.last4 } : {}) } });
      }
      await audit(prisma, { actorId: actor.id, action: "banking.account_corrected_from_list", entityType: "BookkeepingAccount", entityId: r.id, clientId, details: { before, after: data, why } });
      done.push(`${before.institution}${before.last4 ? ` ••${before.last4}` : ""} → ${data.institution ?? before.institution}${(data.last4 ?? before.last4) ? ` ••${data.last4 ?? before.last4}` : ""} (${why})`);
    };
    // 1. Same ending, other bank: the bank is corrected.
    for (const e of ref) {
      if (!e.ending) continue;
      const r = regs.find((x) => !used.has(x.id) && sameEnding(e.ending, x.last4));
      if (!r) continue;
      used.add(r.id);
      (e as RefEntry & { _used?: boolean })._used = true;
      if (e.institution && !sameBank(e.institution, r.institution)) await fix(r, { institution: e.institution.split(" - ")[0].trim() }, "the banking list shows this ending at that bank");
    }
    // 2. Registered with no ending: takes the only list account of its kind (bank and ending).
    for (const r of regs.filter((x) => !used.has(x.id) && !x.last4)) {
      const fits = ref.filter((e) => !(e as { _used?: boolean })._used && e.ending && kindFits(e.kind, r.accountType) && !/closed/i.test(e.note));
      const sameKindRegs = regs.filter((x) => !used.has(x.id) && !x.last4 && KIND_OF_TYPE[x.accountType] === KIND_OF_TYPE[r.accountType]);
      if (fits.length === 1 && sameKindRegs.length === 1) {
        const e = fits[0];
        (e as { _used?: boolean })._used = true;
        used.add(r.id);
        await fix(r, { ...(e.institution ? { institution: e.institution.split(" - ")[0].trim() } : {}), last4: digits(e.ending) }, "the only account of this kind on the banking list");
      }
    }
    // 3. On the list, not registered (and not closed): added, with the bank the list gives — unless a
    // registered account of the same kind might already be it (no ending, or the same bank): flagged instead.
    const { registerAccount } = await import("./bank-accounts");
    for (const e of ref) {
      if ((e as { _used?: boolean })._used || !e.ending || !e.institution || /closed/i.test(e.note)) continue;
      const type = e.kind === "UNKNOWN" ? "CHECKING" : e.kind;
      const maybe = regs.find((x) => !used.has(x.id) && KIND_OF_TYPE[x.accountType] === KIND_OF_TYPE[type] && (!x.last4 || sameBank(x.institution, e.institution)));
      if (maybe) { done.push(`not added: ${e.institution} ending ${e.ending} may already be registered as ${maybe.institution}${maybe.last4 ? ` ••${maybe.last4}` : ""} (check its statements)`); continue; }
      try {
        const a = await registerAccount(actor, clientId, { institution: e.institution.split(" - ")[0].trim(), accountType: type, last4: digits(e.ending).slice(-6), gl: "NEW" });
        await audit(prisma, { actorId: actor.id, action: "banking.account_added_from_list", entityType: "BookkeepingAccount", entityId: a.id, clientId, details: { institution: a.institution, ending: a.last4, type } });
        done.push(`added ${a.institution} ••${a.last4} (${type.toLowerCase().replace("_", " ")}) from the banking list`);
      } catch { /* e.g. books not set up: listed as not registered below */ }
    }
  }
  // Every account verified against the list and its statements.
  const { verifyAccount } = await import("./account-ownership");
  const accts = await prisma.bookkeepingAccount.findMany({ where: { clientId, active: true, parentAccountId: null, accountType: { in: Object.keys(KIND_OF_TYPE) } }, select: { id: true } });
  const statuses = [];
  for (const a of accts) statuses.push(await verifyAccount(actor, a.id));
  return { corrected: done.filter((d) => !d.startsWith("not added")), flagged: done.filter((d) => d.startsWith("not added")), verified: statuses.filter((s) => s.status === "VERIFIED").length, inQuestion: statuses.filter((s) => s.status === "IN_QUESTION").map((s) => s.note) };
}
