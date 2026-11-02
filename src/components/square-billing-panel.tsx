import Link from "next/link";
import { ActionForm } from "@/components/action-form";
import { Badge, Button, Field } from "@/components/ui";
import { SquareFindPanel } from "@/components/square-find-panel";
import { SquareAutoRefresh } from "@/components/square-auto-refresh";
import {
  addToSquareBillingAction, removeFromSquareBillingAction, setSquareExpectedAction, syncSquareBillingAction, verifySquareAuthorizationAction,
} from "@/app/actions/square-billing";
import { CADENCE_LABELS, nameOf, NOT_SYNCED, paymentStatus, scheduleText, staleness, syncDue, type SeriesInvoice, type squareBillingFor } from "@/lib/services/square-billing";
import type { ActionState } from "@/lib/action";
import type { squareHealth } from "@/lib/services/square-health";
import { fmtDate, fmtDateTime } from "@/lib/format";

type SB = Awaited<ReturnType<typeof squareBillingFor>>;
type Health = Awaited<ReturnType<typeof squareHealth>>;

/** The real connection state: a live check, not just "the settings are filled in". */
export function SquareConnectionStatus({ health, lastSuccessfulSync }: { health: Health; lastSuccessfulSync?: Date | null }) {
  const last = health.last;
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-xl bg-ivory-50 p-3 text-sm" data-testid="square-connection" data-state={health.state}>
      <strong>Square connection:</strong>
      {health.state === "WORKING" ? <Badge tone="green">Working</Badge>
        : health.state === "FAILING" ? <Badge tone="red">Not working</Badge>
        : health.state === "UNCHECKED" ? <Badge tone="amber">Set up — not yet verified</Badge>
        : <Badge tone="gray">Not set up</Badge>}
      <span className="text-slate-600">
        {health.state === "WORKING" && last ? `Square ${health.env} accepted the token on ${fmtDateTime(last.checkedAt)}.`
          : health.state === "FAILING" && last ? `${last.summary} (${fmtDateTime(last.checkedAt)})`
          : health.state === "UNCHECKED" ? "The Netlify settings are present, but no live check has confirmed Square accepts them."
          : "Square isn't configured, so nothing is read from Square."}
        {lastSuccessfulSync ? ` Last successful sync: ${fmtDateTime(lastSuccessfulSync)}.` : ""}
      </span>
      <Link className="underline" href="/bookkeeping/square-billing#connection">Check connection</Link>
    </div>
  );
}
const usd = (c: number | null | undefined) => (c == null ? "—" : `$${(c / 100).toLocaleString("en-US", { minimumFractionDigits: 2 })}`);

export function SquareStateBadge({ state }: { state: SB["state"] }) {
  return (
    <span data-testid="square-state">
      {state === "VERIFIED" ? <Badge tone="green">Existing Square authorization — verified</Badge>
        : state === "SYNCED" ? <Badge tone="amber">Synced from Square — authorization not yet verified</Badge>
        : state === "LINKED" ? <Badge tone="amber">Linked — waiting for first sync</Badge>
        : state === "NOT_SYNCED" ? <Badge tone="amber">{NOT_SYNCED}</Badge>
        : <Badge tone="gray">No Square billing on record</Badge>}
    </span>
  );
}

type Inv = SeriesInvoice;
const INV_TONE: Record<string, "green" | "amber" | "red" | "gray" | "navy"> = { PAID: "green", SCHEDULED: "navy", UNPAID: "amber", PARTIALLY_PAID: "amber", PAYMENT_PENDING: "amber", FAILED: "red", CANCELED: "gray", REFUNDED: "gray", PARTIALLY_REFUNDED: "gray" };
const INV_LABEL: Record<string, string> = { PAID: "Paid", SCHEDULED: "Scheduled", UNPAID: "Unpaid", PARTIALLY_PAID: "Partly paid", PAYMENT_PENDING: "Pending", FAILED: "Failed", CANCELED: "Canceled", REFUNDED: "Refunded", PARTIALLY_REFUNDED: "Partly refunded" };
const ymd = (d: string) => fmtDate(new Date(`${d}T12:00:00Z`));
const squareCustomerUrl = (env: string, id: string) => `https://app.${env === "production" ? "squareup" : "squareupsandbox"}.com/dashboard/customers/directory/customer/${encodeURIComponent(id)}`;
const Check = ({ ok, children }: { ok: boolean; children: React.ReactNode }) => (
  <li className="flex items-center gap-2"><span aria-hidden className={`grid size-5 place-items-center rounded-full text-xs font-bold text-white ${ok ? "bg-emerald-600" : "bg-slate-400"}`}>{ok ? "✓" : "–"}</span><span className={ok ? "" : "text-slate-500"}>{children}</span></li>
);

