import Link from "next/link";
import { connection } from "next/server";
import { notFound } from "next/navigation";
import { requireUser } from "@/lib/auth/session";
import { prisma } from "@/lib/prisma";
import { ActionForm } from "@/components/action-form";
import { Button, Card, Field, Notice, PageHeader } from "@/components/ui";
import { payDateAction } from "@/app/actions/business-overview";
import { payrollSetupAction, staffNotifyChannelAction } from "@/app/actions/payroll";
import { PAYROLL_FREQUENCIES } from "@/lib/services/bookkeeping-clients";
import { PAYROLL_ACCESS } from "@/lib/services/bookkeeping-profile";
import { canUseLedger } from "@/lib/services/ledger";
import { payHistory, payrollSchedule } from "@/lib/services/payroll";
import { approverWhere, canManagePayrollApprovers, channelsFor } from "@/lib/services/payroll-approval";
import { connectionStatus } from "@/lib/payroll/providers";
import { NOTIFY_CHANNELS, PAYROLL_CONNECTIONS, PAYROLL_PROVIDER_LOGIN, PAYROLL_SYSTEMS, type PayrollSystem } from "@/lib/payroll/fields";
import { PayrollImport } from "@/components/payroll/payroll-import";
import { dayOf, money, RunStatus } from "@/components/payroll/status";
import { deliveryOf } from "@/lib/payroll/queue";

export const metadata = { title: "Payroll" };

const PRESET_FOR: Record<string, string> = { ADP_RUN: "ADP_RUN", ADP_WFN: "ADP_WFN", PAYCHEX_FLEX: "PAYCHEX_FLEX" };

