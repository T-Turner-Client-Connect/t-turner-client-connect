import "server-only";
import { prisma } from "@/lib/prisma";
import { audit } from "@/lib/audit";
import type { Actor } from "@/lib/auth/actor";
import { storage } from "@/lib/storage";
import { ValidationError } from "./clients";
import { readDocumentBytes, retentionDate, storeDocumentFile } from "./documents";
import { canStaffViewIdentity, ensureClientPerson, ID_ROLES, ID_TYPES, openVerificationTask, type IdRole, type IdType } from "./identity";

/**
 * Identity documents that clients already sent with their Jotform tax questionnaire (driver's
 * licenses, birth certificates, Social Security cards, passports) are filed into the client's
 * Identity Documents, so nobody scans or uploads them again.
 *
 * - Which document and whose it is comes from the Jotform question the file was uploaded under
 *   ("Spouse's driver's license"). The images themselves are never read by Coetha or anyone else
 *   to decide. A file whose question doesn't say clearly stays where it is for staff to file.
 * - Filing keeps ONE record: the same Document moves from the tax folder into Identity, its file
 *   is re-stored encrypted (like every identity upload) and the unencrypted copy is removed.
 * - It arrives "Pending verification" with the usual staff task. Identity's rules then apply:
 *   Social Security cards and birth certificates Admin-only, never opened in the portal.
 * - The most recent document of a kind is the one on file; an older one is kept as history.
 */

export type IdFiling = { type: IdType; role: Exclude<IdRole, "OWNER">; /** "Dependent (2) …": which dependent the question is about. */ index?: number };

/** The identity document a Jotform upload question asks for, and whose it is; null when unclear. */
export function classifyIdQuestion(question: string): IdFiling | null {
  const q = question.toLowerCase();
  const type: IdType | null = /passport/.test(q)
    ? "PASSPORT"
    : /social security|soc\.? ?sec|\bss card\b|\bssn card\b/.test(q)
      ? "SOCIAL_SECURITY_CARD"
      : /birth cert/.test(q)
        ? "BIRTH_CERTIFICATE"
        : /driver'?s? ?licen[cs]e|drivers? licen[cs]e|\bdl\b|state id|state-issued id|photo id/.test(q)
          ? "DRIVERS_LICENSE"
          : null;
  if (!type) return null;
  // "Upload Social Security Card(s)": several people's cards in one upload — whose can't be told.
  if (/cards?\s*\(s\)|\bcards\b|certificates\b/.test(q)) return null;
  const role = /spouse|wife|husband/.test(q) ? "SPOUSE" : /dependent|child|children|\bkid|\bson\b|daughter/.test(q) ? "DEPENDENT" : "CLIENT";
  const n = role === "DEPENDENT" ? /dependent\s*\(?\s*(\d)\s*\)?/.exec(q)?.[1] : undefined;
  return n ? { type, role, index: Number(n) } : { type, role };
}

/** The spouse's name from the questionnaire's answers (a "spouse … name" question), if any. */
export function spouseNameFrom(pairs: { q: string; a: string }[]) {
  const hit = pairs.find((p) => /spouse/i.test(p.q) && /name/i.test(p.q) && !/maiden|employer|business/i.test(p.q));
  const name = hit?.a.replace(/\s+/g, " ").trim().slice(0, 120);
  return name && /[a-z]/i.test(name) ? name : null;
}

async function personFor(clientId: string, role: IdFiling["role"], spouseName: string | null, index?: number) {
  if (role === "CLIENT") return ensureClientPerson(clientId);
  if (role === "SPOUSE") {
    const existing = await prisma.identityPerson.findFirst({ where: { clientId, role: "SPOUSE", archivedAt: null } });
    if (existing) return existing;
    if (!spouseName) return null;
    return prisma.identityPerson.create({ data: { clientId, role: "SPOUSE", name: spouseName } });
  }
  // Dependents: only when there is exactly one on file (the question doesn't say which child), and
  // never for "Dependent (2)" or later — that is another child than the one on file.
  if (index && index > 1) return null;
  const deps = await prisma.identityPerson.findMany({ where: { clientId, role: "DEPENDENT", archivedAt: null } });
  return deps.length === 1 ? deps[0] : null;
}

