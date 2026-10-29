import Link from "next/link";
import { Badge, Card, EmptyState, LinkButton, PageHeader } from "@/components/ui";
import { requireOwner } from "@/lib/auth/owner";
import { invoiceRows } from "@/lib/services/owner-billing";
import { money } from "@/lib/billing/pricing";
import { prisma } from "@/lib/prisma";
import { STATE_LABELS } from "@/lib/billing/labels";

export default async function InvoicesPage({ searchParams }: { searchParams: Promise<{ client?: string; state?: string }> }) {
  const { actor, access } = await requireOwner("billing");
  const sp = await searchParams;
  const states = Object.keys(STATE_LABELS);
  const all = await invoiceRows(actor, { clientId: sp.client || undefined, state: states.includes(sp.state ?? "") ? sp.state : undefined });
  const rows = sp.state === "open" ? all.filter((r) => r.balanceCents > 0) : sp.state === "overdue" ? all.filter((r) => r.overdueCents > 0) : all;
  const clients = await prisma.client.findMany({ where: { archivedAt: null }, select: { id: true, displayName: true }, orderBy: { displayName: "asc" } });
  return (
    <>
      <PageHeader
        title="Quotes & invoices"
        actions={
          <>
            <LinkButton href="/owner/invoices/new">New quote / invoice</LinkButton>
            {access.scope === "FULL" && <LinkButton variant="secondary" href={`/api/owner/export?type=invoices${sp.client ? `&client=${sp.client}` : ""}`}>Export CSV</LinkButton>}
          </>
        }
      />
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
        <EmptyState title="No quotes or invoices yet">Create one to send a client an itemized quote with payment options.</EmptyState>
      ) : (
        <Card>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[760px] text-sm">
              <thead className="text-left text-slate-600"><tr><th className="py-1">Number</th><th>Client</th><th>Title</th><th>Status</th><th className="text-right">Total</th><th className="text-right">Collected</th><th className="text-right">Balance</th><th>Next due</th></tr></thead>
              <tbody className="divide-y divide-navy-100">
                {rows.map((r) => (
                  <tr key={r.id}>
                    <td className="py-2"><Link className="font-semibold underline" href={`/owner/invoices/${r.id}`}>{r.number}</Link></td>
                    <td>{r.clientName}</td>
                    <td>{r.title}</td>
                    <td className="space-x-1">
                      <Badge tone={STATE_LABELS[r.state].tone}>{STATE_LABELS[r.state].label}</Badge>
                      {r.option === "PLAN" && <Badge tone="navy">Plan</Badge>}
                      {r.overdueCents > 0 && <Badge tone="red">Overdue {r.oldestOverdueDays}d</Badge>}
                    </td>
                    <td className="text-right">{r.invoicedOn ? money(r.totalCents) : "—"}</td>
                    <td className="text-right">{money(r.collectedCents)}</td>
                    <td className="text-right font-semibold">{r.invoicedOn ? money(r.balanceCents) : "—"}</td>
                    <td>{r.nextDue ?? "—"}</td>
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
