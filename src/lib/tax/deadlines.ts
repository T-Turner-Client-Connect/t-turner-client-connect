/**
 * Tax countdowns. Dates are calendar dates ("YYYY-MM-DD") so they never
 * shift with time zones. Clients only see dates Tabitha has reviewed (a
 * TaxDeadline row with a source link and review date); the IRS rules below
 * are used to suggest next year's dates for review and to calculate
 * fiscal-year dates, which are always labeled as calculated.
 *
 * Rules (IRS Publication 509): partnerships (1065) and S corporations
 * (1120-S) are due the 15th day of the 3rd month after the tax year ends;
 * individuals (1040) and C corporations (1120) the 15th day of the 4th month.
 * An automatic extension adds 6 months. A due date on a Saturday, Sunday or
 * District of Columbia legal holiday moves to the next business day.
 */

export const RETURN_KINDS = {
  INDIVIDUAL: { label: "Individuals", form: "Form 1040", months: 4, extForm: "Form 4868" },
  PARTNERSHIP: { label: "Partnerships", form: "Form 1065", months: 3, extForm: "Form 7004" },
  S_CORP: { label: "S corporations", form: "Form 1120-S", months: 3, extForm: "Form 7004" },
  C_CORP: { label: "C corporations", form: "Form 1120", months: 4, extForm: "Form 7004" },
} as const;
export type ReturnKind = keyof typeof RETURN_KINDS;
export const RETURN_KIND_KEYS = Object.keys(RETURN_KINDS) as ReturnKind[];

export const DEADLINE_KIND_LABELS: Record<string, string> = {
  TAX_SEASON_OPENS: "Tax season opens (IRS starts accepting returns)",
  ...Object.fromEntries(RETURN_KIND_KEYS.flatMap((k) => [
    [k, `${RETURN_KINDS[k].label} — ${RETURN_KINDS[k].form} due`],
    [`${k}_EXTENDED`, `${RETURN_KINDS[k].label} — ${RETURN_KINDS[k].form} due with a valid extension`],
  ])),
};
export const isDeadlineKind = (k: string) => k in DEADLINE_KIND_LABELS;

export const ENTITY_TYPES = {
  SOLE_PROPRIETOR: "Sole proprietor / single-member LLC (Schedule C)",
  PARTNERSHIP: "Partnership / multi-member LLC (Form 1065)",
  S_CORP: "S corporation (Form 1120-S)",
  C_CORP: "C corporation (Form 1120)",
  NONPROFIT: "Nonprofit (Form 990)",
  TRUST_ESTATE: "Trust or estate (Form 1041)",
} as const;

export const PAY_NOTE = "An extension to file generally does not extend the time to pay.";

// --- Calendar math (UTC, date-only) ---------------------------------------