export type FileResult = { documentId: string; filed: boolean; label: string; reason?: string };

/**
 * Files one questionnaire upload into Identity Documents. `takenAt` is when the client sent it
 * (the submission date); it decides which document of a kind is the most recent.
 */
export async function fileIntoIdentity(actor: Actor | null, input: { clientId: string; documentId: string; filing: IdFiling; takenAt: Date; spouseName?: string | null; personId?: string }): Promise<FileResult> {
  const { clientId, documentId, filing } = input;
  const t = ID_TYPES[filing.type];
  const label = `${t.label} — ${ID_ROLES[filing.role]}`;
  const doc = await prisma.document.findFirst({ where: { id: documentId, clientId, deletedAt: null }, include: { file: true } });
  if (!doc?.file) return { documentId, filed: false, label, reason: "The file isn't on file." };
  if (doc.category === "IDENTITY" || (await prisma.identityDocument.count({ where: { documentId: doc.id } }))) return { documentId, filed: false, label, reason: "Already in Identity Documents." };
  if (doc.scanStatus === "INFECTED") return { documentId, filed: false, label, reason: "The file failed the malware scan." };
  const person = input.personId
    ? await prisma.identityPerson.findFirst({ where: { id: input.personId, clientId, archivedAt: null } })
    : await personFor(clientId, filing.role, input.spouseName ?? null, filing.index);
  if (!person) return { documentId, filed: false, label, reason: filing.role === "SPOUSE" ? "No spouse is listed and the questionnaire doesn't give the spouse's name." : "The questionnaire doesn't say which dependent it is." };

  // Re-store the same bytes encrypted (identity files are always encrypted at rest).
  const bytes = await readDocumentBytes(doc.file);
  if (!bytes) return { documentId, filed: false, label, reason: "The file couldn't be read from storage." };
  const stored = doc.file.encrypted ? null : await storeDocumentFile(bytes, doc.file.originalName, actor ? { staff: actor } : { system: "jotform" }, clientId, { encrypt: true, allowOffice: true });

  // The most recent one of this kind is the one on file; anything older stays as history.
  const newer = await prisma.identityDocument.count({ where: { personId: person.id, type: filing.type, createdAt: { gt: input.takenAt }, status: { in: ["VERIFIED", "PENDING_VERIFICATION", "EXPIRED"] } } });
  try {
    const rec = await prisma.$transaction(async (tx) => {
      let fileId = doc.fileId;
      if (stored) {
        const file = await tx.storedFile.create({ data: stored.fileData });
        fileId = file.id;
      }
      await tx.document.update({
        where: { id: doc.id },
        data: { category: "IDENTITY", docType: filing.type, title: label, fileId, visibility: "PUBLISHED", needsReview: true, retainUntil: await retentionDate("IDENTITY") },
      });
      if (stored) await tx.storedFile.delete({ where: { id: doc.file!.id } });
      // A newer copy on file: older unverified copies of the same document become history.
      if (!newer) {
        const older = await tx.identityDocument.findMany({ where: { personId: person.id, type: filing.type, status: "PENDING_VERIFICATION", createdAt: { lt: input.takenAt } }, select: { id: true, verificationTaskId: true } });
        if (older.length) {
          await tx.identityDocument.updateMany({ where: { id: { in: older.map((o) => o.id) } }, data: { status: "REPLACED", replacedAt: new Date() } });
          const tasks = older.map((o) => o.verificationTaskId).filter((x): x is string => !!x);
          if (tasks.length) await tx.task.updateMany({ where: { id: { in: tasks }, status: "OPEN" }, data: { status: "DONE", completedAt: new Date() } });
        }
      }
      const r = await tx.identityDocument.create({
        data: {
          clientId, personId: person.id, type: filing.type, documentId: doc.id,
          status: newer ? "REPLACED" : "PENDING_VERIFICATION", replacedAt: newer ? new Date() : null,
          uploadedByStaffId: actor?.id ?? null, createdAt: input.takenAt,
        },
      });
      await tx.documentAccessLog.create({ data: { documentId: doc.id, action: "LINK", staffUserId: actor?.id ?? null } });
      await audit(tx, { actorId: actor?.id ?? null, action: "identity.filed_from_questionnaire", entityType: "IdentityDocument", entityId: r.id, clientId, details: { type: filing.type, role: filing.role, documentId: doc.id, history: !!newer, reencrypted: !!stored } });
      return r;
    });
    // The unencrypted copy is removed only once the encrypted one is in place.
    if (stored) await storage.remove(doc.file.storageKey).catch(() => {});
    if (rec.status === "PENDING_VERIFICATION") await openVerificationTask(rec.id, actor?.id ?? null);
    return { documentId, filed: true, label: newer ? `${label} (older copy, kept as history)` : label };
  } catch (err) {
    if (stored) await storage.remove(stored.storageKey).catch(() => {});
    throw err;
  }
}

