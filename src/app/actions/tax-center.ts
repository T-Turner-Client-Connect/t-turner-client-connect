"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth/session";
import { requirePortalUser } from "@/lib/portal/session";
import { requireClientAccess } from "@/lib/portal/access";
import { dateOrNull, run, str, type ActionState } from "@/lib/action";
import { prisma } from "@/lib/prisma";
import { audit } from "@/lib/audit";
import { ValidationError } from "@/lib/services/clients";
import { queueStaffAlert } from "@/lib/services/staff-alerts";
import { ENTITY_TYPES } from "@/lib/tax/deadlines";
import { chicagoLocalToUtc } from "@/lib/tz";

// A calendar date from a date field, stored as noon Central so it never shows as the day before.
const officeDate = (v: string) => (/^\d{4}-\d{2}-\d{2}$/.test(v) ? chicagoLocalToUtc(`${v}T12:00`) : null);
import { confirmPortalIdentity, linkSubmission, previewSubmission, requestFilingCopy, saveQuestionnaire, setTaxYearProgress } from "@/lib/services/tax-center";
import { expireAnnouncement, markDeadlineReviewed, saveAnnouncement, saveDeadline, setAnnouncementPinned, setDeadlineHidden } from "@/lib/services/news";

// --- Client portal ------------------------------------------------------------

export async function requestCopyAction(clientId: string, year: number, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const user = await requirePortalUser();
  return run(async () => {
    const r = await requestFilingCopy(user, clientId, year, str(fd, "note"));
    revalidatePath("/client/taxes/filings");
    return r.created ? `Request sent. Our office will add your ${year} records here and reply in Messages.` : `You already asked for your ${year} records — our office is on it.`;
  });
}

/** "Refer someone": a secure message to the office. No rewards are promised here. */
export async function referralAction(clientId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const user = await requirePortalUser();
  return run(async () => {
    await requireClientAccess(user.id, clientId, "message");
    const name = str(fd, "name").trim();
    const contact = str(fd, "contact").trim();
    if (!name || !contact) throw new ValidationError("Add their name and a phone number or email.");
    const note = str(fd, "note").trim();
    const convo = await prisma.$transaction(async (tx) => {
      const c = await tx.conversation.create({ data: { clientId, subject: `Referral — ${name.slice(0, 80)}`, awaitingStaff: true, unreadByStaff: true } });
      await tx.message.create({ data: { conversationId: c.id, channel: "PORTAL", direction: "INBOUND", portalAuthorId: user.id, status: "DELIVERED", readByClientAt: new Date(), body: `[Referral] ${name.slice(0, 120)}\nContact: ${contact.slice(0, 160)}${note ? `\n\n${note.slice(0, 1000)}` : ""}\n\n(They asked us to reach out; they haven't opted in to marketing.)` } });
      await audit(tx, { actorId: null, action: "referral.submitted", entityType: "Conversation", entityId: c.id, clientId });
      return c;
    });
    await queueStaffAlert({ conversationId: convo.id });
    revalidatePath("/client/messages");
    return "Thank you! We'll reach out to them.";
  });
}

// --- Staff: client tax profile, progress, identity, questionnaires ----------------

export async function taxProfileAction(clientId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    const entityType = str(fd, "entityType") || null;
    if (entityType && !(entityType in ENTITY_TYPES)) throw new ValidationError("Choose an entity type.");
    const fy = str(fd, "fiscalYearEnd");
    const fiscalYearEnd = fy ? Number(fy) : null;
    if (fiscalYearEnd !== null && !(fiscalYearEnd >= 1 && fiscalYearEnd <= 12)) throw new ValidationError("Choose the month the tax year ends.");
    await prisma.client.update({ where: { id: clientId }, data: { entityType, fiscalYearEnd: fiscalYearEnd === 12 ? null : fiscalYearEnd } });
    await audit(prisma, { actorId: actor.id, action: "client.tax_profile_updated", entityType: "Client", entityId: clientId, clientId, details: { entityType, fiscalYearEnd } });
    revalidatePath(`/clients/${clientId}`);
    return "Tax profile saved. Deadline cards now use it.";
  });
}

