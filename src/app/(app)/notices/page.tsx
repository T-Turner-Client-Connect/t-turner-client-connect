import Link from "next/link";
import { connection } from "next/server";
import { ActionForm } from "@/components/action-form";
import { Badge, Button, Card, EmptyState, PageHeader } from "@/components/ui";
import { noticeStatusAction } from "@/app/actions/notices";
import { requireUser } from "@/lib/auth/session";
import { AGENCIES, deadlineFlag, NOTICE_STATUS, openNoticeCases } from "@/lib/services/notices";
import { fmtDate, fmtDateTime } from "@/lib/format";

export const metadata = { title: "Audits & Notices" };

/** Open audit and tax-notice cases across clients, soonest response deadline first. */
export default async function NoticesPage() {
  await connection();
  await requireUser();
  const cases = await openNoticeCases();
  return (
    <>
      <PageHeader title="Audits & Notices" subtitle="Letters clients sent from the IRS, states and cities. “Received” means only that we have it — update the status as you work it." />
      {cases.length === 0 ? (
        <EmptyState title="No open notices" />
      ) : (
        <Card>
          <ul className="divide-y divide-navy-100 text-sm" data-testid="notice-cases">
            {cases.map((c) => {
              const flag = deadlineFlag(c);
              return (
                <li key={c.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
                  <span>
                    <Link className="font-semibold underline" href={`/clients/${c.client.id}?tab=documents`}>{c.client.displayName}</Link> · {AGENCIES[c.agency as keyof typeof AGENCIES]}{c.agencyDetail && ` (${c.agencyDetail})`} · tax year {c.taxYear ?? "not sure"} · {c.documents.length} file{c.documents.length === 1 ? "" : "s"}
                    <span className="block text-xs text-slate-600">Uploaded {fmtDateTime(c.createdAt)}{c.receivedOn && ` · received by client ${fmtDate(c.receivedOn)}`}{c.clientMessage && ` · “${c.clientMessage.slice(0, 120)}”`}</span>
                    {flag ? <Badge tone={flag.tone} className="mt-1">{flag.text}</Badge> : !c.responseDueOn && <Badge tone="amber" className="mt-1">Deadline unknown — check the letter</Badge>}
                  </span>
                  <ActionForm action={noticeStatusAction.bind(null, c.id)} className="flex items-center gap-2" showSuccess={false}>
                    <select className="input w-auto" name="status" defaultValue={c.status} aria-label="Status">{Object.entries(NOTICE_STATUS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}</select>
                    <Button type="submit" variant="secondary">Save</Button>
                  </ActionForm>
                </li>
              );
            })}
          </ul>
        </Card>
      )}
    </>
  );
}
