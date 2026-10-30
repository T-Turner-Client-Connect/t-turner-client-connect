"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth/session";
import { run, str, type ActionState } from "@/lib/action";
import { ValidationError } from "@/lib/services/clients";
import { staffUploadDocument, REPORT_LABELS } from "@/lib/services/documents";
import {
  AlreadyEnrolledError, approveReport, deliverApprovedReports, classifyDocument, deliverReport, enrollExistingClient, enrollNewClient, isBkDocType, openWorkPeriod, openWorkPeriodsForAll, periodLabel, PossibleDuplicateError, requestReportChanges, saveProfile, setChecklistItem, submitReportForReview, uploadMonthlyReport,
} from "@/lib/services/bookkeeping-clients";
import { prisma } from "@/lib/prisma";
import {
  recordChargeAuthorization, revealEin, revokeChargeAuthorization, saveAccount, saveBilling, saveBusinessInfo, setBillingAccess,
} from "@/lib/services/bookkeeping-profile";

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

// A calendar date from a date field (no time zone shift), or null.
function localDate(fd: FormData, key: string) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(str(fd, key));
  return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : null;
}

const scanNote = (scan: string) =>
  scan === "CLEAN" ? "Malware scan passed." : scan === "NOT_SCANNED" ? "It's quarantined: malware scanning isn't set up on this site yet, so no one can download it until a scanner is connected and it passes." : "It's quarantined until the malware scan finishes (re-checked automatically every 10 minutes)."

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
    // "M9" = September, "Q3" = quarter ending September; period type is month, quarter or year to date.
    const pick = str(fd, "period");
    const periodType = str(fd, "periodType") || (str(fd, "covers") === "YTD" ? "YEAR_TO_DATE" : pick.startsWith("Q") ? "QUARTER" : "MONTH");
    const monthFromPick = pick ? (pick.startsWith("Q") ? Number(pick.slice(1)) * 3 : Number(pick.slice(1))) : month;
    const r = await uploadMonthlyReport(actor, {
      clientId,
      year,
      month: monthFromPick,
      periodType,
      basis: str(fd, "basis") || null,
      includesYtd: fd.has("includesYtd") ? fd.get("includesYtd") === "on" : null,
      asOf: localDate(fd, "asOf"),
      accountId: str(fd, "accountId") || null,
      reportType: str(fd, "reportType"),
      title: str(fd, "title"),
      replacesId: str(fd, "replacesId") || null,
      bytes: new Uint8Array(await f.arrayBuffer()),
      originalName: f.name,
    });
    refresh(clientId);
    const where = r.range.short;
    return {
      ok: r.replaced
        ? `${REPORT_LABELS[r.document.reportType!]} saved as version ${r.version} for ${where} (staff-only draft). ${scanNote(r.document.scanStatus)} Version ${r.version - 1} is kept in the history${r.replaced.visibility === "PUBLISHED" ? " and stays with the client until this one is approved and delivered" : ""}.`
        : `${REPORT_LABELS[r.document.reportType!]} saved to ${where} as a staff-only draft. ${scanNote(r.document.scanStatus)} Submit it for Tabitha's review when it's ready.`,
      next: { href: `/bookkeeping/${clientId}?period=${r.period.id}#reports`, label: `Go to ${periodLabel("MONTHLY", r.period.year, r.period.month)} reports` },
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
    const accountId = str(fd, "accountId") || null;
    if (accountId && !(await prisma.bookkeepingAccount.count({ where: { id: accountId, clientId } }))) throw new ValidationError("That account isn't on this client's profile.");
    const saved = await staffUploadDocument(actor, {
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
    if (accountId) await prisma.document.update({ where: { id: saved.id }, data: { bookkeepingAccountId: accountId } });
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

export async function deliverApprovedAction(clientId: string, periodId: string, periodType: string | null, _prev: ActionState): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    const n = await deliverApprovedReports(actor, periodId, periodType);
    refresh(clientId);
    return `Delivered ${n} approved report${n === 1 ? "" : "s"} to the client's portal.`;
  });
}

// --- Business profile ---------------------------------------------------------------

export async function saveBusinessInfoAction(clientId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    const num = (k: string) => (str(fd, k) ? Number(str(fd, k)) : null);
    await saveBusinessInfo(actor, clientId, {
      legalName: str(fd, "legalName"),
      dba: str(fd, "dba"),
      ein: str(fd, "ein"),
      businessAddress1: str(fd, "businessAddress1"),
      businessAddress2: str(fd, "businessAddress2"),
      businessCity: str(fd, "businessCity"),
      businessState: str(fd, "businessState"),
      businessPostalCode: str(fd, "businessPostalCode"),
      businessEmail: str(fd, "businessEmail"),
      contactName: str(fd, "contactName"),
      contactTitle: str(fd, "contactTitle"),
      contactPhone: str(fd, "contactPhone"),
      businessStartDate: localDate(fd, "businessStartDate"),
      entityType: str(fd, "entityType") || null,
      fiscalYearEnd: num("fiscalYearEnd"),
      workingYear: num("workingYear"),
      accountingBasis: str(fd, "accountingBasis") || null,
      payrollAccessStatus: str(fd, "payrollAccessStatus") || null,
      payrollReports: fd.getAll("payrollReports").map(String),
    });
    refresh(clientId);
    return "Business profile saved.";
  });
}

export async function revealEinAction(clientId: string, _prev: ActionState): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => `EIN: ${await revealEin(actor, clientId)} (this view was logged)`);
}

export async function saveAccountAction(clientId: string, accountId: string | null, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    await saveAccount(actor, clientId, accountId, {
      institution: str(fd, "institution"),
      accountType: str(fd, "accountType"),
      last4: str(fd, "last4"),
      nickname: str(fd, "nickname"),
      loginUrl: str(fd, "loginUrl"),
      accessStatus: str(fd, "accessStatus"),
      accessNote: str(fd, "accessNote"),
      active: str(fd, "active") !== "false",
    });
    refresh(clientId);
    return accountId ? "Account updated." : "Account added.";
  });
}

export async function saveBillingAction(clientId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    await saveBilling(actor, clientId, {
      monthlyFee: str(fd, "monthlyFee"),
      billingStartDate: localDate(fd, "billingStartDate"),
      billingDay: str(fd, "billingDay") ? Number(str(fd, "billingDay")) : null,
      paymentStatus: str(fd, "paymentStatus"),
      squareCustomerId: str(fd, "squareCustomerId"),
      notes: str(fd, "notes"),
    });
    refresh(clientId);
    return "Billing saved.";
  });
}

export async function recordAuthorizationAction(clientId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    await recordChargeAuthorization(actor, clientId, {
      amount: str(fd, "amount"),
      startDate: localDate(fd, "startDate"),
      method: str(fd, "method"),
      authorizedByName: str(fd, "authorizedByName"),
      authorizedAt: localDate(fd, "authorizedAt"),
      evidenceDocumentId: str(fd, "evidenceDocumentId") || null,
    });
    refresh(clientId);
    return "Recurring-charge authorization recorded.";
  });
}

export async function revokeAuthorizationAction(clientId: string, id: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    await revokeChargeAuthorization(actor, clientId, id, str(fd, "reason"));
    refresh(clientId);
    return "Authorization ended.";
  });
}

export async function billingAccessAction(userId: string, allowed: boolean, _prev: ActionState): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    await setBillingAccess(actor, userId, allowed);
    revalidatePath("/settings");
    return allowed ? "Billing access granted." : "Billing access removed.";
  });
}
