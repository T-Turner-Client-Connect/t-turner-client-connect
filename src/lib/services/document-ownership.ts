import "server-only";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { audit } from "@/lib/audit";
import type { Actor } from "@/lib/auth/actor";
import { pdfLines } from "@/lib/statement-pdf";
import { readDocumentBytes } from "./documents";

/**
 * Misfiled documents, across every section (Taxes, Bookkeeping, Payroll, the Vault, uploads…).
 *
 * Tabitha's standing authorization: when a document filed under one client clearly belongs to
 * another existing client, Coetha moves it there without asking. "Clearly" means the document
 * itself proves it:
 *   - the other client's name is printed on it, AND one of that client's own identifiers on file
 *     is printed on it too (SSN last four from its tax return, EIN last four, or the last four of a
 *     registered bank/card account), AND
 *   - nothing on it names or identifies the client it is filed under, AND
 *   - no third client's identifier is on it.
 * When another client's identifiers are on it but ownership can't be proven (several clients
 * match), it is held in a staff-only review area (Owner's Office → Document ownership review):
 * the client it is filed under no longer sees it, nothing is guessed, and Tabitha decides.
 *
 * A move keeps the original file (the same stored bytes), never creates a second copy (if the
 * correct client already has the same file, the misfiled copy goes to Recently deleted, where it
 * can be restored for 30 days), removes the wrong client's access at once, and is audited under
 * both clients. The moved document arrives staff-only: releasing it to the correct client stays
 * with Tabitha. Documents tied to firm records (signed agreements, filings, notices, audit
 * packages, released reports) and identity / owner-private documents are never moved here.
 */

type Identity = { id: string; label: string; businessNames: string[]; people: [string, string][]; ssn4: Set<string>; ein4: Set<string>; acct4: Map<string, string> };

export type OwnershipVerdict =
  | { verdict: "OWNS" | "UNKNOWN" | "UNREADABLE" | "EXCLUDED"; reason: string }
  | { verdict: "MOVE"; to: { id: string; label: string }; accountId: string | null; proof: string[] }
  | { verdict: "HOLD"; reason: string; candidates: { id: string; label: string }[] };

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\b(llc|inc|co|corp|corporation|company|the|pllc|lp|llp|ltd)\b/g, " ").replace(/\s+/g, " ").trim();

/** Categories never moved automatically: identity papers, and an owner's private K-1 / personal papers kept on a business. */
const PROTECTED = new Set(["IDENTITY", "OWNER_K1", "OWNER_PERSONAL"]);

/** The SSN, EIN and account last fours printed on a document. */
export function identifiersIn(text: string) {
  const ssn4 = new Set<string>(), ein4 = new Set<string>();
  for (const m of text.matchAll(/(?<![\dA-Za-z])(?:\d{3}|[xX*•]{3})[-\s](?:\d{2}|[xX*•]{2})[-\s](\d{4})(?!\d)/g)) ssn4.add(m[1]);
  for (const m of text.matchAll(/(?<![\dA-Za-z-])(?:\d{2}|[xX*•]{2})-(?:\d{3}|[xX*•]{3})(\d{4})(?!\d)/g)) ein4.add(m[1]);
  return { ssn4, ein4 };
}

