import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, History, Link2, Sparkles } from "lucide-react";
import { ActionForm } from "@/components/action-form";
import { AdpNav } from "@/components/owner/adp-nav";
import { PaymentFields, ReasonField } from "@/components/owner/adp-forms";
import { Badge, Button, Card, Field, Notice, PageHeader } from "@/components/ui";
import { archivePaymentAction, matchPaymentAction, unmatchPaymentAction, updatePaymentAction } from "@/app/actions/adp-revenue-share";
import { requireOwnerPage } from "@/lib/auth/owner";
import { getPayment, statementChoices } from "@/lib/services/adp-revenue-share";
import { PAYMENT_METHOD_LABELS, fmtCents, fmtDay, ymdOf, type AdpPaymentMethod } from "@/lib/adp-revenue-share";
import { todayYmd } from "@/lib/services/owner-billing";
import { fmtDateTime } from "@/lib/format";

export const metadata = { title: "ADP payment" };

export default async function AdpPaymentPage({ params }: { params: Promise<{ id: string }> }) {
  const actor = await requireOwnerPage();
  const { id } = await params;
  const [p, statements] = await Promise.all([getPayment(actor, id), statementChoices(actor)]);
  if (!p) notFound();
  const archived = !!p.archivedAt;
  const method = p.method === "OTHER" && p.methodOther ? p.methodOther : (PAYMENT_METHOD_LABELS[p.method as AdpPaymentMethod] ?? p.method);
  return (
    <>
      <Link href="/owner/adp-revenue-share/payments" className="mb-3 inline-flex items-center gap-2 text-sm font-semibold text-navy-900 underline decoration-gold-500 underline-offset-4"><ArrowLeft className="size-4" aria-hidden /> Payments</Link>
      <PageHeader title={`${fmtCents(p.amountCents)} from ADP`} subtitle={`${method} · received ${fmtDay(p.receivedOn)}${p.periodsCovered ? ` · covers ${p.periodsCovered}` : ""}`} actions={p.statement ? <Badge tone="green">Matched: {p.statement.periodLabel}</Badge> : <Badge tone="amber">Not matched</Badge>} />
      <AdpNav current="payments" />
      {archived && <div className="mb-4"><Notice tone="warn" title="Deleted">Deleted on {fmtDateTime(p.archivedAt)} by {p.names[p.archivedById ?? ""] ?? "the owner"}: {p.archivedReason}. It no longer counts in reports.</Notice></div>}

      <div className="grid items-start gap-4 lg:grid-cols-2">
        {!archived && (
          <Card title="Payment details">
            <ActionForm action={updatePaymentAction.bind(null, p.id)} className="grid gap-3">
              <PaymentFields today={todayYmd()} p={{ receivedOn: ymdOf(p.receivedOn), amountCents: p.amountCents, method: p.method, methodOther: p.methodOther, periodsCovered: p.periodsCovered, reference: p.reference, note: p.note }} />
              <Button type="submit">Save details</Button>
            </ActionForm>
          </Card>
        )}
        <div className="space-y-4">
          {!archived && (
            <Card title={<span className="flex items-center gap-2"><Link2 className="size-5 text-gold-600" aria-hidden /> Match payment to statement</span>}>
              {p.statement && (
                <p className="mb-3 text-sm">Matched to <Link className="font-semibold underline" href={`/owner/adp-revenue-share/statements/${p.statement.id}`}>{p.statement.periodLabel}</Link> (statement total {fmtCents(p.statement.reportedTotalCents)}){p.matchedAt ? ` on ${fmtDateTime(p.matchedAt)}` : ""}.</p>
              )}
              <ActionForm action={matchPaymentAction.bind(null, p.id)} className="grid gap-3" resetOnSuccess>
                <Field label={p.statement ? "Match to a different statement" : "Statement this payment is for"}>
                  <select className="input" name="statementId" required defaultValue="" data-testid="match-statement">
                    <option value="" disabled>— Choose a statement —</option>
                    {statements.filter((s) => s.id !== p.statementId).map((s) => <option key={s.id} value={s.id}>{s.periodLabel} · {fmtCents(s.reportedTotalCents)} · {fmtDay(s.statementDate)}{s.status === "FINAL" ? "" : " (draft)"}</option>)}
                  </select>
                </Field>
                <Field label="Note (optional)"><input className="input" name="note" maxLength={2000} /></Field>
                <Button type="submit" data-testid="match-payment">Match payment to statement</Button>
              </ActionForm>
              {p.statement && (
                <ActionForm action={unmatchPaymentAction.bind(null, p.id)} className="mt-4 grid gap-3 border-t border-ivory-200 pt-4" resetOnSuccess>
                  <ReasonField label="Reason for unmatching (required)" />
                  <Button type="submit" variant="secondary">Unmatch</Button>
                </ActionForm>
              )}
              <p className="mt-4 flex gap-2 rounded-lg bg-ivory-50 px-3 py-2 text-xs text-slate-700" data-testid="matching-placeholder"><Sparkles className="size-4 shrink-0 text-gold-600" aria-hidden /> Matching is manual in this stage. Suggested matches (by amount, date and period) come later, and each one will need your approval before it is applied.</p>
            </Card>
          )}
          <Card title={<span className="flex items-center gap-2"><History className="size-5 text-gold-600" aria-hidden /> Match history</span>}>
            {p.matchEvents.length === 0 ? (
              <p className="text-sm text-slate-600">Not matched to any statement yet.</p>
            ) : (
              <ol className="space-y-2 text-sm" data-testid="match-history">
                {p.matchEvents.map((e) => (
                  <li key={e.id} className="rounded-lg bg-ivory-50 px-3 py-2">
                    <span className="font-semibold text-navy-900">{e.action === "MATCHED" ? "Matched to" : "Unmatched from"} {e.statement?.periodLabel ?? "a statement"}</span>
                    {e.note && <span className="block text-slate-700">{e.note}</span>}
                    <span className="block text-xs text-slate-600">{fmtDateTime(e.at)} · {e.actorName}</span>
                  </li>
                ))}
              </ol>
            )}
          </Card>
          {!archived && (
            <Card title="Delete payment">
              <ActionForm action={archivePaymentAction.bind(null, p.id)} className="grid gap-3" confirm="Delete this payment? It's kept in your private history with your reason and no longer counts.">
                <ReasonField hint="Kept with the record." />
                <Button type="submit" variant="danger">Delete payment</Button>
              </ActionForm>
            </Card>
          )}
        </div>
      </div>
    </>
  );
}
