import Link from "next/link";
import { notFound } from "next/navigation";
import { CheckCircle2, Circle } from "lucide-react";
import { ActionForm } from "@/components/action-form";
import { Badge, Button, Card, Field, Notice, PageHeader } from "@/components/ui";
import {
  confirmFeatureAction, earningsCodesAction, earningsReportAction, employeeMapAction, employeeReportAction, saveIdentifiersAction, setFrequencyAction, testFileAction, testVerifiedAction,
  uploadTemplateAction,
} from "@/app/actions/adp-run";
import { requirePayrollTaxPage } from "@/lib/payroll-taxes/access";
import { adpSetupPage } from "@/lib/services/adp-run";
import { ForbiddenError } from "@/lib/auth/actor";
import { ADP_FREQUENCY, ADP_FREQUENCY_LABEL, NOT_IN_IMPORT, RATE_CODES } from "@/lib/payroll/adp-run-csv";

export const metadata = { title: "ADP RUN import setup" };

const input = "w-full rounded-lg border border-ivory-200 px-3 py-2 text-sm focus:border-navy-700 focus:outline-none disabled:bg-ivory-100";
const fileInput = "block w-full text-sm file:mr-3 file:rounded-lg file:border-0 file:bg-navy-900 file:px-3 file:py-2 file:text-white";
const day = (d: Date | null) => (d ? d.toLocaleDateString("en-US", { timeZone: "America/Chicago" }) : "");

