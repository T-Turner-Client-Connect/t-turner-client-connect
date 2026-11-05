import Link from "next/link";
import { requirePortalUser } from "@/lib/portal/session";
import { resolveAccount } from "@/lib/portal/account";
import { portalCompliance } from "@/lib/services/compliance/views";
import { ActionForm } from "@/components/action-form";
import { Badge, Button, Card, EmptyState, Notice, PageHeader } from "@/components/ui";
import { fmtD, money, StatusBadge } from "@/components/compliance/bits";
import { portalDecisionAction } from "@/app/actions/compliance";

export const metadata = { title: "Tax & Compliance" };

/** The client's own entities' filing calendar: client-visible obligations for services we provide. */
export default async function PortalCompliance({ searchParams }: { searchParams: Promise<{ account?: string }> }) {
  const user = await requirePortalUser();
  const { current } = await resolveAccount(user.id, (await searchParams).account);
  if (!current) return null;
  if (!current.canViewTax) return <Notice>Your access to this account doesn&apos;t include tax information.</Notice>;
  const d = await portalCompliance(user, current.clientId);
  return (
    <div data-testid="portal-compliance">
      <PageHeader title="Tax & Compliance" subtitle="Your filing calendar with our office: due dates, approvals and filed returns. Dates marked “to be confirmed” are still being verified." />
      <p className="mb-4 text-sm"><Link href={`/client?account=${current.clientId}`} className="underline">← Back to your dashboard</Link></p>
      {d.entities.length === 0 && <EmptyState title="Nothing to show yet">When our office sets up your filing calendar, your returns and deadlines appear here.</EmptyState>}
      <div className="space-y-5">
        {d.entities.map((e) => (
          <Card key={e.id} title={<span className="flex items-center gap-2">{e.name}{e.kind === "NONPROFIT" && <Badge>Nonprofit</Badge>}</span>}>
            {e.periods.length === 0 ? <p className="text-sm text-slate-600">No filings scheduled yet.</p> : (
              <ul className="divide-y divide-ivory-200">
                {e.periods.map((p) => (
                  <li key={p.id} className="py-3 text-sm">
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <div><p className="font-semibold">{p.form}</p><p className="text-xs text-slate-600">Period {fmtD(p.periodStart)} – {fmtD(p.periodEnd)} · due {fmtD(p.dueDate)}{!p.dueCertain && " (to be confirmed)"} · amount due {money(p.amountDueCents)} · {p.paymentStatus}{p.actualFilingDate && ` · filed ${fmtD(p.actualFilingDate)}`}{p.confirmationNumber && ` · confirmation ${p.confirmationNumber}`}</p></div>
                      <StatusBadge status={p.status} />
                    </div>
                    {p.published.length > 0 && <p className="mt-1 text-xs">Documents: {p.published.map((x) => <a key={x.documentId} href={`/api/client/compliance/doc/${x.documentId}`} className="mr-3 underline">{x.title}</a>)}</p>}
                    {p.awaitingMe && (
                      <div className="mt-3 rounded-xl border border-gold-300 bg-gold-50 p-3" data-testid="approval-box">
                        <p className="font-semibold">A tax return is ready for your review (version {p.awaitingMe.version})</p>
                        <p className="text-xs">Review the documents, the amount due and the deadline, then approve it for filing or ask for changes.</p>
                        <p className="mt-1 text-xs">{p.awaitingMe.documentIds.map((id, i) => <a key={id} href={`/api/client/compliance/doc/${id}`} className="mr-3 underline">Document {i + 1}</a>)}</p>
                        <ActionForm action={portalDecisionAction.bind(null, p.awaitingMe.versionId)} className="mt-2 grid gap-2 sm:grid-cols-2">
                          <input type="hidden" name="contentHash" value={p.awaitingMe.contentHash} />
                          <input name="signerName" required placeholder="Type your full name" className="input" autoComplete="name" />
                          <input name="comments" placeholder="Comments (required to request changes)" className="input" />
                          <Button name="decision" value="APPROVED">Approve for filing</Button>
                          <Button name="decision" value="CHANGES_REQUESTED" variant="secondary">Request changes</Button>
                        </ActionForm>
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </Card>
        ))}
      </div>
    </div>
  );
}
