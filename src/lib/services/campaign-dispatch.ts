import "server-only";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { audit } from "@/lib/audit";
import type { Actor } from "@/lib/auth/actor";
import { sendEmail } from "@/lib/email";
import { sendSms } from "@/lib/twilio";
import { appUrl } from "@/lib/integrations";
import { renderEmailHtml, renderSms } from "@/lib/campaigns/render";
import { unsubscribeToken } from "@/lib/unsubscribe-token";
import { campaignRecipients, liveSendBlockers } from "./campaigns";
import { canSend, categoryForPurpose } from "./comm-prefs";
import { clientSmsAllowedNow } from "./notifications";
import { ValidationError } from "./clients";

/**
 * Campaign delivery (flyers, newsletters, promotions, general updates).
 * Recipients are resolved again at send time, and every single message is
 * re-checked with canSend() immediately before it goes out, so a preference
 * saved a second ago is honored. Nonessential email carries a signed
 * unsubscribe link and RFC 8058 one-click List-Unsubscribe headers; every
 * text carries "Reply STOP to opt out".
 */

export type DeliveryResult = { sent: number; skipped: number; failed: number };

export function unsubscribeLinks(person: { clientId: string; contactId: string | null; email: string }, kind: "PROMO" | "GENERAL") {
  const token = unsubscribeToken({ ...person, kind });
  return {
    page: `${appUrl()}/unsubscribe/${token}`,
    headers: { "List-Unsubscribe": `<${appUrl()}/api/unsubscribe/${token}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" },
  };
}

async function deliver(campaignId: string, now: Date): Promise<DeliveryResult> {
  const { campaign, eligible } = await campaignRecipients(campaignId, now);
  const category = categoryForPurpose(campaign.purpose);
  const result: DeliveryResult = { sent: 0, skipped: 0, failed: 0 };
  for (const r of eligible) {
    let row;
    try {
      row = await prisma.campaignMessage.create({ data: { campaignId, channel: r.channel, address: r.address, clientId: r.clientId, contactId: r.contactId, status: "SENDING" } });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") continue; // already handled by an earlier run
      throw err;
    }
    const gate = await canSend({ channel: r.channel, address: r.address, category, person: { clientId: r.clientId, contactId: r.contactId } });
    const quiet = r.channel === "SMS" && !clientSmsAllowedNow(now);
    if (!gate.ok || quiet) {
      await prisma.campaignMessage.update({ where: { id: row.id }, data: { status: "SKIPPED", skipReason: gate.ok ? "Quiet hours (texts only 8 a.m.–8 p.m. Central)" : gate.reason } });
      result.skipped++;
      continue;
    }
    let ok: boolean;
    let detail: string;
    let providerId: string | null = null;
    if (r.channel === "EMAIL") {
      const links = category === "ESSENTIAL" ? null : unsubscribeLinks({ clientId: r.clientId, contactId: r.contactId, email: r.address }, category === "GENERAL_UPDATE" ? "GENERAL" : "PROMO");
      const manage = `${appUrl()}/client/account#communication-preferences`;
      const subject = campaign.emailSubject || campaign.title;
      const html = renderEmailHtml({ subject, body: campaign.body, purpose: campaign.purpose, flyer: null, unsubscribeUrl: links?.page ?? manage, mailingAddress: process.env.BUSINESS_MAILING_ADDRESS || null });
      const footer = links ? `\n\n—\nUnsubscribe: ${links.page}\nManage your communication preferences: ${manage}` : `\n\n—\nManage your communication preferences: ${manage}`;
      const res = await sendEmail({ to: r.address, subject, text: `${campaign.body}${footer}`, html, headers: links?.headers, idempotencyKey: `campaign/${campaignId}/${r.address}`, tags: { category: "campaign" } });
      ok = res.ok;
      detail = res.ok ? "Accepted by email provider" : res.detail;
      providerId = res.ok ? res.providerId : null;
    } else {
      const res = await sendSms(r.address, renderSms({ body: campaign.smsBody || campaign.body, purpose: campaign.purpose }).text);
      ok = res.ok;
      detail = res.detail;
      providerId = res.sid ?? null;
      if (res.blocked) {
        await prisma.campaignMessage.update({ where: { id: row.id }, data: { status: "SKIPPED", skipReason: detail } });
        result.skipped++;
        continue;
      }
    }
    await prisma.campaignMessage.update({ where: { id: row.id }, data: ok ? { status: "PROVIDER_ACCEPTED", providerId } : { status: "FAILED", errorDetail: detail } });
    if (ok) result.sent++;
    else result.failed++;
  }
  await prisma.campaign.update({ where: { id: campaignId }, data: { status: "SENT", sentAt: now } });
  await audit(prisma, { actorId: null, action: "campaign.delivered", entityType: "Campaign", entityId: campaignId, details: result });
  return result;
}

/** Sends now (when is null or past) or schedules. Every live-send blocker is enforced here. */
export async function scheduleCampaign(actor: Actor, campaignId: string, when: Date | null, now = new Date()): Promise<DeliveryResult | null> {
  const blockers = await liveSendBlockers(actor, campaignId);
  if (blockers.length) throw new ValidationError(`Not sent. ${blockers[0]}`);
  if (when && when > now) {
    await prisma.campaign.update({ where: { id: campaignId }, data: { status: "SCHEDULED", scheduledAt: when } });
    await audit(prisma, { actorId: actor.id, action: "campaign.scheduled", entityType: "Campaign", entityId: campaignId, details: { at: when.toISOString() } });
    return null;
  }
  const claimed = await prisma.campaign.updateMany({ where: { id: campaignId, status: "DRAFT" }, data: { status: "SENDING" } });
  if (!claimed.count) throw new ValidationError("This campaign has already been scheduled or sent.");
  await audit(prisma, { actorId: actor.id, action: "campaign.send_started", entityType: "Campaign", entityId: campaignId });
  return deliver(campaignId, now);
}

export async function cancelScheduled(actor: Actor, campaignId: string) {
  const r = await prisma.campaign.updateMany({ where: { id: campaignId, status: "SCHEDULED" }, data: { status: "CANCELLED" } });
  if (!r.count) throw new ValidationError("Only a scheduled campaign can be cancelled.");
  await audit(prisma, { actorId: actor.id, action: "campaign.cancelled", entityType: "Campaign", entityId: campaignId });
}

/** Cron: sends scheduled campaigns that are due (permissions re-checked per message at that moment). */
export async function runDueCampaigns(now = new Date()) {
  if (process.env.CAMPAIGN_SENDING_ENABLED !== "true" || process.env.LIVE_SENDING_ENABLED !== "true") return 0;
  const due = await prisma.campaign.findMany({ where: { status: "SCHEDULED", scheduledAt: { lte: now } }, select: { id: true } });
  let n = 0;
  for (const c of due) {
    const claimed = await prisma.campaign.updateMany({ where: { id: c.id, status: "SCHEDULED" }, data: { status: "SENDING" } });
    if (!claimed.count) continue;
    await deliver(c.id, now);
    n++;
  }
  return n;
}