async function identities(): Promise<Identity[]> {
  const clients = await prisma.client.findMany({
    where: { archivedAt: null },
    select: { id: true, displayName: true, businessName: true, firstName: true, preferredName: true, lastName: true, spouseFirstName: true, spouseLastName: true },
  });
  const [profiles, summaries, accounts] = await Promise.all([
    prisma.bookkeepingProfile.findMany({ select: { clientId: true, legalName: true, dba: true, einLast4: true } }),
    prisma.taxReturnSummary.findMany({ where: { OR: [{ taxpayerSsnLast4: { not: null } }, { spouseSsnLast4: { not: null } }] }, select: { clientId: true, taxpayerSsnLast4: true, spouseSsnLast4: true } }),
    prisma.bookkeepingAccount.findMany({ where: { last4: { not: null } }, select: { id: true, clientId: true, last4: true, parentAccountId: true } }),
  ]);
  const byId = new Map<string, Identity>();
  for (const c of clients) {
    const people: [string, string][] = [];
    if (c.firstName && c.lastName) people.push([norm(c.firstName), norm(c.lastName)]);
    if (c.preferredName && c.lastName) people.push([norm(c.preferredName), norm(c.lastName)]);
    if (c.spouseFirstName && c.spouseLastName) people.push([norm(c.spouseFirstName), norm(c.spouseLastName)]);
    const businessNames = [c.businessName, !c.firstName ? c.displayName : null].filter((n): n is string => !!n).map(norm);
    byId.set(c.id, { id: c.id, label: c.businessName || c.displayName, businessNames, people, ssn4: new Set(), ein4: new Set(), acct4: new Map() });
  }
  for (const p of profiles) {
    const i = byId.get(p.clientId); if (!i) continue;
    for (const n of [p.legalName, p.dba]) if (n) i.businessNames.push(norm(n));
    if (p.einLast4) i.ein4.add(p.einLast4);
  }
  for (const s of summaries) {
    const i = byId.get(s.clientId); if (!i) continue;
    for (const n of [s.taxpayerSsnLast4, s.spouseSsnLast4]) if (n) i.ssn4.add(n);
  }
  for (const a of accounts) {
    const i = byId.get(a.clientId); if (!i || !a.last4) continue;
    if (!i.acct4.has(a.last4) || !a.parentAccountId) i.acct4.set(a.last4, a.id);
  }
  for (const i of byId.values()) i.businessNames = [...new Set(i.businessNames.filter((n) => n.length >= 6))];
  return [...byId.values()];
}

function namedIn(i: Identity, flat: string, words: Set<string>) {
  if (i.businessNames.some((n) => flat.includes(` ${n} `))) return true;
  return i.people.some(([f, l]) => f.length >= 2 && l.length >= 3 && words.has(f) && words.has(l));
}

function idsIn(i: Identity, doc: { ssn4: Set<string>; ein4: Set<string>; acct4: Set<string> }) {
  const hits: string[] = [];
  let accountId: string | null = null;
  // SSN and EIN digits are never written into the reason or the audit trail.
  if ([...i.ssn4].some((n) => doc.ssn4.has(n))) hits.push("SSN matches the one on file");
  if ([...i.ein4].some((n) => doc.ein4.has(n))) hits.push("EIN matches the one on file");
  for (const [n, id] of i.acct4) if (doc.acct4.has(n)) { hits.push(`account ending ${n}`); accountId ??= id; }
  return { hits, accountId };
}

type DocRow = Awaited<ReturnType<typeof loadDoc>>;
async function loadDoc(documentId: string) {
  return prisma.document.findUnique({
    where: { id: documentId },
    include: {
      file: true,
      signaturePackages: { select: { id: true }, take: 1 },
      signatureSigned: { select: { id: true }, take: 1 },
      signatureAudit: { select: { id: true }, take: 1 },
      contractPdfs: { select: { id: true }, take: 1 },
      auditItemLinks: { select: { id: true }, take: 1 },
    },
  });
}

function excludedReason(d: NonNullable<DocRow>): string | null {
  if (d.deletedAt || d.purgedAt) return "deleted";
  if (PROTECTED.has(d.category)) return "identity or owner-private document";
  if (d.reportType || d.noticeCaseId || d.replacesId || d.signaturePackages.length || d.signatureSigned.length || d.signatureAudit.length || d.contractPdfs.length || d.auditItemLinks.length) return "tied to a firm record (report, filing, notice, agreement or audit package)";
  return null;
}

