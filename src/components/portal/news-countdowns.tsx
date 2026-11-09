import { splitFlyer } from "@/lib/news/flyers";
import type { Announcement } from "@prisma/client";
import { CalendarClock, Newspaper } from "lucide-react";
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
 * News & Tax Countdowns, built to Tabitha's design: navy banner with the gold megaphone and the
 * mug-and-plant art, Latest News & Announcements beside Tax Countdowns (1040, 1065, 1120-S, 1120)
 * and "Important to Know". Dates come from the deadline engine (official IRS and state sources).
 * "View All News & Updates" lists every announcement in the same panel.
 */
export function NewsAndCountdowns({ cards, news, showAll, allHref }: { cards: CountdownCard[]; news: Announcement[]; personalized?: boolean; showAll?: boolean; allHref?: string }) {
  const lines = cards.flatMap((c) => c.lines);
  const items = news.map((a) => { const f = splitFlyer(a.body); return { id: a.id, title: a.title, body: f.text, flyer: f.flyer, topic: a.topic, clientId: a.clientId, pinned: a.pinned, at: a.publishedAt ?? a.createdAt }; });
  const taxYear = lines.find((l) => l.key === "individual")?.taxYear;
  return (
    <div className="space-y-6" data-testid="news-countdowns">
      <section aria-labelledby="news-heading" className="relative overflow-hidden rounded-2xl bg-gradient-to-r from-navy-950 via-navy-900 to-navy-900 text-white shadow-[0_20px_45px_-28px_rgb(10_26_68/0.7)]">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/brand/news/banner-decor.jpg" alt="" className="absolute inset-y-0 right-0 hidden h-full w-[34%] object-cover [mask-image:linear-gradient(to_right,transparent,black_30%)] md:block" />
        <svg className="pointer-events-none absolute inset-0 h-full w-full" viewBox="0 0 1000 200" preserveAspectRatio="none" aria-hidden>
          <path d="M0 22 C 160 -6, 380 4, 560 10" fill="none" stroke="#C89D29" strokeWidth="4" />
        </svg>
        <div className="relative flex items-center gap-5 px-6 py-8 sm:px-10 sm:py-10 md:max-w-[68%]">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/brand/news/megaphone.png" alt="" width={297} height={289} className="hidden h-24 w-auto shrink-0 drop-shadow-[0_6px_10px_rgb(0_0_0/0.35)] sm:block" />
          <div className="min-w-0">
            <h1 id="news-heading" className="font-serif text-2xl font-bold leading-tight text-white sm:text-3xl">News &amp; Tax Countdowns</h1>
            <p className="mt-2 text-[15px] text-navy-100 sm:text-lg">Stay informed with the latest IRS and state updates, filing <strong className="text-white">deadlines</strong>, and important announcements from our office.</p>
          </div>
        </div>
      </section>

      <div className="grid items-start gap-6 lg:grid-cols-[0.95fr_1.05fr]">
        <section className={luxCard} data-testid="announcements">
          <PanelHead icon={Newspaper} title={showAll ? "All News & Announcements" : "Latest News & Announcements"} />
          <NewsList items={items} href={allHref ?? "#"} limit={showAll ? 500 : 3} full={showAll} />
          {!showAll && items.length > 0 && allHref && (
            <div className="mt-4 text-center">
              <a href={allHref} className="inline-flex rounded-full border-2 border-gold-500 bg-gradient-to-b from-white to-gold-50 px-8 py-2.5 font-semibold text-navy-900 shadow-sm hover:to-gold-100" data-testid="view-all-news">View All News &amp; Updates</a>
            </div>
          )}
        </section>
        <section className={luxCard} data-testid="countdowns-panel">
          <PanelHead icon={CalendarClock} title="Tax Countdowns" action={taxYear ? <span className="rounded-full border-2 border-gold-500 px-4 py-1.5 text-sm font-semibold text-navy-900">Tax Year {taxYear}</span> : undefined} />
          <div className="pt-3"><CountdownCards lines={lines} max={7} /></div>
          <ImportantToKnow>An extension gives you more time to file, not more time to pay.</ImportantToKnow>
        </section>
      </div>
    </div>
  );
}
