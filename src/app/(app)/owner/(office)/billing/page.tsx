import Link from "next/link";
import { Plus } from "lucide-react";
import { Badge, Card, LinkButton, PageHeader, Stat } from "@/components/ui";
import { requireOffice } from "@/lib/auth/owner";
import { billingDashboard, CADENCES, SCHEDULE_KINDS, SCHEDULE_STATUS, type Cadence, type ScheduleKind, type ScheduleRow } from "@/lib/services/billing-schedules";
import { openInvoiceRequests, REQUEST_STATUS } from "@/lib/services/invoice-requests";
import { nameOf, paymentStatus, squareRevenueSummary } from "@/lib/services/square-billing";
import { STATE_LABELS } from "@/lib/billing/labels";
import { money } from "@/lib/billing/pricing";
import { fmtDate, fmtDateTime } from "@/lib/format";

export const metadata = { title: "Billing dashboard" };

const sectionTitle = (n: number, t: string) => <span className="flex items-center gap-2"><span className="flex size-6 items-center justify-center rounded-full bg-navy-900 text-xs font-bold text-gold-300">{n}</span>{t}</span>;

function ScheduleTable({ rows, plan }: { rows: ScheduleRow[]; plan: boolean }) {
  if (!rows.length) return <p className="text-sm text-slate-600">{plan ? "No payment plans yet. On Create Invoice, choose Deposit or Installment plan." : "No recurring schedules yet. On Create Invoice, choose Make this recurring."}</p>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[48rem] text-sm [&_td]:px-2 [&_th]:px-2 [&_td:first-child]:pl-0 [&_th:first-child]:pl-0" data-testid={plan ? "plan-rows" : "recurring-rows"}>
        <thead className="text-left text-slate-600">
          <tr><th className="py-1">Client</th><th>For</th><th>{plan ? "Plan" : "Schedule"}</th><th>Status</th>{plan ? <><th className="text-right">Total</th><th className="text-right">Paid</th><th className="text-right">Remaining</th></> : <><th className="text-right">Each</th><th className="text-right">Invoiced</th><th className="text-right">Outstanding</th></>}<th className="pl-4">Next</th></tr>
        </thead>
        <tbody className="divide-y divide-navy-100">
          {rows.map((s) => (
            <tr key={s.id} data-testid="schedule-row">
              <td className="py-2"><Link className="font-semibold underline" href={`/owner/billing/schedules/${s.id}`}>{s.clientName}</Link></td>
              <td>{s.service}</td>
              <td>{plan ? SCHEDULE_KINDS[s.kind as ScheduleKind] : `${CADENCES[s.cadence as Cadence]?.label ?? ""}${s.endDate ? ` until ${fmtDate(s.endDate)}` : s.maxInvoices ? ` × ${s.maxInvoices}` : ""}`}{s.autoSend && <Badge tone="navy" className="ml-1">Auto-send</Badge>}</td>
              <td><Badge tone={SCHEDULE_STATUS[s.status].tone}>{SCHEDULE_STATUS[s.status].label}</Badge>{s.drafts > 0 && <span className="ml-1 text-xs text-slate-600">{s.drafts} draft{s.drafts === 1 ? "" : "s"} to review</span>}</td>
              {plan ? (
                <><td className="text-right">{money(s.totalCents ?? 0)}</td><td className="text-right">{money(s.paidCents)}</td><td className="text-right font-semibold">{money(s.remainingCents ?? 0)}</td></>
              ) : (
                <><td className="text-right">{money(s.amountCents ?? 0)}</td><td className="text-right">{money(s.invoicedCents)}</td><td className="text-right font-semibold">{money(s.outstandingCents)}</td></>
              )}
              <td className="pl-4 text-slate-700">{s.nextDate ? `${s.nextDate}${s.nextAmountCents ? ` · ${money(s.nextAmountCents)}` : ""}` : "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * The Owner's Office billing dashboard: four separate sections with their own totals. A firm invoice
 * counts in exactly one of sections 2–4; section 1 (Square bookkeeping subscriptions) is read-only
 * figures from the last Square sync and is never added to the others.
 */
export default async function BillingDashboardPage() {
  const { actor, access } = await requireOffice("billing");
  const maySq = access.can("square", "view");
  const [d, sq, requests] = await Promise.all([billingDashboard(actor), maySq ? squareRevenueSummary() : null, openInvoiceRequests()]);
  return (
    <>
      <PageHeader
        title="Billing dashboard"
        subtitle="Bookkeeping subscriptions in Square, tax & individual invoices, payment plans and recurring invoice schedules — each counted once, in its own section."
        actions={access.can("billing", "create") && <LinkButton href="/owner/invoices/create" variant="gold" data-testid="create-invoice"><Plus className="size-4" aria-hidden /> Create Invoice</LinkButton>}
      />

      {requests.length > 0 && (
        <Card className="mb-4" title="Invoice requests from clients">
          <ul className="divide-y divide-ivory-200 text-sm" data-testid="dashboard-requests">
            {requests.map((r) => (
              <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <Link className="min-w-0 font-medium text-navy-900 underline" href={`/clients/${r.clientId}?tab=messages&c=${r.conversationId}`}>{r.title}</Link>
                <span className="flex items-center gap-2 text-xs text-slate-500"><Badge tone={REQUEST_STATUS[r.status].tone}>{REQUEST_STATUS[r.status].label}</Badge>{fmtDateTime(r.createdAt)}</span>
              </li>
            ))}
          </ul>
        </Card>
      )}

      {sq && (
        <Card className="mb-4" title={sectionTitle(1, "Bookkeeping subscriptions (Square)")} actions={<Link className="text-sm underline" href="/bookkeeping/square-billing">Square billing</Link>}>
          <div data-testid="section-square">
            <p className="mb-3 text-sm text-slate-600">Read only, from the last verified Square sync of {sq.linked} active series. Client Connect never changes, pauses or re-syncs these from here. {sq.oldestSync ? <>Oldest sync: {fmtDateTime(sq.oldestSync)}.</> : "Nothing synced yet."}</p>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <Stat label="Monthly recurring (Square)" value={money(sq.recurringMonthlyCents)} />
              <Stat label={`Paid, due ${sq.month}`} value={money(sq.paidThisMonthCents)} />
              <Stat label="Outstanding (Square)" value={money(sq.outstandingCents)} />
              <Stat label="Overdue (Square)" value={money(sq.overdueCents)} />
            </div>
            {sq.attention.length > 0 && <p className="mt-3 text-sm">{sq.attention.map((a) => <span key={a.id} className="mr-3">{a.members.map((m) => nameOf(m.client)).join(", ")} <Badge tone={paymentStatus(a).tone}>{paymentStatus(a).label}</Badge></span>)}</p>}
          </div>
        </Card>
      )}

      <Card className="mb-4" title={sectionTitle(2, "Tax & individual invoices")} actions={<Link className="text-sm underline" href="/owner/invoices">All quotes &amp; invoices</Link>}>
        <div data-testid="section-tax">
          <p className="mb-3 text-sm text-slate-600">One-time invoices and quotes for tax preparation and other individually billed work. Invoices made by a plan or schedule are counted in their own section below, not here.</p>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Stat label="Invoiced (sent)" value={money(d.tax.invoicedCents)} />
            <Stat label="Collected" value={money(d.tax.collectedCents)} />
            <Stat label="Outstanding" value={money(d.tax.outstandingCents)} />
            <Stat label="Drafts to review" value={String(d.tax.drafts)} />
          </div>
          {d.tax.recent.length > 0 && (
            <ul className="mt-3 divide-y divide-ivory-200 text-sm">
              {d.tax.recent.map((i) => <li key={i.id} className="flex flex-wrap justify-between gap-2 py-1.5"><span><Link className="font-semibold underline" href={`/owner/invoices/${i.id}`}>{i.number}</Link> · {i.clientName} · {i.title}</span><span className="text-slate-600">{STATE_LABELS[i.state]?.label ?? i.state} · {money(i.totalCents)}</span></li>)}
            </ul>
          )}
        </div>
      </Card>

      <Card className="mb-4" title={sectionTitle(3, "Payment plans (deposits & installments)")}>
        <div data-testid="section-plans">
          <div className="mb-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Stat label="Plan totals" value={money(d.plans.totals.totalCents)} hint={`${d.plans.totals.count} plan${d.plans.totals.count === 1 ? "" : "s"}`} />
            <Stat label="Paid" value={money(d.plans.totals.paidCents)} />
            <Stat label="Remaining" value={money(d.plans.totals.remainingCents)} />
            <Stat label="Awaiting Tabitha's approval" value={String(d.plans.totals.awaiting)} />
          </div>
          <ScheduleTable rows={d.plans.rows} plan />
        </div>
      </Card>

      <Card className="mb-4" title={sectionTitle(4, "Recurring invoice schedules")}>
        <div data-testid="section-recurring">
          <p className="mb-3 text-sm text-slate-600">Each cycle is one Client Connect invoice (a draft for review unless Tabitha turned on automatic sending), sent through the normal send path. No Square subscriptions are created.</p>
          <div className="mb-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Stat label="Monthly equivalent (active)" value={money(d.recurring.totals.monthlyCents)} hint={`${d.recurring.totals.count} active`} />
            <Stat label="Invoiced (sent)" value={money(d.recurring.totals.invoicedCents)} />
            <Stat label="Outstanding" value={money(d.recurring.totals.outstandingCents)} />
            <Stat label="Awaiting Tabitha's approval" value={String(d.recurring.totals.awaiting)} />
          </div>
          <ScheduleTable rows={d.recurring.rows} plan={false} />
        </div>
      </Card>
    </>
  );
}
