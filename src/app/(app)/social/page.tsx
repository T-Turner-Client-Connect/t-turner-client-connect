import Link from "next/link";
import type { SocialPostStatus } from "@prisma/client";
import { Badge, buttonClass, EmptyState, LinkButton, Notice, PageHeader } from "@/components/ui";
import { requireUser } from "@/lib/auth/session";
import { prisma } from "@/lib/prisma";
import { PLATFORM_LABELS, TARGET_STATUS_LABELS } from "@/lib/social/rules";
import { fmtDateTime } from "@/lib/format";

export const metadata = { title: "Social media" };

const POST_STATUS: Record<SocialPostStatus, { label: string; tone: "gray" | "gold" | "navy" | "green" | "red" }> = {
  DRAFT: { label: "Draft", tone: "gray" },
  PENDING_APPROVAL: { label: "Awaiting approval", tone: "gold" },
  APPROVED: { label: "Approved", tone: "navy" },
  SCHEDULED: { label: "Scheduled", tone: "navy" },
  COMPLETED: { label: "Done", tone: "green" },
  CANCELLED: { label: "Cancelled", tone: "red" },
};
const TARGET_TONE = { DRAFT: "gray", SCHEDULED: "navy", PUBLISHED: "green", FAILED: "red", REQUIRES_MANUAL_POSTING: "amber", POSTED_MANUALLY: "green", CANCELLED: "gray" } as const;

export default async function SocialPage({ searchParams }: { searchParams: Promise<{ status?: string }> }) {
  await requireUser();
  const { status } = await searchParams;
  const filter = status && status in POST_STATUS ? (status as SocialPostStatus) : undefined;
  const [posts, manual] = await Promise.all([
    prisma.socialPost.findMany({ where: filter ? { status: filter } : {}, include: { targets: true }, orderBy: [{ scheduledAt: { sort: "asc", nulls: "last" } }, { createdAt: "desc" }], take: 200 }),
    prisma.socialPostTarget.count({ where: { status: "REQUIRES_MANUAL_POSTING" } }),
  ]);
  return (
    <>
      <PageHeader
        title="Social media"
        subtitle="Plan, approve and schedule posts for Facebook, Instagram and TikTok."
        actions={
          <>
            <LinkButton href="/social/calendar" variant="secondary">Content calendar</LinkButton>
            <LinkButton href="/media" variant="secondary">Media library</LinkButton>
            <LinkButton href="/social/new" variant="gold">Create post</LinkButton>
          </>
        }
      />
      <div className="mb-4">
        <Notice tone="info" title="Publishing mode: manual">
          No social accounts are connected for direct publishing yet. When a scheduled post is due it&apos;s marked <strong>Requires manual posting</strong> — download the media, copy the
          caption, post it on the platform, then confirm with the post link. Posts are never shown as published just because the platform was opened.
        </Notice>
      </div>
      {manual > 0 && <div className="mb-4"><Notice tone="warn">{manual} platform post(s) are due and need to be posted manually.</Notice></div>}
      <div className="mb-4 flex flex-wrap gap-2">
        <Link href="/social" className={buttonClass(!filter ? "primary" : "secondary")}>All</Link>
        {(Object.keys(POST_STATUS) as SocialPostStatus[]).map((s) => (
          <Link key={s} href={`/social?status=${s}`} className={buttonClass(filter === s ? "primary" : "secondary")}>{POST_STATUS[s].label}</Link>
        ))}
      </div>
      {posts.length === 0 ? (
        <EmptyState title="No posts yet">Create a post to start a draft.</EmptyState>
      ) : (
        <ul className="divide-y divide-navy-100 rounded-xl border border-navy-100 bg-white">
          {posts.map((p) => (
            <li key={p.id}>
              <Link href={`/social/${p.id}`} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 hover:bg-navy-50">
                <div>
                  <p className="font-semibold text-navy-900">{p.title}</p>
                  <p className="text-sm text-slate-600">{p.scheduledAt ? fmtDateTime(p.scheduledAt) : "No date yet"}</p>
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
