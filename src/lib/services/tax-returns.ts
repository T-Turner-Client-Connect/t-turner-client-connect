import "server-only";
import { prisma } from "@/lib/prisma";
import { audit } from "@/lib/audit";
import { ForbiddenError, type Actor } from "@/lib/auth/actor";
import type { PortalActor } from "@/lib/portal/session";
import { requireClientAccess } from "@/lib/portal/access";
import { storage } from "@/lib/storage";
import { sendEmail, brandedEmailHtml } from "@/lib/email";
import { appUrl } from "@/lib/integrations";
import { BUSINESS } from "@/lib/business";
import { normalizeJurisdiction, normalizeReturnType } from "@/lib/tax/normalize";
import { ValidationError } from "./clients";
import { clientMayReceive, notifyClientUsers, readDocumentBytes, sha256Of, staffUploadDocument, storeDocumentFile } from "./documents";
import { canSendReturns, NOT_RETURN_SENDER, senderBasis } from "./return-senders";

/**
 * Accepted Return Delivery — the stage AFTER filing. Clients don't review
 * full returns before filing (that's the Tax Return Summary & Approval
 * stage). Once the IRS or state ACCEPTS a return, the accepted return PDF is
 * uploaded to the client's vault, labeled by tax year, federal/state, return
 * type and original/amended; the acceptance confirmation is kept separately
 * on the filing. Draft or unaccepted returns are never delivered as
 * completed filings. A staff upload waits for Tabitha's release; her own
 * upload can go straight to the client. The malware scan must pass first.
 */
export const RETURN_COPY_STATUS = {
  DRAFT: { label: "Uploaded — not sent yet", tone: "gray" },
  AWAITING_REVIEW: { label: "Waiting for Tabitha's release", tone: "gold" },
  APPROVED: { label: "Sent to client", tone: "green" },
} as const;

/** Filing status shown beside a return — from the filing record, never from the PDF. */
export function filingLabel(status: string | null | undefined) {
  if (status === "ACCEPTED") return { label: "Accepted Return", tone: "green" as const };
  if (status === "REJECTED") return { label: "Rejected", tone: "red" as const };
  if (status === "SUBMITTED" || status === "PENDING_ACKNOWLEDGMENT") return { label: "Submitted — awaiting acknowledgment", tone: "navy" as const };
  return null;
}

/** Staff-side filing status: always shown, "Not filed" until the filing record says otherwise. */
export function staffFilingLabel(status: string | null | undefined, amended?: boolean) {
  const l = filingLabel(status);
  if (l) return amended ? { ...l, label: `${l.label} (amended)` } : l;
  return { label: amended ? "Amended — not filed yet" : "Not filed", tone: "gray" as const };
}

export type ReturnFields = { clientId: string; taxYear: number; returnType: string; jurisdiction: string; filingType: "ORIGINAL" | "AMENDED" };

function checkFields(f: Partial<ReturnFields>) {
  const thisYear = new Date().getFullYear();
  if (!f.clientId) throw new ValidationError("Choose the client or business.");
  if (!Number.isInteger(f.taxYear) || f.taxYear! < 2000 || f.taxYear! > thisYear) throw new ValidationError("Choose the tax year of the return.");
  // May be empty: then the only filing for that year and jurisdiction is used (see fileReturn).
  const returnType = normalizeReturnType(f.returnType) ?? "";
  const jurisdiction = normalizeJurisdiction(f.jurisdiction ?? "");
  if (!jurisdiction) throw new ValidationError("Choose Federal or the state.");
  if (f.filingType !== "ORIGINAL" && f.filingType !== "AMENDED") throw new ValidationError("Choose original or amended.");
  return { clientId: f.clientId, taxYear: f.taxYear!, returnType, jurisdiction, filingType: f.filingType };
}

const docTypeFor = (f: { jurisdiction: string; filingType: string }) => (f.filingType === "AMENDED" ? "AMENDED_RETURN" : f.jurisdiction === "FEDERAL" ? "FEDERAL_RETURN" : "STATE_RETURN");

