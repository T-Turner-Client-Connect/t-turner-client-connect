import "server-only";
import type { AmendmentOutcome, FilingMethod, FilingStatus, FilingType, Prisma, PrepStatus } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { audit } from "@/lib/audit";
import type { Actor } from "@/lib/auth/actor";
import { isSensitiveHeader } from "@/lib/import/fields";
import { matchByName, nameIndex } from "@/lib/tax/name-match";
import { allowedCategories, effectiveGrantsFor } from "@/lib/portal/access";
import {
  normalizeFilingType,
  normalizeJurisdiction,
  normalizeReturnType,
  normalizeStatus,
  parseDate,
  TAX_IMPORT_FIELDS,
  type TaxImportField,
} from "@/lib/tax/normalize";
import { ForbiddenError } from "@/lib/auth/actor";
import { ValidationError } from "./clients";
import { isReportApprover } from "./bookkeeping-clients";
import { queuePortalNotification } from "./notifications";

const FILING_LABEL: Record<FilingStatus, string> = { NOT_SUBMITTED: "Not submitted", SUBMITTED: "Submitted", PENDING_ACKNOWLEDGMENT: "Pending acknowledgment", ACCEPTED: "Accepted", REJECTED: "Rejected" };

/** The status staff most likely want to record next (the select's default), so “Submitted” isn't re-saved by mistake. */
export function nextFilingStatus(current: FilingStatus): FilingStatus {
  if (current === "NOT_SUBMITTED" || current === "REJECTED") return "SUBMITTED";
  return "ACCEPTED";
}

const ORDER: FilingStatus[] = ["NOT_SUBMITTED", "SUBMITTED", "PENDING_ACKNOWLEDGMENT", "ACCEPTED", "REJECTED"];

export async function createFiling(
  actor: Actor,
  input: { clientId: string; taxYear: number; returnType: string; jurisdiction: string; filingType: FilingType; method?: FilingMethod },
) {
  const jurisdiction = normalizeJurisdiction(input.jurisdiction);
  const returnType = normalizeReturnType(input.returnType);
  if (!jurisdiction) throw new ValidationError("Choose Federal or a two-letter state.");
  if (!returnType) throw new ValidationError("Enter the return type (e.g. 1040).");
  if (!Number.isInteger(input.taxYear) || input.taxYear < 2000 || input.taxYear > 2100) throw new ValidationError("Enter a valid tax year.");
  const exists = await prisma.filingRecord.findUnique({
    where: { clientId_taxYear_returnType_jurisdiction_filingType: { clientId: input.clientId, taxYear: input.taxYear, returnType, jurisdiction, filingType: input.filingType } },
  });
  if (exists) throw new ValidationError("That filing already exists for this client.");
  const f = await prisma.filingRecord.create({ data: { clientId: input.clientId, taxYear: input.taxYear, returnType, jurisdiction, filingType: input.filingType, method: input.method ?? "ELECTRONIC" } });
  await audit(prisma, { actorId: actor.id, action: "filing.created", entityType: "FilingRecord", entityId: f.id, clientId: input.clientId, details: { taxYear: f.taxYear, returnType, jurisdiction, filingType: f.filingType } });
  return f;
}

/**
 * The filing a return belongs to: the exact match, or — when the return type
 * differs or was left empty (a state filing created as "1040" instead of
 * "40") — the only filing for that client, year, jurisdiction and
 * original/amended. Never a guess between two.
 */
export async function findFilingFor(key: { clientId: string; taxYear: number; returnType: string; jurisdiction: string; filingType: FilingType }) {
  if (key.returnType) {
    const exact = await prisma.filingRecord.findUnique({ where: { clientId_taxYear_returnType_jurisdiction_filingType: key } });
    if (exact) return exact;
  }
  const near = await prisma.filingRecord.findMany({ where: { clientId: key.clientId, taxYear: key.taxYear, jurisdiction: key.jurisdiction, filingType: key.filingType } });
  return near.length === 1 ? near[0] : null;
}

