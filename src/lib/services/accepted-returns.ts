import "server-only";
import type { Document, FilingRecord, FilingStatus, Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { audit } from "@/lib/audit";
import { ForbiddenError, type Actor } from "@/lib/auth/actor";
import { storage } from "@/lib/storage";
import { allowedCategories, effectiveGrantsFor } from "@/lib/portal/access";
import { chicagoLocalToUtc } from "@/lib/tz";
import { chicagoToday } from "@/lib/dates";
import { fmtDateTime } from "@/lib/format";
import { FILING_LABELS, normalizeJurisdiction, normalizeReturnType } from "@/lib/tax/normalize";
import { ValidationError } from "./clients";
import { isReportApprover } from "./bookkeeping-clients";
import { retentionDate, sha256Of, storeDocumentFile } from "./documents";
import { queuePortalNotification } from "./notifications";
import { correctFilingForm, findFilingFor, formCorrectionRecords, formNumberRenames } from "./tax";

/**
 * Deliver an already-accepted return — one step.
 *
 * TaxAct e-filed the return and the IRS/state accepted it. One submission:
 * creates each filing record if missing, records Submitted → Accepted at the
 * accepted date (both events in the status history), attaches the
 * acknowledgment if given, and files the return PDF as a staff-only draft
 * linked to its filing. Federal and any states go in the same submission;
 * one combined PDF can be the return for several filings of the same client
 * and year.
 *
 * Owner rules are unchanged: only Tabitha records a return as submitted or
 * accepted. When someone else submits this form, everything is saved but the
 * status is NOT changed — the filing waits in "Ready for Tabitha to confirm
 * acceptance" until she confirms (Form 8879 checkbox, plus a reason when no
 * client-approved summary exists). A filing that is already Accepted (for
 * example from the TaxAct e-file status import) takes the return directly.
 *
 * Nothing here publishes anything or messages the client: the return is a
 * staff-only draft; Tabitha's "send to client" and "notify the client" are
 * separate, opt-in choices (email only, never text).
 *
 * Re-running the same submission is safe: existing filings, acknowledgments
 * and the same return file are reused, and an accepted filing is not
 * re-recorded.
 */

import { coverLabel, DEFAULT_VERIFICATION, DRAFT_SUMMARY_REASON } from "@/lib/tax/accepted";
export { CLOSE_DRAFT_LABEL, DEFAULT_VERIFICATION, DRAFT_SUMMARY_REASON, PRESET_OVERRIDE_REASON } from "@/lib/tax/accepted";
/** FilingStatusEvent.field for the "Ready for Tabitha to confirm acceptance" item (REQUESTED → CONFIRMED | WITHDRAWN). */
export const OWNER_CONFIRM = "OWNER_CONFIRM";

type FileIn = { bytes: Uint8Array; originalName: string };
export type AcceptedFilingInput = {
  jurisdiction: string;
  returnType: string;
  /** "YYYY-MM-DD" (office calendar day), "YYYY-MM-DDTHH:mm" (office time) or an instant. */
  acceptedOn?: string | Date | null;
  submissionId?: string | null;
  /** A separate PDF for this return; otherwise the combined PDF is used. */
  returnFile?: FileIn | null;
  ackFile?: FileIn | null;
};
export type OwnerConfirmation = { form8879Confirmed: boolean; overrideReason?: string | null; /** A pre-2026 original return being filed now (late): the e-file authorization rules apply. */ filingNow?: boolean };
export type DeliverInput = {
  clientId: string;
  taxYear: number;
  filingType: "ORIGINAL" | "AMENDED";
  filings: AcceptedFilingInput[];
  /** One PDF covering several (or all) of the filings above. */
  combinedReturn?: FileIn | null;
  verificationNote?: string | null;
  owner?: OwnerConfirmation;
  /** The return PDF is already attached to this filing as its acknowledgment: re-label that document as the return. */
  relabelAck?: boolean;
  /** Owner only: release the returns to the client's vault now. */
  sendToClient?: boolean;
  /** Owner only, with sendToClient: email the client that an update is in their portal (opt-in, never text). */
  notifyClient?: boolean;
  /** Also a text message (off by default; the client's own text settings still apply). */
  notifyText?: boolean;
  /** Close a never-sent draft summary for this year (filed before Client Connect approvals). */
  closeDraftSummary?: boolean;
};


/** Draft summaries for this client/year that were never sent, signed or approved (the only ones ever closed here). */
export async function unsentDraftSummaries(clientId: string, taxYear: number, filingType: string) {
  const all = await prisma.taxReturnSummary.findMany({ where: { clientId, taxYear, filingType }, include: { signatures: true } });
  // Any version that reached the client keeps the whole year out of this shortcut.
  if (all.some((s) => s.sentAt || s.approvedAt || s.signatures.length || !["DRAFT", "SUPERSEDED", "WITHDRAWN"].includes(s.status))) return [];
  return all.filter((s) => s.status === "DRAFT");
}

export type DeliveryResult = {
  filingId: string;
  jurisdiction: string;
  returnType: string;
  documentId: string;
  outcome: "accepted" | "already_accepted" | "awaiting_owner";
  sent: boolean;
};

const label = (f: { taxYear: number; returnType: string; jurisdiction: string; filingType: string }) =>
  `${f.taxYear} ${f.jurisdiction === "FEDERAL" ? "federal" : f.jurisdiction} ${f.returnType}${f.filingType === "AMENDED" ? " amended" : ""}`;
export const returnDocType = (f: { jurisdiction: string; filingType: string }) => (f.filingType === "AMENDED" ? "AMENDED_RETURN" : f.jurisdiction === "FEDERAL" ? "FEDERAL_RETURN" : "STATE_RETURN");
export const returnTitle = (f: { taxYear: number; returnType: string; jurisdiction: string; filingType: string }) =>
  `${f.taxYear} ${f.returnType} — ${f.jurisdiction === "FEDERAL" ? "Federal" : f.jurisdiction}${f.filingType === "AMENDED" ? " (amended)" : ""}`;
const officeDay = (d: Date) => d.toLocaleDateString("en-CA", { timeZone: "America/Chicago" });

/**
 * The accepted date as an instant. A calendar day means noon office time
 * that day. Refused: a future day, or a day before the last recorded status.
 * The same day as the last status is fine (placed just after it).
 */
export function resolveAcceptedAt(value: string | Date | null | undefined, last: { statusAsOf: Date | null; filingStatus: FilingStatus } | null, what: string, now = new Date()): Date {
  let at: Date | null = null;
  if (value instanceof Date) at = Number.isNaN(value.getTime()) ? null : value;
  else if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value.trim())) at = chicagoLocalToUtc(`${value.trim()}T12:00`);
  else if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value.trim())) at = chicagoLocalToUtc(value.trim());
  if (!at) throw new ValidationError(`Enter the date the IRS or state accepted the ${what} return.`);
  if (officeDay(at) > chicagoToday(now)) throw new ValidationError(`The accepted date for the ${what} return can't be in the future.`);
  if (at > now) at = now;
  if (last?.statusAsOf && at <= last.statusAsOf) {
    if (officeDay(at) < officeDay(last.statusAsOf)) {
      throw new ValidationError(`The accepted date for the ${what} return is earlier than its last recorded status (${FILING_LABELS[last.filingStatus]}, ${fmtDateTime(last.statusAsOf)}). It must be after ${fmtDateTime(last.statusAsOf)}.`);
    }
    at = new Date(Math.min(last.statusAsOf.getTime() + 1000, now.getTime()));
  }
  return at;
}

type Gate = { note: string | null; details: Record<string, unknown> };

