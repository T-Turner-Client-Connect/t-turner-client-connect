import Link from "next/link";
import clsx from "clsx";
import { CheckCircle2, Circle, CircleDot } from "lucide-react";
import { STATUS_LABELS, type BooksProgress, type StageStatus } from "@/lib/services/books-progress";

/**
 * The Monthly Bookkeeping Progress Tracker card on the business dashboard (portal and View as
 * Client). It shows only the stages that apply to this engagement, from computeBooksProgress —
 * the same wording, indicators and links whatever way the month's transactions arrived.
 */

const card = "min-w-0 rounded-2xl border border-gold-200/70 bg-white shadow-[0_1px_2px_rgb(10_26_68/0.05),0_14px_32px_-22px_rgb(10_26_68/0.4)]";
const textLink = "inline-flex items-center gap-1 text-sm font-semibold text-navy-900 underline decoration-gold-500 underline-offset-4";

const PILL: Record<Exclude<StageStatus, "NOT_APPLICABLE">, string> = {
  COMPLETE: "bg-emerald-50 text-emerald-700",
  IN_PROGRESS: "bg-gold-100 text-gold-800",
  NOT_STARTED: "bg-ivory-100 text-slate-600",
};

function Ring({ percent }: { percent: number }) {
  const r = 52;
  const c = 2 * Math.PI * r;
  return (
    <div className="relative size-32 shrink-0" role="img" aria-label={`${percent}% complete`} data-testid="books-progress-ring">
      <svg viewBox="0 0 128 128" className="size-full -rotate-90">
        <circle cx="64" cy="64" r={r} fill="none" stroke="var(--color-navy-900)" strokeWidth="12" />
        {percent > 0 && <circle cx="64" cy="64" r={r} fill="none" stroke="var(--color-gold-500)" strokeWidth="12" strokeDasharray={`${(percent / 100) * c} ${c}`} strokeLinecap="round" />}
      </svg>
      <span className="absolute inset-0 flex flex-col items-center justify-center">
        <span className="font-serif text-xl font-bold text-navy-900">{percent}%</span>
        <span className="text-xs text-navy-800">Complete</span>
      </span>
    </div>
  );
}

function StageIcon({ status }: { status: StageStatus }) {
  if (status === "COMPLETE") return <CheckCircle2 className="size-6 shrink-0 fill-emerald-600 text-white" aria-hidden />;
  if (status === "IN_PROGRESS") return <CircleDot className="size-6 shrink-0 text-gold-600" aria-hidden />;
  return <Circle className="size-6 shrink-0 text-slate-300" aria-hidden />;
}

/** `links`: where each stage's link goes on this page; `everyMonth`: the bookkeeping page (null in View as Client, shown disabled). */
export function BooksProgressCard({ progress, links, everyMonth }: { progress: BooksProgress; links: { "what-we-need": string; statements: string }; everyMonth: string | null }) {
  const p = progress;
  const monthLabel = p.periodLabel;
  const allPeriods = p.periodKind === "QUARTER" ? "See all bookkeeping periods" : "See every month";
  return (
    <div className={clsx(card, "p-5")} data-testid="books-progress" data-percent={p.percent} data-current={p.current ?? "DONE"}>
      <h2 className="font-serif text-lg font-bold text-navy-900">{monthLabel} – Bookkeeping Progress</h2>
      <p className="text-sm text-navy-800">{p.done ? `Every step for ${p.periodKind === "QUARTER" ? "this quarter" : "this month"} is complete.` : `${p.completed} of ${p.applicable} steps complete`}</p>
      <div className="mt-3 flex flex-wrap items-start gap-5">
        <Ring percent={p.percent} />
        <ol className="min-w-0 flex-1 basis-64" aria-label={`${monthLabel} bookkeeping steps`}>
          {p.stages.map((s, i) => {
            const last = i === p.stages.length - 1;
            const href = s.link ? links[s.link] : null;
            return (
              <li key={s.key} className="relative flex gap-3 pb-3 last:pb-0" data-testid="books-stage" data-stage={s.key} data-status={s.status} aria-current={p.current === s.key ? "step" : undefined}>
                {!last && <span aria-hidden className={clsx("absolute left-[11px] top-7 h-[calc(100%-1.75rem)] w-0.5", s.status === "COMPLETE" ? "bg-emerald-600" : "bg-ivory-200")} />}
                <StageIcon status={s.status} />
                <div className="min-w-0 flex-1">
                  <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm font-semibold text-navy-900">
                    <span>{i + 1}. {s.label}</span>
                    <span className={clsx("rounded-full px-2 py-0.5 text-xs font-semibold", PILL[s.status as keyof typeof PILL])} data-testid="books-stage-status">{STATUS_LABELS[s.status as keyof typeof STATUS_LABELS]}</span>
                  </p>
                  <p className="text-xs text-slate-600" data-testid="books-stage-detail">{s.detail}</p>
                  {href && s.status !== "NOT_STARTED" && (
                    <a href={href} className="text-xs font-semibold text-navy-900 underline decoration-gold-500 underline-offset-4" data-testid={`books-stage-link-${s.key}`}>
                      {s.link === "what-we-need" ? "See what we need" : "View financial statements"}
                    </a>
                  )}
                </div>
              </li>
            );
          })}
        </ol>
      </div>
      {everyMonth ? (
        <Link href={everyMonth} className={clsx(textLink, "mt-3")}>{allPeriods}</Link>
      ) : (
        <span className={clsx(textLink, "mt-3 cursor-not-allowed opacity-60")} aria-disabled="true" title="Not available in View as Client" data-disabled="true">{allPeriods}</span>
      )}
    </div>
  );
}
