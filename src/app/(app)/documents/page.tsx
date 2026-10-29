import Link from "next/link";
import { subDays } from "date-fns";
import { Badge, Button, Card, Notice, PageHeader } from "@/components/ui";
import { ActionForm } from "@/components/action-form";
import { UploadDocumentForm } from "@/components/upload-document-form";
import { scanNowAction, scannerSelfTestAction } from "@/app/actions/workspace";
import { quarantinedDocuments } from "@/lib/services/documents";
import { scanProvider } from "@/lib/scan";
import { SCAN_LABELS } from "@/lib/scan-labels";
import { requireUser } from "@/lib/auth/session";
import { prisma } from "@/lib/prisma";
import { CATEGORY_LABELS } from "@/lib/services/documents";
import { scanConfigured } from "@/lib/scan";
import { fmtDate, fmtDateTime } from "@/lib/format";

export const metadata = { title: "Documents" };

export default async function DocumentsHub() {
  const user = await requireUser();
  const include = { client: { select: { id: true, displayName: true } } } as const;
  const [uploads, drafts, published, expired, counts] = await Promise.all([
    prisma.document.findMany({ where: { deletedAt: null, uploadedByPortalId: { not: null }, createdAt: { gte: subDays(new Date(), 30) } }, include, orderBy: { createdAt: "desc" }, take: 50 }),
    prisma.document.findMany({ where: { deletedAt: null, visibility: "STAFF_ONLY", category: { in: ["BOOKKEEPING", "TAXES"] } }, include, orderBy: { createdAt: "desc" }, take: 50 }),
    prisma.document.findMany({ where: { deletedAt: null, visibility: "PUBLISHED", uploadedByStaffId: { not: null } }, include, orderBy: { publishedAt: "desc" }, take: 20 }),
    prisma.document.findMany({ where: { deletedAt: null, retainUntil: { lt: new Date() } }, include, take: 50 }),
    prisma.document.groupBy({ by: ["category"], where: { deletedAt: null }, _count: true }),
  ]);
  const [clients, quarantined, needsReview, lastCheck] = await Promise.all([
    prisma.client.findMany({ where: { archivedAt: null }, select: { id: true, displayName: true }, orderBy: { displayName: "asc" } }),
    quarantinedDocuments(),
    prisma.document.findMany({ where: { deletedAt: null, needsReview: true }, include, orderBy: { createdAt: "asc" }, take: 50 }),
    prisma.scannerCheck.findFirst({ orderBy: { createdAt: "desc" } }),
  ]);
  const provider = scanProvider();
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
      <PageHeader title="Documents" subtitle="Private client documents across all accounts." actions={<a href="#upload" className="rounded-lg bg-navy-900 px-4 py-2 text-sm font-semibold text-white">Upload Document</a>} />
      <div className="mb-4 flex flex-wrap gap-2">
        {counts.map((c) => <Badge key={c.category} tone="navy">{CATEGORY_LABELS[c.category]}: {c._count}</Badge>)}
      </div>
      <div className="mb-4 grid gap-4 lg:grid-cols-2">
        <Card title="Upload Document" className="scroll-mt-6" >
          <div id="upload" />
          <UploadDocumentForm clients={clients} />
        </Card>
        <Card title="Malware scanning">
          <div className="space-y-2 text-sm" data-testid="scan-card">
            <p>
              Scanner: {provider ? <Badge tone="green">{provider === "clamav-rest" ? "ClamAV (your server)" : provider === "cloudmersive" ? "Cloudmersive" : "Custom scanner"}</Badge> : <Badge tone="red">Not set up</Badge>}{" "}
              {lastCheck && (lastCheck.ok ? <Badge tone="green">Self-test passed {fmtDateTime(lastCheck.createdAt)}</Badge> : <Badge tone="red">Self-test failed {fmtDateTime(lastCheck.createdAt)}</Badge>)}
            </p>
            {!scanConfigured() && (
              <Notice tone="warn">Every new file stays quarantined — no downloads, nothing shown to clients — until a scanner is connected and the file passes.</Notice>
            )}
            <p>{quarantined.length === 0 ? "No files in quarantine." : `${quarantined.length} file(s) in quarantine.`} Files are re-checked automatically every 10 minutes.</p>
            <div className="flex flex-wrap gap-2">
              <ActionForm action={scanNowAction}><Button type="submit" variant="secondary" disabled={!scanConfigured()}>Scan quarantined files now</Button></ActionForm>
              {user.role === "ADMIN" && <ActionForm action={scannerSelfTestAction}><Button type="submit" variant="ghost" disabled={!scanConfigured()}>Run scanner self-test</Button></ActionForm>}
            </div>
            {quarantined.length > 0 && (
              <ul className="max-h-56 divide-y divide-ivory-200 overflow-y-auto" data-testid="quarantine-list">
                {quarantined.map((d) => (
                  <li key={d.id} className="flex flex-wrap items-center justify-between gap-2 py-1.5">
                    <span><Link className="underline" href={`/clients/${d.client.id}?tab=documents`}>{d.title}</Link> · {d.client.displayName}</span>
                    <Badge tone={SCAN_LABELS[d.scanStatus].tone}>{SCAN_LABELS[d.scanStatus].text}</Badge>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </Card>
      </div>
      {needsReview.length > 0 && (
        <div className="mb-4">
          <Card title={`Client uploads waiting for review (${needsReview.length})`}>
            <ul className="divide-y divide-ivory-200">{needsReview.map((d) => row(d, <><Badge tone="gold">{d.year ?? "Year?"}</Badge><Badge tone={SCAN_LABELS[d.scanStatus].tone}>{SCAN_LABELS[d.scanStatus].text}</Badge></>))}</ul>
          </Card>
        </div>
      )}
      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Client uploads (last 30 days)">
          {uploads.length ? <ul className="divide-y divide-ivory-200">{uploads.map((d) => row(d, <Badge tone={SCAN_LABELS[d.scanStatus].tone}>{SCAN_LABELS[d.scanStatus].text}</Badge>))}</ul> : <p className="text-sm text-slate-600">No recent uploads.</p>}
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
