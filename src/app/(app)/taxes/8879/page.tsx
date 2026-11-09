import Link from "next/link";
import { connection } from "next/server";
import { Badge, Card, EmptyState, PageHeader } from "@/components/ui";
import { requireUser } from "@/lib/auth/session";
import { signedDate, summaryTracker, TRACKER_FILTERS, type TrackerFilter, type TrackerRow } from "@/lib/services/auto-tax-summary";
import { fmtDateTime } from "@/lib/format";

export const metadata = { title: "8879 Signature Page" };

const FILTER_LABEL: Record<TrackerFilter, string> = {
  ALL: "All", ACTION: "Needs my action", HELD: "Held", READY: "Ready", SENT: "Sent", QUESTIONS: "Questions", APPROVED: "Approved",
  "8879_WAITING": "8879 waiting to send", "8879_SENT": "8879 sent", "8879_SIGNED": "8879 signed", "8879_RESIGN": "8879 needs re-signing", "8879_MISMATCH": "8879 numbers don't match",
};
const SUMMARY_TONE: Record<TrackerRow["summary"]["code"], "gray" | "gold" | "green" | "red"> = { HELD: "red", READY: "gold", SENT: "gray", APPROVED: "green", QUESTIONS: "red", DRAFT: "gray" };
const F_TONE: Record<TrackerRow["form8879"]["code"], "gray" | "gold" | "green" | "red"> = { NONE: "gray", WAITING: "gold", SENT: "gray", SIGNED: "green", NEEDS_RESIGN: "red", MISMATCH: "red" };

/**
 * Firm-wide: every client with a summary for the tax year, its approval and
 * its Form 8879. Rows needing Tabitha come first. Signed 8879 PDFs stay in
 * each client's Documents › Taxes › year; this page only links to them.
 */
export default async function Form8879Page({ searchParams }: { searchParams: Promise<{ year?: string; status?: string }> }) {
  await connection();
  const user = await requireUser();
  const sp = await searchParams;
  const thisYear = new Date().getFullYear();
  const year = Number(sp.year) >= 2000 && Number(sp.year) <= thisYear ? Number(sp.year) : thisYear - 1;
  const filter = (TRACKER_FILTERS as readonly string[]).includes(sp.status ?? "") ? (sp.status as TrackerFilter) : "ALL";
  const rows = await summaryTracker(user, year, filter);
  const years = Array.from({ length: 5 }, (_, i) => thisYear - i);

  return (
    <>
      <PageHeader title={`8879 Signature Page — Tax Year ${year}`} subtitle="Each client's tax summary and Form 8879 for the year. Rows that need you come first. Signed 8879s stay in the client's Documents › Taxes." />
      <form method="get" className="mb-4 flex flex-wrap items-end gap-3" data-testid="tracker-filters">
        <label className="block text-sm font-semibold text-navy-900">Tax year
          <select name="year" defaultValue={year} className="input mt-1 min-h-11">{years.map((y) => <option key={y} value={y}>{y}</option>)}</select>
        </label>
        <label className="block text-sm font-semibold text-navy-900">Show
          <select name="status" defaultValue={filter} className="input mt-1 min-h-11">{TRACKER_FILTERS.map((f) => <option key={f} value={f}>{FILTER_LABEL[f]}</option>)}</select>
        </label>
        <button type="submit" className="inline-flex min-h-11 items-center rounded-lg bg-navy-900 px-4 text-sm font-semibold text-white hover:bg-navy-800">Apply</button>
      </form>
      <Card title={`${rows.length} client${rows.length === 1 ? "" : "s"}`}>
        {rows.length === 0 ? (
          <EmptyState title="Nothing here">No {year} summaries{filter !== "ALL" ? " match this filter" : " yet"}.</EmptyState>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[720px] text-sm" data-testid="tracker-table">
              <thead>
                <tr className="border-b border-ivory-200 text-left text-xs uppercase tracking-wide text-slate-600">
                  <th className="py-2 pr-3">Client</th><th className="py-2 pr-3">Tax Year</th><th className="py-2 pr-3">Summary status</th><th className="py-2 pr-3">8879 status</th><th className="py-2 pr-3">Signed on</th><th className="py-2 pr-3">Last change</th><th className="py-2">Links</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.clientId} className="border-b border-ivory-200 align-top" data-testid="tracker-row" data-action={r.needsAction ? "true" : "false"}>
                    <td className="py-2.5 pr-3">
                      <Link className="font-semibold text-navy-900 underline" href={r.clientHref} data-testid="tracker-client">{r.clientName}</Link>
                      {r.needsAction && <span className="ml-2 align-middle"><Badge tone="gold">Needs you</Badge></span>}
                    </td>
                    <td className="py-2.5 pr-3">{r.taxYear}</td>
                    <td className="py-2.5 pr-3"><Badge tone={SUMMARY_TONE[r.summary.code]}>{r.summary.label}</Badge>{r.summary.reason && <span className="mt-1 block text-xs text-slate-600">{r.summary.reason}</span>}</td>
                    <td className="py-2.5 pr-3" data-testid="tracker-8879">
                      {r.statusHref ? (
                        <a className="underline" href={r.statusHref} {...(r.statusHref.startsWith("/api/documents/") ? { target: "_blank", rel: "noopener" } : {})} data-testid="tracker-8879-link"><Badge tone={F_TONE[r.form8879.code]}>{r.form8879.label}</Badge></a>
                      ) : (
                        <Badge tone={F_TONE[r.form8879.code]}>{r.form8879.label}</Badge>
                      )}
                      {r.noAccess && <span className="mt-1 block text-xs text-slate-600" data-testid="tracker-no-access">No access</span>}
                    </td>
                    <td className="py-2.5 pr-3">{r.signedOn ? signedDate(r.signedOn) : "—"}</td>
                    <td className="py-2.5 pr-3 text-slate-600">{fmtDateTime(r.lastChange)}</td>
                    <td className="py-2.5"><Link className="underline" href={r.clientHref}>Taxes tab</Link> · <Link className="text-xs underline" href={r.recordsHref} data-testid="tracker-records">Records</Link></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </>
  );
}
