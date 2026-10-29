import Link from "next/link";
import { Badge, Card, LinkButton, Notice, PageHeader, Stat } from "@/components/ui";
import { requireOwner } from "@/lib/auth/owner";
import { monthlySummary, receivables, todayYmd } from "@/lib/services/owner-billing";
import { AGING_BUCKETS, money } from "@/lib/billing/pricing";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export default async function OwnerOverview({ searchParams }: { searchParams: Promise<{ year?: string }> }) {
  const { actor } = await requireOwner("full");
  const thisYear = Number(todayYmd().slice(0, 4));
  const year = Number((await searchParams).year) || thisYear;
  const [{ months, total }, r] = await Promise.all([monthlySummary(actor, year), receivables(actor)]);
  const month = year === thisYear ? months[Number(todayYmd().slice(5, 7)) - 1] : null;
  return (
    <>
      <PageHeader
        title="Overview"
        subtitle="Invoiced revenue and cash collected are tracked separately. Unpaid invoices never count as cash."
        actions={
          <>
            <LinkButton href="/owner/invoices/new">New quote / invoice</LinkButton>
            <LinkButton href="/owner/expenses" variant="secondary">Add expense</LinkButton>
          </>
        }
      />
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label={`Collected ${year}`} value={money(total.collectedCents - total.refundedCents)} hint={month ? `${money(month.collectedCents - month.refundedCents)} this month` : "Cash received, less refunds"} />
        <Stat label={`Invoiced ${year}`} value={money(total.invoicedCents)} hint="Accepted quotes and issued invoices" />
        <Stat label={`Expenses ${year}`} value={money(total.expensesCents)} hint={month ? `${money(month.expensesCents)} this month` : undefined} />
        <Stat label="Outstanding now" value={money(r.totalOutstandingCents)} hint={`${r.clients.length} client${r.clients.length === 1 ? " owes" : "s owe"} a balance`} href="/owner/invoices?state=open" />
      </div>

      <div className="mt-6 grid gap-4 lg:grid-cols-[3fr_2fr]">
        <Card title="Who owes me" actions={<Link className="text-sm underline" href="/api/owner/export?type=receivables">Export CSV</Link>}>
          {r.clients.length === 0 ? (
            <p className="text-sm text-slate-600">No outstanding balances.</p>
          ) : (
            <table className="w-full text-sm">
              <thead className="text-left text-slate-600"><tr><th className="py-1">Client</th><th>For</th><th className="text-right">Overdue</th><th className="text-right">Balance</th></tr></thead>
              <tbody className="divide-y divide-navy-100">
                {r.clients.map((c) => (
                  <tr key={c.clientId}>
                    <td className="py-2 font-medium"><Link className="underline" href={`/owner/invoices?client=${c.clientId}`}>{c.clientName}</Link></td>
                    <td className="text-slate-600">{c.services.join(", ")}</td>
                    <td className="text-right">{c.overdueCents ? <Badge tone="red">{money(c.overdueCents)}</Badge> : "—"}</td>
                    <td className="text-right font-semibold">{money(c.balanceCents)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
        <Card title="Aging">
          <ul className="divide-y divide-navy-100 text-sm">
            {AGING_BUCKETS.map((b) => (
              <li key={b} className="flex justify-between py-2"><span>{b === "Current" ? "Not yet due" : `${b} past due`}</span><span className="font-semibold">{money(r.aging[b])}</span></li>
            ))}
          </ul>
        </Card>
      </div>

      <Card
        className="mt-6"
        title={`Monthly totals — ${year}`}
        actions={
          <div className="flex flex-wrap items-center gap-3 text-sm">
            <Link className="underline" href={`/owner?year=${year - 1}`}>← {year - 1}</Link>
            {year < thisYear && <Link className="underline" href={`/owner?year=${year + 1}`}>{year + 1} →</Link>}
            <Link className="underline" href={`/api/owner/export?type=summary&year=${year}`}>Export CSV</Link>
          </div>
        }
      >
        <div className="overflow-x-auto">
          <table className="w-full min-w-[560px] text-sm">
            <thead className="text-left text-slate-600"><tr><th className="py-1">Month</th><th className="text-right">Invoiced</th><th className="text-right">Collected</th><th className="text-right">Refunded</th><th className="text-right">Expenses</th><th className="text-right">Net cash</th></tr></thead>
            <tbody className="divide-y divide-navy-100">
              {months.map((m) => (
                <tr key={m.month}>
                  <td className="py-1.5">{MONTHS[m.month - 1]}</td>
                  <td className="text-right">{money(m.invoicedCents)}</td>
                  <td className="text-right">{money(m.collectedCents)}</td>
                  <td className="text-right">{m.refundedCents ? `−${money(m.refundedCents)}` : "—"}</td>
                  <td className="text-right">{money(m.expensesCents)}</td>
                  <td className={`text-right font-semibold ${m.netCashCents < 0 ? "text-red-800" : ""}`}>{money(m.netCashCents)}</td>
                </tr>
              ))}
              <tr className="font-bold"><td className="py-2">Total</td><td className="text-right">{money(total.invoicedCents)}</td><td className="text-right">{money(total.collectedCents)}</td><td className="text-right">{money(total.refundedCents)}</td><td className="text-right">{money(total.expensesCents)}</td><td className="text-right">{money(total.netCashCents)}</td></tr>
            </tbody>
          </table>
        </div>
      </Card>

      <div className="mt-6">
        <Notice title="Financial connections">
          Manual entry. No bank, card processor, QuickBooks or payment provider is connected, so every payment, refund and expense here was recorded by hand and is labeled that way.
          Invoices are &ldquo;invoiced revenue&rdquo; when accepted or issued; only recorded payments count as cash collected.
        </Notice>
      </div>
    </>
  );
}
