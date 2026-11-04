import Link from "next/link";
import clsx from "clsx";
import { connection } from "next/server";
import { notFound } from "next/navigation";
import { Archive, BadgeCheck, CloudUpload, FileText, History, Inbox, Landmark, ListChecks, Settings, Sparkles } from "lucide-react";
import { ActionForm } from "@/components/action-form";
import { BkUploadFields, UploadMeta } from "@/components/bk-upload";
import { card, Donut, Dot, goldBtn, h2, navyBtn, outlineBtn, StateIcon } from "@/components/bk/parts";
import { RequestList } from "@/components/bk/requests";
import { requireUser } from "@/lib/auth/session";
import { prisma } from "@/lib/prisma";
import { recordHeading } from "@/lib/services/related-businesses";
import {
  askQuestionAction, classifyDocumentAction, coethaLinkAction, deliverApprovedAction, openPeriodForClientAction, reportStepAction, requestChangesAction, saveBookkeepingProfileAction, uploadBookkeepingFileAction, uploadMonthlyFinancialsAction,
} from "@/app/actions/bookkeeping-clients";
import { runMonitorAction, taxClassificationAction } from "@/app/actions/bk-workflow";
import { BK_DOC_TYPES, bookkeepingWorkspace, FREQUENCIES, isReportApprover, PAYROLL_FREQUENCIES, periodLabel, reportCaption, REVIEW_LABELS, workMonth } from "@/lib/services/bookkeeping-clients";
import { BASIS, PERIOD_TYPES, type PeriodType } from "@/lib/bookkeeping-periods";
import { accountLabel } from "@/lib/services/bookkeeping-profile";
import { MONTHS } from "@/lib/services/bookkeeping";
import { downloadToken, REPORT_LABELS } from "@/lib/services/documents";
import { monthlyChecklist, coethaCurrentWork } from "@/lib/services/monthly-workflow";
import { bankingRegistry } from "@/lib/services/bank-accounts";
import { requestsFor } from "@/lib/services/client-requests";
import { canSendClientRequests, canViewBanking } from "@/lib/services/bk-permissions";
import { TAX_CLASSIFICATIONS, taxProfile } from "@/lib/services/tax-classification";
import { fmtDate, fmtDateTime } from "@/lib/format";

export const metadata = { title: "Bookkeeping management" };

const REVIEW_TONE: Record<string, string> = { DRAFT: "bg-slate-100 text-slate-700", AWAITING_REVIEW: "bg-gold-100 text-gold-800", CHANGES_REQUESTED: "bg-red-50 text-red-800", APPROVED: "bg-emerald-50 text-emerald-800", DELIVERED: "bg-emerald-600 text-white" };

/**
 * The Owner's Office bookkeeping management screen for one business and month: completion,
 * connected accounts, what's done and what's missing (all derived automatically), outstanding
 * requests, Coetha's current work, statements awaiting Tabitha, historical requests and history.
 * One upload path and the approval actions; routine prep has no manual check-offs.
 */
