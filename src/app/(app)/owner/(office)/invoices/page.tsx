import Link from "next/link";
import { Plus } from "lucide-react";
import { Badge, Card, EmptyState, LinkButton, PageHeader } from "@/components/ui";
import { INVOICE_STATUS } from "@/lib/billing/invoice-status";
import { requireOffice } from "@/lib/auth/owner";
import { invoiceRows } from "@/lib/services/owner-billing";
import { money } from "@/lib/billing/pricing";
import { prisma } from "@/lib/prisma";
import { STATE_LABELS } from "@/lib/billing/labels";

export default async function InvoicesPage({ searchParams }: { searchParams: Promise<{ client?: string; state?: string }> }) {
  const { actor, access } = await requireOffice("billing");
  const sp = await searchParams;
  const states = Object.keys(STATE_LABELS);
  const all = await invoiceRows(actor, { clientId: sp.client || undefined, state: states.includes(sp.state ?? "") ? sp.state : undefined });
  const rows = sp.state === "open" ? all.filter((r) => r.balanceCents > 0) : sp.state === "overdue" ? all.filter((r) => r.status === "OVERDUE") : all;
  const pending = sp.state ? 0 : all.filter((r) => r.state === "PENDING_APPROVAL").length;
  const clients = await prisma.client.findMany({ where: { archivedAt: null }, select: { id: true, displayName: true }, orderBy: { displayName: "asc" } });
  return (
    <>
      <PageHeader
        title="Quotes & invoices"
        actions={
          <>
            <LinkButton href="/owner/invoices/create" variant="gold" className="px-5 text-base shadow-md" data-testid="create-invoice"><Plus className="size-5" aria-hidden /> Create Invoice</LinkButton>
            <LinkButton href="/owner/invoices/new" variant="secondary">Itemized quote</LinkButton>
            {access.can("billing", "view") && <LinkButton variant="secondary" href={`/api/owner/export?type=invoices${sp.client ? `&client=${sp.client}` : ""}`}>Export CSV</LinkButton>}
          </>
        }
      />
      {pending > 0 && (
        <p className="mb-4 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900" data-testid="pending-approval-count">
          <strong>{pending}</strong> invoice{pending === 1 ? " is" : "s are"} waiting for {access.isOwner ? "your" : "the owner's"} approval. <Link className="font-semibold underline" href="/owner/invoices?state=PENDING_APPROVAL">Review</Link>
        </p>
      )}
      <form className="mb-4 flex flex-wrap items-end gap-2" method="get">
        <label className="text-sm">Client
          <select className="input mt-1" name="client" defaultValue={sp.client ?? ""}>
            <option value="">All clients</option>
            {clients.map((c) => <option key={c.id} value={c.id}>{c.displayName}</option>)}
          </select>
        </label>
        <label className="text-sm">Status
          <select className="input mt-1" name="state" defaultValue={sp.state ?? ""}>
            <option value="">All</option>
            <option value="open">Balance due</option>
            <option value="overdue">Overdue</option>
            {states.map((s) => <option key={s} value={s}>{STATE_LABELS[s].label}</option>)}
          </select>
        </label>
        <button className="rounded-lg border border-navy-200 px-3 py-2 text-sm font-semibold">Filter</button>
      </form>
      {rows.length === 0 ? (
        <EmptyState title="No quotes or invoices yet">Use Create Invoice to bill an existing client, or an itemized quote to offer a payment plan.</EmptyState>
      ) : (
        <Card>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[760px] text-sm">
              <thead className="text-left text-slate-600"><tr><th className="py-1">Number</th><th>Client</th><th>Title</th><th>Status</th><th className="text-right">Total</th><th className="text-right">Paid</th><th className="text-right">Balance</th><th className="pl-6">Due</th></tr></thead>
              <tbody className="divide-y divide-navy-100">
                {rows.map((r) => (
                  <tr key={r.id}>
                    <td className="py-2"><Link className="font-semibold underline" href={`/owner/invoices/${r.id}`}>{r.number}</Link></td>
                    <td>{r.clientName}</td>
                    <td>{r.title}</td>
                    <td className="space-x-1">
                      <Badge tone={INVOICE_STATUS[r.status].badge}>{INVOICE_STATUS[r.status].label}{r.status === "OVERDUE" && r.oldestOverdueDays ? ` ${r.oldestOverdueDays}d` : ""}</Badge>
                      {r.option === "PLAN" && <Badge tone="navy">Plan</Badge>}
                    </td>
                    <td className="text-right">{r.invoicedOn ? money(r.totalCents) : "—"}</td>
                    <td className="text-right">{money(r.collectedCents)}</td>
                    <td className="text-right font-semibold">{r.invoicedOn ? money(r.balanceCents) : "—"}</td>
                    <td className="pl-6">{r.nextDue ?? r.dueDate}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </>
  );
}
