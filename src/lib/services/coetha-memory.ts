import "server-only";
import { prisma } from "@/lib/prisma";
import { audit } from "@/lib/audit";
import type { Actor } from "@/lib/auth/actor";
import { assertCanApproveCoethaWork } from "@/lib/auth/permissions";
import { ValidationError } from "./clients";
import { assertLedger } from "./ledger";
import { scrub } from "./coetha";

/**
 * What Coetha remembers for one business, so Tabitha never has to say the same thing twice:
 * her decisions ("#184 is a business license"), standing instructions ("use 6195 for licenses")
 * and holds ("hold W26 until I confirm the Alfa tickets").
 *
 * - Only Tabitha adds (through Coetha's remember tool when she's the one asking) or removes.
 * - Every note is sent with every question for that business, and never to another business.
 * - Removed notes are kept (removedAt) and every change is audited.
 */

export const MEMORY_KINDS = { DECISION: "Decision", INSTRUCTION: "Standing instruction", HOLD: "On hold" } as const;
export type MemoryKind = keyof typeof MEMORY_KINDS;
const MAX_ACTIVE = 200;
const MAX_TEXT = 400;

/** The notes Coetha applies for this business (oldest first). */
export async function activeMemory(clientId: string) {
  return prisma.coethaMemory.findMany({ where: { clientId, removedAt: null }, orderBy: { createdAt: "asc" }, take: MAX_ACTIVE });
}

/** Saves notes Tabitha stated (Tabitha only). Exact repeats aren't saved twice. */
export async function rememberNotes(actor: Actor, clientId: string, notes: { kind: string; text: string }[]) {
  await assertCanApproveCoethaWork(actor);
  await assertLedger(actor, clientId);
  const clean = notes
    .map((n) => ({ kind: (n.kind in MEMORY_KINDS ? n.kind : "INSTRUCTION") as MemoryKind, text: scrub(String(n.text ?? ""), MAX_TEXT).trim() }))
    .filter((n) => n.text.length >= 3)
    .slice(0, 20);
  if (!clean.length) throw new ValidationError("There's nothing to remember.");
  const existing = await activeMemory(clientId);
  const have = new Set(existing.map((m) => m.text.toLowerCase()));
  const fresh = clean.filter((n) => !have.has(n.text.toLowerCase()));
  if (existing.length + fresh.length > MAX_ACTIVE) throw new ValidationError(`Coetha remembers at most ${MAX_ACTIVE} notes per business; remove some first.`);
  const saved = [];
  for (const n of fresh) saved.push(await prisma.coethaMemory.create({ data: { clientId, kind: n.kind, text: n.text, createdById: actor.id } }));
  if (saved.length) await audit(prisma, { actorId: actor.id, action: "coetha.memory_added", entityType: "LedgerBook", entityId: clientId, clientId, details: { ids: saved.map((m) => m.id), count: saved.length } });
  return { saved, skipped: clean.length - fresh.length };
}

/** Removes notes (Tabitha only); they're kept in history. */
export async function forgetNotes(actor: Actor, clientId: string, ids: string[]) {
  await assertCanApproveCoethaWork(actor);
  await assertLedger(actor, clientId);
  const r = await prisma.coethaMemory.updateMany({ where: { id: { in: ids }, clientId, removedAt: null }, data: { removedAt: new Date(), removedById: actor.id } });
  if (r.count) await audit(prisma, { actorId: actor.id, action: "coetha.memory_removed", entityType: "LedgerBook", entityId: clientId, clientId, details: { ids, count: r.count } });
  return r.count;
}

/** For the page: the notes, newest first (anyone who can open the books can read them). */
export async function memoryView(actor: Actor, clientId: string) {
  await assertLedger(actor, clientId);
  const notes = await prisma.coethaMemory.findMany({ where: { clientId, removedAt: null }, orderBy: { createdAt: "desc" }, take: MAX_ACTIVE });
  return notes.map((n) => ({ id: n.id, kind: n.kind as MemoryKind, label: MEMORY_KINDS[n.kind as MemoryKind] ?? n.kind, text: n.text, createdAt: n.createdAt }));
}

// --- Coetha's tools (offered only when Tabitha is asking) -------------------------------------------

export const MEMORY_TOOLS = [
  {
    name: "remember",
    description:
      "Save something Tabitha told you to remember for THIS business, so she never has to repeat it: an accounting decision (DECISION), a standing instruction for how to handle something (INSTRUCTION), or an item to keep on hold until something happens (HOLD). One short, self-contained sentence each, with check numbers, amounts, accounts and W-references where they apply. Only what she stated; never your own guesses.",
    input_schema: {
      type: "object" as const,
      properties: {
        notes: { type: "array", items: { type: "object", properties: { kind: { type: "string", enum: ["DECISION", "INSTRUCTION", "HOLD"] }, text: { type: "string" } }, required: ["kind", "text"] } },
      },
      required: ["notes"],
    },
  },
  {
    name: "forget",
    description: "Remove remembered notes (by their id from the memory list) that Tabitha changed or that no longer apply, for example a hold she released. Save the new version with remember.",
    input_schema: { type: "object" as const, properties: { ids: { type: "array", items: { type: "string" } } }, required: ["ids"] },
  },
];

export async function runMemoryTool(actor: Actor, clientId: string, name: string, input: unknown) {
  const q = (input && typeof input === "object" ? input : {}) as { notes?: { kind: string; text: string }[]; ids?: string[] };
  try {
    if (name === "remember") {
      const r = await rememberNotes(actor, clientId, Array.isArray(q.notes) ? q.notes : []);
      return { remembered: r.saved.map((m) => ({ id: m.id, kind: m.kind, text: m.text })), alreadyRemembered: r.skipped };
    }
    if (name === "forget") return { removed: await forgetNotes(actor, clientId, Array.isArray(q.ids) ? q.ids.map(String) : []) };
  } catch (err) {
    return { error: err instanceof ValidationError ? err.message : "That couldn't be saved." };
  }
  return { error: `Unknown tool ${name}.` };
}
