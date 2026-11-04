import Link from "next/link";
import { connection } from "next/server";
import { notFound, redirect } from "next/navigation";
import clsx from "clsx";
import {
  ArrowDown, ArrowRight, ArrowUp, BarChart3, Building2, CalendarPlus, Calculator, CheckCircle2, Coins, CreditCard, FileBadge, FileSpreadsheet, FileText, IdCard, Landmark, MessageSquareText, ReceiptText, Sparkles, UsersRound,
} from "lucide-react";
import { requireUser } from "@/lib/auth/session";
import { prisma } from "@/lib/prisma";
import { businessOverview, YEAR_END_STAGES, type Deadline } from "@/lib/services/business-overview";
import { usd } from "@/lib/services/ledger";
import { MonthSelect } from "@/components/business-overview/month-select";
import { StateIcon } from "@/components/bk/parts";

export const metadata = { title: "Client Overview" };

const monthName = (ym: string, opts: Intl.DateTimeFormatOptions = { month: "long", year: "numeric" }) => {
  const [y, m] = ym.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString("en-US", { ...opts, timeZone: "UTC" });
};
const dayLabel = (d: string, opts: Intl.DateTimeFormatOptions = { month: "short", day: "numeric", year: "numeric" }) => new Date(`${d}T12:00:00Z`).toLocaleDateString("en-US", { ...opts, timeZone: "UTC" });

const card = "min-w-0 rounded-2xl border border-gold-200/80 bg-gradient-to-b from-white to-ivory-50 shadow-[0_14px_32px_-24px_rgb(10_26_68/0.45)]";
const navyBtn = "inline-flex items-center justify-center rounded-lg bg-navy-900 px-4 py-2 text-sm font-semibold text-white shadow hover:bg-navy-800";
const outlineBtn = "inline-flex items-center justify-center rounded-lg border-[1.5px] border-navy-900 bg-white px-4 py-2 text-sm font-semibold text-navy-900 hover:bg-ivory-50";
const goldBtn = "inline-flex items-center justify-center gap-2 rounded-lg bg-gradient-to-b from-gold-300 to-gold-500 px-4 py-2.5 text-sm font-semibold text-navy-950 shadow hover:to-gold-600";
const ghostBtn = "inline-flex items-center justify-center gap-2 rounded-lg border border-white/80 bg-white px-4 py-2.5 text-sm font-semibold text-navy-900 hover:bg-ivory-50";

function Kpi({ icon: Icon, label, value, change, goodWhenDown = false, sub, testId }: { icon: typeof Coins; label: string; value: string; change?: number | null; goodWhenDown?: boolean; sub?: string; testId: string }) {
  const up = (change ?? 0) >= 0;
  const good = goodWhenDown ? !up : up;
  return (
    <div className={clsx(card, "flex items-center gap-4 px-5 py-4")} data-testid={testId}>
      <Icon className="size-11 shrink-0 text-gold-600" aria-hidden />
      <div className="min-w-0">
        <p className="text-sm font-medium text-navy-800">{label}</p>
        <p className="truncate font-serif text-xl font-bold text-navy-900">{value}</p>
        {change != null && (
          <p className={clsx("flex items-center gap-1 text-sm font-semibold", good ? "text-emerald-700" : "text-red-700")}>
            {up ? <ArrowUp className="size-4" aria-hidden /> : <ArrowDown className="size-4" aria-hidden />}
            {Math.abs(change).toFixed(1)}%
            <span className="sr-only"> vs the month before</span>
          </p>
        )}
        {sub && <p className="text-sm text-slate-600">{sub}</p>}
      </div>
    </div>
  );
}

function Donut({ percent }: { percent: number }) {
  const r = 52;
  const c = 2 * Math.PI * r;
  return (
    <div className="relative size-36 shrink-0" role="img" aria-label={`${percent}% complete`}>
      <svg viewBox="0 0 128 128" className="size-full -rotate-90">
        <circle cx="64" cy="64" r={r} fill="none" stroke="var(--color-navy-900)" strokeWidth="12" />
        <circle cx="64" cy="64" r={r} fill="none" stroke="var(--color-gold-500)" strokeWidth="12" strokeDasharray={`${(percent / 100) * c} ${c}`} strokeLinecap="round" />
      </svg>
      <span className="absolute inset-0 flex flex-col items-center justify-center">
        <span className="font-serif text-2xl font-bold text-navy-900">{percent}%</span>
        <span className="text-sm text-navy-800">Complete</span>
      </span>
    </div>
  );
}

