import { connection } from "next/server";
import { notFound } from "next/navigation";
import { requirePortalUser } from "@/lib/portal/session";
import { ActionForm } from "@/components/action-form";
import { Button } from "@/components/ui";
import { ApprovalSummary, DecisionForm } from "@/components/payroll/approval-summary";
import { dayOf, money, whenOf } from "@/components/payroll/status";
import { portalNotifyChannelAction, portalPayrollDecisionAction } from "@/app/actions/payroll-portal";
import { approverDashboard, approverRunView } from "@/lib/services/payroll-approval";
import { NOTIFY_CHANNELS } from "@/lib/payroll/fields";

export const metadata = { title: "Payroll Approval" };

/** Business owners designated as payroll approvers: review and approve or deny. Read-only otherwise. */
export default async function PayrollApprovalPage() {
  await connection();
  const user = await requirePortalUser();
  const dash = await approverDashboard(user.id);
  if (!dash.approvers.length) notFound();
  const views = await Promise.all(dash.pending.map((r) => approverRunView(user.id, r.clientId, r.id)));
  const nameOf = (clientId: string) => {
    const c = dash.approvers.find((a) => a.clientId === clientId)?.client;
    return c?.businessName || c?.displayName || "";
  };
  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <header>
        <h1 className="font-serif text-3xl font-bold text-navy-900">Payroll Approval</h1>
        <p className="mt-1 text-sm text-slate-700">Review each payroll before the office submits it. Your decision is recorded with your name and the time.</p>
      </header>

      {!views.length && <p className="rounded-2xl border border-navy-100 bg-white p-5 text-sm text-slate-700" data-testid="nothing-pending">Nothing is waiting for your approval right now. We&apos;ll send you a secure link when the next payroll is ready.</p>}

      {views.map((v) => (
        <section key={v.run.id} className="space-y-3" data-testid="pending-run">
          <h2 className="font-serif text-xl font-bold text-navy-900">{nameOf(v.run.clientId)} — pay date {dayOf(v.version.checkDate)} <span className="ml-1 inline-flex items-center rounded-md border border-navy-900 px-1.5 align-middle font-sans text-sm font-bold" data-testid="approval-version">v{v.version.number}</span></h2>
          {v.version.documentId && v.showDetail && (
            <a href={`/api/client/payroll-preview/${v.version.id}`} target="_blank" rel="noopener" className="inline-flex items-center gap-1.5 rounded-lg border border-navy-100 bg-white px-3 py-2 text-sm font-semibold text-navy-900 underline" data-testid="approval-preview-doc">
              Open ADP&apos;s payroll preview (PDF) for v{v.version.number}
            </a>
          )}
          <p className="text-xs text-slate-600">Your decision is recorded for version {v.version.number} exactly. If the office changes anything, it becomes a new version and asks you again.</p>
          <ApprovalSummary business={nameOf(v.run.clientId)} version={v.version} showDetail={v.showDetail} />
          {v.decisions.length > 0 && <p className="text-sm text-slate-700">So far: {v.decisions.map((d) => `${d.approverName} ${d.decision === "APPROVED" ? "approved" : "denied"}`).join(" · ")}</p>}
          {v.mine ? (
            <p className="rounded-xl bg-emerald-50 p-3 text-sm font-semibold text-emerald-800">You {v.mine.decision === "APPROVED" ? "approved" : "denied"} this payroll on {whenOf(v.mine.createdAt)}.</p>
          ) : (
            <DecisionForm action={portalPayrollDecisionAction.bind(null, v.run.clientId, v.run.id, v.version.id)} />
          )}
        </section>
      ))}

      <section className="grid gap-4 md:grid-cols-2">
        {dash.approvers.map((a) => {
          const ch = dash.channels.find((c) => c.clientId === a.clientId);
          return (
            <div key={a.id} className="rounded-2xl border border-navy-100 bg-white p-4" data-testid="notify-card">
              <h2 className="font-serif text-lg font-bold text-navy-900">How should we notify you?</h2>
              <p className="text-xs text-slate-600">{a.client.businessName || a.client.displayName} · payroll approval requests</p>
              <ActionForm action={portalNotifyChannelAction.bind(null, a.clientId)} className="mt-3 space-y-2">
                <div className="flex flex-wrap gap-3 text-sm">
                  {Object.entries(NOTIFY_CHANNELS).map(([k, label]) => (
                    <label key={k} className="flex items-center gap-1.5"><input type="radio" name="channel" value={k} defaultChecked={(a.notifyChannel ?? "BOTH") === k} /> {label}</label>
                  ))}
                </div>
                <Button type="submit" variant="secondary" className="py-1 text-xs">Save</Button>
              </ActionForm>
              {!a.notifyChannel && <p className="mt-2 text-xs text-slate-600">Default: email, plus a text when we have your permission to text you.</p>}
              {ch?.fallback && <p className="mt-2 rounded-lg bg-amber-50 p-2 text-xs text-amber-800">We&apos;ll email you instead of texting: {ch.fallback}</p>}
              {!ch?.fallback && ch?.smsBlocked && a.notifyChannel !== "EMAIL" && <p className="mt-2 text-xs text-slate-600">Texts aren&apos;t available right now ({ch.smsBlocked}) — you&apos;ll get email.</p>}
            </div>
          );
        })}
      </section>

      <section>
        <h2 className="font-serif text-xl font-bold text-navy-900">Your approval history</h2>
        {!dash.history.length ? <p className="text-sm text-slate-700">No decisions yet.</p> : (
          <ul className="mt-2 divide-y divide-navy-100 rounded-2xl border border-navy-100 bg-white text-sm" data-testid="approval-history">
            {dash.history.map((h) => (
              <li key={h.id} className="flex flex-wrap justify-between gap-2 px-4 py-2">
                <span><span className="font-semibold text-navy-900">{nameOf(h.clientId)}</span> · pay date {dayOf(h.version.checkDate)} · v{h.version.number} · {money(h.version.grossCents + h.version.employerTaxCents)}</span>
                <span className={h.decision === "APPROVED" ? "font-semibold text-emerald-700" : "font-semibold text-red-700"}>{h.decision === "APPROVED" ? "Approved" : "Denied"} · {whenOf(h.createdAt)}{h.channel !== "PORTAL" ? " · by secure link" : ""}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