/** The owner gate for leaving "Not submitted" — exactly the rules in setFilingStatusByStaff. */
async function ownerGate(actor: Actor, f: { clientId: string; taxYear: number; returnType: string; jurisdiction: string; filingType: string; method: string; filingStatus: FilingStatus }, owner: OwnerConfirmation | undefined): Promise<Gate> {
  const { summaryRequirement, assertOwnerMaySubmit } = await import("./tax-summary");
  if (f.filingStatus !== "NOT_SUBMITTED" || f.filingType === "EXTENSION") return { note: null, details: {} };
  if (!(await summaryRequirement(f)).required) return { note: null, details: {} };
  const g = await assertOwnerMaySubmit(actor, f, owner ?? { form8879Confirmed: false });
  return {
    note: "historical" in g && g.historical ? g.override : g.summaryId ? "Owner filing: client-approved summary on file; Form 8879/state authorization confirmed." : `Owner filing WITHOUT an approved summary: ${g.override}`,
    details: { approvedSummaryId: g.summaryId, overrideReason: g.override, form8879Confirmed: !!owner?.form8879Confirmed },
  };
}

/** Records Submitted (when not yet submitted) and then Accepted, both in the status history. Owner only — callers check. */
async function recordAcceptance(
  tx: Prisma.TransactionClient,
  actor: Actor,
  f: FilingRecord,
  a: { acceptedAt: Date; submissionId: string | null; evidenceDocumentId: string | null; note: string | null; gate: Gate },
) {
  let from: FilingStatus = f.filingStatus;
  if (from === "NOT_SUBMITTED" || from === "REJECTED") {
    await tx.filingStatusEvent.create({
      data: { filingId: f.id, field: "FILING", fromValue: from, toValue: "SUBMITTED", source: "STAFF", actorId: actor.id, verificationNote: [a.note ? "E-filed in TaxAct" : null, a.gate.note].filter(Boolean).join(" · ") || null, eventAt: a.acceptedAt },
    });
    await audit(tx, { actorId: actor.id, action: "filing.status_staff_update", entityType: "FilingRecord", entityId: f.id, clientId: f.clientId, details: { from, to: "SUBMITTED", oneStep: true, ...a.gate.details } as Prisma.InputJsonValue });
    from = "SUBMITTED";
  }
  await tx.filingStatusEvent.create({
    data: { filingId: f.id, field: "FILING", fromValue: from, toValue: "ACCEPTED", source: "STAFF", actorId: actor.id, evidenceDocumentId: a.evidenceDocumentId, verificationNote: a.note, eventAt: a.acceptedAt },
  });
  await tx.filingRecord.update({
    where: { id: f.id },
    data: {
      filingStatus: "ACCEPTED",
      statusSource: "STAFF",
      statusAsOf: a.acceptedAt,
      lastVerifiedAt: new Date(),
      lastVerifiedById: actor.id,
      submittedAt: f.submittedAt ?? a.acceptedAt,
      acknowledgedAt: a.acceptedAt,
      // A Submission ID already on file is kept; only Tabitha may replace it with a different one.
      filingReference: f.filingReference && a.submissionId && a.submissionId !== f.filingReference && !(await isReportApprover(actor)) ? f.filingReference : a.submissionId || f.filingReference,
    },
  });
  await audit(tx, { actorId: actor.id, action: "filing.status_staff_update", entityType: "FilingRecord", entityId: f.id, clientId: f.clientId, details: { from, to: "ACCEPTED", oneStep: true, submissionId: a.submissionId } });
}

type Plan = {
  jurisdiction: string;
  returnType: string;
  what: string;
  filing: FilingRecord | null;
  alreadyAccepted: boolean;
  acceptedAt: Date | null;
  submissionId: string | null;
  gate: Gate;
  returnFile: FileIn;
  ackFile: FileIn | null;
  // Decided before anything is written:
  reuseReturn: Document | null;
  relabel: Document | null;
  reuseAck: Document | null;
  storedReturn?: Awaited<ReturnType<typeof storeDocumentFile>>;
  storedAck?: Awaited<ReturnType<typeof storeDocumentFile>>;
};

async function docsWithSha(clientId: string, sha: string) {
  return prisma.document.findMany({ where: { clientId, deletedAt: null, file: { sha256: sha } }, orderBy: { createdAt: "desc" } });
}

const dupMessage = (d: { title: string; year: number | null }) => `This file is already saved${d.year ? ` under ${d.year}` : ""} as “${d.title}”, so it wasn't added again.`;

/** Creates a staff-only tax document row (file already stored and scanned). */
async function createDocRow(tx: Prisma.TransactionClient, actor: Actor, clientId: string, stored: Awaited<ReturnType<typeof storeDocumentFile>>, data: { title: string; year: number; retainUntil: Date | null; docType?: string | null }) {
  const file = await tx.storedFile.create({ data: stored.fileData });
  const doc = await tx.document.create({
    data: { clientId, category: "TAXES", title: data.title.slice(0, 200), year: data.year, visibility: "STAFF_ONLY", docType: data.docType ?? null, fileId: file.id, scanStatus: stored.scan, ...stored.scanMeta, uploadedByStaffId: actor.id, retainUntil: data.retainUntil },
  });
  await tx.documentAccessLog.create({ data: { documentId: doc.id, action: "UPLOAD", staffUserId: actor.id } });
  await audit(tx, { actorId: actor.id, action: "document.uploaded", entityType: "Document", entityId: doc.id, clientId, details: { category: "TAXES", visibility: "STAFF_ONLY" } });
  return doc;
}

/** Title of a document converted from an acknowledgment: "2025 Federal return" / "2025 AL return". */
export const convertedTitle = (f: { taxYear: number; jurisdiction: string; filingType: string }) => `${f.taxYear} ${f.jurisdiction === "FEDERAL" ? "Federal" : f.jurisdiction} return${f.filingType === "AMENDED" ? " (amended)" : ""}`;

/**
 * Makes `doc` the filing's current return copy (a later copy becomes a new
 * version). A document the client can already see stays published only when
 * Tabitha does it and the filing is recorded Accepted (it becomes her released
 * return); otherwise it's a staff-only draft — never a return shown before acceptance.
 */
async function asReturn(tx: Prisma.TransactionClient, filing: FilingRecord, doc: Document, opts: { actor?: Actor; owner?: boolean; title?: string } = {}) {
  const previous = await tx.document.findFirst({ where: { filingId: filing.id, filingDocType: "RETURN", deletedAt: null, supersededAt: null, id: { not: doc.id }, replacedBy: null }, orderBy: { createdAt: "desc" } });
  const version = (previous?.version ?? (previous ? 1 : 0)) + 1;
  const keep = doc.visibility === "PUBLISHED" && !!opts.owner && filing.filingStatus === "ACCEPTED";
  const updated = await tx.document.update({
    where: { id: doc.id },
    data: {
      filingId: filing.id,
      filingDocType: "RETURN",
      docType: returnDocType(filing),
      title: opts.title ?? returnTitle(filing),
      year: filing.taxYear,
      category: "TAXES",
      version,
      replacesId: previous?.id ?? null,
      ...(keep
        ? { reviewStatus: "APPROVED", approvedAt: new Date(), approvedById: opts.actor!.id }
        : { reviewStatus: "DRAFT", visibility: "STAFF_ONLY", publishedAt: null, approvedAt: null, approvedById: null }),
    },
  });
  if (keep) {
    // Like a release: the newest delivered version replaces older ones in the portal.
    await tx.document.updateMany({ where: { filingId: filing.id, filingDocType: "RETURN", id: { not: doc.id }, visibility: "PUBLISHED" }, data: { visibility: "STAFF_ONLY", supersededAt: new Date() } });
  }
  return updated;
}


