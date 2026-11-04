import Link from "next/link";
import { notFound } from "next/navigation";
import { ExternalLink, LockKeyhole } from "lucide-react";
import { ActionForm } from "@/components/action-form";
import { Badge, Button, Card, Field, LinkButton, Notice, PageHeader } from "@/components/ui";
import { FirmInvoiceDocument } from "@/components/billing/firm-invoice-document";
import { issueInvoiceAction, offerQuoteAction, recordPaymentAction, voidInvoiceAction, withdrawQuoteAction } from "@/app/actions/owner";
import { adjustInvoiceAction, approveInvoiceAction, returnInvoiceAction, submitInvoiceAction } from "@/app/actions/firm-invoices";
import { refreshSquareAction, resendSquareLinkAction, sendViaSquareAction } from "@/app/actions/square-invoicing";
import { SQUARE_STATUS_LABELS, squareSendingState } from "@/lib/services/square-invoicing";
import { SQUARE_PAYABLE } from "@/lib/billing/invoice-status";
import { requireOffice } from "@/lib/auth/owner";
import { breakdownOf, todayYmd, ymd } from "@/lib/services/owner-billing";
import { firmInvoiceDoc, invoiceHistory } from "@/lib/services/firm-invoices";
import { collectedCents, money, scheduleStatus, type ScheduleItem } from "@/lib/billing/pricing";
import { INVOICE_STATUS, invoiceStatus } from "@/lib/billing/invoice-status";
import { METHOD_LABELS } from "@/lib/billing/labels";
import { fmtDateTime } from "@/lib/format";
import { prisma } from "@/lib/prisma";

