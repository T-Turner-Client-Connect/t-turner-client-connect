import Link from "next/link";
import { endOfDay, startOfDay } from "date-fns";
import { Badge, Card, LinkButton, Notice, PageHeader, Stat } from "@/components/ui";
import { requireUser } from "@/lib/auth/session";
import { prisma } from "@/lib/prisma";
import { workQueue } from "@/lib/services/workqueue";
import { MONTHS, PERIOD_LABELS } from "@/lib/services/bookkeeping";
import { filingTitle } from "@/lib/tax/normalize";
import { fmtDate, fmtDateTime, fromNow } from "@/lib/format";
import { integrationStatus } from "@/lib/integrations";
import { ownerAccessFor } from "@/lib/auth/owner";
import { receivables } from "@/lib/services/owner-billing";
import { money } from "@/lib/billing/pricing";

export const metadata = { title: "Dashboard" };

function Empty({ children }: { children: React.ReactNode }) {
  return <p className="rounded-lg bg-ivory-50 px-3 py-4 text-sm text-slate-600">{children}</p>;
}

export default async function Dashboard() {
  const user = await requireUser();
  const now = new Date();
  const [q, dueToday, appointmentsToday, owing, totals, rejected] = await Promise.all([
    workQueue(),
    prisma.task.findMany({
      where: { status: "OPEN", dueAt: { lte: endOfDay(now) } },
      include: { client: { select: { id: true, displayName: true } }, assignee: { select: { name: true } } },
      orderBy: { dueAt: "asc" },
      take: 12,
    }),
    prisma.appointment.findMany({ where: { cancelledAt: null, startsAt: { gte: startOfDay(now), lte: endOfDay(now) } }, include: { client: { select: { id: true, displayName: true } } }, orderBy: { startsAt: "asc" } }),
    prisma.documentRequest.groupBy({ by: ["clientId"], where: { status: "OPEN" }, _count: true, _min: { dueAt: true } }),
    Promise.all([
      prisma.client.count({ where: { archivedAt: null } }),
      prisma.client.count({ where: { archivedAt: null, status: "ACTIVE" } }),
      prisma.task.count({ where: { status: "OPEN" } }),
      prisma.conversation.count({ where: { unreadByStaff: true, closedAt: null } }),
    ]),
    prisma.filingRecord.findMany({ where: { filingStatus: "REJECTED" }, include: { client: { select: { id: true, displayName: true } } }, take: 10 }),
  ]);
  const owingClients = owing.length
    ? await prisma.client.findMany({ where: { id: { in: owing.map((o) => o.clientId) } }, select: { id: true, displayName: true } })
    : [];
  const names = new Map(owingClients.map((c) => [c.id, c.displayName]));
  const [total, active, openTasks, unread] = totals;
  const integrations = integrationStatus();
  // Private totals: only rendered for the account that holds full owner access.
  const ownerAccess = await ownerAccessFor(user.id);
  const owed = ownerAccess?.scope === "FULL" ? await receivables(user) : null;

  return (
    <>
      <PageHeader
        title={`Good ${now.getHours() < 12 ? "morning" : now.getHours() < 17 ? "afternoon" : "evening"}, ${user.name.split(" ")[0]}`}
        subtitle={fmtDate(now)}
        actions={
          <>
            <LinkButton href="/clients/new" variant="secondary">Add client</LinkButton>
            <LinkButton href="/imports/new" variant="secondary">Import contacts</LinkButton>
            <LinkButton href="/conversations/new">New message</LinkButton>
            <LinkButton href="/campaigns/new" variant="gold">Create campaign</LinkButton>
          </>
        }
      />

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="Active clients" value={active} hint={`${total} total`} href="/clients?status=ACTIVE" />
        <Stat label="Unread conversations" value={unread} href="/conversations?filter=unread" />
        <Stat label="Open tasks" value={openTasks} href="/tasks" />
        <Stat label="Clients owing documents" value={owing.length} href="/workflows?tab=bookkeeping" />
      </div>

      {owed && (
        <div className="mt-4 rounded-2xl border border-gold-500/50 bg-navy-900 p-4 text-white" data-testid="owner-balances">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="font-serif text-lg font-bold">Unpaid balances <span className="ml-2 text-xs font-semibold uppercase tracking-wider text-gold-500">Private — only you see this</span></p>
            <Link href="/owner" className="text-sm text-gold-500 underline">Owner&apos;s Office</Link>
          </div>
          <p className="mt-1 text-sm text-navy-100">
            {money(owed.totalOutstandingCents)} outstanding from {owed.clients.length} client{owed.clients.length === 1 ? "" : "s"}
            {owed.rows.some((r) => r.overdueCents > 0) && ` · ${money(owed.rows.reduce((s, r) => s + r.overdueCents, 0))} overdue`}
          </p>
          {owed.clients.length > 0 && (
            <ul className="mt-2 grid gap-1 text-sm sm:grid-cols-2">
              {owed.clients.slice(0, 6).map((c) => (
                <li key={c.clientId} className="flex justify-between gap-2"><span className="truncate">{c.clientName}</span><span className={c.overdueCents ? "text-red-200" : ""}>{money(c.balanceCents)}</span></li>
              ))}
            </ul>
          )}
        </div>
      )}

      <div className="mt-6 grid gap-4 lg:grid-cols-2">
        <Card title="Who needs a response?" actions={<Link href="/conversations?filter=awaiting" className="text-sm underline">All conversations</Link>}>
          {q.unanswered.length ? (
            <ul className="divide-y divide-ivory-200">
              {q.unanswered.slice(0, 8).map((c) => (
                <li key={c.id} className="flex items-center justify-between gap-2 py-2.5">
                  <Link href={`/clients/${c.client.id}?tab=messages&c=${c.id}`} className="min-w-0">
                    <span className="block truncate font-medium text-navy-900">{c.client.displayName}</span>
                    <span className="block truncate text-sm text-slate-600">{c.subject}</span>
                  </Link>
                  <span className="shrink-0 text-xs text-slate-500">{fromNow(c.lastMessageAt)}</span>
                </li>
              ))}
            </ul>
          ) : (
            <Empty>No one is waiting on a reply.</Empty>
          )}
        </Card>

        <Card title="What's due today?" actions={<Link href="/tasks" className="text-sm underline">Tasks & calendar</Link>}>
          {dueToday.length || appointmentsToday.length ? (
            <ul className="divide-y divide-ivory-200">
              {appointmentsToday.map((a) => (
                <li key={a.id} className="flex items-center justify-between gap-2 py-2.5">
                  <span><Badge tone="navy">Appointment</Badge> <Link className="font-medium underline" href={`/clients/${a.client.id}`}>{a.client.displayName}</Link> · {a.title}</span>
                  <span className="text-sm text-slate-600">{fmtDateTime(a.startsAt).split(" ").slice(3).join(" ")}</span>
                </li>
              ))}
              {dueToday.map((t) => (
                <li key={t.id} className="flex flex-wrap items-center justify-between gap-2 py-2.5">
                  <span>
                    <span className="font-medium text-navy-900">{t.title}</span>
                    <span className="block text-sm text-slate-600">{t.client?.displayName ?? "No client"} · {t.assignee?.name ?? "Unassigned"}</span>
                  </span>
                  <Badge tone={t.dueAt! < startOfDay(now) ? "red" : "gold"}>{t.dueAt! < startOfDay(now) ? `Overdue · ${fmtDate(t.dueAt)}` : "Today"}</Badge>
                </li>
              ))}
            </ul>
          ) : (
            <Empty>Nothing due today.</Empty>
          )}
        </Card>

        <Card title="Which clients owe documents?">
          {owing.length ? (
            <ul className="divide-y divide-ivory-200 text-sm">
              {owing.slice(0, 10).map((o) => (
                <li key={o.clientId} className="flex items-center justify-between gap-2 py-2">
                  <Link className="font-medium underline" href={`/clients/${o.clientId}?tab=bookkeeping`}>{names.get(o.clientId)}</Link>
                  <span>{o._count} open request{o._count === 1 ? "" : "s"}{o._min.dueAt && <span className="text-slate-600"> · next due {fmtDate(o._min.dueAt)}</span>}</span>
                </li>
              ))}
            </ul>
          ) : (
            <Empty>No outstanding document requests.</Empty>
          )}
          {q.submittedRequests.length > 0 && <p className="mt-3 text-sm"><Badge tone="gold">{q.submittedRequests.length}</Badge> client upload(s) waiting for your review.</p>}
        </Card>

        <Card title="Which bookkeeping months need attention?">
          {q.periodsAwaiting.length ? (
            <ul className="divide-y divide-ivory-200 text-sm">
              {q.periodsAwaiting.slice(0, 10).map((p) => (
                <li key={p.id} className="flex items-center justify-between gap-2 py-2">
                  <Link className="font-medium underline" href={`/clients/${p.client.id}?tab=bookkeeping`}>{p.client.displayName}</Link>
                  <span>{MONTHS[p.month - 1]} {p.year} · {PERIOD_LABELS[p.status]} · client uploaded files</span>
                </li>
              ))}
            </ul>
          ) : (
            <Empty>No months with new client uploads waiting.</Empty>
          )}
        </Card>

        <Card title="Contracts & signatures outstanding" className="lg:col-span-2">
          {q.contracts.length || q.signatures.length || rejected.length ? (
            <ul className="grid gap-x-6 divide-y divide-ivory-200 text-sm md:grid-cols-2 md:divide-y-0">
              {q.contracts.map((c) => (
                <li key={c.id} className="py-2"><Badge tone="amber">Contract</Badge> <Link className="underline" href={`/clients/${c.client.id}?tab=portal`}>{c.client.displayName}</Link> · {c.title}{c.dueAt && ` · due ${fmtDate(c.dueAt)}`}</li>
              ))}
              {q.signatures.map((s) => (
                <li key={s.id} className="py-2"><Badge tone="navy">Signature</Badge> <Link className="underline" href={`/clients/${s.client.id}?tab=portal`}>{s.client.displayName}</Link> · {s.title} ({s.status.toLowerCase().replace(/_/g, " ")})</li>
              ))}
              {rejected.map((f) => (
                <li key={f.id} className="py-2"><Badge tone="red">Rejected filing</Badge> <Link className="underline" href={`/clients/${f.client.id}?tab=taxes`}>{f.client.displayName}</Link> · {filingTitle(f)}</li>
              ))}
            </ul>
          ) : (
            <Empty>Nothing outstanding.</Empty>
          )}
        </Card>
      </div>

      {(!integrations.email || !integrations.twilio) && (
        <div className="mt-6">
          <Notice tone="info" title="Live sending is off">
            Email and text sending stay off until providers are connected and tested. Portal messages work now.
            {user.role === "ADMIN" && <> See <Link className="underline" href="/settings">Settings</Link>.</>}
          </Notice>
        </div>
      )}
    </>
  );
}
