import "server-only";
import type { CoethaConsent } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { audit } from "@/lib/audit";
import { ForbiddenError, type Actor } from "@/lib/auth/actor";
import type { PortalActor } from "@/lib/portal/session";
import { requireClientAccess } from "@/lib/portal/access";
import { ValidationError } from "./clients";

/**
 * Coetha client notice and authorization. Coetha (the AI assistant) never works on a client's
 * financial information until that client has seen this notice and authorized it. The notice is
 * versioned: changing its wording means a new COETHA_CONSENT_VERSION, and every client must
 * authorize the new version before Coetha works on their books again.
 *
 * DRAFT wording for Tabitha's approval.
 */
export const COETHA_CONSENT_VERSION = "2026-11-v2";

export const COETHA_CONSENT_TITLE = "Using an AI assistant on your books";
export const COETHA_CONSENT_TEXT: string[] = [
  "T. Turner & Associates uses an AI assistant, provided by Anthropic, to help prepare your bookkeeping. It drafts categories for your transactions and helps reconcile your accounts, working from your bank and bookkeeping data.",
  "Before anything is sent to the assistant, we leave out your name and remove email addresses, phone numbers and Social Security or EIN-format numbers. Long numbers, such as account numbers, are shortened to their last four digits. Transaction amounts, dates and descriptions are sent, and descriptions may include merchant or payee names.",
  "Nothing the assistant prepares is final. Tabitha reviews every draft and approves it before it becomes part of your books.",
  "You can decline, or withdraw your authorization at any time. If you do, we keep doing your books without the assistant, and nothing else about your service changes.",
];

export type ConsentStatus = "AUTHORIZED" | "DECLINED" | "WITHDRAWN";
export type ConsentMethod = "PORTAL" | "IN_OFFICE" | "WRITTEN";

export const COETHA_NO_CONSENT = "Coetha can't work on this business yet: the client hasn't authorized the AI assistant notice. Ask the client to review it in their portal (Bookkeeping), or record their in-office or written authorization on the bookkeeping dashboard.";
export const COETHA_OLD_CONSENT = `Coetha can't work on this business: the client authorized an earlier version of the AI assistant notice. They need to review and authorize the current version (${COETHA_CONSENT_VERSION}).`;
export const COETHA_DECLINED = "Coetha can't work on this business: the client declined or withdrew authorization for the AI assistant. Their books are done without it.";

/** The client's current decision (the newest record), or null if they've never been asked. */
export async function currentCoethaConsent(clientId: string): Promise<CoethaConsent | null> {
  return prisma.coethaConsent.findFirst({ where: { clientId }, orderBy: [{ createdAt: "desc" }, { id: "desc" }] });
}

export type ConsentState = { ok: boolean; state: "AUTHORIZED" | "OLD_VERSION" | "DECLINED" | "WITHDRAWN" | "NONE"; consent: CoethaConsent | null; message: string | null };

export function consentStateOf(c: CoethaConsent | null): ConsentState {
  if (!c) return { ok: false, state: "NONE", consent: null, message: COETHA_NO_CONSENT };
  if (c.status === "AUTHORIZED" && c.version === COETHA_CONSENT_VERSION) return { ok: true, state: "AUTHORIZED", consent: c, message: null };
  if (c.status === "AUTHORIZED") return { ok: false, state: "OLD_VERSION", consent: c, message: COETHA_OLD_CONSENT };
  return { ok: false, state: c.status === "DECLINED" ? "DECLINED" : "WITHDRAWN", consent: c, message: COETHA_DECLINED };
}

export async function coethaConsentState(clientId: string): Promise<ConsentState> {
  return consentStateOf(await currentCoethaConsent(clientId));
}

/** Coetha's gate: throws a staff-facing message unless this client has a current authorization. */
export async function assertCoethaConsent(clientId: string) {
  const s = await coethaConsentState(clientId);
  if (!s.ok) throw new ValidationError(s.message!);
}