async function documentText(d: NonNullable<DocRow>): Promise<string | null> {
  if (d.file && /pdf/i.test(d.file.mimeType)) {
    const bytes = await readDocumentBytes(d.file).catch(() => null);
    const lines = bytes ? await pdfLines(bytes, { maxPages: 6 }).catch(() => null) : null;
    const t = (lines ?? []).slice(0, 400).join("\n");
    if (t.trim()) return t;
  }
  // Scans and pictures Coetha has already read keep their text on her reading job.
  const job = await prisma.coethaDocJob.findUnique({ where: { documentId: d.id }, select: { text: true } }).catch(() => null);
  return job?.text?.trim() ? job.text : null;
}

/** Whose document is this? Reads only the document itself and the identifiers on file. Never guesses. */
export async function assessOwnership(documentId: string, cache?: { ids?: Identity[] }): Promise<OwnershipVerdict> {
  const d = await loadDoc(documentId);
  if (!d) return { verdict: "EXCLUDED", reason: "not found" };
  const ex = excludedReason(d);
  if (ex) return { verdict: "EXCLUDED", reason: ex };
  const text = await documentText(d);
  if (!text) return { verdict: "UNREADABLE", reason: "Its text can't be read here (a picture or scan Coetha hasn't read yet)." };
  const flat = ` ${norm(text)} `;
  const words = new Set(flat.trim().split(" "));
  const { accountNumbersIn } = await import("./statement-choice");
  const { ssn4, ein4 } = identifiersIn(text);
  const acct4 = accountNumbersIn(text.split("\n"));
  for (const n of [...ssn4, ...ein4]) acct4.delete(n);
  const printed = { ssn4, ein4, acct4 };
  const all = cache?.ids ?? (await identities());
  if (cache && !cache.ids) cache.ids = all;
  const here = all.find((i) => i.id === d.clientId);
  if (here && (namedIn(here, flat, words) || idsIn(here, printed).hits.length)) return { verdict: "OWNS", reason: "This client's name or identifiers are printed on it." };
  const strong: { i: Identity; hits: string[]; accountId: string | null }[] = [];
  const idOnly: Identity[] = [];
  for (const i of all) {
    if (i.id === d.clientId) continue;
    const { hits, accountId } = idsIn(i, printed);
    if (!hits.length) continue;
    if (namedIn(i, flat, words)) strong.push({ i, hits, accountId }); else idOnly.push(i);
  }
  if (strong.length === 1 && !idOnly.length) {
    const s = strong[0];
    return { verdict: "MOVE", to: { id: s.i.id, label: s.i.label }, accountId: s.accountId, proof: [`${s.i.label}'s name`, ...s.hits] };
  }
  if (strong.length) {
    const c = [...strong.map((s) => s.i), ...idOnly];
    return { verdict: "HOLD", reason: `More than one client's name and identifiers are printed on it (${c.map((x) => x.label).join(", ")}), and nothing on it identifies the client it is filed under.`, candidates: c.map((x) => ({ id: x.id, label: x.label })) };
  }
  // A tax or payroll document (it carries an SSN or EIN, or is filed under Taxes / Payroll) that names
  // another client as a person, and nowhere names or identifies the client it is filed under: whose it
  // is isn't proven (that client's SSN isn't on file to compare), so it is held, never guessed.
  const taxDoc = ssn4.size > 0 || ein4.size > 0 || d.category === "TAXES" || d.category === "PAYROLL";
  if (taxDoc) {
    const people = all.filter((i) => i.id !== d.clientId && i.people.some(([f, l]) => f.length >= 2 && l.length >= 3 && words.has(f) && words.has(l)));
    if (people.length) return { verdict: "HOLD", reason: `${people.map((x) => x.label).join(", ")} ${people.length === 1 ? "is" : "are"} named on this tax document and the client it is filed under isn't; no identifier on file proves whose it is.`, candidates: people.map((x) => ({ id: x.id, label: x.label })) };
  }
  return { verdict: "UNKNOWN", reason: "Nothing on it proves it belongs to another client." };
}

