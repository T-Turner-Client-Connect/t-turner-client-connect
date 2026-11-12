import "server-only";
import { randomUUID } from "node:crypto";
import type Anthropic from "@anthropic-ai/sdk";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { audit } from "@/lib/audit";
import type { Actor } from "@/lib/auth/actor";
import { isPrimaryOwner } from "@/lib/auth/permissions";
import { CHAT_MAX_SEARCH_ROUNDS, chatMessages, chatRequest, chatSystem, chatText, sendChatRequest, type ChatCallOutcome, type ChatRequest, type CoethaChatFile, type CoethaChatTurn } from "@/lib/coetha-model";
import { assertLedger } from "./ledger";
import { buildCoethaInput } from "./coetha";
import { recordsSnapshot } from "./coetha-records-view";

/**
 * How Coetha answers: every question becomes a saved, resumable run.
 *
 * - Client Connect does everything that touches the books: it gathers the business's records (with
 *   the asker's permissions, checked again when the run starts), builds each AI request, runs her
 *   tools (searches, reading stored documents, prepare_entries under Tabitha's standing
 *   authorization, statements) and saves the answer.
 * - The AI call itself is the only slow part, so it is made by the background function
 *   (coetha-answer-background, up to 15 minutes), never inside a page request (cut off at ~30 s).
 *   Locally and in tests, runAnswerNow makes the calls in-process.
 * - Several staff can be answered at once (up to MAX_LIVE AI calls office-wide); questions in the
 *   same chat are answered in order. A busy or overloaded AI service delays only that run, which is
 *   retried with backoff; nothing is lost and nothing is answered twice (each call has an id, and
 *   a late or duplicate result is ignored).
 */

/** AI calls in flight at once, office-wide. */
export const MAX_LIVE = 3;
/** Longer than one AI call may take (the background function's own timeout is 10 minutes). */
const LEASE_MS = 11 * 60_000;
const MAX_ATTEMPTS = 5;
const BACKOFF_S = [20, 60, 120, 240];
const HISTORY = 16;
const RETRYABLE = new Set(["RATE_LIMIT", "OVERLOADED", "TIMEOUT", "NETWORK", "API", "PERMISSION"]);

type Asker = "owner" | "staff";
type Pending = { files?: CoethaChatFile[]; documentsRead?: string };
type RunState = {
  pending?: Pending;
  books?: unknown;
  records?: unknown;
  asker?: Asker;
  messages?: Anthropic.Beta.BetaMessageParam[];
  maxRounds?: number;
  searches?: number;
  emptyRetried?: boolean;
  forceText?: boolean;
  question?: string;
  reading?: { chat?: string | null; alreadyRead?: string[] };
  inputHash?: string;
  waitingRows?: number;
};
type Timing = { step: string; ms: number; round?: number; in?: number; out?: number; cacheRead?: number; code?: string; tools?: string[] };

const asJson = (v: unknown) => JSON.parse(JSON.stringify(v)) as Prisma.InputJsonValue;

/** Saves a question's run (the question itself is already saved, status WAITING). */
export async function queueAnswer(question: { id: string; clientId: string; chatId: string | null; authorId: string | null }, pending: Pending = {}) {
  if (!question.authorId) throw new Error("A question needs the person who asked it.");
  return prisma.coethaAnswerRun.upsert({
    where: { questionId: question.id },
    create: { questionId: question.id, clientId: question.clientId, chatId: question.chatId, askerId: question.authorId, state: asJson({ pending }) },
    update: {},
  });
}

async function askerOf(id: string): Promise<Actor | null> {
  const u = await prisma.user.findUnique({ where: { id }, select: { id: true, role: true, name: true, email: true, active: true } }).catch(() => null);
  return u && (u as { active?: boolean }).active !== false ? { id: u.id, role: u.role, name: u.name, email: u.email } as Actor : null;
}

