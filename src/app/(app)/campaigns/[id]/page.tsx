import Link from "next/link";
import { notFound } from "next/navigation";
import clsx from "clsx";
import { ActionForm } from "@/components/action-form";
import { AudiencePicker } from "@/components/audience-picker";
import { RecipientReview } from "@/components/recipient-review";
import { Badge, Button, Card, Field, Notice, PageHeader } from "@/components/ui";
import { deleteDraftAction, updateCampaignAction } from "@/app/actions/campaigns";
import { requireUser } from "@/lib/auth/session";
import { prisma } from "@/lib/prisma";
import { campaignRecipients } from "@/lib/services/campaigns";
import { PURPOSE_LABELS } from "@/lib/consent";
import { renderEmailHtml, renderSms } from "@/lib/campaigns/render";
import { integrationStatus } from "@/lib/integrations";
import { CHANNEL_LABELS } from "@/lib/format";

export const metadata = { title: "Campaign" };

const STEPS = [
  { key: "message", label: "1. Message" },
  { key: "audience", label: "2. Audience" },
  { key: "review", label: "3. Review recipients" },
  { key: "preview", label: "4. Preview" },
] as const;

export default async function CampaignPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ step?: string }> }) {
  await requireUser();
  const { id } = await params;
  const stepParam = (await searchParams).step;
  const step = STEPS.find((s) => s.key === stepParam)?.key ?? "message";
  const campaign = await prisma.campaign.findUnique({
    where: { id },
    include: { flyer: true, groups: true, inclusions: true, exclusions: true, createdBy: { select: { name: true } } },
  });
  if (!campaign) notFound();
  const editable = campaign.status === "DRAFT";
  const usesEmail = campaign.channel !== "SMS";
  const usesSms = campaign.channel !== "EMAIL";

  return (
    <>
      <PageHeader
        title={campaign.title}
        subtitle={
          <span className="flex flex-wrap items-center gap-2">
            <Badge tone="gray">{campaign.status === "DRAFT" ? "Draft" : campaign.status}</Badge>
            <Badge tone="navy">{CHANNEL_LABELS[campaign.channel]}</Badge>
            <span>{PURPOSE_LABELS[campaign.purpose]}</span>
          </span>
        }
        actions={
          editable ? (
            <ActionForm action={deleteDraftAction.bind(null, id)} confirm="Delete this draft?" showSuccess={false}>
              <Button variant="danger">Delete draft</Button>
            </ActionForm>
          ) : undefined
        }
      />
      <nav aria-label="Campaign steps" className="mb-5 flex gap-1 overflow-x-auto rounded-xl border border-navy-100 bg-white p-1">
        {STEPS.map((s) => (
          <Link
            key={s.key}
            href={`/campaigns/${id}?step=${s.key}`}
            aria-current={step === s.key ? "step" : undefined}
            className={clsx("whitespace-nowrap rounded-lg px-4 py-2 text-sm font-semibold", step === s.key ? "bg-navy-900 text-white" : "text-navy-900 hover:bg-navy-50")}
          >
            {s.label}
          </Link>
        ))}
      </nav>

      {step === "message" && <MessageStep campaign={campaign} editable={editable} usesEmail={usesEmail} usesSms={usesSms} />}
      {step === "audience" && <AudienceStep campaignId={id} editable={editable} groupIds={campaign.groups.map((g) => g.groupId)} clientIds={campaign.inclusions.map((i) => i.clientId)} excludedIds={campaign.exclusions.map((e) => e.clientId)} />}
      {step === "review" && <ReviewStep campaignId={id} editable={editable} />}
      {step === "preview" && <PreviewStep campaign={campaign} usesEmail={usesEmail} usesSms={usesSms} />}
    </>
  );
}

type CampaignWithFlyer = NonNullable<Awaited<ReturnType<typeof prisma.campaign.findUnique>>> & { flyer: { id: string; title: string; mimeType: string; sizeBytes: number } | null };