export async function consentStatesFor(clientIds: string[]) {
  const rows = clientIds.length ? await prisma.coethaConsent.findMany({ where: { clientId: { in: clientIds } }, orderBy: [{ createdAt: "desc" }, { id: "desc" }] }) : [];
  const out = new Map<string, ConsentState>();
  for (const id of clientIds) out.set(id, consentStateOf(rows.find((r) => r.clientId === id) ?? null));
  return out;
}

export const CONSENT_LABEL: Record<ConsentState["state"], string> = {
  AUTHORIZED: "Authorized",
  OLD_VERSION: "Needs to re-authorize (notice updated)",
  DECLINED: "Declined",
  WITHDRAWN: "Withdrawn",
  NONE: "Not asked yet",
};

/** Who sees the notice in the portal: the business's owner login with banking (bookkeeping) access on a Managed Business. */
export async function portalMayDecideCoetha(portalUserId: string, clientId: string) {
  try {
    const access = await requireClientAccess(portalUserId, clientId);
    return access.role === "OWNER" && access.canViewBookkeeping;
  } catch {
    return false;
  }
}

/** The client's own decision from the portal: authorize, decline, or withdraw. */
export async function portalDecideCoetha(user: PortalActor, clientId: string, decision: ConsentStatus) {
  if (!(await portalMayDecideCoetha(user.id, clientId))) throw new ForbiddenError("Only the business owner can answer this notice.");
  if (!["AUTHORIZED", "DECLINED", "WITHDRAWN"].includes(decision)) throw new ValidationError("Choose authorize or decline.");
  const before = await currentCoethaConsent(clientId);
  if (decision === "WITHDRAWN" && before?.status !== "AUTHORIZED") throw new ValidationError("There's no authorization to withdraw.");
  const row = await prisma.coethaConsent.create({ data: { clientId, status: decision, version: COETHA_CONSENT_VERSION, method: "PORTAL", portalUserId: user.id, decidedByName: user.name } });
  await audit(prisma, { actorId: null, action: `coetha.consent_${decision.toLowerCase()}`, entityType: "CoethaConsent", entityId: row.id, clientId, details: { method: "PORTAL", version: COETHA_CONSENT_VERSION, portalUserId: user.id, from: before ? `${before.status}@${before.version}` : null } });
  return row;
}

/**
 * Staff record a decision the client made in the office or in writing. A method (IN_OFFICE or
 * WRITTEN) and a note saying who and how are required.
 */
export async function staffRecordCoethaConsent(actor: Actor, clientId: string, input: { status: ConsentStatus; method: string; note: string; clientName?: string }) {
  const { assertLedger } = await import("./ledger");
  await assertLedger(actor, clientId);
  if (input.method !== "IN_OFFICE" && input.method !== "WRITTEN") throw new ValidationError("Choose how the client gave their answer: in the office, or in writing.");
  if ((input.note ?? "").trim().length < 5) throw new ValidationError("Add a note: who answered, when, and where the written copy is kept.");
  if (!["AUTHORIZED", "DECLINED", "WITHDRAWN"].includes(input.status)) throw new ValidationError("Choose authorized, declined or withdrawn.");
  const before = await currentCoethaConsent(clientId);
  const row = await prisma.coethaConsent.create({ data: { clientId, status: input.status, version: COETHA_CONSENT_VERSION, method: input.method, note: input.note.trim().slice(0, 500), recordedById: actor.id, decidedByName: input.clientName?.trim().slice(0, 120) || null } });
  await audit(prisma, { actorId: actor.id, action: `coetha.consent_${input.status.toLowerCase()}`, entityType: "CoethaConsent", entityId: row.id, clientId, details: { method: input.method, version: COETHA_CONSENT_VERSION, note: row.note, from: before ? `${before.status}@${before.version}` : null } });
  return row;
}

export async function coethaConsentHistory(clientId: string) {
  return prisma.coethaConsent.findMany({ where: { clientId }, orderBy: { createdAt: "desc" }, take: 20 });
}
