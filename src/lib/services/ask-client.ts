import "server-only";
import { createHash } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { audit } from "@/lib/audit";
import type { Actor } from "@/lib/auth/actor";
import type { PortalActor } from "@/lib/portal/session";
import { requireClientAccess } from "@/lib/portal/access";
import { BK_PORTAL_COETHA_V1, type LetterBlock, type LetterTemplate } from "@/lib/client-letters/templates";
import { ValidationError } from "./clients";
import { assertCanSendClientRequests } from "./bk-permissions";
import { createClientRequest, discardDraftRequest, rangeText, sendClientRequest } from "./client-requests";
import { clientRolloutAuthorized } from "./owner-switches";
import { isYmd, toDate } from "./ledger";
import { registryLabel } from "./bank-accounts";

/**
 * Ask Client: the supporting documents and explanations only the client can give.
 *
 * - Coetha (or staff) prepares each item as a DRAFT supporting request (kind SUPPORTING). Tabitha
 *   and staff review, edit, add or remove items before anything is sent.
 * - The request letter is printed on the firm's letterhead (the same letterhead as the approved
 *   client letters).
 * - Nothing reaches the client (no email, no reminder, no portal notice, and the request isn't
 *   shown in the portal) until Tabitha has authorized client communications and rollout
 *   (the owner's "Client rollout authorized" switch). Until then items stay drafts.
 * - The client answers each item in the portal by uploading the document or writing an
 *   explanation. Uploads are filed against the request (no re-uploading by staff) and queued for
 *   Coetha to read. An explanation is evidence for the office, never authorization to post.
 */

export const ASK_CLIENT_ON_HOLD =
  "Client communications are on hold. Nothing goes to the client until Tabitha authorizes client communications and rollout in the Owner's Office.";
const MAX_EXPLANATION = 4000;

export type AskItemInput = {
  title: string;
  reason?: string | null;
  instructions?: string | null;
  dueAt?: string | null;
  bookkeepingAccountId?: string | null;
  start?: string | null;
  end?: string | null;
};

const clean = (v: string | null | undefined, max: number) => (v ?? "").trim().slice(0, max) || null;
const dueDate = (v: string | null | undefined) => {
  if (!v) return null;
  if (!isYmd(v)) throw new ValidationError("Enter a valid due date.");
  return toDate(v);
};

async function itemOf(clientId: string, requestId: string) {
  const r = await prisma.documentRequest.findFirst({ where: { id: requestId, clientId, kind: "SUPPORTING", askClient: true } });
  if (!r) throw new ValidationError("That request isn't on this business's Ask Client list.");
  return r;
}

/** Adds an item as a draft (never sent from here). Coetha's items carry a stable draft key so she never asks twice. */
export async function addAskItem(actor: Actor, clientId: string, input: AskItemInput, opts: { source?: "STAFF" | "COETHA" } = {}) {
  await assertCanSendClientRequests(actor, clientId);
  const title = clean(input.title, 200);
  if (!title) throw new ValidationError("Say what you need from the client.");
  const source = opts.source ?? "STAFF";
  const draftKey = source === "COETHA" ? `ask:${createHash("sha256").update(title.toLowerCase().replace(/\s+/g, " ")).digest("hex").slice(0, 24)}` : null;
  return createClientRequest(
    actor,
    clientId,
    {
      kind: "SUPPORTING", title, reason: clean(input.reason, 500), instructions: clean(input.instructions, 1000),
      dueAt: dueDate(input.dueAt), bookkeepingAccountId: input.bookkeepingAccountId || null,
      start: input.start || null, end: input.end || null, draftKey, askClient: true,
    },
    { send: false, source },
  );
}

/** Edits an item that hasn't been answered yet. */
export async function editAskItem(actor: Actor, clientId: string, requestId: string, input: AskItemInput) {
  await assertCanSendClientRequests(actor, clientId);
  const r = await itemOf(clientId, requestId);
  if (r.status !== "DRAFT" && r.status !== "OPEN") throw new ValidationError("Only an unanswered request can be edited.");
  const title = clean(input.title, 200);
  if (!title) throw new ValidationError("Say what you need from the client.");
  const data = { title, reason: clean(input.reason, 500), instructions: clean(input.instructions, 1000), dueAt: dueDate(input.dueAt) };
  await prisma.documentRequest.update({ where: { id: r.id }, data });
  await audit(prisma, { actorId: actor.id, action: "ask_client.edited", entityType: "DocumentRequest", entityId: r.id, clientId, details: { before: { title: r.title, reason: r.reason, instructions: r.instructions, dueAt: r.dueAt }, after: data } });
}

