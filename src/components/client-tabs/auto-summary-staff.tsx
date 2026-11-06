import Link from "next/link";
import { ActionForm } from "@/components/action-form";
import { Badge, Button, Card, Notice } from "@/components/ui";
import { AutoTaxSummaryView } from "@/components/portal/auto-tax-summary-view";
import { mark8879SentAction, sendAutoSummaryAction, upload8879Action, uploadAutoSummaryAction } from "@/app/actions/auto-tax-summary";
import type { Actor } from "@/lib/auth/actor";
import { isReportApprover } from "@/lib/services/bookkeeping-clients";
import { autoSummaryPanel, F8879_LABEL, form8879Progress, type F8879Status } from "@/lib/services/auto-tax-summary";
import { money } from "@/lib/tax/return-parser/summary";
import { fmtDateTime } from "@/lib/format";

const TONE: Record<F8879Status, "gray" | "gold" | "green" | "red"> = { NONE: "gray", WAITING: "gold", SENT: "gold", SIGNED: "green", NEEDS_RESIGN: "red", MISMATCH: "red" };
const STATUS: Record<string, { label: string; tone: "gray" | "gold" | "green" | "red" }> = {
  DRAFT: { label: "Ready — waiting for Tabitha's “Send for approval”", tone: "gold" },
  SENT: { label: "Sent — waiting for the client", tone: "gold" },
  CHANGES_REQUESTED: { label: "Client has a question — on hold", tone: "red" },
  CLIENT_APPROVED: { label: "Client approved", tone: "green" },
};

/**
 * Staff entry point for the Automatic Client Tax Summary: upload the TaxAct
 * PDF, see what was held and why, Tabitha's one-click send, and the 8879 task.
 * (To be placed in the Taxes tab's Step 2 once PR #122 merges.)
 */