export async function deliverAcceptedReturn(actor: Actor, input: DeliverInput): Promise<{ results: DeliveryResult[]; owner: boolean }> {
  const thisYear = new Date().getFullYear();
  const client = await prisma.client.findUnique({ where: { id: input.clientId } });
  if (!client || client.archivedAt) throw new ValidationError("Client not found.");
  if (!Number.isInteger(input.taxYear) || input.taxYear < 2000 || input.taxYear > thisYear) throw new ValidationError("Choose the tax year of the return.");
  if (input.filingType !== "ORIGINAL" && input.filingType !== "AMENDED") throw new ValidationError("Choose original or amended.");
  if (!input.filings.length) throw new ValidationError("Tick Federal and/or the state returns being delivered.");
  if (input.filings.length > 10) throw new ValidationError("Deliver up to 10 returns at a time.");
  // Tabitha, an Admin or the client's assigned preparer records acceptance and sends in one step.
  const { canSendReturns } = await import("./return-senders");
  const owner = await canSendReturns(actor, input.clientId);
  const note = input.verificationNote?.trim().slice(0, 300) || null;

  const seen = new Set<string>();
  const plans: Plan[] = [];
  for (const e of input.filings) {
    const jurisdiction = normalizeJurisdiction(e.jurisdiction);
    if (!jurisdiction) throw new ValidationError("Choose Federal or the state for each return.");
    // The form type may be left empty when exactly one filing exists for that year and jurisdiction.
    const typed = normalizeReturnType(e.returnType);
    const only = typed ? null : await findFilingFor({ clientId: input.clientId, taxYear: input.taxYear, returnType: "", jurisdiction, filingType: input.filingType });
    const returnType = typed ?? only?.returnType ?? null;
    if (!returnType) throw new ValidationError(`Enter the return type for the ${jurisdiction === "FEDERAL" ? "federal" : jurisdiction} return (for example 1040, or 40 for Alabama).`);
    if (seen.has(jurisdiction)) throw new ValidationError(`${jurisdiction === "FEDERAL" ? "Federal" : jurisdiction} is listed twice.`);
    seen.add(jurisdiction);
    const key = { clientId: input.clientId, taxYear: input.taxYear, returnType, jurisdiction, filingType: input.filingType };
    const what = label(key);
    // Shown as entered: a state filing saved earlier as "1040" is the same filing as "40" here.
    const filing = await findFilingFor(key);
    const alreadyAccepted = filing?.filingStatus === "ACCEPTED";
    const returnFile = e.returnFile?.bytes.length ? e.returnFile : input.combinedReturn?.bytes.length ? input.combinedReturn : null;
    if (!returnFile) throw new ValidationError(`Choose the return PDF for the ${what} return (or one combined PDF).`);
    // The return itself is read and matched to this client, year and form before anything is saved.
    await (await import("./return-gate")).checkReturnUpload(actor, { clientId: input.clientId, taxYear: input.taxYear, jurisdiction, filingType: input.filingType, returnType }, returnFile);
    const ackFile = e.ackFile?.bytes.length ? e.ackFile : null;
    let acceptedAt: Date | null = null;
    let gate: Gate = { note: null, details: {} };
    if (!alreadyAccepted) {
      acceptedAt = resolveAcceptedAt(e.acceptedOn ?? null, filing, what);
      if (!ackFile && !note) throw new ValidationError(`To record the ${what} return as accepted, attach the acknowledgment or say how you verified it (e.g. “${DEFAULT_VERIFICATION}”).`);
      if (filing?.method === "PAPER" && !ackFile) throw new ValidationError(`The ${what} return was paper filed — attach the agency notice as the acknowledgment.`);
      // Only the owner changes the status; for her the gate is checked up front, before anything is saved.
      if (owner) gate = await ownerGate(actor, { ...key, method: filing?.method ?? "ELECTRONIC", filingStatus: filing?.filingStatus ?? "NOT_SUBMITTED" }, input.owner);
    }
    plans.push({ jurisdiction, returnType, what, filing, alreadyAccepted, acceptedAt, submissionId: e.submissionId?.trim().slice(0, 80) || null, gate, returnFile, ackFile, reuseReturn: null, relabel: null, reuseAck: null });
  }

  // Duplicate handling, decided before anything is written.
  for (const p of plans) {
    const rSha = sha256Of(p.returnFile.bytes);
    if (p.ackFile && sha256Of(p.ackFile.bytes) === rSha) throw new ValidationError(`The return PDF and the acknowledgment for the ${p.what} return are the same file. Choose the acknowledgment separately, or leave it empty.`);
    const same = await docsWithSha(input.clientId, rSha);
    const here = p.filing ? same.filter((d) => d.filingId === p.filing!.id) : [];
    const sameReturn = here.find((d) => d.filingDocType === "RETURN" && !d.supersededAt);
    const asAck = here.find((d) => d.filingDocType && d.filingDocType !== "RETURN");
    const ackElsewhere = same.find((d) => d.filingDocType === "OFFICIAL_ACK" && d.year === input.taxYear && !plans.some((q) => q.filing?.id && q.filing.id === d.filingId));
    if (sameReturn) p.reuseReturn = sameReturn;
    else if (asAck) {
      if (!input.relabelAck) {
        throw new ValidationError(`This return PDF is already saved on the ${p.what} filing as its acknowledgment (“${asAck.title}”). Click “Use this file as the return copy” next to it, or tick “Re-label it as the return” and submit again — nothing is uploaded twice.`);
      }
      if (asAck.visibility === "PUBLISHED" && !owner) throw new ForbiddenError("That document is already published to the client. Only Tabitha can re-label it.");
      p.relabel = asAck;
    } else {
      // A combined federal + state PDF already delivered for another filing of this client and year is fine,
      // and so is the prepared return PDF kept (staff only) on this year's summary.
      const prepared = new Set((await prisma.taxReturnSummary.findMany({ where: { clientId: input.clientId, taxYear: input.taxYear, returnDocumentId: { in: same.map((d) => d.id) } }, select: { returnDocumentId: true } })).map((x) => x.returnDocumentId));
      // An acknowledgment that another return in this same submission re-labels is the combined PDF too.
      const relabeledHere = (d: Document) => !!input.relabelAck && d.filingDocType === "OFFICIAL_ACK" && d.year === input.taxYear && plans.some((q) => q.filing?.id && q.filing.id === d.filingId);
      if (ackElsewhere && !relabeledHere(ackElsewhere)) {
        throw new ValidationError(`This return PDF is already saved as an acknowledgment (“${ackElsewhere.title}”). Click “Use this file as the return copy” next to it — it's converted in place, nothing is uploaded twice.`);
      }
      const blocking = same.find((d) => !(d.filingDocType === "RETURN" && d.year === input.taxYear) && !(prepared.has(d.id) && d.visibility === "STAFF_ONLY" && !d.filingDocType) && !relabeledHere(d));
      if (blocking) throw new ValidationError(dupMessage(blocking));
    }
    if (p.ackFile) {
      const aSha = sha256Of(p.ackFile.bytes);
      const sameAck = await docsWithSha(input.clientId, aSha);
      const ackHere = p.filing ? sameAck.find((d) => d.filingId === p.filing!.id && d.filingDocType === "OFFICIAL_ACK") : undefined;
      if (ackHere) p.reuseAck = ackHere;
      else if (sameAck.length) throw new ValidationError(dupMessage(sameAck[0]));
    }
  }

  // Store and scan the files first (outside the database transaction); removed again if anything fails.
  const keys: string[] = [];
  try {
    for (const p of plans) {
      if (!p.reuseReturn && !p.relabel) {
        p.storedReturn = await storeDocumentFile(p.returnFile.bytes, p.returnFile.originalName, { staff: actor });
        keys.push(p.storedReturn.storageKey);
      }
      if (p.ackFile && !p.reuseAck) {
        p.storedAck = await storeDocumentFile(p.ackFile.bytes, p.ackFile.originalName, { staff: actor });
        keys.push(p.storedAck.storageKey);
      }
    }
    const retainUntil = await retentionDate("TAXES");
    const drafts = input.closeDraftSummary ? await unsentDraftSummaries(input.clientId, input.taxYear, input.filingType) : [];
    const results = await prisma.$transaction(
      async (tx) => {
        const out: DeliveryResult[] = [];
        for (const p of plans) {
          const key = { clientId: input.clientId, taxYear: input.taxYear, returnType: p.returnType, jurisdiction: p.jurisdiction, filingType: input.filingType };
          let filing = p.filing ? await tx.filingRecord.findUnique({ where: { id: p.filing.id } }) : await tx.filingRecord.findUnique({ where: { clientId_taxYear_returnType_jurisdiction_filingType: key } });
          if ((filing?.filingStatus ?? null) !== (p.filing?.filingStatus ?? null) || (filing?.statusAsOf?.getTime() ?? 0) !== (p.filing?.statusAsOf?.getTime() ?? 0)) {
            throw new ValidationError(`The ${p.what} filing changed while you were saving. Nothing was saved — please submit again.`);
          }
          if (!filing) {
            filing = await tx.filingRecord.create({ data: { ...key, method: "ELECTRONIC", prepStatus: "READY_TO_FILE" } });
            await audit(tx, { actorId: actor.id, action: "filing.created", entityType: "FilingRecord", entityId: filing.id, clientId: input.clientId, details: { ...key, oneStep: true } });
          }
          // Acknowledgment, kept separately on the filing.
          let ackId: string | null = p.reuseAck?.id ?? null;
          if (p.storedAck) {
            const a = await createDocRow(tx, actor, input.clientId, p.storedAck, { title: `${returnTitle(filing)} — acceptance confirmation`, year: input.taxYear, retainUntil });
            await tx.document.update({ where: { id: a.id }, data: { filingId: filing.id, filingDocType: "OFFICIAL_ACK" } });
            await audit(tx, { actorId: actor.id, action: "filing.document_attached", entityType: "FilingRecord", entityId: filing.id, clientId: input.clientId, details: { documentId: a.id, docType: "OFFICIAL_ACK" } });
            ackId = a.id;
          }
          let outcome: DeliveryResult["outcome"] = "already_accepted";
          let requestId: string | null = null;
          if (!p.alreadyAccepted && owner) {
            await recordAcceptance(tx, actor, filing, { acceptedAt: p.acceptedAt!, submissionId: p.submissionId, evidenceDocumentId: ackId, note, gate: p.gate });
            await closeRequest(tx, actor, filing.id, "CONFIRMED");
            outcome = "accepted";
          } else if (!p.alreadyAccepted) {
            // Not the owner: saved for Tabitha to confirm; nothing is marked submitted or accepted.
            const pending = await latestRequest(tx, filing.id);
            const same = pending?.toValue === "REQUESTED" && pending.eventAt.getTime() === p.acceptedAt!.getTime() && pending.evidenceDocumentId === ackId && pending.verificationNote === note;
            if (!same) {
              const ev = await tx.filingStatusEvent.create({
                data: { filingId: filing.id, field: OWNER_CONFIRM, fromValue: filing.filingStatus, toValue: "REQUESTED", source: "STAFF", actorId: actor.id, evidenceDocumentId: ackId, verificationNote: note, eventAt: p.acceptedAt! },
              });
              requestId = ev.id;
            }
            outcome = "awaiting_owner";
          }
          // The return (after the status, so an acknowledgment converted by Tabitha can stay published once accepted).
          filing = await tx.filingRecord.findUniqueOrThrow({ where: { id: filing.id } });
          let doc: Document;
          if (p.reuseReturn) doc = p.reuseReturn;
          else if (p.relabel) {
            doc = await asReturn(tx, filing, p.relabel, { actor, owner, title: convertedTitle(filing) });
            await audit(tx, { actorId: actor.id, action: "filing.document_relabeled", entityType: "Document", entityId: doc.id, clientId: input.clientId, details: { from: p.relabel.filingDocType, to: "RETURN", filingId: filing.id, wasPublished: p.relabel.visibility === "PUBLISHED" } });
          } else {
            // One combined PDF for several returns is titled for all of them ("2025 Federal + AL Returns").
            const covers = plans.filter((q) => q.returnFile === p.returnFile).map((q) => q.jurisdiction);
            const title = covers.length > 1 ? `${input.taxYear} ${coverLabel(covers)} ${input.filingType === "AMENDED" ? "Amended Returns" : "Returns"}` : returnTitle(filing);
            const created = await createDocRow(tx, actor, input.clientId, p.storedReturn!, { title, year: input.taxYear, retainUntil, docType: returnDocType(filing) });
            doc = await asReturn(tx, filing, created, { title });
            await audit(tx, { actorId: actor.id, action: "tax.return_filed", entityType: "Document", entityId: doc.id, clientId: input.clientId, details: { ...key, version: doc.version, replaces: doc.replacesId, oneStep: true } });
          }
          // Staff, filing already accepted: the return goes straight to Tabitha's release list.
          if (!owner && p.alreadyAccepted && doc.reviewStatus === "DRAFT") {
            doc = await tx.document.update({ where: { id: doc.id }, data: { reviewStatus: "AWAITING_REVIEW", submittedForReviewAt: new Date(), submittedForReviewById: actor.id } });
          }
          if (requestId) {
            await audit(tx, {
              actorId: actor.id,
              action: "tax.acceptance_confirmation_requested",
              entityType: "FilingStatusEvent",
              entityId: requestId,
              clientId: input.clientId,
              details: { filingId: filing.id, acceptedAt: p.acceptedAt!.toISOString(), submissionId: p.submissionId, returnDocumentId: doc.id, ackDocumentId: ackId, notifyEmail: !!input.notifyClient, notifyText: !!input.notifyText },
            });
          }
          out.push({ filingId: filing.id, jurisdiction: p.jurisdiction, returnType: p.filing?.returnType ?? p.returnType, documentId: doc.id, outcome, sent: doc.visibility === "PUBLISHED" });
        }
        for (const s of drafts) {
          const r = await tx.taxReturnSummary.updateMany({ where: { id: s.id, status: "DRAFT", sentAt: null }, data: { status: "WITHDRAWN", invalidatedAt: new Date(), invalidatedReason: DRAFT_SUMMARY_REASON } });
          if (r.count) await audit(tx, { actorId: actor.id, action: "tax.summary_withdrawn", entityType: "TaxReturnSummary", entityId: s.id, clientId: input.clientId, details: { reason: DRAFT_SUMMARY_REASON, version: s.version, oneStep: true } });
        }
        await audit(tx, { actorId: actor.id, action: "tax.accepted_return_delivered", entityType: "Client", entityId: input.clientId, clientId: input.clientId, details: { taxYear: input.taxYear, filingType: input.filingType, owner, results: out.map((r) => ({ filingId: r.filingId, documentId: r.documentId, outcome: r.outcome })) } });
        return out;
      },
      { timeout: 60_000 },
    );
    keys.length = 0; // stored files now belong to their documents
    if (owner && input.sendToClient) await sendNow(actor, input.clientId, results, channelsOf(input));
    return { results, owner };
  } finally {
    for (const k of keys) await storage.remove(k).catch(() => {});
  }
}