/**
 * Owner-only correction of a filing's form number (e.g. a state return entered
 * as "1040" that is really Alabama Form 40). Keeps every status and document,
 * renames the linked documents that carry the old number, and records the
 * change with a reason in the status history and audit log.
 */
export async function correctFilingForm(actor: Actor, filingId: string, newReturnType: string, reason: string) {
  if (!(await isReportApprover(actor))) throw new ForbiddenError("Only Tabitha can correct a filing's form number.");
  const why = reason.trim();
  if (!why) throw new ValidationError("Say why the form number is being corrected.");
  const returnType = normalizeReturnType(newReturnType);
  if (!returnType) throw new ValidationError("Enter the correct form number (for example 40 for Alabama).");
  const f = await prisma.filingRecord.findUniqueOrThrow({ where: { id: filingId }, include: { documents: { where: { deletedAt: null }, select: { id: true, title: true } } } });
  if (f.returnType === returnType) throw new ValidationError(`This filing is already form ${returnType}.`);
  const clash = await prisma.filingRecord.findUnique({
    where: { clientId_taxYear_returnType_jurisdiction_filingType: { clientId: f.clientId, taxYear: f.taxYear, returnType, jurisdiction: f.jurisdiction, filingType: f.filingType } },
  });
  if (clash) throw new ValidationError(`This client already has a ${f.taxYear} form ${returnType} filing for ${f.jurisdiction === "FEDERAL" ? "Federal" : f.jurisdiction}.`);
  const old = f.returnType;
  const renames = formNumberRenames(f.documents, old, returnType);
  await prisma.$transaction([
    prisma.filingRecord.update({ where: { id: filingId }, data: { returnType } }),
    ...renames.map((r) => prisma.document.update({ where: { id: r.id }, data: { title: r.to } })),
    ...formCorrectionRecords(prisma, actor, { id: filingId, clientId: f.clientId }, { from: old, to: returnType, reason: why, renames }),
  ]);
  return { from: old, to: returnType, renamed: renames.length };
}

export type FormRename = { id: string; from: string; to: string };

/**
 * The document titles a form-number change rewrites: the old number as a whole
 * word ("2025 1040 — AL" → "2025 40 — AL"), never digits inside another
 * number ("Notice 10401 follow-up" is left alone).
 */
export function formNumberRenames(docs: { id: string; title: string }[], from: string, to: string): FormRename[] {
  const escaped = from.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`(^|\\s)${escaped}(?=\\s|$)`);
  return docs.filter((d) => pattern.test(d.title)).map((d) => ({ id: d.id, from: d.title, to: d.title.replace(pattern, `$1${to}`) }));
}

/**
 * The audit record of a form-number change, shared by correctFilingForm and
 * "Edit filing details": a FORM status event carrying the reason, and a
 * `filing.form_corrected` audit entry listing the renamed documents.
 */
export function formCorrectionRecords(db: Prisma.TransactionClient, actor: Actor, filing: { id: string; clientId: string }, c: { from: string; to: string; reason: string; renames: FormRename[] }) {
  return [
    db.filingStatusEvent.create({ data: { filingId: filing.id, field: "FORM", fromValue: c.from, toValue: c.to, source: "STAFF", actorId: actor.id, verificationNote: c.reason, eventAt: new Date() } }),
    db.auditLog.create({ data: { actorId: actor.id, action: "filing.form_corrected", entityType: "FilingRecord", entityId: filing.id, clientId: filing.clientId, details: { from: c.from, to: c.to, reason: c.reason, renamedDocuments: c.renames } } }),
  ] as const;
}

