import { ActionForm } from "@/components/action-form";
import { Badge, Button, Field, LinkButton } from "@/components/ui";
import {
  addToSquareBillingAction, removeFromSquareBillingAction, setSquareExpectedAction, syncSquareBillingAction, verifySquareAuthorizationAction,
} from "@/app/actions/square-billing";
import { nameOf, NOT_SYNCED, paymentStatus, scheduleText, type squareBillingFor } from "@/lib/services/square-billing";
import { fmtDate, fmtDateTime } from "@/lib/format";

type SB = Awaited<ReturnType<typeof squareBillingFor>>;
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
export function SquareBillingPanel({ clientId, sb, approver, addable }: { clientId: string; sb: SB; approver: boolean; addable: { id: string; displayName: string; businessName?: string | null }[] }) {
  const a = sb.arrangement;
  return (
    <div className="space-y-3 rounded-xl border border-ivory-200 p-3" data-testid="square-billing">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <strong>Existing Square recurring billing</strong>
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
            <LinkButton variant="secondary" href={`/bookkeeping/square-billing?client=${clientId}`} data-testid="connect-square">Find and link in Square</LinkButton>
            <ActionForm action={setSquareExpectedAction.bind(null, clientId, sb.state !== "NOT_SYNCED")} showSuccess>
              <Button type="submit" variant="ghost">{sb.state === "NOT_SYNCED" ? "Not billed through Square" : "Mark as billed through Square"}</Button>
            </ActionForm>
          </div>
        </div>
      ) : (
        <>
          <dl className="grid gap-3 text-sm sm:grid-cols-3" data-testid="square-details">
            <div><dt className="text-xs uppercase tracking-wide text-slate-500">Amount (from Square)</dt><dd className="font-semibold">{usd(a.amountCents)}</dd></div>
            <div><dt className="text-xs uppercase tracking-wide text-slate-500">Schedule</dt><dd>{a.syncedAt ? scheduleText(a) : "—"}</dd></div>
            <div><dt className="text-xs uppercase tracking-wide text-slate-500">Next invoice</dt><dd>{a.nextDueDate ? `${fmtDate(a.nextDueDate)}${a.autopay ? " · charged automatically by Square" : " · client pays the invoice"}` : "None scheduled in Square"}</dd></div>
            <div><dt className="text-xs uppercase tracking-wide text-slate-500">Payment status</dt><dd>{a.syncedAt ? <Badge tone={paymentStatus(a).tone}>{paymentStatus(a).label}</Badge> : "—"}</dd></div>
            <div><dt className="text-xs uppercase tracking-wide text-slate-500">Card on file (from Square)</dt><dd>{a.cardLast4 ? `${a.cardBrand ?? "Card"} ****${a.cardLast4} · exp ${a.cardExpMonth}/${a.cardExpYear}` : a.autopay ? "On file in Square" : "No automatic payment"}</dd></div>
            <div><dt className="text-xs uppercase tracking-wide text-slate-500">Square series</dt><dd>{a.title ? `${a.title} · ` : ""}{a.seriesKey}-R · {a.invoiceCount} invoice{a.invoiceCount === 1 ? "" : "s"}</dd></div>
          </dl>
          <p className="text-sm" data-testid="square-covers">
            <strong>One bill covers:</strong> {a.members.map((m) => nameOf(m.client)).join(", ")}
            {a.members.length > 1 && <span className="text-slate-600"> — one invoice and one payment per cycle, never split or charged twice.</span>}
          </p>
          <p className="text-xs text-slate-600">
            {a.syncedAt ? `Last synced ${fmtDateTime(a.syncedAt)} (read only).` : "Not synced yet."}
            {a.syncError && <span className="ml-1 text-red-700">Last sync problem: {a.syncError}</span>}
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
            <ActionForm action={syncSquareBillingAction.bind(null, a.id)} showSuccess><Button type="submit" variant="secondary">Sync now</Button></ActionForm>
            {addable.length > 0 && (
              <ActionForm action={addToSquareBillingAction.bind(null, a.id)} className="flex flex-wrap items-end gap-2" showSuccess>
                <Field label="Also covered by this bill"><select className="input" name="clientId" defaultValue=""><option value="">Choose a business…</option>{addable.map((c) => <option key={c.id} value={c.id}>{nameOf(c)}</option>)}</select></Field>
                <Button type="submit" variant="ghost">Add to this bill</Button>
              </ActionForm>
            )}
          </div>
          {approver && (
            <details className="text-sm">
              <summary className="cursor-pointer underline">Remove this client from the link</summary>
              <ActionForm action={removeFromSquareBillingAction.bind(null, a.id, clientId)} className="mt-2 flex flex-wrap items-end gap-2" confirm="Remove the link in Client Connect? Billing in Square continues unchanged.">
                <input className="input w-72" name="reason" placeholder="Why?" aria-label="Reason" />
                <Button type="submit" variant="ghost">Remove link</Button>
              </ActionForm>
            </details>
          )}
        </>
      )}
    </div>
  );
}
