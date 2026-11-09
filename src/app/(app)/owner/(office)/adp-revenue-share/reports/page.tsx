import clsx from "clsx";
import { Info } from "lucide-react";
import { ActionForm } from "@/components/action-form";
import { AdpNav } from "@/components/owner/adp-nav";
import { WindowPrintButton } from "@/components/window-print-button";
import { Button, Card, Notice, PageHeader } from "@/components/ui";
import { saveFiscalNoteAction } from "@/app/actions/adp-revenue-share";
import { requireOwnerPage } from "@/lib/auth/owner";
import { adpReport, fiscalNote } from "@/lib/services/adp-revenue-share";
import { fmtCents, reportParams, type Row } from "@/lib/adp-revenue-share";
import { todayYmd } from "@/lib/services/owner-billing";
import { fmtDateTime } from "@/lib/format";

export const metadata = { title: "ADP Revenue Share reports" };

const MONTHS = Array.from({ length: 12 }, (_, i) => new Date(Date.UTC(2000, i, 1)).toLocaleString("en-US", { month: "long", timeZone: "UTC" }));

function Table({ rows, total, first, testId }: { rows: Row[]; total?: Row; first: string; testId: string }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-sm" data-testid={testId}>
        <thead className="border-b border-ivory-200 text-xs uppercase tracking-wide text-slate-600">
          <tr><th className="py-2 pr-3">{first}</th><th className="py-2 pr-3 text-right">Earned</th><th className="py-2 pr-3 text-right">Received</th><th className="py-2 text-right">Outstanding</th></tr>
        </thead>
        <tbody className="divide-y divide-ivory-200">
          {rows.length === 0 && <tr><td colSpan={4} className="py-3 text-slate-600">Nothing in this period.</td></tr>}
          {rows.map((r) => (
            <tr key={r.key} className={clsx(r.key.startsWith("__") && "text-slate-600")}>
              <td className="py-1.5 pr-3">{r.label}</td>
              <td className="py-1.5 pr-3 text-right tabular-nums">{fmtCents(r.earnedCents)}</td>
              <td className="py-1.5 pr-3 text-right tabular-nums">{fmtCents(r.receivedCents)}</td>
              <td className={clsx("py-1.5 text-right font-semibold tabular-nums", r.outstandingCents < 0 && "text-emerald-800")}>{fmtCents(r.outstandingCents)}</td>
            </tr>
          ))}
        </tbody>
        {total && (
          <tfoot className="border-t-2 border-navy-900 font-bold">
            <tr><td className="py-2 pr-3">{total.label}</td><td className="py-2 pr-3 text-right tabular-nums">{fmtCents(total.earnedCents)}</td><td className="py-2 pr-3 text-right tabular-nums">{fmtCents(total.receivedCents)}</td><td className="py-2 text-right tabular-nums">{fmtCents(total.outstandingCents)}</td></tr>
          </tfoot>
        )}
      </table>
    </div>
  );
}

