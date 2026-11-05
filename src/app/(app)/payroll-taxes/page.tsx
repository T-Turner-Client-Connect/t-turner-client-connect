import Link from "next/link";
import clsx from "clsx";
import { CalendarDays, Settings2 } from "lucide-react";
import { Badge, Card, EmptyState, LinkButton, PageHeader } from "@/components/ui";
import { Countdown, fmtDay, fmtWhen, OverdueFlag, QueueBadge, RemindersOffBanner, VersionTag } from "@/components/payroll-taxes/bits";
import { requirePayrollTaxPage } from "@/lib/payroll-taxes/access";
import { clientApprovals, completedWork, dueDates, listSchedules, payrollTaxSettings, schedulableClients, workQueue, type QueueFilter } from "@/lib/services/payroll-taxes";
import { downloadToken } from "@/lib/services/documents";
import { todayCentral } from "@/lib/services/ledger";
import { FREQUENCIES } from "@/lib/payroll/schedule";

export const metadata = { title: "ADP Payroll & Taxes" };

const TABS = [
  { key: "payroll", label: "Payroll" },
  { key: "taxes", label: "Taxes" },
  { key: "due", label: "Due Dates" },
  { key: "approvals", label: "Client Approvals" },
  { key: "completed", label: "Completed Work" },
] as const;
type Tab = (typeof TABS)[number]["key"];
const FILTERS: { key: QueueFilter; label: string }[] = [
  { key: "mine", label: "Assigned to me" },
  { key: "all", label: "All" },
  { key: "overdue", label: "Overdue" },
];

const href = (p: { tab?: string; f?: string; month?: string }) => `/payroll-taxes?${new URLSearchParams(Object.entries(p).filter(([, v]) => v) as [string, string][]).toString()}`;

