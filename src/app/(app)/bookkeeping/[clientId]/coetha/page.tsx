import Link from "next/link";
import clsx from "clsx";
import { connection } from "next/server";
import { notFound } from "next/navigation";
import { AlertTriangle, BookOpenCheck, CheckCircle2, FileText, History, KeyRound, Landmark, ListChecks, Lock, Power, ShieldCheck, Sparkles, Tags } from "lucide-react";
import { requireUser } from "@/lib/auth/session";
import { prisma } from "@/lib/prisma";
import { BusinessTabs } from "@/components/business-tabs";
import { ActionForm } from "@/components/action-form";
import { canUseLedger, officeMayWorkBooks, usd } from "@/lib/services/ledger";
import { taxProfile } from "@/lib/services/tax-classification";
import { coethaCurrentWork } from "@/lib/services/monthly-workflow";
import { RecommendationCard } from "@/components/bk/parts";
import { COETHA_NO_KEY, COETHA_PRIVACY, coethaView, KIND_LABEL } from "@/lib/services/coetha";
import { approveCoethaAction, approveJudgmentAction, approveMatchingAction, bulkCoethaAction, prepareFromRecordsAction, rejectCoethaAction, runCoethaAction, saveReferenceAction, undoFamilyAction } from "@/app/actions/coetha";
import { compareWithReference, familyPostingsToUndo, judgmentDraftIds, matchingDraftIds } from "@/lib/services/coetha-records";
import { fmtDateTime } from "@/lib/format";
import { canSetCoethaOptOut, coethaOptOutView } from "@/lib/services/coetha-opt-out";
import { CoethaOptOutPanel } from "@/components/bk/coetha-opt-out-panel";

export const metadata = { title: "Coetha AI" };

const card = "min-w-0 rounded-2xl border border-gold-200/80 bg-gradient-to-b from-white to-ivory-50 shadow-[0_14px_32px_-24px_rgb(10_26_68/0.45)]";
const goldBtn = "inline-flex min-h-10 items-center justify-center gap-2 rounded-lg bg-gradient-to-b from-gold-300 to-gold-500 px-4 py-2 text-sm font-semibold text-navy-950 shadow hover:to-gold-600 disabled:opacity-50";
const navyBtn = "inline-flex min-h-10 items-center justify-center gap-2 rounded-lg bg-navy-900 px-4 py-2 text-sm font-semibold text-white shadow hover:bg-navy-800";
const outlineBtn = "inline-flex min-h-10 items-center justify-center gap-2 rounded-lg border-[1.5px] border-navy-900 bg-white px-3 py-2 text-sm font-semibold text-navy-900 hover:bg-ivory-50";

