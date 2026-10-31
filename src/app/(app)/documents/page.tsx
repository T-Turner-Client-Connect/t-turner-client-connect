import Link from "next/link";
import { financialStatementAudit } from "@/lib/services/documents";
import { subDays } from "date-fns";
import { Badge, Button, Card, Notice, PageHeader } from "@/components/ui";
import { ActionForm } from "@/components/action-form";
import { UploadDocumentForm } from "@/components/upload-document-form";
import { scanNowAction, scannerSelfTestAction } from "@/app/actions/workspace";
import { quarantinedDocuments } from "@/lib/services/documents";
import { scanProvider } from "@/lib/scan";
import { ScanStatus } from "@/components/scan-status";
import { scanHealth } from "@/lib/services/documents";
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
    prisma.document.findMany({ where: { deletedAt: null, category: { not: "IDENTITY" }, uploadedByPortalId: { not: null }, createdAt: { gte: subDays(new Date(), 30) } }, include, orderBy: { createdAt: "desc" }, take: 50 }),
    prisma.document.findMany({ where: { deletedAt: null, visibility: "STAFF_ONLY", category: { in: ["BOOKKEEPING", "TAXES"] } }, include, orderBy: { createdAt: "desc" }, take: 50 }),
    prisma.document.findMany({ where: { deletedAt: null, category: { not: "IDENTITY" }, visibility: "PUBLISHED", uploadedByStaffId: { not: null } }, include, orderBy: { publishedAt: "desc" }, take: 20 }),
    prisma.document.findMany({ where: { deletedAt: null, retainUntil: { lt: new Date() } }, include, take: 50 }),
    prisma.document.groupBy({ by: ["category"], where: { deletedAt: null }, _count: true }),
  ]);
  const [clients, quarantined, needsReview, lastCheck] = await Promise.all([
    prisma.client.findMany({ where: { archivedAt: null }, select: { id: true, displayName: true }, orderBy: { displayName: "asc" } }),
    quarantinedDocuments(),
    prisma.document.findMany({ where: { deletedAt: null, category: { not: "IDENTITY" }, needsReview: true }, include, orderBy: { createdAt: "asc" }, take: 50 }),
    prisma.scannerCheck.findFirst({ orderBy: { createdAt: "desc" } }),
  ]);
  const idPending = await prisma.identityDocument.groupBy({ by: ["clientId"], where: { status: "PENDING_VERIFICATION" }, _count: true });
  const clientName = new Map(clients.map((c) => [c.id, c.displayName]));
  const provider = scanProvider();
  const health = await scanHealth();
  // Admins: files that may be financial statements outside the approval flow (read-only).
  const audit = user.role === "ADMIN" ? await financialStatementAudit() : [];
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
      {audit.length > 0 && (
        <Card title={`Financial statement check — ${audit.length} file${audit.length === 1 ? "" : "s"} to review`} className="mb-4">
          <p className="mb-2 text-sm text-slate-700">Financial statements reach clients only through <strong>Upload Monthly Financials → Tabitha&apos;s approval → Deliver</strong>. These files may be statements filed another way. Nothing has been changed or deleted; review each one.</p>
          <ul className="max-h-72 divide-y divide-ivory-200 overflow-y-auto text-sm" data-testid="statement-audit">
            {audit.map((a) => (
              <li key={a.doc.id} className="py-2" data-level={a.level}>
                <Link className="underline" href={`/clients/${a.doc.clientId}?tab=documents`}>{a.doc.title}</Link> · {a.doc.client.businessName || a.doc.client.displayName}{" "}
                <Badge tone={a.level === "PUBLISHED_OUTSIDE_FLOW" ? "red" : "amber"}>{a.level === "PUBLISHED_OUTSIDE_FLOW" ? "Was published without approval" : a.level === "UNCLASSIFIED_BOOKKEEPING" ? "Needs classification" : "Name suggests a statement"}</Badge>
                <span className="block text-xs text-slate-600">{a.reason} Uploaded {fmtDateTime(a.doc.createdAt)}.</span>
              </li>
            ))}
          </ul>
        </Card>
      )}
      {idPending.length > 0 && (
        <div className="mb-4">
          <Notice tone="warn" title="Identity documents pending verification">
            {idPending.map((p, i) => (
              <span key={p.clientId}>{i > 0 && " · "}<Link className="underline" href={`/clients/${p.clientId}?tab=documents#identity`}>{clientName.get(p.clientId) ?? "Client"} ({p._count})</Link></span>
            ))}
            <span className="block text-xs">Only Admins and each client&apos;s assigned staff member can open them.</span>
          </Notice>
        </div>
      )}
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
            <ul className="space-y-1" data-testid="scan-setup">
              <li>{health.configured ? "✅" : "❌"} Scanner connected {health.configured ? `(${provider})` : "— set MALWARE_SCAN_PROVIDER and the scanner's settings in Netlify (see docs/INTEGRATIONS.md)"}</li>
              <li>{health.selfTest?.ok ? "✅" : "❌"} Self-test {health.selfTest ? (health.selfTest.ok ? `passed ${fmtDateTime(health.selfTest.at)}` : `failed ${fmtDateTime(health.selfTest.at)}`) : "not run yet"} — the standard antivirus test file must be blocked and a clean file must pass</li>
              <li data-testid="recheck-status">
                {health.recheckRunning && health.configured && health.cronSecretSet ? "✅" : "❌"} Automatic re-check every 10 minutes —{" "}
                {!health.cronSecretSet
                  ? "not verified. CRON_SECRET isn't set on this site, so the scheduled job's requests are refused (HTTP 401) and nothing is re-checked automatically."
                  : !health.lastRecheckAt
                    ? "not verified: no scheduled run has been recorded yet. CRON_SECRET is set; after the next deploy finishes, a scheduled run should appear here within 10 minutes (Netlify → Functions → notifications-cron should log “notifications: HTTP 200”)."
                    : !health.recheckRunning
                      ? `stopped: last scheduled run ${fmtDateTime(health.lastRecheckAt)}, more than 30 minutes ago.`
                      : health.lastRecheck?.configured === false
                        ? `the schedule ran (last ${fmtDateTime(health.lastRecheckAt)}), but no scanner is connected, so it couldn't scan anything.`
                        : `verified: last scheduled run ${fmtDateTime(health.lastRecheckAt)} checked ${health.lastRecheck?.scanned ?? 0} file(s): ${health.lastRecheck?.clean ?? 0} clean, ${health.lastRecheck?.infected ?? 0} blocked.`}
                {health.lastRefusedAt && (!health.lastRecheckAt || health.lastRefusedAt > health.lastRecheckAt) && (
                  <> Last refused request to the scheduled endpoint: {fmtDateTime(health.lastRefusedAt)} ({health.cronSecretSet ? "the secret sent didn't match — check CRON_SECRET's scopes include Functions, then redeploy" : "CRON_SECRET not set"}).</>
                )}
              </li>
              <li data-testid="manual-scan-status">
                Last manual scan (“Scan quarantined files now”): {health.lastManualAt ? fmtDateTime(health.lastManualAt) : "none"} — a manual scan never counts as the automatic re-check.
              </li>
            </ul>
            {user.role === "ADMIN" && (
              <details className="text-xs" data-testid="scan-settings" open={!health.configured || !health.cronSecretSet}>
                <summary className="cursor-pointer font-semibold">Settings this site can see (Netlify)</summary>
                <ul className="mt-1 font-mono">
                  {Object.entries(health.settings).map(([k, v]) => <li key={k}>{k}: {v}</li>)}
                </ul>
                <p className="mt-1">Values are never shown. After changing Netlify variables, redeploy so the site picks them up.</p>
              </details>
            )}
            {!scanConfigured() && (
              <Notice tone="warn">Every new file stays quarantined — no downloads, nothing shown to clients — until a scanner is connected and the file passes.</Notice>
            )}
            <p data-testid="quarantine-summary">
              {quarantined.length === 0 ? "No files in quarantine." : `${quarantined.length} file(s) in quarantine — not downloadable and not shown to clients until a scan passes.`}{" "}
              {health.configured && health.recheckRunning && health.cronSecretSet ? "They're re-checked automatically every 10 minutes." : "Until a scheduled run is verified above, they're re-checked only when you press “Scan quarantined files now”."}
            </p>
            <div className="flex flex-wrap gap-2">
              <ActionForm action={scanNowAction}><Button type="submit" variant="secondary" disabled={!scanConfigured()}>Scan quarantined files now</Button></ActionForm>
              {user.role === "ADMIN" && <ActionForm action={scannerSelfTestAction}><Button type="submit" variant="ghost" disabled={!scanConfigured()}>Run scanner self-test</Button></ActionForm>}
            </div>
            {quarantined.length > 0 && (
              <ul className="max-h-56 divide-y divide-ivory-200 overflow-y-auto" data-testid="quarantine-list">
                {quarantined.map((d) => (
                  <li key={d.id} className="flex flex-wrap items-center justify-between gap-2 py-1.5">
                    <span><Link className="underline" href={`/clients/${d.client.id}?tab=documents`}>{d.title}</Link> · {d.client.displayName}</span>
                    <ScanStatus doc={d} health={health} />
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
            <ul className="divide-y divide-ivory-200">{needsReview.map((d) => row(d, <><Badge tone="gold">{d.year ?? "Year?"}</Badge><ScanStatus doc={d} health={health} compact /></>))}</ul>
          </Card>
        </div>
      )}
      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Client uploads (last 30 days)">
          {uploads.length ? <ul className="divide-y divide-ivory-200">{uploads.map((d) => row(d, <ScanStatus doc={d} health={health} compact />))}</ul> : <p className="text-sm text-slate-600">No recent uploads.</p>}
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