const pad = (n: number) => String(n).padStart(2, "0");
export const iso = (y: number, m: number, d: number) => `${y}-${pad(m)}-${pad(d)}`;
const toDate = (s: string) => new Date(`${s}T00:00:00Z`);
const fromDate = (d: Date) => iso(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
const weekday = (s: string) => toDate(s).getUTCDay();
export const addDays = (s: string, n: number) => fromDate(new Date(toDate(s).getTime() + n * 86400_000));

function nthWeekday(y: number, m: number, dow: number, n: number) {
  const first = new Date(Date.UTC(y, m - 1, 1)).getUTCDay();
  return iso(y, m, 1 + ((dow - first + 7) % 7) + (n - 1) * 7);
}
function lastWeekday(y: number, m: number, dow: number) {
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const last = new Date(Date.UTC(y, m - 1, lastDay)).getUTCDay();
  return iso(y, m, lastDay - ((last - dow + 7) % 7));
}
/** Saturday holidays are observed the Friday before, Sunday holidays the Monday after. */
function observed(s: string) {
  const w = weekday(s);
  return w === 6 ? addDays(s, -1) : w === 0 ? addDays(s, 1) : s;
}

/** District of Columbia legal holidays (the ones that move IRS due dates). */
export function dcHolidays(y: number): Set<string> {
  const fixed = [iso(y, 1, 1), iso(y, 4, 16), iso(y, 6, 19), iso(y, 7, 4), iso(y, 11, 11), iso(y, 12, 25)].map(observed);
  const floating = [nthWeekday(y, 1, 1, 3), nthWeekday(y, 2, 1, 3), lastWeekday(y, 5, 1), nthWeekday(y, 9, 1, 1), nthWeekday(y, 10, 1, 2), nthWeekday(y, 11, 4, 4)];
  // Inauguration Day (Jan 20 every four years; moved to Jan 21 if Sunday).
  const inauguration = (y - 1965) % 4 === 0 ? [weekday(iso(y, 1, 20)) === 0 ? iso(y, 1, 21) : iso(y, 1, 20)] : [];
  // New Year's Day on a Saturday is observed Friday Dec 31 of the year before.
  const nextNewYear = observed(iso(y + 1, 1, 1));
  return new Set([...fixed, ...floating, ...inauguration, ...(nextNewYear.startsWith(`${y}-`) ? [nextNewYear] : [])]);
}

export function nextBusinessDay(s: string) {
  let d = s;
  for (let i = 0; i < 10; i++) {
    const w = weekday(d);
    if (w !== 0 && w !== 6 && !dcHolidays(Number(d.slice(0, 4))).has(d)) return d;
    d = addDays(d, 1);
  }
  return d;
}

/** The 15th day of the nth month after a tax year ending in (year, month), before rollover. */
export function fifteenthAfter(endYear: number, endMonth: number, n: number) {
  const idx = endYear * 12 + (endMonth - 1) + n;
  return iso(Math.floor(idx / 12), (idx % 12) + 1, 15);
}

/**
 * Due date for a tax year ending in (endYear, endMonth), calculated from the
 * IRS rules. C corporations with a June 30 year end that began before 2026
 * keep the older rule (3rd month; 7-month extension).
 */
export function ruleDueDate(kind: ReturnKind, endYear: number, endMonth = 12, extended = false) {
  let months: number = RETURN_KINDS[kind].months;
  let ext = 6;
  if (kind === "C_CORP" && endMonth === 6 && endYear <= 2026) {
    months = 3;
    ext = 7;
  }
  return nextBusinessDay(fifteenthAfter(endYear, endMonth, months + (extended ? ext : 0)));
}

/** Today's date in the office time zone (America/Chicago). */
export function officeToday(now = new Date()) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Chicago", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

export const daysBetween = (from: string, to: string) => Math.round((toDate(to).getTime() - toDate(from).getTime()) / 86400_000);

export function fmtIso(s: string, opts: Intl.DateTimeFormatOptions = { weekday: "short", month: "long", day: "numeric", year: "numeric" }) {
  return new Intl.DateTimeFormat("en-US", { ...opts, timeZone: "UTC" }).format(toDate(s));
}

export function countdownText(days: number) {
  if (days <= 0) return "Due today";
  return days === 1 ? "1 day left" : `${days} days left`;
}

// --- Countdown cards -------------------------------------------------------

export type DeadlineRow = {
  id: string;
  kind: string;
  taxYear: number;
  jurisdiction: string;
  reliefState: string;
  dueDate: string;
  timeNote: string | null;
  notes: string | null;
  sourceUrl: string | null;
  lastReviewedAt: Date | null;
  hidden: boolean;
};

export type CountdownLine = {
  key: string;
  label: string;
  form?: string;
  taxYear?: number;
  dueDate: string | null;
  days: number | null;
  // VERIFIED: reviewed official date · CALCULATED: from IRS rules for this client's fiscal year
  basis: "VERIFIED" | "CALCULATED" | "AWAITING";
  sourceUrl?: string | null;
  reviewedAt?: Date | null;
  notes?: string | null;
  timeNote?: string | null;
  appliesToYou?: boolean;
  personal?: string;
};

export type CountdownCard = { key: string; title: string; intro?: string; lines: CountdownLine[]; footnote?: string };

export type ClientProfile = {
  clientType: "INDIVIDUAL" | "BUSINESS" | "NONPROFIT";
  entityType: string | null;
  fiscalYearEnd: number | null;
  state: string | null;
};

/** Confirmed extensions: accepted EXTENSION filings recorded by staff. */
export type ConfirmedExtension = { taxYear: number; jurisdiction: string };

export const publishable = (r: DeadlineRow) => !r.hidden && !!r.sourceUrl && !!r.lastReviewedAt;

/** The next reviewed date for a kind and jurisdiction, honoring state relief rows. */
export function nextRow(rows: DeadlineRow[], kind: string, jurisdiction: string, today: string, clientState: string | null) {
  const pool = rows.filter((r) => publishable(r) && r.kind === kind && r.jurisdiction === jurisdiction && (r.reliefState === "" || r.reliefState === clientState));
  const byYear = new Map<number, DeadlineRow>();
  for (const r of pool) {
    const cur = byYear.get(r.taxYear);
    // A relief row for the client's state replaces the general date for that year.
    if (!cur || (r.reliefState && !cur.reliefState)) byYear.set(r.taxYear, r);
  }
  return [...byYear.values()].filter((r) => r.dueDate >= today).sort((a, b) => a.dueDate.localeCompare(b.dueDate))[0] ?? null;
}

function lineFromRow(key: string, label: string, r: DeadlineRow | null, today: string, extra: Partial<CountdownLine> = {}): CountdownLine {
  if (!r) return { key, label, dueDate: null, days: null, basis: "AWAITING", ...extra };
  return {
    key,
    label,
    taxYear: r.taxYear,
    dueDate: r.dueDate,
    days: Math.max(0, daysBetween(today, r.dueDate)),
    basis: "VERIFIED",
    sourceUrl: r.sourceUrl,
    reviewedAt: r.lastReviewedAt,
    notes: r.notes,
    timeNote: r.timeNote,
    ...extra,
  };
}

/** Which return kinds apply to this client. */
export function kindsFor(p: ClientProfile | null): Set<ReturnKind> {
  if (!p) return new Set();
  if (p.clientType === "INDIVIDUAL") return new Set(["INDIVIDUAL"]);
  switch (p.entityType) {
    case "SOLE_PROPRIETOR": return new Set(["INDIVIDUAL"]);
    case "PARTNERSHIP": return new Set(["PARTNERSHIP"]);
    case "S_CORP": return new Set(["S_CORP"]);
    case "C_CORP": return new Set(["C_CORP"]);
    default: return new Set();
  }
}

/** The next calculated date for a fiscal-year business. */
export function fiscalNext(kind: ReturnKind, fiscalYearEnd: number, today: string, extended: boolean) {
  const y = Number(today.slice(0, 4));
  for (let endYear = y - 2; endYear <= y + 1; endYear++) {
    const due = ruleDueDate(kind, endYear, fiscalYearEnd, extended);
    if (due >= today) return { due, endYear };
  }
  return null;
}

const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const lastDayOf = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();

export function buildCountdowns(input: { rows: DeadlineRow[]; today: string; profile: ClientProfile | null; extensions: ConfirmedExtension[]; stateName?: (code: string) => string }): CountdownCard[] {
  const { rows, today, profile } = input;
  const mine = kindsFor(profile);
  const state = profile?.state ?? null;
  const fiscal = profile && profile.clientType !== "INDIVIDUAL" && profile.fiscalYearEnd && profile.fiscalYearEnd !== 12 ? profile.fiscalYearEnd : null;
  const cards: CountdownCard[] = [];

  // 1. Tax season opens
  const season = nextRow(rows, "TAX_SEASON_OPENS", "US", today, state);
  const opened = rows.filter((r) => publishable(r) && r.kind === "TAX_SEASON_OPENS" && r.dueDate < today).sort((a, b) => b.dueDate.localeCompare(a.dueDate))[0];
  const individualNext = nextRow(rows, "INDIVIDUAL", "US", today, state);
  if (season) {
    cards.push({ key: "season", title: "Tax Season Opens", lines: [lineFromRow("season", `${season.taxYear} returns`, season, today)] });
  } else if (opened && individualNext && individualNext.taxYear === opened.taxYear) {
    cards.push({ key: "season", title: "Tax Season Opens", intro: `Tax season is open. The IRS began accepting ${opened.taxYear} returns on ${fmtIso(opened.dueDate)}.`, lines: [] });
  } else {
    cards.push({ key: "season", title: "Tax Season Opens", intro: "Opening date awaiting IRS announcement.", lines: [] });
  }

  // 2. Individual filing deadline (federal, plus the client's state when reviewed)
  const indiv: CountdownLine[] = [lineFromRow("individual", "Federal — Form 1040", individualNext, today, { form: "Form 1040", appliesToYou: mine.has("INDIVIDUAL") })];
  if (state) {
    const st = nextRow(rows, "INDIVIDUAL", state, today, state);
    if (st) indiv.push(lineFromRow(`individual-${state}`, `${input.stateName?.(state) ?? state} individual return`, st, today, { appliesToYou: mine.has("INDIVIDUAL") }));
  }
  cards.push({ key: "individual", title: "Individual Tax Filing Deadline", lines: indiv });

  // 3. Business tax deadlines
  const business: CountdownLine[] = [];
  for (const k of ["PARTNERSHIP", "S_CORP", "C_CORP"] as const) {
    const applies = mine.has(k);
    business.push(lineFromRow(k, `${RETURN_KINDS[k].label} — ${RETURN_KINDS[k].form}`, nextRow(rows, k, "US", today, state), today, { form: RETURN_KINDS[k].form, appliesToYou: applies && !fiscal, ...(applies && fiscal ? { notes: "General date for calendar-year businesses. Your fiscal-year date is below." } : {}) }));
    if (applies && fiscal) {
      const f = fiscalNext(k, fiscal, today, false);
      if (f) business.push({ key: `${k}-fiscal`, label: `Your ${RETURN_KINDS[k].form} — fiscal year ending ${MONTH_NAMES[fiscal - 1]} ${lastDayOf(f.endYear, fiscal)}, ${f.endYear}`, dueDate: f.due, days: Math.max(0, daysBetween(today, f.due)), basis: "CALCULATED", appliesToYou: true });
    }
  }
  cards.push({ key: "business", title: "Business Tax Deadlines", intro: "General dates for calendar-year businesses. Fiscal-year businesses have different dates.", lines: business });

  // 4. Extension filing deadlines (the request is due by the original due date)
  const extReq: CountdownLine[] = [
    lineFromRow("ext-individual", "Individuals — Form 4868", individualNext, today, { form: "Form 4868", appliesToYou: mine.has("INDIVIDUAL"), notes: "Or make an IRS payment and mark it as an extension payment." }),
    lineFromRow("ext-passthrough", "Partnerships & S corporations — Form 7004", nextRow(rows, "PARTNERSHIP", "US", today, state), today, { form: "Form 7004", appliesToYou: (mine.has("PARTNERSHIP") || mine.has("S_CORP")) && !fiscal, notes: null }),
    lineFromRow("ext-ccorp", "C corporations — Form 7004", nextRow(rows, "C_CORP", "US", today, state), today, { form: "Form 7004", appliesToYou: mine.has("C_CORP") && !fiscal, notes: null }),
  ];
  cards.push({ key: "extension-request", title: "Extension Filing Deadlines", intro: "An extension must be requested by the return's original due date.", lines: extReq, footnote: PAY_NOTE });

  // 5. Extended return deadlines
  const extended: CountdownLine[] = [];
  for (const k of RETURN_KIND_KEYS) {
    const r = nextRow(rows, `${k}_EXTENDED`, "US", today, state);
    const applies = mine.has(k);
    const confirmed = r && input.extensions.some((e) => e.taxYear === r.taxYear && e.jurisdiction === "FEDERAL");
    const personal = applies && !(fiscal && k !== "INDIVIDUAL")
      ? confirmed
        ? `Our office confirmed your ${r!.taxYear} federal extension was accepted.`
        : "Applies only if a valid extension is filed. Seeing this date doesn't mean an extension was filed or approved for you."
      : undefined;
    extended.push(lineFromRow(`${k}-extended`, `${RETURN_KINDS[k].label} — ${RETURN_KINDS[k].form}`, r, today, { form: RETURN_KINDS[k].form, appliesToYou: applies && !(fiscal && k !== "INDIVIDUAL"), personal }));
    if (applies && fiscal && k !== "INDIVIDUAL") {
      const f = fiscalNext(k, fiscal, today, true);
      if (f) extended.push({ key: `${k}-extended-fiscal`, label: `Your ${RETURN_KINDS[k].form} with an extension — fiscal year ending ${MONTH_NAMES[fiscal - 1]} ${lastDayOf(f.endYear, fiscal)}, ${f.endYear}`, dueDate: f.due, days: Math.max(0, daysBetween(today, f.due)), basis: "CALCULATED", appliesToYou: true, personal: "Applies only if a valid extension is filed." });
    }
  }
  if (state) {
    const st = nextRow(rows, "INDIVIDUAL_EXTENDED", state, today, state);
    if (st) extended.push(lineFromRow(`individual-extended-${state}`, `${input.stateName?.(state) ?? state} individual return`, st, today, { appliesToYou: mine.has("INDIVIDUAL") }));
  }
  cards.push({ key: "extended", title: "Extended Return Deadlines", intro: "When returns are due after a valid extension.", lines: extended, footnote: PAY_NOTE });

  return cards;
}

/**
 * Next year's dates calculated from the IRS rules, offered to staff for
 * review. They are never shown to clients until reviewed with a source.
 */
export function suggestedDates(taxYear: number) {
  return RETURN_KIND_KEYS.flatMap((k) => [
    { kind: k, taxYear, dueDate: ruleDueDate(k, taxYear, 12, false) },
    { kind: `${k}_EXTENDED`, taxYear, dueDate: ruleDueDate(k, taxYear, 12, true) },
  ]);
}
