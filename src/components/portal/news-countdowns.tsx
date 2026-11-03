import type { Announcement } from "@prisma/client";
import { CalendarClock, Megaphone, Newspaper } from "lucide-react";
import { countdownText, fmtIso, PAY_NOTE, type CountdownCard, type CountdownLine } from "@/lib/tax/deadlines";
import { TOPICS } from "@/lib/services/news";
import { fmtChicago } from "@/lib/tz";
import { CountdownCards, ImportantToKnow, luxCard, NewsList, PanelHead } from "./luxury";

/** One deadline row — client-specific dates are highlighted in gold and labeled. */
function Line({ l }: { l: CountdownLine }) {
  return (
    <li className={`rounded-xl border p-3 ${l.appliesToYou ? "border-gold-500 bg-gold-50 ring-1 ring-gold-400/50" : "border-ivory-200 bg-white"}`} data-testid="countdown-line" data-key={l.key}>
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <p className="text-sm font-semibold text-navy-900">
          {l.label}
          {l.appliesToYou && <span className="ml-2 rounded-full bg-navy-900 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-gold-300">Applies to you</span>}
        </p>
        {l.days !== null && (
          <p className={`font-serif text-lg font-bold ${l.days === 0 ? "text-red-700" : "text-gold-700"}`} data-testid="countdown-days">
            {countdownText(l.days)}
          </p>
        )}
      </div>
      {l.dueDate ? (
        <p className="text-sm text-navy-800">
          {fmtIso(l.dueDate)}
          {l.taxYear && <> · {l.taxYear} tax year</>}
          {l.timeNote && <> · {l.timeNote}</>}
        </p>
      ) : (
        <p className="text-sm text-slate-600">Next date not published yet — our office is confirming it with the IRS.</p>
      )}
      {l.notes && <p className="mt-1 text-xs text-slate-600">{l.notes}</p>}
      {l.personal && <p className="mt-1 text-xs font-semibold text-navy-900">{l.personal}</p>}
      <p className="mt-1 text-[11px] text-slate-500">
        {l.basis === "VERIFIED" && (
          <>
            General deadline · reviewed {l.reviewedAt ? fmtChicago(l.reviewedAt, { month: "short", day: "numeric", year: "numeric" }) : ""}
            {l.sourceUrl && (
              <>
                {" "}·{" "}
                <a href={l.sourceUrl} target="_blank" rel="noopener noreferrer" className="underline decoration-gold-500">
                  Source: {new URL(l.sourceUrl).hostname.replace(/^www\./, "")} ↗
                </a>
              </>
            )}
          </>
        )}
        {l.basis === "CALCULATED" && "Calculated from IRS rules for your fiscal year — our office will confirm your exact date."}
      </p>
    </li>
  );
}

/**
 * News & Tax Countdowns: a refined navy banner, the latest announcements beside the headline
 * federal countdowns, then every deadline in detail and the full news archive. Dates all come
 * from the deadline engine (reviewed against official IRS and state sources).
 */
