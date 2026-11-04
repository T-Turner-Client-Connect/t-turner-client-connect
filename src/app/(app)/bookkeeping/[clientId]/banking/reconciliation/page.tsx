import Link from "next/link";
import clsx from "clsx";
import { connection } from "next/server";
import { notFound } from "next/navigation";
import { ListChecks, Sparkles } from "lucide-react";
import { requireUser } from "@/lib/auth/session";
import { prisma } from "@/lib/prisma";
import { ActionForm } from "@/components/action-form";
import { card, Dot, goldBtn, h2, Legend, navyBtn, outlineBtn } from "@/components/bk/parts";
import { monthlyAccountProgress, REC_LABEL, REGISTRY_TYPES, registryLabel } from "@/lib/services/bank-accounts";
import { canManageBanking, canViewBanking } from "@/lib/services/bk-permissions";
import { canApproveCoethaWork } from "@/lib/auth/permissions";
import { usd } from "@/lib/services/ledger";
import { workMonth } from "@/lib/services/bookkeeping-clients";
import { MONTH_NAMES } from "@/lib/bk-uploads";
import { approveReconciliationAction, runMonitorAction, statementBalancesAction } from "@/app/actions/bk-workflow";

export const metadata = { title: "Monthly Reconciliation" };

const STMT: Record<string, string> = { RECEIVED: "Statement received", REQUESTED: "Statement requested", MISSING: "Statement missing", NOT_NEEDED: "Not needed" };

