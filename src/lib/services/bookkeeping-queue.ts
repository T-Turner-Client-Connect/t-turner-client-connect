import "server-only";
import { prisma } from "@/lib/prisma";
import { audit } from "@/lib/audit";
import { ForbiddenError, type Actor } from "@/lib/auth/actor";
import { isPrimaryOwner } from "@/lib/auth/permissions";
import { ValidationError } from "./clients";

/**
 * Coetha's bookkeeping work queue: Tabitha assigns a range of months for one client or every active
 * bookkeeping client, and Coetha works through them in the background (coetha-answer runs).
 *
 * - Each client has ONE bookkeeping chat, so its months are done in order and two assignments never
 *   change the same books at once; different clients are worked side by side (MAX_LIVE office-wide).
 * - Each month is one run that saves its place after every step, so a stopped background function
 *   resumes where it left off. Posting, duplicate removal and reconciliation are all idempotent:
 *   nothing is posted twice when a step is repeated.
 * - A client that can't be worked (books not set up, Coetha turned off for it) is reported as blocked
 *   and the others go on. Inside a month, a missing statement leaves that account pending and the
 *   rest of the month continues.
 */

export const bookkeepingChat = (clientId: string) => `c_bk-${clientId}`.slice(0, 42);

const MONTH = /^(\d{4})-(0[1-9]|1[0-2])$/;
const NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const monthName = (ym: string) => `${NAMES[Number(ym.slice(5)) - 1]} ${ym.slice(0, 4)}`;

export function monthsFrom(from: string, to: string) {
  if (!MONTH.test(from) || !MONTH.test(to)) throw new ValidationError("Choose the months as YYYY-MM.");
  if (from > to) throw new ValidationError("The first month must come before the last.");
  const out: string[] = [];
  let [y, m] = from.split("-").map(Number);
  while (`${y}-${String(m).padStart(2, "0")}` <= to && out.length < 24) {
    out.push(`${y}-${String(m).padStart(2, "0")}`);
    m++; if (m > 12) { m = 1; y++; }
  }
  return out;
}

/** The assignment Coetha works from, one per month. */
export const assignmentText = (ym: string) =>
  `Complete the bookkeeping for ${monthName(ym)} (${ym}) for this client, under my standing authorization: remove verified duplicate imports, post every supported transaction, reverse entries you verify are wrong and re-post them correctly, post the supported items already on my Apply These Decisions card, reconcile every account from the statements on file, prepare the Profit & Loss and Balance Sheet, then give me a short exception report (only what you couldn't support, each with what would settle it).`;

export async function assignBookkeeping(actor: Actor, input: { from: string; to: string; clientIds?: string[] }) {
  if (!(await isPrimaryOwner(actor.id))) throw new ForbiddenError("Only Tabitha assigns bookkeeping to Coetha.");
  const months = monthsFrom(input.from, input.to);
  const profiles = await prisma.bookkeepingProfile.findMany({ where: { active: true, ...(input.clientIds?.length ? { clientId: { in: input.clientIds } } : {}) }, select: { clientId: true, client: { select: { displayName: true } } } });
  const { askCoetha } = await import("./coetha-chat");
  const queued: { client: string; months: string[] }[] = [];
  const blocked: { client: string; why: string }[] = [];
  for (const p of profiles) {
    const chat = bookkeepingChat(p.clientId);
    const done: string[] = [];
    for (const ym of months) {
      // Already assigned and not failed: not queued twice.
      const existing = await prisma.coethaChatMessage.findFirst({ where: { clientId: p.clientId, chatId: chat, role: "USER", text: { startsWith: `Complete the bookkeeping for ${monthName(ym)}` }, OR: [{ status: "WAITING" }, { status: "ANSWERED" }] }, select: { id: true } });
      if (existing) continue;
      try {
        await askCoetha(actor, p.clientId, assignmentText(ym), { chat, inline: false });
        done.push(ym);
      } catch (err) {
        blocked.push({ client: p.client.displayName, why: err instanceof Error ? err.message : "Couldn't be queued." });
        break;
      }
    }
    if (done.length) queued.push({ client: p.client.displayName, months: done });
  }
  await audit(prisma, { actorId: actor.id, action: "coetha.bookkeeping_assigned", entityType: "User", entityId: actor.id, details: { from: input.from, to: input.to, clients: queued.length, blocked: blocked.length } });
  return { queued, blocked };
}

/** Coetha's queue state per client, read from her runs (not from what she wrote). */
export async function bookkeepingQueueStatus(clientIds: string[]) {
  const runs = await prisma.coethaAnswerRun.findMany({ where: { clientId: { in: clientIds }, chatId: { in: clientIds.map(bookkeepingChat) } }, orderBy: { queuedAt: "asc" }, select: { clientId: true, questionId: true, status: true, phase: true, error: true, finishedAt: true, answerId: true } });
  const questions = await prisma.coethaChatMessage.findMany({ where: { id: { in: runs.map((r) => r.questionId) } }, select: { id: true, text: true } });
  const monthOf = new Map(questions.map((q) => [q.id, /\((\d{4}-\d{2})\)/.exec(q.text)?.[1] ?? null]));
  const out = new Map<string, { waiting: string[]; working: string | null; done: string[]; failed: { month: string | null; why: string | null }[]; lastAnswerId: string | null }>();
  for (const id of clientIds) out.set(id, { waiting: [], working: null, done: [], failed: [], lastAnswerId: null });
  for (const r of runs) {
    const s = out.get(r.clientId)!;
    const m = monthOf.get(r.questionId) ?? null;
    if (r.status === "DONE") { if (m) s.done.push(m); s.lastAnswerId = r.answerId; }
    else if (r.status === "FAILED") s.failed.push({ month: m, why: r.error });
    else if (r.status === "RUNNING" || (r.status === "QUEUED" && r.phase !== "WAITING")) s.working = m;
    else if (m) s.waiting.push(m);
  }
  return out;
}
