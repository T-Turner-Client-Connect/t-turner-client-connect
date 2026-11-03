import "server-only";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { audit } from "@/lib/audit";
import type { Actor } from "@/lib/auth/actor";
import { ValidationError } from "@/lib/services/clients";
import { jotformConfig } from "@/lib/services/contracts";
import { currentYear, linkSubmission, parseQuestionnaireRef, questionnaireFor, questionnaireUrl, recordQuestionnaireWebhook, submissionAnswers, summarize, type JotSubmission } from "@/lib/services/tax-center";
import { isReportApprover } from "@/lib/services/bookkeeping-clients";
import { ForbiddenError } from "@/lib/auth/actor";
import { createDocumentRequest } from "@/lib/services/bookkeeping";
import { brandedEmailHtml, sendTransactionalEmail } from "@/lib/email";
import { formatPhone, normalizeEmail, normalizePhone } from "@/lib/normalize";

// ---------------------------------------------------------------- status

export const INTAKE_STATUS = {
  NOT_SENT: { label: "Not Sent", tone: "gray" },
  SENT: { label: "Sent", tone: "navy" },
  IN_PROGRESS: { label: "In Progress", tone: "gold" },
  NEEDS_REVIEW: { label: "Needs Review", tone: "amber" },
  COMPLETED: { label: "Completed", tone: "green" },
} as const;
export type IntakeStatus = keyof typeof INTAKE_STATUS;

/**
 * Not Sent → Sent (staff sent it) → In Progress (client opened it) →
 * Needs Review (a submission is linked but staff haven't reviewed it) →
 * Completed (reviewed).
 */
export function intakeStatus(req: { sentAt: Date | null; openedAt: Date | null } | null, subs: { reviewStatus: string }[]): IntakeStatus {
  if (subs.some((s) => s.reviewStatus === "NEEDS_REVIEW")) return "NEEDS_REVIEW";
  if (subs.length) return "COMPLETED";
  if (req?.openedAt) return "IN_PROGRESS";
  if (req?.sentAt) return "SENT";
  return "NOT_SENT";
}

export async function intakeSummary(clientId: string, taxYear: number) {
  const [req, subs] = await Promise.all([
    prisma.questionnaireRequest.findUnique({ where: { clientId_taxYear: { clientId, taxYear } } }),
    prisma.questionnaireSubmission.findMany({ where: { clientId, taxYear }, select: { id: true, reviewStatus: true, submittedAt: true, createdAt: true } }),
  ]);
  const status = intakeStatus(req, subs);
  return { status, ...INTAKE_STATUS[status], request: req, submissions: subs };
}

// ---------------------------------------------------------------- connection check

/**
 * Read-only check that the Jotform credentials work: calls GET /user with the
 * API key and reports only "connected" or the HTTP status — never the key.
 */
export async function testJotformConnection(): Promise<{ ok: boolean; detail: string; checks: { name: string; set: boolean }[] }> {
  const c = jotformConfig();
  const checks = [
    { name: "JOTFORM_API_KEY", set: !!c.apiKey },
    { name: "JOTFORM_WEBHOOK_SECRET", set: !!c.webhookSecret },
  ];
  if (!c.apiKey) return { ok: false, detail: "JOTFORM_API_KEY isn't set, so submissions can't be read or verified.", checks };
  const res = await fetch(`${c.apiBase}/user`, { headers: { APIKEY: c.apiKey } }).catch(() => null);
  if (!res) return { ok: false, detail: "Couldn't reach the Jotform API.", checks };
  if (res.status === 401 || res.status === 403) return { ok: false, detail: `Jotform rejected the API key (HTTP ${res.status}).`, checks };
  if (!res.ok) return { ok: false, detail: `Jotform API error (HTTP ${res.status}).`, checks };
  return { ok: true, detail: c.webhookSecret ? "Connected: the API key works and the webhook secret is set." : "API key works. Set JOTFORM_WEBHOOK_SECRET so completed questionnaires arrive automatically.", checks };
}

// ---------------------------------------------------------------- send / open

