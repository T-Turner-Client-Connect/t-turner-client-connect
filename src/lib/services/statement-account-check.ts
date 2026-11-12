import "server-only";
import { prisma } from "@/lib/prisma";
import { audit } from "@/lib/audit";
import { ForbiddenError, type Actor } from "@/lib/auth/actor";
import { canApproveCoethaWork } from "@/lib/auth/permissions";
import { pdfLines } from "@/lib/statement-pdf";
import { checkStatementAccount, readStatementIdentity, type StatementAccountVerdict } from "@/lib/statement-identity";
import { ValidationError } from "./clients";
import { readDocumentBytes } from "./documents";
import { assertCanViewBanking } from "./bk-permissions";
import { STATEMENT_DOC_TYPES } from "./client-request-scope";

/**
 * Before a statement's transactions go into a business's books, the statement must be shown to be
 * this business's and this account's: the account holder name and the account number's last 4 on
 * the statement itself (statement-identity.ts). Never the bank's name alone.
 *
 * - VERIFIED → imported as before.
 * - MISMATCH → stopped and flagged; no override. File it under the right client and account.
 * - UNCERTAIN → held ("NEEDS_CONFIRMATION") until Tabitha or an Admin confirms it is this account.
 * A confirmation is for that document AND that account: moving the file to another account checks again.
 * Earlier imports are never changed here; reviewStatementAssignments only reports.
 */

export type StatementCheckStatus = "VERIFIED" | "MISMATCH" | "NEEDS_CONFIRMATION" | "CONFIRMED";

type StatementDoc = {
  id: string;
  clientId: string | null;
  bookkeepingAccountId: string | null;
  manualBankAccountId: string | null;
};

const personName = (f?: string | null, l?: string | null) => (f && l ? `${f} ${l}` : null);

async function expectedFor(clientId: string, doc: StatementDoc) {
  const client = await prisma.client.findUniqueOrThrow({ where: { id: clientId }, select: { businessName: true, displayName: true, firstName: true, lastName: true, preferredName: true, spouseFirstName: true, spouseLastName: true } });
  const clientNames = [client.businessName, client.displayName, personName(client.firstName, client.lastName), personName(client.preferredName, client.lastName), personName(client.spouseFirstName, client.spouseLastName ?? client.lastName)].filter((n): n is string => !!n);
  const others = await prisma.client.findMany({ where: { id: { not: clientId }, archivedAt: null }, select: { businessName: true, firstName: true, lastName: true } });
  const otherClientNames = others.flatMap((o) => [o.businessName, personName(o.firstName, o.lastName)]).filter((n): n is string => !!n);
  const label = (a: { nickname?: string | null; name?: string | null; institution: string | null; last4: string | null }) => [a.institution, a.nickname ?? a.name].filter(Boolean).join(" ") + (a.last4 ? ` ••${a.last4}` : "");
  if (doc.bookkeepingAccountId) {
    const a = await prisma.bookkeepingAccount.findFirstOrThrow({ where: { id: doc.bookkeepingAccountId, clientId } });
    const sib = await prisma.bookkeepingAccount.findMany({ where: { clientId, id: { not: a.id } } });
    return { accountId: a.id, exp: { clientNames, otherClientNames, account: { label: label(a), last4: a.last4, institution: a.institution, accountType: a.accountType }, siblings: sib.map((s) => ({ label: label(s), last4: s.last4 })) } };
  }
  if (doc.manualBankAccountId) {
    const a = await prisma.manualBankAccount.findFirstOrThrow({ where: { id: doc.manualBankAccountId, clientId } });
    const sib = await prisma.manualBankAccount.findMany({ where: { clientId, id: { not: a.id } } });
    return { accountId: a.id, exp: { clientNames, otherClientNames, account: { label: label(a), last4: a.last4, institution: a.institution, accountType: a.kind }, siblings: sib.map((s) => ({ label: label(s), last4: s.last4 })) } };
  }
  throw new ValidationError("Choose which of this business's accounts the statement is for first.");
}

/**
 * Checks a statement against the client and account it is filed under and records the result.
 * Returns ok = true when its transactions may be imported.
 */
export async function verifyStatementAccount(actorId: string | null, clientId: string, doc: StatementDoc, lines: string[]): Promise<{ ok: boolean; status: StatementCheckStatus; reasons: string[] }> {
  const { accountId, exp } = await expectedFor(clientId, doc);
  const verdict = checkStatementAccount(readStatementIdentity(lines), exp);
  const prior = await prisma.statementAccountCheck.findUnique({ where: { documentId: doc.id } });
  const confirmed = prior?.status === "CONFIRMED" && prior.accountId === accountId;
  // A confirmation covers what couldn't be read, never a positive mismatch.
  const status: StatementCheckStatus = verdict.status === "VERIFIED" ? "VERIFIED" : verdict.status === "MISMATCH" ? "MISMATCH" : confirmed ? "CONFIRMED" : "NEEDS_CONFIRMATION";
  const keep = status === "CONFIRMED" && prior ? { confirmedById: prior.confirmedById, confirmedAt: prior.confirmedAt, confirmNote: prior.confirmNote } : { confirmedById: null, confirmedAt: null, confirmNote: null };
  await prisma.statementAccountCheck.upsert({
    where: { documentId: doc.id },
    create: { documentId: doc.id, clientId, accountId, status, reasons: verdict.reasons, readLast4: verdict.readLast4, ...keep },
    update: { accountId, status, reasons: verdict.reasons, readLast4: verdict.readLast4, ...keep },
  });
  if (prior?.status !== status || prior.accountId !== accountId) {
    await audit(prisma, { actorId, action: `bookkeeping.statement_account_${status.toLowerCase()}`, entityType: "Document", entityId: doc.id, clientId, details: { accountId, readLast4: verdict.readLast4, reasons: verdict.reasons } });
  }
  return { ok: status === "VERIFIED" || status === "CONFIRMED", status, reasons: verdict.reasons };
}