/** Removes an item: a draft is discarded; a sent, unanswered request is withdrawn (kept as history). */
export async function removeAskItem(actor: Actor, clientId: string, requestId: string) {
  await assertCanSendClientRequests(actor, clientId);
  const r = await itemOf(clientId, requestId);
  if (r.status === "DRAFT") return discardDraftRequest(actor, clientId, r.id);
  if (r.status !== "OPEN") throw new ValidationError("An answered request stays on file for the audit trail.");
  await prisma.documentRequest.updateMany({ where: { id: r.id, status: "OPEN" }, data: { status: "CANCELLED" } });
  await audit(prisma, { actorId: actor.id, action: "ask_client.withdrawn", entityType: "DocumentRequest", entityId: r.id, clientId });
}

/**
 * Sends the chosen drafts to the client (portal request + the client's usual notice). Refused
 * until Tabitha authorized client communications and rollout.
 */
export async function sendAskItems(actor: Actor, clientId: string, requestIds: string[]) {
  await assertCanSendClientRequests(actor, clientId);
  if (!(await clientRolloutAuthorized())) throw new ValidationError(ASK_CLIENT_ON_HOLD);
  const drafts = await prisma.documentRequest.findMany({ where: { id: { in: requestIds }, clientId, kind: "SUPPORTING", askClient: true, status: "DRAFT" }, select: { id: true } });
  if (!drafts.length) throw new ValidationError("Choose at least one draft to send.");
  for (const d of drafts) await sendClientRequest(actor, clientId, d.id);
  return drafts.length;
}

/** The page: drafts, sent and answered items, and whether client communications are authorized. */
export async function askClientView(actor: Actor, clientId: string) {
  await assertCanSendClientRequests(actor, clientId);
  const items = await prisma.documentRequest.findMany({
    where: { clientId, kind: "SUPPORTING", askClient: true, status: { not: "CANCELLED" } },
    orderBy: [{ createdAt: "asc" }],
    include: {
      bookkeepingAccount: { select: { institution: true, nickname: true, last4: true, accountType: true } },
      documents: { where: { deletedAt: null }, orderBy: { createdAt: "asc" }, select: { id: true, title: true, createdAt: true, scanStatus: true, uploadedByPortalId: true } },
    },
  });
  // Coetha's reading status for each uploaded answer.
  const docIds = items.flatMap((i) => i.documents.map((d) => d.id));
  const jobs = docIds.length ? await prisma.coethaDocJob.findMany({ where: { documentId: { in: docIds } }, select: { documentId: true, status: true } }) : [];
  const reading = Object.fromEntries(jobs.map((j) => [j.documentId, j.status])) as Record<string, string>;
  return {
    reading,
    rolloutAuthorized: await clientRolloutAuthorized(),
    drafts: items.filter((i) => i.status === "DRAFT"),
    waiting: items.filter((i) => i.status === "OPEN"),
    answered: items.filter((i) => i.status === "SUBMITTED" || i.status === "ACCEPTED"),
  };
}

// --- The request letter (letterhead) ----------------------------------------------------------------

const longDate = (d: Date) => d.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "America/Chicago" });
const shortDate = (d: Date) => d.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" });

/** The letter's text: one numbered item per request, then how to answer in Client Connect. */
export function askLetterTemplate(items: { title: string; reason: string | null; instructions: string | null; dueAt: Date | null; account: string | null; period: string | null }[]): LetterTemplate {
  const bullets = items.map((i, n) => [`${n + 1}. ${i.title}.`, i.account && `Account: ${i.account}.`, i.period && `Period: ${i.period}.`, i.reason, i.instructions, i.dueAt && `Please respond by ${shortDate(i.dueAt)}.`].filter(Boolean).join(" "));
  const blocks: LetterBlock[] = [
    { text: "Thank you for working with T. Turner & Associates. To complete and support your books, we need a few items that only you can provide. Each item below says what we need and why." },
    { lead: "What we need", bullets },
    {
      lead: "How to respond.",
      text: "Sign in to TTurner Client Connect, your secure client portal, and open Bookkeeping & requests. For each item you can upload the document, or write a short explanation if you don't have a document or if the answer is simply information. Everything you send goes directly and securely to our office, so there is no need to call, text or email it.",
    },
    { text: "If you have any questions about an item, send us a message in Client Connect or call our office. We appreciate your help." },
  ];
  return {
    version: "ask-client-request-2026-11-v1",
    documentTitle: "Supporting documents request",
    label: "Supporting documents request",
    letterhead: BK_PORTAL_COETHA_V1.letterhead,
    reLine: "Re: Supporting documents and information we need for your books",
    blocks,
    closing: "Sincerely,",
    signature: "T. Turner & Associates, LLC",
    email: { subject: "Supporting documents we need", heading: "Supporting documents we need" },
  };
}

