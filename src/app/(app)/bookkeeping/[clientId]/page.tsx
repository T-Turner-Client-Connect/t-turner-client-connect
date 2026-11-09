import Link from "next/link";
import clsx from "clsx";
import { connection } from "next/server";
import { notFound } from "next/navigation";
import {
  ArrowRight, Ban, BarChart3, CalendarDays, CheckCircle2, ChevronRight, Clock, Coins, CreditCard, FileText, Info, Landmark, Lightbulb, Link2, ListChecks, MonitorCheck, Percent, RefreshCw, Scale, Settings, SquareCheckBig, TrendingDown, TrendingUp, Upload,
} from "lucide-react";
import { ActionForm } from "@/components/action-form";
import { requireUser } from "@/lib/auth/session";
import { prisma } from "@/lib/prisma";
import { businessOverview } from "@/lib/services/business-overview";
import { bankingRegistry, monthlyAccountProgress, REGISTRY_TYPES, registryLabel } from "@/lib/services/bank-accounts";
import { canManageBanking, canSendClientRequests, canViewBanking } from "@/lib/services/bk-permissions";
import { rangeText, requestsFor } from "@/lib/services/client-requests";
import { monthlyChecklist } from "@/lib/services/monthly-workflow";
import { accountBalance, todayCentral, usd } from "@/lib/services/ledger";
import { workMonth } from "@/lib/services/bookkeeping-clients";
import { MONTH_NAMES } from "@/lib/bk-uploads";
import { retrieveNowAction } from "@/app/actions/ledger";
import { uploadForRequestAction, uploadStatementAction, uploadStatementsAutoAction } from "@/app/actions/bk-workflow";
import { canSetCoethaOptOut, coethaOptOutView } from "@/lib/services/coetha-opt-out";
import { CoethaOptOutPanel } from "@/components/bk/coetha-opt-out-panel";

export const metadata = { title: "Bookkeeping" };

/**
 * The staff / admin bookkeeping dashboard for one business (Tabitha's design). Coetha does the
 * routine work; this page shows where everything stands, from real data only, and lets the office
 * upload the statements Coetha asks for when a new client has no bank feed.
 */

const card = "min-w-0 rounded-2xl border border-gold-200/80 bg-gradient-to-b from-white to-ivory-50 shadow-[0_14px_32px_-24px_rgb(10_26_68/0.45)]";
const smallBtn = "inline-flex items-center gap-1.5 rounded-lg border border-navy-200 bg-white px-3 py-1.5 text-sm font-semibold text-navy-900 shadow-sm hover:bg-ivory-50";
const fmtSync = (d: Date) => d.toLocaleString("en-US", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit", timeZone: "America/Chicago" }).replace(/, (\d{1,2}:)/, " at $1");
const fmtShort = (d: Date) => d.toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "America/Chicago" });
const shiftYm = (y: number, m: number, n: number) => { const d = new Date(Date.UTC(y, m - 1 + n, 1)); return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1 }; };

const PILL: Record<string, string> = { DONE: "bg-emerald-50 text-emerald-800 ring-emerald-200", IN_PROGRESS: "bg-gold-100 text-gold-800 ring-gold-300", NOT_DUE: "bg-gold-100 text-gold-800 ring-gold-300", MISSING: "bg-red-50 text-red-700 ring-red-200" };
function RowIcon({ state, red }: { state: string; red?: boolean }) {
  if (state === "DONE") return <CheckCircle2 className="size-6 shrink-0 fill-emerald-600 text-white" aria-label="Complete" />;
  if (state === "MISSING" || red) return <Ban className="size-6 shrink-0 text-red-600" aria-label="Not done" />;
  return <Clock className="size-6 shrink-0 text-gold-500" aria-label="In progress" />;
}

const STATUS: Record<string, [string, string]> = {
  APPROVED: ["Reconciled", "bg-emerald-50 text-emerald-800"],
  READY: ["Awaiting Approval", "bg-gold-100 text-gold-800"],
  IN_PROGRESS: ["In Progress", "bg-gold-100 text-gold-800"],
  AWAITING_DATA: ["Awaiting Data", "bg-gold-100 text-gold-800"],
  EXCEPTION: ["Issue", "bg-red-50 text-red-700"],
  NOT_DUE: ["Not Yet Due", "bg-slate-100 text-slate-700"],
};