/** Tabitha's optional "send to client now": releases each clean draft; an email notice only when she ticks "notify". Never a text. */
const channelsOf = (x: { notifyClient?: boolean | null; notifyText?: boolean | null }) => [...(x.notifyClient ? (["EMAIL"] as const) : []), ...(x.notifyText ? (["SMS"] as const) : [])];

/** Queues the "your filing update is ready" notice (a sign-in link only, never the return), per the client's own settings. */
async function notifyFilingUpdate(clientId: string, refKey: string, channels: ("EMAIL" | "SMS")[]) {
  if (!channels.length) return;
  for (const g of await effectiveGrantsFor(clientId)) {
    if (!allowedCategories(g).includes("TAXES" as never)) continue;
    await queuePortalNotification(g.portalUserId, "FILING_UPDATE", refKey, channels);
  }
}

async function sendNow(actor: Actor, clientId: string, results: DeliveryResult[], channels: ("EMAIL" | "SMS")[]) {
  const { releaseReturn } = await import("./tax-returns");
  let any = false;
  for (const r of results) {
    if (r.outcome === "awaiting_owner") continue;
    const d = await prisma.document.findUnique({ where: { id: r.documentId } });
    if (!d || d.scanStatus === "INFECTED" || (d.reviewStatus !== "DRAFT" && d.reviewStatus !== "AWAITING_REVIEW")) continue;
    // Released now; the portal shows it only once the malware scan passes (the same rule as every document).
    await releaseReturn(actor, d.id, { notify: false, allowPendingScan: true });
    r.sent = true;
    if (d.scanStatus === "CLEAN") any = true;
  }
  // The notice (only what was ticked) goes only for returns the client can open right now.
  if (any) await notifyFilingUpdate(clientId, `delivered:${results.map((r) => r.documentId).join(",")}`, channels);
}

