import "server-only";
import { randomUUID } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { audit } from "@/lib/audit";
import { ForbiddenError, type Actor } from "@/lib/auth/actor";
import { CHAT_FILE_TYPES, callCoethaChat, CoethaModelError, coethaKeyPresent, type CoethaChatTurn } from "@/lib/coetha-model";
import { ValidationError } from "./clients";
import { assertLedger, assertManagedBusiness, bookOf } from "./ledger";
import { coethaOn } from "./owner-switches";
import { assertCoethaAllowed, coethaOptOutView } from "./coetha-opt-out";
import { buildCoethaInput, COETHA_NO_KEY, COETHA_OFF, coethaStatus, scrub } from "./coetha";
import { recordsSnapshot, RECORDS_TOOLS, runRecordsTool } from "./coetha-records-view";
import { isPrimaryOwner } from "@/lib/auth/permissions";

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
 * - Her tools are read-only searches of the same business's history (coetha-records-view), plus,
 *   only when Tabitha herself is asking, prepare_entries (coetha-decisions): it turns decisions
 *   she stated into drafts on her Apply These Decisions card. A reply never posts, approves,
 *   reverses or sends anything; only Tabitha's Approve & Post does, through the existing path.
 * - Same switches as a Coetha run: Tabitha's Coetha switch, the API key and "Client prefers no
 *   Coetha". Every question is audited (who, when, model, tokens; not the text).
 */

export const MAX_QUESTION = 2000;
/** Files sent to Coetha: PDFs or images, up to MAX_CHAT_FILES per question and 5 MB in all (the page's upload limit is 6 MB). */
export const MAX_CHAT_FILES = 3;
/**
 * Pictures and scanned PDFs go to Coetha as files, which grow by a third on the way; together they
 * stay under this so the request isn't refused before it reaches her. Text PDFs (bank statements,
 * invoices) are sent as their text instead, which is far smaller.
 */
export const MAX_CHAT_RAW = 3 * 1024 * 1024;
/** The most text read from one PDF that is sent (about 40 pages of a bank statement). */
const MAX_PDF_TEXT = 120_000;

/** What Coetha receives for one file: a PDF's text when it has any, else the file itself. */
type ForCoetha = { name: string; text: string } | { mediaType: string; base64: string; raw: number };
async function forCoetha(f: { bytes: Uint8Array; originalName: string; type: string }): Promise<ForCoetha> {
  if (f.type === "application/pdf") {
    const { pdfLines } = await import("@/lib/statement-pdf");
    const lines = await pdfLines(f.bytes);
    const text = (lines ?? []).map((l) => scrub(l, 400)).filter(Boolean).join("\n");
    if (text.replace(/\s/g, "").length >= 40) return { name: f.originalName.slice(0, 120), text: text.slice(0, MAX_PDF_TEXT) };
  }
  return { mediaType: f.type, base64: Buffer.from(f.bytes).toString("base64"), raw: f.bytes.length };
}
export const MAX_CHAT_FILE = 5 * 1024 * 1024;
export type ChatFile = { bytes: Uint8Array; originalName: string; mimeType: string };

/** The file's real type from its first bytes (the browser's label isn't trusted). */
export function chatFileType(bytes: Uint8Array): (typeof CHAT_FILE_TYPES)[number] | null {
  const h = (n: number) => Array.from(bytes.slice(0, n));
  const is = (sig: number[]) => sig.every((b, i) => bytes[i] === b);
  if (is([0x25, 0x50, 0x44, 0x46])) return "application/pdf";
  if (is([0x89, 0x50, 0x4e, 0x47])) return "image/png";
  if (is([0xff, 0xd8, 0xff])) return "image/jpeg";
  if (is([0x47, 0x49, 0x46, 0x38])) return "image/gif";
  if (is([0x52, 0x49, 0x46, 0x46]) && String.fromCharCode(...h(12).slice(8)) === "WEBP") return "image/webp";
  return null;
}
/** How many earlier messages go with each question (the newest ones). */
const HISTORY = 16;
const SHOWN = 60;

/**
 * Chats: the Ask Coetha page keeps separate conversations per business. A question carries the
 * id of the chat it was asked in, and only that chat's earlier messages go with it. What Coetha
 * remembers (coetha-memory) is in every chat. Messages from before chats existed have no chat id
 * and form one "Earlier conversation", addressed as EARLIER_CHAT.
 */
