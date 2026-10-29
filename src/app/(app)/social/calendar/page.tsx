import { endOfMonth, startOfMonth, addDays } from "date-fns";
import { LinkButton, PageHeader } from "@/components/ui";
import { MonthCalendar, monthFromParam, type CalendarEvent } from "@/components/month-calendar";
import { requireUser } from "@/lib/auth/session";
import { prisma } from "@/lib/prisma";
import { PLATFORM_LABELS } from "@/lib/social/rules";

export const metadata = { title: "Content calendar" };

export default async function ContentCalendar({ searchParams }: { searchParams: Promise<{ month?: string }> }) {
  await requireUser();
  const month = monthFromParam((await searchParams).month);
  const range = { gte: addDays(startOfMonth(month), -7), lte: addDays(endOfMonth(month), 7) };
  const [posts, campaigns] = await Promise.all([
    prisma.socialPost.findMany({ where: { scheduledAt: range, status: { not: "CANCELLED" } }, include: { targets: { select: { platform: true } } } }),
    prisma.campaign.findMany({ where: { scheduledAt: range } }),
  ]);
  const events: CalendarEvent[] = [
    ...posts.map((p) => ({
      id: p.id,
      at: p.scheduledAt!,
      title: `${p.title} (${p.targets.map((t) => PLATFORM_LABELS[t.platform]).join(", ") || "no platform"})`,
      href: `/social/${p.id}`,
      tone: (p.status === "COMPLETED" ? "green" : p.status === "DRAFT" || p.status === "PENDING_APPROVAL" ? "gray" : "navy") as CalendarEvent["tone"],
    })),
    ...campaigns.map((c) => ({ id: c.id, at: c.scheduledAt!, title: `✉ ${c.title}`, href: `/campaigns/${c.id}`, tone: "gold" as const })),
  ];
  return (
    <>
      <PageHeader title="Content calendar" subtitle="Social posts (navy, gray when not yet approved) and email/text campaigns (gold)." actions={<LinkButton href="/social/new" variant="gold">Create post</LinkButton>} />
      <MonthCalendar month={month} events={events} basePath="/social/calendar" />
    </>
  );
}