/** Internal preparation status — staff-managed, separate from e-file status. */
export async function setPrepStatus(actor: Actor, filingId: string, status: PrepStatus) {
  const f = await prisma.filingRecord.findUniqueOrThrow({ where: { id: filingId } });
  if (f.prepStatus === status) return f;
  await prisma.$transaction([
    prisma.filingRecord.update({ where: { id: filingId }, data: { prepStatus: status } }),
    prisma.filingStatusEvent.create({ data: { filingId, field: "PREP", fromValue: f.prepStatus, toValue: status, source: "STAFF", actorId: actor.id, eventAt: new Date() } }),
    prisma.auditLog.create({ data: { actorId: actor.id, action: "filing.prep_status", entityType: "FilingRecord", entityId: filingId, clientId: f.clientId, details: { from: f.prepStatus, to: status } } }),
  ]);
}

/**
 * Audited staff update of the filing (acknowledgment) status. "Accepted"
 * needs an acknowledgment document on this filing or a written note of how
 * it was verified. A change dated before the current status is refused.
 */
export async function setFilingStatusByStaff(
  actor: Actor,
  filingId: string,
  input: {
    status: FilingStatus;
    eventAt?: Date | null;
    evidenceDocumentId?: string | null;
    verificationNote?: string | null;
    filingReference?: string | null;
    rejectionCodes?: string | null;
    // Owner filing: Form 8879 confirmed; reason when filing without an approved summary.
    submission?: { form8879Confirmed: boolean; overrideReason?: string | null };
  },
) {
  const f = await prisma.filingRecord.findUniqueOrThrow({ where: { id: filingId } });
  const eventAt = input.eventAt ?? new Date();
  if (eventAt > new Date(Date.now() + 60_000)) throw new ValidationError("The status date can't be in the future.");
  if (f.statusAsOf && eventAt < f.statusAsOf) {
    const { fmtDateTime } = await import("@/lib/format");
    throw new ValidationError(`A newer status is already recorded for this filing (${FILING_LABEL[f.filingStatus]}, ${fmtDateTime(f.statusAsOf)}). The status date must be after ${fmtDateTime(f.statusAsOf)}.`);
  }
  if (input.evidenceDocumentId && !(await prisma.document.count({ where: { id: input.evidenceDocumentId, clientId: f.clientId, deletedAt: null } }))) {
    throw new ValidationError("The evidence document must belong to this client.");
  }
  if (input.status === "ACCEPTED" && !input.evidenceDocumentId && !input.verificationNote?.trim()) {
    throw new ValidationError("To record Accepted, attach the acknowledgment or describe how you verified it (e.g. “Checked IRS acknowledgment in TaxAct E-file Center, 3/14”).");
  }
  if (f.method === "PAPER" && input.status === "ACCEPTED" && !input.evidenceDocumentId) {
    throw new ValidationError("Paper filings have no electronic acceptance. Attach the agency notice to record a status.");
  }
  // Moving a return out of "Not submitted" means it was filed: for individual
  // returns that is Tabitha's alone, with the client's approved summary on file.
  let gateNote: string | null = null;
  let gateDetails: Record<string, unknown> = {};
  if (f.filingStatus === "NOT_SUBMITTED" && input.status !== "NOT_SUBMITTED" && f.filingType !== "EXTENSION") {
    const { summaryRequirement, assertOwnerMaySubmit } = await import("./tax-summary");
    if ((await summaryRequirement(f)).required) {
      const g = await assertOwnerMaySubmit(actor, f, input.submission ?? { form8879Confirmed: false });
      gateNote = g.summaryId ? "Owner filing: client-approved summary on file; Form 8879/state authorization confirmed." : `Owner filing WITHOUT an approved summary: ${g.override}`;
      gateDetails = { approvedSummaryId: g.summaryId, overrideReason: g.override, form8879Confirmed: !!input.submission?.form8879Confirmed };
    }
  }
  await prisma.$transaction([
    prisma.filingRecord.update({
      where: { id: filingId },
      data: {
        filingStatus: input.status,
        statusSource: "STAFF",
        statusAsOf: eventAt,
        lastVerifiedAt: new Date(),
        lastVerifiedById: actor.id,
        submittedAt: input.status === "SUBMITTED" || input.status === "PENDING_ACKNOWLEDGMENT" ? f.submittedAt ?? eventAt : f.submittedAt,
        acknowledgedAt: input.status === "ACCEPTED" || input.status === "REJECTED" ? eventAt : f.acknowledgedAt,
        filingReference: input.filingReference?.trim() || f.filingReference,
        rejectionCodes: input.status === "REJECTED" ? input.rejectionCodes?.trim() || f.rejectionCodes : f.rejectionCodes,
      },
    }),
    prisma.filingStatusEvent.create({
      data: {
        filingId,
        field: "FILING",
        fromValue: f.filingStatus,
        toValue: input.status,
        source: "STAFF",
        actorId: actor.id,
        evidenceDocumentId: input.evidenceDocumentId ?? null,
        verificationNote: [input.verificationNote?.trim(), gateNote].filter(Boolean).join(" · ") || null,
        eventAt,
      },
    }),
    prisma.auditLog.create({
      data: { actorId: actor.id, action: "filing.status_staff_update", entityType: "FilingRecord", entityId: filingId, clientId: f.clientId, details: { from: f.filingStatus, to: input.status, ...gateDetails } },
    }),
  ]);
}

