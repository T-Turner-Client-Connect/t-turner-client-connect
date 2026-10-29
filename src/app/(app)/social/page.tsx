import Link from "next/link";
import type { SocialPostStatus } from "@prisma/client";
import { ActionForm } from "@/components/action-form";
import { Badge, Button, buttonClass, EmptyState, LinkButton, Notice, PageHeader } from "@/components/ui";
import { SocialViewTabs } from "@/components/social/view-tabs";
import { ReadyPanel } from "@/components/social/ready-panel";
import { suggestMonthAction } from "@/app/actions/social";
import { requireUser } from "@/lib/auth/session";
import { prisma } from "@/lib/prisma";
import { readyToPublish } from "@/lib/services/social";
import { PLATFORM_LABELS, POST_STATUS, TARGET_STATUS_LABELS } from "@/lib/social/rules";
import { fmtChicago } from "@/lib/tz";

export const metadata = { title: "Social media" };

const TARGET_TONE = { DRAFT: "gray", SCHEDULED: "navy", PUBLISHED: "green", FAILED: "red", REQUIRES_MANUAL_POSTING: "amber", POSTED_MANUALLY: "green", CANCELLED: "gray" } as const;

export default async function SocialPage({ searchParams }: { searchParams: Promise<{ status?: string }> }) {
  await requireUser();
  const { status } = await searchParams;
  const filter = status && status in POST_STATUS ? (status as SocialPostStatus) : undefined;
  const [posts, ready, approvedTopics] = await Promise.all([
    prisma.socialPost.findMany({ where: filter ? { status: filter } : {}, include: { targets: true }, orderBy: [{ scheduledAt: { sort: "asc", nulls: "last" } }, { createdAt: "desc" }], take: 200 }),
    readyToPublish(),
    prisma.contentTopic.count({ where: { approvedAt: { not: null }, archivedAt: null } }),
  ]);
  const thisMonth = new Date().toLocaleDateString("en-CA", { timeZone: "America/Chicago" }).slice(0, 7);
  return (
    <>
      <PageHeader
        title="Social media"
        subtitle="Plan, approve and prepare posts for Facebook, Instagram and TikTok. Times are Central (America/Chicago)."
        actions={
          <>
            <LinkButton href="/media" variant="secondary">Media library</LinkButton>
            <LinkButton href="/social/new" variant="gold">Create post</LinkButton>
          </>
        }
      />
      <SocialViewTabs active="list" />
      <ReadyPanel items={ready} />
      <section className="mb-4 rounded-xl border border-navy-100 bg-white p-4" aria-labelledby="suggest-heading">
        <h2 id="suggest-heading" className="font-semibold text-navy-900">Suggest a month of posts</h2>
        {approvedTopics === 0 ? (
          <p className="mt-2 text-sm text-slate-700">Suggestions use only approved content topics. <Link className="underline" href="/social/topics">Add and approve topics</Link> first.</p>
        ) : (
          <ActionForm action={suggestMonthAction} className="mt-3 flex flex-wrap items-end gap-3">
            <label className="text-sm font-semibold text-navy-900">Month<input className="input mt-1" type="month" name="month" defaultValue={thisMonth} required /></label>
            <fieldset className="flex gap-3 text-sm">
              <legend className="sr-only">Platforms</legend>
              {(["FACEBOOK", "INSTAGRAM", "TIKTOK"] as const).map((p) => <label key={p} className="flex items-center gap-1"><input type="checkbox" name="platform" value={p} defaultChecked={p !== "TIKTOK"} /> {PLATFORM_LABELS[p]}</label>)}
            </fieldset>
            <Button type="submit">Suggest drafts</Button>
            <p className="w-full text-xs text-slate-600">Creates drafts at recommended times (not guaranteed best times — no account analytics are connected). Nothing is approved or posted automatically.</p>
          </ActionForm>
        )}
      </section>
      <div className="mb-4">
        <Notice tone="info" title="Publishing mode: manual">
          No accounts are connected for direct publishing. Scheduling prepares the post and reminds you here when it&apos;s time — download the media, copy the caption &amp; hashtags,
          open the platform, post it, then mark that platform posted. A post is never shown as published just because its time passed.
        </Notice>
      </div>
      <div className="mb-4 flex flex-wrap gap-2">
        <Link href="/social" className={buttonClass(!filter ? "primary" : "secondary")}>All</Link>
        {(Object.keys(POST_STATUS) as SocialPostStatus[]).filter((s) => s !== "APPROVED").map((s) => (
          <Link key={s} href={`/social?status=${s}`} className={buttonClass(filter === s ? "primary" : "secondary")}>{POST_STATUS[s].label}</Link>
        ))}
      </div>
      {posts.length === 0 ? (
        <EmptyState title="No posts yet">Create a post, or suggest a month of drafts from your approved topics.</EmptyState>
      ) : (
        <ul className="divide-y divide-navy-100 rounded-xl border border-navy-100 bg-white">
          {posts.map((p) => (
            <li key={p.id}>
              <Link href={`/social/${p.id}`} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 hover:bg-navy-50">
                <div>
                  <p className="font-semibold text-navy-900">{p.title}</p>
                  <p className="text-sm text-slate-600">{p.scheduledAt ? `${fmtChicago(p.scheduledAt)} CT${p.timeSuggested ? " · recommended time" : ""}` : "No date yet"}</p>
                </div>
                <div className="flex flex-wrap gap-1">
                  <Badge tone={POST_STATUS[p.status].tone}>{POST_STATUS[p.status].label}</Badge>
                  {p.targets.map((t) => <Badge key={t.id} tone={TARGET_TONE[t.status]}>{PLATFORM_LABELS[t.platform]}: {TARGET_STATUS_LABELS[t.status]}</Badge>)}
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