export function NewsAndCountdowns({ cards, news, personalized }: { cards: CountdownCard[]; news: Announcement[]; personalized: boolean }) {
  const lines = cards.flatMap((c) => c.lines);
  const items = news.map((a) => ({ id: a.id, title: a.title, body: a.body, topic: a.topic, clientId: a.clientId, pinned: a.pinned, at: a.publishedAt ?? a.createdAt }));
  return (
    <div className="space-y-6" data-testid="news-countdowns">
      <section aria-labelledby="news-heading" className="relative overflow-hidden rounded-[2rem] bg-gradient-to-r from-navy-950 via-navy-900 to-navy-800 px-6 py-7 text-white shadow-[0_20px_45px_-28px_rgb(10_26_68/0.7)] sm:px-10 sm:py-9">
        <svg className="pointer-events-none absolute inset-0 h-full w-full" viewBox="0 0 1000 200" preserveAspectRatio="none" aria-hidden>
          <path d="M0 30 C 120 -5, 300 0, 420 12" fill="none" stroke="#C89D29" strokeWidth="3" opacity="0.9" />
          <path d="M520 200 C 700 190, 880 170, 1000 120" fill="none" stroke="#E6C76A" strokeWidth="3" opacity="0.8" />
        </svg>
        <div className="relative flex items-center gap-4 sm:gap-6">
          <span className="hidden size-16 shrink-0 items-center justify-center rounded-2xl border border-gold-500/60 bg-white/5 sm:flex">
            <Megaphone className="size-9 text-gold-400" aria-hidden />
          </span>
          <div className="min-w-0">
            <h1 id="news-heading" className="font-serif text-3xl font-bold leading-tight text-white sm:text-4xl">News &amp; Tax Countdowns</h1>
            <p className="mt-2 max-w-2xl text-sm text-navy-100 sm:text-base">Stay informed with the latest IRS and state updates, filing deadlines, and important announcements from our office.</p>
          </div>
        </div>
      </section>

      <div className="grid gap-6 lg:grid-cols-2">
        <section className={luxCard}>
          <PanelHead icon={Newspaper} title="Latest News & Announcements" />
          <NewsList items={items} href="#all-news" limit={3} />
          {items.length > 3 && (
            <div className="mt-4 text-center">
              <a href="#all-news" className="inline-flex rounded-full border border-gold-500 bg-gradient-to-b from-white to-gold-50 px-6 py-2 font-serif text-base font-bold text-navy-900 shadow-sm hover:to-gold-100">View All News &amp; Updates</a>
            </div>
          )}
        </section>
        <section className={luxCard}>
          <PanelHead icon={CalendarClock} title="Tax Countdowns" />
          <div className="pt-3"><CountdownCards lines={lines} max={4} /></div>
          <ImportantToKnow>An extension gives you more time to file, not more time to pay.</ImportantToKnow>
        </section>
      </div>

      <section className={luxCard} aria-labelledby="all-deadlines">
        <div className="mb-4 flex flex-wrap items-end justify-between gap-2">
          <h2 id="all-deadlines" className="font-serif text-2xl font-bold text-navy-900">Every deadline in detail</h2>
          <p className="max-w-md text-xs text-slate-600">
            {personalized ? "Dates marked “Applies to you” use your account details. Others are general deadlines." : "General deadlines."} Dates are reviewed against official IRS and state sources.
          </p>
        </div>
        <div className="grid items-start gap-4 sm:grid-cols-2 xl:grid-cols-3" data-testid="deadline-groups">
          {cards.map((c) => (
            <article key={c.key} className="rounded-2xl border border-gold-200 bg-ivory-50/60 p-4" data-card={c.key}>
              <h3 className="mb-1 font-serif text-lg font-bold text-navy-900">{c.title}</h3>
              {c.intro && <p className="mb-2 text-sm text-slate-600" data-testid={`intro-${c.key}`}>{c.intro}</p>}
              {c.lines.length > 0 && <ul className="space-y-2">{c.lines.map((l) => <Line key={l.key} l={l} />)}</ul>}
              {c.footnote && <p className="mt-3 rounded-lg border border-gold-300 bg-gold-50 px-3 py-2 text-xs font-semibold text-navy-900">{c.footnote}</p>}
            </article>
          ))}
        </div>
        <p className="mt-4 text-center text-sm font-semibold text-gold-700" data-testid="pay-note">{PAY_NOTE}</p>
      </section>

      <section id="all-news" className={luxCard} aria-labelledby="all-news-heading">
        <h2 id="all-news-heading" className="mb-3 font-serif text-2xl font-bold text-navy-900">All News &amp; Updates</h2>
        {news.length === 0 ? (
          <p className="text-sm text-slate-600">No announcements right now.</p>
        ) : (
          <ul className="grid gap-3 md:grid-cols-2" data-testid="announcements">
            {news.map((a) => (
              <li key={a.id} className={`rounded-2xl border p-4 ${a.pinned ? "border-gold-500 bg-gold-50" : "border-ivory-200 bg-white"}`}>
                <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-gold-700">
                  {a.pinned && "Pinned · "}
                  {a.clientId ? "For your account" : TOPICS[(a.topic ?? "GENERAL") as keyof typeof TOPICS] ?? "News"}
                  {a.publishedAt && <> · {fmtChicago(a.publishedAt, { month: "short", day: "numeric", year: "numeric" })}</>}
                </p>
                <p className="mt-1 font-serif text-lg font-bold text-navy-900">{a.title}</p>
                <p className="mt-1 whitespace-pre-wrap text-sm text-navy-800">{a.body}</p>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