/** Gathers what the answer needs, once per run: the books, the records and the conversation. */
async function prepare(runId: string): Promise<RunState> {
  const started = Date.now();
  const run = await prisma.coethaAnswerRun.findUniqueOrThrow({ where: { id: runId } });
  const asker = await askerOf(run.askerId);
  if (!asker) throw new Fail("The person who asked no longer has an account.");
  // The asker's access is checked again now (it may have changed since the question was asked).
  await assertLedger(asker, run.clientId);
  const { assertCanAsk } = await import("./coetha-chat");
  await assertCanAsk(run.clientId);
  const question = await prisma.coethaChatMessage.findFirstOrThrow({ where: { id: run.questionId, clientId: run.clientId, role: "USER" } });
  const earlier = (await prisma.coethaChatMessage.findMany({ where: { clientId: run.clientId, chatId: question.chatId, createdAt: { lt: question.createdAt }, OR: [{ status: null }, { status: { not: "FAILED" } }] }, orderBy: { createdAt: "desc" }, take: HISTORY, select: { role: true, text: true, attachmentName: true, attachments: true } })).reverse();
  const built = await buildCoethaInput(asker, run.clientId);
  const { toCategorize: _batch, recentPosted: _recent, ...books } = built.input;
  void _batch; void _recent;
  const records = await recordsSnapshot(asker, run.clientId);
  const names = (m: { attachmentName: string | null; attachments: unknown }) => (Array.isArray(m.attachments) ? (m.attachments as { name: string }[]).map((a) => a.name) : m.attachmentName ? [m.attachmentName] : []);
  const pending = ((run.state as RunState | null)?.pending ?? {}) as Pending;
  const turns: CoethaChatTurn[] = [
    ...earlier.map((m) => ({ role: m.role === "COETHA" ? ("assistant" as const) : ("user" as const), text: names(m).length ? `${m.text}\n[Attached earlier: ${names(m).join(", ")}]` : m.text })),
    { role: "user", text: pending.documentsRead ? `${question.text}\n\nWhat you read from the attached documents (read page by page; each item is matched to the bank rows where possible):\n${pending.documentsRead}` : question.text },
  ];
  const attached = Array.isArray(question.attachments) ? (question.attachments as { documentId?: string }[]).map((a) => a.documentId).filter((x): x is string => !!x) : [];
  const state: RunState = {
    books, records,
    asker: (await isPrimaryOwner(asker.id)) ? "owner" : "staff",
    messages: chatMessages(turns, pending.files ?? []),
    maxRounds: CHAT_MAX_SEARCH_ROUNDS,
    searches: 0,
    question: question.text,
    reading: { chat: question.chatId, alreadyRead: attached },
    inputHash: built.inputHash,
    waitingRows: (records as { counts?: { waitingTotal?: number } }).counts?.waitingTotal ?? 0,
  };
  await prisma.coethaAnswerRun.update({ where: { id: runId }, data: { state: asJson(state), timings: asJson([...((run.timings as Timing[]) ?? []), { step: "gather", ms: Date.now() - started }]) } });
  return state;
}

class Fail extends Error {}

async function toolsFor(run: { askerId: string; clientId: string }, state: RunState) {
  const asker = await askerOf(run.askerId);
  if (!asker) throw new Fail("The person who asked no longer has an account.");
  const { chatTools } = await import("./coetha-chat");
  return chatTools(asker, run.clientId, state.records, state.question, state.reading ?? {});
}

/**
 * Hands out the next AI call: of one run (runId) or of the oldest run that may go now. Returns null
 * when nothing may go (all waiting on a retry, MAX_LIVE calls already out, or nothing queued).
 */
