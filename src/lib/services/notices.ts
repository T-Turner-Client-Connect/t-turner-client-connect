import "server-only";
import { isFutureDay } from "@/lib/dates";
import { prisma } from "@/lib/prisma";
import { audit } from "@/lib/audit";
import type { Actor } from "@/lib/auth/actor";
import type { PortalActor } from "@/lib/portal/session";
import { requireClientAccess } from "@/lib/portal/access";
import { ValidationError } from "./clients";
import { portalUploadDocument } from "./documents";

/**
 * Audits & Notices: letters from the IRS, a state or a local agency that a
 * client uploads. Each upload opens (or adds to) a case in the client's
 * yearly vault and alerts Tabitha and the assigned staff member. "Received"
 * means only that our office has it — never that it's been reviewed or answered.
 */

export const AGENCIES = { IRS: "IRS", STATE: "State tax agency", LOCAL: "Local / city / county", NOT_SURE: "Not sure" } as const;
export const NOTICE_STATUS = {
  RECEIVED: { label: "Received — not yet reviewed", tone: "amber" },
  UNDER_REVIEW: { label: "Under review by our office", tone: "navy" },
  RESPONDED: { label: "Response sent", tone: "green" },
  CLOSED: { label: "Closed", tone: "gray" },
} as const;

const day = (s: string | null | undefined) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s ?? "");
  return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12) : null;
};

/** How close a response deadline is: shown to staff (and to the client as the date they gave). */
export function deadlineFlag(c: { responseDueOn: Date | null; status: string }, now = new Date()) {
  if (!c.responseDueOn || c.status === "RESPONDED" || c.status === "CLOSED") return null;
  const days = Math.ceil((c.responseDueOn.getTime() - now.getTime()) / 86_400_000);
  if (days < 0) return { tone: "red" as const, text: `Response deadline passed ${-days} day${days === -1 ? "" : "s"} ago` };
  if (days <= 7) return { tone: "red" as const, text: `Response due in ${days} day${days === 1 ? "" : "s"}` };
  if (days <= 14) return { tone: "amber" as const, text: `Response due in ${days} days` };
  return { tone: "gray" as const, text: `Response due in ${days} days` };
}

export type NoticeInput = { taxYear: string; agency: string; agencyDetail?: string; receivedOn?: string; responseDueOn?: string; message?: string };

/** A client uploads an audit or notice. Files are scanned and quarantined like every upload. */
export async function submitNotice(user: PortalActor, clientId: string, input: NoticeInput, files: { bytes: Uint8Array; originalName: string }[]) {
  await requireClientAccess(user.id, clientId, "upload");
  if (!files.length) throw new ValidationError("Choose the notice or letter to upload (a photo or PDF).");
  if (files.length > 10) throw new ValidationError("Upload up to 10 files at a time.");
  const thisYear = new Date().getFullYear();
  let taxYear: number | null = null;
  if (input.taxYear !== "unsure") {
    taxYear = Number(input.taxYear);
    if (!Number.isInteger(taxYear) || taxYear < thisYear - 15 || taxYear > thisYear) throw new ValidationError("Choose the tax year on the notice, or “Not sure”.");
  }
  if (!(input.agency in AGENCIES)) throw new ValidationError("Choose who sent the notice, or “Not sure”.");
  const receivedOn = day(input.receivedOn);
  if (input.receivedOn && !receivedOn) throw new ValidationError("Enter the date you received it, or leave it blank.");
  // Calendar days in Chicago: today is fine at any hour.
  if (receivedOn && isFutureDay(input.receivedOn!)) throw new ValidationError("The date received can't be in the future.");
  const responseDueOn = day(input.responseDueOn);
  if (input.responseDueOn && !responseDueOn) throw new ValidationError("Enter the response deadline, or leave it blank if you're not sure.");
  const kase = await prisma.noticeCase.create({
    data: {
      clientId, taxYear, agency: input.agency, agencyDetail: input.agencyDetail?.trim().slice(0, 120) || null, receivedOn, responseDueOn,
      clientMessage: input.message?.trim().slice(0, 2000) || null, createdByPortalId: user.id,
    },
  });
  const label = `${AGENCIES[input.agency as keyof typeof AGENCIES] === "Not sure" ? "Tax" : AGENCIES[input.agency as keyof typeof AGENCIES]} notice${receivedOn ? ` received ${receivedOn.toLocaleDateString("en-US")}` : ""}`;
  const saved = [];
  for (const f of files) {
    const doc = await portalUploadDocument(user, { clientId, year: taxYear ?? "unsure", docType: "AGENCY_LETTER", title: label, bytes: f.bytes, originalName: f.originalName });
    await prisma.document.update({ where: { id: doc.id }, data: { noticeCaseId: kase.id } });
    saved.push(doc);
  }
  await prisma.auditLog.create({ data: { action: "notice.submitted_by_client", entityType: "NoticeCase", entityId: kase.id, clientId, details: { portalUserId: user.id, files: saved.length, taxYear, agency: input.agency, responseDueOn: responseDueOn?.toISOString() ?? null } } });
  await alertStaff(kase.id);
  return { case: kase, documents: saved };
}