/** One return into a client's file: staff-only Draft, linked to its filing record; a later copy becomes a new version. */
export async function fileReturn(actor: Actor, input: ReturnFields & { bytes: Uint8Array; originalName: string }) {
  const f = checkFields(input);
  const client = await prisma.client.findUnique({ where: { id: f.clientId } });
  if (!client || client.archivedAt) throw new ValidationError("Client not found.");
  // A return type that differs from the filing's (40 vs 1040), or left empty, still finds the one filing for that year and jurisdiction.
  const { findFilingFor } = await import("./tax");
  const filing = await findFilingFor(f);
  if (!filing && !f.returnType) throw new ValidationError("Enter the return type (for example 1040, 1120-S, 1065, 990, or the state form).");
  if (filing) f.returnType = filing.returnType;
  // Only accepted returns are delivered as completed filings.
  if (!filing || filing.filingStatus !== "ACCEPTED") {
    const where = `${f.taxYear} ${f.returnType} ${f.jurisdiction === "FEDERAL" ? "federal" : f.jurisdiction}${f.filingType === "AMENDED" ? " amended" : ""} return`;
    throw new ValidationError(
      filing
        ? `The ${where} hasn't been accepted yet (it's ${filing.filingStatus.toLowerCase().replace(/_/g, " ")}). Upload the return after the IRS or state accepts it, and record the acceptance first.`
        : `There's no filing record for the ${where}. Record the filing and its acceptance first, then upload the accepted return.`,
    );
  }
  const previous = await prisma.document.findFirst({ where: { filingId: filing.id, filingDocType: "RETURN", deletedAt: null, supersededAt: null }, orderBy: { createdAt: "desc" } });
  // The same file can't be filed twice for a client (checked by content, not name) — except one
  // combined federal + state PDF, which is the return for each filing of that client and year.
  const same = await prisma.document.findMany({ where: { clientId: f.clientId, deletedAt: null, file: { sha256: sha256Of(input.bytes) } }, select: { filingId: true, filingDocType: true, year: true } });
  const combined = same.length > 0 && same.every((d) => d.filingDocType === "RETURN" && d.year === f.taxYear && d.filingId !== filing.id);
  const doc = await staffUploadDocument(actor, {
    returnCheck: { jurisdiction: f.jurisdiction, filingType: f.filingType, returnType: f.returnType },
    duplicateChecked: combined, clientId: f.clientId, category: "TAXES", title: `${f.taxYear} ${f.returnType} — ${f.jurisdiction === "FEDERAL" ? "Federal" : f.jurisdiction}${f.filingType === "AMENDED" ? " (amended)" : ""}`, year: f.taxYear, visibility: "STAFF_ONLY", docType: docTypeFor(f), bytes: input.bytes, originalName: input.originalName });
  const version = (previous?.version ?? (previous ? 1 : 0)) + 1;
  await prisma.document.update({ where: { id: doc.id }, data: { filingId: filing.id, filingDocType: "RETURN", reviewStatus: "DRAFT", version, replacesId: previous?.id ?? null } });
  await audit(prisma, { actorId: actor.id, action: "tax.return_filed", entityType: "Document", entityId: doc.id, clientId: f.clientId, details: { ...f, version, replaces: previous?.id ?? null } });
  return prisma.document.findUniqueOrThrow({ where: { id: doc.id } });
}

// --- Bulk upload and review queue -------------------------------------------------

const words = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").split(" ").filter((w) => w.length >= 3 && !["llc", "inc", "corp", "the", "and", "pdf", "return", "tax"].includes(w));

/** A suggestion from the file name only — never applied without staff confirmation. */
export async function suggestMatch(originalName: string) {
  const year = /(?:^|\D)(20\d{2})(?:\D|$)/.exec(originalName)?.[1];
  const type = /(1040-?(?:SR|X)?|1120-?S|1120|1065|990-?(?:EZ|N|PF)?|1041)/i.exec(originalName)?.[1]?.toUpperCase();
  const name = words(originalName.replace(/\.[^.]+$/, ""));
  const clients = await prisma.client.findMany({ where: { archivedAt: null }, select: { id: true, displayName: true, businessName: true } });
  const hits = clients.filter((c) => {
    const w = words(c.businessName || c.displayName);
    return w.length > 0 && w.every((x) => name.includes(x));
  });
  return {
    suggestedYear: year ? Number(year) : null,
    suggestedType: type ?? null,
    // Only a single, unambiguous name match is suggested.
    suggestedClientId: hits.length === 1 ? hits[0].id : null,
    matchReason: hits.length === 1 ? `File name contains “${hits[0].businessName || hits[0].displayName}”` : hits.length > 1 ? `Ambiguous: ${hits.length} clients match the file name` : "No client name found in the file name",
  };
}

