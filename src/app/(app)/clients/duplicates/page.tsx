import Link from "next/link";
import { Badge, Card, EmptyState, PageHeader } from "@/components/ui";
import { requireUser } from "@/lib/auth/session";
import { possibleDuplicates } from "@/lib/services/client-merge";
import { fmtDate } from "@/lib/format";

export const metadata = { title: "Possible duplicates" };

export default async function DuplicatesPage() {
  await requireUser();
  const pairs = await possibleDuplicates();
  return (
    <>
      <PageHeader title="Possible duplicate clients" subtitle="Records that may be the same person or household. Nothing is merged or deleted automatically — compare each pair, then an Admin decides." />
      {pairs.length === 0 ? <EmptyState title="No possible duplicates found" /> : (
        <Card>
          <ul className="divide-y divide-ivory-200 text-sm" data-testid="duplicate-pairs">
            {pairs.map((p) => (
              <li key={`${p.a.id}|${p.b.id}`} className="flex flex-wrap items-center justify-between gap-2 py-3">
                <span>
                  <Link className="font-semibold underline" href={`/clients/${p.a.id}`}>{p.a.displayName}</Link> <span className="text-xs text-slate-500">({fmtDate(p.a.createdAt)}{p.a.source ? ` · ${p.a.source}` : ""})</span>
                  <span className="mx-2 text-slate-400">and</span>
                  <Link className="font-semibold underline" href={`/clients/${p.b.id}`}>{p.b.displayName}</Link> <span className="text-xs text-slate-500">({fmtDate(p.b.createdAt)}{p.b.source ? ` · ${p.b.source}` : ""})</span>
                  <span className="ml-2">{p.why.map((w) => <Badge key={w} tone={w === "Same name" ? "gray" : "amber"} className="ml-1">{w}</Badge>)}</span>
                </span>
                <Link className="text-sm font-semibold underline" href={`/clients/duplicates/merge?keep=${p.a.id}&dup=${p.b.id}`}>Compare</Link>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </>
  );
}
