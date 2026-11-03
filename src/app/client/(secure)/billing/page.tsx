import Link from "next/link";
import { ArrowLeft, CircleDollarSign, Clock, CreditCard, FileText, Receipt, Wallet } from "lucide-react";
import { ActionForm } from "@/components/action-form";
import { Badge, Button, Card, Notice } from "@/components/ui";
import { PageBanner } from "@/components/portal/luxury";
import { GoldNote, StatCard, StatusPill, tableCard, usdc, ymdLabel, type Tone } from "@/components/portal/billing-pages";
import { PaymentPanel } from "@/components/portal/payment-panel";
import { acceptQuoteAction, declineQuoteAction } from "@/app/actions/portal-billing";
import { requirePortalUser } from "@/lib/portal/session";
import { resolveAccount } from "@/lib/portal/account";
import { portalBilling, quoteTermsHash } from "@/lib/services/owner-billing";
import { money } from "@/lib/billing/pricing";
import { METHOD_LABELS } from "@/lib/billing/labels";
import { fmtDate } from "@/lib/format";
import { prisma } from "@/lib/prisma";
import { NOT_SYNCED, portalSquareBilling, todayCentral } from "@/lib/services/square-billing";
import { portalManualBilling } from "@/lib/services/manual-billing";

export const metadata = { title: "Billing & Payments" };

type Office = Awaited<ReturnType<typeof portalBilling>>[number];
type Row = {
  key: string;
  number: string;
  description: string;
  amountCents: number | null;
  status: [string, Tone];
  date: string | null;
  action: { href: string; label: string; external?: boolean } | null;
};

// The ways a client can pay, in the order of the approved design. Details come only from the
// payment instructions our office has saved — nothing is made up here.
const WAYS = [
  { method: "ZELLE", label: "Zelle" },
  { method: "CASH_APP", label: "Cash App" },
  { method: "APPLE_PAY", label: "Apple Pay" },
  { method: "VENMO", label: "Venmo" },
] as const;

function officeStatus(inv: Office, today: string): [string, Tone] {
  if (inv.state === "OFFERED") return ["Ready for review", "pending"];
  if (inv.state === "DECLINED") return ["Declined", "muted"];
  const bal = inv.balanceCents ?? 0;
  if (inv.totalCents != null && bal <= 0) return ["Paid", "paid"];
  if (inv.schedule.some((s) => s.state === "OVERDUE") || inv.schedule.some((s) => s.dueCents > 0 && s.dueDate < today)) return ["Overdue", "overdue"];
  if (inv.collectedCents > 0) return ["Partially Paid", "partial"];
  return ["Open", "open"];
}

function squareStatus(status: string, due: string, today: string): [string, Tone] | null {
  if (status === "PAID") return ["Paid", "paid"];
  if (status === "PARTIALLY_PAID") return [due < today ? "Overdue" : "Partially Paid", due < today ? "overdue" : "partial"];
  if (status === "PAYMENT_PENDING") return ["Pending", "pending"];
  if (status === "UNPAID" || status === "FAILED") return due < today ? ["Overdue", "overdue"] : ["Open", "open"];
  if (status === "REFUNDED" || status === "PARTIALLY_REFUNDED") return ["Refunded", "muted"];
  return null; // scheduled (not billed yet), canceled, drafts — not invoices the client owes
}

