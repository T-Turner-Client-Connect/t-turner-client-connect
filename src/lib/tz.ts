// Office time zone helpers. All scheduling is in America/Chicago, including
// daylight saving, regardless of the server's own time zone (UTC on Netlify).
export const OFFICE_TZ = "America/Chicago";

function parts(d: Date) {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone: OFFICE_TZ, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", weekday: "short" })
      .formatToParts(d)
      .map((x) => [x.type, x.value]),
  );
  return { year: +p.year, month: +p.month, day: +p.day, hour: +p.hour, minute: +p.minute, second: +p.second, weekday: p.weekday as string };
}

/** Offset (ms) between Chicago wall time and UTC at this instant. */
function offsetAt(d: Date) {
  const p = parts(d);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(d.getTime() / 1000) * 1000;
}

/** "2026-11-03T11:30" read as Chicago wall time → UTC instant. */
export function chicagoLocalToUtc(local: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(local);
  if (!m) return null;
  const guess = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
  let t = guess - offsetAt(new Date(guess));
  t = guess - offsetAt(new Date(t)); // second pass settles DST boundaries
  return new Date(t);
}

/** UTC instant → "YYYY-MM-DDTHH:mm" Chicago wall time (for datetime-local inputs). */
export function utcToChicagoLocal(d: Date): string {
  const p = parts(d);
  const z = (n: number) => String(n).padStart(2, "0");
  return `${p.year}-${z(p.month)}-${z(p.day)}T${z(p.hour)}:${z(p.minute)}`;
}

export function chicagoParts(d: Date) {
  return parts(d);
}

export function fmtChicago(d: Date, opts: Intl.DateTimeFormatOptions = { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" }) {
  return new Intl.DateTimeFormat("en-US", { timeZone: OFFICE_TZ, ...opts }).format(d);
}