export const EARLIER_CHAT = "earlier";
/** A chat id from the page (or a form): a fresh id for a new chat, EARLIER_CHAT, or null when absent or malformed. */
export function chatKey(raw: unknown): string | null {
  const v = typeof raw === "string" ? raw.trim() : "";
  return v === EARLIER_CHAT || /^c_[A-Za-z0-9-]{8,40}$/.test(v) ? v : null;
}
/** A new chat's id (the chat exists once its first question is asked). */
export const newChatKey = () => `c_${randomUUID()}`;
/** The database value for a chat key: EARLIER_CHAT is stored as null. */
const chatIdOf = (key: string | null | undefined) => (key && key !== EARLIER_CHAT ? key : null);

export const COETHA_CHAT_PRIVACY =
  "When you ask Coetha a question, your question and this business's bookkeeping data (transaction dates, amounts, shortened descriptions and account names) are sent to Anthropic's API (Claude) under the firm's own API key. Long numbers are shortened to the last 4 digits, and SSNs, EINs, emails and phone numbers are removed first. From a PDF with text (a bank statement, an invoice), its text is sent with long numbers shortened to the last 4 digits; a picture or a scanned PDF is sent as it is (a check image shows the account and routing numbers printed on it). Every file is kept as a staff-only document for this business. The conversation is saved in Client Connect for this business only.";