/**
 * Emails the client their signed questionnaire link for one tax year. One
 * request row per client per year: resending updates it. Never resends a
 * questionnaire that's already been submitted.
 */
export async function sendQuestionnaire(actor: Actor, clientId: string, taxYear: number) {
  if (!Number.isInteger(taxYear) || taxYear < 2000 || taxYear > currentYear()) throw new ValidationError("Choose the tax year.");
  const client = await prisma.client.findUniqueOrThrow({ where: { id: clientId } });
  if (client.archivedAt) throw new ValidationError("This client is archived.");
  if (await prisma.questionnaireSubmission.count({ where: { clientId, taxYear } })) throw new ValidationError(`The ${taxYear} questionnaire is already completed for this client.`);
  const to = client.email && normalizeEmail(client.email);
  if (!to) throw new ValidationError("Add the client's email address before sending.");
  const url = await questionnaireUrl(clientId, client.clientType, taxYear);
  const q = await questionnaireFor(client.clientType, taxYear);
  if (!url || !q) throw new ValidationError(`There's no ${taxYear} questionnaire form set up yet (News & Countdowns → Tax questionnaires).`);

  const first = client.preferredName || client.firstName || client.displayName;
  const sent = await sendTransactionalEmail(
    to,
    `Your ${taxYear} tax questionnaire`,
    `Hi ${first},\n\nPlease complete your ${taxYear} tax questionnaire: ${url}\n\nThe link is personal to you. — TTurner & Associates`,
    brandedEmailHtml({
      heading: `Your ${taxYear} tax questionnaire`,
      paragraphs: [`Hi ${first},`, `Please complete your ${taxYear} tax questionnaire. It takes about 15 minutes, and you can upload documents as you go.`],
      button: { label: "Start my questionnaire", url },
      note: "This link is personal to you — please don't forward it.",
    }),
  );
  if (!sent) throw new ValidationError("The email couldn't be sent. Nothing was recorded — try again.");
  const now = new Date();
  const req = await prisma.questionnaireRequest.upsert({
    where: { clientId_taxYear: { clientId, taxYear } },
    create: { clientId, taxYear, questionnaireId: q.id, sentAt: now, sentById: actor.id, sentTo: to, sendCount: 1 },
    update: { questionnaireId: q.id, sentAt: now, sentById: actor.id, sentTo: to, sendCount: { increment: 1 } },
  });
  await audit(prisma, { actorId: actor.id, action: req.sendCount > 1 ? "questionnaire.resent" : "questionnaire.sent", entityType: "QuestionnaireRequest", entityId: req.id, clientId, details: { taxYear, sendCount: req.sendCount } });
  return req;
}

/** The client opened their questionnaire from the portal (status → In Progress). */
export async function recordQuestionnaireOpened(clientId: string, taxYear: number) {
  await prisma.questionnaireRequest.upsert({
    where: { clientId_taxYear: { clientId, taxYear } },
    create: { clientId, taxYear, openedAt: new Date() },
    update: {},
  });
  await prisma.questionnaireRequest.updateMany({ where: { clientId, taxYear, openedAt: null }, data: { openedAt: new Date() } });
}

// ---------------------------------------------------------------- find existing submissions

const norm = (s: string | null | undefined) => s?.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim() || "";

/**
 * Looks through the year's Jotform questionnaire for submissions that belong
 * to this client (same email, or same name) and says which are already
 * linked. Read-only: linking is a separate, confirmed step.
 */
