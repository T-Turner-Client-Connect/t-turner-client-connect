import Link from "next/link";
import clsx from "clsx";
import { connection } from "next/server";
import { notFound } from "next/navigation";
import { BadgeCheck, CloudUpload, FileText, Settings } from "lucide-react";
import { ActionForm } from "@/components/action-form";
import { BkUploadFields, UploadMeta } from "@/components/bk-upload";
import { card, goldBtn, h2, navyBtn, outlineBtn } from "@/components/bk/parts";
import { requireUser } from "@/lib/auth/session";
import { prisma } from "@/lib/prisma";
import { recordHeading } from "@/lib/services/related-businesses";
import {
  classifyDocumentAction, coethaLinkAction, deliverApprovedAction, reportStepAction, requestChangesAction, saveBookkeepingProfileAction, uploadBookkeepingFileAction, uploadMonthlyFinancialsAction,
} from "@/app/actions/bookkeeping-clients";
import { releaseInterimAction, revokeInterimAction, taxClassificationAction } from "@/app/actions/bk-workflow";
import { clientInterimStatements } from "@/lib/services/client-statements";
import { BK_DOC_TYPES, bookkeepingWorkspace, FREQUENCIES, isReportApprover, PAYROLL_FREQUENCIES, periodLabel, reportCaption, REVIEW_LABELS, workMonth } from "@/lib/services/bookkeeping-clients";
import { BASIS, PERIOD_TYPES, type PeriodType } from "@/lib/bookkeeping-periods";
import { accountLabel } from "@/lib/services/bookkeeping-profile";
import { MONTHS } from "@/lib/services/bookkeeping";
import { downloadToken, REPORT_LABELS } from "@/lib/services/documents";
import { TAX_CLASSIFICATIONS, taxProfile } from "@/lib/services/tax-classification";
import { fmtDate } from "@/lib/format";

export const metadata = { title: "Statements & settings" };

const REVIEW_TONE: Record<string, string> = { DRAFT: "bg-slate-100 text-slate-700", AWAITING_REVIEW: "bg-gold-100 text-gold-800", CHANGES_REQUESTED: "bg-red-50 text-red-800", APPROVED: "bg-emerald-50 text-emerald-800", DELIVERED: "bg-emerald-600 text-white" };

/**
 * Financial statements for one business and month: Tabitha's approvals, release to the client,
 * interim statements, the statement upload, and the bookkeeping settings. Reached from the
 * bookkeeping dashboard ("View Draft", "Pending Approval").
 */
export default async function StatementsPage({ params, searchParams }: { params: Promise<{ clientId: string }>; searchParams: Promise<{ period?: string; year?: string; month?: string }> }) {
  await connection();
  const user = await requireUser();
  const { clientId } = await params;
  const sp = await searchParams;
  if (!(await prisma.client.count({ where: { id: clientId } }))) notFound();
  const picked = sp.year && sp.month ? await prisma.bookkeepingPeriod.findUnique({ where: { clientId_year_month: { clientId, year: Number(sp.year), month: Number(sp.month) } }, select: { id: true } }).catch(() => null) : null;
  const [ws, approver, staff] = await Promise.all([
    bookkeepingWorkspace(clientId, picked?.id ?? sp.period),
    isReportApprover(user),
    prisma.user.findMany({ where: { active: true }, select: { id: true, name: true }, orderBy: { name: "asc" } }),
  ]);
  const { client, profile, period, summary } = ws;
  const heading = await recordHeading(clientId);
  const biz = heading?.title ?? client.displayName;
  const freq = profile?.frequency ?? "MONTHLY";
  const base = `/bookkeeping/${clientId}`;
  const target = period ? { year: period.year, month: period.month } : workMonth(freq);
  const label = periodLabel(freq, target.year, target.month);
  const link = (id: string) => `/api/documents/${downloadToken(id, { staffId: user.id })}`;
  const thisYear = new Date().getFullYear();
  const [tp, regAccounts, fiscal, interims] = await Promise.all([
    taxProfile(clientId),
    prisma.bookkeepingAccount.findMany({ where: { clientId, active: true }, orderBy: { institution: "asc" } }),
    prisma.client.findUniqueOrThrow({ where: { id: clientId }, select: { fiscalYearEnd: true } }),
    clientInterimStatements(clientId),
  ]);
  const reports = summary?.reports ?? [];
  const waitingTabitha = reports.filter((d) => d.reviewStatus === "AWAITING_REVIEW");
  const files = period?.documents.filter((d) => !(d.category === "BOOKKEEPING" && d.reportType)) ?? [];

  return (
    <div className="space-y-5" data-testid="bk-statements">
      <p className="text-sm"><Link className="underline" href={`${base}/close${period ? `?period=${period.id}` : ""}`}>← Bookkeeping dashboard</Link></p>
      <section className="rounded-2xl bg-gradient-to-br from-navy-900 via-navy-950 to-navy-900 px-5 py-5 text-white ring-1 ring-gold-500/40 sm:px-7">
        <p className="text-xs uppercase tracking-[0.2em] text-gold-300">{biz}</p>
        <h1 className="mt-1 font-serif text-2xl font-bold text-white">Statements &amp; approvals — {label}</h1>
        <p className="mt-1 text-sm text-navy-100">Statements are drafts until Tabitha approves them; nothing reaches the client before she does. Interim statements for lenders are released here too.</p>
        {ws.periods.length > 0 && (
          <p className="mt-2 flex flex-wrap gap-2 text-xs">{ws.periods.slice(0, 8).map((p) => <Link key={p.id} href={`${base}/statements?period=${p.id}`} className={clsx("rounded-full px-3 py-1 font-semibold", p.id === period?.id ? "bg-gold-400 text-navy-950" : "bg-white/10 text-white")}>{periodLabel(freq, p.year, p.month)}</Link>)}</p>
        )}
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
        <div className="mt-3 rounded-xl border border-gold-300 bg-ivory-50 p-3" data-testid="interim">
          <p className="text-sm font-semibold text-navy-900">Interim financial statements (lender, financing)</p>
          <p className="text-xs text-slate-600">Released without closing the period. The client sees them labeled &ldquo;Interim — unaudited, prepared as of &lt;date&gt;&rdquo;, with no internal commentary.</p>
          {interims.length > 0 && <ul className="mt-1 space-y-1 text-sm">{interims.map((r) => <li key={r.id} className="flex flex-wrap items-center gap-2"><span>{r.purpose ?? "Interim"} · {r.label}</span>{approver && <ActionForm action={revokeInterimAction.bind(null, clientId, r.id)} confirm="Withdraw this interim statement from the client's portal?" showSuccess={false}><button type="submit" className="text-xs underline">Withdraw</button></ActionForm>}</li>)}</ul>}
          {approver ? (
            <ActionForm action={releaseInterimAction.bind(null, clientId)} className="mt-2 flex flex-wrap items-end gap-2 text-sm" resetOnSuccess confirm="Approve and release this interim statement to the client's portal?">
              <label>From<input className="input mt-1" type="date" name="from" required defaultValue={`${target.year}-01-01`} /></label>
              <label>As of<input className="input mt-1" type="date" name="asOf" required /></label>
              <label>Purpose (shown to the client)<input className="input mt-1" name="purpose" placeholder="e.g. For Pretend Community Bank" /></label>
              <button type="submit" className={navyBtn}>Approve &amp; release interim</button>
            </ActionForm>
          ) : <p className="mt-1 text-xs text-slate-600">Only Tabitha releases interim statements.</p>}
        </div>
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
