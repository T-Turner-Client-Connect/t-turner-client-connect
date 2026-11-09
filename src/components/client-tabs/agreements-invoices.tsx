import Link from "next/link";
import { Plus } from "lucide-react";
import type { Actor } from "@/lib/auth/actor";
import { Badge, Card, LinkButton } from "@/components/ui";
import { StatusBadge } from "@/components/agreements/bits";
import { JotformContractsCard } from "@/components/agreements/jotform-contracts";
import { can } from "@/lib/auth/permissions";
import { listAgreements } from "@/lib/services/agreements";
import { clientServices, SERVICE_TYPES } from "@/lib/services/service-agreements";
import { invoiceRows } from "@/lib/services/owner-billing";
import { downloadToken } from "@/lib/services/documents";
import { INVOICE_STATUS } from "@/lib/billing/invoice-status";
import { money } from "@/lib/billing/pricing";
import { usd } from "@/lib/billing/payment-fees";
import type { AgreementTerms } from "@/lib/billing/agreement-terms";
import { fmtDate } from "@/lib/format";

const PRICING_LABEL = { DRAFT: "Draft (not sent)", SENT: "Sent", VIEWED: "Viewed", SIGNED: "Signed", SUPERSEDED: "Superseded", VOID: "Void" } as const;

/**
 * Agreements & Invoices: this client's agreements from the Agreements center, their
 * invoices, earlier pricing agreements (read-only, kept as history) and, at the bottom,
 * Jotform contracts for older or custom contracts.
 */
export async function AgreementsInvoicesTab({ clientId, user }: { clientId: string; user: Actor }) {
  const [agreements, services, seesInvoices] = await Promise.all([listAgreements({ clientId }), clientServices(clientId), can(user, "billing", "view")]);
  const invoices = seesInvoices ? await invoiceRows(user, { clientId }) : [];
  const earlier = services.filter((s) => s.agreements.length > 0);
  return (
    <div className="space-y-4" data-testid="agreements-invoices-tab">
      <Card title="Agreements" actions={<LinkButton href={`/agreements/new?client=${clientId}`} variant="gold" data-testid="client-new-agreement"><Plus className="size-4" aria-hidden /> New agreement</LinkButton>}>
        {agreements.length === 0 ? (
          <p className="text-sm text-slate-600">No agreements yet. Use “New agreement” to prepare one for any service.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[36rem] text-sm" data-testid="client-agreements-table">
              <thead className="text-left text-slate-600"><tr><th className="py-1">Agreement</th><th>Type</th><th>Status</th><th>Sent</th><th>Signed</th><th>Signed PDF</th></tr></thead>
              <tbody className="divide-y divide-navy-100">
                {agreements.map((a) => (
                  <tr key={a.id}>
                    <td className="py-2"><Link className="font-semibold underline" href={`/agreements/${a.id}`}>{a.title}</Link></td>
                    <td className="text-slate-700">{a.template.name}</td>
                    <td><StatusBadge status={a.display} /></td>
                    <td>{a.sentAt ? fmtDate(a.sentAt) : "—"}</td>
                    <td>{a.signedAt ? fmtDate(a.signedAt) : "—"}</td>
                    <td>{a.pdfDocumentId ? <a className="underline" href={`/api/documents/${downloadToken(a.pdfDocumentId, { staffId: user.id })}`} target="_blank" rel="noopener">Open</a> : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {seesInvoices && (
        <Card title="Invoices" actions={<Link className="text-sm underline" href={`/owner/invoices?client=${clientId}`}>Open the Invoices page</Link>}>
          {invoices.length === 0 ? <p className="text-sm text-slate-600">No invoices yet. On an agreement, “Add invoice to this agreement” drafts one from its fees.</p> : (
            <ul className="divide-y divide-navy-100 text-sm" data-testid="client-invoices">
              {invoices.map((r) => (
                <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                  <span><Link className="font-semibold underline" href={`/owner/invoices/${r.id}`}>{r.number}</Link> · {r.title}</span>
                  <span className="flex items-center gap-2"><Badge tone={INVOICE_STATUS[r.status].badge}>{INVOICE_STATUS[r.status].label}</Badge> due {r.dueDate}{r.invoicedOn && <> · {money(r.totalCents)}</>}</span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      )}

      {earlier.length > 0 && (
        <Card title="Earlier pricing agreements">
          <p className="mb-2 text-sm text-slate-600">Kept as history, read-only. New agreements are made above.</p>
          <ul className="divide-y divide-navy-100 text-sm" data-testid="earlier-pricing">
            {earlier.flatMap((s) => s.agreements.map((a) => {
              const t = a.terms as unknown as AgreementTerms;
              return (
                <li key={a.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                  <span><strong>{s.title}</strong> · {SERVICE_TYPES[s.type].label}{s.taxYear ? ` · ${s.taxYear}` : s.periodLabel ? ` · ${s.periodLabel}` : ""} · version {a.version} · {usd(t.baseCents)} · <Badge tone={a.status === "SIGNED" ? "green" : a.status === "SUPERSEDED" || a.status === "VOID" ? "gray" : "amber"}>{PRICING_LABEL[a.status]}</Badge>{a.signedAt && ` · signed ${fmtDate(a.signedAt)} by ${a.signerName}`}</span>
                  {a.pdfDocumentId && <a className="underline" href={`/api/documents/${downloadToken(a.pdfDocumentId, { staffId: user.id })}`} target="_blank" rel="noopener">Signed PDF</a>}
                </li>
              );
            }))}
          </ul>
        </Card>
      )}

      <JotformContractsCard clientId={clientId} />
    </div>
  );
}
