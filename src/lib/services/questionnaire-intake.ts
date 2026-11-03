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
import { ALL_DOC_TYPES } from "@/lib/document-types";
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
  { key: "1099nec", label: "1099-NEC / 1099-MISC / 1099-K and a summary of business income and expenses", ask: /self[\s-]?employ|1099-?(nec|misc|k)\b|contract(or)? (work|income)|gig|freelanc|side business/i, doc: /1099-?(nec|misc|k)\b|profit|business (income|expense)|self-employment/i },
  { key: "invest", label: "1099-INT / 1099-DIV / 1099-B from banks and brokerages", ask: /interest (income|earned)|earn(ed)? interest|bank interest|dividend|brokerage|stock|crypto|investment/i, doc: /1099-?(int|div|b)\b|brokerage|consolidated/i },
  { key: "retire", label: "1099-R for retirement or pension distributions", ask: /retire|pension|401\s?\(?k|\bira\b.*distribut|distribut.*\bira\b/i, doc: /1099-?r\b/i },
  { key: "ssa", label: "SSA-1099 for Social Security benefits", ask: /social security benefit|ssa-?1099/i, doc: /ssa-?1099/i },
  { key: "unemp", label: "1099-G for unemployment or state refunds", ask: /unemploy/i, doc: /1099-?g\b/i },
  { key: "mortgage", label: "1098 Mortgage Interest Statement", ask: /mortgage|home loan/i, doc: /mortgage/i },
  { key: "tuition", label: "1098-T for tuition (and receipts for books/fees)", ask: /tuition|college|universit|education credit/i, doc: /1098-?t\b|tuition/i },
  { key: "childcare", label: "Child or dependent care provider statement (name, address, amount paid)", ask: /child ?care|day ?care|dependent care/i, doc: /child ?care|day ?care|provider/i },
  { key: "hsa", label: "HSA forms 1099-SA and 5498-SA", ask: /\bhsa\b|health savings/i, doc: /1099-?sa|5498|\bhsa\b/i },
  { key: "marketplace", label: "Form 1095-A for Marketplace health insurance", ask: /marketplace|healthcare\.gov|1095-?a/i, doc: /1095-?a/i },
  { key: "rental", label: "Rental income and expense summary", ask: /rental|landlord|rent (out|income)/i, doc: /rental|rent roll|lease/i },
  { key: "charity", label: "Charitable donation receipts", ask: /charit|donat/i, doc: /charit|donation/i },
  { key: "vehicle_tag", label: "Vehicle registration / car tag receipt", ask: /vehicle registration|car tag|tag renewal|ad valorem/i, doc: /registration|car tag/i },
  { key: "vehicle_loan", label: "Vehicle loan interest statement (VIN, purchase date, lender statement)", ask: /vehicle loan|car loan|auto loan/i, doc: /vehicle loan interest|car loan|auto loan/i },
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
  const items = followUpChecklist(submissionAnswers(sub), docs.map((d) => `${d.title} ${d.docType ? ALL_DOC_TYPES[d.docType] ?? d.docType : ""}`));
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

/** Identifiers kept on an inbox item (no answers) — used only to suggest a client. */
function inboxFacts(sub: JotSubmission) {
  const sum = summarize(sub);
  return {
    emails: sum.emails.slice(0, 5),
    phones: sum.phones.slice(0, 5),
    names: sum.names.map((n) => n.slice(0, 120)).slice(0, 5),
    submittedAt: sub.created_at ? new Date(sub.created_at.replace(" ", "T") + "Z") : null,
  };
}

/**
 * A verified questionnaire webhook (the submission was re-read from the
 * Jotform API). Every submission is listed in the central Questionnaire
 * Inbox. A valid personal link (signed for one client + that year's form) is
 * associated automatically and listed as Verified/New Client for answer
 * review; everything else waits as Needs Matching. Never recorded twice.
 */
export async function routeQuestionnaireWebhook(sub: JotSubmission, ref: string | null, arrivedVia: "WEBHOOK" | "IMPORT" = "WEBHOOK"): Promise<string> {
  if (!sub.id || !sub.form_id) return "Missing submission; ignored";
  if (await prisma.jotformInbox.findUnique({ where: { submissionId: sub.id } })) return "Already in the inbox";
  const alreadyFiled = await prisma.questionnaireSubmission.findUnique({ where: { submissionId: sub.id } });
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
    else {
      suggestedClientId = client.id;
      reason = forms.some((f) => f.taxYear === parsed.taxYear) ? "HELD" : "FORM_YEAR_MISMATCH";
    }
  }
  if (!forms.length && !parsed) return "Not one of our questionnaire forms; ignored";
  const facts = inboxFacts(sub);
  const base = { submissionId: sub.id, formId: sub.form_id, questionnaireId: forms.find((f) => f.taxYear === taxYear)?.id ?? null, taxYear, suggestedClientId, reason, arrivedVia, ...facts };
  if (alreadyFiled) {
    // Filed earlier (e.g. linked before the inbox existed): list it as Assigned.
    await prisma.jotformInbox.create({ data: { ...base, status: "FILED", filedClientId: alreadyFiled.clientId, resolvedAt: alreadyFiled.createdAt } });
    return "Already recorded";
  }
  if (reason === "HELD") {
    // Approved rule: a submission from a verified personal Client Connect link
    // is associated with that client and tax year automatically. This only
    // links it — answers never change the client record and documents stay
    // "needs review" until staff approve them.
    const result = await recordQuestionnaireWebhook(sub, ref!);
    await prisma.jotformInbox.create({ data: { ...base, status: "FILED", filedClientId: suggestedClientId, resolvedAt: new Date() } });
    return result;
  }
  const row = await prisma.jotformInbox.create({ data: base });
  await audit(prisma, { actorId: null, action: "questionnaire.received", entityType: "JotformInbox", entityId: row.id, clientId: suggestedClientId, details: { reason, taxYear, arrivedVia } });
  return `Held for staff review (${reason})`;
}

