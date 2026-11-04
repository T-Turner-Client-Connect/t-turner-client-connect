import Link from "next/link";
import { connection } from "next/server";
import { notFound } from "next/navigation";
import { requireUser } from "@/lib/auth/session";
import { prisma } from "@/lib/prisma";
import { ActionForm } from "@/components/action-form";
import { Button, Card, Field, Notice, PageHeader } from "@/components/ui";
import { discardPayrollRunAction, editPayrollRunAction, postPayrollRunAction, requestApprovalAction, submitRunAction } from "@/app/actions/payroll";
import { canUseLedger, ymdOf } from "@/lib/services/ledger";
import { draftEntry } from "@/lib/services/payroll";
import { runTimeline } from "@/lib/services/payroll-approval";
import { PAYROLL_SYSTEMS } from "@/lib/payroll/fields";
import { AMOUNT_KEYS } from "@/lib/payroll/register";
import { dayOf, hours, money, RunStatus, StatusSteps, whenOf } from "@/components/payroll/status";

export const metadata = { title: "Pay run" };

const EVENT_LABEL: Record<string, string> = {
  CREATED: "Created", VERSIONED: "New version", APPROVAL_REQUESTED: "Sent for approval", APPROVED: "Approved", DENIED: "Denied — Needs Review",
  FULLY_APPROVED: "Fully Approved", SUBMITTED: "Submitted for Processing", PROCESSED: "Processed by provider", POSTED: "Posted to the books", DISCARDED: "Discarded", APPROVALS_INVALIDATED: "Earlier approvals invalidated",
};
const COLS: [typeof AMOUNT_KEYS[number], string][] = [["hoursHundredths", "Hours"], ["grossCents", "Gross"], ["federalWhCents", "Federal"], ["ssEeCents", "SS"], ["medicareEeCents", "Medicare"], ["stateWhCents", "State"], ["otherEeTaxCents", "Other EE tax"], ["deductionsCents", "Deductions"], ["netPayCents", "Net"], ["employerTaxCents", "Employer taxes"]];

