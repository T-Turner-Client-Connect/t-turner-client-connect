import Link from "next/link";
import { ActionForm } from "@/components/action-form";
import { Badge, Button, Card, EmptyState, Field, PageHeader } from "@/components/ui";
import { approvePlanAction, declinePlanAction, methodChangeDecisionAction, planPaymentAction, waiveFeeAction } from "@/app/actions/installment-plans";
import { requireOffice } from "@/lib/auth/owner";
import { chargeAllowed, lateFeePolicy, PAY_METHODS, PLAN_STATUS, planProgress, planQueue, type PayMethod, type PlanStatus } from "@/lib/services/installment-plans";
import { usd } from "@/lib/billing/payment-fees";
import { fmtDateTime } from "@/lib/format";

export const metadata = { title: "Payment plans" };

const TONE: Record<string, "gray" | "amber" | "green" | "red" | "gold"> = { REQUESTED: "gray", PENDING_APPROVAL: "gold", APPROVED: "amber", DEPOSIT_PENDING: "amber", ACTIVE: "green", PAST_DUE: "red", PAID_IN_FULL: "green", DECLINED: "gray" };
const today = () => new Date().toLocaleDateString("en-CA", { timeZone: "America/Chicago" });

/** Owner's Office → Payment plans: approvals, progress and payment-method changes. */
export default async function PlansPage() {
  const { actor, access } = await requireOffice("billing");
  const [{ plans, changes }, policy] = await Promise.all([planQueue(actor), lateFeePolicy()]);
  const full = access.can("billing", "approve");
  const mayPay = access.can("billing", "record_payment");
  const mayWaive = access.can("billing", "adjust");
  const waiting = plans.filter((p) => p.status === "PENDING_APPROVAL");
  return (
    <>
      <PageHeader title="Payment plans" subtitle="In-house plans: 30% deposit, then equal monthly installments. Nothing is charged until the client accepts, you approve, and their card on file is authorized." />
      <p className="mb-4 text-sm" data-testid="late-fee-state">Late fees: <Badge tone={policy.enabled ? "red" : "gray"}>{policy.enabled ? "On" : "Off"}</Badge> <Link className="underline" href="/owner/settings">Billing settings</Link></p>

      <Card title={`Waiting for your approval — ${waiting.length}`} className="mb-4">
        {waiting.length === 0 ? <p className="text-sm text-slate-600">None.</p> : (
          <ul className="space-y-4" data-testid="plans-pending">
            {waiting.map((p) => (
              <li key={p.id} className="rounded-xl bg-ivory-50 p-3 text-sm" data-plan={p.title}>
                <p className="font-semibold">{p.client.displayName} · {p.title}</p>
                <p>Service {usd(p.serviceCents)} + card fee {usd(p.feeCents)} ({p.card === "CARD_DEBIT" ? "debit — no fee" : "credit"}) = <strong>{usd(p.totalCents)}</strong> · deposit {usd(p.depositCents)} · {p.months} monthly installments</p>
                <ul className="my-1 text-xs">{(p.schedule as { seq: number; dueDate: string; amountCents: number }[]).map((i) => <li key={i.seq}>Installment {i.seq}: {usd(i.amountCents)} due {i.dueDate}</li>)}</ul>
                <p className="text-xs">Client accepted {p.acceptedAt ? `${fmtDateTime(p.acceptedAt)} as “${p.acceptedName}”` : "—"} · Card on file: {p.cardAuthorizedAt ? `authorized (${p.verifiedCardType})` : "not authorized yet"}</p>
                {full ? (
                  <div className="mt-2 flex flex-wrap gap-2">
                    <ActionForm action={approvePlanAction.bind(null, p.id)}><Button type="submit" variant="gold">Approve plan</Button></ActionForm>
                    <ActionForm action={declinePlanAction.bind(null, p.id)} className="flex gap-1"><input className="input" name="reason" placeholder="Reason (shown to client)" required /><Button type="submit" variant="ghost">Decline</Button></ActionForm>
                  </div>
                ) : <p className="mt-1 text-xs text-slate-600">Approving plans needs the owner&apos;s permission (Billing → Approve).</p>}
              </li>
            ))}
          </ul>
        )}
      </Card>

      {changes.length > 0 && (
        <Card title="Payment-method change requests" className="mb-4">
          <ul className="space-y-2 text-sm" data-testid="method-changes">
            {changes.map((c) => (
              <li key={c.id} className="flex flex-wrap items-center gap-2">
                {PAY_METHODS[c.fromMethod as PayMethod]?.label ?? "—"} → <strong>{PAY_METHODS[c.toMethod as PayMethod]?.label}</strong>{c.reason ? ` · “${c.reason}”` : ""} · {fmtDateTime(c.createdAt)}
                {full && <ActionForm action={methodChangeDecisionAction.bind(null, c.id, true)}><Button type="submit" variant="secondary">Approve</Button></ActionForm>}
                {full && <ActionForm action={methodChangeDecisionAction.bind(null, c.id, false)}><Button type="submit" variant="ghost">Decline</Button></ActionForm>}
              </li>
            ))}
          </ul>
        </Card>
      )}

      <Card title="All plans">
        {plans.length === 0 ? <EmptyState title="No plans yet">Clients request plans from an invoice in their portal.</EmptyState> : (
          <ul className="divide-y divide-ivory-200" data-testid="plans-all">
            {plans.map((p) => {
              const prog = planProgress(p, today(), policy);
              const gate = chargeAllowed(p);
              return (
                <li key={p.id} className="py-3 text-sm">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span><strong>{p.client.displayName}</strong> · {p.title} · {usd(p.totalCents)} · paid {usd(p.paidCents)} · balance {usd(prog.balanceCents)}{prog.overdueCents ? ` · ${usd(prog.overdueCents)} past due` : ""}{prog.lateFeesCents ? ` · late fees ${usd(prog.lateFeesCents)}` : ""}</span>
                    <Badge tone={TONE[prog.status] ?? "gray"}>{PLAN_STATUS[prog.status as PlanStatus]}</Badge>
                  </div>
                  <p className="text-xs text-slate-600">{gate.ok ? "Automatic charges allowed." : `No automatic charges: ${gate.reason}`}</p>
                  {p.approvedAt && prog.balanceCents > 0 && (
                    <div className="mt-1 flex flex-wrap gap-3">
                      {mayPay && <ActionForm action={planPaymentAction.bind(null, p.id)} className="flex flex-wrap items-end gap-1" resetOnSuccess>
                        <Field label="Record a verified payment"><input className="input w-28" name="amount" inputMode="decimal" placeholder="$0.00" required /></Field>
                        <input className="input w-44" name="note" placeholder="How it was verified" aria-label="Note" />
                        <Button type="submit" variant="secondary">Record</Button>
                      </ActionForm>}
                      {mayWaive && prog.lateFeesCents > 0 && (
                        <ActionForm action={waiveFeeAction.bind(null, p.clientId, p.id)} className="flex items-end gap-1"><input className="input w-24" name="amount" placeholder="$0.00" required aria-label="Waive amount" /><input className="input w-40" name="reason" placeholder="Reason" required aria-label="Reason" /><Button type="submit" variant="ghost">Waive</Button></ActionForm>
                      )}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </Card>
    </>
  );
}