export async function AutoSummaryStaff({ clientId, user }: { clientId: string; user: Actor }) {
  const [panel, owner] = await Promise.all([autoSummaryPanel(clientId), isReportApprover(user)]);
  const thisYear = new Date().getFullYear();
  const years = [thisYear - 1, thisYear, thisYear - 2, thisYear - 3];
  return (
    <Card title="Automatic tax summary (read from the TaxAct return)">
      <div className="space-y-4" data-testid="auto-summary-staff">
        <p className="text-sm text-slate-700">
          Upload the prepared return printed to PDF from TaxAct. The figures are read from the forms by line — nothing is typed and no AI is used — and checked. If anything can&apos;t be read or doesn&apos;t add up, nothing is sent and the reasons are listed here.
        </p>
        <p className="flex flex-wrap items-center gap-2 text-sm" data-testid="auto-send-state" data-on={panel.switchOn ? "true" : "false"}>
          <span className="font-semibold text-navy-900">Send tax summaries automatically:</span>
          <Badge tone={panel.switchOn ? "green" : "gray"}>{panel.switchOn ? "On" : "Off"}</Badge>
          <span className="text-slate-600">{panel.switchOn ? "Summaries Tabitha uploads go out by themselves when every check passes and the client has a portal login. Staff uploads still wait for her." : "Every summary waits for Tabitha's “Send for approval”."}</span>
          {owner && <Link className="underline" href="/owner/automation">Change</Link>}
        </p>
        <ActionForm action={uploadAutoSummaryAction.bind(null, clientId)} className="grid gap-3 rounded-xl border border-navy-100 bg-navy-50/40 p-4 sm:grid-cols-[auto_1fr_auto] sm:items-end">
          <label className="block text-sm font-semibold text-navy-900">Tax year
            <select name="taxYear" className="input mt-1 min-h-11" defaultValue={thisYear - 1}>
              {years.filter((y, i, a) => a.indexOf(y) === i).sort((a, b) => b - a).map((y) => <option key={y} value={y}>{y}</option>)}
            </select>
          </label>
          <label className="block text-sm font-semibold text-navy-900">Prepared return PDF (or the signed Form 8879)
            <input type="file" name="file" accept="application/pdf" required className="input mt-1 min-h-11" />
          </label>
          <Button type="submit" className="min-h-11">Read the return</Button>
        </ActionForm>

        {panel.years.length === 0 && <p className="text-sm text-slate-600">No automatic summary yet.</p>}
        {panel.years.map((y) => {
          const s = y.summary;
          const f = y.form8879;
          const heldNewer = y.held && (!s || y.held.at > s.updatedAt);
          return (
            <section key={y.year} id={`auto-summary-${y.year}`} className="scroll-mt-24 space-y-3 rounded-xl border border-ivory-200 p-4" data-testid={`auto-summary-${y.year}`}>
              <h3 className="font-serif text-lg font-bold text-navy-900">Tax Year {y.year}</h3>
              {heldNewer && (
                <div data-testid="auto-held">
                  <Notice tone="error" title={`Held — not sent (${fmtDateTime(y.held!.at)})`}>
                    <p>These couldn&apos;t be confirmed from the uploaded return:</p>
                    <ul className="mt-1 list-disc space-y-1 pl-5">{y.held!.issues.map((i) => <li key={i.code + i.message}>{i.message}</li>)}</ul>
                    <p className="mt-2">Fix it in TaxAct (or the client record), print the return to PDF again and upload it.</p>
                  </Notice>
                </div>
              )}
              {y.manualSummary && !s && <p className="text-sm text-slate-600">A summary entered by hand exists for {y.year}; it&apos;s in the Tax Return Summary card.</p>}
              {s && y.model && (
                <>
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge tone={STATUS[s.status]?.tone ?? "gray"}>{STATUS[s.status]?.label ?? s.status}</Badge>
                    <span className="text-sm text-slate-600">Version {s.version} · {fmtDateTime(s.updatedAt)}</span>
                  </div>
                  <dl className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-4" data-testid="auto-answer">
                    <div><dt className="text-slate-600">{y.model.answer.federal.label}</dt><dd className="font-semibold">{money(y.model.answer.federal.cents)}</dd></div>
                    {y.model.answer.state && <div><dt className="text-slate-600">{y.model.answer.state.label}</dt><dd className="font-semibold">{money(y.model.answer.state.cents)}</dd></div>}
                    <div><dt className="text-slate-600">Filing status</dt><dd className="font-semibold">{y.model.statusLabel}</dd></div>
                    <div><dt className="text-slate-600">Checks</dt><dd className="font-semibold text-emerald-800">All passed</dd></div>
                  </dl>
                  {s.status === "DRAFT" && (
                    <div className="space-y-2 rounded-lg bg-gold-50 p-3" data-testid="auto-ready">
                      <p className="text-sm text-navy-900">Every check passed. {y.waiting}</p>
                      {owner ? (
                        <ActionForm action={sendAutoSummaryAction.bind(null, s.id)} confirm="Send this summary to the client's portal for approval? They get a sign-in notice by email (no figures).">
                          <Button type="submit" className="min-h-11" data-testid="send-for-approval">Send for approval</Button>
                        </ActionForm>
                      ) : (
                        <p className="text-sm text-slate-600">Only Tabitha can send it for approval.</p>
                      )}
                    </div>
                  )}
                  <details className="rounded-lg border border-navy-100 p-3">
                    <summary className="cursor-pointer text-sm font-semibold text-navy-900">Preview what the client sees</summary>
                    <div className="mt-3 rounded-xl bg-ivory-100 p-3"><AutoTaxSummaryView s={{ ...s, items: s.items }} clientId={clientId} readOnly /></div>
                  </details>
                </>
              )}
              {s && f && f.status !== "NONE" && (
                <div className="space-y-2 rounded-lg border border-navy-100 p-3" data-testid="f8879-task" data-status={f.status}>
                  <p className="flex flex-wrap items-center gap-2 text-sm">
                    <span className="font-semibold text-navy-900">Form 8879:</span>
                    <Badge tone={TONE[f.status]}>{F8879_LABEL[f.status]}</Badge>
                  </p>
                  {(f.status === "WAITING" || f.status === "NEEDS_RESIGN") && s.status === "CLIENT_APPROVED" && (
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-sm text-navy-900">Task: <strong>Send the 8879 from TaxAct</strong>{f.status === "NEEDS_RESIGN" ? " again — the summary changed after it was signed" : ""}.</span>
                      <ActionForm action={mark8879SentAction.bind(null, s.id)}><Button type="submit" variant="secondary" className="min-h-11" data-testid="mark-8879-sent">Mark 8879 sent</Button></ActionForm>
                    </div>
                  )}
                  {f.status === "NEEDS_RESIGN" && s.status !== "CLIENT_APPROVED" && <p className="text-sm text-red-900">Needs re-signing: the summary was revised after the 8879 was signed. Send the new 8879 once the client approves the updated summary.</p>}
                  {f.status === "SIGNED" && f.signedAt && <p className="text-sm font-semibold text-emerald-800" data-testid="f8879-progress">{form8879Progress(y.year, f.signedAt)}</p>}
                  {f.flags.length > 0 && (
                    <Notice tone="warn" title="Flagged for Tabitha">
                      <ul className="list-disc pl-5">{f.flags.map((x) => <li key={x}>{x}</li>)}</ul>
                    </Notice>
                  )}
                  {f.status !== "SIGNED" && (
                    <ActionForm action={upload8879Action.bind(null, clientId, y.year)} className="flex flex-wrap items-end gap-2">
                      <label className="block text-sm font-semibold text-navy-900">Signed 8879 PDF
                        <input type="file" name="file" accept="application/pdf" required className="input mt-1 min-h-11" />
                      </label>
                      {owner && <label className="flex min-h-11 items-center gap-2 text-sm"><input type="checkbox" name="manual" className="size-5 accent-navy-900" /> This is the signed 8879</label>}
                      <Button type="submit" variant="secondary" className="min-h-11">Upload signed 8879</Button>
                    </ActionForm>
                  )}
                  {y.history.length > 0 && (
                    <details className="text-xs text-slate-600">
                      <summary className="cursor-pointer">8879 history ({y.history.length})</summary>
                      <ul className="mt-1 space-y-0.5">{y.history.map((h, i) => <li key={i}>{fmtDateTime(new Date(h.at))} · {h.event.replace(/_/g, " ").toLowerCase()}{h.note ? ` — ${h.note}` : ""}</li>)}</ul>
                    </details>
                  )}
                </div>
              )}
            </section>
          );
        })}
      </div>
    </Card>
  );
}