// --- "Ready for Tabitha to confirm acceptance" --------------------------------------

async function latestRequest(db: Prisma.TransactionClient | typeof prisma, filingId: string) {
  return db.filingStatusEvent.findFirst({ where: { filingId, field: OWNER_CONFIRM }, orderBy: [{ createdAt: "desc" }, { id: "desc" }] });
}

async function closeRequest(tx: Prisma.TransactionClient, actor: Actor, filingId: string, to: "CONFIRMED" | "WITHDRAWN", note?: string | null) {
  const last = await latestRequest(tx, filingId);
  if (last?.toValue !== "REQUESTED") return;
  await tx.filingStatusEvent.create({ data: { filingId, field: OWNER_CONFIRM, fromValue: "REQUESTED", toValue: to, source: "STAFF", actorId: actor.id, verificationNote: note ?? null, eventAt: new Date() } });
}

async function requestDetails(eventId: string) {
  const a = await prisma.auditLog.findFirst({ where: { action: "tax.acceptance_confirmation_requested", entityType: "FilingStatusEvent", entityId: eventId } });
  return (a?.details ?? {}) as { submissionId?: string | null; returnDocumentId?: string | null; ackDocumentId?: string | null; notifyEmail?: boolean; notifyText?: boolean };
}

/** Every filing waiting for Tabitha to confirm acceptance (optionally for one client), oldest first. */
export async function pendingAcceptances(clientId?: string) {
  const events = await prisma.filingStatusEvent.findMany({
    where: { field: OWNER_CONFIRM, ...(clientId ? { filing: { clientId } } : {}) },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    include: { filing: { include: { client: { select: { id: true, displayName: true, businessName: true, clientType: true } } } } },
  });
  const latest = new Map<string, (typeof events)[number]>();
  for (const e of events) if (!latest.has(e.filingId)) latest.set(e.filingId, e);
  const open = [...latest.values()].filter((e) => e.toValue === "REQUESTED" && e.filing.filingStatus !== "ACCEPTED").reverse();
  const { summaryRequirement } = await import("./tax-summary");
  const names = new Map((await prisma.user.findMany({ where: { id: { in: open.map((e) => e.actorId ?? "") } }, select: { id: true, name: true } })).map((u) => [u.id, u.name]));
  return Promise.all(
    open.map(async (e) => {
      const d = await requestDetails(e.id);
      const req = await summaryRequirement(e.filing);
      return {
        requestId: e.id,
        filing: e.filing,
        client: e.filing.client,
        acceptedAt: e.eventAt,
        verificationNote: e.verificationNote,
        hasAck: !!e.evidenceDocumentId,
        submissionId: d.submissionId ?? null,
        returnDocumentId: d.returnDocumentId ?? null,
        requestedBy: names.get(e.actorId ?? "") ?? "Staff",
        requestedAt: e.createdAt,
        needsReason: req.required && !req.approved && e.filing.filingStatus === "NOT_SUBMITTED",
        gated: req.required && e.filing.filingStatus === "NOT_SUBMITTED",
      };
    }),
  );
}

/** Tabitha confirms one waiting acceptance: Submitted → Accepted at the date staff entered, under the owner gate. */
export async function confirmAcceptance(actor: Actor, filingId: string, ownerInput: OwnerConfirmation) {
  const { canSendReturns, NOT_RETURN_SENDER } = await import("./return-senders");
  const target = await prisma.filingRecord.findUnique({ where: { id: filingId }, select: { clientId: true } });
  if (!target) throw new ValidationError("Filing not found.");
  if (!(await canSendReturns(actor, target.clientId))) throw new ForbiddenError(NOT_RETURN_SENDER);
  const req = await latestRequest(prisma, filingId);
  if (req?.toValue !== "REQUESTED") throw new ValidationError("That return is no longer waiting for confirmation.");
  const f = await prisma.filingRecord.findUniqueOrThrow({ where: { id: filingId } });
  const d = await requestDetails(req.id);
  if (f.filingStatus === "ACCEPTED") {
    await prisma.$transaction(async (tx) => closeRequest(tx, actor, filingId, "CONFIRMED", "Already accepted"));
    await releaseFilingReturns(actor, filingId, d);
    return f;
  }
  const what = label(f);
  const acceptedAt = resolveAcceptedAt(req.eventAt, f, what);
  if (!req.evidenceDocumentId && !req.verificationNote) throw new ValidationError(`Attach the acknowledgment or say how the ${what} acceptance was verified.`);
  if (f.method === "PAPER" && !req.evidenceDocumentId) throw new ValidationError(`The ${what} return was paper filed — attach the agency notice first.`);
  const gate = await ownerGate(actor, f, ownerInput);
  await prisma.$transaction(async (tx) => {
    const now = await tx.filingRecord.findUniqueOrThrow({ where: { id: filingId } });
    if (now.filingStatus !== f.filingStatus || now.statusAsOf?.getTime() !== f.statusAsOf?.getTime()) throw new ValidationError("This filing changed while you were confirming. Please try again.");
    await recordAcceptance(tx, actor, now, { acceptedAt, submissionId: d.submissionId ?? null, evidenceDocumentId: req.evidenceDocumentId, note: req.verificationNote, gate });
    await closeRequest(tx, actor, filingId, "CONFIRMED");
    await audit(tx, { actorId: actor.id, action: "tax.acceptance_confirmed", entityType: "FilingRecord", entityId: filingId, clientId: f.clientId, details: { requestId: req.id, requestedById: req.actorId } });
  });
  await releaseFilingReturns(actor, filingId, d);
  return prisma.filingRecord.findUniqueOrThrow({ where: { id: filingId } });
}

