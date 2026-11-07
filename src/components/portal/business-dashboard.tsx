import Link from "next/link";
import clsx from "clsx";
import {
  ArrowDown, ArrowRight, ArrowUp, BarChart3, BookOpen, Building2, CalendarPlus, ClipboardCheck, Coins, ExternalLink, FileBadge, FileSpreadsheet, FileText, IdCard, ReceiptText, Scale, Sparkles, TrendingDown, TrendingUp, Upload, UsersRound,
} from "lucide-react";
import { CHECKLIST_STATUS, type ChecklistStatus } from "@/lib/services/business-tax-requests";
import { ActionForm } from "@/components/action-form";
import { MonthSelect } from "@/components/business-overview/month-select";
import { usdc } from "@/components/bank/bank-ticker";
import { MONTH_NAMES } from "@/lib/bk-uploads";
import { INVOICE_STATUS } from "@/lib/billing/invoice-status";
import type { Deadline } from "@/lib/services/business-overview";
import type { portalBusinessDashboard } from "@/lib/services/portal-business";
import { portalUploadAction } from "@/app/actions/portal";
import { previewFormAction } from "@/app/actions/preview";
import { PreviewDisabled } from "@/components/portal/preview-off";
import { ActionTiles, NewsList, type NewsItem, type Tile } from "./luxury";
import { BooksProgressCard } from "./books-progress";
import { LiveBankCard, LiveBankKpi, LiveBankProvider, LiveBankTicker } from "./business-live";

type Dash = Awaited<ReturnType<typeof portalBusinessDashboard>>;

const monthName = (ym: string, opts: Intl.DateTimeFormatOptions = { month: "long", year: "numeric" }) => {
  const [y, m] = ym.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString("en-US", { ...opts, timeZone: "UTC" });
};
const dayLabel = (d: string, opts: Intl.DateTimeFormatOptions = { month: "short", day: "numeric", year: "numeric" }) => new Date(`${d}T12:00:00Z`).toLocaleDateString("en-US", { ...opts, timeZone: "UTC" });

// White cards with soft shadows on the cream page; navy feature cards; gold accents; serif headings.
const card = "min-w-0 rounded-2xl border border-gold-200/70 bg-white shadow-[0_1px_2px_rgb(10_26_68/0.05),0_14px_32px_-22px_rgb(10_26_68/0.4)]";
const navyCard = "min-w-0 rounded-2xl bg-gradient-to-br from-navy-900 to-navy-950 text-white shadow-[0_14px_32px_-22px_rgb(10_26_68/0.7)] ring-1 ring-gold-500/40";
const navyBtn = "inline-flex items-center justify-center rounded-lg bg-navy-900 px-4 py-2 text-sm font-semibold text-white shadow hover:bg-navy-800";
const outlineBtn = "inline-flex items-center justify-center rounded-lg border-[1.5px] border-navy-900 bg-white px-4 py-2 text-sm font-semibold text-navy-900 hover:bg-ivory-50";
const textLink = "inline-flex items-center gap-1 text-sm font-semibold text-navy-900 underline decoration-gold-500 underline-offset-4";
const h2 = "font-serif text-lg font-bold text-navy-900";
const h3 = "flex flex-wrap items-center gap-2 font-serif text-base font-bold text-navy-900";
const OFF = "Not available in View as Client";

/** A link, or (in View as Client, where the page has no preview) the same text, disabled. */
function MaybeLink({ href, className, testId, children }: { href: string | null; className: string; testId?: string; children: React.ReactNode }) {
  return href ? (
    <Link href={href} className={className} data-testid={testId}>{children}</Link>
  ) : (
    <span className={clsx(className, "cursor-not-allowed opacity-60")} aria-disabled="true" title={OFF} data-testid={testId} data-disabled="true">{children}</span>
  );
}

function Kpi({ icon: Icon, label, value, change, goodWhenDown = false, note, testId }: { icon: typeof Coins; label: string; value: string; change?: number | null; goodWhenDown?: boolean; note?: string; testId: string }) {
  const up = (change ?? 0) >= 0;
  const good = goodWhenDown ? !up : up;
  return (
    <div className={clsx(card, "flex items-center gap-4 px-5 py-4")} data-testid={testId}>
      <Icon className="size-10 shrink-0 text-gold-600" aria-hidden />
      <div className="min-w-0">
        <p className="text-sm font-medium text-navy-800">{label}</p>
        <p className="truncate font-serif text-2xl font-bold text-navy-900">{value}</p>
        {change != null ? (
          <p className={clsx("flex items-center gap-1 text-xs font-semibold", good ? "text-emerald-700" : "text-red-700")}>
            {up ? <ArrowUp className="size-3.5" aria-hidden /> : <ArrowDown className="size-3.5" aria-hidden />}
            {Math.abs(change).toFixed(1)}% <span className="font-normal text-slate-600">vs last year</span>
          </p>
        ) : note ? (
          <p className="text-xs text-slate-600">{note}</p>
        ) : null}
      </div>
    </div>
  );
}

