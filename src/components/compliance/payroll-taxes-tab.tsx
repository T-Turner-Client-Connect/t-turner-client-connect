import Link from "next/link";
import type { Actor } from "@/lib/auth/actor";
import { Card, EmptyState } from "@/components/ui";
import { fmtD, NeedsVerification, StatusBadge } from "@/components/compliance/bits";
import { payrollTaxesTaxFeed } from "@/lib/services/compliance/payroll-bridge";

/**
 * ADP Payroll & Taxes → Taxes: the payroll, withholding, sales/use and information-return periods
 * from the Tax & Compliance Center (read-only here; work happens on the Tax Due Board).
 */
export async function ComplianceTaxesTab({ actor }: { actor: Actor }) {
  const feed = await payrollTaxesTaxFeed(actor);
  return (
    <Card title="Payroll, withholding & sales tax filings" actions={feed.canOpenBoard ? <Link href="/compliance?segment=payroll" className="text-sm font-semibold underline decoration-gold-500 underline-offset-4">Open the Tax Due Board</Link> : undefined}>
      <p className="mb-3 text-sm text-slate-600">From the Tax & Compliance Center: 941/940, W-2/W-3, Alabama A-6/A-1/A-3, Birmingham occupational tax, state/county/city sales tax and 1099s. Staff file in the government portal; nothing here files or pays.</p>
      {feed.rows.length === 0 ? <EmptyState title="No open tax filings">Approved obligations appear here with their due dates.</EmptyState> : (
        <div className="-mx-2 overflow-x-auto">
          <table className="w-full min-w-[720px] text-left text-sm" data-testid="payroll-taxes-compliance">
            <thead className="text-xs uppercase text-slate-600"><tr><th className="px-2 py-2">Due</th><th className="px-2">Client / entity</th><th className="px-2">Form</th><th className="px-2">Period</th><th className="px-2">Status</th><th className="px-2" /></tr></thead>
            <tbody className="divide-y divide-ivory-200">
              {feed.rows.map((r) => (
                <tr key={r.id}>
                  <td className="px-2 py-2">{fmtD(r.due)}{!r.dueCertain && <> <NeedsVerification /></>}</td>
                  <td className="px-2">{r.entityName}<span className="block text-xs text-slate-600">{r.clientName}</span></td>
                  <td className="px-2">{r.form}<span className="block text-xs text-slate-600">{r.jurisdiction}</span></td>
                  <td className="px-2">{r.periodKey}</td>
                  <td className="px-2"><StatusBadge status={r.status} /></td>
                  <td className="px-2 text-right">{feed.canOpenBoard && <Link href={`/compliance/periods/${r.id}`} className="font-semibold underline">Open</Link>}{r.portalUrl && <a href={r.portalUrl} target="_blank" rel="noopener noreferrer" className="ml-3 text-xs underline">Portal</a>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}
