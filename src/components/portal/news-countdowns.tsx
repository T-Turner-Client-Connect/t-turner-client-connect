import type { Announcement } from "@prisma/client";
import { countdownText, fmtIso, PAY_NOTE, type CountdownCard, type CountdownLine } from "@/lib/tax/deadlines";
import { TOPICS } from "@/lib/services/news";
import { fmtChicago } from "@/lib/tz";

function Line({ l }: { l: CountdownLine }) {
  return (
    <li className={`rounded-xl p-3 ${l.appliesToYou ? "bg-gold-100/90 ring-2 ring-gold-500" : "bg-white/5"}`} data-testid="countdown-line" data-key={l.key}>
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <p className={`text-sm font-semibold ${l.appliesToYou ? "text-navy-900" : "text-white"}`}>
          {l.label}
          {l.appliesToYou && <span className="ml-2 rounded-full bg-navy-900 px-2 py-0.5 text-[11px] font-bold uppercase tracking-wide text-gold-300">Applies to you</span>}
        </p>
        {l.days !== null && (
          <p className={`font-serif text-lg font-bold ${l.days === 0 ? "text-red-600" : l.appliesToYou ? "text-navy-900" : "text-gold-300"}`} data-testid="countdown-days">
            {countdownText(l.days)}
          </p>
        )}
      </div>
      {l.dueDate ? (
        <p className={`text-sm ${l.appliesToYou ? "text-navy-800" : "text-navy-100"}`}>
          {fmtIso(l.dueDate)}
          {l.taxYear && <> · {l.taxYear} tax year</>}
          {l.timeNote && <> · {l.timeNote}</>}
        </p>
      ) : (
        <p className="text-sm text-navy-100">Next date not published yet — our office is confirming it with the IRS.</p>
      )}
      {l.notes && <p className={`mt-1 hidden text-xs sm:block ${l.appliesToYou ? "text-navy-800" : "text-navy-100"}`}>{l.notes}</p>}
      {l.personal && <p className={`mt-1 text-xs font-semibold ${l.appliesToYou ? "text-navy-900" : "text-gold-300"}`}>{l.personal}</p>}
      <p className={`mt-1 text-[11px] ${l.appliesToYou ? "text-navy-700" : "text-navy-100/80"}`}>
        {l.basis === "VERIFIED" && (
          <>
            General deadline · reviewed {l.reviewedAt ? fmtChicago(l.reviewedAt, { month: "short", day: "numeric", year: "numeric" }) : ""}
            {l.sourceUrl && (
              <>
                {" "}·{" "}
                <a href={l.sourceUrl} target="_blank" rel="noopener noreferrer" className="underline">
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

export function NewsAndCountdowns({ cards, news, personalized }: { cards: CountdownCard[]; news: Announcement[]; personalized: boolean }) {
  return (
    <section aria-labelledby="news-heading" className="overflow-hidden rounded-3xl border border-gold-500/40 bg-gradient-to-br from-navy-950 via-navy-900 to-navy-800 text-white shadow-xl" data-testid="news-countdowns">
      <div className="flex flex-wrap items-end justify-between gap-2 border-b border-gold-500/30 px-5 pb-4 pt-5">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.2em] text-gold-300">Stay on schedule</p>
          <h2 id="news-heading" className="font-serif text-2xl font-bold text-white">News, Updates &amp; Tax Countdowns</h2>
        </div>
        <p className="max-w-md text-xs text-navy-100">
          {personalized ? "Cards marked “Applies to you” use your account details. Others are general deadlines." : "General deadlines."} Dates are reviewed against official IRS and state sources.
        </p>
      </div>
      {/* Phones: swipe through the cards; larger screens: a grid. */}
      <p className="px-5 pt-3 text-xs text-navy-100 sm:hidden" aria-hidden>Swipe for more dates →</p>
      <div className="flex snap-x snap-mandatory items-start gap-3 overflow-x-auto p-4 sm:grid sm:grid-cols-2 sm:overflow-visible xl:grid-cols-3" data-testid="countdown-cards">
        {cards.map((c) => (
          <article key={c.key} className="max-h-[26rem] w-[86%] shrink-0 snap-start overflow-y-auto rounded-2xl sm:max-h-none sm:overflow-visible border border-white/10 bg-white/5 p-4 backdrop-blur sm:w-auto" data-card={c.key}>
            <h3 className="mb-1 font-serif text-lg font-bold text-gold-300">{c.title}</h3>
            {c.intro && <p className="mb-2 text-sm text-navy-100" data-testid={`intro-${c.key}`}>{c.intro}</p>}
            {c.lines.length > 0 && <ul className="space-y-2">{c.lines.map((l) => <Line key={l.key} l={l} />)}</ul>}
            {c.footnote && <p className="mt-3 rounded-lg border border-gold-500/40 bg-gold-500/10 px-3 py-2 text-xs font-semibold text-gold-100">{c.footnote}</p>}
          </article>
        ))}
      </div>
      <p className="px-5 pb-2 text-center text-sm font-semibold text-gold-300" data-testid="pay-note">{PAY_NOTE}</p>
      <div className="border-t border-gold-500/30 bg-navy-950/40 p-4">
        <h3 className="mb-2 font-serif text-lg font-bold text-white">Latest news &amp; updates</h3>
        {news.length === 0 ? (
          <p className="text-sm text-navy-100">No announcements right now.</p>
        ) : (
          <ul className="grid gap-3 md:grid-cols-2" data-testid="announcements">
            {news.slice(0, 6).map((a) => (
              <li key={a.id} className={`rounded-xl border p-3 ${a.pinned ? "border-gold-500 bg-gold-500/10" : "border-white/10 bg-white/5"}`}>
                <p className="text-[11px] font-semibold uppercase tracking-wide text-gold-300">
                  {a.pinned && "📌 Pinned · "}
                  {a.clientId ? "For your account" : TOPICS[(a.topic ?? "GENERAL") as keyof typeof TOPICS] ?? "News"}
                  {a.publishedAt && <> · {fmtChicago(a.publishedAt, { month: "short", day: "numeric", year: "numeric" })}</>}
                </p>
                <p className="font-semibold text-white">{a.title}</p>
                <p className="whitespace-pre-wrap text-sm text-navy-100">{a.body}</p>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
