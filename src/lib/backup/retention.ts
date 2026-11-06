/**
 * Retention: daily backups are kept 35 days, the last backup of each month 12 months, the last
 * backup of each year 7 years. The latest successful backup is always kept, whatever its age.
 * Pure date arithmetic on office dates ("YYYY-MM-DD"), so it is easy to test.
 */
export type RetentionClass = "DAILY" | "MONTHLY" | "YEARLY";
export const DAILY_DAYS = 35;
export const MONTHLY_MONTHS = 12;
export const YEARLY_YEARS = 7;

const toUtc = (d: string) => {
  const [y, m, day] = d.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, day));
};
export const addDaysUtc = (d: string, n: number) => new Date(toUtc(d).getTime() + n * 86_400_000);
export const addMonthsUtc = (d: string, n: number) => {
  const t = toUtc(d);
  return new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + n, t.getUTCDate()));
};

export type RunForRetention = { id: string; backupDate: string; startedAt: Date };
export type RetentionDecision = { keep: boolean; cls: RetentionClass; keepUntil: Date; latest: boolean };

export function classifyRuns(runs: RunForRetention[], today: string): Map<string, RetentionDecision> {
  const out = new Map<string, RetentionDecision>();
  if (!runs.length) return out;
  const sorted = [...runs].sort((a, b) => (a.backupDate === b.backupDate ? a.startedAt.getTime() - b.startedAt.getTime() : a.backupDate < b.backupDate ? -1 : 1));
  const latest = sorted[sorted.length - 1];
  const curMonth = today.slice(0, 7);
  const curYear = today.slice(0, 4);
  const lastOf = (key: (r: RunForRetention) => string) => {
    const m = new Map<string, RunForRetention>();
    for (const r of sorted) m.set(key(r), r);
    return new Set([...m.values()].map((r) => r.id));
  };
  const monthEnds = lastOf((r) => r.backupDate.slice(0, 7));
  const yearEnds = lastOf((r) => r.backupDate.slice(0, 4));
  const now = toUtc(today);
  for (const r of sorted) {
    let cls: RetentionClass = "DAILY";
    let until = addDaysUtc(r.backupDate, DAILY_DAYS);
    if (yearEnds.has(r.id) && r.backupDate.slice(0, 4) < curYear) {
      cls = "YEARLY";
      until = addMonthsUtc(r.backupDate, YEARLY_YEARS * 12);
    } else if (monthEnds.has(r.id) && r.backupDate.slice(0, 7) < curMonth) {
      cls = "MONTHLY";
      until = addMonthsUtc(r.backupDate, MONTHLY_MONTHS);
    }
    const isLatest = r.id === latest.id;
    out.set(r.id, { keep: isLatest || until > now, cls, keepUntil: until, latest: isLatest });
  }
  return out;
}