/**
 * Pulls recent submissions of every configured questionnaire form into the
 * inbox (e.g. ones sent before the webhook existed). Staff never search
 * Jotform by hand. Nothing is filed; duplicates are skipped.
 */
export async function importRecentSubmissions(actor: Actor) {
  const c = jotformConfig();
  if (!c.apiKey) throw new ValidationError("Jotform isn't connected (JOTFORM_API_KEY).");
  const forms = await prisma.taxQuestionnaire.findMany({ where: { jotformFormId: { not: null } } });
  if (!forms.length) throw new ValidationError("No questionnaire forms are set up yet (News & Countdowns → Tax questionnaires).");
  let added = 0;
  let seen = 0;
  for (const formId of Array.from(new Set(forms.map((f) => f.jotformFormId!)))) {
    const res = await fetch(`${c.apiBase}/form/${encodeURIComponent(formId)}/submissions?limit=200&orderby=created_at`, { headers: { APIKEY: c.apiKey } }).catch(() => null);
    if (!res?.ok) throw new ValidationError(`Jotform API error${res ? ` (HTTP ${res.status})` : ""}.`);
    const subs = (((await res.json()) as { content?: JotSubmission[] }).content ?? []).filter((x) => x.id && (x as { status?: string }).status !== "DELETED");
    for (const sub of subs) {
      seen++;
      const ref = Object.values(sub.answers ?? {}).find((a) => a.name === c.refField)?.answer;
      const r = await routeQuestionnaireWebhook({ ...sub, form_id: sub.form_id ?? formId }, typeof ref === "string" && ref ? ref : null, "IMPORT");
      if (r.startsWith("Held")) added++;
    }
  }
  await audit(prisma, { actorId: actor.id, action: "questionnaire.inbox_imported", entityType: "JotformInbox", details: { seen, added } });
  return { seen, added };
}

export const INBOX_REASON: Record<string, string> = {
  HELD: "Came from the client's personal Client Connect link (verified)",
  NO_REFERENCE: "Came from the public Jotform link",
  BAD_REFERENCE: "Personal link didn't verify",
  FORM_YEAR_MISMATCH: "Form isn't that tax year's questionnaire",
  CLIENT_NOT_FOUND: "The linked client no longer exists",
};

export type InboxKind = "VERIFIED_CLIENT" | "NEW_CLIENT" | "NEEDS_MATCHING";
export const INBOX_KIND: Record<InboxKind, { label: string; tone: "green" | "navy" | "amber" }> = {
  VERIFIED_CLIENT: { label: "Verified Client", tone: "green" },
  NEW_CLIENT: { label: "New Client", tone: "navy" },
  NEEDS_MATCHING: { label: "Needs Matching", tone: "amber" },
};
const NEW_CLIENT_DAYS = 120;

/** Verified personal link → Verified Client (or New Client if they signed up recently); anything else → Needs Matching. */
export function inboxKind(item: { reason: string }, client?: { source: string | null; createdAt: Date } | null, now = new Date()): InboxKind {
  if (item.reason !== "HELD") return "NEEDS_MATCHING";
  const recent = client && now.getTime() - client.createdAt.getTime() < NEW_CLIENT_DAYS * 86_400_000;
  return recent && client?.source?.startsWith("Client portal sign-up") ? "NEW_CLIENT" : "VERIFIED_CLIENT";
}