const DEADLINE_PILL: Record<Deadline["status"], [string, string]> = {
  ON_TRACK: ["On Track", "bg-emerald-50 text-emerald-700"],
  DUE_SOON: ["Due Soon", "bg-red-50 text-red-700"],
  UPCOMING: ["Upcoming", "bg-navy-50 text-navy-800"],
  PAST_DUE: ["Past Due", "bg-red-600 text-white"],
};

function Chart({ perf }: { perf: { month: string; income: number; expenses: number }[] }) {
  const max = Math.max(1, ...perf.flatMap((p) => [p.income, p.expenses]));
  // A rounded top for the axis: 1, 2 or 5 × a power of ten, in whole dollars.
  const dollars = max / 100;
  const pow = 10 ** Math.floor(Math.log10(dollars || 1));
  const top = [1, 2, 5, 10].map((k) => k * pow).find((v) => v >= dollars) ?? dollars;
  const ticks = [1, 0.8, 0.6, 0.4, 0.2, 0].map((f) => f * top);
  const fmt = (v: number) => (v >= 1000 ? `$${Math.round(v / 1000)}K` : `$${Math.round(v)}`);
  return (
    <div className="flex gap-2" data-testid="performance-chart">
      <div className="flex h-44 flex-col justify-between pb-6 text-right text-xs text-navy-800">{ticks.map((t) => <span key={t}>{fmt(t)}</span>)}</div>
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="relative flex h-38 items-end justify-around border-b border-l border-ivory-200">
          {perf.map((p) => (
            <div key={p.month} className="flex h-full items-end gap-1" title={`${monthName(p.month)}: income ${usd(p.income)}, expenses ${usd(p.expenses)}`}>
              <span className="w-3 rounded-t bg-navy-900 sm:w-4" style={{ height: `${Math.max(0, (p.income / 100 / top) * 100)}%` }} />
              <span className="w-3 rounded-t bg-gold-500 sm:w-4" style={{ height: `${Math.max(0, (p.expenses / 100 / top) * 100)}%` }} />
            </div>
          ))}
        </div>
        <div className="flex justify-around pt-1 text-xs text-navy-800">{perf.map((p) => <span key={p.month}>{monthName(p.month, { month: "short" })}</span>)}</div>
      </div>
    </div>
  );
}