export async function nextCall(opts: { runId?: string; now?: Date } = {}): Promise<{ runId: string; callId: string; request: ChatRequest } | null> {
  const now = opts.now ?? new Date();
  if (!opts.runId) {
    const live = await prisma.coethaAnswerRun.count({ where: { status: "RUNNING", callId: { not: null }, leaseUntil: { gt: now } } });
    if (live >= MAX_LIVE) return null;
  }
  const candidates = await prisma.coethaAnswerRun.findMany({
    where: {
      ...(opts.runId ? { id: opts.runId } : {}),
      status: { in: ["QUEUED", "RUNNING"] },
      OR: [{ callId: null }, { leaseUntil: { lt: now } }],
      AND: [{ OR: [{ notBefore: null }, { notBefore: { lte: now } }] }],
    },
    orderBy: { queuedAt: "asc" },
    take: 20,
  });
  for (const c of candidates) {
    // Questions in the same chat are answered in order.
    const ahead = await prisma.coethaAnswerRun.count({ where: { clientId: c.clientId, chatId: c.chatId, status: { in: ["QUEUED", "RUNNING"] }, queuedAt: { lt: c.queuedAt } } });
    if (ahead) continue;
    const callId = randomUUID();
    const got = await prisma.coethaAnswerRun.updateMany({ where: { id: c.id, OR: [{ callId: null }, { leaseUntil: { lt: now } }] }, data: { callId, leaseUntil: new Date(now.getTime() + LEASE_MS), status: "RUNNING", startedAt: c.startedAt ?? now, phase: c.state && (c.state as RunState).messages ? "THINKING" : "GATHERING" } });
    if (!got.count) continue;
    try {
      let state = (c.state ?? {}) as RunState;
      if (!state.messages) state = await prepare(c.id);
      const tools = await toolsFor(c, state);
      const mayUseTools = !state.forceText && c.round < (state.maxRounds ?? CHAT_MAX_SEARCH_ROUNDS);
      const request = chatRequest(chatSystem(state.books, state.records, state.asker), state.messages!, tools.defs, { mayUseTools, owner: state.asker === "owner" });
      await prisma.coethaAnswerRun.update({ where: { id: c.id }, data: { phase: c.round === 0 ? "THINKING" : mayUseTools ? "WORKING" : "WRITING", calls: { increment: 1 } } });
      return { runId: c.id, callId, request };
    } catch (err) {
      await fail(c.id, err instanceof Error ? err.message : "Coetha couldn't start this answer.");
    }
  }
  return null;
}

async function fail(runId: string, reason: string) {
  const run = await prisma.coethaAnswerRun.update({ where: { id: runId }, data: { status: "FAILED", phase: "FAILED", error: reason.slice(0, 500), callId: null, leaseUntil: null, finishedAt: new Date() } });
  await prisma.coethaChatMessage.update({ where: { id: run.questionId }, data: { status: "FAILED" } }).catch(() => {});
  await audit(prisma, { actorId: run.askerId, action: "coetha.chat_failed", entityType: "CoethaChatMessage", entityId: run.questionId, clientId: run.clientId, details: { reason: reason.slice(0, 300), calls: run.calls, attempts: run.attempts } });
  logTiming(run, "failed");
}