export type InboxState = "NEW" | "REVIEWED" | "ASSIGNED" | "COMPLETED" | "DISMISSED";
export const INBOX_STATE: Record<InboxState, { label: string; tone: "gold" | "navy" | "amber" | "green" | "gray" }> = {
  NEW: { label: "New", tone: "gold" },
  REVIEWED: { label: "Reviewed", tone: "navy" },
  ASSIGNED: { label: "Assigned — answers to review", tone: "amber" },
  COMPLETED: { label: "Completed", tone: "green" },
  DISMISSED: { label: "Dismissed", tone: "gray" },
};

export function inboxState(item: { status: string; previewedAt: Date | null }, filed?: { reviewStatus: string } | null): InboxState {
  if (item.status === "DISMISSED") return "DISMISSED";
  if (item.status === "FILED") return filed?.reviewStatus === "REVIEWED" ? "COMPLETED" : "ASSIGNED";
  return item.previewedAt ? "REVIEWED" : "NEW";
}

/**
 * Coetha's suggestions: only verified information counts — the client's
 * signed personal link, or an email / phone already on the client's record.
 * A name alone is shown as "name only" and is never pre-selected.
 */
export async function suggestClients(item: { suggestedClientId: string | null; reason: string; emails: string[]; phones: string[]; names: string[] }) {
  const out = new Map<string, { id: string; displayName: string; email: string | null; phone: string | null; why: string[]; verified: boolean }>();
  const add = (c: { id: string; displayName: string; email: string | null; phone: string | null }, why: string, verified: boolean) => {
    const e = out.get(c.id) ?? { ...c, why: [], verified: false };
    e.why.push(why);
    e.verified ||= verified;
    out.set(c.id, e);
  };
  const sel = { id: true, displayName: true, email: true, phone: true } as const;
  if (item.suggestedClientId && item.reason === "HELD") {
    const c = await prisma.client.findUnique({ where: { id: item.suggestedClientId }, select: sel });
    if (c) add(c, "Personal Client Connect link", true);
  }
  if (item.emails.length) {
    for (const c of await prisma.client.findMany({ where: { archivedAt: null, OR: [{ emailNormalized: { in: item.emails } }, { contacts: { some: { emailNormalized: { in: item.emails } } } }] }, select: sel, take: 5 })) add(c, "Same email", true);
  }
  if (item.phones.length) {
    for (const c of await prisma.client.findMany({ where: { archivedAt: null, OR: [{ phoneNormalized: { in: item.phones } }, { contacts: { some: { phoneNormalized: { in: item.phones } } } }] }, select: sel, take: 5 })) add(c, "Same phone", true);
  }
  for (const n of item.names) {
    for (const c of await prisma.client.findMany({ where: { archivedAt: null, displayName: { equals: n, mode: "insensitive" } }, select: sel, take: 5 })) {
      if (!out.has(c.id)) add(c, "Name only — verify before assigning", false);
    }
  }
  return [...out.values()].sort((a, b) => Number(b.verified) - Number(a.verified));
}

export async function markPreviewed(actor: Actor, inboxId: string) {
  await prisma.jotformInbox.updateMany({ where: { id: inboxId, previewedAt: null }, data: { previewedAt: new Date(), previewedById: actor.id } });
}

/**
 * Staff approve the client and tax year in the inbox. Answers are re-read
 * from Jotform; only the attachments staff tick go to that year's vault.
 */
export async function fileInboxItem(actor: Actor, inboxId: string, input: { clientId: string; taxYear: number; yearConfirmed: boolean; fileIndexes?: number[]; note?: string }) {
  const item = await prisma.jotformInbox.findUniqueOrThrow({ where: { id: inboxId } });
  if (item.status !== "PENDING") throw new ValidationError("This submission was already handled.");
  if (!input.yearConfirmed) throw new ValidationError("Confirm the tax year before assigning.");
  if (!input.clientId) throw new ValidationError("Choose the client.");
  const client = await prisma.client.findUnique({ where: { id: input.clientId }, select: { id: true, archivedAt: true } });
  if (!client || client.archivedAt) throw new ValidationError("Choose an active client.");
  const signedRef = item.reason === "HELD" && item.suggestedClientId === input.clientId && item.taxYear === input.taxYear;
  const r = await linkSubmission(actor, { clientId: input.clientId, taxYear: input.taxYear, submissionId: item.submissionId, confirmed: true, signedRef, staffApproved: true, fileIndexes: input.fileIndexes, matchNote: input.note });
  await prisma.jotformInbox.update({ where: { id: item.id }, data: { status: "FILED", resolvedAt: new Date(), resolvedById: actor.id, filedClientId: input.clientId, previewedAt: item.previewedAt ?? new Date(), previewedById: item.previewedById ?? actor.id } });
  await audit(prisma, { actorId: actor.id, action: "questionnaire.assigned_from_inbox", entityType: "JotformInbox", entityId: item.id, clientId: input.clientId, details: { taxYear: input.taxYear, signedRef, files: r.imported } });
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
