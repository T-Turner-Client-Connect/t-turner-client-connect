import Link from "next/link";
import { ActionForm } from "@/components/action-form";
import { AdpNav } from "@/components/owner/adp-nav";
import { ReferralFields } from "@/components/owner/adp-forms";
import { Badge, Button, Card, EmptyState, Field, PageHeader } from "@/components/ui";
import { createReferralAction } from "@/app/actions/adp-revenue-share";
import { requireOwnerPage } from "@/lib/auth/owner";
import { adpClientChoices, listReferrals, referralName } from "@/lib/services/adp-revenue-share";
import { REFERRAL_STATUSES, REFERRAL_STATUS_LABELS, fmtDay, productLabel, statusTone, type ReferralStatus } from "@/lib/adp-revenue-share";
import { todayYmd } from "@/lib/services/owner-billing";

export const metadata = { title: "ADP referrals" };

export default async function AdpReferralsPage({ searchParams }: { searchParams: Promise<{ archived?: string }> }) {
  const actor = await requireOwnerPage();
  const archived = (await searchParams).archived === "1";
  const [rows, clients] = await Promise.all([listReferrals(actor, { archived }), adpClientChoices(actor)]);
  return (
    <>
      <PageHeader title="ADP Revenue Share" subtitle="Businesses you referred to ADP, and where each one stands." />
      <AdpNav current="referrals" />
      <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
        <Card title="Add a referral">
          <ActionForm action={createReferralAction} className="grid gap-3" resetOnSuccess idempotent>
            <ReferralFields clients={clients} today={todayYmd()} />
            <Field label="Status">
              <select className="input" name="status" defaultValue="REFERRED">
                {REFERRAL_STATUSES.map((s) => <option key={s} value={s}>{REFERRAL_STATUS_LABELS[s]}</option>)}
              </select>
            </Field>
            <Button type="submit">Save referral</Button>
          </ActionForm>
        </Card>
        <Card
          title={archived ? "Deleted referrals" : `Referrals (${rows.length})`}
          actions={
            <span className="flex gap-3 text-sm">
              <Link className="underline" href={archived ? "/owner/adp-revenue-share/referrals" : "/owner/adp-revenue-share/referrals?archived=1"}>{archived ? "Back to referrals" : "Show deleted"}</Link>
              {!archived && <a className="underline" href="/api/owner/adp-revenue-share/export?type=referrals">Export CSV</a>}
            </span>
          }
        >
          {rows.length === 0 ? (
            <EmptyState title={archived ? "No deleted referrals" : "No referrals yet"}>Add the businesses you refer to ADP. Link each to its client record, or enter a prospect by name.</EmptyState>
          ) : (
            <ul className="divide-y divide-ivory-200" data-testid="referral-list">
              {rows.map((r) => (
                <li key={r.id} className="flex flex-wrap items-start justify-between gap-2 py-3">
                  <div className="min-w-0">
                    <Link href={`/owner/adp-revenue-share/referrals/${r.id}`} className="font-semibold text-navy-900 underline decoration-gold-500 underline-offset-4">{referralName(r)}</Link>
                    <p className="text-sm text-slate-600">{productLabel(r.product, r.productOther)} · referred {fmtDay(r.referredOn)}{r.adpReference ? ` · ADP ref ${r.adpReference}` : ""}{r._count.lines ? ` · ${r._count.lines} statement line${r._count.lines === 1 ? "" : "s"}` : ""}</p>
                    {archived && r.archivedReason && <p className="text-xs text-slate-600">Deleted: {r.archivedReason}</p>}
                  </div>
                  <Badge tone={statusTone(r.status)}>{REFERRAL_STATUS_LABELS[r.status as ReferralStatus] ?? r.status}</Badge>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </>
  );
}