export async function findClientSubmissions(clientId: string, taxYear: number) {
  const c = jotformConfig();
  if (!c.apiKey) throw new ValidationError("Jotform isn't connected (JOTFORM_API_KEY), so submissions can't be searched.");
  const client = await prisma.client.findUniqueOrThrow({
    where: { id: clientId },
    include: { contacts: { select: { emailNormalized: true, name: true } }, taxPrepCases: { where: { taxYear } } },
  });
  const q = await questionnaireFor(client.clientType, taxYear);
  if (!q?.jotformFormId) throw new ValidationError(`There's no ${taxYear} questionnaire form set up yet.`);
  const res = await fetch(`${c.apiBase}/form/${encodeURIComponent(q.jotformFormId)}/submissions?limit=500&orderby=created_at`, { headers: { APIKEY: c.apiKey } }).catch(() => null);
  if (!res?.ok) throw new ValidationError(`Jotform API error${res ? ` (HTTP ${res.status})` : ""}.`);
  const subs = (((await res.json()) as { content?: JotSubmission[] }).content ?? []).filter((s) => s.id);

  const emails = new Set([client.emailNormalized, ...client.contacts.map((x) => x.emailNormalized)].filter(Boolean) as string[]);
  const kase = client.taxPrepCases[0];
  const names = new Set(
    [
      client.displayName,
      [client.firstName, client.lastName].filter(Boolean).join(" "),
      kase && [kase.primaryFirstName, kase.primaryLastName].filter(Boolean).join(" "),
      kase && [kase.spouseFirstName, kase.spouseLastName].filter(Boolean).join(" "),
      ...client.contacts.map((x) => x.name),
    ].map(norm).filter(Boolean),
  );
  const linked = new Map(
    (await prisma.questionnaireSubmission.findMany({ where: { submissionId: { in: subs.map((s) => s.id!) } }, select: { submissionId: true, clientId: true } })).map((r) => [r.submissionId, r.clientId]),
  );
  const out: { submissionId: string; submittedAt: string | null; matchedBy: ("email" | "name")[]; linkedHere: boolean; linkedElsewhere: boolean }[] = [];
  for (const s of subs) {
    const sum = summarize(s);
    const matchedBy: ("email" | "name")[] = [];
    if (sum.emails.some((e) => emails.has(e))) matchedBy.push("email");
    if (sum.names.some((n) => names.has(norm(n)))) matchedBy.push("name");
    const owner = linked.get(s.id!);
    if (!matchedBy.length && owner !== clientId) continue;
    out.push({ submissionId: s.id!, submittedAt: s.created_at ?? null, matchedBy, linkedHere: owner === clientId, linkedElsewhere: !!owner && owner !== clientId });
  }
  return out;
}

// ---------------------------------------------------------------- review answers

const FIELD_LABEL: Record<string, string> = { email: "Email", phone: "Phone", addressLine1: "Address", city: "City", state: "State", postalCode: "ZIP" };

/** Contact details the client gave in the questionnaire that differ from the client record. */
export function proposedUpdates(pairs: { q: string; a: string }[], current: Record<string, string | null>) {
  const found: Record<string, string> = {};
  for (const { q, a } of pairs) {
    if (/spouse|employer|preparer|bank|dependent/i.test(q)) continue;
    if (!found.email && /e-?mail/i.test(q) && normalizeEmail(a)) found.email = a.trim();
    else if (!found.phone && /phone|mobile|cell/i.test(q) && normalizePhone(a)) found.phone = formatPhone(normalizePhone(a));
    else if (/address/i.test(q)) {
      const part = (label: RegExp) => new RegExp(`${label.source}\\s*:\\s*([^<\\n]+)`, "i").exec(a)?.[1]?.trim();
      const street = part(/street address/);
      if (street && !found.addressLine1) {
        found.addressLine1 = street;
        const city = part(/city/);
        const state = part(/state(?: \/ province)?/);
        const zip = part(/(?:postal \/ )?zip(?: code)?/);
        if (city) found.city = city;
        if (state) found.state = state.toUpperCase().slice(0, 2);
        if (zip) found.postalCode = zip;
      }
    }
  }
  return Object.entries(found)
    .filter(([k, v]) => (current[k] ?? "").trim().toLowerCase() !== v.trim().toLowerCase())
    .map(([field, to]) => ({ field, label: FIELD_LABEL[field], from: current[field] ?? null, to }));
}

/**
 * Staff review of a linked submission. Only the fields staff tick are written
 * to the client record; everything else stays in the questionnaire.
 */
