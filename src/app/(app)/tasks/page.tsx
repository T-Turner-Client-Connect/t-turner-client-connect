import Link from "next/link";
import { startOfDay } from "date-fns";
import type { Prisma } from "@prisma/client";
import { ActionForm } from "@/components/action-form";
import { ConfirmButton } from "@/components/confirm-button";
import { Badge, Button, buttonClass, Card, EmptyState, Field, PageHeader } from "@/components/ui";
import { addAppointmentAction, cancelAppointmentAction, saveTaskAction, setTaskDoneAction } from "@/app/actions/tasks";
import { MonthCalendar, monthFromParam, type CalendarEvent } from "@/components/month-calendar";
import { addDays, endOfMonth, startOfMonth } from "date-fns";
import { requireUser } from "@/lib/auth/session";
import { prisma } from "@/lib/prisma";
import { fmtDate } from "@/lib/format";

export const metadata = { title: "Tasks & Calendar" };

export default async function TasksPage({ searchParams }: { searchParams: Promise<{ view?: string; who?: string; month?: string }> }) {
  const user = await requireUser();
  const { view = "open", who = "all", month: monthParam } = await searchParams;
  if (view === "calendar") return <CalendarView month={monthFromParam(monthParam)} />;
  const where: Prisma.TaskWhereInput = { status: view === "done" ? "DONE" : "OPEN" };
  if (who === "me") where.assigneeId = user.id;
  else if (who !== "all") where.assigneeId = who;
  const [tasks, staff, clients] = await Promise.all([
    prisma.task.findMany({
      where,
      include: { client: { select: { id: true, displayName: true } }, assignee: { select: { name: true } } },
      orderBy: view === "done" ? { completedAt: "desc" } : [{ dueAt: { sort: "asc", nulls: "last" } }, { createdAt: "asc" }],
      take: 300,
    }),
    prisma.user.findMany({ where: { active: true }, select: { id: true, name: true }, orderBy: { name: "asc" } }),
    prisma.client.findMany({ where: { archivedAt: null }, select: { id: true, displayName: true }, orderBy: { displayName: "asc" }, take: 2000 }),
  ]);
  const today = startOfDay(new Date());
  const tab = (v: string, label: string) => (
    <Link href={`/tasks?view=${v}&who=${who}`} className={buttonClass(view === v ? "primary" : "secondary")}>{label}</Link>
  );
  return (
    <>
      <PageHeader title="Tasks & Calendar" />
      <div className="grid gap-4 lg:grid-cols-3">
        <div className="space-y-3 lg:col-span-2">
          <div className="flex flex-wrap items-center gap-2">
            {tab("open", "Open")}
            {tab("done", "Completed")}
            {tab("calendar", "Calendar")}
            <form className="ml-auto">
              <input type="hidden" name="view" value={view} />
              <label className="flex items-center gap-2 text-sm">
                <span>Assigned to</span>
                <select className="input w-auto" name="who" defaultValue={who}>
                  <option value="all">Everyone</option>
                  <option value="me">Me</option>
                  {staff.filter((s) => s.id !== user.id).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                </select>
                <button className={buttonClass("secondary")}>Show</button>
              </label>
            </form>
          </div>
          {tasks.length === 0 ? (
            <EmptyState title={view === "done" ? "No completed tasks" : "No open tasks"} />
          ) : (
            <ul className="divide-y divide-navy-100 rounded-xl border border-navy-100 bg-white">
              {tasks.map((t) => {
                const overdue = t.status === "OPEN" && t.dueAt && t.dueAt < today;
                return (
                  <li key={t.id} className="flex flex-wrap items-start justify-between gap-3 px-4 py-3">
                    <div className="min-w-0">
                      <p className="font-semibold text-navy-900">{t.title}</p>
                      {t.details && <p className="text-sm text-slate-700">{t.details}</p>}
                      <p className="text-sm text-slate-600">
                        {t.client ? <Link className="underline" href={`/clients/${t.client.id}`}>{t.client.displayName}</Link> : "No client"} · {t.assignee?.name ?? "Unassigned"}
                      </p>
                      <div className="mt-1 flex flex-wrap gap-1">
                        {t.dueAt && <Badge tone={overdue ? "red" : "gray"}>{overdue ? "Overdue · " : ""}Due {fmtDate(t.dueAt)}</Badge>}
                        {t.priority === "HIGH" && <Badge tone="gold">High priority</Badge>}
                        {t.remindAt && <Badge tone="navy">Reminder {fmtDate(t.remindAt)}</Badge>}
                      </div>
                    </div>
                    <ConfirmButton action={setTaskDoneAction.bind(null, t.id, t.status !== "DONE")} variant={t.status === "DONE" ? "secondary" : "primary"}>
                      {t.status === "DONE" ? "Reopen" : "Mark done"}
                    </ConfirmButton>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
        <Card title="New task">
          <ActionForm action={saveTaskAction.bind(null, null)} className="space-y-3" resetOnSuccess>
            <Field label="Task"><input className="input" name="title" required /></Field>
            <Field label="Details"><textarea className="input" name="details" rows={3} /></Field>
            <Field label="Client">
              <select className="input" name="clientId" defaultValue="">
                <option value="">No client</option>
                {clients.map((c) => <option key={c.id} value={c.id}>{c.displayName}</option>)}
              </select>
            </Field>
            <Field label="Assign to">
              <select className="input" name="assigneeId" defaultValue={user.id}>
                {staff.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Due"><input className="input" type="date" name="dueAt" /></Field>
              <Field label="Remind me" hint="Shown on the task now; alerts come later."><input className="input" type="date" name="remindAt" /></Field>
            </div>
            <Field label="Priority">
              <select className="input" name="priority" defaultValue="NORMAL">
                <option value="LOW">Low</option><option value="NORMAL">Normal</option><option value="HIGH">High</option>
              </select>
            </Field>
            <Button type="submit">Add task</Button>
          </ActionForm>
        </Card>
      </div>
    </>
  );
}

async function CalendarView({ month }: { month: Date }) {
  const range = { gte: addDays(startOfMonth(month), -7), lte: addDays(endOfMonth(month), 7) };
  const [tasks, deadlines, appts, requests, clients, staff] = await Promise.all([
    prisma.task.findMany({ where: { status: "OPEN", dueAt: range }, select: { id: true, title: true, dueAt: true, clientId: true } }),
    prisma.clientDeadline.findMany({ where: { dueAt: range }, include: { client: { select: { displayName: true } } } }),
    prisma.appointment.findMany({ where: { startsAt: range, cancelledAt: null }, include: { client: { select: { displayName: true } } } }),
    prisma.documentRequest.findMany({ where: { status: "OPEN", dueAt: range }, include: { client: { select: { displayName: true } } } }),
    prisma.client.findMany({ where: { archivedAt: null }, select: { id: true, displayName: true }, orderBy: { displayName: "asc" }, take: 2000 }),
    prisma.user.findMany({ where: { active: true }, select: { id: true, name: true } }),
  ]);
  const upcoming = await prisma.appointment.findMany({ where: { cancelledAt: null, startsAt: { gte: new Date() } }, include: { client: { select: { displayName: true } } }, orderBy: { startsAt: "asc" }, take: 10 });
  const events: CalendarEvent[] = [
    ...appts.map((a) => ({ id: `a${a.id}`, at: a.startsAt, title: `🕑 ${a.client.displayName}: ${a.title}`, href: `/clients/${a.clientId}`, tone: "navy" as const })),
    ...tasks.map((t) => ({ id: `t${t.id}`, at: t.dueAt!, title: `☐ ${t.title}`, href: t.clientId ? `/clients/${t.clientId}` : "/tasks", tone: "gray" as const })),
    ...deadlines.map((d) => ({ id: `d${d.id}`, at: d.dueAt, title: `⚑ ${d.client.displayName}: ${d.title}`, href: `/clients/${d.clientId}?tab=portal`, tone: "red" as const })),
    ...requests.map((r) => ({ id: `r${r.id}`, at: r.dueAt!, title: `📄 ${r.client.displayName}: ${r.title}`, href: `/clients/${r.clientId}?tab=bookkeeping`, tone: "gold" as const })),
  ];
  return (
    <>
      <PageHeader title="Tasks & Calendar" actions={<><Link href="/tasks" className={buttonClass("secondary")}>Task list</Link></>} />
      <div className="grid gap-4 xl:grid-cols-4">
        <div className="xl:col-span-3">
          <MonthCalendar month={month} events={events} basePath="/tasks?view=calendar" />
          <p className="mt-2 text-xs text-slate-600">Appointments (navy) · tasks (gray) · client deadlines (red) · document due dates (gold)</p>
        </div>
        <div className="space-y-4">
          <Card title="Add appointment">
            <ActionForm action={addAppointmentAction} className="space-y-3" resetOnSuccess>
              <Field label="Client">
                <select className="input" name="clientId" required defaultValue="">
                  <option value="" disabled>Choose…</option>
                  {clients.map((c) => <option key={c.id} value={c.id}>{c.displayName}</option>)}
                </select>
              </Field>
              <Field label="What"><input className="input" name="title" required placeholder="Tax review meeting" /></Field>
              <Field label="When"><input className="input" type="datetime-local" name="startsAt" required /></Field>
              <Field label="Where"><input className="input" name="location" placeholder="Office, phone, or video" /></Field>
              <Field label="With">
                <select className="input" name="staffId">{staff.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select>
              </Field>
              <Button type="submit">Add</Button>
            </ActionForm>
          </Card>
          <Card title="Upcoming appointments">
            {upcoming.length ? (
              <ul className="space-y-2 text-sm">
                {upcoming.map((a) => (
                  <li key={a.id} className="flex items-start justify-between gap-2">
                    <span><strong>{fmtDate(a.startsAt)}</strong> · {a.client.displayName}<span className="block text-slate-600">{a.title}</span></span>
                    <ConfirmButton action={cancelAppointmentAction.bind(null, a.id)} variant="ghost" confirm="Cancel this appointment? Its reminder won't be sent.">Cancel</ConfirmButton>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-slate-600">None scheduled.</p>
            )}
          </Card>
        </div>
      </div>
    </>
  );
}
