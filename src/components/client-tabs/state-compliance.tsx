import clsx from "clsx";
import { ActionForm } from "@/components/action-form";
import { Button, Card, Field } from "@/components/ui";
import { fmtDate } from "@/lib/format";
import { CATEGORIES, clientCompliance, effectiveStatus, FREQUENCIES, STATES, STATUS_LABEL, WORKING_STATUSES } from "@/lib/services/state-compliance";
import { addRegistrationAction, addRequirementAction, completeFilingAction, flagFilingAction, markNotRequiredAction, setFilingStatusAction } from "@/app/actions/state-compliance";

const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const TONE: Record<string, string> = { OVERDUE: "bg-red-100 text-red-800", FILED: "bg-emerald-50 text-emerald-800", NOT_REQUIRED: "bg-slate-100 text-slate-700", READY_TO_FILE: "bg-gold-100 text-gold-800", WAITING_ON_CLIENT: "bg-amber-50 text-amber-800", IN_PROGRESS: "bg-navy-100 text-navy-900", NOT_STARTED: "bg-slate-100 text-slate-700" };
const daysUntil = (d: Date) => Math.round((d.getTime() - new Date(new Date().toLocaleDateString("en-CA", { timeZone: "America/Chicago" }) + "T00:00:00Z").getTime()) / 86_400_000);

/**
 * Client profile → State Compliance (internal to the office): where the business is registered, the
 * state filings it owes with each state's own due date, and every filing period. Nothing here is
 * shown or sent to the client.
 */
