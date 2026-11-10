import Link from "next/link";
import clsx from "clsx";
import { connection } from "next/server";
import { notFound } from "next/navigation";
import { ListChecks, Sparkles , Scale } from "lucide-react";
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
import { approveReconciliationAction, postOpeningFromStatementAction, readAllStatementsAction, readStatementAction, runMonitorAction, statementBalancesAction } from "@/app/actions/bk-workflow";
import { cashProof } from "@/lib/services/cash-proof";

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
  const proofs = await cashProof(user, clientId).catch(() => []);
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

      {proofs.map((pf) => (
        <section key={pf.ledgerAccountId} className={clsx(card, "p-4 sm:p-5")} data-testid="cash-proof">
          <h2 className={h2}><Scale className="size-5 text-gold-600" aria-hidden /> Cash proof — {pf.account}, {pf.asOf}</h2>
          <p className="mt-1 text-sm text-navy-800">How the bank statement balance becomes the balance in the books, from this business&apos;s own records. Nothing here changes a number.</p>
          <table className="mt-2 w-full max-w-xl text-sm"><tbody>
            <tr><td className="py-0.5">Statement ending balance ({pf.asOf})</td><td className="text-right tabular-nums">{usd(pf.statementEnding)}</td></tr>
            <tr><td className="py-0.5">Less: bank activity not posted yet ({pf.waiting.count} row{pf.waiting.count === 1 ? "" : "s"} waiting for review)</td><td className="text-right tabular-nums">{usd(-pf.waiting.cents)}</td></tr>
            {pf.excluded.count > 0 && <tr><td className="py-0.5">Less: bank activity excluded from the books ({pf.excluded.count})</td><td className="text-right tabular-nums">{usd(-pf.excluded.cents)}</td></tr>}
            {pf.openingNeeded != null && pf.openingNeeded !== pf.openingPosted && <tr><td className="py-0.5">Less: opening balance not posted ({pf.openingMonth} statement begins at {usd(pf.openingNeeded)})</td><td className="text-right tabular-nums">{usd(-(pf.openingNeeded - pf.openingPosted))}</td></tr>}
            {pf.other !== 0 && <tr><td className="py-0.5">Plus: entries on this account that aren&apos;t bank rows (manual or adjusting)</td><td className="text-right tabular-nums">{usd(pf.other)}</td></tr>}
            <tr className="border-t border-navy-200 font-semibold"><td className="py-0.5">Expected balance in the books</td><td className="text-right tabular-nums">{usd(pf.expected)}</td></tr>
            <tr className="font-semibold"><td className="py-0.5">Balance in the books (posted entries)</td><td className="text-right tabular-nums">{usd(pf.ledger)}</td></tr>
            <tr className={clsx("font-semibold", pf.difference ? "text-red-700" : "text-emerald-700")}><td className="py-0.5">Unexplained difference</td><td className="text-right tabular-nums" data-testid="cash-proof-difference">{usd(pf.difference)}</td></tr>
          </tbody></table>
          {pf.coverageGap ? <p className="mt-2 text-sm text-red-800">The statements on file don&apos;t run continuously: starting from the first beginning balance and adding every bank row gives an ending balance that is off by {usd(pf.coverageGap)}. A statement may be missing or overlap.</p> : null}
          {pf.duplicateRows > 0 && <p className="mt-2 text-sm text-red-800">{pf.duplicateRows} bank row{pf.duplicateRows === 1 ? " is" : "s are"} posted more than once.</p>}
          <div className="mt-2 rounded-lg bg-ivory-50 p-2 text-xs text-navy-900 ring-1 ring-ivory-200" data-testid="cash-proof-opening">
            <p><strong>Beginning balance on file</strong> for {pf.openingMonth ?? "the first statement month"}: {pf.openingNeeded != null ? usd(pf.openingNeeded) : "none"} (from the reconciliation page or the statement itself).</p>
            <p className="mt-0.5"><strong>Opening entry in the books:</strong> {pf.openingOnFile ? <>dated {pf.openingOnFile.date}: {pf.openingOnFile.lines.map((l) => `${l.account} ${l.debitCents ? `debit ${usd(l.debitCents)}` : `credit ${usd(l.creditCents)}`}`).join("; ")}{pf.openingElsewhere ? " — it does not include this bank account, so the bank balance doesn't reflect it." : ""}</> : "none. Entering a beginning balance on the reconciliation page records the statement's balance; it doesn't post to the books."}</p>
          </div>
          {pf.openingElsewhere && owner && (
            <ActionForm action={postOpeningFromStatementAction.bind(null, clientId, pf.ledgerAccountId)} className="mt-3 flex flex-wrap items-center gap-2" confirm={`Record the opening balance ${usd(pf.openingNeeded ?? 0)} on this bank account with an adjusting entry dated ${pf.openingOnFile?.date}? The original opening entry stays as it is, in the history.`}>
              <span className="mr-auto text-sm text-navy-900">The opening entry was recorded on other accounts. Correct it using the {usd(pf.openingNeeded ?? 0)} already on file.</span>
              <button type="submit" className={navyBtn} data-testid="correct-opening">Correct the opening balance</button>
            </ActionForm>
          )}
          {pf.openingMissing && owner && (
            <ActionForm action={postOpeningFromStatementAction.bind(null, clientId, pf.ledgerAccountId)} className="mt-3 flex flex-wrap items-center gap-2" confirm={`Post the opening balance ${usd(pf.openingNeeded ?? 0)} on ${pf.openingMonth}-01, from the ${pf.openingMonth} statement's beginning balance? It's posted once and can only be corrected with an adjusting entry.`}>
              <span className="mr-auto text-sm text-navy-900">The books have no opening entry. Use the {usd(pf.openingNeeded ?? 0)} beginning balance already on file for {pf.openingMonth}; nothing to type again.</span>
              <button type="submit" className={navyBtn} data-testid="post-opening-from-statement">Post the opening balance on file ({usd(pf.openingNeeded ?? 0)})</button>
            </ActionForm>
          )}
        </section>
      ))}


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
                  {manage && rec?.statementDocumentId && rec.status !== "APPROVED" && (
                    <ActionForm action={readStatementAction.bind(null, clientId, rec.statementDocumentId)} className="w-full sm:w-auto">
                      <button type="submit" className={goldBtn} data-testid="read-statement"><Sparkles className="size-4" aria-hidden /> Read transactions from statement</button>
                    </ActionForm>
                  )}
                  {manage && (
                    <ActionForm action={readAllStatementsAction.bind(null, clientId, a.id)} className="flex flex-wrap items-center gap-2" confirm="Read every statement already on file for this account? Transactions already imported are skipped; nothing is posted until it's categorized.">
                      <button type="submit" className={outlineBtn} data-testid="read-all-statements">Read every statement on file</button>
                      <label className="flex items-center gap-1 text-xs text-slate-700"><input type="checkbox" name="postOpening" /> Also post opening cash from the earliest statement (only if no opening balance is posted yet)</label>
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