const DEADLINE_PILL: Record<Deadline["status"], [string, string]> = {
  ON_TRACK: ["On Track", "bg-emerald-50 text-emerald-700"],
  DUE_SOON: ["Due Soon", "bg-red-50 text-red-700"],
  UPCOMING: ["Upcoming", "bg-navy-50 text-navy-800"],
  PAST_DUE: ["Past Due", "bg-red-600 text-white"],
};

const PLAN_TONE: Record<string, string> = {
  green: "bg-emerald-50 text-emerald-700",
  red: "bg-red-50 text-red-700",
  amber: "bg-amber-50 text-amber-800",
  navy: "bg-navy-50 text-navy-800",
  gray: "bg-ivory-100 text-slate-700",
};

function Chart({ perf }: { perf: { month: string; income: number; expenses: number }[] }) {
  const max = Math.max(1, ...perf.flatMap((p) => [p.income, p.expenses]));
  const dollars = max / 100;
  const pow = 10 ** Math.floor(Math.log10(dollars || 1));
  const top = [1, 2, 5, 10].map((k) => k * pow).find((v) => v >= dollars) ?? dollars;
  const ticks = [1, 0.8, 0.6, 0.4, 0.2, 0].map((f) => f * top);
  const fmt = (v: number) => (v >= 1000 ? `$${Math.round(v / 1000)}K` : `$${Math.round(v)}`);
  return (
    <div className="flex gap-2" data-testid="performance-chart">
      <div className="flex h-40 flex-col justify-between pb-6 text-right text-xs text-navy-800">{ticks.map((t) => <span key={t}>{fmt(t)}</span>)}</div>
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="relative flex h-34 items-end justify-around border-b border-l border-ivory-200">
          {perf.map((p) => (
            <div key={p.month} className="flex h-full items-end gap-1" title={`${monthName(p.month)}: income ${usdc(p.income)}, expenses ${usdc(p.expenses)}`}>
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

const STATUS_PILL: Record<ChecklistStatus, string> = {
  NEEDED: "bg-gold-100 text-gold-800",
  UPLOADED: "bg-navy-50 text-navy-800",
  UNDER_REVIEW: "bg-navy-900 text-white",
  ACCEPTED: "bg-emerald-50 text-emerald-700",
  MORE_INFO: "bg-red-50 text-red-700",
};

/**
 * Upload straight from a request: the file is saved to this business, linked to the request, as
 * the request's document type and tax year. The client only picks the month or quarter when the
 * request covers one, and the file.
 */
function RequestUpload({ clientId, item, readOnly }: { clientId: string; item: Dash["checklist"][number]; readOnly?: boolean }) {
  const typed = item.docType && item.period && item.taxYear;
  return (
    <details className="group mt-2">
      <summary className="inline-flex cursor-pointer list-none items-center gap-1.5 rounded-lg border-[1.5px] border-navy-900 bg-white px-3 py-1 text-sm font-semibold text-navy-900 hover:bg-ivory-50" data-testid={`upload-${item.id}`}>
        <Upload className="size-4" aria-hidden /> {item.files ? "Upload another" : "Upload"}
      </summary>
      <PreviewDisabled readOnly={readOnly}>
      <ActionForm action={readOnly ? previewFormAction : portalUploadAction.bind(null, clientId)} className="mt-2 grid gap-2 rounded-xl border border-ivory-200 bg-white p-3 sm:grid-cols-2" resetOnSuccess>
        <input type="hidden" name="requestId" value={item.id} />
        {typed && (
          <>
            <input type="hidden" name="bk" value="1" />
            <input type="hidden" name="docType" value={item.docType!} />
            <input type="hidden" name="periodKind" value={item.period!} />
            <input type="hidden" name="periodYear" value={item.taxYear!} />
          </>
        )}
        {typed && item.period === "MONTH" && (
          <label className="text-sm">Month ({item.taxYear})
            <select className="input mt-1" name="periodMonth" required defaultValue="">{[<option key="" value="" disabled>Choose…</option>, ...MONTH_NAMES.map((m, i) => <option key={m} value={i + 1}>{m}</option>)]}</select>
          </label>
        )}
        {typed && item.period === "QUARTER" && (
          <label className="text-sm">Quarter ({item.taxYear})
            <select className="input mt-1" name="periodQuarter" required defaultValue="">{[<option key="" value="" disabled>Choose…</option>, ...[1, 2, 3, 4].map((q) => <option key={q} value={q}>Q{q}</option>)]}</select>
          </label>
        )}
        <input className="input sm:col-span-2" type="file" name="file" accept="application/pdf,image/png,image/jpeg" required aria-label={`File for ${item.title}`} />
        <button type="submit" className={clsx(navyBtn, "sm:col-span-2")}>Send securely</button>
      </ActionForm>
      </PreviewDisabled>
    </details>
  );
}

/** `readOnly` (View as Client): each upload shows, disabled. */
export function NeedList({ items, clientId, canUpload, readOnly }: { items: Dash["checklist"]; clientId: string; canUpload: boolean; readOnly?: boolean }) {
  return (
    <ul className="mt-2 grid gap-x-6 md:grid-cols-2">
      {items.map((c) => (
        <li key={c.id} className="border-b border-ivory-200 py-3" data-testid="need-item" data-status={c.status}>
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div className="min-w-0">
              <p className="text-sm font-semibold text-navy-900">{c.title}</p>
              <p className="text-xs text-slate-600">{c.fromOffice ? <>Requested by our office{c.why ? ` — ${c.why}` : ""}</> : c.why}{c.dueAt && <> · due {dayLabel(c.dueAt.toISOString().slice(0, 10))}</>}</p>
              {c.files > 0 && <p className="text-xs text-slate-600">{c.files} file{c.files === 1 ? "" : "s"} sent{c.period === "MONTH" && c.months ? ` · ${c.months} month${c.months === 1 ? "" : "s"}` : ""}</p>}
            </div>
            <span className={clsx("shrink-0 rounded-full px-2.5 py-0.5 text-xs font-semibold", STATUS_PILL[c.status])}>{CHECKLIST_STATUS[c.status].label}</span>
          </div>
          {canUpload && c.status !== "ACCEPTED" && <RequestUpload clientId={clientId} item={c} readOnly={readOnly} />}
        </li>
      ))}
    </ul>
  );
}


/**
 * The Managed Business / Bookkeeping Client landing page. `readOnly` is the owner's View as
 * Client: nothing can be uploaded or refreshed, the bank feed isn't polled (its routes need a
 * portal session), portal links open the matching preview page through `previewHref` (or show
 * disabled when there's none), and the packet download is hidden (staff packets include drafts,
 * which the client never sees). Without `readOnly`, links go to the client's own portal pages.
 */
export function BusinessDashboardView({ d, tiles, q, base, linkFor, personalQ, readOnly, previewHref, news }: { d: Dash; tiles: Tile[]; q: string; base: string; linkFor: (id: string) => string; personalQ: string | null; readOnly?: boolean; previewHref?: (path: string, extra?: string) => string | null; news?: NewsItem[] }) {
  // "October 2026", or "Q4 2026" for a quarterly engagement.
  const mName = d.periodLabel;
  const short = monthName(d.selected, { month: "long" });
  const neededCount = d.checklist.filter((c) => c.status === "NEEDED" || c.status === "MORE_INFO").length;
  // Portal: the client's own page for this account. View as Client: the preview page, or null.
  const to = (path: string, extra?: string): string | null => (readOnly ? (previewHref?.(path, extra) ?? null) : `${path}${q}${extra ? `&${extra}` : ""}`);
  // View as Client shows the client's upload buttons too, disabled (the server refuses them anyway).
  const canUpload = d.perms.canUpload;
  const anchor = (href: string | null, id: string) => (href ? `${href}#${id}` : null);
  const ytd = d.figures?.ytd ?? null;
  const ytdNote = d.figures ? undefined : d.isReleased ? "See Financial statements below" : `Shown once ${mName} is released`;
  const yearEndCount = d.yearEndDocs.active ? d.yearEndDocs.items.length : 0;

  return (
    <LiveBankProvider account={d.client.id} initial={d.feed} live={!readOnly}>
      <div className="space-y-5" data-testid="business-dashboard" data-read-only={readOnly ? "true" : undefined}>
        {/* Quick access: the same tiles as the regular business Home, one compact row. */}
        <ActionTiles tiles={tiles} compact />

        {/* 1. Header banner */}
        <section className="relative overflow-hidden rounded-2xl bg-gradient-to-br from-navy-900 via-navy-950 to-navy-900 px-5 py-6 text-white ring-1 ring-gold-500/40 sm:px-8 sm:py-7" data-testid="business-banner">
          <div aria-hidden className="pointer-events-none absolute inset-y-0 right-0 hidden w-[48%] sm:block">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/brand/glass-buildings.jpg" alt="" className="size-full object-cover object-right" />
            <span className="absolute inset-0 bg-gradient-to-r from-navy-950 via-navy-950/30 to-transparent" />
          </div>
          <div className="relative flex flex-wrap items-center justify-between gap-4">
            <div className="flex min-w-0 items-start gap-4 sm:max-w-[62%]">
              <span className="mt-1 hidden size-14 shrink-0 items-center justify-center rounded-lg border-2 border-gold-400 sm:flex"><Building2 className="size-8 text-gold-400" aria-hidden /></span>
              <div className="min-w-0">
                <h1 className="font-serif text-2xl font-bold leading-tight text-white [overflow-wrap:anywhere] sm:text-3xl" data-testid="business-name">{d.client.name}</h1>
                <p className="mt-1.5 flex flex-wrap border-t border-gold-500/40 pt-1.5 text-sm text-navy-100" data-testid="business-services">
                  {d.services.map((s, i) => <span key={s}>{i > 0 && <span className="mx-2 text-gold-400">•</span>}{s}</span>)}
                </p>
                <p className="mt-2.5 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-sm text-navy-100">
                  {d.client.active && <span className="rounded-full bg-emerald-500 px-3 py-0.5 font-semibold text-white" data-testid="active-client">Active Client</span>}
                  {d.client.einLast4 && <span className="rounded-full border border-gold-400/60 px-3 py-0.5 font-medium tabular-nums" data-testid="business-ein">EIN ***-**{d.client.einLast4}</span>}
                  {d.basis && <span>Accounting basis: {d.basis === "ACCRUAL" ? "Accrual" : d.basis === "CASH" ? "Cash" : "Modified cash"}</span>}
                </p>
              </div>
            </div>
            <MonthSelect base={base} value={d.selected} choices={d.monthChoices} labels={d.choiceLabels} />
          </div>
        </section>

        {/* News from our office: the newest pinned or recent announcements (flyers show as the picture). */}
        {news && news.length > 0 && (
          <section className="rounded-2xl border border-gold-200 bg-white px-5 py-2 shadow-sm" aria-labelledby="biz-news-heading" data-testid="business-news">
            <div className="flex items-center justify-between pt-3">
              <h2 id="biz-news-heading" className="font-serif text-lg font-bold text-navy-900">News from our office</h2>
              {to("/client/news") && <Link href={to("/client/news")!} className="text-sm font-semibold text-gold-700 underline">View all</Link>}
            </div>
            <NewsList items={news} href={to("/client/news") ?? "#"} limit={2} />
          </section>
        )}

        {/* 2. Year to date at a glance (released statements only) and the bank balance */}
        <section className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4" aria-label="Year to date at a glance" data-testid="kpis">
          <Kpi icon={TrendingUp} label={`Income (YTD${ytd ? ` ${ytd.year}` : ""})`} value={ytd ? usdc(ytd.income) : "—"} change={ytd?.change.income} note={ytdNote} testId="kpi-income" />
          <Kpi icon={TrendingDown} label={`Expenses (YTD${ytd ? ` ${ytd.year}` : ""})`} value={ytd ? usdc(ytd.expenses) : "—"} change={ytd?.change.expenses} goodWhenDown note={ytdNote} testId="kpi-expenses" />
          <Kpi icon={Coins} label={`Net Profit (YTD${ytd ? ` ${ytd.year}` : ""})`} value={ytd ? usdc(ytd.net) : "—"} change={ytd?.change.net} note={ytdNote} testId="kpi-net" />
          <LiveBankKpi className={clsx(card, "flex items-center gap-4 px-5 py-4")} />
        </section>
        {!d.figures && (
          <p className="-mt-2 text-xs text-slate-600" data-testid="kpi-not-released">
            {d.isReleased
              ? <>Your {mName} statements are released — see <a className="font-semibold underline" href="#statements">Financial statements</a> below.</>
              : <>Your figures appear here once we&apos;ve finished and released {mName}&apos;s statements.</>}
          </p>
        )}

        {/* 3. Monthly Bookkeeping Progress Tracker + Coetha (client-facing status only, from the same stages) */}
        {d.progress && (
          <section className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <BooksProgressCard progress={d.progress} links={{ "what-we-need": "#what-we-need", statements: "#statements" }} everyMonth={to("/client/bookkeeping")} />

            <div className={clsx(navyCard, "flex flex-col p-5")} data-testid="coetha-card">
              <h2 className="flex items-center gap-3 font-serif text-lg font-bold text-white"><Sparkles className="size-6 text-gold-400" aria-hidden /> Coetha | Senior Accountant</h2>
              <p className="ml-9 text-sm text-navy-100">Status update for {d.client.name}</p>
              <p className="mt-4 rounded-xl bg-white px-5 py-4 text-[15px] leading-snug text-navy-900" data-testid="coetha-message">{d.progress.headline}</p>
              {d.perms.canMessage && (
                <MaybeLink href={to("/client/messages")} className="mt-auto inline-flex items-center gap-1 pt-4 text-sm font-semibold text-gold-300 hover:text-gold-200">Message us <ArrowRight className="size-4" aria-hidden /></MaybeLink>
              )}
            </div>
          </section>
        )}

        {/* 4. Payroll, filings, licenses, year-end */}
        <section className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <div className={clsx(card, "flex flex-col p-4")} data-testid="payroll-card">
            <h3 className={h3}>
              <UsersRound className="size-5 text-gold-600" aria-hidden /> Payroll{d.payroll?.provider ? ` (${d.payroll.provider})` : ""}
              {d.payroll && <span className="rounded-full bg-emerald-50 px-2 py-0.5 font-sans text-xs font-semibold text-emerald-700">On Schedule</span>}
            </h3>
            <p className="mt-3 flex-1 text-sm text-navy-900">{!d.payroll ? "Not set up for this account." : d.payroll.next ? <>Next Pay Date: <span className="font-semibold">{dayLabel(d.payroll.next)}</span>{d.payroll.frequency && <><br />{d.payroll.frequency}</>}</> : "We'll show your next pay date here."}</p>
            {d.payroll && <MaybeLink href={to("/client/payroll")} className={clsx(textLink, "mt-3")} testId="view-payroll">View payroll</MaybeLink>}
          </div>
          <div className={clsx(card, "flex flex-col p-4")} data-testid="filings-card">
            <h3 className={h3}>
              <FileSpreadsheet className="size-5 text-gold-600" aria-hidden /> Taxes &amp; Filings
              {d.filings.dueSoon > 0 && <span className="rounded-full bg-red-600 px-2 py-0.5 font-sans text-xs font-semibold text-white">{d.filings.dueSoon} Due</span>}
            </h3>
            <p className="mt-3 flex-1 text-sm text-navy-900">{d.filings.next ? <><span className="font-semibold">{d.filings.next.title}</span><br />Due: {dayLabel(d.filings.next.date)}</> : "No filing deadlines right now."}</p>
            <MaybeLink href={to("/client/tax-center")} className={clsx(navyBtn, "mt-3 w-full")}>View Tax Center</MaybeLink>
          </div>
          <div className={clsx(card, "flex flex-col p-4")} data-testid="licenses-card">
            <h3 className={h3}>
              <IdCard className="size-5 text-gold-600" aria-hidden /> Business Licenses
              {d.licenses.count > 0 && (d.licenses.expired ? <span className="rounded-full bg-red-600 px-2 py-0.5 font-sans text-xs font-semibold text-white">{d.licenses.expired} Expired</span> : <span className="rounded-full bg-emerald-50 px-2 py-0.5 font-sans text-xs font-semibold text-emerald-700">All Current</span>)}
            </h3>
            <p className="mt-3 flex-1 text-sm text-navy-900">{d.licenses.next ? <>Next Renewal: <span className="font-semibold">{dayLabel(d.licenses.next.renewal!)}</span><br />({d.licenses.next.name})</> : d.licenses.count ? "No upcoming renewal dates." : "Not set up — no licenses on file with us yet."}</p>
            <MaybeLink href={to("/client/licenses")} className={clsx(textLink, "mt-3")} testId="view-licenses">View licenses</MaybeLink>
          </div>
          <div className={clsx(card, "flex flex-col p-4")} data-testid="year-end-card">
            <h3 className={h3}>
              <FileBadge className="size-5 text-gold-600" aria-hidden /> 1099 / W-2
              {yearEndCount > 0 && <span className="rounded-full bg-navy-50 px-2 py-0.5 font-sans text-xs font-semibold text-navy-800">{yearEndCount} form{yearEndCount === 1 ? "" : "s"}</span>}
            </h3>
            <div className="mt-3 flex-1 text-sm text-navy-900">
              {d.yearEnd ? <><p className="font-semibold">{d.yearEnd.taxYear} Year-End</p><p className="mt-1 inline-block rounded-full bg-gold-200 px-3 py-0.5 text-xs font-semibold text-navy-900">{d.yearEnd.label}</p></> : <p>Year-end W-2 / 1099 work hasn&apos;t started.</p>}
            </div>
            <MaybeLink href={to("/client/year-end")} className={clsx(textLink, "mt-3")} testId="view-year-end">View 1099 / W-2</MaybeLink>
          </div>
        </section>

        {/* 5. Their invoicing + our account */}
        <section className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <div className={clsx(card, "p-5")} data-testid="client-invoicing">
            <div className="flex items-start gap-3 border-b border-ivory-200 pb-3">
              <ReceiptText className="size-8 shrink-0 text-gold-600" aria-hidden />
              <div>
                <h2 className={h2}>Client Invoicing <span className="font-sans text-sm font-semibold">(Your Customers)</span></h2>
                <p className="text-sm text-navy-800">Invoices we track for your customers.</p>
              </div>
            </div>
            <div className="grid grid-cols-2 divide-x divide-ivory-200 py-4 text-center">
              <div><p className="font-serif text-xl font-bold text-navy-900">{usdc(d.invoicing.openCents)}</p><p className="text-sm text-navy-800">Open Invoices ({d.invoicing.openCount})</p></div>
              <div><p className="font-serif text-xl font-bold text-navy-900">{usdc(d.invoicing.collectedCents)}</p><p className="text-sm text-navy-800">Collected ({short})</p></div>
            </div>
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
              <MaybeLink href={to("/client/invoicing")} className={navyBtn} testId="view-invoices">View invoices</MaybeLink>
              <MaybeLink href={anchor(to("/client/invoicing"), "payments")} className={textLink} testId="payment-history">Payment history</MaybeLink>
              {d.perms.canMessage && <MaybeLink href={anchor(to("/client/invoicing"), "request")} className={outlineBtn} testId="request-invoice">Request an invoice</MaybeLink>}
            </div>
          </div>

          <div className="min-w-0 rounded-2xl border-2 border-gold-400 bg-white p-5 shadow-[0_14px_32px_-24px_rgb(200_157_41/0.7)]" data-testid="my-account">
            <div className="flex items-start gap-3 border-b border-ivory-200 pb-3">
              <FileText className="size-8 shrink-0 text-gold-600" aria-hidden />
              <div>
                <h2 className={h2}>My Account — T. Turner &amp; Associates</h2>
                <p className="text-sm text-navy-800">Your bookkeeping &amp; tax services</p>
              </div>
            </div>
            {d.account ? (
              <div className="mt-3 grid gap-4 sm:grid-cols-[1fr_auto]">
                <div className="min-w-0 space-y-2 sm:border-r sm:border-ivory-200 sm:pr-4">
                  {d.account.plan && (
                    <div data-testid="my-account-plan">
                      <p className="text-sm font-semibold text-navy-900">{d.account.plan.title ?? "Service plan"}</p>
                      <p className="text-sm text-navy-800">{d.account.plan.amountCents != null && <span className="font-serif text-lg font-bold text-navy-900">{usdc(d.account.plan.amountCents)}</span>} {d.account.plan.schedule}</p>
                      <p className="mt-1 flex flex-wrap items-center gap-2 text-xs text-slate-600">
                        {d.account.plan.nextDue && <span>Next due {dayLabel(d.account.plan.nextDue)}</span>}
                        <span className={clsx("rounded-full px-2 py-0.5 font-semibold", PLAN_TONE[d.account.plan.status.tone] ?? PLAN_TONE.gray)}>{d.account.plan.status.label}</span>
                        {d.account.plan.autopay && <span>AutoPay on</span>}
                      </p>
                    </div>
                  )}
                  <div>
                    <p className="font-serif text-xl font-bold text-navy-900" data-testid="my-account-balance">{usdc(d.account.balanceCents)}</p>
                    <p className="text-sm text-navy-800">{d.account.openCount ? `${d.account.openCount} open invoice${d.account.openCount === 1 ? "" : "s"}${d.account.nextDue ? ` · due ${dayLabel(d.account.nextDue)}` : ""}` : "No balance due — you're all set!"}</p>
                    {d.account.latest && <p className="mt-1 text-xs text-slate-600">Latest: {d.account.latest.number}{d.account.latest.title ? ` · ${d.account.latest.title}` : ""} · {d.account.latest.status === "QUOTE_OFFERED" ? "Ready for review" : INVOICE_STATUS[d.account.latest.status as keyof typeof INVOICE_STATUS]?.label ?? ""}</p>}
                  </div>
                </div>
                <div className="flex flex-col gap-2">
                  <MaybeLink href={to("/client/billing")} className="rounded-lg border-[1.5px] border-navy-900 bg-white px-4 py-1.5 text-center text-sm font-semibold text-navy-900 hover:bg-ivory-50">View Invoices</MaybeLink>
                  <MaybeLink href={to("/client/billing")} className="rounded-lg bg-navy-900 px-4 py-1.5 text-center text-sm font-semibold text-white hover:bg-navy-800">Make a Payment</MaybeLink>
                  {d.account.plan && !d.account.plan.autopay && <MaybeLink href={to("/client/billing")} className="rounded-lg border-[1.5px] border-gold-500 bg-white px-4 py-1.5 text-center text-sm font-semibold text-navy-900 hover:bg-gold-50">Set Up AutoPay</MaybeLink>}
                  <MaybeLink href={to("/client/billing")} className="px-1 text-center text-sm font-semibold text-navy-900 underline decoration-gold-500 underline-offset-4">Billing History</MaybeLink>
                </div>
              </div>
            ) : (
              <p className="mt-3 text-sm text-navy-800">Billing for this account is handled by the account owner.</p>
            )}
          </div>
        </section>

        {/* 6. Performance + deadlines */}
        <section className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <div className={clsx(card, "p-5")}>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 className={clsx(h2, "flex items-center gap-2")}><BarChart3 className="size-5 text-gold-600" aria-hidden /> Monthly Performance</h2>
              <p className="flex gap-3 text-xs text-navy-800"><span className="flex items-center gap-1"><span className="size-3 rounded-sm bg-navy-900" />Income</span><span className="flex items-center gap-1"><span className="size-3 rounded-sm bg-gold-500" />Expenses</span></p>
            </div>
            <div className="mt-4">{d.figures && d.figures.perf.length ? <Chart perf={d.figures.perf} /> : <p className="text-sm text-navy-800">The chart fills in as monthly statements are released.</p>}</div>
          </div>
          <div className={clsx(card, "p-5")} data-testid="upcoming-deadlines">
            <h2 className={clsx(h2, "flex items-center gap-2")}><CalendarPlus className="size-5 text-gold-600" aria-hidden /> Upcoming Deadlines</h2>
            {d.deadlines.length ? (
              <ul className="mt-3 divide-y divide-ivory-200">
                {d.deadlines.map((x) => (
                  <li key={`${x.date}${x.title}`} className="flex items-center gap-3 py-2">
                    <span className="w-16 shrink-0 rounded-md bg-gold-200 px-2 py-1 text-center text-xs font-bold uppercase text-navy-950">{dayLabel(x.date, { month: "short", day: "2-digit" })}</span>
                    <span className="min-w-0 flex-1 text-sm font-semibold text-navy-900">{x.title}</span>
                    <span className={clsx("shrink-0 rounded-full px-2.5 py-0.5 text-xs font-semibold", DEADLINE_PILL[x.status][1])}>{DEADLINE_PILL[x.status][0]}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mt-3 text-sm text-navy-800">No upcoming deadlines.</p>
            )}
          </div>
        </section>

        {/* What we need from you */}
        <section id="what-we-need" className={clsx(card, "scroll-mt-20 p-5")} data-testid="business-checklist">
          <div className="flex flex-wrap items-start justify-between gap-3 border-b border-ivory-200 pb-3">
            <div className="flex items-start gap-3">
              <ClipboardCheck className="size-8 shrink-0 text-gold-600" aria-hidden />
              <div>
                <h2 className={h2}>What we need from you — {d.taxYear} bookkeeping</h2>
                <p className="text-sm text-navy-800">{neededCount ? `${neededCount} still needed.` : "Nothing is needed right now. Thank you!"} Only what applies to your business is listed. Uploads save to {d.client.name} only, never your personal files.</p>
              </div>
            </div>
            {personalQ && <Link href={`/client/tax-center/upload${personalQ}`} className={outlineBtn} data-testid="personal-upload">Upload personal tax documents</Link>}
          </div>
          {d.checklist.length === 0 ? <p className="mt-3 text-sm text-navy-800">No documents requested right now.</p> : <NeedList items={d.checklist} clientId={d.client.id} canUpload={canUpload} readOnly={readOnly} />}
        </section>

        {/* Year-End Tax Documents: annual forms only, from January for the prior tax year. */}
        <section id="year-end-docs" className={clsx(card, "scroll-mt-20 p-5")} data-testid="year-end-docs" data-active={d.yearEndDocs.active ? "true" : "false"}>
          <div className="flex items-start gap-3 border-b border-ivory-200 pb-3">
            <FileBadge className="size-8 shrink-0 text-gold-600" aria-hidden />
            <div>
              <h2 className={h2}>Year-End Tax Documents{d.yearEndDocs.active ? ` — ${d.yearEndDocs.taxYear}` : ""}</h2>
              <p className="text-sm text-navy-800">W-2s, 1099s, 1098s and K-1s that apply to your business, asked once a year.</p>
            </div>
          </div>
          {!d.yearEndDocs.active ? (
            <p className="mt-3 text-sm text-navy-800" data-testid="year-end-later">Year-end requests start in {d.yearEndDocs.startsIn}, for the {d.yearEndDocs.taxYear} tax year. Nothing is needed until then.</p>
          ) : d.yearEndDocs.items.length === 0 ? (
            <p className="mt-3 text-sm text-navy-800">No year-end forms apply to your business for {d.yearEndDocs.taxYear}.</p>
          ) : (
            <NeedList items={d.yearEndDocs.items} clientId={d.client.id} canUpload={canUpload} readOnly={readOnly} />
          )}
        </section>

        {/* Bank accounts and transactions + where the books stand */}
        <LiveBankTicker />
        <section className="grid grid-cols-1 gap-4 lg:grid-cols-3">
          <LiveBankCard className={clsx(card, "p-5 lg:col-span-2")} canRefresh={!readOnly} />
          <div className={clsx(card, "p-5")} data-testid="books-status">
            <h2 className={clsx(h2, "flex items-center gap-2")}><Scale className="size-5 text-gold-600" aria-hidden /> Your Books</h2>
            <h3 className="mt-3 text-sm font-semibold text-navy-900">Reconciliation</h3>
            {d.books.reconciliation.length ? (
              <ul className="mt-1 space-y-1 text-sm" data-testid="reconciliation">
                {d.books.reconciliation.map((r) => (
                  <li key={r.name} className="flex flex-wrap items-baseline justify-between gap-x-2">
                    <span className="text-navy-900">{r.name}</span>
                    <span className={r.through ? "text-emerald-700" : "text-slate-600"}>{r.through ? `Reconciled through ${dayLabel(r.through)}` : "Not reconciled yet"}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mt-1 text-sm text-slate-600">Reconciliation status appears once your books are set up.</p>
            )}
            <h3 className="mt-4 text-sm font-semibold text-navy-900">Outstanding items</h3>
            <ul className="mt-1 space-y-1 text-sm text-navy-900" data-testid="outstanding">
              <li>{d.books.openRequests ? <a href="#what-we-need" className="underline decoration-gold-500">{d.books.openRequests} document request{d.books.openRequests === 1 ? "" : "s"} waiting for you</a> : "No document requests waiting"}</li>
              {d.books.questions.map((c) => (
                <li key={c.id}>{d.perms.canMessage ? <MaybeLink href={to("/client/messages", `c=${c.id}`)} className="underline decoration-gold-500">Question: {c.subject}</MaybeLink> : <>Question: {c.subject}</>}{c.responseDueAt && <span className="text-slate-600"> · answer by {dayLabel(c.responseDueAt.toISOString().slice(0, 10))}</span>}</li>
              ))}
              {!d.books.questions.length && <li>No questions from our office</li>}
              {d.books.toCategorize > 0 && <li className="text-slate-600">{d.books.toCategorize} bank transaction{d.books.toCategorize === 1 ? "" : "s"} being categorized by our office</li>}
            </ul>
          </div>
        </section>

        {/* Statements + resources */}
        <section className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <div id="statements" className={clsx(card, "p-5")} data-testid="business-statements">
            <h2 className={clsx(h2, "flex items-center gap-2")}><FileText className="size-5 text-gold-600" aria-hidden /> Financial Statements</h2>
            {d.statements ? (
              <>
                <p className="mt-1 text-sm text-navy-800">Latest released: {monthName(d.statements.month)}</p>
                {readOnly ? (
                  <p className="mt-3 text-xs text-slate-600" data-testid="preview-packet-off">The packet download is turned off in View as Client; each released statement opens below.</p>
                ) : (
                  <div className="mt-3 flex flex-wrap gap-2">
                    {d.statements.types.map((t) => (
                      <a key={t} className={navyBtn} href={`/api/bookkeeping/packet?period=${d.statements!.periodId}&type=${t}&download=1`}>Download {t === "MONTH" ? "monthly" : t === "QUARTER" ? "quarterly" : "year-to-date"} packet (PDF)</a>
                    ))}
                  </div>
                )}
                <ul className="mt-3 space-y-1 text-sm">
                  {d.statements.docs.map((x) => <li key={x.id}><a className="font-semibold text-navy-900 underline decoration-gold-500" href={linkFor(x.id)} target="_blank" rel="noopener">{x.label}</a></li>)}
                </ul>
              </>
            ) : (
              <p className="mt-2 text-sm text-navy-800">Your P&amp;L and Balance Sheet will be here as soon as we release your first month.</p>
            )}
            <MaybeLink href={to("/client/bookkeeping")} className={clsx(textLink, "mt-3")}>All months and reports</MaybeLink>
          </div>
          <div className={clsx(card, "p-5")} data-testid="business-resources">
            <h2 className={clsx(h2, "flex items-center gap-2")}><BookOpen className="size-5 text-gold-600" aria-hidden /> Business Resources</h2>
            {d.resources.length ? (
              <ul className="mt-2 divide-y divide-ivory-200">
                {d.resources.map((r) => (
                  <li key={r.id} className="py-2">
                    <a href={r.url!} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-sm font-semibold text-navy-900 underline decoration-gold-500">{r.title}<ExternalLink className="size-3.5" aria-hidden /></a>
                    <p className="text-xs text-slate-600">{r.agency} — {r.purpose}</p>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mt-2 text-sm text-navy-800">Official sales tax, license and IRS business links are in the Resource Center.</p>
            )}
            <MaybeLink href={to("/client/resources")} className={clsx(outlineBtn, "mt-3")}>Open the Resource Center</MaybeLink>
          </div>
        </section>

        {/* 7. Footer note */}
        <p className="flex items-center gap-2 text-xs text-slate-500" data-testid="figures-note"><Building2 className="size-3.5 shrink-0" aria-hidden /> Figures come only from {d.client.name}&apos;s released statements and its own bank feed.</p>
      </div>
    </LiveBankProvider>
  );
}

