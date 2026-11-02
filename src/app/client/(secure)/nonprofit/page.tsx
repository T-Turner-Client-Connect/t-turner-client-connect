import Link from "next/link";
import { Badge, Card, EmptyState, Notice, PageHeader } from "@/components/ui";
import { PortfolioDocuments } from "@/components/portal/portfolio-documents";
import { requirePortalUser } from "@/lib/portal/session";
import { resolveAccount } from "@/lib/portal/account";
import { downloadToken } from "@/lib/services/documents";
import { DONE, IRS_EVENTS, ITEM_STATUS, ORIGINS, portalPortfolio } from "@/lib/services/nonprofit-portfolio";
import { fmtDate } from "@/lib/format";

export const metadata = { title: "Nonprofit Portfolio" };

/** The client's nonprofit portfolio: progress, checklist, released documents and annual deadline. */
export default async function PortalNonprofit({ searchParams }: { searchParams: Promise<{ account?: string }> }) {
  const user = await requirePortalUser();
  const { accounts, current } = await resolveAccount(user.id, (await searchParams).account);
  if (!current) return null;
  const nonprofits = accounts.filter((a) => a.client.clientType === "NONPROFIT");
  if (current.client.clientType !== "NONPROFIT") {
    return (
      <>
        <PageHeader title="Nonprofit Portfolio" />
        {nonprofits.length ? (
          <Card title="Your nonprofit organizations">
            <ul className="space-y-2 text-sm">{nonprofits.map((n) => <li key={n.clientId}><Link className="font-semibold underline" href={`/client/nonprofit?account=${n.clientId}`}>{n.client.businessName || n.client.displayName}</Link></li>)}</ul>
          </Card>
        ) : <EmptyState title="No nonprofit on this account">If we&apos;re forming or supporting a nonprofit for you, it will appear here once it&apos;s linked to your login.</EmptyState>}
      </>
    );
  }
  const v = await portalPortfolio(user, current.clientId);
  if (!v) return <><PageHeader title="Nonprofit Portfolio" /><Notice>Your portfolio is being set up. Check back soon.</Notice></>;
  const pct = v.progress.total ? Math.round((v.progress.done / v.progress.total) * 100) : 0;

  return (
    <>
      <PageHeader title="Nonprofit Portfolio" subtitle={v.org.name} />
      <div className="grid gap-4 lg:grid-cols-3">
        <Card title="Formation progress" className="lg:col-span-2" actions={<span className="text-sm font-semibold" data-testid="progress-count">{v.progress.done} of {v.progress.total}</span>}>
          <div className="mb-4 h-2 rounded-full bg-ivory-200"><div className="h-2 rounded-full bg-emerald-600" style={{ width: `${pct}%` }} /></div>
          <ul className="divide-y divide-ivory-200 text-sm" data-testid="portfolio-checklist">
            {v.items.map((i) => (
              <li key={i.id} className="flex items-center justify-between py-2">
                <span className="flex items-center gap-2"><span className={`inline-block h-3 w-3 rounded-full ${DONE.includes(i.status) ? "bg-emerald-600" : "bg-slate-400"}`} aria-hidden />{i.label}</span>
                <span className={DONE.includes(i.status) ? "text-emerald-700" : "text-slate-600"}>{ITEM_STATUS[i.status]}</span>
              </li>
            ))}
          </ul>
        </Card>
        <div className="space-y-4">
          <Card title="Organization">
            <dl className="space-y-1 text-sm">
              {v.org.state && <div><dt className="inline text-slate-600">State: </dt><dd className="inline">{v.org.state}</dd></div>}
              {v.org.formationDate && <div><dt className="inline text-slate-600">Formed: </dt><dd className="inline">{fmtDate(v.org.formationDate)}</dd></div>}
              {v.org.ein && <div><dt className="inline text-slate-600">EIN: </dt><dd className="inline">{v.org.ein}</dd></div>}
              {v.org.sosEntityNumber && <div><dt className="inline text-slate-600">State entity number: </dt><dd className="inline">{v.org.sosEntityNumber}</dd></div>}
              {v.org.classification && <div><dt className="inline text-slate-600">Federal classification: </dt><dd className="inline">{v.org.classification}</dd></div>}
              <div><dt className="inline text-slate-600">IRS application: </dt><dd className="inline">{v.irs ? IRS_EVENTS[v.irs as keyof typeof IRS_EVENTS] : "Not submitted yet"}</dd></div>
              {v.org.uei && <div><dt className="inline text-slate-600">UEI: </dt><dd className="inline">{v.org.uei}</dd></div>}
            </dl>
          </Card>
          <Card title="Annual filing deadline">
            <div className="text-sm" data-testid="portal-deadline">
              {v.deadlines ? (
                <>
                  <p>{v.deadlines.form} for {v.deadlines.taxYear}: due <strong>{v.deadlines.due}</strong></p>
                  <p className="mt-1">{v.deadlines.preparedByUs ? <Badge tone="green">T. Turner &amp; Associates prepares this filing</Badge> : <span className="text-slate-700">Shown for your information. Preparing it isn&apos;t part of your current services unless you&apos;ve arranged it with us.</span>}</p>
                </>
              ) : <p className="text-slate-600">Not available yet.</p>}
            </div>
          </Card>
        </div>
      </div>
      <Card title="Your documents" className="mt-4">
        {v.files.length === 0 ? <p className="text-sm text-slate-600">Documents appear here as they&apos;re completed and released to you.</p> : (
          <PortfolioDocuments
            orgId={current.clientId}
            docs={v.files.map((f) => ({ id: f.id, label: f.label, title: f.title, origin: ORIGINS[f.origin].replace(" (prepared by us)", ""), released: fmtDate(f.releasedAt), href: `/api/documents/${downloadToken(f.documentId, { portalUserId: user.id })}` }))}
          />
        )}
      </Card>
    </>
  );
}
