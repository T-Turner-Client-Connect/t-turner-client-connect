"use server";

import { revalidatePath } from "next/cache";
import { requirePortalUser } from "@/lib/portal/session";
import { requireClientAccess } from "@/lib/portal/access";
import { requireUser } from "@/lib/auth/session";
import { run, str, type ActionState } from "@/lib/action";
import { prisma } from "@/lib/prisma";
import { ValidationError } from "@/lib/services/clients";
import { setNoticeStatus, submitNotice } from "@/lib/services/notices";

export async function submitNoticeAction(clientId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const user = await requirePortalUser();
  return run(async () => {
    const files = await Promise.all(
      fd.getAll("file").filter((f): f is File => f instanceof File && f.size > 0).map(async (f) => ({ bytes: new Uint8Array(await f.arrayBuffer()), originalName: f.name })),
    );
    const r = await submitNotice(user, clientId, { taxYear: str(fd, "taxYear"), agency: str(fd, "agency"), agencyDetail: str(fd, "agencyDetail"), receivedOn: str(fd, "receivedOn"), responseDueOn: str(fd, "responseDueOn"), message: str(fd, "message") }, files);
    revalidatePath("/client", "layout");
    const held = r.documents.some((d) => d.scanStatus !== "CLEAN");
    return `Received — thank you. We have your notice (${r.documents.length} file${r.documents.length === 1 ? "" : "s"}) and our team has been alerted. This confirms only that we received it; we'll review it and contact you.${held ? " Your files are being checked for viruses first." : ""}`;
  });
}

/** "Request Another Tax Year": a task for the office (no form or link is invented). */
export async function requestTaxYearAction(clientId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const user = await requirePortalUser();
  return run(async () => {
    await requireClientAccess(user.id, clientId, "tax");
    const year = Number(str(fd, "year"));
    const thisYear = new Date().getFullYear();
    if (!Number.isInteger(year) || year < 2000 || year > thisYear) throw new ValidationError("Enter the tax year you need help with.");
    const client = await prisma.client.findUniqueOrThrow({ where: { id: clientId }, select: { displayName: true, assignedToId: true } });
    const owner = await prisma.ownerAccess.findFirst({ where: { isPrimary: true, revokedAt: null }, select: { userId: true } });
    const creator = owner?.userId ?? (await prisma.user.findFirst({ where: { role: "ADMIN", active: true }, select: { id: true } }))?.id;
    if (!creator) throw new ValidationError("Please message our office for this request.");
    await prisma.task.create({ data: { title: `${client.displayName} asked for help with tax year ${year}`, details: `Requested in the portal by ${user.name}.${str(fd, "note") ? ` Note: ${str(fd, "note").slice(0, 500)}` : ""}`, clientId, assigneeId: client.assignedToId ?? owner?.userId ?? null, createdById: creator } });
    await prisma.auditLog.create({ data: { action: "tax.year_requested", entityType: "Client", entityId: clientId, clientId, details: { year, portalUserId: user.id } } });
    return `Request sent for ${year}. Our office will contact you.`;
  });
}

export async function noticeStatusAction(caseId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    await setNoticeStatus(actor, caseId, str(fd, "status"));
    revalidatePath("/notices");
    return "Status updated.";
  });
}