export async function takeLock(name: string, seconds: number) {
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
export const releaseLock = (name: string) => prisma.jobLock.update({ where: { name }, data: { lockedUntil: new Date(0), runId: null } }).catch(() => {});

/** The question as it is stored and sent: trimmed, length-checked and de-identified. */
export function cleanQuestion(q: string): string {
  const t = (q ?? "").trim();
  if (!t) throw new ValidationError("Type a question for Coetha.");
  if (t.length > MAX_QUESTION) throw new ValidationError(`Keep the question under ${MAX_QUESTION.toLocaleString()} characters.`);
  return scrub(t, MAX_QUESTION);
}

/** Asks Coetha one question about this client's books and saves both sides of the exchange. */
export async function askCoetha(actor: Actor, clientId: string, question: string, opts: { today?: string; files?: ChatFile[]; chat?: string | null } = {}) {
  const chatId = chatIdOf(chatKey(opts.chat));
  await assertLedger(actor, clientId);
  await assertManagedBusiness(clientId);
  await bookOf(clientId);
  // "Client prefers no Coetha": refused before anything is read or sent.
  await assertCoethaAllowed(clientId);
  if (!(await coethaOn())) throw new ValidationError(COETHA_OFF);
  if (!coethaKeyPresent()) throw new ValidationError(COETHA_NO_KEY);
  const files = (opts.files ?? []).filter((f) => f.bytes.length);
  if (files.length > MAX_CHAT_FILES) throw new ValidationError(`Send up to ${MAX_CHAT_FILES} files with one question.`);
  if (files.reduce((n, f) => n + f.bytes.length, 0) > MAX_CHAT_FILE) throw new ValidationError(files.length > 1 ? "Keep the files under 5 MB in all." : "Attach a file under 5 MB.");
  const typed = files.map((f) => {
    const type = chatFileType(f.bytes);
    if (!type) throw new ValidationError(`“${f.originalName.slice(0, 80)}” isn't a PDF or a picture (PNG, JPEG, GIF or WebP).`);
    return { ...f, type };
  });
  const parts = await Promise.all(typed.map(forCoetha));
  const raw = parts.reduce((n, p) => n + ("raw" in p ? p.raw : 0), 0);
  if (raw > MAX_CHAT_RAW) throw new ValidationError("Pictures and scanned PDFs can be up to 3 MB in all for one question. Send a smaller picture, just the pages you need, or one file at a time.");
  const q = cleanQuestion(question.trim() || (files.length ? `Please read the attached file${files.length > 1 ? "s" : ""} and tell me what ${files.length > 1 ? "they show" : "it shows"} and how it should be recorded.` : ""));
  const lock = `coetha-chat:${clientId}`;
  if (!(await takeLock(lock, 120))) throw new ValidationError("Coetha is still answering the last question for this business. Try again in a moment.");
  try {
    const earlier = (await prisma.coethaChatMessage.findMany({ where: { clientId, chatId }, orderBy: { createdAt: "desc" }, take: HISTORY, select: { role: true, text: true, attachmentName: true, attachments: true } })).reverse();
    const built = await buildCoethaInput(actor, clientId, { today: opts.today });
    // The batch a Coetha run categorizes is capped and skips drafted rows; the complete records replace it.
    const { toCategorize: _batch, recentPosted: _recent, ...books } = built.input;
    void _batch; void _recent;
    const records = await recordsSnapshot(actor, clientId);
    // Earlier files aren't sent again; Coetha sees which were attached and her answer about them.
    const names = (m: { attachmentName: string | null; attachments: unknown }) => (Array.isArray(m.attachments) ? (m.attachments as { name: string }[]).map((a) => a.name) : m.attachmentName ? [m.attachmentName] : []);
    const turns: CoethaChatTurn[] = [...earlier.map((m) => ({ role: m.role === "COETHA" ? ("assistant" as const) : ("user" as const), text: names(m).length ? `${m.text}\n[Attached earlier: ${names(m).join(", ")}]` : m.text })), { role: "user", text: q }];
    let res;
    try {
      res = await callCoethaChat(books, turns, await chatTools(actor, clientId, records, q), parts.map((p) => ("text" in p ? { name: p.name, text: p.text } : { mediaType: p.mediaType, base64: p.base64 })));
    } catch (err) {
      const code = err instanceof CoethaModelError ? err.code : "ERROR";
      // The AI service is busy (its per-minute limit, or a refusal/connection drop right after it):
      // the question is kept and answered in the background a minute later, never lost.
      if (BUSY_CODES.has(code) && !typed.length) {
        const queued = await prisma.coethaChatMessage.create({ data: { clientId, chatId, role: "USER", text: q, authorId: actor.id, status: "WAITING", jobIds: [] } });
        await audit(prisma, { actorId: actor.id, action: "coetha.chat_queued", entityType: "CoethaChatMessage", entityId: queued.id, clientId, details: { code } });
        return { questionId: queued.id, answerId: null, text: null, queued: true as const };
      }
      await audit(prisma, { actorId: actor.id, action: "coetha.chat_failed", entityType: "LedgerBook", entityId: clientId, clientId, details: { code } });
      throw new ValidationError(`Coetha couldn't answer: ${err instanceof CoethaModelError ? err.message : "something went wrong."} Your question wasn't saved; you can send it again.`);
    }
    // The files are kept only once Coetha has answered (a failed question saves nothing).
    const attachments: { documentId: string; name: string }[] = [];
    if (typed.length) {
      const { staffUploadDocument } = await import("./documents");
      for (const f of typed) {
        const name = f.originalName.slice(0, 200);
        const doc = await staffUploadDocument(actor, { clientId, category: "BOOKKEEPING", title: `Sent to Coetha — ${name}`.slice(0, 200), visibility: "STAFF_ONLY", bytes: f.bytes, originalName: f.originalName, notify: false });
        attachments.push({ documentId: doc.id, name });
      }
    }
    const documentId = attachments[0]?.documentId ?? null;
    const attachmentName = attachments[0]?.name ?? null;
    // Explicit times keep the question just before its answer in the thread.
    const at = Date.now();
    const [asked, answered] = await prisma.$transaction([
      prisma.coethaChatMessage.create({ data: { clientId, chatId, role: "USER", text: q, authorId: actor.id, documentId, attachmentName, ...(attachments.length ? { attachments } : {}), createdAt: new Date(at) } }),
      prisma.coethaChatMessage.create({ data: { clientId, chatId, role: "COETHA", text: res.text.slice(0, 20000), model: res.model, inputTokens: res.inputTokens, outputTokens: res.outputTokens, requestId: res.requestId, inputHash: built.inputHash, createdAt: new Date(at + 1) } }),
    ]);
    await audit(prisma, { actorId: actor.id, action: "coetha.chat", entityType: "CoethaChatMessage", entityId: answered.id, clientId, details: { questionId: asked.id, documentIds: attachments.map((a) => a.documentId), searches: res.searches, waitingRows: records.counts.waitingTotal, model: res.model, inputTokens: res.inputTokens, outputTokens: res.outputTokens, inputHash: built.inputHash } });
    return { questionId: asked.id, answerId: answered.id as string | null, text: answered.text as string | null, queued: false as const };
  } finally {
    await releaseLock(lock);
  }
}

/** The AI service's "slow down" answers: the question is kept and retried instead of failing. */
export const BUSY_CODES = new Set(["RATE_LIMIT", "PERMISSION", "NETWORK", "TIMEOUT"]);

/** Read-only searches and the monthly checklist for everyone; prepare_entries, memory and ask_client only when the person asking is Tabitha. */
async function chatTools(actor: Actor, clientId: string, records: unknown, currentQuestion?: string) {
  const owner = await isPrimaryOwner(actor.id);
  const { PREPARE_TOOL, runPrepareTool } = await import("./coetha-decisions");
  const { MEMORY_TOOLS, runMemoryTool } = await import("./coetha-memory");
  const memoryNames = new Set(MEMORY_TOOLS.map((t) => t.name));
  // Ask Client drafts (drafts only; never sent from chat). Like her other preparing tools: Tabitha only.
  const { ASK_CLIENT_TOOL, runAskClientTool } = await import("./ask-client");
  const asks = owner;
  // The Monthly Progress checklist: everyone may read it; clearing a paperwork line is checked
  // against the person asking (the same people who handle the business's document requests).
  const { CHECKLIST_TOOLS, CHECKLIST_TOOL_NAMES, runChecklistTool } = await import("./coetha-checklist");
  // Day-to-day bank activity read from what was sent (checked to the cent; nothing posted). The
  // person asking must be allowed to import bank transactions for this business.
  const { BANK_ACTIVITY_TOOL, addBankActivity } = await import("./coetha-bank-activity");
  const enterActivity = async (input: unknown) => {
    try {
      return await addBankActivity(actor, clientId, (input && typeof input === "object" ? input : {}) as Record<string, unknown>);
    } catch (err) {
      return { entered: false, problem: err instanceof ForbiddenError || err instanceof ValidationError ? err.message : "The transactions couldn't be entered." };
    }
  };
  return {
    defs: owner ? [...RECORDS_TOOLS, ...CHECKLIST_TOOLS, BANK_ACTIVITY_TOOL, PREPARE_TOOL, ...MEMORY_TOOLS, ASK_CLIENT_TOOL] : [...RECORDS_TOOLS, ...CHECKLIST_TOOLS, BANK_ACTIVITY_TOOL],
    run: (name: string, input: unknown) =>
      owner && name === PREPARE_TOOL.name ? runPrepareTool(actor, clientId, input, currentQuestion)
        : owner && memoryNames.has(name) ? runMemoryTool(actor, clientId, name, input)
          : asks && name === ASK_CLIENT_TOOL.name ? runAskClientTool(actor, clientId, input)
            : CHECKLIST_TOOL_NAMES.has(name) ? runChecklistTool(actor, clientId, name, input)
              : name === BANK_ACTIVITY_TOOL.name ? enterActivity(input)
              : runRecordsTool(clientId, name, input),
    records,
    asker: owner ? ("owner" as const) : ("staff" as const),
  };
}

/** The same switches as a question: Coetha on, the API key present, and the client hasn't opted out. */
export async function assertCanAsk(clientId: string) {
  await assertCoethaAllowed(clientId);
  if (!(await coethaOn())) throw new ValidationError(COETHA_OFF);
  if (!coethaKeyPresent()) throw new ValidationError(COETHA_NO_KEY);
}

/**
 * Answers a question that waited for its documents to be read in the background (coetha-reading):
 * the same books, records and read-only search as any question, plus what Coetha read from the
 * documents. The answer is placed right after the question in the thread. With quick: true (a
 * worker with little time left) Coetha gets one round of her tools, then answers.
 */
export async function answerQuestion(asker: Actor, clientId: string, questionId: string, documentsRead: string, opts: { quick?: boolean } = {}) {
  await assertLedger(asker, clientId);
  await assertCanAsk(clientId);
  const question = await prisma.coethaChatMessage.findFirstOrThrow({ where: { id: questionId, clientId, role: "USER" } });
  const earlier = (await prisma.coethaChatMessage.findMany({ where: { clientId, chatId: question.chatId, createdAt: { lt: question.createdAt } }, orderBy: { createdAt: "desc" }, take: HISTORY, select: { role: true, text: true, attachmentName: true, attachments: true } })).reverse();
  const built = await buildCoethaInput(asker, clientId);
  const { toCategorize: _batch, recentPosted: _recent, ...books } = built.input;
  void _batch; void _recent;
  const records = await recordsSnapshot(asker, clientId);
  const names = (m: { attachmentName: string | null; attachments: unknown }) => (Array.isArray(m.attachments) ? (m.attachments as { name: string }[]).map((a) => a.name) : m.attachmentName ? [m.attachmentName] : []);
  const turns: CoethaChatTurn[] = [
    ...earlier.map((m) => ({ role: m.role === "COETHA" ? ("assistant" as const) : ("user" as const), text: names(m).length ? `${m.text}\n[Attached earlier: ${names(m).join(", ")}]` : m.text })),
    { role: "user", text: documentsRead ? `${question.text}\n\nWhat you read from the attached documents (read page by page; each item is matched to the bank rows where possible):\n${documentsRead}` : question.text },
  ];
  // Quick (a worker with little time left): one round of tools, so Coetha can still prepare
  // entries, save what Tabitha decided and clear checklist lines, then she answers.
  const res = await callCoethaChat(books, turns, { ...(await chatTools(asker, clientId, records)), ...(opts.quick ? { maxRounds: 1 } : {}) });
  const answered = await prisma.coethaChatMessage.create({ data: { clientId, chatId: question.chatId, role: "COETHA", text: res.text.slice(0, 20000), model: res.model, inputTokens: res.inputTokens, outputTokens: res.outputTokens, requestId: res.requestId, inputHash: built.inputHash, createdAt: new Date(question.createdAt.getTime() + 1) } });
  await audit(prisma, { actorId: asker.id, action: "coetha.chat", entityType: "CoethaChatMessage", entityId: answered.id, clientId, details: { questionId, background: true, searches: res.searches, waitingRows: records.counts.waitingTotal, model: res.model, inputTokens: res.inputTokens, outputTokens: res.outputTokens, inputHash: built.inputHash } });
  return answered;
}

/**
 * The Ask Coetha page for one business, for staff who can open its books: the list of chats
 * (newest first, each titled by its first question) and one chat's messages, oldest first.
 * opts.chat picks the chat (default: the most recent one; a new chat's id shows an empty chat);
 * opts.limit keeps only that chat's newest messages (default SHOWN), with total for "See all".
 */
export async function coethaChatView(actor: Actor, clientId: string, opts: { chat?: string | null; limit?: number } = {}) {
  await assertLedger(actor, clientId);
  const [status, book, optOut, groups, firsts] = await Promise.all([
    coethaStatus(),
    prisma.ledgerBook.findUnique({ where: { clientId }, select: { clientId: true } }),
    coethaOptOutView(clientId),
    prisma.coethaChatMessage.groupBy({ by: ["chatId"], where: { clientId }, _count: { _all: true }, _min: { createdAt: true }, _max: { createdAt: true } }),
    prisma.coethaChatMessage.findMany({ where: { clientId, role: "USER" }, distinct: ["chatId"], orderBy: { createdAt: "asc" }, select: { chatId: true, text: true } }),
  ]);
  const titleOf = new Map(firsts.map((f) => [f.chatId ?? EARLIER_CHAT, f.text]));
  const chats = groups
    .map((g) => {
      const key = g.chatId ?? EARLIER_CHAT;
      const first = titleOf.get(key);
      return { key, title: g.chatId ? (first ? first.replace(/\s+/g, " ").slice(0, 70) : "Chat with Coetha") : "Earlier conversation", startedAt: g._min.createdAt!, lastAt: g._max.createdAt!, count: g._count._all };
    })
    .sort((a, b) => b.lastAt.getTime() - a.lastAt.getTime());
  const asked = chatKey(opts.chat);
  const current = asked ?? chats[0]?.key ?? newChatKey();
  const chat = chats.find((c) => c.key === current) ?? null;
  const rows = chat ? await prisma.coethaChatMessage.findMany({ where: { clientId, chatId: chatIdOf(current) }, orderBy: { createdAt: "desc" }, take: Math.max(1, opts.limit ?? SHOWN) }) : [];
  const people = await prisma.user.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.authorId).filter((x): x is string => !!x))] } }, select: { id: true, name: true } });
  const nameOf = new Map(people.map((u) => [u.id, u.name]));
  const messages = rows.reverse().map((m) => ({ id: m.id, role: m.role as "USER" | "COETHA", text: m.text, createdAt: m.createdAt, author: m.role === "USER" ? (m.authorId ? nameOf.get(m.authorId) ?? "Staff" : "Staff") : "Coetha", attachments: Array.isArray(m.attachments) ? (m.attachments as { documentId: string; name: string }[]) : m.attachmentName ? [{ documentId: m.documentId ?? "", name: m.attachmentName }] : [], status: m.status, jobIds: Array.isArray(m.jobIds) ? (m.jobIds as string[]) : [] }));
  return { status, hasBook: !!book, optedOut: !!optOut, chats, chat: { key: current, title: chat?.title ?? "New chat", total: chat?.count ?? 0, isNew: !chat }, messages, canAsk: status.ready && !!book && !optOut };
}
