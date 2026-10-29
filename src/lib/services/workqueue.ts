import "server-only";
import { startOfDay } from "date-fns";
import { prisma } from "@/lib/prisma";

/** Everything waiting on staff, in one place. */
export async function workQueue() {
  const today = startOfDay(new Date());
  const [unanswered, submittedRequests, overdueRequests, periodsAwaiting, signatures, contracts, unscanned] = await Promise.all([
    prisma.conversation.findMany({
      where: { awaitingStaff: true, closedAt: null },
      include: { client: { select: { id: true, displayName: true } }, assignedTo: { select: { name: true } } },
      orderBy: { lastMessageAt: "asc" },
      take: 100,
    }),
    prisma.documentRequest.findMany({
      where: { status: "SUBMITTED" },
      include: { client: { select: { id: true, displayName: true } }, _count: { select: { documents: true } } },
      orderBy: { updatedAt: "asc" },
      take: 100,
    }),
    prisma.documentRequest.findMany({
      where: { status: "OPEN", dueAt: { lt: today } },
      include: { client: { select: { id: true, displayName: true } } },
      orderBy: { dueAt: "asc" },
      take: 100,
    }),
    prisma.bookkeepingPeriod.findMany({
      where: { status: { in: ["IN_PROGRESS", "AWAITING_DOCUMENTS"] }, documents: { some: { uploadedByPortalId: { not: null }, deletedAt: null } } },
      include: { client: { select: { id: true, displayName: true } } },
      orderBy: [{ year: "asc" }, { month: "asc" }],
      take: 100,
    }),
    prisma.signatureRequest.findMany({
      where: { status: { in: ["DRAFT", "SENT", "VIEWED", "PARTIALLY_SIGNED"] } },
      include: { client: { select: { id: true, displayName: true } } },
      orderBy: { createdAt: "asc" },
      take: 100,
    }),
    prisma.contractAssignment.findMany({
      where: { status: { in: ["ASSIGNED", "SUBMITTED"] } },
      include: { client: { select: { id: true, displayName: true } } },
      orderBy: { createdAt: "asc" },
      take: 100,
    }),
    prisma.document.count({ where: { uploadedByPortalId: { not: null }, scanStatus: { in: ["NOT_SCANNED", "PENDING"] }, deletedAt: null } }),
  ]);
  return { unanswered, submittedRequests, overdueRequests, periodsAwaiting, signatures, contracts, unscanned };
}
