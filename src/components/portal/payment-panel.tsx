import { ActionForm } from "@/components/action-form";
import { Badge, Button } from "@/components/ui";
import { portalAcceptPlanAction, portalChooseMethodAction, portalRequestPlanAction } from "@/app/actions/installment-plans";
import { prisma } from "@/lib/prisma";
import { PAY_METHODS, PLAN_CONSENT, PLAN_STATUS, planOptions, type PayMethod, type PlanStatus } from "@/lib/services/installment-plans";
import { usd } from "@/lib/billing/payment-fees";

type Inst = { seq: number; dueDate: string; amountCents: number };

/**
 * For one invoice: the selected payment method with its instructions (one
 * method per invoice; changes go to the owner), or a request for an in-house
 * plan showing only the terms the amount qualifies for — fee shown
 * separately, then the deposit and every installment — before accepting.
 */
export async function PaymentPanel({ clientId, invoice }: { clientId: string; invoice: { id: string; serviceCents: number; paymentMethod: string | null } }) {
  const [instructions, plan, pending] = await Promise.all([
    prisma.paymentInstruction.findMany({ where: { active: true } }),
    prisma.installmentPlan.findFirst({ where: { invoiceId: invoice.id, status: { notIn: ["DECLINED", "CANCELLED"] } }, orderBy: { createdAt: "desc" } }),
    prisma.paymentMethodChange.findFirst({ where: { invoiceId: invoice.id, status: "PENDING" } }),
  ]);
  const declined = !plan ? await prisma.installmentPlan.findFirst({ where: { invoiceId: invoice.id, status: "DECLINED" }, orderBy: { createdAt: "desc" } }) : null;

  if (plan) {
    const sched = plan.schedule as unknown as Inst[];
    return (
      <div className="mt-4 rounded-xl border border-gold-300 bg-ivory-50 p-4 text-sm" data-testid="plan-panel">
        <p className="mb-2 flex flex-wrap items-center gap-2 font-semibold text-navy-900">In-house payment plan <Badge tone={plan.status === "PENDING_APPROVAL" ? "gold" : plan.status === "PAID_IN_FULL" ? "green" : "amber"}>{PLAN_STATUS[plan.status as PlanStatus]}</Badge></p>
        <table className="mb-2 w-full" data-testid="plan-terms">
          <tbody>
            <tr><td>Service price</td><td className="text-right">{usd(plan.serviceCents)}</td></tr>
            <tr><td>Card processing fee ({plan.card === "CARD_DEBIT" ? "debit card — no fee" : "credit card"})</td><td className="text-right">{usd(plan.feeCents)}</td></tr>
            <tr className="font-semibold"><td>Total</td><td className="text-right">{usd(plan.totalCents)}</td></tr>
            <tr><td>Deposit (30%), due when the plan is approved</td><td className="text-right">{usd(plan.depositCents)}</td></tr>
            {sched.map((i) => <tr key={i.seq}><td>Installment {i.seq} — due {i.dueDate}</td><td className="text-right">{usd(i.amountCents)}</td></tr>)}
            <tr><td>Paid so far</td><td className="text-right">{usd(plan.paidCents)}</td></tr>
            <tr className="font-semibold"><td>Remaining balance</td><td className="text-right">{usd(plan.totalCents - plan.paidCents)}</td></tr>
          </tbody>
        </table>
        {plan.status === "REQUESTED" ? (
          <ActionForm action={portalAcceptPlanAction.bind(null, plan.id)} className="space-y-2">
            <input type="hidden" name="termsHash" value={plan.termsHash} />
            <label className="flex items-start gap-2"><input type="checkbox" name="agree" className="mt-1" required /><span>{PLAN_CONSENT}</span></label>
            <label className="block"><span className="mb-1 block font-semibold">Type your full name</span><input className="input" name="name" autoComplete="name" required /></label>
            <Button type="submit">Accept plan and send for approval</Button>
          </ActionForm>
        ) : plan.status === "PENDING_APPROVAL" ? (
          <p>Waiting for our office to approve. Nothing is charged until it&apos;s approved and you authorize your card.</p>
        ) : plan.status === "APPROVED" ? (
          <p>Approved. Next, you&apos;ll authorize your card on file through Square&apos;s secure form — we never see or store your card number. No charge happens before that.</p>
        ) : null}
      </div>
    );
  }

  const current = invoice.paymentMethod as PayMethod | null;
  const shown = instructions.filter((i) => i.method !== "IN_HOUSE_PLAN" && i.method !== "REFUND_TRANSFER");
  const instr = current ? instructions.find((i) => i.method === current) : null;
  const [credit, debit] = await Promise.all([planOptions(invoice.serviceCents, "CARD_CREDIT"), planOptions(invoice.serviceCents, "CARD_DEBIT")]);

  return (
    <div className="mt-4 rounded-xl border border-ivory-200 p-4 text-sm" data-testid="payment-panel">
      <p className="mb-2 font-semibold text-navy-900">How you&apos;ll pay</p>
      {declined && <p className="mb-2 rounded-lg bg-amber-50 p-2 text-amber-900">Your payment plan request wasn&apos;t approved: {declined.declineReason}</p>}
      {current && (
        <div className="mb-3 rounded-lg bg-ivory-50 p-3" data-testid="selected-method">
          <p><strong>{PAY_METHODS[current]?.label}</strong> · {PAY_METHODS[current]?.fee}</p>
          {instr && <p className="mt-1 whitespace-pre-line">{instr.details}</p>}
          {pending && <p className="mt-1 text-xs text-amber-800">Change to {PAY_METHODS[pending.toMethod as PayMethod]?.label} requested — waiting for our office.</p>}
        </div>
      )}
      {shown.length > 0 && !pending && (
        <ActionForm action={portalChooseMethodAction.bind(null, invoice.id)} className="mb-3 flex flex-wrap items-end gap-2">
          <label className="block"><span className="mb-1 block text-xs font-semibold">{current ? "Request a different method" : "Choose your payment method"}</span>
            <select className="input" name="method" defaultValue="" required><option value="" disabled>Choose</option>{shown.filter((i) => i.method !== current).map((i) => <option key={i.method} value={i.method}>{i.label}</option>)}</select>
          </label>
          {current && <input className="input w-56" name="reason" placeholder="Reason (optional)" aria-label="Reason" />}
          <Button type="submit" variant="secondary">{current ? "Request change" : "Save"}</Button>
        </ActionForm>
      )}
      <details data-testid="plan-request">
        <summary className="cursor-pointer font-semibold underline">Request an in-house payment plan</summary>
        <p className="mt-2 text-xs text-slate-600">30% deposit, then equal monthly payments on a card kept on file. No fee for choosing a plan; a credit-card processing fee applies only where permitted (never on debit cards). Every plan needs our office&apos;s approval.</p>
        <div className="mt-2 grid gap-3 sm:grid-cols-2">
          {([["CARD_CREDIT", "Credit card", credit], ["CARD_DEBIT", "Debit card", debit]] as const).map(([card, label, opts]) => (
            <div key={card} className="rounded-lg bg-ivory-50 p-3" data-testid={`plan-options-${card}`}>
              <p className="mb-1 font-semibold">{label}</p>
              {opts.map((o) => (
                <ActionForm key={o.months} action={portalRequestPlanAction.bind(null, clientId, invoice.id)} className="mb-2 border-b border-ivory-200 pb-2">
                  <input type="hidden" name="months" value={o.months} />
                  <input type="hidden" name="card" value={card} />
                  <p className="text-xs">{o.months} months · fee {usd(o.feeCents)} · total {usd(o.totalCents)} · deposit {usd(o.depositCents)} · {o.installments.map((i) => usd(i.amountCents)).join(" / ")}</p>
                  <Button type="submit" variant="ghost">Review this plan</Button>
                </ActionForm>
              ))}
            </div>
          ))}
        </div>
      </details>
    </div>
  );
}