export async function bulkUploadReturns(actor: Actor, files: { bytes: Uint8Array; originalName: string }[]) {
  if (!files.length) throw new ValidationError("Choose the returns to upload.");
  if (files.length > 50) throw new ValidationError("Upload up to 50 returns at a time.");
  const out = [];
  for (const f of files) {
    const stored = await storeDocumentFile(f.bytes, f.originalName, { staff: actor });
    const sha = stored.fileData.sha256 as string;
    // Same file already queued or already in a client's file: skip it, don't store a second copy.
    const dupIntake = await prisma.returnIntake.findFirst({ where: { sha256: sha, status: { not: "DISCARDED" } } });
    const dupDoc = await prisma.storedFile.findFirst({ where: { sha256: sha, kind: "CLIENT_DOCUMENT", NOT: { storageKey: stored.storageKey } } });
    if (dupIntake || dupDoc) {
      await storage.remove(stored.storageKey).catch(() => {});
      out.push({ originalName: f.originalName, duplicate: true });
      continue;
    }
    const file = await prisma.storedFile.create({ data: stored.fileData });
    const s = await suggestMatch(f.originalName);
    const intake = await prisma.returnIntake.create({ data: { fileId: file.id, originalName: file.originalName, sha256: sha, uploadedById: actor.id, ...s } });
    out.push({ originalName: f.originalName, duplicate: false, intakeId: intake.id });
  }
  await audit(prisma, { actorId: actor.id, action: "tax.returns_bulk_uploaded", entityType: "ReturnIntake", entityId: "bulk", details: { files: files.length, queued: out.filter((o) => !o.duplicate).length } });
  return out;
}

/** Staff confirm client, year, type and jurisdiction; only then is the file placed in that client's file (as a Draft). */
export async function confirmIntake(actor: Actor, intakeId: string, fields: ReturnFields) {
  const intake = await prisma.returnIntake.findUnique({ where: { id: intakeId } });
  if (!intake || intake.status !== "PENDING") throw new ValidationError("That upload is no longer waiting for review.");
  const file = await prisma.storedFile.findUniqueOrThrow({ where: { id: intake.fileId } });
  const bytes = await readDocumentBytes(file);
  if (!bytes) throw new ValidationError("The uploaded file couldn't be read. Upload it again.");
  const doc = await fileReturn(actor, { ...fields, bytes, originalName: intake.originalName });
  await prisma.returnIntake.update({ where: { id: intakeId }, data: { status: "FILED", documentId: doc.id, filedById: actor.id, filedAt: new Date() } });
  // The queued copy is no longer needed; the client's file holds its own.
  await storage.remove(file.storageKey).catch(() => {});
  await prisma.storedFile.delete({ where: { id: file.id } }).catch(() => {});
  return doc;
}

export async function discardIntake(actor: Actor, intakeId: string, reason: string) {
  const intake = await prisma.returnIntake.findUnique({ where: { id: intakeId } });
  if (!intake || intake.status !== "PENDING") throw new ValidationError("That upload is no longer waiting for review.");
  if (reason.trim().length < 3) throw new ValidationError("Say why it's being removed.");
  const file = await prisma.storedFile.findUnique({ where: { id: intake.fileId } });
  if (file) {
    await storage.remove(file.storageKey).catch(() => {});
    await prisma.storedFile.delete({ where: { id: file.id } }).catch(() => {});
  }
  await prisma.returnIntake.update({ where: { id: intakeId }, data: { status: "DISCARDED", discardedReason: reason.trim().slice(0, 200), filedById: actor.id, filedAt: new Date() } });
  await audit(prisma, { actorId: actor.id, action: "tax.return_intake_discarded", entityType: "ReturnIntake", entityId: intakeId, details: { reason: reason.trim() } });
}

// --- Review and release ------------------------------------------------------------

/** Tabitha releases several returns at once (each one checked like a single release). */
export async function releaseReturns(actor: Actor, documentIds: string[]) {
  // Each return is checked for this person and its client, like a single release.
  const done: string[] = [];
  const skipped: { id: string; reason: string }[] = [];
  for (const id of Array.from(new Set(documentIds)).slice(0, 100)) {
    try {
      await releaseReturn(actor, id);
      done.push(id);
    } catch (e) {
      skipped.push({ id, reason: e instanceof Error ? e.message : "Couldn't release" });
    }
  }
  return { done, skipped };
}

