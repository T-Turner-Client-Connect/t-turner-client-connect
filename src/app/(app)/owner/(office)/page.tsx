import Link from "next/link";
import { Plus } from "lucide-react";
import { Badge, Button, Card, Field, LinkButton, Notice, PageHeader, Stat } from "@/components/ui";
import { ActionForm } from "@/components/action-form";
import { addNonSquareRecurringAction } from "@/app/actions/manual-billing";
import { nonSquareRecurring, PAY_METHODS } from "@/lib/services/manual-billing";
import { prisma } from "@/lib/prisma";
import { requireOffice } from "@/lib/auth/owner";
import { monthlySummary, receivables, todayYmd } from "@/lib/services/owner-billing";
import { AGING_BUCKETS, money } from "@/lib/billing/pricing";
import { nameOf, paymentStatus, squareRevenueSummary } from "@/lib/services/square-billing";
import { squareHealth } from "@/lib/services/square-health";
import { fmtDate, fmtDateTime } from "@/lib/format";
import { accessReviewBanner } from "@/lib/services/access-review";
import { AccessReviewBanner } from "@/components/owner/access-review-banner";
import { isReportApprover } from "@/lib/services/bookkeeping-clients";
import { ownerQueue } from "@/lib/services/agreements";
import { pendingAcceptances } from "@/lib/services/accepted-returns";
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export default async function OwnerOverview({ searchParams }: { searchParams: Promise<{ year?: string }> }) {
  const { actor, access } = await requireOffice("revenue");
  const thisYear = Number(todayYmd().slice(0, 4));
  const year = Number((await searchParams).year) || thisYear;
  // Each section shows only to staff holding its permission (the owner sees everything).
  const mayAr = access.can("receivables", "view");
  const maySq = access.can("square", "view");
  const [{ months, total }, r, sq, health, other, clientChoices] = await Promise.all([monthlySummary(actor, year), mayAr ? receivables(actor) : null, maySq ? squareRevenueSummary() : null, maySq ? squareHealth() : null, maySq ? nonSquareRecurring(actor) : null, prisma.client.findMany({ where: { archivedAt: null }, select: { id: true, displayName: true, businessName: true }, orderBy: { displayName: "asc" } })]);
  // Agreements staff asked Tabitha to send, and recent signatures/declines (Tabitha only).
  const queue = (await isReportApprover(actor)) ? await ownerQueue() : null;
  const month = year === thisYear ? months[Number(todayYmd().slice(5, 7)) - 1] : null;
  // Owner only: returns null for staff (even with every grant) and while the review is 14+ days away.
  const reviewBanner = await accessReviewBanner(actor);
  // Returns staff delivered that wait for Tabitha's one-click acceptance confirmation.
  const toConfirm = (await isReportApprover(actor)) ? (await pendingAcceptances()).length : 0;
  return (
    <>
      {toConfirm > 0 && (
        <div className="mb-4" data-testid="owner-acceptance-notice">
          <Notice tone="warn" title={`${toConfirm} return${toConfirm === 1 ? "" : "s"} ready for you to confirm acceptance`}>
            Staff delivered {toConfirm === 1 ? "an accepted return" : "accepted returns"} that only you can record as submitted and accepted. <Link className="font-semibold underline" href="/taxes/returns#confirm-acceptance">Confirm them on Tax returns</Link>.
          </Notice>
        </div>
      )}
      <PageHeader
        title="Overview"
        subtitle="Invoiced revenue and cash collected are tracked separately. Unpaid invoices never count as cash."
        actions={
          <>
            {access.can("billing", "create") && <LinkButton href="/owner/invoices/create" variant="gold" className="px-5 text-base shadow-md" data-testid="create-invoice"><Plus className="size-5" aria-hidden /> Create Invoice</LinkButton>}
            {access.can("billing", "create") && <LinkButton href="/owner/invoices/new" variant="secondary">Itemized quote</LinkButton>}
            {access.can("revenue", "create") && <LinkButton href="/owner/expenses" variant="secondary">Add expense</LinkButton>}
          </>
        }
      />
      {reviewBanner && <AccessReviewBanner banner={reviewBanner} />}
      {queue && (queue.waiting.length > 0 || queue.recent.length > 0) && (
        <Card className="mb-4" title="Agreements for you" actions={<Link className="text-sm underline" href="/agreements">All agreements</Link>}>
          <ul className="divide-y divide-navy-100 text-sm" data-testid="owner-agreements">
            {queue.waiting.map((a) => (
              <li key={a.id} className="flex flex-wrap items-center justify-between gap-2 py-2"><span><Badge tone="gold">Waiting for you to send</Badge> <Link className="font-semibold underline" href={`/agreements/${a.id}`}>{a.title}</Link> · {a.clientLabel}</span><span className="text-slate-600">asked {fmtDateTime(a.requestedAt)}</span></li>
            ))}
            {queue.recent.map((a) => (
              <li key={a.id} className="flex flex-wrap items-center justify-between gap-2 py-2"><span><Badge tone={a.status === "SIGNED" ? "green" : "red"}>{a.status === "SIGNED" ? "Signed" : "Declined"}</Badge> <Link className="font-semibold underline" href={`/agreements/${a.id}`}>{a.title}</Link> · {a.clientLabel}</span><span className="text-slate-600">{fmtDateTime(a.signedAt ?? a.declinedAt)}</span></li>
            ))}
          </ul>
        </Card>
      )}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label={`Collected ${year}`} value={money(total.collectedCents - total.refundedCents)} hint={month ? `${money(month.collectedCents - month.refundedCents)} this month` : "Cash received, less refunds"} />
        <Stat label={`Invoiced ${year}`} value={money(total.invoicedCents)} hint="Accepted quotes and issued invoices" />
        <Stat label={`Expenses ${year}`} value={money(total.expensesCents)} hint={month ? `${money(month.expensesCents)} this month` : undefined} />
        {r && <Stat label="Outstanding now" value={money(r.totalOutstandingCents)} hint={`${r.clients.length} client${r.clients.length === 1 ? " owes" : "s owe"} a balance`} href="/owner/invoices?state=open" />}
      </div>

      {r && <div className="mt-6 grid gap-4 lg:grid-cols-[3fr_2fr]">
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
      </div>}

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
      {sq && health && other && <>
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
      <Card className="mt-4" title="Recurring billing (not in Square)">
        <p className="mb-3 text-sm text-slate-600">Clients on monthly billing who pay another way (cash, check, Zelle, Cash App, ACH…). Record each payment on the client&apos;s billing page; it shows here as paid.</p>
        <div className="mb-4 grid gap-3 sm:grid-cols-3" data-testid="owner-non-square-totals">
          <Stat label="Monthly recurring (not in Square)" value={money(other.totals.monthlyCents)} />
          <Stat label="Paid this month" value={money(other.totals.paidThisMonthCents)} />
          <Stat label="Past due" value={money(other.totals.overdueCents)} />
        </div>
        {other.rows.length === 0 ? (
          <p className="text-sm text-slate-600">No clients billed outside Square yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[40rem] text-sm" data-testid="owner-non-square">
              <thead><tr className="border-b border-navy-100 text-left"><th className="py-2">Client</th><th>Monthly</th><th>Due day</th><th>Paid this month</th><th>Still owed</th><th>Status</th></tr></thead>
              <tbody>
                {other.rows.map((o) => (
                  <tr key={o.clientId} className="border-b border-navy-50">
                    <td className="py-2"><Link className="underline" href={`/bookkeeping/${o.clientId}/profile`}>{o.name}</Link></td>
                    <td>{money(o.feeCents)}</td>
                    <td>{o.billingDay ?? "—"}</td>
                    <td>{money(o.paidThisMonthCents)}</td>
                    <td>{money(o.owedThisMonthCents)}</td>
                    <td>{o.status ? <Badge tone={o.status.tone}>{o.status.label}</Badge> : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <details className="mt-4 rounded-lg border border-ivory-200 p-3">
          <summary className="cursor-pointer font-semibold text-navy-900">+ Add a client not in Square</summary>
          <ActionForm action={addNonSquareRecurringAction} className="mt-3 grid gap-3 sm:grid-cols-2" resetOnSuccess>
            <Field label="Client"><select className="input" name="clientId" required defaultValue=""><option value="" disabled>Choose a client…</option>{clientChoices.map((c) => <option key={c.id} value={c.id}>{c.businessName || c.displayName}</option>)}</select></Field>
            <Field label="Monthly amount ($)"><input className="input" name="monthlyFee" inputMode="decimal" required placeholder="595.00" /></Field>
            <Field label="Due day of the month"><input className="input" name="billingDay" type="number" min={1} max={28} required defaultValue={1} /></Field>
            <Field label="First month billed"><input className="input" name="startMonth" type="month" required defaultValue={todayYmd().slice(0, 7)} /></Field>
            <Field label="Usually pays by"><select className="input" name="method" defaultValue="ZELLE">{Object.entries(PAY_METHODS).filter(([k]) => k !== "SQUARE").map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></Field>
            <Field label="Note (optional)"><input className="input" name="notes" maxLength={300} /></Field>
            <div className="sm:col-span-2"><Button type="submit">Add to recurring billing</Button></div>
          </ActionForm>
        </details>
      </Card>
      </>}
    </>
  );
}