/** Post-acceptance outcome of an amended return (kept separate from acceptance). */
export async function setAmendmentOutcome(actor: Actor, filingId: string, outcome: AmendmentOutcome, note?: string) {
  const f = await prisma.filingRecord.findUniqueOrThrow({ where: { id: filingId } });
  if (f.filingType !== "AMENDED") throw new ValidationError("Only amended returns have an amendment outcome.");
  await prisma.$transaction([
    prisma.filingRecord.update({ where: { id: filingId }, data: { amendmentOutcome: outcome } }),
    prisma.filingStatusEvent.create({ data: { filingId, field: "AMENDMENT", fromValue: f.amendmentOutcome, toValue: outcome, source: "STAFF", actorId: actor.id, verificationNote: note?.trim() || null, eventAt: new Date() } }),
    prisma.auditLog.create({ data: { actorId: actor.id, action: "filing.amendment_outcome", entityType: "FilingRecord", entityId: filingId, clientId: f.clientId, details: { to: outcome } } }),
  ]);
}

/** Links an uploaded document (acknowledgment, notice, correspondence) to a filing. */
export async function attachFilingDocument(actor: Actor, filingId: string, documentId: string, docType: "OFFICIAL_ACK" | "AGENCY_NOTICE" | "CORRESPONDENCE") {
  const f = await prisma.filingRecord.findUniqueOrThrow({ where: { id: filingId } });
  const doc = await prisma.document.findFirst({ where: { id: documentId, clientId: f.clientId, deletedAt: null } });
  if (!doc) throw new ValidationError("Document not found for this client.");
  await prisma.document.update({ where: { id: documentId }, data: { filingId, filingDocType: docType, category: "TAXES", year: f.taxYear } });
  await audit(prisma, { actorId: actor.id, action: "filing.document_attached", entityType: "FilingRecord", entityId: filingId, clientId: f.clientId, details: { documentId, docType } });
}

/**
 * Publishes a filing's documents to the client's portal (staff-controlled)
 * and optionally notifies them. Notices only say an update is available.
 */
