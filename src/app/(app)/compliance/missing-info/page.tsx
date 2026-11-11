import Link from "next/link";
import { Card, EmptyState, PageHeader } from "@/components/ui";
import { ComplianceNav } from "@/components/compliance/bits";
import { WindowPrintButton } from "@/components/window-print-button";
import { requireCompliancePage } from "@/lib/compliance/page-gate";
import { missingInfoReport } from "@/lib/services/compliance/views";

export const metadata = { title: "Missing compliance information" };

export default async function MissingInfoPage({ searchParams }: { searchParams: Promise<{ clientId?: string }> }) {
  const { actor, access } = await requireCompliancePage();
  const { clientId } = await searchParams;
  const rows = await missingInfoReport(actor, { clientId });
  const csv = `/api/compliance/missing-info${clientId ? `?clientId=${encodeURIComponent(clientId)}` : ""}`;
  return (
    <>
      <PageHeader title="Missing Compliance Information" subtitle={`${rows.length} gap${rows.length === 1 ? "" : "s"} that block a confirmed obligation${clientId ? " for this client" : " office-wide"}. Nothing is filled in automatically.`} actions={<span className="flex gap-2 print:hidden"><a href={csv} className="rounded-lg border border-ivory-200 bg-white px-4 py-2 text-sm font-semibold">Export CSV</a><WindowPrintButton /></span>} />
      <div className="print:hidden"><ComplianceNav current="/compliance/missing-info" isOwner={access.isOwner} /></div>
      <Card>
        {rows.length === 0 ? <EmptyState title="Nothing missing" /> : (
          <div className="-mx-2 overflow-x-auto">
            <table className="w-full min-w-[720px] text-left text-sm" data-testid="missing-info">
              <thead className="text-xs uppercase text-slate-600"><tr><th className="px-2 py-2">Client</th><th className="px-2">Entity</th><th className="px-2">Missing information</th><th className="px-2">Blocks</th><th className="px-2">Source</th></tr></thead>
              <tbody className="divide-y divide-ivory-200">{rows.map((r, i) => <tr key={i}><td className="px-2 py-1.5">{r.clientName}</td><td className="px-2"><Link href={`/compliance/entities/${r.entityId}`} className="underline">{r.entityName}</Link></td><td className="px-2">{r.item}</td><td className="px-2 text-xs">{r.blocks}</td><td className="px-2 text-xs">{r.source}</td></tr>)}</tbody>
            </table>
          </div>
        )}
      </Card>
    </>
  );
}
