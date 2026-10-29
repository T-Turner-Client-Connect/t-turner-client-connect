import "server-only";
import { prisma } from "@/lib/prisma";
import { audit } from "@/lib/audit";
import { assertAdmin, type Actor } from "@/lib/auth/actor";
import { requireClientAccess } from "@/lib/portal/access";
import type { PortalActor } from "@/lib/portal/session";
import { CATEGORIES, EXPECTED_STATE_CATEGORIES, isStateCode, REQUEST_TOPICS, stateName, type RequestTopic } from "@/lib/resources/catalog";
import { ValidationError } from "./clients";
import { portalUploadDocument } from "./documents";
import { queueStaffAlert } from "./staff-alerts";

/**
 * Client Resource Center. Resources are official agency links (or honest
 * "not applicable" notes) per state/DC/county/city plus federal ("US").
 * Clients only read them; every login and payment happens on the agency's
 * own website — nothing here collects agency passwords or marks payments.
 */
export async function resourcesFor(state: string, opts: { includeHidden?: boolean } = {}) {
  if (!isStateCode(state)) throw new ValidationError("Choose a state.");
  return prisma.resource.findMany({
    where: { jurisdiction: { in: [state, "US"] }, ...(opts.includeHidden ? {} : { hidden: false }) },
    orderBy: [{ sortOrder: "asc" }, { title: "asc" }],
  });
}

/** Which expected resource types are still missing or unconfirmed for a state. */
export function coverage(state: string, rows: { jurisdiction: string; category: string; status: string; hidden: boolean }[]) {
  const mine = rows.filter((r) => r.jurisdiction === state && !r.hidden);
  const missing = EXPECTED_STATE_CATEGORIES.filter((c) => !mine.some((r) => r.category === c));
  const unconfirmed = EXPECTED_STATE_CATEGORIES.filter((c) => mine.some((r) => r.category === c) && mine.filter((r) => r.category === c).every((r) => r.status === "NEEDS_VERIFICATION" || r.status === "UNAVAILABLE"));
  return { missing, unconfirmed, complete: missing.length === 0 && unconfirmed.length === 0 };
}

export async function setPreferredState(user: PortalActor, state: string) {
  if (!isStateCode(state)) throw new ValidationError("Choose a state.");
  await prisma.portalUser.update({ where: { id: user.id }, data: { preferredState: state } });
}

export async function visibleFaqs() {
  return prisma.resourceFaq.findMany({ where: { hidden: false }, orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }] });
}

/**
 * "Ask TTurner for Help" and the request buttons: a secure portal request in
 * the client's own file (shared staff inbox), with the state and topic, plus
 * an optional supporting document saved to the client's yearly documents.
 */
export async function requestResourceHelp(
  user: PortalActor,
  input: { clientId: string; topic: RequestTopic; state: string; area?: string | null; message: string; file?: { bytes: Uint8Array; originalName: string } | null; year?: number | "unsure" | null },
) {
  await requireClientAccess(user.id, input.clientId, "message");
  if (!(input.topic in REQUEST_TOPICS)) throw new ValidationError("Choose what you need help with.");
  if (!isStateCode(input.state) && input.state !== "US") throw new ValidationError("Choose a state.");
  const message = input.message.trim();
  if (!message) throw new ValidationError("Tell us briefly what you need.");
  if (message.length > 4000) throw new ValidationError("Please keep the message under 4,000 characters.");
  let documentId: string | null = null;
  if (input.file) {
    await requireClientAccess(user.id, input.clientId, "upload");
    documentId = (await portalUploadDocument(user, { clientId: input.clientId, title: `${REQUEST_TOPICS[input.topic]} — supporting document`, year: input.year ?? null, ...input.file })).id;
  }
  const label = REQUEST_TOPICS[input.topic];
  const where = input.state === "US" ? "Federal" : stateName(input.state);
  const area = input.area && input.area in CATEGORIES ? CATEGORIES[input.area].label : input.area?.slice(0, 80) || null;
  const convo = await prisma.$transaction(async (tx) => {
    const c = await tx.conversation.create({ data: { clientId: input.clientId, subject: `${label} — ${where}${area ? ` · ${area}` : ""}`.slice(0, 200), awaitingStaff: true, unreadByStaff: true } });
    await tx.message.create({
      data: {
        conversationId: c.id,
        channel: "PORTAL",
        direction: "INBOUND",
        portalAuthorId: user.id,
        status: "DELIVERED",
        readByClientAt: new Date(),
        body: `[Resource Center request] ${label}\nState: ${where}${area ? `\nTopic: ${area}` : ""}\n\n${message}`,
        attachments: documentId ? { connect: [{ id: documentId }] } : undefined,
      },
    });
    await audit(tx, { actorId: null, action: "resources.help_requested", entityType: "Conversation", entityId: c.id, clientId: input.clientId, details: { topic: input.topic, state: input.state } });
    return c;
  });
  await queueStaffAlert({ conversationId: convo.id });
  return convo;
}

// ---------------------------------------------------------------------------
// Staff management (Admins edit; any staff can read)
// ---------------------------------------------------------------------------

export type ResourceInput = {
  jurisdiction: string;
  county?: string | null;
  city?: string | null;
  category: string;
  title: string;
  purpose: string;
  agency: string;
  url?: string | null;
  phone?: string | null;
  status: string;
  notes?: string | null;
};

const STATUSES = ["VERIFIED", "NEEDS_VERIFICATION", "NOT_APPLICABLE", "UNAVAILABLE"];

