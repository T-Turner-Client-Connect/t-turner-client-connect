import Link from "next/link";
import { connection } from "next/server";
import clsx from "clsx";
import { requireOwnerPage } from "@/lib/auth/owner";
import { bookkeepingStatus, OVERALL, type Overall } from "@/lib/services/bookkeeping-status";
import { bookkeepingQueueStatus } from "@/lib/services/bookkeeping-queue";
import { assignBookkeepingAction } from "@/app/actions/bookkeeping-queue";
import { ActionForm } from "@/components/action-form";
import { todayCentral } from "@/lib/services/ledger";

export const metadata = { title: "Office Files" };

const TONE: Record<Overall, string> = {
  Current: "bg-emerald-50 text-emerald-800",
  "In Progress": "bg-navy-100 text-navy-900",
  "Missing Documents": "bg-amber-50 text-amber-800",
  "Needs Attention": "bg-red-50 text-red-800",
  Overdue: "bg-red-100 text-red-900",
};

export default async function OfficeFilesPage() {
  await connection();
  const actor = await requireOwnerPage();
  const { through, clients } = await bookkeepingStatus(actor);
  const counts = OVERALL.map((o) => [o, clients.filter((c) => c.overall === o).length] as const);
  const queue = await bookkeepingQueueStatus(clients.map((c) => c.clientId));
  const t = todayCentral();
  const lastMonth = (() => { const [y, m] = t.split("-").map(Number); return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, "0")}`; })();
  const yearStart = `${lastMonth.slice(0, 4)}-01`;
  return (
    <div className="space-y-5">
      <header>
        <h1 className="font-serif text-2xl font-bold text-navy-900">Office Files</h1>
        <p className="text-sm text-slate-600">Your private files. Staff can&apos;t see this page.</p>
      </header>
      <section data-testid="bookkeeping-status">
        <h2 className="font-serif text-xl font-bold text-navy-900">Bookkeeping Clients Status</h2>
        <p className="mb-3 text-sm text-slate-600">Every bookkeeping client through {through}, read live from the books, uploads, reconciliations and Coetha&apos;s work. Missing items are only what isn&apos;t already in Client Connect. Click a client to open their workspace.</p>
        <ActionForm action={assignBookkeepingAction.bind(null, null)} className="mb-4 flex flex-wrap items-end gap-2 rounded-xl border border-gold-500/40 bg-gold-50 p-3" confirm="Assign these months to Coetha for every active bookkeeping client? She posts supported work under your standing authorization, holds exceptions, reconciles from the statements on file and prepares draft statements. Nothing is released to clients.">
          <p className="w-full text-sm font-semibold text-navy-900">Assign bookkeeping to Coetha — every client, month by month, in the background</p>
          <label className="text-xs">From<input className="input w-32" name="from" type="month" defaultValue={lastMonth} required /></label>
          <label className="text-xs">Through<input className="input w-32" name="to" type="month" defaultValue={lastMonth} required /></label>
          <button type="submit" className="rounded-lg bg-navy-900 px-4 py-2 text-sm font-semibold text-white" data-testid="assign-all">Assign to Coetha</button>
          <span className="text-xs text-slate-600">Months already assigned or done aren&apos;t queued again.</span>
        </ActionForm>
        <div className="mb-4 flex flex-wrap gap-2">
          {counts.map(([o, n]) => <span key={o} className={clsx("rounded-full px-3 py-1 text-sm font-semibold", TONE[o])}>{o}: {n}</span>)}
        </div>
        <div className="overflow-x-auto rounded-xl border border-ivory-200 bg-white">
          <table className="w-full min-w-[1100px] text-left text-sm">
            <thead className="bg-ivory-100 text-xs uppercase tracking-wide text-slate-600">
              <tr>
                <th className="p-3">Client</th>
                <th className="p-3">Status</th>
                <th className="p-3">Completed through</th>
                <th className="p-3">Working on</th>
                <th className="p-3">On file</th>
                <th className="p-3">Missing documents</th>
                <th className="p-3">Reconciliation</th>
                <th className="p-3">Coetha</th>
                <th className="p-3">Statements ready</th>
              </tr>
            </thead>
            <tbody>
              {clients.map((c) => (
                <tr key={c.clientId} className="border-t border-ivory-200 align-top" data-testid="status-row">
                  <td className="p-3">
                    <Link href={`/bookkeeping/${c.clientId}`} className="font-semibold text-navy-900 underline">{c.name}</Link>
                    <p className="text-xs text-slate-600">{[c.assignedTo ?? "Unassigned", c.schedule, c.payroll ? `Payroll: ${c.payroll}` : null].filter(Boolean).join(" · ")}</p>
                  </td>
                  <td className="p-3"><span className={clsx("whitespace-nowrap rounded-full px-2.5 py-0.5 text-xs font-semibold", TONE[c.overall])}>{c.overall}</span><p className="mt-1 text-xs text-slate-600">{c.why}</p></td>
                  <td className="p-3">{c.completedThrough ? <>{c.completedThrough}<p className="text-xs text-slate-500">{c.completedHow}</p></> : <span className="text-slate-500">None yet</span>}</td>
                  <td className="p-3">{c.workingOn ?? "—"}</td>
                  <td className="p-3 text-xs">{c.onFile.length ? c.onFile.map((f) => <p key={f}>{f}</p>) : <span className="text-slate-500">Nothing on file</span>}</td>
                  <td className="p-3 text-xs">
                    {c.uploads.length ? c.uploads.map((u) => <p key={u.what}><strong className="text-navy-900">{u.what}:</strong> {u.months.join(", ")}</p>) : <span className="text-emerald-700">Nothing missing</span>}
                    {c.uploadedNotEntered > 0 && <p className="text-slate-500">{c.uploadedNotEntered} uploaded, being entered</p>}
                  </td>
                  <td className="p-3 text-xs">{c.discrepancies.length ? c.discrepancies.map((d) => <p key={`${d.account}${d.month}`}>{d.account}, {d.month}: {d.detail}</p>) : <span className="text-emerald-700">No discrepancies</span>}</td>
                  <td className="p-3 text-xs">{(() => { const q = queue.get(c.clientId); return q && (q.working || q.waiting.length || q.done.length || q.failed.length) ? (
                    <div className="mb-1 rounded bg-ivory-100 p-1.5" data-testid="queue-state">
                      {q.working && <p className="font-semibold text-navy-900">Working on {q.working}</p>}
                      {q.waiting.length > 0 && <p>Queued: {q.waiting.join(", ")}</p>}
                      {q.done.length > 0 && <p className="text-emerald-700">Done: {q.done.join(", ")}</p>}
                      {q.failed.map((f, i) => <p key={i} className="text-red-700">{f.month ?? "A month"} stopped: {f.why}</p>)}
                      <Link className="underline" href={`/bookkeeping/${c.clientId}/coetha/ask?chat=c_bk-${c.clientId}`}>Exception report</Link>
                    </div>
                  ) : null; })()}
                  <ActionForm action={assignBookkeepingAction.bind(null, c.clientId)} className="mb-1 flex items-center gap-1" showSuccess={false}>
                    <input type="hidden" name="from" value={lastMonth} /><input type="hidden" name="to" value={lastMonth} />
                    <button type="submit" className="rounded border border-navy-900 px-2 py-0.5 text-xs font-semibold text-navy-900">Assign {lastMonth} to Coetha</button>
                  </ActionForm>
                  <p>{c.coetha}</p><p className="text-slate-600">Corrections: {c.corrections.posted} done · {c.corrections.waiting} outstanding</p></td>
                  <td className="p-3 text-xs">{c.ready.length ? c.ready.map((r) => <p key={r}>{r}</p>) : <span className="text-slate-500">—</span>}</td>
                </tr>
              ))}
              {!clients.length && <tr><td className="p-3 text-slate-600" colSpan={9}>No active bookkeeping clients.</td></tr>}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
