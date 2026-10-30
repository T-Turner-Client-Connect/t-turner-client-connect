import "server-only";
import { startOfDay } from "date-fns";
import type { PortalAccess } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { allowedCategories } from "./access";
import { announcementsForClient, countdownsFor } from "@/lib/services/news";
import { isPortalVerified, questionnaireUrl, questionnaireYears, taxYearStatuses, vaultYears } from "@/lib/services/tax-center";
import { isStateCode } from "@/lib/resources/catalog";
import { isHistorical } from "@/lib/services/documents";
import { portalBilling } from "@/lib/services/owner-billing";
import { identityAlerts, identityOverview } from "@/lib/services/identity";
import type { PortalActor } from "./session";

type Perms = Pick<PortalAccess, "canMessage" | "canUpload" | "canViewBookkeeping" | "canViewTax" | "canViewContracts" | "canViewBilling" | "canViewIdentity">;

/**
 * Everything on a client's portal dashboard. Only staff-entered records
 * (published documents, updates, requests, deadlines) are shown — no
 * computed or sample figures.
 */
export async function loadPortalHome(clientId: string, perms: Perms, viewerPortalUserId: string | null) {
  const today = startOfDay(new Date());
  const categories = allowedCategories(perms as PortalAccess);
  const [updates, unread, readyPeriods, newDocs, requests, deadlines, contracts, signatures] = await Promise.all([
    announcementsForClient(clientId),
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
  const client = await prisma.client.findUniqueOrThrow({ where: { id: clientId }, select: { clientType: true, state: true, entityType: true } });
  const thisYear = new Date().getFullYear();
  const viewer = viewerPortalUserId ? await prisma.portalUser.findUnique({ where: { id: viewerPortalUserId }, select: { preferredState: true } }) : null;
  const [countdowns, statuses, vault, questionnaires, verified, latestThread, billing] = await Promise.all([
    countdownsFor(clientId),
    perms.canViewTax ? taxYearStatuses(clientId, questionnaireYears()) : [],
    vaultYears(clientId, categories),
    perms.canViewTax
      ? Promise.all(questionnaireYears().map(async (year) => ({ year, url: await questionnaireUrl(clientId, client.clientType, year), completed: (await prisma.questionnaireSubmission.count({ where: { clientId, taxYear: year } })) > 0 })))
      : [],
    viewerPortalUserId ? isPortalVerified(viewerPortalUserId) : true,
    perms.canMessage
      ? prisma.conversation.findMany({
          where: { clientId },
          orderBy: { lastMessageAt: "desc" },
          take: 2,
          select: {
            id: true,
            subject: true,
            lastMessageAt: true,
            messages: { where: { channel: "PORTAL" }, orderBy: { createdAt: "desc" }, take: 1, select: { body: true, direction: true, readByClientAt: true } },
          },
        })
      : [],
    perms.canViewBilling && viewerPortalUserId ? portalBilling({ id: viewerPortalUserId } as PortalActor, clientId) : [],
  ]);
  // Service progress: years with any activity (or last year's return by default).
  const progress = statuses.filter((s) => s.started);
  const state = viewer?.preferredState ?? (client.state && isStateCode(client.state.toUpperCase()) ? client.state.toUpperCase() : "AL");
  return {
    updates,
    unread,
    readyPeriods,
    newDocs: verified ? newDocs : newDocs.filter((d) => !isHistorical(d)),
    requests,
    deadlines,
    contracts,
    signatures,
    countdowns,
    progress: progress.length ? progress : statuses.filter((s) => s.year === thisYear - 1),
    statuses,
    identityAlerts: perms.canViewIdentity ? identityAlerts(await identityOverview(clientId)) : [],
    vault,
    questionnaires,
    verified,
    threads: latestThread.map((t) => {
      const m = t.messages[0];
      return { id: t.id, subject: t.subject, at: t.lastMessageAt, snippet: m ? m.body.replace(/\s+/g, " ").slice(0, 70) : "", unread: !!m && m.direction === "OUTBOUND" && !m.readByClientAt };
    }),
    billing: {
      quotes: billing.filter((b) => b.state === "OFFERED").length,
      outstanding: billing.filter((b) => b.state !== "OFFERED" && b.state !== "DECLINED" && (b.balanceCents ?? 0) > 0),
    },
    perms,
    state,
    personalized: true,
  };
}

export async function loadPortalDocuments(clientId: string, perms: Perms, opts: { year?: number | "none" | null; includeHistorical?: boolean } = {}) {
  const lastYear = new Date().getFullYear() - 1;
  return prisma.document.findMany({
    where: {
      clientId,
      deletedAt: null,
      visibility: "PUBLISHED",
      scanStatus: "CLEAN",
      category: { in: allowedCategories(perms as PortalAccess) },
      ...(opts.year === "none" ? { year: null } : opts.year ? { year: opts.year } : {}),
      // Unverified logins don't see our past-year records (see isHistorical).
      ...(opts.includeHistorical === false ? { NOT: { uploadedByStaffId: { not: null }, year: { lt: lastYear } } } : {}),
    },
    include: { file: { select: { mimeType: true, sizeBytes: true } } },
    orderBy: [{ year: "desc" }, { month: "desc" }, { createdAt: "desc" }],
  });
}

export const OWNER_PREVIEW_PERMS: Perms = { canMessage: true, canUpload: true, canViewBookkeeping: true, canViewTax: true, canViewContracts: true, canViewBilling: true, canViewIdentity: true };
