import Link from "next/link";
import { notFound } from "next/navigation";
import { AlertTriangle, ArrowLeft, CheckCircle2, FileText, History, Lock } from "lucide-react";
import { ActionForm } from "@/components/action-form";
import { AdpNav, StatementStatus } from "@/components/owner/adp-nav";
import { LineFields, ReasonField, StatementHeaderFields } from "@/components/owner/adp-forms";
import { AdpCsvImport } from "@/components/owner/adp-csv-import";
import { WindowPrintButton } from "@/components/window-print-button";
import { Button, Card, Field, Notice, PageHeader } from "@/components/ui";
import { addLineAction, archiveStatementAction, attachStatementFileAction, finalizeStatementAction, removeLineAction, updateLineAction, updateStatementAction } from "@/app/actions/adp-revenue-share";
import { requireOwnerPage } from "@/lib/auth/owner";
import { adpClientChoices, getStatement, referralChoices, referralName } from "@/lib/services/adp-revenue-share";
import { LINE_TYPE_LABELS, STATEMENT_FILE_TYPES, fmtCents, fmtDay, totalWarning, ymdOf, type LineType } from "@/lib/adp-revenue-share";
import { todayYmd } from "@/lib/services/owner-billing";
import { fmtDateTime } from "@/lib/format";

export const metadata = { title: "ADP statement" };

const KIND_LABELS: Record<string, string> = {
  FINALIZED: "Marked Final",
  HEADER_EDITED: "Statement details changed",
  LINE_ADDED: "Line added",
  LINE_EDITED: "Line changed",
  LINE_REMOVED: "Line removed",
  LINES_IMPORTED: "Lines imported from CSV",
  FILE_ATTACHED: "Statement file attached",
  ARCHIVED: "Statement deleted",
};

const show = (v: unknown) => {
  if (v === null || v === undefined) return "";
  const o = v as Record<string, unknown>;
  return Object.entries(o)
    .filter(([k]) => !["id", "lines"].includes(k))
    .map(([k, x]) => `${k}: ${k.endsWith("Cents") && typeof x === "number" ? fmtCents(x) : x === null ? "—" : String(x)}`)
    .join(" · ");
};