export default async function BookkeepingManagement({ params, searchParams }: { params: Promise<{ clientId: string }>; searchParams: Promise<{ period?: string; year?: string; month?: string }> }) {
  await connection();
  const user = await requireUser();
  const { clientId } = await params;
  const sp = await searchParams;
  if (!(await prisma.client.count({ where: { id: clientId } }))) notFound();
  const picked = sp.year && sp.month ? { year: Number(sp.year), month: Number(sp.month) } : null;
  const pickedPeriod = picked ? await prisma.bookkeepingPeriod.findUnique({ where: { clientId_year_month: { clientId, year: picked.year, month: picked.month } }, select: { id: true } }).catch(() => null) : null;
  const notOpened = picked && !pickedPeriod && picked.month >= 1 && picked.month <= 12 ? picked : null;
  const [ws, approver, staff] = await Promise.all([
    bookkeepingWorkspace(clientId, pickedPeriod?.id ?? sp.period),
    isReportApprover(user),
    prisma.user.findMany({ where: { active: true }, select: { id: true, name: true }, orderBy: { name: "asc" } }),
  ]);
  const { client, profile, period, summary } = ws;
  const heading = await recordHeading(clientId);
  const biz = heading?.title ?? client.displayName;
  const freq = profile?.frequency ?? "MONTHLY";
  const base = `/bookkeeping/${clientId}`;
  const work = workMonth(freq);
  const target = notOpened ?? (period ? { year: period.year, month: period.month } : work);
  const label = periodLabel(freq, target.year, target.month);
  const link = (id: string) => `/api/documents/${downloadToken(id, { staffId: user.id })}`;
  const thisYear = new Date().getFullYear();
  const years = Array.from({ length: 8 }, (_, i) => thisYear + 1 - i);
  const banking = await canViewBanking(user, clientId);
  const [wf, coetha, reqs, reg, tp, canSend, regAccounts, fiscal] = await Promise.all([
    monthlyChecklist(clientId, target.year, target.month),
    coethaCurrentWork(clientId),
    requestsFor(clientId),
    banking ? bankingRegistry(user, clientId) : Promise.resolve(null),
    taxProfile(clientId),
    canSendClientRequests(user, clientId),
    prisma.bookkeepingAccount.findMany({ where: { clientId, active: true }, orderBy: { institution: "asc" } }),
    prisma.client.findUniqueOrThrow({ where: { id: clientId }, select: { fiscalYearEnd: true } }),
  ]);
  const history = await Promise.all(ws.periods.slice(0, 6).map(async (p) => ({ p, c: await monthlyChecklist(clientId, p.year, p.month) })));
  const done = wf.items.filter((i) => i.state === "DONE");
  const missing = wf.items.filter((i) => i.state !== "DONE");
  const reports = summary?.reports ?? [];
  const waitingTabitha = reports.filter((d) => d.reviewStatus === "AWAITING_REVIEW");
  const files = period?.documents.filter((d) => !(d.category === "BOOKKEEPING" && d.reportType)) ?? [];
  const outstanding = [...reqs.drafts.filter((r) => r.kind !== "YEAR_END" && r.kind !== "HISTORICAL"), ...reqs.outstanding.filter((r) => r.status !== "DRAFT")];

  return (
    <div className="space-y-5" data-testid="bk-management">
      <p className="text-sm"><Link className="underline" href={base}>← Client Overview</Link></p>

      <section className="rounded-2xl bg-gradient-to-br from-navy-900 via-navy-950 to-navy-900 px-5 py-5 text-white ring-1 ring-gold-500/40 sm:px-7" data-testid="period-header">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-xs uppercase tracking-[0.2em] text-gold-300">Owner&apos;s Office · Bookkeeping</p>
            <h1 className="mt-1 font-serif text-2xl font-bold text-white">{biz} — {label}</h1>
            <p className="mt-1 text-sm text-navy-100">
              {profile ? `${FREQUENCIES[freq as keyof typeof FREQUENCIES]} bookkeeping` : "Not on the bookkeeping list yet"} · Assigned: {client.assignedTo?.name ?? "unassigned"}
              {profile?.payroll && ` · Payroll ${profile.payrollFrequency ? PAYROLL_FREQUENCIES[profile.payrollFrequency as keyof typeof PAYROLL_FREQUENCIES].toLowerCase() : ""}${profile.payrollProvider ? ` (${profile.payrollProvider})` : ""}`}
              {summary?.due.reports ? ` · Statements target ${fmtDate(summary.due.reports)}` : ""}
            </p>
            {summary && summary.overdue.length > 0 && <p className="mt-1 inline-block rounded-full bg-red-600 px-3 py-0.5 text-xs font-semibold text-white" data-testid="overdue">{summary.overdue.join(" · ")}</p>}
          </div>
          <form method="get" className="flex flex-wrap items-end gap-2 text-navy-900" data-testid="month-picker">
            <select className="input w-24" name="year" defaultValue={target.year} aria-label="Year">{years.map((y) => <option key={y} value={y}>{y}</option>)}</select>
            <select className="input w-32" name="month" defaultValue={target.month} aria-label="Month">{MONTHS.map((m, i) => <option key={m} value={i + 1}>{m}</option>)}</select>
            <button className="rounded-lg bg-white px-3 py-2 text-sm font-semibold" type="submit">Go</button>
          </form>
        </div>
        {notOpened && (
          <ActionForm action={openPeriodForClientAction.bind(null, clientId)} className="mt-3" data-testid="not-opened">
            <input type="hidden" name="year" value={notOpened.year} />
            <input type="hidden" name="month" value={notOpened.month} />
            <button type="submit" className={goldBtn}>Open {MONTHS[notOpened.month - 1]} {notOpened.year}</button>
          </ActionForm>
        )}
      </section>

      <section className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {/* Completion with green checks and red marks */}
        <div className={clsx(card, "p-4 sm:p-5")} data-testid="monthly-completion">
          <h2 className={h2}><ListChecks className="size-5 text-gold-600" aria-hidden /> Monthly completion</h2>
          <div className="mt-3 flex flex-wrap items-start gap-5">
            <Donut percent={wf.percent} />
            <div className="min-w-0 flex-1 space-y-3">
              <div>
                <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Complete ({done.length})</p>
                <ul className="mt-1 space-y-1">{done.map((i) => <li key={i.key} className="flex items-start gap-2 text-sm text-navy-900" data-item={i.key} data-state={i.state}><StateIcon state={i.state} /><span>{i.label}<span className="block text-xs text-slate-500">{i.detail}</span></span></li>)}</ul>
              </div>
              <div>
                <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Still open ({missing.length})</p>
                <ul className="mt-1 space-y-1">{missing.map((i) => <li key={i.key} className="flex items-start gap-2 text-sm text-navy-900" data-item={i.key} data-state={i.state}><StateIcon state={i.state} /><span>{i.label}<span className={clsx("block text-xs", i.state === "MISSING" ? "text-red-700" : "text-slate-500")}>{i.detail}</span></span></li>)}</ul>
              </div>
            </div>
          </div>
          <p className="mt-3 text-xs text-slate-500">Every line comes from the books, bank feeds, reconciliations and report review — nothing to check off. Year-end tax documents are tracked separately in the <Link className="underline" href={`${base}/year-end`}>W-2 / 1099 Center</Link>.</p>
        </div>

        {/* Accounts connected */}
        <div className={clsx(card, "p-4 sm:p-5")} data-testid="accounts-connected">
          <h2 className={h2}><Landmark className="size-5 text-gold-600" aria-hidden /> Accounts &amp; reconciliation</h2>
          {reg ? (
            <>
              <dl className="mt-3 grid grid-cols-3 gap-2 text-center">
                <div className="rounded-xl bg-ivory-50 px-2 py-2"><dt className="text-xs text-slate-600">Connected</dt><dd className="font-serif text-xl font-bold text-navy-900">{reg.connected}/{reg.rows.length}</dd></div>
                <div className="rounded-xl bg-ivory-50 px-2 py-2"><dt className="text-xs text-slate-600">Reconciled</dt><dd className="font-serif text-xl font-bold text-navy-900">{wf.recon.reconciled}/{wf.recon.total}</dd></div>
                <div className="rounded-xl bg-ivory-50 px-2 py-2"><dt className="text-xs text-slate-600">Last synced</dt><dd className="text-sm font-semibold text-navy-900">{reg.lastSync ? fmtDateTime(reg.lastSync) : "—"}</dd></div>
              </dl>
              <ul className="mt-3 divide-y divide-ivory-200 text-sm">
                {wf.recon.rows.slice(0, 8).map((r) => <li key={r.account.id} className="flex items-center justify-between gap-2 py-1.5"><span className="flex min-w-0 items-center gap-2"><Dot light={r.light} /><span className="truncate">{r.account.nickname || r.account.institution}{r.account.last4 ? ` ••${r.account.last4}` : ""}</span></span><span className="shrink-0 text-xs text-slate-600">{r.rec?.status === "APPROVED" ? "Approved" : r.rec?.differenceCents ? "Difference" : r.light === "GREEN" ? "Balanced" : r.light === "GRAY" ? "Not due" : r.rec?.statementStatus === "MISSING" ? "Statement missing" : "In progress"}</span></li>)}
              </ul>
              {wf.recon.rows.length > 8 && <p className="text-xs text-slate-500">+ {wf.recon.rows.length - 8} more</p>}
              <div className="mt-3 flex flex-wrap gap-2">
                <Link className={navyBtn} href={`${base}/banking/reconciliation?month=${target.year}-${String(target.month).padStart(2, "0")}`}>Monthly reconciliation</Link>
                <Link className={outlineBtn} href={`${base}/banking`}>Manage accounts</Link>
              </div>
            </>
          ) : <p className="mt-2 text-sm text-slate-600">Banking is visible to Admins, the assigned staff member and staff Tabitha allows.</p>}
        </div>
      </section>

      <section className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {/* Outstanding requests */}
        <div className={clsx(card, "p-4 sm:p-5")} data-testid="outstanding-requests">
          <h2 className={h2}><Inbox className="size-5 text-gold-600" aria-hidden /> Outstanding document requests <span className="rounded-full bg-navy-900 px-2.5 py-0.5 font-sans text-xs font-semibold text-gold-300">{outstanding.length}</span></h2>
          <RequestList items={outstanding.slice(0, 12)} clientId={clientId} canSend={canSend} empty="Nothing outstanding." />
          {period && (
            <details className="mt-2 text-sm">
              <summary className="cursor-pointer font-semibold text-navy-900 underline decoration-gold-500">Ask the client a question about {label}</summary>
              <ActionForm action={askQuestionAction.bind(null, clientId, period.id)} className="mt-2 grid gap-2" resetOnSuccess>
                <input className="input" name="subject" required placeholder="e.g. $1,240 deposit on October 4" aria-label="Subject" />
                <textarea className="input min-h-16" name="body" required aria-label="Question" />
                <div><button type="submit" className={outlineBtn}>Send to client portal</button></div>
              </ActionForm>
            </details>
          )}
        </div>

        {/* Coetha's current work */}
        <div className="rounded-2xl bg-gradient-to-br from-navy-900 to-navy-950 p-4 text-white ring-1 ring-gold-500/40 sm:p-5" data-testid="coetha-work">
          <h2 className="flex items-center gap-2 font-serif text-lg font-bold text-white sm:text-xl"><Sparkles className="size-5 text-gold-400" aria-hidden /> Coetha&apos;s current work</h2>
          <ul className="mt-3 space-y-1.5 text-sm text-navy-100">
            <li><strong className="text-white">{coetha.proposals.RECOMMENDATION ?? 0}</strong> findings &amp; recommendations for Tabitha{coetha.proposals.CLASSIFICATION ? ` · ${coetha.proposals.CLASSIFICATION} tax classification` : ""}</li>
            <li><strong className="text-white">{(coetha.proposals.CATEGORY ?? 0) + (coetha.proposals.ADJUSTING_ENTRY ?? 0)}</strong> draft categories and entries</li>
            <li><strong className="text-white">{coetha.drafts}</strong> draft requests waiting to be sent · <strong className="text-white">{coetha.outstanding}</strong> waiting on the client</li>
            <li><strong className="text-white">{coetha.recsWaiting}</strong> reconciliations ready for approval</li>
            <li className="text-xs">Last check: {coetha.lastCheck ? fmtDateTime(coetha.lastCheck) : "not yet"} · Tax classification: {tp.label ?? "not set"}</li>
          </ul>
          <div className="mt-3 flex flex-wrap gap-2">
            <ActionForm action={runMonitorAction.bind(null, clientId, target.year, target.month)} idempotent><button type="submit" className={goldBtn} data-testid="run-monitor"><Sparkles className="size-4" aria-hidden /> Check {MONTHS[target.month - 1]}</button></ActionForm>
            <Link className="inline-flex min-h-10 items-center rounded-lg border border-white/70 px-4 py-2 text-sm font-semibold text-white hover:bg-white/10" href={`${base}/coetha`}>Open Coetha&apos;s review</Link>
          </div>
        </div>
      </section>

      {/* Statements awaiting Tabitha */}
      <section className={clsx(card, "p-4 sm:p-5")} data-testid="statements-approval">
        <h2 className={h2}><BadgeCheck className="size-5 text-gold-600" aria-hidden /> Financial statements {waitingTabitha.length > 0 && <span className="rounded-full bg-gold-100 px-2.5 py-0.5 font-sans text-xs font-semibold text-gold-800">{waitingTabitha.length} awaiting Tabitha</span>}</h2>
        {!period ? <p className="mt-2 text-sm text-slate-600">Open the month to prepare statements.</p> : !reports.length ? <p className="mt-2 text-sm text-slate-600">No statements uploaded for {label} yet.</p> : (
          <ul className="mt-2 divide-y divide-ivory-200" data-testid="reports">
            {reports.map((d) => {
              const status = d.visibility === "PUBLISHED" ? "DELIVERED" : d.reviewStatus ?? "DRAFT";
              return (
                <li key={d.id} className="py-2.5" data-report={d.reportType}>
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <span className="min-w-0 text-sm">
                      <strong className="text-navy-900">{d.reportType ? REPORT_LABELS[d.reportType] : "Report"}</strong> <span className="text-xs text-slate-500">v{d.version ?? 1}</span> · {d.scanStatus === "CLEAN" ? <a className="underline" href={link(d.id)} target="_blank" rel="noopener">{d.title}</a> : d.title}
                      <span className="block text-xs text-slate-600">{PERIOD_TYPES[(d.reportPeriodType ?? "MONTH") as PeriodType]} · {reportCaption(d, period.year, period.month, fiscal.fiscalYearEnd)}</span>
                    </span>
                    <span className={clsx("rounded-full px-2.5 py-0.5 text-xs font-semibold", REVIEW_TONE[status])}>{status === "DELIVERED" ? "Released to client" : REVIEW_LABELS[status]}</span>
                  </div>
                  {d.reviewNote && d.reviewStatus === "CHANGES_REQUESTED" && <p className="mt-1 rounded-lg bg-red-50 px-3 py-1.5 text-sm text-red-900">Tabitha: {d.reviewNote}</p>}
                  <div className="mt-1.5 flex flex-wrap gap-2">
                    {(status === "DRAFT" || status === "CHANGES_REQUESTED") && d.scanStatus === "CLEAN" && <ActionForm action={reportStepAction.bind(null, clientId, d.id, "submit")}><button type="submit" className={outlineBtn}>Submit for Tabitha&apos;s approval</button></ActionForm>}
                    {status === "AWAITING_REVIEW" && approver && (
                      <>
                        <ActionForm action={reportStepAction.bind(null, clientId, d.id, "approve")}><button type="submit" className={navyBtn} data-testid="approve-report">Approve</button></ActionForm>
                        <ActionForm action={requestChangesAction.bind(null, clientId, d.id)} className="flex flex-wrap items-center gap-2">
                          <input className="input w-56 py-1.5" name="note" placeholder="What needs to change?" required aria-label="Changes needed" />
                          <button type="submit" className={outlineBtn}>Request changes</button>
                        </ActionForm>
                      </>
                    )}
                    {status === "AWAITING_REVIEW" && !approver && <span className="text-xs text-slate-600">Waiting for Tabitha.</span>}
                    {status === "APPROVED" && <ActionForm action={reportStepAction.bind(null, clientId, d.id, "deliver")} confirm="Release this approved statement to the client's portal and notify them?"><button type="submit" className={goldBtn}>Release to client</button></ActionForm>}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
        {period && reports.some((d) => d.reviewStatus === "APPROVED" && d.visibility !== "PUBLISHED") && (
          <ActionForm action={deliverApprovedAction.bind(null, clientId, period.id, null)} className="mt-2" confirm="Release every approved statement for this month to the client's portal?"><button type="submit" className={outlineBtn}>Release all approved</button></ActionForm>
        )}
        {period && <p className="mt-2 text-xs text-slate-600"><a className="underline" href={`/api/bookkeeping/packet?period=${period.id}&type=MONTH`} target="_blank" rel="noopener">Preview the month&apos;s packet PDF</a> · Statements are always drafts until Tabitha approves; nothing reaches the client before she does.</p>}
      </section>

      {/* The one upload path */}
      <section id="upload-financials" className={clsx(card, "scroll-mt-6 p-4 sm:p-5")} data-testid="upload">
        <h2 className={h2}><CloudUpload className="size-5 text-gold-600" aria-hidden /> Upload</h2>
        <ActionForm action={uploadMonthlyFinancialsAction.bind(null, clientId)} className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4" resetOnSuccess idempotent>
          <input type="hidden" name="year" value={target.year} />
          <input type="hidden" name="period" value={`M${target.month}`} />
          <input type="hidden" name="covers" value="PERIOD" />
          <label className="text-sm">Statement<select className="input mt-1" name="reportType" defaultValue="PROFIT_AND_LOSS">{Object.entries(REPORT_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
          <label className="text-sm">Basis<select className="input mt-1" name="basis" defaultValue={profile?.accountingBasis ?? ""}><option value="">{profile?.accountingBasis ? "—" : "Choose…"}</option>{Object.entries(BASIS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
          <label className="text-sm">Account (reconciliation)<select className="input mt-1" name="accountId" defaultValue=""><option value="">—</option>{regAccounts.map((a) => <option key={a.id} value={a.id}>{accountLabel(a)}</option>)}</select></label>
          <label className="text-sm">File (PDF, PNG or JPG)<input className="input mt-1" type="file" name="file" accept="application/pdf,image/png,image/jpeg" /></label>
          <div className="sm:col-span-2 lg:col-span-4"><button type="submit" className={navyBtn}>Upload statement for {label}</button> <span className="text-xs text-slate-600">Saved as a staff-only draft for Tabitha&apos;s approval.</span></div>
        </ActionForm>
        {period && (
          <details className="mt-3 text-sm">
            <summary className="cursor-pointer font-semibold text-navy-900 underline decoration-gold-500">File a document the client sent ({files.length} this month)</summary>
            <ActionForm action={uploadBookkeepingFileAction.bind(null, clientId, period.id)} className="mt-2 grid gap-2 sm:grid-cols-3" resetOnSuccess idempotent>
              <div className="sm:col-span-3"><BkUploadFields business={biz} typeName="kind" year={period.year} month={period.month} /></div>
              <input className="input sm:col-span-2" type="file" name="file" accept="application/pdf,image/png,image/jpeg" required aria-label="File" />
              <select className="input" name="accountId" defaultValue="" aria-label="Account"><option value="">Account (optional)</option>{regAccounts.map((a) => <option key={a.id} value={a.id}>{accountLabel(a)}</option>)}</select>
              <div><button type="submit" className={outlineBtn}>Upload</button></div>
            </ActionForm>
            <ul className="mt-2 divide-y divide-ivory-200">
              {files.map((d) => (
                <li key={d.id} className="flex flex-wrap items-center justify-between gap-2 py-1.5">
                  <span>{d.scanStatus === "CLEAN" ? <a className="underline" href={link(d.id)} target="_blank" rel="noopener">{d.title}</a> : d.title} <UploadMeta d={d} /></span>
                  {(!d.docType || !(d.docType in BK_DOC_TYPES)) && (
                    <ActionForm action={classifyDocumentAction.bind(null, clientId, d.id)} className="flex items-center gap-1" showSuccess={false}>
                      <select className="input w-auto text-xs" name="docType" defaultValue="" aria-label="Label as"><option value="" disabled>Label as…</option>{Object.entries(BK_DOC_TYPES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
                      <button type="submit" className={outlineBtn}>Save</button>
                    </ActionForm>
                  )}
                </li>
              ))}
            </ul>
          </details>
        )}
      </section>

      <section className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <div className={clsx(card, "p-4 sm:p-5")} data-testid="historical-summary">
          <h2 className={h2}><Archive className="size-5 text-gold-600" aria-hidden /> Historical statement requests</h2>
          <RequestList items={reqs.historical.slice(0, 5)} clientId={clientId} canSend={canSend} empty="None yet." />
          <Link className={clsx(outlineBtn, "mt-2")} href={`${base}/records`}>Historical Records &amp; Statements</Link>
        </div>
        <div className={clsx(card, "p-4 sm:p-5")} data-testid="progress-history">
          <h2 className={h2}><History className="size-5 text-gold-600" aria-hidden /> Monthly progress history</h2>
          {!history.length ? <p className="mt-2 text-sm text-slate-600">No months yet.</p> : (
            <ul className="mt-2 space-y-2">
              {history.map(({ p, c }) => (
                <li key={p.id}>
                  <Link href={`${base}/close?period=${p.id}`} className={clsx("block rounded-lg px-2 py-1.5 hover:bg-ivory-50", p.id === period?.id && "ring-1 ring-gold-400")}>
                    <span className="flex items-center justify-between text-sm"><span className="font-semibold text-navy-900">{periodLabel(freq, p.year, p.month)}</span><span className="text-navy-800">{c.percent}% · {c.recon.reconciled}/{c.recon.total} reconciled</span></span>
                    <span className="mt-1 block h-2 overflow-hidden rounded-full bg-ivory-200"><span className="block h-full rounded-full bg-gold-500" style={{ width: `${c.percent}%` }} /></span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>

      {/* Settings, kept out of the way */}
      <details className={clsx(card, "p-4 sm:p-5")} data-testid="settings">
        <summary className="flex cursor-pointer items-center gap-2 font-serif text-lg font-bold text-navy-900"><Settings className="size-5 text-gold-600" aria-hidden /> Settings — service, tax classification, Coetha link</summary>
        <div className="mt-3 grid gap-5 lg:grid-cols-2">
          <ActionForm action={saveBookkeepingProfileAction.bind(null, clientId)} className="grid gap-2 text-sm sm:grid-cols-2">
            <p className="font-semibold text-navy-900 sm:col-span-2">Service details</p>
            <label>Schedule<select className="input mt-1" name="frequency" defaultValue={freq}>{Object.entries(FREQUENCIES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
            {user.role === "ADMIN" ? (
              <label>Assigned staff<select className="input mt-1" name="assignedToId" defaultValue={client.assignedToId ?? "none"}><option value="none">Unassigned</option>{staff.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label>
            ) : <p className="text-xs text-slate-600">Assigned: {client.assignedTo?.name ?? "unassigned"}</p>}
            <label className="flex items-center gap-2"><input type="checkbox" name="payroll" defaultChecked={profile?.payroll} /> Runs payroll</label>
            <label>Payroll frequency<select className="input mt-1" name="payrollFrequency" defaultValue={profile?.payrollFrequency ?? ""}><option value="">—</option>{Object.entries(PAYROLL_FREQUENCIES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
            <label>Payroll provider<input className="input mt-1" name="payrollProvider" defaultValue={profile?.payrollProvider ?? ""} /></label>
            <label>Statements due (day of next month)<select className="input mt-1" name="reportsDueDay" defaultValue={profile?.reportsDueDay ?? ""}><option value="">Office default — the 15th</option>{Array.from({ length: 31 }, (_, i) => i + 1).map((d) => <option key={d} value={d}>{d === 31 ? "Last day" : `Day ${d}`}</option>)}</select></label>
            <label>Documents due<select className="input mt-1" name="documentsDueDay" defaultValue={profile?.documentsDueDay ?? ""}><option value="">No deadline</option>{Array.from({ length: 31 }, (_, i) => i + 1).map((d) => <option key={d} value={d}>{d === 31 ? "Last day" : `Day ${d}`}</option>)}</select></label>
            <label>Tabitha&apos;s review by<select className="input mt-1" name="reviewDueDay" defaultValue={profile?.reviewDueDay ?? ""}><option value="">Not scheduled</option>{Array.from({ length: 31 }, (_, i) => i + 1).map((d) => <option key={d} value={d}>{d === 31 ? "Last day" : `Day ${d}`}</option>)}</select></label>
            <label>Status<select className="input mt-1" name="active" defaultValue={String(profile?.active ?? true)}><option value="true">Active</option><option value="false">Paused</option></select></label>
            <label className="sm:col-span-2">Notes<textarea className="input mt-1" name="notes" rows={2} defaultValue={profile?.notes ?? ""} /></label>
            <div className="sm:col-span-2"><button type="submit" className={outlineBtn}>Save service details</button></div>
          </ActionForm>
          <div className="space-y-4">
            <div data-testid="tax-classification">
              <p className="flex items-center gap-2 text-sm font-semibold text-navy-900"><FileText className="size-4 text-gold-600" aria-hidden /> Business tax classification (internal)</p>
              <p className="text-sm text-navy-800">{tp.label ?? "Not set"}{tp.setAt ? ` · set ${fmtDate(tp.setAt)}` : ""}</p>
              {approver ? (
                <ActionForm action={taxClassificationAction.bind(null, clientId)} className="mt-2 grid gap-2 text-sm sm:grid-cols-2">
                  <label className="sm:col-span-2">Classification<select className="input mt-1" name="classification" defaultValue={tp.classification ?? ""} required><option value="" disabled>Choose…</option>{Object.entries(TAX_CLASSIFICATIONS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}</select></label>
                  <label>Accounting method<select className="input mt-1" name="basis" defaultValue={tp.basis === "ACCRUAL" ? "ACCRUAL" : "CASH"}><option value="CASH">Cash</option><option value="ACCRUAL">Accrual</option></select></label>
                  <label>Fiscal year ends<select className="input mt-1" name="fiscalYearEnd" defaultValue={tp.fiscalYearEnd}>{MONTHS.map((m, i) => <option key={m} value={i + 1}>{m}</option>)}</select></label>
                  <label>Tax year<input className="input mt-1" name="taxYear" inputMode="numeric" defaultValue={tp.taxYear ?? thisYear} /></label>
                  <div className="flex items-end"><button type="submit" className={navyBtn}>Save classification</button></div>
                </ActionForm>
              ) : <p className="text-xs text-slate-600">Only Tabitha sets or changes it. Coetha may recommend a change for her approval.</p>}
            </div>
            {approver && profile && (
              <div>
                <p className="text-sm font-semibold text-navy-900">Coetha&apos;s Claude Project link</p>
                <ActionForm action={coethaLinkAction.bind(null, clientId, false)} className="mt-1 flex flex-wrap gap-2">
                  <input className="input max-w-sm" name="url" type="url" placeholder="https://claude.ai/project/…" defaultValue={profile.coethaUrl ?? ""} aria-label="Claude Project link" />
                  <button type="submit" className={outlineBtn}>Save link</button>
                </ActionForm>
              </div>
            )}
          </div>
        </div>
      </details>
    </div>
  );
}