const day = (d: string) => new Date(`${d}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
const pct = (c: number | null) => (c == null ? null : Math.round(c * 100));

function Confidence({ value }: { value: number | null }) {
  const p = pct(value);
  if (p == null) return null;
  const tone = p >= 85 ? "bg-emerald-50 text-emerald-800 ring-emerald-200" : p >= 60 ? "bg-gold-100 text-gold-800 ring-gold-300" : "bg-red-50 text-red-800 ring-red-200";
  return <span className={clsx("inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-bold ring-1", tone)} title="Coetha's confidence">{p}% confident</span>;
}

const SEVERITY: Record<string, string> = { HIGH: "bg-red-600 text-white", MEDIUM: "bg-gold-100 text-gold-800", LOW: "bg-navy-50 text-navy-800" };
const DISC_LABEL: Record<string, string> = { POSSIBLE_DUPLICATE: "Possible duplicate", MISSING_STATEMENT: "Missing statement", UNRECONCILED_DIFFERENCE: "Unreconciled difference", OWNER_DRAW_VS_EXPENSE: "Owner draw vs. expense", UNUSUAL_AMOUNT: "Unusual amount", OTHER: "Other" };
const STATUS_PILL: Record<string, string> = { APPROVED: "bg-emerald-50 text-emerald-800", REJECTED: "bg-red-50 text-red-800", OK: "bg-emerald-50 text-emerald-800", FAILED: "bg-red-50 text-red-800", RUNNING: "bg-gold-100 text-gold-800" };

function SectionTitle({ icon: Icon, title, count, testId }: { icon: typeof Tags; title: string; count: number; testId?: string }) {
  return (
    <h2 className="flex flex-wrap items-center gap-2 font-serif text-xl font-bold text-navy-900" data-testid={testId}>
      <Icon className="size-6 text-gold-600" aria-hidden /> {title}
      <span className="rounded-full bg-navy-900 px-2.5 py-0.5 font-sans text-xs font-semibold text-gold-300">{count}</span>
    </h2>
  );
}

export default async function CoethaPage({ params }: { params: Promise<{ clientId: string }> }) {
  await connection();
  const user = await requireUser();
  const { clientId } = await params;
  const client = await prisma.client.findUnique({ where: { id: clientId }, select: { id: true, displayName: true, businessName: true, businessAccess: true } });
  if (!client) notFound();
  const biz = client.businessName || client.displayName;
  const base = `/bookkeeping/${clientId}`;

  if (!(await canUseLedger(user, clientId))) {
    return (
      <>
        <p className="mb-2 text-sm"><Link className="underline" href={base}>← Client Overview</Link></p>
        <div className={clsx(card, "p-6 text-navy-900")} data-testid="coetha-no-access">Only Admins and the staff member assigned to {biz} can see Coetha&apos;s work for this business.</div>
      </>
    );
  }

  const v = await coethaView(user, clientId);
  const [cmp, matching, judgmentIds, familyUndo] = v.book ? await Promise.all([compareWithReference(user, clientId), matchingDraftIds(clientId), judgmentDraftIds(clientId), familyPostingsToUndo(clientId)]) : [null, [] as string[], [] as string[], [] as { entryId: string }[]];
  const judgment = judgmentIds.length;
  const byKind = (k: keyof typeof KIND_LABEL) => v.open.filter((p) => p.kind === k);
  const cats = byKind("CATEGORY");
  const discs = byKind("DISCREPANCY");
  const adjs = byKind("ADJUSTING_ENTRY");
  const sums = byKind("MONTH_SUMMARY");
  const acctLabel = new Map(v.accounts.map((a) => [a.id, `${a.code} · ${a.name}`]));
  // Transactions a discrepancy refers to (this client's only).
  const refIds = [...new Set(discs.flatMap((d) => ((d.payload.bankTransactionIds as string[] | undefined) ?? [])))];
  const refRows = refIds.length ? await prisma.bankTransaction.findMany({ where: { clientId, id: { in: refIds } }, select: { id: true, date: true, amountCents: true, description: true, status: true } }) : [];
  const refById = new Map(refRows.map((r) => [r.id, r]));
  const lastRun = v.runs[0];
  // Office work: any Bookkeeping Client (client portal access is a separate matter).
  const office = await officeMayWorkBooks(clientId);
  const [optOut, canSetOptOut] = await Promise.all([coethaOptOutView(clientId), canSetCoethaOptOut(user, clientId)]);
  const canRun = v.status.ready && !!v.book && office && !optOut;
  const recs = byKind("RECOMMENDATION");
  const classes = byKind("CLASSIFICATION");
  const tp = await taxProfile(clientId);
  const work = await coethaCurrentWork(clientId);
  const BULK = "coetha-bulk";

  return (
    <div className="space-y-5" data-testid="coetha-page">
      <p className="text-sm"><Link className="underline" href={base}>← Client Overview</Link></p>
      <BusinessTabs clientId={clientId} base="/bookkeeping" isAdmin={user.role === "ADMIN"} />

      {/* Banner */}
      <section className="relative overflow-hidden rounded-2xl bg-gradient-to-br from-navy-900 via-navy-950 to-navy-900 px-5 py-6 text-white ring-1 ring-gold-500/40 sm:px-8" data-testid="coetha-banner">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="flex min-w-0 items-start gap-4">
            <span className="mt-1 flex size-12 shrink-0 items-center justify-center rounded-lg border-2 border-gold-400 sm:size-14"><Sparkles className="size-7 text-gold-400 sm:size-8" aria-hidden /></span>
            <div className="min-w-0">
              <h1 className="font-serif text-2xl font-bold leading-tight text-white sm:text-3xl">Coetha <span className="text-gold-400">|</span> Senior Accountant</h1>
              <p className="mt-1 border-t border-gold-500/40 pt-1 text-base text-navy-100" data-testid="coetha-client">Client: <strong className="text-white">{biz}</strong></p>
              <p className="mt-2 flex flex-wrap items-center gap-2 text-sm text-navy-100">
                {v.status.enabled ? <span className="rounded-full bg-emerald-500 px-3 py-0.5 font-semibold text-white" data-testid="coetha-on">Coetha AI on</span> : <span className="rounded-full bg-amber-400 px-3 py-0.5 font-semibold text-navy-950" data-testid="coetha-off">Coetha AI off</span>}
                <span className="rounded-full bg-white/10 px-3 py-0.5">Drafts only · Tabitha approves</span>
                {lastRun && <span>Last run {fmtDateTime(lastRun.startedAt)}</span>}
              </p>
            </div>
          </div>
          {canRun ? (
            <ActionForm action={runCoethaAction.bind(null, clientId)} className="w-full sm:w-auto" idempotent>
              <button type="submit" className={clsx(goldBtn, "w-full px-6 py-3 text-base sm:w-auto")} data-testid="coetha-run"><Sparkles className="size-5" aria-hidden /> Run Coetha</button>
            </ActionForm>
          ) : null}
        </div>
      </section>

      {/* "Client prefers no Coetha" */}
      <CoethaOptOutPanel clientId={clientId} optOut={optOut} canSet={canSetOptOut} />

      {/* Why Coetha can't run yet */}
      {!v.status.enabled && (
        <div className={clsx(card, "flex items-start gap-3 p-4 text-sm text-navy-900")} data-testid="coetha-switch-off">
          <Power className="mt-0.5 size-5 shrink-0 text-gold-600" aria-hidden />
          <p><strong>Coetha AI is turned off.</strong> Tabitha turns it on in the <Link className="font-semibold underline" href="/owner/automation">Owner&apos;s Office → Coetha &amp; bank feeds</Link>. The rest of the books work as usual.</p>
        </div>
      )}
      {!v.status.keyPresent && (
        <div className="flex items-start gap-3 rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900" role="status" data-testid="coetha-no-key">
          <KeyRound className="mt-0.5 size-5 shrink-0" aria-hidden />
          <p><strong>{COETHA_NO_KEY}</strong> Everything else in Client Connect keeps working without it.</p>
        </div>
      )}
      {!v.book && <div className={clsx(card, "p-4 text-sm text-navy-900")}>Set up this business&apos;s books first in <Link className="font-semibold underline" href={`${base}/books`}>Books &amp; Ledger</Link>.</div>}
      {!office && <div className={clsx(card, "p-4 text-sm text-navy-900")}>Coetha works on Bookkeeping Clients. Add {biz} to the Bookkeeping Client list first.</div>}

      {/* Prepare from the business's completed financial statements */}
      {v.book && office && !optOut && (
        <section className={clsx(card, "p-4 sm:p-5")} data-testid="coetha-records">
          <h2 className="flex items-center gap-2 font-serif text-lg font-bold text-navy-900"><BookOpenCheck className="size-5 text-gold-600" aria-hidden /> Prepare the books from completed statements</h2>
          <p className="mt-1 text-sm text-navy-800">Coetha reads the completed financial statements, matches every recurring vendor in the bank activity to the line it was booked to (to the cent, month by month), and drafts a category for every waiting transaction, including later months. Uncertain treatments are flagged for you. Nothing posts until it&apos;s approved.</p>
          {cmp ? (
            <p className="mt-2 text-sm text-navy-900" data-testid="records-on-file"><FileText className="mr-1 inline size-4 text-gold-600" aria-hidden />On file: <strong>{cmp.title}</strong> ({cmp.months[0]?.month} to {cmp.months[cmp.months.length - 1]?.month}), added {fmtDateTime(cmp.createdAt)}.</p>
          ) : null}
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <ActionForm action={saveReferenceAction.bind(null, clientId)} className="flex flex-wrap items-center gap-2" resetOnSuccess idempotent>
              <input className="input max-w-72" type="file" name="file" accept="application/pdf" required aria-label="Completed financial statements PDF" />
              <span className="w-full text-xs text-slate-600">The completed financial statements package with the monthly Profit &amp; Loss (not a bank statement).</span>
              <button type="submit" className={goldBtn} data-testid="records-upload"><Sparkles className="size-4" aria-hidden /> {cmp ? "Replace statements and prepare" : "Add statements and prepare"}</button>
            </ActionForm>
            {cmp && (
              <ActionForm action={prepareFromRecordsAction.bind(null, clientId)} idempotent>
                <button type="submit" className={outlineBtn} data-testid="records-prepare">Prepare again</button>
              </ActionForm>
            )}
          </div>
          {v.canApprove && matching.length > 0 && (
            <ActionForm action={approveMatchingAction.bind(null, clientId)} className="mt-3 flex flex-wrap items-center gap-3 rounded-xl bg-emerald-50 p-3 text-sm text-emerald-900 ring-1 ring-emerald-200" confirm={`Approve and post all ${matching.length} transactions that match the completed statements? The ones that need your judgment are not included.`}>
              <span className="mr-auto"><strong>{matching.length}</strong> drafts match the completed statements.{judgment ? ` ${judgment} more need your judgment (below, marked “Needs your judgment”).` : ""}</span>
              <button type="submit" className={navyBtn} data-testid="records-approve-all">Approve all {matching.length}</button>
            </ActionForm>
          )}
          {v.canApprove && judgment > 0 && (
            <ActionForm action={approveJudgmentAction.bind(null, clientId)} className="mt-3 flex flex-wrap items-center gap-3 rounded-xl bg-amber-50 p-3 text-sm text-amber-950 ring-1 ring-amber-200" confirm={`Approve and post all ${judgment} judgment items exactly as the completed statements treated them (owner draws, card payments, unidentified checks, unclassified items)? You can still reclassify any of them later with an adjusting entry.`}>
              <span className="mr-auto"><strong>{judgment}</strong> need your judgment. Each is drafted the way the completed statements treated it. Review them in the list below, or approve them all as the statements treated them.</span>
              <button type="submit" className={outlineBtn} data-testid="records-approve-judgment">Approve the {judgment} as the statements treated them</button>
            </ActionForm>
          )}
          {v.canApprove && familyUndo.length > 0 && (
            <ActionForm action={undoFamilyAction.bind(null, clientId)} className="mt-3 flex flex-wrap items-center gap-3 rounded-xl bg-red-50 p-3 text-sm text-red-900 ring-1 ring-red-200" confirm={`Reverse these ${familyUndo.length} postings and prepare them again?`}>
              <span className="mr-auto"><strong>Correction:</strong> {familyUndo.length} transaction{familyUndo.length === 1 ? " was" : "s were"} posted by a “same vendor family” shortcut inside the statement months (that shortcut now only applies to later months). Reverse {familyUndo.length === 1 ? "it" : "them"} so Coetha prepares {familyUndo.length === 1 ? "it" : "them"} again correctly.</span>
              <button type="submit" className={outlineBtn} data-testid="records-undo-family">Reverse and prepare again</button>
            </ActionForm>
          )}
          {cmp && cmp.rows.some((r) => r.books) && (
            <div className="mt-4 overflow-x-auto" data-testid="records-compare">
              <p className="mb-1 text-sm font-semibold text-navy-900">Books compared with the completed statements, month by month</p>
              <table className="w-full min-w-[640px] text-xs">
                <thead><tr className="text-left text-slate-600"><th className="py-1 pr-2">Line</th>{cmp.months.map((m) => <th key={m.month} className="px-1 text-right">{m.month.slice(5)}/{m.month.slice(2, 4)}</th>)}</tr></thead>
                <tbody>
                  {cmp.rows.filter((r) => r.books).map((r) => (
                    <tr key={r.label} className="border-t border-ivory-200">
                      <td className="py-1 pr-2 text-navy-900">{r.label}{r.needsJudgment ? <span className="ml-1 rounded bg-amber-100 px-1 text-[10px] text-amber-900">judgment</span> : null}</td>
                      {r.books!.map((b, k) => <td key={k} className={clsx("px-1 text-right tabular-nums", b === r.statements[k] ? "text-emerald-700" : "font-semibold text-red-700")} title={`Statements ${usd(r.statements[k])} · Books ${usd(b)}`}>{b === r.statements[k] ? "✓" : usd(b - r.statements[k])}</td>)}
                    </tr>
                  ))}
                  <tr className="border-t-2 border-navy-200 font-semibold"><td className="py-1 pr-2 text-navy-900">Net income</td>{cmp.months.map((m) => <td key={m.month} className={clsx("px-1 text-right", m.agrees ? "text-emerald-700" : "text-red-700")}>{m.agrees ? "✓" : usd(m.booksNet - m.statementsNet)}</td>)}</tr>
                </tbody>
              </table>
              <p className="mt-1 text-[11px] text-slate-600">✓ = the books equal the statements to the cent. An amount is the difference (books minus statements) still to post or review.</p>
            </div>
          )}
        </section>
      )}

      {/* Figures */}
      <section className="grid grid-cols-2 gap-3 lg:grid-cols-4" aria-label="Coetha at a glance">
        {[
          { icon: Tags, label: "Open drafts", value: String(v.open.length), testId: "kpi-open" },
          { icon: Landmark, label: "Bank rows to review", value: String(v.unreviewed), testId: "kpi-unreviewed" },
          { icon: CheckCircle2, label: "Approved (last 30)", value: String(v.decided.filter((d) => d.status === "APPROVED").length), testId: "kpi-approved" },
          { icon: History, label: "Runs", value: String(v.runs.length), testId: "kpi-runs" },
        ].map(({ icon: Icon, label, value, testId }) => (
          <div key={label} className={clsx(card, "flex items-center gap-3 px-4 py-3")} data-testid={testId}>
            <Icon className="size-8 shrink-0 text-gold-600" aria-hidden />
            <div className="min-w-0"><p className="text-xs font-medium text-navy-800 sm:text-sm">{label}</p><p className="font-serif text-xl font-bold text-navy-900">{value}</p></div>
          </div>
        ))}
      </section>

      {/* Who approves */}
      <div className="flex items-start gap-3 rounded-2xl bg-navy-50 p-4 text-sm text-navy-900 ring-1 ring-navy-100" data-testid="coetha-approver-note">
        {v.canApprove ? <ShieldCheck className="mt-0.5 size-5 shrink-0 text-emerald-700" aria-hidden /> : <Lock className="mt-0.5 size-5 shrink-0 text-gold-600" aria-hidden />}
        <p>
          {v.canApprove
            ? "You approve Coetha's work. Approving a category or adjusting entry posts it to the books through the ledger's normal rules; rejecting posts nothing. Every decision is recorded."
            : "Coetha's drafts wait for Tabitha. Only Tabitha can approve or reject them. You can keep doing the books as usual; a transaction you post yourself simply retires Coetha's draft for it."}
        </p>
      </div>

      {v.canApprove && cats.length > 0 && (
        <ActionForm id={BULK} action={bulkCoethaAction.bind(null, clientId)} className={clsx(card, "flex flex-wrap items-center gap-2 p-3 text-sm")}>
          <span className="mr-auto font-semibold text-navy-900">Selected category recommendations:</span>
          <button type="submit" name="decision" value="APPROVE" className={navyBtn} data-testid="bulk-approve">Approve selected</button>
          <button type="submit" name="decision" value="REJECT" className={outlineBtn} data-testid="bulk-reject">Reject selected</button>
          <span className="w-full text-xs text-slate-600">Bulk approval uses Coetha&apos;s recommended account. To change a category first, use that row&apos;s own Approve.</span>
        </ActionForm>
      )}

      {/* Findings & recommendations (rules-based monitor and AI runs), each with full rationale */}
      <section className={clsx(card, "p-4 sm:p-5")} data-testid="kind-RECOMMENDATION">
        <SectionTitle icon={AlertTriangle} title={KIND_LABEL.RECOMMENDATION} count={recs.length} />
        <p className="mt-1 text-sm text-navy-800">Tax classification: <strong>{tp.label ?? "Not set"}</strong>{tp.basis ? ` · ${tp.basis === "ACCRUAL" ? "Accrual" : "Cash"} basis` : ""} · Fiscal year ends month {tp.fiscalYearEnd}{tp.taxYear ? ` · Tax year ${tp.taxYear}` : ""}. Coetha applies its equity and compensation rules; she can only recommend a change.</p>
        <p className="mt-1 text-xs text-slate-600">Internal only — never shown to the client. {work.drafts} draft request{work.drafts === 1 ? "" : "s"} · {work.outstanding} sent and waiting · {work.recsWaiting} reconciliation{work.recsWaiting === 1 ? "" : "s"} awaiting approval · <Link className="underline" href={base}>Bookkeeping management</Link></p>
        {recs.length + classes.length === 0 ? <p className="mt-2 text-sm text-slate-600">No open findings.</p> : (
          <ul className="mt-3 space-y-3">
            {[...classes, ...recs].map((p) => <RecommendationCard key={p.id} p={p} clientId={clientId} canApprove={v.canApprove} booksHref={`${base}/books?tab=bank`} />)}
          </ul>
        )}
      </section>

      {/* Category recommendations */}
      <section className={clsx(card, "p-4 sm:p-5")} data-testid="kind-CATEGORY">
        <SectionTitle icon={Tags} title={KIND_LABEL.CATEGORY} count={cats.length} />
        {cats.length === 0 ? <p className="mt-2 text-sm text-slate-600">No open recommendations.</p> : (
          <ul className="mt-3 divide-y divide-ivory-200">
            {cats.map((p) => {
              const d = p.payload as { date: string; amountCents: number; description: string; bankAccountName: string; accountId: string; accountCode: string; accountName: string };
              return (
                <li key={p.id} className="grid gap-3 py-3 lg:grid-cols-[1fr_auto] lg:items-center" data-testid="proposal" data-kind="CATEGORY">
                  <div className="flex min-w-0 gap-3">
                    {v.canApprove && <input type="checkbox" name="ids" value={p.id} form={BULK} className="mt-1 size-5 shrink-0 accent-navy-900" aria-label={`Select ${d.description}`} />}
                    <div className="min-w-0">
                      <p className="flex flex-wrap items-baseline gap-x-2 text-[15px] text-navy-900">
                        <span className="font-semibold">{d.description}</span>
                        <span className={clsx("font-semibold tabular-nums", d.amountCents < 0 ? "text-red-700" : "text-emerald-700")}>{usd(d.amountCents)}</span>
                      </p>
                      <p className="text-xs text-slate-600">{day(d.date)} · {d.bankAccountName}</p>
                      <p className="mt-1 flex flex-wrap items-center gap-2 text-sm">
                        <span className="rounded-md bg-navy-900 px-2 py-0.5 font-semibold text-gold-300">→ {d.accountCode} · {d.accountName}</span>
                        <Confidence value={p.confidence} />
                      </p>
                      <p className="mt-1 text-sm text-navy-800">{p.reason}</p>
                    </div>
                  </div>
                  {v.canApprove ? (
                    <div className="flex flex-wrap items-start gap-2 lg:justify-end">
                      <ActionForm action={approveCoethaAction.bind(null, clientId, p.id)} className="flex flex-wrap gap-2" showSuccess={false}>
                        <select name="accountId" defaultValue={d.accountId} className="input max-w-full py-1.5 text-sm sm:w-56" aria-label="Category to post to">
                          {v.accounts.map((a) => <option key={a.id} value={a.id}>{a.code} · {a.name}</option>)}
                        </select>
                        <button type="submit" className={navyBtn} data-testid="approve">Approve</button>
                      </ActionForm>
                      <ActionForm action={rejectCoethaAction.bind(null, clientId, p.id)} showSuccess={false}>
                        <button type="submit" className={outlineBtn} data-testid="reject">Reject</button>
                      </ActionForm>
                    </div>
                  ) : (
                    <span className="justify-self-start rounded-full bg-gold-100 px-3 py-1 text-xs font-semibold text-gold-800 lg:justify-self-end" data-testid="awaiting-tabitha">Awaiting Tabitha</span>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <div className="grid gap-5 xl:grid-cols-2">
        {/* Discrepancies */}
        <section className={clsx(card, "p-4 sm:p-5")} data-testid="kind-DISCREPANCY">
          <SectionTitle icon={AlertTriangle} title={KIND_LABEL.DISCREPANCY} count={discs.length} />
          {discs.length === 0 ? <p className="mt-2 text-sm text-slate-600">Nothing flagged.</p> : (
            <ul className="mt-3 space-y-3">
              {discs.map((p) => {
                const d = p.payload as { type: string; severity: string; title: string; detail: string; bankTransactionIds?: string[] };
                return (
                  <li key={p.id} className="rounded-xl border border-ivory-200 bg-white p-3" data-testid="proposal" data-kind="DISCREPANCY">
                    <p className="flex flex-wrap items-center gap-2">
                      <span className={clsx("rounded-full px-2.5 py-0.5 text-xs font-bold", SEVERITY[d.severity] ?? SEVERITY.LOW)}>{d.severity === "HIGH" ? "High" : d.severity === "MEDIUM" ? "Medium" : "Low"}</span>
                      <span className="text-xs font-semibold uppercase tracking-wide text-gold-700">{DISC_LABEL[d.type] ?? d.type}</span>
                    </p>
                    <p className="mt-1 font-semibold text-navy-900">{d.title}</p>
                    <p className="text-sm text-navy-800">{d.detail}</p>
                    {(d.bankTransactionIds ?? []).length > 0 && (
                      <ul className="mt-2 space-y-0.5 rounded-lg bg-ivory-100 px-3 py-2 text-xs text-navy-800">
                        {(d.bankTransactionIds ?? []).map((id) => refById.get(id)).filter((r) => !!r).map((r) => (
                          <li key={r!.id}>{day(r!.date.toISOString().slice(0, 10))} · {r!.description} · <span className="tabular-nums">{usd(r!.amountCents)}</span> <span className="text-slate-500">({r!.status.toLowerCase()})</span></li>
                        ))}
                      </ul>
                    )}
                    {v.canApprove && (
                      <div className="mt-2 flex flex-wrap gap-2">
                        <ActionForm action={approveCoethaAction.bind(null, clientId, p.id)} showSuccess={false}><button type="submit" className={navyBtn} data-testid="approve">Acknowledge</button></ActionForm>
                        <ActionForm action={rejectCoethaAction.bind(null, clientId, p.id)} showSuccess={false}><button type="submit" className={outlineBtn} data-testid="reject">Dismiss</button></ActionForm>
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        {/* Adjusting entries */}
        <section className={clsx(card, "p-4 sm:p-5")} data-testid="kind-ADJUSTING_ENTRY">
          <SectionTitle icon={BookOpenCheck} title={KIND_LABEL.ADJUSTING_ENTRY} count={adjs.length} />
          {adjs.length === 0 ? <p className="mt-2 text-sm text-slate-600">No adjusting entries proposed.</p> : (
            <ul className="mt-3 space-y-3">
              {adjs.map((p) => {
                const d = p.payload as { date: string; memo: string; totalCents: number; lines: { accountId: string; debitCents: number; creditCents: number; description: string }[] };
                return (
                  <li key={p.id} className="rounded-xl border border-ivory-200 bg-white p-3" data-testid="proposal" data-kind="ADJUSTING_ENTRY">
                    <p className="flex flex-wrap items-center gap-2"><span className="font-semibold text-navy-900">{d.memo}</span><Confidence value={p.confidence} /></p>
                    <p className="text-xs text-slate-600">{day(d.date)} · {usd(d.totalCents)}</p>
                    <div className="mt-2 overflow-x-auto">
                      <table className="w-full min-w-[18rem] text-sm">
                        <thead><tr className="text-left text-xs text-slate-600"><th className="py-1 pr-2 font-medium">Account</th><th className="py-1 pr-2 text-right font-medium">Debit</th><th className="py-1 text-right font-medium">Credit</th></tr></thead>
                        <tbody>
                          {d.lines.map((l, i) => (
                            <tr key={i} className="border-t border-ivory-200"><td className="py-1 pr-2">{acctLabel.get(l.accountId) ?? "Inactive account"}</td><td className="py-1 pr-2 text-right tabular-nums">{l.debitCents ? usd(l.debitCents) : ""}</td><td className="py-1 text-right tabular-nums">{l.creditCents ? usd(l.creditCents) : ""}</td></tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                    <p className="mt-2 text-sm text-navy-800">{p.reason}</p>
                    {v.canApprove && (
                      <div className="mt-2 flex flex-wrap gap-2">
                        <ActionForm action={approveCoethaAction.bind(null, clientId, p.id)} confirm="Post this adjusting entry to the books?" showSuccess={false}><button type="submit" className={navyBtn} data-testid="approve">Approve &amp; post</button></ActionForm>
                        <ActionForm action={rejectCoethaAction.bind(null, clientId, p.id)} showSuccess={false}><button type="submit" className={outlineBtn} data-testid="reject">Reject</button></ActionForm>
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      </div>

      {/* Month summary */}
      <section className={clsx(card, "p-4 sm:p-5")} data-testid="kind-MONTH_SUMMARY">
        <SectionTitle icon={FileText} title={KIND_LABEL.MONTH_SUMMARY} count={sums.length} />
        {sums.length === 0 ? <p className="mt-2 text-sm text-slate-600">No draft summary yet.</p> : sums.map((p) => {
          const d = p.payload as { month: string; summary: string; highlights: string[] };
          return (
            <div key={p.id} className="mt-3 rounded-xl bg-navy-900 p-4 text-white" data-testid="proposal" data-kind="MONTH_SUMMARY">
              <p className="text-xs font-semibold uppercase tracking-wide text-gold-300">{new Date(`${d.month}-15T12:00:00Z`).toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" })} · draft</p>
              <p className="mt-2 rounded-lg bg-white px-4 py-3 text-[15px] leading-snug text-navy-900">{d.summary}</p>
              {d.highlights.length > 0 && <ul className="mt-2 list-disc space-y-0.5 pl-5 text-sm text-navy-100">{d.highlights.map((h, i) => <li key={i}>{h}</li>)}</ul>}
              {v.canApprove && (
                <div className="mt-3 flex flex-wrap gap-2">
                  <ActionForm action={approveCoethaAction.bind(null, clientId, p.id)} showSuccess={false}><button type="submit" className={goldBtn} data-testid="approve">Accept summary</button></ActionForm>
                  <ActionForm action={rejectCoethaAction.bind(null, clientId, p.id)} showSuccess={false}><button type="submit" className="inline-flex min-h-10 items-center justify-center rounded-lg border border-white/70 px-3 py-2 text-sm font-semibold text-white hover:bg-white/10" data-testid="reject">Reject</button></ActionForm>
                </div>
              )}
            </div>
          );
        })}
      </section>

      <div className="grid gap-5 xl:grid-cols-2">
        {/* Decisions */}
        <section className={clsx(card, "p-4 sm:p-5")} data-testid="coetha-decided">
          <SectionTitle icon={ListChecks} title="Tabitha's decisions" count={v.decided.length} />
          {v.decided.length === 0 ? <p className="mt-2 text-sm text-slate-600">None yet.</p> : (
            <ul className="mt-3 divide-y divide-ivory-200 text-sm">
              {v.decided.map((p) => (
                <li key={p.id} className="flex flex-wrap items-center gap-2 py-2">
                  <span className={clsx("rounded-full px-2.5 py-0.5 text-xs font-bold", STATUS_PILL[p.status])}>{p.status === "APPROVED" ? "Approved" : "Rejected"}</span>
                  <span className="min-w-0 basis-full text-navy-900 sm:basis-auto sm:flex-1">{KIND_LABEL[p.kind as keyof typeof KIND_LABEL]}: {String(p.payload.description ?? p.payload.title ?? p.payload.memo ?? p.payload.month ?? "")}{p.approvedAccountId && p.approvedAccountId !== p.payload.accountId ? <span className="text-gold-700"> (category changed to {acctLabel.get(p.approvedAccountId) ?? "another account"})</span> : null}</span>
                  <span className="text-xs text-slate-600">{p.decidedByName} · {p.decidedAt ? fmtDateTime(p.decidedAt) : ""}</span>
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* Runs */}
        <section className={clsx(card, "p-4 sm:p-5")} data-testid="coetha-runs">
          <SectionTitle icon={History} title="Run history" count={v.runs.length} />
          {v.runs.length === 0 ? <p className="mt-2 text-sm text-slate-600">Coetha hasn&apos;t run for this business yet.</p> : (
            <div className="mt-3 overflow-x-auto">
              <table className="w-full min-w-[30rem] text-sm">
                <thead><tr className="text-left text-xs text-slate-600"><th className="py-1 pr-2 font-medium">When</th><th className="py-1 pr-2 font-medium">By</th><th className="py-1 pr-2 font-medium">Result</th><th className="py-1 pr-2 text-right font-medium">Rows</th><th className="py-1 pr-2 text-right font-medium">Drafts</th><th className="py-1 text-right font-medium">Tokens in/out</th></tr></thead>
                <tbody>
                  {v.runs.map((r) => (
                    <tr key={r.id} className="border-t border-ivory-200 align-top">
                      <td className="py-1.5 pr-2 whitespace-nowrap">{fmtDateTime(r.startedAt)}</td>
                      <td className="py-1.5 pr-2">{r.startedByName}</td>
                      <td className="py-1.5 pr-2"><span className={clsx("rounded-full px-2 py-0.5 text-xs font-bold", STATUS_PILL[r.status])}>{r.status === "OK" ? "Done" : r.status === "FAILED" ? "Failed" : "Running"}</span>{r.error && <span className="mt-0.5 block text-xs text-slate-600">{r.error}</span>}</td>
                      <td className="py-1.5 pr-2 text-right tabular-nums">{r.transactions}</td>
                      <td className="py-1.5 pr-2 text-right tabular-nums">{r.proposals}</td>
                      <td className="py-1.5 text-right tabular-nums text-xs">{r.inputTokens.toLocaleString()} / {r.outputTokens.toLocaleString()}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="mt-2 text-xs text-slate-600">Model: {v.status.model}</p>
            </div>
          )}
        </section>
      </div>

      <p className="flex items-start gap-2 rounded-xl bg-ivory-100 p-3 text-xs text-navy-800 ring-1 ring-ivory-200" data-testid="coetha-privacy"><ShieldCheck className="size-4 shrink-0 text-gold-600" aria-hidden /> {COETHA_PRIVACY}</p>
    </div>
  );
}
