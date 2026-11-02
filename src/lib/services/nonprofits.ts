import "server-only";
import { prisma } from "@/lib/prisma";
import { audit } from "@/lib/audit";
import type { Actor } from "@/lib/auth/actor";
import { fifteenthAfter, nextBusinessDay, officeToday, daysBetween } from "@/lib/tax/deadlines";
import { ValidationError } from "./clients";
import { createFiling, setFilingStatusByStaff } from "./tax";
import { queuePortalNotification } from "./notifications";

/**
 * Nonprofit annual federal filings. Rules as stated by the IRS (checked Oct 31, 2026):
 * - Who files what: https://www.irs.gov/charities-non-profits/annual-exempt-organization-return-who-must-file
 * - Due date (15th day of the 5th month after the tax year ends; next business day if a weekend or legal holiday):
 *   https://www.irs.gov/charities-non-profits/annual-exempt-organization-return-due-date
 * - Form 8868 gives an automatic 6-month extension for 990, 990-EZ and 990-PF — not for 990-N:
 *   https://www.irs.gov/charities-non-profits/extension-of-time-to-file-exempt-organization-returns
 * - Not filing for three consecutive years automatically revokes exempt status.
 * Staff choose the form; nothing here assumes a nonprofit qualifies for the 990-N.
 */
export const NONPROFIT_FORMS = {
  "990-N": { label: "Form 990-N (e-Postcard)", extendable: false, guide: "Only if gross receipts are normally $50,000 or less. Not for supporting organizations or private foundations. Can't be extended." },
  "990-EZ": { label: "Form 990-EZ", extendable: true, guide: "Gross receipts under $200,000 and total assets under $500,000 at year end." },
  "990": { label: "Form 990", extendable: true, guide: "Gross receipts of $200,000 or more, or total assets of $500,000 or more at year end." },
  "990-PF": { label: "Form 990-PF", extendable: true, guide: "Private foundations, regardless of size." },
  OTHER: { label: "Other filing", extendable: false, guide: "Name the form; confirm its due date and extension rules separately." },
} as const;
export type NonprofitForm = keyof typeof NONPROFIT_FORMS;
export const IRS_SOURCES = [
  "https://www.irs.gov/charities-non-profits/annual-exempt-organization-return-who-must-file",
  "https://www.irs.gov/charities-non-profits/annual-exempt-organization-return-due-date",
  "https://www.irs.gov/charities-non-profits/extension-of-time-to-file-exempt-organization-returns",
];

/** The tax year is named for the year it begins. Returns the date its federal return is due (with rollover). */
export function nonprofitDueDate(taxYear: number, fiscalYearEnd: number | null, extended = false) {
  const endMonth = fiscalYearEnd ?? 12;
  const endYear = endMonth === 12 ? taxYear : taxYear + 1;
  return nextBusinessDay(fifteenthAfter(endYear, endMonth, 5 + (extended ? 6 : 0)));
}

/** The most recent tax year that has ended as of today (Chicago). */
export function latestEndedTaxYear(fiscalYearEnd: number | null, today = officeToday()) {
  const endMonth = fiscalYearEnd ?? 12;
  const [y, m] = today.split("-").map(Number);
  // A year ending in endMonth of year E belongs to tax year E (December) or E-1 (fiscal).
  const endYear = m > endMonth ? y : y - 1;
  return endMonth === 12 ? endYear : endYear - 1;
}

export type Bucket = "COMPLETED" | "SUBMITTED" | "OVERDUE" | "DUE" | "UPCOMING" | "NOT_SET_UP";
export const BUCKETS: Record<Bucket, { label: string; tone: "green" | "navy" | "red" | "amber" | "gray" }> = {
  OVERDUE: { label: "Overdue", tone: "red" },
  DUE: { label: "Due within 30 days", tone: "amber" },
  SUBMITTED: { label: "Submitted — awaiting acceptance", tone: "navy" },
  UPCOMING: { label: "Upcoming", tone: "gray" },
  NOT_SET_UP: { label: "Needs information", tone: "amber" },
  COMPLETED: { label: "Accepted", tone: "green" },
};

const returnTypeFor = (p: { formType: string | null; otherForm: string | null }) => (p.formType === "OTHER" ? p.otherForm || "OTHER" : p.formType);

