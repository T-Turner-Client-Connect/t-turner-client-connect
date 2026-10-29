import "server-only";
import { startOfDay } from "date-fns";
import type { PortalAccess } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { allowedCategories } from "./access";
import { announcementsFor } from "@/lib/services/bookkeeping";

type Perms = Pick<PortalAccess, "canMessage" | "canUpload" | "canViewBookkeeping" | "canViewTax" | "canViewContracts">;

/**
 * Everything on a client's portal dashboard. Only staff-entered records
 * (published documents, updates, requests, deadlines) are shown — no
 * computed or sample figures.
 */
export async function loadPortalHome(clientId: string, perms: Perms, viewerPortalUserId: string | null) {
  const today = startOfDay(new Date());
  const categories = allowedCategories(perms as PortalAccess);
  const [updates, unread, readyPeriods, newDocs, requests, deadlines, contracts, signatures] = await Promise.all([
    announcementsFor([clientId]),
    perms.canMessage
      ? prisma.message.count({ where: { conversation: { clientId }, channel: "PORTAL", direction: "OUTBOUND", readByClientAt: null } })
      : 0,
    perms.canViewBookkeeping ? prisma.bookkeepingPeriod.findMany({ where: { clientId, status: "READY_FOR_REVIEW" }, orderBy: [{ year: "desc" }, { month: "desc" }] }) : [],
    prisma.document.findMany({
      where: {
        clientId,
        deletedAt: null,
        visibility: "PUBLISHED",
        scanStatus: "CLEAN",
        category: { in: categories },
        uploadedByStaffId: { not: null },
        // Unopened by this viewer
        ...(viewerPortalUserId ? { accessLogs: { none: { portalUserId: viewerPortalUserId, action: { in: ["VIEW", "DOWNLOAD"] } } } } : {}),
      },
      orderBy: { publishedAt: "desc" },
      take: 10,
    }),
    prisma.documentRequest.findMany({ where: { clientId, status: "OPEN" }, orderBy: [{ dueAt: { sort: "asc", nulls: "last" } }] }),
    prisma.clientDeadline.findMany({ where: { clientId, visibleToClient: true, dueAt: { gte: today } }, orderBy: { dueAt: "asc" }, take: 10 }),
    perms.canViewContracts ? prisma.contractAssignment.findMany({ where: { clientId, status: "ASSIGNED" }, orderBy: { createdAt: "asc" } }) : [],
    perms.canViewTax ? prisma.signatureRequest.findMany({ where: { clientId, status: { in: ["SENT", "VIEWED", "PARTIALLY_SIGNED"] } } }) : [],
  ]);
  return { updates, unread, readyPeriods, newDocs, requests, deadlines, contracts, signatures };
}

export async function loadPortalDocuments(clientId: string, perms: Perms) {
  return prisma.document.findMany({
    where: { clientId, deletedAt: null, visibility: "PUBLISHED", scanStatus: "CLEAN", category: { in: allowedCategories(perms as PortalAccess) } },
    include: { file: { select: { mimeType: true, sizeBytes: true } } },
    orderBy: [{ year: "desc" }, { month: "desc" }, { createdAt: "desc" }],
  });
}

export const OWNER_PREVIEW_PERMS: Perms = { canMessage: true, canUpload: true, canViewBookkeeping: true, canViewTax: true, canViewContracts: true };