/** The request letter for this business's open and draft items (or the chosen ones), on letterhead. */
export async function askLetterPdf(actor: Actor, clientId: string, requestIds?: string[]) {
  await assertCanSendClientRequests(actor, clientId);
  const r = await letterFor(clientId, ["DRAFT", "OPEN"], requestIds);
  await audit(prisma, { actorId: actor.id, action: "ask_client.letter_prepared", entityType: "Client", entityId: clientId, clientId, details: { requestIds: r.ids } });
  return r;
}

/** The client's own copy, from the portal: only requests already sent to them (never drafts). */
export async function portalAskLetterPdf(user: PortalActor, clientId: string) {
  await requireClientAccess(user.id, clientId);
  const r = await letterFor(clientId, ["OPEN"]);
  await audit(prisma, { actorId: null, action: "ask_client.letter_viewed", entityType: "Client", entityId: clientId, clientId, details: { portalUserId: user.id, requestIds: r.ids } });
  return r;
}

async function letterFor(clientId: string, statuses: ("DRAFT" | "OPEN")[], requestIds?: string[]) {
  const items = await prisma.documentRequest.findMany({
    where: { clientId, kind: "SUPPORTING", askClient: true, status: { in: statuses }, ...(requestIds?.length ? { id: { in: requestIds } } : {}) },
    orderBy: { createdAt: "asc" },
    include: { bookkeepingAccount: { select: { institution: true, nickname: true, last4: true, accountType: true } } },
  });
  if (!items.length) throw new ValidationError("There's nothing to ask this client right now.");
  const { resolveRecipient } = await import("./client-letters");
  const { buildLetterPdf } = await import("@/lib/client-letters/pdf");
  const who = await resolveRecipient(clientId);
  const t = askLetterTemplate(items.map((i) => ({ title: i.title.replace(/\.$/, ""), reason: i.reason, instructions: i.instructions, dueAt: i.dueAt, account: i.bookkeepingAccount ? registryLabel(i.bookkeepingAccount) : null, period: i.periodStart ? rangeText(i) : null })));
  const bytes = await buildLetterPdf(t, { date: longDate(new Date()), businessName: who.businessName, ownerName: who.ownerName, ownerFirstName: who.ownerFirstName });
  return { ids: items.map((i) => i.id), bytes, fileName: `Supporting documents request - ${who.businessName}.pdf`.replace(/[^\w.\- ()&]/g, "_") };
}

// --- The client's answer -------------------------------------------------------------------------

/**
 * The client's written explanation for one sent request. It is saved word for word for the office
 * and Coetha to review: evidence only, never authorization to post. Nothing is sent to the client.
 */
export async function portalExplainRequest(user: PortalActor, clientId: string, requestId: string, text: string) {
  const access = await requireClientAccess(user.id, clientId);
  const explanation = text.trim().slice(0, MAX_EXPLANATION);
  if (explanation.length < 2) throw new ValidationError("Write your explanation first.");
  const r = await prisma.documentRequest.findFirst({ where: { id: requestId, clientId, kind: "SUPPORTING", askClient: true } });
  if (!r || (r.status !== "OPEN" && r.status !== "SUBMITTED")) throw new ValidationError("That request is closed.");
  if (r.periodId && !access.canViewBookkeeping) throw new ValidationError("Your access to this account doesn't include that.");
  await prisma.documentRequest.update({ where: { id: r.id }, data: { clientExplanation: explanation, explainedAt: new Date(), explainedByPortalId: user.id, status: "SUBMITTED" } });
  await audit(prisma, { actorId: null, action: "request.client_explained", entityType: "DocumentRequest", entityId: r.id, clientId, details: { portalUserId: user.id, length: explanation.length, replaced: !!r.clientExplanation } });
}