export async function publishFilingUpdate(actor: Actor, filingId: string, channels: ("EMAIL" | "SMS")[] | "portal_only") {
  const f = await prisma.filingRecord.findUniqueOrThrow({ where: { id: filingId }, include: { documents: { where: { deletedAt: null } } } });
  // A tax return reaches the client only through Tabitha's release (never as a side effect of publishing the filing).
  const docIds = f.documents.filter((d) => d.scanStatus === "CLEAN" && d.filingDocType !== "RETURN").map((d) => d.id);
  await prisma.$transaction([
    prisma.filingRecord.update({ where: { id: filingId }, data: { visibleToClient: true } }),
    prisma.document.updateMany({ where: { id: { in: docIds }, visibility: "STAFF_ONLY" }, data: { visibility: "PUBLISHED", publishedAt: new Date() } }),
    prisma.auditLog.create({ data: { actorId: actor.id, action: "filing.published", entityType: "FilingRecord", entityId: filingId, clientId: f.clientId, details: { documents: docIds.length, notify: channels } } }),
  ]);
  if (channels !== "portal_only") {
    const grants = await effectiveGrantsFor(f.clientId);
    for (const g of grants) {
      if (!allowedCategories(g).includes("TAXES" as never)) continue;
      await queuePortalNotification(g.portalUserId, "FILING_UPDATE", `filing:${filingId}:${f.filingStatus}:${f.statusAsOf?.getTime() ?? 0}`, channels);
    }
  }
  return docIds.length;
}

// --- E-file status import -------------------------------------------------

export type TaxStageInput = {
  fileName: string;
  source: string;
  mapping: Record<string, string>;
  rows: Record<string, unknown>[];
  statusFilter: FilingStatus[];
};

type CleanTaxRow = {
  clientRef: string | null;
  displayName: string | null;
  taxYear: number | null;
  returnType: string | null;
  jurisdiction: string | null;
  filingType: FilingType;
  status: FilingStatus | null;
  submittedAt: string | null;
  eventAt: string | null;
  submissionId: string | null;
  rejectionCodes: string | null;
  /** The status on file is already as new: only the missing Submission ID is saved. */
  idOnly?: boolean;
};

function cleanTaxRow(raw: Record<string, unknown>): { row: CleanTaxRow; errors: string[] } {
  const get = (k: TaxImportField) => {
    const v = raw[k];
    const s = v === undefined || v === null ? "" : String(v).trim().slice(0, 200);
    return s || null;
  };
  const errors: string[] = [];
  const returnType = normalizeReturnType(get("returnType"));
  const jurisdiction = normalizeJurisdiction(get("jurisdiction"));
  const yearRaw = get("taxYear");
  const taxYear = yearRaw && /^\d{4}$/.test(yearRaw) ? Number(yearRaw) : null;
  const status = normalizeStatus(get("status"));
  const eventAt = parseDate(get("statusDate")) ?? parseDate(get("submittedAt"));
  const clientRef = get("clientRef");
  if (!clientRef && !get("displayName")) errors.push("No client ID or name");
  if (!taxYear) errors.push("Missing or invalid tax year");
  if (!returnType) errors.push("Missing return type");
  if (!jurisdiction) errors.push(`Unknown jurisdiction "${get("jurisdiction") ?? ""}"`);
  if (!status) errors.push(`Unknown e-file status "${get("status") ?? ""}"`);
  if (!eventAt) errors.push("Missing status/submit date");
  return {
    errors,
    row: {
      clientRef,
      displayName: get("displayName"),
      taxYear,
      returnType,
      jurisdiction,
      filingType: normalizeFilingType(get("filingType"), get("returnType")),
      status,
      submittedAt: parseDate(get("submittedAt"))?.toISOString() ?? null,
      eventAt: eventAt?.toISOString() ?? null,
      submissionId: get("submissionId"),
      rejectionCodes: get("rejectionCodes"),
    },
  };
}

