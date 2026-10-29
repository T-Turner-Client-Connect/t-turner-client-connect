import { notFound } from "next/navigation";
import { ActionForm } from "@/components/action-form";
import { Badge, Button, Card, Field, LinkButton, Notice, PageHeader } from "@/components/ui";
import { issueInvoiceAction, offerQuoteAction, recordPaymentAction, voidInvoiceAction, withdrawQuoteAction } from "@/app/actions/owner";
import { requireOwner } from "@/lib/auth/owner";
import { breakdownOf, todayYmd, ymd } from "@/lib/services/owner-billing";
import { collectedCents, money, scheduleStatus, type ScheduleItem } from "@/lib/billing/pricing";
import { METHOD_LABELS, STATE_LABELS } from "@/lib/billing/labels";
import { fmtDateTime } from "@/lib/format";
import { prisma } from "@/lib/prisma";

export default async function InvoicePage({ params }: { params: Promise<{ id: string }> }) {
  await requireOwner("billing");
  const { id } = await params;
  const inv = await prisma.invoice.findUnique({
    where: { id },
    include: { lines: { orderBy: { sortOrder: "asc" } }, payments: { orderBy: { createdAt: "asc" } }, client: { select: { id: true, displayName: true } } },
  });
  if (!inv) notFound();
  const breakdown = breakdownOf(inv);
  const terms = inv.acceptedTerms as unknown as { totalCents: number; schedule: ScheduleItem[]; planFeeCents: number } | null;
  const collected = collectedCents(inv.payments);
  const schedule = terms ? scheduleStatus(terms.schedule, collected, todayYmd()) : [];
  const state = STATE_LABELS[inv.state];
  const accepter = inv.acceptedByPortalId ? await prisma.portalUser.findUnique({ where: { id: inv.acceptedByPortalId }, select: { name: true, email: true } }) : null;

  return (
    <>
      <PageHeader
        title={`${inv.number} · ${inv.title}`}
        subtitle={<>{inv.client.displayName} · <Badge tone={state.tone}>{state.label}</Badge></>}
        actions={inv.state === "DRAFT" ? <LinkButton variant="secondary" href={`/owner/invoices/${inv.id}/edit`}>Edit draft</LinkButton> : undefined}
      />
      {inv.state === "OFFERED" && inv.publishedAt && (
        <div className="mb-4"><Notice title="Quote sent">Sent to the client&apos;s portal {fmtDateTime(inv.publishedAt)}. Waiting for the client to choose a payment option and accept.</Notice></div>
      )}
      {inv.state === "ISSUED" && inv.publishedAt && (
        <div className="mb-4"><Notice title="Invoice issued">Published to the client&apos;s portal {fmtDateTime(inv.publishedAt)}.</Notice></div>
      )}
      <div className="grid gap-4 lg:grid-cols-[3fr_2fr]">
        <div className="space-y-4">
          <Card title="Services">
            <table className="w-full text-sm">
              <thead className="text-left text-slate-600"><tr><th className="py-1">Service</th><th className="text-right">Qty</th><th className="text-right">Price</th><th className="text-right">Amount</th></tr></thead>
              <tbody className="divide-y divide-navy-100">
                {breakdown.lines.map((l, i) => (
                  <tr key={i}><td className="py-1.5">{l.service}{l.description && <span className="block text-xs text-slate-600">{l.description}</span>}</td><td className="text-right">{l.quantity}</td><td className="text-right">{money(l.unitCents)}</td><td className="text-right">{money(l.amountCents)}</td></tr>
                ))}
              </tbody>
            </table>
            <ul className="mt-3 list-disc space-y-0.5 pl-5 text-xs text-slate-600">{breakdown.explanation.map((e) => <li key={e}>{e}</li>)}</ul>
          </Card>

          {terms ? (
            <Card title={`Payment schedule — ${inv.acceptedOption === "PLAN" ? "payment plan" : "full payment"}`}>
              <table className="w-full text-sm" data-testid="schedule">
                <thead className="text-left text-slate-600"><tr><th className="py-1">Item</th><th>Due</th><th className="text-right">Amount</th><th className="text-right">Paid</th><th>Status</th></tr></thead>
                <tbody className="divide-y divide-navy-100">
                  {schedule.map((s) => (
                    <tr key={s.seq}>
                      <td className="py-1.5">{s.label}</td><td>{s.dueDate}</td><td className="text-right">{money(s.amountCents)}</td><td className="text-right">{money(s.paidCents)}</td>
                      <td><Badge tone={s.state === "PAID" ? "green" : s.state === "OVERDUE" ? "red" : s.state === "PARTIAL" ? "gold" : "gray"}>{s.state === "OVERDUE" ? `Overdue ${s.daysOverdue}d` : s.state[0] + s.state.slice(1).toLowerCase()}</Badge></td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div className="mt-3 flex flex-wrap justify-end gap-6 text-sm">
                <span>Total <strong>{money(terms.totalCents)}</strong></span>
                <span>Collected <strong>{money(collected)}</strong></span>
                <span>Balance <strong>{money(terms.totalCents - collected)}</strong></span>
              </div>
            </Card>
          ) : (
            <Card title="Options offered">
              <div className="grid gap-3 sm:grid-cols-2">
                {(["FULL", "PLAN"] as const).map((k) => {
                  const o = breakdown.options[k];
                  if (!o) return null;
                  return (
                    <div key={k} className="rounded-lg bg-navy-50 p-3 text-sm">
                      <p className="font-semibold">{k === "FULL" ? "Pay in full" : "Payment plan"} — {money(o.totalCents)}</p>
                      <ul className="mt-1 text-xs">{o.schedule.map((s) => <li key={s.seq}>{s.label} · {s.dueDate} · {money(s.amountCents)}</li>)}</ul>
                    </div>
                  );
                })}
              </div>
            </Card>
          )}

          <Card title="Payments, refunds and failed attempts">
            {inv.payments.length === 0 ? <p className="text-sm text-slate-600">None recorded.</p> : (
              <ul className="divide-y divide-navy-100 text-sm">
                {inv.payments.map((p) => (
                  <li key={p.id} className="flex flex-wrap justify-between gap-2 py-2">
                    <span>{ymd(p.receivedOn)} · {p.kind === "REFUND" ? "Refund" : "Payment"} · {METHOD_LABELS[p.method]}{p.reference ? ` · ${p.reference}` : ""}</span>
                    <span className="flex items-center gap-2">
                      {p.status === "FAILED" ? <Badge tone="red">Failed — not counted</Badge> : <Badge tone="gray">Recorded manually</Badge>}
                      <strong>{p.kind === "REFUND" ? "−" : ""}{money(p.amountCents)}</strong>
                    </span>
                  </li>
                ))}
              </ul>
            )}
            {(inv.state === "ACCEPTED" || inv.state === "ISSUED") && (
              <ActionForm action={recordPaymentAction.bind(null, inv.id)} className="mt-4 grid gap-2 sm:grid-cols-3" resetOnSuccess idempotent>
                <Field label="Type"><select className="input" name="kind"><option value="PAYMENT">Payment received</option><option value="REFUND">Refund given</option></select></Field>
                <Field label="Result"><select className="input" name="status"><option value="SUCCEEDED">Succeeded</option><option value="FAILED">Failed / bounced</option></select></Field>
                <Field label="Amount"><input className="input" name="amount" inputMode="decimal" required placeholder="0.00" /></Field>
                <Field label="Date"><input className="input" type="date" name="receivedOn" defaultValue={todayYmd()} required /></Field>
                <Field label="Method"><select className="input" name="method">{Object.entries(METHOD_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></Field>
                <Field label="Reference (check #, confirmation)"><input className="input" name="reference" /></Field>
                <Field label="Note" className="sm:col-span-2"><input className="input" name="note" /></Field>
                <div className="flex items-end"><Button type="submit">Record</Button></div>
              </ActionForm>
            )}
          </Card>
        </div>

        <div className="space-y-4">
          <Card title="Actions">
            <div className="space-y-2">
              {inv.state === "DRAFT" && (
                <>
                  <ActionForm action={offerQuoteAction.bind(null, inv.id)} confirm="Send this quote to the client's portal? They'll see every amount before choosing and accepting.">
                    <Button type="submit" className="w-full">Send quote for acceptance</Button>
                  </ActionForm>
                  {inv.allowFull && (
                    <ActionForm action={issueInvoiceAction.bind(null, inv.id)} confirm="Issue as an invoice for full payment? It will appear in the client's portal.">
                      <Button type="submit" variant="secondary" className="w-full">Issue invoice (full payment)</Button>
                    </ActionForm>
                  )}
                </>
              )}
              {inv.state === "OFFERED" && (
                <ActionForm action={withdrawQuoteAction.bind(null, inv.id)} confirm="Withdraw this quote? It disappears from the client's portal and returns to draft.">
                  <Button type="submit" variant="secondary" className="w-full">Withdraw quote</Button>
                </ActionForm>
              )}
              {inv.state !== "VOID" && (
                <details className="text-sm">
                  <summary className="cursor-pointer underline">Void…</summary>
                  <ActionForm action={voidInvoiceAction.bind(null, inv.id)} className="mt-2 space-y-2">
                    <Field label="Reason"><input className="input" name="reason" required /></Field>
                    <Button type="submit" variant="ghost">Void</Button>
                  </ActionForm>
                </details>
              )}
            </div>
            <p className="mt-3 text-xs text-slate-600">No automatic charges: payments are recorded here when money is received. No payment provider is connected.</p>
          </Card>
          {inv.acceptedAt && (
            <Card title="Client acceptance record">
              <dl className="space-y-1 text-sm">
                <div><dt className="inline font-semibold">Accepted: </dt><dd className="inline">{fmtDateTime(inv.acceptedAt)}</dd></div>
                <div><dt className="inline font-semibold">By: </dt><dd className="inline">{accepter ? `${accepter.name} (${accepter.email})` : "—"}</dd></div>
                <div><dt className="inline font-semibold">Option: </dt><dd className="inline">{inv.acceptedOption === "PLAN" ? "Payment plan" : "Full payment"}</dd></div>
                {inv.acceptedFromIp && <div><dt className="inline font-semibold">From IP: </dt><dd className="inline">{inv.acceptedFromIp}</dd></div>}
                <div><dt className="font-semibold">Terms fingerprint (SHA-256):</dt><dd className="break-all font-mono text-xs">{inv.acceptedTermsHash}</dd></div>
              </dl>
            </Card>
          )}
          {inv.privateNote && <Notice title="Private note">{inv.privateNote}</Notice>}
          {inv.memo && <Card title="Note to client"><p className="text-sm">{inv.memo}</p></Card>}
          {inv.paymentTerms && <Card title="Payment terms"><p className="whitespace-pre-line text-sm">{inv.paymentTerms}</p></Card>}
        </div>
      </div>
    </>
  );
}
