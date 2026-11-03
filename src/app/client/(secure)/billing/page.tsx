import { ActionForm } from "@/components/action-form";
import { Badge, Button, Card, EmptyState, Notice, PageHeader } from "@/components/ui";
import { acceptQuoteAction, declineQuoteAction } from "@/app/actions/portal-billing";
import { requirePortalUser } from "@/lib/portal/session";
import { resolveAccount } from "@/lib/portal/account";
import { portalBilling, quoteTermsHash } from "@/lib/services/owner-billing";
import { money } from "@/lib/billing/pricing";
import { METHOD_LABELS } from "@/lib/billing/labels";
import { fmtDate } from "@/lib/format";
import { prisma } from "@/lib/prisma";
import { NOT_SYNCED, portalSquareBilling } from "@/lib/services/square-billing";
import { PaymentPanel } from "@/components/portal/payment-panel";
import { MonthlyBillingCard, type BillingRow, type MonthlyBilling } from "@/components/portal/monthly-billing-card";
import { portalManualBilling } from "@/lib/services/manual-billing";

type SquareView = NonNullable<Awaited<ReturnType<typeof portalSquareBilling>>["view"]>;
type ManualView = NonNullable<Awaited<ReturnType<typeof portalManualBilling>>>;
const SQ_LABEL: Record<string, [string, BillingRow["tone"]]> = {
  PAID: ["Paid", "green"], PARTIALLY_PAID: ["Partly paid", "red"], FAILED: ["Payment failed", "red"], CANCELED: ["Canceled", "gray"],
  REFUNDED: ["Refunded", "gray"], PARTIALLY_REFUNDED: ["Partly refunded", "gray"], SCHEDULED: ["Upcoming", "navy"], UNPAID: ["Unpaid", "amber"], PAYMENT_PENDING: ["Pending", "amber"],
};
const ordinal = (d: number) => `${d}${d % 10 === 1 && d !== 11 ? "st" : d % 10 === 2 && d !== 12 ? "nd" : d % 10 === 3 && d !== 13 ? "rd" : "th"}`;

/** Square-billed: every figure from Square (this account's linked series only). */
function squareCard(v: SquareView, many = false): MonthlyBilling {
  const [schedule, due] = v.schedule.split(" · ");
  const upcoming = v.invoices.filter((i) => i.status === "SCHEDULED").sort((x, y) => x.due.localeCompare(y.due)).slice(0, 1);
  const lastPaid = v.invoices.find((i) => i.status === "PAID");
  return {
    title: `${v.title || "Monthly service"}${many ? ` · Series ${v.seriesKey}` : ""} · billed through Square`,
    amountCents: v.amountCents,
    schedule: schedule ?? "Monthly",
    dueDay: due ? due.replace(/^due/, "Due") : null,
    payWith: v.autopay ? (v.card ? `${v.card.brand} ending in ${v.card.last4}` : "Card on file") : "Pay each invoice",
    status: { label: v.status.label.replace(" in Square", ""), tone: v.status.tone as BillingRow["tone"] },
    next: v.nextDueDate ? { date: new Date(v.nextDueDate).toISOString(), amountCents: upcoming[0]?.amountCents ?? v.amountCents } : null,
    last: lastPaid ? { date: lastPaid.paidAt ?? lastPaid.due, amountCents: lastPaid.amountCents } : null,
    overdueCents: v.overdueCents,
    overdueNote: v.overdueCount ? `${v.overdueCount} invoice${v.overdueCount === 1 ? "" : "s"}` : null,
    rows: [
      ...upcoming.map((i) => ({ key: `next-${i.number ?? i.due}`, due: i.due, amountCents: i.amountCents, paidOn: null, status: "Upcoming", tone: "navy" as const, link: i.invoiceUrl ? { href: i.invoiceUrl, label: "Invoice" } : null, upcoming: true })),
      ...v.invoices.filter((i) => i.status !== "SCHEDULED").map((i) => ({
        key: i.number ?? i.due, due: i.due, amountCents: i.amountCents, paidOn: i.paidAt,
        detail: i.paidCents != null ? `$${(i.paidCents / 100).toFixed(2)} paid · $${(((i.amountCents ?? 0) - i.paidCents) / 100).toFixed(2)} due` : null,
        status: (SQ_LABEL[i.status] ?? ["Unpaid", "amber"])[0], tone: (SQ_LABEL[i.status] ?? ["Unpaid", "amber"])[1],
        link: i.receiptUrl ? { href: i.receiptUrl, label: "Receipt" } : i.invoiceUrl ? { href: i.invoiceUrl, label: "Invoice" } : null,
      })),
    ],
    source: `Shown from Square as of ${fmtDate(v.syncedAt)}. "Paid" appears only when Square confirms it. To change your card or schedule, send us a message.`,
  };
}