/** Validates, matches and previews an e-file status export. Nothing changes until commit. */
export async function stageTaxImport(actor: Actor, input: TaxStageInput) {
  if (!input.rows.length) throw new ValidationError("The file has no data rows.");
  if (input.rows.length > 5000) throw new ValidationError("Import up to 5,000 rows at a time.");
  const mapping: Record<string, string> = {};
  for (const [header, field] of Object.entries(input.mapping)) {
    if (!(field in TAX_IMPORT_FIELDS)) continue;
    if (isSensitiveHeader(header) && !/return|refund/i.test(field)) {
      // "Return Type" headers are allowed; SSN/EIN/DOB/bank columns are not.
      if (!/return\s*type|form/i.test(header)) throw new ValidationError(`The column "${header}" looks sensitive and can't be imported.`);
    }
    mapping[header.slice(0, 200)] = field;
  }
  if (!Object.values(mapping).includes("clientRef") && !Object.values(mapping).includes("displayName")) throw new ValidationError("Map the client name column (or the TaxAct client ID column).");
  const mapped = new Set(Object.values(mapping));
  const filter = input.statusFilter.length ? input.statusFilter : (["ACCEPTED"] as FilingStatus[]);

  const cleaned = input.rows.map((raw) => {
    const allowed: Record<string, unknown> = {};
    for (const k of Object.keys(TAX_IMPORT_FIELDS)) if (mapped.has(k) && k in raw) allowed[k] = raw[k];
    return cleanTaxRow(allowed);
  });

  const refs = Array.from(new Set(cleaned.map((c) => c.row.clientRef).filter((v): v is string => !!v)));
  const clients = await prisma.client.findMany({ where: { OR: [{ taxSoftwareId: { in: refs } }, { id: { in: refs } }] }, select: { id: true, taxSoftwareId: true, displayName: true } });
  const byRef = new Map<string, string[]>();
  for (const c of clients) {
    for (const key of [c.taxSoftwareId, c.id]) if (key) byRef.set(key, [...(byRef.get(key) ?? []), c.id]);
  }
  // No known TaxAct client ID: match by the taxpayer's or business's name. A name that fits more
  // than one client always goes to review; it is never applied automatically.
  const needNames = cleaned.some((c) => !(c.row.clientRef && byRef.has(c.row.clientRef)) && c.row.displayName);
  const people = needNames
    ? await prisma.client.findMany({ where: { archivedAt: null }, select: { id: true, displayName: true, firstName: true, lastName: true, spouseFirstName: true, spouseLastName: true, businessName: true } })
    : [];
  const names = nameIndex(people);
  const nameOf = new Map(people.map((p) => [p.id, p.displayName]));

  const seen = new Set<string>();
  const rows: Prisma.TaxImportRowCreateManyBatchInput[] = [];
  for (const [i, { row, errors }] of cleaned.entries()) {
    const warnings: string[] = [];
    let match = "ERROR";
    let clientId: string | null = null;
    let filingId: string | null = null;
    if (!errors.length) {
      let ids = Array.from(new Set(row.clientRef ? byRef.get(row.clientRef) ?? [] : []));
      const byName = !ids.length && !!row.displayName;
      if (byName) ids = matchByName(names, row.displayName);
      if (ids.length === 0) {
        match = "NO_CLIENT";
        warnings.push(row.displayName ? `No client named "${row.displayName}". Choose the client on review, or skip.` : "No CRM client has this client ID. Choose the client on review, or skip.");
      } else if (ids.length > 1) {
        match = "AMBIGUOUS";
        warnings.push(byName ? `"${row.displayName}" fits more than one client: ${ids.map((id) => nameOf.get(id)).join(", ")}. Choose one.` : "This ID matches more than one client.");
      } else {
        if (byName) warnings.push(`Matched by name: ${nameOf.get(ids[0])}.`);
        clientId = ids[0];
        const key = `${clientId}|${row.taxYear}|${row.returnType}|${row.jurisdiction}|${row.filingType}`;
        const filing = await prisma.filingRecord.findUnique({
          where: { clientId_taxYear_returnType_jurisdiction_filingType: { clientId, taxYear: row.taxYear!, returnType: row.returnType!, jurisdiction: row.jurisdiction!, filingType: row.filingType } },
        });
        filingId = filing?.id ?? null;
        if (seen.has(key)) {
          match = "AMBIGUOUS";
          warnings.push("Another row in this file is for the same filing.");
        } else if (!filter.includes(row.status!)) {
          match = "FILTERED";
        } else if (filing?.statusAsOf && new Date(row.eventAt!) <= filing.statusAsOf && row.submissionId && !filing.filingReference) {
          // The status is already up to date; the Submission ID is missing: save just the ID.
          match = "MATCH";
          row.idOnly = true;
          warnings.push("Status already up to date. Only the missing Submission ID will be saved.");
        } else if (filing?.statusAsOf && new Date(row.eventAt!) <= filing.statusAsOf) {
          match = "STALE";
          warnings.push(`Older than the status already recorded (${filing.filingStatus.toLowerCase().replace(/_/g, " ")}) — will not overwrite.`);
        } else {
          match = filing ? "MATCH" : "NEW_FILING";
          if (filing?.filingReference && row.submissionId && filing.filingReference !== row.submissionId) warnings.push(`Replaces the Submission ID on file (${filing.filingReference}). Skip this row to keep it.`);
          if (filing && ORDER.indexOf(row.status!) < ORDER.indexOf(filing.filingStatus) && filing.filingStatus !== "REJECTED") {
            warnings.push(`Moves status back from ${filing.filingStatus.toLowerCase().replace(/_/g, " ")} — check before applying.`);
          }
        }
        seen.add(key);
      }
    }
    rows.push({
      rowNumber: i + 2,
      data: row as unknown as Prisma.InputJsonValue,
      errors,
      warnings,
      match,
      clientId,
      filingId,
      decision: match === "MATCH" || match === "NEW_FILING" ? "apply" : match === "AMBIGUOUS" || match === "NO_CLIENT" ? null : "skip",
    });
  }
  const batch = await prisma.taxImportBatch.create({
    data: { source: input.source.slice(0, 120) || "TaxAct e-file export", fileName: input.fileName.slice(0, 200), mapping, statusFilter: filter, importedById: actor.id, rows: { createMany: { data: rows } } },
  });
  await audit(prisma, { actorId: actor.id, action: "tax_import.staged", entityType: "TaxImportBatch", entityId: batch.id, details: { rows: rows.length, statusFilter: filter } });
  return batch;
}

