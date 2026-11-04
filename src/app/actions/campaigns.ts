"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import type { CampaignChannel, CampaignPurpose } from "@prisma/client";
import { requireUser } from "@/lib/auth/session";
import { run, str, type ActionState } from "@/lib/action";
import { campaignFromAnnouncement, createCampaign, deleteDraft, setAudience, setCampaignFlyer, setExclusions, updateCampaignDraft } from "@/lib/services/campaigns";
import { cancelScheduled, scheduleCampaign } from "@/lib/services/campaign-dispatch";
import { ValidationError } from "@/lib/services/clients";
import { normalizeEmail } from "@/lib/normalize";
import { sendTransactionalEmail } from "@/lib/email";
import { prisma } from "@/lib/prisma";
import { chicagoLocalToUtc } from "@/lib/tz";

export async function createCampaignAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  let id = "";
  const result = await run(async () => {
    id = (await createCampaign(actor, { title: str(fd, "title"), purpose: str(fd, "purpose") as CampaignPurpose, channel: str(fd, "channel") as CampaignChannel })).id;
  });
  if (result?.ok) redirect(`/campaigns/${id}?step=message`);
  return result;
}

export async function updateCampaignAction(campaignId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    await updateCampaignDraft(actor, campaignId, {
      title: str(fd, "title"),
      purpose: str(fd, "purpose") as CampaignPurpose,
      channel: str(fd, "channel") as CampaignChannel,
      emailSubject: str(fd, "emailSubject"),
      body: str(fd, "body"),
      smsBody: str(fd, "smsBody"),
      flyerId: (await prisma.campaign.findUniqueOrThrow({ where: { id: campaignId } })).flyerId,
    });
    revalidatePath(`/campaigns/${campaignId}`);
    return "Draft saved.";
  });
}

export async function setAudienceAction(campaignId: string, groupIds: string[], clientIds: string[]): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    await setAudience(actor, campaignId, { groupIds, clientIds });
    revalidatePath(`/campaigns/${campaignId}`);
    return "Audience saved.";
  });
}

export async function setExclusionsAction(campaignId: string, clientIds: string[], excluded: boolean, reason?: string): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    await setExclusions(actor, campaignId, clientIds, excluded, reason);
    revalidatePath(`/campaigns/${campaignId}`);
    return excluded ? "Removed from this campaign." : "Added back.";
  });
}

export async function deleteDraftAction(campaignId: string, _prev: ActionState): Promise<ActionState> {
  const actor = await requireUser();
  const result = await run(async () => {
    await deleteDraft(actor, campaignId);
  });
  if (result?.ok) redirect("/campaigns");
  return result;
}

export async function setFlyerAction(campaignId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    await setCampaignFlyer(actor, campaignId, str(fd, "flyerId") || null);
    revalidatePath(`/campaigns/${campaignId}`);
    return str(fd, "flyerId") ? "Flyer added." : "Flyer removed.";
  });
}

/**
 * Test sends go only to a staff address and are separate from live sending.
 * Without a configured provider the test is simulated and labeled as such.
 */
export async function testSendAction(campaignId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    const to = normalizeEmail(str(fd, "testEmail"));
    if (!to) throw new ValidationError("Enter your own email address for the test.");
    const staff = await prisma.user.findFirst({ where: { email: to, active: true } });
    if (!staff) throw new ValidationError("Test emails can only go to a staff account's email address.");
    const c = await prisma.campaign.findUniqueOrThrow({ where: { id: campaignId } });
    const sent = await sendTransactionalEmail(to, `[TEST] ${c.emailSubject ?? c.title}`, `${c.body}\n\n— Test send from TTurner Client Connect. Not sent to any client.`);
    await prisma.auditLog.create({ data: { actorId: actor.id, action: sent ? "campaign.test_sent" : "campaign.test_simulated", entityType: "Campaign", entityId: campaignId } });
    return sent ? `Test email accepted by the provider for ${to}. Check your inbox.` : "SIMULATED test — no email provider is configured, so nothing was sent. The preview above is exactly what would go out.";
  });
}

export async function sendOrScheduleAction(campaignId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    if (fd.get("confirm") !== "on") throw new ValidationError("Tick the confirmation box to send.");
    const v = str(fd, "scheduledAt");
    const when = v ? chicagoLocalToUtc(v) : null;
    if (v && !when) throw new ValidationError("Choose a valid date and time.");
    const r = await scheduleCampaign(actor, campaignId, when);
    revalidatePath(`/campaigns/${campaignId}`);
    return r ? `Sent: ${r.sent} accepted by the providers, ${r.skipped} skipped (preferences, opt-outs, STOP), ${r.failed} failed.` : "Scheduled. Preferences and opt-outs are checked again right before each message sends.";
  });
}

export async function cancelScheduledAction(campaignId: string, _prev: ActionState): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    await cancelScheduled(actor, campaignId);
    revalidatePath(`/campaigns/${campaignId}`);
    return "Cancelled. Nothing was sent.";
  });
}

/** News & Updates: start a General business update campaign from an announcement. */
export async function campaignFromAnnouncementAction(announcementId: string, _prev: ActionState): Promise<ActionState> {
  const actor = await requireUser();
  let id = "";
  const result = await run(async () => {
    id = (await campaignFromAnnouncement(actor, announcementId)).id;
  });
  if (result?.ok) redirect(`/campaigns/${id}?step=audience`);
  return result;
}