export default async function AdpReportsPage({ searchParams }: { searchParams: Promise<{ year?: string; month?: string; basis?: string }> }) {
  const actor = await requireOwnerPage();
  const today = todayYmd();
  const p = reportParams(await searchParams, today);
  const [r, note] = await Promise.all([adpReport(actor, p), fiscalNote(actor)]);
  const period = p.month ? `${MONTHS[p.month - 1]} ${p.year}` : String(p.year);
  const qs = `year=${p.year}${p.month ? `&month=${p.month}` : ""}&basis=${p.basis}`;
  return (
    <>
      <PageHeader
        title="ADP Revenue Share"
        subtitle={`Earned (statement lines) vs received (payments from ADP). Outstanding = earned − received.`}
        actions={
          <span className="flex flex-wrap items-center gap-2 print:hidden">
            <a className="inline-flex min-h-10 items-center rounded-lg border border-navy-700 bg-white px-4 py-2 text-sm font-semibold text-navy-900 hover:bg-navy-50" href={`/api/owner/adp-revenue-share/export?type=report&${qs}`}>Export CSV</a>
            <WindowPrintButton label="Print / save as PDF" />
          </span>
        }
      />
      <AdpNav current="reports" />

      <form method="get" className="mb-5 flex flex-wrap items-end gap-2 text-sm print:hidden" data-testid="report-filter">
        <label className="block"><span className="mb-1 block font-semibold text-navy-900">Year</span><input className="input w-24" name="year" defaultValue={p.year} inputMode="numeric" /></label>
        <label className="block"><span className="mb-1 block font-semibold text-navy-900">Month (by client / product)</span>
          <select className="input w-44" name="month" defaultValue={p.month ?? ""}>
            <option value="">Whole year</option>
            {MONTHS.map((m, i) => <option key={m} value={i + 1}>{m}</option>)}
          </select>
        </label>
        <label className="block"><span className="mb-1 block font-semibold text-navy-900">Date earnings by</span>
          <select className="input w-48" name="basis" defaultValue={p.basis}>
            <option value="statementDate">Statement date</option>
            <option value="periodEnd">Statement period end</option>
          </select>
        </label>
        <Button type="submit" variant="secondary">Show</Button>
      </form>

      <div className="mb-5 hidden print:block">
        <p className="font-serif text-xl font-bold text-navy-900">ADP Revenue Share — {period}</p>
        <p className="text-sm text-slate-700">T. Turner &amp; Associates · owner&apos;s private report · printed {fmtDateTime(new Date())} · earnings dated by {p.basis === "periodEnd" ? "statement period end" : "statement date"}</p>
      </div>

      <div className="mb-5 flex gap-2 rounded-xl bg-navy-50 px-4 py-3 text-sm text-navy-900 ring-1 ring-navy-100" data-testid="fiscal-note">
        <Info className="mt-0.5 size-4 shrink-0 text-gold-600" aria-hidden />
        <p className="whitespace-pre-line">{note.text}</p>
      </div>
      {r.draftStatements > 0 && <div className="mb-5"><Notice tone="warn">Includes {r.draftStatements} draft statement{r.draftStatements === 1 ? "" : "s"} not yet marked Final.</Notice></div>}

      <div className="grid gap-4 lg:grid-cols-2">
        <Card title={`Monthly — ${p.year}`}>
          <Table rows={r.months} total={{ ...r.yearTotal, label: `${p.year} total` }} first="Month" testId="report-months" />
        </Card>
        <Card title="Annual">
          <Table rows={r.years} total={{ ...r.allTime, label: "All years" }} first="Year" testId="report-years" />
        </Card>
        <Card title={`By client — ${period}`}>
          <Table rows={r.byClient} total={{ ...r.total, label: `${period} total` }} first="Client / referral" testId="report-clients" />
        </Card>
        <Card title={`By ADP product — ${period}`}>
          <Table rows={r.byProduct} total={{ ...r.total, label: `${period} total` }} first="Product" testId="report-products" />
        </Card>
      </div>
      <p className="mt-3 text-xs text-slate-600">Received by client and product: each payment is split across the lines of the statement you matched it to, in proportion to each line. Payments not yet matched to a statement show on their own row.</p>

      <Card className="mt-5 print:hidden" title="ADP fiscal-quarter note">
        <ActionForm action={saveFiscalNoteAction} className="grid gap-3" >
          <label id="fiscal-note" className="block">
            <span className="mb-1 block text-sm font-semibold text-navy-900">Shown on Overview and Reports</span>
            <textarea className="input" name="fiscalNote" rows={4} defaultValue={note.text} maxLength={4000} required />
            <span className="mt-1 block text-xs text-slate-600">{note.isDefault ? "Default wording — edit it to match your ADP agreement." : `Last saved ${fmtDateTime(note.updatedAt)}.`}</span>
          </label>
          <div><Button type="submit" variant="secondary">Save note</Button></div>
        </ActionForm>
      </Card>
    </>
  );
}