export async function decideTaxRow(actor: Actor, rowId: string, decision: "apply" | "skip", clientId?: string) {
  const row = await prisma.taxImportRow.findUnique({ where: { id: rowId }, include: { batch: true } });
  if (!row || row.batch.status !== "REVIEW") throw new ValidationError("This import is no longer open.");
  if (decision === "apply") {
    if (row.errors.length) throw new ValidationError("Rows with errors can only be skipped.");
    if (row.match === "STALE" || row.match === "FILTERED") throw new ValidationError("This row won't be applied (older status or not in the selected queues).");
    const target = clientId ?? row.clientId;
    if (!target) throw new ValidationError("Choose the client this filing belongs to.");
    if (!(await prisma.client.count({ where: { id: target } }))) throw new ValidationError("Client not found.");
    await prisma.taxImportRow.update({ where: { id: rowId }, data: { decision, clientId: target } });
  } else {
    await prisma.taxImportRow.update({ where: { id: rowId }, data: { decision } });
  }
}

/** Applies approved rows. Never enrolls anyone in campaigns or groups. */
export async function commitTaxImport(actor: Actor, batchId: string, linkClientIds: boolean) {
  const batch = await prisma.taxImportBatch.findUnique({ where: { id: batchId }, include: { rows: { orderBy: { rowNumber: "asc" } } } });
  if (!batch || batch.status !== "REVIEW") throw new ValidationError("This import is no longer open.");
  const undecided = batch.rows.filter((r) => !r.decision).length;
  if (undecided) throw new ValidationError(`Decide on ${undecided} row(s) that need review first.`);
  let applied = 0;
  let skipped = 0;
  await prisma.$transaction(
    async (tx) => {
      for (const r of batch.rows) {
        const d = r.data as unknown as CleanTaxRow;
        if (r.decision !== "apply" || !r.clientId) {
          skipped++;
          continue;
        }
        const eventAt = new Date(d.eventAt!);
        const key = { clientId: r.clientId, taxYear: d.taxYear!, returnType: d.returnType!, jurisdiction: d.jurisdiction!, filingType: d.filingType };
        const filing =
          (await tx.filingRecord.findUnique({ where: { clientId_taxYear_returnType_jurisdiction_filingType: key } })) ??
          (await tx.filingRecord.create({ data: { ...key, method: "ELECTRONIC", prepStatus: "READY_TO_FILE" } }));
        // Re-check freshness inside the transaction. An up-to-date filing still gets a missing Submission ID.
        if (filing.statusAsOf && eventAt <= filing.statusAsOf) {
          if (d.submissionId && !filing.filingReference) {
            await tx.filingRecord.update({ where: { id: filing.id }, data: { filingReference: d.submissionId } });
            await audit(tx, { actorId: actor.id, action: "filing.submission_id_imported", entityType: "FilingRecord", entityId: filing.id, clientId: r.clientId, details: { batchId } });
            await tx.taxImportRow.update({ where: { id: r.id }, data: { applied: true, filingId: filing.id } });
            applied++;
          } else skipped++;
          continue;
        }
        await tx.filingRecord.update({
          where: { id: filing.id },
          data: {
            filingStatus: d.status!,
            statusSource: "TAXACT_IMPORT",
            statusAsOf: eventAt,
            lastVerifiedAt: new Date(),
            submittedAt: d.submittedAt ? new Date(d.submittedAt) : filing.submittedAt,
            acknowledgedAt: d.status === "ACCEPTED" || d.status === "REJECTED" ? eventAt : filing.acknowledgedAt,
            filingReference: d.submissionId ?? filing.filingReference,
            rejectionCodes: d.status === "REJECTED" ? d.rejectionCodes : filing.rejectionCodes,
          },
        });
        await tx.filingStatusEvent.create({
          data: { filingId: filing.id, field: "FILING", fromValue: filing.filingStatus, toValue: d.status!, source: "TAXACT_IMPORT", actorId: actor.id, importBatchId: batchId, eventAt },
        });
        if (linkClientIds && d.clientRef && d.clientRef !== r.clientId) {
          const taken = await tx.client.findFirst({ where: { taxSoftwareId: d.clientRef } });
          if (!taken) await tx.client.update({ where: { id: r.clientId }, data: { taxSoftwareId: d.clientRef } });
        }
        await tx.taxImportRow.update({ where: { id: r.id }, data: { applied: true, filingId: filing.id } });
        applied++;
      }
      await tx.taxImportBatch.update({ where: { id: batchId }, data: { status: "COMMITTED", committedAt: new Date(), appliedCount: applied, skippedCount: skipped } });
      await audit(tx, { actorId: actor.id, action: "tax_import.committed", entityType: "TaxImportBatch", entityId: batchId, details: { applied, skipped } });
    },
    { timeout: 120_000 },
  );
  return { applied, skipped };
}

export const TAX_QUEUES = {
  accepted: { label: "Accepted returns", where: { filingStatus: "ACCEPTED", filingType: "ORIGINAL" } },
  needs_info: { label: "Needs more information", where: { prepStatus: "AWAITING_INFORMATION" } },
  extensions: { label: "Extensions", where: { filingType: "EXTENSION" } },
  amended: { label: "Amended returns", where: { filingType: "AMENDED" } },
  rejected: { label: "Rejected — needs attention", where: { filingStatus: "REJECTED" } },
} satisfies Record<string, { label: string; where: Prisma.FilingRecordWhereInput }>;