export default async function AdpStatementPage({ params }: { params: Promise<{ id: string }> }) {
  const actor = await requireOwnerPage();
  const { id } = await params;
  const [s, referrals, clients] = await Promise.all([getStatement(actor, id), referralChoices(actor), adpClientChoices(actor)]);
  if (!s) notFound();
  const final = s.status === "FINAL";
  const archived = !!s.archivedAt;
  const editable = !archived;
  const active = s.lines.filter((l) => !l.archivedAt);
  const removed = s.lines.filter((l) => l.archivedAt);
  const warning = totalWarning(s.check);
  const lineWho = (l: (typeof s.lines)[number]) => (l.referral ? referralName(l.referral) : l.client ? l.client.businessName || l.client.displayName : l.adpName ? `${l.adpName} (not linked)` : "Not linked");
  const reasonHint = "Required because this statement is Final. Kept in the statement's history.";

  return (
    <>
      <Link href="/owner/adp-revenue-share/statements" className="mb-3 inline-flex items-center gap-2 text-sm font-semibold text-navy-900 underline decoration-gold-500 underline-offset-4 print:hidden"><ArrowLeft className="size-4" aria-hidden /> Statements</Link>
      <PageHeader
        title={s.periodLabel}
        subtitle={`ADP Revenue Share statement · period ${fmtDay(s.periodStart)} – ${fmtDay(s.periodEnd)} · statement date ${fmtDay(s.statementDate)}`}
        actions={
          <span className="flex flex-wrap items-center gap-2">
            <StatementStatus status={s.status} />
            <a className="text-sm underline print:hidden" href={`/api/owner/adp-revenue-share/export?type=statement&id=${s.id}`}>Export lines (CSV)</a>
            <WindowPrintButton />
          </span>
        }
      />
      <AdpNav current="statements" />

      {archived && <div className="mb-4"><Notice tone="warn" title="Deleted">Deleted on {fmtDateTime(s.archivedAt)} by {s.names[s.archivedById ?? ""] ?? "the owner"}: {s.archivedReason}. It no longer counts in reports.</Notice></div>}
      {final && !archived && (
        <div className="mb-4 flex items-start gap-2 rounded-xl bg-navy-900 px-4 py-3 text-sm text-white" data-testid="final-lock">
          <Lock className="mt-0.5 size-4 shrink-0 text-gold-500" aria-hidden />
          <span>Final since {fmtDateTime(s.finalizedAt)} ({s.names[s.finalizedById ?? ""] ?? "owner"}). Every change now needs a revision note and is kept in the history below.</span>
        </div>
      )}

      <div className={warning ? "mb-4 rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-amber-900" : "mb-4 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-emerald-900"} data-testid={warning ? "total-warning" : "total-ok"} role={warning ? "alert" : "status"}>
        <p className="flex items-center gap-2 font-semibold">{warning ? <AlertTriangle className="size-5" aria-hidden /> : <CheckCircle2 className="size-5" aria-hidden />} Statement total {fmtCents(s.check.reportedCents)} · lines {fmtCents(s.check.linesCents)}{warning ? ` · difference ${fmtCents(s.check.differenceCents)}` : " · balanced"}</p>
        {warning && <p className="mt-1 text-sm">{warning}</p>}
      </div>

      <Card title={`Lines (${active.length})`} actions={s.fileName ? <a className="inline-flex items-center gap-1 text-sm underline print:hidden" href={`/api/owner/adp-revenue-share/statements/${s.id}/file`}><FileText className="size-4" aria-hidden /> {s.fileName}</a> : undefined}>
        {active.length === 0 ? (
          <p className="text-sm text-slate-600">No lines yet. Add them below, or import them from a CSV.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm" data-testid="statement-lines">
              <thead className="border-b border-ivory-200 text-xs uppercase tracking-wide text-slate-600">
                <tr><th className="py-2 pr-3">Referral / client</th><th className="py-2 pr-3">Type</th><th className="py-2 pr-3 text-right">Amount</th><th className="py-2 pr-3">Note</th><th className="py-2 print:hidden"><span className="sr-only">Actions</span></th></tr>
              </thead>
              <tbody className="divide-y divide-ivory-200">
                {active.map((l) => (
                  <tr key={l.id} className="align-top">
                    <td className="py-2 pr-3">
                      <span className="font-semibold text-navy-900">{lineWho(l)}</span>
                      {l.adpName && (l.referral || l.client) && <span className="block text-xs text-slate-600">On ADP&apos;s statement: {l.adpName}</span>}
                    </td>
                    <td className="py-2 pr-3">{LINE_TYPE_LABELS[l.type as LineType] ?? l.type}</td>
                    <td className="py-2 pr-3 text-right font-semibold tabular-nums">{fmtCents(l.amountCents)}</td>
                    <td className="py-2 pr-3 text-slate-700">{l.note}</td>
                    <td className="py-2 print:hidden">
                      {editable && (
                        <details className="min-w-56">
                          <summary className="cursor-pointer text-sm font-semibold text-navy-900 underline decoration-gold-500 underline-offset-4">Edit / remove</summary>
                          <div className="mt-2 space-y-3 rounded-xl border border-ivory-200 bg-ivory-50 p-3">
                            <ActionForm action={updateLineAction.bind(null, s.id, l.id)} className="grid gap-3">
                              <LineFields referrals={referrals} clients={clients} idPrefix={`line-${l.id}`} l={l} />
                              {final && <ReasonField label="Revision note (required)" hint={reasonHint} />}
                              <Button type="submit" variant="secondary">Save line</Button>
                            </ActionForm>
                            <ActionForm action={removeLineAction.bind(null, s.id, l.id)} className="grid gap-2" confirm="Remove this line? It's kept, marked removed, and no longer counts.">
                              <ReasonField label="Reason for removing (required)" />
                              <Button type="submit" variant="danger">Remove line</Button>
                            </ActionForm>
                          </div>
                        </details>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot className="border-t-2 border-navy-900">
                <tr><td className="py-2 pr-3 font-semibold" colSpan={2}>Sum of lines</td><td className="py-2 pr-3 text-right font-bold tabular-nums">{fmtCents(s.check.linesCents)}</td><td colSpan={2} /></tr>
              </tfoot>
            </table>
          </div>
        )}
        {removed.length > 0 && (
          <details className="mt-3 text-sm">
            <summary className="cursor-pointer text-slate-700">Removed lines ({removed.length})</summary>
            <ul className="mt-2 divide-y divide-ivory-200">
              {removed.map((l) => (
                <li key={l.id} className="py-1 text-slate-600"><s>{lineWho(l)} · {LINE_TYPE_LABELS[l.type as LineType] ?? l.type} · {fmtCents(l.amountCents)}</s> — removed {fmtDateTime(l.archivedAt)}: {l.archivedReason}</li>
              ))}
            </ul>
          </details>
        )}
      </Card>

      {editable && (
        <div className="mt-5 grid items-start gap-4 lg:grid-cols-2 print:hidden">
          <Card title="Add a line">
            <ActionForm action={addLineAction.bind(null, s.id)} className="grid gap-3" resetOnSuccess idempotent>
              <LineFields referrals={referrals} clients={clients} idPrefix="new-line" />
              {final && <ReasonField label="Revision note (required)" hint={reasonHint} />}
              <Button type="submit">Add line</Button>
            </ActionForm>
          </Card>
          <Card title="Import lines from a CSV">
            <p className="mb-3 text-sm text-slate-600">ADP doesn&apos;t publish a fixed layout, so you choose every column and confirm each row before anything is saved.</p>
            <AdpCsvImport statementId={s.id} referrals={referrals} final={final} />
          </Card>
        </div>
      )}

      {editable && (
        <div className="mt-5 grid items-start gap-4 lg:grid-cols-2 print:hidden">
          {!final ? (
            <Card title="Mark Final">
              <ActionForm action={finalizeStatementAction.bind(null, s.id)} className="grid gap-3" confirm="Mark this statement Final? After this, every change needs a revision note.">
                <p className="text-sm text-slate-600">When the lines match ADP&apos;s statement, mark it Final. You can still correct it later, with a revision note kept in its history.</p>
                {!s.check.matches && (
                  <label className="inline-flex items-start gap-2 text-sm text-amber-900"><input type="checkbox" name="acknowledgeMismatch" className="mt-0.5 size-4 accent-navy-900" /> The total doesn&apos;t match the lines. Mark it Final anyway.</label>
                )}
                <Field label="Note (optional)"><input className="input" name="note" maxLength={2000} /></Field>
                <Button type="submit" data-testid="finalize">Mark Final</Button>
              </ActionForm>
            </Card>
          ) : (
            <Card title="Statement file">
              {s.fileName ? <p className="text-sm">On file: <a className="underline" href={`/api/owner/adp-revenue-share/statements/${s.id}/file`}>{s.fileName}</a> (uploaded {fmtDateTime(s.fileUploadedAt)})</p> : <p className="text-sm text-slate-600">No file uploaded.</p>}
              <ActionForm action={attachStatementFileAction.bind(null, s.id)} className="mt-3 grid gap-3" resetOnSuccess>
                <Field label={`Upload / replace (${STATEMENT_FILE_TYPES})`}><input className="input" type="file" name="file" required accept="application/pdf,.pdf,.csv,text/csv,.xlsx" /></Field>
                <ReasonField label="Revision note (required)" hint={reasonHint} />
                <Button type="submit" variant="secondary">Save file</Button>
              </ActionForm>
            </Card>
          )}
          <Card title="Statement details">
            <ActionForm action={updateStatementAction.bind(null, s.id)} className="grid gap-3">
              <StatementHeaderFields today={todayYmd()} s={{ periodLabel: s.periodLabel, periodStart: ymdOf(s.periodStart), periodEnd: ymdOf(s.periodEnd), statementDate: ymdOf(s.statementDate), reportedTotalCents: s.reportedTotalCents, notes: s.notes }} />
              {final && <ReasonField label="Revision note (required)" hint={reasonHint} />}
              <Button type="submit" variant="secondary">Save details</Button>
            </ActionForm>
            {!final && (
              <ActionForm action={attachStatementFileAction.bind(null, s.id)} className="mt-4 grid gap-3 border-t border-ivory-200 pt-4" resetOnSuccess>
                <Field label={`Statement file (${STATEMENT_FILE_TYPES})`} hint={s.fileName ? `On file: ${s.fileName}. Uploading replaces it.` : "Kept in your private owner-only store."}><input className="input" type="file" name="file" required accept="application/pdf,.pdf,.csv,text/csv,.xlsx" /></Field>
                <Button type="submit" variant="secondary">Upload file</Button>
              </ActionForm>
            )}
          </Card>
        </div>
      )}

      <div className="mt-5 grid items-start gap-4 lg:grid-cols-2">
        <Card title="Payments matched to this statement">
          {s.payments.length === 0 ? (
            <p className="text-sm text-slate-600">No payment is matched yet. Match one from the payment&apos;s page (Payments tab).</p>
          ) : (
            <ul className="divide-y divide-ivory-200 text-sm">
              {s.payments.map((p) => (
                <li key={p.id} className="flex justify-between py-2"><Link className="underline" href={`/owner/adp-revenue-share/payments/${p.id}`}>{fmtDay(p.receivedOn)}{p.reference ? ` · ${p.reference}` : ""}</Link><strong className="tabular-nums">{fmtCents(p.amountCents)}</strong></li>
              ))}
            </ul>
          )}
          {s.matchEvents.length > 0 && (
            <details className="mt-3 text-sm">
              <summary className="cursor-pointer text-slate-700">Match history ({s.matchEvents.length})</summary>
              <ul className="mt-2 space-y-1">
                {s.matchEvents.map((e) => <li key={e.id} className="text-slate-700">{fmtDateTime(e.at)} · {e.action === "MATCHED" ? "Matched" : "Unmatched"} payment of {fmtCents(e.payment.amountCents)} ({fmtDay(e.payment.receivedOn)}) · {e.actorName}{e.note ? ` · ${e.note}` : ""}</li>)}
              </ul>
            </details>
          )}
        </Card>
        <Card title={<span className="flex items-center gap-2"><History className="size-5 text-gold-600" aria-hidden /> Revision history</span>}>
          {s.revisions.length === 0 ? (
            <p className="text-sm text-slate-600">{final ? "No revisions." : "Draft: edits aren't kept as revisions until the statement is marked Final (they are in your audit log)."}</p>
          ) : (
            <ol className="space-y-2 text-sm" data-testid="revision-history">
              {s.revisions.map((r) => (
                <li key={r.id} className="rounded-lg bg-ivory-50 px-3 py-2">
                  <p className="font-semibold text-navy-900">#{r.revisionNumber} · {KIND_LABELS[r.kind] ?? r.kind}</p>
                  {r.reason && <p className="text-slate-800">“{r.reason}”</p>}
                  {r.kind !== "FINALIZED" && (r.previous || r.updated) ? (
                    <p className="text-xs text-slate-600">{r.previous ? `Before: ${show(r.previous)}` : ""}{r.previous && r.updated ? " → " : ""}{r.updated ? `After: ${show(r.updated)}` : ""}</p>
                  ) : null}
                  <p className="text-xs text-slate-600">{fmtDateTime(r.editedAt)} · {r.editedByName}</p>
                </li>
              ))}
            </ol>
          )}
        </Card>
      </div>

      {editable && (
        <Card className="mt-5 print:hidden" title="Delete statement">
          <ActionForm action={archiveStatementAction.bind(null, s.id)} className="grid gap-3 sm:grid-cols-[1fr_auto] sm:items-end" confirm="Delete this statement? It's kept in your private history with your reason and no longer counts.">
            <ReasonField hint="Kept with the record. Unmatch any payment first." />
            <Button type="submit" variant="danger">Delete statement</Button>
          </ActionForm>
        </Card>
      )}
    </>
  );
}
