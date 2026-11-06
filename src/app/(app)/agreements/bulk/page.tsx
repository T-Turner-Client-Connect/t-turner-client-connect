import Link from "next/link";
import { connection } from "next/server";
import { ActionForm } from "@/components/action-form";
import { StatusBadge } from "@/components/agreements/bits";
import { Button, Card, Field, Notice, PageHeader } from "@/components/ui";
import { bulkCreateAction, sendSelectedAction } from "@/app/actions/agreements";
import { requireUser } from "@/lib/auth/session";
import { isReportApprover } from "@/lib/services/bookkeeping-clients";
import { BULK_FILTERS, bulkBatch, bulkCandidates, templates } from "@/lib/services/agreements";
import { displayStatus, money } from "@/lib/agreements/catalog";
import { chicagoToday } from "@/lib/dates";

export const metadata = { title: "Create for several clients" };

/**
 * Bulk drafts: choose a template and the clients; one draft per client with that client's
 * own fees prefilled. Reviewed in a table and sent one at a time or with "Send selected" —
 * only on Tabitha's click, never automatically.
 */
export default async function BulkAgreementsPage({ searchParams }: { searchParams: Promise<{ template?: string; filter?: string; batch?: string }> }) {
  await connection();
  const user = await requireUser();
  const sp = await searchParams;
  const [tpls, owner] = await Promise.all([templates(), isReportApprover(user)]);
  const filter = sp.filter && sp.filter in BULK_FILTERS ? sp.filter : "ACTIVE_BOOKKEEPING";
  const template = tpls.find((t) => t.key === sp.template)?.key ?? "BOOKKEEPING";

  if (sp.batch) {
    const rows = await bulkBatch(sp.batch);
    const today = chicagoToday();
    return (
      <>
        <PageHeader title="Review drafts" subtitle={`${rows.length} draft${rows.length === 1 ? "" : "s"} created together. Review each one; nothing has been sent.`} actions={<Link className="text-sm underline" href="/agreements">← All agreements</Link>} />
        <ActionForm action={sendSelectedAction.bind(null, sp.batch)} confirm={owner ? "Send the selected agreements now? Clients with a portal login get a sign-in notice; the others get a signing link you copy from each agreement." : undefined}>
          <div className="overflow-x-auto rounded-xl border border-navy-100 bg-white">
            <table className="w-full min-w-[760px] text-sm" data-testid="bulk-table">
              <thead className="bg-navy-50 text-left text-navy-900"><tr><th className="px-3 py-2"><span className="sr-only">Select</span></th><th className="px-3 py-2">Client</th><th className="px-3 py-2">Agreement</th><th className="px-3 py-2 text-right">Fees</th><th className="px-3 py-2">Status</th><th className="px-3 py-2">Ready?</th><th className="px-3 py-2">Delivery</th></tr></thead>
              <tbody className="divide-y divide-navy-100">
                {rows.map((a) => {
                  const ready = a.blockers.length === 0 && (a.status === "DRAFT" || a.status === "WAITING_FOR_OWNER");
                  return (
                    <tr key={a.id} data-testid="bulk-row">
                      <td className="px-3 py-2">{ready && owner ? <input type="checkbox" name="agreementId" value={a.id} defaultChecked className="size-5 accent-navy-900" aria-label={`Select ${a.clientLabel}`} /> : null}</td>
                      <td className="px-3 py-2 font-medium">{a.clientLabel}</td>
                      <td className="px-3 py-2"><Link className="underline" href={`/agreements/${a.id}`}>{a.title}</Link></td>
                      <td className="px-3 py-2 text-right">{a.feeCents ? money(a.feeCents) : <span className="text-amber-800">No fee yet</span>}</td>
                      <td className="px-3 py-2"><StatusBadge status={displayStatus(a, today)} /></td>
                      <td className="px-3 py-2 text-xs">{a.status === "DRAFT" || a.status === "WAITING_FOR_OWNER" ? (a.blockers.length ? <span className="text-amber-900">{a.blockers.join(" ")}</span> : <span className="text-emerald-800">Ready</span>) : "—"}</td>
                      <td className="px-3 py-2 text-xs">{a.hasPortal ? "Portal notice" : "Signing link"}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-3">
            {owner ? <Button type="submit" variant="gold" data-testid="send-selected">Send selected</Button> : <p className="text-sm text-slate-700">Tabitha sends these. Open each draft and use “Ask Tabitha to send”.</p>}
            <p className="text-xs text-slate-600">Rows that aren&apos;t ready can&apos;t be selected — open them to fill in the missing details or wait for clause approval.</p>
          </div>
        </ActionForm>
      </>
    );
  }

  const candidates = await bulkCandidates(filter);
  return (
    <>
      <PageHeader title="Create for several clients" subtitle="One draft per client, each with its own fees prefilled. Nothing is sent." actions={<Link className="text-sm underline" href="/agreements">← All agreements</Link>} />
      <Card title="1 · Template and clients">
        <form method="get" className="grid gap-2 sm:grid-cols-3">
          <Field label="Template"><select className="input" name="template" defaultValue={template}>{tpls.map((t) => <option key={t.key} value={t.key}>{t.name}</option>)}</select></Field>
          <Field label="Clients"><select className="input" name="filter" defaultValue={filter}>{Object.entries(BULK_FILTERS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></Field>
          <div className="flex items-end"><Button type="submit" variant="secondary">Show clients</Button></div>
        </form>
      </Card>
      <Card className="mt-4" title={`2 · Select clients (${candidates.length})`}>
        {candidates.length === 0 ? <Notice>No clients match this filter.</Notice> : (
          <ActionForm action={bulkCreateAction}>
            <input type="hidden" name="templateKey" value={template} />
            <ul className="grid gap-x-4 sm:grid-cols-2" data-testid="bulk-candidates">
              {candidates.map((c) => (
                <li key={c.id}><label className="flex min-h-11 items-center gap-2 text-sm"><input type="checkbox" name="clientId" value={c.id} defaultChecked className="size-5 accent-navy-900" /> {c.label}<span className="text-xs text-slate-600">{c.monthlyFeeCents ? ` · ${money(c.monthlyFeeCents)}/mo on file` : " · no fee on file"}</span></label></li>
              ))}
            </ul>
            <Button type="submit" className="mt-3" data-testid="create-drafts">Create drafts</Button>
          </ActionForm>
        )}
      </Card>
    </>
  );
}
