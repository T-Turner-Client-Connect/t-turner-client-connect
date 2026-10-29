"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import type { CampaignChannel, CampaignPurpose } from "@prisma/client";
import { requireUser } from "@/lib/auth/session";
import { run, str, type ActionState } from "@/lib/action";
import { createCampaign, deleteDraft, setAudience, setExclusions, updateCampaignDraft } from "@/lib/services/campaigns";

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
      flyerId: str(fd, "flyerId") || null,
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