/** Takes one AI call's outcome: runs the tools it asked for, or saves the answer. Late and duplicate results are ignored. */
export async function applyResult(runId: string, callId: string, outcome: ChatCallOutcome): Promise<{ done: boolean; ignored?: boolean }> {
  const run = await prisma.coethaAnswerRun.findUnique({ where: { id: runId } });
  if (!run || run.callId !== callId || (run.status !== "RUNNING" && run.status !== "QUEUED")) return { done: true, ignored: true };
  const state = (run.state ?? {}) as RunState;
  const timings = [...((run.timings as Timing[]) ?? [])];
  if (!outcome.ok) {
    timings.push({ step: "ai", ms: outcome.ms, round: run.round, code: outcome.code });
    const attempts = run.attempts + 1;
    if (RETRYABLE.has(outcome.code) && attempts < MAX_ATTEMPTS) {
      const waitMs = Math.max(outcome.retryAfterMs ?? 0, BACKOFF_S[Math.min(attempts - 1, BACKOFF_S.length - 1)] * 1000);
      await prisma.coethaAnswerRun.update({ where: { id: runId }, data: { attempts, timings: asJson(timings), status: "QUEUED", phase: "RETRYING", callId: null, leaseUntil: null, notBefore: new Date(Date.now() + waitMs), error: outcome.message.slice(0, 300) } });
      console.log(`coetha-answer: run ${runId} AI ${outcome.code}, retry ${attempts} in ${Math.round(waitMs / 1000)} s`);
      return { done: false };
    }
    await prisma.coethaAnswerRun.update({ where: { id: runId }, data: { attempts, timings: asJson(timings) } });
    await fail(runId, outcome.message);
    return { done: true };
  }
  const msg = outcome.message;
  const usage = msg.usage as { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number | null };
  timings.push({ step: "ai", ms: outcome.ms, round: run.round, in: usage.input_tokens ?? 0, out: usage.output_tokens ?? 0, cacheRead: usage.cache_read_input_tokens ?? 0 });
  const tokens = { inputTokens: { increment: usage.input_tokens ?? 0 }, outputTokens: { increment: usage.output_tokens ?? 0 }, cacheReadTokens: { increment: usage.cache_read_input_tokens ?? 0 } };
  const calls = msg.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use");
  const messages = [...(state.messages ?? [])];
  try {
    if (msg.stop_reason === "tool_use" && calls.length) {
      const tools = await toolsFor(run, state);
      const started = Date.now();
      messages.push({ role: "assistant", content: msg.content as Anthropic.Beta.BetaContentBlockParam[] });
      const results: Anthropic.Beta.BetaToolResultBlockParam[] = [];
      for (const c of calls) {
        let out: unknown;
        try { out = await tools.run(c.name, c.input); } catch { out = { error: "That tool couldn't be completed." }; }
        results.push({ type: "tool_result", tool_use_id: c.id, content: JSON.stringify(out) });
      }
      messages.push({ role: "user", content: results });
      timings.push({ step: "tools", ms: Date.now() - started, round: run.round, tools: calls.map((c) => c.name) });
      const next: RunState = { ...state, messages, searches: (state.searches ?? 0) + calls.length };
      await prisma.coethaAnswerRun.update({ where: { id: runId }, data: { ...tokens, state: asJson(next), timings: asJson(timings), round: run.round + 1, attempts: 0, error: null, callId: null, leaseUntil: null, phase: "WORKING" } });
      return { done: false };
    }
    let text = chatText(msg);
    if (msg.stop_reason === "refusal") throw new Fail("Claude declined to answer this question.");
    if (!text && !state.emptyRetried) {
      // No written answer (it can happen right after her tools): ask once, plainly, for the answer.
      const said = msg.content.filter((b) => b.type !== "tool_use") as Anthropic.Beta.BetaContentBlockParam[];
      if (said.length) messages.push({ role: "assistant", content: said });
      messages.push({ role: "user", content: "Please write your answer now, in plain text, from what you already have. Don't use tools again." });
      await prisma.coethaAnswerRun.update({ where: { id: runId }, data: { ...tokens, state: asJson({ ...state, messages, emptyRetried: true, forceText: true }), timings: asJson(timings), callId: null, leaseUntil: null, phase: "WRITING" } });
      return { done: false };
    }
    if (!text) throw new Fail("Coetha didn't return an answer. Try asking again.");
    if (msg.stop_reason === "max_tokens") text += "\n\n(Coetha's answer was cut off because it was long. Ask a narrower follow-up question for the rest.)";
    const question = await prisma.coethaChatMessage.findUniqueOrThrow({ where: { id: run.questionId } });
    const requestId: string | null = (msg as { _request_id?: string | null })._request_id ?? msg.id ?? null;
    const done = await prisma.$transaction(async (tx) => {
      const answered = await tx.coethaChatMessage.create({ data: { clientId: run.clientId, chatId: question.chatId, role: "COETHA", text: text.slice(0, 20000), model: msg.model, inputTokens: run.inputTokens + (usage.input_tokens ?? 0), outputTokens: run.outputTokens + (usage.output_tokens ?? 0), requestId, inputHash: state.inputHash ?? null, createdAt: new Date(question.createdAt.getTime() + 1) } });
      await tx.coethaChatMessage.update({ where: { id: question.id }, data: { status: "ANSWERED" } });
      return tx.coethaAnswerRun.update({ where: { id: runId }, data: { ...tokens, timings: asJson(timings), status: "DONE", phase: "DONE", answerId: answered.id, callId: null, leaseUntil: null, finishedAt: new Date(), error: null, state: asJson({ ...state, books: null, records: null, messages: [] }) } });
    });
    await audit(prisma, { actorId: run.askerId, action: "coetha.chat", entityType: "CoethaChatMessage", entityId: done.answerId!, clientId: run.clientId, details: { questionId: run.questionId, background: true, searches: state.searches ?? 0, waitingRows: state.waitingRows ?? 0, model: msg.model, inputTokens: done.inputTokens, outputTokens: done.outputTokens, cacheReadTokens: done.cacheReadTokens, calls: done.calls, inputHash: state.inputHash ?? null } });
    logTiming(done, "answered");
    return { done: true };
  } catch (err) {
    await prisma.coethaAnswerRun.update({ where: { id: runId }, data: { ...tokens, timings: asJson(timings) } }).catch(() => {});
    await fail(runId, err instanceof Error ? err.message : "Coetha couldn't finish this answer.");
    return { done: true };
  }
}

