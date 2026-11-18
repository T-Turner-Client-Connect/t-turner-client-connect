import "server-only";
import { prisma } from "@/lib/prisma";
import { audit } from "@/lib/audit";
import type { Actor } from "@/lib/auth/actor";
import { ValidationError } from "./clients";

/**
 * State compliance (internal to the office). Each business records where it is registered and the
 * recurring state filings it owes — each with ITS state's own due month and day (nothing assumes one
 * national deadline). A filing record exists for every period from the first tracked year through the
 * next one due, so a missed year can't silently disappear.
 *
 * - Office reminders (never client messages): 90, 60, 30, 15 and 7 days before the due date and on it;
 *   an open filing past due is reminded against its final deadline (e.g. a forfeiture date) too. One
 *   office task per filing, kept up to date.
 * - Overdue is shown automatically for any open filing past its due date.
 * - A filing is completed only by a person, with evidence: the date filed plus a confirmation number
 *   or the uploaded confirmation. Coetha can change working statuses but never completes a filing.
 * - Completing a filing (or marking it not required) creates the next period.
 * - Urgent stays on until the filing is completed or found not required.
 */

export const STATES = ["AL", "AK", "AZ", "AR", "CA", "CO", "CT", "DE", "DC", "FL", "GA", "HI", "ID", "IL", "IN", "IA", "KS", "KY", "LA", "ME", "MD", "MA", "MI", "MN", "MS", "MO", "MT", "NE", "NV", "NH", "NJ", "NM", "NY", "NC", "ND", "OH", "OK", "OR", "PA", "RI", "SC", "SD", "TN", "TX", "UT", "VT", "VA", "WA", "WV", "WI", "WY"] as const;
export const CATEGORIES = { ANNUAL_REPORT: "Annual report", BUSINESS_LICENSE: "Business license", FRANCHISE_TAX: "Franchise / privilege tax", PERSONAL_PROPERTY: "Personal property return", REGISTERED_AGENT: "Registered agent", OTHER: "Other" } as const;
export const FREQUENCIES = { ANNUAL: "Every year", BIENNIAL: "Every two years" } as const;
export const STATUS_LABEL = { NOT_STARTED: "Not Started", IN_PROGRESS: "In Progress", WAITING_ON_CLIENT: "Waiting on Client", READY_TO_FILE: "Ready to File", FILED: "Filed", OVERDUE: "Overdue", NOT_REQUIRED: "Not Required" } as const;
export const WORKING_STATUSES = ["NOT_STARTED", "IN_PROGRESS", "WAITING_ON_CLIENT", "READY_TO_FILE"] as const;
export const REMINDER_DAYS = [90, 60, 30, 15, 7, 0] as const;
const FINAL_REMINDER_DAYS = [30, 15, 7, 0] as const;
const CLOSED = ["FILED", "NOT_REQUIRED"];
const DAY = 86_400_000;

const ymd = (d: Date) => d.toISOString().slice(0, 10);
const toDate = (s: string) => new Date(`${s}T00:00:00Z`);
const todayCentral = () => new Date().toLocaleDateString("en-CA", { timeZone: "America/Chicago" });
const isYmd = (s: unknown): s is string => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);
const clean = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) || null : null);

/** The due date of a period: that year's month and day (the last day of the month when the day is past its end). */
export function dueDateFor(period: number, dueMonth: number, dueDay: number) {
  const last = new Date(Date.UTC(period, dueMonth, 0)).getUTCDate();
  return new Date(Date.UTC(period, dueMonth - 1, Math.min(dueDay, last)));
}

/** What the office sees: the stored status, or Overdue for an open filing past its due date. */
export function effectiveStatus(f: { status: string; dueDate: Date }, today = todayCentral()) {
  if (!CLOSED.includes(f.status) && ymd(f.dueDate) < today) return "OVERDUE";
  return f.status;
}

async function assertStaff(actor: Actor) {
  if (!actor?.id) throw new ValidationError("Sign in again.");
}

// --- Registrations and requirements -------------------------------------------------------------

