import "server-only";
import { timingSafeEqual } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { audit } from "@/lib/audit";
import { assertAdmin, ForbiddenError, type Actor } from "@/lib/auth/actor";
import { decryptSecret, encryptSecret, sign } from "@/lib/crypto";
import { requireClientAccess } from "@/lib/portal/access";
import type { PortalActor } from "@/lib/portal/session";
import { filingGroup } from "@/lib/document-types";
import { normalizeEmail } from "@/lib/normalize";
import { ValidationError } from "./clients";
import { assertNotDuplicate, portalVerified, retentionDate, sha256Of, storeDocumentFile } from "./documents";
import { jotformConfig } from "./contracts";
import { queueStaffAlert } from "./staff-alerts";

/**
 * My Tax Center. Questionnaire completion, document receipt, return
 * preparation, filing and agency acceptance are tracked separately: opening
 * a questionnaire never marks it complete, and uploading never marks a
 * return filed.
 */

export const FIRST_QUESTIONNAIRE_YEAR = 2022;
export const FIRST_RETRIEVE_YEAR = 2020;
export const currentYear = () => new Date().getFullYear();

export const DOCUMENTS_STATUS = { NOT_STARTED: "Not started", SOME_RECEIVED: "Some documents received", ALL_RECEIVED: "All documents received" } as const;

// --- Account verification ---------------------------------------------------

/** Past-year tax records need a proven email address or staff-confirmed identity. */
export const isPortalVerified = portalVerified;

async function requireVerified(user: PortalActor) {
  if (!(await isPortalVerified(user.id))) throw new ForbiddenError("Please verify your account first.");
}

/** Staff confirmed who a portal login belongs to (e.g. a call to the number on file). */
export async function confirmPortalIdentity(actor: Actor, clientId: string, portalUserId: string, note: string) {
  if (!note.trim()) throw new ValidationError("Describe how you confirmed who this is.");
  const access = await prisma.portalAccess.findFirst({ where: { clientId, portalUserId, revokedAt: null } });
  if (!access) throw new ValidationError("That login isn't connected to this client.");
  await prisma.portalUser.update({ where: { id: portalUserId }, data: { identityVerifiedAt: new Date(), identityVerifiedById: actor.id } });
  await audit(prisma, { actorId: actor.id, action: "portal.identity_confirmed", entityType: "PortalUser", entityId: portalUserId, clientId, details: { note: note.trim().slice(0, 300) } });
}

// --- Questionnaires ----------------------------------------------------------

/** Accepts a numeric Jotform form ID or a form link and returns the ID. */
export function parseJotformId(input: string) {
  const v = input.trim();
  if (!v) return null;
  if (/^\d{6,20}$/.test(v)) return v;
  try {
    const u = new URL(v);
    if (u.protocol !== "https:" || !/(^|\.)jotform\.com$/.test(u.hostname)) throw new Error();
    const id = u.pathname.split("/").filter(Boolean).find((p) => /^\d{6,20}$/.test(p));
    if (id) return id;
  } catch {
    /* fall through */
  }
  throw new ValidationError("Enter the numeric Jotform form ID or the form's jotform.com link.");
}

export async function saveQuestionnaire(actor: Actor, input: { taxYear: number; audience: string; title: string; jotformFormId: string; active: boolean }, id?: string) {
  assertAdmin(actor);
  if (!Number.isInteger(input.taxYear) || input.taxYear < 2000 || input.taxYear > currentYear() + 1) throw new ValidationError("Enter a valid tax year.");
  if (!["ALL", "INDIVIDUAL", "BUSINESS"].includes(input.audience)) throw new ValidationError("Choose who the questionnaire is for.");
  const data = {
    taxYear: input.taxYear,
    audience: input.audience,
    title: input.title.trim().slice(0, 160) || `${input.taxYear} Tax Questionnaire`,
    jotformFormId: parseJotformId(input.jotformFormId),
    active: input.active,
    updatedById: actor.id,
  };
  const q = id ? await prisma.taxQuestionnaire.update({ where: { id }, data }) : await prisma.taxQuestionnaire.create({ data });
  await audit(prisma, { actorId: actor.id, action: id ? "questionnaire.updated" : "questionnaire.created", entityType: "TaxQuestionnaire", entityId: q.id, details: { taxYear: q.taxYear, formId: q.jotformFormId } });
  return q;
}