export const FILING_SERVICE = { YES: "Yes — TTurner files it", NO: "No", PENDING_AGREEMENT: "Pending agreement" } as const;
export type FilingService = keyof typeof FILING_SERVICE;

/**
 * Dashboard rows: one per nonprofit organization whose filings we handle (or
 * might — not recorded yet, or pending agreement, flagged for review), for its
 * latest ended tax year. Organizations we don't file for, and prospects we
 * haven't agreed to file for (e.g. Nonprofit Interest formation inquiries), are left out.
 */
export async function nonprofitDashboard(today = officeToday()) {
  const clients = await prisma.client.findMany({
    where: {
      clientType: "NONPROFIT",
      archivedAt: null,
      OR: [
        { nonprofitProfile: { filingService: "YES" } },
        { nonprofitProfile: { filingService: "PENDING_AGREEMENT" } },
        { status: { not: "PROSPECT" }, OR: [{ nonprofitProfile: null }, { nonprofitProfile: { filingService: null } }] },
      ],
    },
    select: { id: true, displayName: true, businessName: true, fiscalYearEnd: true, assignedTo: { select: { id: true, name: true } }, nonprofitProfile: true },
    orderBy: { displayName: "asc" },
  });
  const rows = [];
  for (const c of clients) {
    // Missing facts are flagged for review, never assumed (no default December year-end).
    const missing: string[] = [];
    const service = (c.nonprofitProfile?.filingService ?? null) as FilingService | null;
    if (!service) missing.push("Whether TTurner handles its annual filings isn't recorded");
    else if (service === "PENDING_AGREEMENT") missing.push("Filing agreement pending — confirm before tracking its deadline");
    // Flagged for review without hiding the deadline.
    const review = c.assignedTo ? [] : ["No staff assigned"];
    if (!c.fiscalYearEnd) missing.push("Fiscal year-end not recorded");
    if (!c.nonprofitProfile?.formType) missing.push("Required return not chosen");
    else if (!c.nonprofitProfile.formBasis) missing.push("How the form was determined isn't recorded");
    if (!c.fiscalYearEnd) {
      // An earlier version assumed a December year-end when none was recorded. Anything it
      // produced (filings, reminders) is flagged until someone confirms the real year-end.
      const [assumedFilings, assumedReminders] = await Promise.all([
        prisma.filingRecord.findMany({ where: { clientId: c.id, jurisdiction: "FEDERAL", returnType: { in: ["990-N", "990-EZ", "990", "990-PF", "8868"] } }, select: { taxYear: true, returnType: true } }),
        prisma.auditLog.count({ where: { action: "nonprofit.reminder", clientId: c.id } }),
      ]);
      if (assumedFilings.length) missing.push(`Filing record${assumedFilings.length === 1 ? "" : "s"} (${assumedFilings.map((f) => `${f.returnType} ${f.taxYear}`).join(", ")}) may use a tax year based on an assumed December year-end — verify`);
      if (assumedReminders) missing.push(`${assumedReminders} reminder${assumedReminders === 1 ? " was" : "s were"} sent using an assumed December deadline — verify`);
      rows.push({ client: c, service, profile: c.nonprofitProfile, taxYear: null, returnType: null, filing: null, extension: null, extended: false, due: null, days: null, bucket: "NOT_SET_UP" as Bucket, missing, review });
      continue;
    }
    const taxYear = latestEndedTaxYear(c.fiscalYearEnd, today);
    const p = c.nonprofitProfile;
    const returnType = p ? returnTypeFor(p) : null;
    const [filing, extension] = returnType
      ? await Promise.all([
          prisma.filingRecord.findFirst({ where: { clientId: c.id, taxYear, returnType, jurisdiction: "FEDERAL", filingType: "ORIGINAL" }, include: { events: { orderBy: { createdAt: "desc" }, take: 10 } } }),
          prisma.filingRecord.findFirst({ where: { clientId: c.id, taxYear, returnType: "8868", jurisdiction: "FEDERAL", filingType: "EXTENSION" } }),
        ])
      : [null, null];
    const extendable = p?.formType ? NONPROFIT_FORMS[p.formType as NonprofitForm]?.extendable ?? false : false;
    // Only an ACCEPTED extension moves the deadline.
    const extended = extendable && extension?.filingStatus === "ACCEPTED";
    const due = nonprofitDueDate(taxYear, c.fiscalYearEnd, extended);
    const days = daysBetween(today, due);
    let bucket: Bucket;
    if (missing.length) bucket = "NOT_SET_UP";
    else if (filing?.filingStatus === "ACCEPTED") bucket = "COMPLETED";
    else if (filing && ["SUBMITTED", "PENDING_ACKNOWLEDGMENT"].includes(filing.filingStatus)) bucket = "SUBMITTED";
    else if (days < 0) bucket = "OVERDUE";
    else if (days <= 30) bucket = "DUE";
    else bucket = "UPCOMING";
    rows.push({ client: c, service, profile: p, taxYear: taxYear as number | null, returnType, filing, extension, extended, due: due as string | null, days: days as number | null, bucket, missing, review });
  }
  const order: Bucket[] = ["OVERDUE", "DUE", "NOT_SET_UP", "SUBMITTED", "UPCOMING", "COMPLETED"];
  return rows.sort((a, b) => order.indexOf(a.bucket) - order.indexOf(b.bucket) || (a.days ?? 0) - (b.days ?? 0));
}

