import Link from "next/link";
import { Badge, EmptyState, LinkButton, PageHeader } from "@/components/ui";
import { requireUser } from "@/lib/auth/session";
import { prisma } from "@/lib/prisma";
import { fmtDateTime } from "@/lib/format";

export const metadata = { title: "Imports" };

export default async function ImportsPage() {
  await requireUser();
  const batches = await prisma.importBatch.findMany({
    orderBy: { createdAt: "desc" },
    take: 100,
    include: { importedBy: { select: { name: true } }, _count: { select: { rows: true } } },
  });
  return (
    <>
      <PageHeader title="Imports" subtitle="Every import records its date, source, and the staff member who ran it." actions={<><LinkButton href="/imports/tax" variant="secondary">Import TaxAct e-file statuses</LinkButton><LinkButton href="/imports/new">Import contacts</LinkButton></>} />
      {batches.length === 0 ? (
        <EmptyState title="No imports yet">Export your client list from TaxAct as CSV or Excel, then import it here.</EmptyState>
      ) : (
        <ul className="divide-y divide-navy-100 rounded-xl border border-navy-100 bg-white">
          {batches.map((b) => (
            <li key={b.id}>
              <Link href={`/imports/${b.id}`} className="flex flex-wrap items-center justify-between gap-2 px-4 py-3 hover:bg-navy-50">
                <div>
                  <p className="font-semibold text-navy-900">{b.fileName}</p>
                  <p className="text-sm text-slate-600">{b.source} · {b.importedBy.name} · {fmtDateTime(b.createdAt)}</p>
                </div>
                <div className="flex flex-wrap gap-1">
                  {b.status === "REVIEW" && <Badge tone="gold">Waiting for review</Badge>}
                  {b.status === "DISCARDED" && <Badge tone="gray">Discarded</Badge>}
                  {b.status === "COMMITTED" && <Badge tone="green">{b.createdCount} new · {b.updatedCount} updated · {b.skippedCount} skipped</Badge>}
                  <Badge tone="navy">{b._count.rows} rows</Badge>
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