export default async function PayrollPage({ params }: { params: Promise<{ clientId: string }> }) {
  await connection();
  const actor = await requireUser();
  const { clientId } = await params;
  const client = await prisma.client.findUnique({ where: { id: clientId }, select: { displayName: true, businessName: true, bookkeepingProfile: true } });
  if (!client) notFound();
  const p = client.bookkeepingProfile;
  const base = `/bookkeeping/${clientId}`;
  if (!p?.payroll) {
    return (
      <>
        <PageHeader title="Payroll" subtitle={client.businessName || client.displayName} />
        <Card><p className="text-sm text-slate-700">This client doesn&apos;t run payroll. Turn it on under <Link className="font-semibold underline" href={base}>Bookkeeping settings</Link>.</p></Card>
      </>
    );
  }
  const [schedule, history, ledgerOk, manager, approvers, apiConn, banks] = await Promise.all([
    payrollSchedule(clientId),
    payHistory(clientId, 26),
    canUseLedger(actor, clientId),
    canManagePayrollApprovers(actor),
    prisma.payrollApprover.findMany({ where: approverWhere(clientId), include: { portalUser: { select: { id: true, name: true, email: true, phoneNormalized: true } } }, orderBy: [{ required: "desc" }, { createdAt: "asc" }] }),
    p.payrollSystem ? prisma.payrollConnection.findFirst({ where: { clientId, provider: p.payrollSystem } }) : null,
    prisma.ledgerAccount.findMany({ where: { clientId, subtype: "BANK", active: true }, orderBy: { code: "asc" } }),
  ]);
  const conn = connectionStatus(p.payrollSystem, apiConn);
  const known = p.payrollPayDate?.toISOString().slice(0, 10) ?? null;
  const approverRows = await Promise.all(approvers.map(async (a) => ({ a, ch: await channelsFor(a, a.portalUser) })));
  const approvals = await prisma.payrollApproval.findMany({ where: { runId: { in: history.map((h) => h.run.id) }, decision: "APPROVED" }, select: { runId: true, round: true, versionId: true, approverName: true } });
  // PAY-1: a waiting run whose approval email never reached the client shows as Not Sent / Failed.
  const waitingRuns = history.map((h) => h.run).filter((r) => r.status === "AWAITING_APPROVAL");
  const runNotices = waitingRuns.length ? await prisma.payrollNotice.findMany({ where: { OR: waitingRuns.map((r) => ({ runId: r.id, round: r.approvalRound })) }, select: { runId: true, channel: true, status: true, detail: true } }) : [];
  return (
    <>
      <PageHeader title="Payroll" subtitle={client.businessName || client.displayName} />
      <div className="grid gap-4 lg:grid-cols-3">
        <Card title="Payroll provider" className="lg:col-span-1">
          <ActionForm action={payrollSetupAction.bind(null, clientId)} className="space-y-3" >
            <div data-testid="payroll-setup" className="grid gap-3">
              <Field label="Payroll system">
                <select className="input" name="system" defaultValue={p.payrollSystem ?? ""} required>
                  <option value="" disabled>Choose…</option>
                  {Object.entries(PAYROLL_SYSTEMS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                </select>
              </Field>
              <Field label="Provider name (for Other)"><input className="input" name="providerName" defaultValue={p.payrollSystem === "OTHER" ? p.payrollProvider ?? "" : ""} placeholder="e.g. Local payroll service" /></Field>
              <Field label="Pay frequency">
                <select className="input" name="frequency" defaultValue={p.payrollFrequency ?? ""}>
                  <option value="">Not set</option>
                  {Object.entries(PAYROLL_FREQUENCIES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                </select>
              </Field>
              <Field label="How payroll data reaches us">
                <select className="input" name="connection" defaultValue={p.payrollConnection ?? "REPORT_IMPORT"}>
                  {Object.entries(PAYROLL_CONNECTIONS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                </select>
              </Field>
              <Field label="Accountant access">
                <select className="input" name="accessStatus" defaultValue={p.payrollAccessStatus ?? ""}>
                  <option value="">Not recorded</option>
                  {Object.entries(PAYROLL_ACCESS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                </select>
              </Field>
            </div>
            <Button type="submit" variant="secondary">Save provider setup</Button>
          </ActionForm>
        </Card>

        <Card title="Schedule">
          <dl className="space-y-1 text-sm" data-testid="payroll-schedule">
            <div className="flex justify-between gap-2"><dt>Provider</dt><dd className="font-semibold">{p.payrollProvider ?? "Not set"}</dd></div>
            <div className="flex justify-between gap-2"><dt>How often</dt><dd className="font-semibold">{p.payrollFrequency ? PAYROLL_FREQUENCIES[p.payrollFrequency as keyof typeof PAYROLL_FREQUENCIES] : "Not set"}</dd></div>
            <div className="flex justify-between gap-2"><dt>Last pay date</dt><dd className="font-semibold">{schedule.last ? dayOf(schedule.last) : "No payroll imported yet"}</dd></div>
            <div className="flex justify-between gap-2"><dt>Next pay date</dt><dd className="font-semibold" data-testid="next-pay-date">{schedule.next ? dayOf(schedule.next) : "Import a register or add a known pay date"}</dd></div>
          </dl>
          <p className="mt-2 text-xs text-slate-500">{schedule.fromImports ? "Estimated from the last imported pay date and the pay frequency." : "Estimated from the known pay date below."} Twice-a-month payroll is shown as the 15th and the last day of the month.</p>
          <ActionForm action={payDateAction.bind(null, clientId)} className="mt-3 flex flex-wrap items-end gap-2">
            <Field label="A known pay date"><input type="date" name="payDate" className="input" defaultValue={known ?? ""} /></Field>
            <Button type="submit" variant="secondary">Save</Button>
          </ActionForm>
        </Card>

        <Card title="Direct connection">
          <p className="text-sm font-semibold text-navy-900" data-testid="api-status">{conn.label}</p>
          <p className="mt-2 text-sm text-slate-700">Until the connection is approved, payroll comes in through the register import below — it works today with ADP RUN, ADP Workforce Now and Paychex Flex exports.</p>
          <p className="mt-2 text-xs text-slate-500">Setup guide: <span className="font-mono">docs/payroll-integrations.md</span> (what Tabitha files with ADP and Paychex, and what each business authorizes).</p>
          <p className="mt-3 text-sm"><span className="font-semibold">Accountant access:</span> {p.payrollAccessStatus ? PAYROLL_ACCESS[p.payrollAccessStatus as keyof typeof PAYROLL_ACCESS] : "Not recorded"}</p>
        </Card>
      </div>

      <Card title="Payroll approvers" className="mt-4" actions={manager ? <Link href={`/owner/payroll-approvers?client=${clientId}`} className="text-sm font-semibold text-navy-900 underline">Choose approvers (Owner&apos;s Office)</Link> : null}>
        {!approverRows.length ? (
          <p className="text-sm text-slate-700">No owners approve this business&apos;s payroll yet. {manager ? "Choose them in the Owner's Office." : "Tabitha chooses them in the Owner's Office."} Without approvers, the office submits payroll directly.</p>
        ) : (
          <ul className="divide-y divide-navy-100 text-sm">
            {approverRows.map(({ a, ch }) => (
              <li key={a.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <span><span className="font-semibold text-navy-900">{a.portalUser.name}</span> <span className="text-slate-500">{a.required ? "· Required approver" : "· Optional approver"}</span>{ch.fallback && <span className="block text-xs text-amber-700">Texts fall back to email: {ch.fallback}</span>}</span>
                <ActionForm action={staffNotifyChannelAction.bind(null, clientId, a.portalUserId)} className="flex items-center gap-2">
                  <select className="input py-1 text-xs" name="channel" defaultValue={a.notifyChannel ?? "BOTH"} aria-label={`How ${a.portalUser.name} is notified`}>
                    {Object.entries(NOTIFY_CHANNELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                  </select>
                  <Button type="submit" variant="secondary" className="py-1 text-xs">Change at client&apos;s request</Button>
                </ActionForm>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <section id="import" className="mt-4">
        <Card title="Import a payroll register">
          {(() => {
            const login = p.payrollSystem ? PAYROLL_PROVIDER_LOGIN[p.payrollSystem as PayrollSystem] : undefined;
            return login ? (
              <p className="mb-3 flex flex-wrap items-center gap-2 text-sm text-slate-700" data-testid="payroll-provider-login">
                <a href={login.url} target="_blank" rel="noopener noreferrer" className="inline-flex min-h-10 items-center rounded-lg bg-navy-900 px-4 py-2 text-sm font-semibold text-white hover:bg-navy-800">{login.label} ↗</a>
                <span>Opens in a new tab, so this page stays open. Download the payroll register (PDF is fine) and choose it below.</span>
              </p>
            ) : null;
          })()}
          {!ledgerOk ? (
            <Notice tone="warn">Only Admins and the staff member assigned to this client can import payroll.</Notice>
          ) : (
            <>
              <p className="mb-3 text-sm text-slate-700">Export the <strong>payroll register</strong> (ADP — PDF is fine) or <strong>payroll journal</strong> (Paychex) as PDF, CSV or Excel for the pay dates you need, then upload it here. A PDF is read by Coetha and checked against the register&apos;s own totals. You&apos;ll see totals per pay date before anything is created. Each new pay date becomes a draft pay run with a draft journal entry; re-importing the same file never doubles up.</p>
              <PayrollImport clientId={clientId} defaultPreset={PRESET_FOR[p.payrollSystem ?? ""] ?? "OTHER"} bankAccounts={banks.map((b) => ({ id: b.id, label: `${b.code} ${b.name}` }))} />
            </>
          )}
        </Card>
      </section>

      <Card title="Pay history" className="mt-4">
        {!history.length ? (
          <p className="text-sm text-slate-700">No pay runs yet. Import a payroll register above.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[48rem] text-sm" data-testid="pay-history">
              <thead className="text-left text-xs uppercase tracking-wide text-navy-800">
                <tr><th className="py-2 pr-3">Check date</th><th className="py-2 pr-3">Status</th><th className="py-2 pr-3 text-right">Employees</th><th className="py-2 pr-3 text-right">Gross</th><th className="py-2 pr-3 text-right">Net pay</th><th className="py-2 pr-3 text-right">Total cost</th><th className="py-2 pr-3">Books</th><th className="py-2" /></tr>
              </thead>
              <tbody>
                {history.map(({ run, version }) => (
                  <tr key={run.id} className="border-t border-navy-100">
                    <td className="py-2 pr-3 font-semibold text-navy-900">{dayOf(run.checkDate)}<span className="ml-1 text-xs font-normal text-slate-500">v{version.number}</span></td>
                    <td className="py-2 pr-3"><RunStatus status={run.status} delivery={run.status === "AWAITING_APPROVAL" ? deliveryOf(runNotices.filter((n) => n.runId === run.id)) : null} approvedBy={approvals.filter((x) => x.runId === run.id && x.round === run.approvalRound && x.versionId === run.currentVersionId).map((x) => x.approverName)} /></td>
                    <td className="py-2 pr-3 text-right">{version.employees}</td>
                    <td className="py-2 pr-3 text-right">{money(version.grossCents)}</td>
                    <td className="py-2 pr-3 text-right">{money(version.netPayCents)}</td>
                    <td className="py-2 pr-3 text-right font-semibold">{money(version.grossCents + version.employerTaxCents)}</td>
                    <td className="py-2 pr-3 text-xs">{run.journalEntryId ? <span className="font-semibold text-emerald-700">Posted</span> : <span className="text-slate-600">Draft entry</span>}</td>
                    <td className="py-2 text-right"><Link href={`${base}/payroll/${run.id}`} className="font-semibold text-navy-900 underline">Open</Link></td>
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
