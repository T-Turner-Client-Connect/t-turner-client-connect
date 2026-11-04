import Link from "next/link";
import clsx from "clsx";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { dateLabel, isoWeekday, monthDates } from "@/lib/appointments/availability";
import { STATUS_LABELS } from "@/lib/appointments/services";
import { fmtChicago, utcToChicagoLocal } from "@/lib/tz";

export type CalAppt = {
  id: string;
  title: string;
  status: string;
  startsAt: Date;
  endsAt: Date | null;
  pendingStartsAt: Date | null;
  source: string;
  client: { id: string; displayName: string };
};

export type View = "month" | "week" | "day";

const day = (d: Date) => utcToChicagoLocal(d).slice(0, 10);
const time = (d: Date) => fmtChicago(d, { hour: "numeric", minute: "2-digit" });

export const STATUS_CHIP: Record<string, string> = {
  CONFIRMED: "bg-navy-900 text-white",
  REQUESTED: "bg-amber-100 text-amber-900 ring-1 ring-amber-300",
  RESCHEDULE_REQUESTED: "bg-amber-100 text-amber-900 ring-1 ring-amber-300",
  PROPOSED: "bg-gold-100 text-navy-900 ring-1 ring-gold-400",
  CANCELLED: "bg-slate-100 text-slate-500 line-through",
  DECLINED: "bg-slate-100 text-slate-500 line-through",
  COMPLETED: "bg-emerald-50 text-emerald-800 ring-1 ring-emerald-200",
  NO_SHOW: "bg-red-50 text-red-700 ring-1 ring-red-200",
};

function shift(date: string, days: number) {
  const t = Date.parse(`${date}T00:00:00Z`) + days * 86400_000;
  return new Date(t).toISOString().slice(0, 10);
}
function shiftMonth(date: string, n: number) {
  const [y, m] = date.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1 + n, 1));
  return d.toISOString().slice(0, 10);
}
/** Sunday that starts the week containing `date`. */
export function weekStart(date: string) {
  return shift(date, -(isoWeekday(date) % 7));
}

/** The office-time range [from, to) a view covers. */
export function viewRange(view: View, anchor: string): [string, string] {
  if (view === "day") return [anchor, shift(anchor, 1)];
  if (view === "week") return [weekStart(anchor), shift(weekStart(anchor), 7)];
  const [y, m] = anchor.split("-").map(Number);
  const dates = monthDates(y, m);
  return [dates[0], shift(dates.at(-1)!, 1)];
}

function Chip({ a, href, compact }: { a: CalAppt; href: string; compact?: boolean }) {
  const proposedOnly = a.pendingStartsAt && day(a.pendingStartsAt) !== day(a.startsAt);
  return (
    <Link href={href} className={clsx("block truncate rounded-md px-1.5 py-0.5 text-[11px] font-semibold leading-snug", STATUS_CHIP[a.status] ?? "bg-ivory-100")} title={`${time(a.startsAt)} ${a.client.displayName} — ${STATUS_LABELS[a.status]}`} data-testid="cal-chip">
      {time(a.startsAt)} {compact ? "" : a.client.displayName}
      {proposedOnly ? " ↻" : ""}
    </Link>
  );
}

