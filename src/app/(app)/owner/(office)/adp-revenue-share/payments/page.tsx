import Link from "next/link";
import { ActionForm } from "@/components/action-form";
import { AdpNav } from "@/components/owner/adp-nav";
import { PaymentFields } from "@/components/owner/adp-forms";
import { Badge, Button, Card, EmptyState, Field, PageHeader } from "@/components/ui";
import { createPaymentAction } from "@/app/actions/adp-revenue-share";
import { requireOwnerPage } from "@/lib/auth/owner";
import { listPayments, statementChoices } from "@/lib/services/adp-revenue-share";
import { PAYMENT_METHOD_LABELS, fmtCents, fmtDay, type AdpPaymentMethod } from "@/lib/adp-revenue-share";
import { todayYmd } from "@/lib/services/owner-billing";

export const metadata = { title: "ADP payments" };

export default async function AdpPaymentsPage({ searchParams }: { searchParams: Promise<{ archived?: string }> }) {
  const actor = await requireOwnerPage();
  const archived = (await searchParams).archived === "1";
  const [rows, statements] = await Promise.all([listPayments(actor, { archived }), statementChoices(actor)]);
  const total = rows.reduce((t, p) => t + p.amountCents, 0);
  return (
    <>
      <PageHeader title="ADP Revenue Share" subtitle="Payments received from ADP (usually about 45 days after each ADP fiscal quarter)." />
      <AdpNav current="payments" />
      <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
        <Card title="Record a payment">
          <ActionForm action={createPaymentAction} className="grid gap-3" resetOnSuccess idempotent>
            <PaymentFields today={todayYmd()} />
            <Field label="Statement it pays (optional)" hint="Your own match — nothing is matched automatically. You can match or change it later.">
              <select className="input" name="statementId" defaultValue="">
                <option value="">— Not matched yet —</option>
                {statements.map((s) => <option key={s.id} value={s.id}>{s.periodLabel} · {fmtCents(s.reportedTotalCents)}{s.status === "FINAL" ? "" : " (draft)"}</option>)}
              </select>
            </Field>
            <Button type="submit">Save payment</Button>
          </ActionForm>
        </Card>
        <Card
          title={archived ? "Deleted payments" : `Payments received (${fmtCents(total)})`}
          actions={
            <span className="flex gap-3 text-sm">
              <Link className="underline" href={archived ? "/owner/adp-revenue-share/payments" : "/owner/adp-revenue-share/payments?archived=1"}>{archived ? "Back to payments" : "Show deleted"}</Link>
              {!archived && <a className="underline" href="/api/owner/adp-revenue-share/export?type=payments">Export CSV</a>}
            </span>
          }
        >
          {rows.length === 0 ? (
            <EmptyState title={archived ? "No deleted payments" : "No payments yet"}>Record each ACH deposit or check from ADP here.</EmptyState>
          ) : (
            <ul className="divide-y divide-ivory-200" data-testid="payment-list">
              {rows.map((p) => (
                <li key={p.id} className="flex flex-wrap items-start justify-between gap-2 py-3">
                  <div className="min-w-0">
                    <Link href={`/owner/adp-revenue-share/payments/${p.id}`} className="font-semibold text-navy-900 underline decoration-gold-500 underline-offset-4">{fmtDay(p.receivedOn)} · {p.method === "OTHER" && p.methodOther ? p.methodOther : PAYMENT_METHOD_LABELS[p.method as AdpPaymentMethod] ?? p.method}</Link>
                    <p className="text-sm text-slate-600">{[p.periodsCovered, p.reference && `Ref ${p.reference}`, p.note].filter(Boolean).join(" · ") || "—"}</p>
                    {archived && p.archivedReason && <p className="text-xs text-slate-600">Deleted: {p.archivedReason}</p>}
                  </div>
                  <div className="text-right">
                    <p className="font-semibold tabular-nums text-navy-900">{fmtCents(p.amountCents)}</p>
                    {p.statement ? <Badge tone="green">Matched: {p.statement.periodLabel}</Badge> : <Badge tone="amber">Not matched</Badge>}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </>
  );
}