/** After Tabitha confirms: the waiting return copy goes to the client, with the notice staff chose (if any). */
async function releaseFilingReturns(actor: Actor, filingId: string, d: { notifyEmail?: boolean; notifyText?: boolean }) {
  const { releaseReturn } = await import("./tax-returns");
  const docs = await prisma.document.findMany({ where: { filingId, filingDocType: "RETURN", deletedAt: null, reviewStatus: { in: ["DRAFT", "AWAITING_REVIEW"] }, scanStatus: { not: "INFECTED" } } });
  let clean = false;
  for (const doc of docs) {
    await releaseReturn(actor, doc.id, { notify: false, allowPendingScan: true });
    if (doc.scanStatus === "CLEAN") clean = true;
  }
  if (clean && docs.length) await notifyFilingUpdate(docs[0].clientId, `delivered:${docs.map((x) => x.id).join(",")}`, channelsOf({ notifyClient: d.notifyEmail, notifyText: d.notifyText }));
}

/** Several at once (each checked like a single confirmation). */
export async function confirmAcceptances(actor: Actor, filingIds: string[], ownerInput: OwnerConfirmation) {
  // Each one is checked for this person and that client, like a single confirmation.
  const done: string[] = [];
  const skipped: { id: string; reason: string }[] = [];
  for (const id of Array.from(new Set(filingIds)).slice(0, 200)) {
    try {
      await confirmAcceptance(actor, id, ownerInput);
      done.push(id);
    } catch (e) {
      skipped.push({ id, reason: e instanceof Error ? e.message : "Couldn't confirm" });
    }
  }
  return { done, skipped };
}

/** Takes a waiting item off the queue (e.g. entered for the wrong return). The return stays a staff-only draft. */
export async function withdrawAcceptanceRequest(actor: Actor, filingId: string, reason: string) {
  if (reason.trim().length < 3) throw new ValidationError("Say why it's being withdrawn.");
  const req = await latestRequest(prisma, filingId);
  if (req?.toValue !== "REQUESTED") throw new ValidationError("That return is no longer waiting for confirmation.");
  const f = await prisma.filingRecord.findUniqueOrThrow({ where: { id: filingId } });
  await prisma.$transaction(async (tx) => {
    await closeRequest(tx, actor, filingId, "WITHDRAWN", reason.trim().slice(0, 200));
    await audit(tx, { actorId: actor.id, action: "tax.acceptance_request_withdrawn", entityType: "FilingRecord", entityId: filingId, clientId: f.clientId, details: { reason: reason.trim().slice(0, 200) } });
  });
}

// --- Misfiled filing documents -------------------------------------------------------

const FILING_DOC_TYPES = ["RETURN", "OFFICIAL_ACK", "AGENCY_NOTICE", "CORRESPONDENCE"] as const;
export type FilingDocType = (typeof FILING_DOC_TYPES)[number];

async function loadFilingDoc(actor: Actor, documentId: string) {
  const d = await prisma.document.findUnique({ where: { id: documentId }, include: { filing: true } });
  if (!d || d.deletedAt || !d.filing) throw new ValidationError("Document not found on a filing.");
  // Anything the client can already see changes only with the owner.
  if (d.visibility === "PUBLISHED" && !(await isReportApprover(actor))) throw new ForbiddenError("This document is published to the client. Only Tabitha can change or remove it.");
  return d as typeof d & { filing: FilingRecord };
}

/** Re-labels a document on a filing (e.g. a return saved as the acknowledgment). Audited; a re-labeled return starts again as a staff-only draft. */
export async function relabelFilingDocument(actor: Actor, documentId: string, to: FilingDocType) {
  if (!FILING_DOC_TYPES.includes(to)) throw new ValidationError("Choose what this document is.");
  if (to === "RETURN") return convertToReturnCopy(actor, documentId);
  const d = await loadFilingDoc(actor, documentId);
  if (d.filingDocType === to) return d;
  await prisma.$transaction(async (tx) => {
    await tx.document.update({
      where: { id: d.id },
      data: { filingDocType: to, docType: to === "OFFICIAL_ACK" ? "ACCEPTANCE_NOTICE" : null, reviewStatus: null, version: null, replacesId: null, ...(d.filingDocType === "RETURN" ? { visibility: "STAFF_ONLY", publishedAt: null } : {}) },
    });
    await audit(tx, { actorId: actor.id, action: "filing.document_relabeled", entityType: "Document", entityId: d.id, clientId: d.clientId, details: { from: d.filingDocType, to, filingId: d.filingId, wasPublished: d.visibility === "PUBLISHED" } });
  });
  return prisma.document.findUniqueOrThrow({ where: { id: d.id } });
}

/**
 * "This is the return, not the acknowledgment" / "Use this file as the return
 * copy": converts the document in place — re-labeled and re-titled ("2025
 * Federal return"), linked to its filing as the return copy, audited. No
 * delete and re-upload. A published document (Tabitha only) stays published
 * when the filing is recorded Accepted; for Tabitha a staff-only one is sent
 * to the client in the same step (shown once the malware scan passes).
 * Staff conversions wait for her release as usual.
 */
export async function convertToReturnCopy(actor: Actor, documentId: string) {
  const d = await loadFilingDoc(actor, documentId);
  if (d.filingDocType === "RETURN") return d;
  const owner = await (await import("./return-senders")).canSendReturns(actor, d.clientId);
  const doc = await prisma.$transaction(async (tx) => {
    const filing = await tx.filingRecord.findUniqueOrThrow({ where: { id: d.filing.id } });
    const out = await asReturn(tx, filing, d, { actor, owner, title: convertedTitle(filing) });
    await audit(tx, {
      actorId: actor.id,
      action: "filing.document_converted_to_return",
      entityType: "Document",
      entityId: d.id,
      clientId: d.clientId,
      details: { from: d.filingDocType, fromTitle: d.title, to: "RETURN", title: out.title, filingId: filing.id, wasPublished: d.visibility === "PUBLISHED", stillPublished: out.visibility === "PUBLISHED" },
    });
    return out;
  });
  if (owner && d.filing.filingStatus === "ACCEPTED" && doc.reviewStatus === "DRAFT" && doc.scanStatus !== "INFECTED") {
    const { releaseReturn } = await import("./tax-returns");
    await releaseReturn(actor, doc.id, { notify: false, allowPendingScan: true });
  }
  return prisma.document.findUniqueOrThrow({ where: { id: doc.id } });
}

/**
 * "Accepted return PDF (client copy)" on the Record-a-filing-status form:
 * exactly fileReturn for this filing; for Tabitha it then goes straight to
 * the client (shown once the scan passes, no automatic message).
 */
export async function fileReturnForFiling(actor: Actor, filingId: string, file: FileIn) {
  const f = await prisma.filingRecord.findUniqueOrThrow({ where: { id: filingId } });
  if (f.filingStatus !== "ACCEPTED") throw new ValidationError("Upload the return copy when you record the filing as Accepted.");
  if (f.filingType === "EXTENSION") throw new ValidationError("An extension has no return copy. Attach its acceptance as the acknowledgment.");
  // The same file already saved as this filing's acknowledgment is converted, not refused.
  const same = await docsWithSha(f.clientId, sha256Of(file.bytes));
  const misfiled = same.find((d) => d.filingId === f.id && d.filingDocType && d.filingDocType !== "RETURN");
  if (misfiled) return convertToReturnCopy(actor, misfiled.id);
  const { fileReturn, releaseReturn } = await import("./tax-returns");
  const doc = await fileReturn(actor, { clientId: f.clientId, taxYear: f.taxYear, returnType: f.returnType, jurisdiction: f.jurisdiction, filingType: f.filingType as "ORIGINAL" | "AMENDED", bytes: file.bytes, originalName: file.originalName });
  if ((await (await import("./return-senders")).canSendReturns(actor, f.clientId)) && doc.scanStatus !== "INFECTED") await releaseReturn(actor, doc.id, { notify: false, allowPendingScan: true });
  return prisma.document.findUniqueOrThrow({ where: { id: doc.id } });
}