/** The questionnaire a client should use for a year (their audience first, then "ALL"). */
export async function questionnaireFor(clientType: string, taxYear: number) {
  const audience = clientType === "INDIVIDUAL" ? "INDIVIDUAL" : "BUSINESS";
  const rows = await prisma.taxQuestionnaire.findMany({ where: { taxYear, active: true, audience: { in: [audience, "ALL"] } } });
  return rows.find((r) => r.audience === audience) ?? rows.find((r) => r.audience === "ALL") ?? null;
}

export function questionnaireYears() {
  const ys: number[] = [];
  for (let y = currentYear(); y >= FIRST_QUESTIONNAIRE_YEAR; y--) ys.push(y);
  return ys;
}

const refSig = (clientId: string, year: number) => sign(`questionnaire:${clientId}:${year}`).slice(0, 22);
export const questionnaireRef = (clientId: string, year: number) => `q.${clientId}.${year}.${refSig(clientId, year)}`;
export function parseQuestionnaireRef(ref: string) {
  const m = /^q\.([a-z0-9]+)\.(\d{4})\.([A-Za-z0-9_-]{22})$/.exec(ref.trim());
  if (!m) return null;
  const a = Buffer.from(m[3]);
  const b = Buffer.from(refSig(m[1], Number(m[2])));
  return a.length === b.length && timingSafeEqual(a, b) ? { clientId: m[1], taxYear: Number(m[2]) } : null;
}

/**
 * The Jotform link for this client and year, with a signed reference in the
 * hidden field so a submission can only be tied to this client and year.
 */
export async function questionnaireLink(user: PortalActor, clientId: string, taxYear: number) {
  await requireClientAccess(user.id, clientId, "tax");
  const client = await prisma.client.findUniqueOrThrow({ where: { id: clientId }, select: { clientType: true } });
  return questionnaireUrl(clientId, client.clientType, taxYear);
}

/** Callers must already have checked access to this client. */
export async function questionnaireUrl(clientId: string, clientType: string, taxYear: number) {
  const q = await questionnaireFor(clientType, taxYear);
  if (!q?.jotformFormId) return null;
  const c = jotformConfig();
  return `${c.formBase}/${encodeURIComponent(q.jotformFormId)}?${encodeURIComponent(c.refField)}=${encodeURIComponent(questionnaireRef(clientId, taxYear))}`;
}

type JotAnswer = { name?: string; text?: string; type?: string; answer?: unknown; prettyFormat?: string };
export type JotSubmission = { id?: string; form_id?: string; created_at?: string; answers?: Record<string, JotAnswer> };

async function fetchSubmission(submissionId: string): Promise<JotSubmission> {
  const c = jotformConfig();
  if (!c.apiKey) throw new ValidationError("Jotform isn't connected yet (JOTFORM_API_KEY), so the submission can't be read.");
  if (!/^\d{6,25}$/.test(submissionId)) throw new ValidationError("Enter the numeric Jotform submission ID.");
  const res = await fetch(`${c.apiBase}/submission/${submissionId}`, { headers: { APIKEY: c.apiKey } });
  if (res.status === 404) throw new ValidationError("Jotform didn't find that submission.");
  if (!res.ok) throw new ValidationError(`Jotform API error (HTTP ${res.status}).`);
  const sub = ((await res.json()) as { content?: JotSubmission }).content;
  if (!sub?.form_id) throw new ValidationError("Jotform returned an unexpected answer.");
  return sub;
}