export async function saveNonprofitProfile(actor: Actor, clientId: string, input: { formType: string; otherForm?: string; formBasis?: string; reminderDays?: string; notifyClient?: boolean }) {
  const c = await prisma.client.findUnique({ where: { id: clientId } });
  if (!c || c.clientType !== "NONPROFIT") throw new ValidationError("Choose a nonprofit client.");
  if (!(input.formType in NONPROFIT_FORMS)) throw new ValidationError("Choose the required federal return.");
  if (input.formType === "OTHER" && !input.otherForm?.trim()) throw new ValidationError("Name the other filing.");
  if (!input.formBasis?.trim() || input.formBasis.trim().length < 5) throw new ValidationError("Record how you determined the form (for example, gross receipts and assets, or private-foundation status).");
  const days = (input.reminderDays ?? "60,30,7").split(/[,\s]+/).filter(Boolean).map(Number);
  if (!days.length || days.some((d) => !Number.isInteger(d) || d < 1 || d > 180)) throw new ValidationError("Reminder days must be whole numbers from 1 to 180, separated by commas.");
  const data = { formType: input.formType, otherForm: input.formType === "OTHER" ? input.otherForm!.trim().slice(0, 40) : null, formBasis: input.formBasis.trim().slice(0, 300), reminderDays: [...new Set(days)].sort((a, b) => b - a), notifyClient: !!input.notifyClient, updatedById: actor.id };
  const before = await prisma.nonprofitProfile.findUnique({ where: { clientId } });
  await prisma.nonprofitProfile.upsert({ where: { clientId }, create: { clientId, ...data }, update: data });
  await audit(prisma, { actorId: actor.id, action: "nonprofit.profile_saved", entityType: "Client", entityId: clientId, clientId, details: { before: before ? { formType: before.formType, formBasis: before.formBasis } : null, after: { formType: data.formType, formBasis: data.formBasis } } });
}

async function ensureFiling(actor: Actor, clientId: string, taxYear: number) {
  const p = await prisma.nonprofitProfile.findUnique({ where: { clientId } });
  if (!p?.formType) throw new ValidationError("Choose the required federal return first.");
  const returnType = returnTypeFor(p)!;
  return (
    (await prisma.filingRecord.findFirst({ where: { clientId, taxYear, returnType, jurisdiction: "FEDERAL", filingType: "ORIGINAL" } })) ??
    (await createFiling(actor, { clientId, taxYear, returnType, jurisdiction: "FEDERAL", filingType: "ORIGINAL", method: "ELECTRONIC" }))
  );
}

/** Mark Filed: Submitted (with date/time, staff, confirmation number or acknowledgment). Never claims acceptance. */
export async function markNonprofitFiled(actor: Actor, clientId: string, taxYear: number, input: { filedAt: Date | null; confirmation?: string; ackDocumentId?: string | null }) {
  if (!input.filedAt) throw new ValidationError("Enter the date and time it was filed.");
  if (!input.confirmation?.trim() && !input.ackDocumentId) throw new ValidationError("Enter the confirmation/submission number or choose the uploaded acknowledgment.");
  const f = await ensureFiling(actor, clientId, taxYear);
  await setFilingStatusByStaff(actor, f.id, { status: "SUBMITTED", eventAt: input.filedAt, filingReference: input.confirmation ?? null, evidenceDocumentId: input.ackDocumentId ?? null, verificationNote: "Marked filed in the nonprofit tracker" });
  return f.id;
}

