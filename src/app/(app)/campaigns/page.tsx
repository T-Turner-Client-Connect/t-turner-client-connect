import Link from "next/link";
import type { Prisma } from "@prisma/client";
import { Badge, buttonClass, EmptyState, LinkButton, PageHeader } from "@/components/ui";
import { requireUser } from "@/lib/auth/session";
import { prisma } from "@/lib/prisma";
import { PURPOSE_LABELS } from "@/lib/consent";
import { CHANNEL_LABELS, fmtDateTime } from "@/lib/format";

export const metadata = { title: "Campaigns" };

const STATUS_TONE = { DRAFT: "gray", SCHEDULED: "gold", SENDING: "navy", SENT: "green", CANCELLED: "red" } as const;

export default async function CampaignsPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  await requireUser();
  const sp = await searchParams;
  const where: Prisma.CampaignWhereInput = {};
  if (sp.channel && ["EMAIL", "SMS", "BOTH"].includes(sp.channel)) where.channel = sp.channel as "EMAIL" | "SMS" | "BOTH";
  if (sp.staff) where.createdById = sp.staff;
  const from = sp.from ? new Date(sp.from) : null;
  const to = sp.to ? new Date(`${sp.to}T23:59:59`) : null;
  if ((from && !isNaN(from.getTime())) || (to && !isNaN(to.getTime()))) {
    where.createdAt = { ...(from && !isNaN(from.getTime()) ? { gte: from } : {}), ...(to && !isNaN(to.getTime()) ? { lte: to } : {}) };
  }
  const [campaigns, staff] = await Promise.all([
    prisma.campaign.findMany({ where, orderBy: { updatedAt: "desc" }, include: { createdBy: { select: { name: true } } }, take: 200 }),
    prisma.user.findMany({ select: { id: true, name: true }, orderBy: { name: "asc" } }),
  ]);
  return (
    <>
      <PageHeader title="Campaigns" actions={<LinkButton href="/campaigns/new" variant="gold">New campaign</LinkButton>} />
      <form className="mb-4 grid gap-2 rounded-xl border border-navy-100 bg-white p-3 sm:grid-cols-2 lg:grid-cols-5">
        <label className="text-sm">From<input className="input" type="date" name="from" defaultValue={sp.from} /></label>
        <label className="text-sm">To<input className="input" type="date" name="to" defaultValue={sp.to} /></label>
        <label className="text-sm">Channel
          <select className="input" name="channel" defaultValue={sp.channel ?? ""}>
            <option value="">Any</option><option value="EMAIL">Email</option><option value="SMS">Text</option><option value="BOTH">Both</option>
          </select>
        </label>
        <label className="text-sm">Staff member
          <select className="input" name="staff" defaultValue={sp.staff ?? ""}>
            <option value="">Anyone</option>
            {staff.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </label>
        <div className="flex items-end gap-2">
          <button className={buttonClass("primary")}>Filter</button>
          <Link className={buttonClass("ghost")} href="/campaigns">Clear</Link>
        </div>
      </form>
      {campaigns.length === 0 ? (
        <EmptyState title="No campaigns found">Create a draft to pick an audience and preview your message.</EmptyState>
      ) : (
        <ul className="divide-y divide-navy-100 rounded-xl border border-navy-100 bg-white">
          {campaigns.map((c) => (
            <li key={c.id}>
              <Link href={`/campaigns/${c.id}`} className="flex flex-wrap items-center justify-between gap-2 px-4 py-3 hover:bg-navy-50">
                <div>
                  <p className="font-semibold text-navy-900">{c.title}</p>
                  <p className="text-sm text-slate-600">{PURPOSE_LABELS[c.purpose]} · {c.createdBy.name} · updated {fmtDateTime(c.updatedAt)}</p>
                </div>
                <div className="flex gap-1">
                  <Badge tone="navy">{CHANNEL_LABELS[c.channel]}</Badge>
                  <Badge tone={STATUS_TONE[c.status]}>{c.status.charAt(0) + c.status.slice(1).toLowerCase()}</Badge>
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
      <p className="mt-3 text-xs text-slate-600">Delivery results (accepted, delivered, failed, bounced) will appear here once sending is set up. Nothing here is estimated or invented.</p>
    </>
  );
}