/**
 * A client upload answering an Ask Client request is queued for Coetha to read, so the office never
 * re-uploads it. Only for a business with books, with Coetha on, for a client who hasn't opted out,
 * and for a PDF or a picture. Never throws: the upload itself has already succeeded.
 */
export async function queueClientResponseReading(documentId: string) {
  try {
    const doc = await prisma.document.findUnique({ where: { id: documentId }, select: { id: true, clientId: true, title: true, scanStatus: true, request: { select: { askClient: true, createdById: true } }, file: { select: { mimeType: true, originalName: true } } } });
    if (!doc?.request || !doc.request.askClient || doc.scanStatus === "INFECTED") return null;
    if (!doc.file || !/^(application\/pdf|image\/(png|jpeg|gif|webp))$/.test(doc.file.mimeType)) return null;
    if (!(await prisma.ledgerBook.findUnique({ where: { clientId: doc.clientId }, select: { clientId: true } }))) return null;
    const { coethaOn } = await import("./owner-switches");
    if (!(await coethaOn())) return null;
    const { coethaOptOutOf } = await import("./coetha-opt-out");
    if (await coethaOptOutOf(doc.clientId)) return null;
    const { queueSystemReading } = await import("./coetha-reading");
    return await queueSystemReading(doc.clientId, doc.id, doc.file.originalName || doc.title, doc.request.createdById);
  } catch {
    return null;
  }
}

/** For Coetha's records: what clients answered on supporting requests (evidence only). */
export async function clientResponsesForCoetha(clientId: string) {
  const rows = await prisma.documentRequest.findMany({
    where: { clientId, askClient: true, status: { in: ["SUBMITTED", "ACCEPTED"] } },
    orderBy: { updatedAt: "desc" },
    take: 40,
    select: { id: true, title: true, reason: true, clientExplanation: true, explainedAt: true, documents: { where: { deletedAt: null }, select: { title: true } } },
  });
  return rows.map((r) => ({ request: r.title, whyAsked: r.reason, clientExplanation: r.clientExplanation, explainedOn: r.explainedAt?.toISOString().slice(0, 10) ?? null, filesUploaded: r.documents.map((d) => d.title) }));
}

// --- Coetha's tool (offered to Tabitha and staff who can send this business requests) ------------

export const ASK_CLIENT_TOOL = {
  name: "ask_client",
  description:
    "Prepare items for this business's Ask Client list: supporting documents or explanations that ONLY the client can give (a receipt or invoice, a loan agreement, what a deposit was, where a transfer went, who a check was paid to and why). Each item is saved as a DRAFT for Tabitha's review; nothing is sent to the client. Write each item in plain, polite words for the client: a short title saying exactly what is needed (with dates, amounts and check numbers), and the reason it is needed. Never ask for bank or card statements the office retrieves itself, and never ask for something already on file.",
  input_schema: {
    type: "object" as const,
    properties: {
      items: {
        type: "array",
        items: {
          type: "object",
          properties: {
            title: { type: "string", description: "What is needed, e.g. \"Receipt or invoice for check #1043, $412.00, paid March 4, 2026\"." },
            reason: { type: "string", description: "Why it's needed, in plain words for the client." },
            instructions: { type: "string", description: "Optional: what will do (e.g. \"A photo of the receipt is fine\" or \"If you have no document, a short explanation is fine\")." },
          },
          required: ["title", "reason"],
        },
      },
    },
    required: ["items"],
  },
};

export async function runAskClientTool(actor: Actor, clientId: string, input: unknown) {
  const q = (input && typeof input === "object" ? input : {}) as { items?: { title?: string; reason?: string; instructions?: string }[] };
  const items = Array.isArray(q.items) ? q.items.slice(0, 25) : [];
  if (!items.length) return { error: "No items to prepare." };
  const out: { title: string; result: string }[] = [];
  for (const i of items) {
    const title = String(i.title ?? "").trim();
    try {
      const r = await addAskItem(actor, clientId, { title, reason: i.reason ?? null, instructions: i.instructions ?? null }, { source: "COETHA" });
      out.push({ title, result: r.created ? "Draft added to the Ask Client list" : r.request ? "Already on the Ask Client list" : "Already received" });
    } catch (err) {
      out.push({ title, result: err instanceof ValidationError ? err.message : "Couldn't be prepared" });
    }
  }
  return { prepared: out, note: "Drafts only: Tabitha reviews the Ask Client list; nothing was sent to the client." };
}