export default async function PayRunPage({ params }: { params: Promise<{ clientId: string; runId: string }> }) {
  await connection();
  const actor = await requireUser();
  const { clientId, runId } = await params;
  const client = await prisma.client.findUnique({ where: { id: clientId }, select: { displayName: true, businessName: true } });
  if (!client || !(await canUseLedger(actor, clientId))) notFound();
  const t = await runTimeline(actor, clientId, runId).catch(() => null);
  if (!t) notFound();
  const { run, version, events, versions, current, notices, approvers } = t;
  const entry = await draftEntry(clientId, runId);
  const banks = await prisma.ledgerAccount.findMany({ where: { clientId, subtype: "BANK", active: true }, orderBy: { code: "asc" } });
  const base = `/bookkeeping/${clientId}/payroll`;
  const locked = ["SUBMITTED", "PROCESSED", "DISCARDED"].includes(run.status);
  const approvedIds = current.filter((a) => a.decision === "APPROVED").map((a) => a.portalUserId);
  const providerName = run.provider.startsWith("ADP") ? "ADP" : run.provider === "PAYCHEX_FLEX" ? "Paychex" : PAYROLL_SYSTEMS[run.provider as keyof typeof PAYROLL_SYSTEMS] ?? "the provider";
  return (
    <>
      <PageHeader title={`Pay run — ${dayOf(version.checkDate)}`} subtitle={<><Link href={base} className="underline">{client.businessName || client.displayName} · Payroll</Link> · {PAYROLL_SYSTEMS[run.provider as keyof typeof PAYROLL_SYSTEMS] ?? run.provider} · version {version.number}{run.origin === "COETHA" ? " · prepared by Coetha (Tabitha approves)" : ""}</>} actions={<RunStatus status={run.status} approvedBy={current.filter((a) => a.decision === "APPROVED").map((a) => a.approverName)} />} />

      <Card title="Status" className="mb-4">
        <StatusSteps status={run.status} required={approvers.required.map((a) => ({ id: a.portalUserId, name: a.portalUser.name }))} approvedIds={approvedIds} />
        <ol className="mt-4 space-y-2 border-l-2 border-navy-100 pl-4 text-sm" data-testid="timeline">
          {events.map((e) => (
            <li key={e.id}>
              <span className="font-semibold text-navy-900">{EVENT_LABEL[e.kind] ?? e.kind}</span>
              {e.actorName && <span className="text-slate-600"> · {e.actorName}</span>}
              {e.versionNumber && <span className="text-slate-500"> · v{e.versionNumber}</span>}
              <span className="text-slate-500"> · {whenOf(e.createdAt)}</span>
              {e.note && <span className="block text-slate-700">{e.note}</span>}
            </li>
          ))}
        </ol>
      </Card>

      <div className="grid gap-4 lg:grid-cols-3">
        <Card title="Totals (current version)">
          <dl className="space-y-1 text-sm">
            <div className="flex justify-between"><dt>Pay period</dt><dd>{version.periodStart && version.periodEnd ? `${dayOf(version.periodStart)} – ${dayOf(version.periodEnd)}` : "Not in the file"}</dd></div>
            <div className="flex justify-between"><dt>Pay date</dt><dd className="font-semibold">{dayOf(version.checkDate)}</dd></div>
            <div className="flex justify-between"><dt>Employees</dt><dd>{version.employees}</dd></div>
            <div className="flex justify-between"><dt>Hours</dt><dd>{hours(version.hoursHundredths)}</dd></div>
            <div className="flex justify-between"><dt>Gross wages</dt><dd>{money(version.grossCents)}</dd></div>
            <div className="flex justify-between"><dt>Employee taxes</dt><dd>{money(version.federalWhCents + version.ssEeCents + version.medicareEeCents + version.stateWhCents + version.otherEeTaxCents)}</dd></div>
            <div className="flex justify-between"><dt>Deductions</dt><dd>{money(version.deductionsCents)}</dd></div>
            <div className="flex justify-between"><dt>Net pay</dt><dd>{money(version.netPayCents)}</dd></div>
            <div className="flex justify-between"><dt>Employer taxes</dt><dd>{money(version.employerTaxCents)}</dd></div>
            <div className="flex justify-between border-t border-navy-100 pt-1 font-semibold text-navy-900"><dt>Total payroll cost</dt><dd>{money(version.grossCents + version.employerTaxCents)}</dd></div>
          </dl>
          <p className="mt-2 break-all text-[11px] text-slate-400">Content hash {version.contentHash.slice(0, 16)}…</p>
        </Card>

        <Card title="Next step" className="lg:col-span-2">
          <div className="space-y-3">
            {(run.status === "DRAFT" || run.status === "DENIED") && approvers.all.length > 0 && (
              <ActionForm action={requestApprovalAction.bind(null, clientId, runId)}>
                <p className="mb-2 text-sm text-slate-700">Send version {version.number} to {approvers.all.map((a) => a.portalUser.name).join(", ")} for approval{approvers.required.length < approvers.all.length ? ` (required: ${approvers.required.map((a) => a.portalUser.name).join(", ")})` : ""}. Each gets a secure link by their chosen channel.</p>
                <Button type="submit">Send for owner approval</Button>
              </ActionForm>
            )}
            {(run.status === "FULLY_APPROVED" || (run.status === "DRAFT" && approvers.all.length === 0)) && (
              <ActionForm action={submitRunAction.bind(null, clientId, runId)} className="flex flex-wrap items-end gap-2" confirm={`Submit this payroll to ${providerName}? It locks the run.`}>
                <Field label="Note (what you did in the provider)"><input className="input" name="note" placeholder={`e.g. Entered and submitted in ${providerName}`} /></Field>
                <Button type="submit">Submit to {providerName}</Button>
              </ActionForm>
            )}
            {run.status === "AWAITING_APPROVAL" && <Notice tone="info">Waiting for the owners. Approvals count only for version {version.number}; any change creates a new version and the run is sent again.</Notice>}
            {run.status === "FULLY_APPROVED" && <p className="text-xs text-slate-600">Approval never releases payroll by itself — the payroll operator submits it. Until the {providerName} connection is authorized, submit it in {providerName} and record it here.</p>}
            {(run.status === "SUBMITTED" || run.status === "PROCESSED") && !run.journalEntryId && (
              <ActionForm action={postPayrollRunAction.bind(null, clientId, runId)} className="flex flex-wrap items-end gap-2">
                <Field label="Net pay paid from">
                  <select className="input" name="cashAccountId" defaultValue={run.cashAccountId ?? banks[0]?.id ?? ""}>{banks.map((b) => <option key={b.id} value={b.id}>{b.code} {b.name}</option>)}</select>
                </Field>
                <Button type="submit">Post journal entry to the books</Button>
              </ActionForm>
            )}
            {run.journalEntryId && <Notice tone="success">Posted to the books {run.postedAt ? whenOf(run.postedAt) : ""}. Corrections are made with a reversal on the Books page.</Notice>}
            {!locked && (
              <details>
                <summary className="cursor-pointer text-sm font-semibold text-red-700">Discard this pay run</summary>
                <ActionForm action={discardPayrollRunAction.bind(null, clientId, runId)} className="mt-2 flex flex-wrap items-end gap-2">
                  <Field label="Why"><input className="input" name="reason" required minLength={3} /></Field>
                  <Button type="submit" variant="secondary">Discard</Button>
                </ActionForm>
              </details>
            )}
          </div>
        </Card>
      </div>

      <Card title={`Employees (version ${version.number})`} className="mt-4">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[60rem] text-sm">
            <thead className="text-left text-xs uppercase tracking-wide text-navy-800"><tr><th className="py-2 pr-2">Employee</th>{COLS.map(([, l]) => <th key={l} className="py-2 pr-2 text-right">{l}</th>)}</tr></thead>
            <tbody>
              {version.lines.map((l) => (
                <tr key={l.id} className="border-t border-navy-100">
                  <td className="py-1.5 pr-2 font-medium text-navy-900">{l.employeeName}</td>
                  {COLS.map(([k]) => <td key={k} className="py-1.5 pr-2 text-right">{k === "hoursHundredths" ? hours(l[k]) : money(l[k])}</td>)}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {!locked && (
          <details className="mt-3">
            <summary className="cursor-pointer text-sm font-semibold text-navy-900">Correct figures (creates version {version.number + 1})</summary>
            <ActionForm action={editPayrollRunAction.bind(null, clientId, runId)} className="mt-3 space-y-2">
              <input type="hidden" name="lineCount" value={version.lines.length + 1} />
              <div className="overflow-x-auto">
                <table className="w-full min-w-[70rem] text-xs">
                  <thead><tr><th className="pr-1 text-left">Employee</th>{COLS.map(([, l]) => <th key={l} className="pr-1 text-left">{l}</th>)}</tr></thead>
                  <tbody>
                    {[...version.lines, null].map((l, i) => (
                      <tr key={l?.id ?? "new"}>
                        <td className="pr-1"><input className="input py-1 text-xs" name={`l${i}.employeeName`} defaultValue={l?.employeeName ?? ""} placeholder={l ? "" : "Add employee"} /></td>
                        {COLS.map(([k]) => <td key={k} className="pr-1"><input className="input w-24 py-1 text-xs" name={`l${i}.${k}`} defaultValue={l ? (l[k] / 100).toFixed(2) : ""} inputMode="decimal" /></td>)}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="flex flex-wrap items-end gap-2">
                <Field label="Pay date"><input type="date" className="input" name="checkDate" defaultValue={ymdOf(version.checkDate)} /></Field>
                <Field label="Period start"><input type="date" className="input" name="periodStart" defaultValue={version.periodStart ? ymdOf(version.periodStart) : ""} /></Field>
                <Field label="Period end"><input type="date" className="input" name="periodEnd" defaultValue={version.periodEnd ? ymdOf(version.periodEnd) : ""} /></Field>
                <Field label="What changed and why"><input className="input" name="reason" required minLength={3} /></Field>
                <Button type="submit">Save new version</Button>
              </div>
              <p className="text-xs text-slate-600">Gross − employee taxes − deductions must equal net pay. Saving invalidates earlier approvals; send it for approval again. Clear a name to remove that employee.</p>
            </ActionForm>
          </details>
        )}
      </Card>

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <Card title={run.journalEntryId ? "Payroll journal entry (posted)" : "Draft payroll journal entry"}>
          <table className="w-full text-sm" data-testid="draft-entry">
            <thead className="text-left text-xs uppercase text-navy-800"><tr><th className="py-1">Account</th><th className="py-1">Line</th><th className="py-1 text-right">Debit</th><th className="py-1 text-right">Credit</th></tr></thead>
            <tbody>
              {entry.lines.map((l, i) => (
                <tr key={i} className="border-t border-navy-100"><td className="py-1 pr-2">{l.account}</td><td className="py-1 pr-2 text-slate-600">{l.description}</td><td className="py-1 text-right">{l.debitCents ? money(l.debitCents) : ""}</td><td className="py-1 text-right">{l.creditCents ? money(l.creditCents) : ""}</td></tr>
              ))}
              <tr className="border-t-2 border-navy-900 font-semibold"><td className="py-1" colSpan={2}>Totals {entry.debits === entry.credits ? "· balances" : "· doesn't balance"}</td><td className="py-1 text-right">{money(entry.debits)}</td><td className="py-1 text-right">{money(entry.credits)}</td></tr>
            </tbody>
          </table>
        </Card>
        <Card title="Approvals, notices and versions">
          <h4 className="text-xs font-semibold uppercase text-navy-800">Decisions (this round)</h4>
          {!current.length ? <p className="text-sm text-slate-600">None yet.</p> : (
            <ul className="text-sm">{current.map((a) => <li key={a.id}><span className="font-semibold">{a.approverName}</span>: {a.decision === "APPROVED" ? "Approved" : "Denied"} · {a.channel === "PORTAL" ? "portal" : a.channel === "SMS_LINK" ? "text link" : "email link"} ({a.verifiedBy.toLowerCase().replace(/_/g, " ")}) · {whenOf(a.createdAt)}{a.comment && <span className="block text-slate-600">“{a.comment}”</span>}</li>)}</ul>
          )}
          <h4 className="mt-3 text-xs font-semibold uppercase text-navy-800">Notices</h4>
          {!notices.length ? <p className="text-sm text-slate-600">None sent.</p> : (
            <ul className="text-xs text-slate-700">{notices.map((n) => <li key={n.id}>Round {n.round} · {n.channel === "SMS" ? "Text" : "Email"} · {n.status.toLowerCase()}{n.detail ? ` — ${n.detail}` : ""}</li>)}</ul>
          )}
          <h4 className="mt-3 text-xs font-semibold uppercase text-navy-800">Versions</h4>
          <ul className="text-xs text-slate-700">{versions.map((v) => <li key={v.id}>v{v.number} · {whenOf(v.createdAt)} · gross {money(v.grossCents)} · {v.reason ?? ""}</li>)}</ul>
        </Card>
      </div>
    </>
  );
}
