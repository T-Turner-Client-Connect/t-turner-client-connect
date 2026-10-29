import "server-only";
import { z } from "zod";
import type { CampaignChannel, CampaignPurpose } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { audit } from "@/lib/audit";
import type { Actor } from "@/lib/auth/actor";
import { channelsFor, resolveRecipients, type AudienceClient } from "@/lib/campaigns/recipients";
import { activeSuppressionsFor, ValidationError } from "./clients";

const PURPOSES = ["SERVICE", "TAX_PREP_PROMO", "OTHER_SERVICES_PROMO"] as const;
const CHANNELS = ["EMAIL", "SMS", "BOTH"] as const;

const draftSchema = z.object({
  title: z.string().trim().min(1, "Give the campaign a title.").max(150),
  purpose: z.enum(PURPOSES),
  channel: z.enum(CHANNELS),
  emailSubject: z.string().trim().max(200).optional(),
  body: z.string().max(20000).optional(),
  smsBody: z.string().max(1600).optional(),
  flyerId: z.string().nullable().optional(),
});

async function editableCampaign(campaignId: string) {
  const campaign = await prisma.campaign.findUnique({ where: { id: campaignId } });
  if (!campaign) throw new ValidationError("Campaign not found.");
  if (campaign.status !== "DRAFT") throw new ValidationError("Only drafts can be changed.");
  return campaign;
}

export async function createCampaign(actor: Actor, input: { title: string; purpose: CampaignPurpose; channel: CampaignChannel }) {
  const parsed = draftSchema.safeParse(input);
  if (!parsed.success) throw new ValidationError(parsed.error.issues[0]?.message ?? "Check the form.");
  return prisma.$transaction(async (tx) => {
    const c = await tx.campaign.create({ data: { title: parsed.data.title, purpose: parsed.data.purpose, channel: parsed.data.channel, createdById: actor.id } });
    await audit(tx, { actorId: actor.id, action: "campaign.created", entityType: "Campaign", entityId: c.id });
    return c;
  });
}

export async function updateCampaignDraft(actor: Actor, campaignId: string, input: z.input<typeof draftSchema>) {
  await editableCampaign(campaignId);
  const parsed = draftSchema.safeParse(input);
  if (!parsed.success) throw new ValidationError(parsed.error.issues[0]?.message ?? "Check the form.");
  const v = parsed.data;
  if (v.flyerId && !(await prisma.storedFile.count({ where: { id: v.flyerId, kind: "FLYER", archivedAt: null } }))) {
    throw new ValidationError("Choose a flyer from the library.");
  }
  return prisma.$transaction(async (tx) => {
    const c = await tx.campaign.update({
      where: { id: campaignId },
      data: {
        title: v.title,
        purpose: v.purpose,
        channel: v.channel,
        emailSubject: v.emailSubject || null,
        body: v.body ?? "",
        smsBody: v.smsBody?.trim() || null,
        flyerId: v.flyerId || null,
      },
    });
    await audit(tx, { actorId: actor.id, action: "campaign.updated", entityType: "Campaign", entityId: campaignId });
    return c;
  });
}

/**
 * Replaces the selected groups and individually selected clients.
 * Manual exclusions are stored separately and are not affected.
 */
export async function setAudience(actor: Actor, campaignId: string, input: { groupIds: string[]; clientIds: string[] }) {
  await editableCampaign(campaignId);
  const groupIds = Array.from(new Set(input.groupIds)).slice(0, 200);
  const clientIds = Array.from(new Set(input.clientIds)).slice(0, 20000);
  await prisma.$transaction(async (tx) => {
    await tx.campaignGroup.deleteMany({ where: { campaignId } });
    await tx.campaignInclusion.deleteMany({ where: { campaignId } });
    const validGroups = await tx.group.findMany({ where: { id: { in: groupIds } }, select: { id: true } });
    const validClients = await tx.client.findMany({ where: { id: { in: clientIds } }, select: { id: true } });
    await tx.campaignGroup.createMany({ data: validGroups.map((g) => ({ campaignId, groupId: g.id })) });
    await tx.campaignInclusion.createMany({ data: validClients.map((c) => ({ campaignId, clientId: c.id })) });
    await audit(tx, {
      actorId: actor.id,
      action: "campaign.audience_updated",
      entityType: "Campaign",
      entityId: campaignId,
      details: { groups: validGroups.length, clients: validClients.length },
    });
  });
}

