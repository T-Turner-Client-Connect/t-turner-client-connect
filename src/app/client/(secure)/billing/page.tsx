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
  const [items, sq] = await Promise.all([portalBilling(user, current.clientId), portalSquareBilling(user, current.clientId)]);
  const client = await prisma.client.findUniqueOrThrow({ where: { id: current.clientId }, select: { displayName: true } });
  return (
    <>
      <PageHeader title="Billing" subtitle="Quotes and invoices from TTurner & Associates Group for this account." />
      {sq.state !== "NONE" && (
        <Card title="Monthly billing" className="mb-4">
          <div data-testid="portal-square-billing">
            {!sq.view ? (
              <>
                <p><Badge tone="amber">{NOT_SYNCED}</Badge></p>
                <p className="mt-2 text-sm text-slate-700">Your recurring billing with our office continues in Square exactly as arranged. There&apos;s nothing to authorize or update here, and nothing new will be charged.</p>
              </>
            ) : (
              <>
                <dl className="grid gap-3 text-sm sm:grid-cols-2">
                  <div><dt className="text-xs uppercase tracking-wide text-slate-500">{sq.view.title || "Monthly service"}</dt><dd className="text-lg font-semibold text-navy-900">{sq.view.amountCents == null ? "—" : money(sq.view.amountCents)}</dd></div>
                  <div><dt className="text-xs uppercase tracking-wide text-slate-500">Schedule</dt><dd>{sq.view.schedule}</dd></div>
                  <div><dt className="text-xs uppercase tracking-wide text-slate-500">Next invoice</dt><dd>{sq.view.nextDueDate ? fmtDate(sq.view.nextDueDate) : "None scheduled"}</dd></div>
                  <div><dt className="text-xs uppercase tracking-wide text-slate-500">Status</dt><dd><Badge tone={sq.view.status.tone}>{sq.view.status.label.replace(" in Square", "")}</Badge></dd></div>
                  {sq.view.card && <div><dt className="text-xs uppercase tracking-wide text-slate-500">Automatic payment</dt><dd>{sq.view.card.brand} ending in {sq.view.card.last4}</dd></div>}
                  {sq.view.authorizationVerified && <div><dt className="text-xs uppercase tracking-wide text-slate-500">Authorization</dt><dd>On file with Square — nothing new is needed</dd></div>}
                </dl>
                {(sq.view.alsoCovers.length > 0 || sq.view.otherAccounts > 0) && (
                  <p className="mt-3 text-sm" data-testid="portal-square-covers">This one bill also covers {[...sq.view.alsoCovers, ...(sq.view.otherAccounts ? [`${sq.view.otherAccounts} other account${sq.view.otherAccounts === 1 ? "" : "s"}`] : [])].join(", ")} — you&apos;re charged once per cycle.</p>
                )}
                <p className="mt-3 text-xs text-slate-600">Shown from Square as of {fmtDate(sq.view.syncedAt)}. Billing runs in Square as arranged; to change your card or schedule, send us a message.</p>
              </>
            )}
          </div>
        </Card>
      )}
      {items.length === 0 && sq.state === "NONE" && <EmptyState title="Nothing here yet">Quotes and invoices we send you will appear here.</EmptyState>}
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
                          {k === "PLAN" && <div className="flex justify-between"><dt>Payment-plan fee</dt><dd>{money(o.planFeeCents)}</dd></div>}
                          {o.planFeeDiscountCents > 0 && <div className="flex justify-between"><dt>Discount on plan fee</dt><dd>−{money(o.planFeeDiscountCents)}</dd></div>}
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
            {inv.memo && <p className="mt-3 text-sm text-slate-700">{inv.memo}</p>}
          </Card>
        ))}
      </div>
      <p className="mt-6 text-xs text-slate-600">Online payment isn&apos;t available in the portal yet. Pay the way we&apos;ve arranged with you; we&apos;ll record it here once received. Questions? Use Messages.</p>
    </>
  );
}