/** Question/answer pairs, the contact details used for matching, and uploaded file links. */
export function summarize(sub: JotSubmission) {
  const answers = Object.values(sub.answers ?? {});
  const pairs: { q: string; a: string }[] = [];
  const emails: string[] = [];
  const names: string[] = [];
  const files: string[] = [];
  for (const a of answers) {
    const v = a.answer;
    if (v == null || v === "") continue;
    if (a.type === "control_fileupload") {
      for (const u of Array.isArray(v) ? v : [v]) if (typeof u === "string") files.push(u);
      continue;
    }
    const text = a.prettyFormat || (typeof v === "string" ? v : typeof v === "object" ? Object.values(v as Record<string, unknown>).filter((x) => typeof x === "string" && x).join(" ") : String(v));
    if (a.type === "control_email" && typeof v === "string" && normalizeEmail(v)) emails.push(normalizeEmail(v)!);
    if (a.type === "control_fullname") names.push(text.trim());
    if (a.name === jotformConfig().refField) continue;
    if (text) pairs.push({ q: (a.text || a.name || "Question").slice(0, 300), a: text.slice(0, 4000) });
  }
  return { pairs, emails, names, files };
}

async function clientEmails(clientId: string) {
  const c = await prisma.client.findUniqueOrThrow({ where: { id: clientId }, include: { contacts: true, portalAccess: { where: { revokedAt: null }, include: { portalUser: { select: { email: true } } } } } });
  return {
    client: c,
    emails: new Set([c.emailNormalized, ...c.contacts.map((x) => x.emailNormalized), ...c.portalAccess.map((p) => normalizeEmail(p.portalUser.email))].filter(Boolean) as string[]),
  };
}

/** Staff preview before linking: which client the submission appears to belong to. */
export async function previewSubmission(actor: Actor, submissionId: string) {
  void actor;
  const sub = await fetchSubmission(submissionId.trim());
  const s = summarize(sub);
  const linked = await prisma.questionnaireSubmission.findUnique({ where: { submissionId: submissionId.trim() }, include: { client: { select: { displayName: true } } } });
  const q = await prisma.taxQuestionnaire.findFirst({ where: { jotformFormId: sub.form_id } });
  const candidates = s.emails.length ? await prisma.client.findMany({ where: { archivedAt: null, OR: [{ emailNormalized: { in: s.emails } }, { contacts: { some: { emailNormalized: { in: s.emails } } } }] }, select: { id: true, displayName: true } }) : [];
  return { formId: sub.form_id!, submittedAt: sub.created_at ?? null, taxYear: q?.taxYear ?? null, questionnaireTitle: q?.title ?? null, emails: s.emails, names: s.names, fileCount: s.files.length, answerCount: s.pairs.length, candidates, alreadyLinkedTo: linked?.client.displayName ?? null };
}