export async function addRegistration(actor: Actor, clientId: string, input: { state: string; kind?: string; entityId?: string; agency?: string; formedOn?: string; note?: string }) {
  await assertStaff(actor);
  const state = String(input.state ?? "").toUpperCase();
  if (!(STATES as readonly string[]).includes(state)) throw new ValidationError("Choose the state.");
  const kind = input.kind === "FOREIGN" ? "FOREIGN" : "FORMATION";
  const entityId = clean(input.entityId, 40);
  // One registration per state and ID for a business: the same one is never added twice.
  const dup = await prisma.complianceRegistration.findFirst({ where: { clientId, state, archivedAt: null, ...(entityId ? { entityId } : {}) } });
  if (dup) throw new ValidationError(`This business already has a ${state} registration${dup.entityId ? ` (${dup.entityId})` : ""}.`);
  const r = await prisma.complianceRegistration.create({ data: { clientId, state, kind, entityId, agency: clean(input.agency, 160), formedOn: isYmd(input.formedOn) ? toDate(input.formedOn) : null, note: clean(input.note, 500), createdById: actor.id } });
  await audit(prisma, { actorId: actor.id, action: "compliance.registration_added", entityType: "ComplianceRegistration", entityId: r.id, clientId, details: { state, kind, entityId } });
  return r;
}

