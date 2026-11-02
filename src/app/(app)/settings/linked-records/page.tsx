import Link from "next/link";
import { connection } from "next/server";
import { ActionForm } from "@/components/action-form";
import { Badge, Button, Card, EmptyState, Notice, PageHeader } from "@/components/ui";
import { unlinkBusinessAction } from "@/app/actions/related-businesses";
import { requireUser } from "@/lib/auth/session";
import { relationshipReview } from "@/lib/services/related-businesses";
import { fmtDateTime } from "@/lib/format";

export const metadata = { title: "Linked records review" };

/**
 * Admins: every owner ↔ business link, read-only — who created it and when, and
 * flags to review (a business under more than one owner, no shared contact
 * details, portal access granted through the link and whether it was used).
 * Nothing on this page changes records.
 */
export default async function LinkedRecordsPage() {
  await connection();
  const user = await requireUser();
  if (user.role !== "ADMIN") return <Notice tone="warn">Only Admins can review linked records.</Notice>;
  const rows = await relationshipReview(user);
  const flagged = rows.filter((r) => r.flags.length);
  return (
    <>
      <PageHeader title="Linked records review" subtitle="Every owner ↔ business link, with who created it and when. Nothing changes unless an Admin removes a specific link with a written reason; the removed link is kept in the activity log." />
      <p className="mb-4 text-sm" data-testid="review-summary">{rows.length} link{rows.length === 1 ? "" : "s"} · <strong>{flagged.length} flagged for review</strong></p>
      {rows.length === 0 && <EmptyState title="No linked records">No owner has linked businesses yet.</EmptyState>}
      <Card title="Links">
        <ul className="divide-y divide-ivory-200 text-sm" data-testid="review-rows">
          {[...flagged, ...rows.filter((r) => !r.flags.length)].map((r) => (
            <li key={r.id} className="py-3" data-flagged={r.flags.length ? "yes" : "no"}>
              <p>
                <Link className="font-semibold underline" href={`/clients/${r.person.id}`}>{r.person.name}</Link> → <Link className="font-semibold underline" href={`/clients/${r.business.id}`}>{r.business.name}</Link>{" "}
                <span className="text-xs text-slate-600">({r.business.type === "NONPROFIT" ? "Nonprofit" : "Business"} · {r.role})</span>
              </p>
              <p className="text-xs text-slate-600">Linked {fmtDateTime(r.createdAt)} by {r.createdBy}</p>
              {r.flags.length > 0 && <p className="mt-1 flex flex-wrap gap-1">{r.flags.map((f) => <Badge key={f} tone="amber">{f}</Badge>)}</p>}
              <details className="mt-1 text-xs">
                <summary className="cursor-pointer underline">Remove this link (after reviewing the evidence)</summary>
                <ActionForm action={unlinkBusinessAction.bind(null, r.person.id, r.business.id)} confirm={`Remove the link between ${r.person.name} and ${r.business.name}? Both records stay; only the link is removed and it's recorded in the activity log.`} className="mt-1 flex flex-wrap gap-1">
                  <input className="input w-80" name="reason" placeholder="What you checked and why this link is wrong" required />
                  <input className="input w-64" name="confirmName" placeholder="Organization name (required for its original or only owner link)" />
                  <Button type="submit" variant="ghost">Remove link</Button>
                </ActionForm>
              </details>
            </li>
          ))}
        </ul>
      </Card>
    </>
  );
}
