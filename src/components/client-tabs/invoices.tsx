import Link from "next/link";
import { Plus } from "lucide-react";
import { Badge, Card, LinkButton } from "@/components/ui";
import type { Actor } from "@/lib/auth/actor";
import { invoiceRows } from "@/lib/services/owner-billing";
import { money } from "@/lib/billing/pricing";
import { INVOICE_STATUS } from "@/lib/billing/invoice-status";

/**
 * The client's firm invoices on their master profile — the same Invoice records as Admin Billing,
 * the client's Billing page and receivables. Shown only to staff with Owner's Office access
 * (the page checks before rendering this tab).
 */
export async function InvoicesTab({ clientId, actor }: { clientId: string; actor: Actor }) {
  const rows = await invoiceRows(actor, { clientId });
  const balance = rows.reduce((s, r) => s + Math.max(0, r.balanceCents), 0);
  return (
    <Card
      title="Invoices"
      actions={<LinkButton href={`/owner/invoices/create?client=${clientId}`} variant="gold" data-testid="profile-create-invoice"><Plus className="size-4" aria-hidden /> Create Invoice</LinkButton>}
    >
      <p className="mb-3 text-sm text-slate-600">From the Owner&apos;s Office. Open balance: <strong className="text-navy-900">{money(balance)}</strong></p>
      {rows.length === 0 ? (
        <p className="text-sm text-slate-600">No invoices for this client yet.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[36rem] text-sm" data-testid="profile-invoices">
            <thead className="text-left text-slate-600"><tr><th className="py-1">Number</th><th>Service</th><th>Status</th><th>Due</th><th className="text-right">Total</th><th className="text-right">Balance</th></tr></thead>
            <tbody className="divide-y divide-navy-100">
              {rows.map((r) => (
                <tr key={r.id}>
                  <td className="py-2"><Link className="font-semibold underline" href={`/owner/invoices/${r.id}`}>{r.number}</Link></td>
                  <td>{r.title}</td>
                  <td><Badge tone={INVOICE_STATUS[r.status].badge}>{INVOICE_STATUS[r.status].label}</Badge></td>
                  <td>{r.dueDate}</td>
                  <td className="text-right">{r.invoicedOn ? money(r.totalCents) : "—"}</td>
                  <td className="text-right font-semibold">{r.invoicedOn ? money(r.balanceCents) : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}