export async function addRequirement(actor: Actor, clientId: string, input: { state: string; registrationId?: string | null; category: string; name: string; agency?: string; filingUrl?: string; frequency?: string; dueMonth: number; dueDay: number; startYear: number; note?: string }) {
  await assertStaff(actor);
  const state = String(input.state ?? "").toUpperCase();
  if (!(STATES as readonly string[]).includes(state)) throw new ValidationError("Choose the state.");
  if (!(input.category in CATEGORIES)) throw new ValidationError("Choose what kind of filing it is.");
  const name = clean(input.name, 160);
  if (!name) throw new ValidationError("Name the filing (e.g. Form 1 Annual Report).");
  const dueMonth = Number(input.dueMonth), dueDay = Number(input.dueDay), startYear = Number(input.startYear);
  if (!(dueMonth >= 1 && dueMonth <= 12) || !(dueDay >= 1 && dueDay <= 31)) throw new ValidationError("Enter the month and day this state sets as the due date.");
  if (!(startYear >= 2000 && startYear <= 2100)) throw new ValidationError("Enter the first year to track.");
  const frequency = input.frequency === "BIENNIAL" ? "BIENNIAL" : "ANNUAL";
  const url = clean(input.filingUrl, 300);
  if (url && !/^https:\/\//i.test(url)) throw new ValidationError("The filing website must start with https://");
  const reg = input.registrationId ? await prisma.complianceRegistration.findFirst({ where: { id: input.registrationId, clientId } }) : null;
  const dup = await prisma.complianceRequirement.findFirst({ where: { clientId, state, name: { equals: name, mode: "insensitive" }, archivedAt: null } });
  if (dup) throw new ValidationError(`“${name}” is already tracked for ${state}.`);
  const r = await prisma.complianceRequirement.create({ data: { clientId, registrationId: reg?.id ?? null, state, category: input.category, name, agency: clean(input.agency, 160), filingUrl: url, frequency, dueMonth, dueDay, startYear, note: clean(input.note, 500), createdById: actor.id } });
  await audit(prisma, { actorId: actor.id, action: "compliance.requirement_added", entityType: "ComplianceRequirement", entityId: r.id, clientId, details: { state, name, dueMonth, dueDay, frequency, startYear } });
  await ensureFilings(r.id);
  return r;
}

/** Every period from the first tracked year through the next one due exists (idempotent). */
export async function ensureFilings(requirementId: string, today = todayCentral()) {
  const r = await prisma.complianceRequirement.findUniqueOrThrow({ where: { id: requirementId } });
  if (r.archivedAt) return;
  const step = r.frequency === "BIENNIAL" ? 2 : 1;
  for (let p = r.startYear; p <= r.startYear + 200; p += step) {
    const due = dueDateFor(p, r.dueMonth, r.dueDay);
    await prisma.complianceFiling.upsert({ where: { requirementId_period: { requirementId: r.id, period: p } }, create: { requirementId: r.id, clientId: r.clientId, period: p, dueDate: due }, update: {} });
    if (ymd(due) >= today) break; // the next one due exists; later ones come as each is completed
  }
}

// --- Working a filing ---------------------------------------------------------------------------

async function filingFor(clientId: string, filingId: string) {
  const f = await prisma.complianceFiling.findFirst({ where: { id: filingId, clientId }, include: { requirement: true } });
  if (!f) throw new ValidationError("That filing isn't on file for this client.");
  return f;
}

/** A working status (never Filed: completing takes evidence). Used by staff and by Coetha. */
export async function setFilingStatus(actor: Actor, clientId: string, filingId: string, status: string, note?: string, by = "staff") {
  if (!(WORKING_STATUSES as readonly string[]).includes(status)) throw new ValidationError(status === "FILED" ? "A filing is completed only with the date filed and its confirmation." : "Choose a status.");
  const f = await filingFor(clientId, filingId);
  if (CLOSED.includes(f.status)) throw new ValidationError("That filing is already closed.");
  await prisma.complianceFiling.update({ where: { id: f.id }, data: { status, ...(note?.trim() ? { note: note.trim().slice(0, 1000) } : {}) } });
  await audit(prisma, { actorId: actor.id, action: "compliance.status_changed", entityType: "ComplianceFiling", entityId: f.id, clientId, details: { from: f.status, to: status, by, period: f.period, name: f.requirement.name } });
}

/** Records a later state deadline (e.g. a forfeiture date from a notice) and/or marks the filing urgent. */
export async function flagFiling(actor: Actor, clientId: string, filingId: string, input: { finalDeadline?: string | null; urgent?: boolean; reason?: string }) {
  const f = await filingFor(clientId, filingId);
  if (CLOSED.includes(f.status)) throw new ValidationError("That filing is already closed.");
  const data: { finalDeadline?: Date | null; urgent?: boolean; urgentReason?: string | null } = {};
  if (input.finalDeadline !== undefined) data.finalDeadline = isYmd(input.finalDeadline) ? toDate(input.finalDeadline) : null;
  if (input.urgent) { data.urgent = true; data.urgentReason = clean(input.reason, 500) ?? f.urgentReason ?? "Marked urgent"; }
  await prisma.complianceFiling.update({ where: { id: f.id }, data });
  await audit(prisma, { actorId: actor.id, action: "compliance.flagged", entityType: "ComplianceFiling", entityId: f.id, clientId, details: { ...input, period: f.period, name: f.requirement.name } });
}

/**
 * The office completes a filing: the date filed, and a confirmation number or the uploaded
 * confirmation (or both). Only a person — never Coetha. Clears urgent, closes the reminder task and
 * creates the next period.
 */
export async function completeFiling(actor: Actor & { coetha?: boolean }, clientId: string, filingId: string, input: { filedOn: string; confirmationNumber?: string; documentId?: string | null; note?: string }) {
  if ((actor as { coetha?: boolean }).coetha) throw new ValidationError("Coetha never marks a filing completed; the office records it with its confirmation.");
  const f = await filingFor(clientId, filingId);
  if (f.status === "FILED") return f;
  if (!isYmd(input.filedOn) || input.filedOn > todayCentral()) throw new ValidationError("Enter the date it was filed (not in the future).");
  const confirmationNumber = clean(input.confirmationNumber, 80);
  const doc = input.documentId ? await prisma.document.findFirst({ where: { id: input.documentId, clientId, deletedAt: null }, select: { id: true } }) : null;
  if (!confirmationNumber && !doc) throw new ValidationError("Add the confirmation number or upload the filing confirmation. A filing is never marked completed without evidence.");
  const done = await prisma.complianceFiling.update({ where: { id: f.id }, data: { status: "FILED", filedOn: toDate(input.filedOn), confirmationNumber, confirmationDocumentId: doc?.id ?? null, completedById: actor.id, completedAt: new Date(), urgent: false, ...(input.note?.trim() ? { note: input.note.trim().slice(0, 1000) } : {}) } });
  await audit(prisma, { actorId: actor.id, action: "compliance.filed", entityType: "ComplianceFiling", entityId: f.id, clientId, details: { period: f.period, name: f.requirement.name, filedOn: input.filedOn, confirmationNumber, documentId: doc?.id ?? null } });
  await closeTask(f.id);
  await ensureNext(f.requirementId, f.period);
  return done;
}

/** Not required for this period (e.g. the business dissolved): Admin only, with the reason. */
export async function markNotRequired(actor: Actor, clientId: string, filingId: string, reason: string) {
  if (actor.role !== "ADMIN") throw new ValidationError("Only an Admin marks a filing not required.");
  const why = reason.trim();
  if (why.length < 5) throw new ValidationError("Give the reason.");
  const f = await filingFor(clientId, filingId);
  await prisma.complianceFiling.update({ where: { id: f.id }, data: { status: "NOT_REQUIRED", urgent: false, completedById: actor.id, completedAt: new Date(), note: why.slice(0, 1000) } });
  await audit(prisma, { actorId: actor.id, action: "compliance.not_required", entityType: "ComplianceFiling", entityId: f.id, clientId, details: { period: f.period, name: f.requirement.name, reason: why.slice(0, 300) } });
  await closeTask(f.id);
  await ensureNext(f.requirementId, f.period);
}

async function ensureNext(requirementId: string, period: number) {
  const r = await prisma.complianceRequirement.findUniqueOrThrow({ where: { id: requirementId } });
  if (r.archivedAt) return;
  const next = period + (r.frequency === "BIENNIAL" ? 2 : 1);
  await prisma.complianceFiling.upsert({ where: { requirementId_period: { requirementId: r.id, period: next } }, create: { requirementId: r.id, clientId: r.clientId, period: next, dueDate: dueDateFor(next, r.dueMonth, r.dueDay) }, update: {} });
}

async function closeTask(filingId: string) {
  await prisma.task.updateMany({ where: { reminderKey: `compliance:${filingId}`, status: "OPEN" }, data: { status: "DONE", completedAt: new Date() } });
}

// --- Reminders (office only) ---------------------------------------------------------------------

/**
 * Daily: makes sure every requirement has its next period, then gives the office its reminders —
 * one task per open filing (Task.reminderKey), refreshed at 90/60/30/15/7 days and on the due date,
 * and against the final deadline once past due. Never contacts a client.
 */
export async function runComplianceReminders(opts: { today?: string } = {}) {
  const today = opts.today ?? todayCentral();
  for (const r of await prisma.complianceRequirement.findMany({ where: { archivedAt: null, client: { archivedAt: null } }, select: { id: true } })) await ensureFilings(r.id, today);
  const { ownerActor } = await import("./coetha-decisions");
  const owner = await ownerActor();
  if (!owner) return { reminded: 0 };
  const open = await prisma.complianceFiling.findMany({ where: { status: { notIn: CLOSED }, client: { archivedAt: null }, requirement: { archivedAt: null } }, include: { requirement: true, client: { select: { displayName: true, businessName: true } } } });
  let reminded = 0;
  const t = toDate(today).getTime();
  for (const f of open) {
    const days = Math.round((f.dueDate.getTime() - t) / DAY);
    const finalDays = f.finalDeadline ? Math.round((f.finalDeadline.getTime() - t) / DAY) : null;
    // The most urgent threshold reached and not yet given.
    const due = REMINDER_DAYS.filter((d) => days <= d && !f.remindersSent.includes(d));
    const fin = finalDays !== null && days < 0 ? FINAL_REMINDER_DAYS.filter((d) => finalDays <= d && !f.remindersSent.includes(1000 + d)) : [];
    if (!due.length && !fin.length && !(f.urgent && !f.remindersSent.includes(-1))) continue;
    const name = f.client.businessName || f.client.displayName;
    const status = effectiveStatus(f, today);
    const when = days < 0 ? `OVERDUE since ${ymd(f.dueDate)}` : days === 0 ? "due TODAY" : `due ${ymd(f.dueDate)} (${days} days)`;
    const title = `${f.urgent || status === "OVERDUE" ? "URGENT: " : ""}${name}: ${f.requirement.state} ${f.requirement.name} ${f.period} — ${when}`.slice(0, 200);
    const details = [`${f.requirement.agency ?? "State agency"}${f.requirement.filingUrl ? ` · ${f.requirement.filingUrl}` : ""}`, f.finalDeadline ? `Final deadline: ${ymd(f.finalDeadline)}${finalDays !== null ? ` (${finalDays} days)` : ""}` : null, f.urgentReason ? `Urgent: ${f.urgentReason}` : null, `Status: ${STATUS_LABEL[status as keyof typeof STATUS_LABEL] ?? status}`, "Internal reminder — nothing is sent to the client."].filter(Boolean).join("\n");
    const priority = f.urgent || days <= 15 ? "HIGH" : "NORMAL";
    const key = `compliance:${f.id}`;
    const existing = await prisma.task.findUnique({ where: { reminderKey: key } });
    if (existing) await prisma.task.update({ where: { id: existing.id }, data: { title, details, priority, dueAt: f.finalDeadline && days < 0 ? f.finalDeadline : f.dueDate, status: "OPEN", completedAt: null } });
    else await prisma.task.create({ data: { title, details, priority, dueAt: f.finalDeadline && days < 0 ? f.finalDeadline : f.dueDate, clientId: f.clientId, assigneeId: owner.id, createdById: owner.id, reminderKey: key } });
    const sent = [...f.remindersSent, ...due, ...fin.map((d) => 1000 + d), ...(f.urgent ? [-1] : [])];
    await prisma.complianceFiling.update({ where: { id: f.id }, data: { remindersSent: [...new Set(sent)] } });
    await audit(prisma, { actorId: null, action: "compliance.reminder", entityType: "ComplianceFiling", entityId: f.id, clientId: f.clientId, details: { days, finalDays, thresholds: due, final: fin, urgent: f.urgent } });
    reminded++;
  }
  return { reminded };
}

// --- Views --------------------------------------------------------------------------------------

export async function clientCompliance(clientId: string) {
  const [registrations, requirements] = await Promise.all([
    prisma.complianceRegistration.findMany({ where: { clientId, archivedAt: null }, orderBy: { createdAt: "asc" } }),
    prisma.complianceRequirement.findMany({ where: { clientId, archivedAt: null }, orderBy: [{ state: "asc" }, { name: "asc" }], include: { filings: { orderBy: { period: "desc" } } } }),
  ]);
  return { registrations, requirements };
}

/** Outstanding filings across clients: urgent and overdue first, then by due date (the owner's dashboard). */
export async function outstandingFilings(opts: { withinDays?: number; today?: string } = {}) {
  const today = opts.today ?? todayCentral();
  const horizon = new Date(toDate(today).getTime() + (opts.withinDays ?? 90) * DAY);
  const rows = await prisma.complianceFiling.findMany({
    where: { status: { notIn: CLOSED }, client: { archivedAt: null }, requirement: { archivedAt: null }, OR: [{ urgent: true }, { dueDate: { lte: horizon } }] },
    include: { requirement: { select: { state: true, name: true, agency: true, filingUrl: true } }, client: { select: { id: true, displayName: true, businessName: true } } },
    orderBy: { dueDate: "asc" },
  });
  return rows
    .map((f) => ({ ...f, effective: effectiveStatus(f, today) }))
    .sort((a, b) => Number(b.urgent || b.effective === "OVERDUE") - Number(a.urgent || a.effective === "OVERDUE") || a.dueDate.getTime() - b.dueDate.getTime());
}

// --- Coetha ---------------------------------------------------------------------------------------

export const COMPLIANCE_TOOL = {
  name: "state_compliance",
  description: "This business's state compliance: its state registrations, recurring state filings (each with its own state's due date) and every filing period with its status, due date, any final deadline (e.g. forfeiture) and urgent flag. To move a filing along, pass updates [{ filingId, status, note }] with status NOT_STARTED, IN_PROGRESS, WAITING_ON_CLIENT or READY_TO_FILE. You can never mark a filing Filed or Not Required — the office completes it with the date filed and its confirmation. Nothing here is ever sent to the client.",
  input_schema: { type: "object" as const, properties: { updates: { type: "array", items: { type: "object", properties: { filingId: { type: "string" }, status: { type: "string" }, note: { type: "string" } }, required: ["filingId", "status"] } } } },
};

export async function runComplianceTool(actor: Actor, clientId: string, input: { updates?: { filingId: string; status: string; note?: string }[] }) {
  const results: string[] = [];
  for (const u of input.updates ?? []) {
    try { await setFilingStatus(actor, clientId, u.filingId, u.status, u.note, "Coetha"); results.push(`${u.filingId}: ${u.status}`); }
    catch (e) { results.push(`${u.filingId}: not changed — ${e instanceof Error ? e.message : "error"}`); }
  }
  const { registrations, requirements } = await clientCompliance(clientId);
  const today = todayCentral();
  return {
    ...(results.length ? { updated: results } : {}),
    registrations: registrations.map((r) => ({ state: r.state, kind: r.kind, entityId: r.entityId, agency: r.agency })),
    filings: requirements.flatMap((q) => q.filings.map((f) => ({ filingId: f.id, state: q.state, filing: q.name, period: f.period, dueDate: ymd(f.dueDate), finalDeadline: f.finalDeadline ? ymd(f.finalDeadline) : null, status: STATUS_LABEL[effectiveStatus(f, today) as keyof typeof STATUS_LABEL], workingStatus: STATUS_LABEL[f.status as keyof typeof STATUS_LABEL], urgent: f.urgent ? f.urgentReason ?? true : false, filedOn: f.filedOn ? ymd(f.filedOn) : null }))),
  };
}
