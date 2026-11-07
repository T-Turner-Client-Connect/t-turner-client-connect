import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, History } from "lucide-react";
import { ActionForm } from "@/components/action-form";
import { AdpNav } from "@/components/owner/adp-nav";
import { ReasonField, ReferralFields } from "@/components/owner/adp-forms";
import { Badge, Button, Card, Field, Notice, PageHeader } from "@/components/ui";
import { archiveReferralAction, referralStatusAction, updateReferralAction } from "@/app/actions/adp-revenue-share";
import { requireOwnerPage } from "@/lib/auth/owner";
import { adpClientChoices, getReferral, referralName } from "@/lib/services/adp-revenue-share";
import { LINE_TYPE_LABELS, REFERRAL_STATUSES, REFERRAL_STATUS_LABELS, fmtCents, fmtDay, productLabel, statusTone, ymdOf, type LineType, type ReferralStatus } from "@/lib/adp-revenue-share";
import { todayYmd } from "@/lib/services/owner-billing";
import { fmtDateTime } from "@/lib/format";

export const metadata = { title: "ADP referral" };

const label = (s: string | null) => (s ? (REFERRAL_STATUS_LABELS[s as ReferralStatus] ?? s) : "—");

export default async function AdpReferralPage({ params }: { params: Promise<{ id: string }> }) {
  const actor = await requireOwnerPage();
  const { id } = await params;
  const [r, clients] = await Promise.all([getReferral(actor, id), adpClientChoices(actor)]);
  if (!r) notFound();
  const archived = !!r.archivedAt;
  const today = todayYmd();
  const earned = r.lines.reduce((t, l) => t + l.amountCents, 0);
  return (
    <>
      <Link href="/owner/adp-revenue-share/referrals" className="mb-3 inline-flex items-center gap-2 text-sm font-semibold text-navy-900 underline decoration-gold-500 underline-offset-4"><ArrowLeft className="size-4" aria-hidden /> Referrals</Link>
      <PageHeader title={referralName(r)} subtitle={`${productLabel(r.product, r.productOther)} · referred ${fmtDay(r.referredOn)}${r.adpReference ? ` · ADP ref ${r.adpReference}` : ""}`} actions={<Badge tone={statusTone(r.status)}>{label(r.status)}</Badge>} />
      <AdpNav current="referrals" />
      {archived && <div className="mb-4"><Notice tone="warn" title="Deleted">This referral was deleted on {fmtDateTime(r.archivedAt)} by {r.names[r.archivedById ?? ""] ?? "the owner"}: {r.archivedReason}. It no longer appears in lists; its history is kept.</Notice></div>}
      {!r.clientId && r.prospectName && !archived && <div className="mb-4"><Notice title="Prospect — not linked to a client yet">When {r.prospectName} becomes a client, choose their client record below and save.</Notice></div>}

      <div className="grid items-start gap-4 lg:grid-cols-2">
        {!archived && (
          <Card title="Referral details">
            <ActionForm action={updateReferralAction.bind(null, r.id)} className="grid gap-3">
              <ReferralFields clients={clients} today={today} r={{ clientId: r.clientId, prospectName: r.prospectName, referredOn: ymdOf(r.referredOn), product: r.product, productOther: r.productOther, adpReference: r.adpReference, notes: r.notes }} />
              <Button type="submit">Save details</Button>
            </ActionForm>
          </Card>
        )}
        <div className="space-y-4">
          {!archived && (
            <Card title="Change status">
              <ActionForm action={referralStatusAction.bind(null, r.id)} className="grid gap-3" resetOnSuccess>
                <div className="grid gap-3 sm:grid-cols-2">
                  <Field label="New status">
                    <select className="input" name="status" defaultValue={r.status}>
                      {REFERRAL_STATUSES.map((s) => <option key={s} value={s}>{REFERRAL_STATUS_LABELS[s]}</option>)}
                    </select>
                  </Field>
                  <Field label="Date it happened (optional)"><input className="input" type="date" name="effectiveOn" /></Field>
                </div>
                <Field label="Note"><input className="input" name="note" maxLength={2000} /></Field>
                <Button type="submit" variant="secondary">Change status</Button>
              </ActionForm>
            </Card>
          )}
          <Card title={<span className="flex items-center gap-2"><History className="size-5 text-gold-600" aria-hidden /> Status history</span>}>
            <ol className="space-y-2 text-sm" data-testid="status-history">
              {r.statusHistory.map((h) => (
                <li key={h.id} className="rounded-lg bg-ivory-50 px-3 py-2">
                  <span className="font-semibold text-navy-900">{h.fromStatus ? `${label(h.fromStatus)} → ${label(h.toStatus)}` : label(h.toStatus)}</span>
                  {h.effectiveOn && <span className="text-slate-700"> · on {fmtDay(h.effectiveOn)}</span>}
                  {h.note && <span className="block text-slate-700">{h.note}</span>}
                  <span className="block text-xs text-slate-600">{fmtDateTime(h.changedAt)} · {r.names[h.changedById] ?? "Owner"}</span>
                </li>
              ))}
            </ol>
          </Card>
          <Card title={`Statement lines (${fmtCents(earned)})`}>
            {r.lines.length === 0 ? (
              <p className="text-sm text-slate-600">No statement lines are linked to this referral yet.</p>
            ) : (
              <ul className="divide-y divide-ivory-200 text-sm">
                {r.lines.map((l) => (
                  <li key={l.id} className="flex justify-between gap-2 py-2">
                    <span><Link className="underline" href={`/owner/adp-revenue-share/statements/${l.statement.id}`}>{l.statement.periodLabel}</Link> · {LINE_TYPE_LABELS[l.type as LineType] ?? l.type}</span>
                    <strong className="tabular-nums">{fmtCents(l.amountCents)}</strong>
                  </li>
                ))}
              </ul>
            )}
          </Card>
          {!archived && (
            <Card title="Delete referral">
              <ActionForm action={archiveReferralAction.bind(null, r.id)} className="grid gap-3" confirm="Delete this referral? It's kept in your private history with your reason.">
                <ReasonField hint="Kept with the record. Statement lines already linked keep their link." />
                <Button type="submit" variant="danger">Delete referral</Button>
              </ActionForm>
            </Card>
          )}
        </div>
      </div>
    </>
  );
}