/** Downloads Jotform file uploads (jotform.com only) into the client's vault for that year. */
async function importFiles(urls: string[], ctx: { clientId: string; taxYear: number; staff: Actor | null; visibility: "STAFF_ONLY" | "PUBLISHED" }) {
  const c = jotformConfig();
  const ids: string[] = [];
  const skipped: string[] = [];
  for (const raw of urls.slice(0, 20)) {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      skipped.push(raw);
      continue;
    }
    if (url.protocol !== "https:" || !/(^|\.)jotform\.com$/.test(url.hostname)) {
      skipped.push(raw);
      continue;
    }
    if (c.apiKey) url.searchParams.set("apiKey", c.apiKey);
    const res = await fetch(url, { redirect: "follow" }).catch(() => null);
    if (!res?.ok) {
      skipped.push(raw);
      continue;
    }
    const bytes = new Uint8Array(await res.arrayBuffer());
    const name = decodeURIComponent(url.pathname.split("/").pop() || "questionnaire-upload");
    try {
      await assertNotDuplicate(ctx.clientId, sha256Of(bytes));
      const stored = await storeDocumentFile(bytes, name, ctx.staff ? { staff: ctx.staff } : { system: "jotform" });
      const doc = await prisma.$transaction(async (tx) => {
        const file = await tx.storedFile.create({ data: stored.fileData });
        const d = await tx.document.create({
          data: {
            clientId: ctx.clientId,
            category: "TAXES",
            title: `${ctx.taxYear} questionnaire upload — ${file.title}`.slice(0, 200),
            year: ctx.taxYear,
            visibility: ctx.visibility,
            publishedAt: ctx.visibility === "PUBLISHED" ? new Date() : null,
            docType: "QUESTIONNAIRE_UPLOAD",
            fileId: file.id,
            scanStatus: stored.scan,
            ...stored.scanMeta,
            uploadedByStaffId: ctx.staff?.id ?? null,
            needsReview: true,
            retainUntil: await retentionDate("TAXES"),
          },
        });
        await tx.documentAccessLog.create({ data: { documentId: d.id, action: "LINK", staffUserId: ctx.staff?.id ?? null } });
        return d;
      });
      ids.push(doc.id);
    } catch (err) {
      if (err instanceof ValidationError) skipped.push(name);
      else throw err;
    }
  }
  return { ids, skipped };
}

/**
 * Links an existing Jotform submission to a client and tax year. The match
 * is checked against the client's email addresses; anything else needs the
 * staff member to confirm and say how they verified it.
 */
export async function linkSubmission(actor: Actor, input: { clientId: string; taxYear: number; submissionId: string; confirmed: boolean; matchNote?: string }) {
  const submissionId = input.submissionId.trim();
  if (!Number.isInteger(input.taxYear) || input.taxYear < 2000 || input.taxYear > currentYear() + 1) throw new ValidationError("Choose the tax year.");
  const taken = await prisma.questionnaireSubmission.findUnique({ where: { submissionId } });
  if (taken) throw new ValidationError(taken.clientId === input.clientId ? "That submission is already linked to this client." : "That submission is already linked to a different client.");
  const { client, emails } = await clientEmails(input.clientId);
  const c = jotformConfig();
  let sub: JotSubmission | null = null;
  let source = "staff_import";
  if (c.apiKey) sub = await fetchSubmission(submissionId);
  else {
    // Without the API the submission can't be read: staff confirm it themselves.
    if (!/^\d{6,25}$/.test(submissionId)) throw new ValidationError("Enter the numeric Jotform submission ID.");
    source = "staff_verified";
  }
  const s = sub ? summarize(sub) : { pairs: [], emails: [], names: [], files: [] };
  const emailMatch = s.emails.some((e) => emails.has(e));
  if (!emailMatch) {
    if (!input.confirmed || !input.matchNote?.trim()) {
      throw new ValidationError(
        sub
          ? `The submission's email (${s.emails.join(", ") || "none"}) doesn't match ${client.displayName}. Confirm the match and note how you verified it.`
          : "Jotform isn't connected, so the match can't be checked automatically. Confirm the match and note how you verified it.",
      );
    }
  }
  const q = sub ? await prisma.taxQuestionnaire.findFirst({ where: { jotformFormId: sub.form_id } }) : null;
  const files = sub ? await importFiles(s.files, { clientId: client.id, taxYear: input.taxYear, staff: actor, visibility: "STAFF_ONLY" }) : { ids: [], skipped: [] };
  const row = await prisma.questionnaireSubmission.create({
    data: {
      clientId: client.id,
      taxYear: input.taxYear,
      questionnaireId: q?.id ?? null,
      jotformFormId: sub?.form_id ?? "unknown",
      submissionId,
      submittedAt: sub?.created_at ? new Date(sub.created_at.replace(" ", "T") + "Z") : null,
      source,
      answersEnc: s.pairs.length ? encryptSecret(JSON.stringify(s.pairs)) : null,
      matchNote: emailMatch ? `Email matched (${s.emails.filter((e) => emails.has(e)).join(", ")})` : input.matchNote!.trim().slice(0, 300),
      linkedById: actor.id,
      documentIds: files.ids,
    },
  });
  await audit(prisma, { actorId: actor.id, action: "questionnaire.linked", entityType: "QuestionnaireSubmission", entityId: row.id, clientId: client.id, details: { submissionId, taxYear: input.taxYear, source, files: files.ids.length, skipped: files.skipped.length, emailMatch } });
  return { row, imported: files.ids.length, skipped: files.skipped };
}