export default async function BookkeepingDashboard({ params, searchParams }: { params: Promise<{ clientId: string }>; searchParams: Promise<{ period?: string; year?: string; month?: string }> }) {
  await connection();
  const user = await requireUser();
  const { clientId } = await params;
  const sp = await searchParams;
  const client = await prisma.client.findUnique({ where: { id: clientId }, select: { id: true, bookkeepingProfile: { select: { frequency: true } } } });
  if (!client) notFound();
  const base = `/bookkeeping/${clientId}`;
  // The month shown: ?period, ?year&month, ?month=YYYY-MM (links made for the earlier Client Overview), else the month being worked.
  const byPeriod = sp.period ? await prisma.bookkeepingPeriod.findFirst({ where: { id: sp.period, clientId }, select: { year: true, month: true } }) : null;
  const ymParam = !sp.year && sp.month && /^\d{4}-(0[1-9]|1[0-2])$/.test(sp.month) ? { year: Number(sp.month.slice(0, 4)), month: Number(sp.month.slice(5)) } : null;
  const sel = byPeriod ?? ymParam ?? (sp.year && sp.month && Number(sp.month) >= 1 && Number(sp.month) <= 12 ? { year: Number(sp.year), month: Number(sp.month) } : workMonth(client.bookkeepingProfile?.frequency ?? "MONTHLY"));
  const ym = `${sel.year}-${String(sel.month).padStart(2, "0")}`;
  const monthLabel = `${MONTH_NAMES[sel.month - 1]} ${sel.year}`;
  const today = todayCentral();

  const [o, banking, manage, canSend] = await Promise.all([businessOverview(user, clientId, ym), canViewBanking(user, clientId), canManageBanking(user, clientId), canSendClientRequests(user, clientId)]);
  const [reg, prog, reqs] = await Promise.all([banking ? bankingRegistry(user, clientId) : null, banking ? monthlyAccountProgress(user, clientId, sel.year, sel.month) : null, requestsFor(clientId)]);
  const [optOut, canSetOptOut] = await Promise.all([coethaOptOutView(clientId), canSetCoethaOptOut(user, clientId)]);
  const pct = o.close.percent;

  // Accounts overview (registry: top-level accounts; employee cards live under their shared account).
  const rows = reg?.rows ?? [];
  const bankCount = rows.filter((r) => r.accountType === "CHECKING" || r.accountType === "SAVINGS").length;
  const cardCount = rows.filter((r) => r.accountType === "CREDIT_CARD").length;
  const recOf = new Map((prog?.rows ?? []).map((r) => [r.account.id, r.rec]));
  const balanceOf = async (r: (typeof rows)[number]) => {
    const feed = r.feeds.find((f) => f.currentBalanceCents != null);
    if (feed) return feed.currentBalanceCents!;
    const rec = recOf.get(r.id);
    if (rec?.endingBalanceCents != null) return rec.endingBalanceCents;
    return r.ledgerAccountId ? accountBalance(clientId, r.ledgerAccountId, today).catch(() => 0) : 0;
  };
  const balances = new Map(await Promise.all(rows.map(async (r) => [r.id, await balanceOf(r)] as const)));
  const toReconcile = rows.filter((r) => recOf.get(r.id)?.status !== "APPROVED" && recOf.has(r.id)).reduce((n, r) => n + Math.abs(balances.get(r.id) ?? 0), 0);
  const recent = [...rows].sort((a, b) => (b.lastSync?.getTime() ?? 0) - (a.lastSync?.getTime() ?? 0)).slice(0, 5);
  const reconciled = prog?.reconciled ?? 0, recTotal = prog?.total ?? 0;

  // Coetha tiles.
  const requestsNeeded = reqs.all.filter((r) => (r.status === "DRAFT" || r.status === "OPEN") && r.kind !== "YEAR_END").length;
  const recommendations = (o.coetha.proposals.RECOMMENDATION ?? 0) + (o.coetha.proposals.CLASSIFICATION ?? 0);
  const tiles = [
    { label: "Banking & Accounts", icon: Landmark, href: `${base}/banking`, badge: 0 },
    { label: "Credit Cards", icon: CreditCard, href: `${base}/banking#group-CREDIT_CARD`, badge: 0 },
    { label: "Reconciliations", icon: SquareCheckBig, href: `${base}/banking/reconciliation?month=${ym}`, badge: 0 },
    { label: "Requests & Items Needed", icon: FileText, href: `${base}/records`, badge: requestsNeeded },
    { label: "Recommendations", icon: Lightbulb, href: `${base}/coetha`, badge: recommendations },
  ];

  // Statements Coetha asked for (new clients / missing statements): upload straight to the request.
  const statementRequests = reqs.all.filter((r) => (r.status === "OPEN" || (r.status === "DRAFT" && r.routing !== "REVIEW")) && (r.docType === "BANK_STATEMENT" || r.docType === "CARD_STATEMENT"));

  // Month tiles: four months back, the month shown, two ahead.
  const months = await Promise.all([-4, -3, -2, -1, 0, 1, 2].map(async (n) => {
    const t = shiftYm(sel.year, sel.month, n);
    const c = await monthlyChecklist(clientId, t.year, t.month, { today });
    const started = c.items.some((i) => i.state !== "NOT_DUE");
    return { ...t, percent: c.percent, state: c.percent === 100 ? "COMPLETE" : started ? "IN_PROGRESS" : "NOT_STARTED", current: n === 0 };
  }));

  return (
    <div className="space-y-5" data-testid="bk-dashboard">
      {/* Banner */}
      <section className="relative overflow-hidden rounded-2xl bg-gradient-to-br from-navy-900 via-navy-950 to-navy-900 px-6 pb-14 pt-6 text-white ring-1 ring-gold-500/40 sm:px-8" data-testid="bk-banner">
        <div aria-hidden className="pointer-events-none absolute inset-y-0 right-0 hidden w-[55%] sm:block">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/brand/glass-buildings.jpg" alt="" className="size-full object-cover object-right" />
          <span className="absolute inset-0 bg-gradient-to-r from-navy-950 via-navy-950/30 to-transparent" />
        </div>
        <div className="relative">
          <h1 className="font-serif text-2xl font-bold leading-tight text-white" data-testid="bk-name">{o.client.name}</h1>
          <p className="font-serif text-lg text-navy-100">Bookkeeping Services</p>
        </div>
      </section>

      {/* Financial Overview */}
      <section className={clsx(card, "relative -mt-16 mx-1 p-4 sm:mx-3 sm:p-5")} data-testid="financial-overview">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
            <h2 className="font-serif text-xl font-bold text-navy-900">Financial Overview</h2>
            <p className="flex items-center gap-1.5 text-sm text-navy-800" data-testid="last-bank-update">
              <span className={clsx("size-2.5 rounded-full", reg?.lastSync ? "bg-emerald-600" : "bg-slate-300")} aria-hidden />
              Last bank update: <strong className="font-semibold text-navy-900">{reg?.lastSync ? fmtSync(reg.lastSync) : "Not connected yet"}</strong>
            </p>
          </div>
          <div className="flex items-center gap-2">
            {manage && (reg?.connections.some((c) => c.status === "ACTIVE" || c.status === "ERROR") ?? false) && (
              <ActionForm action={retrieveNowAction.bind(null, clientId)} showSuccess={false}><button type="submit" className={smallBtn} data-testid="refresh-data"><RefreshCw className="size-4" aria-hidden /> Refresh Data</button></ActionForm>
            )}
            <span title="Figures come only from this business's own books and bank feeds."><Info className="size-5 text-navy-700" aria-label="About these figures" /></span>
          </div>
        </div>
        <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {[
            { icon: Landmark, label: "Total Bank Balance", value: o.ledger ? usd(o.ledger.bank) : "—", sub: o.ledger ? `(${o.ledger.bankAccounts} account${o.ledger.bankAccounts === 1 ? "" : "s"})` : "Books not set up", tone: "text-gold-600", id: "fo-bank" },
            { icon: TrendingUp, label: "Income (MTD)", value: o.ledger ? usd(o.ledger.income) : "—", tone: "text-emerald-600", id: "fo-income" },
            { icon: TrendingDown, label: "Expenses (MTD)", value: o.ledger ? usd(o.ledger.expenses) : "—", tone: "text-red-500", id: "fo-expenses" },
            { icon: Coins, label: "Net Profit (MTD)", value: o.ledger ? usd(o.ledger.net) : "—", tone: "text-gold-600", id: "fo-net" },
          ].map((k) => (
            <div key={k.label} className="flex items-center gap-3 rounded-xl border border-ivory-200 bg-white px-4 py-3" data-testid={k.id}>
              <k.icon className={clsx("size-9 shrink-0", k.tone)} aria-hidden />
              <div className="min-w-0">
                <p className="text-sm text-navy-800">{k.label}</p>
                <p className="truncate font-serif text-xl font-bold text-navy-900">{k.value}</p>
                {k.sub && <p className="text-xs text-slate-600">{k.sub}</p>}
              </div>
            </div>
          ))}
        </div>
      </section>

      <section className="grid grid-cols-1 items-start gap-4 xl:grid-cols-[minmax(0,0.9fr)_minmax(0,1.2fr)]">
        {/* Monthly Progress */}
        <div className={clsx(card, "p-4 sm:p-5")} data-testid="monthly-progress">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="flex items-center gap-2 font-serif text-xl font-bold text-navy-900"><CalendarDays className="size-6 text-gold-600" aria-hidden /> Monthly Progress – {monthLabel}</h2>
            <span className="rounded-lg bg-gold-200 px-3 py-1 text-sm font-semibold text-navy-950" data-testid="progress-pill">{pct}% Complete</span>
          </div>
          <div className="mt-3 h-3 overflow-hidden rounded-full bg-ivory-200" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}><div className="h-full rounded-full bg-emerald-600" style={{ width: `${pct}%` }} /></div>
          <ul className="mt-3 divide-y divide-ivory-200">
            {o.close.steps.map((s) => {
              const red = s.key === "RELEASED" && s.state !== "DONE";
              const tone = s.state === "DONE" ? PILL.DONE : red ? PILL.MISSING : PILL[s.state ?? "NOT_DUE"];
              const action = s.key === "RECONCILED" && s.state !== "DONE" ? { label: "Review", href: `${base}/banking/reconciliation?month=${ym}` }
                : s.key === "PREPARED" && s.state !== "NA" ? { label: s.state === "DONE" ? "View" : "View Draft", href: `${base}/statements?year=${sel.year}&month=${sel.month}` }
                : s.key === "APPROVAL" && s.state === "IN_PROGRESS" ? { label: "Review", href: `${base}/statements?year=${sel.year}&month=${sel.month}` }
                : s.key === "CATEGORIZED" && s.state === "IN_PROGRESS" ? { label: "Review", href: `${base}/books?tab=bank` }
                : null;
              return (
                <li key={s.label} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2" data-item={s.key} data-state={s.state} title={s.detail}>
                  <RowIcon state={s.state ?? "NOT_DUE"} red={red} />
                  <span className="min-w-0 flex-1 text-[15px] text-navy-900">{s.label}</span>
                  <span className={clsx("rounded-full px-3 py-0.5 text-xs font-semibold ring-1", tone)}>{s.pill ?? s.detail}</span>
                  {action && <Link href={action.href} className="rounded-md border border-navy-200 bg-white px-2.5 py-0.5 text-xs font-semibold text-navy-900 hover:bg-ivory-50">{action.label}</Link>}
                </li>
              );
            })}
          </ul>
        </div>

        <div className="space-y-4">
          {/* Coetha – Senior Accountant */}
          <div className="overflow-hidden rounded-2xl ring-1 ring-gold-500/40" data-testid="coetha-card">
            <div className="flex items-start justify-between gap-2 bg-gradient-to-br from-navy-900 to-navy-950 px-4 py-3 text-white">
              <div className="flex min-w-0 items-center gap-3">
                <MonitorCheck className="size-8 text-gold-400" aria-hidden />
                <div>
                  <h2 className="font-serif text-lg font-bold text-white">Coetha – Senior Accountant</h2>
                  <p className="text-xs text-navy-100">Account Monitoring • Reconciliation • Document Requests • Recommendations</p>
                </div>
              </div>
              {optOut ? (
                <span className="shrink-0 rounded-md bg-slate-200 px-2.5 py-0.5 text-sm font-semibold text-slate-800">Opted out</span>
              ) : (
                <span className="shrink-0 rounded-md bg-emerald-100 px-2.5 py-0.5 text-sm font-semibold text-emerald-800">Active</span>
              )}
            </div>
            <div className="grid grid-cols-2 gap-2 bg-white p-3 sm:grid-cols-5">
              {tiles.map((t) => (
                <Link key={t.label} href={t.href} className="relative flex min-w-0 flex-col items-center justify-center gap-1 rounded-xl border border-ivory-200 bg-ivory-50 px-1 py-3 text-center text-[11px] font-semibold leading-tight text-navy-900 hover:border-gold-400" data-testid="coetha-tile">
                  <t.icon className="size-7 text-gold-600" aria-hidden />
                  {t.label}
                  {t.badge > 0 && <span className="absolute -right-1 -top-1 flex size-6 items-center justify-center rounded-full bg-red-600 text-xs font-bold text-white" aria-label={`${t.badge} waiting`}>{t.badge}</span>}
                </Link>
              ))}
            </div>
          </div>
          <CoethaOptOutPanel clientId={clientId} optOut={optOut} canSet={canSetOptOut} />

          {/* Accounts Overview */}
          <div className={clsx(card, "p-4")} data-testid="accounts-overview">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 className="flex items-center gap-2 font-serif text-lg font-bold text-navy-900"><BarChart3 className="size-6 text-gold-600" aria-hidden /> Accounts Overview</h2>
              <div className="flex flex-wrap gap-2">
                <Link href={`${base}/banking#connect`} className={smallBtn}><Link2 className="size-4" aria-hidden /> Connect Financial Institution</Link>
                <Link href={`${base}/banking#manage`} className={smallBtn}><Settings className="size-4" aria-hidden /> Manage Accounts</Link>
              </div>
            </div>
            <div className="mt-3 grid grid-cols-2 gap-3 rounded-xl bg-navy-900 px-3 py-3 text-white sm:grid-cols-3 2xl:grid-cols-5" data-testid="accounts-strip">
              {[
                { icon: Landmark, label: "Total Accounts", value: String(rows.length) },
                { icon: BarChart3, label: "Bank Accounts", value: String(bankCount) },
                { icon: CreditCard, label: "Credit Cards", value: String(cardCount) },
                { icon: Percent, label: "Reconciled", value: `${reconciled} of ${recTotal}`, sub: recTotal ? `(${Math.round((reconciled / recTotal) * 100)}%)` : "" },
                { icon: Scale, label: "Balance to Reconcile", value: usd(toReconcile) },
              ].map((s) => (
                <div key={s.label} className="flex min-w-0 items-center gap-2">
                  <s.icon className="size-6 shrink-0 text-gold-400" aria-hidden />
                  <div className="min-w-0"><p className="text-[11px] leading-tight text-navy-100">{s.label}</p><p className="font-semibold leading-tight">{s.value} <span className="whitespace-nowrap text-xs font-normal text-navy-100">{s.sub}</span></p></div>
                </div>
              ))}
            </div>
          </div>

          {/* Recent Account Activity */}
          <div className={clsx(card, "p-4")} data-testid="recent-activity">
            <h2 className="flex items-center gap-2 font-serif text-lg font-bold text-navy-900"><ListChecks className="size-6 text-gold-600" aria-hidden /> Recent Account Activity</h2>
            {!recent.length ? <p className="mt-2 text-sm text-slate-600">No accounts registered yet.</p> : (
              <div className="mt-2 overflow-x-auto">
                <table className="w-full min-w-[30rem] text-xs sm:text-[13px]">
                  <thead className="text-left text-xs text-slate-600"><tr><th className="py-1.5 pr-2 font-semibold">Account</th><th className="pr-2 font-semibold">Type</th><th className="pr-2 font-semibold">Last Sync</th><th className="pr-2 font-semibold">Status</th><th className="pr-2 text-right font-semibold">Balance</th><th /></tr></thead>
                  <tbody className="divide-y divide-ivory-200">
                    {recent.map((r) => {
                      const rec = recOf.get(r.id);
                      const [st, tone] = STATUS[rec?.status ?? "NOT_DUE"] ?? STATUS.NOT_DUE;
                      const isCard = r.accountType !== "CHECKING" && r.accountType !== "SAVINGS";
                      return (
                        <tr key={r.id}>
                          <td className="py-2 pr-2"><span className="flex items-center gap-1.5 whitespace-nowrap font-semibold text-navy-900">{isCard ? <CreditCard className="size-4 shrink-0 text-gold-600" aria-hidden /> : <Landmark className="size-4 shrink-0 text-gold-600" aria-hidden />}<span className="max-w-[9rem] truncate">{r.nickname || r.institution}</span> <span className="font-normal text-navy-800">••••{r.last4 ?? "—"}</span></span></td>
                          <td className="pr-2">{isCard ? (REGISTRY_TYPES[r.accountType as keyof typeof REGISTRY_TYPES]?.label ?? "Card") : "Bank"}</td>
                          <td className="whitespace-nowrap pr-2">{r.lastSync ? fmtShort(r.lastSync) : "—"}</td>
                          <td className="pr-2"><span className={clsx("inline-flex items-center gap-1 whitespace-nowrap rounded-full px-2.5 py-0.5 text-xs font-semibold", tone)}>{rec?.status === "APPROVED" ? <CheckCircle2 className="size-3.5" aria-hidden /> : null}{st}</span></td>
                          <td className="whitespace-nowrap pr-2 text-right tabular-nums">{usd(balances.get(r.id) ?? 0)}</td>
                          <td><Link href={`${base}/banking/reconciliation?month=${ym}`} aria-label={`Open ${registryLabel(r)}`}><ChevronRight className="size-4 text-navy-800" aria-hidden /></Link></td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
            <Link href={`${base}/banking/reconciliation?month=${ym}`} className="mt-2 flex items-center justify-end gap-1 text-sm font-semibold text-navy-900 underline decoration-gold-500">View All {rows.length} Accounts &amp; Reconciliations <ArrowRight className="size-4" aria-hidden /></Link>
          </div>
        </div>
      </section>

      {/* Monthly Bookkeeping Progress */}
      <section className={clsx(card, "p-4 sm:p-5")} data-testid="bookkeeping-progress">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="flex items-center gap-2 font-serif text-xl font-bold text-navy-900"><BarChart3 className="size-6 text-gold-600" aria-hidden /> Monthly Bookkeeping Progress</h2>
          <Link href={`${base}/statements`} className={smallBtn}>View Full Bookkeeping History <ArrowRight className="size-4" aria-hidden /></Link>
        </div>
        <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-7">
          {months.map((m) => (
            <Link key={`${m.year}-${m.month}`} href={`${base}?year=${m.year}&month=${m.month}`} className={clsx("rounded-xl border px-3 py-2.5 text-center", m.current ? "border-gold-400 bg-gold-50 shadow" : "border-ivory-200 bg-white hover:border-gold-300")} data-testid="month-tile" data-state={m.state}>
              <p className="font-semibold text-navy-900">{MONTH_NAMES[m.month - 1].slice(0, 3)} {m.year}</p>
              {m.state === "COMPLETE" ? <p className="mt-1 flex items-center justify-center gap-1 text-sm font-semibold text-emerald-700"><CheckCircle2 className="size-4" aria-hidden /> Complete</p>
                : m.state === "IN_PROGRESS" ? (<><p className="mt-1 flex items-center justify-center gap-1 text-sm font-semibold text-navy-900"><span className="size-2 rounded-full bg-red-600" aria-hidden /> In Progress</p><span className="mt-1 flex items-center gap-1.5"><span className="h-1.5 flex-1 overflow-hidden rounded-full bg-ivory-200"><span className="block h-full rounded-full bg-emerald-600" style={{ width: `${m.percent}%` }} /></span><span className="text-xs">{m.percent}%</span></span></>)
                : <p className="mt-1 flex items-center justify-center gap-1 text-sm text-navy-800"><span className="size-2 rounded-full bg-red-600" aria-hidden /> Not Started</p>}
            </Link>
          ))}
        </div>
      </section>

      {/* Statements Coetha asked for (only when she needs them) */}
      {canSend && (
        <section className={clsx(card, "p-4 sm:p-5")} data-testid="statement-uploads">
          {statementRequests.length > 0 ? (
            <>
              <h2 className="flex items-center gap-2 font-serif text-lg font-bold text-navy-900"><Upload className="size-5 text-gold-600" aria-hidden /> Upload statements Coetha requested <span className="rounded-full bg-red-600 px-2 py-0.5 font-sans text-xs font-bold text-white">{statementRequests.length}</span></h2>
              <ul className="mt-2 divide-y divide-ivory-200">
                {statementRequests.slice(0, 8).map((r) => (
                  <li key={r.id} className="flex flex-wrap items-center gap-2 py-2 text-sm" data-testid="statement-request">
                    <span className="min-w-0 flex-1"><strong className="text-navy-900">{r.bookkeepingAccount ? registryLabel(r.bookkeepingAccount) : "Account"}</strong> · {rangeText(r) ?? ""} <span className="text-xs text-slate-600">· {r.status === "OPEN" ? "asked of the client" : "draft"}</span></span>
                    <ActionForm action={uploadForRequestAction.bind(null, clientId, r.id)} className="flex flex-wrap items-center gap-2" resetOnSuccess idempotent>
                      <input className="input max-w-56 py-1 text-xs" type="file" name="file" accept="application/pdf,image/png,image/jpeg" required aria-label={`Statement for ${r.title}`} />
                      <button type="submit" className={smallBtn}><Upload className="size-4" aria-hidden /> Upload</button>
                    </ActionForm>
                  </li>
                ))}
              </ul>
              {statementRequests.length > 8 && <Link className="text-xs underline" href={`${base}/records`}>+ {statementRequests.length - 8} more</Link>}
            </>
          ) : (
            <p className="flex items-center gap-2 text-sm text-navy-800"><CheckCircle2 className="size-4 text-emerald-600" aria-hidden /> Coetha isn&apos;t waiting on any statements.</p>
          )}
          {rows.length > 0 && (
            <div className="mt-3 rounded-xl border border-gold-200 bg-white p-3" data-testid="upload-statements-auto">
              <p className="flex items-center gap-2 text-sm font-semibold text-navy-900"><Upload className="size-4 text-gold-600" aria-hidden /> Upload bank statements</p>
              <p className="mt-0.5 text-xs text-slate-600">Choose one or more statement PDFs (as many months as you have). Client Connect finds the account and month on each one, files it, and imports its transactions when they match the statement to the cent. Nothing is posted until it&apos;s categorized.</p>
              <ActionForm action={uploadStatementsAutoAction.bind(null, clientId)} className="mt-2 flex flex-wrap items-center gap-2" resetOnSuccess idempotent>
                <input className="input max-w-80" type="file" name="files" accept="application/pdf" multiple required aria-label="Statement PDFs" />
                <button type="submit" className={smallBtn}><Upload className="size-4" aria-hidden /> Upload</button>
                <label className="flex w-full items-center gap-1.5 text-xs text-slate-700"><input type="checkbox" name="postOpening" /> Start the books with the earliest statement&apos;s beginning balance (only if no opening balance is posted yet)</label>
              </ActionForm>
            </div>
          )}
          {rows.length > 0 && (
            <details className="mt-2 text-sm">
              <summary className="cursor-pointer text-navy-900 underline decoration-gold-500">Choose the account and month myself</summary>
              <ActionForm action={uploadStatementAction.bind(null, clientId)} className="mt-2 flex flex-wrap items-end gap-2" resetOnSuccess idempotent>
                <label className="text-xs">Account<select className="input mt-1" name="accountId" required defaultValue="">{[<option key="" value="" disabled>Choose…</option>, ...rows.map((r) => <option key={r.id} value={r.id}>{registryLabel(r)}</option>)]}</select></label>
                <label className="text-xs">Month<input className="input mt-1" type="month" name="month" required defaultValue={ym} /></label>
                <input className="input max-w-64" type="file" name="file" accept="application/pdf,image/png,image/jpeg" required aria-label="Statement file" />
                <button type="submit" className={smallBtn}><Upload className="size-4" aria-hidden /> Upload</button>
              </ActionForm>
            </details>
          )}
        </section>
      )}
    </div>
  );
}