function cleanResource(input: ResourceInput) {
  if (!isStateCode(input.jurisdiction) && input.jurisdiction !== "US") throw new ValidationError("Choose a state, DC or Federal.");
  if (!(input.category in CATEGORIES)) throw new ValidationError("Choose a category.");
  if (!STATUSES.includes(input.status)) throw new ValidationError("Choose a status.");
  if (!input.title.trim() || !input.purpose.trim() || !input.agency.trim()) throw new ValidationError("Add a title, what it's for, and the agency.");
  let url: string | null = null;
  if (input.url?.trim()) {
    try {
      const u = new URL(input.url.trim());
      if (u.protocol !== "https:") throw new Error();
      url = u.toString();
    } catch {
      throw new ValidationError("Enter the full official https:// address.");
    }
  }
  if (input.status === "VERIFIED" && !url) throw new ValidationError("A verified resource needs its official link.");
  if (input.status === "NOT_APPLICABLE" && !input.notes?.trim()) throw new ValidationError("Explain why it doesn't apply in this state.");
  return {
    jurisdiction: input.jurisdiction,
    county: input.county?.trim() || null,
    city: input.city?.trim() || null,
    category: input.category,
    title: input.title.trim().slice(0, 160),
    purpose: input.purpose.trim().slice(0, 400),
    agency: input.agency.trim().slice(0, 160),
    url,
    phone: input.phone?.trim() || null,
    status: input.status,
    notes: input.notes?.trim() || null,
  };
}

export async function saveResource(actor: Actor, input: ResourceInput, id?: string) {
  assertAdmin(actor);
  const data = cleanResource(input);
  const stamp = data.status === "VERIFIED" ? { lastVerifiedAt: new Date(), verificationMethod: "staff" } : {};
  const r = id
    ? await prisma.resource.update({ where: { id }, data: { ...data, ...stamp, updatedById: actor.id, linkCheckedAt: null, linkCheckOk: null, linkCheckStatus: null } })
    : await prisma.resource.create({ data: { ...data, ...stamp, updatedById: actor.id, sortOrder: 1000 } });
  await audit(prisma, { actorId: actor.id, action: id ? "resources.updated" : "resources.created", entityType: "Resource", entityId: r.id });
  return r;
}

export async function setResourceHidden(actor: Actor, id: string, hidden: boolean) {
  assertAdmin(actor);
  await prisma.resource.update({ where: { id }, data: { hidden, updatedById: actor.id } });
  await audit(prisma, { actorId: actor.id, action: hidden ? "resources.hidden" : "resources.shown", entityType: "Resource", entityId: id });
}

/** Moves a resource up or down within its state and category. */
export async function moveResource(actor: Actor, id: string, direction: "up" | "down") {
  assertAdmin(actor);
  const r = await prisma.resource.findUniqueOrThrow({ where: { id } });
  const siblings = await prisma.resource.findMany({ where: { jurisdiction: r.jurisdiction, category: r.category }, orderBy: [{ sortOrder: "asc" }, { title: "asc" }] });
  const i = siblings.findIndex((s) => s.id === id);
  const j = direction === "up" ? i - 1 : i + 1;
  if (j < 0 || j >= siblings.length) return;
  [siblings[i], siblings[j]] = [siblings[j], siblings[i]];
  await prisma.$transaction(siblings.map((s, k) => prisma.resource.update({ where: { id: s.id }, data: { sortOrder: k } })));
}

export async function saveFaq(actor: Actor, input: { question: string; answer: string; tags: string[] }, id?: string) {
  assertAdmin(actor);
  if (!input.question.trim() || !input.answer.trim()) throw new ValidationError("Add the question and the answer.");
  const data = { question: input.question.trim().slice(0, 300), answer: input.answer.trim().slice(0, 4000), tags: input.tags.map((t) => t.trim().toLowerCase()).filter(Boolean).slice(0, 12), updatedById: actor.id };
  return id ? prisma.resourceFaq.update({ where: { id }, data }) : prisma.resourceFaq.create({ data: { ...data, sortOrder: 1000 } });
}

export async function setFaqHidden(actor: Actor, id: string, hidden: boolean) {
  assertAdmin(actor);
  await prisma.resourceFaq.update({ where: { id }, data: { hidden, updatedById: actor.id } });
}

/**
 * Live link check, run from the deployed site (which can reach agency
 * websites). Records the HTTP status; a failure flags the link for review
 * but never deletes it. Checks the least-recently checked links first.
 */
export async function checkResourceLinks(limit = 25, olderThanDays = 7) {
  const due = await prisma.resource.findMany({
    where: { url: { not: null }, OR: [{ linkCheckedAt: null }, { linkCheckedAt: { lt: new Date(Date.now() - olderThanDays * 86400_000) } }] },
    orderBy: [{ linkCheckedAt: { sort: "asc", nulls: "first" } }],
    take: limit,
  });
  let ok = 0;
  for (const r of due) {
    let status = 0;
    try {
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), 10_000);
      let res = await fetch(r.url!, { method: "HEAD", redirect: "follow", signal: ctl.signal, headers: { "User-Agent": "TTurner-Client-Connect-LinkCheck/1.0" } });
      // Many agency sites refuse HEAD; try a normal GET before calling it broken.
      if (res.status === 405 || res.status === 403 || res.status === 404) res = await fetch(r.url!, { method: "GET", redirect: "follow", signal: ctl.signal, headers: { "User-Agent": "TTurner-Client-Connect-LinkCheck/1.0" } });
      clearTimeout(t);
      status = res.status;
    } catch {
      status = 0;
    }
    const good = status >= 200 && status < 400;
    if (good) ok++;
    await prisma.resource.update({ where: { id: r.id }, data: { linkCheckedAt: new Date(), linkCheckStatus: status, linkCheckOk: good } });
  }
  return { checked: due.length, ok, failed: due.length - ok };
}