/**
 * Jotform webhook for a questionnaire (called from the shared Jotform
 * webhook once the submission was re-fetched from the API). The signed
 * reference ties it to one client and year; the form must be that year's.
 */
export async function recordQuestionnaireWebhook(sub: JotSubmission, ref: string): Promise<string> {
  const parsed = parseQuestionnaireRef(ref);
  if (!parsed || !sub.id) return "Invalid questionnaire reference; ignored";
  const q = await prisma.taxQuestionnaire.findFirst({ where: { taxYear: parsed.taxYear, jotformFormId: sub.form_id } });
  if (!q) return "Form isn't this year's questionnaire; ignored";
  if (await prisma.questionnaireSubmission.findUnique({ where: { submissionId: sub.id } })) return "Already recorded";
  const client = await prisma.client.findUnique({ where: { id: parsed.clientId } });
  if (!client) return "Client not found; ignored";
  const s = summarize(sub);
  // The client's own uploads come back to them, held for staff review.
  const files = await importFiles(s.files, { clientId: client.id, taxYear: parsed.taxYear, staff: null, visibility: "PUBLISHED" });
  const row = await prisma.questionnaireSubmission.create({
    data: {
      clientId: client.id,
      taxYear: parsed.taxYear,
      questionnaireId: q.id,
      jotformFormId: q.jotformFormId!,
      submissionId: sub.id,
      submittedAt: sub.created_at ? new Date(sub.created_at.replace(" ", "T") + "Z") : new Date(),
      source: "jotform_webhook",
      answersEnc: s.pairs.length ? encryptSecret(JSON.stringify(s.pairs)) : null,
      matchNote: "Signed client link",
      documentIds: files.ids,
    },
  });
  await audit(prisma, { actorId: null, action: "questionnaire.submitted", entityType: "QuestionnaireSubmission", entityId: row.id, clientId: client.id, details: { taxYear: parsed.taxYear, files: files.ids.length } });
  for (const id of files.ids) await queueStaffAlert({ documentId: id });
  return "Recorded";
}

export function submissionAnswers(row: { answersEnc: string | null }): { q: string; a: string }[] {
  if (!row.answersEnc) return [];
  try {
    return JSON.parse(decryptSecret(row.answersEnc));
  } catch {
    return [];
  }
}

// --- Separate statuses per tax year ----------------------------------------

export async function setTaxYearProgress(actor: Actor, clientId: string, taxYear: number, input: { documentsStatus: string; estimatedCompletion: Date | null; estimateNote?: string }) {
  if (!(input.documentsStatus in DOCUMENTS_STATUS)) throw new ValidationError("Choose a documents status.");
  const data = { documentsStatus: input.documentsStatus, documentsUpdatedAt: new Date(), estimatedCompletion: input.estimatedCompletion, estimateNote: input.estimateNote?.trim().slice(0, 300) || null, updatedById: actor.id };
  await prisma.taxYearProgress.upsert({ where: { clientId_taxYear: { clientId, taxYear } }, create: { clientId, taxYear, ...data }, update: data });
  await audit(prisma, { actorId: actor.id, action: "tax_year.progress_updated", entityType: "Client", entityId: clientId, clientId, details: { taxYear, documentsStatus: input.documentsStatus } });
}