export default async function AdpSetupPage({ params }: { params: Promise<{ clientId: string }> }) {
  const { actor } = await requirePayrollTaxPage();
  const { clientId } = await params;
  const p = await adpSetupPage(actor, clientId).catch((e) => {
    if (e instanceof ForbiddenError) notFound();
    throw e;
  });
  const s = p.setup;
  const ro = !p.canManage;
  const scheduleLetter = p.client.frequency ? ADP_FREQUENCY[p.client.frequency] : null;
  const done = p.checklist.filter((c) => c.done).length;

  return (
    <>
      <PageHeader title={`ADP RUN import setup — ${p.client.name}`} subtitle={<Link href={`/payroll-taxes/schedules/${clientId}`} className="underline">← Payroll schedule</Link>} actions={p.ready ? <Badge tone="green">Ready: Download ADP CSV is on</Badge> : <Badge tone="amber">{done} of {p.checklist.length} steps done</Badge>} />
      <div className="mb-4">
        <Notice tone="info" title="How this works">
          A one-time setup for this business. Afterwards, each pay cycle has <strong>Download ADP CSV</strong>: the hours entered once in Client Connect, with this company&apos;s code and each employee&apos;s RUN ID already filled in. Import the file in RUN (Home &gt; Time Sheet Import), review Pay Data Approval and submit payroll in RUN as usual. Client Connect never connects to ADP and never submits payroll.
        </Notice>
      </div>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]">
        <Card title="Setup checklist">
          <ol className="space-y-3 text-sm" data-testid="adp-checklist">
            {p.checklist.map((c, i) => (
              <li key={c.key} className="flex gap-2" data-done={c.done ? "1" : "0"} data-key={c.key}>
                {c.done ? <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-emerald-600" aria-label="Done" /> : <Circle className="mt-0.5 size-4 shrink-0 text-slate-400" aria-label="Not done" />}
                <span><span className="font-semibold text-navy-900">{i + 1}. {c.label}</span><br /><span className="text-xs text-slate-600">{c.how}</span></span>
              </li>
            ))}
          </ol>
          <div className="mt-4 rounded-xl border border-ivory-200 bg-ivory-50 p-3 text-xs text-slate-700">
            <p className="mb-1 font-semibold text-navy-900">Still entered in RUN (the import doesn&apos;t carry these)</p>
            <ul className="list-disc space-y-0.5 pl-4">{NOT_IN_IMPORT.map((x) => <li key={x}>{x}</li>)}</ul>
          </div>
        </Card>

        <div className="space-y-4">
          <Card title="1. ADP company identifiers">
            <p className="mb-2 text-xs text-slate-600">From ADP Accountant Connect. Stored encrypted; only the last characters are shown. {s.companyCodeHint && <>Current company code <strong>{s.companyCodeHint}</strong> ({s.companyCodeForm === "IID" ? "IID" : "Branch + Code"}).</>}</p>
            <ActionForm action={saveIdentifiersAction.bind(null, clientId)} className="space-y-3">
              <fieldset disabled={ro} className="grid gap-3 sm:grid-cols-3">
                <Field label="ADP Client ID"><input name="acClientId" inputMode="numeric" autoComplete="off" className={input} placeholder={s.acClientIdHint ?? ""} /></Field>
                <Field label="Branch"><input name="branch" autoComplete="off" className={input} /></Field>
                <Field label="Code"><input name="code" autoComplete="off" className={input} /></Field>
                <Field label="The template's Company Code is" className="sm:col-span-3">
                  <select name="form" defaultValue={s.companyCodeForm ?? "BRANCH_CODE"} className={input}>
                    <option value="BRANCH_CODE">Branch + Code (for example XX + ABC → XXABC)</option>
                    <option value="IID">The ADP Client ID (IID)</option>
                  </select>
                </Field>
              </fieldset>
              {!ro && <Button type="submit">Save identifiers</Button>}
            </ActionForm>
          </Card>

          <Card title="2–3. Time Sheet Import and pay frequency">
            <div className="flex flex-wrap items-center gap-3 text-sm">
              {s.featureConfirmedAt ? <Badge tone="green">Turned on in RUN — recorded {day(s.featureConfirmedAt)}</Badge> : <Badge tone="amber">Not confirmed</Badge>}
              {!ro && (
                <ActionForm action={confirmFeatureAction.bind(null, clientId)}>
                  <input type="hidden" name="on" value={s.featureConfirmedAt ? "0" : "1"} />
                  <Button type="submit" variant="secondary">{s.featureConfirmedAt ? "Clear" : "It's selected on Company > Features Overview"}</Button>
                </ActionForm>
              )}
            </div>
            <ActionForm action={setFrequencyAction.bind(null, clientId)} className="mt-3 flex flex-wrap items-end gap-3">
              <Field label="Pay frequency in RUN" hint={`This client's pay schedule: ${scheduleLetter ? ADP_FREQUENCY_LABEL[scheduleLetter] : "not set"}.`}>
                <select name="letter" defaultValue={s.payFrequency ?? scheduleLetter ?? ""} disabled={ro} className={input}>
                  <option value="">Choose…</option>
                  {Object.entries(ADP_FREQUENCY_LABEL).map(([k, v]) => <option key={k} value={k}>{v} ({k})</option>)}
                </select>
              </Field>
              {!ro && <Button type="submit" variant="secondary">Save</Button>}
            </ActionForm>
          </Card>

          <Card title="4. This company's Time Sheet Import template">
            <p className="mb-2 text-xs text-slate-600">RUN: Help &amp; Support &gt; Payroll &amp; HR &gt; Time Sheet Import → Employee ID template. Save as .csv and upload. {s.templateCheckedAt && <>Checked {day(s.templateCheckedAt)} ({s.templateVersion}).</>}</p>
            {!ro && (
              <ActionForm action={uploadTemplateAction.bind(null, clientId)} className="flex flex-wrap items-center gap-3">
                <input type="file" name="file" accept=".csv,text/csv" required className={fileInput} />
                <Button type="submit" variant="secondary">Check template</Button>
              </ActionForm>
            )}
          </Card>

          <Card title="5–6. RUN reports">
            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <p className="text-sm font-semibold text-navy-900">Employee Codes Report</p>
                <p className="mb-2 text-xs text-slate-600">RUN: Reports → Employee Codes Report → Export to Excel → save as .csv. {s.employeeReportAt && <>Last read {day(s.employeeReportAt)}.</>}</p>
                {!ro && <ActionForm action={employeeReportAction.bind(null, clientId)} className="space-y-2"><input type="file" name="file" accept=".csv,text/csv" required className={fileInput} /><Button type="submit" variant="secondary">Read employees</Button></ActionForm>}
              </div>
              <div>
                <p className="text-sm font-semibold text-navy-900">Earnings Codes Report</p>
                <p className="mb-2 text-xs text-slate-600">RUN: Reports → Earnings Codes Report → Export to Excel → save as .csv. {s.earningsReportAt && <>Last read {day(s.earningsReportAt)}.</>}</p>
                {!ro && <ActionForm action={earningsReportAction.bind(null, clientId)} className="space-y-2"><input type="file" name="file" accept=".csv,text/csv" required className={fileInput} /><Button type="submit" variant="secondary">Read earnings codes</Button></ActionForm>}
              </div>
            </div>
            <ActionForm action={earningsCodesAction.bind(null, clientId)} className="mt-4 grid gap-3 sm:grid-cols-3">
              <fieldset disabled={ro} className="contents">
                {(["regular", "overtime"] as const).map((k) => (
                  <Field key={k} label={k === "regular" ? "Code for regular hours" : "Code for overtime hours"}>
                    {s.earningsCatalog.length ? (
                      <select name={k} defaultValue={(k === "regular" ? s.regularEarningsCode : s.overtimeEarningsCode) ?? ""} className={input}>
                        <option value="">{k === "regular" ? "Choose…" : "None"}</option>
                        {s.earningsCatalog.map((e) => <option key={e.code} value={e.code}>{e.code}{e.description ? ` — ${e.description}` : ""}</option>)}
                      </select>
                    ) : <input name={k} defaultValue={(k === "regular" ? s.regularEarningsCode : s.overtimeEarningsCode) ?? ""} className={input} placeholder="Read the report first" />}
                  </Field>
                ))}
                <label className="flex items-center gap-2 pt-6 text-sm"><input type="checkbox" name="usesDepartments" defaultChecked={s.usesDepartments} className="size-4 accent-[#0a1a44]" /> Company uses departments</label>
              </fieldset>
              {!ro && <div className="sm:col-span-3"><Button type="submit" variant="secondary">Save codes</Button></div>}
            </ActionForm>
          </Card>

          <Card title={`Employees (${s.employees.filter((e) => e.active).length} active)`}>
            <p className="mb-2 text-xs text-slate-600">The name must match how the hours are entered for this business. RUN IDs come from the Employee Codes Report; nobody re-enters them each payroll.</p>
            <div className="space-y-2" data-testid="adp-employees">
              {[...s.employees.map((e) => ({ ...e, isNew: false })), { id: "", name: "", adpEmployeeId: "", departmentCode: "", rateCode: "BASE", active: true, isNew: true }].map((e) => (
                <ActionForm key={e.id || "new"} action={employeeMapAction.bind(null, clientId, e.id || null)} className="grid items-end gap-2 rounded-lg border border-ivory-200 p-2 sm:grid-cols-[1.4fr_0.8fr_0.6fr_0.8fr_auto_auto]">
                  <fieldset disabled={ro} className="contents">
                    <Field label={e.isNew ? "Add: name in hours" : "Name in hours"}><input name="name" defaultValue={e.name} className={input} /></Field>
                    <Field label="RUN employee ID"><input name="adpEmployeeId" defaultValue={e.adpEmployeeId} className={input} /></Field>
                    <Field label="Dept"><input name="departmentCode" defaultValue={e.departmentCode ?? ""} className={input} /></Field>
                    <Field label="Rate code"><select name="rateCode" defaultValue={e.rateCode} className={input}>{RATE_CODES.map((r) => <option key={r}>{r}</option>)}</select></Field>
                    <label className="flex items-center gap-1 pb-2 text-xs"><input type="checkbox" name="active" defaultChecked={e.active} className="size-4 accent-[#0a1a44]" /> Active</label>
                  </fieldset>
                  {!ro && <Button type="submit" variant="secondary">{e.isNew ? "Add" : "Save"}</Button>}
                </ActionForm>
              ))}
            </div>
          </Card>

          <Card title="8. Test import (fictional hours)">
            <ol className="mb-3 list-decimal space-y-1 pl-5 text-xs text-slate-700">
              <li>Make the test file: 1.00 fictional regular hour for each active employee, for the next open pay period.</li>
              <li>In RUN: Home &gt; Time Sheet Import → Browse → Import Pay Data.</li>
              <li>Check RUN shows no errors and the right employees on Pay Data Approval.</li>
              <li><strong>Click “Delete this Pay Data File”. Never click Approve.</strong></li>
              <li>Record what RUN showed below.</li>
            </ol>
            {s.testVerifiedAt ? <Notice tone="success">Test verified {day(s.testVerifiedAt)}: {s.testVerifiedNote}</Notice> : !ro && (
              <div className="space-y-3">
                <ActionForm action={testFileAction.bind(null, clientId)}><Button type="submit" variant="secondary" disabled={!p.setupComplete}>Make the test file</Button></ActionForm>
                {!p.setupComplete && <p className="text-xs text-amber-700">Finish steps 1–7 first.</p>}
                <ActionForm action={testVerifiedAction.bind(null, clientId)} className="space-y-2">
                  <Field label="What RUN showed"><input name="note" className={input} placeholder="No errors on Pay Data Approval; file deleted, not approved" /></Field>
                  <Button type="submit">Record test as verified</Button>
                </ActionForm>
              </div>
            )}
          </Card>

          {p.exports.length > 0 && (
            <Card title="Files made">
              <ul className="space-y-1 text-xs" data-testid="adp-exports">
                {p.exports.map((x) => (
                  <li key={x.id} className="flex flex-wrap items-center gap-2">
                    {x.isTest && <Badge tone="amber">Test</Badge>}<Badge tone={x.status === "ACTIVE" ? "navy" : "gray"}>{x.status === "ACTIVE" ? "Current" : "Replaced"}</Badge>
                    <span>{x.fileName}</span><span className="text-slate-500">{x.rows} rows · downloaded {x.downloads}×{x.importedAt ? ` · imported ${day(x.importedAt)}` : ""}</span>
                    {x.status === "ACTIVE" && p.canManage && <a className="underline" href={`/api/payroll-taxes/adp-file/${x.id}`}>Download</a>}
                  </li>
                ))}
              </ul>
            </Card>
          )}
        </div>
      </div>
    </>
  );
}