/** Staff view of a client's Square recurring billing (read only — nothing is changed in Square). */
export function SquareBillingPanel({ clientId, sb, approver, addable, client, autoSuggest = false, initialQuery, health, notes, notesAction }: { clientId: string; sb: SB; approver: boolean; addable: { id: string; displayName: string; businessName?: string | null }[]; client: { name: string; email: string | null; phone: string | null }; autoSuggest?: boolean; initialQuery?: string; health?: Health | null; notes?: string | null; notesAction?: (prev: ActionState, fd: FormData) => Promise<ActionState> }) {
  const a = sb.arrangement;
  const reviewList = sb.review.length > 0 && (
    <div className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm" data-testid="square-review-linked">
      <p className="font-semibold text-amber-900">Status needs review — not shown as current billing</p>
      <ul className="mt-1 space-y-1 text-amber-950">
        {sb.review.map((e) => <li key={e.id}>Series {e.seriesKey}{e.title ? ` · ${e.title}` : ""} · {usd(e.amountCents)} — {e.endedReason}</li>)}
      </ul>
      <p className="mt-1 text-xs">Square shows no scheduled or open invoice, which alone doesn&apos;t prove it ended. {approver ? "Decide it in Find and link (search the series number)." : "Tabitha reviews it."}</p>
    </div>
  );
  const endedHistory = sb.ended.length > 0 && (
    <details className="rounded-lg border border-dashed border-slate-300 p-2 text-xs text-slate-600" data-testid="square-ended-history">
      <summary className="cursor-pointer">Ended Square billing — history only ({sb.ended.length})</summary>
      <ul className="mt-1 space-y-1">
        {sb.ended.map((e) => (
          <li key={e.id}><Badge tone="gray">Ended</Badge> Series {e.seriesKey}{e.title ? ` · ${e.title}` : ""} · {usd(e.amountCents)}{e.lastDueDate ? ` · last invoice due ${fmtDate(e.lastDueDate)}` : ""}<span className="block">{e.endedReason}</span></li>
        ))}
      </ul>
      <p className="mt-1">Not included in current billing or totals. Its invoices and payments stay in Square&apos;s history; nothing was changed in Square.</p>
    </details>
  );
  if (!a) {
    return (
      <div className="space-y-3 rounded-xl border border-ivory-200 p-3" data-testid="square-billing">
        <div className="flex flex-wrap items-center gap-2 text-sm"><strong>Square recurring billing</strong><SquareStateBadge state={sb.state} /></div>
        <div className="space-y-2 text-sm">
          {sb.state === "NOT_SYNCED" ? (
            <p>This client already pays through recurring billing in Square. Their amount, schedule and authorization stay exactly as set up there — nothing will be charged or re-authorized from Client Connect.</p>
          ) : (
            <p className="text-slate-600">Not marked as billed through Square.</p>
          )}
          <div className="flex flex-wrap gap-2">
            <SquareFindPanel owner={approver} autoSuggest={autoSuggest} initialQuery={initialQuery} client={{ id: clientId, ...client }} coverOptions={[{ id: clientId, name: client.name }, ...addable.filter((c) => c.id !== clientId).map((c) => ({ id: c.id, name: nameOf(c) }))]} />
            <ActionForm action={setSquareExpectedAction.bind(null, clientId, sb.state !== "NOT_SYNCED")} showSuccess>
              <Button type="submit" variant="ghost">{sb.state === "NOT_SYNCED" ? "Not billed through Square" : "Mark as billed through Square"}</Button>
            </ActionForm>
          </div>
        </div>
        {reviewList}
        {endedHistory}
      </div>
    );
  }
  const st = staleness(a);
  const status = paymentStatus(a);
  // Every invoice in THIS series, newest first; the next scheduled one is shown separately above.
  const invs = ((a.seriesInvoices as Inv[] | null) ?? []).filter((i) => i.status !== "SCHEDULED");
  const owed = (a.outstandingCents ?? 0) - (a.overdueCents ?? 0);
  return (
    <div className="space-y-4" data-testid="square-billing">
      <SquareAutoRefresh arrangementId={a.id} due={syncDue(a)} />
      {/* Header: Billing & Payments, live connection, Sync Now */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <span aria-hidden className="grid size-12 place-items-center rounded-xl border-2 border-gold-500 text-2xl text-gold-600">▭</span>
          <div>
            <h3 className="font-serif text-2xl font-bold text-navy-900">Billing &amp; Payments</h3>
            <p className="text-sm font-medium text-gold-700">Square Integration – {health?.env === "production" ? "Live" : "Sandbox (test)"}</p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex items-center gap-2 rounded-xl border border-ivory-200 bg-white px-3 py-2 shadow-sm" data-testid="square-connection-pill">
            <span aria-hidden className="grid size-8 place-items-center rounded-md bg-navy-950 text-white">■</span>
            <div className="text-sm leading-tight">
              <p className="font-semibold text-navy-900">
                {health?.state === "WORKING" ? <>Connected to Square <span className="text-emerald-600">✓</span></> : health?.state === "FAILING" ? <span className="text-red-700">Square connection not working</span> : "Square — connection not yet verified"}
              </p>
              <p className="text-slate-600">{a.syncedAt ? `Last Sync: ${fmtDateTime(a.syncedAt)}` : "Not synced yet"}</p>
            </div>
          </div>
          <ActionForm action={syncSquareBillingAction.bind(null, a.id)} showSuccess>
            <Button type="submit" variant="gold" data-testid="square-refresh">↻ Sync Now</Button>
          </ActionForm>
        </div>
      </div>
      {st.stale && (
        <p className="rounded bg-amber-50 p-2 text-sm text-amber-900" data-testid="square-stale" role="alert">
          ⚠ Last verified figures — may be out of date. {st.reason} {a.syncedAt ? `Last successful sync: ${fmtDateTime(a.syncedAt)}.` : ""}
          {a.syncError && <span className="block text-xs">Last problem: {a.syncError}</span>}
        </p>
      )}
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
        <div className="space-y-4">
          {/* Active Recurring Billing */}
          <div>
            <span className="relative z-10 ml-4 inline-block rounded-t-lg bg-gold-500 px-4 py-1 text-sm font-bold text-navy-950">Active Recurring Billing</span>
            <div className="overflow-hidden rounded-2xl border-2 border-gold-500 bg-navy-950 text-white shadow" data-testid="square-active-card">
              <div className="flex flex-wrap items-start justify-between gap-3 p-5">
                <div data-testid="square-series-value">
                  <p className="text-xl font-bold">Series {a.seriesKey}</p>
                  <p className="text-sm text-slate-200">{a.title || "Recurring invoice"}</p>
                  <p className="mt-1 font-serif text-4xl font-bold text-gold-300" data-testid="square-amount">{usd(a.amountCents)}</p>
                  <p className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-sm text-slate-100">
                    <span>↻ {CADENCE_LABELS[(a.cadence ?? "UNKNOWN") as keyof typeof CADENCE_LABELS] ?? "Recurring"}</span>
                    <span>{a.dueDay ? `▦ Due on the ${scheduleText({ cadence: null, dueDay: a.dueDay }).replace(/^.*due on the /, "")}` : ""}</span>
                    <span>{a.autopay ? "▭ Card on File" : "Client pays each invoice"}</span>
                  </p>
                </div>
                <span className="rounded-full border border-emerald-400 bg-emerald-600/20 px-3 py-1 text-sm font-semibold text-emerald-300">✓ Active</span>
              </div>
              <div className="grid divide-y divide-white/15 border-t border-white/15 sm:grid-cols-3 sm:divide-x sm:divide-y-0" data-testid="square-details">
                <div className="p-4"><p className="text-sm text-slate-300">Next Invoice</p><p className="text-xl font-bold">{a.nextDueDate ? fmtDate(a.nextDueDate) : "None scheduled"}</p><p className="text-xs text-slate-400">Scheduled, not yet due</p></div>
                <div className="p-4"><p className="text-sm text-slate-300">Status</p><p className={`text-lg font-bold ${status.tone === "green" ? "text-emerald-300" : status.tone === "red" ? "text-red-300" : "text-gold-300"}`}>{a.syncedAt ? status.label : "—"}</p></div>
                <div className="p-4"><p className="text-sm text-slate-300">Last Payment</p><p className="text-xl font-bold">{a.lastPaidDueDate ? fmtDate(a.lastPaidDueDate) : "—"}</p><p className="text-sm text-slate-200">{a.lastPaidDueDate ? usd(a.lastPaidCents) : "No paid invoice yet"}</p></div>
              </div>
              <div className="grid grid-cols-3 gap-2 border-t border-white/15 px-4 py-2 text-xs text-slate-300">
                <span data-testid="square-outstanding">Unpaid, not yet overdue: <strong className="text-white">{usd(owed)}</strong></span>
                <span data-testid="square-overdue">Overdue: <strong className={a.overdueCount ? "text-red-300" : "text-white"}>{usd(a.overdueCents)}{a.overdueCount ? ` (${a.overdueCount})` : ""}</strong></span>
                <span data-testid="square-failed">Failed payments: <strong className={a.failedCount ? "text-red-300" : "text-white"}>{a.failedCount ?? 0}</strong></span>
              </div>
            </div>
          </div>
          {/* Payment History — this series only */}
          <div className="rounded-2xl border border-ivory-200 bg-white p-4 shadow-sm" data-testid="square-payment-history">
            <p className="mb-2 text-lg font-bold text-navy-900">▦ Payment History <span className="text-sm font-normal text-slate-600">— Series {a.seriesKey} only · {invs.length} invoice{invs.length === 1 ? "" : "s"}</span></p>
            {invs.length === 0 ? <p className="text-sm text-slate-600">No invoices yet in this series.</p> : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead><tr className="bg-navy-950 text-left text-white"><th className="rounded-l-md px-3 py-1.5">Due date</th><th className="px-3">Invoice</th><th className="px-3 text-right">Amount</th><th className="px-3">Paid on</th><th className="px-3 text-center">Status</th><th className="rounded-r-md px-3">Receipt</th></tr></thead>
                  <tbody className="divide-y divide-ivory-200">
                    {invs.map((i) => (
                      <tr key={i.id} data-invoice={i.number ?? i.id}>
                        <td className="px-3 py-2">{ymd(i.due)}</td>
                        <td className="px-3">{i.number ?? "—"}<span className="block text-xs text-slate-500">{i.title || "Recurring invoice"}</span></td>
                        <td className="px-3 text-right">{usd(i.amountCents)}{i.status === "PARTIALLY_PAID" && <span className="block text-xs text-slate-500">{usd(i.paidCents)} paid · {usd((i.amountCents ?? 0) - (i.paidCents ?? 0))} due</span>}</td>
                        <td className="px-3">{i.status === "PAID" ? (i.paidAt ? ymd(i.paidAt) : <span className="text-xs text-slate-500">Paid — date not provided by Square</span>) : "—"}</td>
                        <td className="px-3 text-center"><Badge tone={INV_TONE[i.status] ?? "gray"}>{INV_LABEL[i.status] ?? i.status}</Badge></td>
                        <td className="px-3">{i.status === "PAID" && i.receiptUrl ? <a className="underline" href={i.receiptUrl} target="_blank" rel="noopener noreferrer">Receipt ↗</a> : i.invoiceUrl ? <a className="underline" href={i.invoiceUrl} target="_blank" rel="noopener noreferrer">Invoice ↗</a> : "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <p className="mt-2 text-xs text-slate-500">From Square, read only. “Paid” appears only when Square marks the invoice paid; the paid date and receipt come from Square&apos;s payment record. Other series of this customer aren&apos;t included.</p>
          </div>
        </div>
        <div className="space-y-4">
          {/* Square Customer */}
          <div className="rounded-2xl border border-ivory-200 bg-white p-4 shadow-sm" data-testid="square-identity">
            <div className="flex items-center justify-between gap-2"><p className="text-lg font-bold text-navy-900">■ Square Customer</p><Badge tone="green">Verified</Badge></div>
            <p className="mt-2 text-lg font-bold text-navy-900">{a.companyName || a.customerName || "Square customer"}</p>
            {a.companyName && a.customerName && <p className="text-sm text-slate-700">{a.customerName}</p>}
            <p className="text-sm" data-testid="square-customer-id-value">Customer ID: {a.squareCustomerId}</p>
            <p className="text-xs text-slate-500">Confirmed {fmtDate(a.createdAt)}</p>
            <ul className="mt-3 space-y-1.5 text-sm">
              <Check ok>Recurring Billing Active</Check>
              <Check ok={!!a.cardLast4 || a.autopay}>{a.cardLast4 ? `Card on File (${a.cardBrand ?? "Card"} ****${a.cardLast4})` : "Card on File"}</Check>
              <Check ok={a.autopay}>Auto-Pay Enabled</Check>
            </ul>
            <a className="mt-3 inline-flex rounded-xl border-2 border-gold-500 bg-navy-950 px-4 py-2 text-sm font-semibold text-white" href={squareCustomerUrl(health?.env ?? "production", a.squareCustomerId)} target="_blank" rel="noopener noreferrer">View in Square ↗</a>
          </div>
          {/* Billing Notes */}
          <div className="rounded-2xl border border-ivory-200 bg-ivory-50 p-4 shadow-sm" data-testid="billing-notes">
            <p className="text-lg font-bold text-navy-900">✎ Billing Notes</p>
            <p className="mt-2 whitespace-pre-line text-sm text-slate-800">{notes || `${usd(a.amountCents)} ${CADENCE_LABELS[(a.cadence ?? "UNKNOWN") as keyof typeof CADENCE_LABELS] ?? ""} · Billed through Square${a.autopay ? " – Auto-Pay" : ""}`}</p>
            {!notes && <p className="text-xs text-slate-500">Summary from Square. Add your own note below.</p>}
            {notesAction && (
              <details className="mt-2 text-sm">
                <summary className="cursor-pointer font-semibold text-navy-900 underline">Edit</summary>
                <ActionForm action={notesAction} className="mt-2 space-y-2" showSuccess>
                  <textarea className="input min-h-20 w-full" name="notes" defaultValue={notes ?? ""} aria-label="Billing notes" />
                  <Button type="submit" variant="secondary">Save notes</Button>
                </ActionForm>
              </details>
            )}
          </div>
        </div>
      </div>
      <p className="text-sm" data-testid="square-covers">
        <strong>One bill covers:</strong> {a.members.map((m) => nameOf(m.client)).join(", ")}
        {a.members.length > 1 && <span className="text-slate-600"> — one invoice and one payment per cycle, never split or charged twice.</span>}
      </p>
      <p className="text-xs text-slate-600" data-testid="square-last-sync">{a.syncedAt ? `Last successful sync from Square: ${fmtDateTime(a.syncedAt)} (read only, refreshed hourly).` : "Not synced yet."} Balances cover this series only; scheduled invoices aren&apos;t owed until due.</p>
      {a.authorizationVerifiedAt ? (
        <p className="text-sm text-emerald-800">✓ Existing authorization verified by Tabitha on {fmtDate(a.authorizationVerifiedAt)}{a.authorizationNote ? ` — ${a.authorizationNote}` : ""}.</p>
      ) : approver ? (
        <ActionForm action={verifySquareAuthorizationAction.bind(null, a.id)} className="flex flex-wrap items-end gap-2" showSuccess>
          <Field label="How you verified the existing authorization"><input className="input w-80" name="note" placeholder="e.g. Card-on-file authorization in Square Dashboard" /></Field>
          <Button type="submit" variant="secondary">Verify existing authorization</Button>
        </ActionForm>
      ) : (
        <p className="text-sm text-slate-600">Tabitha verifies the existing Square authorization.</p>
      )}
      {addable.length > 0 && (
        <ActionForm action={addToSquareBillingAction.bind(null, a.id)} className="flex flex-wrap items-end gap-2" showSuccess>
          <Field label="Also covered by this bill"><select className="input" name="clientId" defaultValue=""><option value="">Choose a business…</option>{addable.map((c) => <option key={c.id} value={c.id}>{nameOf(c)}</option>)}</select></Field>
          <Button type="submit" variant="ghost">Add to this bill</Button>
        </ActionForm>
      )}
      {approver && (
        <details className="text-sm">
          <summary className="cursor-pointer underline" data-testid="square-correct">Wrong match? Remove this client from the link</summary>
          <p className="mt-2 text-xs text-slate-600">Removes the link and its verified customer ID from this client in Client Connect only, with your reason in the audit history. Billing in Square continues unchanged. Then use Find and link to choose the right customer.</p>
          <ActionForm action={removeFromSquareBillingAction.bind(null, a.id, clientId)} className="mt-2 flex flex-wrap items-end gap-2" confirm="Remove the link in Client Connect? Billing in Square continues unchanged.">
            <input className="input w-72" name="reason" placeholder="Why? e.g. Wrong Square customer — verified with client" aria-label="Reason" />
            <Button type="submit" variant="ghost">Remove link</Button>
          </ActionForm>
        </details>
      )}
      {reviewList}
      {endedHistory}
    </div>
  );
}