/** Removes a misfiled document from a filing: soft delete with a reason (the file is kept for the audit trail). */
export async function removeFilingDocument(actor: Actor, documentId: string, reason: string) {
  if (reason.trim().length < 3) throw new ValidationError("Say why it's being removed (e.g. “wrong file”).");
  const d = await loadFilingDoc(actor, documentId);
  if (await prisma.signatureRequest.count({ where: { OR: [{ signedDocumentId: documentId }, { auditTrailDocumentId: documentId }] } })) throw new ValidationError("Signed documents can't be removed here.");
  await prisma.$transaction([
    prisma.document.update({ where: { id: d.id }, data: { deletedAt: new Date(), deletedById: actor.id, deletionReason: reason.trim().slice(0, 500), visibility: "STAFF_ONLY" } }),
    // A newer version that replaced this one keeps working; an evidence link to it is cleared from nothing (history is kept).
    prisma.documentAccessLog.create({ data: { documentId: d.id, action: "DELETE", staffUserId: actor.id } }),
    prisma.auditLog.create({ data: { actorId: actor.id, action: "filing.document_removed", entityType: "Document", entityId: d.id, clientId: d.clientId, details: { reason: reason.trim().slice(0, 500), title: d.title, filingId: d.filingId, filingDocType: d.filingDocType, wasPublished: d.visibility === "PUBLISHED" } } }),
  ]);
}

// --- Bulk: a queued upload delivered through the same one-step path -----------------

/** Confirms a bulk-uploaded return with its accepted date(s): the same rules as the one-step form. */
export async function deliverIntake(actor: Actor, intakeId: string, input: Omit<DeliverInput, "combinedReturn">) {
  const intake = await prisma.returnIntake.findUnique({ where: { id: intakeId } });
  if (!intake || intake.status !== "PENDING") throw new ValidationError("That upload is no longer waiting for review.");
  const file = await prisma.storedFile.findUniqueOrThrow({ where: { id: intake.fileId } });
  const { readDocumentBytes } = await import("./documents");
  const bytes = await readDocumentBytes(file);
  if (!bytes) throw new ValidationError("The uploaded file couldn't be read. Upload it again.");
  const r = await deliverAcceptedReturn(actor, { ...input, combinedReturn: { bytes, originalName: intake.originalName } });
  await prisma.returnIntake.update({ where: { id: intakeId }, data: { status: "FILED", documentId: r.results[0]?.documentId ?? null, filedById: actor.id, filedAt: new Date() } });
  await storage.remove(file.storageKey).catch(() => {});
  await prisma.storedFile.delete({ where: { id: file.id } }).catch(() => {});
  return r;
}

/** What the delivery form needs to know: owner or not, client type, years with an approved summary or an unsent draft. */
export async function deliveryContext(clientId: string, actor: Actor) {
  const { summaryRequirement } = await import("./tax-summary");
  const [client, summaries, filings, owner] = await Promise.all([
    prisma.client.findUniqueOrThrow({ where: { id: clientId }, select: { clientType: true, entityType: true, state: true } }),
    prisma.taxReturnSummary.findMany({ where: { clientId }, select: { taxYear: true, filingType: true } }),
    prisma.filingRecord.findMany({ where: { clientId, filingType: { in: ["ORIGINAL", "AMENDED"] } }, select: { taxYear: true, jurisdiction: true, filingType: true, returnType: true, filingReference: true } }),
    import("./return-senders").then((m) => m.canSendReturns(actor, clientId)),
  ]);
  const keys = Array.from(new Set(summaries.map((x) => `${x.taxYear}:${x.filingType}`)));
  const approvedKeys: string[] = [];
  const draftKeys: string[] = [];
  for (const k of keys) {
    const [y, ft] = k.split(":");
    if ((await summaryRequirement({ clientId, taxYear: Number(y), returnType: "1040", jurisdiction: "FEDERAL", filingType: ft })).approved) approvedKeys.push(k);
    if ((await unsentDraftSummaries(clientId, Number(y), ft)).length) draftKeys.push(k);
  }
  const existing: Record<string, string[]> = {};
  // The Submission ID already on file (from the TaxAct import), so nobody types it again.
  const refs: Record<string, string> = {};
  for (const f of filings) {
    const k = `${f.taxYear}:${f.jurisdiction}:${f.filingType}`;
    (existing[k] ??= []).push(f.returnType);
    if (f.filingReference) refs[k] = f.filingReference;
  }
  const st = normalizeJurisdiction(client.state ?? "");
  // Enter once: the confirmed Tax Preparation case for a year fills in its forms.
  const { prepDefaults } = await import("./tax-prep");
  const prepForms: Record<string, { federal: string | null; state: string | null }> = {};
  for (const p of await prepDefaults(clientId)) prepForms[String(p.taxYear)] = { federal: p.federalForm, state: p.stateForm };
  return { owner, clientType: client.clientType as string, entityType: client.entityType, clientState: st && st !== "FEDERAL" ? st : null, approvedKeys, draftKeys, existing, refs, prepForms };
}

// --- Fixing a filing (Tabitha only) ------------------------------------------------

const describeFiling = (f: { taxYear: number; returnType: string; jurisdiction: string; filingType: string }) => `${f.taxYear} ${f.jurisdiction === "FEDERAL" ? "Federal" : f.jurisdiction} ${f.returnType} ${f.filingType.toLowerCase()}`;

/** Editing, moving onto and removing filings is Tabitha's alone (the same rule as correcting a form number). */
async function assertOwner(actor: Actor) {
  if (!(await isReportApprover(actor))) throw new ForbiddenError("Only Tabitha can change, move or remove a filing.");
}

/** A linked document's title after the filing's details change (only titles this app generated are rewritten). */
function retitle(title: string, from: FilingRecord, to: { taxYear: number; returnType: string; jurisdiction: string; filingType: string }) {
  for (const [a, b] of [[returnTitle(from), returnTitle(to)], [convertedTitle(from), convertedTitle(to)]] as const) if (title.startsWith(a)) return b + title.slice(a.length);
  return title;
}

/**
 * "Edit filing details" — the one correction control on a filing card
 * (Tabitha only): the return type (a state filing created as 1040 → 40),
 * jurisdiction, tax year or original/amended/extension.
 *
 * A change of form number alone is exactly correctFilingForm (#124): its
 * refusals, a FORM status event with the reason, a `filing.form_corrected`
 * audit entry and whole-word renaming of linked document titles. When other
 * details change too, the form-number part is recorded the same way and the
 * rest as a DETAILS event and `filing.details_corrected`, in one transaction.
 * A reason is always required, every status event is kept, and linked
 * documents are re-titled and re-labeled.
 */
