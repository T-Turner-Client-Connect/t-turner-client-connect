import Link from "next/link";
import { Building2, CalendarDays, ChevronRight, ExternalLink, HandHeart, Handshake, Info, Landmark, Users } from "lucide-react";
/** "2027-04-15" → "Apr 15, 2027" (date only, no time-zone shift). */
const shortDate = (iso: string) => { const [y, m, d] = iso.split("-").map(Number); return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" }); };

/** Shared navy · gold · white pieces for the portal home and the News & Tax Countdowns page. */

export const luxCard = "min-w-0 rounded-3xl border border-gold-200/70 bg-white/95 p-5 shadow-[0_1px_2px_rgb(10_26_68/0.05),0_18px_40px_-24px_rgb(10_26_68/0.35)] sm:p-7";

export type Tile = { title: string; sub: string; icon: React.ComponentType<{ className?: string }>; href: string | null; external?: boolean; testId: string; disabledNote?: string };

/**
 * Headline actions, alternating navy and white like the reference design. `compact`: one slimmer
 * row for the business dashboard (7 across on wide screens, 4 on tablets, 2 columns on phones).
 */
export function ActionTiles({ tiles, compact = false }: { tiles: Tile[]; compact?: boolean }) {
  return (
    <div className={compact ? "grid grid-cols-2 gap-2.5 sm:grid-cols-4 xl:grid-cols-7" : "grid gap-3 sm:grid-cols-2 lg:grid-cols-5"} data-testid="action-tiles">
      {tiles.map((t, i) => {
        const navy = i % 2 === 0;
        const body = (
          <>
            <t.icon className={`${compact ? "size-7 xl:size-6" : "size-10"} shrink-0 ${navy ? "text-gold-400" : "text-gold-600"}`} aria-hidden />
            <span className="min-w-0 flex-1">
              <span className={`block font-serif ${compact ? "text-[15px] xl:text-sm" : "text-[17px]"} font-bold leading-snug ${navy ? "text-white" : "text-navy-900"}`}>{t.title}</span>
              <span className={`mt-0.5 ${compact ? "block text-xs xl:hidden" : "block text-[13px]"} leading-snug ${navy ? "text-navy-100" : "text-slate-600"}`}>{t.disabledNote ?? t.sub}</span>
            </span>
            {t.href && <ChevronRight className={`${compact ? "size-4 xl:hidden" : "size-5"} shrink-0 transition group-hover:translate-x-0.5 ${navy ? "text-gold-400" : "text-gold-600"}`} aria-hidden />}
          </>
        );
        const cls = `group flex ${compact ? "min-h-[4.75rem] gap-2 px-3 py-3" : "min-h-[6.5rem] gap-3 px-4 py-4"} items-center rounded-2xl shadow-[0_10px_24px_-16px_rgb(10_26_68/0.55)] transition hover:-translate-y-0.5 hover:shadow-[0_16px_30px_-18px_rgb(10_26_68/0.6)] ${
          navy ? "bg-gradient-to-br from-navy-900 to-navy-950 ring-1 ring-gold-500/40" : "border border-gold-200 bg-white"
        }`;
        // Outside links (the questionnaire redirect, official sites) are plain links: no in-app prefetch.
        return t.href && t.external ? (
          <a key={t.testId} href={t.href} className={cls} data-testid={t.testId} target="_blank" rel="noopener noreferrer">
            {body}
          </a>
        ) : t.href ? (
          <Link key={t.testId} href={t.href} className={cls} data-testid={t.testId}>
            {body}
          </Link>
        ) : (
          <div key={t.testId} className={`${cls} cursor-not-allowed opacity-60`} aria-disabled="true" title={t.disabledNote} data-testid={t.testId} data-disabled="true">
            {body}
          </div>
        );
      })}
    </div>
  );
}

export type NewsItem = { id: string; title: string; body: string; topic: string | null; clientId: string | null; pinned: boolean; at?: Date | null; sourceUrl?: string | null };

function topicLook(n: NewsItem) {
  const t = (n.topic ?? "").toUpperCase();
  const title = n.title.toLowerCase();
  if (n.clientId) return { img: "/brand/news/office.jpg", label: "For your account" };
  if (t.includes("STATE") || /\b(alabama|state tax|department of revenue)\b/.test(title)) return { img: "/brand/news/state.jpg", label: "State" };
  if (t.includes("IRS") || t === "TAX_SEASON" || t === "DEADLINE" || /\birs\b/.test(title)) return { img: "/brand/news/irs.jpg", label: t === "DEADLINE" ? "Deadline" : "IRS" };
  return { img: "/brand/news/office.jpg", label: "Office" };
}

/** One elegant row per announcement: emblem, headline, short summary, arrow. */
export function NewsList({ items, href, limit = 3, full }: { items: NewsItem[]; href: string; limit?: number; full?: boolean }) {
  if (!items.length) return <p className="py-6 text-sm text-slate-600">No announcements right now. New IRS, state and office updates will appear here.</p>;
  return (
    <ul className="divide-y divide-gold-100" data-testid="news-list">
      {items.slice(0, limit).map((n) => {
        const look = topicLook(n);
        return (
          <li key={n.id}>
            <Link href={href} className="group flex items-center gap-4 py-4">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={look.img} alt="" width={128} height={82} className="h-16 w-24 shrink-0 rounded-xl object-cover shadow-sm ring-1 ring-gold-200 sm:h-20 sm:w-32" />
              <span className="min-w-0 flex-1">
                <span className="block font-serif text-[17px] font-bold leading-snug text-navy-900 [overflow-wrap:anywhere]">{n.title}</span>
                <span className={`mt-1 block text-sm text-slate-700 ${full ? "whitespace-pre-wrap" : "line-clamp-2"}`}>{n.body}</span>
                <span className="mt-1 block text-[11px] font-semibold uppercase tracking-[0.14em] text-gold-700">
                  {n.pinned ? "Pinned · " : ""}
                  {look.label}
                  {n.at ? ` · ${n.at.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "America/Chicago" })}` : ""}
                </span>
              </span>
              <ChevronRight className="size-5 shrink-0 text-gold-600 transition group-hover:translate-x-0.5" aria-hidden />
            </Link>
          </li>
        );
      })}
    </ul>
  );
}

export type CountdownLine = { key: string; label: string; form?: string | null; dueDate: string | null; days: number | null; appliesToYou?: boolean };

const FORMS: { key: string; form: string; who: string; icon: React.ComponentType<{ className?: string }> }[] = [
  { key: "individual", form: "Form 1040", who: "Individuals", icon: Users },
  { key: "PARTNERSHIP", form: "Form 1065", who: "Partnerships", icon: Handshake },
  { key: "S_CORP", form: "Form 1120-S", who: "S Corporations", icon: Building2 },
  { key: "C_CORP", form: "Form 1120", who: "C Corporations", icon: Building2 },
  { key: "TRUST_ESTATE", form: "Form 1041", who: "Estates & Trusts", icon: Landmark },
  { key: "NONPROFIT_990", form: "Form 990 / 990-EZ", who: "Nonprofits", icon: HandHeart },
  { key: "NONPROFIT_990N", form: "Form 990-N", who: "Small Nonprofits", icon: HandHeart },
];

/** IRS forms, instructions and publications (official site, new tab). */
export const IRS_FORMS_URL = "https://www.irs.gov/forms-instructions";

/**
 * The headline federal filing countdowns (from the same deadline engine as before — dates are
 * never typed in here). A card that applies to this client is marked "Your deadline".
 */
export function CountdownCards({ lines, max = 4 }: { lines: CountdownLine[]; max?: number }) {
  const cards = FORMS.map((f) => ({ ...f, line: lines.find((l) => l.key === f.key) })).filter((c) => c.line && c.line.dueDate && c.line.days !== null).slice(0, max);
  if (!cards.length) return <p className="py-6 text-sm text-slate-600">Deadlines will appear here once the IRS confirms the next filing season.</p>;
  return (
    <>
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 2xl:grid-cols-4" data-testid="countdown-cards">
      {cards.map((c) => (
        <div key={c.key} className={`flex flex-col overflow-hidden rounded-2xl border bg-white text-center shadow-sm ${c.line!.appliesToYou ? "border-gold-500 ring-2 ring-gold-400/40" : "border-gold-200"}`} data-testid={`countdown-${c.key}`}>
          <div className="flex flex-1 flex-col items-center px-1.5 pb-3 pt-4 sm:px-3">
            <c.icon className="size-7 text-gold-600" aria-hidden />
            <p className="mt-2 font-serif text-sm font-bold leading-tight text-navy-900 sm:text-base">{c.form}</p>
            <p className="text-[11px] text-slate-600 sm:text-xs">({c.who})</p>
            <p className="mt-2 font-serif text-3xl font-bold leading-none text-gold-600 sm:text-4xl">{c.line!.days}</p>
            <p className="text-sm font-semibold text-gold-700">{c.line!.days === 1 ? "Day Left" : "Days Left"}</p>
            {c.line!.appliesToYou && <span className="mt-2 rounded-full bg-gold-100 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-gold-800">Your deadline</span>}
          </div>
          <div className="flex items-center justify-center gap-1 whitespace-nowrap bg-navy-900 px-1 py-2 text-[11px] font-semibold text-white sm:gap-1.5 sm:px-2 sm:text-sm">
            <CalendarDays className="hidden size-4 text-gold-400 sm:block" aria-hidden />
            {shortDate(c.line!.dueDate!)}
          </div>
        </div>
      ))}
    </div>
    <p className="mt-3 text-center text-sm"><a href={IRS_FORMS_URL} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 font-semibold text-navy-900 underline decoration-gold-500 underline-offset-2" data-testid="irs-forms-link">View all IRS forms &amp; publications <ExternalLink className="size-3.5" aria-hidden /></a></p>
    </>
  );
}

export function ImportantToKnow({ children }: { children: React.ReactNode }) {
  return (
    <div className="mt-4 flex items-start gap-3 rounded-2xl border border-gold-300 bg-gold-50/70 px-4 py-3">
      <Info className="mt-0.5 size-6 shrink-0 text-gold-600" aria-hidden />
      <div>
        <p className="font-serif text-base font-bold text-navy-900">Important to Know</p>
        <p className="text-sm text-navy-800">{children}</p>
      </div>
    </div>
  );
}

export function PanelHead({ icon: Icon, title, action }: { icon: React.ComponentType<{ className?: string }>; title: string; action?: React.ReactNode }) {
  return (
    <div className="mb-2 flex flex-wrap items-center justify-between gap-3 border-b border-gold-100 pb-4">
      <h2 className="flex items-center gap-3 font-serif text-xl sm:text-xl font-bold text-navy-900">
        <span className="flex size-11 items-center justify-center rounded-xl border border-gold-300 bg-gold-50"><Icon className="size-6 text-gold-600" aria-hidden /></span>
        {title}
      </h2>
      {action}
    </div>
  );
}



/**
 * Light page header from the approved designs: gold outline icon, serif title, subtitle, and a
 * navy-and-gold swoosh along the right edge.
 */
export function PageBanner({ icon: Icon, title, subtitle }: { icon: React.ComponentType<{ className?: string }>; title: string; subtitle: string }) {
  return (
    <section className="relative -mx-4 -mt-6 mb-6 overflow-hidden border-b border-ivory-200 bg-gradient-to-r from-ivory-50 via-white to-white px-4 py-6 sm:-mx-6 sm:px-8" data-testid="page-banner">
      <svg className="pointer-events-none absolute inset-y-0 right-0 hidden h-full w-[48%] md:block" viewBox="0 0 600 130" preserveAspectRatio="none" aria-hidden>
        <path d="M0 130 C 220 120, 380 70, 600 22 L 600 130 Z" fill="#0A1A44" />
        <path d="M60 130 C 260 112, 420 58, 600 6" fill="none" stroke="#C89D29" strokeWidth="10" />
        <path d="M0 126 C 240 116, 400 74, 600 30" fill="none" stroke="#E6C76A" strokeWidth="3" opacity="0.8" />
      </svg>
      <div className="relative flex items-center gap-4 sm:gap-5 md:max-w-[60%]">
        <Icon className="size-10 shrink-0 text-gold-500 sm:size-14" aria-hidden />
        <div className="min-w-0">
          <h1 className="font-serif text-2xl font-bold leading-tight text-navy-900 sm:text-3xl">{title}</h1>
          <p className="mt-1 text-[15px] text-navy-800 sm:text-lg">{subtitle}</p>
        </div>
      </div>
    </section>
  );
}

/** Navy-headed card used by the approved designs (Contact Our Office, Recent Messages, …). */
export function NavyCard({ icon: Icon, title, children, className = "" }: { icon: React.ComponentType<{ className?: string }>; title: string; children: React.ReactNode; className?: string }) {
  return (
    <section className={`min-w-0 overflow-hidden rounded-2xl border border-ivory-200 bg-white shadow-[0_14px_32px_-24px_rgb(10_26_68/0.45)] ${className}`}>
      <h2 className="flex items-center gap-3 bg-navy-900 px-5 py-3.5 font-serif text-lg font-bold text-white sm:text-xl">
        <Icon className="size-6 shrink-0 text-white" aria-hidden />
        {title}
      </h2>
      <div className="p-4 sm:p-5">{children}</div>
    </section>
  );
}