/** Moves a document to the client it belongs to: same stored file, wrong client's access removed, no duplicate, audited under both. */
export async function relocateDocument(actor: Actor, documentId: string, to: { id: string; label: string }, opts: { accountId?: string | null; proof: string[]; by: string }) {
  const d = await prisma.document.findUniqueOrThrow({ where: { id: documentId }, include: { file: true } });
  const from = d.clientId;
  if (from === to.id) return { moved: false, message: "It is already filed under that client." };
  // No duplicate: the correct client already has this exact file.
  const twin = d.file?.sha256 ? await prisma.document.findFirst({ where: { clientId: to.id, deletedAt: null, id: { not: d.id }, file: { sha256: d.file.sha256 } }, select: { id: true, title: true } }) : null;
  const details = { from, to: to.id, proof: opts.proof, by: opts.by, title: d.title, category: d.category, visibilityBefore: d.visibility, uploadedByPortalId: d.uploadedByPortalId, duplicateOf: twin?.id ?? null };
  await prisma.$transaction(async (tx) => {
    // The wrong client's links to it: reconciliations, its messages, its request, its reading job.
    await tx.accountReconciliation.updateMany({ where: { clientId: from, statementDocumentId: d.id }, data: { statementDocumentId: null, statementStatus: "MISSING" } });
    const msgs = await tx.message.findMany({ where: { attachments: { some: { id: d.id } } }, select: { id: true } });
    for (const m of msgs) await tx.message.update({ where: { id: m.id }, data: { attachments: { disconnect: { id: d.id } } } });
    const job = await tx.coethaDocJob.findUnique({ where: { documentId: d.id } });
    if (job) { await tx.coethaDocFinding.deleteMany({ where: { jobId: job.id } }); await tx.coethaDocJob.delete({ where: { id: job.id } }); }
    if (twin) {
      // The correct client already holds the same file: this copy goes to Recently deleted (restorable for 30 days).
      const now = new Date();
      await tx.document.update({ where: { id: d.id }, data: { deletedAt: now, deletedById: actor.id, deletionReason: `Misfiled under another client; ${to.label} already has the same file.`, visibility: "STAFF_ONLY", purgeAfter: new Date(now.getTime() + 30 * 86_400_000), ownershipCheckedAt: now, ownershipHold: Prisma.DbNull } });
    } else {
      // Arrives staff-only: releasing it to the correct client stays with Tabitha. Who uploaded it
      // stays in the audit entry; the other client's login no longer counts as its uploader.
      await tx.document.update({ where: { id: d.id }, data: { clientId: to.id, visibility: "STAFF_ONLY", publishedAt: null, needsReview: true, uploadedByPortalId: null, requestId: null, periodId: null, filingId: null, filingDocType: null, bookkeepingAccountId: opts.accountId ?? null, manualBankAccountId: null, ownershipCheckedAt: new Date(), ownershipHold: Prisma.DbNull } });
    }
    await tx.documentAccessLog.create({ data: { documentId: d.id, action: twin ? "DELETE" : "UNPUBLISH", staffUserId: actor.id } });
  });
  for (const c of [from, to.id]) await audit(prisma, { actorId: actor.id, action: "document.moved_to_owner", entityType: "Document", entityId: d.id, clientId: c, details });
  return { moved: true, duplicate: !!twin, message: twin ? `“${d.title}” belongs to ${to.label}, who already has the same file; this misfiled copy was removed from this client (restorable from Recently deleted for 30 days).` : `Moved “${d.title}” to ${to.label} (${opts.proof.join(", ")} printed on it). This client no longer sees it; it is staff-only at ${to.label} until Tabitha releases it.` };
}

