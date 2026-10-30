"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth/session";
import { run, str, type ActionState } from "@/lib/action";
import { ValidationError } from "@/lib/services/clients";
import { staffUploadDocument, REPORT_LABELS } from "@/lib/services/documents";
import {
  AlreadyEnrolledError, approveReport, classifyDocument, deliverReport, enrollExistingClient, enrollNewClient, isBkDocType, openWorkPeriod, openWorkPeriodsForAll, periodLabel, PossibleDuplicateError, requestReportChanges, saveProfile, setChecklistItem, submitReportForReview, uploadMonthlyReport,
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
    // "" keeps the current assignee; "none" unassigns.
    ...(str(fd, "assignedToId") ? { assignedToId: str(fd, "assignedToId") === "none" ? null : str(fd, "assignedToId") } : {}),
  };
}

const workspaceLink = (clientId: string, name: string) => ({ href: `/bookkeeping/${clientId}`, label: `Open ${name}'s bookkeeping workspace` });

/** Add Bookkeeping Client → an existing CRM client. Never creates a client record. */
export async function addExistingBookkeepingClientAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    const id = str(fd, "clientId");
    if (!id) throw new ValidationError("Choose the client from the list. If they aren't in the CRM yet, use “New client”.");
    try {
      const { client, reactivated } = await enrollExistingClient(actor, id, profileInput(fd));
      refresh(id);
      return { ok: `${client.displayName} ${reactivated ? "is active again in" : "was added to"} Bookkeeping Clients. No new client record was created.`, next: workspaceLink(id, client.displayName) };
    } catch (err) {
      if (err instanceof AlreadyEnrolledError) Object.assign(err, { next: { href: `/bookkeeping/${id}`, label: "Open their workspace" } });
      throw err;
    }
  });
}

/** Add Bookkeeping Client → a new client: creates the CRM record (after a duplicate check) and enrolls it. */
export async function addNewBookkeepingClientAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    const clientType = str(fd, "clientType") || "BUSINESS";
    try {
      const client = await enrollNewClient(
        actor,
        {
          clientType: clientType as "INDIVIDUAL" | "BUSINESS" | "NONPROFIT",
          status: "ACTIVE",
          firstName: str(fd, "firstName"),
          lastName: str(fd, "lastName"),
          businessName: str(fd, "businessName"),
          email: str(fd, "email"),
          phone: str(fd, "phone"),
        },
        profileInput(fd),
        { differentClient: fd.get("differentClient") === "on" },
      );
      refresh(client.id);
      revalidatePath("/clients");
      return { ok: `${client.displayName} was created in the CRM and added to Bookkeeping Clients. No invitation or message was sent.`, next: workspaceLink(client.id, client.displayName) };
    } catch (err) {
      if (err instanceof PossibleDuplicateError) {
        const m = err.matches[0];
        Object.assign(err, { next: m.enrolled ? { href: `/bookkeeping/${m.id}`, label: `${m.displayName} is already enrolled — open their workspace` } : { href: `/bookkeeping/new?client=${m.id}`, label: `Enroll the existing ${m.displayName} record instead` } });
      }
      throw err;
    }
  });
}

/** Upload Monthly Financials: a finished report into client → year → month (draft until Tabitha approves). */
export async function uploadMonthlyFinancialsAction(clientId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    const f = fd.get("file");
    if (!(f instanceof File) || f.size === 0) throw new ValidationError("Choose the report file (PDF, PNG or JPG).");
    const year = Number(str(fd, "year"));
    const month = Number(str(fd, "month"));
    const r = await uploadMonthlyReport(actor, {
      clientId,
      year,
      month,
      reportType: str(fd, "reportType"),
      title: str(fd, "title"),
      replacesId: str(fd, "replacesId") || null,
      bytes: new Uint8Array(await f.arrayBuffer()),
      originalName: f.name,
    });
    refresh(clientId);
    const where = periodLabel("MONTHLY", r.period.year, r.period.month);
    return {
      ok: r.replaced
        ? `${REPORT_LABELS[r.document.reportType!]} saved as version ${r.version} for ${where} (staff-only draft). Version ${r.version - 1} is kept in the history${r.replaced.visibility === "PUBLISHED" ? " and stays with the client until this one is approved and delivered" : ""}.`
        : `${REPORT_LABELS[r.document.reportType!]} saved to ${where} as a staff-only draft. Submit it for Tabitha's review when it's ready.`,
      next: { href: `/bookkeeping/${clientId}?period=${r.period.id}#reports`, label: `Go to ${where} reports` },
    };
  });
}

export async function saveBookkeepingProfileAction(clientId: string | null, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    const id = clientId ?? str(fd, "clientId");
    if (!id) throw new ValidationError("Choose a client from the list.");
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
    const bytes = new Uint8Array(await f.arrayBuffer());
    if (isReport) {
      // Same path as Upload Monthly Financials, so a second P&L for the month becomes a new version.
      const r = await uploadMonthlyReport(actor, { clientId, year: period.year, month: period.month, reportType: kind, title: str(fd, "title"), bytes, originalName: f.name });
      refresh(clientId);
      return r.replaced ? `Saved as version ${r.version} (staff-only draft); the earlier version is kept in the history.` : "Report saved as a draft. Submit it for Tabitha's review when it's ready.";
    }
    await staffUploadDocument(actor, {
      clientId,
      category: "BOOKKEEPING",
      title: str(fd, "title"),
      year: period.year,
      month: period.month,
      periodId,
      visibility: "STAFF_ONLY",
      docType: kind,
      bytes,
      originalName: f.name,
    });
    refresh(clientId);
    return "Saved to this month (staff only).";
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