export async function StateComplianceTab({ clientId, isAdmin }: { clientId: string; isAdmin: boolean }) {
  const { registrations, requirements } = await clientCompliance(clientId);
  const thisYear = new Date().getUTCFullYear();
  return (
    <div className="space-y-4" data-testid="state-compliance">
      <p className="text-sm text-slate-600">Internal to the office. Reminders go to the office at 90, 60, 30, 15 and 7 days before each due date and on it; nothing is sent to the client. A filing is completed only with the date filed and its confirmation.</p>

      <Card title="State registrations">
        {registrations.length ? (
          <ul className="divide-y divide-ivory-200 text-sm">
            {registrations.map((r) => (
              <li key={r.id} className="py-2"><strong>{r.state}</strong> · {r.kind === "FOREIGN" ? "Registered as a foreign entity" : "State of formation"}{r.entityId ? ` · ID ${r.entityId}` : ""}{r.agency ? ` · ${r.agency}` : ""}{r.formedOn ? ` · formed ${fmtDate(r.formedOn)}` : ""}</li>
            ))}
          </ul>
        ) : <p className="text-sm text-slate-600">No state registration recorded yet.</p>}
        <details className="mt-3">
          <summary className="cursor-pointer text-sm font-semibold text-navy-900">Add a registration</summary>
          <ActionForm action={addRegistrationAction.bind(null, clientId)} className="mt-2 grid gap-2 sm:grid-cols-3" resetOnSuccess>
            <Field label="State"><select name="state" className="input" required defaultValue=""><option value="" disabled>Choose</option>{STATES.map((s) => <option key={s} value={s}>{s}</option>)}</select></Field>
            <Field label="Kind"><select name="kind" className="input"><option value="FORMATION">State of formation</option><option value="FOREIGN">Foreign registration</option></select></Field>
            <Field label="State ID (e.g. department ID)"><input name="entityId" className="input" maxLength={40} /></Field>
            <Field label="Agency"><input name="agency" className="input" maxLength={160} placeholder="e.g. Maryland Department of Assessments and Taxation (SDAT)" /></Field>
            <Field label="Formed on (optional)"><input name="formedOn" type="date" className="input" /></Field>
            <div className="flex items-end"><Button type="submit">Save registration</Button></div>
          </ActionForm>
        </details>
      </Card>

      <Card title="Recurring state filings">
        {requirements.length === 0 && <p className="text-sm text-slate-600">No recurring filings tracked yet.</p>}
        <ul className="space-y-4">
          {requirements.map((q) => (
            <li key={q.id} className="rounded-xl border border-ivory-200 p-3" data-testid="compliance-requirement">
              <p className="font-semibold text-navy-900">{q.state} · {q.name} <span className="font-normal text-slate-600">· {CATEGORIES[q.category as keyof typeof CATEGORIES] ?? q.category} · due {MONTH_NAMES[q.dueMonth - 1]} {q.dueDay}, {FREQUENCIES[q.frequency as keyof typeof FREQUENCIES]?.toLowerCase() ?? q.frequency}</span></p>
              <p className="text-xs text-slate-600">{q.agency ?? ""}{q.filingUrl ? <> · <a className="underline" href={q.filingUrl} target="_blank" rel="noreferrer">Filing website</a></> : null}</p>
              <ul className="mt-2 divide-y divide-ivory-200">
                {q.filings.map((f) => {
                  const st = effectiveStatus(f);
                  const open = st !== "FILED" && st !== "NOT_REQUIRED";
                  const d = daysUntil(f.dueDate);
                  return (
                    <li key={f.id} className={clsx("py-2 text-sm", f.urgent && open && "rounded-lg bg-red-50 px-2")} data-testid="compliance-filing" data-status={st}>
                      <div className="flex flex-wrap items-center gap-2">
                        <strong>{f.period}</strong>
                        {st === "OVERDUE" && <span className={clsx("rounded-full px-2.5 py-0.5 text-xs font-semibold", TONE.OVERDUE)}>Overdue</span>}
                        <span className={clsx("rounded-full px-2.5 py-0.5 text-xs font-semibold", TONE[f.status] ?? TONE.NOT_STARTED)}>{STATUS_LABEL[f.status as keyof typeof STATUS_LABEL] ?? f.status}</span>
                        {f.urgent && open && <span className="rounded-full bg-red-700 px-2.5 py-0.5 text-xs font-semibold text-white">URGENT</span>}
                        <span className="text-slate-700">Due {fmtDate(f.dueDate)}{open ? (d < 0 ? ` · ${-d} days past due` : d === 0 ? " · due today" : ` · in ${d} days`) : ""}</span>
                        {f.finalDeadline && open && <span className="font-semibold text-red-800">Final deadline {fmtDate(f.finalDeadline)} ({daysUntil(f.finalDeadline)} days)</span>}
                        {f.status === "FILED" && <span className="text-emerald-800">Filed {fmtDate(f.filedOn)}{f.confirmationNumber ? ` · confirmation ${f.confirmationNumber}` : ""}{f.confirmationDocumentId ? " · confirmation on file" : ""}</span>}
                      </div>
                      {f.urgentReason && open && <p className="text-xs text-red-800">{f.urgentReason}</p>}
                      {f.note && <p className="text-xs text-slate-600">{f.note}</p>}
                      {open && (
                        <div className="mt-2 grid gap-3 lg:grid-cols-3">
                          <ActionForm action={setFilingStatusAction.bind(null, clientId, f.id)} className="flex flex-wrap items-end gap-2">
                            <Field label="Status"><select name="status" className="input" defaultValue={(WORKING_STATUSES as readonly string[]).includes(f.status) ? f.status : "NOT_STARTED"}>{WORKING_STATUSES.map((s) => <option key={s} value={s}>{STATUS_LABEL[s]}</option>)}</select></Field>
                            <input name="note" className="input" placeholder="Note (optional)" maxLength={500} />
                            <Button type="submit" variant="secondary">Save</Button>
                          </ActionForm>
                          <details>
                            <summary className="cursor-pointer text-xs font-semibold text-navy-900">Final deadline / urgent</summary>
                            <ActionForm action={flagFilingAction.bind(null, clientId, f.id)} className="mt-1 space-y-1">
                              <Field label="Final deadline (e.g. forfeiture date)"><input name="finalDeadline" type="date" className="input" defaultValue={f.finalDeadline ? f.finalDeadline.toISOString().slice(0, 10) : ""} /></Field>
                              <label className="flex items-center gap-2 text-xs"><input type="checkbox" name="urgent" defaultChecked={f.urgent} /> Urgent (stays on until completed)</label>
                              <input name="reason" className="input w-full" placeholder="Why (e.g. forfeiture notice dated 10/23/2026)" maxLength={500} />
                              <Button type="submit" variant="secondary">Save</Button>
                            </ActionForm>
                          </details>
                          <details>
                            <summary className="cursor-pointer text-xs font-semibold text-emerald-800">Record as filed</summary>
                            <ActionForm action={completeFilingAction.bind(null, clientId, f.id)} className="mt-1 space-y-1">
                              <input type="hidden" name="label" value={`${q.state} ${q.name} ${f.period}`} />
                              <Field label="Date filed"><input name="filedOn" type="date" className="input" required /></Field>
                              <Field label="Confirmation number"><input name="confirmationNumber" className="input" maxLength={80} /></Field>
                              <Field label="Confirmation (PDF or picture)"><input name="file" type="file" className="input" accept="application/pdf,image/png,image/jpeg" /></Field>
                              <p className="text-xs text-slate-600">A confirmation number or the uploaded confirmation is required.</p>
                              <Button type="submit">Mark filed</Button>
                            </ActionForm>
                            {isAdmin && (
                              <ActionForm action={markNotRequiredAction.bind(null, clientId, f.id)} className="mt-2 flex gap-2">
                                <input name="reason" className="input" placeholder="Why not required" required minLength={5} />
                                <Button type="submit" variant="secondary">Not required</Button>
                              </ActionForm>
                            )}
                          </details>
                        </div>
                      )}
                    </li>
                  );
                })}
              </ul>
            </li>
          ))}
        </ul>
        <details className="mt-3">
          <summary className="cursor-pointer text-sm font-semibold text-navy-900">Add a recurring filing</summary>
          <ActionForm action={addRequirementAction.bind(null, clientId)} className="mt-2 grid gap-2 sm:grid-cols-3" resetOnSuccess>
            <Field label="State"><select name="state" className="input" required defaultValue={registrations[0]?.state ?? ""}><option value="" disabled>Choose</option>{STATES.map((s) => <option key={s} value={s}>{s}</option>)}</select></Field>
            <Field label="Registration"><select name="registrationId" className="input"><option value="">—</option>{registrations.map((r) => <option key={r.id} value={r.id}>{r.state}{r.entityId ? ` ${r.entityId}` : ""}</option>)}</select></Field>
            <Field label="Kind"><select name="category" className="input">{Object.entries(CATEGORIES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></Field>
            <Field label="Filing name"><input name="name" className="input" required maxLength={160} placeholder="e.g. Form 1 Annual Report / Personal Property Tax Return" /></Field>
            <Field label="Agency"><input name="agency" className="input" maxLength={160} /></Field>
            <Field label="Filing website (https)"><input name="filingUrl" className="input" maxLength={300} placeholder="https://" /></Field>
            <Field label="Due month (this state's)"><select name="dueMonth" className="input" required>{MONTH_NAMES.map((m, i) => <option key={m} value={i + 1}>{m}</option>)}</select></Field>
            <Field label="Due day"><input name="dueDay" type="number" min={1} max={31} className="input" required /></Field>
            <Field label="How often"><select name="frequency" className="input">{Object.entries(FREQUENCIES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></Field>
            <Field label="First year to track" hint="Earlier unfiled years can be included (e.g. an outstanding 2025 report)."><input name="startYear" type="number" min={2000} max={2100} defaultValue={thisYear} className="input" required /></Field>
            <div className="flex items-end"><Button type="submit">Track this filing</Button></div>
          </ActionForm>
        </details>
      </Card>
    </div>
  );
}
