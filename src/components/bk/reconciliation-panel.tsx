import Link from "next/link";
import clsx from "clsx";
import { ListChecks, Scale, Sparkles } from "lucide-react";
import type { Actor } from "@/lib/auth/actor";
import { ActionForm } from "@/components/action-form";
import { card, Dot, goldBtn, Legend, navyBtn, outlineBtn } from "@/components/bk/parts";
import { monthlyAccountProgress, REC_LABEL, REGISTRY_TYPES, registryLabel } from "@/lib/services/bank-accounts";
import { canManageBanking, canViewBanking } from "@/lib/services/bk-permissions";
import { canApproveCoethaWork } from "@/lib/auth/permissions";
import { usd } from "@/lib/services/ledger";
import { workMonth } from "@/lib/services/bookkeeping-clients";
import { MONTH_NAMES } from "@/lib/bk-uploads";
import { approveReconciliationAction, postOpeningFromStatementAction, readAllStatementsAction, readStatementAction, runMonitorAction, statementBalancesAction } from "@/app/actions/bk-workflow";
import { cashProof } from "@/lib/services/cash-proof";

const STMT: Record<string, string> = { RECEIVED: "Statement received", REQUESTED: "Statement requested", MISSING: "Statement missing", NOT_NEEDED: "Not needed" };

/** "YYYY-MM" from a query string, or the current work month. */
export function reconMonth(raw?: string) {
  const wm = workMonth("MONTHLY");
  return raw && /^\d{4}-(0[1-9]|1[0-2])$/.test(raw) ? (raw.split("-").map(Number) as [number, number]) : ([wm.year, wm.month] as [number, number]);
}

/**
 * The month's bank reconciliation for one business, on the Ask Coetha page (it replaced the
 * separate Monthly Reconciliation page). Bank statements uploaded for an account are read
 * automatically, which fills in the balances and imports the transactions; Tabitha approves here.
 * Same permissions as before: viewing needs banking access, entering and reading need banking
 * edit access, approving and posting the opening balance are Tabitha's.
 */
export async function ReconciliationPanel({ user, clientId, month, pagePath }: { user: Actor; clientId: string; month?: string; pagePath: string }) {
  if (!(await canViewBanking(user, clientId))) return null;
  const base = `/bookkeeping/${clientId}`;
  const wm = workMonth("MONTHLY");
  const [y, m] = reconMonth(month);
  const [p, manage, owner] = await Promise.all([monthlyAccountProgress(user, clientId, y, m), canManageBanking(user, clientId), canApproveCoethaWork(user)]);
  const label = `${MONTH_NAMES[m - 1]} ${y}`;
  const proofs = await cashProof(user, clientId).catch(() => []);
  const months = Array.from({ length: 12 }, (_, i) => { const d = new Date(Date.UTC(wm.year, wm.month - 1 - i, 1)); return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`; });
  const needsYou = owner && p.awaitingApproval > 0;

  return (
    <section id="reconciliation" className={clsx(card, "scroll-mt-4 p-3 sm:p-4")} data-testid="reconciliation-page">
      <details open={!!month || needsYou || p.counts.RED > 0}>
        <summary className="flex cursor-pointer flex-wrap items-center gap-x-3 gap-y-1 font-serif text-lg font-bold text-navy-900">
          <ListChecks className="size-5 text-gold-600" aria-hidden /> Reconciliation — {label}
          <span className="font-sans text-sm font-semibold text-navy-800" data-testid="recon-count">{p.reconciled} of {p.total} accounts reconciled</span>
          <span className="flex flex-wrap gap-1.5 font-sans text-xs font-normal">{(["GREEN", "RED", "YELLOW", "GRAY"] as const).map((l) => <span key={l} className="flex items-center gap-1 rounded-full bg-ivory-100 px-2 py-0.5"><Dot light={l} />{p.counts[l]}</span>)}</span>
          {needsYou && <span className="rounded-full bg-gold-400 px-2 py-0.5 font-sans text-xs font-bold text-navy-950">{p.awaitingApproval} ready for your approval</span>}
        </summary>
        <div className="mt-3 space-y-3">
          <div className="flex flex-wrap items-end gap-2">
            <form method="get" action={pagePath} className="flex items-end gap-2">
              <select className="input w-auto" name="month" defaultValue={`${y}-${String(m).padStart(2, "0")}`} aria-label="Month">{months.map((x) => <option key={x} value={x}>{MONTH_NAMES[Number(x.slice(5)) - 1]} {x.slice(0, 4)}</option>)}</select>
              <button className={outlineBtn} type="submit">Go</button>
            </form>
            {manage && (
              <ActionForm action={runMonitorAction.bind(null, clientId, y, m)} idempotent>
                <button type="submit" className={goldBtn}><Sparkles className="size-4" aria-hidden /> Coetha: check this month</button>
              </ActionForm>
            )}
          </div>
          <p className="text-xs text-slate-600">Upload each bank statement on the <Link className="underline" href={`${base}/statements`}>upload page</Link> with its account: Coetha reads it automatically, fills in the balances and brings in the transactions. Work one month at a time. An account counts as reconciled only once Tabitha approves it.</p>
          <Legend />
      {proofs.map((pf) => (
        <details key={pf.ledgerAccountId} className="rounded-xl border border-ivory-200 bg-white p-3" open={!!pf.difference} data-testid="cash-proof">
          <summary className="flex cursor-pointer flex-wrap items-center gap-2 font-semibold text-navy-900"><Scale className="size-4 text-gold-600" aria-hidden /> Cash proof — {pf.account}, {pf.asOf} <span className={clsx("tabular-nums", pf.difference ? "text-red-700" : "text-emerald-700")}>{pf.difference ? `off by ${usd(pf.difference)}` : "proves out"}</span></summary>
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
            <p><strong>Beginning balance on file</strong> for {pf.openingMonth ?? "the first statement month"}: {pf.openingNeeded != null ? usd(pf.openingNeeded) : "none"} (entered here or read from the statement).</p>
            <p className="mt-0.5"><strong>Opening entry in the books:</strong> {pf.openingOnFile ? <>dated {pf.openingOnFile.date}: {pf.openingOnFile.lines.map((l) => `${l.account} ${l.debitCents ? `debit ${usd(l.debitCents)}` : `credit ${usd(l.creditCents)}`}`).join("; ")}{pf.openingElsewhere ? " — it does not include this bank account, so the bank balance doesn't reflect it." : ""}</> : "none. Entering a beginning balance here records the statement's balance; it doesn't post to the books."}</p>
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
        </details>
      ))}

      <div>
        <h3 className="flex items-center gap-2 font-semibold text-navy-900"><ListChecks className="size-4 text-gold-600" aria-hidden /> Every account</h3>
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
      </div>
        </div>
      </details>
    </section>
  );
}
