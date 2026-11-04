import { Banknote, CreditCard, ExternalLink, Landmark, ShieldCheck, Smartphone } from "lucide-react";
import { StatusPill } from "@/components/portal/billing-pages";
import { INVOICE_STATUS, type ClientPaymentOption, type InvoiceStatusKey } from "@/lib/billing/invoice-status";

/**
 * One firm invoice as the client sees it — the same component renders the live preview on the
 * Create Invoice screen, the owner's "client preview", and the invoice in the client portal, so
 * what staff approve is exactly what the client gets. It never receives internal notes.
 */
export type FirmInvoiceDoc = {
  number: string;
  status: InvoiceStatusKey;
  issueDate: string;
  dueDate: string;
  billTo: { name: string | null; email: string | null; phone: string | null; address: string | null };
  service: string;
  description: string;
  amountCents: number;
  paidCents: number;
  creditedCents: number;
  balanceCents: number;
  payments: { key: string; date: string; label: string; amountCents: number; negative?: boolean }[];
  options: ClientPaymentOption[];
};

const usd = (c: number) => `$${(Math.abs(c) / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const day = (d: string) => {
  if (!/^\d{4}-\d{2}-\d{2}/.test(d)) return "—";
  const [y, m, dd] = d.slice(0, 10).split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, dd)).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" });
};
const ICONS = { SQUARE_INVOICE: CreditCard, ZELLE: Smartphone, CASH_APP: Smartphone, VENMO: Smartphone, CASH: Banknote, REFUND_TRANSFER: Landmark } as const;

export function FirmInvoiceDocument({ doc, children }: { doc: FirmInvoiceDoc; children?: React.ReactNode }) {
  const st = INVOICE_STATUS[doc.status];
  const closed = doc.status === "VOIDED" || doc.status === "PAID";
  return (
    <article className="min-w-0 overflow-hidden rounded-2xl border border-gold-200/80 bg-white shadow-[0_18px_40px_-26px_rgb(10_26_68/0.55)]" data-testid="firm-invoice">
      <header className="bg-gradient-to-br from-navy-900 to-navy-950 px-5 py-5 text-white sm:px-7">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="font-serif text-xl font-bold leading-tight sm:text-2xl">T. Turner &amp; Associates, LLC</p>
            <p className="mt-0.5 text-xs uppercase tracking-[0.25em] text-gold-300">TTurner Client Connect</p>
          </div>
          <div className="text-right">
            <p className="font-serif text-2xl font-bold tracking-[0.2em] text-gold-400 sm:text-3xl">INVOICE</p>
            <p className="mt-0.5 font-mono text-sm text-navy-100" data-testid="invoice-number">{doc.number}</p>
          </div>
        </div>
      </header>
      <div className="h-1 bg-gradient-to-r from-gold-600 via-gold-400 to-gold-600" aria-hidden />

      <div className="space-y-6 px-5 py-6 sm:px-7">
        <div className="grid gap-5 sm:grid-cols-2">
          <div className="min-w-0">
            <p className="text-xs font-semibold uppercase tracking-widest text-gold-700">Bill to</p>
            <p className="mt-1 font-serif text-lg font-bold text-navy-900">{doc.billTo.name || "—"}</p>
            {doc.billTo.address && <p className="whitespace-pre-line text-sm text-navy-800">{doc.billTo.address}</p>}
            {doc.billTo.email && <p className="break-all text-sm text-navy-800">{doc.billTo.email}</p>}
            {doc.billTo.phone && <p className="text-sm text-navy-800">{doc.billTo.phone}</p>}
          </div>
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 self-start rounded-xl bg-ivory-100 p-4 text-sm ring-1 ring-ivory-200">
            <dt className="text-slate-600">Status</dt>
            <dd className="text-right"><StatusPill tone={st.tone}>{st.label}</StatusPill></dd>
            <dt className="text-slate-600">Invoice date</dt>
            <dd className="text-right font-semibold text-navy-900">{day(doc.issueDate)}</dd>
            <dt className="text-slate-600">Due date</dt>
            <dd className="text-right font-semibold text-navy-900">{day(doc.dueDate)}</dd>
          </dl>
        </div>

        <div className="relative overflow-x-auto">
          <table className="w-full border-separate border-spacing-0 text-sm">
            <thead>
              <tr className="text-left text-white">
                <th className="rounded-l-xl bg-navy-900 py-2.5 pl-4 pr-3 font-semibold">Service</th>
                <th className="rounded-r-xl bg-navy-900 py-2.5 pl-3 pr-4 text-right font-semibold">Amount</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td className="border-b border-ivory-200 py-3 pl-4 pr-3 align-top">
                  <span className="block font-semibold text-navy-900">{doc.service}</span>
                  {doc.description && <span className="mt-0.5 block whitespace-pre-line text-slate-700">{doc.description}</span>}
                </td>
                <td className="border-b border-ivory-200 py-3 pl-3 pr-4 text-right align-top font-semibold text-navy-900">{usd(doc.amountCents)}</td>
              </tr>
            </tbody>
          </table>
        </div>

        <dl className="ml-auto max-w-xs space-y-1.5 text-sm" data-testid="invoice-totals">
          <div className="flex justify-between gap-4"><dt className="text-slate-600">Invoice total</dt><dd className="font-semibold text-navy-900">{usd(doc.amountCents)}</dd></div>
          <div className="flex justify-between gap-4"><dt className="text-slate-600">Payments received</dt><dd className="text-navy-900">{doc.paidCents ? `−${usd(doc.paidCents)}` : usd(0)}</dd></div>
          {doc.creditedCents > 0 && <div className="flex justify-between gap-4"><dt className="text-slate-600">Adjustments</dt><dd className="text-navy-900">−{usd(doc.creditedCents)}</dd></div>}
          <div className="flex items-center justify-between gap-4 rounded-xl bg-gradient-to-br from-navy-900 to-navy-950 px-4 py-3 text-white">
            <dt className="font-serif text-base font-bold">Balance due</dt>
            <dd className="font-serif text-xl font-bold text-gold-300" data-testid="invoice-balance">{usd(doc.balanceCents)}</dd>
          </div>
        </dl>

        {!closed && (
          <section aria-labelledby="ways-to-pay" data-testid="ways-to-pay">
            <h3 id="ways-to-pay" className="font-serif text-xl font-bold text-navy-900">Ways to pay</h3>
            {doc.options.length === 0 ? (
              <p className="mt-2 rounded-xl bg-ivory-100 px-4 py-3 text-sm text-navy-800 ring-1 ring-ivory-200">Please contact our office at 205-639-1000 for payment options.</p>
            ) : (
              <ul className="mt-3 grid gap-3 md:grid-cols-2">
                {doc.options.map((o) => {
                  const Icon = ICONS[o.method];
                  return (
                    <li key={o.method} className={`rounded-xl border px-4 py-3 ${o.method === "REFUND_TRANSFER" ? "border-gold-400 bg-white md:col-span-2" : "border-gold-300 bg-gold-50/50"}`} data-testid={`option-${o.method}`}>
                      <p className="flex items-center gap-2 font-semibold text-navy-900"><Icon className="size-5 shrink-0 text-gold-600" aria-hidden /> {o.label}</p>
                      <p className="mt-0.5 text-xs text-slate-600">{o.sub}</p>
                      {o.details && <p className="mt-2 whitespace-pre-line text-sm text-navy-800">{o.details}</p>}
                      {o.method !== "CASH" && o.method !== "SQUARE_INVOICE" && o.method !== "REFUND_TRANSFER" && <p className="mt-1 text-xs text-slate-600">Please include your name and invoice number {doc.number} in the note.</p>}
                      {o.url && (
                        <a href={o.url} target="_blank" rel="noopener noreferrer" className="mt-2 inline-flex items-center gap-2 rounded-lg bg-navy-900 px-4 py-2 text-sm font-semibold text-white hover:bg-navy-800" data-testid="square-pay-link">
                          <ShieldCheck className="size-4 text-gold-300" aria-hidden /> Pay securely with Square <ExternalLink className="size-3.5" aria-hidden />
                        </a>
                      )}
                      {o.terms && (
                        <div className="mt-2 space-y-1.5 text-sm text-navy-800">
                          <ul className="list-disc space-y-1 pl-5">{o.terms.map((t) => <li key={t}>{t}</li>)}</ul>
                          <p className="rounded-lg bg-ivory-100 px-3 py-2 text-xs ring-1 ring-ivory-200" data-testid="refund-transfer-fees">
                            <strong>Republic Bank fees: </strong>
                            {o.feeNote ?? "Our office will give you Republic Bank's confirmed fees and required disclosures before you authorize the service. No fee amount is assumed here."}
                          </p>
                        </div>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        )}

        <section aria-labelledby="pay-history">
          <h3 id="pay-history" className="font-serif text-xl font-bold text-navy-900">Payments &amp; history</h3>
          {doc.payments.length === 0 ? (
            <p className="mt-2 text-sm text-slate-600">No payments recorded yet.</p>
          ) : (
            <ul className="mt-2 divide-y divide-ivory-200 text-sm" data-testid="invoice-payments">
              {doc.payments.map((p) => (
                <li key={p.key} className="flex flex-wrap justify-between gap-2 py-2">
                  <span className="text-navy-800">{day(p.date)} · {p.label}</span>
                  <span className="font-semibold text-navy-900">{p.negative ? "+" : "−"}{usd(p.amountCents)}</span>
                </li>
              ))}
            </ul>
          )}
        </section>
        {children}
        <p className="border-t border-ivory-200 pt-4 text-center text-xs text-slate-500">Thank you for choosing T. Turner &amp; Associates, LLC · 205-639-1000</p>
      </div>
    </article>
  );
}
