import Link from "next/link";
import { addDays, startOfDay } from "date-fns";
import { Badge, Card, EmptyState, LinkButton, Notice, PageHeader, Stat } from "@/components/ui";
import { requireUser } from "@/lib/auth/session";
import { prisma } from "@/lib/prisma";
import { fmtDate, fmtDateTime } from "@/lib/format";
import { integrationStatus } from "@/lib/integrations";

export const metadata = { title: "Dashboard" };

export default async function Dashboard() {
  const user = await requireUser();
  const now = new Date();
  const today = startOfDay(now);
  const weekOut = addDays(today, 8);
  const [total, active, prospects, openTasks, overdue, upcoming, drafts, recentImports] = await Promise.all([
    prisma.client.count({ where: { archivedAt: null } }),
    prisma.client.count({ where: { archivedAt: null, status: "ACTIVE" } }),
    prisma.client.count({ where: { archivedAt: null, status: "PROSPECT" } }),
    prisma.task.count({ where: { status: "OPEN" } }),
    prisma.task.findMany({
      where: { status: "OPEN", dueAt: { lt: today } },
      include: { client: { select: { id: true, displayName: true } }, assignee: { select: { name: true } } },
      orderBy: { dueAt: "asc" },
      take: 10,
    }),
    prisma.task.findMany({
      where: { status: "OPEN", dueAt: { gte: today, lt: weekOut } },
      include: { client: { select: { id: true, displayName: true } }, assignee: { select: { name: true } } },
      orderBy: { dueAt: "asc" },
      take: 10,
    }),
    prisma.campaign.count({ where: { status: "DRAFT" } }),
    prisma.importBatch.findMany({ orderBy: { createdAt: "desc" }, take: 3, include: { importedBy: { select: { name: true } } } }),
  ]);
  const integrations = integrationStatus();

  const taskRow = (t: (typeof overdue)[number], late: boolean) => (
    <li key={t.id} className="flex flex-wrap items-center justify-between gap-2 py-2.5">
      <div>
        <p className="font-medium text-navy-900">{t.title}</p>
        <p className="text-sm text-slate-600">
          {t.client ? <Link className="underline" href={`/clients/${t.client.id}`}>{t.client.displayName}</Link> : "No client"} · {t.assignee?.name ?? "Unassigned"}
        </p>
      </div>
      <Badge tone={late ? "red" : t.priority === "HIGH" ? "gold" : "gray"}>{late ? "Overdue · " : ""}Due {fmtDate(t.dueAt)}</Badge>
    </li>
  );

  return (
    <>
      <PageHeader
        title={`Welcome, ${user.name.split(" ")[0]}`}
        subtitle={fmtDate(now)}
        actions={
          <>
            <LinkButton href="/clients/new">Add client</LinkButton>
            <LinkButton href="/campaigns/new" variant="gold">New campaign</LinkButton>
          </>
        }
      />

      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
        <Stat label="Total clients" value={total} href="/clients" />
        <Stat label="Active clients" value={active} href="/clients?status=ACTIVE" />
        <Stat label="Prospects" value={prospects} href="/clients?status=PROSPECT" />
        <Stat label="Open tasks" value={openTasks} hint={overdue.length ? `${overdue.length} overdue` : undefined} href="/tasks" />
        <Stat label="Unread conversations" value="—" hint="Shared inbox arrives with texting setup" />
      </div>

      <div className="mt-6 grid gap-4 lg:grid-cols-2">
        <Card title="Overdue tasks" actions={<Link href="/tasks" className="text-sm underline">All tasks</Link>}>
          {overdue.length ? <ul className="divide-y divide-navy-100">{overdue.map((t) => taskRow(t, true))}</ul> : <p className="text-sm text-slate-600">Nothing overdue.</p>}
        </Card>
        <Card title="Due in the next 7 days">
          {upcoming.length ? <ul className="divide-y divide-navy-100">{upcoming.map((t) => taskRow(t, false))}</ul> : <p className="text-sm text-slate-600">No tasks due this week.</p>}
        </Card>
        <Card title="Campaign delivery" actions={<Link href="/campaigns" className="text-sm underline">Campaigns</Link>}>
          <p className="text-sm text-slate-700">
            {drafts} draft{drafts === 1 ? "" : "s"} in progress. No campaigns have been sent — delivery results will appear here once
            sending is set up and a campaign goes out.
          </p>
        </Card>
        <Card title="Recent imports" actions={<Link href="/imports" className="text-sm underline">Imports</Link>}>
          {recentImports.length ? (
            <ul className="divide-y divide-navy-100 text-sm">
              {recentImports.map((b) => (
                <li key={b.id} className="flex justify-between gap-2 py-2">
                  <Link href={`/imports/${b.id}`} className="font-medium underline">{b.fileName}</Link>
                  <span className="text-slate-600">{b.importedBy.name} · {fmtDateTime(b.createdAt)}</span>
                </li>
              ))}
            </ul>
          ) : (
            <EmptyState title="No imports yet">Bring in contacts from a TaxAct export on the Imports page.</EmptyState>
          )}
        </Card>
      </div>

      {(!integrations.email || !integrations.twilio) && (
        <div className="mt-6">
          <Notice tone="info" title="Sending is not set up yet">
            Email and text sending are turned off until the providers are connected and tested. Campaigns can be drafted and previewed now.
            {user.role === "ADMIN" && <> See <Link className="underline" href="/settings">Settings</Link> for what&apos;s needed.</>}
          </Notice>
        </div>
      )}
    </>
  );
}