async function MessageStep({ campaign, editable, usesEmail, usesSms }: { campaign: CampaignWithFlyer; editable: boolean; usesEmail: boolean; usesSms: boolean }) {
  const flyers = await prisma.storedFile.findMany({ where: { kind: "FLYER", archivedAt: null }, orderBy: { createdAt: "desc" }, select: { id: true, title: true, mimeType: true } });
  return (
    <Card>
      <ActionForm action={updateCampaignAction.bind(null, campaign.id)} className="space-y-4">
        <fieldset disabled={!editable} className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-3">
            <Field label="Title" className="sm:col-span-3"><input className="input" name="title" defaultValue={campaign.title} required /></Field>
            <Field label="Purpose" className="sm:col-span-2">
              <select className="input" name="purpose" defaultValue={campaign.purpose}>
                {Object.entries(PURPOSE_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
              </select>
            </Field>
            <Field label="Send by">
              <select className="input" name="channel" defaultValue={campaign.channel}>
                <option value="EMAIL">Email</option><option value="SMS">Text message</option><option value="BOTH">Both</option>
              </select>
            </Field>
          </div>
          {usesEmail && (
            <Field label="Email subject"><input className="input" name="emailSubject" defaultValue={campaign.emailSubject ?? ""} maxLength={200} /></Field>
          )}
          <Field label={usesEmail ? "Message" : "Message (used for the text if no text version is given)"} hint="Blank line starts a new paragraph. **double asterisks** for bold. Links are clickable.">
            <textarea className="input" name="body" rows={9} defaultValue={campaign.body} />
          </Field>
          {usesSms && (
            <Field label="Text message version (optional)" hint="Keep it short. The firm name and “Reply STOP to opt out.” are added automatically.">
              <textarea className="input" name="smsBody" rows={3} maxLength={1600} defaultValue={campaign.smsBody ?? ""} />
            </Field>
          )}
          <Field label="Flyer" hint={<>From the <Link className="underline" href="/flyers">flyer library</Link>. Email shows images inline and links PDFs; texts send small images as MMS and link anything else.</>}>
            <select className="input" name="flyerId" defaultValue={campaign.flyerId ?? ""}>
              <option value="">No flyer</option>
              {flyers.map((f) => <option key={f.id} value={f.id}>{f.title} ({f.mimeType === "application/pdf" ? "PDF" : "image"})</option>)}
            </select>
          </Field>
        </fieldset>
        {editable && (
          <div className="flex flex-wrap gap-2">
            <Button type="submit">Save draft</Button>
            <Link href={`/campaigns/${campaign.id}?step=audience`} className="self-center text-sm underline">Next: choose audience →</Link>
          </div>
        )}
      </ActionForm>
    </Card>
  );
}

async function AudienceStep({ campaignId, editable, groupIds, clientIds, excludedIds }: { campaignId: string; editable: boolean; groupIds: string[]; clientIds: string[]; excludedIds: string[] }) {
  const [groups, clients] = await Promise.all([
    prisma.group.findMany({ orderBy: { name: "asc" }, include: { _count: { select: { clients: { where: { client: { archivedAt: null } } } } } } }),
    prisma.client.findMany({
      where: { archivedAt: null },
      orderBy: { displayName: "asc" },
      take: 5000,
      select: { id: true, displayName: true, businessName: true, clientType: true, status: true, tags: true, emailNormalized: true, phoneNormalized: true, groups: { select: { groupId: true } } },
    }),
  ]);
  return (
    <AudiencePicker
      campaignId={campaignId}
      editable={editable}
      groups={groups.map((g) => ({ id: g.id, name: g.name, count: g._count.clients }))}
      clients={clients.map((c) => ({
        id: c.id,
        name: c.displayName,
        business: c.businessName,
        type: c.clientType,
        status: c.status,
        tags: c.tags,
        groupIds: c.groups.map((g) => g.groupId),
        hasEmail: !!c.emailNormalized,
        hasPhone: !!c.phoneNormalized,
      }))}
      initialGroupIds={groupIds}
      initialClientIds={clientIds}
      excludedIds={excludedIds}
    />
  );
}

async function ReviewStep({ campaignId, editable }: { campaignId: string; editable: boolean }) {
  const { eligible, excluded, selectedClientCount } = await campaignRecipients(campaignId);
  return (
    <>
      <p className="mb-3 text-sm text-slate-700">
        {selectedClientCount} client{selectedClientCount === 1 ? "" : "s"} selected. Eligibility is checked on the server using recorded permissions and opt-outs, and is checked again right
        before anything is sent.
      </p>
      <RecipientReview campaignId={campaignId} eligible={eligible} excluded={excluded} editable={editable} />
    </>
  );
}

async function PreviewStep({ campaign, usesEmail, usesSms }: { campaign: CampaignWithFlyer; usesEmail: boolean; usesSms: boolean }) {
  const integrations = integrationStatus();
  const { eligible } = await campaignRecipients(campaign.id);
  const smsRecipients = eligible.filter((r) => r.channel === "SMS").length;
  const flyer = campaign.flyer;
  const html = renderEmailHtml({
    subject: campaign.emailSubject ?? "",
    body: campaign.body || "(Your message will appear here.)",
    purpose: campaign.purpose,
    flyer: flyer ? { url: `/api/files/${flyer.id}`, title: flyer.title, mimeType: flyer.mimeType } : null,
    unsubscribeUrl: "#unsubscribe-link-added-when-sent",
    mailingAddress: process.env.BUSINESS_MAILING_ADDRESS || "[Business mailing address — set BUSINESS_MAILING_ADDRESS]",
  });
  const sms = renderSms({ body: campaign.smsBody || campaign.body || "(Your message)", purpose: campaign.purpose, flyer });
  const price = Number(process.env.SMS_PRICE_PER_SEGMENT_USD);
  const mmsPrice = Number(process.env.MMS_PRICE_PER_MESSAGE_USD);
  const smsCost = sms.media === "mms"
    ? mmsPrice > 0 ? smsRecipients * mmsPrice : null
    : price > 0 ? smsRecipients * sms.segments.segments * price : null;
  return (
    <div className="space-y-4">
      <Notice tone="warn" title="Preview only — sending is not available yet">
        {integrations.email || integrations.twilio
          ? "Providers are partly configured, but test sends, scheduling and live sending arrive in the next stage after delivery is verified."
          : "No email or text provider is connected. Test sends, scheduling and live sending arrive in the next stage, once providers are set up and verified."}
      </Notice>
      <div className="grid gap-4 lg:grid-cols-5">
        {usesEmail && (
          <Card title="Email preview" className="lg:col-span-3">
            <p className="mb-2 text-sm"><span className="text-slate-600">Subject:</span> <strong>{campaign.emailSubject || <span className="text-red-700">No subject yet</span>}</strong></p>
            <iframe title="Email preview" srcDoc={html} sandbox="allow-same-origin" className="h-[560px] w-full rounded-lg border border-navy-100 bg-white" />
            <p className="mt-2 text-xs text-slate-600">The unsubscribe link is created per recipient when the email is sent.</p>
          </Card>
        )}
        {usesSms && (
          <Card title="Text message preview" className="lg:col-span-2">
            <div className="mx-auto max-w-xs rounded-3xl border-8 border-navy-900 bg-slate-50 p-3">
              {sms.media === "mms" && flyer && (
                // eslint-disable-next-line @next/next/no-img-element -- private, authenticated file route
                <img src={`/api/files/${flyer.id}`} alt={flyer.title} className="mb-2 rounded-xl" />
              )}
              <p className="whitespace-pre-wrap rounded-2xl rounded-bl-sm bg-white px-3 py-2 text-[15px] shadow-sm">{sms.text}</p>
            </div>
            <dl className="mt-3 space-y-1 text-sm">
              <div className="flex justify-between"><dt>Encoding</dt><dd>{sms.segments.encoding}{sms.segments.encoding === "UCS-2" && " (emoji or special characters)"}</dd></div>
              <div className="flex justify-between"><dt>Characters</dt><dd>{sms.segments.characters}</dd></div>
              <div className="flex justify-between"><dt>Segments per text</dt><dd>{sms.media === "mms" ? "1 MMS" : sms.segments.segments}</dd></div>
              <div className="flex justify-between"><dt>Eligible text recipients</dt><dd>{smsRecipients}</dd></div>
              <div className="flex justify-between font-semibold">
                <dt>Estimated cost</dt>
                <dd>{smsCost !== null ? `$${smsCost.toFixed(2)}` : "Set provider pricing to estimate"}</dd>
              </div>
            </dl>
            {sms.mediaNote && <p className="mt-2 text-xs text-slate-600">{sms.mediaNote}</p>}
            {smsCost === null && <p className="mt-1 text-xs text-slate-600">Add SMS_PRICE_PER_SEGMENT_USD and MMS_PRICE_PER_MESSAGE_USD from your Twilio pricing to see estimates. Carrier fees may apply on top.</p>}
          </Card>
        )}
      </div>
    </div>
  );
}