async function loadReturn(documentId: string) {
  const d = await prisma.document.findUnique({ where: { id: documentId } });
  if (!d || d.deletedAt || d.filingDocType !== "RETURN") throw new ValidationError("Return not found.");
  return d;
}

/** Nothing reaches the client as a completed filing unless its acceptance is recorded. */
async function assertAccepted(d: { filingId: string | null; clientId: string; year: number | null }) {
  if (!d.filingId) return null;
  const f = await prisma.filingRecord.findUnique({ where: { id: d.filingId }, select: { id: true, clientId: true, taxYear: true, returnType: true, jurisdiction: true, filingType: true, filingStatus: true } });
  if (!f) return null;
  // The file must belong to the same client and tax year as the filing it is sent under.
  if (f.clientId !== d.clientId || (d.year != null && d.year !== f.taxYear)) {
    throw new ValidationError("This return's client or tax year doesn't match its filing. Fix the year (or remove the file and upload it again) before sending.");
  }
  if (f.filingStatus !== "ACCEPTED") throw new ValidationError("This return's filing isn't recorded as accepted yet. It's waiting for Tabitha to confirm acceptance.");
  return f;
}

export async function submitReturnForRelease(actor: Actor, documentId: string) {
  const d = await loadReturn(documentId);
  if (d.reviewStatus !== "DRAFT") throw new ValidationError("Only a draft can be sent for review.");
  await assertAccepted(d);
  if (d.scanStatus !== "CLEAN") throw new ValidationError("This file hasn't passed the malware scan yet.");
  await prisma.document.update({ where: { id: d.id }, data: { reviewStatus: "AWAITING_REVIEW", submittedForReviewAt: new Date(), submittedForReviewById: actor.id } });
  await audit(prisma, { actorId: actor.id, action: "tax.return_submitted", entityType: "Document", entityId: d.id, clientId: d.clientId });
}

/**
 * Only Tabitha releases a return to the client. Her own uploads go straight
 * out (no second review of her own work); a staff upload waits until she
 * releases it. Releasing never changes the filing status. A newer released
 * version replaces older ones in the portal.
 */
export async function releaseReturn(actor: Actor, documentId: string, opts: { notify?: boolean; allowPendingScan?: boolean } = {}) {
  const d = await loadReturn(documentId);
  if (!(await canSendReturns(actor, d.clientId))) throw new ForbiddenError(NOT_RETURN_SENDER);
  if (d.reviewStatus !== "AWAITING_REVIEW" && d.reviewStatus !== "DRAFT") throw new ValidationError("This return was already sent to the client.");
  // Tabitha's one-step delivery may release a file whose scan is still running: the portal shows it only once the scan passes.
  const pendingOk = opts.allowPendingScan && (d.scanStatus === "NOT_SCANNED" || d.scanStatus === "PENDING");
  if (d.scanStatus !== "CLEAN" && !pendingOk) throw new ValidationError("This file hasn't passed the malware scan, so it can't be released.");
  const filing = await assertAccepted(d);
  const older = d.filingId ? await prisma.document.findMany({ where: { filingId: d.filingId, filingDocType: "RETURN", id: { not: d.id }, visibility: "PUBLISHED" } }) : [];
  await prisma.$transaction([
    prisma.document.update({ where: { id: d.id }, data: { reviewStatus: "APPROVED", approvedAt: new Date(), approvedById: actor.id, visibility: "PUBLISHED", publishedAt: new Date() } }),
    ...older.map((o) => prisma.document.update({ where: { id: o.id }, data: { visibility: "STAFF_ONLY", supersededAt: new Date() } })),
    prisma.documentAccessLog.create({ data: { documentId: d.id, action: "PUBLISH", staffUserId: actor.id } }),
  ]);
  await audit(prisma, { actorId: actor.id, action: "tax.return_released", entityType: "Document", entityId: d.id, clientId: d.clientId, details: { replaced: older.map((o) => o.id), scan: d.scanStatus, filingId: filing?.id ?? null, taxYear: filing?.taxYear ?? d.year, returnType: filing?.returnType ?? null, jurisdiction: filing?.jurisdiction ?? null, filingType: filing?.filingType ?? null, sentBy: await senderBasis(actor, d.clientId) } });
  if (opts.notify !== false && d.scanStatus === "CLEAN") await notifyClientUsers(d.clientId, "FILING_UPDATE", d.id, d.category);
}