/** Accepted (or Rejected) only with the acknowledgment or a described verification — handled by the filing rules. */
export async function recordNonprofitOutcome(actor: Actor, clientId: string, taxYear: number, input: { outcome: "ACCEPTED" | "REJECTED"; at: Date | null; evidenceDocumentId?: string | null; note?: string; rejectionCodes?: string }) {
  const f = await ensureFiling(actor, clientId, taxYear);
  if (f.filingStatus === "NOT_SUBMITTED") throw new ValidationError("Mark it filed (submitted) first.");
  await setFilingStatusByStaff(actor, f.id, { status: input.outcome, eventAt: input.at, evidenceDocumentId: input.evidenceDocumentId ?? null, verificationNote: input.note ?? null, rejectionCodes: input.rejectionCodes ?? null });
}

/** A logged correction (confirmation number or the record's notes). The status history is never rewritten. */
export async function correctNonprofitFiling(actor: Actor, clientId: string, filingId: string, input: { confirmation?: string; reason: string }) {
  const f = await prisma.filingRecord.findFirst({ where: { id: filingId, clientId } });
  if (!f) throw new ValidationError("Filing not found.");
  if (input.reason.trim().length < 5) throw new ValidationError("Say what was wrong and why it's being corrected.");
  await prisma.filingRecord.update({ where: { id: f.id }, data: { filingReference: input.confirmation?.trim() || f.filingReference, notes: [f.notes, `Correction ${new Date().toISOString()}: ${input.reason.trim()}`].filter(Boolean).join("\n").slice(0, 2000) } });
  await audit(prisma, { actorId: actor.id, action: "nonprofit.filing_corrected", entityType: "FilingRecord", entityId: f.id, clientId, details: { before: { filingReference: f.filingReference }, after: { filingReference: input.confirmation?.trim() || f.filingReference }, reason: input.reason.trim() } });
}

/**
 * Advance reminders (from the 10-minute schedule, once per reminder day):
 * a task for the assigned staff member and, when enabled, a portal notice to
 * the client's owner logins. Each reminder is sent once.
 */
export async function runNonprofitReminders(today = officeToday()) {
  const rows = await nonprofitDashboard(today);
  let sent = 0;
  const owner = await prisma.ownerAccess.findFirst({ where: { isPrimary: true, revokedAt: null }, select: { userId: true } });
  for (const r of rows) {
    // Only organizations whose filings we handle get reminders.
    if (r.service !== "YES" || !r.profile?.formType || r.days === null || r.taxYear === null || r.bucket === "COMPLETED" || r.bucket === "SUBMITTED") continue;
    if (!r.profile.reminderDays.includes(r.days)) continue;
    const key = `nonprofit-reminder:${r.client.id}:${r.taxYear}:${r.days}`;
    if (await prisma.auditLog.count({ where: { action: "nonprofit.reminder", entityId: key } })) continue;
    const creator = r.client.assignedTo?.id ?? owner?.userId;
    if (creator) {
      await prisma.task.create({ data: { title: `${r.client.businessName || r.client.displayName}: ${r.returnType} for ${r.taxYear} due ${r.due} (${r.days} days)`, details: "Nonprofit filing reminder. Mark it filed in Taxes → Nonprofit filings when submitted; record Accepted only with the IRS acknowledgment.", clientId: r.client.id, assigneeId: r.client.assignedTo?.id ?? null, createdById: creator, priority: r.days <= 7 ? "HIGH" : "NORMAL" } });
    }
    if (r.profile.notifyClient) {
      const owners = await prisma.portalAccess.findMany({ where: { clientId: r.client.id, role: "OWNER", revokedAt: null }, select: { portalUserId: true } });
      for (const o of owners) await queuePortalNotification(o.portalUserId, "DEADLINE_REMINDER", key);
    }
    await prisma.auditLog.create({ data: { action: "nonprofit.reminder", entityType: "Reminder", entityId: key, clientId: r.client.id, details: { days: r.days, due: r.due, client: r.profile.notifyClient } } });
    sent++;
  }
  return { sent };
}
