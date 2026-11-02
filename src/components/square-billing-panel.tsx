import Link from "next/link";
import { ActionForm } from "@/components/action-form";
import { Badge, Button, Field } from "@/components/ui";
import { SquareFindPanel } from "@/components/square-find-panel";
import { SquareAutoRefresh } from "@/components/square-auto-refresh";
import {
  addToSquareBillingAction, removeFromSquareBillingAction, setSquareExpectedAction, syncSquareBillingAction, verifySquareAuthorizationAction,
} from "@/app/actions/square-billing";
import { nameOf, NOT_SYNCED, paymentStatus, scheduleText, staleness, syncDue, type squareBillingFor } from "@/lib/services/square-billing";
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

/** Staff view of a client's existing Square recurring billing (read-only link). */
export function SquareBillingPanel({ clientId, sb, approver, addable, client, autoSuggest = false, initialQuery }: { clientId: string; sb: SB; approver: boolean; addable: { id: string; displayName: string; businessName?: string | null }[]; client: { name: string; email: string | null; phone: string | null }; autoSuggest?: boolean; initialQuery?: string }) {
  const a = sb.arrangement;
  return (
    <div className="space-y-3 rounded-xl border border-ivory-200 p-3" data-testid="square-billing">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <strong>Square recurring billing</strong>
        <SquareStateBadge state={sb.state} />
      </div>
      {!a ? (
        <div className="space-y-2 text-sm">
          {sb.state === "NOT_SYNCED" ? (
            <p>This client already pays through recurring billing in Square. Their amount, schedule and authorization stay exactly as set up there — nothing will be charged or re-authorized from Client Connect.</p>
          ) : (
            <p className="text-slate-600">Not marked as billed through Square.</p>
          )}
          <div className="flex flex-wrap gap-2">
            <SquareFindPanel autoSuggest={autoSuggest} initialQuery={initialQuery} client={{ id: clientId, ...client }} coverOptions={[{ id: clientId, name: client.name }, ...addable.filter((c) => c.id !== clientId).map((c) => ({ id: c.id, name: nameOf(c) }))]} />
            <ActionForm action={setSquareExpectedAction.bind(null, clientId, sb.state !== "NOT_SYNCED")} showSuccess>
              <Button type="submit" variant="ghost">{sb.state === "NOT_SYNCED" ? "Not billed through Square" : "Mark as billed through Square"}</Button>
            </ActionForm>
          </div>
        </div>
      ) : (
        <>
          <SquareAutoRefresh arrangementId={a.id} due={syncDue(a)} />
          {staleness(a).stale && (
            <p className="rounded bg-amber-50 p-2 text-sm text-amber-900" data-testid="square-stale" role="alert">
              ⚠ Last verified figures — may be out of date. {staleness(a).reason} {a.syncedAt ? `Last successful sync: ${fmtDateTime(a.syncedAt)}.` : ""}
              {a.syncError && <span className="block text-xs">Last problem: {a.syncError}</span>}
            </p>
          )}
          <dl className="grid gap-3 text-sm sm:grid-cols-2" data-testid="square-identity">
            <div><dt className="text-xs uppercase tracking-wide text-slate-500">Square customer (verified)</dt><dd><strong>{a.companyName || a.customerName || "Square customer"}</strong>{a.companyName && a.customerName ? ` · ${a.customerName}` : ""}<span className="block text-xs text-slate-600" data-testid="square-customer-id-value">Customer ID {a.squareCustomerId} · confirmed {fmtDate(a.createdAt)}</span></dd></div>
            <div><dt className="text-xs uppercase tracking-wide text-slate-500">Recurring invoice series</dt><dd data-testid="square-series-value"><strong>{a.seriesKey}</strong>{a.title ? ` · ${a.title}` : ""}<span className="block text-xs text-slate-600">Invoice numbers {a.seriesKey}-R-… · {a.invoiceCount} invoice{a.invoiceCount === 1 ? "" : "s"} in Square</span></dd></div>
          </dl>
          <dl className="grid gap-3 text-sm sm:grid-cols-3" data-testid="square-details">
            <div><dt className="text-xs uppercase tracking-wide text-slate-500">Recurring amount</dt><dd className="font-semibold">{usd(a.amountCents)}</dd></div>
            <div><dt className="text-xs uppercase tracking-wide text-slate-500">Billing schedule</dt><dd>{a.syncedAt ? scheduleText(a) : "—"}</dd></div>
            <div><dt className="text-xs uppercase tracking-wide text-slate-500">Next scheduled invoice</dt><dd>{a.nextDueDate ? <>{fmtDate(a.nextDueDate)} <span className="text-xs text-slate-600">· scheduled, not yet due{a.autopay ? " · Square charges the card on file" : " · client pays the invoice"}</span></> : "None scheduled in Square"}</dd></div>
            <div><dt className="text-xs uppercase tracking-wide text-slate-500">Last payment</dt><dd>{a.lastPaidDueDate ? <>{usd(a.lastPaidCents)} <span className="text-xs text-slate-600">· invoice due {fmtDate(a.lastPaidDueDate)}, paid in Square</span></> : "No paid invoice in this series"}</dd></div>
            <div><dt className="text-xs uppercase tracking-wide text-slate-500">Payment status (Square)</dt><dd>{a.syncedAt ? <Badge tone={paymentStatus(a).tone}>{paymentStatus(a).label}</Badge> : "—"}</dd></div>
            <div><dt className="text-xs uppercase tracking-wide text-slate-500">Card on file</dt><dd>{a.cardLast4 ? `${a.cardBrand ?? "Card"} ****${a.cardLast4} · exp ${a.cardExpMonth}/${a.cardExpYear}` : a.autopay ? "On file in Square" : "No automatic payment"}</dd></div>
            <div data-testid="square-outstanding"><dt className="text-xs uppercase tracking-wide text-slate-500">Unpaid, not yet overdue</dt><dd>{a.outstandingCount == null ? "—" : usd((a.outstandingCents ?? 0) - (a.overdueCents ?? 0))}<span className="text-xs text-slate-600"> {a.outstandingCount != null ? `(${(a.outstandingCount ?? 0) - (a.overdueCount ?? 0)} invoice${(a.outstandingCount ?? 0) - (a.overdueCount ?? 0) === 1 ? "" : "s"})` : ""}</span></dd></div>
            <div data-testid="square-overdue"><dt className="text-xs uppercase tracking-wide text-slate-500">Overdue</dt><dd className={a.overdueCount ? "font-semibold text-red-700" : ""}>{a.overdueCount == null ? "—" : `${usd(a.overdueCents)} (${a.overdueCount} invoice${a.overdueCount === 1 ? "" : "s"})`}</dd></div>
            <div data-testid="square-failed"><dt className="text-xs uppercase tracking-wide text-slate-500">Failed payments</dt><dd className={a.failedCount ? "font-semibold text-red-700" : ""}>{a.failedCount == null ? "—" : a.failedCount === 0 ? "None reported by Square" : `${a.failedCount} reported by Square`}</dd></div>
          </dl>
          <p className="text-xs text-slate-600">Balances cover all of this customer&apos;s invoices at the location. Scheduled invoices aren&apos;t counted as owed until their due date passes.</p>
          <p className="text-sm" data-testid="square-covers">
            <strong>One bill covers:</strong> {a.members.map((m) => nameOf(m.client)).join(", ")}
            {a.members.length > 1 && <span className="text-slate-600"> — one invoice and one payment per cycle, never split or charged twice.</span>}
          </p>
          <p className="text-xs text-slate-600" data-testid="square-last-sync">
            {a.syncedAt ? `Last successful sync from Square: ${fmtDateTime(a.syncedAt)} (read only, refreshed hourly).` : "Not synced yet."}
          </p>
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
          <div className="flex flex-wrap items-end gap-2">
            <ActionForm action={syncSquareBillingAction.bind(null, a.id)} showSuccess><Button type="submit" variant="secondary" data-testid="square-refresh">Refresh From Square</Button></ActionForm>
            {addable.length > 0 && (
              <ActionForm action={addToSquareBillingAction.bind(null, a.id)} className="flex flex-wrap items-end gap-2" showSuccess>
                <Field label="Also covered by this bill"><select className="input" name="clientId" defaultValue=""><option value="">Choose a business…</option>{addable.map((c) => <option key={c.id} value={c.id}>{nameOf(c)}</option>)}</select></Field>
                <Button type="submit" variant="ghost">Add to this bill</Button>
              </ActionForm>
            )}
          </div>
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
        </>
      )}
    </div>
  );
}
