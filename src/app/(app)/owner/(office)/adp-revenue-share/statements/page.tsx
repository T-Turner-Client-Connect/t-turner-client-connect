import Link from "next/link";
import { AlertTriangle, Paperclip } from "lucide-react";
import { ActionForm } from "@/components/action-form";
import { AdpNav, StatementStatus } from "@/components/owner/adp-nav";
import { StatementHeaderFields } from "@/components/owner/adp-forms";
import { Button, Card, EmptyState, Field, PageHeader } from "@/components/ui";
import { createStatementAction } from "@/app/actions/adp-revenue-share";
import { requireOwnerPage } from "@/lib/auth/owner";
import { listStatements } from "@/lib/services/adp-revenue-share";
import { STATEMENT_FILE_TYPES, fmtCents, fmtDay } from "@/lib/adp-revenue-share";
import { todayYmd } from "@/lib/services/owner-billing";

export const metadata = { title: "ADP statements" };

export default async function AdpStatementsPage({ searchParams }: { searchParams: Promise<{ archived?: string }> }) {
  const actor = await requireOwnerPage();
  const archived = (await searchParams).archived === "1";
  const rows = await listStatements(actor, { archived });
  return (
    <>
      <PageHeader title="ADP Revenue Share" subtitle="ADP's Revenue Share statements from the partner portal, with every line entered or imported by you." />
      <AdpNav current="statements" />
      <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
        <Card title="Add a statement">
          <ActionForm action={createStatementAction} className="grid gap-3" resetOnSuccess idempotent>
            <StatementHeaderFields today={todayYmd()} />
            <Field label={`ADP statement file (${STATEMENT_FILE_TYPES}, optional)`} hint="Kept in your private owner-only store, never in client documents. The same file can't be uploaded twice.">
              <input className="input" type="file" name="file" accept="application/pdf,.pdf,.csv,text/csv,.xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" />
            </Field>
            <Button type="submit">Save draft statement</Button>
          </ActionForm>
        </Card>
        <Card
          title={archived ? "Deleted statements" : `Statements (${rows.length})`}
          actions={
            <span className="flex gap-3 text-sm">
              <Link className="underline" href={archived ? "/owner/adp-revenue-share/statements" : "/owner/adp-revenue-share/statements?archived=1"}>{archived ? "Back to statements" : "Show deleted"}</Link>
              {!archived && <a className="underline" href="/api/owner/adp-revenue-share/export?type=statements">Export CSV</a>}
            </span>
          }
        >
          {rows.length === 0 ? (
            <EmptyState title={archived ? "No deleted statements" : "No statements yet"}>Download each Revenue Share statement from ADP&apos;s partner portal, then add it here with its lines.</EmptyState>
          ) : (
            <ul className="divide-y divide-ivory-200" data-testid="statement-list">
              {rows.map((s) => (
                <li key={s.id} className="py-3">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="min-w-0">
                      <Link href={`/owner/adp-revenue-share/statements/${s.id}`} className="font-semibold text-navy-900 underline decoration-gold-500 underline-offset-4">{s.periodLabel}</Link>
                      <p className="text-sm text-slate-600">
                        {fmtDay(s.periodStart)} – {fmtDay(s.periodEnd)} · statement {fmtDay(s.statementDate)} · {s.lineCount} line{s.lineCount === 1 ? "" : "s"}
                        {s.fileName && <span className="ml-1 inline-flex items-center gap-1"><Paperclip className="size-3" aria-hidden /> file</span>}
                      </p>
                      {archived && s.archivedReason && <p className="text-xs text-slate-600">Deleted: {s.archivedReason}</p>}
                    </div>
                    <div className="text-right">
                      <StatementStatus status={s.status} />
                      <p className="mt-1 font-semibold tabular-nums text-navy-900">{fmtCents(s.reportedTotalCents)}</p>
                    </div>
                  </div>
                  {!s.check.matches && (
                    <p className="mt-1 flex items-center gap-1 text-sm text-amber-900" data-testid="total-warning"><AlertTriangle className="size-4" aria-hidden /> Lines add up to {fmtCents(s.check.linesCents)} ({fmtCents(s.check.differenceCents)} difference)</p>
                  )}
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </>
  );
}
