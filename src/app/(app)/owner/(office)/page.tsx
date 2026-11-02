import Link from "next/link";
import { Badge, Card, LinkButton, Notice, PageHeader, Stat } from "@/components/ui";
import { requireOwner } from "@/lib/auth/owner";
import { monthlySummary, receivables, todayYmd } from "@/lib/services/owner-billing";
import { AGING_BUCKETS, money } from "@/lib/billing/pricing";
import { nameOf, paymentStatus, squareRevenueSummary } from "@/lib/services/square-billing";
import { squareHealth } from "@/lib/services/square-health";
import { fmtDate, fmtDateTime } from "@/lib/format";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export default async function OwnerOverview({ searchParams }: { searchParams: Promise<{ year?: string }> }) {
  const { actor } = await requireOwner("full");
  const thisYear = Number(todayYmd().slice(0, 4));
  const year = Number((await searchParams).year) || thisYear;
  const [{ months, total }, r, sq, health] = await Promise.all([monthlySummary(actor, year), receivables(actor), squareRevenueSummary(), squareHealth()]);
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
      <Card
        className="mt-4"
        title="Square recurring billing (from Square)"
        actions={<Link className="text-sm underline" href="/bookkeeping/square-billing">Square billing</Link>}
      >
        <div data-testid="owner-square">
          <p className="mb-3 text-sm text-slate-600">
            Read only, from the last verified sync of {sq.linked} active, confirmed Square series. Refreshed hourly.{" "}
            {sq.oldestSync ? <>Oldest sync: <strong>{fmtDateTime(sq.oldestSync)}</strong>.</> : "Nothing synced yet."}{" "}
            Connection: <Badge tone={health.state === "WORKING" ? "green" : health.state === "FAILING" ? "red" : "amber"}>{health.state === "WORKING" ? "Working" : health.state === "FAILING" ? "Not working" : health.state === "UNCHECKED" ? "Not yet verified" : "Not set up"}</Badge>
          </p>
          {(sq.endedCount > 0 || sq.reviewCount > 0) && <p className="mb-2 text-xs text-slate-600" data-testid="owner-square-excluded">Not counted: {sq.endedCount} ended series (history only){sq.reviewCount ? ` and ${sq.reviewCount} series whose status needs your review` : ""}.</p>}
          {(sq.stale > 0 || health.state === "FAILING") && <Notice tone="warn" title="Some Square figures may be out of date">{sq.stale} of {sq.linked} series haven&apos;t been read successfully in the last 3 hours. The figures below are the last verified ones.</Notice>}
          <div className="mt-3 grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
            <Stat label="Monthly recurring (Square)" value={money(sq.recurringMonthlyCents)} hint={sq.unknownCadence ? `${sq.unknownCadence} series with an unclear schedule not counted` : "Quarterly/yearly converted to monthly"} />
            <Stat label={`Paid invoices due ${sq.month}`} value={money(sq.paidThisMonthCents)} hint="Square invoices marked paid" />
            <Stat label="Outstanding (Square)" value={money(sq.outstandingCents)} hint="Unpaid, incl. overdue — scheduled invoices aren't counted" />
            <Stat label="Overdue (Square)" value={money(sq.overdueCents)} hint={`${sq.overdueInvoices} invoice${sq.overdueInvoices === 1 ? "" : "s"} past due${sq.failedInvoices ? ` · ${sq.failedInvoices} failed payment${sq.failedInvoices === 1 ? "" : "s"}` : ""}`} />
            <Stat label="Upcoming, next 30 days" value={money(sq.upcomingCents)} hint={`${sq.upcoming.length} scheduled invoice${sq.upcoming.length === 1 ? "" : "s"}`} />
          </div>
          {sq.attention.length > 0 && (
            <div className="mt-4">
              <p className="text-sm font-semibold text-red-800">Needs attention</p>
              <ul className="text-sm">{sq.attention.map((a) => <li key={a.id}>{a.members.map((m) => nameOf(m.client)).join(", ")} — <Badge tone={paymentStatus(a).tone}>{paymentStatus(a).label}</Badge></li>)}</ul>
            </div>
          )}
          {sq.upcoming.length > 0 && (
            <div className="mt-4 overflow-x-auto">
              <table className="w-full text-sm" data-testid="owner-square-upcoming">
                <thead className="text-left text-slate-600"><tr><th className="py-1">Client</th><th>Series</th><th>Next invoice</th><th>Amount</th><th>Last synced</th></tr></thead>
                <tbody className="divide-y divide-navy-100">
                  {sq.upcoming.map((a) => (
                    <tr key={a.id}><td className="py-1">{a.members.map((m) => nameOf(m.client)).join(", ")}</td><td>{a.seriesKey}</td><td>{fmtDate(a.nextDueDate!)}</td><td>{money(a.amountCents ?? 0)}</td><td>{a.syncedAt ? fmtDateTime(a.syncedAt) : "—"}</td></tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </Card>
    </>
  );
}