/** Office-billed: payments our office recorded for this account. */
function manualCard(v: ManualView): MonthlyBilling {
  return {
    title: "Monthly bookkeeping · billed by our office",
    amountCents: v.feeCents,
    schedule: "Monthly",
    dueDay: v.billingDay ? `Due on the ${ordinal(v.billingDay)}` : null,
    payWith: v.payments[0]?.method ?? null,
    status: v.status ? { label: v.status.label, tone: v.status.tone } : { label: "—", tone: "gray" },
    next: v.next ? { date: v.next.due, amountCents: v.next.amountCents } : null,
    last: v.payments[0] ? { date: v.payments[0].paidOn.toISOString(), amountCents: v.payments[0].amountCents } : null,
    overdueCents: v.overdueCents,
    rows: [
      ...(v.next ? [{ key: "next", due: v.next.due, amountCents: v.next.amountCents, paidOn: null, status: "Upcoming", tone: "navy" as const, upcoming: true }] : []),
      ...v.payments.map((p) => ({ key: p.id, due: `${p.periodMonth}-${String(v.billingDay ?? 1).padStart(2, "0")}`, amountCents: p.amountCents, paidOn: p.paidOn.toISOString(), detail: p.method, status: "Paid", tone: "green" as const })),
    ],
    source: "Payments recorded by our office. If something looks wrong, send us a message.",
  };
}

export const metadata = { title: "Billing" };