/** Removes (or restores) clients for this campaign only. */
export async function setExclusions(actor: Actor, campaignId: string, clientIds: string[], excluded: boolean, reason?: string) {
  const campaign = await editableCampaign(campaignId);
  const ids = Array.from(new Set(clientIds));
  await prisma.$transaction(async (tx) => {
    if (excluded) {
      await tx.campaignExclusion.createMany({
        data: ids.map((clientId) => ({ campaignId, clientId, reason: reason?.trim().slice(0, 200) || null })),
        skipDuplicates: true,
      });
    } else {
      await tx.campaignExclusion.deleteMany({ where: { campaignId, clientId: { in: ids } } });
    }
    await tx.auditLog.createMany({
      data: ids.map((clientId) => ({
        actorId: actor.id,
        action: excluded ? "campaign.excluded" : "campaign.included",
        entityType: "Campaign",
        entityId: campaignId,
        clientId,
        details: { campaignTitle: campaign.title },
      })),
    });
  });
}

export async function deleteDraft(actor: Actor, campaignId: string) {
  await editableCampaign(campaignId);
  await prisma.$transaction([
    prisma.campaign.delete({ where: { id: campaignId } }),
    prisma.auditLog.create({ data: { actorId: actor.id, action: "campaign.deleted", entityType: "Campaign", entityId: campaignId } }),
  ]);
}

/** Everyone selected through a group or individually, archived clients included. */
export async function selectedClientIds(campaignId: string): Promise<string[]> {
  const [groups, inclusions] = await Promise.all([
    prisma.campaignGroup.findMany({ where: { campaignId }, select: { groupId: true } }),
    prisma.campaignInclusion.findMany({ where: { campaignId }, select: { clientId: true } }),
  ]);
  const members = groups.length
    ? await prisma.clientGroup.findMany({ where: { groupId: { in: groups.map((g) => g.groupId) } }, select: { clientId: true } })
    : [];
  return Array.from(new Set([...members.map((m) => m.clientId), ...inclusions.map((i) => i.clientId)]));
}

/**
 * Server-side recipient resolution: consent, suppression, archive status,
 * manual exclusions and per-channel de-duplication are all applied here.
 * The same function is used for previews and (in stage 2) right before send.
 */
