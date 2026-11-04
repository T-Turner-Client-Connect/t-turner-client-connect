import Link from "next/link";
import { notFound } from "next/navigation";
import { ActionForm } from "@/components/action-form";
import { Badge, Button, Card, Field, Notice, PageHeader } from "@/components/ui";
import { applySquarePaymentAction, dismissSquarePaymentAction, reconcileNowAction } from "@/app/actions/square-invoicing";
import { requireOwner } from "@/lib/auth/owner";
import { canReconcile } from "@/lib/auth/billing-permissions";
import { SQUARE_STATUS_LABELS, squareReconcileView, squareSendingState } from "@/lib/services/square-invoicing";
import { ymd } from "@/lib/services/owner-billing";
import { money } from "@/lib/billing/pricing";
import { METHOD_LABELS } from "@/lib/billing/labels";
import { fmtDateTime } from "@/lib/format";

export const metadata = { title: "Reconcile Square payments" };

/** Square payments matched to our invoices, and the ones staff need to look at. */
export default async function ReconcilePage() {
  const { actor } = await requireOwner("billing");
  if (!(await canReconcile(actor))) notFound();
  const [v, sending] = await Promise.all([squareReconcileView(actor), squareSendingState()]);
  return (
    <>
      <PageHeader
        title="Reconcile Square payments"
        subtitle="Payments made through Square on invoices we sent, recorded automatically — and any Square payment we couldn't match, for review."
        actions={
          <ActionForm action={reconcileNowAction}>
            <Button type="submit" variant="secondary" data-testid="reconcile-now">Check Square now</Button>
          </ActionForm>
        }
      />
      <div className="mb-4 grid gap-3 sm:grid-cols-3" data-testid="reconcile-status">
        <div className="rounded-xl border border-ivory-200 bg-white px-4 py-3 text-sm">
          <p className="text-xs font-semibold uppercase tracking-widest text-gold-700">Square notifications</p>
          <p className="mt-1 text-navy-900">{sending.webhookKeySet ? <Badge tone="green">Signature key set</Badge> : <Badge tone="amber">Not set up</Badge>}</p>
          <p className="mt-1 text-xs text-slate-600">{v.lastEvent ? `Last received ${fmtDateTime(v.lastEvent.at)} (${v.lastEvent.type})` : "None received yet."}</p>
        </div>
        <div className="rounded-xl border border-ivory-200 bg-white px-4 py-3 text-sm">
          <p className="text-xs font-semibold uppercase tracking-widest text-gold-700">Hourly check</p>
          <p className="mt-1 text-navy-900">{v.lastRun ? fmtDateTime(v.lastRun.at) : "Not run yet"}</p>
          <p className="mt-1 text-xs text-slate-600">{v.lastRun?.details ? `${v.lastRun.details.checked ?? 0} invoice(s) checked · ${v.lastRun.details.newPayments ?? 0} payment(s) caught` : "Catches any payment a notification missed."}</p>
        </div>
        <div className="rounded-xl border border-ivory-200 bg-white px-4 py-3 text-sm">
          <p className="text-xs font-semibold uppercase tracking-widest text-gold-700">Needs review</p>
          <p className="mt-1 font-serif text-2xl font-bold text-navy-900">{v.review.length}</p>
          <p className="mt-1 text-xs text-slate-600">{v.recurring} recurring-billing payment(s) and {v.dismissed} reviewed payment(s) not shown.</p>
        </div>
      </div>

      {v.attention.length > 0 && (
        <Card title="Square invoices that need attention" className="mb-4">
          <ul className="divide-y divide-navy-100 text-sm" data-testid="square-attention">
            {v.attention.map((a) => (
              <li key={a.id} className="flex flex-wrap items-start justify-between gap-2 py-2">
                <span><Link className="font-semibold underline" href={`/owner/invoices/${a.id}`}>{a.number}</Link> · {a.client.displayName} · {SQUARE_STATUS_LABELS[a.squareStatus ?? ""] ?? a.squareStatus ?? "—"}</span>
                <span className="max-w-xl text-amber-900">{a.squareError}</span>
              </li>
            ))}
          </ul>
        </Card>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        <Card title={`Unmatched Square payments (${v.review.length})`}>
          {v.review.length === 0 ? (
            <p className="text-sm text-slate-600">Nothing to review. Every Square payment we were told about is matched to an invoice or was reviewed.</p>
          ) : (
            <ul className="space-y-3" data-testid="unmatched">
              {v.review.map((r) => (
                <li key={r.id} className="rounded-xl border border-amber-200 bg-amber-50/60 p-3 text-sm">
                  <p className="flex flex-wrap justify-between gap-2">
                    <span className="font-semibold text-navy-900">{money(r.amountCents)} · {r.sourceType === "BANK_ACCOUNT" ? "Bank transfer" : r.sourceType === "CARD" ? "Card" : (r.sourceType ?? "Square")}</span>
                    <span className="text-slate-600">{r.paidAt ? fmtDateTime(r.paidAt) : ""}</span>
                  </p>
                  <p className="mt-0.5 font-mono text-xs text-slate-600">Square payment {r.squarePaymentId}{r.squareCustomerId ? ` · customer ${r.squareCustomerId}` : ""}</p>
                  {r.likelyClient && <p className="mt-0.5 text-xs text-navy-900">Square customer used for {r.likelyClient}</p>}
                  {r.note && <p className="mt-1 text-xs text-amber-900">{r.note}</p>}
                  <div className="mt-2 grid gap-2 sm:grid-cols-2">
                    <ActionForm action={applySquarePaymentAction.bind(null, r.id)} className="space-y-1.5" confirm="Record this Square payment on the chosen invoice?">
                      <Field label="Apply to invoice">
                        <select className="input" name="invoiceId" required defaultValue="">
                          <option value="" disabled>Choose an open invoice…</option>
                          {v.openInvoices.map((i) => <option key={i.id} value={i.id}>{i.number} · {i.clientName} · {money(i.balanceCents)} due</option>)}
                        </select>
                      </Field>
                      <Button type="submit" variant="secondary">Apply payment</Button>
                    </ActionForm>
                    <ActionForm action={dismissSquarePaymentAction.bind(null, r.id)} className="space-y-1.5">
                      <Field label="Not a Client Connect invoice — why?"><input className="input" name="note" required maxLength={300} placeholder="e.g. in-person sale" /></Field>
                      <Button type="submit" variant="ghost">Mark reviewed</Button>
                    </ActionForm>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card title="Matched to invoices">
          {v.matched.length === 0 ? (
            <p className="text-sm text-slate-600">No Square payments recorded yet.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm" data-testid="matched">
                <thead className="text-left text-slate-600"><tr><th className="py-1">Date</th><th>Invoice</th><th>Method</th><th className="text-right">Amount</th></tr></thead>
                <tbody className="divide-y divide-navy-100">
                  {v.matched.map((p) => (
                    <tr key={p.id}>
                      <td className="py-1.5 whitespace-nowrap">{ymd(p.receivedOn)}</td>
                      <td><Link className="font-semibold underline" href={`/owner/invoices/${p.invoice.id}`}>{p.invoice.number}</Link> <span className="text-slate-600">· {p.invoice.client.displayName}</span>{p.kind === "REFUND" && <Badge tone="gray" className="ml-1">Refund</Badge>}<span className="block font-mono text-xs text-slate-500">{p.providerRef}</span></td>
                      <td>{METHOD_LABELS[p.method]}</td>
                      <td className="text-right font-semibold">{p.kind === "REFUND" ? "−" : ""}{money(p.amountCents)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </div>
      <div className="mt-4"><Notice tone="info">Refunds are made in Square by the owner and then recorded on the invoice. Client Connect never charges or refunds a card itself.</Notice></div>
    </>
  );
}
