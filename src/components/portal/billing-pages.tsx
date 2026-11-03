import { AlertTriangle, CheckCircle2, Clock, Info, RotateCw } from "lucide-react";

/** Pieces shared by the Pricing & Agreements and Billing & Payments pages, built to Tabitha's designs. */

type IconT = React.ComponentType<{ className?: string }>;

/** Cream card with a soft gold edge — the base of every panel in the approved designs. */
export const luxPanel = "min-w-0 rounded-2xl border border-gold-200/80 bg-gradient-to-b from-white to-ivory-50 shadow-[0_14px_32px_-24px_rgb(10_26_68/0.45)]";
/** Kept for older callers. */
export const tableCard = luxPanel;

/** Table with a rounded navy header row, as in "Your Invoices" and "Your Agreements". */
export const navyTable = "w-full border-separate border-spacing-0 text-sm [&_thead_th]:bg-navy-900 [&_thead_th]:py-3 [&_thead_th]:text-left [&_thead_th]:font-semibold [&_thead_th]:text-white [&_thead_th:first-child]:rounded-l-xl [&_thead_th:last-child]:rounded-r-xl [&_tbody_td]:border-b [&_tbody_td]:border-ivory-200";

/** Card heading: gold outline icon, serif title, optional subtitle. */
export function PanelTitle({ icon: Icon, title, sub, action }: { icon: IconT; title: string; sub?: string; action?: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div className="flex min-w-0 items-start gap-3">
        <Icon className="mt-0.5 size-10 shrink-0 text-gold-600" aria-hidden />
        <div className="min-w-0">
          <h2 className="font-serif text-2xl font-bold leading-tight text-navy-900 sm:text-[1.7rem]">{title}</h2>
          {sub && <p className="mt-0.5 text-sm text-navy-800">{sub}</p>}
        </div>
      </div>
      {action}
    </div>
  );
}

export type Tone = "paid" | "partial" | "overdue" | "open" | "pending" | "muted";
const TONES: Record<Tone, [string, IconT | null]> = {
  paid: ["bg-emerald-50 text-emerald-700 ring-emerald-200", CheckCircle2],
  partial: ["bg-gold-100 text-navy-900 ring-gold-300", RotateCw],
  overdue: ["bg-red-50 text-red-700 ring-red-200", AlertTriangle],
  open: ["bg-navy-50 text-navy-900 ring-navy-100", null],
  pending: ["bg-amber-50 text-amber-800 ring-amber-200", Clock],
  muted: ["bg-ivory-50 text-slate-600 ring-ivory-200", null],
};

export function StatusPill({ tone, children }: { tone: Tone; children: React.ReactNode }) {
  const [cls, Icon] = TONES[tone];
  return (
    <span className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-3 py-1 text-[13px] font-semibold ring-1 ${cls}`}>
      {Icon && <Icon className={`size-4 ${tone === "partial" ? "text-gold-600" : ""}`} aria-hidden />}
      {children}
    </span>
  );
}

/** Gold-outline pill action ("Receipt", "View", "Download"). */
export const pillButton = "inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-full border-[1.5px] border-gold-500 bg-gradient-to-b from-white to-gold-50 px-4 py-1.5 text-[13px] font-semibold text-navy-900 shadow-sm hover:to-gold-100";

/** One headline figure. The first card on Billing & Payments is navy. */
export function StatCard({ icon: Icon, label, value, sub, navy = false, testId }: { icon: IconT; label: string; value: string; sub?: string; navy?: boolean; testId: string }) {
  return (
    <div
      className={`flex min-w-0 items-center gap-4 rounded-2xl px-6 py-5 shadow-[0_14px_32px_-24px_rgb(10_26_68/0.55)] ${navy ? "bg-gradient-to-br from-navy-900 to-navy-950 text-white ring-1 ring-gold-500/40" : "border border-gold-200/80 bg-gradient-to-b from-white to-ivory-50"}`}
      data-testid={testId}
    >
      <Icon className={`size-11 shrink-0 ${navy ? "text-gold-400" : "text-gold-600"}`} aria-hidden />
      <span className="min-w-0">
        <span className={`block font-serif text-lg font-bold leading-tight ${navy ? "text-white" : "text-navy-900"}`}>{label}</span>
        <span className={`block font-serif text-3xl font-bold leading-tight ${navy ? "text-gold-300" : "text-navy-900"}`}>{value}</span>
        {sub && <span className={`block text-xs ${navy ? "text-navy-100" : "text-slate-500"}`}>{sub}</span>}
      </span>
    </div>
  );
}

/** Gold-edged note with an outlined "i" ("Pricing Notice"). */
export function GoldNote({ title, children, testId }: { title: string; children: React.ReactNode; testId?: string }) {
  return (
    <div className="flex items-start gap-4 rounded-2xl border border-gold-300 bg-gradient-to-b from-gold-50/40 to-gold-50 px-5 py-4 shadow-[0_14px_32px_-26px_rgb(200_157_41/0.7)]" data-testid={testId}>
      <Info className="mt-0.5 size-9 shrink-0 text-gold-600" aria-hidden />
      <div className="min-w-0 text-[15px] text-navy-800">
        <p className="mb-1 font-serif text-2xl font-bold text-navy-900">{title}</p>
        {children}
      </div>
    </div>
  );
}

/** Wide note: icon and serif title on the left, a thin gold divider, then the text ("Important"). */
export function NoteBar({ icon: Icon, title, children, testId }: { icon: IconT; title: string; children: React.ReactNode; testId?: string }) {
  return (
    <div className="flex flex-col gap-3 rounded-2xl border border-gold-200/80 bg-gradient-to-b from-white to-ivory-50 px-6 py-5 shadow-[0_14px_32px_-24px_rgb(10_26_68/0.45)] sm:flex-row sm:items-center sm:gap-6" data-testid={testId}>
      <div className="flex shrink-0 items-center gap-3">
        <Icon className="size-10 text-gold-600" aria-hidden />
        <p className="font-serif text-2xl font-bold leading-tight text-navy-900">{title}</p>
      </div>
      <span className="hidden h-12 w-px shrink-0 bg-gold-400 sm:block" aria-hidden />
      <div className="min-w-0 text-[15px] text-navy-800">{children}</div>
    </div>
  );
}

export const usdc = (c: number | null | undefined) => (c == null ? "—" : `$${(c / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
export const ymdLabel = (d: string | null | undefined) => {
  if (!d) return "—";
  const [y, m, day] = d.slice(0, 10).split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, day || 1)).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
};