export async function reviewSubmission(actor: Actor, submissionRowId: string, applyFields: string[]) {
  const sub = await prisma.questionnaireSubmission.findUniqueOrThrow({ where: { id: submissionRowId } });
  const client = await prisma.client.findUniqueOrThrow({ where: { id: sub.clientId } });
  const proposals = proposedUpdates(submissionAnswers(sub), client as unknown as Record<string, string | null>);
  const chosen = proposals.filter((p) => applyFields.includes(p.field));
  const data: Prisma.ClientUpdateInput = {};
  for (const p of chosen) (data as Record<string, unknown>)[p.field] = p.to;
  if (data.email) data.emailNormalized = normalizeEmail(p(chosen, "email"));
  if (data.phone) data.phoneNormalized = normalizePhone(p(chosen, "phone"));
  await prisma.$transaction(async (tx) => {
    if (chosen.length) await tx.client.update({ where: { id: client.id }, data });
    await tx.questionnaireSubmission.update({ where: { id: sub.id }, data: { reviewStatus: "REVIEWED", reviewedAt: new Date(), reviewedById: actor.id, appliedFields: chosen.map((c) => c.field) } });
    await audit(tx, { actorId: actor.id, action: "questionnaire.reviewed", entityType: "QuestionnaireSubmission", entityId: sub.id, clientId: client.id, details: { taxYear: sub.taxYear, appliedFields: chosen.map((c) => c.field) } });
  });
  return chosen.map((c) => c.field);
}
const p = (list: { field: string; to: string }[], f: string) => list.find((x) => x.field === f)?.to ?? null;

// ---------------------------------------------------------------- Coetha follow-up checklist