export default async function PortalBilling({ searchParams }: { searchParams: Promise<{ account?: string }> }) {
  const user = await requirePortalUser();
  const { current } = await resolveAccount(user.id, (await searchParams).account);
  if (!current) return null;
  if (!current.canViewBilling) {
    return (
      <>
        <PageHeader title="Billing" />
        <Notice>Billing isn&apos;t included in your access to this account.</Notice>
      </>
    );
  }
  const [items, sq, manual] = await Promise.all([portalBilling(user, current.clientId), portalSquareBilling(user, current.clientId), portalManualBilling(user, current.clientId)]);
  const client = await prisma.client.findUniqueOrThrow({ where: { id: current.clientId }, select: { displayName: true } });
  const methods = new Map((await prisma.invoice.findMany({ where: { id: { in: items.map((i) => i.id) } }, select: { id: true, paymentMethod: true } })).map((i) => [i.id, i.paymentMethod]));
  return (
    <>
      <PageHeader title="Billing" subtitle="Quotes and invoices from TTurner & Associates Group for this account." />
      {sq.state !== "NONE" && (!sq.view || sq.unsynced > 0) && (
        <Card className="mb-6" title={sq.view ? "More billing from Square" : "Your monthly billing"}>
          <div data-testid={sq.view ? "portal-square-billing-pending" : "portal-square-billing"}>
            <p><Badge tone="amber">{NOT_SYNCED}</Badge></p>
            <p className="mt-2 text-sm text-slate-700">Your recurring billing with our office continues in Square exactly as arranged. There&apos;s nothing to authorize or update here, and nothing new will be charged.</p>
          </div>
        </Card>
      )}
      {sq.views.length > 1 && <p className="mb-3 text-sm text-slate-700" data-testid="portal-square-count">You have {sq.views.length} recurring bills with our office in Square. Each is shown separately with its own payments.</p>}
      {sq.views.map((v, i) => (
        <div key={v.id}>
          <MonthlyBillingCard testId={i === 0 ? "portal-square-billing" : `portal-square-billing-${i + 1}`} b={squareCard(v, sq.views.length > 1)} showHeading={i === 0} />
          {(v.alsoCovers.length > 0 || v.otherAccounts > 0) && (
            <p className="-mt-3 mb-6 text-sm" data-testid="portal-square-covers">This one bill also covers {[...v.alsoCovers, ...(v.otherAccounts ? [`${v.otherAccounts} other account${v.otherAccounts === 1 ? "" : "s"}`] : [])].join(", ")} — you&apos;re charged once per cycle.</p>
          )}
        </div>
      ))}
      {manual && <MonthlyBillingCard testId="portal-manual-billing" b={manualCard(manual)} />}
      {items.length === 0 && sq.state === "NONE" && !manual && <EmptyState title="Nothing here yet">Quotes and invoices we send you will appear here.</EmptyState>}
      <div className="space-y-4">
        {items.map((inv) => (
          <Card
            key={inv.id}
            title={<>{inv.title} <span className="text-sm font-normal text-slate-600">· {inv.number}</span></>}
            actions={
              inv.state === "OFFERED" ? <Badge tone="gold">Ready for your review</Badge> : inv.state === "DECLINED" ? <Badge tone="gray">Declined</Badge> : inv.balanceCents === 0 ? <Badge tone="green">Paid in full</Badge> : <Badge tone="navy">Balance {money(inv.balanceCents ?? 0)}</Badge>
            }
          >
            <table className="w-full text-sm">
              <tbody className="divide-y divide-navy-100">
                {inv.breakdown.lines.map((l, i) => (
                  <tr key={i}><td className="py-1.5">{l.service}{l.description && <span className="block text-xs text-slate-600">{l.description}</span>}{l.quantity > 1 && <span className="block text-xs text-slate-600">{l.quantity} × {money(l.unitCents)}</span>}</td><td className="text-right">{money(l.amountCents)}</td></tr>
                ))}
                <tr><td className="py-1.5">Original price</td><td className="text-right">{money(inv.breakdown.subtotalCents)}</td></tr>
                {inv.breakdown.serviceDiscountCents > 0 && <tr><td className="py-1.5">Discount</td><td className="text-right">−{money(inv.breakdown.serviceDiscountCents)}</td></tr>}
                <tr><td className="py-1.5">Sales tax</td><td className="text-right">{inv.breakdown.taxCents ? money(inv.breakdown.taxCents) : "None"}</td></tr>
              </tbody>
            </table>

            {inv.state === "OFFERED" ? (
              <ActionForm action={acceptQuoteAction.bind(null, inv.id)} className="mt-4 space-y-3">
                <fieldset className="grid gap-3 sm:grid-cols-2">
                  <legend className="mb-2 font-semibold text-navy-900">Choose how you&apos;d like to pay</legend>
                  {(["FULL", "PLAN"] as const).map((k) => {
                    const o = inv.breakdown.options[k];
                    if (!o) return null;
                    const hash = quoteTermsHash(inv, client.displayName, inv.breakdown, k);
                    return (
                      <label key={k} className="block cursor-pointer rounded-xl border-2 border-navy-100 p-4 has-[:checked]:border-gold-500 has-[:checked]:bg-ivory">
                        <span className="flex items-center gap-2 font-semibold"><input type="radio" name="choice" value={`${k}|${hash}`} required /> {k === "FULL" ? "Pay in full" : "Payment plan"}</span>
                        <dl className="mt-2 space-y-0.5 text-sm">
                          <div className="flex justify-between font-bold text-navy-900"><dt>Final total</dt><dd>{money(o.totalCents)}</dd></div>
                        </dl>
                        <ul className="mt-2 space-y-0.5 text-xs text-slate-700">
                          {o.schedule.map((s) => <li key={s.seq} className="flex justify-between"><span>{s.label} — due {fmtDate(new Date(`${s.dueDate}T12:00:00Z`))}</span><span>{money(s.amountCents)}</span></li>)}
                        </ul>
                      </label>
                    );
                  })}
                </fieldset>
                <ul className="list-disc space-y-0.5 pl-5 text-xs text-slate-600">{inv.breakdown.explanation.map((e) => <li key={e}>{e}</li>)}</ul>
                {inv.paymentTerms && <p className="whitespace-pre-line rounded-lg bg-navy-50 p-3 text-sm"><strong>Payment terms: </strong>{inv.paymentTerms}</p>}
                <label className="flex items-start gap-2 text-sm">
                  <input type="checkbox" name="agree" required className="mt-1" />
                  <span>I accept this quote and the payment option I selected, including the total and due dates shown. I understand nothing will be charged automatically.</span>
                </label>
                <Button type="submit">Accept quote</Button>
              </ActionForm>
            ) : inv.schedule.length > 0 ? (
              <div className="mt-4">
                {inv.acceptedAt && (
                  <p className="mb-3 rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-900" role="status">
                    ✓ You accepted the {inv.acceptedOption === "PLAN" ? "payment plan" : "full-payment option"} on {fmtDate(inv.acceptedAt)}. Nothing is charged automatically.
                  </p>
                )}
                <p className="mb-2 text-sm"><strong>{inv.acceptedOption === "PLAN" ? "Payment plan" : "Full payment"}</strong> · Total {money(inv.totalCents ?? 0)}</p>
                <table className="w-full text-sm">
                  <thead className="text-left text-slate-600"><tr><th className="py-1">Payment</th><th>Due</th><th className="text-right">Amount</th><th className="text-right">Remaining</th></tr></thead>
                  <tbody className="divide-y divide-navy-100">
                    {inv.schedule.map((s) => (
                      <tr key={s.seq}><td className="py-1.5">{s.label}</td><td>{fmtDate(new Date(`${s.dueDate}T12:00:00Z`))}</td><td className="text-right">{money(s.amountCents)}</td><td className="text-right">{s.dueCents === 0 ? <Badge tone="green">Paid</Badge> : s.state === "OVERDUE" ? <Badge tone="red">{money(s.dueCents)} past due</Badge> : money(s.dueCents)}</td></tr>
                    ))}
                  </tbody>
                </table>
                {inv.payments.length > 0 && (
                  <p className="mt-2 text-xs text-slate-600">Payments received: {inv.payments.map((p) => `${p.kind === "REFUND" ? "refund " : ""}${money(p.amountCents)} on ${p.receivedOn} (${METHOD_LABELS[p.method]})`).join("; ")}</p>
                )}
              </div>
            ) : null}
            {inv.state === "OFFERED" && (
              <ActionForm action={declineQuoteAction.bind(null, inv.id)} confirm="Decline this quote?" className="mt-2">
                <Button variant="ghost">Decline</Button>
              </ActionForm>
            )}
            {inv.state !== "DECLINED" && (inv.balanceCents ?? 1) > 0 && (
              <PaymentPanel clientId={current.clientId} invoice={{ id: inv.id, serviceCents: inv.breakdown.options.FULL?.totalCents ?? inv.breakdown.lines.reduce((a, l) => a + l.amountCents, 0), paymentMethod: methods.get(inv.id) ?? null }} />
            )}
            {inv.memo && <p className="mt-3 text-sm text-slate-700">{inv.memo}</p>}
          </Card>
        ))}
      </div>
      <p className="mt-6 text-xs text-slate-600">Online payment isn&apos;t available in the portal yet. Pay the way we&apos;ve arranged with you; we&apos;ll record it here once received. Questions? Use Messages.</p>
    </>
  );
}
