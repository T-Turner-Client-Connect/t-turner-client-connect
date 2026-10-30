"use server";

import { revalidatePath } from "next/cache";
import type { ReportType } from "@prisma/client";
import { requireUser } from "@/lib/auth/session";
import { run, str, type ActionState } from "@/lib/action";
import { ValidationError } from "@/lib/services/clients";
import { staffUploadDocument, REPORT_LABELS } from "@/lib/services/documents";
import {
  approveReport, classifyDocument, deliverReport, isBkDocType, openWorkPeriod, openWorkPeriodsForAll, requestReportChanges, saveProfile, setChecklistItem, submitReportForReview,
} from "@/lib/services/bookkeeping-clients";
import { prisma } from "@/lib/prisma";

const refresh = (clientId?: string) => {
  revalidatePath("/bookkeeping", "layout");
  if (clientId) revalidatePath(`/clients/${clientId}`);
};

function profileInput(fd: FormData) {
  return {
    active: str(fd, "active") !== "false",
    frequency: str(fd, "frequency") || "MONTHLY",
    payroll: fd.get("payroll") === "on",
    payrollFrequency: str(fd, "payrollFrequency") || null,
    payrollProvider: str(fd, "payrollProvider") || null,
    accounts: str(fd, "accounts") || null,
    notes: str(fd, "notes") || null,
    ...(fd.has("documentsDueDay") ? { documentsDueDay: str(fd, "documentsDueDay") ? Number(str(fd, "documentsDueDay")) : null } : {}),
    ...(fd.has("reportsDueDay") ? { reportsDueDay: str(fd, "reportsDueDay") ? Number(str(fd, "reportsDueDay")) : null } : {}),
    ...(fd.has("assignedToId") ? { assignedToId: str(fd, "assignedToId") || null } : {}),
  };
}

export async function saveBookkeepingProfileAction(clientId: string | null, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    const id = clientId ?? str(fd, "clientId");
    if (!id) throw new ValidationError("Choose a client.");
    await saveProfile(actor, id, profileInput(fd));
    refresh(id);
    return clientId ? "Saved." : "Added to Bookkeeping Clients.";
  });
}

export async function openPeriodForClientAction(clientId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    const p = await openWorkPeriod(actor, clientId, Number(str(fd, "year")), Number(str(fd, "month")));
    refresh(clientId);
    void p;
    return "Opened with its checklist.";
  });
}

export async function openAllPeriodsAction(_prev: ActionState): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    const r = await openWorkPeriodsForAll(actor);
    refresh();
    return `${r.opened} new month${r.opened === 1 ? "" : "s"} opened (${r.total} active bookkeeping client${r.total === 1 ? "" : "s"}).`;
  });
}

export async function checklistItemAction(clientId: string, itemId: string, status: "OPEN" | "DONE" | "NOT_NEEDED") {
  const actor = await requireUser();
  await setChecklistItem(actor, itemId, status);
  refresh(clientId);
}

export async function classifyDocumentAction(clientId: string, documentId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    await classifyDocument(actor, documentId, str(fd, "docType"));
    refresh(clientId);
    return "Labeled.";
  });
}

export async function uploadBookkeepingFileAction(clientId: string, periodId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    const f = fd.get("file");
    if (!(f instanceof File) || f.size === 0) throw new ValidationError("Choose a file.");
    const kind = str(fd, "kind");
    const period = await prisma.bookkeepingPeriod.findFirst({ where: { id: periodId, clientId } });
    if (!period) throw new ValidationError("Month not found.");
    const isReport = kind in REPORT_LABELS;
    if (!isReport && !isBkDocType(kind)) throw new ValidationError("Choose what this file is.");
    await staffUploadDocument(actor, {
      clientId,
      category: "BOOKKEEPING",
      title: str(fd, "title"),
      year: period.year,
      month: period.month,
      periodId,
      visibility: "STAFF_ONLY",
      reportType: isReport ? (kind as ReportType) : null,
      docType: isReport ? null : kind,
      bytes: new Uint8Array(await f.arrayBuffer()),
      originalName: f.name,
    });
    refresh(clientId);
    return isReport ? "Report saved as a draft. Submit it for Tabitha's review when it's ready." : "Saved to this month (staff only).";
  });
}

export async function reportStepAction(clientId: string, documentId: string, step: "submit" | "approve" | "deliver", _prev: ActionState): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    if (step === "submit") await submitReportForReview(actor, documentId);
    else if (step === "approve") await approveReport(actor, documentId);
    else await deliverReport(actor, documentId);
    refresh(clientId);
    return step === "submit" ? "Sent to Tabitha for review." : step === "approve" ? "Approved. Staff can now deliver it to the client." : "Delivered to the client's portal.";
  });
}

export async function requestChangesAction(clientId: string, documentId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    await requestReportChanges(actor, documentId, str(fd, "note"));
    refresh(clientId);
    return "Sent back to staff with your note.";
  });
}
