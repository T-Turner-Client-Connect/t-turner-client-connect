import "server-only";
import { randomUUID } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { audit } from "@/lib/audit";
import type { Actor } from "@/lib/auth/actor";
import { callCoethaChat, CoethaModelError, coethaKeyPresent, type CoethaChatTurn } from "@/lib/coetha-model";
import { ValidationError } from "./clients";
import { assertLedger, assertManagedBusiness, bookOf } from "./ledger";
import { coethaOn } from "./owner-switches";
import { assertCoethaAllowed, coethaOptOutView } from "./coetha-opt-out";
import { buildCoethaInput, COETHA_NO_KEY, COETHA_OFF, coethaStatus, scrub } from "./coetha";
import { recordsSnapshot, RECORDS_TOOLS, runRecordsTool } from "./coetha-records-view";

/**
 * "Ask Coetha": the office's back-and-forth conversation with Coetha about ONE client's books.
 *
 * - Only staff who can open this client's books (Admins and the assigned staff member) can read
 *   or add to the conversation. Each business has its own thread; nothing from another client is
 *   read, sent or shown.
 * - Coetha answers from the business's books context (buildCoethaInput, without its batch of
 *   transactions to categorize) and its complete open records (recordsSnapshot: every waiting row
 *   with its draft, counts, cash proof, judgment groups, comparison, documents on file), plus the
 *   question, with long numbers, SSN/EIN shapes, emails and phone numbers removed first.
 * - Her only tools are read-only searches of the same business's history (coetha-records-view).
 *   A reply is text only and never posts, changes, approves, reverses or sends anything.
 *   Corrections still go through Coetha's drafts and Tabitha's approval.
 * - Same switches as a Coetha run: Tabitha's Coetha switch, the API key and "Client prefers no
 *   Coetha". Every question is audited (who, when, model, tokens; not the text).
 */

export const MAX_QUESTION = 2000;
/** How many earlier messages go with each question (the newest ones). */
const HISTORY = 16;
const SHOWN = 60;

export const COETHA_CHAT_PRIVACY =
  "When you ask Coetha a question, your question and this business's bookkeeping data (transaction dates, amounts, shortened descriptions and account names) are sent to Anthropic's API (Claude) under the firm's own API key. Long numbers are shortened to the last 4 digits, and SSNs, EINs, emails and phone numbers are removed first. The conversation is saved in Client Connect for this business only.";

async function takeLock(name: string, seconds: number) {
  const now = new Date();
  const until = new Date(now.getTime() + seconds * 1000);
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

/** The question as it is stored and sent: trimmed, length-checked and de-identified. */
export function cleanQuestion(q: string): string {
  const t = (q ?? "").trim();
  if (!t) throw new ValidationError("Type a question for Coetha.");
  if (t.length > MAX_QUESTION) throw new ValidationError(`Keep the question under ${MAX_QUESTION.toLocaleString()} characters.`);
  return scrub(t, MAX_QUESTION);
}

/** Asks Coetha one question about this client's books and saves both sides of the exchange. */
export async function askCoetha(actor: Actor, clientId: string, question: string, opts: { today?: string } = {}) {
  await assertLedger(actor, clientId);
  await assertManagedBusiness(clientId);
  await bookOf(clientId);
  // "Client prefers no Coetha": refused before anything is read or sent.
  await assertCoethaAllowed(clientId);
  if (!(await coethaOn())) throw new ValidationError(COETHA_OFF);
  if (!coethaKeyPresent()) throw new ValidationError(COETHA_NO_KEY);
  const q = cleanQuestion(question);
  const lock = `coetha-chat:${clientId}`;
  if (!(await takeLock(lock, 120))) throw new ValidationError("Coetha is still answering the last question for this business. Try again in a moment.");
  try {
    const earlier = (await prisma.coethaChatMessage.findMany({ where: { clientId }, orderBy: { createdAt: "desc" }, take: HISTORY, select: { role: true, text: true } })).reverse();
    const built = await buildCoethaInput(actor, clientId, { today: opts.today });
    // The batch a Coetha run categorizes is capped and skips drafted rows; the complete records replace it.
    const { toCategorize: _batch, recentPosted: _recent, ...books } = built.input;
    void _batch; void _recent;
    const records = await recordsSnapshot(actor, clientId);
    const turns: CoethaChatTurn[] = [...earlier.map((m) => ({ role: m.role === "COETHA" ? ("assistant" as const) : ("user" as const), text: m.text })), { role: "user", text: q }];
    let res;
    try {
      res = await callCoethaChat(books, turns, { defs: RECORDS_TOOLS, run: (name, input) => runRecordsTool(clientId, name, input), records });
    } catch (err) {
      const code = err instanceof CoethaModelError ? err.code : "ERROR";
      await audit(prisma, { actorId: actor.id, action: "coetha.chat_failed", entityType: "LedgerBook", entityId: clientId, clientId, details: { code } });
      throw new ValidationError(`Coetha couldn't answer: ${err instanceof CoethaModelError ? err.message : "something went wrong."} Your question wasn't saved; you can send it again.`);
    }
    // Explicit times keep the question just before its answer in the thread.
    const at = Date.now();
    const [asked, answered] = await prisma.$transaction([
      prisma.coethaChatMessage.create({ data: { clientId, role: "USER", text: q, authorId: actor.id, createdAt: new Date(at) } }),
      prisma.coethaChatMessage.create({ data: { clientId, role: "COETHA", text: res.text.slice(0, 20000), model: res.model, inputTokens: res.inputTokens, outputTokens: res.outputTokens, requestId: res.requestId, inputHash: built.inputHash, createdAt: new Date(at + 1) } }),
    ]);
    await audit(prisma, { actorId: actor.id, action: "coetha.chat", entityType: "CoethaChatMessage", entityId: answered.id, clientId, details: { questionId: asked.id, searches: res.searches, waitingRows: records.counts.waitingTotal, model: res.model, inputTokens: res.inputTokens, outputTokens: res.outputTokens, inputHash: built.inputHash } });
    return { questionId: asked.id, answerId: answered.id, text: answered.text };
  } finally {
    await releaseLock(lock);
  }
}

/** The conversation for one business (newest SHOWN messages, oldest first), for staff who can open its books. */
export async function coethaChatView(actor: Actor, clientId: string) {
  await assertLedger(actor, clientId);
  const [status, book, optOut, rows] = await Promise.all([
    coethaStatus(),
    prisma.ledgerBook.findUnique({ where: { clientId }, select: { clientId: true } }),
    coethaOptOutView(clientId),
    prisma.coethaChatMessage.findMany({ where: { clientId }, orderBy: { createdAt: "desc" }, take: SHOWN }),
  ]);
  const people = await prisma.user.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.authorId).filter((x): x is string => !!x))] } }, select: { id: true, name: true } });
  const nameOf = new Map(people.map((u) => [u.id, u.name]));
  const messages = rows.reverse().map((m) => ({ id: m.id, role: m.role as "USER" | "COETHA", text: m.text, createdAt: m.createdAt, author: m.role === "USER" ? (m.authorId ? nameOf.get(m.authorId) ?? "Staff" : "Staff") : "Coetha" }));
  return { status, hasBook: !!book, optedOut: !!optOut, messages, canAsk: status.ready && !!book && !optOut };
}