export async function editFilingDetails(actor: Actor, filingId: string, input: { taxYear: number; returnType: string; jurisdiction: string; filingType: "ORIGINAL" | "AMENDED" | "EXTENSION" }, reason: string) {
  await assertOwner(actor);
  const f = await prisma.filingRecord.findUniqueOrThrow({ where: { id: filingId } });
  const returnType = normalizeReturnType(input.returnType);
  const jurisdiction = normalizeJurisdiction(input.jurisdiction);
  if (!returnType) throw new ValidationError("Enter the return type.");
  if (!jurisdiction) throw new ValidationError("Choose Federal or the state.");
  if (!Number.isInteger(input.taxYear) || input.taxYear < 2000 || input.taxYear > new Date().getFullYear()) throw new ValidationError("Choose the tax year.");
  if (!["ORIGINAL", "AMENDED", "EXTENSION"].includes(input.filingType)) throw new ValidationError("Choose original, amended or extension.");
  const next = { taxYear: input.taxYear, returnType, jurisdiction, filingType: input.filingType };
  const formChanged = returnType !== f.returnType;
  const otherChanged = next.taxYear !== f.taxYear || next.jurisdiction !== f.jurisdiction || next.filingType !== f.filingType;
  if (!formChanged && !otherChanged) throw new ValidationError(`This filing is already the ${describeFiling(f)}. Change the form number, year, jurisdiction or filing type, then save.`);

  // Form number only: #124's audited correction, unchanged.
  if (!otherChanged) {
    const formCorrection = await correctFilingForm(actor, filingId, returnType, reason);
    return { ...(await prisma.filingRecord.findUniqueOrThrow({ where: { id: filingId } })), formCorrection, detailsCorrected: false };
  }

  const why = reason.trim().slice(0, 300);
  if (why.length < 3) throw new ValidationError("Say why the filing details are being corrected.");
  const clash = await prisma.filingRecord.findUnique({ where: { clientId_taxYear_returnType_jurisdiction_filingType: { clientId: f.clientId, ...next } } });
  if (clash) throw new ValidationError(`This client already has a ${describeFiling(next)} filing. Remove one of them first (move any documents across), then correct the other.`);
  const docs = await prisma.document.findMany({ where: { filingId, deletedAt: null } });
  // The form-number part first, exactly as correctFilingForm does it; then the other details from there.
  const renames = formChanged ? formNumberRenames(docs, f.returnType, returnType) : [];
  const afterForm = { ...f, returnType };
  await prisma.$transaction(async (tx) => {
    await tx.filingRecord.update({ where: { id: filingId }, data: next });
    for (const d of docs) {
      const title = renames.find((r) => r.id === d.id)?.to ?? d.title;
      await tx.document.update({ where: { id: d.id }, data: { title: retitle(title, afterForm, next), year: next.taxYear, ...(d.filingDocType === "RETURN" ? { docType: returnDocType(next) } : {}) } });
    }
    if (formChanged) for (const write of formCorrectionRecords(tx, actor, f, { from: f.returnType, to: returnType, reason: why, renames })) await write;
    await tx.filingStatusEvent.create({ data: { filingId, field: "DETAILS", fromValue: describeFiling(afterForm), toValue: describeFiling(next), source: "STAFF", actorId: actor.id, verificationNote: why, eventAt: new Date() } });
    await audit(tx, { actorId: actor.id, action: "filing.details_corrected", entityType: "FilingRecord", entityId: filingId, clientId: f.clientId, details: { from: { taxYear: f.taxYear, returnType: f.returnType, jurisdiction: f.jurisdiction, filingType: f.filingType }, to: next, reason: why, documents: docs.map((d) => d.id), formCorrected: formChanged } });
  });
  const formCorrection = formChanged ? { from: f.returnType, to: returnType, renamed: renames.length } : undefined;
  return { ...(await prisma.filingRecord.findUniqueOrThrow({ where: { id: filingId } })), formCorrection, detailsCorrected: true };
}

/** Moves a document to another filing of the same client (e.g. before removing a filing created by mistake). */
export async function moveFilingDocument(actor: Actor, documentId: string, targetFilingId: string) {
  await assertOwner(actor);
  const d = await prisma.document.findUnique({ where: { id: documentId }, include: { filing: true } });
  if (!d || d.deletedAt || !d.filing) throw new ValidationError("Document not found on a filing.");
  const t = await prisma.filingRecord.findUnique({ where: { id: targetFilingId } });
  if (!t || t.clientId !== d.clientId) throw new ValidationError("Choose another filing of this client.");
  if (t.id === d.filing.id) return d;
  // A return the client can see may only sit on a filing recorded as Accepted.
  if (d.filingDocType === "RETURN" && d.visibility === "PUBLISHED" && t.filingStatus !== "ACCEPTED") throw new ValidationError("That return is in the client's vault, so it can only move to a filing recorded as Accepted.");
  await prisma.$transaction(async (tx) => {
    if (d.filingDocType === "RETURN") {
      const previous = await tx.document.findFirst({ where: { filingId: t.id, filingDocType: "RETURN", deletedAt: null, supersededAt: null, replacedBy: null }, orderBy: { createdAt: "desc" } });
      await tx.document.update({ where: { id: d.id }, data: { filingId: t.id, title: retitle(d.title, d.filing!, t), year: t.taxYear, docType: returnDocType(t), replacesId: previous && previous.id !== d.id ? previous.id : null, version: (previous?.version ?? (previous ? 1 : 0)) + 1 } });
    } else {
      await tx.document.update({ where: { id: d.id }, data: { filingId: t.id, title: retitle(d.title, d.filing!, t), year: t.taxYear } });
    }
    await audit(tx, { actorId: actor.id, action: "filing.document_moved", entityType: "Document", entityId: d.id, clientId: d.clientId, details: { from: d.filingId, to: t.id, filingDocType: d.filingDocType } });
  });
  return prisma.document.findUniqueOrThrow({ where: { id: d.id } });
}

/**
 * "Remove filing (created by mistake)": the filing and its status history are
 * written in full to the audit log first, so nothing is lost from the audit
 * trail; then the record is removed (documents stay in the client's file,
 * unlinked). Refused while a return copy on it is in the client's vault —
 * move that copy to the right filing first.
 */
export async function removeFiling(actor: Actor, filingId: string, reason: string) {
  await assertOwner(actor);
  if (reason.trim().length < 3) throw new ValidationError("Say why the filing is being removed (e.g. “created by mistake — duplicate of the AL 40 filing”).");
  const f = await prisma.filingRecord.findUnique({ where: { id: filingId }, include: { events: { orderBy: { createdAt: "asc" } }, documents: { where: { deletedAt: null } } } });
  if (!f) throw new ValidationError("Filing not found.");
  const sent = f.documents.filter((d) => d.filingDocType === "RETURN" && (d.visibility === "PUBLISHED" || d.reviewStatus === "APPROVED"));
  if (sent.length) throw new ValidationError(`A return copy on this filing (“${sent[0].title}”) was already sent to the client. Move it to the right filing first (Misfiled? Fix → Move), then remove this one.`);
  const { events, documents, ...record } = f;
  await prisma.$transaction(async (tx) => {
    await audit(tx, {
      actorId: actor.id,
      action: "filing.removed",
      entityType: "FilingRecord",
      entityId: filingId,
      clientId: f.clientId,
      details: JSON.parse(JSON.stringify({ reason: reason.trim().slice(0, 300), filing: record, statusHistory: events, unlinkedDocuments: documents.map((d) => ({ id: d.id, title: d.title, filingDocType: d.filingDocType })) })),
    });
    // Documents stay in the client's file (staff-only drafts stay drafts); only the link goes.
    await tx.document.updateMany({ where: { filingId }, data: { filingId: null } });
    await tx.taxImportRow.updateMany({ where: { filingId }, data: { filingId: null } });
    await tx.filingRecord.delete({ where: { id: filingId } });
  });
}
