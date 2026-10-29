import Link from "next/link";
import clsx from "clsx";
import { addDays, endOfMonth, endOfWeek, format, isSameDay, isSameMonth, startOfMonth, startOfWeek } from "date-fns";
import { chicagoParts } from "@/lib/tz";

// Re-express an instant as the same wall-clock time in the server's own zone,
// so events land on their Central-time day whatever zone the server runs in.
const officeWallClock = (d: Date) => {
  const p = chicagoParts(d);
  return new Date(p.year, p.month - 1, p.day, p.hour, p.minute);
};

export type CalendarEvent = { id: string; at: Date; title: string; href?: string; tone?: "navy" | "gold" | "green" | "red" | "gray" };

const TONES = {
  navy: "bg-navy-100 text-navy-900",
  gold: "bg-gold-100 text-gold-700",
  green: "bg-emerald-50 text-emerald-800",
  red: "bg-red-50 text-red-800",
  gray: "bg-slate-100 text-slate-700",
};

/** Month grid on wider screens, an agenda list on phones. */
export function MonthCalendar({ month, events: raw, basePath }: { month: Date; events: CalendarEvent[]; basePath: string }) {
  const events = raw.map((e) => ({ ...e, at: officeWallClock(e.at) }));
  const start = startOfWeek(startOfMonth(month));
  const end = endOfWeek(endOfMonth(month));
  const days: Date[] = [];
  for (let d = start; d <= end; d = addDays(d, 1)) days.push(d);
  const prev = format(addDays(startOfMonth(month), -1), "yyyy-MM");
  const next = format(addDays(endOfMonth(month), 1), "yyyy-MM");
  const today = officeWallClock(new Date());
  const sep = basePath.includes("?") ? "&" : "?";
  const inMonth = events.filter((e) => isSameMonth(e.at, month)).sort((a, b) => a.at.getTime() - b.at.getTime());

  const chip = (e: CalendarEvent) => {
    const cls = clsx("block truncate rounded px-1.5 py-0.5 text-xs font-medium", TONES[e.tone ?? "navy"]);
    return e.href ? <Link key={e.id} href={e.href} className={cls} title={e.title}>{e.title}</Link> : <span key={e.id} className={cls} title={e.title}>{e.title}</span>;
  };

  return (
    <div className="rounded-xl border border-navy-100 bg-white p-3 shadow-sm sm:p-4">
      <div className="mb-3 flex items-center justify-between">
        <Link href={`${basePath}${sep}month=${prev}`} className="rounded-md px-3 py-1.5 text-sm font-semibold hover:bg-navy-50" aria-label="Previous month">←</Link>
        <h2 className="text-lg font-semibold">{format(month, "MMMM yyyy")}</h2>
        <Link href={`${basePath}${sep}month=${next}`} className="rounded-md px-3 py-1.5 text-sm font-semibold hover:bg-navy-50" aria-label="Next month">→</Link>
      </div>
      <div className="hidden grid-cols-7 gap-px overflow-hidden rounded-lg border border-navy-100 bg-navy-100 md:grid">
        {["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((d) => <div key={d} className="bg-navy-50 px-2 py-1 text-xs font-semibold text-slate-600">{d}</div>)}
        {days.map((d) => {
          const dayEvents = events.filter((e) => isSameDay(e.at, d));
          return (
            <div key={d.toISOString()} className={clsx("min-h-24 space-y-1 bg-white p-1.5", !isSameMonth(d, month) && "bg-slate-50 text-slate-400")}>
              <p className={clsx("text-xs font-semibold", isSameDay(d, today) && "inline-block rounded-full bg-navy-900 px-1.5 text-white")}>{format(d, "d")}</p>
              {dayEvents.slice(0, 4).map(chip)}
              {dayEvents.length > 4 && <p className="text-xs text-slate-500">+{dayEvents.length - 4} more</p>}
            </div>
          );
        })}
      </div>
      <ul className="space-y-2 md:hidden">
        {inMonth.length === 0 && <li className="text-sm text-slate-600">Nothing scheduled this month.</li>}
        {inMonth.map((e) => (
          <li key={e.id} className="flex items-center gap-3">
            <span className="w-14 shrink-0 text-sm font-semibold text-navy-900">{format(e.at, "MMM d")}</span>
            {chip(e)}
          </li>
        ))}
      </ul>
    </div>
  );
}

export function monthFromParam(v?: string) {
  const m = v && /^\d{4}-\d{2}$/.test(v) ? new Date(`${v}-01T12:00:00`) : officeWallClock(new Date());
  return Number.isNaN(m.getTime()) ? new Date() : m;
}