/** One log line per answer: where the time went (no client data), for the office's performance check. */
function logTiming(run: { id: string; queuedAt: Date; startedAt: Date | null; finishedAt: Date | null; calls: number; round: number; attempts: number; inputTokens: number; outputTokens: number; cacheReadTokens: number; timings: unknown }, outcome: string) {
  const t = (run.timings as Timing[]) ?? [];
  const sum = (step: string) => t.filter((x) => x.step === step).reduce((n, x) => n + x.ms, 0);
  const end = run.finishedAt ?? new Date();
  console.log(`coetha-timing ${JSON.stringify({ run: run.id, outcome, waitMs: run.startedAt ? run.startedAt.getTime() - run.queuedAt.getTime() : null, totalMs: end.getTime() - run.queuedAt.getTime(), gatherMs: sum("gather"), aiMs: sum("ai"), toolsMs: sum("tools"), aiCalls: t.filter((x) => x.step === "ai").length, rounds: run.round, retries: t.filter((x) => x.step === "ai" && x.code).length, inputTokens: run.inputTokens, outputTokens: run.outputTokens, cacheReadTokens: run.cacheReadTokens })}`);
}

/** Works one run to the end in this process (tests, local runs). Stops when the run must wait (a retry delay). */
export async function runAnswerNow(runId: string, send: (r: ChatRequest) => Promise<ChatCallOutcome> = (r) => sendChatRequest(r)) {
  for (let i = 0; i < 40; i++) {
    const call = await nextCall({ runId });
    if (!call) break;
    const r = await applyResult(call.runId, call.callId, await send(call.request));
    if (r.done) break;
  }
  return prisma.coethaAnswerRun.findUniqueOrThrow({ where: { id: runId } });
}

/** Starts the background function that makes Coetha's AI calls (it exits when nothing is waiting). */
export async function kickAnswers() {
  const url = process.env.DEPLOY_URL || process.env.URL, secret = process.env.CRON_SECRET;
  if (!url || !secret || process.env.VITEST) return false;
  try {
    await fetch(`${url}/.netlify/functions/coetha-answer-background`, { method: "POST", headers: { Authorization: `Bearer ${secret}` }, signal: AbortSignal.timeout(5000) });
    return true;
  } catch {
    return false;
  }
}

/** Is anything waiting that no AI call is working on (so the background function should be started)? */
export async function answersWaitingWithoutWorker(now = new Date()) {
  return prisma.coethaAnswerRun.count({ where: { status: { in: ["QUEUED", "RUNNING"] }, OR: [{ callId: null }, { leaseUntil: { lt: now } }], AND: [{ OR: [{ notBefore: null }, { notBefore: { lte: now } }] }], queuedAt: { lt: new Date(now.getTime() - 10_000) } } });
}

export const PHASE_LABEL: Record<string, string> = {
  WAITING: "Waiting for Coetha",
  GATHERING: "Gathering this business's records",
  THINKING: "Reading the records and your question",
  WORKING: "Working: searching, reading documents and posting",
  WRITING: "Writing her answer",
  RETRYING: "The AI service was busy; trying again shortly",
  FAILED: "Couldn't finish",
  DONE: "Answered",
};

/** What the page shows for each question still being worked on (and why one failed). */
export async function answerStatus(clientId: string) {
  const runs = await prisma.coethaAnswerRun.findMany({ where: { clientId, OR: [{ status: { in: ["QUEUED", "RUNNING"] } }, { status: "FAILED", finishedAt: { gt: new Date(Date.now() - 7 * 86_400_000) } }] }, select: { questionId: true, status: true, phase: true, round: true, error: true, notBefore: true, queuedAt: true, startedAt: true } });
  const ahead = async (q: Date) => prisma.coethaAnswerRun.count({ where: { status: { in: ["QUEUED", "RUNNING"] }, startedAt: null, queuedAt: { lt: q } } });
  return Promise.all(runs.map(async (r) => ({ ...r, label: PHASE_LABEL[r.phase] ?? r.phase, waitingAhead: r.status === "QUEUED" && !r.startedAt ? await ahead(r.queuedAt) : 0 })));
}
