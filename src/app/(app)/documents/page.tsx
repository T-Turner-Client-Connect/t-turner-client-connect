import Link from "next/link";
import { subDays } from "date-fns";
import { Badge, Card, Notice, PageHeader } from "@/components/ui";
import { requireUser } from "@/lib/auth/session";
import { prisma } from "@/lib/prisma";
import { CATEGORY_LABELS } from "@/lib/services/documents";
import { scanConfigured } from "@/lib/scan";
import { fmtDate } from "@/lib/format";

export const metadata = { title: "Documents" };

export default async function DocumentsHub() {
  await requireUser();
  const include = { client: { select: { id: true, displayName: true } } } as const;
  const [uploads, drafts, published, expired, counts] = await Promise.all([
    prisma.document.findMany({ where: { deletedAt: null, uploadedByPortalId: { not: null }, createdAt: { gte: subDays(new Date(), 30) } }, include, orderBy: { createdAt: "desc" }, take: 50 }),
    prisma.document.findMany({ where: { deletedAt: null, visibility: "STAFF_ONLY", category: { in: ["BOOKKEEPING", "TAXES"] } }, include, orderBy: { createdAt: "desc" }, take: 50 }),
    prisma.document.findMany({ where: { deletedAt: null, visibility: "PUBLISHED", uploadedByStaffId: { not: null } }, include, orderBy: { publishedAt: "desc" }, take: 20 }),
    prisma.document.findMany({ where: { deletedAt: null, retainUntil: { lt: new Date() } }, include, take: 50 }),
    prisma.document.groupBy({ by: ["category"], where: { deletedAt: null }, _count: true }),
  ]);
  const row = (d: (typeof uploads)[number], extra?: React.ReactNode) => (
    <li key={d.id} className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm">
      <span>
        <Link className="font-medium underline" href={`/clients/${d.client.id}?tab=documents`}>{d.title}</Link>
        <span className="text-slate-600"> · {d.client.displayName} · {CATEGORY_LABELS[d.category]}</span>
      </span>
      <span className="flex items-center gap-2 text-xs text-slate-500">{extra}{fmtDate(d.createdAt)}</span>
    </li>
  );
  return (
    <>
      <PageHeader title="Documents" subtitle="Private client documents across all accounts. Open a client to upload, publish or delete." />
      <div className="mb-4 flex flex-wrap gap-2">
        {counts.map((c) => <Badge key={c.category} tone="navy">{CATEGORY_LABELS[c.category]}: {c._count}</Badge>)}
      </div>
      {!scanConfigured() && <div className="mb-4"><Notice tone="warn" title="Malware scanning: setup required">Client uploads are type-checked but not virus-scanned until MALWARE_SCAN_URL is configured.</Notice></div>}
      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Client uploads (last 30 days)">
          {uploads.length ? <ul className="divide-y divide-ivory-200">{uploads.map((d) => row(d, d.scanStatus !== "CLEAN" && <Badge tone="gray">Not scanned</Badge>))}</ul> : <p className="text-sm text-slate-600">No recent uploads.</p>}
        </Card>
        <Card title="Staff-only drafts (not yet published)">
          {drafts.length ? <ul className="divide-y divide-ivory-200">{drafts.map((d) => row(d))}</ul> : <p className="text-sm text-slate-600">No unpublished reports or tax documents.</p>}
        </Card>
        <Card title="Recently published to clients">
          {published.length ? <ul className="divide-y divide-ivory-200">{published.map((d) => row(d))}</ul> : <p className="text-sm text-slate-600">Nothing published yet.</p>}
        </Card>
        <Card title="Past retention period">
          {expired.length ? (
            <>
              <ul className="divide-y divide-ivory-200">{expired.map((d) => row(d, <Badge tone="amber">Keep-until {fmtDate(d.retainUntil)}</Badge>))}</ul>
              <p className="mt-2 text-xs text-slate-600">Review with an Admin before deleting. Deletion is never automatic.</p>
            </>
          ) : (
            <p className="text-sm text-slate-600">No documents are past their retention period.</p>
          )}
        </Card>
      </div>
    </>
  );
}