export default async function PayrollTaxesPage({ searchParams }: { searchParams: Promise<{ tab?: string; f?: string; month?: string }> }) {
  const { actor, access } = await requirePayrollTaxPage();
  const sp = await searchParams;
  const tab: Tab = TABS.some((t) => t.key === sp.tab) ? (sp.tab as Tab) : "payroll";
  const filter: QueueFilter = FILTERS.some((f) => f.key === sp.f) ? (sp.f as QueueFilter) : "mine";
  const today = todayCentral();
  const month = /^\d{4}-\d{2}$/.test(sp.month ?? "") ? sp.month! : today.slice(0, 7);
  const [queue, settings] = await Promise.all([workQueue(actor, filter, today), payrollTaxSettings()]);
  const manage = access.level === "MANAGE";

  return (
    <>
      <PageHeader
        title="ADP Payroll & Taxes"
        subtitle={<>Payroll schedules, hours, previews, client approvals and ADP processing. Nothing here submits payroll, files taxes or moves money — every ADP step is recorded by a person.{!manage && <Badge tone="gray" className="ml-2">View only</Badge>}</>}
        actions={manage ? <LinkButton href="/payroll-taxes/settings" variant="secondary"><Settings2 className="size-4" aria-hidden /> Reminder settings</LinkButton> : undefined}
      />
      {!settings.clientRemindersAuthorized && <RemindersOffBanner isOwner={access.isOwner} />}

      <Card
        title={<span className="flex items-center gap-2">Work queue {queue.overdueCount > 0 && <Badge tone="red">{queue.overdueCount} overdue</Badge>}</span>}
        actions={
          <nav aria-label="Queue filter" className="flex gap-1 rounded-lg bg-ivory-100 p-1 text-sm">
            {FILTERS.map((f) => (
              <Link key={f.key} href={href({ tab, f: f.key, month: sp.month })} aria-current={filter === f.key ? "true" : undefined} className={clsx("rounded-md px-3 py-1 font-semibold", filter === f.key ? "bg-navy-900 text-white" : "text-navy-900 hover:bg-white")}>{f.label}</Link>
            ))}
          </nav>
        }
      >
        {queue.rows.length === 0 ? (
          <p className="text-sm text-slate-600" data-testid="queue-empty">{filter === "mine" ? "Nothing is assigned to you right now. Choose “All” to see every client's payroll." : filter === "overdue" ? "Nothing is overdue." : "No pay cycles yet. Add a payroll schedule below."}</p>
        ) : (
          <div className="-mx-2 overflow-x-auto">
            <table className="w-full min-w-[760px] text-sm" data-testid="work-queue">
              <thead className="text-left text-xs uppercase tracking-wide text-slate-500">
                <tr><th className="px-2 py-2">Client</th><th className="px-2">Item</th><th className="px-2">Deadline</th><th className="px-2">Status</th><th className="px-2">Assigned</th><th className="px-2 text-right">Next action</th></tr>
              </thead>
              <tbody className="divide-y divide-ivory-200">
                {queue.rows.map((r) => (
                  <tr key={r.data.cycleId} className={clsx(r.overdue && "bg-red-50/60")} data-status={r.status} data-overdue={r.overdue ? "yes" : "no"}>
                    <td className="px-2 py-2.5">
                      <p className="font-semibold text-navy-900">{r.data.clientName}</p>
                      <p className="text-xs text-slate-600">Pay date {fmtDay(r.data.payDate)} {r.data.versionNumber ? <VersionTag n={r.data.versionNumber} /> : null}</p>
                    </td>
                    <td className="px-2">{r.item}</td>
                    <td className="px-2">{r.deadline ? <><span className="block">{fmtDay(r.deadline)}</span><Countdown days={r.daysLeft} overdue={r.overdue} /></> : "—"}</td>
                    <td className="px-2"><span className="flex flex-wrap items-center gap-1">{r.overdue && <OverdueFlag />}<QueueBadge status={r.status} /></span></td>
                    <td className="px-2">{r.data.assigneeName ?? <span className="text-slate-500">Unassigned</span>}</td>
                    <td className="px-2 text-right"><LinkButton href={`/payroll-taxes/cycles/${r.data.cycleId}`} variant={r.overdue ? "primary" : "secondary"} className="min-h-8 px-3 py-1 text-xs">{manage ? r.action : "View"}</LinkButton></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <nav aria-label="Workspace sections" className="mt-6 flex flex-wrap gap-1 border-b border-ivory-200" data-testid="workspace-tabs">
        {TABS.map((t) => (
          <Link key={t.key} href={href({ tab: t.key, f: filter === "mine" ? undefined : filter })} aria-current={tab === t.key ? "page" : undefined} className={clsx("-mb-px rounded-t-lg border px-4 py-2 text-sm font-semibold", tab === t.key ? "border-ivory-200 border-b-white bg-white text-navy-900" : "border-transparent text-slate-600 hover:text-navy-900")}>{t.label}</Link>
        ))}
      </nav>
      <div className="mt-4" data-testid={`tab-${tab}`}>
        {tab === "payroll" && <PayrollTab manage={manage} />}
        {tab === "taxes" && (
          <EmptyState title="Taxes">Tax obligations (MAT, Jefferson County, Birmingham, Huntsville) arrive in the next stage.</EmptyState>
        )}
        {tab === "due" && <DueTab month={month} today={today} />}
        {tab === "approvals" && <ApprovalsTab />}
        {tab === "completed" && <CompletedTab staffId={actor.id} />}
      </div>
    </>
  );

  async function PayrollTab({ manage }: { manage: boolean }) {
    const [schedules, candidates] = await Promise.all([listSchedules(actor), manage ? schedulableClients(actor) : Promise.resolve([])]);
    return (
      <Card title="Payroll schedules" actions={manage && candidates.length > 0 ? (
        <form action="/payroll-taxes/schedules" className="flex flex-wrap items-center gap-2">
          <select name="client" aria-label="Client" className="rounded-lg border border-ivory-200 px-2 py-1.5 text-sm">
            {candidates.map((c) => <option key={c.id} value={c.id}>{c.businessName || c.displayName}</option>)}
          </select>
          <button className="rounded-lg bg-navy-900 px-3 py-1.5 text-sm font-semibold text-white">Add schedule</button>
        </form>
      ) : undefined}>
        {!schedules.length ? (
          <p className="text-sm text-slate-600">No payroll schedules yet.{manage ? " Choose a payroll client above (clients with payroll turned on in Bookkeeping)." : ""}</p>
        ) : (
          <div className="-mx-2 overflow-x-auto">
            <table className="w-full min-w-[680px] text-sm" data-testid="schedules">
              <thead className="text-left text-xs uppercase tracking-wide text-slate-500"><tr><th className="px-2 py-2">Client</th><th className="px-2">Frequency</th><th className="px-2">Next pay date</th><th className="px-2">Assigned</th><th className="px-2">Client reminders</th><th className="px-2" /></tr></thead>
              <tbody className="divide-y divide-ivory-200">
                {schedules.map((s) => (
                  <tr key={s.id}>
                    <td className="px-2 py-2.5 font-semibold text-navy-900">{s.clientName}{!s.active && <Badge tone="gray" className="ml-2">Paused</Badge>}</td>
                    <td className="px-2">{FREQUENCIES[s.frequency as keyof typeof FREQUENCIES] ?? s.frequency}{s.frequency === "SEMIMONTHLY" && ` (${s.semiMonthlyDays.map((d) => (d === 31 ? "last day" : d)).join(" & ")})`}</td>
                    <td className="px-2">{s.nextPayDate ? fmtDay(s.nextPayDate) : "—"}</td>
                    <td className="px-2">{s.assignedName ?? <span className="text-slate-500">Unassigned</span>}</td>
                    <td className="px-2">{s.clientRemindersEnabled ? <Badge tone="green">On</Badge> : <Badge tone="gray">Off</Badge>}</td>
                    <td className="px-2 text-right"><Link href={`/payroll-taxes/schedules/${s.clientId}`} className="font-semibold text-navy-900 underline decoration-gold-500 underline-offset-4">{manage ? "Edit schedule" : "View schedule"}</Link></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    );
  }

  async function DueTab({ month, today }: { month: string; today: string }) {
    const { items, start } = await dueDates(actor, month, today);
    const y = Number(month.slice(0, 4));
    const m = Number(month.slice(5, 7));
    const days = new Date(Date.UTC(y, m, 0)).getUTCDate();
    const lead = new Date(`${start}T00:00:00Z`).getUTCDay();
    const prev = m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, "0")}`;
    const next = m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, "0")}`;
    const title = new Date(`${start}T12:00:00Z`).toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
    const short: Record<string, string> = { HOURS_DUE: "Hours", APPROVAL_DUE: "Approval", ADP_CUTOFF: "ADP cutoff", PAY_DATE: "Pay date" };
    return (
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
        <Card title={<span className="flex items-center gap-2"><CalendarDays className="size-5 text-gold-600" aria-hidden /> {title}</span>} actions={<span className="flex gap-2 text-sm"><Link href={href({ tab: "due", month: prev })} className="underline">← Prev</Link><Link href={href({ tab: "due", month: next })} className="underline">Next →</Link></span>}>
          <div className="grid grid-cols-7 gap-1 text-xs" data-testid="due-calendar">
            {["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((d) => <div key={d} className="py-1 text-center font-semibold text-slate-500">{d}</div>)}
            {Array.from({ length: lead }).map((_, i) => <div key={`b${i}`} />)}
            {Array.from({ length: days }).map((_, i) => {
              const date = `${month}-${String(i + 1).padStart(2, "0")}`;
              const here = items.filter((x) => x.date === date);
              return (
                <div key={date} className={clsx("min-h-20 rounded-lg border p-1", date === today ? "border-gold-500 bg-gold-50" : "border-ivory-200 bg-white")}>
                  <p className="text-right font-semibold text-slate-500">{i + 1}</p>
                  {here.slice(0, 4).map((x, k) => (
                    <Link key={k} href={`/payroll-taxes/cycles/${x.cycleId}`} title={`${x.label} — ${x.clientName}`} className={clsx("mt-0.5 block truncate rounded px-1 text-[10.5px] font-semibold", x.overdue ? "bg-red-600 text-white" : x.done ? "bg-emerald-50 text-emerald-800 line-through" : x.kind === "PAY_DATE" ? "bg-navy-900 text-white" : "bg-navy-50 text-navy-900")}>{short[x.kind]} · {x.clientName.replace(/ \(FICTIONAL\)$/, "")}</Link>
                  ))}
                  {here.length > 4 && <p className="text-[10px] text-slate-500">+{here.length - 4} more</p>}
                </div>
              );
            })}
          </div>
        </Card>
        <Card title="Every deadline this month">
          {!items.length ? <p className="text-sm text-slate-600">No payroll deadlines this month.</p> : (
            <ul className="divide-y divide-ivory-200 text-sm" data-testid="due-list">
              {items.map((x, i) => (
                <li key={i} className={clsx("flex flex-wrap items-center justify-between gap-2 py-2", x.overdue && "text-red-700")}>
                  <span><span className="font-semibold">{fmtDay(x.date)}</span> · {x.label} · {x.clientName}</span>
                  {x.overdue ? <OverdueFlag /> : x.done ? <Badge tone="green">Done</Badge> : null}
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    );
  }

  async function ApprovalsTab() {
    const rows = await clientApprovals(actor, today);
    if (!rows.length) return <EmptyState title="No approvals yet">When a preview is sent for client approval, each approver&apos;s decision shows here with the round and version.</EmptyState>;
    return (
      <div className="space-y-3" data-testid="approvals">
        {rows.map((r) => (
          <Card key={r.cycleId} title={<span className="flex flex-wrap items-center gap-2">{r.clientName} · pay date {fmtDay(r.payDate)} <VersionTag n={r.currentVersion} /> <Badge tone="gray">Round {r.round}</Badge></span>} actions={<Link href={`/payroll-taxes/cycles/${r.cycleId}`} className="text-sm font-semibold underline decoration-gold-500 underline-offset-4">Open cycle</Link>}>
            <ul className="grid gap-2 sm:grid-cols-2">
              {r.approvers.map((a, i) => (
                <li key={i} className="rounded-lg border border-ivory-200 px-3 py-2 text-sm">
                  <p className="font-semibold text-navy-900">{a.name} {a.required && <span className="text-xs font-normal text-slate-500">(required)</span>}</p>
                  <p className={clsx("text-xs font-semibold", a.decision === "APPROVED" ? "text-emerald-700" : a.decision === "DENIED" ? "text-red-700" : "text-slate-600")}>
                    {a.decision === "APPROVED" ? `Approved v${r.currentVersion} · ${fmtWhen(a.at!)}` : a.decision === "DENIED" ? `Denied v${r.currentVersion} · ${fmtWhen(a.at!)}` : a.decision === "PENDING" ? "Waiting for their decision" : "No decision on the current version"}
                  </p>
                  {a.comment && <p className="mt-1 text-xs text-slate-700">“{a.comment}”</p>}
                </li>
              ))}
            </ul>
            {r.history.length > 0 && (
              <details className="mt-3 text-sm">
                <summary className="cursor-pointer font-semibold text-navy-900">History ({r.history.length})</summary>
                <ul className="mt-2 space-y-1 text-xs text-slate-700">
                  {r.history.map((h, i) => <li key={i}>{fmtWhen(h.at)} — {h.name} {h.decision === "APPROVED" ? "approved" : "denied"} v{h.version} (round {h.round}{h.channel !== "PORTAL" ? ", by secure link" : ""}){h.comment ? `: “${h.comment}”` : ""}</li>)}
                </ul>
              </details>
            )}
          </Card>
        ))}
      </div>
    );
  }

  async function CompletedTab({ staffId }: { staffId: string }) {
    const rows = await completedWork(actor);
    if (!rows.length) return <EmptyState title="Nothing processed yet">Cycles marked processed (with ADP&apos;s confirmation) are listed here.</EmptyState>;
    return (
      <Card title="Processed payroll">
        <table className="w-full text-sm" data-testid="completed">
          <thead className="text-left text-xs uppercase tracking-wide text-slate-500"><tr><th className="py-2">Client</th><th>Pay date</th><th>Processed</th><th>Confirmation</th></tr></thead>
          <tbody className="divide-y divide-ivory-200">
            {rows.map((r) => (
              <tr key={r.cycleId}>
                <td className="py-2.5"><Link href={`/payroll-taxes/cycles/${r.cycleId}`} className="font-semibold text-navy-900 underline decoration-gold-500 underline-offset-4">{r.clientName}</Link> <VersionTag n={r.versionNumber} /></td>
                <td>{fmtDay(r.payDate)}</td>
                <td>{fmtWhen(r.processedAt)}{r.processedBy ? ` · ${r.processedBy}` : ""}</td>
                <td>{r.confirmation ? <a href={`/api/documents/${downloadToken(r.confirmation.id, { staffId })}`} className="font-semibold text-navy-900 underline">{r.confirmation.title}</a> : "—"}{r.note && <span className="block text-xs text-slate-600">{r.note}</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    );
  }
}
