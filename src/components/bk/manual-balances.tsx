import clsx from "clsx";
import Link from "next/link";
import { Archive, ClipboardPen, ExternalLink, History, Plus } from "lucide-react";
import { ActionForm } from "@/components/action-form";
import { card, h2, navyBtn, outlineBtn } from "@/components/bk/parts";
import { archiveManualAccountAction, createManualAccountAction, enterManualBalanceAction, updateManualAccountLinksAction } from "@/app/actions/manual-bank";
import { BALANCE_SOURCES, MANUAL_KINDS, MANUAL_STALE_DAYS, type manualAccountsForStaff } from "@/lib/services/manual-bank";
import { usd } from "@/lib/services/ledger";
import { fmtDateTime } from "@/lib/format";
import { fmtChicago, utcToChicagoLocal } from "@/lib/tz";

type Rows = Awaited<ReturnType<typeof manualAccountsForStaff>>;

/**
 * Banking page → "Balances entered by our office": until a Plaid feed is live, staff who can see
 * the client's bank record each account's balance; the client's dashboard shows the cash total.
 * Notes stay in the office. History is append-only: a correction is a new entry.
 */
type GlChoice = { id: string; label: string; linkedTo: string | null };

/** shownToClient: ids of our accounts whose figure the client's dashboard uses (bank-feed.ts chooseSources). */
export function ManualBalancesSection({ clientId, rows, canEdit, plaidConnected, ledgerChoices = [], shownToClient, now = new Date() }: { clientId: string; rows: Rows; canEdit: boolean; plaidConnected: boolean; ledgerChoices?: GlChoice[]; shownToClient?: Set<string>; now?: Date }) {
  const nowLocal = utcToChicagoLocal(now);
  const active = rows.filter((r) => !r.archivedAt);
  const archived = rows.filter((r) => r.archivedAt);
  const staleMs = MANUAL_STALE_DAYS * 86_400_000;
  return (
    <section className={clsx(card, "scroll-mt-6 p-4 sm:p-5")} id="manual-balances" data-testid="manual-balances">
      <h2 className={h2}><ClipboardPen className="size-5 text-gold-600" aria-hidden /> Balances entered by our office <span className="rounded-full bg-navy-900 px-2.5 py-0.5 font-sans text-xs font-semibold text-gold-300">{active.length}</span></h2>
      <p className="mt-1 text-sm text-navy-800">
        Until the bank feed is connected, look up each balance at the bank and enter it here. The client&apos;s dashboard shows the checking and savings total as &ldquo;Updated by our office&rdquo;, and &ldquo;Not current&rdquo; after {MANUAL_STALE_DAYS} days. Notes are for the office only. Never enter usernames, passwords, security answers or full account numbers.
      </p>
      {plaidConnected && <p className="mt-2 rounded-lg bg-navy-50 px-3 py-2 text-sm text-navy-900" data-testid="manual-plaid-note">This business also has a bank feed. Each account is counted once: when one of these is the same account as a bank-feed account (same GL account, or same institution and last 4), the dashboard uses the bank feed while it&apos;s current — unless you set its balance source to Office-entered.</p>}
      <p className="mt-1 flex flex-wrap gap-x-4 text-xs"><Link className="underline" href="/bookkeeping/balances">Enter today&apos;s balances for every business →</Link><Link className="underline" href="/bookkeeping/morning-pull">Morning bank pull →</Link></p>
      <p className="mt-1 text-xs text-slate-600">Bank sign-ins are kept in the firm&apos;s password manager, never in Client Connect.</p>

      {!active.length ? (
        <p className="mt-3 text-sm text-slate-600" data-testid="manual-none">No accounts yet.{canEdit ? " Add one below." : ""}</p>
      ) : (
        <ul className="mt-3 divide-y divide-ivory-200" data-testid="manual-accounts">
          {active.map((a) => {
            const stale = a.latest && now.getTime() - a.latest.asOf.getTime() > staleMs;
            return (
              <li key={a.id} className="py-3" data-testid="manual-account">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="font-semibold text-navy-900">{a.name}{a.last4 && <span className="ml-1 font-normal text-navy-800">••{a.last4}</span>}</p>
                    <p className="text-xs text-slate-600">{[a.institution, MANUAL_KINDS[a.kind] ?? a.kind, a.kind === "CREDIT_CARD" ? "not counted as cash" : null, a.ledgerAccountId ? `GL ${ledgerChoices.find((l) => l.id === a.ledgerAccountId)?.label ?? "linked"}` : null].filter(Boolean).join(" · ")}</p>
                    {shownToClient && a.latest && <p className={clsx("text-xs", shownToClient.has(a.id) ? "text-emerald-800" : "text-navy-800")} data-testid="manual-shown">{shownToClient.has(a.id) ? "Client's dashboard shows this balance" : "Client's dashboard shows the bank feed for this account"}{a.balanceSource === "OFFICE" ? " · source: Office-entered" : ""}</p>}
                    {a.signInUrl && <a href={a.signInUrl} target="_blank" rel="noopener noreferrer" className="mt-0.5 inline-flex items-center gap-1 text-xs font-semibold text-navy-900 underline"><ExternalLink className="size-3.5" aria-hidden /> Open bank site</a>}
                  </div>
                  <div className="text-right">
                    <p className="font-serif text-lg font-bold text-navy-900" data-testid="manual-latest">{a.latest ? usd(a.latest.balanceCents) : "—"}</p>
                    <p className={clsx("text-xs", stale ? "font-semibold text-amber-800" : "text-slate-600")}>{a.latest ? `${stale ? "Not current · " : ""}as of ${a.latest.source === "BANK_FILE" ? fmtChicago(a.latest.asOf, { month: "short", day: "numeric", year: "numeric" }) + " (bank file)" : fmtDateTime(a.latest.asOf)} · ${a.latest.enteredBy}` : "No balance entered yet"}</p>
                  </div>
                </div>
                {canEdit && (
                  <ActionForm action={enterManualBalanceAction.bind(null, clientId, a.id)} className="mt-2 grid gap-2 rounded-xl bg-ivory-50 p-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,1.5fr)_auto] sm:items-end" resetOnSuccess idempotent>
                    <label className="text-sm">Balance<input className="input mt-1" name="amount" inputMode="decimal" required placeholder="e.g. 12,480.55" aria-label={`Balance for ${a.name}`} /></label>
                    <label className="text-sm">As of (Central)<input className="input mt-1" type="datetime-local" name="asOf" defaultValue={nowLocal} /></label>
                    <label className="text-sm">Note (office only)<input className="input mt-1" name="note" maxLength={500} placeholder="Optional" /></label>
                    <button type="submit" className={navyBtn}>Enter balance</button>
                  </ActionForm>
                )}
                {a.history.length > 0 && (
                  <details className="mt-2 text-sm" data-testid="manual-history">
                    <summary className="flex cursor-pointer items-center gap-1.5 font-semibold text-navy-900"><History className="size-4 text-gold-600" aria-hidden /> History ({a.history.length})</summary>
                    <ul className="mt-2 space-y-2">
                      {a.history.map((b) => (
                        <li key={b.id} className={clsx("rounded-lg border border-ivory-200 bg-white px-3 py-2", b.corrected && "opacity-70")}>
                          <div className="flex flex-wrap items-baseline justify-between gap-2">
                            <span className={clsx("font-semibold text-navy-900", b.corrected && "line-through")}>{usd(b.balanceCents)}{b.source === "BANK_FILE" && <span className="ml-2 rounded-full bg-navy-50 px-2 py-0.5 text-xs font-semibold text-navy-800 no-underline">Bank file</span>}</span>
                            <span className="text-xs text-slate-600">as of {b.source === "BANK_FILE" ? fmtChicago(b.asOf, { month: "short", day: "numeric", year: "numeric" }) : fmtDateTime(b.asOf)} · entered {fmtDateTime(b.enteredAt)} by {b.enteredBy}</span>
                          </div>
                          {(b.note || b.correctsId || b.corrected) && <p className="text-xs text-navy-800">{[b.correctsId ? "Correction of an earlier entry" : null, b.corrected ? "Corrected by a later entry" : null, b.note ? `Note: ${b.note}` : null].filter(Boolean).join(" · ")}</p>}
                          {canEdit && !b.corrected && (
                            <details className="mt-1">
                              <summary className="cursor-pointer text-xs font-semibold text-navy-900 underline">Correct this entry</summary>
                              <ActionForm action={enterManualBalanceAction.bind(null, clientId, a.id)} className="mt-2 grid gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,1.5fr)_auto] sm:items-end" idempotent>
                                <input type="hidden" name="correctsId" value={b.id} />
                                <label className="text-xs">Correct balance<input className="input mt-1" name="amount" inputMode="decimal" required /></label>
                                <label className="text-xs">As of (Central)<input className="input mt-1" type="datetime-local" name="asOf" defaultValue={utcToChicagoLocal(b.asOf)} /></label>
                                <label className="text-xs">Why (office only)<input className="input mt-1" name="note" maxLength={500} placeholder="e.g. typo" /></label>
                                <button type="submit" className={outlineBtn}>Save correction</button>
                              </ActionForm>
                            </details>
                          )}
                        </li>
                      ))}
                    </ul>
                  </details>
                )}
                {canEdit && (
                  <details className="mt-2 text-sm">
                    <summary className="cursor-pointer text-xs font-semibold text-navy-900 underline">Bank sign-in page, GL link &amp; balance source</summary>
                    <ActionForm action={updateManualAccountLinksAction.bind(null, clientId, a.id)} className="mt-2 grid gap-2 sm:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_auto] sm:items-end">
                      <label className="text-xs">Bank&apos;s sign-in page (https)<input className="input mt-1" name="signInUrl" type="url" inputMode="url" defaultValue={a.signInUrl ?? ""} placeholder="https://www.pretendbank.example/sign-in" /></label>
                      <label className="text-xs">GL account for CSV imports
                        <select className="input mt-1" name="ledgerAccountId" defaultValue={a.ledgerAccountId ?? ""}>
                          <option value="">Not linked</option>
                          {ledgerChoices.filter((l) => !l.linkedTo || l.linkedTo === a.id).map((l) => <option key={l.id} value={l.id}>{l.label}</option>)}
                        </select>
                      </label>
                      <label className="text-xs sm:col-span-2">Balance source on the client&apos;s dashboard
                        <select className="input mt-1" name="balanceSource" defaultValue={a.balanceSource}>{Object.entries(BALANCE_SOURCES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
                      </label>
                      <button type="submit" className={outlineBtn}>Save</button>
                    </ActionForm>
                  </details>
                )}
                {canEdit && (
                  <ActionForm action={archiveManualAccountAction.bind(null, clientId, a.id)} className="mt-2" showSuccess={false} confirm={`Archive ${a.name}? It stops counting toward the client's bank balance; its history is kept.`}>
                    <button type="submit" className="inline-flex items-center gap-1 text-xs font-semibold text-navy-800 underline"><Archive className="size-3.5" aria-hidden /> Archive account</button>
                  </ActionForm>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {canEdit && (
        <details className="mt-3 rounded-xl border border-gold-300 bg-ivory-50 p-3" open={!active.length} data-testid="manual-add">
          <summary className="flex cursor-pointer items-center gap-1.5 text-sm font-semibold text-navy-900"><Plus className="size-4 text-gold-600" aria-hidden /> Add account</summary>
          <ActionForm action={createManualAccountAction.bind(null, clientId)} className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4" resetOnSuccess>
            <label className="text-sm">Name<input className="input mt-1" name="name" required maxLength={80} placeholder="e.g. Operating checking" /></label>
            <label className="text-sm">Institution<input className="input mt-1" name="institution" maxLength={120} placeholder="e.g. Pretend National Bank" /></label>
            <label className="text-sm">Type<select className="input mt-1" name="kind" defaultValue="CHECKING">{Object.entries(MANUAL_KINDS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
            <label className="text-sm">Last 4 digits (optional)<input className="input mt-1" name="last4" inputMode="numeric" maxLength={4} pattern="\d{4}" placeholder="1234" /></label>
            <label className="text-sm sm:col-span-2">Bank&apos;s sign-in page (optional, https)<input className="input mt-1" name="signInUrl" type="url" inputMode="url" placeholder="https://www.pretendbank.example/sign-in" /></label>
            <label className="text-sm sm:col-span-2">GL account for CSV imports (optional)
              <select className="input mt-1" name="ledgerAccountId" defaultValue=""><option value="">Not linked</option>{ledgerChoices.filter((l) => !l.linkedTo).map((l) => <option key={l.id} value={l.id}>{l.label}</option>)}</select>
            </label>
            <div className="sm:col-span-2 lg:col-span-4"><button type="submit" className={navyBtn}>Add account</button></div>
          </ActionForm>
        </details>
      )}

      {archived.length > 0 && (
        <details className="mt-3 text-sm" data-testid="manual-archived">
          <summary className="cursor-pointer font-semibold text-navy-900">Archived ({archived.length})</summary>
          <ul className="mt-2 space-y-1 text-navy-800">
            {archived.map((a) => <li key={a.id}>{a.name}{a.last4 ? ` ••${a.last4}` : ""} · archived {fmtDateTime(a.archivedAt)} · last {a.latest ? `${usd(a.latest.balanceCents)} as of ${fmtDateTime(a.latest.asOf)}` : "—"}</li>)}
          </ul>
        </details>
      )}
    </section>
  );
}