export default async function InvoicePage({ params }: { params: Promise<{ id: string }> }) {
  const { actor, access } = await requireOffice("billing");
  // Each control shows only to staff holding that permission; the server re-checks every action.
  const may = { pay: access.can("billing", "record_payment"), refund: access.can("billing", "refund"), adjust: access.can("billing", "adjust"), send: access.can("billing", "send"), edit: access.can("billing", "edit"), void: access.can("billing", "void") };
  const { id } = await params;
  const inv = await prisma.invoice.findUnique({
    where: { id },
    include: { lines: { orderBy: { sortOrder: "asc" } }, payments: { orderBy: { createdAt: "asc" } }, client: { select: { id: true, displayName: true } } },
  });
  if (!inv) notFound();
  const breakdown = breakdownOf(inv);
  const terms = inv.acceptedTerms as unknown as { totalCents: number; schedule: ScheduleItem[]; planFeeCents: number } | null;
  const collected = collectedCents(inv.payments);
  const today = todayYmd();
  const schedule = terms ? scheduleStatus(terms.schedule, collected, today) : [];
  const statusKey = invoiceStatus({ state: inv.state, viewedAt: inv.viewedAt, dueDate: ymd(inv.dueDate), totalCents: terms?.totalCents ?? null, appliedCents: collected, overdueInstallment: schedule.some((s) => s.state === "OVERDUE") }, today);
  const status = INVOICE_STATUS[statusKey];
  const isFirm = inv.formType === "INVOICE";
  const open = inv.state === "ACCEPTED" || inv.state === "ISSUED";
  const balance = terms ? terms.totalCents - collected : null;
  const [history, accepter, people, sending] = await Promise.all([
    invoiceHistory(actor, inv.id),
    inv.acceptedByPortalId ? prisma.portalUser.findUnique({ where: { id: inv.acceptedByPortalId }, select: { name: true, email: true } }) : null,
    prisma.user.findMany({ where: { id: { in: [inv.createdById, inv.submittedById, inv.approvedById, inv.squareSentById].filter((x): x is string => !!x) } }, select: { id: true, name: true } }),
    squareSendingState(),
  ]);
  const maySend = may.send;
  const mayReconcile = access.can("receivables", "reconcile");
  const nameOf = (uid: string | null) => people.find((p) => p.id === uid)?.name ?? "—";
  const doc = isFirm
    ? await firmInvoiceDoc({
        number: inv.number,
        status: statusKey,
        issueDate: ymd(inv.issueDate),
        dueDate: ymd(inv.dueDate),
        billTo: { name: inv.billingName ?? inv.client.displayName, email: inv.billingEmail, phone: inv.billingPhone, address: inv.billingAddress },
        lines: inv.lines,
        totalCents: terms?.totalCents ?? null,
        payments: inv.payments.map((p) => ({ id: p.id, kind: p.kind, status: p.status, amountCents: p.amountCents, receivedOn: ymd(p.receivedOn), method: p.method })),
        offeredMethods: inv.offeredMethods,
        squarePaymentUrl: inv.squarePaymentUrl,
        squarePublicUrl: inv.squarePublicUrl,
        squareStatus: inv.squareStatus,
      })
    : null;
  // Square: an approved, full-payment invoice with a balance can go through Square once.
  const squareSendable = (inv.state === "ISSUED" || (inv.state === "ACCEPTED" && inv.acceptedOption === "FULL")) && (balance ?? 0) > 0;
  const squareOpen = !!inv.squarePublicUrl && SQUARE_PAYABLE.includes(inv.squareStatus ?? "");
  const squareNeedsSend = squareSendable && !squareOpen && inv.squareStatus !== "PAID" && inv.squareStatus !== "PAYMENT_PENDING";
  const offersSquare = inv.offeredMethods.includes("SQUARE_INVOICE");
  const editable = inv.state === "DRAFT";

  return (
    <>
      <PageHeader
        title={`${inv.number} · ${inv.title}`}
        subtitle={<><Link className="underline" href={`/clients/${inv.client.id}?tab=invoices`}>{inv.client.displayName}</Link> · <Badge tone={status.badge}>{status.label}</Badge></>}
        actions={editable && may.edit ? <LinkButton variant="secondary" href={`/owner/invoices/${inv.id}/edit`}>Edit draft</LinkButton> : undefined}
      />
      {inv.state === "PENDING_APPROVAL" && (
        <div className="mb-4"><Notice tone="warn" title="Waiting for the owner's approval">Submitted by {nameOf(inv.submittedById)}{inv.submittedAt ? ` on ${fmtDateTime(inv.submittedAt)}` : ""}. It isn&apos;t visible to the client until it&apos;s approved and sent.</Notice></div>
      )}
      {inv.state === "OFFERED" && inv.publishedAt && (
        <div className="mb-4"><Notice title="Quote sent">Sent to the client&apos;s portal {fmtDateTime(inv.publishedAt)}. Waiting for the client to choose a payment option and accept.</Notice></div>
      )}
      {inv.state === "ISSUED" && inv.publishedAt && (
        <div className="mb-4"><Notice title="Invoice sent">Approved{inv.approvedById ? ` by ${nameOf(inv.approvedById)}` : ""} and published to the client&apos;s portal {fmtDateTime(inv.publishedAt)}.{inv.viewedAt ? ` The client first viewed it ${fmtDateTime(inv.viewedAt)}.` : " The client hasn't opened it yet."}</Notice></div>
      )}
      <div className="grid gap-4 lg:grid-cols-[3fr_2fr]">
        <div className="min-w-0 space-y-4">
          {doc ? (
            <div data-testid="owner-client-preview">
              <p className="mb-2 text-xs font-semibold uppercase tracking-widest text-gold-700">{inv.publishedAt ? "What the client sees" : "Client preview — not visible to the client yet"}</p>
              <FirmInvoiceDocument doc={doc} />
            </div>
          ) : (
            <>
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
                    <span>Applied <strong>{money(collected)}</strong></span>
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
            </>
          )}

          <Card title="Payments, refunds, adjustments and failed attempts">
            {inv.payments.length === 0 ? <p className="text-sm text-slate-600">None recorded.</p> : (
              <ul className="divide-y divide-navy-100 text-sm" data-testid="owner-payments">
                {inv.payments.map((p) => (
                  <li key={p.id} className="flex flex-wrap justify-between gap-2 py-2">
                    <span>{ymd(p.receivedOn)} · {p.kind === "REFUND" ? "Refund" : p.kind === "CREDIT" ? "Adjustment (credit)" : "Payment"}{p.kind !== "CREDIT" && ` · ${METHOD_LABELS[p.method]}`}{p.reference ? ` · Ref ${p.reference}` : ""}{p.kind === "CREDIT" && p.note ? ` · ${p.note}` : ""}</span>
                    <span className="flex items-center gap-2">
                      {p.status === "FAILED" ? <Badge tone="red">Failed — not counted</Badge> : p.source === "square" ? <Badge tone="green">Square</Badge> : <Badge tone="gray">{p.kind === "CREDIT" ? "Not cash" : "Recorded manually"}</Badge>}
                      <strong>{p.kind === "REFUND" ? "+" : "−"}{money(p.amountCents)}</strong>
                    </span>
                  </li>
                ))}
              </ul>
            )}
            {open && (may.pay || may.refund) && (balance ?? 0) > 0 && (
              <ActionForm action={recordPaymentAction.bind(null, inv.id)} className="mt-4 grid gap-2 sm:grid-cols-3" resetOnSuccess idempotent>
                <p className="text-sm font-semibold text-navy-900 sm:col-span-3">Record an offline payment · balance {money(balance ?? 0)}</p>
                <Field label="Type"><select className="input" name="kind">{may.pay && <option value="PAYMENT">Payment received</option>}{may.refund && <option value="REFUND">Refund given</option>}</select></Field>
                <Field label="Result"><select className="input" name="status"><option value="SUCCEEDED">Succeeded</option><option value="FAILED">Failed / bounced</option></select></Field>
                <Field label="Amount"><input className="input" name="amount" inputMode="decimal" required placeholder="0.00" /></Field>
                <Field label="Payment date"><input className="input" type="date" name="receivedOn" defaultValue={today} max={today} required /></Field>
                <Field label="Method"><select className="input" name="method">{Object.entries(METHOD_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></Field>
                <Field label="Reference # (confirmation, check #)"><input className="input" name="reference" maxLength={100} /></Field>
                <Field label="Note" className="sm:col-span-2"><input className="input" name="note" maxLength={300} /></Field>
                <div className="flex items-end"><Button type="submit">Record payment</Button></div>
              </ActionForm>
            )}
            {open && may.adjust && (balance ?? 0) > 0 && (
              <details className="mt-3 rounded-lg border border-ivory-200 p-3 text-sm">
                <summary className="cursor-pointer font-semibold text-navy-900">Apply an adjustment (credit)…</summary>
                <ActionForm action={adjustInvoiceAction.bind(null, inv.id)} className="mt-2 grid gap-2 sm:grid-cols-3" resetOnSuccess idempotent>
                  <Field label="Amount"><input className="input" name="amount" inputMode="decimal" required placeholder="0.00" /></Field>
                  <Field label="Date"><input className="input" type="date" name="receivedOn" defaultValue={today} max={today} required /></Field>
                  <Field label="Reason (shown in history)"><input className="input" name="reason" required maxLength={300} /></Field>
                  <div><Button type="submit" variant="secondary">Apply adjustment</Button></div>
                </ActionForm>
                <p className="mt-2 text-xs text-slate-600">Reduces the balance without counting as cash collected.</p>
              </details>
            )}
            {open && !may.pay && <p className="mt-3 text-xs text-slate-600">Recording payments needs the owner&apos;s permission (Billing → Record payments).</p>}
            {open && squareOpen && <p className="mt-3 text-xs text-slate-600">Payments made through Square are recorded here automatically.</p>}
          </Card>

          <Card title="History">
            <ol className="space-y-2 text-sm" data-testid="invoice-history">
              {history.map((h) => (
                <li key={h.id} className="flex flex-wrap justify-between gap-2 border-b border-ivory-200 pb-2 last:border-0">
                  <span><strong className="text-navy-900">{h.action}</strong> · {h.who}{typeof h.details?.amountCents === "number" ? ` · ${money(h.details.amountCents)}` : ""}{typeof h.details?.reason === "string" ? ` · “${h.details.reason}”` : ""}{typeof h.details?.note === "string" ? ` · “${h.details.note}”` : ""}{Array.isArray(h.details?.changed) && h.details.changed.length ? ` · ${(h.details.changed as string[]).join(", ")}` : ""}</span>
                  <span className="text-slate-600">{fmtDateTime(h.at)}</span>
                </li>
              ))}
            </ol>
          </Card>
        </div>

        <div className="space-y-4">
          <Card title="Actions">
            <div className="space-y-2">
              {(inv.state === "DRAFT" || inv.state === "PENDING_APPROVAL") && may.send && (
                <>
                  {(isFirm || inv.allowFull) && (
                    <>
                    <ActionForm action={(isFirm ? approveInvoiceAction : issueInvoiceAction).bind(null, inv.id)} className="space-y-2" confirm="Approve and send this invoice? It will appear in the client's portal and the client is notified that a new invoice is available.">
                      {isFirm && offersSquare && sending.live && (
                        <label className="flex items-start gap-2 rounded-lg border border-gold-300 bg-gold-50 px-3 py-2 text-sm" data-testid="approve-via-square">
                          <input type="checkbox" name="viaSquare" defaultChecked className="mt-0.5 size-4 accent-navy-900" />
                          <span>Also send through Square — Square creates the invoice and a secure payment link for {money(breakdown.options.FULL?.totalCents ?? 0)}.</span>
                        </label>
                      )}
                      <Button type="submit" variant="gold" className="w-full" data-testid="approve-send">Approve &amp; send invoice</Button>
                    </ActionForm>
                    {isFirm && offersSquare && !sending.live && <p className="text-xs text-slate-600" data-testid="square-off-note">{sending.message}</p>}
                    </>
                  )}
                  {!isFirm && (
                    <ActionForm action={offerQuoteAction.bind(null, inv.id)} confirm="Send this quote to the client's portal? They'll see every amount before choosing and accepting.">
                      <Button type="submit" variant="secondary" className="w-full">Send quote for acceptance</Button>
                    </ActionForm>
                  )}
                </>
              )}
              {inv.state === "DRAFT" && !may.send && may.edit && (
                <ActionForm action={submitInvoiceAction.bind(null, inv.id)}>
                  <Button type="submit" className="w-full" data-testid="submit-approval">Submit for owner approval</Button>
                </ActionForm>
              )}
              {inv.state === "PENDING_APPROVAL" && may.edit && (may.send || inv.submittedById === actor.id) && (
                <details className="text-sm">
                  <summary className="cursor-pointer underline">{may.send ? "Return to draft for changes…" : "Take back to draft…"}</summary>
                  <ActionForm action={returnInvoiceAction.bind(null, inv.id)} className="mt-2 space-y-2">
                    <Field label="Note (optional)"><input className="input" name="note" maxLength={300} /></Field>
                    <Button type="submit" variant="secondary">Return to draft</Button>
                  </ActionForm>
                </details>
              )}
              {inv.state === "OFFERED" && may.send && (
                <ActionForm action={withdrawQuoteAction.bind(null, inv.id)} confirm="Withdraw this quote? It disappears from the client's portal and returns to draft.">
                  <Button type="submit" variant="secondary" className="w-full">Withdraw quote</Button>
                </ActionForm>
              )}
              {inv.state !== "VOID" && may.void && (
                <details className="text-sm">
                  <summary className="cursor-pointer underline">Void…</summary>
                  <ActionForm action={voidInvoiceAction.bind(null, inv.id)} className="mt-2 space-y-2">
                    <Field label="Reason"><input className="input" name="reason" required /></Field>
                    <Button type="submit" variant="ghost">Void</Button>
                  </ActionForm>
                </details>
              )}
              {inv.state === "VOID" && <p className="text-sm text-slate-700">Voided {inv.voidedAt ? fmtDateTime(inv.voidedAt) : ""}{inv.voidReason ? ` — ${inv.voidReason}` : ""}.</p>}
            </div>
            <p className="mt-3 text-xs text-slate-600">{may.send ? "No automatic charges: the client pays through the Square link, or payments are recorded here when money is received." : "You can prepare and submit drafts. Someone the owner allows to send (or the owner) approves and sends."}</p>
          </Card>
          {isFirm && (inv.publishedAt || inv.squareInvoiceId) && (
            <Card title="Square">
              <div className="space-y-3 text-sm" data-testid="square-card">
                <p className="flex flex-wrap items-center gap-2">
                  <span className="font-semibold text-navy-900">Status:</span>
                  {inv.squareStatus ? <Badge tone={inv.squareStatus === "PAID" ? "green" : inv.squareStatus === "CANCELED" || inv.squareStatus === "DELETED" ? "gray" : inv.squareStatus === "PARTIALLY_PAID" ? "gold" : "navy"}>{SQUARE_STATUS_LABELS[inv.squareStatus] ?? inv.squareStatus}</Badge> : <Badge tone="gray">Not sent through Square</Badge>}
                  {sending.env === "sandbox" && inv.squareInvoiceId && <Badge tone="amber">Square sandbox</Badge>}
                </p>
                {inv.squarePublicUrl && (
                  <p><a className="inline-flex items-center gap-1 font-semibold text-navy-900 underline decoration-gold-500 underline-offset-4" href={inv.squarePublicUrl} target="_blank" rel="noopener noreferrer" data-testid="square-public-url">Square payment page <ExternalLink className="size-3.5" aria-hidden /></a></p>
                )}
                {inv.squareInvoiceId && (
                  <dl className="space-y-0.5 text-xs text-slate-700">
                    <div><dt className="inline font-semibold">Square invoice: </dt><dd className="inline font-mono">{inv.squareInvoiceId}</dd></div>
                    {inv.squareOrderId && <div><dt className="inline font-semibold">Order: </dt><dd className="inline font-mono">{inv.squareOrderId}</dd></div>}
                    {inv.squareCustomerId && <div><dt className="inline font-semibold">Customer: </dt><dd className="inline font-mono">{inv.squareCustomerId}</dd></div>}
                    {inv.squareSentAt && <div><dt className="inline font-semibold">Sent: </dt><dd className="inline">{fmtDateTime(inv.squareSentAt)} by {nameOf(inv.squareSentById)}{inv.squareEmailSentAt ? " · link emailed to the client" : ""}</dd></div>}
                    {inv.squareSyncedAt && <div><dt className="inline font-semibold">Last checked: </dt><dd className="inline">{fmtDateTime(inv.squareSyncedAt)}</dd></div>}
                  </dl>
                )}
                {inv.squareError && <Notice tone="warn">{inv.squareError}</Notice>}
                {squareNeedsSend && maySend && (
                  sending.live ? (
                    <ActionForm action={sendViaSquareAction.bind(null, inv.id)} confirm={`Send ${inv.number} through Square? Square creates the invoice for ${money(balance ?? 0)} and the client gets a secure payment link (${sending.delivery === "EMAIL" ? "Square emails it" : "we email it"}). Nothing is charged until the client pays.`}>
                      <Button type="submit" variant="gold" className="w-full" data-testid="send-via-square">Send via Square</Button>
                    </ActionForm>
                  ) : (
                    <div className="space-y-2">
                      <Button type="button" variant="secondary" className="w-full" disabled data-testid="send-via-square">Send via Square</Button>
                      <p className="text-xs text-slate-700" data-testid="square-off-note">{sending.message}</p>
                    </div>
                  )
                )}
                {inv.squareInvoiceId && mayReconcile && (
                  <ActionForm action={refreshSquareAction.bind(null, inv.id)}>
                    <Button type="submit" variant="secondary" className="w-full">Refresh from Square</Button>
                  </ActionForm>
                )}
                {squareOpen && maySend && sending.delivery === "SHARE_MANUALLY" && (
                  <ActionForm action={resendSquareLinkAction.bind(null, inv.id)} confirm="Email the Square payment link to the client again?">
                    <Button type="submit" variant="ghost" className="w-full">Email the Square link{inv.squareEmailSentAt ? " again" : ""}</Button>
                  </ActionForm>
                )}
                <p className="text-xs text-slate-600">Square payments are recorded here automatically (Square notifies us, and we re-check every hour). Voiding cancels an unpaid Square invoice. No surcharges are added.</p>
              </div>
            </Card>
          )}
          <Card title="Record">
            <dl className="space-y-1 text-sm">
              <div><dt className="inline font-semibold">Client ID: </dt><dd className="inline font-mono text-xs">{inv.client.id}</dd></div>
              <div><dt className="inline font-semibold">Created by: </dt><dd className="inline">{nameOf(inv.createdById)} · {fmtDateTime(inv.createdAt)}</dd></div>
              {inv.approvedAt && <div><dt className="inline font-semibold">Approved by: </dt><dd className="inline">{nameOf(inv.approvedById)} · {fmtDateTime(inv.approvedAt)}</dd></div>}
              {inv.viewedAt && <div><dt className="inline font-semibold">Viewed by client: </dt><dd className="inline">{fmtDateTime(inv.viewedAt)}</dd></div>}
            </dl>
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
          {inv.privateNote && (
            <section className="rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-950" data-testid="internal-note">
              <p className="mb-1 flex items-center gap-1.5 font-semibold"><LockKeyhole className="size-4" aria-hidden /> Internal notes — staff only</p>
              <p className="whitespace-pre-line">{inv.privateNote}</p>
            </section>
          )}
          {inv.memo && <Card title="Note to client"><p className="text-sm">{inv.memo}</p></Card>}
          {inv.paymentTerms && <Card title="Payment terms"><p className="whitespace-pre-line text-sm">{inv.paymentTerms}</p></Card>}
        </div>
      </div>
    </>
  );
}