/** Files every recognized identity upload of one submission (new imports). Never fails the import. */
export async function fileSubmissionIdentity(actor: Actor | null, input: { clientId: string; takenAt: Date; spouseName: string | null; items: { documentId: string; question: string | null }[] }) {
  const results: FileResult[] = [];
  for (const it of input.items) {
    const filing = it.question ? classifyIdQuestion(it.question) : null;
    if (!filing) continue;
    try {
      results.push(await fileIntoIdentity(actor, { clientId: input.clientId, documentId: it.documentId, filing, takenAt: input.takenAt, spouseName: input.spouseName }));
    } catch (err) {
      if (!(err instanceof ValidationError)) console.error("identity filing failed", err instanceof Error ? err.name : "error");
    }
  }
  return results;
}

// --- Questionnaires already pulled over ---------------------------------------------------

const baseName = (u: string) => {
  try {
    return decodeURIComponent(new URL(u).pathname.split("/").pop() || "");
  } catch {
    return "";
  }
};

export type ExistingPlanItem = { documentId: string; title: string; taxYear: number; filing: IdFiling | null; question: string | null };

/**
 * For each questionnaire already pulled over for this client: its uploads that are still in the
 * tax folders, with the identity document each one is (from the Jotform question it was uploaded
 * under). Reads the submissions again from Jotform (questions only matter here).
 */
export async function existingQuestionnaireIdentity(actor: Actor, clientId: string, fetchSub: (submissionId: string) => Promise<{ answers?: Record<string, { type?: string; text?: string; name?: string; answer?: unknown }> }>) {
  if (!(await canStaffViewIdentity(actor, clientId))) throw new ValidationError("Only an Admin or the client's assigned staff member can file identity documents.");
  const subs = await prisma.questionnaireSubmission.findMany({ where: { clientId, NOT: { documentIds: { isEmpty: true } } }, orderBy: { submittedAt: "asc" } });
  const items: (ExistingPlanItem & { takenAt: Date; spouseName: string | null })[] = [];
  for (const s of subs) {
    const docs = await prisma.document.findMany({ where: { id: { in: s.documentIds }, clientId, deletedAt: null, category: { not: "IDENTITY" } }, include: { file: { select: { originalName: true } } } });
    if (!docs.length) continue;
    let labels = new Map<string, string>();
    let spouseName: string | null = null;
    try {
      const sub = await fetchSub(s.submissionId);
      const answers = Object.values(sub.answers ?? {});
      labels = new Map(answers.filter((a) => a.type === "control_fileupload").flatMap((a) => (Array.isArray(a.answer) ? a.answer : [a.answer]).filter((u): u is string => typeof u === "string").map((u) => [baseName(u), String(a.text || a.name || "")] as const)));
      spouseName = spouseNameFrom(answers.filter((a) => a.type !== "control_fileupload" && typeof a.answer === "string").map((a) => ({ q: String(a.text || a.name || ""), a: String(a.answer) })));
    } catch {
      // Jotform unreachable: these files are listed without a question, for staff to file.
    }
    for (const d of docs) {
      const question = labels.get(d.file?.originalName ?? "") ?? null;
      items.push({ documentId: d.id, title: d.title, taxYear: s.taxYear, question, filing: question ? classifyIdQuestion(question) : null, takenAt: s.submittedAt ?? s.createdAt, spouseName });
    }
  }
  return items;
}