/** Holds a document in the staff-only review area: the client it is filed under stops seeing it. */
export async function holdForOwnershipReview(actor: Actor, documentId: string, reason: string, candidates: { id: string; label: string }[], by: string) {
  const d = await prisma.document.findUniqueOrThrow({ where: { id: documentId } });
  const msgs = await prisma.message.findMany({ where: { staffAuthorId: { not: null }, attachments: { some: { id: d.id } } }, select: { id: true } });
  // An upload staff marked "publish" is restored as published if Tabitha keeps it here.
  const hold = { reason: reason.slice(0, 500), candidates, visibilityBefore: d.publishAfterCheck ? "PUBLISHED" : d.visibility, staffMessages: msgs.map((m) => m.id), heldAt: new Date().toISOString(), by };
  await prisma.$transaction(async (tx) => {
    for (const m of msgs) await tx.message.update({ where: { id: m.id }, data: { attachments: { disconnect: { id: d.id } } } });
    await tx.document.update({ where: { id: d.id }, data: { visibility: "STAFF_ONLY", needsReview: true, ownershipHold: hold, ownershipCheckedAt: new Date() } });
  });
  await audit(prisma, { actorId: actor.id, action: "document.ownership_held", entityType: "Document", entityId: d.id, clientId: d.clientId, details: hold });
  return { held: true, message: `“${d.title}” is held for review (staff-only): ${reason}` };
}

/** Checks one document and acts on it under the standing authorization. */
export async function checkAndCorrect(actor: Actor, documentId: string, by: string, cache: { ids?: Identity[] } = {}) {
  const v = await assessOwnership(documentId, cache);
  if (v.verdict === "MOVE") return { verdict: v.verdict, ...(await relocateDocument(actor, documentId, v.to, { accountId: v.accountId, proof: v.proof, by })) };
  if (v.verdict === "HOLD") {
    const held = await prisma.document.findUnique({ where: { id: documentId }, select: { ownershipHold: true } });
    if (held?.ownershipHold) return { verdict: v.verdict, message: "Already held for review." };
    return { verdict: v.verdict, ...(await holdForOwnershipReview(actor, documentId, v.reason, v.candidates, by)) };
  }
  if (v.verdict !== "UNREADABLE") await prisma.document.update({ where: { id: documentId }, data: { ownershipCheckedAt: new Date() } });
  return { verdict: v.verdict, message: v.reason };
}

/**
 * The scheduled sweep: checks documents not yet checked (oldest first, including every existing
 * record), within a time budget. Runs under Tabitha's standing authorization as her owner actor.
 */
export async function sweepDocumentOwnership(opts: { budgetMs: number; limit?: number }) {
  const { ownerActor } = await import("./coetha-decisions");
  const owner = await ownerActor();
  if (!owner) return { checked: 0, moved: 0, held: 0, more: false, error: "no owner" };
  const started = Date.now();
  // Waiting releases first (uploads whose check didn't finish), then every record not yet checked.
  const docs = await prisma.document.findMany({ where: { deletedAt: null, purgedAt: null, OR: [{ publishAfterCheck: true }, { ownershipCheckedAt: null }] }, orderBy: [{ publishAfterCheck: "desc" }, { createdAt: "asc" }], take: opts.limit ?? 200, select: { id: true } });
  const cache: { ids?: Identity[] } = {};
  let checked = 0, moved = 0, held = 0;
  for (const d of docs) {
    if (Date.now() - started > opts.budgetMs) break;
    try {
      const r = await checkAndCorrect(owner, d.id, "Coetha (standing authorization, scheduled check)", cache);
      if (await releaseIfCleared(d.id, r.verdict)) {
        const now = await prisma.document.findUnique({ where: { id: d.id }, select: { clientId: true, category: true, scanStatus: true } });
        if (now?.scanStatus === "CLEAN") await (await import("./documents")).notifyClientUsers(now.clientId, "NEW_DOCUMENT", d.id, now.category).catch(() => {});
      }
      if (r.verdict === "MOVE") moved++;
      if (r.verdict === "HOLD") held++;
      // A picture nobody has read yet is checked again once Coetha has read it.
      if (r.verdict === "UNREADABLE") await prisma.document.update({ where: { id: d.id }, data: { ownershipCheckedAt: new Date() } });
    } catch {
      await prisma.document.update({ where: { id: d.id }, data: { ownershipCheckedAt: new Date() } }).catch(() => {});
    }
    checked++;
  }
  return { checked, moved, held, more: checked < docs.length || docs.length === (opts.limit ?? 200) };
}