const PREP_STEP: Record<string, string> = { AWAITING_INFORMATION: "Waiting on information", IN_PROGRESS: "In progress", UNDER_REVIEW: "Under review", AWAITING_SIGNATURE: "Waiting for your signature", READY_TO_FILE: "Ready to file" };
const FILE_STEP: Record<string, string> = { NOT_SUBMITTED: "Not filed yet", SUBMITTED: "Filed", PENDING_ACKNOWLEDGMENT: "Filed — waiting for the agency", ACCEPTED: "Filed", REJECTED: "Needs correction" };

/** One row per tax year with the five separate steps. */
export async function taxYearStatuses(clientId: string, years: number[]) {
  const [subs, progress, filings, uploads] = await Promise.all([
    prisma.questionnaireSubmission.findMany({ where: { clientId, taxYear: { in: years } }, select: { taxYear: true, submittedAt: true, createdAt: true } }),
    prisma.taxYearProgress.findMany({ where: { clientId, taxYear: { in: years } } }),
    prisma.filingRecord.findMany({ where: { clientId, taxYear: { in: years }, filingType: "ORIGINAL", visibleToClient: true }, orderBy: { jurisdiction: "asc" } }),
    prisma.document.groupBy({ by: ["year"], where: { clientId, deletedAt: null, year: { in: years }, uploadedByPortalId: { not: null } }, _count: true }),
  ]);
  return years.map((year) => {
    const sub = subs.find((s) => s.taxYear === year);
    const p = progress.find((x) => x.taxYear === year);
    const fed = filings.find((f) => f.taxYear === year && f.jurisdiction === "FEDERAL") ?? filings.find((f) => f.taxYear === year);
    const uploaded = uploads.find((u) => u.year === year)?._count ?? 0;
    const docs = (p?.documentsStatus ?? "NOT_STARTED") as keyof typeof DOCUMENTS_STATUS;
    return {
      year,
      steps: [
        { key: "questionnaire", label: "Questionnaire", value: sub ? "Completed" : "Not completed", done: !!sub },
        { key: "documents", label: "Documents", value: docs === "NOT_STARTED" && uploaded ? `${uploaded} uploaded — our team will confirm` : DOCUMENTS_STATUS[docs], done: docs === "ALL_RECEIVED" },
        { key: "preparation", label: "Return preparation", value: fed ? PREP_STEP[fed.prepStatus] : "Not started", done: fed?.prepStatus === "READY_TO_FILE" || (!!fed && fed.filingStatus !== "NOT_SUBMITTED") },
        { key: "filing", label: "Filing", value: fed ? FILE_STEP[fed.filingStatus] : "Not filed yet", done: !!fed && ["SUBMITTED", "PENDING_ACKNOWLEDGMENT", "ACCEPTED"].includes(fed.filingStatus) },
        { key: "acceptance", label: "Agency acceptance", value: fed?.filingStatus === "ACCEPTED" ? "Accepted" : fed?.filingStatus === "REJECTED" ? "Rejected — we're correcting it" : "Not yet", done: fed?.filingStatus === "ACCEPTED" },
      ],
      estimatedCompletion: p?.estimatedCompletion ?? null,
      estimateNote: p?.estimateNote ?? null,
      started: !!(sub || p || fed || uploaded),
    };
  });
}

// --- Retrieve Tax Filings ----------------------------------------------------

export function retrieveYears() {
  const ys: number[] = [];
  for (let y = currentYear(); y >= FIRST_RETRIEVE_YEAR; y--) ys.push(y);
  return ys;
}

/**
 * Returns and related records that staff uploaded and published to this
 * account for one year. Only clean (scanned) files; staff-only drafts never
 * appear. Records stored in Client Connect only — nothing is pulled from
 * TaxAct or the IRS.
 */