/**
 * "Move Jotform ID documents to Identity": files every recognized identity upload from this
 * client's questionnaires already pulled over. Returns what was filed and what is left for staff.
 */
export async function moveQuestionnaireIdentity(actor: Actor, clientId: string) {
  const { fetchSubmission } = await import("./tax-center");
  const plan = await existingQuestionnaireIdentity(actor, clientId, (id) => fetchSubmission(id) as never);
  const filed: FileResult[] = [];
  const left: FileResult[] = [];
  // Oldest first, so the most recent copy of each document ends up on file.
  for (const it of plan.filter((p) => p.filing).sort((a, b) => a.takenAt.getTime() - b.takenAt.getTime())) {
    const r = await fileIntoIdentity(actor, { clientId, documentId: it.documentId, filing: it.filing!, takenAt: it.takenAt, spouseName: it.spouseName });
    (r.filed ? filed : left).push(r);
  }
  await audit(prisma, { actorId: actor.id, action: "identity.questionnaire_move", entityType: "Client", entityId: clientId, clientId, details: { filed: filed.length, left: left.length, unrecognized: plan.filter((p) => !p.filing).length } });
  return { filed, left, unrecognized: plan.filter((p) => !p.filing).length };
}

/** Staff file one questionnaire upload into Identity by hand (the question didn't say clearly). */
export async function fileQuestionnaireUploadByHand(actor: Actor, clientId: string, documentId: string, input: { type: string; personId: string }) {
  if (!(await canStaffViewIdentity(actor, clientId))) throw new ValidationError("Only an Admin or the client's assigned staff member can file identity documents.");
  if (!(input.type in ID_TYPES)) throw new ValidationError("Choose the kind of document.");
  const person = await prisma.identityPerson.findFirst({ where: { id: input.personId, clientId, archivedAt: null } });
  if (!person || person.role === "OWNER") throw new ValidationError("Choose whose document this is.");
  const doc = await prisma.document.findFirst({ where: { id: documentId, clientId, docType: "QUESTIONNAIRE_UPLOAD", deletedAt: null }, select: { createdAt: true } });
  if (!doc) throw new ValidationError("That questionnaire upload isn't on file for this client.");
  const sub = await prisma.questionnaireSubmission.findFirst({ where: { clientId, documentIds: { has: documentId } }, select: { submittedAt: true } });
  // A spouse or dependent chosen by hand: file under that exact person.
  const r = await fileIntoIdentityFor(actor, { clientId, documentId, type: input.type as IdType, personId: person.id, takenAt: sub?.submittedAt ?? doc.createdAt });
  if (!r.filed) throw new ValidationError(r.reason ?? "It couldn't be filed.");
  return r;
}

/** Like fileIntoIdentity, for the exact person staff chose. */
async function fileIntoIdentityFor(actor: Actor, input: { clientId: string; documentId: string; type: IdType; personId: string; takenAt: Date }) {
  const person = await prisma.identityPerson.findUniqueOrThrow({ where: { id: input.personId } });
  return fileIntoIdentity(actor, { clientId: input.clientId, documentId: input.documentId, filing: { type: input.type, role: person.role as IdFiling["role"] }, takenAt: input.takenAt, personId: person.id });
}
