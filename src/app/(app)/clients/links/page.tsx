import Link from "next/link";
import { connection } from "next/server";
import { ActionForm } from "@/components/action-form";
import { Button, Card, EmptyState, Notice, PageHeader } from "@/components/ui";
import { confirmLinkAction } from "@/app/actions/related-businesses";
import { requireUser } from "@/lib/auth/session";
import { possibleDuplicatePeople, proposedLinks } from "@/lib/services/related-businesses";

export const metadata = { title: "Owner & business links" };

/** Admin review: proposed owner↔business links and possible duplicate people. Nothing merges or deletes automatically. */
export default async function LinksReview() {
  await connection();
  const user = await requireUser();
  if (user.role !== "ADMIN") return <Notice tone="warn">Only an Admin can review owner and business links.</Notice>;
  const [proposals, dupes] = await Promise.all([proposedLinks(), possibleDuplicatePeople()]);
  return (
    <>
      <PageHeader title="Owner & business links" subtitle="Suggested links between a person's Personal record and businesses they may own. Confirm only what you've verified — nothing is merged or deleted." />
      <Card title={`Proposed links (${proposals.length})`} className="mb-4">
        {proposals.length === 0 ? <EmptyState title="No suggestions right now" /> : (
          <ul className="divide-y divide-navy-100 text-sm" data-testid="link-proposals">
            {proposals.map((p) => (
              <li key={`${p.person.id}:${p.business.id}`} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <span><Link className="underline" href={`/clients/${p.person.id}`}>{p.person.displayName}</Link> ↔ <Link className="underline" href={`/clients/${p.business.id}`}>{p.business.displayName}</Link> <span className="text-xs text-slate-600">({p.reason})</span></span>
                <ActionForm action={confirmLinkAction.bind(null, p.person.id, p.business.id)} confirm={`Link ${p.business.displayName} to ${p.person.displayName}? This doesn't merge records or grant portal access.`}><Button type="submit" variant="secondary">Confirm link</Button></ActionForm>
              </li>
            ))}
          </ul>
        )}
      </Card>
      <Card title={`Possible duplicate people (${dupes.length})`}>
        {dupes.length === 0 ? <EmptyState title="None found" /> : (
          <ul className="space-y-1 text-sm">{dupes.map((d, i) => <li key={i}>{d.clients.map((c, k) => <span key={c.id}>{k > 0 && " · "}<Link className="underline" href={`/clients/${c.id}`}>{c.displayName}</Link></span>)} <span className="text-xs text-slate-600">({d.reason}) — review and correct by hand; nothing is merged automatically.</span></li>)}</ul>
        )}
      </Card>
    </>
  );
}
