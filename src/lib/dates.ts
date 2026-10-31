// Calendar days for date-only fields (no time of day), in the office's time zone.
// "Today" is the America/Chicago date, whatever the hour or the server's zone.
// Upload and audit timestamps are real instants and are never compared this way.

export const OFFICE_TZ = "America/Chicago";

/** Today's date in Chicago, as YYYY-MM-DD. */
export const chicagoToday = (now = new Date()) => now.toLocaleDateString("en-CA", { timeZone: OFFICE_TZ });

/** The calendar day a date-only value holds: "YYYY-MM-DD" text, or a Date stored at UTC midnight or noon. */
export const calendarDay = (d: Date | string) => (typeof d === "string" ? d.slice(0, 10) : d.toISOString().slice(0, 10));

/** True only for a day after today's Chicago date — today itself is fine at any hour. */
export const isFutureDay = (d: Date | string, now = new Date()) => calendarDay(d) > chicagoToday(now);