export function CalendarViews({ view, anchor, appts, base, today, blocked = {}, published }: { view: View; anchor: string; appts: CalAppt[]; base: string; today: string; blocked?: Record<string, string>; published?: boolean | null }) {
  const link = (v: View, d: string, extra = "") => `${base}${base.includes("?") ? "&" : "?"}view=${v}&date=${d}${extra}`;
  const open = (a: CalAppt) => link(view, anchor, `&appt=${a.id}`);
  const byDay = new Map<string, CalAppt[]>();
  for (const a of appts) {
    for (const d of new Set([day(a.startsAt), ...(a.pendingStartsAt ? [day(a.pendingStartsAt)] : [])])) byDay.set(d, [...(byDay.get(d) ?? []), a]);
  }
  const prev = view === "month" ? shiftMonth(anchor, -1) : shift(anchor, view === "week" ? -7 : -1);
  const next = view === "month" ? shiftMonth(anchor, 1) : shift(anchor, view === "week" ? 7 : 1);
  const [y, m] = anchor.split("-").map(Number);
  const title =
    view === "month"
      ? new Intl.DateTimeFormat("en-US", { month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(Date.UTC(y, m - 1, 1)))
      : view === "week"
        ? `Week of ${dateLabel(weekStart(anchor), { month: "long", day: "numeric", year: "numeric" })}`
        : dateLabel(anchor, { weekday: "long", month: "long", day: "numeric", year: "numeric" });

  return (
    <section className="min-w-0 rounded-2xl border border-ivory-200 bg-white p-4 shadow-sm sm:p-5" data-testid={`calendar-${view}`}>
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-1">
          <Link href={link(view, prev)} className="rounded-lg p-2 hover:bg-navy-50" aria-label="Previous"><ChevronLeft className="size-5" /></Link>
          <Link href={link(view, next)} className="rounded-lg p-2 hover:bg-navy-50" aria-label="Next"><ChevronRight className="size-5" /></Link>
        </div>
        <h2 className="min-w-0 flex-1 font-serif text-xl font-bold text-navy-900 sm:text-2xl">{title}</h2>
        {published !== undefined && published !== null && view === "month" && (
          <span className={clsx("rounded-full px-3 py-1 text-xs font-bold", published ? "bg-emerald-50 text-emerald-800 ring-1 ring-emerald-200" : "bg-slate-100 text-slate-600 ring-1 ring-slate-200")}>{published ? "Published" : "Not published"}</span>
        )}
        <nav className="flex rounded-lg bg-navy-50 p-1 text-sm font-semibold" aria-label="Calendar view">
          {(["month", "week", "day"] as const).map((v) => (
            <Link key={v} href={link(v, anchor)} aria-current={v === view ? "page" : undefined} className={clsx("rounded-md px-3 py-1 capitalize", v === view ? "bg-navy-900 text-white" : "text-navy-900 hover:bg-white")}>{v}</Link>
          ))}
          <Link href={link(view, today)} className="rounded-md px-3 py-1 text-navy-900 hover:bg-white">Today</Link>
        </nav>
      </div>

      {view === "month" && (
        <>
          <div className="mt-4 grid grid-cols-7 gap-1 text-center text-[11px] font-semibold uppercase tracking-wide text-slate-500">
            {["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((d) => <span key={d}>{d}</span>)}
          </div>
          <div className="mt-1 grid grid-cols-7 gap-1">
            {Array.from({ length: isoWeekday(`${anchor.slice(0, 8)}01`) % 7 }).map((_, i) => <span key={`b${i}`} />)}
            {monthDates(y, m).map((d) => {
              const list = byDay.get(d) ?? [];
              return (
                <div key={d} className={clsx("min-h-16 min-w-0 rounded-lg border p-1 sm:min-h-24", d === today ? "border-gold-500 bg-gold-50/50" : "border-ivory-200", blocked[d] && "bg-slate-50")}>
                  <Link href={link("day", d)} className="flex items-center justify-between text-xs font-bold text-navy-900">
                    <span>{Number(d.slice(8))}</span>
                    {list.length > 0 && <span className="rounded-full bg-gold-500 px-1.5 text-[10px] text-navy-950 sm:hidden">{list.length}</span>}
                  </Link>
                  {blocked[d] && <p className="truncate text-[10px] font-semibold text-slate-500" title={blocked[d]}>{blocked[d]}</p>}
                  <div className="mt-0.5 hidden space-y-0.5 sm:block">
                    {list.slice(0, 3).map((a) => <Chip key={a.id} a={a} href={open(a)} />)}
                    {list.length > 3 && <Link href={link("day", d)} className="block text-[11px] font-semibold text-navy-700">+{list.length - 3} more</Link>}
                  </div>
                </div>
              );
            })}
          </div>
        </>
      )}

      {view === "week" && (
        <div className="mt-4 grid gap-2 md:grid-cols-7">
          {Array.from({ length: 7 }, (_, i) => shift(weekStart(anchor), i)).map((d) => {
            const list = byDay.get(d) ?? [];
            return (
              <div key={d} className={clsx("min-w-0 rounded-lg border p-2", d === today ? "border-gold-500 bg-gold-50/50" : "border-ivory-200")}>
                <Link href={link("day", d)} className="block text-sm font-bold text-navy-900">{dateLabel(d, { weekday: "short", month: "short", day: "numeric" })}</Link>
                {blocked[d] && <p className="text-[11px] font-semibold text-slate-500">{blocked[d]}</p>}
                <div className="mt-1 space-y-1">
                  {list.length ? list.map((a) => <Chip key={a.id} a={a} href={open(a)} />) : <p className="text-xs text-slate-400">—</p>}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {view === "day" && (
        <div className="mt-4">
          {blocked[anchor] && <p className="mb-2 rounded-lg bg-slate-50 px-3 py-2 text-sm font-semibold text-slate-600">{blocked[anchor]}</p>}
          {(byDay.get(anchor) ?? []).length === 0 ? (
            <p className="py-6 text-center text-sm text-slate-500">No appointments this day.</p>
          ) : (
            <ul className="divide-y divide-ivory-200">
              {(byDay.get(anchor) ?? []).map((a) => {
                const pendingHere = a.pendingStartsAt && day(a.pendingStartsAt) === anchor && day(a.startsAt) !== anchor;
                const at = pendingHere ? a.pendingStartsAt! : a.startsAt;
                return (
                  <li key={a.id}>
                    <Link href={open(a)} className="flex flex-wrap items-center gap-3 py-3 hover:bg-ivory-100 sm:flex-nowrap" data-testid="day-row">
                      <span className="w-24 shrink-0 font-serif text-lg font-bold text-navy-900">{time(at)}</span>
                      <span className="min-w-0 flex-1">
                        <span className="block font-semibold text-navy-900">{a.client.displayName}</span>
                        <span className="block truncate text-sm text-slate-600">{a.title}{a.endsAt ? ` · until ${time(a.endsAt)}` : ""}{pendingHere ? " · requested/proposed new time" : ""}</span>
                      </span>
                      <span className={clsx("shrink-0 rounded-full px-2.5 py-0.5 text-xs font-semibold", STATUS_CHIP[a.status])}>{STATUS_LABELS[a.status]}</span>
                    </Link>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
      <p className="mt-3 flex flex-wrap gap-3 text-[11px] text-slate-600">
        <span className="flex items-center gap-1"><span className="size-2.5 rounded-sm bg-navy-900" />Confirmed</span>
        <span className="flex items-center gap-1"><span className="size-2.5 rounded-sm bg-amber-200" />Awaiting approval</span>
        <span className="flex items-center gap-1"><span className="size-2.5 rounded-sm bg-gold-300" />New time proposed</span>
        <span className="flex items-center gap-1"><span className="size-2.5 rounded-sm bg-slate-200" />Cancelled / declined</span>
      </p>
    </section>
  );
}
