import Link from "next/link";
import type { MessageChannel, Prisma } from "@prisma/client";
import { Badge, buttonClass, EmptyState, LinkButton, PageHeader } from "@/components/ui";
import { requireUser } from "@/lib/auth/session";
import { prisma } from "@/lib/prisma";
import { fromNow } from "@/lib/format";

export const metadata = { title: "Conversations" };

const FILTERS = [
  ["all", "All open"],
  ["unread", "Unread"],
  ["awaiting", "Needs reply"],
  ["mine", "Assigned to me"],
  ["unassigned", "Unassigned"],
  ["closed", "Closed"],
] as const;
const CHANNEL = { PORTAL: { label: "Portal", tone: "navy" }, EMAIL: { label: "Email", tone: "gold" }, SMS: { label: "Text", tone: "green" }, INTERNAL_NOTE: { label: "Internal note", tone: "amber" } } as const;

export default async function Conversations({ searchParams }: { searchParams: Promise<{ filter?: string; channel?: string }> }) {
  const user = await requireUser();
  const sp = await searchParams;
  const filter = FILTERS.find(([k]) => k === sp.filter)?.[0] ?? "all";
  const where: Prisma.ConversationWhereInput = filter === "closed" ? { closedAt: { not: null } } : { closedAt: null };
  if (filter === "unread") where.unreadByStaff = true;
  if (filter === "awaiting") where.awaitingStaff = true;
  if (filter === "mine") where.assignedToId = user.id;
  if (filter === "unassigned") where.assignedToId = null;
  const channel = sp.channel && sp.channel in CHANNEL ? (sp.channel as MessageChannel) : undefined;
  if (channel) where.messages = { some: { channel } };
  const conversations = await prisma.conversation.findMany({
    where,
    include: {
      client: { select: { id: true, displayName: true } },
      assignedTo: { select: { name: true } },
      messages: { orderBy: { createdAt: "desc" }, take: 1, select: { body: true, channel: true, direction: true } },
    },
    orderBy: { lastMessageAt: "desc" },
    take: 200,
  });
  const qs = (patch: Record<string, string | undefined>) => {
    const p = new URLSearchParams(Object.entries({ filter, channel, ...patch }).filter(([, v]) => v && v !== "all") as [string, string][]);
    const s = p.toString();
    return `/conversations${s ? `?${s}` : ""}`;
  };
  return (
    <>
      <PageHeader title="Conversations" subtitle="Shared inbox for portal, email and text, with staff-only notes." actions={<LinkButton href="/conversations/new">New message</LinkButton>} />
      <div className="mb-3 flex flex-wrap gap-2">
        {FILTERS.map(([k, label]) => <Link key={k} href={qs({ filter: k })} className={buttonClass(filter === k ? "primary" : "secondary")}>{label}</Link>)}
      </div>
      <div className="mb-4 flex flex-wrap items-center gap-2 text-sm">
        <span className="text-slate-600">Channel:</span>
        <Link href={qs({ channel: undefined })} className={buttonClass(!channel ? "primary" : "ghost")}>Any</Link>
        {(Object.keys(CHANNEL) as MessageChannel[]).map((c) => <Link key={c} href={qs({ channel: c })} className={buttonClass(channel === c ? "primary" : "ghost")}>{CHANNEL[c].label}</Link>)}
      </div>
      {conversations.length === 0 ? (
        <EmptyState title="No conversations here">Start one with New message, or wait for clients to write in through the portal.</EmptyState>
      ) : (
        <ul className="divide-y divide-ivory-200 overflow-hidden rounded-2xl border border-ivory-200 bg-white">
          {conversations.map((c) => {
            const last = c.messages[0];
            return (
              <li key={c.id}>
                <Link href={`/clients/${c.client.id}?tab=messages&c=${c.id}`} className="grid gap-1 px-4 py-3 hover:bg-ivory-50 md:grid-cols-[1.4fr_2fr_auto] md:items-center md:gap-4">
                  <div className="flex items-center gap-2">
                    {c.unreadByStaff && <span className="size-2.5 shrink-0 rounded-full bg-gold-500" aria-label="Unread" />}
                    <div className="min-w-0">
                      <p className={`truncate ${c.unreadByStaff ? "font-bold" : "font-semibold"} text-navy-900`}>{c.client.displayName}</p>
                      <p className="truncate text-sm text-slate-600">{c.subject}</p>
                    </div>
                  </div>
                  <p className="truncate text-sm text-slate-700">
                    {last && <Badge tone={CHANNEL[last.channel].tone} className="mr-2">{CHANNEL[last.channel].label}</Badge>}
                    {last?.direction === "INBOUND" ? "" : "You: "}{last?.body}
                  </p>
                  <div className="flex items-center gap-2 text-xs text-slate-500">
                    {c.awaitingStaff && <Badge tone="gold">Needs reply</Badge>}
                    <span>{c.assignedTo?.name ?? "Unassigned"}</span>
                    <span>{fromNow(c.lastMessageAt)}</span>
                  </div>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
}
