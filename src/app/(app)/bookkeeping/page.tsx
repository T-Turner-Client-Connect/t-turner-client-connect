import Link from "next/link";
import { connection } from "next/server";
import { ActionForm } from "@/components/action-form";
import { Badge, Button, Card, EmptyState, Field, LinkButton, PageHeader } from "@/components/ui";
import { openAllPeriodsAction, saveBookkeepingProfileAction } from "@/app/actions/bookkeeping-clients";
import { requireUser } from "@/lib/auth/session";
import { prisma } from "@/lib/prisma";
import { bookkeepingClients, FREQUENCIES, isReportApprover, PAYROLL_FREQUENCIES, periodLabel, REVIEW_LABELS, reportsAwaitingReview, STAGES, workMonth } from "@/lib/services/bookkeeping-clients";
import { REPORT_LABELS } from "@/lib/services/documents";
import { fmtDateTime } from "@/lib/format";

export const metadata = { title: "Bookkeeping Clients" };

type SP = { staff?: string; schedule?: string; missing?: string; overdue?: string; review?: string };

export default async function BookkeepingClientsPage({ searchParams }: { searchParams: Promise<SP> }) {
  await connection();
  const user = await requireUser();
  const sp = await searchParams;
  const filters = { assignedTo: sp.staff || null, frequency: sp.schedule || null, missing: sp.missing === "1", overdue: sp.overdue === "1", review: sp.review === "1" };
  const anyFilter = !!(filters.assignedTo || filters.frequency || filters.missing || filters.overdue || filters.review);
  const [rows, approver, awaiting, staff, suggested] = await Promise.all([
    bookkeepingClients(filters),
    isReportApprover(user),
    reportsAwaitingReview(),
    prisma.user.findMany({ where: { active: true }, select: { id: true, name: true }, orderBy: { name: "asc" } }),
    // Clients whose services mention bookkeeping but who aren't enrolled yet.
    prisma.client
      .findMany({ where: { archivedAt: null, OR: [{ bookkeepingProfile: null }, { bookkeepingProfile: { active: false } }] }, select: { id: true, displayName: true, services: true }, orderBy: { displayName: "asc" } })
      .then((cs) => cs.filter((c) => c.services.some((x) => /bookkeep/i.test(x)))),
  ]);
  const shown = rows;
  const monthly = workMonth("MONTHLY");

  return (
    <>
      <PageHeader
        title="Bookkeeping Clients"
        subtitle={`Monthly and quarterly bookkeeping. Current work month: ${periodLabel("MONTHLY", monthly.year, monthly.month)}.`}
        actions={
          <div className="flex flex-wrap items-start gap-2">
            <LinkButton href="/bookkeeping/new" data-testid="add-bk-client">+ Add Bookkeeping Client</LinkButton>
            <ActionForm action={openAllPeriodsAction} showSuccess>
              <Button type="submit" variant="secondary">Open this month for all clients</Button>
            </ActionForm>
          </div>
        }
      />

      {approver && awaiting.length > 0 && (
        <Card title={`Awaiting your review (${awaiting.length})`} className="mb-4">
          <ul className="divide-y divide-navy-100 text-sm" data-testid="awaiting-review">
            {awaiting.map((d) => (
              <li key={d.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <span><strong>{d.client.displayName}</strong> · {d.reportType ? REPORT_LABELS[d.reportType] : "Report"} · {d.period ? periodLabel("MONTHLY", d.period.year, d.period.month) : d.title} · submitted {d.submittedForReviewAt ? fmtDateTime(d.submittedForReviewAt) : ""}</span>
                <Link className="font-semibold underline" href={`/bookkeeping/${d.client.id}${d.period ? `?period=${d.period.id}` : ""}#reports`}>Review</Link>
              </li>
            ))}
          </ul>
        </Card>
      )}

      <form method="get" className="mb-3 flex flex-wrap items-end gap-3 rounded-2xl border border-ivory-200 bg-white p-3 text-sm shadow-sm" data-testid="bk-filters">
        <Field label="Assigned staff">
          <select className="input w-auto" name="staff" defaultValue={sp.staff ?? ""}>
            <option value="">Everyone</option>
            <option value={user.id}>Me ({user.name.split(" ")[0]})</option>
            {staff.filter((s) => s.id !== user.id).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            <option value="unassigned">Unassigned</option>
          </select>
        </Field>
        <Field label="Schedule">
          <select className="input w-auto" name="schedule" defaultValue={sp.schedule ?? ""}>
            <option value="">Monthly &amp; quarterly</option>
            {Object.entries(FREQUENCIES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
        </Field>
        <label className="flex items-center gap-2 pb-2"><input type="checkbox" name="missing" value="1" defaultChecked={filters.missing} /> Missing documents</label>
        <label className="flex items-center gap-2 pb-2"><input type="checkbox" name="overdue" value="1" defaultChecked={filters.overdue} /> Overdue work</label>
        <label className="flex items-center gap-2 pb-2"><input type="checkbox" name="review" value="1" defaultChecked={filters.review} /> Awaiting Tabitha&apos;s review</label>
        <Button type="submit" variant="secondary">Apply</Button>
        {anyFilter && <Link href="/bookkeeping" className="pb-2 underline">Clear</Link>}
        <span className="ml-auto pb-2 text-slate-600">{rows.length} client{rows.length === 1 ? "" : "s"}</span>
      </form>

      {shown.length === 0 ? (
        <EmptyState title={anyFilter ? "No bookkeeping clients match these filters" : "No bookkeeping clients yet"}>
          {anyFilter ? "Change or clear the filters." : <>Use <Link className="font-semibold underline" href="/bookkeeping/new">Add Bookkeeping Client</Link> to enroll an existing CRM client or create a new one.</>}
        </EmptyState>
      ) : (
        <div className="overflow-x-auto rounded-2xl border border-ivory-200 bg-white shadow-sm">
          <table className="w-full min-w-[960px] text-sm" data-testid="bk-table">
            <thead className="bg-ivory-50 text-left text-xs uppercase tracking-wide text-slate-500">
              <tr>
                <th className="px-4 py-3">Client</th>
                <th className="px-3 py-3">Assigned</th>
                <th className="px-3 py-3">Schedule</th>
                <th className="px-3 py-3">Payroll</th>
                <th className="px-3 py-3">Missing documents</th>
                <th className="px-3 py-3">Current period</th>
                <th className="px-3 py-3">Stage</th>
                <th className="px-3 py-3">Overdue</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-navy-100">
              {shown.map((r) => (
                <tr key={r.client.id} className="hover:bg-ivory-50" data-client={r.client.displayName}>
                  <td className="px-4 py-3">
                    <Link href={`/bookkeeping/${r.client.id}`} className="font-semibold text-navy-900 underline decoration-gold-500 underline-offset-4">{r.client.displayName}</Link>
                    {r.unread > 0 && <Badge tone="gold" className="ml-2">{r.unread} message{r.unread === 1 ? "" : "s"}</Badge>}
                  </td>
                  <td className="px-3 py-3">{r.client.assignedTo?.name ?? <span className="text-red-700">Unassigned</span>}</td>
                  <td className="px-3 py-3">{FREQUENCIES[r.profile.frequency as keyof typeof FREQUENCIES]}</td>
                  <td className="px-3 py-3">
                    {r.profile.payroll ? (
                      <>Yes{r.profile.payrollFrequency && ` · ${PAYROLL_FREQUENCIES[r.profile.payrollFrequency as keyof typeof PAYROLL_FREQUENCIES]}`}{r.profile.payrollProvider && <span className="block text-xs text-slate-500">{r.profile.payrollProvider}</span>}</>
                    ) : (
                      <span className="text-slate-500">No</span>
                    )}
                  </td>
                  <td className="px-3 py-3">{r.missing ? <Badge tone="amber">{r.missing} missing</Badge> : r.summary ? <Badge tone="green">None</Badge> : "—"}</td>
                  <td className="px-3 py-3">
                    <span className="font-medium">{r.workLabel}</span>
                    {!r.reportMonth && <span className="block text-xs text-slate-500">documents only — report at quarter end</span>}
                    {r.summary && (
                      <>
                        <span className="mt-1 block h-1.5 w-28 overflow-hidden rounded-full bg-ivory-200"><span className="block h-full bg-gold-500" style={{ width: `${r.summary.total ? Math.round((r.summary.done / r.summary.total) * 100) : 0}%` }} /></span>
                        <span className="text-xs text-slate-600">{r.summary.done} of {r.summary.total} checklist items{r.summary.reports.length > 0 && ` · ${r.summary.reports.length} report${r.summary.reports.length === 1 ? "" : "s"}`}</span>
                      </>
                    )}
                  </td>
                  <td className="px-3 py-3"><Badge tone={STAGES[r.stage].tone}>{STAGES[r.stage].label}</Badge>{r.awaitingReview && r.stage !== "AWAITING_REVIEW" && <Badge tone="gold" className="ml-1">Earlier month in review</Badge>}</td>
                  <td className="px-3 py-3">{r.overdue.length ? <span className="text-red-800">{r.overdue.join("; ")}</span> : !r.profile.documentsDueDay && !r.profile.reportsDueDay ? <span className="text-xs text-slate-500">No deadlines set</span> : <span className="text-slate-500">—</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {suggested.length > 0 && (
        <Card title="Suggested: clients with a bookkeeping service on file" className="mt-4">
          <ul className="flex flex-wrap gap-2 text-sm" data-testid="bk-suggested">
            {suggested.map((c) => (
              <li key={c.id}>
                <ActionForm action={saveBookkeepingProfileAction.bind(null, c.id)} className="inline">
                  <input type="hidden" name="frequency" value="MONTHLY" />
                  <Button type="submit" variant="secondary">+ {c.displayName}</Button>
                </ActionForm>
              </li>
            ))}
          </ul>
          <p className="mt-2 text-xs text-slate-600">Adds them as monthly with no payroll; open a client to change the schedule, assigned staff or payroll. For anyone else, use <Link className="underline" href="/bookkeeping/new">Add Bookkeeping Client</Link>.</p>
        </Card>
      )}

      <p className="mt-3 text-xs text-slate-600">
        Every client collects documents monthly; quarterly clients get reports at quarter end. Overdue uses each client&apos;s own document and report due days (set in the client&apos;s Service details); a client with no due day set is never marked overdue for it. Requested items use their own due dates.
        Reports go draft → {REVIEW_LABELS.AWAITING_REVIEW} → approved by Tabitha → delivered by staff. This workspace is separate from the Owner&apos;s Office.
      </p>
    </>
  );
}