export default async function ClientOverview({ params, searchParams }: { params: Promise<{ clientId: string }>; searchParams: Promise<Record<string, string | undefined>> }) {
  await connection();
  const user = await requireUser();
  const { clientId } = await params;
  const sp = await searchParams;
  // Links to a month's close (?period=…, ?year=&month=) open the monthly close page.
  if (sp.period || (sp.year && sp.month)) {
    const q = new URLSearchParams(Object.entries(sp).filter((e): e is [string, string] => !!e[1]));
    redirect(`/bookkeeping/${clientId}/close?${q}`);
  }
  if (!(await prisma.client.count({ where: { id: clientId } }))) notFound();
  const o = await businessOverview(user, clientId, sp.month);
  const base = `/bookkeeping/${clientId}`;
  const mName = monthName(o.selected);
  const short = monthName(o.selected, { month: "long" });

  const missingStep = o.close.steps.find((s) => s.state === "MISSING");
  const nextStep = missingStep ?? o.close.steps.find((s) => !s.done && s.state !== "NOT_DUE");
  const work = o.coetha;
  const workBits = [
    work.proposals.RECOMMENDATION ? `${work.proposals.RECOMMENDATION} finding${work.proposals.RECOMMENDATION === 1 ? "" : "s"} for Tabitha` : null,
    work.drafts ? `${work.drafts} draft request${work.drafts === 1 ? "" : "s"} ready to send` : null,
    work.recsWaiting ? `${work.recsWaiting} reconciliation${work.recsWaiting === 1 ? "" : "s"} ready for approval` : null,
  ].filter(Boolean);
  const coethaSays = !nextStep
    ? `${short}'s close is ${o.close.percent === 100 ? "complete — the financial statements were approved and released" : "on track"}.${workBits.length ? ` I'm working on: ${workBits.join(", ")}.` : ""}`
    : `${short} is ${o.close.percent}% complete · ${o.close.reconciled} of ${o.close.accounts} accounts reconciled. Next: ${nextStep.label}${nextStep.detail ? ` (${nextStep.detail})` : ""}.${workBits.length ? ` I'm working on: ${workBits.join(", ")}.` : ""}`;

  return (
    <div className="space-y-5" data-testid="client-overview">
      {/* Banner */}
      <section className="relative overflow-hidden rounded-2xl bg-gradient-to-br from-navy-900 via-navy-950 to-navy-900 px-6 py-6 text-white ring-1 ring-gold-500/40 sm:px-8" data-testid="overview-banner">
        {/* Tabitha's glass-building photo on the right, fading into the navy. */}
        <div aria-hidden className="pointer-events-none absolute inset-y-0 right-0 hidden w-[48%] sm:block">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/brand/glass-buildings.jpg" alt="" className="size-full object-cover object-right" />
          <span className="absolute inset-0 bg-gradient-to-r from-navy-950 via-navy-950/30 to-transparent" />
        </div>
        <div className="relative flex flex-wrap items-center justify-between gap-4">
          <div className="flex min-w-0 items-start gap-4 sm:max-w-[60%]">
            <span className="mt-1 hidden size-14 shrink-0 items-center justify-center rounded-lg border-2 border-gold-400 sm:flex"><Building2 className="size-9 text-gold-400" aria-hidden /></span>
            <div className="min-w-0">
              <h1 className="font-serif text-2xl font-bold leading-tight text-white sm:text-3xl" data-testid="overview-name">{o.client.name}</h1>
              <p className="mt-1 flex flex-wrap border-t border-gold-500/40 pt-1 text-base text-navy-100" data-testid="overview-services">
                {o.services.map((s, i) => <span key={s}>{i > 0 && <span className="mx-2 text-gold-400">•</span>}{s}</span>)}
              </p>
              <p className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-navy-100">
                {o.client.active && <span className="rounded-full bg-emerald-500 px-3 py-0.5 font-semibold text-white">Active Client</span>}
                {o.client.managed ? (
                  <span className="rounded-full bg-white/15 px-3 py-0.5 font-semibold text-white" data-testid="overview-access" title="The client's own portal shows their business books and statements.">Client portal: Managed Business access granted</span>
                ) : (
                  <Link href="/owner/business-access" className="rounded-full bg-amber-400 px-3 py-0.5 font-semibold text-navy-950" data-testid="overview-access" title="This is about the CLIENT's portal only. The office keeps and manages these books either way.">Client portal: Managed Business access not granted</Link>
                )}
                {o.profile.einLast4 && <span>EIN: ••••{o.profile.einLast4}</span>}
                {o.profile.basis && <span>| Accounting Basis: {o.profile.basis === "ACCRUAL" ? "Accrual" : o.profile.basis === "CASH" ? "Cash" : "Modified cash"}</span>}
                {o.payroll && <span>| Payroll: {o.payroll.provider ?? "Provider not set"}{o.payroll.frequency ? ` (${o.payroll.frequency})` : ""}</span>}
              </p>
            </div>
          </div>
          <MonthSelect base={base} value={o.selected} choices={o.monthChoices} />
        </div>
      </section>

      {/* Figures */}
      <section className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4" aria-label="This month's figures">
        {o.ledger ? (
          <>
            <Kpi icon={BarChart3} label="Income (MTD)" value={usd(o.ledger.income)} change={o.ledger.change.income} testId="kpi-income" />
            <Kpi icon={CreditCard} label="Expenses (MTD)" value={usd(o.ledger.expenses)} change={o.ledger.change.expenses} goodWhenDown testId="kpi-expenses" />
            <Kpi icon={Coins} label="Net Profit (MTD)" value={usd(o.ledger.net)} change={o.ledger.change.net} testId="kpi-net" />
            <Kpi icon={Landmark} label="Bank Balance" value={usd(o.ledger.bank)} sub={`(${o.ledger.bankAccounts} Account${o.ledger.bankAccounts === 1 ? "" : "s"})`} testId="kpi-bank" />
          </>
        ) : (
          <div className={clsx(card, "px-5 py-4 text-sm text-navy-800 sm:col-span-2 xl:col-span-4")} data-testid="kpi-none">
            {o.hasBooks ? "Only Admins and the staff member assigned to this client can see its figures." : <>Income, expenses, profit and bank balance appear here once this client&apos;s books are set up in <Link className="font-semibold underline" href={`${base}/books`}>General Ledger</Link>.</>}
          </div>
        )}
      </section>

      {/* Close + Coetha */}
      <section className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <div className={clsx(card, "p-5")} data-testid="monthly-close">
          <h2 className="font-serif text-xl font-bold text-navy-900">{mName} – Monthly Close</h2>
          <div className="mt-3 flex flex-wrap items-center gap-6">
            <Donut percent={o.close.percent} />
            <ul className="min-w-0 flex-1 divide-y divide-ivory-200">
              {o.close.steps.map((s) => (
                <li key={s.label} className="flex items-center gap-2 py-1.5 text-[15px] text-navy-900" data-state={s.state} title={s.detail}>
                  <StateIcon state={s.state ?? (s.done ? "DONE" : "NOT_DUE")} />
                  {s.label}<span className="sr-only">{s.done ? " — done" : s.state === "MISSING" ? " — missing" : " — not done"}</span>
                </li>
              ))}
            </ul>
          </div>
          <p className="mt-2 text-xs text-slate-500">{o.close.reconciled} of {o.close.accounts} accounts reconciled · updated automatically from the books and bank feeds.</p>
          <Link href={o.periodId ? `${base}/close?period=${o.periodId}` : `${base}/close?year=${o.selected.slice(0, 4)}&month=${Number(o.selected.slice(5))}`} className="mt-2 inline-block text-sm font-semibold text-navy-900 underline decoration-gold-500">Open bookkeeping management</Link>
        </div>

        <div className="rounded-2xl bg-gradient-to-br from-navy-900 to-navy-950 p-5 text-white shadow-[0_14px_32px_-24px_rgb(10_26_68/0.6)] ring-1 ring-gold-500/40" data-testid="coetha-card">
          <h2 className="flex items-center gap-3 font-serif text-xl font-bold text-white"><Sparkles className="size-7 text-gold-400" aria-hidden /> Coetha | Senior Accountant</h2>
          <p className="ml-11 text-sm text-navy-100">Client: {o.client.name}</p>
          <p className="mt-4 rounded-xl bg-white px-5 py-4 text-base leading-snug text-navy-900" data-testid="coetha-message">{coethaSays}</p>
          <div className="mt-4 flex flex-wrap gap-3">
            <Link href={`${base}/books?tab=reports`} className={goldBtn}><FileText className="size-4" aria-hidden /> Review Financials</Link>
            <Link href={`/clients/${clientId}?tab=taxes`} className={ghostBtn}><Calculator className="size-4" aria-hidden /> Prepare Taxes</Link>
            <Link href={`${base}/coetha`} className={ghostBtn} data-testid="coetha-open-page"><MessageSquareText className="size-4" aria-hidden /> Open Coetha AI</Link>
          </div>
        </div>
      </section>

      {/* Payroll, filings, licenses, year-end */}
      <section className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <div className={clsx(card, "flex flex-col p-4")} data-testid="payroll-card">
          <h3 className="flex flex-wrap items-center gap-2 font-serif text-lg font-bold text-navy-900">
            <UsersRound className="size-6 text-gold-600" aria-hidden /> Payroll{o.payroll?.provider ? ` (${o.payroll.provider})` : ""}
            {o.payroll && <span className="rounded-full bg-emerald-50 px-2 py-0.5 font-sans text-xs font-semibold text-emerald-700">On Schedule</span>}
          </h3>
          <p className="mt-3 flex-1 text-sm text-navy-900">
            {!o.payroll ? "This client doesn't run payroll." : o.payroll.next ? <>Next Pay Date: {dayLabel(o.payroll.next)}</> : "Next pay date: add a known pay date on the Payroll page."}
          </p>
          <div className="mt-3 flex gap-2">
            <Link href={`${base}/payroll`} className={clsx(navyBtn, "flex-1")}>View Payroll</Link>
            <Link href={`${base}/close#upload-financials`} className={clsx(outlineBtn, "flex-1")}>New Payroll</Link>
          </div>
        </div>

        <div className={clsx(card, "flex flex-col p-4")} data-testid="filings-card">
          <h3 className="flex flex-wrap items-center gap-2 font-serif text-lg font-bold text-navy-900">
            <FileSpreadsheet className="size-6 text-gold-600" aria-hidden /> Taxes &amp; Filings
            {o.filings.dueSoon > 0 && <span className="rounded-full bg-red-600 px-2 py-0.5 font-sans text-xs font-semibold text-white">{o.filings.dueSoon} Due</span>}
          </h3>
          <p className="mt-3 flex-1 text-sm text-navy-900">
            {o.filings.next ? <><span className="font-semibold">• {o.filings.next.title}</span><br />Due: {dayLabel(o.filings.next.date)}</> : "No filing deadlines added for this client."}
          </p>
          <Link href={`/clients/${clientId}?tab=taxes`} className={clsx(navyBtn, "mt-3 w-full")}>View Tax Center</Link>
        </div>

        <div className={clsx(card, "flex flex-col p-4")} data-testid="licenses-card">
          <h3 className="flex flex-wrap items-center gap-2 font-serif text-lg font-bold text-navy-900">
            <IdCard className="size-6 text-gold-600" aria-hidden /> Business Licenses
            {o.licenses.count > 0 && (o.licenses.expired ? <span className="rounded-full bg-red-600 px-2 py-0.5 font-sans text-xs font-semibold text-white">{o.licenses.expired} Expired</span> : <span className="rounded-full bg-emerald-50 px-2 py-0.5 font-sans text-xs font-semibold text-emerald-700">All Current</span>)}
          </h3>
          <p className="mt-3 flex-1 text-sm text-navy-900">
            {o.licenses.next ? <>Next Renewal: {dayLabel(o.licenses.next.renewal!)}<br />({o.licenses.next.name})</> : o.licenses.count ? "No upcoming renewal dates." : "No licenses added yet."}
          </p>
          <Link href={`${base}/licenses`} className={clsx(outlineBtn, "mt-3 w-full")}>View Licenses</Link>
        </div>

        <div className={clsx(card, "flex flex-col p-4")} data-testid="year-end-card">
          <h3 className="flex items-center gap-2 font-serif text-lg font-bold text-navy-900"><FileBadge className="size-6 text-gold-600" aria-hidden /> 1099 / W-2</h3>
          <div className="mt-3 flex-1 text-center text-sm text-navy-900">
            {o.yearEnd ? (
              <>
                <p className="font-semibold">{o.yearEnd.taxYear} Year-End Setup</p>
                <p className="mt-1 inline-block rounded-full bg-gold-200 px-3 py-0.5 text-xs font-semibold text-navy-900">{YEAR_END_STAGES[o.yearEnd.stage].label}</p>
              </>
            ) : (
              <p>Year-end W-2 / 1099 work not started.</p>
            )}
          </div>
          <Link href={`${base}/year-end`} className={clsx(navyBtn, "mt-3 w-full")}>View 1099 / W-2</Link>
        </div>
      </section>

      {/* Invoicing + our account */}
      <section className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <div className={clsx(card, "p-5")} data-testid="client-invoicing">
          <div className="flex items-start gap-3 border-b border-ivory-200 pb-3">
            <ReceiptText className="size-10 shrink-0 text-gold-600" aria-hidden />
            <div>
              <h3 className="font-serif text-xl font-bold text-navy-900">Client Invoicing <span className="font-sans text-sm font-semibold">(Your Customers)</span></h3>
              <p className="text-sm text-navy-800">Create, send, and track invoices to your customers.</p>
            </div>
          </div>
          <div className="grid grid-cols-2 divide-x divide-ivory-200 py-4 text-center">
            <div><p className="font-serif text-xl font-bold text-navy-900">{usd(o.invoicing.openCents)}</p><p className="text-sm text-navy-800">Open Invoices ({o.invoicing.openCount})</p></div>
            <div><p className="font-serif text-xl font-bold text-navy-900">{usd(o.invoicing.collectedCents)}</p><p className="text-sm text-navy-800">Collected (MTD)</p></div>
          </div>
          <div className="flex flex-wrap gap-2">
            <Link href={`${base}/books?tab=invoicing`} className={navyBtn}>Create Invoice</Link>
            <Link href={`${base}/books?tab=invoicing`} className={outlineBtn}>View Invoices</Link>
            <Link href={`${base}/books?tab=invoicing`} className={outlineBtn}>Payment History</Link>
          </div>
        </div>

        <div className="min-w-0 rounded-2xl border-2 border-gold-400 bg-gradient-to-b from-white to-gold-50/40 p-5 shadow-[0_14px_32px_-24px_rgb(200_157_41/0.7)]" data-testid="my-account">
          <div className="flex items-start gap-3">
            <FileText className="size-10 shrink-0 text-gold-600" aria-hidden />
            <div>
              <h3 className="font-serif text-xl font-bold text-navy-900">My Account – T. Turner &amp; Associates</h3>
              <p className="text-sm text-navy-800">Your Bookkeeping &amp; Tax Services</p>
            </div>
          </div>
          {o.account ? (
            <div className="mt-3 grid gap-4 sm:grid-cols-[1fr_auto]">
              <div className="text-center sm:border-r sm:border-ivory-200 sm:pr-4">
                {o.account.plan && <p className="inline-block rounded-full bg-gold-300 px-4 py-1 text-sm font-semibold text-navy-950">{o.account.plan}</p>}
                <p className="mt-2 font-serif text-2xl font-bold text-navy-900">{o.account.amountCents != null ? usd(o.account.amountCents) : "—"}</p>
                {o.account.due && <p className="text-sm text-navy-800">Due: {dayLabel(o.account.due)}</p>}
                <p className={clsx("mt-2 inline-flex items-center gap-1 rounded-full px-4 py-1 text-sm font-semibold", o.account.status.tone === "paid" ? "bg-emerald-600 text-white" : o.account.status.tone === "overdue" ? "bg-red-600 text-white" : "bg-navy-50 text-navy-900")} data-testid="my-account-status">
                  {o.account.status.tone === "paid" && <CheckCircle2 className="size-4" aria-hidden />}{o.account.status.label}
                </p>
              </div>
              <div className="flex flex-col gap-2">
                {["View Invoice", "Make a Payment", "Set Up AutoPay", "Billing History"].map((l) => (
                  <Link key={l} href={`${base}/profile#billing`} className="rounded-lg border-[1.5px] border-navy-900 bg-white px-4 py-1.5 text-center text-sm font-semibold text-navy-900 hover:bg-ivory-50">{l}</Link>
                ))}
              </div>
            </div>
          ) : (
            <p className="mt-3 text-sm text-navy-800">Billing is visible to Tabitha and staff she allows.</p>
          )}
        </div>
      </section>

      {/* Performance + deadlines */}
      <section className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <div className={clsx(card, "p-5")}>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="flex items-center gap-2 font-serif text-xl font-bold text-navy-900"><BarChart3 className="size-6 text-gold-600" aria-hidden /> Monthly Performance</h3>
            <p className="flex gap-3 text-xs text-navy-800"><span className="flex items-center gap-1"><span className="size-3 rounded-sm bg-navy-900" />Income</span><span className="flex items-center gap-1"><span className="size-3 rounded-sm bg-gold-500" />Expenses</span></p>
          </div>
          <div className="mt-4">{o.ledger ? <Chart perf={o.ledger.perf} /> : <p className="text-sm text-navy-800">The chart fills in from the books once they&apos;re set up.</p>}</div>
        </div>

        <div className={clsx(card, "p-5")} data-testid="upcoming-deadlines">
          <div className="flex items-center justify-between gap-2">
            <h3 className="flex items-center gap-2 font-serif text-xl font-bold text-navy-900"><CalendarPlus className="size-6 text-gold-600" aria-hidden /> Upcoming Deadlines</h3>
            <Link href="/tasks" className="flex items-center gap-1 text-sm font-semibold text-navy-900">View Calendar <ArrowRight className="size-4" aria-hidden /></Link>
          </div>
          {o.deadlines.length ? (
            <ul className="mt-3 divide-y divide-ivory-200">
              {o.deadlines.map((d) => (
                <li key={`${d.date}${d.title}`} className="flex items-center gap-3 py-2">
                  <span className="w-20 shrink-0 rounded-md bg-gold-200 px-2 py-1 text-center text-sm font-bold uppercase text-navy-950">{dayLabel(d.date, { month: "short", day: "2-digit" })}</span>
                  <span className="min-w-0 flex-1 font-semibold text-navy-900">{d.title}</span>
                  <span className={clsx("shrink-0 rounded-full px-3 py-0.5 text-sm font-semibold", DEADLINE_PILL[d.status][1])}>{DEADLINE_PILL[d.status][0]}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-3 text-sm text-navy-800">No upcoming deadlines for this client.</p>
          )}
        </div>
      </section>
      <p className="flex items-center gap-2 text-xs text-slate-500"><Building2 className="size-3.5" aria-hidden /> Figures come only from this client&apos;s own records in Client Connect.</p>
    </div>
  );
}