export async function campaignRecipients(campaignId: string, now = new Date()) {
  const campaign = await prisma.campaign.findUnique({ where: { id: campaignId }, include: { exclusions: true } });
  if (!campaign) throw new ValidationError("Campaign not found.");
  const ids = await selectedClientIds(campaignId);
  const clients: AudienceClient[] = await prisma.client.findMany({
    where: { id: { in: ids } },
    select: {
      id: true,
      displayName: true,
      email: true,
      emailNormalized: true,
      phoneNormalized: true,
      archivedAt: true,
      taxReturnDerived: true,
      consentRecords: {
        select: { contactId: true, kind: true, status: true, effectiveAt: true, createdAt: true, expiresAt: true, reviewedAt: true, evidenceFileId: true },
      },
      contacts: { select: { id: true, name: true, email: true, emailNormalized: true, phoneNormalized: true } },
    },
  });
  const pairs = clients.flatMap((c) =>
    channelsFor(campaign.channel).flatMap((channel) =>
      [c.emailNormalized, c.phoneNormalized, ...c.contacts.flatMap((x) => [x.emailNormalized, x.phoneNormalized])]
        .filter((a): a is string => !!a && (channel === "EMAIL" ? a.includes("@") : a.startsWith("+")))
        .map((address) => ({ channel, address })),
    ),
  );
  const suppressions = await activeSuppressionsFor(pairs);
  // Phone-level SMS consent (consent page, STOP replies, portal settings) is
  // merged in as consent history for whoever uses that number.
  const phones = Array.from(new Set(pairs.filter((p) => p.channel === "SMS").map((p) => p.address)));
  const ledger = phones.length
    ? await prisma.smsConsentEvent.findMany({ where: { phoneNormalized: { in: phones } }, orderBy: { createdAt: "asc" } })
    : [];
  for (const c of clients) {
    const people = [{ contactId: null as string | null, phone: c.phoneNormalized }, ...c.contacts.map((x) => ({ contactId: x.id as string | null, phone: x.phoneNormalized }))];
    for (const person of people) {
      for (const e of ledger.filter((l) => l.phoneNormalized === person.phone)) {
        c.consentRecords.push({
          contactId: person.contactId,
          kind: e.category === "SERVICE" ? "SMS_SERVICE" : "SMS_MARKETING",
          status: e.status,
          effectiveAt: e.createdAt,
          createdAt: e.createdAt,
          expiresAt: null,
          reviewedAt: null,
          evidenceFileId: null,
        });
      }
    }
  }
  const manualExclusions = new Map(campaign.exclusions.map((e) => [e.clientId, e.reason]));
  return { campaign, ...resolveRecipients({ channel: campaign.channel, purpose: campaign.purpose, clients, manualExclusions, suppressions, now }) };
}

export async function setCampaignFlyer(actor: Actor, campaignId: string, flyerId: string | null) {
  await editableCampaign(campaignId);
  if (flyerId && !(await prisma.storedFile.count({ where: { id: flyerId, kind: "FLYER", archivedAt: null } }))) throw new ValidationError("Choose from the media library.");
  await prisma.campaign.update({ where: { id: campaignId }, data: { flyerId } });
  await audit(prisma, { actorId: actor.id, action: "campaign.flyer_set", entityType: "Campaign", entityId: campaignId });
}

/**
 * Everything that must be true before a campaign can be sent or scheduled.
 * Enforced on the server; the UI only displays the result.
 */
export async function liveSendBlockers(actor: Actor, campaignId: string): Promise<string[]> {
  const { integrationStatus } = await import("@/lib/integrations");
  const i = integrationStatus();
  const c = await prisma.campaign.findUniqueOrThrow({ where: { id: campaignId } });
  const blockers: string[] = [];
  if (!i.liveSendingFlag) blockers.push("Live sending is turned off (LIVE_SENDING_ENABLED). It stays off until providers, permissions and a test delivery are verified.");
  if (c.channel !== "SMS" && !i.email) blockers.push("Email provider isn't configured.");
  if (c.channel !== "EMAIL" && !i.twilio) blockers.push("Twilio isn't configured.");
  if (c.channel !== "SMS" && !c.emailSubject) blockers.push("Add an email subject.");
  if (!c.body.trim() && !c.smsBody?.trim()) blockers.push("Write the message.");
  if (c.purpose !== "SERVICE" && !process.env.BUSINESS_MAILING_ADDRESS) blockers.push("Promotional email needs BUSINESS_MAILING_ADDRESS for the footer.");
  if (actor.role !== "ADMIN") blockers.push("An Admin must give the final send.");
  blockers.push("Campaign delivery (queue, delivery webhooks, unsubscribe handling) is enabled in the messaging stage.");
  return blockers;
}

export async function sendOrSchedule(actor: Actor, campaignId: string): Promise<never> {
  const blockers = await liveSendBlockers(actor, campaignId);
  throw new ValidationError(`Not sent. ${blockers[0]}`);
}
