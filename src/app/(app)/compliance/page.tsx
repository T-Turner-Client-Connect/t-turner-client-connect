import Link from "next/link";
import clsx from "clsx";
import { ExternalLink } from "lucide-react";
import { Card, EmptyState, PageHeader, Stat } from "@/components/ui";
import { ComplianceNav, fmtD, LABEL, NeedsVerification, StatusBadge, SwitchesBanner } from "@/components/compliance/bits";
import { requireCompliancePage } from "@/lib/compliance/page-gate";
import { myReminders, taxDueBoard, type BoardFilter } from "@/lib/services/compliance/views";
import { FILING_STATUS } from "@/lib/services/compliance/periods";

export const metadata = { title: "Tax Due Board" };

type SP = Record<string, string | undefined>;
const KEYS = ["clientId", "entityId", "state", "county", "city", "industry", "form", "staffId", "from", "to", "filingStatus", "frequency", "segment"] as const;

export default async function TaxDueBoardPage({ searchParams }: { searchParams: Promise<SP> }) {
  const { actor, access } = await requireCompliancePage();
  const sp = await searchParams;
  const filter: BoardFilter = Object.fromEntries(KEYS.filter((k) => sp[k]).map((k) => [k, sp[k]])) as BoardFilter;
  if (sp.done === "1") filter.includeDone = true;
  const [b, reminders] = await Promise.all([taxDueBoard(actor, filter), myReminders(actor, 8)]);
  const calendar = sp.view === "calendar";
  const month = /^\d{4}-\d{2}$/.test(sp.month ?? "") ? sp.month! : b.today.slice(0, 7);
  const qs = (extra: SP) => `/compliance?${new URLSearchParams(Object.entries({ ...sp, ...extra }).filter(([, v]) => v) as [string, string][]).toString()}`;
  const w = b.widgets;
  return (
    <>
      <PageHeader title="Tax & Compliance — Tax Due Board" subtitle="Every entity's filing deadlines, approvals and evidence. Staff file in the government portal; nothing here files or pays." />
      <SwitchesBanner {...b.switches} isOwner={access.isOwner} />
      <ComplianceNav current={calendar ? "/compliance?view=calendar" : "/compliance"} isOwner={access.isOwner} />

      <form action="/compliance" className="mb-5 grid gap-2 rounded-2xl border border-ivory-200 bg-white p-4 sm:grid-cols-3 lg:grid-cols-6" data-testid="board-filters">
        {calendar && <input type="hidden" name="view" value="calendar" />}
        <select name="clientId" defaultValue={sp.clientId ?? ""} className="input" aria-label="Client"><option value="">All clients</option>{b.options.clients.map((c) => <option key={c.id} value={c.id}>{c.displayName}</option>)}</select>
        <select name="entityId" defaultValue={sp.entityId ?? ""} className="input" aria-label="Entity"><option value="">All entities</option>{b.options.entities.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}</select>
        <input name="state" defaultValue={sp.state ?? ""} placeholder="State (AL)" className="input" aria-label="State" />
        <input name="county" defaultValue={sp.county ?? ""} placeholder="County" className="input" aria-label="County" />
        <input name="city" defaultValue={sp.city ?? ""} placeholder="City" className="input" aria-label="City" />
        <input name="industry" defaultValue={sp.industry ?? ""} placeholder="Industry / tag" className="input" aria-label="Industry" />
        <input name="form" defaultValue={sp.form ?? ""} placeholder="Form / obligation" className="input" aria-label="Form" />
        <select name="staffId" defaultValue={sp.staffId ?? ""} className="input" aria-label="Assigned staff"><option value="">Any staff</option>{b.options.staff.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select>
        <input type="date" name="from" defaultValue={sp.from ?? ""} className="input" aria-label="Due from" />
        <input type="date" name="to" defaultValue={sp.to ?? ""} className="input" aria-label="Due to" />
        <select name="filingStatus" defaultValue={sp.filingStatus ?? ""} className="input" aria-label="Filing status"><option value="">Open items</option>{Object.entries(FILING_STATUS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
        <select name="frequency" defaultValue={sp.frequency ?? ""} className="input" aria-label="Frequency"><option value="">Any frequency</option>{Object.entries(LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
        <select name="segment" defaultValue={sp.segment ?? ""} className="input" aria-label="Client type"><option value="">All client types</option><option value="nonprofit">Nonprofits</option><option value="bookkeeping">Bookkeeping clients</option><option value="payroll">Payroll clients</option><option value="tax_only">Tax-only clients</option></select>
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="done" value="1" defaultChecked={sp.done === "1"} /> Include completed</label>
        <button className="rounded-lg bg-navy-900 px-4 py-2 text-sm font-semibold text-white">Filter</button>
        <Link href={calendar ? "/compliance?view=calendar" : "/compliance"} className="self-center text-sm underline">Clear</Link>
      </form>

      <div className="mb-5 grid grid-cols-2 gap-3 lg:grid-cols-6" data-testid="board-widgets">
        <Stat label="Due in 30 days" value={w.upcoming.length} />
        <Stat label="Overdue" value={<span className={w.overdue.length ? "text-red-700" : ""}>{w.overdue.length}</span>} />
        <Stat label="Awaiting client approval" value={w.awaitingApproval.length} />
        <Stat label="Missing confirmations" value={w.missingConfirmations.length} hint="Submitted without acceptance, or paid without receipt" />
        <Stat label="Renewals (60 days)" value={w.renewals.length} />
        <Stat label="Needs verification" value={w.needsVerification} hint="Due dates not yet confirmed" />
      </div>

      <div className="mb-5 grid gap-4 lg:grid-cols-3">
        <Card title="Staff workload" className="lg:col-span-1">
          {w.workload.length ? <ul className="divide-y divide-ivory-200 text-sm">{w.workload.map((s) => <li key={s.name} className="flex justify-between py-1.5"><span>{s.name}</span><span>{s.open} open{s.overdue ? <span className="ml-2 font-semibold text-red-700">{s.overdue} overdue</span> : null}</span></li>)}</ul> : <p className="text-sm text-slate-600">No open items.</p>}
        </Card>
        <Card title="My reminders" className="lg:col-span-2">
          {reminders.length ? <ul className="divide-y divide-ivory-200 text-sm" data-testid="my-reminders">{reminders.map((r) => <li key={r.id} className="py-1.5"><Link href={`/compliance/periods/${r.periodId}`} className="underline decoration-gold-500">{r.detail ?? `${r.period.obligation.formName} ${r.period.periodKey}`}</Link> <span className="text-xs text-slate-500">{r.step}</span></li>)}</ul> : <p className="text-sm text-slate-600">No reminders for you.</p>}
        </Card>
      </div>

      {calendar ? <MonthCalendar rows={b.rows} month={month} prev={qs({ month: shift(month, -1) })} next={qs({ month: shift(month, 1) })} /> : (
        <Card title={`Filing periods (${b.rows.length})`}>
          {b.rows.length === 0 ? <EmptyState title="Nothing matches these filters" /> : (
            <div className="-mx-2 overflow-x-auto">
              <table className="w-full min-w-[860px] text-left text-sm" data-testid="board-table">
                <thead className="text-xs uppercase text-slate-600"><tr><th className="px-2 py-2">Due</th><th className="px-2">Client / entity</th><th className="px-2">Form / obligation</th><th className="px-2">Period</th><th className="px-2">Status</th><th className="px-2">Payment</th><th className="px-2">Assigned</th><th className="px-2" /></tr></thead>
                <tbody className="divide-y divide-ivory-200">
                  {b.rows.map((r) => (
                    <tr key={r.id} className={clsx(r.days !== null && r.days < 0 && !["SUBMITTED", "ACCEPTED", "NOT_REQUIRED"].includes(r.filingStatus) && "bg-red-50/60")}>
                      <td className="px-2 py-2 whitespace-nowrap">{fmtD(r.due)}{r.days !== null && !["SUBMITTED", "ACCEPTED", "NOT_REQUIRED"].includes(r.filingStatus) && <span className="block text-xs text-slate-600">{r.days < 0 ? `${-r.days}d overdue` : `${r.days}d`}</span>}{!r.dueCertain && <NeedsVerification />}</td>
                      <td className="px-2"><Link href={`/compliance/entities/${r.entityId}`} className="font-semibold underline decoration-gold-500">{r.entityName}</Link><span className="block text-xs text-slate-600">{r.clientName}{r.entityKind === "NONPROFIT" ? " · Nonprofit" : ""}</span></td>
                      <td className="px-2">{r.form}<span className="block text-xs text-slate-600">{r.jurisdiction} · {LABEL[r.frequency] ?? r.frequency}</span></td>
                      <td className="px-2">{r.periodKey}{r.kind === "AMENDED" ? " (amended)" : ""}</td>
                      <td className="px-2"><StatusBadge status={r.status} /></td>
                      <td className="px-2 text-xs">{r.paymentStatus.replace("_", " ").toLowerCase()}</td>
                      <td className="px-2 text-xs">{r.assigned}</td>
                      <td className="px-2 whitespace-nowrap text-right"><Link href={`/compliance/periods/${r.id}`} className="font-semibold underline">Open</Link>{r.portalUrl && <a href={r.portalUrl} target="_blank" rel="noopener noreferrer" className="ml-3 inline-flex items-center gap-1 text-xs underline">Portal <ExternalLink className="size-3" aria-hidden /></a>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      )}
    </>
  );
}

function shift(month: string, n: number) {
  const [y, m] = month.split("-").map(Number);
  const i = y * 12 + m - 1 + n;
  return `${Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, "0")}`;
}

function MonthCalendar({ rows, month, prev, next }: { rows: { id: string; due: string | null; form: string; entityName: string; status: string; dueCertain: boolean }[]; month: string; prev: string; next: string }) {
  const [y, m] = month.split("-").map(Number);
  const first = new Date(Date.UTC(y, m - 1, 1)).getUTCDay();
  const days = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const cells = [...Array(first).fill(null), ...Array.from({ length: days }, (_, i) => i + 1)];
  const label = new Intl.DateTimeFormat("en-US", { month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(Date.UTC(y, m - 1, 1)));
  return (
    <Card title={label} actions={<span className="flex gap-3 text-sm"><Link href={prev} className="underline">← Previous</Link><Link href={next} className="underline">Next →</Link></span>}>
      <div className="grid grid-cols-7 gap-1 text-xs" data-testid="board-calendar">
        {["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((d) => <div key={d} className="px-1 font-semibold text-slate-600">{d}</div>)}
        {cells.map((d, i) => {
          const iso = d ? `${month}-${String(d).padStart(2, "0")}` : "";
          const items = d ? rows.filter((r) => r.due === iso) : [];
          return (
            <div key={i} className={clsx("min-h-20 rounded-lg border p-1", d ? "border-ivory-200 bg-white" : "border-transparent")}>
              {d && <p className="font-semibold text-navy-900">{d}</p>}
              {items.map((r) => <Link key={r.id} href={`/compliance/periods/${r.id}`} title={`${r.form} — ${r.entityName}`} className={clsx("mt-0.5 block truncate rounded px-1 text-[10.5px] font-semibold", r.status === "Overdue" ? "bg-red-600 text-white" : r.dueCertain ? "bg-navy-900 text-white" : "bg-amber-100 text-amber-900")}>{r.form.split(" ").slice(0, 3).join(" ")} · {r.entityName}{r.dueCertain ? "" : " (verify)"}</Link>)}
            </div>
          );
        })}
      </div>
      <p className="mt-2 text-xs text-slate-600">Amber items have due dates that need verification.</p>
    </Card>
  );
}