/** Tabitha or an Admin confirms a held statement is this account's (after checking it). */
export async function confirmStatementAccount(actor: Actor, clientId: string, documentId: string, note: string) {
  if (actor.role !== "ADMIN" && !(await canApproveCoethaWork(actor))) throw new ForbiddenError("Only Tabitha or an Admin can confirm which account a statement belongs to.");
  await assertCanViewBanking(actor, clientId);
  const why = note.trim();
  if (why.length < 5) throw new ValidationError("Say how you confirmed it (for example, “Checked the full account number with the client's bank login”).");
  const check = await prisma.statementAccountCheck.findFirst({ where: { documentId, clientId } });
  if (!check) throw new ValidationError("This statement hasn't been checked yet. Read its transactions first.");
  if (check.status === "MISMATCH") throw new ValidationError("This statement belongs to a different account or client. It can't be confirmed here; file it under the right client and account.");
  if (check.status !== "NEEDS_CONFIRMATION") throw new ValidationError("This statement doesn't need confirming.");
  await prisma.statementAccountCheck.update({ where: { id: check.id }, data: { status: "CONFIRMED", confirmedById: actor.id, confirmedAt: new Date(), confirmNote: why.slice(0, 500) } });
  await audit(prisma, { actorId: actor.id, action: "bookkeeping.statement_account_confirmed", entityType: "Document", entityId: documentId, clientId, details: { accountId: check.accountId, note: why.slice(0, 500), reasons: check.reasons } });
}

/** The statements held or flagged for a business (for the reconciliation page). */
export async function statementChecksNeedingAttention(clientId: string) {
  const rows = await prisma.statementAccountCheck.findMany({ where: { clientId, status: { in: ["MISMATCH", "NEEDS_CONFIRMATION"] } }, orderBy: { updatedAt: "desc" } });
  const docs = await prisma.document.findMany({ where: { id: { in: rows.map((r) => r.documentId) }, deletedAt: null }, select: { id: true, title: true, year: true, month: true } });
  const byId = new Map(docs.map((d) => [d.id, d]));
  return rows.filter((r) => byId.has(r.documentId)).map((r) => ({ ...r, reasons: (r.reasons as string[]) ?? [], document: byId.get(r.documentId)! }));
}

/**
 * Re-checks every statement already filed for this business against the account it was filed under,
 * and reports which were assigned on assumption. Records the result; never moves a file and never
 * changes an imported transaction — a confirmed error is corrected by staff, with its own audit trail.
 */
export async function reviewStatementAssignments(actor: Actor, clientId: string) {
  await assertCanViewBanking(actor, clientId);
  const docs = await prisma.document.findMany({
    where: { clientId, deletedAt: null, docType: { in: STATEMENT_DOC_TYPES }, OR: [{ bookkeepingAccountId: { not: null } }, { manualBankAccountId: { not: null } }] },
    include: { file: true },
    orderBy: [{ year: "asc" }, { month: "asc" }],
  });
  const out: { documentId: string; title: string; month: string | null; status: StatementCheckStatus | "UNREADABLE"; reasons: string[] }[] = [];
  for (const d of docs) {
    const month = d.year && d.month ? `${d.year}-${String(d.month).padStart(2, "0")}` : null;
    const bytes = d.file ? await readDocumentBytes(d.file) : null;
    const lines = bytes ? await pdfLines(bytes).catch(() => null) : null;
    if (!lines?.length) { out.push({ documentId: d.id, title: d.title, month, status: "UNREADABLE", reasons: ["No text could be read from this file, so its account couldn't be checked."] }); continue; }
    const r = await verifyStatementAccount(actor.id, clientId, { ...d, clientId }, lines);
    out.push({ documentId: d.id, title: d.title, month, status: r.status, reasons: r.reasons });
  }
  await audit(prisma, { actorId: actor.id, action: "bookkeeping.statement_assignments_reviewed", entityType: "Client", entityId: clientId, clientId, details: { checked: out.length, flagged: out.filter((o) => o.status === "MISMATCH").length, held: out.filter((o) => o.status === "NEEDS_CONFIRMATION").length } });
  return out;
}

export type { StatementAccountVerdict };