/** Documents held for review, for the Owner's Office page. */
export async function heldDocuments() {
  const docs = await prisma.document.findMany({ where: { deletedAt: null, NOT: { ownershipHold: { equals: Prisma.DbNull } } }, orderBy: { createdAt: "desc" }, select: { id: true, title: true, category: true, year: true, ownershipHold: true, client: { select: { id: true, displayName: true, businessName: true } } } });
  return docs.filter((d) => d.ownershipHold).map((d) => ({ ...d, hold: d.ownershipHold as { reason: string; candidates: { id: string; label: string }[]; visibilityBefore: string; heldAt: string } }));
}

/** Tabitha's decision on a held document: move it to the client she names, or keep it where it is (its access comes back). */
export async function decideHeldDocument(actor: Actor, documentId: string, decision: { moveTo?: string | null }) {
  const { isPrimaryOwner } = await import("@/lib/auth/permissions");
  if (!(await isPrimaryOwner(actor.id))) throw new Error("Only Tabitha decides held documents.");
  const d = await prisma.document.findUniqueOrThrow({ where: { id: documentId }, select: { id: true, clientId: true, title: true, ownershipHold: true } });
  const hold = d.ownershipHold as { visibilityBefore?: "STAFF_ONLY" | "PUBLISHED"; staffMessages?: string[] } | null;
  if (!hold) return { message: "It isn't held." };
  if (decision.moveTo) {
    const to = await prisma.client.findUniqueOrThrow({ where: { id: decision.moveTo }, select: { id: true, displayName: true, businessName: true } });
    const r = await relocateDocument(actor, documentId, { id: to.id, label: to.businessName || to.displayName }, { proof: ["Tabitha's decision"], by: "Tabitha" });
    return { message: r.message };
  }
  await prisma.$transaction(async (tx) => {
    for (const m of hold.staffMessages ?? []) await tx.message.update({ where: { id: m }, data: { attachments: { connect: { id: d.id } } } }).catch(() => {});
    await tx.document.update({ where: { id: d.id }, data: { visibility: hold.visibilityBefore ?? "STAFF_ONLY", ownershipHold: Prisma.DbNull, ownershipCheckedAt: new Date() } });
  });
  await audit(prisma, { actorId: actor.id, action: "document.ownership_kept", entityType: "Document", entityId: d.id, clientId: d.clientId, details: { restoredVisibility: hold.visibilityBefore ?? "STAFF_ONLY" } });
  return { message: `“${d.title}” stays with this client; its earlier access is back.` };
}

/** Publishes a staff upload that was marked "publish" once its check cleared it; a moved or held one stays staff-only. */
async function releaseIfCleared(documentId: string, verdict: string) {
  if (verdict === "MOVE" || verdict === "HOLD") {
    await prisma.document.updateMany({ where: { id: documentId, publishAfterCheck: true }, data: { publishAfterCheck: false } });
    return false;
  }
  const r = await prisma.document.updateMany({ where: { id: documentId, publishAfterCheck: true, deletedAt: null }, data: { visibility: "PUBLISHED", publishedAt: new Date(), publishAfterCheck: false } });
  return r.count > 0;
}

/**
 * Runs during every upload (staff and portal), before any client can see the file: a quick read of
 * the document against the identifiers on file. Never blocks the upload: if the check itself fails,
 * the file simply stays staff-only and the scheduled sweep checks and releases it.
 */
export async function checkUploadNow(actor: Actor | null, documentId: string) {
  try {
    const { ownerActor } = await import("./coetha-decisions");
    const who = actor ?? (await ownerActor());
    if (!who) return;
    const r = await checkAndCorrect(who, documentId, "Coetha (standing authorization, checked on upload)");
    await releaseIfCleared(documentId, r.verdict);
  } catch { /* stays staff-only; the sweep retries */ }
}