/** Review tasks for the assigned staff member and Tabitha (high priority when the deadline is within 14 days or unknown). */
async function alertStaff(caseId: string) {
  const c = await prisma.noticeCase.findUniqueOrThrow({ where: { id: caseId }, include: { client: { select: { displayName: true, assignedToId: true } } } });
  const owner = await prisma.ownerAccess.findFirst({ where: { isPrimary: true, revokedAt: null }, select: { userId: true } });
  const creator = owner?.userId ?? (await prisma.user.findFirst({ where: { role: "ADMIN", active: true }, orderBy: { createdAt: "asc" }, select: { id: true } }))?.id;
  if (!creator) return;
  const flag = deadlineFlag(c);
  const urgent = !c.responseDueOn || (flag?.tone === "red") || (flag?.tone === "amber");
  const title = `${AGENCIES[c.agency as keyof typeof AGENCIES]} notice from ${c.client.displayName}${c.taxYear ? ` (${c.taxYear})` : ""}${c.responseDueOn ? ` — respond by ${c.responseDueOn.toLocaleDateString("en-US")}` : " — deadline unknown"}`;
  const assignees = [...new Set([c.client.assignedToId, owner?.userId].filter(Boolean))] as string[];
  for (const assigneeId of assignees.length ? assignees : [null]) {
    await prisma.task.create({
      data: { title, details: "Uploaded by the client in the portal. Open the client's Documents tab → Audits & Notices. The client has been told only that we received it.", clientId: c.clientId, assigneeId, createdById: creator, priority: urgent ? "HIGH" : "NORMAL", dueAt: c.responseDueOn },
    });
  }
}

export async function clientNoticeCases(user: PortalActor, clientId: string) {
  await requireClientAccess(user.id, clientId);
  return prisma.noticeCase.findMany({ where: { clientId }, include: { documents: { where: { deletedAt: null }, select: { id: true, title: true, scanStatus: true, createdAt: true } } }, orderBy: { createdAt: "desc" } });
}

export function openNoticeCases() {
  return prisma.noticeCase.findMany({ where: { status: { in: ["RECEIVED", "UNDER_REVIEW"] } }, include: { client: { select: { id: true, displayName: true } }, documents: { select: { id: true } } }, orderBy: [{ responseDueOn: "asc" }, { createdAt: "asc" }] });
}

export async function setNoticeStatus(actor: Actor, caseId: string, status: string) {
  if (!(status in NOTICE_STATUS)) throw new ValidationError("Choose a status.");
  const c = await prisma.noticeCase.update({ where: { id: caseId }, data: { status, updatedById: actor.id } });
  await audit(prisma, { actorId: actor.id, action: "notice.status_changed", entityType: "NoticeCase", entityId: caseId, clientId: c.clientId, details: { status } });
}