export async function retrieveFilings(user: PortalActor, clientId: string, year: number) {
  await requireClientAccess(user.id, clientId, "tax");
  await requireVerified(user);
  if (!retrieveYears().includes(year)) throw new ValidationError("Choose a year from the list.");
  const docs = await prisma.document.findMany({
    where: { clientId, year, deletedAt: null, visibility: "PUBLISHED", scanStatus: "CLEAN", category: "TAXES", uploadedByStaffId: { not: null } },
    include: { filing: { select: { jurisdiction: true, filingType: true, returnType: true } }, file: { select: { mimeType: true, sizeBytes: true } } },
    orderBy: [{ publishedAt: "desc" }],
  });
  const groups = { FEDERAL: [] as typeof docs, STATE: [] as typeof docs, AMENDED: [] as typeof docs, RELATED: [] as typeof docs };
  for (const d of docs) groups[filingGroup(d)].push(d);
  const openRequest = await prisma.task.findFirst({ where: { clientId, status: "OPEN", title: copyTaskTitle(year) }, select: { createdAt: true } });
  return { year, groups, total: docs.length, openRequest };
}

const copyTaskTitle = (year: number) => `Client requested a copy of their ${year} tax filings`;

/** "Request a Copy": a staff task (one open per year) plus a secure message. */
export async function requestFilingCopy(user: PortalActor, clientId: string, year: number, note?: string) {
  await requireClientAccess(user.id, clientId, "tax");
  await requireVerified(user);
  if (!retrieveYears().includes(year)) throw new ValidationError("Choose a year from the list.");
  const existing = await prisma.task.findFirst({ where: { clientId, status: "OPEN", title: copyTaskTitle(year) } });
  if (existing) return { task: existing, created: false };
  const client = await prisma.client.findUniqueOrThrow({ where: { id: clientId }, select: { assignedToId: true } });
  const creator = client.assignedToId ?? (await prisma.user.findFirst({ where: { role: "ADMIN", active: true }, orderBy: { createdAt: "asc" }, select: { id: true } }))?.id;
  if (!creator) throw new ValidationError("Our office can't receive requests right now. Please call us.");
  const result = await prisma.$transaction(async (tx) => {
    const task = await tx.task.create({
      data: { title: copyTaskTitle(year), details: `Requested in the portal by ${user.name}. Upload and publish the ${year} returns (federal, state, amended) and related records, or reply if we don't have them.${note?.trim() ? `\n\nClient note: ${note.trim().slice(0, 1000)}` : ""}`, clientId, assigneeId: client.assignedToId, createdById: creator, priority: "NORMAL" },
    });
    const convo = await tx.conversation.create({ data: { clientId, subject: `Request a Copy — ${year} tax filings`, awaitingStaff: true, unreadByStaff: true } });
    await tx.message.create({ data: { conversationId: convo.id, channel: "PORTAL", direction: "INBOUND", portalAuthorId: user.id, status: "DELIVERED", readByClientAt: new Date(), body: `[Request a Copy] Please add my ${year} tax filings to my portal.${note?.trim() ? `\n\n${note.trim().slice(0, 1000)}` : ""}` } });
    await audit(tx, { actorId: null, action: "tax.copy_requested", entityType: "Task", entityId: task.id, clientId, details: { year, portalUserId: user.id } });
    return { task, convoId: convo.id };
  });
  await queueStaffAlert({ conversationId: result.convoId });
  return { task: result.task, created: true };
}

/** Year folders for the client's Document Vault (published, clean records only). */
export async function vaultYears(clientId: string, categories: string[]) {
  const rows = await prisma.document.groupBy({
    by: ["year"],
    where: { clientId, deletedAt: null, visibility: "PUBLISHED", scanStatus: "CLEAN", category: { in: categories as never } },
    _count: true,
  });
  return rows.map((r) => ({ year: r.year, count: r._count })).sort((a, b) => (b.year ?? 0) - (a.year ?? 0));
}