export default async function ReconciliationPage({ params, searchParams }: { params: Promise<{ clientId: string }>; searchParams: Promise<{ month?: string }> }) {
  await connection();
  const user = await requireUser();
  const { clientId } = await params;
  const sp = await searchParams;
  const client = await prisma.client.findUnique({ where: { id: clientId }, select: { displayName: true, businessName: true } });
  if (!client) notFound();
  const biz = client.businessName || client.displayName;
  const base = `/bookkeeping/${clientId}`;
  if (!(await canViewBanking(user, clientId))) return <div className={clsx(card, "p-6 text-navy-900")}>Only Admins, the staff member assigned to {biz} and staff Tabitha allows can see its reconciliations.</div>;
  const wm = workMonth("MONTHLY");
  const [y, m] = sp.month && /^\d{4}-(0[1-9]|1[0-2])$/.test(sp.month) ? sp.month.split("-").map(Number) : [wm.year, wm.month];
  const [p, manage, owner] = await Promise.all([monthlyAccountProgress(user, clientId, y, m), canManageBanking(user, clientId), canApproveCoethaWork(user)]);
  const label = `${MONTH_NAMES[m - 1]} ${y}`;
  const months = Array.from({ length: 12 }, (_, i) => { const d = new Date(Date.UTC(wm.year, wm.month - 1 - i, 1)); return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`; });

  return (
    <div className="space-y-5" data-testid="reconciliation-page">
      <p className="text-sm"><Link className="underline" href={`${base}/banking`}>← Banking &amp; Credit Card Connections</Link></p>
      <section className="rounded-2xl bg-gradient-to-br from-navy-900 via-navy-950 to-navy-900 px-5 py-5 text-white ring-1 ring-gold-500/40 sm:px-7">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="text-xs uppercase tracking-[0.2em] text-gold-300">{biz}</p>
            <h1 className="mt-1 font-serif text-2xl font-bold text-white">Monthly Reconciliation — {label}</h1>
            <p className="mt-1 text-lg font-semibold text-gold-300" data-testid="recon-count">{p.reconciled} of {p.total} accounts reconciled</p>
            <p className="text-sm text-navy-100">{p.awaitingApproval} balanced and awaiting Tabitha&apos;s approval · Coetha prepares each one and flags exceptions; an account counts as reconciled only once Tabitha approves it.</p>
          </div>
          <form method="get" className="flex items-end gap-2 text-navy-900">
            <select className="input w-auto" name="month" defaultValue={`${y}-${String(m).padStart(2, "0")}`} aria-label="Month">{months.map((x) => <option key={x} value={x}>{MONTH_NAMES[Number(x.slice(5)) - 1]} {x.slice(0, 4)}</option>)}</select>
            <button className="rounded-lg bg-white px-3 py-2 text-sm font-semibold" type="submit">Go</button>
          </form>
        </div>
        <div className="mt-3 flex flex-wrap gap-2 text-sm">
          {(["GREEN", "RED", "YELLOW", "GRAY"] as const).map((l) => <span key={l} className="flex items-center gap-1.5 rounded-full bg-white/10 px-3 py-1"><Dot light={l} />{p.counts[l]}</span>)}
        </div>
        {manage && (
          <ActionForm action={runMonitorAction.bind(null, clientId, y, m)} className="mt-3" idempotent>
            <button type="submit" className={goldBtn}><Sparkles className="size-4" aria-hidden /> Coetha: check this month</button>
          </ActionForm>
        )}
      </section>
      <Legend />

      <section className={clsx(card, "p-4 sm:p-5")}>
        <h2 className={h2}><ListChecks className="size-5 text-gold-600" aria-hidden /> Every account</h2>
        {!p.rows.length ? <p className="mt-2 text-sm text-slate-600">No accounts registered. <Link className="underline" href={`${base}/banking#manage`}>Add accounts</Link>.</p> : (
          <ul className="mt-3 space-y-3">
            {p.rows.map(({ account: a, rec, light }) => (
              <li key={a.id} className="rounded-xl border border-ivory-200 bg-white p-3" data-testid="recon-row" data-light={light}>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="flex items-center gap-2 font-semibold text-navy-900"><Dot light={light} />{registryLabel(a)} <span className="text-xs font-normal text-slate-600">{REGISTRY_TYPES[a.accountType as keyof typeof REGISTRY_TYPES]?.label}{a.subCards.length ? ` · ${a.subCards.length} employee card${a.subCards.length === 1 ? "" : "s"}` : ""}</span></p>
                  <span className="text-sm text-navy-800">{rec ? REC_LABEL[rec.status] : "Not prepared"}</span>
                </div>
                {rec && (
                  <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-sm sm:grid-cols-4">
                    <div><dt className="text-xs text-slate-600">Statement closing</dt><dd>{rec.statementClosingDate?.toISOString().slice(0, 10) ?? "—"}</dd></div>
                    <div><dt className="text-xs text-slate-600">Beginning balance</dt><dd className="tabular-nums">{rec.beginningBalanceCents != null ? usd(rec.beginningBalanceCents) : "—"}</dd></div>
                    <div><dt className="text-xs text-slate-600">Ending balance</dt><dd className="tabular-nums">{rec.endingBalanceCents != null ? usd(rec.endingBalanceCents) : "—"}</dd></div>
                    <div><dt className="text-xs text-slate-600">Difference</dt><dd className={clsx("tabular-nums font-semibold", rec.differenceCents ? "text-red-700" : "text-emerald-700")}>{rec.differenceCents != null ? usd(rec.differenceCents) : "—"}</dd></div>
                    <div><dt className="text-xs text-slate-600">Transactions imported</dt><dd>{rec.transactionsImported}</dd></div>
                    <div><dt className="text-xs text-slate-600">{a.accountType === "CHECKING" || a.accountType === "SAVINGS" ? "Deposits & credits" : "Payments & credits"}</dt><dd className="tabular-nums">{usd(rec.paymentsCreditsCents)}</dd></div>
                    <div><dt className="text-xs text-slate-600">Unmatched</dt><dd>{rec.unmatchedCount}</dd></div>
                    <div><dt className="text-xs text-slate-600">Statement</dt><dd>{STMT[rec.statementStatus] ?? rec.statementStatus}</dd></div>
                  </dl>
                )}
                {rec && rec.exceptions.length > 0 && <ul className="mt-2 space-y-0.5 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-900">{rec.exceptions.map((e, i) => <li key={i}>{e}</li>)}</ul>}
                <div className="mt-2 flex flex-wrap items-end gap-2">
                  {manage && rec && rec.status !== "APPROVED" && rec.status !== "NOT_DUE" && (
                    <ActionForm action={statementBalancesAction.bind(null, clientId, a.id, y, m)} className="flex flex-wrap items-end gap-2" showSuccess={false}>
                      {rec.beginningBalanceCents == null && <label className="text-xs">Beginning<input className="input w-28 py-1" name="beginning" inputMode="decimal" /></label>}
                      <label className="text-xs">Statement ending balance<input className="input w-32 py-1" name="ending" inputMode="decimal" defaultValue={rec.endingBalanceCents != null ? (rec.endingBalanceCents / 100).toFixed(2) : ""} required /></label>
                      <button type="submit" className={outlineBtn}>Save</button>
                    </ActionForm>
                  )}
                  {owner && rec?.status === "READY" && (
                    <ActionForm action={approveReconciliationAction.bind(null, clientId, rec.id)} confirm="Approve this reconciliation? The books are recorded as reconciled through the statement date." showSuccess={false}>
                      <button type="submit" className={navyBtn} data-testid="approve-recon">Approve</button>
                    </ActionForm>
                  )}
                  {!owner && rec?.status === "READY" && <span className="text-xs text-slate-600">Waiting for Tabitha&apos;s approval.</span>}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
