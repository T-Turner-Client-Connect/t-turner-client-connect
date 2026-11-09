import Link from "next/link";
import { AlertTriangle, CalendarClock, Handshake, Info } from "lucide-react";
import { AdpNav } from "@/components/owner/adp-nav";
import { Card, LinkButton, PageHeader, Stat } from "@/components/ui";
import { requireOwnerPage } from "@/lib/auth/owner";
import { adpOverview, fiscalNote } from "@/lib/services/adp-revenue-share";
import { REFERRAL_STATUSES, REFERRAL_STATUS_LABELS, fmtCents } from "@/lib/adp-revenue-share";
import { todayYmd } from "@/lib/services/owner-billing";

export const metadata = { title: "ADP Revenue Share" };

const longDate = (ymd: string) => new Date(`${ymd}T12:00:00Z`).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" });

export default async function AdpOverviewPage() {
  // Tabitha's own tracker: a plain 404 for everyone else, like the other owner-bound pages.
  const actor = await requireOwnerPage();
  const today = todayYmd();
  const [o, note] = await Promise.all([adpOverview(actor, today), fiscalNote(actor)]);
  return (
    <>
      <PageHeader
        title="ADP Revenue Share"
        subtitle="Your ADP referrals, ADP's Revenue Share statements and the payments ADP sends. ADP has no API for this, so everything here is entered or uploaded by you. Private to you."
        actions={<LinkButton href="/owner/adp-revenue-share/statements" variant="gold">Add a statement</LinkButton>}
      />
      <AdpNav current="overview" />

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4" data-testid="adp-overview-stats">
        <Stat label={`Earned in ${o.year}`} value={fmtCents(o.yearTotal.earnedCents)} hint="Statement lines, by statement date" href="/owner/adp-revenue-share/reports" />
        <Stat label={`Received in ${o.year}`} value={fmtCents(o.yearTotal.receivedCents)} hint="Payments from ADP" href="/owner/adp-revenue-share/payments" />
        <Stat label="Outstanding (all time)" value={fmtCents(o.allTime.outstandingCents)} hint="Earned − received" href="/owner/adp-revenue-share/reports" />
        <Stat label="Referrals" value={o.referralCount} hint={REFERRAL_STATUSES.filter((s) => o.referralsByStatus[s]).map((s) => `${o.referralsByStatus[s]} ${REFERRAL_STATUS_LABELS[s].toLowerCase()}`).join(" · ") || "None yet"} href="/owner/adp-revenue-share/referrals" />
      </div>

      <div className="mt-5 grid gap-4 lg:grid-cols-2">
        <Card title={<span className="flex items-center gap-2"><CalendarClock className="size-5 text-gold-600" aria-hidden /> ADP fiscal quarter</span>}>
          <dl className="grid gap-2 text-sm sm:grid-cols-2">
            <div><dt className="text-xs font-semibold uppercase tracking-wider text-gold-700">Now</dt><dd className="text-navy-900">{o.quarter.label}: {longDate(o.quarter.start)} – {longDate(o.quarter.end)}</dd></div>
            <div><dt className="text-xs font-semibold uppercase tracking-wider text-gold-700">This quarter&apos;s payment</dt><dd className="text-navy-900">Expected around {longDate(o.quarter.expectedPaymentBy)}</dd></div>
            <div><dt className="text-xs font-semibold uppercase tracking-wider text-gold-700">Previous quarter</dt><dd className="text-navy-900">{o.previous.label}: ended {longDate(o.previous.end)}</dd></div>
            <div><dt className="text-xs font-semibold uppercase tracking-wider text-gold-700">Its payment</dt><dd className="text-navy-900">Expected around {longDate(o.previous.expectedPaymentBy)}</dd></div>
          </dl>
          <p className="mt-3 flex gap-2 rounded-lg bg-navy-50 px-3 py-2 text-sm text-navy-900" data-testid="fiscal-note"><Info className="mt-0.5 size-4 shrink-0 text-gold-600" aria-hidden /> <span className="whitespace-pre-line">{note.text}</span></p>
          <p className="mt-2 text-xs text-slate-600">Estimates only (quarter end + about 45 days). Edit the note on the <Link className="underline" href="/owner/adp-revenue-share/reports#fiscal-note">Reports</Link> tab.</p>
        </Card>

        <Card title={<span className="flex items-center gap-2"><Handshake className="size-5 text-gold-600" aria-hidden /> Needs your attention</span>}>
          <ul className="space-y-2 text-sm" data-testid="adp-attention">
            {o.mismatched.map((s) => (
              <li key={s.id} className="flex gap-2 rounded-lg bg-amber-50 px-3 py-2 text-amber-900">
                <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
                <span><Link className="font-semibold underline" href={`/owner/adp-revenue-share/statements/${s.id}`}>{s.periodLabel}</Link>: statement total {fmtCents(s.reportedTotalCents)} ≠ lines {fmtCents(s.check.linesCents)}</span>
              </li>
            ))}
            {o.drafts.map((s) => (
              <li key={s.id} className="rounded-lg bg-ivory-50 px-3 py-2"><Link className="font-semibold text-navy-900 underline" href={`/owner/adp-revenue-share/statements/${s.id}`}>{s.periodLabel}</Link> is a draft — mark it Final once it matches ADP&apos;s statement.</li>
            ))}
            {o.unmatchedPayments > 0 && (
              <li className="rounded-lg bg-ivory-50 px-3 py-2"><Link className="font-semibold text-navy-900 underline" href="/owner/adp-revenue-share/payments">{o.unmatchedPayments} payment{o.unmatchedPayments === 1 ? "" : "s"}</Link> not matched to a statement yet.</li>
            )}
            {!o.mismatched.length && !o.drafts.length && !o.unmatchedPayments && <li className="text-slate-600">Nothing waiting: every statement is Final and balanced, and every payment is matched.</li>}
          </ul>
        </Card>
      </div>
    </>
  );
}
