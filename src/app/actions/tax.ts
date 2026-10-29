"use server";

import { revalidatePath } from "next/cache";
import type { AmendmentOutcome, FilingMethod, FilingStatus, FilingType, PrepStatus } from "@prisma/client";
import { requireUser } from "@/lib/auth/session";
import { dateOrNull, run, str, type ActionState } from "@/lib/action";
import { ValidationError } from "@/lib/services/clients";
import { prisma } from "@/lib/prisma";
import { staffUploadDocument } from "@/lib/services/documents";
import {
  attachFilingDocument,
  commitTaxImport,
  createFiling,
  decideTaxRow,
  publishFilingUpdate,
  setAmendmentOutcome,
  setFilingStatusByStaff,
  setPrepStatus,
  stageTaxImport,
  type TaxStageInput,
} from "@/lib/services/tax";

const refresh = (clientId: string) => {
  revalidatePath(`/clients/${clientId}`);
  revalidatePath("/workflows");
};

export async function createFilingAction(clientId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    await createFiling(actor, {
      clientId,
      taxYear: Number(str(fd, "taxYear")),
      returnType: str(fd, "returnType"),
      jurisdiction: str(fd, "jurisdiction"),
      filingType: str(fd, "filingType") as FilingType,
      method: (str(fd, "method") || "ELECTRONIC") as FilingMethod,
    });
    refresh(clientId);
    return "Filing added.";
  });
}

export async function prepStatusAction(clientId: string, filingId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    await setPrepStatus(actor, filingId, str(fd, "prepStatus") as PrepStatus);
    refresh(clientId);
    return "Preparation status updated.";
  });
}

export async function filingStatusAction(clientId: string, filingId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    let evidenceDocumentId = str(fd, "evidenceDocumentId") || null;
    const file = fd.get("ackFile");
    if (file instanceof File && file.size > 0) {
      const f = await prisma.filingRecord.findUniqueOrThrow({ where: { id: filingId } });
      const doc = await staffUploadDocument(actor, {
        clientId,
        category: "TAXES",
        title: `${f.taxYear} ${f.jurisdiction === "FEDERAL" ? "Federal" : f.jurisdiction} ${f.filingType === "EXTENSION" ? "extension" : f.filingType === "AMENDED" ? "amended return" : "return"} — acknowledgment`,
        year: f.taxYear,
        visibility: "STAFF_ONLY",
        bytes: new Uint8Array(await file.arrayBuffer()),
        originalName: file.name,
        notify: false,
      });
      await attachFilingDocument(actor, filingId, doc.id, "OFFICIAL_ACK");
      evidenceDocumentId = doc.id;
    }
    await setFilingStatusByStaff(actor, filingId, {
      status: str(fd, "filingStatus") as FilingStatus,
      eventAt: dateOrNull(fd, "eventAt"),
      evidenceDocumentId,
      verificationNote: str(fd, "verificationNote"),
      filingReference: str(fd, "filingReference"),
      rejectionCodes: str(fd, "rejectionCodes"),
    });
    refresh(clientId);
    return "Filing status recorded.";
  });
}

export async function amendmentOutcomeAction(clientId: string, filingId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    await setAmendmentOutcome(actor, filingId, str(fd, "outcome") as AmendmentOutcome, str(fd, "note"));
    refresh(clientId);
    return "Amendment outcome recorded.";
  });
}

export async function attachFilingDocAction(clientId: string, filingId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    const type = str(fd, "docType") as "OFFICIAL_ACK" | "AGENCY_NOTICE" | "CORRESPONDENCE";
    let documentId = str(fd, "documentId");
    const file = fd.get("file");
    if (file instanceof File && file.size > 0) {
      const f = await prisma.filingRecord.findUniqueOrThrow({ where: { id: filingId } });
      documentId = (
        await staffUploadDocument(actor, { clientId, category: "TAXES", title: str(fd, "title") || file.name, year: f.taxYear, visibility: "STAFF_ONLY", bytes: new Uint8Array(await file.arrayBuffer()), originalName: file.name, notify: false })
      ).id;
    }
    if (!documentId) throw new ValidationError("Choose or upload a document.");
    await attachFilingDocument(actor, filingId, documentId, type);
    refresh(clientId);
    return "Document attached to the filing (staff only until published).";
  });
}

function channelsFrom(fd: FormData): ("EMAIL" | "SMS")[] | "portal_only" {
  const chosen = fd.getAll("notify").map(String).filter((c): c is "EMAIL" | "SMS" => c === "EMAIL" || c === "SMS");
  return fd.get("notifyClient") === "on" ? (chosen.length ? chosen : ["EMAIL", "SMS"]) : "portal_only";
}

export async function publishFilingAction(clientId: string, filingId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    const n = await publishFilingUpdate(actor, filingId, channelsFrom(fd));
    refresh(clientId);
    return `Published to the client's portal (${n} document${n === 1 ? "" : "s"}).`;
  });
}

/** Reviewed bulk publishing: staff tick each filing they've checked. */
export async function bulkPublishFilingsAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    const ids = fd.getAll("filingIds").map(String);
    if (!ids.length) throw new ValidationError("Tick the filings you've reviewed.");
    if (fd.get("reviewed") !== "on") throw new ValidationError("Confirm you've reviewed each selected filing and its acknowledgment.");
    const channels = channelsFrom(fd);
    for (const id of ids) await publishFilingUpdate(actor, id, channels);
    revalidatePath("/workflows");
    return `Published ${ids.length} filing update(s).`;
  });
}

export async function setTaxSoftwareIdAction(clientId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    const v = str(fd, "taxSoftwareId").trim() || null;
    if (v && (await prisma.client.findFirst({ where: { taxSoftwareId: v, NOT: { id: clientId } } }))) throw new ValidationError("Another client already has that TaxAct client ID.");
    await prisma.client.update({ where: { id: clientId }, data: { taxSoftwareId: v } });
    await prisma.auditLog.create({ data: { actorId: actor.id, action: "client.tax_software_id", entityType: "Client", entityId: clientId, clientId } });
    refresh(clientId);
    return "Saved.";
  });
}

export async function stageTaxImportAction(input: TaxStageInput): Promise<{ error?: string; batchId?: string } | null> {
  const actor = await requireUser();
  let batchId = "";
  const r = await run(async () => {
    batchId = (await stageTaxImport(actor, input)).id;
  });
  return r?.ok ? { batchId } : r;
}

export async function decideTaxRowAction(rowId: string, decision: string): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    if (decision === "skip") await decideTaxRow(actor, rowId, "skip");
    else if (decision === "apply") await decideTaxRow(actor, rowId, "apply");
    else if (decision.startsWith("apply:")) await decideTaxRow(actor, rowId, "apply", decision.slice(6));
    else throw new ValidationError("Invalid choice.");
  });
}

export async function commitTaxImportAction(batchId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    const r = await commitTaxImport(actor, batchId, fd.get("linkIds") === "on");
    revalidatePath(`/imports/tax/${batchId}`);
    revalidatePath("/workflows");
    return `Applied ${r.applied}, skipped ${r.skipped}. Nothing was published to clients — publish acknowledgments from each filing.`;
  });
}