/** Billing & Payments, built to Tabitha's design. Only this account's own records — the same ones our office sees. */
export default async function PortalBilling({ searchParams }: { searchParams: Promise<{ account?: string; invoice?: string }> }) {
  const user = await requirePortalUser();
  const sp = await searchParams;
  const { current } = await resolveAccount(user.id, sp.account);
  if (!current) return null;
  const banner = <PageBanner icon={CreditCard} title="Billing & Payments" subtitle="View your invoices, payments, and account balance." />;
  if (!current.canViewBilling) {
    return (
      <>
        {banner}
        <Notice>Billing isn&apos;t included in your access to this account.</Notice>
      </>
    );
  }
  const [items, sq, manual, instructions] = await Promise.all([
    portalBilling(user, current.clientId),
    portalSquareBilling(user, current.clientId),
    portalManualBilling(user, current.clientId),
    prisma.paymentInstruction.findMany({ where: { active: true }, select: { method: true, details: true } }),
  ]);
  const q = `account=${current.clientId}`;
  const today = todayCentral();
  const year = today.slice(0, 4);

  // One invoice opened from the table: the existing quote review, schedule and payment method.
  const opened = sp.invoice ? items.find((i) => i.id === sp.invoice) : undefined;
  if (opened) {
    const client = await prisma.client.findUniqueOrThrow({ where: { id: current.clientId }, select: { displayName: true } });
    const method = (await prisma.invoice.findUnique({ where: { id: opened.id }, select: { paymentMethod: true } }))?.paymentMethod ?? null;
    return (
      <div className="space-y-6">
        {banner}
        <Link href={`/client/billing?${q}`} className="inline-flex items-center gap-2 font-semibold text-navy-900 underline decoration-gold-500 underline-offset-4"><ArrowLeft className="size-4" aria-hidden /> Back to Billing &amp; Payments</Link>
        <InvoiceDetail inv={opened} clientId={current.clientId} clientName={client.displayName} paymentMethod={method} />
      </div>
    );
  }

  // ---- Every invoice for this account, newest first ----
  const rows: (Row & { sort: string })[] = [];
  let balance = 0;
  let openCount = 0;
  let pendingCents = 0;
  let paidYtd = 0;

  for (const inv of items) {
    const st = officeStatus(inv, today);
    if (inv.state !== "OFFERED" && inv.state !== "DECLINED") {
      const bal = Math.max(0, inv.balanceCents ?? 0);
      balance += bal;
      if (bal > 0) openCount++;
    }
    for (const p of inv.payments) if (p.receivedOn.startsWith(year)) paidYtd += p.kind === "REFUND" ? -p.amountCents : p.amountCents;
    rows.push({
      key: inv.id, sort: inv.issueDate, number: inv.number, description: inv.title,
      amountCents: inv.totalCents ?? inv.breakdown.options.FULL?.totalCents ?? inv.breakdown.subtotalCents,
      status: st, date: inv.issueDate,
      action: { href: `/client/billing?${q}&invoice=${inv.id}`, label: inv.state === "OFFERED" ? "Review" : "View" },
    });
  }

  for (const v of sq.views) {
    for (const [i, inv] of v.invoices.entries()) {
      const st = squareStatus(inv.status, inv.due, today);
      if (!st) continue;
      const amt = inv.amountCents ?? 0;
      const owed = inv.status === "PARTIALLY_PAID" ? amt - (inv.paidCents ?? 0) : inv.status === "UNPAID" || inv.status === "FAILED" ? amt : 0;
      balance += owed;
      if (owed > 0) openCount++;
      if (inv.status === "PAYMENT_PENDING") pendingCents += amt;
      if (inv.status === "PAID" && (inv.paidAt ?? inv.due).startsWith(year)) paidYtd += amt;
      if (inv.status === "PARTIALLY_PAID" && inv.due.startsWith(year)) paidYtd += inv.paidCents ?? 0;
      rows.push({
        key: `${v.id}-${inv.number ?? i}`, sort: inv.due, number: inv.number ?? "—", description: v.title || "Monthly service",
        amountCents: inv.amountCents, status: st, date: inv.paidAt ?? inv.due,
        action: inv.receiptUrl ? { href: inv.receiptUrl, label: "Receipt", external: true } : inv.invoiceUrl ? { href: inv.invoiceUrl, label: "View", external: true } : null,
      });
    }
  }

  if (manual) {
    balance += manual.overdueCents;
    if (manual.overdueCents > 0) openCount++;
    for (const p of manual.payments) {
      const paidOn = p.paidOn.toISOString().slice(0, 10);
      if (paidOn.startsWith(year)) paidYtd += p.amountCents;
      rows.push({ key: p.id, sort: paidOn, number: "—", description: `Monthly bookkeeping · ${p.periodMonth}`, amountCents: p.amountCents, status: ["Paid", "paid"], date: paidOn, action: null });
    }
  }
  rows.sort((a, b) => b.sort.localeCompare(a.sort));

  const card = instructions.find((i) => i.method === "SQUARE_INVOICE");
  const notSynced = sq.state !== "NONE" && (!sq.view || sq.unsynced > 0);

  return (
    <div className="space-y-6" data-testid="billing-payments">
      {banner}

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard navy icon={Wallet} label="Account Balance" value={usdc(balance)} testId="stat-balance" />
        <StatCard icon={FileText} label="Open Invoices" value={String(openCount)} testId="stat-open" />
        <StatCard icon={Clock} label="Pending Payments" value={usdc(pendingCents)} testId="stat-pending" />
        <StatCard icon={CircleDollarSign} label={`Paid (YTD ${year})`} value={usdc(paidYtd)} testId="stat-paid-ytd" />
      </div>

      <div className="grid items-start gap-6 xl:grid-cols-[1.7fr_1fr]">
        <section className={tableCard} data-testid="your-invoices">
          <h2 className="flex items-center gap-3 bg-navy-900 px-5 py-3.5 font-serif text-xl font-bold text-white sm:text-2xl">
            <Receipt className="size-6 shrink-0" aria-hidden /> Your Invoices
          </h2>
          {rows.length === 0 ? (
            <p className="p-5 text-sm text-slate-600">Invoices from our office will appear here.</p>
          ) : (
            <div className="relative overflow-x-auto">
              <table className="w-full min-w-[40rem] text-sm">
                <thead className="bg-ivory-50 text-left text-xs font-bold uppercase tracking-wide text-slate-600">
                  <tr><th className="px-5 py-3">Invoice #</th><th className="px-3 py-3">Description</th><th className="px-3 py-3 text-right">Amount</th><th className="px-3 py-3">Status</th><th className="px-3 py-3">Date</th><th className="px-5 py-3 text-right">Action</th></tr>
                </thead>
                <tbody className="divide-y divide-ivory-200">
                  {rows.map((r) => (
                    <tr key={r.key} data-testid="invoice-row">
                      <td className="whitespace-nowrap px-5 py-3.5 font-semibold text-navy-900">{r.number}</td>
                      <td className="px-3 py-3.5">{r.description}</td>
                      <td className="whitespace-nowrap px-3 py-3.5 text-right font-semibold text-navy-900">{usdc(r.amountCents)}</td>
                      <td className="px-3 py-3.5"><StatusPill tone={r.status[1]}>{r.status[0]}</StatusPill></td>
                      <td className="whitespace-nowrap px-3 py-3.5">{ymdLabel(r.date)}</td>
                      <td className="px-5 py-3.5 text-right">
                        {r.action ? (
                          r.action.external ? (
                            <a href={r.action.href} target="_blank" rel="noopener noreferrer" className="inline-flex whitespace-nowrap rounded-lg border border-gold-500 px-3 py-1.5 font-semibold text-navy-900 hover:bg-gold-50">{r.action.label}</a>
                          ) : (
                            <Link href={r.action.href} className="inline-flex whitespace-nowrap rounded-lg border border-gold-500 px-3 py-1.5 font-semibold text-navy-900 hover:bg-gold-50">{r.action.label}</Link>
                          )
                        ) : (
                          <span className="text-slate-400">—</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {notSynced && <p className="border-t border-ivory-200 px-5 py-3 text-sm text-slate-600" data-testid="portal-square-billing-pending">{NOT_SYNCED}. Your recurring billing continues exactly as arranged — nothing new will be charged.</p>}
        </section>

        <div className="space-y-6">
          <section className={tableCard} data-testid="make-a-payment">
            <h2 className="flex items-center gap-3 bg-navy-900 px-5 py-3.5 font-serif text-xl font-bold text-white sm:text-2xl">
              <CreditCard className="size-6 shrink-0" aria-hidden /> Make a Payment
            </h2>
            <ul className="divide-y divide-ivory-200">
              <li className="px-5 py-4" data-testid="pay-card">
                <p className="font-semibold text-navy-900">Pay Invoice (Credit/Debit Card)</p>
                {/* Until Square can take a card payment here, there is no pay button — only how to pay. */}
                <p className="mt-0.5 text-sm text-slate-600">{card?.details || "Online card payments are coming soon. To pay by card now, please contact our office."}</p>
              </li>
              {WAYS.map((w) => {
                const d = instructions.find((i) => i.method === w.method)?.details;
                return (
                  <li key={w.method} className="px-5 py-4" data-testid={`pay-${w.method}`}>
                    <p className="font-semibold text-navy-900">{w.label}</p>
                    <p className="mt-0.5 whitespace-pre-line text-sm text-slate-600">{d || "Ask our office for details."}</p>
                  </li>
                );
              })}
            </ul>
          </section>

          <GoldNote title="Important Payment Info" testId="payment-info">
            <ul className="list-disc space-y-1 pl-5">
              <li>Please include your name and invoice number with every payment.</li>
              <li>Payments show as &ldquo;Paid&rdquo; here once our office confirms them.</li>
              <li>Nothing is charged to your account automatically from this page.</li>
              <li>Questions about a bill? Send us a message in the Message Center.</li>
            </ul>
          </GoldNote>
        </div>
      </div>
    </div>
  );
}

/** One office invoice: quote review and acceptance, payment schedule, and payment method (unchanged flows). */
function InvoiceDetail({ inv, clientId, clientName, paymentMethod }: { inv: Office; clientId: string; clientName: string; paymentMethod: string | null }) {
  return (
    <Card
      title={<>{inv.title} <span className="text-sm font-normal text-slate-600">· {inv.number}</span></>}
      actions={inv.state === "OFFERED" ? <Badge tone="gold">Ready for your review</Badge> : inv.state === "DECLINED" ? <Badge tone="gray">Declined</Badge> : inv.balanceCents === 0 ? <Badge tone="green">Paid in full</Badge> : <Badge tone="navy">Balance {money(inv.balanceCents ?? 0)}</Badge>}
    >
      <div className="relative overflow-x-auto">
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
      </div>

      {inv.state === "OFFERED" ? (
        <ActionForm action={acceptQuoteAction.bind(null, inv.id)} className="mt-4 space-y-3">
          <fieldset className="grid gap-3 sm:grid-cols-2">
            <legend className="mb-2 font-semibold text-navy-900">Choose how you&apos;d like to pay</legend>
            {(["FULL", "PLAN"] as const).map((k) => {
              const o = inv.breakdown.options[k];
              if (!o) return null;
              const hash = quoteTermsHash(inv, clientName, inv.breakdown, k);
              return (
                <label key={k} className="block cursor-pointer rounded-xl border-2 border-navy-100 p-4 has-[:checked]:border-gold-500 has-[:checked]:bg-ivory">
                  <span className="flex items-center gap-2 font-semibold"><input type="radio" name="choice" value={`${k}|${hash}`} required /> {k === "FULL" ? "Pay in full" : "Payment plan"}</span>
                  <dl className="mt-2 space-y-0.5 text-sm"><div className="flex justify-between font-bold text-navy-900"><dt>Final total</dt><dd>{money(o.totalCents)}</dd></div></dl>
                  <ul className="mt-2 space-y-0.5 text-xs text-slate-700">
                    {o.schedule.map((s) => <li key={s.seq} className="flex justify-between gap-2"><span>{s.label} — due {fmtDate(new Date(`${s.dueDate}T12:00:00Z`))}</span><span>{money(s.amountCents)}</span></li>)}
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
          <div className="relative overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-slate-600"><tr><th className="py-1">Payment</th><th>Due</th><th className="text-right">Amount</th><th className="text-right">Remaining</th></tr></thead>
              <tbody className="divide-y divide-navy-100">
                {inv.schedule.map((s) => (
                  <tr key={s.seq}><td className="py-1.5">{s.label}</td><td>{fmtDate(new Date(`${s.dueDate}T12:00:00Z`))}</td><td className="text-right">{money(s.amountCents)}</td><td className="text-right">{s.dueCents === 0 ? <Badge tone="green">Paid</Badge> : s.state === "OVERDUE" ? <Badge tone="red">{money(s.dueCents)} past due</Badge> : money(s.dueCents)}</td></tr>
                ))}
              </tbody>
            </table>
          </div>
          {inv.payments.length > 0 && <p className="mt-2 text-xs text-slate-600">Payments received: {inv.payments.map((p) => `${p.kind === "REFUND" ? "refund " : ""}${money(p.amountCents)} on ${p.receivedOn} (${METHOD_LABELS[p.method]})`).join("; ")}</p>}
        </div>
      ) : null}
      {inv.state === "OFFERED" && (
        <ActionForm action={declineQuoteAction.bind(null, inv.id)} confirm="Decline this quote?" className="mt-2">
          <Button variant="ghost">Decline</Button>
        </ActionForm>
      )}
      {inv.state !== "DECLINED" && (inv.balanceCents ?? 1) > 0 && (
        <PaymentPanel clientId={clientId} invoice={{ id: inv.id, serviceCents: inv.breakdown.options.FULL?.totalCents ?? inv.breakdown.lines.reduce((a, l) => a + l.amountCents, 0), paymentMethod }} />
      )}
      {inv.memo && <p className="mt-3 text-sm text-slate-700">{inv.memo}</p>}
    </Card>
  );
}