type Rule = { key: string; label: string; ask: RegExp; doc: RegExp };
const RULES: Rule[] = [
  { key: "w2", label: "W-2 from each employer", ask: /\bw-?2\b|wages|employ(ed|er|ment)/i, doc: /\bw-?2\b/i },
  { key: "1099nec", label: "1099-NEC / 1099-MISC / 1099-K and a summary of business income and expenses", ask: /self[\s-]?employ|1099-?(nec|misc|k)\b|contract(or)? (work|income)|gig|freelanc|side business/i, doc: /1099-?(nec|misc|k)\b|profit|business (income|expense)/i },
  { key: "invest", label: "1099-INT / 1099-DIV / 1099-B from banks and brokerages", ask: /interest (income|earned)|earn(ed)? interest|bank interest|dividend|brokerage|stock|crypto|investment/i, doc: /1099-?(int|div|b)\b|brokerage|consolidated/i },
  { key: "retire", label: "1099-R for retirement or pension distributions", ask: /retire|pension|401\s?\(?k|\bira\b.*distribut|distribut.*\bira\b/i, doc: /1099-?r\b/i },
  { key: "ssa", label: "SSA-1099 for Social Security benefits", ask: /social security benefit|ssa-?1099/i, doc: /ssa-?1099/i },
  { key: "unemp", label: "1099-G for unemployment or state refunds", ask: /unemploy/i, doc: /1099-?g\b/i },
  { key: "mortgage", label: "1098 Mortgage Interest Statement", ask: /mortgage|home loan/i, doc: /\b1098\b(?!-?t)|mortgage/i },
  { key: "tuition", label: "1098-T for tuition (and receipts for books/fees)", ask: /tuition|college|universit|education credit/i, doc: /1098-?t\b|tuition/i },
  { key: "childcare", label: "Child or dependent care provider statement (name, address, amount paid)", ask: /child ?care|day ?care|dependent care/i, doc: /child ?care|day ?care|provider/i },
  { key: "hsa", label: "HSA forms 1099-SA and 5498-SA", ask: /\bhsa\b|health savings/i, doc: /1099-?sa|5498|\bhsa\b/i },
  { key: "marketplace", label: "Form 1095-A for Marketplace health insurance", ask: /marketplace|healthcare\.gov|1095-?a/i, doc: /1095-?a/i },
  { key: "rental", label: "Rental income and expense summary", ask: /rental|landlord|rent (out|income)/i, doc: /rental|rent roll|lease/i },
  { key: "estimates", label: "Dates and amounts of estimated tax payments", ask: /estimated (tax )?payment/i, doc: /estimated|1040-?es/i },
];

const saidYes = (a: string) => /^\s*(yes|y|true|✓|checked)\b/i.test(a);

/**
 * Coetha's follow-up checklist: rules-based, from the questionnaire answers
 * and the documents already in the client's vault for that tax year. A draft
 * for staff to review — nothing is sent to the client automatically.
 */
export function followUpChecklist(pairs: { q: string; a: string }[], vaultTitles: string[]) {
  const items: { key: string; label: string; reason: string; status: "MISSING" | "RECEIVED" }[] = [];
  for (const r of RULES) {
    const hit = pairs.find(({ q, a }) => r.ask.test(q) && saidYes(a));
    if (!hit) continue;
    const received = vaultTitles.some((t) => r.doc.test(t));
    items.push({ key: r.key, label: r.label, reason: `“${hit.q.slice(0, 120)}” — ${hit.a.slice(0, 40)}`, status: received ? "RECEIVED" : "MISSING" });
  }
  const blanks = pairs.filter(({ a }) => /^\s*(n\/?a|unknown|not sure|\?+)\s*$/i.test(a)).slice(0, 10);
  for (const b of blanks) items.push({ key: `ask:${b.q.slice(0, 40)}`, label: `Clarify: ${b.q.slice(0, 120)}`, reason: `Answered “${b.a.trim()}”`, status: "MISSING" });
  return items;
}

export async function buildFollowUp(actor: Actor, submissionRowId: string) {
  const sub = await prisma.questionnaireSubmission.findUniqueOrThrow({ where: { id: submissionRowId } });
  const docs = await prisma.document.findMany({ where: { clientId: sub.clientId, deletedAt: null, OR: [{ year: sub.taxYear }, { id: { in: sub.documentIds } }] }, select: { title: true, docType: true } });
  const items = followUpChecklist(submissionAnswers(sub), docs.map((d) => `${d.title} ${d.docType ?? ""}`));
  await prisma.questionnaireSubmission.update({ where: { id: sub.id }, data: { followUp: { items, preparedAt: new Date().toISOString() } as Prisma.InputJsonValue } });
  await audit(prisma, { actorId: actor.id, action: "questionnaire.followup_prepared", entityType: "QuestionnaireSubmission", entityId: sub.id, clientId: sub.clientId, details: { missing: items.filter((i) => i.status === "MISSING").length } });
  return items;
}

/** Staff approved the checklist: send the missing items as one document request in the client's portal. */
export async function requestMissingItems(actor: Actor, submissionRowId: string, keys: string[]) {
  const sub = await prisma.questionnaireSubmission.findUniqueOrThrow({ where: { id: submissionRowId } });
  const items = ((sub.followUp as { items?: { key: string; label: string; status: string }[] } | null)?.items ?? []).filter((i) => i.status === "MISSING" && keys.includes(i.key));
  if (!items.length) throw new ValidationError("Choose at least one missing item.");
  const req = await createDocumentRequest(actor, {
    clientId: sub.clientId,
    title: `${sub.taxYear} tax documents still needed`,
    instructions: items.map((i) => `• ${i.label}`).join("\n"),
    category: "TAXES",
  });
  await audit(prisma, { actorId: actor.id, action: "questionnaire.followup_requested", entityType: "QuestionnaireSubmission", entityId: sub.id, clientId: sub.clientId, details: { requestId: req.id, items: items.length } });
  return req;
}

// ---------------------------------------------------------------- webhook routing + review inbox

export async function jotformAutoFileOn(): Promise<boolean> {
  return (await prisma.integrationSettings.findUnique({ where: { id: "default" } }))?.jotformAutoFileEnabled ?? false;
}

/** Owner-only switch: file verified, signed questionnaire submissions automatically. */
export async function setJotformAutoFile(actor: Actor, on: boolean) {
  if (!(await isReportApprover(actor))) throw new ForbiddenError("Only Tabitha can turn automatic questionnaire filing on or off.");
  await prisma.integrationSettings.upsert({ where: { id: "default" }, create: { id: "default", jotformAutoFileEnabled: on, updatedById: actor.id }, update: { jotformAutoFileEnabled: on, updatedById: actor.id } });
  await audit(prisma, { actorId: actor.id, action: on ? "jotform.autofile_on" : "jotform.autofile_off", entityType: "IntegrationSettings", entityId: "default" });
}

/**
 * A verified questionnaire webhook (the submission was re-read from the
 * Jotform API). Files it automatically only when the owner's switch is on AND
 * it carries a valid signed link for an existing client and that year's form;
 * everything else waits in the staff review inbox. Never imports twice.
 */
export async function routeQuestionnaireWebhook(sub: JotSubmission, ref: string | null): Promise<string> {
  if (!sub.id || !sub.form_id) return "Missing submission; ignored";
  if (await prisma.questionnaireSubmission.findUnique({ where: { submissionId: sub.id } })) return "Already recorded";
  if (await prisma.jotformInbox.findUnique({ where: { submissionId: sub.id } })) return "Already in staff review";
  const forms = await prisma.taxQuestionnaire.findMany({ where: { jotformFormId: sub.form_id } });
  const parsed = ref ? parseQuestionnaireRef(ref) : null;
  let reason: string;
  let suggestedClientId: string | null = null;
  let taxYear: number | null = forms.length === 1 ? forms[0].taxYear : null;
  if (!ref) reason = "NO_REFERENCE";
  else if (!parsed) reason = "BAD_REFERENCE";
  else {
    taxYear = parsed.taxYear;
    const client = await prisma.client.findUnique({ where: { id: parsed.clientId }, select: { id: true } });
    if (!client) reason = "CLIENT_NOT_FOUND";
    else if (!forms.some((f) => f.taxYear === parsed.taxYear)) {
      reason = "FORM_YEAR_MISMATCH";
      suggestedClientId = client.id;
    } else {
      suggestedClientId = client.id;
      if (await jotformAutoFileOn()) return recordQuestionnaireWebhook(sub, ref!);
      reason = "HELD";
    }
  }
  if (!forms.length && reason !== "HELD") return "Not one of our questionnaire forms; ignored";
  const row = await prisma.jotformInbox.create({
    data: {
      submissionId: sub.id,
      formId: sub.form_id,
      questionnaireId: forms.find((f) => f.taxYear === taxYear)?.id ?? null,
      taxYear,
      suggestedClientId,
      reason,
      emails: summarize(sub).emails.slice(0, 5),
    },
  });
  await audit(prisma, { actorId: null, action: "questionnaire.held_for_review", entityType: "JotformInbox", entityId: row.id, clientId: suggestedClientId, details: { reason, taxYear } });
  return `Held for staff review (${reason})`;
}

export const INBOX_REASON: Record<string, string> = {
  HELD: "Signed link verified — waiting for staff to file (automatic filing is off)",
  NO_REFERENCE: "No client link — submitted from the public form",
  BAD_REFERENCE: "Client link didn't verify",
  FORM_YEAR_MISMATCH: "Form isn't that tax year's questionnaire",
  CLIENT_NOT_FOUND: "Linked client no longer exists",
};

/** Candidate clients for an inbox item (by the submission's email addresses). */
export async function inboxCandidates(emails: string[]) {
  if (!emails.length) return [];
  return prisma.client.findMany({
    where: { archivedAt: null, OR: [{ emailNormalized: { in: emails } }, { contacts: { some: { emailNormalized: { in: emails } } } }] },
    select: { id: true, displayName: true },
    take: 5,
  });
}

/** Staff file an inbox item to a client and tax year (answers re-read from Jotform). */
export async function fileInboxItem(actor: Actor, inboxId: string, input: { clientId: string; taxYear: number; confirmed: boolean; matchNote?: string }) {
  const item = await prisma.jotformInbox.findUniqueOrThrow({ where: { id: inboxId } });
  if (item.status !== "PENDING") throw new ValidationError("This submission was already handled.");
  const signedRef = item.reason === "HELD" && item.suggestedClientId === input.clientId && item.taxYear === input.taxYear;
  const r = await linkSubmission(actor, { clientId: input.clientId, taxYear: input.taxYear, submissionId: item.submissionId, confirmed: input.confirmed, matchNote: input.matchNote, signedRef });
  await prisma.jotformInbox.update({ where: { id: item.id }, data: { status: "FILED", resolvedAt: new Date(), resolvedById: actor.id, filedClientId: input.clientId } });
  await audit(prisma, { actorId: actor.id, action: "questionnaire.filed_from_inbox", entityType: "JotformInbox", entityId: item.id, clientId: input.clientId, details: { taxYear: input.taxYear, signedRef } });
  return r;
}

export async function dismissInboxItem(actor: Actor, inboxId: string, note: string) {
  if (!note.trim()) throw new ValidationError("Say why it's being dismissed (e.g. test submission, duplicate).");
  const item = await prisma.jotformInbox.findUniqueOrThrow({ where: { id: inboxId } });
  if (item.status !== "PENDING") throw new ValidationError("This submission was already handled.");
  await prisma.jotformInbox.update({ where: { id: item.id }, data: { status: "DISMISSED", resolvedAt: new Date(), resolvedById: actor.id } });
  await audit(prisma, { actorId: actor.id, action: "questionnaire.inbox_dismissed", entityType: "JotformInbox", entityId: item.id, details: { note: note.trim().slice(0, 200) } });
}

/**
 * Corrects a wrong assignment: moves a submission (and its vault files) to
 * the right client and/or tax year. Only before review — once answers have
 * been applied to a client record it can't be moved. Audited with a reason.
 */
export async function reassignSubmission(actor: Actor, submissionRowId: string, input: { clientId: string; taxYear: number; note: string }) {
  if (!input.note.trim()) throw new ValidationError("Say why it's being moved.");
  if (!Number.isInteger(input.taxYear) || input.taxYear < 2000 || input.taxYear > currentYear() + 1) throw new ValidationError("Choose the tax year.");
  const sub = await prisma.questionnaireSubmission.findUniqueOrThrow({ where: { id: submissionRowId } });
  if (sub.reviewStatus === "REVIEWED") throw new ValidationError("This questionnaire was already reviewed and applied; it can't be moved.");
  if (sub.clientId === input.clientId && sub.taxYear === input.taxYear) throw new ValidationError("It's already assigned to that client and year.");
  const target = await prisma.client.findUnique({ where: { id: input.clientId }, select: { id: true, archivedAt: true } });
  if (!target || target.archivedAt) throw new ValidationError("Choose an active client.");
  const q = await prisma.taxQuestionnaire.findFirst({ where: { jotformFormId: sub.jotformFormId, taxYear: input.taxYear } });
  await prisma.$transaction(async (tx) => {
    await tx.questionnaireSubmission.update({ where: { id: sub.id }, data: { clientId: input.clientId, taxYear: input.taxYear, questionnaireId: q?.id ?? null, matchNote: `Reassigned by staff: ${input.note.trim().slice(0, 200)}`, followUp: Prisma.DbNull } });
    if (sub.documentIds.length) await tx.document.updateMany({ where: { id: { in: sub.documentIds } }, data: { clientId: input.clientId, year: input.taxYear } });
    await audit(tx, { actorId: actor.id, action: "questionnaire.reassigned", entityType: "QuestionnaireSubmission", entityId: sub.id, clientId: sub.clientId, details: { from: { clientId: sub.clientId, taxYear: sub.taxYear }, to: { clientId: input.clientId, taxYear: input.taxYear }, files: sub.documentIds.length } });
    await audit(tx, { actorId: actor.id, action: "questionnaire.reassigned_in", entityType: "QuestionnaireSubmission", entityId: sub.id, clientId: input.clientId, details: { fromClientId: sub.clientId } });
  });
}
