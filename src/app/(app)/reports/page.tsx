import { Card, PageHeader } from "@/components/ui";
import { requireUser } from "@/lib/auth/session";
import { prisma } from "@/lib/prisma";
import { CLIENT_STATUS_LABELS, CLIENT_TYPE_LABELS } from "@/lib/format";
import { FILING_LABELS, PREP_LABELS } from "@/lib/tax/normalize";
import { PERIOD_LABELS } from "@/lib/services/bookkeeping";

export const metadata = { title: "Reports" };

function Table({ rows }: { rows: [string, number][] }) {
  const total = rows.reduce((n, [, v]) => n + v, 0);
  if (!total) return <p className="text-sm text-slate-600">No data yet.</p>;
  return (
    <table className="w-full text-sm">
      <tbody className="divide-y divide-ivory-200">
        {rows.map(([label, v]) => (
          <tr key={label}>
            <td className="py-2">{label}</td>
            <td className="w-1/2 py-2">
              <div className="flex items-center gap-2">
                <div className="h-2 rounded-full bg-navy-800" style={{ width: `${Math.max(2, (v / total) * 100)}%` }} aria-hidden />
                <span className="font-semibold tabular-nums">{v}</span>
              </div>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export default async function Reports() {
  await requireUser();
  const [byStatus, byType, msgs, requests, periods, prep, filing, campaigns, social] = await Promise.all([
    prisma.client.groupBy({ by: ["status"], where: { archivedAt: null }, _count: true }),
    prisma.client.groupBy({ by: ["clientType"], where: { archivedAt: null }, _count: true }),
    prisma.message.groupBy({ by: ["channel", "status"], _count: true }),
    prisma.documentRequest.groupBy({ by: ["status"], _count: true }),
    prisma.bookkeepingPeriod.groupBy({ by: ["status"], _count: true }),
    prisma.filingRecord.groupBy({ by: ["prepStatus"], _count: true }),
    prisma.filingRecord.groupBy({ by: ["filingStatus"], _count: true }),
    prisma.campaign.groupBy({ by: ["status"], _count: true }),
    prisma.socialPostTarget.groupBy({ by: ["status"], _count: true }),
  ]);
  const label = (s: string) => s.charAt(0) + s.slice(1).toLowerCase().replace(/_/g, " ");
  return (
    <>
      <PageHeader title="Reports" subtitle="Counts from records in the CRM. Nothing here is estimated." />
      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Clients by status"><Table rows={byStatus.map((r) => [CLIENT_STATUS_LABELS[r.status], r._count])} /></Card>
        <Card title="Clients by type"><Table rows={byType.map((r) => [CLIENT_TYPE_LABELS[r.clientType], r._count])} /></Card>
        <Card title="Messages by channel and result"><Table rows={msgs.map((r) => [`${label(r.channel)} — ${label(r.status)}`, r._count])} /></Card>
        <Card title="Document requests"><Table rows={requests.map((r) => [label(r.status), r._count])} /></Card>
        <Card title="Bookkeeping months"><Table rows={periods.map((r) => [PERIOD_LABELS[r.status], r._count])} /></Card>
        <Card title="Tax preparation (all filings)"><Table rows={prep.map((r) => [PREP_LABELS[r.prepStatus], r._count])} /></Card>
        <Card title="E-file status (all filings)"><Table rows={filing.map((r) => [FILING_LABELS[r.filingStatus], r._count])} /></Card>
        <Card title="Email & text campaigns"><Table rows={campaigns.map((r) => [label(r.status), r._count])} /></Card>
        <Card title="Social posts by platform result"><Table rows={social.map((r) => [label(r.status), r._count])} /></Card>
      </div>
      <p className="mt-4 text-xs text-slate-600">Delivery and engagement reporting for email, text and social will appear once those integrations are connected and report real results.</p>
    </>
  );
}
