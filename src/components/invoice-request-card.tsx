import Link from "next/link";
import { FileText, Plus } from "lucide-react";
import { Badge, LinkButton } from "@/components/ui";
import type { InvoiceRequestCard as Card } from "@/lib/services/invoice-requests";
import { REQUEST_STATUS } from "@/lib/services/invoice-requests";
import { INVOICE_STATUS } from "@/lib/billing/invoice-status";
import { money } from "@/lib/billing/pricing";
import { fmtDateTime } from "@/lib/format";
import { formatPhone } from "@/lib/normalize";

const term = "text-xs font-semibold uppercase tracking-wider text-gold-700";

/** "Pay with an Invoice" on a conversation: who asked, for whom, what for, and what's on file. */
export function InvoiceRequestCardView({ card }: { card: Card }) {
  const st = REQUEST_STATUS[card.status] ?? REQUEST_STATUS.OPEN;
  const clientName = card.client.businessName || card.client.displayName;
  return (
    <section id="invoice-request" className="mb-4 rounded-2xl border border-gold-300 bg-gradient-to-b from-white to-ivory-50 p-4 sm:p-5" data-testid="invoice-request-card">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <h3 className="flex min-w-0 items-start gap-2 font-serif text-lg font-bold text-navy-900">
          <FileText className="mt-1 size-5 shrink-0 text-gold-600" aria-hidden />
          <span data-testid="invoice-request-title">{card.legacy ? "Invoice request (details not given)" : "Invoice request"}</span>
        </h3>
        <Badge tone={st.tone}>{st.label}</Badge>
      </div>
      <dl className="mt-3 grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
        <div><dt className={term}>Client</dt><dd className="text-navy-900"><Link className="underline" href={`/clients/${card.client.id}`}>{clientName}</Link>{card.client.businessName && card.client.businessName !== card.client.displayName && <span className="block text-xs text-slate-600">{card.client.displayName}</span>}</dd></div>
        <div><dt className={term}>Requested by</dt><dd className="text-navy-900" data-testid="requester">{card.requester.name}<span className="block text-xs text-slate-600">{[card.requester.email, card.requester.phone ? formatPhone(card.requester.phone) : null].filter(Boolean).join(" · ") || "Portal login"}</span></dd></div>
        <div><dt className={term}>Client contact</dt><dd className="text-navy-900">{[card.client.email, card.client.phone ? formatPhone(card.client.phone) : null].filter(Boolean).join(" · ") || <span className="text-slate-500">Not on file</span>}</dd></div>
        <div><dt className={term}>Date</dt><dd className="text-navy-900">{fmtDateTime(card.requestedAt)}</dd></div>
        {card.taxYear && <div><dt className={term}>Tax year</dt><dd className="text-navy-900">{card.taxYear}</dd></div>}
        {card.amountCents != null && <div><dt className={term}>Amount the client gave</dt><dd className="text-navy-900" data-testid="request-amount">{money(card.amountCents)}</dd></div>}
      </dl>

      <div className="mt-3">
        <p className={term}>Asked for</p>
        {card.legacy ? (
          <p className="mt-1 text-sm text-slate-700" data-testid="request-legacy">Details not given (sent before requests asked what they were for).{card.message && <span className="mt-1 block italic">“{card.message}”</span>}</p>
        ) : (
          <ul className="mt-1 divide-y divide-ivory-200 rounded-xl border border-ivory-200 bg-white text-sm" data-testid="request-lines">
            {card.lines.map((l, i) => (
              <li key={i} className="flex flex-wrap items-baseline justify-between gap-2 px-3 py-2">
                <span className="min-w-0 text-navy-900">{l.kind === "OTHER" ? `Other${card.note ? `: ${card.note}` : ""}` : l.label}{l.priceNote && card.mayView && <span className="block text-xs text-slate-600">{l.priceNote}</span>}</span>
                {card.mayView && <span className="font-semibold text-navy-900" data-testid="request-price">{l.priceCents != null ? money(l.priceCents) : "—"}</span>}
              </li>
            ))}
          </ul>
        )}
        {!card.legacy && card.note && !card.lines.some((l) => l.kind === "OTHER") && <p className="mt-2 text-sm text-slate-700">Note: {card.note}</p>}
      </div>

      {card.invoices ? (
        <div className="mt-3 grid gap-3 text-sm sm:grid-cols-2" data-testid="request-invoices">
          <div>
            <p className={term}>Open invoices</p>
            {card.invoices.open.length ? (
              <ul className="mt-1 space-y-0.5">{card.invoices.open.map((r) => <li key={r.id}><Link className="underline" href={`/owner/invoices/${r.id}`}>{r.number}</Link> · {r.title} · {money(r.balanceCents)} due</li>)}</ul>
            ) : <p className="mt-1 text-slate-600">None</p>}
            {card.invoices.drafts.length > 0 && <p className="mt-1 text-xs text-slate-600">Drafts not yet sent: {card.invoices.drafts.map((d) => d.number).join(", ")}</p>}
          </div>
          <div>
            <p className={term}>Paid invoices</p>
            {card.invoices.paid.length ? (
              <ul className="mt-1 space-y-0.5">{card.invoices.paid.slice(0, 5).map((r) => <li key={r.id}><Link className="underline" href={`/owner/invoices/${r.id}`}>{r.number}</Link> · {r.title} · <Badge tone={INVOICE_STATUS[r.status].badge}>{INVOICE_STATUS[r.status].label}</Badge></li>)}</ul>
            ) : <p className="mt-1 text-slate-600">None</p>}
          </div>
        </div>
      ) : (
        <p className="mt-3 text-xs text-slate-600">Prices and invoices show to staff with Billing access.</p>
      )}

      <div className="mt-4 flex flex-wrap items-center gap-3">
        {card.invoice ? (
          <LinkButton href={`/owner/invoices/${card.invoice.id}`} variant="secondary" data-testid="request-invoice-link">Open {card.invoice.number}</LinkButton>
        ) : card.mayCreate ? (
          <LinkButton href={card.createHref} variant="gold" data-testid="create-from-request"><Plus className="size-4" aria-hidden /> Create invoice for this request</LinkButton>
        ) : (
          <p className="text-xs text-slate-600">Someone with Billing → Create makes the invoice.</p>
        )}
        <p className="text-xs text-slate-600">Opens Create Invoice filled in. Nothing is sent until it&apos;s sent the normal way; then this request shows Invoice sent and stops needing a reply.</p>
      </div>
    </section>
  );
}