export async function taxYearProgressAction(clientId: string, year: number, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    await setTaxYearProgress(actor, clientId, year, { documentsStatus: str(fd, "documentsStatus"), estimatedCompletion: officeDate(str(fd, "estimatedCompletion")), estimateNote: str(fd, "estimateNote") });
    revalidatePath(`/clients/${clientId}`);
    return `${year} progress saved.`;
  });
}

export async function confirmIdentityAction(clientId: string, portalUserId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    await confirmPortalIdentity(actor, clientId, portalUserId, str(fd, "note"));
    revalidatePath(`/clients/${clientId}`);
    return "Identity confirmed. This login can now open past-year tax records.";
  });
}

export async function previewSubmissionAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    const p = await previewSubmission(actor, str(fd, "submissionId"));
    if (p.alreadyLinkedTo) return `Already linked to ${p.alreadyLinkedTo}.`;
    return [
      `Form ${p.formId}${p.questionnaireTitle ? ` (${p.questionnaireTitle})` : " (not one of your saved questionnaires)"}`,
      p.submittedAt ? `submitted ${p.submittedAt}` : null,
      `email: ${p.emails.join(", ") || "none"}`,
      p.names.length ? `name: ${p.names.join(", ")}` : null,
      `${p.answerCount} answers, ${p.fileCount} files`,
      p.candidates.length ? `matching clients: ${p.candidates.map((c) => c.displayName).join(", ")}` : "no client has this email — confirm the match yourself",
    ].filter(Boolean).join(" · ");
  });
}

export async function linkSubmissionAction(clientId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    const r = await linkSubmission(actor, { clientId, taxYear: Number(str(fd, "taxYear")), submissionId: str(fd, "submissionId"), confirmed: fd.get("confirmed") === "on", matchNote: str(fd, "matchNote") });
    revalidatePath(`/clients/${clientId}`);
    return `Linked to ${r.row.taxYear}. ${r.imported} file${r.imported === 1 ? "" : "s"} saved as staff-only drafts${r.skipped.length ? `; ${r.skipped.length} skipped (already saved or not a Jotform file)` : ""}. The client won't be asked to complete it again.`;
  });
}

export async function saveQuestionnaireAction(id: string | null, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    await saveQuestionnaire(actor, { taxYear: Number(str(fd, "taxYear")), audience: str(fd, "audience") || "ALL", title: str(fd, "title"), jotformFormId: str(fd, "jotformFormId"), active: fd.get("active") === "on" }, id ?? undefined);
    revalidatePath("/news");
    return "Questionnaire saved.";
  });
}

// --- Staff: news and tax dates ---------------------------------------------------

export async function saveAnnouncementAction(id: string | null, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    const a = await saveAnnouncement(actor, { title: str(fd, "title"), body: str(fd, "body"), audience: str(fd, "audience"), topic: str(fd, "topic"), pinned: fd.get("pinned") === "on", publishAt: dateOrNull(fd, "publishAt"), expiresAt: dateOrNull(fd, "expiresAt") }, id ?? undefined);
    revalidatePath("/news");
    revalidatePath("/client", "layout");
    return a.publishedAt! > new Date() ? "Scheduled. It appears on client dashboards at the start time — no texts or emails are sent." : "Published to client dashboards. No texts or emails are sent.";
  });
}

export async function announcementStepAction(id: string, step: "pin" | "unpin" | "expire") {
  const actor = await requireUser();
  if (step === "expire") await expireAnnouncement(actor, id);
  else await setAnnouncementPinned(actor, id, step === "pin");
  revalidatePath("/news");
}

export async function saveDeadlineAction(id: string | null, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    await saveDeadline(actor, { kind: str(fd, "kind"), taxYear: Number(str(fd, "taxYear")), jurisdiction: str(fd, "jurisdiction") || "US", reliefState: str(fd, "reliefState"), dueDate: str(fd, "dueDate"), timeNote: str(fd, "timeNote"), notes: str(fd, "notes"), sourceUrl: str(fd, "sourceUrl") }, id ?? undefined);
    revalidatePath("/news");
    return "Date saved and marked reviewed by you today.";
  });
}

export async function deadlineStepAction(id: string, step: "reviewed" | "hide" | "show") {
  const actor = await requireUser();
  if (step === "reviewed") await markDeadlineReviewed(actor, id);
  else await setDeadlineHidden(actor, id, step === "hide");
  revalidatePath("/news");
}
