import { endOfMonth, startOfMonth, addDays } from "date-fns";
import { LinkButton, PageHeader } from "@/components/ui";
import { MonthCalendar, monthFromParam, type CalendarEvent } from "@/components/month-calendar";
import { SocialViewTabs } from "@/components/social/view-tabs";
import { ReadyPanel } from "@/components/social/ready-panel";
import { requireUser } from "@/lib/auth/session";
import { prisma } from "@/lib/prisma";
import { readyToPublish } from "@/lib/services/social";
import { PLATFORM_LABELS, POST_STATUS } from "@/lib/social/rules";

export const metadata = { title: "Content calendar" };

export default async function ContentCalendar({ searchParams }: { searchParams: Promise<{ month?: string }> }) {
  await requireUser();
  const month = monthFromParam((await searchParams).month);
  const range = { gte: addDays(startOfMonth(month), -7), lte: addDays(endOfMonth(month), 7) };
  const [posts, campaigns, ready] = await Promise.all([
    prisma.socialPost.findMany({ where: { scheduledAt: range, status: { not: "CANCELLED" } }, include: { targets: { select: { platform: true } } } }),
    prisma.campaign.findMany({ where: { scheduledAt: range } }),
    readyToPublish(),
  ]);
  const events: CalendarEvent[] = [
    ...posts.map((p) => ({
      id: p.id,
      at: p.scheduledAt!,
      title: `${p.title} · ${POST_STATUS[p.status].label} (${p.targets.map((t) => PLATFORM_LABELS[t.platform]).join(", ") || "no platform"})`,
      href: `/social/${p.id}`,
      tone: (p.status === "COMPLETED" ? "green" : p.status === "DRAFT" || p.status === "PENDING_APPROVAL" ? "gray" : "navy") as CalendarEvent["tone"],
    })),
    ...campaigns.map((c) => ({ id: c.id, at: c.scheduledAt!, title: `✉ ${c.title}`, href: `/campaigns/${c.id}`, tone: "gold" as const })),
  ];
  return (
    <>
      <PageHeader title="Social media" subtitle="Gray = draft or awaiting approval · navy = approved & scheduled · green = posted manually · gold = email/text campaign." actions={<LinkButton href="/social/new" variant="gold">Create post</LinkButton>} />
      <SocialViewTabs active="calendar" />
      <ReadyPanel items={ready} />
      <MonthCalendar month={month} events={events} basePath="/social/calendar" />
    </>
  );
}