export async function returnsQueue() {
  const [intakes, drafts] = await Promise.all([
    prisma.returnIntake.findMany({ where: { status: "PENDING" }, orderBy: { createdAt: "asc" } }),
    prisma.document.findMany({
      // Returns whose filing still waits for Tabitha to confirm acceptance are listed in that queue instead.
      where: { filingDocType: "RETURN", deletedAt: null, reviewStatus: { in: ["DRAFT", "AWAITING_REVIEW"] }, OR: [{ filingId: null }, { filing: { filingStatus: "ACCEPTED" } }] },
      include: { client: { select: { id: true, displayName: true, businessName: true } }, filing: { select: { filingStatus: true, jurisdiction: true, filingType: true, returnType: true, taxYear: true } } },
      orderBy: { createdAt: "asc" },
    }),
  ]);
  const ids = [...new Set(intakes.map((i) => i.suggestedClientId).filter(Boolean))] as string[];
  const suggested = new Map((await prisma.client.findMany({ where: { id: { in: ids } }, select: { id: true, displayName: true, businessName: true } })).map((c) => [c.id, c]));
  return { intakes: intakes.map((i) => ({ ...i, suggested: i.suggestedClientId ? suggested.get(i.suggestedClientId) ?? null : null })), drafts };
}

// --- Email My Copy -----------------------------------------------------------------

/**
 * Emails the client a secure sign-in link to the return in their portal —
 * never the file and never a public link — at the verified address on their
 * own login. The delivery result is recorded and shown.
 */
export async function emailMyCopy(user: PortalActor, clientId: string, documentId: string) {
  await requireClientAccess(user.id, clientId, "tax");
  const login = await prisma.portalUser.findUniqueOrThrow({ where: { id: user.id }, select: { email: true, emailVerifiedAt: true } });
  if (!login.emailVerifiedAt) throw new ValidationError("Verify your email address first (Account settings), so we only send to an address we've confirmed.");
  const d = await prisma.document.findFirst({ where: { id: documentId, clientId, deletedAt: null, visibility: "PUBLISHED", scanStatus: "CLEAN", category: "TAXES" } });
  if (!d || !clientMayReceive(d) || (d.filingDocType === "RETURN" && d.reviewStatus !== "APPROVED")) throw new ValidationError("That return isn't available.");
  const link = `${appUrl()}/client/taxes/filings?account=${clientId}&year=${d.year ?? ""}`;
  const lines = ["You asked for a copy of your tax return.", "For your security we don't attach returns to email. Sign in to view, download or print it."];
  const res = await sendEmail({
    to: login.email,
    subject: `Your ${d.year ?? ""} tax return is in your portal`.replace("  ", " "),
    text: `${lines.join("\n\n")}\n\n${link}\n\n${BUSINESS.displayName}`,
    html: brandedEmailHtml({ heading: "Your tax return copy", paragraphs: lines, button: { label: "Sign in to view it", url: link }, footer: BUSINESS.displayName }),
    tags: { category: "return_copy" },
  });
  await prisma.notification.create({
    data: { portalUserId: user.id, channel: "EMAIL", kind: "RETURN_COPY", status: res.ok ? "SENT" : "FAILED", statusDetail: res.ok ? `Accepted by the email provider${res.providerId ? ` (ID ${res.providerId})` : ""}` : res.detail, sentAt: res.ok ? new Date() : null, idempotencyKey: `RETURN_COPY:${documentId}:${user.id}:${Date.now()}` },
  });
  await prisma.auditLog.create({ data: { action: "tax.return_copy_emailed", entityType: "Document", entityId: d.id, clientId, details: { portalUserId: user.id, ok: res.ok } } });
  return res.ok ? { ok: true as const, message: `Sent to ${login.email}. It contains a sign-in link, not the file.` } : { ok: false as const, message: `Not sent: ${res.detail}` };
}

export async function lastCopyEmails(portalUserId: string) {
  return prisma.notification.findMany({ where: { portalUserId, kind: "RETURN_COPY" }, orderBy: { createdAt: "desc" }, take: 3 });
}
